import { Compass, House, LogIn, RotateCcw, TriangleAlert, Unplug } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router';
import { Logo } from '../components/brand/logo.tsx';
import { Page } from '../components/layout/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { ApiError, SIGNED_OUT_EVENT } from '../lib/api.ts';

/**
 * Every failure the console can hit ends up here: a thrown render error, a route that does not
 * exist, a lazy page chunk that will not load, a dead API. One screen, one recovery action,
 * so a demo never shows a blank white page.
 */

type Kind = 'notFound' | 'signedOut' | 'stale' | 'offline' | 'server' | 'unknown';

interface Shape {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Label of the main recovery button. */
  action: string;
}

const SHAPES: Record<Kind, Shape> = {
  notFound: {
    icon: Compass,
    title: 'Halaman tidak ditemukan',
    body: 'Alamat ini tidak ada di konsol SALURA. Mungkin tautannya sudah berubah.',
    action: 'Kembali ke ringkasan',
  },
  signedOut: {
    icon: LogIn,
    title: 'Sesi Anda sudah berakhir',
    body: 'Masuk sekali lagi untuk melanjutkan. Data yang sudah tersimpan tidak hilang.',
    action: 'Masuk kembali',
  },
  stale: {
    icon: RotateCcw,
    title: 'Versi aplikasi sudah diperbarui',
    body: 'Konsol baru saja dideploy ulang, jadi halaman ini perlu dimuat ulang sebelum bisa dibuka.',
    action: 'Muat ulang halaman',
  },
  offline: {
    icon: Unplug,
    title: 'Tidak bisa terhubung ke server',
    body: 'Periksa koneksi internet Anda, lalu coba lagi. Server mungkin juga sedang dimulai ulang.',
    action: 'Coba lagi',
  },
  server: {
    icon: TriangleAlert,
    title: 'Server sedang bermasalah',
    body: 'Permintaan Anda tidak bisa diselesaikan. Coba lagi sebentar; kalau masih gagal, laporkan kode di bawah.',
    action: 'Coba lagi',
  },
  unknown: {
    icon: TriangleAlert,
    title: 'Terjadi kesalahan',
    body: 'Ada bagian konsol yang gagal dimuat. Kembali ke ringkasan atau coba lagi.',
    action: 'Coba lagi',
  },
};

/** A failed `import()` means the chunk is gone — almost always a redeploy under an open tab. */
function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /dynamically imported module|importing a module script failed|chunkloaderror|failed to fetch dynamically/i.test(message);
}

function classify(error: unknown): { kind: Kind; detail: string } {
  if (isRouteErrorResponse(error)) {
    const detail = `HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''}`;
    if (error.status === 404) return { kind: 'notFound', detail };
    if (error.status === 401 || error.status === 403) return { kind: 'signedOut', detail };
    return { kind: 'server', detail };
  }
  if (error instanceof ApiError) {
    const detail = `${error.code} · HTTP ${error.status}`;
    if (error.status === 0) return { kind: 'offline', detail };
    if (error.status === 401 || error.status === 403) return { kind: 'signedOut', detail };
    if (error.status === 404) return { kind: 'notFound', detail };
    return { kind: 'server', detail };
  }
  if (isStaleChunk(error)) return { kind: 'stale', detail: 'Gagal memuat modul halaman' };
  if (error instanceof Error) return { kind: 'unknown', detail: `${error.name}: ${error.message}` };
  return { kind: 'unknown', detail: String(error ?? 'Kesalahan tanpa keterangan') };
}

function ErrorBody({ error, reset }: { error: unknown; reset?: () => void }) {
  const navigate = useNavigate();
  const { kind, detail } = classify(error);
  const shape = SHAPES[kind];

  const recover = () => {
    if (kind === 'stale') return window.location.reload();
    // Hand the session back to AuthProvider, which swaps in the login screen.
    if (kind === 'signedOut') return window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    if (kind === 'notFound') return navigate('/');
    if (reset) return reset();
    window.location.reload();
  };

  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-12 text-center">
      <span className={`grid size-14 place-items-center rounded-full ${kind === 'notFound' ? 'bg-primary-soft text-primary' : 'bg-danger-bg text-danger-fg'}`}>
        <Icon icon={shape.icon} size={24} weight="semibold" />
      </span>
      <h2 className="text-h2 font-semibold text-ink">{shape.title}</h2>
      <p className="text-body text-ink-2">{shape.body}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <Button icon={kind === 'notFound' ? House : RotateCcw} onClick={recover}>
          {shape.action}
        </Button>
        {kind !== 'notFound' && (
          <Button variant="ghost" icon={House} onClick={() => navigate('/')}>
            Kembali ke ringkasan
          </Button>
        )}
      </div>
      {/* Kept visible but folded away: the judges never need it, a developer always does. */}
      <details className="mt-4 w-full text-left">
        <summary className="cursor-pointer text-small text-ink-3">Detail teknis</summary>
        <p className="mt-2 rounded-inner bg-surface-muted px-4 py-3 font-mono text-meta break-words text-ink-2">{detail}</p>
      </details>
    </div>
  );
}

/**
 * Route-level handler: mounted inside the app shell, so the sidebar and top bar stay usable.
 * No page header — the card states the problem, and a missing page is not a "Kesalahan".
 */
export function ErrorPage() {
  const error = useRouteError();
  return (
    <Page>
      <div className="rounded-card bg-surface">
        <ErrorBody error={error} />
      </div>
    </Page>
  );
}

/** Used when the shell itself failed, so it must not depend on any of the shell's chrome. */
export function ErrorScreen({ error, reset }: { error: unknown; reset?: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas p-6">
      <div className="w-full max-w-xl">
        <div className="mb-4 flex items-center gap-3 px-2">
          <Logo />
          <span className="text-h2 font-bold tracking-tight text-ink">SALURA</span>
        </div>
        <div className="rounded-card bg-surface">
          <ErrorBody error={error} reset={reset} />
        </div>
      </div>
    </main>
  );
}

/** Router-level fallback: a crash in `<Root />` takes the shell with it. */
export function RootErrorScreen() {
  return <ErrorScreen error={useRouteError()} />;
}

/**
 * Catches what the router cannot: a throw inside the providers that sit above `<RouterProvider />`.
 * Without this the whole console renders as a blank page.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('SALURA gagal dimuat', error, info.componentStack);
  }

  render() {
    if (this.state.error) return <ErrorScreen error={this.state.error} reset={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
