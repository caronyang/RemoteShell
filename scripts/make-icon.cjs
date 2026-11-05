/**
 * M4-04：由 design source（docs/design/UI-06_Logo.svg）產生 build/icon.ico。
 *
 * 為什麼要這支腳本：設計稿是 SVG（向量 + 漸層），而 Windows 的 .ico 需要多尺寸點陣圖。
 * 做法是「用專案既有的 Electron 當光柵化器」——不引入額外原生依賴（sharp/resvg），
 * 也保證漸層、圓角、圓點與設計稿完全一致。
 *
 * 尺寸策略（依設計稿 UI-06_Logo 設計說明）：
 *   16 / 24 → #logo-micro（節點減少，避免 16px 糊成一團）
 *   32 以上 → #logo-full
 *
 * 輸出：
 *   build/icon.ico                 多尺寸（16/24/32/48/64/128/256），<=48 用 BMP、>=64 用 PNG
 *   build/icons/icon-<size>.png    各尺寸單獨 PNG（驗收／文件用）
 *
 * 用法：npx electron scripts/make-icon.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const designSvg = path.join(root, 'docs', 'design', 'UI-06_Logo.svg')
const outIco = path.join(root, 'build', 'icon.ico')
const outDir = path.join(root, 'build', 'icons')

/** 從設計稿抽出可獨立渲染的 logo（單一來源，不重打路徑資料） */
function standaloneSvg(id) {
  const svg = fs.readFileSync(designSvg, 'utf8')
  const gradient = /<linearGradient id="tile"[\s\S]*?<\/linearGradient>/.exec(svg)
  const group = new RegExp(`<g id="${id}">[\\s\\S]*?</g>`).exec(svg)
  if (!gradient || !group) throw new Error(`design source 缺少 #${id} 或 #tile 漸層`)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">' +
    `<defs>${gradient[0]}</defs>${group[0]}</svg>`
  )
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
/** 32 以下用 micro 版；24 也用 micro（設計稿標明 16px 對照） */
const microUpTo = 24

function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight = 影像 + AND mask
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(size * size * 4, 20) // biSizeImage

  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y // BMP 由下而上
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4
      const d = (y * size + x) * 4
      pixels[d] = rgba[s + 2] // B
      pixels[d + 1] = rgba[s + 1] // G
      pixels[d + 2] = rgba[s] // R
      pixels[d + 3] = rgba[s + 3] // A
    }
  }

  const maskRow = (Math.ceil(size / 8) + 3) & ~3
  const mask = Buffer.alloc(maskRow * size) // 全 0 = 不透明（透明度交給 alpha 通道）
  return Buffer.concat([header, pixels, mask])
}

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((entry, index) => {
    const at = index * 16
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at) // 0 代表 256
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    dir.writeUInt8(0, at + 2) // 調色盤數
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // planes
    dir.writeUInt16LE(32, at + 6) // bpp
    dir.writeUInt32LE(entry.data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })

  return Buffer.concat([header, dir, ...entries.map((entry) => entry.data)])
}

async function render() {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 400,
    webPreferences: { offscreen: false, sandbox: true, contextIsolation: true }
  })
  await win.loadURL('data:text/html,<html><body></body></html>')

  const payload = SIZES.map((size) => ({
    size,
    svg: standaloneSvg(size <= microUpTo ? 'logo-micro' : 'logo-full')
  }))

  const rendered = await win.webContents.executeJavaScript(
    `(async () => {
      const jobs = ${JSON.stringify(payload)};
      const out = [];
      for (const job of jobs) {
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(job.svg)));
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = job.size;
        canvas.height = job.size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, job.size, job.size);
        const bytes = ctx.getImageData(0, 0, job.size, job.size).data;
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        out.push({ size: job.size, rgba: btoa(binary), png: canvas.toDataURL('image/png') });
      }
      return out;
    })()`,
    true
  )

  win.destroy()

  fs.mkdirSync(outDir, { recursive: true })
  const entries = []
  for (const item of rendered) {
    const rgba = Buffer.from(item.rgba, 'base64')
    const png = Buffer.from(item.png.slice('data:image/png;base64,'.length), 'base64')
    fs.writeFileSync(path.join(outDir, `icon-${item.size}.png`), png)
    // 小尺寸用 BMP（舊版 shell/對話框相容性最好），大尺寸用 PNG 壓縮
    entries.push({ size: item.size, data: item.size <= 48 ? bmpEntry(rgba, item.size) : png })
    console.log(`[icon] ${item.size}x${item.size} <- ${item.size <= microUpTo ? 'logo-micro' : 'logo-full'} (${entries.at(-1).data.length} bytes)`)
  }

  fs.writeFileSync(outIco, buildIco(entries))
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), fs.readFileSync(path.join(outDir, 'icon-256.png')))
  console.log(`[icon] wrote ${outIco} (${fs.statSync(outIco).size} bytes, ${entries.length} sizes)`)
}

app.whenReady().then(render).then(
  () => app.exit(0),
  (error) => {
    console.error('[icon] failed:', error)
    app.exit(1)
  }
)
