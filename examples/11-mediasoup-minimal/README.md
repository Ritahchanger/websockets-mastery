# Example 11 — minimal mediasoup SFU

Chapter: [docs/11-mediasoup.md](../../docs/11-mediasoup.md)

A single room where everyone publishes cam + mic (simulcast video) and consumes everyone else. It includes active-speaker highlighting, mute through producer pause, a receive-quality selector (`setPreferredLayers`), ICE restart, and a `/stats` endpoint. This example is **its own package** because of the native mediasoup worker and the bundled mediasoup-client.

```bash
cd examples/11-mediasoup-minimal
npm install            # downloads a prebuilt mediasoup-worker (else needs python3 + make + C++20 compiler)
npm run build:client   # esbuild: public/src/client.js → public/bundle.js
npm start              # http://localhost:3000/?name=alice
npm test               # headless signaling-flow test with ws clients
```

| Env | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP/WS port |
| `MEDIASOUP_NUM_WORKERS` | 1 | worker processes (1 per core in prod) |
| `MEDIASOUP_LISTEN_IP` | 0.0.0.0 | bind address for RTC sockets |
| `MEDIASOUP_ANNOUNCED_ADDRESS` | first LAN IPv4 | IP put in ICE candidates (the **public IP** on a cloud VM) |
| `MEDIASOUP_MIN_PORT` / `MAX_PORT` | 40000 / 40100 | RTC UDP/TCP port range (open it in the firewall) |
| `TLS_CERT` / `TLS_KEY` | – | serve HTTPS directly (phones on the LAN need a secure context) |
