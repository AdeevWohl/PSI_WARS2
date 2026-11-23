import { readFileSync } from 'node:fs';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, seedRng, viewFor, type AiLevel } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json')); const rules = read('data/rules.json');
const decks = [read('data/decks/creature-commander.json'), read('data/decks/robot-commander.json')];
function game(levels: AiLevel[], seed: string, swap: boolean) {
  const d = swap ? [decks[1], decks[0]] : decks;
  let { state } = createGame({ defs, rules, seed, players: levels.map((_, i) => ({ name: 'P' + i, deck: d[i % 2] })), autoPassNoPlay: true, maxTurns: 150 });
  const rng = levels.map((_, i) => seedRng(seed + i)); let cmds = 0; const counts: Record<string, number> = {};
  while (!state.result) { const s = state.prompt!.seat; const la = getLegalView(state, s)!; const c = chooseCommand(levels[s]!, viewFor(state, s), la, rules, rng[s]!); counts[c.type] = (counts[c.type] ?? 0) + 1; const r = applyCommand(state, s, c); if (!r.ok) throw new Error(r.error); state = r.state; cmds++; }
  return { state, cmds, counts };
}
const N = Number(process.argv[2] ?? 60);
for (const [a, b] of [['easy', 'easy'], ['normal', 'easy'], ['hard', 'easy'], ['hard', 'normal'], ['normal', 'normal']] as [AiLevel, AiLevel][]) {
  let winsA = 0, draws = 0, turns = 0, cmds = 0; const t0 = performance.now(); const reasons: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    const aSeat = i % 2; const lv: AiLevel[] = aSeat === 0 ? [a, b] : [b, a];
    const { state, cmds: c } = game(lv, `s${a}${b}${i}`, i % 4 >= 2);
    turns += state.turn.number; cmds += c; reasons[state.result!.reason] = (reasons[state.result!.reason] ?? 0) + 1;
    if (state.result!.draw) draws++; else if (state.result!.winners.includes(aSeat)) winsA++;
  }
  const ms = performance.now() - t0;
  console.log(`${a} vs ${b}: ${a} wins ${(100 * winsA / N).toFixed(0)}%, draws ${draws}, avg turns ${(turns / N).toFixed(1)}, cmds/game ${(cmds / N).toFixed(0)}, ${(ms / N).toFixed(0)} ms/game, ${(ms / cmds).toFixed(2)} ms/cmd`, JSON.stringify(reasons));
}
