"""
app/services/search_sources.py
정보 검색(ADR 0041)의 바깥 출처 — 구글 뉴스 RSS(한국어·영어 판)·Bing 뉴스 RSS·Yahoo 검색 뉴스·네이버 종목 뉴스·연합인포맥스.

- 공용 세션(``http.get_session`` — 호스트 간격·거부 래치)으로 부릅니다. 네이버는 상세 화면의 함수(``detail._naver_json``·``news_from_naver``)를,
  Yahoo는 상세 화면과 같은 yfinance 방식(거부 래치 ``http.YAHOO_HOST`` + 무응답 래치 ``app.yahoo``)을 씁니다. 네이버를 부르는 길을 새로 늘리지
  않습니다(이미 있는 종목 뉴스 응답만).
- 연합인포맥스는 상세 화면처럼 구글 뉴스 검색을 그 사이트로 좁힌 것이지만 2년 창이 필요해 ``when:7d`` 대신 ``after:``를 붙여 따로 부릅니다.
- 출처마다 메모리 캐시(성공 15분·실패 60초). 외부 호출을 끈 요청(``external=false`` — 데모·``STORE_ONLY``)은 캐시만 보고 부르지 않습니다.
- 검색어·경로·인자는 로그와 오류 글에 남기지 않습니다(호스트와 상태 코드만). urllib3의 재시도 경고가 경로와 인자를 찍으므로 검색 경로의 그
  부분을 지우는 거름을 그 로거에 답니다.
- 파싱(``parse_*``·``yahoo_items``)은 순수 함수라 시험이 합성 응답으로 봅니다.
"""
from __future__ import annotations

import calendar
import html
import io
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import feedparser
import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from .. import http, yahoo
from . import detail
from . import search_rules as rules

logger = logging.getLogger(__name__)

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"
BING_NEWS_RSS = "https://www.bing.com/news/search"
GOOGLE_EDITIONS = {"ko": {"hl": "ko", "gl": "KR", "ceid": "KR:ko"}, "en": {"hl": "en-US", "gl": "US", "ceid": "US:en"}}
BING_EDITIONS = {"ko": {"setlang": "ko-KR", "cc": "KR"}, "en": {"setlang": "en-US", "cc": "US"}}
EDITION_LABELS = {"ko": "한국어", "en": "영어"}
FETCH_TIMEOUT = (5, 10)          # (연결, 읽기) 초 — 세션 재시도(2번)와 곱해도 출처 하나가 40초를 넘지 않게
YAHOO_TIMEOUT = 10
YAHOO_NEWS_COUNT = 20
NAVER_PAGE_SIZE = 20

SOURCE_TTL = 900.0               # 성공한 출처 결과 15분
FAILURE_TTL = 60.0               # 실패한 출처 60초
_CACHE_LIMIT = 1000


@dataclass
class Fetched:
    """출처 한 곳의 결과 — 줄(계약 FeedItem 모양), 실패 사유, 안내, 캐시에서 왔는지, 외부 호출을 꺼서 부르지 않았는지."""
    items: list[dict] = field(default_factory=list)
    error: str | None = None
    note: str | None = None
    cached: bool = False
    offline: bool = False


# ------------------------------------------------------------------ 로그·오류 글에서 검색어 지우기

_SEARCH_PATHS = ("/rss/search", "/news/search", "/w/api.php", "/news/stock/")


class _SearchPathLogFilter(logging.Filter):
    """urllib3 재시도 경고(``Retrying (...) after ...: <경로?인자>``)에서 정보 검색 경로의 경로·인자를 지웁니다 — 검색어가 로그에 남지 않게."""

    @staticmethod
    def _scrub(value: Any) -> Any:
        if isinstance(value, str) and any(path in value for path in _SEARCH_PATHS):
            return re.sub(r"/(?:api/)?(?:rss/search|news/search|w/api\.php|news/stock/)\S*", "(검색 경로 생략)", value)
        return value

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(self._scrub(arg) for arg in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: self._scrub(arg) for key, arg in record.args.items()}
        record.msg = self._scrub(record.msg)
        return True


def _install_log_filter() -> None:
    target = logging.getLogger("urllib3.connectionpool")
    if not any(isinstance(existing, _SearchPathLogFilter) for existing in target.filters):
        target.addFilter(_SearchPathLogFilter())


