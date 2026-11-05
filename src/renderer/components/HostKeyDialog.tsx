import { useTranslation } from 'react-i18next'
import type { HostKeyDecision, HostKeyPrompt } from '../../shared/ipc-contract'
import { Button } from './Button'
import { Modal } from './Modal'

export interface HostKeyDialogProps {
  prompt: HostKeyPrompt | null
  onAnswer: (requestId: string, decision: HostKeyDecision) => void
}

/** 首連指紋確認（UI-07 A10）：接受一次／永久接受／拒絕 */
export function HostKeyDialog({ prompt, onAnswer }: HostKeyDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!prompt) return null
  const changed = Boolean(prompt.knownPrevious)

  return (
    <Modal
      open
      title={changed ? t('hostkey.changed.title') : t('hostkey.title')}
      onClose={() => onAnswer(prompt.requestId, 'reject')}
      footer={
        <>
          <Button variant="danger" onClick={() => onAnswer(prompt.requestId, 'reject')}>
            {t('hostkey.reject')}
          </Button>
          <Button onClick={() => onAnswer(prompt.requestId, 'once')}>{t('hostkey.acceptOnce')}</Button>
          <Button variant="primary" onClick={() => onAnswer(prompt.requestId, 'always')}>
            {t('hostkey.acceptAlways')}
          </Button>
        </>
      }
    >
      {changed ? <p className="rs-danger">{t('hostkey.changed.warning')}</p> : <p>{t('hostkey.description')}</p>}
      <dl className="rs-kv">
        <dt>{t('dialog.connection.field.host')}</dt>
        <dd>
          {prompt.host}:{prompt.port}
        </dd>
        <dt>{t('hostkey.keyType')}</dt>
        <dd>{prompt.keyType}</dd>
        <dt>{t('hostkey.fingerprint')}</dt>
        <dd className="rs-mono">{prompt.fingerprintSha256}</dd>
        {changed ? (
          <>
            <dt>{t('hostkey.previousFingerprint', { fingerprint: '' })}</dt>
            <dd className="rs-mono">{prompt.knownPrevious}</dd>
          </>
        ) : null}
      </dl>
    </Modal>
  )
}
