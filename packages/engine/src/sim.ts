/**
 * Headless AI-vs-AI batch simulation (build prompt §13). Pure and deterministic for a given
 * seed, so the same run can be repeated before and after a balance change. Used by tools/sim
 * (Node) and by the card editor's quick test (a Web Worker in the browser).
 */
import type { Seat } from '@psi-wars/shared';
import { chooseCommand, type AiLevel } from './ai';
import { applyCommand } from './commands';
import { getLegalView } from './legal';
import { seedRng } from './rng';
import { createGame, type DeckList } from './setup';
import type { CardDef, RulesData } from './types';
import { viewFor } from './view';

export interface SimDeck {
  name: string;
  deck: DeckList;
}

export interface SimOptions {
  defs: Record<string, CardDef>;
  rules: RulesData;
  decks: SimDeck[];
  games: number;
  players?: number;
  /** One level for everyone, or one per seat. */
  ai?: AiLevel | AiLevel[];
  seed?: string;
  startingHP?: number;
  maxTurns?: number;
  /** Include games where every seat plays the same deck (default: only when there is one deck). */
  mirrors?: boolean;
  balanceName?: string;
  onProgress?: (done: number, total: number) => void;
  /** Clock for the report's run time (the engine itself never reads the time). */
  now?: () => number;
}

export interface RateRow {
  games: number;
  wins: number;
  draws: number;
  winRate: number;
}

export interface CardRow {
  id: string;
  name: string;
  /** Player-games with this card in the deck. */
  present: RateRow;
  /** Player-games in which the card was actually played (cast, created or used). */
  played: RateRow;
  /**
   * Win rate when played minus the win rate its decks had overall (positive = the card's
   * games go better than its deck's average). Separates the card from the deck it sits in.
   */
  playedDelta: number;
  /** The win rate its decks had overall, weighted by the games in which it was played. */
  expected: number;
  avgCopiesPlayed: number;
}

export interface SimReport {
  games: number;
  players: number;
  seed: string;
  ai: AiLevel[];
  balance: string;
  ms: number;
  draws: number;
  turnLimitGames: number;
  errors: { seed: string; error: string }[];
  /** Expected win rate of a seat if all decks were equal: (1 - draw rate) / players. */
  baseline: number;
  decks: (RateRow & { name: string; asFirstPlayer: RateRow })[];
  matchups: { decks: string[]; games: number; wins: number[]; draws: number }[];
  firstPlayer: RateRow;
  length: { avgTurns: number; avgRounds: number; medianTurns: number; minTurns: number; maxTurns: number; avgCommands: number };
  reasons: Record<string, number>;
  firstDestroyed: { id: string; name: string; count: number; share: number }[];
  destroyed: { id: string; name: string; count: number; perGame: number }[];
  cards: CardRow[];
}

const rate = (r: { games: number; wins: number; draws: number }): RateRow => ({ ...r, winRate: r.games ? r.wins / r.games : 0 });

function lineups(n: number, k: number, mirrors: boolean): number[][] {
  const out: number[][] = [];
  const rec = (cur: number[]) => {
    if (cur.length === n) {
      if (mirrors || k === 1 || new Set(cur).size > 1) out.push([...cur]);
      return;
    }
    for (let i = 0; i < k; i++) rec([...cur, i]);
  };
  rec([]);
  return out;
}

