"""
tests/test_status_view.py
수집기 GET /status의 보기 두 가지와 행 수 기억(ADR 0047, 2026-11-22 성능 개선 작업 A2·A3).

- ``view=light``: 마지막 실행·그 상태·누락 데이터셋만 — 행 수 세기(COUNT(*) 둘)·태스크 요약을 하지 않습니다(백엔드 오류·경고 모음이 부름).
- 기본(``full``): 상태 화면용 전체. 행 수는 60초 동안 기억해 다시 씁니다(센 그대로의 정확한 값).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main


def test_가벼운_보기는_세_칸만이고_행_수_세기와_태스크_요약을_하지_않는다(store, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(store, "count_timeseries", lambda: calls.append("timeseries") or 0)
    monkeypatch.setattr(store, "count_observations", lambda: calls.append("observations") or 0)
    monkeypatch.setattr(store, "read_task_summary", lambda task_names=None: calls.append("summary") or [])
    run_id = store.start_run("fast")
    store.finish_run(run_id, status="ok", ok_count=1)

    light = main.status(view="light")

    assert list(light) == ["lastRun", "lastRunStatus", "missingDatasets"]
    assert light["lastRun"]["id"] == run_id
    assert light["lastRunStatus"] == "ok"
    assert isinstance(light["missingDatasets"], list)
    assert calls == []


def test_전체_보기의_가벼운_칸은_가벼운_보기와_같다(store):
    run_id = store.start_run("fast")
    store.finish_run(run_id, status="partial", ok_count=1, fail_count=1, detail="가짜 사유")

    full, light = main.status(), main.status(view="light")

    for key in ("lastRun", "lastRunStatus", "missingDatasets"):
        assert full[key] == light[key], key
    assert {"timeseriesRows", "observationRows", "taskSummary", "keys", "intervals"} <= set(full)


def test_행_수는_60초_동안_기억하고_그_뒤에는_다시_센다(store, monkeypatch):
    counted: list[int] = []
    monkeypatch.setattr(store, "count_timeseries", lambda: counted.append(1) or 10 * len(counted))
    monkeypatch.setattr(store, "count_observations", lambda: 7)
    clock = [1000.0]
    monkeypatch.setattr(store, "monotonic", lambda: clock[0])

    assert store.row_counts() == (10, 7)
    clock[0] += 59.0
    assert store.row_counts() == (10, 7)          # 기억한 값(센 그대로의 정확한 수)
    assert len(counted) == 1
    clock[0] += 2.0
    assert store.row_counts() == (20, 7)          # 60초가 지나면 다시 셈
    assert len(counted) == 2
    store.close_pool()
    assert store.row_counts() == (30, 7)          # 연결을 닫으면 기억도 버림(다른 DB일 수 있음)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main.store, "store_stats", lambda task_names=None: {"timeseriesRows": 1})
    monkeypatch.setattr(main.store, "status_light", lambda: {"lastRun": None, "lastRunStatus": "none", "missingDatasets": []})
    return TestClient(main.app, raise_server_exceptions=False)


def test_보기_인자는_full_light만_받는다(client):
    assert client.get("/status").json()["timeseriesRows"] == 1
    assert client.get("/status?view=full").json()["timeseriesRows"] == 1
    assert client.get("/status?view=light").json() == {"lastRun": None, "lastRunStatus": "none", "missingDatasets": []}
    assert client.get("/status?view=everything").status_code == 422
