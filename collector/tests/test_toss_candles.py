"""
tests/test_toss_candles.py
토스 종목 봉·종목 상태 받기(v2 2단계 B4 — 모의 매매 한국 책). DB 없음.

고정하는 규칙
  1. 봉 시각은 시간대까지 읽어 KST 날짜·시각으로 옮긴다(앞 10자를 자르지 않음). 시간대 없는 시각은 버린다.
  2. 문자열 숫자를 읽고, 가격은 양수만·거래량은 0 이상 정수만 — 아니면 None(0원 가격을 만들지 않음). 종가가 없는 봉은 버린다.
  3. adjusted는 기본값(토스 true)에 기대지 않고 'true'/'false' 소문자로 늘 보낸다. count는 1~200.
  4. 종목 상태의 nxtSupported·krxTradingSuspended는 참·거짓만, 아니면 None(모름).

입력은 실제 응답(fixtures/toss/README.md '실제 응답')입니다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import toss

FIXTURES = Path(__file__).parent / "fixtures" / "toss"


def _result(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))["result"]


def test_실제_일봉은_거래일_KST_자정이고_숫자를_읽는다():
    candles = [toss.normalize_candle(c) for c in _result("candles_1d_069500.json")["candles"]]

    assert [c["date"] for c in candles] == ["2026-10-26", "2026-10-23", "2026-10-22", "2026-10-21", "2026-10-20"]
    assert candles[0] == {"date": "2026-10-26", "time": "00:00", "open": 86265.0, "high": 87540.0, "low": 85700.0,
                          "close": 85995.0, "volume": 25113307}


def test_실제_1분봉은_끝_시각_라벨이고_전날_봉이_섞여_온다():
    candles = [toss.normalize_candle(c) for c in _result("candles_1m_005930_open.json")["candles"]]
    by_label = {(c["date"], c["time"]): c for c in candles}

    assert by_label[("2026-10-23", "09:01")]["open"] == 206000.0
    assert by_label[("2026-10-23", "09:01")]["volume"] == 982971
    assert by_label[("2026-10-23", "09:00")]["volume"] == 0           # 시가 단일가 전 — 체결 없음
    assert ("2026-10-22", "20:00") in by_label                        # 한 응답이 전날 애프터마켓까지 걸침


def test_UTC로_와도_거래일이_밀리지_않는다():
    assert toss.candle_time("2026-10-25T15:00:00Z").date().isoformat() == "2026-10-26"
    assert toss.candle_time("2026-10-26T00:00:00.000+09:00").strftime("%Y-%m-%d %H:%M") == "2026-10-26 00:00"
    assert toss.candle_time("2026-10-26T00:00:00") is None      # 시간대 없음 — 짐작하지 않음
    assert toss.candle_time("어제") is None and toss.candle_time(None) is None


def test_가격은_양수만_거래량은_0_이상_정수만_종가_없으면_버린다():
    base = {"timestamp": "2026-10-26T00:00:00.000+09:00", "openPrice": "0", "highPrice": "-1", "lowPrice": "N/A",
            "closePrice": "1000", "volume": "-5"}
    assert toss.normalize_candle(base) == {"date": "2026-10-26", "time": "00:00", "open": None, "high": None, "low": None,
                                           "close": 1000.0, "volume": None}
    assert toss.normalize_candle({**base, "volume": "0"})["volume"] == 0
    assert toss.normalize_candle({**base, "closePrice": "0"}) is None
    assert toss.normalize_candle({**base, "timestamp": "bad"}) is None
    assert toss.normalize_candle("not a dict") is None


def test_adjusted는_늘_소문자로_보내고_count는_200까지(monkeypatch):
    sent = []

    def fake_get(path, params=None, timeout=10.0):
        sent.append((path, dict(params)))
        return {"candles": _result("candles_1d_069500.json")["candles"][:2], "nextBefore": "2026-10-22T00:00:00.000+09:00"}

    monkeypatch.setattr(toss, "api_get", fake_get)

    candles, next_before = toss.fetch_candles("069500", "1d", 500, adjusted=False, before="2026-10-26T00:00:00+09:00")
    toss.fetch_candles("069500", "1m", 0, adjusted=True)

    assert sent[0] == ("/api/v1/candles", {"symbol": "069500", "interval": "1d", "count": 200, "adjusted": "false",
                                            "before": "2026-10-26T00:00:00+09:00"})
    assert sent[1][1] == {"symbol": "069500", "interval": "1m", "count": 1, "adjusted": "true"}
    assert [c["date"] for c in candles] == ["2026-10-26", "2026-10-23"]
    assert next_before == "2026-10-22T00:00:00.000+09:00"


def test_마지막_쪽은_nextBefore가_없고_모르는_간격은_부르지_않는다(monkeypatch):
    monkeypatch.setattr(toss, "api_get", lambda path, params=None, timeout=10.0: {"candles": [], "nextBefore": None})
    assert toss.fetch_candles("069500", "1d", 5, adjusted=False) == ([], None)

    monkeypatch.setattr(toss, "api_get", lambda *a, **k: pytest.fail("호출하면 안 됩니다"))
    with pytest.raises(ValueError):
        toss.fetch_candles("069500", "1w", 5, adjusted=False)


def test_봉_응답이_객체가_아니면_TossError(monkeypatch):
    monkeypatch.setattr(toss, "api_get", lambda *a, **k: [1, 2])
    with pytest.raises(toss.TossError):
        toss.fetch_candles("069500", "1d", 5, adjusted=False)


def test_실제_종목_상태에서_NXT_여부와_정지를_읽는다(monkeypatch):
    sent = []

    def fake_get(path, params=None, timeout=10.0):
        sent.append((path, params))
        return _result("stocks_005930_069500_153130.json")

    monkeypatch.setattr(toss, "api_get", fake_get)

    infos = toss.fetch_stock_infos(["005930", "069500", "153130"])

    assert sent == [("/api/v1/stocks", {"symbols": "005930,069500,153130"})]
    assert infos["005930"] == {"name": "삼성전자", "market": "KOSPI", "securityType": "STOCK", "nxtSupported": True,
                               "krxTradingSuspended": False, "listDate": "1975-06-11", "status": "ACTIVE"}
    assert infos["069500"]["securityType"] == "ETF" and infos["069500"]["nxtSupported"] is False


def test_종목_상태_칸이_없거나_참거짓이_아니면_모름(monkeypatch):
    monkeypatch.setattr(toss, "api_get", lambda *a, **k: [
        {"symbol": "000001", "name": "가", "koreanMarketDetail": {"nxtSupported": "true"}},
        {"symbol": "000002", "name": "나"},
    ])
    infos = toss.fetch_stock_infos(["000001", "000002"])
    assert infos["000001"]["nxtSupported"] is None and infos["000001"]["krxTradingSuspended"] is None
    assert infos["000002"]["nxtSupported"] is None and infos["000002"]["listDate"] is None
