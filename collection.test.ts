import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, CollectionError } from '../src/db/collection';
import { MemoryPersistence } from '../src/db/persistence';
import { clozeNumbers, renderCloze } from '../src/lib/cloze';
import { renderCard } from '../src/lib/render';
import { CardState, Rating } from '../src/types';

const T0 = new Date('2026-03-10T09:00:00');
async function fresh(userId = 'u1') {
  let now = new Date(T0);
  const col = await Collection.open(new MemoryPersistence(), userId, () => now);
  return { col, setNow: (d: Date) => (now = d), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}
const basic = (c: Collection) => c.builtinTypeId('basic');
const addBasic = (c: Collection, deckId: string, f = 'front', b = 'back', tags: string[] = []) =>
  c.addNote({ typeId: basic(c), deckId, fields: { Front: f, Back: b }, tags });
const rejects = (p: Promise<unknown>, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof CollectionError && (!re || re.test(e.message)));

// ------------------------------------------------------------------------------------------ cloze / render
test('cloze numbers, rendering of front/back, hints', () => {
  const t = 'The {{c1::heart}} pumps {{c2::blood::fluid}} and {{c1::more}}';
  assert.deepEqual(clozeNumbers(t), [1, 2]);
  assert.equal(renderCloze(t, 1, 'front'), 'The <span class="cloze cloze-hidden">[…]</span> pumps blood and <span class="cloze cloze-hidden">[…]</span>');
  assert.equal(renderCloze(t, 2, 'front'), 'The heart pumps <span class="cloze cloze-hidden">[fluid]</span> and more');
  assert.equal(renderCloze(t, 2, 'back'), 'The heart pumps <span class="cloze">blood</span> and more');
  assert.deepEqual(clozeNumbers('no clozes {{c0::x}}'), []);
});

test('render: FrontSide, conditionals, text:, escaping of Tags', async () => {
  const { col } = await fresh();
  const t = col.types.get(basic(col))!;
  const r = renderCard({ fields: { Front: 'Q', Back: 'A' }, tags: ['a<b'] }, t, 0);
  assert.equal(r.front, 'Q');
  assert.equal(r.back, 'Q<hr id="answer">A');
  const opt = col.types.get(col.builtinTypeId('basic_optional_reversed'))!;
  assert.equal(renderCard({ fields: { Front: 'F', Back: 'B', 'Add Reverse': '' }, tags: [] }, opt, 1).front, '');
  assert.equal(renderCard({ fields: { Front: 'F', Back: 'B', 'Add Reverse': 'y' }, tags: [] }, opt, 1).front, 'B');
  const custom = { kind: 'custom' as const, css: '', templates: [{ name: 'c', front: '{{text:Front}} {{Tags}}', back: '' }] };
  assert.equal(renderCard({ fields: { Front: '<b>x</b>' }, tags: ['a<b'] }, custom, 0).front, 'x a&lt;b');
});

// ------------------------------------------------------------------------------------------ seeding & persistence
test('opening seeds default deck, built-in note types, options and settings (deterministic ids)', async () => {
  const { col } = await fresh();
  assert.equal(col.liveDecks().length, 1);
  assert.equal(col.liveDecks()[0].name, 'Default');
  assert.equal(col.liveTypes().length, 8);
  assert.ok(col.options.has(col.defaultOptionsId));
  assert.equal(col.settings.theme, 'system');
  const { col: col2 } = await fresh();
  assert.equal(col.defaultDeckId, col2.defaultDeckId, 'same user → same ids on every device');
  const { col: other } = await fresh('someone-else');
  assert.notEqual(col.defaultDeckId, other.defaultDeckId, 'different users never collide');
});

test('data persists through reload and mutations are queued in the outbox', async () => {
  const p = new MemoryPersistence();
  const a = await Collection.open(p, 'u1', () => T0);
  await addBasic(a, a.defaultDeckId, 'persist me', 'ok');
  const ob = await p.outboxAll();
  assert.ok(ob.some((e) => e.table === 'notes') && ob.some((e) => e.table === 'cards'));
  const b = await Collection.open(p, 'u1', () => T0);
  assert.equal(b.liveCards().length, 1);
  assert.equal([...b.notes.values()][0].fields.Front, 'persist me');
});

// ------------------------------------------------------------------------------------------ decks
test('create / nested / rename / move / delete decks with validation', async () => {
  const { col } = await fresh();
  const a = await col.createDeck('Languages');
  const b = await col.createDeck('Spanish', a.id);
  assert.equal(col.deckPath(b.id), 'Languages::Spanish');
  await rejects(col.createDeck('  '), /empty/);
  await rejects(col.createDeck('languages'), /already exists/);
  const deep = await col.createDeck('Science::Physics::Optics');
  assert.equal(col.deckPath(deep.id), 'Science::Physics::Optics');
  assert.equal(col.findDeckByPath('science::physics')?.name, 'Physics');
  await col.renameDeck(b.id, 'Español');
  assert.equal(col.deckPath(b.id), 'Languages::Español');
  await rejects(col.moveDeck(a.id, b.id), /into itself/);
  await col.moveDeck(b.id, null);
  assert.equal(col.deckPath(b.id), 'Español');
  assert.equal(col.deckTree().length, 4); // Default, Languages, Español, Science
});

test('deleting a deck removes sub-decks and cards but keeps review history; always one deck remains', async () => {
  const { col } = await fresh();
  const d = await col.createDeck('Temp::Child');
  await addBasic(col, d.id);
  const card = col.liveCards()[0];
  await col.answerCard(card.id, Rating.Good, 1500);
  const removed = await col.deleteDeck(col.findDeckByPath('Temp')!.id);
  assert.equal(removed, 1);
  assert.equal(col.liveCards().length, 0);
  assert.equal(col.logs.size, 1, 'history kept');
  assert.equal(col.findDeckByPath('Temp'), undefined);
  for (const dk of col.liveDecks()) await col.deleteDeck(dk.id);
  assert.equal(col.liveDecks().length, 1, 'a Default deck is recreated');
});

test('duplicate deck copies notes + cards with fresh scheduling', async () => {
  const { col } = await fresh();
  const d = await col.createDeck('Orig');
  await addBasic(col, d.id, 'a', 'b');
  await col.answerCard(col.liveCards()[0].id, Rating.Easy, 1000);
  const copy = await col.duplicateDeck(d.id);
  assert.equal(copy.name, 'Orig (copy)');
  const copied = col.liveCards().filter((c) => c.deck_id === copy.id);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].state, CardState.New);
  assert.notEqual(copied[0].note_id, col.liveCards().find((c) => c.deck_id === d.id)!.note_id);
});

