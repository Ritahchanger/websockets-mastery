# Example 01 — Raw WebSocket handshake (no libraries)

A WebSocket server built with only `node:http` + `node:crypto`: the RFC 6455 handshake,
frame parsing/unmasking, echo, ping → pong and the closing handshake.
Explained in [Chapter 1](../../docs/01-fundamentals.md).

## Run

```bash
npm run ex:01          # from the repo root (PORT=3000 by default)
```

Open <http://localhost:3000>, then DevTools → Network → WS to inspect the handshake and frames.

## Things to try

- Click **Send text**, **Send binary**, **Send 70 KB** (forces the 64-bit length encoding), **Close**.
- Watch every byte with the dependency-free client:
  ```bash
  node examples/01-raw-handshake/raw-client.js
  ```
- Check the accept math against the RFC example key:
  ```bash
  curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
       -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:3000/
  # Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
  ```
- Send `Sec-WebSocket-Version: 8` and get a `426 Upgrade Required`.

## Files

| File | What |
|---|---|
| `server.js` | handshake, frame parser/encoder, opcode dispatch |
| `raw-client.js` | byte-level client using `node:net` (prints hex) |
| `public/index.html` | browser client using the standard `WebSocket` API |

Educational only: no UTF-8 validation, compression, close timeouts or backpressure. Use `ws` (chapter 2) in real apps.
