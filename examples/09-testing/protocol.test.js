// examples/09-testing/protocol.test.js — request/response and validation.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect, request, nextMessage } from './helpers.js';

describe('protocol', () => {
  let srv, ws;
  before(async () => {
    srv = await startServer();
    ws = await connect(srv.wsUrl);
  });
  after(async () => {
    ws.close();
    await srv.close();
  });

  test('server greets with hello + clientId', () => {
    assert.match(ws.clientId, /^[0-9a-f-]{36}$/);
  });

  test('ping gets a pong correlated by replyTo', async () => {
    const res = await request(ws, 'ping', {});
    assert.equal(res.type, 'pong');
    assert.equal(typeof res.payload.t, 'number');
  });

  test('invalid JSON yields BAD_JSON error (and the socket survives)', async () => {
    ws.send('{not json');
    const err = await nextMessage(ws, (m) => m.type === 'error');
    assert.equal(err.payload.code, 'BAD_JSON');
    // still usable afterwards
    assert.equal((await request(ws, 'ping', {})).type, 'pong');
  });

  test('missing envelope fields yields BAD_ENVELOPE', async () => {
    ws.send(JSON.stringify({ type: 'ping' })); // no id
    const err = await nextMessage(ws, (m) => m.type === 'error');
    assert.equal(err.payload.code, 'BAD_ENVELOPE');
  });

  test('unknown types are rejected with replyTo set', async () => {
    const err = await request(ws, 'does:not:exist', {});
    assert.equal(err.type, 'error');
    assert.equal(err.payload.code, 'UNKNOWN_TYPE');
  });

  test('payload validation (zod) rejects bad room names', async () => {
    const err = await request(ws, 'room:join', { room: '' });
    assert.equal(err.payload.code, 'BAD_PAYLOAD');
  });
});
