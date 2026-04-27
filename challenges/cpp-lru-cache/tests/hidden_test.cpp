// Hidden tests — not visible in the candidate's branch.
// Grader copies this file into tests/ before building.
#include <atomic>
#include <memory>
#include <optional>
#include <thread>
#include <vector>
#include <catch2/catch_test_macros.hpp>
#include "lru_cache.hpp"

// --- [basic] hidden ---

TEST_CASE("cache does not exceed capacity on insert", "[basic]") {
    // Exercises the off-by-one bug: > vs >= in the eviction loop.
    LRUCache<int, int> cache(3);
    for (int i = 0; i < 10; ++i) cache.put(i, i);
    REQUIRE(cache.size() == 3);
}

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

TEST_CASE("concurrent put does not corrupt state", "[thread]") {
    LRUCache<int, int> cache(64);
    constexpr int N = 8;
    constexpr int OPS = 200;

    std::vector<std::thread> threads;
    for (int t = 0; t < N; ++t) {
        threads.emplace_back([&, t] {
            for (int i = 0; i < OPS; ++i) {
                cache.put(t * OPS + i, i);
            }
        });
    }
    for (auto& th : threads) th.join();
    // No assertion on values — we just need it to not crash or data-race.
    REQUIRE(cache.size() <= 64);
}

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

// --- [edge] hidden ---

TEST_CASE("capacity zero never stores entries", "[edge]") {
    // A cache with capacity 0 should be effectively a no-op store.
    LRUCache<int, int> cache(0);
    cache.put(1, 1);
    REQUIRE(cache.size() == 0);
    REQUIRE(cache.get(1) == std::nullopt);
}

TEST_CASE("move-only value type compiles and works", "[edge]") {
    LRUCache<int, std::unique_ptr<int>> cache(2);
    cache.put(1, std::make_unique<int>(42));
    cache.put(2, std::make_unique<int>(99));
    auto v = cache.get(1);
    REQUIRE(v.has_value());
    REQUIRE(**v == 42);
}
