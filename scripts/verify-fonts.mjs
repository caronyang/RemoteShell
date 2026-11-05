/**
 * M4-04 驗收：字型覆蓋率檢查（純 Node，不依賴 fonttools）。
 *
 * 直接解析 TrueType/OpenType 的 cmap（format 4 / 12），確認內嵌字型是否真的
 * 具備終端需要的字元：
 *   - U+25B2 / U+25BC   htop / mc 的排序指示箭頭
 *   - U+2500–U+257F     框線（drawing box）
 *   - CJK 全形          漢字、全形標點、假名（Mono CJK 字型負責）
 *   - ASCII 可列印字元  終端基本盤
 *
 * 另外確認「Consolas 不得打包」：build/fonts 內不得出現 Consolas 檔名/名稱。
 *
 * 用法：npm run verify:fonts
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fontsDir = path.join(root, 'build', 'fonts')

/** 讀出字型所有可用的 code point（取最好的 cmap 子表） */
export function readCmap(file) {
  const buf = fs.readFileSync(file)
  const numTables = buf.readUInt16BE(4)
  let cmapOffset = -1
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16
    if (buf.toString('ascii', at, at + 4) === 'cmap') {
      cmapOffset = buf.readUInt32BE(at + 8)
      break
    }
  }
  if (cmapOffset < 0) throw new Error(`${path.basename(file)}: 找不到 cmap`)

  const count = buf.readUInt16BE(cmapOffset + 2)
  const subtables = []
  for (let i = 0; i < count; i++) {
    const at = cmapOffset + 4 + i * 8
    const platform = buf.readUInt16BE(at)
    const encoding = buf.readUInt16BE(at + 2)
    const offset = cmapOffset + buf.readUInt32BE(at + 4)
    subtables.push({ platform, encoding, offset, format: buf.readUInt16BE(offset) })
  }

  // 優先 format 12（完整 Unicode），其次 format 4（BMP）
  const best =
    subtables.find((s) => s.format === 12) ??
    subtables.find((s) => s.format === 4 && s.platform === 3 && s.encoding === 1) ??
    subtables.find((s) => s.format === 4)
  if (!best) throw new Error(`${path.basename(file)}: 沒有 format 4/12 cmap`)

  const codePoints = new Set()
  if (best.format === 12) {
    const groups = buf.readUInt32BE(best.offset + 12)
    for (let i = 0; i < groups; i++) {
      const at = best.offset + 16 + i * 12
      const start = buf.readUInt32BE(at)
      const end = buf.readUInt32BE(at + 4)
      for (let cp = start; cp <= end; cp++) codePoints.add(cp)
    }
  } else {
    const segCount = buf.readUInt16BE(best.offset + 6) / 2
    const endAt = best.offset + 14
    const startAt = endAt + segCount * 2 + 2
    const deltaAt = startAt + segCount * 2
    const rangeAt = deltaAt + segCount * 2
    for (let i = 0; i < segCount; i++) {
      const end = buf.readUInt16BE(endAt + i * 2)
      const start = buf.readUInt16BE(startAt + i * 2)
      const delta = buf.readInt16BE(deltaAt + i * 2)
      const rangeOffset = buf.readUInt16BE(rangeAt + i * 2)
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let glyph = 0
        if (rangeOffset === 0) {
          glyph = (cp + delta) & 0xffff
        } else {
          const glyphAt = rangeAt + i * 2 + rangeOffset + (cp - start) * 2
          if (glyphAt + 1 < buf.length) {
            glyph = buf.readUInt16BE(glyphAt)
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff
          }
        }
        if (glyph !== 0) codePoints.add(cp)
      }
    }
  }
  return codePoints
}

export function fontName(file) {
  const buf = fs.readFileSync(file)
  const numTables = buf.readUInt16BE(4)
  let nameOffset = -1
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16
    if (buf.toString('ascii', at, at + 4) === 'name') {
      nameOffset = buf.readUInt32BE(at + 8)
      break
    }
  }
  if (nameOffset < 0) return path.basename(file)
  const count = buf.readUInt16BE(nameOffset + 2)
  const strings = nameOffset + buf.readUInt16BE(nameOffset + 4)
  for (let i = 0; i < count; i++) {
    const at = nameOffset + 6 + i * 12
    if (buf.readUInt16BE(at + 6) !== 4) continue // nameID 4 = full name
    const length = buf.readUInt16BE(at + 8)
    const offset = strings + buf.readUInt16BE(at + 10)
    const raw = buf.subarray(offset, offset + length)
    const platform = buf.readUInt16BE(at)
    return platform === 3 || platform === 0 ? raw.swap16().toString('utf16le') : raw.toString('latin1')
  }
  return path.basename(file)
}

