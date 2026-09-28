# Huddle

**A Slack-lite real-time collaboration app: channels, presence, typing indicators, reactions, and video huddles.** It is the capstone of the *WebSockets in Node.js & Express* course and uses every chapter in one codebase you could actually run. The guided build-along is [Chapter 13, Capstone: Building Huddle](../docs/13-capstone-huddle.md): ten milestones (config → auth → protocol → gateway → chat → browser client → mediasoup → signaling → video UI → metrics and tests), each ending with a checkpoint command you can run against this folder.

```
┌──────────────┬────────────────────────────────────────────────────┐
│ H  Huddle    │ # general  Company-wide chatter     (A)(G) [Leave] │
│ ● Connected  ├────────────────────────────────────────────────────┤
│              │ ┌───────────────┐ ┌───────────────┐                │
│ CHANNELS   + │ │      (G)      │ │  ▶ ada's cam  │  ← active      │
│ # engineering│ │  grace (you)  │ │      ada      │    speaker ring│
│ # general 🎧2│ └───────────────┘ └───────────────┘                │
│ # random   3 │      (mic) (cam) (screen) (expand) (leave)         │
│              ├────────────────────────────────────────────────────┤
│ ONLINE     2 │ ── Today ──                                        │
│ (A) ada   🎧 │ (A) ada 12:24   Hello **Grace**! `ws@8`            │
│ (G) grace    │                 [👍 1]                             │
│              │ (G) grace 12:24 hey                                │
│ (G) grace    │ ada is typing ···                                  │
│     10 ms  ⇥ │ [ Message #general                          ➤ ]    │
└──────────────┴────────────────────────────────────────────────────┘
```

## Features

| Area | What you get |
|---|---|
| **Auth** | Nickname login returns a JWT. `POST /api/ticket` exchanges it for a **one-time, 30 s WebSocket ticket**, so the JWT never goes in a URL. |
| **Gateway** | Upgrade-time origin check and ticket check (raw `401`/`403`/`404` before the handshake), `maxPayload`, heartbeat sweep, a per-connection **token-bucket rate limit**, and slow-consumer cut-off (`bufferedAmount`). |
| **Protocol** | One JSON envelope `{type,id,payload,replyTo}`. Every client message is validated with **zod** (strict schemas). Requests get `ok`/`error` replies with `replyTo` and stable error codes. |
| **Chat** | Channels (create and join), per-channel **ring-buffer history** with monotonically increasing `seq`, paginated history, **reactions** (toggle), **typing indicators** with TTL, **presence** (multi-tab aware), and **idempotent sends** via `clientMsgId`. |
| **Reliability** | The browser client reconnects with **exponential backoff and full jitter**, gets a fresh ticket per attempt, times out requests, detects half-open connections with an app-level ping, and **resyncs** after reconnect in one round-trip (`sys:resync` with seq cursors). An offline outbox is replayed safely. A server-restart "epoch" triggers a full refetch. |
| **Video huddles** | One mediasoup Router per channel huddle. It runs a **worker pool** (round-robin, with `died` handling and respawn) and uses send/recv WebRTC transports, paused-then-resumed consumers, cam **simulcast**, screen share, mute (producer pause), and an **active speaker** from `AudioLevelObserver`. |
| **Observability** | `GET /metrics` returns JSON (connections, users, msgs/sec in and out, rejections by reason, rooms, peers, producers, consumers, worker CPU and RSS). `?format=prometheus` returns text exposition. |
| **UI** | Dark, responsive, no framework: login, sidebar (channels, unread badges, live-huddle indicators, online users), grouped messages with safe mini-markdown, hover reactions, a typing line, a reconnect banner with countdown, and a video grid with controls. |
| **Tests** | `node:test`: protocol validation, rate limiter, ring buffer, tickets and HTTP auth, a WS integration test, the real browser `HuddleSocket` reconnecting and resyncing in Node, and **full mediasoup signaling** with `mediasoup-client`'s FakeHandler, including killing a worker. |

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[main.js UI] --> HS[HuddleSocket<br/>backoff · request() · resync]
    UI --> HM[HuddleMedia<br/>mediasoup-client Device]
    HM -- signaling --> HS
  end

  subgraph "Node.js process"
    EX[Express 5<br/>/api/login · /api/ticket · /metrics · static]
    GW[Gateway<br/>origin · ticket · heartbeat · rate limit]
    RT[MessageRouter<br/>zod-validated dispatch]
    HUB[Hub<br/>clients · users · broadcast]
    CHAT[Chat<br/>channels · history · typing · presence · reactions]
    MS[MediaService<br/>Room · Peer]
    POOL[WorkerPool<br/>round-robin · died → respawn]
    MET[Metrics]
    EX -. tickets .-> GW
    GW --> RT --> CHAT & MS
    CHAT --> HUB
    MS --> HUB
    MS --> POOL
    MET --- HUB & MS
  end

  subgraph "mediasoup workers (C++)"
    W1["Worker 1<br/>Router: #general"]
    W2["Worker 2<br/>Router: #random"]
  end

  HS <== "wss:// JSON envelopes" ==> GW
  UI -- "HTTPS fetch" --> EX
  HM <== "SRTP over UDP/TCP 40000-40100" ==> W1
  POOL --- W1 & W2
