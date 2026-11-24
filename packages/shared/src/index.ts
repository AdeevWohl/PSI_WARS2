/**
 * Shared protocol types: commands clients send, events the engine emits,
 * and the protocol version. Imported by engine, client and both servers.
 */

/** Bump whenever a command, event or view shape changes incompatibly. */
export const PROTOCOL_VERSION = 4;

export type Seat = number;
export type Ability = 'cyber' | 'psionic' | 'physical';
export const ABILITIES: readonly Ability[] = ['cyber', 'psionic', 'physical'];
export type CUType = 'G' | 'B' | 'R' | 'P';
export const CU_TYPES: readonly CUType[] = ['G', 'B', 'R', 'P'];

/** Which CU types to destroy for a card's white cost. Depletion is fixed by the card's coloured cost. */
export interface Payment {
  destroy: Partial<Record<CUType, number>>;
  /** For each "pay one of these" choice light, the type depleted (Change Request 1, B5). */
  choice?: CUType[];
  /** Types depleted for the "pay any" cost (B5). */
  any?: Partial<Record<CUType, number>>;
  /** v0.4: type destroyed for each extra burn component. */
  burns?: CUType[];
  /** v0.4.1: the exact Creation Units chosen (ready, yours, distinct). Their types must form this payment. */
  pick?: { deplete: string[]; burn: string[] };
}

export interface AttackDeclaration {
  /** A ready Battle Unit; if it is stacked, its partner attacks with it. */
  uid: string;
  /** The opponent this attacker targets (house rule A: per unit). */
  target: Seat;
}

export interface BlockAssignment {
  /** A defending Battle Unit (its stack partner blocks with it). */
  blocker: string;
  /** The attack id (the attacking unit's uid as declared). */
  attacker: string;
}

/**
 * Every player action is a command. Spec §C3 lists ChoosePayment, ChooseTarget and
 * PlayPower separately; here payment and target ride on PlayCard (one atomic command),
 * and PlayCard covers Power and Trap cards too.
 */
export type Command =
  | { type: 'PlayCard'; uid: string; target?: string; payment?: Payment }
  | { type: 'MoveEquipment'; equip: string; to: string; payment?: Payment }
  | { type: 'Activate'; uid: string; ability: string; payment?: Payment }
  | { type: 'DiscardEquipment'; equip: string }
  | { type: 'Stack'; a: string; b: string }
  | { type: 'Unstack'; uid: string }
  | { type: 'DeclareAttackers'; attacks: AttackDeclaration[] }
  | { type: 'AssignBlockers'; blocks: BlockAssignment[] }
  | { type: 'Pass' }
  | { type: 'UseAbility'; use: boolean }
  | { type: 'ChooseReroll'; reroll: boolean }
  | { type: 'ChooseFromList'; choice: string | null }
  | { type: 'AdvancePhase' }
  | { type: 'Concede' };

export type CommandType = Command['type'];

/**
 * Engine events. `to` restricts the full event to some seats; everyone else
 * receives `redacted` (or nothing). Per-seat filtering strips both fields.
 */
export interface GameEvent {
  type: string;
  to?: Seat[];
  redacted?: GameEvent;
  [k: string]: unknown;
}

export * from './protocol';
