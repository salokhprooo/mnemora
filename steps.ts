import { CollectionError } from '../db/collection';

/** "1 10" → [1,10]; accepts suffixes: 30s is rejected, 5m, 2h, 1d. Returns minutes. */
export function parseSteps(text: string): number[] {
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  return tokens.map((t) => {
    const m = /^(\d+(?:\.\d+)?)([mhd]?)$/i.exec(t);
    if (!m) throw new CollectionError(`“${t}” is not a valid step. Use numbers of minutes, or add h / d (e.g. 1 10 1d).`);
    const n = Number(m[1]);
    const mult = m[2].toLowerCase() === 'h' ? 60 : m[2].toLowerCase() === 'd' ? 1440 : 1;
    return n * mult;
  });
}

export function stepsToText(steps: number[]): string {
  return steps.map((s) => (s % 1440 === 0 ? `${s / 1440}d` : s % 60 === 0 && s >= 60 ? `${s / 60}h` : `${s}`)).join(' ');
}
