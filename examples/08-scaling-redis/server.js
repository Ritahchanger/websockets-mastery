// Chapter 8 — Horizontally scaled raw `ws` chat using Redis pub/sub.
//
// Run several copies (PORT=3001, PORT=3002, ...) against the same Redis and
// clients connected to *different* processes can still chat in the same room.
//
//   REDIS_URL=redis://127.0.0.1:6379 PORT=3001 node examples/08-scaling-redis/server.js
//   REDIS_URL=redis://127.0.0.1:6379 PORT=3002 node examples/08-scaling-redis/server.js
//
// Design:
//   * Each process keeps only its OWN sockets in memory (localRooms).
//   * Every room message is PUBLISHed to Redis channel `chat:room:<name>`.
//   * A process SUBSCRIBEs to a room channel only while it has at least one
//     local member in that room (lazy subscribe / unsubscribe).
//   * ALL delivery goes through Redis — even to sockets on the publishing
//     node — so every node follows one code path and ordering per channel is
//     the same everywhere.
//   * Presence lives in Redis: a SET per room + a per-node liveness key with a
//     TTL, so members of a crashed node disappear automatically.

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
// A stable-ish, human-readable node id: host + port + random suffix.
const NODE_ID = process.env.NODE_ID ?? `${os.hostname()}:${PORT}:${randomUUID().slice(0, 6)}`;
const NODE_TTL_SEC = 15; // liveness key expiry
const HEARTBEAT_MS = 5_000; // refresh liveness + ws ping sweep

// ---------------------------------------------------------------------------
// Redis: one connection for commands/PUBLISH, one dedicated to SUBSCRIBE.
// A connection in subscriber mode can only run (P)SUBSCRIBE/(P)UNSUBSCRIBE/PING.
// ---------------------------------------------------------------------------
const pub = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
const sub = pub.duplicate();
for (const [name, c] of [['pub', pub], ['sub', sub]]) {
  c.on('error', (err) => console.error(`[redis:${name}]`, err.message));
}

const roomChannel = (room) => `chat:room:${room}`;
const presenceKey = (room) => `chat:presence:${room}`;
const nodeKey = (id) => `chat:node:${id}`;

// ---------------------------------------------------------------------------
// Local state (this process only)
// ---------------------------------------------------------------------------
/** @type {Map<string, Set<import('ws').WebSocket>>} room -> local sockets */
const localRooms = new Map();
const stats = { published: 0, delivered: 0, received: 0 };

// ---------------------------------------------------------------------------
// Protocol (same envelope as chapter 4): { type, id, payload, replyTo? }
// ---------------------------------------------------------------------------
const roomName = z.string().min(1).max(40).regex(/^[\w-]+$/);
const Envelope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room:join'), id: z.string(), payload: z.object({ room: roomName, user: z.string().min(1).max(30) }) }),
  z.object({ type: z.literal('room:leave'), id: z.string(), payload: z.object({ room: roomName }) }),
  z.object({ type: z.literal('chat:message'), id: z.string(), payload: z.object({ room: roomName, text: z.string().min(1).max(2000) }) }),
  z.object({ type: z.literal('presence:list'), id: z.string(), payload: z.object({ room: roomName }) }),
]);

function send(ws, type, payload, replyTo) {
  if (ws.readyState !== ws.OPEN) return;
  // Crude slow-consumer protection (see chapter 5): skip if >1 MiB queued.
  if (ws.bufferedAmount > 1 << 20) return;
  const msg = { type, id: randomUUID(), payload };
  if (replyTo) msg.replyTo = replyTo;
  ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Fan-out: publish to Redis; the subscriber below delivers to local sockets.
// ---------------------------------------------------------------------------
async function publishToRoom(room, type, payload) {
  stats.published++;
  // Wrap with origin info so receivers can tell where it came from (debugging,
  // or to skip local echo if you choose to deliver locally first).
  await pub.publish(roomChannel(room), JSON.stringify({ origin: NODE_ID, type, payload }));
}

sub.on('message', (channel, raw) => {
  stats.received++;
  const room = channel.slice('chat:room:'.length);
  const members = localRooms.get(room);
  if (!members) return; // raced with an unsubscribe — harmless
  let evt;
  try { evt = JSON.parse(raw); } catch { return; }
  // Serialize ONCE, send many times (important at high fan-out).
  const data = JSON.stringify({ type: evt.type, id: randomUUID(), payload: { ...evt.payload, via: evt.origin } });
  for (const ws of members) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1 << 20) {
      ws.send(data);
      stats.delivered++;
    }
  }
});

async function joinRoom(ws, room) {
  let members = localRooms.get(room);
  if (!members) {
    members = new Set();
    localRooms.set(room, members);
    await sub.subscribe(roomChannel(room)); // first local member -> subscribe
  }
  members.add(ws);
  ws.rooms.add(room);
  await pub.sadd(presenceKey(room), memberId(ws));
}

async function leaveRoom(ws, room) {
  const members = localRooms.get(room);
  ws.rooms.delete(room);
  await pub.srem(presenceKey(room), memberId(ws));
  if (!members) return;
  members.delete(ws);
  if (members.size === 0) {
    localRooms.delete(room);
    await sub.unsubscribe(roomChannel(room)); // last local member -> unsubscribe
  }
}

