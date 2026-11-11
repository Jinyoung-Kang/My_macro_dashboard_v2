"""
tests/test_radar_naver.py
수급 레이더의 Naver 단계 — stock.naver.com 새 화면의 ``trendForeignOrg`` API (ADR 0035 결정 10).

옛 iframe 페이지는 HTTP 410으로 끊겼습니다. 새 API의 장중 순위는 추정(``estimated: true``)이고 순매수 금액 칸이 ``"0"``이라,
0으로 읽으면 없는 숫자가 이력에 남습니다. 확정 값만 금액 순위로 씁니다. 표본은 구조만 흉내 낸 합성 값입니다(실제 응답 원문 아님).
네트워크를 쓰지 않습니다.
"""
from __future__ import annotations

import pytest

from app.services import radar


def _row(code: str, name: str, amount: str, *, estimated=None, volume: str = "1000", price: str = "10000",
         change: str = "1.5", day: str = "20261110") -> dict:
    return {
        "itemcode": code, "itemname": name, "bizdateFrom": day, "bizdateTo": day,
        "accTradeVolume": volume, "accTradeAmount": amount, "dailyTradeVolume": volume,
        "nowPrice": price, "prevChangeRate": change, "prevChangePrice": "100", "type": "ST",
        "estimated": estimated, "toRankingAt": None,
    }


def _page(buys: list[dict], sells: list[dict] | None = None) -> dict:
    return {"sections": {"buyRankList": buys, "sellRankList": sells or []}}


def test_확정_값은_금액을_억_원으로_쓰고_기준일을_밝힌다():
    page = _page([_row("000001", "가나다", "166159457000"), _row("000002", "라마바", "90926067000")])

    records, reason = radar.parse_naver_ranking([page], trade_type="순매수", top_n=30, investor="외국인")

    assert reason is None
    assert [r["code"] for r in records] == ["000001", "000002"]
    assert records[0]["netAmountEok"] == 1661.6
    assert records[0]["dataDate"] == "2026-11-10"
    assert records[0]["price"] == 10000.0 and records[0]["changePct"] == 1.5
    assert records[0]["rank"] == 1 and "Naver" in records[0]["source"]


def test_장중_추정_순위는_금액이_없어_쓰지_않는다():
    page = _page([_row("000001", "가나다", "0", estimated=True)])

    records, reason = radar.parse_naver_ranking([page], trade_type="순매수", top_n=30, investor="외국인")

    assert records == []
    assert "추정" in reason


def test_순매도는_음수이고_금액이_0이거나_없으면_행을_뺀다():
    page = _page([], [_row("000003", "사아자", "-50000000000"), _row("000004", "차카타", "0"),
                      _row("000005", "파하가", "")])

    records, _ = radar.parse_naver_ranking([page], trade_type="순매도", top_n=30, investor="기관")

    assert [r["code"] for r in records] == ["000003"]
    assert records[0]["netAmountEok"] == -500.0


def test_빈_칸은_모르는_값이고_0으로_채우지_않는다():
    page = _page([_row("000001", "가나다", "1000000000", price="", change="-")])

    records, _ = radar.parse_naver_ranking([page], trade_type="순매수", top_n=30, investor="외국인")

    assert records[0]["price"] is None and records[0]["changePct"] is None


def test_모양이_다르면_사유를_돌려준다():
    records, reason = radar.parse_naver_ranking([{"content": []}], trade_type="순매수", top_n=30, investor="외국인")

    assert records == [] and "형식" in reason


