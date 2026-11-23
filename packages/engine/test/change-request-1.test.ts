// Change Request 1: new disorientation rules, combat damage, damage effects, new costs and new cards.
import { describe, expect, it } from 'vitest';
import { canAfford, getLegalActions, viewFor } from '../src/index';
import { drive, scenario } from './helpers';

const blockedBattle = (sc: ReturnType<typeof scenario>) => {
  const d = drive(sc);
  const a = sc.ids[0]!.lab[0]!;
  d.do({ type: 'DeclareAttackers', attacks: [{ uid: a, target: 1 }] });
  d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: a }] });
  return d;
};

describe('B1: losing the Psionic battle disorients', () => {
  // Jingwa 0/3/1 vs Trangarey 0/1/3, equal dice: Jingwa wins Psionic, Trangarey wins Physical.
  it('the Psionic loser is Disoriented, so it cannot destroy; the other deals its Physical as damage (B3)', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_JPA'] }, { lab: ['BU_TS'] }], dice: [2, 2, 2, 2] });
    const d = blockedBattle(sc);
    const [j, ts] = [sc.ids[0]!.lab[0]!, sc.ids[1]!.lab[0]!];
    expect(d.ofType('Disoriented').some((e) => e.side === 'def' && e.ability === 'psionic')).toBe(true);
    expect(d.ofType('PsionicWin')[0]).toMatchObject({ side: 'att' });
    // Trangarey has the higher Physical total but is Disoriented: nothing destroyed, Jingwa deals 1 damage.
    expect(d.ofType('UnitDestroyed')).toHaveLength(0);
    expect(d.last('UnitDamaged')).toMatchObject({ uid: ts, amount: 1, physicalBefore: 3, physicalAfter: 2, cause: 'combat' });
    expect(d.state.cards[j]!.zone).toBe('lab');
  });
});

describe('B2: zero-strength rule', () => {
  it('a Robot with 0 Cyber against Cyber >= 1 is instantly Disoriented (no Cyber dice)', () => {
    // Scrap Hulk 0/0/3 attacks, Scout Drone 2/0/1 blocks.
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_SH'] }, { lab: ['BU_SD'] }], dice: [3, 3] });
    const d = blockedBattle(sc);
    const dis = d.ofType('Disoriented');
    expect(dis).toHaveLength(1);
    expect(dis[0]).toMatchObject({ side: 'att', ability: 'cyber', auto: true });
    expect(d.ofType('DiceRolled')[0]!.att.cyber).toBeNull();
    // Scrap Hulk wins Physical (3+die vs 1+die) but is Disoriented: Scout Drone deals 1 damage.
    expect(d.last('UnitDamaged')).toMatchObject({ uid: sc.ids[0]!.lab[0], amount: 1, physicalAfter: 2 });
  });

  it('a Creature with 0 Psionic against Psionic >= 1 is instantly Disoriented, and the opponent wins Psionic', () => {
    // Bio Brute 0/0/3 attacks, Psi Hatchling 0/2/1 blocks.
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_BB'] }, { lab: ['BU_PH'] }], dice: [3, 3] });
    const d = blockedBattle(sc);
    expect(d.ofType('Disoriented')[0]).toMatchObject({ side: 'att', ability: 'psionic', auto: true });
    expect(d.ofType('PsionicWin')[0]).toMatchObject({ side: 'def', auto: true });
  });

  it('Robot vs Creature is unaffected (only Physical is fought)', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_SD'] }, { lab: ['BU_PH'] }], dice: [3, 3] });
    const d = blockedBattle(sc);
    expect(d.ofType('Disoriented')).toHaveLength(0);
  });
});

describe('B4: damage effects', () => {
  it('Overload Strike: 3 damage destroys a unit with Physical <= 3, otherwise lowers its Physical for the turn', () => {
    const sc = scenario({ seats: [{ hand: ['PW_OS', 'PW_OS'], cus: { R: 2, P: 2 } }, { lab: ['BU_LS', 'BU_LQ'] }] });
    const [ls, lq] = sc.ids[1]!.lab;
    const d = drive(sc);
    const play = getLegalActions(d.state, 0)!.plays.find((p) => p.uid === sc.ids[0]!.hand[0])!;
    expect(play.targets).toEqual(expect.arrayContaining([ls, lq, 'lab:0', 'lab:1']));
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: lq! }); // Loquidor Stalker 1/0/3
    d.passUntil(['main']);
    expect(d.state.cards[lq!]!.zone).toBe('discard');
    expect(d.last('UnitDestroyed')).toMatchObject({ uid: lq, cause: 'damage' });
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[1]!, target: 'lab:1' });
    d.passUntil(['main']);
    expect(d.state.players[1]!.labHP).toBe(12);
  });

  it('a unit that survives damage has its Physical lowered; strengths never go below 0', () => {
    const sc = scenario({ seats: [{ hand: ['PW_OS'], cus: { R: 1, P: 1 } }, { lab: ['BU_DC'] }] }); // Davileam 4/0/4
    const dc = sc.ids[1]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: dc });
    d.passUntil(['main']);
    expect(d.state.cards[dc]!.zone).toBe('lab');
    expect(viewFor(d.state, 0).unitStats[dc]!.physical).toBe(1);
  });

  it('Bio Pulse hits every enemy Creature and Cyborg; your own units and Robots are untouched', () => {
    const sc = scenario({ seats: [{ hand: ['PW_BP'], cus: { R: 2 }, lab: ['BU_PH'] }, { lab: ['BU_TS', 'BU_HB', 'BU_BM'] }] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.passUntil(['main']);
    const [ts, hb, bm] = sc.ids[1]!.lab;
    expect(d.state.cards[sc.ids[0]!.lab[0]!]!.zone).toBe('lab'); // your own Psi Hatchling is safe
    expect(viewFor(d.state, 0).unitStats[ts!]!.physical).toBe(2);
    expect(viewFor(d.state, 0).unitStats[bm!]!.physical).toBe(1);
    expect(viewFor(d.state, 0).unitStats[hb!]!.physical).toBe(2); // Robot: untouched
  });
});

