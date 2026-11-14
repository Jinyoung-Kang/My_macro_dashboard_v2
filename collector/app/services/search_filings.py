"""
app/services/search_filings.py
정보 검색 공시 탭(ADR 0041 단계 4, 계약 docs/specs/2026-11-14-info-search-contract.md §7-1·§7-2) — 공식 API만 부릅니다(스크래핑 없음).

- ``sec``: SEC 회사별 공시 목록 ``data.sec.gov/submissions/CIK<10자리>.json`` 한 번(``SEC_USER_AGENT`` 세션과 토큰 버킷 — 13F·재무와 같음).
  ``filings.recent``의 줄을 모두 넘기고 2년 자르기는 규칙(search_rules)이 합니다(2년 밖 줄만 있으면 olderOnlyLatest가 생기게). 최근 블록의 가장
  오래된 접수일이 창 안이고 그 앞 파일(``filings.files``)이 있으면 안내 한 줄(더 부르지 않음).
- ``sec_fts``: EDGAR 전문 검색 ``efts.sec.gov/LATEST/search-index``(같은 세션) — 따옴표 구문 하나씩, 첫 구문이 0건이면 다음 구문 한 번(앞에
  ``before_retry``), 첫 쪽만. 받은 줄 없이 어느 구문이든 실패하면 실패(Bing과 같음 — 이름을 다 묻지 못한 것을 '없음'으로 보이지 않게).
  같은 접수의 여러 문서는 한 줄. 제출자 CIK가 없는 줄은 연결할 쪽이 없어 뺍니다.
- ``dart``: Open DART ``list.json``(``DART_API_KEY`` — publicapi의 키 처리) 첫 쪽(100건), ``total_page``가 1보다 크면 2쪽 한 번(최대 200건).
  status 013(자료 없음)은 빈 결과.
- SEC 두 출처의 줄 id는 ``info_text.item_id("sec:" + 접수번호)`` — 같은 접수가 두 출처에서 와도 한 줄(합칠 때 ``sec``가 먼저). DART 줄 id는 공시
  뷰어 주소의 ``info_text.item_id``.
- 시각(§7-1): DART 접수일·전문 검색 ``file_date``는 그 날짜의 그 출처 달력 00:00(DART = KST, SEC = 미국 동부)을 UTC로 바꾼 값과
  ``timeBasis: "date"``. SEC 회사별 목록의 ``acceptanceDateTime``은 꼬리의 ``Z`` 그대로 UTC입니다(서버 실측 2026-11-14 — ``…T13:52:41.000Z``가
  접수 색인 쪽의 'Accepted 08:52:41'(미국 동부 표준시)과 같은 순간). 없으면 접수일(``date``).
- 실패 사유는 호스트와 상태 코드만(검색어·경로·인자·키 없음). urllib3 재시도 경고가 경로와 인자(전문 검색의 이름)를 찍으므로 이 모듈이 다루는
  경로(SEC submissions·EDGAR 전문 검색·DART list.json·GLEIF)를 지우는 거름을 그 로거에 답니다.
- ``sec_unready``·``dart_unready``: 요청을 보내기 전에 설정(SEC_USER_AGENT·DART_API_KEY)을 미리 봄 — 관심 대상 수집이 보내지 않을 질의에
  하루 예산·간격을 쓰지 않게. 사유에 설정값을 싣지 않습니다.
- 파싱(``parse_*``)은 순수 함수라 시험이 합성 응답으로 봅니다. 이 결과는 모의 매매의 입력이 아닙니다.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from .. import http, publicapi, settings
from . import info_text
from . import search_rules as rules
from .search_sources import Fetched, feed_item, safe_reason

logger = logging.getLogger(__name__)

SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
EFTS_URL = "https://efts.sec.gov/LATEST/search-index"
DART_LIST_URL = "https://opendart.fss.or.kr/api/list.json"
SEC_INDEX_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{plain}/{accession}-index.htm"
DART_VIEWER_URL = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcept_no}"
SEC_HOST = http.host_of(SEC_SUBMISSIONS_URL)
EFTS_HOST = http.host_of(EFTS_URL)
DART_HOST = http.host_of(DART_LIST_URL)
SEC_DOMAIN = "sec.gov"
DART_DOMAIN = "dart.fss.or.kr"

KST = rules.KST
NEW_YORK = ZoneInfo("America/New_York")
SEC_TIMEOUT = (5, 15)            # (연결, 읽기) 초 — submissions는 큰 회사면 수백 KB
DART_TIMEOUT = 15.0
DART_PAGE_SIZE = 100
DART_MAX_PAGES = 2
FTS_MAX_PHRASES = 2
RECENT_NOTE = "최근 1,000건만 — 그 앞은 SEC에서"
UA_HINT = " — SEC_USER_AGENT에 본인 이메일을 넣으세요"
SEC_UNREADY = "SEC_USER_AGENT가 비어 있거나 올바르지 않아 SEC를 부르지 않음"
DART_UNREADY = "DART_API_KEY가 설정되지 않아 부르지 않음"
# 날짜만 아는 출처 — 모은 글(search_watch_items)에서 읽을 때 timeBasis를 'date'로 되살립니다(표에 시각 기준 칸이 없음).
DATE_SOURCES = frozenset({"sec_fts", "dart", "naver_research"})

_ACCESSION = re.compile(r"^\d{10}-\d{2}-\d{6}$")
_CIK = re.compile(r"^\d{1,10}$")
_RCEPT_NO = re.compile(r"^\d{14}$")
_ACCEPTED = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})")
_DAY = re.compile(r"^(\d{4})[-.]?(\d{2})[-.]?(\d{2})$")
_NAME_TAIL = re.compile(r"\s*\((?:CIK\s+\d+|[A-Z0-9.\-]+(?:\s*,\s*[A-Z0-9.\-]+)*)\)\s*$")


# ------------------------------------------------------------------ 로그에서 경로 지우기

_SCRUB = re.compile(r"/(?:LATEST/search-index|api/list\.json|api/v1/lei-records|submissions/CIK)\S*")


def _scrub(value: Any) -> Any:
    """로그 인자 하나에서 단계 4 경로(경로 + 인자)를 지웁니다 — 전문 검색 인자에는 사람·기관 이름이 듭니다."""
    if isinstance(value, str) and _SCRUB.search(value):
        return _SCRUB.sub("(검색 경로 생략)", value)
    return value


class _PathLogFilter(logging.Filter):
    """urllib3 재시도 경고(``Retrying (...) after ...: <경로?인자>``)에서 단계 4 출처의 경로·인자를 지웁니다."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(_scrub(arg) for arg in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: _scrub(arg) for key, arg in record.args.items()}
        record.msg = _scrub(record.msg)
        return True