// ------------------------------------------------------------------------------------------ notes / cards
test('card counts per note type', async () => {
  const { col } = await fresh();
  const d = col.defaultDeckId;
  const rev = await col.addNote({ typeId: col.builtinTypeId('basic_reversed'), deckId: d, fields: { Front: 'a', Back: 'b' } });
  assert.equal(rev.cards.length, 2);
  const opt1 = await col.addNote({ typeId: col.builtinTypeId('basic_optional_reversed'), deckId: d, fields: { Front: 'a', Back: 'b' } });
  assert.equal(opt1.cards.length, 1);
  const opt2 = await col.addNote({ typeId: col.builtinTypeId('basic_optional_reversed'), deckId: d, fields: { Front: 'a2', Back: 'b2', 'Add Reverse': 'y' } });
  assert.equal(opt2.cards.length, 2);
  const cl = await col.addNote({ typeId: col.builtinTypeId('cloze'), deckId: d, fields: { Text: '{{c1::a}} {{c2::b}} {{c3::c}}' } });
  assert.deepEqual(cl.cards.map((c) => c.ord).sort(), [1, 2, 3]);
  const mc = await col.addNote({ typeId: col.builtinTypeId('multiple_choice'), deckId: d, fields: { Question: 'q', Correct: 'y', 'Wrong 1': 'n' } });
  assert.equal(mc.cards.length, 1);
  const io = await col.addNote({
    typeId: col.builtinTypeId('image_occlusion'), deckId: d,
    fields: { Image: '<img src="media:abc.png">', Occlusions: JSON.stringify([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }]) },
  });
  assert.equal(io.cards.length, 2);
});

