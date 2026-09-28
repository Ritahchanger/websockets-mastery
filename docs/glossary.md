# Glossary

Plain-English definitions of every key term in the course, in alphabetical order. Each entry links to the chapter(s) where the idea is explained in depth. New to networking? Start with [Chapter 0 — HTTP & TCP in 10 minutes](00-http-tcp-primer.md).

---

## 0–9

<a id="1006"></a>

### 1006 (Abnormal Closure)

A close code that is never sent on the wire: the browser reports it locally when the TCP connection dropped without a proper close frame, or when the handshake was rejected. The most common close code you'll see while debugging. → [Chapter 1](01-fundamentals.md), [Chapter 9](09-testing-debugging.md)

---

## A

<a id="ack"></a>

### Ack (acknowledgement)

A reply that says "I received and processed your message". Used to build at-least-once delivery (resend until acked); Socket.IO has acks built in as a callback argument. → [Chapter 5](05-reliability.md), [Chapter 7](07-socketio.md)

<a id="active-speaker"></a>

### Active speaker

Detecting which participant is currently talking, from audio levels. mediasoup provides an `ActiveSpeakerObserver` / `AudioLevelObserver` for this. → [Chapter 11](11-mediasoup.md), [Chapter 13](13-capstone-huddle.md)

<a id="adapter"></a>

### Adapter (Socket.IO)

A plug-in that lets several Socket.IO servers share rooms and broadcasts, e.g. `@socket.io/redis-adapter`, which relays emits between nodes through Redis pub/sub. → [Chapter 8](08-scaling.md)

<a id="announcedaddress"></a>

### announcedAddress

The public IP (or hostname) mediasoup writes into its ICE candidates when the server listens on a private address, e.g. a cloud VM behind 1:1 NAT. Getting it wrong is the #1 reason media doesn't flow in production. → [Chapter 11](11-mediasoup.md), [Chapter 12](12-production.md)

<a id="at-least-once-delivery"></a>

### At-least-once delivery

A guarantee that a message will arrive one or more times: the sender retries until it gets an ack. Duplicates are possible, so the receiver must be idempotent. → [Chapter 5](05-reliability.md)

---

## B

<a id="backoff"></a>

### Backoff (exponential)

Waiting longer after each failed reconnect attempt (e.g. 0.5 s, 1 s, 2 s, 4 s... up to a cap) so clients don't hammer a server that is down. → [Chapter 5](05-reliability.md)

<a id="backpressure"></a>

### Backpressure

What happens when a sender produces data faster than the receiver or network can take it: buffers grow. Handling backpressure means noticing (e.g. via `bufferedAmount`) and slowing down, dropping, or disconnecting. → [Chapter 1](01-fundamentals.md), [Chapter 5](05-reliability.md)

<a id="bandwidth"></a>

### Bandwidth

How much data per second a connection can carry. Not the same as latency: a wide pipe can still be a long one. → [Chapter 0](00-http-tcp-primer.md), [Chapter 10](10-webrtc-fundamentals.md)

<a id="binary-frame"></a>

### Binary frame

A WebSocket frame with opcode `0x2` whose payload is arbitrary bytes. Browsers deliver it as a `Blob` or `ArrayBuffer` (see `binaryType`); `ws` delivers a `Buffer` with `isBinary === true`. → [Chapter 1](01-fundamentals.md), [Chapter 2](02-first-server-ws.md)

<a id="binarytype"></a>

### binaryType

A property on a WebSocket that chooses how received binary messages are delivered: `'blob'` (browser default) or `'arraybuffer'`. → [Chapter 1](01-fundamentals.md), [Chapter 2](02-first-server-ws.md)

<a id="broadcast"></a>

### Broadcast

Sending the same message to many connections, usually by looping over a set of sockets (all clients, or the members of a room). Serialize once, check `readyState`. → [Chapter 2](02-first-server-ws.md), [Chapter 4](04-messaging-patterns.md)

