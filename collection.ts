/**
 * Collection: the local-first data model. The whole working set lives in memory (a 50k-card collection is a few
 * MB) so queries, queues and statistics are instant and work offline; every mutation is written through to a
 * Persistence adapter (IndexedDB in the browser) and queued in the sync outbox.
 *
 * Rules:
 *  - Rows are never hard-deleted (tombstones via deleted_at) so deletions can sync.
 *  - Review logs are append-only. "Undo" flips `undone`; the history row stays.
 *  - Every mutation goes through save()/commit() so persistence + outbox + change notification stay consistent.
 */
import type {
  Card, CardStateValue, Deck, DeckCounts, DeckOptions, ID, Note, NoteType, OutboxEntry, RatingValue,
  ReviewLog, SyncTable, UserSettings, UserSettingsRow,
} from '../types';
import { CardState } from '../types';
import { clozeNumbers } from '../lib/cloze';
import { BUILTIN_NOTE_TYPES, DEFAULT_DECK_NAME, DEFAULT_SETTINGS } from '../lib/defaults';
import { deterministicId, uuid } from '../lib/ids';
import { previewText, renderCard, stripHtml } from '../lib/render';
import {
  DEFAULT_SCHEDULER_OPTIONS, isMature, newCardFields, previewAll, schedule, schedulingFields,
  type SchedulePreview, type SchedulerOptions,
} from '../lib/scheduler';
import { compileQuery, lastRatedMap } from '../lib/search';
import { MS_MINUTE, dayEnd, dayStart } from '../lib/time';
import type { Persistence, Row } from './persistence';
import { TABLES } from './persistence';

export const LEARN_AHEAD_MINUTES = 20;
export const MAX_FIELD_LENGTH = 200_000;
export const MAX_TAGS_PER_NOTE = 50;
const UNDO_LIMIT = 30;

export class CollectionError extends Error {}

type RowOf<T extends SyncTable> = T extends 'decks' ? Deck
  : T extends 'deck_options' ? DeckOptions
  : T extends 'card_templates' ? NoteType
  : T extends 'notes' ? Note
  : T extends 'cards' ? Card
  : T extends 'review_logs' ? ReviewLog
  : UserSettingsRow & { id: string };

interface Pending { table: SyncTable; row: Row; queue: boolean }

interface UndoEntry { cardBefore: Card; logId: ID }

export interface QueueItem { card: Card; note: Note; type: NoteType }

export interface StudyQueue {
  learning: Card[];
  review: Card[];
  new: Card[];
  counts: { new: number; learning: number; review: number };
}

export interface BrowseRow {
  card: Card;
  note: Note;
  type: NoteType;
  deckPath: string;
  preview: string;
}

export type BrowseSort = 'created' | 'reviewed' | 'due' | 'interval' | 'lapses' | 'reps' | 'deck' | 'front';

export interface DeckTreeNode {
  deck: Deck;
  path: string;
  depth: number;
  children: DeckTreeNode[];
}

const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

