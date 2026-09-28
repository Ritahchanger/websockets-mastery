// Chapter 8 — tiny WebSocket load generator (no extra deps).
//
//   node examples/08-scaling-redis/flood.js --urls ws://localhost:3001/ws,ws://localhost:3002/ws \
//        --clients 2000 --rate 200 --rooms 20 --msgs 1 --duration 30
//
//   --urls      comma-separated targets; clients are spread round-robin
//   --clients   total connections to open
//   --rate      new connections per second (ramp-up; never open all at once)
//   --rooms     number of rooms to spread clients over
//   --msgs      chat messages per client per second (can be fractional, e.g. 0.1)
//   --duration  seconds to run after ramp-up completes
//
// Latency is measured end-to-end: the sender embeds Date.now() in the text and
// every receiver computes now - sentAt. Sender and receivers are the same
// process, so there's no clock skew.
import { WebSocket } from 'ws';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({
  options: {
    urls: { type: 'string', default: 'ws://localhost:3000/ws' },
    clients: { type: 'string', default: '500' },
    rate: { type: 'string', default: '100' },
    rooms: { type: 'string', default: '10' },
    msgs: { type: 'string', default: '0.2' },
    duration: { type: 'string', default: '20' },
  },
});
const urls = o.urls.split(',');
const N = Number(o.clients), RATE = Number(o.rate), ROOMS = Number(o.rooms);
const MSGS = Number(o.msgs), DURATION = Number(o.duration);

const s = { open: 0, failed: 0, closed: 0, sent: 0, recv: 0, lat: [] };
const sockets = [];

function openOne(i) {
  const ws = new WebSocket(urls[i % urls.length]);
  const room = `load-${i % ROOMS}`;
  let timer;
  ws.on('open', () => {
    s.open++;
    ws.send(JSON.stringify({ type: 'room:join', id: `j${i}`, payload: { room, user: `bot${i}` } }));
    if (MSGS > 0) {
      // Randomize phase so clients don't all fire in the same millisecond.
      const every = 1000 / MSGS;
      setTimeout(() => {
        timer = setInterval(() => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify({ type: 'chat:message', id: `m${i}-${s.sent}`, payload: { room, text: `t=${Date.now()}` } }));
          s.sent++;
        }, every);
      }, Math.random() * every);
    }
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type !== 'chat:message') return;
    s.recv++;
    const t = Number(msg.payload.text.slice(2));
    if (t) s.lat.push(Date.now() - t);
  });
  ws.on('error', () => { s.failed++; });
  ws.on('close', () => { s.closed++; clearInterval(timer); });
  sockets.push(ws);
}

// Ramp up at RATE connections/sec.
let next = 0;
const ramp = setInterval(() => {
  for (let k = 0; k < RATE / 10 && next < N; k++) openOne(next++);
  if (next >= N) clearInterval(ramp);
}, 100);

const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);
let lastRecv = 0;
const report = setInterval(() => {
  const lat = s.lat.sort((a, b) => a - b);
  console.log(
    `open=${s.open - s.closed} failed=${s.failed} sent=${s.sent} recv/s=${s.recv - lastRecv} ` +
      `p50=${pct(lat, 50)}ms p99=${pct(lat, 99)}ms max=${lat.at(-1) ?? 0}ms`,
  );
  lastRecv = s.recv;
  s.lat = [];
}, 1000);

const total = N / RATE + DURATION;
setTimeout(() => {
  clearInterval(report);
  for (const ws of sockets) ws.terminate();
  console.log(`done: opened=${s.open} failed=${s.failed} sent=${s.sent} received=${s.recv}`);
  process.exit(0);
}, total * 1000);