test('validation: empty fields, no cloze, MCQ without wrong option, bad tags, oversized field', async () => {
  const { col } = await fresh();
  const d = col.defaultDeckId;
  await rejects(addBasic(col, d, '', 'x'), /cannot be empty/);
  await rejects(addBasic(col, d, '<p><br></p>', 'x'), /cannot be empty/);
  await rejects(addBasic(col, d, 'x', ''), /Back/);
  await rejects(col.addNote({ typeId: col.builtinTypeId('cloze'), deckId: d, fields: { Text: 'nothing here' } }), /cloze/);
  await rejects(col.addNote({ typeId: col.builtinTypeId('multiple_choice'), deckId: d, fields: { Question: 'q', Correct: 'a' } }), /wrong/i);
  await rejects(col.addNote({ typeId: col.builtinTypeId('image_occlusion'), deckId: d, fields: { Image: 'no image', Occlusions: '[]' } }), /image/i);
  await rejects(addBasic(col, d, 'q', 'a', ['bad<tag']), /unsupported/);
  await rejects(addBasic(col, d, 'x'.repeat(200_001), 'a'), /too long/);
  await rejects(col.addNote({ typeId: basic(col), deckId: 'nope', fields: { Front: 'a', Back: 'b' } }), /Deck not found/);
  assert.equal(col.liveCards().length, 0, 'nothing was saved by failed attempts');
});

test('tags are normalised and de-duplicated; bulk add/remove', async () => {
  const { col } = await fresh();
  const n1 = (await addBasic(col, col.defaultDeckId, 'a', 'b', ['Verbs', 'verbs', 'two words'])).note;
  assert.deepEqual(n1.tags, ['Verbs', 'two_words']);
  const n2 = (await addBasic(col, col.defaultDeckId, 'c', 'd')).note;
  assert.equal(await col.addTags([n1.id, n2.id], ['hard']), 2);
  assert.equal(await col.addTags([n1.id], ['HARD']), 0, 'case-insensitive duplicate ignored');
  assert.equal(await col.removeTags([n1.id, n2.id], ['verbs']), 1);
  assert.deepEqual(col.notes.get(n1.id)!.tags, ['two_words', 'hard']);
  assert.deepEqual(col.allTags().map((t) => t.tag).sort(), ['hard', 'two_words']);
});

test('editing a note adds cards for new cloze numbers and never deletes existing ones', async () => {
  const { col } = await fresh();
  const { note } = await col.addNote({ typeId: col.builtinTypeId('cloze'), deckId: col.defaultDeckId, fields: { Text: '{{c1::a}}' } });
  await col.updateNote(note.id, { fields: { Text: '{{c1::a}} {{c2::b}}' } });
  assert.equal(col.cardsOfNote(note.id).length, 2);
  await col.updateNote(note.id, { fields: { Text: '{{c1::a}}' } });
  assert.equal(col.cardsOfNote(note.id).length, 2, 'card 2 kept');
  assert.equal(col.emptyCards().length, 1, 'but flagged as empty');
});

test('duplicate detection, duplicate note, move cards, suspend', async () => {
  const { col } = await fresh();
  const d2 = await col.createDeck('Other');
  const { note } = await addBasic(col, col.defaultDeckId, 'Same', 'x');
  assert.equal(col.findDuplicates(basic(col), { Front: ' same ' }).length, 1);
  const copy = await col.duplicateNote(note.id);
  assert.notEqual(copy.note.guid, note.guid);
  assert.equal(col.liveCards().length, 2);
  await col.moveCards(copy.cards.map((c) => c.id), d2.id);
  assert.equal(col.cards.get(copy.cards[0].id)!.deck_id, d2.id);
  await col.setSuspended([copy.cards[0].id], true);
  assert.equal(col.buildQueue(d2.id).counts.new, 0, 'suspended cards are not studied');
});

