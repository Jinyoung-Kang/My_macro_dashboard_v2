"""
tests/test_us_calendar.py
미국 발표·실적 일정(태스크 us_calendar, 2단계 명세 A1~A3·§10) — 모의 매매 Claude 계좌 패킷 1b_calendar의 원자료.

고정하는 규칙
  1. FOMC 상수는 단계 0에서 확인한 연준 일정표(2026·2027, 16회)와 같다. 날짜는 성명이 나오는 둘째 날, SEP 표시 그대로.
     상수 끝이 수집 창(45일) 안에 들어오면 '갱신 필요'.
  2. FRED는 릴리스마다 release/dates 한 건 — include_release_dates_with_no_data=true, realtime_start=오늘, realtime_end=수집 창
     끝(오늘+45일)이 속한 해의 12-31. 일정(events)은 45일 창 안만, lastKnownDate는 받은 날짜 중 마지막(창 밖 포함).
     다른 릴리스·읽을 수 없는 날짜는 버린다. 오류 문구·저장본에 API 키가 실리지 않는다.
  3. 실적일은 quoteSummary calendarEvents의 epoch 중 지금 이후 가장 이른 것. 날짜는 미국 동부 날짜, 장 구분은 UTC 12:30 BMO·
     20:00 AMC·그 밖 None, 추정치는 장 구분 None. 모두 지났으면 '다음 일정 미정' + 마지막 날짜. 없으면 None(0으로 채우지 않음).
  4. 내부 호출(Ticker._quote._fetch)이 없거나 응답 모양이 바뀌면 EmptyResult('yfinance 내부 API 변경') — 실적은 직전 값을
     isStale로 잇고(받은 응답은 버림), 거시 일정(FRED·FOMC)은 새로 저장한다(실적 고장으로 거시 45일 창이 굳지 않게).
  5. 종목 24시간 캐시, 실패한 종목은 6시간 뒤 다시. 순서는 한 번도 묻지 않은 종목(티커 순) → 오래전에 물은 순. 예산(종목 수).
     429면 그 실행을 멈추고, 연속 실패 5회면 나머지를 다음 실행으로 미룬다.
  6. 일부 실패 → 항목별 이전 값 이어받기 + isStale(릴리스·종목). 시도한 것이 전부 실패 → EmptyResult(저장본 그대로).
     실적의 '전부 실패'는 이번에 물은 종목만이 아니라 캐시가 유효한 종목까지 보고 정한다(늘 실패하는 종목 하나가 태스크를 멈추지 않게).
     FRED 키가 없으면 FRED 일정은 비고 '키 미설정' — FOMC 상수와 실적 일정은 그대로 들어간다.

외부 네트워크를 쓰지 않습니다 — 가짜 FRED 세션과 가짜 yfinance Ticker가 tests/fixtures/calendar/의 응답을 돌려줍니다.
태스크 테스트는 PostgreSQL이 필요합니다(store 픽스처, macrodash_test). 순수 함수 테스트는 DB 없이 돕니다.
"""
from __future__ import annotations

import copy
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from yfinance.exceptions import YFException, YFRateLimitError

from app import catalog, indicators, paper_universe, settings, tasks
from app.services import us_calendar as svc
from app.tasks import us_calendar as task_module
from app.tasks.base import EmptyResult

FIXTURES = Path(__file__).parent / "fixtures" / "calendar"
NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)   # 동부 2026-10-25 08:00
TODAY = date(2026, 10, 25)
END = TODAY + timedelta(days=task_module.HORIZON_DAYS)     # 2026-12-09
SENTINEL_KEY = "abcdef0123456789abcdef0123456789"


