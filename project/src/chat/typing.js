// Typing indicators are ephemeral and lossy by design: never stored, expire on
// their own (clients may crash mid-sentence), and only changes are broadcast.
export class TypingTracker {
  #state = new Map(); // channelId -> Map<userId, { user, timer }>

  constructor({ ttlMs, onChange }) {
    this.ttlMs = ttlMs;
    this.onChange = onChange; // (channelId, users[]) => void
  }

  start(channelId, user) {
    let ch = this.#state.get(channelId);
    if (!ch) this.#state.set(channelId, (ch = new Map()));
    const existing = ch.get(user.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.stop(channelId, user.id), this.ttlMs);
    timer.unref();
    ch.set(user.id, { user, timer });
    if (!existing) this.#emit(channelId);
  }

  stop(channelId, userId) {
    const ch = this.#state.get(channelId);
    const entry = ch?.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    ch.delete(userId);
    if (ch.size === 0) this.#state.delete(channelId);
    this.#emit(channelId);
  }

  stopEverywhere(userId) {
    for (const channelId of [...this.#state.keys()]) this.stop(channelId, userId);
  }

  users(channelId) {
    return [...(this.#state.get(channelId)?.values() ?? [])].map((e) => e.user);
  }

  #emit(channelId) {
    this.onChange(channelId, this.users(channelId));
  }
}
