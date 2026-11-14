import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreVertical } from './icons';
import { IconButton, cx } from './primitives';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
  divider?: boolean;
}

/** Small popover menu with outside-click, Escape and arrow-key support. */
export function Menu({ items, label = 'More actions', trigger }: { items: MenuItem[]; label?: string; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const visible = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('touchstart', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('touchstart', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      {trigger ? (
        <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {trigger}
        </button>
      ) : (
        <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <MoreVertical className="h-5 w-5" />
        </IconButton>
      )}
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          {visible.map((it, i) => (
            <div key={i}>
              {it.divider && <div className="my-1 border-t border-line" />}
              <button
                role="menuitem"
                type="button"
                className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-ink/5 focus:bg-ink/5 focus:outline-none', it.danger && 'text-again')}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon && <span className="[&>svg]:h-4 [&>svg]:w-4">{it.icon}</span>}
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