def _install_log_filter() -> None:
    target = logging.getLogger("urllib3.connectionpool")
    if not any(isinstance(existing, _PathLogFilter) for existing in target.filters):
        target.addFilter(_PathLogFilter())


_install_log_filter()


# ------------------------------------------------------------------ 시각(§7-1)

def date_moment(value: Any, zone: ZoneInfo) -> datetime | None:
    """날짜('YYYY-MM-DD'·'YYYYMMDD'·'YYYY.MM.DD') → 그 날짜의 ``zone`` 달력 00:00. 읽지 못하면 None(지어내지 않음)."""
    if not isinstance(value, str):
        return None
    match = _DAY.match(value.strip())
    if not match:
        return None
    try:
        return datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)), tzinfo=zone)
    except ValueError:
        return None


def compact_day(day: str | date) -> str:
    """'YYYY-MM-DD' 또는 date → 'YYYYMMDD'(DART 기간 인자)."""
    return (day.isoformat() if isinstance(day, date) else str(day)).replace("-", "")


def _accepted(value: Any) -> datetime | None:
    """SEC ``acceptanceDateTime``('2026-11-12T18:08:27.000Z') → UTC 시각(꼬리의 Z 그대로 — 모듈 설명). 읽지 못하면 None."""
    match = _ACCEPTED.match(value.strip()) if isinstance(value, str) else None
    if not match:
        return None
    try:
        return datetime(*(int(part) for part in match.groups()), tzinfo=timezone.utc)
    except ValueError:
        return None


def stored_basis(source: str | None, published_at: datetime | None) -> str:
    """
    모은 글(search_watch_items) 줄의 시각 기준 — 표에 시각 기준 칸이 없어 출처로 되살립니다. 날짜만 아는 출처는 'date', SEC 회사별 목록은 접수
    시각이 없어 접수일로 넣은 줄(미국 동부 00:00:00)만 'date', 그 밖은 'published'.
    """
    if published_at is None:
        return "published"
    if source in DATE_SOURCES:
        return "date"
    if source == "sec":
        local = published_at.astimezone(NEW_YORK)
        return "date" if (local.hour, local.minute, local.second) == (0, 0, 0) else "published"
    return "published"


# ------------------------------------------------------------------ 줄 만들기(순수 함수)

