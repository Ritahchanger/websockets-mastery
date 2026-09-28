// examples/09-testing/socketio.test.js — testing a Socket.IO server with socket.io-client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

let httpServer, io, url;

before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  // middleware auth: reject handshakes without the right token
  io.use((socket, next) => {
    if (socket.handshake.auth?.token === 'good') return next();
    next(new Error('unauthorized'));
  });
  io.on('connection', (socket) => {
    socket.on('sum', (nums, ack) => ack(nums.reduce((a, b) => a + b, 0)));
    socket.on('join', (room, ack) => { socket.join(room); ack('ok'); });
    socket.on('say', ({ room, text }) => socket.to(room).emit('said', { text }));
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  await io.close(); // also closes httpServer
});

/** Connect with websocket-only transport (skips long-polling → faster, deterministic). */
function client(token = 'good') {
  const s = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err) => { s.close(); reject(err); });
  });
}

test('middleware rejects a bad token with connect_error', async () => {
  await assert.rejects(client('bad'), { message: 'unauthorized' });
});

test('acknowledgements work like RPC (emitWithAck)', async (t) => {
  const s = await client();
  t.after(() => s.close());
  const total = await s.timeout(1000).emitWithAck('sum', [1, 2, 3]);
  assert.equal(total, 6);
});

test('room broadcast excludes the sender and non-members', async (t) => {
  const [a, b, c] = await Promise.all([client(), client(), client()]);
  t.after(() => { a.close(); b.close(); c.close(); });
  await a.emitWithAck('join', 'r1');
  await b.emitWithAck('join', 'r1');

  const got = new Promise((r) => b.once('said', r));
  let leaked = false;
  a.on('said', () => { leaked = true; });
  c.on('said', () => { leaked = true; });

  a.emit('say', { room: 'r1', text: 'yo' });
  assert.deepEqual(await got, { text: 'yo' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(leaked, false);
});
