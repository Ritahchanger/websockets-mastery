// End-to-end over real sockets: HTTP login -> ticket -> WebSocket -> chat.
// Media is disabled so this runs anywhere; see media.test.js for mediasoup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createHuddleServer } from '../src/server.js';
import { HuddleSocket } from '../public/src/ws-client.js';

let huddle;
let base;
let wsBase;

before(async () => {
  huddle = await createHuddleServer({ media: { enabled: false }, ws: { heartbeatMs: 60_000, rateBurst: 20, ratePerSec: 5 } });
  const { port } = await huddle.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});
after(() => huddle.close());

async function loginAs(nickname) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }) });
  return res.json();
}

async function ticketFor(token) {
  const res = await fetch(`${base}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return (await res.json()).ticket;
}

/** Minimal raw client: collects frames, offers request() and waitFor(). */
async function rawClient(nickname, { origin } = {}) {
  const session = await loginAs(nickname);
  const ticket = await ticketFor(session.token);
  const ws = new WebSocket(`${wsBase}?ticket=${ticket}`, { headers: origin ? { origin } : {} });
  const frames = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    frames.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  const waitFor = (pred, ms = 2000) => {
    const found = frames.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('waitFor timed out')), ms).unref();
    });
  };
  let n = 0;
  const request = async (type, payload = {}) => {
    const id = `${nickname}-${++n}`;
    ws.send(JSON.stringify({ type, id, payload }));
    const r = await waitFor((m) => m.replyTo === id);
    if (r.type === 'error') throw Object.assign(new Error(r.payload.message), { code: r.payload.code });
    return r.payload;
  };
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const welcome = await waitFor((m) => m.type === 'session:welcome');
  return { ws, session, frames, waitFor, request, welcome, close: () => ws.close() };
}

function upgradeStatus(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', () => {});
  });
}

test('login -> ticket -> connect -> join -> send -> broadcast', async () => {
  const alice = await rawClient('alice');
  const bob = await rawClient('bob');
  assert.equal(alice.welcome.payload.user.name, 'alice');
  assert.ok(alice.welcome.payload.channels.some((c) => c.id === 'general'));

  await alice.request('channel:join', { channelId: 'general' });
  const joined = await bob.request('channel:join', { channelId: 'general' });
  assert.ok(Array.isArray(joined.messages));

  const sent = await alice.request('chat:send', { channelId: 'general', text: 'hello **world**' });
  assert.equal(sent.message.text, 'hello **world**');
  assert.ok(sent.message.seq >= 1);

  const got = await bob.waitFor((m) => m.type === 'chat:message' && m.payload.message.id === sent.message.id);
  assert.equal(got.payload.message.user.name, 'alice');
  assert.equal(got.replyTo, undefined, 'events never carry replyTo');

  alice.close();
  bob.close();
});

test('upgrade is refused without a valid ticket, on reuse, and from foreign origins', async () => {
  assert.equal(await upgradeStatus(wsBase), 401);
  assert.equal(await upgradeStatus(`${wsBase}?ticket=forged`), 401);

  const { token } = await loginAs('mallory');
  const ticket = await ticketFor(token);
  assert.equal(await upgradeStatus(`${wsBase}?ticket=${ticket}`), 101);
  assert.equal(await upgradeStatus(`${wsBase}?ticket=${ticket}`), 401, 'tickets are single-use');

  const t2 = await ticketFor(token);
  assert.equal(await upgradeStatus(`${wsBase}?ticket=${t2}`, { origin: 'https://evil.example' }), 403);
  assert.equal(await upgradeStatus(`${base.replace('http', 'ws')}/nope`), 404);
});

test('invalid frames get error replies correlated by id', async () => {
  const c = await rawClient('carol');
  c.ws.send(JSON.stringify({ type: 'chat:send', id: 'bad-1', payload: { channelId: 'general' } }));
  const err = await c.waitFor((m) => m.replyTo === 'bad-1');
  assert.equal(err.type, 'error');
  assert.equal(err.payload.code, 'bad_payload');

  await assert.rejects(c.request('chat:send', { channelId: 'general', text: 'x' }), { code: 'not_member' });
  await assert.rejects(c.request('channel:join', { channelId: 'nope' }), { code: 'not_found' });
  c.close();
});

test('chat:send is idempotent per clientMsgId', async () => {
  const c = await rawClient('dave');
  await c.request('channel:join', { channelId: 'random' });
  const a = await c.request('chat:send', { channelId: 'random', text: 'once', clientMsgId: 'k1' });
  const b = await c.request('chat:send', { channelId: 'random', text: 'once', clientMsgId: 'k1' });
  assert.equal(a.message.id, b.message.id);
  assert.equal(b.duplicate, true);
  c.close();
});

test('reactions toggle and broadcast; typing indicators fan out', async () => {
  const a = await rawClient('erin');
  const b = await rawClient('frank');
  await a.request('channel:join', { channelId: 'engineering' });
  await b.request('channel:join', { channelId: 'engineering' });
  const { message } = await a.request('chat:send', { channelId: 'engineering', text: 'ship it' });

  await b.request('chat:react', { channelId: 'engineering', messageId: message.id, emoji: '🚀' });
  const ev = await a.waitFor((m) => m.type === 'chat:reaction' && m.payload.reactions['🚀']);
  assert.deepEqual(ev.payload.reactions['🚀'], [b.session.user.id]);
  const off = await b.request('chat:react', { channelId: 'engineering', messageId: message.id, emoji: '🚀' });
  assert.equal(off.reactions['🚀'], undefined);

  b.ws.send(JSON.stringify({ type: 'typing:start', id: 't1', payload: { channelId: 'engineering' } }));
  const typing = await a.waitFor((m) => m.type === 'typing:update' && m.payload.users.length === 1);
  assert.equal(typing.payload.users[0].name, 'frank');
  a.close();
  b.close();
});

test('presence: others see you come online and go offline', async () => {
  const a = await rawClient('gina');
  const b = await rawClient('hank');
  await a.waitFor((m) => m.type === 'presence:update' && m.payload.user.id === b.session.user.id && m.payload.status === 'online');
  b.close();
  await a.waitFor((m) => m.type === 'presence:update' && m.payload.user.id === b.session.user.id && m.payload.status === 'offline');
  a.close();
});

test('rate limiter answers rate_limited instead of processing floods', async () => {
  const c = await rawClient('ivan');
  for (let i = 0; i < 40; i++) c.ws.send(JSON.stringify({ type: 'sys:ping', id: `f${i}`, payload: {} }));
  const limited = await c.waitFor((m) => m.type === 'error' && m.payload.code === 'rate_limited');
  assert.ok(limited.replyTo?.startsWith('f'));
  c.close();
});

test('HuddleSocket (the browser client) reconnects with a fresh ticket and resyncs missed messages', async (t) => {
  const session = await loginAs('judy');
  const getUrl = async () => `${wsBase}?ticket=${await ticketFor(session.token)}`;
  const sock = new HuddleSocket({ getUrl, baseDelayMs: 20, maxDelayMs: 100, pingIntervalMs: 60_000 });
  t.after(() => sock.close()); // never leave a reconnect loop running
  const opened = () => new Promise((r) => sock.addEventListener('open', (e) => r(e.detail), { once: true }));

  let o = opened();
  sock.connect();
  assert.deepEqual(await o, { reconnected: false });

  const joined = await sock.request('channel:join', { channelId: 'general' });
  const lastSeq = joined.messages.at(-1)?.seq ?? 0;

  // Kill judy's socket from the server side, then post while she's away.
  o = opened();
  const reconnecting = new Promise((r) => sock.addEventListener('reconnecting', (e) => r(e.detail), { once: true }));
  for (const c of huddle.hub.clients.values()) if (c.user.id === session.user.id) c.ws.terminate();
  const r = await reconnecting;
  assert.equal(r.attempt, 1);
  assert.ok(r.delay <= 20, 'first retry uses the base delay ceiling');

  const other = await rawClient('ken');
  await other.request('channel:join', { channelId: 'general' });
  const { message } = await other.request('chat:send', { channelId: 'general', text: 'you missed this' });

  assert.deepEqual(await o, { reconnected: true });
  const res = await sock.request('sys:resync', { channels: { general: lastSeq } });
  assert.ok(res.missed.general.messages.some((m) => m.id === message.id));

  // Requests reject with a timeout rather than hanging forever
  // (typing:start is a notification: the server never replies on success).
  await assert.rejects(sock.request('typing:start', { channelId: 'general' }, { timeoutMs: 50 }), { code: 'timeout' });

  sock.close();
  other.close();
});

test('media requests fail cleanly when mediasoup is disabled', async () => {
  const c = await rawClient('leo');
  await assert.rejects(c.request('media:getRouterRtpCapabilities', { roomId: 'general' }), { code: 'media_unavailable' });
  c.close();
});
