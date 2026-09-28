// examples/10-webrtc-p2p/public/app.js
const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const roomName = params.get('room') ?? 'demo';
const displayName = params.get('name') ?? `guest-${Math.random().toString(36).slice(2, 6)}`;
$('#room').textContent = roomName;

let selfId = null;
let localStream = null;
let iceServers = [];
/** peerId -> { id, pc, name, polite, makingOffer, ignoreOffer, isSettingRemoteAnswerPending, mediaAttached, dc, tile, queue } */
const peers = new Map();
const names = new Map();

// ---------------------------------------------------------------- signaling (ch.4 envelope)
let ws;
const pending = new Map(); // request id -> { resolve, reject }

function send(type, payload) {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type, id, payload }));
  return id;
}

function request(type, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const id = send(type, payload);
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id) && reject(new Error(`${type} timed out`)), timeoutMs);
  });
}

const signal = (to, data) => send('signal', { to, data });

function connectSignaling() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onclose = () => setStatus('signaling closed');
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.replyTo && pending.has(msg.replyTo)) {
        const { resolve, reject } = pending.get(msg.replyTo);
        pending.delete(msg.replyTo);
        return msg.type === 'error' ? reject(new Error(msg.payload.code)) : resolve(msg.payload);
      }
      switch (msg.type) {
        case 'peer:joined': names.set(msg.payload.id, msg.payload.name); break; // they will call us
        case 'peer:left': closePeer(msg.payload.id); break;
        case 'signal': enqueue(msg.payload.from, msg.payload.data); break;
        case 'error': console.warn('server error', msg.payload); break;
      }
    };
  });
}

// ---------------------------------------------------------------- peers
function createPeer(id, { initiator }) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = {
    id, pc, name: names.get(id) ?? id.slice(0, 6),
    polite: selfId > id,            // any rule both sides agree on
    makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false,
    mediaAttached: false, dc: null, tile: addTile(id), queue: Promise.resolve(),
  };
  peers.set(id, peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      signal(id, { description: pc.localDescription });
    } catch (err) {
      console.error('negotiation failed', err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => signal(id, { candidate }); // null = end-of-candidates
  pc.ontrack = ({ streams: [stream] }) => { peer.tile.video.srcObject = stream; };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') pc.restartIce(); // triggers negotiationneeded with ICE restart
  };
  pc.onconnectionstatechange = () => {
    peer.tile.caption.textContent = `${peer.name} · ${pc.connectionState}`;
  };

  if (initiator) attachLocalMedia(peer); // → negotiationneeded → offer
  return peer;
}

// Add our tracks + a pre-negotiated data channel. Called up-front by the initiator,
// or by the answerer right AFTER setRemoteDescription(offer), so addTrack reuses the
// transceivers the offer created instead of adding extra m-lines.
function attachLocalMedia(peer) {
  if (peer.mediaAttached) return;
  peer.mediaAttached = true;
  for (const track of localStream.getTracks()) peer.pc.addTrack(track, localStream);
  // negotiated:true + same id on both sides → no 'datachannel' event / extra round trip
  peer.dc = peer.pc.createDataChannel('chat', { negotiated: true, id: 0 });
  peer.dc.onmessage = ({ data }) => log(`${peer.name}: ${data}`);
}

// Serialize signal handling per peer: each message waits for the previous one.
function enqueue(from, data) {
  const peer = peers.get(from) ?? createPeer(from, { initiator: false });
  peer.queue = peer.queue.then(() => handleSignal(peer, data)).catch((err) => console.error(err));
}

async function handleSignal(peer, { description, candidate }) {
  const { pc } = peer;
  if (description) {
    const readyForOffer =
      !peer.makingOffer && (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    peer.isSettingRemoteAnswerPending = description.type === 'answer';
    await pc.setRemoteDescription(description);
    peer.isSettingRemoteAnswerPending = false;

    if (description.type === 'offer') {
      attachLocalMedia(peer);            // no-op if already attached
      await pc.setLocalDescription();    // answer
      signal(peer.id, { description: pc.localDescription });
    }
  } else if (candidate !== undefined) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!peer.ignoreOffer) throw err;
    }
  }
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.tile.figure.remove();
  peers.delete(id);
  log(`${peer.name} left`);
}

// ---------------------------------------------------------------- UI helpers
function addTile(id) {
  const figure = document.createElement('figure');
  const video = Object.assign(document.createElement('video'), { autoplay: true, playsInline: true });
  const caption = document.createElement('figcaption');
  caption.textContent = names.get(id) ?? id.slice(0, 6);
  figure.append(video, caption);
  $('#grid').append(figure);
  return { figure, video, caption };
}
const setStatus = (text) => ($('#status').textContent = text);
const log = (line) => { $('#log').append(Object.assign(document.createElement('div'), { textContent: line })); $('#log').scrollTop = 1e9; };

// ---------------------------------------------------------------- stats: which path did ICE pick?
setInterval(async () => {
  for (const peer of peers.values()) {
    const stats = await peer.pc.getStats();
    let pair, local, outVideo;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      if (r.type === 'outbound-rtp' && r.kind === 'video') outVideo = r;
    });
    if (pair) local = stats.get(pair.localCandidateId);
    const kbps = outVideo && peer.lastBytes != null ? Math.round(((outVideo.bytesSent - peer.lastBytes) * 8) / 2000) : 0;
    peer.lastBytes = outVideo?.bytesSent;
    peer.tile.caption.textContent =
      `${peer.name} · ${peer.pc.connectionState} · ${local?.candidateType ?? '?'} · ↑${kbps} kbps · rtt ${pair?.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : '?'} ms`;
  }
}, 2000);

// ---------------------------------------------------------------- controls
$('#join').onclick = async () => {
  $('#join').disabled = true;
  try {
    setStatus('getting media…');
    ({ iceServers } = await (await fetch('/config')).json());
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 24 } }, // mesh-friendly
    });
    $('#local').srcObject = localStream;

    setStatus('connecting…');
    await connectSignaling();
    const joined = await request('room:join', { room: roomName, name: displayName });
    selfId = joined.selfId;
    for (const p of joined.peers) {
      names.set(p.id, p.name);
      createPeer(p.id, { initiator: true }); // newcomer calls everyone already here
    }
    setStatus(`in room as ${displayName} (${joined.peers.length} other peer(s))`);
    $('#mic').disabled = $('#cam').disabled = false;
  } catch (err) {
    setStatus(`error: ${err.message}`);
    $('#join').disabled = false;
  }
};

$('#mic').onclick = () => {
  const t = localStream.getAudioTracks()[0];
  t.enabled = !t.enabled;
  $('#mic').textContent = t.enabled ? 'Mute mic' : 'Unmute mic';
};
$('#cam').onclick = () => {
  const t = localStream.getVideoTracks()[0];
  t.enabled = !t.enabled;
  $('#cam').textContent = t.enabled ? 'Stop cam' : 'Start cam';
};
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (!text) return;
  for (const p of peers.values()) if (p.dc?.readyState === 'open') p.dc.send(text);
  log(`me: ${text}`);
  $('#chat-input').value = '';
};
