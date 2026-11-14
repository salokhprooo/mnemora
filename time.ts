/** Date helpers. All persisted timestamps are UTC ISO strings; "days" are local scheduling days. */

export const MS_MINUTE = 60_000;
export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;

export const toISO = (d: Date): string => d.toISOString();
export const nowISO = (): string => new Date().toISOString();
export const addMinutes = (d: Date, m: number): Date => new Date(d.getTime() + m * MS_MINUTE);
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * MS_DAY);

/**
 * Start of the current scheduling day: the most recent local `rolloverHour`:00.
 * With rolloverHour = 4, 02:30 on the 6th still belongs to the day that began 04:00 on the 5th.
 */
export function dayStart(now: Date, rolloverHour = 4): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), rolloverHour, 0, 0, 0);
  if (now.getTime() < d.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/** Exclusive end of the current scheduling day (start of the next one). */
export function dayEnd(now: Date, rolloverHour = 4): Date {
  const d = dayStart(now, rolloverHour);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Local calendar key (YYYY-MM-DD) of the scheduling day a timestamp belongs to. */
export function dayKey(d: Date, rolloverHour = 4): string {
  const s = dayStart(d, rolloverHour);
  const y = s.getFullYear();
  const m = String(s.getMonth() + 1).padStart(2, '0');
  const day = String(s.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Integer count of scheduling days since 1970 (local), used for whole-day elapsed maths. */
export function dayNumber(d: Date, rolloverHour = 4): number {
  const s = dayStart(d, rolloverHour);
  return Math.round(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate()) / MS_DAY);
}

/** Whole scheduling days between two instants (0 = same scheduling day). */
export function elapsedDays(from: Date | string | null, to: Date, rolloverHour = 4): number {
  if (!from) return 0;
  const f = typeof from === 'string' ? new Date(from) : from;
  return Math.max(0, dayNumber(to, rolloverHour) - dayNumber(f, rolloverHour));
}

export function startOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatRelativeDue(iso: string, now = new Date()): string {
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const label =
    abs < MS_HOUR
      ? `${Math.max(1, Math.round(abs / MS_MINUTE))}m`
      : abs < MS_DAY
        ? `${Math.round(abs / MS_HOUR)}h`
        : `${Math.round(abs / MS_DAY)}d`;
  return diff <= 0 ? `${label} overdue` : `in ${label}`;
}
