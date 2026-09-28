// HuddleSocket — a resilient WebSocket client.
//
//  * reconnects forever with exponential backoff + full jitter
//  * fetches a fresh one-time ticket before every (re)connect
//  * request(type, payload) -> Promise resolved by the matching `replyTo`
//  * queues requests while offline, rejects them on timeout
//  * app-level ping detects dead connections the browser hasn't noticed
//  * emits 'open' with { reconnected } so the app can resync
//
// Events (EventTarget): state, open, close, message, reconnecting, fatal,
// latency, and one event per server message type (e.g. 'chat:message').

export class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export class HuddleSocket extends EventTarget {
  #ws = null;
  #pending = new Map(); // id -> { resolve, reject, timer, frame }
  #outbox = []; // frames waiting for an open socket
  #attempt = 0;
  #everOpened = false;
  #stopped = false;
  #reconnectTimer = null;
  #pingTimer = null;

  /**
   * @param {object} opts
   * @param {() => Promise<string>} opts.getUrl  resolves the ws:// URL (with a fresh ticket)
   */
  constructor({ getUrl, requestTimeoutMs = 10_000, baseDelayMs = 500, maxDelayMs = 15_000, pingIntervalMs = 15_000 }) {
    super();
    this.getUrl = getUrl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.pingIntervalMs = pingIntervalMs;
    this.state = 'idle';

    // Networks come back before backoff timers fire; skip the wait.
    globalThis.addEventListener?.('online', () => this.reconnectNow());
    globalThis.document?.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  // ---- public API ---------------------------------------------------------

  connect() {
    this.#stopped = false;
    if (this.state === 'idle' || this.state === 'closed') this.#open();
    return this;
  }

  close() {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopPing();
    this.#ws?.close(1000, 'bye');
    this.#failPending('closed', 'Socket closed');
    this.#setState('closed');
  }

  /** Skip the backoff delay (e.g. user clicked "Retry now"). */
  reconnectNow() {
    if (this.#stopped || this.state !== 'reconnecting') return;
    clearTimeout(this.#reconnectTimer);
    this.#open();
  }

  /** Send a request and await its reply. Rejects with RequestError. */
  request(type, payload = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    const frame = { type, id: uid(), payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(frame.id);
        this.#outbox = this.#outbox.filter((f) => f !== frame);
        reject(new RequestError('timeout', `${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(frame.id, { resolve, reject, timer, type });
      this.#send(frame);
    });
  }

  /** Fire-and-forget. Dropped (not queued) when offline — for ephemeral stuff like typing. */
  notify(type, payload = {}) {
    if (this.state !== 'open') return false;
    this.#ws.send(JSON.stringify({ type, id: uid(), payload }));
    return true;
  }

  /** Subscribe to a server event type. Returns an unsubscribe function. */
  on(type, fn) {
    const listener = (e) => fn(e.detail);
    this.addEventListener(type, listener);
    return () => this.removeEventListener(type, listener);
  }

  // ---- internals ------------------------------------------------------------

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.#emit('state', { state });
  }

  #send(frame) {
    if (this.state === 'open' && this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
    else this.#outbox.push(frame);
  }

  async #open() {
    this.#setState(this.#everOpened ? 'reconnecting' : 'connecting');
    let url;
    try {
      url = await this.getUrl(); // fresh one-time ticket every attempt
    } catch (err) {
      if (err.fatal) {
        // e.g. JWT expired: backoff won't fix it, the app must log in again
        this.#stopped = true;
        this.#setState('closed');
        return this.#emit('fatal', { error: err });
      }
      return this.#scheduleReconnect();
    }
    if (this.#stopped) return;

    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.onopen = () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.#attempt = 0;
      this.#setState('open');
      const queued = this.#outbox;
      this.#outbox = [];
      for (const f of queued) ws.send(JSON.stringify(f));
      this.#startPing();
      this.#emit('open', { reconnected });
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.replyTo && this.#pending.has(msg.replyTo)) {
        const p = this.#pending.get(msg.replyTo);
        this.#pending.delete(msg.replyTo);
        clearTimeout(p.timer);
        if (msg.type === 'error') p.reject(new RequestError(msg.payload.code, msg.payload.message));
        else p.resolve(msg.payload);
        return;
      }
      if (msg.type === 'error') return this.#emit('servererror', msg.payload);
      this.#emit('message', msg);
      this.#emit(msg.type, msg.payload);
    };

    ws.onclose = (e) => this.#handleClose(ws, e.code, e.reason);
    ws.onerror = () => {}; // 'close' always follows; handle there
  }

  #handleClose(ws, code, reason) {
    if (ws !== this.#ws) return; // stale socket
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    this.#ws = null;
    this.#stopPing();
    // In-flight requests went out on a dead socket and will never be answered.
    this.#failPending('disconnected', 'Connection lost');
    this.#emit('close', { code, reason });
    if (this.#stopped) return this.#setState('closed');
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    // Full jitter: random delay in [0, min(max, base * 2^attempt)].
    // Spreads a thundering herd of clients after a server restart.
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.#attempt);
    const delay = Math.round(Math.random() * ceiling);
    this.#attempt++;
    this.#setState('reconnecting');
    this.#emit('reconnecting', { attempt: this.#attempt, delay, at: Date.now() + delay });
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
    this.#reconnectTimer.unref?.(); // Node (tests/CLI): don't keep the process alive
  }

  #failPending(code, message) {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new RequestError(code, message));
      this.#pending.delete(id);
    }
  }

  #startPing() {
    this.#stopPing();
    const ping = async () => {
      const ws = this.#ws;
      const t = performance.now();
      try {
        await this.request('sys:ping', { t: Date.now() }, { timeoutMs: 5000 });
        this.#emit('latency', { ms: Math.round(performance.now() - t) });
      } catch (err) {
        // Half-open TCP: the browser still says OPEN but nothing gets through.
        if (err.code === 'timeout' && ws && ws === this.#ws) {
          ws.close(4000, 'ping timeout');
          this.#handleClose(ws, 4000, 'ping timeout');
        }
      }
    };
    ping();
    this.#pingTimer = setInterval(ping, this.pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  #stopPing() {
    clearInterval(this.#pingTimer);
  }
}
