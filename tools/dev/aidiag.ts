import { readFileSync } from 'node:fs';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, seedRng, viewFor, type AiLevel } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json')); const rules = read('data/rules.json');
const decks = [read('data/decks/creature-commander.json'), read('data/decks/robot-commander.json')];
const stat: Record<string, Record<string, number>> = { easy: {}, normal: {} };
const add = (lv: string, k: string, n = 1) => (stat[lv]![k] = (stat[lv]![k] ?? 0) + n);
for (let i = 0; i < 40; i++) {
  const levels: AiLevel[] = i % 2 ? ['easy', 'normal'] : ['normal', 'easy'];
  let { state } = createGame({ defs, rules, seed: 'd' + i, players: levels.map((_, k) => ({ name: 'P' + k, deck: decks[(k + (i >> 1)) % 2] })), autoPassNoPlay: true, maxTurns: 150 });
  const rng = levels.map((_, k) => seedRng('r' + i + k));
  while (!state.result) {
    const s = state.prompt!.seat; const la = getLegalView(state, s)!; const lv = levels[s]!;
    const c = chooseCommand(lv, viewFor(state, s), la, rules, rng[s]!);
    if (c.type === 'DeclareAttackers') { add(lv, 'attackPrompts'); add(lv, 'eligible', la.attack!.eligible.length); add(lv, 'attackers', c.attacks.length); }
    if (c.type === 'AssignBlockers') { add(lv, 'blockPrompts'); add(lv, 'blocks', c.blocks.length); }
    if (c.type === 'PlayCard') add(lv, 'play:' + state.defs[state.cards[c.uid]!.cardId]!.cardType);
    if (c.type === 'AdvancePhase') { add(lv, 'advance'); add(lv, 'unplayedAffordable', la.plays.length); }
    const r = applyCommand(state, s, c); if (!r.ok) throw new Error(r.error);
    for (const e of r.events) if (e.type === 'LabDamaged') add(levels[e.seat as number] === 'easy' ? 'normal' : 'easy', 'dmgDealt', e.amount as number);
    for (const e of r.events) if (e.type === 'UnitDestroyed') add(levels[e.seat as number]!, 'unitsLost');
    state = r.state;
  }
  add(levels[state.result!.winners[0]!]!, 'WINS');
}
console.log(JSON.stringify(stat, null, 1));
