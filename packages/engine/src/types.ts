import type { Ability, CUType, GameEvent, Seat } from '@psi-wars/shared';
import type { RngState } from './rng';

export type { Ability, CUType, GameEvent, Seat };

export type UnitType = 'Creature' | 'Robot' | 'Cyborg';
export type CardType = 'BattleUnit' | 'Equipment' | 'Power' | 'Trap' | 'CreationUnit' | 'Resource';
export type StatValue = number | 'X';

export interface Cost {
  G: number;
  B: number;
  R: number;
  P: number;
  /** Creation Units of any (eligible) type to destroy. */
  W: number;
  /** Creation Units of any type to deplete ("pay any"). */
  A?: number;
  /** "Pay one of these" lights: each entry lists the types that may be depleted for it. */
  choice?: CUType[][];
}

export interface Stats {
  cyber: StatValue;
  psionic: StatValue;
  physical: StatValue;
}

export interface EffectSpec {
  trigger: string;
  effect: string;
  params: Record<string, any>;
}

export interface CardDef {
  id: string;
  name: string;
  deck: 'battle' | 'resource';
  cardType: CardType;
  unitType?: UnitType;
  isCommander?: boolean;
  cuType?: CUType;
  cost?: Cost;
  stats?: Stats;
  equip?: { ability: Ability; bonus: number; allowed: UnitType[] };
  effects: EffectSpec[];
  text: string;
  implementation?: string;
  art?: string;
  artSource?: string;
  printed?: { cost?: Cost; stats?: Stats; hasRulesText?: boolean };
  enabled: boolean;
  origin?: string;
}

export interface DieFace {
  bonus: number;
  reroll?: boolean;
  physicalPlus?: number;
  obliterate?: boolean;
}

export type DiceTable = Record<Ability, Record<string, DieFace>>;

export interface RulesData {
  dice: { standard: DiceTable; noModifier: DiceTable; numericValue: Record<string, number> };
  setup: {
    startingHandSize: number;
    startingHP: { default: number; presets: number[]; min: number; max: number };
    firstPlayerSkipsBattleDraw: boolean;
  };
  deckLimits: {
    battle: { min: number; max: number; minBattleUnits: number; maxCopies: number };
    resource: { min: number; max: number; maxCreationUnits: number; maxPerCUType: number; maxCopiesNonCU: number };
  };
  houseRules: Record<string, string | number | boolean>;
  /** Change Request 1 combat rules (absent in old data = the new defaults). */
  combat?: {
    /** Losing the Psionic battle disorients, like losing the Cyber battle (B1). */
    psionicLossDisorients?: boolean;
    /** Unit types instantly Disoriented with 0 in the ability against an opponent with >= 1 (B2). */
    zeroStrengthDisorients?: Partial<Record<'cyber' | 'psionic', string[]>>;
    /** A Disoriented Physical winner takes damage from the loser instead of nothing happening (B3). */
    disorientedWinnerTakesDamage?: boolean;
  };
  instantWindows: Record<string, boolean | string>;
}

export type DiceVariant = 'standard' | 'noModifier';

export interface GameConfig {
  seed: string;
  startingHP: number;
  diceVariant: DiceVariant;
  /** Skip priority prompts for seats with no legal play (house rule J/M "fast windows"). */
  autoPassNoPlay: boolean;
  /** 0 = unlimited. Exceeding it ends the game as a draw (simulator safety valve). */
  maxTurns: number;
}

export type Zone =
  | 'battleDeck'
  | 'resourceDeck'
  | 'hand'
  | 'lab'
  | 'cus'
  | 'trapped'
  | 'discard'
  | 'attached'
  | 'stack'
  | 'removed';

export interface StatMods {
  cyber: number;
  psionic: number;
  physical: number;
}

