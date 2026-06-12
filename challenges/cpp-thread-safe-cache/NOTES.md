# NOTES — thread-safe core + bonus

## Core: making the cache thread-safe (and correct)

The starter was single-threaded and had a capacity off-by-one. Two changes:

- **One `std::mutex` guards every operation.** `get()` *looks* like a read but it
  promotes the returned entry (splices the node to the front), so it mutates
  `list_`. A `std::shared_mutex` with a shared lock on `get()` would therefore let
  many threads mutate the list at once — a data race. A single exclusive mutex is
  both the simplest and the correct design for this access pattern.
- **Eviction now uses `>=`** (`while (list_.size() >= capacity_)`) so a new insert
  never pushes the cache one entry over capacity, and a `capacity == 0` cache
  stores nothing.

## Bonus

The brief says pick one; I implemented all three because they are orthogonal,
each serves a different stakeholder, and together they round out an operationally
honest cache. The guiding constraint — *new shared state must be thread-safe* — is
satisfied by keeping every counter and field under the same mutex, so no bump can
be lost to a race.

### 1. Observability — the "2 a.m. page"
**Who:** the on-call operator who suspects the cache and needs evidence.
**What:** `stats()` returns a consistent snapshot — `hits`, `misses`, `evictions`,
`expirations`, `size`, `capacity`, plus a `hit_rate()` helper.
**Why this and not logging:** counters are cheap, always-on, and pull-based (a
metrics scrape can read them); per-event logging is noisy and easy to turn off.
The snapshot is taken under the lock so the fields are mutually consistent rather
than smeared across concurrent updates.

### 2. TTL — "stale answers"
**Who:** the user being quietly served a value whose source-of-truth has changed.
**What:** an optional per-entry TTL via `put(key, value, ttl)`. An entry past its
deadline is treated as absent on `get()` (returns `nullopt`, counts a miss + an
expiration) and reclaimed in place.
**Why per-entry, not one global TTL:** freshness requirements differ per key. The
clock is **injectable** (`ClockFn` constructor arg) so tests are deterministic and
instant instead of sleeping; production defaults to `steady_clock`.

### 3. Eviction callback — "silent drop-outs"
**Who:** a sibling subsystem that must learn when an entry falls out.
**What:** `set_on_evict(cb)` fires once per entry dropped *to make room*. It does
**not** fire on update or on TTL expiry — those are different events.
**The subtle part:** the callback runs **outside the lock**. Evicted `(key, value)`
pairs are collected while locked, then handed to the callback after the lock is
released, so a callback that calls back into the cache cannot deadlock. This is
covered by a re-entrancy test.

## Tests
`tests/bonus_test.cpp` covers each feature, including a fake-clock TTL suite, the
re-entrant-callback case, and a concurrency test asserting `hits + misses` equals
the exact number of `get()` calls (no counter lost to a race).

## What I'd do next
- A `reason` argument on the callback (`Evicted` vs `Expired`) so expiry can
  notify too, without conflating the two.
- Per-shard locking (stripe the map) if profiling shows the single mutex is the
  bottleneck under the read-heavy load — measure before adding that complexity.
- Background reaping of expired entries so dead keys don't sit until next access.
