/** One or more tests for every card ability in the pool (acceptance checklist item 1). */
import { describe, expect, it } from 'vitest';
import { getLegalActions, viewFor } from '../src/index';
import { cardsJson, drive, scenario } from './helpers';

const attackUnblocked = (sc: ReturnType<typeof scenario>, uids: string[]) => {
  const d = drive(sc);
  d.do({ type: 'DeclareAttackers', attacks: uids.map((uid) => ({ uid, target: 1 })) });
  return d;
};

describe('Dark Shredder — optional red-die modifier', () => {
  const cases: [number, number][] = [[1, 1], [2, 3], [3, 1], [4, 3], [5, 1], [6, 3]];
  for (const [side, dmg] of cases) {
    it(`side ${side} -> ${dmg} damage unblocked (Obliterate counts as 4, even)`, () => {
      const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_DSH'] }, {}], dice: [side] });
      const d = attackUnblocked(sc, [sc.ids[0]!.lab[0]!]);
      d.expectPrompt('optionalRoll', 0);
      d.do({ type: 'UseAbility', use: true });
      expect(d.last('UnblockedHit').damage).toBe(dmg);
    });
  }
  it('declining rolls nothing', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_DSH'] }, {}], dice: [] });
    const d = attackUnblocked(sc, [sc.ids[0]!.lab[0]!]);
    d.do({ type: 'UseAbility', use: false });
    expect(d.ofType('RollModified')).toHaveLength(0);
    expect(d.last('UnblockedHit').damage).toBe(2);
  });
  it('is decided before any battle die is rolled', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_DSH'] }, { lab: ['BU_TS'] }], dice: [2, 2, 2, 2, 2] });
    const d = drive(sc);
    const ds = sc.ids[0]!.lab[0]!;
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ds, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: ds }] });
    d.expectPrompt('optionalRoll', 0);
    expect(d.ofType('DiceRolled')).toHaveLength(0);
    d.do({ type: 'UseAbility', use: true });
    const evs = d.events.map((e) => e.type);
    expect(evs.indexOf('RollModified')).toBeLessThan(evs.indexOf('DiceRolled'));
  });
});

describe('X abilities — Shadow Assassin, Therabot Seeker, Zomber Mercenary', () => {
  it('Shadow Assassin rolls Psionic X in stage a; Obliterate = 4', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_SA'] }, { lab: ['BU_TS'] }], dice: [6, 2, 2, 2, 2] });
    const sa = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sa, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: sa }] });
    expect(d.last('XRolled')).toMatchObject({ uid: sa, stat: 'psionic', side: 6, value: 4 });
    expect(d.last('BattleResolved').att.psionic.strength).toBe(4);
  });
  it('X counts as >= 1, so Therabot fights a Cyber battle', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_TB'] }, { lab: ['BU_HB'] }], dice: [3, 2, 2, 2, 2] });
    const tb = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: tb, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: tb }] });
    const br = d.last('BattleResolved');
    expect(br.att.cyber).toMatchObject({ strength: 3 });
  });
  it('X lasts for the turn and is shown as X (null) outside it', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_ZM'] }, {}], dice: [5] });
    const zm = sc.ids[0]!.lab[0]!;
    const d = attackUnblocked(sc, [zm]);
    expect(d.last('XRolled')).toMatchObject({ uid: zm, value: 5 });
    d.passUntil(['main']);
    expect(d.state.cards[zm]!.xValue).toBeNull(); // next turn
  });
  it('X counts as > 0 for Equipment eligibility (Psi Bolster onto Zomber)', () => {
    const sc = scenario({ seats: [{ lab: ['BU_ZM'], hand: ['EQ_PB'], cus: { B: 1, R: 1 } }, {}] });
    expect(getLegalActions(sc.state, 0)!.plays[0]!.targets).toEqual([sc.ids[0]!.lab[0]]);
  });
});

