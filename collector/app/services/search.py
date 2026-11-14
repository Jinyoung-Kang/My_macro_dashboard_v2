"""
app/services/search.py
정보 검색(ADR 0041, 계약 docs/specs/2026-11-14-info-search-contract.md §2~4) — 수집기 ``/live/search/*``가 부르는 곳.

- ``suggest``: 치는 동안의 후보 — 이미 가진 색인만(바깥 호출 0건, search_entities.local_candidates).
- ``resolve``: Enter의 후보 — 로컬 + Wikidata 이름 찾기(한글이 있으면 ko, 아니면 en — 1시간 캐시, RESOLVE_DEADLINE까지만 기다림),
  맨 끝에 언제나 ``topic:<q>``.
- ``entity``: 대상 풀기(하루 캐시, 실패가 섞이면 60초) — search_entities.build.
- ``feed``: 탭 하나의 결과(2년 묶음 한 번에) — 출처를 작은 스레드 풀로 함께 부르고(출처마다 캐시 — 성공 15분·실패 60초) 규칙(search_rules)을
  적용해 합칩니다. 단계 4(계약 §7)에서 공시 탭(``sec``·``sec_fts``·``dart`` — 기업·기관·사람)과 리서치 탭(``yahoo_research``·``naver_research`` —
  기업)을 엶(상태 ``later`` 없앰). 타임라인은 그 대상에 허락된 모든 탭의 합(주제는 공시·리서치 없음). 단계 3에서 저장본 출처 둘을 더함 — 새 피드 묶음(``feeds``,
  보도자료·경제지 — 회원에게도)과 관심 대상이 모은 글(``watch``). ``refresh``면 출처 캐시를 건너뜀('지금 새로 받기' — 빈도는 백엔드가 막음).
  모은 글 가운데 수집 글·거장 견해에서 온 줄은 글이 섞이는 탭(타임라인)에만 두고(뉴스 탭에는 넣지 않음 — 계약 §3-4), 출처 상태 줄의 건수는
  그 줄을 내준 출처에서 셉니다(모은 글은 표시 출처가 ``wire``·``info``여도 '관심 대상 수집' 줄 — 상태 줄 건수의 합 = 줄 수). 모은 글의 경유
  주소(구글) 줄은 합칠 때 맨 뒤로 보내 같은 기사의 원문 주소 줄이 남게 합니다.
  단계 5(계약 §8-4)에서 미국 상장 회사의 뉴스·타임라인에 Finviz 종목 뉴스(``finviz`` — search_finviz)를 더함: 바로 답하고 받기는 작업자가 —
  받는 중이면 상태 ``pending``과 응답 ``pending: true``, 이 요청이 새로 줄에 넣었으면 ``finvizQueued: true``(백엔드가 사용자 빈도를 셈),
  ``finviz=False``면 줄에 넣지 않음(캐시는 씀). 공시 출처는 대상 풀기가 SEC 표·DART 저장본을 읽지 못해 식별자를 모르면 '건너뜀'이 아니라
  ``error``(단계 4 QA — 확인하지 못한 것을 '없음'으로 보이지 않음).
  단계 6(계약 §9-2)에서 모든 탭의 합친 줄에 같은 사건 묶기(search_rules.cluster_items)를 더함 — 줄마다 ``clusterId``, 대표 줄에
  ``cluster: {size, publishers}``. 줄을 빼지 않으므로 기간 건수·출처 건수는 그대로입니다.
- ``recent``(단계 3): 첫 화면 — 새 피드 묶음 최근 30건(+ 운영자는 속보 최근 20건). 저장본만, 바깥 호출 0건. 사용자 제외 매체는 60초 캐시 없이
  바로 읽음(값싼 저장본 경로 — 제외를 더한 직후 화면이 다시 읽으면 바로 빠짐, 단계 4 QA).
- ``excludes``(단계 3): 매체 제외 목록의 처음 값(묶음 이름과 함께)과 늘 적용하는 규칙. 바깥 호출·DB 없음.
- ``links``(단계 4, 계약 §7-5): 연결 보강 — Yahoo 내부자 명단(``insiders``)·GLEIF 법인 관계(``gleif``). 대상 풀기와 따로 부르고 출처마다 캐시
  (search_links). 중국어 이름의 연결은 빼고 상태 줄에 셉니다. LEI가 없을 때 'LEI 없음'은 Wikidata 항목을 읽었을 때만(못 찾았으면 '모름').

관심 대상이 모은 글(``watch``)은 탭에 맞는 종류만 섞습니다(계약 §7-6): 뉴스 탭은 ``news``·``headline``·``wire``(속보는 운영자에게만 — §3-4),
공시 탭은 ``filing``, 타임라인은 전부(주제는 공시·리서치 줄 없음).

매체 제외는 처음 값(코드 상수) + 사용자가 더한 매체(백엔드 표 search_media_excludes — search_store.user_excludes, 60초 캐시)입니다.

운영자 전용 저장본(수집 글·거장 견해·속보)은 ``owner=true``일 때만 읽고, 아니면 상태 줄만 ``owner_only``로 둡니다(백엔드가 한 번 더 거름).
``external=false``(데모·``STORE_ONLY``)면 바깥 출처는 캐시만 보고 부르지 않습니다(상태 ``offline``). DB에 쓰지 않고, 검색어·경로를 로그에 남기지
않습니다. 이 결과는 모의 매매의 입력이 아닙니다.
"""
from __future__ import annotations

import concurrent.futures as futures
import dataclasses
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from .. import store
from . import search_entities, search_filings, search_finviz, search_links, search_research, search_store
from . import search_rules as rules
from . import search_sources as sources
from . import search_wikidata as wd

logger = logging.getLogger(__name__)

TABS = ("timeline", "news", "posts", "filings", "research")
QUERY_MAX_CHARS = 60
ENTITY_TTL = 86_400.0
RESOLVE_TTL = 3_600.0
FAILURE_TTL = 60.0
RESOLVE_LIMIT = 15
RESOLVE_LOCAL_HEAD = 8
WIKIDATA_CANDIDATES = 8
ENTITY_DEADLINE = 15.0          # 대상 풀기를 기다리는 상한(초) — 넘으면 로컬 이름으로만 찾음
RESOLVE_DEADLINE = 15.0         # Enter 후보의 Wikidata 이름 찾기를 기다리는 상한(초) — 넘으면 로컬 후보와 주제만
SOURCE_DEADLINE = 30.0          # 출처를 함께 부른 뒤 기다리는 상한(초) — 둘을 더해도 45초(백엔드의 수집기 읽기 상한 90초 안)
MAX_WORKERS = 8
OFFLINE = search_entities.OFFLINE

