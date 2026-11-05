/** ESLint 設定（v8 legacy config，依任務卡要求使用 .eslintrc.cjs） */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'spikes/',
    'build/',
    'coverage/',
    '*.cjs',
    '*.mjs'
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    // 秘密不得進 console；只允許 warn / error（logger 已做 redaction）
    'no-console': ['error', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'smart'],
    // 色票只能出現在 tokens.css（CSS 不走 eslint，因此等於禁止 TS/TSX 內硬編色碼）
    'no-restricted-syntax': [
      'error',
      {
        selector: "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
        message: 'Do not hard-code colour values; use CSS variables from styles/tokens.css.'
      }
    ]
  },
  overrides: [
    {
      files: ['tests/**/*.ts', 'src/renderer/**/*.tsx'],
      env: { node: true, browser: true }
    }
  ]
}
