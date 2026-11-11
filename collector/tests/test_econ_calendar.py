"""
tests/test_econ_calendar.py
경제 캘린더(TradingView — app/services/tv_calendar·app/tasks/econ_calendar, ADR 0026, 명세 docs/specs/2026-11-05-polite-fetch.md §6-1).

고정하는 규칙
  1. 아는 칸만 옮기고 없는 값은 null입니다(0으로 채우지 않음). 숫자가 아닌 값·참거짓은 null, 중요도는 -1·0·1만.
  2. 제목·나라·시각이 없거나 미국·한국이 아닌 행은 그 행만 버립니다. 쓸 행이 하나도 없거나 모양이 다르면 저장본을 덮지 않습니다.
  3. 요청은 차단 통과 계층으로 한 건 — 화면이 보내는 Origin·Referer와 창(어제 ~ 두 주 뒤)·나라(US, KR)를 싣습니다.
  4. 저장본에 출처·수집 시각·통과한 계층(fetchTier)과 받은 칸 이름(fieldsSeen)을 싣습니다. Claude 결정 패킷이 읽는 저장본은 건드리지 않습니다.
  5. 일정 — 때가 아니면 외부를 부르지 않고, 받은 뒤 다음 실행은 3~6시간 뒤입니다.

시험 자료는 조사 기록의 칸 이름으로 만든 합성본입니다(실제 응답이 아님). 외부 네트워크에 나가지 않습니다.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app import catalog, tasks
from app.fetch import pacing, policy, state
from app.services import tv_calendar
from app.tasks import econ_calendar

NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)      # KST 12:00
HOST = "127.0.0.1"


def _row(**over) -> dict:
    row = {
        "id": "356312", "title": "Inflation Rate YoY", "country": "US", "indicator": "Inflation Rate", "period": "Oct",
        "date": "2026-11-12T13:30:00.000Z", "actual": None, "forecast": 3.0, "previous": 3.1, "unit": "%", "scale": "",
        "currency": "USD", "importance": 1, "source": "Bureau of Labor Statistics",
        "comment": "Annual inflation rate in the US ...", "source_url": "https://www.bls.gov/",
    }
    row.update(over)
    return row


PAYLOAD = {"status": "ok", "result": [
    _row(),
    _row(id="356400", title="Interest Rate Decision", country="KR", indicator="Interest Rate", period="",
         date="2026-11-26T01:00:00.000Z", forecast=2.5, previous=2.5, currency="KRW", importance=1, source="Bank of Korea"),
    _row(id="356100", title="Initial Jobless Claims", date="2026-11-05T13:30:00.000Z", actual=218, forecast=220,
         previous=219, unit="", scale="K", importance=0),
]}


# ==============================================================================
# 1·2. 읽기
# ==============================================================================
def test_아는_칸만_옮기고_시각순으로_둔다():
    parsed = tv_calendar.parse(PAYLOAD)

    assert [event["title"] for event in parsed["events"]] == ["Initial Jobless Claims", "Inflation Rate YoY", "Interest Rate Decision"]
    first = parsed["events"][0]
    assert first == {
        "id": "356100", "country": "US", "title": "Initial Jobless Claims", "at": "2026-11-05T13:30:00+00:00",
        "atKst": "2026-11-05 22:30 KST", "importance": 0, "actual": 218, "forecast": 220, "previous": 219,
        "indicator": "Inflation Rate", "period": "Oct", "unit": None, "scale": "K", "currency": "USD",
        "source": "Bureau of Labor Statistics",
    }
    assert "comment" not in first and "source_url" not in first, "설명문과 링크는 저장하지 않습니다"
    assert parsed["skipped"] == 0
    assert "comment" in parsed["fieldsSeen"] and "importance" in parsed["fieldsSeen"], "받은 칸 이름은 남깁니다(모양 확인용)"


def test_없는_값은_null이고_0으로_채우지_않는다():
    row = _row(actual="", forecast="3.0", previous=True, importance=5, unit="  ", indicator=None)
    del row["period"]
    del row["currency"]

    event = tv_calendar.parse({"result": [row]})["events"][0]

    assert (event["actual"], event["forecast"], event["previous"]) == (None, None, None), "글자·참거짓은 숫자가 아닙니다"
    assert event["importance"] is None, "중요도는 -1·0·1만"
    assert (event["unit"], event["indicator"], event["period"], event["currency"]) == (None, None, None, None)


def test_0과_음수는_값으로_남는다():
    event = tv_calendar.parse({"result": [_row(actual=0, forecast=-0.2, previous=0.0, importance=-1)]})["events"][0]

    assert (event["actual"], event["forecast"], event["previous"], event["importance"]) == (0, -0.2, 0.0, -1)


@pytest.mark.parametrize("broken", [
    {"title": ""}, {"title": None}, {"country": "JP"}, {"country": None}, {"date": "soon"}, {"date": None}, {"date": 1762349400},
])
def test_제목_나라_시각이_없는_행은_그_행만_버린다(broken):
    parsed = tv_calendar.parse({"result": [_row(**broken), "not-a-row", _row()]})

    assert len(parsed["events"]) == 1 and parsed["skipped"] == 2


@pytest.mark.parametrize("payload, why", [
    ([], "result 목록이 없음"),
    ({"status": "error"}, "result 목록이 없음"),
    ({"result": {"rows": []}}, "result 목록이 없음"),
    ({"result": []}, r"쓸 수 있는 행이 없음\(받은 행 0개\)"),
    ({"result": [_row(country="JP"), _row(title="")]}, r"쓸 수 있는 행이 없음\(받은 행 2개\)"),
])
def test_모양이_다르거나_쓸_행이_없으면_모양_오류(payload, why):
    with pytest.raises(tv_calendar.CalendarShapeError, match=why):
        tv_calendar.parse(payload)


def test_창은_어제부터_두_주_뒤까지_UTC_자정_기준():
    start, end = tv_calendar.window(NOW)

    assert (start, end) == (datetime(2026, 11, 4, tzinfo=timezone.utc), datetime(2026, 11, 19, tzinfo=timezone.utc))


# ==============================================================================
# 3·4·5. 태스크 — 로컬 서버를 TradingView 자리에 둠
# ==============================================================================
@pytest.fixture()
def tradingview(server, store, monkeypatch):
    """TradingView 주소·정책을 로컬 서버로 돌리고, 시계를 고정하고, 지연은 자지 않습니다."""
    monkeypatch.setattr(tv_calendar, "URL", f"{server.base}/events")
    monkeypatch.setitem(policy.POLICIES, HOST, policy.HostPolicy(HOST, (policy.TIER_IMPERSONATE,), daily_budget=12))
    monkeypatch.setattr(pacing, "_sleep", lambda seconds: None)
    monkeypatch.setattr(state, "_utcnow", lambda: NOW)
    monkeypatch.setattr(econ_calendar, "_now", lambda: NOW)
    server.routes["/events"] = [(200, {"Content-Type": "application/json"}, json.dumps(PAYLOAD).encode("utf-8"))]
    server.store = store
    return server


def _due(name: str = econ_calendar.TRADINGVIEW_TASK) -> None:
    state.set_due_at(name, NOW - timedelta(seconds=1))


def test_받아서_출처와_통과한_계층을_싣고_저장한다(tradingview):
    _due()

    detail = tasks.task_econ_calendar_tradingview()

    assert detail.startswith("TradingView 경제 캘린더 3건(미국 2·한국 1) · 예상치 있는 행 3 · 중요도 있는 행 3 · 계층 impersonate · 다음 ")
    payload = tradingview.store.read_snapshot(catalog.SNAP_ECON_CALENDAR_TV).payload
    assert payload["contract"] == 1 and payload["fetchTier"] == "impersonate"
    assert (payload["source"], payload["sourceUrl"]) == ("TradingView 경제 캘린더", "https://www.tradingview.com/economic-calendar/")
    assert payload["collectedAt"] == "2026-11-05 12:00 KST" and payload["countries"] == ["US", "KR"]
    assert payload["window"] == {"from": "2026-11-04T00:00:00.000Z", "to": "2026-11-19T00:00:00.000Z"}
    assert [event["country"] for event in payload["events"]] == ["US", "US", "KR"]
    assert payload["skipped"] == 0 and "title" in payload["fieldsSeen"]


def test_요청은_한_건이고_화면의_Origin과_창_나라를_싣는다(tradingview, monkeypatch):
    _due()
    asked: list[str] = []
    real = tv_calendar.ladder.fetch

    def spy(url, **kwargs):
        asked.append(json.dumps({"params": kwargs.get("params"), "expect": kwargs.get("expect")}, sort_keys=True))
        return real(url, **kwargs)

    monkeypatch.setattr(tv_calendar.ladder, "fetch", spy)

    tasks.task_econ_calendar_tradingview()

    assert tradingview.hits == ["/events"], "한 번에 요청 1건"
    seen = tradingview.seen[0]
    assert seen["origin"] == "https://www.tradingview.com" and seen["referer"] == "https://www.tradingview.com/"
    assert "Chrome/" in seen["user-agent"], "프로필이 정한 브라우저 표시 그대로"
    assert json.loads(asked[0]) == {
        "expect": "json",
        "params": {"countries": "US,KR", "from": "2026-11-04T00:00:00.000Z", "to": "2026-11-19T00:00:00.000Z"},
    }


def test_때가_아니면_외부를_부르지_않는다(tradingview):
    with pytest.raises(tasks.EmptyResult, match="첫 실행을"):
        tasks.task_econ_calendar_tradingview()
    with pytest.raises(tasks.EmptyResult, match="아직 때가 아님"):
        tasks.task_econ_calendar_tradingview()

    assert tradingview.hits == []
    assert tradingview.store.read_snapshot(catalog.SNAP_ECON_CALENDAR_TV) is None


def test_받은_뒤_다음_실행은_3에서_6시간_뒤(tradingview):
    _due()

    tasks.task_econ_calendar_tradingview()

    assert timedelta(hours=3) <= state.due_at(econ_calendar.TRADINGVIEW_TASK) - NOW <= timedelta(hours=6)


def test_거부되면_저장본을_그대로_두고_거부됨으로_끝난다(tradingview, monkeypatch):
    rows: list[dict] = []
    monkeypatch.setattr(tasks.store, "start_run", lambda group_name=None: 1)
    monkeypatch.setattr(tasks.store, "record_task_run", lambda *args, **kwargs: rows.append(kwargs))
    tradingview.store.put_snapshot(catalog.SNAP_ECON_CALENDAR_TV, {"events": [{"title": "이전 값"}]})
    tradingview.routes["/events"] = [(403, {"Content-Type": "text/html"}, b"<html><center><h1>403 Forbidden</h1></center></html>")]
    _due()

    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["econ_calendar_tradingview"])

    assert ok is False and rows[-1]["status"] == "error" and rows[-1]["speed"] == "polite"
    assert detail.startswith("거부됨: 출처가 요청을 거부 · 거부됨 — 127.0.0.1 HTTP 403(계층 impersonate) · ")
    assert tradingview.store.read_snapshot(catalog.SNAP_ECON_CALENDAR_TV).payload == {"events": [{"title": "이전 값"}]}
    assert state.due_at(econ_calendar.TRADINGVIEW_TASK) > NOW + timedelta(minutes=30), "닫힌 동안에는 다시 돌지 않습니다"


@pytest.mark.parametrize("body", [b"not json", json.dumps({"status": "ok", "result": []}).encode("utf-8")])
def test_모양이_다르면_저장본을_덮지_않는다(tradingview, body):
    tradingview.store.put_snapshot(catalog.SNAP_ECON_CALENDAR_TV, {"events": [{"title": "이전 값"}]})
    tradingview.routes["/events"] = [(200, {"Content-Type": "application/json"}, body)]
    _due()

    with pytest.raises(tasks.EmptyResult, match="응답 모양이 다름.*기존 저장본 유지"):
        tasks.task_econ_calendar_tradingview()

    assert tradingview.store.read_snapshot(catalog.SNAP_ECON_CALENDAR_TV).payload == {"events": [{"title": "이전 값"}]}
    assert state.closed(HOST) is None, "모양이 다른 것은 출처의 거부가 아닙니다"


def test_패킷이_읽는_저장본_이름과_겹치지_않는다():
    packet_inputs = {catalog.SNAP_US_CALENDAR, catalog.SNAP_KR_CALENDAR, catalog.SNAP_US_CONSENSUS}

    assert catalog.SNAP_ECON_CALENDAR_TV == "calendar.econ.tradingview"
    assert catalog.SNAP_ECON_CALENDAR_TV not in packet_inputs


def test_운영_정책은_계층_1만_쓰고_하루_12건():
    rules = policy.policy_for(tv_calendar.HOST)

    assert rules.tiers == (policy.TIER_IMPERSONATE,) and rules.daily_budget == 30
    assert tv_calendar.URL.startswith(f"https://{tv_calendar.HOST}/")
