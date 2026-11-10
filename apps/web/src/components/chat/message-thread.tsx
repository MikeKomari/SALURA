import { CheckCheck, Footprints, MessagesSquare } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { time } from '../../lib/format.ts';
import { itemIn } from '../../lib/motion.ts';
import type { Message } from '../../lib/types.ts';
import { LogoMark } from '../brand/logo.tsx';
import { Button } from '../ui/button.tsx';
import { Avatar, EmptyState, ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { dayLabel, sameDay } from './chat-format.ts';
import { OrderCard, orderCardFor, type OrderCardData } from './order-card.tsx';
import type { Optimistic, TraceRun } from './use-chat.ts';

interface Item {
  key: string;
  direction: 'in' | 'out';
  kind: Message['kind'];
  text: string | null;
  transcript: string | null;
  mediaUrl: string | null;
  createdAt: string;
  runId: string | null;
  state: 'sent' | 'sending' | 'failed';
  fromAdmin: boolean;
  guest: boolean;
  card: OrderCardData | null;
}

interface ThreadProps {
  messages: Message[] | undefined;
  optimistic: Optimistic[];
  runs: TraceRun[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  typing: boolean;
  customerName: string;
  avatarName: string;
  suggestions: string[];
  onSuggestion: (text: string) => void;
  onShowTrace: (runId: string | null) => void;
}

export function MessageThread({ messages, optimistic, runs, loading, error, onRetry, typing, customerName, avatarName, suggestions, onSuggestion, onShowTrace }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  // Server message id → optimistic key, so the confirmed copy replaces the pending bubble without re-animating.
  const keys = useRef(new Map<number, string>());

  const { items, traced } = useMemo(() => {
    const list = messages ?? [];
    const adminIds = new Set<number>();
    const cards = new Map<string, OrderCardData | null>();
    for (const r of runs) {
      cards.set(r.run.id, orderCardFor(r.steps));
      for (const s of r.steps) {
        const id = (s.data as { messageId?: unknown } | null)?.messageId;
        if (s.type === 'message_out' && s.actor === 'human' && typeof id === 'number') adminIds.add(id);
      }
    }
    const firstReply = new Map<string, number>();
    for (const m of list) if (m.direction === 'out' && m.runId && !adminIds.has(m.id) && !firstReply.has(m.runId)) firstReply.set(m.runId, m.id);

    const claimed = new Set<number>();
    const pending = optimistic.filter((o) => {
      const match = list.find((m) => m.direction === 'in' && m.id > o.baselineId && m.kind === o.kind && !claimed.has(m.id) && (o.kind !== 'text' || m.text === o.text));
      if (!match) return true;
      claimed.add(match.id);
      keys.current.set(match.id, o.key);
      return false;
    });

    const out: Item[] = list.map((m) => ({
      key: keys.current.get(m.id) ?? `m${m.id}`,
      direction: m.direction,
      kind: m.kind,
      text: m.text,
      transcript: m.transcript,
      mediaUrl: m.mediaUrl,
      createdAt: m.createdAt,
      runId: m.runId,
      state: 'sent',
      fromAdmin: adminIds.has(m.id),
      guest: Boolean(m.guest),
      card: m.runId && firstReply.get(m.runId) === m.id ? (cards.get(m.runId) ?? null) : null,
    }));
    for (const o of pending) {
      out.push({ key: o.key, direction: 'in', kind: o.kind, text: o.text ?? null, transcript: null, mediaUrl: o.previewUrl, createdAt: o.createdAt, runId: null, state: o.failed ? 'failed' : 'sending', fromAdmin: false, guest: false, card: null });
    }
    return { items: out, traced: new Set(runs.map((r) => r.run.id)) };
  }, [messages, optimistic, runs]);

  const first = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: first.current ? 'auto' : 'smooth' });
    if (items.length) first.current = false;
  }, [items.length, typing, items[items.length - 1]?.card]);

  // Keep the newest message in view while images and audio finish loading, unless the reader scrolled up.
  const stick = useRef(true);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const list = listRef.current;
    if (!el || !list) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, [loading]);

  if (loading) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-24 w-3/5" />
        <Skeleton className="h-12 w-1/2" />
      </div>
    );
  }

  return (
    <div ref={scroller} onScroll={(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80)} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6" aria-live="polite" aria-relevant="additions">
      {error && (
        <div className="mb-4">
          <ErrorCallout message={error.message} onRetry={onRetry} />
        </div>
      )}
      {!items.length && !error && (
        <EmptyState icon={MessagesSquare} title="Belum ada pesan">
          Tulis pesanan seperti pemilik warung menulis di WhatsApp. Contoh untuk memulai:
        </EmptyState>
      )}
      {!items.length && !error && suggestions.length > 0 && (
        <div className="-mt-4 flex flex-wrap justify-center gap-2 pb-6">
          {suggestions.map((s) => (
            <Button key={s} variant="ghost" size="sm" onClick={() => onSuggestion(s)}>
              {s}
            </Button>
          ))}
        </div>
      )}
      <ol ref={listRef} className="flex flex-col">
        <AnimatePresence initial={false}>
          {items.map((item, i) => {
            const prev = items[i - 1];
            const newDay = !prev || !sameDay(prev.createdAt, item.createdAt);
            const grouped = !newDay && prev?.direction === item.direction;
            return (
              <motion.li key={item.key} layout="position" variants={itemIn} initial="hidden" animate="show" className={grouped ? 'pt-2' : 'pt-4 first:pt-0'}>
                {newDay && (
                  <p className="mb-4 flex justify-center">
                    <span className="rounded-pill bg-surface-muted px-3 py-1 text-meta font-medium text-ink-2">{dayLabel(item.createdAt)}</span>
                  </p>
                )}
                {item.direction === 'in' ? (
                  <Inbound item={item} name={customerName} avatarName={avatarName} showAvatar={!grouped} />
                ) : (
                  <Outbound item={item} onShowTrace={item.runId && traced.has(item.runId) ? () => onShowTrace(item.runId) : undefined} />
                )}
              </motion.li>
            );
          })}
          {typing && (
            <motion.li key="typing" variants={itemIn} initial="hidden" animate="show" exit={{ opacity: 0, transition: { duration: 0.15 } }} className="flex flex-col items-end pt-4">
              <div className="flex items-center gap-2 rounded-inner rounded-br-[4px] bg-surface-muted px-4 py-3 text-body text-ink-2" role="status">
                <motion.span className="size-2 rounded-full bg-primary" animate={{ opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} aria-hidden="true" />
                SALURA sedang mengetik…
              </div>
              <button type="button" onClick={() => onShowTrace(null)} className="mt-1 inline-flex h-8 cursor-pointer items-center gap-1 rounded-pill text-small font-medium text-primary hover:underline">
                <Icon icon={Footprints} size={16} weight="semibold" />
                Lihat agen memeriksa stok dan kredit
              </button>
            </motion.li>
          )}
        </AnimatePresence>
      </ol>
    </div>
  );
}

