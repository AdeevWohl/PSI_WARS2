import type { Command } from '@psi-wars/shared';
import { ABILITIES } from '@psi-wars/shared';
import { applyObliteration, dieBonus, diePhysicalPlus, dieReroll, newRoll, numericValue, rollSide } from './dice';
import { fighterStrength, fighterUnits, isDisabled } from './stats';
import { card, defOf, emit, moveCard, player, turnOrderFrom } from './state';
import { ask, push, pushSeq, register } from './tasks';
import { checkVictory, damageLab } from './victory';
import { damageUnit } from './damage';
import { openWindow } from './windows';
import { othersFrom } from './plays';
import type { Ability, Attack, Ctx, GameState, Resolution, Seat, SideDice, Task } from './types';

// ---------- eligibility ----------

/** One uid per fighter: ready, untrapped, not disabled; both units of an attacking stack must be ready (§A8). */
export function eligibleAttackers(s: GameState, seat: Seat): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const uid of player(s, seat).lab) {
    if (seen.has(uid)) continue;
    const units = fighterUnits(s, uid);
    units.forEach((u) => seen.add(u));
    if (units.every((u) => !card(s, u).depleted && !isDisabled(s, u))) out.push(uid);
  }
  return out;
}

/** Defenders may be depleted; trapped units are not in the Lab; disabled units cannot defend. */
export function eligibleBlockers(s: GameState, seat: Seat): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const attacking = new Set((s.battle?.attacks ?? []).flatMap((a) => a.units));
  for (const uid of player(s, seat).lab) {
    if (seen.has(uid)) continue;
    const units = fighterUnits(s, uid);
    units.forEach((u) => seen.add(u));
    if (units.some((u) => attacking.has(u))) continue;
    if (units.every((u) => !isDisabled(s, u))) out.push(uid);
  }
  return out;
}

export function attacksAgainst(s: GameState, seat: Seat): Attack[] {
  return (s.battle?.attacks ?? []).filter((a) => a.status === 'pending' && a.target === seat);
}

// ---------- phase skeleton ----------

register('battle', (ctx) => {
  const s = ctx.s;
  s.phase = 'battle';
  s.step = null;
  emit(ctx, { type: 'PhaseChanged', phase: 'battle', seat: s.turn.active });
  if (checkVictory(ctx)) return;
  s.battle = { attacker: s.turn.active, attacks: [], current: null };
  pushSeq(ctx, [
    { k: 'declareAttackers' },
    { k: 'afterAttackers' },
    { k: 'declareBlockersAll' },
    { k: 'powerWindow' },
    { k: 'cyborgStep' },
    { k: 'determination' },
    { k: 'endBattle' },
  ]);
});

function setStep(ctx: Ctx, step: GameState['step']): void {
  ctx.s.step = step;
  emit(ctx, { type: 'StepChanged', step, seat: ctx.s.turn.active });
}

register('declareAttackers', (ctx, t) => {
  const s = ctx.s;
  const b = s.battle!;
  const seat = b.attacker;
  const a = t.answer as Command | undefined;
  if (!a) {
    setStep(ctx, 'declareAttackers');
    const hasTargets = turnOrderFrom(s, seat).length > 1;
    if (eligibleAttackers(s, seat).length === 0 || !hasTargets) {
      emit(ctx, { type: 'AttackersDeclared', seat, attacks: [] });
      return;
    }
    ask(ctx, { seat, kind: 'declareAttackers', label: 'Declare attackers', resume: { k: 'declareAttackers' } });
    return;
  }
  if (a.type !== 'DeclareAttackers') return;
  for (const d of a.attacks) {
    const units = fighterUnits(s, d.uid);
    for (const u of units) card(s, u).depleted = true; // attacking depletes
    b.attacks.push({ id: d.uid, seat, units, target: d.target, blockers: [], status: 'pending' });
  }
  emit(ctx, { type: 'AttackersDeclared', seat, attacks: b.attacks.map((x) => ({ id: x.id, units: x.units, target: x.target })) });
  // Change Request 1: "When this unit attacks" abilities, in declaration order.
  const onAttack: Task[] = [];
  for (const atk of b.attacks) {
    for (const u of atk.units) {
      for (const e of defOf(s, u).effects) {
        if (e.trigger === 'OnAttack') onAttack.push({ k: 'effect', effect: e.effect, controller: seat, source: u, params: e.params, opponent: atk.target });
      }
    }
  }
  if (onAttack.length) pushSeq(ctx, onAttack);
});

