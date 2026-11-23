/**
 * The authoritative game room, shared verbatim by the Cloudflare Durable Object and the local
 * Node server (build prompt §4). Pure TypeScript: no sockets, no timers, no platform APIs.
 * Hosts deliver messages with onMessage/onClose, call tick() at nextDeadline(), and persist
 * serialize() after every change.
 *
 * Guarantees:
 *  - the server owns GameState and the seeded RNG; clients never roll, shuffle or decide legality
 *  - every command is validated by the engine for the sending seat; rejections are logged
 *  - each connection receives only its seat's filtered view and filtered events
 *  - every game message carries a monotonically increasing seq; snapshots on join/resync/reconnect
 *  - rate limiting per connection
 */
import {
  PROTOCOL_VERSION,
  diffView,
  type AiLevelName,
  type ClientMsg,
  type Command,
  type Deadline,
  type DeckPayload,
  type GameEvent,
  type LobbySeat,
  type LobbyState,
  type RoomConfig,
  type Seat,
  type ServerMsg,
} from '@psi-wars/shared';
import {
  applyCommand,
  buildDefs,
  cleanBalance,
  describeOverlay,
  makeLog,
  type BalanceFile,
  chooseCommand,
  createGame,
  defaultCommandFor,
  filterEvents,
  getLegalView,
  seedRng,
  validateDeck,
  viewFor,
  type CardDef,
  type GameState,
  type RngState,
  type RulesData,
} from '@psi-wars/engine';

export interface RoomHost {
  send(connId: string, msg: ServerMsg): void;
  close(connId: string, code?: number, reason?: string): void;
  now(): number;
  log(message: string, data?: unknown): void;
  randomSeed(): string;
}

export interface RoomOptions {
  defs: Record<string, CardDef>;
  /** cards.json as shipped, for validating and applying a host's balance overlay. */
  baseCards?: { cards: CardDef[] };
  rules: RulesData;
  starterDecks: DeckPayload[];
  graceMs?: number;
  idleMs?: number;
  /** Multiplier for computer players' thinking pauses (1 = paced for humans, 0 = instant; tests). */
  aiDelayScale?: number;
}

interface SeatSlot {
  seat: Seat;
  kind: 'open' | 'human' | 'ai';
  clientId: string | null;
  name: string;
  aiLevel?: AiLevelName;
  deck: DeckPayload | null;
  ready: boolean;
  disconnectedAt: number | null;
  graceNotified: boolean;
}

interface Conn {
  connId: string;
  clientId: string | null;
  tokens: number;
  refillAt: number;
  dropped: number;
  lastView: Record<string, unknown> | null;
}

interface Pending {
  key: string;
  seat: Seat;
  kind: 'response' | 'turn' | 'ai';
  at: number;
}

export interface RoomData {
  v: 1;
  code: string;
  phase: LobbyState['phase'];
  config: RoomConfig;
  seats: SeatSlot[];
  hostClientId: string | null;
  game: Omit<GameState, 'defs' | 'rules'> | null;
  seq: number;
  log: GameEvent[];
  aiRng: RngState;
  pending: Pending | null;
  createdAt: number;
  lastActivity: number;
  balance?: BalanceFile | null;
  commands?: { seat: Seat; cmd: Command }[];
  setup?: GameRecord | null;
}

/** What is needed (with the commands) to rebuild the current game exactly. */
interface GameRecord {
  seed: string;
  players: { name: string; deck: DeckPayload; kind: string }[];
}

const DEFAULT_CONFIG: RoomConfig = { seats: 2, startingHP: 15, diceVariant: 'standard', trapWindowSec: 3, fastWindows: false, turnTimerSec: 0 };
const RATE = { burst: 60, perSec: 25 };
const LOG_CAP = 600;

export class Room {
  code: string;
  phase: LobbyState['phase'] = 'lobby';
  config: RoomConfig = { ...DEFAULT_CONFIG };
  seats: SeatSlot[] = [];
  hostClientId: string | null = null;
  game: GameState | null = null;
  seq = 0;
  log: GameEvent[] = [];
  aiRng: RngState;
  pending: Pending | null = null;
  createdAt: number;
  lastActivity: number;
  balance: BalanceFile | null = null;
  commands: { seat: Seat; cmd: Command }[] = [];
  setup: GameRecord | null = null;
  private defsCache: { key: BalanceFile | null; defs: Record<string, CardDef> } | null = null;
  private conns = new Map<string, Conn>();
  private graceMs: number;
  private idleMs: number;

