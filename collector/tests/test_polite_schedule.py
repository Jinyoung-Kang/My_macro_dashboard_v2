"""
tests/test_polite_schedule.py
polite 속도군의 비주기 일정(app/tasks/polite·runner.run_polite_due·main의 틱 — ADR 0026 결정 7, 명세 docs/specs/2026-11-05-polite-fetch.md §4).

고정하는 규칙
  1. 기동 직후에는 받지 않습니다 — 일정이 없는 태스크는 첫 실행 시각(5~45분 뒤)만 정하고 외부를 부르지 않습니다. 스케줄러의 틱도
     next_run_time 없이 등록돼 한 주기 뒤에 처음 돕니다.
  2. 때가 아니면 태스크 본문을 부르지 않습니다(수동 단일 실행·전체 수집도 같은 확인을 지남).
  3. 실행이 끝나면 성공이든 실패든 다음 시각을 그 태스크 구간 안에서 무작위로 정합니다 — 같은 간격이 되풀이되지 않습니다.
  4. 출처가 닫혀 있으면 닫힘이 풀린 뒤로, 포기한 출처면 한 주 뒤로 미룹니다.
  5. 틱은 polite 태스크 가운데 때가 된 것만 이름으로 실행합니다. polite는 주기 설정·/collect 그룹·/status 주기 표에 없습니다.

외부 네트워크에 나가지 않습니다. 표는 시험마다 새 스키마이고 시계는 손으로 돌립니다.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app import main, settings, tasks
from app import store as app_store
from app.fetch import ladder, state
from app.tasks import polite, runner

NAME = "polite_probe"
CADENCE = polite.Cadence(low_minutes=180, high_minutes=360)


@pytest.fixture()
def clock(monkeypatch):
    now = {"t": datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(state, "_utcnow", lambda: now["t"])
    return now


def _due_in(clock, name: str = NAME) -> timedelta:
    return state.due_at(name) - clock["t"]


def _make_due(clock, name: str = NAME) -> None:
    state.set_due_at(name, clock["t"] - timedelta(seconds=1))


# ==============================================================================
# 1·2. 기동 직후와 때가 아닐 때
# ==============================================================================
def test_일정이_없으면_첫_실행_시각만_정하고_본문을_부르지_않는다(store, clock):
    called = []

    with pytest.raises(tasks.EmptyResult, match="첫 실행을 .* 기동 직후에는 받지 않음"):
        polite.scheduled(NAME, CADENCE, lambda: called.append(1) or "받음")

    assert called == []
    assert timedelta(minutes=5) <= _due_in(clock) <= timedelta(minutes=45)


def test_때가_아니면_본문을_부르지_않고_일정도_그대로(store, clock):
    state.set_due_at(NAME, clock["t"] + timedelta(hours=2))
    called = []

    with pytest.raises(tasks.EmptyResult, match="아직 때가 아님"):
        polite.scheduled(NAME, CADENCE, lambda: called.append(1) or "받음")

    assert called == [] and _due_in(clock) == timedelta(hours=2)


# ==============================================================================
# 3. 다음 시각
# ==============================================================================
def test_때가_되면_실행하고_다음_시각을_구간_안에서_정한다(store, clock):
    _make_due(clock)

    detail = polite.scheduled(NAME, CADENCE, lambda: "12건 받음")

    assert detail.startswith("12건 받음 · 다음 ") and detail.endswith(" KST")
    assert timedelta(hours=3) <= _due_in(clock) <= timedelta(hours=6)


def test_다음_간격은_되풀이되지_않는다(store, clock):
    gaps = set()
    for _ in range(12):
        _make_due(clock)
        polite.scheduled(NAME, CADENCE, lambda: "받음")
        gaps.add(_due_in(clock))

    assert len(gaps) == 12
    assert all(timedelta(hours=3) <= gap <= timedelta(hours=6) for gap in gaps)


def test_본문이_실패해도_다음_시각을_정한다(store, clock):
    _make_due(clock)

    def boom():
        raise RuntimeError("파싱 실패")

    with pytest.raises(RuntimeError, match="파싱 실패"):
        polite.scheduled(NAME, CADENCE, boom)

    assert timedelta(hours=3) <= _due_in(clock) <= timedelta(hours=6), "실패한 실행을 다음 틱마다 되풀이하지 않습니다"


@pytest.mark.parametrize("error", [ladder.FetchSkipped("오늘 요청 예산(12건)을 다 써서 보내지 않음"), ladder.FetchFailed("host HTTP 503")])
def test_보내지_못했거나_받지_못하면_저장본을_유지하고_수집_결과_없음(store, clock, error):
    _make_due(clock)

    def work():
        raise error

    with pytest.raises(tasks.EmptyResult, match="기존 저장본 유지 · 다음 "):
        polite.scheduled(NAME, CADENCE, work)

    assert timedelta(hours=3) <= _due_in(clock) <= timedelta(hours=6)


# ==============================================================================
# 4. 닫힌 출처
# ==============================================================================
def test_닫힌_출처면_닫힘이_풀린_뒤로_미룬다(store, clock):
    _make_due(clock)
    until = clock["t"] + timedelta(hours=20)

    def work():
        raise ladder.FetchRejected(state.Closed("calendar.example", "HTTP 403(계층 impersonate)", until, False))

    with pytest.raises(ladder.FetchRejected):
        polite.scheduled(NAME, CADENCE, work)

    assert state.due_at(NAME) > until, "닫힌 동안에는 다시 돌지 않습니다"
    assert state.due_at(NAME) - until <= timedelta(hours=1, minutes=30), "풀린 뒤 오래 미루지도 않습니다"


def test_닫힘이_다음_실행보다_먼저_풀리면_보통_간격대로(store, clock):
    _make_due(clock)
    until = clock["t"] + timedelta(minutes=40)

    def work():
        raise ladder.FetchRejected(state.Closed("calendar.example", "HTTP 403(계층 impersonate)", until, False))

    with pytest.raises(ladder.FetchRejected):
        polite.scheduled(NAME, CADENCE, work)

    assert timedelta(hours=3) <= _due_in(clock) <= timedelta(hours=6)


def test_포기한_출처는_한_주_뒤에_다시_본다(store, clock):
    _make_due(clock)

    def work():
        raise ladder.FetchRejected(state.Closed("calendar.example", "HTTP 403(계층 impersonate)", None, True))

    with pytest.raises(ladder.FetchRejected, match="포기"):
        polite.scheduled(NAME, CADENCE, work)

    assert _due_in(clock) == timedelta(days=polite.GIVE_UP_RECHECK_DAYS)


# ==============================================================================
# 5. 틱
# ==============================================================================
def test_틱은_polite_태스크_가운데_때가_된_것만_이름으로_실행한다(store, clock, monkeypatch):
    probes = (
        tasks.Task("polite_due", polite.SPEED, lambda: "x", ""),
        tasks.Task("polite_later", polite.SPEED, lambda: "x", ""),
        tasks.Task("polite_new", polite.SPEED, lambda: "x", ""),
        tasks.Task("slow_one", "slow", lambda: "x", ""),
    )
    monkeypatch.setattr(runner, "ALL_TASKS", probes)
    state.set_due_at("polite_due", clock["t"] - timedelta(minutes=1))
    state.set_due_at("polite_later", clock["t"] + timedelta(hours=1))
    ran: list[str] = []
    monkeypatch.setattr(runner, "run_group", lambda group=None, task_name=None: ran.append(task_name))

    assert runner.run_polite_due() == ["polite_due", "polite_new"]
    assert ran == ["polite_due", "polite_new"], "일정이 없는 태스크는 한 번 불러 첫 실행 시각을 정하게 합니다"


def test_일정_표를_읽지_못하면_그_틱만_건너뛴다(monkeypatch):
    monkeypatch.setattr(runner, "ALL_TASKS", (tasks.Task("polite_due", polite.SPEED, lambda: "x", ""),))

    def broken(name):
        raise RuntimeError("DB에 닿지 못함")

    monkeypatch.setattr(polite, "should_run", broken)
    monkeypatch.setattr(runner, "run_group", lambda **kwargs: pytest.fail("실행하면 안 됩니다"))

    assert runner.run_polite_due() == []


def test_등록된_polite_태스크는_실행기에_긴_상한이_있고_주기_설정에는_없다():
    names = [task.name for task in tasks.ALL_TASKS if task.speed == polite.SPEED]

    assert "econ_calendar_tradingview" in names
    assert all(tasks.deadline_for(tasks.TASKS_BY_NAME[name]) == 900.0 for name in names)
    with pytest.raises(KeyError):
        settings.interval_seconds(polite.SPEED)


def test_스케줄러의_polite_틱은_기동_직후에_돌지_않는다(monkeypatch):
    jobs: list[dict] = []

    class FakeScheduler:
        def __init__(self, **kwargs):
            pass

        def add_job(self, func, trigger, **kwargs):
            jobs.append({"func": func, "trigger": trigger, **kwargs})

        def start(self):
            pass

        def shutdown(self, wait=False):
            pass

    for name in ("get_pool", "close_pool", "init_schema"):
        monkeypatch.setattr(app_store, name, lambda *a, **k: None)
    monkeypatch.setattr(app_store, "purge_retired_datasets", lambda: 0)
    monkeypatch.setattr(app_store, "mark_stale_runs_interrupted", lambda: 0)
    monkeypatch.setattr(main.krcalendar, "load_from_store", lambda: 0)
    monkeypatch.setattr(main, "API_TOKEN", "test-token")
    monkeypatch.setattr(settings, "scheduler_enabled", lambda: True)
    monkeypatch.setattr(main, "BackgroundScheduler", FakeScheduler)
    monkeypatch.setattr(main, "_last_quotes_at", lambda: None)
    monkeypatch.setattr(main, "slow_first_run", lambda now, last, minute: now)

    async def enter_and_exit() -> None:
        async with main.lifespan(main.app):
            pass

    asyncio.run(enter_and_exit())

    by_id = {job["id"]: job for job in jobs}
    assert set(by_id) == {"collect-fast", "collect-slow", "collect-weekly", "collect-session", "collect-polite"}
    tick = by_id["collect-polite"]
    assert "next_run_time" not in tick, "다른 군은 기동 직후 한 번 돌지만 polite 틱은 한 주기 뒤에 처음 돕니다"
    assert (tick["trigger"], tick["seconds"], tick["jitter"]) == ("interval", 300, 120)
    assert tick["max_instances"] == 1 and tick["func"] is main._run_polite_job
    # slow의 기동 직후 한 번은 slow_first_run이 정함(여기서는 돌게 스텁 — 규칙은 test_group_schedule)
    assert all("next_run_time" in by_id[f"collect-{group}"] for group in ("fast", "slow", "weekly", "session"))


def test_수집_그룹_API와_주기_표에는_polite가_없다(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(main, "API_TOKEN", "")
    monkeypatch.setattr(main.store, "store_stats", lambda task_names: {})
    client = TestClient(main.app)

    assert client.post("/collect?group=polite").status_code == 422
    assert "polite" not in client.get("/status").json()["intervals"]
