/**
 * Import / export: CSV, JSON note exchange, and full-collection backup / restore.
 *
 * APKG (Anki package) is intentionally NOT implemented: it requires reading a zipped SQLite database and the
 * implementation could not be tested in this build environment. The UI says so instead of pretending.
 */
import type { Collection } from '../db/collection';
import { CollectionError } from '../db/collection';
import type { Card, Deck, DeckOptions, Note, NoteType, ReviewLog, SyncTable, UserSettings } from '../types';
import { escapeHtml } from './render';
import { uuid } from './ids';

// ------------------------------------------------------------------------------------------------ CSV
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;

export class ImportError extends Error {}

export function detectDelimiter(text: string): string {
  const head = text.slice(0, 4000).split(/\r?\n/).filter(Boolean).slice(0, 5);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = head.map((l) => l.split(d).length - 1);
    if (counts.length === 0 || counts[0] === 0) continue;
    const consistent = counts.every((c) => c === counts[0]);
    const score = counts[0] + (consistent ? 1000 : 0);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** RFC-4180 parser: quoted fields, escaped quotes, embedded newlines, BOM, CRLF. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i++;
      if (rows.length > MAX_IMPORT_ROWS + 1) throw new ImportError(`Too many rows (limit ${MAX_IMPORT_ROWS}).`);
    } else {
      field += ch;
      i++;
    }
  }
  if (inQuotes) throw new ImportError('Malformed CSV: a quoted field is never closed.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

const needsFormulaGuard = (v: string) => /^[=+@]/.test(v) || /^-[A-Za-z(]/.test(v) || /^[\t\r]/.test(v);

export function toCsv(rows: string[][], opts: { delimiter?: string; spreadsheetSafe?: boolean } = {}): string {
  const d = opts.delimiter ?? ',';
  const safe = opts.spreadsheetSafe ?? true;
  const esc = (v: string) => {
    if (safe && needsFormulaGuard(v)) v = `'${v}`;
    return /["\r\n]/.test(v) || v.includes(d) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(d)).join('\r\n') + '\r\n';
}

const unguard = (v: string) => (/^'[=+@]/.test(v) || /^'-[A-Za-z(]/.test(v) ? v.slice(1) : v);

// ------------------------------------------------------------------------------------------------ CSV export
export interface CsvExportOptions {
  deckId?: string | null; // subtree
  typeId?: string | null;
  includeTags?: boolean;
}

/** One row per note (not per card). Columns: Deck, Type, Tags, Field 1 … Field N (header uses real field names if single type). */
export function exportCsv(col: Collection, opts: CsvExportOptions = {}): { csv: string; notes: number } {
  const deckIds = opts.deckId ? col.subtreeIds(opts.deckId) : null;
  const wantedNotes = new Map<string, { deckPath: string; note: Note; type: NoteType }>();
  for (const card of col.liveCards()) {
    if (deckIds && !deckIds.has(card.deck_id)) continue;
    const note = col.notes.get(card.note_id);
    if (!note || note.deleted_at) continue;
    if (opts.typeId && note.template_id !== opts.typeId) continue;
    const type = col.types.get(note.template_id);
    if (!type) continue;
    if (!wantedNotes.has(note.id)) wantedNotes.set(note.id, { deckPath: col.deckPath(card.deck_id), note, type });
  }
  const list = [...wantedNotes.values()].sort((a, b) => a.note.created_at.localeCompare(b.note.created_at));
  const types = new Set(list.map((x) => x.type.id));
  const single = types.size === 1 ? list[0].type : null;
  const maxFields = Math.max(0, ...list.map((x) => x.type.fields.length));
  const header = ['Deck', 'Type', 'Tags', ...(single ? single.fields : Array.from({ length: maxFields }, (_, i) => `Field ${i + 1}`))];
  const rows: string[][] = [header];
  for (const { deckPath, note, type } of list) {
    rows.push([
      deckPath,
      type.name,
      opts.includeTags === false ? '' : note.tags.join(' '),
      ...type.fields.map((f) => note.fields[f] ?? ''),
      ...Array(Math.max(0, maxFields - type.fields.length)).fill(''),
    ]);
  }
  return { csv: toCsv(rows), notes: list.length };
}

// ------------------------------------------------------------------------------------------------ CSV import
export interface CsvMapping {
  typeId: string;
  /** field name → column index (or -1 for none) */
  fields: Record<string, number>;
  deckColumn: number; // -1 → use `deckId`
  deckId: string | null;
  tagsColumn: number; // -1 → none
  extraTags: string[];
  hasHeader: boolean;
  /** false → treat cells as plain text (escape HTML, newlines → <br>) */
  allowHtml: boolean;
  skipDuplicates: boolean;
}

const FIELD_ALIASES: Record<string, string[]> = {
  front: ['front', 'question', 'term', 'word', 'q', 'prompt'],
  back: ['back', 'answer', 'definition', 'meaning', 'a', 'translation'],
  text: ['text', 'cloze', 'sentence'],
  extra: ['extra', 'notes', 'note', 'hint'],
  tags: ['tags', 'tag', 'labels'],
  deck: ['deck', 'category', 'collection'],
};

/** Suggest a mapping from header names (or column order when there is no header). */
export function guessMapping(rows: string[][], type: NoteType, defaultDeckId: string): CsvMapping {
  const first = rows[0] ?? [];
  const lower = first.map((h) => h.trim().toLowerCase());
  const looksLikeHeader =
    lower.some((h) => type.fields.some((f) => f.toLowerCase() === h)) ||
    lower.some((h) => Object.values(FIELD_ALIASES).some((a) => a.includes(h)));
  const fields: Record<string, number> = {};
  const used = new Set<number>();
  const find = (names: string[]) => lower.findIndex((h, i) => !used.has(i) && names.includes(h));

  const deckCol = looksLikeHeader ? find(FIELD_ALIASES.deck) : -1;
  if (deckCol >= 0) used.add(deckCol);
  const tagsCol = looksLikeHeader ? find(FIELD_ALIASES.tags) : -1;
  if (tagsCol >= 0) used.add(tagsCol);

  type.fields.forEach((f, idx) => {
    let c = -1;
    if (looksLikeHeader) {
      c = find([f.toLowerCase(), ...(FIELD_ALIASES[f.toLowerCase()] ?? [])]);
    }
    if (c < 0 && !looksLikeHeader && idx < first.length) c = idx;
    if (c >= 0) used.add(c);
    fields[f] = c;
  });
  return {
    typeId: type.id,
    fields,
    deckColumn: deckCol,
    deckId: defaultDeckId,
    tagsColumn: tagsCol,
    extraTags: [],
    hasHeader: looksLikeHeader,
    allowHtml: true,
    skipDuplicates: true,
  };
}

export interface ImportReport {
  total: number;
  added: number;
  cardsAdded: number;
  duplicates: number;
  invalid: number;
  /** first few problems: "Row 12: Front is empty" */
  errors: string[];
  decksCreated: number;
}

export function validateMapping(col: Collection, m: CsvMapping, columns: number): string | null {
  const type = col.types.get(m.typeId);
  if (!type || type.deleted_at) return 'Choose a note type.';
  const mapped = type.fields.filter((f) => (m.fields[f] ?? -1) >= 0);
  if (mapped.length === 0) return 'Map at least one field to a column.';
  for (const f of mapped) if (m.fields[f] >= columns) return `Field “${f}” points to a column that does not exist.`;
  if (m.deckColumn >= columns || m.tagsColumn >= columns) return 'A mapped column does not exist.';
  if (m.deckColumn < 0 && (!m.deckId || !col.decks.get(m.deckId) || col.decks.get(m.deckId)!.deleted_at)) return 'Choose a deck.';
  return null;
}

export async function importCsv(
  col: Collection,
  rows: string[][],
  m: CsvMapping,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportReport> {
  const bad = validateMapping(col, m, Math.max(0, ...rows.map((r) => r.length)));
  if (bad) throw new ImportError(bad);
  const type = col.types.get(m.typeId)!;
  const data = m.hasHeader ? rows.slice(1) : rows;
  const report: ImportReport = { total: data.length, added: 0, cardsAdded: 0, duplicates: 0, invalid: 0, errors: [], decksCreated: 0 };
  const note = (n: number, msg: string) => {
    report.invalid++;
    if (report.errors.length < 20) report.errors.push(`Row ${n + (m.hasHeader ? 2 : 1)}: ${msg}`);
  };
  const decksBefore = col.liveDecks().length;

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    const fields: Record<string, string> = {};
    for (const f of type.fields) {
      const c = m.fields[f] ?? -1;
      let v = c >= 0 ? unguard(r[c] ?? '').trim() : '';
      if (!m.allowHtml) v = escapeHtml(v).replace(/\r?\n/g, '<br>');
      fields[f] = v;
    }
    let deckId = m.deckId ?? col.defaultDeckId;
    if (m.deckColumn >= 0) {
      const path = (r[m.deckColumn] ?? '').trim();
      if (path) {
        try {
          deckId = (await col.ensureDeckPath(path)).id;
        } catch (e) {
          note(i, e instanceof CollectionError ? e.message : 'invalid deck name');
          continue;
        }
      }
    }
    const tags = [
      ...(m.tagsColumn >= 0 ? (r[m.tagsColumn] ?? '').split(/[\s,;]+/).filter(Boolean) : []),
      ...m.extraTags,
    ].map((t) => t.replace(/[^\p{L}\p{N}_:\-./]/gu, '_'));
    try {
      col.validateNote(type, fields);
      if (m.skipDuplicates && col.findDuplicates(type.id, fields).length > 0) {
        report.duplicates++;
        continue;
      }
      const res = await col.addNote({ typeId: type.id, deckId, fields, tags });
      report.added++;
      report.cardsAdded += res.cards.length;
    } catch (e) {
      note(i, e instanceof CollectionError ? e.message : 'could not be added');
    }
    if (onProgress && (i % 50 === 0 || i === data.length - 1)) onProgress(i + 1, data.length);
  }
  report.decksCreated = Math.max(0, col.liveDecks().length - decksBefore);
  return report;
}

// ------------------------------------------------------------------------------------------------ JSON notes
export interface JsonNote {
  deck?: string;
  type?: string;
  fields: Record<string, string>;
  tags?: string[];
}

export function exportJsonNotes(col: Collection, deckId?: string | null): { json: string; notes: number } {
  const deckIds = deckId ? col.subtreeIds(deckId) : null;
  const seen = new Set<string>();
  const out: JsonNote[] = [];
  for (const card of col.liveCards()) {
    if (deckIds && !deckIds.has(card.deck_id)) continue;
    const note = col.notes.get(card.note_id);
    if (!note || note.deleted_at || seen.has(note.id)) continue;
    seen.add(note.id);
    const type = col.types.get(note.template_id);
    if (!type) continue;
    out.push({ deck: col.deckPath(card.deck_id), type: type.name, fields: { ...note.fields }, tags: [...note.tags] });
  }
  return { json: JSON.stringify({ format: 'mnemora-notes', version: 1, notes: out }, null, 2), notes: out.length };
}

export async function importJsonNotes(col: Collection, text: string, opts: { defaultDeckId?: string; skipDuplicates?: boolean } = {}): Promise<ImportReport> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ImportError('This file is not valid JSON.');
  }
  const list = Array.isArray(doc) ? doc : (doc as { notes?: unknown })?.notes;
  if (!Array.isArray(list)) throw new ImportError('Expected a JSON array of notes or an object with a "notes" array.');
  if (list.length > MAX_IMPORT_ROWS) throw new ImportError(`Too many notes (limit ${MAX_IMPORT_ROWS}).`);
  const report: ImportReport = { total: list.length, added: 0, cardsAdded: 0, duplicates: 0, invalid: 0, errors: [], decksCreated: 0 };
  const decksBefore = col.liveDecks().length;
  const types = col.liveTypes();
  const err = (i: number, msg: string) => {
    report.invalid++;
    if (report.errors.length < 20) report.errors.push(`Note ${i + 1}: ${msg}`);
  };
  for (let i = 0; i < list.length; i++) {
    const n = list[i] as Partial<JsonNote> | null;
    if (!n || typeof n !== 'object' || typeof n.fields !== 'object' || n.fields === null || Array.isArray(n.fields)) {
      err(i, 'missing "fields" object');
      continue;
    }
    const type = types.find((t) => t.name === n.type) ?? types.find((t) => t.kind === 'basic')!;
    const fields: Record<string, string> = {};
    for (const f of type.fields) fields[f] = typeof n.fields[f] === 'string' ? n.fields[f] : '';
    try {
      const deckId = n.deck ? (await col.ensureDeckPath(String(n.deck))).id : (opts.defaultDeckId ?? col.defaultDeckId);
      col.validateNote(type, fields);
      if ((opts.skipDuplicates ?? true) && col.findDuplicates(type.id, fields).length) {
        report.duplicates++;
        continue;
      }
      const res = await col.addNote({ typeId: type.id, deckId, fields, tags: Array.isArray(n.tags) ? n.tags.map(String) : [] });
      report.added++;
      report.cardsAdded += res.cards.length;
    } catch (e) {
      err(i, e instanceof CollectionError ? e.message : 'could not be added');
    }
  }
  report.decksCreated = Math.max(0, col.liveDecks().length - decksBefore);
  return report;
}

// ------------------------------------------------------------------------------------------------ backup / restore
export const BACKUP_FORMAT = 'mnemora-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exported_at: string;
  counts: Record<string, number>;
  deck_options: DeckOptions[];
  card_templates: NoteType[];
  decks: Deck[];
  notes: Note[];
  cards: Card[];
  review_logs: ReviewLog[];
  settings: UserSettings;
}

export function createBackup(col: Collection): Backup {
  const b: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: col.ts(),
    counts: {},
    deck_options: [...col.options.values()],
    card_templates: [...col.types.values()],
    decks: [...col.decks.values()],
    notes: [...col.notes.values()],
    cards: [...col.cards.values()],
    review_logs: [...col.logs.values()],
    settings: col.settings,
  };
  for (const k of ['deck_options', 'card_templates', 'decks', 'notes', 'cards', 'review_logs'] as const) b.counts[k] = b[k].length;
  return structuredClone(b);
}

export interface RestoreReport {
  mode: 'merge' | 'replace';
  added: Record<string, number>;
  updated: Record<string, number>;
  kept: Record<string, number>;
  removed: number;
}

const ts = (s: unknown) => (typeof s === 'string' ? Date.parse(s) || 0 : 0);

/** Structural validation so a corrupt or foreign file is rejected before anything is written. */
export function validateBackup(doc: unknown): Backup {
  const b = doc as Partial<Backup> | null;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new ImportError('This is not a Mnemora backup file.');
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) throw new ImportError('This backup was made by a newer version of the app.');
  for (const k of ['deck_options', 'card_templates', 'decks', 'notes', 'cards', 'review_logs'] as const) {
    const arr = b[k];
    if (!Array.isArray(arr)) throw new ImportError(`Backup is missing the "${k}" list.`);
    for (const r of arr) {
      if (!r || typeof r !== 'object' || typeof (r as { id?: unknown }).id !== 'string') throw new ImportError(`Backup contains a malformed record in "${k}".`);
    }
  }
  const noteIds = new Set(b.notes!.map((n) => n.id));
  const deckIds = new Set(b.decks!.map((d) => d.id));
  const typeIds = new Set(b.card_templates!.map((t) => t.id));
  if (b.notes!.some((n) => !typeIds.has(n.template_id))) throw new ImportError('Backup is inconsistent: a note refers to a missing note type.');
  if (b.cards!.some((c) => !noteIds.has(c.note_id) || !deckIds.has(c.deck_id))) throw new ImportError('Backup is inconsistent: a card refers to a missing note or deck.');
  return b as Backup;
}

