import { useRef, useState } from 'react';
import { useApp, useCollection } from '../store/app';
import {
  ImportError, MAX_IMPORT_BYTES, createBackup, downloadName, exportCsv, exportJsonNotes, guessMapping, importCsv, importJsonNotes, parseBackup, parseCsv,
  restoreBackup, validateMapping, type Backup, type CsvMapping, type ImportReport, type RestoreReport,
} from '../lib/portability';
import { Modal } from '../components/ui/Modal';
import { Badge, Button, Field, Input, PageHeader, Section, Select, Switch } from '../components/ui/primitives';
import { AlertTriangle, CheckCircle2, Database, Download, FileText, Upload } from '../components/ui/icons';

export function saveBlob(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

type Pending =
  | { kind: 'csv'; name: string; rows: string[][] }
  | { kind: 'notes'; name: string; text: string }
  | { kind: 'backup'; name: string; backup: Backup }
  | null;

export default function DataPage() {
  const { toast } = useApp();
  const col = useCollection();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportDeck, setExportDeck] = useState('');
  const [exportType, setExportType] = useState('');
  const decks = col.liveDecks().sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id)));

  const readFile = async (file: File) => {
    setError(null);
    const lower = file.name.toLowerCase();
    try {
      if (/\.(apkg|colpkg)$/.test(lower)) {
        throw new ImportError('Anki package files (.apkg / .colpkg) are not supported yet. In Anki, use File → Export → “Notes in Plain Text” (.txt) and import that file here instead.');
      }
      if (file.size > MAX_IMPORT_BYTES) throw new ImportError('This file is larger than 25 MB.');
      if (file.size === 0) throw new ImportError('This file is empty.');
      const text = await file.text();
      if (text.includes('\u0000')) throw new ImportError('This looks like a binary file, not a text or JSON file.');
      if (lower.endsWith('.json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
        let doc: unknown;
        try {
          doc = JSON.parse(text);
        } catch {
          throw new ImportError('This file is not valid JSON.');
        }
        if (doc && typeof doc === 'object' && (doc as { format?: string }).format === 'mnemora-backup') {
          setPending({ kind: 'backup', name: file.name, backup: parseBackup(text) });
        } else setPending({ kind: 'notes', name: file.name, text });
        return;
      }
      const rows = parseCsv(text);
      if (rows.length === 0) throw new ImportError('No rows were found in this file.');
      setPending({ kind: 'csv', name: file.name, rows });
    } catch (e) {
      setError(e instanceof ImportError ? e.message : 'Could not read this file.');
    }
  };

  const download = (kind: 'csv' | 'json' | 'backup') => {
    try {
      if (kind === 'csv') {
        const { csv, notes } = exportCsv(col, { deckId: exportDeck || null, typeId: exportType || null });
        if (!notes) return toast('info', 'There are no cards to export for that selection.');
        saveBlob(downloadName('mnemora-cards', 'csv'), csv, 'text/csv;charset=utf-8');
        toast('success', `Exported ${notes} note${notes === 1 ? '' : 's'}`);
      } else if (kind === 'json') {
        const { json, notes } = exportJsonNotes(col, exportDeck || null);
        if (!notes) return toast('info', 'There are no cards to export for that selection.');
        saveBlob(downloadName('mnemora-notes', 'json'), json, 'application/json');
        toast('success', `Exported ${notes} note${notes === 1 ? '' : 's'}`);
      } else {
        const b = createBackup(col);
        saveBlob(downloadName('mnemora-backup', 'json'), JSON.stringify(b), 'application/json');
        toast('success', `Backup saved (${b.counts.cards} cards, ${b.counts.review_logs} reviews)`);
      }
    } catch {
      toast('error', 'Export failed');
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Import / Export" subtitle="Move cards in and out, and keep full backups of your collection" />

      <div className="space-y-5">
        <Section title="Import" description="CSV / TSV / text files, Mnemora JSON and Mnemora backups">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void readFile(f); }}
            className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-10 text-center transition ${dragOver ? 'border-brand bg-brand/5' : 'border-line'}`}
          >
            <Upload className="h-8 w-8 text-brand" />
            <div>
              <p className="font-medium">Drop a file here</p>
              <p className="text-sm text-mute">.csv · .tsv · .txt · .json · Mnemora backup</p>
            </div>
            <Button variant="primary" onClick={() => fileInput.current?.click()}>Choose file…</Button>
            <input ref={fileInput} type="file" hidden accept=".csv,.tsv,.txt,.json,.apkg,.colpkg,text/*,application/json" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFile(f); }} />
          </div>
          {error && <p role="alert" className="flex items-start gap-2 rounded-lg bg-again/10 px-3 py-2 text-sm text-again"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
          <p className="text-xs text-mute">
            Anki <b>.apkg</b> import is <b>not implemented yet</b> (it needs a zipped SQLite reader that could not be tested in this build). Export from Anki as plain text and import that here: fields, tags and decks are preserved, scheduling is not.
          </p>
        </Section>

        <Section title="Export" description="Download your cards. Backups include scheduling and full review history.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Deck"><Select value={exportDeck} onChange={(e) => setExportDeck(e.target.value)} aria-label="Deck to export"><option value="">All decks</option>{decks.map((d) => <option key={d.id} value={d.id}>{col.deckPath(d.id)}</option>)}</Select></Field>
            <Field label="Card type (CSV only)"><Select value={exportType} onChange={(e) => setExportType(e.target.value)} aria-label="Card type to export"><option value="">All types</option>{col.liveTypes().map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => download('csv')} icon={<FileText className="h-4 w-4" />}>Export CSV</Button>
            <Button onClick={() => download('json')} icon={<FileText className="h-4 w-4" />}>Export JSON</Button>
          </div>
          <p className="text-xs text-mute">CSV/JSON contain notes (fields, tags, deck) — not scheduling. Cells that start with = + @ are prefixed with an apostrophe so spreadsheets never run them as formulas.</p>
        </Section>

        <Section title="Full backup" description="Everything in this account on this device: decks, notes, note types, cards, scheduling, review history, settings.">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => download('backup')} icon={<Download className="h-4 w-4" />}>Download backup</Button>
            <Button onClick={() => fileInput.current?.click()} icon={<Database className="h-4 w-4" />}>Restore from backup…</Button>
          </div>
          <p className="text-xs text-mute">Embedded images and audio are not included in the JSON backup file; they stay on this device and sync through your cloud account.</p>
        </Section>
      </div>

      {pending?.kind === 'csv' && <CsvImportModal pending={pending} onClose={() => setPending(null)} />}
      {pending?.kind === 'notes' && <JsonImportModal text={pending.text} name={pending.name} onClose={() => setPending(null)} />}
      {pending?.kind === 'backup' && <RestoreModal backup={pending.backup} name={pending.name} onClose={() => setPending(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ report
function ReportView({ r }: { r: ImportReport }) {
  return (
    <div className="space-y-3" role="status">
      <div className="flex items-center gap-2 font-semibold text-good"><CheckCircle2 className="h-5 w-5" />Import finished</div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[['Notes added', r.added], ['Cards created', r.cardsAdded], ['Duplicates skipped', r.duplicates], ['Rows with problems', r.invalid]].map(([k, v]) => (
          <div key={k as string} className="rounded-lg bg-raised p-3 text-center"><dt className="text-xs text-mute">{k}</dt><dd className="font-display text-xl font-semibold tabular-nums">{v}</dd></div>
        ))}
      </dl>
      {r.decksCreated > 0 && <p className="text-sm text-mute">{r.decksCreated} new deck{r.decksCreated === 1 ? '' : 's'} created.</p>}
      {r.errors.length > 0 && (
        <details className="rounded-lg border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium">Show problems ({r.invalid})</summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-mute">{r.errors.map((e) => <li key={e}>{e}</li>)}{r.invalid > r.errors.length && <li>…and {r.invalid - r.errors.length} more</li>}</ul>
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ CSV
function CsvImportModal({ pending, onClose }: { pending: { name: string; rows: string[][] }; onClose: () => void }) {
  const col = useCollection();
  const { toast } = useApp();
  const types = col.liveTypes();
  const first = types.find((t) => t.kind === 'basic') ?? types[0];
  const [m, setM] = useState<CsvMapping>(() => guessMapping(pending.rows, first, col.defaultDeckId));
  const [tagsText, setTagsText] = useState('');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const type = col.types.get(m.typeId)!;
  const columns = Math.max(...pending.rows.map((r) => r.length));
  const header = pending.rows[0] ?? [];
  const colLabel = (i: number) => (m.hasHeader && header[i] ? `${i + 1}: ${header[i].slice(0, 30)}` : `Column ${i + 1}`);
  const decks = col.liveDecks().sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id)));
  const dataRows = m.hasHeader ? pending.rows.slice(1) : pending.rows;
  const colOptions = Array.from({ length: columns }, (_, i) => i);

  const run = async () => {
    setError(null);
    const mapping = { ...m, extraTags: tagsText.split(/[\s,;]+/).filter(Boolean) };
    const bad = validateMapping(col, mapping, columns);
    if (bad) return setError(bad);
    setBusy({ done: 0, total: dataRows.length });
    try {
      const r = await importCsv(col, pending.rows, mapping, (done, total) => setBusy({ done, total }));
      setReport(r);
      toast(r.added ? 'success' : 'info', `${r.added} note${r.added === 1 ? '' : 's'} imported`);
    } catch (e) {
      setError(e instanceof ImportError ? e.message : 'Import failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} size="xl" title={`Import ${pending.name}`} dismissible={!busy}
      footer={report ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose} disabled={!!busy}>Cancel</Button><Button variant="primary" loading={!!busy} onClick={() => void run()}>Import {dataRows.length.toLocaleString()} row{dataRows.length === 1 ? '' : 's'}</Button></>}
    >
      {report ? <ReportView r={report} /> : (
        <div className="space-y-5">
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-xs">
              <tbody>
                {pending.rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className={i === 0 && m.hasHeader ? 'bg-raised font-semibold' : 'border-t border-line'}>
                    {colOptions.map((c) => <td key={c} className="max-w-[14rem] truncate px-2.5 py-1.5" title={r[c]}>{r[c] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-mute">{pending.rows.length.toLocaleString()} row{pending.rows.length === 1 ? '' : 's'} · {columns} column{columns === 1 ? '' : 's'}. Showing the first 5.</p>

          <Switch label="First row is a header" checked={m.hasHeader} onChange={(v) => setM({ ...m, hasHeader: v })} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Card type">
              <Select value={m.typeId} onChange={(e) => setM(guessMapping(pending.rows, col.types.get(e.target.value)!, m.deckId ?? col.defaultDeckId))} aria-label="Card type">
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="Deck">
              <Select value={m.deckColumn >= 0 ? 'col' : (m.deckId ?? '')} onChange={(e) => (e.target.value === 'col' ? setM({ ...m, deckColumn: Math.max(0, m.deckColumn) }) : setM({ ...m, deckColumn: -1, deckId: e.target.value }))} aria-label="Deck">
                {decks.map((d) => <option key={d.id} value={d.id}>{col.deckPath(d.id)}</option>)}
                <option value="col">Take deck name from a column…</option>
              </Select>
            </Field>
          </div>
          {m.deckColumn >= 0 && (
            <Field label="Deck column" hint="Use :: for nested decks. Missing decks are created.">
              <Select value={m.deckColumn} onChange={(e) => setM({ ...m, deckColumn: Number(e.target.value) })} aria-label="Deck column">{colOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}</Select>
            </Field>
          )}

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold">Map fields to columns</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {type.fields.map((f) => (
                <Field key={f} label={f}>
                  <Select value={m.fields[f] ?? -1} onChange={(e) => setM({ ...m, fields: { ...m.fields, [f]: Number(e.target.value) } })} aria-label={`Column for ${f}`}>
                    <option value={-1}>(leave empty)</option>
                    {colOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
                  </Select>
                </Field>
              ))}
              <Field label="Tags">
                <Select value={m.tagsColumn} onChange={(e) => setM({ ...m, tagsColumn: Number(e.target.value) })} aria-label="Tags column">
                  <option value={-1}>(none)</option>
                  {colOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
                </Select>
              </Field>
              <Field label="Extra tags for every note" hint="Space separated">
                <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="imported" />
              </Field>
            </div>
          </fieldset>

          <div className="grid gap-x-6 sm:grid-cols-2">
            <Switch label="Allow HTML in cells" description="Off: text is shown exactly as written; line breaks are kept" checked={m.allowHtml} onChange={(v) => setM({ ...m, allowHtml: v })} />
            <Switch label="Skip duplicates" description="Notes whose first field already exists" checked={m.skipDuplicates} onChange={(v) => setM({ ...m, skipDuplicates: v })} />
          </div>

          {busy && <div role="progressbar" aria-valuenow={busy.done} aria-valuemax={busy.total} className="text-sm text-mute">Importing… {busy.done.toLocaleString()} / {busy.total.toLocaleString()}</div>}
          {error && <p role="alert" className="rounded-lg bg-again/10 px-3 py-2 text-sm text-again">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ JSON notes
function JsonImportModal({ text, name, onClose }: { text: string; name: string; onClose: () => void }) {
  const col = useCollection();
  const [skip, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await importJsonNotes(col, text, { skipDuplicates: skip }));
    } catch (e) {
      setError(e instanceof ImportError ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Import ${name}`} size="md" dismissible={!busy}
      footer={report ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void run()}>Import</Button></>}>
      {report ? <ReportView r={report} /> : (
        <div className="space-y-3">
          <p className="text-sm text-mute">Notes are matched to your note types by name (unknown types fall back to Basic). Missing decks are created.</p>
          <Switch label="Skip duplicates" checked={skip} onChange={setSkip} />
          {error && <p role="alert" className="rounded-lg bg-again/10 px-3 py-2 text-sm text-again">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ restore
function RestoreModal({ backup, name, onClose }: { backup: Backup; name: string; onClose: () => void }) {
  const col = useCollection();
  const { confirm, toast } = useApp();
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const run = async () => {
    if (mode === 'replace') {
      const ok = await confirm({ title: 'Replace this collection?', message: 'Everything not in the backup is removed from this account (review history is kept). Download a backup first if unsure.', confirmLabel: 'Replace', danger: true });
      if (!ok) return;
    }
    setBusy(true);
    try {
      setReport(await restoreBackup(col, backup, mode));
      toast('success', 'Backup restored');
    } catch (e) {
      toast('error', e instanceof ImportError ? e.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  };
  const c = backup.counts;
  return (
    <Modal open onClose={onClose} title="Restore backup" size="md" dismissible={!busy}
      footer={report ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void run()}>Restore</Button></>}>
      {report ? (
        <div className="space-y-2 text-sm" role="status">
          <div className="flex items-center gap-2 font-semibold text-good"><CheckCircle2 className="h-5 w-5" />Restore finished ({report.mode})</div>
          <ul className="list-disc pl-5 text-mute">
            <li>Cards: {report.added.cards} added, {report.updated.cards} updated, {report.kept.cards} kept as they were</li>
            <li>Notes: {report.added.notes} added, {report.updated.notes} updated</li>
            <li>Decks: {report.added.decks} added, {report.updated.decks} updated</li>
            <li>Review logs: {report.added.review_logs} added</li>
            {report.removed > 0 && <li>{report.removed} records removed (not in the backup)</li>}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg bg-raised p-3 text-sm"><div className="font-medium">{name}</div><div className="text-mute">Made {new Date(backup.exported_at).toLocaleString()} · {c.decks} decks · {c.notes} notes · {c.cards} cards · {c.review_logs} reviews</div></div>
          <fieldset className="space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-brand has-[:checked]:bg-brand/5"><input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} className="mt-1 accent-[rgb(var(--c-brand))]" /><span><span className="font-medium">Merge <Badge tone="brand">recommended</Badge></span><span className="block text-sm text-mute">Adds missing items and updates older ones. Nothing is deleted; newer review history is never rolled back.</span></span></label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-brand has-[:checked]:bg-brand/5"><input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} className="mt-1 accent-[rgb(var(--c-brand))]" /><span><span className="font-medium">Replace</span><span className="block text-sm text-mute">Makes this collection match the backup; cards and decks that are not in it are removed.</span></span></label>
          </fieldset>
        </div>
      )}
    </Modal>
  );
}
