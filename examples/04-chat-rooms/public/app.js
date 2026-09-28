// examples/04-chat-rooms/public/app.js
//
// Browser client for the multi-room chat.
//   Part 1: ChatSocket — envelope protocol, request/response with timeouts, events.
//   Part 2: UI state + rendering (vanilla DOM, textContent only => no XSS).

// ===========================================================================
// Part 1: ChatSocket
// ===========================================================================
class ChatSocket {
  #url;
  #ws = null;
  #pending = new Map(); // id -> { resolve, reject, timer }
  #listeners = new Map(); // type -> Set<fn>

  constructor(url) {
    this.#url = url;
  }

  connect() {
    const ws = new WebSocket(this.#url);
    this.#ws = ws;
    ws.addEventListener('open', () => this.#emit('open'));
    ws.addEventListener('message', (e) => this.#onMessage(e.data));
    ws.addEventListener('close', (e) => {
      // Reject every in-flight request: their replies will never come.
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(Object.assign(new Error('connection closed'), { code: 'CLOSED' }));
      }
      this.#pending.clear();
      this.#emit('close', { code: e.code, reason: e.reason });
    });
  }

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Request/response: resolves with the reply payload, rejects with {code, message}. */
  request(type, payload = {}, { timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(Object.assign(new Error('not connected'), { code: 'CLOSED' }));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(Object.assign(new Error(`${type} timed out`), { code: 'TIMEOUT' }));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ type, id, payload }));
    });
  }

  /** Fire-and-forget event (no id => server won't reply). */
  emit(type, payload = {}) {
    if (this.connected) this.#ws.send(JSON.stringify({ type, payload }));
  }

  on(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(fn);
    return () => this.#listeners.get(type).delete(fn); // unsubscribe
  }

  #emit(type, payload) {
    for (const fn of this.#listeners.get(type) ?? []) fn(payload);
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return console.warn('bad JSON from server', raw); }

    // 1. A reply to one of our requests?
    if (msg.replyTo && this.#pending.has(msg.replyTo)) {
      const { resolve, reject, timer } = this.#pending.get(msg.replyTo);
      clearTimeout(timer);
      this.#pending.delete(msg.replyTo);
      if (msg.type === 'error') reject(Object.assign(new Error(msg.payload.message), { code: msg.payload.code }));
      else resolve(msg.payload);
      return;
    }
    // 2. An error not tied to a request (e.g. malformed message).
    if (msg.type === 'error') return this.#emit('error', msg.payload);
    // 3. A server push: route by type.
    this.#emit(msg.type, msg.payload);
  }
}

// ===========================================================================
// Part 2: UI
// ===========================================================================
const $ = (id) => document.getElementById(id);
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const socket = new ChatSocket(wsUrl);

const state = {
  me: null, // { userId, nick }
  roomList: [], // [{ name, count, permanent }]
  joined: new Map(), // room -> { messages: [], members: [], typing: Map<userId, nick>, unread }
  active: null,
};

// ---- small helpers ---------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children); // strings become text nodes => safe from XSS
  return node;
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3000);
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const saveRooms = () => localStorage.setItem('rooms', JSON.stringify([...state.joined.keys()]));

// ---- rendering ---------------------------------------------------------------
function renderRooms() {
  // Show all known rooms, plus any we're in that the list hasn't caught up with yet.
  const names = new Set([...state.roomList.map((r) => r.name), ...state.joined.keys()]);
  const counts = Object.fromEntries(state.roomList.map((r) => [r.name, r.count]));
  $('rooms').replaceChildren(
    ...[...names].map((name) => {
      const joined = state.joined.get(name);
      const li = el('li', { className: [name === state.active && 'active', joined && 'joined'].filter(Boolean).join(' ') },
        el('span', { className: 'name', textContent: `# ${name}` }),
      );
      if (joined?.unread) li.append(el('span', { className: 'unread', textContent: joined.unread }));
      li.append(el('span', { className: 'count', textContent: counts[name] ?? '' }));
      li.onclick = () => openRoom(name);
      return li;
    }),
  );
}