LABELS = {
    "google_ko": "구글 뉴스(한국어)", "google_en": "구글 뉴스(영어)", "bing": "Bing 뉴스", "yahoo": "Yahoo 종목 뉴스",
    "naver": "네이버 종목 뉴스", "infomax": "연합인포맥스", "event_news": "사건 뉴스(저장본)", "wire": "속보(Financial Juice)",
    "info": "수집 글", "guru": "거장 견해",
    "feeds": "보도자료·경제지 피드", "watch": "관심 대상 수집",
    # 단계 4(계약 §7-2·§7-3·§7-5)
    "sec": "SEC 공시(회사별)", "sec_fts": "SEC 전문 검색(이름)", "dart": "DART 공시",
    "yahoo_research": "투자의견 변경(Yahoo)", "naver_research": "증권사 리포트(네이버)",
    "insiders": "내부자 명단(Yahoo)", "gleif": "법인 관계(GLEIF)",
    # 단계 5(계약 §8-3)
    "finviz": search_finviz.LABEL,
}
DISPLAY_ORDER = ("google_ko", "google_en", "bing", "yahoo", "finviz", "naver", "infomax", "event_news", "feeds", "watch", "wire",
                 "info", "guru", "sec", "sec_fts", "dart", "yahoo_research", "naver_research")
LINK_ORDER = ("insiders", "gleif")
# 같은 글이 여러 출처에 있으면 앞의 출처가 남습니다(계약 §4-4: 저장본 > Yahoo·네이버 > Bing > 구글, §7-4: 그 뒤에
# sec > sec_fts > dart > yahoo_research > naver_research — SEC 두 출처는 같은 접수번호 id라 한 줄, §8-3: Finviz는 Yahoo 바로 뒤).
# 모은 글의 공시 줄은 dart 바로 뒤(_merge_order — 실시간 공시 출처가 먼저).
MERGE_PRIORITY = ("event_news", "feeds", "info", "guru", "wire", "watch", "yahoo", "finviz", "naver", "bing", "infomax", "google_ko",
                  "google_en", "sec", "sec_fts", "dart", "yahoo_research", "naver_research")
FILING_KINDS = ("company", "institution", "person")     # 공시 탭이 있는 대상 종류(주제는 없음)
FTS_KINDS = ("institution", "person")                   # EDGAR 이름 전문 검색을 묻는 대상 종류
# 관심 대상이 모은 글에서 탭마다 섞는 종류(계약 §7-6). 뉴스 탭의 'wire'는 운영자에게만 남는 속보(§3-4 — 단계 3과 같음).
WATCH_KINDS = {"news": ("news", "headline", "wire"), "filings": ("filing",)}
TOPIC_TIMELINE_KINDS = ("news", "headline", "wire", "post", "opinion")   # 주제의 타임라인 — 공시·리서치 줄 없음
_CIK = re.compile(r"^\d{10}$")
_CORP_CODE = re.compile(r"^\d{8}$")
OWNER_SOURCES = ("wire", "info", "guru")
POST_SOURCES = ("info", "guru")    # 글 탭의 출처 — 모은 글에서 이 출처로 표시되는 줄은 뉴스 탭에 넣지 않음
RECENT_FEEDS = 30               # 첫 화면 — 새 피드 묶음 최근 건수
RECENT_WIRE = 20                # 첫 화면 — 운영자에게 더하는 속보 최근 건수

_KEY_PATTERNS = {
    "us": re.compile(r"^[A-Z0-9.\-]{1,15}$"),
    "kr": re.compile(r"^\d{6}$"),
    "cik": re.compile(r"^\d{10}$"),
    "wd": re.compile(r"^Q[1-9]\d{0,11}$"),
}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


# ------------------------------------------------------------------ 입력 검사

def clean_query(q: str | None) -> str:
    """검색어 — 앞뒤 공백을 떼고 1~60자, 제어 글자 없음. 아니면 ValueError."""
    text = " ".join((q or "").split())
    if not text or len(text) > QUERY_MAX_CHARS or _CONTROL.search(q or ""):
        raise ValueError(f"검색어는 1~{QUERY_MAX_CHARS}자입니다.")
    return text


def parse_key(key: str | None) -> tuple[str, str]:
    """대상 키 → (종류, 값). 계약 §2의 문법(us:·kr:·cik:·wd:·topic:)이 아니면 ValueError."""
    prefix, sep, value = (key or "").partition(":")
    if not sep:
        raise ValueError("대상 키 형식이 올바르지 않습니다.")
    if prefix == "topic":
        if _CONTROL.search(value):
            raise ValueError("주제에 제어 글자를 쓸 수 없습니다.")
        return "topic", clean_query(value)
    pattern = _KEY_PATTERNS.get(prefix)
    if pattern is None or not pattern.match(value):
        raise ValueError("대상 키 형식이 올바르지 않습니다.")
    return prefix, value


def check_tab(tab: str | None) -> str:
    if tab not in TABS:
        raise ValueError(f"tab은 {', '.join(TABS)} 가운데 하나입니다.")
    return tab


def _now_iso() -> str:
    return rules.utc_iso(datetime.now(timezone.utc))


# ------------------------------------------------------------------ 캐시

_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _get(key: tuple) -> dict | None:
    with _cache_lock:
        hit = _cache.get(key)
    return hit[1] if hit is not None and hit[0] > time.monotonic() else None


def _put(key: tuple, value: dict, life: float) -> None:
    stamp = time.monotonic()
    with _cache_lock:
        _cache[key] = (stamp + life, value)
        if len(_cache) > 2000:
            for stale in [k for k, (until, _) in _cache.items() if until <= stamp]:
                _cache.pop(stale, None)


def reset_cache() -> None:
    """시험용 — 대상·후보 캐시, 출처별 캐시(연결 출처 포함), 로컬 색인·SEC 표, Finviz 캐시·줄을 모두 비웁니다."""
    with _cache_lock:
        _cache.clear()
        _entity_jobs.clear()
        _resolve_jobs.clear()
    sources.reset_cache()
    search_links.reset_cache()
    search_store.reset_excludes()
    search_entities.reset()
    search_finviz.reset()