<a id="bufferedamount"></a>

### bufferedAmount

The number of bytes you've passed to `send()` that haven't been handed to the network yet. If it keeps growing, the peer or network is too slow: a signal of backpressure. → [Chapter 1](01-fundamentals.md), [Chapter 5](05-reliability.md)

---

## C

<a id="candidate"></a>

### Candidate (ICE candidate)

One possible network address (IP + port + protocol) where a WebRTC peer might be reachable: a local address (`host`), a public one discovered via STUN (`srflx`), or a TURN relay (`relay`). → [Chapter 10](10-webrtc-fundamentals.md)

<a id="close-code"></a>

### Close code

A number sent in a close frame explaining why the connection ended: `1000` normal, `1001` going away, `1008` policy violation, `1011` server error, and `4000–4999` for your own application codes. → [Chapter 1](01-fundamentals.md), [Chapter 5](05-reliability.md)

<a id="close-frame-closing-handshake"></a>

### Close frame / closing handshake

A control frame (opcode `0x8`) that starts a clean shutdown. Each side sends one, then the TCP connection is closed, ideally by the server. → [Chapter 1](01-fundamentals.md)

<a id="cluster"></a>

### Cluster (`node:cluster`)

Node's built-in way to run one worker process per CPU core behind a shared port. With WebSockets it still needs sticky routing and cross-process pub/sub. → [Chapter 8](08-scaling.md)

<a id="connection-state-recovery"></a>

### Connection state recovery

A Socket.IO feature that, after a short disconnect, restores the socket's rooms and replays missed events, so the client can pick up where it left off. → [Chapter 7](07-socketio.md)

<a id="consumer"></a>

### Consumer (mediasoup)

The server-side object that sends one Producer's media *to* one client over that client's receive transport. Created paused, resumed once the client is ready. → [Chapter 11](11-mediasoup.md)

<a id="control-frame"></a>

### Control frame

A WebSocket frame for protocol housekeeping rather than data: ping, pong and close. Max 125-byte payload, never fragmented, can be interleaved between fragments of a data message. → [Chapter 1](01-fundamentals.md)

<a id="cookie"></a>

### Cookie

A small value the server sets (`Set-Cookie`) that the browser sends back automatically with later requests to the same site, including the WebSocket handshake. Handy for auth, dangerous without an Origin check. → [Chapter 0](00-http-tcp-primer.md), [Chapter 3](03-express-integration.md), [Chapter 6](06-security.md)

<a id="cors"></a>

### CORS

Cross-Origin Resource Sharing: the browser rules that decide which other sites may read your HTTP responses. It does **not** apply to WebSockets, so you must check `Origin` yourself. → [Chapter 6](06-security.md)

<a id="cswsh"></a>

### CSWSH (Cross-Site WebSocket Hijacking)

An attack where a malicious website opens a WebSocket to your server and the browser automatically attaches the victim's cookies. Prevented by checking the `Origin` header during the handshake (and/or using tickets instead of cookies). → [Chapter 6](06-security.md)

---

## D

<a id="data-channel"></a>

### Data channel

A WebRTC channel for arbitrary messages that flows peer-to-peer (or via an SFU), can be unordered/unreliable, and is useful for game state or file transfer. In mediasoup: DataProducer/DataConsumer. → [Chapter 10](10-webrtc-fundamentals.md), [Chapter 11](11-mediasoup.md)

<a id="device"></a>

### Device (mediasoup-client)

The browser-side object in `mediasoup-client` that loads the router's `rtpCapabilities`, learns what the browser can do, and creates send/receive transports. → [Chapter 11](11-mediasoup.md)

<a id="dispatcher-router"></a>

### Dispatcher / router (messages)

One function that looks at each incoming message's `type` and calls the matching handler from a map. The WebSocket equivalent of Express routing and middleware. → [Chapter 4](04-messaging-patterns.md)