def _json(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _raw(ticker: str) -> dict:
    return copy.deepcopy(_json("quote_summary_calendar_events.json")[ticker])


def _with_dates(stamps: list, estimate=False, base: str = "AAPL") -> dict:
    raw = _raw(base)
    earnings = raw["quoteSummary"]["result"][0]["calendarEvents"]["earnings"]
    earnings["earningsDate"] = stamps
    if estimate is None:
        earnings.pop("isEarningsDateEstimate")
    else:
        earnings["isEarningsDateEstimate"] = estimate
    return raw


def _epoch(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp())


# ==============================================================================
# 1. FOMC 상수
# ==============================================================================
def test_FOMC_상수는_단계0_연준_일정표와_같다():
    # docs/specs/2026-10-25-paper-trading-phase2-spec.md §10 (연준 일정표 Last Update 2026-10-07, 확인 2026-10-25)
    assert svc.FOMC_MEETINGS == (
        ("2026-01-27", "2026-01-28", False), ("2026-03-17", "2026-03-18", True),
        ("2026-04-28", "2026-04-29", False), ("2026-06-16", "2026-06-17", True),
        ("2026-07-28", "2026-07-29", False), ("2026-09-15", "2026-09-16", True),
        ("2026-10-27", "2026-10-28", False), ("2026-12-08", "2026-12-09", True),
        ("2027-01-26", "2027-01-27", False), ("2027-03-16", "2027-03-17", True),
        ("2027-04-27", "2027-04-28", False), ("2027-06-08", "2027-06-09", True),
        ("2027-07-27", "2027-07-28", False), ("2027-09-14", "2027-09-15", True),
        ("2027-10-26", "2027-10-27", False), ("2027-12-07", "2027-12-08", True),
    )
    for first, statement, _ in svc.FOMC_MEETINGS:
        assert date.fromisoformat(statement) - date.fromisoformat(first) == timedelta(days=1)
    assert svc.FOMC_THROUGH == "2027-12-08"
    assert (svc.FOMC_CHECKED_AT, svc.FOMC_PAGE_UPDATED) == ("2026-10-25", "2026-10-07")
    assert svc.FOMC_SOURCE == "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"


def test_FOMC_일정은_창_안_회의의_성명일만():
    events = svc.fomc_events(TODAY, END)

    assert [(e["date"], e["sep"], e["meetingStart"]) for e in events] == [
        ("2026-10-28", False, "2026-10-27"), ("2026-12-09", True, "2026-12-08")]
    assert {e["kind"] for e in events} == {"FOMC"} and {e["releaseId"] for e in events} == {None}
    assert {e["source"] for e in events} == {svc.FOMC_SOURCE}
    assert "SEP" in events[1]["name"] and "SEP" not in events[0]["name"]


def test_FOMC_상수_끝이_창에_들어오면_갱신_필요():
    assert svc.fomc_status(date(2027, 12, 8)) == "ok"
    assert svc.fomc_status(date(2027, 12, 9)) == "갱신 필요"


# ==============================================================================
# 2. FRED 발표 일정
# ==============================================================================
def test_FRED_실제_응답에서_창_안_날짜만_남긴다():
    cpi = _json("fred_release_dates_cpi.json")["release_dates"]
    assert svc.parse_release_dates(cpi, 10, TODAY, END) == ["2026-11-10"]

    step0 = _json("fred_release_dates_step0.json")
    assert svc.parse_release_dates(step0["54"]["release_dates"], 54, TODAY, END) == ["2026-10-29", "2026-11-25"]
    assert svc.parse_release_dates(step0["50"]["release_dates"], 50, TODAY, END) == ["2026-11-06", "2026-12-04"]


def test_FRED_다른_릴리스_행과_읽을_수_없는_날짜와_중복은_버린다():
    rows = [{"release_id": 10, "date": "2026-11-10"}, {"release_id": 10, "date": "2026-11-10"},
            {"release_id": 101, "date": "2026-11-11"}, {"release_id": 10, "date": "11/12/2026"},
            {"release_id": 10, "date": None}, "x", {"release_id": 10, "date": "2026-10-24"}]
    assert svc.parse_release_dates(rows, 10, TODAY, END) == ["2026-11-10"]


class _Response:
    def __init__(self, status: int, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakeFred:
    """
    release_id → 응답(상태, 본문) 또는 예외. 부른 요청을 기록합니다.

    진짜 FRED처럼 ``realtime_end`` 뒤의 발표일은 빼고 돌려줍니다 — 단계 0 CPI 고정본은 realtime_end 12-08로 받아 12-10이 없습니다.
    """

    def __init__(self, responses: dict | None = None):
        step0 = _json("fred_release_dates_step0.json")
        self.responses = responses if responses is not None else {
            10: (200, _json("fred_release_dates_cpi.json")),
            54: (200, step0["54"]), 50: (200, step0["50"]), 53: (200, step0["53"]),
        }
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, dict(params or {})))
        outcome = self.responses[params["release_id"]]
        if isinstance(outcome, Exception):
            raise outcome
        status, body = outcome
        end = params.get("realtime_end")
        if isinstance(body, dict) and isinstance(body.get("release_dates"), list) and end:
            body = {**body, "realtime_end": end,
                    "release_dates": [row for row in body["release_dates"] if str(row.get("date")) <= end]}
        return _Response(status, body)

    def release_ids(self) -> list[int]:
        return [params["release_id"] for _, params in self.calls]


def test_FRED_요청은_릴리스별_앞날짜_포함_요청한_범위(monkeypatch):
    fake = FakeFred()
    monkeypatch.setattr(svc, "get_fred_session", lambda: fake)
    monkeypatch.setattr(settings, "fred_key", lambda: SENTINEL_KEY)

    assert svc.fetch_release_dates(10, TODAY, date(2026, 12, 31)) == ["2026-11-10"]

    url, params = fake.calls[0]
    assert url == f"{settings.FRED_API_BASE}/release/dates"
    assert params == {"release_id": 10, "api_key": SENTINEL_KEY, "file_type": "json",
                      "include_release_dates_with_no_data": "true", "realtime_start": "2026-10-25",
                      "realtime_end": "2026-12-31", "sort_order": "asc"}


@pytest.mark.parametrize(("outcome", "expected"), [
    ((400, {"error_message": f"api_key={SENTINEL_KEY} is not registered"}), "HTTP 400 — FRED_API_KEY 확인"),
    ((500, None), "HTTP 500"),
    ((200, ValueError("no json")), "JSON"),
    ((200, {"error": "x"}), "release_dates가 없습니다"),
    (ConnectionError(f"GET /fred/release/dates?release_id=10&api_key={SENTINEL_KEY}&file_type=json broke"), "ConnectionError"),
])
def test_FRED_실패_사유에_키를_싣지_않는다(monkeypatch, outcome, expected):
    monkeypatch.setattr(svc, "get_fred_session", lambda: FakeFred({10: outcome}))
    monkeypatch.setattr(settings, "fred_key", lambda: SENTINEL_KEY)

    with pytest.raises(svc.CalendarFetchError) as exc:
        svc.fetch_release_dates(10, TODAY, END)

    assert expected in str(exc.value)
    assert SENTINEL_KEY not in str(exc.value)


