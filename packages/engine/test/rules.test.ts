/**
 * Build prompt §12 must-pass cases (spec §C3 list, corrected for the Q&A changes).
 * Dice are forced through `debugDice`, consumed in this order inside a blocked battle:
 *   stage a (X / modify rolls), then attacker cyber, psionic, physical, then defender cyber, psionic, physical
 *   (a die is only rolled when its battle occurs), then re-rolls.
 */
import { describe, expect, it } from 'vitest';
import { canAfford, enumeratePayments, getLegalActions, shortfall } from '../src/index';
import { defs, drive, scenario } from './helpers';

function attackBlocked(sc: ReturnType<typeof scenario>, attacker: string, blocker: string) {
  const d = drive(sc);
  d.expectPrompt('declareAttackers', 0);
  d.do({ type: 'DeclareAttackers', attacks: [{ uid: attacker, target: 1 }] });
  d.expectPrompt('declareBlockers', 1);
  d.do({ type: 'AssignBlockers', blocks: [{ blocker, attacker }] });
  return d;
}

describe('§12 dice and battle maths', () => {
  it('both players roll Cyber Obliterate: neither gets a Cyber bonus', () => {
    // Hydra Bot (Cy3 Ph2) vs Loquidor Stalker (Cy1 Ph3): Robots, so Cyber + Physical only.
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_HB'] }, { lab: ['BU_LQ'] }], dice: [6, 3, 6, 3] });
    const [hb] = sc.ids[0]!.lab;
    const [lq] = sc.ids[1]!.lab;
    const d = attackBlocked(sc, hb!, lq!);
    const ob = d.ofType('Obliterated');
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ die: 'cyber', by: 'both' });
    const br = d.last('BattleResolved');
    expect(br.att.cyber).toMatchObject({ strength: 3, die: 6, obliterated: true, total: 3 });
    expect(br.def.cyber).toMatchObject({ strength: 1, die: 6, obliterated: true, total: 1 });
    expect(br.def.disoriented).toBe(true);
    // Physical: 2+2 vs 3+2 — the defender is higher but Disoriented, so nothing is destroyed.
    expect(br.att.physical.total).toBe(4);
    expect(br.def.physical.total).toBe(5);
    expect(d.ofType('UnitDestroyed')).toHaveLength(0);
  });

  it('attacker Psionic side 1 vs defender Psionic Obliterate: attacker loses the +1 and the re-roll icon', () => {
    // Life Snatcher (Ps3 Ph2) vs Trangarey Scythe (Ps1 Ph3): Creatures, so Psionic + Physical.
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LS'] }, { lab: ['BU_TS'] }], dice: [1, 3, 6, 3] });
    const d = attackBlocked(sc, sc.ids[0]!.lab[0]!, sc.ids[1]!.lab[0]!);
    const br = d.last('BattleResolved');
    expect(br.att.psionic).toMatchObject({ die: 1, obliterated: true, total: 3 });
    expect(br.def.psionic).toMatchObject({ die: 6, obliterated: false, total: 2 });
    expect(d.ofType('Rerolled')).toHaveLength(0);
    // No re-roll prompt was ever offered: the flow ran straight on to the next turn.
    d.expectPrompt('main', 1);
  });

  it('control: an unobliterated Psionic side 1 does offer the re-roll, showing both totals', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LS'] }, { lab: ['BU_TS'] }], dice: [1, 3, 2, 3, 5] });
    const d = attackBlocked(sc, sc.ids[0]!.lab[0]!, sc.ids[1]!.lab[0]!);
    d.expectPrompt('reroll', 0);
    expect(d.prompt!.info).toMatchObject({ yourTotal: 4, theirTotal: 5 });
    d.do({ type: 'ChooseReroll', reroll: true });
    const br = d.last('BattleResolved');
    expect(br.att.physical.history).toEqual([3, 5]);
    expect(br.att.physical.total).toBe(2 + 4); // the new result replaces the old one
  });

  it('Disoriented attacker at Physical 7 vs defender 5: nothing destroyed', () => {
    // Loquidor (Cy1 Ph3) attacks Hydra (Cy3 Ph2). Cyber 1+2 vs 3+2 -> attacker Disoriented.
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LQ'] }, { lab: ['BU_HB'] }], dice: [2, 5, 2, 4] });
    const d = attackBlocked(sc, sc.ids[0]!.lab[0]!, sc.ids[1]!.lab[0]!);
    const br = d.last('BattleResolved');
    expect(br.att.disoriented).toBe(true);
    expect(br.att.physical.total).toBe(7);
    expect(br.def.physical.total).toBe(5);
    expect(d.ofType('UnitDestroyed')).toHaveLength(0);
  });

  it('defender 8 vs Disoriented attacker 7: attacker destroyed', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LQ'] }, { lab: [{ id: 'BU_HB', equip: 'EQ_KA' }] }], dice: [2, 5, 2, 5] });
    const att = sc.ids[0]!.lab[0]!;
    const d = attackBlocked(sc, att, sc.ids[1]!.lab[0]!);
    const br = d.last('BattleResolved');
    expect(br.att.disoriented).toBe(true);
    expect(br.att.physical.total).toBe(7);
    expect(br.def.physical.total).toBe(8);
    expect(d.ofType('UnitDestroyed').map((e) => e.uid)).toEqual([att]);
    expect(d.state.cards[att]!.zone).toBe('discard');
  });

  it('Robot vs Creature: only Physical dice are rolled', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_HB'] }, { lab: ['BU_LS'] }], dice: [3, 3] });
    const d = attackBlocked(sc, sc.ids[0]!.lab[0]!, sc.ids[1]!.lab[0]!);
    const dr = d.last('DiceRolled');
    expect(dr.att).toMatchObject({ cyber: null, psionic: null, physical: 3 });
    expect(dr.def).toMatchObject({ cyber: null, psionic: null, physical: 3 });
    expect(sc.state.debugDice.length - 2).toBe(0);
  });

  it('a Cyber/Psionic side 5 adds +1 Physical', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_HB'] }, { lab: ['BU_LQ'] }], dice: [5, 1, 2, 1] });
    const d = attackBlocked(sc, sc.ids[0]!.lab[0]!, sc.ids[1]!.lab[0]!);
    const br = d.last('BattleResolved');
    expect(br.att.physical).toMatchObject({ strength: 2, side5: 1, total: 2 + 1 + 1 });
  });
});

