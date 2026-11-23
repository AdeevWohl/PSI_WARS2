/**
 * Exportable, replayable game logs (build prompt §13): the seed, the setup, every command in
 * order, every event, and the exact card data and rules the game ran under. Because the engine
 * is deterministic, re-applying the commands to a game created from the same setup reproduces
 * the same states and a byte-identical event stream; the replayer checks that as it goes.
 */
import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import type { BalanceFile } from './balance';
import { applyCommand } from './commands';
import { createGame, type DeckList, type GameSetup } from './setup';
import type { CardDef, GameState, RulesData } from './types';

export const LOG_FORMAT = 'psi-wars-log';
export const LOG_VERSION = 2;

export interface GameLog {
  format: typeof LOG_FORMAT;
  version: number;
  engineVersion: number;
  createdAt: string;
  seed: string;
  players: { name: string; deck: DeckList; kind?: string }[];
  startingHP: number;
  diceVariant: GameState['config']['diceVariant'];
  autoPassNoPlay: boolean;
  maxTurns: number;
  /** The balance overlay in force (null = cards.json as shipped). Informational; `defs` is authoritative. */
  balance: Pick<BalanceFile, 'name' | 'cards'> | null;
  /** Definitions of every card in the decks, exactly as played. */
  defs: Record<string, CardDef>;
  rules: RulesData;
  commands: { seat: Seat; cmd: Command }[];
  events: GameEvent[];
  result: GameState['result'];
  meta?: Record<string, unknown>;
}

/** Build a log from the setup that created a game, the commands applied and the events seen. */
export function makeLog(
  setup: GameSetup,
  commands: { seat: Seat; cmd: Command }[],
  events: GameEvent[],
  final: GameState,
  extra: { balance?: GameLog['balance']; kinds?: string[]; meta?: Record<string, unknown>; createdAt?: string } = {},
): GameLog {
  const used = new Set(setup.players.flatMap((p) => [...Object.keys(p.deck.battle), ...Object.keys(p.deck.resource)]));
  const defs: Record<string, CardDef> = {};
  for (const id of [...used].sort()) if (setup.defs[id]) defs[id] = setup.defs[id]!;
  return {
    format: LOG_FORMAT,
    version: LOG_VERSION,
    engineVersion: final.engineVersion,
    createdAt: extra.createdAt ?? '',
    seed: setup.seed,
    players: setup.players.map((p, i) => ({ name: p.name, deck: p.deck, ...(extra.kinds?.[i] ? { kind: extra.kinds[i] } : {}) })),
    startingHP: final.config.startingHP,
    diceVariant: final.config.diceVariant,
    autoPassNoPlay: final.config.autoPassNoPlay,
    maxTurns: final.config.maxTurns,
    balance: extra.balance ?? null,
    defs,
    rules: setup.rules,
    commands,
    events,
    result: final.result,
    ...(extra.meta ? { meta: extra.meta } : {}),
  };
}

/** Basic shape check for a log loaded from a file. */
export function checkLog(raw: unknown): { log: GameLog | null; error?: string } {
  if (!raw || typeof raw !== 'object') return { log: null, error: 'Not a game log (expected a JSON object).' };
  const l = raw as Partial<GameLog>;
  if (l.format !== LOG_FORMAT) return { log: null, error: 'Not a Psi Wars game log.' };
  if (!l.version || l.version < 2) return { log: null, error: 'This log was saved by an older version without its commands and card data, so it cannot be replayed. Its events can still be read as JSON.' };
  if (l.version > LOG_VERSION) return { log: null, error: `This log is from a newer version (log v${l.version}).` };
  if (typeof l.seed !== 'string' || !Array.isArray(l.players) || !Array.isArray(l.commands) || !l.defs || !l.rules) return { log: null, error: 'The log is missing its seed, players, commands or card data.' };
  return { log: l as GameLog };
}

export function setupFromLog(log: GameLog): GameSetup {
  return {
    defs: log.defs,
    rules: log.rules,
    seed: log.seed,
    players: log.players.map((p) => ({ name: p.name, deck: p.deck })),
    startingHP: log.startingHP,
    diceVariant: log.diceVariant,
    autoPassNoPlay: log.autoPassNoPlay,
    maxTurns: log.maxTurns,
  };
}

/**
 * Steps through a log. Position 0 is the game as created; position i is after command i.
 * States are rebuilt from checkpoints, so long games stay cheap to scrub through.
 */
export class Replayer {
  readonly log: GameLog;
  readonly length: number;
  /** Events produced by game creation (position 0) and by each command (positions 1..n). */
  readonly batches: GameEvent[][] = [];
  /** First command whose result differs from the log (events or legality), if any. */
  divergence: { index: number; reason: string } | null = null;
  private checkpoints = new Map<number, GameState>();
  private cache: { i: number; s: GameState } | null = null;
  private static EVERY = 25;

  constructor(log: GameLog) {
    this.log = log;
    const { state, events } = createGame(setupFromLog(log));
    this.checkpoints.set(0, state);
    this.batches.push(events);
    let s = state;
    let n = 0;
    for (const { seat, cmd } of log.commands) {
      const r = applyCommand(s, seat, cmd);
      if (!r.ok) {
        this.divergence = { index: n + 1, reason: `Command ${n + 1} was rejected: ${r.error}` };
        break;
      }
      s = r.state;
      n++;
      this.batches.push(r.events);
      if (n % Replayer.EVERY === 0) this.checkpoints.set(n, s);
    }
    this.length = n;
    this.cache = { i: n, s };
    if (!this.divergence && log.events?.length) {
      const replayed = JSON.stringify(this.batches.flat());
      if (replayed !== JSON.stringify(log.events)) {
        // Find the first command whose events differ, for a useful message.
        let off = 0;
        for (let i = 0; i < this.batches.length; i++) {
          const b = this.batches[i]!;
          if (JSON.stringify(b) !== JSON.stringify(log.events.slice(off, off + b.length))) {
            this.divergence = { index: i, reason: `Events differ from the log at ${i === 0 ? 'game setup' : `command ${i}`} (different engine or card data?).` };
            break;
          }
          off += b.length;
        }
        this.divergence ??= { index: this.length, reason: 'The log has events after the last command.' };
      }
    }
  }

  get final(): GameState {
    return this.stateAt(this.length);
  }

  /** The state at position i (0..length). */
  stateAt(i: number): GameState {
    i = Math.max(0, Math.min(this.length, i));
    if (this.cache?.i === i) return this.cache.s;
    let base = Math.floor(i / Replayer.EVERY) * Replayer.EVERY;
    while (!this.checkpoints.has(base)) base -= Replayer.EVERY;
    let start = base;
    let s = this.checkpoints.get(base)!;
    if (this.cache && this.cache.i < i && this.cache.i > base) {
      start = this.cache.i;
      s = this.cache.s;
    }
    for (let k = start; k < i; k++) {
      const { seat, cmd } = this.log.commands[k]!;
      const r = applyCommand(s, seat, cmd);
      if (!r.ok) throw new Error(`Replay failed at command ${k + 1}: ${r.error}`);
      s = r.state;
    }
    this.cache = { i, s };
    return s;
  }

  /** Positions where a new turn begins (for "jump to turn"). */
  turnStarts(): { turn: number; index: number }[] {
    const out: { turn: number; index: number }[] = [];
    this.batches.forEach((b, i) => {
      for (const e of b) if (e.type === 'TurnStarted') out.push({ turn: Number(e.turn ?? out.length + 1), index: i });
    });
    return out;
  }
}
