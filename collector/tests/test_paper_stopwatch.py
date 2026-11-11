"""
tests/test_paper_stopwatch.py
모의 장중 스탑 감시 paper_stopwatch_us·paper_stopwatch_kr → paper.stopwatch.us·paper.stopwatch.kr(계약 1, ADR 0032). 저장은 PostgreSQL, Yahoo spark·토스는 가짜.

고정하는 규칙
  1. 설정 stopWatch.mode·kr.stopWatch.mode가 SHADOW·ON일 때만 받는다 — OFF·키 없음·설정 행 없음·다른 글자면 외부 호출 0회(통합 검토 R8).
  2. 정규장 감시 창(개장 + 4분 ~ 장 끝 여유 앞 + 1분, 한국 장 시간 변경일은 설정의 그날 개장·마감) 밖·주말·휴장·보유 없음도 호출 0회.
  3. 미국은 slow 군이 Yahoo를 쓰는 동안 쉬고(R7), 래치가 닫혀 있으면 묻지 않으며, 거부를 받으면 다음 두 회차를 쉰다. 첫 응답으로 휴장·조기 폐장을 배운다.
  4. 미국 항목: spark의 분에 맞고 완성된 봉만(진행 중인 봉은 마지막 거래 시각), 그 세션만, 첫 봉은 정규장 첫 분일 때만, 전일 종가는 previousClose.
  5. 한국: 기준 종목 → 보유 순으로 1분봉 한 쪽, 그 세션에 처음 보는 종목만 일봉 원시·수정(전일 종가), 기준 종목에 그날 봉이 없으면 호출 1회로 끝.
  6. 받지 못한 종목은 같은 세션 항목만 isStale로 잇는다. 범위·설정은 DB 실제 표를 읽기만 한다. 글자는 백엔드와 같다.
"""
from __future__ import annotations

import json
import re
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app import catalog, http, store as store_module, tasks
from app.services import toss as toss_service
from app.tasks import paper_stopwatch as sw
from app.tasks import runner
from app.tasks.base import EmptyResult, KST

NY = ZoneInfo("America/New_York")
UTC = timezone.utc
US_DAY = date(2026, 11, 9)      # 월요일
KR_DAY = date(2026, 11, 9)
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _fresh_state():
    sw.reset_state()
    yield
    sw.reset_state()


def _ny(hh: int, mm: int, ss: int = 0, day: date = US_DAY) -> datetime:
    return datetime.combine(day, time(hh, mm, ss), tzinfo=NY).astimezone(UTC)


def _kst(hh: int, mm: int, ss: int = 0, day: date = KR_DAY) -> datetime:
    return datetime.combine(day, time(hh, mm, ss), tzinfo=KST)


def _settings(store, body: dict) -> None:
    with store.connection() as conn:
        conn.execute("INSERT INTO paper_settings (id, version, body) VALUES (1, 1, %s) "
                     "ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body", (json.dumps(body),))


def _book(store, code: str, market: str, kind: str = "CLAUDE", status: str = "ACTIVE") -> None:
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
            "VALUES (%s, %s, %s, 100000, %s, %s, %s, %s)",
            (code, kind, code, date(2026, 10, 30), status, market, "USD" if market == "US" else "KRW"),
        )


def _hold(store, book: str, ticker: str) -> None:
    now = datetime(2026, 10, 30, 20, 0, tzinfo=UTC)
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_positions (book_code, ticker, qty, avg_cost, opened_on, opened_at, high_watermark, "
            "watermark_at, fill_ref_date, fill_ref_close) VALUES (%s, %s, 10, 100, %s, %s, 100, %s, %s, 100)",
            (book, ticker, date(2026, 10, 30), now, now, date(2026, 10, 30)),
        )


# ==============================================================================
# 1. 등록·이름·백엔드와 같은 글자
# ==============================================================================
def test_session_군에_두_태스크_미국은_Yahoo_작업_스레드():
    us, kr = tasks.TASKS_BY_NAME["paper_stopwatch_us"], tasks.TASKS_BY_NAME["paper_stopwatch_kr"]
    assert us.speed == kr.speed == "session"
    assert us.run is sw.task_paper_stopwatch_us and kr.run is sw.task_paper_stopwatch_kr
    assert us.yahoo and not kr.yahoo
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("paper_stopwatch_kr") == names.index("paper_stopwatch_us") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME)  # 태스크 수는 test_task_registry.py 한 곳에서 셉니다


