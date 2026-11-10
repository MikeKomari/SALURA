import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mic, Send } from 'lucide-react';
import { useId, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { time } from '../../lib/format.ts';
import type { Approval, Message } from '../../lib/types.ts';
import { useAdmin } from '../admin-gate.tsx';
import { Button } from '../ui/button.tsx';
import { ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { useToast } from '../ui/toast.tsx';
import { customerName, errorText } from './copy.ts';
import { OrderLinesTable } from './order-details.tsx';

const RECENT = 4;

/** The last few messages for context, the related draft (if any), and a direct reply box. */
export function EscalationDetails({ approval, waId, pending }: { approval: Approval; waId: string | null; pending: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {waId && <RecentMessages waId={waId} name={customerName(approval)} />}
      {approval.order && (
        <section>
          <h3 className="mb-2 text-h3 font-semibold text-ink">Draf pesanan terkait #{approval.order.orderId}</h3>
          <OrderLinesTable order={approval.order} />
        </section>
      )}
      {pending && waId && <ReplyBox waId={waId} name={customerName(approval)} />}
    </div>
  );
}

function RecentMessages({ waId, name }: { waId: string; name: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['messages', waId, 'approval-preview'],
    queryFn: () => api.get<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(waId)}/messages`),
  });
  const recent = data?.messages.slice(-RECENT) ?? [];

  return (
    <section aria-labelledby={`recent-${waId}`}>
      <h3 id={`recent-${waId}`} className="text-h3 font-semibold text-ink">
        Pesan terakhir
      </h3>
      <div className="mt-3 rounded-inner bg-canvas p-4">
        {error ? (
          <ErrorCallout message={errorText(error)} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-14 w-2/3" />
            <Skeleton className="ml-auto h-14 w-2/3" />
          </div>
        ) : recent.length ? (
          <ol className="flex flex-col gap-3">
            {recent.map((m) => (
              <li key={m.id} className={`flex ${m.direction === 'in' ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[85%] rounded-inner px-4 py-2.5 ${m.direction === 'in' ? 'rounded-bl-[4px] bg-primary-soft' : 'rounded-br-[4px] bg-surface-muted'}`}
                >
                  <p className="text-small font-semibold text-ink">
                    {m.direction === 'in' ? name : 'SALURA'} <span className="tabular font-normal text-ink-3">{time(m.createdAt)}</span>
                  </p>
                  {m.kind === 'voice' && (
                    <p className="mt-0.5 flex items-center gap-1 text-small text-ink-2">
                      <Icon icon={Mic} size={16} /> Pesan suara
                    </p>
                  )}
                  <p className={`mt-0.5 text-body break-words whitespace-pre-line text-ink ${m.kind === 'voice' && m.transcript ? 'text-ink-2 italic' : ''}`}>
                    {m.text ?? m.transcript ?? (m.kind === 'image' ? 'Foto' : '')}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-body text-ink-2">Belum ada pesan di percakapan ini.</p>
        )}
      </div>
    </section>
  );
}

function ReplyBox({ waId, name }: { waId: string; name: string }) {
  const id = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin, signOut } = useAdmin();
  const [text, setText] = useState('');

  const send = useMutation({
    mutationFn: (body: string) => api.post(`/api/conversations/${encodeURIComponent(waId)}/admin-reply`, { text: body }),
    onSuccess: () => {
      setText('');
      toast({ tone: 'success', text: `Balasan terkirim ke ${name}.` });
      qc.invalidateQueries({ queryKey: ['messages', waId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) signOut();
      toast({
        tone: 'error',
        text: err instanceof ApiError && err.status === 404 ? 'Balas langsung belum tersedia di server ini. Buka percakapan untuk menindaklanjuti.' : errorText(err),
      });
    },
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || !(await requireAdmin())) return;
    send.mutate(body);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor={id} className="text-h3 font-semibold text-ink">
        Balas {name}
      </label>
      <p id={`${id}-hint`} className="text-small text-ink-3">
        Dikirim atas nama admin, bukan agen. Tekan Ctrl+Enter untuk mengirim.
      </p>
      <textarea
        id={id}
        rows={3}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
        }}
        aria-describedby={`${id}-hint`}
        placeholder="Tulis balasan untuk pelanggan"
        className="min-h-24 resize-y rounded-input border border-transparent bg-surface-muted px-4 py-3 text-body text-ink placeholder:text-ink-3"
      />
      <div className="flex justify-end">
        <Button type="submit" variant="outline" icon={Send} loading={send.isPending} disabled={!text.trim()}>
          Kirim balasan
        </Button>
      </div>
    </form>
  );
}
