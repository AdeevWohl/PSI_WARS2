/**
 * v0.4 card set: keywords and card abilities (Lock-On, Calibrate, Protocol, Mutation,
 * Cannibalize, Reanimated, feeding, containment variants, activated abilities, new Powers).
 *
 * Everything here is data-driven: cards name an `effect` and a `trigger` in data/cards.json and
 * this module implements each effect once. Decisions use the generic `decide` prompt (token
 * options with labels) or `chooseCard`; every decision is validated by the engine.
 *
 * `info.scores` on a decide prompt is a public-information estimate of each option's value,
 * computed only from what every player can see, used by the computer players.
 */
import { ABILITIES, CU_TYPES, type Command, type Payment } from '@psi-wars/shared';
import { numericValue, rollSide } from './dice';
import { damageUnit } from './damage';
import { EFFECTS, removeFromBattle, type EffectImpl, type EffectTask } from './effects';
import {
  addMod, canUseAbilities, effectOf, hasEffect, hooks, isJammed, markUsed, permanentStrength, usedThisTurn,
} from './mods';
import { autoPayment, burnOnly, canAfford, eligibleDestroyTypes, pay, totalCost } from './payment';
import { shuffleInPlace } from './rng';
import { canHoldEquipment, fighterStrength, fighterUnits, isDisabled, unitHasAbility, unitStrength } from './stats';
import { card, defOf, emit, matchesFilter, moveCard, opponentsOf, player } from './state';
import { ask, push, pushSeq, register } from './tasks';
import { checkVictory, damageLab } from './victory';
import type { Ability, Attack, CardDef, Cost, Ctx, GameState, Prompt, Resolution, Seat, Task } from './types';

const ZERO: Cost = { G: 0, B: 0, R: 0, P: 0, W: 0 };
const cost = (c: Partial<Cost>): Cost => ({ ...ZERO, ...c });
const name = (s: GameState, uid: string) => defOf(s, uid).name;

// ---------------------------------------------------------------- decisions

export interface Opt {
  token: string;
  label: string;
  score?: number;
}

/** Ask a token decision. `none` = label of the decline option (omit for a forced choice). */
function decide(ctx: Ctx, seat: Seat, title: string, text: string, opts: Opt[], resume: Task, extra: Record<string, unknown> = {}, none?: { label: string; score?: number }): void {
  const { answer: _a, ...clean } = resume;
  ask(ctx, {
    seat, kind: 'decide', label: title,
    options: [...opts.map((o) => o.token), ...(none ? [null] : [])],
    info: {
      text,
      labels: Object.fromEntries(opts.map((o) => [o.token, o.label])),
      scores: Object.fromEntries(opts.map((o) => [o.token, o.score ?? 0])),
      noneLabel: none?.label ?? null,
      noneScore: none?.score ?? 0,
      ...extra,
    },
    resume: clean as Task,
  });
}

/** undefined = not answered yet; null = declined. */
function answerOf(t: Task): string | null | undefined {
  const a = t.answer as Command | undefined;
  if (!a) return undefined;
  if (a.type === 'ChooseFromList') return a.choice;
  if (a.type === 'UseAbility') return a.use ? 'yes' : null;
  return null;
}

function strip(t: Task): Task {
  const { answer: _a, ...rest } = t;
  return rest as Task;
}

/** Pay a fixed ability cost with the suggested (option-preserving) payment. */
function payAbility(ctx: Ctx, seat: Seat, c: Cost, forUid: string, payment?: Payment): boolean {
  if (!c || (c.G + c.B + c.R + c.P + c.W + (c.A ?? 0) + (c.choice?.length ?? 0)) === 0) return true;
  const p = payment ?? autoPayment(ctx.s, seat, c);
  if (!p) return false;
  pay(ctx, seat, c, p, forUid);
  return true;
}

export function costOfParam(x: unknown): Cost {
  return x && typeof x === 'object' ? cost(x as Partial<Cost>) : ZERO;
}

// ---------------------------------------------------------------- battle helpers

export function currentAttack(s: GameState): Attack | null {
  const id = s.battle?.current?.attackId;
  return id ? s.battle!.attacks.find((a) => a.id === id) ?? null : null;
}

function sideOf(atk: Attack, uid: string): 'att' | 'def' | null {
  if (atk.units.includes(uid)) return 'att';
  if (atk.blockers.includes(uid)) return 'def';
  return null;
}

function engagementOf(s: GameState, uid: string): Attack | null {
  return (s.battle?.attacks ?? []).find((a) => a.status === 'pending' && (a.units.includes(uid) || a.blockers.includes(uid))) ?? null;
}

/** Rough public "how good is this side" used to score options for the AI. */
function edge(s: GameState, mine: string[], theirs: string[], mineAttacking: boolean): number {
  const a = (ab: Ability) => fighterStrength(s, mine, ab, mineAttacking) - fighterStrength(s, theirs, ab, !mineAttacking);
  return a('physical') * 1.5 + a('cyber') * 0.6 + a('psionic') * 0.6;
}

// ---------------------------------------------------------------- ability rolls + Lock-On

/** Outcome of an ability roll face, as stat changes (X value included) — used to apply and to score Lock-On. */
function rollOutcome(s: GameState, uid: string, purpose: string, side: number): Partial<Record<Ability, number>> {
  const out: Partial<Record<Ability, number>> = {};
  const add = (ab: Ability, n: number) => (out[ab] = (out[ab] ?? 0) + n);
  const v = numericValue(s, side);
  if (purpose === 'x') {
    const e = defOf(s, uid).effects.find((x) => x.trigger === 'RollX');
    if (!e) return out;
    add(e.params.stat as Ability, v);
    switch (e.params.rider) {
      case 'lowPhysical': if (v <= 2) add('physical', 1); break;
      case 'face6Physical': if (side === 6) add('physical', 1); break;
      case 'apex': if (v <= 2) add('physical', 2); else if (v >= 4) add('psionic', 1); break;
    }
  } else if (purpose === 'modify') {
    const e = defOf(s, uid).effects.find((x) => x.trigger === 'ModifyRoll');
    if (e) add((e.params.stat ?? 'physical') as Ability, Number(e.params.bySide?.[String(side)] ?? 0));
  }
  return out;
}

const outcomeValue = (o: Partial<Record<Ability, number>>) => (o.physical ?? 0) * 1.5 + (o.cyber ?? 0) + (o.psionic ?? 0);

interface Locker { uid: string; cost: Cost }

/** Units that may Lock-On the ability roll of `roller` in its blocked engagement. */
export function lockOnCandidates(s: GameState, roller: string, attackId: string | null): Locker[] {
  if (!attackId || !s.battle?.current || s.battle.current.attackId !== attackId) return [];
  const atk = s.battle.attacks.find((a) => a.id === attackId);
  if (!atk || atk.blockers.length === 0) return [];
  const side = sideOf(atk, roller);
  if (!side) return [];
  const used = s.battle.current.lockUsed ?? [];
  const opposing = side === 'att' ? atk.blockers : atk.units;
  const out: Locker[] = [];
  for (const u of opposing) {
    if (used.includes(u) || !canUseAbilities(s, u) || isJammed(s, u)) continue;
    let c: Cost | null = null;
    const e = effectOf(s, u, 'LockOn');
    if (e) c = costOfParam(e.params.cost);
    const pe = defOf(s, u).effects.find((x) => x.effect === 'ProtocolLockOn');
    if (!c && pe && card(s, u).protocol === pe.params.mode) c = costOfParam(pe.params.cost);
    if (!c) continue;
    if (!canAfford(s, card(s, u).owner, c)) continue;
    out.push({ uid: u, cost: c });
  }
  return out;
}

function canRerollX(s: GameState, uid: string): boolean {
  const e = defOf(s, uid).effects.find((x) => x.trigger === 'RollX');
  if (!e) return false;
  const p = card(s, uid).stackPartner;
  if (!p) return false;
  if (e.params.robotReroll && defOf(s, p).unitType === 'Robot') return true; // Urilian Overlord
  // Neural Interface: its Creature partner's X roll may be rerolled once.
  if (hasEffect(s, p, 'PartnerReroll') && defOf(s, uid).unitType === 'Creature' && canUseAbilities(s, p)) return true;
  return false;
}

/** Ability-roll task: Zomber's "set X to 3", Lock-On, the roll, an optional reroll, then the result. */
register('abilityRoll', (ctx, t) => {
  const s = ctx.s;
  const c = s.cards[t.uid];
  if (!c || c.zone !== 'lab') return;
  if (t.purpose === 'x' && c.xValue !== null) return;
  const ans = answerOf(t);
  const phase: string = t.phase ?? 'pre';
  const e = defOf(s, t.uid).effects.find((x) => x.trigger === 'RollX');
  if (phase === 'pre') {
    const p = c.stackPartner;
    if (t.purpose === 'x' && e?.params.robotSetX3 && p && defOf(s, p).unitType === 'Robot') {
      if (ans === undefined) {
        return decide(ctx, c.owner, `${name(s, t.uid)}: set X to 3?`, 'Stacked with a Robot: you may set X to 3 instead of making its ability roll.', [
          { token: 'set3', label: 'Set X to 3', score: 3 - 2.8 },
          { token: 'roll', label: 'Roll the ability die', score: 0 },
        ], t, { uid: t.uid });
      }
      if (ans === 'set3') {
        c.xValue = 3;
        emit(ctx, { type: 'XRolled', uid: t.uid, cardId: c.cardId, stat: e.params.stat, side: null, value: 3, set: true });
        return;
      }
    }
    push(ctx, { ...strip(t), phase: 'lock' });
    return;
  }
  if (phase === 'lock') {
    const lockers = lockOnCandidates(s, t.uid, t.attackId ?? null);
    if (lockers.length && ans === undefined && !t.asked) {
      const lk = lockers[0]!;
      const owner = card(s, lk.uid).owner;
      const opts: Opt[] = [1, 2, 3, 4, 5, 6].map((f) => ({ token: `face:${f}`, label: `Face ${f}${f === 6 ? ' (numeric 4)' : ''}`, score: -outcomeValue(rollOutcome(s, t.uid, t.purpose, f)) }));
      const avg = -[1, 2, 3, 4, 5, 6].reduce((a, f) => a + outcomeValue(rollOutcome(s, t.uid, t.purpose, f)), 0) / 6;
      return decide(ctx, owner, `Lock-On: ${name(s, lk.uid)}`,
        `${name(s, t.uid)} is about to make an ability roll (${t.purpose === 'x' ? 'its X' : 'its printed ability'}). Pay ${costLabel(lk.cost)} to choose the raw face instead.`,
        opts, { ...strip(t), asked: true }, { uid: t.uid, locker: lk.uid, cost: lk.cost, lockOn: true }, { label: 'Let it roll', score: avg + 0.8 });
    }
    let side: number;
    let locked = false;
    if (typeof ans === 'string' && ans.startsWith('face:') && lockers.length) {
      const lk = lockers[0]!;
      side = Number(ans.slice(5));
      payAbility(ctx, card(s, lk.uid).owner, lk.cost, lk.uid);
      s.battle!.current!.lockUsed = [...(s.battle!.current!.lockUsed ?? []), lk.uid];
      locked = true;
      emit(ctx, { type: 'LockOn', uid: lk.uid, cardId: card(s, lk.uid).cardId, seat: card(s, lk.uid).owner, target: t.uid, targetCardId: c.cardId, side });
    } else side = rollSide(ctx);
    push(ctx, { k: 'abilityRoll', uid: t.uid, purpose: t.purpose, attackId: t.attackId ?? null, phase: 'reroll', side, locked });
    return;
  }
  // phase 'reroll'
  let side: number = t.side;
  if (!t.locked && !t.rerolled && canRerollX(s, t.uid) && t.purpose === 'x') {
    if (ans === undefined) {
      emit(ctx, { type: 'AbilityRollPending', uid: t.uid, cardId: c.cardId, side, value: numericValue(s, side) });
      return decide(ctx, c.owner, `${name(s, t.uid)}: reroll X?`, `It rolled ${numericValue(s, side)} (face ${side}). You may reroll once and keep the new result.`, [
        { token: 'keep', label: `Keep ${numericValue(s, side)}`, score: numericValue(s, side) - 2.8 },
        { token: 'reroll', label: 'Reroll', score: 0 },
      ], t, { uid: t.uid });
    }
    if (ans === 'reroll') side = rollSide(ctx);
  }
  finishAbilityRoll(ctx, t.uid, t.purpose, side, !!t.locked);
});

