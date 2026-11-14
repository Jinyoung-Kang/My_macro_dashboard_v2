"""
app/services/search_store.py
정보 검색(ADR 0041)이 읽는 수집기 자기 저장본 — 읽기만 합니다(단계 2는 DB에 쓰지 않음). 외부 호출이 없어 ``external=false``에서도 씁니다.

- 사건 뉴스 관측치 ``news_headline``·``kr_news_headline``(보관 7일): 제목·요약에서 별칭. 작성 시각이 없는 줄(날짜만 주는 한국 피드)은 처음 받은
  시각(``fetchedAt``)으로 넣고 '받은 시각'으로 표시합니다.
- 수집 글 ``info_items``(운영자 — 블로그·waedge): 제목·한국어 제목·요약·본문에서 별칭. 본문 색인이 없어 건수 상한(INFO_ROW_LIMIT)과 문 시간 상한
  (STATEMENT_TIMEOUT_MS)을 둔 단순 검색입니다. 속보(``kind = 'headline'`` — Financial Juice)는 따로 읽습니다.
- 거장 견해 스냅샷 ``info.waedge.gurus``(운영자): 이름·요약에서 별칭.
- DART 고유번호 저장본 ``kr.dart_corp_codes``(상장사만)와 거장 이름 목록 — 후보 찾기·대상 풀기의 로컬 색인.

수집기의 다른 모듈은 SQL을 ``store``에 두지만, 이 단계는 그 파일을 고치지 않고 ``store.connection()``으로 SELECT만 합니다(쓰기 문장 없음 —
tests/test_table_ownership.py가 봄). 검색어는 로그에 남기지 않습니다.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import date
from typing import Any

from .. import catalog, store
from . import info_blogs, info_waedge, info_wire
from . import search_rules as rules
from .search_sources import Fetched, feed_item

logger = logging.getLogger(__name__)

INFO_ROW_LIMIT = 200
STATEMENT_TIMEOUT_MS = 3000
EVENT_DATASETS = (catalog.OBS_NEWS_HEADLINE, catalog.OBS_KR_NEWS_HEADLINE)
POST_KINDS = ("article", "brief", "guru")
WIRE_KINDS = ("headline",)
_BLOG_LABELS = {blog.key: blog.label for blog in info_blogs.BLOGS}
_STOCK_CODE = re.compile(r"^\d{6}$")
_CORP_CODE = re.compile(r"^\d{8}$")


def _store_error(exc: BaseException) -> str:
    return f"저장소를 읽지 못함({type(exc).__name__})"


def _set_timeout(conn) -> None:
    conn.execute("SELECT set_config('statement_timeout', %s, true)", (str(STATEMENT_TIMEOUT_MS),))


def _lang(text: str | None) -> str:
    return "ko" if rules.has_hangul(text) else "en"


# ------------------------------------------------------------------ 사건 뉴스

def _event_rows() -> list[dict]:
    with store.connection() as conn:
        _set_timeout(conn)
        return conn.execute("SELECT dataset, payload FROM observations WHERE dataset = ANY(%s::text[])",
                            (list(EVENT_DATASETS),)).fetchall()


def event_news(terms: list[str]) -> Fetched:
    """사건 뉴스 관측치에서 별칭이 제목·요약에 든 줄."""
    if not terms:
        return Fetched()
    try:
        rows = _event_rows()
    except Exception as exc:  # noqa: BLE001 — 저장소 장애는 이 출처의 실패
        return Fetched(error=_store_error(exc))
    items = []
    for row in rows:
        payload = row["payload"] if isinstance(row.get("payload"), dict) else {}
        title = payload.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        summary = payload.get("summary") if isinstance(payload.get("summary"), str) else None
        if not (rules.text_matches(title, terms) or rules.text_matches(summary, terms)):
            continue
        published = rules.parse_time(payload.get("publishedAt"))
        basis = "published"
        if published is None:
            published, basis = rules.parse_time(payload.get("fetchedAt")), "fetched"
        link = payload.get("link") if isinstance(payload.get("link"), str) else None
        items.append(feed_item(title=title.strip(), url=link, publisher=payload.get("source"), domain=rules.domain_of(link),
                               published=published, basis=basis, source="event_news", kind="headline",
                               lang="ko" if row["dataset"] == catalog.OBS_KR_NEWS_HEADLINE else "en", summary=summary))
    return Fetched(items=items)


# ------------------------------------------------------------------ 수집 글·속보

def _publisher(source: str) -> str | None:
    if source in _BLOG_LABELS:
        return _BLOG_LABELS[source]
    if source.startswith("waedge."):
        return info_waedge.SOURCE_LABEL
    if source == info_wire.SOURCE_KEY:
        return info_wire.LABEL
    return None


def _info_rows(kinds: tuple[str, ...], terms: list[str]) -> list[dict]:
    ilike, regex = rules.sql_patterns(terms)
    columns = ("title", "title_ko", "summary", "body")
    clauses = [f"{column} ILIKE ANY(%(ilike)s::text[])" for column in columns]
    clauses += [f"{column} ~* ANY(%(regex)s::text[])" for column in columns]
    sql = ("SELECT id, source, kind, url, title, title_ko, published_at, first_seen_at, summary FROM info_items "
           "WHERE kind = ANY(%(kinds)s::text[]) AND (" + " OR ".join(clauses) + ") "
           "ORDER BY COALESCE(published_at, first_seen_at) DESC, id LIMIT %(limit)s")
    with store.connection() as conn:
        _set_timeout(conn)
        return conn.execute(sql, {"kinds": list(kinds), "ilike": ilike, "regex": regex, "limit": INFO_ROW_LIMIT}).fetchall()


def _info_items(kinds: tuple[str, ...], terms: list[str], *, source: str) -> Fetched:
    if not terms:
        return Fetched()
    try:
        rows = _info_rows(kinds, terms)
    except Exception as exc:  # noqa: BLE001
        return Fetched(error=_store_error(exc))
    items = []
    for row in rows:
        published, basis = row["published_at"], "published"
        if published is None:
            published, basis = row["first_seen_at"], "fetched"
        kind = {"guru": "opinion", "headline": "wire"}.get(row["kind"], "post")
        items.append(feed_item(title=row["title"], url=row["url"], publisher=_publisher(row["source"]),
                               domain=rules.domain_of(row["url"]), published=published, basis=basis, source=source, kind=kind,
                               lang=_lang(row["title_ko"] or row["title"]), summary=row["summary"], reader_id=row["id"]))
    note = f"최근 {INFO_ROW_LIMIT}건까지만 찾음" if len(rows) >= INFO_ROW_LIMIT else None
    return Fetched(items=items, note=note)


def info_posts(terms: list[str]) -> Fetched:
    """수집 글(블로그·waedge — 운영자)에서 별칭이 제목·한국어 제목·요약·본문에 든 글."""
    return _info_items(POST_KINDS, terms, source="info")


def wire(terms: list[str]) -> Fetched:
    """속보(Financial Juice — 운영자)에서 별칭이 든 줄."""
    return _info_items(WIRE_KINDS, terms, source="wire")


# ------------------------------------------------------------------ 거장 견해

def _guru_snapshot() -> tuple[dict, Any]:
    snap = store.read_snapshot(catalog.SNAP_INFO_WAEDGE_GURUS)
    if snap is None or not isinstance(snap.payload, dict):
        return {}, None
    return snap.payload, snap.collected_at


def _guru_title(guru: dict) -> str:
    stance, score = guru.get("stance"), guru.get("score")
    head = f"{guru['name']} 시장 견해"
    if isinstance(stance, str) and isinstance(score, int) and not isinstance(score, bool):
        return f"{head} — {stance} {score:+d}"
    return f"{head} — {stance}" if isinstance(stance, str) else head


def guru_views(terms: list[str]) -> Fetched:
    """거장 견해(운영자) — 이름이나 요약에 별칭이 든 거장마다 한 줄. 시각은 화면이 밝힌 기준일(00:00 KST), 없으면 저장 시각('fetched')."""
    if not terms:
        return Fetched()
    try:
        payload, collected_at = _guru_snapshot()
    except Exception as exc:  # noqa: BLE001
        return Fetched(error=_store_error(exc))
    source_url = payload.get("sourceUrl") if isinstance(payload.get("sourceUrl"), str) else None
    items = []
    for guru in payload.get("gurus") or []:
        if not isinstance(guru, dict) or not isinstance(guru.get("name"), str) or not guru["name"].strip():
            continue
        summary = guru.get("summary") if isinstance(guru.get("summary"), str) else None
        if not (rules.text_matches(guru["name"], terms) or rules.text_matches(summary, terms)):
            continue
        published, basis = None, "published"
        as_of = guru.get("asOf")
        if isinstance(as_of, str):
            try:
                day = date.fromisoformat(as_of)
                published = rules.utc_iso(rules.kst_midnight(day))
            except ValueError:
                published = None
        if published is None and collected_at is not None:
            published, basis = collected_at, "fetched"
        key = "guru-" + hashlib.sha1(guru["name"].encode("utf-8")).hexdigest()[:20]
        items.append(feed_item(title=_guru_title(guru), url=source_url, publisher=info_waedge.SOURCE_LABEL,
                               domain=rules.domain_of(source_url), published=published, basis=basis, source="guru",
                               kind="opinion", lang="ko", summary=summary, item_id=key))
    return Fetched(items=items)


def guru_names() -> list[str]:
    """거장 이름 목록(스냅샷 순서) — 후보 찾기용. 없거나 읽지 못하면 빈 목록."""
    try:
        payload, _ = _guru_snapshot()
    except Exception as exc:  # noqa: BLE001
        logger.info("정보 검색: 거장 목록을 읽지 못함(%s)", type(exc).__name__)
        return []
    return [guru["name"].strip() for guru in payload.get("gurus") or []
            if isinstance(guru, dict) and isinstance(guru.get("name"), str) and guru["name"].strip()]


# ------------------------------------------------------------------ DART 고유번호

def dart_codes() -> dict[str, dict]:
    """DART 고유번호 저장본 → {종목코드 6자리: {corpCode, name}}(상장사만). 없거나 읽지 못하면 빈 표."""
    try:
        snap = store.read_snapshot(catalog.SNAP_DART_CORP_CODES)
    except Exception as exc:  # noqa: BLE001
        logger.info("정보 검색: DART 고유번호 저장본을 읽지 못함(%s)", type(exc).__name__)
        return {}
    codes = (snap.payload or {}).get("codes") if snap is not None and isinstance(snap.payload, dict) else None
    out: dict[str, dict] = {}
    for code, row in (codes or {}).items():
        if not isinstance(row, dict) or not _STOCK_CODE.match(str(code)):
            continue
        corp, name = row.get("corpCode"), row.get("name")
        if isinstance(corp, str) and _CORP_CODE.match(corp) and isinstance(name, str) and name.strip():
            out[str(code)] = {"corpCode": corp, "name": name.strip()}
    return out
