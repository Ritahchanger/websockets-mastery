# Example 02 — Echo + broadcast with `ws`

`WebSocketServer` attached to a plain `node:http` server on path `/ws`.
Text is echoed to the sender and broadcast to everyone else; binary is echoed back as binary.
Explained in [Chapter 2](../../docs/02-first-server-ws.md).

## Run

```bash
npm run ex:02                              # server on http://localhost:3000
node examples/02-echo-ws/client.js         # optional terminal client
```

## Things to try

- Open <http://localhost:3000> in two tabs and chat; type `/nick Alice`.
- **Send binary** shows `isBinary` handling round-trip.
- In the terminal client: `/ping` (real WebSocket ping + RTT), `/bin`, `/nick Terminal`, `/quit`.
- Exceed `maxPayload` (64 KB) from DevTools:
  ```js
  const t = new WebSocket(`ws://${location.host}/ws`);
  t.onopen = () => t.send('x'.repeat(100_000));
  t.onclose = (e) => console.log(e.code); // 1009
  ```
- Ctrl+C the server: clients get close code `1001` (going away).
