"""
app/tasks/base.py
태스크가 함께 쓰는 것 — 결과 없음 예외, 실패 사유 덧붙이기, 태스크 정의, 레이더 조합.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo


logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")

# 수급 레이더에서 미리 받아 둘 조건 조합. 전부 받으면 수집 시간이 과도하게
# 길어지므로 화면 기본값만 받습니다.
RADAR_COMBINATIONS = (
    ("KOSPI", "외국인", "순매수", "TODAY"),
    ("KOSPI", "기관", "순매수", "TODAY"),
    ("KOSPI", "외국인", "순매도", "TODAY"),
)

DAUM_TREND_LOOKBACK = 25

# 이어받기 기한(QA-056). 이보다 오래 실패한 항목은 더 잇지 않고 빠집니다 — 폐지 종목처럼 다시 오지 않는 항목이
# 멈춘 값으로 남아 다른 계산(기관 위험 분석의 날짜 교집합, 업종 순위)을 묶지 않게. 주말·긴 연휴에 소스가
# 하루 이틀 막히는 정도는 잇습니다.
CARRY_OVER_MAX_AGE = timedelta(days=3)


class EmptyResult(Exception):
    """수집은 끝났지만 쓸 수 있는 데이터가 없음 → 실패로 집계합니다."""


def _reason_suffix(reasons: list[str | None]) -> str:
    """
    실패 사유를 메시지 끝에 덧붙입니다.

    "0/12 시리즈"만 남으면 운영자가 무엇을 고쳐야 할지 알 수 없습니다.
    같은 사유가 반복되는 경우가 대부분이므로 중복을 제거하고 두 개까지만
    싣습니다(상태 화면의 detail 길이 제한 1000자를 넘기지 않기 위함).
    """
    unique: list[str] = []
    for reason in reasons:
        if reason and reason not in unique:
            unique.append(reason)
    if not unique:
        return ""
    return " (사유: " + " / ".join(unique[:2]) + ")"


def carry_over_missing(
    fresh: dict,
    previous: dict | None,
    expected,
    reason: str | None,
    has_data: Callable[[dict], bool],
    max_age: timedelta = CARRY_OVER_MAX_AGE,
) -> list[str]:
    """
    이번 수집에서 빠졌거나 빈 항목을 **직전 저장본의 같은 항목**으로 잇습니다(QA-032, fast 태스크의 QA-001과 같은 규칙).

    일부만 실패한 수집이 받은 것만으로 저장본을 덮으면, 빠진 항목의 마지막 정상 값이 다음 실행까지 사라졌습니다.
    이어받은 항목은 값을 그대로 두고 ``isStale``·``staleReason``·``staleSince``(처음 이어받은 시각)만 더합니다.
    직전 저장본에도 없거나, 이어받은 지 ``max_age``가 지났으면 빠집니다(QA-056).

    :param fresh: 이번에 받은 항목(키 → 항목). 이 사전을 고칩니다
    :param expected: 있어야 하는 키(태스크가 받으려던 목록) — 목록에서 뺀 키는 잇지 않습니다
    :return: 이어받은 키
    """
    previous = previous or {}
    now = datetime.now(timezone.utc)
    carried: list[str] = []
    for key in expected:
        if key in fresh and isinstance(fresh[key], dict) and has_data(fresh[key]):
            continue
        before = previous.get(key)
        if not isinstance(before, dict) or not has_data(before):
            continue
        since = _parse_time(before.get("staleSince")) if before.get("isStale") else None
        if since is not None and now - since > max_age:
            continue
        fresh[key] = {**before, "isStale": True, "staleReason": reason or "수집 실패",
                      "staleSince": (since or now).isoformat()}
        carried.append(key)
    return carried


def _parse_time(text) -> datetime | None:
    """staleSince 문자열 → 시각. 없거나 읽을 수 없으면 None(이번에 처음 이어받은 것으로 봄)."""
    if not isinstance(text, str):
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def previous_payload(name: str) -> dict:
    """직전 저장본의 내용(없으면 빈 사전)."""
    from .. import store

    snapshot = store.read_snapshot(name)
    return snapshot.payload if snapshot and isinstance(snapshot.payload, dict) else {}


def carried_suffix(carried: list[str]) -> str:
    return f" · 이전 값 {len(carried)}개({', '.join(carried[:5])}{'…' if len(carried) > 5 else ''})" if carried else ""


@dataclass(frozen=True)
class Task:
    name: str
    speed: str            # fast | slow | weekly | live(정기 수집 없음 — 화면이 볼 때만 백엔드가 요청)
                          # | session(🧪 5분 — 장중 확인 날 확인 시각 앞뒤에만 외부 호출, 그 밖은 EmptyResult)
    run: Callable[[], str]
    description: str

