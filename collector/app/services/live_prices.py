"""
화면 실시간 시세(ADR 0024) — 모의 매매 장중 카드·보유 표·종목 상세가 SSE로 받는 가격(5초~3시간 주기, 사용자가 고름). 저장하지 않고 화면이
볼 때만 부릅니다(`/live/prices`, 백엔드 `feature.live`가 고른 주기마다 부름). 장부(체결·스탑·통계·결정)는 이 값을 쓰지 않습니다.

출처(2026-11-03 운영 서버에서 5초 간격 12번씩 실측 — ADR 0024)
- 미국: 네이버 해외주식 polling(여러 종목 한 번에, 로이터 코드 — 자동완성으로 찾아 하루 캐시, 5초마다 새 거래 시각) → 네이버가 못 주는 종목
  (지수 ^…·환율 =X 등)은 Yahoo spark(``v7/finance/spark`` — 한 번에 20종목). Yahoo spark는 1분 넘게 같은 값을 돌려주는 캐시 응답이라 먼저 묻지
  않습니다(QA-166). 트레이딩뷰는 로그인 없이 미국 주식이 15분 지연, 인베스팅은 종목 ID 검색이 빈 결과, 구글은 종목마다 1.4MB 페이지라 쓰지 않습니다.
- 국내: 네이버 polling(여러 종목 한 번에, 거래 시각 포함) → 다음(종목마다, Referer 필요) → 토스 1분봉(분 단위 — 마지막 대체).
- 지수·환율·금리·원자재(2단계 — 시장 메뉴 카드, 2026-11-03 실측): ``TV:거래소:심볼``은 트레이딩뷰 공개 스캐너(``global/scan`` 한 번에 여러 심볼 —
  달러지수·환율·미국채 수익률·코스피·닛케이·항셍은 실시간, 선물·상하이는 10~15분 지연을 ``delayMinutes``로), ``NI:.INX``는 네이버 해외 지수
  (S&P 500·나스닥 100 실시간 — 트레이딩뷰는 이 둘이 10~15분 지연).
같은 종목은 :data:`TTL_SECONDS` 동안 같은 값 — 5초 주기·여러 탭·여러 화면이 출처를 한 번만 부르게. 출처 거부(403·429·봇 차단)는 공용 세션의
5분 래치(http.py)를 따르고 다음 출처로 넘어갑니다. Yahoo는 yfinance 경로와 같은 래치 이름(:data:`http.YAHOO_HOST`)을 함께 씁니다(같은 한도).
모르는 값은 None(0으로 채우지 않음). 파싱(``*_from_*``)은 순수 함수라 시험이 네트워크 없이 고정 응답으로 봅니다.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from .. import http
from ..http import brief_error, get_session
from . import detail
from . import scraper
from . import toss as toss_service

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")
TTL_SECONDS = 3.0
MAX_ITEMS = 60
BATCH = 20
FETCH_TIMEOUT = 8
TOSS_SPACING_SECONDS = 0.1

YAHOO_SPARK = "https://query1.finance.yahoo.com/v7/finance/spark"
# Yahoo는 공용 세션의 브라우저 표시(http.BROWSER_HEADERS — 맥 Chrome 124)에 429를 돌려주고 다른 표시에는 200을 줍니다(2026-11-03 확인).
# 공용 표시는 다른 출처가 쓰므로 그대로 두고 이 호출만 바꿉니다.
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/141.0.0.0 Safari/537.36"}
NAVER_POLLING = "https://polling.finance.naver.com/api/realtime"
DAUM_QUOTES = "https://finance.daum.net/api/quotes"
TRADINGVIEW_SCAN = "https://scanner.tradingview.com/global/scan"
TRADINGVIEW_COLUMNS = ["close", "change", "change_abs", "update_mode", "current_session"]
TRADINGVIEW_HEADERS = {"Origin": "https://www.tradingview.com", "Referer": "https://www.tradingview.com/"}
TV_CODE = re.compile(r"^[A-Z0-9_]{1,20}:[A-Z0-9_.!]{1,20}$")
NI_CODE = re.compile(r"^\.[A-Z0-9]{1,10}$")

SOURCE_YAHOO = "Yahoo"
SOURCE_NAVER = "네이버"
SOURCE_DAUM = "다음"
SOURCE_TOSS = "토스 1분봉"
SOURCE_TRADINGVIEW = "TradingView"

OPEN, PRE, POST, CLOSED = "OPEN", "PRE", "POST", "CLOSED"

# ---------------------------------------------------------------- 요청 읽기


def parse_items(text: str) -> list[tuple[str, str]]:
    """
    ``'US:AAPL,KR:005930,TV:TVC:DXY,NI:.INX'`` → [(시장, 코드)] — 같은 것은 하나, 순서 유지. 시장은 US(Yahoo 심볼)·KR(6자리)·TV(트레이딩뷰
    '거래소:심볼')·NI(네이버 해외 지수 '.INX'). 형식이 틀리거나 :data:`MAX_ITEMS`를 넘으면 ValueError.
    """
    out: list[tuple[str, str]] = []
    for raw in (text or "").split(","):
        raw = raw.strip()
        if not raw:
            continue
        market, _, code = raw.partition(":")
        market = market.strip().upper()
        code = code.strip().upper()
        if not ((market == "US" and detail.US_CODE.match(code)) or (market == "KR" and detail.KR_CODE.match(code))
                or (market == "TV" and TV_CODE.match(code)) or (market == "NI" and NI_CODE.match(code))):
            raise ValueError(f"종목은 'US:심볼'·'KR:6자리'·'TV:거래소:심볼'·'NI:.지수'입니다: {raw[:30]}")
        if (market, code) not in out:
            out.append((market, code))
    if not out:
        raise ValueError("종목이 없습니다.")
    if len(out) > MAX_ITEMS:
        raise ValueError(f"한 번에 {MAX_ITEMS}개까지입니다.")
    return out


# ---------------------------------------------------------------- 숫자·시각


def _number(value: Any) -> float | None:
    """숫자나 '1,234.5'·'-6.86' 글 → float. 없거나 읽을 수 없으면 None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def _positive(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and number > 0 else None


def _iso(moment: datetime | None) -> str | None:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if moment else None


def _parse_time(text: Any) -> datetime | None:
    """네이버 '2026-11-02T13:57:58-05:00'(마이크로초가 붙기도 함) → aware datetime. 읽을 수 없으면 None."""
    if not isinstance(text, str) or not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _item(market: str, code: str, *, price: float, prev_close: float | None, change: float | None, change_pct: float | None,
          traded_at: datetime | None, status: str | None, source: str, currency: str | None,
          over: dict | None = None, delay_minutes: int | None = None) -> dict:
    """
    한 종목의 응답 — 등락은 주어진 값, 없으면 전일 종가로 계산(전일 종가도 없으면 None). ``over``는 시간 외(미국 프리·애프터, 국내 NXT 장 전·장 후)가
    열려 있을 때의 {price, change, changePct, tradedAt, session} — 화면은 그때 이 가격을 주 가격으로 보입니다(정규장 값은 그대로 둠).
    """
    if change is None and prev_close:
        change = price - prev_close
    if change_pct is None and prev_close and change is not None:
        change_pct = change / prev_close * 100
    if prev_close is None and change is not None:
        prev_close = price - change
    over = over or {}
    return {
        "market": market, "code": code, "price": price, "prevClose": prev_close, "change": change, "changePct": change_pct,
        "currency": currency, "tradedAt": _iso(traded_at), "status": status, "source": source, "delayMinutes": delay_minutes,
        "overPrice": over.get("price"), "overChange": over.get("change"), "overChangePct": over.get("changePct"),
        "overTradedAt": _iso(over.get("tradedAt")), "overSession": over.get("session"),
    }


# ---------------------------------------------------------------- 파싱(순수 함수)


def _yahoo_status(meta: dict, now: float) -> str | None:
    """Yahoo currentTradingPeriod(pre·regular·post의 시작·끝 epoch)로 지금 장 상태. 모르면 None."""
    periods = meta.get("currentTradingPeriod")
    if not isinstance(periods, dict):
        return None
    for key, status in (("regular", OPEN), ("pre", PRE), ("post", POST)):
        span = periods.get(key) if isinstance(periods.get(key), dict) else {}
        start, end = _number(span.get("start")), _number(span.get("end"))
        if start is not None and end is not None and start <= now < end:
            return status
    return CLOSED


def yahoo_from_spark(payload: Any, now: float) -> dict[str, dict]:
    """Yahoo spark 응답 → {심볼: 종목}. 가격이 없는 심볼은 뺍니다(모르는 심볼은 응답에서 아예 빠짐)."""
    out: dict[str, dict] = {}
    results = ((payload or {}).get("spark") or {}).get("result") if isinstance(payload, dict) else None
    for result in results if isinstance(results, list) else []:
        responses = result.get("response") if isinstance(result, dict) else None
        meta = (responses[0] or {}).get("meta") if isinstance(responses, list) and responses else None
        if not isinstance(meta, dict):
            continue
        code = str(meta.get("symbol") or result.get("symbol") or "").upper()
        price = _positive(meta.get("regularMarketPrice"))
        if not code or price is None:
            continue
        at = _number(meta.get("regularMarketTime"))
        prev_close = _positive(meta.get("previousClose")) or _positive(meta.get("chartPreviousClose"))
        out[code] = _item("US", code, price=price, prev_close=prev_close, change=None,
                          change_pct=_number(meta.get("regularMarketChangePercent")),
                          traded_at=datetime.fromtimestamp(at, timezone.utc) if at else None,
                          status=_yahoo_status(meta, now), source=SOURCE_YAHOO, currency=meta.get("currency"))
    return out


def _naver_change(data: dict) -> float | None:
    """네이버 전일 대비 — 글에 부호가 없으면(국내 '5,000') compareToPreviousPrice 코드로(4 하한·5 하락은 음수)."""
    raw = data.get("compareToPreviousClosePriceRaw", data.get("compareToPreviousClosePrice"))
    change = _number(raw)
    if change is None:
        return None
    direction = data.get("compareToPreviousPrice") if isinstance(data.get("compareToPreviousPrice"), dict) else {}
    if change > 0 and str(direction.get("code")) in ("4", "5"):
        change = -change
    return change


def _naver_status(data: dict) -> tuple[str | None, dict | None]:
    """
    (장 상태, 시간 외) — 시간 외(국내 NXT·미국 프리·애프터)가 열려 있으면 PRE·POST와 그 가격·전일 대비·거래 시각·구분, 아니면 정규장 OPEN이면 OPEN.
    시간 외를 먼저 봅니다: 국내 NXT 거래 종목은 정규장이 끝난 애프터마켓 중에도 marketStatus가 OPEN(상세 break)입니다(QA-169, 2026-11-03 실측).
    시간 외 등락의 부호는 정규장과 같은 규칙(부호 없는 글은 방향 코드로).
    """
    status = str(data.get("marketStatus") or "").upper()
    over = data.get("overMarketPriceInfo") or data.get("nxtOverMarketPriceInfo")
    if isinstance(over, dict) and str(over.get("overMarketStatus") or "").upper() == "OPEN":
        session = str(over.get("tradingSessionType") or "").upper()
        if session.startswith(("PRE", "AFTER")):
            price = _positive(over.get("overPriceRaw", over.get("overPrice")))
            detail = None if price is None else {
                "price": price, "change": _naver_change(over),
                "changePct": _number(over.get("fluctuationsRatioRaw", over.get("fluctuationsRatio"))),
                "tradedAt": _parse_time(over.get("localTradedAt")), "session": session,
            }
            return (PRE if session.startswith("PRE") else POST), detail
    if status == "OPEN":
        return OPEN, None
    return (CLOSED if status else None), None


def naver_from_polling(payload: Any, market: str, code_of: Callable[[dict], str | None]) -> dict[str, dict]:
    """네이버 polling(국내 ``domestic/stock/<코드,…>``·해외 ``worldstock/stock/<로이터,…>``) → {코드: 종목}. ``code_of``가 줄에서 화면 코드를 고릅니다."""
    out: dict[str, dict] = {}
    datas = payload.get("datas") if isinstance(payload, dict) else None
    for data in datas if isinstance(datas, list) else []:
        if not isinstance(data, dict):
            continue
        code = code_of(data)
        price = _positive(data.get("closePriceRaw", data.get("closePrice")))
        if not code or price is None:
            continue
        status, over = _naver_status(data)
        currency = data.get("currencyType", {}).get("code") if isinstance(data.get("currencyType"), dict) else None
        exchange = data.get("stockExchangeType") if isinstance(data.get("stockExchangeType"), dict) else {}
        delay = _number(exchange.get("delayTime"))
        out[code] = _item(market, code, price=price, prev_close=None, change=_naver_change(data),
                          change_pct=_number(data.get("fluctuationsRatioRaw", data.get("fluctuationsRatio"))),
                          traded_at=_parse_time(data.get("localTradedAt")), status=status, source=SOURCE_NAVER,
                          currency=currency or ("KRW" if market == "KR" else None), over=over,
                          delay_minutes=int(delay) if delay is not None else None)
    return out


_TV_STATUS = {"market": OPEN, "pre_market": PRE, "post_market": POST, "out_of_session": CLOSED}


def tradingview_from_scan(payload: Any) -> dict[str, dict]:
    """트레이딩뷰 global/scan 응답(열은 :data:`TRADINGVIEW_COLUMNS` 순서) → {'거래소:심볼': 종목}. 지연은 update_mode, 거래 시각은 주지 않음(null)."""
    out: dict[str, dict] = {}
    rows = payload.get("data") if isinstance(payload, dict) else None
    for row in rows if isinstance(rows, list) else []:
        values = row.get("d") if isinstance(row, dict) else None
        symbol = str(row.get("s") or "") if isinstance(row, dict) else ""
        if not symbol or not isinstance(values, list) or len(values) < len(TRADINGVIEW_COLUMNS):
            continue
        close, pct, change, mode, session = values[:5]
        price = _positive(close)
        if price is None:
            continue
        out[symbol] = _item("TV", symbol, price=price, prev_close=None, change=_number(change), change_pct=_number(pct),
                            traded_at=None, status=_TV_STATUS.get(str(session)), source=SOURCE_TRADINGVIEW, currency=None,
                            delay_minutes=scraper.delay_minutes(mode))
    return out


def daum_from_quote(code: str, payload: Any) -> dict | None:
    """다음 시세 → 종목(tradeDate·tradeTime은 KST). 가격이 없으면 None."""
    if not isinstance(payload, dict):
        return None
    price = _positive(payload.get("tradePrice"))
    if price is None:
        return None
    traded_at = None
    day, clock = str(payload.get("tradeDate") or ""), str(payload.get("tradeTime") or "")
    if len(day) == 8 and len(clock) == 6 and (day + clock).isdigit():
        traded_at = datetime.strptime(day + clock, "%Y%m%d%H%M%S").replace(tzinfo=KST)
    change = _number(payload.get("changePrice"))
    if change is not None and str(payload.get("change") or "").upper() in ("FALL", "LOWER_LIMIT"):
        change = -abs(change)
    rate = _number(payload.get("changeRate"))
    status = str(payload.get("marketStatus") or "").upper()
    return _item("KR", code, price=price, prev_close=_positive(payload.get("prevClosingPrice")), change=change,
                 change_pct=None if rate is None else rate * 100 * (-1 if change is not None and change < 0 and rate > 0 else 1),
                 traded_at=traded_at, status=OPEN if status == "OPEN" else (CLOSED if status else None),
                 source=SOURCE_DAUM, currency="KRW")


def toss_from_candle(code: str, candle: dict | None) -> dict | None:
    """토스 1분봉(정규화한 봉 — date·time은 KST) → 종목(전일 대비 모름). 봉이 없으면 None."""
    if not candle or _positive(candle.get("close")) is None:
        return None
    try:
        at = datetime.fromisoformat(f"{candle['date']}T{candle['time']}:00").replace(tzinfo=KST)
    except (KeyError, ValueError):
        at = None
    return _item("KR", code, price=float(candle["close"]), prev_close=None, change=None, change_pct=None,
                 traded_at=at, status=None, source=SOURCE_TOSS, currency="KRW")


# ---------------------------------------------------------------- 출처 부르기


def _chunks(values: list[str], size: int = BATCH) -> list[list[str]]:
    return [values[index:index + size] for index in range(0, len(values), size)]


def _get_json(url: str, **kwargs) -> Any:
    res = get_session().get(url, timeout=FETCH_TIMEOUT, **kwargs)
    if res.status_code != 200:
        raise RuntimeError(f"HTTP {res.status_code}")
    return res.json()


def _fetch_yahoo(codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        errors[SOURCE_YAHOO] = str(latched)
        return {}
    out: dict[str, dict] = {}
    for chunk in _chunks(codes):
        try:
            payload = _get_json(YAHOO_SPARK, params={"symbols": ",".join(chunk), "range": "1d", "interval": "1m"},
                                headers=YAHOO_HEADERS)
        except http.SourceRejected as exc:
            http.reject_host(http.YAHOO_HOST, exc.why)  # yfinance 경로(같은 Yahoo 한도)도 5분 쉼
            errors[SOURCE_YAHOO] = brief_error(exc)
            break
        except Exception as exc:  # noqa: BLE001 — 출처 하나의 실패는 다음 출처로
            errors[SOURCE_YAHOO] = brief_error(exc)
            break
        out.update(yahoo_from_spark(payload, time.time()))
    return out


def _reuters_code(code: str) -> str | None:
    """미국 심볼 → 네이버 로이터 코드(자동완성 — 질의·캐시·실패 처리는 :func:`detail.naver_world`). 못 찾으면 None."""
    item = detail.naver_world(code)
    return item["reutersCode"] if item else None


def _fetch_naver_us(codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    by_reuters = {reuters: code for code in codes if (reuters := _reuters_code(code))}
    out: dict[str, dict] = {}
    for chunk in _chunks(list(by_reuters)):
        try:
            payload = _get_json(f"{NAVER_POLLING}/worldstock/stock/{','.join(chunk)}")
        except Exception as exc:  # noqa: BLE001
            errors[SOURCE_NAVER] = brief_error(exc)
            break
        out.update(naver_from_polling(payload, "US", lambda data: by_reuters.get(str(data.get("reutersCode") or ""))))
    return out


def _fetch_naver_kr(codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for chunk in _chunks(codes):
        try:
            payload = _get_json(f"{NAVER_POLLING}/domestic/stock/{','.join(chunk)}")
        except Exception as exc:  # noqa: BLE001
            errors[SOURCE_NAVER] = brief_error(exc)
            break
        out.update(naver_from_polling(payload, "KR", lambda data: str(data.get("itemCode") or "").upper() or None))
    return out


def _fetch_daum(codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for code in codes:
        try:
            payload = _get_json(f"{DAUM_QUOTES}/A{code}", params={"summary": "false"},
                                headers={"Referer": f"https://finance.daum.net/quotes/A{code}"})
        except Exception as exc:  # noqa: BLE001
            errors[SOURCE_DAUM] = brief_error(exc)
            break
        item = daum_from_quote(code, payload)
        if item:
            out[code] = item
    return out


def _fetch_toss(codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for index, code in enumerate(codes):
        if index:
            time.sleep(TOSS_SPACING_SECONDS)
        try:
            candles, _ = toss_service.fetch_candles(code, "1m", 1, adjusted=False)
        except toss_service.TossMissingKey:
            errors[SOURCE_TOSS] = "토스 키 없음"
            break
        except Exception as exc:  # noqa: BLE001 — 403(TossForbidden)도 여기서 멈춤
            errors[SOURCE_TOSS] = brief_error(exc)
            break
        item = toss_from_candle(code, candles[0] if candles else None)
        if item:
            out[code] = item
    return out


def _fetch_tradingview(codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for chunk in _chunks(codes, 50):
        try:
            res = get_session().post(TRADINGVIEW_SCAN, json={"symbols": {"tickers": chunk}, "columns": TRADINGVIEW_COLUMNS},
                                     headers=TRADINGVIEW_HEADERS, timeout=FETCH_TIMEOUT)
            if res.status_code != 200:
                raise RuntimeError(f"HTTP {res.status_code}")
            out.update(tradingview_from_scan(res.json()))
        except Exception as exc:  # noqa: BLE001
            errors[SOURCE_TRADINGVIEW] = brief_error(exc)
            break
    return out


def _fetch_naver_index(codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for chunk in _chunks(codes):
        try:
            payload = _get_json(f"{NAVER_POLLING}/worldstock/index/{','.join(chunk)}")
        except Exception as exc:  # noqa: BLE001
            errors[SOURCE_NAVER] = brief_error(exc)
            break
        out.update(naver_from_polling(payload, "NI", lambda data: str(data.get("reutersCode") or "").upper() or None))
    return out


CHAINS: dict[str, tuple[Callable[[list[str], dict[str, str]], dict[str, dict]], ...]] = {
    "US": (_fetch_naver_us, _fetch_yahoo),   # QA-166 — Yahoo spark는 1분 넘게 같은 값이라 네이버(5초마다 새 값)를 먼저
    "KR": (_fetch_naver_kr, _fetch_daum, _fetch_toss),
    "TV": (_fetch_tradingview,),
    "NI": (_fetch_naver_index,),
}


def _fetch(market: str, codes: list[str], errors: dict[str, str]) -> dict[str, dict]:
    """시장의 출처를 차례로 — 앞 출처가 못 준 종목만 다음 출처에 묻습니다."""
    found: dict[str, dict] = {}
    for fetch in CHAINS[market]:
        left = [code for code in codes if code not in found]
        if not left:
            break
        # 물은 종목만 받습니다 — 출처가 묻지 않은 종목까지 돌려줘도 앞 출처가 이미 준 값을 덮어쓰지 않게(QA-166 재현 시험이 잡음).
        found.update({code: item for code, item in fetch(left, errors).items() if code in left})
    return found


# ---------------------------------------------------------------- 캐시와 응답

_cache: dict[tuple[str, str], tuple[float, dict | None]] = {}
_cache_lock = threading.Lock()
_fetch_lock = threading.Lock()


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()
    detail.reset_cache()   # 로이터 코드 찾기(detail.naver_world)의 캐시


def prices(items: list[tuple[str, str]]) -> dict:
    """종목들의 지금 가격 — {fetchedAt, items: {'US:AAPL': 종목}, missing: ['KR:…'], errors: {출처: 사유}}. :data:`TTL_SECONDS` 캐시."""
    errors: dict[str, str] = {}
    with _fetch_lock:   # 같은 순간의 여러 화면(SSE 구독)이 같은 종목을 두 번 묻지 않게 — 출처 응답은 수십~수백 ms
        now = time.monotonic()
        with _cache_lock:
            stale = [key for key in items if key not in _cache or _cache[key][0] <= now]
        by_market: dict[str, list[str]] = {}
        for market, code in stale:
            by_market.setdefault(market, []).append(code)
        for market, codes in by_market.items():
            found = _fetch(market, codes, errors)
            expires = time.monotonic() + TTL_SECONDS
            with _cache_lock:
                for code in codes:
                    _cache[(market, code)] = (expires, found.get(code))
    with _cache_lock:
        values = {key: _cache.get(key, (0.0, None))[1] for key in items}
    return {
        "fetchedAt": _iso(datetime.now(timezone.utc)),
        "items": {f"{market}:{code}": value for (market, code), value in values.items() if value},
        "missing": [f"{market}:{code}" for (market, code), value in values.items() if not value],
        "errors": errors,
    }
