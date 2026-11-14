import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCollection } from '../../store/app';
import { CollectionError, validateTag } from '../../db/collection';
import { renderCard } from '../../lib/render';
import { CardState, type Card, type Note, type NoteType } from '../../types';
import { RichEditor } from './RichEditor';
import { OcclusionEditor } from './OcclusionEditor';
import { CardHtml, FlipCard } from './CardView';
import { Button, Field, Select, Switch, cx } from '../ui/primitives';
import { AlertTriangle, Copy, Eye, EyeOff, Tag, Trash2, X } from '../ui/icons';

const DRAFT_KEY = 'mnemora.draft.v1';

interface Draft {
  typeId: string;
  deckId: string;
  fields: Record<string, string>;
  tags: string[];
}

const readDraft = (): Draft | null => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null;
    return d && typeof d === 'object' && d.fields ? d : null;
  } catch {
    return null;
  }
};
const writeDraft = (d: Draft | null) => {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
};
const isBlank = (fields: Record<string, string>) => Object.values(fields).every((v) => !v || v.replace(/<[^>]*>/g, '').trim() === '' && !/<(img|audio)/.test(v) && !/media:/.test(v));

export const fakeCard = (ord: number): Card => ({
  id: 'preview', user_id: '', note_id: 'preview', deck_id: '', ord, state: CardState.New, due: new Date().toISOString(), stability: 0, difficulty: 0,
  scheduled_days: 0, step: 0, reps: 0, lapses: 0, last_review: null, suspended: false, created_at: '', updated_at: '', deleted_at: null,
});

interface Props {
  /** Edit an existing note. Omit to create a new one. */
  noteId?: string;
  defaultDeckId?: string | null;
  defaultTypeId?: string | null;
  onDone?: () => void;
  onSaved?: () => void;
}