# ------------------------------------------------------------------ 후보

def suggest(q: str, *, owner: bool = False) -> dict:
    """치는 동안의 후보(최대 12개) — 이미 가진 색인만, 바깥 호출 없음. 거장 이름은 운영자에게만."""
    text = clean_query(q)
    return {"items": search_entities.local_candidates(text, owner=owner), "fetchedAt": _now_iso()}


def _norm_name(name: str) -> str:
    return " ".join((search_entities.clean_company_name(name) or name).split()).casefold()


def _same_group(left: str, right: str) -> bool:
    groups = {"company": "org", "institution": "org"}
    return groups.get(left, left) == groups.get(right, right)


def _wikidata_candidates(text: str) -> tuple[list[dict], str | None]:
    """
    Wikidata 이름 찾기(한글이면 ko, 아니면 en) + 그 항목들 읽기(종류·대표 키) — 호출 두 번. 1시간 캐시, 실패는 60초.
    설명·라벨이 중국어뿐인 후보는 뺍니다.
    """
    key = ("resolve-wd", text.casefold())
    hit = _get(key)
    if hit is not None:
        return hit["items"], hit["error"]
    lang = "ko" if rules.has_hangul(text) else "en"
    try:
        results = wd.search(text, lang, WIKIDATA_CANDIDATES)
        results = [row for row in results
                   if not (rules.is_chinese_title(row["label"]) and (not row["description"]
                                                                    or rules.is_chinese_title(row["description"])))]
        parsed = wd.get_entities([row["id"] for row in results]) if results else {}
    except wd.WikidataError as exc:
        _put(key, {"items": [], "error": str(exc)}, FAILURE_TTL)
        return [], str(exc)
    items = [search_entities.wd_candidate(row["id"], row["label"], row["description"], parsed.get(row["id"]))
             for row in results]
    _put(key, {"items": items, "error": None}, RESOLVE_TTL)
    return items, None


_resolve_jobs: dict[str, futures.Future] = {}


def _wikidata_job(text: str) -> tuple[list[dict], str | None]:
    try:
        return _wikidata_candidates(text)
    finally:
        with _cache_lock:
            _resolve_jobs.pop(text.casefold(), None)


def _wikidata_in_time(text: str) -> tuple[list[dict], str | None]:
    """
    Wikidata 후보를 RESOLVE_DEADLINE까지만 기다립니다 — 넘으면 빈 목록과 사유(그 사이 끝난 찾기는 캐시에 남아 다음에 씀).
    같은 검색어를 이미 찾는 중이면 그 결과를 기다립니다(다시 보내지 않음).
    """
    norm = text.casefold()
    hit = _get(("resolve-wd", norm))
    if hit is not None:
        return hit["items"], hit["error"]
    with _cache_lock:
        job = _resolve_jobs.get(norm)
        if job is None:
            pool = futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="search-resolve")
            job = pool.submit(_wikidata_job, text)
            _resolve_jobs[norm] = job
            pool.shutdown(wait=False)
    try:
        return job.result(timeout=RESOLVE_DEADLINE)
    except futures.TimeoutError:
        return [], f"Wikidata 이름 찾기가 {int(RESOLVE_DEADLINE)}초를 넘어 로컬 후보만 보임 — 잠시 뒤 다시 찾으면 그 사이 받은 결과를 씀"


def resolve(q: str, *, owner: bool = False, external: bool = True) -> dict:
    """
    Enter의 후보 — 로컬 + Wikidata(최대 15개), 맨 끝에 ``topic:<q>``. 같은 대상을 둘로 보이지 않게 합니다(동명이인은 남음):
    키가 있는 로컬 후보와 키·이름·종류가 같은 Wikidata 후보는 빼고, 키가 없는 로컬 후보(13F 운용자·거장 이름)는 이름·종류가 같은
    Wikidata 후보가 있으면 로컬 쪽을 뺍니다(그래야 그 사람의 대상 화면으로 들어갈 수 있음).
    """
    text = clean_query(q)
    local = search_entities.local_candidates(text, owner=owner)
    errors: dict[str, str] = {}
    remote: list[dict] = []
    if external:
        remote, error = _wikidata_in_time(text)
        if error:
            errors["wikidata"] = error
    else:
        hit = _get(("resolve-wd", text.casefold()))
        if hit is not None and not hit["error"]:
            remote = hit["items"]
        else:
            errors["wikidata"] = OFFLINE
    keyed = [item for item in local if item["key"]]
    keys = {item["key"] for item in keyed}
    names = {(_norm_name(item["name"]), item["kind"]) for item in keyed}
    remote = [item for item in remote if item["key"] not in keys
              and not any(name == _norm_name(item["name"]) and _same_group(kind, item["kind"]) for name, kind in names)]
    seen: set[str] = set()
    remote = [item for item in remote if not (item["key"] in seen or seen.add(item["key"]))]
    remote_names = {(_norm_name(item["name"]), item["kind"]) for item in remote}
    local = [item for item in local if item["key"]
             or not any(name == _norm_name(item["name"]) and _same_group(kind, item["kind"]) for name, kind in remote_names)]
    room = RESOLVE_LIMIT - 1
    head = local[:RESOLVE_LOCAL_HEAD] if remote else local[:room]
    items = head + remote[: room - len(head)]
    items += local[len(head):][: room - len(items)]
    items.append({"key": f"topic:{text}", "kind": "topic", "name": text, "sub": None, "source": "topic"})
    return {"items": items, "errors": errors, "fetchedAt": _now_iso()}


# ------------------------------------------------------------------ 대상 풀기

_entity_jobs: dict[str, futures.Future] = {}


def _resolve_entity(norm: str, prefix: str, value: str, external: bool) -> dict:
    try:
        built = search_entities.build(prefix, value, external=external)
        result = {"entity": built["entity"], "errors": built["errors"], "fetchedAt": _now_iso()}
        _put(("entity", norm, external), result, ENTITY_TTL if external and not built["errors"] else FAILURE_TTL)
        return result
    finally:
        if external:
            with _cache_lock:
                _entity_jobs.pop(norm, None)


