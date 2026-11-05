import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * CSP 依模式注入（index.html 內以 %CSP% 佔位）。
 * - production：嚴格（script 只能來自自身、connect-src 全關）
 * - dev：放寬 script-src 'unsafe-inline' 與 connect-src ws:（Vite HMR 需要）
 */
function csp(): Plugin {
  const prod = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
  const dev = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: http://localhost:*",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')

  return {
    name: 'remoteshell-csp',
    transformIndexHtml(html, ctx) {
      return html.replace('%CSP%', ctx.server ? dev : prod)
    }
  }
}

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), csp()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome128'
  },
  server: {
    port: 5273,
    strictPort: true
  }
})
