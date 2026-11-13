"""
tests/test_uscalendar.py
미국 증시 휴장일(app/uscalendar — ADR 0040). 백엔드 UsMarketCalendarTest와 같은 해의 같은 날짜를 대조합니다.

고정하는 규칙
  1. 2024~2027 휴장일이 정확히 NYSE 공지와 같은 목록(백엔드·화면 규칙과 같음 — 임시 휴장은 담지 않음).
  2. 신정이 토요일이면 전년 12-31(금)은 쉬지 않는다(NYSE Rule 7.2).
  3. 거래일 = 평일이고 휴장일이 아님. 주말은 휴장일 목록에 없다.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from app import uscalendar


def _holidays_of(year: int) -> list[str]:
    day = date(year, 1, 1)
    out = []
    while day.year == year:
        if uscalendar.is_holiday(day):
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


@pytest.mark.parametrize("year, expected", [
    (2024, ["2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
            "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25"]),
    # 2025-01-09(카터 애도일 임시 휴장)은 규칙 밖이라 없습니다(모듈 설명의 한계).
    (2025, ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
            "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"]),
    (2026, ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
            "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]),
    (2027, ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
            "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]),
])
def test_그해_휴장일이_백엔드와_같은_목록(year, expected):
    assert _holidays_of(year) == expected


def test_신정이_토요일이면_전년_12월_31일은_개장():
    # 2022-01-01·2028-01-01이 토요일.
    assert date(2022, 1, 1).weekday() == 5 and date(2028, 1, 1).weekday() == 5
    assert not uscalendar.is_holiday(date(2021, 12, 31)) and uscalendar.is_trading_day(date(2021, 12, 31))
    assert not uscalendar.is_holiday(date(2027, 12, 31)) and uscalendar.is_trading_day(date(2027, 12, 31))


def test_거래일은_평일이고_휴장일이_아닌_날():
    assert uscalendar.is_trading_day(date(2026, 11, 13))          # 금
    assert not uscalendar.is_trading_day(date(2026, 11, 14))      # 토
    assert not uscalendar.is_trading_day(date(2026, 11, 15))      # 일
    assert not uscalendar.is_trading_day(date(2026, 11, 26))      # 추수감사절
    assert uscalendar.is_trading_day(date(2026, 11, 27))          # 추수감사절 다음 날(조기 폐장이지만 거래일)
    assert not uscalendar.is_holiday(date(2026, 11, 14))          # 주말은 휴장일 목록에 없음
