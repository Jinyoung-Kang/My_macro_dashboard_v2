"""
app/services/info_blogs.py
정보 수집(ADR 0035) — 해외 투자·경제 블로그 14곳의 RSS·Atom.

[받는 순서]
  1. 피드 하나(조건부 요청 — 지난번 ETag·Last-Modified를 보내 304면 '새 글 없음'으로 끝)
  2. 새 글(정규화한 주소의 id로 이미 받은 글은 건너뜀, 30일보다 오래된 글은 넣지 않음)마다
     - 피드에 본문이 있으면(글자 400자 이상) 그 본문을 씁니다 — 같은 글을 다시 열지 않는 것이 출처 부하가 가장 적습니다.
     - 피드에 본문이 없거나 짧으면, 최근 7일 글만 글 페이지를 열어 본문을 고릅니다(실행 한 번에 최대 PAGE_FETCHES_PER_RUN건, 한 글에 두 번까지).
  3. info_items에 넣거나 채웁니다(본문은 더 나은 판정일 때만 덮음 — store.upsert_info_items).

[실패 규칙]
  - 피드에서 글을 하나도 읽지 못하면 '형식 바뀜'(:class:`info_text.ShapeError` — 태스크가 polite.ShapeChanged로 바꿈). 피드 주소가 HTML을 주게
    바뀐 경우 등. 저장된 글은 그대로입니다.
  - 글 페이지가 거부되면 그때까지 받은 것은 넣고 거부를 그대로 올립니다(그 호스트가 닫힘 — 출처 상태 '차단').
  - 글 페이지가 404·5xx면 그 글만 피드 요약('partial')으로 둡니다.
"""
from __future__ import annotations

import io
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

import feedparser

from .. import http, store
from ..fetch import ladder, policy
from . import info_text
from .info_text import ShapeError

logger = logging.getLogger(__name__)

# 넣는 글의 나이 상한(일). 첫 실행에 Liberty Street처럼 100건짜리 피드를 통째로 넣지 않게.
MAX_AGE_DAYS = 30
# 글 페이지를 열어 볼 만큼 새로운 글(일).
PAGE_MAX_AGE_DAYS = 7
# 한 번 실행에서 여는 글 페이지 수의 상한과, 한 글에 페이지를 여는 횟수의 상한(404 등으로 계속 실패하는 글을 매번 다시 열지 않게).
PAGE_FETCHES_PER_RUN = 6
PAGE_TRIES_PER_ITEM = 2
# 피드의 글이 이만큼은 돼야 본문으로 봅니다(Blogger처럼 요약 칸에 본문 전체를 싣는 피드도 같은 기준).
FEED_BODY_MIN_CHARS = info_text.MIN_BODY_CHARS


@dataclass(frozen=True)
class Blog:
    """블로그 하나 — 출처 키(info_items.source), 태스크 이름, 화면 이름, 사이트 주소(출처 링크), 피드 주소, 다음 실행까지의 간격(분, 하한·상한)."""

    key: str
    task: str
    label: str
    site: str
    feed: str
    minutes: tuple[int, int] = (180, 480)


