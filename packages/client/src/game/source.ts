import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import type { GameView, LegalView } from '@psi-wars/engine';

export type SeatKind = 'local' | 'remote' | 'ai';

export interface SeatInfo {
  seat: Seat;
  name: string;
  kind: SeatKind;
  aiLevel?: 'easy' | 'normal' | 'hard';
}

export interface Update {
  /** Events since the last update, unfiltered for local sources (filter per viewer before display). */
  events: GameEvent[];
}

/**
 * What the UI talks to. Implemented by LocalGame (hot-seat / vs AI: engine in the browser)
 * and later by RemoteGame (server-authoritative over WebSocket). The UI only ever sees
 * filtered views and legal-action lists — never the raw state.
 */
export interface GameSource {
  readonly seats: SeatInfo[];
  view(viewer: Seat | null): GameView;
  legal(seat: Seat): LegalView | null;
  send(seat: Seat, cmd: Command): Promise<{ ok: true } | { ok: false; error: string }>;
  onUpdate(cb: (u: Update) => void): () => void;
  /** Events filtered for a viewer (redacts private information). */
  eventsFor(events: GameEvent[], viewer: Seat | null): GameEvent[];
  /** Full replayable log (seed + commands), for export. */
  exportLog?(): unknown;
  dispose(): void;
}
