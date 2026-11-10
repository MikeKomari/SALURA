import { ArrowLeft, Ban, Check, CircleCheck, CircleX, MessagesSquare, PencilLine, Send, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { date, relative, time } from '../../lib/format.ts';
import type { Approval } from '../../lib/types.ts';
import { Button } from '../ui/button.tsx';
import { Chip } from '../ui/chip.tsx';
import { Avatar, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { AgentTrail } from './agent-trail.tsx';
import { approvalWaId, customerName, reasonText, TYPE_META } from './copy.ts';
import { EditOrderDialog, RejectDialog } from './dialogs.tsx';
import { EscalationDetails } from './escalation-details.tsx';
import { CreditFacts, OrderLinesTable } from './order-details.tsx';
import { ReminderDetails } from './reminder-details.tsx';
import { ReorderDetails } from './reorder-details.tsx';
import { DeliveryQueryDetails, InvoiceAdjustmentDetails } from './delivery-details.tsx';
import { PaymentDetails } from './payment-details.tsx';
import { useDecision } from './use-decision.ts';

interface ApprovalDetailProps {
  approval: Approval;
  now: number;
  /** Shown below 1024px, where list and detail are one column. */
  onBack: () => void;
}

export function ApprovalDetail({ approval: a, now, onBack }: ApprovalDetailProps) {
  const meta = TYPE_META[a.type];
  const name = customerName(a);
  const waId = approvalWaId(a);
  const pending = a.status === 'pending';
  const reason = reasonText(a);
  const isOrder = a.type === 'order' || a.type === 'credit_override';

  return (
    <article aria-labelledby={`approval-${a.id}-title`} className="flex flex-col gap-6">
      <button
        type="button"
        onClick={onBack}
        className="-mt-2 -ml-2 inline-flex h-10 w-fit cursor-pointer items-center gap-2 rounded-pill px-2 text-label font-medium text-primary hover:bg-primary-soft lg:hidden"
      >
        <Icon icon={ArrowLeft} size={20} weight="semibold" />
        Kembali ke daftar
      </button>

      <header className="flex flex-wrap items-start gap-4">
        <Avatar name={name} size={48} />
        <div className="min-w-[200px] flex-1">
          <h2 id={`approval-${a.id}-title`} className="text-h2 font-semibold text-ink">
            {name}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Chip tone={meta.tone} icon={meta.icon}>
              {meta.label}
            </Chip>
            {a.guest && <Chip tone="info">Chat uji tamu</Chip>}
            {a.orderId && <Chip>Pesanan #{a.orderId}</Chip>}
            {!a.customer && waId && <Chip>+{waId}</Chip>}
          </div>
          <p className="tabular mt-2 text-small text-ink-3">
            Ditahan agen {relative(a.requestedAt, now)} · {date(a.requestedAt)}, {time(a.requestedAt)}
          </p>
        </div>
        {waId && (
          <Link
            to={`/percakapan/${waId}`}
            className="inline-flex h-10 items-center gap-2 rounded-pill border border-border px-4 text-label font-medium text-ink hover:bg-surface-muted"
          >
            <Icon icon={MessagesSquare} size={20} />
            Lihat percakapan
          </Link>
        )}
      </header>

      <div className="flex gap-3 rounded-inner bg-warning-bg p-4 text-warning-fg" role="note">
        <Icon icon={ShieldAlert} size={24} weight="semibold" className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-label font-semibold">Mengapa agen menahan ini</p>
          <p className="mt-1 text-body text-ink">{reason.text}</p>
          {reason.detail && <p className="mt-1 text-small break-words text-warning-fg">Catatan agen: {reason.detail}</p>}
        </div>
      </div>

      {!pending && <DecisionNote approval={a} />}

      {isOrder && a.order && (
        <section aria-labelledby={`lines-${a.id}`}>
          <h3 id={`lines-${a.id}`} className="mb-2 text-h3 font-semibold text-ink">
            Isi pesanan
          </h3>
          <OrderLinesTable order={a.order} stock={a.stock} />
          {a.order.deliveryNote && <p className="mt-3 text-body text-ink-2">Catatan pengiriman: {a.order.deliveryNote}</p>}
          {a.order.splitFromOrderId && (
            <p className="mt-3 text-body text-ink-2">
              Bagian yang muat di limit sudah diproses sebagai{' '}
              <Link to={`/pesanan?id=${a.order.splitFromOrderId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                pesanan #{a.order.splitFromOrderId}
              </Link>
              .
            </p>
          )}
        </section>
      )}

      {isOrder && a.credit && (
        <section aria-labelledby={`credit-${a.id}`}>
          <h3 id={`credit-${a.id}`} className="mb-3 text-h3 font-semibold text-ink">
            Posisi kredit pelanggan
          </h3>
          <CreditFacts credit={a.credit} orderTotal={pending ? (a.order?.subtotal ?? null) : null} />
        </section>
      )}

      {a.type === 'reminder' && <ReminderDetails approval={a} pending={pending} />}
      {a.type === 'reorder' && <ReorderDetails approval={a} pending={pending} />}
      {a.type === 'delivery_query' && <DeliveryQueryDetails approval={a} pending={pending} />}
      {a.type === 'invoice_adjustment' && <InvoiceAdjustmentDetails approval={a} />}
      {a.type === 'payment' && <PaymentDetails approval={a} />}
      {a.type === 'escalation' && <EscalationDetails approval={a} waId={waId} pending={pending} />}

      {pending && <Actions approval={a} />}

      {a.runId && <AgentTrail runId={a.runId} />}
    </article>
  );
}

function DecisionNote({ approval: a }: { approval: Approval }) {
  const approved = a.status === 'approved';
  const word = a.type === 'escalation' ? (approved ? 'Ditandai selesai' : 'Diabaikan') : approved ? 'Disetujui' : 'Ditolak';
  return (
    <div className={`flex gap-3 rounded-inner p-4 ${approved ? 'bg-primary-soft text-primary' : 'bg-danger-bg text-danger-fg'}`}>
      <Icon icon={approved ? CircleCheck : CircleX} size={24} weight="semibold" className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-label font-semibold">
          {word} oleh {a.decidedBy ?? 'admin'}
        </p>
        {a.decidedAt && (
          <p className="tabular mt-0.5 text-small text-ink-2">
            {date(a.decidedAt)}, {time(a.decidedAt)}
          </p>
        )}
        {a.decisionNote && <p className="mt-1 text-body text-ink">Catatan: {a.decisionNote}</p>}
      </div>
    </div>
  );
}

function Actions({ approval: a }: { approval: Approval }) {
  const { decide, busy } = useDecision();
  const [dialog, setDialog] = useState<'edit' | 'reject' | null>(null);
  const mine = busy?.id === a.id ? busy.kind : null;
  const locked = mine !== null;
  const isOrder = a.type === 'order' || a.type === 'credit_override';
  const canEdit = isOrder && (a.order?.lines.length ?? 0) > 0;

  const approve = () => void decide(a, { action: 'approve' });
  const close = () => setDialog(null);

  const primary =
    a.type === 'reminder'
      ? { label: 'Kirim pengingat', icon: Send }
      : a.type === 'reorder'
        ? { label: 'Kirim tawaran', icon: Send }
        : a.type === 'delivery_query'
          ? { label: `Kirim ke ${String(a.payload?.staffName ?? 'staf').split(' (')[0]}`, icon: Send }
          : a.type === 'invoice_adjustment'
            ? { label: 'Koreksi tagihan', icon: Check }
            : a.type === 'payment'
              ? { label: 'Dana sudah masuk, catat lunas', icon: Check }
      : a.type === 'escalation'
        ? { label: 'Tandai selesai', icon: CircleCheck }
        : { label: 'Setujui pesanan', icon: Check };
  const reject = a.type === 'reminder' || a.type === 'reorder' || a.type === 'delivery_query' ? 'Jangan kirim' : a.type === 'escalation' ? 'Abaikan' : 'Tolak';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <Button icon={primary.icon} loading={mine === 'approve'} disabled={locked} onClick={approve}>
          {primary.label}
        </Button>
        {canEdit && (
          <Button variant="outline" icon={PencilLine} loading={mine === 'edit'} disabled={locked} onClick={() => setDialog('edit')}>
            Ubah lalu setujui
          </Button>
        )}
        <Button variant={a.type === 'escalation' ? 'ghost' : 'danger'} icon={Ban} loading={mine === 'reject'} disabled={locked} onClick={() => setDialog('reject')}>
          {reject}
        </Button>
      </div>
      {isOrder && a.stock?.some((s) => !s.enough) && (
        <p role="status" className="rounded-inner bg-danger-bg px-3 py-2 text-small text-danger-fg">
          Stok sebagian barang sudah tidak cukup sejak pesanan ini ditahan. Pakai “Ubah lalu setujui” untuk menyesuaikan jumlah, atau tolak.
        </p>
      )}
      {isOrder && <p className="text-small text-ink-3">Setelah Anda memutuskan, agen langsung mengabari pelanggan lewat WhatsApp.</p>}
      {a.type === 'escalation' && <p className="text-small text-ink-3">"Tandai selesai" bila Anda sudah membalas atau menelepon pelanggan.</p>}
      {a.type === 'payment' && <p className="text-small text-ink-3">Setujui hanya setelah dana terlihat di mutasi rekening. Agen tidak pernah menandai lunas sendiri.</p>}

      {canEdit && (
        <EditOrderDialog
          open={dialog === 'edit'}
          approval={a}
          busy={mine === 'edit'}
          onClose={close}
          onSubmit={async (editedLines) => {
            if (await decide(a, { action: 'approve', editedLines }, 'edit')) close();
          }}
        />
      )}
      <RejectDialog
        open={dialog === 'reject'}
        approval={a}
        busy={mine === 'reject'}
        onClose={close}
        onSubmit={async (note) => {
          if (await decide(a, { action: 'reject', note })) close();
        }}
      />
    </div>
  );
}

export function ApprovalDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex gap-4">
        <Skeleton className="size-12 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-[26px] w-1/3" />
        </div>
      </div>
      <Skeleton className="h-24" />
      <Skeleton className="h-48" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    </div>
  );
}
