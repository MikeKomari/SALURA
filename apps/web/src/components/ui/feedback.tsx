import type { LucideIcon } from 'lucide-react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from './button.tsx';
import { Icon } from './icon.tsx';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-inner bg-surface-muted motion-reduce:animate-none ${className}`} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: LucideIcon; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {icon && (
        <span className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary">
          <Icon icon={icon} size={24} />
        </span>
      )}
      <p className="text-h3 font-semibold text-ink">{title}</p>
      {children && <p className="max-w-sm text-body text-ink-2">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorCallout({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-inner bg-danger-bg px-4 py-3 text-danger-fg">
      <Icon icon={TriangleAlert} size={20} weight="semibold" />
      <p className="min-w-0 flex-1 text-body">{message}</p>
      {onRetry && (
        <Button variant="danger" size="sm" icon={RotateCcw} onClick={onRetry}>
          Coba lagi
        </Button>
      )}
    </div>
  );
}

export function Avatar({ name, size = 40, tone = 'soft' }: { name: string; size?: number; tone?: 'soft' | 'strong' }) {
  const initials = name
    .replace(/^(warung|toko|minimarket|agen|warung kopi|warung madura|toko kelontong|agen sembako)\s+/i, '')
    .split(/\s+/)
    .filter((w) => !/^(pak|bu|mas|mbak)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${tone === 'soft' ? 'bg-primary-soft text-primary' : 'bg-primary text-white'}`}
    >
      {initials || '?'}
    </span>
  );
}
