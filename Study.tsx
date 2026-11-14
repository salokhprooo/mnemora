import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCollection, useT } from '../store/app';
import { navigate, useQueryParam } from '../lib/router';
import { CardState, Rating, type Card, type RatingValue } from '../types';
import { FlipCard, mcqOptions } from '../components/cards/CardView';
import { NoteEditor } from '../components/cards/NoteEditor';
import { Modal } from '../components/ui/Modal';
import { Button, EmptyState, IconButton, ProgressBar, Select, cx } from '../components/ui/primitives';
import { Check, Clock, Eye, GraduationCap, Pencil, Undo2, X } from '../components/ui/icons';
import { formatDuration } from '../lib/time';

const RATINGS: { value: RatingValue; label: string; tone: string; key: 'again' | 'hard' | 'good' | 'easy' }[] = [
  { value: Rating.Again, label: 'Again', tone: 'text-again border-again/40 hover:bg-again/10', key: 'again' },
  { value: Rating.Hard, label: 'Hard', tone: 'text-hard border-hard/40 hover:bg-hard/10', key: 'hard' },
  { value: Rating.Good, label: 'Good', tone: 'text-good border-good/40 hover:bg-good/10', key: 'good' },
  { value: Rating.Easy, label: 'Easy', tone: 'text-easy border-easy/40 hover:bg-easy/10', key: 'easy' },
];

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function Study() {
  const { toast } = useApp();
  const t = useT();
  const col = useCollection();
  const deckParam = useQueryParam('deck');
  const deckId = deckParam && col.decks.get(deckParam) && !col.decks.get(deckParam)!.deleted_at ? deckParam : null;
  const settings = col.settings;

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [waitingUntil, setWaitingUntil] = useState<Date | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState({ answered: 0, ms: 0, again: 0 });
  const shownAt = useRef(Date.now());

  const queue = useMemo(() => col.buildQueue(deckId), [col, col.version, deckId, waitingUntil]);
  const card: Card | null = currentId ? (col.cards.get(currentId) ?? null) : null;
  const cardValid = card !== null && !card.deleted_at && !card.suspended;
  const item = cardValid && card ? col.queueItem(card) : null;

  const pickNext = useCallback(() => {
    const q = col.buildQueue(deckId);
    const { card: next, waitingUntil: w } = col.nextCard(q);
    setCurrentId(next?.id ?? null);
    setWaitingUntil(next ? null : w);
    setRevealed(false);
    setPicked(null);
    shownAt.current = Date.now();
  }, [col, deckId]);

  // First card, deck switch, or the shown card vanished (deleted / suspended / synced away).
  useEffect(() => {
    if (currentId === null || !cardValid) pickNext();
  }, [deckId, currentId, cardValid, pickNext]);
  // Switching deck restarts the session. (Skipped on mount: resetting then would undo the first pick above.)
  const lastDeck = useRef(deckId);
  useEffect(() => {
    if (lastDeck.current === deckId) return;
    lastDeck.current = deckId;
    setSession({ answered: 0, ms: 0, again: 0 });
    pickNext();
  }, [deckId, pickNext]);

  // When only a not-yet-due learning card remains, wake up as soon as it is due.
  useEffect(() => {
    if (!waitingUntil) return;
    const t = setTimeout(pickNext, Math.max(500, waitingUntil.getTime() - Date.now() + 200));
    return () => clearTimeout(t);
  }, [waitingUntil, pickNext]);

  const tick = useNow(1000);
  const elapsed = Math.max(0, Math.round((tick - shownAt.current) / 1000));

  const preview = useMemo(() => (card && cardValid ? col.preview(card) : null), [col, card, cardValid, col.version]);

  const reveal = useCallback(() => {
    if (!cardValid) return;
    setRevealed(true);
  }, [cardValid]);

  const answer = useCallback(
    async (rating: RatingValue) => {
      if (!card || !cardValid || busy || !revealed) return;
      setBusy(true);
      try {
        const ms = Date.now() - shownAt.current;
        await col.answerCard(card.id, rating, ms);
        setSession((s) => ({ answered: s.answered + 1, ms: s.ms + Math.min(ms, 120_000), again: s.again + (rating === Rating.Again ? 1 : 0) }));
        pickNext();
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'Could not save the answer');
      } finally {
        setBusy(false);
      }
    },
    [card, cardValid, busy, revealed, col, pickNext, toast],
  );

  const undo = useCallback(async () => {
    if (!col.canUndo) return;
    const restored = await col.undoLastAnswer();
    if (restored) {
      setSession((s) => ({ ...s, answered: Math.max(0, s.answered - 1) }));
      setCurrentId(restored.id);
      setWaitingUntil(null);
      setRevealed(false);
      setPicked(null);
      shownAt.current = Date.now();
      toast('info', 'Answer undone');
    }
  }, [col, toast]);

  // Keyboard: shortcuts come from Settings → Review.
  useEffect(() => {
    const sc = settings.shortcuts;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (editing || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'Escape') {
        navigate('/decks');
        return;
      }
      if (k === sc.undo.toLowerCase()) {
        e.preventDefault();
        void undo();
        return;
      }
      if (!card || !item) return;
      const isMcq = item.type.kind === 'multiple_choice';
      if (!revealed) {
        if (isMcq && /^[1-4]$/.test(k)) {
          const n = Number(k) - 1;
          if (n < mcqOptions(item.note, `${card.id}:${card.reps}`).length) {
            e.preventDefault();
            setPicked(n);
            setRevealed(true);
          }
          return;
        }
        if (k === sc.showAnswer.toLowerCase() || k === 'Enter' || k === ' ') {
          e.preventDefault();
          if (!isMcq) reveal();
        }
        return;
      }
      if (e.repeat) return;
      const map: Record<string, RatingValue> = { [sc.again]: 1, [sc.hard]: 2, [sc.good]: 3, [sc.easy]: 4 };
      if (settings.answer_buttons === 2) {
        delete map[sc.hard];
        delete map[sc.easy];
      }
      const r = map[k] ?? (k === ' ' || k === 'Enter' ? (3 as RatingValue) : undefined);
      if (r) {
        e.preventDefault();
        void answer(r);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settings.shortcuts, settings.answer_buttons, card, item, revealed, reveal, answer, undo, editing]);

  const deckName = deckId ? col.deckPath(deckId) : 'All decks';
  const total = queue.counts.new + queue.counts.learning + queue.counts.review;
  const done = session.answered;
  const stateOf = card?.state;
  const decks = col.liveDecks().sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id)));

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg md:static md:z-auto md:-mx-8 md:-my-8 md:min-h-dvh">
      {/* top bar */}
      <div className="safe-top border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-3 py-2.5">
          <IconButton label="Exit study (Esc)" onClick={() => navigate('/decks')}>
            <X className="h-5 w-5" />
          </IconButton>
          <Select aria-label="Deck" className="max-w-[12rem] py-1.5 sm:max-w-xs" value={deckId ?? ''} onChange={(e) => navigate(e.target.value ? `/study?deck=${e.target.value}` : '/study')}>
            <option value="">All decks</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {col.deckPath(d.id)}
              </option>
            ))}
          </Select>
          <div className="ml-auto flex items-center gap-3 text-sm font-semibold tabular-nums" aria-label="Cards remaining">
            <span className={cx('text-newc', stateOf === CardState.New && 'underline decoration-2 underline-offset-4')} title="New">{queue.counts.new}</span>
            <span className={cx('text-learnc', (stateOf === CardState.Learning || stateOf === CardState.Relearning) && 'underline decoration-2 underline-offset-4')} title="Learning">{queue.counts.learning}</span>
            <span className={cx('text-reviewc', stateOf === CardState.Review && 'underline decoration-2 underline-offset-4')} title="To review">{queue.counts.review}</span>
          </div>
          {settings.show_timer && card && (
            <span className="hidden items-center gap-1 text-xs tabular-nums text-mute sm:flex" title="Time on this card">
              <Clock className="h-3.5 w-3.5" />
              {elapsed}s
            </span>
          )}
          <IconButton label="Undo (Z)" onClick={() => void undo()} disabled={!col.canUndo}>
            <Undo2 className="h-5 w-5" />
          </IconButton>
          <IconButton label="Edit this card" onClick={() => setEditing(true)} disabled={!card}>
            <Pencil className="h-5 w-5" />
          </IconButton>
        </div>
        <ProgressBar value={done} max={done + total} label="Session progress" />
      </div>

      {/* card area */}
      <div className="mx-auto flex w-full max-w-4xl min-h-0 flex-1 flex-col justify-center overflow-y-auto px-3 py-5">
        {item && card ? (
          <>
            <div className="mb-2 flex items-center justify-between px-1 text-xs text-mute">
              <span className="truncate">{deckName}</span>
              <span>
                {card.state === CardState.New ? 'New' : card.state === CardState.Review ? 'Review' : 'Learning'}
              </span>
            </div>
            <FlipCard
              card={card}
              note={item.note}
              type={item.type}
              revealed={revealed}
              fontSize={settings.card_font_size}
              maxWidth={settings.card_max_width}
              autoPlay={settings.auto_play_audio}
              picked={picked}
              onPick={(i) => {
                setPicked(i);
                setRevealed(true);
              }}
              onTapFront={reveal}
            />
          </>
        ) : waitingUntil ? (
          <WaitingScreen until={waitingUntil} onNow={pickNext} session={session} />
        ) : (
          <FinishedScreen session={session} hasCards={col.liveCards().length > 0} deckId={deckId} />
        )}
      </div>

      {/* answer bar */}
      {item && card && (
        <div className="safe-bottom border-t border-line bg-surface/90 backdrop-blur">
          <div className="mx-auto max-w-2xl px-3 py-3">
            {!revealed ? (
              item.type.kind === 'multiple_choice' ? (
                <p className="py-3 text-center text-sm text-mute">{t('study.chooseAnswer')}</p>
              ) : (
                <Button variant="primary" size="lg" className="w-full" onClick={reveal} icon={<Eye className="h-5 w-5" />}>
                  {t('study.showAnswer')} <span className="kbd ml-1 !border-white/30 !bg-white/15 !text-inherit">Space</span>
                </Button>
              )
            ) : (
              <div className={cx('grid gap-2', settings.answer_buttons === 2 ? 'grid-cols-2' : 'grid-cols-4')}>
                {RATINGS.filter((r) => settings.answer_buttons === 4 || r.value === Rating.Again || r.value === Rating.Good).map((r) => (
                  <button
                    key={r.value}
                    disabled={busy}
                    onClick={() => void answer(r.value)}
                    className={cx('flex flex-col items-center rounded-xl border bg-surface px-1 py-2.5 transition active:scale-95 disabled:opacity-60 sm:py-3', r.tone)}
                    aria-label={`${r.label}${settings.show_intervals && preview ? `, next review in ${preview[r.value].label}` : ''}`}
                  >
                    {settings.show_intervals && preview && <span className="text-[11px] font-medium tabular-nums opacity-80">{preview[r.value].label}</span>}
                    <span className="text-sm font-semibold sm:text-base">{t('study.' + r.key)}</span>
                    <span className="kbd mt-1 hidden sm:inline-flex">{settings.shortcuts[r.key]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal open={editing && !!card} onClose={() => setEditing(false)} title="Edit card" size="lg">
        {card && <NoteEditor noteId={card.note_id} onDone={() => setEditing(false)} />}
      </Modal>
    </div>
  );
}

function WaitingScreen({ until, onNow, session }: { until: Date; onNow: () => void; session: { answered: number } }) {
  const now = useNow(1000);
  const left = Math.max(0, until.getTime() - now);
  return (
    <EmptyState
      icon={<Clock />}
      title="Nothing to show right now"
      body={`The next learning card is ready in ${formatDuration(left)}. You answered ${session.answered} card${session.answered === 1 ? '' : 's'} this session.`}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={onNow}>
            Check again
          </Button>
          <Button onClick={() => navigate('/decks')}>Back to decks</Button>
        </div>
      }
    />
  );
}

function FinishedScreen({ session, hasCards, deckId }: { session: { answered: number; ms: number; again: number }; hasCards: boolean; deckId: string | null }) {
  const col = useCollection();
  const retention = session.answered > 0 ? Math.round(((session.answered - session.again) / session.answered) * 100) : null;
  if (!hasCards) {
    return <EmptyState icon={<GraduationCap />} title="No cards yet" body="Create your first card to start studying." action={<Button variant="primary" onClick={() => navigate('/add')}>Add a card</Button>} />;
  }
  // Next due review, for a helpful "come back" hint.
  const next = col
    .liveCards()
    .filter((c) => !c.suspended && c.state !== CardState.New && (!deckId || col.subtreeIds(deckId).has(c.deck_id)))
    .map((c) => c.due)
    .sort()[0];
  return (
    <div className="mx-auto max-w-md text-center">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-good/15 text-good">
        <Check className="h-9 w-9" />
      </div>
      <h2 className="text-2xl font-semibold">{session.answered > 0 ? 'Session complete' : 'All caught up'}</h2>
      <p className="mt-1 text-mute">{session.answered > 0 ? 'Nice work — everything due is done.' : 'There is nothing due in this deck today.'}</p>
      {session.answered > 0 && (
        <dl className="mt-6 grid grid-cols-3 gap-2 text-center">
          <div className="panel p-3"><dt className="text-xs text-mute">Cards</dt><dd className="font-display text-xl font-semibold tabular-nums">{session.answered}</dd></div>
          <div className="panel p-3"><dt className="text-xs text-mute">Time</dt><dd className="font-display text-xl font-semibold tabular-nums">{formatDuration(session.ms)}</dd></div>
          <div className="panel p-3"><dt className="text-xs text-mute">Correct</dt><dd className="font-display text-xl font-semibold tabular-nums">{retention}%</dd></div>
        </dl>
      )}
      {next && <p className="mt-5 text-sm text-mute">Next card due {new Date(next).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => navigate('/decks')}>Back to decks</Button>
        <Button onClick={() => navigate('/add')}>Add cards</Button>
      </div>
    </div>
  );
}