export interface CardInstance {
  uid: string;
  cardId: string;
  owner: Seat;
  zone: Zone;
  depleted: boolean;
  /** Kept for the log and the AI; no longer gates attacking (Q&A change 2). */
  enteredThisTurn: boolean;
  /** Equipment attached under this unit. */
  equipment: string | null;
  /** For Equipment and Trap cards: the unit they sit on. */
  attachedTo: string | null;
  stackPartner: string | null;
  xValue: number | null;
  tempMods: StatMods;
  /** Lasting changes while in play (e.g. a revived unit: +1 Physical, −1 Psionic). Cleared when it leaves play. */
  permMods?: StatMods;
  disoriented: boolean;
  /** Trap card uid holding this unit. */
  trappedBy: string | null;
}

export interface PlayerState {
  seat: Seat;
  name: string;
  labHP: number;
  eliminated: boolean;
  /** Index 0 is the top of the deck. */
  battleDeck: string[];
  resourceDeck: string[];
  hand: string[];
  lab: string[];
  cus: string[];
  trapped: string[];
  discard: string[];
}

export interface DieRoll {
  side: number;
  obliterated: boolean;
  history: number[];
}

export interface SideDice {
  cyber: DieRoll | null;
  psionic: DieRoll | null;
  physical: DieRoll;
}

export interface Attack {
  /** The declared unit's uid. */
  id: string;
  seat: Seat;
  units: string[];
  target: Seat;
  /** Units of the blocking fighter; empty = unblocked. */
  blockers: string[];
  status: 'pending' | 'resolved' | 'cancelled';
}

export interface Resolution {
  attackId: string;
  optional: Record<string, boolean>;
  att: SideDice | null;
  def: SideDice | null;
  occurs: { cyber: boolean; psionic: boolean } | null;
  rerollsLeft: { att: number; def: number };
  disoriented: { att: boolean; def: boolean };
  winners: { cyber: 'att' | 'def' | null; psionic: 'att' | 'def' | null; physical: 'att' | 'def' | null };
  destroyed: { att: boolean; def: boolean };
}

export interface BattleState {
  attacker: Seat;
  attacks: Attack[];
  current: Resolution | null;
}

export interface StackItem {
  uid: string;
  controller: Seat;
  target: string | null;
}

export interface TurnEffect {
  kind: 'disable';
  source: string;
  filter: Record<string, any>;
}

/** Continuation tasks: the engine is an interpreter over this serialisable stack. */
export type Task = { k: string; answer?: unknown; [key: string]: any };

export type PromptKind =
  | 'main'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'priority'
  | 'oracle'
  | 'chooseCard'
  | 'battleOrder'
  | 'optionalRoll'
  | 'reroll';

export interface Prompt {
  seat: Seat;
  kind: PromptKind;
  /** Human-readable reason, for the UI and log. */
  label: string;
  /** For list prompts: the legal choices (null = decline, when optional). */
  options?: (string | null)[];
  /** Extra context for the UI (current totals for re-roll, source card, ...). */
  info?: Record<string, unknown>;
  /** For priority windows: which cards may be played. */
  allowed?: 'traps' | 'powers';
  resume: Task;
}

export interface GameResult {
  winners: Seat[];
  draw: boolean;
  reason: string;
}

export interface GameState {
  engineVersion: number;
  defs: Record<string, CardDef>;
  rules: RulesData;
  config: GameConfig;
  rng: RngState;
  /** Test hook: forced die sides, consumed before the RNG. Never set in real games. */
  debugDice: number[];
  players: PlayerState[];
  cards: Record<string, CardInstance>;
  nextUid: number;
  turn: { number: number; active: Seat; firstPlayer: Seat };
  phase: 'setup' | 'replenish' | 'draw' | 'creation' | 'battle' | 'cleanup' | 'gameOver';
  step: 'declareAttackers' | 'declareBlockers' | 'power' | 'cyborg' | 'determination' | null;
  battle: BattleState | null;
  stack: StackItem[];
  turnEffects: TurnEffect[];
  tasks: Task[];
  prompt: Prompt | null;
  result: GameResult | null;
  /** Count of commands applied; part of the deterministic record. */
  commandCount: number;
}

export interface Ctx {
  s: GameState;
  events: GameEvent[];
}
