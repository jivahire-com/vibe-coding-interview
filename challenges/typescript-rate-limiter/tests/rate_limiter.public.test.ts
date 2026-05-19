import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate_limiter";

/**
 * Public tests for the rate limiter challenge.
 *
 * Tag convention: every test name ends with one of @basic, @refill,
 * @concurrent, @edge. The grader runs `vitest -t "@<tag>"` to score each tag
 * group independently. Add new tests with the same suffix style.
 *
 * Most tests pass on the unmodified starter. A few fail intentionally — those
 * failures are hints pointing at planted bugs you must fix.
 */

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

describe("basic single-bucket semantics", () => {
  it("starts at full capacity @basic", () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, now: clock.now });
    expect(rl.available("alice")).toBe(3);
  });

  it("tryAcquire consumes tokens and returns false when empty @basic", () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 0, now: clock.now });
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(false);
    expect(rl.available("alice")).toBe(0);
  });

  it("keys are isolated @basic", () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0, now: clock.now });
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("bob")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(false);
    expect(rl.tryAcquire("bob")).toBe(false);
  });

  it("cost > 1 consumes multiple tokens @basic", () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 5, refillPerSec: 0, now: clock.now });
    expect(rl.tryAcquire("alice", 3)).toBe(true);
    expect(rl.available("alice")).toBe(2);
    expect(rl.tryAcquire("alice", 3)).toBe(false);
    expect(rl.tryAcquire("alice", 2)).toBe(true);
    expect(rl.available("alice")).toBe(0);
  });
});

describe("refill behaviour", () => {
  it("refills at the configured rate @refill", () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 10, refillPerSec: 5, now: clock.now });
    expect(rl.tryAcquire("k", 10)).toBe(true);
    expect(rl.available("k")).toBe(0);
    clock.advance(1000); // +5 tokens
    expect(rl.available("k")).toBeCloseTo(5, 5);
    clock.advance(500); // +2.5 tokens
    expect(rl.available("k")).toBeCloseTo(7.5, 5);
  });

  it("refill does not exceed capacity after long idle @refill", () => {
    // Hint: this test fails on the unmodified starter.
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 4, refillPerSec: 10, now: clock.now });
    expect(rl.tryAcquire("k", 4)).toBe(true);
    clock.advance(60_000); // way past full
    expect(rl.available("k")).toBe(4);
  });
});

describe("concurrent acquire semantics", () => {
  it("acquire returns immediately when tokens are available @concurrent", async () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1, now: clock.now });
    await rl.acquire("k");
    await rl.acquire("k");
    expect(rl.available("k")).toBe(0);
  });
});

describe("edge cases and input validation", () => {
  it("rejects cost <= 0 @edge", () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
    expect(() => rl.tryAcquire("k", 0)).toThrow(RangeError);
    expect(() => rl.tryAcquire("k", -1)).toThrow(RangeError);
  });

  it("rejects cost greater than capacity @edge", () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
    expect(() => rl.tryAcquire("k", 4)).toThrow(RangeError);
  });

  it("reset(key) clears that bucket only @edge", () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0, now: clock.now });
    expect(rl.tryAcquire("a")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(true);
    rl.reset("a");
    // 'a' bucket is gone — next call should see a fresh full bucket.
    expect(rl.available("a")).toBe(1);
    // 'b' is still empty.
    expect(rl.available("b")).toBe(0);
  });
});
