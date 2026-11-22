import type { Command } from '@psi-wars/shared';
import { numericValue, rollSide } from './dice';
import { equipmentBonus } from './stats';
import { card, defOf, emit, moveCard, nextLiveSeat, player } from './state';
import { ask, push, pushSeq, register } from './tasks';
import { checkVictory, endGameByTurnLimit } from './victory';
import { openWindow } from './windows';
import { othersFrom } from './plays';
import type { Ctx, Seat } from './types';

function phase(ctx: Ctx, ph: Exclude<Ctx['s']['phase'], 'setup' | 'gameOver'>): boolean {
  ctx.s.phase = ph;
  ctx.s.step = null;
  emit(ctx, { type: 'PhaseChanged', phase: ph, seat: ctx.s.turn.active });
  return checkVictory(ctx); // §A10: check at every phase change
}

register('startTurn', (ctx, t) => {
  const s = ctx.s;
  const seat: Seat = t.seat;
  if (s.config.maxTurns > 0 && s.turn.number >= s.config.maxTurns) {
    endGameByTurnLimit(ctx);
    return;
  }
  s.turn.number++;
  s.turn.active = seat;
  for (const c of Object.values(s.cards)) c.enteredThisTurn = false;
  emit(ctx, { type: 'TurnStarted', seat, turn: s.turn.number });
  pushSeq(ctx, [{ k: 'replenish' }, { k: 'draw' }, { k: 'creation' }, { k: 'battle' }, { k: 'cleanup' }, { k: 'endTurn' }]);
});

register('replenish', (ctx) => {
  if (phase(ctx, 'replenish')) return;
  const s = ctx.s;
  const p = player(s, s.turn.active);
  const uids = [...p.cus, ...p.lab, ...p.trapped].filter((u) => card(s, u).depleted);
  for (const u of uids) card(s, u).depleted = false;
  emit(ctx, { type: 'Replenished', seat: p.seat, uids });
});

register('draw', (ctx) => {
  if (phase(ctx, 'draw')) return;
  pushSeq(ctx, [{ k: 'drawResource' }, { k: 'drawBattle' }, { k: 'openWindow', point: 'endOfDraw' }]);
});

register('openWindow', (ctx, t) => {
  openWindow(ctx, t.point, 'traps', othersFrom(ctx.s, ctx.s.turn.active));
});

register('drawResource', (ctx) => {
  const s = ctx.s;
  const seat = s.turn.active;
  const p = player(s, seat);
  const uid = p.resourceDeck[0];
  if (!uid) {
    emit(ctx, { type: 'DeckEmpty', seat, deck: 'resourceDeck' });
    return;
  }
  const d = defOf(s, uid);
  if (d.cardType === 'CreationUnit') {
    moveCard(ctx, uid, 'cus');
    card(s, uid).depleted = false;
    emit(ctx, { type: 'CUEntered', seat, uid, cardId: d.id, via: 'draw' });
    return;
  }
  // Creation Oracle (or any non-CU resource): drawn face-up, owner chooses.
  moveCard(ctx, uid, 'hand');
  emit(ctx, { type: 'CardDrawn', seat, deck: 'resource', uid, cardId: d.id });
  if (d.effects.some((e) => e.effect === 'CreationOracle')) {
    ask(ctx, { seat, kind: 'oracle', label: 'Creation Oracle: keep it in hand, or use it now?', options: ['keep', 'use'], info: { uid }, resume: { k: 'oracleChoice', uid } });
  }
});

register('oracleChoice', (ctx, t) => {
  const a = t.answer as Command;
  const choice = a.type === 'ChooseFromList' ? a.choice : 'keep';
  const s = ctx.s;
  const seat = card(s, t.uid).owner;
  if (choice === 'use') {
    moveCard(ctx, t.uid, 'discard');
    emit(ctx, { type: 'CardPlayed', seat, uid: t.uid, cardId: card(s, t.uid).cardId, cardType: 'Resource' });
    push(ctx, { k: 'effect', effect: 'CreationOracle', controller: seat, source: t.uid, params: {} });
  } else {
    emit(ctx, { type: 'OracleKept', seat, uid: t.uid });
  }
});

register('drawBattle', (ctx) => {
  const s = ctx.s;
  const seat = s.turn.active;
  if (s.turn.number === 1 && s.rules.setup.firstPlayerSkipsBattleDraw) {
    emit(ctx, { type: 'DrawSkipped', seat, reason: 'firstTurn' });
    return;
  }
  drawBattleCard(ctx, seat);
});

export function drawBattleCard(ctx: Ctx, seat: Seat): void {
  const s = ctx.s;
  const p = player(s, seat);
  const uid = p.battleDeck[0];
  if (!uid) {
    emit(ctx, { type: 'DeckEmpty', seat, deck: 'battleDeck' });
    return;
  }
  moveCard(ctx, uid, 'hand');
  emit(ctx, {
    type: 'CardDrawn', seat, deck: 'battle', uid, cardId: card(s, uid).cardId, to: [seat],
    redacted: { type: 'CardDrawn', seat, deck: 'battle' },
  });
}

register('creation', (ctx) => {
  if (phase(ctx, 'creation')) return;
  pushSeq(ctx, [{ k: 'creationMain' }, { k: 'openWindow', point: 'endOfCreation' }]);
});

register('creationMain', (ctx) => {
  const s = ctx.s;
  ask(ctx, { seat: s.turn.active, kind: 'main', label: 'Creation phase', resume: { k: 'creationMain' } });
});

register('cleanup', (ctx) => {
  if (phase(ctx, 'cleanup')) return;
  pushSeq(ctx, [{ k: 'openWindow', point: 'beforeCleanupEscapes' }, { k: 'escapes' }]);
});

/** RULING A9-a: one escape attempt per Trap, in the trapped unit owner's Cleanup. */
register('escapes', (ctx) => {
  const s = ctx.s;
  const seat = s.turn.active;
  for (const uid of [...player(s, seat).trapped]) {
    const u = card(s, uid);
    const trapUid = u.trappedBy;
    if (!trapUid) continue;
    const trapDef = defOf(s, trapUid);
    const check = trapDef.effects.find((e) => e.trigger === 'TrapEscapeCheck');
    if (!check) continue;
    const base = defOf(s, uid).stats?.physical;
    const phys = (typeof base === 'number' ? base : 0) + equipmentBonus(s, uid, 'physical');
    const side = rollSide(ctx);
    const value = numericValue(s, side);
    const threshold = Number(check.params.threshold ?? 5);
    const freed = phys + value > threshold;
    emit(ctx, { type: 'EscapeAttempt', seat, uid, cardId: u.cardId, trap: trapUid, physical: phys, side, value, threshold, freed });
    if (freed) {
      u.trappedBy = null;
      moveCard(ctx, trapUid, 'discard');
      moveCard(ctx, uid, 'lab');
      u.depleted = true;
      emit(ctx, { type: 'UnitFreed', uid, cardId: u.cardId, seat, reason: 'escaped' });
    }
  }
});

register('endTurn', (ctx) => {
  const s = ctx.s;
  s.turnEffects = [];
  for (const c of Object.values(s.cards)) {
    c.tempMods = { cyber: 0, psionic: 0, physical: 0 };
    c.xValue = null;
    c.disoriented = false;
  }
  s.step = null;
  emit(ctx, { type: 'TurnEnded', seat: s.turn.active });
  if (checkVictory(ctx)) return;
  push(ctx, { k: 'startTurn', seat: nextLiveSeat(s, s.turn.active) });
});
