// examples/11-mediasoup-minimal/config.js
import os from 'node:os';

// On a laptop: announce your LAN IP so other devices can reach you.
// On a cloud VM: set MEDIASOUP_ANNOUNCED_ADDRESS to the PUBLIC IP (ch.12).
function firstLanIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

const env = process.env;
const listenIp = env.MEDIASOUP_LISTEN_IP ?? '0.0.0.0';
const announcedAddress = env.MEDIASOUP_ANNOUNCED_ADDRESS ?? firstLanIPv4();
const portRange = { min: Number(env.MEDIASOUP_MIN_PORT ?? 40000), max: Number(env.MEDIASOUP_MAX_PORT ?? 40100) };

export const config = {
  httpPort: Number(env.PORT ?? 3000),
  // Optional HTTPS so phones on the LAN get a secure context (getUserMedia).
  tls: env.TLS_CERT && env.TLS_KEY ? { cert: env.TLS_CERT, key: env.TLS_KEY } : null,

  // One worker per core in production; 1 is plenty for a single demo room.
  numWorkers: Number(env.MEDIASOUP_NUM_WORKERS ?? 1),
  worker: {
    logLevel: env.MEDIASOUP_LOG_LEVEL ?? 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  },

  router: {
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
      { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2, 'x-google-start-bitrate': 1000 } },
      {
        kind: 'video', mimeType: 'video/H264', clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 },
      },
    ],
  },

  webRtcTransport: {
    listenInfos: [
      { protocol: 'udp', ip: listenIp, announcedAddress, portRange },
      { protocol: 'tcp', ip: listenIp, announcedAddress, portRange },
    ],
    initialAvailableOutgoingBitrate: 1_000_000,
    maxIncomingBitrate: 1_500_000,
  },
};
