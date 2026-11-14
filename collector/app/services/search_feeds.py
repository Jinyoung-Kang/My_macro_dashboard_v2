"""
app/services/search_feeds.py
정보 검색의 새 피드 묶음(ADR 0041 결정 8, 계약 docs/specs/2026-11-14-info-search-contract.md §6-1) — 보도자료·경제지 RSS 12개의 표와 읽기.

[사건 뉴스와 따로]
  사건 뉴스 두 묶음(services.news의 ``FEEDS``·``KR_FEEDS`` → 관측치 ``news_headline``·``kr_news_headline``)은 모의 매매 결정 패킷의 입력(실험 조건)
  이라 피드를 더하지 않습니다. 이 묶음은 다른 모듈·다른 이름(``SEARCH_FEEDS``)·다른 데이터셋(``search_feed_headline``)이고, 피드 키·주소도
  사건 뉴스와 겹치지 않습니다(시험). 쓰는 곳은 정보 검색의 뉴스·타임라인(저장본 출처 ``feeds``)·첫 화면 최근 글·관심 대상 대조뿐이고 **모의
  매매 패킷은 읽지 않습니다.**

[피드 — 2026-11-14 서버(Vultr) 실측, 진행 기록 '단계 0']
  후보 13개 가운데 12개. FXStreet는 서버 IP에서 403이라 뺐습니다(우회하지 않음 — D-11). 매체 소유는 모두 중국 자본을 찾지 못함(ADR 0041 배경).
  Nikkei Asia(RDF)는 글마다 작성 시각 칸이 없어 처음 받은 시각을 '받은 시각'(timeBasis ``fetched``)으로 씁니다. 간격(분)은 실측한 글 수와 기간에서
  정한 ADR 0041 결정 8의 표 그대로이고, 받는 규칙(무작위 간격·조건부 요청·거부 뒤 물러남·같은 호스트 차례)은 tasks/search_feeds.

[받기와 읽기]
  받기는 사건 뉴스와 같은 공용 세션의 조건부 요청(services.news.fetch_feed_conditional — Feed.session "default", 크기 상한·거부 래치 그대로)입니다.
  읽기는 services.news.parse_feed를 쓰지 않고 여기서 따로 합니다 — parse_feed는 시각이 없는 글을 버리고(Nikkei Asia가 통째로 실패) 요약으로
  description과 본문 칸(content:encoded) 가운데 긴 것을 2,000자까지 고릅니다(Benzinga는 본문이 실려 옴). 이 묶음의 요약은 **description·summary만**
  300자까지이고 본문 칸은 쓰지 않습니다 — feedparser가 본문 칸을 summary로 옮겨 적은 경우(description이 없는 글)도 본문으로 보고 비웁니다.
  feedparser에는 바이트를 BytesIO로 넘깁니다(services.news 모듈 설명 '받기와 읽기를 나눕니다').
"""
from __future__ import annotations

import calendar
import io
from dataclasses import dataclass, field
from datetime import datetime, timezone

import feedparser

from . import info_text
from . import news
from . import search_rules as rules

# 요약 상한(글자) — 계약 §6-1(피드의 description·summary만, 본문 칸 안 씀).
SUMMARY_MAX_CHARS = 300


@dataclass(frozen=True)
class SearchFeed(news.Feed):
    """
    새 묶음의 피드 하나 — services.news.Feed(키·매체 이름·주소·세션)에 간격 구간을 더한 것. 조건부 요청 함수에 그대로 넘깁니다.

    :param minutes: 다음 요청까지의 간격 구간(분, 무작위) — 시장 시간과 상관없이 늘 같음
    :param lang: 글의 언어(지금은 모두 영어)
    """

    minutes: tuple[float, float] = (60.0, 120.0)
    lang: str = "en"


_CNBC = "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id="

# 피드 표(ADR 0041 결정 8). 같은 호스트의 두 CNBC 피드는 한 실행에서 차례로 나가도록 붙여 둡니다(tasks/search_feeds — 사이 2~5초).
SEARCH_FEEDS: tuple[SearchFeed, ...] = (
    SearchFeed("fed_press_all", "Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", "default",
               minutes=(120.0, 240.0)),
    SearchFeed("ecb_press", "European Central Bank", "https://www.ecb.europa.eu/rss/press.html", "default", minutes=(120.0, 240.0)),
    SearchFeed("boe_news", "Bank of England", "https://www.bankofengland.co.uk/rss/news", "default", minutes=(120.0, 240.0)),
    SearchFeed("bloomberg_markets", "Bloomberg", "https://feeds.bloomberg.com/markets/news.rss", "default", minutes=(60.0, 120.0)),
    SearchFeed("marketwatch_top", "MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories/", "default",
               minutes=(45.0, 90.0)),
    SearchFeed("cnbc_finance", "CNBC", _CNBC + "100003114", "default", minutes=(60.0, 120.0)),
    SearchFeed("cnbc_world", "CNBC", _CNBC + "100727362", "default", minutes=(90.0, 180.0)),
    SearchFeed("benzinga", "Benzinga", "https://www.benzinga.com/feed", "default", minutes=(45.0, 90.0)),
    SearchFeed("seekingalpha_currents", "Seeking Alpha", "https://seekingalpha.com/market_currents.xml", "default",
               minutes=(30.0, 60.0)),
    SearchFeed("bbc_business", "BBC", "https://feeds.bbci.co.uk/news/business/rss.xml", "default", minutes=(90.0, 180.0)),
    SearchFeed("economist_finance", "The Economist", "https://www.economist.com/finance-and-economics/rss.xml", "default",
               minutes=(180.0, 360.0)),
    SearchFeed("nikkei_asia", "Nikkei Asia", "https://asia.nikkei.com/rss/feed/nar", "default", minutes=(60.0, 120.0)),
)

