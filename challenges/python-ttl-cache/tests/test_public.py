import pytest

from ttl_cache import TTLCache


@pytest.mark.basic
def test_basic_get_and_put():
    cache: TTLCache[int, str] = TTLCache(capacity=3, ttl_seconds=60)
    cache.put(1, "one")
    cache.put(2, "two")
    cache.put(3, "three")

    assert cache.get(1) == "one"
    assert cache.get(2) == "two"
    assert cache.get(3) == "three"
    assert cache.get(99) is None


@pytest.mark.basic
def test_lru_eviction_order():
    cache: TTLCache[int, int] = TTLCache(capacity=2, ttl_seconds=60)
    cache.put(1, 10)
    cache.put(2, 20)
    # Access 1, making 2 the LRU
    assert cache.get(1) == 10
    # Insert 3 — should evict 2
    cache.put(3, 30)

    assert cache.get(2) is None
    assert cache.get(1) == 10
    assert cache.get(3) == 30


@pytest.mark.basic
def test_update_existing_key_does_not_change_size():
    cache: TTLCache[int, int] = TTLCache(capacity=2, ttl_seconds=60)
    cache.put(1, 1)
    cache.put(2, 2)
    assert cache.size() == 2
    # Update key 1 — size must stay 2, key 2 must still be present
    cache.put(1, 100)
    assert cache.size() == 2
    assert cache.get(2) == 2
    assert cache.get(1) == 100


@pytest.mark.basic
def test_clear_empties_the_cache():
    cache: TTLCache[str, int] = TTLCache(capacity=3, ttl_seconds=60)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.clear()
    assert cache.size() == 0
    assert cache.get("a") is None
