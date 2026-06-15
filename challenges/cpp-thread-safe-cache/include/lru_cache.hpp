#pragma once
#include <cstddef>
#include <list>
#include <optional>
#include <unordered_map>
#include <utility>

// LRUCache<K, V> — a fixed-capacity cache that evicts the least-recently-used
// (LRU) entry when full. The starter is single-threaded.
//
// Contract (README.md is authoritative):
//   * Never holds more than `capacity` entries.
//   * get(key) returns the value if present and marks it most-recently-used.
//   * put(key, value) inserts or updates; at capacity it evicts the LRU entry.
//   * Every operation must be safe to call concurrently from multiple threads.
//
// Workload: read-heavy — get() is called far more often than put().

template <typename K, typename V>
class LRUCache {
public:
    explicit LRUCache(size_t capacity) : capacity_(capacity) {}

    std::optional<V> get(const K& key) {
        auto it = map_.find(key);
        if (it == map_.end()) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return it->second->second;
    }

    void put(const K& key, V value) {
        auto it = map_.find(key);
        if (it != map_.end()) {
            list_.splice(list_.begin(), list_, it->second);
            it->second->second = std::move(value);
            return;
        }
        while (list_.size() > capacity_) {
            auto last = std::prev(list_.end());
            map_.erase(last->first);
            list_.erase(last);
        }
        list_.emplace_front(key, std::move(value));
        map_[key] = list_.begin();
    }

    size_t size() const { return list_.size(); }

    void clear() {
        list_.clear();
        map_.clear();
    }

private:
    size_t capacity_;
    std::list<std::pair<K, V>> list_;
    std::unordered_map<K, typename std::list<std::pair<K, V>>::iterator> map_;
};
