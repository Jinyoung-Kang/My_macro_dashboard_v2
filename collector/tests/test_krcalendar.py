"""
tests/test_krcalendar.py
거래일·장중 판정이 공휴일을 아는지.
"""
from __future__ import annotations

from datetime import date, datetime

import pytest

from app import krcalendar
from app.krcalendar import KST


@pytest.fixture(autouse=True)
def holidays():
    krcalendar.set_holidays({"2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18"})
    yield
    krcalendar.set_holidays(())


def test_평일_공휴일_아침_이후에는_전_거래일이_최근_거래일이다():
    """
    2026-01-01(목) 10:00에 Daum이 주는 랭킹은 12-30(화)의 것입니다(12-31(수)은 KRX 연말 휴장, QA-081).
    주말만 건너뛰면 이 데이터가 01-01로 쌓여 하루가 복제됩니다.
    """
    assert krcalendar.latest_completed_session(datetime(2026, 1, 1, 10, 0, tzinfo=KST)) == "20251230"


def test_연휴_뒤_장_시작_전에는_연휴_전_거래일이다():
    # 설 연휴 02-16(월)~18(수) → 02-19(목) 08:00의 최근 거래일은 02-13(금)
    assert krcalendar.latest_completed_session(datetime(2026, 2, 19, 8, 0, tzinfo=KST)) == "20260213"
    assert krcalendar.latest_completed_session(datetime(2026, 2, 19, 9, 0, tzinfo=KST)) == "20260219"


def test_주말_규칙은_그대로다():
    assert krcalendar.latest_completed_session(datetime(2026, 9, 12, 8, 0, tzinfo=KST)) == "20260911"   # 토
    assert krcalendar.latest_completed_session(datetime(2026, 9, 11, 7, 0, tzinfo=KST)) == "20260910"   # 금 장전
    assert krcalendar.latest_completed_session(datetime(2026, 9, 11, 10, 0, tzinfo=KST)) == "20260911"


def test_공휴일에는_장중이_아니다():
    assert krcalendar.is_regular_session(datetime(2026, 1, 1, 10, 0, tzinfo=KST)) is False
    assert krcalendar.is_regular_session(datetime(2026, 1, 2, 10, 0, tzinfo=KST)) is True
    assert krcalendar.is_regular_session(datetime(2026, 1, 2, 15, 30, tzinfo=KST)) is False


def test_이전_거래일_목록은_공휴일과_주말을_건너뛴다():
    days = krcalendar.previous_trading_days(date(2026, 2, 19), 3)
    assert days == [date(2026, 2, 13), date(2026, 2, 12), date(2026, 2, 11)]


def test_공휴일_목록이_비어_있으면_주말만_건너뛴다():
    krcalendar.set_holidays(())
    assert krcalendar.latest_completed_session(datetime(2026, 1, 1, 10, 0, tzinfo=KST)) == "20260101"


def test_QA081_평일인_12월_31일은_KRX_연말_휴장이다():
    """
    KRX는 12-31(평일이면)에 열지 않습니다(화면 marketCalendar.ts와 같은 규칙). 수집기 달력이 그날을 거래일로 보면
    날짜를 밝히지 않는 소스(KIS 가집계·Daum 기간 응답)의 전 거래일 데이터가 12-31 날짜로 이력에 쌓이고,
    12-31 장중에는 KIS를 먼저 부릅니다. 이 판정은 공휴일 목록(천문연)과 별개입니다.
    """
    krcalendar.set_holidays({"2026-12-25", "2027-01-01"})
    assert krcalendar.is_trading_day(date(2026, 12, 31)) is False
    assert krcalendar.is_regular_session(datetime(2026, 12, 31, 10, 0, tzinfo=KST)) is False
    assert krcalendar.latest_completed_session(datetime(2026, 12, 31, 10, 0, tzinfo=KST)) == "20261230"
    assert krcalendar.latest_completed_session(datetime(2027, 1, 1, 10, 0, tzinfo=KST)) == "20261230"
    assert krcalendar.previous_trading_days(date(2027, 1, 4), 2) == [date(2026, 12, 30), date(2026, 12, 29)]
    # 공휴일 목록이 비어 있어도(첫 기동) 연말 휴장은 압니다.
    krcalendar.set_holidays(())
    assert krcalendar.is_trading_day(date(2026, 12, 31)) is False


