"""
app/services/market.py
yfinance 기반 시세 수집 (티커 시계열 + 매크로 카드).

[구버전에서 반드시 지켜야 할 규칙 — 그대로 옮겼습니다]

1. ^MOVE는 Yahoo가 제공하지 않습니다. ^TNX 변동성에서 역산한 **대용 추정치**를
   쓰되, isProxy/sourceLabel을 반드시 달아 화면과 AI가 공식 지표로 오인하지
   않게 합니다. 실제 MOVE 임계치(80/120/140)를 이 값에 그대로 적용하면
   잘못된 판단으로 이어집니다.

2. 분봉 피드가 마지막 봉을 반복하면 최근 두 봉의 종가가 같아집니다. 이때
   "변화 없음(0.00%)"으로 위장하지 않습니다. 일봉에서 직전 거래일 종가를
   찾아 보완하고, 그래도 없으면 전일 대비를 N/A로 둡니다.

3. 일봉 폴백 데이터의 시:분:초는 신뢰할 수 없으므로 "YYYY-MM-DD 일봉 기준"
   으로 표시합니다. 거짓 체결 시각을 만들지 않습니다.

4. 엔/원은 Yahoo가 '1엔당 원'을 주므로 화면 표기(100엔당)와 다릅니다.
   배율은 **원본 현재가**로 한 번만 판정하고 현재가·전일값에 똑같이 적용합니다
   (스케일 적용 후의 값으로 판정하면 전일값만 100배 틀어집니다).
"""
from __future__ import annotations

import logging
from datetime import date, time, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from ..numbers import to_float
from .. import http, indicators, yfcache
from .. import kst

from ..http import brief_error

logger = logging.getLogger(__name__)

# 병렬 수집 전에 캐시 폴더를 만들어 둡니다 (yfcache 참고).
yfcache.configure()

KST = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")

# 세션이 전날 저녁(뉴욕 시각)에 시작하는 상품과 그 시작 시각(QA-058). 이 시각 이후의 체결은 다음 거래일 세션입니다.
# CME 선물(=F)은 18:00 ET, ICE 달러인덱스는 19:30 ET 무렵(Yahoo 분봉 기준)에 시작합니다.
_FUTURES_SESSION_START = time(18, 0)
_DXY_SESSION_START = time(19, 0)

# 세션형 상품의 직전 세션 종가 — (티커, 세션 거래일) → 원본 스케일 종가. 하루에 한 번만 바뀌는 값이라 기억해 두면
# 5분마다 카드마다 하던 일봉 조회가 세션이 바뀔 때 한 번으로 줄어듭니다. 프로세스 메모리에만 두고, 커지면 비웁니다.
_SESSION_CLOSE_CACHE: dict[tuple[str, date], float] = {}
_SESSION_CLOSE_CACHE_LIMIT = 64

MOVE_SYMBOLS = {"^MOVE", "MOVE", "MOVE:INDEX"}

_PERIOD_DAYS = {
    "1d": 1, "5d": 5, "1mo": 31, "3mo": 92, "6mo": 183,
    "1y": 366, "2y": 731, "5y": 1827,
}


# ==============================================================================
# 1. 티커 시계열
# ==============================================================================
def collect_ticker(symbol: str, period: str = "1mo") -> dict:
    """
    티커 1종의 시계열을 수집합니다.

    반환 계약(JSON):
    {
      "symbol": "^VIX", "period": "5y",
      "isIntraday": bool,        # 분봉 수집 성공 여부
      "isProxy": bool,           # 실제 지표가 아닌 대용 추정치인가
      "isSynthetic": bool,       # 네트워크까지 실패해 만든 자리표시 값인가
      "sourceLabel": str | None,
      "points": [{"date": ISO, "open":..., "high":..., "low":..., "close":..., "volume":...}]
    }
    수집 실패 시 points가 빈 리스트입니다.
    """
    if not symbol:
        return _empty(symbol, period)

    if symbol in MOVE_SYMBOLS:
        return _collect_move_proxy(symbol, period)

    frame, is_intraday, reason = _download(symbol, period)
    if frame is None or frame.empty:
        logger.warning("yfinance 수집 실패 (%s): %s", symbol, reason)
        return _empty(symbol, period, reason)

    return {
        "symbol": symbol,
        "period": period,
        "isIntraday": is_intraday,
        "isProxy": False,
        "isSynthetic": False,
        "sourceLabel": None,
        "error": None,
        "points": _frame_to_points(frame),
    }