function finishAbilityRoll(ctx: Ctx, uid: string, purpose: string, side: number, locked: boolean): void {
  const s = ctx.s;
  const c = card(s, uid);
  const v = numericValue(s, side);
  if (purpose === 'x') {
    const e = defOf(s, uid).effects.find((x) => x.trigger === 'RollX')!;
    c.xValue = v;
    emit(ctx, { type: 'XRolled', uid, cardId: c.cardId, stat: e.params.stat, side, value: v, locked });
    const out = rollOutcome(s, uid, 'x', side);
    for (const ab of ABILITIES) {
      const extra = (out[ab] ?? 0) - (ab === e.params.stat ? v : 0);
      if (extra) addMod(ctx, uid, ab, extra, 'temp', uid, `${defOf(s, uid).name} ability roll`);
    }
    if (e.params.rider === 'seer') push(ctx, { k: 'seerOffer', uid });
  } else {
    const e = defOf(s, uid).effects.find((x) => x.trigger === 'ModifyRoll');
    if (!e) return;
    const stat = (e.params.stat ?? 'physical') as Ability;
    const delta = Number(e.params.bySide?.[String(side)] ?? 0);
    addMod(ctx, uid, stat, delta, 'temp', uid, `${defOf(s, uid).name} ability roll`);
    emit(ctx, { type: 'RollModified', uid, cardId: c.cardId, stat, side, value: v, delta, locked });
  }
}

/** Garilian Seer: after its X roll, may discard a Battle card to give another unit +1 Physical. */
register('seerOffer', (ctx, t) => {
  const s = ctx.s;
  const c = s.cards[t.uid];
  if (!c || c.zone !== 'lab') return;
  const seat = c.owner;
  const hand = player(s, seat).hand.filter((u) => defOf(s, u).deck === 'battle');
  const others = player(s, seat).lab.filter((u) => u !== t.uid);
  if (!hand.length || !others.length) return;
  const ans = answerOf(t);
  if (ans === undefined) {
    return decide(ctx, seat, `${name(s, t.uid)}: discard for +1 Physical?`, 'Discard a Battle card from your hand to give another unit under your control +1 Physical until end of turn.',
      others.map((u) => ({ token: u, label: name(s, u), score: inEngagementValue(s, u) - 1.5 })), t, { uid: t.uid }, { label: 'No' });
  }
  if (!ans || !others.includes(ans)) return;
  push(ctx, { k: 'discardFromHand', seat, then: { k: 'modTask', uid: ans, stat: 'physical', amount: 1, kind: 'temp', source: t.uid, label: 'Garilian Seer' } });
});

function inEngagementValue(s: GameState, uid: string): number {
  const atk = engagementOf(s, uid);
  return atk && atk.blockers.length ? 2 : 0.3;
}

register('modTask', (ctx, t) => {
  if (ctx.s.cards[t.uid]?.zone !== 'lab') return;
  addMod(ctx, t.uid, t.stat, t.amount, t.kind, t.source, t.label);
});

/** Discard one Battle card of your choice from hand, then run `then`. */
register('discardFromHand', (ctx, t) => {
  const s = ctx.s;
  const hand = player(s, t.seat).hand.filter((u) => defOf(s, u).deck === 'battle');
  const a = t.answer as Command | undefined;
  if (!a) {
    if (!hand.length) return;
    ask(ctx, { seat: t.seat, kind: 'chooseCard', label: 'Choose a Battle card to discard', options: hand, info: { zone: 'hand', discard: true, pickLow: true }, resume: strip(t) });
    return;
  }
  const choice = a.type === 'ChooseFromList' ? a.choice : null;
  if (!choice || !hand.includes(choice)) return;
  moveCard(ctx, choice, 'discard');
  emit(ctx, { type: 'CardDiscarded', seat: t.seat, uid: choice, cardId: card(s, choice).cardId, reason: 'cost' });
  if (t.then) push(ctx, t.then);
});

// ---------------------------------------------------------------- before-dice decisions

interface BeforeOpt {
  key: string;
  seat: Seat;
  uid: string;
  title: string;
  text: string;
  opts: Opt[];
  noneScore?: number;
}

const EV_PHYS = (s: GameState) => {
  const t = s.rules.dice[s.config.diceVariant].physical;
  return [1, 2, 3, 4, 5, 6].reduce((a, f) => a + t[String(f)]!.bonus, 0) / 6;
};

/** Probability-ish score for replacing a die with a fixed +2: positive when reliability helps. */
function calibrateScore(s: GameState, atk: Attack, side: 'att' | 'def', die: Ability): number {
  const mine = side === 'att' ? atk.units : atk.blockers;
  const theirs = side === 'att' ? atk.blockers : atk.units;
  const t = s.rules.dice[s.config.diceVariant][die];
  const my = fighterStrength(s, mine, die, side === 'att');
  const op = fighterStrength(s, theirs, die, side !== 'att');
  const faces = [1, 2, 3, 4, 5, 6].map((f) => t[String(f)]!.bonus);
  let rollWin = 0;
  let calWin = 0;
  for (const a of faces) for (const b of faces) {
    if (my + a > op + b) rollWin++;
    if (my + 2 > op + b) calWin++;
  }
  return (calWin - rollWin) / 36 * 4;
}

export function beforeDiceOptions(s: GameState, atk: Attack, r: Resolution): BeforeOpt[] {
  const out: BeforeOpt[] = [];
  const decided = r.decided ?? {};
  const all = [...atk.units, ...atk.blockers];
  const isAtt = (u: string) => atk.units.includes(u);
  const sideUnits = (u: string) => (isAtt(u) ? atk.units : atk.blockers);
  const otherUnits = (u: string) => (isAtt(u) ? atk.blockers : atk.units);
  const add = (o: BeforeOpt) => { if (!(o.key in decided)) out.push(o); };
  for (const u of all) {
    if (!canUseAbilities(s, u)) continue;
    const seat = card(s, u).owner;
    const d = defOf(s, u);
    for (const e of d.effects) {
      if (e.trigger !== 'BeforeDice') continue;
      const ed = edge(s, sideUnits(u), otherUnits(u), isAtt(u));
      if (e.effect === 'SelfShift' && unitStrength(s, u, e.params.from, isAtt(u)) >= 1) {
        add({ key: `shift:${u}`, seat, uid: u, title: d.name, text: d.text, opts: [{ token: 'yes', label: `−1 ${e.params.from}, +1 ${e.params.to}`, score: fighterStrength(s, otherUnits(u), e.params.from, !isAtt(u)) > 0 ? 0.2 : 1 }] });
      }
      if (e.effect === 'PayBoost' && !isJammed(s, u) && !usedThisTurn(s, `boost:${u}`) && canAfford(s, seat, costOfParam(e.params.cost))) {
        add({ key: `boost:${u}`, seat, uid: u, title: d.name, text: d.text, opts: [{ token: 'yes', label: `Pay ${costLabel(costOfParam(e.params.cost))}: +1 Physical`, score: ed < 2 && ed > -4 ? 1.2 : 0.1 }] });
      }
      if (e.effect === 'MorphicShift') {
        const o: Opt[] = [];
        if (unitStrength(s, u, 'psionic', isAtt(u)) >= 1) o.push({ token: 'toPhys', label: '1 Psionic → Physical', score: 0.8 });
        if (unitStrength(s, u, 'physical', isAtt(u)) >= 2) o.push({ token: 'toPsi', label: '1 Physical → Psionic', score: -0.5 });
        if (o.length) add({ key: `morph:${u}`, seat, uid: u, title: d.name, text: d.text, opts: o });
      }
    }
    // Psi Bolster: swap +1 Psionic for +1 Physical this turn.
    const eq = card(s, u).equipment;
    if (eq && hasEffect(s, eq, 'BolsterSwap') && !usedThisTurn(s, `swap:${eq}`)) {
      add({ key: `bolster:${u}`, seat, uid: u, title: defOf(s, eq).name, text: defOf(s, eq).text, opts: [{ token: 'yes', label: 'Use +1 Physical instead', score: 0.6 }] });
    }
  }
  // Nomis Analyzer: once per your Battle phase, G1: a Robot under your control in this battle +1 Physical.
  const attacker = s.battle!.attacker;
  for (const n of player(s, attacker).lab) {
    const e = effectOf(s, n, 'NomisBoost');
    if (!e || !canUseAbilities(s, n) || isJammed(s, n) || usedThisTurn(s, `nomis:${n}`)) continue;
    const c = costOfParam(e.params.cost);
    if (!canAfford(s, attacker, c)) continue;
    const robots = atk.units.filter((u) => defOf(s, u).unitType === 'Robot');
    if (!robots.length || atk.seat !== attacker) continue;
    add({ key: `nomis:${n}`, seat: attacker, uid: n, title: name(s, n), text: defOf(s, n).text, opts: robots.map((u) => ({ token: u, label: `${name(s, u)} +1 Physical`, score: 1 })) });
  }
  // Calibration, one decision per side and die.
  for (const side of ['att', 'def'] as const) {
    const units = side === 'att' ? atk.units : atk.blockers;
    if (!units.length) continue;
    const seat = card(s, units[0]!).owner;
    const sources: { die: Ability; uid: string; cost?: Cost; key?: string }[] = [];
    for (const u of units) {
      if (!canUseAbilities(s, u)) continue;
      const cs = effectOf(s, u, 'CalibrateSelf');
      if (cs && (!cs.params.whenDefending || side === 'def')) sources.push({ die: cs.params.die, uid: u });
      const pg = defOf(s, u).effects.find((x) => x.effect === 'ProtocolCalibrate');
      if (pg && card(s, u).protocol === pg.params.mode && (!pg.params.whenDefending || side === 'def')) sources.push({ die: pg.params.die, uid: u });
      if (card(s, u).flags?.convergeCal) sources.push({ die: 'physical', uid: u });
    }
    // Davileam Precision: one Robot under your control may Calibrate its Physical die each Battle phase.
    for (const dv of player(s, seat).lab) {
      const pe = defOf(s, dv).effects.find((x) => x.effect === 'ProtocolPrecision');
      if (!pe || card(s, dv).protocol !== pe.params.mode || !canUseAbilities(s, dv) || usedThisTurn(s, `precision:${seat}`)) continue;
      if (units.some((u) => defOf(s, u).unitType === 'Robot')) sources.push({ die: 'physical', uid: dv, key: `precision:${seat}` });
    }
    // Targeting Node: pay G1, another Robot under your control in this battle Calibrates Cyber.
    for (const tn of player(s, seat).lab) {
      const te = effectOf(s, tn, 'TargetingNode');
      if (!te || !canUseAbilities(s, tn) || isJammed(s, tn) || usedThisTurn(s, `node:${tn}`)) continue;
      if (!units.some((u) => u !== tn && defOf(s, u).unitType === 'Robot')) continue;
      const c = costOfParam(te.params.cost);
      if (canAfford(s, seat, c)) sources.push({ die: 'cyber', uid: tn, cost: c, key: `node:${tn}` });
    }
    for (const die of ['cyber', 'psionic', 'physical'] as const) {
      const src = sources.find((x) => x.die === die);
      if (!src) continue;
      if (die !== 'physical' && (fighterStrength(s, units, die, side === 'att') < 1 || fighterStrength(s, side === 'att' ? atk.blockers : atk.units, die, side !== 'att') < 1)) continue;
      add({
        key: `cal:${side}:${die}`, seat, uid: src.uid, title: `Calibrate (${name(s, src.uid)})`,
        text: `Replace your ${die} die with a fixed +2 (no icons) for this battle${src.cost ? `, paying ${costLabel(src.cost)}` : ''}. Decide before rolling.`,
        opts: [{ token: 'yes', label: `Calibrate ${die} (+2)`, score: calibrateScore(s, atk, side, die) - (src.cost ? 0.3 : 0) }],
      });
    }
  }
  return out;
}

