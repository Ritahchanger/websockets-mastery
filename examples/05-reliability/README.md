# Example 05 — Reliability

Companion to [Chapter 5](../../docs/05-reliability.md). Express 5 + `ws` (noServer) with:

- **Heartbeats**: `ping()` + `isAlive` sweep every 15 s (`terminate()` dead peers) + app-level `sys:heartbeat` for the browser watchdog
- **Sessions that outlive sockets**: sequence numbers (`seq`) + bounded replay buffer (500 msgs, 60 s TTL)
- **At-least-once client→server**: client outbox + `ack` (`replyTo`) + server-side idempotency (seen ids)
- **Backpressure**: volatile sends dropped above 64 KB `bufferedAmount`, slow consumers closed with `1013` above 1 MB
- **Graceful shutdown**: `SIGINT`/`SIGTERM` → reject upgrades (503), `close(1001)`, 5 s drain, terminate stragglers

## Run

```bash
npm run ex:05          # PORT=3000 by default
open http://localhost:3000   # open two tabs
```

## Things to try

| Button / action | What you should see |
|---|---|
| *Server: kill all sockets* | `closed (1006)` → jittered reconnect → `resumed … replaying N`; tick counter never skips |
| *Client: go offline 8 s* (send chat from other tab meanwhile) | ~8 replayed messages, chat tagged `[replay]` |
| Type messages while offline | Outbox grows; flushed in order on reconnect, delivered exactly once |
| `Ctrl+C` the server, restart within 60 s | `closed (1001 server restarting)`, then `session reset` (in-memory sessions are gone) |
| *Noise flood ON* + DevTools "Slow 3G" | Noise frames dropped; extreme case → server logs `slow consumer → 1013` |

Endpoints: `GET /stats`, `POST /debug/kill-all`, `POST /debug/noise/on|off`, WebSocket at `/ws`.
