"""
tests/test_kr_paper_timed.py
한국 Claude 계좌2 시각 지정 체결 1분봉 kr_paper_timed → paper.kr.timed(계약 1, 단계 2a). 저장은 PostgreSQL, 토스는 가짜.

고정하는 규칙
  1. 범위는 계좌2의 매시·종가 대기 주문(종목, 기준 거래일) — 목표 세션 E = 다음 KR 거래일, E 15:40 KST 전에는 부르지 않는다.
  2. 저장본 = 세션 → 종목 → 창(라벨 hh:01~hh:05)·창 뒤 첫 거래 봉·마감 봉(15:30·15:31·16:30·16:31 있는 것만), 봉이 없으면 NO_BARS.
  3. OK·NO_BARS는 다시 받지 않고, 실패(FAILED)는 다음 주기에 그 종목만 다시. 16:36부터 거슬러 쪽을 넘기고 E 09:01 봉에 닿으면 멈춘다.
     E 16:40(덮는 가장 늦은 마감 + 10분) 전에 받은 OK 칸은 그 뒤 한 번 더 받고, 다시 받기가 실패하면 직전 OK 칸을 덮지 않는다(QA-174).
  4. 받을 것이 없으면 EmptyResult(저장본 그대로).
  5. 계좌·시점 글자는 백엔드 PaperBooks와 같다.
  6. 장중 시장가(MARKET — 단계 2b) 대기 주문은 그 기준 분 T(생성 + 60초를 분으로 올림, KST)의 창을 같은 모양으로 더한다.
  7. 실행 감사(단계 2c): 개장 창 09:00을 늘 싣고, 한국 Claude 계좌1·2의 최근 결정 주문도 장부 몫 뒤에 받으며, 받은 칸에 필요한 창 키가 없으면 다시 받는다.
  8. 목표 세션 E가 NO_BARS면 만료 창(기준일 + 3거래일) 안의 다음 거래일도 그날 끝난 뒤 받는다(장부가 고르는 첫 관측 봉의 날 — QA-201).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from datetime import time as clock_time
from pathlib import Path

import pytest

from app import catalog, krcalendar, tasks
from app.services import toss as toss_service
from app.tasks import kr_paper_timed
from app.tasks.base import EmptyResult, KST

E = "2026-11-03"
NIGHT = datetime(2026, 11, 3, 23, 25, tzinfo=KST)
ROOT = Path(__file__).resolve().parents[2]


def _minute(day, label, open_, volume, close=None):
    return {"date": day, "time": label, "open": float(open_), "high": float(open_), "low": float(open_),
            "close": float(close if close is not None else open_), "volume": volume}


def _session(day):
    """E의 1분봉 09:01~16:36(최신순 — 토스 응답 순서) — 분마다 거래, 10:01 봉만 거래량 0, 15:31 마감 봉."""
    bars = []
    for hour in range(9, 17):
        for minute in range(0, 60):
            label = f"{hour:02d}:{minute:02d}"
            if label <= "09:00" or label > "16:36":
                continue
            volume = 0 if label == "10:01" else 100
            price = 70_000 + hour * 100 + minute
            bars.append(_minute(day, label, price, volume, close=71_500 if label == "15:31" else None))
    return list(reversed(bars))


class FakeToss:
    def __init__(self):
        self.pages: dict[tuple[str, str], list[dict]] = {}
        self.errors: dict[str, Exception] = {}
        self.calls: list[tuple[str, str]] = []

    def candles(self, symbol, interval, count, *, adjusted, before=None):
        assert interval == "1m" and adjusted is False
        self.calls.append((symbol, before))
        if symbol in self.errors:
            raise self.errors[symbol]
        bars = self.pages.get((symbol, before[:10]), [])
        cut = before[11:16]
        older = [b for b in bars if b["date"] < before[:10] or b["time"] <= cut]
        page = older[:count]
        next_before = None
        if page and len(older) > count:
            last = page[-1]
            next_before = f"{last['date']}T{last['time']}:00+09:00"
        return page, next_before


@pytest.fixture()
def toss(monkeypatch):
    fake = FakeToss()
    monkeypatch.setattr(kr_paper_timed.toss_service, "fetch_candles", fake.candles)
    monkeypatch.setattr(kr_paper_timed, "KR_TIMED_SPACING", 0)
    monkeypatch.setattr(krcalendar, "_holidays", set())
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: NIGHT)
    return fake


def _orders(monkeypatch, rows, market=(), audit=(), minute=()):
    monkeypatch.setattr(kr_paper_timed.store, "kr_timed_orders", lambda books, timings: list(rows))
    monkeypatch.setattr(kr_paper_timed.store, "kr_market_orders", lambda books: list(market))
    monkeypatch.setattr(kr_paper_timed.store, "kr_minute_orders", lambda books: list(minute))
    monkeypatch.setattr(kr_paper_timed.store, "kr_audit_orders", lambda books, days: list(audit))


def _payload(store):
    return store.read_snapshot(catalog.SNAP_KR_PAPER_TIMED).payload


def test_목표_세션의_창_창_뒤_첫_거래_봉_마감_봉을_저장한다(store, toss, monkeypatch):
    _orders(monkeypatch, [("005930", date(2026, 11, 2))])
    toss.pages[("005930", E)] = _session(E)

    detail = tasks.task_kr_paper_timed()

    payload = _payload(store)
    assert payload["contract"] == 1 and payload["source"] == "토스증권 1분봉(원시가)"
    entry = payload["sessions"][E]["005930"]
    assert entry["status"] == "OK" and entry["reason"] is None
    assert [b["label"] for b in entry["windows"]["10:00"]] == ["10:01", "10:02", "10:03", "10:04", "10:05"]
    assert entry["windows"]["10:00"][0]["volume"] == 0
    assert entry["firstAfter"]["10:00"]["label"] == "10:02"                  # 10:01은 거래량 0
    assert entry["windows"]["15:00"][0] == {"label": "15:01", "open": 71_501.0, "volume": 100}
    assert [b["label"] for b in entry["windows"]["09:00"]] == ["09:01", "09:02", "09:03", "09:04", "09:05"], "개장 창(시가 반사실)"
    assert entry["firstAfter"]["09:00"]["label"] == "09:01"
    assert entry["closes"]["15:31"] == {"close": 71_500.0, "volume": 100}
    assert set(entry["closes"]) == {"15:30", "15:31", "16:30", "16:31"}
    assert [before for _, before in toss.calls] == [f"{E}T16:36:00+09:00", f"{E}T13:17:00+09:00", f"{E}T09:58:00+09:00"][:len(toss.calls)]
    assert len(toss.calls) <= kr_paper_timed.KR_TIMED_PAGES
    assert detail.startswith("1/1")


def test_세션이_끝나기_전에는_부르지_않고_받은_것은_다시_받지_않는다(store, toss, monkeypatch):
    _orders(monkeypatch, [("005930", date(2026, 11, 3))])            # E = 11-04 — 아직 끝나지 않음
    with pytest.raises(EmptyResult):
        tasks.task_kr_paper_timed()
    assert toss.calls == []

    _orders(monkeypatch, [("005930", date(2026, 11, 2))])
    toss.pages[("005930", E)] = _session(E)
    tasks.task_kr_paper_timed()
    calls = len(toss.calls)
    with pytest.raises(EmptyResult):
        tasks.task_kr_paper_timed()
    assert len(toss.calls) == calls


def test_봉이_없으면_NO_BARS_실패는_FAILED로_다음_주기에_다시(store, toss, monkeypatch):
    _orders(monkeypatch, [("000660", date(2026, 11, 2)), ("005930", date(2026, 11, 2))])
    toss.pages[("005930", E)] = []
    toss.errors["000660"] = toss_service.TossError("HTTP 500")

    detail = tasks.task_kr_paper_timed()

    sessions = _payload(store)["sessions"][E]
    assert sessions["005930"]["status"] == "NO_BARS"
    assert sessions["000660"]["status"] == "FAILED" and "HTTP 500" in sessions["000660"]["reason"]
    assert "실패 1" in detail

    del toss.errors["000660"]
    toss.pages[("000660", E)] = _session(E)
    before = len(toss.calls)
    tasks.task_kr_paper_timed()
    assert {symbol for symbol, _ in toss.calls[before:]} == {"000660"}
    assert _payload(store)["sessions"][E]["000660"]["status"] == "OK"


def test_계좌와_시점_글자는_백엔드와_같다():
    books = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/PaperBooks.java").read_text(encoding="utf-8")
    assert re.search(r'KR_CLAUDE2 = "kr_claude2"', books)
    declared = {name: re.search(rf'static final String {name} = "([^"]+)";', books).group(1) for name in ("KR_CLAUDE2", "KR_CLAUDE", "KR_RULES")}
    assert kr_paper_timed.KR_TIMED_BOOKS == (declared["KR_CLAUDE2"], declared["KR_CLAUDE"], declared["KR_RULES"])
    assert re.search(r'static final String AT_MINUTE = "([^"]+)";', books).group(1) == kr_paper_timed.store.MINUTE_TIMING
    assert kr_paper_timed.store.MINUTE_TIMING not in kr_paper_timed.KR_TIMED_TIMINGS, "지정 시각 주문은 kr_minute_orders가 따로 읽음(시각이 주문에 있음)"
    for timing in kr_paper_timed.KR_TIMED_TIMINGS:
        assert f'"{timing}"' in books, timing
    datasets = (ROOT / "backend/src/main/java/com/macrodash/store/Datasets.java").read_text(encoding="utf-8")
    assert f'SNAP_KR_PAPER_TIMED = "{catalog.SNAP_KR_PAPER_TIMED}"' in datasets


def test_장중_시장가의_기준_분은_생성_더하기_60초를_분으로_내린_뒤_1분_뒤():
    # 백엔드 ExecutionAudit.marketTarget과 같은 식 — 늘 생성 + 60초보다 뒤(:00초 생성이면 + 2분).
    assert kr_paper_timed.market_target(datetime(2026, 11, 3, 10, 31, 0, tzinfo=KST)) == "10:33"
    assert kr_paper_timed.market_target(datetime(2026, 11, 3, 10, 31, 0, 500, tzinfo=KST)) == "10:33"
    assert kr_paper_timed.market_target(datetime(2026, 11, 3, 10, 31, 59, tzinfo=KST)) == "10:33"
    assert kr_paper_timed.market_target(datetime(2026, 11, 3, 1, 59, 30, tzinfo=timezone.utc)) == "11:01"   # UTC로 와도 KST


def test_장중_시장가_대기_주문은_그_기준_분의_창을_더한다(store, toss, monkeypatch):
    created = datetime(2026, 11, 3, 10, 31, 20, tzinfo=KST)
    _orders(monkeypatch, [("005930", date(2026, 11, 2))], market=[("005930", date(2026, 11, 2), created)])
    toss.pages[("005930", E)] = _session(E)

    tasks.task_kr_paper_timed()

    entry = _payload(store)["sessions"][E]["005930"]
    assert [b["label"] for b in entry["windows"]["10:33"]] == ["10:34", "10:35", "10:36", "10:37", "10:38"]
    assert entry["firstAfter"]["10:33"]["label"] == "10:34"
    assert {"10:00", "11:00", "15:00"} <= set(entry["windows"]), "매시 창은 그대로"


def test_분_단위_지정_시각_대기_주문은_그_지정_시각의_창을_더하고_장부_몫으로_먼저_받는다(store, toss, monkeypatch):
    # ADR 0027 — 한국 계좌1(kr_claude)의 10:47 주문과 규칙 계좌(kr_rules)의 13:05 주문. 감사 주문(035720)보다 먼저 부르고, 그 종목·세션에만 창을 더한다.
    _orders(monkeypatch, [], minute=[("005930", date(2026, 11, 2), clock_time(10, 47)), ("000660", date(2026, 11, 2), clock_time(13, 5)),
                                     ("005930", date(2026, 11, 2), clock_time(14, 20))],
            audit=[("035720", date(2026, 11, 2), "NEXT_OPEN", None)])
    for code in ("005930", "000660", "035720"):
        toss.pages[(code, E)] = _session(E)

    tasks.task_kr_paper_timed()

    assert [symbol for symbol, _ in toss.calls][:1] == ["005930"] and toss.calls[-1][0] == "035720", "장부 몫이 먼저, 감사 몫이 뒤"
    sessions = _payload(store)["sessions"][E]
    first = sessions["005930"]
    assert [b["label"] for b in first["windows"]["10:47"]] == ["10:48", "10:49", "10:50", "10:51", "10:52"]
    assert first["firstAfter"]["10:47"]["label"] == "10:48" and "14:20" in first["windows"]
    assert "13:05" in sessions["000660"]["windows"] and "10:47" not in sessions["000660"]["windows"], "그 종목의 주문 시각만"
    assert not {"10:47", "13:05", "14:20"} & set(sessions["035720"]["windows"]), "지정 시각 주문이 없는 종목은 매시 창 그대로"
    assert {"09:00", "10:00", "15:00"} <= set(first["windows"])

    # 이미 받은 칸에 새 지정 시각 창이 없으면 그 칸만 다시 받는다(장중 시장가와 같은 규칙).
    before = len(toss.calls)
    _orders(monkeypatch, [], minute=[("005930", date(2026, 11, 2), clock_time(10, 47)), ("005930", date(2026, 11, 2), clock_time(11, 11))])
    tasks.task_kr_paper_timed()
    assert {symbol for symbol, _ in toss.calls[before:]} == {"005930"}
    assert "11:11" in _payload(store)["sessions"][E]["005930"]["windows"]


def test_분_단위_지정_시각_범위는_그_계좌들의_대기_AT_MINUTE_주문만_읽는다(store):
    with store.connection() as conn:
        for code, kind in (("kr_claude2", "CLAUDE"), ("kr_claude", "CLAUDE"), ("kr_rules", "RULES"), ("kr_bench_200", "BENCHMARK")):
            conn.execute(
                "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
                "VALUES (%s, %s, %s, 100000000, %s, 'ACTIVE', 'KR', 'KRW')", (code, kind, code, date(2026, 10, 30)))
        for book, ticker, timing, status, at in (
                ("kr_claude", "005930", "AT_MINUTE", "PENDING", "10:47"), ("kr_rules", "000660", "AT_MINUTE", "PENDING", "13:05"),
                ("kr_claude2", "005930", "AT_MINUTE", "PENDING", "10:47"),      # 같은 (종목, 기준일, 시각) → 하나
                ("kr_claude2", "035720", "AT_MINUTE", "FILLED", "09:05"),       # 대기가 아님 → 뺌
                ("kr_claude2", "051910", "AT_MINUTE", "REJECTED", None),        # 거절 행(시각 없음) → 뺌
                ("kr_claude2", "066570", "AT_1100", "PENDING", None),           # 매시 → kr_timed_orders 몫
                ("kr_bench_200", "069500", "AT_MINUTE", "PENDING", "09:30")):   # 범위 밖 계좌 → 뺌
            conn.execute(
                "INSERT INTO paper_orders (book_code, ticker, side, timing, source, status, as_of_trading_date, target_local) "
                "VALUES (%s, %s, 'BUY', %s, 'CLAUDE', %s, %s, %s::time)", (book, ticker, timing, status, date(2026, 11, 2), at))
    rows = kr_paper_timed.store.kr_minute_orders(kr_paper_timed.KR_TIMED_BOOKS)
    assert rows == [("000660", date(2026, 11, 2), clock_time(13, 5)), ("005930", date(2026, 11, 2), clock_time(10, 47))]
    assert kr_paper_timed.store.kr_timed_orders(kr_paper_timed.KR_TIMED_BOOKS, kr_paper_timed.KR_TIMED_TIMINGS) == [("066570", date(2026, 11, 2))]


def test_장중_시장가_범위는_그_계좌의_대기_MARKET_주문만_읽는다(store):
    with store.connection() as conn:
        for code in ("kr_claude2", "kr_claude"):
            conn.execute(
                "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
                "VALUES (%s, 'CLAUDE', %s, 100000000, %s, 'ACTIVE', 'KR', 'KRW')", (code, code, date(2026, 10, 30)))
        for book, ticker, timing, status in (("kr_claude2", "005930", "MARKET", "PENDING"), ("kr_claude2", "000660", "MARKET", "FILLED"),
                                             ("kr_claude2", "035720", "AT_1100", "PENDING"), ("kr_claude", "051910", "MARKET", "PENDING")):
            conn.execute(
                "INSERT INTO paper_orders (book_code, ticker, side, timing, source, status, as_of_trading_date) "
                "VALUES (%s, %s, 'BUY', %s, 'CLAUDE', %s, %s)", (book, ticker, timing, status, date(2026, 11, 2)))
    rows = kr_paper_timed.store.kr_market_orders(("kr_claude2",))
    assert [(ticker, as_of) for ticker, as_of, _ in rows] == [("005930", date(2026, 11, 2))]
    assert rows[0][2].tzinfo is not None
    wide = kr_paper_timed.store.kr_market_orders(kr_paper_timed.KR_TIMED_BOOKS)
    assert [(ticker, as_of) for ticker, as_of, _ in wide] == [("005930", date(2026, 11, 2)), ("051910", date(2026, 11, 2))], \
        "계좌1(자유 시점 판 — ADR 0027)의 장중 시장가도 범위 — 끈 판은 MARKET을 내지 않음"


def test_실행_감사_주문도_장부_몫_뒤에_받는다(store, toss, monkeypatch):
    # 계좌1 시가 주문(000660)과 계좌2 체결된 장중 시장가(035720) — 장부 몫(005930)을 먼저 부르고, 감사 MARKET 주문의 기준 분 창도 싣는다.
    created = datetime(2026, 11, 3, 13, 14, 30, tzinfo=KST)
    _orders(monkeypatch, [("005930", date(2026, 11, 2))],
            audit=[("000660", date(2026, 11, 2), "NEXT_OPEN", datetime(2026, 11, 2, 22, 31, tzinfo=KST)),
                   ("035720", date(2026, 11, 2), "MARKET", created),
                   ("005930", date(2026, 11, 2), "AT_1100", datetime(2026, 11, 2, 22, 31, tzinfo=KST))])
    for code in ("005930", "000660", "035720"):
        toss.pages[(code, E)] = _session(E)

    detail = tasks.task_kr_paper_timed()

    order = []
    for symbol, _ in toss.calls:
        if symbol not in order:
            order.append(symbol)
    assert order == ["005930", "000660", "035720"], "장부 몫 먼저, 같은 종목·세션은 한 번"
    sessions = _payload(store)["sessions"][E]
    assert set(sessions) == {"005930", "000660", "035720"}
    assert [b["label"] for b in sessions["035720"]["windows"]["13:16"]] == ["13:17", "13:18", "13:19", "13:20", "13:21"]
    assert "13:16" not in sessions["000660"]["windows"]
    assert detail.startswith("3/3")


def test_예산이_모자라면_실행_감사_몫이_다음_주기로_밀린다(store, toss, monkeypatch):
    monkeypatch.setattr(kr_paper_timed, "KR_TIMED_CALL_BUDGET", 3)
    _orders(monkeypatch, [("005930", date(2026, 11, 2))],
            audit=[("000660", date(2026, 11, 2), "NEXT_OPEN", datetime(2026, 11, 2, 22, 31, tzinfo=KST))])
    for code in ("005930", "000660"):
        toss.pages[(code, E)] = _session(E)

    detail = tasks.task_kr_paper_timed()

    assert {symbol for symbol, _ in toss.calls} == {"005930"}
    assert "000660" not in _payload(store)["sessions"][E]
    assert "예산" in detail

    monkeypatch.setattr(kr_paper_timed, "KR_TIMED_CALL_BUDGET", 60)
    tasks.task_kr_paper_timed()
    assert _payload(store)["sessions"][E]["000660"]["status"] == "OK"


def test_받은_칸에_필요한_창_키가_없으면_그_칸만_다시_받는다(store, toss, monkeypatch):
    # 2c 전에 받은 칸(개장 창 09:00 없음)은 감사 주문이 있으면 한 번 다시 받고, 키가 다 있는 칸은 그대로 둔다.
    old = {"status": "OK", "reason": None, "fetchedAt": "2026-11-03T14:30:00+00:00",
           "windows": {f"{hour}:00": [] for hour in range(10, 16)}, "firstAfter": {}, "closes": {}}
    full = dict(old, windows={key: [] for key in kr_paper_timed.window_keys()})
    store.put_snapshot(catalog.SNAP_KR_PAPER_TIMED, {"contract": 1, "source": kr_paper_timed.KR_TIMED_SOURCE,
                                                     "sessions": {E: {"005930": old, "000660": full}}})
    _orders(monkeypatch, [], audit=[("005930", date(2026, 11, 2), "NEXT_OPEN", None),
                                    ("000660", date(2026, 11, 2), "NEXT_OPEN", None)])
    toss.pages[("005930", E)] = _session(E)

    tasks.task_kr_paper_timed()

    assert {symbol for symbol, _ in toss.calls} == {"005930"}
    sessions = _payload(store)["sessions"][E]
    assert "09:00" in sessions["005930"]["windows"]
    assert sessions["000660"] == full


def test_실행_감사_범위는_한국_Claude_계좌의_결정_주문_대기_또는_최근_8일(store):
    with store.connection() as conn:
        for code, market in (("kr_claude2", "KR"), ("kr_claude", "KR"), ("claude", "US")):
            conn.execute(
                "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
                "VALUES (%s, 'CLAUDE', %s, 100000000, %s, 'ACTIVE', %s, %s)",
                (code, code, date(2026, 10, 30), market, "KRW" if market == "KR" else "USD"))
        rows = (("kr_claude", "000660", "NEXT_OPEN", "CLAUDE", "FILLED", "1 day"),
                ("kr_claude2", "035720", "MARKET", "CLAUDE", "CANCELLED", "2 days"),
                ("kr_claude2", "005930", "AT_1100", "CLAUDE", "PENDING", "20 days"),     # 대기면 오래돼도
                ("kr_claude2", "051910", "NEXT_OPEN", "CLAUDE", "FILLED", "20 days"),    # 오래된 체결 — 범위 밖
                ("kr_claude2", "068270", "BACKFILL", "CLAUDE", "FILLED", "1 day"),       # 사후 체결 — 범위 밖
                ("kr_claude", "207940", "NEXT_OPEN", "STOP", "FILLED", "1 day"),         # 스탑 — 범위 밖
                ("kr_claude", "105560", "NEXT_OPEN", "CLAUDE", "REJECTED", "1 day"),     # 거절 — 범위 밖
                ("claude", "AAPL", "NEXT_OPEN", "CLAUDE", "FILLED", "1 day"))            # 미국 — 범위 밖
        for book, ticker, timing, source, status, age in rows:
            conn.execute(
                "INSERT INTO paper_orders (book_code, ticker, side, timing, source, status, as_of_trading_date, created_at) "
                "VALUES (%s, %s, 'BUY', %s, %s, %s, %s, now() - %s::interval)",
                (book, ticker, timing, source, status, date(2026, 11, 2), age))
    got = kr_paper_timed.store.kr_audit_orders(kr_paper_timed.KR_AUDIT_BOOKS, kr_paper_timed.KR_AUDIT_RECENT_DAYS)
    assert sorted((ticker, timing) for ticker, _, timing, _ in got) == [("000660", "NEXT_OPEN"), ("005930", "AT_1100"),
                                                                       ("035720", "MARKET")]
    assert all(as_of == date(2026, 11, 2) and created.tzinfo is not None for _, as_of, _, created in got)


def test_실행_감사_계좌_글자는_백엔드와_같다():
    books = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/PaperBooks.java").read_text(encoding="utf-8")
    for code in kr_paper_timed.KR_AUDIT_BOOKS:
        name = "KR_CLAUDE2" if code.endswith("2") else "KR_CLAUDE"
        assert f'{name} = "{code}"' in books, code


def _until(bars, last):
    """그 라벨까지의 봉만(그 시각에 받은 것처럼 — 장 시간 변경일 16:30 마감의 장중 저장본)."""
    return [b for b in bars if b["time"] <= last]


def test_QA174_가장_늦은_마감_더하기_10분_전에_받은_OK_칸은_그_뒤_한_번_더_받는다(store, toss, monkeypatch):
    _orders(monkeypatch, [("005930", date(2026, 11, 2))])
    toss.pages[("005930", E)] = _until(_session(E), "15:50")
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: datetime(2026, 11, 3, 15, 50, tzinfo=KST))
    tasks.task_kr_paper_timed()
    first = _payload(store)["sessions"][E]["005930"]
    assert first["status"] == "OK" and "16:31" not in first["closes"]

    toss.pages[("005930", E)] = _session(E)
    toss.calls.clear()
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: datetime(2026, 11, 3, 16, 45, tzinfo=KST))
    tasks.task_kr_paper_timed()

    assert {symbol for symbol, _ in toss.calls} == {"005930"}
    again = _payload(store)["sessions"][E]["005930"]
    assert "16:31" in again["closes"]
    assert datetime.fromisoformat(again["fetchedAt"]) >= datetime(2026, 11, 3, 16, 40, tzinfo=KST)

    toss.calls.clear()
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: datetime(2026, 11, 3, 17, 45, tzinfo=KST))
    with pytest.raises(EmptyResult):
        tasks.task_kr_paper_timed()
    assert toss.calls == [], "16:40 뒤에 받은 칸은 다시 받지 않음"


def test_QA174_다시_받기가_실패하면_직전_OK_칸을_FAILED로_덮지_않는다(store, toss, monkeypatch):
    # 창 키가 빠진 칸(2c 전)을 다시 받는 길 — 받기가 실패해도 장부가 쓰던 OK 칸은 그대로 두고 다음 주기에 다시.
    old = {"status": "OK", "reason": None, "fetchedAt": "2026-11-03T14:30:00+00:00",
           "windows": {f"{hour}:00": [] for hour in range(10, 16)}, "firstAfter": {}, "closes": {"15:31": {"close": 71_500.0, "volume": 100}}}
    store.put_snapshot(catalog.SNAP_KR_PAPER_TIMED, {"contract": 1, "source": kr_paper_timed.KR_TIMED_SOURCE,
                                                     "sessions": {E: {"005930": old}}})
    _orders(monkeypatch, [("005930", date(2026, 11, 2))])
    toss.errors["005930"] = toss_service.TossError("HTTP 500")

    with pytest.raises(EmptyResult):
        tasks.task_kr_paper_timed()

    assert toss.calls, "다시 받으려고 부름"
    assert _payload(store)["sessions"][E]["005930"] == old

def test_QA201_목표_세션이_NO_BARS면_만료_창_안의_다음_거래일도_마감_뒤_받는다(store, toss, monkeypatch):
    # 11-03을 거래소가 늦게 임시휴장으로 정함(백엔드 설정 kr.calendar.extraClosures에만 — 수집기 달력은 거래일로 앎) → 장부는 11-04 봉을 고름.
    after = "2026-11-04"
    _orders(monkeypatch, [("005930", date(2026, 11, 2))])
    toss.pages[("005930", E)] = []
    toss.pages[("005930", after)] = _session(after)
    tasks.task_kr_paper_timed()
    assert _payload(store)["sessions"][E]["005930"]["status"] == "NO_BARS"

    toss.calls.clear()
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: datetime(2026, 11, 4, 16, 45, tzinfo=KST))
    tasks.task_kr_paper_timed()

    assert {symbol for symbol, _ in toss.calls} == {"005930"}
    sessions = _payload(store)["sessions"]
    assert sessions[E]["005930"]["status"] == "NO_BARS", "E 칸은 그대로"
    assert sessions[after]["005930"]["status"] == "OK"
    assert sessions[after]["005930"]["closes"]["15:31"] == {"close": 71_500.0, "volume": 100}


def test_QA201_E에_봉이_있으면_다음_날을_받지_않고_만료_창_밖은_받지_않는다(store, toss, monkeypatch):
    # E(11-03) 봉 있음 → 11-04는 받지 않음. 11-03~11-05 모두 NO_BARS여도 만료 창(기준일 11-02 + 3거래일 = 11-05) 밖 11-06은 받지 않음.
    _orders(monkeypatch, [("005930", date(2026, 11, 2)), ("000660", date(2026, 11, 2))])
    toss.pages[("005930", E)] = _session(E)
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: datetime(2026, 11, 6, 17, 0, tzinfo=KST))
    for _ in range(4):
        try:
            tasks.task_kr_paper_timed()
        except EmptyResult:
            break

    sessions = _payload(store)["sessions"]
    assert set(sessions) == {E, "2026-11-04", "2026-11-05"}
    assert set(sessions[E]) == {"005930", "000660"}
    assert sessions["2026-11-04"].keys() == {"000660"} and sessions["2026-11-05"].keys() == {"000660"}
    assert all(sessions[day]["000660"]["status"] == "NO_BARS" for day in (E, "2026-11-04", "2026-11-05"))
    assert kr_paper_timed.target_sessions("000660", date(2026, 11, 2), sessions) == [E, "2026-11-04", "2026-11-05"]


def test_만료_창은_백엔드_주문_만료와_같다():
    rules = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/RuleBookService.java").read_text(encoding="utf-8")
    assert re.search(rf"ORDER_EXPIRY_TRADING_DAYS = {kr_paper_timed.KR_TIMED_EXPIRY_SESSIONS};", rules)


def test_QA174_다시_받은_응답에_그날_봉이_없으면_직전_OK_칸을_NO_BARS로_덮지_않는다(store, toss, monkeypatch):
    # 15:50에 받은 OK 칸(봉 있음 — 그날 거래가 있었음)을 16:45에 다시 받았는데 응답이 비면 받기 이상으로 보고 OK 칸을 그대로 둠.
    _orders(monkeypatch, [("005930", date(2026, 11, 2))])
    toss.pages[("005930", E)] = _until(_session(E), "15:50")
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: datetime(2026, 11, 3, 15, 50, tzinfo=KST))
    tasks.task_kr_paper_timed()
    first = _payload(store)["sessions"][E]["005930"]

    toss.pages[("005930", E)] = []
    monkeypatch.setattr(kr_paper_timed, "_now", lambda: datetime(2026, 11, 3, 16, 45, tzinfo=KST))
    with pytest.raises(EmptyResult):
        tasks.task_kr_paper_timed()

    assert _payload(store)["sessions"][E]["005930"] == first


# --------------------------------------------------------------------------- QA-202
# QA-174 수정이 '다시 받기 실패로 직전 OK 칸을 둔 수'를 정수 kept로 셌는데, 저장 직전의 기존 줄이 같은 이름에 잘라 낸 저장본 사전을 다시 넣어
# 결과 문구가 정상 실행마다 '(직전 OK 칸 유지 {세션: {종목: …}})'를 붙였습니다(태스크 기록 detail — 운영자가 보는 신호를 알아볼 수 없음).
def test_QA202_정상_실행의_결과_문구에는_직전_OK_칸_유지가_없다(store, toss, monkeypatch):
    _orders(monkeypatch, [("005930", date(2026, 11, 2))])
    toss.pages[("005930", E)] = _session(E)

    assert tasks.task_kr_paper_timed() == "1/1 종목·세션"


def test_QA202_다시_받기_실패가_섞이면_결과_문구가_직전_칸을_둔_수를_적는다(store, toss, monkeypatch):
    # 005930은 창 키가 빠진 OK 칸을 다시 받다 실패(직전 칸 유지), 000660은 새로 받음.
    old = {"status": "OK", "reason": None, "fetchedAt": "2026-11-03T14:30:00+00:00",
           "windows": {f"{hour}:00": [] for hour in range(10, 16)}, "firstAfter": {}, "closes": {"15:31": {"close": 71_500.0, "volume": 100}}}
    store.put_snapshot(catalog.SNAP_KR_PAPER_TIMED, {"contract": 1, "source": kr_paper_timed.KR_TIMED_SOURCE,
                                                     "sessions": {E: {"005930": old}}})
    _orders(monkeypatch, [("005930", date(2026, 11, 2)), ("000660", date(2026, 11, 2))])
    toss.errors["005930"] = toss_service.TossError("HTTP 500")
    toss.pages[("000660", E)] = _session(E)

    detail = tasks.task_kr_paper_timed()

    assert detail == "1/2 종목·세션, 실패 1(직전 OK 칸 유지 1)"
    sessions = _payload(store)["sessions"][E]
    assert sessions["005930"] == old and sessions["000660"]["status"] == "OK"


# --------------------------------------------------------------------------- QA-301
# 한국 실행 감사 몫이 분 단위 지정 시각(AT_MINUTE) 주문의 창을 싣지 않음 — 수집기 kr_audit_orders가 target_local을 읽지 않아 감사 몫은 장중 시장가
# 창만 더하고, 칸을 다시 받으면 그때의 대기 주문으로 창을 통째로 다시 만들어 체결·취소된 지정 시각 주문의 창이 사라짐(미국은 최근 8일 주문의 지정 시각을 읽음).
def _kr_minute_order(store, status: str, at: str = "10:47") -> None:
    """한국 계좌1의 지정 시각 주문 한 건(기준 거래일 11-02 → E = 11-03, 하루 전에 만듦) — 실제 DB 읽기(store.kr_audit_orders)로 범위를 받습니다."""
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
            "VALUES ('kr_claude', 'CLAUDE', 'kr_claude', 100000000, %s, 'ACTIVE', 'KR', 'KRW')", (date(2026, 10, 30),))
        conn.execute(
            "INSERT INTO paper_orders (book_code, ticker, side, timing, source, status, as_of_trading_date, target_local, created_at) "
            "VALUES ('kr_claude', '005930', 'BUY', 'AT_MINUTE', 'CLAUDE', %s, %s, %s::time, now() - interval '1 day')",
            (status, date(2026, 11, 2), at))


@pytest.mark.xfail(strict=True, reason="QA-301 재현 — 감사 몫이 지정 시각을 읽지 않음(fix(QA-301)에서 표시를 뗌)")
@pytest.mark.parametrize("status", ["FILLED", "CANCELLED"])
def test_QA301_체결되거나_취소된_지정_시각_주문의_창도_감사_몫으로_싣는다(store, toss, status):
    # FILLED — 장부가 이미 체결(대기 목록에서 빠짐). CANCELLED — 장중 판단 REPLACE가 E 15:40 전에 취소해 장부 몫으로는 창을 받은 적이 없음.
    _kr_minute_order(store, status)
    toss.pages[("005930", E)] = _session(E)

    tasks.task_kr_paper_timed()

    windows = _payload(store)["sessions"][E]["005930"]["windows"]
    assert [b["label"] for b in windows.get("10:47", [])] == ["10:48", "10:49", "10:50", "10:51", "10:52"]


@pytest.mark.xfail(strict=True, reason="QA-301 재현 — 다시 받을 때 지정 시각 창을 잃음(fix(QA-301)에서 표시를 뗌)")
def test_QA301_다시_받을_때_체결된_지정_시각_주문의_창을_잃지_않는다(store, toss):
    # 대기 중에 장부 몫으로 받은 칸(10:47 창 있음, 개장 창 09:00 없음 — 2c 전 모양)을 주문이 체결된 뒤 감사 몫이 다시 받음.
    _kr_minute_order(store, "FILLED")
    held = {"status": "OK", "reason": None, "fetchedAt": "2026-11-03T14:30:00+00:00",
            "windows": {**{f"{hour}:00": [] for hour in range(10, 16)}, "10:47": [{"label": "10:48", "open": 71_048.0, "volume": 100}]},
            "firstAfter": {}, "closes": {}}
    store.put_snapshot(catalog.SNAP_KR_PAPER_TIMED, {"contract": 1, "source": kr_paper_timed.KR_TIMED_SOURCE,
                                                     "sessions": {E: {"005930": held}}})
    toss.pages[("005930", E)] = _session(E)

    tasks.task_kr_paper_timed()

    assert toss.calls, "개장 창이 없어 다시 받음"
    windows = _payload(store)["sessions"][E]["005930"]["windows"]
    assert "09:00" in windows and "10:47" in windows