def entity(key: str, *, external: bool = True) -> dict:
    """
    대상 풀기 — 하루 캐시(실패가 섞였거나 외부 호출을 끈 결과는 60초). 외부 호출을 끈 요청은 앞서 풀어 둔 결과가 있으면 그것을 씁니다.
    바깥을 부르는 풀기는 ENTITY_DEADLINE까지만 기다리고, 넘으면 저장본 이름으로만 답합니다(그 사이 끝난 풀기는 캐시에 남아 다음에 씀).
    같은 대상을 이미 푸는 중이면 그 결과를 기다립니다(대상 화면과 결과 탭이 함께 불러도 바깥 호출은 한 벌).
    """
    prefix, value = parse_key(key)
    norm = f"{prefix}:{value}"
    hit = _get(("entity", norm, True)) or (None if external else _get(("entity", norm, False)))
    if hit is not None:
        return hit
    if not external:
        return _resolve_entity(norm, prefix, value, False)
    with _cache_lock:
        job = _entity_jobs.get(norm)
        if job is None:
            pool = futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="search-entity")
            job = pool.submit(_resolve_entity, norm, prefix, value, True)
            _entity_jobs[norm] = job
            pool.shutdown(wait=False)
    try:
        return job.result(timeout=ENTITY_DEADLINE)
    except futures.TimeoutError:
        local = _get(("entity", norm, False)) or _resolve_entity(norm, prefix, value, False)
        # 저장본만 본 풀기의 '외부 호출을 끈 요청' 사유는 이 요청(외부 호출을 켠)에 맞지 않아 빼고 시간 초과만 적습니다.
        errors = {source: reason for source, reason in local["errors"].items() if reason != OFFLINE}
        errors["entity"] = f"대상 풀기가 {int(ENTITY_DEADLINE)}초를 넘어 저장본 이름으로만 답함"
        return dict(local, errors=errors)


# ------------------------------------------------------------------ 결과

@dataclass
class _Spec:
    source: str
    run: Callable[[], sources.Fetched] | None = None
    status: str | None = None           # 부르지 않는 줄의 상태(owner_only·skipped·later)
    message: str | None = None


def _status_row(source: str, status: str, count: int, dropped: dict | None, message: str | None) -> dict:
    return {"source": source, "label": LABELS[source], "status": status, "count": count,
            "dropped": dropped or rules.empty_dropped(), "message": message}


def _remote(source: str, key: tuple, fetch: Callable[[], sources.Fetched], external: bool, refresh: bool = False) -> _Spec:
    return _Spec(source, run=lambda: sources.cached(key, fetch, external=external, refresh=refresh))


def _stored(source: str, key: tuple, fetch: Callable[[], sources.Fetched], refresh: bool = False) -> _Spec:
    return _Spec(source, run=lambda: sources.cached(key, fetch, external=True, refresh=refresh))


def _watch_spec(entity_key: str, *, owner: bool, refresh: bool, kinds: tuple[str, ...] | None = None) -> _Spec:
    """
    관심 대상이 모은 글(대표 키) — 운영자 전용 출처에서 온 줄은 운영자에게만(캐시 키에 owner). ``kinds``가 있으면 그 종류의 줄만(계약 §7-6 — 뉴스 탭
    ``WATCH_KINDS["news"]``·공시 탭 ``filing``·주제의 타임라인, None = 전부). 글(``post``)이 섞이지 않는 탭에서는 수집 글·거장 견해에서 온 줄을
    뺍니다(그 글은 글 탭의 것 — 계약 §3-4).
    """
    def run() -> sources.Fetched:
        result = sources.cached(("watch", entity_key, owner, kinds),
                                lambda: search_store.watch_items(entity_key, owner=owner, kinds=kinds),
                                external=True, refresh=refresh)
        if kinds is None or "post" in kinds:
            return result
        return dataclasses.replace(result, items=[item for item in result.items if item.get("source") not in POST_SOURCES])

    return _Spec("watch", run=run)


def _timeline_watch_kinds(target: dict | None) -> tuple[str, ...] | None:
    """타임라인이 섞는 모은 글의 종류 — 주제는 공시·리서치 줄 없음(그 탭이 없음), 그 밖은 전부."""
    return TOPIC_TIMELINE_KINDS if (target or {}).get("kind") == "topic" else None


def _news_specs(target: dict, *, owner: bool, external: bool, after: str, refresh: bool = False,
                posts: bool = False) -> list[_Spec]:
    ko, en = rules.edition_terms(target, "ko"), rules.edition_terms(target, "en")
    match = rules.match_terms(target)
    ids = target.get("ids") or {}
    specs = []
    for lang, terms in (("ko", ko), ("en", en)):
        source = f"google_{lang}"
        if terms:
            specs.append(_remote(source, (source, tuple(terms), after),
                                 lambda terms=terms, lang=lang: sources.google(terms, lang, after=after), external, refresh))
        else:
            specs.append(_Spec(source, status="skipped",
                               message=f"{sources.EDITION_LABELS[lang]} 이름이 없어 묻지 않음"))
    if ko or en:
        us_ticker = ids.get("ticker") if target.get("kind") == "company" and ids.get("market") == "us" else None
        specs.append(_remote("bing", ("bing", tuple(ko), tuple(en), us_ticker),
                             lambda: sources.bing({"ko": ko, "en": en}, ticker=us_ticker), external, refresh))
    else:
        specs.append(_Spec("bing", status="skipped", message="검색할 이름이 없음"))
    if target.get("kind") == "company" and ids.get("market") == "us" and ids.get("ticker"):
        ticker = ids["ticker"]
        specs.append(_remote("yahoo", ("yahoo", ticker), lambda: sources.yahoo_news(ticker), external, refresh))
    if target.get("kind") == "company" and ids.get("market") == "kr" and ids.get("stockCode"):
        code = ids["stockCode"]
        specs.append(_remote("naver", ("naver", code), lambda: sources.naver(code), external, refresh))
    if target.get("kind") == "company" and ids.get("market") in ("us", "kr"):
        terms = ko or en
        if terms:
            specs.append(_remote("infomax", ("infomax", tuple(terms), after),
                                 lambda: sources.infomax(terms, after=after), external, refresh))
    if match:
        specs.append(_stored("event_news", ("event_news", tuple(match)), lambda: search_store.event_news(match), refresh))
        specs.append(_stored("feeds", ("feeds", tuple(match)), lambda: search_store.feed_bundle(match), refresh))
    else:
        specs.append(_Spec("event_news", status="skipped", message="찾을 이름이 없음"))
        specs.append(_Spec("feeds", status="skipped", message="찾을 이름이 없음"))
    if target.get("key"):
        kinds = _timeline_watch_kinds(target) if posts else WATCH_KINDS["news"]
        specs.append(_watch_spec(target["key"], owner=owner, refresh=refresh, kinds=kinds))
    if owner:
        specs.append(_stored("wire", ("wire", tuple(match)), lambda: search_store.wire(match), refresh))
    else:
        specs.append(_Spec("wire", status="owner_only"))
    return specs


