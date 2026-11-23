import { readFileSync } from 'node:fs';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, seedRng, viewFor, type AiLevel } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json')); const rules = read('data/rules.json');
const decks = [read('data/decks/creature-commander.json'), read('data/decks/robot-commander.json')];
const N = Number(process.argv[2] ?? 120);
for (const [a, b] of [['normal', 'easy'], ['hard', 'easy'], ['hard', 'normal']] as [AiLevel, AiLevel][]) {
  let wins = 0;
  for (let i = 0; i < N; i++) {
    const deck = decks[i % 2]; const aSeat = (i >> 1) % 2; const lv: AiLevel[] = aSeat === 0 ? [a, b] : [b, a];
    let { state } = createGame({ defs, rules, seed: `m${a}${b}${i}`, players: [0, 1].map((k) => ({ name: 'P' + k, deck })), autoPassNoPlay: true, maxTurns: 150 });
    const rng = [seedRng('x' + i), seedRng('y' + i)];
    while (!state.result) { const s = state.prompt!.seat; const c = chooseCommand(lv[s]!, viewFor(state, s), getLegalView(state, s)!, rules, rng[s]!); const r = applyCommand(state, s, c); if (!r.ok) throw 0; state = r.state; }
    if (state.result!.winners.includes(aSeat)) wins++;
  }
  console.log(`mirror ${a} vs ${b}: ${a} wins ${(100 * wins / N).toFixed(0)}% (${N} games)`);
}
