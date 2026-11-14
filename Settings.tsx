import { useCallback, useEffect, useState } from 'react';
import { useApp, useAuth, useCollection, useSyncStatus } from '../store/app';
import { Link, navigate, useQueryParam } from '../lib/router';
import { supabase } from '../lib/supabase';
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from '../lib/defaults';
import { LANGUAGES } from '../lib/i18n';
import { PARAM_COUNT, DEFAULT_PARAMS } from '../lib/fsrs';
import type { Language, ShortcutMap, SyncConflict, ThemeMode } from '../types';
import { DeckOptionsModal } from '../components/decks/DeckOptionsModal';
import { NoteTypeManager } from '../components/cards/NoteTypeManager';
import { Badge, Button, Field, Input, PageHeader, Section, Segmented, Select, Switch, Textarea, cx } from '../components/ui/primitives';
import { Bell, Database, Keyboard, Languages, Lock, Mail, Monitor, Moon, Palette, RefreshCw, Shield, SlidersHorizontal, Sun, User, GraduationCap, Eye } from '../components/ui/icons';
import { formatRelativeDue } from '../lib/time';

const TABS = [
  { id: 'general', label: 'General', icon: Palette },
  { id: 'study', label: 'Study', icon: GraduationCap },
  { id: 'review', label: 'Review', icon: Eye },
  { id: 'account', label: 'Account', icon: User },
  { id: 'data', label: 'Data', icon: Database },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function Settings() {
  const tabParam = useQueryParam('tab') as Tab | null;
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? tabParam! : 'general';
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" />
      <div role="tablist" aria-label="Settings sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-line bg-raised p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => navigate(`/settings?tab=${id}`, { replace: true })}
            className={cx('flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition', tab === id ? 'bg-surface text-ink shadow-sm' : 'text-mute hover:text-ink')}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="space-y-5">
        {tab === 'general' && <General />}
        {tab === 'study' && <Study />}
        {tab === 'review' && <Review />}
        {tab === 'account' && <Account />}
        {tab === 'data' && <DataTab />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ general
function General() {
  const { theme, setTheme, toast } = useApp();
  const col = useCollection();
  const s = col.settings;
  const [time, setTime] = useState(s.reminder_time);

  const setReminders = async (on: boolean) => {
    if (on) {
      if (typeof Notification === 'undefined') return toast('error', 'This browser does not support notifications.');
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') return toast('error', 'Notifications are blocked. Allow them in your browser settings to get reminders.');
    }
    await col.updateSettings({ reminders_enabled: on });
  };

  return (
    <>
      <Section title="Appearance">
        <Field label="Theme">
          <Segmented<ThemeMode> label="Theme" value={theme} onChange={setTheme} options={[
            { value: 'light', label: <><Sun className="h-4 w-4" />Light</> },
            { value: 'dark', label: <><Moon className="h-4 w-4" />Dark</> },
            { value: 'system', label: <><Monitor className="h-4 w-4" />System</> },
          ]} />
        </Field>
        <Field label="Language" hint="Navigation and the study screen are translated; the rest of the app is English for now.">
          <Select value={s.language} onChange={(e) => void col.updateSettings({ language: e.target.value as Language })} aria-label="Language" className="max-w-xs">
            {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </Select>
        </Field>
        <Switch label="Compact layout" description="Tighter spacing in lists" checked={s.compact} onChange={(v) => void col.updateSettings({ compact: v })} />
      </Section>

      <Section title="Goals & reminders">
        <Field label="Daily goal (reviews)" hint="Used for the progress ring on the home page">
          <Input type="number" min={1} max={5000} className="max-w-[10rem]" value={s.daily_goal} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 5000) void col.updateSettings({ daily_goal: n }); }} aria-label="Daily goal" />
        </Field>
        <Field label="Next day starts at" hint="Cards due “today” roll over at this hour, so late-night study counts for the previous day.">
          <Select className="max-w-[10rem]" value={s.rollover_hour} onChange={(e) => void col.updateSettings({ rollover_hour: Number(e.target.value) })} aria-label="Day rollover hour">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </Select>
        </Field>
        <Switch label="Study reminders" description="A notification at your chosen time when cards are due. Works while the app is open in a tab or installed; background push needs a server and is not included." checked={s.reminders_enabled} onChange={(v) => void setReminders(v)} />
        {s.reminders_enabled && (
          <Field label="Remind me at">
            <Input type="time" className="max-w-[10rem]" value={time} onChange={(e) => { setTime(e.target.value); if (/^\d{2}:\d{2}$/.test(e.target.value)) void col.updateSettings({ reminder_time: e.target.value }); }} aria-label="Reminder time" />
          </Field>
        )}
        <Switch label="Sync automatically" description="Upload and download changes in the background when you are signed in" checked={s.auto_sync} onChange={(v) => void col.updateSettings({ auto_sync: v })} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ study
function Study() {
  const { toast } = useApp();
  const col = useCollection();
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [types, setTypes] = useState(false);
  const [fsrs, setFsrs] = useState(col.settings.fsrs_params?.join(', ') ?? '');
  const [err, setErr] = useState<string | null>(null);
  const def = col.options.get(col.defaultOptionsId)!;

  const saveFsrs = async () => {
    setErr(null);
    if (!fsrs.trim()) {
      await col.updateSettings({ fsrs_params: null });
      return toast('success', 'Using default FSRS parameters');
    }
    const nums = fsrs.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (nums.length !== PARAM_COUNT || nums.some((n) => !Number.isFinite(n))) return setErr(`Enter exactly ${PARAM_COUNT} numbers, or leave empty for the defaults.`);
    await col.updateSettings({ fsrs_params: nums });
    toast('success', 'FSRS parameters saved. Use “Reschedule” in deck options to apply them to existing cards.');
  };

  return (
    <>
      <Section title="Default scheduling" description="These values come from the default options preset, which new decks use. Each deck can use its own preset (Decks → ⋮ → Options).">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            ['New cards / day', def.new_per_day],
            ['Max reviews / day', def.reviews_per_day],
            ['Desired retention', `${Math.round(def.desired_retention * 100)}%`],
            ['Maximum interval', `${def.maximum_interval} d`],
            ['Learning steps', def.learning_steps.join(' ') + ' min'],
            ['Relearning steps', def.relearning_steps.join(' ') + ' min'],
          ].map(([k, v]) => (
            <div key={k as string} className="rounded-lg bg-raised p-3"><dt className="text-xs text-mute">{k}</dt><dd className="font-semibold tabular-nums">{v}</dd></div>
          ))}
        </dl>
        <Button onClick={() => setOptionsFor(col.defaultDeckId)} icon={<SlidersHorizontal className="h-4 w-4" />}>Edit default preset</Button>
      </Section>

      <Section title="FSRS parameters" description={`Account-wide parameters (${PARAM_COUNT} numbers) used by every deck whose preset has none of its own.`}>
        <Field label="Parameters" error={err} hint="Leave empty for the built-in defaults. You can paste parameters produced by an FSRS optimiser.">
          <Textarea className="font-mono text-xs" rows={3} value={fsrs} onChange={(e) => { setFsrs(e.target.value); setErr(null); }} placeholder={DEFAULT_PARAMS.join(', ')} aria-label="FSRS parameters" />
        </Field>
        <div className="flex gap-2"><Button variant="primary" onClick={() => void saveFsrs()}>Save</Button><Button onClick={() => { setFsrs(''); }}>Clear</Button></div>
      </Section>

      <Section title="Card templates"><p className="text-sm text-mute">Create your own note types with custom fields, templates and styling.</p><Button onClick={() => setTypes(true)}>Manage note types</Button></Section>

      <DeckOptionsModal deckId={optionsFor} onClose={() => setOptionsFor(null)} />
      <NoteTypeManager open={types} onClose={() => setTypes(false)} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------ review
const SHORTCUT_LABELS: Record<keyof ShortcutMap, string> = { showAnswer: 'Show answer', again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy', undo: 'Undo' };
const keyLabel = (k: string) => (k === ' ' ? 'Space' : k.toUpperCase());

function ShortcutEditor() {
  const col = useCollection();
  const [capturing, setCapturing] = useState<keyof ShortcutMap | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const sc = col.settings.shortcuts;

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(null);
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : null;
      if (!k) return setMsg('Use a single letter, number, symbol or the space bar.');
      const clash = (Object.entries(sc) as [keyof ShortcutMap, string][]).find(([name, v]) => name !== capturing && v.toLowerCase() === k);
      if (clash) return setMsg(`“${keyLabel(k)}” is already used for ${SHORTCUT_LABELS[clash[0]]}.`);
      void col.updateSettings({ shortcuts: { ...sc, [capturing]: k } });
      setMsg(null);
      setCapturing(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [capturing, sc, col]);

  return (
    <div>
      <ul className="divide-y divide-line">
        {(Object.keys(SHORTCUT_LABELS) as (keyof ShortcutMap)[]).map((name) => (
          <li key={name} className="flex items-center justify-between py-2">
            <span className="text-sm">{SHORTCUT_LABELS[name]}</span>
            <Button size="sm" onClick={() => { setMsg(null); setCapturing(capturing === name ? null : name); }} aria-label={`Change shortcut for ${SHORTCUT_LABELS[name]}`} className="min-w-[7rem] font-mono">
              {capturing === name ? 'Press a key…' : keyLabel(sc[name])}
            </Button>
          </li>
        ))}
      </ul>
      {msg && <p role="alert" className="mt-2 text-sm text-again">{msg}</p>}
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => { setMsg(null); void col.updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } }); }}>Reset to defaults</Button>
      <p className="mt-1 text-xs text-mute">Enter also shows the answer, and Space / Enter answers “Good” once the answer is visible.</p>
    </div>
  );
}

