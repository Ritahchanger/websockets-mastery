// Authentication: HTTP issues credentials, the WebSocket only accepts tickets.
//
//   POST /api/login   { nickname }        -> { token, user }      (JWT, hours)
//   POST /api/ticket  Authorization: JWT  -> { ticket, expiresIn } (one-time, seconds)
//
// Why two credentials? Browsers cannot set headers on `new WebSocket()`, so the
// credential must travel in the URL — where it can leak into logs and history.
// A ticket is useless after one use and expires in seconds, so leaking it is
// harmless. The long-lived JWT never touches a URL.
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const LoginBody = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, 'Nickname must be at least 2 characters')
    .max(24, 'Nickname must be at most 24 characters')
    .regex(/^[\p{L}\p{N}_.\- ]+$/u, 'Letters, numbers, space, _ . - only'),
});

const COLORS = ['#7c5cff', '#22c55e', '#f97316', '#06b6d4', '#ec4899', '#eab308', '#ef4444', '#3b82f6', '#14b8a6', '#a855f7'];

export function colorFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** One-time, short-lived tickets kept in memory (use Redis when scaling out). */
export class TicketStore {
  #tickets = new Map(); // ticket -> { user, expiresAt }
  #ttlMs;
  #timer;

  constructor({ ttlMs = 30_000, sweepMs = 10_000 } = {}) {
    this.#ttlMs = ttlMs;
    this.#timer = setInterval(() => this.sweep(), sweepMs);
    this.#timer.unref();
  }

  issue(user) {
    const ticket = crypto.randomBytes(24).toString('base64url');
    this.#tickets.set(ticket, { user, expiresAt: Date.now() + this.#ttlMs });
    return { ticket, expiresIn: Math.floor(this.#ttlMs / 1000) };
  }

  /** Returns the user and deletes the ticket, or null. Never usable twice. */
  consume(ticket) {
    if (typeof ticket !== 'string') return null;
    const entry = this.#tickets.get(ticket);
    if (!entry) return null;
    this.#tickets.delete(ticket);
    return entry.expiresAt >= Date.now() ? entry.user : null;
  }

  sweep(now = Date.now()) {
    for (const [t, e] of this.#tickets) if (e.expiresAt < now) this.#tickets.delete(t);
  }

  get size() {
    return this.#tickets.size;
  }

  close() {
    clearInterval(this.#timer);
    this.#tickets.clear();
  }
}

export function createAuth(config) {
  const tickets = new TicketStore({ ttlMs: config.ticketTtlMs });

  const signToken = (user) =>
    jwt.sign({ name: user.name, color: user.color }, config.jwtSecret, {
      subject: user.id,
      expiresIn: config.jwtTtl,
      algorithm: 'HS256',
    });

  const verifyToken = (token) => {
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    return { id: claims.sub, name: claims.name, color: claims.color };
  };

  /** Express middleware: requires `Authorization: Bearer <jwt>`. */
  const requireUser = (req, res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'missing_token' });
    try {
      req.user = verifyToken(token);
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  };

  const router = express.Router();

  router.post('/login', (req, res) => {
    const parsed = LoginBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_nickname', message: parsed.error.issues[0].message });
    }
    // Demo identity: nickname-only. Swap this block for a real IdP / password check.
    const id = `u_${crypto.randomUUID().slice(0, 8)}`;
    const user = { id, name: parsed.data.nickname, color: colorFor(id) };
    res.json({ token: signToken(user), user });
  });

  router.post('/ticket', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(tickets.issue(req.user));
  });

  router.get('/me', requireUser, (req, res) => res.json({ user: req.user }));

  return { router, tickets, signToken, verifyToken, requireUser, close: () => tickets.close() };
}