# ==============================================================================
# 3. 실적일 해석 (원본 고정본)
# ==============================================================================
def test_원본_고정본에서_다음_실적일과_장_구분을_읽는다():
    aapl = svc.parse_earnings(_raw("AAPL"), NOW)
    assert (aapl.date, aapl.session, aapl.is_estimated, aapl.epoch, aapl.note) == (
        "2026-11-02", "AMC", False, 1793649600, None)
    assert aapl.has_module

    panw = svc.parse_earnings(_raw("PANW"), NOW)
    assert (panw.date, panw.session, panw.is_estimated) == ("2026-11-19", None, True), "추정치는 시각이 자리표시라 장 구분 없음"

    jpm = svc.parse_earnings(_raw("JPM"), NOW)
    assert (jpm.date, jpm.session, jpm.is_estimated) == ("2027-01-14", "BMO", False)


def test_장_구분은_UTC_시각으로_가른다_서머타임이_끝나도():
    # 단계 0의 AMD: 2026-11-03 20:00 UTC = 15:00 EST. 동부 시각으로 가르면 '장중'으로 보입니다.
    amd = svc.parse_earnings(_with_dates([_epoch("2026-11-03T20:00:00+00:00")]), NOW)
    assert (amd.date, amd.session) == ("2026-11-03", "AMC")
    # 서머타임 중 12:30 UTC = 08:30 EDT, 끝난 뒤 = 07:30 EST — 둘 다 장전.
    assert svc.parse_earnings(_with_dates([_epoch("2026-10-29T12:30:00+00:00")]), NOW).session == "BMO"
    assert svc.parse_earnings(_with_dates([_epoch("2026-11-04T12:30:00+00:00")]), NOW).session == "BMO"
    # 그 밖의 시각은 모름.
    assert svc.parse_earnings(_with_dates([_epoch("2026-11-04T15:00:00+00:00")]), NOW).session is None


def test_날짜는_미국_동부_날짜다_서버나_화면_시간대가_아니라():
    # AMZN 2026-10-29 20:00 UTC = 10-29 16:00 EDT = 10-30 05:00 KST. 공개 Ticker.calendar(KST 컨테이너)는 10-30으로 밀었습니다.
    assert svc.parse_earnings(_with_dates([_epoch("2026-10-29T20:00:00+00:00")]), NOW).date == "2026-10-29"
    # 00:30 UTC는 동부로 전날 저녁.
    assert svc.parse_earnings(_with_dates([_epoch("2026-11-10T00:30:00+00:00")]), NOW).date == "2026-11-09"


def test_지난_날짜만_있으면_다음_일정_미정과_마지막_날짜():
    parsed = svc.parse_earnings(_with_dates([_epoch("2026-10-09T12:30:00+00:00")]), NOW)
    assert (parsed.date, parsed.session, parsed.epoch, parsed.note, parsed.last_date) == (
        None, None, None, "다음 일정 미정", "2026-10-09")


def test_범위면_지금_이후_가장_이른_것_추정_여부를_모르면_장_구분_없음():
    stamps = [_epoch("2026-11-20T20:00:00+00:00"), _epoch("2026-10-20T20:00:00+00:00"), _epoch("2026-11-24T20:00:00+00:00")]
    parsed = svc.parse_earnings(_with_dates(stamps, estimate=None), NOW)
    assert (parsed.date, parsed.is_estimated, parsed.session) == ("2026-11-20", None, None)


def test_실적일이_없으면_None이고_0으로_채우지_않는다():
    empty = svc.parse_earnings(_with_dates([]), NOW)
    assert (empty.date, empty.epoch, empty.session, empty.note) == (None, None, None, "실적일 없음")

    no_module = svc.parse_earnings({"quoteSummary": {"result": [{}], "error": None}}, NOW)
    assert (no_module.date, no_module.has_module) == (None, False)

    raw = _raw("AAPL")
    del raw["quoteSummary"]["result"][0]["calendarEvents"]["earnings"]
    no_earnings = svc.parse_earnings(raw, NOW)
    assert (no_earnings.date, no_earnings.has_module) == (None, True)


@pytest.mark.parametrize("raw", [
    {}, {"quoteSummary": None}, {"quoteSummary": {"result": None, "error": None}},
    {"quoteSummary": {"result": ["x"]}}, {"quoteSummary": {"result": [{"calendarEvents": []}]}},
    {"quoteSummary": {"result": [{"calendarEvents": {"earnings": {"earningsDate": ["2026-11-02"]}}}]}},
    {"quoteSummary": {"result": [{"calendarEvents": {"earnings": {"earningsDate": [True]}}}]}},
])
def test_모양이_다른_응답은_ShapeError(raw):
    with pytest.raises(svc.ShapeError):
        svc.parse_earnings(raw, NOW)


# ==============================================================================
# 4. 내부 호출 감시
# ==============================================================================
class _Quote:
    def __init__(self, outcome):
        self.outcome = outcome
        self.modules = None

    def _fetch(self, modules):
        self.modules = modules
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def test_내부_호출은_calendarEvents_모듈만_묻는다(monkeypatch):
    quote = _Quote(_raw("AAPL"))

    class _Ticker:
        def __init__(self, symbol):
            self._quote = quote

    monkeypatch.setattr(svc.yf, "Ticker", _Ticker)
    assert svc.fetch_calendar_events("AAPL") == _raw("AAPL")
    assert quote.modules == ["calendarEvents"]


def test_내부_메서드가_없으면_InternalApiChanged(monkeypatch):
    class _Ticker:
        def __init__(self, symbol):
            pass

    monkeypatch.setattr(svc.yf, "Ticker", _Ticker)
    with pytest.raises(svc.InternalApiChanged):
        svc.fetch_calendar_events("AAPL")


