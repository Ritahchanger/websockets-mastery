// examples/09-testing/helpers.js — reusable test utilities for WebSocket servers.
// Not a test file: its name doesn't match *.test.js, so the runner never executes it.
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';

/** Start an isolated app on a random port. Returns urls + a close() for t.after(). */
export async function startServer(opts = {}) {
  const instance = createApp(opts);
  const urls = await instance.listen(0);
  return { ...instance, ...urls };
}

/**
 * Open a client and resolve once it's OPEN *and* has received the server's `hello`.
 * Installing the message queue BEFORE 'open' fires means we can never miss a frame
 * the server sends immediately on connect — the #1 source of flaky WS tests.
 */
export function connect(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    attachInbox(ws);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error(`Unexpected server response: ${res.statusCode}`), { statusCode: res.statusCode })));
    ws.once('open', async () => {
      try {
        const hello = await nextMessage(ws, (m) => m.type === 'hello');
        ws.clientId = hello.payload.clientId;
        resolve(ws);
      } catch (e) { reject(e); }
    });
  });
}

/** Buffer every incoming JSON message so tests can await them in any order. */
function attachInbox(ws) {
  ws.inbox = [];
  ws.waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const i = ws.waiters.findIndex((w) => w.predicate(msg));
    if (i >= 0) ws.waiters.splice(i, 1)[0].resolve(msg);
    else ws.inbox.push(msg);
  });
}

/**
 * Await the next message matching `predicate` (default: any). Checks already-buffered
 * messages first; rejects after `timeout` ms with a helpful error instead of hanging.
 */
export function nextMessage(ws, predicate = () => true, timeout = 1000) {
  const i = ws.inbox.findIndex(predicate);
  if (i >= 0) return Promise.resolve(ws.inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } };
    const timer = setTimeout(() => {
      ws.waiters.splice(ws.waiters.indexOf(waiter), 1);
      reject(new Error(`nextMessage: timed out after ${timeout}ms (inbox: ${JSON.stringify(ws.inbox)})`));
    }, timeout);
    ws.waiters.push(waiter);
  });
}

/** Send an envelope and await the reply whose replyTo matches its id. */
export async function request(ws, type, payload, timeout) {
  const id = randomUUID();
  ws.send(JSON.stringify({ type, id, payload }));
  return nextMessage(ws, (m) => m.replyTo === id, timeout);
}

/** Assert that NO matching message arrives within `ms` (for negative tests). */
export async function expectSilence(ws, predicate = () => true, ms = 100) {
  try {
    const m = await nextMessage(ws, predicate, ms);
    throw Object.assign(new Error(`expected silence, got ${JSON.stringify(m)}`), { unexpected: true });
  } catch (e) {
    if (e.unexpected) throw e; // timeout = success
  }
}

/** Resolve with { code, reason } when the socket closes. */
export function waitForClose(ws, timeout = 2000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: ws._closeCode, reason: '' });
    const timer = setTimeout(() => reject(new Error('waitForClose timed out')), timeout);
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
  });
}

/** Poll until fn() is truthy (e.g. a metrics gauge catching up after a close). */
export async function eventually(fn, { timeout = 1000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { if (await fn()) return; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error('eventually: condition not met in time');
    await new Promise((r) => setTimeout(r, interval));
  }
}
