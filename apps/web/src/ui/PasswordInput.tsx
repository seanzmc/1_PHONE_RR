import { useState, type InputHTMLAttributes } from 'react'
import { Input } from './index'
import { passwordVisibilityLabel } from './passwordVisibility'

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string
}

export function PasswordInput({ label, className, ...inputProps }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <span className="ui-password-input">
      <Input
        {...inputProps}
        className={className}
        type={visible ? 'text' : 'password'}
        aria-label={inputProps['aria-label'] ?? label}
      />
      <button
        type="button"
        className="ui-password-toggle"
        aria-label={passwordVisibilityLabel(label, visible)}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </span>
  )
}
