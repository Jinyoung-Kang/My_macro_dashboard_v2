"""
tests/test_radar_chain.py
수급 레이더 폴백 체인 회귀 테스트.

체인: KIS(장중) → Daum → Naver → 토스(공식) → 누적 이력 (PyKrx·LS는 2026-11-11에 뺌 — ADR 0035)
외부 네트워크를 쓰지 않습니다(각 단계를 대체합니다).
"""
from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from app.services import radar

KST = ZoneInfo("Asia/Seoul")


@pytest.fixture(autouse=True)
def silence_sources(monkeypatch):
    """기본적으로 모든 외부 단계를 '빈 결과'로 만들어 둡니다."""
    monkeypatch.setattr(radar.kis, "fetch_deal_ranking", lambda *a, **k: [])
    monkeypatch.setattr(radar, "fetch_daum_ranking", lambda *a, **k: [])
    monkeypatch.setattr(radar, "fetch_naver_ranking", lambda *a, **k: [])
    monkeypatch.setattr(radar, "fetch_toss_ranking", lambda *a, **k: [])
    monkeypatch.setattr(radar, "read_from_history", lambda *a, **k: None)


def _rows(source: str):
    return [{
        "rank": 1, "code": "005930", "name": "삼성전자",
        "price": 71000.0, "changePct": 1.2, "netAmountEok": 1200.5,
        "source": source, "collectedAt": "2026-09-11 10:00:00 KST",
    }]


def test_kis_wins_during_regular_session(monkeypatch):
    monkeypatch.setattr(radar, "is_regular_session", lambda now=None: True)
    monkeypatch.setattr(
        radar.kis, "fetch_deal_ranking", lambda *a, **k: _rows("KIS 장중 가집계")
    )
    called = {"daum": False}

    def daum(*args, **kwargs):
        called["daum"] = True
        return _rows("Daum")

    monkeypatch.setattr(radar, "fetch_daum_ranking", daum)

    result = radar.collect_radar_ranking(datetime.now(KST).date())

    assert result["sourceKind"] == "kis"
    assert called["daum"] is False, "앞 단계가 성공하면 뒤는 호출되지 않아야 합니다"


def test_kis_is_skipped_outside_regular_session(monkeypatch):
    monkeypatch.setattr(radar, "is_regular_session", lambda now=None: False)
    called = {"kis": False}

    def kis_call(*args, **kwargs):
        called["kis"] = True
        return _rows("KIS")

    monkeypatch.setattr(radar.kis, "fetch_deal_ranking", kis_call)
    monkeypatch.setattr(radar, "fetch_daum_ranking", lambda *a, **k: _rows("Daum API"))

    result = radar.collect_radar_ranking(datetime.now(KST).date())

    assert called["kis"] is False, "가집계 TR은 장중 전용입니다"
    assert result["sourceKind"] == "daum"


def test_history_fallback_is_marked_and_dated(monkeypatch):
    """
    외부 소스가 전멸하면 수집기가 쌓아 둔 이력으로 대체하되, 화면이
    "지금 시점의 수급이 아니다"라고 경고할 수 있도록 표시해야 합니다.
    """
    monkeypatch.setattr(
        radar, "read_from_history",
        lambda *a, **k: {
            "source": "누적 이력 (수집기가 2026-09-10에 저장한 값 · 외부 소스 전부 실패)",
            "sourceKind": "history",
            "isHistorical": True,
            "historyDate": "2026-09-10",
            "rows": _rows("누적 이력"),
        },
    )

    result = radar.collect_radar_ranking(date(2026, 9, 11))

    assert result["isHistorical"] is True
    assert result["historyDate"] == "2026-09-10"
    assert "누적 이력" in result["source"]


def test_total_failure_returns_empty_not_fabricated():
    result = radar.collect_radar_ranking(date(2026, 9, 11))

    assert result["rows"] == []
    assert result["sourceKind"] == "none"


