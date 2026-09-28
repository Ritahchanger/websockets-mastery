import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage, ProtocolError, ClientMessages, reply, errorReply } from '../src/ws/protocol.js';
import { RingBuffer } from '../src/chat/ringBuffer.js';
import { TokenBucket } from '../src/ws/rateLimit.js';

const frame = (obj) => JSON.stringify(obj);
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ProtocolError);
    return err.code;
  }
  assert.fail('expected a ProtocolError');
};

test('parses a valid chat:send and trims text', () => {
  const msg = parseClientMessage(frame({ type: 'chat:send', id: 'a1', payload: { channelId: 'general', text: '  hi  ' } }));
  assert.deepEqual(msg, { type: 'chat:send', id: 'a1', payload: { channelId: 'general', text: 'hi' } });
});

test('accepts Buffer input (what ws gives us)', () => {
  const msg = parseClientMessage(Buffer.from(frame({ type: 'sys:ping', id: 'p' })));
  assert.equal(msg.type, 'sys:ping');
  assert.deepEqual(msg.payload, {});
});

test('rejects garbage with stable error codes', () => {
  assert.equal(code(() => parseClientMessage('{nope')), 'bad_json');
  assert.equal(code(() => parseClientMessage(frame({ type: 'chat:send' }))), 'bad_envelope'); // no id
  assert.equal(code(() => parseClientMessage(frame({ type: 'NOPE', id: '1' }))), 'bad_envelope');
  assert.equal(code(() => parseClientMessage(frame({ type: 'admin:nuke', id: '1' }))), 'unknown_type');
  assert.equal(code(() => parseClientMessage(frame({ type: 'chat:send', id: '1', payload: { channelId: 'general', text: '   ' } }))), 'bad_payload');
});

test('strict schemas reject unexpected fields (no mass-assignment)', () => {
  const c = code(() => parseClientMessage(frame({ type: 'chat:send', id: '1', payload: { channelId: 'general', text: 'x', user: { id: 'admin' } } })));
  assert.equal(c, 'bad_payload');
});

test('channel ids and media ids are validated', () => {
  assert.equal(code(() => parseClientMessage(frame({ type: 'channel:join', id: '1', payload: { channelId: '../etc' } }))), 'bad_payload');
  assert.equal(code(() => parseClientMessage(frame({ type: 'media:resumeConsumer', id: '1', payload: { consumerId: 'x' } }))), 'bad_payload');
  const ok = parseClientMessage(frame({ type: 'media:createTransport', id: '1', payload: { direction: 'send' } }));
  assert.equal(ok.payload.direction, 'send');
});

test('channel:create lowercases names', () => {
  const m = parseClientMessage(frame({ type: 'channel:create', id: '1', payload: { name: 'Design-Review' } }));
  assert.equal(m.payload.name, 'design-review');
});

test('every media handler type has a schema', () => {
  for (const t of ['getRouterRtpCapabilities', 'createTransport', 'connectTransport', 'produce', 'consume', 'resumeConsumer', 'closeProducer']) {
    assert.ok(ClientMessages[`media:${t}`], t);
  }
});

test('reply and errorReply carry replyTo', () => {
  const ok = reply('r1', { n: 1 });
  assert.equal(ok.type, 'ok');
  assert.equal(ok.replyTo, 'r1');
  const e = errorReply('r2', 'nope', 'Nope');
  assert.equal(e.type, 'error');
  assert.deepEqual(e.payload, { code: 'nope', message: 'Nope' });
});

test('RingBuffer keeps only the newest N in order', () => {
  const rb = new RingBuffer(3);
  for (let i = 1; i <= 5; i++) rb.push(i);
  assert.deepEqual(rb.toArray(), [3, 4, 5]);
  assert.deepEqual(rb.last(2), [4, 5]);
  assert.equal(rb.find((x) => x < 5), 4);
});

test('TokenBucket allows a burst then refills over time', () => {
  let now = 0;
  const b = new TokenBucket({ capacity: 3, refillPerSec: 2, now: () => now });
  assert.ok(b.take() && b.take() && b.take());
  assert.equal(b.take(), false);
  now += 500; // +1 token
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});