@pytest.mark.parametrize(("error", "expected"), [
    (YFRateLimitError(), svc.RateLimited),
    (YFException("No valid modules provided, see available modules using `valid_modules`"), svc.InternalApiChanged),
    (TypeError("_fetch() got an unexpected keyword argument 'modules'"), svc.InternalApiChanged),
])
def test_내부_호출_오류를_구분한다(monkeypatch, error, expected):
    class _Ticker:
        def __init__(self, symbol):
            self._quote = _Quote(error)

    monkeypatch.setattr(svc.yf, "Ticker", _Ticker)
    with pytest.raises(expected):
        svc.fetch_calendar_events("AAPL")


def test_yfinance는_1_7_0으로_고정한다():
    # 내부 호출이라 버전이 바뀌면 고정본 시험을 다시 해야 합니다(명세 C1 '버전 고정').
    requirements = (Path(__file__).parents[1] / "requirements.txt").read_text(encoding="utf-8")
    assert "yfinance==1.7.0" in requirements.splitlines()
    assert svc.yfinance_version() == "1.7.0"


# ==============================================================================
# 5. 순서·캐시·설정 (네트워크·DB 없음)
# ==============================================================================
def _stamp(hours_ago: float) -> str:
    return (NOW - timedelta(hours=hours_ago)).isoformat()


def test_순서는_묻지_않은_종목_다음_오래전에_물은_순_캐시는_빠진다():
    previous = {
        "OLD": {"fetchedAt": _stamp(30), "checkedAt": _stamp(30)},
        "OLDER": {"fetchedAt": _stamp(50), "checkedAt": _stamp(50)},
        "FRESH": {"fetchedAt": _stamp(23), "checkedAt": _stamp(23)},
        "FAILED_RECENT": {"fetchedAt": None, "checkedAt": _stamp(5), "error": "x"},
        "FAILED_DUE": {"fetchedAt": None, "checkedAt": _stamp(7), "error": "x"},
        "STALE_DUE": {"fetchedAt": _stamp(40), "checkedAt": _stamp(6), "isStale": True},
        "BROKEN": {"checkedAt": "not a time"},
    }
    universe = ["ZNEW", "OLD", "OLDER", "FRESH", "FAILED_RECENT", "FAILED_DUE", "STALE_DUE", "BROKEN", "ANEW"]

    assert task_module.due_order(universe, previous, NOW) == [
        "ANEW", "BROKEN", "ZNEW", "OLDER", "OLD", "FAILED_DUE", "STALE_DUE"]


def test_ETF는_실적_일정을_묻지_않는다():
    universe = task_module.stock_universe()
    assert not set(universe) & set(indicators.PAPER_ETFS)
    assert "IVV" not in universe and "SPY" not in universe
    assert set(universe) < set(paper_universe.tradable())


def test_예산_설정은_1에서_600으로_자르고_잘못된_값은_기본값(monkeypatch):
    for raw, expected in (("", 120), ("abc", 120), ("0", 1), ("-5", 1), ("5000", 600), (" 30 ", 30)):
        monkeypatch.setenv("US_CALENDAR_EARNINGS_BUDGET", raw)
        assert settings.us_calendar_earnings_budget() == expected, raw
    monkeypatch.delenv("US_CALENDAR_EARNINGS_BUDGET")
    assert settings.us_calendar_earnings_budget() == 120


def test_시간_상한은_slow_태스크_상한보다_짧다():
    assert task_module.FRED_TIME_LIMIT_SECONDS < task_module.TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]


def test_slow에_등록되고_태스크는_29개():
    task = tasks.TASKS_BY_NAME["us_calendar"]
    assert task.speed == "slow" and task.run is task_module.task_us_calendar
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 29  # 2단계 B의 news_headlines·C의 earnings_surprise·v2 B3의 fsc_etf_prices·v2 B4의 kr_paper_universe까지


def test_데이터셋_이름():
    assert catalog.SNAP_US_CALENDAR == "calendar.us_events"


# ==============================================================================
# 6. 태스크 (PostgreSQL)
# ==============================================================================
UNIVERSE = ("AAPL", "JPM", "PANW", "SPY", "ZZZZ")


class FakeYahoo:
    """티커 → quoteSummary 원문 / None(404) / 예외. 부른 티커를 기록합니다."""

    def __init__(self):
        self.responses: dict = {t: _raw(t) for t in ("AAPL", "JPM", "PANW")}
        self.calls: list[str] = []
        fake = self

        class _Ticker:
            def __init__(self, symbol):
                fake.calls.append(symbol)
                self._quote = _Quote(fake.responses.get(symbol))

        self.Ticker = _Ticker


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.delenv("US_CALENDAR_EARNINGS_BUDGET", raising=False)
    monkeypatch.setattr(paper_universe, "tradable", lambda: UNIVERSE)
    monkeypatch.setattr(settings, "fred_key", lambda: SENTINEL_KEY)
    fred = FakeFred()
    monkeypatch.setattr(svc, "get_fred_session", lambda: fred)
    yahoo = FakeYahoo()
    monkeypatch.setattr(svc.yf, "Ticker", yahoo.Ticker)
    clock = {"now": NOW, "mono": 0.0}
    monkeypatch.setattr(task_module, "_now", lambda: clock["now"])
    monkeypatch.setattr(task_module, "_clock", lambda: clock["mono"])
    monkeypatch.setattr(task_module, "_sleep", lambda seconds: None)
    assert "SPY" in indicators.PAPER_ETFS
    return {"fred": fred, "yahoo": yahoo, "clock": clock}


def _payload(store) -> dict:
    return store.read_snapshot(catalog.SNAP_US_CALENDAR).payload


def _later(env, hours: float) -> None:
    env["clock"]["now"] = env["clock"]["now"] + timedelta(hours=hours)