/** Ask the next before-dice decision. Returns true if it asked. */
export function beforeDiceStep(ctx: Ctx, atk: Attack, r: Resolution, self: Task): boolean {
  const s = ctx.s;
  const ans = answerOf(self);
  r.decided ??= {};
  if (self.key && ans !== undefined) {
    const opt = beforeDiceOptions(s, atk, r).find((o) => o.key === self.key);
    r.decided[self.key] = ans;
    if (opt && ans) applyBefore(ctx, atk, r, opt, ans);
  }
  const next = beforeDiceOptions(s, atk, r)[0];
  if (!next) return false;
  decide(ctx, next.seat, next.title, next.text, next.opts, { ...strip(self), key: next.key }, { uid: next.uid }, { label: 'No', score: next.noneScore ?? 0 });
  return true;
}

function applyBefore(ctx: Ctx, atk: Attack, r: Resolution, o: BeforeOpt, ans: string): void {
  const s = ctx.s;
  const [kind, a, b] = o.key.split(':');
  const label = name(s, o.uid);
  switch (kind) {
    case 'shift': {
      const e = effectOf(s, o.uid, 'SelfShift')!;
      addMod(ctx, o.uid, e.params.from, -1, 'temp', o.uid, label);
      addMod(ctx, o.uid, e.params.to, 1, 'temp', o.uid, label);
      break;
    }
    case 'boost': {
      const e = effectOf(s, o.uid, 'PayBoost')!;
      if (!payAbility(ctx, o.seat, costOfParam(e.params.cost), o.uid)) return;
      markUsed(s, `boost:${o.uid}`, o.uid);
      addMod(ctx, o.uid, 'physical', 1, 'battle', o.uid, label);
      break;
    }
    case 'morph':
      if (ans === 'toPhys') { addMod(ctx, o.uid, 'psionic', -1, 'temp', o.uid, label); addMod(ctx, o.uid, 'physical', 1, 'temp', o.uid, label); }
      if (ans === 'toPsi') { addMod(ctx, o.uid, 'physical', -1, 'temp', o.uid, label); addMod(ctx, o.uid, 'psionic', 1, 'temp', o.uid, label); }
      break;
    case 'bolster': {
      const eq = card(s, o.uid).equipment;
      if (eq) { markUsed(s, `swap:${eq}`, eq); emit(ctx, { type: 'StatModified', uid: o.uid, cardId: card(s, o.uid).cardId, stat: 'physical', amount: 1, kind: 'temp', source: eq, label: 'Psi Bolster (Psionic bonus swapped to Physical)' }); }
      break;
    }
    case 'nomis': {
      const e = effectOf(s, o.uid, 'NomisBoost')!;
      if (!atk.units.includes(ans) || !payAbility(ctx, o.seat, costOfParam(e.params.cost), o.uid)) return;
      markUsed(s, `nomis:${o.uid}`, o.uid);
      addMod(ctx, ans, 'physical', 1, 'battle', o.uid, label);
      break;
    }
    case 'cal': {
      const side = a as 'att' | 'def';
      const die = b as Ability;
      const te = effectOf(s, o.uid, 'TargetingNode');
      if (te && die === 'cyber') {
        if (!payAbility(ctx, o.seat, costOfParam(te.params.cost), o.uid)) return;
        markUsed(s, `node:${o.uid}`, o.uid);
      }
      if (defOf(s, o.uid).effects.some((x) => x.effect === 'ProtocolPrecision') && die === 'physical' && !(side === 'att' ? atk.units : atk.blockers).includes(o.uid)) markUsed(s, `precision:${o.seat}`, o.uid);
      r.calibrated = [...(r.calibrated ?? []), `${side}:${die}`];
      emit(ctx, { type: 'Calibrated', attackId: atk.id, side, die, uid: o.uid, cardId: card(s, o.uid).cardId });
      break;
    }
  }
}

// ---------------------------------------------------------------- declaration triggers

/** After attackers are declared: Trangarey Scythe width bonus, Hive Regent, Davileam Assault. */
export function afterAttackDeclared(ctx: Ctx): void {
  const s = ctx.s;
  const b = s.battle!;
  const seat = b.attacker;
  const attackingUnits = b.attacks.flatMap((a) => a.units);
  const tasks: Task[] = [];
  for (const u of attackingUnits) {
    const e = effectOf(s, u, 'WidthBonus');
    if (e && attackingUnits.filter((x) => x !== u).length >= Number(e.params.others ?? 2)) addMod(ctx, u, 'physical', 1, 'battle', u, name(s, u));
  }
  for (const u of player(s, seat).lab) {
    if (!canUseAbilities(s, u)) continue;
    const hr = effectOf(s, u, 'SwarmBoost');
    const creatures = attackingUnits.filter((x) => defOf(s, x).unitType === 'Creature');
    if (hr && creatures.length >= Number(hr.params.min ?? 3) && !usedThisTurn(s, `swarm:${u}`)) {
      markUsed(s, `swarm:${u}`, u);
      tasks.push({ k: 'chooseBoost', seat, source: u, candidates: creatures, left: 2, kind: 'temp' });
    }
    const pa = defOf(s, u).effects.find((x) => x.effect === 'ProtocolBoost' && x.params.when === 'attack');
    if (pa && card(s, u).protocol === pa.params.mode && !usedThisTurn(s, `assault:${seat}`)) {
      const robots = attackingUnits.filter((x) => defOf(s, x).unitType === 'Robot');
      if (robots.length) {
        markUsed(s, `assault:${seat}`, u);
        tasks.push({ k: 'chooseBoost', seat, source: u, candidates: robots, left: 2, kind: 'battle' });
      }
    }
  }
  if (tasks.length) pushSeq(ctx, tasks);
}

/** After blockers: "when blocked" abilities (Jingwa, Mind Leech) and Davileam Guard. */
register('afterBlockers', (ctx) => {
  const s = ctx.s;
  const b = s.battle!;
  const tasks: Task[] = [];
  for (const a of b.attacks) {
    if (a.status !== 'pending' || !a.blockers.length) continue;
    for (const u of a.units) {
      if (!canUseAbilities(s, u)) continue;
      if (hasEffect(s, u, 'BlockedTax')) tasks.push({ k: 'jingwa', uid: u, attackId: a.id });
      if (hasEffect(s, u, 'LeechShift') && unitStrength(s, u, 'psionic', true) >= 1) tasks.push({ k: 'leech', uid: u });
    }
  }
  const defenders = [...new Set(b.attacks.filter((a) => a.status === 'pending' && a.blockers.length).map((a) => a.target))];
  for (const seat of defenders) {
    const blockingRobots = b.attacks.filter((a) => a.target === seat).flatMap((a) => a.blockers).filter((u) => defOf(s, u).unitType === 'Robot');
    if (!blockingRobots.length) continue;
    for (const u of player(s, seat).lab) {
      const pg = defOf(s, u).effects.find((x) => x.effect === 'ProtocolBoost' && x.params.when === 'defend');
      if (pg && card(s, u).protocol === pg.params.mode && canUseAbilities(s, u) && !usedThisTurn(s, `guard:${seat}`)) {
        markUsed(s, `guard:${seat}`, u);
        tasks.push({ k: 'chooseBoost', seat, source: u, candidates: blockingRobots, left: 2, kind: 'battle' });
      }
    }
  }
  if (tasks.length) pushSeq(ctx, tasks);
});

/** "Choose up to N of them: +1 Physical", asked one unit at a time. */
register('chooseBoost', (ctx, t) => {
  const s = ctx.s;
  const cands: string[] = (t.candidates as string[]).filter((u) => s.cards[u]?.zone === 'lab');
  if (!cands.length || t.left <= 0) return;
  const ans = answerOf(t);
  if (ans === undefined) {
    return decide(ctx, t.seat, `${name(s, t.source)}: +1 Physical`, `${defOf(s, t.source).text}\nChoose a unit (${t.left} left).`,
      cands.map((u) => ({ token: u, label: name(s, u), score: inEngagementValue(s, u) + 0.5 })), t, { uid: t.source }, { label: 'Done', score: 0 });
  }
  if (!ans || !cands.includes(ans)) return;
  addMod(ctx, ans, 'physical', 1, t.kind, t.source, name(s, t.source));
  push(ctx, { ...strip(t), candidates: cands.filter((u) => u !== ans), left: t.left - 1 });
});

register('jingwa', (ctx, t) => {
  const s = ctx.s;
  const atk = s.battle?.attacks.find((a) => a.id === t.attackId);
  if (!atk || atk.status !== 'pending' || !atk.blockers.length) return;
  const seat = atk.target;
  const powers = player(s, seat).hand.filter((u) => defOf(s, u).cardType === 'Power');
  const defender = [...atk.blockers].sort((a, b) => unitStrength(s, b, 'physical', false) - unitStrength(s, a, 'physical', false))[0]!;
  const ans = answerOf(t);
  const weaken = () => {
    if (unitStrength(s, defender, 'physical', false) > 1) addMod(ctx, defender, 'physical', -1, 'temp', t.uid, name(s, t.uid));
  };
  if (!powers.length) return weaken();
  if (ans === undefined) {
    return decide(ctx, seat, `${name(s, t.uid)} was blocked`, 'Choose: discard a Power card, or your defender loses 1 Physical until end of turn (minimum 1).', [
      { token: 'discard', label: 'Discard a Power card', score: -1.5 },
      { token: 'weaken', label: `${name(s, defender)} −1 Physical`, score: -1.2 },
    ], t, { uid: t.uid });
  }
  if (ans === 'discard') {
    ask(ctx, { seat, kind: 'chooseCard', label: 'Discard a Power card', options: powers, info: { zone: 'hand', discard: true, pickLow: true }, resume: { k: 'discardChosen', seat } });
    return;
  }
  weaken();
});

register('discardChosen', (ctx, t) => {
  const ch = answerOf(t);
  if (!ch || ctx.s.cards[ch]?.zone !== 'hand') return;
  moveCard(ctx, ch, 'discard');
  emit(ctx, { type: 'CardDiscarded', seat: t.seat, uid: ch, cardId: card(ctx.s, ch).cardId, reason: 'ability' });
});

register('leech', (ctx, t) => {
  const s = ctx.s;
  if (s.cards[t.uid]?.zone !== 'lab') return;
  const ans = answerOf(t);
  if (ans === undefined) {
    return decide(ctx, card(s, t.uid).owner, name(s, t.uid), defOf(s, t.uid).text, [{ token: 'yes', label: '−1 Psionic, +1 Physical', score: 0.7 }], t, { uid: t.uid }, { label: 'No' });
  }
  if (ans !== 'yes') return;
  addMod(ctx, t.uid, 'psionic', -1, 'temp', t.uid, name(s, t.uid));
  addMod(ctx, t.uid, 'physical', 1, 'temp', t.uid, name(s, t.uid));
});

// ---------------------------------------------------------------- after an engagement

/** Snapshot permanent strengths before dice (Marrow Parasite compares "immediately before the battle"). */
export function snapshotFighters(s: GameState, atk: Attack, r: Resolution): void {
  r.snap = {};
  for (const u of [...atk.units, ...atk.blockers]) r.snap[u] = { cyber: permanentStrength(s, u, 'cyber'), psionic: permanentStrength(s, u, 'psionic'), physical: permanentStrength(s, u, 'physical') };
}

