/**
 * The active card balance (build prompt §13): a balance file layered over cards.json. The card
 * editor saves it here; local games, the deck builder, the rules reference and (when the host
 * chooses) online rooms play under it. Shipped presets live in data/balance/*.json.
 */
import { cleanBalance, type BalanceFile } from '@psi-wars/engine';
import { baseCards } from './data';

const KEY = 'psiwars.balance';
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: BalanceFile | null } | null = null;

/** Presets shipped in data/balance (any *.json there). */
const presetFiles = import.meta.glob('../../../data/balance/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
export function balancePresets(): { file: string; balance: BalanceFile; errors: string[] }[] {
  return Object.entries(presetFiles)
    .map(([path, raw]) => ({ file: path.split('/').pop()!, ...cleanBalance(baseCards, raw) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The balance in force, or null for the cards as shipped. Accepts the old `{cards}` shape. */
export function activeBalance(): BalanceFile | null {
  const raw = readRaw();
  if (cache && cache.raw === raw) return cache.value;
  let value: BalanceFile | null = null;
  if (raw) {
    try {
      const b = cleanBalance(baseCards, JSON.parse(raw)).balance;
      value = Object.keys(b.cards).length ? b : null;
    } catch {
      value = null;
    }
  }
  cache = { raw, value };
  return value;
}

export function setActiveBalance(b: BalanceFile | null): void {
  try {
    if (b && Object.keys(b.cards).length) localStorage.setItem(KEY, JSON.stringify(b));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the balance applies for this page only */
  }
  cache = null;
  for (const l of listeners) l();
}

export function onBalanceChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'balance';
}