def test_거시_일정과_실적_일정을_한_저장본에_남긴다(store, env):
    detail = task_module.task_us_calendar()

    payload = _payload(store)
    macro = payload["macro"]
    assert [(e["date"], e["kind"], e.get("key")) for e in macro["events"]] == [
        ("2026-10-28", "FOMC", None), ("2026-10-29", "RELEASE", "GDP"), ("2026-10-29", "RELEASE", "PCE"),
        ("2026-11-06", "RELEASE", "EMPLOYMENT"), ("2026-11-10", "RELEASE", "CPI"), ("2026-11-25", "RELEASE", "GDP"),
        ("2026-11-25", "RELEASE", "PCE"), ("2026-12-04", "RELEASE", "EMPLOYMENT"), ("2026-12-09", "FOMC", None)]
    cpi = next(e for e in macro["events"] if e.get("key") == "CPI")
    assert cpi == {"name": "CPI (Consumer Price Index)", "key": "CPI", "date": "2026-11-10", "kind": "RELEASE",
                   "releaseId": 10, "agency": "BLS", "source": "FRED release/dates (api.stlouisfed.org) — BLS 일정"}
    assert macro["horizon"] == {"from": "2026-10-25", "to": "2026-12-09"}
    # PCE·GDP 12-23은 45일 창 밖이라 일정에는 없지만 FRED가 알려 준 날짜라 lastKnownDate입니다.
    assert macro["fred"] == {"status": "ok", "source": svc.FRED_SOURCE, "lastKnownDate": {
        "CPI": "2026-11-10", "PCE": "2026-12-23", "EMPLOYMENT": "2026-12-04", "GDP": "2026-12-23"}}
    assert macro["fomc"] == {"source": svc.FOMC_SOURCE, "checkedAt": "2026-10-25", "pageUpdated": "2026-10-07",
                             "through": "2027-12-08", "status": "ok"}
    assert env["fred"].release_ids() == [10, 54, 50, 53]
    assert {(p["realtime_start"], p["realtime_end"]) for _, p in env["fred"].calls} == {("2026-10-25", "2026-12-31")}

    earnings = payload["earnings"]
    assert sorted(env["yahoo"].calls) == ["AAPL", "JPM", "PANW", "ZZZZ"], "ETF(SPY)는 묻지 않습니다"
    items = earnings["items"]
    assert sorted(items) == ["AAPL", "JPM", "PANW", "ZZZZ"]
    assert items["AAPL"] == {"date": "2026-11-02", "session": "AMC", "isEstimated": False, "epoch": 1793649600,
                             "source": svc.EARNINGS_SOURCE, "fetchedAt": NOW.isoformat(), "checkedAt": NOW.isoformat()}
    assert (items["PANW"]["session"], items["PANW"]["isEstimated"]) == (None, True)
    assert items["ZZZZ"]["date"] is None and items["ZZZZ"]["fetchedAt"] is None and "404" in items["ZZZZ"]["error"]
    assert {k: earnings[k] for k in ("covered", "upcoming", "universe", "budget", "fetchedThisRun", "failedThisRun")} == {
        "covered": 3, "upcoming": 3, "universe": 4, "budget": 120, "fetchedThisRun": 3, "failedThisRun": 1}
    assert "1.7.0" in earnings["source"]
    assert payload["generatedAt"] == NOW.isoformat()

    assert detail.startswith("거시 9건(FRED 4/4, FOMC 2) · 실적 3/4종목 갱신(예산 120, 캐시 0), 일정 있음 3/4"), detail
    assert SENTINEL_KEY not in json.dumps(payload, ensure_ascii=False) and SENTINEL_KEY not in detail


def test_FRED_키가_없으면_거시는_FOMC만_실적은_그대로(store, env, monkeypatch):
    monkeypatch.setattr(settings, "fred_key", lambda: "")

    detail = task_module.task_us_calendar()

    macro = _payload(store)["macro"]
    assert env["fred"].calls == []
    assert {e["kind"] for e in macro["events"]} == {"FOMC"} and len(macro["events"]) == 2
    assert macro["fred"] == {"status": "키 미설정", "source": svc.FRED_SOURCE, "lastKnownDate": {
        "CPI": None, "PCE": None, "EMPLOYMENT": None, "GDP": None}}
    assert _payload(store)["earnings"]["fetchedThisRun"] == 3
    assert "FRED 키 미설정" in detail


def test_키가_없고_캐시가_모두_유효하면_실패가_아니라_저장본만_새로_쓴다(store, env, monkeypatch):
    env["yahoo"].responses["ZZZZ"] = _raw("JPM")
    task_module.task_us_calendar()
    monkeypatch.setattr(settings, "fred_key", lambda: "")
    env["yahoo"].calls.clear()
    _later(env, 1)

    detail = task_module.task_us_calendar()

    assert env["yahoo"].calls == []
    assert "캐시 4" in detail
    payload = _payload(store)
    assert payload["generatedAt"] == env["clock"]["now"].isoformat()
    assert payload["earnings"]["items"]["AAPL"]["fetchedAt"] == NOW.isoformat()


def test_FRED_일부_실패는_그_릴리스만_이전_값을_잇는다(store, env):
    task_module.task_us_calendar()
    env["fred"].responses[54] = (500, None)
    _later(env, 2)

    detail = task_module.task_us_calendar()

    macro = _payload(store)["macro"]
    pce = [e for e in macro["events"] if e.get("key") == "PCE"]
    assert [e["date"] for e in pce] == ["2026-10-29", "2026-11-25"]
    assert all(e["isStale"] and e["staleReason"] == "HTTP 500" and e["staleSince"] for e in pce)
    assert not any(e.get("isStale") for e in macro["events"] if e.get("key") != "PCE")
    assert macro["fred"]["status"] == "ok" and macro["fred"]["isStale"] is True
    assert macro["fred"]["failed"] == {"PCE": "HTTP 500"}
    assert macro["fred"]["lastKnownDate"]["PCE"] == "2026-12-23"
    assert "FRED 3/4" in detail and "FRED 이전 값 PCE" in detail
    # 실적은 24시간 캐시(ZZZZ 실패는 6시간 뒤) — 두 시간 뒤에는 묻지 않습니다.
    assert "실적 0/0종목" in detail


