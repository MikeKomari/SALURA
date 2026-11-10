import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useState } from 'react';
import { ease } from '../../lib/motion.ts';
import { Icon } from './icon.tsx';

interface Toast {
  id: number;
  tone: 'success' | 'error';
  text: string;
  /**
   * One named follow-up on the toast itself, used for undo. DESIGN.md §2.4: it says what it does,
   * so "Batalkan tindakan ini", never "Undo". A toast with an action stays long enough to be read.
   */
  action?: { label: string; onClick: () => void };
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    // Errors stay until closed (DESIGN.md §7). An undo needs reading time: 12s, not 5s.
    if (t.tone === 'success') setTimeout(() => dismiss(id), t.action ? 12_000 : 5000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease } }}
              exit={{ opacity: 0, y: 6, transition: { duration: 0.16, ease } }}
              className="pointer-events-auto flex items-start gap-3 rounded-inner bg-surface p-4 shadow-pop"
              role={t.tone === 'error' ? 'alert' : 'status'}
            >
              <span className={t.tone === 'success' ? 'text-primary' : 'text-danger-fg'}>
                <Icon icon={t.tone === 'success' ? CircleCheck : TriangleAlert} size={20} weight="semibold" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body text-ink">{t.text}</p>
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(t.id);
                      t.action!.onClick();
                    }}
                    className="mt-1 inline-flex h-10 cursor-pointer items-center rounded-pill text-label font-semibold text-primary hover:underline"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button type="button" aria-label="Tutup" onClick={() => dismiss(t.id)} className="-m-1 grid size-8 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-muted hover:text-ink">
                <Icon icon={X} size={16} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