def test_데이터셋_이름과_범위_글자는_백엔드와_같다():
    datasets = (ROOT / "backend/src/main/java/com/macrodash/store/Datasets.java").read_text(encoding="utf-8")
    assert f'SNAP_PAPER_STOPWATCH_US = "{catalog.SNAP_PAPER_STOPWATCH_US}"' in datasets
    assert f'SNAP_PAPER_STOPWATCH_KR = "{catalog.SNAP_PAPER_STOPWATCH_KR}"' in datasets
    books = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/PaperBooks.java").read_text(encoding="utf-8")
    assert f'ACTIVE = "{store_module.STOPWATCH_BOOK_STATUS}"' in books
    assert f'KIND_BENCHMARK = "{store_module.STOPWATCH_EXCLUDED_KIND}"' in books
    mode = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/StopWatchMode.java").read_text(encoding="utf-8")
    assert re.search(r"OFF, SHADOW, ON;", mode) and store_module.STOPWATCH_MODES == ("OFF", "SHADOW", "ON")
    assert 'US_KEY = "stopWatch.mode"' in mode and 'KR_KEY = "kr.stopWatch.mode"' in mode
    assert ".".join(store_module.STOPWATCH_MODE_PATHS["US"]) == "stopWatch.mode"
    assert ".".join(store_module.STOPWATCH_MODE_PATHS["KR"]) == "kr.stopWatch.mode"


# ==============================================================================
# 2. 범위·설정 읽기 (PostgreSQL)
# ==============================================================================
def _read_only(store, monkeypatch) -> None:
    @contextmanager
    def read_only():
        with store.get_pool().connection() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            yield conn

    monkeypatch.setattr(store, "connection", read_only)


def test_범위는_운용_중이고_벤치마크가_아닌_책의_보유를_시장별로_읽기만_한다(store, monkeypatch):
    _book(store, "rules", "US", kind="RULES")
    _book(store, "claude", "US")
    _book(store, "claude2", "US", status="PAUSED")
    _book(store, "bench_spy", "US", kind="BENCHMARK")
    _book(store, "kr_rules", "KR", kind="RULES")
    _hold(store, "rules", "AAPL")
    _hold(store, "claude", "NVDA")
    _hold(store, "claude", "AAPL")
    _hold(store, "claude2", "PAUSED1")
    _hold(store, "bench_spy", "SPY")
    _hold(store, "kr_rules", "005930")
    _read_only(store, monkeypatch)
    assert store.stopwatch_scope("US") == ["AAPL", "NVDA"]
    assert store.stopwatch_scope("KR") == ["005930"]


def test_설정은_세_값만_받고_그_밖은_OFF(store, monkeypatch):
    assert store.stopwatch_settings() == {"US": "OFF", "KR": "OFF", "krOpenOverrides": {}}, "설정 행 없음"
    _settings(store, {"stopWatch": {"mode": "ON"}, "kr": {"stopWatch": {"mode": "on"},
                                                          "calendar": {"openTimeOverrides": {"2026-11-19": {"open": "10:00", "close": "16:30"}}}}})
    _read_only(store, monkeypatch)
    got = store.stopwatch_settings()
    assert got["US"] == "ON" and got["KR"] == "OFF", "소문자는 세 값 밖 — OFF(백엔드 StopWatchMode와 같음)"
    assert got["krOpenOverrides"] == {"2026-11-19": {"open": "10:00", "close": "16:30"}}


# ==============================================================================
# 3. 미국 — spark 읽기(순수 함수)
# ==============================================================================
def _spark_result(symbol: str, points: list[tuple[datetime, float | None]], prev: float | None = 100.0,
                  regular: tuple[datetime, datetime] | None = None, partial: tuple[datetime, float] | None = None) -> dict:
    """2026-11-06 실측과 같은 모양 — meta·timestamp(봉 시작 epoch)·indicators.quote[0].close, 진행 중인 봉은 분에 맞지 않는 마지막 거래 시각."""
    stamps = [int(at.timestamp()) for at, _ in points]
    closes = [close for _, close in points]
    if partial:
        stamps.append(int(partial[0].timestamp()))
        closes.append(partial[1])
    regular = regular or (_ny(9, 30), _ny(16, 0))
    meta = {"currency": "USD", "symbol": symbol, "exchangeTimezoneName": "America/New_York", "regularMarketPrice": closes[-1] if closes else None,
            "chartPreviousClose": prev, "previousClose": prev, "dataGranularity": "1m", "range": "1d",
            "currentTradingPeriod": {"regular": {"timezone": "EST", "start": int(regular[0].timestamp()), "end": int(regular[1].timestamp()),
                                                 "gmtoffset": -18000}}}
    return {"symbol": symbol, "response": [{"meta": meta, "timestamp": stamps, "indicators": {"quote": [{"close": closes}]}}]}


