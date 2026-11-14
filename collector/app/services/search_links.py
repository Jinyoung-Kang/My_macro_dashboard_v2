"""
app/services/search_links.py
정보 검색 연결 보강(ADR 0041 단계 4, 계약 docs/specs/2026-11-14-info-search-contract.md §7-5) — 대상 풀기(3-3, 하루 캐시·15초 상한)를 무겁게
하지 않으려고 따로 부르는 연결 탭 전용 출처. 화면은 3-3의 ``links``(Wikidata·13F)와 이 응답을 합쳐 보입니다.

- ``insiders``: 미국 상장 회사의 내부자 명단 — yfinance ``Ticker(t).insider_roster_holders``(서버 실측 2026-11-14: 임원 목록 ``companyOfficers``는
  0건이라 명단으로 대신). 공용 거부 래치(``http.YAHOO_HOST``)·무응답 래치를 먼저 봅니다. → ``relation: "insider"``, ``kind: "person"``, ``key: null``,
  ``detail`` = 직위 + ' · 최근 <거래> <날짜>'.
- ``gleif``: 법인 관계 — Wikidata ``P1278``에서 얻은 LEI로만(이름 검색은 해외 자회사가 먼저 나와 쓰지 않음 — 진행 기록 단계 0). ``direct-parent``·
  ``ultimate-parent``(404 = 관계 없음 — 오류 아님)·``direct-children?page[size]=20``. 연락처 없는 일반 이름 User-Agent(Wikidata와 같음), 요청 사이
  MIN_INTERVAL초. → ``relation`` ``parent``·``ultimate_parent``·``subsidiary``, ``kind: "company"``, ``key: null``, ``detail`` = 소재지 + ' · LEI <lei>'.
- 캐시: 내부자 15분, GLEIF 하루, 실패(일부 실패·받지 못했을 수도 있는 빈 내부자 명단 포함)는 60초. 외부 호출을 끈 요청은 캐시만(없으면 ``offline``). 같은 키를 부르는 중이면 기다림.
- 실패 사유는 호스트와 상태만(LEI·경로 없음 — urllib3 재시도 경고의 경로는 search_filings의 거름이 지움). 이 결과는 모의 매매의 입력이 아닙니다.
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from .. import http, yahoo
from . import search_filings  # noqa: F401 — urllib3 재시도 경고에서 GLEIF 경로를 지우는 거름을 답니다
from .search_sources import Fetched, safe_reason
from .search_wikidata import USER_AGENT

GLEIF_API = "https://api.gleif.org/api/v1/lei-records"
GLEIF_HOST = http.host_of(GLEIF_API)
GLEIF_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/vnd.api+json"}
GLEIF_TIMEOUT = (5, 10)
GLEIF_MIN_INTERVAL = 1.0
CHILDREN_PAGE_SIZE = 20
INSIDERS_TTL = 900.0
GLEIF_TTL = 86_400.0
FAILURE_TTL = 60.0
INFLIGHT_WAIT = 45.0
_CACHE_LIMIT = 500
LEI_PATTERN = re.compile(r"^[A-Z0-9]{18}[0-9]{2}$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}")


@dataclass
class Linked(Fetched):
    """연결 출처 한 곳의 결과 — ``items``는 Link 줄. ``partial``이면 일부 요청이 실패했거나 받지 못했을 수도 있는 결과(짧게 캐시)."""
    partial: bool = False


# ------------------------------------------------------------------ 캐시

_cache: dict[tuple, tuple[float, Linked]] = {}
_inflight: dict[tuple, threading.Event] = {}
_cache_lock = threading.Lock()


def _hit(key: tuple) -> Linked | None:
    with _cache_lock:
        hit = _cache.get(key)
    if hit is None or hit[0] <= time.monotonic():
        return None
    value = hit[1]
    return Linked(items=list(value.items), error=value.error, note=value.note, cached=True, partial=value.partial)


def cached(key: tuple, fetch: Callable[[], Linked], *, ttl: float, external: bool = True) -> Linked:
    """
    출처별 캐시 — 성공 ``ttl``, 실패·일부 실패 FAILURE_TTL. ``external``이 거짓이면 캐시만(없으면 ``offline``). 같은 키를 부르는 중이면 그 결과를
    기다립니다(INFLIGHT_WAIT까지).
    """
    hit = _hit(key)
    if hit is not None:
        return hit
    if not external:
        return Linked(offline=True)
    with _cache_lock:
        running = _inflight.get(key)
        if running is None:
            _inflight[key] = threading.Event()
    if running is not None:
        running.wait(INFLIGHT_WAIT)
        return _hit(key) or Linked(error="같은 출처를 부르는 중 — 잠시 뒤 다시")
    try:
        value = fetch()
        life = FAILURE_TTL if value.error or value.partial else ttl
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
    """시험용 — 연결 출처 캐시를 비웁니다."""
    with _cache_lock:
        _cache.clear()


# ------------------------------------------------------------------ Yahoo 내부자 명단

def _ticker(symbol: str):
    """시험이 바꿔 끼우는 자리 — yfinance Ticker."""
    return yf.Ticker(symbol)


def _clean(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text if text and text.casefold() not in ("nan", "none", "nat") else None


def _day(value: Any) -> str | None:
    """거래 날짜(pandas Timestamp·datetime·ISO 글) → 'YYYY-MM-DD'. NaT·모름은 None."""
    if isinstance(value, datetime):
        if value != value:          # NaT
            return None
        try:
            return value.date().isoformat()
        except (ValueError, AttributeError):
            return None
    if isinstance(value, str) and _DAY.match(value.strip()):
        return value.strip()[:10]
    return None


def roster_rows(frame: Any) -> list[dict]:
    """yfinance ``insider_roster_holders`` 표 → 줄 사전 목록. 표가 아니거나 비었으면 빈 목록."""
    if frame is None or not hasattr(frame, "to_dict") or getattr(frame, "empty", True):
        return []
    return frame.to_dict("records")


def insider_links(rows: list[dict]) -> list[dict]:
    """내부자 명단 줄 → Link(계약 §7-5). 이름이 없는 줄은 뺍니다."""
    out = []
    for row in rows:
        name = _clean(row.get("Name"))
        if not name:
            continue
        recent = " ".join(part for part in (_clean(row.get("Most Recent Transaction")), _day(row.get("Latest Transaction Date")))
                          if part)
        detail = " · ".join(part for part in (_clean(row.get("Position")), f"최근 {recent}" if recent else None) if part)
        out.append({"relation": "insider", "key": None, "name": name, "kind": "person", "source": "yahoo",
                    "detail": detail or None})
    return out


def insiders(ticker: str) -> Linked:
    """미국 상장 회사의 내부자 명단(yfinance) — 래치가 닫혀 있으면 부르지 않습니다."""
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return Linked(error=str(latched))
    closed = yahoo.unavailable_reason()
    if closed:
        return Linked(error=closed)
    symbol = ticker.upper().replace(".", "-")
    try:
        frame = _ticker(symbol).insider_roster_holders
    except YFRateLimitError:
        return Linked(error=str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")))
    except Exception as exc:  # noqa: BLE001 — 출처 하나의 실패
        return Linked(error=safe_reason(exc, http.YAHOO_HOST))
    rows = roster_rows(frame)
    if not rows:
        # yfinance는 HTTP 오류도 빈 표로 돌려줘 '명단 없음'과 가를 수 없습니다 — 무응답 래치가 닫혔으면 그 사유, 아니면 빈 결과와 안내.
        # 명단이 정말 없는 회사(작은 회사 등)도 있어 실패로 보이지는 않되, 일시 실패가 15분 동안 '없음'으로 남지 않게 60초만 캐시(partial).
        closed = yahoo.unavailable_reason()
        return Linked(error=closed) if closed else Linked(note="Yahoo가 내부자 명단을 주지 않음(받지 못했을 수도 있음)",
                                                          partial=True)
    return Linked(items=insider_links(rows))


# ------------------------------------------------------------------ GLEIF

def gleif_link(record: Any, relation: str) -> dict | None:
    """GLEIF lei-record 하나 → Link. 법인 이름이나 LEI가 없으면 None."""
    attributes = record.get("attributes") if isinstance(record, dict) and isinstance(record.get("attributes"), dict) else {}
    entity = attributes.get("entity") if isinstance(attributes.get("entity"), dict) else {}
    legal = entity.get("legalName") if isinstance(entity.get("legalName"), dict) else {}
    name = _clean(legal.get("name"))
    lei = str(attributes.get("lei") or record.get("id") or "").strip().upper() if isinstance(record, dict) else ""
    if not name or not LEI_PATTERN.match(lei):
        return None
    address = entity.get("legalAddress") if isinstance(entity.get("legalAddress"), dict) else {}
    country = _clean(address.get("country"))
    return {"relation": relation, "key": None, "name": name, "kind": "company", "source": "gleif",
            "detail": f"{country} · LEI {lei}" if country else f"LEI {lei}"}


def _gleif_get(url: str, session) -> tuple[Any, str | None]:
    """GLEIF 한 번 → (JSON 또는 None(404 — 관계 없음), 실패 사유). 사유는 호스트와 상태만."""
    http.pace(GLEIF_HOST, GLEIF_MIN_INTERVAL)
    try:
        res = (session if session is not None else http.get_session()).get(url, timeout=GLEIF_TIMEOUT, headers=GLEIF_HEADERS)
    except Exception as exc:  # noqa: BLE001
        return None, safe_reason(exc, GLEIF_HOST)
    if res.status_code == 404:
        return None, None
    if res.status_code != 200:
        return None, f"{GLEIF_HOST} HTTP {res.status_code}"
    try:
        payload = res.json()
    except ValueError:
        return None, f"{GLEIF_HOST} 응답이 JSON이 아님"
    if not isinstance(payload, dict):
        return None, f"{GLEIF_HOST} 응답 모양이 다름"
    return payload, None


def gleif(lei: str, *, session=None) -> Linked:
    """LEI의 모회사·최상위 모회사·자회사(20곳까지). 셋 다 실패하면 실패, 일부만 실패하면 받은 것과 안내(짧게 캐시)."""
    base = f"{GLEIF_API}/{lei}"
    links: list[dict] = []
    failures: list[str] = []
    notes: list[str] = []
    for relation, path in (("parent", "direct-parent"), ("ultimate_parent", "ultimate-parent")):
        payload, error = _gleif_get(f"{base}/{path}", session)
        if error:
            failures.append(error)
            continue
        link = gleif_link((payload or {}).get("data"), relation)
        if link is not None:
            links.append(link)
    # 대괄호 인자는 주소에 그대로 둡니다(requests는 '[' ']'를 다시 인코딩하지 않음 — 계약의 모양 그대로).
    payload, error = _gleif_get(f"{base}/direct-children?page[size]={CHILDREN_PAGE_SIZE}", session)
    if error:
        failures.append(error)
    elif payload is not None:
        rows = payload.get("data") if isinstance(payload.get("data"), list) else []
        children = [link for link in (gleif_link(row, "subsidiary") for row in rows) if link is not None]
        links += children
        pagination = ((payload.get("meta") or {}).get("pagination") or {}) if isinstance(payload.get("meta"), dict) else {}
        total = pagination.get("total") if isinstance(pagination, dict) else None
        if isinstance(total, int) and not isinstance(total, bool) and total > len(rows):
            notes.append(f"자회사 {CHILDREN_PAGE_SIZE}곳까지(전체 {total:,}곳)")
    if failures and len(failures) == 3:
        return Linked(error="; ".join(dict.fromkeys(failures)))
    if failures:
        notes.append(f"일부 받지 못함({'; '.join(dict.fromkeys(failures))})")
    return Linked(items=links, note="; ".join(notes) or None, partial=bool(failures))
