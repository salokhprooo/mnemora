/**
 * FSRS-5 memory model (Free Spaced Repetition Scheduler), implemented from the
 * public algorithm specification:
 *   https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
 *
 * NOTE: this is an in-repo implementation (the package registry was not
 * reachable when the project was generated), not the `ts-fsrs` package. The
 * numerical behaviour is covered by tests/fsrs.test.ts. See README for how to
 * swap in `ts-fsrs` behind the same `FsrsEngine` surface if you prefer.
 *
 * Only the memory model lives here (difficulty, stability, retrievability,
 * intervals). Learning/relearning *steps* are handled in scheduler.ts.
 */

export const DEFAULT_PARAMS: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605,
  2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

export const PARAM_COUNT = DEFAULT_PARAMS.length; // 19

export const DECAY = -0.5;
export const FACTOR = 19 / 81; // chosen so that R(S, S) = 0.9

export const MIN_STABILITY = 0.01;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 10;

export type Grade = 1 | 2 | 3 | 4;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function validateParams(p: unknown): p is number[] {
  return Array.isArray(p) && p.length === PARAM_COUNT && p.every((x) => typeof x === 'number' && Number.isFinite(x));
}

export interface MemoryState {
  stability: number;
  difficulty: number;
}

export class Fsrs {
  readonly w: readonly number[];
  readonly requestRetention: number;
  readonly maximumInterval: number;

  constructor(opts: { params?: readonly number[] | null; requestRetention?: number; maximumInterval?: number } = {}) {
    this.w = opts.params && validateParams(opts.params) ? opts.params : DEFAULT_PARAMS;
    this.requestRetention = clamp(opts.requestRetention ?? 0.9, 0.7, 0.99);
    this.maximumInterval = Math.max(1, Math.floor(opts.maximumInterval ?? 36500));
  }

  /** Probability of recall after `elapsedDays` for a memory with stability `s`. */
  retrievability(elapsedDays: number, s: number): number {
    if (s <= 0) return 0;
    return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / s, DECAY);
  }

  /** Days until retrievability decays to `requestRetention`, rounded and clamped to [1, max]. */
  nextInterval(s: number, retention = this.requestRetention): number {
    const raw = (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
    return clamp(Math.round(raw), 1, this.maximumInterval);
  }

  initStability(g: Grade): number {
    return Math.max(this.w[g - 1], MIN_STABILITY);
  }

  initDifficulty(g: Grade): number {
    const w = this.w;
    return clamp(w[4] - Math.exp(w[5] * (g - 1)) + 1, MIN_DIFFICULTY, MAX_DIFFICULTY);
  }

  nextDifficulty(d: number, g: Grade): number {
    const w = this.w;
    const delta = -w[6] * (g - 3);
    // linear damping keeps D from saturating at 10
    const damped = d + (delta * (MAX_DIFFICULTY - d)) / 9;
    // mean reversion towards the "Easy" initial difficulty
    const reverted = w[7] * this.initDifficulty(4) + (1 - w[7]) * damped;
    return clamp(reverted, MIN_DIFFICULTY, MAX_DIFFICULTY);
  }

  /** Stability after a successful recall (Hard / Good / Easy) of a review-state card. */
  nextRecallStability(d: number, s: number, r: number, g: Grade): number {
    const w = this.w;
    const hardPenalty = g === 2 ? w[15] : 1;
    const easyBonus = g === 4 ? w[16] : 1;
    const gain =
      Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hardPenalty * easyBonus;
    return Math.max(s * (1 + gain), MIN_STABILITY);
  }

  /** Stability after a lapse (Again on a review-state card). Never exceeds the previous stability. */
  nextForgetStability(d: number, s: number, r: number): number {
    const w = this.w;
    const next = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
    return clamp(next, MIN_STABILITY, Math.max(s, MIN_STABILITY));
  }

  /** Stability update for reviews within the same day (learning / relearning steps). */
  nextShortTermStability(s: number, g: Grade): number {
    const w = this.w;
    return Math.max(s * Math.exp(w[17] * (g - 3 + w[18])), MIN_STABILITY);
  }

  /**
   * Apply one review to a memory state.
   * - `prev === null` → first ever review of the card.
   * - `elapsedDays < 1` → same-day review (short-term formula).
   */
  review(prev: MemoryState | null, elapsedDays: number, g: Grade): MemoryState {
    if (prev === null) {
      return { stability: this.initStability(g), difficulty: this.initDifficulty(g) };
    }
    const d = this.nextDifficulty(prev.difficulty, g);
    if (elapsedDays < 1) {
      return { stability: this.nextShortTermStability(prev.stability, g), difficulty: d };
    }
    const r = this.retrievability(elapsedDays, prev.stability);
    const s =
      g === 1
        ? this.nextForgetStability(prev.difficulty, prev.stability, r)
        : this.nextRecallStability(prev.difficulty, prev.stability, r, g);
    return { stability: s, difficulty: d };
  }
}

/** Formats a day count as a short label: "1d", "3mo", "1.2y". */
export function formatDays(days: number): string {
  if (days < 30) return `${Math.max(1, Math.round(days))}d`;
  if (days < 365) return `${Math.round((days / 30) * 10) / 10}mo`.replace('.0', '');
  return `${Math.round((days / 365) * 10) / 10}y`.replace('.0', '');
}

/** Formats a minute count: "<1m" … "10m", "1h", "1d". */
export function formatMinutes(minutes: number): string {
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 24) return `${Math.round((minutes / 60) * 10) / 10}h`.replace('.0', '');
  return formatDays(minutes / (60 * 24));
}
