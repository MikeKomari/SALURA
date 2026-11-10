import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useAdmin } from '../components/admin-gate.tsx';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { ErrorCallout, Skeleton } from '../components/ui/feedback.tsx';
import { Field, Segmented } from '../components/ui/field.tsx';
import { useToast } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { number, rupiah } from '../lib/format.ts';
import { ease } from '../lib/motion.ts';
import type { AutonomyPolicy } from '../lib/types.ts';

type Mode = AutonomyPolicy['mode'];
type Action = AutonomyPolicy['action'];

const MODES: { value: Mode; label: string }[] = [
  { value: 'suggest', label: 'Sarankan saja' },
  { value: 'auto', label: 'Otomatis' },
  { value: 'approve', label: 'Perlu persetujuan' },
];

const ACTIONS: Record<Action, { title: string; what: string; modes: Record<Mode, string> }> = {
  confirm_order: {
    title: 'Konfirmasi pesanan',
    what: 'Setelah pelanggan membalas “ya” pada ringkasan pesanan.',
    modes: {
      suggest: 'Agen menyiapkan pesanan, tetapi tidak mengonfirmasi sendiri. Semua pesanan masuk ke Persetujuan.',
      auto: 'Agen langsung mengonfirmasi pesanan sampai batas otomatis. Pesanan di atas batas itu menunggu persetujuan Anda.',
      approve: 'Setiap pesanan menunggu Anda setujui di halaman Persetujuan sebelum dikonfirmasi.',
    },
  },
  over_credit_order: {
    title: 'Pesanan melewati limit atau ada tagihan terlambat',
    what: 'Pesanan yang melebihi sisa limit kredit, atau dari warung dengan tagihan terlambat lebih dari 14 hari.',
    modes: {
      suggest: 'Agen menahan pesanan dan menyarankan pemecahan. Anda yang memutuskan di Persetujuan.',
      auto: 'Agen memproses tanpa menahan. Berisiko: piutang bisa bertambah tanpa sepengetahuan Anda.',
      approve: 'Bagian yang masih dalam limit diproses; sisanya ditahan sampai Anda setujui.',
    },
  },
  send_reminder: {
    title: 'Kirim pengingat pembayaran',
    what: 'Pengingat tagihan terlambat dari agen penagihan, memakai template yang sudah disetujui.',
    modes: {
      suggest: 'Agen menyiapkan teks pengingat dan nadanya. Anda yang memutuskan di Persetujuan.',
      auto: 'Agen langsung mengirim pengingat ke WhatsApp atau chat pelanggan.',
      approve: 'Pengingat dikirim setelah Anda setujui di halaman Persetujuan.',
    },
  },
  send_reorder_nudge: {
    title: 'Tawarkan pesan ulang',
    what: 'Setiap pagi agen mencari warung yang sudah lewat jadwal belanja biasanya, lalu menawarkan pesanan biasanya.',
    modes: {
      suggest: 'Agen menyiapkan tawaran dan pesanannya. Anda yang memutuskan di Persetujuan.',
      auto: 'Agen langsung mengirim tawaran. Pesanan tetap baru diproses setelah pelanggan membalas YA.',
      approve: 'Tawaran dikirim setelah Anda setujui di halaman Persetujuan.',
    },
  },
};