BLOGS: tuple[Blog, ...] = (
    Blog("blog.wolfstreet", "info_blog_wolfstreet", "Wolf Street", "https://wolfstreet.com/", "https://wolfstreet.com/feed/"),
    Blog("blog.abnormalreturns", "info_blog_abnormalreturns", "Abnormal Returns", "https://abnormalreturns.com/",
         "https://abnormalreturns.com/feed/"),
    Blog("blog.awealthofcommonsense", "info_blog_awealthofcommonsense", "A Wealth of Common Sense",
         "https://awealthofcommonsense.com/", "https://awealthofcommonsense.com/feed/"),
    Blog("blog.marginalrevolution", "info_blog_marginalrevolution", "Marginal Revolution", "https://marginalrevolution.com/",
         "https://marginalrevolution.com/feed"),
    Blog("blog.ritholtz", "info_blog_ritholtz", "The Big Picture (Ritholtz)", "https://ritholtz.com/", "https://ritholtz.com/feed/"),
    Blog("blog.calculatedrisk", "info_blog_calculatedrisk", "Calculated Risk", "https://calculatedrisk.substack.com/",
         "https://calculatedrisk.substack.com/feed"),
    # 피드가 100건·약 3 MB라 간격을 길게 둡니다(글은 한 주에 몇 편).
    Blog("blog.libertystreet", "info_blog_libertystreet", "Liberty Street Economics (NY Fed)",
         "https://libertystreeteconomics.newyorkfed.org/", "https://libertystreeteconomics.newyorkfed.org/feed/",
         (360, 900)),
    Blog("blog.klement", "info_blog_klement", "Klement on Investing", "https://klementoninvesting.substack.com/",
         "https://klementoninvesting.substack.com/feed"),
    Blog("blog.econbrowser", "info_blog_econbrowser", "Econbrowser", "https://econbrowser.com/", "https://econbrowser.com/feed"),
    Blog("blog.conversableeconomist", "info_blog_conversableeconomist", "Conversable Economist",
         "https://conversableeconomist.com/", "https://conversableeconomist.com/feed/"),
    Blog("blog.alphaarchitect", "info_blog_alphaarchitect", "Alpha Architect", "https://alphaarchitect.com/",
         "https://alphaarchitect.com/feed/"),
    Blog("blog.humbledollar", "info_blog_humbledollar", "HumbleDollar", "https://humbledollar.com/", "https://humbledollar.com/feed/"),
    # Blogger 피드(약 1.3 MB) — 요약 칸에 본문 전체가 옵니다. 글이 드물어 간격을 길게 둡니다.
    Blog("blog.damodaran", "info_blog_damodaran", "Musings on Markets (Damodaran)", "https://aswathdamodaran.blogspot.com/",
         "https://aswathdamodaran.blogspot.com/feeds/posts/default?alt=rss", (360, 900)),
    # 사이트의 /feed/는 HTML이고 실제 피드는 Beehiiv에 있습니다(사이트 머리의 rel=alternate가 가리키는 곳).
    Blog("blog.irrelevantinvestor", "info_blog_irrelevantinvestor", "The Irrelevant Investor",
         "https://www.theirrelevantinvestor.com/", "https://rss.beehiiv.com/feeds/BJES4OT2HF.xml"),
)
BLOG_BY_TASK = {blog.task: blog for blog in BLOGS}


def _bare_host(url: str) -> str:
    host = http.host_of(url)
    return host[4:] if host.startswith("www.") else host


# 원문 주소의 호스트 → 블로그(waedge 해외 블로그 목록의 원문 주소를 출처에 묶을 때).
BLOG_BY_HOST = {_bare_host(blog.site): blog for blog in BLOGS}

_validators_lock = threading.Lock()
_validators: dict[str, dict[str, str]] = {}      # 피드 주소 → 조건부 요청 머리글(이 프로세스 안 — 재기동하면 한 번 통째로 받음)

Fetch = Callable[..., ladder.Fetched]


def blog_for_url(url: str) -> Blog | None:
    return BLOG_BY_HOST.get(_bare_host(url))


def _conditional(feed: str) -> dict[str, str]:
    with _validators_lock:
        return dict(_validators.get(feed, {}))


def _remember(feed: str, fetched: ladder.Fetched) -> None:
    headers = {}
    if fetched.headers.get("etag"):
        headers["If-None-Match"] = fetched.headers["etag"]
    if fetched.headers.get("last-modified"):
        headers["If-Modified-Since"] = fetched.headers["last-modified"]
    with _validators_lock:
        if headers:
            _validators[feed] = headers
        else:
            _validators.pop(feed, None)


def reset() -> None:
    """조건부 요청 기록을 비웁니다(시험 사이의 격리용)."""
    with _validators_lock:
        _validators.clear()