_install_log_filter()


def safe_reason(exc: BaseException, host: str | None = None) -> str:
    """
    예외 → 화면용 한 줄(경로·인자·검색어 없음). 출처 거부(래치)는 그 한 줄 그대로(호스트·근거만), 그 밖은 ``http.brief_error``가 고른
    조치 안내가 있으면 그것, 없으면 예외 이름만 — 원래 메시지에는 요청 주소가 섞일 수 있어 싣지 않습니다.
    """
    if isinstance(exc, http.SourceRejected):
        return str(exc)
    name = type(exc).__name__
    text = http.brief_error(exc)
    reason = text if text.startswith(f"{name} — ") else f"{name}(연결·응답 실패)"
    return f"{host} {reason}" if host else reason


def _status_reason(url: str, status: int) -> str:
    return f"{http.host_of(url)} HTTP {status}"


# ------------------------------------------------------------------ 출처별 캐시

_cache: dict[tuple, tuple[float, Fetched]] = {}
_inflight: dict[tuple, threading.Event] = {}
_cache_lock = threading.Lock()
INFLIGHT_WAIT = 45.0             # 같은 출처를 이미 부르는 중일 때 그 결과를 기다리는 상한(초)


def _hit(key: tuple) -> Fetched | None:
    with _cache_lock:
        hit = _cache.get(key)
    if hit is None or hit[0] <= time.monotonic():
        return None
    value = hit[1]
    return Fetched(items=list(value.items), error=value.error, note=value.note, cached=True)


def cached(key: tuple, fetch: Callable[[], Fetched], *, external: bool = True) -> Fetched:
    """
    출처별 캐시 — 성공 SOURCE_TTL, 실패(error) FAILURE_TTL. ``external``이 거짓이면 캐시에 있는 것만 돌려주고 없으면 부르지 않고 ``offline``.
    캐시에서 온 결과는 ``cached=True``인 사본입니다. 같은 키를 이미 부르는 중이면 다시 보내지 않고 그 결과를 기다립니다 — 출처가 응답하지
    않는 동안 요청마다 같은 호출이 쌓이지 않게(기다림도 INFLIGHT_WAIT까지).
    """
    hit = _hit(key)
    if hit is not None:
        return hit
    if not external:
        return Fetched(offline=True)
    with _cache_lock:
        running = _inflight.get(key)
        if running is None:
            _inflight[key] = threading.Event()
    if running is not None:
        running.wait(INFLIGHT_WAIT)
        return _hit(key) or Fetched(error="같은 출처를 부르는 중 — 잠시 뒤 다시")
    try:
        value = fetch()
        life = FAILURE_TTL if value.error else SOURCE_TTL
        stamp = time.monotonic()
        with _cache_lock:
            _cache[key] = (stamp + life, value)
            if len(_cache) > _CACHE_LIMIT:
                for stale in [k for k, (until, _) in _cache.items() if until <= stamp]:
                    _cache.pop(stale, None)
        return value
    finally:
        with _cache_lock:
            done = _inflight.pop(key, None)
        if done is not None:
            done.set()


def reset_cache() -> None:
    """시험용 — 출처별 캐시를 비웁니다."""
    with _cache_lock:
        _cache.clear()


# ------------------------------------------------------------------ 줄 만들기

def feed_item(*, title: str, url: str | None, publisher: str | None, domain: str | None, published: Any, source: str,
              lang: str | None, kind: str = "news", basis: str = "published", summary: str | None = None,
              reader_id: str | None = None, item_id: str | None = None) -> dict:
    """계약 FeedItem 한 줄. 시각은 UTC ISO로 맞추고, 모르는 값은 None."""
    moment = rules.parse_time(published)
    return {
        "id": item_id or rules.item_key(url, title),
        "kind": kind,
        "title": title,
        "url": url or None,
        "publisher": publisher or None,
        "publisherDomain": domain or None,
        "publishedAt": rules.utc_iso(moment) if moment else None,
        "timeBasis": basis,
        "source": source,
        "lang": lang,
        "summary": rules.clip(summary),
        "readerId": reader_id,
    }


def _text(value: Any) -> str | None:
    text = html.unescape(str(value)).strip() if value is not None else ""
    return text or None


