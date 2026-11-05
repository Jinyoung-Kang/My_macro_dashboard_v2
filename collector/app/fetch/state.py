"""
app/fetch/state.py
닫힘·물러남·포기·하루 예산·고정 프로필·다음 실행 시각의 규칙 (명세 §3·§4). 값은 표 fetch_hosts·fetch_schedule에 있어 재기동해도
이어집니다(읽고 쓰기는 app/store.py).
"""
from __future__ import annotations

import random
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import get_args

import curl_cffi
from curl_cffi.requests.impersonate import BrowserTypeLiteral

from .. import kst, store
from . import policy

# 시험이 난수·시계를 바꿔 끼우는 자리입니다.
_rng = random.Random()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# 고정 프로필의 후보 수 — 지금 설치된 curl_cffi가 아는 데스크톱 Chrome 가운데 최신 몇 개(실제 사용자의 판 분포처럼).
PROFILE_CANDIDATES = 3
_DESKTOP_CHROME = re.compile(r"^chrome(\d+)$")
FALLBACK_PROFILE = "chrome"


@dataclass(frozen=True)
class Closed:
    """그 호스트가 닫혀 있음 — 기한(``until``)이 있거나 포기(``given_up``, 운영자가 풀 때까지)."""

    host: str
    reason: str
    until: datetime | None
    given_up: bool

    def message(self) -> str:
        """실행 기록·화면에 뜨는 한 줄. 주소는 싣지 않고 호스트만 적습니다."""
        if self.given_up:
            return (f"{self.host} {self.reason} · 연속 {policy.GIVE_UP_LEVEL}회 거부로 포기"
                    "(운영자가 풀 때까지 다시 시도하지 않음)")
        return f"{self.host} {self.reason} · {kst.stamp(self.until)}까지 이 출처 호출을 멈춤"


def closed(host: str) -> Closed | None:
    """``host``가 닫혀 있으면 그 사정, 열려 있으면 None(기한이 지난 닫힘은 열린 것)."""
    row = store.fetch_host(host)
    if row is None:
        return None
    reason = row["blocked_reason"] or "거부"
    if row["given_up"]:
        return Closed(host, reason, None, True)
    until = row["blocked_until"]
    if until is not None and until > _utcnow():
        return Closed(host, reason, until, False)
    return None


def note_success(host: str, tier: str) -> None:
    """통과 — 연속 거부를 0으로 되돌리고 통과한 계층을 기억합니다(다음에는 그 계층부터)."""
    store.save_fetch_host(host, last_good_tier=tier, fail_level=0, blocked_until=None, blocked_reason=None)


def note_rejected(host: str, why: str) -> Closed:
    """
    모든 계층에서 거부 — 연속 거부를 하나 올리고 그만큼 물러납니다. ``policy.GIVE_UP_LEVEL``에 닿으면 포기로 닫습니다.

    :param why: 거부 근거 한 줄("HTTP 403", "Cloudflare 챌린지") — 주소·응답 본문은 싣지 않습니다
    """
    row = store.fetch_host(host)
    level = int(row["fail_level"] if row else 0) + 1
    if level >= policy.GIVE_UP_LEVEL:
        store.save_fetch_host(host, fail_level=level, given_up=True, blocked_until=None, blocked_reason=why)
        return Closed(host, why, None, True)
    low, high = policy.BACKOFF_MINUTES[min(level, len(policy.BACKOFF_MINUTES)) - 1]
    until = _utcnow() + timedelta(minutes=_rng.uniform(low, high))
    store.save_fetch_host(host, fail_level=level, blocked_until=until, blocked_reason=why)
    return Closed(host, why, until, False)


def note_human_check(host: str, why: str) -> Closed:
    """사람 확인을 만남 — 풀지 않고 길게 닫습니다. 연속 거부는 올리지 않습니다(포기로 가는 셈이 아님)."""
    low, high = policy.HUMAN_CHECK_MINUTES
    until = _utcnow() + timedelta(minutes=_rng.uniform(low, high))
    store.save_fetch_host(host, blocked_until=until, blocked_reason=why)
    return Closed(host, why, until, False)


def take_budget(host: str, limit: int) -> bool:
    """오늘(KST) 그 호스트의 요청 예산에서 한 건을 씁니다. 다 썼으면 False."""
    return store.take_fetch_budget(host, _utcnow().astimezone(kst.KST).date(), limit)


def last_good_tier(host: str) -> str | None:
    row = store.fetch_host(host)
    return row["last_good_tier"] if row else None


def profile_candidates() -> list[str]:
    """지금 설치된 curl_cffi가 아는 데스크톱 Chrome 프로필 가운데 최신 ``PROFILE_CANDIDATES``개(없으면 별칭 하나)."""
    found = []
    for name in get_args(BrowserTypeLiteral):
        match = _DESKTOP_CHROME.match(name)
        if match:
            found.append((int(match.group(1)), name))
    newest = [name for _, name in sorted(found, reverse=True)[:PROFILE_CANDIDATES]]
    return newest or [FALLBACK_PROFILE]


def profile_for(host: str) -> str:
    """
    그 호스트에 고정한 브라우저 프로필. 처음이면 후보 가운데 하나를 뽑아 적어 두고, 그 뒤에는 늘 같은 것을 씁니다 — 요청마다
    정체를 바꾸지 않습니다(ADR 0026 결정 3). curl_cffi 판이 바뀌었으면(그 이름의 지문이 달라졌을 수 있음) 다시 뽑습니다.
    """
    row = store.fetch_host(host)
    lib = curl_cffi.__version__
    if row and row["profile"] and row["profile_lib"] == lib:
        return row["profile"]
    chosen = _rng.choice(profile_candidates())
    store.save_fetch_host(host, profile=chosen, profile_lib=lib)
    return chosen


# ------------------------------------------------------------------ 일정
def due_at(task: str) -> datetime | None:
    """그 태스크의 다음 실행 시각(정한 적이 없으면 None)."""
    return store.fetch_due_at(task)


def set_due_at(task: str, when: datetime) -> None:
    store.set_fetch_due_at(task, when)


def minutes_from_now(low: float, high: float) -> datetime:
    """지금부터 [``low``, ``high``]분 사이의 무작위 시각."""
    return _utcnow() + timedelta(minutes=_rng.uniform(low, high))
