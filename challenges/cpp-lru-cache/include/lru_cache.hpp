#pragma once
#include <cstddef>
#include <list>
#include <optional>
#include <unordered_map>
#include <utility>

// TODO(candidate): make get/put/size/clear thread-safe under concurrent access.
//                  The public [basic] tests are single-threaded and pass as-is.
//                  The hidden [thread] tests run multiple std::threads concurrently
//                  and will fail without synchronisation.

template <typename K, typename V>
class LRUCache {
public:
    explicit LRUCache(size_t capacity) : capacity_(capacity) {}

    // Returns the value for key and promotes it to most-recently-used.
    // Returns std::nullopt if not present.
    std::optional<V> get(const K& key) {
        auto it = map_.find(key);
        if (it == map_.end()) return std::nullopt;
        list_.splice(list_.begin(), list_, it->second);
        return it->second->second;
    }

    // Inserts or updates key→value. Evicts the least-recently-used entry
    // when the cache is at capacity.
    // TODO(candidate): handle capacity == 0 safely — currently causes
    //                  incorrect behaviour on the first put.
    void put(const K& key, V value) {
        auto it = map_.find(key);
        if (it != map_.end()) {
            list_.splice(list_.begin(), list_, it->second);
            it->second->second = std::move(value);
            return;
        }
        // TODO(candidate): the eviction condition below has an off-by-one error.
        //                  A full cache should evict before inserting, but currently
        //                  it allows the cache to grow one entry beyond capacity.
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
    // TODO(candidate): add synchronisation primitive here.
};
