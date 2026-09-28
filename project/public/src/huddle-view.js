// Video grid: one tile per participant (+ one per screen share). Tiles show
// video when a video track exists, an avatar otherwise, a muted badge, and a
// green ring on the active speaker.
import { avatar, escapeHtml } from './dom.js';
import { icons } from './icons.js';

export class HuddleView {
  #tiles = new Map(); // key (peerId or peerId:screen) -> element
  #users = new Map(); // peerId -> user

  constructor({ grid, audioSink }) {
    this.grid = grid;
    this.audioSink = audioSink;
  }

  clear() {
    this.grid.innerHTML = '';
    this.audioSink.innerHTML = '';
    this.#tiles.clear();
    this.#users.clear();
  }

  addPeer(peerId, user, { local = false } = {}) {
    this.#users.set(peerId, user);
    this.#tile(peerId, { local });
  }

  removePeer(peerId) {
    for (const [key, el] of this.#tiles) {
      if (key === peerId || key.startsWith(`${peerId}:`)) {
        el.remove();
        this.#tiles.delete(key);
      }
    }
    this.audioSink.querySelectorAll(`[data-peer="${CSS.escape(peerId)}"]`).forEach((a) => a.remove());
    this.#users.delete(peerId);
  }

  #tile(peerId, { local = false, screen = false } = {}) {
    const key = screen ? `${peerId}:screen` : peerId;
    let el = this.#tiles.get(key);
    if (el) return el;
    const user = this.#users.get(peerId) ?? { name: '…', color: '#555' };
    el = document.createElement('div');
    el.className = `tile${local && !screen ? ' mirror' : ''}${screen ? ' screen' : ''}`;
    el.dataset.peer = peerId;
    el.innerHTML = `${avatar(user, 72)}<video autoplay playsinline muted hidden></video>
      <div class="tile-label"><span class="muted-ico">${icons.micOff}</span>${escapeHtml(user.name)}${local ? ' (you)' : ''}${screen ? ' · screen' : ''}</div>`;
    if (!screen) el.classList.add('mic-off'); // until an unpaused audio track shows up
    this.#tiles.set(key, el);
    if (screen) this.grid.prepend(el);
    else this.grid.append(el);
    return el;
  }

  /** Attach a track (local or remote) to the right tile / audio element. */
  attach({ peerId, source, track, local = false, paused = false }) {
    if (track.kind === 'audio') {
      const tile = this.#tile(peerId, { local });
      tile.classList.toggle('mic-off', paused);
      if (local) return; // never play your own mic back
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.peer = peerId;
      audio.dataset.source = source;
      audio.srcObject = new MediaStream([track]);
      this.audioSink.append(audio);
      audio.play().catch(() => {}); // autoplay policies: user already clicked "Join"
      return;
    }
    const tile = this.#tile(peerId, { local, screen: source === 'screen' });
    const video = tile.querySelector('video');
    video.srcObject = new MediaStream([track]);
    video.hidden = false;
    tile.querySelector('.avatar').hidden = true;
    video.play().catch(() => {});
  }

  detach({ peerId, source, kind }) {
    if (kind === 'audio') {
      this.audioSink.querySelectorAll(`[data-peer="${CSS.escape(peerId)}"]`).forEach((a) => a.remove());
      this.#tiles.get(peerId)?.classList.add('mic-off');
      return;
    }
    if (source === 'screen') {
      const key = `${peerId}:screen`;
      this.#tiles.get(key)?.remove();
      this.#tiles.delete(key);
      return;
    }
    const tile = this.#tiles.get(peerId);
    if (!tile) return;
    const video = tile.querySelector('video');
    video.srcObject = null;
    video.hidden = true;
    tile.querySelector('.avatar').hidden = false;
  }

  setMuted(peerId, muted) {
    this.#tiles.get(peerId)?.classList.toggle('mic-off', muted);
  }

  setActiveSpeaker(peerId) {
    for (const [key, el] of this.#tiles) el.classList.toggle('speaking', peerId !== null && key === peerId);
  }

  get count() {
    return this.#users.size;
  }
}

