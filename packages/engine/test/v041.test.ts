// v0.4.1: Reactive/Creation timing, source-specific restrictions, Grankor / Interference Net, individual
// Creation Unit payments, atomic Equipment Mechanic, Lock-On user choice, Marrow choice, AI relocation.
import { describe, expect, it } from 'vitest';
import { applyCommand, chooseCommand, getLegalActions, getLegalView, seedRng, viewFor } from '../src/index';
import { defsV04, drive, rules, scenario } from './helpers';

const sc4 = (o: Parameters<typeof scenario>[0]) => scenario({ ...o, defs: defsV04 });
const plays = (d: ReturnType<typeof drive>, seat: number) => getLegalActions(d.state, seat)?.plays.map((p) => p.cardId) ?? [];

describe('timing names', () => {
  it('Powers are Reactive or Creation', () => {
    const t = new Set(Object.values(defsV04).filter((d) => d.cardType === 'Power').map((d) => d.timing));
    expect(t).toEqual(new Set(['Reactive', 'Creation']));
  });
});

describe('Grankor Stasis Field: restrictions instead of a trapped zone', () => {
  const contain = () => {
    // Seat 1 contains seat 0's equipped Hydra Bot during seat 0's Creation phase.
    const sc = sc4({ at: 'creation', autoPassNoPlay: true, seats: [{ lab: [{ id: 'BU_HB', equip: 'EQ_CO' }, 'BU_PH'], hand: ['PW_OS', 'PW_CI'], cus: { R: 3, P: 2 } }, { hand: ['TR_GSF'], cus: { G: 1 } }], dice: [] });
    const hb = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    // Seat 0 plays Overload Strike at the opponent's Lab, giving seat 1 a response window.
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: 'lab:1' });
    d.expectPrompt('priority', 1);
    d.do({ type: 'PlayCard', uid: sc.ids[1]!.hand[0]!, target: hb });
    d.passUntil(['main']);
    return { sc, d, hb };
  };

  it('the unit stays in its Lab but cannot attack, be chosen, be a cost, or use its passive', () => {
    const { d, hb } = contain();
    const c = d.state.cards[hb]!;
    expect(c.zone).toBe('lab');
    expect(c.restrictions?.[0]?.kinds).toEqual(['attack', 'defend', 'target', 'activate', 'passive', 'cost']);
    expect(viewFor(d.state, 0).unitStats[hb]!.cyber).toBe(3); // printed 2 + Equipment 1; Hydra Bot's own +1 is off
    d.passUntil(['declareAttackers']);
    expect(getLegalActions(d.state, 0)!.attack!.eligible).not.toContain(hb);
  });

  it('frees on Physical + roll >= 5 in its owner Cleanup, depleted; otherwise after the second failure', () => {
    const { d, hb } = contain();
    d.state.debugDice = [1, 1]; // Hydra Bot Physical 2: 2+1 < 5 twice
    d.passUntil(['declareAttackers']);
    d.do({ type: 'DeclareAttackers', attacks: [] });
    d.passUntil(['main']);
    expect(d.state.cards[hb]!.restrictions?.length).toBe(1);
    expect(d.last('EscapeAttempt')).toMatchObject({ freed: false, fails: 1 });
    d.passUntil(['declareAttackers']); // opponent's turn ...
    d.do({ type: 'DeclareAttackers', attacks: [] });
    d.passUntil(['declareAttackers']); // ... and ours again
    d.do({ type: 'DeclareAttackers', attacks: [] });
    d.passUntil(['main']);
    expect(d.ofType('RestrictionEnded').some((e) => e.uid === hb && e.reason === 'secondFailure')).toBe(true);
    expect(d.state.cards[hb]!.restrictions).toBeUndefined();
  });
});