/** Survive / kill triggers once a blocked engagement has resolved. */
export function afterEngagement(ctx: Ctx, t: Task): Task[] {
  const s = ctx.s;
  const tasks: Task[] = [];
  const b = s.battle;
  const snap = (t.snap ?? {}) as Record<string, { cyber: number; psionic: number; physical: number }>;
  for (const side of ['att', 'def'] as const) {
    const mine: string[] = side === 'att' ? t.attUnits : t.defUnits;
    const theirs: string[] = side === 'att' ? t.defUnits : t.attUnits;
    const other = side === 'att' ? 'def' : 'att';
    const killed: boolean = side === 'att' ? t.destroyed.def : t.destroyed.att;
    const lostPsi = t.winners.psionic === other;
    const lostCy = t.winners.cyber === other;
    const survivors = mine.filter((u) => s.cards[u]?.zone === 'lab');
    for (const u of survivors) {
      if (b) (b.survivors ??= {})[u] = lostPsi || !!b.survivors?.[u];
      if (hasEffect(s, u, 'MutateOnPsiLoss') && lostPsi) addMod(ctx, u, 'psionic', 1, 'mutation', u, `${name(s, u)} Mutation`);
      if (hasEffect(s, u, 'AlloyUpgrade') && (lostPsi || lostCy)) tasks.push({ k: 'alloy', uid: u, lostCy, lostPsi });
      if (hasEffect(s, u, 'MarrowMutation') && killed) {
        const me = snap[u];
        const victims = theirs.map((v) => snap[v]).filter((x): x is NonNullable<typeof x> => !!x);
        if (me && victims.length) {
          // A destroyed Stack offers a choice of member; the better reward is taken (Physical first).
          if (victims.some((v) => v.physical >= me.physical)) addMod(ctx, u, 'physical', 1, 'mutation', u, `${name(s, u)} Mutation`);
          else if (victims.some((v) => v.psionic > me.psionic)) addMod(ctx, u, 'psionic', 1, 'mutation', u, `${name(s, u)} Mutation`);
        }
      }
    }
    if (killed && survivors.length) {
      const seat = card(s, survivors[0]!).owner;
      const opp = card(s, theirs[0]!).owner;
      for (const u of survivors) {
        if (hasEffect(s, u, 'DrawOnKill') && !usedThisTurn(s, `kyler:${u}`)) { markUsed(s, `kyler:${u}`, u); tasks.push({ k: 'drawFor', seat, source: u }); }
        if (hasEffect(s, u, 'DepleteOpponentCU') && !usedThisTurn(s, `lodner:${u}`)) { markUsed(s, `lodner:${u}`, u); tasks.push({ k: 'depleteOpp', opp, source: u }); }
      }
      const foundress = survivors.find((u) => hasEffect(s, u, 'Feeding'));
      if (foundress && !usedThisTurn(s, `feed:${seat}`)) {
        markUsed(s, `feed:${seat}`, foundress);
        tasks.push({ k: 'feed', seat, source: foundress, victims: theirs.map((v) => card(s, v).cardId) });
      }
    }
  }
  return tasks;
}

register('drawFor', (ctx, t) => {
  const s = ctx.s;
  const p = player(s, t.seat);
  const uid = p.battleDeck[0];
  if (!uid) return;
  moveCard(ctx, uid, 'hand');
  emit(ctx, { type: 'CardDrawn', seat: t.seat, deck: 'battle', uid, cardId: card(s, uid).cardId, to: [t.seat], redacted: { type: 'CardDrawn', seat: t.seat, deck: 'battle' }, source: t.source });
});

register('depleteOpp', (ctx, t) => {
  const s = ctx.s;
  const ready = player(s, t.opp).cus.filter((u) => !card(s, u).depleted);
  if (!ready.length) return;
  const ans = answerOf(t);
  // The destroying player picks which ready CU of the opponent to deplete.
  const controller = card(s, t.source).owner;
  const kinds = [...new Set(ready.map((u) => card(s, u).cardId))];
  if (ans === undefined && kinds.length > 1) {
    return decide(ctx, controller, `${name(s, t.source)}: deplete an opposing Creation Unit`, 'Choose which ready Creation Unit of that opponent to deplete.',
      kinds.map((k) => ({ token: k, label: s.defs[k]!.name, score: ready.filter((u) => card(s, u).cardId === k).length })), t, { uid: t.source });
  }
  const pick = ready.find((u) => card(s, u).cardId === (ans ?? kinds[0])) ?? ready[0]!;
  card(s, pick).depleted = true;
  emit(ctx, { type: 'CUDepleted', seat: t.opp, uids: [pick], forUid: t.source });
});

register('alloy', (ctx, t) => {
  const s = ctx.s;
  const u = t.uid;
  const p = s.cards[u]?.stackPartner;
  if (!p || s.cards[p]?.zone !== 'lab') return;
  const seat = card(s, u).owner;
  const pt = defOf(s, p).unitType;
  const opts: Opt[] = [];
  if (t.lostCy && pt !== 'Creature' && canAfford(s, seat, cost({ P: 1 }))) opts.push({ token: 'cyber', label: 'Pay P1: partner +1 permanent Cyber', score: 1.5 });
  if (t.lostPsi && pt !== 'Robot' && canAfford(s, seat, cost({ R: 1 }))) opts.push({ token: 'psionic', label: 'Pay R1: partner +1 permanent Psionic', score: 1.5 });
  if (!opts.length) return;
  const ans = answerOf(t);
  if (ans === undefined) return decide(ctx, seat, name(s, u), defOf(s, u).text, opts, t, { uid: u }, { label: 'No' });
  if (ans !== 'cyber' && ans !== 'psionic') return;
  if (!payAbility(ctx, seat, ans === 'cyber' ? cost({ P: 1 }) : cost({ R: 1 }), u)) return;
  addMod(ctx, p, ans, 1, 'permanent', u, name(s, u));
});

/** Carrion Foundress: create a Creature from hand, total cost ≤ the victim's; burns still paid. */
register('feed', (ctx, t) => {
  const s = ctx.s;
  const seat: Seat = t.seat;
  const ans = answerOf(t);
  const victims: string[] = t.victims;
  if (!t.limit) {
    if (victims.length > 1 && ans === undefined) {
      return decide(ctx, seat, 'Carrion Foundress: choose one destroyed card', 'Its printed total cost is the limit for the Creature you may create.',
        victims.map((id, i) => ({ token: `${i}:${id}`, label: `${s.defs[id]!.name} (cost ${totalCost(s.defs[id]!.cost)})`, score: totalCost(s.defs[id]!.cost) })), t);
    }
    const id = ans ? ans.split(':')[1]! : victims[0]!;
    push(ctx, { k: 'feed', seat, source: t.source, victims, limit: totalCost(s.defs[id]!.cost), victim: id });
    return;
  }
  const options = player(s, seat).hand.filter((u) => {
    const d = defOf(s, u);
    return d.cardType === 'BattleUnit' && d.unitType === 'Creature' && totalCost(d.cost) <= t.limit && canAfford(s, seat, burnOnly(d.cost ?? ZERO));
  });
  emit(ctx, { type: 'FeedingTriggered', seat, source: t.source, victim: t.victim, limit: t.limit, options: options.length });
  if (!options.length) return;
  const a = t.answer as Command | undefined;
  if (!a) {
    ask(ctx, { seat, kind: 'chooseCard', label: `Carrion Foundress: create a Creature with total cost ≤ ${t.limit} (burn costs still paid)`, options: [...options, null], info: { zone: 'hand', optional: true, source: t.source }, resume: strip(t) });
    return;
  }
  const ch = a.type === 'ChooseFromList' ? a.choice : null;
  if (!ch || !options.includes(ch)) return;
  const d = defOf(s, ch);
  const burn = burnOnly(d.cost ?? ZERO);
  if (burn.W) pay(ctx, seat, burn, autoPayment(s, seat, burn)!, ch);
  createUnit(ctx, seat, ch, 'feeding');
});

/** Put a Battle Unit from hand (or elsewhere) into the Lab as a created unit, with its on-create triggers. */
export function createUnit(ctx: Ctx, seat: Seat, uid: string, via: string): void {
  const s = ctx.s;
  const c = card(s, uid);
  moveCard(ctx, uid, 'lab');
  c.depleted = false;
  c.enteredThisTurn = true;
  emit(ctx, { type: 'CardPlayed', seat, uid, cardId: c.cardId, cardType: 'BattleUnit', via });
  onCreate(ctx, seat, uid);
}

/** On-creation triggers (units): Protocol choice first, then printed "when created" abilities. */
export function onCreate(ctx: Ctx, seat: Seat, uid: string): void {
  const s = ctx.s;
  const d = defOf(s, uid);
  const tasks: Task[] = [];
  if (d.protocols) tasks.push({ k: 'protocolChoose', uid, initial: true });
  for (const e of d.effects) if (e.trigger === 'OnCreate') tasks.push({ k: 'effect', effect: e.effect, controller: seat, source: uid, params: e.params, opponent: opponentsOf(s, seat)[0] });
  if (tasks.length) pushSeq(ctx, tasks);
}

// ---------------------------------------------------------------- destruction

hooks.destroyed = (ctx, uid, cause) => {
  const s = ctx.s;
  const c = s.cards[uid];
  if (!c) return;
  const d = defOf(s, uid);
  const seat = c.owner;
  if (d.unitType === 'Creature' && s.phase === 'battle' && s.battle) {
    s.battle.creatureDied = [...new Set([...(s.battle.creatureDied ?? []), seat])];
  }
  const tasks: Task[] = [];
  if (hasEffect(s, uid, 'LarvaBurst')) tasks.push({ k: 'larva', seat, source: uid });
  if (d.unitType === 'Creature' && s.phase === 'battle' && s.turn.active === seat) {
    for (const w of player(s, seat).lab) {
      if (w === uid || !hasEffect(s, w, 'SprinterHunger') || usedThisTurn(s, `sprint:${w}`)) continue;
      markUsed(s, `sprint:${w}`, w);
      addMod(ctx, w, 'physical', 1, 'temp', uid, name(s, w));
    }
  }
  const eq = c.equipment;
  if (eq && hasEffect(s, eq, 'ReturnOnDestroy')) tasks.push({ k: 'membrane', seat, eq });
  emit(ctx, { type: 'DestroyCause', uid, cardId: c.cardId, cause });
  if (tasks.length) pushSeq(ctx, tasks);
};

register('larva', (ctx, t) => {
  const s = ctx.s;
  const opts = player(s, t.seat).lab.filter((u) => defOf(s, u).unitType === 'Creature' && !usedThisTurn(s, `larva:${u}`));
  if (!opts.length) return;
  const ans = answerOf(t);
  if (ans === undefined && opts.length > 1) {
    return decide(ctx, t.seat, 'Spore Larva', 'Choose another Creature under your control: it gains +1 Physical until end of turn.', opts.map((u) => ({ token: u, label: name(s, u), score: inEngagementValue(s, u) })), t);
  }
  const pick = ans && opts.includes(ans) ? ans : opts[0]!;
  markUsed(s, `larva:${pick}`, t.source);
  addMod(ctx, pick, 'physical', 1, 'temp', t.source, 'Spore Larva');
});

register('membrane', (ctx, t) => {
  const s = ctx.s;
  if (s.cards[t.eq]?.zone !== 'discard' || usedThisTurn(s, `membrane:${t.seat}`)) return;
  const ans = answerOf(t);
  if (ans === undefined) return decide(ctx, t.seat, 'Adaptive Membrane', 'Its bearer was destroyed: return this Equipment to your hand instead of discarding it?', [{ token: 'yes', label: 'Return to hand', score: 2 }], t, {}, { label: 'No' });
  if (ans !== 'yes') return;
  markUsed(s, `membrane:${t.seat}`, t.eq);
  moveCard(ctx, t.eq, 'hand');
  emit(ctx, { type: 'CardReturnedToHand', seat: t.seat, uid: t.eq, cardId: card(s, t.eq).cardId, from: 'discard' });
});