const ascii = Array.from({ length: 95 }, (_, i) => 0x20 + i)
const boxDrawing = Array.from({ length: 0x80 }, (_, i) => 0x2500 + i)
const triangles = [0x25b2, 0x25bc, 0x25c0, 0x25b6]
const fullwidth = Array.from({ length: 94 }, (_, i) => 0xff01 + i)
const cjkPunct = Array.from({ length: 0x40 }, (_, i) => 0x3000 + i)
// U+3097–3098 是 Unicode 保留未定義，不算缺字
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const kana = [...range(0x3041, 0x3096), ...range(0x30a1, 0x30fa)]
const han = [...'中文檔案傳輸錯誤連線跳板伺服器終端全形測試'].map((ch) => ch.codePointAt(0))

const required = {
  'ASCII 可列印 (U+0020–007E)': { codePoints: ascii, who: 'cascadia' },
  '排序箭頭 U+25B2 / U+25BC': { codePoints: triangles, who: 'cascadia' },
  '框線 U+2500–U+257F': { codePoints: boxDrawing, who: 'cascadia' },
  '全形標點 U+FF01–FF5E': { codePoints: fullwidth, who: 'cjk' },
  'CJK 標點 U+3000–303F': { codePoints: cjkPunct, who: 'cjk' },
  '假名 U+3041–30A0': { codePoints: kana, who: 'cjk' },
  '漢字（樣本）': { codePoints: han, who: 'cjk' }
}

const fonts = fs
  .readdirSync(fontsDir)
  .filter((name) => /\.(ttf|otf)$/i.test(name))
  .map((name) => {
    const file = path.join(fontsDir, name)
    return { name, file, family: fontName(file), codePoints: readCmap(file) }
  })

const cascadia = fonts.find((f) => /cascadia/i.test(f.name))
const cjk = fonts.find((f) => /noto/i.test(f.name))
const problems = []

if (!cascadia) problems.push('build/fonts 找不到 Cascadia Mono（應為 CascadiaMono-Regular.ttf）')
if (!cjk) problems.push('build/fonts 找不到 CJK 等寬字型（應為 NotoSansMonoCJKtc-Regular.otf）')

console.log('字型清單：')
for (const font of fonts) {
  console.log(`  - ${font.name} → "${font.family}"（${font.codePoints.size} code points）`)
}

console.log('\n覆蓋率：')
const rows = []
for (const [label, spec] of Object.entries(required)) {
  const font = spec.who === 'cjk' ? cjk : cascadia
  const missing = font ? spec.codePoints.filter((cp) => !font.codePoints.has(cp)) : spec.codePoints
  const covered = spec.codePoints.length - missing.length
  const ok = missing.length === 0
  if (!ok) {
    problems.push(`${label} 缺 ${missing.length} 個字元（${missing.slice(0, 6).map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')}）`)
  }
  rows.push({
    需求: label,
    字型: font ? font.name : '(缺少)',
    覆蓋: `${covered}/${spec.codePoints.length}`,
    結果: ok ? 'PASS' : 'FAIL'
  })
}
console.table(rows)

// Consolas 不得打包（只能當系統 fallback）
const bundled = fs.readdirSync(fontsDir)
const consolas = bundled.filter((name) => /consola/i.test(name))
if (consolas.length > 0) problems.push(`build/fonts 打包了 Consolas：${consolas.join(', ')}`)
console.log(`Consolas 打包檢查：${consolas.length === 0 ? 'PASS（未打包，僅作 fallback）' : 'FAIL'}`)

// 授權檔必須存在
for (const license of ['OFL-CascadiaMono.txt', 'OFL-NotoSansMonoCJK.txt']) {
  if (!fs.existsSync(path.join(fontsDir, license))) problems.push(`缺少授權檔 build/fonts/${license}`)
}

if (problems.length > 0) {
  console.error('\n字型檢查失敗：')
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}

console.log('\n字型檢查全部通過（Cascadia Mono + Noto Sans Mono CJK TC，OFL-1.1）。')
