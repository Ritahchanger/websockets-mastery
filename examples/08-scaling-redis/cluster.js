// Chapter 8 — run server.js on every CPU core with node:cluster.
//
//   WORKERS=4 PORT=3001 node examples/08-scaling-redis/cluster.js
//   kill -HUP <primary pid>    # rolling restart, one worker at a time
//
// Workers share the listening port (the primary accepts and hands sockets out
// round-robin). They do NOT share memory, so the Redis backplane in server.js
// is still what makes rooms work across workers.
import cluster from 'node:cluster';
import os from 'node:os';

if (cluster.isPrimary) {
  const n = Number(process.env.WORKERS ?? os.availableParallelism());
  const retiring = new Set(); // workers we stopped on purpose
  let seq = 0;
  const fork = () => cluster.fork({ NODE_ID: `${os.hostname()}:${process.env.PORT ?? 3000}:w${seq++}` });

  console.log(`primary ${process.pid}: forking ${n} workers`);
  for (let i = 0; i < n; i++) fork();

  cluster.on('exit', (worker, code, signal) => {
    if (retiring.delete(worker.id)) return; // planned exit during rolling restart
    console.warn(`worker ${worker.process.pid} died (${signal ?? code}); restarting`);
    fork();
  });

  // Rolling restart: start a replacement, wait until it listens, then SIGTERM
  // the old one (server.js closes its clients with 1001 and they reconnect).
  process.on('SIGHUP', async () => {
    for (const old of Object.values(cluster.workers)) {
      const replacement = fork();
      await new Promise((resolve) => replacement.once('listening', resolve));
      retiring.add(old.id);
      old.process.kill('SIGTERM');
    }
  });

  // Ctrl+C / SIGTERM on the primary: stop everyone gracefully.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      for (const w of Object.values(cluster.workers)) {
        retiring.add(w.id);
        w.process.kill('SIGTERM');
      }
      cluster.on('exit', () => Object.keys(cluster.workers).length === 0 && process.exit(0));
    });
  }
} else {
  await import('./server.js'); // every worker runs the same server on the same PORT
}
