// Chapter 6 — Security: ticket-based auth, Origin check, per-IP limits,
// token-bucket rate limiting, maxPayload, per-message validation + authorization.
//
// Flow:
//   1. POST /api/login   {username,password}  -> { token }   (long-ish lived JWT, stays in HTTP land)
//   2. POST /api/ticket  Authorization: Bearer <jwt> -> { ticket } (single-use, 30 s, bound to IP)
//   3. new WebSocket('ws://host/ws?ticket=...')  -> upgrade is checked BEFORE the handshake completes
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

const PORT = Number(process.env.PORT) || 3000;
// In production: a long random secret from a secret manager, never a literal.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`).split(',')
);
const TICKET_TTL_MS = 30_000;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 5;
const MAX_PAYLOAD = 16 * 1024; // 16 KiB — chat messages never need more
const RATE = { capacity: 10, refillPerSec: 5 }; // burst of 10, sustained 5 msg/s
const MAX_VIOLATIONS = 3;

// ---------------------------------------------------------------------------
// Demo user store (use a real DB + bcrypt/argon2 in production)
// ---------------------------------------------------------------------------
const USERS = {
  alice: { password: 'alice123', roles: ['member', 'admin'] },
  bob: { password: 'bob123', roles: ['member'] },
};
// Room ACL: which role may join which room.
const ROOM_ACL = { general: 'member', random: 'member', admins: 'admin' };

// ---------------------------------------------------------------------------
// HTTP side
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const user = USERS[username];
  // Constant-time compare to avoid timing oracles (demo-grade).
  const ok =
    user &&
    typeof password === 'string' &&
    password.length === user.password.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(user.password));
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: username, roles: user.roles }, JWT_SECRET, {
    expiresIn: '15m',
    algorithm: 'HS256',
  });
  res.json({ token });
});

function requireJwt(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
  if (!m) return res.status(401).json({ error: 'missing bearer token' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

// ticket -> { user, ip, expires }
const tickets = new Map();
app.post('/api/ticket', requireJwt, (req, res) => {
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, {
    user: { id: req.user.sub, roles: req.user.roles },
    ip: req.socket.remoteAddress,
    expires: Date.now() + TICKET_TTL_MS,
  });
  res.json({ ticket, expiresIn: TICKET_TTL_MS / 1000 });
});
// Sweep expired tickets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t);
}, 10_000).unref();

function redeemTicket(ticket, ip) {
  if (!ticket) return null;
  const entry = tickets.get(ticket);
  tickets.delete(ticket); // single use — even on failure
  if (!entry || entry.expires < Date.now() || entry.ip !== ip) return null;
  return entry.user;
}

// ---------------------------------------------------------------------------
// WebSocket side
// ---------------------------------------------------------------------------
const server = http.createServer(app);
// Slowloris-ish defences on the HTTP layer (the upgrade request is HTTP too).
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD, // bigger frames -> close 1009
  perMessageDeflate: false, // no compression = no zip-bomb / memory amplification
});

const connsPerIp = new Map();

function reject(socket, status, message) {
  // Write a minimal HTTP response on the raw socket and hang up.
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
      'Connection: close\r\nContent-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  );
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const url = new URL(req.url, 'http://placeholder');
  const ip = req.socket.remoteAddress;

  if (url.pathname !== '/ws') return reject(socket, 404, 'not found');

  // 1. Origin check — the CSWSH defence. Browsers always send Origin on WS handshakes.
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    log('reject', { ip, reason: 'origin', origin });
    return reject(socket, 403, 'origin not allowed');
  }

  // 2. Per-IP connection limit.
  if ((connsPerIp.get(ip) ?? 0) >= MAX_CONN_PER_IP) {
    log('reject', { ip, reason: 'too many connections' });
    return reject(socket, 429, 'too many connections');
  }

  // 3. Authenticate with a single-use ticket.
  const user = redeemTicket(url.searchParams.get('ticket'), ip);
  if (!user) {
    log('reject', { ip, reason: 'bad ticket' });
    return reject(socket, 401, 'invalid or expired ticket');
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.ip = ip;
    wss.emit('connection', ws, req);
  });
});