def _minutes(start: datetime, end: datetime, base: float = 100.0, step: float = 0.1) -> list[tuple[datetime, float]]:
    out, at, i = [], start, 0
    while at <= end:
        out.append((at, round(base + step * i, 4)))
        at += timedelta(minutes=1)
        i += 1
    return out


def test_spark_줄은_종가와_시작_epoch_진행_중인_봉과_지난_세션은_빼고_첫_봉은_정규장_첫_분일_때만():
    points = _minutes(_ny(9, 30), _ny(10, 4)) + [(_ny(10, 5), None)]
    payload = {"spark": {"result": [_spark_result("AAPL", points, prev=99.5, partial=(_ny(10, 6, 34), 104.0))], "error": None}}
    series = sw.spark_series(payload)["AAPL"]
    assert series["prevClose"] == 99.5 and series["regular"] == (int(_ny(9, 30).timestamp()), int(_ny(16, 0).timestamp()))
    entry = sw.us_entry(series, _ny(10, 6, 40))
    assert entry["session"] == "2026-11-09" and entry["prevClose"] == 99.5
    starts = [bar["t"] for bar in entry["bars"]]
    assert starts[-1] == _ny(10, 4).isoformat(), "10:05 봉은 종가 없음(거래 없음), 10:06:34는 진행 중인 봉"
    assert len(starts) == 35 and set(entry["bars"][0]) == {"t", "c"}, "09:30~10:04 — BARS_KEPT(40)보다 적으면 그날 전부"
    assert entry["day"] == {"first": {"t": _ny(9, 30).isoformat(), "c": 100.0}}
    assert entry["lastBar"] == {"t": _ny(10, 4).isoformat(), "c": pytest.approx(103.4)}

    late = sw.us_entry(sw.spark_series({"spark": {"result": [_spark_result("AAPL", _minutes(_ny(9, 45), _ny(10, 0)))]}})["AAPL"], _ny(10, 2))
    assert "day" not in late, "응답이 정규장 첫 분부터가 아니면 첫 봉을 만들지 않음"
    assert sw.us_entry(sw.spark_series({"spark": {"result": [_spark_result("AAPL", [(_ny(10, 0), 1.0)])]}})["AAPL"], _ny(10, 0, 30)) is None, \
        "시작 + 60초 > 받은 시각이면 완성 봉 없음"
    assert sw.spark_series({"spark": {"result": None}}) == {}


# ==============================================================================
# 4. 미국 태스크
# ==============================================================================
class FakeSpark:
    def __init__(self):
        self.results: dict[str, dict] = {}
        self.calls: list[list[str]] = []
        self.reject = False

    def get(self, url, timeout=None, headers=None, params=None):
        assert url == sw.live_prices.YAHOO_SPARK and params["range"] == "1d" and params["interval"] == "1m"
        symbols = params["symbols"].split(",")
        assert len(symbols) <= sw.SPARK_BATCH
        self.calls.append(symbols)
        if self.reject:
            raise http.reject_host(sw.SPARK_HOST, "HTTP 429")
        results = [self.results[s] for s in symbols if s in self.results]

        class Res:
            status_code = 200

            def json(self_inner):
                return {"spark": {"result": results, "error": None}}
        return Res()


@pytest.fixture()
def spark(monkeypatch):
    fake = FakeSpark()
    monkeypatch.setattr(sw.http, "get_session", lambda: fake)
    monkeypatch.setattr(sw, "_slow_busy", lambda: False)
    return fake


def _us_clock(monkeypatch, at: datetime) -> None:
    monkeypatch.setattr(sw, "_now", lambda: at)


def _us_setup(store, mode="ON"):
    _settings(store, {"stopWatch": {"mode": mode}})
    _book(store, "rules", "US", kind="RULES")
    _hold(store, "rules", "AAPL")
    _hold(store, "rules", "MSFT")


