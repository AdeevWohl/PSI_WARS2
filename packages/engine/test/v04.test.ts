// v0.4 card set: payment solver, Power timing, Calibrate, Lock-On, Mutation, Cannibalize, feeding.
import { describe, expect, it } from 'vitest';
import { canAfford, enumeratePayments, getLegalActions, type Cost } from '../src/index';
import { defsV04, drive, scenario } from './helpers';

const sc4 = (o: Parameters<typeof scenario>[0]) => scenario({ ...o, defs: defsV04 });
const cost = (c: Partial<Cost>): Cost => ({ G: 0, B: 0, R: 0, P: 0, W: 0, ...c });

/** Seat 0 attacks with its first unit; seat 1 blocks with its first unit. */
const blocked = (sc: ReturnType<typeof scenario>) => {
  const d = drive(sc);
  const a = sc.ids[0]!.lab[0]!;
  d.do({ type: 'DeclareAttackers', attacks: [{ uid: a, target: 1 }] });
  d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: a }] });
  return d;
};

describe('v0.4 payment solver', () => {
  it('Mixed R/P 2 can be paid RR, RP or PP', () => {
    const s = sc4({ seats: [{ cus: { R: 2, P: 2 } }, {}] }).state;
    const ways = new Set(enumeratePayments(s, 0, cost({ choice: [['R', 'P'], ['R', 'P']] })).map((p) => [...p.choice!].sort().join('')));
    expect(ways).toEqual(new Set(['RR', 'PR', 'PP']));
  });

  it('burn pool and mixed depletion are independent; one CU never pays twice', () => {
    const c = cost({ W: 1, burnPool: ['R', 'P'], choice: [['B', 'G']] });
    expect(canAfford(sc4({ seats: [{ cus: { R: 1, B: 1 } }, {}] }).state, 0, c)).toBe(true);
    expect(canAfford(sc4({ seats: [{ cus: { R: 1, R: 1 } as any }, {}] }).state, 0, c)).toBe(false);
    expect(canAfford(sc4({ seats: [{ cus: { B: 2 } }, {}] }).state, 0, c)).toBe(false); // B cannot be burned
    // Burn R/P 1 + Mixed R/P 1 needs two different red/purple CUs.
    const both = cost({ W: 1, burnPool: ['R', 'P'], choice: [['R', 'P']] });
    expect(canAfford(sc4({ seats: [{ cus: { R: 1 } }, {}] }).state, 0, both)).toBe(false);
    expect(canAfford(sc4({ seats: [{ cus: { R: 1, P: 1 } }, {}] }).state, 0, both)).toBe(true);
  });

  it('Burn Any (Equipment Mechanic) may destroy a CU of any type', () => {
    const s = sc4({ seats: [{ cus: { B: 1 } }, {}] }).state;
    expect(canAfford(s, 0, defsV04.PW_EM!.cost!)).toBe(true);
  });
});

describe('v0.4 Power timing', () => {
  it('Operations are only playable in your own Creation phase; Pulses also respond', () => {
    const sc = sc4({ at: 'creation', seats: [{ hand: ['PW_EH'], cus: { G: 1 } }, {}] });
    const d = drive(sc);
    d.expectPrompt('main', 0);
    expect(getLegalActions(d.state, 0)!.plays.map((p) => p.cardId)).toContain('PW_EH');
    // In the opponent's attack: Grankor (Pulse) yes, Robo Refurb (Operation) no.
    const sc2 = sc4({ at: 'battle', autoPassNoPlay: true, seats: [{ lab: ['BU_BB'] }, { hand: ['TR_GSF', 'PW_RR'], cus: { G: 2, P: 2, R: 1 }, discard: ['BU_SD'] }] });
    const d2 = drive(sc2);
    d2.do({ type: 'DeclareAttackers', attacks: [{ uid: sc2.ids[0]!.lab[0]!, target: 1 }] });
    d2.expectPrompt('priority', 1);
    const ids = getLegalActions(d2.state, 1)!.plays.map((p) => p.cardId);
    expect(ids).toContain('TR_GSF');
    expect(ids).not.toContain('PW_RR');
  });
});

