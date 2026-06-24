import React from "react";

/**
 * Format an integer number of cents as a dollar string: 150 -> "$1.50".
 */
export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * CartView — a small presentational component. It owns no state; it renders the
 * lines and total it is given and calls `onRemove(id)` when a Remove button is
 * clicked. The per-line total here is correct (price × quantity); the cart-wide
 * total is whatever the caller passes in.
 */
export function CartView({ items, total, onRemove }) {
  if (items.length === 0) {
    return <p data-testid="empty">Your cart is empty.</p>;
  }

  return (
    <ul data-testid="cart">
      {items.map((it) => (
        <li key={it.id} data-testid={`line-${it.id}`}>
          <span className="name">{it.name}</span>
          <span className="qty">×{it.quantity}</span>
          <span className="line-total">{formatMoney(it.price * it.quantity)}</span>
          <button type="button" onClick={() => onRemove(it.id)}>
            Remove
          </button>
        </li>
      ))}
      <li data-testid="total">{formatMoney(total)}</li>
    </ul>
  );
}
