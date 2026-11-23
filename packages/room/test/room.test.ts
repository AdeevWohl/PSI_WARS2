import { describe, expect, it } from 'vitest';
import { applyViewPatch, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@psi-wars/shared';
import { checkLog, chooseCommand, Replayer, viewFor, seedRng, type GameView, type LegalView } from '@psi-wars/engine';
import { Room, roomOptions, type RoomHost } from '../src/index';

class FakeHost implements RoomHost {
  t = 1_000_000;
  out = new Map<string, ServerMsg[]>();
  closed = new Set<string>();
  logs: { m: string; d: unknown }[] = [];
  seed = 0;
  send(connId: string, msg: ServerMsg) {
    if (!this.out.has(connId)) this.out.set(connId, []);
    this.out.get(connId)!.push(JSON.parse(JSON.stringify(msg)));
  }
  close(connId: string) {
    this.closed.add(connId);
  }
  now() {
    return this.t;
  }
  log(m: string, d?: unknown) {
    this.logs.push({ m, d });
  }
  randomSeed() {
    return `seed-${this.seed++}`;
  }
}

/** A test client that reconstructs its view from snapshots + patches, like the real one. */
class Client {
  view: GameView | null = null;
  legal: LegalView | null = null;
  lastSeq = -1;
  seqs: number[] = [];
  cid = 0;
  lobby: any = null;
  seat: number | null = null;
  isHost = false;
  errors: string[] = [];
  read = 0;
  constructor(public room: Room, public host: FakeHost, public connId: string, public clientId: string) {}
  open() {
    this.room.onOpen(this.connId);
  }
  send(msg: ClientMsg) {
    this.host.t += 120;
    this.room.onMessage(this.connId, JSON.stringify(msg));
    this.drain();
  }
  hello(name: string, protocol = PROTOCOL_VERSION) {
    this.send({ t: 'hello', protocol, clientId: this.clientId, name });
  }
  drain() {
    const msgs = this.host.out.get(this.connId) ?? [];
    for (; this.read < msgs.length; this.read++) {
      const m = msgs[this.read]!;
      if (m.t === 'welcome') {
        this.seat = m.seat;
        this.isHost = m.isHost;
      } else if (m.t === 'lobby') this.lobby = m.lobby;
      else if (m.t === 'error') this.errors.push(m.code);
      else if (m.t === 'snapshot') {
        this.view = m.view as GameView;
        this.legal = m.legal as LegalView | null;
        this.seqs.push(m.seq);
        this.lastSeq = m.seq;
      } else if (m.t === 'update') {
        this.view = applyViewPatch(this.view as any, m.patch) as GameView;
        this.legal = m.legal as LegalView | null;
        this.seqs.push(m.seq);
        this.lastSeq = m.seq;
      } else if (m.t === 'deadline') this.seqs.push(m.seq);
    }
  }
  messages(): ServerMsg[] {
    return this.host.out.get(this.connId) ?? [];
  }
}

function setup(graceMs = 120_000) {
  const host = new FakeHost();
  const room = new Room('ABCDEF', host, roomOptions({ graceMs }));
  const mk = (n: number) => {
    const c = new Client(room, host, `conn${n}-${Math.random()}`, `client${n}`);
    c.open();
    return c;
  };
  return { host, room, mk };
}

describe('Room lobby', () => {
  it('first player becomes host on seat 0; next joins seat 1', () => {
    const { mk } = setup();
    const a = mk(1);
    a.hello('Ann');
    const b = mk(2);
    b.hello('Bo');
    a.drain();
    expect(a.seat).toBe(0);
    expect(a.isHost).toBe(true);
    expect(b.seat).toBe(1);
    expect(b.isHost).toBe(false);
    expect(a.lobby.seats.map((s: any) => s.name)).toEqual(['Ann', 'Bo']);
  });

  it('refuses a different protocol version, plainly, and closes', () => {
    const { mk, host } = setup();
    const a = mk(1);
    a.hello('Ann', PROTOCOL_VERSION + 1);
    expect(a.errors).toEqual(['protocol']);
    expect(host.closed.has(a.connId)).toBe(true);
    const err = a.messages().find((m) => m.t === 'error') as any;
    expect(err.message).toMatch(/version/);
  });

  it('only the host can change settings, add computer seats or start', () => {
    const { mk, room } = setup();
    const a = mk(1);
    a.hello('Ann');
    const b = mk(2);
    b.hello('Bo');
    b.send({ t: 'config', config: { startingHP: 20 } });
    b.send({ t: 'start' });
    expect(b.errors).toEqual(['not_host', 'not_host']);
    a.send({ t: 'config', config: { startingHP: 20, seats: 3 } });
    expect(room.config.startingHP).toBe(20);
    expect(room.seats).toHaveLength(3);
    a.send({ t: 'start' });
    expect(a.errors).toContain('seats_open');
    a.send({ t: 'seatAi', seat: 2, level: 'easy' });
    a.send({ t: 'start' });
    expect(room.phase).toBe('game');
  });

  it('rejects illegal decks', () => {
    const { mk } = setup();
    const a = mk(1);
    a.hello('Ann');
    a.send({ t: 'setDeck', deck: { name: 'bad', battle: { BU_LS: 9 }, resource: { CU_NG: 2 } } });
    expect(a.errors).toContain('bad_deck');
  });
});

function startTwo() {
  const env = setup();
  const a = env.mk(1);
  a.hello('Ann');
  const b = env.mk(2);
  b.hello('Bo');
  a.send({ t: 'start' });
  a.drain();
  b.drain();
  return { ...env, a, b };
}

describe('Room game', () => {
  it('sends each seat its own hand only — never the opponent hand or deck order', () => {
    const { a, b, room } = startTwo();
    expect(a.view).not.toBeNull();
    const state = room.game!;
    const bHand = state.players[1]!.hand;
    const json = JSON.stringify(a.messages());
    for (const uid of [...bHand, ...state.players[1]!.battleDeck]) expect(json.includes(`"${uid}"`)).toBe(false);
    expect(a.view!.players[0]!.hand).toHaveLength(state.players[0]!.hand.length);
    expect(a.view!.players[1]!.hand).toBeNull();
    void b;
  });

  it('rejects a command from the wrong seat and logs it', () => {
    const { a, b, room, host } = startTwo();
    const holder = room.game!.prompt!.seat === 0 ? b : a; // the one NOT holding the prompt
    holder.send({ t: 'cmd', cid: 1, command: { type: 'AdvancePhase' } });
    const ack = holder.messages().filter((m) => m.t === 'ack').pop() as any;
    expect(ack.ok).toBe(false);
    expect(host.logs.some((l) => l.m === 'rejected command')).toBe(true);
  });

  it('plays a full game: patched client views always equal the server view; seq strictly increases', () => {
    const { a, b, room, host } = startTwo();
    const clients = [a, b];
    const rng = seedRng('test-ai');
    let n = 0;
    while (room.game && !room.game.result && n++ < 4000) {
      for (const c of clients) {
        c.drain();
        const server = JSON.parse(JSON.stringify({ ...(viewFor(room.game, c.seat) as any), defs: undefined }));
        const mine = JSON.parse(JSON.stringify({ ...(c.view as any), defs: undefined }));
        expect(mine).toEqual(server);
      }
      const seat = room.game.prompt!.seat;
      const c = clients[seat]!;
      if (!c.legal) {
        // response window for a seat with no play: let the server's timer pass it
        host.t += 10_000;
        room.tick();
        continue;
      }
      const cmd = chooseCommand('normal', c.view!, c.legal, roomOptions().rules, rng);
      c.send({ t: 'cmd', cid: ++c.cid, command: cmd });
      const ack = c.messages().filter((m) => m.t === 'ack').pop() as any;
      expect(ack.ok, ack.error).toBe(true);
    }
    expect(room.game!.result).not.toBeNull();
    expect(room.phase).toBe('ended');
    for (const c of clients) {
      for (let i = 1; i < c.seqs.length; i++) expect(c.seqs[i]!).toBeGreaterThan(c.seqs[i - 1]!);
    }
  });

  it('response windows auto-pass after the configured time (house rule M)', () => {
    const { a, b, room, host } = startTwo();
    // Drive until someone faces a priority prompt.
    const rng = seedRng('w');
    let guard = 0;
    while (room.game!.prompt!.kind !== 'priority' && guard++ < 500) {
      const c = [a, b][room.game!.prompt!.seat]!;
      c.drain();
      c.send({ t: 'cmd', cid: ++c.cid, command: chooseCommand('easy', c.view!, c.legal!, roomOptions().rules, rng) });
    }
    expect(room.game!.prompt!.kind).toBe('priority');
    const before = room.game!.commandCount;
    host.t += 2_000;
    room.tick();
    expect(room.game!.commandCount).toBe(before); // 3 s not yet up
    host.t += 1_500;
    room.tick();
    expect(room.game!.commandCount).toBeGreaterThan(before);
  });

  it('reconnects to the same seat; grace expiry lets the host hand the seat to the computer', () => {
    const { a, b, room, host, mk } = startTwo();
    room.onClose(b.connId);
    a.drain();
    expect(a.lobby.seats[1].connected).toBe(false);
    // Reconnect within grace: same seat, fresh snapshot.
    const b2 = new Client(room, host, 'b2', 'client2');
    b2.open();
    b2.hello('Bo');
    expect(b2.seat).toBe(1);
    expect(b2.messages().some((m) => m.t === 'snapshot')).toBe(true);
    // Disconnect again and let the grace run out.
    room.onClose('b2');
    host.t += 121_000;
    room.tick();
    a.drain();
    expect(a.messages().some((m) => m.t === 'graceExpired')).toBe(true);
    a.send({ t: 'replaceWithAi', seat: 1, level: 'normal' });
    expect(room.seats[1]!.kind).toBe('ai');
    // The computer now acts for seat 1 whenever it holds the prompt.
    let guard = 0;
    const rng = seedRng('r');
    while (!room.game!.result && guard++ < 3000) {
      const p = room.game!.prompt!;
      if (p.seat === 1) {
        host.t += 2000;
        room.tick();
      } else {
        a.drain();
        if (!a.legal) { host.t += 5000; room.tick(); continue; }
        a.send({ t: 'cmd', cid: ++a.cid, command: chooseCommand('easy', a.view!, a.legal, roomOptions().rules, rng) });
      }
    }
    expect(room.game!.result).not.toBeNull();
    void mk;
  });

  it('a spectator joining mid-game sees only public information', () => {
    const { room, mk } = startTwo();
    const s = mk(9);
    s.hello('Watcher');
    expect(s.seat).toBeNull();
    expect(s.view!.players.every((p) => p.hand === null)).toBe(true);
    expect(s.legal).toBeNull();
    void room;
  });

  it('serialize/restore mid-game resumes exactly (Durable Object hibernation)', () => {
    const { a, b, room, host } = startTwo();
    const rng = seedRng('h');
    for (let i = 0; i < 25 && !room.game!.result; i++) {
      const c = [a, b][room.game!.prompt!.seat]!;
      c.drain();
      if (!c.legal) { host.t += 5000; room.tick(); continue; }
      c.send({ t: 'cmd', cid: ++c.cid, command: chooseCommand('easy', c.view!, c.legal, roomOptions().rules, rng) });
    }
    const data = JSON.parse(JSON.stringify(room.serialize()));
    const room2 = Room.restore(data, host, roomOptions());
    expect(JSON.stringify(viewFor(room2.game!, 0))).toBe(JSON.stringify(viewFor(room.game!, 0)));
    expect(room2.seq).toBe(room.seq);
    expect(JSON.stringify(data).length).toBeLessThan(200_000);
  });

  it('rate-limits a flood without crashing', () => {
    const { a, host } = startTwo();
    for (let i = 0; i < 200; i++) a.room.onMessage(a.connId, JSON.stringify({ t: 'ping', at: i }));
    expect(host.logs.some((l) => l.m === 'rate limited')).toBe(true);
  });

  it('keeps update messages small (patches, not full state)', () => {
    const { a, b, room } = startTwo();
    const rng = seedRng('s');
    for (let i = 0; i < 30 && !room.game!.result; i++) {
      const c = [a, b][room.game!.prompt!.seat]!;
      c.drain();
      if (!c.legal) break;
      c.send({ t: 'cmd', cid: ++c.cid, command: chooseCommand('easy', c.view!, c.legal, roomOptions().rules, rng) });
    }
    const updates = a.messages().filter((m) => m.t === 'update').map((m) => JSON.stringify(m).length);
    const snap = JSON.stringify(a.messages().find((m) => m.t === 'snapshot')).length;
    const avg = updates.reduce((x, y) => x + y, 0) / Math.max(1, updates.length);
    expect(avg).toBeLessThan(snap / 4);
  });
});

describe('Room balance and logs (Stage 8)', () => {
  function playOut(env: ReturnType<typeof startTwo>) {
    const { a, b, room, host } = env;
    const clients = [a, b];
    const rng = seedRng('log-ai');
    let n = 0;
    while (room.game && !room.game.result && n++ < 4000) {
      for (const c of clients) c.drain();
      const c = clients[room.game.prompt!.seat]!;
      if (!c.legal) {
        host.t += 10_000;
        room.tick();
        continue;
      }
      c.send({ t: 'cmd', cid: ++c.cid, command: chooseCommand('normal', c.view!, c.legal, roomOptions().rules, rng) });
    }
  }

  it('only after the game: sends a full log that replays to the same result', () => {
    const env = startTwo();
    env.a.send({ t: 'getLog' });
    expect(env.a.errors).toContain('no_log');
    playOut(env);
    env.a.send({ t: 'getLog' });
    const msg = env.a.messages().filter((m) => m.t === 'log').pop() as any;
    const { log, error } = checkLog(msg.log);
    expect(error).toBeUndefined();
    const rp = new Replayer(log!);
    expect(rp.divergence).toBeNull();
    expect(rp.length).toBe(log!.commands.length);
    expect(rp.final.result).toEqual(env.room.game!.result);
    expect(log!.players.map((p) => p.kind)).toEqual(['human', 'human']);
  });

  it('the host can play the room under a balance overlay; it is cleaned, shown in the lobby and survives restore', () => {
    const { mk, room, host } = setup();
    const a = mk(1);
    a.hello('Ann');
    const b = mk(2);
    b.hello('Bo');
    b.send({ t: 'setBalance', balance: { name: 'x', cards: { BU_HB: { stats: { cyber: 3, psionic: 0, physical: 3 } } } } });
    expect(b.errors).toContain('not_host');
    a.send({ t: 'setBalance', balance: { name: 'Robot test', cards: { BU_HB: { stats: { cyber: 3, psionic: 0, physical: 3 } }, BU_LQ: { name: 'Hacked' } } } });
    expect(a.errors).toContain('balance_warn'); // the name change is refused
    b.drain();
    expect(b.lobby.balance.name).toBe('Robot test');
    expect(b.lobby.balance.cards).toBe(1);
    expect(room.defs()['BU_HB']!.stats!.physical).toBe(3);
    expect(room.defs()['BU_LQ']!.name).toBe('Loquidor Stalker');
    a.send({ t: 'start' });
    expect(room.game!.defs['BU_HB']!.stats!.physical).toBe(3);
    const restored = Room.restore(JSON.parse(JSON.stringify(room.serialize())), host, roomOptions());
    expect(restored.game!.defs['BU_HB']!.stats!.physical).toBe(3);
    a.send({ t: 'setBalance', balance: null });
    expect(a.errors).toContain('not_host'); // not during a game
  });
});
