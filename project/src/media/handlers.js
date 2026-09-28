// Media signaling. mediasoup does not define a signaling protocol; this file
// IS Huddle's. Each handler is one step of the mediasoup-client dance:
//
//  getRouterRtpCapabilities -> device.load()
//  join                     -> learn peers + existing producers
//  createTransport x2       -> device.createSendTransport / createRecvTransport
//  connectTransport         -> transport 'connect' event (DTLS)
//  produce                  -> sendTransport 'produce' event
//  consume + resumeConsumer -> recvTransport.consume() then resume
import { Room } from './Room.js';
import { Peer } from './Peer.js';
import { ProtocolError } from '../ws/protocol.js';
import { logger } from '../logger.js';

const fail = (code, msg) => {
  throw new ProtocolError(code, msg);
};

export class MediaService {
  rooms = new Map(); // roomId -> Room
  #creating = new Map(); // roomId -> Promise<Room> (dedupe concurrent creates)

  constructor({ pool, config, hub, validateRoom }) {
    this.pool = pool;
    this.config = config;
    this.hub = hub;
    this.validateRoom = validateRoom;

    // A dead worker takes its routers with it: close those rooms so clients rejoin.
    pool.on('workerDied', (worker) => {
      for (const room of this.rooms.values()) if (room.worker === worker) room.close('worker_died');
    });
    hub.on('disconnect', (client) => this.leave(client));
  }

  async getOrCreateRoom(roomId) {
    const existing = this.rooms.get(roomId);
    if (existing && !existing.closed) return existing;
    if (this.#creating.has(roomId)) return this.#creating.get(roomId);

    this.validateRoom(roomId);
    const promise = Room.create({ id: roomId, worker: this.pool.next() })
      .then((room) => {
        this.rooms.set(roomId, room);
        room.on('close', () => {
          if (this.rooms.get(roomId) === room) this.rooms.delete(roomId);
          this.#announce(room);
        });
        logger.info('room created', { room: roomId, workerPid: room.worker.pid });
        return room;
      })
      .finally(() => this.#creating.delete(roomId));
    this.#creating.set(roomId, promise);
    return promise;
  }

  /** Everyone (not only huddle members) sees who is in which huddle. */
  #announce(room) {
    this.hub.broadcast('huddle:update', room.closed ? { roomId: room.id, participants: [] } : room.toJSON());
  }

  huddles() {
    return [...this.rooms.values()].filter((r) => r.peers.size > 0).map((r) => r.toJSON());
  }

  leave(client) {
    const peer = client.peer;
    if (!peer) return;
    client.peer = null;
    const room = peer.room;
    room.removePeer(peer.id);
    if (!room.closed) this.#announce(room);
  }

  #peer(client) {
    return client.peer ?? fail('not_in_room', 'Join a huddle first');
  }

