import { describe, expect, it } from 'vitest'
import { translations, flatten } from '../../src/renderer/i18n'
import { ERROR_CODES } from '../../src/shared/errors'

describe('M1-08 i18n 資源', () => {
  it('en-US 與 zh-TW 的 key 集合完全一致', () => {
    const en = Object.keys(translations['en-US']).sort()
    const zh = Object.keys(translations['zh-TW']).sort()
    expect(zh).toEqual(en)
  })

  it('攤平後全部是字串、且沒有殘留巢狀物件（D7 全扁平 key）', () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      const values = Object.values(translations[locale])
      expect(values.length).toBeGreaterThan(0)
      expect(values.every((v) => typeof v === 'string')).toBe(true)
    }
  })

  it('D7：menu 與 menu.file.quickConnect 這種「同層 + 巢狀」key 都能解析', () => {
    expect(translations['en-US']['menu.file']).toBe('File')
    expect(translations['en-US']['menu.file.quickConnect']).toBe('Quick Connect…')
    expect(translations['zh-TW']['menu.file.quickConnect']).toBeDefined()
  })

  it('flatten 對已是扁平的輸入是 no-op', () => {
    const flat = { a: 'x', 'b.c': 'y' }
    expect(flatten(flat)).toEqual(flat)
  })

  it('28 個錯誤碼在兩個語系都有 error.<code>', () => {
    expect(ERROR_CODES).toHaveLength(28)
    for (const code of ERROR_CODES) {
      expect(translations['en-US'][`error.${code}`]).toBeTruthy()
      expect(translations['zh-TW'][`error.${code}`]).toBeTruthy()
    }
  })

  it('中英 key 數一致（i18n key 覆蓋報告用）', () => {
    expect(Object.keys(translations['zh-TW']).length).toBe(Object.keys(translations['en-US']).length)
  })
})
