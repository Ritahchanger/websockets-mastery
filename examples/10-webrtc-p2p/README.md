# Example 10 — WebRTC P2P mesh with ws signaling

Chapter: [docs/10-webrtc-fundamentals.md](../../docs/10-webrtc-fundamentals.md)

An Express + `ws` signaling server that relays SDP offers/answers and ICE candidates inside a room. The browser client uses the **perfect negotiation** pattern for a 1:1 or small-mesh (max 4) video call, with a P2P data-channel chat and a live stats caption (candidate type, uplink kbps, RTT).

```bash
npm run ex:10                                   # from the repo root
# open http://localhost:3000/?room=demo&name=alice  and  ?room=demo&name=bob
node examples/10-webrtc-p2p/test-signaling.js   # headless relay test (no browser needed)
```

Env: `PORT` (3000), `MAX_PEERS` (4), `STUN_URL`, `TURN_URL` (comma-separated), `TURN_USERNAME`, `TURN_CREDENTIAL`.

Camera access needs a secure context: `localhost` works, but a LAN IP needs HTTPS (see ch.12).