def _download(symbol: str, period: str) -> tuple[pd.DataFrame | None, bool, str | None]:
    """
    분봉 우선 수집. ^TNX/^TYX 같은 심볼은 분봉이 없어 일봉으로 폴백됩니다.
    폴백 여부와 실패 사유를 호출부가 알아야 하므로 함께 돌려줍니다.

    ⚠️ yfinance는 Yahoo가 응답 형식을 바꿀 때마다 깨집니다. 그때 증상은
    "예외 없이 빈 DataFrame"이라 조용한 실패로 보입니다. 사유 문자열에
    그 가능성을 명시해 운영자가 버전 업그레이드를 떠올릴 수 있게 합니다.

    Yahoo 공용 래치(http.YAHOO_HOST)를 봅니다 — 같은 Yahoo 한도를 나눠 쓰는 다른 수집(sector·실적 일정·어닝)이 방금 429를
    받았으면 묻지 않고, 여기서 받은 429(YFRateLimitError)는 래치를 닫습니다. 사유는 '거부됨 — …' 한 줄입니다.
    """
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return None, False, str(latched)
    try:
        ticker = yf.Ticker(symbol)

        if period in ("1d", "5d"):
            for interval in ("1m", "5m"):
                frame = ticker.history(period=period, interval=interval)
                if frame is not None and not frame.empty:
                    return _sanitize(frame), True, None
            frame = ticker.history(period=period)
            sanitized = _sanitize(frame)
            return sanitized, False, (None if sanitized is not None else _empty_reason())

        frame = ticker.history(period=period)
        sanitized = _sanitize(frame)
        return sanitized, False, (None if sanitized is not None else _empty_reason())
    except YFRateLimitError:
        return None, False, str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("yfinance 수집 예외 (%s): %s", symbol, exc)
        return None, False, brief_error(exc)


def last_two_closes(symbol: str) -> tuple[float | None, float | None, str | None]:
    """
    최근 종가와 직전 거래일 종가를 돌려줍니다. (현재가, 직전, 실패 사유)

    <b>왜 여기에 있나</b> — 스크래핑 비교표가 query1.finance.yahoo.com에
    requests로 직접 붙다가 429를 받고 있었습니다.

        WTI 원유    수집 실패  429 Client Error: Too Many Requests
        브렌트유    수집 실패  429 Client Error: Too Many Requests
        상해종합    수집 실패  429 Client Error: Too Many Requests

    같은 시각 같은 종목을 매크로 카드(yfinance 경로)는 정상으로 받았습니다
    (WTI 102.47, 브렌트 105.77). 차이는 **클라이언트**입니다. yfinance는
    Yahoo가 요구하는 쿠키·crumb를 관리하고 자체 캐시를 두지만, 생 requests
    호출은 그 처리가 없어 먼저 차단당합니다.

    그래서 Yahoo로 가는 길을 하나로 모읍니다. 같은 출처에 두 가지 방식으로
    붙으면 한쪽만 조용히 막히고, 화면에는 "왜 매크로 카드에는 값이 있는데
    비교표는 실패인가"라는 설명 불가능한 상태가 남습니다.
    """
    frame, _, reason = _download(symbol, "10d")
    if frame is None or "Close" not in frame.columns:
        return None, None, reason or _empty_reason()

    closes = [float(v) for v in frame["Close"].dropna().tolist()]
    if not closes:
        return None, None, _empty_reason()

    current = closes[-1]
    previous = closes[-2] if len(closes) >= 2 else None
    return current, previous, None


