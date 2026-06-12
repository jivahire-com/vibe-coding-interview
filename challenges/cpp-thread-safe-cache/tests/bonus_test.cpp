// Tests for the bonus features: observability counters, per-entry TTL, and the
// eviction callback. TTL tests drive an injected fake clock so they are
// deterministic and instant.
#include <atomic>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include <catch2/catch_test_macros.hpp>
#include "lru_cache.hpp"

using namespace std::chrono_literals;

// A controllable clock for TTL tests.
struct FakeClock {
    std::shared_ptr<LRUCache<int, int>::TimePoint> now;
    FakeClock() : now(std::make_shared<LRUCache<int, int>::TimePoint>()) {}
    LRUCache<int, int>::ClockFn fn() const {
        auto n = now;
        return [n] { return *n; };
    }
    void advance(LRUCache<int, int>::Duration d) { *now += d; }
};

// --- Observability ---------------------------------------------------------

TEST_CASE("stats counts hits and misses", "[bonus][stats]") {
    LRUCache<int, int> cache(4);
    cache.put(1, 10);
    cache.put(2, 20);

    REQUIRE(cache.get(1).has_value());   // hit
    REQUIRE(cache.get(2).has_value());   // hit
    REQUIRE(!cache.get(99).has_value()); // miss

    auto s = cache.stats();
    REQUIRE(s.hits == 2);
    REQUIRE(s.misses == 1);
    REQUIRE(s.size == 2);
    REQUIRE(s.capacity == 4);
    REQUIRE(s.hit_rate() == 2.0 / 3.0);
}

TEST_CASE("stats counts capacity evictions", "[bonus][stats]") {
    LRUCache<int, int> cache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.put(3, 3);  // evicts 1
    cache.put(4, 4);  // evicts 2

    auto s = cache.stats();
    REQUIRE(s.evictions == 2);
    REQUIRE(s.size == 2);
}

// --- TTL -------------------------------------------------------------------

TEST_CASE("entry is served before its TTL and gone after", "[bonus][ttl]") {
    FakeClock clk;
    LRUCache<int, int> cache(4, clk.fn());

    cache.put(1, 100, 1000ms);

    clk.advance(999ms);
    REQUIRE(cache.get(1) == std::optional<int>(100));  // still fresh

    clk.advance(2ms);  // now past expiry
    REQUIRE(cache.get(1) == std::nullopt);             // expired

    auto s = cache.stats();
    REQUIRE(s.expirations == 1);
    REQUIRE(s.size == 0);  // expired entry was reclaimed on access
}

TEST_CASE("entries without a TTL never expire", "[bonus][ttl]") {
    FakeClock clk;
    LRUCache<int, int> cache(4, clk.fn());
    cache.put(1, 100);             // no ttl
    clk.advance(1000000ms);
    REQUIRE(cache.get(1) == std::optional<int>(100));
}

TEST_CASE("re-putting a key refreshes its TTL", "[bonus][ttl]") {
    FakeClock clk;
    LRUCache<int, int> cache(4, clk.fn());
    cache.put(1, 1, 100ms);
    clk.advance(80ms);
    cache.put(1, 2, 100ms);  // refresh
    clk.advance(80ms);       // 160ms since first put, 80ms since refresh
    REQUIRE(cache.get(1) == std::optional<int>(2));
}

// --- Eviction callback -----------------------------------------------------

TEST_CASE("on_evict fires with the dropped key and value", "[bonus][evict]") {
    LRUCache<int, std::string> cache(2);
    std::vector<std::pair<int, std::string>> dropped;
    cache.set_on_evict([&](const int& k, const std::string& v) {
        dropped.emplace_back(k, v);
    });

    cache.put(1, "one");
    cache.put(2, "two");
    cache.put(3, "three");  // evicts (1, "one")

    REQUIRE(dropped.size() == 1);
    REQUIRE(dropped[0].first == 1);
    REQUIRE(dropped[0].second == "one");
}

TEST_CASE("on_evict does not fire on update or TTL expiry", "[bonus][evict]") {
    FakeClock clk;
    LRUCache<int, int> cache(2, clk.fn());
    std::atomic<int> calls{0};
    cache.set_on_evict([&](const int&, const int&) { ++calls; });

    cache.put(1, 1, 10ms);
    cache.put(1, 2);   // update, not an eviction
    clk.advance(20ms);
    cache.get(1);      // TTL expiry, not a capacity eviction
    REQUIRE(calls.load() == 0);
}

TEST_CASE("on_evict may safely call back into the cache", "[bonus][evict]") {
    // The callback runs outside the lock, so re-entrancy must not deadlock.
    LRUCache<int, int> cache(1);
    std::atomic<int> calls{0};
    cache.set_on_evict([&](const int&, const int&) {
        ++calls;
        cache.size();   // re-enter: would deadlock if called under the lock
    });
    cache.put(1, 1);
    cache.put(2, 2);  // evicts 1, callback re-enters
    REQUIRE(calls.load() == 1);
}

// --- Counters are thread-safe ----------------------------------------------

TEST_CASE("counters are not corrupted under concurrent access", "[bonus][thread]") {
    LRUCache<int, int> cache(64);
    for (int i = 0; i < 64; ++i) cache.put(i, i);

    constexpr int N = 8;
    constexpr int OPS = 1000;
    std::vector<std::thread> threads;
    for (int t = 0; t < N; ++t) {
        threads.emplace_back([&] {
            for (int i = 0; i < OPS; ++i) cache.get(i % 128);  // half hit, half miss
        });
    }
    for (auto& th : threads) th.join();

    auto s = cache.stats();
    // Every get is exactly one hit or one miss; no update is lost to a race.
    REQUIRE(s.hits + s.misses == static_cast<uint64_t>(N) * OPS);
}