def _entry_time(entry: Any) -> datetime | None:
    stamp = entry.get("published_parsed") or entry.get("updated_parsed")
    if not stamp:
        return None
    try:
        return datetime.fromtimestamp(calendar.timegm(stamp), timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _parse_feed(content: bytes, content_type: str | None):
    # 문자열·주소가 아니라 BytesIO로 — feedparser가 받은 글을 주소로 보고 열지 않게(수집 RSS 파서와 같은 방식).
    return feedparser.parse(io.BytesIO(content or b""), response_headers={"content-type": content_type or "application/rss+xml"})


def parse_google(content: bytes, content_type: str | None, *, source: str, lang: str) -> list[dict]:
    """구글 뉴스 RSS → 줄. 제목 끝 ' - 매체'는 떼고 매체 칸(<source>)으로, 매체 도메인은 <source url>의 호스트. 요약은 제목을 되풀이할 뿐이라 비움."""
    out = []
    for entry in _parse_feed(content, content_type).entries:
        title = _text(entry.get("title"))
        link = entry.get("link")
        if not title or not link:
            continue
        origin = entry.get("source") if isinstance(entry.get("source"), dict) else {}
        publisher = _text(origin.get("title"))
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3].rstrip()
        out.append(feed_item(title=title, url=str(link), publisher=publisher, domain=rules.domain_of(origin.get("href")),
                             published=_entry_time(entry), source=source, lang=lang))
    return out


def _bing_original(link: str) -> str | None:
    try:
        values = parse_qs(urlsplit(link).query).get("url") or []
    except ValueError:
        return None
    original = values[0].strip() if values else ""
    return original if rules.domain_of(original) else None


def parse_bing(content: bytes, content_type: str | None, *, lang: str) -> list[dict]:
    """Bing 뉴스 RSS → 줄. 원문 주소는 링크의 인자 ``url``(없으면 링크 그대로, 매체 도메인은 모름), 매체는 ``News:Source``."""
    out = []
    for entry in _parse_feed(content, content_type).entries:
        title = _text(entry.get("title"))
        link = entry.get("link")
        if not title or not link:
            continue
        original = _bing_original(str(link))
        summary = _text(entry.get("summary") or entry.get("description"))
        out.append(feed_item(title=title, url=original or str(link), publisher=_text(entry.get("news_source")),
                             domain=rules.domain_of(original) if original else None, published=_entry_time(entry),
                             source="bing", lang=lang, summary=summary))
    return out


def yahoo_items(news: Any, ticker: str) -> tuple[list[dict], int]:
    """
    Yahoo 검색 뉴스 → (그 티커가 ``relatedTickers``에 있는 줄, 뺀 줄 수). 이름이 비슷한 다른 회사 기사를 거릅니다. ``relatedTickers``가 없는
    줄도 뺍니다(관련을 알 수 없음 — 서버 실측에서는 10/10에 있었음).
    """
    related = []
    other = 0
    for item in news if isinstance(news, list) else []:
        tickers = item.get("relatedTickers") if isinstance(item, dict) else None
        if isinstance(tickers, list) and any(isinstance(t, str) and rules.same_ticker(t, ticker) for t in tickers):
            related.append(item)
        else:
            other += 1
    out = [feed_item(title=row["title"], url=row["url"], publisher=row.get("publisher"), domain=rules.domain_of(row["url"]),
                     published=row.get("publishedAt"), source="yahoo", lang="en")
           for row in detail.news_from_yahoo(related)]
    return out, other


# ------------------------------------------------------------------ 부르기

def _session(session):
    return session if session is not None else http.get_session()


