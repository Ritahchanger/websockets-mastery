// examples/09-testing/app.js
// A small, *testable* WebSocket app: Express 5 + ws (noServer) + the course envelope.
// The key design choice: this module does NOT listen on a port by itself.
// It exports a factory so tests can create many isolated instances on port 0.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

// ---- Protocol (same envelope as chapter 4) --------------------------------
const Envelope = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(64),
  payload: z.unknown().optional(),
  replyTo: z.string().optional(),
});
const JoinPayload = z.object({ room: z.string().min(1).max(32) });
const ChatPayload = z.object({ room: z.string().min(1).max(32), text: z.string().min(1).max(2000) });

// ---- Metrics: a tiny Prometheus-style registry -----------------------------
export function createMetrics() {
  const m = {
    connections: 0,          // gauge   (goes up and down)
    connectionsTotal: 0,     // counter (only goes up)
    messagesIn: 0,           // counter
    messagesOut: 0,          // counter
    errors: 0,               // counter (protocol errors sent to clients)
    terminated: 0,           // counter (heartbeat kills)
  };
  m.render = () => [
    '# HELP ws_connections Currently open WebSocket connections',
    '# TYPE ws_connections gauge',
    `ws_connections ${m.connections}`,
    '# HELP ws_connections_total WebSocket connections accepted since start',
    '# TYPE ws_connections_total counter',
    `ws_connections_total ${m.connectionsTotal}`,
    '# TYPE ws_messages_received_total counter',
    `ws_messages_received_total ${m.messagesIn}`,
    '# TYPE ws_messages_sent_total counter',
    `ws_messages_sent_total ${m.messagesOut}`,
    '# TYPE ws_protocol_errors_total counter',
    `ws_protocol_errors_total ${m.errors}`,
    '# TYPE ws_heartbeat_terminations_total counter',
    `ws_heartbeat_terminations_total ${m.terminated}`,
    '',
  ].join('\n');
  return m;
}

/**
 * Build (but do not start) the app.
 * @param {object} [opts]
 * @param {number} [opts.heartbeatMs=30000] ping interval; tests pass something tiny
 * @param {number} [opts.maxPayload=64*1024] bytes
 * @param {(msg:string, meta?:object)=>void} [opts.log] injectable logger (silent in tests)
 */
export function createApp({ heartbeatMs = 30_000, maxPayload = 64 * 1024, log = () => {} } = {}) {
  const metrics = createMetrics();
  const app = express();
  app.get('/healthz', (_req, res) => res.json({ ok: true, connections: metrics.connections }));
  app.get('/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(metrics.render()));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  /** @type {Map<string, Set<WebSocket>>} */
  const rooms = new Map();

  // --- Upgrade routing: only /ws is a WebSocket endpoint ---
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') {
      // Answer with a real HTTP response so clients see "Unexpected server response: 404"
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, msg) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
    metrics.messagesOut++;
  };
  const reply = (ws, req, type, payload) => send(ws, { type, id: randomUUID(), replyTo: req.id, payload });
  const error = (ws, code, message, replyTo) => {
    metrics.errors++;
    send(ws, { type: 'error', id: randomUUID(), ...(replyTo && { replyTo }), payload: { code, message } });
  };

  wss.on('connection', (ws, req) => {
    ws.id = randomUUID();
    ws.rooms = new Set();
    ws.isAlive = true;
    metrics.connections++;
    metrics.connectionsTotal++;
    log('connect', { id: ws.id, ip: req.socket.remoteAddress });

    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, { type: 'hello', id: randomUUID(), payload: { clientId: ws.id } });

    ws.on('message', (data, isBinary) => {
      metrics.messagesIn++;
      if (isBinary) return error(ws, 'BINARY_UNSUPPORTED', 'send JSON text frames');
      let raw;
      try { raw = JSON.parse(data.toString()); } catch { return error(ws, 'BAD_JSON', 'invalid JSON'); }
      const env = Envelope.safeParse(raw);
      if (!env.success) return error(ws, 'BAD_ENVELOPE', env.error.issues[0].message);
      const msg = env.data;

      switch (msg.type) {
        case 'ping':
          return reply(ws, msg, 'pong', { t: Date.now() });
        case 'room:join': {
          const p = JoinPayload.safeParse(msg.payload);
          if (!p.success) return error(ws, 'BAD_PAYLOAD', p.error.issues[0].message, msg.id);
          const { room } = p.data;
          if (!rooms.has(room)) rooms.set(room, new Set());
          rooms.get(room).add(ws);
          ws.rooms.add(room);
          return reply(ws, msg, 'room:joined', { room, members: rooms.get(room).size });
        }
        case 'chat:message': {
          const p = ChatPayload.safeParse(msg.payload);
          if (!p.success) return error(ws, 'BAD_PAYLOAD', p.error.issues[0].message, msg.id);
          const { room, text } = p.data;
          if (!ws.rooms.has(room)) return error(ws, 'NOT_IN_ROOM', `join ${room} first`, msg.id);
          const out = { type: 'chat:message', id: randomUUID(), payload: { room, text, from: ws.id } };
          for (const peer of rooms.get(room)) send(peer, out);
          return reply(ws, msg, 'ack', { delivered: rooms.get(room).size });
        }
        default:
          return error(ws, 'UNKNOWN_TYPE', `unknown type ${msg.type}`, msg.id);
      }
    });

    ws.on('close', (code) => {
      metrics.connections--;
      for (const room of ws.rooms) {
        const set = rooms.get(room);
        set?.delete(ws);
        if (set?.size === 0) rooms.delete(room);
      }
      log('close', { id: ws.id, code });
    });
    ws.on('error', (err) => log('ws error', { id: ws.id, err: err.message }));
  });

  // --- Heartbeat sweep (chapter 5) ---
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { metrics.terminated++; ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  sweep.unref(); // never keep the process (or the test runner) alive on its own

  /** Start listening. Pass port 0 to get a random free port (what tests do). */
  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const { port: p } = server.address();
        resolve({ port: p, httpUrl: `http://${host}:${p}`, wsUrl: `ws://${host}:${p}/ws` });
      });
    });
  }

  /** Stop everything: sweep timer, every socket, the WSS, the HTTP server. */
  async function close() {
    clearInterval(sweep);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(() => r()));
    server.closeAllConnections?.(); // drop idle keep-alive HTTP sockets (fetch in tests)
    await new Promise((r) => server.close(() => r()));
  }

  return { app, server, wss, rooms, metrics, listen, close };
}
