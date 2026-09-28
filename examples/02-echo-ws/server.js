// examples/02-echo-ws/server.js
//
// Echo + broadcast server using the `ws` library.
//   - Plain node:http serves the browser client (public/index.html).
//   - A WebSocketServer shares the SAME http server and port, on path /ws.
//   - Text  -> echoed to sender AND broadcast to everyone else.
//   - Binary -> echoed back to sender as binary (shows isBinary handling).
//
// Run: npm run ex:02   then open http://localhost:3000 in two tabs,
//      and/or: node examples/02-echo-ws/client.js

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- 1. HTTP server: serves the HTML client --------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = await fs.readFile(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
});

// --- 2. WebSocket server attached to the same HTTP server -----------------
const wss = new WebSocketServer({
  server,              // share the port with our HTTP handler
  path: '/ws',         // only upgrades to /ws are accepted (others get 400)
  maxPayload: 64 * 1024, // 64 KB per message; larger -> close code 1009
  // perMessageDeflate is false by default; see chapter text for trade-offs.
});

// Per-connection metadata. Everything added on connect is removed on close.
const clients = new Map(); // WebSocket -> { id, name }

// Helper: serialize ONCE, then send the same string to each open client.
function broadcast(message, { except } = {}) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Helper: send a JSON object to one client (if it's still open).
function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

wss.on('connection', (ws, req) => {
  // `req` is the HTTP upgrade request: handy for IP, headers, query string.
  const id = crypto.randomUUID().slice(0, 4);
  const name = `guest-${id}`;
  clients.set(ws, { id, name });

  const ip = req.socket.remoteAddress;
  console.log(`[+] ${name} connected from ${ip} (${wss.clients.size} online)`);

  // Greet the newcomer, tell everyone else.
  sendJson(ws, { kind: 'welcome', you: name, online: wss.clients.size });
  broadcast({ kind: 'system', text: `${name} joined`, online: wss.clients.size }, { except: ws });

  ws.on('message', (data, isBinary) => {
    const me = clients.get(ws);

    if (isBinary) {
      // Binary: `data` is a Buffer. Echo the exact bytes back as a BINARY frame.
      console.log(`[bin] ${me.name}: ${data.length} bytes`, data.subarray(0, 8));
      ws.send(data, { binary: true });
      return;
    }

    // Text: `data` is a Buffer holding UTF-8 (ws 8+). Decode it ourselves.
    const text = data.toString().trim();
    if (!text) return;
    console.log(`[txt] ${me.name}: ${text}`);

    // Tiny command: "/nick <name>" renames you.
    if (text.startsWith('/nick ')) {
      const old = me.name;
      me.name = text.slice(6).trim().slice(0, 20) || old;
      sendJson(ws, { kind: 'system', text: `you are now ${me.name}` });
      broadcast({ kind: 'system', text: `${old} is now ${me.name}` }, { except: ws });
      return;
    }

    sendJson(ws, { kind: 'echo', text });                              // back to sender
    broadcast({ kind: 'broadcast', from: me.name, text }, { except: ws }); // to others
  });

  ws.on('close', (code, reason) => {
    // In ws 8, `reason` is a Buffer.
    const me = clients.get(ws);
    clients.delete(ws); // <- no leaks
    console.log(`[-] ${me.name} left (code=${code} reason="${reason.toString()}")`);
    // By the time 'close' fires, ws is already removed from wss.clients.
    broadcast({ kind: 'system', text: `${me.name} left`, online: wss.clients.size });
  });

  // Without an 'error' listener, errors (e.g. message > maxPayload) crash the process.
  ws.on('error', (err) => console.error(`[!] ${clients.get(ws)?.name}:`, err.message));
});

server.listen(PORT, () => {
  console.log(`HTTP + WS on http://localhost:${PORT}  (WebSocket path: /ws)`);
});

// Graceful shutdown on Ctrl+C: close every socket with 1001 "going away".
process.on('SIGINT', () => {
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref(); // don't hang forever
});