register('afterAttackers', (ctx) => {
  const s = ctx.s;
  if (s.battle!.attacks.length > 0) openWindow(ctx, 'afterAttackersDeclared', 'traps', othersFrom(s, s.turn.active));
});

register('declareBlockersAll', (ctx) => {
  const s = ctx.s;
  const b = s.battle!;
  const targets = new Set(b.attacks.filter((a) => a.status === 'pending').map((a) => a.target));
  if (targets.size === 0) return;
  setStep(ctx, 'declareBlockers');
  // House rule B: only the attacked player blocks. Defenders declare in turn order.
  const defenders = turnOrderFrom(s, b.attacker).filter((x) => targets.has(x));
  pushSeq(ctx, defenders.map((seat) => ({ k: 'declareBlockers', seat })));
});

register('declareBlockers', (ctx, t) => {
  const s = ctx.s;
  const seat: Seat = t.seat;
  const a = t.answer as Command | undefined;
  if (!a) {
    if (attacksAgainst(s, seat).length === 0 || eligibleBlockers(s, seat).length === 0) {
      emit(ctx, { type: 'BlockersAssigned', seat, blocks: [] });
      return;
    }
    ask(ctx, { seat, kind: 'declareBlockers', label: 'Assign blockers', resume: { k: 'declareBlockers', seat } });
    return;
  }
  if (a.type !== 'AssignBlockers') return;
  for (const blk of a.blocks) {
    const atk = s.battle!.attacks.find((x) => x.id === blk.attacker)!;
    atk.blockers = fighterUnits(s, blk.blocker);
  }
  emit(ctx, { type: 'BlockersAssigned', seat, blocks: a.blocks.map((x) => ({ blocker: x.blocker, attacker: x.attacker, units: fighterUnits(s, x.blocker) })) });
});

/** Q&A change 6: the Power-card window always happens, even with no attackers. */
register('powerWindow', (ctx) => {
  const s = ctx.s;
  setStep(ctx, 'power');
  openWindow(ctx, 'battlePower', 'powers', turnOrderFrom(s, s.turn.active));
});

// ---------- step 4: Cyborg abilities ----------

register('cyborgStep', (ctx) => {
  const s = ctx.s;
  const pending = s.battle!.attacks.filter((a) => a.status === 'pending');
  if (pending.length === 0) return;
  setStep(ctx, 'cyborg');
  const tasks: Task[] = [];
  for (const a of pending) {
    for (const u of a.units) {
      for (const e of defOf(s, u).effects) {
        if (e.trigger === 'CyborgStep' && (e.params.whenAttacking ?? true)) tasks.push({ k: 'cyborgAbility', uid: u, attackId: a.id, params: e.params });
      }
    }
  }
  pushSeq(ctx, tasks);
});

register('cyborgAbility', (ctx, t) => {
  const s = ctx.s;
  const atk = s.battle?.attacks.find((a) => a.id === t.attackId);
  if (!atk || atk.status !== 'pending' || !atk.units.includes(t.uid)) return;
  const a = t.answer as Command | undefined;
  if (!a && t.params.optional !== false) {
    ask(ctx, { seat: atk.seat, kind: 'optionalRoll', label: `${defOf(s, t.uid).name}: roll for attack?`, info: { uid: t.uid, attackId: atk.id }, resume: t });
    return;
  }
  if (a && a.type === 'UseAbility' && !a.use) {
    emit(ctx, { type: 'AbilityDeclined', uid: t.uid });
    return;
  }
  const side = rollSide(ctx);
  emit(ctx, { type: 'AbilityRoll', uid: t.uid, cardId: card(s, t.uid).cardId, die: 'physical', side });
  if (side === 6) {
    const opp = player(s, atk.target);
    const top = opp.resourceDeck[0];
    if (top) {
      moveCard(ctx, top, 'discard');
      emit(ctx, { type: 'CardMilled', seat: atk.target, uid: top, cardId: card(s, top).cardId, source: t.uid });
    }
  }
});