/** Cannibalize: destroy a Creature/Cyborg under your control as a cost. Returns its permanent Physical. */
export function cannibalize(ctx: Ctx, uid: string, source: string): number {
  const s = ctx.s;
  const c = card(s, uid);
  const phys = permanentStrength(s, uid, 'physical');
  removeFromBattle(ctx, uid, 'cannibalized');
  emit(ctx, { type: 'Cannibalized', uid, cardId: c.cardId, seat: c.owner, source, permanentPhysical: phys });
  hooks.destroyed?.(ctx, uid, 'cannibalize');
  moveCard(ctx, uid, 'discard');
  emit(ctx, { type: 'UnitDestroyed', uid, cardId: c.cardId, seat: c.owner, attackId: null, cause: 'cannibalize' });
  return phys;
}

export function cannibalTargets(s: GameState, seat: Seat, except: string | null): string[] {
  return player(s, seat).lab.filter((u) => u !== except && (defOf(s, u).unitType === 'Creature' || defOf(s, u).unitType === 'Cyborg'));
}

// ---------------------------------------------------------------- end of Battle phase

/** Siana Commander: after a phase in which another Creature of yours died, a blocked survivor mutates. */
export function endOfBattle(ctx: Ctx): void {
  const s = ctx.s;
  const b = s.battle;
  if (!b) return;
  const tasks: Task[] = [];
  for (const seat of b.creatureDied ?? []) {
    const siana = player(s, seat).lab.find((u) => hasEffect(s, u, 'SianaMutation') && canUseAbilities(s, u));
    if (!siana) continue;
    const opts = Object.keys(b.survivors ?? {}).filter((u) => s.cards[u]?.zone === 'lab' && card(s, u).owner === seat && defOf(s, u).unitType === 'Creature');
    if (opts.length) tasks.push({ k: 'siana', seat, source: siana, opts, lost: b.survivors });
  }
  if (tasks.length) pushSeq(ctx, tasks);
}

register('siana', (ctx, t) => {
  const s = ctx.s;
  const opts: string[] = t.opts.filter((u: string) => s.cards[u]?.zone === 'lab');
  if (!opts.length) return;
  const ans = answerOf(t);
  if (ans === undefined && opts.length > 1) {
    return decide(ctx, t.seat, 'Siana Commander: Mutation', 'Choose a Creature that survived a blocked battle this phase. It gains +1 permanent Psionic if it lost a Psionic battle, otherwise +1 permanent Physical.',
      opts.map((u) => ({ token: u, label: `${name(s, u)} (+1 ${t.lost?.[u] ? 'Psionic' : 'Physical'})`, score: t.lost?.[u] ? 1 : 1.5 })), t);
  }
  const pick = ans && opts.includes(ans) ? ans : opts[0]!;
  addMod(ctx, pick, t.lost?.[pick] ? 'psionic' : 'physical', 1, 'mutation', t.source, 'Siana Commander Mutation');
});

// ---------------------------------------------------------------- Stacks

/** A Stack just formed: clear old stack-duration mods, then Third I / Veeda / Convergence Engine. */
export function onStackFormed(ctx: Ctx, a: string, b: string): void {
  const s = ctx.s;
  for (const u of [a, b]) { delete card(s, u).stackMods; if (card(s, u).flags) delete card(s, u).flags!.convergeCal; }
  const cy = defOf(s, a).unitType === 'Cyborg' ? a : b;
  const partner = cy === a ? b : a;
  const seat = card(s, cy).owner;
  const tasks: Task[] = [];
  if (hasEffect(s, cy, 'StackChoice')) {
    const e = effectOf(s, cy, 'StackChoice')!;
    if (!e.params.partnerType || defOf(s, partner).unitType === e.params.partnerType) tasks.push({ k: 'stackChoice', seat, source: cy, target: cy, opts: e.params.opts });
  }
  const veeda = player(s, seat).lab.find((u) => hasEffect(s, u, 'VeedaStack') && canUseAbilities(s, u));
  if (veeda && !usedThisTurn(s, `veeda:${seat}`)) {
    markUsed(s, `veeda:${seat}`, veeda);
    const opts = ['cyber', 'psionic', ...(card(s, partner).equipment ? ['physical'] : [])];
    tasks.push({ k: 'stackChoice', seat, source: veeda, target: cy, opts });
  }
  if (hasEffect(s, cy, 'Convergence')) {
    const lab = player(s, seat).lab;
    if (lab.some((u) => defOf(s, u).unitType === 'Robot') && lab.some((u) => defOf(s, u).unitType === 'Creature')) tasks.push({ k: 'converge', seat, source: cy, partner });
  }
  if (tasks.length) pushSeq(ctx, tasks);
}

register('stackChoice', (ctx, t) => {
  const s = ctx.s;
  if (!s.cards[t.target]?.stackPartner) return;
  const ans = answerOf(t);
  if (ans === undefined) {
    return decide(ctx, t.seat, `${name(s, t.source)}: Stack bonus`, `${defOf(s, t.source).text}\nThe bonus lasts until the Stack separates.`,
      (t.opts as Ability[]).map((ab) => ({ token: ab, label: `+1 ${ab[0]!.toUpperCase()}${ab.slice(1)}`, score: ab === 'physical' ? 1.5 : 1 })), t, { uid: t.source });
  }
  if (!ans || !(t.opts as string[]).includes(ans)) return;
  addMod(ctx, t.target, ans as Ability, 1, 'stack', t.source, name(s, t.source));
});

register('converge', (ctx, t) => {
  const s = ctx.s;
  if (!s.cards[t.source]?.stackPartner) return;
  const ans = answerOf(t);
  if (ans === undefined) {
    return decide(ctx, t.seat, 'Convergence Engine', defOf(s, t.source).text, [
      { token: 'cal', label: 'May Calibrate its Physical die', score: 0.8 },
      { token: 'phys', label: `${name(s, t.partner)} +1 Physical until the Stack separates`, score: 1.2 },
    ], t, { uid: t.source });
  }
  if (ans === 'cal') (card(s, t.source).flags ??= {}).convergeCal = true;
  else addMod(ctx, t.partner, 'physical', 1, 'stack', t.source, 'Convergence Engine');
});

// ---------------------------------------------------------------- Protocol

export function protocolOptions(s: GameState, uid: string): Opt[] {
  const d = defOf(s, uid);
  const seat = card(s, uid).owner;
  const myLab = player(s, seat).lab;
  const robots = myLab.filter((u) => defOf(s, u).unitType === 'Robot').length;
  const oppThreat = opponentsOf(s, seat).reduce((a, o) => a + player(s, o).lab.reduce((x, u) => x + unitStrength(s, u, 'physical', true), 0), 0);
  const myPower = myLab.reduce((x, u) => x + unitStrength(s, u, 'physical', true), 0);
  const oppRolls = opponentsOf(s, seat).flatMap((o) => player(s, o).lab).filter((u) => defOf(s, u).effects.some((e) => e.trigger === 'RollX' || e.trigger === 'ModifyRoll')).length;
  return Object.entries(d.protocols ?? {}).map(([mode, text]) => {
    let score = 1;
    if (mode === 'Assault') score = 1 + (myPower > oppThreat ? 1.5 : 0) + robots * 0.2;
    if (mode === 'Guard') score = 1 + (oppThreat >= myPower ? 1.5 : 0) + robots * 0.2;
    if (mode === 'Precision') score = 1.4;
    if (mode === 'Scan') score = 0.8 + oppRolls * 0.7;
    return { token: mode, label: `${mode}: ${text}`, score };
  });
}

register('protocolChoose', (ctx, t) => {
  const s = ctx.s;
  const c = s.cards[t.uid];
  if (!c || c.zone !== 'lab') return;
  const ans = answerOf(t);
  const opts = protocolOptions(s, t.uid);
  if (ans === undefined) {
    const cur = c.protocol;
    return decide(ctx, c.owner, `${name(s, t.uid)}: choose a Protocol`, cur ? `Current mode: ${cur}. Keep it or switch; the choice is public and lasts until your next Creation phase.` : 'Choose its operating mode. The choice is public and lasts until your next Creation phase.',
      opts, t, { uid: t.uid, protocol: true, current: cur ?? null });
  }
  if (!ans || !defOf(s, t.uid).protocols?.[ans]) return;
  const changed = c.protocol !== ans;
  c.protocol = ans;
  emit(ctx, { type: 'ProtocolSet', uid: t.uid, cardId: c.cardId, seat: c.owner, mode: ans, text: defOf(s, t.uid).protocols![ans], changed });
});

/** Start of the owner's Creation phase: keep or switch each Protocol. */
register('protocolUpkeep', (ctx) => {
  const s = ctx.s;
  const seat = s.turn.active;
  const units = player(s, seat).lab.filter((u) => defOf(s, u).protocols);
  if (units.length) pushSeq(ctx, units.map((uid) => ({ k: 'protocolChoose', uid })));
});

// ---------------------------------------------------------------- activated abilities

export interface Activation {
  uid: string;
  ability: string;
  label: string;
  cost: Cost | null;
}

function relocations(s: GameState, seat: Seat, involving: string | null): { equip: string; to: string; cost: Cost }[] {
  const out: { equip: string; to: string; cost: Cost }[] = [];
  for (const u of player(s, seat).lab) {
    const eq = card(s, u).equipment;
    if (!eq) continue;
    const mc = defOf(s, eq).equip?.moveCost ?? ZERO;
    if (!canAfford(s, seat, mc)) continue;
    for (const to of player(s, seat).lab) {
      if (to === u || !canHoldEquipment(s, to, card(s, eq).cardId)) continue;
      if (involving && u !== involving && to !== involving) continue;
      out.push({ equip: eq, to, cost: mc });
    }
  }
  return out;
}
export { relocations };

export function activations(s: GameState, seat: Seat, p: Prompt): Activation[] {
  const out: Activation[] = [];
  const lab = player(s, seat).lab;
  if (p.kind === 'main') {
    for (const u of lab) {
      if (!canUseAbilities(s, u) || isJammed(s, u)) continue;
      const c = card(s, u);
      if (hasEffect(s, u, 'FabricatorDiscount') && !c.depleted && !usedThisTurn(s, `fab:${u}`)) out.push({ uid: u, ability: 'FabricatorDiscount', label: 'Deplete: next Equipment this turn costs 1 fewer P', cost: null });
      if (hasEffect(s, u, 'HarvestScrap') && !usedThisTurn(s, `harvest:${u}`) && player(s, seat).discard.some((x) => defOf(s, x).cardType === 'Equipment') && canAfford(s, seat, cost({ P: 1 }))) out.push({ uid: u, ability: 'HarvestScrap', label: 'Pay P1, remove an Equipment in your discard from the game: draw a Battle card', cost: cost({ P: 1 }) });
      if (hasEffect(s, u, 'SutureRelocate') && !usedThisTurn(s, `suture:${u}`) && relocations(s, seat, u).length) out.push({ uid: u, ability: 'SutureRelocate', label: 'Relocate an Equipment between this and another unit (pay its move cost): +1 Psionic', cost: null });
    }
  }
  if (p.kind === 'priority' && (p.info as any)?.point === 'battlePower' && s.battle) {
    const unblocked = s.battle.attacks.filter((a) => a.status === 'pending' && a.target === seat && a.blockers.length === 0 && a.units.length);
    for (const u of lab) {
      const e = effectOf(s, u, 'Intercept');
      if (!e || !unblocked.length || !canUseAbilities(s, u) || isJammed(s, u) || isDisabled(s, u) || usedThisTurn(s, `intercept:${u}`)) continue;
      if (card(s, u).stackPartner || engagementOf(s, u)) continue;
      if (!canAfford(s, seat, costOfParam(e.params.cost))) continue;
      out.push({ uid: u, ability: 'Intercept', label: `Pay ${costLabel(costOfParam(e.params.cost))}: defend against an unblocked attacker`, cost: costOfParam(e.params.cost) });
    }
  }
  return out;
}

