import { ArrowRight, PackageX, SearchCheck, Wallet, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { rupiah } from '../../lib/format.ts';
import type { AuditEntry, Order } from '../../lib/types.ts';
import { Chip, StatusChip, type Tone } from '../ui/chip.tsx';
import { Icon } from '../ui/icon.tsx';

type Issue =
  | { type: 'out_of_stock'; name: string; requested: string; available: string; substitutes: { name: string; available: string; unitPrice: number | null; unit: string }[] }
  | { type: 'over_credit'; availableCredit: number; shortfall: number }
  | { type: 'low_confidence'; name: string; rawText: string | null };

export type OrderCardData =
  | { kind: 'single'; order: Order; issues: Issue[]; note: string | null }
  | { kind: 'split'; now: Order; held: Order };

const ORDER_TOOLS = new Set(['draft_order', 'confirm_order', 'split_order', 'request_approval', 'cancel_order']);

const isOrder = (v: unknown): v is Order => typeof v === 'object' && v !== null && 'orderId' in v && Array.isArray((v as Order).lines);

/** The order state the agent left behind in a run: the last successful order tool result. */
export function orderCardFor(steps: AuditEntry[]): OrderCardData | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.type !== 'tool_result' || !s.tool || !ORDER_TOOLS.has(s.tool)) continue;
    const d = s.data as Record<string, unknown> | null;
    if (!d) continue;
    switch (s.tool) {
      case 'draft_order':
        if (isOrder(d.order)) return { kind: 'single', order: d.order, issues: Array.isArray(d.issues) ? (d.issues as Issue[]) : [], note: null };
        break;
      case 'confirm_order':
        if (!isOrder(d.order)) break;
        if (d.outcome === 'blocked_over_credit')
          return { kind: 'single', order: d.order, issues: [{ type: 'over_credit', availableCredit: Number(d.availableCredit), shortfall: Number(d.shortfall) }], note: null };
        return { kind: 'single', order: d.order, issues: [], note: d.outcome === 'awaiting_approval' && typeof d.reason === 'string' ? d.reason : null };
      case 'split_order': {
        const part = d.confirmedPart as { order?: unknown } | undefined;
        if (part && isOrder(part.order) && isOrder(d.heldOrder)) return { kind: 'split', now: part.order, held: d.heldOrder };
        break;
      }
      case 'request_approval':
        if (isOrder(d.order)) return { kind: 'single', order: d.order, issues: [], note: null };
        break;
      case 'cancel_order':
        if (isOrder(d)) return { kind: 'single', order: d, issues: [], note: null };
        break;
    }
  }
  return null;
}

export function OrderCard({ data }: { data: OrderCardData }) {
  if (data.kind === 'split') {
    return (
      <div className="mt-3 flex flex-col gap-3">
        <OrderBlock order={data.now} heading="Diproses sekarang" />
        <OrderBlock order={data.held} heading="Menunggu persetujuan pemilik" />
      </div>
    );
  }
  return (
    <div className="mt-3">
      <OrderBlock order={data.order} issues={data.issues} note={data.note} />
    </div>
  );
}

function OrderBlock({ order, heading, issues = [], note }: { order: Order; heading?: string; issues?: Issue[]; note?: string | null }) {
  return (
    <section aria-label={`Pesanan nomor ${order.orderId}`} className="rounded-inner bg-surface p-4 text-ink">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {heading && <p className="text-small font-medium text-ink-2">{heading}</p>}
          <p className="tabular text-label font-semibold">Pesanan #{order.orderId}</p>
        </div>
        <StatusChip status={order.status} />
      </header>
      <ul className="mt-3 flex flex-col gap-2">
        {order.lines.map((l) => (
          <li key={`${l.productId}-${l.unit}`} className="flex items-start justify-between gap-3 text-body">
            <span className="min-w-0">
              <span className="tabular font-semibold">
                {l.qty} {l.unit}
              </span>{' '}
              {l.name}
              {l.substitutedFromProductId !== null && <span className="ml-1 text-small text-info-fg">(pengganti)</span>}
            </span>
            <span className="tabular shrink-0 text-ink-2">{rupiah(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3">
        <span className="text-label text-ink-2">Total</span>
        <span className="tabular text-h3 font-semibold">{rupiah(order.subtotal)}</span>
      </div>
      {issues.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {issues.map((issue, i) => (
            <IssueRow key={i} issue={issue} />
          ))}
        </ul>
      )}
      {note && <p className="mt-3 rounded-inner bg-warning-bg px-3 py-2 text-small text-warning-fg">{note}</p>}
      <Link to={`/pesanan?id=${order.orderId}`} className="mt-3 inline-flex h-8 items-center gap-1 rounded-pill text-small font-medium text-primary hover:underline">
        Lihat pesanan <Icon icon={ArrowRight} size={16} weight="semibold" />
      </Link>
    </section>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  let chip: { tone: Tone; icon: LucideIcon; label: string };
  let detail: string;
  switch (issue.type) {
    case 'out_of_stock': {
      chip = { tone: 'danger', icon: PackageX, label: 'Stok habis' };
      const sub = issue.substitutes[0];
      detail = `${issue.name}: diminta ${issue.requested}, tersedia ${issue.available}.${sub ? ` Pengganti: ${sub.name}${sub.unitPrice !== null ? ` (${rupiah(sub.unitPrice)}/${sub.unit})` : ''}.` : ''}`;
      break;
    }
    case 'over_credit':
      chip = { tone: 'danger', icon: Wallet, label: 'Lewat limit kredit' };
      detail = `Kurang ${rupiah(issue.shortfall)}; sisa limit ${rupiah(issue.availableCredit)}.`;
      break;
    case 'low_confidence':
      chip = { tone: 'info', icon: SearchCheck, label: 'Perlu dicek' };
      detail = `${issue.name}${issue.rawText ? ` (ditulis "${issue.rawText}")` : ''}.`;
      break;
    default:
      return null;
  }
  return (
    <li className="flex flex-col items-start gap-1">
      <Chip tone={chip.tone} icon={chip.icon}>
        {chip.label}
      </Chip>
      <p className="text-small text-ink-2">{detail}</p>
    </li>
  );
}