```

## Run it locally

```bash
cd project
npm install        # mediasoup downloads a prebuilt C++ worker (or compiles it: needs python3, make, g++)
npm run dev        # esbuild bundles public/src → public/bundle.js, then starts with --watch
# open http://localhost:3000 in two browser windows (or one normal + one private)
```

| Script | Does |
|---|---|
| `npm run build` | Bundles the browser client (`public/src/main.js` + `mediasoup-client`) into `public/bundle.js`. |
| `npm start` | Starts the server (run `build` first). |
| `npm run dev` | Builds, then starts with `node --watch-path=src`. |
| `npm run watch` | Rebuilds the bundle on every client change (run it next to `npm start`). |
| `npm test` | Runs all `node:test` suites. The mediasoup suite skips itself if workers can't start. |

Camera and mic need a **secure context**. `http://localhost` counts as one. Any other host needs HTTPS.

### On a LAN or in the cloud

WebRTC media does not travel over the WebSocket. Browsers send UDP (or TCP as a fallback) straight to the mediasoup worker ports, so two settings matter:

```bash
# The IP the *browsers* can reach: LAN IP (192.168.x.y) or the VM's public IP.
export MEDIASOUP_ANNOUNCED_IP=203.0.113.10
export RTC_MIN_PORT=40000 RTC_MAX_PORT=40100     # open UDP+TCP for this range
export JWT_SECRET=$(openssl rand -hex 32) NODE_ENV=production
export ALLOWED_ORIGINS=https://huddle.example.com
npm run build && npm start
```

- **Firewall or security group:** allow TCP 443 (or your HTTP port) and **UDP and TCP 40000–40100**.
- **TLS:** put Caddy or nginx in front for `https://` + `wss://` (proxy `Upgrade` headers on `/ws`). See Chapter 12. Only the WebSocket and HTTP go through the proxy. RTP goes direct.
- **Docker:** use `network_mode: host`, or publish the whole UDP range and set `MEDIASOUP_ANNOUNCED_IP`.
- **Strict corporate networks** that block UDP need a TURN server (Chapter 12). Transports already enable TCP as a fallback.

### Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listen address |
| `JWT_SECRET` | dev constant | **Required** when `NODE_ENV=production` |
| `JWT_TTL` / `TICKET_TTL_MS` | `12h` / `30000` | Credential lifetimes |
| `ALLOWED_ORIGINS` | *(same host + localhost)* | Extra allowed WebSocket origins, comma-separated, or `*` |
| `ALLOW_NO_ORIGIN` | `true` | Allow non-browser clients that send no `Origin` header |
| `MEDIASOUP_ANNOUNCED_IP` | *first LAN IPv4* | IP put in ICE candidates; set to the public IP in the cloud |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | Local bind IP for transports |
| `RTC_MIN_PORT` / `RTC_MAX_PORT` | `40000` / `40100` | WebRTC port range |
| `MEDIASOUP_WORKERS` | `min(cores, 4)` | Worker processes |
| `MEDIA_ENABLED` | `true` | `false` runs chat only |
| `MAX_PEERS_PER_ROOM` | `12` | Huddle size cap |
| `HEARTBEAT_MS` | `30000` | Ping sweep interval |
| `RATE_BURST` / `RATE_PER_SEC` | `40` / `15` | Token bucket per connection |
| `WS_MAX_PAYLOAD` | `65536` | Max inbound frame size (bytes) |
| `HISTORY_SIZE` | `500` | Messages kept per channel (ring buffer) |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` · `silent` |

## Folder structure

```
project/
├── package.json            scripts: build · start · dev · watch · test
├── .env.example
├── src/
│   ├── server.js           composition root: Express + http.Server + gateway; graceful shutdown
│   ├── config.js           env → validated config (per-section overrides for tests)
│   ├── logger.js           tiny leveled logger (JSON in production)
│   ├── auth.js             POST /api/login (JWT) · POST /api/ticket (one-time) · TicketStore
│   ├── metrics.js          RateWindow · Metrics · GET /metrics (JSON / Prometheus)
│   ├── ws/
│   │   ├── gateway.js      upgrade auth, origin, heartbeat sweep, rate limit, parse → router
│   │   ├── protocol.js     zod envelope + per-type payload schemas, reply/error builders
│   │   ├── router.js       MessageRouter: type → handler, results → ok, throws → error
│   │   ├── hub.js          Client (send + backpressure) · Hub (registry, broadcast)
│   │   └── rateLimit.js    TokenBucket
│   ├── chat/
│   │   ├── handlers.js     channel:*, chat:*, typing:*, presence:*, sys:* handlers + welcome
│   │   ├── channels.js     Channel (seq, history, idempotency, reactions) · ChannelStore
│   │   ├── ringBuffer.js   fixed-size history
│   │   ├── typing.js       TTL'd typing state, change-only broadcasts
│   │   └── presence.js     first-connect / last-disconnect presence
│   └── media/
│       ├── index.js        optional mediasoup bootstrap (falls back to media_unavailable)
│       ├── workerPool.js   N workers, round-robin, 'died' → close rooms + respawn
│       ├── Room.js         Router + AudioLevelObserver + peers; active speaker
│       ├── Peer.js         transports / producers / consumers per connection
│       ├── handlers.js     MediaService: all media:* signaling handlers
│       └── codecs.js       router media codecs (opus, VP8, H264)
├── public/
│   ├── index.html · styles.css
│   ├── bundle.js           ← built by esbuild (git-ignored)
│   └── src/
│       ├── main.js         app state + rendering + wiring
│       ├── ws-client.js    HuddleSocket: backoff+jitter, request(), outbox, ping, events
│       ├── media-client.js HuddleMedia: Device, transports, produce/consume, mute/cam/screen
│       ├── huddle-view.js  video grid tiles, audio sinks, active-speaker ring
│       ├── api.js          login, ticket → ws URL, session storage
│       ├── dom.js          escapeHtml, safe mini-markdown, avatars, toasts
│       └── icons.js        inline SVG icons
└── test/
    ├── protocol.test.js    schemas, error codes, RingBuffer, TokenBucket
    ├── auth.test.js        tickets (one-time, expiry), /api/login, /api/ticket, /metrics
    ├── integration.test.js login → ticket → WS → join → send → broadcast; upgrade rejections;
    │                       idempotency; reactions; typing; presence; rate limit; reconnect+resync
    └── media.test.js       real server + HuddleMedia/FakeHandler: produce/consume/pause/close/leave,
                            worker SIGKILL → room closed → respawn → rejoin
