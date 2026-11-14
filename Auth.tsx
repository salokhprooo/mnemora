import { useState, type FormEvent } from 'react';
import { useAuth, type AuthMode, type AuthResult } from '../store/app';
import { Button, Field, Input, Spinner } from '../components/ui/primitives';
import { AlertTriangle, Info, Lock, Mail, User } from '../components/ui/icons';

type View = 'signin' | 'signup' | 'forgot';

function Brand() {
  return (
    <div className="mb-6 flex items-center gap-3">
      <svg viewBox="0 0 64 64" className="h-10 w-10" aria-hidden>
        <rect width="64" height="64" rx="15" fill="rgb(var(--c-brand))" />
        <rect x="20" y="13" width="30" height="34" rx="5" fill="rgb(var(--c-brand-ink))" />
        <path d="M28 37V24l6 8 6-8v13" fill="none" stroke="rgb(var(--c-brand))" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Mnemora</h1>
        <p className="text-sm text-mute">Remember what matters, for good.</p>
      </div>
    </div>
  );
}

export function BootScreen({ error }: { error?: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-sm text-center" role={error ? 'alert' : 'status'}>
        {error ? (
          <>
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-again" aria-hidden />
            <p className="mb-4 text-sm">{error}</p>
            <Button variant="primary" onClick={() => window.location.reload()}>Reload</Button>
          </>
        ) : (
          <>
            <Spinner className="mx-auto h-6 w-6" />
            <p className="mt-3 text-sm text-mute">Opening your collection…</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function AuthPage({ mode }: { mode: AuthMode }) {
  const auth = useAuth();
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const recovery = mode === 'recovery';

  async function run(fn: () => Promise<AuthResult>) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (r.error) setMsg({ kind: 'error', text: r.error });
      else if (r.info) setMsg({ kind: 'info', text: r.info });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (recovery) {
      if (password.length < 8) return setMsg({ kind: 'error', text: 'Use at least 8 characters.' });
      return void run(() => auth.updatePassword(password));
    }
    if (!email.trim()) return setMsg({ kind: 'error', text: 'Enter your email address.' });
    if (view === 'forgot') return void run(() => auth.resetPassword(email));
    if (password.length < 8 && view === 'signup') return setMsg({ kind: 'error', text: 'Use at least 8 characters.' });
    if (!password) return setMsg({ kind: 'error', text: 'Enter your password.' });
    void run(() => (view === 'signup' ? auth.signUp(email, password, name) : auth.signIn(email, password)));
  }

  const title = recovery ? 'Choose a new password' : view === 'signup' ? 'Create your account' : view === 'forgot' ? 'Reset your password' : 'Welcome back';

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="panel w-full max-w-md p-6 sm:p-8">
        <Brand />

        {auth.unsafeKey && (
          <div role="alert" className="mb-4 flex gap-2 rounded-lg border border-again/40 bg-again/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-again" aria-hidden />
            <p>
              The configured Supabase key looks like a <strong>service-role</strong> key. It has been ignored for your safety — use the public
              <code className="mx-1">anon</code> key in <code>VITE_SUPABASE_ANON_KEY</code> and rotate the leaked key.
            </p>
          </div>
        )}

        {!auth.cloudConfigured ? (
          <div className="space-y-4">
            <div className="flex gap-2 rounded-lg border border-line bg-sunken p-3 text-sm">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
              <p>
                Cloud accounts are not configured for this build. Mnemora works fully offline: your cards are stored in this browser. To enable
                accounts and sync, set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see README).
              </p>
            </div>
            <Button variant="primary" size="lg" className="w-full" onClick={auth.useLocal}>Continue on this device</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <h2 className="text-lg font-semibold">{title}</h2>

            {view === 'signup' && !recovery && (
              <Field label="Display name" htmlFor="auth-name">
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
                  <Input id="auth-name" autoComplete="name" className="pl-9" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
                </div>
              </Field>
            )}

            {!recovery && (
              <Field label="Email" htmlFor="auth-email">
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
                  <Input id="auth-email" type="email" autoComplete="email" className="pl-9" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
                </div>
              </Field>
            )}

            {view !== 'forgot' && (
              <Field label={recovery ? 'New password' : 'Password'} htmlFor="auth-pass" hint={view === 'signup' || recovery ? 'At least 8 characters.' : undefined}>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
                  <Input
                    id="auth-pass"
                    type="password"
                    autoComplete={view === 'signup' || recovery ? 'new-password' : 'current-password'}
                    className="pl-9"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus={recovery}
                  />
                </div>
              </Field>
            )}

            {msg && (
              <p role={msg.kind === 'error' ? 'alert' : 'status'} className={msg.kind === 'error' ? 'text-sm text-again' : 'text-sm text-good'}>
                {msg.text}
              </p>
            )}

            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
              {recovery ? 'Update password' : view === 'signup' ? 'Create account' : view === 'forgot' ? 'Send reset link' : 'Sign in'}
            </Button>

            {!recovery && view === 'signin' && (
              <button type="button" className="text-sm text-brand hover:underline" onClick={() => { setView('forgot'); setMsg(null); }}>
                Forgot your password?
              </button>
            )}

            {!recovery && view !== 'forgot' && (
              <>
                <div className="flex items-center gap-3 text-xs text-mute" aria-hidden>
                  <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
                </div>
                <Button size="lg" className="w-full" disabled={busy} onClick={() => run(auth.google)}>
                  <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
                    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
                    <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" />
                    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
                  </svg>
                  Continue with Google
                </Button>
              </>
            )}

            {!recovery && (
              <p className="text-center text-sm text-mute">
                {view === 'signup' ? 'Already have an account?' : view === 'forgot' ? 'Remembered it?' : 'New to Mnemora?'}{' '}
                <button type="button" className="font-medium text-brand hover:underline" onClick={() => { setView(view === 'signup' || view === 'forgot' ? 'signin' : 'signup'); setMsg(null); }}>
                  {view === 'signup' || view === 'forgot' ? 'Sign in' : 'Create an account'}
                </button>
              </p>
            )}

            {!recovery && (
              <div className="border-t border-line pt-4 text-center">
                <button type="button" className="text-sm text-mute hover:text-ink hover:underline" onClick={auth.useLocal}>
                  Continue without an account
                </button>
                <p className="mt-1 text-xs text-mute">Data stays on this device only. You can sign in later.</p>
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
