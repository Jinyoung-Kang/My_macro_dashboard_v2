"""
비공식 참고 시세 수집 (TradingView Scanner + Yahoo chart JSON).

⚠️ TradingView·Yahoo는 **비공식 참고 시세**입니다. 화면은 공식 확정치와 나란히
놓되 반드시 "참고"라고 표시해야 합니다.

**HTML을 정규식으로 긁지 마세요.** 같은 값을 JSON으로 주는 공개 엔드포인트가
있고 이 파일은 그것만 씁니다. HTML 파싱은 구조가 바뀌면 예외 없이 조용히 틀린
숫자를 주기 시작합니다 — 실패가 status="fail"로 드러나지 않는 방식입니다.
"""
from __future__ import annotations

from ..numbers import to_float
from .. import kst

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

from . import market
from ..http import bind_guard, get_session

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")

TRADINGVIEW_BONDS_SCANNER_URL = "https://scanner.tradingview.com/bonds/scan"
TRADINGVIEW_SYMBOL_SCANNER_URL = "https://scanner.tradingview.com/symbol"
TRADINGVIEW_US_TREASURY_SYMBOLS = {
    # 3개월물은 심볼 표기가 다릅니다(US03MY — M은 month).
    "TVC:US03MY": "us03m",
    "TVC:US02Y": "us02y",
    "TVC:US10Y": "us10y",
    "TVC:US30Y": "us30y",
}

TREASURY_KEYS = ("us03m", "us02y", "us10y", "us30y")

