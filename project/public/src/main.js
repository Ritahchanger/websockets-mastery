// Huddle browser app: glue between HuddleSocket (transport), HuddleMedia
// (mediasoup) and the DOM. State lives in one plain object; render functions
// read it. Server events mutate state, then re-render the affected part.
import { HuddleSocket } from './ws-client.js';
import { HuddleMedia } from './media-client.js';
import { HuddleView } from './huddle-view.js';
import { login, wsUrl, loadSession, saveSession, serverConfig } from './api.js';
import { $, $$, escapeHtml, renderText, avatar, timeOf, dayLabel, toast } from './dom.js';
import { icons } from './icons.js';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🚀'];
const GROUP_WINDOW_MS = 5 * 60_000;
const uid = () => crypto.randomUUID();

const state = {
  session: null, // { token, user }
  clientId: null,
  epoch: null, // server history epoch (changes when the server restarts)
  active: 'general',
  channels: new Map(), // id -> { info, messages[], lastSeq, unread, typing[], hasMore, joined }
  presence: new Map(), // userId -> user
  huddles: new Map(), // roomId -> participants[]
  outbox: new Map(), // clientMsgId -> { channelId, text } (unsent while offline)
  mediaAvailable: false,
  initialised: false,
  rejoinHuddle: null, // roomId to rejoin after a reconnect / worker death
};

let socket;
let media;
let view;

// =========================================================================
// Boot & login
// =========================================================================

function boot() {
  $('#new-channel').innerHTML = icons.plus;
  $('#logout').innerHTML = icons.logout;
  $('#send').innerHTML = icons.send;
  $('.channel-title .hash').innerHTML = icons.hash;

  const session = loadSession();
  if (session?.token) startApp(session);
  else showLogin(sessionStorage.getItem('huddle.flash'));
  sessionStorage.removeItem('huddle.flash');

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter ?? $('#login-form button');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      const session = await login($('#nickname').value);
      saveSession(session);
      startApp(session);
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function showLogin(message) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message ?? '';
  $('#nickname').focus();
}

async function startApp(session) {
  state.session = session;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me-avatar').innerHTML = avatar(session.user, 34);
  $('#me-name').textContent = session.user.name;

  serverConfig()
    .then((c) => {
      state.mediaAvailable = c.media;
      renderHeader();
    })
    .catch(() => {});

  socket = new HuddleSocket({ getUrl: () => wsUrl(session.token) });
  media = new HuddleMedia(socket);
  view = new HuddleView({ grid: $('#grid'), audioSink: $('#audio-sink') });
  wireSocket();
  wireMedia();
  wireUi();
  socket.connect();
}

function logout(message) {
  media?.leave().catch(() => {});
  socket?.close();
  saveSession(null);
  location.hash = '';
  // Simplest way to drop every piece of in-memory state:
  if (message) sessionStorage.setItem('huddle.flash', message);
  location.reload();
}

// =========================================================================
// Socket events -> state
// =========================================================================

