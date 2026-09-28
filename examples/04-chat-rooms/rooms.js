// examples/04-chat-rooms/rooms.js
//
// RoomManager: the classic Map<roomName, Set<client>> with a reverse index
// (client.rooms) and a small in-memory history per room.
//
// A "client" here is our per-connection object (see server.js):
//   { id, nick, ws, rooms: Set<string>, typing: Map<string, Timeout>, send(msg) }

import { WebSocket } from 'ws';

const HISTORY_LIMIT = 50;

export class RoomManager {
  /** @type {Map<string, { name: string, members: Set<object>, history: object[], permanent: boolean }>} */
  #rooms = new Map();

  constructor(permanentRooms = []) {
    for (const name of permanentRooms) this.#create(name, true);
  }

  #create(name, permanent = false) {
    const room = { name, members: new Set(), history: [], permanent };
    this.#rooms.set(name, room);
    return room;
  }

  has(name) {
    return this.#rooms.has(name);
  }

  /** Add client to room (creating it if needed). Returns the room. */
  join(name, client) {
    const room = this.#rooms.get(name) ?? this.#create(name);
    room.members.add(client);
    client.rooms.add(name); // reverse index
    return room;
  }

  /** Remove client from room. Deletes non-permanent empty rooms. Returns true if room was deleted. */
  leave(name, client) {
    const room = this.#rooms.get(name);
    client.rooms.delete(name);
    if (!room) return false;
    room.members.delete(client);
    if (room.members.size === 0 && !room.permanent) {
      this.#rooms.delete(name); // don't leak empty rooms
      return true;
    }
    return false;
  }

  isMember(name, client) {
    return this.#rooms.get(name)?.members.has(client) ?? false;
  }

  /** Public member info, sorted by nick. */
  members(name) {
    const room = this.#rooms.get(name);
    if (!room) return [];
    return [...room.members]
      .map((c) => ({ id: c.id, nick: c.nick }))
      .sort((a, b) => a.nick.localeCompare(b.nick));
  }

  addToHistory(name, message) {
    const room = this.#rooms.get(name);
    if (!room) return;
    room.history.push(message);
    if (room.history.length > HISTORY_LIMIT) room.history.shift(); // simple ring buffer
  }

  history(name) {
    return [...(this.#rooms.get(name)?.history ?? [])];
  }

  /** Summary for the room list sidebar. */
  list() {
    return [...this.#rooms.values()]
      .map((r) => ({ name: r.name, count: r.members.size, permanent: r.permanent }))
      .sort((a, b) => Number(b.permanent) - Number(a.permanent) || a.name.localeCompare(b.name));
  }

  /**
   * Send `message` to every member of `name`, optionally excluding one client.
   * Serializes ONCE, skips sockets that aren't OPEN.
   */
  broadcast(name, message, { except } = {}) {
    const room = this.#rooms.get(name);
    if (!room) return 0;
    const data = JSON.stringify(message);
    let sent = 0;
    for (const client of room.members) {
      if (client !== except && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
        sent++;
      }
    }
    return sent;
  }
}