def latest_minute_prices(symbols: list[str]) -> tuple[dict[str, dict], str | None]:
    """
    🧪 모의 매매 장중 평가 — 종목마다 가장 최근 세션의 마지막 정규장 1분봉 종가와 그 봉 시각. (``{T: {price, at(ISO, UTC)}}``, 받지 못한 이유)

    배치 한 번(yf.download)으로 받고 빠진 종목을 하나씩 다시 묻지 않습니다 — 화면이 볼 때만 부르고 다음 새로고침이 다시 묻습니다.
    같은 Yahoo 한도를 나눠 쓰는 다른 수집이 방금 429를 받았으면 묻지 않고, 여기서 받은 429는 래치를 닫습니다(_download와 같음).
    값이 없거나 0 이하인 봉은 버립니다(0으로 채우지 않음). 지연 여부는 짐작하지 않고 봉 시각을 그대로 넘깁니다.
    """
    names = [s for s in dict.fromkeys(symbols) if s]
    if not names:
        return {}, None
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return {}, str(latched)
    try:
        raw = yf.download(tickers=" ".join(names), period="1d", interval="1m", prepost=False, auto_adjust=False,
                          actions=False, progress=False, group_by="ticker", threads=True)
    except YFRateLimitError:
        return {}, str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)"))
    except Exception as exc:  # noqa: BLE001 — 배치 하나의 실패는 사유로 돌려줍니다
        logger.warning("장중 1분봉 배치 실패: %s", exc)
        return {}, brief_error(exc)

    out: dict[str, dict] = {}
    if raw is not None and not raw.empty:
        for symbol in names:
            try:
                if isinstance(raw.columns, pd.MultiIndex):
                    if symbol not in raw.columns.get_level_values(0):
                        continue
                    closes = raw[symbol]["Close"].dropna()
                else:
                    closes = raw["Close"].dropna()
            except (KeyError, TypeError) as exc:
                logger.warning("장중 1분봉 결과 분해 실패 (%s): %s", symbol, exc)
                continue
            if closes.empty:
                continue
            price = to_float(closes.iloc[-1])
            if price is None or price <= 0:
                continue
            at = pd.Timestamp(closes.index[-1])
            at = at.tz_localize("UTC") if at.tzinfo is None else at.tz_convert("UTC")
            out[symbol] = {"price": price, "at": at.isoformat()}
    missing = [s for s in names if s not in out]
    if not missing:
        return out, None
    shown = ", ".join(missing[:3]) + ("…" if len(missing) > 3 else "")
    return out, (f"받지 못함 {len(missing)}개({shown})" if out else _empty_reason())


def _empty_reason() -> str:
    return (
        f"yfinance({getattr(yf, '__version__', '?')})가 빈 응답을 받았습니다 "
        "— Yahoo 차단 또는 라이브러리 버전 불일치를 의심하세요"
    )


def _sanitize(frame: pd.DataFrame | None) -> pd.DataFrame | None:
    if frame is None or frame.empty or "Close" not in frame.columns:
        return None
    out = frame.dropna(subset=["Close"])
    out = out[out["Close"] > 0]
    return out if not out.empty else None


def _collect_move_proxy(symbol: str, period: str) -> dict:
    """
    ⚠️ 실제 ICE BofA MOVE 지수가 아닙니다.

    Yahoo는 MOVE를 제공하지 않습니다. 10년물 금리(^TNX)의 변동성에서 역산한
    대용값이며, 실제 MOVE와 수치가 다릅니다. 실제 값이 필요하면 ICE/Bloomberg
    유료 피드를 연결하고 이 분기를 교체해야 합니다.
    """
    base_period = period if period not in ("1d", "5d") else "1mo"
    frame, _, reason = _download("^TNX", base_period)

    if frame is not None and len(frame) >= 2:
        closes = frame["Close"]
        rolling_bp_vol = closes.diff().rolling(window=5, min_periods=1).std().fillna(0.05)
        proxy_close = (88.0 + (rolling_bp_vol * 190.0) + (closes * 2.6)).round(2)

        proxy = frame.copy()
        proxy["Close"] = proxy_close
        proxy["Open"] = proxy_close
        proxy["High"] = (proxy_close * 1.01).round(2)
        proxy["Low"] = (proxy_close * 0.99).round(2)

        return {
            "symbol": symbol,
            "period": period,
            "isIntraday": False,
            "isProxy": True,
            "isSynthetic": False,
            "sourceLabel": "^TNX 변동성 기반 추정치 (실제 ICE BofA MOVE 아님)",
            "error": None,
            "points": _frame_to_points(proxy),
        }

    # 네트워크까지 실패한 경우.
    # 구버전은 여기서 사인파 합성 시계열을 만들어 채웠습니다. 값에 정보가
    # 전혀 없는데 차트는 그럴듯하게 그려지므로, 이 버전에서는 만들지 않고
    # 빈 결과를 돌려줍니다. 화면은 "수집 실패"를 그대로 표시합니다.
    logger.error("MOVE 대용 추정치 계산 실패: ^TNX 수집 불가 (%s)", reason)
    return _empty(symbol, period, f"^TNX 수집 불가 — {reason}")


