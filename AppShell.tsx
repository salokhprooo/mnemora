import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp, useCollection, useSyncStatus, useT } from '../../store/app';
import { NavLink, navigate, useLocation } from '../../lib/router';
import { formatRelativeDue } from '../../lib/time';
import {
  ArrowLeftRight, BarChart3, Cloud, CloudOff, Folder, GraduationCap, Home, Keyboard, Layers, Loader2, Menu, Monitor, Moon, PlusCircle, RefreshCw,
  Search, Settings, Sun, AlertTriangle, WifiOff, Check,
} from '../ui/icons';
import { IconButton, Kbd, cx } from '../ui/primitives';
import { Modal } from '../ui/Modal';
import { Link } from '../../lib/router';

export const NAV = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/decks', label: 'Decks', icon: Layers },
  { to: '/study', label: 'Study', icon: GraduationCap },
  { to: '/browse', label: 'Browse', icon: Search },
  { to: '/stats', label: 'Statistics', icon: BarChart3 },
  { to: '/add', label: 'Add Card', icon: PlusCircle },
  { to: '/data', label: 'Import / Export', icon: ArrowLeftRight },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

const MOBILE_PRIMARY = ['/', '/decks', '/study', '/add', '/browse'] as const;

function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="Mnemora home">
      <svg viewBox="0 0 64 64" className="h-8 w-8" aria-hidden>
        <rect width="64" height="64" rx="15" fill="rgb(var(--c-brand))" />
        <rect x="14" y="17" width="30" height="34" rx="5" fill="rgb(var(--c-brand-ink))" opacity=".4" transform="rotate(-8 29 34)" />
        <rect x="20" y="13" width="30" height="34" rx="5" fill="rgb(var(--c-brand-ink))" />
        <path d="M28 37V24l6 8 6-8v13" fill="none" stroke="rgb(var(--c-brand))" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!compact && <span className="font-display text-xl font-semibold tracking-tight">Mnemora</span>}
    </Link>
  );
}

