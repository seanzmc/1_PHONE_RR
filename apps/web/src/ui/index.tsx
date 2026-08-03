import { isValidElement } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

/* ── Button ─────────────────────────────────────────────────────────────── */

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  block?: boolean
  ref?: Ref<HTMLButtonElement>
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'ui-btn-primary',
  ghost: 'ui-btn-ghost',
  danger: 'ui-btn-danger',
}

export function Button({ variant = 'default', size = 'md', block = false, className, type, ref, ...rest }: ButtonProps) {
  const classes = [
    'ui-btn',
    VARIANT_CLASS[variant],
    size === 'sm' ? 'ui-btn-sm' : '',
    block ? 'ui-btn-block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  return <button ref={ref} type={type ?? 'button'} className={classes} {...rest} />
}

/* ── Field ──────────────────────────────────────────────────────────────── */

export type FieldProps = {
  label: string
  hint?: string
  error?: string | null
  children: ReactNode
}

export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <div className="ui-field">
      <label>
        {label}
        {children}
      </label>
      {hint && <p className="ui-hint">{hint}</p>}
      {error && <p className="ui-error" role="alert">{error}</p>}
    </div>
  )
}

export function Input({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={['ui-input', className ?? ''].filter(Boolean).join(' ')} {...rest} />
}

export function Textarea({
  className,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={['ui-input', className ?? ''].filter(Boolean).join(' ')} {...rest} />
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={['ui-select', className ?? ''].filter(Boolean).join(' ')} {...rest} />
}

/* ── Card ───────────────────────────────────────────────────────────────── */

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  title?: string
  kicker?: string
  children?: ReactNode
}

export function Card({ title, kicker, children, className, ...rest }: CardProps) {
  return (
    <div className={['ui-card', className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {kicker && <span className="ui-card-kicker">{kicker}</span>}
      {title && <h4 className="ui-card-title">{title}</h4>}
      {children}
    </div>
  )
}

/** Single big number + label, for the rep dashboard counters. */
export function MetricCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card>
      <span className="ui-card-kicker">{label}</span>
      <span className="ui-card-metric">{value}</span>
      {hint && <span className="ui-hint">{hint}</span>}
    </Card>
  )
}

/* ── Badge ──────────────────────────────────────────────────────────────── */

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'outline'

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: '',
  ok: 'ui-badge-ok',
  warn: 'ui-badge-warn',
  danger: 'ui-badge-danger',
  accent: 'ui-badge-accent',
  outline: 'ui-badge-outline',
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={['ui-badge', TONE_CLASS[tone]].filter(Boolean).join(' ')}>{children}</span>
}

/* ── Table ──────────────────────────────────────────────────────────────── */

export type TableHeader = {
  content: ReactNode
  ariaSort?: 'ascending' | 'descending'
}

function isTableHeader(header: ReactNode | TableHeader): header is TableHeader {
  return !!header && typeof header === 'object' && !Array.isArray(header) && !isValidElement(header) && 'content' in header
}

export function Table({ headers, children }: { headers: Array<ReactNode | TableHeader>; children: ReactNode }) {
  return (
    <div className="ui-table-scroll">
      <table className="ui-table">
        <thead>
          <tr>
            {headers.map((header, i) => {
              if (isTableHeader(header)) {
                return <th key={i} aria-sort={header.ariaSort}>{header.content}</th>
              }
              return <th key={i}>{header}</th>
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