<a id="dtls-srtp"></a>

### DTLS-SRTP

The encryption WebRTC always uses for media: a DTLS handshake (TLS over UDP) exchanges keys, then audio/video packets are encrypted with SRTP. There is no unencrypted WebRTC. → [Chapter 10](10-webrtc-fundamentals.md)

---

## E

<a id="envelope"></a>

### Envelope

The standard shape of every message in this course: `{ type, id, payload, replyTo? }`. It lets you route, correlate replies, and validate consistently. → [Chapter 4](04-messaging-patterns.md)

<a id="ephemeral-port"></a>

### Ephemeral port

The random port number the OS assigns to the client side of a TCP connection. A proxy or load generator can run out of them when opening many connections to one backend. → [Chapter 0](00-http-tcp-primer.md), [Chapter 8](08-scaling.md)

<a id="extension"></a>

### Extension (WebSocket)

A negotiated change to how frames are encoded, requested with `Sec-WebSocket-Extensions`. In practice this means `permessage-deflate`. → [Chapter 1](01-fundamentals.md)

---

## F

<a id="file-descriptor"></a>

### File descriptor

The OS handle for an open file or socket. Every WebSocket uses one, so a server with many connections needs a high `ulimit -n`. → [Chapter 8](08-scaling.md)

<a id="fin-bit"></a>

### FIN bit

The first bit of a WebSocket frame: 1 means "this is the last frame of the message". Messages split across several frames have FIN = 0 on all but the last. → [Chapter 1](01-fundamentals.md)

<a id="fragmentation"></a>

### Fragmentation

Splitting one WebSocket message into several frames (a first frame, then continuation frames). Libraries reassemble them, so your code always receives whole messages. → [Chapter 1](01-fundamentals.md)

<a id="frame"></a>

### Frame

The unit a WebSocket actually sends on the wire: a 2–14 byte header (FIN, opcode, mask bit, length, optional masking key) followed by the payload. One message is one or more frames. → [Chapter 1](01-fundamentals.md)

<a id="full-duplex"></a>

### Full duplex

Both sides can send at the same time, like a phone call. TCP is full duplex, and WebSockets expose that to your code. Contrast with half duplex (one at a time, like a walkie-talkie) and HTTP's request/response. → [Chapter 0](00-http-tcp-primer.md), [Chapter 1](01-fundamentals.md)

---

## G

<a id="glare"></a>

### Glare

In WebRTC, both peers sending an offer at the same moment, which breaks naive negotiation. The perfect negotiation pattern resolves it. → [Chapter 10](10-webrtc-fundamentals.md)

<a id="graceful-shutdown"></a>

### Graceful shutdown

Stopping a server without dropping users abruptly: stop accepting new connections, close existing ones with code `1001` (going away) so clients reconnect elsewhere, drain, then exit. → [Chapter 5](05-reliability.md), [Chapter 12](12-production.md)

---

## H

<a id="half-duplex"></a>

### Half duplex

Both directions are possible, but only one at a time (a walkie-talkie). HTTP/1.1 request/response behaves this way. → [Chapter 0](00-http-tcp-primer.md)

<a id="handleupgrade"></a>

### handleUpgrade

The `ws` method that performs the WebSocket handshake on a raw socket you received from Node's `'upgrade'` event, used with `noServer: true` after you've done routing and auth. → [Chapter 3](03-express-integration.md)

<a id="handshake"></a>

### Handshake (opening)

The HTTP request/response that turns a normal connection into a WebSocket: the client sends `GET` with `Upgrade: websocket` and a `Sec-WebSocket-Key`; the server replies `101 Switching Protocols` with the matching `Sec-WebSocket-Accept`. → [Chapter 1](01-fundamentals.md), [Chapter 3](03-express-integration.md)

<a id="heartbeat"></a>

### Heartbeat

Sending regular pings and expecting pongs to detect connections that died silently (closed laptop, lost Wi-Fi). If no pong arrives in time, terminate the socket. → [Chapter 5](05-reliability.md)

