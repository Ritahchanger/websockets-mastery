// HuddleMedia — the browser half of mediasoup signaling.
//
// One Device, one send transport, one recv transport per huddle. Every
// mediasoup-client callback that needs the server ('connect', 'produce') is
// bridged to a socket.request(). Server notifications drive consume/cleanup.
//
// Events: joined, left, peerJoined, peerLeft, track, trackEnded, trackPaused,
// trackResumed, activeSpeaker, localTrack, localTrackEnded, error.
import { Device } from 'mediasoup-client';

// Simulcast: 3 layers so the SFU can forward a smaller one to weak receivers.
const CAM_ENCODINGS = [
  { rid: 'r0', maxBitrate: 120_000, scaleResolutionDownBy: 4 },
  { rid: 'r1', maxBitrate: 350_000, scaleResolutionDownBy: 2 },
  { rid: 'r2', maxBitrate: 1_000_000, scaleResolutionDownBy: 1 },
];

export class HuddleMedia extends EventTarget {
  device = null;
  roomId = null;
  sendTransport = null;
  recvTransport = null;
  producers = new Map(); // source ('mic'|'cam'|'screen') -> Producer
  consumers = new Map(); // consumerId -> { consumer, peerId, source }
  #unsubs = [];
  #ready = null; // resolves when recv transport exists (consumes wait on it)

  constructor(socket) {
    super();
    this.socket = socket;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get active() {
    return this.roomId !== null;
  }

  async join(roomId) {
    if (this.active) await this.leave();
    this.roomId = roomId;
    const s = this.socket;
    let markReady;
    this.#ready = new Promise((r) => (markReady = r));

    // Listen before joining so no notification slips between join and listen.
    this.#unsubs = [
      s.on('media:newProducer', (p) => this.#consume(p.producerId).catch((e) => this.#emit('error', e))),
      s.on('media:producerClosed', ({ producerId }) => this.#dropConsumer((c) => c.consumer.producerId === producerId)),
      s.on('media:peerJoined', ({ peer }) => this.#emit('peerJoined', peer)),
      s.on('media:peerLeft', ({ peerId }) => {
        this.#dropConsumer((c) => c.peerId === peerId);
        this.#emit('peerLeft', { peerId });
      }),
      s.on('media:producerPaused', ({ producerId }) => this.#emitForProducer('trackPaused', producerId)),
      s.on('media:producerResumed', ({ producerId }) => this.#emitForProducer('trackResumed', producerId)),
      s.on('media:activeSpeaker', ({ peerId }) => this.#emit('activeSpeaker', { peerId })),
      s.on('media:roomClosed', ({ reason }) => this.#teardown(reason)),
    ];

    try {
      // 1. What codecs does the router speak?  2. Load the device with them.
      const { rtpCapabilities } = await s.request('media:getRouterRtpCapabilities', { roomId });
      this.device = new Device();
      await this.device.load({ routerRtpCapabilities: rtpCapabilities });

      // 3. Join, telling the server what *we* can receive.
      const joined = await s.request('media:join', { roomId, rtpCapabilities: this.device.rtpCapabilities });
      this.peerId = joined.peerId;

      // 4. Two transports: one up, one down.
      this.sendTransport = await this.#createTransport('send');
      this.recvTransport = await this.#createTransport('recv');
      markReady();

      this.#emit('joined', { roomId, peerId: joined.peerId, peers: joined.peers });
      for (const peer of joined.peers) this.#emit('peerJoined', peer);
      if (joined.activeSpeakerId) this.#emit('activeSpeaker', { peerId: joined.activeSpeakerId });

      // 5. Consume everything that was already being produced.
      await Promise.allSettled(joined.producers.map((p) => this.#consume(p.producerId)));
    } catch (err) {
      markReady(); // unblock queued consumes; they see no transport and bail
      await this.leave({ silent: true });
      throw err;
    }
  }

  async #createTransport(direction) {
    const params = await this.socket.request('media:createTransport', { direction });
    const transport =
      direction === 'send' ? this.device.createSendTransport(params) : this.device.createRecvTransport(params);

    // Fires on first produce/consume: hand DTLS fingerprints to the server.
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.socket
        .request('media:connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback(), errback);
    });

    if (direction === 'send') {
      // Fires inside transport.produce(): server creates the Producer, returns its id.
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        this.socket
          .request('media:produce', { transportId: transport.id, kind, rtpParameters, appData })
          .then(({ producerId }) => callback({ id: producerId }), errback);
      });
    }

    transport.on('connectionstatechange', (state) => {
      if (state === 'failed') this.#emit('error', new Error(`${direction} transport failed (firewall/UDP blocked?)`));
    });
    return transport;
  }

  async #consume(producerId) {
    await this.#ready;
    if (!this.recvTransport) return;
    const data = await this.socket.request('media:consume', { transportId: this.recvTransport.id, producerId });
    const consumer = await this.recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });
    const entry = { consumer, peerId: data.peerId, source: data.appData.source ?? data.kind };
    this.consumers.set(consumer.id, entry);
    consumer.on('trackended', () => this.#dropConsumer((c) => c.consumer === consumer));
    this.#emit('track', { ...entry, track: consumer.track, paused: data.producerPaused });
    // Server created it paused; resume now that we're ready to render.
    await this.socket.request('media:resumeConsumer', { consumerId: consumer.id });
  }

  #dropConsumer(match) {
    for (const [id, entry] of this.consumers) {
      if (!match(entry)) continue;
      entry.consumer.close();
      this.consumers.delete(id);
      this.#emit('trackEnded', { peerId: entry.peerId, source: entry.source, kind: entry.consumer.kind });
    }
  }

  #emitForProducer(type, producerId) {
    for (const entry of this.consumers.values()) {
      if (entry.consumer.producerId === producerId) this.#emit(type, { peerId: entry.peerId, source: entry.source });
    }
  }

  // ---- local media -------------------------------------------------------

  async #produce(source, track, options = {}) {
    const producer = await this.sendTransport.produce({ track, appData: { source }, ...options });
    this.producers.set(source, producer);
    producer.on('trackended', () => this.stop(source)); // e.g. "Stop sharing" browser button
    this.#emit('localTrack', { source, track, producer });
    return producer;
  }

