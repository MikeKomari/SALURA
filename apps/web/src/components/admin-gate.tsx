import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect } from 'react';
import { api, SIGNED_OUT_EVENT } from '../lib/api.ts';
import { closeLive } from '../lib/live.ts';
import type { SessionUser } from '../lib/types.ts';
import { LoginPage } from '../pages/login.tsx';
import { useToast } from './ui/toast.tsx';

interface AuthContextValue {
  user: SessionUser;
  isAdmin: boolean;
  /** True for admins. For a guest account it explains why the action is not allowed and returns false. */
  requireAdmin: () => Promise<boolean>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Kept for the screens written against the old admin-key gate. */
export const useAdmin = useAuth;

const ME = ['auth', 'me'] as const;

/**
 * The whole console sits behind a login. Admin accounts (the distributor owner, the judges' account)
 * can decide approvals and change data; guest accounts can chat as a warung and look around.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ME, queryFn: () => api.get<{ user: SessionUser | null }>('/api/auth/me'), staleTime: Infinity, retry: 1 });
  const user = me.data?.user ?? null;

  useEffect(() => {
    const onSignedOut = () => {
      closeLive();
      qc.setQueryData(ME, { user: null });
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [qc]);

  // Another account must never see the previous one's cached data. The session query itself stays:
  // this component is subscribed to it, and a removed query would no longer update the screen.
  const forgetData = useCallback(() => qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME[0] }), [qc]);

  const signOut = useCallback(() => {
    closeLive();
    void api.post('/api/auth/logout').finally(() => {
      forgetData();
      qc.setQueryData(ME, { user: null });
    });
  }, [qc, forgetData]);

  const requireAdmin = useCallback(async () => {
    if (user?.role === 'admin') return true;
    toast({ tone: 'error', text: 'Akun tamu hanya bisa melihat dan mencoba chat. Masuk dengan akun admin untuk menyetujui atau mengubah data.' });
    return false;
  }, [user, toast]);

  if (me.isLoading) return <div className="min-h-dvh bg-surface" aria-busy="true" />;
  if (!user) {
    return (
      <LoginPage
        serverError={me.error ? (me.error as Error).message : undefined}
        onLoggedIn={(u) => {
          forgetData();
          qc.setQueryData(ME, { user: u });
        }}
      />
    );
  }

  return <AuthContext.Provider value={{ user, isAdmin: user.role === 'admin', requireAdmin, signOut }}>{children}</AuthContext.Provider>;
}