def test_미국_OFF·키_없음이면_호출_0회(store, spark, monkeypatch):
    _book(store, "rules", "US", kind="RULES")
    _hold(store, "rules", "AAPL")
    _us_clock(monkeypatch, _ny(11, 0, 20))
    assert "호출 0회" in tasks.task_paper_stopwatch_us(), "설정 행 없음"
    _settings(store, {"stopWatch": {"mode": "OFF"}})
    assert "꺼짐" in tasks.task_paper_stopwatch_us()
    _settings(store, {"kr": {"stopWatch": {"mode": "ON"}}})
    assert "꺼짐" in tasks.task_paper_stopwatch_us(), "한국만 켬"
    assert spark.calls == []


def test_미국_창_밖·주말·보유_없음·slow_군·래치면_묻지_않는다(store, spark, monkeypatch):
    _settings(store, {"stopWatch": {"mode": "SHADOW"}})
    _us_clock(monkeypatch, _ny(11, 0, 20))
    assert "보유 없음" in tasks.task_paper_stopwatch_us()
    _book(store, "rules", "US", kind="RULES")
    _hold(store, "rules", "AAPL")
    for at in (_ny(9, 33, 59), _ny(15, 56, 1), _ny(11, 0, 20, day=date(2026, 11, 8))):
        _us_clock(monkeypatch, at)
        assert "호출 0회" in tasks.task_paper_stopwatch_us()
    _us_clock(monkeypatch, _ny(11, 15, 20))
    monkeypatch.setattr(sw, "_slow_busy", lambda: True)
    assert "slow 군" in tasks.task_paper_stopwatch_us()
    monkeypatch.setattr(sw, "_slow_busy", lambda: False)
    http.reject_host(http.YAHOO_HOST, "HTTP 429")
    with pytest.raises(EmptyResult):
        tasks.task_paper_stopwatch_us()
    assert spark.calls == []


def test_QA335_미국_Yahoo_래치가_닫혀_있으면_spark도_묻지_않고_그_사유로_저장본_유지(store, spark, monkeypatch):
    from app import yahoo

    _us_setup(store)
    _us_clock(monkeypatch, _ny(11, 0, 20))
    for _ in range(yahoo.NO_RESPONSE_LIMIT):
        yahoo._note_timeout()
    with pytest.raises(EmptyResult, match="기존 저장본 유지 \\(Yahoo 응답 없음"):
        tasks.task_paper_stopwatch_us()
    assert spark.calls == []


def test_미국_SPY_먼저_한_묶음으로_받아_저장하고_같은_세션만_잇는다(store, spark, monkeypatch):
    _us_setup(store)
    spark.results = {s: _spark_result(s, _minutes(_ny(9, 30), _ny(10, 59))) for s in ("SPY", "AAPL", "MSFT")}
    _us_clock(monkeypatch, _ny(11, 0, 20))

    detail = tasks.task_paper_stopwatch_us()

    assert spark.calls == [["SPY", "AAPL", "MSFT"]]
    payload = store.read_snapshot(catalog.SNAP_PAPER_STOPWATCH_US).payload
    assert payload["contract"] == 1 and payload["market"] == "US" and payload["barLabel"] == "START" and payload["mode"] == "ON"
    assert payload["scope"] == ["SPY", "AAPL", "MSFT"] and payload["missing"] == [] and payload["lagSeconds"] == 20
    assert payload["tickers"]["AAPL"]["day"]["first"]["t"] == _ny(9, 30).isoformat()
    assert "3/3 종목" in detail and "지연 20초" in detail

    # 다음 회차 — MSFT를 받지 못하면 같은 세션 항목을 잇고, 응답이 첫 분부터가 아닌 종목도 첫 봉을 이어받음
    spark.results = {"SPY": _spark_result("SPY", _minutes(_ny(9, 30), _ny(11, 4))),
                     "AAPL": _spark_result("AAPL", _minutes(_ny(10, 30), _ny(11, 4)))}
    _us_clock(monkeypatch, _ny(11, 5, 20))
    detail = tasks.task_paper_stopwatch_us()
    payload = store.read_snapshot(catalog.SNAP_PAPER_STOPWATCH_US).payload
    assert payload["missing"] == ["MSFT"] and payload["tickers"]["MSFT"]["isStale"] is True
    assert payload["tickers"]["AAPL"]["day"]["first"]["t"] == _ny(9, 30).isoformat(), "첫 봉은 같은 세션 직전 항목에서"
    assert "이전 값 1개" in detail

    # 다음 날 — 어제 항목은 잇지 않음
    spark.results = {"SPY": _spark_result("SPY", _minutes(_ny(9, 30, day=US_DAY + timedelta(days=1)), _ny(9, 59, day=US_DAY + timedelta(days=1))),
                                          regular=(_ny(9, 30, day=US_DAY + timedelta(days=1)), _ny(16, 0, day=US_DAY + timedelta(days=1))))}
    _us_clock(monkeypatch, _ny(10, 0, 20, day=US_DAY + timedelta(days=1)))
    tasks.task_paper_stopwatch_us()
    payload = store.read_snapshot(catalog.SNAP_PAPER_STOPWATCH_US).payload
    assert set(payload["tickers"]) == {"SPY"}, "다른 세션 항목은 잇지 않음"