# kind: tradingview_symbol(=Symbol Scanner JSON) | yahoo_chart(=chart JSON)
# delay: yahoo_chart 항목의 시세 지연(분) — Yahoo가 밝힌 값(exchangeDataDelayedBy, 2026-10-19 확인).
#        TradingView 항목은 응답의 update_mode로 그때그때 받습니다(QA-137).
# tz: 그 시장의 시간대. TradingView 일봉이 열린 시각을 그 시장의 거래일로 옮길 때 씁니다 — 매크로 카드를 이 값으로
#     바꾸는 항목(indicators.REALTIME_QUOTES)은 장이 닫혔을 때 카드에 거래일을 적어야 합니다(QA-138).
SCRAPER_MARKETS = [
    # 달러 인덱스·엔/원 — 매크로 카드의 실시간 출처입니다(Yahoo DX-Y.NYB는 ICE 10분 지연, JPYKRW=X는 호가가 드묾).
    # FX_IDC:JPYKRW는 1엔당(약 8.4원)으로 옵니다. 카드는 100엔당으로 바꿉니다(market.quote_scale).
    {"key": "dxy", "name": "달러 인덱스", "kind": "tradingview_symbol",
     "symbol": "TVC:DXY", "provider": "TradingView Scanner", "unit": "pt", "tz": "America/New_York",
     "url": "https://www.tradingview.com/symbols/TVC-DXY/"},
    {"key": "jpykrw", "name": "엔/원 (1엔당)", "kind": "tradingview_symbol",
     "symbol": "FX_IDC:JPYKRW", "provider": "TradingView Scanner", "unit": "원", "tz": "America/New_York",
     "url": "https://www.tradingview.com/symbols/JPYKRW/"},
    {"key": "us03m", "name": "미국채 3개월물", "kind": "tradingview_symbol",
     "symbol": "TVC:US03MY", "provider": "TradingView Scanner", "unit": "%", "tz": "America/New_York",
     "url": "https://www.tradingview.com/symbols/TVC-US03MY/"},
    {"key": "us02y", "name": "미국채 2년물", "kind": "tradingview_symbol",
     "symbol": "TVC:US02Y", "provider": "TradingView Scanner", "unit": "%", "tz": "America/New_York",
     "url": "https://www.tradingview.com/symbols/TVC-US02Y/"},
    {"key": "us10y", "name": "미국채 10년물", "kind": "tradingview_symbol",
     "symbol": "TVC:US10Y", "provider": "TradingView Scanner", "unit": "%", "tz": "America/New_York",
     "url": "https://www.tradingview.com/symbols/TVC-US10Y/"},
    {"key": "us30y", "name": "미국채 30년물", "kind": "tradingview_symbol",
     "symbol": "TVC:US30Y", "provider": "TradingView Scanner", "unit": "%", "tz": "America/New_York",
     "url": "https://www.tradingview.com/symbols/TVC-US30Y/"},
    {"key": "wti", "name": "WTI 원유", "kind": "yahoo_chart",
     "symbol": "CL=F", "provider": "Yahoo Finance", "delay": 10, "unit": "USD/bbl",
     "url": "https://finance.yahoo.com/quote/CL=F/"},
    {"key": "brent", "name": "브렌트유", "kind": "yahoo_chart",
     "symbol": "BZ=F", "provider": "Yahoo Finance", "delay": 10, "unit": "USD/bbl",
     "url": "https://finance.yahoo.com/quote/BZ=F/"},
    {"key": "gold_spot", "name": "금 현물", "kind": "tradingview_symbol",
     "symbol": "OANDA:XAUUSD", "provider": "TradingView Scanner", "unit": "USD/oz",
     "url": "https://www.tradingview.com/symbols/XAUUSD/"},
    {"key": "kospi", "name": "코스피", "kind": "tradingview_symbol",
     "symbol": "KRX:KOSPI", "provider": "TradingView Scanner", "unit": "pt", "tz": "Asia/Seoul",
     "url": "https://www.tradingview.com/symbols/KRX-KOSPI/"},
    {"key": "nikkei", "name": "닛케이225", "kind": "tradingview_symbol",
     "symbol": "TVC:NI225", "provider": "TradingView Scanner", "unit": "pt", "tz": "Asia/Tokyo",
     "url": "https://www.tradingview.com/symbols/TVC-NI225/"},
    {"key": "shanghai", "name": "상해종합", "kind": "yahoo_chart",
     "symbol": "000001.SS", "provider": "Yahoo Finance", "delay": 15, "unit": "pt",
     "url": "https://finance.yahoo.com/quote/000001.SS/"},
    # 코스피200 야간선물(KRX 야간 파생시장 18:00~06:00). 구버전은 TradingView HTML을 정규식으로 긁고
    # Investing.com으로 폴백했는데, 둘 다 페이지 구조가 바뀌면 조용히 깨집니다.
    # 여기서는 같은 값을 JSON으로 주는 Symbol Scanner를 쓰고, 실패하면 구버전과
    # 같은 KODEX 200 프록시로 내려갑니다(반드시 추정치로 표시).
    {"key": "kospi200_night", "name": "코스피200 야간선물",
     "kind": "tradingview_symbol", "symbol": "KRX:K2I1!",
     "provider": "TradingView Scanner", "unit": "pt", "tz": "Asia/Seoul",
     "fallback": "kodex_proxy",
     "url": "https://kr.tradingview.com/symbols/KRX-K2I1!/"},
    {"key": "hang_seng", "name": "항셍", "kind": "tradingview_symbol",
     "symbol": "TVC:HSI", "provider": "TradingView Scanner", "unit": "pt", "tz": "Asia/Hong_Kong",
     "url": "https://www.tradingview.com/symbols/TVC-HSI/"},
    # 닛케이225·항셍 **선물**(최근월 연결). 예전에는 "선물" 카드가 위의 지수
    # 심볼(TVC:NI225·TVC:HSI)을 그대로 썼습니다 — 이름은 선물인데 값은 지수였고,
    # 지수 카드와 소수점까지 같은 값이 나란히 떴습니다. 선물 조회에 실패하면
    # 카드가 지수 값으로 내려가되 이름에 그 사실을 적습니다(macro_cards.inject_scraped_indices).
    {"key": "nikkei_fut", "name": "닛케이225 선물", "kind": "tradingview_symbol",
     "symbol": "OSE:NK2251!", "provider": "TradingView Scanner", "unit": "pt", "tz": "Asia/Tokyo",
     "url": "https://www.tradingview.com/symbols/OSE-NK2251!/"},
    {"key": "hsi_fut", "name": "항셍 선물", "kind": "tradingview_symbol",
     "symbol": "HKEX:HSI1!", "provider": "TradingView Scanner", "unit": "pt", "tz": "Asia/Hong_Kong",
     "url": "https://www.tradingview.com/symbols/HKEX-HSI1!/"},
]