class _Res:
    def __init__(self, payload, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def _stub(monkeypatch, responses: list):
    calls: list[dict] = []

    class _Session:
        def get(self, url, params=None, headers=None, timeout=None):
            calls.append({"url": url, "params": dict(params or {}), "headers": headers})
            return responses[min(len(calls) - 1, len(responses) - 1)]

    monkeypatch.setattr(radar, "get_session", lambda: _Session())
    radar._NAVER_LAST_REASON["value"] = None
    return calls


def test_외국인·기관만_부르고_나머지는_부르지_않는다(monkeypatch):
    calls = _stub(monkeypatch, [_Res(_page([_row("000001", "가나다", "1000000000")]))])

    assert radar.fetch_naver_ranking("20261110", "KOSPI", "개인", "순매수", 5) == []
    assert calls == []
    assert "외국인·기관만" in radar._NAVER_LAST_REASON["value"]

    rows = radar.fetch_naver_ranking("20261110", "KOSDAQ", "기관", "순매수", 5)
    assert rows and calls[0]["params"]["investorType"] == "ORGANIZATION"
    assert calls[0]["params"]["marketType"] == "KOSDAQ" and calls[0]["params"]["periodType"] == "DAY"
    assert calls[0]["headers"]["Referer"].endswith("/trend/organization")


def test_상위_N이_한_쪽보다_크면_다음_쪽을_한_번만_더_받는다(monkeypatch):
    full = _page([_row(f"{i:06d}", f"종목{i}", str((100 - i) * 1_000_000_000)) for i in range(20)])
    rest = _page([_row(f"{i:06d}", f"종목{i}", str((100 - i) * 1_000_000_000)) for i in range(20, 30)])
    calls = _stub(monkeypatch, [_Res(full), _Res(rest)])

    rows = radar.fetch_naver_ranking("20261110", "KOSPI", "외국인", "순매수", 30)

    assert [c["params"]["startIdx"] for c in calls] == [0, 1]
    assert len(rows) == 30


@pytest.mark.parametrize("response,expected", [
    (_Res({}, status_code=503), "503"),
    (_Res(ValueError("not json")), "JSON이 아닌 응답"),
])
def test_실패하면_진단_사유를_남긴다(monkeypatch, response, expected):
    _stub(monkeypatch, [response])

    assert radar.fetch_naver_ranking("20261110", "KOSPI", "외국인", "순매수", 5) == []
    assert expected in radar._NAVER_LAST_REASON["value"]
    assert expected in radar.test_naver_connection()["message"]


# ------------------------------------------------------------------ QA-412
@pytest.mark.xfail(strict=True, reason="QA-412: 장중 추정 응답을 받은 정상 연결이 진단 표에서 실패로 보입니다")
def test_QA412_추정_응답을_받았으면_연결_진단은_정상이고_단계로_가른다(monkeypatch):
    """장중에는 응답이 추정이라 행을 만들지 않습니다(금액 없음). 연결은 정상이므로 진단 표가 위험 색으로 뜨면 안 됩니다."""
    _stub(monkeypatch, [_Res(_page([_row("000001", "가나다", "0", estimated=True)]))])

    result = radar.test_naver_connection()

    assert result["ok"] is True
    assert result["stage"] == "estimated"
    assert "추정" in result["message"]


def test_QA412_빈_응답과_차단은_여전히_실패다(monkeypatch):
    _stub(monkeypatch, [_Res(_page([]))])
    assert radar.test_naver_connection()["ok"] is False

    _stub(monkeypatch, [_Res({}, status_code=403)])
    blocked = radar.test_naver_connection()
    assert blocked["ok"] is False and blocked["stage"] == "empty"


@pytest.mark.xfail(strict=True, reason="QA-412: 두 쪽이 겹치면 같은 종목이 두 번 들어갑니다")
def test_QA412_쪽이_겹쳐_같은_종목이_다시_와도_한_번만_싣는다():
    """다음 쪽 요청의 startIdx가 행 오프셋이면 1쪽과 겹칩니다(외부 동작 — 확인 못 함). 종목 코드로 한 번만 싣습니다."""
    first = _page([_row("000001", "가나다", "3000000000"), _row("000002", "라마바", "2000000000")])
    second = _page([_row("000002", "라마바", "2000000000"), _row("000003", "사아자", "1000000000")])

    records, reason = radar.parse_naver_ranking([first, second], trade_type="순매수", top_n=30, investor="외국인")

    assert reason is None
    assert [r["code"] for r in records] == ["000001", "000002", "000003"]
    assert [r["rank"] for r in records] == [1, 2, 3]


@pytest.mark.xfail(strict=True, reason="QA-412: KRX 저장본 행에 늘 비어 있는 collectedAt 칸이 붙습니다")
def test_QA412_KRX_저장본_행에는_없는_수집_시각_칸을_만들지_않는다(monkeypatch):
    """KRX 순위 관측치에는 수집 시각 칸이 없습니다(krx_data.parse_rankings). 늘 None인 칸을 행에 붙이지 않습니다."""
    stored = [{"rank": 1, "code": "005930", "name": "삼성전자", "price": None, "changePct": None, "netAmountEok": 900.0,
               "netVolume": 10, "dataDate": "2026-11-10", "market": "KOSPI", "investor": "외국인", "tradeType": "순매수"}]
    monkeypatch.setattr(radar.store, "read_observations", lambda *a, **k: [dict(row) for row in stored])

    rows = radar.fetch_krx_stored_ranking("20261110", "KOSPI", "외국인", "순매수", 30, nearest=False)

    assert rows and rows[0]["code"] == "005930"
    assert "collectedAt" not in rows[0]
