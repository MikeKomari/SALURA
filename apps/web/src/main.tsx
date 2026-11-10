import '@fontsource-variable/plus-jakarta-sans';
import './styles/app.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider } from './components/admin-gate.tsx';
import { AppShell } from './components/layout/app-shell.tsx';
import { ToastProvider } from './components/ui/toast.tsx';
import { useLiveInvalidation } from './lib/live.ts';
import { DashboardPage } from './pages/dashboard.tsx';
import { AppErrorBoundary, ErrorPage, RootErrorScreen } from './pages/error.tsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } },
});

/** Each screen is its own chunk; the dashboard (landing page) stays in the main bundle. */
function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M) {
  return async () => ({ Component: (await load())[name] as React.ComponentType });
}

function Root() {
  useLiveInvalidation();
  return <AppShell />;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    // The shell itself threw, so the fallback cannot rely on the shell.
    errorElement: <RootErrorScreen />,
    children: [
      {
        // Pathless layout: page errors render in the shell's outlet, so the nav stays usable.
        errorElement: <ErrorPage />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'percakapan', lazy: page(() => import('./pages/chat.tsx'), 'ChatPage') },
          { path: 'percakapan/:waId', lazy: page(() => import('./pages/chat.tsx'), 'ChatPage') },
          { path: 'persetujuan', lazy: page(() => import('./pages/approvals.tsx'), 'ApprovalsPage') },
          { path: 'pesanan', lazy: page(() => import('./pages/orders.tsx'), 'OrdersPage') },
          { path: 'pengiriman', lazy: page(() => import('./pages/deliveries.tsx'), 'DeliveriesPage') },
          { path: 'gudang', lazy: page(() => import('./pages/warehouse.tsx'), 'WarehousePage') },
          { path: 'penagihan', lazy: page(() => import('./pages/collections.tsx'), 'CollectionsPage') },
          { path: 'evaluasi', lazy: page(() => import('./pages/evaluation.tsx'), 'EvaluationPage') },
          { path: 'pengaturan', lazy: page(() => import('./pages/settings.tsx'), 'SettingsPage') },
          { path: 'impor', lazy: page(() => import('./pages/import.tsx'), 'ImportPage') },
          { path: 'bantuan', lazy: page(() => import('./pages/help.tsx'), 'HelpPage') },
          // Unknown address: raise a 404 so it lands on the same error page as everything else.
          {
            path: '*',
            loader: () => {
              throw new Response('Not Found', { status: 404 });
            },
          },
        ],
      },
    ],
  },
]);

// Installable app (PWA). Production only: in dev a service worker would fight Vite's hot reload.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker tidak terpasang', err));
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <AppErrorBoundary>
          <ToastProvider>
            <AuthProvider>
              <RouterProvider router={router} />
            </AuthProvider>
          </ToastProvider>
        </AppErrorBoundary>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
