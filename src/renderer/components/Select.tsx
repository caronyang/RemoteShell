import { useId, type SelectHTMLAttributes } from 'react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label?: string
  options: SelectOption[]
  onValueChange?: (value: string) => void
}

export function Select({ label, options, id, onValueChange, className, ...rest }: SelectProps): JSX.Element {
  const autoId = useId()
  const selectId = id ?? autoId
  const classes = ['rs-select', className].filter(Boolean).join(' ')
  return (
    <div className="rs-field">
      {label ? (
        <label className="rs-field__label" htmlFor={selectId}>
          {label}
        </label>
      ) : null}
      <select id={selectId} className={classes} onChange={(e) => onValueChange?.(e.target.value)} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
