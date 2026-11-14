/**
 * Tiny hash router (no dependency). Hash routing works on any static host without server rewrites and does not
 * collide with Supabase's `?code=` OAuth redirect, which uses the query string.
 *   #/decks            → path "/decks"
 *   #/study?deck=abc   → path "/study", query { deck: "abc" }
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from 'react';

function currentHash(): string {
  const h = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '');
  return h === '' ? '/' : h;
}

const subscribe = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

export interface Location {
  path: string;
  query: URLSearchParams;
}

export function useLocation(): Location {
  const hash = useSyncExternalStore(subscribe, currentHash, () => '/');
  return useMemo(() => {
    const [path, search = ''] = hash.split('?');
    return { path: path || '/', query: new URLSearchParams(search) };
  }, [hash]);
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = '#' + (to.startsWith('/') ? to : '/' + to);
  if (opts.replace) window.location.replace(target);
  else window.location.hash = target;
}

export function useNavigate() {
  return useCallback((to: string, opts?: { replace?: boolean }) => navigate(to, opts), []);
}

export function useQueryParam(name: string): string | null {
  return useLocation().query.get(name);
}

export function Link({ to, children, ...rest }: { to: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={'#' + to} {...rest}>
      {children}
    </a>
  );
}

export function isActive(current: string, to: string): boolean {
  return to === '/' ? current === '/' : current === to || current.startsWith(to + '/');
}

export function NavLink({
  to,
  children,
  className,
  ...rest
}: { to: string; children?: ReactNode | ((a: { active: boolean }) => ReactNode); className?: string | ((a: { active: boolean }) => string) } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'className' | 'children'
>) {
  const { path } = useLocation();
  const active = isActive(path, to);
  return (
    <a href={'#' + to} aria-current={active ? 'page' : undefined} className={typeof className === 'function' ? className({ active }) : className} {...rest}>
      {typeof children === 'function' ? children({ active }) : children}
    </a>
  );
}

export interface RouteDef {
  path: string;
  element: ReactNode;
}

const RouterCtx = createContext(false);

/** Renders the first route whose path matches exactly or as a prefix; falls back to `fallback`. */
export function Routes({ routes, fallback }: { routes: RouteDef[]; fallback: ReactNode }) {
  const { path } = useLocation();
  const match = routes.find((r) => path === r.path || (r.path !== '/' && path.startsWith(r.path + '/')));
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [path]);
  return <RouterCtx.Provider value>{match ? match.element : fallback}</RouterCtx.Provider>;
}
