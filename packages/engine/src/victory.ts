import { battleUnitCount } from './stats';
import { card, defOf, emit, liveSeats, moveCard, player } from './state';
import type { Ctx, Seat } from './types';

export function damageLab(ctx: Ctx, seat: Seat, amount: number, source: string | null): void {
  if (amount <= 0) return;
  const p = player(ctx.s, seat);
  if (p.eliminated) return;
  p.labHP -= amount;
  emit(ctx, { type: 'LabDamaged', seat, amount, hp: p.labHP, source });
}

function finish(ctx: Ctx, winners: Seat[], draw: boolean, reason: string): void {
  const s = ctx.s;
  s.result = { winners, draw, reason };
  s.phase = 'gameOver';
  s.step = null;
  s.tasks = [];
  s.prompt = null;
  emit(ctx, { type: 'GameOver', winners, draw, reason });
}

/**
 * House rule D: an eliminated player's cards all leave the game; units they had
 * trapped are freed and return to their owners' Labs depleted.
 */
export function eliminate(ctx: Ctx, seat: Seat, reason: string): void {
  const s = ctx.s;
  const p = player(s, seat);
  if (p.eliminated) return;
  p.eliminated = true;
  emit(ctx, { type: 'PlayerEliminated', seat, reason });

  for (const c of Object.values(s.cards)) {
    if (c.owner !== seat || c.zone !== 'attached' || defOf(s, c.uid).cardType !== 'Trap' || !c.attachedTo) continue;
    const unit = s.cards[c.attachedTo];
    if (unit && unit.zone === 'trapped' && unit.owner !== seat) {
      unit.trappedBy = null;
      c.attachedTo = null;
      moveCard(ctx, unit.uid, 'lab');
      unit.depleted = true;
      emit(ctx, { type: 'UnitFreed', uid: unit.uid, cardId: unit.cardId, seat: unit.owner, reason: 'trapperEliminated' });
    }
  }
  for (const uid of [...p.lab, ...p.trapped]) moveCard(ctx, uid, 'removed');
  for (const c of Object.values(s.cards)) {
    if (c.owner === seat && c.zone !== 'removed') moveCard(ctx, c.uid, 'removed');
  }
  if (s.battle) {
    for (const a of s.battle.attacks) {
      if (a.status !== 'pending') continue;
      if (a.target === seat || a.seat === seat) a.status = 'cancelled';
      a.blockers = a.blockers.filter((u) => card(s, u).owner !== seat);
    }
  }
}

function abortTurn(ctx: Ctx): void {
  const s = ctx.s;
  for (const item of [...s.stack].reverse()) {
    const c = s.cards[item.uid];
    if (c && c.zone === 'stack') moveCard(ctx, item.uid, 'discard');
  }
  s.stack = [];
  s.battle = null;
  s.step = null;
  s.prompt = null;
  s.tasks = [{ k: 'endTurn', aborted: true }];
}

/**
 * Win/lose check (§A10): Lab at 0 or less, or no Battle Units in Lab (incl. trapped),
 * hand and Battle Deck. Simultaneous loss of everyone left is a draw (RULING A10-a).
 * Returns true when the current flow must stop (game over or active player out).
 */
export function checkVictory(ctx: Ctx): boolean {
  const s = ctx.s;
  if (s.result) return true;
  const live = liveSeats(s);
  const losers = live.filter((seat) => player(s, seat).labHP <= 0 || battleUnitCount(s, seat) === 0);
  if (losers.length === 0) return false;
  const reasonOf = (seat: Seat) => (player(s, seat).labHP <= 0 ? 'labDestroyed' : 'noBattleUnits');
  if (losers.length === live.length) {
    for (const seat of losers) emit(ctx, { type: 'PlayerEliminated', seat, reason: reasonOf(seat) });
    for (const seat of losers) player(s, seat).eliminated = true;
    finish(ctx, [], true, 'simultaneousLoss');
    return true;
  }
  const survivors = live.filter((seat) => !losers.includes(seat));
  if (survivors.length === 1) {
    // Game over: mark the losers out but leave the final board intact (house rule D's
    // "cards leave the game" only matters while the game continues).
    for (const seat of losers) {
      player(s, seat).eliminated = true;
      emit(ctx, { type: 'PlayerEliminated', seat, reason: reasonOf(seat) });
    }
    finish(ctx, survivors, false, reasonOf(losers[0]!));
    return true;
  }
  for (const seat of losers) eliminate(ctx, seat, reasonOf(seat));
  if (player(s, s.turn.active).eliminated) {
    abortTurn(ctx);
    return true;
  }
  return false;
}

export function concede(ctx: Ctx, seat: Seat): void {
  const s = ctx.s;
  const wasActive = s.turn.active === seat;
  const prompt = s.prompt;
  const others = liveSeats(s).filter((x) => x !== seat);
  if (others.length === 1) {
    player(s, seat).eliminated = true;
    emit(ctx, { type: 'PlayerEliminated', seat, reason: 'conceded' });
    finish(ctx, others, false, 'conceded');
    return;
  }
  eliminate(ctx, seat, 'conceded');
  const left = liveSeats(s);
  if (left.length === 0) {
    finish(ctx, [], true, 'conceded');
    return;
  }
  if (wasActive) {
    abortTurn(ctx);
  } else if (prompt && prompt.seat === seat) {
    s.prompt = null;
    s.tasks.push(prompt.resume);
  }
}

export function endGameByTurnLimit(ctx: Ctx): void {
  finish(ctx, [], true, 'turnLimit');
}
