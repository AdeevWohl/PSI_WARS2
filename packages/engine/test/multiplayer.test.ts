/** House rules A–G (3–4 players), first-turn draw, conceding, dice variants, and the art-only extra cards. */
import { describe, expect, it } from 'vitest';
import { applyCommand, getLegalActions } from '../src/index';
import { drive, newGame, scenario } from './helpers';

describe('3–4 player house rules', () => {
  it('A: each attacker picks its own target; B: only the attacked player blocks, in turn order', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LS', 'BU_TS'] }, { lab: ['BU_HB'] }, { lab: ['BU_LQ'] }], dice: Array(12).fill(2) });
    const [ls, ts] = sc.ids[0]!.lab;
    const d = drive(sc);
    expect(getLegalActions(d.state, 0)!.attack!.targets).toEqual([1, 2]);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ls!, target: 1 }, { uid: ts!, target: 2 }] });
    d.expectPrompt('declareBlockers', 1);
    expect(getLegalActions(d.state, 1)!.block!.attackers).toEqual([ls]);
    expect(d.tryDo({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: ts! }] }).ok).toBe(false);
    d.do({ type: 'AssignBlockers', blocks: [] });
    d.expectPrompt('declareBlockers', 2);
    expect(getLegalActions(d.state, 2)!.block!.attackers).toEqual([ts]);
  });

  it('single-target variant flag restricts all attackers to one player', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LS', 'BU_TS'] }, {}, {}] });
    const s = { ...sc.state, rules: { ...sc.state.rules, houseRules: { ...sc.state.rules.houseRules, MP_ATTACK_TARGETING: 'singlePlayer' } } };
    const [ls, ts] = sc.ids[0]!.lab;
    expect(applyCommand(s, 0, { type: 'DeclareAttackers', attacks: [{ uid: ls!, target: 1 }, { uid: ts!, target: 2 }] }).ok).toBe(false);
  });

  it('C: the Power-card window polls every player in turn order from the attacker', () => {
    const sc = scenario({ at: 'battle', autoPassNoPlay: false, active: 1, seats: [{}, { lab: ['BU_LS'] }, {}] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [] });
    const order: number[] = [];
    while (d.prompt?.kind === 'priority' && d.prompt.info?.point === 'battlePower') {
      order.push(d.prompt.seat);
      d.do({ type: 'Pass' });
    }
    expect(order).toEqual([1, 2, 0]);
  });

  it('D: an eliminated player\'s cards leave the game; units they trapped are freed, depleted; play continues', () => {
    const sc = scenario({
      at: 'battle',
      seats: [{ lab: ['BU_DC'] }, { lab: [{ id: 'BU_LS', trappedBy: { id: 'TR_GSF', owner: 2 } }] }, { hp: 3, lab: ['BU_TS'], hand: ['PW_EH'] }],
    });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 2 }] });
    d.do({ type: 'AssignBlockers', blocks: [] });
    expect(d.last('PlayerEliminated')).toMatchObject({ seat: 2, reason: 'labDestroyed' });
    expect(d.state.result).toBeNull();
    const freed = sc.ids[1]!.trapped[0]!;
    expect(d.state.cards[freed]!.zone).toBe('lab');
    expect(d.last('UnitFreed')).toMatchObject({ uid: freed, reason: 'trapperEliminated' });
    // (It returned depleted; by now its owner's Replenish phase has readied it.)
    expect(d.state.turn.active).toBe(1);
    expect(Object.values(d.state.cards).filter((c) => c.owner === 2).every((c) => c.zone === 'removed')).toBe(true);
    d.passUntil(['main']);
    expect(d.state.turn.active).toBe(1);
    d.do({ type: 'AdvancePhase' });
    d.passUntil(['main']);
    expect(d.state.turn.active).toBe(0); // turn order skips the eliminated seat
  });

  it('E: Blade Master\'s damage hits the Lab of the player whose unit it destroyed', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_BM'] }, {}, { lab: ['BU_TS'] }], dice: [2, 5, 2, 1] });
    const bm = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: bm, target: 2 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[2]!.lab[0]!, attacker: bm }] });
    expect(d.last('LabDamaged')).toMatchObject({ seat: 2, amount: 1 });
    expect(d.state.players[1]!.labHP).toBe(15);
  });

  it('E: Lodner Predator mills the defender it attacks', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LP'] }, { resourceDeck: ['CU_NG'] }, { resourceDeck: ['CU_BA'] }], dice: [6] });
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: sc.ids[0]!.lab[0]!, target: 2 }] });
    d.do({ type: 'UseAbility', use: true });
    expect(d.last('CardMilled')).toMatchObject({ seat: 2, cardId: 'CU_BA' });
  });

  it('E: High-Energy Pulse affects everyone', () => {
    const sc = scenario({ seats: [{ hand: ['PW_HEP'], cus: { G: 2, P: 1 }, lab: ['BU_LS'] }, { lab: ['BU_HB'] }, { lab: ['BU_LQ'] }] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    expect(d.last('UnitsDisabled').uids.sort()).toEqual([sc.ids[1]!.lab[0], sc.ids[2]!.lab[0]].sort());
  });

  it('G: only the first player skips their first Battle-Deck draw', () => {
    let { state } = newGame('first-turn', { players: 3, autoPassNoPlay: true });
    const first = state.turn.firstPlayer;
    expect(state.prompt).toMatchObject({ kind: 'main', seat: first });
    expect(state.players[first]!.hand.filter((u) => state.cards[u]!.cardId.startsWith('RS_')).length + 5).toBe(state.players[first]!.hand.length);
    // Advance to the second player's main phase.
    for (let i = 0; i < 50 && !(state.prompt?.kind === 'main' && state.prompt.seat !== first); i++) {
      const p = state.prompt!;
      const cmd = p.kind === 'main' ? { type: 'AdvancePhase' as const } : p.kind === 'declareAttackers' ? { type: 'DeclareAttackers' as const, attacks: [] } : p.kind === 'oracle' ? { type: 'ChooseFromList' as const, choice: 'keep' } : { type: 'Pass' as const };
      const r = applyCommand(state, p.seat, cmd);
      if (!r.ok) throw new Error(r.error);
      state = r.state;
    }
    const second = state.prompt!.seat;
    const battleCards = state.players[second]!.hand.filter((u) => state.cards[u]!.cardId.startsWith('RS_') === false).length;
    expect(battleCards).toBe(6);
  });

  it('a non-active player can concede mid-turn; the game continues with the rest', () => {
    const { state } = newGame('concede', { players: 3 });
    const other = [0, 1, 2].find((x) => x !== state.turn.active)!;
    const r = applyCommand(state, other, { type: 'Concede' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[other]!.eliminated).toBe(true);
    expect(r.state.result).toBeNull();
    expect(r.state.prompt).not.toBeNull();
  });

  it('conceding in a 2-player game ends it', () => {
    const { state } = newGame('concede2');
    const r = applyCommand(state, 1, { type: 'Concede' });
    expect(r.ok && r.state.result).toMatchObject({ winners: [0], reason: 'conceded' });
  });
});

describe('dice variant: no modifier dice', () => {
  it('each die gives +side; no obliteration, no re-roll icon', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_LS'] }, { lab: ['BU_TS'] }], dice: [1, 6, 6, 1] });
    const s = { ...sc.state, config: { ...sc.state.config, diceVariant: 'noModifier' as const } };
    const d = drive({ state: s, events: [] });
    const ls = sc.ids[0]!.lab[0]!;
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ls, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: ls }] });
    const br = d.last('BattleResolved');
    expect(br.att.psionic).toMatchObject({ total: 3 + 1, obliterated: false });
    expect(br.def.psionic).toMatchObject({ total: 1 + 6, obliterated: false });
    expect(br.att.physical.total).toBe(2 + 6);
    expect(d.ofType('Obliterated')).toHaveLength(0);
    expect(d.ofType('Rerolled')).toHaveLength(0);
  });
});

