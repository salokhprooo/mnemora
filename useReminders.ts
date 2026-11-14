import { useEffect } from 'react';
import { useCollection } from '../store/app';
import { dayKey } from '../lib/time';

const LS = 'mnemora.reminded';

/**
 * In-page study reminder. Fires a browser Notification once per day at `reminder_time` while the app is open
 * (and, on browsers that allow it, in a background tab). It is NOT a push notification: nothing is delivered
 * when the app is closed — that would need a push server.
 */
export function useReminders() {
  const col = useCollection();
  const { reminders_enabled, reminder_time, rollover_hour } = col.settings;

  useEffect(() => {
    if (!reminders_enabled || typeof Notification === 'undefined') return;
    const check = () => {
      if (Notification.permission !== 'granted') return;
      const now = new Date();
      const [h, m] = reminder_time.split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
      const today = dayKey(new Date(), rollover_hour);
      let last: string | null = null;
      try { last = localStorage.getItem(LS); } catch { /* ignore */ }
      if (last === today) return;
      const c = col.totalCounts();
      const due = c.new + c.learning + c.review;
      try { localStorage.setItem(LS, today); } catch { /* ignore */ }
      if (due <= 0) return;
      try {
        new Notification('Time to study', { body: `${due} card${due === 1 ? '' : 's'} waiting for you.`, icon: './icon.svg', tag: 'mnemora-reminder' });
      } catch { /* some browsers require a service worker for notifications */ }
    };
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [col, reminders_enabled, reminder_time, rollover_hour]);
}
