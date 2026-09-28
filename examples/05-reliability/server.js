// examples/05-reliability/server.js
// Chapter 5 — Reliability: heartbeats, sessions + replay, acks, backpressure, graceful shutdown.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---- Tunables -------------------------------------------------------------
const HEARTBEAT_MS = 15_000;          // ping sweep interval (well under proxy idle timeouts)
const SESSION_TTL_MS = 60_000;        // keep a disconnected session this long
const REPLAY_LIMIT = 500;             // messages kept per session for replay
const SEEN_IDS_LIMIT = 1_000;         // recent client message ids kept for dedup
const SOFT_LIMIT = 64 * 1024;         // drop volatile sends above this bufferedAmount
const HARD_LIMIT = 1024 * 1024;       // disconnect slow consumer above this
const SHUTDOWN_GRACE_MS = 5_000;      // drain time before terminating stragglers

// ---- 1. Validation (Chapter 4 envelope) -----------------------------------
const Envelope = z.object({
  type: z.string().min(1).max(64),
  id: z.string().uuid(),
  payload: z.unknown().optional(),
  replyTo: z.string().optional(),
});
const HelloPayload = z.object({}).passthrough();
const ResumePayload = z.object({
  sessionId: z.string().uuid(),
  lastSeq: z.number().int().min(0),
});
const ChatPayload = z.object({ text: z.string().min(1).max(500) });

// ---- 2. Sessions: a session outlives any single socket --------------------
/**
 * @typedef {object} Session
 * @property {string} id
 * @property {number} nextSeq          next sequence number to assign
 * @property {Array<object>} buffer    last REPLAY_LIMIT sequenced messages
 * @property {Set<string>} seen        recently processed client message ids
 * @property {import('ws').WebSocket|null} ws
 * @property {NodeJS.Timeout|null} expiry
 */
/** @type {Map<string, Session>} */
const sessions = new Map();

function createSession() {
  const s = { id: crypto.randomUUID(), nextSeq: 1, buffer: [], seen: new Set(), ws: null, expiry: null };
  sessions.set(s.id, s);
  return s;
}

function attach(session, ws) {
  if (session.ws && session.ws !== ws) session.ws.close(4409, 'session taken over');
  clearTimeout(session.expiry);
  session.expiry = null;
  session.ws = ws;
  ws.session = session;
}

function detach(ws) {
  const s = ws.session;
  if (!s || s.ws !== ws) return;
  s.ws = null;
  // Keep the session (and keep buffering!) for a while so the client can resume.
  s.expiry = setTimeout(() => sessions.delete(s.id), SESSION_TTL_MS);
  s.expiry.unref();
}

// ---- 3. Sending: raw, sequenced (replayable), and backpressure-aware -------
function envelope(type, payload, extra = {}) {
  return { type, id: crypto.randomUUID(), payload, ...extra };
}

/** Low-level send with backpressure policy. Returns true if the frame was queued. */
function safeSend(ws, msg, { volatile = false } = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  if (ws.bufferedAmount > HARD_LIMIT) {
    console.warn(`[backpressure] slow consumer ${ws.session?.id} (${ws.bufferedAmount} B) → 1013`);
    ws.close(1013, 'slow consumer');     // client reconnects and resumes from replay buffer
    return false;
  }
  if (volatile && ws.bufferedAmount > SOFT_LIMIT) return false; // drop, it's only noise
  ws.send(JSON.stringify(msg));
  return true;
}

/** Sequenced send: stamped with seq, stored for replay, delivered if connected. */
function sendToSession(session, type, payload) {
  const msg = envelope(type, payload, { seq: session.nextSeq++ });
  session.buffer.push(msg);
  if (session.buffer.length > REPLAY_LIMIT) session.buffer.shift();
  safeSend(session.ws, msg);           // if offline, it simply waits in the buffer
}

function broadcast(type, payload) {
  for (const s of sessions.values()) sendToSession(s, type, payload);
}

