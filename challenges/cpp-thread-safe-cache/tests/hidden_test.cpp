// Hidden tests — not visible in the candidate's branch.
// Grader copies this file into tests/ before building.
#include <atomic>
#include <optional>
#include <thread>
#include <vector>
#include <catch2/catch_test_macros.hpp>
#include "lru_cache.hpp"

// --- [basic] hidden ---

// @doc: Inserting far past capacity must never grow the cache beyond its limit (catches the > vs >= off-by-one).
TEST_CASE("cache does not exceed capacity on insert", "[basic]") {
    // Exercises the off-by-one bug: > vs >= in the eviction loop.
    LRUCache<int, int> cache(3);
    for (int i = 0; i < 10; ++i) cache.put(i, i);
    REQUIRE(cache.size() == 3);
}

// @doc: A get() between inserts re-orders recency, so the next eviction drops the genuinely least-recently-used key.
TEST_CASE("eviction correctness under interleaved reads", "[basic]") {
    LRUCache<int, int> cache(3);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.put(3, 3);
    cache.get(1);  // 1 now MRU; LRU is 2
    cache.put(4, 4);  // should evict 2
    REQUIRE(cache.get(2) == std::nullopt);
    REQUIRE(cache.get(1).has_value());
    REQUIRE(cache.get(3).has_value());
    REQUIRE(cache.get(4).has_value());
}

// --- [thread] hidden ---

// @doc: Many threads put()-ing distinct keys at once: every write must survive, so a lost entry means a data race.
TEST_CASE("concurrent put does not corrupt state", "[thread]") {
    // Capacity exceeds the number of distinct keys, so eviction never fires.
    // This isolates thread-safety from the [basic] eviction off-by-one: every
    // distinct insert must survive, so a missing entry means a data race
    // dropped a write. (ThreadSanitizer also flags the unsynchronised case.)
    constexpr int N = 8;
    constexpr int OPS = 200;
    LRUCache<int, int> cache(N * OPS * 2);

    std::vector<std::thread> threads;
    for (int t = 0; t < N; ++t) {
        threads.emplace_back([&, t] {
            for (int i = 0; i < OPS; ++i) {
                cache.put(t * OPS + i, i);
            }
        });
    }
    for (auto& th : threads) th.join();
    REQUIRE(cache.size() == N * OPS);
}

// @doc: Interleaved get()/put() across threads must never return a torn value — only k or k*2, never garbage.
TEST_CASE("concurrent get and put from many threads", "[thread]") {
    LRUCache<int, int> cache(32);
    for (int i = 0; i < 32; ++i) cache.put(i, i);

    std::atomic<int> mismatches{0};
    std::vector<std::thread> threads;
    for (int t = 0; t < 8; ++t) {
        threads.emplace_back([&, t] {
            for (int i = 0; i < 100; ++i) {
                int k = (t * 100 + i) % 32;
                cache.put(k, k * 2);
                auto v = cache.get(k);
                // Value must be either k or k*2 — if it's something else, state is corrupted.
                if (v.has_value() && *v != k && *v != k * 2) ++mismatches;
            }
        });
    }
    for (auto& th : threads) th.join();
    REQUIRE(mismatches.load() == 0);
}

// @doc: get() mutates state (it promotes the entry), so even pure concurrent reads need an exclusive lock — a shared/read lock here races.
TEST_CASE("concurrent reads of shared keys are race-free", "[thread]") {
    // get() promotes the entry it returns (it splices the node to the front),
    // so it MUTATES internal state — it is not a read-only operation. The
    // tempting "read-heavy → std::shared_mutex + std::shared_lock on get()"
    // optimization therefore lets many threads mutate list_ under a shared
    // lock: a data race. Under ThreadSanitizer this fails for that design and
    // passes only when get() holds an exclusive lock. Pure reads, no puts, so
    // the only way to race here is an under-locked get().
    LRUCache<int, int> cache(128);
    for (int i = 0; i < 128; ++i) cache.put(i, i);

    constexpr int N = 8;
    constexpr int OPS = 500;
    std::atomic<int> misses{0};
    std::vector<std::thread> threads;
    for (int t = 0; t < N; ++t) {
        threads.emplace_back([&] {
            for (int i = 0; i < OPS; ++i) {
                if (!cache.get(i % 128).has_value()) ++misses;
            }
        });
    }
    for (auto& th : threads) th.join();
    REQUIRE(misses.load() == 0);
}

// --- [edge] hidden ---

// @doc: A capacity-0 cache is a no-op store — put() keeps it empty and every get() misses.
TEST_CASE("capacity zero never stores entries", "[edge]") {
    // A cache with capacity 0 should be effectively a no-op store.
    LRUCache<int, int> cache(0);
    cache.put(1, 1);
    REQUIRE(cache.size() == 0);
    REQUIRE(cache.get(1) == std::nullopt);
}
