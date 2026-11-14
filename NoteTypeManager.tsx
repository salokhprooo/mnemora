import { useState } from 'react';
import { useApp, useCollection } from '../../store/app';
import { Collection, CollectionError } from '../../db/collection';
import type { CardTemplateDef, NoteType } from '../../types';
import { renderCard } from '../../lib/render';
import { Modal } from '../ui/Modal';
import { CardHtml } from './CardView';
import { Badge, Button, Field, Input, Select, Textarea } from '../ui/primitives';
import { Copy, Pencil, Plus, Trash2, X } from '../ui/icons';

interface Draft {
  id: string | null; // null → new
  kind: NoteType['kind'];
  name: string;
  fields: string[];
  templates: CardTemplateDef[];
  css: string;
}

const blankTemplate = (fields: string[]): CardTemplateDef => ({ name: 'Card 1', front: `{{${fields[0]}}}`, back: `{{FrontSide}}<hr id="answer">{{${fields[1] ?? fields[0]}}}` });

/** Create / edit custom note types (fields + card templates + CSS). Built-in types can be cloned, not edited. */
export function NoteTypeManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, confirm } = useApp();
  const col = useCollection();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleIdx, setSampleIdx] = useState(0);

  const startNew = () => setDraft({ id: null, kind: 'custom', name: 'My note type', fields: ['Front', 'Back'], templates: [blankTemplate(['Front', 'Back'])], css: '.card { text-align: center; }' });
  const clone = (t: NoteType) => setDraft({ id: null, kind: t.kind, name: `${t.name} copy`, fields: [...t.fields], templates: t.templates.map((x) => ({ ...x })), css: t.css });
  const edit = (t: NoteType) => setDraft({ id: t.id, kind: t.kind, name: t.name, fields: [...t.fields], templates: t.templates.map((x) => ({ ...x })), css: t.css });
  const close = () => {
    setDraft(null);
    setError(null);
    onClose();
  };

  const save = async () => {
    if (!draft) return;
    try {
      const input = { name: draft.name, fields: draft.fields, templates: draft.templates, css: draft.css };
      Collection.validateNoteType(input);
      if (draft.id) {
        const cur = col.types.get(draft.id)!;
        await col.updateNoteType({ ...cur, ...input, name: draft.name.trim() });
      } else await col.createNoteType(input, draft.kind);
      toast('success', 'Note type saved');
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(e instanceof CollectionError ? e.message : 'Could not save the note type');
    }
  };

  const remove = async (t: NoteType) => {
    const ok = await confirm({ title: `Delete “${t.name}”?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await col.deleteNoteType(t.id);
      toast('success', 'Note type deleted');
    } catch (e) {
      toast('error', e instanceof CollectionError ? e.message : 'Could not delete');
    }
  };

  const upd = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setError(null);
  };

  const sampleFields = (d: Draft) => Object.fromEntries(d.fields.map((f, i) => [f, i === 0 ? `Sample ${f}` : `Sample ${f} ${i}`]));
  const previewTemplate = draft ? draft.templates[Math.min(sampleIdx, draft.templates.length - 1)] : null;
  let preview: { front: string; back: string } | null = null;
  if (draft && previewTemplate) {
    try {
      preview = renderCard({ fields: sampleFields(draft), tags: [] }, { kind: 'custom', css: '', templates: [previewTemplate] }, 0);
    } catch {
      preview = null;
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={draft ? (draft.id ? 'Edit note type' : 'New note type') : 'Note types'}
      size="xl"
      footer={
        draft ? (
          <>
            <Button onClick={() => { setDraft(null); setError(null); }}>Back</Button>
            <Button variant="primary" onClick={() => void save()}>Save note type</Button>
          </>
        ) : (
          <Button onClick={close}>Done</Button>
        )
      }
    >
      {!draft ? (
        <div className="space-y-3">
          <div className="flex justify-between gap-2">
            <p className="text-sm text-mute">Note types define the fields of a note and the cards generated from it.</p>
            <Button variant="primary" size="sm" onClick={startNew} icon={<Plus className="h-4 w-4" />}>New</Button>
          </div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {col.liveTypes().map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    <span className="truncate">{t.name}</span>
                    {t.builtin && <Badge>Built-in</Badge>}
                  </div>
                  <div className="truncate text-xs text-mute">{t.fields.join(' · ')} — {t.templates.length} template{t.templates.length === 1 ? '' : 's'}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => clone(t)} icon={<Copy className="h-4 w-4" />}>Clone</Button>
                {!t.builtin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => edit(t)} icon={<Pencil className="h-4 w-4" />}>Edit</Button>
                    <Button size="sm" variant="ghost" className="text-again" onClick={() => void remove(t)} aria-label={`Delete ${t.name}`} icon={<Trash2 className="h-4 w-4" />} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-5">
          <Field label="Name"><Input value={draft.name} maxLength={80} onChange={(e) => upd({ name: e.target.value })} /></Field>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold">Fields</legend>
            <p className="text-xs text-mute">Rename fields in place to keep your data. Do not rename and add/remove fields in the same save.</p>
            {draft.fields.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={`Field ${i + 1} name`} value={f} maxLength={40} onChange={(e) => upd({ fields: draft.fields.map((x, j) => (j === i ? e.target.value : x)) })} />
                <button type="button" aria-label={`Remove field ${f}`} disabled={draft.fields.length <= 1} className="rounded-md p-2 text-mute hover:bg-again/10 hover:text-again disabled:opacity-30" onClick={() => upd({ fields: draft.fields.filter((_, j) => j !== i) })}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button size="sm" onClick={() => upd({ fields: [...draft.fields, `Field ${draft.fields.length + 1}`] })} icon={<Plus className="h-4 w-4" />}>Add field</Button>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-semibold">Card templates</legend>
            <p className="text-xs text-mute">
              Use <code className="kbd">{'{{Field}}'}</code>, <code className="kbd">{'{{FrontSide}}'}</code>, <code className="kbd">{'{{cloze:Field}}'}</code>, <code className="kbd">{'{{#Field}}…{{/Field}}'}</code> (only if filled), <code className="kbd">{'{{^Field}}…{{/Field}}'}</code> (only if empty).
            </p>
            {draft.templates.map((t, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-line p-3">
                <div className="flex items-center gap-2">
                  <Input aria-label={`Template ${i + 1} name`} value={t.name} maxLength={60} onChange={(e) => upd({ templates: draft.templates.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Button size="sm" variant="ghost" className="text-again" disabled={draft.templates.length <= 1} onClick={() => upd({ templates: draft.templates.filter((_, j) => j !== i) })} icon={<Trash2 className="h-4 w-4" />} aria-label="Remove template" />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Front"><Textarea className="font-mono text-xs" rows={4} value={t.front} onChange={(e) => upd({ templates: draft.templates.map((x, j) => (j === i ? { ...x, front: e.target.value } : x)) })} /></Field>
                  <Field label="Back"><Textarea className="font-mono text-xs" rows={4} value={t.back} onChange={(e) => upd({ templates: draft.templates.map((x, j) => (j === i ? { ...x, back: e.target.value } : x)) })} /></Field>
                </div>
              </div>
            ))}
            <Button size="sm" onClick={() => upd({ templates: [...draft.templates, { name: `Card ${draft.templates.length + 1}`, front: `{{${draft.fields[0]}}}`, back: `{{FrontSide}}<hr id="answer">{{${draft.fields[1] ?? draft.fields[0]}}}` }] })} icon={<Plus className="h-4 w-4" />}>Add template</Button>
          </fieldset>

          <Field label="Styling (CSS)" hint="Scoped to this note type. url(), @import and scripts are removed for safety.">
            <Textarea className="font-mono text-xs" rows={4} value={draft.css} onChange={(e) => upd({ css: e.target.value })} />
          </Field>

          {preview && previewTemplate && (
            <div className="rounded-xl border border-line bg-raised p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold">Preview with sample data</span>
                {draft.templates.length > 1 && (
                  <Select className="max-w-[10rem] py-1" value={sampleIdx} onChange={(e) => setSampleIdx(Number(e.target.value))} aria-label="Template to preview">
                    {draft.templates.map((t, i) => <option key={i} value={i}>{t.name}</option>)}
                  </Select>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-line bg-surface p-4 text-center"><CardHtml html={preview.front} css={draft.css} /></div>
                <div className="rounded-lg border border-line bg-surface p-4 text-center"><CardHtml html={preview.back} css={draft.css} /></div>
              </div>
            </div>
          )}
          {error && <p role="alert" className="rounded-lg bg-again/10 px-3 py-2 text-sm text-again">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