  constructor(code: string, private host: RoomHost, private opts: RoomOptions) {
    this.code = code;
    this.createdAt = host.now();
    this.lastActivity = this.createdAt;
    this.aiRng = seedRng(`ai:${code}:${host.randomSeed()}`);
    this.graceMs = opts.graceMs ?? 120_000;
    this.idleMs = opts.idleMs ?? 2 * 3600_000;
    this.resizeSeats(this.config.seats);
  }

  /** Card definitions in force: the shipped cards, or the host's balance overlay on top. */
  defs(): Record<string, CardDef> {
    if (!this.balance || !this.opts.baseCards) return this.opts.defs;
    if (this.defsCache?.key !== this.balance) this.defsCache = { key: this.balance, defs: buildDefs(this.opts.baseCards, this.balance) };
    return this.defsCache.defs;
  }

  // ---------- persistence ----------

  serialize(): RoomData {
    let game: RoomData['game'] = null;
    if (this.game) {
      const { defs: _d, rules: _r, ...rest } = this.game;
      game = rest;
    }
    return {
      v: 1, code: this.code, phase: this.phase, config: this.config, seats: this.seats, hostClientId: this.hostClientId, game,
      seq: this.seq, log: this.log.slice(-LOG_CAP), aiRng: this.aiRng, pending: this.pending, createdAt: this.createdAt, lastActivity: this.lastActivity,
      balance: this.balance, commands: this.commands, setup: this.setup,
    };
  }

  static restore(data: RoomData, host: RoomHost, opts: RoomOptions): Room {
    const r = new Room(data.code, host, opts);
    r.phase = data.phase;
    r.config = data.config;
    r.seats = data.seats;
    r.hostClientId = data.hostClientId;
    r.balance = data.balance ?? null;
    r.commands = data.commands ?? [];
    r.setup = data.setup ?? null;
    r.game = data.game ? ({ ...data.game, defs: r.defs(), rules: opts.rules } as GameState) : null;
    r.seq = data.seq;
    r.log = data.log;
    r.aiRng = data.aiRng;
    r.pending = data.pending;
    r.createdAt = data.createdAt;
    r.lastActivity = data.lastActivity;
    return r;
  }

  /** After hibernation: re-register a live socket whose client already said hello. */
  rehydrateConn(connId: string, clientId: string | null): void {
    this.conns.set(connId, { connId, clientId, tokens: RATE.burst, refillAt: this.host.now(), dropped: 0, lastView: null });
  }

  // ---------- connection lifecycle ----------

  onOpen(connId: string): void {
    this.conns.set(connId, { connId, clientId: null, tokens: RATE.burst, refillAt: this.host.now(), dropped: 0, lastView: null });
  }

  onClose(connId: string): void {
    const c = this.conns.get(connId);
    this.conns.delete(connId);
    if (!c?.clientId) return;
    // Another live connection for the same client (a second tab, or a fast reconnect) keeps the seat.
    if ([...this.conns.values()].some((x) => x.clientId === c.clientId)) return;
    const slot = this.slotOf(c.clientId);
    if (slot) {
      if (this.phase === 'lobby') {
        slot.kind = 'open';
        slot.clientId = null;
        slot.name = '';
        slot.deck = null;
        slot.ready = false;
        if (this.hostClientId === c.clientId) this.passHost();
      } else {
        slot.disconnectedAt = this.host.now();
        slot.graceNotified = false;
      }
    }
    this.broadcastLobby();
  }