// Presence member = "<nodeId>|<connId>|<user>" — the node id lets us filter out
// members whose node has died (its liveness key expired).
const memberId = (ws) => `${NODE_ID}|${ws.connId}|${ws.user}`;

async function listPresence(room) {
  const raw = await pub.smembers(presenceKey(room));
  const nodes = [...new Set(raw.map((m) => m.split('|')[0]))];
  const alive = new Set();
  if (nodes.length) {
    const flags = await pub.mget(nodes.map(nodeKey));
    nodes.forEach((n, i) => flags[i] && alive.add(n));
  }
  const users = [];
  const stale = [];
  for (const m of raw) {
    const [node, , user] = m.split('|');
    if (alive.has(node)) users.push({ user, node });
    else stale.push(m);
  }
  if (stale.length) await pub.srem(presenceKey(room), ...stale); // lazy GC
  return users;
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket (noServer + upgrade, as in chapter 3)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: pub.status === 'ready', node: NODE_ID }));
app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(
    [
      `# TYPE ws_connections gauge`,
      `ws_connections{node="${NODE_ID}"} ${wss.clients.size}`,
      `# TYPE ws_local_rooms gauge`,
      `ws_local_rooms{node="${NODE_ID}"} ${localRooms.size}`,
      `# TYPE ws_published_total counter`,
      `ws_published_total{node="${NODE_ID}"} ${stats.published}`,
      `# TYPE ws_redis_received_total counter`,
      `ws_redis_received_total{node="${NODE_ID}"} ${stats.received}`,
      `# TYPE ws_delivered_total counter`,
      `ws_delivered_total{node="${NODE_ID}"} ${stats.delivered}`,
      `# TYPE process_resident_memory_bytes gauge`,
      `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '',
    ].join('\n'),
  );
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' && !req.url.startsWith('/ws?')) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  ws.connId = randomUUID().slice(0, 8);
  ws.user = 'anon';
  ws.rooms = new Set();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, 'hello', { node: NODE_ID, connId: ws.connId, forwardedFor: req.headers['x-forwarded-for'] ?? null });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = Envelope.parse(JSON.parse(data.toString()));
    } catch {
      return send(ws, 'error', { message: 'invalid message' });
    }
    try {
      switch (msg.type) {
        case 'room:join': {
          ws.user = msg.payload.user;
          await joinRoom(ws, msg.payload.room);
          send(ws, 'room:joined', { room: msg.payload.room, node: NODE_ID }, msg.id);
          await publishToRoom(msg.payload.room, 'presence:joined', { room: msg.payload.room, user: ws.user });
          break;
        }
        case 'room:leave': {
          await leaveRoom(ws, msg.payload.room);
          send(ws, 'room:left', { room: msg.payload.room }, msg.id);
          await publishToRoom(msg.payload.room, 'presence:left', { room: msg.payload.room, user: ws.user });
          break;
        }
        case 'chat:message': {
          if (!ws.rooms.has(msg.payload.room)) return send(ws, 'error', { message: 'join the room first' }, msg.id);
          await publishToRoom(msg.payload.room, 'chat:message', {
            room: msg.payload.room, user: ws.user, text: msg.payload.text, ts: Date.now(),
          });
          send(ws, 'ack', { ok: true }, msg.id);
          break;
        }
        case 'presence:list': {
          send(ws, 'presence:list', { room: msg.payload.room, users: await listPresence(msg.payload.room) }, msg.id);
          break;
        }
      }
    } catch (err) {
      console.error('handler error', err);
      send(ws, 'error', { message: 'server error' }, msg.id);
    }
  });

  ws.on('close', async () => {
    for (const room of [...ws.rooms]) {
      try {
        await leaveRoom(ws, room);
        await publishToRoom(room, 'presence:left', { room, user: ws.user });
      } catch { /* redis down — liveness TTL will clean up */ }
    }
  });
});

// Heartbeat: terminate dead sockets (chapter 5) + refresh node liveness key.
async function beat() {
  await pub.set(nodeKey(NODE_ID), String(Date.now()), 'EX', NODE_TTL_SEC).catch(() => {});
}
const timer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  beat();
}, HEARTBEAT_MS);
await beat();

server.listen(PORT, () => {
  console.log(`[${NODE_ID}] listening on http://localhost:${PORT}  (redis ${REDIS_URL})`);
});

// Graceful shutdown: tell clients to go elsewhere (1001), clean presence.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${NODE_ID}] ${signal} — draining ${wss.clients.size} clients`);
  clearInterval(timer);
  server.close();
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  // Remove this node's presence entries eagerly (TTL would do it eventually).
  await Promise.allSettled(
    [...localRooms.keys()].map(async (room) => {
      const raw = await pub.smembers(presenceKey(room));
      const mine = raw.filter((m) => m.startsWith(`${NODE_ID}|`));
      if (mine.length) await pub.srem(presenceKey(room), ...mine);
    }),
  );
  await pub.del(nodeKey(NODE_ID)).catch(() => {});
  setTimeout(() => {
    for (const ws of wss.clients) ws.terminate();
    sub.disconnect();
    pub.disconnect();
    process.exit(0);
  }, 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
