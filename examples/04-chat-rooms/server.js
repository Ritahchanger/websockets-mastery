// examples/04-chat-rooms/server.js
//
// Multi-room chat: Express (static + tiny REST) + ws, with
//   - an envelope protocol {type, id, payload, replyTo} validated by zod
//   - a handler map + one dispatch() function (WebSocket "router")
//   - request/response (every request with an id gets an ok/error reply)
//   - rooms, presence, typing indicators, broadcast-excluding-sender
//
// Run: npm run ex:04   then open http://localhost:3000 in a few tabs

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Envelope, schemas, AppError, formatIssues, event, reply, errorMessage } from './protocol.js';
import { RoomManager } from './rooms.js';

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_ROOMS_PER_CLIENT = 10;
const TYPING_TTL_MS = 5000; // server-side expiry if the client never sends typing:false

const rooms = new RoomManager(['general', 'random', 'help']);
const clients = new Set(); // all connected client objects
const nicks = new Map(); // lower-cased nick -> client (uniqueness)

// ---------------------------------------------------------------------------
// Express: static client + a REST view of the same state
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/rooms', (req, res) => res.json({ rooms: rooms.list(), online: clients.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function requireMember(client, room) {
  if (!rooms.isMember(room, client)) throw new AppError('NOT_IN_ROOM', `you are not in #${room}`);
}

function claimNick(client, nick) {
  const key = nick.toLowerCase();
  const owner = nicks.get(key);
  if (owner && owner !== client) throw new AppError('NICK_TAKEN', `"${nick}" is already taken`);
  if (client.nick) nicks.delete(client.nick.toLowerCase());
  nicks.set(key, client);
  client.nick = nick;
}

function publicUser(client) {
  return { id: client.id, nick: client.nick };
}

function sendPresence(room, change) {
  rooms.broadcast(room, event('presence:update', { room, members: rooms.members(room), change }));
}

