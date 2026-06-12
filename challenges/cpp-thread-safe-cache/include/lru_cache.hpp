#pragma once
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <list>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <utility>
#include <vector>

// LRUCache<K, V> — a fixed-capacity, thread-safe cache that evicts the
// least-recently-used (LRU) entry when full.
//
// Contract (README.md is authoritative):
//   * Never holds more than `capacity` entries.
//   * get(key) returns the value if present and marks it most-recently-used.
//   * put(key, value) inserts or updates; at capacity it evicts the LRU entry.
//   * Every operation is safe to call concurrently from multiple threads.
//
// Workload: read-heavy — get() is called far more often than put().
//
// Concurrency design
// ------------------
// A single std::mutex guards every operation. get() looks like a read but it
// promotes the entry it returns (splicing the node to the front), so it MUTATES
// internal state — it cannot run under a shared/read lock. One exclusive mutex
// is therefore both the simplest and the correct choice here; a shared_mutex on
// get() would be a data race.
//
// Bonus features (see NOTES.md) — all of their new state lives under the same
// mutex, so a counter two threads bump cannot be corrupted:
//   * Observability  — hit / miss / eviction / expiry counters via stats().
//   * TTL            — optional per-entry expiry so stale values are not served.
//   * Eviction hook  — on_evict callback so another subsystem learns when an
//                      entry is dropped to make room. The callback runs OUTSIDE
//                      the lock, so it may safely call back into the cache.

template <typename K, typename V>
class LRUCache {
public:
    using Clock = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;
    using Duration = Clock::duration;
    using ClockFn = std::function<TimePoint()>;
    using EvictionCallback = std::function<void(const K&, const V&)>;

    // Snapshot of lifetime counters plus current occupancy. Taken atomically
    // under the lock, so the fields are mutually consistent.
    struct Stats {
        uint64_t hits = 0;        // get() that returned a live value
        uint64_t misses = 0;      // get() that found nothing (absent or expired)
        uint64_t evictions = 0;   // entries dropped to stay within capacity
        uint64_t expirations = 0; // entries dropped because their TTL elapsed
        size_t size = 0;          // entries currently held
        size_t capacity = 0;

        double hit_rate() const {
            uint64_t total = hits + misses;
            return total ? static_cast<double>(hits) / total : 0.0;
        }
    };

    // `clock` is injectable so TTL behaviour is deterministic in tests; it
    // defaults to the real monotonic clock.
    explicit LRUCache(size_t capacity, ClockFn clock = {})
        : capacity_(capacity),
          clock_(clock ? std::move(clock)
                       : ClockFn([] { return Clock::now(); })) {}

    // Register (or clear) the eviction callback. Invoked once per entry that is
    // dropped to make room — not for TTL expiry, which is a separate concern.
    void set_on_evict(EvictionCallback cb) {
        std::lock_guard<std::mutex> lk(mutex_);
        on_evict_ = std::move(cb);
    }

    std::optional<V> get(const K& key) {
        std::lock_guard<std::mutex> lk(mutex_);
        auto it = map_.find(key);
        if (it == map_.end()) {
            ++misses_;
            return std::nullopt;
        }
        if (is_expired(it->second)) {
            list_.erase(it->second);
            map_.erase(it);
            ++expirations_;
            ++misses_;
            return std::nullopt;
        }
        list_.splice(list_.begin(), list_, it->second);
        ++hits_;
        return it->second->value;
    }

    // Insert or update with no expiry.
    void put(const K& key, V value) {
        put_impl(key, std::move(value), TimePoint::max());
    }

    // Insert or update; the entry expires `ttl` from now.
    void put(const K& key, V value, Duration ttl) {
        put_impl(key, std::move(value), clock_() + ttl);
    }

    size_t size() const {
        std::lock_guard<std::mutex> lk(mutex_);
        return list_.size();
    }

    Stats stats() const {
        std::lock_guard<std::mutex> lk(mutex_);
        return Stats{hits_, misses_, evictions_, expirations_,
                     list_.size(), capacity_};
    }

    void clear() {
        std::lock_guard<std::mutex> lk(mutex_);
        list_.clear();
        map_.clear();
        // Counters are lifetime totals for the operator — clearing entries does
        // not reset them.
    }

private:
    struct Entry {
        K key;
        V value;
        TimePoint expires_at;
    };
    using ListIt = typename std::list<Entry>::iterator;

    bool is_expired(const ListIt& it) const {
        return it->expires_at != TimePoint::max() && clock_() >= it->expires_at;
    }

    void put_impl(const K& key, V value, TimePoint expires_at) {
        // Entries evicted to make room are handed to the callback AFTER the lock
        // is released, so a callback that re-enters the cache cannot deadlock.
        std::vector<std::pair<K, V>> evicted;
        EvictionCallback cb;
        {
            std::lock_guard<std::mutex> lk(mutex_);
            if (capacity_ == 0) return;  // a 0-capacity cache stores nothing

            auto it = map_.find(key);
            if (it != map_.end()) {
                list_.splice(list_.begin(), list_, it->second);
                it->second->value = std::move(value);
                it->second->expires_at = expires_at;
                return;
            }

            while (list_.size() >= capacity_) {
                auto last = std::prev(list_.end());
                evicted.emplace_back(last->key, std::move(last->value));
                map_.erase(last->key);
                list_.erase(last);
                ++evictions_;
            }

            list_.push_front(Entry{key, std::move(value), expires_at});
            map_[key] = list_.begin();

            if (!evicted.empty()) cb = on_evict_;  // copy under lock, call outside
        }
        if (cb) {
            for (auto& kv : evicted) cb(kv.first, kv.second);
        }
    }

    mutable std::mutex mutex_;
    size_t capacity_;
    ClockFn clock_;
    EvictionCallback on_evict_;
    std::list<Entry> list_;
    std::unordered_map<K, ListIt> map_;

    uint64_t hits_ = 0;
    uint64_t misses_ = 0;
    uint64_t evictions_ = 0;
    uint64_t expirations_ = 0;
};