describe('§12 Commanders and damage', () => {
  it('Davileam Commander attacking alone and unblocked deals 5', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_DC'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 1 }] });
    expect(d.last('LabDamaged')).toMatchObject({ seat: 1, amount: 5, hp: 10 });
  });

  it('a Hydra Bot attacking alongside Davileam deals 3', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_DC', 'BU_HB'] }, {}] });
    const [dc, hb] = sc.ids[0]!.lab;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: dc!, target: 1 }, { uid: hb!, target: 1 }] });
    const hits = Object.fromEntries(d.ofType('UnblockedHit').map((e: any) => [e.attackId, e.damage]));
    expect(hits[dc!]).toBe(5);
    expect(hits[hb!]).toBe(3);
    expect(d.state.players[1]!.labHP).toBe(15 - 8);
  });
});

describe('§12 paying costs', () => {
  it('Davileam Commander with 3 green + 3 purple un-depleted is payable', () => {
    const sc = scenario({ seats: [{ hand: ['BU_DC'], cus: { G: 3, P: 3 } }, {}] });
    const d = drive(sc);
    d.expectPrompt('main', 0);
    const opt = getLegalActions(d.state, 0)!.plays.find((p) => p.cardId === 'BU_DC')!;
    expect(opt).toBeTruthy();
    expect(opt.payments).toEqual([{ destroy: { G: 1, P: 1 } }]);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    const p = d.state.players[0]!;
    expect(p.lab).toHaveLength(1);
    expect(p.cus).toHaveLength(4);
    expect(p.cus.every((u) => d.state.cards[u]!.depleted)).toBe(true);
    expect(p.discard).toHaveLength(2);
  });

  it('with only 2 green + 2 purple it is not payable', () => {
    const sc = scenario({ seats: [{ hand: ['BU_DC'], cus: { G: 2, P: 2 } }, {}] });
    expect(getLegalActions(sc.state, 0)!.plays.find((p) => p.cardId === 'BU_DC')).toBeUndefined();
    expect(canAfford(sc.state, 0, defs.BU_DC!.cost!)).toBe(false);
    expect(shortfall(sc.state, 0, defs.BU_DC!.cost!)).toEqual([{ type: 'W', missing: 2 }]);
  });

  it('white-only costs may destroy any CU type (RULING A7-a)', () => {
    const sc = scenario({ seats: [{ hand: ['PW_EH'], cus: { R: 1, G: 1 } }, {}] });
    const ps = enumeratePayments(sc.state, 0, defs.PW_EH!.cost!).map((p) => JSON.stringify(p.destroy)).sort();
    expect(ps).toEqual(['{"G":1}', '{"R":1}']);
  });

  it('a payment that destroys an ineligible type is rejected', () => {
    const sc = scenario({ seats: [{ hand: ['BU_LS'], cus: { B: 1, R: 1, G: 1 } }, {}] });
    const r = drive(sc).tryDo({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, payment: { destroy: { G: 1 } } });
    expect(r.ok).toBe(false);
  });
});

