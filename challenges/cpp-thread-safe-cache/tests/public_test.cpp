#include <catch2/catch_test_macros.hpp>
#include "lru_cache.hpp"

// @doc: Round-trips values — what put() stores comes back from get(), and an absent key returns nullopt.
TEST_CASE("basic get and put", "[basic]") {
    LRUCache<int, std::string> cache(3);
    cache.put(1, "one");
    cache.put(2, "two");
    cache.put(3, "three");

    REQUIRE(cache.get(1) == std::optional<std::string>("one"));
    REQUIRE(cache.get(2) == std::optional<std::string>("two"));
    REQUIRE(cache.get(3) == std::optional<std::string>("three"));
    REQUIRE(cache.get(99) == std::nullopt);
}

// @doc: get() promotes an entry to most-recently-used, so the next insert at capacity evicts the other key.
TEST_CASE("LRU eviction order", "[basic]") {
    LRUCache<int, int> cache(2);
    cache.put(1, 10);
    cache.put(2, 20);
    // Access 1, making 2 the LRU
    cache.get(1);
    // Insert 3 — should evict 2
    cache.put(3, 30);

    REQUIRE(cache.get(2) == std::nullopt);
    REQUIRE(cache.get(1) == std::optional<int>(10));
    REQUIRE(cache.get(3) == std::optional<int>(30));
}

// @doc: Re-putting an existing key updates its value in place — size stays the same and nothing is evicted.
TEST_CASE("update existing key does not change size", "[basic]") {
    LRUCache<int, int> cache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    REQUIRE(cache.size() == 2);
    // Update key 1 — size must stay 2, key 2 must still be present
    cache.put(1, 100);
    REQUIRE(cache.size() == 2);
    REQUIRE(cache.get(2) == std::optional<int>(2));
    REQUIRE(cache.get(1) == std::optional<int>(100));
}

// @doc: clear() drops every entry — size() returns to 0 and previously-stored keys miss.
TEST_CASE("clear empties the cache", "[basic]") {
    LRUCache<std::string, int> cache(3);
    cache.put("a", 1);
    cache.put("b", 2);
    cache.clear();
    REQUIRE(cache.size() == 0);
    REQUIRE(cache.get("a") == std::nullopt);
}