def _frame_to_points(frame: pd.DataFrame) -> list[dict]:
    points: list[dict] = []
    for index, row in frame.iterrows():
        timestamp = pd.Timestamp(index)
        points.append({
            "date": timestamp.isoformat(),
            "open": to_float(row.get("Open")),
            "high": to_float(row.get("High")),
            "low": to_float(row.get("Low")),
            "close": to_float(row.get("Close")),
            "volume": to_float(row.get("Volume")),
        })
    return points


def _empty(symbol: str, period: str, error: str | None = None) -> dict:
    return {
        "symbol": symbol,
        "period": period,
        "isIntraday": False,
        "isProxy": symbol in MOVE_SYMBOLS,
        "isSynthetic": False,
        "sourceLabel": None,
        "error": error,
        "points": [],
    }


def slice_period(payload: dict, period: str) -> dict:
    """
    저장된 긴 시계열에서 요청 기간만큼 최근 구간을 잘라 냅니다.

    ^VIX/^MOVE는 화면 여러 곳이 서로 다른 기간으로 요청합니다. 기간마다
    스냅샷을 만들면 저장본이 난립하므로 가장 긴 기간으로 한 번만 저장하고
    짧은 요청은 잘라 씁니다(13F에서 q1을 q8에서 유도하는 것과 같은 방식).
    """
    days = _PERIOD_DAYS.get(period)
    points = payload.get("points") or []
    if not days or not points:
        return payload

    try:
        last = pd.Timestamp(points[-1]["date"])
        cutoff = last - pd.Timedelta(days=days)
        sliced = [p for p in points if pd.Timestamp(p["date"]) >= cutoff]
    except Exception:  # noqa: BLE001
        return payload

    if len(sliced) < 2:
        return payload
    return {**payload, "period": period, "points": sliced}


# ==============================================================================
# 2. 매크로 카드
# ==============================================================================
def collect_macro_cards(categories: list[dict]) -> dict:
    """
    카테고리별 지표 카드를 수집합니다 (5일 분봉 기준).

    반환 계약(JSON):
    {
      "categories": [
        {"id","title","items":[{key,name,note,ticker,status,price,delta,pct,
                                priceStr,deltaStr,prevStr,lastTs,prevSource?}]}
      ],
      "rates": {"us02y": {...}, "us10y": {...}, "us30y": {...}}  # 스프레드 계산용
    }
    status: ok(전일 대비 있음) | single(현재가만) | fail(수집 실패)
    note: 이 카드 출처의 지연 배지(indicators.delay_label). 카테고리 부제(note)는 보정·주입이 끝난 뒤
          macro_cards.summarize_notes가 종목 배지를 요약해 붙입니다.
    """
    from concurrent.futures import ThreadPoolExecutor

    tickers = [
        item["ticker"]
        for category in categories
        for item in category["items"]
    ]

    with ThreadPoolExecutor(max_workers=min(12, max(1, len(tickers)))) as pool:
        frames = dict(zip(
            tickers,
            pool.map(http.bind_guard(lambda symbol: collect_ticker(symbol, "5d")), tickers),
        ))

    out_categories = []
    rates: dict[str, dict] = {}

    for category in categories:
        items = []
        for spec in category["items"]:
            card = _build_card(spec, frames.get(spec["ticker"]))
            items.append(card)
            # 30년물을 빠뜨리면 화면의 30Y−2Y 스크래핑 패널이 통째로
            # "수집 실패"로 뜹니다. 수집은 됐는데 여기서 버린 것이므로
            # 사실이 아닌 실패 표시가 됩니다. 목록은 indicators에 한 곳만 둡니다.
            if spec["key"] in indicators.BOND_SCANNER_KEYS:
                rates[spec["key"]] = {
                    "current": card.get("price"),
                    "previous": card.get("prevValue"),
                }
        out_categories.append({
            "id": category["id"],
            "title": category["title"],
            "items": items,
        })

    return {"categories": out_categories, "rates": rates}


