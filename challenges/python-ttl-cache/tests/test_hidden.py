# Hidden tests — not visible in the candidate's branch.
# Grader copies this file into tests/ before building.
import threading
import time

import pytest

from ttl_cache import TTLCache


# --- basic hidden ---


@pytest.mark.basic
def test_cache_does_not_exceed_capacity_on_insert():
    # Exercises the off-by-one bug: > vs >= in the eviction loop.
    cache: TTLCache[int, int] = TTLCache(capacity=3, ttl_seconds=60)
    for i in range(10):
        cache.put(i, i)
    assert cache.size() == 3


@pytest.mark.basic
def test_eviction_correctness_under_interleaved_reads():
    cache: TTLCache[int, int] = TTLCache(capacity=3, ttl_seconds=60)
    cache.put(1, 1)
    cache.put(2, 2)
    cache.put(3, 3)
    assert cache.get(1) == 1  # 1 now MRU; LRU is 2
    cache.put(4, 4)  # should evict 2
    assert cache.get(2) is None
    assert cache.get(1) is not None
    assert cache.get(3) is not None
    assert cache.get(4) is not None


# --- thread hidden ---


@pytest.mark.thread
def test_concurrent_put_does_not_corrupt_state():
    cache: TTLCache[int, int] = TTLCache(capacity=64, ttl_seconds=60)
    n_threads = 8
    ops = 200

    def worker(t: int) -> None:
        for i in range(ops):
            cache.put(t * ops + i, i)

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    # No assertion on values — we just need it to not crash and to respect cap.
    assert cache.size() <= 64


@pytest.mark.thread
def test_concurrent_get_and_put_from_many_threads():
    cache: TTLCache[int, int] = TTLCache(capacity=32, ttl_seconds=60)
    for i in range(32):
        cache.put(i, i)

    mismatches = 0
    mismatches_lock = threading.Lock()

    def worker(t: int) -> None:
        nonlocal mismatches
        local_bad = 0
        for i in range(100):
            k = (t * 100 + i) % 32
            cache.put(k, k * 2)
            v = cache.get(k)
            # Value must be either k or k*2 — anything else means corruption.
            if v is not None and v != k and v != k * 2:
                local_bad += 1
        if local_bad:
            with mismatches_lock:
                mismatches += local_bad

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert mismatches == 0


# --- edge hidden ---


@pytest.mark.edge
def test_capacity_zero_never_stores_entries():
    # A cache with capacity 0 should be effectively a no-op store.
    cache: TTLCache[int, int] = TTLCache(capacity=0, ttl_seconds=60)
    cache.put(1, 1)
    assert cache.size() == 0
    assert cache.get(1) is None


@pytest.mark.edge
def test_unhashable_key_raises():
    cache: TTLCache = TTLCache(capacity=2, ttl_seconds=60)
    with pytest.raises(TypeError):
        cache.put([1, 2], "x")  # list is unhashable


# --- ttl hidden ---


@pytest.mark.ttl
def test_get_returns_none_for_expired_entry():
    cache: TTLCache[int, int] = TTLCache(capacity=4, ttl_seconds=0.05)
    cache.put(1, 100)
    assert cache.get(1) == 100
    time.sleep(0.10)
    assert cache.get(1) is None


@pytest.mark.ttl
def test_put_refreshes_ttl():
    cache: TTLCache[int, int] = TTLCache(capacity=4, ttl_seconds=0.10)
    cache.put(1, 1)
    time.sleep(0.07)
    cache.put(1, 2)  # refresh
    time.sleep(0.07)  # total 0.14s since first put, only 0.07s since refresh
    assert cache.get(1) == 2
