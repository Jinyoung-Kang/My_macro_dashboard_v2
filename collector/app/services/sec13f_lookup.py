"""
app/services/sec13f_lookup.py
13F 즐겨찾기 기관(ADR 0048)을 더할 때 쓰는 SEC 조회 둘 — 사용자가 '찾기'·'더하기'를 눌렀을 때만 부릅니다(입력마다 부르지 않음).

- :func:`search_filers` 이름 → 13F-HR을 낸 적이 있는 기관 후보(EDGAR 회사 검색 ``browse-edgar?company=…&type=13F-HR&output=atom`` 한 번).
  2026-11-23 실제 응답으로 확인: 회사 이름 앞부분 일치(옛 이름 포함)이고 ``type=13F-HR``이 13F-HR 제출자만 남깁니다(baupost 2곳 — 전체 개체 색인은 16곳,
  pershing square 2곳, berkshire 6곳, 없는 이름은 entry 0개의 빈 피드). 한 번에 최대 :data:`SEARCH_COUNT`곳.
- :func:`filer_info` CIK → SEC 등록 이름과 가장 최근 원본 13F-HR 공시(SEC submissions JSON 한 번 — ``filings.recent``만 봄).

SEC 예절: 기존 토큰 버킷(:func:`http.sec_rate_limit`)과 User-Agent 세션(:func:`http.get_sec_session`)만 씁니다. 실패 사유에는 호스트와 상태만 싣습니다.
"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
import xml.etree.ElementTree as ET
from typing import Any

from .. import http
from . import search_filings

logger = logging.getLogger(__name__)

EDGAR_BROWSE = "https://www.sec.gov/cgi-bin/browse-edgar"
SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
TIMEOUT = (5, 20)            # (연결, 읽기) 초
SEARCH_COUNT = 40            # 회사 검색 한 쪽의 행 수(browse-edgar count — 첫 쪽만)
CANDIDATE_MAX = 20           # 돌려주는 후보 수 상한(앞부분 일치 먼저, 그다음 낱말 일치)
_BUCKET_CIK = re.compile(r"\(CIK\s+(\d{1,10})\)\s*$")
QUERY_MAX = 60               # 이름 검색어 상한(글자)
CIK_PATTERN = re.compile(r"^\d{1,10}$")
UNREADY = "SEC_USER_AGENT가 설정되지 않아 SEC를 부르지 않았습니다"


def normalize_cik(raw: Any) -> str | None:
    """숫자 1~10자리 → 10자리 CIK, 그 밖은 None."""
    text = str(raw or "").strip()
    return text.zfill(10) if CIK_PATTERN.match(text) and int(text) > 0 else None


NOT_ENGLISH = "SEC 등록 이름은 영문입니다 — 영문 이름 앞부분이나 CIK로 찾으세요"


def clean_query(raw: Any) -> str | None:
    """
    이름 검색어 — 앞뒤 공백을 떼고 연속 공백을 하나로, 2~60자의 영문(ASCII 인쇄 글자)만(그 밖은 None). SEC 등록 이름은 영문뿐이고, 한글을 보내면 SEC가
    47초쯤 뒤 503을 돌려줬습니다(QA-983 — 2026-11-23 서버 재현).
    """
    text = " ".join(str(raw or "").split())
    if not (2 <= len(text) <= QUERY_MAX) or not all(" " <= ch <= "~" for ch in text):
        return None
    return text


def _get(url: str, params: dict | None):
    """SEC GET 한 번 → (응답, 실패 사유). 사유는 호스트·상태만."""
    host = http.host_of(url)
    try:
        session = http.get_sec_session()
    except http.SecUserAgentInvalid:
        return None, UNREADY
    try:
        http.sec_rate_limit()
        res = session.get(url, params=params, timeout=TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — 사유만 돌려줍니다
        return None, f"{host} 연결 실패({type(exc).__name__})"
    status = getattr(res, "status_code", None)
    if status != 200:
        return None, f"{host} HTTP {status}"
    return res, None


def _local(tag: str) -> str:
    """XML 요소 이름에서 이름공간을 뗀 부분('{…}entry' → 'entry') — atom 이름공간 주소를 코드에 적지 않으려고 이름으로만 찾습니다."""
    return tag.rsplit("}", 1)[-1]


def _child(node: ET.Element | None, name: str) -> ET.Element | None:
    return next((child for child in node if _local(child.tag) == name), None) if node is not None else None


def _text_of(node: ET.Element | None, name: str) -> str | None:
    child = _child(node, name)
    return child.text if child is not None else None


def parse_company_atom(content: bytes | str) -> list[dict]:
    """EDGAR 회사 검색 atom → [{cik, name}](응답 차례, CIK가 겹치면 처음 것). 모양이 다르면 빈 목록."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for entry in (child for child in root if _local(child.tag) == "entry"):
        info = _child(_child(entry, "content"), "company-info")
        cik = normalize_cik(_text_of(info, "cik"))
        name = " ".join((_text_of(info, "name") or _text_of(entry, "title") or "").split())
        if cik is None or not name or cik in seen:
            continue
        seen.add(cik)
        out.append({"cik": cik, "name": name})
    return out


