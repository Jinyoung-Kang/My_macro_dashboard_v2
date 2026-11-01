"""
tests/test_kr_paper_timed.py
한국 Claude 계좌2 시각 지정 체결 1분봉 kr_paper_timed → paper.kr.timed(계약 1, 단계 2a). 저장은 PostgreSQL, 토스는 가짜.

고정하는 규칙
  1. 범위는 계좌2의 매시·종가 대기 주문(종목, 기준 거래일) — 목표 세션 E = 다음 KR 거래일, E 15:40 KST 전에는 부르지 않는다.
  2. 저장본 = 세션 → 종목 → 창(라벨 hh:01~hh:05)·창 뒤 첫 거래 봉·마감 봉(15:30·15:31·16:30·16:31 있는 것만), 봉이 없으면 NO_BARS.
  3. OK·NO_BARS는 다시 받지 않고, 실패(FAILED)는 다음 주기에 그 종목만 다시. 16:36부터 거슬러 쪽을 넘기고 E 10:00 전에 닿으면 멈춘다.
  4. 받을 것이 없으면 EmptyResult(저장본 그대로).
  5. 계좌·시점 글자는 백엔드 PaperBooks와 같다.
"""
from __future__ import annotations

import re
from datetime import date, datetime
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


def _orders(monkeypatch, rows):
    monkeypatch.setattr(kr_paper_timed.store, "kr_timed_orders", lambda books, timings: list(rows))


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
    for timing in kr_paper_timed.KR_TIMED_TIMINGS:
        assert f'"{timing}"' in books, timing
    datasets = (ROOT / "backend/src/main/java/com/macrodash/store/Datasets.java").read_text(encoding="utf-8")
    assert f'SNAP_KR_PAPER_TIMED = "{catalog.SNAP_KR_PAPER_TIMED}"' in datasets
