// In-process metrics. Rates use a 10-slot ring of per-second counters, so
// "messages/sec" is a 10-second moving average, not a lifetime average.
import express from 'express';

class RateWindow {
  #slots = new Array(10).fill(0);
  #slotSecond = Math.floor(Date.now() / 1000);
  total = 0;

  #rotate() {
    const now = Math.floor(Date.now() / 1000);
    const steps = Math.min(now - this.#slotSecond, this.#slots.length);
    for (let i = 0; i < steps; i++) {
      this.#slots.shift();
      this.#slots.push(0);
    }
    this.#slotSecond = now;
  }

  inc(n = 1) {
    this.#rotate();
    this.#slots[this.#slots.length - 1] += n;
    this.total += n;
  }

  perSecond() {
    this.#rotate();
    // exclude the current (partial) second
    const full = this.#slots.slice(0, -1);
    return +(full.reduce((a, b) => a + b, 0) / full.length).toFixed(2);
  }
}

export class Metrics {
  startedAt = Date.now();
  #in = new RateWindow();
  #out = new RateWindow();
  rejected = { origin: 0, ticket: 0, rate: 0, invalid: 0 };

  countIn() {
    this.#in.inc();
  }
  countOut() {
    this.#out.inc();
  }
  countRejected(kind) {
    this.rejected[kind] = (this.rejected[kind] ?? 0) + 1;
  }

  async snapshot({ hub, chat, media }) {
    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      connections: hub.clients.size,
      usersOnline: hub.users.length,
      messages: {
        inPerSec: this.#in.perSecond(),
        outPerSec: this.#out.perSecond(),
        inTotal: this.#in.total,
        outTotal: this.#out.total,
      },
      rejected: this.rejected,
      channels: chat.channels.list().length,
      media: { available: media.available, ...media.stats(), workerDetails: await media.workerStats() },
      memory: { rssMb: +(mem.rss / 1048576).toFixed(1), heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1) },
    };
  }
}

/** GET /metrics (JSON) and GET /metrics?format=prometheus (text exposition). */
export function metricsRouter(metrics, deps) {
  const router = express.Router();
  router.get('/', async (req, res) => {
    const s = await metrics.snapshot(deps);
    if (req.query.format !== 'prometheus') return res.json(s);
    const lines = [
      ['huddle_ws_connections', 'gauge', s.connections],
      ['huddle_users_online', 'gauge', s.usersOnline],
      ['huddle_ws_messages_in_total', 'counter', s.messages.inTotal],
      ['huddle_ws_messages_out_total', 'counter', s.messages.outTotal],
      ['huddle_media_rooms', 'gauge', s.media.rooms],
      ['huddle_media_peers', 'gauge', s.media.peers],
      ['huddle_media_workers', 'gauge', s.media.workers],
    ].flatMap(([name, type, v]) => [`# TYPE ${name} ${type}`, `${name} ${v}`]);
    for (const [kind, v] of Object.entries(s.rejected)) lines.push(`huddle_ws_rejected_total{reason="${kind}"} ${v}`);
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });
  return router;
}
