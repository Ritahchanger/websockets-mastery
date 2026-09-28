// examples/01-raw-handshake/raw-client.js
//
// A byte-level WebSocket CLIENT using only node:net + node:crypto.
// It prints every byte it sends and receives so you can match them against
// the frame diagram. Run the server first (npm run ex:01), then:
//
//   node examples/01-raw-handshake/raw-client.js

import net from 'node:net';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT) || 3000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// Build a CLIENT frame: FIN=1, given opcode, MASK=1, random 4-byte key.
// (Kept to payloads < 126 bytes for readability.)
function clientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

const key = crypto.randomBytes(16).toString('base64');
const expectedAccept = crypto.createHash('sha1').update(key + GUID).digest('base64');

const socket = net.connect(PORT, 'localhost', () => {
  socket.write(
    [
      'GET / HTTP/1.1',
      `Host: localhost:${PORT}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Protocol: echo.v1',
      '',
      '',
    ].join('\r\n'),
  );
});

let handshakeDone = false;
let pending = Buffer.alloc(0);

socket.on('data', (chunk) => {
  if (!handshakeDone) {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf('\r\n\r\n');
    if (end === -1) return; // headers not complete yet
    const headers = pending.subarray(0, end).toString();
    console.log('--- handshake response ---\n' + headers + '\n--------------------------');
    const accept = /sec-websocket-accept:\s*(\S+)/i.exec(headers)?.[1];
    console.log(accept === expectedAccept ? 'Accept key verified OK' : 'Accept key MISMATCH!');
    handshakeDone = true;
    chunk = pending.subarray(end + 4); // anything after headers is already frames
    runScript();
  }
  if (chunk.length) {
    // Server frames are unmasked; for small frames: [b0, len, ...payload]
    console.log(`< ${hex(chunk)}`);
    let off = 0;
    while (off < chunk.length) {
      const op = chunk[off] & 0x0f;
      const len = chunk[off + 1] & 0x7f; // demo assumes < 126
      const body = chunk.subarray(off + 2, off + 2 + len);
      const label = { 1: 'TEXT', 2: 'BINARY', 8: 'CLOSE', 10: 'PONG' }[op] ?? `op ${op}`;
      const text = op === 8 ? `code=${body.readUInt16BE(0)}` : body.toString();
      console.log(`  = ${label}: ${text}`);
      off += 2 + len;
    }
  }
});

function runScript() {
  const steps = [
    () => send(0x1, Buffer.from('Hi')), // text
    () => send(0x9, Buffer.from('are you there?')), // ping
    () => { // close with code 1000 + reason
      const body = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('bye')]);
      send(0x8, body);
    },
  ];
  steps.forEach((fn, i) => setTimeout(fn, 200 * (i + 1)));
}

function send(opcode, payload) {
  const frame = clientFrame(opcode, payload);
  console.log(`> ${hex(frame)}`);
  socket.write(frame);
}

socket.on('end', () => console.log('server closed the TCP connection'));
socket.on('error', (e) => console.error('socket error:', e.message));
