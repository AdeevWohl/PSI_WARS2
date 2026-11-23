import { describe, expect, it } from 'vitest';
import type { Command } from '@psi-wars/shared';
import { applyCommand, buildDefs, chooseCommand, cleanBalance, createGame, diffCard, getLegalView, makeLog, Replayer, runSimulation, seedRng, viewFor, type GameLog, type Seat } from '../src/index';
import { cardsJson, creatureDeck, rules, robotDeck } from './helpers';

describe('balance overlays', () => {
  it('apply only balance fields, and report everything else', () => {
    const { balance, errors } = cleanBalance(cardsJson, {
      name: 'Test',
      cards: {
        BU_HB: { stats: { cyber: 3, psionic: 0, physical: 4 }, name: 'Nope', cardType: 'Power' },
        BU_DC: { cost: { G: 2, B: 0, R: 0, P: 2, W: 1 } },
        BU_DSH: { effects: [{ trigger: 'ModifyRoll', effect: 'ModifyRollTable', params: { die: 'green', stat: 'physical', optional: false, bySide: { '1': -2, '2': 2, '3': -1, '4': 1, '5': -1, '6': 1 } } }] },
        BU_LQ: { cost: { G: 99 } },
        NOPE: { text: 'x' },
      },
    });
    expect(balance.cards.BU_HB).toEqual({ stats: { cyber: 3, psionic: 0, physical: 4 } });
    expect(balance.cards.BU_DC!.cost!.W).toBe(1);
    expect(balance.cards.BU_DSH!.effects![0]!.params).toMatchObject({ die: 'green', optional: false, bySide: { '1': -2, '2': 2 } });
    expect(balance.cards.BU_LQ).toBeUndefined();
    const all = errors.join('\n');
    expect(all).toMatch(/"name" cannot be changed/);
    expect(all).toMatch(/"cardType" cannot be changed/);
    expect(all).toMatch(/cost G must be/);
    expect(all).toMatch(/Unknown card "NOPE"/);
    const defs = buildDefs(cardsJson, balance);
    expect(defs.BU_HB!.stats!.physical).toBe(4);
    expect(defs.BU_HB!.name).toBe('Hydra Bot');
  });

  it('refuses to change which abilities a card has', () => {
    const { balance, errors } = cleanBalance(cardsJson, { name: 't', cards: { BU_DSH: { effects: [] }, BU_SA: { effects: [{ trigger: 'RollX', effect: 'DealDamage', params: {} }] } } });
    expect(Object.keys(balance.cards)).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it('diffCard + cleanBalance round-trip an edited card table', () => {
    const base = buildDefs(cardsJson);
    const edited = structuredClone(base);
    edited.BU_HB!.stats!.physical = 5;
    edited.EQ_PA!.text = 'New text';
    edited.BU_LS!.enabled = false;
    const cards = Object.fromEntries(Object.keys(base).map((id) => [id, diffCard(base[id]!, edited[id]!)] as const).filter(([, o]) => Object.keys(o).length));
    const { balance, errors } = cleanBalance(cardsJson, { name: 'rt', cards });
    expect(errors).toEqual([]);
    expect(buildDefs(cardsJson, balance)).toEqual(edited);
  });
});

function playGame(seed: string) {
  const defs = buildDefs(cardsJson);
  const setup = { defs, rules, seed, players: [{ name: 'A', deck: creatureDeck }, { name: 'B', deck: robotDeck }], autoPassNoPlay: true, maxTurns: 150 };
  let { state, events } = createGame(setup);
  const all = [...events];
  const commands: { seat: Seat; cmd: Command }[] = [];
  const rng = seedRng(seed + 'ai');
  while (!state.result) {
    const seat = state.prompt!.seat;
    const cmd = chooseCommand('normal', viewFor(state, seat), getLegalView(state, seat)!, rules, rng);
    const r = applyCommand(state, seat, cmd);
    if (!r.ok) throw new Error(r.error);
    state = r.state;
    commands.push({ seat, cmd });
    all.push(...r.events);
  }
  return { log: makeLog(setup, commands, all, state, { createdAt: 'test' }), state };
}

describe('replayable logs', () => {
  it('a log survives JSON and replays to identical states and events', () => {
    const { log, state } = playGame('replay-1');
    const parsed: GameLog = JSON.parse(JSON.stringify(log));
    const rp = new Replayer(parsed);
    expect(rp.divergence).toBeNull();
    expect(rp.length).toBe(log.commands.length);
    const strip = (s: object) => JSON.stringify({ ...s, defs: undefined, rules: undefined });
    expect(strip(rp.final)).toBe(strip(state));
    // Random access goes through checkpoints and agrees with a straight replay.
    const mid = Math.floor(rp.length / 2);
    const a = JSON.stringify(rp.stateAt(mid));
    rp.stateAt(3);
    expect(JSON.stringify(rp.stateAt(mid))).toBe(a);
    expect(rp.turnStarts().length).toBeGreaterThan(2);
    const ids = new Set([creatureDeck, robotDeck].flatMap((d) => [...Object.keys(d.battle), ...Object.keys(d.resource)]));
    expect(Object.keys(parsed.defs).sort()).toEqual([...ids].sort());
  });

  it('flags a tampered log', () => {
    const { log } = playGame('replay-2');
    const bad: GameLog = JSON.parse(JSON.stringify(log));
    bad.seed = 'other';
    expect(new Replayer(bad).divergence).not.toBeNull();
  });
});

describe('simulator', () => {
  const decks = [{ name: 'Creature', deck: creatureDeck }, { name: 'Robot', deck: robotDeck }];

  it('reports deck and card win rates, length and first destroyed unit; deterministic per seed', () => {
    const defs = buildDefs(cardsJson);
    const r1 = runSimulation({ defs, rules, decks, games: 12, ai: 'easy', seed: 't' });
    const r2 = runSimulation({ defs, rules, decks, games: 12, ai: 'easy', seed: 't' });
    expect(r1).toEqual(r2);
    expect(r1.games).toBe(12);
    expect(r1.errors).toEqual([]);
    expect(r1.decks.reduce((a, d) => a + d.games, 0)).toBe(24);
    expect(r1.decks.reduce((a, d) => a + d.wins, 0) + r1.draws).toBe(12);
    expect(r1.matchups).toHaveLength(2); // seats alternate
    expect(r1.length.avgTurns).toBeGreaterThan(2);
    expect(r1.firstDestroyed.length).toBeGreaterThan(0);
    expect(r1.cards.find((c) => c.id === 'BU_HB')!.present.games).toBe(12);
  });

  it('runs under a balance overlay, and the change is measurable', () => {
    const zero = { stats: { cyber: 0, psionic: 0, physical: 0 } };
    const weak = cleanBalance(cardsJson, { name: 'weak robots', cards: { BU_HB: zero, BU_LQ: zero, BU_BM: zero } }).balance;
    const base = runSimulation({ defs: buildDefs(cardsJson), rules, decks, games: 20, ai: 'easy', seed: 'm' });
    const nerfed = runSimulation({ defs: buildDefs(cardsJson, weak), rules, decks, games: 20, ai: 'easy', seed: 'm', balanceName: weak.name });
    expect(nerfed.balance).toBe('weak robots');
    expect(nerfed.decks[1]!.winRate).toBeLessThanOrEqual(base.decks[1]!.winRate);
  });
});