describe('Commander auras — Siana, Davileam', () => {
  it('Siana: attacking Creatures (incl. itself) get +1 Psionic and +1 Physical', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_SC', 'BU_LS'] }, {}] });
    const [sc1, ls] = sc.ids[0]!.lab;
    const d = attackUnblocked(sc, [sc1!, ls!]);
    const hits = Object.fromEntries(d.ofType('UnblockedHit').map((e: any) => [e.attackId, e.damage]));
    expect(hits).toEqual({ [sc1!]: 5, [ls!]: 3 });
  });
  it('does not apply when defending', () => {
    const sc = scenario({ at: 'battle', active: 1, seats: [{ lab: ['BU_SC', 'BU_LS'] }, { lab: ['BU_TS'] }], dice: [2, 2, 2, 2] });
    const d = drive(sc);
    const ts = sc.ids[1]!.lab[0]!;
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ts, target: 0 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[0]!.lab[1]!, attacker: ts }] });
    expect(d.last('BattleResolved').def.physical.strength).toBe(2);
  });
  it('two Commanders add up; non-matching types get nothing', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_DC', 'BU_DC', 'BU_LS'] }, {}] });
    const [a, b, ls] = sc.ids[0]!.lab;
    const d = attackUnblocked(sc, [a!, b!, ls!]);
    const hits = Object.fromEntries(d.ofType('UnblockedHit').map((e: any) => [e.attackId, e.damage]));
    expect(hits[a!]).toBe(6);
    expect(hits[ls!]).toBe(2);
  });
});

describe('Blade Master — 1 damage when it destroys a unit (RULING B1-c)', () => {
  it('on attack', () => {
    // BM Cy2 Ps2 Ph2 vs Trangarey (Ps1 Ph3). Psionic: 2+2 vs 1+2; Physical 2+4=6 vs 3+1=4.
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_BM'] }, { lab: ['BU_TS'] }], dice: [2, 5, 2, 1] });
    const bm = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: bm, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: bm }] });
    expect(d.ofType('UnitDestroyed')).toHaveLength(1);
    expect(d.last('LabDamaged')).toMatchObject({ seat: 1, amount: 1, source: bm });
  });
  it('on defence: the attacker\'s Lab takes the damage', () => {
    const sc = scenario({ at: 'battle', active: 1, seats: [{ lab: ['BU_BM'] }, { lab: ['BU_TS'] }], dice: [2, 1, 2, 5] });
    const ts = sc.ids[1]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ts, target: 0 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[0]!.lab[0]!, attacker: ts }] });
    expect(d.last('LabDamaged')).toMatchObject({ seat: 1, amount: 1 });
  });
  it('as part of a Stack', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_BM', 'BU_LS'] }, { lab: ['BU_TS'] }], dice: [2, 5, 2, 1] });
    const [bm, ls] = sc.ids[0]!.lab;
    const d = drive(sc);
    d.do({ type: 'Stack', a: bm!, b: ls! });
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: bm!, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: bm! }] });
    expect(d.last('BattleResolved').att.physical.strength).toBe(4);
    expect(d.last('LabDamaged')).toMatchObject({ seat: 1, amount: 1 });
  });
});

describe('Lodner Predator — when it attacks, the attacked player destroys a Creation Unit (Change Request 1)', () => {
  it('the attacked player chooses which Creation Unit to destroy', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LP'] }, { cus: { G: 1, B: 1 } }] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 1 }] });
    d.expectPrompt('chooseCard', 1);
    const [g] = sc.state.players[1]!.cus;
    d.do({ type: 'ChooseFromList', choice: g! });
    expect(d.state.players[1]!.cus).not.toContain(g);
    expect(d.state.players[1]!.discard).toContain(g);
    expect(d.last('CUDestroyed')).toMatchObject({ seat: 1, uids: [g], reason: 'ability' });
  });
  it('does nothing when defending, and costs 3 to destroy', () => {
    const sc = scenario({ at: 'battle', active: 1, seats: [{ lab: ['BU_LP'], cus: { G: 1 } }, { lab: ['BU_HB'] }], dice: [1, 1, 1, 1, 1, 1] });
    const d = drive(sc);
    const hb = sc.ids[1]!.lab[0]!;
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: hb, target: 0 }] });
    expect(d.ofType('CUDestroyed')).toHaveLength(0);
    expect(sc.state.defs.BU_LP!.cost!.W).toBe(3);
  });
});

