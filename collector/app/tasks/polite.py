"""
app/tasks/polite.py
polite 속도군(차단 통과 수집 계층 — ADR 0026, 명세 docs/specs/2026-11-05-polite-fetch.md §4)의 태스크가 함께 쓰는 비주기 일정.

  - 기동 직후 실행하지 않습니다. 처음에는 첫 실행 시각을 잠깐 뒤(무작위)로 정해 두기만 합니다.
  - 실행이 끝나면(성공·실패 모두) 다음 시각을 그 태스크 구간 안에서 무작위로 정해 표 fetch_schedule에 적습니다 — 재기동해도 이어지고,
    정각이나 같은 간격으로 되풀이되지 않습니다.
  - 때가 아니면 태스크가 외부를 부르지 않고 EmptyResult로 끝납니다(session 군의 '확인 시각 앞뒤가 아니면 외부 호출 없음'과 같은 방식).
    스케줄러의 틱뿐 아니라 수동 단일 실행·전체 수집도 태스크 머리의 이 확인을 지납니다.
  - 출처가 닫혀 있으면 닫힘이 풀린 뒤로, 포기한 출처면 한 주 뒤로 미룹니다(그동안의 실행은 네트워크에 나가지 않고 '거부됨' 한 줄만 남김).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable

from .. import kst
from ..fetch import ladder, state
from .base import EmptyResult

SPEED = "polite"

# 포기한 출처는 이만큼 뒤에 한 번씩만 태스크가 돕니다(네트워크에는 나가지 않고 실행 기록에 '포기'가 다시 보이게).
GIVE_UP_RECHECK_DAYS = 7


@dataclass(frozen=True)
class Cadence:
    """다음 실행까지의 간격 구간(분)과, 처음 한 번의 구간(분 — 기동 직후에는 받지 않되 첫 확인을 오래 미루지 않게 짧게)."""

    low_minutes: float
    high_minutes: float
    first_low_minutes: float = 5.0
    first_high_minutes: float = 45.0


def should_run(name: str) -> bool:
    """틱이 그 태스크를 돌릴 때인가 — 일정이 아직 없거나(처음) 다음 실행 시각이 지났으면 True."""
    due = state.due_at(name)
    return due is None or due <= state._utcnow()


def _gate(name: str, cadence: Cadence) -> None:
    """:raises EmptyResult: 때가 아님(외부를 부르지 않음). 일정이 없으면 첫 실행 시각을 정해 두고 끝납니다."""
    due = state.due_at(name)
    if due is None:
        first = state.minutes_from_now(cadence.first_low_minutes, cadence.first_high_minutes)
        state.set_due_at(name, first)
        raise EmptyResult(f"첫 실행을 {kst.stamp(first)}로 정함 — 기동 직후에는 받지 않음(외부 호출 0회)")
    if due > state._utcnow():
        raise EmptyResult(f"다음 실행 예정 {kst.stamp(due)} — 아직 때가 아님(외부 호출 0회)")


def _reschedule(name: str, cadence: Cadence, closed: state.Closed | None = None) -> datetime:
    """다음 실행 시각을 정해 적습니다 — 닫힌 출처면 닫힘이 풀린 뒤로, 포기한 출처면 한 주 뒤로."""
    when = state.minutes_from_now(cadence.low_minutes, cadence.high_minutes)
    if closed is not None:
        if closed.given_up:
            when = state._utcnow() + timedelta(days=GIVE_UP_RECHECK_DAYS)
        elif closed.until is not None and closed.until > state._utcnow():
            when = max(when, closed.until + (when - state._utcnow()) / 4)
    state.set_due_at(name, when)
    return when


def scheduled(name: str, cadence: Cadence, work: Callable[[], str]) -> str:
    """
    태스크 본문 ``work``를 일정 안에서 돌립니다 → detail(끝에 다음 실행 시각).

    :raises EmptyResult: 때가 아님, 또는 ``work``가 보내지 못함(하루 예산·시간 예산 — ladder.FetchSkipped)·받지 못함(ladder.FetchFailed)
    :raises ladder.FetchRejected: 출처가 거부했거나 닫혀 있음(실행 기록에 '거부됨')
    """
    _gate(name, cadence)
    try:
        detail = work()
    except ladder.FetchRejected as exc:
        _reschedule(name, cadence, closed=exc.closed)
        raise
    except (ladder.FetchSkipped, ladder.FetchFailed) as exc:
        when = _reschedule(name, cadence)
        raise EmptyResult(f"{exc} — 기존 저장본 유지 · 다음 {kst.stamp(when)}") from exc
    except BaseException:
        _reschedule(name, cadence)
        raise
    when = _reschedule(name, cadence)
    return f"{detail} · 다음 {kst.stamp(when)}"
