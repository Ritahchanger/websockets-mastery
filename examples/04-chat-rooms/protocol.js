// examples/04-chat-rooms/protocol.js
//
// The wire protocol, in one place:
//   - Envelope: { type, id?, payload?, replyTo? }
//   - zod schemas for every client -> server message type
//   - builders for server -> client messages (event, reply, error)
//   - AppError: an error whose code+message are safe to show the client

import crypto from 'node:crypto';
import { z } from 'zod';

// ---- Envelope (layer 2 validation) ----------------------------------------
export const Envelope = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(64).optional(), // present => client expects a reply
  payload: z.unknown().optional(),
});

// ---- Reusable field schemas ------------------------------------------------
export const RoomName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,23}$/, 'room names use a-z, 0-9 and dashes (max 24)');

export const Nick = z
  .string()
  .trim()
  .min(2, 'nickname must be at least 2 characters')
  .max(20, 'nickname must be at most 20 characters')
  .regex(/^[\p{L}\p{N}_.-]+$/u, 'nickname may contain letters, digits, _ . -');

// ---- Payload schemas per message type (layer 3 validation) ----------------
// z.object() strips unknown keys, so clients can't smuggle extra fields.
export const schemas = {
  'session:hello': z.object({ nick: Nick }),
  'user:nick': z.object({ nick: Nick }),
  'room:list': z.object({}),
  'room:join': z.object({ room: RoomName }),
  'room:leave': z.object({ room: RoomName }),
  'chat:message': z.object({ room: RoomName, text: z.string().trim().min(1).max(2000) }),
  'chat:typing': z.object({ room: RoomName, typing: z.boolean() }),
};

// ---- Errors ----------------------------------------------------------------
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.expose = true; // safe to send to the client
  }
}

// Turn zod issues into one short, human-readable line.
export function formatIssues(zodError) {
  return zodError.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

// ---- Server -> client builders --------------------------------------------
export function event(type, payload) {
  return { type, id: crypto.randomUUID(), payload };
}

export function reply(replyTo, payload) {
  return { type: 'ok', id: crypto.randomUUID(), replyTo, payload };
}

export function errorMessage(replyTo, code, message) {
  const msg = { type: 'error', id: crypto.randomUUID(), payload: { code, message } };
  if (replyTo) msg.replyTo = replyTo;
  return msg;
}