test('delete notes / cards soft-delete and remove from lists', async () => {
  const { col } = await fresh();
  const { note, cards } = await col.addNote({ typeId: col.builtinTypeId('basic_reversed'), deckId: col.defaultDeckId, fields: { Front: 'a', Back: 'b' } });
  assert.equal(await col.deleteCards([cards[0].id]), 1);
  assert.equal(col.notes.get(note.id)!.deleted_at, null, 'note stays while a card remains');
  assert.equal(await col.deleteCards([cards[1].id]), 1);
  assert.ok(col.notes.get(note.id)!.deleted_at, 'note removed with its last card');
  assert.equal(col.liveCards().length, 0);
  assert.ok(col.cards.has(cards[0].id), 'tombstone retained for sync');
});

// ------------------------------------------------------------------------------------------ custom note types
test('custom note types: validation, card generation, field rename migrates data, delete guard', async () => {
  const { col } = await fresh();
  await rejects(col.createNoteType({ name: 'x', fields: ['A', 'a'], templates: [{ name: 't', front: '{{A}}', back: '' }] }), /unique/);
  await rejects(col.createNoteType({ name: 'x', fields: ['A'], templates: [{ name: 't', front: '{{Nope}}', back: '' }] }), /unknown field/);
  const t = await col.createNoteType({
    name: 'Vocab', fields: ['Word', 'Meaning', 'Example'],
    templates: [
      { name: 'W→M', front: '{{Word}}', back: '{{FrontSide}}<hr>{{Meaning}}' },
      { name: 'Example', front: '{{#Example}}{{Example}}{{/Example}}', back: '{{Word}}' },
    ],
  });
  const n1 = await col.addNote({ typeId: t.id, deckId: col.defaultDeckId, fields: { Word: 'w', Meaning: 'm' } });
  assert.equal(n1.cards.length, 1);
  const n2 = await col.addNote({ typeId: t.id, deckId: col.defaultDeckId, fields: { Word: 'w2', Meaning: 'm', Example: 'ex' } });
  assert.equal(n2.cards.length, 2);
  await col.updateNoteType({ ...t, fields: ['Term', 'Meaning', 'Example'], templates: t.templates.map((x) => ({ ...x, front: x.front.replace('Word', 'Term'), back: x.back.replace('Word', 'Term') })) });
  assert.equal(col.notes.get(n1.note.id)!.fields.Term, 'w', 'values follow the renamed field');
  await rejects(col.deleteNoteType(t.id), /still used/);
  await rejects(col.deleteNoteType(basic(col)), /Built-in/);
});

// ------------------------------------------------------------------------------------------ study queue & answering
test('answering: logs every review, schedules, queue empties, learning card returns after its step', async () => {
  const { col, advance } = await fresh();
  const { cards } = await addBasic(col, col.defaultDeckId);
  let q = col.buildQueue(null);
  assert.deepEqual(q.counts, { new: 1, learning: 0, review: 0 });
  const { card, log } = await col.answerCard(cards[0].id, Rating.Good, 3200);
  assert.equal(card.state, CardState.Learning);
  assert.equal(log.state, CardState.New, 'log records the state BEFORE the answer');
  assert.equal(log.duration_ms, 3200);
  q = col.buildQueue(null);
  assert.deepEqual(q.counts, { new: 0, learning: 1, review: 0 });
  assert.ok(col.nextCard(q).card, 'due in 10m is inside the 20m learn-ahead window, so it is offered now');
  advance(11 * 60_000);
  q = col.buildQueue(null);
  const next = col.nextCard(q).card!;
  const r2 = await col.answerCard(next.id, Rating.Good, 2000);
  assert.equal(r2.card.state, CardState.Review);
  assert.equal(col.logs.size, 2);
  assert.equal(col.buildQueue(null).counts.learning, 0);
});