// ---------------------------------------------------------------------------
// Token bucket (per connection)
// ---------------------------------------------------------------------------
function createBucket({ capacity, refillPerSec }) {
  let tokens = capacity;
  let last = Date.now();
  return function take() {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

// ---------------------------------------------------------------------------
// Protocol (envelope from chapter 4) + validation
// ---------------------------------------------------------------------------
const RoomName = z.string().regex(/^[a-z0-9-]{1,32}$/);
const Incoming = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room:join'), id: z.string().max(64), payload: z.object({ room: RoomName }) }),
  z.object({
    type: z.literal('chat:message'),
    id: z.string().max(64),
    payload: z.object({ room: RoomName, text: z.string().min(1).max(2000) }),
  }),
]);

const rooms = new Map(); // room -> Set<ws>

function send(ws, type, payload, replyTo) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, id: crypto.randomUUID(), payload, ...(replyTo && { replyTo }) }));
}

function canJoin(user, room) {
  const needed = ROOM_ACL[room];
  return Boolean(needed && user.roles.includes(needed));
}

wss.on('connection', (ws) => {
  connsPerIp.set(ws.ip, (connsPerIp.get(ws.ip) ?? 0) + 1);
  ws.rooms = new Set();
  ws.violations = 0;
  const take = createBucket(RATE);
  log('connect', { user: ws.user.id, ip: ws.ip });
  send(ws, 'session:welcome', { user: ws.user.id, roles: ws.user.roles, rooms: Object.keys(ROOM_ACL) });

  const strike = (reason, replyTo) => {
    ws.violations += 1;
    send(ws, 'error', { reason }, replyTo);
    if (ws.violations >= MAX_VIOLATIONS) ws.close(1008, 'policy violation');
  };

  ws.on('message', (data, isBinary) => {
    if (!take()) return strike('rate limited');
    if (isBinary) return strike('binary not accepted');

    let parsed;
    try {
      parsed = Incoming.safeParse(JSON.parse(data.toString('utf8')));
    } catch {
      return strike('invalid json');
    }
    if (!parsed.success) return strike('invalid message');
    const msg = parsed.data;

    switch (msg.type) {
      case 'room:join': {
        const { room } = msg.payload;
        // Authorization happens per message, not only at connect time.
        if (!canJoin(ws.user, room)) return send(ws, 'error', { reason: 'forbidden' }, msg.id);
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(ws);
        ws.rooms.add(room);
        return send(ws, 'room:joined', { room }, msg.id);
      }
      case 'chat:message': {
        const { room, text } = msg.payload;
        if (!ws.rooms.has(room)) return send(ws, 'error', { reason: 'not in room' }, msg.id);
        // Identity comes from the server-side session, NEVER from the payload.
        const out = { room, from: ws.user.id, text, at: Date.now() };
        for (const peer of rooms.get(room)) send(peer, 'chat:message', out);
        return;
      }
    }
  });

  ws.on('close', (code) => {
    const n = (connsPerIp.get(ws.ip) ?? 1) - 1;
    n <= 0 ? connsPerIp.delete(ws.ip) : connsPerIp.set(ws.ip, n);
    for (const r of ws.rooms) rooms.get(r)?.delete(ws);
    log('disconnect', { user: ws.user.id, code });
  });
  ws.on('error', () => {}); // e.g. 1009 maxPayload errors; 'close' follows
});

// Structured logging — note we log the path only, never the query string (ticket).
function log(event, fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

server.listen(PORT, () => {
  console.log(`Chapter 6 secure server on http://localhost:${PORT}`);
  console.log('Demo users: alice/alice123 (admin), bob/bob123');
});
