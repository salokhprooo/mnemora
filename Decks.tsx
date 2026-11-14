import { useMemo, useState } from 'react';
import { useApp, useCollection } from '../store/app';
import { CollectionError, type DeckTreeNode } from '../db/collection';
import { navigate } from '../lib/router';
import type { DeckCounts } from '../types';
import { CardState } from '../types';
import { Menu } from '../components/ui/Menu';
import { Modal } from '../components/ui/Modal';
import { DeckOptionsModal } from '../components/decks/DeckOptionsModal';
import { Badge, Button, EmptyState, Field, Input, PageHeader, ProgressBar, Segmented, Select, Skeleton, cx } from '../components/ui/primitives';
import {
  BarChart3, ChevronDown, ChevronRight, Copy, Eye, Folder, FolderPlus, GraduationCap, Globe, Move, Pencil, PlusCircle, Search, SlidersHorizontal, Trash2,
} from '../components/ui/icons';

type SortKey = 'name' | 'due' | 'total' | 'created';
const COLLAPSED_KEY = 'mnemora.collapsedDecks';

const loadCollapsed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};

type NameDialog = { mode: 'create' | 'rename'; parentId: string | null; id?: string; value: string } | null;

export default function Decks() {
  const { toast, confirm } = useApp();
  const col = useCollection();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [nameDialog, setNameDialog] = useState<NameDialog>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<string>('');
  const [optionsId, setOptionsId] = useState<string | null>(null);

  const counts = col.deckCounts();
  // progress = share of cards that have been introduced (not New); one pass over all cards, rolled up the tree
  const progress = useMemo(() => {
    const own = new Map<string, { total: number; learned: number }>();
    for (const c of col.liveCards()) {
      const o = own.get(c.deck_id) ?? { total: 0, learned: 0 };
      o.total++;
      if (c.state !== CardState.New) o.learned++;
      own.set(c.deck_id, o);
    }
    const out = new Map<string, number>();
    const walk = (n: DeckTreeNode): { total: number; learned: number } => {
      const acc = { ...(own.get(n.deck.id) ?? { total: 0, learned: 0 }) };
      for (const ch of n.children) {
        const r = walk(ch);
        acc.total += r.total;
        acc.learned += r.learned;
      }
      out.set(n.deck.id, acc.total ? (acc.learned / acc.total) * 100 : 0);
      return acc;
    };
    col.deckTree().forEach(walk);
    return out;
  }, [col, col.version]);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };

  const sortNodes = (nodes: DeckTreeNode[]): DeckTreeNode[] => {
    const c = (n: DeckTreeNode) => counts.get(n.deck.id);
    const sorted = [...nodes].sort((a, b) => {
      switch (sort) {
        case 'due': return (c(b)?.due ?? 0) + (c(b)?.new ?? 0) - ((c(a)?.due ?? 0) + (c(a)?.new ?? 0)) || a.deck.name.localeCompare(b.deck.name);
        case 'total': return (c(b)?.total ?? 0) - (c(a)?.total ?? 0) || a.deck.name.localeCompare(b.deck.name);
        case 'created': return b.deck.created_at.localeCompare(a.deck.created_at);
        default: return a.deck.name.localeCompare(b.deck.name, undefined, { numeric: true, sensitivity: 'base' });
      }
    });
    return sorted;
  };

  const q = query.trim().toLowerCase();
  const matches = (n: DeckTreeNode): boolean => n.path.toLowerCase().includes(q) || n.children.some(matches);

  const rows: { node: DeckTreeNode; hasKids: boolean }[] = [];
  const flatten = (nodes: DeckTreeNode[]) => {
    for (const n of sortNodes(nodes)) {
      if (q && !matches(n)) continue;
      rows.push({ node: n, hasKids: n.children.length > 0 });
      if (n.children.length && (q || !collapsed.has(n.deck.id))) flatten(n.children);
    }
  };
  flatten(col.deckTree());

  // ---- actions
  const submitName = async () => {
    if (!nameDialog) return;
    setNameError(null);
    try {
      if (nameDialog.mode === 'create') {
        const d = nameDialog.value.includes('::') ? await col.ensureDeckPath(nameDialog.value.trim(), nameDialog.parentId) : await col.createDeck(nameDialog.value, nameDialog.parentId);
        toast('success', `Created “${col.deckPath(d.id)}”`);
      } else {
        await col.renameDeck(nameDialog.id!, nameDialog.value);
        toast('success', 'Deck renamed');
      }
      setNameDialog(null);
    } catch (e) {
      setNameError(e instanceof CollectionError ? e.message : 'Could not save the deck');
    }
  };

  const remove = async (id: string) => {
    const c = counts.get(id);
    const ok = await confirm({
      title: `Delete “${col.deckPath(id)}”?`,
      message: `${c?.total ?? 0} card${c?.total === 1 ? '' : 's'} in this deck and its sub-decks will be deleted. Review history is kept.`,
      confirmLabel: 'Delete deck',
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await col.deleteDeck(id);
      toast('success', `Deck deleted (${n} card${n === 1 ? '' : 's'})`);
    } catch (e) {
      toast('error', e instanceof CollectionError ? e.message : 'Could not delete the deck');
    }
  };

  const duplicate = async (id: string) => {
    try {
      const d = await col.duplicateDeck(id);
      toast('success', `Created “${col.deckPath(d.id)}” with fresh scheduling`);
    } catch (e) {
      toast('error', e instanceof CollectionError ? e.message : 'Could not duplicate the deck');
    }
  };

  const doMove = async () => {
    if (!moveId) return;
    try {
      await col.moveDeck(moveId, moveTo || null);
      toast('success', 'Deck moved');
      setMoveId(null);
    } catch (e) {
      toast('error', e instanceof CollectionError ? e.message : 'Could not move the deck');
    }
  };

  const togglePublic = async (id: string) => {
    const d = col.decks.get(id)!;
    if (!d.is_public) {
      const ok = await confirm({ title: 'Make this deck public?', message: 'Anyone with an account will be able to read the cards in this deck (read-only). You can make it private again at any time.', confirmLabel: 'Make public' });
      if (!ok) return;
    }
    await col.setDeckPublic(id, !d.is_public);
    toast('success', d.is_public ? 'Deck is private again' : 'Deck is now public');
  };

  const moveCandidates = moveId ? col.liveDecks().filter((d) => !col.subtreeIds(moveId).has(d.id)).sort((a, b) => col.deckPath(a.id).localeCompare(col.deckPath(b.id))) : [];
  const empty = col.liveCards().length === 0 && col.liveDecks().length <= 1;

  return (
    <div>
      <PageHeader
        title="Decks"
        subtitle={`${col.liveDecks().length} deck${col.liveDecks().length === 1 ? '' : 's'} · ${col.totalCounts().total} cards`}
        actions={
          <>
            <Button onClick={() => { setNameError(null); setNameDialog({ mode: 'create', parentId: null, value: '' }); }} icon={<FolderPlus className="h-4 w-4" />}>
              New deck
            </Button>
            <Button variant="primary" onClick={() => navigate('/add')} icon={<PlusCircle className="h-4 w-4" />}>
              Add card
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search decks" aria-label="Search decks" className="pl-9" />
        </div>
        <Segmented<SortKey>
          label="Sort decks"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'name', label: 'Name' },
            { value: 'due', label: 'Due' },
            { value: 'total', label: 'Size' },
            { value: 'created', label: 'Newest' },
          ]}
        />
      </div>

      <div className="panel overflow-hidden">
        <div className="hidden grid-cols-[1fr_4rem_4rem_4rem_7rem_2.5rem] items-center gap-2 border-b border-line bg-raised px-4 py-2 text-xs font-semibold uppercase tracking-wide text-mute sm:grid">
          <span>Deck</span>
          <span className="text-center text-newc">New</span>
          <span className="text-center text-learnc">Learn</span>
          <span className="text-center text-reviewc">Due</span>
          <span>Progress</span>
          <span />
        </div>
        {empty && (
          <EmptyState
            icon={<Folder />}
            title="Create your first deck"
            body="Decks keep related cards together. You can nest them, e.g. Languages::Spanish."
            action={<Button variant="primary" onClick={() => setNameDialog({ mode: 'create', parentId: null, value: '' })}>New deck</Button>}
          />
        )}
        {!empty && rows.length === 0 && <EmptyState icon={<Search />} title="No decks match" body={`Nothing matches “${query}”.`} />}
        <ul>
          {rows.map(({ node, hasKids }) => {
            const d = node.deck;
            const c: DeckCounts = counts.get(d.id) ?? { total: 0, new: 0, learning: 0, review: 0, due: 0, suspended: 0, mature: 0 };
            const open = !collapsed.has(d.id) || !!q;
            return (
              <li key={d.id} className="group border-b border-line last:border-0">
                <div className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2.5 hover:bg-ink/[0.03] sm:grid-cols-[1fr_4rem_4rem_4rem_7rem_2.5rem] sm:px-4" style={{ paddingLeft: `${0.75 + node.depth * 1.25}rem` }}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    {hasKids ? (
                      <button onClick={() => toggle(d.id)} aria-label={open ? `Collapse ${d.name}` : `Expand ${d.name}`} aria-expanded={open} className="rounded p-1 text-mute hover:bg-ink/10">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    ) : (
                      <span className="w-6" />
                    )}
                    <button className="min-w-0 truncate text-left font-medium hover:text-brand" onClick={() => navigate(`/study?deck=${d.id}`)} title={`Study ${node.path}`}>
                      {d.name}
                    </button>
                    {d.is_public && <Badge tone="brand"><Globe className="mr-1 h-3 w-3" />Public</Badge>}
                    {c.suspended > 0 && <span className="hidden text-xs text-mute md:inline">· {c.suspended} suspended</span>}
                  </div>
                  <div className="hidden text-center text-sm font-semibold tabular-nums text-newc sm:block">{c.new || <span className="font-normal text-mute/50">0</span>}</div>
                  <div className="hidden text-center text-sm font-semibold tabular-nums text-learnc sm:block">{c.learning || <span className="font-normal text-mute/50">0</span>}</div>
                  <div className="hidden text-center text-sm font-semibold tabular-nums text-reviewc sm:block">{c.review || <span className="font-normal text-mute/50">0</span>}</div>
                  <div className="hidden sm:block">
                    <ProgressBar value={progress.get(d.id) ?? 0} label={`${d.name} progress`} tone="good" />
                    <div className="mt-0.5 text-[11px] text-mute">{c.total} cards</div>
                  </div>
                  <div className="flex items-center gap-1 sm:justify-end">
                    <div className="flex gap-1.5 text-xs font-semibold tabular-nums sm:hidden" aria-label="Counts">
                      <span className="text-newc">{c.new}</span>
                      <span className="text-learnc">{c.learning}</span>
                      <span className="text-reviewc">{c.review}</span>
                    </div>
                    <Menu
                      label={`Actions for ${d.name}`}
                      items={[
                        { label: 'Study', icon: <GraduationCap />, onSelect: () => navigate(`/study?deck=${d.id}`) },
                        { label: 'Add card here', icon: <PlusCircle />, onSelect: () => navigate(`/add?deck=${d.id}`) },
                        { label: 'Browse cards', icon: <Eye />, onSelect: () => navigate(`/browse?q=${encodeURIComponent(`deck:"${node.path}"`)}`) },
                        { label: 'Statistics', icon: <BarChart3 />, onSelect: () => navigate(`/stats?deck=${d.id}`) },
                        { label: 'Options', icon: <SlidersHorizontal />, onSelect: () => setOptionsId(d.id), divider: true },
                        { label: 'New sub-deck', icon: <FolderPlus />, onSelect: () => { setNameError(null); setNameDialog({ mode: 'create', parentId: d.id, value: '' }); } },
                        { label: 'Rename', icon: <Pencil />, onSelect: () => { setNameError(null); setNameDialog({ mode: 'rename', parentId: d.parent_id, id: d.id, value: d.name }); } },
                        { label: 'Move…', icon: <Move />, onSelect: () => { setMoveId(d.id); setMoveTo(d.parent_id ?? ''); } },
                        { label: 'Duplicate', icon: <Copy />, onSelect: () => void duplicate(d.id) },
                        { label: d.is_public ? 'Make private' : 'Make public…', icon: <Globe />, onSelect: () => void togglePublic(d.id) },
                        { label: 'Delete', icon: <Trash2 />, danger: true, divider: true, onSelect: () => void remove(d.id) },
                      ]}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <Modal
        open={nameDialog !== null}
        onClose={() => setNameDialog(null)}
        title={nameDialog?.mode === 'rename' ? 'Rename deck' : nameDialog?.parentId ? `New sub-deck in ${col.deckPath(nameDialog.parentId)}` : 'New deck'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setNameDialog(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form="deck-name-form">{nameDialog?.mode === 'rename' ? 'Rename' : 'Create'}</Button>
          </>
        }
      >
        <form id="deck-name-form" onSubmit={(e) => { e.preventDefault(); void submitName(); }}>
          <Field label="Name" error={nameError} hint={nameDialog?.mode === 'create' ? 'Use :: to create nested decks in one go (e.g. Science::Biology)' : undefined}>
            <Input data-autofocus value={nameDialog?.value ?? ''} maxLength={120} onChange={(e) => nameDialog && setNameDialog({ ...nameDialog, value: e.target.value })} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={moveId !== null}
        onClose={() => setMoveId(null)}
        title={moveId ? `Move “${col.decks.get(moveId)?.name}”` : 'Move deck'}
        size="sm"
        footer={<><Button onClick={() => setMoveId(null)}>Cancel</Button><Button variant="primary" onClick={() => void doMove()}>Move</Button></>}
      >
        <Field label="New parent">
          <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="New parent deck">
            <option value="">(top level)</option>
            {moveCandidates.map((d) => (
              <option key={d.id} value={d.id}>{col.deckPath(d.id)}</option>
            ))}
          </Select>
        </Field>
      </Modal>

      <DeckOptionsModal deckId={optionsId} onClose={() => setOptionsId(null)} />
    </div>
  );
}

export function DecksSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className={cx('h-14')} />)}
    </div>
  );
}
