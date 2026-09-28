// examples/09-testing/rooms.test.js — multi-client scenarios: fan-out and isolation.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect, request, nextMessage, expectSilence, eventually } from './helpers.js';

let srv, clients;
beforeEach(async () => {
  srv = await startServer();        // a FRESH server per test: no shared room state
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.close();
  await srv.close();
});
const client = async () => { const c = await connect(srv.wsUrl); clients.push(c); return c; };

test('a message reaches every member of the room, including the sender', async () => {
  const [alice, bob] = await Promise.all([client(), client()]);
  await request(alice, 'room:join', { room: 'general' });
  const joined = await request(bob, 'room:join', { room: 'general' });
  assert.equal(joined.payload.members, 2);

  const bobGets = nextMessage(bob, (m) => m.type === 'chat:message');   // subscribe FIRST
  const ack = await request(alice, 'chat:message', { room: 'general', text: 'hi bob' });
  assert.equal(ack.type, 'ack');
  assert.equal(ack.payload.delivered, 2);

  const msg = await bobGets;
  assert.deepEqual(msg.payload, { room: 'general', text: 'hi bob', from: alice.clientId });
  // the sender gets its own copy too (echo)
  const echo = await nextMessage(alice, (m) => m.type === 'chat:message');
  assert.equal(echo.payload.text, 'hi bob');
});

test('clients in other rooms do not receive the message', async () => {
  const [alice, carol] = await Promise.all([client(), client()]);
  await request(alice, 'room:join', { room: 'general' });
  await request(carol, 'room:join', { room: 'random' });
  await request(alice, 'chat:message', { room: 'general', text: 'secret' });
  await expectSilence(carol, (m) => m.type === 'chat:message', 100);
});

test('you cannot post to a room you have not joined', async () => {
  const mallory = await client();
  const err = await request(mallory, 'chat:message', { room: 'general', text: 'x' });
  assert.equal(err.payload.code, 'NOT_IN_ROOM');
});

test('rooms are cleaned up when the last member disconnects', async () => {
  const a = await client();
  await request(a, 'room:join', { room: 'tmp' });
  assert.ok(srv.rooms.has('tmp'));
  a.close();
  // The server's 'close' handler runs asynchronously after the client's close —
  // never assert immediately; poll until the state converges.
  await eventually(() => !srv.rooms.has('tmp'));
});

test('fan-out works at a (small) scale: 50 clients', async () => {
  const many = await Promise.all(Array.from({ length: 50 }, client));
  await Promise.all(many.map((c) => request(c, 'room:join', { room: 'big' })));
  const all = Promise.all(many.map((c) => nextMessage(c, (m) => m.type === 'chat:message')));
  await request(many[0], 'chat:message', { room: 'big', text: 'hello everyone' });
  const got = await all;
  assert.equal(got.length, 50);
  assert.ok(got.every((m) => m.payload.text === 'hello everyone'));
});
