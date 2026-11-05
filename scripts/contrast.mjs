/* M4-05 對比檢查：tokens.css 主文字組合 vs WCAG 4.5:1（只計算與回報，不改色票） */
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/renderer/styles/tokens.css', import.meta.url), 'utf8')

const token = (name) => {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))
  if (!match) throw new Error(`token ${name} not found`)
  return match[1]
}

const channel = (value) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

const luminance = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const pairs = [
  ['--text', '--surface'],
  ['--text', '--surface-subtle'],
  ['--text-secondary', '--surface'],
  ['--text-secondary', '--surface-subtle'],
  ['--terminal-fg', '--terminal-bg']
]

let failed = false
for (const [fgName, bgName] of pairs) {
  const ratio = contrast(token(fgName), token(bgName))
  const ok = ratio >= 4.5
  if (!ok) failed = true
  console.log(`${fgName} on ${bgName}: ${ratio.toFixed(2)}:1 ${ok ? 'PASS' : 'FAIL'}`)
}
// CI gate：任何一組 < 4.5:1 即非 0 exit（色票被改壞時擋下）
process.exit(failed ? 1 : 0)
