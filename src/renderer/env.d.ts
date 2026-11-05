/// <reference types="vite/client" />
import type { RsApi } from '../shared/ipc-contract'

declare global {
  interface Window {
    /** preload 唯一暴露的 API（§2 鐵則 1） */
    readonly rs: RsApi
  }
}

export {}
