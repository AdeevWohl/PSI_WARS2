import { ABILITIES, PROTOCOL_VERSION, type GameEvent, type Seat } from '@psi-wars/shared';
import { baseValue, isX, unitStrength } from './stats';
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
  /**
   * Current strengths of every unit in play, computed by the engine (base + Equipment +
   * modifiers + Commander auras while attacking). 'X' = an X value not yet rolled this turn.
   */
  unitStats: Record<string, UnitStats>;
}

export interface UnitStats {
  cyber: number | 'X';
  psionic: number | 'X';
  physical: number | 'X';
  attacking: boolean;
}

export function unitStatsFor(s: GameState): Record<string, UnitStats> {
  const attacking = new Set((s.battle?.attacks ?? []).filter((a) => a.status === 'pending').flatMap((a) => a.units));
  const out: Record<string, UnitStats> = {};
  for (const p of s.players) {
    for (const uid of [...p.lab, ...p.trapped]) {
      const att = attacking.has(uid);
      const st = { attacking: att } as UnitStats;
      for (const ab of ABILITIES) st[ab] = isX(s, uid, ab) && baseValue(s, uid, ab) === null ? 'X' : unitStrength(s, uid, ab, att);
      out[uid] = st;
    }
  }
  return out;
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
    unitStats: unitStatsFor(s),
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
