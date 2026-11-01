"""
검색 상세 화면(종목·지표·기관 — 명세 docs/specs/2026-11-01-search-detail.md)의 실시간 조회. 저장하지 않고 화면이 볼 때만 부릅니다
(`/live/quote`·`/live/news`·`/live/symbols`, 백엔드 `feature.detail`이 부름).

출처
- 미국·해외 종목·지수·환율: Yahoo Finance(yfinance `Ticker.info` — 지연 시세, 비공식 참고), 뉴스·종목 찾기는 yfinance `Search`.
- 국내 종목: 네이버 증권 모바일 API(m.stock.naver.com `basic`·`integration`·`news`, 종목 찾기 ac.stock.naver.com).
- 뉴스 검색어: 구글 뉴스 RSS 검색(news.google.com/rss/search, 최근 7일).
Yahoo·네이버·구글 뉴스는 robots.txt가 막는 출처지만 사용자가 개인·비상업 용도로 허락했습니다(2026-11-01, docs/decisions.md). 그래도
출처 링크·받은 시각을 함께 내고, Yahoo는 공용 거부 래치(http.YAHOO_HOST), 네이버·구글은 수집기 공용 세션의 래치·간격을 따릅니다.

같은 질의는 잠깐 캐시합니다(시세·지표 5분, 뉴스 15분, 종목 찾기 1시간 — 실패한 응답은 1분) — 화면을 여러 번 열어도 출처를 두드리지 않게.
파싱(`*_from_*`)은 순수 함수라 시험이 네트워크 없이 고정 응답으로 봅니다.
"""
from __future__ import annotations

import calendar
import html
import io
import logging
import re
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

import feedparser
import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from .. import http
from ..http import brief_error, get_session

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")
NAVER_API = "https://m.stock.naver.com/api"
NAVER_AC = "https://ac.stock.naver.com/ac"
GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"
FETCH_TIMEOUT = 10

QUOTE_TTL = 300.0
NEWS_TTL = 900.0
SYMBOLS_TTL = 3600.0
FAILURE_TTL = 60.0
NEWS_LIMIT = 15

US_CODE = re.compile(r"^[A-Za-z0-9^=.\-]{1,24}$")
KR_CODE = re.compile(r"^[0-9A-Z]{6}$")

YAHOO_SOURCE = "Yahoo Finance(yfinance) — 지연 시세, 비공식 참고"
NAVER_SOURCE = "네이버 증권"
GOOGLE_SOURCE = "Google News"

# ---------------------------------------------------------------- 짧은 캐시

_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _cached(key: tuple, ttl: float, fetch: Callable[[], dict]) -> dict:
    """같은 키는 ttl초 동안 같은 응답 — 오류가 있는 응답은 FAILURE_TTL만(출처가 돌아오면 곧 다시 묻게)."""
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None and hit[0] > now:
            return hit[1]
    value = fetch()
    life = FAILURE_TTL if value.get("error") else ttl
    with _cache_lock:
        _cache[key] = (now + life, value)
        if len(_cache) > 500:
            for stale in [k for k, (until, _) in _cache.items() if until <= now]:
                _cache.pop(stale, None)
    return value


