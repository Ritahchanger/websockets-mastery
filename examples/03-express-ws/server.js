// examples/03-express-ws/server.js
//
// Express 5 + ws on ONE http.Server and ONE port.
//   - noServer WebSocketServers + a single 'upgrade' handler that routes by path
//   - /ws/chat : authenticated by session cookie (+ Origin allow-list)
//   - /ws/feed : authenticated by a short-lived JWT, sent either as ?token=...
//                or inside Sec-WebSocket-Protocol: ["feed.v1", "auth.<jwt>"]
//   - REST endpoints share state with the sockets (POST /api/broadcast pushes to chat)
//
// Run: npm run ex:03   then open http://localhost:3000

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`).split(','),
);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. A toy session store: sid -> { name }. (Use Redis / express-session in real apps.)
// ---------------------------------------------------------------------------
const sessions = new Map();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns the session user for an HTTP request (works for normal AND upgrade requests,
// since both are http.IncomingMessage with the same headers).
function getSessionUser(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  return sid ? sessions.get(sid) ?? null : null;
}

// ---------------------------------------------------------------------------
// 2. Express app: static files + REST API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware: require a session for a REST route.
function requireSession(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  req.user = user;
  next();
}

app.post('/api/login', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: 'name required' });
  const sid = crypto.randomBytes(18).toString('base64url');
  sessions.set(sid, { name });
  // HttpOnly: JS can't read it. SameSite=Lax: not sent on cross-site subrequests.
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.json({ name });
});

app.post('/api/logout', requireSession, (req, res) => {
  const { sid } = parseCookies(req.headers.cookie);
  sessions.delete(sid);
  // Kick this session's open sockets — auth state changed.
  for (const ws of wssChat.clients) if (ws.sid === sid) ws.close(4001, 'logged out');
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireSession, (req, res) => res.json({ name: req.user.name }));

// Short-lived "ticket" for the feed socket. The cookie never leaves HTTP-land.
app.get('/api/token', requireSession, (req, res) => {
  const token = jwt.sign({ sub: req.user.name, scope: 'feed' }, JWT_SECRET, { expiresIn: '60s' });
  res.json({ token });
});

app.get('/api/online', (req, res) => {
  res.json({ chat: [...wssChat.clients].map((ws) => ws.user.name), feed: wssFeed.clients.size });
});

// REST -> WebSocket: anyone logged in can push an announcement to all chat sockets.
app.post('/api/broadcast', requireSession, (req, res) => {
  const text = String(req.body?.text ?? '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });
  const delivered = broadcast(wssChat, { kind: 'announcement', from: req.user.name, text });
  res.json({ delivered });
});

// ---------------------------------------------------------------------------
// 3. WebSocket servers — noServer: we decide when/if to accept.
// ---------------------------------------------------------------------------
const wssChat = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

const wssFeed = new WebSocketServer({
  noServer: true,
  maxPayload: 1024, // clients barely send anything on this endpoint
  // If the client offered protocols, pick "feed.v1". NEVER echo back the auth.* entry.
  handleProtocols: (protocols) => (protocols.has('feed.v1') ? 'feed.v1' : false),
});

// Send one JSON message to every OPEN client of a given WebSocketServer.
function broadcast(wss, message) {
  const data = JSON.stringify(message);
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      n++;
    }
  }
  return n;
}

// Authenticators: (req, url) -> user | null. They may be async.
function authChat(req) {
  const user = getSessionUser(req);
  return user ? { ...user, sid: parseCookies(req.headers.cookie).sid } : null;
}

function authFeed(req, url) {
  // Token either in ?token=... or in the subprotocol list as "auth.<jwt>".
  let token = url.searchParams.get('token');
  if (!token) {
    const offered = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    token = offered.find((p) => p.startsWith('auth.'))?.slice(5);
  }
  if (!token) return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    return claims.scope === 'feed' ? { name: claims.sub } : null;
  } catch {
    return null; // expired, bad signature, malformed...
  }
}

const routes = {
  '/ws/chat': { wss: wssChat, auth: authChat, checkOrigin: true },
  '/ws/feed': { wss: wssFeed, auth: authFeed, checkOrigin: false }, // token auth => no cookie => no CSWSH
};

// ---------------------------------------------------------------------------
// 4. ONE http.Server shared by Express ('request') and our upgrade router ('upgrade').
// ---------------------------------------------------------------------------
const server = http.createServer(app);

function onSocketError(err) {
  console.error('[upgrade] socket error before handshake:', err.message);
}

// Reject an upgrade: no `res` exists, so write a raw HTTP response and destroy.
function reject(socket, status, message) {
  const body = JSON.stringify({ error: message });
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  socket.on('error', onSocketError);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[url.pathname];
  if (!route) return reject(socket, 404, 'unknown websocket endpoint');

  // Cookie-authenticated endpoints MUST verify Origin (Cross-Site WebSocket Hijacking).
  if (route.checkOrigin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
    console.warn(`[upgrade] rejected origin ${req.headers.origin} for ${url.pathname}`);
    return reject(socket, 403, 'origin not allowed');
  }

  const user = await route.auth(req, url);
  if (!user) {
    console.warn(`[upgrade] 401 for ${url.pathname}`);
    return reject(socket, 401, 'unauthorized');
  }

  // Client might have hung up while we were authenticating.
  if (socket.destroyed) return;

  route.wss.handleUpgrade(req, socket, head, (ws) => {
    socket.removeListener('error', onSocketError); // ws handles errors from here on
    // Extra args after `req` are passed to the 'connection' listeners.
    route.wss.emit('connection', ws, req, user);
  });
});

// ---------------------------------------------------------------------------
// 5. Connection handlers — note the third parameter: the authenticated user.
// ---------------------------------------------------------------------------
wssChat.on('connection', (ws, req, user) => {
  ws.user = user;       // per-socket state (removed automatically with the socket)
  ws.sid = user.sid;    // lets /api/logout find this user's sockets
  console.log(`[chat] + ${user.name} (${wssChat.clients.size} online) ua="${req.headers['user-agent']}"`);

  ws.send(JSON.stringify({ kind: 'welcome', you: user.name }));
  broadcast(wssChat, { kind: 'presence', online: [...wssChat.clients].map((c) => c.user.name) });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return ws.close(1003, 'text only'); // 1003 = unsupported data
    const text = data.toString().trim().slice(0, 1000);
    if (text) broadcast(wssChat, { kind: 'chat', from: user.name, text, at: Date.now() });
  });

  ws.on('close', (code) => {
    console.log(`[chat] - ${user.name} (${code})`);
    broadcast(wssChat, { kind: 'presence', online: [...wssChat.clients].map((c) => c.user.name) });
  });
  ws.on('error', (err) => console.error('[chat] error', err.message));
});

wssFeed.on('connection', (ws, req, user) => {
  console.log(`[feed] + ${user.name} protocol="${ws.protocol}"`);
  ws.send(JSON.stringify({ kind: 'hello', you: user.name, protocol: ws.protocol }));
  ws.on('error', (err) => console.error('[feed] error', err.message));
});

// One timer for the whole feed (not one per socket!) pushes a tick every second.
const tick = setInterval(() => {
  if (wssFeed.clients.size === 0) return;
  broadcast(wssFeed, {
    kind: 'tick',
    time: new Date().toISOString(),
    chatOnline: wssChat.clients.size,
    memoryMB: Math.round(process.memoryUsage().rss / 1e6),
  });
}, 1000);

server.listen(PORT, () => {
  console.log(`Express + ws on http://localhost:${PORT}`);
  console.log('  WS endpoints: /ws/chat (cookie)  /ws/feed (JWT)');
});

process.on('SIGINT', () => {
  clearInterval(tick);
  for (const wss of [wssChat, wssFeed]) for (const ws of wss.clients) ws.close(1001, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
