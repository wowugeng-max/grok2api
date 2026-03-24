"""
Proxy pool with sticky selection and failover rotation.

Supports comma-separated proxy URLs in config. Callers keep using the
current proxy until a retry path explicitly rotates to the next one.
"""

import threading
import time
from typing import Optional

from app.core.logger import logger

# ---- internal state ----
_lock = threading.Lock()
_pools: dict[str, list[str]] = {}  # key -> parsed list
_indexes: dict[str, int] = {}  # key -> current index
_raw_cache: dict[str, str] = {}  # key -> last raw config value
_FAILOVER_STATUS_CODES = frozenset({403, 429, 502})
_failure_counts: dict[tuple[str, str], int] = {}  # (config_key, proxy_url) -> count
_banned_until: dict[tuple[str, str], float] = {}  # (config_key, proxy_url) -> monotonic ts


def _parse_proxies(raw: str) -> list[str]:
    """Parse comma-separated proxy URLs, stripping whitespace and empties."""
    if not raw:
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]


def _ensure_pool(config_key: str) -> list[str]:
    """Load and cache the proxy list for *config_key*."""
    from app.core.config import config  # avoid circular at module level

    raw = config.get(config_key, "") or ""
    if raw != _raw_cache.get(config_key):
        proxies = _parse_proxies(raw)
        _pools[config_key] = proxies
        _indexes[config_key] = 0
        _raw_cache[config_key] = raw
        if len(proxies) > 1:
            logger.info(
                f"ProxyPool: {config_key} loaded {len(proxies)} proxies for failover"
            )
    return _pools.get(config_key, [])


def _load_circuit_breaker_config() -> tuple[int, float]:
    from app.core.config import config  # avoid circular at module level

    threshold = config.get("proxy.fail_403_threshold", 3)
    cooldown_sec = config.get("proxy.fail_403_cooldown_sec", 300)
    try:
        threshold = int(threshold)
    except Exception:
        threshold = 3
    try:
        cooldown_sec = float(cooldown_sec)
    except Exception:
        cooldown_sec = 300.0
    if threshold < 1:
        threshold = 1
    if cooldown_sec < 0:
        cooldown_sec = 0.0
    return threshold, cooldown_sec


def _is_proxy_banned(config_key: str, proxy_url: str) -> bool:
    banned_until = _banned_until.get((config_key, proxy_url), 0.0)
    return banned_until > time.monotonic()


def _next_available_proxy_index(config_key: str, pool: list[str], start_idx: int) -> int:
    if not pool:
        return 0
    total = len(pool)
    for offset in range(total):
        idx = (start_idx + offset) % total
        proxy_url = pool[idx]
        if not _is_proxy_banned(config_key, proxy_url):
            return idx
    return start_idx % total


def get_current_proxy(config_key: str) -> str:
    """Return the current sticky proxy URL for *config_key*."""
    with _lock:
        pool = _ensure_pool(config_key)
        if not pool:
            return ""
        current_idx = _indexes.get(config_key, 0) % len(pool)
        selected_idx = _next_available_proxy_index(config_key, pool, current_idx)
        _indexes[config_key] = selected_idx
        return pool[selected_idx]


def get_current_proxy_from(*config_keys: str) -> tuple[Optional[str], str]:
    """Return the first configured sticky proxy from *config_keys*."""
    for config_key in config_keys:
        proxy = get_current_proxy(config_key)
        if proxy:
            return config_key, proxy
    return None, ""


def rotate_proxy(config_key: str) -> str:
    """Advance *config_key* to the next proxy and return it."""
    with _lock:
        pool = _ensure_pool(config_key)
        if not pool:
            return ""
        if len(pool) == 1:
            return pool[0]
        start_idx = (_indexes.get(config_key, 0) + 1) % len(pool)
        next_idx = _next_available_proxy_index(config_key, pool, start_idx)
        _indexes[config_key] = next_idx
        proxy = pool[next_idx]
        logger.warning(
            f"ProxyPool: rotate {config_key} to index {next_idx + 1}/{len(pool)}"
        )
        return proxy


def record_proxy_status(config_key: Optional[str], proxy_url: str, status_code: Optional[int]):
    """Record proxy request outcome for simple circuit breaker behavior."""
    if not config_key or not proxy_url:
        return
    if status_code is None:
        return

    key = (config_key, proxy_url)
    should_rotate = False
    with _lock:
        if status_code == 403:
            threshold, cooldown_sec = _load_circuit_breaker_config()
            current = _failure_counts.get(key, 0) + 1
            _failure_counts[key] = current
            if current >= threshold:
                banned_until = time.monotonic() + cooldown_sec
                _banned_until[key] = banned_until
                _failure_counts[key] = 0
                logger.warning(
                    f"ProxyPool: circuit open for {config_key} proxy after {threshold}x403, "
                    f"cooldown={cooldown_sec:.0f}s"
                )
                should_rotate = True
        else:
            # 非 403 视为恢复，清理失败计数与熔断状态
            if key in _failure_counts:
                _failure_counts[key] = 0
            if key in _banned_until and _banned_until[key] <= time.monotonic():
                _banned_until.pop(key, None)

    if should_rotate:
        rotate_proxy(config_key)


def should_rotate_proxy(status_code: Optional[int]) -> bool:
    """Return whether *status_code* should trigger proxy failover."""
    return status_code in _FAILOVER_STATUS_CODES


def get_proxy_pool_health() -> dict[str, dict]:
    """Return proxy pool runtime health snapshot (per config_key)."""
    now = time.monotonic()
    with _lock:
        result: dict[str, dict] = {}
        for config_key in set(_pools.keys()) | set(_raw_cache.keys()):
            pool = _ensure_pool(config_key)
            items = []
            for proxy_url in pool:
                key = (config_key, proxy_url)
                failure_count = int(_failure_counts.get(key, 0))
                banned_until = float(_banned_until.get(key, 0.0))
                remaining_sec = max(0.0, banned_until - now)
                items.append(
                    {
                        "proxy": proxy_url,
                        "failure_403_count": failure_count,
                        "is_banned": remaining_sec > 0,
                        "cooldown_remaining_sec": round(remaining_sec, 2),
                    }
                )
            result[config_key] = {
                "size": len(pool),
                "current_index": int(_indexes.get(config_key, 0)),
                "items": items,
            }
        return result


def build_http_proxies(proxy_url: str) -> Optional[dict[str, str]]:
    """Build curl_cffi-style proxies mapping from a single proxy URL."""
    if not proxy_url:
        return None
    return {"http": proxy_url, "https": proxy_url}


__all__ = [
    "build_http_proxies",
    "get_current_proxy",
    "get_current_proxy_from",
    "rotate_proxy",
    "should_rotate_proxy",
    "record_proxy_status",
    "get_proxy_pool_health",
]
