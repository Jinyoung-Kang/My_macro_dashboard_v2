"""
app/services/sec13f.py
SEC EDGAR 13F-HR 공시 수집.

[지켜야 할 것]
- SEC는 연락처가 포함된 User-Agent를 요구하고(미준수 시 403), 초당 요청
  한도가 있습니다. 한도는 app/http.sec_rate_limit() 토큰 버킷이 전역으로
  지키므로 기관을 병렬 처리해도 합계 한도를 넘지 않습니다.
- 2023년 이전 공시는 금액 단위가 천 달러입니다. 합계가 $100M 미만이면
  천 달러 단위로 보고 1000을 곱합니다(구버전과 동일한 보정).
- CUSIP은 숫자로만 이루어진 경우가 많습니다(예: 037833100). 반드시
  **문자열**로 다룹니다. 숫자로 바꾸면 앞자리 0이 사라집니다.
"""
from __future__ import annotations

import io
import logging
import re
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime

from bs4 import BeautifulSoup

from ..numbers import to_float
from ..http import (
    SecUserAgentInvalid,
    brief_error,
    get_sec_session,
    sec_rate_limit,
)

logger = logging.getLogger(__name__)

EDGAR_BROWSE = "https://www.sec.gov/cgi-bin/browse-edgar"


# 원본 13F-HR이 한 쪽(count)에 다 들어오지 않으면 다음 쪽(start=)을 봅니다. 단계 0 측정에서 count=100 한 쪽에 후보 27곳
# 모두 원본 30건이 들어왔으니, 다음 쪽은 정정 공시가 많은 기관을 위한 안전장치입니다 — 끝없이 넘기지 않게 3쪽까지.
# list_count를 준 호출(트랙레코드)만 넘깁니다 — 기존 13F 화면(q8)은 예전처럼 40행 한 쪽.
MAX_LIST_PAGES = 3
DEFAULT_LIST_COUNT = 40