  register(router) {
    router
      .on('media:getRouterRtpCapabilities', async ({ payload }) => {
        const room = await this.getOrCreateRoom(payload.roomId);
        return { rtpCapabilities: room.rtpCapabilities };
      })

      .on('media:join', async ({ client, payload }) => {
        if (client.peer) this.leave(client); // one huddle per connection
        const room = await this.getOrCreateRoom(payload.roomId);
        if (room.peers.size >= this.config.media.maxPeersPerRoom) fail('room_full', 'Huddle is full');
        const peer = new Peer({ client, room });
        peer.rtpCapabilities = payload.rtpCapabilities;
        client.peer = peer;
        room.addPeer(peer);
        this.#announce(room);
        return {
          roomId: room.id,
          peerId: peer.id,
          peers: [...room.peers.values()].filter((p) => p !== peer).map((p) => p.toJSON()),
          producers: room.producersFor(peer.id),
          activeSpeakerId: room.activeSpeakerId,
        };
      })

      .on('media:leave', ({ client }) => {
        this.leave(client);
        return {};
      })

      .on('media:createTransport', async ({ client, payload }) => {
        const peer = this.#peer(client);
        const m = this.config.media;
        const listen = (protocol) => ({
          protocol,
          ip: m.listenIp,
          announcedAddress: m.announcedIp,
          portRange: { min: m.rtcMinPort, max: m.rtcMaxPort },
        });
        const transport = await peer.room.router.createWebRtcTransport({
          listenInfos: [listen('udp'), listen('tcp')],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: m.initialOutgoingBitrate,
          appData: { peerId: peer.id, direction: payload.direction },
        });
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
      })

      .on('media:connectTransport', async ({ client, payload }) => {
        const transport = this.#peer(client).getTransport(payload.transportId) ?? fail('not_found', 'Unknown transport');
        await transport.connect({ dtlsParameters: payload.dtlsParameters });
        return {};
      })

      .on('media:produce', async ({ client, payload }) => {
        const peer = this.#peer(client);
        const transport = peer.getTransport(payload.transportId, 'send') ?? fail('not_found', 'Unknown send transport');
        const producer = await transport.produce({
          kind: payload.kind,
          rtpParameters: payload.rtpParameters,
          appData: { ...payload.appData, peerId: peer.id },
        });
        peer.producers.set(producer.id, producer);
        producer.observer.on('close', () => peer.producers.delete(producer.id));
        if (producer.kind === 'audio') {
          await peer.room.audioLevelObserver.addProducer({ producerId: producer.id }).catch(() => {});
        }
        peer.room.broadcast(
          'media:newProducer',
          { producerId: producer.id, peerId: peer.id, kind: producer.kind, appData: producer.appData, paused: producer.paused },
          peer.id,
        );
        return { producerId: producer.id };
      })

      .on('media:consume', async ({ client, payload }) => {
        const peer = this.#peer(client);
        const { router } = peer.room;
        const transport = peer.getTransport(payload.transportId, 'recv') ?? fail('not_found', 'Unknown recv transport');
        if (!router.canConsume({ producerId: payload.producerId, rtpCapabilities: peer.rtpCapabilities })) {
          fail('cannot_consume', 'Producer gone or codecs incompatible');
        }
        // Start paused: the client resumes once its track is wired up, so no
        // keyframe is wasted on a consumer nobody is rendering yet.
        const consumer = await transport.consume({
          producerId: payload.producerId,
          rtpCapabilities: peer.rtpCapabilities,
          paused: true,
        });
        peer.consumers.set(consumer.id, consumer);
        consumer.observer.on('close', () => peer.consumers.delete(consumer.id));
        consumer.on('producerclose', () => consumer.close());
        consumer.on('producerpause', () => client.event('media:producerPaused', { producerId: consumer.producerId }));
        consumer.on('producerresume', () => client.event('media:producerResumed', { producerId: consumer.producerId }));
        const owner = [...peer.room.peers.values()].find((p) => p.producers.has(consumer.producerId));
        return {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          appData: owner?.producers.get(consumer.producerId)?.appData ?? {},
          peerId: owner?.id,
          producerPaused: consumer.producerPaused,
        };
      })

      .on('media:resumeConsumer', async ({ client, payload }) => {
        const consumer = this.#peer(client).consumers.get(payload.consumerId) ?? fail('not_found', 'Unknown consumer');
        await consumer.resume();
        return {};
      })

      .on('media:pauseProducer', async ({ client, payload }) => {
        const producer = this.#peer(client).producers.get(payload.producerId) ?? fail('not_found', 'Unknown producer');
        await producer.pause();
        return {};
      })

      .on('media:resumeProducer', async ({ client, payload }) => {
        const producer = this.#peer(client).producers.get(payload.producerId) ?? fail('not_found', 'Unknown producer');
        await producer.resume();
        return {};
      })

      .on('media:closeProducer', ({ client, payload }) => {
        const peer = this.#peer(client);
        const producer = peer.producers.get(payload.producerId) ?? fail('not_found', 'Unknown producer');
        producer.close(); // consumers get 'producerclose' and close themselves
        peer.room.broadcast('media:producerClosed', { producerId: producer.id, peerId: peer.id }, peer.id);
        return {};
      });
  }

  stats() {
    let peers = 0;
    let producers = 0;
    let consumers = 0;
    for (const r of this.rooms.values()) {
      for (const p of r.peers.values()) {
        peers++;
        producers += p.producers.size;
        consumers += p.consumers.size;
      }
    }
    return { rooms: this.rooms.size, peers, producers, consumers, workers: this.pool.size };
  }

  close() {
    for (const room of this.rooms.values()) room.close('shutdown');
    this.pool.close();
  }
}
