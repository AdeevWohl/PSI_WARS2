import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { Command, GameEvent } from '@psi-wars/shared';
import {
  advance,
  applyCommand,
  buildDefs,
  createGame,
  type CardInstance,
  type DeckList,
  type GameState,
  type RulesData,
  type Seat,
} from '../src/index';

const ROOT = resolve(__dirname, '..', '..', '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

export const cardsJson = read('data/cards.json');
export const rules: RulesData = read('data/rules.json');
export const defs = buildDefs(cardsJson);
export const creatureDeck: DeckList = read('data/decks/creature-commander.json');
export const robotDeck: DeckList = read('data/decks/robot-commander.json');

export function newGame(seed = 'test', opts: { players?: number; autoPassNoPlay?: boolean; maxTurns?: number; startingHP?: number } = {}) {
  const n = opts.players ?? 2;
  const decks = [creatureDeck, robotDeck, creatureDeck, robotDeck];
  return createGame({
    defs,
    rules,
    seed,
    players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, deck: decks[i]! })),
    autoPassNoPlay: opts.autoPassNoPlay ?? false,
    maxTurns: opts.maxTurns ?? 0,
    startingHP: opts.startingHP,
  });
}

// ---------- scenario builder ----------

export type UnitSpec = string | { id: string; equip?: string; depleted?: boolean; trappedBy?: { id: string; owner: Seat } };

export interface SeatSpec {
  lab?: UnitSpec[];
  cus?: Partial<Record<'G' | 'B' | 'R' | 'P', number>>;
  depletedCus?: Partial<Record<'G' | 'B' | 'R' | 'P', number>>;
  hand?: string[];
  battleDeck?: string[];
  resourceDeck?: string[];
  discard?: string[];
  hp?: number;
}

const CU_ID = { G: 'CU_DS', B: 'CU_NG', R: 'CU_BA', P: 'CU_MA' } as const;

export interface Scenario {
  state: GameState;
  events: GameEvent[];
  /** uids by seat and zone, in spec order */
  ids: { lab: string[]; hand: string[]; equip: Record<string, string>; battleDeck: string[]; discard: string[]; trapped: string[]; traps: string[] }[];
}

/**
 * Build a game positioned at the start of a phase of `active`'s turn, with exactly
 * the given cards. Every seat gets a reserve Battle Unit deep in its deck unless
 * `battleDeck` is given, so nobody loses to "no Battle Units" by accident.
 */