test('a learning card due beyond the learn-ahead window makes the queue report when to come back', async () => {
  const { col, advance } = await fresh();
  const o = await col.createOptions('slow', col.optionsFor(col.defaultDeckId));
  await col.saveOptions({ ...o, learning_steps: [1, 60] });
  await col.assignOptions(col.defaultDeckId, o.id);
  const { cards } = await addBasic(col, col.defaultDeckId);
  await col.answerCard(cards[0].id, Rating.Good, 1000); // → 60 minute step
  const n = col.nextCard(col.buildQueue(null));
  assert.equal(n.card, null);
  assert.ok(n.waitingUntil && n.waitingUntil.getTime() - col.now().getTime() > 50 * 60_000);
  advance(61 * 60_000);
  assert.ok(col.nextCard(col.buildQueue(null)).card);
});

test('learn-ahead: a learning card due within 20 minutes can be shown early', async () => {
  const { col, advance } = await fresh();
  const { cards } = await addBasic(col, col.defaultDeckId);
  await col.answerCard(cards[0].id, Rating.Good, 1000); // → 10m step
  advance(5 * 60_000);
  assert.ok(col.nextCard(col.buildQueue(null)).card, 'due in 5m ≤ 20m learn-ahead');
});

test('daily new-card limit is enforced across the day and resets after rollover', async () => {
  const { col, setNow } = await fresh();
  const d = await col.createDeck('Limited');
  const o = col.optionsFor(d.id);
  const mine = await col.createOptions('Two a day', o);
  await col.saveOptions({ ...mine, new_per_day: 2 });
  await col.assignOptions(d.id, mine.id);
  for (let i = 0; i < 5; i++) await addBasic(col, d.id, `q${i}`, 'a');
  assert.equal(col.buildQueue(d.id).counts.new, 2);
  assert.equal(col.deckCounts().get(d.id)!.new, 2);
  for (let i = 0; i < 2; i++) await col.answerCard(col.nextCard(col.buildQueue(d.id)).card!.id, Rating.Easy, 1000);
  assert.equal(col.buildQueue(d.id).counts.new, 0, 'limit reached after 2 new cards');
  assert.equal(col.deckCounts().get(d.id)!.new, 0);
  setNow(new Date('2026-03-11T09:00:00'));
  assert.equal(col.buildQueue(d.id).counts.new, 2, 'new day → fresh allowance');
});

test('undoing the first answer of a card gives the new-card allowance back (log kept, flagged undone)', async () => {
  const { col } = await fresh();
  const d = await col.createDeck('U');
  const mine = await col.createOptions('one', col.optionsFor(d.id));
  await col.saveOptions({ ...mine, new_per_day: 1 });
  await col.assignOptions(d.id, mine.id);
  await addBasic(col, d.id, 'a', 'b');
  const c = col.buildQueue(d.id).new[0];
  await col.answerCard(c.id, Rating.Easy, 500);
  assert.equal(col.buildQueue(d.id).counts.new, 0);
  assert.ok(col.canUndo);
  const restored = await col.undoLastAnswer();
  assert.equal(restored!.state, CardState.New);
  assert.equal(restored!.reps, 0);
  assert.equal(col.buildQueue(d.id).counts.new, 1);
  assert.equal(col.logs.size, 1, 'review history is never deleted');
  assert.equal([...col.logs.values()][0].undone, true);
  assert.equal(col.liveLogs().length, 0, 'statistics ignore undone reviews');
});

test('reviews due today are limited by max reviews/day; overdue first', async () => {
  const { col, setNow } = await fresh();
  const d = await col.createDeck('R');
  const o = await col.createOptions('r', col.optionsFor(d.id));
  await col.saveOptions({ ...o, reviews_per_day: 3, new_per_day: 50 });
  await col.assignOptions(d.id, o.id);
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push((await addBasic(col, d.id, `q${i}`, 'a')).cards[0].id);
  for (const id of ids) await col.answerCard(id, Rating.Easy, 100);
  setNow(new Date('2026-04-20T09:00:00'));
  const q = col.buildQueue(d.id);
  assert.equal(q.counts.review, 3);
  assert.equal(col.deckCounts().get(d.id)!.review, 3);
  assert.ok(q.review.every((c, i, a) => i === 0 || a[i - 1].due <= c.due), 'ordered by due');
});