def collect_scraped_markets() -> dict:
    """
    참고 시세 전체를 병렬 수집합니다.

    반환: {"updatedAt": "...KST", "items": [ ... ]}
    item.status: ok | fail
    """
    results: list[dict] = []

    with ThreadPoolExecutor(max_workers=len(SCRAPER_MARKETS)) as pool:
        futures = {
            pool.submit(bind_guard(_collect_one), config): config
            for config in SCRAPER_MARKETS
        }
        for future, config in futures.items():
            try:
                results.append(future.result())
            except Exception as exc:  # noqa: BLE001
                results.append(_fail(config, str(exc)))

    # bonds scanner는 미국채 수익률 **폴백**입니다. Symbol Scanner가 세 개를
    # 모두 채웠으면 부를 이유가 없습니다.
    #
    # 예전에는 매번 병렬로 함께 호출했습니다. 그런데 이 엔드포인트는 계속
    # 빈 응답을 주고 Symbol Scanner가 항상 성공해서, 5분마다 쓸모없는 요청이
    # 한 번씩 나가고 로그에는 같은 줄이 반복됐습니다.
    #
    #     bonds scanner 미수집: ['us02y', 'us10y', 'us30y'] — Symbol Scanner 값으로 대체합니다.
    #
    # 폴백은 남겨 두되, 실제로 필요할 때만 부릅니다.
    by_key = {item["key"]: item for item in results}
    need_bonds = [
        key for key in TREASURY_KEYS
        if (by_key.get(key) or {}).get("price") is None
    ]

    if need_bonds:
        logger.info("미국채 수익률 %s 미수집 — bonds scanner로 보강합니다.", need_bonds)
        try:
            bonds = fetch_treasury_yields()
        except Exception as exc:  # noqa: BLE001
            logger.warning("TradingView bonds scanner 조회 실패: %s", exc)
            bonds = {}

        # bonds scanner는 "현재 수익률"만 주고 전일 종가가 없습니다.
        for key, reading in bonds.items():
            item = by_key.get(key)
            if item is None or item.get("price") is not None:
                continue
            item.update({
                "status": "ok",
                "price": reading["price"],
                "provider": reading["provider"],
                "error": None,
            })

    order = {config["key"]: index for index, config in enumerate(SCRAPER_MARKETS)}
    results.sort(key=lambda item: order.get(item["key"], 999))

    # 항목마다 받은 시각을 남깁니다. 다음 수집이 실패해 이 값을 이어받아도(isStale) 언제 값인지 알 수 있습니다(QA-030).
    stamp = kst.stamp()
    for item in results:
        if item.get("status") == "ok":
            item["collectedAt"] = stamp
    return {
        "updatedAt": stamp,
        "items": results,
    }


def collect_quotes(keys: set[str]) -> dict[str, dict]:
    """
    참고 시세 가운데 몇 항목만 바로 받습니다 — {key: 항목}. 항목 모양은 collect_scraped_markets와 같습니다.

    매크로 카드의 실시간 대체가 1분보다 오래된 참고 시세 저장본을 들고 있을 때 씁니다(QA-138, macro_cards).
    """
    configs = [config for config in SCRAPER_MARKETS if config["key"] in keys]
    if not configs:
        return {}
    with ThreadPoolExecutor(max_workers=len(configs)) as pool:
        items = list(pool.map(bind_guard(_collect_one), configs))
    stamp = kst.stamp()
    for item in items:
        if item.get("status") == "ok":
            item["collectedAt"] = stamp
    return {item["key"]: item for item in items}


def _collect_one(config: dict) -> dict:
    reason: str | None = None
    price = previous = change = change_pct = None
    delay = config.get("delay")
    session = trade_day = pricescale = None

    try:
        if config["kind"] == "tradingview_symbol":
            quote = fetch_symbol_snapshot(config["symbol"])
            price, previous = quote["price"], quote["previous"]
            change, change_pct = quote["change"], quote["changePct"]
            delay = quote["delayMinutes"]
            session, pricescale = quote.get("session"), quote.get("pricescale")
            trade_day = trade_date(quote.get("barTime"), config.get("tz"))
        else:
            price, previous = fetch_yahoo_chart(config["symbol"])
            change = (price - previous) if (price is not None and previous) else None
            change_pct = (
                (change / previous * 100.0) if (change is not None and previous) else None
            )
    except requests.RequestException as exc:
        reason = f"통신 실패: {exc}"
    except ValueError as exc:
        reason = f"응답 해석 실패: {exc}"
    except Exception as exc:  # noqa: BLE001
        reason = str(exc)

    if price is None and config.get("fallback") == "kodex_proxy":
        # 구버전과 같은 마지막 수단입니다. 실제 야간선물 값이 아니므로 반드시
        # 추정치로 표시합니다 — 확정치인 척하면 교차 검증이 무의미해집니다.
        fallback = _kodex_proxy_card(config, reason)
        if fallback is not None:
            return fallback

    if reason is not None:
        return _fail(config, reason)

    if price is None:
        return _fail(config, "현재가를 얻지 못했습니다")

    return {
        "key": config["key"],
        "name": config["name"],
        "url": config["url"],
        "provider": config["provider"],
        "symbol": config["symbol"],
        "unit": config["unit"],
        "status": "ok",
        "price": price,
        "previousClose": previous,
        "change": change,
        "changePct": change_pct,
        # 시세 지연(분). 0이면 실시간, 모르면 None — 카드 배지가 이 값으로 적힙니다(QA-137).
        "delayMinutes": delay,
        # 받은 때의 장 상태("market"·"out_of_session" 등)와 값의 거래일, 호가 자릿수(100 → 소수 둘째 자리).
        # 장이 닫혔으면 카드에 수집 시각 대신 거래일을 적습니다(QA-138). Yahoo 항목은 모두 None입니다.
        "session": session,
        "tradeDate": trade_day,
        "pricescale": pricescale,
        "error": None,
    }


