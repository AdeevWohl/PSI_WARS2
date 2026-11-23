/**
 * Psi Wars on Cloudflare: a Worker plus one Durable Object per room (build prompt §4.3).
 * The room code is the Durable Object's name; the DO holds the authoritative game and the
 * WebSockets for its seats. Uses SQLite-backed storage and the WebSocket Hibernation API,
 * so an idle room costs nothing while players think.
 *
 *   POST /api/rooms   -> { code }
 *   GET  /ws/<CODE>   -> WebSocket into that room's Durable Object
 *   everything else   -> the built client (Workers Assets), same origin: no CORS
 */
import { DurableObject } from 'cloudflare:workers';
import { Room, roomOptions, type RoomData, type RoomHost } from '@psi-wars/room';
import { isRoomCode, makeRoomCode, normalizeRoomCode, PROTOCOL_VERSION } from '@psi-wars/shared';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>;
  ASSETS: Fetcher;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let i = 0; i < 10; i++) {
        const code = makeRoomCode((n) => crypto.getRandomValues(new Uint8Array(n)));
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch('https://room/init', { method: 'POST', body: code });
        if (r.ok) return json({ code, protocol: PROTOCOL_VERSION });
      }
      return json({ error: 'Could not allocate a room code' }, 503);
    }
    if (url.pathname === '/api/health') return json({ ok: true, protocol: PROTOCOL_VERSION });
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (m) {
      const code = normalizeRoomCode(m[1]!);
      if (!isRoomCode(code)) return new Response('Bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request('https://room/ws', request));
    }
    return env.ASSETS.fetch(request);
  },
};

interface Attachment {
  connId: string;
  clientId: string | null;
}

export class RoomDO extends DurableObject<Env> {
  private room: Room | null = null;
  private opts = roomOptions();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const data = await ctx.storage.get<RoomData>('room');
      if (!data) return;
      this.room = Room.restore(data, this.host(), this.opts);
      // Woke from hibernation: re-register the sockets that are still connected.
      for (const ws of ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att) this.room.rehydrateConn(att.connId, att.clientId);
      }
    });
  }

  private host(): RoomHost {
    return {
      send: (connId, msg) => {
        for (const ws of this.ctx.getWebSockets(connId)) {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* socket closing */
          }
        }
      },
      close: (connId, code, reason) => {
        for (const ws of this.ctx.getWebSockets(connId)) ws.close(code ?? 4000, reason ?? '');
      },
      now: () => Date.now(),
      log: (message, data) => console.log(`[room] ${message}`, data ? JSON.stringify(data) : ''),
      randomSeed: () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    };
  }

  /** Save after every change, and arm the alarm for the next deadline. */
  private async persist(): Promise<void> {
    if (!this.room) return;
    await this.ctx.storage.put('room', this.room.serialize());
    const next = this.room.nextDeadline();
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 10, next));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (this.room) return new Response('Room code in use', { status: 409 });
      const code = await request.text();
      this.room = new Room(code, this.host(), this.opts);
      await this.persist();
      return new Response('ok');
    }
    if (url.pathname === '/ws') {
      if (!this.room) return new Response('No such room', { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const connId = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, [connId]);
      server.serializeAttachment({ connId, clientId: null } satisfies Attachment);
      this.room.onOpen(connId);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.room) return;
    const att = ws.deserializeAttachment() as Attachment;
    this.room.onMessage(att.connId, typeof message === 'string' ? message : new TextDecoder().decode(message));
    const clientId = this.room.clientIdOf(att.connId);
    if (clientId !== att.clientId) ws.serializeAttachment({ connId: att.connId, clientId } satisfies Attachment);
    await this.persist();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    if (!this.room) return;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att) this.room.onClose(att.connId);
    await this.persist();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Response windows, turn timers, AI moves, reconnect grace and idle expiry (default 2 h). */
  override async alarm(): Promise<void> {
    if (!this.room) return;
    if (this.room.tick() === 'expired') {
      for (const ws of this.ctx.getWebSockets()) ws.close(4000, 'expired');
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.persist();
  }
}
