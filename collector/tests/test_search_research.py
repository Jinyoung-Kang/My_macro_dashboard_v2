"""
tests/test_search_research.py
정보 검색 리서치 탭의 출처(services/search_research — 계약 §7-3, ADR 0041 단계 4) — 네트워크 없이 합성 값으로.

- Yahoo 투자의견 변경(yfinance ``upgrades_downgrades``): 제목 '<Firm>: <한국어 동작> <앞 등급> → <새 등급>'(앞 등급이 없으면 새 등급만),
  목표가 요약(달러), id = item_id("yahoo-grade:" + 티커 + 시각 + Firm + Action + ToGrade), 공용 거부 래치를 먼저 봄(닫혀 있으면 부르지 않음),
  429는 래치를 닫음, 이력 없음은 빈 결과, 빈 표(받지 못함)는 실패
- 네이버 증권사 리포트: 상세 화면이 쓰는 ``integration`` 응답의 ``researches``(새 네이버 경로 없음) — 날짜는 KST 00:00 ``date``
"""
from __future__ import annotations

import pandas as pd
import pytest
from yfinance.exceptions import YFDataException, YFRateLimitError

from app import http
from app.services import detail, info_text
from app.services import search_research as research


@pytest.fixture(autouse=True)
def _guards():
    http.reset_guards()
    yield
    http.reset_guards()


def _grades(rows):
    frame = pd.DataFrame(rows)
    frame["GradeDate"] = pd.to_datetime(frame["GradeDate"])
    return frame.set_index("GradeDate")


GRADES = [
    {"GradeDate": "2026-11-13 12:30:00", "Firm": "Synthetic Securities", "ToGrade": "Overweight", "FromGrade": "Neutral",
     "Action": "up", "priceTargetAction": "Raises", "currentPriceTarget": 175.0, "priorPriceTarget": 150.0},
    {"GradeDate": "2026-11-10 09:00:00", "Firm": "Example Capital", "ToGrade": "Buy", "FromGrade": "",
     "Action": "init", "priceTargetAction": "Announces", "currentPriceTarget": 210.5, "priorPriceTarget": 0.0},
    {"GradeDate": "2026-10-01 00:00:00", "Firm": "Sample Partners", "ToGrade": "Hold", "FromGrade": "Hold",
     "Action": "hold", "priceTargetAction": "", "currentPriceTarget": float("nan"), "priorPriceTarget": float("nan")},
    {"GradeDate": "2026-09-01 00:00:00", "Firm": "", "ToGrade": "Buy", "FromGrade": "", "Action": "main"},
]


def test_투자의견_변경_줄():
    items = research.grade_items(research.grade_rows(_grades(GRADES)), "SCHP")
    assert [item["title"] for item in items] == ["Synthetic Securities: 상향 Neutral → Overweight", "Example Capital: 신규 Buy",
                                                 "Sample Partners: hold Hold → Hold"], "모르는 동작은 원문, 회사가 없는 줄은 뺌"
    first = items[0]
    assert first["kind"] == "research" and first["source"] == "yahoo_research" and first["lang"] == "en"
    assert first["publisher"] == "Synthetic Securities" and first["publisherDomain"] == "finance.yahoo.com"
    assert first["url"] == "https://finance.yahoo.com/quote/SCHP/analysis/"
    assert first["publishedAt"] == "2026-11-13T12:30:00+00:00" and first["timeBasis"] == "published"
    assert first["summary"] == "목표가 $150 → $175"
    assert first["id"] == info_text.item_id("yahoo-grade:SCHP:2026-11-13T12:30:00+00:00:Synthetic Securities:up:Overweight")
    assert items[1]["summary"] == "목표가 $210.50", "앞 목표가가 없으면 새 목표가만"
    assert items[2]["summary"] is None
    assert len({item["id"] for item in items}) == 3


@pytest.mark.parametrize("action,word", [("up", "상향"), ("down", "하향"), ("main", "유지"), ("init", "신규"), ("reit", "재개")])
def test_동작은_한국어로(action, word):
    rows = [dict(GRADES[0], Action=action)]
    assert research.grade_items(research.grade_rows(_grades(rows)), "SCHP")[0]["title"].startswith(f"Synthetic Securities: {word} ")


class Ticker:
    def __init__(self, value):
        self.value = value

    @property
    def upgrades_downgrades(self):
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