<a id="http-keep-alive"></a>

### HTTP keep-alive

Reusing one TCP connection for several HTTP requests in a row instead of reconnecting each time. Saves round trips, but it is still request/response. → [Chapter 0](00-http-tcp-primer.md)

---

## I

<a id="ice"></a>

### ICE (Interactive Connectivity Establishment)

WebRTC's process for finding a network path between two peers: each gathers candidates, they exchange them over signaling, and ICE tests pairs until one works. → [Chapter 10](10-webrtc-fundamentals.md)

<a id="idempotency"></a>

### Idempotency

An operation is idempotent if doing it twice has the same effect as doing it once (e.g. "join room", or "store message with id X" deduped by id). Essential when retries and timeouts can cause duplicates. → [Chapter 4](04-messaging-patterns.md), [Chapter 5](05-reliability.md)

<a id="isalive-sweep"></a>

### isAlive sweep

The common `ws` heartbeat pattern: mark every socket `isAlive = false` on an interval, send a ping, set it back to `true` on pong, and terminate any socket still `false` at the next sweep. → [Chapter 5](05-reliability.md)

---

## J

<a id="jitter"></a>

### Jitter

Randomness added to retry delays so thousands of clients don't reconnect at the same instant after an outage (the thundering herd). In media, jitter also means variation in packet arrival times. → [Chapter 5](05-reliability.md)

<a id="jwt"></a>

### JWT (JSON Web Token)

A signed token carrying claims such as the user id and an expiry. Used for HTTP auth; the capstone exchanges it for a short-lived WebSocket ticket. → [Chapter 6](06-security.md), [Chapter 13](13-capstone-huddle.md)

---

## L

<a id="latency"></a>

### Latency

How long data takes to travel from one point to another. For interactive apps it matters more than bandwidth. → [Chapter 0](00-http-tcp-primer.md)

<a id="long-polling"></a>

### Long polling

A fallback technique where the client makes an HTTP request that the server holds open until it has data (or times out), then the client immediately asks again. → [Chapter 1](01-fundamentals.md), [Chapter 7](07-socketio.md)

---

## M

<a id="masking"></a>

### Masking

XOR-scrambling every client-to-server frame's payload with a random 4-byte key sent alongside it. It protects old proxies from cache-poisoning attacks. It is **not** encryption. → [Chapter 1](01-fundamentals.md)

<a id="maxpayload"></a>

### maxPayload

The `ws` option that caps the size of a single incoming message. Set it low (e.g. 64 KiB) to prevent memory-exhaustion attacks; the default is 100 MiB. → [Chapter 2](02-first-server-ws.md), [Chapter 6](06-security.md)

<a id="mcu"></a>

### MCU (Multipoint Control Unit)

A video-conferencing server that decodes every participant's stream, mixes them into one composite video, and re-encodes it. Cheap for clients, very expensive for the server. → [Chapter 11](11-mediasoup.md)

<a id="mesh"></a>

### Mesh

A WebRTC topology where every participant connects directly to every other one. Simple, no media server, but upload bandwidth grows with each peer, so it stops working at about 4 participants. → [Chapter 10](10-webrtc-fundamentals.md), [Chapter 11](11-mediasoup.md)

<a id="messagepack"></a>

### MessagePack

A compact binary alternative to JSON. Worth it when measurements show JSON size or parsing is a bottleneck. → [Chapter 4](04-messaging-patterns.md)

<a id="message"></a>

### Message (WebSocket)

One complete unit of application data (text or binary) as your code sees it in `send()` and `onmessage`. Made of one or more frames. → [Chapter 1](01-fundamentals.md)

---

## N

<a id="namespace"></a>

### Namespace (Socket.IO)

A separate communication channel (e.g. `/chat`, `/admin`) multiplexed over one Socket.IO connection, each with its own handlers, rooms and middleware. → [Chapter 7](07-socketio.md)

