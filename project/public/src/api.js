// HTTP side of auth. The JWT lives in sessionStorage (per tab) and is only
// ever sent in an Authorization header — never in a WebSocket URL.
const KEY = 'huddle.session';

export class AuthError extends Error {
  fatal = true;
}

export function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: session lives in memory only */
  }
}

async function post(path, body, token) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error ?? 'unauthorized');
  if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
  return data;
}

export const login = (nickname) => post('/api/login', { nickname });

/** Build the WebSocket URL with a fresh one-time ticket. */
export async function wsUrl(token, path = '/ws') {
  const { ticket } = await post('/api/ticket', {}, token);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}?ticket=${encodeURIComponent(ticket)}`;
}

export async function serverConfig() {
  const res = await fetch('/api/config');
  return res.json();
}