def test_미국_거부를_받으면_다음_두_회차를_쉰다(store, spark, monkeypatch):
    _us_setup(store)
    spark.reject = True
    _us_clock(monkeypatch, _ny(11, 0, 20))
    with pytest.raises(EmptyResult):
        tasks.task_paper_stopwatch_us()
    http.reset_guards()
    spark.reject = False
    for clock in ((11, 5, 20), (11, 10, 20)):
        _us_clock(monkeypatch, _ny(*clock))
        assert "거부 뒤 쉼" in tasks.task_paper_stopwatch_us()
    assert len(spark.calls) == 1


def test_미국_첫_응답으로_휴장과_조기_폐장을_배운다(store, spark, monkeypatch):
    _us_setup(store)
    friday = US_DAY - timedelta(days=3)
    spark.results = {s: _spark_result(s, _minutes(_ny(9, 30, day=friday), _ny(15, 59, day=friday)),
                                      regular=(_ny(9, 30, day=friday), _ny(16, 0, day=friday))) for s in ("SPY", "AAPL", "MSFT")}
    _us_clock(monkeypatch, _ny(10, 0, 20))
    tasks.task_paper_stopwatch_us()
    _us_clock(monkeypatch, _ny(10, 5, 20))
    assert "휴장" in tasks.task_paper_stopwatch_us(), "SPY의 마지막 세션이 오늘이 아님(개장 15분 뒤) — 그날 남은 회차는 묻지 않음"
    assert len(spark.calls) == 1

    sw.reset_state()
    early = US_DAY + timedelta(days=18)   # 2026-11-27(금) 13:00 조기 폐장
    spark.results = {s: _spark_result(s, _minutes(_ny(9, 30, day=early), _ny(12, 9, day=early)),
                                      regular=(_ny(9, 30, day=early), _ny(13, 0, day=early))) for s in ("SPY", "AAPL", "MSFT")}
    _us_clock(monkeypatch, _ny(12, 10, 20, day=early))
    tasks.task_paper_stopwatch_us()
    _us_clock(monkeypatch, _ny(12, 56, 20, day=early))
    assert "창" in tasks.task_paper_stopwatch_us() and len(spark.calls) == 2, "정규장 끝 13:00 − 5분 + 1분 = 12:56 뒤는 창 밖"


@pytest.mark.xfail(strict=True, reason="QA-361: 장중 응답 한 번에 SPY 봉이 비면 그날을 휴장으로 굳혀 남은 회차를 묻지 않습니다")
def test_QA361_미국_오늘_세션을_본_뒤에는_SPY만_빈_응답으로_휴장이_되지_않는다(store, spark, monkeypatch):
    _us_setup(store)
    spark.results = {s: _spark_result(s, _minutes(_ny(9, 30), _ny(9, 59))) for s in ("SPY", "AAPL", "MSFT")}
    _us_clock(monkeypatch, _ny(10, 0, 20))
    tasks.task_paper_stopwatch_us()

    # 다음 회차 — SPY 줄은 왔는데 시계열이 빔(다른 종목은 정상). 그날 세션을 이미 봤으므로 휴장이 아닙니다.
    spark.results = {"SPY": _spark_result("SPY", []),
                     "AAPL": _spark_result("AAPL", _minutes(_ny(9, 30), _ny(10, 4))),
                     "MSFT": _spark_result("MSFT", _minutes(_ny(9, 30), _ny(10, 4)))}
    _us_clock(monkeypatch, _ny(10, 5, 20))
    tasks.task_paper_stopwatch_us()

    spark.results = {s: _spark_result(s, _minutes(_ny(9, 30), _ny(10, 9))) for s in ("SPY", "AAPL", "MSFT")}
    _us_clock(monkeypatch, _ny(10, 10, 20))
    detail = tasks.task_paper_stopwatch_us()

    assert "휴장" not in detail and "3/3 종목" in detail
    assert len(spark.calls) == 3, "빈 SPY 한 번 뒤에도 다음 회차가 묻습니다(수정 전 2회 — 그날 남은 감시가 멈춤)"


