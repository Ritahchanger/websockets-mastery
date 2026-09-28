// Channels own their history. Messages get a per-channel, monotonically
// increasing `seq` — the cursor clients use to resync after a reconnect.
import crypto from 'node:crypto';
import { RingBuffer } from './ringBuffer.js';
import { ProtocolError } from '../ws/protocol.js';

export class Channel {
  seq = 0;
  members = new Set(); // Client objects currently subscribed
  #recentClientIds = new Map(); // clientMsgId -> message (idempotency)

  constructor({ id, name, topic = '', createdBy = null, historySize }) {
    this.id = id;
    this.name = name;
    this.topic = topic;
    this.createdBy = createdBy;
    this.createdAt = Date.now();
    this.history = new RingBuffer(historySize);
  }

  append({ user, text, clientMsgId }) {
    const dedupKey = clientMsgId && `${user.id}:${clientMsgId}`;
    if (dedupKey && this.#recentClientIds.has(dedupKey)) {
      return { message: this.#recentClientIds.get(dedupKey), duplicate: true };
    }
    const message = {
      id: crypto.randomUUID(),
      seq: ++this.seq,
      channelId: this.id,
      user: { id: user.id, name: user.name, color: user.color },
      text,
      ts: Date.now(),
      reactions: {}, // emoji -> [userId]
    };
    this.history.push(message);
    if (dedupKey) {
      this.#recentClientIds.set(dedupKey, message);
      if (this.#recentClientIds.size > 1000) this.#recentClientIds.delete(this.#recentClientIds.keys().next().value);
    }
    return { message, duplicate: false };
  }

  /** Messages with seq > since. `gap` = some were already evicted. */
  since(since, max) {
    const all = this.history.toArray().filter((m) => m.seq > since);
    const oldest = this.history.at(0)?.seq ?? this.seq + 1;
    return { messages: all.slice(-max), gap: since + 1 < oldest || all.length > max };
  }

  before(beforeSeq, limit) {
    const all = this.history.toArray().filter((m) => m.seq < beforeSeq);
    return all.slice(-limit);
  }

  toggleReaction(messageId, emoji, userId) {
    const msg = this.history.find((m) => m.id === messageId);
    if (!msg) throw new ProtocolError('not_found', 'Message not found (maybe too old)');
    const users = (msg.reactions[emoji] ??= []);
    const i = users.indexOf(userId);
    if (i >= 0) users.splice(i, 1);
    else users.push(userId);
    if (users.length === 0) delete msg.reactions[emoji];
    return msg;
  }

  toJSON() {
    return { id: this.id, name: this.name, topic: this.topic, createdAt: this.createdAt, lastSeq: this.seq };
  }
}

export class ChannelStore {
  #channels = new Map();

  constructor({ historySize, maxChannels }) {
    this.historySize = historySize;
    this.maxChannels = maxChannels;
    this.create({ name: 'general', topic: 'Company-wide announcements and chatter' });
    this.create({ name: 'random', topic: 'Non-work banter and water-cooler talk' });
    this.create({ name: 'engineering', topic: 'Ship it. WebSockets, WebRTC, and friends' });
  }

  create({ name, topic, createdBy }) {
    if (this.#channels.has(name)) throw new ProtocolError('exists', `#${name} already exists`);
    if (this.#channels.size >= this.maxChannels) throw new ProtocolError('limit', 'Too many channels');
    const ch = new Channel({ id: name, name, topic, createdBy, historySize: this.historySize });
    this.#channels.set(ch.id, ch);
    return ch;
  }

  get(id) {
    const ch = this.#channels.get(id);
    if (!ch) throw new ProtocolError('not_found', `No channel #${id}`);
    return ch;
  }

  list() {
    return [...this.#channels.values()];
  }
}