def _when(entry) -> datetime | None:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    try:
        return datetime(*parsed[:6], tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _feed_text(entry) -> str:
    """피드가 실은 본문 — content(본문 칸)가 있으면 그것, 없으면 요약 칸(Blogger는 여기에 본문 전체)."""
    contents = entry.get("content") or []
    best = ""
    for content in contents:
        text = info_text.html_to_text(content.get("value") if isinstance(content, dict) else None)
        if len(text) > len(best):
            best = text
    summary = info_text.html_to_text(entry.get("summary"))
    return best if len(best) >= len(summary) else summary


def parse_feed(body: bytes) -> list[dict]:
    """
    피드 본문 → 글 [{url, title, author, published_at, text}]. 주소나 제목이 없는 항목은 뺍니다.

    :raises ShapeError: 글을 하나도 읽지 못함(피드가 아니거나 형식이 바뀜)
    """
    # BytesIO — bytes를 그대로 넘기면 feedparser가 먼저 파일 이름으로 열어 봅니다(본문이 경로 모양이면 그 파일을 읽음 — QA-387).
    # news.parse_feed·detail.news_from_google과 같은 가드입니다. 받은 바이트는 데이터로만 읽습니다.
    parsed = feedparser.parse(io.BytesIO(body))
    entries = []
    for entry in parsed.entries or []:
        link = (entry.get("link") or "").strip()
        title = info_text.html_to_text(entry.get("title")).strip()
        if not link.startswith(("http://", "https://")) or not title:
            continue
        entries.append({
            "url": link,
            "title": title[:500],
            "author": (entry.get("author") or "").strip()[:200] or None,
            "published_at": _when(entry),
            "text": _feed_text(entry),
        })
    if not entries:
        why = f"{type(parsed.bozo_exception).__name__}" if parsed.get("bozo") and parsed.get("bozo_exception") else "항목 0개"
        raise ShapeError(f"피드에서 글을 읽지 못함({why} — 피드 주소가 바뀌었거나 형식이 다름)")
    return entries


def collect(blog: Blog, *, fetch: Fetch = ladder.fetch, now: datetime | None = None) -> str:
    """
    블로그 하나를 받습니다 → 실행 기록 한 줄.

    :raises ShapeError: 피드에서 글을 읽지 못함
    :raises ladder.FetchRejected: 피드나 글 페이지가 거부됨(받은 글은 넣은 뒤)
    :raises ladder.FetchSkipped: 피드를 보내지 못함(예산·시간)
    :raises ladder.FetchFailed: 피드를 받지 못함(404·5xx)
    """
    now = now or datetime.now(timezone.utc)
    fetched = fetch(blog.feed, headers=_conditional(blog.feed) or None)
    if fetched.not_modified:
        return f"{blog.label} 피드 바뀐 것 없음(304) · 계층 {fetched.tier}"
    entries = parse_feed(fetched.body)
    _remember(blog.feed, fetched)

    oldest = now - timedelta(days=MAX_AGE_DAYS)
    fresh = [e for e in entries if e["published_at"] is None or e["published_at"] >= oldest]
    ids = {info_text.item_id(e["url"]): e for e in fresh}
    known = store.info_known(list(ids))

    items: list[dict] = []
    opened = from_feed = partial = 0
    blocked: ladder.FetchRejected | None = None
    page_room = PAGE_FETCHES_PER_RUN
    for item_id, entry in sorted(ids.items(), key=lambda pair: pair[1]["published_at"] or now, reverse=True):
        seen = known.get(item_id)
        if seen and seen["body_status"] == "full":
            continue
        text = entry["text"]
        body, status, tier, meta = (text, "full", fetched.tier, {}) if len(text) >= FEED_BODY_MIN_CHARS else (None, None, None, {})
        if status == "full":
            from_feed += 1
        elif blocked is None and page_room > 0 and _page_worthy(entry, seen, now):
            tries = int((seen or {}).get("page_tries") or 0) + 1
            meta = {"pageTries": tries}
            page_room -= 1
            try:
                page = fetch(entry["url"])
                extracted = info_text.extract_article(page.text())
                if len(extracted) >= info_text.MIN_BODY_CHARS:
                    body, status, tier = extracted, "full", page.tier
                    opened += 1
            except ladder.FetchRejected as exc:
                blocked = exc
            except ladder.FetchSkipped:
                page_room = 0
            except (ladder.FetchFailed, policy.UnknownHost) as exc:
                logger.info("%s 글 페이지를 받지 못함: %s", blog.label, exc)
        if status is None:
            body, status = (text or None), ("partial" if text else "none")
            partial += 1
        items.append({
            "id": item_id, "source": blog.key, "kind": "article", "url": entry["url"], "title": entry["title"],
            "author": entry["author"], "published_at": entry["published_at"],
            "summary": info_text.summarize(body or text or ""), "body": body, "body_status": status,
            "fetch_tier": tier, "meta": meta,
        })
    store.upsert_info_items(items)
    if blocked is not None:
        raise blocked
    detail = (f"{blog.label} 피드 {len(entries)}건 · 새로 넣거나 채운 글 {len(items)}(피드 본문 {from_feed}·글 페이지 {opened}·"
              f"요약만 {partial}) · 계층 {fetched.tier}")
    return detail


def _page_worthy(entry: dict, seen: dict | None, now: datetime) -> bool:
    """글 페이지를 열 만한가 — 최근 7일 글이고, 그 글의 페이지를 아직 두 번 열지 않았음. 피드 호스트가 정책 표에 있어야 합니다."""
    published = entry["published_at"]
    if published is not None and published < now - timedelta(days=PAGE_MAX_AGE_DAYS):
        return False
    if int((seen or {}).get("page_tries") or 0) >= PAGE_TRIES_PER_ITEM:
        return False
    return http.host_of(entry["url"]) in policy.POLICIES
