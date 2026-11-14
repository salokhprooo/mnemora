import { useEffect, useState } from 'react';
import { useApp, useCollection } from '../../store/app';
import { Collection, CollectionError } from '../../db/collection';
import { DEFAULT_PARAMS, PARAM_COUNT } from '../../lib/fsrs';
import type { DeckOptions } from '../../types';
import { Modal } from '../ui/Modal';
import { Button, Field, Input, Select, Switch, Textarea } from '../ui/primitives';
import { Plus, Trash2 } from '../ui/icons';
import { parseSteps, stepsToText } from '../../lib/steps';

interface Form {
  name: string;
  new_per_day: string;
  reviews_per_day: string;
  learning_steps: string;
  relearning_steps: string;
  desired_retention: string;
  maximum_interval: string;
  fsrs: string;
}

const toForm = (o: DeckOptions): Form => ({
  name: o.name,
  new_per_day: String(o.new_per_day),
  reviews_per_day: String(o.reviews_per_day),
  learning_steps: stepsToText(o.learning_steps),
  relearning_steps: stepsToText(o.relearning_steps),
  desired_retention: String(o.desired_retention),
  maximum_interval: String(o.maximum_interval),
  fsrs: o.fsrs_params ? o.fsrs_params.join(', ') : '',
});

export function DeckOptionsModal({ deckId, onClose }: { deckId: string | null; onClose: () => void }) {
  const { toast, confirm } = useApp();
  const col = useCollection();
  const [presetId, setPresetId] = useState<string>('');
  const [form, setForm] = useState<Form | null>(null);
  const [subdecks, setSubdecks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!deckId) return;
    const o = col.optionsFor(deckId);
    setPresetId(o.id);
    setForm(toForm(o));
    setError(null);
    setSubdecks(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  if (!deckId || !form) return <Modal open={false} onClose={onClose} title="Deck options">{null}</Modal>;
  const deck = col.decks.get(deckId)!;
  const presets = col.liveOptions();
  const current = col.options.get(presetId);
  const assigned = col.optionsFor(deckId).id === presetId;
  const set = (k: keyof Form, v: string) => {
    setForm({ ...form, [k]: v });
    setError(null);
  };

  const choose = (id: string) => {
    setPresetId(id);
    const o = col.options.get(id);
    if (o) setForm(toForm(o));
    setError(null);
  };

  const parse = (): DeckOptions => {
    const num = (label: string, v: string): number => {
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n)) throw new CollectionError(`${label} must be a number`);
      return n;
    };
    let fsrs: number[] | null = null;
    if (form.fsrs.trim()) {
      fsrs = form.fsrs.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (fsrs.length !== PARAM_COUNT || fsrs.some((x) => !Number.isFinite(x))) throw new CollectionError(`FSRS parameters need exactly ${PARAM_COUNT} numbers (or leave empty to use the defaults).`);
    }
    return {
      ...current!,
      name: form.name.trim(),
      new_per_day: Math.round(num('New cards/day', form.new_per_day)),
      reviews_per_day: Math.round(num('Maximum reviews/day', form.reviews_per_day)),
      learning_steps: parseSteps(form.learning_steps),
      relearning_steps: parseSteps(form.relearning_steps),
      desired_retention: num('Desired retention', form.desired_retention),
      maximum_interval: Math.round(num('Maximum interval', form.maximum_interval)),
      fsrs_params: fsrs,
    };
  };

  const save = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const o = parse();
      Collection.validateOptions(o);
      await col.saveOptions(o);
      if (!assigned) await col.assignOptions(deckId, presetId, subdecks);
      else if (subdecks) await col.assignOptions(deckId, presetId, true);
      toast('success', 'Deck options saved');
      onClose();
    } catch (e) {
      setError(e instanceof CollectionError ? e.message : 'Could not save the options');
    } finally {
      setBusy(false);
    }
  };

  const addPreset = async () => {
    const name = window.prompt('Name for the new preset', `Preset ${presets.length + 1}`);
    if (!name?.trim()) return;
    try {
      const o = await col.createOptions(name.trim(), current);
      choose(o.id);
    } catch (e) {
      setError(e instanceof CollectionError ? e.message : 'Could not create the preset');
    }
  };

  const removePreset = async () => {
    if (!current) return;
    const ok = await confirm({ title: `Delete preset “${current.name}”?`, message: 'Decks using it fall back to the default preset.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await col.deleteOptions(current.id);
      choose(col.optionsFor(deckId).id);
    } catch (e) {
      setError(e instanceof CollectionError ? e.message : 'Could not delete the preset');
    }
  };

  const reschedule = async () => {
    const ids = [...col.subtreeIds(deckId)];
    const ok = await confirm({
      title: 'Reschedule from review history?',
      message: 'Recomputes every card’s memory state in this deck from its full review history using the current retention and FSRS parameters. Review history itself is never changed.',
      confirmLabel: 'Reschedule',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const cards = col.liveCards().filter((c) => ids.includes(c.deck_id)).map((c) => c.id);
      const n = await col.rescheduleFromHistory(cards);
      toast('success', `Rescheduled ${n} card${n === 1 ? '' : 's'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Options · ${deck.name}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Preset" className="min-w-[12rem] flex-1">
            <Select value={presetId} onChange={(e) => choose(e.target.value)} aria-label="Options preset">
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={() => void addPreset()} icon={<Plus className="h-4 w-4" />}>
            Clone as new
          </Button>
          <Button variant="ghost" className="text-again" onClick={() => void removePreset()} disabled={presets.length <= 1 || presetId === col.defaultOptionsId} icon={<Trash2 className="h-4 w-4" />}>
            Delete
          </Button>
        </div>
        <Field label="Preset name">
          <Input value={form.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
        </Field>
        {!assigned && <p className="rounded-lg bg-brand/10 px-3 py-2 text-sm text-brand">Saving will switch “{deck.name}” to this preset.</p>}
        <Switch label="Apply to all sub-decks too" checked={subdecks} onChange={setSubdecks} />

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Daily limits</legend>
          <Field label="New cards / day" hint="Applies to this deck and its sub-decks together">
            <Input type="number" inputMode="numeric" min={0} max={9999} value={form.new_per_day} onChange={(e) => set('new_per_day', e.target.value)} />
          </Field>
          <Field label="Maximum reviews / day">
            <Input type="number" inputMode="numeric" min={0} max={99999} value={form.reviews_per_day} onChange={(e) => set('reviews_per_day', e.target.value)} />
          </Field>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Steps</legend>
          <Field label="Learning steps" hint="Minutes, space separated. Add h or d for hours / days. Example: 1 10">
            <Input value={form.learning_steps} onChange={(e) => set('learning_steps', e.target.value)} placeholder="1 10" />
          </Field>
          <Field label="Relearning steps" hint="Used after you press Again on a review card">
            <Input value={form.relearning_steps} onChange={(e) => set('relearning_steps', e.target.value)} placeholder="10" />
          </Field>
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">FSRS scheduling</legend>
          <Field label={`Desired retention: ${Math.round(Number(form.desired_retention || 0) * 100)}%`} hint="Higher = more reviews, fewer forgotten cards. 90% is a good start.">
            <input type="range" min={0.7} max={0.99} step={0.01} value={Number(form.desired_retention) || 0.9} onChange={(e) => set('desired_retention', e.target.value)} className="w-full accent-[rgb(var(--c-brand))]" aria-label="Desired retention" />
          </Field>
          <Field label="Maximum interval (days)" hint="Cards never wait longer than this. 36500 = 100 years.">
            <Input type="number" inputMode="numeric" min={1} max={36500} value={form.maximum_interval} onChange={(e) => set('maximum_interval', e.target.value)} />
          </Field>
          <Field className="sm:col-span-2" label={`FSRS parameters (${PARAM_COUNT} numbers)`} hint="Leave empty to use your global parameters or the defaults. Optimised parameters from an FSRS optimiser can be pasted here.">
            <Textarea value={form.fsrs} onChange={(e) => set('fsrs', e.target.value)} className="font-mono text-xs" rows={3} placeholder={DEFAULT_PARAMS.join(', ')} />
          </Field>
          <div className="sm:col-span-2">
            <Button size="sm" onClick={() => set('fsrs', '')}>Use default parameters</Button>
          </div>
        </fieldset>

        <div className="rounded-xl border border-line bg-raised p-3 text-sm">
          <div className="font-medium">Reschedule from history</div>
          <p className="mb-2 text-xs text-mute">After changing retention or parameters, recompute due dates for the cards in this deck.</p>
          <Button size="sm" onClick={() => void reschedule()} disabled={busy}>Reschedule cards</Button>
        </div>

        {error && <p role="alert" className="rounded-lg bg-again/10 px-3 py-2 text-sm text-again">{error}</p>}
      </div>
    </Modal>
  );
}
