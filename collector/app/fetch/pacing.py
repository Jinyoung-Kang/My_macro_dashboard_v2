"""
app/fetch/pacing.py
같은 호스트로 가는 요청 사이의 불규칙한 지연 (명세 §3).

공용 세션의 호스트 간격(app/http.pace — 0.2초 + 몰릴 때만 지터)은 병렬 수집이 한 호스트를 같은 순간에 두드리지 않게 하는 장치이고,
여기는 사람이 페이지를 넘기는 것 같은 초 단위 틈입니다. 그 실행에서 그 호스트로 가는 첫 요청은 기다리지 않습니다(앞 실행과 이미 몇 시간
떨어져 있음).

시간 예산: 태스크 안에서는 지연 뒤에도 요청 하나를 보내고 저장할 시간이 남아야 합니다. 모자라면 자지 않고 :class:`OutOfTime`을 올립니다 —
부르는 쪽은 서두르지 않고 남은 것을 다음 회차로 넘깁니다.
"""
from __future__ import annotations

import math
import random
import threading
import time

from .. import http
from .policy import Gap

# 지연 뒤에 이만큼(요청 하나 + 저장)은 남아야 잡니다.
MIN_LEFT_AFTER_PAUSE = 45.0

# 시험이 난수·시계·잠을 바꿔 끼우는 자리입니다.
_rng = random.Random()
_now = time.monotonic
_sleep = time.sleep

_lock = threading.Lock()
_last_request: dict[str, float] = {}     # 호스트 → 마지막으로 보낸 시각(이 프로세스 안)


class OutOfTime(Exception):
    """태스크 시간 예산이 지연 하나를 더 기다릴 만큼 남지 않음 — 보내지 않았습니다."""


def draw(gap: Gap) -> float:
    """``gap``에서 지연 하나(초)를 뽑습니다."""
    if _rng.random() < gap.long_chance:
        base = _rng.uniform(gap.long_low, gap.long_high)
    else:
        base = min(max(_rng.lognormvariate(math.log(gap.median), gap.sigma), gap.low), gap.high)
    return base + _rng.uniform(0.0, 0.999)


def pace(host: str, gap: Gap) -> float:
    """
    ``host``로 가는 앞 요청과의 사이를 ``gap``에서 뽑은 만큼 띄웁니다 → 실제로 기다린 초(첫 요청이거나 이미 그만큼 지났으면 0).

    :raises OutOfTime: 태스크 시간 예산이 모자라 기다리지 않음(이 호출은 '보낸 시각'을 적지 않습니다)
    """
    host = host.lower()
    with _lock:
        last = _last_request.get(host)
    wait = 0.0
    if last is not None:
        wait = max(0.0, draw(gap) - (_now() - last))
    left = http.time_left()
    if left is not None and left - wait < MIN_LEFT_AFTER_PAUSE:
        raise OutOfTime(f"태스크 시간 예산이 {max(left, 0.0):.0f}초 남아 {host} 요청을 다음 회차로 넘김")
    if wait > 0:
        _sleep(wait)
    with _lock:
        _last_request[host] = _now()
    return wait


def mark(host: str) -> None:
    """
    ``host``로 지금 보낸다고 다시 적습니다 — :func:`pace` 뒤 보내기 전에 더 기다린 길(브라우저 컨테이너가 다른 요청을 받는 중)이 실제로 보내는
    순간을 적어, 그만큼 같은 호스트의 다음 간격이 줄지 않게 합니다.
    """
    with _lock:
        _last_request[host.lower()] = _now()


def reset() -> None:
    """보낸 시각 기록을 비웁니다(시험 사이의 격리용)."""
    with _lock:
        _last_request.clear()
