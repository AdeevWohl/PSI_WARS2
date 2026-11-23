import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import { applyCommand, createGame, filterEvents, getLegalView, makeLog, viewFor, type GameSetup, type GameState } from '@psi-wars/engine';
import { activeBalance } from '../balance';
import type { GameSource, SeatInfo, Update } from './source';

/**
 * The engine running in the browser: hot-seat and solo-vs-AI. Same engine package as the
 * servers and the simulator, so behaviour is identical everywhere.
 */
export class LocalGame implements GameSource {
  private state: GameState;
  private listeners = new Set<(u: Update) => void>();
  private commands: { seat: Seat; cmd: Command }[] = [];
  readonly allEvents: GameEvent[] = [];
  /** The balance overlay this game was created under (for the log). */
  private balance = activeBalance();

  constructor(
    readonly seats: SeatInfo[],
    private setup: GameSetup,
  ) {
    const g = createGame(setup);
    this.state = g.state;
    this.allEvents.push(...g.events);
  }

  /** Events produced while creating the game (setup, first-player roll, opening draws). */
  initialEvents(): GameEvent[] {
    return [...this.allEvents];
  }

  view(viewer: Seat | null) {
    return viewFor(this.state, viewer);
  }

  legal(seat: Seat) {
    return getLegalView(this.state, seat);
  }

  get raw(): GameState {
    return this.state;
  }

  async send(seat: Seat, cmd: Command) {
    const r = applyCommand(this.state, seat, cmd);
    if (!r.ok) return { ok: false as const, error: r.error };
    this.state = r.state;
    this.commands.push({ seat, cmd });
    this.allEvents.push(...r.events);
    for (const l of this.listeners) l({ events: r.events });
    return { ok: true as const };
  }

  onUpdate(cb: (u: Update) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  eventsFor(events: GameEvent[], viewer: Seat | null) {
    return filterEvents(events, viewer);
  }

  exportLog() {
    return makeLog(this.setup, this.commands, this.allEvents, this.state, {
      balance: this.balance ? { name: this.balance.name, cards: this.balance.cards } : null,
      kinds: this.seats.map((s) => (s.kind === 'ai' ? `ai-${s.aiLevel ?? 'normal'}` : 'human')),
      createdAt: new Date().toISOString(),
    });
  }

  dispose() {
    this.listeners.clear();
  }
}

export function randomSeed(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${a[0]!.toString(36)}${a[1]!.toString(36)}`;
}
