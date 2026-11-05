import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 資料落地位置（§5）：%APPDATA%\RemoteShell
 * 測試可透過 REMOTESHELL_DATA_DIR 覆寫，避免污染真實 profile。
 */
export function defaultDataDir(): string {
  const override = process.env['REMOTESHELL_DATA_DIR']
  if (override && override.trim().length > 0) return path.resolve(override)
  const appData = process.env['APPDATA']
  const base = appData && appData.trim().length > 0 ? appData : path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(base, 'RemoteShell')
}

export function defaultDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads', 'RemoteShell')
}

export interface StorePaths {
  dir: string
  settings: string
  connections: string
  knownHosts: string
  logsDir: string
}

export function storePaths(dir: string): StorePaths {
  return {
    dir,
    settings: path.join(dir, 'settings.json'),
    connections: path.join(dir, 'connections.json'),
    knownHosts: path.join(dir, 'known_hosts.json'),
    logsDir: path.join(dir, 'logs')
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** 檔名用本地日期：app-YYYYMMDD.log */
export function logFileName(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `app-${y}${m}${d}.log`
}
