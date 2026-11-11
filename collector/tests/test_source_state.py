"""
tests/test_source_state.py
polite 태스크의 출처 상태(표 fetch_source_state — ADR 0035 결정 6). 백엔드가 이 표를 읽어 끊김을 알립니다(텔레그램 + 화면 안내).

고정하는 규칙
  - 성공은 ok(마지막 성공 시각), 거부·닫힘은 blocked(닫힘 사유 한 줄), 모양이 다르면 format, 404·5xx·전송 실패는 failed.
  - 같은 판정이 이어지면 streak이 오르고, 바뀌면 1부터입니다.
  - 보내지 못함(하루 예산·시간 예산)은 출처의 상태가 아니라 표를 바꾸지 않습니다.
  - 일부 모양만 다르면(polite.Partial) 실행은 성공이고 출처 상태는 format입니다.
  - '오래 못 받음'의 기준은 그 태스크 간격 상한의 세 배입니다.

외부 네트워크에 나가지 않습니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import tasks
from app.fetch import ladder, state
from app.tasks import polite

NAME = "info_probe"
CADENCE = polite.Cadence(low_minutes=60, high_minutes=180)


@pytest.fixture()
def clock(monkeypatch):
    now = {"t": datetime(2026, 11, 11, 3, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(state, "_utcnow", lambda: now["t"])
    return now


def _run(clock, work):
    state.set_due_at(NAME, clock["t"] - timedelta(seconds=1))
    return polite.scheduled(NAME, CADENCE, work)


def _row(store):
    return store.source_state(NAME)


def test_성공하면_ok와_마지막_성공_시각(store, clock):
    _run(clock, lambda: "3건")

    row = _row(store)
    assert row["status"] == "ok" and row["streak"] == 1 and row["last_ok_at"] is not None
    assert row["stale_after_minutes"] == 180 * polite.STALE_FACTOR


def test_거부는_blocked이고_닫힘_사유를_남긴다(store, clock):
    closed = state.Closed("feed.example", "HTTP 403(계층 impersonate)", clock["t"] + timedelta(hours=1), False)

    def work():
        raise ladder.FetchRejected(closed)

    with pytest.raises(ladder.FetchRejected):
        _run(clock, work)

    row = _row(store)
    assert row["status"] == "blocked" and "HTTP 403" in row["reason"] and row["last_ok_at"] is None


def test_형식이_다르면_format이고_이어지면_streak이_오른다(store, clock):
    def work():
        raise polite.ShapeChanged("피드에서 글을 읽지 못함")

    for _ in range(2):
        with pytest.raises(tasks.EmptyResult, match="기존 저장본 유지"):
            _run(clock, work)

    row = _row(store)
    assert row["status"] == "format" and row["streak"] == 2

    _run(clock, lambda: "회복")
    row = _row(store)
    assert row["status"] == "ok" and row["streak"] == 1, "판정이 바뀌면 1부터"


def test_받지_못하면_failed(store, clock):
    def work():
        raise ladder.FetchFailed("feed.example HTTP 503")

    with pytest.raises(tasks.EmptyResult):
        _run(clock, work)

    assert _row(store)["status"] == "failed"


def test_보내지_못한_것은_상태를_바꾸지_않는다(store, clock):
    _run(clock, lambda: "3건")

    def work():
        raise ladder.FetchSkipped("오늘 요청 예산(20건)을 다 써서 보내지 않음")

    with pytest.raises(tasks.EmptyResult):
        _run(clock, work)

    row = _row(store)
    assert row["status"] == "ok" and row["streak"] == 1


def test_QA391_일부를_받지_못하면_실행은_성공이고_상태는_failed이며_마지막_성공_시각은_그대로(store, clock):
    _run(clock, lambda: "네이버 6/6")
    ok_at = _row(store)["last_ok_at"]

    clock["t"] += timedelta(hours=1)
    detail = _run(clock, lambda: polite.Partial("네이버 4/6", "받지 못함: trend.KOSPI, trend.KOSDAQ", kind=polite.PARTIAL_FAILED))

    assert detail.startswith("네이버 4/6 · 일부 받지 못함(받지 못함: trend.KOSPI, trend.KOSDAQ)")
    row = _row(store)
    assert row["status"] == "failed" and row["streak"] == 1 and "trend.KOSPI" in row["reason"]
    assert row["last_ok_at"] == ok_at, "마지막 성공 시각은 전부 받은 실행에서만 갱신합니다"


@pytest.mark.xfail(strict=True, reason="QA-391(독립 검토): 보내지 않은 부분만 남은 실행을 나타낼 Partial 종류가 없어 'ok'로 적힙니다")
def test_QA391_일부를_보내지_않은_실행은_출처_상태와_마지막_성공_시각을_그대로_둔다(store, clock):
    """
    예산·시간이 모자라 일부를 보내지 않은 실행은 출처의 성공도 실패도 아닙니다. 'ok'로 적으면 이어지던 '받지 못함' 셈이 1로 돌아가고 마지막 성공
    시각이 갱신돼 끊김 알림이 한 바퀴 늦어집니다(전부 보내지 못한 실행이 상태를 그대로 두는 것과 같은 기준).
    """
    _run(clock, lambda: "네이버 6/6")
    clock["t"] += timedelta(hours=1)
    _run(clock, lambda: polite.Partial("네이버 4/6", "받지 못함: trend.KOSPI", kind=polite.PARTIAL_FAILED))
    before = _row(store)

    clock["t"] += timedelta(hours=1)
    detail = _run(clock, lambda: polite.Partial("네이버 4/6", "trend.KOSPI, trend.KOSDAQ", kind=polite.PARTIAL_UNSENT))

    assert detail.startswith("네이버 4/6 · 일부 보내지 않음(trend.KOSPI, trend.KOSDAQ)")
    row = _row(store)
    assert (row["status"], row["streak"], row["reason"], row["last_ok_at"]) == (
        before["status"], before["streak"], before["reason"], before["last_ok_at"]), "보내지 않은 실행은 판정을 남기지 않습니다"


def test_일부만_형식이_다르면_실행은_성공이고_상태는_format(store, clock):
    detail = _run(clock, lambda: polite.Partial("네이버 5/6", "trend.KOSPI: 모양이 다름"))

    assert detail.startswith("네이버 5/6 · 일부 형식 다름")
    row = _row(store)
    assert row["status"] == "format" and "trend.KOSPI" in row["reason"]
