/**
 * Application root state: account (cloud or local), the open Collection, sync engine, media store, theme,
 * toasts and confirm dialogs. Everything below <AppProvider> can assume `useApp().col` is ready.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { Collection } from '../db/collection';
import { openPersistence, type Persistence } from '../db/persistence';
import { SyncEngine, type SyncStatus } from '../db/sync';
import { SupabaseTransport } from '../db/supabaseTransport';
import { MediaStore } from '../lib/media';
import { randomDeviceId } from '../lib/ids';
import { cloudConfigured, supabase, unsafeKeyDetected } from '../lib/supabase';
import type { ThemeMode } from '../types';
import { translate } from '../lib/i18n';
import { ToastHost } from '../components/ui/Toasts';
import { ConfirmHost } from '../components/ui/ConfirmHost';

// ------------------------------------------------------------------------------------------------ types
export type AuthMode = 'booting' | 'signed-out' | 'recovery' | 'local' | 'cloud';

export interface Account {
  id: string;
  email: string | null;
  name: string;
  providers: string[];
  emailConfirmed: boolean;
}

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; run: () => void };
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface AuthResult {
  error?: string;
  /** true when the user must confirm their e-mail before signing in */
  needsVerification?: boolean;
  info?: string;
}

interface Ctx {
  mode: AuthMode;
  account: Account | null;
  col: Collection;
  store: Persistence;
  engine: SyncEngine;
  media: MediaStore;
  cloud: boolean;
  persistent: boolean;
  online: boolean;
  theme: ThemeMode;
  setTheme(t: ThemeMode): void;
  toast(kind: ToastKind, message: string, action?: Toast['action']): void;
  confirm(o: ConfirmOptions): Promise<boolean>;
  signOut(): Promise<void>;
}

interface AuthCtx {
  mode: AuthMode;
  cloudConfigured: boolean;
  unsafeKey: boolean;
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string, name: string): Promise<AuthResult>;
  google(): Promise<AuthResult>;
  resetPassword(email: string): Promise<AuthResult>;
  updatePassword(password: string): Promise<AuthResult>;
  useLocal(): void;
}

const AppContext = createContext<Ctx | null>(null);
const AuthContext = createContext<AuthCtx | null>(null);
const UiContext = createContext<{ toast: Ctx['toast']; confirm: Ctx['confirm'] } | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('useApp must be used inside a ready <AppProvider>');
  return c;
}
export const useAuth = (): AuthCtx => {
  const c = useContext(AuthContext);
  if (!c) throw new Error('useAuth outside provider');
  return c;
};
export const useUi = () => {
  const c = useContext(UiContext);
  if (!c) throw new Error('useUi outside provider');
  return c;
};

/** Re-render whenever the collection changes. Returns the collection for convenience. */
export function useCollection(): Collection {
  const { col } = useApp();
  useSyncExternalStore(col.subscribe, col.getVersion);
  return col;
}

export function useT(): (key: string) => string {
  const col = useCollection();
  const lang = col.settings.language;
  return useCallback((key: string) => translate(lang, key), [lang]);
}

export function useSyncStatus(): SyncStatus {
  const { engine } = useApp();
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}

// ------------------------------------------------------------------------------------------------ helpers
const LS_LOCAL = 'mnemora.localMode';
const LS_DEVICE = 'mnemora.device';
const LS_THEME = 'mnemora.theme';

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

function deviceId(): string {
  let id = lsGet(LS_DEVICE);
  if (!id) {
    id = randomDeviceId();
    lsSet(LS_DEVICE, id);
  }
  return id;
}

export function applyTheme(t: ThemeMode) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0b1f1d' : '#0f766e');
}

/** Map backend errors to short, safe messages (never leak internals). */
export function friendlyAuthError(message: string | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (m.includes('invalid login')) return 'Incorrect email or password.';
  if (m.includes('email not confirmed')) return 'Please verify your email first — check your inbox for the confirmation link.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'An account with this email already exists. Try signing in instead.';
  if (m.includes('password') && (m.includes('weak') || m.includes('at least') || m.includes('short'))) return 'Choose a stronger password (at least 8 characters).';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Please wait a minute and try again.';
  if (m.includes('fetch') || m.includes('network')) return 'Cannot reach the server. Check your connection.';
  if (m.includes('provider') && m.includes('not enabled')) return 'Google sign-in is not enabled for this project yet.';
  return 'Something went wrong. Please try again.';
}

