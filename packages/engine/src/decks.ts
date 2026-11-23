/** Deck construction rules (spec §A12, RULING A12-a). Shared by the deck builder and the servers. */
import type { CardDef, RulesData } from './types';
import type { DeckList } from './setup';

export interface DeckProblem {
  code: string;
  message: string;
}

export function validateDeck(defs: Record<string, CardDef>, rules: RulesData, deck: DeckList, opts: { allowDisabled?: boolean } = {}): DeckProblem[] {
  const out: DeckProblem[] = [];
  const lim = rules.deckLimits;
  const sum = (o: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + (Number.isInteger(b) && b > 0 ? b : 0), 0);
  if (!deck || typeof deck !== 'object' || typeof deck.battle !== 'object' || typeof deck.resource !== 'object') return [{ code: 'shape', message: 'Deck must have battle and resource lists.' }];

  let units = 0;
  for (const [id, n] of Object.entries(deck.battle)) {
    const d = defs[id];
    if (!d) out.push({ code: 'unknown', message: `Unknown card ${id}.` });
    else if (d.deck !== 'battle') out.push({ code: 'wrongDeck', message: `${d.name} belongs in the Resource Deck.` });
    else if (!d.enabled && !opts.allowDisabled) out.push({ code: 'disabled', message: `${d.name} is not enabled.` });
    if (!Number.isInteger(n) || n < 1) out.push({ code: 'count', message: `Bad count for ${id}.` });
    else if (n > lim.battle.maxCopies) out.push({ code: 'copies', message: `At most ${lim.battle.maxCopies} copies of ${d?.name ?? id}.` });
    if (d?.cardType === 'BattleUnit') units += n;
  }
  const battleN = sum(deck.battle);
  if (battleN < lim.battle.min) out.push({ code: 'battleMin', message: `Battle Deck needs at least ${lim.battle.min} cards (has ${battleN}).` });
  if (battleN > lim.battle.max) out.push({ code: 'battleMax', message: `Battle Deck allows at most ${lim.battle.max} cards (has ${battleN}).` });
  if (units < lim.battle.minBattleUnits) out.push({ code: 'units', message: `Battle Deck needs at least ${lim.battle.minBattleUnits} Battle Units (has ${units}).` });

  let cus = 0;
  for (const [id, n] of Object.entries(deck.resource)) {
    const d = defs[id];
    if (!d) out.push({ code: 'unknown', message: `Unknown card ${id}.` });
    else if (d.deck !== 'resource') out.push({ code: 'wrongDeck', message: `${d.name} belongs in the Battle Deck.` });
    else if (!d.enabled && !opts.allowDisabled) out.push({ code: 'disabled', message: `${d.name} is not enabled.` });
    if (!Number.isInteger(n) || n < 1) out.push({ code: 'count', message: `Bad count for ${id}.` });
    else if (d?.cardType === 'CreationUnit') {
      cus += n;
      if (n > lim.resource.maxPerCUType) out.push({ code: 'cuType', message: `At most ${lim.resource.maxPerCUType} ${d.name}.` });
    } else if (n > lim.resource.maxCopiesNonCU) out.push({ code: 'copies', message: `At most ${lim.resource.maxCopiesNonCU} copies of ${d?.name ?? id}.` });
  }
  const resN = sum(deck.resource);
  if (resN < lim.resource.min) out.push({ code: 'resMin', message: `Resource Deck needs at least ${lim.resource.min} cards (has ${resN}).` });
  if (resN > lim.resource.max) out.push({ code: 'resMax', message: `Resource Deck allows at most ${lim.resource.max} cards (has ${resN}).` });
  if (cus > lim.resource.maxCreationUnits) out.push({ code: 'cuMax', message: `At most ${lim.resource.maxCreationUnits} Creation Units (has ${cus}).` });
  return out;
}
