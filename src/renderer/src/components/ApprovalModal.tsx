import { useState, type ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useAppStore } from '../store/app'
import { Badge, Button, Modal } from './Ui'

const RISK_LABEL = {
  low: { tone: 'ok' as const, label: '低风险' },
  medium: { tone: 'gold' as const, label: '中风险' },
  high: { tone: 'danger' as const, label: '高风险' }
}

export function ApprovalModal(): ReactNode {
  const approvals = useAppStore((state) => state.approvals)
  const respond = useAppStore((state) => state.respondApproval)
  const [remember, setRemember] = useState(false)
  const request = approvals[0]
  if (!request) return null
  const risk = RISK_LABEL[request.risk]

  return (
    <Modal
      title={request.title}
      subtitle={request.description}
      size="narrow"
      onClose={() => void respond(request.id, false, false)}
      footer={(
        <>
          <Button onClick={() => void respond(request.id, false, false)}>拒绝</Button>
          <Button variant={request.risk === 'high' ? 'danger' : 'primary'} onClick={() => void respond(request.id, true, remember)}>
            允许本次操作
          </Button>
        </>
      )}
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <span style={{ color: request.risk === 'high' ? 'var(--danger)' : 'var(--gold)' }}><ShieldAlert size={17} /></span>
        <Badge tone={risk.tone}>{risk.label}</Badge>
        {approvals.length > 1 ? <span className="tiny muted">还有 {approvals.length - 1} 个待确认</span> : null}
      </div>
      <div className="alert alert-warn" style={{ marginBottom: 12 }}>
        智能体请求执行一个会改变外部状态或消耗资源的操作。请确认命令、主机和实验代码符合你的预期。
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          maxHeight: 300,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: 'var(--panel-2)',
          border: '1px solid var(--line-strong)',
          borderRadius: 9,
          padding: 12,
          fontSize: 11
        }}
      >
        {request.details}
      </pre>
      <label className="checkbox-row mt-4">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        本次会话中记住相同操作
      </label>
    </Modal>
  )
}
