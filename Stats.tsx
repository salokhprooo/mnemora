import { useMemo, useState } from 'react';
import { useCollection } from '../store/app';
import { navigate, useQueryParam } from '../lib/router';
import {
  addDaysKey, cardCounts, cardGrowth, dailyStats, filterCards, filterLogs, forecast, groupStats, heatmap, intervalHistogram, periodTotals, streak, summary,
  type StatsFilter, type StatsInput,
} from '../lib/stats';
import { dayKey, formatDuration } from '../lib/time';
import { AnswersChart, ChartCard, ForecastChart, GrowthChart, Heatmap, IntervalsChart, RatingDonut, ReviewsChart } from '../components/charts';
import { EmptyState, PageHeader, Segmented, Select, Stat } from '../components/ui/primitives';
import { BarChart3 } from '../components/ui/icons';

type Range = '7' | '30' | '90' | '365' | 'all';
type Group = 'day' | 'week' | 'month' | 'year';

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export default function Stats() {
  const col = useCollection();
  const deckParam = useQueryParam('deck') ?? '';
  const [range, setRange] = useState<Range>('30');
  const [group, setGroup] = useState<Group>('day');
  const rollover = col.settings.rollover_hour;
  const deckId = deckParam && col.decks.get(deckParam) && !col.decks.get(deckParam)!.deleted_at ? deckParam : '';

  const data = useMemo(() => {
    const now = col.now();
    const today = dayKey(now, rollover);
    const filter: StatsFilter = { deckIds: deckId ? col.subtreeIds(deckId) : null };
    const inp: StatsInput = { cards: col.liveCards(), logs: col.liveLogs(), now, rolloverHour: rollover };
    const allLogs = filterLogs(inp, filter);
    // first activity day (for "All time" ranges)
    const firstKey = allLogs.length ? dayKey(new Date(allLogs.reduce((m, l) => (l.reviewed_at < m ? l.reviewed_at : m), allLogs[0].reviewed_at)), rollover) : today;
    const days = range === 'all' ? 0 : Number(range);
    const from = range === 'all' ? firstKey : addDaysKey(today, -(days - 1));
    const ranged: StatsFilter = { ...filter, from, to: today };
    const rangedLogs = filterLogs(inp, ranged);
    const daily = dailyStats(inp, filter, from, today);
    const cards = filterCards(inp, filter);
    return {
      today, from,
      sum: summary(rangedLogs, rollover),
      totals: periodTotals(inp, filter),
      daily,
      grouped: group === 'day' ? daily.map((d) => ({ label: d.date, reviews: d.reviews, minutes: d.minutes })) : groupStats(daily, group),
      counts: cardCounts(cards),
      forecast: forecast(cards, now, rollover, 30),
      heat: heatmap(inp, filter, 182),
      growth: cardGrowth(cards, rollover, range === 'all' ? (cards.length ? dayKey(new Date(cards.reduce((m, c) => (c.created_at < m ? c.created_at : m), cards[0].created_at)), rollover) : today) : from, today),
      intervals: intervalHistogram(cards),
      streak: streak(allLogs, now, rollover),
      empty: allLogs.length === 0,
      reviewsInRange: rangedLogs.length,
    };
  }, [col, col.version, deckId, range, group, rollover]);

  const decks = col.liveDecks().sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id)));
  const { sum, totals, counts } = data;

  return (
    <div>
      <PageHeader
        title="Statistics"
        subtitle={deckId ? col.deckPath(deckId) : 'All decks'}
        actions={
          <>
            <Select aria-label="Deck" value={deckId} onChange={(e) => navigate(e.target.value ? `/stats?deck=${e.target.value}` : '/stats')} className="min-w-[10rem]">
              <option value="">All decks</option>
              {decks.map((d) => <option key={d.id} value={d.id}>{col.deckPath(d.id)}</option>)}
            </Select>
            <Segmented<Range> label="Date range" value={range} onChange={setRange} options={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: '365', label: '1y' }, { value: 'all', label: 'All' }]} />
          </>
        }
      />

      {data.empty && counts.total === 0 ? (
        <div className="panel"><EmptyState icon={<BarChart3 />} title="Nothing to chart yet" body="Statistics appear as soon as you add cards and review them." /></div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Reviews today" value={totals.today} hint={`${totals.week} this week`} />
            <Stat label="This month" value={totals.month.toLocaleString()} hint={`${totals.year.toLocaleString()} this year`} />
            <Stat label="Total reviews" value={totals.allTime.toLocaleString()} hint={`${sum.daysStudied} days studied in range`} />
            <Stat label="Streak" value={`${data.streak.current}d`} hint={`Longest ${data.streak.longest}d`} />
            <Stat label="Retention" value={sum.retention === null ? '–' : pct(sum.retention)} hint="Review cards answered not-Again" />
            <Stat label="Avg. time / card" value={sum.total ? `${sum.avgSeconds.toFixed(1)}s` : '–'} hint="In selected range" />
            <Stat label="Study time" value={sum.total ? formatDuration(sum.totalMinutes * 60_000) : '0s'} hint="In selected range" />
            <Stat label="Cards" value={counts.total.toLocaleString()} hint={`${counts.suspended} suspended`} />
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="New" value={counts.new.toLocaleString()} tone="new" />
            <Stat label="Learning" value={counts.learning.toLocaleString()} tone="learn" />
            <Stat label="Young" value={counts.young.toLocaleString()} tone="review" hint="interval < 21 days" />
            <Stat label="Mature" value={counts.mature.toLocaleString()} tone="review" hint="interval ≥ 21 days" />
            <Stat label="Answered Again" value={sum.total ? pct(sum.againPct) : '–'} hint={sum.total ? `Hard ${pct(sum.hardPct)} · Good ${pct(sum.goodPct)} · Easy ${pct(sum.easyPct)}` : undefined} />
          </div>

          <ChartCard
            title="Reviews"
            subtitle={`${data.reviewsInRange.toLocaleString()} in range`}
            empty={data.reviewsInRange === 0}
            className="relative"
          >
            <ReviewsChart data={data.grouped} />
          </ChartCard>
          <div className="-mt-2 flex justify-end">
            <Segmented<Group> label="Group reviews by" value={group} onChange={setGroup} options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }]} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Answer buttons" subtitle="Share of Again / Hard / Good / Easy" empty={sum.total === 0}>
              <RatingDonut again={sum.againPct} hard={sum.hardPct} good={sum.goodPct} easy={sum.easyPct} />
            </ChartCard>
            <ChartCard title="Answers per day" empty={data.reviewsInRange === 0}>
              <AnswersChart data={data.daily} />
            </ChartCard>
            <ChartCard title="Upcoming reviews" subtitle="Next 30 days (overdue counted today)" empty={data.forecast.every((d) => d.total === 0)}>
              <ForecastChart data={data.forecast} />
            </ChartCard>
            <ChartCard title="Card growth" subtitle="Total cards over time" empty={counts.total === 0}>
              <GrowthChart data={data.growth} />
            </ChartCard>
            <ChartCard title="Review intervals" subtitle="Cards by current interval" empty={data.intervals.every((b) => b.count === 0)} className="lg:col-span-2">
              <IntervalsChart data={data.intervals} />
            </ChartCard>
          </div>

          <section className="panel p-4" aria-label="Activity">
            <h3 className="font-sans text-sm font-semibold">Daily activity</h3>
            <p className="mb-3 text-xs text-mute">Last 6 months</p>
            <Heatmap days={data.heat} />
          </section>
        </div>
      )}
    </div>
  );
}
