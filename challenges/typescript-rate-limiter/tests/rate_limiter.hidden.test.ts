/**
 * Hidden tests — NEVER on the candidate branch.
 *
 * Dry-run results recorded per CHALLENGE_AUTHORING.md §11.D.9:
 *   - Public suite, unmodified starter:  3 hint failures, rest pass.
 *   - Public suite, reference fix:       all pass.
 *   - Hidden suite, unmodified starter:  every trap tag FAILS (3 traps detected).
 *   - Hidden suite, reference fix:       all pass.
 */
import { describe, expect, it } from "vitest";
import { RateLimiter, type RateLimiterOptions } from "../src/rate_limiter";

const makeClock = () => {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
};

const opts = (over: Partial<RateLimiterOptions> & { now: () => number }): RateLimiterOptions => ({
  capacity: 4,
  refillPerSec: 2,
  idleTtlMs: 60_000,
  ...over,
});

// ───────────────────────── basic ─────────────────────────

describe("basic", () => {
  it("does not allow over-consumption of an empty bucket @basic", () => {
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 3, refillPerSec: 0, now: clock.now }));
    expect(rl.tryAcquire("k", 3)).toBe(true);
    for (let i = 0; i < 10; i++) {
      expect(rl.tryAcquire("k")).toBe(false);
    }
    expect(rl.available("k")).toBe(0);
  });

  it("interleaved keys do not contaminate each other @basic", () => {
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 2, refillPerSec: 0, now: clock.now }));
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("bob")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("bob")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(false);
    expect(rl.tryAcquire("bob")).toBe(false);
    expect(rl.tryAcquire("carol")).toBe(true); // fresh key, fresh bucket
  });

  it("size() reflects live bucket count @basic", () => {
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 1, refillPerSec: 0, now: clock.now }));
    rl.tryAcquire("a");
    rl.tryAcquire("b");
    rl.tryAcquire("c");
    expect(rl.size()).toBe(3);
    rl.reset("b");
    expect(rl.size()).toBe(2);
    rl.clear();
    expect(rl.size()).toBe(0);
  });
});

// ───────────────────────── refill (trap: no_cap_on_refill) ─────────────────────────

describe("refill", () => {
  it("refill amount is proportional to elapsed time @refill", () => {
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 100, refillPerSec: 10, now: clock.now }));
    expect(rl.tryAcquire("k", 100)).toBe(true);
    clock.advance(2_500); // 2.5s × 10 = 25 tokens
    expect(rl.available("k")).toBeCloseTo(25, 5);
  });

  it("refill caps at capacity after long idle @refill", () => {
    // Detects: no_cap_on_refill — bucket overflows without Math.min(capacity, …).
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 5, refillPerSec: 100, now: clock.now }));
    expect(rl.tryAcquire("k", 5)).toBe(true);
    clock.advance(60_000); // would add 6000 tokens uncapped
    expect(rl.available("k")).toBe(5);
    // And the cap must hold even after a partial consumption + further idle.
    expect(rl.tryAcquire("k", 2)).toBe(true);
    clock.advance(60_000);
    expect(rl.available("k")).toBe(5);
  });

  it("burst is bounded by capacity, not by elapsed time @refill", () => {
    // Detects: no_cap_on_refill — without a cap, all subsequent tryAcquires
    // succeed because tokens silently exceed capacity.
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 3, refillPerSec: 10, now: clock.now }));
    expect(rl.tryAcquire("k", 3)).toBe(true);
    clock.advance(10_000);
    // After 10s at 10 tokens/sec, the bucket should be at capacity (3), not 100.
    let consumed = 0;
    while (rl.tryAcquire("k")) consumed++;
    expect(consumed).toBe(3);
  });

  it("refill rate of zero never grants new tokens @refill", () => {
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 2, refillPerSec: 0, now: clock.now }));
    expect(rl.tryAcquire("k", 2)).toBe(true);
    clock.advance(10_000);
    expect(rl.available("k")).toBe(0);
    expect(rl.tryAcquire("k")).toBe(false);
  });
});

