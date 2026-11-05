import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { defaultDataDir, defaultDownloadDir, logFileName, storePaths } from '../../src/main/store/paths'

const original = process.env['REMOTESHELL_DATA_DIR']

afterEach(() => {
  if (original === undefined) delete process.env['REMOTESHELL_DATA_DIR']
  else process.env['REMOTESHELL_DATA_DIR'] = original
})

describe('M1-04 資料路徑（§5 %APPDATA%\\RemoteShell）', () => {
  it('預設落在 %APPDATA%/RemoteShell', () => {
    delete process.env['REMOTESHELL_DATA_DIR']
    const dir = defaultDataDir()
    expect(path.basename(dir)).toBe('RemoteShell')
    expect(dir.toLowerCase()).toContain('appdata')
  })

  it('REMOTESHELL_DATA_DIR 可覆寫（測試用）', () => {
    process.env['REMOTESHELL_DATA_DIR'] = path.join('C:', 'tmp', 'rs')
    expect(defaultDataDir()).toBe(path.resolve(path.join('C:', 'tmp', 'rs')))
  })

  it('storePaths 產生 §5 的四個檔名', () => {
    const paths = storePaths(path.join('C:', 'rs'))
    expect(path.basename(paths.settings)).toBe('settings.json')
    expect(path.basename(paths.connections)).toBe('connections.json')
    expect(path.basename(paths.knownHosts)).toBe('known_hosts.json')
    expect(path.basename(paths.logsDir)).toBe('logs')
  })

  it('下載預設資料夾與 log 檔名格式', () => {
    expect(defaultDownloadDir()).toContain('RemoteShell')
    expect(logFileName(new Date(2026, 9, 30))).toBe('app-20261030.log')
  })
})