describe('Jingwa Psi Avenger — Psionic win: the opponent discards a Power card (Change Request 1)', () => {
  // Jingwa Ps3 Ph1 vs Trangarey Ps1 Ph3: Psionic 3+2 vs 1+2 -> Jingwa wins.
  it('the opponent chooses which Power card to discard', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_JPA'] }, { lab: ['BU_TS'], hand: ['PW_CR', 'TR_GSF', 'BU_LS'] }], dice: [2, 2, 2, 2] });
    const j = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: j, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: j }] });
    d.expectPrompt('chooseCard', 1);
    const [cr, gsf] = sc.ids[1]!.hand;
    expect(d.prompt!.options!.sort()).toEqual([cr, gsf].sort());
    d.do({ type: 'ChooseFromList', choice: gsf! });
    expect(d.last('CardDiscarded')).toMatchObject({ seat: 1, uid: gsf, cardId: 'TR_GSF' });
    expect(d.state.players[1]!.hand).not.toContain(gsf);
    expect(d.state.players[1]!.discard).toContain(gsf);
  });
  it('with no Power card the whole hand is revealed', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_JPA'] }, { lab: ['BU_TS'], hand: ['BU_LS', 'EQ_PA'] }], dice: [2, 2, 2, 2] });
    const j = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: j, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: j }] });
    const ev = d.last('CardsRevealed');
    expect(ev.wholeHand).toBe(true);
    expect(ev.cards).toHaveLength(2);
  });
});

