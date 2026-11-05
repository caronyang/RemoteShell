import { useId, type InputHTMLAttributes } from 'react'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?: string
  error?: string
  onValueChange?: (value: string) => void
}

export function Input({ label, error, id, onValueChange, className, ...rest }: InputProps): JSX.Element {
  const autoId = useId()
  const inputId = id ?? autoId
  const classes = ['rs-input', className].filter(Boolean).join(' ')
  return (
    <div className="rs-field">
      {label ? (
        <label className="rs-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        className={classes}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(event) => onValueChange?.(event.target.value)}
        {...rest}
      />
      {error ? (
        <p className="rs-field__error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
