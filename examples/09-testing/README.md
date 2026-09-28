# Example 09 — Testing & debugging a WebSocket server

Companion to [docs/09-testing-debugging.md](../../docs/09-testing-debugging.md).

| File | What it is |
|---|---|
| `app.js` | Testable app factory: Express 5 + `ws` (noServer), envelope protocol (zod), rooms, heartbeat, `/metrics`, `/healthz`. Does not listen on import. |
| `server.js` | Launcher for manual debugging (`PORT`, `DEBUG_WS=1`). Not used by tests. |
| `helpers.js` | Test utilities: `startServer` (port 0), `connect`, `nextMessage`, `request`, `expectSilence`, `waitForClose`, `eventually`. |
| `protocol.test.js` | Request/response, `replyTo`, validation errors. |
| `rooms.test.js` | Multi-client fan-out, isolation, room cleanup, 50-client broadcast. |
| `lifecycle.test.js` | 404 on wrong upgrade path, `maxPayload` → 1009, heartbeat → 1006, metrics. |
| `socketio.test.js` | Socket.IO: middleware auth, `emitWithAck`, room broadcast. |

## Run the tests

```bash
# from the repo root (quote the glob so Node expands it)
node --test "examples/09-testing/*.test.js"
```

Expected: `tests 20 / pass 20 / fail 0`, finishing in well under a second, and the process exits on its own.

> Note: `node --test examples/09-testing/` (a bare directory) does not work on Node 22+/24 — use the glob.

## Poke the server by hand

```bash
PORT=3000 DEBUG_WS=1 node examples/09-testing/server.js
npx wscat -c ws://localhost:3000/ws
> {"type":"ping","id":"1"}
> {"type":"room:join","id":"2","payload":{"room":"general"}}
> {"type":"chat:message","id":"3","payload":{"room":"general","text":"hi"}}
curl -s localhost:3000/metrics
```
