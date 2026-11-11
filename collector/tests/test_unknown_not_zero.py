"""
tests/test_unknown_not_zero.py
소스가 값을 빼고 보내면 모르는 값(None)이지 0이 아니다(QA-036, PRINCIPLES '수집 실패 시 숫자를 만들어내지 않습니다').

Daum·Naver 파서는 앞선 리뷰(B-8)에서 고쳤고, 같은 패턴이 KIS·LS(2026-11-11 제거)·COT·KRX 장중 가속도에 남아 있었습니다.
네트워크를 쓰지 않습니다(각 소스의 응답을 흉내 냅니다).
"""
from __future__ import annotations

import pytest

from app.services import cot, kis, krx



def test_QA036_KIS_가격_등락률이_없으면_모른다(monkeypatch):
    amount_field = kis.INVESTOR_FIELDS["외국인"]["amount"]
    monkeypatch.setattr(kis, "call_api", lambda **kw: {"rt_cd": "0", "output": [
        {"stck_shrn_iscd": "005930", "hts_kor_isnm": "삼성전자", amount_field: "150000"}]})

    rows = kis.fetch_deal_ranking("20261012", "KOSPI", "외국인", "순매수", 30)

    assert rows and rows[0]["price"] is None and rows[0]["changePct"] is None


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def test_QA036_COT_빠진_필드는_0이_아니고_순포지션도_모른다(monkeypatch):
    # Socrata는 null 필드를 아예 빼고 보냅니다.
    monkeypatch.setattr(cot, "_get_with_retry", lambda params: (_Response([{
        "report_date_as_yyyy_mm_dd": "2026-10-06T00:00:00.000",
        "noncomm_positions_long_all": "250000",
        "comm_positions_long_all": "100000", "comm_positions_short_all": "90000",
        "nonrept_positions_long_all": "1000", "nonrept_positions_short_all": "2000"}]), None))

    rows = cot.collect_contract("13874A")

    assert rows[0]["ncShort"] is None
    assert rows[0]["ncNet"] is None
    assert rows[0]["commNet"] == pytest.approx(10000.0)


def test_QA036_KRX_장중_가속도는_빠진_값의_변화를_모른다(monkeypatch):
    data = [
        {"date": "2026-10-12T10:00:00+09:00", "foreignSettlement": 1000, "institutionalSettlement": 500},
        {"date": "2026-10-12T10:30:00+09:00", "institutionalSettlement": 700},    # 외국인 값 빠짐
    ]

    class _Session:
        def get(self, *a, **k):
            response = _Response({"data": data})
            response.status_code = 200
            return response

    monkeypatch.setattr(krx, "get_session", lambda: _Session())

    result = krx.collect_daum_intraday_acceleration(30)

    assert result["foreignChange"] is None
    assert result["institutionChange"] == 200