def _post_specs(target: dict, *, owner: bool, refresh: bool = False) -> list[_Spec]:
    if not owner:
        return [_Spec("info", status="owner_only"), _Spec("guru", status="owner_only")]
    match = rules.match_terms(target)
    return [_stored("info", ("info", tuple(match)), lambda: search_store.info_posts(match), refresh),
            _stored("guru", ("guru", tuple(match)), lambda: search_store.guru_views(match), refresh)]


def _unknown_id(source: str, errors: dict, keys: tuple[str, ...], label: str, *, external: bool) -> _Spec | None:
    """
    식별자가 없을 때 그것이 '읽지 못해 모름'인지 — 대상 풀기의 ``errors``에 ``keys``(그 표를 읽은 출처·대상 풀기 시간 초과)의 사유가 있으면
    공시 줄을 ``error``("<식별자>를 모름 — <사유>")로, 외부 호출을 끈 요청이면 ``offline``으로 둡니다. 그 표를 읽었는데 식별자가 없을 때만
    None(그때만 '건너뜀' — 계약 §5: 확인하지 못한 것을 '없음'으로 보이지 않음).
    """
    reason = next((errors[key] for key in keys if errors.get(key)), None)
    if not reason:
        return None
    if not external or reason == OFFLINE:
        return _Spec(source, status="offline", message=OFFLINE)
    return _Spec(source, status="error", message=f"{label}를 모름 — {reason}")


def _unknown_dart(ids: dict, errors: dict, *, external: bool) -> _Spec | None:
    """
    국내 종목에 DART 고유번호가 없을 때 그것이 '모름'인지. 대상 풀기는 저장본을 읽었든 못 읽었든 같은 사유('저장본에 이 종목이 없음')를
    남기므로(search_entities._build_kr) 사유 글로는 가르지 못해 저장본(외부 호출 없음)을 한 번 더 봅니다 — 저장본을 읽었고 그 종목이 없으면
    None(ETF·우선주 등 — '건너뜀'), 저장본을 읽지 못했으면 ``error``(외부 호출을 끈 요청이면 ``offline``), 저장본에는 있는데 대상에 없으면
    (저장본을 못 읽던 때 푼 대상 — 그 결과는 60초만 캐시) ``error``. 대상 풀기의 사유(``dart``·``entity``)가 없으면 None.
    """
    if not (errors.get("dart") or errors.get("entity")):
        return None
    codes = search_store.dart_codes()
    if codes and ids.get("stockCode") not in codes:
        return None
    if not external:
        return _Spec("dart", status="offline", message=OFFLINE)
    reason = "대상을 풀 때 저장본을 읽지 못함" if codes else "DART 고유번호 저장본을 읽지 못함"
    return _Spec("dart", status="error", message=f"DART 고유번호를 모름 — {reason}")


def _filing_specs(target: dict, *, tab: str, owner: bool, external: bool, window_from: str, window_to: str,
                  refresh: bool = False, errors: dict | None = None) -> list[_Spec]:
    """
    공시 출처(계약 §7-2) — ``sec``(CIK가 있으면), ``sec_fts``(사람·13F 기관의 영문 이름 — Bing과 같은 구문 규칙, 티커 없이), ``dart``(DART 고유번호가
    있으면). 공시 탭이면 모은 글의 공시 줄도. 주제는 공시가 없어 공시 탭에서만 '건너뜀' 줄을 두고 타임라인에는 아무것도 넣지 않습니다.
    식별자가 없는데 대상 풀기가 SEC 티커 표를 읽지 못했거나 시간을 넘겼으면(``errors``), 또는 DART 고유번호 저장본을 읽지 못했으면
    (:func:`_unknown_dart`) '건너뜀'이 아니라 ``error``("CIK를 모름 — <사유>")입니다(단계 4 QA).
    """
    errors = errors or {}
    kind = target.get("kind")
    if kind not in FILING_KINDS:
        note = "주제에는 공시 탭이 없음"
        return [_Spec(source, status="skipped", message=note) for source in ("sec", "sec_fts", "dart")] if tab == "filings" else []
    ids = target.get("ids") or {}
    specs: list[_Spec] = []
    cik = ids.get("cik")
    if isinstance(cik, str) and _CIK.match(cik):
        specs.append(_remote("sec", ("sec", cik, window_from),
                             lambda: search_filings.sec_submissions(cik, start_day=window_from), external, refresh))
    elif ids.get("market") != "kr":
        specs.append(_unknown_id("sec", errors, ("sec", "entity"), "CIK", external=external)
                     or _Spec("sec", status="skipped", message="CIK가 없어 묻지 않음"))
    if kind in FTS_KINDS:
        phrases = sources.bing_queries(rules.edition_terms(target, "en"))
        if phrases:
            specs.append(_remote("sec_fts", ("sec_fts", tuple(phrases), window_from, window_to),
                                 lambda: search_filings.sec_fts(phrases, start_day=window_from, end_day=window_to), external,
                                 refresh))
        else:
            specs.append(_Spec("sec_fts", status="skipped", message="영문 이름이 없어 묻지 않음"))
    corp = ids.get("dartCorpCode")
    if isinstance(corp, str) and _CORP_CODE.match(corp):
        specs.append(_remote("dart", ("dart", corp, window_from, window_to),
                             lambda: search_filings.dart_list(corp, start_day=window_from, end_day=window_to), external, refresh))
    elif ids.get("market") == "kr":
        specs.append(_unknown_dart(ids, errors, external=external)
                     or _Spec("dart", status="skipped", message="DART 고유번호가 없어 묻지 않음"))
    if tab == "filings" and target.get("key"):
        specs.append(_watch_spec(target["key"], owner=owner, refresh=refresh, kinds=WATCH_KINDS["filings"]))
    return specs