// ---------- step 5: determination ----------

register('determination', (ctx) => {
  const s = ctx.s;
  if (!s.battle!.attacks.some((a) => a.status === 'pending')) return;
  setStep(ctx, 'determination');
  pushSeq(ctx, [{ k: 'nextBattle' }, { k: 'unblockedAll' }]);
});

function pendingBlocked(s: GameState): Attack[] {
  return s.battle!.attacks.filter((a) => a.status === 'pending' && a.blockers.length > 0 && a.units.length > 0 && !player(s, a.target).eliminated);
}

/** The attacker chooses the order in which blocked battles resolve. */
register('nextBattle', (ctx, t) => {
  const s = ctx.s;
  const remaining = pendingBlocked(s);
  if (remaining.length === 0) return;
  const a = t.answer as Command | undefined;
  let id: string | undefined;
  if (remaining.length === 1) id = remaining[0]!.id;
  else if (a && a.type === 'ChooseFromList' && a.choice) id = a.choice;
  else {
    ask(ctx, { seat: s.battle!.attacker, kind: 'battleOrder', label: 'Choose the next battle to resolve', options: remaining.map((x) => x.id), resume: { k: 'nextBattle' } });
    return;
  }
  push(ctx, { k: 'nextBattle' });
  s.battle!.current = freshResolution(id);
  push(ctx, { k: 'fight', attackId: id, stage: 'optional' });
});

function freshResolution(attackId: string): Resolution {
  return {
    attackId,
    optional: {},
    att: null,
    def: null,
    occurs: null,
    rerollsLeft: { att: 0, def: 0 },
    disoriented: { att: false, def: false },
    winners: { cyber: null, psionic: null, physical: null },
    destroyed: { att: false, def: false },
  };
}

/** Optional "may roll to modify" decisions, chosen before any roll (§A8 stage a). Returns true if it asked. */
function askOptionalRolls(ctx: Ctx, units: string[], optional: Record<string, boolean>, resume: Task): boolean {
  const s = ctx.s;
  for (const u of units) {
    if (optional[u] !== undefined) continue;
    const e = defOf(s, u).effects.find((x) => x.trigger === 'ModifyRoll');
    if (!e) continue;
    if (e.params.optional === false) {
      optional[u] = true;
      continue;
    }
    ask(ctx, { seat: card(s, u).owner, kind: 'optionalRoll', label: `${defOf(s, u).name}: ${defOf(s, u).text}`, info: { uid: u }, resume: { ...resume, unit: u } });
    return true;
  }
  return false;
}

/** Stage a: roll X abilities (lasting the turn) and the chosen modify-rolls. */
function stageA(ctx: Ctx, units: string[], optional: Record<string, boolean>): void {
  const s = ctx.s;
  for (const u of units) {
    const c = card(s, u);
    for (const e of defOf(s, u).effects) {
      if (e.trigger === 'RollX' && c.xValue === null) {
        const side = rollSide(ctx);
        c.xValue = numericValue(s, side);
        emit(ctx, { type: 'XRolled', uid: u, cardId: c.cardId, stat: e.params.stat, side, value: c.xValue });
      }
    }
  }
  for (const u of units) {
    if (!optional[u]) continue;
    const c = card(s, u);
    const e = defOf(s, u).effects.find((x) => x.trigger === 'ModifyRoll');
    if (!e) continue;
    const side = rollSide(ctx);
    const delta = Number(e.params.bySide?.[String(side)] ?? 0);
    const stat = (e.params.stat ?? 'physical') as Ability;
    c.tempMods[stat] += delta;
    emit(ctx, { type: 'RollModified', uid: u, cardId: c.cardId, stat, side, value: numericValue(s, side), delta });
  }
}

function strengths(s: GameState, units: string[], attacking: boolean): Record<Ability, number> {
  const out = { cyber: 0, psionic: 0, physical: 0 };
  for (const ab of ABILITIES) out[ab] = fighterStrength(s, units, ab, attacking);
  return out;
}