<a id="nat"></a>

### NAT (Network Address Translation)

What your home router does: many devices share one public IP, and the router rewrites addresses. It blocks unsolicited incoming connections, which is why WebRTC needs STUN and sometimes TURN. → [Chapter 10](10-webrtc-fundamentals.md)

<a id="noserver-mode"></a>

### noServer mode

Creating `new WebSocketServer({ noServer: true })` so `ws` doesn't listen on its own; you receive upgrades from your HTTP server's `'upgrade'` event and call `handleUpgrade` yourself. The production pattern with Express. → [Chapter 2](02-first-server-ws.md), [Chapter 3](03-express-integration.md)

---

## O

<a id="opcode"></a>

### Opcode

A 4-bit field in each frame saying what kind it is: `0x1` text, `0x2` binary, `0x0` continuation, `0x8` close, `0x9` ping, `0xA` pong. → [Chapter 1](01-fundamentals.md)

<a id="origin"></a>

### Origin

A request header set by browsers naming the site (scheme + host + port) that made the request. Pages can't forge it, so checking it during the handshake is your defence against CSWSH. → [Chapter 0](00-http-tcp-primer.md), [Chapter 3](03-express-integration.md), [Chapter 6](06-security.md)

---

## P

<a id="perfect-negotiation"></a>

### Perfect negotiation

A W3C pattern for WebRTC renegotiation where one peer is "polite" (yields on collision) and the other "impolite" (ignores the colliding offer), so glare can never deadlock. → [Chapter 10](10-webrtc-fundamentals.md)

<a id="permessage-deflate"></a>

### permessage-deflate

The WebSocket compression extension (RFC 7692). Saves bandwidth for text-heavy traffic but costs CPU and memory per connection, so `ws` leaves it off by default; it can also enable compression bombs. → [Chapter 1](01-fundamentals.md), [Chapter 2](02-first-server-ws.md), [Chapter 6](06-security.md)

<a id="ping-pong"></a>

### Ping / Pong

Control frames: one side sends a ping, the other must answer with a pong carrying the same data. The building block of heartbeats. Browsers answer pings automatically but can't send them. → [Chapter 1](01-fundamentals.md), [Chapter 5](05-reliability.md)

<a id="pipetransport"></a>

### PipeTransport

A mediasoup transport that connects two routers (on the same machine or different hosts) so a producer on one can be consumed on the other. Used via `pipeToRouter` to scale a room past one CPU core. → [Chapter 11](11-mediasoup.md), [Chapter 12](12-production.md)

<a id="plaintransport"></a>

### PlainTransport

A mediasoup transport for plain RTP without ICE/DTLS, typically used to send media to or from tools like FFmpeg or GStreamer (e.g. for recording). → [Chapter 11](11-mediasoup.md)

<a id="port"></a>

### Port

A number (1–65535) that identifies which program on a machine a connection is for. `http` defaults to 80, `https`/`wss` to 443. → [Chapter 0](00-http-tcp-primer.md)

<a id="presence"></a>

### Presence

Knowing who is online (or in a room) right now, and broadcasting joins and leaves. Ephemeral state that must be cleaned up on disconnect. → [Chapter 4](04-messaging-patterns.md), [Chapter 8](08-scaling.md)

<a id="producer"></a>

### Producer (mediasoup)

The server-side object representing one media track (e.g. a camera or mic) that a client is sending into the router over its send transport. → [Chapter 11](11-mediasoup.md)

<a id="pub-sub"></a>

### Pub/sub (publish/subscribe)

A messaging pattern where senders publish to a named channel and every subscriber of that channel receives it. With Redis pub/sub, a message published by one server reaches clients connected to all servers. → [Chapter 8](08-scaling.md)

---

## R

<a id="rate-limiting"></a>

### Rate limiting

