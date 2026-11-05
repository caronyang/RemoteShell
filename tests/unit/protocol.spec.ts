import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ENTRY_URL, CSP_HEADER, resolveAppAsset } from '../../src/main/protocol'

const root = path.resolve('dist/renderer')

describe('M5-01 app:// protocol：URL → 檔案', () => {
  it('入口 index.html 與相對資源都解析到 dist/renderer', () => {
    expect(APP_ENTRY_URL).toBe('app://bundle/index.html')
    const entry = resolveAppAsset(root, 'app://bundle/index.html')
    expect(entry?.file).toBe(path.join(root, 'index.html'))
    expect(entry?.mime).toBe('text/html; charset=utf-8')

    const js = resolveAppAsset(root, 'app://bundle/assets/index-abc123.js')
    expect(js?.file).toBe(path.join(root, 'assets', 'index-abc123.js'))
    expect(js?.mime).toBe('text/javascript; charset=utf-8')

    // 內嵌字型（M4-04）也要有正確 MIME，否則瀏覽器不當字型用
    expect(resolveAppAsset(root, 'app://bundle/assets/font.otf')?.mime).toBe('font/otf')
    expect(resolveAppAsset(root, 'app://bundle/assets/font.ttf')?.mime).toBe('font/ttf')
  })

  it('根路徑等於 index.html', () => {
    expect(resolveAppAsset(root, 'app://bundle/')?.file).toBe(path.join(root, 'index.html'))
  })

  it('路徑逃逸（含編碼過的 ..）一律回 null', () => {
    expect(resolveAppAsset(root, 'app://bundle/%2e%2e%2f%2e%2e%2fsecret.txt')).toBeNull()
    expect(resolveAppAsset(root, 'app://bundle/assets/%2e%2e%2f%2e%2e%2fpackage.json')).toBeNull()
    expect(resolveAppAsset(root, 'app://bundle/C:/Windows/win.ini')).toBeNull()
    expect(resolveAppAsset(root, 'app://bundle/..%5c..%5csecret.txt')).toBeNull()
    expect(resolveAppAsset(root, 'app://bundle/index.html%00.png')).toBeNull()
  })

  it('壞掉的 URL 不會丟例外', () => {
    expect(resolveAppAsset(root, 'not a url')).toBeNull()
    expect(resolveAppAsset(root, 'app://bundle/%E0%A4%A')).toBeNull()
  })
})

describe('M5-01 CSP header（meta 做不到的 frame-ancestors）', () => {
  it('包含 frame-ancestors / default-src / object-src', () => {
    expect(CSP_HEADER).toContain("frame-ancestors 'none'")
    expect(CSP_HEADER).toContain("default-src 'none'")
    expect(CSP_HEADER).toContain("object-src 'none'")
    expect(CSP_HEADER).toContain("script-src 'self'")
    expect(CSP_HEADER).not.toContain('unsafe-eval')
  })
})