  onMessage(connId: string, raw: string): void {
    const c = this.conns.get(connId);
    if (!c) return;
    if (!this.allow(c)) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.err(connId, 'bad_json', 'Malformed message.');
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return this.err(connId, 'bad_msg', 'Malformed message.');
    this.lastActivity = this.host.now();
    if (msg.t === 'ping') return this.host.send(connId, { t: 'pong', at: msg.at, serverTime: this.host.now() });
    if (msg.t === 'hello') return this.hello(c, msg);
    if (!c.clientId) return this.err(connId, 'no_hello', 'Say hello first.');
    const slot = this.slotOf(c.clientId);
    const isHost = c.clientId === this.hostClientId;
    switch (msg.t) {
      case 'setName':
        if (slot) slot.name = this.uniqueName(cleanName(msg.name, slot.seat), slot.seat);
        return this.broadcastLobby();
      case 'setDeck': {
        if (!slot || this.phase !== 'lobby') return;
        const problems = validateDeck(this.defs(), this.opts.rules, msg.deck);
        if (problems.length) return this.err(connId, 'bad_deck', problems.map((p) => p.message).join(' '));
        slot.deck = { name: String(msg.deck.name ?? 'Custom deck').slice(0, 40), battle: msg.deck.battle, resource: msg.deck.resource };
        return this.broadcastLobby();
      }
      case 'takeSeat': {
        if (this.phase !== 'lobby' || !slot) return;
        const to = this.seats[msg.seat];
        if (!to || to.kind !== 'open') return this.err(connId, 'seat_taken', 'That seat is not free.');
        Object.assign(to, { ...slot, seat: to.seat });
        Object.assign(slot, emptySlot(slot.seat));
        return this.broadcastLobby();
      }
      case 'ready':
        if (slot && this.phase === 'lobby') slot.ready = !!msg.ready;
        return this.broadcastLobby();
      case 'config':
        if (!isHost || this.phase !== 'lobby') return this.err(connId, 'not_host', 'Only the host can change room settings.');
        return this.setConfig(connId, msg.config);
      case 'seatAi': {
        if (!isHost || this.phase !== 'lobby') return this.err(connId, 'not_host', 'Only the host can add computer players.');
        const s = this.seats[msg.seat];
        if (!s || s.kind === 'human') return;
        if (msg.level) Object.assign(s, { kind: 'ai', aiLevel: msg.level, name: this.uniqueName(`Computer (${cap(msg.level)})`, s.seat), deck: this.opts.starterDecks[s.seat % this.opts.starterDecks.length]!, ready: true });
        else Object.assign(s, emptySlot(s.seat));
        return this.broadcastLobby();
      }
      case 'kick': {
        if (!isHost || this.phase !== 'lobby') return;
        const s = this.seats[msg.seat];
        if (!s || s.kind !== 'human' || s.clientId === this.hostClientId) return;
        const kicked = s.clientId;
        Object.assign(s, emptySlot(s.seat));
        for (const x of this.conns.values()) if (x.clientId === kicked) this.err(x.connId, 'kicked', 'The host removed you from the room.', true);
        return this.broadcastLobby();
      }
      case 'start':
        if (!isHost) return this.err(connId, 'not_host', 'Only the host can start the game.');
        return this.start(connId);
      case 'cmd':
        return this.command(c, slot, msg.cid, msg.command);
      case 'replaceWithAi': {
        if (!isHost || this.phase !== 'game') return;
        const s = this.seats[msg.seat];
        if (!s || s.kind !== 'human' || s.disconnectedAt === null) return this.err(connId, 'not_allowed', 'Only a disconnected player can be replaced.');
        Object.assign(s, { kind: 'ai', aiLevel: msg.level, name: `${s.name} (Computer)`, disconnectedAt: null });
        this.broadcastLobby();
        this.reschedule();
        return;
      }
      case 'resync':
        return this.sendSnapshot(c);
      case 'setBalance':
        if (!isHost || this.phase === 'game') return this.err(connId, 'not_host', 'Only the host can choose the card balance, between games.');
        return this.setBalance(connId, msg.balance);
      case 'getLog':
        return this.sendLog(c);
    }
  }

