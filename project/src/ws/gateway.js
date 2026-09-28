// The WebSocket gateway: the only door into the real-time side of Huddle.
//
//  HTTP upgrade ──► origin check ──► ticket check ──► handleUpgrade ──► Client
//                        │403             │401
//                        ▼                ▼
//                 raw HTTP error written to the socket, then destroyed
//
// After the handshake it owns: heartbeats, rate limiting, parse/validate,
// and handing valid messages to the router.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Client } from './hub.js';
import { TokenBucket } from './rateLimit.js';
import { parseClientMessage, ProtocolError, errorReply } from './protocol.js';
import { logger } from '../logger.js';

export const CLOSE = {
  GOING_AWAY: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
  RESTARTING: 1012,
};

function rejectUpgrade(socket, status, reason) {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }[status] ?? 'Error';
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
  socket.destroy();
}

/** Same-host pages are always allowed; ALLOWED_ORIGINS adds more (or '*'). */
export function isOriginAllowed(origin, host, config) {
  if (!origin) return config.allowNoOrigin;
  if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.host === host) return true;
    return config.allowedOrigins.length === 0 && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function createGateway({ server, config, tickets, router, hub, metrics }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.ws.maxPayload,
    perMessageDeflate: false, // CPU + memory cost rarely worth it for small JSON
    clientTracking: false, // the Hub tracks clients
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url, 'http://placeholder');
    if (url.pathname !== config.ws.path) return rejectUpgrade(socket, 404, 'Unknown WebSocket path');

    if (!isOriginAllowed(req.headers.origin, req.headers.host, config)) {
      logger.warn('ws origin rejected', { origin: req.headers.origin });
      metrics.countRejected('origin');
      return rejectUpgrade(socket, 403, 'Origin not allowed');
    }

    const user = tickets.consume(url.searchParams.get('ticket'));
    if (!user) {
      metrics.countRejected('ticket');
      return rejectUpgrade(socket, 401, 'Invalid or expired ticket');
    }

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, req));
  });

  function onConnection(ws, user, req) {
    const client = new Client({
      id: `c_${crypto.randomUUID().slice(0, 8)}`,
      ws,
      user,
      bucket: new TokenBucket({ capacity: config.ws.rateBurst, refillPerSec: config.ws.ratePerSec }),
      maxBufferedBytes: config.ws.maxBufferedBytes,
      metrics,
    });
    logger.info('ws connected', { client: client.id, user: user.name, ip: req.socket.remoteAddress });

    ws.on('pong', () => (client.isAlive = true));

    ws.on('message', (data, isBinary) => {
      client.isAlive = true; // any traffic proves liveness
      metrics.countIn();

      if (!client.bucket.take()) {
        client.violations++;
        metrics.countRejected('rate');
        if (client.violations >= config.ws.maxViolations) return client.close(CLOSE.POLICY, 'Rate limit exceeded');
        return client.send(errorReply(peekId(data), 'rate_limited', 'Slow down'));
      }
      if (isBinary) return client.send(errorReply(undefined, 'bad_frame', 'Binary frames are not supported'));

      let msg;
      try {
        msg = parseClientMessage(data);
      } catch (err) {
        if (err instanceof ProtocolError) {
          metrics.countRejected('invalid');
          return client.send(errorReply(err.details?.id, err.code, err.message));
        }
        throw err;
      }
      router.dispatch(client, msg);
    });

    ws.on('close', (code) => {
      logger.info('ws closed', { client: client.id, code });
      hub.remove(client);
    });
    ws.on('error', (err) => logger.warn('ws error', { client: client.id, err: err.message }));

    hub.add(client);
  }

  // Heartbeat sweep: ping everyone; whoever didn't answer the last ping is dead.
  const sweep = setInterval(() => {
    for (const client of hub.clients.values()) {
      if (!client.isAlive) {
        logger.info('heartbeat timeout', { client: client.id });
        client.ws.terminate(); // triggers 'close' -> hub.remove
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, config.ws.heartbeatMs);
  sweep.unref();

  return {
    wss,
    /** Tell clients to reconnect elsewhere, then stop. */
    close() {
      clearInterval(sweep);
      for (const client of hub.clients.values()) client.close(CLOSE.GOING_AWAY, 'Server shutting down');
      wss.close();
    },
  };
}

function peekId(data) {
  // Best-effort: echo the request id so the client can reject the right promise.
  const m = /"id"\s*:\s*"([^"]{1,64})"/.exec(data.toString('utf8', 0, 256));
  return m?.[1];
}
