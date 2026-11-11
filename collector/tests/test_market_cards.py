"""
tests/test_market_cards.py
매크로 카드 규칙 회귀 테스트.

구버전에서 실제로 화면을 잘못 그리게 만들었던 상황들을 고정합니다.
외부 네트워크를 쓰지 않습니다(수집 함수를 대체합니다).
"""
from __future__ import annotations

import pytest

from app.services import market


def _points(*closes, base_date="2026-09-11T09:00:00+09:00"):
    from datetime import datetime, timedelta

    start = datetime.fromisoformat(base_date)
    return [
        {
            "date": (start + timedelta(minutes=index)).isoformat(),
            "open": close, "high": close, "low": close,
            "close": close, "volume": 0,
        }
        for index, close in enumerate(closes)
    ]


def _payload(points, *, intraday=True):
    return {
        "symbol": "TEST", "period": "5d", "isIntraday": intraday,
        "isProxy": False, "isSynthetic": False, "sourceLabel": None,
        "points": points,
    }


def _two_sessions(previous_day: tuple, today: tuple):
    """전 거래일 분봉 + 오늘 분봉(5일치 분봉 수집과 같은 모양)."""
    return (_points(*previous_day, base_date="2026-09-10T15:00:00+09:00")
            + _points(*today, base_date="2026-09-11T09:00:00+09:00"))


@pytest.fixture(autouse=True)
def _no_real_download(monkeypatch):
    """
    이 파일의 시험은 네트워크 없이 돕니다 — 스텁 없이 yfinance 조회(market._download)에 닿으면 그 시험을 실패시킵니다(QA-287).
    일봉·분봉을 받아야 하는 시험은 ``_download``나 그 위 단계(``previous_close_from_daily``·``collect_ticker``)를 바꿔 끼웁니다.
    """
    def refuse(symbol, period):
        pytest.fail(f"시험이 실제 Yahoo 조회를 하려 했습니다({symbol} {period}) — 그 단계를 바꿔 끼우세요", pytrace=False)

    monkeypatch.setattr(market, "_download", refuse)


SPEC = {"key": "dxy", "name": "달러 인덱스 (DXY)", "ticker": "DX-Y.NYB", "note": "실시간"}
# 분봉의 전 거래일을 달력 날짜로 나눌 수 있는(세션이 하루 안에 끝나는) 상품. 세션형(선물·DXY)은 일봉을 씁니다(QA-058).
DAY_SESSION_SPEC = {"key": "kospi", "name": "KOSPI", "ticker": "^KS11", "note": "실시간"}


def test_normal_card_has_delta_and_previous():
    # 전 거래일 마지막 체결 100 → 오늘 101 (QA-053: '직전'은 전일 종가)
    card = market._build_card(DAY_SESSION_SPEC, _payload(_two_sessions((100.0,), (101.0,))))

    assert card["status"] == "ok"
    assert card["price"] == pytest.approx(101.0)
    assert card["delta"] == pytest.approx(1.0)
    assert card["pct"] == pytest.approx(1.0)
    assert card["prevStr"] == "100.00"


def test_failed_collection_is_reported_as_fail():
    card = market._build_card(SPEC, _payload([]))
    assert card["status"] == "fail"
    assert "price" not in card


def test_stalled_minute_bars_fall_back_to_daily_close(monkeypatch):
    """
    주말·비유동 시간대에는 분봉 피드가 마지막 봉을 그대로 반복합니다.
    그때 "변화 없음(0.00%)"으로 위장하면 거짓이고, 전일 종가까지 N/A로
    사라지는 것도 잘못입니다. 일봉에서 직전 거래일 종가를 찾아야 합니다.
    """
    monkeypatch.setattr(
        market, "previous_close_from_daily", lambda symbol, current=None: 9.20
    )

    spec = {"key": "jpykrw", "name": "엔/원 100엔당", "ticker": "JPYKRW=X", "note": "실시간"}
    card = market._build_card(spec, _payload(_points(9.50, 9.50)))

    assert card["status"] == "ok"
    assert card["prevSource"] == "일봉 직전 거래일 종가"
    # 배율(×100)은 현재가와 전일값에 동일하게 적용돼야 합니다.
    assert card["price"] == pytest.approx(950.0)
    assert card["prevValue"] == pytest.approx(920.0)
    assert card["delta"] == pytest.approx(30.0)