def _finviz_spec(target: dict, *, external: bool, allow_queue: bool) -> tuple[_Spec | None, bool]:
    """
    Finviz 종목 뉴스(계약 §8-4) — 미국 상장 회사(티커)만. 바로 답합니다(받기는 search_finviz의 작업자): 받아 둔 결과는 ``ok``(막 받음)·``cached``,
    받는 중·줄에 있으면 ``pending``, 서버가 아니면 ``server_only``, 외부를 끈 요청은 캐시만(``offline``). → (상태 줄 자리, 이 요청이 새로 줄에 넣었는지)
    """
    ids = target.get("ids") or {}
    if not (target.get("kind") == "company" and ids.get("market") == "us" and ids.get("ticker")):
        return None, False
    answer = search_finviz.request(ids["ticker"], external=external, allow_queue=allow_queue)
    if answer.status in ("ok", "cached"):
        result = sources.Fetched(items=list(answer.items), note=answer.message, cached=answer.status == "cached")
        return _Spec("finviz", run=lambda: result), answer.queued
    if answer.status == "offline":
        return _Spec("finviz", status="offline", message=OFFLINE), answer.queued
    return _Spec("finviz", status=answer.status, message=answer.message), answer.queued


def _research_specs(target: dict, *, tab: str, external: bool, refresh: bool = False) -> list[_Spec]:
    """리서치 출처(계약 §7-3) — 기업(상장 종목)만: 미국 종목은 ``yahoo_research``, 국내 종목은 ``naver_research``."""
    if target.get("kind") != "company":
        note = "리서치 탭은 기업에만 있음"
        return ([_Spec(source, status="skipped", message=note) for source in ("yahoo_research", "naver_research")]
                if tab == "research" else [])
    ids = target.get("ids") or {}
    if ids.get("market") == "us" and ids.get("ticker"):
        ticker = ids["ticker"]
        return [_remote("yahoo_research", ("yahoo_research", ticker), lambda: search_research.yahoo_grades(ticker), external,
                        refresh)]
    if ids.get("market") == "kr" and ids.get("stockCode"):
        code = ids["stockCode"]
        return [_remote("naver_research", ("naver_research", code), lambda: search_research.naver_research(code), external,
                        refresh)]
    note = "미국·한국 상장 종목이 아니라 묻지 않음"
    # 상장되지 않은 기업은 화면에 리서치 탭이 없음 — 타임라인에는 건너뜀 줄도 두지 않음(주제·비기업과 같게).
    return ([_Spec(source, status="skipped", message=note) for source in ("yahoo_research", "naver_research")]
            if tab == "research" else [])


def _unresolved_specs(norm: str, tab: str, *, owner: bool, external: bool, refresh: bool) -> list[_Spec]:
    """대상을 풀지 못했을 때의 상태 줄 — 바깥 출처는 '건너뜀'(외부 호출을 끈 요청이면 offline), 모은 글은 키로 읽음."""
    note = "대상을 풀지 못해 묻지 않음"

    def remote(source: str) -> _Spec:
        # 외부 호출을 끈 요청(데모·STORE_ONLY)이면 바깥 출처는 '대상을 못 풀어서'가 아니라 '부르지 않아서' — 상태 offline(계약 §3-4).
        return _Spec(source, status="skipped" if external else "offline", message=note if external else OFFLINE)

    specs: list[_Spec] = []
    if tab in ("news", "timeline"):
        specs += [remote(source) for source in ("google_ko", "google_en", "bing")]
        specs.append(_Spec("event_news", status="skipped", message=note))
        specs.append(_Spec("feeds", status="skipped", message=note))
        # 관심 대상이 모은 글은 이름 없이 키로 읽습니다(등록 때 푼 대표 키 — 대상을 지금 풀지 못해도 모은 글은 보임).
        specs.append(_watch_spec(norm, owner=owner, refresh=refresh, kinds=None if tab == "timeline" else WATCH_KINDS["news"]))
        specs.append(_Spec("wire", status="owner_only" if not owner else "skipped", message=None if not owner else note))
    if tab in ("posts", "timeline"):
        specs += [_Spec(source, status="owner_only" if not owner else "skipped", message=None if not owner else note)
                  for source in ("info", "guru")]
    if tab == "filings":
        specs += [remote(source) for source in ("sec", "sec_fts", "dart")]
        specs.append(_watch_spec(norm, owner=owner, refresh=refresh, kinds=WATCH_KINDS["filings"]))
    if tab == "research":
        specs += [remote(source) for source in ("yahoo_research", "naver_research")]
    return specs


