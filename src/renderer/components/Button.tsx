import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  icon?: IconName
  children?: ReactNode
}

export function Button({ variant = 'secondary', icon, children, className, ...rest }: ButtonProps): JSX.Element {
  const classes = ['rs-btn', `rs-btn--${variant}`, className].filter(Boolean).join(' ')
  return (
    <button type="button" className={classes} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  )
}
