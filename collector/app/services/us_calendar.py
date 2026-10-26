"""
app/services/us_calendar.py
미국 발표·실적 일정 — 모의 매매(운영자 전용 기능) Claude 계좌 패킷 섹션 ``1b_calendar``의 원자료(2단계 명세 A1·A2·§10).

이 모듈은 "받아서 추린다"까지만 합니다. 기준일 창(다음 세션부터 10거래일)과 보유·후보 종목 고르기는 백엔드 PacketBuilder가
저장본을 읽어 합니다 — 수집기는 계좌 보유를 모릅니다(ADR 0008, 백엔드 테이블). 규칙 계좌·검증기는 이 자료를 읽지 않습니다(D35).

[거시 일정 — FRED 발표 일정 API]
- 릴리스마다 ``fred/release/dates?release_id=`` 한 건(4회). 전체 목록 ``fred/releases/dates``는 101번(FOMC 보도자료)이 매일
  날짜를 내서 1,000건 상한에 걸립니다(단계 0).
- ``include_release_dates_with_no_data=true``가 있어야 앞날짜가 나옵니다(없으면 지난 발표만). FRED는 그해 12-31까지만 줍니다.
- 기존 FRED 세션(get_fred_session)·키(settings.fred_key)·응답 대기(fred.FRED_TIMEOUT)를 씁니다. 키는 오류 문구에 싣지 않습니다
  (응답 본문도 싣지 않음 — 400 본문이 키 형식을 말하는 경우가 있음).

[FOMC — 연준 공개 연간 일정표 상수]
FOMC 회의 일정은 API가 없어(FRED 101번은 매일 날짜) 연준 일정표를 상수로 둡니다. 연 1회 갱신. 상수 끝이 수집 창 안에 들어오면
상태가 '갱신 필요'가 됩니다.

[실적 일정 — yfinance quoteSummary calendarEvents]
- ``yf.Ticker(t)._quote._fetch(['calendarEvents'])``(yfinance 1.7.0 내부 호출, 단계 0과 같은 호출)의
  ``calendarEvents.earnings.earningsDate``(시각 포함 epoch)와 ``isEarningsDateEstimate``.
- 공개 ``Ticker.calendar``는 같은 epoch을 **프로세스 시간대**로 날짜로 바꿔(컨테이너 KST면 장 마감 뒤 발표가 하루 밀림 — 단계 0에서
  28종목) 쓰지 않고, ``earnings_dates``는 HTML 스크래핑이라 D29에 어긋나 쓰지 않습니다.
- 내부 호출이라 버전을 고정(requirements 1.7.0)하고 원본 고정본으로 시험합니다. 메서드나 응답 모양이 바뀌면 InternalApiChanged —
  태스크가 실적 일정을 멈추고 EmptyResult('yfinance 내부 API 변경')로 실패를 알립니다(실적은 직전 값을 잇고 거시 일정은 저장,
  다른 태스크는 영향 없음).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import yfinance as yf
from yfinance.exceptions import YFException, YFRateLimitError

from .. import http, logredact, settings, yfcache
from ..http import brief_error, get_fred_session
from .fred import FRED_TIMEOUT

logger = logging.getLogger(__name__)

# 병렬 수집 전에 캐시 폴더를 만들어 둡니다 (yfcache 참고).
yfcache.configure()

NEW_YORK = ZoneInfo("America/New_York")


# ==============================================================================
# 거시 일정 — FRED 릴리스
# ==============================================================================
@dataclass(frozen=True)
class Release:
    release_id: int
    key: str        # 저장본·패킷의 짧은 이름(lastKnownDate 키)
    name: str       # 패킷에 나가는 이름
    agency: str     # 발표 기관(FRED는 일정을 옮겨 줄 뿐)


# 단계 0(2026-10-25)에 FRED releases 목록으로 ID를 확인했습니다. GDP·PCE 날짜는 BEA 공식 일정과 같았습니다(10-29·11-25·12-23).
RELEASES: tuple[Release, ...] = (
    Release(10, "CPI", "CPI (Consumer Price Index)", "BLS"),
    Release(54, "PCE", "PCE (Personal Income and Outlays)", "BEA"),
    Release(50, "EMPLOYMENT", "Employment Situation (고용보고서)", "BLS"),
    Release(53, "GDP", "GDP (Gross Domestic Product)", "BEA"),
)

FRED_SOURCE = "FRED release/dates (api.stlouisfed.org)"


class CalendarFetchError(RuntimeError):
    """한 릴리스의 일정을 받지 못함 — 사유는 화면에 뜨는 한 줄(키·응답 본문 없음)."""


def fetch_release_dates(release_id: int, start: date, end: date) -> list[str]:
    """
    한 릴리스의 발표일(YYYY-MM-DD, 오름차순, 중복 없음) 중 ``start``~``end``(양끝 포함)만.

    키가 있어야 합니다(부르는 쪽이 먼저 확인 — 없으면 '키 미설정'으로 이 함수를 부르지 않음). 웹 CSV 같은 키 없는 경로는
    없습니다(발표 일정은 API만 줌).

    :raises CalendarFetchError: 연결·HTTP·JSON·모양 오류
    """
    key = settings.fred_key()
    if not key:
        raise CalendarFetchError("FRED_API_KEY 미설정")
    params = {
        "release_id": release_id,
        "api_key": key,
        "file_type": "json",
        # 이것이 없으면 이미 지난(자료가 있는) 발표일만 옵니다 — 단계 0: CPI가 false면 10-14 하나, true면 10-14·11-10·12-10.
        "include_release_dates_with_no_data": "true",
        "realtime_start": start.isoformat(),
        "realtime_end": end.isoformat(),
        "sort_order": "asc",
    }
    try:
        res = get_fred_session().get(f"{settings.FRED_API_BASE}/release/dates", params=params, timeout=FRED_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — 연결 오류 문구에 요청 URL(키 포함)이 섞일 수 있어 가린 한 줄만 남깁니다
        # 403은 FRED 세션의 어댑터가 출처 거부(SourceRejected)로 올립니다(http.py) — 아래 상태 코드 분기와 같은 키 안내를 붙입니다.
        hint = " — FRED_API_KEY 확인" if isinstance(exc, http.SourceRejected) and exc.why == "HTTP 403" else ""
        raise CalendarFetchError(logredact.redact(brief_error(exc)) + hint) from None
    if res.status_code != 200:
        hint = " — FRED_API_KEY 확인" if res.status_code in (400, 401, 403) else ""
        raise CalendarFetchError(f"HTTP {res.status_code}{hint}")
    try:
        body = res.json()
    except ValueError:
        raise CalendarFetchError("응답을 JSON으로 읽지 못했습니다") from None
    rows = body.get("release_dates") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise CalendarFetchError("응답에 release_dates가 없습니다")
    return parse_release_dates(rows, release_id, start, end)


def parse_release_dates(rows: list, release_id: int, start: date, end: date) -> list[str]:
    """응답의 release_dates 행 → 창 안의 날짜(오름차순·중복 없음). 다른 릴리스 행·읽을 수 없는 날짜는 버립니다."""
    out: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("release_id") not in (None, release_id):
            continue
        day = _parse_day(row.get("date"))
        if day is not None and start <= day <= end:
            out.add(day.isoformat())
    return sorted(out)


# ==============================================================================
# FOMC — 연준 공개 연간 일정표 (상수)
# ==============================================================================
FOMC_SOURCE = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
# 이 상수를 연준 일정표와 대조한 날(단계 0)과, 그때 일정표에 적힌 마지막 갱신일.
FOMC_CHECKED_AT = "2026-10-25"
FOMC_PAGE_UPDATED = "2026-10-07"

# (회의 첫날, 성명 발표일 = 둘째 날, 경제전망 SEP 동반). 일정표의 '*' 표시가 SEP입니다.
# 연준 주석: 2028-01-25~26 회의가 잡혀 있고, 각 회의 날짜는 바로 앞 회의에서 확정될 때까지 잠정입니다.
FOMC_MEETINGS: tuple[tuple[str, str, bool], ...] = (
    ("2026-01-27", "2026-01-28", False),
    ("2026-03-17", "2026-03-18", True),
    ("2026-04-28", "2026-04-29", False),
    ("2026-06-16", "2026-06-17", True),
    ("2026-07-28", "2026-07-29", False),
    ("2026-09-15", "2026-09-16", True),
    ("2026-10-27", "2026-10-28", False),
    ("2026-12-08", "2026-12-09", True),
    ("2027-01-26", "2027-01-27", False),
    ("2027-03-16", "2027-03-17", True),
    ("2027-04-27", "2027-04-28", False),
    ("2027-06-08", "2027-06-09", True),
    ("2027-07-27", "2027-07-28", False),
    ("2027-09-14", "2027-09-15", True),
    ("2027-10-26", "2027-10-27", False),
    ("2027-12-07", "2027-12-08", True),
)

FOMC_THROUGH = FOMC_MEETINGS[-1][1]


def fomc_events(start: date, end: date) -> list[dict]:
    """성명 발표일이 ``start``~``end``(양끝 포함)인 회의. 날짜는 성명이 나오는 둘째 날입니다(시장이 반응하는 날)."""
    out = []
    for first_day, statement_day, sep in FOMC_MEETINGS:
        if start <= date.fromisoformat(statement_day) <= end:
            out.append({
                "name": "FOMC 성명 (경제전망 SEP 포함)" if sep else "FOMC 성명",
                "date": statement_day,
                "kind": "FOMC",
                "releaseId": None,
                "source": FOMC_SOURCE,
                "sep": sep,
                "meetingStart": first_day,
            })
    return out


def fomc_status(end: date) -> str:
    """수집 창 끝이 상수 끝을 넘으면 '갱신 필요' — 그 뒤 회의가 저장본에서 조용히 빠지지 않게(연 1회 갱신)."""
    return "ok" if end <= date.fromisoformat(FOMC_THROUGH) else "갱신 필요"


# ==============================================================================
# 실적 일정 — yfinance quoteSummary calendarEvents
# ==============================================================================
# Yahoo는 장 구분을 시각 대신 고정된 UTC 시각으로 적습니다(단계 0의 60종목: 12:30 UTC 32건·20:00 UTC 28건, 그 밖 0건).
# 동부 시각으로 가르면 서머타임이 끝난 뒤(11월) 20:00 UTC = 15:00 EST가 '장중'으로 보여 틀립니다(단계 0의 AMD 11-03).
SESSION_BY_UTC = {(12, 30): "BMO", (20, 0): "AMC"}

EARNINGS_SOURCE = "yfinance quoteSummary calendarEvents"


class InternalApiChanged(RuntimeError):
    """yfinance 내부 호출(Ticker._quote._fetch)이 없어졌거나 받는 방식이 바뀜 — 실적 일정을 멈춥니다."""


class RateLimited(RuntimeError):
    """Yahoo 429 — 이번 실행에서는 더 묻지 않습니다(다른 Yahoo 태스크와 같은 한도를 나눠 씀)."""


class ShapeError(ValueError):
    """응답 모양이 단계 0에서 본 것과 다름(한 종목). 여러 종목에서 나면 태스크가 내부 API 변경으로 봅니다."""


def yfinance_version() -> str:
    return str(getattr(yf, "__version__", "?"))


def fetch_calendar_events(ticker: str) -> dict | None:
    """
    한 종목의 quoteSummary 원문(``calendarEvents`` 모듈만). None = 응답 없음 — yfinance가 HTTP 오류를 로그로만 남기고
    숨깁니다(없는 종목·ETF의 404, 서버 오류 모두). 그래서 None은 '그 종목 실패'로 다룹니다.

    :raises InternalApiChanged: 내부 메서드가 없음·모듈 이름이 받아들여지지 않음
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
        return fetch(["calendarEvents"])
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
            raise InternalApiChanged("calendarEvents 모듈을 받아들이지 않음") from None
        raise


