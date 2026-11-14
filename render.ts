/**
 * Template rendering (Anki-style mustache subset).
 *   {{Field}}              field value (rich-text HTML from the editor)
 *   {{cloze:Field}}        cloze rendering for the card's cloze number
 *   {{text:Field}}         field with HTML stripped
 *   {{FrontSide}}          the rendered front (back templates only)
 *   {{Tags}}               space-joined note tags
 *   {{#Field}}…{{/Field}}  shown only if Field is non-empty
 *   {{^Field}}…{{/Field}}  shown only if Field is empty
 *
 * The returned strings are UNSANITISED HTML. Always pass them through sanitizeHtml() (see lib/sanitize.ts)
 * before inserting into the DOM.
 */
import type { CardTemplateDef, Note, NoteType } from '../types';
import { renderCloze } from './cloze';

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const isEmptyField = (v: string | undefined): boolean => !v || stripHtml(v) === '' && !/<(img|audio|video)\b/i.test(v);

export interface RenderContext {
  fields: Record<string, string>;
  tags: string[];
  clozeNumber: number;
  frontSide?: string;
}

function renderSide(tpl: string, ctx: RenderContext, side: 'front' | 'back'): string {
  // Conditional sections first (non-nested, repeated until stable to allow simple nesting).
  let out = tpl;
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/\{\{#([^{}]+?)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_a, f: string, body: string) =>
        isEmptyField(ctx.fields[f.trim()]) ? '' : body,
      )
      .replace(/\{\{\^([^{}]+?)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_a, f: string, body: string) =>
        isEmptyField(ctx.fields[f.trim()]) ? body : '',
      );
    if (next === out) break;
    out = next;
  }
  return out.replace(/\{\{([^{}]+?)\}\}/g, (_all, raw: string) => {
    const key = raw.trim();
    if (key === 'FrontSide') return ctx.frontSide ?? '';
    if (key === 'Tags') return escapeHtml(ctx.tags.join(' '));
    if (key.startsWith('cloze:')) return renderCloze(ctx.fields[key.slice(6).trim()] ?? '', ctx.clozeNumber, side);
    if (key.startsWith('text:')) return escapeHtml(stripHtml(ctx.fields[key.slice(5).trim()] ?? ''));
    return ctx.fields[key] ?? '';
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface RenderedCard {
  front: string;
  back: string;
  css: string;
}

/** Which template applies to a card of `ord` (cloze notes always use template 0 with cloze number = ord). */
export function templateFor(type: Pick<NoteType, 'kind' | 'templates'>, ord: number): CardTemplateDef {
  if (type.kind === 'cloze' || type.kind === 'image_occlusion') return type.templates[0];
  return type.templates[Math.min(ord, type.templates.length - 1)];
}

export function renderCard(note: Pick<Note, 'fields' | 'tags'>, type: Pick<NoteType, 'kind' | 'templates' | 'css'>, ord: number): RenderedCard {
  const tpl = templateFor(type, ord);
  const clozeNumber = type.kind === 'cloze' ? Math.max(1, ord) : 1;
  const base: RenderContext = { fields: note.fields, tags: note.tags, clozeNumber };
  const front = renderSide(tpl.front, base, 'front');
  const back = renderSide(tpl.back, { ...base, frontSide: front }, 'back');
  return { front, back, css: type.css };
}

/** Plain-text preview of a card's front, for lists. */
export function previewText(note: Pick<Note, 'fields' | 'tags'>, type: Pick<NoteType, 'kind' | 'templates' | 'css' | 'fields'>, ord: number): string {
  if (type.kind === 'image_occlusion') return stripHtml(note.fields['Header'] ?? '') || '🖼 Image occlusion';
  if (type.kind === 'multiple_choice') return stripHtml(note.fields['Question'] ?? '');
  const t = stripHtml(renderCard(note, type, ord).front);
  if (t) return t;
  if (/<img\b/i.test(note.fields[type.fields[0]] ?? '')) return '🖼 Image';
  if (/<audio\b|media:/i.test(note.fields[type.fields[0]] ?? '')) return '🔊 Audio';
  return '';
}