Capping how many messages a connection may send per time window, so one client can't flood the server. Usually implemented with a token bucket. → [Chapter 6](06-security.md), [Chapter 13](13-capstone-huddle.md)

<a id="readystate"></a>

### readyState

A socket's current state: `CONNECTING` (0), `OPEN` (1), `CLOSING` (2), `CLOSED` (3). Check for `OPEN` before sending to other sockets. → [Chapter 1](01-fundamentals.md), [Chapter 2](02-first-server-ws.md)

<a id="reconnection"></a>

### Reconnection

Automatically opening a new WebSocket after the old one dropped, with exponential backoff and jitter, and then resyncing any state missed in between. → [Chapter 5](05-reliability.md), [Chapter 13](13-capstone-huddle.md)

<a id="replay-buffer"></a>

### Replay buffer

A server-side store of recent messages with sequence numbers, so a reconnecting client can say "I last saw #41" and receive everything after it. → [Chapter 5](05-reliability.md), [Chapter 13](13-capstone-huddle.md)

<a id="request-response-over-websocket"></a>

### Request/response over WebSocket

Emulating an HTTP-style call on a socket: send a message with a unique `id`, keep a pending promise, and resolve it when a reply with `replyTo === id` arrives (or reject on timeout or close). → [Chapter 4](04-messaging-patterns.md)

<a id="reverse-proxy"></a>

### Reverse proxy

A server (nginx, Caddy, a cloud load balancer) in front of your app that terminates TLS and forwards traffic. For WebSockets it must pass the `Upgrade` and `Connection` headers and allow long idle timeouts. → [Chapter 8](08-scaling.md), [Chapter 12](12-production.md)

<a id="room"></a>

### Room (channel)

A named group of connections that receive the same broadcasts, typically `Map<roomName, Set<client>>`. Socket.IO has rooms built in. → [Chapter 4](04-messaging-patterns.md), [Chapter 7](07-socketio.md)

<a id="router"></a>

### Router (mediasoup)

A mediasoup object that represents one media "room": it holds a set of codecs (`rtpCapabilities`) and forwards packets from producers to consumers. Lives inside a Worker. → [Chapter 11](11-mediasoup.md)

<a id="rtpcapabilities"></a>

### rtpCapabilities

A description of which codecs and RTP features an endpoint supports. The client's Device loads the router's capabilities, and the server checks `router.canConsume(...)` against the client's before creating a Consumer. → [Chapter 11](11-mediasoup.md)

<a id="rtp-rtcp"></a>

### RTP / RTCP

The protocols that carry real-time audio/video packets (RTP) and their feedback and statistics (RTCP). Encrypted as SRTP in WebRTC. → [Chapter 10](10-webrtc-fundamentals.md), [Chapter 11](11-mediasoup.md)

<a id="rtt"></a>

### RTT (round-trip time)

The time for a message to reach the other side and a reply to come back. Every ask-and-wait step costs at least one RTT, which is why long-lived connections feel fast. → [Chapter 0](00-http-tcp-primer.md), [Chapter 1](01-fundamentals.md)

---

## S

<a id="sdp"></a>

### SDP (Session Description Protocol)

A text format describing a WebRTC session: which media tracks, codecs, encryption fingerprints and so on. Peers exchange an SDP *offer* and *answer* over your signaling channel. → [Chapter 10](10-webrtc-fundamentals.md)

<a id="sec-websocket-key-sec-websocket-accept"></a>

### Sec-WebSocket-Key / Sec-WebSocket-Accept

The handshake headers: the client sends a random key, and the server proves it understands WebSockets by returning `base64(sha1(key + fixed GUID))`. It is not authentication. → [Chapter 1](01-fundamentals.md)

<a id="server-sent-events"></a>

### Server-Sent Events (SSE)

A browser API (`EventSource`) for a one-way stream of text events from server to client over plain HTTP, with automatic reconnection. Simpler than WebSockets when only the server talks. → [Chapter 1](01-fundamentals.md)

