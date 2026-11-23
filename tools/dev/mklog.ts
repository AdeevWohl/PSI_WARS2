// Writes a full AI-vs-AI game log (for testing the replay viewer): npx tsx tools/dev/mklog.ts out.json [seed]
import { readFileSync, writeFileSync } from 'node:fs';
import type { Command, Seat } from '../../packages/shared/src/index';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, makeLog, seedRng, viewFor } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const setup = { defs: buildDefs(read('data/cards.json')), rules: read('data/rules.json'), seed: process.argv[3] ?? 'replay-demo', players: [{ name: 'Creature AI', deck: read('data/decks/creature-commander.json') }, { name: 'Robot AI', deck: read('data/decks/robot-commander.json') }], autoPassNoPlay: true };
let { state, events } = createGame(setup);
const all = [...events];
const commands: { seat: Seat; cmd: Command }[] = [];
const rng = seedRng('demo-ai');
while (!state.result) {
  const seat = state.prompt!.seat;
  const cmd = chooseCommand('normal', viewFor(state, seat), getLegalView(state, seat)!, setup.rules, rng);
  const r = applyCommand(state, seat, cmd);
  if (!r.ok) throw new Error(r.error);
  state = r.state;
  commands.push({ seat, cmd });
  all.push(...r.events);
}
writeFileSync(process.argv[2] ?? 'log.json', JSON.stringify(makeLog(setup, commands, all, state, { kinds: ['ai-normal', 'ai-normal'], createdAt: new Date().toISOString() })));
console.log(`${commands.length} commands, ${state.turn.number} turns, result ${JSON.stringify(state.result)}`);
