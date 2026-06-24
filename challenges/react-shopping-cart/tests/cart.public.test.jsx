import { afterEach, describe, expect, it } from "vitest";
import { renderHook, act, render, screen, cleanup } from "@testing-library/react";
import { useCart } from "../src/useCart.js";
import { CartView, formatMoney } from "../src/CartView.jsx";

/**
 * Public tests for the shopping-cart challenge.
 *
 * Tag convention: every test name ends with one of @basic, @discount, @clamp,
 * @coupons. The grader runs `vitest -t "@<tag>"` to score each tag group
 * independently. Add new tests with the same suffix style.
 *
 * The cart fundamentals already pass. One @discount, one @clamp, and one
 * @coupons test fail on purpose — those failures are hints pointing at the
 * planted bugs in the discount layer.
 */

const PRODUCTS = {
  apple: { id: "apple", name: "Apple", price: 150 }, // 10% off = 15c exactly
  bread: { id: "bread", name: "Bread", price: 320 },
  coffee: { id: "coffee", name: "Coffee", price: 999 }, // 10% off = 99.9c -> 100c
};

afterEach(() => cleanup());

describe("basic cart behaviour", () => {
  it("starts empty with a zero count, subtotal and total @basic", () => {
    const { result } = renderHook(() => useCart());
    expect(result.current.items).toEqual([]);
    expect(result.current.cartCount).toBe(0);
    expect(result.current.subtotal).toBe(0);
    expect(result.current.cartTotal).toBe(0);
  });

  it("merges a re-added product into one line @basic", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple));
    act(() => result.current.addItem(PRODUCTS.apple));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].quantity).toBe(2);
    expect(result.current.cartCount).toBe(2);
  });

  it("subtotal sums unit price times quantity @basic", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple)); // 150
    act(() => result.current.setQuantity("apple", 3));
    expect(result.current.subtotal).toBe(450);
  });

  it("setting quantity to zero drops the line @basic", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple));
    act(() => result.current.setQuantity("apple", 0));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.cartCount).toBe(0);
  });

  it("with no coupons the total equals the subtotal @basic", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.bread)); // 320
    expect(result.current.discount).toBe(0);
    expect(result.current.cartTotal).toBe(320);
  });

  it("renders an empty state and then a populated list @basic", () => {
    const { rerender } = render(
      <CartView items={[]} total={0} onRemove={() => {}} />
    );
    expect(screen.getByTestId("empty")).toBeInTheDocument();

    rerender(
      <CartView
        items={[{ id: "apple", name: "Apple", price: 150, quantity: 2 }]}
        total={300}
        onRemove={() => {}}
      />
    );
    expect(screen.getByTestId("line-apple")).toHaveTextContent("Apple");
    expect(screen.getByTestId("total")).toHaveTextContent("$3.00");
  });

  it("formatMoney renders cents as a dollar string @basic", () => {
    expect(formatMoney(150)).toBe("$1.50");
    expect(formatMoney(0)).toBe("$0.00");
  });
});

describe("percentage discounts round to whole cents", () => {
  it("rounds a 10% coupon on $9.99 to a whole cent @discount", () => {
    // Hint: this test fails on the unmodified starter.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.coffee)); // 999
    act(() => result.current.applyCoupon("SAVE10"));
    // 999 * 10% = 99.9 -> rounds to 100 cents
    expect(result.current.discount).toBe(100);
    expect(result.current.cartTotal).toBe(899);
  });
});

describe("the total never goes negative", () => {
  it("clamps to zero when a coupon is worth more than the cart @clamp", () => {
    // Hint: this test fails on the unmodified starter.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple)); // 150
    act(() => result.current.applyCoupon("TENOFF")); // 1000 off
    expect(result.current.cartTotal).toBe(0);
  });
});

describe("applying coupons", () => {
  it("ignores a duplicate coupon and an unknown code @coupons", () => {
    // Hint: this test fails on the unmodified starter.
    const { result } = renderHook(() => useCart());
    act(() => result.current.addItem(PRODUCTS.apple)); // 150, 10% = 15 exactly
    act(() => result.current.applyCoupon("SAVE10"));
    act(() => result.current.applyCoupon("SAVE10")); // duplicate — ignore it
    act(() => result.current.applyCoupon("BOGUS")); // not a real coupon — ignore it
    expect(result.current.coupons).toEqual(["SAVE10"]);
    expect(result.current.discount).toBe(15);
    expect(result.current.cartTotal).toBe(135);
  });
});
