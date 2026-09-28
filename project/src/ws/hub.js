// Connection registry. A `Client` is one WebSocket; a user may have several
// (two tabs, phone + laptop). The hub knows both views.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { envelope } from './protocol.js';
import { logger } from '../logger.js';

export class Client {
  constructor({ id, ws, user, bucket, maxBufferedBytes, metrics }) {
    this.id = id;
    this.ws = ws;
    this.user = user;
    this.bucket = bucket;
    this.isAlive = true;
    this.violations = 0;
    this.channels = new Set(); // channel ids this connection is subscribed to
    this.connectedAt = Date.now();
    this.maxBufferedBytes = maxBufferedBytes;
    this.metrics = metrics;
  }

  /** Send an envelope. Slow consumers are cut off instead of eating RAM. */
  send(msg) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      logger.warn('slow consumer, terminating', { client: this.id, buffered: this.ws.bufferedAmount });
      this.ws.terminate();
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    this.metrics?.countOut();
    return true;
  }

  event(type, payload) {
    return this.send(envelope(type, payload));
  }

  close(code, reason) {
    this.ws.close(code, reason);
  }
}

export class Hub extends EventEmitter {
  clients = new Map(); // clientId -> Client
  #byUser = new Map(); // userId -> Set<Client>

  add(client) {
    this.clients.set(client.id, client);
    let set = this.#byUser.get(client.user.id);
    const firstForUser = !set;
    if (!set) this.#byUser.set(client.user.id, (set = new Set()));
    set.add(client);
    this.emit('connect', client, { firstForUser });
  }

  remove(client) {
    if (!this.clients.delete(client.id)) return;
    const set = this.#byUser.get(client.user.id);
    set?.delete(client);
    const lastForUser = !set || set.size === 0;
    if (lastForUser) this.#byUser.delete(client.user.id);
    this.emit('disconnect', client, { lastForUser });
  }

  connectionsOf(userId) {
    return this.#byUser.get(userId) ?? new Set();
  }

  get users() {
    return [...this.#byUser.values()].map((set) => set.values().next().value.user);
  }

  /** Push an event to every client matching `filter` (default: everyone). */
  broadcast(type, payload, filter = () => true) {
    const msg = envelope(type, payload);
    // Serialise once, fan out many: the hot path of any chat server.
    const data = JSON.stringify(msg);
    let n = 0;
    for (const c of this.clients.values()) {
      if (!filter(c) || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.ws.bufferedAmount > c.maxBufferedBytes) {
        c.ws.terminate();
        continue;
      }
      c.ws.send(data);
      c.metrics?.countOut();
      n++;
    }
    return n;
  }
}
