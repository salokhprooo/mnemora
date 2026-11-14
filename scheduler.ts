/**
 * Card scheduler: Anki-style learning / relearning steps on top of the FSRS memory model.
 *
 *   New ──Again/Hard/Good──▶ Learning ──(last step passed | Easy)──▶ Review
 *   Review ──Again──▶ Relearning ──(last step passed | Easy)──▶ Review
 *   Review ──Hard/Good/Easy──▶ Review (interval from FSRS)
 *
 * Pure functions only: callers persist the result.
 */
import type { Card, CardStateValue, ISODate, RatingValue } from '../types';
import { CardState, Rating } from '../types';
import { Fsrs, formatDays, formatMinutes, type Grade, type MemoryState } from './fsrs';
import { MS_DAY, MS_MINUTE, addDays, addMinutes, elapsedDays } from './time';

export interface SchedulerOptions {
  learningSteps: number[]; // minutes
  relearningSteps: number[]; // minutes
  desiredRetention: number;
  maximumInterval: number;
  params: number[] | null;
  rolloverHour: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  learningSteps: [1, 10],
  relearningSteps: [10],
  desiredRetention: 0.9,
  maximumInterval: 36500,
  params: null,
  rolloverHour: 4,
};

export type SchedulingFields = Pick<
  Card,
  'state' | 'due' | 'stability' | 'difficulty' | 'scheduled_days' | 'step' | 'reps' | 'lapses' | 'last_review'
>;

export interface SchedulingResult {
  card: SchedulingFields;
  /** Whole scheduling days since the previous review (0 for same-day / first review). */
  elapsed_days: number;
  /** Delay until the card is due again, in minutes. */
  interval_minutes: number;
  /** Human label for the answer button, e.g. "10m", "3d", "2.5mo". */
  label: string;
}

export function schedulingFields(c: Card): SchedulingFields {
  return {
    state: c.state,
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    scheduled_days: c.scheduled_days,
    step: c.step,
    reps: c.reps,
    lapses: c.lapses,
    last_review: c.last_review,
  };
}

export function newCardFields(now: Date): SchedulingFields {
  return {
    state: CardState.New,
    due: now.toISOString(),
    stability: 0,
    difficulty: 0,
    scheduled_days: 0,
    step: 0,
    reps: 0,
    lapses: 0,
    last_review: null,
  };
}

function labelFor(minutes: number): string {
  return minutes < 60 * 24 ? formatMinutes(minutes) : formatDays(minutes / (60 * 24));
}

/** Delay for "Hard" while in a step list (Anki semantics). */
function hardDelay(steps: number[], step: number): number {
  if (step === 0) return steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[0] * 1.5;
  return steps[Math.min(step, steps.length - 1)];
}

type Memo = MemoryState;

interface Ctx {
  card: Card | SchedulingFields;
  now: Date;
  opts: SchedulerOptions;
  fsrs: Fsrs;
}

function memoryAfter(ctx: Ctx, g: Grade): { memo: Memo; elapsed: number } {
  const c = ctx.card;
  const isFirst = c.state === CardState.New;
  const elapsed = isFirst ? 0 : elapsedDays(c.last_review, ctx.now, ctx.opts.rolloverHour);
  const prev: Memo | null = isFirst ? null : { stability: c.stability, difficulty: c.difficulty };
  return { memo: ctx.fsrs.review(prev, elapsed, g), elapsed };
}

function build(
  ctx: Ctx,
  rating: RatingValue,
  state: CardStateValue,
  step: number,
  memo: Memo,
  delayMinutes: number,
  scheduledDays: number,
  lapsesDelta: number,
  elapsed: number,
): SchedulingResult {
  const due: Date = scheduledDays > 0 ? addDays(ctx.now, scheduledDays) : addMinutes(ctx.now, delayMinutes);
  const minutes = scheduledDays > 0 ? scheduledDays * (MS_DAY / MS_MINUTE) : delayMinutes;
  return {
    card: {
      state,
      due: due.toISOString() as ISODate,
      stability: memo.stability,
      difficulty: memo.difficulty,
      scheduled_days: scheduledDays,
      step,
      reps: ctx.card.reps + 1,
      lapses: ctx.card.lapses + lapsesDelta,
      last_review: ctx.now.toISOString(),
    },
    elapsed_days: elapsed,
    interval_minutes: minutes,
    label: scheduledDays > 0 ? formatDays(scheduledDays) : labelFor(delayMinutes),
  };
}

/** Intervals in days for graduating from (re)learning, honouring Hard ≤ Good ≤ Easy ordering. */
function graduationInterval(ctx: Ctx, rating: RatingValue): { memo: Memo; elapsed: number; days: number } {
  const { memo, elapsed } = memoryAfter(ctx, rating as Grade);
  let days = ctx.fsrs.nextInterval(memo.stability);
  if (rating === Rating.Easy) {
    const good = memoryAfter(ctx, Rating.Good as Grade);
    days = Math.max(days, ctx.fsrs.nextInterval(good.memo.stability) + 1);
  }
  return { memo, elapsed, days: Math.min(days, ctx.opts.maximumInterval) };
}

