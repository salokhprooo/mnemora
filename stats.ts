/**
 * Statistics. Pure functions over real cards/review logs — nothing here is sample data.
 * "Day" always means the scheduling day (rollover hour aware), keyed YYYY-MM-DD in local time.
 */
import type { Card, ReviewLog } from '../types';
import { CardState } from '../types';
import { isMature } from './scheduler';
import { MS_DAY, dayEnd, dayKey, dayStart } from './time';

export interface StatsFilter {
  /** Restrict to these deck ids (already expanded to sub-decks by the caller). null = all. */
  deckIds: Set<string> | null;
  /** Inclusive range of scheduling-day keys; undefined = unbounded. */
  from?: string;
  to?: string;
}

export interface StatsInput {
  cards: Card[];
  logs: ReviewLog[]; // already excludes undone
  now: Date;
  rolloverHour: number;
}

export interface DayStat {
  date: string;
  reviews: number;
  minutes: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  learned: number; // first review of a card (state New)
  relearned: number;
  review: number;
}

export function addDaysKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function keysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from, guard = 0; k <= to && guard < 4000; k = addDaysKey(k, 1), guard++) out.push(k);
  return out;
}

const emptyDay = (date: string): DayStat => ({ date, reviews: 0, minutes: 0, again: 0, hard: 0, good: 0, easy: 0, learned: 0, relearned: 0, review: 0 });

function inFilter(l: { deck_id: string }, f: StatsFilter): boolean {
  return !f.deckIds || f.deckIds.has(l.deck_id);
}

export function filterLogs(inp: StatsInput, f: StatsFilter): ReviewLog[] {
  return inp.logs.filter((l) => {
    if (!inFilter(l, f)) return false;
    if (f.from || f.to) {
      const k = dayKey(new Date(l.reviewed_at), inp.rolloverHour);
      if (f.from && k < f.from) return false;
      if (f.to && k > f.to) return false;
    }
    return true;
  });
}

export function filterCards(inp: StatsInput, f: StatsFilter): Card[] {
  return f.deckIds ? inp.cards.filter((c) => f.deckIds!.has(c.deck_id)) : inp.cards;
}

/** One entry per day in [from, to] (zero-filled). */
export function dailyStats(inp: StatsInput, f: StatsFilter, from: string, to: string): DayStat[] {
  const map = new Map<string, DayStat>();
  for (const k of keysBetween(from, to)) map.set(k, emptyDay(k));
  for (const l of inp.logs) {
    if (!inFilter(l, f)) continue;
    const k = dayKey(new Date(l.reviewed_at), inp.rolloverHour);
    const d = map.get(k);
    if (!d) continue;
    d.reviews++;
    d.minutes += l.duration_ms / 60_000;
    if (l.rating === 1) d.again++; else if (l.rating === 2) d.hard++; else if (l.rating === 3) d.good++; else d.easy++;
    if (l.state === CardState.New) d.learned++;
    else if (l.state === CardState.Relearning) d.relearned++;
    else if (l.state === CardState.Review) d.review++;
  }
  return [...map.values()];
}

export interface Summary {
  total: number;
  totalMinutes: number;
  avgSeconds: number;
  /** Fractions 0..1 (0 when there are no reviews). */
  againPct: number;
  hardPct: number;
  goodPct: number;
  easyPct: number;
  /** True retention: share of mature-state (Review) answers that were not "Again". null when no data. */
  retention: number | null;
  daysStudied: number;
}

export function summary(logs: ReviewLog[], rolloverHour: number): Summary {
  const total = logs.length;
  let ms = 0, a = 0, h = 0, g = 0, e = 0, revTotal = 0, revPass = 0;
  const days = new Set<string>();
  for (const l of logs) {
    ms += l.duration_ms;
    if (l.rating === 1) a++; else if (l.rating === 2) h++; else if (l.rating === 3) g++; else e++;
    if (l.state === CardState.Review) { revTotal++; if (l.rating > 1) revPass++; }
    days.add(dayKey(new Date(l.reviewed_at), rolloverHour));
  }
  return {
    total, totalMinutes: ms / 60_000, avgSeconds: total ? ms / total / 1000 : 0,
    againPct: total ? a / total : 0, hardPct: total ? h / total : 0, goodPct: total ? g / total : 0, easyPct: total ? e / total : 0,
    retention: revTotal ? revPass / revTotal : null, daysStudied: days.size,
  };
}

export interface CardCounts { total: number; new: number; learning: number; young: number; mature: number; suspended: number }

export function cardCounts(cards: Card[]): CardCounts {
  const c: CardCounts = { total: cards.length, new: 0, learning: 0, young: 0, mature: 0, suspended: 0 };
  for (const x of cards) {
    if (x.suspended) c.suspended++;
    if (x.state === CardState.New) c.new++;
    else if (x.state === CardState.Review) { if (isMature(x)) c.mature++; else c.young++; }
    else c.learning++;
  }
  return c;
}

export interface Streak { current: number; longest: number; studiedToday: boolean }

export function streak(logs: ReviewLog[], now: Date, rolloverHour: number): Streak {
  const days = new Set<string>();
  for (const l of logs) days.add(dayKey(new Date(l.reviewed_at), rolloverHour));
  const today = dayKey(now, rolloverHour);
  const studiedToday = days.has(today);
  // The streak is still alive if you studied yesterday but have not yet studied today.
  let cursor = studiedToday ? today : addDaysKey(today, -1);
  let current = 0;
  while (days.has(cursor)) { current++; cursor = addDaysKey(cursor, -1); }
  const sorted = [...days].sort();
  let longest = 0, run = 0, prev: string | null = null;
  for (const k of sorted) {
    run = prev && addDaysKey(prev, 1) === k ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = k;
  }
  return { current, longest, studiedToday };
}