def collect_13f(
    cik: str,
    max_quarters: int = 8,
    previous_quarters: list[dict] | None = None,
    *,
    reuse_stored: bool = False,
    list_count: int | None = None,
    fetch_budget: int | None = None,
) -> dict:
    """
    최근 max_quarters개 분기의 13F를 수집합니다.

    반환 계약(JSON):
    {
      "cik": "0001067983",
      "error": null | "사람이 읽는 실패 사유",
      "quarters": [
        {"filingDate","reportDate","totalValue",
         "holdings":[{"name","cusip","class","value","shares","weight"}]}   # reuse_stored면 + "filingUrl"
      ],
      "fetchedFilings": 새로 내려받으려 한 공시 수(실패·쓸 수 없는 공시 포함 — 예산은 요청 수를 묶는 것),
      "budgetExhausted": 예산이 모자라 내려받지 못한 공시가 있는지,
      "linksFound": 찾은 원본 13F-HR 링크 수(최대 max_quarters),
      "noMoreFilings": EDGAR에 이보다 오래된 원본이 없는지(목록 마지막 쪽까지 봤고 링크가 max_quarters에 못 미침)
    }
    quarters는 최신 분기가 앞입니다(q1은 q8의 앞부분과 같습니다). 기존 13F 화면은 앞의 세 키만 저장합니다.

    공시 하나를 받지 못하면(시간 초과·403·XML 없음) 직전 저장본(``previous_quarters``)의 **같은 공시**를
    이어받고 ``isStale``을 붙입니다. 직전 저장본에도 없으면 그 기관은 실패입니다 — 건너뛰면 분기가 한 칸
    밀려, 백엔드가 0번·1번을 '최신 대 직전'으로 비교할 때 두 분기 떨어진 공시를 비교했습니다(QA-031).

    모의 매매 트랙레코드(30분기, tasks/filings.task_sec_13f_track_record)가 쓰는 인자 — 기본값이면 위 동작 그대로입니다
    (목록 요청 한 번 40행, 저장본은 받지 못한 공시를 이어받을 때만 제출일로 찾음, 분기 모양도 같음).
      - ``list_count``: 공시 목록 한 쪽의 행 수(browse-edgar ``count``). 이 값을 준 호출만, 원본 링크가 max_quarters에 못
        미치고 그 쪽이 꽉 찼으면(행 수 == list_count) ``start=``로 다음 쪽을 봅니다(MAX_LIST_PAGES까지). 주지 않으면 40행 한 쪽.
      - ``reuse_stored``: 직전 저장본에 **같은 공시 문서**가 있고 ``isStale``이 아니면 내려받지 않고 그대로 씁니다. 13F
        원본은 한 번 내면 바뀌지 않고(고칠 때는 정정 공시 13F-HR/A를 따로 냄 — 원본만 분기로 셈), 30분기를 실행마다 다시 받으면
        12시간마다 약 810건이라 SEC 한도를 기존 수집과 나눠 쓰기 어렵습니다. 같은 공시인지는 분기에 적어 두는 문서 URL
        (``filingUrl``, 접수번호가 든 색인 주소)로 봅니다 — 밀린 분기를 같은 날 두 건 낸 기관도 실행마다 다시 받지 않게.
        ``filingUrl``이 없는 저장본은 제출일로 찾되, 그날 공시가 목록·저장본 모두 하나일 때만입니다.
      - ``fetch_budget``: 새로 내려받는 공시 수 상한. 다 쓰면 내려받아야 하는 공시는 건너뛰고(최신부터 채우므로 다음 실행이
        더 오래된 쪽을 이어 받음), 저장본에 있는 공시는 계속 이어 씁니다 — 멈추면 아직 안 본 오래된 분기의 저장본까지
        결과에서 빠져, 이번 저장이 그 분기들을 지웁니다.
    """
    try:
        session = get_sec_session()
    except SecUserAgentInvalid as exc:
        # 설정 누락은 '연결 실패'가 아닙니다. 12개 기관마다 같은 망 오류가 뜬 것처럼
        # 보이면 진짜 원인(.env 한 줄)을 찾기 어려워집니다.
        return _fail(cik, str(exc))

    cik_padded = str(cik).lstrip("0").zfill(10)

    pages = MAX_LIST_PAGES if list_count is not None else 1
    count = list_count if list_count is not None else DEFAULT_LIST_COUNT
    links: list[tuple[str, str]] = []
    no_more = False
    for page in range(pages):
        params = {
            "action": "getcompany",
            "CIK": cik_padded,
            "type": "13F-HR",
            "dateb": "",
            "owner": "include",
            "count": count,
        }
        if page:
            params["start"] = page * count

        try:
            sec_rate_limit()
            res = session.get(EDGAR_BROWSE, params=params, timeout=30)
            res.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            if page:
                # 다음 쪽만 실패하면 찾은 공시로 갑니다. 더 오래된 원본이 있는지는 모르므로 noMoreFilings는 False로 둡니다.
                logger.warning("13F 공시 목록 %d쪽 조회 실패 (%s): %s", page + 1, cik, brief_error(exc))
                break
            # 403은 대개 "연락처 없는 User-Agent"입니다. SEC가 정책으로 막습니다.
            hint = (
                " — SEC_USER_AGENT에 본인 이메일을 넣으세요"
                if "403" in str(exc) else ""
            )
            return _fail(cik, f"SEC EDGAR 연결 실패: {brief_error(exc)}{hint}")

        # 쪽을 넘기는 사이 새 공시가 올라오면 목록이 한 칸 밀려 앞 쪽의 마지막 공시가 다시 옵니다 — 같은 문서는 한 번만.
        seen = {url for _filed, url in links}
        fresh = [link for link in _parse_filing_links(res.text, max_quarters) if link[1] not in seen]
        links.extend(fresh[:max_quarters - len(links)])
        if len(links) >= max_quarters:
            break
        if _listing_row_count(res.text) < count:
            no_more = True
            break

    if not links:
        return _fail(cik, "조회된 13F-HR 공시 문서가 없습니다.")

    previous = [q for q in (previous_quarters or []) if isinstance(q, dict) and q.get("filingDate")]
    previous_by_filing = {q.get("filingDate"): q for q in previous}
    previous_by_url = {q["filingUrl"]: q for q in previous if q.get("filingUrl")} if reuse_stored else {}
    # 같은 날 낸 원본이 둘 이상이면(밀린 분기를 한꺼번에 냄) 제출일만으로는 저장본의 어느 공시인지 알 수 없습니다.
    same_day = Counter(filing_date for filing_date, _url in links)
    stored_same_day = Counter(q.get("filingDate") for q in previous)

    def stored_for(filing_date: str, doc_url: str) -> dict | None:
        if not reuse_stored:
            return previous_by_filing.get(filing_date)   # 기존 동작 — 받지 못한 공시를 이어받을 때만 씀
        kept = previous_by_url.get(doc_url)
        if kept is not None:
            return kept
        kept = previous_by_filing.get(filing_date)
        if kept is not None and not kept.get("filingUrl") and same_day[filing_date] == 1 \
                and stored_same_day[filing_date] == 1:
            return kept
        return None

    quarters = []
    missing: list[str] = []
    fetched = 0
    budget_exhausted = False
    for filing_date, doc_url in links:
        kept = stored_for(filing_date, doc_url)
        if reuse_stored and kept is not None and not kept.get("isStale"):
            quarters.append(kept)
            continue
        if fetch_budget is not None and fetched >= fetch_budget:
            budget_exhausted = True
            if reuse_stored:
                # 이어받아 둔(isStale) 값 — 버리면 이번 저장이 그 분기를 지워, 다음 실행까지 분기 중간에 구멍이 납니다.
                quarters.extend(_carried_over(kept, filing_date, previous, quarters))
            continue
        fetched += 1
        holdings = _collect_one_filing(session, filing_date, doc_url)
        if holdings is UNUSABLE_FILING:
            logger.info("13F 공시에 쓸 보유가 없어 건너뜀 (%s %s)", cik, filing_date)
            continue
        if holdings is None:
            if kept is None:
                missing.append(filing_date)
            else:
                quarters.append({**kept, "isStale": True, **({"filingUrl": doc_url} if reuse_stored else {})})
            continue
        if reuse_stored:
            holdings["filingUrl"] = doc_url
        quarters.append(holdings)

    progress = {
        "fetchedFilings": fetched,
        "budgetExhausted": budget_exhausted,
        "linksFound": len(links),
        "noMoreFilings": no_more,
    }
    if missing:
        return _fail(
            cik,
            f"공시 {len(missing)}건({', '.join(missing)})을 받지 못했습니다 — "
            "분기가 밀리지 않게 직전 저장본을 유지합니다.",
            **progress,
        )

    if not quarters:
        if budget_exhausted:
            # 실패가 아니라 이번 예산으로는 아무것도 못 받은 것입니다(저장본도 없음). 다음 실행이 이어 받습니다.
            return {"cik": str(cik), "error": None, "quarters": [], **progress}
        return _fail(
            cik,
            "성공적으로 추출된 분기 데이터가 없습니다 "
            "(공시 문서가 비었거나 파싱 가능한 13F XML이 없습니다).",
            **progress,
        )

    return {"cik": str(cik), "error": None, "quarters": quarters, **progress}


