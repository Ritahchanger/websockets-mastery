// Chapter 10 — WebRTC P2P signaling server.
//
// The server NEVER touches media. It only relays three kinds of opaque blobs
// between peers of the same room: SDP descriptions, ICE candidates, and
// presence (joined / left). Media flows browser <-> browser over UDP.
//
// Envelope (same as ch.4): { type, id, payload, replyTo? }
//   client -> server  room:join  { room, name }            (request, gets a reply)
//   server -> client  room:joined{ selfId, peers:[{id,name}] }  (replyTo = join id)
//   server -> others  peer:joined{ id, name }
//   client -> server  signal     { to, data }               data = {description} | {candidate}
//   server -> client  signal     { from, data }
//   server -> others  peer:left  { id }
//   server -> client  error      { code, message }

import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS ?? 4); // mesh ceiling, see chapter text

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ICE servers are served by the backend so you can rotate TURN credentials
// without redeploying the client. In production, mint short-lived TURN
// credentials here (coturn `use-auth-secret`, see docs/10 and docs/12).
app.get('/config', (_req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers, maxPeers: MAX_PEERS_PER_ROOM });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // SDP is a few KB

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/** @type {Map<string, Map<string, {ws: import('ws').WebSocket, name: string}>>} */
const rooms = new Map();

const send = (ws, type, payload, replyTo) => {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, id: randomUUID(), payload, ...(replyTo && { replyTo }) }));
};

wss.on('connection', (ws) => {
  const peerId = randomUUID();
  let roomName = null;

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, 'error', { code: 'bad_json', message: 'Invalid JSON' });
    }
    const { type, id, payload = {} } = msg;

    switch (type) {
      case 'room:join': {
        if (roomName) return send(ws, 'error', { code: 'already_joined', message: roomName }, id);
        const name = String(payload.room ?? '').slice(0, 64);
        if (!name) return send(ws, 'error', { code: 'bad_room', message: 'room required' }, id);
        const room = rooms.get(name) ?? new Map();
        if (room.size >= MAX_PEERS_PER_ROOM) {
          return send(ws, 'error', { code: 'room_full', message: `mesh limit ${MAX_PEERS_PER_ROOM}` }, id);
        }
        const displayName = String(payload.name ?? 'anon').slice(0, 32);
        const peers = [...room].map(([pid, p]) => ({ id: pid, name: p.name }));
        room.set(peerId, { ws, name: displayName });
        rooms.set(name, room);
        roomName = name;
        send(ws, 'room:joined', { selfId: peerId, peers }, id);
        for (const [pid, p] of room) if (pid !== peerId) send(p.ws, 'peer:joined', { id: peerId, name: displayName });
        break;
      }

      case 'signal': {
        // Pure relay. We validate the *routing* (same room), not the SDP itself.
        const target = roomName && rooms.get(roomName)?.get(payload.to);
        if (!target) return send(ws, 'error', { code: 'unknown_peer', message: String(payload.to) }, id);
        send(target.ws, 'signal', { from: peerId, data: payload.data });
        break;
      }

      default:
        send(ws, 'error', { code: 'unknown_type', message: String(type) }, id);
    }
  });

  ws.on('close', () => {
    if (!roomName) return;
    const room = rooms.get(roomName);
    room?.delete(peerId);
    if (room?.size === 0) rooms.delete(roomName);
    else for (const p of room?.values() ?? []) send(p.ws, 'peer:left', { id: peerId });
  });
});

// Heartbeat (ch.5): drop half-open sockets so "peer:left" fires promptly.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[ex10] signaling on http://localhost:${server.address().port}  (ws path /ws)`);
});
