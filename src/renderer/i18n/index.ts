import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Locale } from '../../shared/ipc-contract'
import enUS from './en-US.json'
import zhTW from './zh-TW.json'

export type FlatResources = Record<string, string>

/**
 * 把（可能仍是巢狀的）資源檔攤平成單層 key。
 * §12 D7 定案：i18next 必須 keySeparator:false / nsSeparator:false，
 * 因此資源必須是扁平 key；交來的 JSON 若仍是巢狀，這裡攤平後行為一致（已是扁平則為 no-op）。
 */
export function flatten(source: unknown, prefix = ''): FlatResources {
  const out: FlatResources = {}
  if (source === null || typeof source !== 'object') {
    if (prefix) out[prefix] = String(source)
    return out
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, path))
    } else {
      out[path] = String(value)
    }
  }
  return out
}

export const translations: Record<Locale, FlatResources> = {
  'en-US': flatten(enUS),
  'zh-TW': flatten(zhTW)
}

export interface InitOptions {
  /** dev 模式：缺 key 時印警告（saveMissing + missingKeyHandler） */
  dev?: boolean
}

/**
 * §12 D7：預設的 keySeparator/nsSeparator 會把 `menu.file.quickConnect`
 * 當成 `menu → file → quickConnect` 路徑；本專案一律用扁平 key，兩者都必須關掉。
 */
export function createI18n(): I18nInstance {
  return i18next.createInstance()
}

export function initI18n(locale: Locale, options: InitOptions = {}): I18nInstance {
  const instance = createI18n()
  void instance.use(initReactI18next).init({
    resources: {
      'en-US': { translation: translations['en-US'] },
      'zh-TW': { translation: translations['zh-TW'] }
    },
    lng: locale,
    fallbackLng: 'en-US',
    keySeparator: false,
    nsSeparator: false,
    defaultNS: 'translation',
    // i18n key 規範（附錄 A）用單大括號 {name}；i18next 預設是 {{name}}，必須改
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
    returnNull: false,
    saveMissing: options.dev === true,
    saveMissingTo: 'current',
    parseMissingKeyHandler: (key: string) => key,
    missingKeyHandler: (lngs: readonly string[], ns: string, key: string) => {
      if (options.dev === true) {
        console.warn(`[i18n] missing key "${key}" (ns=${ns}, lng=${lngs.join(',')})`)
      }
    }
  })
  return instance
}

export function applyLocale(instance: I18nInstance, locale: Locale): void {
  void instance.changeLanguage(locale)
}