def test_이어받은_릴리스는_처음_이어받은_시각을_지키고_지난_날짜는_빠진다(store, env):
    task_module.task_us_calendar()
    env["fred"].responses[54] = (500, None)
    _later(env, 2)
    task_module.task_us_calendar()
    first_since = next(e for e in _payload(store)["macro"]["events"] if e.get("key") == "PCE")["staleSince"]
    _later(env, 24 * 5)  # 10-30 — 10-29 발표는 지났습니다

    task_module.task_us_calendar()

    pce = [e for e in _payload(store)["macro"]["events"] if e.get("key") == "PCE"]
    assert [e["date"] for e in pce] == ["2026-11-25"]
    assert pce[0]["staleSince"] == first_since


def test_창에_날짜가_없으면_마지막으로_받은_날짜를_둔다(store, env):
    task_module.task_us_calendar()
    env["fred"].responses[10] = (200, {**_json("fred_release_dates_cpi.json"), "release_dates": []})
    _later(env, 1)

    task_module.task_us_calendar()

    fred = _payload(store)["macro"]["fred"]
    assert fred["lastKnownDate"]["CPI"] == "2026-11-10" and fred["status"] == "ok"
    assert not [e for e in _payload(store)["macro"]["events"] if e.get("key") == "CPI"]


def _release_body(release_id: int, days: list[str]) -> dict:
    """단계 0 CPI 실제 응답과 같은 모양에 날짜만 바꾼 본문."""
    body = copy.deepcopy(_json("fred_release_dates_cpi.json"))
    body["release_dates"] = [{"release_id": release_id, "date": day} for day in days]
    body["count"] = len(days)
    return body


def test_lastKnownDate는_FRED가_아는_마지막_날짜다_45일_창_끝이_아니라(store, env):
    # 고용보고서처럼 발표 간격이 5주면 다음 발표(05-07)가 45일 창(03-22 → 05-06) 밖입니다. 창 끝까지만 물으면 lastKnownDate가
    # 04-02가 되어, 백엔드가 FRED가 이미 아는 05-07을 두고 '04-02 뒤 일정 미공개'로 적었습니다.
    env["clock"]["now"] = datetime(2027, 3, 22, 12, 0, tzinfo=timezone.utc)   # 동부 2027-03-22 08:00
    env["fred"].responses = {
        10: (200, _release_body(10, ["2027-04-13", "2027-05-12"])),
        54: (200, _release_body(54, ["2027-03-26", "2027-04-30", "2027-05-28"])),
        50: (200, _release_body(50, ["2027-04-02", "2027-05-07"])),
        53: (200, _release_body(53, ["2027-03-25", "2027-04-29"])),
    }

    task_module.task_us_calendar()

    macro = _payload(store)["macro"]
    assert macro["horizon"] == {"from": "2027-03-22", "to": "2027-05-06"}
    assert [(e["date"], e["key"]) for e in macro["events"] if e["kind"] == "RELEASE"] == [
        ("2027-03-25", "GDP"), ("2027-03-26", "PCE"), ("2027-04-02", "EMPLOYMENT"), ("2027-04-13", "CPI"),
        ("2027-04-29", "GDP"), ("2027-04-30", "PCE")]
    assert macro["fred"]["lastKnownDate"] == {
        "CPI": "2027-05-12", "PCE": "2027-05-28", "EMPLOYMENT": "2027-05-07", "GDP": "2027-04-29"}
    assert {p["realtime_end"] for _, p in env["fred"].calls} == {"2027-12-31"}


def test_시도한_것이_전부_실패하면_EmptyResult로_저장본을_그대로_둔다(store, env):
    task_module.task_us_calendar()
    before = _payload(store)
    env["fred"].responses = {rid: (503, None) for rid in (10, 54, 50, 53)}
    env["yahoo"].responses = {}
    _later(env, 25)

    with pytest.raises(EmptyResult) as exc:
        task_module.task_us_calendar()

    assert "기존 저장본 유지" in str(exc.value) and "HTTP 503" in str(exc.value)
    assert _payload(store) == before


def test_FRED가_전부_실패해도_실적을_받았으면_FRED는_이전_값으로_쓴다(store, env):
    task_module.task_us_calendar()
    env["fred"].responses = {rid: (503, None) for rid in (10, 54, 50, 53)}
    _later(env, 25)

    detail = task_module.task_us_calendar()

    macro = _payload(store)["macro"]
    assert macro["fred"]["status"] == "실패" and macro["fred"]["isStale"] is True
    releases = [e for e in macro["events"] if e["kind"] == "RELEASE"]
    assert releases and all(e["isStale"] for e in releases)
    assert "FRED 0/4" in detail and _payload(store)["earnings"]["fetchedThisRun"] == 3


