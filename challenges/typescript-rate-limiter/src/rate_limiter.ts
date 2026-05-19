/**
 * Per-key token-bucket rate limiter.
 *
 * Each key (e.g. user id, IP, route) gets its own bucket with `capacity`
 * tokens that refills at `refillPerSec` tokens/second.
 *
 *   - `tryAcquire(key, cost?)` returns true and consumes tokens if available,
 *     false otherwise. Never blocks.
 *   - `acquire(key, cost?)`    resolves once enough tokens are available,
 *     sleeping until the bucket has refilled. Must not busy-wait.
 *
 * TODO(candidate): the starter has working single-key happy paths but several
 * bugs that the public tests partly reveal. Read the failing tests, then study
 * `refill()`, the constructor, and the slow path of `acquire()` before changing
 * anything.
 */

export type ClockFn = () => number;

export interface RateLimiterOptions {
  /** Maximum tokens a bucket can hold. Must be > 0. */
  capacity: number;
  /** Tokens added per second. Must be >= 0. Zero means a fixed cap with no refill. */
  refillPerSec: number;
  /** Idle TTL (ms): buckets unused for this long are garbage-collected on the next op. */
  idleTtlMs?: number;
  /** Injectable monotonic clock in ms — defaults to performance.now(). Useful for tests. */
  now?: ClockFn;
}

interface Bucket {
  tokens: number;
  lastRefill: number; // ms (monotonic)
  lastTouched: number; // ms (monotonic) — for idle eviction
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly idleTtlMs: number;
  private readonly now: ClockFn;
  private readonly buckets: Map<string, Bucket> = new Map();

  constructor(opts: RateLimiterOptions) {
    // TODO(candidate): the inputs above are not validated. A senior engineer
    //                  would reject zero/negative capacity and negative refill
    //                  rates here — instead of letting the limiter silently
    //                  produce nonsense token counts later.
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.idleTtlMs = opts.idleTtlMs ?? 60_000;
    this.now =
      opts.now ??
      (typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now());
  }

  /**
   * Attempt to consume `cost` tokens immediately. Returns true on success.
   * Never blocks.
   */
  tryAcquire(key: string, cost = 1): boolean {
    if (cost <= 0) {
      throw new RangeError("cost must be > 0");
    }
    if (cost > this.capacity) {
      // A request that can never fit must not stall the bucket forever.
      throw new RangeError("cost exceeds capacity");
    }
    const bucket = this.getBucket(key);
    this.refill(bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return true;
    }
    return false;
  }

  /**
   * Wait until `cost` tokens are available, then consume them.
   * Resolves promptly when capacity is available; otherwise sleeps until
   * the next refill could satisfy the request.
   */
  async acquire(key: string, cost = 1): Promise<void> {
    if (cost <= 0) {
      throw new RangeError("cost must be > 0");
    }
    if (cost > this.capacity) {
      throw new RangeError("cost exceeds capacity");
    }

    // Fast path.
    if (this.tryAcquire(key, cost)) {
      return;
    }

    const bucket = this.getBucket(key);
    while (true) {
      this.refill(bucket);
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return;
      }
      // TODO(candidate): the wait below is incomplete. When the bucket can
      //                  never refill (refillPerSec === 0) and the request
      //                  cannot be satisfied now, this loop runs forever
      //                  instead of telling the caller the request is
      //                  impossible. Make that failure mode explicit.
      const waitMs = this.msUntilTokens(bucket, cost);
      await sleep(waitMs);
    }
  }

  /** Current available token count for `key` (after applying refill). */
  available(key: string): number {
    const bucket = this.getBucket(key);
    this.refill(bucket);
    return bucket.tokens;
  }

  /** Remove the bucket for `key` (e.g. after the user logs out). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Remove all buckets. */
  clear(): void {
    this.buckets.clear();
  }

  /** Number of live buckets (post-eviction). For diagnostics and tests. */
  size(): number {
    this.evictIdle();
    return this.buckets.size;
  }

  private getBucket(key: string): Bucket {
    this.evictIdle();
    const t = this.now();
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = { tokens: this.capacity, lastRefill: t, lastTouched: t };
      this.buckets.set(key, b);
    } else {
      b.lastTouched = t;
    }
    return b;
  }

  private refill(bucket: Bucket): void {
    const t = this.now();
    const elapsedSec = (t - bucket.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    const added = elapsedSec * this.refillPerSec;
    // TODO(candidate): the line below has a cap-overflow bug. After a long
    //                  idle period the bucket can end up with more tokens
    //                  than `capacity`, which lets a caller burst past the
    //                  intended limit.
    bucket.tokens = bucket.tokens + added;
    bucket.lastRefill = t;
    bucket.lastTouched = t;
  }

  private msUntilTokens(bucket: Bucket, cost: number): number {
    if (this.refillPerSec <= 0) {
      return 1_000;
    }
    const needed = cost - bucket.tokens;
    if (needed <= 0) return 0;
    return Math.max(1, Math.ceil((needed / this.refillPerSec) * 1000));
  }

  private evictIdle(): void {
    if (this.idleTtlMs <= 0) return;
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if (t - b.lastTouched > this.idleTtlMs) {
        this.buckets.delete(key);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