  private hello(c: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      return this.err(c.connId, 'protocol', `This room runs game version ${PROTOCOL_VERSION}, but your game is version ${msg.protocol}. Refresh the page to update, then join again.`, true);
    }
    const clientId = String(msg.clientId ?? '').slice(0, 64);
    if (!clientId) return this.err(c.connId, 'bad_hello', 'Missing client id.', true);
    c.clientId = clientId;
    let slot = this.slotOf(clientId);
    if (slot) {
      slot.disconnectedAt = null;
      slot.graceNotified = false;
    } else if (this.phase === 'lobby') {
      const want = msg.seat !== undefined ? this.seats[msg.seat] : undefined;
      const open = want?.kind === 'open' ? want : this.seats.find((s) => s.kind === 'open');
      if (open) {
        Object.assign(open, { kind: 'human', clientId, name: this.uniqueName(cleanName(msg.name, open.seat), open.seat), deck: this.opts.starterDecks[open.seat % this.opts.starterDecks.length]!, ready: false, disconnectedAt: null, graceNotified: false });
        slot = open;
      }
    }
    if (!this.hostClientId && slot) this.hostClientId = clientId;
    this.host.send(c.connId, { t: 'welcome', protocol: PROTOCOL_VERSION, code: this.code, clientId, seat: slot?.seat ?? null, isHost: clientId === this.hostClientId, serverTime: this.host.now() });
    this.broadcastLobby();
    if (this.game) this.sendSnapshot(c);
  }

  // ---------- lobby ----------

  private setBalance(connId: string, raw: unknown): void {
    if (raw === null) {
      this.balance = null;
      return this.broadcastLobby();
    }
    if (!this.opts.baseCards) return this.err(connId, 'no_balance', 'This server cannot apply card balance files.');
    if (JSON.stringify(raw ?? null).length > 200_000) return this.err(connId, 'too_big', 'That balance file is too large.');
    const { balance, errors } = cleanBalance(this.opts.baseCards, raw);
    if (errors.length) this.err(connId, 'balance_warn', `Balance applied with ${errors.length} problem(s) ignored: ${errors.slice(0, 3).join(' ')}`);
    this.balance = Object.keys(balance.cards).length ? balance : null;
    this.broadcastLobby();
  }

  /** The full log only once the game is over: it reveals every hand and deck order. */
  private sendLog(c: Conn): void {
    if (!this.game || !this.game.result || !this.setup) return this.err(c.connId, 'no_log', 'The full game log is available once the game is over.');
    const setup = {
      defs: this.defs(), rules: this.opts.rules, seed: this.setup.seed,
      players: this.setup.players.map((p) => ({ name: p.name, deck: p.deck })),
      startingHP: this.game.config.startingHP, diceVariant: this.game.config.diceVariant, autoPassNoPlay: this.game.config.autoPassNoPlay,
    };
    // Re-create the event stream from the commands (the room keeps only recent events).
    let { state, events } = createGame(setup);
    const all = [...events];
    for (const { seat, cmd } of this.commands) {
      const r = applyCommand(state, seat, cmd);
      if (!r.ok) return this.err(c.connId, 'no_log', 'The game could not be rebuilt for the log.');
      state = r.state;
      all.push(...r.events);
    }
    const log = makeLog(setup, this.commands, all, state, {
      balance: this.balance ? { name: this.balance.name, cards: this.balance.cards } : null,
      kinds: this.setup.players.map((p) => p.kind),
      meta: { room: this.code },
      createdAt: new Date(this.host.now()).toISOString(),
    });
    this.host.send(c.connId, { t: 'log', log });
  }

  private setConfig(connId: string, patch: Partial<RoomConfig>): void {
    const cfg = { ...this.config };
    if (patch.seats !== undefined) {
      const n = clamp(Math.round(patch.seats), 2, 4);
      const occupied = this.seats.filter((s, i) => i >= n && s.kind !== 'open');
      if (occupied.length) return this.err(connId, 'seats_occupied', 'Free the higher seats before reducing the player count.');
      cfg.seats = n;
    }
    if (patch.startingHP !== undefined) cfg.startingHP = clamp(Math.round(patch.startingHP), this.opts.rules.setup.startingHP.min, this.opts.rules.setup.startingHP.max);
    if (patch.diceVariant === 'standard' || patch.diceVariant === 'noModifier') cfg.diceVariant = patch.diceVariant;
    if (patch.trapWindowSec !== undefined) cfg.trapWindowSec = clamp(Math.round(patch.trapWindowSec), 0, 10);
    if (patch.fastWindows !== undefined) cfg.fastWindows = !!patch.fastWindows;
    if (patch.turnTimerSec !== undefined) cfg.turnTimerSec = [0, 30, 60, 120].includes(patch.turnTimerSec) ? patch.turnTimerSec : 0;
    this.config = cfg;
    this.resizeSeats(cfg.seats);
    this.broadcastLobby();
  }

  private resizeSeats(n: number): void {
    while (this.seats.length < n) this.seats.push(emptySlot(this.seats.length));
    this.seats.length = n;
  }

  private start(connId: string): void {
    if (this.phase === 'game') return; // 'ended' -> rematch with the same seats
    for (const s of this.seats) s.disconnectedAt = s.kind === 'human' && !this.isConnected(s.clientId) ? this.host.now() : null;
    const open = this.seats.filter((s) => s.kind === 'open');
    if (open.length) return this.err(connId, 'seats_open', 'Fill every seat (players or computer) before starting.');
    for (const s of this.seats) {
      if (!s.deck) return this.err(connId, 'no_deck', `${s.name || 'A player'} has no deck.`);
      const problems = validateDeck(this.defs(), this.opts.rules, s.deck);
      if (problems.length) return this.err(connId, 'bad_deck', `${s.name}'s deck is not legal under this card balance: ${problems[0]!.message}`);
    }
    const seed = this.host.randomSeed();
    this.setup = { seed, players: this.seats.map((s) => ({ name: s.name, deck: s.deck!, kind: s.kind === 'ai' ? `ai-${s.aiLevel ?? 'normal'}` : 'human' })) };
    this.commands = [];
    const { state, events } = createGame({
      defs: this.defs(),
      rules: this.opts.rules,
      seed,
      players: this.seats.map((s) => ({ name: s.name, deck: s.deck! })),
      startingHP: this.config.startingHP,
      diceVariant: this.config.diceVariant,
      autoPassNoPlay: this.config.fastWindows,
    });
    this.game = state;
    this.phase = 'game';
    this.log = [...events];
    this.seq++;
    this.reschedule(false);
    this.broadcastLobby();
    for (const c of this.conns.values()) this.sendSnapshot(c);
  }

  // ---------- game ----------

  private command(c: Conn, slot: SeatSlot | undefined, cid: number, command: Command): void {
    if (!this.game || this.phase !== 'game') return this.host.send(c.connId, { t: 'ack', cid, ok: false, error: 'No game in progress.' });
    if (!slot || slot.kind !== 'human') return this.host.send(c.connId, { t: 'ack', cid, ok: false, error: 'Spectators cannot act.' });
    const r = applyCommand(this.game, slot.seat, command);
    if (!r.ok) {
      this.host.log('rejected command', { room: this.code, seat: slot.seat, command, error: r.error });
      return this.host.send(c.connId, { t: 'ack', cid, ok: false, error: r.error });
    }
    this.host.send(c.connId, { t: 'ack', cid, ok: true });
    this.commit(r.state, r.events, slot.seat, command);
  }

  private commit(state: GameState, events: GameEvent[], seat: Seat, cmd: Command): void {
    this.commands.push({ seat, cmd });
    this.game = state;
    this.log.push(...events);
    if (this.log.length > LOG_CAP * 2) this.log = this.log.slice(-LOG_CAP);
    if (state.result) this.phase = 'ended';
    this.seq++;
    this.reschedule(false); // the update itself carries the new deadline
    for (const c of this.conns.values()) this.sendUpdate(c, events);
    if (state.result) this.broadcastLobby();
  }

  private seatOfConn(c: Conn): Seat | null {
    const slot = c.clientId ? this.slotOf(c.clientId) : undefined;
    return slot && slot.kind === 'human' ? slot.seat : null;
  }

  private viewForConn(c: Conn) {
    const seat = this.seatOfConn(c);
    const view = viewFor(this.game!, seat) as unknown as Record<string, unknown>;
    const legal = seat !== null ? getLegalView(this.game!, seat) : null;
    return { seat, view, legal };
  }

  private publicDeadline(): Deadline | null {
    const p = this.pending;
    if (!p || p.kind === 'ai') return null;
    return { seat: p.seat, kind: p.kind, at: p.at };
  }

  private sendSnapshot(c: Conn): void {
    if (!this.game) return;
    const { seat, view, legal } = this.viewForConn(c);
    c.lastView = { ...view, defs: undefined };
    this.host.send(c.connId, { t: 'snapshot', seq: this.seq, view, legal, deadline: this.publicDeadline(), serverTime: this.host.now(), log: filterEvents(this.log.slice(-400), seat) });
  }

  private sendUpdate(c: Conn, events: GameEvent[]): void {
    if (!c.clientId) return;
    if (!c.lastView) return this.sendSnapshot(c);
    const { seat, view, legal } = this.viewForConn(c);
    const next = { ...view, defs: undefined };
    const patch = diffView(c.lastView, next);
    c.lastView = next;
    this.host.send(c.connId, { t: 'update', seq: this.seq, events: filterEvents(events, seat), patch, legal, deadline: this.publicDeadline(), serverTime: this.host.now() });
  }

  // ---------- deadlines: response windows, turn timer, AI moves ----------

  /** Work out who must act and by when. Called after every state change. */
  private reschedule(broadcast = true): void {
    const g = this.game;
    const before = this.pending?.key;
    this.pending = null;
    if (g && !g.result && g.prompt && this.phase === 'game') {
      const p = g.prompt;
      const slot = this.seats[p.seat]!;
      const key = `${g.commandCount}:${p.seat}:${p.kind}`;
      const now = this.host.now();
      if (slot.kind === 'ai') {
        const delay = (p.kind === 'priority' ? 350 : p.kind === 'main' ? 900 : 650) * (this.opts.aiDelayScale ?? 1);
        this.pending = { key, seat: p.seat, kind: 'ai', at: now + delay };
      } else if (p.kind === 'priority') {
        // House rule M: every player gets the same short window, so a pause reveals nothing.
        this.pending = { key, seat: p.seat, kind: 'response', at: now + this.config.trapWindowSec * 1000 };
      } else if (this.config.turnTimerSec > 0) {
        this.pending = { key, seat: p.seat, kind: 'turn', at: now + this.config.turnTimerSec * 1000 };
      }
    }
    if (broadcast && this.pending?.key !== before && this.pending && this.pending.kind !== 'ai') {
      this.seq++;
      for (const c of this.conns.values()) if (c.clientId) this.host.send(c.connId, { t: 'deadline', seq: this.seq, deadline: this.publicDeadline(), serverTime: this.host.now() });
    }
  }

  nextDeadline(): number | null {
    const times: number[] = [];
    if (this.pending) times.push(this.pending.at);
    for (const s of this.seats) if (s.kind === 'human' && s.disconnectedAt !== null && !s.graceNotified) times.push(s.disconnectedAt + this.graceMs);
    times.push(this.lastActivity + this.idleMs);
    return times.length ? Math.min(...times) : null;
  }

  /** Process anything due. Returns 'expired' when the room should be torn down. */
  tick(): 'ok' | 'expired' {
    const now = this.host.now();
    if (now >= this.lastActivity + this.idleMs) {
      for (const c of [...this.conns.values()]) this.err(c.connId, 'expired', 'This room closed after two hours without activity.', true);
      this.phase = 'ended';
      return 'expired';
    }
    // Reconnect grace (default 120 s): tell the host they may hand the seat to the computer.
    for (const s of this.seats) {
      if (s.kind !== 'human' || s.disconnectedAt === null || s.graceNotified) continue;
      if (now < s.disconnectedAt + this.graceMs) continue;
      s.graceNotified = true;
      if (s.clientId === this.hostClientId) this.passHost();
      const hostConn = [...this.conns.values()].find((c) => c.clientId === this.hostClientId);
      if (hostConn) this.host.send(hostConn.connId, { t: 'graceExpired', seat: s.seat, name: s.name });
      this.broadcastLobby();
    }
    let guard = 0;
    while (this.pending && now >= this.pending.at && this.game && !this.game.result && guard++ < 64) {
      const p = this.pending;
      const g = this.game;
      if (!g.prompt || `${g.commandCount}:${g.prompt.seat}:${g.prompt.kind}` !== p.key) {
        this.reschedule();
        continue;
      }
      let cmd: Command;
      if (p.kind === 'ai') {
        const slot = this.seats[p.seat]!;
        const legal = getLegalView(g, p.seat)!;
        cmd = chooseCommand(slot.aiLevel ?? 'normal', viewFor(g, p.seat), legal, this.opts.rules, this.aiRng);
      } else {
        cmd = defaultCommandFor(g.prompt);
      }
      const r = applyCommand(g, p.seat, cmd);
      if (!r.ok) {
        this.host.log('timed command rejected', { room: this.code, cmd, error: r.error });
        const fb = defaultCommandFor(g.prompt);
        const fallback = applyCommand(g, p.seat, fb);
        if (!fallback.ok) break;
        this.commit(fallback.state, fallback.events, p.seat, fb);
      } else {
        this.commit(r.state, r.events, p.seat, cmd);
      }
    }
    return 'ok';
  }

  // ---------- helpers ----------

  private passHost(): void {
    const next = this.seats.find((s) => s.kind === 'human' && s.clientId && s.disconnectedAt === null && [...this.conns.values()].some((c) => c.clientId === s.clientId));
    this.hostClientId = next?.clientId ?? null;
    if (next) for (const c of this.conns.values()) if (c.clientId === next.clientId) this.host.send(c.connId, { t: 'welcome', protocol: PROTOCOL_VERSION, code: this.code, clientId: next.clientId!, seat: next.seat, isHost: true, serverTime: this.host.now() });
  }

  /** Seat names must be distinct so the board, turn order and log are unambiguous. */
  private uniqueName(name: string, seat: Seat): string {
    const taken = new Set(this.seats.filter((s) => s.seat !== seat && s.kind !== 'open').map((s) => s.name));
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
  }

  private isConnected(clientId: string | null): boolean {
    return !!clientId && [...this.conns.values()].some((c) => c.clientId === clientId);
  }

  private slotOf(clientId: string): SeatSlot | undefined {
    return this.seats.find((s) => s.kind === 'human' && s.clientId === clientId);
  }

  lobbyState(): LobbyState {
    const connected = new Set([...this.conns.values()].map((c) => c.clientId));
    const seats: LobbySeat[] = this.seats.map((s) => ({
      seat: s.seat,
      kind: s.kind,
      name: s.name,
      aiLevel: s.aiLevel,
      deckName: s.deck?.name,
      ready: s.kind === 'ai' ? true : s.ready,
      connected: s.kind === 'ai' || (s.kind === 'human' && connected.has(s.clientId)),
      isHost: s.kind === 'human' && s.clientId === this.hostClientId,
      graceUntil: s.disconnectedAt !== null ? s.disconnectedAt + this.graceMs : undefined,
    }));
    const base = this.opts.baseCards ? new Map(this.opts.baseCards.cards.map((c) => [c.id, c] as const)) : null;
    const balance = this.balance
      ? {
          name: this.balance.name,
          cards: Object.keys(this.balance.cards).length,
          changes: Object.entries(this.balance.cards).slice(0, 40).map(([id, o]) => `${base?.get(id)?.name ?? id}: ${base?.get(id) ? describeOverlay(base.get(id)!, o).join(', ') : 'changed'}`),
        }
      : null;
    return { code: this.code, phase: this.phase, config: this.config, seats, balance };
  }

  private broadcastLobby(): void {
    const lobby = this.lobbyState();
    for (const c of this.conns.values()) if (c.clientId) this.host.send(c.connId, { t: 'lobby', lobby, serverTime: this.host.now() });
  }

  private err(connId: string, code: string, message: string, fatal = false): void {
    this.host.send(connId, { t: 'error', code, message, fatal });
    if (fatal) this.host.close(connId, 4000, code);
  }

  /** Token-bucket rate limit per connection (§4.6). */
  private allow(c: Conn): boolean {
    const now = this.host.now();
    c.tokens = Math.min(RATE.burst, c.tokens + ((now - c.refillAt) / 1000) * RATE.perSec);
    c.refillAt = now;
    if (c.tokens >= 1) {
      c.tokens -= 1;
      return true;
    }
    c.dropped++;
    if (c.dropped % 20 === 1) this.host.send(c.connId, { t: 'error', code: 'rate', message: 'Slow down: some messages were ignored.' });
    if (c.dropped === 1 || c.dropped % 50 === 0) this.host.log('rate limited', { room: this.code, conn: c.connId, dropped: c.dropped });
    if (c.dropped > 400) this.err(c.connId, 'rate', 'Too many messages.', true);
    return false;
  }

  /** The client id a connection said hello with (hosts store it with the socket). */
  clientIdOf(connId: string): string | null {
    return this.conns.get(connId)?.clientId ?? null;
  }

  get connectionCount(): number {
    return this.conns.size;
  }
}

function emptySlot(seat: Seat): SeatSlot {
  return { seat, kind: 'open', clientId: null, name: '', deck: null, ready: false, disconnectedAt: null, graceNotified: false };
}

function cleanName(raw: unknown, seat: Seat): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return s || `Player ${seat + 1}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

function cap(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}