def test_실적_일부_실패는_그_종목만_이전_값을_잇고_6시간_뒤에_다시_묻는다(store, env):
    env["yahoo"].responses["ZZZZ"] = _raw("JPM")
    task_module.task_us_calendar()
    env["yahoo"].responses["AAPL"] = RuntimeError("boom")
    _later(env, 25)

    detail = task_module.task_us_calendar()

    aapl = _payload(store)["earnings"]["items"]["AAPL"]
    assert aapl["date"] == "2026-11-02" and aapl["isStale"] is True and "boom" in aapl["staleReason"]
    assert aapl["fetchedAt"] == NOW.isoformat() and aapl["checkedAt"] == env["clock"]["now"].isoformat()
    assert _payload(store)["earnings"]["items"]["JPM"]["fetchedAt"] == env["clock"]["now"].isoformat()
    assert "실패 1종목 · 이전 값 1개(AAPL)" in detail, detail

    env["yahoo"].calls.clear()
    _later(env, 5)
    task_module.task_us_calendar()
    assert "AAPL" not in env["yahoo"].calls
    _later(env, 1.5)
    task_module.task_us_calendar()
    assert "AAPL" in env["yahoo"].calls


def test_키가_없고_늘_실패하는_종목만_물을_차례면_실패가_아니라_저장하고_6시간_뒤에_다시_묻는다(store, env, monkeypatch):
    # FRED 키 없이 늘 404인 종목(ZZZZ)이 하나 있으면, 정상 종목이 24시간 캐시 안인 동안은 ZZZZ만 물을 차례입니다. 이번에 물은
    # 종목만 보고 '실적 전부 실패'로 정하던 때는 매시간 EmptyResult였고, 저장하지 않아 ZZZZ의 checkedAt이 그대로라 6시간 재시도
    # 간격도 지켜지지 않았습니다(매시간 다시 물음).
    monkeypatch.setattr(settings, "fred_key", lambda: "")
    task_module.task_us_calendar()
    env["yahoo"].calls.clear()
    _later(env, 7)

    detail = task_module.task_us_calendar()

    assert env["yahoo"].calls == ["ZZZZ"]
    payload = _payload(store)
    assert payload["generatedAt"] == env["clock"]["now"].isoformat()
    zzzz = payload["earnings"]["items"]["ZZZZ"]
    assert zzzz["checkedAt"] == env["clock"]["now"].isoformat() and "404" in zzzz["error"]
    assert payload["earnings"]["items"]["AAPL"]["fetchedAt"] == NOW.isoformat()
    assert "실적 0/1종목 갱신(예산 120, 캐시 3)" in detail and "실패 1종목" in detail, detail

    env["yahoo"].calls.clear()
    _later(env, 1)
    task_module.task_us_calendar()
    assert env["yahoo"].calls == [], "실패한 종목은 6시간 뒤에만 다시 묻습니다"


def test_키가_없고_캐시가_모두_지났는데_물은_종목이_전부_실패하면_EmptyResult(store, env, monkeypatch):
    # 위와 달리 쓸 수 있는 실적 캐시가 하나도 없으면 전부 실패입니다 — 저장본을 그대로 두고 실패로 보입니다.
    monkeypatch.setattr(settings, "fred_key", lambda: "")
    task_module.task_us_calendar()
    before = _payload(store)
    env["yahoo"].responses = {}
    _later(env, 25)

    with pytest.raises(EmptyResult) as exc:
        task_module.task_us_calendar()

    assert "기존 저장본 유지" in str(exc.value)
    assert _payload(store) == before


def test_예산은_종목_수이고_묻지_않은_종목부터_채운다(store, env, monkeypatch):
    monkeypatch.setenv("US_CALENDAR_EARNINGS_BUDGET", "2")

    first = task_module.task_us_calendar()
    assert env["yahoo"].calls == ["AAPL", "JPM"]
    assert "예산 소진 — 2종목은 다음 실행" in first, first
    assert sorted(_payload(store)["earnings"]["items"]) == ["AAPL", "JPM"]

    env["yahoo"].calls.clear()
    _later(env, 1)
    task_module.task_us_calendar()
    assert env["yahoo"].calls == ["PANW", "ZZZZ"]
    assert sorted(_payload(store)["earnings"]["items"]) == ["AAPL", "JPM", "PANW", "ZZZZ"]


def test_429면_그_실행의_나머지를_묻지_않는다(store, env):
    env["yahoo"].responses["JPM"] = YFRateLimitError()

    detail = task_module.task_us_calendar()

    assert env["yahoo"].calls == ["AAPL", "JPM"]
    assert "Yahoo 429로 멈춤 — 2종목은 다음 실행" in detail, detail
    assert _payload(store)["earnings"]["items"]["JPM"]["error"] == "Yahoo 429(요청 제한)"


def test_연속_실패_5회면_나머지는_다음_실행(store, env, monkeypatch):
    many = tuple(f"T{i}" for i in range(7))
    monkeypatch.setattr(paper_universe, "tradable", lambda: many)

    detail = task_module.task_us_calendar()

    assert env["yahoo"].calls == ["T0", "T1", "T2", "T3", "T4"]
    assert "연속 실패 5회로 멈춤 — 2종목은 다음 실행" in detail, detail


class _NoQuote:
    """내부 호출(Ticker._quote)이 없어진 yfinance."""

    def __init__(self, symbol):
        pass


