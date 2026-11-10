import { Check, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { press } from '../../lib/motion.ts';
import { Icon } from '../ui/icon.tsx';

/** Copies text and reports success for 2 seconds. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return { copied, copy };
}

/** Copy → check icon swap (DESIGN.md §12: scale 0.25 → 1, blur 4px → 0). */
export function CopyIcon({ copied }: { copied: boolean }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={copied ? 'check' : 'copy'}
        initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
        transition={press}
        className="grid"
      >
        <Icon icon={copied ? Check : Copy} size={16} weight="semibold" />
      </motion.span>
    </AnimatePresence>
  );
}

/** A shell command with a copy button. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex items-center gap-2 rounded-inner bg-surface-muted py-1.5 pr-1.5 pl-4">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[15px] leading-6 whitespace-pre text-ink">{code}</code>
      <button
        type="button"
        onClick={() => void copy(code)}
        aria-label={copied ? 'Tersalin' : `Salin perintah ${label ?? code}`}
        title={copied ? 'Tersalin' : 'Salin'}
        className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-pill bg-surface px-3 text-small font-medium text-ink transition-colors hover:bg-primary-soft hover:text-primary"
      >
        <CopyIcon copied={copied} />
        {copied ? 'Tersalin' : 'Salin'}
      </button>
    </div>
  );
}
