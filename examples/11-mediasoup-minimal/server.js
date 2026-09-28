// examples/11-mediasoup-minimal/server.js
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as mediasoup from 'mediasoup';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 1. workers
const workers = [];
let nextWorkerIdx = 0;

async function startWorkers() {
  for (let i = 0; i < config.numWorkers; i++) {
    const worker = await mediasoup.createWorker(config.worker);
    worker.on('died', (error) => {
      // A dead worker takes its routers/transports with it. Fail fast; the supervisor restarts us.
      console.error(`[mediasoup] worker pid=${worker.pid} died:`, error);
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(worker);
    console.log(`[mediasoup] worker #${i} pid=${worker.pid} started (mediasoup ${mediasoup.version})`);
  }
}
const getNextWorker = () => workers[nextWorkerIdx++ % workers.length];

// ---------------------------------------------------------------- 2. the (single) room
/** peer = { id, ws, name, joined, rtpCapabilities, transports: Map, producers: Map, consumers: Map } */
const room = { router: null, activeSpeaker: null, peers: new Map() };

async function createRoom() {
  room.router = await getNextWorker().createRouter({ mediaCodecs: config.router.mediaCodecs });
  room.activeSpeaker = await room.router.createActiveSpeakerObserver({ interval: 300 });
  room.activeSpeaker.on('dominantspeaker', ({ producer }) => {
    broadcast('activeSpeaker', { peerId: producer.appData.peerId });
  });
}

// ---------------------------------------------------------------- 3. helpers
function send(ws, type, payload, replyTo) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, id: randomUUID(), payload, ...(replyTo && { replyTo }) }));
}
function broadcast(type, payload, except) {
  for (const peer of room.peers.values()) if (peer.joined && peer !== except) send(peer.ws, type, payload);
}
function getTransport(peer, transportId) {
  const transport = peer.transports.get(transportId); // ownership check: only YOUR transports
  if (!transport) throw new Error(`transport ${transportId} not found`);
  return transport;
}
function findProducer(producerId) {
  for (const peer of room.peers.values()) {
    const producer = peer.producers.get(producerId);
    if (producer) return producer;
  }
  return null;
}

// ---------------------------------------------------------------- 4. request handlers
const PRE_JOIN = new Set(['getRouterRtpCapabilities', 'createWebRtcTransport', 'connectTransport', 'restartIce', 'join']);

const handlers = {
  getRouterRtpCapabilities: () => ({ rtpCapabilities: room.router.rtpCapabilities }),

  async createWebRtcTransport(peer, { direction, sctpCapabilities }) {
    if (direction !== 'send' && direction !== 'recv') throw new Error('direction must be send|recv');
    const { listenInfos, initialAvailableOutgoingBitrate, maxIncomingBitrate } = config.webRtcTransport;
    const transport = await room.router.createWebRtcTransport({
      listenInfos,
      preferUdp: true,
      initialAvailableOutgoingBitrate,
      enableSctp: Boolean(sctpCapabilities),
      numSctpStreams: sctpCapabilities?.numStreams,
      appData: { peerId: peer.id, direction },
    });
    if (direction === 'send') await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    transport.on('dtlsstatechange', (state) => {
      if (state === 'failed' || state === 'closed') transport.close();
    });
    transport.observer.on('close', () => peer.transports.delete(transport.id));
    peer.transports.set(transport.id, transport);
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  },

  async connectTransport(peer, { transportId, dtlsParameters }) {
    await getTransport(peer, transportId).connect({ dtlsParameters });
    return {};
  },

  async restartIce(peer, { transportId }) {
    return { iceParameters: await getTransport(peer, transportId).restartIce() };
  },

  join(peer, { name, rtpCapabilities }) {
    if (peer.joined) throw new Error('already joined');
    peer.name = String(name ?? 'anon').slice(0, 32);
    peer.rtpCapabilities = rtpCapabilities; // needed for canConsume/consume
    peer.joined = true;

    const others = [...room.peers.values()].filter((p) => p.joined && p !== peer);
    broadcast('peerJoined', { peerId: peer.id, name: peer.name }, peer);
    return {
      peerId: peer.id,
      peers: others.map((p) => ({ peerId: p.id, name: p.name })),
      producers: others.flatMap((p) =>
        [...p.producers.values()].map((pr) => ({ producerId: pr.id, peerId: p.id, kind: pr.kind }))),
    };
  },

  async produce(peer, { transportId, kind, rtpParameters, appData = {} }) {
    if (kind !== 'audio' && kind !== 'video') throw new Error('bad kind');
    const producer = await getTransport(peer, transportId).produce({
      kind, rtpParameters, appData: { ...appData, peerId: peer.id },
    });
    peer.producers.set(producer.id, producer);
    producer.observer.on('close', () => peer.producers.delete(producer.id));
    if (kind === 'audio') await room.activeSpeaker.addProducer({ producerId: producer.id });
    broadcast('newProducer', { producerId: producer.id, peerId: peer.id, kind }, peer);
    return { id: producer.id };
  },

  async consume(peer, { transportId, producerId }) {
    const producer = findProducer(producerId);
    if (!producer) throw new Error('producer not found');
    if (!room.router.canConsume({ producerId, rtpCapabilities: peer.rtpCapabilities })) {
      throw new Error('cannot consume: no common codec');
    }
    const consumer = await getTransport(peer, transportId).consume({
      producerId,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true, // resume after the client has set up its side (section 2.4)
      appData: { peerId: producer.appData.peerId },
    });
    peer.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => send(peer.ws, 'consumerClosed', { consumerId: consumer.id }));
    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      peerId: producer.appData.peerId,
    };
  },

  async resumeConsumer(peer, { consumerId }) {
    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new Error('consumer not found');
    await consumer.resume(); // → mediasoup asks the producer for a keyframe
    return {};
  },

  async pauseProducer(peer, { producerId }) {
    await peer.producers.get(producerId)?.pause();
    return {};
  },

  async resumeProducer(peer, { producerId }) {
    await peer.producers.get(producerId)?.resume();
    return {};
  },

  async setConsumerPreferredLayers(peer, { consumerId, spatialLayer, temporalLayer }) {
    const consumer = peer.consumers.get(consumerId);
    if (consumer?.type !== 'simulcast' && consumer?.type !== 'svc') return {};
    await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
    return {};
  },
};

