import { LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Logo } from '../components/brand/logo.tsx';
import { Button } from '../components/ui/button.tsx';
import { ErrorCallout } from '../components/ui/feedback.tsx';
import { Field } from '../components/ui/field.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { SessionUser } from '../lib/types.ts';

const FACTS = [
  { title: 'Pesanan dari WhatsApp', text: 'Teks, pesan suara, dan foto daftar belanja diubah agen menjadi pesanan yang sudah dicek stok dan kreditnya.' },
  { title: 'Keputusan tetap di tangan pemilik', text: 'Pesanan besar, kredit lewat limit, pembayaran, dan koreksi tagihan menunggu persetujuan Anda.' },
  { title: 'Setiap langkah tercatat', text: 'Jejak agen menunjukkan alat yang dipakai, hasilnya, dan alasan setiap keputusan.' },
];

export function LoginPage({ onLoggedIn, serverError }: { onLoggedIn: (user: SessionUser) => void; serverError?: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Masuk · SALURA';
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.post<{ user: SessionUser }>('/api/auth/login', { username: username.trim(), password });
      onLoggedIn(res.user);
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 401 || err.status === 429) ? err.message : `Belum bisa masuk: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface p-3 sm:p-6">
      <div className="grid w-full max-w-[960px] gap-3 lg:grid-cols-2">
        <section className="relative hidden flex-col justify-between overflow-hidden rounded-card p-8 text-white lg:flex" style={{ background: 'var(--gradient-feature)' }} aria-label="Tentang SALURA">
          <div>
            <p className="text-label font-semibold text-primary-on-strong">CV Sumber Rejeki · Bekasi</p>
            <h2 className="mt-3 text-h1 font-semibold text-balance">Agen order-to-cash untuk distributor FMCG</h2>
          </div>
          <ul className="mt-10 flex flex-col gap-5">
            {FACTS.map((f) => (
              <li key={f.title}>
                <p className="text-h3 font-semibold">{f.title}</p>
                <p className="mt-1 text-body text-primary-on-strong">{f.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col justify-center rounded-card bg-canvas p-6 sm:p-10">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="text-h2 font-semibold text-ink">SALURA</span>
          </div>
          <h1 className="mt-8 text-h1 font-semibold text-ink">Masuk ke konsol</h1>
          <p className="mt-1 text-body text-ink-2">Pakai akun yang diberikan distributor. Akun demo untuk juri tercantum di dokumen proposal.</p>

          {serverError && (
            <div className="mt-6">
              <ErrorCallout message={`Server belum bisa dihubungi: ${serverError}`} onRetry={() => window.location.reload()} />
            </div>
          )}

          <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
            <Field label="Nama pengguna" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required className="[&_input]:bg-surface" />
            <Field
              label="Kata sandi"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error}
              required
              className="[&_input]:bg-surface"
            />
            <Button type="submit" icon={LogIn} loading={busy} disabled={!username.trim() || !password} className="mt-2 w-full">
              Masuk
            </Button>
          </form>
          <p className="mt-6 text-small text-ink-3">Akun admin bisa menyetujui pesanan dan mengubah data. Akun tamu bisa mencoba chat sebagai warung dan melihat semua layar.</p>
        </section>
      </div>
    </main>
  );
}