def _run(specs: list[_Spec]) -> dict[str, sources.Fetched]:
    """부를 출처를 함께 부르고 SOURCE_DEADLINE까지 기다립니다 — 늦은 출처는 '시간 초과'(끝나면 캐시에 남아 다음 요청이 씀)."""
    runnable = [spec for spec in specs if spec.run is not None]
    if not runnable:
        return {}
    pool = futures.ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(runnable)), thread_name_prefix="search-source")
    try:
        jobs = {pool.submit(spec.run): spec.source for spec in runnable}
        done, _ = futures.wait(jobs, timeout=SOURCE_DEADLINE)
        out: dict[str, sources.Fetched] = {}
        for job, source in jobs.items():
            if job in done:
                try:
                    out[source] = job.result()
                except Exception as exc:  # noqa: BLE001 — 출처 하나의 예외가 응답 전체를 넘어뜨리지 않게
                    out[source] = sources.Fetched(error=sources.safe_reason(exc))
            else:
                out[source] = sources.Fetched(error=f"{int(SOURCE_DEADLINE)}초 안에 답이 없음 — 잠시 뒤 다시 부르면 그 사이 받은 결과를 씀")
        return out
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def feed(key: str, tab: str, *, owner: bool = False, external: bool = True, refresh: bool = False, finviz: bool = True) -> dict:
    """
    탭 하나의 결과 — 오늘(KST)부터 2년 안의 줄 전부(최신순), 출처마다 상태 한 줄, 기간별 건수. 화면이 7일·30일·1년·2년으로 자릅니다.
    ``refresh``면 출처 캐시를 건너뜁니다(대상 풀기 캐시는 그대로 — 외부 호출을 끈 요청에서는 캐시만, Finviz의 30분 캐시도 그대로).
    ``finviz``가 거짓이면(백엔드 — 사용자 한 명의 한 시간 한도를 넘음) Finviz를 줄에 넣지 않고 받아 둔 결과만 씁니다.
    """
    prefix, value = parse_key(key)
    tab = check_tab(tab)
    norm = f"{prefix}:{value}"
    now = datetime.now(timezone.utc)
    today = rules.kst_today(now)
    window_from, window_to = rules.window(today)
    start = rules.window_start(today)

    resolved = entity(norm, external=external)
    target = resolved["entity"]
    finviz_queued = False
    if target is None:
        specs = _unresolved_specs(norm, tab, owner=owner, external=external, refresh=refresh)
    else:
        specs = []
        if tab in ("news", "timeline"):
            specs += _news_specs(target, owner=owner, external=external, after=window_from, refresh=refresh,
                                 posts=tab == "timeline")
            finviz_spec, finviz_queued = _finviz_spec(target, external=external, allow_queue=finviz)
            if finviz_spec is not None:
                specs.append(finviz_spec)
        if tab in ("posts", "timeline"):
            specs += _post_specs(target, owner=owner, refresh=refresh)
        if tab in ("filings", "timeline"):
            specs += _filing_specs(target, tab=tab, owner=owner, external=external, window_from=window_from,
                                   window_to=window_to, refresh=refresh, errors=resolved.get("errors"))
        if tab in ("research", "timeline"):
            specs += _research_specs(target, tab=tab, external=external, refresh=refresh)

    fetched = _run(specs)
    excludes = search_store.user_excludes() if fetched else rules.Excludes()
    groups: dict[str, list[dict]] = {}
    dropped_by: dict[str, dict] = {}
    latest_olds: list[str] = []
    for spec in specs:
        result = fetched.get(spec.source)
        if result is None:
            continue
        kept, dropped, latest_old = rules.apply_rules(result.items, start=start, now=now, excludes=excludes)
        groups[spec.source] = kept
        dropped_by[spec.source] = dropped
        if latest_old:
            latest_olds.append(latest_old)
    merged = rules.merge(_merge_order(groups))
    # 건수는 그 줄을 내준 출처에서 셉니다(모은 글의 줄은 표시 출처가 wire·info여도 'watch' — 상태 줄 건수의 합 = 줄 수).
    giver = {id(item): source for source, kept in groups.items() for item in kept}
    counts: dict[str, int] = {}
    for item in merged:
        source = giver.get(id(item), item["source"])
        counts[source] = counts.get(source, 0) + 1

    rows = []
    for spec in sorted(specs, key=lambda s: DISPLAY_ORDER.index(s.source)):
        result = fetched.get(spec.source)
        if result is None:
            rows.append(_status_row(spec.source, spec.status or "skipped", 0, None, spec.message))
            continue
        count = counts.get(spec.source, 0)
        if result.offline:
            status, message = "offline", OFFLINE
        elif result.error:
            status, message = "error", result.error
        elif result.cached:
            status, message = "cached", result.note
        else:
            status, message = ("ok" if count else "empty"), result.note
        rows.append(_status_row(spec.source, status, count, dropped_by.get(spec.source), message))

    return {
        "entityKey": norm,
        "tab": tab,
        # 같은 사건 묶기(단계 6, 계약 §9-2) — 줄마다 clusterId, 대표 줄에 cluster. 줄을 빼지 않아 기간·출처 건수는 그대로.
        "items": rules.cluster_items(merged, ignore=rules.match_terms(target) if target else ()),
        "sources": rows,
        "window": {"from": window_from, "to": window_to},
        "rangeCounts": rules.range_counts(merged, today),
        "olderOnlyLatest": max(latest_olds) if not merged and latest_olds else None,
        # 받는 중인 출처(Finviz)가 있으면 화면이 몇 초 뒤 다시 부름(계약 §8-6).
        "pending": any(row["status"] == "pending" for row in rows),
        # 이 요청이 Finviz를 새로 줄에 넣었는지 — 백엔드가 사용자 빈도를 세고 화면에는 넘기지 않음(계약 §8-5).
        "finvizQueued": finviz_queued,
        "fetchedAt": rules.utc_iso(now),
    }


def _merge_order(groups: dict[str, list[dict]]) -> list[list[dict]]:
    """
    합칠 순서(MERGE_PRIORITY) — 모은 글 가운데 두 갈래만 자리를 옮깁니다.
    - 경유 주소(구글) 줄은 맨 뒤로(구글 줄과 같은 낮은 우선순위, 같은 기사의 원문 주소 줄이 남게).
    - 공시 줄(kind ``filing``)은 실시간 공시 출처(``sec``·``sec_fts``·``dart``) 바로 뒤로 — 관심 대상 수집은 같은 회사별 목록·DART 목록을 같은 id로
      모으므로, 앞에 두면 겹치는 줄이 모두 모은 줄로 남아 실시간 출처가 줄을 줬는데도 상태가 '빈 결과'(0건)가 됩니다. 실시간 출처가 실패하면
      모은 공시 줄이 그 자리를 채웁니다.
    """
    ordered: list[list[dict]] = []
    relayed: list[dict] = []
    stored_filings: list[dict] = []
    for source in MERGE_PRIORITY:
        kept = groups.get(source, [])
        if source == "watch":
            relayed = [item for item in kept if rules.is_relay(item.get("url"))]
            stored_filings = [item for item in kept if not rules.is_relay(item.get("url")) and item.get("kind") == "filing"]
            kept = [item for item in kept if not rules.is_relay(item.get("url")) and item.get("kind") != "filing"]
        ordered.append(kept)
        if source == "dart":
            ordered.append(stored_filings)
    ordered.append(relayed)
    return ordered


# ------------------------------------------------------------------ 연결 보강(단계 4)

def _unknown_lei(errors: dict, *, external: bool) -> _Spec | None:
    """
    LEI가 없을 때 그것이 'Wikidata를 읽지 못해 모름'인지 — 대상 풀기의 ``errors``에 Wikidata 실패·시간 초과·외부 호출 끔이 있으면 GLEIF 줄을
    ``offline``(외부 호출을 끈 요청·Wikidata를 부르지 않음) 또는 ``error``(그 사유)로 둡니다. Wikidata가 답했으면(항목이 없음 포함) None — 그때만
    'LEI 없음'(계약 §5: 확인하지 못한 것을 '없음'으로 보이지 않음).
    """
    reason = errors.get("entity") or errors.get("wikidata")
    if not reason or reason == search_entities.WD_MISSING:
        return None
    if not external or reason == OFFLINE:
        return _Spec("gleif", status="offline", message=OFFLINE)
    return _Spec("gleif", status="error", message=f"LEI를 모름 — {reason}")