  async startMic() {
    if (this.producers.has('mic')) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await this.#produce('mic', stream.getAudioTracks()[0], { codecOptions: { opusStereo: false, opusDtx: true } });
  }

  async startCam() {
    if (this.producers.has('cam')) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    await this.#produce('cam', stream.getVideoTracks()[0], { encodings: CAM_ENCODINGS, codecOptions: { videoGoogleStartBitrate: 1000 } });
  }

  async startScreen() {
    if (this.producers.has('screen')) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    await this.#produce('screen', stream.getVideoTracks()[0]);
  }

  /** Mute = pause (instant, keeps the mic open). Server pauses forwarding too. */
  async setMicMuted(muted) {
    const p = this.producers.get('mic');
    if (!p) return;
    if (muted) p.pause();
    else p.resume();
    await this.socket.request(muted ? 'media:pauseProducer' : 'media:resumeProducer', { producerId: p.id });
  }

  /** Stop = close the producer and release the device (camera light goes off). */
  async stop(source) {
    const p = this.producers.get(source);
    if (!p) return;
    this.producers.delete(source);
    p.track?.stop();
    p.close();
    this.#emit('localTrackEnded', { source });
    await this.socket.request('media:closeProducer', { producerId: p.id }).catch(() => {});
  }

  async leave({ silent = false } = {}) {
    if (!this.active) return;
    if (this.socket.state === 'open') await this.socket.request('media:leave').catch(() => {});
    this.#teardown(silent ? null : 'left');
  }

  #teardown(reason) {
    if (!this.active) return;
    for (const unsub of this.#unsubs) unsub();
    this.#unsubs = [];
    for (const p of this.producers.values()) {
      p.track?.stop();
      p.close();
    }
    this.producers.clear();
    for (const { consumer } of this.consumers.values()) consumer.close();
    this.consumers.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = this.recvTransport = this.device = null;
    const roomId = this.roomId;
    this.roomId = null;
    if (reason) this.#emit('left', { roomId, reason });
  }
}
