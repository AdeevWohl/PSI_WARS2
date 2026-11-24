import type { Command } from '@psi-wars/shared';
import { EngineError, player } from './state';
import type { Ctx, Prompt, Task } from './types';

/**
 * The engine is a small interpreter over `state.tasks`, a serialisable continuation
 * stack. Handlers pop a task, change state, emit events, push follow-up tasks, or
 * stop at a prompt. Because every pending step is plain data, a game can be
 * snapshotted at any prompt and resumed byte-identically (netcode, hibernation, replay).
 */
export type Handler = (ctx: Ctx, t: Task) => void;

const handlers: Record<string, Handler> = {};

export function register(k: string, h: Handler): void {
  handlers[k] = h;
}

export function push(ctx: Ctx, t: Task): void {
  ctx.s.tasks.push(t);
}

/** Push several tasks so they run in the given order. */
export function pushSeq(ctx: Ctx, ts: Task[]): void {
  for (let i = ts.length - 1; i >= 0; i--) ctx.s.tasks.push(ts[i]!);
}

export function run(ctx: Ctx): void {
  const s = ctx.s;
  let guard = 0;
  while (!s.prompt && !s.result && s.tasks.length > 0) {
    if (++guard > 200_000) throw new EngineError('task loop did not settle');
    const t = s.tasks.pop()!;
    const h = handlers[t.k];
    if (!h) throw new EngineError(`no handler for task ${t.k}`);
    h(ctx, t);
  }
  if (!s.prompt && !s.result) throw new EngineError('soft-lock: no prompt, no result and no tasks');
}

/** Default answer for every prompt kind — the "valid default" that prevents soft-locks. */
export function defaultCommandFor(p: Prompt): Command {
  switch (p.kind) {
    case 'main':
      return { type: 'AdvancePhase' };
    case 'declareAttackers':
      return { type: 'DeclareAttackers', attacks: [] };
    case 'declareBlockers':
      return { type: 'AssignBlockers', blocks: [] };
    case 'priority':
      return { type: 'Pass' };
    case 'optionalRoll':
      return { type: 'UseAbility', use: false };
    case 'reroll':
      return { type: 'ChooseReroll', reroll: false };
    case 'oracle':
      return { type: 'ChooseFromList', choice: 'keep' };
    case 'decide':
      return { type: 'ChooseFromList', choice: (p.options ?? []).includes(null) ? null : (p.options?.[0] ?? null) };
    case 'chooseCard':
    case 'battleOrder': {
      const opts = p.options ?? [];
      const first = opts.find((o) => o !== null);
      return { type: 'ChooseFromList', choice: first ?? null };
    }
  }
}

/** Open a prompt. If its owner has been eliminated, answer it with the default at once. */
export function ask(ctx: Ctx, p: Prompt): void {
  if (player(ctx.s, p.seat).eliminated) {
    push(ctx, { ...p.resume, answer: defaultCommandFor(p) });
    return;
  }
  ctx.s.prompt = p;
}
