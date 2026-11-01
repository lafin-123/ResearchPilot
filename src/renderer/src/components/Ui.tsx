import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import clsx from 'clsx'

export function Button({
  variant = 'secondary',
  size,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' }): ReactNode {
  return (
    <button className={clsx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)} {...props}>
      {children}
    </button>
  )
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): ReactNode {
  return (
    <button className={clsx('btn btn-ghost btn-icon', className)} title={label} aria-label={label} {...props}>
      {children}
    </button>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...props} className={clsx('input', props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return <select {...props} className={clsx('select', props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea {...props} className={clsx('textarea', props.className)} />
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'gold' | 'danger' | 'ok' | 'blue'; children: ReactNode }): ReactNode {
  return <span className={clsx('badge', `badge-${tone}`)}>{children}</span>
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions
}: {
  eyebrow?: string
  title: string
  subtitle?: string
  actions?: ReactNode
}): ReactNode {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  text,
  action
}: {
  icon?: ReactNode
  title: string
  text?: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div className="empty-title">{title}</div>
      {text ? <div className="empty-text">{text}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  size = 'normal'
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  size?: 'normal' | 'wide' | 'narrow'
}): ReactNode {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    if (!dialog?.contains(document.activeElement)) dialog?.focus()
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
      if (event.key !== 'Tab' || !dialog) return
      const targets = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter((el) => el.getClientRects().length > 0)
      const first = targets[0]
      const last = targets.at(-1)
      if (!first || !last) { event.preventDefault(); dialog.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handler)
    return () => { window.removeEventListener('keydown', handler); if (previous?.isConnected) previous.focus() }
  }, [])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} tabIndex={-1} className={clsx('modal', size === 'wide' && 'wide', size === 'narrow' && 'narrow')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <div className="row-between">
            <div>
              <h2 id={titleId} className="modal-title">{title}</h2>
              {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
            </div>
            <IconButton label="关闭" onClick={onClose}>
              <X />
            </IconButton>
          </div>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}

export function Spinner({ label }: { label?: string }): ReactNode {
  return (
    <div className="boot-card">
      <div className="spinner" />
      {label ? <div>{label}</div> : null}
    </div>
  )
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  const map: Record<string, { tone: 'neutral' | 'accent' | 'gold' | 'danger' | 'ok' | 'blue'; label: string }> = {
    idle: { tone: 'neutral', label: '空闲' },
    queued: { tone: 'gold', label: '排队中' },
    running: { tone: 'blue', label: '运行中' },
    succeeded: { tone: 'ok', label: '成功' },
    completed: { tone: 'ok', label: '已完成' },
    failed: { tone: 'danger', label: '失败' },
    cancelled: { tone: 'neutral', label: '已取消' },
    stopped: { tone: 'neutral', label: '已停止' },
    paused: { tone: 'gold', label: '待继续' },
    pending: { tone: 'neutral', label: '待执行' },
    skipped: { tone: 'neutral', label: '跳过' },
    error: { tone: 'danger', label: '错误' },
    starting: { tone: 'gold', label: '启动中' },
    unconfigured: { tone: 'gold', label: '未配置' }
  }
  const item = map[status] ?? { tone: 'neutral' as const, label: status }
  return <Badge tone={item.tone}>{item.label}</Badge>
}