export function validateTag(t: string): string {
  const tag = t.trim().replace(/\s+/g, '_');
  if (!tag) throw new CollectionError('Tag cannot be empty');
  if (tag.length > 80) throw new CollectionError('Tag is too long (max 80 characters)');
  if (/[<>"'`,;]/.test(tag)) throw new CollectionError('Tag contains unsupported characters');
  return tag;
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (!raw.trim()) continue;
    const t = validateTag(raw);
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  if (out.length > MAX_TAGS_PER_NOTE) throw new CollectionError(`A note can have at most ${MAX_TAGS_PER_NOTE} tags`);
  return out;
}

export class Collection {
  readonly decks = new Map<ID, Deck>();
  readonly options = new Map<ID, DeckOptions>();
  readonly types = new Map<ID, NoteType>();
  readonly notes = new Map<ID, Note>();
  readonly cards = new Map<ID, Card>();
  readonly logs = new Map<ID, ReviewLog>();
  settingsRow!: UserSettingsRow & { id: string };

  private noteCards = new Map<ID, Set<ID>>();
  private pending = new Map<string, Pending>();
  private undoStack: UndoEntry[] = [];
  private listeners = new Set<() => void>();
  private _version = 0;
  private cache = new Map<string, { v: number; t: number; value: unknown }>();

  private constructor(
    readonly userId: ID,
    readonly persistence: Persistence,
    private clock: () => Date,
  ) {}

  // ------------------------------------------------------------------ lifecycle
  static async open(persistence: Persistence, userId: ID, clock: () => Date = () => new Date()): Promise<Collection> {
    const c = new Collection(userId, persistence, clock);
    await c.load();
    await c.seed();
    return c;
  }

  private async load(): Promise<void> {
    for (const t of TABLES) {
      const rows = await this.persistence.loadAll(t);
      for (const r of rows) this.index(t, r);
    }
  }

  private index(table: SyncTable, r: Row): void {
    switch (table) {
      case 'decks': this.decks.set(r.id, r as unknown as Deck); break;
      case 'deck_options': this.options.set(r.id, r as unknown as DeckOptions); break;
      case 'card_templates': this.types.set(r.id, r as unknown as NoteType); break;
      case 'notes': this.notes.set(r.id, r as unknown as Note); break;
      case 'cards': {
        const c = r as unknown as Card;
        this.cards.set(c.id, c);
        let s = this.noteCards.get(c.note_id);
        if (!s) this.noteCards.set(c.note_id, (s = new Set()));
        s.add(c.id);
        break;
      }
      case 'review_logs': this.logs.set(r.id, r as unknown as ReviewLog); break;
      case 'user_settings': this.settingsRow = r as unknown as UserSettingsRow & { id: string }; break;
    }
  }

  private async seed(): Promise<void> {
    const ts = this.ts();
    const id = (k: string) => deterministicId(`${this.userId}:${k}`);

    if (!this.options.has(this.defaultOptionsId)) {
      this.save('deck_options', {
        id: this.defaultOptionsId, user_id: this.userId, name: 'Default',
        new_per_day: 20, reviews_per_day: 200, learning_steps: [1, 10], relearning_steps: [10],
        desired_retention: 0.9, maximum_interval: 36500, fsrs_params: null,
        created_at: ts, updated_at: ts, deleted_at: null,
      } satisfies DeckOptions, false);
    }
    for (const b of BUILTIN_NOTE_TYPES) {
      const tid = id(`nt:${b.key}`);
      if (!this.types.has(tid)) {
        this.save('card_templates', {
          id: tid, user_id: this.userId, name: b.name, kind: b.kind, fields: b.fields, templates: b.templates,
          css: b.css, builtin: true, created_at: ts, updated_at: ts, deleted_at: null,
        } satisfies NoteType, false);
      }
    }
    if (![...this.decks.values()].some((d) => !d.deleted_at)) {
      const did = id('deck:default');
      const existing = this.decks.get(did);
      this.save('decks', {
        id: did, user_id: this.userId, parent_id: null, name: DEFAULT_DECK_NAME, description: '',
        options_id: this.defaultOptionsId, is_public: false, position: 0,
        created_at: existing?.created_at ?? ts, updated_at: ts, deleted_at: null,
      } satisfies Deck, false);
    }
    if (!this.settingsRow) {
      this.save('user_settings', {
        id: this.userId, user_id: this.userId, settings: { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SETTINGS.shortcuts } },
        created_at: ts, updated_at: ts,
      } as UserSettingsRow & { id: string }, false);
    }
    await this.commit();
  }

  get defaultOptionsId(): ID {
    return deterministicId(`${this.userId}:opts:default`);
  }
  get defaultDeckId(): ID {
    return deterministicId(`${this.userId}:deck:default`);
  }
  builtinTypeId(key: string): ID {
    return deterministicId(`${this.userId}:nt:${key}`);
  }

  now(): Date {
    return this.clock();
  }
  /** Current time as an ISO string from the collection's clock (injectable in tests). */
  ts(): string {
    return this.clock().toISOString();
  }
  setClock(fn: () => Date): void {
    this.clock = fn;
  }

  // ------------------------------------------------------------------ change notification
  get version(): number {
    return this._version;
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this._version;

  /**
   * Cache a derived value until the data changes. `timeSensitive` values (anything that depends on "now":
   * today's limits, what is due) are additionally invalidated as the clock moves (30 s buckets), so a deck list
   * left open across midnight or while learning steps elapse never shows stale counts.
   */
  private memo<T>(key: string, fn: () => T, timeSensitive = false): T {
    const bucket = timeSensitive ? Math.floor(this.now().getTime() / 30_000) : 0;
    const hit = this.cache.get(key);
    if (hit && hit.v === this._version && hit.t === bucket) return hit.value as T;
    const value = fn();
    this.cache.set(key, { v: this._version, t: bucket, value });
    return value;
  }

  // ------------------------------------------------------------------ write path
  /** Stage a row. `touch` stamps updated_at (always, except when applying remote data or seeding). */
  save<T extends SyncTable>(table: T, row: RowOf<T>, touch = true, queue = true): RowOf<T> {
    const r = row as unknown as Row & { updated_at: string };
    if (touch) r.updated_at = this.ts();
    this.index(table, r);
    this.pending.set(`${table}:${r.id}`, { table, row: r, queue });
    return row;
  }

  async commit(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    const byTable = new Map<SyncTable, Row[]>();
    const outbox: OutboxEntry[] = [];
    const queuedAt = this.ts();
    for (const p of batch) {
      let list = byTable.get(p.table);
      if (!list) byTable.set(p.table, (list = []));
      list.push(structuredClone(p.row));
      if (p.queue) outbox.push({ key: `${p.table}:${p.row.id}`, table: p.table, record_id: p.row.id, queued_at: queuedAt });
    }
    for (const [t, rows] of byTable) await this.persistence.putMany(t, rows);
    await this.persistence.outboxPut(outbox);
    this._version++;
    for (const l of [...this.listeners]) l();
  }

  /** Apply rows received from the cloud: no touch, no outbox. */
  async applyRemote(table: SyncTable, rows: Row[]): Promise<void> {
    for (const r of rows) this.save(table, r as unknown as RowOf<typeof table>, false, false);
    await this.commit();
  }

  getRow(table: SyncTable, id: ID): Row | undefined {
    switch (table) {
      case 'decks': return this.decks.get(id) as unknown as Row | undefined;
      case 'deck_options': return this.options.get(id) as unknown as Row | undefined;
      case 'card_templates': return this.types.get(id) as unknown as Row | undefined;
      case 'notes': return this.notes.get(id) as unknown as Row | undefined;
      case 'cards': return this.cards.get(id) as unknown as Row | undefined;
      case 'review_logs': return this.logs.get(id) as unknown as Row | undefined;
      case 'user_settings': return this.settingsRow?.id === id ? (this.settingsRow as unknown as Row) : undefined;
    }
  }

  // ------------------------------------------------------------------ settings
  get settings(): UserSettings {
    return this.settingsRow.settings;
  }
  async updateSettings(patch: Partial<UserSettings>): Promise<void> {
    const next: UserSettings = { ...this.settings, ...patch, shortcuts: { ...this.settings.shortcuts, ...(patch.shortcuts ?? {}) } };
    this.save('user_settings', { ...this.settingsRow, settings: next });
    await this.commit();
  }

  // ------------------------------------------------------------------ decks
  liveDecks(): Deck[] {
    return this.memo('liveDecks', () => [...this.decks.values()].filter((d) => !d.deleted_at));
  }

  deckPath(id: ID): string {
    const parts: string[] = [];
    let cur: Deck | undefined = this.decks.get(id);
    let guard = 0;
    while (cur && guard++ < 64) {
      parts.unshift(cur.name);
      cur = cur.parent_id ? this.decks.get(cur.parent_id) : undefined;
    }
    return parts.join('::');
  }

  childrenOf(id: ID | null): Deck[] {
    return this.liveDecks().filter((d) => (d.parent_id ?? null) === id).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  /** The deck and all live descendants. */
  subtreeIds(id: ID): Set<ID> {
    const out = new Set<ID>([id]);
    const stack = [id];
    const kids = this.memo('kidsIndex', () => {
      const m = new Map<ID | null, ID[]>();
      for (const d of this.liveDecks()) {
        const k = d.parent_id ?? null;
        const arr = m.get(k);
        if (arr) arr.push(d.id); else m.set(k, [d.id]);
      }
      return m;
    });
    while (stack.length) {
      for (const k of kids.get(stack.pop()!) ?? []) if (!out.has(k)) { out.add(k); stack.push(k); }
    }
    return out;
  }

  deckTree(): DeckTreeNode[] {
    return this.memo('deckTree', () => {
      const build = (parent: ID | null, depth: number, prefix: string): DeckTreeNode[] =>
        this.childrenOf(parent).map((d) => {
          const path = prefix ? `${prefix}::${d.name}` : d.name;
          return { deck: d, path, depth, children: build(d.id, depth + 1, path) };
        });
      return build(null, 0, '');
    });
  }

  findDeckByPath(path: string): Deck | undefined {
    const want = path.split('::').map(cleanName).join('::').toLowerCase();
    return this.liveDecks().find((d) => this.deckPath(d.id).toLowerCase() === want);
  }

  private assertSiblingNameFree(name: string, parentId: ID | null, exceptId?: ID): void {
    const clash = this.childrenOf(parentId).find((d) => d.id !== exceptId && d.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new CollectionError(`A deck named "${name}" already exists here`);
  }

  private validateDeckName(raw: string): string {
    const name = cleanName(raw);
    if (!name) throw new CollectionError('Deck name cannot be empty');
    if (name.length > 120) throw new CollectionError('Deck name is too long (max 120 characters)');
    if (name.includes('::')) throw new CollectionError('Deck name cannot contain "::" (use a parent deck instead)');
    return name;
  }

  async createDeck(rawName: string, parentId: ID | null = null): Promise<Deck> {
    // "A::B::C" creates the whole chain.
    if (rawName.includes('::')) return this.ensureDeckPath(rawName, parentId);
    const name = this.validateDeckName(rawName);
    if (parentId && (!this.decks.has(parentId) || this.decks.get(parentId)!.deleted_at)) throw new CollectionError('Parent deck not found');
    this.assertSiblingNameFree(name, parentId);
    const ts = this.ts();
    const siblings = this.childrenOf(parentId);
    const parent = parentId ? this.decks.get(parentId) : undefined;
    const deck = this.save('decks', {
      id: uuid(), user_id: this.userId, parent_id: parentId, name, description: '',
      options_id: parent?.options_id ?? this.defaultOptionsId, is_public: false,
      position: siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1 : 0,
      created_at: ts, updated_at: ts, deleted_at: null,
    });
    await this.commit();
    return deck;
  }

  /** Find or create every segment of a "A::B::C" path. */
  async ensureDeckPath(path: string, under: ID | null = null): Promise<Deck> {
    const parts = path.split('::').map((p) => this.validateDeckName(p));
    let parent: ID | null = under;
    let deck!: Deck;
    for (const part of parts) {
      const existing: Deck | undefined = this.childrenOf(parent).find((d) => d.name.toLowerCase() === part.toLowerCase());
      deck = existing ?? (await this.createDeck(part, parent));
      parent = deck.id;
    }
    return deck;
  }

  async renameDeck(id: ID, rawName: string): Promise<void> {
    const deck = this.decks.get(id);
    if (!deck || deck.deleted_at) throw new CollectionError('Deck not found');
    const name = this.validateDeckName(rawName);
    this.assertSiblingNameFree(name, deck.parent_id, id);
    this.save('decks', { ...deck, name });
    await this.commit();
  }

  async setDeckDescription(id: ID, description: string): Promise<void> {
    const deck = this.decks.get(id);
    if (!deck || deck.deleted_at) throw new CollectionError('Deck not found');
    this.save('decks', { ...deck, description: description.slice(0, 2000) });
    await this.commit();
  }

  async moveDeck(id: ID, newParentId: ID | null): Promise<void> {
    const deck = this.decks.get(id);
    if (!deck || deck.deleted_at) throw new CollectionError('Deck not found');
    if (newParentId) {
      const p = this.decks.get(newParentId);
      if (!p || p.deleted_at) throw new CollectionError('Target deck not found');
      if (this.subtreeIds(id).has(newParentId)) throw new CollectionError('A deck cannot be moved into itself or its own sub-deck');
    }
    this.assertSiblingNameFree(deck.name, newParentId, id);
    const sibs = this.childrenOf(newParentId);
    this.save('decks', { ...deck, parent_id: newParentId, position: sibs.length ? Math.max(...sibs.map((s) => s.position)) + 1 : 0 });
    await this.commit();
  }

  async setDeckPublic(id: ID, isPublic: boolean): Promise<void> {
    const deck = this.decks.get(id);
    if (!deck || deck.deleted_at) throw new CollectionError('Deck not found');
    this.save('decks', { ...deck, is_public: isPublic });
    await this.commit();
  }

  /** Delete a deck, its sub-decks and every card in them. Returns number of cards removed. Review history is kept. */
  async deleteDeck(id: ID): Promise<number> {
    const deck = this.decks.get(id);
    if (!deck || deck.deleted_at) throw new CollectionError('Deck not found');
    const ids = this.subtreeIds(id);
    const ts = this.ts();
    let removed = 0;
    const touchedNotes = new Set<ID>();
    for (const c of this.cards.values()) {
      if (!c.deleted_at && ids.has(c.deck_id)) {
        this.save('cards', { ...c, deleted_at: ts });
        touchedNotes.add(c.note_id);
        removed++;
      }
    }
    for (const nid of touchedNotes) {
      const alive = [...(this.noteCards.get(nid) ?? [])].some((cid) => !this.cards.get(cid)!.deleted_at);
      const n = this.notes.get(nid);
      if (!alive && n && !n.deleted_at) this.save('notes', { ...n, deleted_at: ts });
    }
    for (const did of ids) this.save('decks', { ...this.decks.get(did)!, deleted_at: ts });
    await this.commit();
    if (this.liveDecks().length === 0) await this.seed();
    return removed;
  }

  /** Copy a deck (and sub-decks, notes, cards) with fresh scheduling. Returns the new root deck. */
  async duplicateDeck(id: ID): Promise<Deck> {
    const src = this.decks.get(id);
    if (!src || src.deleted_at) throw new CollectionError('Deck not found');
    let name = `${src.name} (copy)`;
    for (let i = 2; this.childrenOf(src.parent_id).some((d) => d.name.toLowerCase() === name.toLowerCase()); i++) name = `${src.name} (copy ${i})`;
    const ts = this.ts();
    const map = new Map<ID, ID>();
    const copyDeck = (d: Deck, parent: ID | null, nm: string): void => {
      const nd = this.save('decks', { ...d, id: uuid(), parent_id: parent, name: nm, is_public: false, created_at: ts, updated_at: ts, deleted_at: null });
      map.set(d.id, nd.id);
      for (const k of this.childrenOf(d.id)) copyDeck(k, nd.id, k.name);
    };
    copyDeck(src, src.parent_id, name);
    const noteMap = new Map<ID, Note>();
    const now = this.now();
    for (const c of [...this.cards.values()]) {
      if (c.deleted_at || !map.has(c.deck_id)) continue;
      const n = this.notes.get(c.note_id);
      if (!n || n.deleted_at) continue;
      let nn = noteMap.get(n.id);
      if (!nn) {
        nn = this.save('notes', { ...n, id: uuid(), guid: uuid(), created_at: ts, updated_at: ts, deleted_at: null, fields: { ...n.fields }, tags: [...n.tags] });
        noteMap.set(n.id, nn);
      }
      this.save('cards', { ...c, id: uuid(), note_id: nn.id, deck_id: map.get(c.deck_id)!, ...newCardFields(now), suspended: false, created_at: ts, updated_at: ts, deleted_at: null });
    }
    await this.commit();
    return this.decks.get(map.get(id)!)!;
  }

  // ------------------------------------------------------------------ deck options
  optionsFor(deckId: ID): DeckOptions {
    const d = this.decks.get(deckId);
    const o = d?.options_id ? this.options.get(d.options_id) : undefined;
    return o && !o.deleted_at ? o : this.options.get(this.defaultOptionsId)!;
  }

  schedulerOptionsFor(deckId: ID): SchedulerOptions {
    const o = this.optionsFor(deckId);
    return {
      learningSteps: o.learning_steps, relearningSteps: o.relearning_steps, desiredRetention: o.desired_retention,
      maximumInterval: o.maximum_interval, params: o.fsrs_params ?? this.settings.fsrs_params ?? null,
      rolloverHour: this.settings.rollover_hour,
    };
  }

  liveOptions(): DeckOptions[] {
    return [...this.options.values()].filter((o) => !o.deleted_at).sort((a, b) => a.name.localeCompare(b.name));
  }

  static validateOptions(o: Pick<DeckOptions, 'new_per_day' | 'reviews_per_day' | 'learning_steps' | 'relearning_steps' | 'desired_retention' | 'maximum_interval' | 'fsrs_params'>): void {
    const int = (n: number, lo: number, hi: number, label: string) => {
      if (!Number.isInteger(n) || n < lo || n > hi) throw new CollectionError(`${label} must be a whole number between ${lo} and ${hi}`);
    };
    int(o.new_per_day, 0, 9999, 'New cards/day');
    int(o.reviews_per_day, 0, 9999, 'Maximum reviews/day');
    int(o.maximum_interval, 1, 36500, 'Maximum interval');
    if (!(o.desired_retention >= 0.7 && o.desired_retention <= 0.99)) throw new CollectionError('Desired retention must be between 0.70 and 0.99');
    for (const [label, steps] of [['Learning steps', o.learning_steps], ['Relearning steps', o.relearning_steps]] as const) {
      if (steps.length > 10) throw new CollectionError(`${label}: at most 10 steps`);
      let prev = 0;
      for (const s of steps) {
        if (!(s > 0) || s > 60 * 24 * 30) throw new CollectionError(`${label} must be positive minutes (max 30 days)`);
        if (s < prev) throw new CollectionError(`${label} must be in increasing order`);
        prev = s;
      }
    }
    if (o.fsrs_params && (o.fsrs_params.length !== 19 || o.fsrs_params.some((x) => !Number.isFinite(x)))) {
      throw new CollectionError('FSRS parameters must be exactly 19 numbers');
    }
  }

  async saveOptions(opts: DeckOptions): Promise<void> {
    if (!opts.name.trim()) throw new CollectionError('Preset name cannot be empty');
    Collection.validateOptions(opts);
    if (!this.options.has(opts.id)) throw new CollectionError('Preset not found');
    this.save('deck_options', { ...opts, name: opts.name.trim().slice(0, 80) });
    await this.commit();
  }

  async createOptions(name: string, from?: DeckOptions): Promise<DeckOptions> {
    const base = from ?? this.options.get(this.defaultOptionsId)!;
    const ts = this.ts();
    const o = this.save('deck_options', { ...base, id: uuid(), name: name.trim().slice(0, 80) || 'New preset', created_at: ts, updated_at: ts, deleted_at: null });
    await this.commit();
    return o;
  }

  async deleteOptions(id: ID): Promise<void> {
    if (id === this.defaultOptionsId) throw new CollectionError('The default preset cannot be deleted');
    const o = this.options.get(id);
    if (!o) return;
    for (const d of this.decks.values()) if (d.options_id === id) this.save('decks', { ...d, options_id: this.defaultOptionsId });
    this.save('deck_options', { ...o, deleted_at: this.ts() });
    await this.commit();
  }

  async assignOptions(deckId: ID, optionsId: ID, includeSubdecks = false): Promise<void> {
    if (!this.options.has(optionsId) || this.options.get(optionsId)!.deleted_at) throw new CollectionError('Preset not found');
    const ids = includeSubdecks ? this.subtreeIds(deckId) : new Set([deckId]);
    for (const id of ids) {
      const d = this.decks.get(id);
      if (d) this.save('decks', { ...d, options_id: optionsId });
    }
    await this.commit();
  }

  // ------------------------------------------------------------------ note types
  liveTypes(): NoteType[] {
    return [...this.types.values()].filter((t) => !t.deleted_at).sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }

  static validateNoteType(t: Pick<NoteType, 'name' | 'fields' | 'templates'>): void {
    if (!t.name.trim()) throw new CollectionError('Note type name cannot be empty');
    if (t.fields.length < 1 || t.fields.length > 30) throw new CollectionError('A note type needs 1–30 fields');
    const lower = t.fields.map((f) => f.trim().toLowerCase());
    if (lower.some((f) => !f)) throw new CollectionError('Field names cannot be empty');
    if (lower.some((f, i) => lower.indexOf(f) !== i)) throw new CollectionError('Field names must be unique');
    if (t.fields.some((f) => /[{}#^/:]/.test(f))) throw new CollectionError('Field names cannot contain { } # ^ / :');
    if (t.templates.length < 1 || t.templates.length > 20) throw new CollectionError('A note type needs 1–20 card templates');
    for (const tpl of t.templates) {
      if (!tpl.name.trim()) throw new CollectionError('Card template names cannot be empty');
      if (!tpl.front.trim()) throw new CollectionError(`Template "${tpl.name}": front side cannot be empty`);
      for (const side of [tpl.front, tpl.back]) {
        for (const m of side.matchAll(/\{\{([^{}]+?)\}\}/g)) {
          const key = m[1].trim().replace(/^[#^/]/, '').replace(/^(cloze|text):/, '');
          if (key !== 'FrontSide' && key !== 'Tags' && !t.fields.some((f) => f.trim() === key)) {
            throw new CollectionError(`Template "${tpl.name}" refers to unknown field "${key}"`);
          }
        }
      }
    }
  }

  async createNoteType(input: { name: string; fields: string[]; templates: NoteType['templates']; css?: string }, cloneKind: NoteType['kind'] = 'custom'): Promise<NoteType> {
    Collection.validateNoteType(input);
    const ts = this.ts();
    const t = this.save('card_templates', {
      id: uuid(), user_id: this.userId, name: input.name.trim().slice(0, 80), kind: cloneKind, fields: input.fields.map((f) => f.trim()),
      templates: input.templates, css: input.css ?? '', builtin: false, created_at: ts, updated_at: ts, deleted_at: null,
    });
    await this.commit();
    return t;
  }

  async updateNoteType(t: NoteType): Promise<void> {
    const cur = this.types.get(t.id);
    if (!cur) throw new CollectionError('Note type not found');
    if (cur.builtin) throw new CollectionError('Built-in note types cannot be edited; clone one first');
    Collection.validateNoteType(t);
    // Renaming a field must carry the stored values over; a positional rename is the only unambiguous case.
    if (cur.fields.length === t.fields.length) {
      const renames = cur.fields.map((f, i) => [f, t.fields[i].trim()] as const).filter(([a, b]) => a !== b);
      if (renames.length) {
        for (const n of this.notes.values()) {
          if (n.template_id !== t.id) continue;
          const nf: Record<string, string> = {};
          t.fields.forEach((f, i) => { nf[f.trim()] = n.fields[cur.fields[i]] ?? ''; });
          this.save('notes', { ...n, fields: nf });
        }
      }
    }
    this.save('card_templates', { ...t, fields: t.fields.map((f) => f.trim()) });
    await this.commit();
  }

  async deleteNoteType(id: ID): Promise<void> {
    const t = this.types.get(id);
    if (!t) return;
    if (t.builtin) throw new CollectionError('Built-in note types cannot be deleted');
    for (const n of this.notes.values()) if (n.template_id === id && !n.deleted_at) throw new CollectionError('This note type is still used by notes');
    this.save('card_templates', { ...t, deleted_at: this.ts() });
    await this.commit();
  }

  // ------------------------------------------------------------------ notes & cards
  /** Which card ordinals a note should have. Cloze / occlusion ords are 1-based. */
  cardOrdsFor(type: NoteType, fields: Record<string, string>): number[] {
    const nonEmpty = (f: string) => stripHtml(fields[f] ?? '') !== '' || /<(img|audio)\b/i.test(fields[f] ?? '');
    switch (type.kind) {
      case 'basic_reversed': return [0, 1];
      case 'basic_optional_reversed': return nonEmpty('Add Reverse') ? [0, 1] : [0];
      case 'cloze': return clozeNumbers(fields['Text'] ?? '');
      case 'image_occlusion': return parseOcclusions(fields['Occlusions']).map((_, i) => i + 1);
      case 'custom':
        return type.templates
          .map((_, i) => i)
          .filter((i) => stripHtml(renderCard({ fields, tags: [] }, type, i).front) !== '' || /<(img|audio)\b/i.test(renderCard({ fields, tags: [] }, type, i).front));
      default: return [0];
    }
  }

  validateNote(type: NoteType, fields: Record<string, string>): void {
    for (const f of type.fields) {
      const v = fields[f] ?? '';
      if (v.length > MAX_FIELD_LENGTH) throw new CollectionError(`Field "${f}" is too long`);
    }
    const filled = (f: string) => stripHtml(fields[f] ?? '') !== '' || /<(img|audio)\b|media:/i.test(fields[f] ?? '');
    switch (type.kind) {
      case 'cloze':
        if (!filled('Text')) throw new CollectionError('Enter some text');
        if (clozeNumbers(fields['Text']).length === 0) throw new CollectionError('Add at least one cloze, e.g. {{c1::answer}}');
        break;
      case 'multiple_choice':
        if (!filled('Question')) throw new CollectionError('Enter a question');
        if (!filled('Correct')) throw new CollectionError('Enter the correct answer');
        if (!['Wrong 1', 'Wrong 2', 'Wrong 3'].some(filled)) throw new CollectionError('Enter at least one wrong option');
        break;
      case 'image_occlusion':
        if (!/<img\b|media:/i.test(fields['Image'] ?? '')) throw new CollectionError('Add an image');
        if (parseOcclusions(fields['Occlusions']).length === 0) throw new CollectionError('Draw at least one region to hide');
        break;
      case 'image':
        if (!filled('Image')) throw new CollectionError('Add an image');
        break;
      case 'audio':
        if (!filled('Audio')) throw new CollectionError('Add an audio clip');
        break;
      default:
        if (!filled(type.fields[0])) throw new CollectionError(`"${type.fields[0]}" cannot be empty`);
        if (type.kind === 'basic' || type.kind === 'basic_reversed' || type.kind === 'basic_optional_reversed') {
          if (!filled('Back')) throw new CollectionError('"Back" cannot be empty');
        }
    }
    if (this.cardOrdsFor(type, fields).length === 0) throw new CollectionError('These fields would not generate any card');
  }

  /** Existing live notes of the same type whose first field matches (for the "duplicate" warning). */
  findDuplicates(typeId: ID, fields: Record<string, string>, exceptNoteId?: ID): Note[] {
    const type = this.types.get(typeId);
    if (!type) return [];
    const key = stripHtml(fields[type.fields[0]] ?? '').toLowerCase();
    if (!key) return [];
    return [...this.notes.values()].filter(
      (n) => !n.deleted_at && n.id !== exceptNoteId && n.template_id === typeId && stripHtml(n.fields[type.fields[0]] ?? '').toLowerCase() === key,
    );
  }

  async addNote(input: { typeId: ID; deckId: ID; fields: Record<string, string>; tags?: string[] }): Promise<{ note: Note; cards: Card[] }> {
    const type = this.types.get(input.typeId);
    if (!type || type.deleted_at) throw new CollectionError('Note type not found');
    const deck = this.decks.get(input.deckId);
    if (!deck || deck.deleted_at) throw new CollectionError('Deck not found');
    const fields: Record<string, string> = {};
    for (const f of type.fields) fields[f] = input.fields[f] ?? '';
    this.validateNote(type, fields);
    const tags = normalizeTags(input.tags ?? []);
    const ts = this.ts();
    const note = this.save('notes', { id: uuid(), user_id: this.userId, template_id: type.id, fields, tags, guid: uuid(), created_at: ts, updated_at: ts, deleted_at: null });
    const cards = this.cardOrdsFor(type, fields).map((ord) => this.newCard(note.id, deck.id, ord, ts));
    await this.commit();
    return { note, cards };
  }

  private newCard(noteId: ID, deckId: ID, ord: number, ts: string): Card {
    return this.save('cards', {
      id: uuid(), user_id: this.userId, note_id: noteId, deck_id: deckId, ord, ...newCardFields(this.now()), suspended: false,
      created_at: ts, updated_at: ts, deleted_at: null,
    });
  }

  cardsOfNote(noteId: ID): Card[] {
    return [...(this.noteCards.get(noteId) ?? [])].map((id) => this.cards.get(id)!).filter((c) => !c.deleted_at);
  }

  async updateNote(noteId: ID, patch: { fields?: Record<string, string>; tags?: string[] }): Promise<Note> {
    const note = this.notes.get(noteId);
    if (!note || note.deleted_at) throw new CollectionError('Note not found');
    const type = this.types.get(note.template_id)!;
    const fields: Record<string, string> = { ...note.fields };
    if (patch.fields) for (const f of type.fields) if (f in patch.fields) fields[f] = patch.fields[f];
    this.validateNote(type, fields);
    const tags = patch.tags ? normalizeTags(patch.tags) : note.tags;
    const updated = this.save('notes', { ...note, fields, tags });
    // Add cards for newly-required ordinals (new cloze number, "Add Reverse" filled in…). Never delete cards here.
    const existing = this.cardsOfNote(noteId);
    const have = new Set(existing.map((c) => c.ord));
    const deckId = existing[0]?.deck_id ?? this.defaultDeckId;
    const ts = this.ts();
    for (const ord of this.cardOrdsFor(type, fields)) if (!have.has(ord)) this.newCard(noteId, deckId, ord, ts);
    await this.commit();
    return updated;
  }

  /** Cards whose ordinal no longer exists in their note (e.g. a removed cloze). */
  emptyCards(): Card[] {
    const out: Card[] = [];
    for (const c of this.cards.values()) {
      if (c.deleted_at) continue;
      const n = this.notes.get(c.note_id);
      const t = n && this.types.get(n.template_id);
      if (n && t && !this.cardOrdsFor(t, n.fields).includes(c.ord)) out.push(c);
    }
    return out;
  }

  async deleteCards(cardIds: ID[]): Promise<number> {
    const ts = this.ts();
    const notes = new Set<ID>();
    let n = 0;
    for (const id of cardIds) {
      const c = this.cards.get(id);
      if (!c || c.deleted_at) continue;
      this.save('cards', { ...c, deleted_at: ts });
      notes.add(c.note_id);
      n++;
    }
    for (const nid of notes) {
      const note = this.notes.get(nid);
      if (note && !note.deleted_at && this.cardsOfNote(nid).length === 0) this.save('notes', { ...note, deleted_at: ts });
    }
    await this.commit();
    return n;
  }

  async deleteNotes(noteIds: ID[]): Promise<number> {
    const ts = this.ts();
    let n = 0;
    for (const id of noteIds) {
      const note = this.notes.get(id);
      if (!note || note.deleted_at) continue;
      for (const c of this.cardsOfNote(id)) this.save('cards', { ...c, deleted_at: ts });
      this.save('notes', { ...note, deleted_at: ts });
      n++;
    }
    await this.commit();
    return n;
  }

  async duplicateNote(noteId: ID): Promise<{ note: Note; cards: Card[] }> {
    const note = this.notes.get(noteId);
    if (!note || note.deleted_at) throw new CollectionError('Note not found');
    const src = this.cardsOfNote(noteId);
    const type = this.types.get(note.template_id)!;
    const ts = this.ts();
    const copy = this.save('notes', { ...note, id: uuid(), guid: uuid(), fields: { ...note.fields }, tags: [...note.tags], created_at: ts, updated_at: ts, deleted_at: null });
    const deckId = src[0]?.deck_id ?? this.defaultDeckId;
    const ords = this.cardOrdsFor(type, copy.fields);
    const cards = ords.map((o) => this.newCard(copy.id, src.find((c) => c.ord === o)?.deck_id ?? deckId, o, ts));
    await this.commit();
    return { note: copy, cards };
  }

  async moveCards(cardIds: ID[], deckId: ID): Promise<number> {
    const d = this.decks.get(deckId);
    if (!d || d.deleted_at) throw new CollectionError('Deck not found');
    let n = 0;
    for (const id of cardIds) {
      const c = this.cards.get(id);
      if (c && !c.deleted_at && c.deck_id !== deckId) { this.save('cards', { ...c, deck_id: deckId }); n++; }
    }
    await this.commit();
    return n;
  }

  async addTags(noteIds: ID[], tags: string[]): Promise<number> {
    const add = normalizeTags(tags);
    let n = 0;
    for (const id of noteIds) {
      const note = this.notes.get(id);
      if (!note || note.deleted_at) continue;
      const merged = normalizeTags([...note.tags, ...add]);
      if (merged.length !== note.tags.length) { this.save('notes', { ...note, tags: merged }); n++; }
    }
    await this.commit();
    return n;
  }

  async removeTags(noteIds: ID[], tags: string[]): Promise<number> {
    const drop = new Set(tags.map((t) => t.trim().toLowerCase()));
    let n = 0;
    for (const id of noteIds) {
      const note = this.notes.get(id);
      if (!note || note.deleted_at) continue;
      const kept = note.tags.filter((t) => !drop.has(t.toLowerCase()));
      if (kept.length !== note.tags.length) { this.save('notes', { ...note, tags: kept }); n++; }
    }
    await this.commit();
    return n;
  }

  allTags(): { tag: string; count: number }[] {
    return this.memo('allTags', () => {
      const m = new Map<string, { tag: string; count: number }>();
      for (const n of this.notes.values()) {
        if (n.deleted_at) continue;
        for (const t of n.tags) {
          const k = t.toLowerCase();
          const e = m.get(k);
          if (e) e.count++; else m.set(k, { tag: t, count: 1 });
        }
      }
      return [...m.values()].sort((a, b) => a.tag.localeCompare(b.tag));
    });
  }

  async setSuspended(cardIds: ID[], suspended: boolean): Promise<void> {
    for (const id of cardIds) {
      const c = this.cards.get(id);
      if (c && !c.deleted_at && c.suspended !== suspended) this.save('cards', { ...c, suspended });
    }
    await this.commit();
  }

  /** Reset to a brand-new card; review history is kept. */
  async forgetCards(cardIds: ID[]): Promise<void> {
    const now = this.now();
    for (const id of cardIds) {
      const c = this.cards.get(id);
      if (c && !c.deleted_at) this.save('cards', { ...c, ...newCardFields(now) });
    }
    await this.commit();
  }

  /** Make cards due `days` from today (0 = today), keeping their memory state. */
  async setDueInDays(cardIds: ID[], days: number): Promise<void> {
    if (!Number.isInteger(days) || days < 0 || days > 36500) throw new CollectionError('Days must be a whole number between 0 and 36500');
    const due = new Date(dayStart(this.now(), this.settings.rollover_hour).getTime() + (days * 24 + 12) * 3_600_000).toISOString();
    for (const id of cardIds) {
      const c = this.cards.get(id);
      if (!c || c.deleted_at || c.state === CardState.New) continue;
      this.save('cards', { ...c, due });
    }
    await this.commit();
  }

  /**
   * Re-derive scheduling from review history using the CURRENT options/FSRS parameters (after changing
   * parameters or desired retention). The log itself is untouched. Cards without history are skipped.
   */
  async rescheduleFromHistory(cardIds?: ID[]): Promise<number> {
    const byCard = new Map<ID, ReviewLog[]>();
    for (const l of this.logs.values()) {
      if (l.undone) continue;
      const arr = byCard.get(l.card_id);
      if (arr) arr.push(l); else byCard.set(l.card_id, [l]);
    }
    let n = 0;
    const targets = cardIds ?? [...byCard.keys()];
    for (const id of targets) {
      const c = this.cards.get(id);
      const hist = byCard.get(id);
      if (!c || c.deleted_at || !hist?.length) continue;
      hist.sort((a, b) => a.reviewed_at.localeCompare(b.reviewed_at));
      const opts = this.schedulerOptionsFor(c.deck_id);
      let f = newCardFields(new Date(hist[0].reviewed_at));
      for (const l of hist) f = schedule(f, l.rating, new Date(l.reviewed_at), opts).card;
      this.save('cards', { ...c, ...f });
      n++;
    }
    await this.commit();
    return n;
  }

  // ------------------------------------------------------------------ study queue
  private todayLogs(): { newDone: Map<ID, number>; reviewDone: Map<ID, number>; noteCards: Map<ID, Set<ID>> } {
    return this.memo('todayLogs', () => {
      const start = dayStart(this.now(), this.settings.rollover_hour).toISOString();
      const newDone = new Map<ID, number>();
      const reviewDone = new Map<ID, number>();
      const nc = new Map<ID, Set<ID>>();
      for (const l of this.logs.values()) {
        if (l.undone || l.reviewed_at < start) continue;
        if (l.state === CardState.New) newDone.set(l.deck_id, (newDone.get(l.deck_id) ?? 0) + 1);
        else if (l.state === CardState.Review) reviewDone.set(l.deck_id, (reviewDone.get(l.deck_id) ?? 0) + 1);
        const card = this.cards.get(l.card_id);
        if (card) {
          const s = nc.get(card.note_id);
          if (s) s.add(card.id); else nc.set(card.note_id, new Set([card.id]));
        }
      }
      return { newDone, reviewDone, noteCards: nc };
    }, true);
  }

  /** Build today's queue for a deck subtree (or every top-level deck when `deckId` is null). */
  buildQueue(deckId: ID | null): StudyQueue {
    const now = this.now();
    const rollover = this.settings.rollover_hour;
    const endMs = dayEnd(now, rollover).getTime();
    const today = this.todayLogs();
    const roots = deckId ? [deckId] : this.childrenOf(null).map((d) => d.id);
    const learning: Card[] = [];
    const review: Card[] = [];
    const fresh: Card[] = [];

    for (const root of roots) {
      const ids = this.subtreeIds(root);
      const opts = this.optionsFor(root);
      let newDone = 0, reviewDone = 0;
      for (const id of ids) { newDone += today.newDone.get(id) ?? 0; reviewDone += today.reviewDone.get(id) ?? 0; }
      const newLeft = Math.max(0, opts.new_per_day - newDone);
      const reviewLeft = Math.max(0, opts.reviews_per_day - reviewDone);

      const rv: Card[] = [];
      const nw: Card[] = [];
      for (const c of this.cards.values()) {
        if (c.deleted_at || c.suspended || !ids.has(c.deck_id)) continue;
        const buried = ((): boolean => {
          const s = today.noteCards.get(c.note_id);
          return !!s && [...s].some((x) => x !== c.id);
        })();
        switch (c.state) {
          case CardState.New: if (!buried) nw.push(c); break;
          case CardState.Review: if (!buried && new Date(c.due).getTime() < endMs) rv.push(c); break;
          default: if (new Date(c.due).getTime() < endMs) learning.push(c);
        }
      }
      rv.sort((a, b) => a.due.localeCompare(b.due));
      nw.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ord - b.ord);
      const takeOnePerNote = (list: Card[], limit: number): Card[] => {
        const seen = new Set<ID>();
        const out: Card[] = [];
        for (const c of list) {
          if (out.length >= limit) break;
          if (seen.has(c.note_id)) continue;
          seen.add(c.note_id);
          out.push(c);
        }
        return out;
      };
      review.push(...takeOnePerNote(rv, reviewLeft));
      fresh.push(...takeOnePerNote(nw, newLeft));
    }
    learning.sort((a, b) => a.due.localeCompare(b.due));
    return { learning, review, new: fresh, counts: { new: fresh.length, learning: learning.length, review: review.length } };
  }

  /** Next card to show: due learning → reviews → new → learn-ahead. */
  nextCard(q: StudyQueue): { card: Card | null; waitingUntil: Date | null } {
    const nowMs = this.now().getTime();
    const due = q.learning.find((c) => new Date(c.due).getTime() <= nowMs);
    if (due) return { card: due, waitingUntil: null };
    if (q.review.length) return { card: q.review[0], waitingUntil: null };
    if (q.new.length) return { card: q.new[0], waitingUntil: null };
    const ahead = q.learning[0];
    if (ahead) {
      const t = new Date(ahead.due).getTime();
      if (t <= nowMs + LEARN_AHEAD_MINUTES * MS_MINUTE) return { card: ahead, waitingUntil: null };
      return { card: null, waitingUntil: new Date(t) };
    }
    return { card: null, waitingUntil: null };
  }

  queueItem(card: Card): QueueItem {
    const note = this.notes.get(card.note_id)!;
    return { card, note, type: this.types.get(note.template_id)! };
  }

  preview(card: Card): SchedulePreview {
    return previewAll(card, this.now(), this.schedulerOptionsFor(card.deck_id));
  }

  async answerCard(cardId: ID, rating: RatingValue, durationMs: number): Promise<{ card: Card; log: ReviewLog }> {
    const card = this.cards.get(cardId);
    if (!card || card.deleted_at) throw new CollectionError('Card not found');
    if (![1, 2, 3, 4].includes(rating)) throw new CollectionError('Invalid rating');
    const now = this.now();
    const res = schedule(card, rating, now, this.schedulerOptionsFor(card.deck_id));
    const before: Card = { ...card };
    const updated = this.save('cards', { ...card, ...res.card });
    const ts = this.ts();
    const log = this.save('review_logs', {
      id: uuid(), user_id: this.userId, card_id: card.id, deck_id: card.deck_id, rating,
      state: before.state as CardStateValue, stability: res.card.stability, difficulty: res.card.difficulty,
      elapsed_days: res.elapsed_days, scheduled_days: res.card.scheduled_days,
      duration_ms: Math.max(0, Math.min(Math.round(durationMs) || 0, 120_000)),
      reviewed_at: now.toISOString(), undone: false, created_at: ts, updated_at: ts,
    });
    this.undoStack.push({ cardBefore: before, logId: log.id });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    await this.commit();
    return { card: updated, log };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Revert the most recent answer. The review log is kept and flagged `undone` (history is never deleted). */
  async undoLastAnswer(): Promise<Card | null> {
    const e = this.undoStack.pop();
    if (!e) return null;
    const log = this.logs.get(e.logId);
    if (log && !log.undone) this.save('review_logs', { ...log, undone: true });
    const restored = this.save('cards', { ...e.cardBefore });
    await this.commit();
    return restored;
  }

  // ------------------------------------------------------------------ counts
  /** Per-deck counts including sub-decks, with daily limits applied to new/review (like the Anki deck list). */
  deckCounts(): Map<ID, DeckCounts> {
    return this.memo('deckCounts', () => {
      const now = this.now();
      const endMs = dayEnd(now, this.settings.rollover_hour).getTime();
      const today = this.todayLogs();
      type Own = { total: number; newAvail: number; learn: number; review: number; suspended: number; mature: number };
      const own = new Map<ID, Own>();
      const get = (id: ID): Own => { let o = own.get(id); if (!o) own.set(id, (o = { total: 0, newAvail: 0, learn: 0, review: 0, suspended: 0, mature: 0 })); return o; };
      for (const c of this.cards.values()) {
        if (c.deleted_at) continue;
        const o = get(c.deck_id);
        o.total++;
        if (c.suspended) { o.suspended++; continue; }
        if (c.state === CardState.New) o.newAvail++;
        else if (c.state === CardState.Review) { if (new Date(c.due).getTime() < endMs) o.review++; if (isMature(c)) o.mature++; }
        else if (new Date(c.due).getTime() < endMs) o.learn++;
      }
      const result = new Map<ID, DeckCounts>();
      const walk = (n: DeckTreeNode): { total: number; newAvail: number; learn: number; review: number; suspended: number; mature: number; newDone: number; reviewDone: number; newShown: number; reviewShown: number } => {
        const o = own.get(n.deck.id) ?? { total: 0, newAvail: 0, learn: 0, review: 0, suspended: 0, mature: 0 };
        const acc = { ...o, newDone: today.newDone.get(n.deck.id) ?? 0, reviewDone: today.reviewDone.get(n.deck.id) ?? 0, newShown: 0, reviewShown: 0 };
        let newShown = 0, reviewShown = 0;
        for (const ch of n.children) {
          const r = walk(ch);
          acc.total += r.total; acc.newAvail += r.newAvail; acc.learn += r.learn; acc.review += r.review;
          acc.suspended += r.suspended; acc.mature += r.mature; acc.newDone += r.newDone; acc.reviewDone += r.reviewDone;
          newShown += r.newShown; reviewShown += r.reviewShown;
        }
        const opts = this.optionsFor(n.deck.id);
        const newCap = Math.max(0, opts.new_per_day - acc.newDone);
        const revCap = Math.max(0, opts.reviews_per_day - acc.reviewDone);
        const newNow = Math.min(acc.newAvail, newCap);
        const revNow = Math.min(acc.review, revCap);
        acc.newShown = newNow; acc.reviewShown = revNow;
        result.set(n.deck.id, { total: acc.total, new: newNow, learning: acc.learn, review: revNow, due: acc.learn + revNow, suspended: acc.suspended, mature: acc.mature });
        return acc;
      };
      for (const root of this.deckTree()) walk(root);
      return result;
    }, true);
  }

  /** Counts across every deck (home screen / "study all"). */
  totalCounts(): DeckCounts {
    const t: DeckCounts = { total: 0, new: 0, learning: 0, review: 0, due: 0, suspended: 0, mature: 0 };
    const counts = this.deckCounts();
    for (const root of this.deckTree()) {
      const c = counts.get(root.deck.id);
      if (!c) continue;
      for (const k of Object.keys(t) as (keyof DeckCounts)[]) t[k] += c[k];
    }
    return t;
  }

  // ------------------------------------------------------------------ browsing / search
  liveCards(): Card[] {
    return this.memo('liveCards', () => [...this.cards.values()].filter((c) => !c.deleted_at && !this.notes.get(c.note_id)?.deleted_at));
  }

  liveLogs(): ReviewLog[] {
    return this.memo('liveLogs', () => [...this.logs.values()].filter((l) => !l.undone));
  }

  searchCards(query: string, opts: { sort?: BrowseSort; desc?: boolean; offset?: number; limit?: number } = {}): { total: number; rows: BrowseRow[]; warnings: string[] } {
    const q = compileQuery(query);
    const now = this.now();
    const ctx = {
      now, rolloverEnd: dayEnd(now, this.settings.rollover_hour),
      deckPath: (id: ID) => this.deckPath(id),
      lastRated: /rated:/i.test(query) ? lastRatedMap(this.logs.values()) : undefined,
    };
    const matched: Card[] = [];
    for (const c of this.liveCards()) {
      const n = this.notes.get(c.note_id)!;
      const t = this.types.get(n.template_id);
      if (t && q.test(c, n, t, ctx)) matched.push(c);
    }
    const sort = opts.sort ?? 'created';
    const dir = opts.desc === false ? 1 : -1;
    const rowOf = (c: Card): BrowseRow => {
      const note = this.notes.get(c.note_id)!;
      const type = this.types.get(note.template_id)!;
      return { card: c, note, type, deckPath: this.deckPath(c.deck_id), preview: previewText(note, type, c.ord) };
    };
    let rows: BrowseRow[] | null = null;
    const key: Record<BrowseSort, (c: Card) => string | number> = {
      created: (c) => c.created_at, reviewed: (c) => c.last_review ?? '', due: (c) => (c.state === CardState.New ? '9999' : c.due),
      interval: (c) => c.scheduled_days, lapses: (c) => c.lapses, reps: (c) => c.reps, deck: (c) => this.deckPath(c.deck_id).toLowerCase(),
      front: (c) => '',
    };
    if (sort === 'front') {
      rows = matched.map(rowOf).sort((a, b) => dir * a.preview.localeCompare(b.preview));
    } else {
      const k = key[sort];
      matched.sort((a, b) => {
        const x = k(a), y = k(b);
        return dir * (x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id));
      });
    }
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const page = rows ? rows.slice(offset, offset + limit) : matched.slice(offset, offset + limit).map(rowOf);
    return { total: matched.length, rows: page, warnings: q.warnings };
  }

  /** All cards matching a query (ids only) — used by "select all N results" bulk actions. */
  searchIds(query: string): ID[] {
    const r = this.searchCards(query, { limit: Number.MAX_SAFE_INTEGER });
    return r.rows.map((x) => x.card.id);
  }

  globalSearch(text: string, limit = 8): { decks: Deck[]; cards: BrowseRow[] } {
    const t = text.trim().toLowerCase();
    if (!t) return { decks: [], cards: [] };
    const decks = this.liveDecks().filter((d) => this.deckPath(d.id).toLowerCase().includes(t)).slice(0, limit);
    const r = this.searchCards(text, { limit });
    return { decks, cards: r.rows };
  }

  render(card: Card): { front: string; back: string; css: string } {
    const { note, type } = this.queueItem(card);
    return renderCard(note, type, card.ord);
  }
}

export function parseOcclusions(raw: string | undefined): { x: number; y: number; w: number; h: number; label?: string }[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(stripHtml(raw).replace(/&quot;/g, '"')) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r): r is { x: number; y: number; w: number; h: number; label?: string } =>
        !!r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every((k) => typeof (r as Record<string, unknown>)[k] === 'number'))
      .map((r) => ({ x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h), label: typeof r.label === 'string' ? r.label.slice(0, 100) : undefined }))
      .filter((r) => r.w > 0.005 && r.h > 0.005)
      .slice(0, 100);
  } catch {
    return [];
  }
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
