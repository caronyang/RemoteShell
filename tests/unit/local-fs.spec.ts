import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  homeDir,
  listDrives,
  listLocal,
  mkdirLocal,
  removeLocal,
  renameLocal,
  resolveSafePath
} from '../../src/main/local/fs'
import type { AppError } from '../../src/shared/ipc-contract'

let root: string
const options = () => ({ home: root, drives: () => [path.parse(root).root] })

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'NO_THROW'
  } catch (error) {
    return (error as AppError).code ?? 'NO_CODE'
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-local-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('M3-04 路徑安全（§3.9-1／2）', () => {
  it('正常絕對路徑會被正規化', () => {
    expect(resolveSafePath(root, options())).toBe(path.resolve(root))
    const nested = path.join(root, 'a', 'b')
    expect(resolveSafePath(nested, options())).toBe(path.resolve(nested))
  })

  it('拒絕含 .. 的路徑（即使 resolve 後還在磁碟機內）', () => {
    // 注意：path.join 會先正規化掉 ..，所以要用原始字串模擬 renderer 直接送來的惡意路徑
    const escape = `${root}\\..\\..\\Windows`
    expect(codeOf(() => resolveSafePath(escape, options()))).toBe('E_LOCAL_IO')
  })

  it('拒絕裝置命名空間 \\\\?\\ 與 \\\\.\\', () => {
    expect(codeOf(() => resolveSafePath('\\\\?\\C:\\Windows', options()))).toBe('E_LOCAL_IO')
    expect(codeOf(() => resolveSafePath('\\\\.\\PhysicalDrive0', options()))).toBe('E_LOCAL_IO')
  })

  it('拒絕空路徑與 NUL byte', () => {
    expect(codeOf(() => resolveSafePath('', options()))).toBe('E_LOCAL_IO')
    expect(codeOf(() => resolveSafePath(`${root}\\a\0b`, options()))).toBe('E_LOCAL_IO')
  })

  it('家目錄與磁碟機根都可存取', () => {
    expect(resolveSafePath(root, options())).toBe(path.resolve(root))
    const drive = path.parse(root).root
    expect(resolveSafePath(drive, options())).toBe(path.resolve(drive))
  })

  it('homeDir 預設為使用者家目錄', () => {
    expect(homeDir()).toBe(path.resolve(os.homedir()))
  })
})

describe('M3-04 列出目錄（只回 metadata，§3.9-4）', () => {
  it('回傳 entries 與磁碟機清單，且不含檔案內容', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
    fs.mkdirSync(path.join(root, 'sub'))

    const result = listLocal(root, options())
    expect(result.path).toBe(path.resolve(root))
    expect(result.drives.length).toBeGreaterThan(0)
    const file = result.entries.find((e) => e.name === 'a.txt')
    expect(file).toMatchObject({ type: 'file', size: 5 })
    expect(file && Object.keys(file).sort()).toEqual(['isSymlink', 'mtimeMs', 'name', 'path', 'size', 'type'])
    expect(result.entries.find((e) => e.name === 'sub')?.type).toBe('dir')
  })

  it('junction 標成 link 且不跟隨（不進入裝置命名空間）', () => {
    const target = path.join(root, 'target')
    const link = path.join(root, 'link-dir')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'inside.txt'), 'x')
    try {
      fs.symlinkSync(target, link, 'junction')
    } catch {
      // 沒有建立 junction 的權限時，至少驗證一般目錄不是 link
      const result = listLocal(root, options())
      expect(result.entries.find((e) => e.name === 'target')?.isSymlink).toBe(false)
      return
    }
    const result = listLocal(root, options())
    const entry = result.entries.find((e) => e.name === 'link-dir')
    expect(entry?.type).toBe('link')
    expect(entry?.isSymlink).toBe(true)
  })

  it('不存在 → E_SFTP_NOT_FOUND', () => {
    expect(codeOf(() => listLocal(path.join(root, 'nope'), options()))).toBe('E_SFTP_NOT_FOUND')
  })

  it('權限不足 → E_SFTP_PERMISSION（系統受保護目錄）', () => {
    const protectedDir = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'config')
    if (!fs.existsSync(protectedDir)) return
    expect(codeOf(() => listLocal(protectedDir))).toBe('E_SFTP_PERMISSION')
  })
})

describe('M3-04 建立／改名／刪除（§3.9-3）', () => {
  it('mkdir 建立目錄；重複建立不報錯', () => {
    const dir = path.join(root, 'new-dir')
    mkdirLocal(dir, options())
    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(() => mkdirLocal(dir, options())).not.toThrow()
  })

  it('rename 改名；目標路徑一樣要通過安全檢查', () => {
    const from = path.join(root, 'a.txt')
    fs.writeFileSync(from, 'x')
    const to = path.join(root, 'b.txt')
    renameLocal(from, to, options())
    expect(fs.existsSync(to)).toBe(true)
    expect(codeOf(() => renameLocal(to, `${root}\\..\\evil.txt`, options()))).toBe('E_LOCAL_IO')
  })

  it('遞迴刪除整個目錄；非遞迴刪非空目錄會失敗', () => {
    const tree = path.join(root, 'tree')
    fs.mkdirSync(path.join(tree, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'sub', 'f.txt'), 'x')

    expect(codeOf(() => removeLocal(tree, false, options()))).toBe('E_LOCAL_IO')
    removeLocal(tree, true, options())
    expect(fs.existsSync(tree)).toBe(false)
  })

  it('刪除不存在的路徑 → E_SFTP_NOT_FOUND', () => {
    expect(codeOf(() => removeLocal(path.join(root, 'ghost'), true, options()))).toBe('E_SFTP_NOT_FOUND')
  })

  it('listDrives 至少包含系統磁碟', () => {
    const drives = listDrives()
    expect(drives.length).toBeGreaterThan(0)
    expect(drives.every((d) => /^[A-Z]:\\$/.test(d))).toBe(true)
  })
})
