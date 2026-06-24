import { useReducer, useCallback, useMemo } from "react";

/**
 * useCart — the data layer behind a shopping-cart UI, now with discount coupons.
 *
 * State shape:
 *   { items: Array<{ id, name, price, quantity }>, coupons: Array<string> }
 *   `price` is an integer number of cents (so 150 means $1.50). EVERY money
 *   value this hook exposes — `subtotal`, `discount`, `cartTotal` — is also an
 *   integer number of cents. Keep it that way.
 *
 * The cart fundamentals already work: adding a product merges into its existing
 * line, `setQuantity(id, 0)` drops the line, and `subtotal` sums price × qty.
 *
 * The DISCOUNT layer is new, and it has three planted bugs. The failing public
 * tests point at them without naming them:
 *
 *   1. A percentage coupon is applied in raw floating point, so 10% off $9.99
 *      comes out as 99.9 — a fractional cent that breaks the integer-cents rule.
 *   2. `cartTotal` can go negative when a coupon is worth more than the cart.
 *   3. `applyCoupon` accepts anything — it stacks the same code twice and even
 *      adds codes that aren't real coupons.
 *
 * The exact discount rules are written out in README.md. Read them: they are the
 * spec the hidden tests check against.
 */

export const initialCart = { items: [], coupons: [] };

/**
 * Built-in coupon catalogue.
 *   - `percent` coupons take a percentage off the subtotal.
 *   - `fixed`   coupons take a flat number of cents off.
 * Any code that isn't a key in here is NOT a valid coupon.
 */
export const COUPONS = {
  SAVE10: { type: "percent", value: 10 },
  SAVE25: { type: "percent", value: 25 },
  FIVEOFF: { type: "fixed", value: 500 },
  TENOFF: { type: "fixed", value: 1000 },
};

export function cartReducer(state, action) {
  switch (action.type) {
    case "add": {
      const { product } = action;
      const existing = state.items.find((it) => it.id === product.id);
      if (existing) {
        return {
          ...state,
          items: state.items.map((it) =>
            it.id === product.id ? { ...it, quantity: it.quantity + 1 } : it
          ),
        };
      }
      const line = {
        id: product.id,
        name: product.name,
        price: product.price,
        quantity: 1,
      };
      return { ...state, items: [...state.items, line] };
    }

    case "setQuantity": {
      const { id, quantity } = action;
      if (quantity <= 0) {
        return { ...state, items: state.items.filter((it) => it.id !== id) };
      }
      return {
        ...state,
        items: state.items.map((it) =>
          it.id === id ? { ...it, quantity } : it
        ),
      };
    }

    case "remove":
      return {
        ...state,
        items: state.items.filter((it) => it.id !== action.id),
      };

    case "applyCoupon": {
      // TODO(candidate): this trusts the code completely. The same coupon can be
      // added twice (which doubles its discount), and a made-up code like
      // "FREESTUFF" is stored just the same. Only real coupons that aren't
      // already applied belong in the list.
      return { ...state, coupons: [...state.coupons, action.code] };
    }

    case "removeCoupon":
      return {
        ...state,
        coupons: state.coupons.filter((c) => c !== action.code),
      };

    case "clear":
      return { items: [], coupons: [] };

    default:
      return state;
  }
}

/**
 * The discount, in cents, that a single coupon takes off the given subtotal.
 *
 * TODO(candidate): percentage coupons are computed in raw floating point here,
 * so a 10%-off coupon on a $9.99 (999-cent) subtotal returns 99.9 — not a whole
 * number of cents. Round each percentage discount to the nearest cent (a
 * half-cent rounds up) so the money stays in integers.
 */
function couponDiscount(coupon, subtotal) {
  if (coupon.type === "percent") {
    return (subtotal * coupon.value) / 100;
  }
  return coupon.value;
}

export function useCart() {
  const [state, dispatch] = useReducer(cartReducer, initialCart);

  const addItem = useCallback(
    (product) => dispatch({ type: "add", product }),
    []
  );
  const setQuantity = useCallback(
    (id, quantity) => dispatch({ type: "setQuantity", id, quantity }),
    []
  );
  const removeItem = useCallback((id) => dispatch({ type: "remove", id }), []);
  const applyCoupon = useCallback(
    (code) => dispatch({ type: "applyCoupon", code }),
    []
  );
  const removeCoupon = useCallback(
    (code) => dispatch({ type: "removeCoupon", code }),
    []
  );
  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  const cartCount = useMemo(
    () => state.items.reduce((n, it) => n + it.quantity, 0),
    [state.items]
  );

  const subtotal = useMemo(
    () => state.items.reduce((sum, it) => sum + it.price * it.quantity, 0),
    [state.items]
  );

  const discount = useMemo(
    () =>
      state.coupons.reduce((sum, code) => {
        const coupon = COUPONS[code];
        if (!coupon) return sum;
        return sum + couponDiscount(coupon, subtotal);
      }, 0),
    [state.coupons, subtotal]
  );

  const cartTotal = useMemo(
    // TODO(candidate): when the discount adds up to more than the subtotal this
    // goes negative. A cart total must never fall below zero.
    () => subtotal - discount,
    [subtotal, discount]
  );

  return {
    items: state.items,
    coupons: state.coupons,
    addItem,
    setQuantity,
    removeItem,
    applyCoupon,
    removeCoupon,
    clear,
    cartCount,
    subtotal,
    discount,
    cartTotal,
  };
}
