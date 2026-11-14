import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

/**
 * Only the public anon/publishable key is ever used in the browser; row-level security does the authorising.
 * Refuse to start if someone pasted a service-role key here by mistake: it would be shipped to every visitor.
 */
function looksLikeServiceRole(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

export const cloudConfigured = Boolean(url && anon);
export const unsafeKeyDetected = Boolean(anon && looksLikeServiceRole(anon));

export const supabase: SupabaseClient | null =
  cloudConfigured && !unsafeKeyDetected
    ? createClient(url!, anon!, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      })
    : null;
