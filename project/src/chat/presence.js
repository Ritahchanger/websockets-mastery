// Presence is derived from the hub: a user is online while they have at least
// one open connection. Only the first connect / last disconnect is broadcast,
// so opening a second tab doesn't spam everyone.
export function wirePresence(hub) {
  hub.on('connect', (client, { firstForUser }) => {
    if (firstForUser) hub.broadcast('presence:update', { user: client.user, status: 'online' }, (c) => c !== client);
  });
  hub.on('disconnect', (client, { lastForUser }) => {
    if (lastForUser) hub.broadcast('presence:update', { user: client.user, status: 'offline' });
  });
  return {
    list: () => hub.users.map((user) => ({ user, status: 'online' })),
  };
}