SEARCH_FEED_KEYS: tuple[str, ...] = tuple(feed.key for feed in SEARCH_FEEDS)
FEEDS_BY_KEY: dict[str, SearchFeed] = {feed.key: feed for feed in SEARCH_FEEDS}

SOURCE_NOTE = ("RSS 제목·링크·매체·시각과 피드의 description·summary(300자) — 연준 전체 보도자료·ECB 보도자료·영란은행 소식·Bloomberg 시장·"
               "MarketWatch 주요 기사·CNBC 금융·세계·Benzinga·Seeking Alpha 시장 속보·BBC 비즈니스·Economist 금융·경제·Nikkei Asia. "
               "FXStreet는 서버 IP에서 403이라 제외. 모의 매매 패킷은 읽지 않음")


@dataclass
class ParsedBundle:
    items: list[dict] = field(default_factory=list)   # {title, url, summary, publishedAt(datetime UTC | None)} — 피드 순서
    entries: int = 0          # 피드가 준 항목 수
    no_title: int = 0         # 제목이 비어 건너뜀
    no_time: int = 0          # 작성 시각이 없음(처음 받은 시각으로 넣음 — 건너뛰지 않음)
    version: str = ""


def _entry_time(entry) -> datetime | None:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    try:
        return datetime.fromtimestamp(calendar.timegm(parsed), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _link(value) -> str | None:
    """http(s) 링크만(javascript: 등은 버림). 없으면 None."""
    if not isinstance(value, str):
        return None
    link = value.strip()
    return link if link.lower().startswith(("https://", "http://")) else None


def _flat(text: str | None) -> str:
    return " ".join((text or "").split())


def entry_summary(entry, title: str) -> str | None:
    """
    피드의 description·summary만(HTML은 글자만) 300자까지. 본문 칸(content:encoded 등)은 쓰지 않습니다 — feedparser가 본문 칸을 summary로
    옮겨 적은 경우(description이 없는 글)는 그 글자가 본문 칸과 같아 비웁니다. 없거나 제목과 같으면 None(지어내지 않음).
    """
    raw = entry.get("summary") if isinstance(entry.get("summary"), str) else None
    if not raw or not raw.strip():
        return None
    bodies = {_flat(content.get("value")) for content in entry.get("content") or [] if isinstance(content, dict)}
    if _flat(raw) in bodies:
        return None
    text = _flat(info_text.html_to_text(raw))
    if not text or text.casefold() == _flat(title).casefold():
        return None
    return rules.clip(text, SUMMARY_MAX_CHARS)


def parse(content: bytes, content_type: str | None = None, feed=None) -> ParsedBundle:   # noqa: ARG001 — 조건부 요청 틀의 자리
    """
    받은 바이트 → 항목(제목·원문 링크·요약·작성 시각). 시각이 없는 항목도 남깁니다(``publishedAt`` None — 태스크가 처음 받은 시각으로 넣음).

    :raises news.FeedShapeError: RSS·Atom이 아님(HTML 오류 페이지 등), 항목 없음, 제목 있는 항목 없음
    """
    headers = {"content-type": content_type} if content_type else None
    parsed = feedparser.parse(io.BytesIO(content or b""), response_headers=headers)
    version = parsed.get("version") or ""
    entries = list(parsed.get("entries") or [])
    if not version:
        raise news.FeedShapeError("RSS·Atom 피드가 아님(HTML 등)")
    if not entries:
        raise news.FeedShapeError("항목 0개")
    out = ParsedBundle(entries=len(entries), version=version)
    for entry in entries:
        title = news.normalise_title(entry.get("title"))
        if not title:
            out.no_title += 1
            continue
        published = _entry_time(entry)
        if published is None:
            out.no_time += 1
        out.items.append({"title": title, "url": _link(entry.get("link")), "summary": entry_summary(entry, title),
                          "publishedAt": published})
    if not out.items:
        raise news.FeedShapeError(f"쓸 항목 없음(항목 {out.entries}개 — 제목 없음 {out.no_title})")
    return out