# ── QA-142: 연말 휴장일의 주말·공휴일 대체 ─────────────────────────────────────────────
# KRX 연말 휴장일은 12-31이고, 그날이 토·일·공휴일이면 그 직전 매매거래일을 쉽니다. KRX 휴장일 목록의 실례가
# 2022-12-30(금, 12-31 토)·2023-12-29(금, 12-31 일)이고, 앞으로는 2028-12-29(금, 12-31 일)·2033-12-30·2034-12-29입니다
# (v2 2단계 명세 §4-4·K27). 달력이 12-31만 더하면 그 금요일을 거래일로 보아, 날짜를 밝히지 않는 소스(KIS 가집계·Daum 기간
# 응답)의 전 거래일 데이터가 휴장일 날짜로 이력에 쌓입니다(QA-081과 같은 모양). 2026·2027은 12-31이 평일이라 영향이 없습니다.
KR_HOLIDAYS_2028 = {
    "2028-01-01", "2028-01-26", "2028-01-27", "2028-01-28", "2028-03-01", "2028-04-12",
    "2028-05-01", "2028-05-02", "2028-05-05", "2028-06-06", "2028-07-17", "2028-08-15",
    "2028-10-02", "2028-10-03", "2028-10-04", "2028-10-05", "2028-10-09", "2028-12-25",
    "2029-01-01",
}


@pytest.mark.xfail(strict=True, reason="QA-142 재현: 12-31이 일요일인 2028년에 직전 금요일(12-29)을 거래일로 봄")
def test_QA142_12월_31일이_일요일이면_직전_금요일이_연말_휴장이다_2028():
    krcalendar.set_holidays(KR_HOLIDAYS_2028)
    assert krcalendar.is_trading_day(date(2028, 12, 29)) is False
    assert krcalendar.is_trading_day(date(2028, 12, 28)) is True
    assert krcalendar.is_regular_session(datetime(2028, 12, 29, 10, 0, tzinfo=KST)) is False
    assert krcalendar.latest_completed_session(datetime(2028, 12, 29, 10, 0, tzinfo=KST)) == "20281228"
    assert krcalendar.latest_completed_session(datetime(2029, 1, 2, 8, 0, tzinfo=KST)) == "20281228"
    assert krcalendar.previous_trading_days(date(2029, 1, 2), 2) == [date(2028, 12, 28), date(2028, 12, 27)]


@pytest.mark.xfail(strict=True, reason="QA-142 재현: KRX 실례 2022-12-30(12-31 토)·2023-12-29(12-31 일)를 거래일로 봄")
def test_QA142_KRX_실례_2022_12_30과_2023_12_29는_연말_휴장이다():
    krcalendar.set_holidays({"2022-12-25", "2023-01-01", "2023-12-25", "2024-01-01"})
    assert krcalendar.is_trading_day(date(2022, 12, 30)) is False
    assert krcalendar.is_trading_day(date(2022, 12, 29)) is True
    assert krcalendar.is_trading_day(date(2023, 12, 29)) is False
    assert krcalendar.is_trading_day(date(2023, 12, 28)) is True


@pytest.mark.xfail(strict=True, reason="QA-142 재현: 공휴일 목록이 없는 해(첫 기동)에도 주말 대체는 규칙만으로 알 수 있음")
def test_QA142_공휴일_목록이_비어도_주말_대체는_안다():
    krcalendar.set_holidays(())
    assert krcalendar.is_trading_day(date(2028, 12, 29)) is False
    assert krcalendar.is_trading_day(date(2033, 12, 30)) is False   # 12-31 토
    assert krcalendar.is_trading_day(date(2034, 12, 29)) is False   # 12-31 일


@pytest.mark.xfail(strict=True, reason="QA-142 재현: 12-31이 평일 공휴일이면 직전 매매거래일이 연말 휴장")
def test_QA142_12월_31일이_평일_공휴일이면_직전_매매거래일이_연말_휴장이다():
    """가상의 해: 2029-12-31(월)이 임시공휴일이면 직전 매매거래일 12-28(금)이 연말 휴장일입니다(주말 12-29·30을 건너뜀)."""
    krcalendar.set_holidays({"2029-12-25", "2029-12-31", "2030-01-01"})
    assert krcalendar.is_trading_day(date(2029, 12, 31)) is False
    assert krcalendar.is_trading_day(date(2029, 12, 28)) is False
    assert krcalendar.is_trading_day(date(2029, 12, 27)) is True


def test_QA142_12월_31일이_평일인_해는_그대로다():
    """2026-12-31(목)·2027-12-31(금)은 그날만 쉬고 12-30은 엽니다 — 대체 규칙이 평일 12-31을 건드리지 않습니다."""
    krcalendar.set_holidays({"2026-12-25", "2027-01-01", "2027-12-27", "2028-01-01"})
    assert krcalendar.is_trading_day(date(2026, 12, 31)) is False
    assert krcalendar.is_trading_day(date(2026, 12, 30)) is True
    assert krcalendar.is_trading_day(date(2027, 12, 31)) is False
    assert krcalendar.is_trading_day(date(2027, 12, 30)) is True
    assert krcalendar.previous_trading_days(date(2028, 1, 3), 2) == [date(2027, 12, 30), date(2027, 12, 29)]