```

## Which chapter each file demonstrates

| File | Chapter(s) | Concept |
|---|---|---|
| `src/server.js` | 3, 12 | Express and `ws` sharing one `http.Server`; graceful shutdown (1001) |
| `src/ws/gateway.js` | 2, 3, 5, 6 | `noServer` + `upgrade`, rejecting before the handshake, heartbeat sweep, origin check, rate limit, `maxPayload` |
| `src/ws/protocol.js` | 4, 6 | Envelope, zod validation, stable error codes, strict schemas against mass-assignment |
| `src/ws/router.js` | 4 | Type-based dispatch, request/response with `replyTo` |
| `src/ws/hub.js` | 4, 5 | Rooms and broadcast (serialize once), backpressure with `bufferedAmount` |
| `src/ws/rateLimit.js` | 6 | Token bucket |
| `src/auth.js` | 6 | JWT over HTTP, one-time WebSocket tickets |
| `src/chat/*` | 4, 5 | Channels, presence, typing, reactions; seq cursors for replay; idempotency keys |
| `src/metrics.js` | 9, 12 | Moving-window rates, Prometheus exposition |
| `src/media/workerPool.js` | 11, 12 | Worker per core, round-robin, `died` handling |
| `src/media/Room.js`, `Peer.js` | 11 | Router per room, transport/producer/consumer ownership, AudioLevelObserver |
| `src/media/handlers.js` | 10, 11 | Signaling over the WebSocket; paused consumers; `canConsume` |
| `public/src/ws-client.js` | 4, 5 | Promise request map with timeouts, reconnect with backoff and jitter, outbox, ping |
| `public/src/media-client.js` | 10, 11 | mediasoup-client Device, transports, `connect` and `produce` events, simulcast |
| `public/src/main.js` | 4, 5 | Resync after reconnect, optimistic UI, offline outbox, epoch detection |
| `test/*` | 9 | `node:test` integration over real sockets, a Node-side browser client, FakeHandler |
| (not in this repo) | 7, 8 | Socket.IO comparison; Redis fan-out (see extension ideas) |

## Ideas for extension

1. **Scale out with Redis (Chapter 8).** Move `Hub.broadcast` behind Redis pub/sub (channel `huddle:chan:<id>`), store tickets in Redis with `SET … EX 30 NX` plus `GETDEL`, and keep history in Redis Streams (`XADD`/`XRANGE` by seq). Pin each huddle to one node, or use `pipeToRouter` across hosts.
2. **Persistence.** Replace `RingBuffer` with SQLite or Postgres. Keep `seq` per channel as the resync cursor.
3. **Recording.** Use a `PlainTransport` for each producer to feed FFmpeg or GStreamer. Add a `media:startRecording` message and show a red dot for everyone.
4. **Threads, DMs and mentions.** Add `replyToMessageId`, a DM channel type with two members, and `@name` notifications through `presence`.
5. **Adaptive video.** Call `consumer.setPreferredLayers()` based on tile size, and pause consumers for off-screen tiles.
6. **Browser E2E tests.** Use Playwright with `--use-fake-device-for-media-stream`: two contexts, chat, join the huddle, and assert that `videoWidth > 0`.
7. **Moderation.** Add delete/edit (`chat:edit` with a version number), per-channel roles, and kick from a huddle (`transport.close()` server-side).
8. **Live media stats dashboard.** Stream `transport.getStats()` to an admin dashboard every 2 s.
