// Chat feature: channels, messages, history, reactions, typing, presence.
// Each handler is small because validation already happened in the gateway
// and error formatting happens in the router.
import { ChannelStore } from './channels.js';
import { TypingTracker } from './typing.js';
import { wirePresence } from './presence.js';
import { ProtocolError } from '../ws/protocol.js';

export function registerChat({ router, hub, config, getHuddles = () => [] }) {
  const channels = new ChannelStore(config.chat);
  const presence = wirePresence(hub);
  const toMembers = (channel) => (c) => channel.members.has(c);

  const typing = new TypingTracker({
    ttlMs: config.chat.typingTtlMs,
    onChange: (channelId, users) => {
      const ch = channels.list().find((c) => c.id === channelId);
      if (ch) hub.broadcast('typing:update', { channelId, users }, toMembers(ch));
    },
  });

  const snapshot = () => ({
    channels: channels.list().map((c) => c.toJSON()),
    presence: presence.list(),
    huddles: getHuddles(),
  });

  // First frame on every connection: who you are + the world as of now.
  hub.on('connect', (client) => {
    client.event('session:welcome', { user: client.user, clientId: client.id, serverTime: Date.now(), ...snapshot() });
  });

  hub.on('disconnect', (client, { lastForUser }) => {
    for (const ch of channels.list()) ch.members.delete(client);
    if (lastForUser) typing.stopEverywhere(client.user.id);
  });

  const join = (client, channelId, since) => {
    const ch = channels.get(channelId);
    ch.members.add(client);
    client.channels.add(ch.id);
    const { messages, gap } = since === undefined
      ? { messages: ch.history.last(config.chat.historyPage), gap: ch.history.size > config.chat.historyPage || (ch.history.at(0)?.seq ?? 1) > 1 }
      : ch.since(since, config.chat.historyPage * 4);
    return { channel: ch.toJSON(), messages, gap, typing: typing.users(ch.id) };
  };

  router
    .on('sys:ping', ({ payload }) => ({ t: payload.t, serverTime: Date.now() }))

    // One round-trip after reconnect: fresh world snapshot + every message
    // missed in every channel the client had open.
    .on('sys:resync', ({ client, payload }) => {
      const missed = {};
      for (const [channelId, since] of Object.entries(payload.channels)) {
        try {
          missed[channelId] = join(client, channelId, since);
        } catch {
          /* channel vanished; the snapshot tells the client */
        }
      }
      return { ...snapshot(), missed };
    })

    .on('channel:list', () => ({ channels: channels.list().map((c) => c.toJSON()) }))

    .on('channel:create', ({ client, payload }) => {
      const ch = channels.create({ ...payload, createdBy: client.user.id });
      hub.broadcast('channel:created', { channel: ch.toJSON(), by: client.user });
      return { channel: ch.toJSON() };
    })

    .on('channel:join', ({ client, payload }) => join(client, payload.channelId, payload.since))

    .on('channel:leave', ({ client, payload }) => {
      const ch = channels.get(payload.channelId);
      ch.members.delete(client);
      client.channels.delete(ch.id);
      return {};
    })

    .on('chat:send', ({ client, payload }) => {
      const ch = channels.get(payload.channelId);
      if (!ch.members.has(client)) throw new ProtocolError('not_member', `Join #${ch.id} first`);
      const { message, duplicate } = ch.append({ user: client.user, text: payload.text, clientMsgId: payload.clientMsgId });
      if (!duplicate) {
        typing.stop(ch.id, client.user.id);
        // Everyone in the channel, including the sender's *other* tabs.
        hub.broadcast('chat:message', { message, clientMsgId: payload.clientMsgId }, toMembers(ch));
      }
      return { message, duplicate };
    })

    .on('chat:history', ({ payload }) => {
      const ch = channels.get(payload.channelId);
      const messages = ch.before(payload.before ?? ch.seq + 1, payload.limit ?? config.chat.historyPage);
      return { channelId: ch.id, messages, hasMore: (messages[0]?.seq ?? 1) > (ch.history.at(0)?.seq ?? 1) };
    })

    .on('chat:react', ({ client, payload }) => {
      const ch = channels.get(payload.channelId);
      const msg = ch.toggleReaction(payload.messageId, payload.emoji, client.user.id);
      const event = { channelId: ch.id, messageId: msg.id, reactions: msg.reactions };
      hub.broadcast('chat:reaction', event, toMembers(ch));
      return event;
    })

    .on('typing:start', ({ client, payload }) => {
      if (channels.get(payload.channelId).members.has(client)) typing.start(payload.channelId, client.user);
    }, { notify: true })
    .on('typing:stop', ({ client, payload }) => typing.stop(payload.channelId, client.user.id), { notify: true })

    .on('presence:list', () => ({ presence: presence.list() }));

  return { channels, typing, presence, snapshot };
}
