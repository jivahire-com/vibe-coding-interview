import logging
import time
import threading
from collections import defaultdict
from fastapi import Header, HTTPException, Request
from vibe.db import query
from vibe.logging_config import bind_session

log = logging.getLogger("vibe.auth")

_rate_limits: dict[str, list[float]] = defaultdict(list)
_lock = threading.Lock()

RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW = 3600


def check_rate_limit(ip: str) -> None:
    now = time.time()
    with _lock:
        _rate_limits[ip] = [t for t in _rate_limits[ip] if now - t < RATE_LIMIT_WINDOW]
        if len(_rate_limits[ip]) >= RATE_LIMIT_MAX:
            log.warning("rate_limit_hit", extra={"context": {"ip": ip, "max": RATE_LIMIT_MAX}})
            raise HTTPException(429, "Rate limit: 5 attempts per hour per IP")
        _rate_limits[ip].append(now)


def get_session(authorization: str = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Bearer token")
    key = authorization[7:]
    rows = query("SELECT * FROM sessions WHERE session_key = ?", (key,))
    if not rows:
        log.warning("invalid_session_key")
        raise HTTPException(401, "Invalid session key")
    bind_session(rows[0]["id"])
    return rows[0]