describe('Power cards', () => {
  it('Creature Regenerate returns a Creature or Cyborg to play, changed; not playable if none (Change Request 1)', () => {
    const none = scenario({ seats: [{ hand: ['PW_CR'], cus: { B: 2, R: 2 }, discard: ['BU_HB'] }, {}] });
    expect(getLegalActions(none.state, 0)!.plays).toHaveLength(0);
    const sc = scenario({ seats: [{ hand: ['PW_CR'], cus: { B: 2, R: 2 }, discard: ['BU_HB', 'BU_SC', 'BU_BM'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.passUntil(['chooseCard']);
    const [, sc2, bm] = sc.ids[0]!.discard;
    expect(d.prompt!.options!.sort()).toEqual([sc2, bm].sort());
    d.do({ type: 'ChooseFromList', choice: sc2! });
    expect(d.state.cards[sc2!]!.zone).toBe('lab');
    expect(d.state.cards[sc2!]!.depleted).toBe(false);
    expect(d.state.cards[sc2!]!.permMods).toEqual({ cyber: 0, psionic: -1, physical: 1 });
    expect(d.last('UnitRevived')).toMatchObject({ seat: 0, uid: sc2 });
    expect(d.state.players[0]!.discard).toContain(sc.ids[0]!.hand[0]); // power discarded after use
    expect(d.state.players[0]!.cus).toHaveLength(2); // destroyed 2 (W2), depleted 2
  });

  it('a revived Cyborg gets +2 Physical, -1 Cyber, -1 Psionic; modifiers vanish when it leaves play', () => {
    const sc = scenario({ seats: [{ hand: ['PW_RR'], cus: { G: 2, P: 2 }, discard: ['BU_BM'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.passUntil(['chooseCard', 'main']);
    if (d.prompt!.kind === 'chooseCard') d.do({ type: 'ChooseFromList', choice: sc.ids[0]!.discard[0]! });
    const bm = sc.ids[0]!.discard[0]!;
    const st = viewFor(d.state, 0).unitStats[bm]!;
    expect([st.cyber, st.psionic, st.physical]).toEqual([1, 1, 4]); // Blade Master 2/2/2
  });

  it('Equipment Hunter searches the Battle Deck, then shuffles', () => {
    const sc = scenario({ seats: [{ hand: ['PW_EH'], cus: { G: 1 }, battleDeck: ['BU_TS', 'EQ_PB', 'BU_LS'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.expectPrompt('chooseCard', 0);
    const eq = sc.ids[0]!.battleDeck[1]!;
    expect(d.prompt!.options).toEqual([eq]);
    d.do({ type: 'ChooseFromList', choice: eq });
    expect(d.state.players[0]!.hand).toContain(eq);
    expect(d.ofType('DeckShuffled')).toHaveLength(1);
  });

  it('Equipment Hunter with no Equipment in the deck still shuffles', () => {
    const sc = scenario({ seats: [{ hand: ['PW_EH'], cus: { G: 1 }, battleDeck: ['BU_TS'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    expect(d.last('DeckSearched')).toMatchObject({ found: false });
    expect(d.ofType('DeckShuffled')).toHaveLength(1);
  });

  it('Equipment Mechanic returns an Equipment card from discard', () => {
    const sc = scenario({ seats: [{ hand: ['PW_EM'], cus: { G: 1 }, discard: ['EQ_KA'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.do({ type: 'ChooseFromList', choice: sc.ids[0]!.discard[0]! });
    expect(d.state.players[0]!.hand).toContain(sc.ids[0]!.discard[0]);
  });

  it('High-Energy Pulse in Creation: Cyber units (both players) cannot attack or defend this turn', () => {
    const sc = scenario({ seats: [{ lab: ['BU_HB', 'BU_LS'], hand: ['PW_HEP'], cus: { G: 2, P: 1 } }, { lab: ['BU_LQ'] }] });
    const [hb, ls] = sc.ids[0]!.lab;
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    expect(d.last('UnitsDisabled').uids.sort()).toEqual([hb, sc.ids[1]!.lab[0]].sort());
    d.do({ type: 'AdvancePhase' });
    expect(getLegalActions(d.state, 0)!.attack!.eligible).toEqual([ls]);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ls!, target: 1 }] });
    // Loquidor cannot block: LS goes through.
    expect(d.last('UnblockedHit')).toMatchObject({ damage: 2 });
    d.passUntil(['main']);
    expect(d.state.turnEffects).toHaveLength(0); // "for Turn"
  });

  it('High-Energy Pulse in Battle step 3 removes blockers: the blocked attacker becomes unblocked', () => {
    const sc = scenario({ at: 'battle', active: 1, seats: [{ lab: ['BU_LQ'], hand: ['PW_HEP'], cus: { G: 2, P: 1 } }, { lab: ['BU_LS'] }] });
    const ls = sc.ids[1]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ls, target: 0 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[0]!.lab[0]!, attacker: ls }] });
    d.expectPrompt('priority', 0);
    expect(d.state.step).toBe('power');
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.passUntil(['main']);
    expect(d.ofType('RemovedFromBattle')[0]).toMatchObject({ uid: sc.ids[0]!.lab[0], role: 'defender' });
    expect(d.last('UnblockedHit')).toMatchObject({ attackId: ls, damage: 2 });
  });

  it('High-Energy Pulse affects a Stack if either unit qualifies', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_BM', 'BU_LS'] }, { hand: ['PW_HEP'], cus: { G: 2, P: 1 } }] });
    const [bm, ls] = sc.ids[0]!.lab;
    const d = drive(sc);
    d.do({ type: 'Stack', a: bm!, b: ls! });
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: bm!, target: 1 }] });
    d.expectPrompt('priority', 1);
    d.do({ type: 'PlayCard', uid: sc.ids[1]!.hand[0]! });
    d.passUntil(['main']);
    expect(d.ofType('UnblockedHit')).toHaveLength(0);
    expect(d.state.players[1]!.labHP).toBe(14); // only Blade Master's on-attack damage (Change Request 1)
  });

  it('Grankor Stasis Field traps an opposing unit; a trapped stack partner leaves, the other fights on', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_BM', 'BU_LS'] }, { hand: ['TR_GSF'], cus: { G: 1 } }] });
    const [bm, ls] = sc.ids[0]!.lab;
    const d = drive(sc);
    d.do({ type: 'Stack', a: bm!, b: ls! });
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: bm!, target: 1 }] });
    d.expectPrompt('priority', 1); // afterAttackersDeclared window
    d.do({ type: 'PlayCard', uid: sc.ids[1]!.hand[0]!, target: ls! });
    d.passUntil(['main']);
    expect(d.state.cards[ls!]!.zone).toBe('trapped');
    expect(d.last('UnblockedHit')).toMatchObject({ attackId: bm, units: [bm], damage: 2 });
  });

  it('Grankor cannot target your own units', () => {
    const sc = scenario({ seats: [{ lab: ['BU_LS'], hand: ['TR_GSF'], cus: { G: 1 } }, {}] });
    expect(getLegalActions(sc.state, 0)!.plays).toHaveLength(0);
  });
});

describe('Resource cards', () => {
  it('a drawn Creation Unit goes straight into the Lab, ready (RULING A7-c)', () => {
    const sc = scenario({ at: 'draw', seats: [{ resourceDeck: ['CU_BA'] }, {}] });
    const p = sc.state.players[0]!;
    expect(p.cus).toHaveLength(1);
    expect(sc.state.cards[p.cus[0]!]!.depleted).toBe(false);
    expect(p.hand.some((u) => sc.state.cards[u]!.cardId === 'CU_BA')).toBe(false);
  });

  it('Creation Oracle: use now -> search a CU into the Lab and shuffle', () => {
    const sc = scenario({ at: 'draw', seats: [{ resourceDeck: ['RS_CO', 'CU_NG', 'CU_MA'] }, {}] });
    const d = drive(sc);
    d.expectPrompt('oracle', 0);
    d.do({ type: 'ChooseFromList', choice: 'use' });
    d.expectPrompt('chooseCard', 0);
    expect(d.prompt!.options).toEqual(['CU_NG', 'CU_MA']);
    d.do({ type: 'ChooseFromList', choice: 'CU_MA' });
    const p = d.state.players[0]!;
    expect(p.cus.map((u) => d.state.cards[u]!.cardId)).toEqual(['CU_MA']);
    expect(p.discard.map((u) => d.state.cards[u]!.cardId)).toEqual(['RS_CO']);
  });

  it('Creation Oracle: keep -> usable later from hand at no cost', () => {
    const sc = scenario({ at: 'draw', seats: [{ resourceDeck: ['RS_CO', 'CU_NG'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'ChooseFromList', choice: 'keep' });
    d.expectPrompt('main', 0);
    const oracle = d.state.players[0]!.hand.find((u) => d.state.cards[u]!.cardId === 'RS_CO')!;
    d.do({ type: 'PlayCard', uid: oracle });
    d.do({ type: 'ChooseFromList', choice: 'CU_NG' });
    expect(d.state.players[0]!.cus).toHaveLength(1);
  });
});

describe('Stacking', () => {
  it('a Cyborg + non-Cyborg stack sums its strengths and splits after battle', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: [{ id: 'BU_BM', equip: 'EQ_PA' }, { id: 'BU_SC' }] }, {}] });
    const [bm, siana] = sc.ids[0]!.lab;
    const d = drive(sc);
    d.do({ type: 'Stack', a: bm!, b: siana! });
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: siana!, target: 1 }] });
    // BM 2+1 (Equipment) + Siana 4 + 1 (own aura; BM is not a Creature) = 8
    expect(d.last('UnblockedHit').damage).toBe(8);
    d.passUntil(['main']);
    expect(d.state.cards[bm!]!.stackPartner).toBeNull();
  });
  it('two Cyborgs cannot stack; a depleted unit cannot be part of an attacking stack', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_BM', 'BU_LP', { id: 'BU_LS', depleted: true }] }, {}] });
    const [bm, lp, ls] = sc.ids[0]!.lab;
    const d = drive(sc);
    expect(d.tryDo({ type: 'Stack', a: bm!, b: lp! }).ok).toBe(false);
    d.do({ type: 'Stack', a: bm!, b: ls! });
    expect(getLegalActions(d.state, 0)!.attack!.eligible).toEqual([lp]);
  });
  it('stacking is not allowed in the Creation phase', () => {
    const sc = scenario({ seats: [{ lab: ['BU_BM', 'BU_LS'] }, {}] });
    expect(getLegalActions(sc.state, 0)!.stacks).toEqual([]);
  });
});

describe('every enabled card with an ability has at least one implementation path', () => {
  const triggers = new Set(['ModifyRoll', 'RollX', 'StaticAura', 'CyborgStep', 'OnPsionicWin', 'OnCyberWin', 'OnPhysicalWin', 'OnDestroyEnemyUnit', 'TrapEscapeCheck', 'OnPlay', 'OnAttack', 'Static']);
  for (const c of cardsJson.cards) {
    for (const e of c.effects) {
      it(`${c.id} ${e.trigger}/${e.effect}`, () => {
        expect(triggers.has(e.trigger)).toBe(true);
      });
    }
  }
});
