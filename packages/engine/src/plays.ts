import type { Command, Payment } from '@psi-wars/shared';
import { EFFECTS } from './effects';
import { autoPayment, canAfford, enumeratePayments, isValidPayment, pay, shortfall, ZERO_COST } from './payment';
import { canHoldEquipment } from './stats';
import { card, defOf, emit, moveCard, player, turnOrderFrom } from './state';
import { push } from './tasks';
import type { CardDef, Ctx, GameState, Prompt, Seat, Task } from './types';
import { openWindow } from './windows';

export interface PlayOption {
  uid: string;
  cardId: string;
  /** Legal targets, or null if the card takes none. */
  targets: string[] | null;
  /** Distinct legal payments (by CU type destroyed). */
  payments: Payment[];
  /** Auto-pay suggestion that preserves the most flexible CUs (§C3). */
  suggested: Payment | null;
}

const CU_NAME: Record<string, string> = { G: 'Digital Splicing', B: 'Neurogenesis', R: 'Bio-Acceleration', P: 'Material Animation', W: 'Creation Unit to destroy' };

/** Why each hand card cannot be played right now — shown as a tooltip on dimmed cards (§8). */
export function unplayableReasons(s: GameState, seat: Seat, p: Prompt): Record<string, string> {
  const types = allowedTypes(p);
  const playable = new Set(playOptions(s, seat, p).map((o) => o.uid));
  const out: Record<string, string> = {};
  for (const uid of player(s, seat).hand) {
    if (playable.has(uid)) continue;
    const d = defOf(s, uid);
    if (!types.has(d.cardType)) {
      out[uid] = types.size === 0 ? 'Finish the current decision first' : types.has('Power') ? 'Only Power cards can be played now' : types.has('Trap') ? 'Only Traps can be played now' : 'Not playable now';
      continue;
    }
    const short = shortfall(s, seat, d.cost ?? ZERO_COST);
    if (short.length) {
      const units = (n: number) => `${n} more Creation Unit${n > 1 ? 's' : ''}`;
      out[uid] = 'Needs ' + short.map((x) =>
        x.type === 'W' ? `${units(x.missing)} to destroy`
        : x.type === 'A' ? `${units(x.missing)} of any type to deplete`
        : x.type === 'choice' ? `1 ${(x.options ?? []).map((t) => CU_NAME[t]).join(' or ')}`
        : `${x.missing} more ${CU_NAME[x.type]}`).join(', ');
      continue;
    }
    if (d.cardType === 'Equipment') out[uid] = `No unit can hold it (needs an un-equipped ${d.equip?.allowed.join(' or ')} with ${d.equip?.ability} above 0)`;
    else if (d.cardType === 'Trap') out[uid] = 'No opposing unit to target';
    else out[uid] = 'Nothing for it to do right now';
  }
  return out;
}

/** Which card types a prompt allows from hand. Only Traps are instant (house rule L). */
function allowedTypes(p: Prompt): Set<string> {
  switch (p.kind) {
    case 'main':
      return new Set(['BattleUnit', 'Equipment', 'Power', 'Trap', 'Resource']);
    case 'declareAttackers':
    case 'declareBlockers':
      return new Set(['Trap']);
    case 'priority':
      return p.allowed === 'powers' ? new Set(['Power', 'Trap']) : new Set(['Trap']);
    default:
      return new Set();
  }
}

export function equipTargets(s: GameState, seat: Seat, equipCardId: string): string[] {
  return player(s, seat).lab.filter((u) => canHoldEquipment(s, u, equipCardId));
}

function powerPlayable(s: GameState, seat: Seat, uid: string, d: CardDef): { ok: boolean; targets: string[] | null } {
  let targets: string[] | null = null;
  for (const e of d.effects) {
    if (e.trigger !== 'OnPlay') continue;
    const impl = EFFECTS[e.effect];
    if (!impl) continue;
    if (impl.canPlay && !impl.canPlay(s, seat, uid, e.params)) return { ok: false, targets: null };
    if (impl.targets) targets = impl.targets(s, seat, uid, e.params);
  }
  if (targets && targets.length === 0) return { ok: false, targets: null };
  return { ok: true, targets };
}

export function playOptions(s: GameState, seat: Seat, p: Prompt): PlayOption[] {
  const types = allowedTypes(p);
  if (types.size === 0) return [];
  const out: PlayOption[] = [];
  for (const uid of player(s, seat).hand) {
    const d = defOf(s, uid);
    if (!types.has(d.cardType)) continue;
    if (d.cardType === 'Resource') {
      if (d.effects.some((e) => e.effect === 'FortifyResource')) {
        const targets = player(s, seat).cus.filter((u) => !card(s, u).equipment);
        if (targets.length === 0) continue;
        out.push({ uid, cardId: d.id, targets, payments: [{ destroy: {} }], suggested: { destroy: {} } });
        continue;
      }
      out.push({ uid, cardId: d.id, targets: null, payments: [{ destroy: {} }], suggested: { destroy: {} } });
      continue;
    }
    const cost = d.cost ?? ZERO_COST;
    if (!canAfford(s, seat, cost)) continue;
    let targets: string[] | null = null;
    if (d.cardType === 'Equipment') {
      targets = equipTargets(s, seat, d.id);
      if (targets.length === 0) continue;
    } else if (d.cardType === 'Power' || d.cardType === 'Trap') {
      const r = powerPlayable(s, seat, uid, d);
      if (!r.ok) continue;
      targets = r.targets;
    }
    out.push({ uid, cardId: d.id, targets, payments: enumeratePayments(s, seat, cost), suggested: autoPayment(s, seat, cost) });
  }
  return out;
}

