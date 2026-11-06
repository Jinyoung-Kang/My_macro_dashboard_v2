"""
app/services/toss_ratelimit.py
토스증권 계좌·매매 호출의 그룹별 속도 조절(ADR 0028, 명세 docs/specs/2026-11-06-real-trade-mirror.md §5.1).

토스는 **클라이언트 × API 그룹** 단위로 초당 요청 수를 셉니다(공식 스펙 'Rate Limits'). 실제 계좌 조회(toss_account)와
실제 매매(toss_trade)는 같은 키로 같은 그룹을 쓰므로, 두 모듈이 이 한 곳의 토큰 버킷을 함께 씁니다. 한도는 토스가 밝힌 값보다
낮게 잡았습니다(피크 시간 ORDER_INFO 3회 등 — 공지 없이 바뀔 수 있다고 적혀 있음).

  - 버킷 용량은 1초어치(초당 한도와 같은 수)이고, 비면 다음 토큰까지 기다립니다.
  - 기다림은 요청 하나에 최대 :data:`MAX_WAIT_SECONDS`초 — 넘으면 기다리지 않고 False(부르는 쪽이 ``rate-limited``로 끝냄).
  - 표에 없는 그룹(계좌 목록·장 운영 정보 등 드물게 부르는 것)은 세지 않습니다.
"""
from __future__ import annotations

import re
import threading
import time

MAX_WAIT_SECONDS = 3.0

# 그룹 → 초당 한도(명세 §5.1). 토스가 밝힌 한도: ORDER 10, ORDER_HISTORY 5, ORDER_INFO 6(09:00~09:10 3), ASSET 5, MARKET_DATA 15.
RATES = {
    "ORDER": 5.0,
    "ORDER_HISTORY": 3.0,
    "ORDER_INFO": 2.0,
    "ASSET": 3.0,
    "MARKET_DATA": 8.0,
}

# (메서드, 경로 정규식, 그룹) — 공식 스펙 1.2.28의 'Rate Limits Group' 표기대로.
_ROUTES = (
    ("POST", re.compile(r"/api/v1/orders(/[^/]+/cancel)?"), "ORDER"),
    ("GET", re.compile(r"/api/v1/orders(/[^/]+)?"), "ORDER_HISTORY"),
    ("GET", re.compile(r"/api/v1/(buying-power|sellable-quantity)"), "ORDER_INFO"),
    ("GET", re.compile(r"/api/v1/holdings"), "ASSET"),
    ("GET", re.compile(r"/api/v1/(prices|price-limits)"), "MARKET_DATA"),
)


class _Bucket:
    def __init__(self, rate: float, now: float) -> None:
        self.rate = rate
        self.tokens = rate
        self.updated = now


_lock = threading.Lock()
_buckets: dict[str, _Bucket] = {}


def _monotonic() -> float:
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def reset_for_tests() -> None:
    """버킷을 모두 비웁니다(다음 호출에서 가득 찬 채로 다시 만듦). 시험 사이의 격리용입니다."""
    with _lock:
        _buckets.clear()


def group_for(method: str, path: str) -> str | None:
    """요청의 그룹 이름. 표에 없으면 None(세지 않음)."""
    upper = (method or "").upper()
    for route_method, pattern, group in _ROUTES:
        if upper == route_method and pattern.fullmatch(path or ""):
            return group
    return None


def acquire(group: str | None, max_wait: float = MAX_WAIT_SECONDS) -> bool:
    """
    그 그룹의 토큰 하나를 씁니다. 토큰이 없으면 생길 때까지 기다립니다(잠금 밖에서).

    :param group: :func:`group_for`의 값. None이거나 표에 없으면 바로 True
    :param max_wait: 기다릴 수 있는 최대 초(:data:`MAX_WAIT_SECONDS`를 넘지 않음). 더 기다려야 하면 토큰을 쓰지 않고 False
    """
    rate = RATES.get(group or "")
    if rate is None:
        return True
    limit = max(0.0, min(max_wait, MAX_WAIT_SECONDS))
    with _lock:
        now = _monotonic()
        bucket = _buckets.get(group)
        if bucket is None:
            bucket = _buckets[group] = _Bucket(rate, now)
        bucket.tokens = min(bucket.rate, bucket.tokens + (now - bucket.updated) * bucket.rate)
        bucket.updated = now
        wait = 0.0 if bucket.tokens >= 1.0 else (1.0 - bucket.tokens) / bucket.rate
        if wait > limit:
            return False
        bucket.tokens -= 1.0   # 기다릴 몫을 미리 잡아 둡니다 — 뒤에 온 요청은 그만큼 더 기다림
    if wait > 0:
        _sleep(wait)
    return True