@pytest.mark.xfail(strict=True, reason="QA-399: silence_sources가 KRX 저장본 단계를 막지 않아 기본 DB 주소로 접속을 시도합니다")
def test_QA399_기본_스텁만으로는_DB_풀을_열지_않는다(monkeypatch):
    """
    이 파일의 시험은 ``store`` 픽스처를 쓰지 않습니다. 그래서 체인의 KRX 저장본 단계(fetch_krx_stored_ranking)가 스텁 없이 돌면
    ``DATABASE_URL`` 기본값(localhost:5432/macrodash — 이 PC에서는 다른 스택의 자리)으로 풀을 열려 하고, 닿지 않으면 5초씩 기다립니다.
    그 단계는 저장소 예외를 삼키므로(빈 결과) 부른 사실을 따로 적어 봅니다.
    """
    from app import store

    opened: list[str] = []

    def refuse():
        opened.append("get_pool")
        raise RuntimeError("시험이 DB 풀을 열려 했습니다")

    monkeypatch.setattr(store, "get_pool", refuse)

    radar.collect_radar_ranking(date(2020, 1, 6))                 # 과거 평일 — 그 날짜의 KRX 저장본만 봅니다
    radar.collect_radar_ranking(datetime.now(KST).date())         # 당일 — 가장 가까운 앞 거래일의 KRX 저장본

    assert opened == [], "레이더 체인 시험은 DB 없이 돌아야 합니다"


def test_past_date_skips_current_only_sources(monkeypatch):
    """
    Naver/Daum/KIS는 과거 날짜 조회를 지원하지 않습니다. 과거 조회에서
    이들을 부르면 '오늘 값'을 과거 날짜 데이터로 착각하게 됩니다.
    """
    monkeypatch.setattr(radar, "is_regular_session", lambda now=None: True)
    called = {"daum": 0, "naver": 0, "toss": 0}

    def daum(*args, **kwargs):
        called["daum"] += 1
        return []

    def naver(*args, **kwargs):
        called["naver"] += 1
        return []

    def toss(*args, **kwargs):
        called["toss"] += 1
        return []

    monkeypatch.setattr(radar, "fetch_daum_ranking", daum)
    monkeypatch.setattr(radar, "fetch_naver_ranking", naver)
    monkeypatch.setattr(radar, "fetch_toss_ranking", toss)
    monkeypatch.setattr(
        radar, "read_from_history",
        lambda *a, **k: {"source": "누적 이력", "sourceKind": "history", "isHistorical": True,
                         "historyDate": "2020-01-06", "rows": _rows("누적 이력")},
    )

    result = radar.collect_radar_ranking(date(2020, 1, 6))    # 과거 평일

    assert called == {"daum": 0, "naver": 0, "toss": 0}
    assert result["sourceKind"] == "history", "과거 날짜는 누적 이력만 봅니다(날짜를 지정해 받는 외부 출처 없음)"


def test_latest_completed_session_handles_weekend():
    saturday = datetime(2026, 9, 12, 8, 0, tzinfo=KST)   # 토요일
    assert radar.latest_completed_session(saturday) == "20260911"

    weekday_morning = datetime(2026, 9, 11, 7, 0, tzinfo=KST)  # 금요일 장 시작 전
    assert radar.latest_completed_session(weekday_morning) == "20260910"

    weekday_open = datetime(2026, 9, 11, 10, 0, tzinfo=KST)
    assert radar.latest_completed_session(weekday_open) == "20260911"


def test_regular_session_boundaries():
    assert radar.is_regular_session(datetime(2026, 9, 11, 9, 0, tzinfo=KST)) is True
    assert radar.is_regular_session(datetime(2026, 9, 11, 15, 29, tzinfo=KST)) is True
    assert radar.is_regular_session(datetime(2026, 9, 11, 15, 30, tzinfo=KST)) is False
    assert radar.is_regular_session(datetime(2026, 9, 12, 10, 0, tzinfo=KST)) is False


def test_rank_orders_by_amount_and_renumbers():
    records = [
        {"code": "A", "netAmountEok": 10.0},
        {"code": "B", "netAmountEok": 50.0},
        {"code": "C", "netAmountEok": 30.0},
    ]
    ranked = radar._rank(list(records), "순매수", 3)
    assert [r["code"] for r in ranked] == ["B", "C", "A"]
    assert [r["rank"] for r in ranked] == [1, 2, 3]

    sells = [
        {"code": "A", "netAmountEok": -10.0},
        {"code": "B", "netAmountEok": -50.0},
    ]
    ranked_sells = radar._rank(list(sells), "순매도", 2)
    assert [r["code"] for r in ranked_sells] == ["B", "A"]