// ------------------------------------------------------------------------------------------------ sync badge
export function SyncBadge({ expanded }: { expanded?: boolean }) {
  const s = useSyncStatus();
  const { engine, cloud, online } = useApp();
  const label =
    !engine.enabled ? 'Local only'
    : !online || s.state === 'offline' ? 'Offline'
    : s.state === 'syncing' ? 'Syncing…'
    : s.state === 'error' ? 'Sync failed'
    : s.pending > 0 ? `${s.pending} to upload`
    : 'Synced';
  const title = !engine.enabled
    ? 'Your data is stored on this device only. Sign in with a cloud account to sync.'
    : s.error
      ? `${s.error}${s.retryInMs ? ` — retrying in ${Math.ceil(s.retryInMs / 1000)}s` : ''}`
      : s.lastSyncAt ? `Last synced ${formatRelativeDue(s.lastSyncAt).replace('overdue', 'ago')}` : 'Not synced yet';
  const Icon = !engine.enabled ? CloudOff : !online || s.state === 'offline' ? WifiOff : s.state === 'syncing' ? Loader2 : s.state === 'error' ? AlertTriangle : s.pending > 0 ? Cloud : Check;
  const tone = s.state === 'error' ? 'text-again' : !online || s.state === 'offline' ? 'text-learnc' : 'text-mute';
  return (
    <div className="flex items-center gap-1">
      <button
        className={cx('inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-ink/5', tone)}
        title={title}
        aria-label={`Sync status: ${label}. ${title}`}
        onClick={() => (engine.enabled ? void engine.syncNow() : navigate('/settings?tab=account'))}
      >
        <Icon className={cx('h-4 w-4', s.state === 'syncing' && 'animate-spin')} />
        {(expanded || s.state !== 'idle' || !engine.enabled) && <span className="hidden sm:inline">{label}</span>}
      </button>
      {cloud && s.conflicts > 0 && (
        <Link to="/settings?tab=data" className="chip !bg-learnc/15 !text-learnc" title="Some records changed on two devices">
          {s.conflicts} conflict{s.conflicts > 1 ? 's' : ''}
        </Link>
      )}
      {engine.enabled && s.state === 'idle' && (
        <IconButton label="Sync now" onClick={() => void engine.syncNow()} className="hidden md:inline-flex">
          <RefreshCw className="h-4 w-4" />
        </IconButton>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ theme toggle
export function ThemeToggle() {
  const { theme, setTheme } = useApp();
  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <IconButton label={`Theme: ${theme} (click for ${next})`} onClick={() => setTheme(next)}>
      <Icon className="h-5 w-5" />
    </IconButton>
  );
}

// ------------------------------------------------------------------------------------------------ global search
function GlobalSearch() {
  const col = useCollection();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 120);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  const results = useMemo(() => (debounced.trim() ? col.globalSearch(debounced.trim(), 6) : null), [col, debounced, col.version]);
  const go = (to: string) => {
    setOpen(false);
    setQ('');
    input.current?.blur();
    navigate(to);
  };
  const quote = (s: string) => `"${s.replace(/"/g, '')}"`;

  return (
    <div ref={box} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" />
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim()) go(`/browse?q=${encodeURIComponent(q.trim())}`);
          if (e.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
        }}
        type="search"
        placeholder="Search cards and decks"
        aria-label="Global search"
        className="input pl-9 pr-14"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 md:flex">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </span>
      {open && results && (
        <div className="absolute left-0 right-0 top-full z-40 mt-2 max-h-[70dvh] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          {results.decks.length === 0 && results.cards.length === 0 && <p className="px-3 py-4 text-center text-sm text-mute">No matches</p>}
          {results.decks.length > 0 && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-mute">Decks</div>}
          {results.decks.map((d) => (
            <button key={d.id} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-ink/5" onClick={() => go(`/browse?q=${encodeURIComponent(`deck:${quote(col.deckPath(d.id))}`)}`)}>
              <Folder className="h-4 w-4 shrink-0 text-brand" />
              <span className="truncate">{col.deckPath(d.id)}</span>
            </button>
          ))}
          {results.cards.length > 0 && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-mute">Cards</div>}
          {results.cards.map((r) => (
            <button key={r.card.id} className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-ink/5" onClick={() => go(`/browse?q=${encodeURIComponent(debounced.trim())}&card=${r.card.id}`)}>
              <span className="truncate text-sm">{r.preview || '(empty)'}</span>
              <span className="truncate text-xs text-mute">{r.deckPath}</span>
            </button>
          ))}
          {(results.cards.length > 0 || results.decks.length > 0) && (
            <button className="mt-1 w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-brand hover:bg-brand/10" onClick={() => go(`/browse?q=${encodeURIComponent(debounced.trim())}`)}>
              See all results in Browse →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ shortcuts
export const SHORTCUT_HELP: [string, string][] = [
  ['Ctrl / ⌘ + K', 'Search cards and decks'],
  ['?', 'Show this help'],
  ['g then h / d / s / b / t / a', 'Go to Home / Decks / Study / Browse / sTatistics / Add'],
  ['Space or Enter', 'Show answer (while studying)'],
  ['1 · 2 · 3 · 4', 'Again · Hard · Good · Easy'],
  ['Z', 'Undo last answer (while studying)'],
  ['Ctrl / ⌘ + Enter', 'Save card (in the editor)'],
  ['Ctrl / ⌘ + B / I / U', 'Bold / italic / underline (in the editor)'],
  ['Ctrl / ⌘ + Shift + C', 'Wrap selection in a cloze (in the editor)'],
  ['Esc', 'Close dialogs'],
];

function useGlobalShortcuts(openHelp: () => void) {
  const pendingG = useRef<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        openHelp();
        return;
      }
      if (pendingG.current) {
        clearTimeout(pendingG.current);
        pendingG.current = null;
        const map: Record<string, string> = { h: '/', d: '/decks', s: '/study', b: '/browse', t: '/stats', a: '/add' };
        const to = map[e.key.toLowerCase()];
        if (to) {
          e.preventDefault();
          navigate(to);
        }
        return;
      }
      if (e.key === 'g' && window.location.hash.indexOf('/study') === -1) {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 900);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openHelp]);
}

// ------------------------------------------------------------------------------------------------ shell
export function AppShell({ children }: { children: ReactNode }) {
  const { path } = useLocation();
  const { online, persistent, account, mode } = useApp();
  const t = useT();
  const [more, setMore] = useState(false);
  const [help, setHelp] = useState(false);
  const openHelp = useCallback(() => setHelp(true), []);
  useGlobalShortcuts(openHelp);
  const studying = path === '/study';

  return (
    <div className="min-h-dvh md:flex">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface/60 px-3 py-5 md:flex">
        <div className="px-3 pb-6">
          <Logo />
        </div>
        <nav className="flex-1 space-y-0.5" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ active }) =>
                cx(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition',
                  active ? 'bg-brand/10 text-brand' : 'text-mute hover:bg-ink/5 hover:text-ink',
                )
              }
            >
              <Icon className="h-[18px] w-[18px]" />
              {t('nav.' + label)}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t border-line px-1 pt-3">
          <button onClick={openHelp} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-mute hover:bg-ink/5 hover:text-ink">
            <Keyboard className="h-[18px] w-[18px]" /> Keyboard shortcuts
          </button>
          <div className="px-3 pt-1 text-xs text-mute">
            {mode === 'cloud' && account ? <span className="block truncate">{account.email}</span> : <span>Local mode</span>}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!studying && (
          <header className="safe-top sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-bg/85 px-3 py-2.5 backdrop-blur md:px-6">
            <div className="md:hidden">
              <Logo compact />
            </div>
            <GlobalSearch />
            <div className="ml-auto flex items-center gap-0.5">
              <SyncBadge />
              <ThemeToggle />
            </div>
          </header>
        )}
        {!online && (
          <div role="status" className="flex items-center justify-center gap-2 bg-learnc/15 px-3 py-1.5 text-center text-xs font-medium text-learnc">
            <WifiOff className="h-3.5 w-3.5" /> You’re offline — everything keeps working and changes will sync when you reconnect.
          </div>
        )}
        {!persistent && (
          <div role="alert" className="bg-again/10 px-3 py-1.5 text-center text-xs font-medium text-again">
            Your browser blocked on-device storage, so this session will not be saved. Export a backup before closing the tab.
          </div>
        )}
        <main className={cx('mx-auto w-full max-w-6xl flex-1 px-4 py-5 md:px-8 md:py-8', !studying && 'pb-28 md:pb-10')}>{children}</main>
      </div>

      {/* mobile bottom navigation */}
      {!studying && (
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-line bg-surface/95 backdrop-blur md:hidden" aria-label="Main">
          {MOBILE_PRIMARY.map((to) => {
            const item = NAV.find((n) => n.to === to)!;
            const Icon = item.icon;
            const active = to === '/' ? path === '/' : path.startsWith(to);
            const center = to === '/add';
            return (
              <NavLink key={to} to={to} className="relative flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium" aria-label={item.label}>
                {center ? (
                  <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand text-brand-ink shadow-pop">
                    <Icon className="h-6 w-6" />
                  </span>
                ) : (
                  <Icon className={cx('h-[22px] w-[22px]', active ? 'text-brand' : 'text-mute')} />
                )}
                <span className={cx(active && !center ? 'text-brand' : 'text-mute')}>{center ? t('nav.Add') : t('nav.' + item.label)}</span>
              </NavLink>
            );
          })}
          <button onClick={() => setMore(true)} aria-label="More" className="flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium text-mute">
            <Menu className="h-[22px] w-[22px]" />
            <span>{t('nav.More')}</span>
          </button>
        </nav>
      )}
      <Modal open={more} onClose={() => setMore(false)} title="More" size="sm">
        <div className="grid gap-1">
          {NAV.filter((n) => !(MOBILE_PRIMARY as readonly string[]).includes(n.to)).map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} onClick={() => setMore(false)} className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium hover:bg-ink/5">
              <Icon className="h-5 w-5 text-brand" /> {t('nav.' + label)}
            </Link>
          ))}
        </div>
      </Modal>

      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" size="md">
        <dl className="divide-y divide-line text-sm">
          {SHORTCUT_HELP.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2">
              <dt className="text-mute">{d}</dt>
              <dd className="shrink-0 font-mono text-xs">{k}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}
