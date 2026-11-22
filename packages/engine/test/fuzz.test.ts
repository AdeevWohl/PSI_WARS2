/**
 * Determinism, full-game integration and fuzz tests.
 * FUZZ_GAMES=5000 npx vitest run packages/engine/test/fuzz.test.ts  for the long run.
 */
import { describe, expect, it } from 'vitest';
import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import { applyCommand, defaultCommandFor, filterEvents, randomLegalCommand, seedRng, type GameState } from '../src/index';
import { checkInvariants, checkViews } from './invariants';
import { newGame } from './helpers';

const FUZZ = Number(process.env.FUZZ_GAMES ?? 200);

function playRandom(seed: string, opts: { players?: number; checkEvery?: number; maxTurns?: number; autoPass?: boolean } = {}) {
  const g = newGame(seed, { players: opts.players, maxTurns: opts.maxTurns ?? 120, autoPassNoPlay: opts.autoPass });
  let state: GameState = g.state;
  const events: GameEvent[] = [...g.events];
  const commands: { seat: Seat; cmd: Command }[] = [];
  const r = seedRng(`choices:${seed}`);
  let n = 0;
  while (!state.result) {
    if (++n > 50_000) throw new Error(`game ${seed} did not finish`);
    const pick = randomLegalCommand(state, r);
    if (!pick) throw new Error(`no legal command at prompt ${state.prompt?.kind} (seed ${seed})`);
    const res = applyCommand(state, pick.seat, pick.cmd);
    if (!res.ok) throw new Error(`legal command rejected: ${res.error} ${JSON.stringify(pick.cmd)} (seed ${seed})`);
    commands.push(pick);
    events.push(...res.events);
    state = res.state;
    if (opts.checkEvery && n % opts.checkEvery === 0) {
      const errs = [...checkInvariants(state), ...checkViews(state)];
      if (errs.length) throw new Error(`seed ${seed} step ${n}: ${errs.slice(0, 5).join('; ')}`);
    }
  }
  return { state, events, commands };
}

describe('determinism', () => {
  it('same seed + same commands -> byte-identical event stream and state', () => {
    const a = playRandom('det-1');
    const g = newGame('det-1', { maxTurns: 120 });
    let state = g.state;
    const events: GameEvent[] = [...g.events];
    for (const { seat, cmd } of a.commands) {
      const res = applyCommand(state, seat, cmd);
      if (!res.ok) throw new Error(res.error);
      events.push(...res.events);
      state = res.state;
    }
    expect(JSON.stringify(events)).toBe(JSON.stringify(a.events));
    const strip = (s: GameState) => JSON.stringify({ ...s, defs: null, rules: null });
    expect(strip(state)).toBe(strip(a.state));
  });

  it('a JSON round-trip of the state mid-game resumes identically (snapshot/hibernation)', () => {
    const a = playRandom('det-2');
    const half = Math.floor(a.commands.length / 2);
    const g = newGame('det-2', { maxTurns: 120 });
    let s1 = g.state;
    for (const { seat, cmd } of a.commands.slice(0, half)) s1 = (applyCommand(s1, seat, cmd) as any).state;
    let s2: GameState = JSON.parse(JSON.stringify(s1));
    const e1: GameEvent[] = [];
    const e2: GameEvent[] = [];
    for (const { seat, cmd } of a.commands.slice(half)) {
      const r1 = applyCommand(s1, seat, cmd) as any;
      const r2 = applyCommand(s2, seat, cmd) as any;
      s1 = r1.state; s2 = r2.state;
      e1.push(...r1.events); e2.push(...r2.events);
    }
    expect(JSON.stringify(e2)).toBe(JSON.stringify(e1));
  });

  it('different seeds give different games', () => {
    expect(JSON.stringify(playRandom('det-3').events)).not.toBe(JSON.stringify(playRandom('det-4').events));
  });

  it('the input state is never mutated', () => {
    const g = newGame('pure');
    const before = JSON.stringify(g.state);
    const pick = randomLegalCommand(g.state, seedRng('x'))!;
    applyCommand(g.state, pick.seat, pick.cmd);
    expect(JSON.stringify(g.state)).toBe(before);
  });
});

describe('integration: full games end to end', () => {
  for (const players of [2, 3, 4]) {
    it(`${players}-player random games finish with invariants and hidden information intact`, () => {
      for (let i = 0; i < 6; i++) {
        const { state } = playRandom(`int-${players}-${i}`, { players, checkEvery: 1 });
        expect(state.result).not.toBeNull();
      }
    });
  }

  it('playing only default answers always finishes (every prompt has a valid default)', () => {
    let { state } = newGame('defaults', { maxTurns: 200 });
    let n = 0;
    while (!state.result && n++ < 20000) {
      const res = applyCommand(state, state.prompt!.seat, defaultCommandFor(state.prompt!));
      if (!res.ok) throw new Error(res.error);
      state = res.state;
    }
    expect(state.result).not.toBeNull();
  });

  it('per-seat event filtering redacts private draws', () => {
    const { events } = newGame('filter');
    const draws0 = filterEvents(events, 0).filter((e) => e.type === 'CardDrawn' && e.seat === 1);
    expect(draws0.length).toBe(5);
    for (const e of draws0) {
      expect(e.cardId).toBeUndefined();
      expect(e.uid).toBeUndefined();
    }
    const own = filterEvents(events, 1).filter((e) => e.type === 'CardDrawn' && e.seat === 1);
    expect(own.every((e) => typeof e.cardId === 'string')).toBe(true);
    expect(filterEvents(events, 1).some((e) => 'to' in e || 'redacted' in e)).toBe(false);
  });
});

describe('fuzz', () => {
  it(`${FUZZ} random games never throw and never soft-lock`, () => {
    const tally = { games: 0, draws: 0, turns: 0 };
    for (let i = 0; i < FUZZ; i++) {
      const players = 2 + (i % 3);
      const { state } = playRandom(`fuzz-${i}`, { players, checkEvery: i < 30 ? 1 : 25, autoPass: i % 2 === 0 });
      tally.games++;
      tally.turns += state.turn.number;
      if (state.result!.draw) tally.draws++;
    }
    expect(tally.games).toBe(FUZZ);
  }, 600_000);
});
