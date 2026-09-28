// examples/02-echo-ws/client.js
//
// Interactive terminal client using the `ws` library.
//   node examples/02-echo-ws/client.js [ws://localhost:3000/ws]
//
// Type a line and press Enter to send it as text.
//   /bin   -> send 4 random bytes as a binary frame
//   /ping  -> send a WebSocket PING (browsers can't do this!)
//   /quit  -> close cleanly with code 1000

import readline from 'node:readline';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const url = process.argv[2] || `ws://localhost:${process.env.PORT || 3000}/ws`;

// Node clients CAN send custom headers (browsers can't). Handy for tokens later.
const ws = new WebSocket(url, { headers: { 'User-Agent': 'ws-course-cli/1.0' } });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

ws.on('open', () => {
  console.log(`connected to ${url}`);
  rl.prompt();
});

ws.on('message', (data, isBinary) => {
  // Same (data, isBinary) signature as on the server.
  if (isBinary) {
    console.log(`\n[binary ${data.length}B]`, [...data]);
  } else {
    const msg = JSON.parse(data.toString());
    const line =
      msg.kind === 'broadcast' ? `${msg.from}: ${msg.text}`
      : msg.kind === 'echo' ? `(echo) ${msg.text}`
      : msg.kind === 'welcome' ? `* welcome, you are ${msg.you} (${msg.online} online)`
      : `* ${msg.text}`;
    console.log(`\n${line}`);
  }
  rl.prompt(true);
});

ws.on('pong', (data) => {
  const rtt = Date.now() - Number(data.toString());
  console.log(`\n[pong] round trip ${rtt} ms`);
  rl.prompt(true);
});

ws.on('close', (code, reason) => {
  console.log(`\nclosed: ${code} ${reason.toString()}`);
  process.exit(0);
});

ws.on('error', (err) => {
  // e.g. ECONNREFUSED if the server isn't running, or "Unexpected server response: 404"
  console.error('error:', err.message);
});

rl.on('line', (line) => {
  const text = line.trim();
  if (ws.readyState !== WebSocket.OPEN) return console.log('not connected');

  if (text === '/quit') return ws.close(1000, 'bye');
  if (text === '/bin') ws.send(crypto.randomBytes(4)); // Buffer -> binary frame
  else if (text === '/ping') ws.ping(String(Date.now())); // payload comes back in 'pong'
  else if (text) ws.send(text); // string -> text frame
  rl.prompt();
});

rl.on('close', () => ws.close(1000, 'stdin closed')); // Ctrl+D
