// A Peer is one WebSocket connection inside one Room. It owns its transports;
// closing a transport closes its producers and consumers, so Peer.close()
// cascades and leaks nothing.
export class Peer {
  transports = new Map(); // id -> WebRtcTransport
  producers = new Map(); // id -> Producer
  consumers = new Map(); // id -> Consumer
  rtpCapabilities = null;

  constructor({ client, room }) {
    this.id = client.id;
    this.user = client.user;
    this.client = client;
    this.room = room;
  }

  getTransport(id, direction) {
    const t = this.transports.get(id);
    if (!t || (direction && t.appData.direction !== direction)) return null;
    return t;
  }

  toJSON() {
    return { id: this.id, user: this.user };
  }

  close() {
    for (const t of this.transports.values()) t.close();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }
}