describe('Interference Net and other single-purpose restrictions', () => {
  it('Interference Net only targets printed Physical <= 2 and releases at the owner next Cleanup, depleted', () => {
    const sc = sc4({ at: 'creation', autoPassNoPlay: true, seats: [{ lab: ['BU_SD', 'BU_BB'], hand: ['PW_EH'], cus: { G: 1 } }, { hand: ['PW_IN'], cus: { G: 1, P: 1 } }] });
    const [sd, bb] = sc.ids[0]!.lab as [string, string];
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.expectPrompt('priority', 1);
    const net = getLegalActions(d.state, 1)!.plays.find((p) => p.cardId === 'PW_IN')!;
    expect(net.targets).toContain(sd);
    expect(net.targets).not.toContain(bb); // Rupture Brute has printed Physical 3
    d.do({ type: 'PlayCard', uid: sc.ids[1]!.hand[0]!, target: sd });
    d.passUntil(['declareAttackers']);
    expect(getLegalActions(d.state, 0)!.attack!.eligible).not.toContain(sd);
    d.do({ type: 'DeclareAttackers', attacks: [] });
    d.passUntil(['main']); // our Cleanup released it
    expect(d.state.cards[sd]!.restrictions).toBeUndefined();
    expect(d.state.cards[sd]!.depleted).toBe(true);
  });

  it('Signal Jam stops activated abilities (Lock-On) but not passives', () => {
    const sc = sc4({ at: 'battle', autoPassNoPlay: true, seats: [{ lab: ['BU_SA'], hand: ['PW_SJ'], cus: { G: 1 } }, { lab: [{ id: 'BU_TB', equip: 'EQ_CO' }], cus: { G: 1 } }], dice: [2, 1, 1] });
    const tb = sc.ids[1]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: tb, attacker: sc.ids[0]!.lab[0]! }] });
    d.expectPrompt('priority', 0);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: tb });
    d.passUntil(['main', 'decide']);
    expect(d.ofType('LockOn')).toHaveLength(0);
    expect(d.state.cards[tb]?.zone === 'lab' ? viewFor(d.state, 1).unitStats[tb]!.cyber : 3).toBe(3);
  });
});

describe('individual Creation Unit payments', () => {
  it('pays with exactly the chosen units; an exact-but-wrong set is rejected', () => {
    const sc = sc4({ at: 'creation', seats: [{ hand: ['BU_HB'], cus: { G: 2, P: 2 } }, {}] });
    const [g1, g2, p1] = sc.state.players[0]!.cus as [string, string, string, string];
    const d = drive(sc);
    const hb = sc.ids[0]!.hand[0]!;
    const bad = d.tryDo({ type: 'PlayCard', uid: hb, payment: { destroy: {}, pick: { deplete: [g1, g2], burn: [] } } });
    expect(bad.ok).toBe(false);
    d.do({ type: 'PlayCard', uid: hb, payment: { destroy: {}, pick: { deplete: [g2, p1], burn: [] } } });
    expect(d.state.cards[g2]!.depleted).toBe(true);
    expect(d.state.cards[g1]!.depleted).toBe(false);
  });

  it('a player may burn an unfortified unit and keep their Resource Fortification', () => {
    const sc = sc4({ at: 'creation', seats: [{ hand: ['PW_RR', 'RS_RF'], cus: { G: 2, P: 2 }, discard: ['BU_SD'] }, {}] });
    const s = sc.state;
    const [, g2, p1, p2] = s.players[0]!.cus as [string, string, string, string];
    const rf = sc.ids[0]!.hand[1]!;
    // Attach the Fortification to the first Purple CU by hand.
    s.players[0]!.hand = s.players[0]!.hand.filter((u) => u !== rf);
    s.cards[rf]!.zone = 'attached';
    s.cards[rf]!.attachedTo = p1;
    s.cards[p1]!.equipment = rf;
    const d = drive(sc);
    // Robo Refurb: G1 P1 + burn 1 (G/P). Deplete G + P, burn the unfortified P.
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, payment: { destroy: { P: 1 }, pick: { deplete: [g2, p1], burn: [p2] } } });
    expect(d.state.cards[p2]!.zone).toBe('discard');
    expect(d.state.cards[rf]!.zone).toBe('attached');
  });
});