function physTotal(s: GameState, str: Record<Ability, number>, d: SideDice, includeObliteration = true): number {
  const physDie = includeObliteration ? dieBonus(s, 'physical', d.physical) : d.physical ? s.rules.dice[s.config.diceVariant].physical[String(d.physical.side)]!.bonus : 0;
  return str.physical + physDie + diePhysicalPlus(s, 'cyber', d.cyber) + diePhysicalPlus(s, 'psionic', d.psionic);
}

register('fight', (ctx, t) => {
  const s = ctx.s;
  const b = s.battle!;
  const atk = b.attacks.find((a) => a.id === t.attackId)!;
  const r = b.current!;
  const answer = t.answer as Command | undefined;
  const attackerSeat = atk.seat;
  const defenderSeat = atk.target;
  const self: Task = { k: 'fight', attackId: t.attackId, stage: t.stage };

  // Units may have left the battle (trap, disable) — a vanished side ends the fight.
  if (atk.status !== 'pending' || atk.units.length === 0) {
    b.current = null;
    return;
  }
  if (atk.blockers.length === 0) {
    b.current = null; // became unblocked; handled with the unblocked attackers
    return;
  }

  switch (t.stage) {
    case 'optional': {
      if (answer && answer.type === 'UseAbility' && t.unit) r.optional[t.unit] = answer.use;
      if (askOptionalRolls(ctx, [...atk.units, ...atk.blockers], r.optional, self)) return;
      push(ctx, { ...self, stage: 'dice' });
      return;
    }
    case 'dice': {
      stageA(ctx, [...atk.units, ...atk.blockers], r.optional);
      const sa = strengths(s, atk.units, true);
      const sd = strengths(s, atk.blockers, false);
      // A Cyber/Psionic battle happens only if both sides have >= 1 (X counts as >= 1, and is rolled by now).
      r.occurs = { cyber: sa.cyber >= 1 && sd.cyber >= 1, psionic: sa.psionic >= 1 && sd.psionic >= 1 };
      // Zero-strength rule (B2): a side with 0 against >= 1, of a listed unit type, is instantly Disoriented.
      const combat = s.rules.combat ?? {};
      const zeroRule = combat.zeroStrengthDisorients ?? { psionic: ['Creature', 'Cyborg'], cyber: ['Robot', 'Cyborg'] };
      const autoLoser: Partial<Record<'cyber' | 'psionic', 'att' | 'def'>> = {};
      for (const ab of ['cyber', 'psionic'] as const) {
        const types = zeroRule[ab] ?? [];
        const isType = (units: string[]) => units.some((u) => types.includes(defOf(s, u).unitType ?? ''));
        if (sa[ab] === 0 && sd[ab] >= 1 && isType(atk.units)) autoLoser[ab] = 'att';
        else if (sd[ab] === 0 && sa[ab] >= 1 && isType(atk.blockers)) autoLoser[ab] = 'def';
      }
      const roll = (ab: 'cyber' | 'psionic') => (r.occurs![ab] ? newRoll(rollSide(ctx)) : null);
      const att: SideDice = { cyber: roll('cyber'), psionic: roll('psionic'), physical: newRoll(rollSide(ctx)) };
      const def: SideDice = { cyber: roll('cyber'), psionic: roll('psionic'), physical: newRoll(rollSide(ctx)) };
      r.att = att;
      r.def = def;
      emit(ctx, {
        type: 'DiceRolled', attackId: atk.id,
        att: { seat: attackerSeat, cyber: att.cyber?.side ?? null, psionic: att.psionic?.side ?? null, physical: att.physical.side, str: sa },
        def: { seat: defenderSeat, cyber: def.cyber?.side ?? null, psionic: def.psionic?.side ?? null, physical: def.physical.side, str: sd },
      });
      for (const ab of ['cyber', 'psionic'] as const) {
        const o = applyObliteration(s, ab, att[ab], def[ab]);
        if (o !== 'none') emit(ctx, { type: 'Obliterated', attackId: atk.id, die: ab, by: o });
      }
      const psionicDisorients = combat.psionicLossDisorients ?? true;
      for (const ab of ['cyber', 'psionic'] as const) {
        let ta: number;
        let td: number;
        let auto = false;
        if (autoLoser[ab]) {
          auto = true;
          ta = sa[ab];
          td = sd[ab];
        } else {
          if (!r.occurs[ab]) continue;
          ta = sa[ab] + dieBonus(s, ab, att[ab]);
          td = sd[ab] + dieBonus(s, ab, def[ab]);
          if (ta === td) continue;
        }
        const winner = autoLoser[ab] ? (autoLoser[ab] === 'att' ? 'def' : 'att') : ta > td ? 'att' : 'def';
        const loser = winner === 'att' ? 'def' : 'att';
        r.winners[ab] = winner;
        if (ab === 'psionic') emit(ctx, { type: 'PsionicWin', attackId: atk.id, side: winner, totals: { att: ta, def: td }, auto });
        if (ab === 'cyber' || psionicDisorients || auto) {
          r.disoriented[loser] = true;
          const units = loser === 'att' ? atk.units : atk.blockers;
          for (const u of units) card(s, u).disoriented = true;
          emit(ctx, { type: 'Disoriented', attackId: atk.id, side: loser, uids: units, totals: { att: ta, def: td }, ability: ab, auto });
        }
      }
      r.rerollsLeft = {
        att: (dieReroll(s, 'cyber', att.cyber) ? 1 : 0) + (dieReroll(s, 'psionic', att.psionic) ? 1 : 0),
        def: (dieReroll(s, 'cyber', def.cyber) ? 1 : 0) + (dieReroll(s, 'psionic', def.psionic) ? 1 : 0),
      };
      push(ctx, { ...self, stage: 'rerollAtt' });
      return;
    }
    case 'rerollAtt':
    case 'rerollDef': {
      // RULING A8-d: optional, asked of the player (attacker decides first), never auto-chosen.
      const side = t.stage === 'rerollAtt' ? 'att' : 'def';
      const seat = side === 'att' ? attackerSeat : defenderSeat;
      const dice = side === 'att' ? r.att! : r.def!;
      if (answer && answer.type === 'ChooseReroll') {
        if (answer.reroll) {
          const newSide = rollSide(ctx);
          dice.physical.side = newSide;
          dice.physical.history.push(newSide);
          r.rerollsLeft[side]--;
          emit(ctx, { type: 'Rerolled', attackId: atk.id, side, seat, physical: newSide });
        } else {
          r.rerollsLeft[side] = 0;
        }
      }
      if (r.rerollsLeft[side] > 0) {
        const sa = strengths(s, atk.units, true);
        const sd = strengths(s, atk.blockers, false);
        const mine = side === 'att' ? physTotal(s, sa, r.att!, false) : physTotal(s, sd, r.def!, false);
        const theirs = side === 'att' ? physTotal(s, sd, r.def!, false) : physTotal(s, sa, r.att!, false);
        ask(ctx, {
          seat, kind: 'reroll', label: 'Re-roll your Physical die?',
          info: { attackId: atk.id, yourTotal: mine, theirTotal: theirs, yourDie: dice.physical.side, rerollsLeft: r.rerollsLeft[side] },
          resume: self,
        });
        return;
      }
      push(ctx, { ...self, stage: side === 'att' ? 'rerollDef' : 'physical' });
      return;
    }
    case 'physical': {
      const att = r.att!;
      const def = r.def!;
      const o = applyObliteration(s, 'physical', att.physical, def.physical);
      if (o !== 'none') emit(ctx, { type: 'Obliterated', attackId: atk.id, die: 'physical', by: o });
      const sa = strengths(s, atk.units, true);
      const sd = strengths(s, atk.blockers, false);
      const ta = physTotal(s, sa, att);
      const td = physTotal(s, sd, def);
      if (ta > td) {
        r.winners.physical = 'att';
        if (!r.disoriented.att) r.destroyed.def = true;
      } else if (td > ta) {
        r.winners.physical = 'def';
        if (!r.disoriented.def) r.destroyed.att = true;
      }
      const side = (units: string[], str: Record<Ability, number>, d: SideDice, physicalTotal: number, dis: boolean, destroyed: boolean) => ({
        units,
        cyber: d.cyber ? { strength: str.cyber, die: d.cyber.side, obliterated: d.cyber.obliterated, total: str.cyber + dieBonus(s, 'cyber', d.cyber) } : null,
        psionic: d.psionic ? { strength: str.psionic, die: d.psionic.side, obliterated: d.psionic.obliterated, total: str.psionic + dieBonus(s, 'psionic', d.psionic) } : null,
        physical: {
          strength: str.physical,
          die: d.physical.side,
          history: d.physical.history,
          obliterated: d.physical.obliterated,
          side5: diePhysicalPlus(s, 'cyber', d.cyber) + diePhysicalPlus(s, 'psionic', d.psionic),
          total: physicalTotal,
        },
        disoriented: dis,
        destroyed,
      });
      emit(ctx, {
        type: 'BattleResolved', attackId: atk.id,
        att: { seat: attackerSeat, ...side(atk.units, sa, att, ta, r.disoriented.att, r.destroyed.att) },
        def: { seat: defenderSeat, ...side(atk.blockers, sd, def, td, r.disoriented.def, r.destroyed.def) },
        winners: r.winners,
      });
      const attUnits = [...atk.units];
      const defUnits = [...atk.blockers];
      if (r.destroyed.def) destroyFighter(ctx, defUnits, atk.id);
      if (r.destroyed.att) destroyFighter(ctx, attUnits, atk.id);
      // B3: a Disoriented Physical winner can't destroy, but the non-Disoriented loser deals damage
      // equal to its Physical strength (no dice). A Stack takes it on its strongest card.
      const w = r.winners.physical;
      if (w && (s.rules.combat?.disorientedWinnerTakesDamage ?? true) && r.disoriented[w] && !r.disoriented[w === 'att' ? 'def' : 'att']) {
        const loserStr = w === 'att' ? sd.physical : sa.physical;
        const winnerUnits = w === 'att' ? atk.units : atk.blockers;
        const loserUnits = w === 'att' ? atk.blockers : atk.units;
        const winnerStr = w === 'att' ? sa.physical : sd.physical;
        if (loserStr > 0) {
          if (loserStr >= winnerStr) {
            // Enough to destroy the whole fighter.
            emit(ctx, { type: 'UnitDamaged', uid: winnerUnits[0], cardId: card(s, winnerUnits[0]!).cardId, seat: card(s, winnerUnits[0]!).owner, amount: loserStr, physicalBefore: winnerStr, physicalAfter: 0, source: loserUnits[0] ?? null, cause: 'combat', lethal: true, attackId: atk.id });
            destroyFighter(ctx, winnerUnits, atk.id);
            if (w === 'att') r.destroyed.att = true;
            else r.destroyed.def = true;
          } else {
            if (winnerUnits.length === 1) damageUnit(ctx, winnerUnits[0]!, loserStr, loserUnits[0] ?? null, 'combat', atk.id);
            else {
              // A surviving Stack spreads the reduction over its cards, strongest first.
              let left = loserStr;
              for (const u of [...winnerUnits].sort((a, b) => fighterStrength(s, [b], 'physical', false) - fighterStrength(s, [a], 'physical', false))) {
                const before = fighterStrength(s, [u], 'physical', false);
                const take = Math.min(left, before);
                if (!take) continue;
                card(s, u).tempMods.physical -= take;
                left -= take;
                emit(ctx, { type: 'UnitDamaged', uid: u, cardId: card(s, u).cardId, seat: card(s, u).owner, amount: take, physicalBefore: before, physicalAfter: fighterStrength(s, [u], 'physical', false), source: loserUnits[0] ?? null, cause: 'combat', lethal: false, attackId: atk.id });
              }
            }
          }
        }
      }
      atk.status = 'resolved';
      push(ctx, { k: 'fightTriggers', attackId: atk.id, attUnits, defUnits, attackerSeat, defenderSeat, winners: r.winners, destroyed: r.destroyed });
      b.current = null;
      return;
    }
  }
});

