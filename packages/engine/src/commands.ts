import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import { validateCommand } from './legal';
import { performDiscardEquipment, performMoveEquipment, performPlay } from './plays';
import { card, emit } from './state';
import { push, run } from './tasks';
import { concede } from './victory';
import type { Ctx, GameState } from './types';
import { onStackFormed, performActivate } from './v04';

/**
 * Deep-clone the mutable part of a state. Card definitions and rules are immutable and
 * shared. The state is plain JSON data by design, and a JSON round-trip is ~2x faster
 * than structuredClone here.
 */
export function cloneState(state: GameState): GameState {
  const { defs, rules, ...rest } = state;
  return { ...JSON.parse(JSON.stringify(rest)), defs, rules } as GameState;
}

/** Run pending tasks from a hand-built state until the next prompt (used by tests and tools). */
export function advance(state: GameState): { state: GameState; events: GameEvent[] } {
  const s = cloneState(state);
  const ctx: Ctx = { s, events: [] };
  run(ctx);
  return { state: s, events: ctx.events };
}

export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };

/**
 * Apply one command for one seat. Pure: the input state is never mutated.
 * Clients, servers, the AI and the simulator all go through this function.
 */
export function applyCommand(state: GameState, seat: Seat, cmd: Command): ApplyResult {
  const err = validateCommand(state, seat, cmd);
  if (err) return { ok: false, error: err };
  const s = cloneState(state);
  const ctx: Ctx = { s, events: [] };
  s.commandCount++;

  if (cmd.type === 'Concede') {
    concede(ctx, seat);
    if (!s.result) run(ctx);
    return { ok: true, state: s, events: ctx.events };
  }

  const p = s.prompt!;
  s.prompt = null;
  switch (cmd.type) {
    case 'PlayCard':
      performPlay(ctx, seat, p, cmd);
      break;
    case 'MoveEquipment':
      performMoveEquipment(ctx, seat, cmd.equip, cmd.to, cmd.payment);
      push(ctx, p.resume);
      break;
    case 'DiscardEquipment':
      performDiscardEquipment(ctx, seat, cmd.equip);
      push(ctx, p.resume);
      break;
    case 'Stack': {
      const a = card(s, cmd.a);
      const b = card(s, cmd.b);
      a.stackPartner = b.uid;
      b.stackPartner = a.uid;
      emit(ctx, { type: 'Stacked', seat, uids: [a.uid, b.uid] });
      push(ctx, p.resume);
      onStackFormed(ctx, a.uid, b.uid);
      break;
    }
    case 'Activate':
      if (p.kind === 'priority') push(ctx, { ...p.resume, answer: cmd });
      else push(ctx, p.resume);
      performActivate(ctx, seat, cmd);
      break;
    case 'Unstack': {
      const a = card(s, cmd.uid);
      const b = card(s, a.stackPartner!);
      a.stackPartner = null;
      b.stackPartner = null;
      emit(ctx, { type: 'Unstacked', seat, uids: [a.uid, b.uid], reason: 'chosen' });
      push(ctx, p.resume);
      break;
    }
    case 'AdvancePhase':
      emit(ctx, { type: 'PhaseEndRequested', seat, phase: s.phase });
      break;
    default:
      push(ctx, { ...p.resume, answer: cmd });
  }
  run(ctx);
  return { ok: true, state: s, events: ctx.events };
}