export function runSimulation(o: SimOptions): SimReport {
  const now = o.now ?? (() => 0);
  const t0 = now();
  const n = o.players ?? 2;
  if (n < 2 || n > 4) throw new Error('players must be 2 to 4');
  if (!o.decks.length) throw new Error('at least one deck is needed');
  const levels: AiLevel[] = Array.isArray(o.ai) ? Array.from({ length: n }, (_, i) => (o.ai as AiLevel[])[i % (o.ai as AiLevel[]).length]!) : Array(n).fill(o.ai ?? 'normal');
  const seed = o.seed ?? 'sim';
  const ups = lineups(n, o.decks.length, o.mirrors ?? false);
  const deckStats = o.decks.map(() => ({ games: 0, wins: 0, draws: 0, f: { games: 0, wins: 0, draws: 0 } }));
  const matchups = new Map<string, { decks: string[]; games: number; wins: number[]; draws: number }>();
  const cards = new Map<string, { present: { games: number; wins: number; draws: number }; played: { games: number; wins: number; draws: number }; copies: number; byDeck: number[] }>();
  const card = (id: string) => {
    let c = cards.get(id);
    if (!c) cards.set(id, (c = { present: { games: 0, wins: 0, draws: 0 }, played: { games: 0, wins: 0, draws: 0 }, copies: 0, byDeck: o.decks.map(() => 0) }));
    return c;
  };
  const firstDestroyed = new Map<string, number>();
  const destroyed = new Map<string, number>();
  const reasons: Record<string, number> = {};
  const turns: number[] = [];
  const first = { games: 0, wins: 0, draws: 0 };
  const errors: { seed: string; error: string }[] = [];
  let draws = 0;
  let turnLimit = 0;
  let commands = 0;

  for (let g = 0; g < o.games; g++) {
    const lineup = ups[g % ups.length]!;
    const gameSeed = `${seed}:${g}`;
    try {
      let { state, events } = createGame({
        defs: o.defs, rules: o.rules, seed: gameSeed, autoPassNoPlay: true, maxTurns: o.maxTurns ?? 150, startingHP: o.startingHP,
        players: lineup.map((d, i) => ({ name: `P${i + 1}`, deck: o.decks[d]!.deck })),
      });
      const rngs = levels.map((_, i) => seedRng(`${gameSeed}:ai${i}`));
      const playedBy: Map<string, number>[] = lineup.map(() => new Map());
      let firstDead: string | null = null;
      const see = (evs: typeof events) => {
        for (const e of evs) {
          if (e.type === 'CardPlayed' && typeof e.seat === 'number' && typeof e.cardId === 'string') {
            const m = playedBy[e.seat]!;
            m.set(e.cardId, (m.get(e.cardId) ?? 0) + 1);
          } else if (e.type === 'UnitDestroyed' && typeof e.cardId === 'string') {
            firstDead ??= e.cardId;
            destroyed.set(e.cardId, (destroyed.get(e.cardId) ?? 0) + 1);
          }
        }
      };
      see(events);
      let guard = 0;
      while (!state.result) {
        if (++guard > 20000) throw new Error('soft-lock: no result after 20000 commands');
        const seat = state.prompt!.seat as Seat;
        const legal = getLegalView(state, seat)!;
        const cmd = chooseCommand(levels[seat]!, viewFor(state, seat), legal, o.rules, rngs[seat]!);
        const r = applyCommand(state, seat, cmd);
        if (!r.ok) throw new Error(`AI command rejected: ${r.error}`);
        state = r.state;
        see(r.events);
        commands++;
      }
      const res = state.result;
      const isDraw = res.draw || !res.winners.length;
      if (isDraw) draws++;
      if (res.reason === 'turnLimit') turnLimit++;
      reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
      turns.push(state.turn.number);
      if (firstDead) firstDestroyed.set(firstDead, (firstDestroyed.get(firstDead) ?? 0) + 1);
      const fp = state.turn.firstPlayer;
      first.games++;
      if (isDraw) first.draws++;
      else if (res.winners.includes(fp)) first.wins++;
      const key = lineup.join(',');
      let mu = matchups.get(key);
      if (!mu) matchups.set(key, (mu = { decks: lineup.map((d) => o.decks[d]!.name), games: 0, wins: lineup.map(() => 0), draws: 0 }));
      mu.games++;
      if (isDraw) mu.draws++;
      lineup.forEach((d, seat) => {
        const won = !isDraw && res.winners.includes(seat);
        const ds = deckStats[d]!;
        ds.games++;
        if (isDraw) ds.draws++;
        if (won) {
          ds.wins++;
          mu!.wins[seat]!++;
        }
        if (seat === fp) {
          ds.f.games++;
          if (isDraw) ds.f.draws++;
          if (won) ds.f.wins++;
        }
        const deck = o.decks[d]!.deck;
        for (const id of new Set([...Object.keys(deck.battle), ...Object.keys(deck.resource)])) {
          const c = card(id).present;
          c.games++;
          if (isDraw) c.draws++;
          if (won) c.wins++;
        }
        for (const [id, count] of playedBy[seat]!) {
          const c = card(id);
          c.played.games++;
          c.copies += count;
          c.byDeck[d]!++;
          if (isDraw) c.played.draws++;
          if (won) c.played.wins++;
        }
      });
    } catch (e) {
      errors.push({ seed: gameSeed, error: (e as Error).message });
    }
    o.onProgress?.(g + 1, o.games);
  }

  const done = turns.length;
  const sorted = [...turns].sort((a, b) => a - b);
  const baseline = done ? (1 - draws / done) / n : 0;
  const nameOf = (id: string) => o.defs[id]?.name ?? id;
  const deckRate = deckStats.map((d) => (d.games ? d.wins / d.games : 0));
  // Rows with too few games to say anything sort after the rest.
  const minGames = Math.max(10, Math.round(done * 0.05));
  const cardRows: CardRow[] = [...cards.entries()].map(([id, c]) => {
    const played = rate(c.played);
    const expected = c.played.games ? c.byDeck.reduce((a, n, d) => a + n * deckRate[d]!, 0) / c.played.games : 0;
    return { id, name: nameOf(id), present: rate(c.present), played, expected, playedDelta: c.played.games ? played.winRate - expected : 0, avgCopiesPlayed: c.played.games ? c.copies / c.played.games : 0 };
  }).sort((a, b) => Number(b.played.games >= minGames) - Number(a.played.games >= minGames) || b.playedDelta - a.playedDelta);
  const fdTotal = [...firstDestroyed.values()].reduce((a, b) => a + b, 0);
  return {
    games: done,
    players: n,
    seed,
    ai: levels,
    balance: o.balanceName ?? 'cards.json',
    ms: now() - t0,
    draws,
    turnLimitGames: turnLimit,
    errors,
    baseline,
    decks: o.decks.map((d, i) => ({ name: d.name, ...rate(deckStats[i]!), asFirstPlayer: rate(deckStats[i]!.f) })),
    matchups: [...matchups.values()],
    firstPlayer: rate(first),
    length: {
      avgTurns: done ? turns.reduce((a, b) => a + b, 0) / done : 0,
      avgRounds: done ? turns.reduce((a, b) => a + b, 0) / done / n : 0,
      medianTurns: done ? sorted[Math.floor(done / 2)]! : 0,
      minTurns: sorted[0] ?? 0,
      maxTurns: sorted[done - 1] ?? 0,
      avgCommands: done ? commands / done : 0,
    },
    reasons,
    firstDestroyed: [...firstDestroyed.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, name: nameOf(id), count, share: fdTotal ? count / fdTotal : 0 })),
    destroyed: [...destroyed.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, name: nameOf(id), count, perGame: done ? count / done : 0 })),
    cards: cardRows,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, w: number, right = false) => (right ? s.padStart(w) : s.padEnd(w));

