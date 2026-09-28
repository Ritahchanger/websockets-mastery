// examples/01-raw-handshake/server.js
//
// A WebSocket server written with ONLY Node's built-in modules.
// No `ws`, no Express. The point is to see every byte of RFC 6455:
//
//   1. the HTTP/1.1 "Upgrade" handshake (Sec-WebSocket-Key -> Sec-WebSocket-Accept)
//   2. the binary frame format (FIN, opcode, MASK, payload length, masking key)
//   3. control frames: ping -> pong, close -> close
//
// This is for LEARNING. It deliberately skips things a production library
// handles (fragmented messages across many frames are only partly supported,
// no permessage-deflate, no UTF-8 validation, minimal limits). Use `ws` for
// real work (chapter 2).
//
// Run:  npm run ex:01   then open http://localhost:3000

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The "magic" GUID from RFC 6455 §1.3. Every WebSocket server on earth
// concatenates this exact string to the client's key.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Opcodes (RFC 6455 §5.2)
const OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

// Refuse absurdly large frames so a malicious client can't make us allocate GBs.
const MAX_PAYLOAD = 1024 * 1024; // 1 MiB

// ---------------------------------------------------------------------------
// 1. Plain HTTP: serve the demo client page.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------------------------------------------------------------------
// 2. The handshake.
//
// When a request carries `Connection: Upgrade` + `Upgrade: websocket`, Node
// does NOT call the normal request handler. It emits 'upgrade' and hands us
// the raw TCP socket. From here on, WE own the bytes.
// ---------------------------------------------------------------------------
server.on('upgrade', (req, socket, head) => {
  // Validate the request per RFC 6455 §4.2.1.
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  const upgrade = (req.headers.upgrade || '').toLowerCase();

  if (req.method !== 'GET' || upgrade !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  if (version !== '13') {
    // Tell the client which version(s) we speak.
    socket.end(
      'HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n',
    );
    return;
  }

  // Accept = base64( SHA-1( key + GUID ) )
  // This proves the server actually understood the WebSocket handshake and
  // isn't some HTTP server/proxy blindly echoing headers back.
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  // Optional subprotocol negotiation: the client offers a comma-separated
  // list; the server picks ONE (or none). We support "echo.v1".
  const offered = (req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const protocol = offered.includes('echo.v1') ? 'echo.v1' : null;

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  if (protocol) responseHeaders.push(`Sec-WebSocket-Protocol: ${protocol}`);

  // Headers end with an empty line (\r\n\r\n). After that: WebSocket frames.
  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
  console.log(`[handshake] key=${key} -> accept=${accept} protocol=${protocol ?? '(none)'}`);

  // Disable Nagle's algorithm: small frames should go out immediately.
  socket.setNoDelay(true);

  handleConnection(socket, head);
});

// ---------------------------------------------------------------------------
// 3. After the handshake: a per-connection frame parser.
// ---------------------------------------------------------------------------
function handleConnection(socket, head) {
  // TCP is a STREAM, not a sequence of messages. One 'data' event may contain
  // half a frame, exactly one frame, or three frames and a bit. So we keep a
  // buffer and parse as many complete frames as we can each time.
  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  // For fragmented messages (FIN=0 ... continuation ... FIN=1)
  let fragments = [];
  let fragmentOpcode = null;
  let closed = false;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      let frame;
      while ((frame = parseFrame(buffer)) !== null) {
        buffer = buffer.subarray(frame.totalLength);
        onFrame(frame);
      }
    } catch (err) {
      console.error('[protocol error]', err.message);
      sendClose(1002, err.message.slice(0, 100)); // 1002 = protocol error
    }
  });

  socket.on('close', () => console.log('[socket] TCP connection closed'));
  socket.on('error', (err) => console.error('[socket error]', err.message));

  function onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.TEXT:
      case OP.BINARY:
        if (fin) return onMessage(opcode, payload);
        // First fragment of a larger message.
        fragmentOpcode = opcode;
        fragments = [payload];
        return;

      case OP.CONTINUATION:
        if (fragmentOpcode === null) throw new Error('Unexpected continuation frame');
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          const op = fragmentOpcode;
          fragments = [];
          fragmentOpcode = null;
          onMessage(op, full);
        }
        return;

      case OP.PING:
        // RFC: a pong MUST echo the ping's application data.
        console.log(`[ping] ${payload.length} bytes -> pong`);
        return socket.write(encodeFrame(OP.PONG, payload));

      case OP.PONG:
        console.log('[pong] received');
        return;

      case OP.CLOSE: {
        // Close payload: 2-byte big-endian status code + optional UTF-8 reason.
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; // 1005 = "no status"
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        console.log(`[close] client sent code=${code} reason="${reason}"`);
        // Echo the close back (the "closing handshake"), then end TCP.
        // The SERVER should be the one to close TCP first (RFC §7.1.1),
        // so the TIME_WAIT state lands on the server, not the client.
        sendClose(code === 1005 ? 1000 : code, '');
        return;
      }

      default:
        throw new Error(`Unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  function onMessage(opcode, payload) {
    if (opcode === OP.TEXT) {
      const text = payload.toString('utf8');
      const preview = text.length > 60 ? `${text.slice(0, 60)}... (${text.length} chars)` : text;
      console.log(`[message] text: ${JSON.stringify(preview)}`);
      socket.write(encodeFrame(OP.TEXT, Buffer.from(`echo: ${text}`, 'utf8')));
    } else {
      console.log(`[message] binary: ${payload.length} bytes`);
      socket.write(encodeFrame(OP.BINARY, payload));
    }
  }

  function sendClose(code, reason) {
    if (closed) return;
    closed = true;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const body = Buffer.alloc(2 + reasonBuf.length);
    body.writeUInt16BE(code, 0);
    reasonBuf.copy(body, 2);
    socket.end(encodeFrame(OP.CLOSE, body)); // end() = write then FIN the TCP socket
  }

  // Say hello so the client sees a server-initiated message.
  socket.write(encodeFrame(OP.TEXT, Buffer.from('Hello from a hand-written WebSocket server!')));
}

// ---------------------------------------------------------------------------
// 4. Frame decoding (RFC 6455 §5.2)
//
//   0                   1                   2                   3
//   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//  +-+-+-+-+-------+-+-------------+-------------------------------+
//  |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
//  |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
//  |N|V|V|V|       |S|             |   (if payload len==126/127)   |
//  | |1|2|3|       |K|             |                               |
//  +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
//  |     Extended payload length continued, if payload len == 127  |
//  + - - - - - - - - - - - - - - - +-------------------------------+
//  |                               |Masking-key, if MASK set to 1  |
//  +-------------------------------+-------------------------------+
//  | Masking-key (continued)       |          Payload Data         |
//  +-------------------------------- - - - - - - - - - - - - - - - +
//
// Returns null if `buf` doesn't yet hold a complete frame.
// ---------------------------------------------------------------------------
function parseFrame(buf) {
  if (buf.length < 2) return null;

  const b0 = buf[0];
  const b1 = buf[1];

  const fin = (b0 & 0b1000_0000) !== 0;
  const rsv = b0 & 0b0111_0000; // must be 0 unless an extension says otherwise
  const opcode = b0 & 0b0000_1111;
  const masked = (b1 & 0b1000_0000) !== 0;
  let payloadLen = b1 & 0b0111_1111;
  let offset = 2;

  if (rsv !== 0) throw new Error('RSV bits set but no extension negotiated');
  // Clients MUST mask every frame they send (RFC §5.1). Servers must reject unmasked.
  if (!masked) throw new Error('Client frames must be masked');

  // Payload length is encoded in 7 bits, OR 7+16 bits, OR 7+64 bits.
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_PAYLOAD)) throw new Error('Frame too large');
    payloadLen = Number(big);
    offset += 8;
  }

  if (payloadLen > MAX_PAYLOAD) throw new Error('Frame too large');

  // Control frames: payload <= 125 and never fragmented (RFC §5.5).
  if (opcode >= 0x8 && (payloadLen > 125 || !fin)) {
    throw new Error('Invalid control frame');
  }

  if (buf.length < offset + 4) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;

  if (buf.length < offset + payloadLen) return null; // wait for more bytes

  // Unmask: byte i of the payload is XOR'd with mask[i % 4].
  // (Copy first so we don't mutate the shared input buffer.)
  const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= mask[i & 3];
  }

  return { fin, opcode, payload, totalLength: offset + payloadLen };
}

// ---------------------------------------------------------------------------
// 5. Frame encoding (server -> client). Servers MUST NOT mask.
// ---------------------------------------------------------------------------
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len; // MASK bit = 0
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0b1000_0000 | opcode; // FIN=1, single-frame message

  return Buffer.concat([header, payload]);
}

server.listen(PORT, () => {
  console.log(`Raw WebSocket server on http://localhost:${PORT}`);
});

// Exported only so the chapter can reference/test them. Not needed to run.
export { parseFrame, encodeFrame, WS_GUID };
