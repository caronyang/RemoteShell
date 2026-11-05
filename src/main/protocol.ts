/**
 * M5-01：以自訂 protocol（`app://bundle/...`）供應 renderer。
 *
 * 為什麼不用 `file://`：
 *   - `file://` 的 origin 是 opaque，沒有真正的「同源」概念，也沒有 response header
 *   - CSP 的 `frame-ancestors` **只能**用 HTTP header 下發（W3C 規定 meta 無效），
 *     所以 §1.3 要求 M5 用自訂 protocol 帶完整 CSP header
 *
 * 這裡只做三件事：把 URL 對到 dist/renderer 內的檔案（含逃逸防護）、給正確的
 * Content-Type、每個回應都附上同一份 CSP header。
 */
import fs from 'node:fs'
import path from 'node:path'
import { protocol } from 'electron'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`

/** 正式環境的 CSP（與 vite.config.ts 的 meta 版一致，另外加上 meta 做不到的 frame-ancestors） */
export const CSP_HEADER = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

export interface AppAsset {
  file: string
  mime: string
}

/**
 * URL → 磁碟路徑。任何 `..`、絕對路徑、裝置命名空間一律視為不合法（回 null），
 * 再用 resolve 後的字首檢查當第二道保險。
 */
export function resolveAppAsset(root: string, requestUrl: string, platform = process.platform): AppAsset | null {
  let pathname: string
  try {
    pathname = new URL(requestUrl).pathname
  } catch {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '')
  const segments = relative.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) return null

  const base = path.resolve(root)
  const file = path.resolve(base, relative)
  const withSep = base.endsWith(path.sep) ? base : base + path.sep
  const comparable = platform === 'win32' ? file.toLowerCase() : file
  const comparableBase = platform === 'win32' ? withSep.toLowerCase() : withSep
  if (!comparable.startsWith(comparableBase)) return null

  const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  return { file, mime }
}

/** app ready 之前呼叫：把 scheme 註冊成 standard + secure（有 origin、算安全來源） */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

/** app ready 之後呼叫：實際的 handler（每個回應都帶 CSP header） */
export function installAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const asset = resolveAppAsset(rendererRoot, request.url)
    if (!asset) {
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': CSP_HEADER }
      })
    }
    try {
      const body = await fs.promises.readFile(asset.file)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'content-type': asset.mime,
          'content-security-policy': CSP_HEADER,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache'
        }
      })
    } catch {
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': CSP_HEADER }
      })
    }
  })
}