test('siblings are buried for the day (one card per note in the queue)', async () => {
  const { col } = await fresh();
  const { cards } = await col.addNote({ typeId: col.builtinTypeId('basic_reversed'), deckId: col.defaultDeckId, fields: { Front: 'a', Back: 'b' } });
  assert.equal(col.buildQueue(null).counts.new, 1, 'only one of the two siblings is queued');
  await col.answerCard(cards[0].id, Rating.Easy, 100);
  assert.equal(col.buildQueue(null).counts.new, 0, 'sibling stays buried today');
});

test('sub-deck cards are studied from the parent; counts roll up', async () => {
  const { col } = await fresh();
  const child = await col.createDeck('P::C');
  const parent = col.findDeckByPath('P')!;
  await addBasic(col, child.id, 'x', 'y');
  await addBasic(col, parent.id, 'z', 'w');
  assert.equal(col.buildQueue(parent.id).counts.new, 2);
  assert.equal(col.buildQueue(child.id).counts.new, 1);
  const c = col.deckCounts();
  assert.equal(c.get(parent.id)!.total, 2);
  assert.equal(c.get(parent.id)!.new, 2);
  assert.equal(col.totalCounts().total, 2);
});

test('preview shows four intervals and answerCard rejects invalid input', async () => {
  const { col } = await fresh();
  const { cards } = await addBasic(col, col.defaultDeckId);
  const p = col.preview(cards[0]);
  assert.deepEqual([1, 2, 3, 4].map((r) => typeof p[r as 1].label), ['string', 'string', 'string', 'string']);
  await assert.rejects(col.answerCard(cards[0].id, 9 as 1, 0), CollectionError);
  await assert.rejects(col.answerCard('missing', 3, 0), CollectionError);
});

test('options validation and reschedule-from-history respects new retention', async () => {
  const { col, setNow } = await fresh();
  const d = col.defaultDeckId;
  assert.throws(() => Collection.validateOptions({ ...col.optionsFor(d), desired_retention: 0.5 }), /retention/);
  assert.throws(() => Collection.validateOptions({ ...col.optionsFor(d), learning_steps: [10, 1] }), /increasing/);
  assert.throws(() => Collection.validateOptions({ ...col.optionsFor(d), fsrs_params: [1, 2, 3] }), /19/);
  assert.throws(() => Collection.validateOptions({ ...col.optionsFor(d), new_per_day: -1 }), /whole number/);

  const { cards } = await addBasic(col, d);
  let c = (await col.answerCard(cards[0].id, Rating.Easy, 100)).card;
  setNow(new Date(new Date(c.due).getTime() + 1000));
  c = (await col.answerCard(c.id, Rating.Good, 100)).card;
  const before = c.scheduled_days;
  const o = col.optionsFor(d);
  await col.saveOptions({ ...o, desired_retention: 0.8 });
  assert.equal(await col.rescheduleFromHistory(), 1);
  assert.ok(col.cards.get(c.id)!.scheduled_days > before, 'lower retention → longer interval');
  assert.equal(col.logs.size, 2, 'history untouched by rescheduling');
});

test('forget and set-due keep review history', async () => {
  const { col } = await fresh();
  const { cards } = await addBasic(col, col.defaultDeckId);
  await col.answerCard(cards[0].id, Rating.Easy, 100);
  await col.setDueInDays([cards[0].id], 5);
  assert.ok(new Date(col.cards.get(cards[0].id)!.due).getTime() > T0.getTime() + 4 * 86_400_000);
  await col.forgetCards([cards[0].id]);
  assert.equal(col.cards.get(cards[0].id)!.state, CardState.New);
  assert.equal(col.logs.size, 1);
  await rejects(col.setDueInDays([cards[0].id], -2), /whole number/);
});

