// Composition root: builds every piece and wires them together. Nothing else
// imports config or creates singletons, which is what makes it testable —
// tests call createHuddleServer() with overrides and port 0.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { Hub } from './ws/hub.js';
import { MessageRouter } from './ws/router.js';
import { createGateway } from './ws/gateway.js';
import { registerChat } from './chat/handlers.js';
import { createMedia } from './media/index.js';
import { Metrics, metricsRouter } from './metrics.js';
import { logger } from './logger.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

export async function createHuddleServer(overrides = {}) {
  const config = loadConfig(overrides);
  const app = express();
  const server = http.createServer(app);
  const hub = new Hub();
  const router = new MessageRouter();
  const metrics = new Metrics();
  const auth = createAuth(config);

  // Media needs chat (to validate room ids) and chat needs media (to list
  // huddles in the welcome snapshot) — break the cycle with a late-bound getter.
  let media;
  const chat = registerChat({ router, hub, config, getHuddles: () => media?.huddles() ?? [] });
  media = await createMedia({ config, hub, router, validateRoom: (id) => chat.channels.get(id) });

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.use('/api', auth.router);
  app.get('/api/config', (req, res) => res.json({ media: media.available, wsPath: config.ws.path }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/metrics', metricsRouter(metrics, { hub, chat, media }));
  app.use(express.static(publicDir, { extensions: ['html'] }));

  const gateway = createGateway({ server, config, tickets: auth.tickets, router, hub, metrics });

  return {
    app,
    server,
    config,
    hub,
    chat,
    media,
    auth,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      gateway.close();
      media.close();
      auth.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Run directly: `node src/server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const huddle = await createHuddleServer();
  const addr = await huddle.listen();
  logger.info(`Huddle listening on http://localhost:${addr.port}`, {
    media: huddle.media.available,
    announcedIp: huddle.config.media.announcedIp,
    rtcPorts: `${huddle.config.media.rtcMinPort}-${huddle.config.media.rtcMaxPort}`,
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 5000).unref();
    await huddle.close();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
