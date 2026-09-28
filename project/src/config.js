// Centralised, validated configuration. Everything tunable comes from the
// environment so the same build runs on a laptop, a LAN box or a cloud VM.
import os from 'node:os';
import crypto from 'node:crypto';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * Build a config object. `overrides` lets tests inject values without
 * touching process.env.
 */
export function loadConfig(overrides = {}, env = process.env) {
  const isProd = env.NODE_ENV === 'production';

  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    if (isProd) throw new Error('JWT_SECRET must be set in production');
    // Random per-process secret: fine for dev, tokens die on restart.
    jwtSecret = crypto.randomBytes(32).toString('hex');
  }

  const config = {
    env: env.NODE_ENV ?? 'development',
    port: num(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    jwtSecret,
    jwtTtl: env.JWT_TTL ?? '12h',
    ticketTtlMs: num(env.TICKET_TTL_MS, 30_000),

    // Origins allowed to open a WebSocket. Empty = "same host as the page"
    // plus localhost variants (see gateway.isOriginAllowed).
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    // Non-browser clients (CLI, tests) usually send no Origin header.
    allowNoOrigin: bool(env.ALLOW_NO_ORIGIN, true),

    ws: {
      path: '/ws',
      maxPayload: num(env.WS_MAX_PAYLOAD, 64 * 1024),
      heartbeatMs: num(env.HEARTBEAT_MS, 30_000),
      // Token bucket: `burst` tokens, refilled at `ratePerSec`.
      rateBurst: num(env.RATE_BURST, 40),
      ratePerSec: num(env.RATE_PER_SEC, 15),
      maxViolations: num(env.RATE_MAX_VIOLATIONS, 50),
      maxBufferedBytes: num(env.WS_MAX_BUFFERED, 4 * 1024 * 1024),
    },

    chat: {
      historySize: num(env.HISTORY_SIZE, 500),
      historyPage: 50,
      maxChannels: num(env.MAX_CHANNELS, 50),
      typingTtlMs: 6_000,
    },

    media: {
      enabled: bool(env.MEDIA_ENABLED, true),
      numWorkers: num(env.MEDIASOUP_WORKERS, Math.min(os.availableParallelism?.() ?? os.cpus().length, 4)),
      announcedIp: env.MEDIASOUP_ANNOUNCED_IP || undefined,
      listenIp: env.MEDIASOUP_LISTEN_IP ?? '0.0.0.0',
      rtcMinPort: num(env.RTC_MIN_PORT, 40000),
      rtcMaxPort: num(env.RTC_MAX_PORT, 40100),
      logLevel: env.MEDIASOUP_LOG_LEVEL ?? 'warn',
      maxPeersPerRoom: num(env.MAX_PEERS_PER_ROOM, 12),
      initialOutgoingBitrate: 1_000_000,
    },
    ...overrides,
  };

  if (config.media.rtcMinPort > config.media.rtcMaxPort) {
    throw new Error('RTC_MIN_PORT must be <= RTC_MAX_PORT');
  }
  return config;
}