// ---------------------------------------------------------------- 5. HTTP + WebSocket
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Tiny monitoring endpoint (ch.12): worker CPU + object counts.
app.get('/stats', async (_req, res) => {
  const peers = [...room.peers.values()];
  res.json({
    peers: peers.length,
    producers: peers.reduce((n, p) => n + p.producers.size, 0),
    consumers: peers.reduce((n, p) => n + p.consumers.size, 0),
    workers: await Promise.all(workers.map(async (w) => {
      const u = await w.getResourceUsage();
      return { pid: w.pid, cpuUserMs: u.ru_utime, cpuSystemMs: u.ru_stime, maxRssKb: u.ru_maxrss };
    })),
  });
});

const server = config.tls
  ? https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, app)
  : http.createServer(app);

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  // Production: authenticate here (ch.6) before handing the socket over.
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const peer = {
    id: randomUUID(), ws, name: 'anon', joined: false, rtpCapabilities: null,
    transports: new Map(), producers: new Map(), consumers: new Map(),
  };
  room.peers.set(peer.id, peer);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, 'error', { message: 'bad json' }); }
    const { type, id, payload = {} } = msg;
    try {
      const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
      if (!handler) throw new Error(`unknown request "${type}"`);
      if (!peer.joined && !PRE_JOIN.has(type)) throw new Error('join first');
      const result = await handler(peer, payload);
      send(ws, type, result, id);
    } catch (err) {
      send(ws, 'error', { message: err.message }, id);
    }
  });

  ws.on('close', () => {
    room.peers.delete(peer.id);
    // Cascade: transport.close() → its producers/consumers close → other peers'
    // consumers of our producers emit 'producerclose' → they get consumerClosed.
    for (const transport of peer.transports.values()) transport.close();
    if (peer.joined) broadcast('peerLeft', { peerId: peer.id });
  });
});

// ---------------------------------------------------------------- 6. boot + graceful shutdown
await startWorkers();
await createRoom();
server.listen(config.httpPort, () => {
  const { listenInfos } = config.webRtcTransport;
  console.log(`[ex11] http${config.tls ? 's' : ''}://localhost:${config.httpPort}  ` +
    `(announcing ${listenInfos[0].announcedAddress}, rtc ports ${listenInfos[0].portRange.min}-${listenInfos[0].portRange.max})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const w of workers) w.close();
    server.close();
    process.exit(0);
  });
}
