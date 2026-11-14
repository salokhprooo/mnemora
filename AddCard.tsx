import { useState } from 'react';
import { navigate, useQueryParam } from '../lib/router';
import { useCollection } from '../store/app';
import { NoteEditor } from '../components/cards/NoteEditor';
import { NoteTypeManager } from '../components/cards/NoteTypeManager';
import { Button, PageHeader } from '../components/ui/primitives';
import { Layers } from '../components/ui/icons';

export default function AddCard() {
  const col = useCollection();
  const deckParam = useQueryParam('deck');
  const [manage, setManage] = useState(false);
  const [count, setCount] = useState(0);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Add card"
        subtitle={count > 0 ? `${count} added this session` : 'Create flashcards in any of the built-in or custom card types'}
        actions={
          <>
            <Button onClick={() => setManage(true)} icon={<Layers className="h-4 w-4" />}>Note types</Button>
            <Button onClick={() => navigate('/decks')}>Decks</Button>
          </>
        }
      />
      <div className="panel p-4 sm:p-6">
        <NoteEditor defaultDeckId={deckParam && col.decks.get(deckParam) ? deckParam : null} onSaved={() => setCount((c) => c + 1)} onDone={() => navigate('/decks')} />
      </div>
      <NoteTypeManager open={manage} onClose={() => setManage(false)} />
    </div>
  );
}
