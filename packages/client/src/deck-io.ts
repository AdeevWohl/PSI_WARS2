/** Deck import/export and helpers. Pure (no DOM, no storage) so it can be unit-tested. */
import { validateDeck, type CardDef, type DeckList, type RulesData } from '@psi-wars/engine';

export interface StoredDeck extends DeckList {
  id: string;
  name: string;
  starter?: boolean;
  updatedAt?: number;
}

export const DECK_FORMAT = 'psi-wars-deck';

export function exportDeckJson(d: StoredDeck): string {
  return JSON.stringify({ format: DECK_FORMAT, version: 1, name: d.name, battle: sortCounts(d.battle), resource: sortCounts(d.resource) }, null, 2);
}

function sortCounts(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));
}

export interface ImportResult {
  deck: StoredDeck | null;
  /** Hard errors: the file could not be read as a deck. */
  errors: string[];
  /** Rule problems: the deck was read but is not legal yet (it can still be edited). */
  problems: string[];
}

/** Accepts our export format or a bare { name, battle, resource } object. Unknown card ids are dropped and reported. */
export function parseDeckImport(text: string, defs: Record<string, CardDef>, rules: RulesData, newId: () => string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { deck: null, errors: ['That is not valid JSON.'], problems: [] };
  }
  if (!raw || typeof raw !== 'object') return { deck: null, errors: ['That is not a deck file.'], problems: [] };
  const o = raw as Record<string, unknown>;
  if (o.format !== undefined && o.format !== DECK_FORMAT) return { deck: null, errors: [`Unknown format "${String(o.format)}".`], problems: [] };
  const errors: string[] = [];
  const clean = (x: unknown, which: 'battle' | 'resource'): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!x || typeof x !== 'object') {
      errors.push(`Missing ${which} list.`);
      return out;
    }
    for (const [id, n] of Object.entries(x as Record<string, unknown>)) {
      const count = Math.floor(Number(n));
      if (!defs[id]) {
        errors.push(`Unknown card "${id}" was skipped.`);
        continue;
      }
      if (!Number.isFinite(count) || count <= 0) continue;
      out[id] = Math.min(count, 99);
    }
    return out;
  };
  const deck: StoredDeck = {
    id: newId(),
    name: String(o.name ?? 'Imported deck').slice(0, 40) || 'Imported deck',
    battle: clean(o.battle, 'battle'),
    resource: clean(o.resource, 'resource'),
    updatedAt: 0,
  };
  const missingList = errors.some((e) => e.startsWith('Missing'));
  if (missingList && !Object.keys(deck.battle).length && !Object.keys(deck.resource).length) return { deck: null, errors, problems: [] };
  return { deck, errors, problems: validateDeck(defs, rules, deck).map((p) => p.message) };
}

export function deckCounts(defs: Record<string, CardDef>, d: DeckList) {
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  let units = 0;
  let cus = 0;
  for (const [id, n] of Object.entries(d.battle)) if (defs[id]?.cardType === 'BattleUnit') units += n;
  for (const [id, n] of Object.entries(d.resource)) if (defs[id]?.cardType === 'CreationUnit') cus += n;
  return { battle: sum(d.battle), resource: sum(d.resource), units, cus };
}

/** Adding one copy of a card: which list it belongs to and whether a limit already blocks it. */
export function canAdd(defs: Record<string, CardDef>, rules: RulesData, d: DeckList, id: string): string | null {
  const def = defs[id];
  if (!def) return 'Unknown card';
  const lim = rules.deckLimits;
  const list = def.deck === 'battle' ? d.battle : d.resource;
  const n = list[id] ?? 0;
  const c = deckCounts(defs, d);
  if (def.deck === 'battle') {
    if (n >= lim.battle.maxCopies) return `At most ${lim.battle.maxCopies} copies`;
    if (c.battle >= lim.battle.max) return `Battle Deck is full (${lim.battle.max})`;
  } else if (def.cardType === 'CreationUnit') {
    if (n >= lim.resource.maxPerCUType) return `At most ${lim.resource.maxPerCUType} of one Creation Unit type`;
    if (c.cus >= lim.resource.maxCreationUnits) return `At most ${lim.resource.maxCreationUnits} Creation Units`;
    if (c.resource >= lim.resource.max) return `Resource Deck is full (${lim.resource.max})`;
  } else {
    if (n >= lim.resource.maxCopiesNonCU) return `At most ${lim.resource.maxCopiesNonCU} copies`;
    if (c.resource >= lim.resource.max) return `Resource Deck is full (${lim.resource.max})`;
  }
  return null;
}