/** Plain-text report (the simulator's console output, also shown in the card editor). */
export function formatReport(r: SimReport, opts: { cards?: number } = {}): string {
  const L: string[] = [];
  L.push(`Psi Wars simulation — ${r.games} games, ${r.players} players, AI ${[...new Set(r.ai)].join('/')}, balance: ${r.balance}, seed "${r.seed}" (${(r.ms / 1000).toFixed(1)} s)`);
  if (r.errors.length) L.push(`!! ${r.errors.length} game(s) failed — first: ${r.errors[0]!.seed}: ${r.errors[0]!.error}`);
  L.push('');
  L.push('Win rate per deck');
  for (const d of r.decks) L.push(`  ${pad(d.name, 28)} ${pad(pct(d.winRate), 7, true)}  (${d.wins}/${d.games}, ${d.draws} draws; going first ${pct(d.asFirstPlayer.winRate)})`);
  if (r.matchups.length > 1) {
    L.push('Matchups (seat order)');
    for (const m of r.matchups) L.push(`  ${pad(m.decks.join(' vs '), 46)} ${m.wins.map((w) => pct(m.games ? w / m.games : 0)).join(' / ')}  (${m.games} games, ${m.draws} draws)`);
  }
  L.push(`First player wins ${pct(r.firstPlayer.winRate)} · draws ${pct(r.games ? r.draws / r.games : 0)} · turn-limit games ${r.turnLimitGames}`);
  L.push('');
  L.push(`Game length: ${r.length.avgTurns.toFixed(1)} turns on average (${r.length.avgRounds.toFixed(1)} rounds; median ${r.length.medianTurns}, range ${r.length.minTurns}–${r.length.maxTurns}), ${r.length.avgCommands.toFixed(0)} decisions`);
  L.push(`Endings: ${Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push('');
  L.push('Most common first destroyed unit');
  for (const f of r.firstDestroyed.slice(0, 5)) L.push(`  ${pad(f.name, 28)} ${pad(pct(f.share), 7, true)}  (${f.count} games)`);
  L.push('');
  L.push('Win rate per card');
  L.push(`  ${pad('Card', 28)} ${pad('in deck', 9, true)} ${pad('played', 9, true)} ${pad('vs deck', 8, true)} ${pad('games played', 13, true)}`);
  const rows = r.cards.filter((c) => c.played.games > 0);
  const never = r.cards.filter((c) => c.played.games === 0 && c.present.games > 0);
  for (const c of rows.slice(0, opts.cards ?? rows.length)) {
    const d = c.played.games ? `${c.playedDelta >= 0 ? '+' : ''}${(c.playedDelta * 100).toFixed(1)}` : '—';
    L.push(`  ${pad(c.name, 28)} ${pad(pct(c.present.winRate), 9, true)} ${pad(c.played.games ? pct(c.played.winRate) : '—', 9, true)} ${pad(d, 8, true)} ${pad(String(c.played.games), 13, true)}`);
  }
  if (never.length) L.push(`  Never played (Creation Units enter play without being "played"): ${never.map((c) => c.name).join(', ')}`);
  L.push('');
  L.push('"in deck": win rate of seats whose deck contains the card. "played": only games where that seat played it.');
  L.push('"vs deck": played win rate minus its deck\'s overall win rate, in points (positive = games where it is played go');
  L.push('better than the deck\'s average). Cheap cards are played in most games, so their numbers sit near zero; cards played in');
  L.push('few games are listed last. Correlation, not proof: a card played only when already winning also looks strong.');
  return L.join('\n');
}