export function validatePlay(s: GameState, seat: Seat, p: Prompt, cmd: Extract<Command, { type: 'PlayCard' }>): string | null {
  const opt = playOptions(s, seat, p).find((o) => o.uid === cmd.uid);
  if (!opt) return 'card is not playable now';
  if (opt.targets) {
    if (!cmd.target || !opt.targets.includes(cmd.target)) return 'illegal or missing target';
  }
  const d = defOf(s, cmd.uid);
  if (cmd.payment && d.cost && !isValidPayment(s, seat, d.cost, cmd.payment)) return 'illegal payment';
  return null;
}

/** Perform a validated PlayCard. `resume` is the prompt's continuation. */
export function performPlay(ctx: Ctx, seat: Seat, p: Prompt, cmd: Extract<Command, { type: 'PlayCard' }>): void {
  const s = ctx.s;
  const d = defOf(s, cmd.uid);
  const c = card(s, cmd.uid);
  const resume: Task = p.resume;

  if (d.cardType === 'Resource' && d.effects.some((e) => e.effect === 'FortifyResource')) {
    const target = cmd.target!;
    moveCard(ctx, cmd.uid, 'attached');
    c.attachedTo = target;
    card(s, target).equipment = cmd.uid;
    emit(ctx, { type: 'CardPlayed', seat, uid: cmd.uid, cardId: d.id, cardType: d.cardType, target });
    emit(ctx, { type: 'ResourceFortified', seat, uid: cmd.uid, cardId: d.id, cu: target });
    push(ctx, resume);
    return;
  }
  if (d.cardType === 'Resource') {
    moveCard(ctx, cmd.uid, 'discard');
    emit(ctx, { type: 'CardPlayed', seat, uid: cmd.uid, cardId: d.id, cardType: d.cardType });
    push(ctx, resume);
    for (const e of [...d.effects].reverse()) {
      if (e.trigger === 'OnPlay') push(ctx, { k: 'effect', effect: e.effect, controller: seat, source: cmd.uid, params: e.params });
    }
    return;
  }

  const cost = d.cost ?? ZERO_COST;
  const payment = cmd.payment ?? autoPayment(s, seat, cost)!;
  pay(ctx, seat, cost, payment, cmd.uid);

  if (d.cardType === 'BattleUnit') {
    moveCard(ctx, cmd.uid, 'lab');
    c.depleted = false; // Q&A change 2: no summoning sickness
    c.enteredThisTurn = true;
    emit(ctx, { type: 'CardPlayed', seat, uid: cmd.uid, cardId: d.id, cardType: d.cardType });
    push(ctx, resume);
    openWindow(ctx, 'afterCardPlayed', 'traps', othersFrom(s, seat));
    return;
  }

  if (d.cardType === 'Equipment') {
    const target = cmd.target!;
    moveCard(ctx, cmd.uid, 'attached');
    c.attachedTo = target;
    card(s, target).equipment = cmd.uid;
    emit(ctx, { type: 'CardPlayed', seat, uid: cmd.uid, cardId: d.id, cardType: d.cardType, target });
    emit(ctx, { type: 'EquipmentAttached', seat, uid: cmd.uid, cardId: d.id, unit: target });
    push(ctx, resume);
    openWindow(ctx, 'afterCardPlayed', 'traps', othersFrom(s, seat));
    return;
  }

  // Power / Trap: onto the stack; resolves when everyone passes (house rule K).
  moveCard(ctx, cmd.uid, 'stack');
  s.stack.push({ uid: cmd.uid, controller: seat, target: cmd.target ?? null });
  emit(ctx, { type: 'CardPlayed', seat, uid: cmd.uid, cardId: d.id, cardType: d.cardType, target: cmd.target ?? null, onStack: true });
  if (p.kind === 'priority') {
    push(ctx, { ...resume, answer: cmd });
  } else {
    push(ctx, resume);
    const order = [...othersFrom(s, seat), seat];
    push(ctx, { k: 'window', point: 'response', allowed: 'traps', order, idx: 0, passes: 0, stackBase: s.stack.length - 1 });
  }
}

/** Other live players in turn order starting after `seat`. */
export function othersFrom(s: GameState, seat: Seat): Seat[] {
  return turnOrderFrom(s, seat).filter((x) => x !== seat);
}

// --- Equipment management (Q&A change 4) ---

export function movableEquipment(s: GameState, seat: Seat): { equip: string; to: string[] }[] {
  const out: { equip: string; to: string[] }[] = [];
  for (const u of player(s, seat).lab) {
    const eq = card(s, u).equipment;
    if (!eq) continue;
    const to = equipTargets(s, seat, card(s, eq).cardId).filter((x) => x !== u);
    if (to.length) out.push({ equip: eq, to });
  }
  return out;
}

export function discardableEquipment(s: GameState, seat: Seat): string[] {
  return player(s, seat).lab.map((u) => card(s, u).equipment).filter((e): e is string => !!e);
}

export function performMoveEquipment(ctx: Ctx, seat: Seat, equip: string, to: string): void {
  const s = ctx.s;
  const e = card(s, equip);
  const from = e.attachedTo!;
  card(s, from).equipment = null;
  e.attachedTo = to;
  card(s, to).equipment = equip;
  emit(ctx, { type: 'EquipmentMoved', seat, uid: equip, cardId: e.cardId, fromUnit: from, toUnit: to });
}

export function performDiscardEquipment(ctx: Ctx, seat: Seat, equip: string): void {
  const s = ctx.s;
  const e = card(s, equip);
  if (e.attachedTo) card(s, e.attachedTo).equipment = null;
  moveCard(ctx, equip, 'discard');
  emit(ctx, { type: 'EquipmentDiscarded', seat, uid: equip, cardId: e.cardId, reason: 'chosen' });
}