# ==============================================================================
# 실패 사유 안내
# ==============================================================================
def test_소스가_모두_없는_조합은_이유를_돌려준다():
    """
    화면에 "수집기 상태를 확인하세요"만 뜨면, 수집기가 멀쩡한 경우에도
    그쪽을 보게 됩니다. 실제 원인은 대개 '이 소스는 이 투자주체를 원래
    안 준다'입니다.
    """
    reasons = radar.diagnose_sources("개인")

    assert any("Daum" in r and "개인" in r for r in reasons)
    assert not any("LS" in r or "pykrx" in r.lower() for r in reasons), "뺀 출처는 사유에 나오지 않습니다"


def test_조사가_받침에_맞게_붙는다():
    """'개인'를 → '개인'은 …처럼 읽히는 문장을 막습니다."""
    assert radar._object_particle("개인") == "을"      # 받침 ㄴ
    assert radar._object_particle("금융투자") == "를"   # 받침 없음
    assert radar._object_particle("연기금") == "을"     # 받침 ㅁ
    assert radar._object_particle("") == "를"


def test_toss_runs_after_naver(monkeypatch):
    monkeypatch.setattr(radar, "is_regular_session", lambda now=None: False)
    order: list[str] = []

    def naver_call(*args, **kwargs):
        order.append("naver")
        return []

    def toss_call(*args, **kwargs):
        order.append("toss")
        return _rows("토스증권 공식 — 거래대금 상위 100종목 중 순위")

    monkeypatch.setattr(radar, "fetch_naver_ranking", naver_call)
    monkeypatch.setattr(radar, "fetch_toss_ranking", toss_call)

    result = radar.collect_radar_ranking(datetime.now(KST).date(), investor="연기금")

    assert result["sourceKind"] == "toss"
    assert order == ["naver", "toss"]


def test_history_fallback_receives_the_requested_interval(monkeypatch):
    """체인이 끝까지 실패하면 이력도 같은 기간 구간으로 읽어야 합니다(DAYS_5 요청에 TODAY 이력을 주지 않도록)."""
    seen = {}

    def history(target_day, market, investor, trade_type, top_n, interval_type="TODAY"):
        seen["interval"] = interval_type
        return None

    monkeypatch.setattr(radar, "read_from_history", history)
    radar.collect_radar_ranking(date(2026, 9, 11), interval_type="DAYS_5")
    assert seen["interval"] == "DAYS_5"


def test_QA028_기관_기간_요청은_당일로_받았다고_밝힌다(monkeypatch):
    """Daum은 기관합계의 5일·20일을 지원하지 않아 당일로 받습니다. 결과가 그 사실을 밝혀야 저장하는 쪽이 거를 수 있습니다."""
    monkeypatch.setattr(radar, "fetch_daum_ranking", lambda *a, **k: _rows("Daum API (기관, 당일, 20260911)"))

    result = radar.collect_radar_ranking(date(2026, 9, 11), investor="기관", interval_type="DAYS_5")

    assert result["rows"]
    assert result["intervalType"] == "TODAY"


def test_QA028_기간_조회가_실패해_당일로_바뀌면_밝힌다(monkeypatch):
    monkeypatch.setattr(radar, "is_regular_session", lambda now=None: False)

    def daum(target, market, investor, trade_type, top_n, interval_type="TODAY"):
        return [] if interval_type != "TODAY" else _rows("Daum API (외국인, 당일)")

    monkeypatch.setattr(radar, "fetch_daum_ranking", daum)
    monkeypatch.setattr(radar, "latest_completed_session", lambda now=None: "20260911")
    result = radar.collect_radar_ranking(date(2026, 9, 11), investor="외국인", interval_type="DAYS_5")

    assert result["rows"]
    assert result["intervalType"] == "TODAY"


def test_QA028_기간_조회가_되면_그_기간이다(monkeypatch):
    monkeypatch.setattr(radar, "fetch_daum_ranking", lambda *a, **k: _rows("Daum API (외국인, 5일)"))
    result = radar.collect_radar_ranking(date(2026, 9, 11), investor="외국인", interval_type="DAYS_5")
    assert result.get("intervalType", "DAYS_5") == "DAYS_5"
