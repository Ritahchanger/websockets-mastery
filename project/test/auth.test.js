import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TicketStore } from '../src/auth.js';
import { createHuddleServer } from '../src/server.js';

test('tickets are one-time', () => {
  const store = new TicketStore({ ttlMs: 1000 });
  const { ticket } = store.issue({ id: 'u1', name: 'ada' });
  assert.equal(store.consume(ticket).name, 'ada');
  assert.equal(store.consume(ticket), null);
  store.close();
});

test('tickets expire', async () => {
  const store = new TicketStore({ ttlMs: 20 });
  const { ticket } = store.issue({ id: 'u1', name: 'ada' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store.consume(ticket), null);
  store.close();
});

test('unknown / non-string tickets are rejected', () => {
  const store = new TicketStore();
  assert.equal(store.consume('nope'), null);
  assert.equal(store.consume(undefined), null);
  assert.equal(store.consume({}), null);
  store.close();
});

let huddle;
let base;
before(async () => {
  huddle = await createHuddleServer({ media: { enabled: false } });
  const { port } = await huddle.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});
after(() => huddle.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('POST /api/login validates the nickname', async () => {
  assert.equal((await post('/api/login', { nickname: 'a' })).status, 400);
  assert.equal((await post('/api/login', { nickname: '<script>' })).status, 400);
  const res = await post('/api/login', { nickname: 'grace' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.name, 'grace');
  assert.match(body.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
});

test('POST /api/ticket requires a valid JWT', async () => {
  assert.equal((await post('/api/ticket', {})).status, 401);
  assert.equal((await post('/api/ticket', {}, { authorization: 'Bearer forged.jwt.here' })).status, 401);
  const { token } = await (await post('/api/login', { nickname: 'grace' })).json();
  const res = await post('/api/ticket', {}, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  const { ticket, expiresIn } = await res.json();
  assert.ok(ticket.length >= 24);
  assert.ok(expiresIn > 0);
});

test('GET /metrics responds with JSON and Prometheus text', async () => {
  const json = await (await fetch(`${base}/metrics`)).json();
  assert.equal(typeof json.connections, 'number');
  assert.equal(json.media.available, false);
  const text = await (await fetch(`${base}/metrics?format=prometheus`)).text();
  assert.match(text, /huddle_ws_connections \d+/);
});
