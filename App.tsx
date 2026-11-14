import { useEffect } from 'react';
import { AppProvider, useApp, useSyncStatus, type AuthMode } from './store/app';
import { AppShell } from './components/layout/AppShell';
import { Routes } from './lib/router';
import AuthPage, { BootScreen } from './pages/Auth';
import Home from './pages/Home';
import Decks from './pages/Decks';
import Study from './pages/Study';
import Browse from './pages/Browse';
import Stats from './pages/Stats';
import AddCard from './pages/AddCard';
import DataPage from './pages/DataPage';
import Settings from './pages/Settings';
import { EmptyState, Button } from './components/ui/primitives';
import { navigate } from './lib/router';
import { useReminders } from './hooks/useReminders';

function NotFound() {
  return <EmptyState title="Page not found" body="That page does not exist." action={<Button variant="primary" onClick={() => navigate('/')}>Go home</Button>} />;
}

/** Background Sync (Chromium): when changes are pending while offline, ask the SW to wake us when back online. */
function useBackgroundSync() {
  const { engine } = useApp();
  const s = useSyncStatus();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'sync-now') void engine.syncNow();
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [engine]);
  useEffect(() => {
    if (!engine.enabled || s.pending === 0 || navigator.onLine || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register('mnemora-sync'))
      .catch(() => undefined);
  }, [engine, s.pending, s.state]);
}

function Pages() {
  useReminders();
  useBackgroundSync();
  return (
    <AppShell>
      <Routes
        fallback={<NotFound />}
        routes={[
          { path: '/', element: <Home /> },
          { path: '/decks', element: <Decks /> },
          { path: '/study', element: <Study /> },
          { path: '/browse', element: <Browse /> },
          { path: '/stats', element: <Stats /> },
          { path: '/add', element: <AddCard /> },
          { path: '/data', element: <DataPage /> },
          { path: '/settings', element: <Settings /> },
        ]}
      />
    </AppShell>
  );
}

function Gate({ mode, error }: { mode: AuthMode; error: string | null }) {
  if (error) return <BootScreen error={error} />;
  if (mode === 'signed-out' || mode === 'recovery') return <AuthPage mode={mode} />;
  return <BootScreen />;
}

export default function App() {
  return (
    <AppProvider fallback={(a) => <Gate {...a} />}>
      <Pages />
    </AppProvider>
  );
}
