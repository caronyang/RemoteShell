import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initI18n } from './i18n'
import '@xterm/xterm/css/xterm.css'
import './styles/base.css'

const i18n = initI18n('en-US', { dev: import.meta.env.DEV })
document.documentElement.setAttribute('lang', 'en-US')

const container = document.getElementById('root')
if (!container) throw new Error('#root container is missing')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

// 熱重載時避免重複初始化
void i18n
