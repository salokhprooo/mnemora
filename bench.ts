/** Performance check: `npm run bench`. Builds a 50k-card collection in memory and times hot paths. */
import { Collection } from '../src/db/collection';
import { MemoryPersistence } from '../src/db/persistence';
import { Rating } from '../src/types';

const N = Number(process.env.CARDS ?? 50_000);
const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
  const t = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - t).toFixed(1).padStart(9)} ms`);
  return r;
};

const col = await Collection.open(new MemoryPersistence(), 'bench');
const decks = [];
for (let i = 0; i < 20; i++) decks.push(await col.createDeck(`Deck ${i}`));
const typeId = col.builtinTypeId('basic');
await time(`add ${N} notes`, async () => {
  for (let i = 0; i < N; i++) {
    await col.addNote({ typeId, deckId: decks[i % 20].id, fields: { Front: `question ${i} alpha${i % 97}`, Back: `answer ${i}` }, tags: [`t${i % 50}`] });
  }
});
console.log(`cards: ${col.totalCounts().total}`);
await time('totalCounts (cold)', () => col.totalCounts());
await time('deckCounts (memoised)', () => col.deckCounts());
await time('buildQueue(all decks)', () => col.buildQueue(null));
await time('search "alpha5"', () => col.searchCards('alpha5').length);
await time('search tag:t7 deck:"Deck 3"', () => col.searchCards('tag:t7 deck:"Deck 3"').length);
await time('globalSearch "question 4"', () => col.globalSearch('question 4'));

const q = col.buildQueue(null);
await time('20 × (nextCard + answerCard)', async () => {
  for (let i = 0; i < 20; i++) {
    const { card } = col.nextCard(q);
    if (!card) break;
    await col.answerCard(card.id, Rating.Good, 3000);
  }
});
await time('buildQueue after answers', () => col.buildQueue(null));
