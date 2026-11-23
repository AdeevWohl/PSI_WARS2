/**
 * Online play: a WebSocket connection to a game server (Cloudflare Worker or the local Node
 * server — the client only knows "a server URL"). RemoteGame implements the same GameSource
 * as the local engine, so the game screen is identical online.
 *
 * - The server is authoritative: we send commands and render the filtered views it sends.
 * - Every game message has a seq; on a gap we ask for a resync (full snapshot).
 * - Dropped connections reconnect automatically with backoff and say hello again with the
 *   same client id, which puts us back in our seat.
 */
import {
  PROTOCOL_VERSION,
  applyViewPatch,
  type ClientMsg,
  type Command,
  type Deadline,
  type DeckPayload,
  type GameEvent,
  type LobbyState,
  type Seat,
  type ServerMsg,
} from '@psi-wars/shared';
import type { GameView, LegalView } from '@psi-wars/engine';
import type { GameSource, SeatInfo, Update } from '../game/source';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type Notice =
  | { kind: 'status'; status: ConnStatus }
  | { kind: 'error'; code: string; message: string; fatal: boolean }
  | { kind: 'graceExpired'; seat: Seat; name: string }
  | { kind: 'lobby'; lobby: LobbyState }
  | { kind: 'gameStarted' }
  | { kind: 'welcome'; seat: Seat | null; isHost: boolean };

