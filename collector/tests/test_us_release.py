"""
tests/test_us_release.py
미국 지표 실제치 발표 직후(태스크 us_consensus_release — ADR 0040 단계 2, B).

고정하는 규칙
  1. 받아들임 기준(지시문 §4 B): 동부 08:30 CPI가 있는 날 08:32~08:34에 오늘 날짜 요청이 나가고, 08:45(개장 45분 전 결정) 전에 저장본의
     그 줄에 실제치가 있다. 다른 날짜·머리 칸은 그대로다.
  2. 발표 시각은 패킷이 읽는 이름(백엔드 CalendarConsensus와 같은 표)의 Nasdaq 시각, 없으면 FRED·FOMC 일정. 패킷이 읽지 않는 줄의 시각에는
     묻지 않는다 — 발표가 없는 날은 요청 0회. 같은 시각은 한 번에.
  3. 실제치가 비면 15~25분 뒤 한 번 더(그 시각마다 두 번까지), Nasdaq 추가 요청은 하루 8회까지.
  4. TradingView 경제 캘린더(polite)는 운영 서버에서만 일정을 당긴다(하루 6회까지, 이미 이르면 그대로).
  5. 하루 1회 태스크는 releaseRefetch를 잇고, 받은 줄의 이름이 저장된 오늘 줄과 크게 다르면 저장하지 않는다.

외부 네트워크를 쓰지 않습니다(가짜 fetch_day). PostgreSQL이 필요합니다(store 픽스처).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app import catalog, tasks
from app.fetch import state as polite_state
from app.services import us_consensus as svc
from app.tasks import flex
from app.tasks import us_consensus as daily
from app.tasks import us_release as task
from app.tasks.base import EmptyResult

NY = ZoneInfo("America/New_York")
CPI_DAY = date(2026, 12, 10)          # 목
OTHER_DAY = date(2026, 12, 11)


def _et(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=NY).astimezone(timezone.utc)


def _row(name: str, time_et: str | None, actual: str | None = None, forecast: str | None = "0.3%") -> dict:
    return {"name": name, "timeEt": time_et, "timeText": time_et, "forecast": 0.3 if forecast else None, "previous": 0.2,
            "actual": float(actual.rstrip("%")) if actual else None, "unit": "%", "forecastText": forecast,
            "previousText": "0.2%", "actualText": actual, "importance": None}


def _consensus(store, rows: list[dict], *, day: date = CPI_DAY, extra: dict | None = None) -> None:
    store.put_snapshot(catalog.SNAP_US_CONSENSUS, {
        "generatedAt": "2026-12-10T05:15:00+00:00", "forDate": day.isoformat(), "source": svc.SOURCE,
        "days": {
            day.isoformat(): {"date": day.isoformat(), "queryDate": (day + timedelta(days=1)).isoformat(), "status": "ok",
                              "fetchedAt": "2026-12-10T05:15:00+00:00", "rows": rows, "count": len(rows), "withForecast": len(rows)},
            OTHER_DAY.isoformat(): {"date": OTHER_DAY.isoformat(), "status": "ok", "fetchedAt": "2026-12-10T05:15:00+00:00",
                                    "rows": [_row("Retail Sales", "08:30")], "count": 1, "withForecast": 1},
        },
        **(extra or {}),
    })


class FakeNasdaq:
    def __init__(self):
        self.rows: list[dict] = []
        self.calls: list[date] = []
        self.error: Exception | None = None

    def fetch_day(self, day: date) -> list[dict]:
        self.calls.append(day)
        if self.error is not None:
            raise self.error
        return [dict(row) for row in self.rows]


@pytest.fixture()
def nasdaq(monkeypatch):
    fake = FakeNasdaq()
    monkeypatch.setattr(svc, "fetch_day", fake.fetch_day)
    return fake


@pytest.fixture()
def clock(monkeypatch):
    now = {"t": _et(CPI_DAY, 7, 5)}
    monkeypatch.setattr(task, "_now", lambda: now["t"])
    monkeypatch.setattr(flex, "_utcnow", lambda: now["t"])
    monkeypatch.setattr(polite_state, "_utcnow", lambda: now["t"])
    return now


def _status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_US_CONSENSUS).payload


def _due() -> datetime:
    return flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM]


def _run_until_request(clock, nasdaq) -> str:
    """일정이 가리키는 시각으로 시계를 옮겨 한 번 돌립니다."""
    clock["t"] = _due()
    return task.task_us_consensus_release()


# ==============================================================================
# 1. 받아들임 기준
# ==============================================================================
def test_08시30분_CPI는_08시32_34분에_오늘만_다시_받아_08시45분_전에_실제치가_있다(store, nasdaq, clock):
    # 지시문의 받아들임 기준 그대로 — CPI가 그날 한 줄로 온 경우(두 줄이면 백엔드가 붙이지 않아 묻지 않음: test_오늘_줄이_있으면_…).
    _consensus(store, [_row("CPI", "08:30"), _row("Initial Jobless Claims", "08:30"), _row("Crude Oil Inventories", "10:30")])
    with pytest.raises(EmptyResult, match="일정 처음 정함"):
        task.task_us_consensus_release()
    first = _due()
    assert _et(CPI_DAY, 8, 32) <= first <= _et(CPI_DAY, 8, 34)
    assert nasdaq.calls == []

    nasdaq.rows = [_row("CPI", "08:30", actual="0.4%"), _row("Initial Jobless Claims", "08:30", actual="1.5%"),
                   _row("Crude Oil Inventories", "10:30")]
    detail = _run_until_request(clock, nasdaq)

    assert nasdaq.calls == [CPI_DAY], "오늘(동부) 날짜 하나만"
    assert clock["t"] <= _et(CPI_DAY, 8, 34)
    payload = _status(store)
    today = payload["days"][CPI_DAY.isoformat()]
    cpi = next(row for row in today["rows"] if row["name"] == "CPI")
    assert cpi["actualText"] == "0.4%" and cpi["actual"] == 0.4
    fetched_at = datetime.fromisoformat(today["fetchedAt"])
    assert fetched_at < _et(CPI_DAY, 8, 45), "개장 45분 전 결정보다 앞서 받은 시각"
    assert today["refetchedAfterRelease"] is True and today["status"] == "ok"
    assert payload["days"][OTHER_DAY.isoformat()]["fetchedAt"] == "2026-12-10T05:15:00+00:00", "다른 날짜는 그대로"
    assert payload["forDate"] == CPI_DAY.isoformat() and payload["source"] == svc.SOURCE, "머리 칸 그대로"
    assert payload["releaseRefetch"]["nasdaqRequests"] == 1
    assert payload["releaseRefetch"]["slots"]["08:30"] == {"names": ["CPI"], "requests": 1, "filled": True}
    assert "실제치 있음" in detail
    # 오늘 남은 패킷 발표가 없어 다음은 다음 평일 계획 시각(외부 호출 없음).
    assert _et(OTHER_DAY, 7, 0) <= _due() <= _et(OTHER_DAY, 7, 20)


def test_실제치가_비면_15_25분_뒤_한_번_더_그_뒤는_묻지_않는다(store, nasdaq, clock):
    _consensus(store, [_row("CPI", "08:30")])
    with pytest.raises(EmptyResult):
        task.task_us_consensus_release()
    nasdaq.rows = [_row("CPI", "08:30")]                     # 아직 비어 있음
    detail = _run_until_request(clock, nasdaq)
    asked = clock["t"]
    assert "다시 묻기(08:30)" in detail
    assert timedelta(minutes=15) <= _due() - asked <= timedelta(minutes=25)

    with pytest.raises(EmptyResult, match="새 실제치 없음 — 오늘 줄과 받은 시각을 그대로 둠"):
        _run_until_request(clock, nasdaq)                    # 두 번째도 비어 있음 — 오늘 줄은 그대로, 그 시각은 끝
    assert len(nasdaq.calls) == 2
    assert _status(store)["releaseRefetch"]["slots"]["08:30"]["requests"] == 2
    assert _due() >= _et(OTHER_DAY, 7, 0)


# ==============================================================================
# 2. 발표 시각
# ==============================================================================
def test_오늘_줄이_있으면_그날_한_줄뿐인_패킷_이름의_시각만(store):
    consensus = {"days": {CPI_DAY.isoformat(): {"rows": [
        _row("CPI", "08:30"), _row("CPI", "08:30"),                     # 전월비·전년비 두 줄 — 백엔드가 붙이지 않아 묻지 않음
        _row("  nonfarm   PAYROLLS ", "08:30"),                         # 대소문자·공백은 백엔드처럼 빼고 맞춤
        _row("Retail Sales", "08:30"),                                  # 패킷이 읽지 않는 이름
        _row("Fed Interest Rate Decision", "14:00"),
    ]}}}
    assert task.release_slots(CPI_DAY, consensus) == {"08:30": ["Nonfarm Payrolls"], "14:00": ["Fed Interest Rate Decision"]}


def test_오늘_줄을_아직_못_받았으면_FRED_FOMC_일정으로(store):
    store.put_snapshot(catalog.SNAP_US_CALENDAR, {"macro": {"events": [
        {"name": "CPI", "date": CPI_DAY.isoformat(), "kind": "RELEASE", "releaseId": 10},
        {"name": "GDP", "date": CPI_DAY.isoformat(), "kind": "RELEASE", "releaseId": 53},
        {"name": "FOMC", "date": CPI_DAY.isoformat(), "kind": "FOMC"},
        {"name": "Employment", "date": OTHER_DAY.isoformat(), "kind": "RELEASE", "releaseId": 50},
    ]}})
    assert task.release_slots(CPI_DAY, {"days": {}}) == {"08:30": ["CPI", "GDP"], "14:00": ["Fed Interest Rate Decision"]}


def test_패킷_발표가_없는_날은_요청하지_않는다(store, nasdaq, clock):
    _consensus(store, [_row("Retail Sales", "08:30"), _row("Crude Oil Inventories", "10:30")])
    with pytest.raises(EmptyResult, match="일정 처음 정함"):
        task.task_us_consensus_release()
    clock["t"] = _due()
    with pytest.raises(EmptyResult, match="패킷 발표 시각: 없음"):
        task.task_us_consensus_release()
    assert nasdaq.calls == []


def test_패킷_이름은_백엔드_CalendarConsensus와_같다():
    source = Path(__file__).parents[2] / "backend/src/main/java/com/macrodash/analytics/CalendarConsensus.java"
    if not source.exists():
        pytest.skip("백엔드 파일을 찾을 수 없습니다")
    text = source.read_text(encoding="utf-8")
    names = set(re.findall(r'names\.put\(\d+, "([^"]+)"\)', text))
    names.add(re.search(r'FOMC_NAME = "([^"]+)"', text).group(1))
    assert names == set(task.PACKET_NAMES)


# ==============================================================================
# 3·4. 상한과 TradingView
# ==============================================================================
def test_Nasdaq_추가_요청은_하루_8회까지(store, nasdaq, clock):
    _consensus(store, [_row("CPI", "08:30")], extra={"releaseRefetch": {"etDate": CPI_DAY.isoformat(), "nasdaqRequests": 8,
                                                                         "tvPulls": 0, "slots": {}}})
    flex.set_due(task.TASK_NAME, task.SCHEDULE_ITEM, _et(CPI_DAY, 8, 33))
    clock["t"] = _et(CPI_DAY, 8, 33)
    with pytest.raises(EmptyResult, match="상한\\(8회\\)"):
        task.task_us_consensus_release()
    assert nasdaq.calls == []


def test_운영_서버면_TradingView_일정을_발표_뒤로_당기고_하루_6회까지(store, nasdaq, clock, monkeypatch):
    _consensus(store, [_row("CPI", "08:30")])
    polite_state.set_due_at(task.TV_TASK, _et(CPI_DAY, 12, 0))
    with pytest.raises(EmptyResult):
        task.task_us_consensus_release()
    nasdaq.rows = [_row("CPI", "08:30", actual="0.4%")]
    detail = _run_until_request(clock, nasdaq)
    pulled = polite_state.due_at(task.TV_TASK)
    assert clock["t"] + timedelta(minutes=1) <= pulled <= clock["t"] + timedelta(minutes=3)
    assert "TradingView 일정 당김(1/6)" in detail

    # 로컬(차단 통과 수집 꺼짐)에서는 당기지 않습니다.
    monkeypatch.delenv("POLITE_FETCH_ENABLED")
    state = {"etDate": CPI_DAY.isoformat(), "nasdaqRequests": 0, "tvPulls": 0, "slots": {}}
    polite_state.set_due_at(task.TV_TASK, _et(CPI_DAY, 12, 0))
    assert task._pull_tradingview(clock["t"], state) is False and state["tvPulls"] == 0
    monkeypatch.setenv("POLITE_FETCH_ENABLED", "true")
    state["tvPulls"] = 6
    assert task._pull_tradingview(clock["t"], state) is False, "하루 6회까지"


# ==============================================================================
# 5. 저장 규칙
# ==============================================================================
def test_받은_줄의_이름이_크게_다르면_저장하지_않는다(store, nasdaq, clock):
    _consensus(store, [_row("CPI", "08:30"), _row("Core CPI", "08:30"), _row("Initial Jobless Claims", "08:30")])
    with pytest.raises(EmptyResult):
        task.task_us_consensus_release()
    nasdaq.rows = [_row("Retail Sales", "08:30", actual="1.0%"), _row("Empire State", "08:30", actual="5")]
    with pytest.raises(EmptyResult, match="날짜 어긋남 의심"):
        _run_until_request(clock, nasdaq)
    today = _status(store)["days"][CPI_DAY.isoformat()]
    assert today["fetchedAt"] == "2026-12-10T05:15:00+00:00" and "refetchedAfterRelease" not in today


def test_받지_못하면_저장본_그대로_저장_시각도_그대로(store, nasdaq, clock):
    _consensus(store, [_row("CPI", "08:30")])
    with pytest.raises(EmptyResult):
        task.task_us_consensus_release()
    before = store.read_snapshot(catalog.SNAP_US_CONSENSUS)
    nasdaq.error = svc.ConsensusFetchError("HTTP 503")
    with pytest.raises(EmptyResult, match="HTTP 503 · 기존 저장본 유지"):
        _run_until_request(clock, nasdaq)
    after = store.read_snapshot(catalog.SNAP_US_CONSENSUS)
    assert after.collected_at == before.collected_at
    assert after.payload["days"] == before.payload["days"]
    assert after.payload["releaseRefetch"]["nasdaqRequests"] == 1


def test_하루_1회_태스크는_releaseRefetch를_잇는다(store, monkeypatch):
    state = {"etDate": CPI_DAY.isoformat(), "nasdaqRequests": 2, "tvPulls": 1, "slots": {"08:30": {"requests": 1}}}
    _consensus(store, [_row("CPI", "08:30")], extra={"releaseRefetch": state})
    monkeypatch.setattr(daily, "_now", lambda: _et(CPI_DAY, 9, 15))
    monkeypatch.setattr(daily, "_sleep", lambda seconds: None)
    monkeypatch.setattr(svc, "fetch_day", lambda day: [_row("Initial Jobless Claims", "08:30")] if day.weekday() == 3 else [])

    daily.task_us_calendar_consensus()

    assert _status(store)["releaseRefetch"] == state


def test_flex에_등록되고_due가_있다():
    registered = tasks.TASKS_BY_NAME["us_consensus_release"]
    assert registered.speed == flex.SPEED and registered.run is task.task_us_consensus_release and registered.due is task.due
    assert task.NASDAQ_DAILY_CAP == 8 and task.TV_DAILY_CAP == 6


# ==============================================================================
# 검토에서 고친 것 — 빈 응답·저장본 없음·새 실제치 없는 다시 묻기
# ==============================================================================
def test_저장된_줄이_있는데_빈_응답이면_저장하지_않고_다시_묻는다(store, nasdaq, clock):
    _consensus(store, [_row("Nonfarm Payrolls", "08:30"), _row("Unemployment Rate", "08:30")])
    with pytest.raises(EmptyResult):
        task.task_us_consensus_release()
    nasdaq.rows = []
    with pytest.raises(EmptyResult, match="빈 응답 포함"):
        _run_until_request(clock, nasdaq)
    today = _status(store)["days"][CPI_DAY.isoformat()]
    assert len(today["rows"]) == 2 and today["fetchedAt"] == "2026-12-10T05:15:00+00:00", "예상치가 든 오늘 줄을 지우지 않음"
    assert timedelta(minutes=15) <= _due() - clock["t"] <= timedelta(minutes=25), "다시 묻기는 남음"


def test_컨센서스_저장본이_없으면_묻지_않는다(store, nasdaq, clock):
    store.put_snapshot(catalog.SNAP_US_CALENDAR, {"macro": {"events": [
        {"name": "Employment", "date": CPI_DAY.isoformat(), "kind": "RELEASE", "releaseId": 50}]}})
    flex.set_due(task.TASK_NAME, task.SCHEDULE_ITEM, _et(CPI_DAY, 8, 33))
    clock["t"] = _et(CPI_DAY, 8, 33)
    with pytest.raises(EmptyResult, match=r"컨센서스 저장본이 아직 없음\(.*외부 호출 0회"):
        task.task_us_consensus_release()
    assert nasdaq.calls == []
    assert _due() >= _et(OTHER_DAY, 7, 0)


def test_다시_묻기가_새_실제치를_더하지_못하면_받은_시각을_늦추지_않는다(store, nasdaq, clock):
    _consensus(store, [_row("Nonfarm Payrolls", "08:30"), _row("GDP", "08:30")])
    with pytest.raises(EmptyResult):
        task.task_us_consensus_release()
    nasdaq.rows = [_row("Nonfarm Payrolls", "08:30", actual="1.5%"), _row("GDP", "08:30")]   # 고용만 먼저
    _run_until_request(clock, nasdaq)
    first_fetched = _status(store)["days"][CPI_DAY.isoformat()]["fetchedAt"]
    with pytest.raises(EmptyResult, match="새 실제치 없음"):
        _run_until_request(clock, nasdaq)                    # GDP가 여전히 비어 새로 더한 것 없음
    today = _status(store)["days"][CPI_DAY.isoformat()]
    assert today["fetchedAt"] == first_fetched, "앞서 받은 고용 실제치의 받은 시각 그대로"
    assert next(row for row in today["rows"] if row["name"] == "Nonfarm Payrolls")["actualText"] == "1.5%"

