// examples/09-testing/server.js — run the testable app for manual poking
// (wscat, websocat, Chrome DevTools). Tests do NOT use this file.
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const verbose = process.env.DEBUG_WS === '1';
const log = (msg, meta = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...meta }));

const { listen, close } = createApp({ log: verbose ? log : (m, meta) => m !== 'ws error' || log(m, meta) });
const { httpUrl, wsUrl } = await listen(port, '0.0.0.0');
console.log(`HTTP ${httpUrl.replace('0.0.0.0', 'localhost')}  (/healthz, /metrics)`);
console.log(`WS   ${wsUrl.replace('0.0.0.0', 'localhost')}`);
console.log('Try:  npx wscat -c ws://localhost:' + port + '/ws');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await close(); process.exit(0); });
}