describe('art-only extra cards (disabled by default, data-driven)', () => {
  it('Veeda Commander: attacking Cyborgs get +1 Cyber and +1 Psionic', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_VC', 'BU_BM'] }, { lab: ['BU_HB'] }], dice: Array(8).fill(2) });
    const bm = sc.ids[0]!.lab[1]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: bm, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: bm }] });
    expect(d.last('BattleResolved').att.cyber.strength).toBe(3);
  });

  it('Acorbeac Destroyer: on Psionic win may put a Cyborg from the deck on top', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_AD'], battleDeck: ['BU_LS', 'BU_ZM', 'BU_TS'] }, { lab: ['BU_TS'] }], dice: [2, 2, 2, 2] });
    const ad = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: ad, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: ad }] });
    d.expectPrompt('chooseCard', 0);
    const zm = sc.ids[0]!.battleDeck[1]!;
    expect(d.prompt!.options).toEqual([zm, null]);
    d.do({ type: 'ChooseFromList', choice: zm });
    expect(d.state.players[0]!.battleDeck[0]).toBe(zm);
  });

  it('Mental Disrupter: Creatures and Cyborgs cannot attack', () => {
    const sc = scenario({ seats: [{ lab: ['BU_LS', 'BU_BM', 'BU_HB'], hand: ['PW_MD'], cus: { B: 1, P: 2 } }, {}] });
    const d = drive(sc);
    d.do({ type: 'PlayCard', uid: sc.ids[0]!.hand[0]! });
    d.do({ type: 'AdvancePhase' });
    expect(getLegalActions(d.state, 0)!.attack!.eligible).toEqual([sc.ids[0]!.lab[2]]);
  });

  it('Nomis Analyzer: with Cyber win the opponent reveals a Power card', () => {
    const sc = scenario({ at: 'battle', seats: [{ lab: ['BU_NA'] }, { lab: ['BU_LQ'], hand: ['PW_EH'] }], dice: [2, 2, 2, 2] });
    const na = sc.ids[0]!.lab[0]!;
    const d = drive(sc);
    d.do({ type: 'DeclareAttackers', attacks: [{ uid: na, target: 1 }] });
    d.do({ type: 'AssignBlockers', blocks: [{ blocker: sc.ids[1]!.lab[0]!, attacker: na }] });
    d.expectPrompt('chooseCard', 1);
    d.do({ type: 'ChooseFromList', choice: sc.ids[1]!.hand[0]! });
    expect(d.last('CardsRevealed').cards[0].cardId).toBe('PW_EH');
  });
});
