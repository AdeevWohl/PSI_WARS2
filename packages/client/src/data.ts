import cardsJson from '@data/cards.json';
import rulesJson from '@data/rules.json';
import rulingsJson from '@data/rulings.json';
import creatureDeck from '@data/decks/creature-commander.json';
import robotDeck from '@data/decks/robot-commander.json';
import { buildDefs, type CardDef, type DeckList, type RulesData } from '@psi-wars/engine';

export const rules = rulesJson as unknown as RulesData;
export const baseCards = cardsJson as unknown as { cards: CardDef[] };

export interface Ruling {
  title: string;
  text: string;
}
export const rulings = rulingsJson as unknown as {
  rulings: Record<string, Ruling>;
  byType: Record<string, string[]>;
  byCard: Record<string, string[]>;
};

export interface StoredDeck extends DeckList {
  id: string;
  name: string;
  starter?: boolean;
}
export const starterDecks: StoredDeck[] = [creatureDeck as StoredDeck, robotDeck as StoredDeck];

/** Card definitions with the local balance overlay (Stage 8 card editor) applied. */
export function currentDefs(): Record<string, CardDef> {
  let overlay: { cards?: Record<string, Partial<CardDef>> } | undefined;
  try {
    const raw = localStorage.getItem('psiwars.balance');
    if (raw) overlay = JSON.parse(raw);
  } catch {
    overlay = undefined;
  }
  return buildDefs(baseCards, overlay);
}

export function rulingsFor(def: CardDef): (Ruling & { id: string })[] {
  const ids = [...(rulings.byType[def.cardType] ?? []), ...(rulings.byCard[def.id] ?? [])];
  return [...new Set(ids)].map((id) => ({ id, ...rulings.rulings[id]! })).filter((r) => r.title);
}
