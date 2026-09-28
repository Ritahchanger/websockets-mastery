// A Room is one huddle (one per channel) = one mediasoup Router on one Worker.
// It tracks its Peers and runs an AudioLevelObserver for active-speaker.
import { EventEmitter } from 'node:events';
import { mediaCodecs } from './codecs.js';
import { logger } from '../logger.js';

export class Room extends EventEmitter {
  peers = new Map(); // peerId -> Peer
  activeSpeakerId = null;
  closed = false;

  static async create({ id, worker }) {
    const router = await worker.createRouter({ mediaCodecs, appData: { roomId: id } });
    const audioLevelObserver = await router.createAudioLevelObserver({ maxEntries: 1, threshold: -65, interval: 700 });
    return new Room({ id, worker, router, audioLevelObserver });
  }

  constructor({ id, worker, router, audioLevelObserver }) {
    super();
    this.id = id;
    this.worker = worker;
    this.router = router;
    this.audioLevelObserver = audioLevelObserver;
    this.createdAt = Date.now();

    audioLevelObserver.on('volumes', ([{ producer, volume }]) => {
      const peerId = producer.appData.peerId;
      if (peerId === this.activeSpeakerId) return;
      this.activeSpeakerId = peerId;
      this.broadcast('media:activeSpeaker', { peerId, volume });
    });
    audioLevelObserver.on('silence', () => {
      if (this.activeSpeakerId === null) return;
      this.activeSpeakerId = null;
      this.broadcast('media:activeSpeaker', { peerId: null });
    });
  }

  get rtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  /** Every producer in the room except `exceptPeerId`'s own. */
  producersFor(exceptPeerId) {
    const list = [];
    for (const peer of this.peers.values()) {
      if (peer.id === exceptPeerId) continue;
      for (const p of peer.producers.values()) {
        list.push({ producerId: p.id, peerId: peer.id, kind: p.kind, appData: p.appData, paused: p.paused });
      }
    }
    return list;
  }

  broadcast(type, payload, exceptPeerId) {
    for (const peer of this.peers.values()) if (peer.id !== exceptPeerId) peer.client.event(type, payload);
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    this.broadcast('media:peerJoined', { peer: peer.toJSON() }, peer.id);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const producerIds = [...peer.producers.keys()];
    peer.close();
    this.peers.delete(peerId);
    this.broadcast('media:peerLeft', { peerId, producerIds });
    if (this.activeSpeakerId === peerId) this.activeSpeakerId = null;
    if (this.peers.size === 0) this.close('empty');
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    if (reason !== 'empty') this.broadcast('media:roomClosed', { roomId: this.id, reason });
    for (const peer of this.peers.values()) {
      peer.close();
      peer.client.peer = null;
    }
    this.peers.clear();
    this.router.close();
    logger.info('room closed', { room: this.id, reason });
    this.emit('close');
  }

  toJSON() {
    return { roomId: this.id, participants: [...this.peers.values()].map((p) => p.user) };
  }
}
