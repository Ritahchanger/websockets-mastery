// The Huddle wire protocol. Every frame, both directions, is one JSON envelope:
//
//   { type: "chat:send", id: "<unique>", payload: { ... }, replyTo?: "<id>" }
//
// * Client -> server frames are validated twice: envelope first, then the
//   payload against the schema registered for its `type`.
// * A request is answered with `type: "ok"` (success) or `type: "error"`
//   (the ch.4 convention), carrying `replyTo: <request id>` so the client
//   can resolve or reject the matching promise.
// * Server -> client pushes ("events") have no replyTo.
import crypto from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(64);
const channelId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'invalid channel id');
const mediaId = z.string().uuid();
const opaque = z.record(z.string(), z.unknown()); // SDP-ish blobs owned by mediasoup

export const Envelope = z.object({
  type: z.string().min(1).max(64).regex(/^[a-z]+:[a-zA-Z]+$/, 'type must look like "domain:action"'),
  id,
  payload: z.unknown().optional().default({}),
  replyTo: id.optional(),
});

/** Payload schema per client -> server message type. Unknown types are rejected. */
export const ClientMessages = {
  // --- system -------------------------------------------------------------
  'sys:ping': z.object({ t: z.number().optional() }).strict(),
  'sys:resync': z.object({ channels: z.record(channelId, z.number().int().min(0)).default({}) }).strict(),

  // --- channels & chat ----------------------------------------------------
  'channel:list': z.object({}).strict(),
  'channel:create': z
    .object({
      name: z.string().trim().toLowerCase().min(2).max(32).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
      topic: z.string().trim().max(120).optional(),
    })
    .strict(),
  'channel:join': z.object({ channelId, since: z.number().int().min(0).optional() }).strict(),
  'channel:leave': z.object({ channelId }).strict(),
  'chat:send': z
    .object({
      channelId,
      text: z.string().trim().min(1, 'empty message').max(4000),
      clientMsgId: z.string().min(1).max(64).optional(), // idempotency key for retries
    })
    .strict(),
  'chat:history': z.object({ channelId, before: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  'chat:react': z.object({ channelId, messageId: id, emoji: z.string().min(1).max(16) }).strict(),
  'typing:start': z.object({ channelId }).strict(),
  'typing:stop': z.object({ channelId }).strict(),
  'presence:list': z.object({}).strict(),

  // --- media signaling (mediasoup) ---------------------------------------
  'media:getRouterRtpCapabilities': z.object({ roomId: channelId }).strict(),
  'media:join': z.object({ roomId: channelId, rtpCapabilities: opaque }).strict(),
  'media:leave': z.object({}).strict(),
  'media:createTransport': z.object({ direction: z.enum(['send', 'recv']) }).strict(),
  'media:connectTransport': z.object({ transportId: mediaId, dtlsParameters: opaque }).strict(),
  'media:produce': z
    .object({
      transportId: mediaId,
      kind: z.enum(['audio', 'video']),
      rtpParameters: opaque,
      appData: z.object({ source: z.enum(['mic', 'cam', 'screen']) }).passthrough(),
    })
    .strict(),
  'media:consume': z.object({ transportId: mediaId, producerId: mediaId }).strict(),
  'media:resumeConsumer': z.object({ consumerId: mediaId }).strict(),
  'media:closeProducer': z.object({ producerId: mediaId }).strict(),
  'media:pauseProducer': z.object({ producerId: mediaId }).strict(),
  'media:resumeProducer': z.object({ producerId: mediaId }).strict(),
};

/** Server -> client event types (documentation + used by tests). */
export const ServerEvents = [
  'session:welcome',
  'channel:created',
  'chat:message',
  'chat:reaction',
  'typing:update',
  'presence:update',
  'huddle:update',
  'media:peerJoined',
  'media:peerLeft',
  'media:newProducer',
  'media:producerClosed',
  'media:producerPaused',
  'media:producerResumed',
  'media:activeSpeaker',
  'media:roomClosed',
];

export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const formatIssues = (err) => err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

/**
 * Parse a raw frame into `{ type, id, payload }` with a validated payload.
 * Throws ProtocolError with a stable `code` the client can switch on.
 */
export function parseClientMessage(raw) {
  let json;
  try {
    json = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new ProtocolError('bad_json', 'Frame is not valid JSON');
  }
  const env = Envelope.safeParse(json);
  if (!env.success) throw new ProtocolError('bad_envelope', formatIssues(env.error), { id: json?.id });

  const schema = ClientMessages[env.data.type];
  if (!schema) throw new ProtocolError('unknown_type', `Unknown message type "${env.data.type}"`, { id: env.data.id });

  const payload = schema.safeParse(env.data.payload ?? {});
  if (!payload.success) throw new ProtocolError('bad_payload', formatIssues(payload.error), { id: env.data.id });

  return { type: env.data.type, id: env.data.id, payload: payload.data };
}

export const newId = () => crypto.randomUUID();

/** Build an outbound envelope. */
export const envelope = (type, payload = {}, replyTo) => (replyTo ? { type, id: newId(), payload, replyTo } : { type, id: newId(), payload });
export const reply = (requestId, payload = {}) => envelope('ok', payload, requestId);
export const errorReply = (requestId, code, message) => envelope('error', { code, message }, requestId);