export function NoteEditor({ noteId, defaultDeckId, defaultTypeId, onDone, onSaved }: Props) {
  const { toast, confirm } = useApp();
  const col = useCollection();
  const editing = noteId ? col.notes.get(noteId) : undefined;
  const types = col.liveTypes();
  const decks = useMemo(() => col.liveDecks().sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id))), [col, col.version]);

  const initial = useMemo<Draft>(() => {
    if (editing) {
      const cards = col.cardsOfNote(editing.id).filter((c) => !c.deleted_at);
      return { typeId: editing.template_id, deckId: cards[0]?.deck_id ?? col.defaultDeckId, fields: { ...editing.fields }, tags: [...editing.tags] };
    }
    return {
      typeId: defaultTypeId && col.types.get(defaultTypeId) ? defaultTypeId : (types.find((t) => t.kind === 'basic') ?? types[0]).id,
      deckId: defaultDeckId && col.decks.get(defaultDeckId) ? defaultDeckId : (localStorage.getItem('mnemora.lastDeck') && col.decks.get(localStorage.getItem('mnemora.lastDeck')!) ? localStorage.getItem('mnemora.lastDeck')! : col.defaultDeckId),
      fields: {},
      tags: [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  const [typeId, setTypeId] = useState(initial.typeId);
  const [deckId, setDeckId] = useState(initial.deckId);
  const [fields, setFields] = useState<Record<string, string>>(initial.fields);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const type: NoteType = col.types.get(typeId) ?? types[0];

  // ---- draft: restore once, then auto-save while typing (new notes only)
  const restored = useRef(false);
  useEffect(() => {
    if (editing || restored.current) return;
    restored.current = true;
    const d = readDraft();
    if (d && col.types.get(d.typeId) && !isBlank(d.fields)) {
      setTypeId(d.typeId);
      if (col.decks.get(d.deckId)) setDeckId(d.deckId);
      setFields(d.fields);
      setTags(d.tags ?? []);
      setResetKey((k) => k + 1);
      toast('info', 'Restored your unsaved draft', { label: 'Discard', run: () => { writeDraft(null); setFields({}); setTags([]); setResetKey((k) => k + 1); } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (editing) return;
    const t = setTimeout(() => writeDraft(isBlank(fields) && tags.length === 0 ? null : { typeId, deckId, fields, tags }), 500);
    return () => clearTimeout(t);
  }, [fields, tags, typeId, deckId, editing]);

  const setField = useCallback((name: string, v: string) => {
    setFields((f) => (f[name] === v ? f : { ...f, [name]: v }));
    setError(null);
  }, []);

  // ---- tags
  const addTag = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).filter(Boolean);
    if (!parts.length) return;
    try {
      const next = [...tags];
      for (const p of parts) {
        const t = validateTag(p);
        if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
      }
      setTags(next);
      setTagInput('');
    } catch (e) {
      toast('error', e instanceof CollectionError ? e.message : 'Invalid tag');
    }
  };
  const knownTags = useMemo(() => col.allTags().map((t) => t.tag), [col, col.version]);

  // ---- derived
  const duplicates = useMemo(() => col.findDuplicates(typeId, fields, noteId), [col, typeId, fields, noteId, col.version]);
  const previewOrds = useMemo(() => {
    try {
      return col.cardOrdsFor(type, fields);
    } catch {
      return [];
    }
  }, [col, type, fields]);

  // ---- actions
  const submitRef = useRef<(another: boolean) => void>(() => undefined);
  const submit = async (another: boolean) => {
    if (saving) return;
    setError(null);
    try {
      col.validateNote(type, fields);
    } catch (e) {
      setError(e instanceof CollectionError ? e.message : 'Check the fields and try again');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await col.updateNote(editing.id, { fields, tags });
        const cards = col.cardsOfNote(editing.id).filter((c) => !c.deleted_at && c.deck_id !== deckId);
        if (cards.length) await col.moveCards(cards.map((c) => c.id), deckId);
        toast('success', 'Card saved');
        onSaved?.();
        onDone?.();
      } else {
        const res = await col.addNote({ typeId, deckId, fields, tags });
        try { localStorage.setItem('mnemora.lastDeck', deckId); } catch { /* ignore */ }
        writeDraft(null);
        toast('success', `Added ${res.cards.length} card${res.cards.length === 1 ? '' : 's'} to ${col.deckPath(deckId)}`);
        onSaved?.();
        // Like Anki's Add window: stay open for the next card (tags and deck are kept).
        setFields({});
        setResetKey((k) => k + 1);
      }
    } catch (e) {
      setError(e instanceof CollectionError ? e.message : 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };
  submitRef.current = (another) => void submit(another);

  const duplicateNote = async () => {
    if (!editing) return;
    const res = await col.duplicateNote(editing.id);
    toast('success', 'Duplicated');
    onSaved?.();
    if (res) onDone?.();
  };
  const remove = async () => {
    if (!editing) return;
    const ok = await confirm({ title: 'Delete this note?', message: 'All of its cards will be deleted. Review history is kept.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await col.deleteNotes([editing.id]);
    toast('success', 'Note deleted');
    onSaved?.();
    onDone?.();
  };
  const cancel = async () => {
    if (!editing && !isBlank(fields)) {
      const ok = await confirm({ title: 'Discard this card?', message: 'What you typed will be lost.', confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    if (!editing) writeDraft(null);
    onDone?.();
  };

  const onSubmit = () => submitRef.current(false);
  const rich = (name: string, opts: { cloze?: boolean; minHeight?: string; placeholder?: string; media?: boolean } = {}) => (
    <Field key={name} label={name}>
      <RichEditor label={name} value={fields[name] ?? ''} onChange={(v) => setField(name, v)} resetKey={`${noteId ?? 'new'}:${resetKey}:${typeId}`} onSubmit={onSubmit} {...opts} />
    </Field>
  );

  const fieldEditors = () => {
    switch (type.kind) {
      case 'cloze':
        return (
          <>
            {rich('Text', { cloze: true, placeholder: 'The {{c1::mitochondria}} is the {{c2::powerhouse}} of the cell', minHeight: '8rem' })}
            {rich('Extra')}
          </>
        );
      case 'multiple_choice':
        return (
          <>
            {rich('Question')}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-good/40 bg-good/5 p-3">{rich('Correct', { minHeight: '2.75rem' })}</div>
              {['Wrong 1', 'Wrong 2', 'Wrong 3'].map((n) => (
                <div key={n} className="rounded-xl border border-line p-3">{rich(n, { minHeight: '2.75rem' })}</div>
              ))}
            </div>
            {rich('Explanation', { minHeight: '3rem' })}
          </>
        );
      case 'image_occlusion':
        return (
          <>
            {rich('Image', { placeholder: 'Insert an image with the toolbar, paste or drop one here' })}
            <Field label="Regions to hide">
              <OcclusionEditor imageHtml={fields['Image'] ?? ''} value={fields['Occlusions'] ?? ''} onChange={(v) => setField('Occlusions', v)} />
            </Field>
            {rich('Header', { minHeight: '2.75rem', media: false })}
            {rich('Extra', { minHeight: '3rem' })}
          </>
        );
      case 'basic_optional_reversed':
        return (
          <>
            {rich('Front')}
            {rich('Back')}
            <Switch
              label="Also create the reversed card"
              description="Adds a second card with Back on the front"
              checked={!!(fields['Add Reverse'] ?? '').trim()}
              onChange={(v) => setField('Add Reverse', v ? 'y' : '')}
            />
          </>
        );
      default:
        return type.fields.map((f) => rich(f, { media: true }));
    }
  };

  if (noteId && !editing) return <p className="text-sm text-mute">This card no longer exists.</p>;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Card type">
          {editing ? (
            <div className="input bg-raised">{type.name}</div>
          ) : (
            <Select
              value={typeId}
              onChange={(e) => {
                setTypeId(e.target.value);
                setError(null);
              }}
              aria-label="Card type"
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Deck">
          <Select value={deckId} onChange={(e) => setDeckId(e.target.value)} aria-label="Deck">
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {col.deckPath(d.id)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {fieldEditors()}

      <Field label="Tags" hint="Press Enter or space to add. Use :: for hierarchy, e.g. lang::spanish">
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25">
          <Tag className="ml-1 h-4 w-4 text-mute" />
          {tags.map((t) => (
            <span key={t} className="chip !bg-brand/10 !text-brand">
              {t}
              <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            list="known-tags"
            value={tagInput}
            onChange={(e) => (/[\s,;]$/.test(e.target.value) ? addTag(e.target.value) : setTagInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag(tagInput);
              } else if (e.key === 'Backspace' && !tagInput && tags.length) setTags(tags.slice(0, -1));
            }}
            onBlur={() => tagInput && addTag(tagInput)}
            aria-label="Add a tag"
            placeholder={tags.length ? '' : 'Add tags…'}
            className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none"
          />
          <datalist id="known-tags">
            {knownTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
      </Field>

      {duplicates.length > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-learnc/10 px-3 py-2 text-sm text-learnc">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          You already have {duplicates.length === 1 ? 'a card' : `${duplicates.length} cards`} with this {type.fields[0].toLowerCase()}. You can still save it.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-again/10 px-3 py-2 text-sm text-again">
          {error}
        </p>
      )}

      {preview && (
        <div className="space-y-4 rounded-xl border border-line bg-raised p-4" aria-label="Card preview">
          <h3 className="text-sm font-semibold">Preview · {previewOrds.length} card{previewOrds.length === 1 ? '' : 's'}</h3>
          {previewOrds.length === 0 && <p className="text-sm text-mute">Fill in the fields to see the generated cards.</p>}
          {previewOrds.map((ord) => {
            const noteLike = { fields, tags } as Pick<Note, 'fields' | 'tags'>;
            if (type.kind === 'multiple_choice' || type.kind === 'image_occlusion') {
              return <FlipCard key={ord} card={fakeCard(ord)} note={noteLike as Note} type={type} revealed={false} fontSize={18} maxWidth={640} autoPlay={false} picked={null} onPick={() => undefined} />;
            }
            const r = renderCard(noteLike, type, ord);
            return (
              <div key={ord} className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-line bg-surface p-4 text-center"><div className="mb-1 text-[11px] font-semibold uppercase text-mute">Front</div><CardHtml html={r.front} css={type.css} /></div>
                <div className="rounded-lg border border-line bg-surface p-4 text-center"><div className="mb-1 text-[11px] font-semibold uppercase text-mute">Back</div><CardHtml html={r.back} css={type.css} /></div>
              </div>
            );
          })}
        </div>
      )}

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 px-1 py-3 backdrop-blur">
        <Button type="submit" variant="primary" loading={saving}>
          {editing ? 'Save changes' : 'Add card'}
        </Button>
        <Button onClick={() => setPreview((p) => !p)} icon={preview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} aria-pressed={preview}>
          Preview
        </Button>
        {editing && (
          <>
            <Button onClick={() => void duplicateNote()} icon={<Copy className="h-4 w-4" />}>
              Duplicate
            </Button>
            <Button variant="ghost" className="text-again" onClick={() => void remove()} icon={<Trash2 className="h-4 w-4" />}>
              Delete
            </Button>
          </>
        )}
        <Button variant="ghost" className={cx('ml-auto')} onClick={() => void cancel()}>
          Cancel
        </Button>
        <span className="hidden text-xs text-mute lg:block">Ctrl/⌘ + Enter to save</span>
      </div>
    </form>
  );
}
