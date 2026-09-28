// Full mediasoup signaling in Node: the real server + the real browser
// classes (HuddleSocket, HuddleMedia), with mediasoup-client's FakeHandler
// standing in for WebRTC. Skipped if mediasoup can't start on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Device } from 'mediasoup-client';
import { FakeHandler } from 'mediasoup-client/handlers/FakeHandler';
import * as fakeParameters from 'mediasoup-client/fakeParameters';
import { FakeMediaStreamTrack } from 'fake-mediastreamtrack';
import { createHuddleServer } from '../src/server.js';
import { HuddleSocket } from '../public/src/ws-client.js';
import { HuddleMedia } from '../public/src/media-client.js';

let huddle;
let base;
let skip = false;

before(async () => {
  huddle = await createHuddleServer({ media: { numWorkers: 2, rtcMinPort: 41000, rtcMaxPort: 41100, listenIp: '127.0.0.1' } });
  skip = !huddle.media.available;
  const { port } = await huddle.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});
after(() => huddle.close());

async function participant(nickname) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }) });
  const { token, user } = await res.json();
  const getUrl = async () => {
    const r = await fetch(`${base}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    return `${base.replace('http', 'ws')}/ws?ticket=${(await r.json()).ticket}`;
  };
  const socket = new HuddleSocket({ getUrl, pingIntervalMs: 60_000 });
  const opened = new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.connect();
  await opened;
  const media = new HuddleMedia(socket, {
    createDevice: () => new Device({ handlerFactory: FakeHandler.createFactory(fakeParameters) }),
  });
  const events = [];
  for (const t of ['peerJoined', 'peerLeft', 'track', 'trackEnded', 'trackPaused', 'left']) {
    media.addEventListener(t, (e) => events.push({ type: t, ...e.detail }));
  }
  const waitFor = async (type, pred = () => true, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = events.find((e) => e.type === type && pred(e));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${nickname}: no ${type} event`);
  };
  return { user, socket, media, events, waitFor, close: () => socket.close() };
}

const fakeTrack = (kind) => new FakeMediaStreamTrack({ kind });

test('two peers: produce, consume, pause, close, leave', async (t) => {
  if (skip) return t.skip('mediasoup unavailable');
  const alice = await participant('alice');
  const bob = await participant('bob');
  t.after(() => {
    alice.close();
    bob.close();
  });

  await alice.media.join('general');
  await alice.media.produce('mic', fakeTrack('audio'));
  assert.equal(huddle.media.stats().producers, 1);

  // Bob joins late: must consume Alice's existing producer.
  await bob.media.join('general');
  await alice.waitFor('peerJoined', (e) => e.user.name === 'bob');
  const audio = await bob.waitFor('track', (e) => e.source === 'mic');
  assert.equal(audio.kind ?? audio.track.kind, 'audio');

  // Alice turns her camera on: Bob is notified via media:newProducer.
  await alice.media.produce('cam', fakeTrack('video'));
  await bob.waitFor('track', (e) => e.source === 'cam');
  const stats = huddle.media.stats();
  assert.equal(stats.peers, 2);
  assert.equal(stats.consumers, 2);

  // Mute: producer paused server-side -> consumer 'producerpause' -> Bob.
  await alice.media.setMicMuted(true);
  await bob.waitFor('trackPaused', (e) => e.source === 'mic');

  // Camera off: producer closed -> Bob's consumer goes away.
  await alice.media.stop('cam');
  await bob.waitFor('trackEnded', (e) => e.source === 'cam');

  // Everyone can see the huddle from the sidebar.
  assert.deepEqual(huddle.media.huddles()[0].participants.map((u) => u.name).sort(), ['alice', 'bob']);

  await alice.media.leave();
  await bob.waitFor('peerLeft');
  await bob.media.leave();
  assert.equal(huddle.media.stats().rooms, 0, 'empty rooms are closed');
});

test('a dead worker closes its rooms and is replaced', async (t) => {
  if (skip) return t.skip('mediasoup unavailable');
  const carol = await participant('carol');
  t.after(() => carol.close());
  await carol.media.join('random');
  const room = huddle.media.service.rooms.get('random');
  const workersBefore = huddle.media.service.pool.size;

  process.kill(room.worker.pid, 'SIGKILL');
  const left = await carol.waitFor('left', () => true, 5000);
  assert.equal(left.reason, 'worker_died');
  assert.equal(carol.media.active, false);

  // Respawn happens ~1s later.
  const deadline = Date.now() + 5000;
  while (huddle.media.service.pool.size < workersBefore && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(huddle.media.service.pool.size, workersBefore);

  // And the huddle can be rejoined on a healthy worker.
  await carol.media.join('random');
  assert.ok(carol.media.active);
  await carol.media.leave();
});
