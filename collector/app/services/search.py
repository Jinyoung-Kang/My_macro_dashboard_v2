"""
app/services/search.py
정보 검색(ADR 0041, 계약 docs/specs/2026-11-14-info-search-contract.md §2~4) — 수집기 ``/live/search/*``가 부르는 곳.

- ``suggest``: 치는 동안의 후보 — 이미 가진 색인만(바깥 호출 0건, search_entities.local_candidates).
- ``resolve``: Enter의 후보 — 로컬 + Wikidata 이름 찾기(한글이 있으면 ko, 아니면 en — 1시간 캐시, RESOLVE_DEADLINE까지만 기다림),
  맨 끝에 언제나 ``topic:<q>``.
- ``entity``: 대상 풀기(하루 캐시, 실패가 섞이면 60초) — search_entities.build.
- ``feed``: 탭 하나의 결과(2년 묶음 한 번에) — 출처를 작은 스레드 풀로 함께 부르고(출처마다 캐시 — 성공 15분·실패 60초) 규칙(search_rules)을
  적용해 합칩니다. 공시·리서치 탭은 다음 단계라 빈 목록과 상태 ``later``입니다. 단계 3에서 저장본 출처 둘을 더함 — 새 피드 묶음(``feeds``,
  보도자료·경제지 — 회원에게도)과 관심 대상이 모은 글(``watch``). ``refresh``면 출처 캐시를 건너뜀('지금 새로 받기' — 빈도는 백엔드가 막음).
  모은 글 가운데 수집 글·거장 견해에서 온 줄은 글이 섞이는 탭(타임라인)에만 두고(뉴스 탭에는 넣지 않음 — 계약 §3-4), 출처 상태 줄의 건수는
  그 줄을 내준 출처에서 셉니다(모은 글은 표시 출처가 ``wire``·``info``여도 '관심 대상 수집' 줄 — 상태 줄 건수의 합 = 줄 수). 모은 글의 경유
  주소(구글) 줄은 합칠 때 맨 뒤로 보내 같은 기사의 원문 주소 줄이 남게 합니다.
- ``recent``(단계 3): 첫 화면 — 새 피드 묶음 최근 30건(+ 운영자는 속보 최근 20건). 저장본만, 바깥 호출 0건.
- ``excludes``(단계 3): 매체 제외 목록의 처음 값(묶음 이름과 함께)과 늘 적용하는 규칙. 바깥 호출·DB 없음.

매체 제외는 처음 값(코드 상수) + 사용자가 더한 매체(백엔드 표 search_media_excludes — search_store.user_excludes, 60초 캐시)입니다.

운영자 전용 저장본(수집 글·거장 견해·속보)은 ``owner=true``일 때만 읽고, 아니면 상태 줄만 ``owner_only``로 둡니다(백엔드가 한 번 더 거름).
``external=false``(데모·``STORE_ONLY``)면 바깥 출처는 캐시만 보고 부르지 않습니다(상태 ``offline``). DB에 쓰지 않고, 검색어·경로를 로그에 남기지
않습니다. 이 결과는 모의 매매의 입력이 아닙니다.
"""
from __future__ import annotations

import concurrent.futures as futures
import dataclasses
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from . import search_entities, search_store
from . import search_rules as rules
from . import search_sources as sources
from . import search_wikidata as wd

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
    "info": "수집 글", "guru": "거장 견해", "filings": "공시", "research": "리서치",
    "feeds": "보도자료·경제지 피드", "watch": "관심 대상 수집",
}
DISPLAY_ORDER = ("google_ko", "google_en", "bing", "yahoo", "naver", "infomax", "event_news", "feeds", "watch", "wire", "info",
                 "guru", "filings", "research")
# 같은 글이 여러 출처에 있으면 앞의 출처가 남습니다(계약 §4-4: 저장본 > Yahoo·네이버 > Bing > 구글).
MERGE_PRIORITY = ("event_news", "feeds", "info", "guru", "wire", "watch", "yahoo", "naver", "bing", "infomax", "google_ko",
                  "google_en")
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
    """시험용 — 대상·후보 캐시, 출처별 캐시, 로컬 색인·SEC 표를 모두 비웁니다."""
    with _cache_lock:
        _cache.clear()
        _entity_jobs.clear()
        _resolve_jobs.clear()
    sources.reset_cache()
    search_store.reset_excludes()
    search_entities.reset()


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


def _watch_spec(entity_key: str, *, owner: bool, refresh: bool, posts: bool = False) -> _Spec:
    """
    관심 대상이 모은 글(대표 키) — 운영자 전용 출처에서 온 줄은 운영자에게만(캐시 키에 owner). ``posts``가 거짓(뉴스 탭)이면 수집 글·거장 견해에서
    온 줄을 뺍니다(그 글은 글 탭의 것 — 계약 §3-4).
    """
    def run() -> sources.Fetched:
        result = sources.cached(("watch", entity_key, owner), lambda: search_store.watch_items(entity_key, owner=owner),
                                external=True, refresh=refresh)
        if posts:
            return result
        return dataclasses.replace(result, items=[item for item in result.items if item.get("source") not in POST_SOURCES])

    return _Spec("watch", run=run)


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
        specs.append(_remote("bing", ("bing", tuple(ko), tuple(en)), lambda: sources.bing({"ko": ko, "en": en}), external, refresh))
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
        specs.append(_watch_spec(target["key"], owner=owner, refresh=refresh, posts=posts))
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