export interface ForecastDay {
  date: string;
  offset: number;
  learning: number;
  young: number;
  mature: number;
  total: number;
  cumulative: number;
}

/** Reviews due on each of the next `days` days. Overdue cards and today's learning cards count towards day 0. */
export function forecast(cards: Card[], now: Date, rolloverHour: number, days: number): ForecastDay[] {
  const start = dayStart(now, rolloverHour).getTime();
  const out: ForecastDay[] = [];
  const startKey = dayKey(now, rolloverHour);
  for (let i = 0; i < days; i++) out.push({ date: addDaysKey(startKey, i), offset: i, learning: 0, young: 0, mature: 0, total: 0, cumulative: 0 });
  for (const c of cards) {
    if (c.suspended || c.state === CardState.New) continue;
    const due = new Date(c.due).getTime();
    const offset = Math.max(0, Math.floor((due - start) / MS_DAY));
    if (offset >= days) continue;
    const d = out[offset];
    if (c.state === CardState.Review) { if (isMature(c)) d.mature++; else d.young++; } else d.learning++;
    d.total++;
  }
  let cum = 0;
  for (const d of out) { cum += d.total; d.cumulative = cum; }
  return out;
}

export interface HeatDay { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }

/** Per-day review counts for the last `days` days with a 0–4 intensity level (quartiles of non-zero days). */
export function heatmap(inp: StatsInput, f: StatsFilter, days: number): HeatDay[] {
  const end = dayKey(inp.now, inp.rolloverHour);
  const start = addDaysKey(end, -(days - 1));
  const counts = new Map<string, number>();
  for (const l of inp.logs) {
    if (!inFilter(l, f)) continue;
    const k = dayKey(new Date(l.reviewed_at), inp.rolloverHour);
    if (k >= start && k <= end) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const nz = [...counts.values()].sort((a, b) => a - b);
  const q = (p: number) => (nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 0);
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  return keysBetween(start, end).map((date) => {
    const count = counts.get(date) ?? 0;
    const level = count === 0 ? 0 : count <= t1 ? 1 : count <= t2 ? 2 : count <= t3 ? 3 : 4;
    return { date, count, level: level as HeatDay['level'] };
  });
}

export interface GrowthPoint { date: string; added: number; total: number }

/** Cards created per day (cumulative total included) across [from, to]. */
export function cardGrowth(cards: Card[], rolloverHour: number, from: string, to: string): GrowthPoint[] {
  const per = new Map<string, number>();
  let before = 0;
  for (const c of cards) {
    const k = dayKey(new Date(c.created_at), rolloverHour);
    if (k < from) before++;
    else if (k <= to) per.set(k, (per.get(k) ?? 0) + 1);
  }
  let total = before;
  return keysBetween(from, to).map((date) => {
    const added = per.get(date) ?? 0;
    total += added;
    return { date, added, total };
  });
}

export interface IntervalBucket { label: string; count: number }

export function intervalHistogram(cards: Card[]): IntervalBucket[] {
  const edges: [string, number, number][] = [
    ['1d', 0, 1], ['2–3d', 2, 3], ['4–7d', 4, 7], ['1–2w', 8, 14], ['2–4w', 15, 30], ['1–3mo', 31, 90], ['3–6mo', 91, 180], ['6–12mo', 181, 365], ['1y+', 366, Infinity],
  ];
  const b = edges.map(([label]) => ({ label, count: 0 }));
  for (const c of cards) {
    if (c.state !== CardState.Review) continue;
    const i = edges.findIndex(([, lo, hi]) => c.scheduled_days >= lo && c.scheduled_days <= hi);
    if (i >= 0) b[i].count++;
  }
  return b;
}

export interface PeriodTotals { today: number; week: number; month: number; year: number; allTime: number }

export function periodTotals(inp: StatsInput, f: StatsFilter): PeriodTotals {
  const today = dayKey(inp.now, inp.rolloverHour);
  const w = addDaysKey(today, -6), m = addDaysKey(today, -29), y = addDaysKey(today, -364);
  const t: PeriodTotals = { today: 0, week: 0, month: 0, year: 0, allTime: 0 };
  for (const l of inp.logs) {
    if (!inFilter(l, f)) continue;
    const k = dayKey(new Date(l.reviewed_at), inp.rolloverHour);
    t.allTime++;
    if (k >= y) t.year++;
    if (k >= m) t.month++;
    if (k >= w) t.week++;
    if (k === today) t.today++;
  }
  return t;
}

/** Reviews today (scheduling day) for the daily-goal ring. */
export function reviewsToday(logs: ReviewLog[], now: Date, rolloverHour: number): number {
  const s = dayStart(now, rolloverHour).toISOString();
  const e = dayEnd(now, rolloverHour).toISOString();
  let n = 0;
  for (const l of logs) if (l.reviewed_at >= s && l.reviewed_at < e) n++;
  return n;
}

/** Group daily stats into ISO-ish weeks / months / years for the "weekly / monthly / yearly" charts. */
export function groupStats(days: DayStat[], by: 'week' | 'month' | 'year'): { label: string; reviews: number; minutes: number }[] {
  const m = new Map<string, { label: string; reviews: number; minutes: number }>();
  for (const d of days) {
    let key: string;
    if (by === 'year') key = d.date.slice(0, 4);
    else if (by === 'month') key = d.date.slice(0, 7);
    else {
      const [y, mo, da] = d.date.split('-').map(Number);
      const dt = new Date(y, mo - 1, da);
      const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7));
      key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    }
    const e = m.get(key) ?? { label: key, reviews: 0, minutes: 0 };
    e.reviews += d.reviews;
    e.minutes += d.minutes;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
}
