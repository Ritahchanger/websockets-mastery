# Example 08 — Scaling raw `ws` with Redis pub/sub

Companion to [Chapter 8 — Scaling](../../docs/08-scaling.md). Several server
instances share rooms and presence through Redis, so clients connected to
different processes can chat with each other.

| File | What it is |
|---|---|
| `server.js` | Express 5 + `ws` (noServer) chat; Redis pub/sub fan-out, per-room lazy subscribe, cross-node presence with node-liveness TTL, `/healthz`, `/metrics`, graceful 1001 shutdown |
| `public/index.html` | Browser client: shows which node it's on and the `via` node of each message; reconnects with backoff + jitter and re-joins its room |
| `cluster.js` | Runs `server.js` on every core with `node:cluster` (rolling restart on SIGHUP) |
| `flood.js` | Load generator: N clients over several URLs, rooms, msgs/sec, end-to-end p50/p99 latency |
| `nginx.conf` | WebSocket reverse proxy (Upgrade/Connection headers, `proxy_read_timeout`, `least_conn`) |
| `Dockerfile`, `docker-compose.yml` | Redis + 2 app instances + nginx on http://localhost:8080 |

## Run locally (two instances)

```bash
# Redis (skip if one is already running on 6379)
docker run -d --name redis -p 6379:6379 redis:7-alpine

# from the repo root, in two terminals
PORT=3001 npm run ex:08
PORT=3002 npm run ex:08
```

Open http://localhost:3001 and http://localhost:3002 in two tabs, join `lobby`
in both and chat. Each message shows which node relayed it.

Env vars: `PORT` (default 3000), `REDIS_URL` (default `redis://127.0.0.1:6379`), `NODE_ID` (optional label).

Inspect Redis while chatting:

```bash
redis-cli PSUBSCRIBE 'chat:room:*'
redis-cli PUBSUB CHANNELS 'chat:*'
redis-cli SMEMBERS chat:presence:lobby
```

## Run the full stack (nginx + 2 instances + Redis)

```bash
docker compose -f examples/08-scaling-redis/docker-compose.yml up --build
# http://localhost:8080  — open several tabs; "Connected to node" shows app1 or app2
docker compose -f examples/08-scaling-redis/docker-compose.yml stop app1   # watch clients fail over
```

## Cluster mode and load test

```bash
WORKERS=4 PORT=3001 node examples/08-scaling-redis/cluster.js

ulimit -n 65535
node examples/08-scaling-redis/flood.js \
  --urls ws://localhost:3001/ws,ws://localhost:3002/ws \
  --clients 2000 --rate 200 --rooms 20 --msgs 0.5 --duration 20
```
