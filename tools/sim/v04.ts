/**
 * v0.4 playtest simulator: every pair of the five example decks, both seat orders, many seeds,
 * 15 Lab HP. Records the metrics asked for in the v0.4 brief and writes reports/v04-sim.{json,md}.
 *
 *   npx tsx tools/sim/v04.ts [gamesPerOrderedPair=20] [ai=normal]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, seedRng, validateDeck, viewFor, type AiLevel, type RulesData } from '../../packages/engine/src/index';
import type { GameEvent, Seat } from '@psi-wars/shared';

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json'));
const rules = read('data/rules.json') as RulesData;
const N = Number(process.argv[2] ?? 20);
const AI = (process.argv[3] ?? 'normal') as AiLevel;
const DECKS = ['robot-control', 'robot-industrial', 'creature-swarm', 'creature-evolution', 'mixed-integration'];
const decks = DECKS.map((n) => ({ name: n, deck: read(`data/decks/v04-${n}.json`) }));

const legality: Record<string, string[]> = {};
for (const d of decks) legality[d.name] = validateDeck(defs, rules, d.deck).map((p) => p.message);

const inc = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);
const matchup: Record<string, { games: number; wins: number; draws: number }> = {};
const deckRow: Record<string, { games: number; wins: number; draws: number }> = {};
const first = { games: 0, wins: 0, draws: 0 };
const turns: number[] = [];
const firstUnitTurn: number[] = [];
const counts: Record<string, number> = {};
const played: Record<string, number> = {};
const activations: Record<string, number> = {};
const mutationsBy: Record<string, number> = {};
const errors: string[] = [];
let stalemates = 0;
let labDamage = 0;
let cuDestroyedPay = 0;
let cuDestroyedOther = 0;
let starvedTurns = 0;
let totalTurns = 0;
const stack = { fights: 0, wins: 0, losses: 0 };
const reanimated = { returned: 0, laterDestroyed: 0, kills: 0 };
const ms0 = Date.now();

for (let i = 0; i < decks.length; i++) for (let j = 0; j < decks.length; j++) {
  if (i === j) continue;
  for (let g = 0; g < N; g++) {
    const seed = `v04:${i}-${j}:${g}`;
    const lineup = [decks[i]!, decks[j]!];
    try {
      let { state, events } = createGame({ defs, rules, seed, autoPassNoPlay: true, maxTurns: 120, startingHP: 15, players: lineup.map((d, k) => ({ name: `P${k}`, deck: d.deck })) });
      const rngs = lineup.map((_, k) => seedRng(`${seed}:ai${k}`));
      const firstUnit: (number | null)[] = [null, null];
      const reanimatedUids = new Set<string>();
      const see = (evs: GameEvent[]) => {
        for (const e of evs) {
          inc(counts, e.type);
          if (e.type === 'CardPlayed' && typeof e.cardId === 'string') {
            inc(played, defs[e.cardId]?.name ?? e.cardId);
            if (e.cardType === 'BattleUnit' && typeof e.seat === 'number' && firstUnit[e.seat] === null) firstUnit[e.seat] = state.turn.number;
            if (e.via === 'feeding') inc(counts, 'FeedingCreated');
          }
          if (e.type === 'AbilityActivated') inc(activations, `${defs[e.cardId as string]?.name}:${e.ability}`);
          if (e.type === 'LockOn') inc(activations, `Lock-On by ${defs[e.cardId as string]?.name}`);
          if (e.type === 'Calibrated') inc(activations, `Calibrate (${defs[e.cardId as string]?.name})`);
          if (e.type === 'ProtocolSet') inc(activations, `Protocol ${defs[e.cardId as string]?.name}: ${e.mode}`);
          if (e.type === 'StatModified' && e.kind === 'mutation') inc(mutationsBy, defs[e.cardId as string]?.name ?? '?');
          if (e.type === 'LabDamaged') labDamage += Number(e.amount ?? 0);
          if (e.type === 'CUDestroyed') (e.forUid ? (cuDestroyedPay += (e.uids as string[]).length) : (cuDestroyedOther += (e.uids as string[]).length));
          if (e.type === 'UnitRevived' && e.reanimated) { reanimated.returned++; reanimatedUids.add(e.uid as string); }
          if (e.type === 'UnitDestroyed' && reanimatedUids.has(e.uid as string)) reanimated.laterDestroyed++;
          if (e.type === 'BattleResolved') {
            const a = e.att as { units: string[]; destroyed: boolean };
            const d = e.def as { units: string[]; destroyed: boolean };
            for (const [mine, theirs] of [[a, d], [d, a]] as const) {
              if (mine.units.length === 2) { stack.fights++; if (theirs.destroyed) stack.wins++; if (mine.destroyed) stack.losses++; }
              if (theirs.destroyed && mine.units.some((u) => reanimatedUids.has(u))) reanimated.kills++;
            }
          }
          if (e.type === 'PhaseChanged' && e.phase === 'creation') {
            totalTurns++;
            const seat = e.seat as Seat;
            const ready = state.players[seat]!.cus.filter((u) => !state.cards[u]!.depleted).length;
            if (ready === 0 && state.turn.number > 2) starvedTurns++;
          }
        }
      };
      see(events);
      let guard = 0;
      while (!state.result) {
        if (++guard > 30000) throw new Error('soft-lock');
        const seat = state.prompt!.seat as Seat;
        const legal = getLegalView(state, seat)!;
        const cmd = chooseCommand(AI, viewFor(state, seat), legal, rules, rngs[seat]!);
        const r = applyCommand(state, seat, cmd);
        if (!r.ok) throw new Error(`AI command rejected (${state.prompt?.kind} ${state.prompt?.label}): ${r.error} ${JSON.stringify(cmd)}`);
        state = r.state;
        see(r.events);
      }
      const res = state.result;
      const draw = res.draw || !res.winners.length;
      if (res.reason === 'turnLimit') stalemates++;
      turns.push(state.turn.number);
      for (const f of firstUnit) if (f !== null) firstUnitTurn.push(f);
      const key = `${lineup[0]!.name} vs ${lineup[1]!.name}`;
      const mu = (matchup[key] ??= { games: 0, wins: 0, draws: 0 });
      mu.games++;
      if (draw) mu.draws++;
      else if (res.winners.includes(0)) mu.wins++;
      lineup.forEach((d, k) => {
        const row = (deckRow[d.name] ??= { games: 0, wins: 0, draws: 0 });
        row.games++;
        if (draw) row.draws++;
        else if (res.winners.includes(k)) row.wins++;
      });
      first.games++;
      if (draw) first.draws++;
      else if (res.winners.includes(state.turn.firstPlayer)) first.wins++;
    } catch (err) {
      errors.push(`${seed}: ${(err as Error).message}`);
    }
  }
}

const sorted = [...turns].sort((a, b) => a - b);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (w: number, g: number) => (g ? `${((w / g) * 100).toFixed(1)}%` : '-');
const games = turns.length;
const report = {
  games, ai: AI, gamesPerOrderedPair: N, startingHP: 15, seconds: Math.round((Date.now() - ms0) / 1000), legality, errors,
  firstPlayer: first, decks: deckRow, matchups: matchup,
  turns: { average: avg(turns), median: sorted[Math.floor(sorted.length / 2)] ?? 0, stalemates },
  firstBattleUnitTurnAvg: avg(firstUnitTurn),
  labDamagePerGame: labDamage / Math.max(1, games),
  resources: { burnedForCostsPerGame: cuDestroyedPay / Math.max(1, games), destroyedByEffectsPerGame: cuDestroyedOther / Math.max(1, games), creationPhasesWithNoReadyCU: pct(starvedTurns, totalTurns) },
  mechanics: {
    lockOns: counts.LockOn ?? 0, calibrations: counts.Calibrated ?? 0, protocolChoices: counts.ProtocolSet ?? 0, mutations: mutationsBy,
    cannibalized: counts.Cannibalized ?? 0, feedingTriggers: counts.FeedingTriggered ?? 0, feedingCreations: counts.FeedingCreated ?? 0,
    reanimated, stacks: { formed: counts.Stacked ?? 0, ...stack }, containments: counts.UnitTrapped ?? 0, counters: counts.Countered ?? 0,
    damagePrevented: counts.DamagePrevented ?? 0, activations,
  },
  cardsPlayed: Object.fromEntries(Object.entries(played).sort((a, b) => b[1] - a[1])),
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/v04-sim.json', JSON.stringify(report, null, 1));
const md = [
  `# v0.4 simulation — ${games} games, ${AI} AI, 15 Lab HP`,
  '',
  `Errors: ${errors.length}${errors.length ? '\n- ' + errors.slice(0, 10).join('\n- ') : ''}`,
  '',
  `First player wins ${pct(first.wins, first.games)} (draws ${first.draws}). Turns: average ${report.turns.average.toFixed(1)}, median ${report.turns.median}, turn-limit stalemates ${stalemates}. First Battle Unit on turn ${report.firstBattleUnitTurnAvg.toFixed(2)} on average. Lab damage per game ${report.labDamagePerGame.toFixed(1)}.`,
  '',
  '| Deck | Games | Win rate | Draws |', '|---|---|---|---|',
  ...Object.entries(deckRow).map(([k, v]) => `| ${k} | ${v.games} | ${pct(v.wins, v.games)} | ${v.draws} |`),
  '',
  '| Matchup (first-listed deck sits in seat 1) | Games | Seat-1 deck wins | Draws |', '|---|---|---|---|',
  ...Object.entries(matchup).map(([k, v]) => `| ${k} | ${v.games} | ${pct(v.wins, v.games)} | ${v.draws} |`),
  '',
  '## Mechanics', '```', JSON.stringify(report.mechanics, null, 1), '```',
  '## Resources', '```', JSON.stringify(report.resources, null, 1), '```',
  '## Deck legality', '```', JSON.stringify(legality, null, 1), '```',
].join('\n');
writeFileSync('reports/v04-sim.md', md);
console.log(md.slice(0, 3000));