def quote_scale(key: str, raw_value: float) -> float:
    """
    원본 호가를 화면 단위로 옮기는 배율.

    JPYKRW=X는 1엔당(약 9.3)으로 올 때와 100엔당(약 930)으로 올 때가 섞입니다.
    지표 이름이 "엔/원 100엔당"이므로 낮은 쪽은 100을 곱해 맞춥니다.

    **카드와 차트가 같은 함수를 씁니다.** 예전처럼 카드 쪽에만 이 규칙이 있으면,
    같은 지표가 카드에서는 930원, 차트에서는 9.3원으로 그려집니다.
    """
    if key == "jpykrw" and raw_value < 50:
        return 100.0
    return 1.0


def _build_card(spec: dict, payload: dict | None) -> dict:
    base = {
        "key": spec["key"],
        "name": spec["name"],
        # Yahoo가 밝힌 이 티커의 지연. 다른 출처로 바꾸는 보정 단계는 배지도 그 출처의 지연으로 바꿉니다(QA-137).
        "note": indicators.delay_label(spec.get("delay")),
        # 화면은 이 분(0=실시간)과 개장 상태를 한 배지로 합칩니다 — note 문구를 쪼개 읽지 않게 따로 싣습니다.
        "delayMinutes": spec.get("delay"),
        "market": spec.get("market"),
        "ticker": spec["ticker"],
        # 모든 카드에 출처를 붙입니다. 미국채처럼 다른 출처로 덮어쓰는 카드는
        # 보정 단계(macro_cards.apply_bond_override)가 이 값을 바꿉니다.
        "source": f"Yahoo Finance ({spec['ticker']})",
    }

    points = (payload or {}).get("points") or []
    if not points:
        return {**base, "status": "fail"}

    is_intraday = bool((payload or {}).get("isIntraday"))
    raw_current = points[-1]["close"]
    if raw_current is None:
        return {**base, "status": "fail"}

    # 엔/원 100엔당 환산. 원본 현재가로 한 번만 판정합니다.
    scale = quote_scale(spec["key"], raw_current)
    current = raw_current * scale
    last_ts = _format_timestamp(points[-1]["date"], is_intraday)

    # '직전'은 전일(직전 거래일) 종가입니다(결정 2026-10-11, QA-053). 예전에는 분봉이면 바로 앞 1분봉이라 등락률이
    # 1분 변화였고, 같은 화면의 국채 카드(전일 종가)와 기준이 달랐습니다.
    previous = None
    prev_source = None

    # 세션형 상품(선물·달러인덱스)은 분봉을 달력 날짜로 나눌 수 없고, 전일 종가가 마지막 체결이 아니라 정산가입니다.
    # 일봉(세션 거래일로 표기)에서 직전 세션 종가를 찾습니다(QA-058).
    if is_intraday and _session_start(spec["ticker"]) is None:
        # 5일치 분봉에 전 거래일 장이 들어 있습니다 — 추가 호출 없이 그 마지막 체결을 씁니다.
        session_close = _previous_session_close(points)
        if session_close is not None:
            previous = session_close * scale
            prev_source = "분봉의 직전 거래일 마지막 체결"
    elif not is_intraday and len(points) >= 2 and points[-2]["close"] is not None:
        previous = points[-2]["close"] * scale       # 일봉 — 바로 앞 봉이 전일 종가

    if previous is None:
        # 분봉에 전 거래일이 없거나 봉이 하나뿐입니다. 일봉에서 직전 거래일 종가를
        # 찾습니다. 못 찾으면 "변화 없음(0.00%)"으로 위장하지 않고 N/A입니다.
        daily_prev = previous_close_from_daily(spec["ticker"], points[-1]["date"])
        if daily_prev is not None:
            previous = daily_prev * scale
            prev_source = "일봉 직전 거래일 종가"

    if previous is None:
        return {
            **base,
            "status": "single",
            "price": current,
            "priceStr": f"{current:,.2f}",
            "delta": None,
            "pct": None,
            "deltaStr": "N/A",
            "prevStr": "N/A",
            "prevValue": None,
            "lastTs": last_ts,
        }

    delta = current - previous
    pct = (delta / previous * 100.0) if previous else 0.0

    card = {
        **base,
        "status": "ok",
        "price": current,
        "priceStr": f"{current:,.2f}",
        "delta": delta,
        "pct": pct,
        "deltaStr": f"{delta:+,.2f} ({pct:+.2f}%)",
        "prevStr": f"{previous:,.2f}",
        "prevValue": previous,
        "lastTs": last_ts,
    }
    if prev_source:
        card["prevSource"] = prev_source
    return card