def parse_fts_filers(payload: Any) -> list[dict]:
    """
    EDGAR 전문 검색의 제출자 묶음(``aggregations.entity_filter.buckets`` — 'NAME  (TICK)  (CIK 0001234567)', 공시 수 차례) → [{cik, name}].
    ``entityName``으로 거른 13F-HR 검색이면 이름 어디에든 그 낱말이 든 제출자(옛 이름으로 낸 제출자 포함)입니다. 모양이 다르면 빈 목록.
    """
    aggregations = payload.get("aggregations") if isinstance(payload, dict) else None
    entity = aggregations.get("entity_filter") if isinstance(aggregations, dict) else None
    buckets = entity.get("buckets") if isinstance(entity, dict) else None
    out: list[dict] = []
    seen: set[str] = set()
    for bucket in buckets if isinstance(buckets, list) else []:
        key = bucket.get("key") if isinstance(bucket, dict) else None
        match = _BUCKET_CIK.search(key) if isinstance(key, str) else None
        cik = normalize_cik(match.group(1)) if match else None
        name = search_filings.clean_filer_name(key)
        if cik is None or not name or cik in seen:
            continue
        seen.add(cik)
        out.append({"cik": cik, "name": " ".join(name.split())})
    return out


def search_filers(query: str) -> dict:
    """
    이름 → {query, candidates: [{cik, name}], error}. 검색어가 맞지 않으면 SEC를 부르지 않고 error.

    SEC 두 번(QA-985 — 2026-11-23 실제 응답으로 확인): ① EDGAR 회사 검색(``type=13F-HR`` — 지금·옛 등록 이름의 앞부분 일치, 13F-HR 제출자만),
    ② EDGAR 전문 검색의 제출자 묶음(``entityName`` + ``forms=13F-HR`` — 이름 가운데 낱말도, 'greenlight' → 옛 제출자 GREENLIGHT CAPITAL INC,
    'square' → Pershing Square 등). 앞부분 일치 먼저, 그다음 공시 수 차례로 합쳐 CIK가 겹치면 하나, 최대 :data:`CANDIDATE_MAX`곳.
    둘 다 실패할 때만 error(하나만 실패하면 나머지로 답함).
    """
    text = clean_query(query)
    if text is None:
        cleaned = " ".join(str(query or "").split())
        if 2 <= len(cleaned) <= QUERY_MAX:
            return {"query": query, "candidates": [], "error": NOT_ENGLISH}
        return {"query": query, "candidates": [], "error": f"검색어는 2~{QUERY_MAX}자입니다"}
    res, error = _get(EDGAR_BROWSE, {"action": "getcompany", "company": text, "type": "13F-HR", "dateb": "",
                                      "owner": "include", "count": SEARCH_COUNT, "output": "atom"})
    prefix = parse_company_atom(res.content) if res is not None else []
    fts, fts_error = _get(search_filings.EFTS_URL, {"q": "", "entityName": text, "forms": "13F-HR"})
    words: list[dict] = []
    if fts is not None:
        try:
            words = parse_fts_filers(fts.json())
        except ValueError:
            fts_error = "efts.sec.gov 응답이 JSON이 아님"
    if error and fts_error:
        return {"query": text, "candidates": [], "error": error}
    merged: list[dict] = []
    seen: set[str] = set()
    for row in prefix + words:
        if row["cik"] not in seen:
            seen.add(row["cik"])
            merged.append(row)
    return {"query": text, "candidates": with_latest_13f(merged[:CANDIDATE_MAX]), "error": None}


