"""
app/services/info_waedge.py
정보 수집(ADR 0035) — waedge 뉴스(news.waedge.ai)의 세 화면. 서버가 완성한 HTML이라 화면을 그대로 읽습니다.

[시장 /s/brief.html]  글 목록(``ul li a[href="a/<번호>.html"]`` — 제목·요약·분류·작성·시각) → 새 글은 상세 페이지 ``/a/<번호>.html``에서 본문
                      (실행당 최대 BRIEF_BODIES_PER_RUN건). info_items source ``waedge.brief``, kind ``brief``.
[거장 /s/people.html] 투자자별 시장 견해(강세·중립·약세 점수·요약) → 스냅샷 ``info.waedge.gurus``. 같은 화면의 글 목록은 시장과 같은 방식
                      (실행당 최대 PEOPLE_BODIES_PER_RUN건, source ``waedge.people``, kind ``guru``).
  스냅샷 모양(contract 1)
    generatedAt · collectedAt(KST) · source · sourceUrl · fetchTier · asOf(화면이 밝힌 기준일) · counts{total, bull, neutral, bear}
    gurus : [{name, stance('강세'·'중립'·'약세'), score(-100~+100), bull, neutral, bear, basisArticles, asOf, summary}] — 점수 내림차순.
            화면에 없는 값은 null입니다(0으로 채우지 않음).
[해외 블로그 /s/blogs.html] 원문 블로그 글의 한국어 제목 목록 → 원문 주소로 info_items의 그 글 행에 title_ko만 채웁니다(본문은 원문 피드가 채움).
                      원문 호스트가 info_blogs의 블로그면 그 출처 키, 아니면 ``waedge.blogs``.

화면은 밝은·어두운 판을 함께 그려 같은 항목이 두 번 이상 나옵니다 — 주소·이름으로 하나로 줄입니다.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .. import http, kst, store
from ..fetch import ladder
from . import info_blogs, info_text
from .info_text import ShapeError

logger = logging.getLogger(__name__)

BASE = "https://news.waedge.ai/"
BRIEF_URL = BASE + "s/brief.html"
PEOPLE_URL = BASE + "s/people.html"
BLOGS_URL = BASE + "s/blogs.html"
SOURCE_LABEL = "WAEDGE NEWS"

BRIEF_BODIES_PER_RUN = 8
PEOPLE_BODIES_PER_RUN = 5

_ARTICLE_HREF = re.compile(r"^(?:\.\./|/)?a/(\d+)\.html$")
_STANCE = re.compile(r"(강세|중립|약세)\s*([+-]?\d+)")
_BREAKDOWN = re.compile(r"강세\s*(\d+)\s*·\s*중립\s*(\d+)\s*·\s*약세\s*(\d+)")
_BASIS = re.compile(r"최근 기사\s*(\d+)\s*건")
_DAY = re.compile(r"(\d{4}-\d{2}-\d{2})")
_COUNT = re.compile(r"(강세|중립|약세)\s*(\d+)")
_TOTAL = re.compile(r"거장\s*(\d+)\s*명")

Fetch = Callable[..., ladder.Fetched]


def _soup(markup: str) -> BeautifulSoup:
    return BeautifulSoup(markup, "lxml")


def _iso_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _text(node) -> str:
    return " ".join(node.get_text(" ", strip=True).split()) if node is not None else ""


# ------------------------------------------------------------------ 글 목록(시장·거장 화면 공통)
def parse_list(markup: str) -> list[dict]:
    """
    글 목록 → [{url, title, summary, category, author, published_at}] (주소로 하나씩, 화면 순서).

    :raises ShapeError: 글을 하나도 읽지 못함
    """
    soup = _soup(markup)
    seen: dict[str, dict] = {}
    for anchor in soup.find_all("a", href=True):
        match = _ARTICLE_HREF.match(anchor["href"].strip())
        if not match:
            continue
        url = urljoin(BASE, f"a/{match.group(1)}.html")
        if url in seen:
            continue
        title_node = anchor.find(class_=re.compile(r"font-bold"))
        title = _text(title_node)
        if not title:
            continue
        # 요약 칸 — 제목 칸도 좁은 화면용 'sm:line-clamp-1'을 가져서 굵은 글(제목)이 아닌 line-clamp 칸을 고릅니다.
        summary_node = next((node for node in anchor.find_all(class_=re.compile(r"line-clamp"))
                             if "font-bold" not in (node.get("class") or [])), None)
        meta = anchor.find(class_=re.compile(r"whitespace-nowrap"))
        spans = meta.find_all("span", recursive=False) if meta is not None else []
        time_node = anchor.find("time")
        seen[url] = {
            "url": url,
            "title": title[:500],
            "summary": _text(summary_node) or None,
            "category": _text(spans[0]) if spans else None,
            "author": _text(spans[1]) if len(spans) > 1 else None,
            "published_at": _iso_time(time_node.get("datetime") or time_node.get("dateTime")) if time_node else None,
        }
    if not seen:
        raise ShapeError("waedge 글 목록에서 글을 읽지 못함(a/<번호>.html 링크·제목 없음 — 화면 형식이 바뀐 경우)")
    return list(seen.values())


def parse_article(markup: str) -> dict:
    """상세 페이지 → {title, lead, body, published_at}. 본문을 못 고르면 body는 빈 문자열입니다."""
    soup = _soup(markup)
    article = soup.find("article") or soup
    title = _text(article.find(attrs={"data-testid": "news-article-title"}) or article.find("h1"))
    lead_node = article.find(attrs={"data-testid": "news-article-lead"})
    lead = info_text.html_to_text(str(lead_node)) if lead_node is not None else ""
    time_node = article.find("time")
    published = _iso_time(time_node.get("datetime") or time_node.get("dateTime")) if time_node else None
    for header in article.find_all("header"):
        header.decompose()
    for node in article.find_all(["figure", "pre", "aside"]):
        node.decompose()
    for node in article.find_all(class_=re.compile(r"\bsticky\b")):
        node.decompose()
    paragraphs = [info_text.html_to_text(str(p)) for p in article.find_all(["p", "h2", "h3", "li", "blockquote"])]
    body = "\n\n".join(text for text in paragraphs if text)
    if lead and not body.startswith(lead[:40]):
        body = f"{lead}\n\n{body}".strip()
    if len(body) < 80:
        body = info_text.extract_article(markup)
    return {"title": title, "lead": lead, "body": body, "published_at": published}


def collect_list(page_url: str, *, source: str, kind: str, bodies_per_run: int, fetch: Fetch = ladder.fetch,
                 listed: ladder.Fetched | None = None) -> tuple[int, int, ladder.FetchRejected | None]:
    """
    글 목록 화면 하나를 받아 새 글을 넣고 본문을 채웁니다 → (목록 글 수, 본문을 받은 글 수, 도중의 거부).

    :param listed: 이미 받은 목록 화면(거장 화면처럼 같은 응답에서 다른 것도 읽을 때)
    :raises ShapeError: 목록에서 글을 읽지 못함
    """
    page = listed or fetch(page_url)
    entries = parse_list(page.text())
    ids = {info_text.item_id(e["url"]): e for e in entries}
    known = store.info_known(list(ids))
    items: list[dict] = []
    room = bodies_per_run
    bodies = 0
    blocked: ladder.FetchRejected | None = None
    for item_id, entry in ids.items():
        seen = known.get(item_id)
        if seen and seen["body_status"] == "full":
            continue
        body, status, tier = None, ("partial" if entry["summary"] else "none"), page.tier
        tries = int((seen or {}).get("page_tries") or 0)
        meta = {"category": entry["category"]} if entry["category"] else {}
        if blocked is None and room > 0 and tries < info_blogs.PAGE_TRIES_PER_ITEM:
            room -= 1
            detail, sent = None, True
            try:
                detail = fetch(entry["url"])
            except ladder.FetchRejected as exc:
                blocked = exc
            except ladder.FetchSkipped:
                room, sent = 0, False             # 보내지 않았음(예산·시간) — 그 글의 시도로 세지 않습니다(QA-393, 블로그 글 페이지와 같음)
            except ladder.FetchFailed:
                pass
            if sent:
                meta["pageTries"] = tries + 1
            if detail is not None:
                try:
                    parsed = parse_article(detail.text())
                    if len(parsed["body"]) >= 80:
                        body, status, tier = parsed["body"], "full", detail.tier
                        bodies += 1
                        entry["published_at"] = entry["published_at"] or parsed["published_at"]
                except Exception as exc:  # noqa: BLE001 — 글 하나의 본문 고르기가 실패해도 그 글만 요약으로 둡니다(다른 글은 저장)
                    logger.warning("waedge 상세 페이지에서 본문을 고르다 실패: %s", http.brief_error(exc))
        if body is None and entry["summary"]:
            body = entry["summary"]
        items.append({
            "id": item_id, "source": source, "kind": kind, "url": entry["url"], "title": entry["title"],
            "author": entry["author"], "published_at": entry["published_at"],
            "summary": info_text.summarize(entry["summary"] or body or ""), "body": body, "body_status": status,
            "fetch_tier": tier, "meta": meta,
        })
    store.upsert_info_items(items)
    return len(entries), bodies, blocked


# ------------------------------------------------------------------ 거장
def parse_gurus(markup: str) -> dict:
    """
    거장 화면 → {asOf, counts, gurus}. 이름으로 하나씩, 점수 내림차순.

    :raises ShapeError: 견해를 하나도 읽지 못함, 또는 견해·점수를 읽은 거장이 절반에 못 미침
    """
    soup = _soup(markup)
    gurus: dict[str, dict] = {}
    for detail in soup.find_all(class_="guru-spectrum-detail"):
        name_node = detail.find(class_=re.compile(r"font-semibold"))
        name = re.sub(r"^거장\s*", "", _text(name_node)).strip()
        if not name or name in gurus:
            continue
        line = _text(detail)
        breakdown = _BREAKDOWN.search(line)
        # 견해 칸은 분포('강세 N · 중립 N · 약세 N') 앞에 있습니다. 분포 글 안의 '강세 N'을 견해로 읽지 않게 그 앞에서만 찾습니다 —
        # 견해 표기가 바뀌면 모두 '강세'·점수는 강세 비중으로 읽혔습니다(QA-392).
        stance = _STANCE.search(line[:breakdown.start()] if breakdown else line)
        basis = _BASIS.search(line)
        day = _DAY.search(line)
        summary_node = detail.find("p")
        gurus[name] = {
            "name": name[:120],
            "stance": stance.group(1) if stance else None,
            "score": int(stance.group(2)) if stance else None,
            "bull": int(breakdown.group(1)) if breakdown else None,
            "neutral": int(breakdown.group(2)) if breakdown else None,
            "bear": int(breakdown.group(3)) if breakdown else None,
            "basisArticles": int(basis.group(1)) if basis else None,
            "asOf": day.group(1) if day else None,
            "summary": _text(summary_node) or None,
        }
    if not gurus:
        raise ShapeError("waedge 거장 화면에서 견해를 읽지 못함(guru-spectrum-detail 없음 — 화면 형식이 바뀐 경우)")
    # 필수 칸(견해·점수)을 읽은 거장이 절반에 못 미치면 형식이 바뀐 것입니다 — 이름만 읽힌 빈 견해로 직전 저장본을 덮지 않습니다(QA-392).
    read = sum(1 for guru in gurus.values() if guru["stance"] is not None and guru["score"] is not None)
    if read * 2 < len(gurus):
        raise ShapeError(f"waedge 거장 화면에서 견해·점수를 읽지 못함({len(gurus)}명 가운데 {read}명만 — 견해 표기가 바뀐 경우)")
    header = soup.find(attrs={"data-testid": "guru-sentiment-spectrum"})
    head_text = _text(header)[:400] if header is not None else ""
    counts = {"total": None, "bull": None, "neutral": None, "bear": None}
    total = _TOTAL.search(head_text)
    if total:
        counts["total"] = int(total.group(1))
    names = {"강세": "bull", "중립": "neutral", "약세": "bear"}
    for label, number in _COUNT.findall(head_text.split("얼굴을")[0]):
        counts.setdefault(names[label], None)
        if counts[names[label]] is None:
            counts[names[label]] = int(number)
    as_of = _DAY.search(head_text)
    ordered = sorted(gurus.values(), key=lambda g: (g["score"] is None, -(g["score"] or 0), g["name"]))
    return {"asOf": as_of.group(1) if as_of else None, "counts": counts, "gurus": ordered}


def guru_snapshot(parsed: dict, *, fetch_tier: str, now: datetime) -> dict:
    return {
        "contract": 1,
        "generatedAt": now.isoformat(timespec="seconds"),
        "collectedAt": kst.stamp(now),
        "source": f"{SOURCE_LABEL} 거장",
        "sourceUrl": PEOPLE_URL,
        "fetchTier": fetch_tier,
        **parsed,
    }


# ------------------------------------------------------------------ 해외 블로그(한국어 제목)
def parse_blog_rows(markup: str) -> list[dict]:
    """
    해외 블로그 화면 → [{url, titleKo, titleEn, blog, timeLabel}] (원문 주소로 하나씩).

    :raises ShapeError: 글을 하나도 읽지 못함
    """
    soup = _soup(markup)
    rows: dict[str, dict] = {}
    for row in soup.find_all(attrs={"data-testid": "waisod-news-blog-row"}):
        anchor = row.find("a", href=True)
        if anchor is None or not anchor["href"].startswith(("http://", "https://")):
            continue
        url = anchor["href"].strip()
        key = info_text.normalize_url(url)
        if key in rows:
            continue
        blog = row.find("b")
        english = row.find(attrs={"lang": "en"})
        stamp = row.find(class_=re.compile(r"tabular-nums"))
        title_ko = _text(anchor)
        if not title_ko:
            continue
        rows[key] = {
            "url": url,
            "titleKo": title_ko[:500],
            "titleEn": _text(english) or None,
            "blog": _text(blog) or None,
            "timeLabel": _text(stamp) or None,
        }
    if not rows:
        raise ShapeError("waedge 해외 블로그 화면에서 글을 읽지 못함(waisod-news-blog-row 없음 — 화면 형식이 바뀐 경우)")
    return list(rows.values())


def store_blog_titles(rows: list[dict], *, fetch_tier: str) -> int:
    """한국어 제목을 원문 글 행에 채웁니다(없으면 본문 없는 행으로 만들어 두고, 원문 피드가 본문을 채움) → 보낸 행 수."""
    items = []
    for row in rows:
        blog = info_blogs.blog_for_url(row["url"])
        items.append({
            "id": info_text.item_id(row["url"]),
            "source": blog.key if blog else "waedge.blogs",
            "kind": "article",
            "url": row["url"],
            "title": row["titleEn"] or row["titleKo"],
            "title_ko": row["titleKo"],
            "body": None,
            "body_status": "none",
            "fetch_tier": None,
            "meta": {"waedgeBlog": row["blog"], "waedgeTime": row["timeLabel"], "titleKoSource": SOURCE_LABEL,
                     "titleKoTier": fetch_tier},
        })
    return store.upsert_info_items(items)