// ---- 4. Message handling ---------------------------------------------------
function handleMessage(ws, raw) {
  let msg;
  try {
    msg = Envelope.parse(JSON.parse(raw.toString()));
  } catch {
    return safeSend(ws, envelope('error', { message: 'invalid envelope' }));
  }

  // The first message on every socket must be hello or resume.
  if (!ws.session && msg.type !== 'session:hello' && msg.type !== 'session:resume') {
    return safeSend(ws, envelope('error', { message: 'send session:hello first' }, { replyTo: msg.id }));
  }

  switch (msg.type) {
    case 'session:hello': {
      HelloPayload.parse(msg.payload ?? {});
      const s = createSession();
      attach(s, ws);
      return safeSend(ws, envelope('session:welcome', { sessionId: s.id, seq: s.nextSeq - 1 }, { replyTo: msg.id }));
    }

    case 'session:resume': {
      const parsed = ResumePayload.safeParse(msg.payload);
      const s = parsed.success ? sessions.get(parsed.data.sessionId) : undefined;
      const lastSeq = parsed.success ? parsed.data.lastSeq : 0;
      const oldest = s?.buffer[0]?.seq ?? s?.nextSeq;
      // Can we fill the gap? We need every message from lastSeq+1 onwards.
      if (!s || lastSeq + 1 < oldest || lastSeq >= s.nextSeq) {
        const fresh = createSession();
        attach(fresh, ws);
        return safeSend(ws, envelope('session:reset',
          { sessionId: fresh.id, seq: 0, reason: s ? 'gap too old' : 'unknown or expired session' },
          { replyTo: msg.id }));
      }
      attach(s, ws);
      const missed = s.buffer.filter((m) => m.seq > lastSeq);
      safeSend(ws, envelope('session:resumed', { sessionId: s.id, replayed: missed.length }, { replyTo: msg.id }));
      for (const m of missed) safeSend(ws, m); // same id + seq as the original → client dedups
      return;
    }

    case 'chat:send': {
      const { text } = ChatPayload.parse(msg.payload);
      const s = ws.session;
      // Idempotency: a resent message (lost ack) must not be broadcast twice.
      if (!s.seen.has(msg.id)) {
        s.seen.add(msg.id);
        if (s.seen.size > SEEN_IDS_LIMIT) s.seen.delete(s.seen.values().next().value);
        broadcast('chat:message', { from: s.id.slice(0, 8), text, clientMsgId: msg.id });
      }
      // Always ack, even duplicates: the client just needs to know "server has it".
      return safeSend(ws, envelope('ack', { ok: true }, { replyTo: msg.id }));
    }

    default:
      return safeSend(ws, envelope('error', { message: `unknown type ${msg.type}` }, { replyTo: msg.id }));
  }
}

// ---- 5. HTTP + WebSocket wiring (Chapter 3 pattern) ------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Debug: simulate a network blip — abrupt kill, no close frame → client sees 1006.
app.post('/debug/kill-all', (_req, res) => {
  let n = 0;
  for (const ws of wss.clients) { ws.terminate(); n++; }
  res.json({ terminated: n });
});

// Debug: flood a volatile stream to demonstrate backpressure dropping.
let noiseTimer = null;
app.post('/debug/noise/:on', (req, res) => {
  clearInterval(noiseTimer);
  noiseTimer = null;
  if (req.params.on === 'on') {
    const blob = 'x'.repeat(16 * 1024);
    noiseTimer = setInterval(() => {
      for (const ws of wss.clients) safeSend(ws, envelope('feed:noise', { blob }), { volatile: true });
    }, 5);
  }
  res.json({ noise: Boolean(noiseTimer) });
});

app.get('/stats', (_req, res) => {
  res.json({
    sockets: wss.clients.size,
    sessions: sessions.size,
    connected: [...sessions.values()].filter((s) => s.ws).length,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
let shuttingDown = false;

server.on('upgrade', (req, socket, head) => {
  if (shuttingDown || req.url !== '/ws') {
    socket.write(`HTTP/1.1 ${shuttingDown ? '503 Service Unavailable' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Serialise handling per connection so async work can't reorder messages.
  ws.queue = Promise.resolve();
  ws.on('message', (raw) => {
    ws.isAlive = true; // any traffic proves liveness
    ws.queue = ws.queue.then(() => handleMessage(ws, raw)).catch((err) => {
      safeSend(ws, envelope('error', { message: err.message }));
    });
  });

  ws.on('close', (code) => {
    console.log(`[close] session=${ws.session?.id?.slice(0, 8) ?? '-'} code=${code}`);
    detach(ws);
  });
  ws.on('error', (err) => console.error('[ws error]', err.message));
});

// ---- 6. Heartbeats ---------------------------------------------------------
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; } // missed a full interval
    ws.isAlive = false;
    ws.ping();
    // App-level heartbeat so *browser* code can detect a dead server too.
    safeSend(ws, envelope('sys:heartbeat', { t: Date.now() }), { volatile: true });
  }
}, HEARTBEAT_MS);

// A steady sequenced stream so you can verify nothing is lost across reconnects.
let tick = 0;
const ticker = setInterval(() => broadcast('feed:tick', { n: ++tick, at: Date.now() }), 1000);

// ---- 7. Graceful shutdown --------------------------------------------------
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: closing ${wss.clients.size} client(s) with 1001`);
  clearInterval(ticker);
  clearInterval(heartbeat);
  clearInterval(noiseTimer);
  server.close(); // stop accepting new HTTP connections

  for (const ws of wss.clients) ws.close(1001, 'server restarting');

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const ws of wss.clients) ws.terminate(); // stragglers
  server.closeAllConnections?.();               // idle keep-alive HTTP sockets
  console.log('[shutdown] done');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`Chapter 5 reliability demo → http://localhost:${PORT}`));