def test_no_previous_close_is_na_not_zero(monkeypatch):
    """전일값을 못 구하면 0.00%로 위장하지 않고 N/A로 둡니다."""
    monkeypatch.setattr(
        market, "previous_close_from_daily", lambda symbol, current=None: None
    )

    card = market._build_card(SPEC, _payload(_points(100.0, 100.0)))

    assert card["status"] == "single"
    assert card["delta"] is None
    assert card["pct"] is None
    assert card["deltaStr"] == "N/A"
    assert card["prevStr"] == "N/A"


def test_jpy_scale_decided_by_raw_price(monkeypatch):
    """
    배율은 **원본 현재가**로 한 번만 판정해야 합니다. 스케일 적용 후의 값으로
    판정하면 전일값만 100배 틀어집니다.
    """
    monkeypatch.setattr(
        market, "previous_close_from_daily", lambda symbol, current=None: None
    )
    spec = {"key": "jpykrw", "name": "엔/원 100엔당", "ticker": "JPYKRW=X", "note": "실시간"}
    card = market._build_card(spec, _payload(_two_sessions((9.10,), (9.30,))))

    assert card["price"] == pytest.approx(930.0)
    assert card["prevValue"] == pytest.approx(910.0)


def test_daily_bar_timestamp_is_labelled_not_faked():
    """
    일봉 폴백 데이터의 시:분:초는 신뢰할 수 없습니다. 거짓 체결 시각 대신
    거래일임을 명시해야 합니다.
    """
    card = market._build_card(SPEC, _payload(_points(100.0, 101.0), intraday=False))
    assert card["lastTs"].endswith("일봉 기준")


def test_intraday_timestamp_is_kst(monkeypatch):
    # 세션형 상품(DXY)의 장중 카드는 직전 세션 종가를 일봉에서 찾습니다 — 바꿔 끼우지 않으면 yfinance로 실제 Yahoo에 나갑니다(QA-287).
    monkeypatch.setattr(market, "previous_close_from_daily", lambda symbol, current=None: 99.0)
    card = market._build_card(SPEC, _payload(_points(100.0, 101.0)))
    assert card["lastTs"].endswith("KST")


def test_slice_period_keeps_proxy_flags():
    payload = {
        "symbol": "^MOVE", "period": "5y", "isIntraday": False,
        "isProxy": True, "isSynthetic": False,
        "sourceLabel": "^TNX 변동성 기반 추정치 (실제 ICE BofA MOVE 아님)",
        "points": _points(*range(100, 200), base_date="2020-01-01T00:00:00+00:00"),
    }
    sliced = market.slice_period(payload, "1mo")

    # 잘라 내도 "이 값은 실제 지표가 아니다"라는 표시가 사라지면 안 됩니다.
    assert sliced["isProxy"] is True
    assert "실제 ICE BofA MOVE 아님" in sliced["sourceLabel"]
    assert len(sliced["points"]) <= len(payload["points"])


def test_move_proxy_returns_empty_when_tnx_unavailable(monkeypatch):
    """
    ^TNX까지 실패하면 합성 사인파를 만들지 않고 빈 결과를 돌려줍니다.
    (구버전은 정보가 전혀 없는 시계열을 그려 줬습니다.)
    """
    monkeypatch.setattr(
        market, "_download",
        lambda symbol, period: (None, False, "yfinance가 빈 응답을 받았습니다"),
    )

    payload = market.collect_ticker("^MOVE", "3mo")
    assert payload["points"] == []
    assert payload["isProxy"] is True
    # 왜 비었는지가 남아야 합니다. 없으면 화면에 "0건"만 뜹니다.
    assert payload.get("error")


def test_rates_include_every_bond_key(monkeypatch):
    """
    스프레드 계산용 rates에 30년물이 빠지면 안 됩니다.

    화면의 30Y−2Y 카드는 rates["us30y"]가 있어야 스크래핑 패널을 그립니다.
    예전에는 여기서 2년·10년만 담아서, 30년물은 **수집에 성공하고도**
    화면에 "수집 실패"로 떴습니다(사실이 아닌 실패 표시).
    """
    from app import indicators

    categories = [{
        "id": "rates",
        "title": "금리",
        "items": [
            {"key": "us02y", "name": "미국채 2년물", "ticker": "ZT=F"},
            {"key": "us10y", "name": "미국채 10년물", "ticker": "^TNX"},
            {"key": "us30y", "name": "미국채 30년물", "ticker": "^TYX"},
        ],
    }]

    prices = {"ZT=F": (3.5, 3.6), "^TNX": (4.0, 4.1), "^TYX": (4.6, 4.7)}
    monkeypatch.setattr(
        market, "collect_ticker",
        lambda symbol, period: _payload(_points(*prices[symbol])),
    )

    result = market.collect_macro_cards(categories)

    assert set(result["rates"]) == set(indicators.BOND_SCANNER_KEYS)
    assert result["rates"]["us30y"]["current"] == pytest.approx(4.7)
    assert result["rates"]["us30y"]["previous"] == pytest.approx(4.6)