@pytest.mark.xfail(strict=True, reason="QA-361: 재기동 뒤 첫 응답 한 번이 비어도 그날을 휴장으로 굳힙니다")
def test_QA361_미국_오늘_세션을_못_본_채_빈_SPY는_연속_두_번이어야_휴장(store, spark, monkeypatch):
    """장중 재기동 직후 — 이 프로세스는 그날 세션을 아직 보지 못했습니다. 응답의 정규장 기간은 오늘인데 SPY 봉만 빈 응답."""
    _us_setup(store)
    others = {s: _spark_result(s, _minutes(_ny(9, 30), _ny(11, 4))) for s in ("AAPL", "MSFT")}
    spark.results = {"SPY": _spark_result("SPY", []), **others}
    _us_clock(monkeypatch, _ny(11, 5, 20))
    tasks.task_paper_stopwatch_us()

    # 한 번으로는 닫지 않습니다 — 다음 회차가 묻고, 정상 응답이면 감시가 이어집니다.
    spark.results = {s: _spark_result(s, _minutes(_ny(9, 30), _ny(11, 9))) for s in ("SPY", "AAPL", "MSFT")}
    _us_clock(monkeypatch, _ny(11, 10, 20))
    assert "3/3 종목" in tasks.task_paper_stopwatch_us()
    assert len(spark.calls) == 2

    # 두 번 연속 비면 그때 닫습니다(그날 남은 회차는 묻지 않음).
    sw.reset_state()
    spark.calls.clear()
    spark.results = {"SPY": _spark_result("SPY", []), **others}
    for clock in ((11, 15, 20), (11, 20, 20)):
        _us_clock(monkeypatch, _ny(*clock))
        tasks.task_paper_stopwatch_us()
    _us_clock(monkeypatch, _ny(11, 25, 20))
    assert "휴장" in tasks.task_paper_stopwatch_us()
    assert len(spark.calls) == 2


# ==============================================================================
# 5. 한국 태스크
# ==============================================================================
def _kbar(day: date, label: str, price: float, volume: int = 100) -> dict:
    return {"date": day.isoformat(), "time": label, "open": float(price), "high": float(price) + 1, "low": float(price) - 1,
            "close": float(price) + 0.5, "volume": volume}


def _kday(until: str, day: date = KR_DAY, start: str = "09:01", with_previous: bool = False) -> list[dict]:
    out = []
    at = datetime.combine(day, datetime.strptime(start, "%H:%M").time())
    end = datetime.combine(day, datetime.strptime(until, "%H:%M").time())
    i = 0
    while at <= end:
        out.append(_kbar(day, at.strftime("%H:%M"), 1000 + i))
        at += timedelta(minutes=1)
        i += 1
    if with_previous:
        out.insert(0, _kbar(day - timedelta(days=3), "15:30", 990))
    return list(reversed(out))[:200]


class FakeToss:
    def __init__(self):
        self.minute: dict[str, list[dict]] = {}
        self.daily: dict[tuple[str, bool], list[dict]] = {}
        self.calls: list[tuple[str, str, bool]] = []
        self.errors: dict[str, Exception] = {}

    def candles(self, symbol, interval, count, *, adjusted, before=None):
        self.calls.append((symbol, interval, adjusted))
        if symbol in self.errors:
            raise self.errors[symbol]
        if interval == "1m":
            assert count == sw.KR_PAGE and adjusted is False
            return self.minute.get(symbol, []), None
        assert count == sw.KR_DAILY_PAGE
        return self.daily.get((symbol, adjusted), []), None


