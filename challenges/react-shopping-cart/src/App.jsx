// Optional dev playground — NOT graded, NOT a file you need to edit.
//
// This component is a thin sandbox around YOUR useCart hook and the provided
// CartView. The challenge is graded only by `npm test`; nothing here is imported
// by the tests. Run it with `npm run dev` to watch your cart behave in a real
// browser.
//
// It deliberately prints the raw integer-cents value next to every money figure
// in the summary. That is where the planted bugs show themselves: a discount or
// total that is not a whole number of cents, a total that drops below zero, or
// the same coupon appearing twice in the applied list.
import React, { useState } from "react";
import { useCart, COUPONS } from "./useCart.js";
import { CartView, formatMoney } from "./CartView.jsx";

// A tiny demo catalogue. Prices are in integer cents, like the rest of the cart.
const CATALOG = [
  { id: "apple", name: "Apple", price: 150 },
  { id: "bread", name: "Bread", price: 320 },
  { id: "coffee", name: "Coffee", price: 999 },
  { id: "milk", name: "Milk", price: 99 },
];

const COUPON_CODES = Object.keys(COUPONS);

export function App() {
  const cart = useCart();
  const [code, setCode] = useState(COUPON_CODES[0] ?? "");

  return (
    <main className="playground">
      <header className="banner">
        <h1>Shopping Cart — Playground</h1>
        <p>
          A live sandbox for your <code>useCart</code> hook.{" "}
          <strong>This screen is not graded</strong> and is not a file you need
          to change — the challenge is scored only by <code>npm test</code>. Use
          it to <em>see</em> your cart work (and to watch the planted bugs) while
          you fix things.
        </p>
      </header>

      <div className="columns">
        <section className="panel">
          <h2>Products</h2>
          <ul className="catalog">
            {CATALOG.map((product) => (
              <li key={product.id}>
                <span className="name">{product.name}</span>
                <span className="muted">{formatMoney(product.price)}</span>
                <button type="button" onClick={() => cart.addItem(product)}>
                  Add
                </button>
              </li>
            ))}
          </ul>

          <h2>Coupons</h2>
          <div className="coupon-apply">
            <input
              aria-label="Coupon code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="Coupon code"
            />
            <button type="button" onClick={() => cart.applyCoupon(code.trim())}>
              Apply
            </button>
          </div>
          <p className="muted small">
            Real codes: {COUPON_CODES.join(", ")} — or try a made-up one.
          </p>
          {cart.coupons.length > 0 && (
            <ul className="applied">
              {cart.coupons.map((applied, index) => (
                <li key={`${applied}-${index}`}>
                  <span>{applied}</span>
                  <button
                    type="button"
                    onClick={() => cart.removeCoupon(applied)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Cart ({cart.cartCount})</h2>
          <CartView
            items={cart.items}
            total={cart.cartTotal}
            onRemove={cart.removeItem}
          />

          {cart.items.length > 0 && (
            <div className="qty-controls">
              {cart.items.map((line) => (
                <div key={line.id} className="qty-row">
                  <span className="name">{line.name}</span>
                  <button
                    type="button"
                    aria-label={`Decrease ${line.name}`}
                    onClick={() => cart.setQuantity(line.id, line.quantity - 1)}
                  >
                    −
                  </button>
                  <span className="qty">×{line.quantity}</span>
                  <button
                    type="button"
                    aria-label={`Increase ${line.name}`}
                    onClick={() => cart.setQuantity(line.id, line.quantity + 1)}
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          )}

          <h2>Summary</h2>
          <dl className="summary">
            <div>
              <dt>Subtotal</dt>
              <dd>
                {formatMoney(cart.subtotal)}{" "}
                <small className="muted">({cart.subtotal}¢)</small>
              </dd>
            </div>
            <div>
              <dt>Discount</dt>
              <dd>
                −{formatMoney(cart.discount)}{" "}
                <small className="muted">({cart.discount}¢)</small>
              </dd>
            </div>
            <div className="grand">
              <dt>Total</dt>
              <dd>
                {formatMoney(cart.cartTotal)}{" "}
                <small className="muted">({cart.cartTotal}¢)</small>
              </dd>
            </div>
          </dl>
          <button type="button" className="clear" onClick={cart.clear}>
            Clear cart
          </button>
        </section>
      </div>

      <footer className="hints">
        <p>
          A correct cart keeps every figure above a whole number of cents, never
          lets the total fall below zero, and never lists the same coupon twice
          or accepts a code that is not real.
        </p>
      </footer>
    </main>
  );
}
