/**
 * v0.4.1 simulation with card- and mechanic-level telemetry.
 *
 *   npx tsx tools/sim/v041.ts original           400 games: the v0.4 seeds (every ordered deck pair × 20)
 *   npx tsx tools/sim/v041.ts matchups 1000      N games per non-mirror matchup, seats alternating
 *
 * Writes reports/v041-<mode>/: summary.md, games.csv, matchups.csv, decks.csv, cards.csv, mechanics.csv.
 * Normal AI, 15 Lab HP, deterministic seeds.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { applyCommand, buildDefs, chooseCommand, createGame, getLegalView, seedRng, validateDeck, viewFor, type AiLevel, type RulesData } from '../../packages/engine/src/index';
import type { GameEvent, Seat } from '@psi-wars/shared';

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const defs = buildDefs(read('data/cards.json'));
const rules = read('data/rules.json') as RulesData;
const mode = process.argv[2] ?? 'original';
const N = Number(process.argv[3] ?? (mode === 'original' ? 20 : 1000));
const AI: AiLevel = 'normal';
const DECKS = ['robot-control', 'robot-industrial', 'creature-swarm', 'creature-evolution', 'mixed-integration'];
const decks = DECKS.map((n) => ({ name: n, deck: read(`data/decks/v04-${n}.json`) }));
const out = `reports/v041-${mode}`;
mkdirSync(out, { recursive: true });

// ---- schedule: [deck index seat 0, deck index seat 1, seed]
const games: [number, number, string][] = [];
if (mode === 'original') {
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (i !== j) for (let g = 0; g < N; g++) games.push([i, j, `v04:${i}-${j}:${g}`]);
} else {
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let g = 0; g < N; g++) games.push(g % 2 ? [j, i, `m:${i}-${j}:${g}`] : [i, j, `m:${i}-${j}:${g}`]);
}

// ---- accumulators
type Row = Record<string, number>;
const inc = (m: Row, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);
const gameRows: string[] = ['seed,seat0_deck,seat1_deck,first_player_deck,winner_deck,reason,turns,seat0_lab_hp,seat1_lab_hp,lab_damage_total,units_destroyed,cus_burned,cus_destroyed_by_effects'];
const matchup: Record<string, { a: string; b: string; games: number; aWins: number; bWins: number; draws: number; aFirstGames: number; aFirstWins: number; turns: number }> = {};
const deckRow: Record<string, Row> = {};
const cards: Record<string, Row> = {};
const cardDecks: Record<string, Set<string>> = {};
const mech: Record<string, Row> = {};
const errors: string[] = [];
let firstGames = 0;
let firstWins = 0;
const turnsAll: number[] = [];
const t0 = Date.now();

const C = (id: string) => (cards[id] ??= {});
const M = (deck: string) => (mech[deck] ??= {});
const nameOf = (id: string) => defs[id]?.name ?? id;

for (const [i, j, seed] of games) {
  const lineup = [decks[i]!, decks[j]!];
  try {
    let { state, events } = createGame({ defs, rules, seed, autoPassNoPlay: true, maxTurns: 120, startingHP: 15, players: lineup.map((d, k) => ({ name: `P${k}`, deck: d.deck })) });
    const rngs = lineup.map((_, k) => seedRng(`${seed}:ai${k}`));
    const playedBy: Set<string>[] = [new Set(), new Set()];
    const g = { labDamage: 0, destroyed: 0, burned: 0, effectBurn: 0 };
    const deckOf = (seat: unknown) => lineup[Number(seat)]?.name ?? '?';
    const ownerOf = (uid: unknown) => state.cards[String(uid)]?.owner;
    const see = (evs: GameEvent[]) => {
      for (const e of evs) {
        const seatDeck = typeof e.seat === 'number' ? deckOf(e.seat) : null;
        switch (e.type) {
          case 'CardPlayed': {
            const id = String(e.cardId);
            inc(C(id), 'played');
            playedBy[Number(e.seat)]?.add(id);
            if (e.via === 'feeding') inc(M(seatDeck!), 'Feeding: Creature created');
            if (defs[id]?.cardType === 'Power') inc(M(seatDeck!), `Power cast: ${defs[id]!.timing}`);
            break;
          }
          case 'UnitDestroyed':
            inc(C(String(e.cardId)), 'deaths');
            g.destroyed++;
            if (e.cause === 'cannibalize') inc(C(String(e.cardId)), 'cannibalized');
            break;
          case 'BattleResolved': {
            const a = e.att as { units: string[]; destroyed: boolean; seat: number };
            const d = e.def as { units: string[]; destroyed: boolean; seat: number };
            for (const [mine, theirs] of [[a, d], [d, a]] as const) {
              for (const u of mine.units) {
                const id = state.cards[u]?.cardId;
                if (!id) continue;
                inc(C(id), 'fights');
                if (theirs.destroyed && !mine.destroyed) inc(C(id), 'kills');
              }
              if (mine.units.length === 2) {
                inc(M(deckOf(mine.seat)), 'Stack fights');
                if (theirs.destroyed) inc(M(deckOf(mine.seat)), 'Stack fights won (kill)');
                if (mine.destroyed) inc(M(deckOf(mine.seat)), 'Stack fights lost (both destroyed)');
              }
            }
            break;
          }
          case 'UnblockedHit': {
            const units = e.units as string[];
            for (const u of units) { const id = state.cards[u]?.cardId; if (id) inc(C(id), 'labDamage', Number(e.damage) / units.length); }
            break;
          }
          case 'LabDamaged':
            g.labDamage += Number(e.amount ?? 0);
            break;
          case 'CUDestroyed':
            if (e.forUid) g.burned += (e.uids as string[]).length;
            else g.effectBurn += (e.uids as string[]).length;
            break;
          case 'LockOn': inc(C(String(e.cardId)), 'activations'); inc(M(seatDeck!), 'Lock-On'); inc(M(seatDeck!), `Lock-On face ${e.side}`); break;
          case 'Calibrated': inc(C(String(e.cardId)), 'activations'); inc(M(deckOf(ownerOf(e.uid))), 'Calibrate'); break;
          case 'ProtocolSet': inc(C(String(e.cardId)), 'activations'); inc(M(seatDeck!), `Protocol ${nameOf(String(e.cardId))}: ${e.mode}`); break;
          case 'AbilityActivated': inc(C(String(e.cardId)), 'activations'); inc(M(seatDeck!), `Activated: ${nameOf(String(e.cardId))}`); break;
          case 'StatModified':
            if (e.kind === 'mutation') { inc(C(String(e.sourceCardId ?? e.cardId)), 'mutationsGranted'); inc(M(deckOf(e.seat)), 'Mutation'); }
            if (e.kind === 'reanimated') inc(M(deckOf(e.seat)), 'Reanimated stat change');
            if (e.kind === 'permanent') inc(M(deckOf(e.seat)), 'Permanent upgrade');
            break;
          case 'Cannibalized': inc(M(seatDeck!), 'Cannibalize'); break;
          case 'FeedingTriggered': inc(M(seatDeck!), 'Feeding: triggered'); break;
          case 'UnitRevived': if (e.reanimated) inc(M(seatDeck!), 'Reanimated return'); else inc(M(seatDeck!), 'Revived (Robo Refurb)'); break;
          case 'Stacked': inc(M(seatDeck!), 'Stacks formed'); break;
          case 'Restricted': inc(C(String(e.sourceCardId)), 'activations'); inc(M(deckOf(1 - Number(e.seat))), `Restriction: ${nameOf(String(e.sourceCardId))}`); break;
          case 'EscapeAttempt': inc(M(seatDeck!), e.freed ? 'Escape succeeded' : 'Escape failed'); break;
          case 'Countered': inc(M(deckOf(ownerOf(e.by))), 'Counter (Emergency Firewall)'); break;
          case 'DamagePrevented': inc(M(deckOf(ownerOf(e.uid))), 'Damage prevented'); break;
          case 'UnitDepleted': if (e.sourceCardId) inc(M(deckOf(ownerOf(e.source))), `Depletion by ${nameOf(String(e.sourceCardId))}`); break;
          case 'EquipmentMoved': inc(M(seatDeck!), e.paid ? 'Equipment relocated (paid)' : 'Equipment relocated (free)'); break;
          case 'FortificationUsed': inc(M(seatDeck!), 'Resource Fortification used'); break;
          case 'XRolled': inc(M(deckOf(ownerOf(e.uid))), e.locked ? 'X roll (locked)' : 'X roll'); break;
        }
      }
    };
    see(events);
    let guard = 0;
    while (!state.result) {
      if (++guard > 30000) throw new Error('soft-lock');
      const seat = state.prompt!.seat as Seat;
      const cmd = chooseCommand(AI, viewFor(state, seat), getLegalView(state, seat)!, rules, rngs[seat]!);
      const r = applyCommand(state, seat, cmd);
      if (!r.ok) throw new Error(`AI command rejected (${state.prompt?.kind}): ${r.error}`);
      state = r.state;
      see(r.events);
    }
    const res = state.result;
    const draw = res.draw || !res.winners.length;
    const winner = draw ? null : res.winners[0]!;
    const fp = state.turn.firstPlayer;
    firstGames++;
    if (!draw && winner === fp) firstWins++;
    turnsAll.push(state.turn.number);
    const [A, B] = [decks[Math.min(i, j)]!.name, decks[Math.max(i, j)]!.name];
    const key = `${A} vs ${B}`;
    const mu = (matchup[key] ??= { a: A, b: B, games: 0, aWins: 0, bWins: 0, draws: 0, aFirstGames: 0, aFirstWins: 0, turns: 0 });
    mu.games++;
    mu.turns += state.turn.number;
    const winDeck = winner === null ? null : lineup[winner]!.name;
    if (draw) mu.draws++;
    else if (winDeck === A) mu.aWins++;
    else mu.bWins++;
    if (lineup[fp]!.name === A) { mu.aFirstGames++; if (winDeck === A) mu.aFirstWins++; }
    lineup.forEach((d, k) => {
      const r = (deckRow[d.name] ??= {});
      inc(r, 'games');
      if (draw) inc(r, 'draws');
      else if (winner === k) inc(r, 'wins');
      if (fp === k) { inc(r, 'firstGames'); if (winner === k) inc(r, 'firstWins'); }
      for (const id of playedBy[k]!) {
        inc(C(id), 'gamesPlayed');
        if (winner === k) inc(C(id), 'gamesPlayedWon');
        (cardDecks[id] ??= new Set()).add(d.name);
      }
    });
    gameRows.push([seed, lineup[0]!.name, lineup[1]!.name, lineup[fp]!.name, winDeck ?? 'draw', res.reason, state.turn.number, state.players[0]!.labHP, state.players[1]!.labHP, g.labDamage, g.destroyed, g.burned, g.effectBurn].join(','));
  } catch (err) {
    errors.push(`${seed}: ${(err as Error).message}`);
  }
}

// ---- write CSVs
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : '');
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
writeFileSync(`${out}/games.csv`, gameRows.join('\n'));
writeFileSync(`${out}/matchups.csv`, ['deck_a,deck_b,games,a_wins,b_wins,draws,a_win_pct,a_win_pct_when_a_first,avg_turns', ...Object.values(matchup).map((m) => [m.a, m.b, m.games, m.aWins, m.bWins, m.draws, pct(m.aWins, m.games - m.draws), pct(m.aFirstWins, m.aFirstGames), (m.turns / m.games).toFixed(1)].join(','))].join('\n'));
writeFileSync(`${out}/decks.csv`, ['deck,games,wins,draws,win_pct,first_player_games,first_player_win_pct', ...Object.entries(deckRow).map(([k, r]) => [k, r.games ?? 0, r.wins ?? 0, r.draws ?? 0, pct(r.wins ?? 0, r.games ?? 0), r.firstGames ?? 0, pct(r.firstWins ?? 0, r.firstGames ?? 0)].join(','))].join('\n'));
const cardIds = Object.keys(defs).filter((id) => defs[id]!.deck === 'battle').sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
writeFileSync(`${out}/cards.csv`, ['card_id,name,type,decks_using,times_played,games_played_in,win_pct_when_played,fights,kills,deaths,lab_damage,activations,mutations_granted,cannibalized',
  ...cardIds.map((id) => { const r = cards[id] ?? {}; const d = defs[id]!; return [id, q(d.name), d.cardType === 'BattleUnit' ? d.unitType : d.cardType, q([...(cardDecks[id] ?? [])].join(' / ')), r.played ?? 0, r.gamesPlayed ?? 0, pct(r.gamesPlayedWon ?? 0, r.gamesPlayed ?? 0), r.fights ?? 0, r.kills ?? 0, r.deaths ?? 0, (r.labDamage ?? 0).toFixed(1), r.activations ?? 0, r.mutationsGranted ?? 0, r.cannibalized ?? 0].join(','); })].join('\n'));
const mechNames = [...new Set(Object.values(mech).flatMap((m) => Object.keys(m)))].sort();
const totalGames = games.length - errors.length;
writeFileSync(`${out}/mechanics.csv`, ['mechanic,total,per_game,' + DECKS.join(','), ...mechNames.map((k) => { const tot = DECKS.reduce((s, d) => s + (mech[d]?.[k] ?? 0), 0); return [q(k), tot, (tot / Math.max(1, totalGames)).toFixed(3), ...DECKS.map((d) => mech[d]?.[k] ?? 0)].join(','); })].join('\n'));

const sorted = [...turnsAll].sort((a, b) => a - b);
const legality = Object.fromEntries(decks.map((d) => [d.name, validateDeck(defs, rules, d.deck).map((p) => p.message)]));
const md = [
  `# v0.4.1 simulation — ${mode} (${totalGames} games, Normal AI, 15 Lab HP)`, '',
  `Errors: ${errors.length}${errors.length ? '\n- ' + errors.slice(0, 10).join('\n- ') : ''}. Time: ${Math.round((Date.now() - t0) / 1000)} s.`, '',
  `First player wins ${pct(firstWins, firstGames)}%. Turns: average ${(turnsAll.reduce((a, b) => a + b, 0) / Math.max(1, turnsAll.length)).toFixed(1)}, median ${sorted[Math.floor(sorted.length / 2)] ?? 0}. Turn-limit games: ${gameRows.filter((r) => r.includes(',turnLimit,')).length}.`, '',
  '| Deck | Games | Win % | Win % going first |', '|---|---|---|---|',
  ...Object.entries(deckRow).map(([k, r]) => `| ${k} | ${r.games} | ${pct(r.wins ?? 0, r.games ?? 0)} | ${pct(r.firstWins ?? 0, r.firstGames ?? 0)} |`), '',
  '| Matchup | Games | First deck win % | Draws | Avg turns |', '|---|---|---|---|---|',
  ...Object.values(matchup).map((m) => `| ${m.a} vs ${m.b} | ${m.games} | ${pct(m.aWins, m.games - m.draws)} | ${m.draws} | ${(m.turns / m.games).toFixed(1)} |`), '',
  `Deck legality: ${JSON.stringify(legality)}`, '',
  'Files: games.csv (one row per game), matchups.csv, decks.csv, cards.csv (per-card performance), mechanics.csv (activation counts per deck).',
].join('\n');
writeFileSync(`${out}/summary.md`, md);
console.log(md);