function destroyFighter(ctx: Ctx, units: string[], attackId: string): void {
  const s = ctx.s;
  for (const u of units) {
    const c = s.cards[u];
    if (!c || (c.zone !== 'lab' && c.zone !== 'trapped')) continue;
    moveCard(ctx, u, 'discard');
    emit(ctx, { type: 'UnitDestroyed', uid: u, cardId: c.cardId, seat: c.owner, attackId });
  }
}

/** "On win" / "on destroy" abilities, then the victory check (§C3 pseudocode). */
register('fightTriggers', (ctx, t) => {
  const s = ctx.s;
  const tasks: Task[] = [];
  const sideUnits = (side: 'att' | 'def'): string[] => (side === 'att' ? t.attUnits : t.defUnits);
  const oppOf = (side: 'att' | 'def'): Seat => (side === 'att' ? t.defenderSeat : t.attackerSeat);
  const triggerFor: Record<Ability, string> = { cyber: 'OnCyberWin', psionic: 'OnPsionicWin', physical: 'OnPhysicalWin' };
  for (const ab of ABILITIES) {
    const w = t.winners[ab] as 'att' | 'def' | null;
    if (!w) continue;
    for (const u of sideUnits(w)) {
      for (const e of defOf(s, u).effects) {
        if (e.trigger === triggerFor[ab]) tasks.push({ k: 'effect', effect: e.effect, controller: card(s, u).owner, source: u, params: e.params, opponent: oppOf(w) });
      }
    }
  }
  for (const side of ['att', 'def'] as const) {
    const killedOther = side === 'att' ? t.destroyed.def : t.destroyed.att;
    if (!killedOther) continue;
    for (const u of sideUnits(side)) {
      for (const e of defOf(s, u).effects) {
        // House rule E: "Opponent" = the player whose unit was destroyed.
        if (e.trigger === 'OnDestroyEnemyUnit') tasks.push({ k: 'effect', effect: e.effect, controller: card(s, u).owner, source: u, params: e.params, opponent: oppOf(side) });
      }
    }
  }
  tasks.push({ k: 'victoryCheck' });
  pushSeq(ctx, tasks);
});

