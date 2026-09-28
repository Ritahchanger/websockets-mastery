# Example 06 — Secure WebSocket chat

Companion to [Chapter 6 — Security](../../docs/06-security.md).

Implements:

- `POST /api/login` → JWT (15 min), `POST /api/ticket` (Bearer JWT) → single-use, 30 s, IP-bound ticket
- Upgrade at `/ws?ticket=…` with checks in the `upgrade` handler, cheapest first: path → **Origin allowlist** → **per-IP connection limit** (5) → **ticket**
- `maxPayload` 16 KiB (close 1009), `perMessageDeflate: false`
- **Token bucket** per connection (burst 10, 5 msg/s), strike counting → close 1008
- zod validation of the `{type,id,payload}` envelope, **per-message authorization** (room ACL, membership check), identity taken from `ws.user`
- `headersTimeout` / `requestTimeout` against slowloris; logs never include the query string

## Run

```bash
npm run ex:06            # PORT=3000 by default
open http://localhost:3000
```

Demo users: `alice / alice123` (member + admin), `bob / bob123` (member).
Try joining `admins` as bob (forbidden), **Flood ×30** (rate limit → 1008) and **Send 20 KiB** (→ 1009).

Env vars: `PORT`, `JWT_SECRET`, `ALLOWED_ORIGINS` (comma-separated, exact match), `MAX_CONN_PER_IP`.
