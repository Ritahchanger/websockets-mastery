// Token bucket: `capacity` tokens, refilled continuously at `refillPerSec`.
// Allows short bursts (typing fast, joining a huddle = ~8 requests at once)
// while capping the sustained rate.
export class TokenBucket {
  constructor({ capacity, refillPerSec, now = () => performance.now() }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.now = now;
    this.last = now();
  }

  take(cost = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