export function performActivate(ctx: Ctx, seat: Seat, cmd: Extract<Command, { type: 'Activate' }>): void {
  const s = ctx.s;
  const u = cmd.uid;
  emit(ctx, { type: 'AbilityActivated', seat, uid: u, cardId: card(s, u).cardId, ability: cmd.ability });
  switch (cmd.ability) {
    case 'FabricatorDiscount':
      card(s, u).depleted = true;
      markUsed(s, `fab:${u}`, u);
      s.turnEffects.push({ kind: 'equipDiscount', source: u, seat });
      break;
    case 'HarvestScrap':
      payAbility(ctx, seat, cost({ P: 1 }), u, cmd.payment);
      markUsed(s, `harvest:${u}`, u);
      push(ctx, { k: 'harvest', seat, source: u });
      break;
    case 'SutureRelocate':
      markUsed(s, `suture:${u}`, u);
      push(ctx, { k: 'relocateChoice', seat, source: u, involving: u, then: { k: 'modTask', uid: u, stat: 'psionic', amount: 1, kind: 'temp', source: u, label: 'Suture Architect' } });
      break;
    case 'Intercept': {
      const e = effectOf(s, u, 'Intercept')!;
      payAbility(ctx, seat, costOfParam(e.params.cost), u, cmd.payment);
      markUsed(s, `intercept:${u}`, u);
      push(ctx, { k: 'intercept', seat, uid: u });
      break;
    }
  }
}

register('harvest', (ctx, t) => {
  const s = ctx.s;
  const opts = player(s, t.seat).discard.filter((x) => defOf(s, x).cardType === 'Equipment');
  const a = t.answer as Command | undefined;
  if (!a) {
    if (!opts.length) return;
    ask(ctx, { seat: t.seat, kind: 'chooseCard', label: 'Scrap Harvester: remove an Equipment in your discard from the game', options: opts, info: { zone: 'discard', pickLow: true }, resume: strip(t) });
    return;
  }
  const ch = a.type === 'ChooseFromList' ? a.choice : null;
  if (!ch || !opts.includes(ch)) return;
  moveCard(ctx, ch, 'removed');
  emit(ctx, { type: 'CardRemoved', seat: t.seat, uid: ch, cardId: card(s, ch).cardId, source: t.source });
  push(ctx, { k: 'drawFor', seat: t.seat, source: t.source });
});

register('intercept', (ctx, t) => {
  const s = ctx.s;
  const b = s.battle;
  if (!b || s.cards[t.uid]?.zone !== 'lab') return;
  const opts = b.attacks.filter((a) => a.status === 'pending' && a.target === t.seat && !a.blockers.length && a.units.length);
  if (!opts.length) return;
  const ans = answerOf(t);
  if (ans === undefined && opts.length > 1) {
    return decide(ctx, t.seat, `${name(s, t.uid)}: intercept`, 'Choose the unblocked attacker to defend against.', opts.map((a) => ({ token: a.id, label: name(s, a.id), score: fighterStrength(s, a.units, 'physical', true) })), t, { uid: t.uid });
  }
  const atk = opts.find((a) => a.id === ans) ?? opts[0]!;
  atk.blockers = fighterUnits(s, t.uid);
  emit(ctx, { type: 'BlockersAssigned', seat: t.seat, blocks: [{ blocker: t.uid, attacker: atk.id, units: atk.blockers }], intercept: true });
});

/** Relocate one Equipment (paying its move cost), then run `then` if something moved. */
register('relocateChoice', (ctx, t) => {
  const s = ctx.s;
  const moves = relocations(s, t.seat, t.involving ?? null);
  if (!moves.length) return;
  const ans = answerOf(t);
  if (ans === undefined) {
    return decide(ctx, t.seat, `${name(s, t.source)}: relocate Equipment`, 'Move one Equipment to another legal unit under your control, paying its Relocate cost.',
      moves.map((m) => ({ token: `${m.equip}>${m.to}`, label: `${name(s, m.equip)} → ${name(s, m.to)}${totalCost(m.cost) ? ` (${costLabel(m.cost)})` : ''}`, score: unitStrength(s, m.to, 'physical', true) - unitStrength(s, card(s, m.equip).attachedTo!, 'physical', true) })), t, { uid: t.source }, { label: "Don't move", score: 0.5 });
  }
  if (!ans) return;
  const [eq, to] = ans.split('>');
  const m = moves.find((x) => x.equip === eq && x.to === to);
  if (!m) return;
  relocate(ctx, t.seat, m.equip, m.to, m.cost);
  if (t.then) push(ctx, t.then);
});

export function relocate(ctx: Ctx, seat: Seat, equip: string, to: string, mc: Cost, payment?: Payment): void {
  const s = ctx.s;
  if (totalCost(mc)) payAbility(ctx, seat, mc, equip, payment);
  const e = card(s, equip);
  const from = e.attachedTo!;
  card(s, from).equipment = null;
  e.attachedTo = to;
  card(s, to).equipment = equip;
  emit(ctx, { type: 'EquipmentMoved', seat, uid: equip, cardId: e.cardId, fromUnit: from, toUnit: to, paid: totalCost(mc) > 0 });
}

// ---------------------------------------------------------------- costs helpers

export function costLabel(c: Cost): string {
  const parts: string[] = [];
  for (const t of CU_TYPES) if (c[t]) parts.push(`${t}${c[t]}`);
  if (c.A) parts.push(`Any ${c.A}`);
  for (const ch of c.choice ?? []) parts.push(ch.join('/'));
  if (c.W) parts.push(`Burn ${c.burnPool && c.burnPool.length < 4 ? c.burnPool.join('/') + ' ' : ''}${c.W}`);
  for (const b of c.burns ?? []) parts.push(`Burn ${b.length < 4 ? b.join('/') + ' ' : ''}1`);
  return parts.join(' + ') || 'free';
}

/** The Equipment discount from Fabricator Drone. */
export function equipmentDiscount(s: GameState, seat: Seat): boolean {
  return s.turnEffects.some((t) => t.kind === 'equipDiscount' && t.seat === seat);
}
export function consumeEquipmentDiscount(s: GameState, seat: Seat): void {
  const i = s.turnEffects.findIndex((t) => t.kind === 'equipDiscount' && t.seat === seat);
  if (i >= 0) s.turnEffects.splice(i, 1);
}

// ---------------------------------------------------------------- filters

/** Extended filter: v0.4 keys maxCost, psionicPositive, maxPrintedPhysical, noBurn. */
export function matchesV04(def: CardDef, f: Record<string, any> | undefined): boolean {
  if (!matchesFilter(def, f)) return false;
  if (!f) return true;
  if (f.maxCost !== undefined && totalCost(def.cost) > f.maxCost) return false;
  if (f.exactCost !== undefined && totalCost(def.cost) !== f.exactCost) return false;
  if (f.psionicPositive) {
    const p = def.stats?.psionic;
    if (!(p === 'X' || (typeof p === 'number' && p > 0))) return false;
  }
  if (f.maxPrintedPhysical !== undefined) {
    const p = def.stats?.physical;
    if (typeof p !== 'number' || p > f.maxPrintedPhysical) return false;
  }
  if (f.noBurn && (def.cost?.W ?? 0) > 0) return false;
  return true;
}

// ---------------------------------------------------------------- Power and on-create effects

const enemyUnits = (s: GameState, seat: Seat, filter?: Record<string, any>) =>
  opponentsOf(s, seat).flatMap((o) => player(s, o).lab).filter((u) => matchesV04(defOf(s, u), filter));

function itemOf(s: GameState, uid: string) {
  return s.stack.find((x) => x.uid === uid);
}

/** Extra targets asked after the first, before the card goes to the response window. */
export interface ExtraTargets {
  label: string;
  options: string[];
  optional: boolean;
  /** Cannibalize victim: destroyed immediately as a cost. */
  cannibalize?: boolean;
}

export const EXTRA: Record<string, (s: GameState, seat: Seat, chosen: string[], params: Record<string, any>) => ExtraTargets | null> = {
  DamageTargets: (s, seat, chosen, params) => {
    if (chosen.length >= Number(params.max ?? 2)) return null;
    const options = enemyUnits(s, seat, params.filter).filter((u) => !chosen.includes(u));
    return options.length ? { label: 'Choose another target (optional)', options, optional: true } : null;
  },
  DisableTargets: (s, seat, chosen, params) => {
    if (chosen.length >= Number(params.max ?? 2)) return null;
    const options = disableTargets(s, seat, params).filter((u) => !chosen.includes(u));
    return options.length ? { label: 'Choose another unit (optional)', options, optional: true } : null;
  },
  CannibalInstinct: (s, seat, chosen) => {
    if (chosen.length >= 2) return null;
    const options = cannibalTargets(s, seat, chosen[0] ?? null);
    return { label: 'Cannibalize: choose a different Creature or Cyborg under your control to destroy (cost)', options, optional: false, cannibalize: true };
  },
};

function disableTargets(s: GameState, seat: Seat, params: Record<string, any>): string[] {
  return enemyUnits(s, seat).filter((u) => unitHasAbility(s, u, params.hasAbility));
}

register('castExtras', (ctx, t) => {
  const s = ctx.s;
  const item = itemOf(s, t.uid);
  if (!item) return;
  const e = defOf(s, t.uid).effects.find((x) => x.trigger === 'OnPlay' && EXTRA[x.effect]);
  if (!e) return;
  const targets = item.targets ?? (item.target ? [item.target] : []);
  const a = t.answer as Command | undefined;
  const ext = EXTRA[e.effect]!(s, item.controller, targets, e.params);
  if (!ext) return;
  if (!a) {
    if (!ext.options.length) return;
    ask(ctx, { seat: item.controller, kind: 'chooseCard', label: `${name(s, t.uid)}: ${ext.label}`, options: ext.optional ? [...ext.options, null] : ext.options, info: { source: t.uid, zone: 'lab', optional: ext.optional, pickLow: !!ext.cannibalize }, resume: strip(t) });
    return;
  }
  const ch = a.type === 'ChooseFromList' ? a.choice : null;
  if (!ch || !ext.options.includes(ch)) return;
  item.targets = [...targets, ch];
  if (ext.cannibalize) {
    item.snap = { ...(item.snap ?? {}), consumedPhysical: cannibalize(ctx, ch, t.uid) };
    return;
  }
  push(ctx, strip(t));
});