def _previous_session_close(points: list[dict]) -> float | None:
    """분봉에서 마지막 봉의 거래일(거래소 현지 날짜)보다 앞선 날의 마지막 종가. 없으면 None."""
    try:
        current_day = pd.Timestamp(points[-1]["date"]).date()
    except (TypeError, ValueError):
        return None
    for point in reversed(points[:-1]):
        if point.get("close") is None:
            continue
        try:
            if pd.Timestamp(point["date"]).date() < current_day:
                return float(point["close"])
        except (TypeError, ValueError):
            continue
    return None


def _session_start(symbol: str | None) -> time | None:
    """세션이 전날 저녁에 시작하는 상품이면 그 시작 시각(뉴욕), 아니면 None."""
    if not symbol:
        return None
    if symbol.endswith("=F"):
        return _FUTURES_SESSION_START
    if symbol == "DX-Y.NYB":
        return _DXY_SESSION_START
    return None


def session_day(symbol: str | None, iso_text: str) -> date | None:
    """
    체결 시각이 속한 거래일. 세션형 상품은 뉴욕 시각으로 세션 시작 이후면 다음 날,
    그 밖은 거래소 현지 날짜(시각 문자열의 날짜)입니다. 읽을 수 없으면 None.
    """
    try:
        stamp = pd.Timestamp(iso_text)
    except (TypeError, ValueError):
        return None
    start = _session_start(symbol)
    if start is None:
        return stamp.date()
    if stamp.tzinfo is None:
        stamp = stamp.tz_localize("UTC")
    local = stamp.tz_convert(NEW_YORK)
    return local.date() + timedelta(days=1) if local.time() >= start else local.date()


def _format_timestamp(iso_text: str, is_intraday: bool) -> str:
    """
    분봉이면 KST 체결 시각, 일봉이면 "거래일 + 일봉 기준".

    일봉 폴백 데이터의 시:분:초는 신뢰할 수 없으므로 거짓 시각을 만들지
    않습니다(구버전에서 고쳤던 문제).
    """
    try:
        stamp = pd.Timestamp(iso_text)
    except Exception:  # noqa: BLE001
        return "N/A"

    if is_intraday:
        if stamp.tzinfo is None:
            stamp = stamp.tz_localize("UTC")
        return kst.stamp(stamp.tz_convert(KST).to_pydatetime())

    return f"{stamp.strftime('%Y-%m-%d')} 일봉 기준"


def previous_close_from_daily(symbol: str, current_iso: str | None = None) -> float | None:
    """
    일봉에서 '현재가가 속한 거래일보다 앞선' 마지막 종가를 반환합니다.

    반환값은 yfinance 원본 스케일입니다. 표시 배율(엔/원 ×100 등)은 호출자가
    현재가와 동일하게 적용해야 합니다.
    """
    current_day = session_day(symbol, current_iso) if current_iso else None
    cache_key = (symbol, current_day) if current_day is not None and _session_start(symbol) else None
    if cache_key in _SESSION_CLOSE_CACHE:
        return _SESSION_CLOSE_CACHE[cache_key]

    payload = collect_ticker(symbol, "1mo")
    points = payload.get("points") or []
    closes = [p for p in points if p.get("close")]
    if not closes:
        return None

    if current_day is not None:
        try:
            # 세션형 상품은 세션 거래일로 비교합니다 — 저녁에 시작한 세션의 '전일'은 그날 정산가입니다(QA-058).
            earlier = [
                p for p in closes
                if pd.Timestamp(p["date"]).date() < current_day
            ]
            if earlier:
                value = float(earlier[-1]["close"])
                if cache_key is not None:
                    if len(_SESSION_CLOSE_CACHE) >= _SESSION_CLOSE_CACHE_LIMIT:
                        _SESSION_CLOSE_CACHE.clear()
                    _SESSION_CLOSE_CACHE[cache_key] = value
                return value
        except Exception as exc:  # noqa: BLE001
            logger.debug("일봉 거래일 비교 실패 (%s): %s", symbol, exc)

    if len(closes) >= 2:
        return float(closes[-2]["close"])
    return None


def now_kst_text() -> str:
    return kst.stamp()
