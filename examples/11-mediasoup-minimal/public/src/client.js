// examples/11-mediasoup-minimal/public/src/client.js
import { Device } from 'mediasoup-client';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const displayName = params.get('name') ?? `guest-${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------- signaling (ch.4 request/response)
let ws;
const pending = new Map(); // request id -> { resolve, reject }
const notifications = {};  // type -> handler

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onclose = () => setStatus('disconnected — reload to rejoin');
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.replyTo) {
        const p = pending.get(msg.replyTo);
        if (!p) return;
        pending.delete(msg.replyTo);
        return msg.type === 'error' ? p.reject(new Error(msg.payload.message)) : p.resolve(msg.payload);
      }
      notifications[msg.type]?.(msg.payload);
    };
  });
}

function request(type, payload = {}, timeoutMs = 10_000) {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type, id, payload }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${type} timed out`)); }, timeoutMs);
  });
}

// ---------------------------------------------------------------- mediasoup-client state
let device, sendTransport, recvTransport;
const producers = new Map(); // kind -> Producer
const consumers = new Map(); // consumerId -> { consumer, peerId }
const tiles = new Map();     // peerId -> { figure, video, caption, stream }
const names = new Map();     // peerId -> display name

async function createTransport(direction) {
  const params = await request('createWebRtcTransport', { direction, sctpCapabilities: device.sctpCapabilities });
  const transport = direction === 'send' ? device.createSendTransport(params) : device.createRecvTransport(params);

  // Fired once, on first produce()/consume(): hand our DTLS parameters to the server.
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    request('connectTransport', { transportId: transport.id, dtlsParameters }).then(callback, errback);
  });

  if (direction === 'send') {
    // Fired on every produce(): server creates the Producer and tells us its id.
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      request('produce', { transportId: transport.id, kind, rtpParameters, appData })
        .then(({ id }) => callback({ id }), errback);
    });
  }

  transport.on('connectionstatechange', async (state) => {
    console.log(`[${direction}] ${state}`);
    if (state === 'failed') {
      const { iceParameters } = await request('restartIce', { transportId: transport.id });
      await transport.restartIce({ iceParameters });
    }
  });
  return transport;
}

async function consume({ producerId, peerId }) {
  const { id, kind, rtpParameters } = await request('consume', { transportId: recvTransport.id, producerId });
  const consumer = await recvTransport.consume({ id, producerId, kind, rtpParameters });
  consumers.set(consumer.id, { consumer, peerId });

  const tile = ensureTile(peerId);
  tile.stream.addTrack(consumer.track);
  tile.video.srcObject = tile.stream;

  await request('resumeConsumer', { consumerId: consumer.id }); // server was holding it paused
  if (kind === 'video') await applyQuality(consumer.id);
}

async function publish() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } },
  });
  $('#local').srcObject = stream;

  if (device.canProduce('audio')) {
    producers.set('audio', await sendTransport.produce({
      track: stream.getAudioTracks()[0],
      codecOptions: { opusDtx: true, opusFec: true },
      appData: { source: 'mic' },
    }));
  }
  if (device.canProduce('video')) {
    producers.set('video', await sendTransport.produce({
      track: stream.getVideoTracks()[0],
      // Simulcast: 3 spatial layers (180p/360p/720p), each with 3 temporal layers.
      encodings: [
        { scaleResolutionDownBy: 4, maxBitrate: 150_000, scalabilityMode: 'L1T3' },
        { scaleResolutionDownBy: 2, maxBitrate: 500_000, scalabilityMode: 'L1T3' },
        { scaleResolutionDownBy: 1, maxBitrate: 1_200_000, scalabilityMode: 'L1T3' },
      ],
      codecOptions: { videoGoogleStartBitrate: 1000 },
      appData: { source: 'cam' },
    }));
  }
}

async function toggleProducer(kind, button, [onLabel, offLabel]) {
  const producer = producers.get(kind);
  if (!producer) return;
  if (producer.paused) {
    producer.resume();
    await request('resumeProducer', { producerId: producer.id });
    button.textContent = onLabel;
  } else {
    producer.pause();
    await request('pauseProducer', { producerId: producer.id }); // server stops forwarding too
    button.textContent = offLabel;
  }
}

async function applyQuality(consumerId) {
  await request('setConsumerPreferredLayers', { consumerId, spatialLayer: Number($('#quality').value) });
}

// ---------------------------------------------------------------- server notifications
Object.assign(notifications, {
  peerJoined: ({ peerId, name }) => { names.set(peerId, name); ensureTile(peerId); },
  peerLeft: ({ peerId }) => { tiles.get(peerId)?.figure.remove(); tiles.delete(peerId); },
  newProducer: (p) => consume(p).catch((err) => console.error('consume failed', err)),
  consumerClosed: ({ consumerId }) => {
    const entry = consumers.get(consumerId);
    if (!entry) return;
    entry.consumer.close();
    tiles.get(entry.peerId)?.stream.removeTrack(entry.consumer.track);
    consumers.delete(consumerId);
  },
  activeSpeaker: ({ peerId }) => {
    for (const [id, tile] of tiles) tile.figure.classList.toggle('speaking', id === peerId);
  },
});

// ---------------------------------------------------------------- UI
function ensureTile(peerId) {
  if (tiles.has(peerId)) return tiles.get(peerId);
  const figure = document.createElement('figure');
  const video = Object.assign(document.createElement('video'), { autoplay: true, playsInline: true });
  const caption = Object.assign(document.createElement('figcaption'), { textContent: names.get(peerId) ?? peerId.slice(0, 6) });
  figure.append(video, caption);
  $('#grid').append(figure);
  const tile = { figure, video, caption, stream: new MediaStream() };
  tiles.set(peerId, tile);
  return tile;
}
const setStatus = (text) => ($('#status').textContent = text);

$('#join').onclick = async () => {
  $('#join').disabled = true;
  try {
    setStatus('connecting…');
    await connect();

    // 1. Router capabilities → load the Device
    const { rtpCapabilities } = await request('getRouterRtpCapabilities');
    device = await Device.factory();
    await device.load({ routerRtpCapabilities: rtpCapabilities });

    // 2. One transport per direction
    sendTransport = await createTransport('send');
    recvTransport = await createTransport('recv');

    // 3. Join: tell the server what we can receive, learn who's here
    const joined = await request('join', { name: displayName, rtpCapabilities: device.recvRtpCapabilities });
    tiles.set(joined.peerId, { figure: $('#local-tile'), stream: new MediaStream() }); // for speaker highlight
    for (const p of joined.peers) { names.set(p.peerId, p.name); ensureTile(p.peerId); }

    // 4. Consume everything already being produced, then 5. publish our own tracks
    await Promise.all(joined.producers.map(consume));
    await publish();

    setStatus(`joined as ${displayName}`);
    for (const id of ['#mic', '#cam', '#quality']) $(id).disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(`error: ${err.message}`);
  }
};

$('#mic').onclick = () => toggleProducer('audio', $('#mic'), ['Mute mic', 'Unmute mic']);
$('#cam').onclick = () => toggleProducer('video', $('#cam'), ['Stop cam', 'Start cam']);
$('#quality').onchange = () => {
  for (const [id, { consumer }] of consumers) if (consumer.kind === 'video') applyQuality(id);
};
