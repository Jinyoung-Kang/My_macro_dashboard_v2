"""
app/uscalendar.py
미국 증시(NYSE·NASDAQ) 정규장 휴장일 — 백엔드 ``analytics.UsMarketCalendar``·화면 ``lib/marketCalendar.ts``의 ``usMarketHolidays``와 같은 규칙.

수집기는 지금까지 미국 휴장일을 몰랐습니다(장중 스탑 감시는 응답에서 그날 휴장을 배움 — tasks/paper_stopwatch). 사건 뉴스 피드의 '활발한
시간'(ADR 0040 — tasks/news_feeds)이 미국 세션 날짜가 거래일인지 알아야 해서 같은 규칙을 옮겼습니다. 규칙(고정 날짜는 토→금·일→월):
신정(토요일이면 전년 12-31에 쉬지 않음 — NYSE Rule 7.2) · 마틴 루터 킹 데이(1월 셋째 월) · 대통령의 날(2월 셋째 월) · 성금요일 ·
메모리얼 데이(5월 마지막 월) · 준틴스(6-19) · 독립기념일(7-4) · 노동절(9월 첫째 월) · 추수감사절(11월 넷째 목) · 크리스마스(12-25).

한계는 백엔드와 같습니다 — 임시 휴장(애도일·허리케인)은 담지 못합니다. 조기 폐장은 다루지 않습니다(날짜만 씀).
시험(tests/test_uscalendar.py)은 백엔드 UsMarketCalendarTest와 같은 해(2024~2027)의 같은 날짜를 대조합니다.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from functools import lru_cache

_MONDAY, _THURSDAY, _SATURDAY, _SUNDAY = 0, 3, 5, 6


def _observed(day: date) -> date:
    """토요일이면 전날(금), 일요일이면 다음 날(월)."""
    if day.weekday() == _SATURDAY:
        return day - timedelta(days=1)
    if day.weekday() == _SUNDAY:
        return day + timedelta(days=1)
    return day


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = date(year, month, calendar.monthrange(year, month)[1])
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _easter_sunday(year: int) -> date:
    """부활절 일요일(Anonymous Gregorian algorithm) — 백엔드·화면과 같은 식."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741 — 알고리즘의 원래 이름
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


@lru_cache(maxsize=32)
def holidays(year: int) -> frozenset[date]:
    """그해 NYSE 정규장 휴장일(평일만 — 주말은 담지 않음)."""
    days: set[date] = set()
    new_year = date(year, 1, 1)
    if new_year.weekday() != _SATURDAY:
        days.add(_observed(new_year))
    days.add(_nth_weekday(year, 1, _MONDAY, 3))          # 마틴 루터 킹 데이
    days.add(_nth_weekday(year, 2, _MONDAY, 3))          # 대통령의 날
    days.add(_easter_sunday(year) - timedelta(days=2))   # 성금요일
    days.add(_last_weekday(year, 5, _MONDAY))            # 메모리얼 데이
    days.add(_observed(date(year, 6, 19)))               # 준틴스
    days.add(_observed(date(year, 7, 4)))                # 독립기념일
    days.add(_nth_weekday(year, 9, _MONDAY, 1))          # 노동절
    days.add(_nth_weekday(year, 11, _THURSDAY, 4))       # 추수감사절
    days.add(_observed(date(year, 12, 25)))              # 크리스마스
    return frozenset(days)


def is_holiday(day: date) -> bool:
    """NYSE 정규장 휴장일인지(주말은 휴장일이 아님 — 거래일 판정은 :func:`is_trading_day`)."""
    return day in holidays(day.year)


def is_trading_day(day: date) -> bool:
    """평일이고 휴장일이 아니면 거래일."""
    return day.weekday() < _SATURDAY and not is_holiday(day)
