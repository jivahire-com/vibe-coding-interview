import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserSearch } from "../src/user_search.js";

/**
 * Public tests for the paginated-user-search challenge.
 *
 * Tag convention: every test name ends with one of @basic, @stale, @race,
 * @pagination. The grader runs `vitest -t "@<tag>"` to score each tag group
 * independently. Add new tests with the same suffix style.
 *
 * Most tests pass on the unmodified starter. A few fail intentionally — those
 * failures are hints that point at planted bugs you must fix.
 */

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

describe("basic API", () => {
  it("starts empty with sensible defaults @basic", () => {
    const { fetcher } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 10 });
    const st = s.getState();
    expect(st.query).toBe("");
    expect(st.page).toBe(1);
    expect(st.pageSize).toBe(10);
    expect(st.users).toEqual([]);
    expect(st.total).toBe(0);
    expect(st.loading).toBe(false);
  });

  it("setQuery debounces and then calls fetch with the latest query @basic", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 100 });

    s.setQuery("a");
    s.setQuery("ab");
    s.setQuery("abc");
    expect(calls.length).toBe(0); // still inside debounce window

    await vi.advanceTimersByTimeAsync(120);
    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe("abc");
    expect(calls[0].page).toBe(1);
    expect(calls[0].pageSize).toBe(5);
  });

  it("setPage triggers a fetch immediately without debounce @basic", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });

    s.setPage(2);
    expect(calls.length).toBe(1);
    expect(calls[0].page).toBe(2);
  });
});

describe("debounced search picks up the current page", () => {
  it("page changes during the debounce window are reflected in the fetch @stale", async () => {
    // Hint: this test fails on the unmodified starter.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 100 });

    s.setQuery("alice"); // schedules a debounced fetch
    s.setPage(4); // user clicks page 4 mid-debounce — fires its own immediate fetch
    expect(calls.length).toBe(1);
    expect(calls[0].page).toBe(4);

    await vi.advanceTimersByTimeAsync(120);

    // The debounced fetch fires last and MUST be for the current page (4),
    // not the page the user has already left (1).
    const debounced = calls[calls.length - 1];
    expect(debounced.query).toBe("alice");
    expect(debounced.page).toBe(4);
  });
});

describe("overlapping fetches resolve correctly", () => {
  it("the latest query's response wins when an earlier slow response lands after @race", async () => {
    // Hint: this test fails on the unmodified starter.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5, debounceMs: 50 });
    const states = [];
    s.subscribe((st) => states.push(st));

    s.setQuery("slow");
    await vi.advanceTimersByTimeAsync(60); // fire debounce → calls[0]
    s.setQuery("fast");
    await vi.advanceTimersByTimeAsync(60); // fire debounce → calls[1]

    expect(calls.length).toBe(2);

    // Resolve the newer one first, then the older one. The state must end
    // up showing the newer ("fast") results.
    calls[1].resolve({ users: fakeUsers("fast", 3), total: 3 });
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve({ users: fakeUsers("slow", 7), total: 7 });
    await vi.advanceTimersByTimeAsync(0);

    const final = s.getState();
    expect(final.users.map((u) => u.id)).toEqual(["fast-0", "fast-1", "fast-2"]);
    expect(final.total).toBe(3);
  });
});

describe("pagination math", () => {
  it("totalPages is 2 when pageSize divides total cleanly @pagination", async () => {
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });
    s.setPage(1);
    calls[0].resolve({ users: fakeUsers("p", 5), total: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getState().totalPages).toBe(2);
  });

  it("totalPages includes the trailing partial page @pagination", async () => {
    // Hint: this test fails on the unmodified starter.
    const { fetcher, calls } = deferredFetcher();
    const s = new UserSearch({ fetchUsers: fetcher, pageSize: 5 });
    s.setPage(1);
    calls[0].resolve({ users: fakeUsers("p", 5), total: 11 });
    await vi.advanceTimersByTimeAsync(0);
    // 11 users at pageSize 5 → 3 pages (5 + 5 + 1), not 2.
    expect(s.getState().totalPages).toBe(3);
  });
});
