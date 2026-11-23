// Finds a seed for the tutorial: the player (seat 0) goes first and can afford a Battle Unit on
// their second turn (turn 3) and Equipment on their third (turn 5), with no Oracle prompt on turn 1.
import { readFileSync } from 'node:fs';
import { buildDefs, canAfford, createGame } from '../../packages/engine/src/index';
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json')); const rules = read('data/rules.json');
const decks = [read('data/decks/creature-commander.json'), read('data/decks/robot-commander.json')];
const CU: Record<string, string> = { CU_DS: 'G', CU_NG: 'B', CU_BA: 'R', CU_MA: 'P' };
const affordable = (cost: any, cus: string[]) => {
  const have: Record<string, number> = { G: 0, B: 0, R: 0, P: 0 };
  for (const c of cus) have[c]++;
  let spare = 0; const types = ['G', 'B', 'R', 'P'].filter((t) => cost[t] > 0);
  for (const t of ['G', 'B', 'R', 'P']) { if (have[t] < cost[t]) return false; if (!types.length || types.includes(t)) spare += have[t] - cost[t]; }
  return spare >= cost.W;
};
void canAfford;
for (let i = 0; i < 4000; i++) {
  const seed = `tutorial-${i}`;
  const { state } = createGame({ defs, rules, seed, players: decks.map((d, k) => ({ name: 'P' + k, deck: d })) });
  if (state.turn.firstPlayer !== 0) continue;
  // createGame runs up to the first decision, so turn 1's Resource draw has already happened.
  if (state.prompt?.kind === 'oracle') continue; // no Oracle prompt on turn 1
  const p = state.players[0]!;
  const now = p.cus.map((u) => CU[state.cards[u]!.cardId]!);
  const res = p.resourceDeck.slice(0, 2).map((u) => state.cards[u]!.cardId);
  if (now.length !== 1 || res.some((id) => !CU[id])) continue; // turn 3 and 5 draws are plain CUs
  const cus3 = [...now, CU[res[0]!]!];
  const cus5 = [...cus3, CU[res[1]!]!];
  const hand3 = [...p.hand, p.battleDeck[0]!].map((u) => defs[state.cards[u]!.cardId]!);
  const hand5 = [...hand3, defs[state.cards[p.battleDeck[1]!]!.cardId]!];
  if (hand3.some((d) => d.cardType === 'BattleUnit' && affordable(d.cost, now))) continue; // nothing on turn 1
  const unit3 = hand3.filter((d) => d.cardType === 'BattleUnit' && affordable(d.cost, cus3));
  const equip5 = hand5.filter((d) => d.cardType === 'Equipment' && affordable(d.cost, cus5));
  if (unit3.length && equip5.length) {
    console.log(JSON.stringify({ seed, cus5, hand: hand5.map((d) => d.name), unit3: unit3.map((d) => d.name), equip5: equip5.map((d) => d.name) }));
    break;
  }
}