def _kodex_proxy_card(config: dict, reason: str | None) -> dict | None:
    """
    KODEX 200(069500.KS) 종가로 코스피200 수준을 추정한 카드.

    ⚠️ 실제 야간선물 값이 아닙니다. 구버전과 동일하게 마지막 수단으로만 쓰고
    isEstimated로 표시합니다. KODEX 200은 지수의 약 100배 가격이라 스케일을
    맞춥니다.
    """
    current, previous, _ = market.last_two_closes("069500.KS")
    if current is None:
        return None

    scale = 0.01 if current > 1000 else 1.0
    price = round(current * scale, 2)
    prev = round(previous * scale, 2) if previous else None
    change = price - prev if prev else None

    return {
        "key": config["key"],
        "name": config["name"],
        "url": config["url"],
        "provider": "KODEX 200 프록시 (추정치)",
        "unit": config["unit"],
        "status": "ok",
        "price": price,
        "previousClose": prev,
        "change": change,
        "changePct": (change / prev * 100.0) if (change is not None and prev) else None,
        "isEstimated": True,
        "error": None,
        "note": (
            "실제 야간선물이 아니라 KODEX 200 현물 기반 추정치입니다"
            + (f" (원인: {reason})" if reason else "")
        ),
    }


def _fail(config: dict, error: str) -> dict:
    return {
        "key": config["key"],
        "name": config["name"],
        "url": config["url"],
        "provider": config["provider"],
        "unit": config["unit"],
        "status": "fail",
        "price": None,
        "previousClose": None,
        "change": None,
        "changePct": None,
        "error": error,
    }


# ==============================================================================
# 개별 출처
# ==============================================================================
def fetch_symbol_snapshot(symbol: str) -> dict:
    """
    TradingView Symbol Scanner에서 현재가·등락·시세 지연을 JSON으로 읽습니다.

    반환: {"price", "previous", "change", "changePct", "delayMinutes", "session", "barTime", "pricescale"}
          — 모르는 값은 None. barTime은 마지막 일봉이 열린 시각(Unix 초), session은 받은 때의 장 상태입니다.
    전일 종가는 change_abs(절대 변화)에서 역산합니다. change_abs가 없으면
    change(%)로 역산하고, 둘 다 없으면 None으로 둡니다 — 0으로 메우지 않습니다.

    지연은 update_mode에서 읽습니다: "streaming"은 실시간, "delayed_streaming_1200"은 1200초(20분) 지연.
    로그인하지 않은 공개 응답이라 거래소 라이선스에 따라 종목마다 다릅니다(2026-10-19: 코스피200 야간선물 20분,
    닛케이·항셍 선물 15분, 지수·환율·미국채 실시간).
    """
    params = {
        "symbol": symbol,
        "fields": "close,change,change_abs,update_mode,current_session,time,pricescale",
        "no_404": "true",
        "label-product": "symbols-performance",
    }
    response = get_session().get(
        TRADINGVIEW_SYMBOL_SCANNER_URL, params=params, timeout=10
    )
    response.raise_for_status()
    payload = response.json()

    price = to_float(payload.get("close"))
    change_pct = to_float(payload.get("change"))
    change = to_float(payload.get("change_abs"))
    bar_time, scale = to_float(payload.get("time")), to_float(payload.get("pricescale"))
    session = payload.get("current_session")
    quote = {"price": price, "previous": None, "change": None, "changePct": None,
             "delayMinutes": delay_minutes(payload.get("update_mode")),
             "session": session if isinstance(session, str) else None,
             "barTime": int(bar_time) if bar_time is not None else None,
             "pricescale": int(scale) if scale and scale > 0 else None}

    if price is None:
        logger.warning("Symbol Scanner 현재가 파싱 실패: symbol=%s", symbol)
        return quote

    previous = None
    if change is not None:
        previous = price - change
    elif change_pct is not None and change_pct != -100:
        previous = price / (1 + change_pct / 100.0)
        change = price - previous

    return {**quote, "previous": previous, "change": change, "changePct": change_pct}


