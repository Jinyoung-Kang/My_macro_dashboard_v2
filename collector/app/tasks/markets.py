"""
app/tasks/markets.py
fast 그룹 — 참고 시세(TradingView·Yahoo)·매크로 카드·국내 수급 레이더.
"""
from __future__ import annotations

import logging
from datetime import datetime

from .. import catalog, indicators, macro_cards, store
from ..services import (
    market as market_service,
    radar as radar_service,
    scraper as scraper_service,
)

from .base import EmptyResult, KST, RADAR_COMBINATIONS

logger = logging.getLogger(__name__)


# ==============================================================================
# fast
# ==============================================================================
STALE_NOTE = "⚠️ 이전 값"
_USABLE_STATUSES = ("ok", "single")


def _carry_over_failed_items(items: list[dict], previous_items: list[dict]) -> list[str]:
    """
    이번 수집에서 실패한 항목을 **직전 저장본의 정상 값**으로 채웁니다(QA-001).

    전부 실패하면 EmptyResult로 저장본을 통째로 지키면서, 일부만 실패하면 새 결과로 덮어 실패한
    항목의 마지막 정상 값이 사라졌습니다 — 외부 소스 하나가 끊기면 다른 소스에서 온 카드 3개
    때문에 나머지 18개가 "수집 실패"로 바뀌었습니다. 값·시각(lastTs)은 그때 것 그대로 두고
    isStale과 '이전 값' 배지만 더합니다. 없는 숫자를 만드는 것이 아니라, 있던 숫자를 버리지 않는
    것입니다. 직전 저장본에도 없던 항목은 그대로 실패입니다.

    :return: 이어받은 항목의 key 목록
    """
    previous_by_key = {
        item.get("key"): item for item in previous_items
        if isinstance(item, dict) and item.get("status") in _USABLE_STATUSES
    }
    carried: list[str] = []
    for index, item in enumerate(items):
        if item.get("status") in _USABLE_STATUSES:
            continue
        before = previous_by_key.get(item.get("key"))
        if before is None:
            continue
        kept = dict(before)
        kept["isStale"] = True
        kept["staleReason"] = item.get("error") or "수집 실패"
        kept["note"] = STALE_NOTE
        items[index] = kept
        carried.append(str(item.get("key")))
    return carried


def _previous_payload(name: str) -> dict:
    snapshot = store.read_snapshot(name)
    return snapshot.payload if snapshot and isinstance(snapshot.payload, dict) else {}


def task_scraper_markets() -> str:
    result = scraper_service.collect_scraped_markets()
    items = result.get("items", [])
    ok = sum(1 for item in items if item.get("status") == "ok")

    if not ok:
        raise EmptyResult(f"0/{len(items)} 소스 — 기존 저장본 유지")

    carried = _carry_over_failed_items(items, _previous_payload(catalog.SNAP_SCRAPER_MARKETS).get("items") or [])
    store.put_snapshot(catalog.SNAP_SCRAPER_MARKETS, result)
    return f"{ok}/{len(items)} 소스 수집" + (f" (이전 값 유지 {len(carried)})" if carried else "")


def task_macro_collected() -> str:
    payload = market_service.collect_macro_cards(indicators.MACRO_CATEGORIES)
    payload = macro_cards.apply_bond_override(payload)
    payload = macro_cards.apply_realtime_quotes(payload)
    payload = macro_cards.inject_scraped_indices(payload)

    items = [
        item
        for category in payload["categories"]
        for item in category["items"]
    ]
    usable = sum(1 for item in items if item.get("status") in _USABLE_STATUSES)

    if not usable:
        raise EmptyResult(f"0/{len(items)} 지표 — 기존 저장본 유지")

    previous = _previous_payload(catalog.SNAP_MACRO_COLLECTED)
    previous_items = [
        item for category in previous.get("categories") or [] for item in category.get("items") or []
    ]
    carried: list[str] = []
    for category in payload["categories"]:
        carried += _carry_over_failed_items(category["items"], previous_items)
    # 스프레드 계산용 금리(rates)도 이어받은 카드는 직전 값으로 — 카드는 살았는데 금리만 비면
    # 10Y-2Y 스프레드가 "데이터 없음"이 됩니다.
    # 이어받았다는 표시도 함께 — 없으면 백엔드가 이전 금리로 '실시간' 스프레드를 표시 없이 냅니다(QA-060).
    previous_rates = previous.get("rates") or {}
    for key in carried:
        if isinstance(previous_rates.get(key), dict):
            payload.setdefault("rates", {})[key] = {**previous_rates[key], "isStale": True}

    # 부제는 보정·주입·이어받기가 끝난 카드의 배지로 요약합니다(QA-137).
    macro_cards.summarize_notes(payload)
    payload["updatedAt"] = market_service.now_kst_text()
    store.put_snapshot(catalog.SNAP_MACRO_COLLECTED, payload)
    return f"{usable}/{len(items)} 지표 수집" + (f" (이전 값 유지 {len(carried)})" if carried else "")


def task_radar_rankings() -> str:
    today = datetime.now(KST).date()
    ok = 0
    kinds: dict[str, int] = {}      # 출처별 건수 — Daum이 비어 KRX 앞 거래일·이력으로 대체된 것이 실행 기록에 남게(QA-396)

    for market, investor, trade_type, interval in RADAR_COMBINATIONS:
        result = radar_service.collect_radar_ranking(
            today, market, investor, trade_type, 30, interval
        )
        rows = result.get("rows") or []
        if not rows:
            logger.info(
                "수급 조합 빈 결과(저장본 유지): %s/%s/%s/%s",
                market, investor, trade_type, interval,
            )
            continue

        name = catalog.snap_radar_scanner(market, investor, trade_type, interval)
        store.put_snapshot(name, result)

        # 누적은 외부에서 새로 받은 값만 합니다. 이력에서 꺼내 온 값을 다시
        # 이력에 쓰면 같은 데이터가 다른 날짜로 복제됩니다.
        if not result.get("isHistorical"):
            radar_service.accumulate_history(
                rows, market, investor, trade_type, interval
            )
        ok += 1
        kind = str(result.get("sourceKind") or "unknown")
        kinds[kind] = kinds.get(kind, 0) + 1

    if not ok:
        raise EmptyResult(f"0/{len(RADAR_COMBINATIONS)} 조합 — 기존 저장본 유지")
    by_kind = " · ".join(f"{kind} {count}" for kind, count in sorted(kinds.items()))
    return f"{ok}/{len(RADAR_COMBINATIONS)} 조합 수집 ({by_kind})"