function wireSocket() {
  socket.addEventListener('state', (e) => renderConn(e.detail.state));
  socket.addEventListener('latency', (e) => ($('#latency').textContent = `${e.detail.ms} ms`));
  socket.addEventListener('fatal', () => logout('Your session expired — please sign in again.'));
  socket.addEventListener('servererror', (e) => toast(e.detail.message, 'error'));

  let countdown;
  socket.addEventListener('reconnecting', (e) => {
    clearInterval(countdown);
    const tick = () => {
      const s = Math.max(0, Math.ceil((e.detail.at - Date.now()) / 1000));
      $('#banner-text').textContent = `Connection lost. Reconnecting${s ? ` in ${s}s` : '…'} (attempt ${e.detail.attempt})`;
    };
    tick();
    countdown = setInterval(tick, 250);
    $('#banner').hidden = false;
  });

  socket.addEventListener('close', () => {
    $('#latency').textContent = 'offline';
    // The server dropped our mediasoup Peer with the socket. Tear down locally
    // and remember to rejoin once we're back.
    if (media.active) {
      state.rejoinHuddle = media.roomId;
      media.leave({ silent: true });
      hideHuddle();
    }
  });

  socket.addEventListener('open', (e) => {
    clearInterval(countdown);
    $('#banner').hidden = true;
    if (e.detail.reconnected) toast('Reconnected', 'success', 1800);
  });

  // Every connection starts with a welcome. First one: initial load.
  // Later ones: we reconnected, so catch up on what we missed.
  socket.on('session:welcome', (w) => {
    const restarted = state.epoch !== null && state.epoch !== w.epoch;
    state.epoch = w.epoch;
    state.clientId = w.clientId;
    applySnapshot(w);
    if (!state.initialised) {
      state.initialised = true;
      initialJoin();
    } else {
      resync({ restarted });
    }
  });

  socket.on('chat:message', ({ message, clientMsgId }) => addMessage(message, clientMsgId));

  socket.on('chat:reaction', ({ channelId, messageId, reactions }) => {
    const ch = state.channels.get(channelId);
    const msg = ch?.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.reactions = reactions;
    if (channelId === state.active) renderMessages({ keepScroll: true });
  });

  socket.on('typing:update', ({ channelId, users }) => {
    const ch = state.channels.get(channelId);
    if (!ch) return;
    ch.typing = users.filter((u) => u.id !== state.session.user.id);
    if (channelId === state.active) renderTyping();
  });

  socket.on('presence:update', ({ user, status }) => {
    if (status === 'online') state.presence.set(user.id, user);
    else state.presence.delete(user.id);
    renderUsers();
  });

  socket.on('channel:created', ({ channel, by }) => {
    upsertChannel(channel);
    joinChannel(channel.id).catch(() => {});
    if (by.id !== state.session.user.id) toast(`${by.name} created #${channel.name}`);
    renderChannels();
  });

  socket.on('huddle:update', ({ roomId, participants }) => {
    if (participants.length) state.huddles.set(roomId, participants);
    else state.huddles.delete(roomId);
    renderChannels();
    renderUsers();
    renderHeader();
  });
}

function applySnapshot({ channels, presence, huddles }) {
  const ids = new Set(channels.map((c) => c.id));
  for (const id of state.channels.keys()) if (!ids.has(id)) state.channels.delete(id); // gone after a restart
  for (const c of channels) upsertChannel(c);
  if (!state.channels.has(state.active)) state.active = 'general';
  state.presence = new Map(presence.map((p) => [p.user.id, p.user]));
  state.presence.set(state.session.user.id, state.session.user);
  state.huddles = new Map(huddles.map((h) => [h.roomId, h.participants]));
  renderChannels();
  renderUsers();
  renderHeader();
}

function upsertChannel(info) {
  const existing = state.channels.get(info.id);
  if (existing) existing.info = info;
  else state.channels.set(info.id, { info, messages: [], lastSeq: 0, unread: 0, typing: [], hasMore: false, joined: false });
}

async function initialJoin() {
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (state.channels.has(fromHash)) state.active = fromHash;
  // Subscribe to every channel so unread badges work; history for all of them.
  await Promise.allSettled([...state.channels.keys()].map((id) => joinChannel(id)));
  selectChannel(state.active);
}

async function joinChannel(channelId) {
  const res = await socket.request('channel:join', { channelId });
  const ch = state.channels.get(channelId);
  ch.joined = true;
  ch.info = res.channel;
  ch.messages = res.messages;
  ch.hasMore = res.gap;
  ch.lastSeq = res.messages.at(-1)?.seq ?? 0;
  ch.typing = res.typing.filter((u) => u.id !== state.session.user.id);
  if (channelId === state.active) {
    renderMessages();
    renderTyping();
  }
}

/**
 * After a reconnect: ONE request returns a fresh snapshot plus every message
 * we missed (seq > lastSeq) in each channel. Then flush the outbox (same
 * clientMsgId, so the server de-duplicates anything that did get through)
 * and rejoin the huddle if we were in one.
 */
