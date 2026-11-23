/**
 * Local game server: the same protocol and the same Room as the Cloudflare Worker, over a
 * plain Node WebSocket server. For development and for playing with no Cloudflare account:
 * run it, expose it with a Cloudflare Quick Tunnel, share the URL (see README).
 *
 *   GET  /            the built client (packages/client/dist)
 *   POST /api/rooms   create a room -> { code }
 *   GET  /ws/<CODE>   WebSocket into that room
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, roomOptions, type RoomHost } from '@psi-wars/room';
import { isRoomCode, makeRoomCode, normalizeRoomCode, PROTOCOL_VERSION } from '@psi-wars/shared';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.map': 'application/json', '.ico': 'image/x-icon',
};

export interface ServerOptions {
  port: number;
  staticDir?: string | null;
  graceMs?: number;
  quiet?: boolean;
  aiDelayScale?: number;
}

interface RoomEntry {
  room: Room;
  sockets: Map<string, WebSocket>;
  timer: NodeJS.Timeout | null;
}

export function startServer(opts: ServerOptions) {
  const rooms = new Map<string, RoomEntry>();
  const opt = roomOptions({ graceMs: opts.graceMs, aiDelayScale: opts.aiDelayScale });
  const log = (m: string, d?: unknown) => {
    if (!opts.quiet) console.log(`[psi-wars] ${m}`, d ? JSON.stringify(d) : '');
  };
  const staticDir = opts.staticDir === undefined ? resolve(import.meta.dirname ?? '.', '..', '..', 'client', 'dist') : opts.staticDir;

  function makeRoom(code: string): RoomEntry {
    const entry: RoomEntry = { room: null as unknown as Room, sockets: new Map(), timer: null };
    const host: RoomHost = {
      send: (connId, msg) => {
        const ws = entry.sockets.get(connId);
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (connId, code, reason) => entry.sockets.get(connId)?.close(code, reason),
      now: () => Date.now(),
      log,
      randomSeed: () => randomBytes(12).toString('hex'),
    };
    entry.room = new Room(code, host, opt);
    rooms.set(code, entry);
    return entry;
  }

  /** Run due timers, then arm one timeout for the next deadline. */
  function schedule(code: string): void {
    const e = rooms.get(code);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    const next = e.room.nextDeadline();
    if (next === null) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      if (e.room.tick() === 'expired') {
        for (const ws of e.sockets.values()) ws.close(4000, 'expired');
        rooms.delete(code);
        return;
      }
      schedule(code);
    }, Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1)));
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    if (!staticDir || !existsSync(staticDir)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Psi Wars game server is running. Build the client (npm run build) to serve it from here.');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(staticDir, path);
    if (!file.startsWith(staticDir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, 'index.html');
    path = file;
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    createReadStream(path).pipe(res);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      let code = '';
      for (let i = 0; i < 20 && (!code || rooms.has(code)); i++) code = makeRoomCode((n) => randomBytes(n));
      makeRoom(code);
      schedule(code);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code, protocol: PROTOCOL_VERSION }));
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, protocol: PROTOCOL_VERSION }));
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
    const code = m ? normalizeRoomCode(m[1]!) : '';
    const entry = isRoomCode(code) ? rooms.get(code) : undefined;
    if (!entry) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connId = randomUUID();
      entry.sockets.set(connId, ws);
      entry.room.onOpen(connId);
      ws.on('message', (data) => {
        entry.room.onMessage(connId, data.toString());
        schedule(code);
      });
      ws.on('close', () => {
        entry.sockets.delete(connId);
        entry.room.onClose(connId);
        schedule(code);
      });
    });
  });

  return new Promise<{ port: number; close: () => Promise<void>; rooms: Map<string, RoomEntry> }>((resolveStart) => {
    server.listen(opts.port, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`listening on http://localhost:${port}`);
      resolveStart({
        port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            for (const e of rooms.values()) {
              if (e.timer) clearTimeout(e.timer);
              for (const ws of e.sockets.values()) ws.terminate();
            }
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}
