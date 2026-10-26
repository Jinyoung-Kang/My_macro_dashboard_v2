"""
app/tasks/series.py
slow 그룹의 시계열 — FRED·연준 순유동성·KRX 선물·섹터/환율/종목 종가·변동성·COT·Daum 선물 수급.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from .. import catalog, equities, indicators, store
from ..services import (
    cot as cot_service,
    fred as fred_service,
    krx as krx_service,
    liquidity as liquidity_service,
    market as market_service,
    sector as sector_service,
)

from .base import DAUM_TREND_LOOKBACK, EmptyResult, _reason_suffix, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)


# ==============================================================================
# slow
# ==============================================================================
def task_fred_series() -> str:
    series_ids = indicators.FRED_ALL_SERIES
    ok = 0
    accumulated = 0
    reasons: list[str] = []

    for series_id in series_ids:
        points, reason = fred_service.collect_series_with_reason(
            series_id, period_years=10
        )
        if not points:
            logger.info("FRED 빈 결과(저장본 유지): %s (%s)", series_id, reason)
            if reason:
                reasons.append(reason)
            continue

        # 받은 점은 진짜 데이터이므로 누적 시계열에는 그대로 넣습니다. 다만 매시간 10년치
        # 2,600점을 전부 보내지 않고, 저장된 마지막 날짜 근처(개정 반영 7일)부터만 보냅니다.
        accumulated += store.put_timeseries(
            catalog.TS_FRED,
            series_id,
            _recent_points([(p["date"], p["value"]) for p in points],
                           store.latest_timeseries_date(catalog.TS_FRED, series_id)),
        )

        # 백엔드는 스냅샷을 읽습니다. 저장본보다 훨씬 짧은 응답(부분 장애·CSV 잘림)으로
        # 덮으면 다음 성공까지 10년 차트가 몇 점으로 무너집니다. 그런 응답은 스냅샷을
        # 두고 실패 사유로 남깁니다.
        stored = _fred_stored_point_count(series_id)
        if _is_shrunken(len(points), stored):
            reason = f"{series_id}: 응답 {len(points)}점이 저장본 {stored}점보다 훨씬 짧아 스냅샷을 덮지 않음"
            logger.warning("FRED %s", reason)
            reasons.append(reason)
            continue

        store.put_snapshot(
            catalog.snap_fred_series(series_id),
            {"seriesId": series_id, "points": points},
        )
        ok += 1

    if not ok:
        raise EmptyResult(
            f"0/{len(series_ids)} 시리즈 — 기존 저장본 유지{_reason_suffix(reasons)}"
        )
    return f"{ok}/{len(series_ids)} 시리즈, 누적 {accumulated}행"


# 시계열 증분 적재: 저장된 마지막 날짜에서 이만큼 거슬러 올라간 날부터만 보냅니다.
# FRED는 최근 값을 며칠 뒤 개정하므로 겹치는 구간을 둡니다. 첫 수집(저장본 없음)은 전부.
TIMESERIES_OVERLAP_DAYS = 7


def _recent_points(points: list[tuple], latest_stored: str | None) -> list[tuple]:
    """저장된 마지막 날짜 − 겹침 일수 이후의 점만. 저장본이 없으면 전부."""
    if not latest_stored:
        return points
    cutoff = (date.fromisoformat(latest_stored[:10]) - timedelta(days=TIMESERIES_OVERLAP_DAYS)).isoformat()
    return [(d, v) for d, v in points if str(d)[:10] >= cutoff]


FRED_SHRINK_MIN_STORED = 50      # 이보다 짧은 저장본은 비교 대상이 아닙니다(첫 수집 등)
FRED_SHRINK_RATIO = 0.5          # 응답이 저장본의 이 비율 미만이면 '훨씬 짧다'


def _fred_stored_point_count(series_id: str) -> int:
    snap = store.read_snapshot(catalog.snap_fred_series(series_id))
    points = (snap.payload or {}).get("points") if snap and isinstance(snap.payload, dict) else None
    return len(points) if isinstance(points, list) else 0


def _is_shrunken(received: int, stored: int) -> bool:
    return stored >= FRED_SHRINK_MIN_STORED and received < stored * FRED_SHRINK_RATIO


def task_fed_liquidity() -> str:
    payload = liquidity_service.collect_fed_liquidity(10)
    rows = payload.get("rows") or []
    if not rows:
        raise EmptyResult(
            "순유동성 빈 결과 — 기존 저장본 유지"
            + _reason_suffix([payload.get("error")] if payload.get("error") else [])
        )

    store.put_snapshot(
        catalog.SNAP_FED_LIQUIDITY,
        payload,
        status="estimated" if payload.get("isEstimated") else "ok",
    )

    if payload.get("isEstimated"):
        return f"{len(rows)}행 (⚠️ 추정치 — 누적 제외)"

    accumulated = 0
    for column in ("walcl", "wtregen", "rrpM", "netLiquidityM"):
        accumulated += store.put_timeseries(
            catalog.TS_LIQUIDITY,
            column,
            _recent_points([(row["date"], row[column]) for row in rows],
                           store.latest_timeseries_date(catalog.TS_LIQUIDITY, column)),
        )
    return f"{len(rows)}행, 누적 {accumulated}행"


# 이보다 새 확정 저장본이 있으면 KRX가 잠깐 실패해도 추정치로 덮지 않습니다(QA-035).
KRX_CONFIRMED_KEEP_SECONDS = 26 * 3600


def task_krx_futures() -> str:
    payload = krx_service.collect_futures_history(40)
    rows = payload.get("rows") or []
    if not rows:
        raise EmptyResult(
            "KRX 선물 빈 결과 — 기존 저장본 유지"
            + _reason_suffix([payload.get("error")] if payload.get("error") else [])
        )
    if payload.get("isEstimated"):
        previous = store.read_snapshot(catalog.SNAP_KRX_FUTURES)
        if (previous and isinstance(previous.payload, dict) and previous.payload.get("rows")
                and not previous.payload.get("isEstimated")
                and previous.age_seconds < KRX_CONFIRMED_KEEP_SECONDS):
            # 확정 미결제약정이 있는 저장본을 OI 없는 추정치로 1시간 덮으면 국면 판정이 그동안 사라집니다.
            raise EmptyResult("KRX 확정치 조회 실패 — 하루 안의 확정 저장본을 추정치로 덮지 않습니다")

    store.put_snapshot(
        catalog.SNAP_KRX_FUTURES,
        payload,
        status="estimated" if payload.get("isEstimated") else "ok",
    )

    if payload.get("isEstimated"):
        # ⚠️ 추정치는 누적하지 않습니다. 실제 확정치와 섞이면 구분 불가능합니다.
        return f"{len(rows)}행 (⚠️ 추정치 — 누적 제외)"

    accumulated = 0
    for column in ("futuresClose", "volume", "openInterest"):
        accumulated += store.put_timeseries(
            catalog.TS_KRX_FUTURES,
            column,
            [(row["date"], row.get(column)) for row in rows],
        )
    return f"{len(rows)}행, 누적 {accumulated}행"


def task_sector_history() -> str:
    tickers = indicators.all_rotation_tickers()
    payload = sector_service.collect_etf_history(tickers, period="2y")
    collected = payload.get("tickers") or {}

    if not collected:
        raise EmptyResult(
            f"0/{len(tickers)} 티커 — 기존 저장본 유지"
            + _reason_suffix([payload.get("error")] if payload.get("error") else [])
        )

    fresh_count = len(collected)
    carried = carry_over_missing(
        collected, previous_payload(catalog.SNAP_SECTOR_HISTORY).get("tickers"), tickers,
        payload.get("error"), lambda frame: bool(frame.get("close")),
    )
    payload["tickers"] = collected
    store.put_snapshot(catalog.SNAP_SECTOR_HISTORY, payload)
    detail = f"{fresh_count}/{len(tickers)} 티커" + carried_suffix(carried)
    if fresh_count < len(tickers) and payload.get("error"):
        # 어느 티커가 왜 빠졌는지 상태 화면에 남깁니다. "136/137"만으로는 매시간 ERROR 로그를 내는
        # 폐지 티커(MMC)를 아무도 알아채지 못했습니다.
        detail += f" — 실패: {payload['error']}"
    return detail


def task_fx_history() -> str:
    """
    💱 환율·달러인덱스 일별 종가 (여러 계열 겹쳐 보기용).

    티커는 매크로 카드의 fx 카테고리에서 그대로 가져옵니다. 차트만 다른
    티커를 쓰면 카드의 최근값과 차트의 끝값이 어긋나고, 보는 사람은 둘 중
    무엇이 맞는지 알 수 없습니다.

    엔/원은 Yahoo가 '1엔당 원'을 줄 때가 있어 카드와 같은 배율 판정을
    거칩니다(market_service.quote_scale). 이 판정이 한쪽에만 있으면 같은
    지표가 카드에서는 930원, 차트에서는 9.3원으로 그려집니다.
    """
    specs = indicators.fx_history_specs()
    if not specs:
        raise EmptyResult("환율 계열 정의가 비어 있습니다 (indicators.MACRO_CATEGORIES 확인)")

    tickers = tuple(spec["ticker"] for spec in specs)
    raw = sector_service.collect_daily_closes(tickers, period=indicators.FX_HISTORY_PERIOD)
    frames = raw.get("tickers") or {}

    series: dict[str, dict] = {}
    for spec in specs:
        frame = frames.get(spec["ticker"])
        closes = (frame or {}).get("close") or []
        dates = (frame or {}).get("dates") or []
        if not closes or not dates:
            continue

        scale = market_service.quote_scale(spec["key"], closes[-1])
        series[spec["key"]] = {
            "key": spec["key"],
            # 화면 버튼 순서. JSONB는 키 순서를 보존하지 않아, 순서를 값으로
            # 적어 두지 않으면 목록이 가나다순으로 뒤집힙니다.
            "order": len(series),
            "name": spec["name"],
            "ticker": spec["ticker"],
            "unit": spec.get("unit"),
            # 배율을 함께 저장합니다. 나중에 값만 보고는 100엔당인지 1엔당인지
            # 되짚을 수 없습니다.
            "scale": scale,
            "dates": dates,
            "close": [value * scale for value in closes],
        }

    if not series:
        raise EmptyResult(
            f"0/{len(specs)} 계열 — 기존 저장본 유지"
            + _reason_suffix([raw.get("error")] if raw.get("error") else [])
        )

    fresh_count = len(series)
    carried = carry_over_missing(
        series, previous_payload(catalog.SNAP_FX_HISTORY).get("series"), [spec["key"] for spec in specs],
        raw.get("error"), lambda entry: bool(entry.get("close")),
    )
    # 이어받은 계열은 옛 order를 가져와 새로 매긴 번호와 겹칠 수 있습니다(QA-057). 정의 순서대로 다시 매깁니다.
    ordered = [spec["key"] for spec in specs if spec["key"] in series]
    for position, key in enumerate(ordered):
        series[key]["order"] = position
    store.put_snapshot(
        catalog.SNAP_FX_HISTORY,
        {"period": indicators.FX_HISTORY_PERIOD, "series": series},
    )
    return f"{fresh_count}/{len(specs)} 계열" + carried_suffix(carried)


def task_equity_history() -> str:
    """
    📈 13F 매핑 종목 + 벤치마크의 일별 종가.

    구루 포트폴리오 위험 분석(베타·추적오차·VaR)과 종목 스코어카드가 씁니다.

    **매핑표를 가격과 같은 저장본에 함께 싣습니다.** 백엔드가 매핑표를 따로
    들고 있으면 한쪽에만 종목을 추가하는 순간 조용히 어긋납니다. 단일 출처로
    둬야 "왜 이 종목만 분석에서 빠지지?"를 한 곳에서 확인할 수 있습니다.
    """
    tickers = equities.all_tickers()
    raw = sector_service.collect_daily_closes(
        tickers, period=equities.PRICE_HISTORY_PERIOD
    )
    frames = raw.get("tickers") or {}

    if not frames:
        raise EmptyResult(
            f"0/{len(tickers)} 티커 — 기존 저장본 유지"
            + _reason_suffix([raw.get("error")] if raw.get("error") else [])
        )

    fresh_count = len(frames)
    carried = carry_over_missing(
        frames, previous_payload(catalog.SNAP_EQUITY_HISTORY).get("tickers"), tickers,
        raw.get("error"), lambda frame: bool(frame.get("close")),
    )
    store.put_snapshot(catalog.SNAP_EQUITY_HISTORY, {
        "period": equities.PRICE_HISTORY_PERIOD,
        "tickers": frames,
        # 이름 → {ticker, sector}. 백엔드가 13F 종목명을 여기에 대조합니다.
        "nameMap": equities.mapping_payload(),
        "benchmarks": equities.BENCHMARKS,
        "trackRecordAssets": equities.TRACK_RECORD_TICKERS,
    })
    return f"{fresh_count}/{len(tickers)} 티커" + carried_suffix(carried)


def task_volatility_history() -> str:
    """
    ^VIX / ^MOVE 시계열.

    화면이 여러 기간으로 요청하므로 가장 긴 기간(5y)으로 한 번만 저장하고,
    짧은 기간은 백엔드가 잘라 씁니다.

    ⚠️ ^MOVE는 Yahoo가 제공하지 않아 ^TNX 변동성에서 역산한 추정치입니다.
    isProxy 플래그가 저장되며 화면이 경고를 띄웁니다.
    """
    period = catalog.VOLATILITY_STORE_PERIOD
    ok = 0
    reasons: list[str] = []

    for symbol in ("^VIX", "^MOVE"):
        payload = market_service.collect_ticker(symbol, period)
        if not payload.get("points"):
            logger.info(
                "변동성 빈 결과(저장본 유지): %s (%s)", symbol, payload.get("error")
            )
            if payload.get("error"):
                reasons.append(f"{symbol} {payload['error']}")
            continue
        store.put_snapshot(
            catalog.snap_ticker_history(symbol, period),
            payload,
            status="estimated" if payload.get("isProxy") else "ok",
        )
        ok += 1

    if not ok:
        raise EmptyResult("0/2 지수 — 기존 저장본 유지" + _reason_suffix(reasons))
    return f"{ok}/2 지수 ({period})"


def task_cot_history() -> str:
    result = cot_service.collect_multi_asset(
        indicators.COT_ASSETS, indicators.COT_WEEKS
    )
    assets = result.get("assets") or {}
    usable = {name: entry for name, entry in assets.items() if entry.get("rows")}
    failed = [entry.get("error") for entry in assets.values() if not entry.get("rows") and entry.get("error")]

    if not usable:
        # 사유를 싣습니다 — CFTC의 거부(거부됨 — …)인지 연결 장애인지가 실행 기록에 보이게.
        raise EmptyResult(f"0/{len(assets)} 자산 — 기존 저장본 유지" + _reason_suffix(failed))

    carried = carry_over_missing(
        assets, previous_payload(catalog.SNAP_COT_HISTORY).get("assets"), list(assets),
        failed[0] if failed else None, lambda entry: bool(entry.get("rows")),
        # 주간 자료라 한 번 빠지면 다음 발표까지 일주일 — 일별 계열보다 길게 잇습니다.
        max_age=timedelta(days=21),
    )
    result["assets"] = assets
    store.put_snapshot(catalog.SNAP_COT_HISTORY, result)

    # 화면은 자산별로도 조회하므로 계약 코드별 스냅샷을 함께 적재합니다.
    per_contract = 0
    for name, entry in usable.items():
        store.put_snapshot(
            catalog.snap_cot_contract(entry["code"], indicators.COT_WEEKS),
            {"code": entry["code"], "asset": name, "rows": entry["rows"]},
        )
        per_contract += 1

    return f"{len(usable)}/{len(assets)} 자산 (계약별 {per_contract}건)" + carried_suffix(carried)


def task_daum_futures_trend() -> str:
    payload = krx_service.collect_daum_futures_trend(DAUM_TREND_LOOKBACK)
    if not payload.get("rows"):
        raise EmptyResult("빈 결과 — 기존 저장본 유지")

    store.put_snapshot(
        catalog.snap_daum_futures_trend(DAUM_TREND_LOOKBACK), payload
    )
    return f"{len(payload['rows'])}개 주체 (기준일 {payload.get('dataDate')})"