// Coalesce room-list broadcasts: many joins/leaves in a burst -> one message.
let roomListTimer = null;
function scheduleRoomListBroadcast() {
  if (roomListTimer) return;
  roomListTimer = setTimeout(() => {
    roomListTimer = null;
    const data = JSON.stringify(event('room:list', { rooms: rooms.list() }));
    for (const c of clients) if (c.nick && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }, 150);
}

// Typing state: client.typing is Map<room, Timeout>. Broadcast only on transitions.
function setTyping(client, room, typing) {
  const timer = client.typing.get(room);
  if (typing) {
    if (timer) clearTimeout(timer); // already typing: just refresh the expiry
    else rooms.broadcast(room, event('chat:typing', { room, user: publicUser(client), typing: true }), { except: client });
    client.typing.set(room, setTimeout(() => setTyping(client, room, false), TYPING_TTL_MS));
  } else if (timer) {
    clearTimeout(timer);
    client.typing.delete(room);
    rooms.broadcast(room, event('chat:typing', { room, user: publicUser(client), typing: false }), { except: client });
  }
}

function leaveRoom(client, room) {
  setTyping(client, room, false);
  rooms.leave(room, client);
  sendPresence(room, { kind: 'leave', user: publicUser(client) });
  scheduleRoomListBroadcast();
}

// ---------------------------------------------------------------------------
// Handlers: (client, validatedPayload) => replyPayload | undefined
// Throw AppError for expected failures.
// ---------------------------------------------------------------------------
const handlers = {
  'session:hello'(client, { nick }) {
    claimNick(client, nick);
    return { userId: client.id, nick: client.nick, rooms: rooms.list() };
  },

  'user:nick'(client, { nick }) {
    const old = client.nick;
    claimNick(client, nick);
    for (const room of client.rooms) {
      sendPresence(room, { kind: 'rename', user: publicUser(client), from: old });
    }
    return { nick: client.nick };
  },

  'room:list'() {
    return { rooms: rooms.list() };
  },

  'room:join'(client, { room }) {
    if (!rooms.isMember(room, client)) {
      if (client.rooms.size >= MAX_ROOMS_PER_CLIENT) {
        throw new AppError('TOO_MANY_ROOMS', `you can join at most ${MAX_ROOMS_PER_CLIENT} rooms`);
      }
      rooms.join(room, client);
      sendPresence(room, { kind: 'join', user: publicUser(client) });
      scheduleRoomListBroadcast();
    }
    // Idempotent: joining twice just returns the snapshot again (safe to retry after a timeout).
    return { room, members: rooms.members(room), history: rooms.history(room) };
  },

  'room:leave'(client, { room }) {
    requireMember(client, room);
    leaveRoom(client, room);
    return { room };
  },

  'chat:message'(client, { room, text }) {
    requireMember(client, room);
    setTyping(client, room, false); // sending a message ends "typing"
    const message = { msgId: crypto.randomUUID(), room, from: publicUser(client), text, at: Date.now() };
    rooms.addToHistory(room, message);
    // Everyone else gets a push; the sender gets the same object as the reply (its "ack").
    rooms.broadcast(room, event('chat:message', message), { except: client });
    return message;
  },

  'chat:typing'(client, { room, typing }) {
    if (!rooms.isMember(room, client)) return; // ephemeral: silently ignore
    setTyping(client, room, typing);
  },
};

// ---------------------------------------------------------------------------
// The dispatcher: bytes -> envelope -> handler -> reply
// ---------------------------------------------------------------------------
async function dispatch(client, data, isBinary) {
  if (isBinary) return client.send(errorMessage(null, 'BAD_MESSAGE', 'binary frames are not supported'));

  let msg;
  try {
    msg = Envelope.parse(JSON.parse(data.toString()));
  } catch {
    return client.send(errorMessage(null, 'BAD_MESSAGE', 'expected a JSON envelope {type, id?, payload?}'));
  }

  const { type, id } = msg;
  const handler = Object.hasOwn(handlers, type) ? handlers[type] : null; // no prototype keys!
  if (!handler) return client.send(errorMessage(id, 'UNKNOWN_TYPE', `unknown message type "${type}"`));

  if (type !== 'session:hello' && !client.nick) {
    return client.send(errorMessage(id, 'NOT_IDENTIFIED', 'send session:hello first'));
  }

  const parsed = schemas[type].safeParse(msg.payload ?? {});
  if (!parsed.success) return client.send(errorMessage(id, 'VALIDATION', formatIssues(parsed.error)));

  try {
    const result = await handler(client, parsed.data);
    if (id) client.send(reply(id, result ?? null)); // every request with an id gets an answer
  } catch (err) {
    if (!err.expose) console.error(`[handler ${type}]`, err); // unexpected: log, don't leak
    client.send(errorMessage(id, err.expose ? err.code : 'INTERNAL', err.expose ? err.message : 'internal error'));
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  const client = {
    id: crypto.randomUUID(),
    nick: null,           // set by session:hello
    ws,
    rooms: new Set(),     // reverse index: rooms this client is in
    typing: new Map(),    // room -> expiry timer
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
  };
  clients.add(client);

  ws.on('message', (data, isBinary) => {
    dispatch(client, data, isBinary).catch((err) => console.error('[dispatch]', err));
  });

  ws.on('close', () => {
    // Undo EVERYTHING this client added: rooms, typing timers, nick, client set.
    for (const room of [...client.rooms]) leaveRoom(client, room);
    if (client.nick && nicks.get(client.nick.toLowerCase()) === client) nicks.delete(client.nick.toLowerCase());
    clients.delete(client);
    console.log(`[-] ${client.nick ?? client.id} (${clients.size} online)`);
  });

  ws.on('error', (err) => console.error('[ws error]', err.message));
});

server.listen(PORT, () => console.log(`Chat rooms on http://localhost:${PORT}`));

process.on('SIGINT', () => {
  for (const c of clients) c.ws.close(1001, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
