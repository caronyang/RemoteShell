import { useId, type InputHTMLAttributes } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  label: string
  onCheckedChange?: (checked: boolean) => void
}

export function Checkbox({ label, id, onCheckedChange, className, ...rest }: CheckboxProps): JSX.Element {
  const autoId = useId()
  const boxId = id ?? autoId
  return (
    <div className={['rs-checkbox', className].filter(Boolean).join(' ')}>
      <input
        id={boxId}
        type="checkbox"
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        {...rest}
      />
      <label htmlFor={boxId}>{label}</label>
    </div>
  )
}
