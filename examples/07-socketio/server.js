// Chapter 7 — Socket.IO on Express 5
// Demonstrates: events, acknowledgements, rooms, namespaces, middleware auth,
// broadcasting, volatile emits, and connection state recovery.
//
// Run:  npm run ex:07   then open http://localhost:3000 in two tabs.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'let-me-in'; // demo only

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, clients: io.engine.clientsCount }));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// The Socket.IO server attaches to the same http.Server as Express.
// It serves its own client bundle at /socket.io/socket.io.esm.min.js
// (serveClient: true is the default).
// ---------------------------------------------------------------------------
const io = new Server(server, {
  // Only allow the page we serve. Socket.IO's HTTP long-polling transport IS
  // subject to CORS (unlike a raw WebSocket upgrade), so this option matters.
  cors: { origin: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`] },
  maxHttpBufferSize: 64 * 1024, // like ws maxPayload: reject messages > 64 KiB
  pingInterval: 25_000,         // Engine.IO heartbeat (built in — no manual sweep)
  pingTimeout: 20_000,
  // Connection state recovery: after a short disconnect the client gets its
  // old socket.id, its rooms, and the packets it missed (server-side buffer).
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true, // a recovered session skips auth middleware again
  },
});

// ---------------------------------------------------------------------------
// Validation schemas (same spirit as the ch.4 envelope, but Socket.IO already
// gives us "type" (event name) and "replyTo" (acks), so we only validate payloads)
// ---------------------------------------------------------------------------
const Name = z.string().trim().min(1).max(32).regex(/^[\w\- ]+$/);
const Room = z.string().trim().min(1).max(32).regex(/^[a-z0-9\-]+$/);
const ChatMessage = z.object({ room: Room, text: z.string().trim().min(1).max(500) });

// ---------------------------------------------------------------------------
// Namespace middleware — runs once per connection, before "connection".
// Calling next(err) rejects the connection; the client receives a
// "connect_error" event with err.message and err.data.
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const parsed = Name.safeParse(socket.handshake.auth?.name);
  if (!parsed.success) {
    const err = new Error('unauthorized');
    err.data = { reason: 'handshake.auth.name must be 1–32 word characters' };
    return next(err);
  }
  socket.data.name = parsed.data; // socket.data is per-socket storage (and survives recovery)
  next();
});

io.on('connection', (socket) => {
  if (socket.recovered) {
    // Rooms, socket.id and socket.data were restored; missed events are replayed.
    console.log(`[recovered] ${socket.data.name} (${socket.id}) rooms=`, [...socket.rooms]);
  } else {
    console.log(`[connect] ${socket.data.name} (${socket.id}) via ${socket.conn.transport.name}`);
  }

  // Engine.IO starts on HTTP long-polling and upgrades to WebSocket.
  socket.conn.once('upgrade', () => {
    console.log(`[upgrade] ${socket.data.name} -> ${socket.conn.transport.name}`);
  });

  // --- Request/response with an acknowledgement callback -------------------
  socket.on('room:join', async (rawRoom, ack) => {
    if (typeof ack !== 'function') return; // defensive: clients must pass an ack
    const room = Room.safeParse(rawRoom);
    if (!room.success) return ack({ ok: false, error: 'invalid room name' });

    // Leave all previous chat rooms (every socket is also in a room named by its id)
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
    socket.join(room.data);

    const members = (await io.in(room.data).fetchSockets()).map((s) => s.data.name);
    // Broadcast to everyone in the room EXCEPT the sender
    socket.to(room.data).emit('room:presence', { room: room.data, event: 'joined', name: socket.data.name });
    ack({ ok: true, room: room.data, members });
  });

  // --- Chat message: validate, broadcast to room INCLUDING the sender -------
  socket.on('chat:message', (raw, ack) => {
    const msg = ChatMessage.safeParse(raw);
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!msg.success) return reply({ ok: false, error: 'invalid message' });
    if (!socket.rooms.has(msg.data.room)) return reply({ ok: false, error: 'not in room' });

    const out = { id: crypto.randomUUID(), room: msg.data.room, from: socket.data.name, text: msg.data.text, ts: Date.now() };
    io.to(msg.data.room).emit('chat:message', out);
    reply({ ok: true, id: out.id });
  });

  // --- Typing indicator: volatile = OK to drop if the client isn't ready ----
  socket.on('chat:typing', (rawRoom) => {
    const room = Room.safeParse(rawRoom);
    if (!room.success || !socket.rooms.has(room.data)) return;
    socket.volatile.to(room.data).emit('chat:typing', { name: socket.data.name });
  });

  // --- Server-initiated request with an ack and a timeout --------------------
  socket.on('ping:server', async (ack) => {
    try {
      // Ask the client something and wait (max 2 s) for its ack.
      const clientTime = await socket.timeout(2000).emitWithAck('whattime');
      if (typeof ack === 'function') ack({ serverTime: Date.now(), clientTime });
    } catch {
      if (typeof ack === 'function') ack({ error: 'client did not answer in time' });
    }
  });

  // "disconnecting" fires while socket.rooms is still populated.
  socket.on('disconnecting', (reason) => {
    for (const r of socket.rooms) {
      if (r !== socket.id) socket.to(r).emit('room:presence', { room: r, event: 'left', name: socket.data.name });
    }
    console.log(`[disconnect] ${socket.data.name}: ${reason}`);
  });
});

// ---------------------------------------------------------------------------
// A second namespace: /admin — separate middleware, separate event space,
// multiplexed over the SAME underlying connection as "/".
// ---------------------------------------------------------------------------
const admin = io.of('/admin');
admin.use((socket, next) => {
  if (socket.handshake.auth?.token === ADMIN_TOKEN) return next();
  next(new Error('forbidden'));
});
admin.on('connection', (socket) => {
  socket.on('stats', (ack) => {
    const rooms = {};
    // io.of('/').adapter.rooms: Map<room, Set<socketId>> (includes private id-rooms)
    for (const [room, ids] of io.of('/').adapter.rooms) {
      if (!ids.has(room)) rooms[room] = ids.size; // skip each socket's own id-room
    }
    ack({ clients: io.engine.clientsCount, rooms });
  });
  socket.on('announce', (text) => {
    if (typeof text === 'string' && text.length <= 200) io.of('/').emit('system', { text });
  });
});

// Every 10 s broadcast server time to everyone on "/" as volatile — a missed
// tick doesn't matter, so don't buffer it for disconnected/slow clients.
const ticker = setInterval(() => io.volatile.emit('tick', Date.now()), 10_000);

server.listen(PORT, () => console.log(`Socket.IO demo on http://localhost:${PORT}`));

// Graceful shutdown: io.close() disconnects all sockets and closes the http server.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(ticker);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
