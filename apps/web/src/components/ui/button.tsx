import type { LucideIcon } from 'lucide-react';
import { LoaderCircle } from 'lucide-react';
import { motion, type HTMLMotionProps } from 'motion/react';
import { fast, press } from '../../lib/motion.ts';
import { Icon } from './icon.tsx';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger';

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  size?: 'md' | 'sm';
  icon?: LucideIcon;
  loading?: boolean;
  children: React.ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-strong',
  outline: 'bg-surface text-primary border border-primary hover:bg-primary-soft',
  ghost: 'bg-surface text-ink border border-border hover:bg-surface-muted',
  danger: 'bg-surface text-danger-fg border border-danger-fg hover:bg-danger-bg',
};

export function Button({ variant = 'primary', size = 'md', icon, loading, disabled, className = '', children, ...rest }: ButtonProps) {
  const isDisabled = disabled || loading;
  // DESIGN.md §2.5 wants >=40px hit areas on touch; the dense 32px of the reference is kept
  // from lg up, where there is a mouse.
  const height = size === 'md' ? 'h-11 px-5 text-label' : 'h-10 px-3 text-small font-medium lg:h-8';
  return (
    <motion.button
      type="button"
      whileTap={isDisabled ? undefined : { scale: 0.97 }}
      transition={press}
      disabled={isDisabled}
      className={`group relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-pill font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:border-transparent disabled:bg-surface-muted disabled:text-ink-3 ${height} ${variants[variant]} ${className}`}
      {...rest}
    >
      {(icon || loading) && (
        <span
          className={`grid place-items-center transition-transform duration-150 group-hover:translate-x-0.5 ${
            variant === 'primary' && size === 'md' ? '-ml-2 size-7 rounded-full bg-white text-primary' : ''
          }`}
        >
          {loading ? (
            <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }} className="grid">
              <Icon icon={LoaderCircle} size={16} weight="semibold" />
            </motion.span>
          ) : (
            icon && <Icon icon={icon} size={16} weight="semibold" />
          )}
        </span>
      )}
      <motion.span layout="position" transition={fast}>
        {children}
      </motion.span>
    </motion.button>
  );
}

interface IconButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  icon: LucideIcon;
  label: string;
  badge?: number;
}

/** Circular icon-only button (top bar, composer). Always labelled for screen readers and on hover. */
export function IconButton({ icon, label, badge, className = '', ...rest }: IconButtonProps) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.95 }}
      transition={press}
      className={`relative grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border border-border bg-surface text-ink-2 transition-colors duration-150 hover:bg-surface-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...rest}
    >
      <Icon icon={icon} size={20} />
      {badge ? (
        <span className="tabular absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-pill bg-primary px-1 text-meta font-semibold text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </motion.button>
  );
}