def test_내부_메서드가_없으면_EmptyResult로_멈추고_실적은_직전_값을_잇되_거시는_새로_저장한다(store, env, monkeypatch):
    task_module.task_us_calendar()
    before = _payload(store)["earnings"]["items"]
    monkeypatch.setattr(svc.yf, "Ticker", _NoQuote)
    # 50일 뒤(12-14). 실적 고장으로 거시까지 버리던 때는 저장본의 45일 창(10-25~12-09)이 코드를 고칠 때까지 굳어, 창 안의
    # 2027-01-27 FOMC가 패킷에서 말없이 빠졌습니다.
    _later(env, 24 * 50)

    with pytest.raises(EmptyResult) as exc:
        task_module.task_us_calendar()

    assert "yfinance 내부 API 변경" in str(exc.value) and "거시 일정은 새로 저장" in str(exc.value), str(exc.value)
    payload = _payload(store)
    assert payload["generatedAt"] == env["clock"]["now"].isoformat()
    macro = payload["macro"]
    assert macro["horizon"] == {"from": "2026-12-14", "to": "2027-01-28"}
    assert [e["date"] for e in macro["events"] if e["kind"] == "FOMC"] == ["2027-01-27"]
    assert macro["fred"]["status"] == "ok"
    earnings = payload["earnings"]
    assert earnings["status"] == "yfinance 내부 API 변경" and "Ticker._quote._fetch 없음" in earnings["stoppedReason"]
    for ticker in ("AAPL", "JPM", "PANW"):
        item = earnings["items"][ticker]
        assert (item["date"], item["fetchedAt"], item["checkedAt"]) == (
            before[ticker]["date"], before[ticker]["fetchedAt"], before[ticker]["checkedAt"]), ticker
        assert item["isStale"] is True and "yfinance 내부 API 변경" in item["staleReason"], ticker
    assert earnings["items"]["ZZZZ"] == before["ZZZZ"], "이어받을 값이 없는 오류 줄은 그대로"
    assert earnings["fetchedThisRun"] == 0


def test_내부_API가_바뀌고_FRED도_전부_실패하면_저장본을_덮지_않는다(store, env, monkeypatch):
    task_module.task_us_calendar()
    before = _payload(store)
    env["fred"].responses = {rid: (503, None) for rid in (10, 54, 50, 53)}
    monkeypatch.setattr(svc.yf, "Ticker", _NoQuote)
    _later(env, 25)

    with pytest.raises(EmptyResult) as exc:
        task_module.task_us_calendar()

    assert "yfinance 내부 API 변경" in str(exc.value) and "기존 저장본 유지" in str(exc.value), str(exc.value)
    assert _payload(store) == before


def test_응답에_calendarEvents가_하나도_없으면_내부_API_변경으로_멈춘다(store, env, monkeypatch):
    many = tuple(f"T{i}" for i in range(6))
    monkeypatch.setattr(paper_universe, "tradable", lambda: many)
    env["yahoo"].responses = {t: {"quoteSummary": {"result": [{"price": {}}], "error": None}} for t in many}

    with pytest.raises(EmptyResult) as exc:
        task_module.task_us_calendar()

    assert "yfinance 내부 API 변경" in str(exc.value) and "응답 6건" in str(exc.value)
    # 모양이 바뀐 응답의 '실적일 없음'은 믿을 수 없어 싣지 않습니다. 거시 일정은 그대로 저장합니다.
    payload = _payload(store)
    assert payload["earnings"]["items"] == {} and payload["earnings"]["status"] == "yfinance 내부 API 변경"
    assert len([e for e in payload["macro"]["events"] if e["kind"] == "RELEASE"]) == 7


def test_FRED는_150초가_지나면_다음_릴리스를_묻지_않는다(store, env, monkeypatch):
    clock = env["clock"]
    real_fetch = svc.fetch_release_dates

    def slow_fetch(release_id, start, end):
        clock["mono"] += 100.0
        return real_fetch(release_id, start, end)

    monkeypatch.setattr(svc, "fetch_release_dates", slow_fetch)

    detail = task_module.task_us_calendar()

    # 0초·100초에 시작한 두 릴리스만 묻습니다. 실적은 200초 — 420초 상한 전이라 그대로 묻습니다.
    assert env["fred"].release_ids() == [10, 54]
    assert _payload(store)["macro"]["fred"]["failed"] == {
        "EMPLOYMENT": "시간 상한(150초) — 다음 실행", "GDP": "시간 상한(150초) — 다음 실행"}
    assert _payload(store)["macro"]["fred"]["status"] == "ok"
    assert "FRED 2/4" in detail and len(env["yahoo"].calls) == 4


def test_실적은_420초가_지나면_새_요청을_멈추고_받은_만큼_쓴다(store, env, monkeypatch):
    clock = env["clock"]
    real_fetch = svc.fetch_calendar_events

    def slow_fetch(ticker):
        clock["mono"] += 200.0
        return real_fetch(ticker)

    monkeypatch.setattr(svc, "fetch_calendar_events", slow_fetch)

    detail = task_module.task_us_calendar()

    # 0초·200초·400초에 시작한 세 종목까지(600초 > 420초에서 멈춤).
    assert env["yahoo"].calls == ["AAPL", "JPM", "PANW"]
    assert "시간 상한(420초) — 1종목은 다음 실행" in detail, detail
    assert sorted(_payload(store)["earnings"]["items"]) == ["AAPL", "JPM", "PANW"]


def test_FOMC_상수_끝이_창에_들어오면_갱신_필요로_적는다(store, env):
    env["clock"]["now"] = datetime(2027, 11, 1, 12, 0, tzinfo=timezone.utc)

    detail = task_module.task_us_calendar()

    fomc = _payload(store)["macro"]["fomc"]
    assert fomc["status"] == "갱신 필요" and fomc["through"] == "2027-12-08"
    assert [e["date"] for e in _payload(store)["macro"]["events"] if e["kind"] == "FOMC"] == ["2027-12-08"]
    assert "FOMC 상수 갱신 필요(~2027-12-08)" in detail


def test_저장본이_없으면_누락_데이터셋에_보인다(store):
    assert catalog.SNAP_US_CALENDAR in {entry["name"] for entry in store.missing_datasets()}
