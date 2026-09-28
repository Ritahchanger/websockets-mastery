# Example 07 — Socket.IO on Express 5

Companion to [docs/07-socketio.md](../../docs/07-socketio.md). The code here is identical to the listings in the chapter.

A chat that demonstrates what Socket.IO adds on top of raw WebSockets:

| Feature | Where |
|---|---|
| Middleware auth (`io.use`, `handshake.auth.name`, `connect_error`) | `server.js` → `io.use(...)` |
| Acknowledgements (client→server and server→client, `emitWithAck`, `timeout`) | `room:join`, `chat:message`, `ping:server` / `whattime` |
| Rooms + broadcasting (`join`, `socket.to`, `io.to`, `fetchSockets`) | `room:join`, `chat:message`, `disconnecting` |
| Volatile emits | `chat:typing`, `tick` |
| Namespaces | `/admin` with its own token middleware (`stats`, `announce`) |
| Connection state recovery | `connectionStateRecovery` option + "Simulate network drop" button |
| Graceful shutdown | `io.close()` on SIGINT/SIGTERM |

## Run

```bash
npm run ex:07            # from the repo root; PORT=3000 by default
# open http://localhost:3000 in two tabs
```

The browser client is plain `<script type="module">` importing `/socket.io/socket.io.esm.min.js`, which the Socket.IO server serves automatically.

## Try

1. Connect two tabs, join `general`, chat. The status line shows the transport upgrading from `polling` to `websocket`.
2. Empty the name and connect → rejected by middleware (`connect_error`, no auto-retry).
3. Click **Simulate network drop** in tab A, send from tab B, and watch tab A come back with the same id and the missed message ("session RECOVERED").
4. Admin namespace from the DevTools console (token via `ADMIN_TOKEN`, default `let-me-in`):

```js
const { io } = await import('/socket.io/socket.io.esm.min.js');
const admin = io('/admin', { auth: { token: 'let-me-in' } });
console.log(await admin.emitWithAck('stats'));
admin.emit('announce', 'hello everyone');
```

5. DevTools → Network → WS → Messages: decode frames such as `421["room:join","general"]` and `431[{...}]` using the tables in the chapter.

## Environment

- `PORT` (default `3000`)
- `ADMIN_TOKEN` (default `let-me-in` — demo only)
