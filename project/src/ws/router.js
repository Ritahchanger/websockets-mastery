// Message router: maps `type` -> async handler, turns return values into
// replies and thrown errors into error frames. Handlers never touch JSON.
import { ProtocolError, reply, errorReply } from './protocol.js';
import { logger } from '../logger.js';

export class MessageRouter {
  #handlers = new Map();

  /**
   * Register a handler. `handler(ctx)` receives { client, payload, id, type }
   * and may return a value (sent as the reply payload) or throw a
   * ProtocolError (sent as an error frame).
   * `{ notify: true }` marks fire-and-forget messages (typing): no success
   * reply is sent, only errors.
   */
  on(type, handler, { notify = false } = {}) {
    if (this.#handlers.has(type)) throw new Error(`Handler for ${type} already registered`);
    this.#handlers.set(type, { handler, notify });
    return this;
  }

  has(type) {
    return this.#handlers.has(type);
  }

  get types() {
    return [...this.#handlers.keys()];
  }

  async dispatch(client, msg) {
    const entry = this.#handlers.get(msg.type);
    if (!entry) {
      client.send(errorReply(msg.id, 'not_implemented', `No handler for ${msg.type}`));
      return;
    }
    try {
      const result = await entry.handler({ client, payload: msg.payload, id: msg.id, type: msg.type });
      // Every request gets exactly one answer; notifications only on failure.
      if (!entry.notify) client.send(reply(msg.id, result ?? {}));
    } catch (err) {
      if (err instanceof ProtocolError) {
        client.send(errorReply(msg.id, err.code, err.message));
      } else {
        logger.error('handler crashed', { type: msg.type, err: err.stack ?? String(err) });
        client.send(errorReply(msg.id, 'internal', 'Internal server error'));
      }
    }
  }
}