def chain_predecessors(current: list[dict], predecessors: list[list[dict]], max_quarters: int) -> list[dict]:
    """
    같은 운용 주체가 CIK를 바꿔 신고하는 기관의 분기를 하나로 잇습니다(최신순, 최대 max_quarters).

    :param current: 지금 CIK의 분기(collect_13f 결과)
    :param predecessors: 옛 CIK마다의 분기 목록(indicators.TRACK_RECORD_FILERS의 ``predecessors`` 순서와 무관)
    옛 CIK는 그 분기들의 마지막 reportDate까지 쓰고, 그보다 뒤 분기만 다음 CIK(옛 CIK가 여럿이면 마지막 보고가 늦은 쪽,
    맨 끝은 지금 CIK)에서 가져옵니다 — 다음 CIK의 같은·앞선 보고 분기는 버립니다. 겹치는 기간에 새 CIK가 일부만 신고하는
    경우가 있어서입니다(퍼싱 스퀘어 Inc.는 2025-06-30~2026-03-31에 하워드 휴스 지분 한 종목만, 펀드 전체는 옛 CIK PSCM).
    같은 reportDate가 둘 이상이면 먼저 낸(filingDate가 이른) 공시 — 그날 시장이 처음 알게 된 보유이고, 트랙레코드는
    공시일 다음 거래일부터 복제합니다(룩어헤드 없음, ADR 0009). 선행 CIK가 없어도 이 정리(중복 보고 분기·정렬)는 같습니다.
    """
    def last_report(quarters: list[dict]) -> str:
        return max((q.get("reportDate") or "" for q in quarters), default="")

    segments = sorted((list(p) for p in predecessors if p), key=last_report) + [list(current or [])]
    chained: list[dict] = []
    cutoff = ""
    for segment in segments:
        chained.extend(q for q in segment if (q.get("reportDate") or "") > cutoff)
        cutoff = max(cutoff, last_report(segment))

    by_report: dict[str, dict] = {}
    for quarter in chained:
        key = quarter.get("reportDate") or ""
        kept = by_report.get(key)
        if kept is None or (quarter.get("filingDate") or "") < (kept.get("filingDate") or ""):
            by_report[key] = quarter
    ordered = sorted(by_report.values(), key=lambda q: q.get("reportDate") or "", reverse=True)
    return ordered[:max_quarters]


