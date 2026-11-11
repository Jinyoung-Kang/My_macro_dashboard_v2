"""
tests/test_polite_switch.py
차단 통과 수집(polite 속도군)은 운영 서버에서만 돕니다 (ADR 0035 결정 4 — 사용자 지시 "수집기에 내 개인 IP를 쓰지 말 것").

로컬·QA compose는 POLITE_FETCH_ENABLED를 "false"로 고정하고 운영 서버 덧붙임만 켭니다(CI가 compose 해석으로 확인). 꺼져 있으면
  - 스케줄러의 틱이 polite 태스크를 하나도 부르지 않고,
  - 수동 실행·전체 수집도 태스크 머리에서 외부를 부르지 않고 끝납니다(일정 표에도 쓰지 않음).

외부 네트워크에 나가지 않습니다.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from app import tasks
from app.fetch import state
from app.tasks import polite, runner

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def disabled(monkeypatch):
    monkeypatch.delenv(polite.ENV_ENABLED, raising=False)


def test_꺼져_있으면_본문을_부르지_않고_일정도_정하지_않는다(store, disabled):
    called = []

    with pytest.raises(tasks.EmptyResult, match="운영 서버에서만"):
        polite.scheduled("info_probe", polite.Cadence(60, 180), lambda: called.append(1) or "x")

    assert called == []
    assert state.due_at("info_probe") is None
    assert store.source_state("info_probe") is None


def test_꺼져_있으면_틱이_아무것도_돌리지_않는다(disabled, monkeypatch):
    ran = []
    monkeypatch.setattr(runner, "run_group", lambda group=None, task_name=None: ran.append(task_name))
    monkeypatch.setattr(polite, "should_run", lambda name: (_ for _ in ()).throw(AssertionError("일정 표도 읽지 않습니다")))

    assert runner.run_polite_due() == []
    assert ran == []


@pytest.mark.parametrize("value,expected", [("true", True), ("1", True), ("false", False), ("", False), ("no", False)])
def test_스위치_값(monkeypatch, value, expected):
    monkeypatch.setenv(polite.ENV_ENABLED, value)
    assert polite.enabled() is expected


def test_기반_compose는_보간_없이_끄고_서버_덧붙임만_켠다():
    base = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    overlay = yaml.safe_load((ROOT / "compose.vultr.yml").read_text(encoding="utf-8"))

    assert base["services"]["collector"]["environment"]["POLITE_FETCH_ENABLED"] == "false"
    assert overlay["services"]["collector"]["environment"]["POLITE_FETCH_ENABLED"] == "${POLITE_FETCH_ENABLED:-true}"
    assert "POLITE_FETCH_ENABLED" not in base["services"]["backend"]["environment"]
