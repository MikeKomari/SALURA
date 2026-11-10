import { CircleCheck, CircleX } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef } from 'react';
import { relative } from '../../lib/format.ts';
import { ease, itemIn } from '../../lib/motion.ts';
import type { Approval } from '../../lib/types.ts';
import { Chip } from '../ui/chip.tsx';
import { Avatar, Skeleton } from '../ui/feedback.tsx';
import { approvalAmount, customerName, reasonText, TYPE_META } from './copy.ts';

interface ApprovalListProps {
  items: Approval[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  mode: 'pending' | 'history';
  now: number;
}

export function ApprovalList({ items, selectedId, onSelect, mode, now }: ApprovalListProps) {
  const list = useRef<HTMLUListElement>(null);

  // Arrow keys move between rows, like a list box; Tab still leaves the list.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    next.focus();
    onSelect(Number(next.dataset.row));
  };

  return (
    <ul ref={list} onKeyDown={onKeyDown} aria-label={mode === 'pending' ? 'Daftar yang menunggu keputusan' : 'Riwayat keputusan'} className="flex flex-col gap-1">
      <AnimatePresence initial={false}>
        {items.map((a) => (
          <motion.li key={a.id} layout variants={itemIn} initial="hidden" animate="show" exit="exit" transition={{ layout: { duration: 0.22, ease } }} className="overflow-hidden">
            <Row approval={a} selected={a.id === selectedId} onSelect={onSelect} mode={mode} now={now} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function Row({ approval: a, selected, onSelect, mode, now }: { approval: Approval; selected: boolean; onSelect: (id: number) => void; mode: 'pending' | 'history'; now: number }) {
  const meta = TYPE_META[a.type];
  const amount = approvalAmount(a);
  const name = customerName(a);
  const when = mode === 'pending' ? a.requestedAt : (a.decidedAt ?? a.requestedAt);
  return (
    <button
      type="button"
      data-row={a.id}
      onClick={() => onSelect(a.id)}
      aria-current={selected ? 'true' : undefined}
      className={`relative flex w-full cursor-pointer items-start gap-3 rounded-inner py-3 pr-3 pl-4 text-left transition-colors duration-150 focus-visible:-outline-offset-2 ${
        selected ? 'bg-primary-soft' : 'hover:bg-surface-muted'
      }`}
    >
      {selected && <span className="absolute top-2 bottom-2 left-0 w-1 rounded-pill bg-primary" aria-hidden="true" />}
      <Avatar name={name} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-h3 font-semibold text-ink">{name}</p>
          <span className="tabular shrink-0 text-meta text-ink-3">{relative(when, now)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Chip tone={meta.tone} icon={meta.icon}>
            {meta.label}
          </Chip>
          {a.guest && <Chip tone="info">Chat uji tamu</Chip>}
          {mode === 'history' &&
            (a.status === 'approved' ? (
              <Chip tone="success" icon={CircleCheck}>
                {a.type === 'escalation' ? 'Selesai' : 'Disetujui'}
              </Chip>
            ) : (
              <Chip tone="danger" icon={CircleX}>
                {a.type === 'escalation' ? 'Diabaikan' : 'Ditolak'}
              </Chip>
            ))}
          {amount && <span className="tabular text-label font-semibold text-ink">{amount}</span>}
        </div>
        <p className="mt-1 line-clamp-1 text-small text-ink-2">{reasonText(a).text}</p>
      </div>
    </button>
  );
}

export function ApprovalListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3 p-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-[26px] w-1/2" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