@dataclass(frozen=True)
class Earnings:
    date: str | None            # 다음 실적 발표일(미국 동부 날짜). 없거나 이미 지났으면 None
    session: str | None         # BMO(장전)·AMC(장후)·None(그 밖·추정치)
    is_estimated: bool | None   # isEarningsDateEstimate(없으면 None)
    epoch: int | None           # 고른 발표 시각(초, UTC)
    note: str | None            # '다음 일정 미정'·'실적일 없음'
    last_date: str | None       # 다음 일정 미정일 때 마지막으로 보인(지난) 발표일
    has_module: bool            # 응답에 calendarEvents가 있었는가(내부 API 변경 감시용)


def parse_earnings(raw, now: datetime) -> Earnings:
    """
    quoteSummary 원문 → 다음 실적 발표 하나.

    - earningsDate(epoch 목록) 가운데 ``now`` 이후 가장 이른 것. 추정치 범위면 두 개가 오는데 앞의 것을 씁니다.
    - 날짜는 미국 동부 날짜(서버 TZ와 무관). 장 구분은 UTC 시각 12:30 → BMO, 20:00 → AMC, 그 밖은 None.
      추정치(``isEarningsDateEstimate``가 true)이거나 그 값이 없으면 시각이 자리표시라 장 구분을 None으로 둡니다.
    - 모두 지났으면 date None + '다음 일정 미정' + 마지막 날짜. 목록이 비었거나 calendarEvents·earnings가 없으면 date None.
      0이나 지어낸 날짜로 채우지 않습니다.

    :raises ShapeError: quoteSummary·result·earningsDate 모양이 다름
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("quoteSummary"), dict):
        raise ShapeError("quoteSummary 없음")
    result = raw["quoteSummary"].get("result")
    if not isinstance(result, list):
        raise ShapeError("quoteSummary.result가 목록이 아님")
    first = result[0] if result else {}
    if not isinstance(first, dict):
        raise ShapeError("quoteSummary.result[0]이 객체가 아님")
    events = first.get("calendarEvents")
    if events is None:
        return Earnings(None, None, None, None, "실적일 없음", None, has_module=False)
    if not isinstance(events, dict):
        raise ShapeError("calendarEvents가 객체가 아님")
    earnings = events.get("earnings")
    if earnings is None:
        return Earnings(None, None, None, None, "실적일 없음", None, has_module=True)
    if not isinstance(earnings, dict):
        raise ShapeError("calendarEvents.earnings가 객체가 아님")
    stamps = earnings.get("earningsDate", [])
    if not isinstance(stamps, list) or not all(isinstance(s, (int, float)) and not isinstance(s, bool) for s in stamps):
        raise ShapeError("earningsDate가 epoch 목록이 아님")
    estimate = earnings.get("isEarningsDateEstimate")
    is_estimated = estimate if isinstance(estimate, bool) else None

    if not stamps:
        return Earnings(None, None, is_estimated, None, "실적일 없음", None, has_module=True)
    now_epoch = now.timestamp()
    upcoming = sorted(int(s) for s in stamps if s >= now_epoch)
    if not upcoming:
        return Earnings(None, None, is_estimated, None, "다음 일정 미정", _ny_date(int(max(stamps))), has_module=True)
    epoch = upcoming[0]
    moment = datetime.fromtimestamp(epoch, timezone.utc)
    session = SESSION_BY_UTC.get((moment.hour, moment.minute)) if is_estimated is False else None
    return Earnings(_ny_date(epoch), session, is_estimated, epoch, None, None, has_module=True)


def _ny_date(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, NEW_YORK).date().isoformat()


def _parse_day(text) -> date | None:
    if not isinstance(text, str):
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None
