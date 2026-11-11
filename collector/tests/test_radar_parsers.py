"""
tests/test_radar_parsers.py
Daum 응답 파서 — 지금까지 fetch와 붙어 있어 테스트가 없던 부분. Naver(새 API)는 tests/test_radar_naver.py.
"""
from __future__ import annotations

from app.services import radar


def _daum_payload(rows: list[dict], **extra) -> dict:
    return {"data": {"BUY": rows, "SELL": []}, "toDate": "2026-09-11", **extra}


def test_daum_파서는_코드_접두어와_비율_단위를_정규화한다():
    rows = [
        {"symbolCode": "A005930", "name": "삼성전자", "tradePrice": 71000, "changeRate": 0.0238,
         "straightPurchasePrice": 123_450_000_000},
        {"symbolCode": "A000660", "name": "SK하이닉스", "tradePrice": 180000, "changeRate": -0.011,
         "straightPurchasePrice": 98_700_000_000},
        "not a dict",
        {"symbolCode": "", "name": "코드없음", "straightPurchasePrice": 1},
    ]
    records = radar.parse_daum_ranking(_daum_payload(rows), investor="외국인", trade_type="순매수",
                                       top_n=30, target_date="20260911")

    assert [r["code"] for r in records] == ["005930", "000660"]          # 금액 내림차순, 접두어 A 제거
    assert records[0]["rank"] == 1
    assert records[0]["changePct"] == 2.38                                # 0.0238 → %
    assert records[0]["netAmountEok"] == 1234.5                           # 원 → 억
    assert records[0]["dataDate"] == "2026-09-11"                         # 소스가 밝힌 기준일
    assert "Daum API (외국인, 당일, 2026-09-11)" == records[0]["source"]


def test_daum_순매도는_부호를_방향에_맞춘다():
    payload = {"data": {"BUY": [], "SELL": [
        {"symbolCode": "A005930", "name": "삼성전자", "straightPurchasePrice": 50_000_000_000}]}}
    records = radar.parse_daum_ranking(payload, investor="외국인", trade_type="순매도",
                                       top_n=30, target_date="20260911")
    assert records[0]["netAmountEok"] == -500.0
    # toDate가 없으면 기준일을 **모릅니다** — 요청한 날짜를 적으면 장 시작 전(08:00) 오늘 날짜로 부른
    # 조회의 어제 데이터가 오늘 날짜로 이력에 쌓입니다. 비워 두면 이력 누적이 달력으로 정합니다(ADR 0005).
    assert records[0]["dataDate"] is None


def test_daum_기간별_조회는_dataDate를_달지_않는다():
    payload = _daum_payload([{"symbolCode": "A005930", "name": "삼성전자", "straightPurchasePrice": 1e9}],
                            fromDate="2026-09-05")
    records = radar.parse_daum_ranking(payload, investor="외국인", trade_type="순매수",
                                       top_n=30, target_date="20260911", interval_type="DAYS_5")
    assert records[0]["dataDate"] is None
    assert "5거래일, 2026-09-05~2026-09-11" in records[0]["source"]


def test_daum_빈_응답과_이상한_응답은_빈_목록():
    assert radar.parse_daum_ranking({}, investor="외국인", trade_type="순매수", top_n=30, target_date="x") == []
    assert radar.parse_daum_ranking(None, investor="외국인", trade_type="순매수", top_n=30, target_date="x") == []  # type: ignore[arg-type]


def test_daum_가격_등락률이_빠지면_모르는_값이고_금액이_빠지면_행을_뺀다():
    """빠진 값을 0.0으로 적으면 '가격 0원·등락률 0%'가 이력에 영구히 남습니다."""
    payload = _daum_payload([
        {"symbolCode": "A005930", "name": "삼성전자", "straightPurchasePrice": 1e9},
        {"symbolCode": "A000660", "name": "SK하이닉스", "tradePrice": 180000, "changeRate": -0.011},
    ])
    records = radar.parse_daum_ranking(payload, investor="외국인", trade_type="순매수",
                                       top_n=30, target_date="20260911")
    assert [r["code"] for r in records] == ["005930"]          # 순매수 금액을 모르면 순위를 매길 수 없다
    assert records[0]["price"] is None and records[0]["changePct"] is None
    assert records[0]["netAmountEok"] == 10.0