function accountFrom(s: Session): Account {
  const u = s.user;
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: u.id,
    email: u.email ?? null,
    name: String(meta.display_name ?? meta.full_name ?? meta.name ?? u.email?.split('@')[0] ?? 'Learner'),
    providers: ((u.app_metadata?.providers as string[] | undefined) ?? [u.app_metadata?.provider as string | undefined]).filter(Boolean) as string[],
    emailConfirmed: Boolean(u.email_confirmed_at),
  };
}

// ------------------------------------------------------------------------------------------------ provider
interface Ready {
  col: Collection;
  store: Persistence;
  engine: SyncEngine;
  media: MediaStore;
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (a: { mode: AuthMode; error: string | null }) => ReactNode }) {
  const [mode, setMode] = useState<AuthMode>('booting');
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemeMode>(() => (lsGet(LS_THEME) as ThemeMode | null) ?? 'system');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const toastId = useRef(0);

  // ---- toasts + confirm
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback<Ctx['toast']>(
    (kind, message, action) => {
      const id = ++toastId.current;
      setToasts((t) => [...t.slice(-3), { id, kind, message, action }]);
      setTimeout(() => dismiss(id), action ? 7000 : kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );
  const confirm = useCallback<Ctx['confirm']>((o) => new Promise((resolve) => setDialog({ ...o, resolve })), []);
  const ui = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  // ---- online status
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // ---- theme
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [theme]);

  // ---- auth bootstrap
  useEffect(() => {
    let cancelled = false;
    const forcedLocal = lsGet(LS_LOCAL) === '1';
    if (!supabase) {
      setMode('local');
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) {
        setAccount(accountFrom(data.session));
        setMode('cloud');
      } else setMode(forcedLocal ? 'local' : 'signed-out');
    }).catch(() => !cancelled && setMode(forcedLocal ? 'local' : 'signed-out'));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setMode('recovery');
      else if (event === 'SIGNED_OUT') {
        setAccount(null);
        setMode(lsGet(LS_LOCAL) === '1' ? 'local' : 'signed-out');
      } else if (session) {
        setAccount(accountFrom(session));
        setMode((m) => (m === 'recovery' ? m : 'cloud'));
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // ---- open collection for the current identity
  const userKey = mode === 'cloud' && account ? account.id : mode === 'local' ? 'local' : null;
  useEffect(() => {
    if (!userKey) {
      setReady(null);
      return;
    }
    let cancelled = false;
    let opened: Ready | null = null;
    (async () => {
      try {
        setBootError(null);
        const store = await openPersistence(userKey);
        const col = await Collection.open(store, userKey);
        const cloudMedia =
          supabase && userKey !== 'local'
            ? {
                async upload(path: string, blob: Blob) {
                  const { error } = await supabase!.storage.from('media').upload(path, blob, { upsert: true, contentType: blob.type });
                  if (error) throw error;
                },
                async download(path: string) {
                  const { data, error } = await supabase!.storage.from('media').download(path);
                  return error ? null : data;
                },
              }
            : null;
        const media = new MediaStore(store, userKey, cloudMedia);
        const transport = supabase && userKey !== 'local' ? new SupabaseTransport(supabase, userKey) : null;
        const engine = new SyncEngine(col, store, transport, deviceId(), { autoSync: () => col.settings.auto_sync });
        if (cancelled) {
          store.close();
          return;
        }
        opened = { col, store, engine, media };
        await engine.start();
        // Settings synced from another device may carry a different theme.
        const t = col.settings.theme;
        if (t) {
          setThemeState(t);
          lsSet(LS_THEME, t);
        }
        setReady(opened);
        if (transport) void media.flushUploads();
      } catch (e) {
        console.error(e);
        if (!cancelled) setBootError('Could not open your collection. Reload the page; if this keeps happening, restore from a backup.');
      }
    })();
    return () => {
      cancelled = true;
      if (opened) {
        opened.engine.stop();
        opened.media.dispose();
        opened.store.close();
      }
      setReady(null);
    };
  }, [userKey]);

  // Upload queued media after every successful sync.
  const sync = ready ? ready.engine : null;
  useEffect(() => {
    if (!ready || !sync?.enabled) return;
    let last: string | null = null;
    return sync.subscribe(() => {
      const s = sync.getSnapshot();
      if (s.state === 'idle' && s.lastSyncAt !== last) {
        last = s.lastSyncAt;
        void ready.media.flushUploads();
      }
    });
  }, [ready, sync]);

  // Theme from settings → persisted for the pre-paint script.
  const setTheme = useCallback(
    (t: ThemeMode) => {
      setThemeState(t);
      lsSet(LS_THEME, t);
      if (ready) void ready.col.updateSettings({ theme: t });
    },
    [ready],
  );

  // ---- auth actions
  const authApi = useMemo<AuthCtx>(
    () => ({
      mode,
      cloudConfigured,
      unsafeKey: unsafeKeyDetected,
      async signIn(email, password) {
        if (!supabase) return { error: 'Cloud accounts are not configured.' };
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        return error ? { error: friendlyAuthError(error.message) } : {};
      },
      async signUp(email, password, name) {
        if (!supabase) return { error: 'Cloud accounts are not configured.' };
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: name.trim() }, emailRedirectTo: window.location.origin + window.location.pathname },
        });
        if (error) return { error: friendlyAuthError(error.message) };
        // With e-mail confirmation enabled Supabase returns a user but no session.
        // An obfuscated duplicate sign-up returns a user with no identities.
        if (!data.session) return { needsVerification: true, info: 'Check your inbox and click the confirmation link, then sign in.' };
        return {};
      },
      async google() {
        if (!supabase) return { error: 'Cloud accounts are not configured.' };
        const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname } });
        return error ? { error: friendlyAuthError(error.message) } : {};
      },
      async resetPassword(email) {
        if (!supabase) return { error: 'Cloud accounts are not configured.' };
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin + window.location.pathname });
        // Always report success so the form cannot be used to discover which e-mails are registered.
        if (error && /rate|fetch|network/i.test(error.message)) return { error: friendlyAuthError(error.message) };
        return { info: 'If an account exists for that address, a reset link is on its way.' };
      },
      async updatePassword(password) {
        if (!supabase) return { error: 'Cloud accounts are not configured.' };
        const { error } = await supabase.auth.updateUser({ password });
        if (error) return { error: friendlyAuthError(error.message) };
        setMode('cloud');
        return { info: 'Password updated.' };
      },
      useLocal() {
        lsSet(LS_LOCAL, '1');
        setMode('local');
      },
    }),
    [mode],
  );

  const signOut = useCallback(async () => {
    lsSet(LS_LOCAL, null);
    if (supabase) await supabase.auth.signOut();
    else setMode('signed-out');
  }, []);

  const value = useMemo<Ctx | null>(
    () =>
      ready
        ? {
            mode,
            account,
            ...ready,
            cloud: Boolean(supabase) && mode === 'cloud',
            persistent: ready.store.kind === 'indexeddb',
            online,
            theme,
            setTheme,
            toast,
            confirm,
            signOut,
          }
        : null,
    [ready, mode, account, online, theme, setTheme, toast, confirm, signOut],
  );

  return (
    <UiContext.Provider value={ui}>
      <AuthContext.Provider value={authApi}>
        {value ? <AppContext.Provider value={value}>{children}</AppContext.Provider> : fallback({ mode, error: bootError })}
        <ToastHost toasts={toasts} dismiss={dismiss} />
        <ConfirmHost dialog={dialog} close={(v) => { dialog?.resolve(v); setDialog(null); }} />
      </AuthContext.Provider>
    </UiContext.Provider>
  );
}
