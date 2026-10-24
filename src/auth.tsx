import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import bs58 from 'bs58';
import { api } from './api';

export type Me = {
  wallet: string;
  handle: string | null;
  display_name: string;
  bio: string;
  country: string;
  kind: 'person' | 'agent';
  operator?: string | null;
  operator_wallet: string | null;
  operator_approved: boolean;
  human_review?: string;
  manifest_url?: string;
  hourly_ltmx: number;
  available: boolean;
};

export type MeResponse = {
  user: Me | null;
  admin?: boolean;
  agents?: { wallet: string; handle: string | null; display_name: string; operator_approved: number; human_review: string }[];
  unread?: number;
};

type AuthState = {
  me: MeResponse | null;
  loading: boolean;
  signingIn: boolean;
  error: string | null;
  login: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wantLogin = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<MeResponse>('/api/me'));
    } catch {
      setMe({ user: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const signIn = useCallback(async () => {
    const pk = wallet.publicKey?.toBase58();
    if (!pk) return;
    if (!wallet.signMessage) {
      setError('This wallet cannot sign messages. Try Phantom, Solflare or Backpack.');
      return;
    }
    setSigningIn(true);
    setError(null);
    try {
      const { nonce, message } = await api<{ nonce: string; message: string }>('/api/auth/nonce', { body: { wallet: pk } });
      const sig = await wallet.signMessage(new TextEncoder().encode(message));
      await api('/api/auth/verify', { body: { wallet: pk, nonce, signature: bs58.encode(sig) } });
      await refresh();
    } catch (e: any) {
      const msg = String(e?.message || e);
      setError(/reject|denied|cancel/i.test(msg) ? 'You cancelled the signature, so you are not logged in.' : msg);
    } finally {
      setSigningIn(false);
      wantLogin.current = false;
    }
  }, [wallet, refresh]);

  // Picking a wallet in the modal only selects it (autoConnect is off), so connect it here.
  useEffect(() => {
    if (wantLogin.current && wallet.wallet && !wallet.connected && !wallet.connecting) {
      wallet.connect().catch((e: any) => {
        wantLogin.current = false;
        setError(/reject|denied|cancel/i.test(String(e?.message || e)) ? 'You cancelled the connection.' : `Could not connect to ${wallet.wallet?.adapter.name}. Unlock the wallet and try again.`);
      });
    }
  }, [wallet.wallet, wallet.connected, wallet.connecting, wallet]);

  // After the person picks a wallet from the modal, ask it to sign the login message.
  useEffect(() => {
    if (wantLogin.current && wallet.connected && wallet.publicKey && !signingIn) signIn();
  }, [wallet.connected, wallet.publicKey, signIn, signingIn]);

  // If the person switches to a different wallet account, log out of the old one.
  useEffect(() => {
    const pk = wallet.publicKey?.toBase58();
    if (pk && me?.user && me.user.wallet !== pk && !wantLogin.current) {
      api('/api/auth/logout', { method: 'POST' }).finally(refresh);
    }
  }, [wallet.publicKey, me, refresh]);

  const login = useCallback(() => {
    setError(null);
    wantLogin.current = true;
    if (wallet.connected && wallet.publicKey) signIn();
    else setVisible(true);
  }, [wallet.connected, wallet.publicKey, signIn, setVisible]);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    await wallet.disconnect().catch(() => {});
    await refresh();
  }, [wallet, refresh]);

  return <AuthContext.Provider value={{ me, loading, signingIn, error, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
