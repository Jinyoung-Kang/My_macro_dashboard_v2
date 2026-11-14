"""
app/services/search_store.py
정보 검색(ADR 0041)이 읽는 수집기 자기 저장본 — 읽기만 합니다(단계 2는 DB에 쓰지 않음). 외부 호출이 없어 ``external=false``에서도 씁니다.

- 사건 뉴스 관측치 ``news_headline``·``kr_news_headline``(보관 7일): 제목·요약에서 별칭. 작성 시각이 없는 줄(날짜만 주는 한국 피드)은 처음 받은
  시각(``fetchedAt``)으로 넣고 '받은 시각'으로 표시합니다.
- 수집 글 ``info_items``(운영자 — 블로그·waedge): 제목·한국어 제목·요약·본문에서 별칭. 본문 색인이 없어 건수 상한(INFO_ROW_LIMIT)과 문 시간 상한
  (STATEMENT_TIMEOUT_MS)을 둔 단순 검색입니다. 속보(``kind = 'headline'`` — Financial Juice)는 따로 읽습니다.
- 거장 견해 스냅샷 ``info.waedge.gurus``(운영자): 이름·요약에서 별칭.
- DART 고유번호 저장본 ``kr.dart_corp_codes``(상장사만)와 거장 이름 목록 — 후보 찾기·대상 풀기의 로컬 색인.
- (단계 3) 새 피드 묶음 관측치 ``search_feed_headline``(보관 90일 — 회원에게도): 제목·요약에서 별칭. 시각 칸이 없는 피드(Nikkei Asia)의 글은
  처음 받은 시각('fetched'). 첫 화면의 최근 글(묶음 최근 30건 + 운영자는 속보 최근 20건)도 여기서.
- (단계 3) 관심 대상이 모은 글 ``search_watch_items``(store.search_watch_items) — 운영자 전용 출처(속보·수집 글)에서 온 줄은 운영자에게만.
- (단계 3) 사용자가 더한 제외 매체 ``search_media_excludes``(백엔드 표 — 읽기만, 60초 캐시).

이 모듈의 SQL은 ``store.connection()``으로 SELECT만 합니다(쓰기 문장 없음 — tests/test_table_ownership.py가 봄). 새 표(V37)의 읽기는
``store``의 함수를 씁니다. 검색어는 로그에 남기지 않습니다.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from datetime import date
from typing import Any

from .. import catalog, store
from . import info_blogs, info_waedge, info_wire
from . import search_rules as rules
from .search_sources import Fetched, feed_item

logger = logging.getLogger(__name__)

INFO_ROW_LIMIT = 200
BUNDLE_ROW_LIMIT = 500          # 새 피드 묶음에서 별칭으로 찾는 건수 상한(최근부터)
WATCH_ROW_LIMIT = 1000          # 관심 대상 한 곳의 모은 글을 읽는 상한(최근부터)
STATEMENT_TIMEOUT_MS = 3000
EXCLUDES_TTL = 60.0             # 사용자가 더한 제외 매체 캐시(초)
EXCLUDES_FAILURE_TTL = 10.0     # 읽지 못했을 때 다시 읽기까지(초) — 그동안은 직전 값(없으면 빈 목록)
EVENT_DATASETS = (catalog.OBS_NEWS_HEADLINE, catalog.OBS_KR_NEWS_HEADLINE)
# 관심 대상이 모은 글 가운데 운영자 전용 출처에서 온 것(백엔드도 회원에게서 이 출처의 줄을 지움 — 계약 §3-4).
OWNER_ONLY_ORIGINS = ("wire", "info", "guru")
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


# ------------------------------------------------------------------ 새 피드 묶음(단계 3)

def bundle_item(payload: dict, *, source: str = "feeds") -> dict | None:
    """새 피드 묶음 관측치의 payload → FeedItem(시각이 없으면 처음 받은 시각 'fetched'). 제목이 없으면 None."""
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    url = payload.get("url") if isinstance(payload.get("url"), str) else None
    published = rules.parse_time(payload.get("publishedAt"))
    basis = "published"
    if published is None:
        published, basis = rules.parse_time(payload.get("fetchedAt")), "fetched"
    domain = payload.get("publisherDomain") if isinstance(payload.get("publisherDomain"), str) else rules.domain_of(url)
    summary = payload.get("summary") if isinstance(payload.get("summary"), str) else None
    lang = payload.get("lang") if payload.get("lang") in ("ko", "en") else _lang(title)
    return feed_item(title=title.strip(), url=url, publisher=payload.get("publisher"), domain=domain, published=published,
                     basis=basis, source=source, kind="news", lang=lang, summary=summary)


_BUNDLE_ORDER = "COALESCE(NULLIF(payload->>'publishedAt', ''), payload->>'fetchedAt') DESC, entity"


def _bundle_rows(terms: list[str]) -> list[dict]:
    ilike, regex = rules.sql_patterns(terms)
    clauses = [f"payload->>'{field}' ILIKE ANY(%(ilike)s::text[])" for field in ("title", "summary")]
    clauses += [f"payload->>'{field}' ~* ANY(%(regex)s::text[])" for field in ("title", "summary")]
    sql = ("SELECT payload FROM observations WHERE dataset = %(dataset)s AND (" + " OR ".join(clauses) + ") "
           f"ORDER BY {_BUNDLE_ORDER} LIMIT %(limit)s")
    with store.connection() as conn:
        _set_timeout(conn)
        return conn.execute(sql, {"dataset": catalog.OBS_SEARCH_FEED_HEADLINE, "ilike": ilike, "regex": regex,
                                  "limit": BUNDLE_ROW_LIMIT}).fetchall()


def feed_bundle(terms: list[str]) -> Fetched:
    """새 피드 묶음(보도자료·경제지 — 회원에게도)에서 별칭이 제목·요약에 든 글(영문은 단어 경계, 한글은 포함)."""
    if not terms:
        return Fetched()
    try:
        rows = _bundle_rows(terms)
    except Exception as exc:  # noqa: BLE001 — 저장소 장애는 이 출처의 실패
        return Fetched(error=_store_error(exc))
    items = []
    for row in rows:
        payload = row["payload"] if isinstance(row.get("payload"), dict) else {}
        if not (rules.text_matches(payload.get("title"), terms) or rules.text_matches(payload.get("summary"), terms)):
            continue
        item = bundle_item(payload)
        if item is not None:
            items.append(item)
    note = f"최근 {BUNDLE_ROW_LIMIT}건까지만 찾음" if len(rows) >= BUNDLE_ROW_LIMIT else None
    return Fetched(items=items, note=note)


def recent_bundle(limit: int) -> Fetched:
    """새 피드 묶음의 최근 글 ``limit``건(첫 화면 — 대상 없이)."""
    try:
        with store.connection() as conn:
            _set_timeout(conn)
            rows = conn.execute(f"SELECT payload FROM observations WHERE dataset = %s ORDER BY {_BUNDLE_ORDER} LIMIT %s",
                                (catalog.OBS_SEARCH_FEED_HEADLINE, limit)).fetchall()
    except Exception as exc:  # noqa: BLE001
        return Fetched(error=_store_error(exc))
    items = [bundle_item(row["payload"]) for row in rows if isinstance(row.get("payload"), dict)]
    return Fetched(items=[item for item in items if item is not None])


def recent_wire(limit: int) -> Fetched:
    """속보(Financial Juice — 운영자)의 최근 줄 ``limit``건(첫 화면)."""
    try:
        with store.connection() as conn:
            _set_timeout(conn)
            rows = conn.execute(
                "SELECT id, source, kind, url, title, title_ko, published_at, first_seen_at, summary FROM info_items "
                "WHERE kind = ANY(%s::text[]) ORDER BY COALESCE(published_at, first_seen_at) DESC, id LIMIT %s",
                (list(WIRE_KINDS), limit)).fetchall()
    except Exception as exc:  # noqa: BLE001
        return Fetched(error=_store_error(exc))
    items = []
    for row in rows:
        published, basis = row["published_at"], "published"
        if published is None:
            published, basis = row["first_seen_at"], "fetched"
        items.append(feed_item(title=row["title"], url=row["url"], publisher=_publisher(row["source"]),
                               domain=rules.domain_of(row["url"]), published=published, basis=basis, source="wire", kind="wire",
                               lang=_lang(row["title_ko"] or row["title"]), summary=row["summary"], reader_id=row["id"]))
    return Fetched(items=items)


# ------------------------------------------------------------------ 관심 대상이 모은 글(단계 3)

def watch_items(entity_key: str, *, owner: bool) -> Fetched:
    """
    그 대상(대표 키)의 모은 글 — 출처 표시는 ``watch``이고, 운영자 전용 출처(속보·수집 글)에서 온 줄은 운영자에게만 그 출처 이름 그대로 둡니다
    (백엔드가 회원에게서 한 번 더 지움). 경유 주소(구글) 줄은 뒤로 — 같은 글의 원문 주소 줄이 먼저 남게(규칙 4).
    """
    try:
        rows = store.search_watch_items(entity_key, WATCH_ROW_LIMIT)
    except Exception as exc:  # noqa: BLE001
        return Fetched(error=_store_error(exc))
    items = []
    for row in rows:
        origin = row["source"]
        if origin in OWNER_ONLY_ORIGINS and not owner:
            continue
        published, basis = row["published_at"], "published"
        if published is None:
            published, basis = row["first_seen_at"], "fetched"
        reader = row["item_id"] if origin in ("wire", "info") else None
        items.append(feed_item(title=row["title"], url=row["url"], publisher=row["publisher"], domain=row["publisher_domain"],
                               published=published, basis=basis, source=origin if origin in OWNER_ONLY_ORIGINS else "watch",
                               kind=row["kind"] or "news", lang=row["lang"], summary=row["summary"], reader_id=reader,
                               item_id=row["item_id"]))
    items.sort(key=lambda item: rules.is_relay(item["url"]))
    note = f"최근 {WATCH_ROW_LIMIT}건까지만 읽음" if len(rows) >= WATCH_ROW_LIMIT else None
    return Fetched(items=items, note=note)


# ------------------------------------------------------------------ 사용자가 더한 제외 매체(단계 3)

_excludes: tuple[float, rules.Excludes] | None = None
_excludes_lock = threading.Lock()


def user_excludes() -> rules.Excludes:
    """
    사용자가 더한 제외 매체(백엔드 표 search_media_excludes — 읽기만) → rules.Excludes. 60초 캐시. 읽지 못하면 직전 값(없으면 빈 목록)을 쓰고
    10초 뒤 다시 읽습니다 — 처음 값 목록·'.cn'·중국어 제목 규칙은 코드에 있어 그대로 걸립니다.
    """
    global _excludes
    with _excludes_lock:
        hit = _excludes
    if hit is not None and hit[0] > time.monotonic():
        return hit[1]
    try:
        value = rules.make_excludes(store.search_media_excludes())
        life = EXCLUDES_TTL
    except Exception as exc:  # noqa: BLE001
        logger.info("정보 검색: 사용자 제외 매체를 읽지 못함(%s) — 직전 값으로", type(exc).__name__)
        value = hit[1] if hit is not None else rules.Excludes()
        life = EXCLUDES_FAILURE_TTL
    with _excludes_lock:
        _excludes = (time.monotonic() + life, value)
    return value


def reset_excludes() -> None:
    """시험용 — 사용자 제외 매체 캐시를 비웁니다."""
    global _excludes
    with _excludes_lock:
        _excludes = None
