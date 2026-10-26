"""
app/services/earnings_surprise.py
미국 종목 어닝 서프라이즈 — 모의 매매(운영자 전용 기능) Claude 계좌 패킷 섹션 ``8b_fundamentals``의 EPS 실제치·컨센서스
(2단계 명세 C1·§10·D36).

이 모듈은 "받아서 추린다"까지만 합니다. 기준일 이전 발표분 고르기(PIT)와 보유·후보 고르기는 백엔드가 저장본을 읽어 합니다
(ADR 0008 — 수집기는 계좌 보유를 모름). 규칙 계좌·검증기는 이 자료를 읽지 않습니다(D35).

[출처 — yfinance quoteSummary earnings]
- ``yf.Ticker(t)._quote._fetch(['earnings'])``(yfinance 1.7.0 내부 호출, 단계 0과 같은 모듈)의 ``earnings.earningsChart.quarterly``:
  분기마다 actual·estimate·surprisePct(문자열, 없을 수 있음)·periodEndDate(UTC 자정 epoch)·reportedDate(실제 발표 시각 epoch).
- 공개 ``Ticker.earnings_history``는 같은 값이지만 발표일이 없어 시점(PIT)을 자를 수 없으므로 쓰지 않습니다(단계 0).
- 한 번에 최근 4분기만 줍니다. 8분기는 관측치를 지우지 않고 쌓아야 찹니다(약 1년).
- 내부 호출이라 버전을 고정(requirements 1.7.0)하고 원본 고정본으로 시험합니다. 메서드·인자 모양이 바뀌면 InternalApiChanged —
  태스크가 EmptyResult('yfinance 내부 API 변경')로 멈추고 저장본(관측 행·상태)을 그대로 둡니다. 예외 종류는 실적 일정
  (services.us_calendar)과 같은 것을 씁니다 — 같은 내부 호출의 같은 고장이기 때문입니다.

[숫자 규칙]
- surprisePct는 응답 문자열을 쓰지 않고 (actual − estimate) / |estimate| × 100을 소수 둘째 자리로 계산합니다. 단계 0과 고정본에서
  Yahoo 문자열과 같았고(적자 기업의 음수 추정치는 분모 절댓값 — SPCX −0.28931 → +68.89%), 문자열은 빠지거나 형식이 바뀔 수 있습니다.
  추정치가 없거나 0이면 None(0으로 채우지 않음).
- |estimate| < 0.05면 smallBase — 분모가 작아 서프라이즈율이 수천 %가 되므로(INTC 0.00705 → 3,162%) 읽는 쪽이 가려 보게 합니다.
  추정치가 없으면 None(작다·크다를 말할 수 없음).
- 통화는 ``earnings.financialCurrency``(BIDU CNY·RACE EUR — ADR은 EPS가 본국 통화라 주가(USD)와 바로 비교할 수 없음). 없으면 None.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

import yfinance as yf
from yfinance.exceptions import YFException, YFRateLimitError

from .. import http
from ..http import brief_error
from .us_calendar import NEW_YORK, InternalApiChanged, RateLimited, ShapeError, yfinance_version  # noqa: F401 — 태스크가 여기서 씁니다

MODULE = "earnings"
SOURCE = "yfinance quoteSummary earnings.earningsChart"

# 추정치가 이보다 작으면(절댓값) smallBase(명세 C1).
SMALL_BASE = 0.05

# epoch(초) 칸이 받아들이는 범위 — 1970-01-01 뒤 ~ 2100-01-01 UTC 전. 밖의 값(밀리초로 바뀐 epoch·터무니없는 수)은 모양 변경으로
# 봅니다. 그대로 datetime.fromtimestamp에 넘기면 ValueError·OverflowError가 나 태스크 전체가 죽고, 상태가 그대로라 다음 실행도
# 같은 종목에서 다시 죽기 때문입니다(ShapeError면 그 종목만 실패).
EPOCH_MAX = 4_102_444_800


def fetch_earnings(ticker: str) -> dict | None:
    """
    한 종목의 quoteSummary 원문(``earnings`` 모듈만). None = 응답 없음 — yfinance가 HTTP 오류를 로그로만 남기고 숨깁니다
    (없는 종목·ETF의 404, 서버 오류 모두). 그래서 None은 '그 종목 실패'로 다룹니다.

    :raises InternalApiChanged: 내부 메서드가 없음·인자 모양이 바뀜·모듈 이름이 받아들여지지 않음
    :raises RateLimited: 429, 또는 공용 Yahoo 래치가 닫혀 있음(묻지 않음)
    """
    # 같은 Yahoo 한도를 나눠 쓰는 다른 태스크가 방금 429를 받았으면 묻지 않습니다(공용 래치, http.YAHOO_HOST).
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        raise RateLimited(str(latched))
    try:
        fetch = yf.Ticker(ticker)._quote._fetch
    except AttributeError as exc:
        raise InternalApiChanged(f"Ticker._quote._fetch 없음 ({type(exc).__name__})") from None
    try:
        return fetch([MODULE])
    except YFRateLimitError:
        http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")
        raise RateLimited("Yahoo 429(요청 제한)") from None
    except TypeError as exc:
        # 내부 메서드의 인자 모양이 바뀜(버전 고정이 풀린 경우). 그 밖의 TypeError는 그 종목만의 실패로 둡니다.
        if "argument" not in str(exc):
            raise
        raise InternalApiChanged(f"Ticker._quote._fetch 호출 방식 변경 ({brief_error(exc)})") from None
    except YFException as exc:
        if "valid modules" in str(exc):
            raise InternalApiChanged(f"{MODULE} 모듈을 받아들이지 않음") from None
        raise


@dataclass(frozen=True)
class Parsed:
    rows: list[tuple[str, dict]]  # (obs_date = 발표 시각의 미국 동부 날짜, payload), 발표 순
    has_module: bool              # 응답에 earnings가 있었는가(내부 API 변경 감시용)
    currency: str | None
    skipped: int                  # 발표 시각이 없거나 아직 오지 않은 분기 — 시점을 정할 수 없어 넣지 않음


def parse_earnings(raw, now: datetime) -> Parsed:
    """
    quoteSummary 원문 → 분기 행. 발표 시각(reportedDate)이 없는 분기와 ``now``보다 뒤인 분기는 넣지 않고 셉니다 — 저장 날짜(PIT 키)가
    발표 시각이라, 없으면 기준일로 자를 수 없고 미래 시각은 아직 나온 발표가 아닙니다. 같은 날짜에 두 분기가 오면 기간 끝이 늦은
    쪽을 남깁니다(하루에 한 행 — 저장 키가 (날짜, 티커)).

    :raises ShapeError: quoteSummary·result·earnings·earningsChart·quarterly 모양이 다름(earningsChart에 quarterly 칸이 없음,
        분기가 있는데 어느 분기에도 reportedDate 칸이 없음 포함), 숫자 칸이 숫자가 아님(``formatted=true``처럼 {raw, fmt} 객체로
        바뀐 경우 — 조용히 None으로 읽으면 '추정치 없음'이 수백 종목에 퍼짐), epoch 칸이 범위(``EPOCH_MAX``) 밖
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("quoteSummary"), dict):
        raise ShapeError("quoteSummary 없음")
    result = raw["quoteSummary"].get("result")
    if not isinstance(result, list):
        raise ShapeError("quoteSummary.result가 목록이 아님")
    first = result[0] if result else {}
    if not isinstance(first, dict):
        raise ShapeError("quoteSummary.result[0]이 객체가 아님")
    earnings = first.get(MODULE)
    if earnings is None:
        return Parsed([], has_module=False, currency=None, skipped=0)
    if not isinstance(earnings, dict):
        raise ShapeError("earnings가 객체가 아님")
    currency = earnings.get("financialCurrency")
    currency = currency.strip().upper() if isinstance(currency, str) and currency.strip() else None
    chart = earnings.get("earningsChart")
    if chart is None:
        return Parsed([], has_module=True, currency=currency, skipped=0)
    if not isinstance(chart, dict):
        raise ShapeError("earnings.earningsChart가 객체가 아님")
    # 칸이 빠진 것을 빈 목록으로 읽지 않습니다 — 이름이 바뀐 응답이 '분기 자료 없음'으로 성공 처리되면 모든 종목의 받은 시각이
    # 새로 찍혀 순서 ②(실적일 뒤 다시 묻기)가 사라지고, 새 분기가 조용히 쌓이지 않습니다.
    if "quarterly" not in chart:
        raise ShapeError("earningsChart.quarterly 없음")
    quarterly = chart["quarterly"]
    if not isinstance(quarterly, list):
        raise ShapeError("earningsChart.quarterly가 목록이 아님")

    now_epoch = now.timestamp()
    by_date: dict[str, tuple[int, dict]] = {}
    skipped = 0
    with_reported_key = 0
    for quarter in quarterly:
        if not isinstance(quarter, dict):
            raise ShapeError("earningsChart.quarterly 항목이 객체가 아님")
        with_reported_key += int("reportedDate" in quarter)
        reported = _epoch(quarter.get("reportedDate"), "reportedDate")
        period_end = _epoch(quarter.get("periodEndDate"), "periodEndDate")
        actual = _number(quarter.get("actual"), "actual")
        estimate = _number(quarter.get("estimate"), "estimate")
        if reported is None or reported > now_epoch:
            skipped += 1
            continue
        moment = datetime.fromtimestamp(reported, NEW_YORK)
        day = moment.date().isoformat()
        payload = {
            "periodEnd": datetime.fromtimestamp(period_end, timezone.utc).date().isoformat() if period_end is not None else None,
            "actual": actual,
            "estimate": estimate,
            "surprisePct": surprise_pct(actual, estimate),
            "currency": currency,
            "smallBase": None if estimate is None else abs(estimate) < SMALL_BASE,
            "reportedAt": moment.isoformat(),
            "source": SOURCE,
        }
        before = by_date.get(day)
        if before is None or (period_end or 0) >= before[0]:
            by_date[day] = (period_end or 0, payload)
    if quarterly and not with_reported_key:
        # 분기가 있는데 어느 분기에도 발표 시각 칸이 없으면 칸 이름이 바뀐 것입니다(단계 0: 60종목 모두 분기마다 있었음). 한 분기만
        # 빠진 것은 그 분기만 뺍니다(위 skipped).
        raise ShapeError("earningsChart.quarterly 어느 분기에도 reportedDate 칸이 없음")
    rows = sorted(((day, payload) for day, (_, payload) in by_date.items()), key=lambda row: row[1]["reportedAt"])
    return Parsed(rows, has_module=True, currency=currency, skipped=skipped)


def surprise_pct(actual: float | None, estimate: float | None) -> float | None:
    """(actual − estimate) / |estimate| × 100, 소수 둘째 자리. 둘 중 하나가 없거나 추정치가 0이면 None."""
    if actual is None or estimate is None or estimate == 0:
        return None
    return round((actual - estimate) / abs(estimate) * 100, 2)


def _number(value, field: str) -> float | None:
    """숫자 칸 — 없으면 None. bool·문자열·객체는 모양 변경. 무한대·NaN은 모르는 값(None)."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ShapeError(f"{field}가 숫자가 아님")
    return float(value) if math.isfinite(value) else None


def _epoch(value, field: str) -> int | None:
    """epoch(초) 칸 — 없으면 None. 범위(0 초과 ``EPOCH_MAX`` 미만) 밖이면 모양 변경(위 ``EPOCH_MAX`` 설명)."""
    number = _number(value, field)
    if number is None:
        return None
    if not 0 < number < EPOCH_MAX:
        raise ShapeError(f"{field}가 epoch 초 범위 밖")
    return int(number)