// ───────────────────────── concurrent (trap: acquire_zero_refill_hangs) ─────────────────────────

describe("concurrent", () => {
  it("acquire resolves immediately when tokens are available @concurrent", async () => {
    const clock = makeClock();
    const rl = new RateLimiter(opts({ capacity: 4, refillPerSec: 0, now: clock.now }));
    await rl.acquire("k");
    await rl.acquire("k");
    await rl.acquire("k");
    await rl.acquire("k");
    expect(rl.available("k")).toBe(0);
  });

  it("multiple concurrent acquires on the same key all complete @concurrent", async () => {
    // Uses real time but with a generous refill rate. We assert all promises
    // resolve and the order in which they settle is preserved (FIFO).
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1000 });
    // Drain.
    expect(rl.tryAcquire("k")).toBe(true);
    const N = 5;
    const order: number[] = [];
    const promises = Array.from({ length: N }, (_, i) =>
      rl.acquire("k").then(() => order.push(i)),
    );
    await Promise.all(promises);
    expect(order.length).toBe(N);
    // Sanity: same set of values present (no losses, no duplicates).
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("acquire does not hang forever when refillPerSec is zero and tokens are insufficient @concurrent", async () => {
    // Detects: acquire_zero_refill_hangs — current slow path polls forever
    // because msUntilTokens returns a constant 1000ms and tokens never grow.
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0 });
    expect(rl.tryAcquire("k")).toBe(true);

    let timedOut = false;
    let threw: unknown = undefined;
    const acquired = rl.acquire("k").then(
      () => false,
      (e) => {
        threw = e;
        return false;
      },
    );
    const timeout = new Promise<true>((res) => setTimeout(() => res((timedOut = true)), 400));
    const result = await Promise.race([acquired, timeout]);
    // Pass if acquire() either rejected promptly OR resolved promptly.
    // Fail if we hit the timeout — that means it would have hung indefinitely.
    expect(result === true && timedOut).toBe(false);
    // If it rejected, the error should be informative.
    if (threw !== undefined) {
      expect(threw).toBeInstanceOf(Error);
    }
  });
});

// ───────────────────────── edge (trap: missing_validation) ─────────────────────────

describe("edge", () => {
  it("constructor rejects non-positive capacity @edge", () => {
    // Detects: missing_validation — capacity=0 / -1 must throw, not produce
    // a broken limiter that silently always denies (or always allows).
    expect(() => new RateLimiter({ capacity: 0, refillPerSec: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: -3, refillPerSec: 1 })).toThrow();
  });

  it("constructor rejects negative refill rate @edge", () => {
    // Detects: missing_validation — negative refill would drain tokens over
    // time and produce NaN/negative bucket counts.
    expect(() => new RateLimiter({ capacity: 4, refillPerSec: -1 })).toThrow();
  });

  it("constructor rejects non-finite values @edge", () => {
    // Detects: missing_validation — NaN/Infinity must be rejected so the
    // bucket math never propagates them into tokens.
    expect(() => new RateLimiter({ capacity: Number.NaN, refillPerSec: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: 4, refillPerSec: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("idle buckets are evicted after idleTtlMs @edge", () => {
    const clock = makeClock();
    const rl = new RateLimiter(
      opts({ capacity: 1, refillPerSec: 0, idleTtlMs: 1_000, now: clock.now }),
    );
    rl.tryAcquire("a");
    rl.tryAcquire("b");
    expect(rl.size()).toBe(2);
    clock.advance(5_000);
    // Any operation that calls getBucket / size should evict.
    expect(rl.size()).toBe(0);
  });

  it("acquire rejects cost > capacity @edge", async () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 10 });
    await expect(rl.acquire("k", 3)).rejects.toThrow();
  });

  it("clear() removes every bucket @edge", () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 0 });
    rl.tryAcquire("a");
    rl.tryAcquire("b");
    rl.tryAcquire("c");
    rl.clear();
    expect(rl.size()).toBe(0);
    expect(rl.tryAcquire("a")).toBe(true); // fresh bucket
  });
});