<a id="sfu"></a>

### SFU (Selective Forwarding Unit)

A media server that receives each participant's stream once and forwards copies to the others without decoding or mixing. Scales far better than mesh and far cheaper than an MCU; mediasoup is an SFU. → [Chapter 11](11-mediasoup.md)

<a id="signaling"></a>

### Signaling

Exchanging the setup information (SDP offers and answers, ICE candidates) two WebRTC peers need before media can flow. WebRTC doesn't define how, and a WebSocket is the usual choice. → [Chapter 10](10-webrtc-fundamentals.md), [Chapter 11](11-mediasoup.md)

<a id="simulcast"></a>

### Simulcast

The sender encodes the same video at several resolutions or bitrates at once, and the SFU forwards the most suitable layer to each receiver based on their bandwidth and screen size. → [Chapter 11](11-mediasoup.md)

<a id="socket-io"></a>

### Socket.IO

A library built on top of WebSockets (with an HTTP long-polling fallback) that adds its own protocol: events, acks, rooms, namespaces, automatic reconnection. Not compatible with plain WebSocket clients. → [Chapter 7](07-socketio.md)

<a id="sticky-session"></a>

### Sticky session

Load-balancer routing that always sends the same client to the same backend server. Required by Socket.IO's polling transport; plain WebSockets don't strictly need it, since a connection is already pinned to one server. → [Chapter 8](08-scaling.md)

<a id="stun"></a>

### STUN

A simple server that tells a WebRTC client its public IP address and port as seen from the internet, so it can offer that as a candidate. Cheap, but can't get through every NAT. → [Chapter 10](10-webrtc-fundamentals.md)

<a id="subprotocol"></a>

### Subprotocol

An application-level protocol name agreed during the handshake with `Sec-WebSocket-Protocol` (e.g. `graphql-transport-ws`, `chat.v1`). Useful for versioning your message format. → [Chapter 1](01-fundamentals.md), [Chapter 3](03-express-integration.md)

<a id="svc"></a>

### SVC (Scalable Video Coding)

A codec technique (e.g. VP9, AV1) that packs multiple quality layers into one stream. Like simulcast, it lets an SFU send each receiver only the layers it can handle. → [Chapter 11](11-mediasoup.md)

---

## T

<a id="tcp"></a>

### TCP (Transmission Control Protocol)

The transport that gives two programs a connection with a reliable, ordered **byte stream**. It has no message boundaries, which is why WebSockets add frames on top. → [Chapter 0](00-http-tcp-primer.md), [Chapter 1](01-fundamentals.md)

<a id="text-frame"></a>

### Text frame

A WebSocket frame with opcode `0x1` whose payload must be valid UTF-8. Browsers deliver it as a string. → [Chapter 1](01-fundamentals.md), [Chapter 2](02-first-server-ws.md)

<a id="thundering-herd"></a>

### Thundering herd

Many clients all doing the same thing at the same moment, such as reconnecting right after a server restart and overloading it again. Solved with backoff plus jitter. → [Chapter 5](05-reliability.md)

<a id="ticket"></a>

### Ticket (WebSocket auth ticket)

A short-lived, single-use random token that the client fetches over authenticated HTTP and then passes when opening the WebSocket (e.g. in the query string). Safer than long-lived tokens in URLs or cookie-only auth. → [Chapter 6](06-security.md), [Chapter 13](13-capstone-huddle.md)

<a id="tls"></a>

### TLS (Transport Layer Security)

Encryption and server identity (certificates) layered between TCP and HTTP/WebSocket. It's the "s" in `https` and `wss`. Always use it in production. → [Chapter 0](00-http-tcp-primer.md), [Chapter 6](06-security.md), [Chapter 12](12-production.md)

<a id="token-bucket"></a>

### Token bucket

