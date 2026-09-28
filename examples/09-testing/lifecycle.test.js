// examples/09-testing/lifecycle.test.js — handshake failures, limits, heartbeats, metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, connect, waitForClose, eventually } from './helpers.js';

test('upgrade on the wrong path is refused with an HTTP status (not a hang)', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  await assert.rejects(connect(`ws://127.0.0.1:${srv.port}/nope`), { statusCode: 404 });
});

test('a plain HTTP GET to /ws (no Upgrade header) is just a normal 404', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await fetch(`${srv.httpUrl}/ws`);
  // Express has no /ws route, so a normal GET falls through to 404 — the WS endpoint
  // is only reachable via the 'upgrade' event.
  assert.equal(res.status, 404);
});

test('frames larger than maxPayload close the socket with 1009', async (t) => {
  const srv = await startServer({ maxPayload: 1024 });
  t.after(() => srv.close());
  const ws = await connect(srv.wsUrl);
  const closed = waitForClose(ws);
  ws.send('x'.repeat(2048));
  const { code } = await closed;
  assert.equal(code, 1009); // Message Too Big
});

test('connections gauge tracks open/close', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await connect(srv.wsUrl);
  const b = await connect(srv.wsUrl);
  assert.equal(srv.metrics.connections, 2);
  a.close();
  b.close();
  await eventually(() => srv.metrics.connections === 0);
  assert.equal(srv.metrics.connectionsTotal, 2);
});

test('heartbeat terminates a client that stops answering pings', async (t) => {
  const srv = await startServer({ heartbeatMs: 50 });
  t.after(() => srv.close());
  // autoPong:false (ws >= 8.17) simulates a dead peer / half-open TCP connection
  const zombie = await connect(srv.wsUrl, { autoPong: false });
  const healthy = await connect(srv.wsUrl);
  const { code } = await waitForClose(zombie, 1000);
  assert.equal(code, 1006);               // abnormal closure: server terminate()d the TCP socket
  assert.equal(healthy.readyState, WebSocket.OPEN);
  assert.ok(srv.metrics.terminated >= 1);
  healthy.close();
});

test('/metrics exposes Prometheus text format', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const ws = await connect(srv.wsUrl);
  t.after(() => ws.close());
  const res = await fetch(`${srv.httpUrl}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const body = await res.text();
  assert.match(body, /^# TYPE ws_connections gauge$/m);
  assert.match(body, /^ws_connections 1$/m);
  assert.match(body, /^ws_messages_sent_total \d+$/m);
});
