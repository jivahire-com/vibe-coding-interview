/**
 * Hidden tests — NEVER on the candidate branch. The grader copies this file
 * into tests/ before running.
 *
 * Dry-run expectations:
 *   - Public suite, unmodified starter:  3 hint failures (one each in
 *     @immutable, @arrays, @security); everything else passes.
 *   - Public suite, reference fix:       all pass.
 *   - Hidden suite, unmodified starter:  every trap tag has at least one
 *     failing test (mutates_target_in_place, arrays_merged_by_index,
 *     prototype_pollution all detected).
 *   - Hidden suite, reference fix:       all pass.
 */
import { afterEach, describe, expect, it } from "vitest";
import { deepMerge } from "../src/deep_merge.js";

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
  delete (Object.prototype as Record<string, unknown>).isAdmin;
});

// ───────────────────────── basic ─────────────────────────

describe("basic", () => {
  it("merges three sources of flat keys in sequence @basic", () => {
    const step1 = deepMerge({ a: 1 }, { b: 2 });
    const result = deepMerge(step1, { c: 3 });
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("merges deeply nested plain objects at every level @basic", () => {
    const result = deepMerge({ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } });
    expect(result).toEqual({ a: { b: { c: 1, d: 2 } } });
  });
});

// ───────────── immutable (trap: mutates_target_in_place) ─────────────

describe("immutable", () => {
  it("returns a new object distinct from the target @immutable", () => {
    // Detects: mutates_target_in_place.
    const target = { a: 1 };
    const result = deepMerge(target, { b: 2 });
    expect(result).not.toBe(target);
    expect(target).toEqual({ a: 1 });
  });

  it("does not share nested source objects into the result @immutable", () => {
    // Detects: mutates_target_in_place (shared reference on the else branch).
    const source = { nested: { x: 1 } };
    const result = deepMerge<{ nested?: { x: number } }>({}, source) as {
      nested: { x: number };
    };
    result.nested.x = 999;
    expect(source.nested.x).toBe(1);
  });
});

// ───────────── arrays (trap: arrays_merged_by_index) ─────────────

describe("arrays", () => {
  it("replaces a nested array rather than merging its elements @arrays", () => {
    // Detects: arrays_merged_by_index.
    const result = deepMerge({ list: [1, 2, 3], keep: true }, { list: [9] });
    expect(result.list).toEqual([9]);
    expect(result.keep).toBe(true);
  });

  it("treats an array value as a leaf even when the target key is absent @arrays", () => {
    const result = deepMerge<{ items?: number[] }>({}, { items: [1, 2] }) as {
      items: number[];
    };
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toEqual([1, 2]);
  });
});

// ───────────── security (trap: prototype_pollution) ─────────────

describe("security", () => {
  it("does not pollute Object.prototype via a __proto__ JSON payload @security", () => {
    // Detects: prototype_pollution.
    const payload = JSON.parse('{"__proto__": {"isAdmin": true}}');
    deepMerge({}, payload);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("does not pollute even when __proto__ is nested under a normal key @security", () => {
    // Detects: prototype_pollution.
    const payload = JSON.parse('{"profile": {"__proto__": {"polluted": true}}}');
    const result = deepMerge<{ profile?: Record<string, unknown> }>(
      { profile: { name: "x" } },
      payload
    ) as { profile: { name: string } };
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.profile.name).toBe("x");
  });

  it("copies sibling safe keys while dropping the dangerous one @security", () => {
    // Detects: prototype_pollution.
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    const result = deepMerge<{ safe?: number }>({}, payload) as { safe: number };
    expect(result.safe).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
