// examples/11-mediasoup-minimal/test-signaling.js — run: npm test
// Drives the full server-side signaling flow with plain ws clients (no browser):
// caps → transports → join → produce (fake Opus params) → consume → resume → leave cascade.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
const port = 3000 + Math.floor(Math.random() * 1000) + 1000;
const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: String(port) } });
proc.stderr.pipe(process.stderr);
await new Promise((resolve) => proc.stdout.on('data', (d) => String(d).includes('[ex11]') && resolve()));

function client() {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const pending = new Map();
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.replyTo && pending.has(msg.replyTo)) {
      const { resolve, reject } = pending.get(msg.replyTo);
      pending.delete(msg.replyTo);
      return msg.type === 'error' ? reject(new Error(msg.payload.message)) : resolve(msg.payload);
    }
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg.payload);
    else inbox.push(msg);
  });
  return {
    ws,
    open: () => once(ws, 'open'),
    request: (type, payload = {}) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type, id, payload }));
    }),
    next: (type) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0].payload);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

try {
  const alice = client(); const bob = client();
  await Promise.all([alice.open(), bob.open()]);

  const { rtpCapabilities } = await alice.request('getRouterRtpCapabilities');
  assert.ok(rtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus'), 'router has opus');

  await assert.rejects(alice.request('produce', {}), /join first/);
  await assert.rejects(alice.request('nope'), /unknown request/);

  const aSend = await alice.request('createWebRtcTransport', { direction: 'send' });
  assert.ok(aSend.id && aSend.iceParameters && aSend.dtlsParameters && aSend.iceCandidates.length >= 1);
  console.log('  announced ICE candidates:', aSend.iceCandidates.map((c) => `${c.protocol}:${c.address}:${c.port}`).join(' '));

  // Use the router caps as a stand-in for a browser's recvRtpCapabilities.
  const aJoin = await alice.request('join', { name: 'alice', rtpCapabilities });
  assert.deepEqual(aJoin.producers, []);

  // A fake Opus producer (no real RTP will arrive — mediasoup doesn't care for this test).
  const opus = rtpCapabilities.codecs.find((c) => c.mimeType === 'audio/opus');
  const { id: producerId } = await alice.request('produce', {
    transportId: aSend.id,
    kind: 'audio',
    rtpParameters: {
      mid: '0',
      codecs: [{ mimeType: 'audio/opus', payloadType: opus.preferredPayloadType, clockRate: 48000, channels: 2 }],
      encodings: [{ ssrc: 11111111 }],
      headerExtensions: [],
      rtcp: { cname: 'alice' },
    },
    appData: { source: 'mic' },
  });
  assert.ok(producerId);

  // Bob joins and must see alice's producer
  const bRecv = await bob.request('createWebRtcTransport', { direction: 'recv' });
  const bJoin = await bob.request('join', { name: 'bob', rtpCapabilities });
  assert.equal(bJoin.peers[0].name, 'alice');
  assert.equal(bJoin.producers[0].producerId, producerId);
  assert.equal((await alice.next('peerJoined')).name, 'bob');

  const consumed = await bob.request('consume', { transportId: bRecv.id, producerId });
  assert.equal(consumed.kind, 'audio');
  assert.equal(consumed.peerId, aJoin.peerId);
  await bob.request('resumeConsumer', { consumerId: consumed.id });

  // Ownership: bob can't use alice's transport
  await assert.rejects(bob.request('connectTransport', { transportId: aSend.id, dtlsParameters: aSend.dtlsParameters }), /not found/);

  const stats = await (await fetch(`http://localhost:${port}/stats`)).json();
  assert.equal(stats.peers, 2); assert.equal(stats.producers, 1); assert.equal(stats.consumers, 1);

  // Alice leaves → cascade → bob gets consumerClosed + peerLeft
  alice.ws.close();
  assert.equal((await bob.next('consumerClosed')).consumerId, consumed.id);
  assert.equal((await bob.next('peerLeft')).peerId, aJoin.peerId);

  bob.ws.close();
  console.log('✔ mediasoup signaling flow tests passed');
} catch (err) {
  console.error('✘', err);
  process.exitCode = 1;
} finally {
  proc.kill('SIGTERM');
}
