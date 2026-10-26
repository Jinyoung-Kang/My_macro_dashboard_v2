"""
tests/test_earnings_surprise.py
어닝 서프라이즈(태스크 earnings_surprise, 2단계 명세 C1·C2·§10·D36) — 모의 매매 Claude 계좌 패킷 8b_fundamentals의 EPS 원자료.

고정하는 규칙
  1. 출처는 yfinance 1.7.0 내부 호출 Ticker._quote._fetch(['earnings'])의 earningsChart.quarterly 하나. 행 날짜(PIT 키)는 실제 발표
     시각(reportedDate)의 미국 동부 날짜, reportedAt은 동부 오프셋을 붙인 ISO. 발표 시각이 없거나 아직 오지 않은 분기는 넣지 않는다.
  2. surprisePct = (actual − estimate) / |estimate| × 100(소수 둘째 자리) — 고정본의 Yahoo 문자열과 같다. 추정치가 없거나 0이면 None
     (0으로 채우지 않음). |estimate| < 0.05면 smallBase. 통화는 financialCurrency(BIDU CNY).
  3. (날짜, 티커)마다 upsert — 나중에 받은 값(채워진 추정치)이 남고, 응답에서 빠진 옛 분기 행은 지우지 않는다.
  4. 순서: 받은 적 없음(처음 보는 종목 → 실패만 한 종목) → us_calendar 저장본의 실적일이 오늘(동부) 이하인데 그 날짜 + 1일 전에
     받은 종목 → 가장 오래전에 받은 순, 같은 순위는 티커 순. 예산(EARNINGS_SURPRISE_BUDGET, 1~600, 기본 100)만큼만 묻는다.
  5. 429면 그 실행을 멈추고 받은 만큼 저장(stoppedReason). 첫 요청부터 429면 EmptyResult.
  6. 내부 호출이 없거나 응답 5건 이상에 earnings가 없거나, 응답 5건 이상이 모두 저장할 분기를 주지 않으면 EmptyResult('yfinance
     내부 API 변경') — 행·상태 그대로. quarterly 칸이 없거나 어느 분기에도 reportedDate 칸이 없거나 epoch가 범위 밖이면 그 종목만 실패.
  7. 일부 실패 → 그 종목 상태 줄만 이전 값 + isStale(행은 그대로). 전부 실패 → EmptyResult(저장본 그대로).
  8. 연속 실패 상한은 이번 실행에서 하나라도 받은 뒤, 직전에 제대로 받은 종목의 실패만 센다(늘 실패하는 종목이 태스크를 멈추지 않게).

외부 네트워크를 쓰지 않습니다 — 가짜 yfinance Ticker가 tests/fixtures/earnings/의 실제 응답을 돌려줍니다.
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
from app.services import earnings_surprise as svc
from app.tasks import earnings_surprise as task_module
from app.tasks.base import EmptyResult

FIXTURES = Path(__file__).parent / "fixtures" / "earnings"
NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)   # 동부 2026-10-25 08:00
TODAY = date(2026, 10, 25)


def _raw(ticker: str) -> dict:
    return copy.deepcopy(json.loads((FIXTURES / "quote_summary_earnings.json").read_text(encoding="utf-8"))[ticker])


def _quarters(raw: dict) -> list[dict]:
    return raw["quoteSummary"]["result"][0]["earnings"]["earningsChart"]["quarterly"]


def _epoch(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp())


# ==============================================================================
# 1. 원문 읽기 (네트워크·DB 없음)
# ==============================================================================
def test_실제_응답_AAPL은_발표_시각의_동부_날짜로_4분기():
    parsed = svc.parse_earnings(_raw("AAPL"), NOW)

    assert (parsed.has_module, parsed.currency, parsed.skipped) == (True, "USD", 0)
    assert [day for day, _ in parsed.rows] == ["2025-10-30", "2026-01-29", "2026-04-30", "2026-07-30"]
    assert parsed.rows[0][1] == {
        "periodEnd": "2025-09-30", "actual": 1.85, "estimate": 1.76993, "surprisePct": 4.52, "currency": "USD",
        "smallBase": False, "reportedAt": "2025-10-30T16:30:00-04:00", "source": "yfinance quoteSummary earnings.earningsChart"}
    # 서머타임이 끝난 뒤(1월)는 -05:00 — 동부 시각 그대로 적습니다.
    assert parsed.rows[1][1]["reportedAt"] == "2026-01-29T16:30:00-05:00"
    assert [payload["periodEnd"] for _, payload in parsed.rows] == ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]


def test_계산한_서프라이즈율은_고정본의_Yahoo_문자열과_같다():
    # 응답 문자열을 쓰지 않고 계산하지만(빠지거나 형식이 바뀔 수 있음), 네 종목 15분기 모두 같은 값이어야 공식이 맞습니다.
    checked = 0
    for ticker in ("AAPL", "BIDU", "SPCX", "INTC"):
        raw = _raw(ticker)
        expected = {datetime.fromtimestamp(q["reportedDate"], svc.NEW_YORK).date().isoformat(): q.get("surprisePct")
                    for q in _quarters(raw)}
        for day, payload in svc.parse_earnings(raw, NOW).rows:
            text = expected[day]
            assert payload["surprisePct"] == (float(text) if text is not None else None), (ticker, day)
            checked += 1
    assert checked == 15


def test_추정치가_없는_분기는_surprisePct가_None이고_0이_아니다():
    parsed = svc.parse_earnings(_raw("SPCX"), NOW)

    first = parsed.rows[0][1]
    assert parsed.rows[0][0] == "2026-05-07"
    assert (first["actual"], first["estimate"], first["surprisePct"], first["smallBase"]) == (-1.27, None, None, None)
    # 적자 추정치(음수)는 분모 절댓값 — 덜 나쁜 실적이 +로 나옵니다.
    second = parsed.rows[1][1]
    assert (second["estimate"], second["surprisePct"], second["smallBase"]) == (-0.28931, 68.89, False)


def test_추정치가_0에_가까우면_smallBase이고_값은_그대로_계산한다():
    rows = svc.parse_earnings(_raw("INTC"), NOW).rows

    assert [(payload["estimate"], payload["smallBase"]) for _, payload in rows] == [
        (0.00705, True), (0.08264, False), (0.01313, True), (0.21584, False)]
    assert rows[0][1]["surprisePct"] == 3162.41


def test_추정치가_0이면_surprisePct는_None이고_smallBase():
    raw = _raw("AAPL")
    _quarters(raw)[0]["estimate"] = 0
    payload = svc.parse_earnings(raw, NOW).rows[0][1]
    assert (payload["estimate"], payload["surprisePct"], payload["smallBase"]) == (0.0, None, True)
    assert svc.surprise_pct(None, 1.0) is None and svc.surprise_pct(1.0, None) is None


def test_통화는_financialCurrency_ADR은_본국_통화():
    bidu = svc.parse_earnings(_raw("BIDU"), NOW)
    assert bidu.currency == "CNY" and {payload["currency"] for _, payload in bidu.rows} == {"CNY"}

    raw = _raw("AAPL")
    del raw["quoteSummary"]["result"][0]["earnings"]["financialCurrency"]
    assert {payload["currency"] for _, payload in svc.parse_earnings(raw, NOW).rows} == {None}


def test_발표_시각이_없거나_아직_오지_않은_분기는_넣지_않고_센다():
    raw = _raw("AAPL")
    quarters = _quarters(raw)
    del quarters[0]["reportedDate"]
    quarters[3]["reportedDate"] = _epoch("2026-10-30T20:30:00+00:00")   # NOW(10-25)보다 뒤

    parsed = svc.parse_earnings(raw, NOW)

    assert [day for day, _ in parsed.rows] == ["2026-01-29", "2026-04-30"]
    assert parsed.skipped == 2


def test_같은_날짜의_두_분기는_기간_끝이_늦은_쪽만():
    raw = _raw("AAPL")
    quarters = _quarters(raw)
    quarters[2]["reportedDate"] = quarters[1]["reportedDate"]

    rows = svc.parse_earnings(raw, NOW).rows

    assert [(day, payload["periodEnd"]) for day, payload in rows] == [
        ("2025-10-30", "2025-09-30"), ("2026-01-29", "2026-03-31"), ("2026-07-30", "2026-06-30")]


def test_earnings가_없거나_분기표가_없으면_빈_행():
    no_module = svc.parse_earnings({"quoteSummary": {"result": [{}], "error": None}}, NOW)
    assert (no_module.rows, no_module.has_module) == ([], False)
    empty = svc.parse_earnings({"quoteSummary": {"result": [], "error": None}}, NOW)
    assert (empty.rows, empty.has_module) == ([], False)

    raw = _raw("AAPL")
    del raw["quoteSummary"]["result"][0]["earnings"]["earningsChart"]
    no_chart = svc.parse_earnings(raw, NOW)
    assert (no_chart.rows, no_chart.has_module, no_chart.currency) == ([], True, "USD")


def _with_quarter(**fields) -> dict:
    raw = _raw("AAPL")
    _quarters(raw)[0].update(fields)
    return raw


def _renamed_reported(raw: dict) -> dict:
    """모든 분기의 reportedDate 칸 이름이 바뀐 응답(reportedTime) — 값은 그대로."""
    for quarter in _quarters(raw):
        quarter["reportedTime"] = quarter.pop("reportedDate")
    return raw


def _without_quarterly(raw: dict) -> dict:
    del raw["quoteSummary"]["result"][0]["earnings"]["earningsChart"]["quarterly"]
    return raw


def test_quarterly_칸이_없으면_빈_목록이_아니라_ShapeError():
    # 칸이 빠진 것을 '분기 자료 없음'으로 읽으면 모양이 바뀐 실행이 성공으로 기록됩니다(QA C-COL-1).
    with pytest.raises(svc.ShapeError, match="quarterly 없음"):
        svc.parse_earnings(_without_quarterly(_raw("AAPL")), NOW)
    # 빈 목록은 그대로 '분기 자료 없음'입니다.
    raw = _raw("AAPL")
    _quarters(raw).clear()
    assert svc.parse_earnings(raw, NOW).rows == []


def test_어느_분기에도_reportedDate_칸이_없으면_ShapeError():
    with pytest.raises(svc.ShapeError, match="reportedDate 칸이 없음"):
        svc.parse_earnings(_renamed_reported(_raw("AAPL")), NOW)


@pytest.mark.parametrize("fields", [
    {"periodEndDate": 10**13}, {"periodEndDate": 1e300}, {"reportedDate": -(10**13)},
    {"reportedDate": 10**13}, {"reportedDate": 0}, {"reportedDate": 1_761_856_200_000},   # 마지막은 밀리초로 바뀐 epoch
])
def test_epoch가_범위_밖이면_ValueError가_아니라_ShapeError(fields):
    # datetime.fromtimestamp가 ValueError·OverflowError를 내면 태스크 전체가 죽습니다 — 그 종목만의 모양 변경으로 바꿉니다(QA C-COL-2).
    with pytest.raises(svc.ShapeError, match="epoch 초 범위 밖"):
        svc.parse_earnings(_with_quarter(**fields), NOW)


@pytest.mark.parametrize("raw", [
    {}, {"quoteSummary": None}, {"quoteSummary": {"result": None, "error": None}},
    {"quoteSummary": {"result": ["x"]}}, {"quoteSummary": {"result": [{"earnings": []}]}},
    {"quoteSummary": {"result": [{"earnings": {"earningsChart": []}}]}},
    {"quoteSummary": {"result": [{"earnings": {"earningsChart": {"quarterly": {}}}}]}},
    {"quoteSummary": {"result": [{"earnings": {"earningsChart": {"quarterly": ["x"]}}}]}},
    # formatted=true로 바뀌면 숫자가 {raw, fmt} 객체로 옵니다 — 조용히 '추정치 없음'으로 읽지 않습니다.
    _with_quarter(actual={"raw": 1.85, "fmt": "1.85"}), _with_quarter(estimate="1.77"),
    _with_quarter(reportedDate="2025-10-30"), _with_quarter(estimate=True),
])
def test_모양이_다른_응답은_ShapeError(raw):
    with pytest.raises(svc.ShapeError):
        svc.parse_earnings(raw, NOW)


# ==============================================================================
# 2. 내부 호출 감시
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


def test_내부_호출은_earnings_모듈만_묻는다(monkeypatch):
    quote = _Quote(_raw("AAPL"))

    class _Ticker:
        def __init__(self, symbol):
            self._quote = quote

    monkeypatch.setattr(svc.yf, "Ticker", _Ticker)
    assert svc.fetch_earnings("AAPL") == _raw("AAPL")
    assert quote.modules == ["earnings"]


def test_내부_메서드가_없으면_InternalApiChanged(monkeypatch):
    class _Ticker:
        def __init__(self, symbol):
            pass

    monkeypatch.setattr(svc.yf, "Ticker", _Ticker)
    with pytest.raises(svc.InternalApiChanged):
        svc.fetch_earnings("AAPL")


@pytest.mark.parametrize(("error", "expected"), [
    (YFRateLimitError(), svc.RateLimited),
    (YFException("No valid modules provided, see available modules using `valid_modules`"), svc.InternalApiChanged),
    (TypeError("_fetch() got an unexpected keyword argument 'modules'"), svc.InternalApiChanged),
    (YFException("something else"), YFException),
])
def test_내부_호출_오류를_구분한다(monkeypatch, error, expected):
    class _Ticker:
        def __init__(self, symbol):
            self._quote = _Quote(error)

    monkeypatch.setattr(svc.yf, "Ticker", _Ticker)
    with pytest.raises(expected):
        svc.fetch_earnings("AAPL")


def test_yfinance는_1_7_0으로_고정한다():
    requirements = (Path(__file__).parents[1] / "requirements.txt").read_text(encoding="utf-8")
    assert "yfinance==1.7.0" in requirements.splitlines()
    assert svc.yfinance_version() == "1.7.0"


# ==============================================================================
# 3. 순서·설정 (네트워크·DB 없음)
# ==============================================================================
def test_달력에서_오늘_이하인_실적일만_고른다():
    calendar = {"earnings": {"items": {
        "PASSED": {"date": "2026-10-22"},
        "LAST": {"date": None, "lastDate": "2026-10-20", "note": "다음 일정 미정"},
        "TODAY": {"date": "2026-10-25"},
        "FUTURE": {"date": "2026-11-02"},
        "BOTH": {"date": "2026-11-02", "lastDate": "2026-10-21"},
        "BAD": {"date": "11/02/2026"}, "NOT_DICT": "x",
    }}}

    assert task_module.calendar_report_dates(calendar, TODAY) == {
        "PASSED": date(2026, 10, 22), "LAST": date(2026, 10, 20), "TODAY": date(2026, 10, 25), "BOTH": date(2026, 10, 21)}
    assert task_module.calendar_report_dates({}, TODAY) == {}
    assert task_module.calendar_report_dates({"earnings": {"items": []}}, TODAY) == {}


def test_순서는_받은_적_없음_발표_뒤_오래전에_받은_순():
    previous = {
        "FAILED_ONLY": {"fetchedAt": None, "error": "응답 없음"},
        "BROKEN": {"fetchedAt": "not a time"},
        "OLDER": {"fetchedAt": "2026-10-21T10:00:00+00:00"},
        "OLD": {"fetchedAt": "2026-10-23T10:00:00+00:00"},
        # 실적일 10-22 — 10-20에 받았으니 발표분이 없음 → ②
        "REPORTED": {"fetchedAt": "2026-10-20T15:00:00+00:00"},
        # 10-22 낮(동부 14:00)에 받음 — 장 마감 뒤 발표 전이라 ②
        "SAME_DAY": {"fetchedAt": "2026-10-22T18:00:00+00:00"},
        # UTC로는 10-23이지만 동부로는 10-22 22:00 — 날짜는 동부로 봅니다 → ②
        "LATE_UTC": {"fetchedAt": "2026-10-23T02:00:00+00:00"},
        # 실적일 다음 날(동부 10-23)에 받음 — 이미 받은 것 → ③
        "SEEN": {"fetchedAt": "2026-10-23T12:00:00+00:00", "isStale": True},
        # 실적일이 앞날 → ③
        "FUTURE": {"fetchedAt": "2026-10-25T02:00:00+00:00"},
    }
    reported = {ticker: date(2026, 10, 22) for ticker in ("REPORTED", "SAME_DAY", "LATE_UTC", "SEEN")}
    reported["FUTURE"] = date(2026, 10, 29)   # calendar_report_dates는 이런 날짜를 주지 않지만 순서도 스스로 거릅니다
    universe = ["ZNEW", "FAILED_ONLY", "BROKEN", "OLDER", "OLD", "REPORTED", "SAME_DAY", "LATE_UTC", "SEEN", "FUTURE", "ANEW"]

    assert task_module.priority_order(universe, previous, reported, TODAY) == [
        "ANEW", "ZNEW",                              # ① 처음 보는 종목(티커 순)
        "BROKEN", "FAILED_ONLY",                     # ① 받은 적 없이 실패만 한 종목(티커 순)
        "LATE_UTC", "REPORTED", "SAME_DAY",          # ② 발표가 나왔을 법한데 그 뒤로 받지 않음(티커 순)
        "OLDER", "OLD", "SEEN", "FUTURE"]            # ③ 가장 오래전에 받은 순


def test_예산_설정은_1에서_600으로_자르고_잘못된_값은_기본값(monkeypatch):
    for raw, expected in (("", 100), ("abc", 100), ("0", 1), ("-5", 1), ("5000", 600), (" 30 ", 30)):
        monkeypatch.setenv("EARNINGS_SURPRISE_BUDGET", raw)
        assert settings.earnings_surprise_budget() == expected, raw
    monkeypatch.delenv("EARNINGS_SURPRISE_BUDGET")
    assert settings.earnings_surprise_budget() == 100


def test_예산_변수는_compose와_env_example에_이름만():
    root = Path(__file__).parents[2]
    compose = (root / "docker-compose.yml").read_text(encoding="utf-8")
    assert 'EARNINGS_SURPRISE_BUDGET: "${EARNINGS_SURPRISE_BUDGET:-}"' in compose
    assert "EARNINGS_SURPRISE_BUDGET=" in (root / ".env.example").read_text(encoding="utf-8").splitlines()


def test_weekly에_등록되고_시간_상한은_weekly_상한보다_짧다():
    task = tasks.TASKS_BY_NAME["earnings_surprise"]
    assert task.speed == "weekly" and task.run is task_module.task_earnings_surprise
    assert task_module.TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["weekly"]
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 31  # v2 B3의 fsc_etf_prices·v2 B4의 kr_paper_universe·kr_paper_quotes·kr_paper_flows까지


def test_데이터셋_이름():
    assert catalog.OBS_US_EARNINGS_SURPRISE == "us.earnings_surprise"
    assert catalog.SNAP_EARNINGS_SURPRISE_STATUS == "us.earnings_surprise.status"


# ==============================================================================
# 4. 태스크 (PostgreSQL)
# ==============================================================================
UNIVERSE = ("AAPL", "BIDU", "INTC", "SPCX", "SPY", "ZZZZ")


class FakeYahoo:
    """티커 → quoteSummary 원문 / None(404) / 예외. 부른 티커를 기록합니다."""

    def __init__(self):
        self.responses: dict = {t: _raw(t) for t in ("AAPL", "BIDU", "INTC", "SPCX")}
        self.calls: list[str] = []
        fake = self

        class _Ticker:
            def __init__(self, symbol):
                fake.calls.append(symbol)
                self._quote = _Quote(fake.responses.get(symbol))

        self.Ticker = _Ticker


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.delenv("EARNINGS_SURPRISE_BUDGET", raising=False)
    monkeypatch.setattr(paper_universe, "tradable", lambda: UNIVERSE)
    yahoo = FakeYahoo()
    monkeypatch.setattr(svc.yf, "Ticker", yahoo.Ticker)
    clock = {"now": NOW, "mono": 0.0}
    monkeypatch.setattr(task_module, "_now", lambda: clock["now"])
    monkeypatch.setattr(task_module, "_clock", lambda: clock["mono"])
    monkeypatch.setattr(task_module, "_sleep", lambda seconds: None)
    assert "SPY" in indicators.PAPER_ETFS
    return {"yahoo": yahoo, "clock": clock}


def _status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_EARNINGS_SURPRISE_STATUS).payload


def _rows(store, ticker: str | None = None) -> list[tuple[str, str, dict]]:
    with store.connection() as conn:
        rows = conn.execute(
            "SELECT entity, obs_date, payload FROM observations WHERE dataset = %s ORDER BY entity, obs_date",
            (catalog.OBS_US_EARNINGS_SURPRISE,),
        ).fetchall()
    return [(r["entity"], r["obs_date"].isoformat(), r["payload"]) for r in rows if ticker in (None, r["entity"])]


def _later(env, hours: float) -> None:
    env["clock"]["now"] = env["clock"]["now"] + timedelta(hours=hours)


def test_유니버스_종목의_분기를_쌓고_상태를_남긴다(store, env):
    env["yahoo"].responses["ZZZZ"] = None

    detail = task_module.task_earnings_surprise()

    assert env["yahoo"].calls == ["AAPL", "BIDU", "INTC", "SPCX", "ZZZZ"], "ETF(SPY)는 묻지 않고, 처음 보는 종목은 티커 순"
    aapl = _rows(store, "AAPL")
    assert [day for _, day, _ in aapl] == ["2025-10-30", "2026-01-29", "2026-04-30", "2026-07-30"]
    assert aapl[0][2] == {"periodEnd": "2025-09-30", "actual": 1.85, "estimate": 1.76993, "surprisePct": 4.52,
                          "currency": "USD", "smallBase": False, "reportedAt": "2025-10-30T16:30:00-04:00",
                          "source": svc.SOURCE}
    assert {payload["currency"] for _, _, payload in _rows(store, "BIDU")} == {"CNY"}
    assert len(_rows(store)) == 15

    status = _status(store)
    assert {k: status[k] for k in ("generatedAt", "universe", "covered", "withEstimate4", "budget",
                                   "fetchedThisRun", "failedThisRun")} == {
        "generatedAt": NOW.isoformat(), "universe": 5, "covered": 4, "withEstimate4": 3, "budget": 100,
        "fetchedThisRun": 4, "failedThisRun": 1}
    assert "stoppedReason" not in status and "1.7.0" in status["source"]
    assert status["items"]["AAPL"] == {"fetchedAt": NOW.isoformat(), "rows": 4, "latestReported": "2026-07-30"}
    assert status["items"]["SPCX"]["rows"] == 3   # 추정치 있는 분기 2개 — withEstimate4에 들지 않음
    zzzz = status["items"]["ZZZZ"]
    assert zzzz["fetchedAt"] is None and "404" in zzzz["error"] and (zzzz["rows"], zzzz["latestReported"]) == (0, None)
    assert "SPY" not in status["items"]

    assert detail.startswith("4/5종목 갱신(예산 100, 행 15개) · 서프라이즈 있음 4/5, 추정치 4분기 이상 3, 실패 1종목"), detail


def test_run_task로_돌면_성공으로_기록된다(store, env):
    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["earnings_surprise"])

    assert ok is True, detail
    assert store.read_task_history("earnings_surprise")[0]["status"] == "ok"


def test_예산만큼만_묻고_다음_실행은_받지_않은_종목부터(store, env, monkeypatch):
    monkeypatch.setenv("EARNINGS_SURPRISE_BUDGET", "2")
    env["yahoo"].responses["ZZZZ"] = None

    detail = task_module.task_earnings_surprise()
    assert env["yahoo"].calls == ["AAPL", "BIDU"]
    assert "예산 소진 — 아직 받지 않았거나 새 실적이 나왔을 3종목은 다음 실행" in detail and "stoppedReason" not in _status(store)

    env["yahoo"].calls.clear()
    _later(env, 12)
    task_module.task_earnings_surprise()
    assert env["yahoo"].calls == ["INTC", "SPCX"]
    assert sorted(_status(store)["items"]) == ["AAPL", "BIDU", "INTC", "SPCX"]

    env["yahoo"].calls.clear()
    _later(env, 12)
    task_module.task_earnings_surprise()
    # 처음 보는 ZZZZ(404) 다음은 가장 오래전에 받은 AAPL
    assert env["yahoo"].calls == ["ZZZZ", "AAPL"]

    env["yahoo"].calls.clear()
    _later(env, 12)
    task_module.task_earnings_surprise()
    # 받은 적 없이 실패만 한 ZZZZ는 계속 앞(①)에 서지만, 그다음은 오래전에 받은 순으로 나아갑니다.
    assert env["yahoo"].calls == ["ZZZZ", "BIDU"]


def test_다_받은_뒤의_예산_소진은_남은_종목을_다음_실행이라_하지_않는다(store, env, monkeypatch):
    env["yahoo"].responses["ZZZZ"] = _raw("AAPL")
    task_module.task_earnings_surprise()   # 예산 100 — 다섯 종목을 모두 받음
    monkeypatch.setenv("EARNINGS_SURPRISE_BUDGET", "2")
    _later(env, 12)

    detail = task_module.task_earnings_surprise()

    # 남은 세 종목은 이미 받았고 오래된 순으로 다시 받을 뿐 — '다음 실행'에 받아야 할 종목이 아닙니다.
    assert "다음 실행" not in detail, detail
    assert "예산 소진 — 남은 3종목은 이미 받음" in detail, detail


def test_실적일이_지났는데_그_뒤로_받지_않은_종목을_먼저_묻는다(store, env, monkeypatch):
    env["yahoo"].responses["ZZZZ"] = _raw("AAPL")
    task_module.task_earnings_surprise()   # 10-25에 다섯 종목 모두 받음
    store.put_snapshot(catalog.SNAP_US_CALENDAR, {"generatedAt": NOW.isoformat(), "earnings": {"items": {
        "INTC": {"date": "2026-10-29", "session": "AMC"},          # 10-29 장 마감 뒤 발표
        "AAPL": {"date": "2026-11-02", "session": "AMC"},          # 아직 앞날
    }}})
    monkeypatch.setenv("EARNINGS_SURPRISE_BUDGET", "1")
    env["yahoo"].calls.clear()
    env["clock"]["now"] = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)   # 동부 10-30 08:00

    detail = task_module.task_earnings_surprise()

    assert env["yahoo"].calls == ["INTC"], "다른 종목은 받은 시각이 같아 티커 순이면 AAPL이 먼저였음"
    assert "실적 발표 뒤 우선 1" in detail

    env["yahoo"].calls.clear()
    _later(env, 6)   # 같은 동부 날짜(10-30)에 다시 — INTC는 실적일 다음 날 받았으니 더는 앞에 두지 않음
    task_module.task_earnings_surprise()
    assert env["yahoo"].calls == ["AAPL"]


def test_429면_그_실행을_멈추고_받은_만큼_저장한다(store, env):
    env["yahoo"].responses["BIDU"] = YFRateLimitError()

    detail = task_module.task_earnings_surprise()

    assert env["yahoo"].calls == ["AAPL", "BIDU"]
    status = _status(store)
    assert status["stoppedReason"] == "Yahoo 429(요청 제한)로 멈춤 — 4종목은 다음 실행"
    assert sorted(status["items"]) == ["AAPL"], "429는 그 종목의 실패가 아니라 상태 줄을 만들지 않습니다"
    assert (status["fetchedThisRun"], status["failedThisRun"]) == (1, 0)
    assert "Yahoo 429" in detail and len(_rows(store)) == 4


def test_첫_요청부터_429면_EmptyResult(store, env):
    env["yahoo"].responses["AAPL"] = YFRateLimitError()

    with pytest.raises(EmptyResult) as exc:
        task_module.task_earnings_surprise()

    assert "0/1종목" in str(exc.value) and "Yahoo 429" in str(exc.value)
    assert store.read_snapshot(catalog.SNAP_EARNINGS_SURPRISE_STATUS) is None and _rows(store) == []


def test_내부_메서드가_없으면_EmptyResult이고_행과_상태를_그대로_둔다(store, env, monkeypatch):
    task_module.task_earnings_surprise()
    before_status, before_rows = _status(store), _rows(store)

    class _NoQuote:
        def __init__(self, symbol):
            pass

    monkeypatch.setattr(svc.yf, "Ticker", _NoQuote)
    _later(env, 12)
    with pytest.raises(EmptyResult) as exc:
        task_module.task_earnings_surprise()

    assert str(exc.value).startswith("yfinance 내부 API 변경 — Ticker._quote._fetch 없음")
    assert "1.7.0" in str(exc.value)
    assert _status(store) == before_status and _rows(store) == before_rows


def test_응답_5건_이상에_earnings가_없으면_내부_API_변경으로_멈춘다(store, env):
    task_module.task_earnings_surprise()
    before_status, before_rows = _status(store), _rows(store)
    env["yahoo"].responses = {t: {"quoteSummary": {"result": [{}], "error": None}} for t in UNIVERSE}
    _later(env, 12)

    with pytest.raises(EmptyResult) as exc:
        task_module.task_earnings_surprise()

    assert "yfinance 내부 API 변경 — 응답 5건 모두 earnings가 없거나 모양이 다름" in str(exc.value)
    assert _status(store) == before_status and _rows(store) == before_rows


def _without_chart(raw: dict) -> dict:
    del raw["quoteSummary"]["result"][0]["earnings"]["earningsChart"]
    return raw


def _null_reported(raw: dict) -> dict:
    for quarter in _quarters(raw):
        quarter["reportedDate"] = None
    return raw


@pytest.mark.parametrize(("change", "message"), [
    (_renamed_reported, "응답 5건 모두 earnings가 없거나 모양이 다름"),
    (_without_quarterly, "응답 5건 모두 earnings가 없거나 모양이 다름"),
    (_without_chart, "응답 5건 모두 발표 시각이 있는 지난 분기가 없음"),
    (_null_reported, "응답 5건 모두 발표 시각이 있는 지난 분기가 없음"),
])
def test_earnings_안쪽이_모두_비거나_이름이_바뀌면_내부_API_변경으로_멈춘다(store, env, change, message):
    # QA C-COL-1: earnings 키는 있는데 안쪽이 비면 'n/n종목 갱신(행 0개)'으로 성공 처리되어 받은 시각이 모두 새로 찍혔습니다.
    task_module.task_earnings_surprise()
    before_status, before_rows = _status(store), _rows(store)
    env["yahoo"].responses = {t: change(_raw("AAPL")) for t in UNIVERSE}
    _later(env, 12)

    with pytest.raises(EmptyResult) as exc:
        task_module.task_earnings_surprise()

    assert f"yfinance 내부 API 변경 — {message}" in str(exc.value)
    assert _status(store) == before_status and _rows(store) == before_rows


def test_한_종목의_범위_밖_epoch는_그_종목만_실패하고_나머지는_저장한다(store, env):
    # QA C-COL-2: 전에는 ValueError로 실행 전체가 죽어 나머지 종목의 행·상태가 하나도 쓰이지 않았습니다.
    _quarters(env["yahoo"].responses["BIDU"])[0]["periodEndDate"] = 10**13

    detail = task_module.task_earnings_surprise()

    status = _status(store)
    assert (status["fetchedThisRun"], status["failedThisRun"]) == (3, 2)
    bidu = status["items"]["BIDU"]
    assert bidu["fetchedAt"] is None and "periodEndDate가 epoch 초 범위 밖" in bidu["error"]
    assert _rows(store, "BIDU") == [] and len(_rows(store)) == 11   # AAPL 4 + INTC 4 + SPCX 3
    assert status["items"]["AAPL"]["fetchedAt"] == NOW.isoformat()
    assert detail.startswith("3/5종목 갱신"), detail


def test_읽다_난_그_밖의_값_오류도_그_종목만_실패로_센다(store, env, monkeypatch):
    original = svc.parse_earnings

    def parse(raw, now):
        if raw.get("boom"):
            raise OverflowError("timestamp out of range for platform time_t")
        return original(raw, now)

    monkeypatch.setattr(svc, "parse_earnings", parse)
    env["yahoo"].responses["BIDU"] = {"boom": True}

    task_module.task_earnings_surprise()

    status = _status(store)
    assert (status["fetchedThisRun"], status["failedThisRun"]) == (3, 2)
    assert "응답을 읽지 못함" in status["items"]["BIDU"]["error"]


def test_응답_모양이_모두_바뀌어도_내부_API_변경으로_멈춘다(store, env):
    env["yahoo"].responses = {t: _with_quarter(actual={"raw": 1.0, "fmt": "1.00"}) for t in UNIVERSE}

    with pytest.raises(EmptyResult) as exc:
        task_module.task_earnings_surprise()

    assert "yfinance 내부 API 변경" in str(exc.value)
    assert _rows(store) == []


def test_추정치_4분기_이상은_행이_아니라_분기로_센다(store, env):
    # QA C-STATUS-1: 발표일이 바뀐 분기는 같은 periodEnd로 두 행이 됩니다 — 행으로 세면 3분기뿐인 AAPL이 '4분기 이상'에 들었지만
    # 패킷(EarningsHistory)은 분기마다 한 행만 싣습니다. 분기 말을 모르는 행(INTC)은 묶지 않고 한 행씩 셉니다(백엔드와 같음).
    aapl = env["yahoo"].responses["AAPL"]
    quarters = _quarters(aapl)
    quarters[0] = {**quarters[1], "reportedDate": quarters[1]["reportedDate"] + 86_400}
    for quarter in _quarters(env["yahoo"].responses["INTC"]):
        del quarter["periodEndDate"]

    task_module.task_earnings_surprise()

    status = _status(store)
    assert [payload["periodEnd"] for _, _, payload in _rows(store, "AAPL")] == [
        "2025-12-31", "2025-12-31", "2026-03-31", "2026-06-30"]
    assert status["items"]["AAPL"]["rows"] == 4, "rows는 저장 행 수 그대로"
    assert {payload["periodEnd"] for _, _, payload in _rows(store, "INTC")} == {None}
    assert status["withEstimate4"] == 2, "BIDU·INTC — AAPL은 추정치 있는 분기가 3개"


def test_나중에_받은_값이_추정치를_채우면_덮어쓰고_빠진_옛_분기는_지우지_않는다(store, env):
    task_module.task_earnings_surprise()
    assert _rows(store, "SPCX")[0][2]["estimate"] is None

    later = _raw("SPCX")
    quarters = _quarters(later)
    quarters[0].update({"estimate": -1.5})                              # 비어 있던 추정치를 채움
    later_quarters = quarters[1:] + [{**quarters[2], "date": "4Q2026", "actual": 0.4, "estimate": 0.3,
                                      "periodEndDate": _epoch("2026-12-31T00:00:00+00:00"),
                                      "reportedDate": _epoch("2027-02-04T21:01:00+00:00")}]
    env["yahoo"].responses["SPCX"] = later
    _later(env, 12)
    task_module.task_earnings_surprise()
    first = _rows(store, "SPCX")[0][2]
    assert (first["estimate"], first["surprisePct"], first["smallBase"]) == (-1.5, 15.33, False)

    # 응답이 1Q2026을 더 주지 않고 새 분기를 줌 — 옛 행은 남고 새 행이 더해집니다(출처가 4분기만 줘 쌓아야 8분기).
    quarters[:] = later_quarters
    env["clock"]["now"] = datetime(2027, 2, 10, 12, 0, tzinfo=timezone.utc)
    task_module.task_earnings_surprise()
    assert [day for _, day, _ in _rows(store, "SPCX")] == ["2026-05-07", "2026-08-04", "2026-10-20", "2027-02-04"]
    assert _status(store)["items"]["SPCX"] == {"fetchedAt": env["clock"]["now"].isoformat(), "rows": 4,
                                               "latestReported": "2027-02-04"}
    assert _rows(store, "SPCX")[0][2]["estimate"] == -1.5


def test_일부_실패는_그_종목만_이전_값을_isStale로_잇고_행은_그대로(store, env):
    env["yahoo"].responses["ZZZZ"] = _raw("AAPL")
    task_module.task_earnings_surprise()
    rows_before = _rows(store, "AAPL")
    env["yahoo"].responses["AAPL"] = RuntimeError("boom")
    _later(env, 12)

    detail = task_module.task_earnings_surprise()

    aapl = _status(store)["items"]["AAPL"]
    assert aapl["isStale"] is True and "boom" in aapl["staleReason"]
    assert (aapl["fetchedAt"], aapl["rows"], aapl["latestReported"]) == (NOW.isoformat(), 4, "2026-07-30")
    assert _status(store)["items"]["BIDU"]["fetchedAt"] == env["clock"]["now"].isoformat()
    assert _rows(store, "AAPL") == rows_before
    assert "실패 1종목 · 이전 값 1개(AAPL)" in detail, detail


def test_이어받은_지_3일이_지나면_오류_줄만_남고_행은_그대로(store, env):
    env["yahoo"].responses["ZZZZ"] = _raw("AAPL")
    task_module.task_earnings_surprise()
    payload = _status(store)
    payload["items"]["AAPL"].update({"isStale": True, "staleReason": "x",
                                     "staleSince": (datetime.now(timezone.utc) - timedelta(days=4)).isoformat()})
    store.put_snapshot(catalog.SNAP_EARNINGS_SURPRISE_STATUS, payload)
    env["yahoo"].responses["AAPL"] = None
    _later(env, 12)

    task_module.task_earnings_surprise()

    aapl = _status(store)["items"]["AAPL"]
    assert aapl["fetchedAt"] is None and "404" in aapl["error"] and "isStale" not in aapl
    assert (aapl["rows"], aapl["latestReported"]) == (4, "2026-07-30")
    assert _status(store)["covered"] == 5


def test_전부_실패하면_EmptyResult이고_저장본을_그대로_둔다(store, env):
    task_module.task_earnings_surprise()
    before_status, before_rows = _status(store), _rows(store)
    env["yahoo"].responses = {}
    _later(env, 12)

    with pytest.raises(EmptyResult) as exc:
        task_module.task_earnings_surprise()

    assert "0/5종목 — 기존 저장본 유지" in str(exc.value) and "404" in str(exc.value)
    assert _status(store) == before_status and _rows(store) == before_rows


def test_받은_뒤_직전에_받은_종목이_연속_5번_실패하면_나머지는_다음_실행(store, env, monkeypatch):
    universe = ("AAPL",) + tuple(f"G{i}" for i in range(1, 8))
    monkeypatch.setattr(paper_universe, "tradable", lambda: universe)
    env["yahoo"].responses.update({ticker: _raw("AAPL") for ticker in universe})
    task_module.task_earnings_surprise()
    # 다음 실행: AAPL만 받히고 G1~G7은 실패 — G1~G5에서 멈춥니다.
    env["yahoo"].responses.update({ticker: None for ticker in universe if ticker != "AAPL"})
    env["yahoo"].calls.clear()
    _later(env, 12)

    detail = task_module.task_earnings_surprise()

    assert env["yahoo"].calls == ["AAPL", "G1", "G2", "G3", "G4", "G5"]
    assert _status(store)["stoppedReason"] == "연속 실패 5회로 멈춤 — 2종목은 다음 실행"
    assert "연속 실패 5회로 멈춤" in detail
    # 그다음 실행: 이어받은 줄(G1~G5)의 실패는 세지 않아 멈추지 않고 G6·G7까지 묻습니다.
    env["yahoo"].calls.clear()
    _later(env, 12)
    task_module.task_earnings_surprise()
    assert sorted(env["yahoo"].calls) == sorted(universe)
    assert "stoppedReason" not in _status(store)


def test_늘_실패하는_종목이_앞에_서도_실행을_멈추지_않는다(store, env, monkeypatch):
    # 받은 적 없는 종목, 그리고 아직 한 종목도 받지 못한 동안의 실패는 세지 않습니다 — 세면 매 실행이 같은 자리에서 멈춥니다.
    universe = tuple(f"BAD{i}" for i in range(1, 7)) + ("ZOK",)
    monkeypatch.setattr(paper_universe, "tradable", lambda: universe)
    env["yahoo"].responses["ZOK"] = _raw("AAPL")

    task_module.task_earnings_surprise()

    assert env["yahoo"].calls == list(universe)
    status = _status(store)
    assert status["fetchedThisRun"] == 1 and status["failedThisRun"] == 6 and "stoppedReason" not in status


def test_시간_상한을_넘으면_새_요청을_보내지_않는다(store, env, monkeypatch):
    original = svc.fetch_earnings

    def slow(ticker):
        env["clock"]["mono"] += 700.0
        return original(ticker)

    monkeypatch.setattr(svc, "fetch_earnings", slow)
    detail = task_module.task_earnings_surprise()

    assert env["yahoo"].calls == ["AAPL", "BIDU"]
    assert _status(store)["stoppedReason"] == "시간 상한(1200초) — 3종목은 다음 실행"
    assert "시간 상한(1200초)" in detail


def test_저장본이_없으면_누락_데이터셋에_보인다(store):
    assert catalog.SNAP_EARNINGS_SURPRISE_STATUS in {entry["name"] for entry in store.missing_datasets()}
