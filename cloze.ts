/**
 * Cloze deletions: {{c1::answer}} or {{c1::answer::hint}}. Cloze numbers start at 1.
 * Nested clozes are not supported (the inner marker is left as literal text).
 */

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export interface ClozeMatch {
  num: number;
  text: string;
  hint?: string;
}

/** Sorted, de-duplicated list of cloze numbers in `text`. */
export function clozeNumbers(text: string): number[] {
  const set = new Set<number>();
  for (const m of text.matchAll(CLOZE_RE)) {
    const n = Number(m[1]);
    if (n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

export function clozeMatches(text: string): ClozeMatch[] {
  return [...text.matchAll(CLOZE_RE)].map((m) => ({ num: Number(m[1]), text: m[2], hint: m[3] }));
}

/**
 * Render a cloze field for card number `active`.
 * - Front: the active cloze becomes `<span class="cloze">[hint]</span>`; other clozes show their text.
 * - Back:  the active cloze is revealed inside `<span class="cloze">`.
 */
export function renderCloze(text: string, active: number, side: 'front' | 'back'): string {
  return text.replace(CLOZE_RE, (_all, n: string, answer: string, hint?: string) => {
    if (Number(n) !== active) return answer;
    if (side === 'back') return `<span class="cloze">${answer}</span>`;
    return `<span class="cloze cloze-hidden">[${hint ? hint : '…'}]</span>`;
  });
}

/** True when `text` has at least one well-formed cloze. */
export const hasCloze = (text: string): boolean => clozeNumbers(text).length > 0;
