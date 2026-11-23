import { readFileSync } from 'node:fs';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, seedRng, viewFor, type AiLevel } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json')); const rules = read('data/rules.json');
const decks = [read('data/decks/creature-commander.json'), read('data/decks/robot-commander.json')];
for (const lv of ['easy', 'normal', 'hard'] as AiLevel[]) {
  let creature = 0; const N = 100;
  for (let i = 0; i < N; i++) {
    const swap = i % 2 === 1; const d = swap ? [decks[1], decks[0]] : decks;
    let { state } = createGame({ defs, rules, seed: 'b' + lv + i, players: [0, 1].map((k) => ({ name: 'P' + k, deck: d[k] })), autoPassNoPlay: true, maxTurns: 150 });
    const rng = [seedRng('x' + i), seedRng('y' + i)];
    while (!state.result) { const s = state.prompt!.seat; const c = chooseCommand(lv, viewFor(state, s), getLegalView(state, s)!, rules, rng[s]!); const r = applyCommand(state, s, c); if (!r.ok) throw 0; state = r.state; }
    const creatureSeat = swap ? 1 : 0; if (state.result!.winners.includes(creatureSeat)) creature++;
  }
  console.log(`${lv} mirror: Creature Commander deck wins ${creature}%`);
}
