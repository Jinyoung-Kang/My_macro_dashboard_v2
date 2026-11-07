"""
tests/test_group_schedule.py
수집 속도군의 스케줄러 등록(app/main.lifespan) — slow는 매시 :15 고정, session은 매 5분 :20초 고정(2026-11 — 실험 조건, ADR 0018).

고정하는 규칙
  1. 주기가 기본(slow 3600초·session 300초)이면 cron으로 등록합니다 — slow는 minute 15·second 0, session은 minute */5·second 20(UTC 기준 분 —
     KST·ET도 시차가 정시라 같은 분). misfire_grace_time을 늘 적습니다(APScheduler 3.11의 기본 1초면 조금만 늦게 깨어도 그 회차를 건너뜀).
  2. slow의 기동 직후 한 번은 slow_first_run이 정합니다 — 다음 :15까지 15분 넘게 남았고 관측치(paper.quotes)가 15분보다 오래됐거나 없을 때만.
     돌지 않을 때는 next_run_time 인자를 아예 넘기지 않습니다(None은 일시정지로 등록됨). fast·weekly·session은 지금처럼 기동 직후 한 번.
  3. 주기 환경변수를 바꾼 실험 스택(COLLECTOR_SLOW_INTERVAL·COLLECTOR_SESSION_INTERVAL)은 예전처럼 interval입니다. /status 주기 표는 그대로.
  4. 관측치가 신선해 slow 전체를 다시 돌지 않는데 이번 회차(가장 최근 :15부터)의 slow 실행이 중간에 끊겼으면, 그 회차에 이미 끝난 태스크와 관측치
     (paper_quotes)를 건너뛰고 남은 태스크만 곧바로 한 번 돕니다(QA-308 — 1분봉·한국 밤 관측치를 한 시간 놓치지 않게).

외부 네트워크·DB에 나가지 않습니다(스케줄러는 가짜, 저장본 읽기는 스텁).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from apscheduler.triggers.cron import CronTrigger

from app import main, settings
from app import store as app_store

UTC = timezone.utc


def _at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 11, 9, hour, minute, second, tzinfo=UTC)


@pytest.mark.parametrize(("now", "quotes_age_minutes", "runs"), [
    (_at(14, 0), None, False),        # 다음 :15까지 정확히 15분 — 기다림
    (_at(14, 6), None, False),        # :05~:15 재기동 — 곧 :15 회차
    (_at(14, 14, 59), None, False),
    (_at(14, 15), None, False),       # 바로 그 :15 — cron이 돎
    (_at(14, 16), 40, True),          # :15 회차 뒤인데 관측치가 오래됨(그 회차 실패·서버 정지 뒤) — 바로 채움
    (_at(14, 16), 3, False),          # :15 회차가 막 저장함 — 몇 분 간격 저장본 둘을 만들지 않음
    (_at(14, 16), None, True),        # 저장본 없음 — 시각 규칙만
    (_at(14, 30), 15, False),         # 정확히 15분 전 저장 — 오래되지 않음
    (_at(14, 30), 16, True),
    (_at(14, 59, 59), 50, True),      # 다음 :15까지 15분 1초
])
def test_slow_첫_실행은_다음_15분까지_15분_넘게_남고_관측치가_오래됐을_때만(now, quotes_age_minutes, runs):
    last = None if quotes_age_minutes is None else now - timedelta(minutes=quotes_age_minutes)
    got = main.slow_first_run(now, last, settings.SLOW_AT_MINUTE)
    assert got == (now if runs else None)


def test_고정_위상_상수():
    assert settings.SLOW_AT_MINUTE == 15 and settings.SLOW_STARTUP_GAP_MINUTES == 15 and settings.SESSION_AT_SECOND == 20
    assert main.SLOW_MISFIRE_GRACE_SECONDS == 900 and main.SESSION_MISFIRE_GRACE_SECONDS == 120


def _jobs(monkeypatch, *, first_run=None, quotes_at=None, now=None, done=None) -> dict[str, dict]:
    """
    lifespan을 가짜 스케줄러로 한 번 띄우고 등록한 작업(id → add_job 인자)을 돌려줍니다. ``now``를 주면 기동 시각을 그 시각으로 고정하고,
    ``done``은 '이번 회차에 끝나지 않은 slow 실행'을 읽는 저장 계층 함수(store.unfinished_group_tasks)의 스텁입니다(기본 — 없음).
    """
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
    monkeypatch.setattr(main, "_last_quotes_at", lambda: quotes_at)
    monkeypatch.setattr(app_store, "unfinished_group_tasks", done or (lambda group, since: None), raising=False)
    if first_run is not None:
        monkeypatch.setattr(main, "slow_first_run", first_run)
    if now is not None:
        class FixedNow(datetime):
            @classmethod
            def now(cls, tz=None):
                return now

        monkeypatch.setattr(main, "datetime", FixedNow)

    async def enter_and_exit() -> None:
        async with main.lifespan(main.app):
            pass

    asyncio.run(enter_and_exit())
    return {job["id"]: job for job in jobs}


def test_slow는_매시_15분_cron이고_첫_실행이_없으면_next_run_time_인자가_아예_없다(monkeypatch):
    monkeypatch.delenv("COLLECTOR_SLOW_INTERVAL", raising=False)
    seen = []
    jobs = _jobs(monkeypatch, first_run=lambda now, last, minute: seen.append((now, last, minute)) or None,
                 quotes_at=_at(14, 15, 30))

    slow = jobs["collect-slow"]
    assert (slow["trigger"], slow["minute"], slow["second"], slow["timezone"]) == ("cron", 15, 0, "UTC")
    assert slow["misfire_grace_time"] == 900 and slow["max_instances"] == 1 and slow["coalesce"] is True
    assert slow["func"] is main._run_group_job and slow["args"] == ["slow"]
    assert "next_run_time" not in slow, "None을 넘기면 APScheduler 3.11이 일시정지 작업으로 등록함"
    assert seen and seen[0][1] == _at(14, 15, 30) and seen[0][2] == 15, "관측치 수집 시각과 고정 분을 넘김"


def test_slow_첫_실행을_정하면_그_시각을_next_run_time으로(monkeypatch):
    monkeypatch.delenv("COLLECTOR_SLOW_INTERVAL", raising=False)
    jobs = _jobs(monkeypatch, first_run=lambda now, last, minute: now)
    slow = jobs["collect-slow"]
    assert slow["trigger"] == "cron" and slow["next_run_time"] is not None


def test_session은_매_5분_20초_cron이고_기동_직후_한_번(monkeypatch):
    monkeypatch.delenv("COLLECTOR_SESSION_INTERVAL", raising=False)
    jobs = _jobs(monkeypatch)
    session = jobs["collect-session"]
    assert (session["trigger"], session["minute"], session["second"], session["timezone"]) == ("cron", "*/5", 20, "UTC")
    assert session["misfire_grace_time"] == 120 and session["max_instances"] == 1 and session["coalesce"] is True
    assert session["next_run_time"] is not None
    for group in ("fast", "weekly"):
        job = jobs[f"collect-{group}"]
        assert job["trigger"] == "interval" and job["seconds"] == settings.interval_seconds(group) and job["next_run_time"] is not None


def test_cron_인자는_정해진_시각에_돈다(monkeypatch):
    # 등록 인자 그대로 APScheduler CronTrigger를 만들어 다음 시각을 셉니다(설치본 APScheduler 3.11.3).
    monkeypatch.delenv("COLLECTOR_SLOW_INTERVAL", raising=False)
    monkeypatch.delenv("COLLECTOR_SESSION_INTERVAL", raising=False)
    jobs = _jobs(monkeypatch)
    slow, session = jobs["collect-slow"], jobs["collect-session"]
    slow_trigger = CronTrigger(minute=slow["minute"], second=slow["second"], timezone=slow["timezone"])
    session_trigger = CronTrigger(minute=session["minute"], second=session["second"], timezone=session["timezone"])
    assert slow_trigger.get_next_fire_time(None, _at(14, 16)) == _at(15, 15)
    assert slow_trigger.get_next_fire_time(None, _at(14, 14, 59)) == _at(14, 15)
    assert session_trigger.get_next_fire_time(None, _at(14, 16)) == _at(14, 20, 20)
    assert session_trigger.get_next_fire_time(None, _at(14, 20, 21)) == _at(14, 25, 20)
    # 미국 개장 09:30 ET(EST = 14:30 UTC)·한국 개장 09:00 KST(00:00 UTC)는 5분 격자 위
    assert session_trigger.get_next_fire_time(None, _at(14, 30)) == _at(14, 30, 20)


def test_주기를_바꾼_실험_스택은_예전처럼_interval(monkeypatch):
    monkeypatch.setenv("COLLECTOR_SLOW_INTERVAL", "1800")
    monkeypatch.setenv("COLLECTOR_SESSION_INTERVAL", "600")
    jobs = _jobs(monkeypatch)
    for group, seconds in (("slow", 1800), ("session", 600)):
        job = jobs[f"collect-{group}"]
        assert job["trigger"] == "interval" and job["seconds"] == seconds and job["next_run_time"] is not None
        assert "minute" not in job
    assert settings.slow_at_minute() is None and settings.session_at_second() is None


def test_관측치_저장본을_읽지_못하면_시각_규칙만(monkeypatch):
    def boom(name):
        raise RuntimeError("시험 — DB 없음")

    monkeypatch.setattr(app_store, "read_snapshot", boom)
    assert main._last_quotes_at() is None
    monkeypatch.setattr(app_store, "read_snapshot", lambda name: None)
    assert main._last_quotes_at() is None


# 21:15 KST(12:15 UTC) 회차가 7번째 태스크 paper_quotes까지 저장한 뒤 끊긴 경우 — 그 회차에 끝난 태스크
_DONE_BEFORE_CUT = frozenset({"fred_series", "fed_liquidity", "krx_futures", "sector_history", "fx_history", "equity_history",
                              "paper_quotes"})


@pytest.mark.xfail(strict=True, reason="QA-308 재현 — 수정 전에는 관측치가 신선하면 끊긴 :15 회차의 남은 slow 태스크를 다음 :15까지 돌리지 않음")
def test_QA308_관측치_저장_뒤_끊긴_slow_회차는_남은_태스크만_곧바로_다시_돈다(monkeypatch):
    # 한국 거래일 21:16:40 KST 재기동(배포·OOM 뒤 재시작) — 관측치는 30초 전(21:16:10)이라 slow 전체는 다시 돌지 않음(감사 사슬)
    monkeypatch.delenv("COLLECTOR_SLOW_INTERVAL", raising=False)
    seen = []
    jobs = _jobs(monkeypatch, quotes_at=_at(12, 16, 10), now=_at(12, 16, 40),
                 done=lambda group, since: seen.append((group, since)) or _DONE_BEFORE_CUT)

    assert "next_run_time" not in jobs["collect-slow"], "관측치 저장본을 하나 더 만들지 않음"
    resume = jobs["collect-slow-resume"]
    assert resume["trigger"] == "date" and resume["func"] is main._run_group_job and resume["args"] == ["slow"]
    assert resume["run_date"] == _at(12, 16, 40) and resume["misfire_grace_time"] == main.SLOW_MISFIRE_GRACE_SECONDS
    skip = resume["kwargs"]["skip"]
    assert _DONE_BEFORE_CUT <= skip and "paper_quotes" in skip
    assert not {"paper_bars_us", "kr_paper_timed", "kr_paper_quotes", "kr_paper_flows"} & skip, "남은 태스크(1분봉·한국 밤 관측치)는 곧바로"
    assert seen == [("slow", _at(12, 15))], "이번 회차(가장 최근 :15) 뒤에 시작한 slow 실행만 봄"


def test_slow_회차가_끝났으면_남은_태스크_실행을_등록하지_않는다(monkeypatch):
    monkeypatch.delenv("COLLECTOR_SLOW_INTERVAL", raising=False)
    jobs = _jobs(monkeypatch, quotes_at=_at(12, 16, 10), now=_at(12, 16, 40), done=lambda group, since: None)
    assert "collect-slow-resume" not in jobs
    assert "next_run_time" not in jobs["collect-slow"]