def _later_specs(tab: str, target: dict | None) -> list[_Spec]:
    if tab == "filings":
        return [_Spec("filings", status="later", message="공시 탭은 다음 단계에서 엽니다")]
    if tab == "research":
        return [_Spec("research", status="later", message="리서치 탭은 다음 단계에서 엽니다")]
    kind = (target or {}).get("kind")
    specs = []
    if kind in ("company", "institution", "person"):
        specs.append(_Spec("filings", status="later", message="공시 탭은 다음 단계에서 엽니다"))
    if kind == "company":
        specs.append(_Spec("research", status="later", message="리서치 탭은 다음 단계에서 엽니다"))
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


def feed(key: str, tab: str, *, owner: bool = False, external: bool = True, refresh: bool = False) -> dict:
    """
    탭 하나의 결과 — 오늘(KST)부터 2년 안의 줄 전부(최신순), 출처마다 상태 한 줄, 기간별 건수. 화면이 7일·30일·1년·2년으로 자릅니다.
    ``refresh``면 출처 캐시를 건너뜁니다(대상 풀기 캐시는 그대로 — 외부 호출을 끈 요청에서는 캐시만).
    """
    prefix, value = parse_key(key)
    tab = check_tab(tab)
    norm = f"{prefix}:{value}"
    now = datetime.now(timezone.utc)
    today = rules.kst_today(now)
    window_from, window_to = rules.window(today)
    start = rules.window_start(today)

    if tab in ("filings", "research"):
        specs = _later_specs(tab, None)
    else:
        target = entity(norm, external=external)["entity"]
        if target is None:
            note = "대상을 풀지 못해 묻지 않음"
            specs = []
            if tab in ("news", "timeline"):
                # 외부 호출을 끈 요청(데모·STORE_ONLY)이면 바깥 출처는 '대상을 못 풀어서'가 아니라 '부르지 않아서' — 상태 offline(계약 §3-4).
                specs += [_Spec(source, status="skipped" if external else "offline", message=note if external else OFFLINE)
                          for source in ("google_ko", "google_en", "bing")]
                specs.append(_Spec("event_news", status="skipped", message=note))
                specs.append(_Spec("feeds", status="skipped", message=note))
                # 관심 대상이 모은 글은 이름 없이 키로 읽습니다(등록 때 푼 대표 키 — 대상을 지금 풀지 못해도 모은 글은 보임).
                specs.append(_watch_spec(norm, owner=owner, refresh=refresh, posts=tab == "timeline"))
                specs.append(_Spec("wire", status="owner_only" if not owner else "skipped", message=None if not owner else note))
            if tab in ("posts", "timeline"):
                specs += [_Spec(source, status="owner_only" if not owner else "skipped", message=None if not owner else note)
                          for source in ("info", "guru")]
        else:
            specs = []
            if tab in ("news", "timeline"):
                specs += _news_specs(target, owner=owner, external=external, after=window_from, refresh=refresh,
                                     posts=tab == "timeline")
            if tab in ("posts", "timeline"):
                specs += _post_specs(target, owner=owner, refresh=refresh)
            if tab == "timeline":
                specs += _later_specs(tab, target)

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
        "items": merged,
        "sources": rows,
        "window": {"from": window_from, "to": window_to},
        "rangeCounts": rules.range_counts(merged, today),
        "olderOnlyLatest": max(latest_olds) if not merged and latest_olds else None,
        "pending": False,
        "fetchedAt": rules.utc_iso(now),
    }


def _merge_order(groups: dict[str, list[dict]]) -> list[list[dict]]:
    """합칠 순서(MERGE_PRIORITY) — 모은 글의 경유 주소(구글) 줄만은 맨 뒤로(구글 줄과 같은 낮은 우선순위, 같은 기사의 원문 주소 줄이 남게)."""
    ordered: list[list[dict]] = []
    relayed: list[dict] = []
    for source in MERGE_PRIORITY:
        kept = groups.get(source, [])
        if source == "watch":
            relayed = [item for item in kept if rules.is_relay(item.get("url"))]
            kept = [item for item in kept if not rules.is_relay(item.get("url"))]
        ordered.append(kept)
    ordered.append(relayed)
    return ordered


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
    excludes = search_store.user_excludes()
    kept_groups = []
    errors: dict[str, str] = {}
    for name, result in zip(names, groups):
        if result.error:
            errors[name] = result.error
        kept, _, _ = rules.apply_rules(result.items, start=start, now=now, excludes=excludes)
        kept_groups.append(kept)
    return {"items": rules.merge(kept_groups), "errors": errors, "fetchedAt": rules.utc_iso(now)}


def excludes() -> dict:
    """매체 제외 목록의 처음 값(묶음 이름과 함께)과 늘 적용하는 규칙 — 사용자가 더한 매체는 백엔드가 자기 표에서 붙입니다."""
    return {"seed": rules.seed_list(), "fixedRules": list(rules.FIXED_RULES)}
