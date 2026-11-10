import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef } from 'react';
import { ease } from '../../lib/motion.ts';
import { Icon } from '../ui/icon.tsx';

interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** Right-hand detail panel (DESIGN.md §12: x 24 → 0, exit softer than enter). */
export function SlideOver({ open, onClose, title, subtitle, children, footer }: SlideOverProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => panel.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.18 } }}>
          <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0, transition: { duration: 0.25, ease } }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.18, ease } }}
            className="absolute inset-y-0 right-0 flex w-full max-w-[600px] flex-col bg-surface shadow-pop outline-none sm:inset-y-3 sm:right-3 sm:rounded-card"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div className="min-w-0">
                <h2 id={titleId} className="text-h2 font-semibold text-ink">
                  {title}
                </h2>
                {subtitle && <div className="mt-1 text-small text-ink-3">{subtitle}</div>}
              </div>
              <button
                type="button"
                aria-label="Tutup"
                title="Tutup"
                onClick={onClose}
                className="-m-2 grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-muted hover:text-ink"
              >
                <Icon icon={X} size={20} />
              </button>
            </header>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
            {footer && <footer className="flex flex-wrap justify-end gap-3 border-t border-border px-6 py-4">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Small section heading used inside slide-overs. */
export function PanelSection({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`mt-6 first:mt-0 ${className}`}>
      <h3 className="mb-3 text-h3 font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}
