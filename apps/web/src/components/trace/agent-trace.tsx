import {
  ChevronDown,
  CircleCheck,
  Lightbulb,
  MessageSquare,
  Send,
  ShieldCheck,
  TriangleAlert,
  UserCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { number, seconds as formatSeconds, time } from '../../lib/format.ts';
import { ease, itemIn } from '../../lib/motion.ts';
import type { AgentRun, AuditEntry } from '../../lib/types.ts';
import { Chip, type Tone } from '../ui/chip.tsx';
import { Icon } from '../ui/icon.tsx';

export const TOOL_LABEL: Record<string, string> = {
  get_customer_profile: 'Profil pelanggan',
  transcribe_audio: 'Transkripsi pesan suara',
  read_order_image: 'Baca foto pesanan',
  search_catalog: 'Cari di katalog',
  check_stock: 'Cek stok',
  check_credit: 'Cek limit kredit',
  draft_order: 'Susun draf pesanan',
  confirm_order: 'Konfirmasi pesanan',
  split_order: 'Pecah pesanan',
  request_approval: 'Minta persetujuan pemilik',
  cancel_order: 'Batalkan pesanan',
  record_promise_to_pay: 'Catat janji bayar',
  search_policies: 'Cari kebijakan distributor',
  escalate_to_human: 'Alihkan ke admin',
  get_overdue_invoices: 'Ambil tagihan jatuh tempo',
  draft_reminder: 'Siapkan pengingat bayar',
};

interface Step {
  key: number;
  kind: 'message_in' | 'message_out' | 'thought' | 'tool' | 'validation' | 'approval' | 'error';
  title: string;
  summary: string;
  ts: string;
  durationMs: number | null;
  tone: Tone;
  icon: LucideIcon;
  input?: unknown;
  output?: unknown;
  refused?: boolean;
}

/** Folds the raw audit log into readable steps: a tool call and its result become one step. */
export function buildSteps(entries: AuditEntry[]): Step[] {
  const steps: Step[] = [];
  for (const e of entries) {
    const base = { key: e.id, ts: e.ts, durationMs: e.durationMs, summary: e.summary };
    switch (e.type) {
      case 'message_in':
        steps.push({ ...base, kind: 'message_in', title: 'Pesan masuk', tone: 'neutral', icon: MessageSquare });
        break;
      case 'message_out':
        steps.push({ ...base, kind: 'message_out', title: e.actor === 'human' ? 'Pesan dari admin' : 'Balasan terkirim', tone: 'success', icon: Send });
        break;
      case 'thought':
        steps.push({ ...base, kind: 'thought', title: 'Rencana agen', tone: 'info', icon: Lightbulb });
        break;
      case 'tool_call':
        steps.push({ ...base, kind: 'tool', title: TOOL_LABEL[e.tool ?? ''] ?? e.tool ?? 'Alat', summary: 'Sedang berjalan…', tone: 'neutral', icon: Wrench, input: e.data });
        break;
      case 'tool_result':
      case 'validation':
      case 'error': {
        const open = [...steps].reverse().find((s) => s.kind === 'tool' && s.output === undefined && s.title === (TOOL_LABEL[e.tool ?? ''] ?? e.tool));
        if (open && e.tool) {
          open.output = e.data ?? null;
          open.summary = e.summary;
          open.durationMs = e.durationMs;
          if (e.type === 'tool_result') Object.assign(open, { tone: 'success', icon: CircleCheck });
          else if (e.type === 'validation') Object.assign(open, { tone: 'warning', icon: ShieldCheck, refused: true });
          else Object.assign(open, { tone: 'danger', icon: TriangleAlert });
        } else if (e.type === 'validation') {
          steps.push({ ...base, kind: 'validation', title: 'Pengaman aturan bisnis', tone: 'warning', icon: ShieldCheck, output: e.data });
        } else if (e.type === 'error') {
          steps.push({ ...base, kind: 'error', title: 'Masalah', tone: 'danger', icon: TriangleAlert, output: e.data });
        }
        break;
      }
      case 'approval':
        steps.push({ ...base, kind: 'approval', title: 'Keputusan admin', tone: 'success', icon: UserCheck, output: e.data });
        break;
    }
  }
  return steps;
}

const RUN_STATUS: Record<AgentRun['status'], { label: string; tone: Tone }> = {
  running: { label: 'Sedang bekerja', tone: 'info' },
  completed: { label: 'Selesai', tone: 'success' },
  escalated: { label: 'Dialihkan ke admin', tone: 'warning' },
  failed: { label: 'Gagal, dialihkan', tone: 'danger' },
};

export function RunHeader({ run }: { run: AgentRun }) {
  const seconds = run.endedAt ? (new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000 : null;
  const s = RUN_STATUS[run.status];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Chip tone={s.tone}>{s.label}</Chip>
      <span className="tabular text-meta text-ink-3">
        {time(run.startedAt)} · {run.steps} langkah{seconds !== null ? ` · ${formatSeconds(seconds)}` : ''}
        {run.inputTokens ? ` · ${number(run.inputTokens + run.outputTokens)} token` : ''}
        {run.costUsd !== null ? ` · $${run.costUsd.toFixed(4)}` : ''}
      </span>
    </div>
  );
}

export function AgentTrace({ entries, running }: { entries: AuditEntry[]; running?: boolean }) {
  const steps = buildSteps(entries);
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (running) end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [steps.length, running]);

  return (
    <ol className="relative flex flex-col">
      <AnimatePresence initial={false}>
        {steps.map((s, i) => (
          <motion.li key={s.key} variants={itemIn} initial="hidden" animate="show" className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && <span className="absolute top-8 bottom-0 left-[13px] w-0.5 bg-border" aria-hidden="true" />}
            <StepDot step={s} pulsing={Boolean(running) && i === steps.length - 1} />
            <StepBody step={s} />
          </motion.li>
        ))}
      </AnimatePresence>
      {running && (
        <li ref={end} className="flex items-center gap-3 pt-2 text-small text-ink-2">
          <span className="grid size-7 place-items-center">
            <motion.span className="size-2.5 rounded-full bg-info-fg" animate={{ opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} />
          </span>
          Sedang bekerja…
        </li>
      )}
    </ol>
  );
}