describe('§12 traps and escapes', () => {
  it('Grankor on a unit with Physical 1: freed only on a red value of 5', () => {
    for (let side = 1; side <= 6; side++) {
      const sc = scenario({ at: 'cleanup', seats: [{ lab: [{ id: 'BU_TB', trappedBy: { id: 'TR_GSF', owner: 1 } }] }, {}], dice: [side] });
      const d = drive(sc);
      const esc = d.last('EscapeAttempt');
      expect(esc, `side ${side}`).toMatchObject({ physical: 1, side, freed: side === 5 });
      const unit = sc.ids[0]!.trapped[0]!;
      expect(d.state.cards[unit]!.zone).toBe(side === 5 ? 'lab' : 'trapped');
      if (side === 5) {
        expect(d.state.cards[unit]!.depleted).toBe(true); // returns depleted (RULING A9-a)
        expect(d.state.players[1]!.discard).toContain(sc.ids[0]!.traps[0]); // trap to the trapper's discard
      }
    }
  });

  it('a Trap can be played in any phase (here: the opponent\'s Draw phase)', () => {
    const sc = scenario({ at: 'draw', seats: [{ lab: ['BU_LS'] }, { hand: ['TR_GSF'], cus: { G: 1 } }] });
    const d = drive(sc);
    d.expectPrompt('priority', 1);
    expect(d.state.phase).toBe('draw');
    d.do({ type: 'PlayCard', uid: sc.ids[1]!.hand[0]!, target: sc.ids[0]!.lab[0]! });
    d.passUntil(['main']);
    expect(d.state.cards[sc.ids[0]!.lab[0]!]!.zone).toBe('trapped');
  });

  it('a trap response resolves before the trap it answers', () => {
    const sc = scenario({ at: 'draw', seats: [{ lab: ['BU_LS'], hand: ['TR_GSF'], cus: { G: 1 } }, { lab: ['BU_HB'], hand: ['TR_GSF'], cus: { G: 1 } }] });
    const myUnit = sc.ids[0]!.lab[0]!;
    const theirUnit = sc.ids[1]!.lab[0]!;
    const d = drive(sc);
    d.expectPrompt('priority', 1);
    d.do({ type: 'PlayCard', uid: sc.ids[1]!.hand[0]!, target: myUnit });
    // The caster has nothing left to play (auto-pass on), so the target's owner — not
    // normally polled in the opponent's-turn window — gets to respond (house rule K).
    d.expectPrompt('priority', 0);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: theirUnit });
    d.passUntil(['main']);
    const trapped = d.ofType('UnitTrapped').map((e) => e.uid);
    expect(trapped).toEqual([theirUnit, myUnit]);
  });

  it('the caster keeps priority after playing (§A8 step 3)', () => {
    const sc = scenario({ at: 'draw', autoPassNoPlay: false, seats: [{ lab: ['BU_LS'] }, { hand: ['TR_GSF'], cus: { G: 1 } }] });
    const d = drive(sc);
    d.expectPrompt('priority', 1);
    d.do({ type: 'PlayCard', uid: sc.ids[1]!.hand[0]!, target: sc.ids[0]!.lab[0]! });
    d.expectPrompt('priority', 1);
    d.do({ type: 'Pass' });
    d.expectPrompt('priority', 0);
    d.do({ type: 'Pass' });
    expect(d.last('UnitTrapped').uid).toBe(sc.ids[0]!.lab[0]);
  });

  it('a trapped unit cannot attack or block, keeps its Equipment, and its Commander aura stops', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: [{ id: 'BU_SC', trappedBy: { id: 'TR_GSF', owner: 1 } }, 'BU_LS'] }, { lab: [{ id: 'BU_TS', equip: 'EQ_PA', trappedBy: { id: 'TR_GSF', owner: 0 } }] }] });
    const la = getLegalActions(sc.state, 0)!;
    expect(la.attack!.eligible).toEqual([sc.ids[0]!.lab[1]]);
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[1]!, target: 1 }] });
    // Defender's only unit is trapped: no blockers prompt; LS hits for 2 with no Siana aura.
    expect(d.last('UnblockedHit').damage).toBe(2);
    expect(d.state.cards[sc.ids[1]!.equip[sc.ids[1]!.trapped[0]!]!]!.attachedTo).toBe(sc.ids[1]!.trapped[0]);
  });
});