function messageNode(m) {
  if (m.system) return el('div', { className: 'sys', textContent: m.text });
  const mine = m.from.id === state.me?.userId;
  return el('div', { className: `msg${mine ? ' mine' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}` },
    el('div', { className: 'meta' }, el('b', { textContent: mine ? 'you' : m.from.nick }), ` · ${m.failed ? 'failed' : m.pending ? 'sending…' : fmtTime(m.at)}`),
    m.text,
  );
}

function renderMessages() {
  const room = state.joined.get(state.active);
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren(...(room?.messages ?? []).map(messageNode));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderMembers() {
  const room = state.joined.get(state.active);
  $('memberList').replaceChildren(...(room?.members ?? []).map((u) =>
    el('li', { textContent: u.id === state.me?.userId ? `${u.nick} (you)` : u.nick })));
}

function renderTyping() {
  const names = [...(state.joined.get(state.active)?.typing.values() ?? [])];
  $('typing').textContent =
    names.length === 0 ? '' :
    names.length === 1 ? `${names[0]} is typing…` :
    names.length === 2 ? `${names[0]} and ${names[1]} are typing…` :
    'Several people are typing…';
}

function renderHeader() {
  $('roomTitle').textContent = state.active ? `# ${state.active}` : '# –';
  $('leaveBtn').disabled = !state.active;
  $('sendBtn').disabled = !state.active || !socket.connected;
  $('myNick').textContent = state.me?.nick ?? '–';
}

function renderAll() { renderRooms(); renderMessages(); renderMembers(); renderTyping(); renderHeader(); }

// ---- actions -----------------------------------------------------------------
async function joinRoom(name) {
  try {
    const { room, members, history } = await socket.request('room:join', { room: name });
    state.joined.set(room, { messages: history, members, typing: new Map(), unread: 0 });
    saveRooms();
    return room;
  } catch (err) {
    toast(`${err.code}: ${err.message}`);
    return null;
  }
}

async function openRoom(name) {
  if (!state.joined.has(name)) {
    const room = await joinRoom(name);
    if (!room) return;
    name = room; // server-normalized name (e.g. lower-cased)
  }
  state.active = name;
  state.joined.get(name).unread = 0;
  localStorage.setItem('active', name);
  renderAll();
  $('input').focus();
}

async function leaveActiveRoom() {
  const name = state.active;
  if (!name) return;
  try {
    await socket.request('room:leave', { room: name });
  } catch (err) {
    if (err.code !== 'NOT_IN_ROOM') return toast(err.message);
  }
  state.joined.delete(name);
  saveRooms();
  state.active = state.joined.keys().next().value ?? null;
  renderAll();
}

async function sendMessage(text) {
  const room = state.active;
  const r = state.joined.get(room);
  // Optimistic UI: show immediately as "sending…", then replace with the server's version.
  const temp = { from: { id: state.me.userId, nick: state.me.nick }, text, pending: true };
  r.messages.push(temp);
  renderMessages();
  stopTyping();
  try {
    const saved = await socket.request('chat:message', { room, text });
    Object.assign(temp, saved, { pending: false });
  } catch (err) {
    temp.pending = false;
    temp.failed = true;
    toast(`Not sent: ${err.message}`);
  }
  if (state.active === room) renderMessages();
}

// ---- typing (client-side throttle + idle timeout) -------------------------
let typingRoom = null, lastTypingSent = 0, idleTimer = null;
function onKeystroke() {
  if (!state.active) return;
  const now = Date.now();
  if (typingRoom !== state.active || now - lastTypingSent > 2500) {
    if (typingRoom && typingRoom !== state.active) socket.emit('chat:typing', { room: typingRoom, typing: false });
    typingRoom = state.active;
    lastTypingSent = now;
    socket.emit('chat:typing', { room: typingRoom, typing: true });
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopTyping, 3000);
}
function stopTyping() {
  clearTimeout(idleTimer);
  if (typingRoom) socket.emit('chat:typing', { room: typingRoom, typing: false });
  typingRoom = null;
  lastTypingSent = 0;
}

// ---- server pushes -------------------------------------------------------------
socket.on('chat:message', (m) => {
  const r = state.joined.get(m.room);
  if (!r) return;
  r.messages.push(m);
  r.typing.delete(m.from.id);
  if (m.room === state.active) { renderMessages(); renderTyping(); }
  else { r.unread++; renderRooms(); }
});

socket.on('chat:typing', ({ room, user, typing }) => {
  const r = state.joined.get(room);
  if (!r) return;
  if (typing) r.typing.set(user.id, user.nick); else r.typing.delete(user.id);
  if (room === state.active) renderTyping();
});

socket.on('presence:update', ({ room, members, change }) => {
  const r = state.joined.get(room);
  if (!r) return;
  r.members = members;
  if (change && change.user.id !== state.me?.userId) {
    const text =
      change.kind === 'join' ? `${change.user.nick} joined` :
      change.kind === 'leave' ? `${change.user.nick} left` :
      `${change.from} is now ${change.user.nick}`;
    r.messages.push({ system: true, text });
    if (change.kind === 'leave') r.typing.delete(change.user.id);
  }
  if (room === state.active) { renderMessages(); renderMembers(); renderTyping(); }
});

socket.on('room:list', ({ rooms }) => { state.roomList = rooms; renderRooms(); });
socket.on('error', (e) => toast(`${e.code}: ${e.message}`));

// ---- connection lifecycle ---------------------------------------------------
function askNick(errorText = '') {
  return new Promise((resolve) => {
    $('nickErr').textContent = errorText;
    $('nickInput').value = localStorage.getItem('nick') ?? '';
    $('nickDialog').showModal();
    $('nickForm').onsubmit = () => resolve($('nickInput').value.trim());
  });
}

async function hello() {
  let nick = localStorage.getItem('nick') || (await askNick());
  for (;;) {
    try {
      const me = await socket.request('session:hello', { nick });
      localStorage.setItem('nick', me.nick);
      return me;
    } catch (err) {
      if (err.code === 'CLOSED') throw err;
      nick = await askNick(err.message); // NICK_TAKEN / VALIDATION -> ask again
    }
  }
}

socket.on('open', async () => {
  $('status').classList.add('on');
  $('banner').classList.remove('show');
  try {
    state.me = await hello();
    state.roomList = state.me.rooms;
    // Re-join everything we were in (also after a reconnect). room:join is idempotent.
    const wanted = JSON.parse(localStorage.getItem('rooms') ?? '["general"]');
    state.joined.clear();
    for (const name of wanted.length ? wanted : ['general']) await joinRoom(name);
    const active = localStorage.getItem('active');
    state.active = state.joined.has(active) ? active : state.joined.keys().next().value ?? null;
    renderAll();
  } catch (err) {
    console.warn('session setup failed', err);
  }
});

socket.on('close', () => {
  $('status').classList.remove('on');
  $('banner').classList.add('show');
  renderHeader();
  // Naive fixed-delay reconnect. Chapter 5 replaces this with exponential backoff + jitter.
  setTimeout(() => socket.connect(), 2000);
});

// ---- DOM events ----------------------------------------------------------------
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || !state.active || !socket.connected) return;
  $('input').value = '';
  sendMessage(text);
});
$('input').addEventListener('input', onKeystroke);
$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('joinInput').value.trim().toLowerCase();
  if (name) openRoom(name);
  $('joinInput').value = '';
});
$('leaveBtn').addEventListener('click', leaveActiveRoom);
$('renameBtn').addEventListener('click', async () => {
  const nick = await askNick();
  try {
    const { nick: newNick } = await socket.request('user:nick', { nick });
    state.me.nick = newNick;
    localStorage.setItem('nick', newNick);
    renderAll();
  } catch (err) {
    toast(err.message);
  }
});

socket.connect();