async function resync({ restarted = false } = {}) {
  try {
    if (restarted) {
      // The server lost its memory: our seq cursors point at nothing. Start
      // over. (Unsent messages survive in the outbox and are re-sent below.)
      for (const ch of state.channels.values()) Object.assign(ch, { messages: [], lastSeq: 0, joined: false });
      await Promise.allSettled([...state.channels.keys()].map((id) => joinChannel(id)));
    } else {
      const cursors = {};
      for (const [id, ch] of state.channels) if (ch.joined) cursors[id] = ch.lastSeq;
      const res = await socket.request('sys:resync', { channels: cursors });
      applySnapshot(res);
      for (const [channelId, r] of Object.entries(res.missed)) {
        for (const m of r.messages) addMessage(m, null, { silent: channelId === state.active });
        state.channels.get(channelId).typing = r.typing.filter((u) => u.id !== state.session.user.id);
      }
      for (const [id, ch] of state.channels) if (!ch.joined) joinChannel(id).catch(() => {});
    }
  } catch (err) {
    console.warn('resync failed', err);
    return;
  }
  for (const [clientMsgId, { channelId, text }] of state.outbox) sendMessage(channelId, text, clientMsgId);
  if (state.rejoinHuddle) {
    const roomId = state.rejoinHuddle;
    state.rejoinHuddle = null;
    joinHuddle(roomId);
  }
  renderMessages({ keepScroll: true });
}

function addMessage(message, clientMsgId, { silent = false } = {}) {
  const ch = state.channels.get(message.channelId);
  if (!ch) return;
  ch.lastSeq = Math.max(ch.lastSeq, message.seq);
  if (clientMsgId) {
    state.outbox.delete(clientMsgId);
    const i = ch.messages.findIndex((m) => m.clientMsgId === clientMsgId);
    if (i >= 0) {
      ch.messages[i] = message; // optimistic -> confirmed
      if (message.channelId === state.active) renderMessages({ keepScroll: true });
      return;
    }
  }
  if (ch.messages.some((m) => m.id === message.id)) return;
  ch.messages.push(message);
  ch.messages.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  const mine = message.user.id === state.session.user.id;
  if (message.channelId !== state.active || document.hidden) {
    if (!mine) ch.unread++;
    renderChannels();
    renderTitle();
  }
  if (message.channelId === state.active && !silent) renderMessages({ animateId: message.id });
}

// =========================================================================
// Sending, typing, reactions, channels
// =========================================================================

async function sendMessage(channelId, text, clientMsgId = uid()) {
  const ch = state.channels.get(channelId);
  state.outbox.set(clientMsgId, { channelId, text });
  let pending = ch.messages.find((m) => m.clientMsgId === clientMsgId);
  if (!pending) {
    pending = { id: clientMsgId, clientMsgId, pending: true, user: state.session.user, text, ts: Date.now(), reactions: {} };
    ch.messages.push(pending);
  }
  pending.failed = false;
  if (channelId === state.active) renderMessages({ animateId: pending.id });
  // Offline: don't let the transport queue it — it would be flushed before we
  // re-join channels. The outbox is replayed at the end of resync().
  if (socket.state !== 'open') return;

  try {
    const { message } = await socket.request('chat:send', { channelId, text, clientMsgId });
    addMessage(message, clientMsgId);
  } catch (err) {
    if (err.code === 'disconnected' || err.code === 'timeout') return; // stays in outbox, retried on resync
    state.outbox.delete(clientMsgId);
    pending.failed = true;
    toast(`Message not sent: ${err.message}`, 'error');
    if (channelId === state.active) renderMessages({ keepScroll: true });
  }
}

let typingSentAt = 0;
function onComposerInput() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  $('#send').disabled = !el.value.trim();
  // Throttle: tell the server at most every 3s; its TTL expires us if we stop.
  if (el.value.trim() && Date.now() - typingSentAt > 3000) {
    typingSentAt = Date.now();
    socket.notify('typing:start', { channelId: state.active });
  } else if (!el.value.trim() && typingSentAt) {
    stopTyping();
  }
}

function stopTyping() {
  if (!typingSentAt) return;
  typingSentAt = 0;
  socket.notify('typing:stop', { channelId: state.active });
}

