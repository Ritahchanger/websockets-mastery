# Example 04 — Multi-room chat (Express + ws + zod)

A complete multi-room chat using the course envelope `{ type, id, payload, replyTo }`:
zod validation, a handler map + dispatcher, request/response with timeouts, rooms
(`Map<room, Set<client>>`), presence, typing indicators, broadcast-excluding-sender,
optimistic sending and structured errors.
Explained in [Chapter 4](../../docs/04-messaging-patterns.md).

## Run

```bash
npm run ex:04    # http://localhost:3000
```

## Things to try

- Open a normal and a private window (the nickname lives in `localStorage`), pick nicknames.
  Try a taken nickname → `NICK_TAKEN`.
- Chat in `#general`, switch one window to `#random` and watch the unread badge.
- Type without sending → *"ada is typing…"* in the other window; it clears after 3 s idle (5 s server expiry).
- Join/create `project-x` from the sidebar; leave it and it disappears (empty rooms are deleted).
- Stop and restart the server: clients show a banner, reconnect, re-hello and re-join.
- `curl localhost:3000/api/rooms` — the same state over REST.
- Send malformed messages from DevTools (see chapter 4.11) to see `BAD_MESSAGE`,
  `NOT_IDENTIFIED`, `VALIDATION`, `UNKNOWN_TYPE`.

## Files

| File | What |
|---|---|
| `server.js` | Express + ws wiring, handlers, dispatcher, connection lifecycle |
| `protocol.js` | envelope + zod schemas, message builders, `AppError` |
| `rooms.js` | `RoomManager` (rooms, reverse index, history, broadcast) |
| `public/index.html` | layout + styles |
| `public/app.js` | `ChatSocket` (request/response, events, reconnect) + UI |
