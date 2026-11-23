/**
 * End-to-end over real WebSockets: create a room over HTTP, two clients join with the room
 * code, the host starts, both play a full game (decisions by the AI from what each client
 * receives), one client drops mid-game and reconnects to its seat.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyViewPatch, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@psi-wars/shared';
import { chooseCommand, seedRng, type GameView, type LegalView } from '@psi-wars/engine';
import { roomOptions } from '@psi-wars/room';
import { startServer } from '../src/index';

let srv: Awaited<ReturnType<typeof startServer>>;
let base = '';
const rules = roomOptions().rules;

// PSI_BASE=http://localhost:8788 runs the same tests against `wrangler dev` (the Cloudflare server).
const external = process.env.PSI_BASE;
beforeAll(async () => {
  if (external) {
    base = external;
    return;
  }
  srv = await startServer({ port: 0, staticDir: null, quiet: true, aiDelayScale: 0 });
  base = `http://localhost:${srv.port}`;
});
afterAll(async () => {
  await srv?.close();
});

class NetClient {
  ws!: WebSocket;
  view: GameView | null = null;
  legal: LegalView | null = null;
  seat: number | null = null;
  lastSeq = -1;
  gaps = 0;
  result: unknown = null;
  lobby: any = null;
  cid = 0;
  waiters: (() => void)[] = [];
  constructor(public code: string, public clientId: string, public name: string) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${this.code}`);
      this.ws.onopen = () => {
        this.send({ t: 'hello', protocol: PROTOCOL_VERSION, clientId: this.clientId, name: this.name });
        resolve();
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (e) => this.onMsg(JSON.parse(String(e.data)) as ServerMsg);
    });
  }
  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }
  onMsg(m: ServerMsg) {
    if (m.t === 'welcome') this.seat = m.seat;
    if (m.t === 'lobby') this.lobby = m.lobby;
    if (m.t === 'snapshot') {
      this.view = m.view as GameView;
      this.legal = m.legal as LegalView | null;
      this.lastSeq = m.seq;
    }
    if (m.t === 'update') {
      if (m.seq !== this.lastSeq + 1) this.gaps++;
      this.lastSeq = m.seq;
      this.view = applyViewPatch(this.view as any, m.patch) as GameView;
      this.legal = m.legal as LegalView | null;
    }
    if (m.t === 'deadline') this.lastSeq = m.seq;
    if (this.view?.result) this.result = this.view.result;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  next(): Promise<void> {
    return new Promise((r) => {
      this.waiters.push(r);
      setTimeout(r, 50);
    });
  }
}

async function until(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe(`online play over WebSockets (${external ? 'external server ' + external : 'local server'})`, () => {
  it('creates a room with an unambiguous 6-character code', async () => {
    const r = await fetch(`${base}/api/rooms`, { method: 'POST' });
    const j = (await r.json()) as { code: string };
    expect(j.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
  });

  it('two clients join by code, play a full game, and survive a reconnect', async () => {
    const { code } = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const a = new NetClient(code, 'alice', 'Alice');
    const b = new NetClient(code, 'bob', 'Bob');
    await a.connect();
    await until(() => a.seat === 0);
    await b.connect();
    await until(() => b.seat === 1 && a.lobby?.seats?.[1]?.kind === 'human');
    a.send({ t: 'config', config: { trapWindowSec: 0 } }); // keep the test fast
    a.send({ t: 'start' });
    await until(() => !!a.view && !!b.view);
    const clients = [a, b];
    const rng = seedRng('net');
    let reconnected = false;
    let steps = 0;
    let sent = 0;
    while (!a.result && steps++ < 3000) {
      // Drop Bob once, early in the game, and reconnect with the same client id.
      if (!reconnected && sent === 6) {
        b.ws.close();
        await new Promise((r) => setTimeout(r, 30));
        const b2 = new NetClient(code, 'bob', 'Bob');
        await b2.connect();
        await until(() => b2.seat === 1 && !!b2.view);
        clients[1] = b2;
        reconnected = true;
      }
      const actor = clients.find((c) => c.legal && c.view && c.view.prompt?.seat === c.seat);
      if (!actor) {
        await Promise.race(clients.map((c) => c.next()));
        continue;
      }
      const cmd = chooseCommand('normal', actor.view!, actor.legal!, rules, rng);
      actor.legal = null;
      sent++;
      actor.send({ t: 'cmd', cid: ++actor.cid, command: cmd });
      await actor.next();
      await new Promise((r) => setTimeout(r, 45)); // a fast human, well under the rate limit
    }
    expect(reconnected).toBe(true);
    expect(a.result).not.toBeNull();
    await until(() => !!clients[1]!.view?.result);
    expect(clients[1]!.view!.result).toEqual(a.result);
    expect(a.gaps).toBe(0);
    for (const c of clients) c.ws.close();
  }, 120_000);

  it('a 4-seat room — two people and two computer players — completes a game', async () => {
    const { code } = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const a = new NetClient(code, 'p-ann', 'Ann');
    const b = new NetClient(code, 'p-ben', 'Ben');
    await a.connect();
    await until(() => a.seat === 0);
    a.send({ t: 'config', config: { seats: 4, trapWindowSec: 0 } });
    await until(() => a.lobby?.seats?.length === 4);
    await b.connect();
    await until(() => b.seat === 1);
    a.send({ t: 'seatAi', seat: 2, level: 'normal' });
    a.send({ t: 'seatAi', seat: 3, level: 'hard' });
    await until(() => a.lobby?.seats?.every((s: any) => s.kind !== 'open'));
    a.send({ t: 'start' });
    await until(() => !!a.view && !!b.view);
    expect(a.view!.players).toHaveLength(4);
    const rng = seedRng('net4');
    let steps = 0;
    while (!a.view!.result && steps++ < 6000) {
      const actor = [a, b].find((c) => c.legal && c.view && c.view.prompt?.seat === c.seat);
      if (!actor) {
        await Promise.race([a.next(), b.next()]);
        continue;
      }
      const cmd = chooseCommand('normal', actor.view!, actor.legal!, rules, rng);
      actor.legal = null;
      actor.send({ t: 'cmd', cid: ++actor.cid, command: cmd });
      await actor.next();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(a.view!.result).not.toBeNull();
    await until(() => !!b.view?.result);
    expect(b.view!.result).toEqual(a.view!.result);
    // Hands of other seats never reached either client.
    expect(a.view!.players.filter((p) => p.seat !== 0).every((p) => p.hand === null)).toBe(true);
    a.ws.close();
    b.ws.close();
  }, 240_000);

  it('rejects unknown rooms and mismatched protocol versions', async () => {
    const bad = new WebSocket(`${base.replace('http', 'ws')}/ws/ZZZZZZ`);
    const closed = await new Promise<boolean>((r) => {
      bad.onerror = () => r(true);
      bad.onclose = () => r(true);
      bad.onopen = () => r(false);
    });
    expect(closed).toBe(true);

    const { code } = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${code}`);
    const msgs: ServerMsg[] = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION + 99, clientId: 'x', name: 'x' }));
    await until(() => msgs.some((m) => m.t === 'error'));
    expect(msgs.find((m) => m.t === 'error')).toMatchObject({ code: 'protocol', fatal: true });
  });
});
