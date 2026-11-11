"""
app/tasks/polite.py
polite 속도군(차단 통과 수집 계층 — ADR 0026, 명세 docs/specs/2026-11-05-polite-fetch.md §4)의 태스크가 함께 쓰는 비주기 일정.

  - 기동 직후 실행하지 않습니다. 처음에는 첫 실행 시각을 잠깐 뒤(무작위)로 정해 두기만 합니다.
  - 실행이 끝나면(성공·실패 모두) 다음 시각을 그 태스크 구간 안에서 무작위로 정해 표 fetch_schedule에 적습니다 — 재기동해도 이어지고,
    정각이나 같은 간격으로 되풀이되지 않습니다.
  - 때가 아니면 태스크가 외부를 부르지 않고 EmptyResult로 끝납니다(session 군의 '확인 시각 앞뒤가 아니면 외부 호출 없음'과 같은 방식).
    스케줄러의 틱뿐 아니라 수동 단일 실행·전체 수집도 태스크 머리의 이 확인을 지납니다.
  - 출처가 닫혀 있으면 닫힘이 풀린 뒤로, 포기한 출처면 한 주 뒤로 미룹니다(그동안의 실행은 네트워크에 나가지 않고 '거부됨' 한 줄만 남김).
  - **운영 서버에서만 돕니다**(ADR 0035 결정 4): ``POLITE_FETCH_ENABLED``가 켜져 있지 않으면 틱이 이 군을 돌리지 않고, 수동 실행도 외부를 부르지
    않고 끝납니다. 로컬·QA compose는 이 값을 "false"로 고정합니다 — 출구가 사용자 PC의 IP가 되지 않게.
  - 실행마다 판정(성공·거부·형식 바뀜·받지 못함)을 표 fetch_source_state에 남깁니다. 백엔드가 읽어 끊김을 알립니다(텔레그램 + 화면 안내).
    일부만 온전하지 않은 실행(:class:`Partial`)은 받은 부분을 저장하되 판정은 '형식 바뀜'·'받지 못함'으로 남깁니다.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable, Union

from .. import http, kst, store
from ..fetch import ladder, state
from .base import EmptyResult

logger = logging.getLogger(__name__)

SPEED = "polite"
ENV_ENABLED = "POLITE_FETCH_ENABLED"
# '오래 못 받음'으로 보는 간격 — 그 태스크 간격 상한의 이 배수만큼 성공이 없으면 백엔드가 알립니다.
STALE_FACTOR = 3

# 포기한 출처는 이만큼 뒤에 한 번씩만 태스크가 돕니다(네트워크에는 나가지 않고 실행 기록에 '포기'가 다시 보이게).
GIVE_UP_RECHECK_DAYS = 7


@dataclass(frozen=True)
class Cadence:
    """다음 실행까지의 간격 구간(분)과, 처음 한 번의 구간(분 — 기동 직후에는 받지 않되 첫 확인을 오래 미루지 않게 짧게)."""

    low_minutes: float
    high_minutes: float
    first_low_minutes: float = 5.0
    first_high_minutes: float = 45.0


CadenceLike = Union[Cadence, Callable[[], Cadence]]


# Partial의 종류 — 출처 상태(fetch_source_state.status)에 그대로 남는 값입니다.
PARTIAL_FORMAT = "format"       # 일부의 모양이 다름('형식 바뀜')
PARTIAL_FAILED = "failed"       # 일부를 받지 못함(404·5xx·빈 답 — '받지 못함')
# 일부를 보내지 않음(하루 예산·태스크 시간) — 출처의 성공도 실패도 아니라 출처 상태에 남기지 않습니다(전부 보내지 못한 실행과 같은 기준).
# 'ok'로 적으면 이어지던 '받지 못함' 셈이 1로 돌아가고 마지막 성공 시각이 갱신돼 끊김 알림이 한 바퀴 늦어집니다(QA-391).
PARTIAL_UNSENT = "unsent"


@dataclass(frozen=True)
class Partial:
    """
    받아 저장은 했지만 일부가 온전하지 않음 — 실행 기록은 성공(``detail``), 출처 상태는 ``kind``(``issue``)로 남깁니다.

    여러 부분을 한 번에 받는 출처(네이버 6건·KRX 20건)에서 한 부분만 형식이 바뀌거나(``PARTIAL_FORMAT``) 받지 못해도(``PARTIAL_FAILED`` —
    QA-391) 알 수 있게. 받은 부분은 저장하고, 마지막 성공 시각은 전부 받은 실행에서만 갱신됩니다(같은 판정이 이어지면 백엔드가 알림).
    예산·시간이 모자라 일부를 보내지 않았을 뿐이면 ``PARTIAL_UNSENT`` — 출처 상태를 건드리지 않습니다.
    """

    detail: str
    issue: str
    kind: str = PARTIAL_FORMAT

    def __post_init__(self) -> None:
        if self.kind not in (PARTIAL_FORMAT, PARTIAL_FAILED, PARTIAL_UNSENT):
            raise ValueError(f"모르는 Partial 종류: {self.kind}")


class ShapeChanged(EmptyResult):
    """
    출처의 응답 모양이 달라 읽지 못함 — 필수 칸이 없거나 목록·피드에서 항목을 하나도 읽지 못함(ADR 0035 결정 6 '형식 바뀜').

    EmptyResult의 하위라 실행 기록에는 '수집 결과 없음'으로 남고 직전 저장본은 그대로입니다. 같은 판정이 이어지면 백엔드가 알립니다.
    """


def enabled() -> bool:
    """polite 속도군을 돌려도 되는가 — 운영 서버의 compose 덧붙임만 켭니다(로컬·QA는 "false" 고정)."""
    return os.environ.get(ENV_ENABLED, "").strip().lower() in ("1", "true", "yes", "on")


def _resolve(cadence: CadenceLike) -> Cadence:
    return cadence() if callable(cadence) else cadence


def _note(name: str, cadence: Cadence, status: str, reason: str | None) -> None:
    """판정을 표에 남깁니다. 표에 쓰지 못해도 태스크는 그대로 끝납니다(알림이 한 번 늦을 뿐)."""
    try:
        store.note_source_state(name, status, reason, stale_after_minutes=int(cadence.high_minutes * STALE_FACTOR))
    except Exception as exc:  # noqa: BLE001
        logger.warning("출처 상태를 남기지 못함(%s): %s", name, exc)


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


def scheduled(name: str, cadence: CadenceLike, work: Callable[[], "str | Partial"]) -> str:
    """
    태스크 본문 ``work``를 일정 안에서 돌립니다 → detail(끝에 다음 실행 시각).

    :param cadence: 간격 구간, 또는 그때그때 구간을 고르는 함수(네이버처럼 장중과 장 밖의 간격이 다른 출처)
    :raises EmptyResult: 운영 서버가 아님·때가 아님, 또는 ``work``가 보내지 못함(하루 예산·시간 예산 — ladder.FetchSkipped)·받지 못함
        (ladder.FetchFailed)·모양이 다름(:class:`ShapeChanged`)
    :raises ladder.FetchRejected: 출처가 거부했거나 닫혀 있음(실행 기록에 '거부됨')
    """
    if not enabled():
        raise EmptyResult(f"차단 통과 수집은 운영 서버에서만 돕니다({ENV_ENABLED} 꺼짐 — 이 PC의 IP로는 받지 않음, 외부 호출 0회)")
    cadence = _resolve(cadence)
    _gate(name, cadence)
    try:
        detail = work()
    except ladder.FetchRejected as exc:
        _reschedule(name, cadence, closed=exc.closed)
        _note(name, cadence, "blocked", exc.closed.message())
        raise
    except ShapeChanged as exc:
        when = _reschedule(name, cadence)
        _note(name, cadence, "format", str(exc))
        raise ShapeChanged(f"{exc} — 기존 저장본 유지 · 다음 {kst.stamp(when)}") from exc
    except ladder.FetchSkipped as exc:
        when = _reschedule(name, cadence)       # 보내지 않았음 — 출처 상태는 그대로
        raise EmptyResult(f"{exc} — 기존 저장본 유지 · 다음 {kst.stamp(when)}") from exc
    except ladder.FetchFailed as exc:
        when = _reschedule(name, cadence)
        _note(name, cadence, "failed", str(exc))
        raise EmptyResult(f"{exc} — 기존 저장본 유지 · 다음 {kst.stamp(when)}") from exc
    except EmptyResult:
        _reschedule(name, cadence)              # 받았지만 쓸 것이 없음(휴장 등) — 출처에는 닿았으므로 성공으로 봅니다
        _note(name, cadence, "ok", None)
        raise
    except Exception as exc:
        _reschedule(name, cadence)
        _note(name, cadence, "failed", http.brief_error(exc))
        raise
    except BaseException:
        _reschedule(name, cadence)
        raise
    when = _reschedule(name, cadence)
    if isinstance(detail, Partial):
        if detail.kind == PARTIAL_UNSENT:       # 보내지 않았을 뿐 — 출처 상태는 그대로(위 FetchSkipped 가지와 같음)
            return f"{detail.detail} · 일부 보내지 않음({detail.issue[:160]}) · 다음 {kst.stamp(when)}"
        _note(name, cadence, detail.kind, detail.issue)
        label = "일부 형식 다름" if detail.kind == PARTIAL_FORMAT else "일부 받지 못함"
        return f"{detail.detail} · {label}({detail.issue[:160]}) · 다음 {kst.stamp(when)}"
    _note(name, cadence, "ok", None)
    return f"{detail} · 다음 {kst.stamp(when)}"
