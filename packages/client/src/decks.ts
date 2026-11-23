/** Saved decks (localStorage) + the starter decks. */
import { validateDeck } from '@psi-wars/engine';
import { currentDefs, rules, starterDecks } from './data';
import type { StoredDeck } from './deck-io';

const KEY = 'psiwars.decks';

export function customDecks(): StoredDeck[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as StoredDeck[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: StoredDeck[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked */
  }
}

export function saveDeck(d: StoredDeck): void {
  const list = customDecks().filter((x) => x.id !== d.id);
  list.push({ ...d, starter: false, updatedAt: Date.now() });
  write(list);
}

export function deleteDeck(id: string): void {
  write(customDecks().filter((x) => x.id !== id));
}

export function newDeckId(): string {
  return `deck-${crypto.randomUUID().slice(0, 8)}`;
}

/** Every deck the player may pick: starters first, then their legal saved decks. */
export function playableDecks(): StoredDeck[] {
  const defs = currentDefs();
  return [...starterDecks, ...customDecks().filter((d) => validateDeck(defs, rules, d).length === 0)];
}
