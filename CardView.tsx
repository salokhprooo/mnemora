import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card, Note, NoteType } from '../../types';
import { sanitizeCss, sanitizeHtml } from '../../lib/sanitize';
import { renderCard, stripHtml } from '../../lib/render';
import { parseOcclusions } from '../../db/collection';
import { seededRandom, shuffled } from '../../lib/ids';
import { useApp } from '../../store/app';
import { cx } from '../ui/primitives';
import { Check, X } from '../ui/icons';

// ------------------------------------------------------------------------------------------------ safe HTML
/** Sanitise card HTML, then swap `media:` references for blob URLs once the files are available. */
export function useResolvedHtml(html: string): string {
  const { media } = useApp();
  const clean = useMemo(() => sanitizeHtml(html), [html]);
  const [resolved, setResolved] = useState(clean);
  useEffect(() => {
    let off = false;
    setResolved(clean);
    void media.resolveHtml(clean).then((r) => {
      if (!off) setResolved(r);
    });
    return () => {
      off = true;
    };
  }, [clean, media]);
  return resolved;
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function CardHtml({ html, css = '', className }: { html: string; css?: string; className?: string }) {
  const resolved = useResolvedHtml(html);
  const scope = 'cs' + hashStr(css);
  const scoped = useMemo(() => (css.trim() ? sanitizeCss(css, '.' + scope) : ''), [css, scope]);
  return (
    <>
      {scoped && <style>{scoped}</style>}
      <div className={cx('card-face', scope, className)} dangerouslySetInnerHTML={{ __html: resolved }} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------ multiple choice
export function mcqOptions(note: Note, seed: string): { text: string; correct: boolean }[] {
  const f = note.fields;
  const raw = [
    { text: f['Correct'] ?? '', correct: true },
    ...(['Wrong 1', 'Wrong 2', 'Wrong 3'] as const).map((k) => ({ text: f[k] ?? '', correct: false })),
  ].filter((o) => stripHtml(o.text) !== '' || /<img\b|media:/i.test(o.text));
  return shuffled(raw, seededRandom(seed));
}

function McqView({ card, note, type, revealed, picked, onPick }: { card: Card; note: Note; type: NoteType; revealed: boolean; picked: number | null; onPick: (i: number) => void }) {
  const options = useMemo(() => mcqOptions(note, `${card.id}:${card.reps}`), [card.id, card.reps, note]);
  return (
    <div className="w-full">
      <CardHtml html={note.fields['Question'] ?? ''} css={type.css} />
      <ol className="mx-auto mt-5 grid max-w-xl gap-2 text-left" role="listbox" aria-label="Answer options">
        {options.map((o, i) => {
          const isPicked = picked === i;
          const state = !revealed ? 'idle' : o.correct ? 'right' : isPicked ? 'wrong' : 'dim';
          return (
            <li key={i}>
              <button
                type="button"
                role="option"
                aria-selected={isPicked}
                disabled={revealed}
                onClick={() => onPick(i)}
                className={cx(
                  'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition',
                  state === 'idle' && 'border-line bg-surface hover:border-brand hover:bg-brand/5 active:scale-[0.99]',
                  state === 'right' && 'border-good bg-good/10',
                  state === 'wrong' && 'border-again bg-again/10',
                  state === 'dim' && 'border-line opacity-60',
                )}
              >
                <span className="kbd shrink-0">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <CardHtml html={o.text} className="!text-left text-[0.9em]" />
                </span>
                {state === 'right' && <Check className="h-5 w-5 shrink-0 text-good" aria-label="Correct" />}
                {state === 'wrong' && <X className="h-5 w-5 shrink-0 text-again" aria-label="Your answer" />}
              </button>
            </li>
          );
        })}
      </ol>
      {revealed && stripHtml(note.fields['Explanation'] ?? '') !== '' && (
        <div className="mx-auto mt-4 max-w-xl rounded-xl bg-raised p-3 text-left text-sm">
          <CardHtml html={note.fields['Explanation']} css={type.css} className="!text-left" />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ image occlusion
export function OcclusionView({ note, ord, revealed, interactive = false }: { note: Note; ord: number; revealed: boolean; interactive?: boolean }) {
  const regions = useMemo(() => parseOcclusions(note.fields['Occlusions']), [note.fields]);
  const html = useResolvedHtml(note.fields['Image'] ?? '');
  const src = useMemo(() => /<img[^>]+src="([^"]+)"/i.exec(html)?.[1] ?? '', [html]);
  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="relative inline-block max-w-full select-none align-top">
        {src ? <img src={src} alt="Image with hidden regions" className="block max-h-[60dvh] max-w-full rounded-lg" draggable={false} /> : <div className="skeleton h-48 w-72" />}
        {regions.map((r, i) => {
          const active = i + 1 === ord;
          if (revealed && !interactive) {
            return active ? (
              <div key={i} className="absolute rounded-sm border-2 border-good bg-good/10" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} aria-label={r.label ?? 'Revealed region'} />
            ) : null;
          }
          return (
            <div
              key={i}
              className={cx('absolute flex items-center justify-center rounded-sm text-xs font-bold', active ? 'bg-brand text-brand-ink ring-2 ring-white/70' : 'bg-ink/70 text-white/80')}
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            >
              {active ? '?' : ''}
            </div>
          );
        })}
      </div>
      {stripHtml(note.fields['Header'] ?? '') !== '' && <CardHtml html={note.fields['Header']} className="mt-3 text-base" />}
      {revealed && stripHtml(note.fields['Extra'] ?? '') !== '' && <CardHtml html={note.fields['Extra']} className="mt-2 text-sm text-mute" />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ flip card
export interface FlipCardProps {
  card: Card;
  note: Note;
  type: NoteType;
  revealed: boolean;
  fontSize: number;
  maxWidth: number;
  autoPlay: boolean;
  picked: number | null;
  onPick: (i: number) => void;
  onTapFront?: () => void;
}

export function FlipCard({ card, note, type, revealed, fontSize, maxWidth, autoPlay, picked, onPick, onTapFront }: FlipCardProps) {
  const rendered = useMemo(() => renderCard(note, type, card.ord), [note, type, card.ord]);
  const root = useRef<HTMLDivElement>(null);
  const special = type.kind === 'multiple_choice' || type.kind === 'image_occlusion';
  const flipsInPlace = !special;

  // Auto-play the first audio clip of whichever face just became visible.
  useEffect(() => {
    if (!autoPlay) return;
    const t = setTimeout(() => {
      const faces = root.current?.querySelectorAll<HTMLElement>('.flip-face');
      const face = faces ? faces[flipsInPlace && revealed ? 1 : 0] : null;
      const audio = (special ? root.current : face)?.querySelector('audio');
      audio?.play().catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [card.id, revealed, autoPlay, special, flipsInPlace]);

  const faceCls = 'flex min-h-[16rem] w-full items-center justify-center rounded-xl2 border border-line bg-surface p-6 text-center shadow-card sm:min-h-[20rem] sm:p-10';
  const style = { fontSize: `${fontSize}px`, maxWidth: `${maxWidth}px` };

  if (type.kind === 'multiple_choice') {
    return (
      <div ref={root} className={cx(faceCls, 'mx-auto')} style={style}>
        <McqView card={card} note={note} type={type} revealed={revealed} picked={picked} onPick={onPick} />
      </div>
    );
  }
  if (type.kind === 'image_occlusion') {
    return (
      <div ref={root} className={cx(faceCls, 'mx-auto')} style={style}>
        <OcclusionView note={note} ord={card.ord} revealed={revealed} />
      </div>
    );
  }
  return (
    <div ref={root} className="flip-scene mx-auto w-full" style={{ maxWidth: `${maxWidth}px` }}>
      <div className={cx('flip-card grid', revealed && 'flipped')} onClick={!revealed ? onTapFront : undefined}>
        <div className={cx('flip-face [grid-area:1/1]', faceCls)} style={{ fontSize: `${fontSize}px` }} aria-hidden={revealed}>
          <CardHtml html={rendered.front} css={type.css} className="w-full" />
        </div>
        <div className={cx('flip-face flip-back [grid-area:1/1]', faceCls)} style={{ fontSize: `${fontSize}px` }} aria-hidden={!revealed}>
          <CardHtml html={rendered.back} css={type.css} className="w-full" />
        </div>
      </div>
    </div>
  );
}
