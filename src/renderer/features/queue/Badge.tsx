import { useTranslation } from 'react-i18next'

/** 傳輸佇列徽章（UI-01 ⑥ / UI-04 收合主列）：活動計數 + aria 全文 */
export function Badge({ count }: { count: number }): JSX.Element | null {
  const { t } = useTranslation()
  if (count <= 0) return null
  return (
    <span className="rs-badge" aria-label={t('queue.badge.active', { count })}>
      {count}
    </span>
  )
}
