import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  CircleQuestionMark,
  ClipboardCheck,
  FileSpreadsheet,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Package,
  ReceiptText,
  Search,
  Settings,
  Truck,
  Warehouse,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';
import { useLiveConnected } from '../../lib/live.ts';
import { ease } from '../../lib/motion.ts';
import type { DashboardData } from '../../lib/types.ts';
import { useAuth } from '../admin-gate.tsx';
import { Logo } from '../brand/logo.tsx';
import { Button, IconButton } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: 'approvals';
}

const MENU: NavItem[] = [
  { to: '/', label: 'Ringkasan', icon: LayoutDashboard },
  { to: '/percakapan', label: 'Percakapan', icon: MessagesSquare },
  { to: '/persetujuan', label: 'Persetujuan', icon: ClipboardCheck, badge: 'approvals' },
  { to: '/pesanan', label: 'Pesanan', icon: Package },
  { to: '/gudang', label: 'Gudang', icon: Warehouse },
  { to: '/pengiriman', label: 'Pengiriman', icon: Truck },
  { to: '/penagihan', label: 'Penagihan', icon: ReceiptText },
];
const GENERAL: NavItem[] = [
  { to: '/evaluasi', label: 'Evaluasi', icon: FlaskConical },
  { to: '/pengaturan', label: 'Pengaturan', icon: Settings },
  { to: '/impor', label: 'Impor data', icon: FileSpreadsheet },
  { to: '/bantuan', label: 'Bantuan', icon: CircleQuestionMark },
];

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  useEffect(() => setDrawer(false), [location.pathname]);
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard') });
  const pending = data?.metrics.pendingApprovals ?? 0;

  return (
    <div className="flex min-h-dvh gap-3 bg-surface p-3">
      <aside className="sticky top-3 hidden print:!hidden h-[calc(100dvh-24px)] w-[var(--sidebar-rail)] shrink-0 lg:block xl:w-[var(--sidebar-width)]">
        <Sidebar pending={pending} />
      </aside>

      <AnimatePresence>
        {drawer && (
          <motion.div className="fixed inset-0 z-40 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-ink/30" onClick={() => setDrawer(false)} aria-hidden="true" />
            <motion.aside
              initial={{ x: -24, opacity: 0 }}
              animate={{ x: 0, opacity: 1, transition: { duration: 0.25, ease } }}
              exit={{ x: -16, opacity: 0, transition: { duration: 0.18, ease } }}
              className="relative h-full w-[var(--sidebar-width)] max-w-[85vw] bg-surface p-3"
            >
              <Sidebar pending={pending} expanded onClose={() => setDrawer(false)} />
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Topbar pending={pending} onMenu={() => setDrawer(true)} />
        <main className="min-h-0 flex-1 rounded-frame bg-canvas p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Sidebar({ pending, expanded, onClose }: { pending: number; expanded?: boolean; onClose?: () => void }) {
  // Rail (icons only) between lg and xl unless shown as the mobile drawer.
  const full = expanded ? '' : 'hidden xl:inline';
  // The badge must stay a grid when it reappears at xl: `xl:inline` would override `grid`
  // and its place-items-center, leaving the digits sitting high in the pill.
  const fullGrid = expanded ? '' : 'hidden xl:grid';
  const fullBlock = expanded ? '' : 'hidden xl:block';
  return (
    <nav aria-label="Navigasi utama" className="flex h-full flex-col rounded-card bg-canvas px-3 py-6">
      <div className="mb-8 flex items-center justify-between gap-2 px-3">
        <Link to="/" className="flex items-center gap-3" aria-label="SALURA, ke ringkasan">
          <Logo />
          <span className={`text-h2 font-bold tracking-tight text-ink ${full}`}>SALURA</span>
        </Link>
        {onClose && <IconButton icon={X} label="Tutup menu" onClick={onClose} />}
      </div>
      <NavGroup label="Menu" items={MENU} pending={pending} full={full} fullGrid={fullGrid} fullBlock={fullBlock} />
      <NavGroup label="Umum" items={GENERAL} pending={pending} full={full} fullGrid={fullGrid} fullBlock={fullBlock} className="mt-8" />
      <div className={`mt-auto ${fullBlock}`}>
        <ChannelCard />
      </div>
    </nav>
  );
}

function NavGroup({ label, items, pending, full, fullGrid, fullBlock, className = '' }: { label: string; items: NavItem[]; pending: number; full: string; fullGrid: string; fullBlock: string; className?: string }) {
  return (
    <div className={className}>
      <p className={`mb-2 px-3 text-meta font-semibold tracking-[0.06em] text-ink-3 uppercase ${fullBlock}`}>{label}</p>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === '/'}
              title={item.label}
              className={({ isActive }) =>
                `relative flex h-11 items-center gap-3 rounded-inner px-3 text-label transition-colors duration-150 ${
                  isActive ? 'font-semibold text-ink' : 'text-ink-2 hover:bg-surface hover:text-ink'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && <motion.span layoutId="nav-active" className="absolute top-2 bottom-2 -left-3 w-1 rounded-r-pill bg-primary" transition={{ duration: 0.2, ease }} />}
                  <span className={isActive ? 'text-primary' : ''}>
                    <Icon icon={item.icon} size={24} weight={isActive ? 'semibold' : 'regular'} />
                  </span>
                  <span className={`flex-1 ${full}`}>{item.label}</span>
                  {item.badge === 'approvals' && pending > 0 && (
                    <span className={`tabular grid h-6 min-w-6 place-items-center rounded-pill bg-primary-strong px-1.5 text-meta font-semibold text-white ${fullGrid}`}>{pending}</span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChannelCard() {
  const live = useLiveConnected();
  const { data } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<{ web: { status: string }; whatsapp: { configured: boolean; status: string } }>('/api/channels/status'),
    refetchInterval: 30_000,
  });
  const wa = data?.whatsapp;
  const waConnected = wa?.configured && /connected|ready|open|working|authenticated/i.test(wa.status);
  return (
    <div className="relative overflow-hidden rounded-card p-5 text-white" style={{ background: 'var(--gradient-feature)' }}>
      <p className="text-label font-semibold">Saluran pesan</p>
      <ul className="mt-3 flex flex-col gap-2 text-small text-primary-on-strong">
        <li className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${live ? 'bg-chart-3' : 'bg-warning-bg'}`} />
          Chat web: {live ? 'terhubung' : 'menyambung…'}
        </li>
        <li className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${waConnected ? 'bg-chart-3' : 'bg-white/40'}`} />
          WhatsApp: {!wa ? 'memeriksa…' : !wa.configured ? 'belum diatur' : waConnected ? 'terhubung' : 'terputus'}
        </li>
      </ul>
      <Link to="/percakapan" className="mt-4 flex h-10 items-center justify-center rounded-pill bg-primary-strong text-label font-medium text-white ring-1 ring-white/20 transition-colors hover:bg-white hover:text-primary">
        Buka percakapan
      </Link>
    </div>
  );
}

function Topbar({ pending, onMenu }: { pending: number; onMenu: () => void }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="flex h-[72px] items-center gap-3 rounded-card bg-canvas px-4 print:hidden">
      <IconButton icon={Menu} label="Buka menu" onClick={onMenu} className="lg:hidden" />
      <form
        role="search"
        className="relative flex max-w-md flex-1 items-center"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/pesanan${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
        }}
      >
        <span className="pointer-events-none absolute left-4 text-ink-3">
          <Icon icon={Search} size={20} />
        </span>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Cari pesanan atau pelanggan"
          placeholder="Cari pesanan atau pelanggan"
          className="h-11 w-full rounded-pill bg-surface pr-12 pl-12 text-body text-ink placeholder:text-ink-3"
        />
        <kbd className="absolute right-3 hidden rounded-[6px] bg-surface-muted px-2 py-0.5 font-sans text-meta text-ink-2 sm:block">/</kbd>
      </form>
      <div className="ml-auto flex items-center gap-3">
        <Link
          to="/persetujuan"
          aria-label={`${pending} menunggu persetujuan`}
          title={`${pending} menunggu persetujuan`}
          className="relative grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface text-ink-2 transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
        >
          <Icon icon={Bell} size={20} />
          {pending > 0 && (
            <span className="tabular absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-pill bg-primary px-1 text-meta font-semibold text-white">{pending}</span>
          )}
        </Link>
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-primary text-label font-semibold text-white" aria-hidden="true">
            {initials(user.displayName)}
          </span>
          <div className="hidden leading-tight md:block">
            <p className="text-label font-semibold text-ink">{user.displayName.replace(/\s*\(.*\)$/, '')}</p>
            <p className="text-small text-ink-3">{user.role === 'admin' ? 'Admin · bisa menyetujui' : 'Tamu · hanya melihat dan chat'}</p>
          </div>
          <IconButton icon={LogOut} label="Keluar" onClick={signOut} />
        </div>
      </div>
    </header>
  );
}

function initials(name: string): string {
  return name
    .replace(/\s*\(.*\)$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle: string; actions?: React.ReactNode }) {
  return (
    <motion.div variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease } } }} className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-h1 font-semibold text-ink">{title}</h1>
        <p className="mt-1 text-body text-ink-3">{subtitle}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </motion.div>
  );
}

/** Wraps a page so its header and card groups run the staggered entrance once per route. */
export function Page({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial="hidden" animate="show" className="mx-auto max-w-[1440px]">
      {children}
    </motion.div>
  );
}