def sec_item_id(accession: str) -> str:
    """SEC 두 출처가 같이 쓰는 줄 id — 접수번호의 해시(쪽 주소가 아니라 접수번호)."""
    return info_text.item_id("sec:" + accession)


def sec_index_url(cik: Any, accession: str) -> str | None:
    """접수 색인 쪽 주소 — CIK 숫자(앞의 0 없음)와 접수번호. 모양이 틀리면 None."""
    text = str(cik or "").strip()
    if not _CIK.match(text) or not _ACCESSION.match(accession) or int(text) == 0:
        return None
    return SEC_INDEX_URL.format(cik=int(text), plain=accession.replace("-", ""), accession=accession)


def _text(value: Any) -> str | None:
    text = " ".join(str(value).split()) if isinstance(value, str) else ""
    return text or None


def _column(recent: dict, name: str, index: int) -> Any:
    values = recent.get(name)
    return values[index] if isinstance(values, list) and index < len(values) else None


def parse_submissions(payload: Any, *, cik: str, start_day: str) -> tuple[list[dict], str | None]:
    """
    SEC submissions → (줄, 안내). 줄은 ``filings.recent`` 전부(2년 자르기는 규칙이 함). 안내는 최근 블록의 가장 오래된 접수일이 창 안(``start_day``
    이후)이고 그 앞 파일이 따로 있을 때만.
    """
    if not isinstance(payload, dict):
        return [], None
    filings_block = payload.get("filings") if isinstance(payload.get("filings"), dict) else {}
    recent = filings_block.get("recent") if isinstance(filings_block.get("recent"), dict) else {}
    publisher = _text(payload.get("name"))
    accessions = recent.get("accessionNumber") if isinstance(recent.get("accessionNumber"), list) else []
    items: list[dict] = []
    days: list[str] = []
    for index, accession in enumerate(accessions):
        filed = _column(recent, "filingDate", index)
        if isinstance(filed, str) and _DAY.match(filed):
            days.append(filed)
        if not isinstance(accession, str) or not _ACCESSION.match(accession.strip()):
            continue
        accession = accession.strip()
        url = sec_index_url(cik, accession)
        form = _text(_column(recent, "form", index)) or "공시"
        described = _text(_column(recent, "primaryDocDescription", index))
        title = form if not described or described.casefold() == form.casefold() else f"{form} · {described}"
        moment, basis = _accepted(_column(recent, "acceptanceDateTime", index)), "published"
        if moment is None:
            moment, basis = date_moment(filed, NEW_YORK), "date"
        report = _text(_column(recent, "reportDate", index))
        items.append(feed_item(title=title, url=url, publisher=publisher, domain=SEC_DOMAIN, published=moment, basis=basis,
                               source="sec", lang="en", kind="filing",
                               summary=f"보고 기준일 {report}" if report else None, item_id=sec_item_id(accession)))
    older_files = filings_block.get("files")
    note = RECENT_NOTE if days and older_files and min(days) >= start_day else None
    return items, note


def clean_filer_name(text: Any) -> str | None:
    """전문 검색의 제출자 이름('NAME  (TICK, TICK-W)  (CIK 0001234567)') → 꼬리의 CIK·티커 괄호를 뗀 이름."""
    name = _text(text)
    while name:
        trimmed = _NAME_TAIL.sub("", name).strip()
        if trimmed == name:
            break
        name = trimmed
    return name or None


def parse_fts(payload: Any) -> tuple[list[dict], int | None, bool]:
    """
    EDGAR 전문 검색 → (줄, 전체 건수(모르면 None), 전체가 '그 이상'인지). 같은 접수의 문서 여럿은 첫 문서 한 줄. 제출자 CIK가 없는 줄(연결할 쪽이
    없음)과 접수번호 모양이 틀린 줄은 뺍니다.
    """
    hits_block = payload.get("hits") if isinstance(payload, dict) and isinstance(payload.get("hits"), dict) else {}
    total_block = hits_block.get("total") if isinstance(hits_block.get("total"), dict) else {}
    total = total_block.get("value") if isinstance(total_block.get("value"), int) and not isinstance(total_block.get("value"), bool) \
        else None
    at_least = total_block.get("relation") == "gte"
    items: list[dict] = []
    seen: set[str] = set()
    for hit in hits_block.get("hits") if isinstance(hits_block.get("hits"), list) else []:
        source = hit.get("_source") if isinstance(hit, dict) and isinstance(hit.get("_source"), dict) else None
        if source is None:
            continue
        accession = source.get("adsh") if isinstance(source.get("adsh"), str) else str(hit.get("_id") or "").split(":", 1)[0]
        accession = accession.strip()
        if not _ACCESSION.match(accession) or accession in seen:
            continue
        ciks = [str(cik).strip() for cik in source.get("ciks") or [] if str(cik or "").strip()]
        url = sec_index_url(ciks[0], accession) if ciks else None
        if url is None:
            continue
        seen.add(accession)
        names = source.get("display_names") if isinstance(source.get("display_names"), list) else []
        filer = clean_filer_name(names[0]) if names else None
        roots = source.get("root_forms") if isinstance(source.get("root_forms"), list) else []
        form = _text(source.get("form")) or (_text(roots[0]) if roots else None) or "공시"
        items.append(feed_item(title=f"{form} · {filer}" if filer else form, url=url, publisher=filer, domain=SEC_DOMAIN,
                               published=date_moment(source.get("file_date"), NEW_YORK), basis="date", source="sec_fts",
                               lang="en", kind="filing", summary=_text(source.get("file_description")),
                               item_id=sec_item_id(accession)))
    return items, total, at_least


