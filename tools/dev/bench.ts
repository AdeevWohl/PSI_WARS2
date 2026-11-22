import { readFileSync } from 'node:fs';
import { applyCommand, buildDefs, createGame, randomLegalCommand, seedRng } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json')); const rules = read('data/rules.json');
const decks = [read('data/decks/creature-commander.json'), read('data/decks/robot-commander.json')];
for (const n of [2, 4]) {
  let cmds = 0, turns = 0; const t0 = performance.now();
  for (let g = 0; g < 20; g++) {
    let { state } = createGame({ defs, rules, seed: `b${g}`, players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, deck: decks[i % 2] })), maxTurns: 120 });
    const r = seedRng(`c${g}`);
    while (!state.result) { const p = randomLegalCommand(state, r)!; const res = applyCommand(state, p.seat, p.cmd); if (!res.ok) throw 0; state = res.state; cmds++; }
    turns += state.turn.number;
  }
  const ms = performance.now() - t0;
  console.log(`${n}p: ${cmds} cmds, avg turns ${turns / 20}, ${(ms / cmds).toFixed(3)} ms/cmd, ${(ms / 20).toFixed(0)} ms/game`);
}
const { state } = createGame({ defs, rules, seed: 'x', players: [0,1,2,3].map(i => ({ name: 'P'+i, deck: decks[i%2] })) });
const { defs: _d, rules: _r, ...rest } = state as any;
let t = performance.now(); for (let i = 0; i < 2000; i++) structuredClone(rest); console.log('structuredClone', ((performance.now() - t) / 2000).toFixed(3), 'ms');
t = performance.now(); for (let i = 0; i < 2000; i++) JSON.parse(JSON.stringify(rest)); console.log('JSON clone', ((performance.now() - t) / 2000).toFixed(3), 'ms');
