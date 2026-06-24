import { afterEach, describe, expect, it } from "vitest";
import { deepMerge } from "../src/deep_merge.js";

/**
 * Public tests for the deep-merge challenge.
 *
 * Tag convention: every test name ends with one of @basic, @immutable,
 * @arrays, @security. The grader runs `vitest -t "@<tag>"` to score each tag
 * group independently. Add new tests with the same suffix style.
 *
 * Most tests pass on the unmodified starter. One @immutable, one @arrays, and
 * one @security test fail on purpose — those failures are hints pointing at the
 * planted bugs you must fix.
 */

// Prototype-pollution tests can write onto Object.prototype when the code is
// buggy. Clean up after every test so one failing case can't leak into the
// next one.
afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
  delete (Object.prototype as Record<string, unknown>).isAdmin;
});

describe("basic merge behaviour", () => {
  it("merges two flat objects @basic", () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("lets the source override the target on a conflicting scalar key @basic", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 99 });
    expect(result).toEqual({ a: 1, b: 99 });
  });

  it("recurses into nested plain objects @basic", () => {
    const result = deepMerge(
      { user: { name: "Ada", age: 30 } },
      { user: { age: 31 } }
    );
    expect(result).toEqual({ user: { name: "Ada", age: 31 } });
  });

  it("adds nested keys that only exist in the source @basic", () => {
    const result = deepMerge({ config: { a: 1 } }, { config: { b: 2 } });
    expect(result).toEqual({ config: { a: 1, b: 2 } });
  });

  it("returns an object carrying every merged key @basic", () => {
    const result = deepMerge({ a: 1 }, { b: 2, c: 3 });
    expect(Object.keys(result).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("immutability", () => {
  it("does not mutate the target object @immutable", () => {
    // Hint: this test fails on the unmodified starter.
    const target = { a: 1, nested: { x: 1 } };
    deepMerge(target, { b: 2 });
    expect(target).toEqual({ a: 1, nested: { x: 1 } });
  });
});

describe("arrays are leaves, not maps", () => {
  it("replaces an array wholesale instead of merging by index @arrays", () => {
    // Hint: this test fails on the unmodified starter.
    const result = deepMerge({ tags: ["a", "b", "c"] }, { tags: ["x"] });
    expect(result.tags).toEqual(["x"]);
  });
});

describe("prototype-pollution safety", () => {
  it("ignores a __proto__ payload and leaves Object.prototype clean @security", () => {
    // Hint: this test fails on the unmodified starter.
    const payload = JSON.parse('{"__proto__": {"polluted": true}}');
    deepMerge({}, payload);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
