import { useMemo, useState } from 'react';
import { useApp, useCollection } from '../store/app';
import { navigate, Link } from '../lib/router';
import { CollectionError } from '../db/collection';
import { addDaysKey, cardCounts, dailyStats, filterLogs, forecast, reviewsToday, streak, summary, type StatsFilter, type StatsInput } from '../lib/stats';
import { computeAchievements } from '../lib/achievements';
import { dayKey, formatDuration } from '../lib/time';
import { ChartCard, ForecastChart, Heatmap, ReviewsChart } from '../components/charts';
import { heatmap } from '../lib/stats';
import { Button, EmptyState, Field, PageHeader, ProgressBar, Segmented, Select, Stat, Textarea, cx } from '../components/ui/primitives';
import { ArrowRight, Flame, GraduationCap, PlusCircle, Trophy, Clock, Folder } from '../components/ui/icons';

function Ring({ value, max, label }: { value: number; max: number; label: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="relative h-28 w-28 shrink-0" role="img" aria-label={`${label}: ${value} of ${max}`}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgb(var(--c-ink) / 0.1)" strokeWidth="9" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgb(var(--c-brand))" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: 'stroke-dashoffset .6s ease' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-2xl font-semibold tabular-nums leading-none">{value}</span>
        <span className="text-[11px] text-mute">of {max}</span>
      </div>
    </div>
  );
}

function QuickAdd() {
  const { toast } = useApp();
  const col = useCollection();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [deckId, setDeckId] = useState(() => {
    try {
      const last = localStorage.getItem('mnemora.lastDeck');
      return last && col.decks.get(last) && !col.decks.get(last)!.deleted_at ? last : col.defaultDeckId;
    } catch {
      return col.defaultDeckId;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decks = col.liveDecks().sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id)));

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
      const fields = { Front: esc(front.trim()), Back: esc(back.trim()) };
      const type = col.types.get(col.builtinTypeId('basic'))!;
      col.validateNote(type, fields);
      await col.addNote({ typeId: type.id, deckId, fields });
      try { localStorage.setItem('mnemora.lastDeck', deckId); } catch { /* ignore */ }
      setFront('');
      setBack('');
      toast('success', `Added to ${col.deckPath(deckId)}`);
    } catch (e) {
      setError(e instanceof CollectionError ? e.message : 'Could not add the card');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Quick add card">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Quick add</h2>
        <Link to="/add" className="text-xs font-medium text-brand hover:underline">More card types →</Link>
      </div>
      <Field label="Front"><Textarea aria-label="Front" rows={2} value={front} onChange={(e) => { setFront(e.target.value); setError(null); }} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submit(); }} /></Field>
      <Field label="Back"><Textarea aria-label="Back" rows={2} value={back} onChange={(e) => { setBack(e.target.value); setError(null); }} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submit(); }} /></Field>
      <div className="flex gap-2">
        <Select aria-label="Deck" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          {decks.map((d) => <option key={d.id} value={d.id}>{col.deckPath(d.id)}</option>)}
        </Select>
        <Button type="submit" variant="primary" loading={busy} icon={<PlusCircle className="h-4 w-4" />}>Add</Button>
      </div>
      {error && <p role="alert" className="text-sm text-again">{error}</p>}
    </form>
  );
}