function Body({ item }: { item: Item }) {
  return (
    <>
      {item.kind === 'voice' && item.mediaUrl && (
        <div className="mt-1">
          <audio controls preload="metadata" src={item.mediaUrl} className="h-10 w-[260px] max-w-full" aria-label="Pesan suara" />
          {item.transcript ? (
            <p className="mt-2 text-body whitespace-pre-wrap text-ink-2 italic">“{item.transcript}”</p>
          ) : (
            item.state === 'sent' && <p className="mt-1 text-small text-ink-3">Belum ditranskripsi</p>
          )}
        </div>
      )}
      {item.kind === 'image' && item.mediaUrl && (
        <a href={item.mediaUrl} target="_blank" rel="noreferrer" className="mt-1 block w-fit overflow-hidden rounded-[8px]">
          <img src={item.mediaUrl} alt="Foto dari pelanggan" className="max-h-60 max-w-full object-cover" loading="lazy" />
        </a>
      )}
      {item.text && <p className={`text-body break-words whitespace-pre-wrap text-ink ${item.kind !== 'text' ? 'mt-2' : ''}`}>{item.text}</p>}
    </>
  );
}

function Inbound({ item, name, avatarName, showAvatar }: { item: Item; name: string; avatarName: string; showAvatar: boolean }) {
  return (
    <div className="flex items-end gap-2">
      <div className="w-8 shrink-0 self-start">{showAvatar && <Avatar name={avatarName} size={32} />}</div>
      <div className="flex max-w-[min(560px,85%)] flex-col items-start">
        <div className={`rounded-inner rounded-tl-[4px] bg-primary-soft px-4 py-2.5 ${item.state === 'sending' ? 'opacity-80' : ''}`}>
          <p className="text-small font-semibold text-ink">{name}</p>
          <Body item={item} />
        </div>
        <p className={`tabular mt-1 text-meta ${item.state === 'failed' ? 'font-medium text-danger-fg' : 'text-ink-3'}`}>
          {item.state === 'sending' ? 'Mengirim…' : item.state === 'failed' ? 'Belum terkirim' : `Diterima ${time(item.createdAt)}${item.guest ? ' · chat uji tamu' : ''}`}
        </p>
      </div>
    </div>
  );
}

function Outbound({ item, onShowTrace }: { item: Item; onShowTrace?: () => void }) {
  return (
    <div className="flex flex-col items-end">
      <div className={`rounded-inner rounded-br-[4px] bg-surface-muted px-4 py-2.5 ${item.card ? 'w-full max-w-[480px]' : 'max-w-[min(560px,85%)]'}`}>
        <p className="flex items-center gap-1.5 text-small font-semibold text-ink">
          {!item.fromAdmin && <LogoMark size={15} className="text-primary" />}
          {item.fromAdmin ? 'Admin distributor' : 'SALURA'}
          <span className="text-primary">
            <Icon icon={CheckCheck} size={16} weight="semibold" />
          </span>
        </p>
        <Body item={item} />
        {item.card && <OrderCard data={item.card} />}
      </div>
      <p className="tabular mt-1 flex items-center gap-2 text-meta text-ink-3">
        Terkirim {time(item.createdAt)}
        {item.guest && ' · chat uji tamu'}
        {onShowTrace && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={onShowTrace} className="inline-flex h-8 cursor-pointer items-center rounded-pill font-medium text-primary hover:underline">
              Lihat jejak agen
            </button>
          </>
        )}
      </p>
    </div>
  );
}
