"""
tests/test_paper_live.py
🧪 모의 매매 장중 평가 태스크 paper_live_us·paper_live_kr (보유 종목 읽기는 PostgreSQL 필요).

고정하는 규칙
  1. 범위 = 그 시장의 출발한 계좌들이 지금 보유한 종목(백엔드 표 paper_positions를 읽기만) — 출발 전 계좌·다른 시장은 뺌, 중복 없음.
  2. 저장본 모양 {market, source, scope, tickers: {T: {price, at(ISO UTC)}}, missing, error} — 백엔드 장중 평가가 이 모양을 읽습니다.
  3. 이번에 받지 못한 종목은 직전 저장본으로 잇고 isStale — 봉 시각은 그대로(백엔드가 장중 값으로 쓰지 않음).
  4. 보유가 없거나 하나도 받지 못하면 EmptyResult — 저장본을 덮지 않습니다.
  5. Yahoo 래치가 닫혀 있으면 묻지 않습니다. 0 이하·빈 봉은 버립니다(0으로 채우지 않음).
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import pandas as pd
import pytest

from app import catalog, http
from app.services import market as market_service
from app.services import toss as toss_service
from app.tasks import paper_live
from app.tasks.base import EmptyResult


def _book(store, code: str, market: str, status: str = "ACTIVE") -> None:
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
            "VALUES (%s, 'RULES', %s, 100000, %s, %s, %s, %s)",
            (code, code, None if status == "NOT_STARTED" else date(2026, 10, 23), status, market,
             "USD" if market == "US" else "KRW"),
        )


def _hold(store, book: str, ticker: str) -> None:
    now = datetime(2026, 10, 23, 20, 0, tzinfo=timezone.utc)
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_positions (book_code, ticker, qty, avg_cost, opened_on, opened_at, high_watermark, "
            "watermark_at, fill_ref_date, fill_ref_close) VALUES (%s, %s, 10, 100, %s, %s, 100, %s, %s, 100)",
            (book, ticker, date(2026, 10, 23), now, now, date(2026, 10, 23)),
        )


def test_보유_종목은_그_시장의_출발한_계좌들_것만_중복_없이(store):
    _book(store, "rules", "US")
    _book(store, "claude", "US", status="PAUSED")
    _book(store, "kr_rules", "KR")
    _book(store, "kr_claude", "KR", status="NOT_STARTED")
    _hold(store, "rules", "SPY")
    _hold(store, "rules", "AAPL")
    _hold(store, "claude", "SPY")
    _hold(store, "kr_rules", "005930")
    _hold(store, "kr_claude", "000660")  # 출발 전 계좌 — 뺌

    assert store.held_tickers("US") == ["AAPL", "SPY"]
    assert store.held_tickers("KR") == ["005930"]


def test_미국_저장본_모양과_빠진_종목_이어받기(store, monkeypatch):
    monkeypatch.setattr(store, "held_tickers", lambda market: ["AAA", "BBB"])
    store.put_snapshot(catalog.SNAP_PAPER_LIVE_US, {
        "market": "US", "tickers": {"BBB": {"price": 50.0, "at": "2026-10-29T19:59:00+00:00"}}})
    monkeypatch.setattr(market_service, "latest_minute_prices",
                        lambda tickers: ({"AAA": {"price": 101.5, "at": "2026-10-30T14:31:00+00:00"}}, "받지 못함 1개(BBB)"))

    detail = paper_live.task_paper_live_us()

    payload = store.read_snapshot(catalog.SNAP_PAPER_LIVE_US).payload
    assert payload["market"] == "US" and payload["source"] == paper_live.US_SOURCE and payload["scope"] == 2
    assert payload["tickers"]["AAA"] == {"price": 101.5, "at": "2026-10-30T14:31:00+00:00"}
    carried = payload["tickers"]["BBB"]
    assert carried["price"] == 50.0 and carried["at"] == "2026-10-29T19:59:00+00:00" and carried["isStale"] is True
    assert payload["missing"] == ["BBB"] and payload["error"] == "받지 못함 1개(BBB)"
    assert detail.startswith("1/2 종목") and "이전 값 1개(BBB)" in detail


def test_보유가_없거나_하나도_받지_못하면_저장본을_덮지_않는다(store, monkeypatch):
    monkeypatch.setattr(store, "held_tickers", lambda market: [])
    with pytest.raises(EmptyResult, match="보유 종목이 없습니다"):
        paper_live.task_paper_live_us()

    store.put_snapshot(catalog.SNAP_PAPER_LIVE_US, {"market": "US", "tickers": {"AAA": {"price": 1.0, "at": "x"}}})
    monkeypatch.setattr(store, "held_tickers", lambda market: ["AAA"])
    monkeypatch.setattr(market_service, "latest_minute_prices", lambda tickers: ({}, "거부됨 — Yahoo 429"))
    with pytest.raises(EmptyResult, match="0/1 종목 — 기존 저장본 유지"):
        paper_live.task_paper_live_us()
    assert store.read_snapshot(catalog.SNAP_PAPER_LIVE_US).payload["tickers"]["AAA"]["price"] == 1.0


def test_한국은_토스_1분봉_종가와_봉_시각(store, monkeypatch):
    monkeypatch.setattr(store, "held_tickers", lambda market: ["005930", "000660"])
    monkeypatch.setattr(paper_live, "KR_SPACING_SECONDS", 0)
    calls = []

    def fake(symbol, interval, count, *, adjusted, before=None):
        calls.append((symbol, interval, count, adjusted))
        if symbol == "000660":
            raise toss_service.TossError("HTTP 500")
        return [{"date": "2026-10-30", "time": "10:15", "open": 70900.0, "high": 71100.0, "low": 70800.0,
                 "close": 71000.0, "volume": 1200}], None

    monkeypatch.setattr(toss_service, "fetch_candles", fake)

    paper_live.task_paper_live_kr()

    assert calls == [("005930", "1m", 1, False), ("000660", "1m", 1, False)], "원시가(adjusted=false) 최신 1분봉 하나씩"
    payload = store.read_snapshot(catalog.SNAP_PAPER_LIVE_KR).payload
    assert payload["tickers"]["005930"] == {"price": 71000.0, "at": "2026-10-30T01:15:00+00:00"}, "KST 봉 시각 → UTC ISO"
    assert payload["missing"] == ["000660"] and "000660 HTTP 500" in payload["error"]


def test_한국_토스_키가_없으면_저장하지_않는다(store, monkeypatch):
    monkeypatch.setattr(store, "held_tickers", lambda market: ["005930"])

    def missing(*args, **kwargs):
        raise toss_service.TossMissingKey("TOSS_CLIENT_ID")

    monkeypatch.setattr(toss_service, "fetch_candles", missing)
    with pytest.raises(EmptyResult, match="토스 키 없음"):
        paper_live.task_paper_live_kr()
    assert store.read_snapshot(catalog.SNAP_PAPER_LIVE_KR) is None


def test_최신_1분봉_배치는_마지막_정규장_봉을_UTC로_주고_빈_봉을_버린다(monkeypatch):
    index = pd.DatetimeIndex(["2026-10-30 10:30", "2026-10-30 10:31"]).tz_localize("America/New_York")
    columns = pd.MultiIndex.from_product([["AAA", "BBB", "CCC"], ["Close", "Volume"]])
    frame = pd.DataFrame([[100.0, 1, 50.0, 1, float("nan"), 0], [101.0, 1, 0.0, 1, float("nan"), 0]],
                         index=index, columns=columns)
    seen = {}

    def fake_download(**kwargs):
        seen.update(kwargs)
        return frame

    monkeypatch.setattr(market_service.http, "active_rejection", lambda host: None)
    monkeypatch.setattr(market_service.yf, "download", fake_download)

    out, reason = market_service.latest_minute_prices(["AAA", "BBB", "CCC"])

    assert seen["interval"] == "1m" and seen["period"] == "1d" and seen["prepost"] is False
    assert out == {"AAA": {"price": 101.0, "at": "2026-10-30T14:31:00+00:00"}}, "BBB 마지막 0은 버림, CCC는 빈 봉"
    assert reason == "받지 못함 2개(BBB, CCC)"


def test_야후_래치가_닫혀_있으면_묻지_않는다(monkeypatch):
    monkeypatch.setattr(market_service.http, "active_rejection", lambda host: f"{http.REJECTED_MARK} — {host} HTTP 429"
                        if host == http.YAHOO_HOST else None)

    def boom(**kwargs):
        raise AssertionError("래치가 닫혔는데 Yahoo를 불렀습니다")

    monkeypatch.setattr(market_service.yf, "download", boom)
    out, reason = market_service.latest_minute_prices(["AAA"])
    assert out == {} and "거부됨" in reason