describe('Equipment Mechanic pays atomically', () => {
  it('chooses the Equipment and host first, then pays base + Equipment cost together', () => {
    const sc = sc4({ at: 'creation', seats: [{ lab: ['BU_BB'], hand: ['PW_EM'], cus: { R: 1, P: 1, B: 1 }, discard: ['EQ_PA'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    expect(d.ofType('CUDepleted')).toHaveLength(0); // nothing paid yet
    d.expectPrompt('chooseCard', 0);
    d.do({ type: 'ChooseFromList', choice: sc.ids[0]!.discard[0]! });
    d.do({ type: 'ChooseFromList', choice: sc.ids[0]!.lab[0]! });
    d.passUntil(['main']);
    // Burn 1 (any) + Physical Augmentation's R/P + R/P: all three CUs used.
    expect(d.state.players[0]!.cus.filter((u) => !d.state.cards[u]!.depleted)).toHaveLength(0);
    expect(d.state.cards[sc.ids[0]!.lab[0]!]!.equipment).toBe(sc.ids[0]!.discard[0]);
  });

  it('is not playable when no Equipment is affordable together with the base cost', () => {
    const sc = sc4({ at: 'creation', seats: [{ lab: ['BU_BB'], hand: ['PW_EM'], cus: { R: 2 }, discard: ['EQ_PA'] }, {}] });
    expect(plays(drive(sc), 0)).not.toContain('PW_EM');
  });
});

describe('Lock-On: choose which unit locks', () => {
  it('with two eligible Lock-On units in one engagement their controller picks one', () => {
    // No current Cyborg has Lock-On, so give Patchwork Initiate one for this test (a Stack is the only
    // way two Lock-On units can share an engagement).
    const defs = { ...defsV04, BU_PI2: { ...defsV04.BU_PI2!, effects: [{ trigger: 'Static', effect: 'LockOn', params: { cost: { G: 1 } } }] } };
    const sc = scenario({ defs, at: 'battle', seats: [{ lab: ['BU_SA'] }, { lab: ['BU_PI2', 'BU_TB'], cus: { G: 2 } }], dice: [1, 1, 1, 1] });
    const d = drive(sc);
    const att = sc.ids[0]!.lab[0]!;
    const [pi, tb] = sc.ids[1]!.lab as [string, string];
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: att, target: 1 }] });
    d.expectPrompt('declareBlockers', 1);
    d.do({ type: 'Stack', a: pi, b: tb });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: pi, attacker: att }] });
    d.expectPrompt('decide', 1);
    expect(new Set(d.prompt!.options)).toEqual(new Set([pi, tb, null]));
    d.do({ type: 'ChooseFromList', choice: tb });
    d.expectPrompt('decide', 1);
    expect(d.prompt!.info!.locker).toBe(tb);
    d.do({ type: 'ChooseFromList', choice: 'face:2' });
    expect(d.last('LockOn')).toMatchObject({ uid: tb, side: 2 });
  });
});

describe('AI relocates Equipment from a unit that cannot fight', () => {
  it('moves free Equipment from a depleted unit to a ready one', () => {
    const sc = sc4({ at: 'creation', seats: [{ lab: [{ id: 'BU_SD', equip: 'EQ_CO', depleted: true }, 'BU_HB'] }, { lab: ['BU_PH'] }] });
    const cmd = chooseCommand('normal', viewFor(sc.state, 0), getLegalView(sc.state, 0)!, rules, seedRng('ai'));
    expect(cmd).toMatchObject({ type: 'MoveEquipment', to: sc.ids[0]!.lab[1] });
    expect(applyCommand(sc.state, 0, cmd).ok).toBe(true);
  });
});

describe('Marrow Parasite: choosing the destroyed Stack member', () => {
  it('asks which member to compare with when the rewards differ', () => {
    // Stack Patchwork Initiate (1/1/1) + Rupture Brute (0/0/3) attacks Marrow Parasite (0/3/2).
    // Dice: att Psionic 2, att Physical 1, def Psionic 2, def Physical 5 -> Marrow wins both, Stack destroyed.
    const sc = sc4({ at: 'battle', seats: [{ lab: ['BU_PI2', 'BU_BB'] }, { lab: ['BU_LS'] }], dice: [2, 1, 2, 5] });
    const [pi, bb] = sc.ids[0]!.lab as [string, string];
    const ls = sc.ids[1]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'Stack', a: pi, b: bb });
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: pi, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: ls, attacker: pi }] });
    d.passUntil(['decide']);
    expect(d.prompt!.seat).toBe(1);
    expect(new Set(d.prompt!.options)).toEqual(new Set([pi, bb]));
    d.do({ type: 'ChooseFromList', choice: bb }); // Rupture Brute's Physical 3 >= 2: +1 permanent Physical
    expect(d.state.cards[ls]!.permMods).toMatchObject({ physical: 1 });
  });
});