NO_LIST = "이 CIK의 SEC 공시 목록이 없습니다"


def with_latest_13f(candidates: list[dict]) -> list[dict]:
    """
    후보마다 가장 최근 원본 13F-HR 공시(``latest13F`` — SEC submissions 한 번씩, QA-986)와 확인했는지(``checked``). 최근 공시 목록에 13F-HR이 없거나
    목록 자체가 없으면(404) ``latest13F=None, checked=True``, SEC를 부르지 못했으면 ``checked=False``. 넷씩 함께 부르되 SEC 속도는 공용 토큰 버킷이
    지킵니다(초당 8건 — 20곳이면 3초 안팎).
    """
    def one(row: dict) -> dict:
        info = filer_info(row["cik"])
        checked = info["error"] is None or info["error"] == NO_LIST
        return {**row, "latest13F": info["latest13F"] if checked else None, "checked": checked}

    if not candidates:
        return []
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, candidates))


def parse_submissions_13f(payload: Any) -> dict:
    """submissions JSON → {name, latest13F: {filingDate, reportDate} | None, olderFiles}. 원본 13F-HR만(정정 13F-HR/A·13F-NT 빼고)."""
    if not isinstance(payload, dict):
        return {"name": None, "latest13F": None, "olderFiles": False}
    name = " ".join(str(payload.get("name") or "").split()) or None
    filings = payload.get("filings") if isinstance(payload.get("filings"), dict) else {}
    recent = filings.get("recent") if isinstance(filings.get("recent"), dict) else {}
    forms = recent.get("form") if isinstance(recent.get("form"), list) else []
    dates = recent.get("filingDate") if isinstance(recent.get("filingDate"), list) else []
    reports = recent.get("reportDate") if isinstance(recent.get("reportDate"), list) else []
    latest = None
    for index, form in enumerate(forms):
        if form != "13F-HR":
            continue
        filed = dates[index] if index < len(dates) else None
        if not isinstance(filed, str):
            continue
        if latest is None or filed > latest["filingDate"]:
            report = reports[index] if index < len(reports) else None
            latest = {"filingDate": filed, "reportDate": report if isinstance(report, str) and report else None}
    return {"name": name, "latest13F": latest, "olderFiles": bool(filings.get("files"))}


def filer_info(cik: str) -> dict:
    """CIK → {cik, name, latest13F, error}. SEC에 목록이 없으면(404) error '이 CIK의 SEC 공시 목록이 없습니다'."""
    padded = normalize_cik(cik)
    if padded is None:
        return {"cik": cik, "name": None, "latest13F": None, "error": "CIK는 숫자 1~10자리입니다"}
    res, error = _get(SEC_SUBMISSIONS_URL.format(cik=padded), None)
    if error:
        if error.endswith("HTTP 404"):
            error = NO_LIST
        return {"cik": padded, "name": None, "latest13F": None, "error": error}
    try:
        payload = res.json()
    except ValueError:
        return {"cik": padded, "name": None, "latest13F": None, "error": "SEC 응답이 JSON이 아닙니다"}
    parsed = parse_submissions_13f(payload)
    return {"cik": padded, "name": parsed["name"], "latest13F": parsed["latest13F"], "error": None}
