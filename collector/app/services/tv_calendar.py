"""
app/services/tv_calendar.py
TradingView 경제 캘린더 — 미국·한국 지표 발표 일정과 예상치·이전치·실제치·중요도 (ADR 0026, 명세 docs/specs/2026-11-05-polite-fetch.md §6-1).

화면 전용입니다(운영자 화면의 경제 캘린더 카드). Claude 결정 패킷은 읽지 않습니다 — 패킷의 캘린더는 그대로 FRED 릴리스·FOMC 상수와
Nasdaq 컨센서스(``calendar.us_consensus``)입니다.

[출처 — ``economic-calendar.tradingview.com/events``, 비공식]
- 기본 요청(머리글 없음)은 nginx가 403으로 답합니다(2026-10-26·10-27 수집기, 2026-11-05 개발 PC의 기본 curl). TradingView 화면이 보내는
  ``Origin``을 싣고 브라우저와 같은 TLS로 보냅니다 — 차단 통과 계층(app/fetch)의 계층 1. v2 한국 책 명세 G11의 '머리글 변형은 사용자 허락
  뒤에만'은 2026-11-05 요청이 그 허락입니다.
- 응답은 ``{status, result: [{id, title, country, indicator, period, date(ISO UTC), actual, forecast, previous, unit, scale, currency,
  importance(-1 낮음·0 보통·1 높음), source, …}]}``로 알려져 있습니다(2026-10-26 조사 기록). **이 저장소의 자동 작업은 실제 응답을 직접 받아 보지
  못했습니다** — 그래서 읽기를 너그럽게 합니다: 아는 칸만 옮기고 없는 칸은 null(만들지 않음), 행마다 제목·나라·시각이 없으면 그 행만 버리고,
  받은 칸 이름(``fieldsSeen``)을 저장본에 남겨 모양이 다르면 실행 기록과 저장본에서 바로 보이게 합니다.
- 응답의 설명문(``comment``)과 링크는 저장하지 않습니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .. import kst
from ..fetch import ladder, policy

HOST = "economic-calendar.tradingview.com"
URL = f"https://{HOST}/events"
# TradingView 화면(www.tradingview.com/economic-calendar/)이 이 API를 부를 때의 요청 문맥.
ORIGIN = "https://www.tradingview.com"
SOURCE = "TradingView 경제 캘린더"
SOURCE_URL = "https://www.tradingview.com/economic-calendar/"
SOURCE_NOTE = "비공식 참고 — 차단 통과 계층으로 받음(ADR 0026). 화면 전용이고 Claude 결정 패킷에는 쓰지 않음"

COUNTRIES = ("US", "KR")
# 어제(발표된 실제치)부터 두 주 뒤까지.
DAYS_BACK = 1
DAYS_AHEAD = 14

IMPORTANCE_VALUES = (-1, 0, 1)
_NUMBER_FIELDS = ("actual", "forecast", "previous")
_TEXT_FIELDS = ("indicator", "period", "unit", "scale", "currency", "source")


class CalendarShapeError(ValueError):
    """받았지만 응답 모양이 기대와 다름 — 저장본을 덮지 않습니다."""


def window(now: datetime) -> tuple[datetime, datetime]:
    """묻는 창 — UTC 자정 기준 [오늘 − DAYS_BACK, 오늘 + DAYS_AHEAD)."""
    midnight = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight - timedelta(days=DAYS_BACK), midnight + timedelta(days=DAYS_AHEAD)


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fetch_events(now: datetime) -> dict:
    """
    창 안의 미국·한국 일정을 한 번에 받습니다 → {events, skipped, fieldsSeen, fetchTier, window}.

    :raises ladder.FetchRejected | ladder.FetchSkipped | ladder.FetchFailed: 차단 통과 계층의 사정(app/fetch/ladder)
    :raises CalendarShapeError: JSON이 아니거나 모양이 다름, 쓸 수 있는 행이 하나도 없음
    """
    start, end = window(now)
    got = ladder.fetch(
        URL,
        expect=policy.EXPECT_JSON,
        params={"from": _iso(start), "to": _iso(end), "countries": ",".join(COUNTRIES)},
        headers={"Origin": ORIGIN, "Referer": f"{ORIGIN}/"},
    )
    try:
        payload = got.json()
    except ValueError:
        raise CalendarShapeError("응답이 JSON이 아님") from None
    parsed = parse(payload)
    parsed["fetchTier"] = got.tier
    parsed["window"] = {"from": _iso(start), "to": _iso(end)}
    return parsed


def parse(payload) -> dict:
    """응답 → {events(시각순), skipped(버린 행 수), fieldsSeen(받은 칸 이름)}."""
    rows = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise CalendarShapeError("응답에 result 목록이 없음")
    events: list[dict] = []
    seen: set[str] = set()
    skipped = 0
    for row in rows:
        if not isinstance(row, dict):
            skipped += 1
            continue
        seen.update(str(key) for key in row)
        event = _event(row)
        if event is None:
            skipped += 1
        else:
            events.append(event)
    if not events:
        raise CalendarShapeError(f"쓸 수 있는 행이 없음(받은 행 {len(rows)}개)")
    events.sort(key=lambda event: (event["at"], event["country"], event["title"]))
    return {"events": events, "skipped": skipped, "fieldsSeen": sorted(seen)}


def _event(row: dict) -> dict | None:
    """행 하나 → 저장 항목. 제목·나라·시각 가운데 하나라도 없거나 모르는 나라면 None(그 행만 버림)."""
    title = row.get("title")
    country = row.get("country")
    at = _moment(row.get("date"))
    if not isinstance(title, str) or not title.strip() or country not in COUNTRIES or at is None:
        return None
    event = {
        "id": str(row["id"]) if isinstance(row.get("id"), (str, int)) and not isinstance(row.get("id"), bool) else None,
        "country": country,
        "title": title.strip(),
        "at": at.isoformat(timespec="seconds"),
        "atKst": kst.stamp(at),
        "importance": row.get("importance") if _is_int(row.get("importance")) and row["importance"] in IMPORTANCE_VALUES else None,
    }
    for name in _NUMBER_FIELDS:
        event[name] = _number(row.get(name))
    for name in _TEXT_FIELDS:
        value = row.get(name)
        event[name] = value.strip() if isinstance(value, str) and value.strip() else None
    return event


def _moment(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _number(value) -> float | int | None:
    """숫자만 그대로 — 글자·참거짓·NaN은 null(0으로 채우지 않음)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return None if value != value else value