describe('§12 turn structure', () => {
  it('a unit created this turn can attack (no summoning sickness)', () => {
    const sc = scenario({ seats: [{ hand: ['BU_LS'], cus: { B: 2, R: 1 } }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    const unit = sc.ids[0]!.hand[0]!;
    expect(d.state.cards[unit]!.depleted).toBe(false);
    expect(d.state.cards[unit]!.enteredThisTurn).toBe(true);
    d.do({ type: 'AdvancePhase' });
    d.expectPrompt('declareAttackers', 0);
    expect(getLegalActions(d.state, 0)!.attack!.eligible).toContain(unit);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: unit, target: 1 }] });
    expect(d.last('UnblockedHit').damage).toBe(2);
  });

  it('Equipment played this turn boosts stats this turn, on attack and on defence', () => {
    const sc = scenario({
      seats: [{ lab: ['BU_LS'], hand: ['EQ_KA'], cus: { R: 2, P: 1 } }, { lab: [{ id: 'BU_TS', equip: 'EQ_PA' }] }],
      dice: [1, 1, 1, 1],
    });
    const ls = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]!, target: ls });
    d.do({ type: 'AdvancePhase' });
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ls, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: ls }] });
    d.passUntil(['main']);
    const br = d.last('BattleResolved');
    expect(br.att.physical.strength).toBe(2 + 2); // Kranthard, played this turn, on attack
    expect(br.def.physical.strength).toBe(3 + 1); // Physical Augmentation on defence
    expect(d.state.cards[sc.ids[0]!.hand[0]!]!.depleted).toBe(false); // Equipment is never depleted
  });

  it('Equipment onto an equipped unit is illegal until the old one is moved or discarded', () => {
    const sc = scenario({ seats: [{ lab: [{ id: 'BU_LS', equip: 'EQ_PA' }, 'BU_TS'], hand: ['EQ_KA'], cus: { R: 2, P: 1 } }, {}] });
    const [ls, ts] = sc.ids[0]!.lab;
    const pa = sc.ids[0]!.equip[ls!]!;
    const ka = sc.ids[0]!.hand[0]!;
    const d = drive(sc);
    expect(getLegalActions(d.state, 0)!.plays.find((p) => p.uid === ka)!.targets).toEqual([ts]);
    expect(d.tryDo({ type: 'PlayCard', uid: ka, target: ls! }).ok).toBe(false);
    d.do({ type: 'MoveEquipment', equip: pa, to: ts! });
    expect(getLegalActions(d.state, 0)!.plays.find((p) => p.uid === ka)!.targets).toEqual([ls]);
    d.do({ type: 'DiscardEquipment', equip: pa });
    expect(d.state.cards[pa]!.zone).toBe('discard');
    expect(getLegalActions(d.state, 0)!.plays.find((p) => p.uid === ka)!.targets!.sort()).toEqual([ls, ts].sort());
  });

  it('Equipment left without a unit is discarded automatically', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: [{ id: 'BU_LS', equip: 'EQ_PA' }] }, { lab: [{ id: 'BU_SC' }] }], dice: [2, 1, 5, 4] });
    const ls = sc.ids[0]!.lab[0]!;
    const d = attackBlocked(sc, ls, sc.ids[1]!.lab[0]!);
    expect(d.state.cards[ls]!.zone).toBe('discard');
    const pa = sc.ids[0]!.equip[ls]!;
    expect(d.state.cards[pa]!.zone).toBe('discard');
    expect(d.state.cards[pa]!.attachedTo).toBeNull();
  });

  it('the Power-card window happens even when no attackers are declared', () => {
    const sc = scenario({ at: 'battle', autoPassNoPlay: false, seats: [{ lab: ['BU_LS'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [] });
    d.expectPrompt('priority', 0);
    expect(d.prompt!.info!.point).toBe('battlePower');
    expect(d.state.step).toBe('power');
    d.do({ type: 'Pass' });
    d.expectPrompt('priority', 1);
    expect(d.prompt!.info!.point).toBe('battlePower');
  });

  it('a player with no Battle Units in Lab, hand or Battle Deck loses immediately', () => {
    const sc = scenario({ seats: [{ lab: ['BU_LS'] }, { battleDeck: [], hand: ['EQ_PA'] }] });
    expect(sc.state.result).toMatchObject({ winners: [0], draw: false, reason: 'noBattleUnits' });
  });

  it('trapped units count as being in the Lab for that check', () => {
    const sc = scenario({ seats: [{ lab: ['BU_LS'] }, { battleDeck: [], lab: [{ id: 'BU_TS', trappedBy: { id: 'TR_GSF', owner: 0 } }] }] });
    expect(sc.state.result).toBeNull();
  });

  it('simultaneous loss is a draw', () => {
    const sc = scenario({ seats: [{ battleDeck: [] }, { battleDeck: [] }] });
    expect(sc.state.result).toMatchObject({ winners: [], draw: true });
  });

  it('Lab at 0 HP loses as soon as the damage lands', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_DC'] }, { hp: 5 }] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 1 }] });
    expect(d.state.result).toMatchObject({ winners: [0], reason: 'labDestroyed' });
    expect(d.state.prompt).toBeNull();
  });
});
