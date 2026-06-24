/**
 * Hidden tests — NEVER on the candidate branch. The grader copies this file
 * into tests/ before running.
 *
 * Dry-run expectations:
 *   - Public suite, unmodified starter:  3 hint failures (one each in @discount,
 *     @clamp, @coupons); @basic all pass.
 *   - Public suite, reference fix:       all pass.
 *   - Hidden suite, unmodified starter:  every trap tag has at least one
 *     failing test (discount_rounding, total_allows_negative,
 *     coupon_stacks_and_unknown all detected).
 *   - Hidden suite, reference fix:       all pass.
 *
 * Each trap is isolated: the failing tests in a tag are fixed by that tag's fix
 * alone, so the grader scores @discount / @clamp / @coupons independently.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCart } from "../src/useCart.js";

const PRODUCTS = {
  apple: { id: "apple", name: "Apple", price: 150 },
  bread: { id: "bread", name: "Bread", price: 320 },
  coffee: { id: "coffee", name: "Coffee", price: 999 },
  milk: { id: "milk", name: "Milk", price: 99 },
};

afterEach(() => cleanup());

// ───────────────────────── basic ─────────────────────────

describe("basic", () => {
  it("clear empties items and coupons @basic", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple));
    act(() => result.current.addItem(PRODUCTS.bread));
    act(() => result.current.applyCoupon("SAVE10"));
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
    expect(result.current.coupons).toEqual([]);
    expect(result.current.cartCount).toBe(0);
    expect(result.current.subtotal).toBe(0);
    expect(result.current.cartTotal).toBe(0);
  });

  it("removeItem with an unknown id is a no-op @basic", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple));
    act(() => result.current.removeItem("does-not-exist"));
    expect(result.current.items.map((i) => i.id)).toEqual(["apple"]);
  });

  it("subtotal sums price times quantity across lines @basic", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple)); // 150
    act(() => result.current.addItem(PRODUCTS.bread)); // 320
    act(() => result.current.setQuantity("apple", 2)); // 2 * 150 = 300
    expect(result.current.subtotal).toBe(620);
  });
});

// ───────────── discount (trap: discount_rounding) ─────────────

describe("discount", () => {
  it("rounds a 25% coupon on $9.99 to the nearest cent @discount", () => {
    // Detects: discount_rounding. 999 * 25% = 249.75 -> 250.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee)); // 999
    act(() => result.current.applyCoupon("SAVE25"));
    expect(result.current.discount).toBe(250);
    expect(result.current.cartTotal).toBe(749);
  });

  it("rounds each coupon independently when several apply @discount", () => {
    // Detects: discount_rounding. round(99.9)=100, plus fixed 500 = 600.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee)); // 999
    act(() => result.current.applyCoupon("SAVE10"));
    act(() => result.current.applyCoupon("FIVEOFF"));
    expect(result.current.discount).toBe(600);
    expect(result.current.cartTotal).toBe(399);
  });

  it("recomputes the discount to zero after the item is removed @discount", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee));
    act(() => result.current.applyCoupon("SAVE25"));
    act(() => result.current.setQuantity("coffee", 0)); // drops the only line
    expect(result.current.subtotal).toBe(0);
    expect(result.current.discount).toBe(0);
    expect(result.current.cartTotal).toBe(0);
  });
});

// ───────────── clamp (trap: total_allows_negative) ─────────────

describe("clamp", () => {
  it("clamps to zero for a single oversized coupon @clamp", () => {
    // Detects: total_allows_negative. 99 - 1000 -> 0, not -901.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.milk)); // 99
    act(() => result.current.applyCoupon("TENOFF")); // 1000 off
    expect(result.current.cartTotal).toBe(0);
  });

  it("clamps to zero when two fixed coupons exceed the subtotal @clamp", () => {
    // Detects: total_allows_negative. 999 - (500 + 1000) -> 0.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee)); // 999
    act(() => result.current.applyCoupon("FIVEOFF"));
    act(() => result.current.applyCoupon("TENOFF"));
    expect(result.current.cartTotal).toBe(0);
  });

  it("clamps to zero when a percent and fixed coupon combine past the total @clamp", () => {
    // Detects: total_allows_negative. 150 - (38 + 1000) -> 0.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple)); // 150
    act(() => result.current.applyCoupon("SAVE25"));
    act(() => result.current.applyCoupon("TENOFF"));
    expect(result.current.cartTotal).toBe(0);
  });
});

// ───────────── coupons (trap: coupon_stacks_and_unknown) ─────────────

describe("coupons", () => {
  it("removeCoupon takes an applied coupon back off @coupons", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee));
    act(() => result.current.applyCoupon("SAVE10"));
    act(() => result.current.removeCoupon("SAVE10"));
    expect(result.current.coupons).toEqual([]);
    expect(result.current.discount).toBe(0);
  });

  it("keeps only distinct, real coupons @coupons", () => {
    // Detects: coupon_stacks_and_unknown.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee));
    act(() => result.current.applyCoupon("SAVE10"));
    act(() => result.current.applyCoupon("FIVEOFF"));
    act(() => result.current.applyCoupon("SAVE10")); // duplicate
    act(() => result.current.applyCoupon("NOPE")); // unknown
    expect(result.current.coupons).toEqual(["SAVE10", "FIVEOFF"]);
  });

  it("ignores an unknown code entirely @coupons", () => {
    // Detects: coupon_stacks_and_unknown.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple)); // 150
    act(() => result.current.applyCoupon("BOGUS"));
    expect(result.current.coupons).toEqual([]);
    expect(result.current.discount).toBe(0);
    expect(result.current.cartTotal).toBe(150);
  });

  it("does not let the same coupon stack its discount @coupons", () => {
    // Detects: coupon_stacks_and_unknown. Fixed coupon keeps this isolated
    // from the rounding and clamp traps.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee)); // 999
    act(() => result.current.applyCoupon("FIVEOFF"));
    act(() => result.current.applyCoupon("FIVEOFF")); // duplicate
    expect(result.current.coupons).toEqual(["FIVEOFF"]);
    expect(result.current.discount).toBe(500);
    expect(result.current.cartTotal).toBe(499);
  });
});