async function react(messageId, emoji) {
  try {
    await socket.request('chat:react', { channelId: state.active, messageId, emoji });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadOlder() {
  const ch = state.channels.get(state.active);
  const before = ch.messages.find((m) => m.seq)?.seq;
  if (!before) return;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const res = await socket.request('chat:history', { channelId: state.active, before, limit: 50 });
  ch.messages = [...res.messages, ...ch.messages];
  ch.hasMore = res.hasMore;
  renderMessages({ keepScroll: true });
  box.scrollTop = box.scrollHeight - prevHeight; // stay where the reader was
}

function selectChannel(id) {
  if (!state.channels.has(id)) return;
  if (state.active !== id) stopTyping();
  state.active = id;
  const ch = state.channels.get(id);
  ch.unread = 0;
  history.replaceState(null, '', `#${id}`);
  $('#input').placeholder = `Message #${ch.info.name}`;
  $('.app').classList.remove('show-sidebar');
  renderChannels();
  renderHeader();
  renderMessages();
  renderTyping();
  renderTitle();
  $('#input').focus();
}

// =========================================================================
// Huddle (video)
// =========================================================================

function wireMedia() {
  media.addEventListener('peerJoined', (e) => view.addPeer(e.detail.id, e.detail.user));
  media.addEventListener('peerLeft', (e) => view.removePeer(e.detail.peerId));
  media.addEventListener('track', (e) => view.attach(e.detail));
  media.addEventListener('trackEnded', (e) => view.detach(e.detail));
  media.addEventListener('trackPaused', (e) => e.detail.source === 'mic' && view.setMuted(e.detail.peerId, true));
  media.addEventListener('trackResumed', (e) => e.detail.source === 'mic' && view.setMuted(e.detail.peerId, false));
  media.addEventListener('activeSpeaker', (e) => view.setActiveSpeaker(e.detail.peerId));
  media.addEventListener('localTrack', (e) => {
    view.attach({ peerId: state.clientId, source: e.detail.source, track: e.detail.track, local: true });
    renderControls();
  });
  media.addEventListener('localTrackEnded', (e) => {
    const kind = e.detail.source === 'mic' ? 'audio' : 'video';
    view.detach({ peerId: state.clientId, source: e.detail.source, kind });
    renderControls();
  });
  media.addEventListener('error', (e) => toast(e.detail.message ?? String(e.detail), 'error'));
  media.addEventListener('left', (e) => {
    hideHuddle();
    if (e.detail.reason === 'worker_died') {
      toast('Media server hiccup — rejoining huddle…', 'error');
      setTimeout(() => joinHuddle(e.detail.roomId), 800);
    }
  });
}

async function joinHuddle(roomId = state.active) {
  if (!state.mediaAvailable) return toast('Video huddles are disabled on this server', 'error');
  if (!navigator.mediaDevices) return toast('Huddles need HTTPS (or localhost) for camera/mic access', 'error');
  view.clear();
  view.addPeer(state.clientId, state.session.user, { local: true });
  $('#huddle').hidden = false;
  $('#huddle').dataset.room = roomId;
  renderHeader();
  try {
    await media.join(roomId);
    renderHeader();
    renderControls();
    await media.startMic().catch((err) => toast(`Mic unavailable: ${err.message}`, 'error'));
  } catch (err) {
    hideHuddle();
    toast(`Could not join huddle: ${err.message}`, 'error');
  }
}

function hideHuddle() {
  $('#huddle').hidden = true;
  $('#huddle').classList.remove('expanded');
  view?.clear();
  renderHeader();
}

async function toggle(source) {
  try {
    if (source === 'mic') {
      const p = media.producers.get('mic');
      if (!p) await media.startMic();
      else {
        await media.setMicMuted(!p.paused);
        view.setMuted(state.clientId, p.paused);
      }
    } else if (media.producers.has(source)) {
      await media.stop(source);
    } else {
      await (source === 'cam' ? media.startCam() : media.startScreen());
    }
  } catch (err) {
    if (err.name !== 'NotAllowedError' || source !== 'screen') toast(`${source}: ${err.message}`, 'error');
  }
  renderControls();
}

function renderControls() {
  const mic = media.producers.get('mic');
  const micOn = mic && !mic.paused;
  const cam = media.producers.has('cam');
  const screen = media.producers.has('screen');
  const expanded = $('#huddle').classList.contains('expanded');
  const set = (id, html, cls) => {
    const b = $(id);
    b.innerHTML = html;
    b.classList.remove('on', 'off');
    if (cls) b.classList.add(cls);
  };
  set('#ctl-mic', micOn ? icons.mic : icons.micOff, micOn ? '' : 'off');
  set('#ctl-cam', cam ? icons.video : icons.videoOff, cam ? 'on' : '');
  set('#ctl-screen', icons.screen, screen ? 'on' : '');
  set('#ctl-size', expanded ? icons.minimize : icons.maximize);
  $('#ctl-leave').innerHTML = icons.phoneOff;
  if (mic) view.setMuted(state.clientId, !micOn);
}

// =========================================================================
// Rendering
// =========================================================================

function renderConn(s) {
  const labels = { connecting: 'Connecting…', open: 'Connected', reconnecting: 'Reconnecting…', closed: 'Offline', idle: '—' };
  $('#conn').dataset.state = s;
  $('#conn-label').textContent = labels[s] ?? s;
}

function renderTitle() {
  const unread = [...state.channels.values()].reduce((n, c) => n + c.unread, 0);
  document.title = unread ? `(${unread}) Huddle` : 'Huddle';
}

function renderChannels() {
  const list = [...state.channels.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
  $('#channel-list').innerHTML = list
    .map(({ info, unread }) => {
      const inHuddle = state.huddles.get(info.id)?.length;
      return `<li class="channel-item${info.id === state.active ? ' active' : ''}${unread ? ' unread' : ''}" data-id="${escapeHtml(info.id)}">
        <span class="ch-hash">${icons.hash}</span><span class="ch-name">${escapeHtml(info.name)}</span>
        ${inHuddle ? `<span class="huddle-live" title="Huddle in progress">${icons.headphones}${inHuddle}</span>` : ''}
        ${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}
      </li>`;
    })
    .join('');
}

function renderUsers() {
  const inHuddle = new Set([...state.huddles.values()].flat().map((u) => u.id));
  const users = [...state.presence.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('#online-count').textContent = users.length;
  $('#user-list').innerHTML = users
    .map(
      (u) => `<li class="user-item">${avatar(u, 26)}<span>${escapeHtml(u.name)}</span>
        ${u.id === state.session.user.id ? '<span class="you">you</span>' : ''}
        ${inHuddle.has(u.id) ? `<span class="in-huddle" title="In a huddle">${icons.headphones}</span>` : ''}</li>`,
    )
    .join('');
}

function renderHeader() {
  const ch = state.channels.get(state.active);
  if (!ch) return;
  $('#channel-name').textContent = ch.info.name;
  $('#channel-topic').textContent = ch.info.topic ?? '';
  const participants = state.huddles.get(state.active) ?? [];
  $('#huddle-faces').innerHTML = participants.slice(0, 5).map((u) => avatar(u, 26)).join('');
  const btn = $('#huddle-btn');
  const here = !$('#huddle').hidden && $('#huddle').dataset.room === state.active;
  btn.classList.toggle('in', here);
  btn.querySelector('.ico').innerHTML = here ? icons.phoneOff : icons.headphones;
  btn.querySelector('.label').textContent = here ? 'Leave huddle' : participants.length ? `Join huddle (${participants.length})` : 'Start huddle';
  btn.disabled = !state.mediaAvailable;
  btn.title = state.mediaAvailable ? '' : 'Media server disabled';
}

function renderTyping() {
  const users = state.channels.get(state.active)?.typing ?? [];
  const names = users.map((u) => `<b>${escapeHtml(u.name)}</b>`);
  const text =
    names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing';
  $('#typing').innerHTML = text ? `<span class="dots"><i></i><i></i><i></i></span><span>${text}</span>` : '';
}

function renderMessages({ keepScroll = false, animateId = null } = {}) {
  const box = $('#messages');
  const ch = state.channels.get(state.active);
  if (!ch) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const me = state.session.user.id;

  if (ch.messages.length === 0) {
    box.innerHTML = `<div class="empty"><div><div class="big">👋</div><h3>Welcome to #${escapeHtml(ch.info.name)}</h3><p>${escapeHtml(ch.info.topic || 'This is the very beginning of the channel.')}</p></div></div>`;
    return;
  }

  let html = ch.hasMore ? '<div class="load-more"><button class="btn btn-ghost btn-sm" data-action="older">Load earlier messages</button></div>' : '';
  let prev = null;
  for (const m of ch.messages) {
    const day = dayLabel(m.ts);
    if (!prev || dayLabel(prev.ts) !== day) {
      html += `<div class="day">${day}</div>`;
      prev = null;
    }
    const grouped = prev && prev.user.id === m.user.id && m.ts - prev.ts < GROUP_WINDOW_MS;
    const reactions = Object.entries(m.reactions ?? {})
      .map(([emoji, users]) => `<button class="reaction${users.includes(me) ? ' mine' : ''}" data-react="${escapeHtml(emoji)}" title="${users.length}">${emoji}<span class="n">${users.length}</span></button>`)
      .join('');
    const status = m.failed ? '<span class="status">failed</span>' : m.pending ? '<span class="status">sending…</span>' : '';
    const cls = ['msg', grouped ? '' : 'first', m.pending ? 'pending' : '', m.failed ? 'failed' : '', m.id === animateId ? 'new' : ''].join(' ');
    html += `<div class="${cls}" data-id="${escapeHtml(m.id)}">
      ${grouped ? `<div class="gutter">${timeOf(m.ts)}</div>` : avatar(m.user)}
      <div>
        ${grouped ? '' : `<div class="msg-head"><span class="msg-author" style="color:${escapeHtml(m.user.color)}">${escapeHtml(m.user.name)}</span><span class="msg-time">${timeOf(m.ts)}</span></div>`}
        <div class="msg-text">${renderText(m.text)}${status}</div>
        ${reactions ? `<div class="reactions">${reactions}</div>` : ''}
      </div>
      ${m.pending ? '' : `<div class="msg-tools">${QUICK_REACTIONS.map((e) => `<button data-react="${e}" title="React ${e}">${e}</button>`).join('')}</div>`}
    </div>`;
    prev = m;
  }
  box.innerHTML = html;
  if (!keepScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

// =========================================================================
// DOM wiring
// =========================================================================

function wireUi() {
  $('#channel-list').addEventListener('click', (e) => {
    const li = e.target.closest('.channel-item');
    if (li) selectChannel(li.dataset.id);
  });

  $('#messages').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-react]');
    if (btn) return react(btn.closest('.msg').dataset.id, btn.dataset.react);
    if (e.target.closest('[data-action="older"]')) loadOlder();
  });

  const input = $('#input');
  input.addEventListener('input', onComposerInput);
  input.addEventListener('blur', stopTyping);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onComposerInput();
    stopTyping();
    sendMessage(state.active, text);
  });
  $('#send').disabled = true;

  $('#huddle-btn').addEventListener('click', async () => {
    const here = !$('#huddle').hidden && $('#huddle').dataset.room === state.active;
    if (here) return media.leave();
    joinHuddle(state.active);
  });
  $('#ctl-mic').addEventListener('click', () => toggle('mic'));
  $('#ctl-cam').addEventListener('click', () => toggle('cam'));
  $('#ctl-screen').addEventListener('click', () => toggle('screen'));
  $('#ctl-leave').addEventListener('click', () => media.leave());
  $('#ctl-size').addEventListener('click', () => {
    $('#huddle').classList.toggle('expanded');
    renderControls();
  });

  $('#banner-retry').addEventListener('click', () => socket.reconnectNow());
  $('#logout').addEventListener('click', () => logout());
  $('#menu').addEventListener('click', () => $('.app').classList.toggle('show-sidebar'));

  const dialog = $('#channel-dialog');
  $('#new-channel').addEventListener('click', () => {
    $('#channel-error').textContent = '';
    $('#channel-form').reset();
    dialog.showModal();
  });
  $('#channel-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const name = $('#channel-name-input').value.trim().toLowerCase().replace(/\s+/g, '-');
    const topic = $('#channel-topic-input').value.trim() || undefined;
    try {
      const { channel } = await socket.request('channel:create', { name, topic });
      upsertChannel(channel);
      await joinChannel(channel.id);
      dialog.close();
      selectChannel(channel.id);
    } catch (err) {
      $('#channel-error').textContent = err.message;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const ch = state.channels.get(state.active);
      if (ch) ch.unread = 0;
      renderChannels();
      renderTitle();
    }
  });
  window.addEventListener('pagehide', () => media.active && media.leave());
}

// Expose for debugging in DevTools: `huddle.socket.request('sys:ping')`
globalThis.huddle = { state, get socket() { return socket; }, get media() { return media; } };

boot();