@pytest.fixture()
def toss(monkeypatch):
    fake = FakeToss()
    monkeypatch.setattr(sw.toss_service, "fetch_candles", fake.candles)
    monkeypatch.setattr(sw, "SPACING_SECONDS", 0)
    return fake


def _kr_clock(monkeypatch, at: datetime) -> None:
    monkeypatch.setattr(sw, "_now", lambda: at.astimezone(UTC))


def _kr_setup(store, mode="SHADOW", overrides=None):
    body = {"kr": {"stopWatch": {"mode": mode}}}
    if overrides:
        body["kr"]["calendar"] = {"openTimeOverrides": overrides}
    _settings(store, body)
    _book(store, "kr_rules", "KR", kind="RULES")
    _hold(store, "kr_rules", "005930")
    _hold(store, "kr_rules", "000660")


def _daily(code: str, raw: float, adjusted: float, day: date = KR_DAY) -> dict:
    previous = day - timedelta(days=3)
    return {(code, False): [_kbar(day, "00:00", raw + 10), _kbar(previous, "00:00", raw - 0.5)],
            (code, True): [_kbar(day, "00:00", adjusted + 10), _kbar(previous, "00:00", adjusted - 0.5)]}


def test_한국_OFF·휴장·창_밖이면_호출_0회_장_시간_변경일은_설정의_개장(store, toss, monkeypatch):
    _book(store, "kr_rules", "KR", kind="RULES")
    _hold(store, "kr_rules", "005930")
    _kr_clock(monkeypatch, _kst(10, 0, 20))
    assert "꺼짐" in tasks.task_paper_stopwatch_kr()
    _settings(store, {"kr": {"stopWatch": {"mode": "ON"}, "calendar": {"openTimeOverrides": {"2026-11-19": {"open": "10:00", "close": "16:30"}}}}})
    for at in (_kst(9, 3, 59), _kst(15, 21, 1), _kst(10, 0, 20, day=date(2026, 11, 8))):
        _kr_clock(monkeypatch, at)
        assert "호출 0회" in tasks.task_paper_stopwatch_kr()
    exam = date(2026, 11, 19)
    for at in (_kst(9, 30, 20, day=exam), _kst(16, 21, 1, day=exam)):
        _kr_clock(monkeypatch, at)
        assert "호출 0회" in tasks.task_paper_stopwatch_kr(), "수능일 10:04~16:21"
    assert toss.calls == []
    assert sw.kr_hours(exam, {"2026-11-19": {"open": "10:00", "close": "16:30"}}) == (time(10, 0), time(16, 30))
    assert sw.kr_hours(exam, {"2026-11-19": {"open": "?"}}) == (time(9, 0), time(15, 30)), "읽을 수 없는 값은 보통 날"


def test_한국_기준_종목에_그날_봉이_없으면_호출_1회로_끝(store, toss, monkeypatch):
    _kr_setup(store)
    toss.minute["069500"] = _kday("15:30", day=KR_DAY - timedelta(days=3))
    _kr_clock(monkeypatch, _kst(9, 10, 20))
    assert "호출 1회" in tasks.task_paper_stopwatch_kr()
    assert toss.calls == [("069500", "1m", False)]