const ORDER: Action[] = ['confirm_order', 'over_credit_order', 'send_reminder', 'send_reorder_nudge'];

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin } = useAdmin();
  const [resetOpen, setResetOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['autonomy'],
    queryFn: () => api.get<{ policies: AutonomyPolicy[] }>('/api/settings/autonomy'),
  });

  const save = useMutation({
    mutationFn: (p: AutonomyPolicy) =>
      api.put<{ policies: AutonomyPolicy[] }>(`/api/settings/autonomy/${p.action}`, {
        mode: p.mode,
        ...(p.action === 'confirm_order' ? { maxAutoAmount: p.maxAutoAmount } : {}),
      }),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: ['autonomy'] });
      const previous = qc.getQueryData<{ policies: AutonomyPolicy[] }>(['autonomy']);
      qc.setQueryData<{ policies: AutonomyPolicy[] }>(
        ['autonomy'],
        (d) =>
          d && {
            policies: d.policies.map((x) => (x.action === p.action ? p : x)),
          },
      );
      return { previous };
    },
    onError: (err, _p, ctx) => {
      if (ctx?.previous) qc.setQueryData(['autonomy'], ctx.previous);
      toast({
        tone: 'error',
        text: `Pengaturan tidak tersimpan: ${(err as Error).message}`,
      });
    },
    onSuccess: (res, p) => {
      qc.setQueryData(['autonomy'], res);
      toast({
        tone: 'success',
        text: `“${ACTIONS[p.action].title}” disimpan.`,
      });
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/admin/reset'),
    onSuccess: () => {
      setResetOpen(false);
      qc.invalidateQueries();
      toast({ tone: 'success', text: 'Data demo sudah dikembalikan ke awal.' });
    },
    onError: (err) => toast({ tone: 'error', text: `Reset gagal: ${(err as Error).message}` }),
  });

  const change = async (p: AutonomyPolicy) => {
    if (!(await requireAdmin())) return;
    save.mutate(p);
  };

  const policies = ORDER.map((a) => data?.policies.find((p) => p.action === a)).filter((p): p is AutonomyPolicy => Boolean(p));

  return (
    <Page>
      <PageHeader title="Pengaturan" subtitle="Tentukan apa yang boleh dikerjakan agen sendiri dan apa yang harus menunggu keputusan Anda." />

      {error && (
        <div className="mb-4">
          <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card title="Kewenangan agen" className="lg:col-span-8">
          <p className="-mt-2 mb-5 text-body text-ink-2">Perubahan langsung berlaku untuk pesan berikutnya. Mengubah pengaturan butuh akun admin.</p>
          {isLoading ? (
            <div className="flex flex-col gap-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-36" />
              ))}
            </div>
          ) : (
            <ul className="flex flex-col gap-4">
              {policies.map((p) => (
                <PolicyRow key={p.action} policy={p} onChange={(next) => void change(next)} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Data demo" className="lg:col-span-4">
          <p className="text-body text-ink-2">Mengembalikan 8 warung, stok, tagihan, dan pengaturan ke kondisi awal. Semua pesanan, percakapan, dan persetujuan hasil uji coba akan dihapus.</p>
          <div className="pt-6">
            <Button
              variant="danger"
              icon={RotateCcw}
              className="w-full"
              onClick={async () => {
                if (await requireAdmin()) setResetOpen(true);
              }}
            >
              Reset data demo
            </Button>
          </div>
        </Card>
      </div>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset data demo?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Batal
            </Button>
            <Button icon={RotateCcw} loading={reset.isPending} onClick={() => reset.mutate()}>
              Ya, reset data
            </Button>
          </>
        }
      >
        Semua pesanan, chat, persetujuan, dan pengingat dari uji coba akan dihapus, lalu data awal CV Sumber Rejeki dimuat ulang. Ini tidak bisa dibatalkan.
      </Dialog>
    </Page>
  );
}

function PolicyRow({ policy, onChange }: { policy: AutonomyPolicy; onChange: (p: AutonomyPolicy) => void }) {
  const info = ACTIONS[policy.action];
  const hasLimit = policy.action === 'confirm_order';
  const [limit, setLimit] = useState(policy.maxAutoAmount ? String(policy.maxAutoAmount) : '');
  useEffect(() => setLimit(policy.maxAutoAmount ? String(policy.maxAutoAmount) : ''), [policy.maxAutoAmount]);

  const parsed = Number(limit.replace(/\D/g, ''));
  const limitError = limit && (!Number.isInteger(parsed) || parsed <= 0) ? 'Isi angka rupiah lebih dari 0.' : undefined;
  const dirty = (limit ? parsed : null) !== policy.maxAutoAmount;

  return (
    <li className="rounded-inner bg-surface-muted/60 p-4">
      <h3 className="text-h3 font-semibold text-ink">{info.title}</h3>
      <p className="mt-0.5 text-small text-ink-3">{info.what}</p>
      <div className="mt-3">
        <Segmented label={info.title} value={policy.mode} options={MODES} onChange={(mode) => mode !== policy.mode && onChange({ ...policy, mode })} />
      </div>
      <p className="mt-2 text-body text-ink-2">{info.modes[policy.mode]}</p>
      <AnimatePresence initial={false}>
        {hasLimit && policy.mode === 'auto' && (
          <motion.form
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease }}
            className="overflow-hidden"
            onSubmit={(e) => {
              e.preventDefault();
              if (!limitError && dirty) onChange({ ...policy, maxAutoAmount: limit ? parsed : null });
            }}
          >
            <div className="flex flex-wrap items-start gap-3 pt-4">
              <Field
                label="Batas otomatis (Rp)"
                inputMode="numeric"
                value={limit ? number(parsed) : ''}
                onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))}
                error={limitError}
                hint={limit && !limitError ? `Pesanan sampai ${rupiah(parsed)} dikonfirmasi otomatis.` : 'Kosongkan untuk tanpa batas.'}
                className="tabular w-full max-w-xs"
              />
              <Button type="submit" variant="outline" icon={Save} disabled={!dirty || Boolean(limitError)} className="sm:mt-7">
                Simpan batas
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </li>
  );
}
