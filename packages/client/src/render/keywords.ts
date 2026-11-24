/** Short explanations of game keywords, shown under a card's text in the preview and hover caption. */
import type { CardDef } from '@psi-wars/engine';

export const KEYWORD_HELP: Record<string, string> = {
  'Lock-On': 'Before an enemy unit in the same blocked battle makes an ability roll, pay the Lock-On cost to choose the raw die face instead. Once per Lock-On unit per battle; never affects normal combat dice.',
  Calibrate: 'Before rolling, replace that combat die with a fixed +2 (no icons). It can still be destroyed by an enemy Obliterate.',
  Protocol: 'A Robot operating mode. Chosen when the unit is created and again in each of your Creation phases; the active mode is public.',
  Mutation: 'A permanent change a Creature gains only by surviving the combat stress printed on the card. Lasts while the unit stays in play.',
  Cannibalize: 'Destroy another Creature or Cyborg you control as a cost. It goes to the discard pile with its Equipment.',
  Reanimated: 'Returned from the discard pile: +2 permanent Physical and −2 permanent Psionic (minimum 0). Not a Mutation.',
  Relocate: 'Move this Equipment to another legal unit in your Creation phase, paying its Relocate cost (or free).',
  Reactive: 'A fast Power: play it in any priority window, on any turn, including in response to another card.',
  Creation: 'A Creation Power: only in your own Creation phase, with nothing waiting to resolve. Reactive Powers can respond to it.',
  Stack: 'A Cyborg joined with one non-Cyborg unit. They fight as one, adding their strengths; destroying the Stack destroys both.',
  Contain: 'The unit is set aside: it cannot attack, defend, or use or grant abilities until the card frees it.',
  Deplete: 'Use a ready card; it stays depleted until its controller\'s Replenish phase. Depleting Creation Units pays costs; a depleted Battle Unit cannot attack or defend, but its passive abilities still work.',
  Disoriented: 'Lost the Cyber or Psionic battle (or has 0 in it): it cannot destroy its opponent this battle.',
  Obliterate: 'Die face 6: destroys the opponent\'s die of the same type. As a number it counts as 4.',
  'Ability roll': 'A roll of the red die for a card ability (X values included). Numeric value: faces 1–5 as shown, face 6 = 4.',
  Feeding: 'Carrion Foundress: after it kills in Physical combat, create a Creature from hand costing no more than the victim (burns still paid).',
  Burn: 'Destroy a ready Creation Unit of the listed type to pay.',
};

const PATTERNS: [string, RegExp][] = [
  ['Lock-On', /lock-on/i], ['Calibrate', /calibrat/i], ['Protocol', /protocol/i], ['Mutation', /mutation/i], ['Cannibalize', /cannibali/i],
  ['Reanimated', /reanimat/i], ['Relocate', /relocat/i], ['Reactive', /\breactive\b/i], ['Stack', /\bstack/i],
  ['Contain', /\bcontain/i], ['Deplete', /\bdeplete/i], ['Disoriented', /disorient/i], ['Obliterate', /obliterat/i],
  ['Ability roll', /ability roll|\bX\b/], ['Feeding', /carrion foundress/i], ['Burn', /\bburn/i],
];

/** Keywords that matter for this card: its keyword list plus words in its text. */
export function keywordsFor(def: CardDef): string[] {
  const found = new Set<string>();
  for (const k of def.keywords ?? []) if (KEYWORD_HELP[k]) found.add(k);
  if (def.timing) found.add(def.timing);
  if (def.equip) found.add('Relocate');
  const text = `${def.text ?? ''} ${Object.values(def.protocols ?? {}).join(' ')}`;
  for (const [k, re] of PATTERNS) if (re.test(text)) found.add(k);
  if (Object.values(def.stats ?? {}).includes('X')) found.add('Ability roll');
  return [...found];
}
