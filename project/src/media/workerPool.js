// A mediasoup Worker is a C++ subprocess that uses one CPU core. We run N of
// them and hand out Routers round-robin. If one dies (segfault, OOM kill),
// every Router on it is gone: we tell the owner (so rooms can close and
// clients rejoin) and spawn a replacement.
import { EventEmitter } from 'node:events';
import { ProtocolError } from '../ws/protocol.js';
import { logger } from '../logger.js';

export class WorkerPool extends EventEmitter {
  #mediasoup;
  #options;
  #workers = [];
  #next = 0;
  #closed = false;

  constructor(mediasoup, { numWorkers, logLevel }) {
    super();
    this.#mediasoup = mediasoup;
    this.#options = { numWorkers, logLevel };
  }

  async start() {
    await Promise.all(Array.from({ length: this.#options.numWorkers }, () => this.#spawn()));
    logger.info('mediasoup workers ready', { count: this.#workers.length, version: this.#mediasoup.version });
  }

  async #spawn() {
    const worker = await this.#mediasoup.createWorker({
      logLevel: this.#options.logLevel,
      logTags: ['ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    });
    worker.on('died', (err) => {
      logger.error('mediasoup worker died', { pid: worker.pid, err: err?.message });
      this.#workers = this.#workers.filter((w) => w !== worker);
      this.emit('workerDied', worker);
      if (!this.#closed) {
        setTimeout(() => this.#spawn().catch((e) => logger.error('respawn failed', { err: e.message })), 1000).unref();
      }
    });
    this.#workers.push(worker);
    return worker;
  }

  /** Round-robin: cheap and fair enough when rooms are similar in size. */
  next() {
    if (this.#workers.length === 0) throw new ProtocolError('media_unavailable', 'No media workers available');
    const worker = this.#workers[this.#next++ % this.#workers.length];
    return worker;
  }

  get size() {
    return this.#workers.length;
  }

  async stats() {
    return Promise.all(
      this.#workers.map(async (w) => {
        const u = await w.getResourceUsage().catch(() => null);
        return { pid: w.pid, cpuMs: u ? u.ru_utime + u.ru_stime : null, maxRssKb: u?.ru_maxrss ?? null };
      }),
    );
  }

  close() {
    this.#closed = true;
    for (const w of this.#workers) w.close();
    this.#workers = [];
  }
}