describe('B5: new cost types', () => {
  it('"pay one of these": Overload Strike accepts Bio-Acceleration or Material Animation', () => {
    const r = scenario({ seats: [{ cus: { R: 2 } }, {}] }).state;
    const p = scenario({ seats: [{ cus: { P: 2 } }, {}] }).state;
    const g = scenario({ seats: [{ cus: { G: 2 } }, {}] }).state;
    const cost = r.defs.PW_OS!.cost!;
    expect(canAfford(r, 0, cost)).toBe(true);
    expect(canAfford(p, 0, cost)).toBe(true);
    expect(canAfford(g, 0, cost)).toBe(false);
  });

  it('"pay any": Equipment Mechanic depletes one Creation Unit of any type, destroying none', () => {
    const sc = scenario({ seats: [{ hand: ['PW_EM'], cus: { G: 1 }, discard: ['EQ_PA'], lab: ['BU_PH'] }, { lab: ['BU_HB'] }] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.passUntil(['chooseCard', 'main']);
    expect(d.state.players[0]!.cus).toHaveLength(1);
    expect(d.state.cards[d.state.players[0]!.cus[0]!]!.depleted).toBe(true);
    expect(d.ofType('CUDestroyed')).toHaveLength(0);
  });
});

describe('Resource Fortification', () => {
  it('attaches to a Creation Unit; that unit is depleted instead of destroyed when paying a destroy cost', () => {
    const sc = scenario({ seats: [{ hand: ['RS_RF', 'PW_EH'], cus: { G: 1 }, battleDeck: ['EQ_PB', 'BU_LS'], lab: ['BU_PH'] }, { lab: ['BU_HB'] }] });
    const d = drive(sc);
    const cu = d.state.players[0]!.cus[0]!;
    const opt = getLegalActions(d.state, 0)!.plays.find((p) => p.uid === sc.ids[0]!.hand[0]);
    expect(opt!.targets).toEqual([cu]);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: cu });
    expect(d.state.cards[cu]!.equipment).toBe(sc.ids[0]!.hand[0]);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[1]! }); // Equipment Hunter: destroy 1
    expect(d.state.players[0]!.cus).toEqual([cu]);
    expect(d.state.cards[cu]!.depleted).toBe(true);
    expect(d.last('CUFortified')).toMatchObject({ uids: [cu] });
  });
});

describe('A5: X strengths show their waiting bonus', () => {
  it('Shadow Assassin (Psionic X) with Psi Bolster shows X+1 before the roll', () => {
    const sc = scenario({ seats: [{ lab: [{ id: 'BU_SA', equip: 'EQ_PB' }] }, {}] });
    const st = viewFor(sc.state, 0).unitStats[sc.ids[0]!.lab[0]!]!;
    expect(st.psionic).toBe('X');
    expect(st.xBonus).toEqual({ psionic: 1 });
  });
});

describe("Creation Units ready only at the start of their owner's turn", () => {
  it("a Creation Unit spent in your turn stays spent through the opponent's turn", () => {
    const sc = scenario({ seats: [{ hand: ['PW_EH'], cus: { G: 2 }, battleDeck: ['EQ_PB', 'BU_LS', 'BU_TS'], lab: ['BU_PH'] }, { lab: ['BU_HB'], battleDeck: ['BU_LQ', 'BU_LQ'] }] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! }); // Equipment Hunter: destroy 1 Creation Unit
    d.passUntil(['chooseCard', 'main']);
    if (d.prompt!.kind === 'chooseCard') d.do({ type: 'ChooseFromList', choice: d.prompt!.options![0]! });
    const cus = () => d.state.players[0]!.cus.map((u) => d.state.cards[u]!.depleted);
    d.state.cards[d.state.players[0]!.cus[0]!]!.depleted = true; // spent this turn
    d.do({ type: 'AdvancePhase' });
    d.passUntil(['main']); // into the opponent's turn
    expect(d.state.turn.active).toBe(1);
    expect(cus()).toContain(true);
  });
});