def _google_raw(query: str, lang: str, session) -> tuple[bytes | None, str | None, str | None]:
    params = {"q": query}
    params.update(GOOGLE_EDITIONS[lang])
    try:
        res = _session(session).get(GOOGLE_NEWS_RSS, params=params, timeout=FETCH_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — 출처 하나의 실패
        return None, None, safe_reason(exc, http.host_of(GOOGLE_NEWS_RSS))
    if res.status_code != 200:
        return None, None, _status_reason(GOOGLE_NEWS_RSS, res.status_code)
    return res.content, res.headers.get("Content-Type"), None


def google(terms: list[str], lang: str, *, after: str | None, session=None) -> Fetched:
    """구글 뉴스 RSS 한 판(ko·en) — 검색식에 ``after:<창 시작>``(믿지 않고 규칙 1로 다시 자름)."""
    query = rules.build_query(terms, after=after)
    if query is None:
        return Fetched()
    content, content_type, error = _google_raw(query, lang, session)
    if error:
        return Fetched(error=error)
    return Fetched(items=parse_google(content, content_type, source=f"google_{lang}", lang=lang))


def infomax(terms: list[str], *, after: str | None, session=None) -> Fetched:
    """연합인포맥스 — 구글 뉴스 RSS(한국어 판) 검색을 그 사이트로 좁힘."""
    query = rules.build_query(terms, after=after, site=detail.INFOMAX_SITE)
    if query is None:
        return Fetched()
    content, content_type, error = _google_raw(query, "ko", session)
    if error:
        return Fetched(error=error)
    return Fetched(items=parse_google(content, content_type, source="infomax", lang="ko"))


def bing(terms_by_lang: dict[str, list[str]], *, session=None) -> Fetched:
    """Bing 뉴스 RSS — 검색어가 있는 판(ko·en)마다 한 번. 한 판만 실패하면 받은 것과 안내, 모두 실패하면 오류."""
    items: list[dict] = []
    failures: list[str] = []
    asked = 0
    for lang in ("ko", "en"):
        query = rules.build_query(terms_by_lang.get(lang) or [])
        if query is None:
            continue
        asked += 1
        params = {"q": query, "format": "rss"}
        params.update(BING_EDITIONS[lang])
        try:
            res = _session(session).get(BING_NEWS_RSS, params=params, timeout=FETCH_TIMEOUT)
            if res.status_code != 200:
                failures.append(f"{EDITION_LABELS[lang]} 판 {_status_reason(BING_NEWS_RSS, res.status_code)}")
                continue
            items.extend(parse_bing(res.content, res.headers.get("Content-Type"), lang=lang))
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{EDITION_LABELS[lang]} 판 {safe_reason(exc, http.host_of(BING_NEWS_RSS))}")
    if asked and len(failures) == asked:
        return Fetched(error="; ".join(failures))
    return Fetched(items=items, note="; ".join(failures) or None)


def yahoo_news(ticker: str) -> Fetched:
    """Yahoo 검색 뉴스(yfinance ``Search``) — 그 티커가 ``relatedTickers``에 있는 줄만. 상세 화면과 같은 래치를 봅니다."""
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return Fetched(error=str(latched))
    closed = yahoo.unavailable_reason()
    if closed:
        return Fetched(error=closed)
    symbol = ticker.upper().replace(".", "-")
    try:
        news = yf.Search(symbol, news_count=YAHOO_NEWS_COUNT, max_results=1, timeout=YAHOO_TIMEOUT).news
    except YFRateLimitError:
        return Fetched(error=str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")))
    except Exception as exc:  # noqa: BLE001
        return Fetched(error=safe_reason(exc, http.YAHOO_HOST))
    items, other = yahoo_items(news, symbol)
    return Fetched(items=items, note=f"관련 종목이 다른 {other}건은 뺌" if other else None)


def naver(code: str) -> Fetched:
    """네이버 종목 뉴스 — 상세 화면이 쓰는 모바일 API 응답 그대로(``detail._naver_json``·``news_from_naver``)."""
    payload, error = detail._naver_json(f"/news/stock/{code}?pageSize={NAVER_PAGE_SIZE}&page=1")
    if error:
        # 상세 화면의 함수가 준 사유에는 요청 주소가 섞일 수 있어 상태 코드만 옮깁니다.
        return Fetched(error=f"m.stock.naver.com {error}" if re.fullmatch(r"HTTP \d{3}", error) else
                       error if error.startswith(http.REJECTED_MARK) else "m.stock.naver.com 연결·응답 실패")
    items = [feed_item(title=row["title"], url=row["url"], publisher=row.get("publisher"), domain=rules.domain_of(row["url"]),
                       published=row.get("publishedAt"), source="naver", lang="ko")
             for row in detail.news_from_naver(payload) if row.get("title")]
    return Fetched(items=items)