export function scenario(opts: {
  seats: SeatSpec[];
  active?: Seat;
  at?: 'replenish' | 'draw' | 'creation' | 'battle' | 'cleanup';
  dice?: number[];
  autoPassNoPlay?: boolean;
  turnNumber?: number;
}): Scenario {
  const base = createGame({
    defs,
    rules,
    seed: 'scenario',
    players: opts.seats.map((_, i) => ({ name: `P${i}`, deck: { battle: { BU_LS: 1 }, resource: { CU_NG: 1 } } })),
    autoPassNoPlay: opts.autoPassNoPlay ?? true,
  }).state;
  const s: GameState = { ...base, cards: {}, nextUid: 1, tasks: [], prompt: null, stack: [], battle: null, turnEffects: [], result: null };
  s.players = opts.seats.map((spec, seat) => ({
    seat, name: `P${seat}`, labHP: spec.hp ?? 15, eliminated: false,
    battleDeck: [], resourceDeck: [], hand: [], lab: [], cus: [], trapped: [], discard: [],
  }));
  const mk = (cardId: string, owner: Seat, zone: CardInstance['zone']): CardInstance => {
    if (!defs[cardId]) throw new Error(`unknown card ${cardId}`);
    const uid = `c${s.nextUid++}`;
    const c: CardInstance = {
      uid, cardId, owner, zone, depleted: false, enteredThisTurn: false, equipment: null, attachedTo: null,
      stackPartner: null, xValue: null, tempMods: { cyber: 0, psionic: 0, physical: 0 }, disoriented: false, trappedBy: null,
    };
    s.cards[uid] = c;
    return c;
  };
  const ids: Scenario['ids'] = [];
  opts.seats.forEach((spec, seat) => {
    const p = s.players[seat]!;
    const rec = { lab: [] as string[], hand: [] as string[], equip: {} as Record<string, string>, battleDeck: [] as string[], discard: [] as string[], trapped: [] as string[], traps: [] as string[] };
    for (const u of spec.lab ?? []) {
      const us = typeof u === 'string' ? { id: u } : u;
      if (us.trappedBy) {
        const c = mk(us.id, seat, 'trapped');
        p.trapped.push(c.uid);
        rec.trapped.push(c.uid);
        const t = mk(us.trappedBy.id, us.trappedBy.owner, 'attached');
        t.attachedTo = c.uid;
        c.trappedBy = t.uid;
        rec.traps.push(t.uid);
        rec.lab.push(c.uid);
        if (us.equip) {
          const e = mk(us.equip, seat, 'attached');
          e.attachedTo = c.uid;
          c.equipment = e.uid;
          rec.equip[c.uid] = e.uid;
        }
        continue;
      }
      const c = mk(us.id, seat, 'lab');
      c.depleted = !!us.depleted;
      p.lab.push(c.uid);
      rec.lab.push(c.uid);
      if (us.equip) {
        const e = mk(us.equip, seat, 'attached');
        e.attachedTo = c.uid;
        c.equipment = e.uid;
        rec.equip[c.uid] = e.uid;
      }
    }
    for (const [t, n] of Object.entries(spec.cus ?? {})) for (let i = 0; i < n!; i++) p.cus.push(mk(CU_ID[t as 'G'], seat, 'cus').uid);
    for (const [t, n] of Object.entries(spec.depletedCus ?? {})) for (let i = 0; i < n!; i++) {
      const c = mk(CU_ID[t as 'G'], seat, 'cus');
      c.depleted = true;
      p.cus.push(c.uid);
    }
    for (const id of spec.hand ?? []) {
      const c = mk(id, seat, 'hand');
      p.hand.push(c.uid);
      rec.hand.push(c.uid);
    }
    for (const id of spec.battleDeck ?? ['BU_TS']) {
      const c = mk(id, seat, 'battleDeck');
      p.battleDeck.push(c.uid);
      rec.battleDeck.push(c.uid);
    }
    for (const id of spec.resourceDeck ?? []) p.resourceDeck.push(mk(id, seat, 'resourceDeck').uid);
    for (const id of spec.discard ?? []) {
      const c = mk(id, seat, 'discard');
      p.discard.push(c.uid);
      rec.discard.push(c.uid);
    }
    ids.push(rec);
  });
  const active = opts.active ?? 0;
  s.turn = { number: opts.turnNumber ?? 3, active, firstPlayer: 0 };
  s.debugDice = [...(opts.dice ?? [])];
  const seq: Record<string, string[]> = {
    replenish: ['replenish', 'draw', 'creation', 'battle', 'cleanup', 'endTurn'],
    draw: ['draw', 'creation', 'battle', 'cleanup', 'endTurn'],
    creation: ['creation', 'battle', 'cleanup', 'endTurn'],
    battle: ['battle', 'cleanup', 'endTurn'],
    cleanup: ['cleanup', 'endTurn'],
  };
  const order = seq[opts.at ?? 'creation']!;
  s.tasks = [...order].reverse().map((k) => ({ k }));
  s.phase = 'replenish';
  const r = advance(s);
  return { state: r.state, events: r.events, ids };
}

// ---------- driving ----------

export class Driver {
  events: GameEvent[] = [];
  constructor(public state: GameState, initial: GameEvent[] = []) {
    this.events.push(...initial);
  }
  get prompt() {
    return this.state.prompt;
  }
  /** Apply a command for whoever holds the prompt (or a given seat); fail the test on rejection. */
  do(cmd: Command, seat?: Seat): GameEvent[] {
    const who = seat ?? this.state.prompt?.seat;
    if (who === undefined) throw new Error('no prompt to answer');
    const r = applyCommand(this.state, who, cmd);
    if (!r.ok) throw new Error(`command rejected (${r.error}): ${JSON.stringify(cmd)} for seat ${who}, prompt ${this.state.prompt?.kind}`);
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }
  tryDo(cmd: Command, seat?: Seat) {
    return applyCommand(this.state, seat ?? this.state.prompt!.seat, cmd);
  }
  expectPrompt(kind: string, seat?: Seat) {
    expect(this.state.prompt?.kind, `prompt (events: ${this.events.slice(-5).map((e) => e.type).join(',')})`).toBe(kind);
    if (seat !== undefined) expect(this.state.prompt?.seat).toBe(seat);
  }
  /** Answer prompts with Pass / default until one of `kinds` is pending. */
  passUntil(kinds: string[], max = 50) {
    for (let i = 0; i < max && this.state.prompt && !kinds.includes(this.state.prompt.kind); i++) {
      const k = this.state.prompt.kind;
      if (k === 'priority') this.do({ type: 'Pass' });
      else if (k === 'main') this.do({ type: 'AdvancePhase' });
      else if (k === 'declareAttackers') this.do({ type: 'DeclareAttackers', attacks: [] });
      else if (k === 'declareBlockers') this.do({ type: 'AssignBlockers', blocks: [] });
      else if (k === 'optionalRoll') this.do({ type: 'UseAbility', use: false });
      else if (k === 'reroll') this.do({ type: 'ChooseReroll', reroll: false });
      else throw new Error(`passUntil: unexpected prompt ${k}`);
    }
  }
  ofType(type: string) {
    return this.events.filter((e) => e.type === type);
  }
  last(type: string) {
    const xs = this.ofType(type);
    return xs[xs.length - 1] as any;
  }
}

export function drive(sc: Scenario | { state: GameState; events: GameEvent[] }) {
  return new Driver(sc.state, sc.events);
}