const V04_EFFECTS: Record<string, EffectImpl> = {
  /** Bio Pulse / Static Burst: 1 damage to up to two enemy units of the listed types. */
  DamageTargets: {
    targets: (s, seat, _u, params) => enemyUnits(s, seat, params.filter),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const item = itemOf(s, e.source);
      const list = item?.targets ?? (e.target ? [e.target] : []);
      for (const u of list) {
        if (s.cards[u]?.zone !== 'lab') continue;
        if (damageUnit(ctx, u, Number(e.params.amount ?? 1), e.source, 'effect')) removeFromBattle(ctx, u, 'destroyed');
      }
      checkVictory(ctx);
    },
  },

  /** High-Energy Pulse / Mental Disrupter: up to two enemy units cannot attack or defend this turn. */
  DisableTargets: {
    targets: (s, seat, _u, params) => disableTargets(s, seat, params),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const item = itemOf(s, e.source);
      const list = (item?.targets ?? (e.target ? [e.target] : [])).filter((u) => s.cards[u]?.zone === 'lab');
      if (!list.length) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
      s.turnEffects.push({ kind: 'disableUnits', source: e.source, uids: list });
      emit(ctx, { type: 'UnitsDisabled', source: e.source, uids: list });
      for (const u of list) for (const x of fighterUnits(s, u)) removeFromBattle(ctx, x, 'disabled');
    },
  },

  /** Emergency Firewall: cancel a Pulse that would contain/disable exactly one of your Robots or Cyborgs. */
  CounterPulse: {
    targets: (s, seat) => s.stack.filter((x) => {
      if (x.controller === seat || x.countered) return false;
      const d = defOf(s, x.uid);
      if (d.timing !== 'Pulse' || !d.effects.some((e) => ['TrapUnit', 'DisableTargets', 'DisableUnits'].includes(e.effect))) return false;
      const ts = x.targets ?? (x.target ? [x.target] : []);
      return ts.length === 1 && s.cards[ts[0]!]?.owner === seat && ['Robot', 'Cyborg'].includes(defOf(s, ts[0]!).unitType ?? '');
    }).map((x) => x.uid),
    run(ctx, t) {
      const e = t as EffectTask;
      const item = e.target ? itemOf(ctx.s, e.target) : undefined;
      if (!item) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
      item.countered = true;
      emit(ctx, { type: 'Countered', uid: item.uid, cardId: card(ctx.s, item.uid).cardId, by: e.source });
    },
  },

  /** Molting: in response to damage aimed at your Creature/Cyborg: −1 Psionic, prevent up to 2 from that effect. */
  Molting: {
    targets: (s, seat) => {
      const aimed = new Set(s.stack.filter((x) => defOf(s, x.uid).effects.some((e) => e.effect === 'DealDamage' || e.effect === 'DamageTargets')).flatMap((x) => x.targets ?? (x.target ? [x.target] : [])));
      return player(s, seat).lab.filter((u) => aimed.has(u) && ['Creature', 'Cyborg'].includes(defOf(s, u).unitType ?? '') && unitStrength(s, u, 'psionic', false) >= 1);
    },
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const u = e.target;
      if (!u || s.cards[u]?.zone !== 'lab' || unitStrength(s, u, 'psionic', false) < 1) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
      const src = [...s.stack].reverse().find((x) => x.uid !== e.source && (x.targets ?? [x.target]).includes(u));
      addMod(ctx, u, 'psionic', -1, 'temp', e.source, 'Molting');
      s.turnEffects.push({ kind: 'prevent', source: e.source, uids: [u], amount: Number(e.params.amount ?? 2), key: src?.uid });
    },
  },

  /** Repair Circuit: prevent the next 1 ability damage to one of your Robots/Cyborgs this turn. */
  PreventDamage: {
    targets: (s, seat, _u, params) => player(s, seat).lab.filter((u) => matchesV04(defOf(s, u), params.filter)),
    run(ctx, t) {
      const e = t as EffectTask;
      if (!e.target || ctx.s.cards[e.target]?.zone !== 'lab') return;
      ctx.s.turnEffects.push({ kind: 'prevent', source: e.source, uids: [e.target], amount: Number(e.params.amount ?? 1) });
      emit(ctx, { type: 'ShieldGranted', uid: e.target, source: e.source, amount: Number(e.params.amount ?? 1) });
    },
  },

  /** Signal Jam: the unit cannot use optional activated abilities this turn. */
  SignalJam: {
    targets: (s, seat) => enemyUnits(s, seat),
    run(ctx, t) {
      const e = t as EffectTask;
      if (!e.target || ctx.s.cards[e.target]?.zone !== 'lab') return;
      ctx.s.turnEffects.push({ kind: 'jam', source: e.source, uids: [e.target] });
      emit(ctx, { type: 'UnitJammed', uid: e.target, source: e.source });
    },
  },

  /** Forced Evolution / Unstable Carapace: a Power roll (not an ability roll; Lock-On cannot touch it). */
  PowerRoll: {
    targets: (s, seat, _u, params) => player(s, seat).lab.filter((u) => defOf(s, u).unitType === 'Creature' && (!params.requireBlocked || (engagementOf(s, u)?.blockers.length ?? 0) > 0)),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      if (!e.target || s.cards[e.target]?.zone !== 'lab') return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
      const side = rollSide(ctx);
      const v = numericValue(s, side);
      emit(ctx, { type: 'AbilityRoll', uid: e.target, cardId: card(s, e.target).cardId, die: 'physical', side, value: v, source: e.source, power: true });
      for (const band of e.params.bands as { values: number[]; stat: Ability; amount: number }[]) {
        if (band.values.includes(v)) addMod(ctx, e.target, band.stat, band.amount, 'temp', e.source, name(s, e.source));
      }
    },
  },

  /** Cannibalistic Instinct: the chosen Creature gains the consumed unit's permanent Physical until end of turn. */
  CannibalInstinct: {
    canPlay: (s, seat) => player(s, seat).lab.some((u) => defOf(s, u).unitType === 'Creature' && cannibalTargets(s, seat, u).length > 0),
    targets: (s, seat) => player(s, seat).lab.filter((u) => defOf(s, u).unitType === 'Creature' && cannibalTargets(s, seat, u).length > 0),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const item = itemOf(s, e.source);
      const amount = Number(item?.snap?.consumedPhysical ?? 0);
      if (!e.target || s.cards[e.target]?.zone !== 'lab') return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
      addMod(ctx, e.target, 'physical', amount, 'temp', e.source, 'Cannibalistic Instinct');
    },
  },

  /** Brood Recall: up to N matching cards from discard to hand. */
  ReturnUpTo: {
    canPlay: (s, seat, _u, params) => player(s, seat).discard.some((u) => matchesV04(defOf(s, u), params.filter)),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const done: number = (t as any).done ?? 0;
      const a = t.answer as Command | undefined;
      const options = player(s, e.controller).discard.filter((u) => matchesV04(defOf(s, u), e.params.filter));
      if (a) {
        const ch = a.type === 'ChooseFromList' ? a.choice : null;
        if (!ch || !options.includes(ch)) return;
        moveCard(ctx, ch, 'hand');
        emit(ctx, { type: 'CardReturnedToHand', seat: e.controller, uid: ch, cardId: card(s, ch).cardId, from: 'discard' });
        if (done + 1 < Number(e.params.n ?? 2)) push(ctx, { ...strip(t), done: done + 1 });
        return;
      }
      if (!options.length) return;
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${name(s, e.source)}: return a card to your hand`, options: done > 0 ? [...options, null] : options, info: { source: e.source, zone: 'discard', optional: done > 0 }, resume: strip(t) });
    },
  },

  /** Crosslink: one of your Stacks gains +1 Cyber and +1 Psionic until it separates. */
  StackBuff: {
    targets: (s, seat) => player(s, seat).lab.filter((u) => card(s, u).stackPartner && defOf(s, u).unitType === 'Cyborg'),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      if (!e.target || !s.cards[e.target]?.stackPartner) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
      for (const ab of ['cyber', 'psionic'] as const) if (e.params[ab]) addMod(ctx, e.target, ab, Number(e.params[ab]), 'stack', e.source, name(s, e.source));
    },
  },

  /** Emergency Separation: split one of your Stacks; the chosen member stays, the other returns depleted. */
  SplitStack: {
    targets: (s, seat) => player(s, seat).lab.filter((u) => card(s, u).stackPartner),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const stay = e.target;
      const leave = stay ? s.cards[stay]?.stackPartner : null;
      if (!stay || !leave) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'targetGone' });
      removeFromBattle(ctx, leave, 'separated');
      card(s, stay).stackPartner = null;
      card(s, leave).stackPartner = null;
      card(s, leave).depleted = true;
      emit(ctx, { type: 'Unstacked', uids: [stay, leave], reason: 'separation', seat: e.controller });
    },
  },

  /** Equipment Mechanic: return an Equipment from discard attached to a legal host, paying its full cost too. */
  EquipmentMechanic: {
    canPlay: (s, seat) => player(s, seat).discard.some((u) => defOf(s, u).cardType === 'Equipment' && player(s, seat).lab.some((h) => canHoldEquipment(s, h, card(s, u).cardId)) && canAfford(s, seat, addBurnAny(defOf(s, u).cost ?? ZERO))),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const seat = e.controller;
      const step: string = (t as any).step ?? 'equip';
      const a = t.answer as Command | undefined;
      const ch = a && a.type === 'ChooseFromList' ? a.choice : undefined;
      if (step === 'equip') {
        const opts = player(s, seat).discard.filter((u) => defOf(s, u).cardType === 'Equipment' && player(s, seat).lab.some((h) => canHoldEquipment(s, h, card(s, u).cardId)) && canAfford(s, seat, defOf(s, u).cost ?? ZERO));
        if (ch === undefined) {
          if (!opts.length) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'noValidCard' });
          ask(ctx, { seat, kind: 'chooseCard', label: 'Equipment Mechanic: choose an Equipment in your discard (you pay its full cost)', options: opts, info: { source: e.source, zone: 'discard' }, resume: strip(t) });
          return;
        }
        if (!ch || !opts.includes(ch)) return;
        push(ctx, { ...strip(t), step: 'host', equip: ch });
        return;
      }
      const eq: string = (t as any).equip;
      const hosts = player(s, seat).lab.filter((h) => canHoldEquipment(s, h, card(s, eq).cardId));
      if (ch === undefined) {
        if (!hosts.length) return;
        ask(ctx, { seat, kind: 'chooseCard', label: `Equipment Mechanic: attach ${name(s, eq)} to`, options: hosts, info: { source: e.source, zone: 'lab' }, resume: { ...strip(t) } });
        return;
      }
      if (!ch || !hosts.includes(ch) || s.cards[eq]?.zone !== 'discard') return;
      const c = defOf(s, eq).cost ?? ZERO;
      if (!payAbility(ctx, seat, c, eq)) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'cannotPay' });
      attachEquipment(ctx, seat, eq, ch, 'mechanic');
    },
  },

  /** Modular Assembly: search for a cheap no-burn Equipment and create it attached, free. */
  ModularAssembly: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const seat = e.controller;
      const a = t.answer as Command | undefined;
      const ch = a && a.type === 'ChooseFromList' ? a.choice : undefined;
      const step: string = (t as any).step ?? 'equip';
      const deck = player(s, seat).battleDeck;
      if (step === 'equip') {
        const opts = deck.filter((u) => matchesV04(defOf(s, u), { cardType: 'Equipment', maxCost: e.params.maxCost ?? 2, noBurn: true }) && player(s, seat).lab.some((h) => canHoldEquipment(s, h, card(s, u).cardId)));
        if (ch === undefined) {
          if (!opts.length) {
            emit(ctx, { type: 'DeckSearched', seat, found: false });
            shuffleInPlace(s.rng, deck);
            return;
          }
          ask(ctx, { seat, kind: 'chooseCard', label: 'Modular Assembly: choose an Equipment to create', options: opts, info: { source: e.source, zone: 'battleDeck' }, resume: strip(t) });
          return;
        }
        if (!ch || !opts.includes(ch)) return;
        emit(ctx, { type: 'CardsRevealed', seat, cards: [{ uid: ch, cardId: card(s, ch).cardId }], source: e.source });
        push(ctx, { ...strip(t), step: 'host', equip: ch });
        return;
      }
      const eq: string = (t as any).equip;
      const hosts = player(s, seat).lab.filter((h) => canHoldEquipment(s, h, card(s, eq).cardId));
      if (ch === undefined) {
        ask(ctx, { seat, kind: 'chooseCard', label: `Modular Assembly: attach ${name(s, eq)} to`, options: hosts, info: { source: e.source, zone: 'lab' }, resume: strip(t) });
        return;
      }
      if (!ch || !hosts.includes(ch)) return;
      attachEquipment(ctx, seat, eq, ch, 'assembly');
      shuffleInPlace(s.rng, deck);
      emit(ctx, { type: 'DeckShuffled', seat, deck: 'battleDeck' });
    },
  },

  /** Salvage Protocol: remove a destroyed Robot from your discard; replenish another depleted CU. */
  SalvageProtocol: {
    canPlay: (s, seat) => player(s, seat).discard.some((u) => defOf(s, u).unitType === 'Robot'),
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const seat = e.controller;
      const a = t.answer as Command | undefined;
      const robots = player(s, seat).discard.filter((u) => defOf(s, u).unitType === 'Robot');
      if (!a) {
        if (!robots.length) return;
        ask(ctx, { seat, kind: 'chooseCard', label: 'Salvage Protocol: remove a destroyed Robot from the game', options: robots, info: { source: e.source, zone: 'discard', pickLow: true }, resume: strip(t) });
        return;
      }
      const ch = a.type === 'ChooseFromList' ? a.choice : null;
      if (!ch || !robots.includes(ch)) return;
      moveCard(ctx, ch, 'removed');
      emit(ctx, { type: 'CardRemoved', seat, uid: ch, cardId: card(s, ch).cardId, source: e.source });
      const paid: string[] = itemOf(s, e.source)?.snap?.paid ?? [];
      const dep = player(s, seat).cus.filter((u) => card(s, u).depleted && !paid.includes(u));
      if (dep.length) {
        card(s, dep[0]!).depleted = false;
        emit(ctx, { type: 'Replenished', seat, uids: [dep[0]], source: e.source });
      }
    },
  },

  // ---- on-create abilities ----

  /** Nomis Analyzer: look at an opponent's hand. */
  LookAtHand: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const opp = e.opponent;
      if (opp === undefined) return;
      const hand = player(s, opp).hand;
      emit(ctx, { type: 'HandLooked', seat: e.controller, of: opp, cards: hand.map((u) => ({ uid: u, cardId: card(s, u).cardId })), to: [e.controller], redacted: { type: 'HandLooked', seat: e.controller, of: opp, count: hand.length } });
    },
  },

  /** Signal Mite / Brood Carrier: look at the top cards and choose which goes on top. */
  ReorderTop: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const seat = e.controller;
      const deck = player(s, seat).battleDeck;
      const n = Math.min(Number(e.params.n ?? 2), deck.length);
      if (n < 2) return;
      const a = t.answer as Command | undefined;
      if (e.params.revealCreature && !(t as any).revealed) {
        const others = player(s, seat).hand.filter((u) => defOf(s, u).unitType === 'Creature');
        if (!others.length) return;
        const ans = answerOf(t);
        if (ans === undefined) return decide(ctx, seat, name(s, e.source), defOf(s, e.source).text, [{ token: 'yes', label: 'Reveal a Creature and look at the top two', score: 1 }], t, { uid: e.source }, { label: 'No' });
        if (ans !== 'yes') return;
        emit(ctx, { type: 'CardsRevealed', seat, cards: [{ uid: others[0], cardId: card(s, others[0]!).cardId }], source: e.source });
        push(ctx, { ...strip(t), revealed: true });
        return;
      }
      const top = deck.slice(0, n);
      if (!a) {
        ask(ctx, { seat, kind: 'chooseCard', label: `${name(s, e.source)}: choose the card to put on top`, options: top, info: { source: e.source, zone: 'battleDeck' }, resume: strip(t) });
        return;
      }
      const ch = a.type === 'ChooseFromList' ? a.choice : null;
      if (!ch || !top.includes(ch)) return;
      deck.splice(deck.indexOf(ch), 1);
      deck.unshift(ch);
      emit(ctx, { type: 'DeckReordered', seat, source: e.source, count: n });
    },
  },

  /** Swarm Caller: reveal the top three; you may take a Creature with total cost 1; the rest go to the bottom. */
  SwarmCall: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const seat = e.controller;
      const deck = player(s, seat).battleDeck;
      const top = deck.slice(0, 3);
      if (!top.length) return;
      const a = t.answer as Command | undefined;
      const opts = top.filter((u) => matchesV04(defOf(s, u), { unitType: 'Creature', exactCost: 1 }));
      if (!a) {
        emit(ctx, { type: 'CardsRevealed', seat, cards: top.map((u) => ({ uid: u, cardId: card(s, u).cardId })), source: e.source });
        if (opts.length) {
          ask(ctx, { seat, kind: 'chooseCard', label: 'Swarm Caller: put a Creature with total cost 1 into your hand', options: [...opts, null], info: { source: e.source, zone: 'battleDeck', optional: true }, resume: strip(t) });
          return;
        }
      }
      const ch = a && a.type === 'ChooseFromList' ? a.choice : null;
      if (ch && opts.includes(ch)) moveCard(ctx, ch, 'hand');
      const rest = deck.slice(0, 3).filter((u) => top.includes(u));
      for (const u of rest) { deck.splice(deck.indexOf(u), 1); deck.push(u); }
      emit(ctx, { type: 'DeckReordered', seat, source: e.source, toBottom: rest.length });
    },
  },

  /** Assembly Wisp: may relocate one Equipment (paying its move cost); if it did, look at the top card. */
  WispRelocate: {
    run(ctx, t) {
      const e = t as EffectTask;
      push(ctx, { k: 'relocateChoice', seat: e.controller, source: e.source, involving: null, then: { k: 'peekTop', seat: e.controller, source: e.source } });
    },
  },

  /** Warend Reaper: may Cannibalize another Creature/Cyborg; if it does, +1 permanent Physical. */
  CannibalizeOnCreate: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const opts = cannibalTargets(s, e.controller, e.source);
      if (!opts.length || s.cards[e.source]?.zone !== 'lab') return;
      const a = t.answer as Command | undefined;
      if (!a) {
        ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${name(s, e.source)}: you may Cannibalize a Creature or Cyborg (+1 permanent Physical)`, options: [...opts, null], info: { source: e.source, zone: 'lab', optional: true, pickLow: true, cannibalize: true }, resume: strip(t) });
        return;
      }
      const ch = a.type === 'ChooseFromList' ? a.choice : null;
      if (!ch || !opts.includes(ch)) return;
      cannibalize(ctx, ch, e.source);
      addMod(ctx, e.source, 'physical', 1, 'permanent', e.source, name(s, e.source));
    },
  },

  /** Railgun Overseer: choose another Robot; while it stays equipped this gains +1 Physical. */
  LinkRobot: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      const opts = player(s, e.controller).lab.filter((u) => u !== e.source && defOf(s, u).unitType === 'Robot');
      if (!opts.length) return;
      const ans = answerOf(t);
      if (ans === undefined && opts.length > 1) return decide(ctx, e.controller, name(s, e.source), defOf(s, e.source).text, opts.map((u) => ({ token: u, label: name(s, u), score: card(s, u).equipment ? 2 : 1 })), t, { uid: e.source });
      const pick = ans && opts.includes(ans) ? ans : opts[0]!;
      card(s, e.source).link = pick;
      emit(ctx, { type: 'UnitLinked', uid: e.source, cardId: card(s, e.source).cardId, linkTo: pick, linkCardId: card(s, pick).cardId });
    },
  },

  /** Foundry Titan: return an Equipment from discard to hand, if you control another Robot. */
  TitanRecall: {
    run(ctx, t) {
      const e = t as EffectTask;
      const s = ctx.s;
      if (!player(s, e.controller).lab.some((u) => u !== e.source && defOf(s, u).unitType === 'Robot')) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'noOtherRobot' });
      EFFECTS.ReturnFromDiscard!.run(ctx, { ...t, params: { filter: { cardType: 'Equipment' } } });
    },
  },
};