describe('v0.4 Calibrate and Lock-On', () => {
  it('Vector Sentinel may Calibrate its Physical die on defence: fixed +2, no die rolled', () => {
    // Rupture Brute 0/0/3 attacks Vector Sentinel 2/0/2. Dice: attacker Physical only.
    const sc = sc4({ at: 'battle', seats: [{ lab: ['BU_BB'] }, { lab: ['BU_VS'] }], dice: [3] });
    const d = blocked(sc);
    d.expectPrompt('decide', 1);
    expect(d.prompt!.options).toContain('yes');
    d.do({ type: 'ChooseFromList', choice: 'yes' });
    const rolled = d.last('DiceRolled');
    expect(rolled.def.physical).toBe(0);
    expect(d.ofType('Calibrated')).toHaveLength(1);
  });

  it('Lock-On: the defender pays G1 to choose the face of the attacker’s X roll', () => {
    // Shadow Assassin 0/X/2 attacks Therabot Seeker 2/0/1 (Lock-On G1).
    const sc = sc4({ at: 'battle', seats: [{ lab: ['BU_SA'] }, { lab: ['BU_TB'], cus: { G: 1 } }], dice: [1, 1] });
    const d = blocked(sc);
    d.expectPrompt('decide', 1);
    expect(d.prompt!.info!.lockOn).toBe(true);
    d.do({ type: 'ChooseFromList', choice: 'face:3' });
    const x = d.last('XRolled');
    expect(x).toMatchObject({ side: 3, value: 3, locked: true });
    expect(d.ofType('LockOn')).toHaveLength(1);
    expect(d.ofType('CUDepleted').some((e) => e.seat === 1 && e.forUid === sc.ids[1]!.lab[0])).toBe(true);
  });

  it('Lock-On is not offered without the cost, nor for unblocked attacks', () => {
    const sc = sc4({ at: 'battle', seats: [{ lab: ['BU_SA'] }, { lab: ['BU_TB'] }], dice: [2, 1, 1] });
    const d = blocked(sc);
    expect(d.ofType('LockOn')).toHaveLength(0);
    expect(d.last('XRolled')).toMatchObject({ side: 2 });
  });
});

describe('v0.4 Mutation and permanent strength', () => {
  it('Chitin Weaver mutates after surviving a blocked battle it lost on Psionic, and keeps it after Cleanup', () => {
    // Chitin 0/2/2 attacks Marrow Parasite 0/3/2; equal dice: Marrow wins Psionic, Physical ties.
    const sc = sc4({ at: 'battle', seats: [{ lab: ['BU_CW'] }, { lab: ['BU_LS'] }], dice: [1, 1, 1, 1] });
    const d = blocked(sc);
    const cw = sc.ids[0]!.lab[0]!;
    d.passUntil(['main']);
    expect(d.state.cards[cw]!.permMods).toMatchObject({ psionic: 1 });
    expect(d.state.cards[cw]!.modLog!.some((m) => m.kind === 'mutation')).toBe(true);
  });

  it('an unblocked attack does not mutate', () => {
    const sc = sc4({ at: 'battle', seats: [{ lab: ['BU_CW'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 1 }] });
    expect(d.ofType('StatModified').filter((e) => e.kind === 'mutation')).toHaveLength(0);
  });
});

describe('v0.4 Cannibalize', () => {
  it('Cannibalistic Instinct transfers permanent Physical (with permanent buffs, without temporary ones)', () => {
    const sc = sc4({ at: 'creation', seats: [{ lab: ['BU_BB', 'BU_PH'], hand: ['PW_CI'], cus: { R: 1 } }, {}] });
    const [brute, hatch] = sc.ids[0]!.lab as [string, string];
    sc.state.cards[hatch]!.permMods = { cyber: 0, psionic: 0, physical: 2 };
    sc.state.cards[hatch]!.tempMods = { cyber: 0, psionic: 0, physical: 5 };
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: brute });
    d.expectPrompt('chooseCard', 0);
    d.do({ type: 'ChooseFromList', choice: hatch });
    d.passUntil(['main']);
    expect(d.state.cards[hatch]!.zone).toBe('discard');
    expect(d.state.cards[brute]!.tempMods.physical).toBe(3); // printed 1 + permanent 2
    expect(d.ofType('Cannibalized')[0]).toMatchObject({ permanentPhysical: 3 });
  });
});

describe('v0.4 Carrion Foundress', () => {
  it('after destroying a unit in Physical combat it creates a Creature from hand of no greater total cost, free of depletion', () => {
    // Foundress 0/2/3 attacks Scout Drone 2/0/1 (cost 1); hand: Psi Hatchling (B1, total 1).
    const sc = sc4({ at: 'battle', seats: [{ lab: ['BU_CF'], hand: ['BU_PH'] }, { lab: ['BU_SD'] }], dice: [3, 1] });
    const d = blocked(sc);
    d.expectPrompt('chooseCard', 0);
    const hatch = sc.ids[0]!.hand[0]!;
    expect(d.prompt!.options).toContain(hatch);
    d.do({ type: 'ChooseFromList', choice: hatch });
    expect(d.state.cards[hatch]!.zone).toBe('lab');
    expect(d.ofType('FeedingTriggered')[0]).toMatchObject({ limit: 1 });
  });
});
