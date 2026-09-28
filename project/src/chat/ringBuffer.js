// Fixed-size history: O(1) push, oldest entries fall off. Memory per channel
// is bounded no matter how chatty it gets.
export class RingBuffer {
  #items;
  #start = 0;
  #size = 0;

  constructor(capacity) {
    this.capacity = capacity;
    this.#items = new Array(capacity);
  }

  push(item) {
    const end = (this.#start + this.#size) % this.capacity;
    this.#items[end] = item;
    if (this.#size < this.capacity) this.#size++;
    else this.#start = (this.#start + 1) % this.capacity; // overwrite oldest
  }

  get size() {
    return this.#size;
  }

  at(i) {
    if (i < 0 || i >= this.#size) return undefined;
    return this.#items[(this.#start + i) % this.capacity];
  }

  toArray() {
    return Array.from({ length: this.#size }, (_, i) => this.at(i));
  }

  /** Last `n` items (in order). */
  last(n) {
    const from = Math.max(0, this.#size - n);
    return Array.from({ length: this.#size - from }, (_, i) => this.at(from + i));
  }

  find(pred) {
    for (let i = this.#size - 1; i >= 0; i--) {
      const it = this.at(i);
      if (pred(it)) return it;
    }
    return undefined;
  }
}