// ------------------------------------------------------------------------------------------ search
test('search language: text, phrases, deck, tag, is:, prop:, negation, or, type, added', async () => {
  const { col } = await fresh();
  const es = await col.createDeck('Languages::Spanish');
  const fr = await col.createDeck('Languages::French');
  await addBasic(col, es.id, 'hola amigo', 'hello friend', ['greeting']);
  await addBasic(col, es.id, 'adiós', 'goodbye', ['greeting', 'farewell']);
  await addBasic(col, fr.id, 'bonjour', 'hello', ['greeting']);
  await col.addNote({ typeId: col.builtinTypeId('cloze'), deckId: fr.id, fields: { Text: 'Paris is the {{c1::capital}}' } });
  const n = (q: string) => col.searchCards(q).total;
  assert.equal(n(''), 4);
  assert.equal(n('hello'), 2);
  assert.equal(n('"hello friend"'), 1);
  assert.equal(n('deck:Languages'), 4, 'includes sub-decks');
  assert.equal(n('deck:languages::spanish'), 2);
  assert.equal(n('deck:*::French'), 2);
  assert.equal(n('tag:greeting'), 3);
  assert.equal(n('tag:greeting -tag:farewell'), 2);
  assert.equal(n('tag:none'), 1);
  assert.equal(n('type:cloze'), 1);
  assert.equal(n('type:basic'), 3);
  assert.equal(n('is:new'), 4);
  assert.equal(n('is:due'), 0);
  assert.equal(n('bonjour or adiós'), 2);
  assert.equal(n('added:1'), 4);
  assert.equal(n('prop:reps>=1'), 0);
  assert.equal(n('-deck:Languages'), 0);
  await col.answerCard(col.searchCards('bonjour').rows[0].card.id, Rating.Good, 100);
  assert.equal(n('prop:reps>=1'), 1);
  assert.equal(n('rated:1'), 1);
  assert.equal(n('is:learn'), 1);
  assert.deepEqual(col.searchCards('is:bogus').warnings.length, 1);
});

test('search sorting and pagination', async () => {
  const { col, advance } = await fresh();
  for (const w of ['pear', 'apple', 'mango']) { await addBasic(col, col.defaultDeckId, w, 'x'); advance(1000); }
  const names = (r: ReturnType<Collection['searchCards']>) => r.rows.map((x) => x.preview);
  assert.deepEqual(names(col.searchCards('', { sort: 'front', desc: false })), ['apple', 'mango', 'pear']);
  assert.deepEqual(names(col.searchCards('', { sort: 'front', desc: true })), ['pear', 'mango', 'apple']);
  assert.equal(col.searchCards('', { limit: 2 }).rows.length, 2);
  const page2 = col.searchCards('', { limit: 2, offset: 2 });
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.total, 3);
  assert.equal(col.searchCards('', { sort: 'created', desc: true }).rows[0].preview, 'mango');
});

test('global search finds decks and cards', async () => {
  const { col } = await fresh();
  const d = await col.createDeck('Anatomy');
  await addBasic(col, d.id, 'femur', 'bone');
  const r = col.globalSearch('anat');
  assert.equal(r.decks[0].name, 'Anatomy');
  assert.equal(col.globalSearch('femur').cards.length, 1);
});

test('settings update merges and persists', async () => {
  const p = new MemoryPersistence();
  const a = await Collection.open(p, 'u1', () => T0);
  await a.updateSettings({ theme: 'dark', shortcuts: { ...a.settings.shortcuts, good: 'g' } });
  const b = await Collection.open(p, 'u1', () => T0);
  assert.equal(b.settings.theme, 'dark');
  assert.equal(b.settings.shortcuts.good, 'g');
  assert.equal(b.settings.shortcuts.again, '1');
});

test('subscribers are notified on every committed change', async () => {
  const { col } = await fresh();
  let n = 0;
  const off = col.subscribe(() => n++);
  await addBasic(col, col.defaultDeckId);
  assert.ok(n >= 1);
  off();
  const before = n;
  await addBasic(col, col.defaultDeckId, 'b', 'b');
  assert.equal(n, before);
});
