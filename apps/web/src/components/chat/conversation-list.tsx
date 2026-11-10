import { Image, Mic, Search, UserRoundPlus, UserX } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ease } from '../../lib/motion.ts';
import type { Conversation } from '../../lib/types.ts';
import { Button } from '../ui/button.tsx';
import { Avatar, EmptyState, ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { formatWa, shortWhen } from './chat-format.ts';

interface ListProps {
  conversations: Conversation[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  selected: string | null;
  /** The open number when it is not a registered customer. */
  unknownWaId: string | null;
  onNewNumber: () => void;
  className?: string;
}

export function ConversationList({ conversations, loading, error, onRetry, selected, unknownWaId, onNewNumber, className = '' }: ListProps) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle ? conversations.filter((c) => `${c.name} ${c.honorific} ${c.ownerName}`.toLowerCase().includes(needle)) : conversations;

  return (
    <section aria-label="Daftar percakapan" className={`min-h-0 flex-col rounded-card bg-surface ${className}`}>
      <header className="flex flex-col gap-3 p-4 pb-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className="text-h2 font-semibold text-ink">Pelanggan</h2>
          <Button variant="ghost" size="sm" icon={UserRoundPlus} onClick={onNewNumber} title="Chat dari nomor yang belum terdaftar">
            Nomor baru
          </Button>
        </div>
        <label className="relative flex items-center">
          <span className="pointer-events-none absolute left-4 text-ink-3">
            <Icon icon={Search} size={20} />
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Cari warung atau pemilik"
            placeholder="Cari warung atau pemilik"
            className="h-11 w-full rounded-pill bg-surface-muted pr-4 pl-12 text-body text-ink placeholder:text-ink-3"
          />
        </label>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error && (
          <div className="p-2">
            <ErrorCallout message={error.message} onRetry={onRetry} />
          </div>
        )}
        {loading ? (
          <div className="flex flex-col gap-2 p-2" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {unknownWaId && (
              <li>
                <Row
                  to={`/percakapan/${unknownWaId}`}
                  selected={selected === unknownWaId}
                  avatar={
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-info-bg text-info-fg">
                      <Icon icon={UserX} size={20} />
                    </span>
                  }
                  title="Nomor belum terdaftar"
                  preview={formatWa(unknownWaId)}
                />
              </li>
            )}
            <AnimatePresence initial={false}>
              {shown.map((c) => (
                <motion.li key={c.waId} layout="position" transition={{ duration: 0.2, ease }}>
                  <Row
                    to={`/percakapan/${c.waId}`}
                    selected={selected === c.waId}
                    avatar={<Avatar name={c.name} size={40} />}
                    title={c.name}
                    when={c.lastMessage ? shortWhen(c.lastMessage.at) : undefined}
                    preview={<Preview c={c} />}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
            {!shown.length && !error && (
              <li>
                <EmptyState icon={Search} title="Tidak ditemukan">
                  Tidak ada warung atau pemilik bernama “{q.trim()}”.
                </EmptyState>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

function Preview({ c }: { c: Conversation }) {
  const m = c.lastMessage;
  if (!m) return <span className="text-ink-3">Belum ada pesan · {c.area}</span>;
  const who = m.direction === 'out' ? 'SALURA: ' : '';
  if (m.kind === 'voice' || m.kind === 'image') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {who}
        <Icon icon={m.kind === 'voice' ? Mic : Image} size={16} />
        <span className="truncate">{m.text && !m.text.startsWith('[') ? m.text : m.kind === 'voice' ? 'Pesan suara' : 'Foto'}</span>
      </span>
    );
  }
  return (
    <>
      {who}
      {m.text}
    </>
  );
}

function Row({ to, selected, avatar, title, when, preview }: { to: string; selected: boolean; avatar: React.ReactNode; title: string; when?: string; preview: React.ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={selected ? 'page' : undefined}
      className={`relative flex items-center gap-3 rounded-inner px-3 py-3 transition-colors duration-150 ${selected ? 'bg-primary-soft' : 'hover:bg-surface-muted'}`}
    >
      {selected && <motion.span layoutId="chat-selected" className="absolute top-2 bottom-2 left-0 w-1 rounded-r-pill bg-primary" transition={{ duration: 0.2, ease }} />}
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-h3 font-semibold text-ink">{title}</span>
          {when && <span className="tabular shrink-0 text-meta text-ink-3">{when}</span>}
        </span>
        <span className="block truncate text-small text-ink-2">{preview}</span>
      </span>
    </Link>
  );
}
