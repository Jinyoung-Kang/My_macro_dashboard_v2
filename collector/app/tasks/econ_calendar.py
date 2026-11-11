"""
app/tasks/econ_calendar.py
polite 속도군 — 경제 캘린더(미국·한국 지표 일정과 예상치·이전치·실제치·중요도). 운영자 화면 전용이고 Claude 결정 패킷은 읽지 않습니다
(ADR 0026, 명세 docs/specs/2026-11-05-polite-fetch.md §6).

[econ_calendar_tradingview] TradingView 경제 캘린더 → 스냅샷 ``calendar.econ.tradingview`` (한 건)
  contract 1 · generatedAt · collectedAt(KST) · source · sourceUrl · sourceNote · fetchTier(통과한 계층 — 화면의 '우회 수집' 표기)
  countries · window{from, to}(UTC)
  events : [{id, country, title, at(ISO UTC), atKst, importance(-1·0·1 또는 null), actual, forecast, previous, indicator, period, unit,
            scale, currency, source}] — 시각순. 없는 값은 null입니다(0으로 채우지 않음)
  skipped(제목·나라·시각이 없어 버린 행 수) · fieldsSeen(응답 행에서 본 칸 이름 — 모양이 달라졌는지 보는 용도)
[일정] 다음 실행까지 3~6시간(무작위), 기동 직후에는 받지 않음. 한 번에 요청 1건.
[실패 규칙] 받지 못하면 직전 저장본을 그대로 둡니다 — 출처가 거부하면 '거부됨'(물러남은 app/fetch), 모양이 다르면 '수집 결과 없음'.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from .. import catalog, kst, store
from ..services import tv_calendar
from . import polite

logger = logging.getLogger(__name__)

TRADINGVIEW_TASK = "econ_calendar_tradingview"
TRADINGVIEW_CADENCE = polite.Cadence(low_minutes=180, high_minutes=360)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def task_econ_calendar_tradingview() -> str:
    """TradingView 경제 캘린더(미국·한국) → 스냅샷 ``calendar.econ.tradingview``."""
    return polite.scheduled(TRADINGVIEW_TASK, TRADINGVIEW_CADENCE, _collect_tradingview)


def _collect_tradingview() -> str:
    now = _now()
    try:
        got = tv_calendar.fetch_events(now)
    except tv_calendar.CalendarShapeError as exc:
        raise polite.ShapeChanged(f"TradingView 경제 캘린더 응답 모양이 다름({exc})") from exc

    events = got["events"]
    store.put_snapshot(catalog.SNAP_ECON_CALENDAR_TV, {
        "contract": 1,
        "generatedAt": now.isoformat(timespec="seconds"),
        "collectedAt": kst.stamp(now),
        "source": tv_calendar.SOURCE,
        "sourceUrl": tv_calendar.SOURCE_URL,
        "sourceNote": tv_calendar.SOURCE_NOTE,
        "fetchTier": got["fetchTier"],
        "countries": list(tv_calendar.COUNTRIES),
        "window": got["window"],
        "events": events,
        "skipped": got["skipped"],
        "fieldsSeen": got["fieldsSeen"],
    })

    by_country = {country: sum(1 for event in events if event["country"] == country) for country in tv_calendar.COUNTRIES}
    with_forecast = sum(1 for event in events if event["forecast"] is not None)
    with_importance = sum(1 for event in events if event["importance"] is not None)
    detail = (f"TradingView 경제 캘린더 {len(events)}건(미국 {by_country['US']}·한국 {by_country['KR']}) · "
              f"예상치 있는 행 {with_forecast} · 중요도 있는 행 {with_importance} · 계층 {got['fetchTier']}")
    if got["skipped"]:
        detail += f" · 버린 행 {got['skipped']}"
    return detail
