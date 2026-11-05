import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { QueuePanel } from '../../src/renderer/features/queue/QueuePanel'
import type { TransferTask } from '../../src/shared/ipc-contract'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

/** 契約 v1.11 目錄任務：一列 + children（3 完成 / 5 檔） */
const dirTask: TransferTask = {
  taskId: 'dir1',
  sessionId: 's1',
  connectionLabel: 'prod-web-01',
  direction: 'upload',
  source: 'C:\\src\\site',
  target: '/var/www/site',
  isDirectory: true,
  totalBytes: 1000,
  transferredBytes: 420,
  bytesPerSec: 1024,
  etaSec: 5,
  state: 'running',
  attempts: 1,
  createdAt: '2026-10-30T00:00:00Z',
  children: [
    { taskId: 'c1', source: 'C:\\src\\site\\a.html', target: '/var/www/site/a.html', size: 100, state: 'completed' },
    { taskId: 'c2', source: 'C:\\src\\site\\b.css', target: '/var/www/site/b.css', size: 100, state: 'completed' },
    { taskId: 'c3', source: 'C:\\src\\site\\c.js', target: '/var/www/site/c.js', size: 100, state: 'completed' },
    { taskId: 'c4', source: 'C:\\src\\site\\d.png', target: '/var/www/site/d.png', size: 100, state: 'running' },
    { taskId: 'c5', source: 'C:\\src\\site\\\u5831\u8868.xlsx', target: '/var/www/site/\u5831\u8868.xlsx', size: 100, state: 'queued' }
  ]
}

function renderPanel(tasks: TransferTask[]): ReturnType<typeof render> {
  return render(
    wrap(
      <QueuePanel
        collapsed={false}
        height={200}
        tasks={tasks}
        onToggle={() => undefined}
        onHeightChange={() => undefined}
        onRequest={() => undefined}
        onClearCompleted={() => undefined}
      />
    )
  )
}

describe('M4-05 契約 v1.11 目錄任務（一列 + children）', () => {
  it('父列顯示彙總進度（百分比 + 已完成/總檔數），子列預設隱藏', () => {
    renderPanel([dirTask])
    // 42% · 3/5（transferredBytes/totalBytes=42%，3 個 completed）
    expect(screen.getByText('42% \u00B7 3/5')).toBeTruthy()
    expect(screen.queryByText('C:\\src\\site\\a.html')).toBeNull()
  })

  it('展開後顯示子列；同一 taskId 重繪（tasks 陣列更新）不收起', () => {
    const { rerender } = renderPanel([dirTask])
    const toggle = screen.getAllByRole('button', { expanded: false })[0] as HTMLElement
    fireEvent.click(toggle)
    expect(screen.getByText('C:\\src\\site\\a.html')).toBeTruthy()
    expect(screen.getByText('C:\\src\\site\\\u5831\u8868.xlsx')).toBeTruthy()

    // 後端批次更新：同 taskId 重新進來（transferredBytes 進度變動）→ 展開狀態保留
    const updated: TransferTask = { ...dirTask, transferredBytes: 500, children: dirTask.children }
    rerender(
      wrap(
        <QueuePanel
          collapsed={false}
          height={200}
          tasks={[updated]}
          onToggle={() => undefined}
          onHeightChange={() => undefined}
          onRequest={() => undefined}
          onClearCompleted={() => undefined}
        />
      )
    )
    expect(screen.getByText('C:\\src\\site\\a.html')).toBeTruthy()
    expect(screen.getAllByRole('button', { expanded: true }).length).toBeGreaterThan(0)
  })

  it('needsRetransfer=true 的列顯示「需重傳」（queue.needRetry）', () => {
    const task: TransferTask = {
      taskId: 't9',
      sessionId: 's1',
      connectionLabel: 'prod-web-01',
      direction: 'download',
      source: '/var/log/app.log',
      target: 'C:\\dl\\app.log',
      isDirectory: false,
      transferredBytes: 0,
      bytesPerSec: 0,
      state: 'failed',
      attempts: 2,
      createdAt: '2026-10-30T00:00:00Z',
      needsRetransfer: true
    }
    renderPanel([task])
    expect(screen.getByText('Needs retry')).toBeTruthy()
  })

  it('斷線橫幅 N = 暫停中的任務數（不含 completed/cancelled）', () => {
    const paused: TransferTask = {
      taskId: 'p1',
      sessionId: 's1',
      connectionLabel: 'prod-web-01',
      direction: 'upload',
      source: 'C:\\a',
      target: '/a',
      isDirectory: false,
      transferredBytes: 10,
      bytesPerSec: 0,
      state: 'paused',
      attempts: 1,
      createdAt: '2026-10-30T00:00:00Z'
    }
    const done: TransferTask = { ...paused, taskId: 'p2', state: 'completed' }
    const cancelled: TransferTask = { ...paused, taskId: 'p3', state: 'cancelled' }
    renderPanel([paused, done, cancelled])
    expect(screen.getByText('Connection lost; 1 transfers paused')).toBeTruthy()
  })
})
