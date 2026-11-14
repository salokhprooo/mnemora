/**
 * All chart rendering lives here so the rest of the app never touches Recharts directly.
 * Colours come from the design tokens, so charts follow light / dark automatically.
 */
import type { ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DayStat, ForecastDay, GrowthPoint, HeatDay, IntervalBucket } from '../lib/stats';
import { cx } from './ui/primitives';

export const C = {
  again: 'rgb(var(--c-again))',
  hard: 'rgb(var(--c-hard))',
  good: 'rgb(var(--c-good))',
  easy: 'rgb(var(--c-easy))',
  brand: 'rgb(var(--c-brand))',
  newc: 'rgb(var(--c-new))',
  learn: 'rgb(var(--c-learn))',
  review: 'rgb(var(--c-review))',
  mute: 'rgb(var(--c-mute))',
  line: 'rgb(var(--c-line))',
};

const tooltipStyle = {
  background: 'rgb(var(--c-surface))',
  border: '1px solid rgb(var(--c-line))',
  borderRadius: 10,
  fontSize: 12,
  color: 'rgb(var(--c-ink))',
  boxShadow: '0 8px 24px rgb(var(--c-shadow) / 0.18)',
} as const;

const axis = { stroke: C.mute, fontSize: 11, tickLine: false, axisLine: false } as const;

export function ChartCard({ title, subtitle, children, empty, className }: { title: string; subtitle?: string; children: ReactNode; empty?: boolean; className?: string }) {
  return (
    <section className={cx('panel p-4', className)} aria-label={title}>
      <h3 className="font-sans text-sm font-semibold">{title}</h3>
      {subtitle && <p className="text-xs text-mute">{subtitle}</p>}
      <div className="mt-3 h-56">
        {empty ? <div className="flex h-full items-center justify-center rounded-lg bg-raised text-sm text-mute">No data for this selection yet</div> : children}
      </div>
    </section>
  );
}

const shortDate = (s: string) => {
  const [, m, d] = s.split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : s;
};

export function ReviewsChart({ data }: { data: { label: string; reviews: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tickFormatter={(v: string) => (v.length === 10 ? shortDate(v) : v)} {...axis} minTickGap={16} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(var(--c-ink) / 0.06)' }} formatter={(v: number) => [v, 'Reviews']} />
        <Bar dataKey="reviews" fill={C.brand} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function AnswersChart({ data }: { data: DayStat[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} {...axis} minTickGap={16} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(var(--c-ink) / 0.06)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="again" name="Again" stackId="a" fill={C.again} />
        <Bar dataKey="hard" name="Hard" stackId="a" fill={C.hard} />
        <Bar dataKey="good" name="Good" stackId="a" fill={C.good} />
        <Bar dataKey="easy" name="Easy" stackId="a" fill={C.easy} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ForecastChart({ data }: { data: ForecastDay[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} {...axis} minTickGap={16} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(var(--c-ink) / 0.06)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="learning" name="Learning" stackId="f" fill={C.learn} />
        <Bar dataKey="young" name="Young" stackId="f" fill={C.review} />
        <Bar dataKey="mature" name="Mature" stackId="f" fill={C.brand} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GrowthChart({ data }: { data: GrowthPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} {...axis} minTickGap={24} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [v, n === 'total' ? 'Total cards' : 'Added']} />
        <Area type="monotone" dataKey="total" stroke={C.newc} fill={C.newc} fillOpacity={0.18} strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function IntervalsChart({ data }: { data: IntervalBucket[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...axis} interval={0} tick={{ fontSize: 10 }} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(var(--c-ink) / 0.06)' }} formatter={(v: number) => [v, 'Cards']} />
        <Bar dataKey="count" fill={C.review} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function RatingDonut({ again, hard, good, easy }: { again: number; hard: number; good: number; easy: number }) {
  const data = [
    { name: 'Again', value: again, color: C.again },
    { name: 'Hard', value: hard, color: C.hard },
    { name: 'Good', value: good, color: C.good },
    { name: 'Easy', value: easy, color: C.easy },
  ];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="none">
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [`${Math.round(v * 1000) / 10}%`, n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

const LEVEL = ['bg-ink/[0.07]', 'bg-brand/25', 'bg-brand/45', 'bg-brand/70', 'bg-brand'];

/** GitHub-style activity grid: columns are weeks (Mon–Sun). */
export function Heatmap({ days }: { days: HeatDay[] }) {
  if (days.length === 0) return null;
  const first = new Date(days[0].date + 'T00:00:00');
  const lead = (first.getDay() + 6) % 7; // blanks before the first day so rows are weekdays
  const cells: (HeatDay | null)[] = [...Array(lead).fill(null), ...days];
  const weeks: (HeatDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return (
    <div className="overflow-x-auto pb-1" role="img" aria-label={`Study activity over the last ${days.length} days`}>
      <div className="inline-flex gap-[3px]">
        {weeks.map((w, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {w.map((d, di) =>
              d ? (
                <div key={di} className={cx('h-3 w-3 rounded-[3px]', LEVEL[d.level])} title={`${d.date}: ${d.count} review${d.count === 1 ? '' : 's'}`} />
              ) : (
                <div key={di} className="h-3 w-3" />
              ),
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 text-[11px] text-mute">
        Less
        {LEVEL.map((l) => (
          <span key={l} className={cx('h-3 w-3 rounded-[3px]', l)} />
        ))}
        More
      </div>
    </div>
  );
}
