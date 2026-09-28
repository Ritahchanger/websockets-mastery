# Example 12 — production configs

Chapter: [docs/12-production.md](../../docs/12-production.md)

These are configuration files to adapt, not a runnable server. They deploy `examples/11-mediasoup-minimal` (or the Huddle capstone):

| File | Purpose |
|---|---|
| `Caddyfile` | TLS (automatic Let's Encrypt) + WSS reverse proxy |
| `nginx.conf` | the same with nginx: Upgrade headers, long read timeouts |
| `Dockerfile` | multi-stage build of the ch.11 SFU (prebuilt mediasoup worker) |
| `docker-compose.yml` | SFU + coturn + Redis, **`network_mode: host`** for media |
| `turnserver.conf` | coturn with TLS, HMAC (`use-auth-secret`) credentials, private-range deny rules |
| `huddle-sfu.service` | systemd unit (restart, graceful drain, `LimitNOFILE`) |
| `ecosystem.config.cjs` | PM2 in **fork** mode (never cluster mode for mediasoup) |

```bash
PUBLIC_IP=203.0.113.10 docker compose -f examples/12-production/docker-compose.yml up -d --build
```