def reset_cache() -> None:
    """시험용 — 캐시를 비웁니다."""
    with _cache_lock:
        _cache.clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _number(value: Any) -> float | None:
    """유한한 숫자만(문자열·NaN·무한은 모름)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _text(value: Any) -> str | None:
    text = html.unescape(str(value)).strip() if value is not None else ""
    return text or None


def yahoo_symbol_of(market: str, code: str, exchange: str | None = None) -> str:
    """차트용 Yahoo 심볼 — 미국·해외는 코드 그대로, 국내는 코스닥 '.KQ', 그 밖 '.KS'."""
    if market != "kr":
        return code
    return f"{code}.KQ" if (exchange or "").upper() in ("KQ", "KOSDAQ") else f"{code}.KS"


# ---------------------------------------------------------------- 시세·지표

# Yahoo `Ticker.info`에서 옮기는 핵심 지표 — (키, 이름, 단위). 단위 'pct'는 이미 % 값(yfinance 1.x의 dividendYield).
_US_STATS = (
    ("marketCap", "시가총액", "money"),
    ("trailingPE", "PER(최근 4분기)", "x"),
    ("forwardPE", "선행 PER", "x"),
    ("priceToBook", "PBR", "x"),
    ("trailingEps", "EPS(최근 4분기)", "money"),
    ("dividendYield", "배당수익률", "pct"),
    ("beta", "베타", "x"),
    ("fiftyTwoWeekHigh", "52주 최고", "price"),
    ("fiftyTwoWeekLow", "52주 최저", "price"),
    ("volume", "거래량", "count"),
    ("averageVolume", "평균 거래량(3개월)", "count"),
    ("sharesOutstanding", "발행 주식 수", "count"),
)


def quote_from_yahoo(code: str, info: dict) -> dict:
    """yfinance `Ticker.info` → 상세 시세 응답(미국·해외). 값이 없으면 null — 0으로 채우지 않습니다."""
    price = _number(info.get("regularMarketPrice")) or _number(info.get("currentPrice"))
    previous = _number(info.get("regularMarketPreviousClose")) or _number(info.get("previousClose"))
    change = price - previous if price is not None and previous is not None else None
    change_pct = change / previous * 100 if change is not None and previous else None
    market_time = info.get("regularMarketTime")
    stats = [{"key": key, "label": label, "value": _number(info.get(key)), "text": None, "unit": unit} for key, label, unit in _US_STATS]
    name = _text(info.get("longName")) or _text(info.get("shortName"))
    return {
        "market": "us",
        "code": code,
        "yahooSymbol": code,
        "name": name,
        "exchange": _text(info.get("fullExchangeName")) or _text(info.get("exchange")),
        "currency": _text(info.get("currency")),
        "kind": _text(info.get("quoteType")),
        "price": price,
        "previousClose": previous,
        "change": change,
        "changePct": change_pct,
        "asOf": datetime.fromtimestamp(market_time, timezone.utc).isoformat(timespec="seconds")
        if isinstance(market_time, (int, float)) and not isinstance(market_time, bool) else None,
        "marketState": _text(info.get("marketState")),
        "stats": [s for s in stats if s["value"] is not None],
        "profile": {
            "sector": _text(info.get("sector")),
            "industry": _text(info.get("industry")),
            "country": _text(info.get("country")),
            "website": _text(info.get("website")),
            "employees": _number(info.get("fullTimeEmployees")),
            "summary": _text(info.get("longBusinessSummary")),
        },
        "consensus": {
            "targetMean": _number(info.get("targetMeanPrice")),
            "recommendation": _text(info.get("recommendationKey")),
            "analysts": _number(info.get("numberOfAnalystOpinions")),
        },
        "research": [],
        "source": {"label": YAHOO_SOURCE, "url": f"https://finance.yahoo.com/quote/{urllib.parse.quote(code)}"},
        "error": None if name or price is not None else "Yahoo가 이 심볼의 정보를 주지 않음",
    }


def _signed(value: Any) -> float | None:
    """네이버의 '−11,500'·'-4.96' 같은 글 → 숫자(없으면 None)."""
    if value is None:
        return None
    text = str(value).replace(",", "").replace("−", "-").strip()
    try:
        return float(text)
    except ValueError:
        return None


def quote_from_naver(code: str, basic: dict, integration: dict | None) -> dict:
    """네이버 `basic`·`integration` → 상세 시세 응답(국내). 지표는 네이버가 적은 글 그대로(단위 포함 — '9.89배', '1,289조 1,044억')."""
    exchange = basic.get("stockExchangeType") or {}
    exchange_code = _text(exchange.get("code")) if isinstance(exchange, dict) else None
    integration = integration or {}
    infos = integration.get("totalInfos") or []
    stats = [{"key": _text(item.get("code")) or "", "label": _text(item.get("key")) or "", "value": None, "text": _text(item.get("value")),
              "unit": "text"} for item in infos if isinstance(item, dict) and _text(item.get("value"))]
    consensus = integration.get("consensusInfo") or {}
    research = []
    for item in (integration.get("researches") or [])[:5]:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        research.append({
            "title": _text(item.get("tit")),
            "broker": _text(item.get("bnm")),
            "date": _compact_date(item.get("wdt")),
            "url": f"https://finance.naver.com/research/company_read.naver?nid={item.get('id')}",
        })
    price = _signed(basic.get("closePrice"))
    change = _signed(basic.get("compareToPreviousClosePrice"))
    previous = price - change if price is not None and change is not None else None
    name = _text(basic.get("stockName"))
    return {
        "market": "kr",
        "code": code,
        "yahooSymbol": yahoo_symbol_of("kr", code, exchange_code),
        "name": name,
        "exchange": _text(basic.get("stockExchangeName")),
        "currency": "KRW",
        "kind": _text(basic.get("stockEndType")),
        "price": price,
        "previousClose": previous,
        "change": change,
        "changePct": _signed(basic.get("fluctuationsRatio")),
        "asOf": _text(basic.get("localTradedAt")),
        "marketState": _text(basic.get("marketStatus")),
        "stats": stats,
        "profile": {"sector": None, "industry": None, "country": "대한민국", "website": None, "employees": None,
                    "summary": _text(integration.get("description"))},
        "consensus": {"targetMean": _signed(consensus.get("priceTargetMean")) if isinstance(consensus, dict) else None,
                      "recommendation": _text(consensus.get("recommMean")) if isinstance(consensus, dict) else None,
                      "analysts": None},
        "research": research,
        "source": {"label": NAVER_SOURCE, "url": _text(basic.get("endUrl")) or f"https://m.stock.naver.com/domestic/stock/{code}"},
        "error": None if name else "네이버가 이 종목의 정보를 주지 않음",
    }


def _compact_date(value: Any) -> str | None:
    """'20261030' → '2026-10-30'(아니면 None)."""
    text = str(value or "")
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}" if re.fullmatch(r"\d{8}", text) else None


def _yahoo_info(code: str) -> tuple[dict | None, str | None]:
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return None, str(latched)
    try:
        return yf.Ticker(code).info or {}, None
    except YFRateLimitError:
        return None, str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)"))
    except Exception as exc:  # noqa: BLE001 — 출처 하나의 실패
        return None, brief_error(exc)


def _naver_json(path: str) -> tuple[Any, str | None]:
    try:
        res = get_session().get(NAVER_API + path, timeout=FETCH_TIMEOUT)
        if res.status_code != 200:
            return None, f"HTTP {res.status_code}"
        return res.json(), None
    except Exception as exc:  # noqa: BLE001
        return None, brief_error(exc)


def quote(market: str, code: str) -> dict:
    """시세·핵심 지표·개요(시장 'us' = Yahoo 심볼, 'kr' = 국내 6자리 코드)."""
    def fetch() -> dict:
        if market == "kr":
            basic, error = _naver_json(f"/stock/{code}/basic")
            if not isinstance(basic, dict):
                return _empty_quote(market, code, error or "네이버 응답 없음")
            integration, _ = _naver_json(f"/stock/{code}/integration")
            out = quote_from_naver(code, basic, integration if isinstance(integration, dict) else None)
        else:
            info, error = _yahoo_info(code)
            if info is None:
                return _empty_quote(market, code, error)
            out = quote_from_yahoo(code, info)
        out["fetchedAt"] = _now_iso()
        return out
    return _cached(("quote", market, code), QUOTE_TTL, fetch)


def _empty_quote(market: str, code: str, error: str | None) -> dict:
    return {"market": market, "code": code, "yahooSymbol": yahoo_symbol_of(market, code), "name": None, "exchange": None,
            "currency": None, "kind": None, "price": None, "previousClose": None, "change": None, "changePct": None, "asOf": None,
            "marketState": None, "stats": [], "profile": None, "consensus": None, "research": [], "source": None,
            "error": error or "정보를 받지 못함", "fetchedAt": _now_iso()}


# ---------------------------------------------------------------- 뉴스

def news_from_yahoo(items: list) -> list[dict]:
    out = []
    for item in items or []:
        if not isinstance(item, dict) or not item.get("title") or not item.get("link"):
            continue
        published = item.get("providerPublishTime")
        out.append({
            "title": _text(item.get("title")),
            "url": str(item.get("link")),
            "publisher": _text(item.get("publisher")),
            "publishedAt": datetime.fromtimestamp(published, timezone.utc).isoformat(timespec="seconds")
            if isinstance(published, (int, float)) and not isinstance(published, bool) else None,
            "source": "Yahoo Finance",
        })
    return out


def news_from_naver(payload: Any) -> list[dict]:
    """네이버 종목 뉴스 — 응답은 묶음 목록([{total, items:[…]}]). 시각 'yyyyMMddHHmm'은 KST."""
    groups = payload if isinstance(payload, list) else [payload] if isinstance(payload, dict) else []
    out = []
    for group in groups:
        for item in (group or {}).get("items") or []:
            if not isinstance(item, dict) or not item.get("title") or not item.get("officeId") or not item.get("articleId"):
                continue
            stamp = str(item.get("datetime") or "")
            published = None
            if re.fullmatch(r"\d{12}", stamp):
                published = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=KST).astimezone(timezone.utc).isoformat(timespec="seconds")
            out.append({
                "title": _text(item.get("title")),
                "url": f"https://n.news.naver.com/mnews/article/{item['officeId']}/{item['articleId']}",
                "publisher": _text(item.get("officeName")),
                "publishedAt": published,
                "source": NAVER_SOURCE,
            })
    return out


def news_from_google(content: bytes, content_type: str | None = None) -> list[dict]:
    """구글 뉴스 RSS — 제목 끝의 ' - 매체'는 떼고 매체(<source>) 칸으로. 수집 RSS 파서(news.parse_feed)는 매체 칸을 버려 feedparser를 직접 씁니다."""
    parsed = feedparser.parse(io.BytesIO(content), response_headers={"content-type": content_type or "application/rss+xml"})
    out = []
    for entry in parsed.entries:
        title = _text(entry.get("title"))
        link = entry.get("link")
        if not title or not link:
            continue
        publisher = _text((entry.get("source") or {}).get("title")) if isinstance(entry.get("source"), dict) else None
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3].rstrip()
        stamp = entry.get("published_parsed")
        published = datetime.fromtimestamp(calendar.timegm(stamp), timezone.utc).isoformat(timespec="seconds") if stamp else None
        out.append({"title": title, "url": str(link), "publisher": publisher, "publishedAt": published, "source": GOOGLE_SOURCE})
    return out


def merge_news(*groups: list[dict], limit: int = NEWS_LIMIT) -> list[dict]:
    """
    여러 출처를 합쳐 최신순으로 — 같은 기사는 먼저 온 출처 하나만. 같은 기사는 기호·공백·대소문자를 뺀 제목의 앞 24자로 가립니다(네이버는 긴
    제목을 '...'로 줄여 보내 구글 뉴스의 같은 기사와 끝이 다름). 시각을 모르면 뒤로.
    """
    seen: set[str] = set()
    merged = []
    for group in groups:
        for item in group:
            key = re.sub(r"\W+", "", (item.get("title") or "").lower())[:24]
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(item)
    merged.sort(key=lambda item: item.get("publishedAt") or "", reverse=True)
    return merged[:limit]


def _google_news(q: str, lang: str) -> tuple[list[dict], str | None]:
    params = {"q": f"{q} when:7d"}
    params.update({"hl": "ko", "gl": "KR", "ceid": "KR:ko"} if lang == "ko" else {"hl": "en-US", "gl": "US", "ceid": "US:en"})
    try:
        res = get_session().get(GOOGLE_NEWS_RSS, params=params, timeout=FETCH_TIMEOUT)
        if res.status_code != 200:
            return [], f"HTTP {res.status_code}"
        return news_from_google(res.content, res.headers.get("Content-Type")), None
    except Exception as exc:  # noqa: BLE001
        return [], brief_error(exc)


def _yahoo_news(code: str) -> tuple[list[dict], str | None]:
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return [], str(latched)
    try:
        return news_from_yahoo(yf.Search(code, news_count=10, max_results=1).news), None
    except YFRateLimitError:
        return [], str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)"))
    except Exception as exc:  # noqa: BLE001
        return [], brief_error(exc)


def news(market: str | None, code: str | None, q: str | None) -> dict:
    """
    주요 뉴스 — 종목 코드가 있으면 그 종목 뉴스(미국·해외 Yahoo, 국내 네이버), 검색어가 있으면 구글 뉴스 RSS(국내 종목·한글 검색어는 한국어 판).
    출처마다 실패는 `errors`에 남기고 받은 것만 합칩니다(하나도 없으면 `error`).
    """
    def fetch() -> dict:
        groups: list[list[dict]] = []
        errors: dict[str, str] = {}
        if code and market == "kr":
            payload, error = _naver_json(f"/news/stock/{code}?pageSize=10&page=1")
            groups.append(news_from_naver(payload))
            if error:
                errors[NAVER_SOURCE] = error
        elif code:
            items, error = _yahoo_news(code)
            groups.append(items)
            if error:
                errors["Yahoo Finance"] = error
        if q:
            lang = "ko" if market == "kr" or re.search(r"[가-힣]", q) else "en"
            items, error = _google_news(q, lang)
            groups.append(items)
            if error:
                errors[GOOGLE_SOURCE] = error
        items = merge_news(*groups)
        return {"items": items, "errors": errors, "error": None if items or not errors else "; ".join(f"{k}: {v}" for k, v in errors.items()),
                "fetchedAt": _now_iso()}
    return _cached(("news", market, code, q), NEWS_TTL, fetch)


# ---------------------------------------------------------------- 종목 찾기

def symbols_from_yahoo(quotes: list) -> list[dict]:
    """Yahoo 검색 결과 → 후보. '.KS'·'.KQ'는 국내 코드로 바꿉니다(국내 상세는 네이버)."""
    out = []
    for item in quotes or []:
        symbol = str((item or {}).get("symbol") or "")
        if not symbol or not US_CODE.match(symbol):
            continue
        match = re.fullmatch(r"([0-9A-Z]{6})\.(KS|KQ)", symbol)
        out.append({
            "market": "kr" if match else "us",
            "code": match.group(1) if match else symbol,
            "yahooSymbol": symbol,
            "name": _text(item.get("longname")) or _text(item.get("shortname")) or symbol,
            "exchange": _text(item.get("exchDisp")) or _text(item.get("exchange")),
            "kind": _text(item.get("quoteType")),
            "source": "Yahoo Finance",
        })
    return out


def symbols_from_naver(payload: Any) -> list[dict]:
    items = payload.get("items") if isinstance(payload, dict) else None
    out = []
    for item in items if isinstance(items, list) else []:
        code = str((item or {}).get("code") or "")
        if not KR_CODE.match(code) or (item.get("nationCode") not in (None, "KOR")):
            continue
        exchange = _text(item.get("typeCode"))
        out.append({
            "market": "kr",
            "code": code,
            "yahooSymbol": yahoo_symbol_of("kr", code, exchange),
            "name": _text(item.get("name")) or code,
            "exchange": _text(item.get("typeName")) or exchange,
            "kind": _text(item.get("category")),
            "source": NAVER_SOURCE,
        })
    return out


def symbols(q: str) -> dict:
    """종목 찾기 — 한글·숫자 질의는 네이버 자동완성 먼저, 그 밖은 Yahoo 검색 먼저(둘 다 부르고 같은 시장·코드는 하나만)."""
    def fetch() -> dict:
        errors: dict[str, str] = {}
        naver: list[dict] = []
        yahoo: list[dict] = []
        try:
            res = get_session().get(NAVER_AC, params={"q": q, "target": "stock"}, timeout=FETCH_TIMEOUT)
            if res.status_code == 200:
                naver = symbols_from_naver(res.json())
            else:
                errors[NAVER_SOURCE] = f"HTTP {res.status_code}"
        except Exception as exc:  # noqa: BLE001
            errors[NAVER_SOURCE] = brief_error(exc)
        latched = http.active_rejection(http.YAHOO_HOST)
        if latched is not None:
            errors["Yahoo Finance"] = str(latched)
        else:
            try:
                yahoo = symbols_from_yahoo(yf.Search(q, news_count=0, max_results=8).quotes)
            except YFRateLimitError:
                errors["Yahoo Finance"] = str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)"))
            except Exception as exc:  # noqa: BLE001
                errors["Yahoo Finance"] = brief_error(exc)
        korean_first = bool(re.search(r"[가-힣]", q)) or bool(re.fullmatch(r"\d{1,6}", q))
        ordered = (naver + yahoo) if korean_first else (yahoo + naver)
        seen: set[tuple[str, str]] = set()
        items = []
        for item in ordered:
            key = (item["market"], item["code"])
            if key not in seen:
                seen.add(key)
                items.append(item)
        return {"items": items[:10], "errors": errors, "error": None if items or not errors else "; ".join(errors.values()),
                "fetchedAt": _now_iso()}
    return _cached(("symbols", q.strip().lower()), SYMBOLS_TTL, fetch)