def test_Yahoo는_래치가_닫혀_있으면_부르지_않는다(monkeypatch):
    monkeypatch.setattr(research, "_ticker", lambda symbol: pytest.fail("부르면 안 됩니다"))
    http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")
    out = research.yahoo_grades("SCHP")
    assert out.error.startswith(http.REJECTED_MARK) and out.items == []


def test_Yahoo_요청_제한은_래치를_닫는다(monkeypatch):
    monkeypatch.setattr(research, "_ticker", lambda symbol: Ticker(YFRateLimitError()))
    out = research.yahoo_grades("SCHP")
    assert out.error.startswith(http.REJECTED_MARK)
    assert http.latch_remaining(http.YAHOO_HOST) is not None


def test_Yahoo_이력_없음은_빈_결과_빈_표는_받지_못함(monkeypatch):
    monkeypatch.setattr(research, "_ticker", lambda symbol: Ticker(YFDataException("No upgrade/downgrade history found for SCHP")))
    out = research.yahoo_grades("SCHP")
    assert out.error is None and out.items == []
    monkeypatch.setattr(research, "_ticker", lambda symbol: Ticker(pd.DataFrame()))
    out = research.yahoo_grades("SCHP")
    assert out.error and "finance.yahoo.com" in out.error
    monkeypatch.setattr(research, "_ticker", lambda symbol: Ticker(RuntimeError("boom /v10/finance/quoteSummary/SCHP")))
    out = research.yahoo_grades("SCHP")
    assert out.error == "finance.yahoo.com RuntimeError(연결·응답 실패)"


def test_Yahoo_심볼은_점을_대시로(monkeypatch):
    seen = []
    monkeypatch.setattr(research, "_ticker", lambda symbol: seen.append(symbol) or Ticker(_grades(GRADES[:1])))
    out = research.yahoo_grades("BRK.B")
    assert seen == ["BRK-B"] and out.items[0]["url"] == "https://finance.yahoo.com/quote/BRK-B/analysis/"


# ------------------------------------------------------------------ 네이버 증권사 리포트

INTEGRATION = {"researches": [
    {"id": 90001, "tit": "합성전자, 반도체 회복 &amp; 목표가 상향", "bnm": "합성증권", "wdt": "20261113"},
    {"id": 90002, "tit": "합성전자 3분기 점검", "bnm": "예시투자증권", "wdt": "2026.11.10"},
    {"id": None, "tit": "id 없는 리포트", "bnm": "합성증권", "wdt": "20261101"},
    {"id": 90003, "tit": "", "bnm": "합성증권", "wdt": "20261101"},
]}


def test_네이버_리포트_줄():
    items = research.naver_items(INTEGRATION)
    assert [item["title"] for item in items] == ["합성전자, 반도체 회복 & 목표가 상향", "합성전자 3분기 점검"]
    first = items[0]
    assert first["kind"] == "research" and first["source"] == "naver_research" and first["lang"] == "ko"
    assert first["publisher"] == "합성증권"
    assert first["url"] == "https://finance.naver.com/research/company_read.naver?nid=90001", "상세 화면과 같은 주소"
    assert first["id"] == info_text.item_id(first["url"])
    assert first["publishedAt"] == "2026-11-12T15:00:00+00:00" and first["timeBasis"] == "date"
    assert items[1]["publishedAt"] == "2026-11-09T15:00:00+00:00"
    assert research.naver_items({}) == [] and research.naver_items(None) == []


def test_네이버는_상세_화면의_integration_경로만_부른다(monkeypatch):
    paths = []
    monkeypatch.setattr(detail, "_naver_json", lambda path: paths.append(path) or (INTEGRATION, None))
    out = research.naver_research("900001")
    assert paths == ["/stock/900001/integration"] and len(out.items) == 2 and out.error is None


@pytest.mark.parametrize("error,expected", [
    ("HTTP 503", "m.stock.naver.com HTTP 503"),
    ("ConnectionError: HTTPSConnectionPool(host='m.stock.naver.com'): /api/stock/900001/integration", "m.stock.naver.com 연결·응답 실패"),
])
def test_네이버_실패는_호스트와_상태만(monkeypatch, error, expected):
    monkeypatch.setattr(detail, "_naver_json", lambda path: (None, error))
    assert research.naver_research("900001").error == expected


def test_네이버_응답_모양이_다르면_실패(monkeypatch):
    monkeypatch.setattr(detail, "_naver_json", lambda path: (["x"], None))
    assert research.naver_research("900001").error == "m.stock.naver.com 응답 모양이 다름"