function scheduleLearningLike(ctx: Ctx, rating: RatingValue, steps: number[], relearning: boolean): SchedulingResult {
  const c = ctx.card;
  const learnState: CardStateValue = relearning ? CardState.Relearning : CardState.Learning;
  const step = c.state === CardState.New ? 0 : Math.min(c.step, Math.max(0, steps.length - 1));
  const lapsesDelta = 0;

  const graduate = (): SchedulingResult => {
    const g = graduationInterval(ctx, rating);
    return build(ctx, rating, CardState.Review, 0, g.memo, 0, g.days, lapsesDelta, g.elapsed);
  };

  if (steps.length === 0) return graduate();
  if (rating === Rating.Easy) return graduate();

  const { memo, elapsed } = memoryAfter(ctx, rating as Grade);

  if (rating === Rating.Again) {
    return build(ctx, rating, learnState, 0, memo, steps[0], 0, lapsesDelta, elapsed);
  }
  if (rating === Rating.Hard) {
    return build(ctx, rating, learnState, step, memo, hardDelay(steps, step), 0, lapsesDelta, elapsed);
  }
  // Good
  if (step + 1 < steps.length) {
    return build(ctx, rating, learnState, step + 1, memo, steps[step + 1], 0, lapsesDelta, elapsed);
  }
  return graduate();
}

function scheduleReview(ctx: Ctx, rating: RatingValue): SchedulingResult {
  const { fsrs, opts } = ctx;
  const hard = memoryAfter(ctx, Rating.Hard);
  const good = memoryAfter(ctx, Rating.Good);
  const easy = memoryAfter(ctx, Rating.Easy);
  const again = memoryAfter(ctx, Rating.Again);

  let hardDays = fsrs.nextInterval(hard.memo.stability);
  let goodDays = fsrs.nextInterval(good.memo.stability);
  let easyDays = fsrs.nextInterval(easy.memo.stability);
  // Strict ordering so the four buttons never collapse onto the same interval.
  hardDays = Math.min(hardDays, goodDays);
  goodDays = Math.max(goodDays, hardDays + 1);
  easyDays = Math.max(easyDays, goodDays + 1);
  const max = opts.maximumInterval;
  hardDays = Math.min(hardDays, max);
  goodDays = Math.min(goodDays, max);
  easyDays = Math.min(easyDays, max);

  switch (rating) {
    case Rating.Again: {
      const steps = opts.relearningSteps;
      if (steps.length === 0) {
        const days = Math.min(fsrs.nextInterval(again.memo.stability), max);
        return build(ctx, rating, CardState.Review, 0, again.memo, 0, days, 1, again.elapsed);
      }
      return build(ctx, rating, CardState.Relearning, 0, again.memo, steps[0], 0, 1, again.elapsed);
    }
    case Rating.Hard:
      return build(ctx, rating, CardState.Review, 0, hard.memo, 0, hardDays, 0, hard.elapsed);
    case Rating.Good:
      return build(ctx, rating, CardState.Review, 0, good.memo, 0, goodDays, 0, good.elapsed);
    default:
      return build(ctx, rating, CardState.Review, 0, easy.memo, 0, easyDays, 0, easy.elapsed);
  }
}

export function makeFsrs(opts: SchedulerOptions): Fsrs {
  return new Fsrs({ params: opts.params, requestRetention: opts.desiredRetention, maximumInterval: opts.maximumInterval });
}

/** Compute the next scheduling state of `card` if answered with `rating` at `now`. */
export function schedule(
  card: Card | SchedulingFields,
  rating: RatingValue,
  now: Date,
  opts: SchedulerOptions = DEFAULT_SCHEDULER_OPTIONS,
): SchedulingResult {
  const ctx: Ctx = { card, now, opts, fsrs: makeFsrs(opts) };
  switch (card.state) {
    case CardState.New:
    case CardState.Learning:
      return scheduleLearningLike(ctx, rating, opts.learningSteps, false);
    case CardState.Relearning:
      return scheduleLearningLike(ctx, rating, opts.relearningSteps, true);
    default:
      return scheduleReview(ctx, rating);
  }
}

export type SchedulePreview = Record<RatingValue, SchedulingResult>;

/** Results for all four answer buttons (used to display the next interval on each). */
export function previewAll(
  card: Card | SchedulingFields,
  now: Date,
  opts: SchedulerOptions = DEFAULT_SCHEDULER_OPTIONS,
): SchedulePreview {
  return {
    1: schedule(card, 1, now, opts),
    2: schedule(card, 2, now, opts),
    3: schedule(card, 3, now, opts),
    4: schedule(card, 4, now, opts),
  };
}

/** Current retrievability of a card at `now` (0 for new cards). */
export function currentRetrievability(card: Card, now: Date, opts: SchedulerOptions = DEFAULT_SCHEDULER_OPTIONS): number {
  if (card.state === CardState.New || !card.last_review) return 0;
  const fsrs = makeFsrs(opts);
  return fsrs.retrievability(elapsedDays(card.last_review, now, opts.rolloverHour), card.stability);
}

/** Mature = interval of 21+ days (Anki convention). */
export const MATURE_DAYS = 21;
export const isMature = (c: Pick<Card, 'state' | 'scheduled_days'>): boolean =>
  c.state === CardState.Review && c.scheduled_days >= MATURE_DAYS;