def merge_filers(group_quarters: list[dict], filers: list[dict], max_quarters: int) -> list[dict]:
    """
    그룹이 13F-NT(신고 위임)로 바꾸고 자회사들이 보유를 나눠 신고하는 기관의 분기 목록(최신순, 최대 max_quarters).

    :param group_quarters: 그룹 자신의 13F-HR 분기(collect_13f 결과)
    :param filers: 자회사별 collect_13f 결과 [{"cik", "quarters"}] — 모두 성공한 것만 넘깁니다
    그룹이 직접 낸 마지막 분기보다 뒤이고 **모든 자회사에 있는** 분기만 합칩니다. 한 곳만 낸 분기를 합치면 기관 전체가
    아니라 일부가 그 기관의 보유로 보입니다(QA-140). 보유는 증권(CUSIP·클래스)별로 평가액·수량을 더하고 비중을 다시
    계산합니다 — 같은 증권을 자회사마다 다른 이름('NVIDIA CORP'·'NVIDIA CORPORATION')으로 적습니다. 수량을 모르는(채권
    원금) 쪽이 있으면 합친 수량도 모름입니다. 합친 분기의 ``filers``에 어느 공시를 합쳤는지 남깁니다.
    """
    last_group = max((q.get("reportDate") or "" for q in group_quarters), default="")
    common = set.intersection(*(
        {q.get("reportDate") for q in filer.get("quarters") or []} for filer in filers
    )) if filers else set()

    merged: list[dict] = []
    for report_date in sorted(d for d in common if d and d > last_group):
        parts = [
            (filer["cik"], next(q for q in filer["quarters"] if q.get("reportDate") == report_date))
            for filer in filers
        ]
        holdings: dict[tuple, dict] = {}
        for _cik, quarter in parts:
            for holding in quarter.get("holdings") or []:
                key = (holding.get("cusip") or holding.get("name"), holding.get("class"))
                entry = holdings.get(key)
                if entry is None:
                    holdings[key] = {**holding, "value": float(holding.get("value") or 0.0)}
                    continue
                entry["value"] += float(holding.get("value") or 0.0)
                shares = holding.get("shares")
                entry["shares"] = None if entry.get("shares") is None or shares is None else entry["shares"] + shares
        rows = sorted(holdings.values(), key=lambda h: h["value"], reverse=True)
        total = sum(h["value"] for h in rows)
        for row in rows:
            row["weight"] = (row["value"] / total * 100.0) if total > 0 else 0.0
        quarter = {
            "filingDate": max(q.get("filingDate") or "" for _cik, q in parts),
            "reportDate": report_date,
            "totalValue": total,
            "holdings": rows,
            "filers": [{"cik": cik, "filingDate": q.get("filingDate")} for cik, q in parts],
        }
        if any(q.get("isStale") for _cik, q in parts):
            quarter["isStale"] = True
        merged.append(quarter)

    combined = list(group_quarters) + merged
    combined.sort(key=lambda q: q.get("reportDate") or "", reverse=True)
    return combined[:max_quarters]


