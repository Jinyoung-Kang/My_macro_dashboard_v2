"""
tests/test_radar_history.py
수급 레이더 누적 이력(observations/radar_ranking)의 쓰기·읽기 계약.

이 테이블은 외부에서 다시 받을 수 없는 데이터라(DATA_SOURCES.md §4), 한 번 잘못
쌓이면 복구할 길이 없습니다. 실제 PostgreSQL 위에서 확인합니다.
"""
from __future__ import annotations

from datetime import date

import pytest

from app import catalog
from app.services import radar


def _rows(*items: tuple[str, float]) -> list[dict]:
    return [
        {"rank": i, "code": code, "name": f"종목{code}", "price": 1000.0,
         "changePct": 0.5, "netAmountEok": amount, "source": "Daum",
         "collectedAt": "2026-09-11 10:00 KST"}
        for i, (code, amount) in enumerate(items, start=1)
    ]


@pytest.fixture()
def session_20260911(monkeypatch):
    monkeypatch.setattr(radar, "latest_completed_session", lambda now=None: "20260911")


def _codes(store, combo: dict, obs_date: str = "2026-09-11") -> set[str]:
    rows = store.read_observations(catalog.OBS_RADAR, obs_date=obs_date, filters=combo)
    return {r["code"] for r in rows}


def test_같은_날_같은_조합을_다시_쌓으면_이전_상위권은_남지_않는다(store, session_20260911):
    """
    장중에는 5분마다 수집하므로 상위 30위 구성이 계속 바뀝니다. upsert만 하면
    밀려난 종목이 10시 값으로 그대로 남아, 하루치가 30행이 아니라 50~57행이
    됩니다(2026-09-28·29 실제 데이터). 그 합집합을 다시 정렬해 "그날의 상위
    30"이라고 돌려주면 시각이 다른 값이 섞입니다.
    """
    combo = {"market": "KOSPI", "investor": "외국인", "tradeType": "순매수",
             "intervalType": "TODAY"}

    radar.accumulate_history(_rows(("A", 10.0), ("B", 9.0)), "KOSPI", "외국인", "순매수", "TODAY")
    radar.accumulate_history(_rows(("B", 50.0), ("C", 40.0)), "KOSPI", "외국인", "순매수", "TODAY")

    assert _codes(store, combo) == {"B", "C"}


def test_다른_조합의_같은_날_이력은_건드리지_않는다(store, session_20260911):
    radar.accumulate_history(_rows(("A", 10.0)), "KOSPI", "외국인", "순매수", "TODAY")
    radar.accumulate_history(_rows(("Z", 5.0)), "KOSPI", "기관", "순매수", "TODAY")
    radar.accumulate_history(_rows(("Y", 7.0)), "KOSPI", "외국인", "순매수", "DAYS_5")

    # 외국인·순매수·TODAY를 다시 쌓아도 기관·DAYS_5 행은 그대로입니다.
    radar.accumulate_history(_rows(("B", 20.0)), "KOSPI", "외국인", "순매수", "TODAY")

    assert _codes(store, {"investor": "외국인", "intervalType": "TODAY"}) == {"B"}
    assert _codes(store, {"investor": "기관"}) == {"Z"}
    assert _codes(store, {"intervalType": "DAYS_5"}) == {"Y"}


def test_빈_결과로는_그날_이력을_지우지_않는다(store, session_20260911):
    radar.accumulate_history(_rows(("A", 10.0)), "KOSPI", "외국인", "순매수", "TODAY")
    assert radar.accumulate_history([], "KOSPI", "외국인", "순매수", "TODAY") == 0
    assert _codes(store, {"investor": "외국인"}) == {"A"}


def test_이력_읽기는_요청한_기간_구간만_본다(store, session_20260911):
    """
    당일(TODAY) 백업을 꺼낼 때 20거래일 누적 금액이 섞이면, 10~20배 큰 값이
    "오늘 순매수"로 1위에 올라갑니다.
    """
    radar.accumulate_history(_rows(("A", 100.0)), "KOSPI", "외국인", "순매수", "TODAY")
    radar.accumulate_history(_rows(("B", 2000.0)), "KOSPI", "외국인", "순매수", "DAYS_20")

    result = radar.read_from_history(date(2026, 9, 11), "KOSPI", "외국인", "순매수", 30, "TODAY")

    assert result is not None
    assert [r["code"] for r in result["rows"]] == ["A"]
    assert result["rows"][0]["rank"] == 1


