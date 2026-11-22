import { PROTOCOL_VERSION, type GameEvent, type Seat } from '@psi-wars/shared';
import type { BattleState, CardDef, CardInstance, GameConfig, GameResult, GameState, PromptKind, StackItem, TurnEffect } from './types';

export type CardInstanceView = Omit<CardInstance, never>;

export interface PlayerView {
  seat: Seat;
  name: string;
  labHP: number;
  eliminated: boolean;
  handCount: number;
  /** Full hand for the viewer only; null for everyone else. */
  hand: string[] | null;
  battleDeckCount: number;
  resourceDeckCount: number;
  discard: string[];
  lab: string[];
  cus: string[];
  trapped: string[];
}

export interface PromptView {
  seat: Seat;
  kind: PromptKind;
  label: string;
  /** Present only for the prompt's owner. */
  options?: (string | null)[];
  info?: Record<string, unknown>;
  allowed?: 'traps' | 'powers';
}

export interface GameView {
  protocol: number;
  viewer: Seat | null;
  config: Pick<GameConfig, 'startingHP' | 'diceVariant'>;
  turn: GameState['turn'];
  phase: GameState['phase'];
  step: GameState['step'];
  players: PlayerView[];
  /** Only cards the viewer may see. Hidden cards are never sent, not even their uids. */
  cards: Record<string, CardInstanceView>;
  battle: BattleState | null;
  stack: StackItem[];
  turnEffects: TurnEffect[];
  prompt: PromptView | null;
  result: GameResult | null;
  commandCount: number;
  defs: Record<string, CardDef>;
}

const PUBLIC_ZONES = new Set(['lab', 'cus', 'trapped', 'discard', 'attached', 'stack']);

/**
 * Per-seat filtered view (build prompt §4.2): own hand in full, other hands as counts,
 * deck order never. `viewer` null = spectator (public information only).
 */
export function viewFor(s: GameState, viewer: Seat | null): GameView {
  const cards: Record<string, CardInstanceView> = {};
  for (const c of Object.values(s.cards)) {
    if (PUBLIC_ZONES.has(c.zone) || (c.zone === 'hand' && c.owner === viewer)) cards[c.uid] = structuredClone(c);
  }
  let prompt: PromptView | null = null;
  if (s.prompt) {
    const p = s.prompt;
    prompt = { seat: p.seat, kind: p.kind, label: p.label };
    if (p.allowed) prompt.allowed = p.allowed;
    if (p.seat === viewer) {
      if (p.options) prompt.options = [...p.options];
      if (p.info) prompt.info = structuredClone(p.info);
      // Choices drawn from hidden zones (search, tutor) become visible to the chooser only.
      for (const o of p.options ?? []) {
        const c = o ? s.cards[o] : undefined;
        if (c) cards[c.uid] = structuredClone(c);
      }
    } else if (p.kind === 'priority' && p.info) {
      prompt.info = { point: p.info.point, stack: p.info.stack };
    }
  }
  return {
    protocol: PROTOCOL_VERSION,
    viewer,
    config: { startingHP: s.config.startingHP, diceVariant: s.config.diceVariant },
    turn: { ...s.turn },
    phase: s.phase,
    step: s.step,
    players: s.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      labHP: p.labHP,
      eliminated: p.eliminated,
      handCount: p.hand.length,
      hand: p.seat === viewer ? [...p.hand] : null,
      battleDeckCount: p.battleDeck.length,
      resourceDeckCount: p.resourceDeck.length,
      discard: [...p.discard],
      lab: [...p.lab],
      cus: [...p.cus],
      trapped: [...p.trapped],
    })),
    cards,
    battle: s.battle ? structuredClone(s.battle) : null,
    stack: s.stack.map((x) => ({ ...x })),
    turnEffects: structuredClone(s.turnEffects),
    prompt,
    result: s.result ? structuredClone(s.result) : null,
    commandCount: s.commandCount,
    defs: s.defs,
  };
}

/** Filter an event stream for one seat: private events are replaced by their redacted form. */
export function filterEvents(events: GameEvent[], viewer: Seat | null): GameEvent[] {
  const out: GameEvent[] = [];
  for (const ev of events) {
    let e: GameEvent | undefined = ev;
    if (ev.to && (viewer === null || !ev.to.includes(viewer))) e = ev.redacted;
    if (!e) continue;
    const { to: _to, redacted: _r, ...rest } = e;
    out.push(rest as GameEvent);
  }
  return out;
}
