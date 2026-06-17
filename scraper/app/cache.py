"""Tiny thread-safe in-memory TTL cache (swap for Redis in production)."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

from . import config

_store: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def get_cached(key: str, fetch_fn: Callable[[], Any], ttl: int | None = None) -> Any:
    ttl = config.CACHE_TTL if ttl is None else ttl
    now = time.time()
    with _lock:
        entry = _store.get(key)
        if entry and now - entry["ts"] < ttl:
            return entry["data"]
    data = fetch_fn()  # computed outside the lock to avoid blocking other keys
    with _lock:
        _store[key] = {"data": data, "ts": time.time()}
    return data


def set_cached(key: str, data: Any) -> None:
    with _lock:
        _store[key] = {"data": data, "ts": time.time()}


def invalidate(prefix: str = "") -> None:
    with _lock:
        for k in [k for k in _store if k.startswith(prefix)]:
            del _store[k]
