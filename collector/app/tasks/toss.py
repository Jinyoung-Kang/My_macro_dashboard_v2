"""
app/tasks/toss.py
토스증권 투자자별 매매(시장·종목·레이더 폴백).
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta, timezone

from .. import catalog, http, store
from ..services import (
    toss as toss_service,
)

from .base import EmptyResult, KST, RADAR_COMBINATIONS, _reason_suffix, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)


# ==============================================================================
# 토스증권 — 투자자별 매매 (공식 Open API)
# ==============================================================================
TOSS_MARKET_DAYS = 30         # 시장 합계: 20거래일 누적 + 여유
TOSS_STOCK_DAYS = 20          # 종목: 5·20일 누적, 연속 순매수 일수
TOSS_STOCK_LIMIT = 40         # 레이더에서 고르는 종목 수
TOSS_WATCHED_LIMIT = 60       # 알림 규칙의 관심 종목(백엔드가 만들 때 전체 60종목으로 막음) — 합쳐 최대 100회 호출
# 이 그룹(STOCK_TRADING_TREND)의 초당 한도는 공개된 표에서 확인하지 못했습니다.
# 다른 그룹은 초당 1~10회라, 한 번에 몰아 부르지 않고 간격을 둡니다.
TOSS_STOCK_SPACING = 0.3
TOSS_STOCK_RETENTION_DAYS = 400
# 새 종목을 더 묻지 않는 경과 시간(초, 종목 루프 시작부터) — 종목별 매매동향을 최대 100번 부르는 두 태스크(toss_stock_flows·toss_radar_universe)에
# 씁니다. 토스 호출은 태스크 시간 예산 층을 거치지 않고 건당 한도가 10초라, 종목 수만 세면 토스가 느릴 때 slow 군 상한(600초)을 넘깁니다
# (QA-367). 묻지 못한 종목은 다음 slow 주기가 받습니다(레이더 대상은 그때까지 직전 저장본의 기록으로 이음).
TOSS_TIME_LIMIT_SECONDS = 300.0
_KR_CODE = re.compile(r"^[0-9A-Z]{6}$")


def task_toss_market_flows() -> str:
    """
    코스피·코스닥 전체의 투자자별 매매대금 (원, 일별 최근 30거래일).

    레이더(시장 전체 수급)와 국내 파생(현물·선물 수급 동조)이 함께 씁니다.
    시장마다 받은 시각(``fetchedAt``)을 남깁니다. 한 시장이 실패하거나 빈 응답이면 그 시장만 직전 저장본으로
    잇고 ``isStale``·``staleSince``를 붙입니다(3일 지나면 뺌 — 다른 태스크와 같은 규칙, QA-032·QA-056).
    예전에는 표시 없이 이어 써서, 저장본 수집 시각(방금 받은 다른 시장의 시각)이 멈춘 시장에도 붙었고, 알림이
    장중에 마지막으로 받은 기록을 다음 날 확정치로 셌습니다(QA-076). 백엔드는 시장별 ``fetchedAt``으로 확정을 봅니다.
    """
    fetched: dict[str, dict] = {}
    reasons: list[str] = []
    fetched_at = datetime.now(timezone.utc).isoformat()
    for symbol in toss_service.MARKET_SYMBOLS:
        try:
            records = toss_service.fetch_market_investor_trading(symbol, TOSS_MARKET_DAYS)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"{exc} — 토스 수급 기능이 꺼져 있습니다") from None
        except toss_service.TossError as exc:
            reasons.append(f"{symbol}: {exc}")
            continue
        if records:
            fetched[symbol] = {"records": records, "fetchedAt": fetched_at}
        else:
            reasons.append(f"{symbol}: 빈 응답(기록 0건)")

    if not fetched:
        raise EmptyResult(f"0/{len(toss_service.MARKET_SYMBOLS)} 시장 — 기존 저장본 유지" + _reason_suffix(reasons))

    fresh_count = len(fetched)
    carried = carry_over_missing(
        fetched, _previous_markets(), toss_service.MARKET_SYMBOLS, reasons[0] if reasons else None,
        lambda market: bool(market.get("records")),
    )
    store.put_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS, {
        "source": "토스증권 Open API — 시장 지표 투자자별 매매대금",
        "unit": "KRW",
        "markets": {symbol: fetched[symbol] for symbol in toss_service.MARKET_SYMBOLS if symbol in fetched},
    })
    return (f"{fresh_count}/{len(toss_service.MARKET_SYMBOLS)} 시장" + carried_suffix(carried)
            + _reason_suffix(reasons))


def _previous_markets() -> dict[str, dict]:
    """
    직전 저장본의 시장별 기록. ``fetchedAt``이 없는 예전 저장본은 그 저장본의 수집 시각으로 채웁니다 — 그 시장을
    그보다 늦게 받았을 수는 없으므로, 이어받은 시장이 이번 수집 시각을 얻어 장중 기록이 확정으로 세지는 일이 없습니다.
    """
    previous = store.read_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS)
    if previous is None or not isinstance(previous.payload, dict):
        return {}
    collected_at = previous.collected_at.isoformat() if previous.collected_at else None
    markets: dict[str, dict] = {}
    for symbol, market in (previous.payload.get("markets") or {}).items():
        if isinstance(market, dict):
            markets[symbol] = market if market.get("fetchedAt") or not collected_at else {
                **market, "fetchedAt": collected_at}
    return markets


def _toss_universe() -> list[str]:
    """
    지금 레이더 화면에 걸린 종목을 먼저, 그다음 최근 10일 레이더에 자주 오른 종목(합쳐 40), 마지막으로 알림 규칙의
    관심 종목(최대 60). 관심 종목은 레이더 상한과 따로 세어, 레이더가 꽉 차도 알림 대상이 빠지지 않게 합니다.
    """
    codes: list[str] = []
    for market, investor, trade_type, interval in RADAR_COMBINATIONS:
        snap = store.read_snapshot(catalog.snap_radar_scanner(market, investor, trade_type, interval))
        for row in ((snap.payload or {}).get("rows") or []) if snap else []:
            code = str(row.get("code") or "")
            if _KR_CODE.match(code) and code not in codes:
                codes.append(code)
    since = (datetime.now(KST).date() - timedelta(days=10)).isoformat()
    for code in store.recent_observation_codes(catalog.OBS_RADAR, since, TOSS_STOCK_LIMIT):
        if _KR_CODE.match(code) and code not in codes:
            codes.append(code)
    codes = codes[:TOSS_STOCK_LIMIT]
    try:
        watched = store.watched_stock_codes(TOSS_WATCHED_LIMIT)
    except Exception as exc:  # noqa: BLE001 — 알림 테이블이 없어도 레이더 종목 수집은 계속합니다
        logger.warning("알림 규칙의 관심 종목을 읽지 못했습니다: %s", http.brief_error(exc))
        watched = []
    for code in watched:
        if _KR_CODE.match(code) and code not in codes:
            codes.append(code)
    return codes


def _clock() -> float:
    """경과 시간 시계(초). 테스트가 시간 상한을 시험할 때 바꿔 끼웁니다."""
    return time.monotonic()


def task_toss_stock_flows() -> str:
    """
    레이더 종목의 일별 투자자 매매동향 (주, 최근 20거래일) — 수급이 며칠째 이어지는지.

    날짜별 기록을 observations에 쌓습니다(entity = 종목코드). 같은 날짜를 다시 받으면
    덮어쓰므로, 장중 잠정치가 저녁 확정치로 자연스럽게 바뀝니다.
    403(허용 IP 문제)이면 남은 종목도 같은 답을 받으므로 즉시 멈춥니다.
    """
    universe = _toss_universe()
    if not universe:
        raise EmptyResult("대상 종목이 없습니다 — 수급 레이더(radar_rankings)가 먼저 쌓여야 합니다")

    by_date: dict[str, list[dict]] = {}
    fetched = 0
    reasons: list[str] = []
    began = _clock()
    for index, code in enumerate(universe):
        if index and _clock() - began >= TOSS_TIME_LIMIT_SECONDS:
            reasons.append(f"시간 상한 {TOSS_TIME_LIMIT_SECONDS:.0f}초 — {len(universe) - index}종목은 다음 주기")
            break
        if index:
            time.sleep(TOSS_STOCK_SPACING)
        try:
            records = toss_service.fetch_stock_investor_trading(code, TOSS_STOCK_DAYS)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"{exc} — 토스 수급 기능이 꺼져 있습니다") from None
        except toss_service.TossForbidden as exc:
            reasons.append(str(exc))
            break
        except toss_service.TossError as exc:
            reasons.append(f"{code}: {exc}")
            continue
        for record in records:
            if record.get("date"):
                by_date.setdefault(record["date"], []).append({**record, "code": code})
        fetched += 1

    if not fetched:
        raise EmptyResult(f"0/{len(universe)} 종목 — 기존 저장본 유지" + _reason_suffix(reasons))

    saved = sum(
        store.put_observations(catalog.OBS_TOSS_STOCK_FLOW, obs_date, rows, entity_key="code")
        for obs_date, rows in by_date.items()
    )
    cutoff = (datetime.now(KST).date() - timedelta(days=TOSS_STOCK_RETENTION_DAYS)).isoformat()
    store.delete_observations_before(catalog.OBS_TOSS_STOCK_FLOW, cutoff)
    return f"{fetched}/{len(universe)} 종목 · {saved}건" + _reason_suffix(reasons)


TOSS_RADAR_UNIVERSE = 100


def task_toss_radar_universe() -> str:
    """
    레이더 폴백용 — 거래대금 상위 100종목의 최근 2거래일 투자자 매매 (토스증권 공식).

    레이더 화면이 요청할 때마다 100번 부르면 느리고 호출 한도를 태웁니다. 1시간마다
    한 번 받아 두고, 폴백 단계(radar.fetch_toss_ranking)는 이 저장본으로 순위만 계산합니다.
    한 번 받은 것으로 외국인·기관·개인·연기금·금융투자·투신, 코스피·코스닥 순위를 모두 만듭니다.
    최근 2일을 받는 이유 — 당일 잠정치에는 개인·기관 세부가 없어서 전 거래일 확정치로 대신합니다.
    """
    try:
        leaders = toss_service.fetch_trading_amount_leaders(TOSS_RADAR_UNIVERSE)
        infos = toss_service.fetch_stock_infos([row["code"] for row in leaders])
    except toss_service.TossMissingKey as exc:
        raise EmptyResult(f"{exc} — 토스 수급 기능이 꺼져 있습니다") from None
    except toss_service.TossError as exc:
        raise EmptyResult(f"거래대금 상위 목록을 받지 못했습니다 — {exc}") from None
    if not leaders:
        raise EmptyResult("거래대금 랭킹이 비어 있습니다 (집계 전이거나 휴장) — 기존 저장본 유지")

    stocks: list[dict] = []
    reasons: list[str] = []
    began = _clock()
    for index, leader in enumerate(leaders):
        if index and _clock() - began >= TOSS_TIME_LIMIT_SECONDS:
            reasons.append(f"시간 상한 {TOSS_TIME_LIMIT_SECONDS:.0f}초 — {len(leaders) - index}종목은 다음 주기")
            break
        if index:
            time.sleep(TOSS_STOCK_SPACING)
        info = infos.get(leader["code"]) or {}
        try:
            records = toss_service.fetch_stock_investor_trading(leader["code"], 2)
        except toss_service.TossForbidden as exc:
            reasons.append(str(exc))
            break
        except toss_service.TossError as exc:
            reasons.append(f"{leader['code']}: {exc}")
            continue
        stocks.append({**leader, "name": info.get("name"), "market": info.get("market"),
                       "securityType": info.get("securityType"), "records": records})

    if not stocks:
        raise EmptyResult(f"0/{len(leaders)} 종목 — 기존 저장본 유지" + _reason_suffix(reasons))
    # 403 등으로 중간에 멈추면 받은 몇 종목만으로 덮지 않고, 빠진 종목은 직전 저장본의 기록으로 잇습니다(QA-032).
    fresh_count = len(stocks)
    by_code = {stock["code"]: stock for stock in stocks}
    previous_by_code = {
        stock.get("code"): stock
        for stock in previous_payload(catalog.SNAP_TOSS_RADAR_UNIVERSE).get("stocks") or []
        if isinstance(stock, dict)
    }
    codes = [leader["code"] for leader in leaders]
    carried = carry_over_missing(
        by_code, previous_by_code, codes, reasons[0] if reasons else None,
        lambda stock: bool(stock.get("records")),
    )
    store.put_snapshot(catalog.SNAP_TOSS_RADAR_UNIVERSE, {
        "source": "토스증권 Open API — 시장 거래대금 상위 랭킹 + 종목별 투자자 매매동향",
        "universe": len(leaders),
        "stocks": [by_code[code] for code in codes if code in by_code],
    })
    return f"{fresh_count}/{len(leaders)} 종목" + carried_suffix(carried) + _reason_suffix(reasons)


