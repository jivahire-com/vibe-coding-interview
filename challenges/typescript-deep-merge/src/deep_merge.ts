/**
 * deepMerge — recursively merge a `source` object into a `target` object.
 *
 * The behaviour we want:
 *   • recursive  — nested plain objects merge key-by-key.
 *   • pure       — the inputs are never mutated; a brand-new object comes back.
 *   • array-safe — arrays are replaced wholesale, not merged element-by-element.
 *   • proto-safe — keys like `__proto__` / `constructor` can never reach
 *                  `Object.prototype` (prototype-pollution protection).
 *
 * TODO(candidate): the starter only gets the easy case right. The public
 * `@basic` tests pass, but one `@immutable`, one `@arrays`, and one `@security`
 * test fail on purpose — each one points straight at a planted bug flagged
 * below. Keep the `deepMerge` signature intact.
 */

export type Plain = Record<string, unknown>;

/**
 * BUG(@arrays): this also returns `true` for arrays, so two arrays at the same
 * key get merged index-by-index instead of the source array replacing the
 * target array. A correct deep-merge treats an array as a leaf value (replace),
 * never as a mergeable map.
 */
function isMergeable(value: unknown): value is Plain {
  return typeof value === "object" && value !== null;
}

export function deepMerge<T extends Plain>(target: T, source: Plain): T {
  // BUG(@immutable): we write straight back into `target`, mutating the
  // caller's object. And the `else` branch assigns `sourceValue` by reference,
  // so nested source objects end up shared between the input and the result.
  // A correct version builds a fresh object and deep-copies as it descends.
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = (target as Plain)[key];

    // BUG(@security): every own key of `source` is followed, including
    // `__proto__` (and `constructor` / `prototype`). A payload parsed from
    // untrusted JSON such as {"__proto__": {"isAdmin": true}} therefore walks
    // straight onto `Object.prototype`. Dangerous keys must be skipped.
    if (isMergeable(sourceValue) && isMergeable(targetValue)) {
      (target as Plain)[key] = deepMerge(targetValue, sourceValue);
    } else {
      (target as Plain)[key] = sourceValue;
    }
  }

  return target;
}