export default function Home() {
  const { account, mode } = useApp();
  const col = useCollection();
  const [range, setRange] = useState<'7' | '30'>('7');
  const rollover = col.settings.rollover_hour;

  const d = useMemo(() => {
    const now = col.now();
    const today = dayKey(now, rollover);
    const cards = col.liveCards();
    const logs = col.liveLogs();
    const filter: StatsFilter = { deckIds: null };
    const inp: StatsInput = { cards, logs, now, rolloverHour: rollover };
    const counts = cardCounts(cards);
    const total = col.totalCounts();
    const from30 = addDaysKey(today, -29);
    const daily30 = dailyStats(inp, filter, from30, today);
    const sum30 = summary(filterLogs(inp, { ...filter, from: from30, to: today }), rollover);
    const sumAll = summary(logs, rollover);
    const st = streak(logs, now, rollover);
    const best = Math.max(0, ...dailyStats(inp, filter, addDaysKey(today, -364), today).map((x) => x.reviews));
    // recent decks: by last review, then by creation
    const lastByDeck = new Map<string, string>();
    for (const l of logs) if ((lastByDeck.get(l.deck_id) ?? '') < l.reviewed_at) lastByDeck.set(l.deck_id, l.reviewed_at);
    const recent = col.liveDecks()
      .map((dk) => ({ dk, at: lastByDeck.get(dk.id) ?? '' , created: dk.created_at }))
      .filter((x) => (col.deckCounts().get(x.dk.id)?.total ?? 0) > 0 || x.at)
      .sort((a, b) => (b.at || b.created).localeCompare(a.at || a.created))
      .slice(0, 4);
    // recent activity: per-day review summaries + recently added cards
    const activity = daily30.filter((x) => x.reviews > 0).slice(-5).reverse();
    const added = [...col.notes.values()].filter((n) => !n.deleted_at).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3);
    return {
      today, counts, total, daily30, sum30, sumAll, st, recent, activity, added,
      doneToday: reviewsToday(logs, now, rollover),
      forecast: forecast(cards, now, rollover, 14),
      heat: heatmap(inp, filter, 98),
      achievements: computeAchievements({
        totalReviews: logs.length, longestStreak: st.longest, currentStreak: st.current, cards: cards.length, decks: col.liveDecks().length,
        matureCards: counts.mature, daysStudied: sumAll.daysStudied, bestDayReviews: best,
      }),
    };
  }, [col, col.version, rollover]);

  const dueNow = d.total.due + d.total.new;
  const week = d.daily30.slice(-7).map((x) => ({ label: x.date, reviews: x.reviews }));
  const month = d.daily30.map((x) => ({ label: x.date, reviews: x.reviews }));
  const name = mode === 'cloud' && account ? account.name.split(' ')[0] : null;
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const goal = col.settings.daily_goal;
  const earned = d.achievements.filter((a) => a.earned);
  const next = d.achievements.filter((a) => !a.earned).sort((a, b) => b.progress - a.progress).slice(0, 3);

  if (d.counts.total === 0 && col.liveDecks().length <= 1) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={`${greet}${name ? `, ${name}` : ''}`} subtitle="Welcome to Mnemora" />
        <div className="panel">
          <EmptyState
            icon={<GraduationCap />}
            title="Let’s make your first flashcard"
            body="Spaced repetition shows each card right before you would forget it. Add a few cards, then study — the scheduler (FSRS) does the rest."
            action={<div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={() => navigate('/add')} icon={<PlusCircle className="h-4 w-4" />}>Add a card</Button><Button onClick={() => navigate('/data')}>Import cards</Button></div>}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title={`${greet}${name ? `, ${name}` : ''}`} subtitle={col.now().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        {/* continue */}
        <section className="panel flex flex-col gap-5 p-5 sm:flex-row sm:items-center" aria-label="Continue studying">
          <Ring value={d.doneToday} max={Math.max(1, goal)} label="Daily goal" />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{dueNow > 0 ? `${dueNow} card${dueNow === 1 ? '' : 's'} ready to study` : 'You’re all caught up'}</h2>
            <p className="mt-0.5 text-sm text-mute">
              {dueNow > 0 ? (
                <>
                  <span className="font-semibold text-newc">{d.total.new} new</span> · <span className="font-semibold text-learnc">{d.total.learning} learning</span> · <span className="font-semibold text-reviewc">{d.total.review} to review</span>
                </>
              ) : d.doneToday >= goal ? 'Daily goal reached — nice work.' : `Nothing due right now. ${Math.max(0, goal - d.doneToday)} more reviews to hit today’s goal.`}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" size="lg" onClick={() => navigate('/study')} icon={<GraduationCap className="h-5 w-5" />} disabled={dueNow === 0}>
                {d.doneToday > 0 ? 'Continue studying' : 'Start studying'}
              </Button>
              <Button size="lg" onClick={() => navigate('/decks')}>Choose a deck</Button>
            </div>
          </div>
        </section>
        <QuickAdd />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total cards" value={d.counts.total.toLocaleString()} />
        <Stat label="Decks" value={col.liveDecks().length} />
        <Stat label="New" value={d.counts.new.toLocaleString()} tone="new" />
        <Stat label="Learning" value={d.counts.learning.toLocaleString()} tone="learn" />
        <Stat label="Review" value={(d.counts.young + d.counts.mature).toLocaleString()} tone="review" />
        <Stat label="Mature" value={d.counts.mature.toLocaleString()} tone="review" hint="interval ≥ 21d" />
        <Stat label="Due today" value={d.total.due} hint="reviews + learning" />
        <Stat label="Streak" value={<span className="inline-flex items-center gap-1.5"><Flame className={cx('h-5 w-5', d.st.current > 0 ? 'text-learnc' : 'text-mute')} />{d.st.current}d</span>} hint={`Longest ${d.st.longest}d`} />
        <Stat label="Study time" value={d.sumAll.total ? formatDuration(d.sumAll.totalMinutes * 60_000) : '0s'} hint="All time" />
        <Stat label="Retention" value={d.sum30.retention === null ? '–' : `${Math.round(d.sum30.retention * 100)}%`} hint="Last 30 days" />
        <Stat label="Today" value={d.doneToday} hint="reviews" />
        <Stat label="Last 30 days" value={d.daily30.reduce((s, x) => s + x.reviews, 0).toLocaleString()} hint="reviews" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <ChartCard title="Study activity" subtitle={range === '7' ? 'Last 7 days' : 'Last 30 days'} empty={(range === '7' ? week : month).every((x) => x.reviews === 0)}>
            <ReviewsChart data={range === '7' ? week : month} />
          </ChartCard>
          <div className="mt-2 flex justify-end"><Segmented<'7' | '30'> label="Range" value={range} onChange={setRange} options={[{ value: '7', label: 'Week' }, { value: '30', label: 'Month' }]} /></div>
        </div>
        <ChartCard title="Upcoming reviews" subtitle="Next 14 days" empty={d.forecast.every((x) => x.total === 0)}>
          <ForecastChart data={d.forecast} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-4" aria-label="Recent decks">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-base font-semibold">Recent decks</h2><Link to="/decks" className="text-xs font-medium text-brand hover:underline">All decks →</Link></div>
          {d.recent.length === 0 ? <p className="py-6 text-center text-sm text-mute">Decks you study will show up here.</p> : (
            <ul className="divide-y divide-line">
              {d.recent.map(({ dk }) => {
                const c = col.deckCounts().get(dk.id);
                return (
                  <li key={dk.id} className="flex items-center gap-3 py-2.5">
                    <Folder className="h-4 w-4 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{col.deckPath(dk.id)}</div>
                      <div className="text-xs text-mute tabular-nums"><span className="text-newc">{c?.new ?? 0}</span> · <span className="text-learnc">{c?.learning ?? 0}</span> · <span className="text-reviewc">{c?.review ?? 0}</span> · {c?.total ?? 0} cards</div>
                    </div>
                    <Button size="sm" onClick={() => navigate(`/study?deck=${dk.id}`)} icon={<ArrowRight className="h-3.5 w-3.5" />}>Study</Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel p-4" aria-label="Recent activity">
          <h2 className="mb-3 text-base font-semibold">Recent activity</h2>
          {d.activity.length === 0 && d.added.length === 0 ? <p className="py-6 text-center text-sm text-mute">Your reviews and new cards will be listed here.</p> : (
            <ul className="divide-y divide-line text-sm">
              {d.activity.map((a) => (
                <li key={a.date} className="flex items-center gap-3 py-2.5">
                  <Clock className="h-4 w-4 shrink-0 text-mute" />
                  <span className="flex-1">{a.date === d.today ? 'Today' : new Date(a.date + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                  <span className="tabular-nums text-mute">{a.reviews} review{a.reviews === 1 ? '' : 's'} · {Math.max(1, Math.round(a.minutes))} min</span>
                </li>
              ))}
              {d.added.map((n) => (
                <li key={n.id} className="flex items-center gap-3 py-2.5">
                  <PlusCircle className="h-4 w-4 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1 truncate">Added “{(n.fields[col.types.get(n.template_id)?.fields[0] ?? ''] ?? '').replace(/<[^>]*>/g, '').slice(0, 60) || 'card'}”</span>
                  <span className="shrink-0 text-xs text-mute">{new Date(n.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-4" aria-label="Activity heatmap">
          <h2 className="mb-3 text-base font-semibold">Consistency</h2>
          <Heatmap days={d.heat} />
        </section>
        <section className="panel p-4" aria-label="Achievements">
          <div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 text-base font-semibold"><Trophy className="h-4 w-4 text-learnc" />Achievements</h2><span className="text-xs text-mute">{earned.length} / {d.achievements.length}</span></div>
          {earned.length > 0 && <div className="mb-3 flex flex-wrap gap-1.5">{earned.map((a) => <span key={a.id} title={`${a.title}: ${a.description}`} className="chip !bg-learnc/10 !text-learnc">{a.emoji} {a.title}</span>)}</div>}
          <ul className="space-y-2.5">
            {next.map((a) => (
              <li key={a.id}>
                <div className="flex items-center justify-between text-sm"><span>{a.emoji} {a.title}<span className="ml-1.5 text-xs text-mute">{a.description}</span></span><span className="text-xs tabular-nums text-mute">{Math.min(a.value, a.target).toLocaleString()} / {a.target.toLocaleString()}</span></div>
                <ProgressBar value={a.progress * 100} label={a.title} />
              </li>
            ))}
            {next.length === 0 && <li className="text-sm text-mute">You’ve earned every achievement. Legend.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