def test_한국_1분봉을_먼저_받고_처음_보는_종목만_전일_종가를_받아_잇는다(store, toss, monkeypatch):
    _kr_setup(store)
    for code in ("069500", "005930", "000660"):
        toss.minute[code] = _kday("09:11", with_previous=True)
        toss.daily.update(_daily(code, 50000, 50000))
    toss.daily.update(_daily("000660", 200000, 160000))     # 권리락 아침 — 수정 종가가 원시와 다름(백엔드가 가드)
    _kr_clock(monkeypatch, _kst(9, 10, 20))

    detail = tasks.task_paper_stopwatch_kr()

    minute = [c for c in toss.calls if c[1] == "1m"]
    assert [c[0] for c in minute] == ["069500", "000660", "005930"], "기준 종목 먼저, 그다음 보유(정렬)"
    assert toss.calls.index(("000660", "1d", False)) > toss.calls.index(("005930", "1m", False)), "일봉은 1분봉을 다 받은 뒤"
    payload = store.read_snapshot(catalog.SNAP_PAPER_STOPWATCH_KR).payload
    assert payload["contract"] == 1 and payload["market"] == "KR" and payload["barLabel"] == "END" and payload["mode"] == "SHADOW"
    entry = payload["tickers"]["005930"]
    assert entry["session"] == "2026-11-09" and entry["bars"][-1]["label"] == "09:10", "09:11 봉은 진행 중(봉 끝 > 받은 시각)"
    assert entry["day"] == {"first": {"label": "09:01", "o": 1000.0}}
    assert entry["prevClose"] == {"date": "2026-11-06", "raw": 50000.0, "adjusted": 50000.0}
    assert payload["tickers"]["000660"]["prevClose"]["raw"] != payload["tickers"]["000660"]["prevClose"]["adjusted"]
    assert payload["lagSeconds"] == 20 and "호출 9회" in detail

    # 다음 회차 — 전일 종가·첫 봉은 같은 세션 항목에서 이어받아 일봉을 다시 부르지 않음(쪽이 개장 봉까지 닿지 않아도)
    toss.calls.clear()
    for code in ("069500", "005930", "000660"):
        toss.minute[code] = _kday("09:16", start="09:05")
    _kr_clock(monkeypatch, _kst(9, 15, 20))
    tasks.task_paper_stopwatch_kr()
    assert all(c[1] == "1m" for c in toss.calls) and len(toss.calls) == 3
    payload = store.read_snapshot(catalog.SNAP_PAPER_STOPWATCH_KR).payload
    assert payload["tickers"]["005930"]["day"]["first"]["label"] == "09:01"
    assert payload["tickers"]["005930"]["prevClose"]["date"] == "2026-11-06"


def test_한국_첫_봉은_쪽이_개장_봉까지_닿았을_때만():
    fetched = _kst(12, 30, 5)
    cut = sw.kr_entry(_kday("12:31", start="09:31"), fetched, "09:01")
    assert "day" not in cut and cut["bars"][-1]["label"] == "12:30"
    whole = sw.kr_entry(_kday("09:30"), _kst(9, 30, 5), "09:01")
    assert whole["day"]["first"]["label"] == "09:01"
    exam = sw.kr_entry(_kday("10:20", start="10:01"), _kst(10, 20, 5), "10:01")
    assert exam["day"]["first"]["label"] == "10:01", "수능일 개장 봉"
    assert sw.prev_close([], [], KR_DAY) is None


def test_한국_호출_상한과_403이면_멈추고_토스_키가_없으면_저장본_유지(store, toss, monkeypatch):
    _kr_setup(store)
    for code in ("069500", "005930", "000660"):
        toss.minute[code] = _kday("09:11", with_previous=True)
        toss.daily.update(_daily(code, 50000, 50000))
    monkeypatch.setattr(sw, "KR_CALL_BUDGET", 4)
    _kr_clock(monkeypatch, _kst(9, 10, 20))
    detail = tasks.task_paper_stopwatch_kr()
    assert len(toss.calls) == 3, "1분봉 3 — 일봉은 원시·수정 두 쪽을 함께 받을 예산이 없어 다음 회차에"
    assert "전일 종가 없음 3종목" in detail

    toss.calls.clear()
    monkeypatch.setattr(sw, "KR_CALL_BUDGET", 120)
    toss.errors["000660"] = toss_service.TossForbidden("403")
    _kr_clock(monkeypatch, _kst(9, 15, 20))
    detail = tasks.task_paper_stopwatch_kr()
    assert ("005930", "1m", False) not in toss.calls and "거부됨" in detail

    toss.errors = {"069500": toss_service.TossMissingKey("키 없음")}
    with pytest.raises(EmptyResult):
        tasks.task_paper_stopwatch_kr()


# ==============================================================================
# 6. slow 군 Yahoo 사용 중 표시 (R7)
# ==============================================================================
def test_slow_군이_도는_동안만_Yahoo_사용_중(monkeypatch):
    seen = []

    def fake_run_task(task, run_id=None):
        seen.append((task.name, runner.slow_yahoo_busy()))
        return True, "ok"

    monkeypatch.setattr(runner, "run_task", fake_run_task)
    monkeypatch.setattr(runner.store, "start_run", lambda group_name=None: None)
    assert runner.slow_yahoo_busy() is False
    runner.run_group("slow")
    assert seen and all(busy for _, busy in seen)
    assert runner.slow_yahoo_busy() is False, "끝나면 풂"
    seen.clear()
    runner.run_group("session")
    assert seen and not any(busy for _, busy in seen), "Yahoo slow 태스크가 없는 군은 표시하지 않음"