def parse_dart(payload: Any) -> tuple[list[dict], int | None, int | None]:
    """DART list.json(정상 봉투) → (줄, 전체 건수, 전체 쪽 수). 접수번호 모양이 틀린 줄은 뺍니다."""
    if not isinstance(payload, dict):
        return [], None, None
    items: list[dict] = []
    for row in payload.get("list") if isinstance(payload.get("list"), list) else []:
        if not isinstance(row, dict):
            continue
        rcept_no = str(row.get("rcept_no") or "").strip()
        title = _text(row.get("report_nm"))
        if not _RCEPT_NO.match(rcept_no) or not title:
            continue
        remark = _text(row.get("rm"))
        items.append(feed_item(title=title, url=DART_VIEWER_URL.format(rcept_no=rcept_no), publisher=_text(row.get("flr_nm")),
                               domain=DART_DOMAIN, published=date_moment(row.get("rcept_dt"), KST), basis="date", source="dart",
                               lang="ko", kind="filing", summary=f"비고 {remark}" if remark else None))
    return items, _count(payload.get("total_count")), _count(payload.get("total_page"))


def _count(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


# ------------------------------------------------------------------ 설정 미리 보기

def sec_unready() -> str | None:
    """SEC를 부를 수 없는 설정이면 그 사유(SEC_USER_AGENT가 비었거나 틀림 — 설정값은 싣지 않음), 부를 수 있으면 None. 요청을 보내지 않습니다."""
    try:
        http.sec_user_agent()
    except http.SecUserAgentInvalid:
        return SEC_UNREADY
    return None


def dart_unready() -> str | None:
    """DART를 부를 수 없는 설정이면(DART_API_KEY 없음) 그 사유, 부를 수 있으면 None."""
    key = settings.dart_key()
    return None if key and key.strip() else DART_UNREADY


# ------------------------------------------------------------------ 부르기 — SEC

def _sec_json(url: str, params: dict | None, session) -> tuple[Any, str | None, int | None]:
    """SEC 한 번(``SEC_USER_AGENT`` 세션·토큰 버킷) → (JSON, 실패 사유, 상태 코드). 사유는 호스트와 상태만."""
    host = http.host_of(url)
    if session is None:
        try:
            session = http.get_sec_session()
        except http.SecUserAgentInvalid:
            return None, SEC_UNREADY, None
    try:
        http.sec_rate_limit()
        res = session.get(url, params=params, timeout=SEC_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — 출처 하나의 실패(거부 래치는 그 한 줄 그대로)
        return None, safe_reason(exc, host), None
    status = getattr(res, "status_code", None)
    if status != 200:
        return None, f"{host} HTTP {status}" + (UA_HINT if status == 403 else ""), status
    try:
        payload = res.json()
    except ValueError:
        return None, f"{host} 응답이 JSON이 아님", status
    if not isinstance(payload, dict):
        return None, f"{host} 응답 모양이 다름", status
    return payload, None, status


def sec_submissions(cik: str, *, start_day: str, session=None) -> Fetched:
    """SEC 회사별 공시 목록 한 번(CIK 10자리). 404(그 CIK의 목록 없음)는 빈 결과와 안내."""
    padded = str(cik).strip().zfill(10)
    payload, error, status = _sec_json(SEC_SUBMISSIONS_URL.format(cik=padded), None, session)
    if status == 404:
        return Fetched(note="SEC에 이 CIK의 공시 목록이 없음")
    if error:
        return Fetched(error=error)
    items, note = parse_submissions(payload, cik=padded, start_day=start_day)
    return Fetched(items=items, note=note)


def sec_fts(phrases: list[str], *, start_day: str, end_day: str, max_phrases: int = FTS_MAX_PHRASES,
            before_retry: Callable[[], bool] | None = None, session=None) -> Fetched:
    """
    EDGAR 전문 검색 — 따옴표 구문(``search_sources.bing_queries``가 만든 것) 하나씩, 첫 구문이 0건이면 다음 구문(최대 ``max_phrases``개). 두 번째
    구문 앞에 ``before_retry``가 있으면 부르고 거짓이면 묻지 않습니다(관심 대상 수집의 예산·간격). 첫 쪽만 받습니다. 받은 줄이 없는 채 구문이
    실패하면(첫 구문이든 0건 뒤의 다음 구문이든) 실패 — 출처 캐시가 60초만 두고 상태가 '빈 결과'가 아니라 '실패'(Bing과 같음).
    """
    asked = [phrase for phrase in phrases if phrase and phrase.strip()][:max(max_phrases, 0)]
    for index, phrase in enumerate(asked):
        if index and before_retry is not None and not before_retry():
            break
        payload, error, _ = _sec_json(EFTS_URL, {"q": phrase, "dateRange": "custom", "startdt": start_day, "enddt": end_day},
                                      session)
        if error:
            return Fetched(error=error)
        items, total, at_least = parse_fts(payload)
        if items:
            raw = len(((payload.get("hits") or {}).get("hits")) or [])
            more = total is not None and (total > raw or at_least)
            note = f"첫 쪽만 받음(전체 {total:,}건{' 이상' if at_least else ''} — 나머지는 SEC에서)" if more else None
            return Fetched(items=items, note=note)
    return Fetched()


# ------------------------------------------------------------------ 부르기 — DART

def _dart_page(corp_code: str, start_day: str, end_day: str, page: int, key: str) -> tuple[dict | None, str | None]:
    """DART list.json 한 쪽 → (봉투, 실패 사유). 013(자료 없음)은 빈 봉투. 사유에 키·주소를 싣지 않습니다."""
    params = {"corp_code": corp_code, "bgn_de": compact_day(start_day), "end_de": compact_day(end_day), "sort": "date",
              "sort_mth": "desc", "page_count": str(DART_PAGE_SIZE), "page_no": str(page)}
    try:
        res = publicapi.get(DART_LIST_URL, params, key=key, key_param="crtfc_key", timeout=DART_TIMEOUT)
    except publicapi.PublicApiError:
        return None, f"{DART_HOST} 연결·응답 실패"
    status = getattr(res, "status_code", None)
    if status != 200:
        return None, f"{DART_HOST} HTTP {status}"
    try:
        body = res.json()
    except ValueError:
        return None, f"{DART_HOST} 응답이 JSON이 아님"
    if not isinstance(body, dict):
        return None, f"{DART_HOST} 응답 모양이 다름"
    code = str(body.get("status") or "")
    if code == "000":
        return body, None
    if code == "013":
        return {"list": [], "total_count": 0, "total_page": 0}, None
    message = publicapi.scrub(" ".join(str(body.get("message") or "").split())[:80], key)
    return None, f"{DART_HOST} status {code or '?'}" + (f" {message}" if message else "")


def dart_list(corp_code: str, *, start_day: str, end_day: str, max_pages: int = DART_MAX_PAGES) -> Fetched:
    """DART 공시 목록 — 창(``start_day``~``end_day``, KST 날짜) 최신순 첫 쪽, ``total_page``가 1보다 크면 다음 쪽(최대 ``max_pages``쪽)."""
    unready = dart_unready()
    if unready:
        return Fetched(error=unready)
    key = settings.dart_key()
    first, error = _dart_page(corp_code, start_day, end_day, 1, key)
    if error:
        return Fetched(error=error)
    items, total, pages = parse_dart(first)
    notes: list[str] = []
    page = 1
    while pages is not None and page < min(pages, max_pages):
        page += 1
        more, error = _dart_page(corp_code, start_day, end_day, page, key)
        if error:
            notes.append(f"{page}쪽을 받지 못함({error})")
            break
        items += parse_dart(more)[0]
    if total is not None and total > len(items):
        notes.insert(0, f"최근 {len(items)}건(전체 {total:,}건 — 그 앞은 DART에서)")
    return Fetched(items=items, note="; ".join(notes) or None)
