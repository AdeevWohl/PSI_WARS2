import type { Command } from '@psi-wars/shared';
import { EFFECTS } from './effects';
import { playOptions } from './plays';
import { card, defOf, emit, moveCard, player, turnOrderFrom } from './state';
import { ask, push, register } from './tasks';
import type { Ctx, Seat, Task } from './types';
import { activations } from './v04';

/**
 * Priority windows. A window polls players in order; each may play an allowed card
 * (which goes on the stack, and the player keeps priority — §A8 step 3) or pass.
 * When every live player has passed in succession, the top of the stack resolves
 * (last played first — house rule K) and polling restarts; with the stack back at
 * its base, the window closes.
 *
 * The engine never times out a window: the server applies the ~3 s response window
 * (house rule M) by sending Pass on expiry. `config.autoPassNoPlay` skips seats with
 * no legal play — fast, but it leaks information (the "fast windows" setting).
 */
export interface WindowTask extends Task {
  k: 'window';
  point: string;
  allowed: 'traps' | 'powers';
  order: Seat[];
  idx: number;
  passes: number;
  stackBase: number;
}

export function openWindow(ctx: Ctx, point: string, allowed: 'traps' | 'powers', order: Seat[]): void {
  const enabled = point === 'battlePower' || ctx.s.rules.instantWindows[point] !== false;
  if (!enabled || order.length === 0) return;
  push(ctx, { k: 'window', point, allowed, order, idx: 0, passes: 0, stackBase: ctx.s.stack.length } satisfies WindowTask);
}

function hasPlay(ctx: Ctx, seat: Seat, allowed: 'traps' | 'powers', point = ''): boolean {
  const fake = { seat, kind: 'priority' as const, label: '', allowed, resume: { k: 'noop' } };
  return playOptions(ctx.s, seat, fake).length > 0 || activations(ctx.s, seat, { ...fake, info: { point } }).length > 0;
}

register('window', (ctx, raw) => {
  const t = raw as WindowTask;
  const s = ctx.s;
  const answer = t.answer as Command | undefined;
  delete t.answer;
  // With something on the stack, every live player may respond (house rule K) — including
  // players a phase-point window does not normally poll, such as the trap target's owner.
  const live = () => {
    const base = t.order.filter((seat) => !player(s, seat).eliminated);
    if (s.stack.length <= t.stackBase) return base;
    const extra = turnOrderFrom(s, s.turn.active).filter((seat) => !base.includes(seat));
    return [...base, ...extra];
  };

  if (answer) {
    const order = live();
    if (answer.type === 'Pass') {
      emit(ctx, { type: 'PriorityPassed', seat: order[t.idx % Math.max(order.length, 1)] ?? null, point: t.point });
      t.passes++;
      t.idx++;
    } else if (answer.type === 'PlayCard' || answer.type === 'Activate') {
      t.passes = 0; // caster keeps priority
    }
  }

  for (;;) {
    const order = live();
    if (order.length === 0) return;
    if (t.passes >= order.length) {
      if (s.stack.length > t.stackBase) {
        push(ctx, { ...t, passes: 0, idx: 0 });
        push(ctx, { k: 'resolveTop' });
      } else {
        emit(ctx, { type: 'WindowClosed', point: t.point });
      }
      return;
    }
    const seat = order[t.idx % order.length]!;
    if (s.config.autoPassNoPlay && !hasPlay(ctx, seat, t.allowed, t.point)) {
      t.passes++;
      t.idx++;
      continue;
    }
    ask(ctx, {
      seat,
      kind: 'priority',
      label: t.point === 'battlePower' ? 'Power-card window' : s.stack.length > t.stackBase ? 'Respond?' : 'Play a Trap?',
      allowed: t.allowed,
      info: { point: t.point, stack: s.stack.map((x) => ({ uid: x.uid, cardId: card(s, x.uid).cardId, controller: x.controller, target: x.target })) },
      resume: t,
    });
    return;
  }
});

register('resolveTop', (ctx) => {
  const s = ctx.s;
  // The item stays on the stack while its effects resolve (they may wait on a choice);
  // finishPower removes it. Last played resolves first (house rule K).
  const item = s.stack[s.stack.length - 1];
  if (!item) return;
  const d = defOf(s, item.uid);
  emit(ctx, { type: 'StackResolving', uid: item.uid, cardId: d.id, controller: item.controller, target: item.target, targets: item.targets ?? null, countered: !!item.countered });
  push(ctx, { k: 'finishPower', uid: item.uid });
  if (item.countered) return; // Emergency Firewall: no effect, costs stay paid
  for (const e of [...d.effects].reverse()) {
    if (e.trigger !== 'OnPlay' || !EFFECTS[e.effect]) continue;
    push(ctx, { k: 'effect', effect: e.effect, controller: item.controller, source: item.uid, params: e.params, target: item.target });
  }
});

register('finishPower', (ctx, t) => {
  const c = card(ctx.s, t.uid);
  if (c.zone === 'stack') moveCard(ctx, t.uid, 'discard');
  ctx.s.stack = ctx.s.stack.filter((x) => x.uid !== t.uid);
  emit(ctx, { type: 'StackResolved', uid: t.uid, cardId: c.cardId });
});

register('noop', () => {});
