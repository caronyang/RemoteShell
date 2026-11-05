#!/usr/bin/env node
/**
 * v0.1.6 防復發掃描：renderer 內 `t('key')` 若翻譯字串含 {placeholder}，
 * 呼叫端必須帶第二個參數（插值物件），否則 UI 會顯示字面 `{host}:{port}`。
 *
 * 用法：node scripts/check-i18n-placeholders.mjs [--json]
 * 結束碼：0 = 無違規；1 = 有違規（CI 會擋）。
 *
 * 只做靜態檢查，不改檔；動態 key（t(variable)）無法靜態解析，會列為 skipped。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const rendererDir = path.join(root, 'src', 'renderer')
const i18nDir = path.join(rendererDir, 'i18n')
const LOCALES = ['en-US', 'zh-TW']

function flatten(source, prefix = '') {
  const out = {}
  if (source === null || typeof source !== 'object') {
    if (prefix) out[prefix] = String(source)
    return out
  }
  for (const [key, value] of Object.entries(source)) {
    const next = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, next))
    } else {
      out[next] = String(value)
    }
  }
  return out
}

const translations = Object.fromEntries(
  LOCALES.map((locale) => {
    const file = path.join(i18nDir, `${locale}.json`)
    return [locale, flatten(JSON.parse(fs.readFileSync(file, 'utf8')))]
  })
)

const PLACEHOLDER = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g

function placeholdersIn(value) {
  return [...new Set(value.match(PLACEHOLDER) ?? [])]
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

function literalKey(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return literalKey(node.expression)
  return null
}

const violations = []
const dynamic = []
const dynamicErrorKeys = []
let literalCalls = 0

for (const file of walk(rendererDir)) {
  const source = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isT = ts.isIdentifier(callee) && callee.text === 't'
      if (isT) {
        const key = literalKey(node.arguments[0])
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (key === null) {
          dynamic.push({ file, line })
          const arg = node.arguments[0]
          // AppError.i18nKey 是動態資料；若有佔位符卻沒帶 params，使用者會看到字面 {host}
          if (arg && ts.isPropertyAccessExpression(arg) && arg.name.text === 'i18nKey' && node.arguments.length < 2) {
            dynamicErrorKeys.push({ file: path.relative(root, file).replaceAll('\\', '/'), line })
          }
        } else {
          literalCalls += 1
          const values = LOCALES.map((locale) => translations[locale][key]).filter((v) => v !== undefined)
          const placeholders = [...new Set(values.flatMap(placeholdersIn))]
          if (placeholders.length > 0 && node.arguments.length < 2) {
            violations.push({
              file: path.relative(root, file).replaceAll('\\', '/'),
              line,
              key,
              placeholders,
              sample: values[0]
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

const asJson = process.argv.includes('--json')
if (asJson) {
  console.log(JSON.stringify({ checked: literalCalls, violations, dynamicSkipped: dynamic.length, dynamicErrorKeyCalls: dynamicErrorKeys }, null, 2))
} else {
  console.log(
    `i18n placeholder check: ${literalCalls} t('literal') calls, ${dynamic.length} dynamic calls skipped (${dynamicErrorKeys.length} dynamic i18nKey calls without params)`
  )
  if (violations.length === 0) {
    console.log('OK: no literal-key t() call renders {placeholder} without interpolation options')
  } else {
    console.log(`FAIL: ${violations.length} call(s) render {placeholder} without options`)
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}  t('${v.key}')  missing ${v.placeholders.join(', ')}`)
      console.log(`    value: ${v.sample}`)
    }
  }
  for (const d of dynamicErrorKeys) {
    console.log(`  WARN dynamic error key without params: ${d.file}:${d.line}`)
  }
}
process.exit(violations.length === 0 ? 0 : 1)
