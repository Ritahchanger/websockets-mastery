# Example 03 — Express + ws on one port, with authenticated endpoints

One `http.Server` shared by Express 5 (static files + REST) and two `noServer` WebSocket servers,
routed by path in a single `'upgrade'` handler.
Explained in [Chapter 3](../../docs/03-express-integration.md).

| Endpoint | Auth |
|---|---|
| `/ws/chat` | session cookie (`POST /api/login`) + `Origin` allow-list |
| `/ws/feed` | 60-second JWT from `GET /api/token`, via `?token=` or `Sec-WebSocket-Protocol: feed.v1, auth.<jwt>` |
| anything else | `404` written to the socket |

REST: `POST /api/login`, `POST /api/logout`, `GET /api/me`, `GET /api/token`, `GET /api/online`, `POST /api/broadcast`.

## Run

```bash
npm run ex:03    # http://localhost:3000
```

Env: `PORT`, `JWT_SECRET`, `ALLOWED_ORIGINS` (comma-separated).

## Things to try

- Log in as two users (normal + private window) and chat; send an announcement (REST → WebSocket push).
- **Try /ws/feed with a bad token**: the browser only sees close code 1006; the server logs a 401.
- See the real status codes with curl:
  ```bash
  H='-H Connection:Upgrade -H Upgrade:websocket -H Sec-WebSocket-Version:13 -H Sec-WebSocket-Key:dGhlIHNhbXBsZSBub25jZQ=='
  curl -i $H http://localhost:3000/ws/nope                                   # 404
  curl -i $H -H "Origin: http://localhost:3000" http://localhost:3000/ws/chat # 401
  curl -i $H -H "Origin: https://evil.example"  http://localhost:3000/ws/chat # 403
  ```
- Push from the command line:
  ```bash
  curl -s -c jar.txt -H 'Content-Type: application/json' -d '{"name":"curl"}' http://localhost:3000/api/login
  curl -s -b jar.txt -H 'Content-Type: application/json' -d '{"text":"hello from curl"}' http://localhost:3000/api/broadcast
  ```
- Log out: the server closes your chat socket with `4001`.
