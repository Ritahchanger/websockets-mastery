// examples/10-webrtc-p2p/test-signaling.js   —  run: node examples/10-webrtc-p2p/test-signaling.js
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', MAX_PEERS: '2' } });
const [chunk] = await once(proc.stdout, 'data');
const port = Number(/localhost:(\d+)/.exec(String(chunk))[1]);

// Tiny client: buffers messages so we can `await next(type)` without races.
function client() {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    open: () => once(ws, 'open'),
    send: (type, payload, id = crypto.randomUUID()) => (ws.send(JSON.stringify({ type, id, payload })), id),
    next: (type) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

try {
  const cfg = await (await fetch(`http://localhost:${port}/config`)).json();
  assert.ok(cfg.iceServers.length >= 1, '/config returns iceServers');

  const alice = client(); const bob = client(); const carol = client();
  await Promise.all([alice.open(), bob.open(), carol.open()]);

  const joinId = alice.send('room:join', { room: 't', name: 'alice' });
  const aJoined = await alice.next('room:joined');
  assert.equal(aJoined.replyTo, joinId, 'reply correlates with request id');
  assert.deepEqual(aJoined.payload.peers, []);

  bob.send('room:join', { room: 't', name: 'bob' });
  const bJoined = await bob.next('room:joined');
  assert.equal(bJoined.payload.peers[0].name, 'alice');
  const pj = await alice.next('peer:joined');
  assert.equal(pj.payload.id, bJoined.payload.selfId);

  // Relay: bob -> alice, "from" is stamped by the server
  const fakeOffer = { description: { type: 'offer', sdp: 'v=0\r\n...' } };
  bob.send('signal', { to: aJoined.payload.selfId, data: fakeOffer });
  const sig = await alice.next('signal');
  assert.equal(sig.payload.from, bJoined.payload.selfId);
  assert.deepEqual(sig.payload.data, fakeOffer);

  // Relay to unknown peer → error
  bob.send('signal', { to: 'nobody', data: {} });
  assert.equal((await bob.next('error')).payload.code, 'unknown_peer');

  // Mesh limit (MAX_PEERS=2)
  carol.send('room:join', { room: 't', name: 'carol' });
  assert.equal((await carol.next('error')).payload.code, 'room_full');

  // Leaving
  bob.ws.close();
  assert.equal((await alice.next('peer:left')).payload.id, bJoined.payload.selfId);

  alice.ws.close(); carol.ws.close();
  console.log('✔ signaling relay tests passed');
} catch (err) {
  console.error('✘', err);
  process.exitCode = 1;
} finally {
  proc.kill();
}