def _parse_filing_links(html: str, max_quarters: int) -> list[tuple[str, str]]:
    """
    공시 목록에서 (제출일, 문서 목록 URL)을 최신순으로 max_quarters개 고릅니다.

    원본 13F-HR만 분기로 셉니다. EDGAR의 type=13F-HR 목록에는 정정(13F-HR/A)도
    섞여 오는데, 그걸 세면 같은 분기가 두 번 들어가고(q8이 실제로는 7개 분기),
    가장 최근 공시가 '신규 보유분만' 담은 부분 정정이면 q1이 부분 포트폴리오가
    되어 비중이 그 부분 합계로 정규화됩니다.
    """
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table", class_="tableFile2")
    if not tables:
        return []

    links: list[tuple[str, str]] = []
    for row in tables[0].find_all("tr")[1:]:
        cols = row.find_all("td")
        if len(cols) < 4:
            continue
        if cols[0].text.strip().upper() != "13F-HR":
            continue
        anchor = cols[1].find("a", href=True)
        if not anchor:
            continue
        href = anchor["href"]
        links.append((
            cols[3].text.strip(),
            href if href.startswith("http") else f"https://www.sec.gov{href}",
        ))
        if len(links) >= max_quarters:
            break
    return links


def _listing_row_count(html: str) -> int:
    """
    공시 목록 표(tableFile2)의 행 수(머리 행 제외) — 원본·정정을 모두 셉니다. 한 쪽이 꽉 찼는지(행 수 == count) 볼 때
    씁니다. 꽉 차지 않았으면 EDGAR에 더 오래된 공시가 없습니다.
    """
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table", class_="tableFile2")
    return len(tables[0].find_all("tr")[1:]) if tables else 0


def _carried_over(kept: dict | None, filing_date: str, previous: list[dict], quarters: list[dict]) -> list[dict]:
    """
    예산 때문에 내려받지 못한 공시 대신 결과에 남길 저장본. 같은 공시의 저장본이 있으면 그것 하나.

    ``filingUrl``을 적기 전의 저장본에서 같은 날 낸 공시 둘은 어느 쪽이 이 문서인지 모르므로, 그 제출일의 저장본 중 아직 결과에
    없는 보고 분기를 모두 남깁니다(같은 날의 다른 공시를 이미 받았으면 그 보고 분기는 빼서 겹치지 않게).
    """
    if kept is not None:
        return [kept]
    have = {id(q) for q in quarters}
    reports = {q.get("reportDate") for q in quarters}
    out: list[dict] = []
    for quarter in previous:
        if quarter.get("filingDate") != filing_date or quarter.get("filingUrl") or id(quarter) in have:
            continue
        if quarter.get("reportDate") in reports:
            continue
        out.append(quarter)
        reports.add(quarter.get("reportDate"))
    return out


# 다시 받아도 쓸 수 없는 공시(정보표 XML이 없거나 롱 보유가 0건 — 옵션 행뿐). 일시 실패(None)와 구분합니다(QA-059).
UNUSABLE_FILING: dict = {"unusable": True}