def test_QA053_장중_카드의_직전은_전_거래일_마지막_체결이다(monkeypatch):
    """
    장중 카드가 points[-2](바로 앞 1분봉)를 '직전'으로 써서, 국채 카드(전일 종가)와 달리 환율·원자재·지수 카드의
    등락률이 1분 변화였습니다(AI 텍스트에도 같은 값). 결정(2026-10-11): 전일(직전 거래일) 종가로 통일.
    """
    monkeypatch.setattr(market, "previous_close_from_daily", lambda symbol, current=None: pytest.fail("분봉으로 충분"))

    card = market._build_card(DAY_SESSION_SPEC, _payload(_two_sessions((99.0, 100.0), (102.0, 103.0))))

    assert card["prevValue"] == pytest.approx(100.0)
    assert card["delta"] == pytest.approx(3.0)
    assert card["pct"] == pytest.approx(3.0)
    assert card["prevSource"] == "분봉의 직전 거래일 마지막 체결"


def test_QA058_선물의_전일은_직전_세션의_일봉_종가다(monkeypatch):
    """
    CME 선물은 전날 18:00 ET에 세션이 시작합니다. 분봉을 달력 날짜로 나누면 한국 낮(ET 저녁)에는 '전일'이 직전 ET
    자정 무렵 체결이 됐습니다. 직전 세션의 종가는 일봉(세션 거래일로 표기, 종가 = 정산가)에 있습니다.
    """
    spec = {"key": "wti", "name": "WTI 원유 ($)", "ticker": "CL=F", "note": "15분 지연"}
    intraday = [
        {"date": "2026-10-05T23:59:00-04:00", "close": 89.0},   # 10-06 세션 한가운데
        {"date": "2026-10-06T16:55:00-04:00", "close": 89.91},  # 10-06 세션 마지막 체결
        {"date": "2026-10-06T20:00:00-04:00", "close": 90.5},   # 10-07 세션(18:00 ET 시작)
    ]
    daily = [
        {"date": "2026-10-05T00:00:00-04:00", "close": 88.0},
        {"date": "2026-10-06T00:00:00-04:00", "close": 89.44},  # 10-06 세션 정산가
    ]
    monkeypatch.setattr(market, "collect_ticker", lambda symbol, period: {"points": daily})
    monkeypatch.setattr(market, "_SESSION_CLOSE_CACHE", {})

    card = market._build_card(spec, _payload(intraday))

    assert card["prevValue"] == pytest.approx(89.44)
    assert card["prevSource"] == "일봉 직전 거래일 종가"


def test_세션형_상품의_직전_세션_종가는_세션마다_한_번만_일봉을_읽는다(monkeypatch):
    """선물 카드는 5분마다 다시 만들어집니다. 직전 세션 종가는 세션이 바뀔 때만 달라지므로 그때만 일봉을 읽습니다."""
    monkeypatch.setattr(market, "_SESSION_CLOSE_CACHE", {})
    calls: list[str] = []
    daily = [{"date": "2026-10-05T00:00:00-04:00", "close": 88.0},
             {"date": "2026-10-06T00:00:00-04:00", "close": 89.44},
             {"date": "2026-10-07T00:00:00-04:00", "close": 90.1}]
    monkeypatch.setattr(market, "collect_ticker", lambda symbol, period: calls.append(symbol) or {"points": daily})

    same_session = ["2026-10-06T20:00:00-04:00", "2026-10-06T20:05:00-04:00", "2026-10-07T09:30:00-04:00"]
    assert [market.previous_close_from_daily("CL=F", at) for at in same_session] == [89.44, 89.44, 89.44]
    assert calls == ["CL=F"]

    assert market.previous_close_from_daily("CL=F", "2026-10-07T19:00:00-04:00") == 90.1   # 다음 세션
    assert calls == ["CL=F", "CL=F"]

    market.previous_close_from_daily("^KS11", "2026-10-07T10:00:00+09:00")                  # 세션형이 아니면 기억하지 않음
    market.previous_close_from_daily("^KS11", "2026-10-07T10:05:00+09:00")
    assert calls.count("^KS11") == 2