/** Per-tab identity (survives reloads, differs between tabs) for reconnecting to a seat. */
export function clientId(): string {
  const KEY = 'psiwars.clientId';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function serverBase(): string {
  return (window as any).PSI_SERVER ?? location.origin;
}

export async function createRoom(): Promise<string> {
  const r = await fetch(`${serverBase()}/api/rooms`, { method: 'POST' });
  if (!r.ok) throw new Error(`Could not create a room (HTTP ${r.status}). Is the game server running?`);
  const j = (await r.json()) as { code: string; protocol: number };
  if (j.protocol !== PROTOCOL_VERSION) throw new Error(`The server runs game version ${j.protocol}; this page is version ${PROTOCOL_VERSION}. Refresh the page.`);
  return j.code;
}

export class RemoteGame implements GameSource {
  seats: SeatInfo[] = [];
  lobby: LobbyState | null = null;
  mySeat: Seat | null = null;
  isHost = false;
  status: ConnStatus = 'connecting';
  private ws: WebSocket | null = null;
  private v: GameView | null = null;
  private lg: LegalView | null = null;
  private dl: Deadline | null = null;
  private offset = 0;
  private lastSeq = -1;
  private cid = 0;
  private acks = new Map<number, (r: { ok: true } | { ok: false; error: string }) => void>();
  private listeners = new Set<(u: Update) => void>();
  private noticeListeners = new Set<(n: Notice) => void>();
  private log: GameEvent[] = [];
  private retries = 0;
  private closedByUs = false;
  private pingTimer = 0;
  initialLog: GameEvent[] = [];

  constructor(readonly code: string, private name: string, private deck: DeckPayload) {
    this.connect();
  }

  // ---------- connection ----------

  private wsUrl(): string {
    const base = new URL(serverBase());
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = `/ws/${this.code}`;
    return base.toString();
  }

  private connect(): void {
    this.setStatus(this.retries ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.setStatus('open');
      this.raw({ t: 'hello', protocol: PROTOCOL_VERSION, clientId: clientId(), name: this.name });
      this.raw({ t: 'setDeck', deck: this.deck });
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.raw({ t: 'ping', at: Date.now() }), 25_000);
    };
    ws.onmessage = (e) => {
      try {
        this.onMsg(JSON.parse(String(e.data)) as ServerMsg);
      } catch (err) {
        console.warn('bad server message', err);
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      for (const [, done] of this.acks) done({ ok: false, error: 'Connection lost.' });
      this.acks.clear();
      if (this.closedByUs) return this.setStatus('closed');
      this.retries++;
      this.setStatus('reconnecting');
      const delay = Math.min(5000, 400 * 2 ** Math.min(this.retries, 4));
      setTimeout(() => !this.closedByUs && this.connect(), delay);
    };
  }

  private raw(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Lobby actions. */
  lobbyAction(msg: ClientMsg): void {
    if (msg.t === 'setDeck') this.deck = msg.deck;
    if (msg.t === 'setName') this.name = msg.name;
    this.raw(msg);
  }

  private setStatus(s: ConnStatus): void {
    this.status = s;
    this.notice({ kind: 'status', status: s });
  }

  onNotice(cb: (n: Notice) => void): () => void {
    this.noticeListeners.add(cb);
    return () => this.noticeListeners.delete(cb);
  }

  private notice(n: Notice): void {
    for (const l of this.noticeListeners) l(n);
  }

  // ---------- messages ----------

  private onMsg(m: ServerMsg): void {
    if ('serverTime' in m && typeof m.serverTime === 'number') this.offset = m.serverTime - Date.now();
    switch (m.t) {
      case 'welcome':
        this.mySeat = m.seat;
        this.isHost = m.isHost;
        this.notice({ kind: 'welcome', seat: m.seat, isHost: m.isHost });
        return;
      case 'lobby':
        this.lobby = m.lobby;
        this.seats = m.lobby.seats.map((s) => ({
          seat: s.seat,
          name: s.name + (s.kind === 'human' && !s.connected ? ' (offline)' : ''),
          kind: s.seat === this.mySeat ? 'local' : 'remote',
          aiLevel: s.aiLevel,
        }));
        this.notice({ kind: 'lobby', lobby: m.lobby });
        return;
      case 'error':
        this.notice({ kind: 'error', code: m.code, message: m.message, fatal: !!m.fatal });
        if (m.fatal) this.dispose();
        if (m.code === 'rate') for (const [, done] of this.acks) done({ ok: false, error: m.message });
        return;
      case 'ack': {
        const done = this.acks.get(m.cid);
        this.acks.delete(m.cid);
        done?.(m.ok ? { ok: true } : { ok: false, error: m.error ?? 'Rejected' });
        return;
      }
      case 'snapshot': {
        const fresh = !this.v || (this.v as GameView).commandCount > (m.view as GameView).commandCount;
        this.v = m.view as GameView;
        this.lg = m.legal as LegalView | null;
        this.dl = m.deadline;
        this.lastSeq = m.seq;
        if (fresh) {
          this.log = [...m.log];
          this.initialLog = [...m.log];
          this.notice({ kind: 'gameStarted' });
        }
        this.emit([]);
        return;
      }
      case 'update': {
        if (!this.v) return;
        if (m.seq !== this.lastSeq + 1) return this.resync();
        this.lastSeq = m.seq;
        this.v = applyViewPatch(this.v as any, m.patch) as GameView;
        this.lg = m.legal as LegalView | null;
        this.dl = m.deadline;
        this.log.push(...m.events);
        this.emit(m.events);
        return;
      }
      case 'deadline':
        if (m.seq !== this.lastSeq + 1) return this.resync();
        this.lastSeq = m.seq;
        this.dl = m.deadline;
        this.emit([]);
        return;
      case 'graceExpired':
        this.notice({ kind: 'graceExpired', seat: m.seat, name: m.name });
        return;
      case 'pong':
        return;
      case 'log':
        this.logWaiters.forEach((w) => w(m.log));
        this.logWaiters = [];
        return;
    }
  }

  private resync(): void {
    this.raw({ t: 'resync' });
  }

  private emit(events: GameEvent[]): void {
    for (const l of this.listeners) l({ events });
  }

  // ---------- GameSource ----------

  get hasGame(): boolean {
    return !!this.v;
  }

  view(_viewer: Seat | null): GameView {
    return this.v!;
  }

  legal(seat: Seat): LegalView | null {
    return seat === this.mySeat ? this.lg : null;
  }

  send(_seat: Seat, cmd: Command): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: 'Not connected — reconnecting…' });
    const cid = ++this.cid;
    return new Promise((resolve) => {
      this.acks.set(cid, resolve);
      this.raw({ t: 'cmd', cid, command: cmd });
    });
  }

  onUpdate(cb: (u: Update) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  eventsFor(events: GameEvent[]): GameEvent[] {
    return events; // the server already filtered them for our seat
  }

  /** Server-enforced countdown, converted to the local clock. */
  deadline(): { seat: Seat; kind: string; at: number } | null {
    return this.dl ? { ...this.dl, at: this.dl.at - this.offset } : null;
  }

  private logWaiters: ((log: unknown) => void)[] = [];

  /**
   * Once the game is over the server sends the full replayable log (seed, commands, card data).
   * During a game only this seat's own view of events can be exported (no hidden information).
   */
  exportLog(): unknown | Promise<unknown> {
    if (!(this.v as GameView | null)?.result) {
      return { format: 'psi-wars-log', version: 1, partial: true, room: this.code, seat: this.mySeat, note: 'Exported during an online game: only the events this seat could see. Export again after the game for the full, replayable log.', events: this.log };
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ format: 'psi-wars-log', version: 1, partial: true, room: this.code, seat: this.mySeat, note: 'The server did not send the full log.', events: this.log }), 5000);
      this.logWaiters.push((log) => {
        clearTimeout(t);
        resolve(log);
      });
      this.raw({ t: 'getLog' });
    });
  }

  dispose(): void {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.listeners.clear();
  }
}