def _collect_one_filing(session, filing_date: str, doc_url: str) -> dict | None:
    """
    공시 하나의 보유 목록. 네트워크 실패는 None(일시 실패 — 이어받거나 기관을 실패로),
    공시 자체에 쓸 것이 없으면 ``UNUSABLE_FILING``(건너뜀)입니다.
    """
    try:
        sec_rate_limit()
        res = session.get(doc_url, timeout=30)
        res.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        logger.warning("13F 문서 목록 조회 실패 (%s): %s", filing_date, exc)
        return None

    xml_url = _find_information_table_url(res.text)
    if not xml_url:
        return UNUSABLE_FILING
    # 보고 분기는 공시 색인의 'Period of Report'가 정답입니다. 없을 때만 제출일로 추정합니다.
    report_date = _parse_period_of_report(res.text) or _estimate_report_date(filing_date)

    try:
        sec_rate_limit()
        xml_res = session.get(xml_url, timeout=30)
        xml_res.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        logger.warning("13F XML 다운로드 실패 (%s): %s", filing_date, exc)
        return None

    holdings = _parse_information_table(xml_res.content, filing_date)
    if not holdings:
        return UNUSABLE_FILING

    total = sum(h["value"] for h in holdings)

    # 2023년 이전 공시는 천 달러 단위입니다.
    if 0 < total < 100_000_000:
        for holding in holdings:
            holding["value"] *= 1000.0
        total *= 1000.0

    for holding in holdings:
        holding["weight"] = (holding["value"] / total * 100.0) if total > 0 else 0.0

    holdings.sort(key=lambda h: h["value"], reverse=True)

    return {
        "filingDate": filing_date,
        "reportDate": report_date,
        "totalValue": total,
        "holdings": holdings,
    }


