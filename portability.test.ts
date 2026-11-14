import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from '../src/db/collection';
import { MemoryPersistence } from '../src/db/persistence';
import {
  ImportError, createBackup, detectDelimiter, exportCsv, exportJsonNotes, guessMapping, importCsv, importJsonNotes,
  parseBackup, parseCsv, restoreBackup, toCsv, validateMapping,
} from '../src/lib/portability';

const open = (user = 'u1', clock?: () => Date) => Collection.open(new MemoryPersistence(), user, clock);

test('CSV parser: quotes, escaped quotes, embedded newlines, CRLF, BOM, blank lines', () => {
  const text = '﻿Front,Back\r\n"a, b","He said ""hi"""\r\n\r\n"line1\nline2",x\r\nlast,row';
  assert.deepEqual(parseCsv(text), [
    ['Front', 'Back'],
    ['a, b', 'He said "hi"'],
    ['line1\nline2', 'x'],
    ['last', 'row'],
  ]);
});

test('delimiter detection: comma, semicolon, tab', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('malformed CSV is rejected with a clear error', () => {
  assert.throws(() => parseCsv('a,b\n"unterminated,1'), ImportError);
});

test('toCsv neutralises spreadsheet formulas and the importer undoes it', async () => {
  const csv = toCsv([['=1+1', '@x', '-5', '-abc', 'ok']]);
  assert.ok(csv.includes("'=1+1") && csv.includes("'@x") && csv.includes("'-abc"));
  assert.ok(csv.includes(',-5,'), 'plain negative numbers are untouched');
  const col = await open();
  const rows = [['Front', 'Back'], ["'=SUM(A1)", 'answer']];
  const rep = await importCsv(col, rows, guessMapping(rows, col.types.get(col.builtinTypeId('basic'))!, col.defaultDeckId));
  assert.equal(rep.added, 1);
  assert.equal(col.searchCards('').rows[0].note.fields.Front, '=SUM(A1)');
});

test('guessMapping recognises header names and aliases; no-header falls back to column order', async () => {
  const col = await open();
  const basic = col.types.get(col.builtinTypeId('basic'))!;
  const g = guessMapping([['Question', 'Answer', 'Tags', 'Deck'], ['q', 'a', 't', 'd']], basic, col.defaultDeckId);
  assert.deepEqual(g.fields, { Front: 0, Back: 1 });
  assert.equal(g.tagsColumn, 2);
  assert.equal(g.deckColumn, 3);
  assert.equal(g.hasHeader, true);
  const g2 = guessMapping([['cat', 'dog']], basic, col.defaultDeckId);
  assert.equal(g2.hasHeader, false);
  assert.deepEqual(g2.fields, { Front: 0, Back: 1 });
});

test('CSV import: creates nested decks, tags, counts duplicates / invalid rows, reports row numbers', async () => {
  const col = await open();
  const basic = col.types.get(col.builtinTypeId('basic'))!;
  const rows = [
    ['Deck', 'Front', 'Back', 'Tags'],
    ['Lang::ES', 'hola', 'hello', 'greet common'],
    ['Lang::ES', 'adios', 'bye', ''],
    ['Lang::ES', 'hola', 'hello', ''], // duplicate
    ['Lang::ES', '', 'no front', ''], // invalid
    ['Lang::FR', 'bonjour', 'hello', 'greet'],
  ];
  const m = guessMapping(rows, basic, col.defaultDeckId);
  assert.equal(validateMapping(col, m, 4), null);
  const rep = await importCsv(col, rows, m);
  assert.equal(rep.total, 5);
  assert.equal(rep.added, 3);
  assert.equal(rep.duplicates, 1);
  assert.equal(rep.invalid, 1);
  assert.match(rep.errors[0], /^Row 5:/);
  assert.ok(col.findDeckByPath('Lang::ES') && col.findDeckByPath('Lang::FR'));
  assert.equal(col.searchCards('tag:greet').total, 2);
});

test('CSV import: plain-text mode escapes HTML; invalid mapping is refused', async () => {
  const col = await open();
  const basic = col.types.get(col.builtinTypeId('basic'))!;
  const rows = [['<b>x</b>', 'a\nb']];
  const m = { ...guessMapping(rows, basic, col.defaultDeckId), allowHtml: false };
  await importCsv(col, rows, m);
  const f = col.searchCards('').rows[0].note.fields;
  assert.equal(f.Front, '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(f.Back, 'a<br>b');
  assert.match(validateMapping(col, { ...m, fields: { Front: 9, Back: -1 } }, 2) ?? '', /does not exist/);
  assert.match(validateMapping(col, { ...m, fields: { Front: -1, Back: -1 } }, 2) ?? '', /Map at least one/);
  await assert.rejects(importCsv(col, rows, { ...m, typeId: 'nope' }), ImportError);
});

test('export → import round trip preserves decks, fields and tags', async () => {
  const a = await open();
  const d = await a.createDeck('Math');
  await a.addNote({ typeId: a.builtinTypeId('basic'), deckId: d.id, fields: { Front: '2+2, "sum"', Back: 'multi\nline' }, tags: ['easy', 'arith'] });
  await a.addNote({ typeId: a.builtinTypeId('basic'), deckId: d.id, fields: { Front: '=cmd', Back: 'safe' } });
  const { csv, notes } = exportCsv(a, { typeId: a.builtinTypeId('basic') });
  assert.equal(notes, 2);
  assert.ok(csv.split('\r\n')[0].includes('Front'));

  const b = await open('u2');
  const rows = parseCsv(csv);
  const rep = await importCsv(b, rows, guessMapping(rows, b.types.get(b.builtinTypeId('basic'))!, b.defaultDeckId));
  assert.equal(rep.added, 2);
  const got = b.searchCards('').rows.map((r) => r.note.fields.Front).sort();
  assert.deepEqual(got, ['2+2, "sum"', '=cmd']);
  assert.equal(b.searchCards('tag:arith').total, 1);
  assert.ok(b.findDeckByPath('Math'));
});

test('JSON notes: export/import round trip, invalid input is rejected gracefully', async () => {
  const a = await open();
  await a.addNote({ typeId: a.builtinTypeId('cloze'), deckId: a.defaultDeckId, fields: { Text: '{{c1::x}} {{c2::y}}' }, tags: ['t'] });
  const { json, notes } = exportJsonNotes(a);
  assert.equal(notes, 1);
  const b = await open('u2');
  const rep = await importJsonNotes(b, json);
  assert.equal(rep.added, 1);
  assert.equal(rep.cardsAdded, 2);
  await assert.rejects(importJsonNotes(b, 'not json'), /not valid JSON/);
  await assert.rejects(importJsonNotes(b, '{"x":1}'), /array of notes/);
  const r2 = await importJsonNotes(b, JSON.stringify([{ fields: { Front: 'ok', Back: 'b' } }, { nope: 1 }, null]));
  assert.equal(r2.added, 1);
  assert.equal(r2.invalid, 2);
});

test('backup → restore into a fresh account keeps everything, including scheduling and review history', async () => {
  let now = new Date('2026-05-01T10:00:00Z');
  const a = await open('u1', () => now);
  const d = await a.createDeck('Bio::Cells');
  const { cards } = await a.addNote({ typeId: a.builtinTypeId('basic'), deckId: d.id, fields: { Front: 'mitochondria', Back: 'powerhouse' }, tags: ['bio'] });
  now = new Date('2026-05-01T10:01:00Z');
  await a.answerCard(cards[0].id, 3, 4000);
  now = new Date('2026-05-01T10:12:00Z');
  await a.answerCard(cards[0].id, 3, 3000);
  const backup = createBackup(a);
  const text = JSON.stringify(backup);

  const b = await open('someone-else');
  const rep = await restoreBackup(b, parseBackup(text));
  assert.equal(rep.added.cards, 1);
  assert.equal(b.logs.size, 2);
  const card = b.cards.get(cards[0].id)!;
  const orig = a.cards.get(cards[0].id)!;
  assert.equal(card.user_id, 'someone-else', 'restored rows belong to the restoring user');
  assert.equal(card.reps, orig.reps);
  assert.equal(card.due, orig.due);
  assert.equal(card.stability, orig.stability);
  assert.ok(b.findDeckByPath('Bio::Cells'));
  assert.equal(b.searchCards('tag:bio').total, 1);
  // restored data is queued for upload
  assert.ok((await b.persistence.outboxAll()).length > 0);
});

test('restore merge: never rolls review history back and never removes anything', async () => {
  let now = new Date('2026-05-01T10:00:00Z');
  const a = await open('u1', () => now);
  const { cards } = await a.addNote({ typeId: a.builtinTypeId('basic'), deckId: a.defaultDeckId, fields: { Front: 'q', Back: 'a' } });
  const old = createBackup(a); // before any review
  now = new Date('2026-05-01T10:05:00Z');
  await a.answerCard(cards[0].id, 3, 1000);
  const repsNow = a.cards.get(cards[0].id)!.reps;
  await a.createDeck('Added later');
  const rep = await restoreBackup(a, old, 'merge');
  assert.equal(a.cards.get(cards[0].id)!.reps, repsNow);
  assert.equal(rep.kept.cards, 1);
  assert.ok(a.findDeckByPath('Added later'));
  assert.equal(a.logs.size, 1);
});

test('restore replace: removes records absent from the backup but keeps review history', async () => {
  const a = await open();
  await a.addNote({ typeId: a.builtinTypeId('basic'), deckId: a.defaultDeckId, fields: { Front: 'keep', Back: 'a' } });
  const snap = createBackup(a);
  const { cards } = await a.addNote({ typeId: a.builtinTypeId('basic'), deckId: a.defaultDeckId, fields: { Front: 'extra', Back: 'a' } });
  await a.answerCard(cards[0].id, 3, 1000);
  const rep = await restoreBackup(a, snap, 'replace');
  assert.ok(rep.removed >= 2);
  assert.deepEqual(a.searchCards('').rows.map((r) => r.note.fields.Front), ['keep']);
  assert.equal(a.logs.size, 1, 'review history is never deleted');
});

test('invalid / foreign / inconsistent backups are rejected before anything is written', async () => {
  const a = await open();
  const before = a.liveDecks().length;
  assert.throws(() => parseBackup('{'), /not valid JSON/);
  assert.throws(() => parseBackup('{"format":"anki"}'), /not a Mnemora backup/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'mnemora-backup', version: 99 })), /newer version/);
  const good = createBackup(a);
  assert.throws(() => parseBackup(JSON.stringify({ ...good, cards: 'x' })), /missing the "cards"/);
  const bad = createBackup(a);
  bad.cards.push({ ...(bad.cards[0] ?? { id: 'c' }), id: 'orphan', note_id: 'nope', deck_id: 'nope' } as never);
  assert.throws(() => parseBackup(JSON.stringify(bad)), /inconsistent/);
  assert.equal(a.liveDecks().length, before);
});
