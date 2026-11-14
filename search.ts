/**
 * Card search with an Anki-like query language.
 *
 *   word            note text contains "word" (case-insensitive, all fields)
 *   "two words"     phrase
 *   -term           negation (works on every term)
 *   deck:Spanish    deck or any sub-deck (full path, case-insensitive; * wildcard)
 *   tag:verbs       note has tag (tag:none = untagged; hierarchical "a::b" also matches "a")
 *   type:cloze      note-type kind (basic, cloze, …) or note-type name
 *   is:new|learn|review|due|suspended|mature|young|leech
 *   added:N         created in the last N days
 *   rated:N         answered in the last N days
 *   prop:ivl>=21    interval (days) comparison; also prop:reps, prop:lapses, prop:ease(difficulty)
 *   front:/back:    not supported; use plain text
 *
 * All terms are AND-ed; "or" between terms makes an OR group.
 */
import type { Card, Note, NoteType, ReviewLog } from '../types';
import { CardState } from '../types';
import { stripHtml } from './render';
import { MS_DAY } from './time';

export interface SearchContext {
  now: Date;
  deckPath(deckId: string): string;
  /** Latest non-undone review time per card id (ms), for rated:N. */
  lastRated?: Map<string, number>;
  rolloverEnd: Date;
}

type Pred = (c: Card, n: Note, t: NoteType, ctx: SearchContext, haystack: () => string) => boolean;

export interface CompiledQuery {
  test(c: Card, n: Note, t: NoteType, ctx: SearchContext): boolean;
  /** Parse errors (unknown terms are treated as plain text instead, so this is usually empty). */
  warnings: string[];
}

export function tokenize(q: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch; // keep quotes so the term parser knows it was a phrase
    } else if (/\s/.test(ch) && !inQuote) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function wildcardRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s.replace(/"/g, '');
}

function cmp(op: string, a: number, b: number): boolean {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    case '!=': return a !== b;
    default: return a === b;
  }
}

function compileTerm(raw: string, warnings: string[]): Pred {
  let negate = false;
  let term = raw;
  if (term.startsWith('-') && term.length > 1) {
    negate = true;
    term = term.slice(1);
  }
  const wrap = (p: Pred): Pred => (negate ? (c, n, t, x, h) => !p(c, n, t, x, h) : p);

  const m = /^([a-z]+):(.*)$/i.exec(term);
  if (m && !term.startsWith('"')) {
    const key = m[1].toLowerCase();
    const val = unquote(m[2]);
    switch (key) {
      case 'deck': {
        const re = wildcardRegex(val);
        const sub = wildcardRegex(val + '::*');
        return wrap((c, _n, _t, x) => {
          const p = x.deckPath(c.deck_id);
          return re.test(p) || sub.test(p);
        });
      }
      case 'tag': {
        if (val.toLowerCase() === 'none') return wrap((_c, n) => n.tags.length === 0);
        const re = wildcardRegex(val);
        const sub = wildcardRegex(val + '::*');
        return wrap((_c, n) => n.tags.some((tg) => re.test(tg) || sub.test(tg)));
      }
      case 'type':
      case 'note': {
        const v = val.toLowerCase();
        return wrap((_c, _n, t) => t.kind === v || t.name.toLowerCase() === v || t.name.toLowerCase().includes(v));
      }
      case 'is': {
        switch (val.toLowerCase()) {
          case 'new': return wrap((c) => c.state === CardState.New);
          case 'learn': return wrap((c) => c.state === CardState.Learning || c.state === CardState.Relearning);
          case 'review': return wrap((c) => c.state === CardState.Review);
          case 'suspended': return wrap((c) => c.suspended);
          case 'due':
            return wrap((c, _n, _t, x) => c.state !== CardState.New && !c.suspended && new Date(c.due).getTime() < x.rolloverEnd.getTime());
          case 'mature': return wrap((c) => c.state === CardState.Review && c.scheduled_days >= 21);
          case 'young': return wrap((c) => c.state === CardState.Review && c.scheduled_days < 21);
          case 'leech': return wrap((c) => c.lapses >= 8);
          default:
            warnings.push(`Unknown filter is:${val}`);
            return () => false;
        }
      }
      case 'added': {
        const days = Number(val);
        if (!Number.isFinite(days)) { warnings.push(`added:${val} needs a number`); return () => false; }
        return wrap((c, _n, _t, x) => new Date(c.created_at).getTime() >= x.now.getTime() - days * MS_DAY);
      }
      case 'rated': {
        const days = Number(val);
        if (!Number.isFinite(days)) { warnings.push(`rated:${val} needs a number`); return () => false; }
        return wrap((c, _n, _t, x) => (x.lastRated?.get(c.id) ?? 0) >= x.now.getTime() - days * MS_DAY);
      }
      case 'prop': {
        const pm = /^(ivl|reps|lapses|ease|difficulty|stability)(>=|<=|!=|>|<|=)(-?\d+(?:\.\d+)?)$/i.exec(val);
        if (!pm) { warnings.push(`Cannot parse prop:${val}`); return () => false; }
        const [, field, op, numStr] = pm;
        const num = Number(numStr);
        const get = (c: Card): number => {
          switch (field.toLowerCase()) {
            case 'ivl': return c.scheduled_days;
            case 'reps': return c.reps;
            case 'lapses': return c.lapses;
            case 'stability': return c.stability;
            default: return c.difficulty;
          }
        };
        return wrap((c) => cmp(op, get(c), num));
      }
      default:
        break; // fall through: treat "foo:bar" as plain text
    }
  }

  const needle = unquote(term).toLowerCase();
  if (!needle) return () => true;
  return wrap((_c, _n, _t, _x, hay) => hay().includes(needle));
}

export function compileQuery(q: string): CompiledQuery {
  const warnings: string[] = [];
  const tokens = tokenize(q.trim());
  // Split on bare "or" into AND-groups.
  const groups: Pred[][] = [[]];
  for (const tok of tokens) {
    if (tok.toLowerCase() === 'or') groups.push([]);
    else groups[groups.length - 1].push(compileTerm(tok, warnings));
  }
  const nonEmpty = groups.filter((g) => g.length > 0);
  return {
    warnings,
    test(c, n, t, ctx) {
      if (nonEmpty.length === 0) return true;
      let cache: string | null = null;
      const hay = () => (cache ??= (Object.values(n.fields).map(stripHtml).join(' \u0001 ') + ' ' + n.tags.join(' ')).toLowerCase());
      return nonEmpty.some((g) => g.every((p) => p(c, n, t, ctx, hay)));
    },
  };
}

export function lastRatedMap(logs: Iterable<ReviewLog>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of logs) {
    if (l.undone) continue;
    const t = new Date(l.reviewed_at).getTime();
    if ((m.get(l.card_id) ?? 0) < t) m.set(l.card_id, t);
  }
  return m;
}
