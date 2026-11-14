import { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../store/app';
import { CollectionError, type BrowseRow, type BrowseSort } from '../db/collection';
import { navigate, useQueryParam } from '../lib/router';
import { CardState } from '../types';
import { renderCard } from '../lib/render';
import { formatRelativeDue } from '../lib/time';
import { NoteEditor } from '../components/cards/NoteEditor';
import { CardHtml } from '../components/cards/CardView';
import { Modal } from '../components/ui/Modal';
import { Badge, Button, EmptyState, Field, Input, PageHeader, Select, cx } from '../components/ui/primitives';
import { ArrowUpDown, ChevronLeft, ChevronRight, Clock, Copy, EyeOff, Eye, Folder, Move, Pencil, Plus, Search, Tag, Trash2, X, Eraser } from '../components/ui/icons';

const PAGE_SIZE = 50;

const SORTS: { value: BrowseSort; label: string }[] = [
  { value: 'created', label: 'Created' },
  { value: 'reviewed', label: 'Last review' },
  { value: 'due', label: 'Due date' },
  { value: 'interval', label: 'Interval' },
  { value: 'lapses', label: 'Lapses' },
  { value: 'reps', label: 'Reviews' },
  { value: 'deck', label: 'Deck' },
  { value: 'front', label: 'Question A–Z' },
];

const STATES = [
  { value: '', label: 'Any state' },
  { value: 'is:new', label: 'New' },
  { value: 'is:learn', label: 'Learning' },
  { value: 'is:review', label: 'Review' },
  { value: 'is:due', label: 'Due today' },
  { value: 'is:young', label: 'Young (<21d)' },
  { value: 'is:mature', label: 'Mature (≥21d)' },
  { value: 'is:suspended', label: 'Suspended' },
  { value: 'is:leech', label: 'Leeches' },
];

type Bulk = null | { kind: 'move' | 'addTags' | 'removeTags' | 'setDue'; value: string };

function dueLabel(r: BrowseRow): string {
  const c = r.card;
  if (c.suspended) return 'Suspended';
  if (c.state === CardState.New) return 'New';
  const d = new Date(c.due);
  if (c.state === CardState.Review) return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  return formatRelativeDue(c.due);
}

export default function Browse() {
  const { toast, confirm } = useApp();
  const col = useCollection();
  const qParam = useQueryParam('q');
  const cardParam = useQueryParam('card');

  const [text, setText] = useState(qParam ?? '');
  const [deck, setDeck] = useState('');
  const [tag, setTag] = useState('');
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [sort, setSort] = useState<BrowseSort>('created');
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);
  const [bulk, setBulk] = useState<Bulk>(null);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [help, setHelp] = useState(false);

  // react to links from global search / deck menu
  useEffect(() => {
    setText(qParam ?? '');
    setPage(0);
  }, [qParam]);
  useEffect(() => {
    if (cardParam) {
      const c = col.cards.get(cardParam);
      if (c) {
        setActive(c.id);
        setEditNote(c.note_id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardParam]);

  const fullQuery = useMemo(
    () => [text.trim(), deck && `deck:"${col.deckPath(deck)}"`, tag && `tag:${tag}`, type && `type:"${col.types.get(type)?.name ?? ''}"`, state].filter(Boolean).join(' '),
    [text, deck, tag, type, state, col, col.version],
  );

  const result = useMemo(
    () => col.searchCards(fullQuery, { sort, desc, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
    [col, col.version, fullQuery, sort, desc, page],
  );
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1);
  }, [page, pages]);

  const decks = useMemo(() => col.liveDecks().sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id))), [col, col.version]);
  const tags = useMemo(() => col.allTags(), [col, col.version]);
  const types = col.liveTypes();
  const activeRow = result.rows.find((r) => r.card.id === active) ?? null;

  const allOnPage = result.rows.length > 0 && result.rows.every((r) => selected.has(r.card.id));
  const toggleRow = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };
  const togglePage = () => {
    const n = new Set(selected);
    for (const r of result.rows) {
      if (allOnPage) n.delete(r.card.id);
      else n.add(r.card.id);
    }
    setSelected(n);
  };
  const selectAllResults = () => setSelected(new Set(col.searchIds(fullQuery)));

  const ids = [...selected].filter((id) => col.cards.get(id) && !col.cards.get(id)!.deleted_at);
  const noteIds = [...new Set(ids.map((id) => col.cards.get(id)!.note_id))];

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast('success', label);
    } catch (e) {
      toast('error', e instanceof CollectionError ? e.message : 'That did not work');
    }
  };

  const applyBulk = async () => {
    if (!bulk) return;
    setBulkErr(null);
    try {
      if (bulk.kind === 'move') {
        if (!bulk.value) throw new CollectionError('Choose a deck');
        const n = await col.moveCards(ids, bulk.value);
        toast('success', `Moved ${n} card${n === 1 ? '' : 's'} to ${col.deckPath(bulk.value)}`);
      } else if (bulk.kind === 'addTags' || bulk.kind === 'removeTags') {
        const list = bulk.value.split(/[\s,;]+/).filter(Boolean);
        if (!list.length) throw new CollectionError('Enter at least one tag');
        const n = bulk.kind === 'addTags' ? await col.addTags(noteIds, list) : await col.removeTags(noteIds, list);
        toast('success', `${bulk.kind === 'addTags' ? 'Tagged' : 'Updated'} ${n} note${n === 1 ? '' : 's'}`);
      } else {
        const days = Number(bulk.value);
        if (!Number.isFinite(days) || days < 0 || days > 36500) throw new CollectionError('Enter a number of days between 0 and 36500');
        await col.setDueInDays(ids, Math.round(days));
        toast('success', `Rescheduled ${ids.length} card${ids.length === 1 ? '' : 's'}`);
      }
      setBulk(null);
    } catch (e) {
      setBulkErr(e instanceof CollectionError ? e.message : 'Could not apply that change');
    }
  };

  const deleteSelected = async () => {
    const ok = await confirm({
      title: `Delete ${noteIds.length} note${noteIds.length === 1 ? '' : 's'}?`,
      message: `This also deletes all their cards (${ids.length} selected). Review history is kept.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await run(`Deleted ${noteIds.length} note${noteIds.length === 1 ? '' : 's'}`, () => col.deleteNotes(noteIds));
    setSelected(new Set());
    setActive(null);
  };

  const forgetSelected = async () => {
    const ok = await confirm({ title: `Reset ${ids.length} card${ids.length === 1 ? '' : 's'} to New?`, message: 'Scheduling is reset. Review history is kept.', confirmLabel: 'Reset' });
    if (ok) await run('Cards reset to new', () => col.forgetCards(ids));
  };

  const anySuspended = ids.some((id) => col.cards.get(id)!.suspended);
  const rendered = activeRow ? renderCard(activeRow.note, activeRow.type, activeRow.card.ord) : null;
  const filtersActive = Boolean(deck || tag || type || state || text);

  return (
    <div>
      <PageHeader title="Browse" subtitle={`${result.total.toLocaleString()} card${result.total === 1 ? '' : 's'}${filtersActive ? ' match' : ''}`} actions={<Button variant="primary" onClick={() => navigate('/add')} icon={<Plus className="h-4 w-4" />}>Add card</Button>} />

      {/* search + filters */}
      <div className="panel mb-4 space-y-3 p-3 sm:p-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" />
            <Input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPage(0);
              }}
              placeholder='Search text, or e.g. deck:Spanish tag:verbs is:due "exact phrase" -negation'
              aria-label="Search cards"
              className="pl-9"
            />
          </div>
          <Button onClick={() => setHelp(true)} aria-label="Search syntax help">?</Button>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Select aria-label="Deck filter" value={deck} onChange={(e) => { setDeck(e.target.value); setPage(0); }}>
            <option value="">All decks</option>
            {decks.map((d) => <option key={d.id} value={d.id}>{col.deckPath(d.id)}</option>)}
          </Select>
          <Select aria-label="Tag filter" value={tag} onChange={(e) => { setTag(e.target.value); setPage(0); }}>
            <option value="">Any tag</option>
            <option value="none">Untagged</option>
            {tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
          </Select>
          <Select aria-label="Card type filter" value={type} onChange={(e) => { setType(e.target.value); setPage(0); }}>
            <option value="">Any card type</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select aria-label="Card state and due filter" value={state} onChange={(e) => { setState(e.target.value); setPage(0); }}>
            {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
          <div className="flex gap-2">
            <Select aria-label="Sort by" value={sort} onChange={(e) => { setSort(e.target.value as BrowseSort); setPage(0); }}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
            <Button onClick={() => setDesc((d) => !d)} aria-label={desc ? 'Descending' : 'Ascending'} title={desc ? 'Descending' : 'Ascending'}>
              <ArrowUpDown className={cx('h-4 w-4 transition', !desc && 'rotate-180')} />
            </Button>
          </div>
        </div>
        {result.warnings.length > 0 && <p role="status" className="text-xs text-learnc">{result.warnings.join(' · ')}</p>}
        {filtersActive && (
          <button className="text-xs font-medium text-brand hover:underline" onClick={() => { setText(''); setDeck(''); setTag(''); setType(''); setState(''); setPage(0); }}>
            Clear all filters
          </button>
        )}
      </div>

      {/* bulk bar */}
      {selected.size > 0 && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/40 bg-surface px-3 py-2 shadow-card" role="toolbar" aria-label="Bulk actions">
          <span className="text-sm font-medium">{ids.length} selected</span>
          {selected.size < result.total && <button className="text-xs font-medium text-brand hover:underline" onClick={selectAllResults}>Select all {result.total.toLocaleString()}</button>}
          <button className="text-xs text-mute hover:underline" onClick={() => setSelected(new Set())}>Clear</button>
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
          <Button size="sm" icon={<Move className="h-4 w-4" />} onClick={() => { setBulkErr(null); setBulk({ kind: 'move', value: decks[0]?.id ?? '' }); }}>Move</Button>
          <Button size="sm" icon={<Tag className="h-4 w-4" />} onClick={() => { setBulkErr(null); setBulk({ kind: 'addTags', value: '' }); }}>Add tags</Button>
          <Button size="sm" onClick={() => { setBulkErr(null); setBulk({ kind: 'removeTags', value: '' }); }}>Remove tags</Button>
          <Button size="sm" icon={anySuspended ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />} onClick={() => void run(anySuspended ? 'Unsuspended' : 'Suspended', () => col.setSuspended(ids, !anySuspended))}>{anySuspended ? 'Unsuspend' : 'Suspend'}</Button>
          <Button size="sm" icon={<Clock className="h-4 w-4" />} onClick={() => { setBulkErr(null); setBulk({ kind: 'setDue', value: '1' }); }}>Set due</Button>
          <Button size="sm" icon={<Eraser className="h-4 w-4" />} onClick={() => void forgetSelected()}>Reset</Button>
          <Button size="sm" icon={<Copy className="h-4 w-4" />} disabled={noteIds.length > 20} title={noteIds.length > 20 ? 'Duplicate up to 20 notes at a time' : undefined} onClick={() => void run(`Duplicated ${noteIds.length} note${noteIds.length === 1 ? '' : 's'}`, async () => { for (const n of noteIds) await col.duplicateNote(n); })}>Duplicate</Button>
          <Button size="sm" variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => void deleteSelected()}>Delete</Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="panel min-w-0 overflow-hidden">
          {result.total === 0 ? (
            col.liveCards().length === 0 ? (
              <EmptyState icon={<Folder />} title="No cards yet" body="Add your first card and it will show up here." action={<Button variant="primary" onClick={() => navigate('/add')}>Add card</Button>} />
            ) : (
              <EmptyState icon={<Search />} title="No cards match" body="Try a broader search or clear the filters." />
            )
          ) : (
            <>
              <div className="hidden grid-cols-[2rem_1fr_9rem_7rem_4rem_3rem] items-center gap-2 border-b border-line bg-raised px-3 py-2 text-xs font-semibold uppercase tracking-wide text-mute md:grid">
                <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={togglePage} className="h-4 w-4 accent-[rgb(var(--c-brand))]" />
                <span>Question</span><span>Deck</span><span>Due</span><span>Ivl</span><span>Lapses</span>
              </div>
              <ul>
                {result.rows.map((r) => {
                  const isSel = selected.has(r.card.id);
                  const isActive = active === r.card.id;
                  return (
                    <li key={r.card.id} className={cx('border-b border-line last:border-0', isActive && 'bg-brand/5', r.card.suspended && 'opacity-60')}>
                      <div className="grid grid-cols-[2rem_1fr_auto] items-center gap-2 px-3 py-2.5 md:grid-cols-[2rem_1fr_9rem_7rem_4rem_3rem]">
                        <input type="checkbox" aria-label={`Select ${r.preview.slice(0, 40)}`} checked={isSel} onChange={() => toggleRow(r.card.id)} className="h-4 w-4 accent-[rgb(var(--c-brand))]" />
                        <button className="min-w-0 text-left" onClick={() => setActive(r.card.id)} onDoubleClick={() => setEditNote(r.note.id)}>
                          <div className="truncate text-sm font-medium">{r.preview || <span className="text-mute">(empty)</span>}</div>
                          <div className="flex flex-wrap items-center gap-1 pt-0.5 text-xs text-mute md:hidden">
                            <span className="truncate">{r.deckPath}</span> · <span>{dueLabel(r)}</span>
                          </div>
                          {r.note.tags.length > 0 && <div className="mt-0.5 hidden flex-wrap gap-1 md:flex">{r.note.tags.slice(0, 4).map((t) => <span key={t} className="chip !px-1.5 !py-0 text-[11px]">{t}</span>)}</div>}
                        </button>
                        <span className="hidden truncate text-xs text-mute md:block" title={r.deckPath}>{r.deckPath}</span>
                        <span className="hidden text-xs tabular-nums md:block">{dueLabel(r)}</span>
                        <span className="hidden text-xs tabular-nums text-mute md:block">{r.card.state === CardState.Review ? `${r.card.scheduled_days}d` : '–'}</span>
                        <span className="hidden text-xs tabular-nums text-mute md:block">{r.card.lapses}</span>
                        <button className="rounded-md p-1.5 text-mute hover:bg-ink/10 md:hidden" aria-label="Edit" onClick={() => setEditNote(r.note.id)}><Pencil className="h-4 w-4" /></button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-between border-t border-line px-3 py-2 text-sm">
                <span className="text-mute tabular-nums">{page * PAGE_SIZE + 1}–{Math.min(result.total, (page + 1) * PAGE_SIZE)} of {result.total.toLocaleString()}</span>
                <div className="flex items-center gap-1">
                  <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page" icon={<ChevronLeft className="h-4 w-4" />} />
                  <span className="px-2 text-xs tabular-nums text-mute">{page + 1} / {pages}</span>
                  <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page" icon={<ChevronRight className="h-4 w-4" />} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* preview */}
        <aside className="hidden lg:block" aria-label="Card preview">
          <div className="panel sticky top-28 overflow-hidden">
            {activeRow && rendered ? (
              <div>
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <span className="text-sm font-semibold">Preview</span>
                  <div className="flex items-center gap-1">
                    <Badge tone={activeRow.card.state === CardState.New ? 'new' : activeRow.card.state === CardState.Review ? 'review' : 'learn'}>{activeRow.card.state === CardState.New ? 'New' : activeRow.card.state === CardState.Review ? 'Review' : 'Learning'}</Badge>
                    <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditNote(activeRow.note.id)}>Edit</Button>
                  </div>
                </div>
                <div className="max-h-[60dvh] space-y-3 overflow-y-auto p-4 text-center">
                  <CardHtml html={rendered.front} css={activeRow.type.css} className="text-lg" />
                  <hr className="border-line" />
                  <CardHtml html={rendered.back} css={activeRow.type.css} className="text-lg" />
                </div>
                <dl className="grid grid-cols-3 gap-2 border-t border-line px-4 py-3 text-center text-xs">
                  <div><dt className="text-mute">Reviews</dt><dd className="font-semibold tabular-nums">{activeRow.card.reps}</dd></div>
                  <div><dt className="text-mute">Lapses</dt><dd className="font-semibold tabular-nums">{activeRow.card.lapses}</dd></div>
                  <div><dt className="text-mute">Interval</dt><dd className="font-semibold tabular-nums">{activeRow.card.state === CardState.Review ? `${activeRow.card.scheduled_days}d` : '–'}</dd></div>
                </dl>
              </div>
            ) : (
              <p className="p-6 text-center text-sm text-mute">Select a card to preview it. Double-click a row to edit.</p>
            )}
          </div>
        </aside>
      </div>

      {/* editor */}
      <Modal open={editNote !== null} onClose={() => { setEditNote(null); if (cardParam) navigate('/browse', { replace: true }); }} title="Edit card" size="lg">
        {editNote && <NoteEditor noteId={editNote} onDone={() => { setEditNote(null); if (cardParam) navigate('/browse', { replace: true }); }} />}
      </Modal>

      {/* bulk dialogs */}
      <Modal
        open={bulk !== null}
        onClose={() => setBulk(null)}
        size="sm"
        title={bulk?.kind === 'move' ? `Move ${ids.length} cards` : bulk?.kind === 'addTags' ? 'Add tags' : bulk?.kind === 'removeTags' ? 'Remove tags' : 'Set due date'}
        footer={<><Button onClick={() => setBulk(null)}>Cancel</Button><Button variant="primary" type="submit" form="bulk-form">Apply</Button></>}
      >
        <form id="bulk-form" onSubmit={(e) => { e.preventDefault(); void applyBulk(); }}>
          {bulk?.kind === 'move' && (
            <Field label="Destination deck" error={bulkErr}>
              <Select data-autofocus value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} aria-label="Destination deck">
                {decks.map((d) => <option key={d.id} value={d.id}>{col.deckPath(d.id)}</option>)}
              </Select>
            </Field>
          )}
          {(bulk?.kind === 'addTags' || bulk?.kind === 'removeTags') && (
            <Field label="Tags" hint={`Applies to ${noteIds.length} note${noteIds.length === 1 ? '' : 's'}. Separate with spaces or commas.`} error={bulkErr}>
              <Input data-autofocus value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} placeholder="verbs lang::spanish" list="bulk-tags" />
              <datalist id="bulk-tags">{tags.map((t) => <option key={t.tag} value={t.tag} />)}</datalist>
            </Field>
          )}
          {bulk?.kind === 'setDue' && (
            <Field label="Due in how many days?" hint="0 = today. Cards become review cards; their memory state is kept." error={bulkErr}>
              <Input data-autofocus type="number" min={0} max={36500} value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} />
            </Field>
          )}
        </form>
      </Modal>

      <Modal open={help} onClose={() => setHelp(false)} title="Search syntax" size="md">
        <dl className="divide-y divide-line text-sm">
          {[
            ['word', 'Cards containing the word in any field'],
            ['"two words"', 'Exact phrase'],
            ['-word', 'Exclude (works on any term)'],
            ['deck:Spanish', 'Deck and its sub-decks (* wildcard)'],
            ['tag:verbs · tag:none', 'Tagged / untagged (lang matches lang::es)'],
            ['type:cloze', 'Card type'],
            ['is:new learn review due suspended mature young leech', 'Card state'],
            ['added:7 · rated:1', 'Created / answered in the last N days'],
            ['prop:ivl>=21 · prop:lapses>3', 'Interval, reps, lapses, difficulty'],
            ['a or b', 'Either term'],
          ].map(([k, d]) => (
            <div key={k} className="grid gap-1 py-2 sm:grid-cols-[14rem_1fr]"><dt className="font-mono text-xs">{k}</dt><dd className="text-mute">{d}</dd></div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}