A rate-limiting algorithm: a bucket refills with tokens at a steady rate up to a maximum, and each message costs a token. Allows short bursts but caps the long-term rate. → [Chapter 6](06-security.md), [Chapter 13](13-capstone-huddle.md)

<a id="transport"></a>

### Transport (mediasoup)

A mediasoup object representing one network connection between the router and an endpoint, over which producers and consumers carry media. Types: WebRtcTransport, PlainTransport, PipeTransport, DirectTransport. → [Chapter 11](11-mediasoup.md)

<a id="trickle-ice"></a>

### Trickle ICE

Sending each ICE candidate over signaling as soon as it's discovered instead of waiting for gathering to finish, which makes calls connect faster. → [Chapter 10](10-webrtc-fundamentals.md)

<a id="turn"></a>

### TURN

A relay server that forwards WebRTC media when a direct connection is impossible (strict NATs or firewalls). Always works, but costs server bandwidth. `coturn` is the usual implementation. → [Chapter 10](10-webrtc-fundamentals.md), [Chapter 12](12-production.md)

---

## U

<a id="udp"></a>

### UDP

A connectionless transport that sends independent packets with no guarantee of delivery or order. Preferred for real-time media, where late data is useless anyway. → [Chapter 0](00-http-tcp-primer.md), [Chapter 10](10-webrtc-fundamentals.md)

<a id="upgrade"></a>

### Upgrade (HTTP)

The HTTP/1.1 mechanism (`Connection: Upgrade` + `Upgrade: websocket`) for switching an existing connection to another protocol. In Node it arrives as the `'upgrade'` event on `http.Server`, not as a normal request. → [Chapter 0](00-http-tcp-primer.md), [Chapter 1](01-fundamentals.md), [Chapter 3](03-express-integration.md)

---

## V

<a id="volatile-event"></a>

### Volatile event (Socket.IO)

A Socket.IO emit that may be dropped if the client isn't ready, for data where only the latest value matters (cursor positions, live metrics). → [Chapter 7](07-socketio.md)

---

## W

<a id="webrtc"></a>

### WebRTC

The browser technology for real-time peer-to-peer audio, video and data. It carries media over UDP with DTLS-SRTP and relies on you to provide signaling (usually over a WebSocket). → [Chapter 10](10-webrtc-fundamentals.md)

<a id="webrtcserver"></a>

### WebRtcServer (mediasoup)

A mediasoup object that lets many WebRtcTransports share a single UDP/TCP port per worker, which makes firewall rules and Docker networking much simpler. → [Chapter 12](12-production.md)

<a id="webrtctransport"></a>

### WebRtcTransport

The mediasoup transport type used by browsers: it does ICE, DTLS and SRTP. Each client usually has two, one for sending and one for receiving. → [Chapter 11](11-mediasoup.md)

<a id="websocket"></a>

### WebSocket

A protocol (RFC 6455) that upgrades an HTTP connection into a persistent, full-duplex, message-based channel with tiny per-message overhead. `ws://` is plain, `wss://` runs over TLS. → [Chapter 1](01-fundamentals.md), [Chapter 2](02-first-server-ws.md)

<a id="worker"></a>

### Worker (mediasoup)

A separate C++ process that mediasoup spawns to do the actual media work. Usually one per CPU core; if it dies, its routers die too, so handle the `died` event. → [Chapter 11](11-mediasoup.md), [Chapter 12](12-production.md)

<a id="ws"></a>

### ws (library)

The most widely used WebSocket library for Node.js: a fast, spec-compliant server and client with no extra features such as rooms or reconnection. Used throughout this course. → [Chapter 2](02-first-server-ws.md)

<a id="wss"></a>

### wss://

WebSocket over TLS: encrypted, on port 443 by default. Required for production and from any `https://` page. → [Chapter 0](00-http-tcp-primer.md), [Chapter 6](06-security.md), [Chapter 12](12-production.md)

---

Back to the [course README](../README.md) · Start at [Chapter 0](00-http-tcp-primer.md)
