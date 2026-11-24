import cardsJson from '@data/cards.json';
import rulesJson from '@data/rules.json';
import rulingsJson from '@data/rulings.json';
import creatureDeck from '@data/decks/creature-commander.json';
import robotDeck from '@data/decks/robot-commander.json';
import v04RobotControl from '@data/decks/v04-robot-control.json';
import v04RobotIndustrial from '@data/decks/v04-robot-industrial.json';
import v04CreatureSwarm from '@data/decks/v04-creature-swarm.json';
import v04CreatureEvolution from '@data/decks/v04-creature-evolution.json';
import v04MixedIntegration from '@data/decks/v04-mixed-integration.json';

import { buildDefs, type CardDef, type DeckList, type RulesData } from '@psi-wars/engine';
import { activeBalance } from './balance';

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
export const starterDecks: StoredDeck[] = [
  v04RobotControl as StoredDeck, v04RobotIndustrial as StoredDeck, v04CreatureSwarm as StoredDeck, v04CreatureEvolution as StoredDeck, v04MixedIntegration as StoredDeck,
  // v0.3 starter lists, kept for comparison (they use the current card data).
  creatureDeck as StoredDeck, robotDeck as StoredDeck,
];

let defsCache: { key: unknown; defs: Record<string, CardDef> } | null = null;

/** Card definitions with the active balance overlay (card editor, data/balance) applied. */
export function currentDefs(): Record<string, CardDef> {
  const b = activeBalance();
  if (defsCache?.key !== b) defsCache = { key: b, defs: buildDefs(baseCards, b ?? undefined) };
  return defsCache.defs;
}

export function rulingsFor(def: CardDef): (Ruling & { id: string })[] {
  const ids = [...(rulings.byType[def.cardType] ?? []), ...(rulings.byCard[def.id] ?? [])];
  return [...new Set(ids)].map((id) => ({ id, ...rulings.rulings[id]! })).filter((r) => r.title);
}