register('peekTop', (ctx, t) => {
  const s = ctx.s;
  const top = player(s, t.seat).battleDeck[0];
  if (!top) return;
  emit(ctx, { type: 'TopCardSeen', seat: t.seat, uid: top, cardId: card(s, top).cardId, to: [t.seat], redacted: { type: 'TopCardSeen', seat: t.seat } });
});

function addBurnAny(c: Cost): Cost {
  return { ...c, burns: [...(c.burns ?? []), [...CU_TYPES]] };
}

export function attachEquipment(ctx: Ctx, seat: Seat, eq: string, host: string, via: string): void {
  const s = ctx.s;
  moveCard(ctx, eq, 'attached');
  card(s, eq).attachedTo = host;
  card(s, host).equipment = eq;
  emit(ctx, { type: 'EquipmentAttached', seat, uid: eq, cardId: card(s, eq).cardId, unit: host, via });
}

Object.assign(EFFECTS, V04_EFFECTS);

// Overload Strike: 3 to a Battle Unit or 2 to a Lab (labAmount).
const baseDeal = EFFECTS.DealDamage!.run;
EFFECTS.DealDamage!.run = (ctx, t) => {
  const e = t as EffectTask;
  if ((e.target ?? '').startsWith('lab:') && e.params.labAmount !== undefined) return baseDeal(ctx, { ...t, params: { ...e.params, amount: e.params.labAmount } });
  return baseDeal(ctx, t);
};

// Creature Regenerate / Robo Refurb: v0.4 filters (cost, Psionic > 0) and the Reanimated modifier.
EFFECTS.ReviveToLab = {
  canPlay: (s, seat, _uid, params) => player(s, seat).discard.some((u) => matchesV04(defOf(s, u), params.filter)),
  run(ctx, t) {
    const e = t as EffectTask;
    const s = ctx.s;
    const a = t.answer as Command | undefined;
    const options = player(s, e.controller).discard.filter((u) => matchesV04(defOf(s, u), e.params.filter));
    if (!a) {
      if (!options.length) return void emit(ctx, { type: 'EffectFizzled', source: e.source, reason: 'noValidCard' });
      ask(ctx, { seat: e.controller, kind: 'chooseCard', label: `${name(s, e.source)}: choose a unit to return to your Lab`, options, info: { source: e.source, zone: 'discard' }, resume: strip(t) });
      return;
    }
    const ch = a.type === 'ChooseFromList' ? a.choice : null;
    if (!ch || !options.includes(ch)) return;
    moveCard(ctx, ch, 'lab');
    const c = card(s, ch);
    c.depleted = false;
    c.enteredThisTurn = true;
    const r = e.params.reanimate as Partial<Record<Ability, number>> | undefined;
    if (r) for (const ab of ABILITIES) if (r[ab]) addMod(ctx, ch, ab, r[ab]!, 'reanimated', e.source, 'Reanimated');
    // Legacy (v0.3) data: per-unit-type lasting modifiers.
    const legacy = (e.params.mods ?? {})[defOf(s, ch).unitType ?? ''] as Partial<Record<Ability, number>> | undefined;
    if (legacy) for (const ab of ABILITIES) if (legacy[ab]) addMod(ctx, ch, ab, Number(legacy[ab]), 'permanent', e.source, 'Revived');
    emit(ctx, { type: 'UnitRevived', seat: e.controller, uid: ch, cardId: c.cardId, mods: c.permMods ?? null, source: e.source, reanimated: !!r });
    onCreate(ctx, e.controller, ch);
  },
};

// Containment: filters (Interference Net) are checked on targeting.
const baseTrap = EFFECTS.TrapUnit!;
EFFECTS.TrapUnit = {
  ...baseTrap,
  targets: (s, seat, uid, params) => (baseTrap.targets!(s, seat, uid, params)).filter((u) => matchesV04(defOf(s, u), params.filter)),
  canPlay: (s, seat, uid, params) => (baseTrap.targets!(s, seat, uid, params)).some((u) => matchesV04(defOf(s, u), params.filter)),
};

// Equipment Hunter etc. keep TutorToHand; Brood Recall-style filters for ReturnFromDiscard.
const baseReturn = EFFECTS.ReturnFromDiscard!;
EFFECTS.ReturnFromDiscard = {
  ...baseReturn,
  canPlay: (s, seat, _uid, params) => player(s, seat).discard.some((u) => matchesV04(defOf(s, u), params.filter)),
};

export { eligibleDestroyTypes };
