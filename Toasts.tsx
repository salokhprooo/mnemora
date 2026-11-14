import { AnimatePresence, motion } from 'framer-motion';
import type { Toast } from '../../store/app';
import { AlertTriangle, CheckCircle2, Info, X } from './icons';
import { cx } from './primitives';

export function ToastHost({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:pr-6"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={cx(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-pop',
              t.kind === 'error' ? 'border-again/40' : t.kind === 'success' ? 'border-good/40' : 'border-line',
            )}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            {t.kind === 'error' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-again" />
            ) : t.kind === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-good" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            )}
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            {t.action && (
              <button
                className="shrink-0 font-semibold text-brand hover:underline"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button aria-label="Dismiss" className="shrink-0 text-mute hover:text-ink" onClick={() => dismiss(t.id)}>
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