register('victoryCheck', (ctx) => {
  checkVictory(ctx);
});

// ---------- stage e: unblocked attackers ----------

register('unblockedAll', (ctx) => {
  const s = ctx.s;
  const list = s.battle!.attacks.filter((a) => a.status === 'pending' && a.blockers.length === 0 && a.units.length > 0);
  pushSeq(ctx, list.map((a) => ({ k: 'unblocked', attackId: a.id, stage: 'optional' })));
});

register('unblocked', (ctx, t) => {
  const s = ctx.s;
  const b = s.battle!;
  const atk = b.attacks.find((a) => a.id === t.attackId)!;
  if (atk.status !== 'pending' || atk.units.length === 0) return;
  if (player(s, atk.target).eliminated) {
    atk.status = 'cancelled';
    return;
  }
  const answer = t.answer as Command | undefined;
  const optional: Record<string, boolean> = t.optional ?? {};
  if (answer && answer.type === 'UseAbility' && t.unit) optional[t.unit] = answer.use;
  if (askOptionalRolls(ctx, atk.units, optional, { k: 'unblocked', attackId: atk.id, optional })) return;
  stageA(ctx, atk.units, optional);
  // §A8 e: damage = current Physical strength (base + Equipment + Stack + Commander + modifiers). No dice.
  const dmg = Math.max(0, fighterStrength(s, atk.units, 'physical', true));
  atk.status = 'resolved';
  emit(ctx, { type: 'UnblockedHit', attackId: atk.id, seat: atk.seat, target: atk.target, units: atk.units, damage: dmg });
  damageLab(ctx, atk.target, dmg, atk.id);
  checkVictory(ctx);
});

register('endBattle', (ctx) => {
  const s = ctx.s;
  const b = s.battle;
  if (b) {
    // §A9.1: surviving attackers return to the Lab and are replenished.
    for (const a of b.attacks) {
      for (const u of a.units) {
        const c = s.cards[u];
        if (c && c.zone === 'lab') c.depleted = false;
      }
    }
  }
  // Stacks separate at the end of the Battle phase; Disoriented ends (RULING A8-c).
  for (const c of Object.values(s.cards)) {
    if (c.stackPartner) c.stackPartner = null;
    c.disoriented = false;
  }
  s.battle = null;
  s.step = null;
  emit(ctx, { type: 'BattleEnded', seat: s.turn.active });
});
