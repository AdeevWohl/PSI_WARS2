/** Diagnostic: how often do Lock-On opportunities arise in Robot Control games? */
import { readFileSync } from 'node:fs';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, seedRng, viewFor, type RulesData } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json'));
const rules = read('data/rules.json') as RulesData;
const a = read('data/decks/v04-robot-control.json');
const b = read('data/decks/v04-creature-evolution.json');
const c = { prompts: 0, xRolls: 0, blockedX: 0, robotsWithLock: 0, readyG: 0 };
for (let g = 0; g < 6; g++) {
  let { state } = createGame({ defs, rules, seed: `ld${g}`, autoPassNoPlay: true, maxTurns: 120, startingHP: 15, players: [{ name: 'A', deck: g % 2 ? a : b }, { name: 'B', deck: g % 2 ? b : a }] });
  const rngs = [seedRng('x0'), seedRng('x1')];
  while (!state.result) {
    const seat = state.prompt!.seat;
    if (state.prompt!.kind === 'decide' && (state.prompt!.info as any)?.lockOn) c.prompts++;
    const r = applyCommand(state, seat, chooseCommand('normal', viewFor(state, seat), getLegalView(state, seat)!, rules, rngs[seat]!));
    if (!r.ok) throw new Error(r.error);
    for (const e of r.events) {
      if (e.type !== 'XRolled') continue;
      c.xRolls++;
      const atk = state.battle?.attacks.find((x) => x.units.includes(e.uid as string) || x.blockers.includes(e.uid as string));
      if (atk && atk.blockers.length) {
        c.blockedX++;
        const opp = atk.units.includes(e.uid as string) ? atk.blockers : atk.units;
        if (opp.some((u) => defs[state.cards[u]!.cardId]!.effects.some((x) => x.effect === 'LockOn'))) {
          c.robotsWithLock++;
          const owner = state.cards[opp[0]!]!.owner;
          c.readyG += state.players[owner]!.cus.filter((u) => state.cards[u]!.cardId === 'CU_DS' && !state.cards[u]!.depleted).length > 0 ? 1 : 0;
        }
      }
    }
    state = r.state;
  }
}
console.log(c);