const DOT: Record<Tone, string> = {
  success: 'bg-primary-soft text-primary',
  warning: 'bg-warning-bg text-warning-fg',
  danger: 'bg-danger-bg text-danger-fg',
  info: 'bg-info-bg text-info-fg',
  neutral: 'bg-surface-muted text-ink-2',
};

function StepDot({ step, pulsing }: { step: Step; pulsing: boolean }) {
  return (
    <motion.span
      className={`relative z-10 grid size-7 shrink-0 place-items-center rounded-full ${DOT[step.tone]}`}
      animate={pulsing ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
      transition={pulsing ? { repeat: Infinity, duration: 1.2 } : undefined}
    >
      <Icon icon={step.icon} size={16} weight="semibold" />
    </motion.span>
  );
}

function StepBody({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const hasDetail = step.input !== undefined || (step.output !== undefined && step.output !== null);
  const isText = step.kind === 'message_in' || step.kind === 'message_out' || step.kind === 'thought';
  return (
    <div className="min-w-0 flex-1 pt-0.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-label font-semibold text-ink">
          {step.title}
          {step.refused && <span className="ml-2 text-small font-medium text-warning-fg">ditolak aturan</span>}
        </p>
        <span className="tabular text-meta text-ink-3">
          {time(step.ts)}
          {step.durationMs ? ` · ${step.durationMs < 1000 ? `${step.durationMs} md` : formatSeconds(step.durationMs / 1000)}` : ''}
        </span>
      </div>
      <p className={`mt-0.5 text-small break-words ${isText ? 'whitespace-pre-line text-ink' : 'text-ink-2'} ${step.kind === 'thought' ? 'italic' : ''}`}>{step.summary}</p>
      {hasDetail && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="mt-1 inline-flex h-8 cursor-pointer items-center gap-1 rounded-pill text-small font-medium text-primary hover:underline"
          >
            Detail
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.15, ease }} className="grid">
              <Icon icon={ChevronDown} size={16} weight="semibold" />
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease }} className="overflow-hidden">
                {step.input !== undefined && <JsonBlock label="Masukan" value={step.input} />}
                {step.output !== undefined && step.output !== null && <JsonBlock label="Hasil" value={step.output} />}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-2">
      <p className="mb-1 text-meta font-semibold text-ink-3 uppercase">{label}</p>
      <pre className="scrollbar-thin max-h-72 overflow-auto rounded-inner bg-surface-muted p-3 font-mono text-[14px] leading-5 text-ink">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