def test_이력_읽기는_그_조합이_실제로_있는_가장_가까운_날짜를_고른다(store, monkeypatch):
    """
    가장 최근 날짜에 다른 조합만 있으면(예: 기관만 수집됨), 그보다 앞선 날짜의
    외국인 이력을 돌려줘야 합니다. 날짜 목록을 조합과 무관하게 뽑으면 '최근
    날짜에 행이 없음 → None'으로 끝나 백업이 있는데도 빈 화면이 됩니다.
    """
    monkeypatch.setattr(radar, "latest_completed_session", lambda now=None: "20260910")
    radar.accumulate_history(_rows(("A", 10.0)), "KOSPI", "외국인", "순매수", "TODAY")
    monkeypatch.setattr(radar, "latest_completed_session", lambda now=None: "20260911")
    radar.accumulate_history(_rows(("Z", 5.0)), "KOSPI", "기관", "순매수", "TODAY")

    result = radar.read_from_history(date(2026, 9, 11), "KOSPI", "외국인", "순매수", 30, "TODAY")

    assert result is not None
    assert result["historyDate"] == "2026-09-10"
    assert [r["code"] for r in result["rows"]] == ["A"]


def test_소스가_밝힌_데이터_기준일이_있으면_그_날짜로_쌓는다(store, session_20260911):
    """
    Daum은 응답에 toDate(데이터 기준일)를 줍니다. 공휴일 아침처럼 수집 시각으로 추정한
    거래일이 어긋날 수 있는 때에도, 소스가 말한 날짜가 맞습니다.
    """
    rows = _rows(("A", 10.0))
    rows[0]["dataDate"] = "2026-09-10"

    radar.accumulate_history(rows, "KOSPI", "외국인", "순매수", "TODAY")

    assert _codes(store, {"investor": "외국인"}, obs_date="2026-09-10") == {"A"}
    assert _codes(store, {"investor": "외국인"}, obs_date="2026-09-11") == set()


class _TossSnap:
    """toss_radar_universe 저장본 흉내 — 거래대금 상위 종목의 투자자별 매매(주)."""
    age_seconds = 60
    collected_at = None
    payload = {
        "universe": 100,
        "stocks": [{
            "market": "KOSPI", "code": "000660", "name": "SK하이닉스", "lastPrice": 200000.0, "changePct": 1.0,
            "records": [{"date": "2026-09-10", "investors": {"foreigner": {"net": 50000}}}],
        }],
    }


def test_QA029_토스_추정_순위는_그날의_실제_이력을_지우지_않는다(store, session_20260911, monkeypatch):
    """
    토스 폴백은 '거래대금 상위 100종목 안'의 순위이고 금액은 주식 수 × 현재가 추정입니다. 기준일도 전 거래일일 수
    있는데 기준일 없이 와서, 오늘 거래일 이름으로 그날 앞서 받은 실제 Daum 상위 30을 교체했습니다.
    """
    combo = {"market": "KOSPI", "investor": "외국인", "tradeType": "순매수", "intervalType": "TODAY"}
    radar.accumulate_history(_rows(("A", 10.0), ("B", 9.0)), "KOSPI", "외국인", "순매수", "TODAY")

    monkeypatch.setattr(radar.store, "read_snapshot", lambda name: _TossSnap())
    toss_rows = radar.fetch_toss_ranking("KOSPI", "외국인", "순매수", 30)
    assert toss_rows, "토스 폴백 행이 만들어져야 합니다"
    radar.accumulate_history(toss_rows, "KOSPI", "외국인", "순매수", "TODAY")

    assert _codes(store, combo) == {"A", "B"}
    assert _codes(store, combo, "2026-09-10") == set(), "추정치는 어느 날짜에도 쌓지 않습니다"
