/**
 * Wire protocol between clients and a game server (Cloudflare Durable Object or the local
 * Node server — both speak exactly this). JSON over WebSocket. Every server message about the
 * game carries a monotonically increasing `seq`; clients that see a gap send `resync`.
 */
import type { Command, GameEvent, Seat } from './index';

/** Unambiguous alphabet: no 0/O, 1/I/L. */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isRoomCode(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && [...code].every((ch) => ROOM_ALPHABET.includes(ch));
}

/** Generate a code from any source of random bytes (crypto.getRandomValues). */
export function makeRoomCode(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH * 2);
  let out = '';
  for (let i = 0; out.length < ROOM_CODE_LENGTH && i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 248) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length]; // 248 = 8 * 31: unbiased
  }
  return out.length === ROOM_CODE_LENGTH ? out : makeRoomCode(randomBytes);
}

export type AiLevelName = 'easy' | 'normal' | 'hard';

export interface DeckPayload {
  name: string;
  battle: Record<string, number>;
  resource: Record<string, number>;
}

export interface RoomConfig {
  seats: number; // 2..4
  startingHP: number;
  diceVariant: 'standard' | 'noModifier';
  trapWindowSec: number;
  fastWindows: boolean;
  turnTimerSec: number; // 0 = off
}

export interface LobbySeat {
  seat: Seat;
  kind: 'open' | 'human' | 'ai';
  name: string;
  aiLevel?: AiLevelName;
  deckName?: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  /** Epoch ms when a disconnected human's seat stops being held (server clock). */
  graceUntil?: number;
}

export interface LobbyState {
  code: string;
  phase: 'lobby' | 'game' | 'ended';
  config: RoomConfig;
  seats: LobbySeat[];
  /** A card balance overlay the host chose for this room (null = the standard cards). */
  balance?: { name: string; cards: number; changes: string[] } | null;
}

/** A countdown the server enforces (response window, turn timer). */
export interface Deadline {
  seat: Seat;
  kind: 'response' | 'turn';
  at: number; // server epoch ms
}

// ---------- client -> server ----------

export type ClientMsg =
  | { t: 'hello'; protocol: number; clientId: string; name: string; seat?: Seat }
  | { t: 'setName'; name: string }
  | { t: 'setDeck'; deck: DeckPayload }
  | { t: 'takeSeat'; seat: Seat }
  | { t: 'ready'; ready: boolean }
  | { t: 'config'; config: Partial<RoomConfig> }
  | { t: 'seatAi'; seat: Seat; level: AiLevelName | null }
  | { t: 'kick'; seat: Seat }
  | { t: 'start' }
  | { t: 'cmd'; cid: number; command: Command }
  | { t: 'replaceWithAi'; seat: Seat; level: AiLevelName }
  | { t: 'resync' }
  /** Host, in the lobby: play this room under a balance overlay from the card editor (null = standard). */
  | { t: 'setBalance'; balance: unknown | null }
  /** After the game ends: the full replayable log (seed, commands, card data). */
  | { t: 'getLog' }
  | { t: 'ping'; at: number };

// ---------- server -> client ----------

export type ServerMsg =
  | { t: 'welcome'; protocol: number; code: string; clientId: string; seat: Seat | null; isHost: boolean; serverTime: number }
  | { t: 'lobby'; lobby: LobbyState; serverTime: number }
  | { t: 'error'; code: string; message: string; fatal?: boolean }
  | { t: 'ack'; cid: number; ok: boolean; error?: string }
  /** Full filtered state for this seat: on join, game start, resync, reconnect. */
  | { t: 'snapshot'; seq: number; view: unknown; legal: unknown | null; deadline: Deadline | null; serverTime: number; log: GameEvent[] }
  /** Incremental update: filtered events + a patch of this seat's view since the last message. */
  | { t: 'update'; seq: number; events: GameEvent[]; patch: ViewPatch; legal: unknown | null; deadline: Deadline | null; serverTime: number }
  | { t: 'deadline'; seq: number; deadline: Deadline | null; serverTime: number }
  | { t: 'graceExpired'; seat: Seat; name: string }
  | { t: 'pong'; at: number; serverTime: number }
  | { t: 'log'; log: unknown };

/**
 * A shallow patch of a view object: `set` replaces top-level keys; `maps` patches keyed maps
 * (cards, unitStats) entry by entry, null = delete. Keeps messages small (§4.3).
 */
export interface ViewPatch {
  set: Record<string, unknown>;
  maps: Record<string, Record<string, unknown | null>>;
}

const MAP_KEYS = ['cards', 'unitStats'];
const SKIP = ['defs'];

export function diffView(prev: Record<string, any> | null, next: Record<string, any>): ViewPatch {
  const patch: ViewPatch = { set: {}, maps: {} };
  for (const k of Object.keys(next)) {
    if (SKIP.includes(k)) continue;
    if (MAP_KEYS.includes(k) && prev && prev[k]) {
      const a = prev[k] as Record<string, unknown>;
      const b = next[k] as Record<string, unknown>;
      const m: Record<string, unknown | null> = {};
      for (const id of Object.keys(b)) if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) m[id] = b[id];
      for (const id of Object.keys(a)) if (!(id in b)) m[id] = null;
      if (Object.keys(m).length) patch.maps[k] = m;
      continue;
    }
    if (!prev || JSON.stringify(prev[k]) !== JSON.stringify(next[k])) patch.set[k] = next[k];
  }
  return patch;
}

export function applyViewPatch<T extends Record<string, any>>(view: T, patch: ViewPatch): T {
  const out: Record<string, any> = { ...view, ...patch.set };
  for (const [k, m] of Object.entries(patch.maps)) {
    const base = { ...(view[k] ?? {}) };
    for (const [id, v] of Object.entries(m)) {
      if (v === null) delete base[id];
      else base[id] = v;
    }
    out[k] = base;
  }
  return out as T;
}
