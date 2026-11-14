/** Shared domain types. These mirror the Postgres schema in supabase/migrations. */

export type ID = string;
/** ISO-8601 UTC timestamp with milliseconds, e.g. 2026-11-05T18:46:52.679Z. Sorts lexicographically. */
export type ISODate = string;

export const CardState = { New: 0, Learning: 1, Review: 2, Relearning: 3 } as const;
export type CardStateValue = (typeof CardState)[keyof typeof CardState];

export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const;
export type RatingValue = (typeof Rating)[keyof typeof Rating];

export interface Timestamps {
  created_at: ISODate;
  updated_at: ISODate;
  /** Soft-delete tombstone. Needed so deletions can sync to other devices. */
  deleted_at: ISODate | null;
}

export interface Profile {
  id: ID;
  display_name: string;
  avatar_url: string | null;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Deck extends Timestamps {
  id: ID;
  user_id: ID;
  parent_id: ID | null;
  /** Leaf name only; the full path "A::B::C" is derived from parent links. */
  name: string;
  description: string;
  options_id: ID | null;
  is_public: boolean;
  position: number;
}

export interface DeckOptions extends Timestamps {
  id: ID;
  user_id: ID;
  name: string;
  new_per_day: number;
  reviews_per_day: number;
  /** Minutes, e.g. [1, 10]. */
  learning_steps: number[];
  relearning_steps: number[];
  desired_retention: number;
  maximum_interval: number;
  /** null → use the user's global FSRS parameters (or library defaults). */
  fsrs_params: number[] | null;
}

export type NoteKind =
  | 'basic'
  | 'basic_reversed'
  | 'basic_optional_reversed'
  | 'cloze'
  | 'multiple_choice'
  | 'image'
  | 'image_occlusion'
  | 'audio'
  | 'custom';

export interface CardTemplateDef {
  name: string;
  front: string;
  back: string;
}

/** A "note type": field list plus one or more card templates. Row of `card_templates`. */
export interface NoteType extends Timestamps {
  id: ID;
  user_id: ID;
  name: string;
  kind: NoteKind;
  fields: string[];
  templates: CardTemplateDef[];
  css: string;
  builtin: boolean;
}

export interface Note extends Timestamps {
  id: ID;
  user_id: ID;
  template_id: ID;
  fields: Record<string, string>;
  tags: string[];
  /** Stable id used to de-duplicate on import. */
  guid: string;
}

export interface Card extends Timestamps {
  id: ID;
  user_id: ID;
  note_id: ID;
  deck_id: ID;
  /** Template index, or cloze number (1-based) for cloze notes. */
  ord: number;
  state: CardStateValue;
  due: ISODate;
  stability: number;
  difficulty: number;
  scheduled_days: number;
  /** Index into learning/relearning steps while state is Learning/Relearning. */
  step: number;
  reps: number;
  lapses: number;
  last_review: ISODate | null;
  suspended: boolean;
}

export interface ReviewLog {
  id: ID;
  user_id: ID;
  card_id: ID;
  deck_id: ID;
  rating: RatingValue;
  /** State of the card BEFORE this review. */
  state: CardStateValue;
  /** Memory state AFTER this review. */
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  duration_ms: number;
  reviewed_at: ISODate;
  /** Set when the user pressed Undo. History is never deleted. */
  undone: boolean;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface Tag {
  id: ID;
  user_id: ID;
  name: string;
  created_at: ISODate;
  updated_at: ISODate;
  deleted_at: ISODate | null;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type Language = 'en' | 'uz' | 'ru';

export interface ShortcutMap {
  showAnswer: string;
  again: string;
  hard: string;
  good: string;
  easy: string;
  undo: string;
}

export interface UserSettings {
  theme: ThemeMode;
  language: Language;
  daily_goal: number;
  reminders_enabled: boolean;
  reminder_time: string; // HH:MM, local
  show_intervals: boolean;
  show_timer: boolean;
  /** 4 = Again/Hard/Good/Easy, 2 = Again/Good only. */
  answer_buttons: 2 | 4;
  auto_play_audio: boolean;
  card_font_size: number; // px
  card_max_width: number; // px
  rollover_hour: number; // next day starts at this local hour
  compact: boolean;
  shortcuts: ShortcutMap;
  /** User-wide FSRS parameters (null → defaults). */
  fsrs_params: number[] | null;
  auto_sync: boolean;
}

export interface UserSettingsRow {
  user_id: ID;
  settings: UserSettings;
  created_at: ISODate;
  updated_at: ISODate;
}

/** Tables that take part in cloud synchronisation. */
export type SyncTable = 'decks' | 'deck_options' | 'card_templates' | 'notes' | 'cards' | 'review_logs' | 'user_settings';

export const SYNC_TABLES: SyncTable[] = [
  'deck_options',
  'card_templates',
  'decks',
  'notes',
  'cards',
  'review_logs',
  'user_settings',
];

export interface OutboxEntry {
  /** `${table}:${recordId}` — coalesces repeated edits to the same record. */
  key: string;
  table: SyncTable;
  record_id: ID;
  queued_at: ISODate;
}

export interface SyncConflict {
  id: string;
  table: SyncTable;
  record_id: ID;
  local: unknown;
  remote: unknown;
  /** Which side the automatic resolver kept. */
  auto_kept: 'local' | 'remote';
  detected_at: ISODate;
  resolved: boolean;
}

export interface QueueCounts {
  new: number;
  learning: number;
  review: number;
}

export interface DeckCounts extends QueueCounts {
  total: number;
  due: number;
  suspended: number;
  mature: number;
}