def trade_date(bar_time: int | None, tz: str | None) -> str | None:
    """
    TradingView 일봉이 열린 시각 → 그 시장의 거래일("YYYY-MM-DD"). 모르면 None.

    아침~낮(현지 04:00~15:59)에 여는 일봉(지수 — 코스피 KST 09:00, 항셍 HKT 09:30)만 그날을 거래일로 봅니다.
    저녁에 여는 세션(선물 야간장·외환·달러 인덱스는 전날 뉴욕 17:00)의 거래일은 다음 영업일이고 휴장일까지 겹쳐 달력만으로
    정할 수 없습니다 — 2026-10-19 항셍 선물의 금요일 17:15 HKT 세션에 12시간을 더하니 토요일이 나왔습니다(QA-138).
    """
    if bar_time is None or not tz:
        return None
    opened = datetime.fromtimestamp(bar_time, timezone.utc).astimezone(ZoneInfo(tz))
    return opened.date().isoformat() if 4 <= opened.hour < 16 else None


def delay_minutes(update_mode: object) -> int | None:
    """TradingView update_mode → 지연(분). "streaming"은 0, "delayed_streaming_900"은 15, 그 밖은 모름(None)."""
    if update_mode == "streaming":
        return 0
    if isinstance(update_mode, str) and update_mode.startswith("delayed_streaming_"):
        seconds = to_float(update_mode.removeprefix("delayed_streaming_"))
        return round(seconds / 60) if seconds is not None and seconds >= 0 else None
    return None


def fetch_yahoo_chart(symbol: str) -> tuple[float | None, float | None]:
    """
    Yahoo에서 최근 종가와 직전 거래일 종가를 읽습니다.

    ⚠️ 예전에는 query1.finance.yahoo.com/v8/finance/chart 를 requests로 직접
    호출했습니다. 그러다 429(Too Many Requests)로 WTI·브렌트유·상해종합이
    한꺼번에 막혔습니다. 같은 시각 같은 종목을 매크로 카드(yfinance)는 정상
    수집하고 있었습니다 — 차이는 클라이언트였습니다.

    이제 앱 전체가 쓰는 yfinance 경로 하나로 모읍니다
    (market.last_two_closes 주석 참고).
    """
    current, previous, reason = market.last_two_closes(symbol)
    if current is None and reason:
        raise RuntimeError(reason)
    return current, previous


def fetch_treasury_yields() -> dict:
    """
    TradingView 공개 bonds scanner에서 미국채 수익률을 한 번에 읽습니다.

    응답 예: {"s": "TVC:US02Y", "d": [1000, 1, 20280831, "P2Y", 4.375, ...]}
    d[4]가 최신 수익률(%)입니다. 이 엔드포인트는 보조 출처이며 비어 있는
    경우도 흔하므로(2026-09 기준 d=[] 응답 확인) 실패해도 조용히 넘어갑니다.
    """
    try:
        response = get_session().get(
            TRADINGVIEW_BONDS_SCANNER_URL,
            params={"label-product": "bonds-yield-curve"},
            timeout=10,
        )
        response.raise_for_status()
        rows = response.json().get("data") or []
    except (requests.RequestException, ValueError) as exc:
        logger.warning("TradingView bonds scanner 조회 실패: %s", exc)
        return {}

    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = TRADINGVIEW_US_TREASURY_SYMBOLS.get(str(row.get("s", "")).strip())
        if not key:
            continue
        values = row.get("d") or []
        if not isinstance(values, list) or len(values) < 5:
            continue
        current = to_float(values[4])
        if current is None:
            continue
        out[key] = {
            "price": current,
            "provider": "TradingView Scanner",
            "symbol": row.get("s"),
        }

    missing = set(TREASURY_KEYS) - set(out)
    if missing:
        logger.warning(
            "bonds scanner도 %s를 주지 못했습니다 — 해당 수익률은 빈 값으로 남습니다.",
            sorted(missing),
        )
    return out