export function parseBackup(text: string): Backup {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError('File is too large.');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ImportError('This file is not valid JSON.');
  }
  return validateBackup(doc);
}

/**
 * Restore a backup into the current collection.
 *  merge   – newest `updated_at` wins per record; nothing is removed; review logs are unioned.
 *  replace – like merge, then everything that is not in the backup is soft-deleted (review history is kept).
 * Restored records are queued for sync like any other edit. Rows are re-owned by the current user.
 */
export async function restoreBackup(col: Collection, backup: Backup, mode: 'merge' | 'replace' = 'merge'): Promise<RestoreReport> {
  validateBackup(backup);
  const rep: RestoreReport = { mode, added: {}, updated: {}, kept: {}, removed: 0 };
  const tables: [SyncTable, Record<string, unknown>[]][] = [
    ['deck_options', backup.deck_options as unknown as Record<string, unknown>[]],
    ['card_templates', backup.card_templates as unknown as Record<string, unknown>[]],
    ['decks', backup.decks as unknown as Record<string, unknown>[]],
    ['notes', backup.notes as unknown as Record<string, unknown>[]],
    ['cards', backup.cards as unknown as Record<string, unknown>[]],
    ['review_logs', backup.review_logs as unknown as Record<string, unknown>[]],
  ];
  const inBackup = new Map<SyncTable, Set<string>>();
  for (const [table, rows] of tables) {
    rep.added[table] = rep.updated[table] = rep.kept[table] = 0;
    inBackup.set(table, new Set(rows.map((r) => String(r.id))));
    for (const raw of rows) {
      const row = { ...structuredClone(raw), user_id: col.userId } as unknown as Record<string, unknown> & { id: string };
      const cur = col.getRow(table, row.id) as (Record<string, unknown> & { id: string }) | undefined;
      if (!cur) {
        col.save(table, row as never, false, true);
        rep.added[table]++;
      } else if (table === 'review_logs') {
        if (row.undone === true && cur.undone !== true) {
          col.save(table, { ...cur, undone: true } as never, true, true);
          rep.updated[table]++;
        } else rep.kept[table]++;
      } else if (table === 'cards' && (ts(cur.last_review) > ts(row.last_review) || (ts(cur.last_review) === ts(row.last_review) && Number(cur.reps) > Number(row.reps)))) {
        rep.kept[table]++; // never roll review history back
      } else if (ts(row.updated_at) > ts(cur.updated_at)) {
        col.save(table, row as never, false, true);
        rep.updated[table]++;
      } else rep.kept[table]++;
    }
  }
  if (backup.settings && typeof backup.settings === 'object') {
    await col.updateSettings({ ...backup.settings });
  }
  if (mode === 'replace') {
    const now = col.ts();
    const tomb = (table: SyncTable, items: Iterable<{ id: string; deleted_at: string | null }>) => {
      for (const it of items) {
        if (!it.deleted_at && !inBackup.get(table)!.has(it.id)) {
          col.save(table, { ...it, deleted_at: now } as never, true, true);
          rep.removed++;
        }
      }
    };
    tomb('cards', col.cards.values());
    tomb('notes', col.notes.values());
    tomb('decks', col.decks.values());
  }
  await col.commit();
  return rep;
}

export function downloadName(prefix: string, ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.${ext}`;
}

export const newImportId = uuid;
