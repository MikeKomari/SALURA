import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef } from 'react';
import { ease } from '../../lib/motion.ts';
import { Icon } from './icon.tsx';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export function Dialog({ open, onClose, title, children, actions }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('input, textarea, button:not([aria-label="Tutup"])')?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40 grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.18 } }}>
          <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease } }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.18, ease } }}
            className="relative w-full max-w-[520px] rounded-card bg-surface p-6 shadow-pop"
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <h2 id={titleId} className="text-h2 font-semibold">
                {title}
              </h2>
              <button type="button" aria-label="Tutup" onClick={onClose} className="-m-2 grid size-10 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-muted hover:text-ink">
                <Icon icon={X} size={20} />
              </button>
            </div>
            <div className="text-body text-ink-2">{children}</div>
            {actions && <div className="mt-6 flex flex-wrap justify-end gap-3">{actions}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
