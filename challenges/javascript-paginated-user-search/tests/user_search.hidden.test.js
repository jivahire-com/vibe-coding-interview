/**
 * Hidden tests — NEVER on the candidate branch.
 *
 * Dry-run expectations:
 *   - Public suite, unmodified starter:  3 hint failures (one each in @stale,
 *     @race, @pagination), the rest pass.
 *   - Public suite, reference fix:       all pass.
 *   - Hidden suite, unmodified starter:  every trap tag has at least one
 *     failing test (stale_closure_on_page, out_of_order_fetch_results,
 *     total_pages_floor_off_by_one all detected).
 *   - Hidden suite, reference fix:       all pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserSearch } from "../src/user_search.js";

function deferredFetcher() {
  const calls = [];
  const fetcher = (query, page, pageSize) =>
    new Promise((resolve, reject) => {
      calls.push({ query, page, pageSize, resolve, reject });
    });
  return { fetcher, calls };
}

function fakeUsers(prefix, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `${prefix} ${i}`,
    email: `${prefix}${i}@example.com`,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── basic ─────────────────────────

describe("basic", () => {
  it("notifies subscribers on loading start and on fetch commit @basic", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 50 });
    const states = [];
    s.subscribe((st) => states.push(st));

    s.setQuery("a");
    await vi.advanceTimersByTimeAsync(60);
    // After debounce fires, the fetch is in flight → loading=true notification expected.
    expect(states.some((st) => st.loading === true)).toBe(true);

    calls[0].resolve({ users: fakeUsers("u", 2), total: 2 });
    await vi.advanceTimersByTimeAsync(0);

    const last = states[states.length - 1];
    expect(last.loading).toBe(false);
    expect(last.users.map((u) => u.id)).toEqual(["u-0", "u-1"]);
  });

  it("unsubscribe stops further notifications @basic", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });
    let count = 0;
    const unsub = s.subscribe(() => {
      count++;
    });
    s.setPage(1);
    calls[0].resolve({ users: fakeUsers("u", 1), total: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const before = count;
    unsub();
    s.setPage(2);
    calls[1].resolve({ users: fakeUsers("v", 1), total: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(before);
  });

  it("dispose cancels a pending debounce @basic", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 100 });
    s.setQuery("never");
    s.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(0);
  });

  it("the debounce window collapses rapid keystrokes into one fetch @basic", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 100 });
    for (const c of "alice") {
      s.setQuery(s.getState().query + c);
      await vi.advanceTimersByTimeAsync(20); // each shorter than the debounce
    }
    expect(calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(120);
    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe("alice");
  });
});

// ───────────── stale (trap: stale_closure_on_page) ─────────────

describe("stale", () => {
  it("setPage during debounce → debounced fetch targets the new page @stale", async () => {
    // Detects: stale_closure_on_page.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 100 });

    s.setQuery("alice"); // schedules a debounced fetch with stale page=1
    s.setPage(7); // immediate fetch for page 7
    expect(calls.length).toBe(1);
    expect(calls[0].page).toBe(7);

    await vi.advanceTimersByTimeAsync(120); // fire debounce
    const debounced = calls[calls.length - 1];
    expect(debounced.query).toBe("alice");
    expect(debounced.page).toBe(7); // must reflect the latest page, not 1
  });

  it("multiple setPage calls inside one debounce window land on the final page @stale", async () => {
    // Detects: stale_closure_on_page.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 100 });

    s.setQuery("bob");
    s.setPage(2);
    s.setPage(3);
    s.setPage(5);
    // Drain the immediate setPage fetches so we can spot the debounced one.
    expect(calls.length).toBe(3);
    for (const c of calls) c.resolve({ users: [], total: 0 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(120);
    const debounced = calls[calls.length - 1];
    expect(debounced.query).toBe("bob");
    expect(debounced.page).toBe(5);
  });

  it("debounced fetch uses the latest query when setQuery is called repeatedly @stale", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 80 });
    s.setQuery("a");
    await vi.advanceTimersByTimeAsync(40);
    s.setQuery("ab");
    await vi.advanceTimersByTimeAsync(40);
    s.setQuery("abc");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe("abc");
  });
});

// ───────────── race (trap: out_of_order_fetch_results) ─────────────

describe("race", () => {
  it("slow earlier query does not overwrite a faster later query @race", async () => {
    // Detects: out_of_order_fetch_results.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 40 });

    s.setQuery("old");
    await vi.advanceTimersByTimeAsync(50);
    s.setQuery("new");
    await vi.advanceTimersByTimeAsync(50);

    expect(calls.length).toBe(2);
    // Resolve newer first, then older — older must be ignored.
    calls[1].resolve({ users: fakeUsers("new", 4), total: 4 });
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve({ users: fakeUsers("old", 9), total: 9 });
    await vi.advanceTimersByTimeAsync(0);

    const st = s.getState();
    expect(st.users.map((u) => u.id)).toEqual(["new-0", "new-1", "new-2", "new-3"]);
    expect(st.total).toBe(4);
  });

  it("stale page-fetch does not overwrite a fresh page-fetch @race", async () => {
    // Detects: out_of_order_fetch_results — pages, not just queries.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });

    s.setPage(2);
    s.setPage(3);
    expect(calls.length).toBe(2);
    // Page 3 resolves first (the fresh one).
    calls[1].resolve({ users: fakeUsers("p3", 5), total: 13 });
    await vi.advanceTimersByTimeAsync(0);
    // Then page 2 resolves later (stale).
    calls[0].resolve({ users: fakeUsers("p2", 5), total: 13 });
    await vi.advanceTimersByTimeAsync(0);

    const st = s.getState();
    expect(st.users.map((u) => u.id)).toEqual(["p3-0", "p3-1", "p3-2", "p3-3", "p3-4"]);
    expect(st.page).toBe(3);
  });

  it("after a stale-and-discarded response the loading flag still settles to false @race", async () => {
    // A correct generation-counter fix must still clear `loading` when the
    // current request completes — even if older ones never commit.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 30 });

    s.setQuery("a");
    await vi.advanceTimersByTimeAsync(40);
    s.setQuery("b");
    await vi.advanceTimersByTimeAsync(40);

    calls[1].resolve({ users: fakeUsers("b", 2), total: 2 });
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve({ users: fakeUsers("a", 2), total: 2 });
    await vi.advanceTimersByTimeAsync(0);

    expect(s.getState().loading).toBe(false);
  });
});

// ───────────── pagination (trap: total_pages_floor_off_by_one) ─────────────

describe("pagination", () => {
  it("totalPages = ceil(total / pageSize) for partial last page @pagination", async () => {
    // Detects: total_pages_floor_off_by_one.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });
    s.setPage(1);
    calls[0].resolve({ users: fakeUsers("u", 5), total: 23 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getState().totalPages).toBe(5);
  });

  it("totalPages equals 1 when total exactly fills one page @pagination", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 10 });
    s.setPage(1);
    calls[0].resolve({ users: fakeUsers("u", 10), total: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getState().totalPages).toBe(1);
  });

  it("totalPages of an empty result is 0 (or 1) but not negative or NaN @pagination", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });
    s.setPage(1);
    calls[0].resolve({ users: [], total: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const tp = s.getState().totalPages;
    expect(tp === 0 || tp === 1).toBe(true);
  });

  it("setPage rejects non-positive and non-integer values @pagination", () => {
    const { fetcher } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });
    expect(() => s.setPage(0)).toThrow(RangeError);
    expect(() => s.setPage(-1)).toThrow(RangeError);
    expect(() => s.setPage(1.5)).toThrow(RangeError);
  });
});
