"""Thread-safe TTL cache with size-bounded LRU eviction.

TODO(candidate): make get/put/size/clear thread-safe under concurrent access.
                 The public `basic` tests are single-threaded and pass as-is.
                 The hidden `thread` tests run multiple threads concurrently
                 and will fail without synchronisation.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Generic, Hashable, Optional, TypeVar

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


class TTLCache(Generic[K, V]):
    def __init__(self, capacity: int, ttl_seconds: float) -> None:
        self._capacity = capacity
        self._ttl = ttl_seconds
        # value -> (value, inserted_at_monotonic)
        self._data: "OrderedDict[K, tuple[V, float]]" = OrderedDict()
        # TODO(candidate): add a synchronisation primitive here.

    def get(self, key: K) -> Optional[V]:
        """Return the value for `key` and promote it to most-recently-used.

        Returns None if the key is absent OR if its TTL has elapsed.
        TODO(candidate): the current implementation does not check TTL —
                         expired entries are returned as if still valid.
        """
        entry = self._data.get(key)
        if entry is None:
            return None
        value, _inserted_at = entry
        self._data.move_to_end(key, last=False)
        return value

    def put(self, key: K, value: V) -> None:
        """Insert or update `key` -> `value`.

        Evicts the least-recently-used entry when the cache is at capacity.
        TODO(candidate): handle capacity == 0 safely — currently the first
                         put inserts an entry instead of being a no-op.
        """
        if key in self._data:
            self._data[key] = (value, time.monotonic())
            self._data.move_to_end(key, last=False)
            return

        # TODO(candidate): the eviction condition below has an off-by-one
        # error. A full cache should evict before inserting, but currently
        # it allows the cache to grow one entry beyond capacity.
        while len(self._data) > self._capacity:
            self._data.popitem(last=True)

        self._data[key] = (value, time.monotonic())
        self._data.move_to_end(key, last=False)

    def size(self) -> int:
        return len(self._data)

    def clear(self) -> None:
        self._data.clear()
