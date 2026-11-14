/** Achievements are derived from real data on every render – nothing is stored, so they can never drift or be faked. */
export interface AchievementInput {
  totalReviews: number;
  longestStreak: number;
  currentStreak: number;
  cards: number;
  decks: number;
  matureCards: number;
  daysStudied: number;
  bestDayReviews: number;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  emoji: string;
  value: number;
  target: number;
  earned: boolean;
  /** 0..1 */
  progress: number;
}

interface Def {
  id: string;
  title: string;
  description: string;
  emoji: string;
  target: number;
  pick: (i: AchievementInput) => number;
}

const DEFS: Def[] = [
  { id: 'first-review', title: 'First steps', description: 'Answer your first card', emoji: '🌱', target: 1, pick: (i) => i.totalReviews },
  { id: 'reviews-100', title: 'Getting going', description: 'Answer 100 cards', emoji: '📚', target: 100, pick: (i) => i.totalReviews },
  { id: 'reviews-1000', title: 'Dedicated', description: 'Answer 1,000 cards', emoji: '🎯', target: 1000, pick: (i) => i.totalReviews },
  { id: 'reviews-10000', title: 'Memory master', description: 'Answer 10,000 cards', emoji: '🏆', target: 10000, pick: (i) => i.totalReviews },
  { id: 'streak-3', title: 'Warming up', description: 'Study 3 days in a row', emoji: '🔥', target: 3, pick: (i) => i.longestStreak },
  { id: 'streak-7', title: 'One full week', description: 'Study 7 days in a row', emoji: '📅', target: 7, pick: (i) => i.longestStreak },
  { id: 'streak-30', title: 'Habit formed', description: 'Study 30 days in a row', emoji: '🌟', target: 30, pick: (i) => i.longestStreak },
  { id: 'streak-100', title: 'Unstoppable', description: 'Study 100 days in a row', emoji: '💎', target: 100, pick: (i) => i.longestStreak },
  { id: 'cards-10', title: 'Collector', description: 'Create 10 cards', emoji: '🗂️', target: 10, pick: (i) => i.cards },
  { id: 'cards-100', title: 'Librarian', description: 'Create 100 cards', emoji: '📖', target: 100, pick: (i) => i.cards },
  { id: 'cards-1000', title: 'Archivist', description: 'Create 1,000 cards', emoji: '🏛️', target: 1000, pick: (i) => i.cards },
  { id: 'mature-1', title: 'It sticks', description: 'Get a card to a 21-day interval', emoji: '🧠', target: 1, pick: (i) => i.matureCards },
  { id: 'mature-100', title: 'Long-term memory', description: 'Have 100 mature cards', emoji: '🌳', target: 100, pick: (i) => i.matureCards },
  { id: 'decks-5', title: 'Organised', description: 'Keep 5 decks', emoji: '🧭', target: 5, pick: (i) => i.decks },
  { id: 'best-day-100', title: 'Power session', description: 'Answer 100 cards in one day', emoji: '⚡', target: 100, pick: (i) => i.bestDayReviews },
  { id: 'days-30', title: 'Showing up', description: 'Study on 30 different days', emoji: '🗓️', target: 30, pick: (i) => i.daysStudied },
];

export function computeAchievements(input: AchievementInput): Achievement[] {
  return DEFS.map((d) => {
    const value = Math.max(0, d.pick(input));
    return { id: d.id, title: d.title, description: d.description, emoji: d.emoji, value, target: d.target, earned: value >= d.target, progress: Math.min(1, value / d.target) };
  });
}