def _find_information_table_url(html: str) -> str | None:
    """
    공시 문서 목록에서 종목 테이블(information table) XML을 고릅니다.
    primary_doc.xml은 표지 문서라 제외해야 합니다.
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="tableFile")
    fallback = None

    if table:
        for row in table.find_all("tr")[1:]:
            cols = row.find_all("td")
            if len(cols) < 4:
                continue
            anchor = cols[2].find("a", href=True)
            if not anchor or not anchor.text.strip().lower().endswith(".xml"):
                continue

            href = anchor["href"]
            full = href if href.startswith("http") else f"https://www.sec.gov{href}"
            doc_type = cols[3].text.strip().lower()
            file_name = anchor.text.strip().lower()

            if (
                "information table" in doc_type
                or "infotable" in doc_type
                or "infotable" in file_name
                or "information" in file_name
            ):
                return full
            if fallback is None and "primary_doc" not in file_name:
                fallback = full

    if fallback:
        return fallback

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        lowered = href.lower()
        if lowered.endswith(".xml") and "primary_doc" not in lowered:
            return href if href.startswith("http") else f"https://www.sec.gov{href}"
    return None


def _parse_information_table(content: bytes, filing_date: str) -> list[dict]:
    """
    네임스페이스를 무시하고 infoTable 노드를 훑습니다.
    (제출자마다 네임스페이스 접두사가 달라 고정할 수 없습니다.)

    스트리밍으로 읽습니다(2026-11-23 — ``ET.iterparse``): infoTable 하나가 닫힐 때 그 줄을 읽고 바로 비워, 문서 전체의 요소 나무를
    메모리에 두지 않습니다. 큰 제출자(모건스탠리 보유 7,896줄)는 통째로 읽으면 공시 하나에 요소가 십수만 개라 수집기 메모리를 크게
    올렸습니다(QA-989). 결과와 차례는 통째 파싱과 같습니다(tests/test_sec13f_stream_parse.py). 깨진 XML은 지금처럼 빈 목록입니다.
    """
    merged: dict[tuple[str, str, str], dict] = {}
    root = None
    try:
        for event, node in ET.iterparse(io.BytesIO(content), events=("start", "end")):
            if event == "start":
                if root is None:
                    root = node
                continue
            if not node.tag.lower().endswith("infotable"):
                continue
            _merge_info_table_row(merged, node)
            # 읽은 줄은 비우고 뿌리에서도 떼어 냅니다(뿌리가 빈 요소를 계속 들고 있지 않게).
            node.clear()
            if root is not None and root is not node:
                root.clear()
    except ET.ParseError as exc:
        logger.warning("13F XML 파싱 에러 (%s): %s", filing_date, exc)
        return []

    return list(merged.values())


def _merge_info_table_row(merged: dict[tuple[str, str, str], dict], node: ET.Element) -> None:
    """infoTable 한 줄 → ``merged``(이름·CUSIP·클래스마다 평가액·주식 수를 더함). 쓸 수 없는 줄은 건너뜁니다."""
    name = cusip = title_class = put_call = amount_type = ""
    value = shares = 0.0

    for child in node.iter():
        tag = child.tag.lower()
        text = (child.text or "").strip()
        if tag.endswith("nameofissuer"):
            name = text
        elif tag.endswith("titleofclass"):
            title_class = text
        elif tag.endswith("cusip"):
            cusip = text
        elif tag.endswith("value"):
            value = _to_float(text)
        elif tag.endswith("sshprnamt"):
            shares = _to_float(text)
        elif tag.endswith("sshprnamttype"):
            amount_type = text.upper()
        elif tag.endswith("putcall"):
            put_call = text

    if not name or value <= 0:
        return
    # 옵션(풋·콜) 행의 평가액은 기초자산 기준이라 롱 보유가 아닙니다. 합치면 풋이 보유로 보이고 비중 분모가
    # 부풉니다(QA-033). 보유·비중에서 뺍니다.
    if put_call:
        return

    key = (name.strip().upper(), cusip.strip(), title_class.strip())
    entry = merged.setdefault(key, {
        "name": key[0],
        "cusip": key[1],     # 문자열 유지 — 숫자로 바꾸면 앞자리 0이 사라집니다
        "class": key[2],
        "value": 0.0,
        "shares": 0.0,
        "weight": 0.0,
    })
    entry["value"] += value
    # PRN(채권 원금) 행의 수량은 주식 수가 아닙니다 — 모름(None)으로 둡니다(백엔드는 '비교 불가'로 처리).
    if amount_type == "PRN" or entry["shares"] is None:
        entry["shares"] = None
    else:
        entry["shares"] += shares


_PERIOD_OF_REPORT = re.compile(
    r'infoHead">\s*Period of Report\s*</div>\s*<div class="info">\s*(\d{4}-\d{2}-\d{2})',
    re.IGNORECASE,
)


def _parse_period_of_report(index_html: str) -> str | None:
    """EDGAR 공시 색인 페이지의 'Period of Report'(보고 분기말). 없으면 None."""
    match = _PERIOD_OF_REPORT.search(index_html or "")
    return match.group(1) if match else None


def _estimate_report_date(filing_date: str) -> str:
    """
    제출일 **전에 끝난** 가장 최근 분기말 — 색인에 보고 기간이 없을 때만 씁니다.

    예전에는 제출 월로 골라 3·6·9·12월에 낸 공시가 아직 끝나지 않은 분기로 붙었습니다
    (12월 2일 제출 → 같은 해 12-31, QA-014). 13F는 분기가 끝난 뒤에 내므로, 제출일 이전의
    분기말이 언제나 가능한 답입니다(마감 45일 안에 낸 공시라면 정답).
    """
    try:
        filed = datetime.strptime(filing_date, "%Y-%m-%d")
    except ValueError:
        return filing_date

    year, month = filed.year, filed.month
    if month <= 3:
        return f"{year - 1}-12-31"
    if month <= 6:
        return f"{year}-03-31"
    if month <= 9:
        return f"{year}-06-30"
    return f"{year}-09-30"


def _to_float(text: str) -> float:
    """13F 평가액·주식 수 — 비었으면 0(합계에서 빠지게, 원래 동작 유지). 해석 규칙은 app/numbers."""
    return to_float(text) or 0.0


def _fail(cik: str, message: str, **progress) -> dict:
    """실패 결과. 진행 정보(fetchedFilings 등)는 실패해도 싣습니다 — 트랙레코드 수집이 쓴 예산을 셉니다."""
    return {
        "cik": str(cik), "error": message, "quarters": [],
        "fetchedFilings": 0, "budgetExhausted": False, "linksFound": 0, "noMoreFilings": False,
        **progress,
    }