function Review() {
  const col = useCollection();
  const s = col.settings;
  return (
    <>
      <Section title="Answer buttons">
        <Field label="Buttons shown after the answer">
          <Segmented<2 | 4> label="Answer buttons" value={s.answer_buttons} onChange={(v) => void col.updateSettings({ answer_buttons: v })} options={[{ value: 4, label: 'Again · Hard · Good · Easy' }, { value: 2, label: 'Again · Good' }]} />
        </Field>
        <Switch label="Show next interval on buttons" checked={s.show_intervals} onChange={(v) => void col.updateSettings({ show_intervals: v })} />
        <Switch label="Show timer" description="Seconds spent on the current card" checked={s.show_timer} onChange={(v) => void col.updateSettings({ show_timer: v })} />
        <Switch label="Play audio automatically" checked={s.auto_play_audio} onChange={(v) => void col.updateSettings({ auto_play_audio: v })} />
      </Section>
      <Section title="Card display">
        <Field label={`Text size: ${s.card_font_size}px`}>
          <input type="range" min={14} max={40} value={s.card_font_size} onChange={(e) => void col.updateSettings({ card_font_size: Number(e.target.value) })} className="w-full accent-[rgb(var(--c-brand))]" aria-label="Card text size" />
        </Field>
        <Field label={`Maximum card width: ${s.card_max_width}px`}>
          <input type="range" min={360} max={1100} step={20} value={s.card_max_width} onChange={(e) => void col.updateSettings({ card_max_width: Number(e.target.value) })} className="w-full accent-[rgb(var(--c-brand))]" aria-label="Card width" />
        </Field>
        <div className="rounded-xl border border-line bg-raised p-4"><div className="card-face mx-auto text-center" style={{ fontSize: s.card_font_size, maxWidth: s.card_max_width }}>The quick brown fox jumps over the lazy dog</div></div>
        <Button size="sm" onClick={() => void col.updateSettings({ card_font_size: DEFAULT_SETTINGS.card_font_size, card_max_width: DEFAULT_SETTINGS.card_max_width })}>Reset display</Button>
      </Section>
      <Section title="Keyboard shortcuts" description="Used on the study screen"><ShortcutEditor /></Section>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ account
function Account() {
  const { account, mode, cloud, signOut, toast, confirm, store } = useApp();
  const auth = useAuth();
  const [name, setName] = useState(account?.name ?? '');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ field: string; msg: string } | null>(null);

  if (!cloud || !account || !supabase) {
    return (
      <Section title="Account">
        {auth.cloudConfigured ? (
          <>
            <p className="text-sm text-mute">You are using Mnemora <b>without an account</b>. Your data lives only in this browser. Sign in to back it up and sync it across devices.</p>
            <Button variant="primary" onClick={() => void signOut()}>Sign in or create an account</Button>
          </>
        ) : (
          <>
            <p className="text-sm text-mute"><b>Cloud accounts are not configured.</b> The app runs in local mode: everything is stored on this device only.</p>
            <p className="text-sm text-mute">To enable accounts and sync, create a Supabase project, run the SQL in <code className="kbd">supabase/migrations</code>, and set <code className="kbd">VITE_SUPABASE_URL</code> and <code className="kbd">VITE_SUPABASE_ANON_KEY</code> (see the README).</p>
          </>
        )}
      </Section>
    );
  }

  const wrap = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
    } catch {
      toast('error', 'Something went wrong. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const saveName = () => wrap('name', async () => {
    const n = name.trim();
    if (n.length < 1 || n.length > 60) return setErr({ field: 'name', msg: 'Enter a name between 1 and 60 characters.' });
    const { error } = await supabase!.auth.updateUser({ data: { display_name: n } });
    if (error) return setErr({ field: 'name', msg: 'Could not update your name.' });
    await supabase!.from('profiles').update({ display_name: n }).eq('id', account.id);
    toast('success', 'Profile updated');
  });

  const saveEmail = () => wrap('email', async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr({ field: 'email', msg: 'Enter a valid email address.' });
    const { error } = await supabase!.auth.updateUser({ email: email.trim() });
    if (error) return setErr({ field: 'email', msg: 'Could not change the email. It may already be in use.' });
    setEmail('');
    toast('success', 'Check both inboxes to confirm the change.');
  });

  const savePw = () => wrap('pw', async () => {
    if (pw.length < 8) return setErr({ field: 'pw', msg: 'Use at least 8 characters.' });
    if (pw !== pw2) return setErr({ field: 'pw', msg: 'The passwords do not match.' });
    const r = await auth.updatePassword(pw);
    if (r.error) return setErr({ field: 'pw', msg: r.error });
    setPw('');
    setPw2('');
    toast('success', 'Password updated');
  });

  const linkGoogle = () => wrap('google', async () => {
    const { error } = await supabase!.auth.linkIdentity({ provider: 'google' });
    if (error) toast('error', 'Could not connect Google. Manual linking may be disabled for this project.');
  });

  const deleteData = async () => {
    const ok = await confirm({ title: 'Delete all cloud data?', message: 'Removes every deck, card and review from the cloud and from this device. This cannot be undone. Your sign-in itself remains until you delete it in the dashboard.', confirmLabel: 'Delete everything', danger: true });
    if (!ok) return;
    const typed = window.prompt('Type DELETE to confirm');
    if (typed !== 'DELETE') return toast('info', 'Nothing was deleted.');
    await wrap('delete', async () => {
      const { error } = await supabase!.rpc('delete_my_data');
      if (error) return void toast('error', 'The server refused the request. Nothing was deleted.');
      await store.clear();
      toast('success', 'All data deleted');
      setTimeout(() => window.location.reload(), 600);
    });
  };

  const providers = account.providers.length ? account.providers : ['email'];

  return (
    <>
      <Section title="Profile">
        <Field label="Display name" error={err?.field === 'name' ? err.msg : null}>
          <div className="flex gap-2"><Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Display name" /><Button variant="primary" loading={busy === 'name'} onClick={() => void saveName()}>Save</Button></div>
        </Field>
        <Field label="Email" hint={account.emailConfirmed ? 'Verified' : 'Not verified yet — check your inbox'}>
          <div className="input flex items-center justify-between bg-raised"><span className="truncate">{account.email}</span>{account.emailConfirmed ? <Badge tone="review">Verified</Badge> : <Badge tone="learn">Unverified</Badge>}</div>
        </Field>
        <Field label="Change email" error={err?.field === 'email' ? err.msg : null}>
          <div className="flex gap-2"><Input type="email" autoComplete="email" placeholder="new@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="New email" /><Button loading={busy === 'email'} onClick={() => void saveEmail()} icon={<Mail className="h-4 w-4" />}>Update</Button></div>
        </Field>
      </Section>

      <Section title="Password">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New password"><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="New password" /></Field>
          <Field label="Repeat password"><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-label="Repeat password" /></Field>
        </div>
        {err?.field === 'pw' && <p role="alert" className="text-sm text-again">{err.msg}</p>}
        <Button loading={busy === 'pw'} onClick={() => void savePw()} icon={<Lock className="h-4 w-4" />}>Change password</Button>
      </Section>

      <Section title="Connected accounts">
        <ul className="divide-y divide-line">
          {['email', 'google'].map((p) => (
            <li key={p} className="flex items-center justify-between py-2.5 text-sm"><span className="capitalize">{p === 'email' ? 'Email & password' : 'Google'}</span>
              {providers.includes(p) ? <Badge tone="review">Connected</Badge> : p === 'google' ? <Button size="sm" loading={busy === 'google'} onClick={() => void linkGoogle()}>Connect</Button> : <Badge>Not set</Badge>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Session">
        <div className="flex flex-wrap gap-2"><Button onClick={() => void signOut()}>Sign out</Button><Button variant="danger" loading={busy === 'delete'} onClick={() => void deleteData()}>Delete all my data…</Button></div>
        <p className="text-xs text-mute">Signed in as {mode === 'cloud' ? account.email : 'local user'}. Deleting your sign-in itself requires a server-side function (see the README) because the browser must never hold admin rights.</p>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ data
function describe(table: string, row: unknown, col: ReturnType<typeof useCollection>): string {
  const r = (row ?? {}) as Record<string, unknown>;
  if (r.error) return `Server rejected it: ${String(r.error)}`;
  const strip = (h: unknown) => String(h ?? '').replace(/<[^>]*>/g, '').slice(0, 60);
  switch (table) {
    case 'decks': return `Deck “${strip(r.name)}”${r.deleted_at ? ' (deleted)' : ''}`;
    case 'notes': { const f = (r.fields ?? {}) as Record<string, unknown>; return `Note “${strip(Object.values(f)[0])}”${r.deleted_at ? ' (deleted)' : ''}`; }
    case 'cards': return `Card — ${String(r.reps ?? 0)} reviews${r.suspended ? ', suspended' : ''}${r.deleted_at ? ', deleted' : ''}${r.deck_id && col.decks.get(String(r.deck_id)) ? `, in ${col.deckPath(String(r.deck_id))}` : ''}`;
    case 'deck_options': return `Options preset “${strip(r.name)}”`;
    case 'card_templates': return `Note type “${strip(r.name)}”`;
    default: return table;
  }
}

function SyncPanel() {
  const { engine, toast, cloud } = useApp();
  const col = useCollection();
  const s = useSyncStatus();
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [integrity, setIntegrity] = useState<ReturnType<typeof engine.integrity> | null>(null);
  const refresh = useCallback(() => void engine.conflicts().then(setConflicts), [engine]);
  useEffect(refresh, [refresh, s.conflicts, s.lastSyncAt]);

  if (!cloud) return <Section title="Cloud sync"><p className="text-sm text-mute">Sync is off because you are not signed in to a cloud account. Everything is saved on this device.</p></Section>;

  return (
    <Section title="Cloud sync" description="Changes are saved on this device first and uploaded when you are online.">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={s.state === 'error' ? 'danger' : s.state === 'idle' ? 'review' : 'learn'}>{s.state}</Badge>
        <span className="text-mute">{s.pending} change{s.pending === 1 ? '' : 's'} waiting · {s.lastSyncAt ? `last sync ${formatRelativeDue(s.lastSyncAt).replace('overdue', 'ago')}` : 'never synced'}</span>
      </div>
      {s.error && <p role="alert" className="rounded-lg bg-again/10 px-3 py-2 text-sm text-again">{s.error}{s.retryInMs ? ` — retrying in ${Math.ceil(s.retryInMs / 1000)}s` : ''}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={s.state === 'syncing'} onClick={() => void engine.syncNow()} icon={<RefreshCw className="h-4 w-4" />}>Sync now</Button>
        <Button onClick={() => { const r = engine.integrity(); setIntegrity(r); toast(r.ok ? 'success' : 'error', r.ok ? 'Data integrity check passed' : 'Integrity problems found'); }} icon={<Shield className="h-4 w-4" />}>Check integrity</Button>
        <Button onClick={async () => { await engine.resetCursors(); toast('info', 'Re-downloading everything on the next sync'); void engine.syncNow(); }}>Full re-sync</Button>
      </div>
      {integrity && (integrity.ok ? <p className="text-sm text-good">All records are consistent.</p> : <ul className="list-disc pl-5 text-sm text-again">{integrity.issues.map((i) => <li key={i}>{i}</li>)}</ul>)}

      {conflicts.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Conflicts ({conflicts.length})</h3>
          <p className="text-xs text-mute">The same item changed on two devices. The newest edit was kept automatically; you can choose the other version. Review history is never overwritten.</p>
          <ul className="space-y-2">
            {conflicts.map((c) => (
              <li key={c.id} className="rounded-xl border border-line p-3 text-sm">
                <div className="mb-2 flex items-center justify-between gap-2"><span className="font-medium">{describe(c.table, c.local, col).split(',')[0]}</span><span className="text-xs text-mute">{new Date(c.detected_at).toLocaleString()}</span></div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className={cx('rounded-lg border p-2', c.auto_kept === 'local' ? 'border-brand bg-brand/5' : 'border-line')}><div className="text-xs font-semibold text-mute">This device {c.auto_kept === 'local' && '· kept'}</div><div>{describe(c.table, c.local, col)}</div></div>
                  <div className={cx('rounded-lg border p-2', c.auto_kept === 'remote' ? 'border-brand bg-brand/5' : 'border-line')}><div className="text-xs font-semibold text-mute">Cloud {c.auto_kept === 'remote' && '· kept'}</div><div>{describe(c.table, c.remote, col)}</div></div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void engine.resolveConflict(c.id, 'local').then(refresh)}>Use this device’s version</Button>
                  <Button size="sm" onClick={() => void engine.resolveConflict(c.id, 'remote').then(refresh)} disabled={Boolean((c.remote as Record<string, unknown>)?.error)}>Use cloud version</Button>
                  <Button size="sm" variant="ghost" onClick={() => void engine.resolveConflict(c.id, c.auto_kept).then(refresh)}>Dismiss</Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function DataTab() {
  const { store, confirm, toast, persistent } = useApp();
  const [usage, setUsage] = useState<{ used: number; quota: number; persisted: boolean } | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const est = await navigator.storage?.estimate?.();
        const persisted = (await navigator.storage?.persisted?.()) ?? false;
        if (est) setUsage({ used: est.usage ?? 0, quota: est.quota ?? 0, persisted });
      } catch { /* not available */ }
    })();
  }, []);
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

  const erase = async () => {
    const ok = await confirm({ title: 'Erase everything on this device?', message: 'Deletes the local copy of your collection. If you are signed in and synced, it will download again; otherwise it is gone. Download a backup first.', confirmLabel: 'Erase', danger: true });
    if (!ok) return;
    await store.clear();
    window.location.reload();
  };

  return (
    <>
      <Section title="Import, export & backup" description="Move cards in and out, or keep a full backup.">
        <div className="flex flex-wrap gap-2"><Link to="/data" className="btn btn-primary">Open Import / Export</Link></div>
      </Section>
      <SyncPanel />
      <Section title="Storage on this device">
        {!persistent && <p role="alert" className="rounded-lg bg-again/10 px-3 py-2 text-sm text-again">On-device storage is unavailable, so nothing is being saved. Export a backup before closing this tab.</p>}
        {usage && <p className="text-sm text-mute">{mb(usage.used)} used of about {mb(usage.quota)} available · {usage.persisted ? 'protected from automatic clean-up' : 'the browser may clear it if the device runs low on space'}</p>}
        <div className="flex flex-wrap gap-2">
          {usage && !usage.persisted && <Button onClick={async () => { const ok = await navigator.storage.persist(); toast(ok ? 'success' : 'info', ok ? 'Storage is now protected' : 'The browser declined; installing the app to your home screen usually helps.'); setUsage({ ...usage, persisted: ok }); }}>Protect my data</Button>}
          <Button variant="danger" onClick={() => void erase()}>Erase local data…</Button>
        </div>
      </Section>
      <Section title="Keyboard"><p className="flex items-center gap-2 text-sm text-mute"><Keyboard className="h-4 w-4" />Press <kbd className="kbd">?</kbd> anywhere to see all shortcuts.</p></Section>
      <span className="hidden"><Languages /><Bell /></span>
    </>
  );
}