def _link_specs(target: dict | None, *, external: bool, errors: dict | None = None) -> list[_Spec]:
    """
    연결 출처(계약 §7-5) — 미국 상장 회사면 내부자 명단, LEI가 있으면 GLEIF. 해당하지 않으면 '건너뜀' 줄. LEI가 없는데 대상 풀기가 Wikidata를
    읽지 못했으면(``errors``) GLEIF 줄은 '건너뜀'이 아니라 offline·error, Wikidata 항목을 찾지 못했으면 '모름'(:func:`_no_lei`).
    """
    if target is None:
        note = "대상을 풀지 못해 묻지 않음"
        return [_Spec(source, status="skipped" if external else "offline", message=note if external else OFFLINE)
                for source in LINK_ORDER]
    ids = target.get("ids") or {}
    specs: list[_Spec] = []
    if target.get("kind") == "company" and ids.get("market") == "us" and ids.get("ticker"):
        ticker = ids["ticker"]
        specs.append(_Spec("insiders", run=lambda: search_links.cached(("insiders", ticker), lambda: search_links.insiders(ticker),
                                                                       ttl=search_links.INSIDERS_TTL, external=external)))
    else:
        specs.append(_Spec("insiders", status="skipped", message="미국 상장 회사가 아니라 묻지 않음"))
    lei = ids.get("lei")
    if isinstance(lei, str) and search_links.LEI_PATTERN.match(lei):
        specs.append(_Spec("gleif", run=lambda: search_links.cached(("gleif", lei), lambda: search_links.gleif(lei),
                                                                    ttl=search_links.GLEIF_TTL, external=external)))
    else:
        specs.append(_unknown_lei(errors or {}, external=external) or _no_lei(ids, errors or {}))
    return specs


def _no_lei(ids: dict, errors: dict) -> _Spec:
    """
    LEI가 없고 Wikidata를 읽지 못한 것도 아닐 때 — Wikidata 항목을 읽었으면(``ids.wikidata``가 있고 '항목 없음'이 아님) 'LEI 없음', 항목을
    찾지 못했거나 묻지 않았으면 '모름'(둘 다 건너뜀 — 단계 4 QA: 확인하지 못한 것을 '없음'으로 보이지 않음).
    """
    if ids.get("wikidata") and errors.get("wikidata") != search_entities.WD_MISSING:
        return _Spec("gleif", status="skipped", message="LEI 없음 — Wikidata에 법인 식별자가 없음")
    return _Spec("gleif", status="skipped", message="Wikidata 항목을 찾지 못해 LEI를 모름")


def links(key: str, *, external: bool = True, owner: bool = False) -> dict:
    """
    연결 보강(계약 §7-5) — ``{entityKey, links, sources, fetchedAt}``. 대상 풀기(하루 캐시)와 따로 부릅니다. 중국어 이름의 연결은 빼고(규칙 2)
    상태 줄의 ``dropped.chinese``에 셉니다. 운영자 전용 출처는 없어 ``owner``는 받기만 합니다.
    """
    prefix, value = parse_key(key)
    norm = f"{prefix}:{value}"
    resolved = entity(norm, external=external)
    specs = _link_specs(resolved["entity"], external=external, errors=resolved.get("errors"))
    fetched = _run(specs)
    out: list[dict] = []
    rows = []
    for spec in specs:
        result = fetched.get(spec.source)
        if result is None:
            rows.append(_status_row(spec.source, spec.status or "skipped", 0, None, spec.message))
            continue
        dropped = rules.empty_dropped()
        kept = []
        for link in result.items:
            if rules.is_chinese_title(link.get("name")):
                dropped["chinese"] += 1
            else:
                kept.append(link)
        out += kept
        if result.offline:
            status, message = "offline", OFFLINE
        elif result.error:
            status, message = "error", result.error
        elif result.cached:
            status, message = "cached", result.note
        else:
            status, message = ("ok" if kept else "empty"), result.note
        rows.append(_status_row(spec.source, status, len(kept), dropped, message))
    return {"entityKey": norm, "links": out, "sources": rows, "fetchedAt": _now_iso()}


# ------------------------------------------------------------------ 첫 화면·제외 목록(단계 3)

def recent(*, owner: bool = False) -> dict:
    """
    첫 화면(대상을 고르지 않은 때) — 새 피드 묶음 최근 RECENT_FEEDS건(회원에게도) + 운영자는 속보 최근 RECENT_WIRE건. 저장본만(바깥 호출 0건),
    규칙(2년·중국어·매체 제외)을 거쳐 최신순. 읽지 못한 저장본은 ``errors``에 사유(빈 목록을 '없음'으로 보이지 않게).
    """
    now = datetime.now(timezone.utc)
    start = rules.window_start(rules.kst_today(now))
    groups: list[sources.Fetched] = [search_store.recent_bundle(RECENT_FEEDS)]
    names = ["feeds"]
    if owner:
        groups.append(search_store.recent_wire(RECENT_WIRE))
        names.append("wire")
    excludes = _fresh_excludes()
    kept_groups = []
    errors: dict[str, str] = {}
    for name, result in zip(names, groups):
        if result.error:
            errors[name] = result.error
        kept, _, _ = rules.apply_rules(result.items, start=start, now=now, excludes=excludes)
        kept_groups.append(kept)
    return {"items": rules.merge(kept_groups), "errors": errors, "fetchedAt": rules.utc_iso(now)}


def _fresh_excludes() -> rules.Excludes:
    """
    사용자가 더한 제외 매체를 캐시(60초) 없이 바로 읽음 — 첫 화면(저장본만 읽는 값싼 경로)이 제외를 더한 직후 다시 읽을 때 바로 맞게(단계 4 QA).
    읽지 못하면 결과 경로와 같은 값(search_store.user_excludes — 직전 값)을 씁니다. 결과 경로(feed)는 그대로 60초 캐시.
    """
    try:
        return rules.make_excludes(store.search_media_excludes())
    except Exception as exc:  # noqa: BLE001
        logger.info("정보 검색: 사용자 제외 매체를 바로 읽지 못함(%s) — 캐시된 값으로", type(exc).__name__)
        return search_store.user_excludes()


def excludes() -> dict:
    """매체 제외 목록의 처음 값(묶음 이름과 함께)과 늘 적용하는 규칙 — 사용자가 더한 매체는 백엔드가 자기 표에서 붙입니다."""
    return {"seed": rules.seed_list(), "fixedRules": list(rules.FIXED_RULES)}
