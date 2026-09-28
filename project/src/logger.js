// Tiny structured logger: one JSON line per event in production, pretty in dev.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info')] ?? 20;
const json = process.env.NODE_ENV === 'production';

function log(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  if (json) {
    console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
  } else {
    const tail = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
    console.log(`${new Date().toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`);
  }
}

export const logger = {
  debug: (m, e) => log('debug', m, e),
  info: (m, e) => log('info', m, e),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),
};
