"""
app/tasks/filings.py
weekly 그룹 — SEC 13F 기관 포트폴리오(기존 13F 화면 q8)와 모의 매매 트랙레코드 후보 기관(q30).
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .. import catalog, equities, equities_cusip, http, indicators, settings, store
from ..services import (
    sec13f as sec_service,
)

from .base import EmptyResult, _reason_suffix

logger = logging.getLogger(__name__)


# ==============================================================================
# weekly
# ==============================================================================
def task_sec_13f() -> str:
    """
    SEC 13F — 전체 수집에서 가장 오래 걸리는 작업.

    [최적화 2가지 — 구버전과 동일]
    1) q1은 q8의 부분집합입니다(공시를 최신순으로 훑어 앞에서 자릅니다).
       q8만 수집하고 q1은 잘라서 저장합니다 (수집 24건 → 12건).
    2) SEC 한도는 토큰 버킷이 전역으로 지키므로 기관을 병렬 처리해도
       합계 한도를 넘지 않습니다.

    저장할 때 보유마다 티커(``ticker``, 모르면 None)를 붙입니다 — 매핑표(equities)의 두 단계 매칭.
    이어받은(isStale) 분기도 함께 붙이므로 매핑표에 이름을 더하면 다음 실행부터 모든 분기에 반영됩니다(QA-087).
    """
    # 설정이 없으면 기관 12곳에 같은 실패를 12번 만들지 않고 여기서 한 번 말합니다.
    try:
        http.sec_user_agent()
    except http.SecUserAgentInvalid as exc:
        raise EmptyResult(f"0/{len(indicators.INSTITUTIONS)} 기관 — {exc}") from exc

    quarters = catalog.MAX_TRACKED_QUARTERS
    targets = [(inst["name"], inst["cik"], tuple(inst.get("merge_ciks") or ())) for inst in indicators.INSTITUTIONS]

    ok = 0
    saved = 0
    errors: list[str] = []

    def collect(item):
        name, cik, merge_ciks = item
        # 받지 못한 공시는 직전 저장본의 같은 공시로 잇습니다(QA-031).
        previous = store.read_snapshot(catalog.snap_sec_13f(cik, quarters))
        previous_quarters = (previous.payload or {}).get("quarters") if previous else None
        payload = sec_service.collect_13f(cik, quarters, previous_quarters=previous_quarters)
        if merge_ciks and payload.get("quarters"):
            # 그룹이 13F-NT로 바꾼 뒤의 분기는 자회사들의 공시를 합칩니다(QA-140, 뱅가드). 한 곳이라도 실패하면 이번에는
            # 저장하지 않습니다 — 그룹 공시만으로 덮으면 이미 합쳐 둔 최근 분기가 사라집니다.
            filers = [{**sec_service.collect_13f(sub, quarters), "cik": sub} for sub in merge_ciks]
            failed = next((filer for filer in filers if not filer.get("quarters")), None)
            if failed is not None:
                return name, cik, {"cik": cik, "quarters": None,
                                   "error": f"자회사 {failed['cik']} 13F 수집 실패({failed.get('error')}) — 합산하지 않고 저장본 유지"}
            payload = {**payload, "quarters": sec_service.merge_filers(payload["quarters"], filers, quarters)}
        return name, cik, payload

    with ThreadPoolExecutor(max_workers=4) as pool:
        for name, cik, payload in pool.map(http.bind_guard(collect), targets):
            if not payload.get("quarters"):
                logger.info("13F 빈 결과(저장본 유지): %s (%s)", name, payload.get("error"))
                errors.append(f"{name}: {payload.get('error') or '빈 결과'}")
                continue

            # 저장본 모양은 예전 그대로 {"cik", "error", "quarters"} — collect_13f의 진행 정보(fetchedFilings 등)는
            # 트랙레코드 수집만 씁니다.
            payload = {key: payload.get(key) for key in ("cik", "error", "quarters")}
            equities.attach_tickers(payload["quarters"])
            store.put_snapshot(catalog.snap_sec_13f(cik, quarters), payload)
            saved += 1

            # q1은 q8의 첫 분기와 같은 데이터입니다. 재수집하지 않습니다.
            store.put_snapshot(
                catalog.snap_sec_13f(cik, 1),
                {**payload, "quarters": payload["quarters"][:1]},
            )
            saved += 1
            ok += 1

    if not ok:
        raise EmptyResult(
            f"0/{len(targets)} 기관 — 기존 저장본 유지"
            + (f" ({errors[0]})" if errors else "")
        )

    detail = f"{ok}/{len(targets)} 기관, 스냅샷 {saved}건 (q{quarters} 수집 → q1 유도)"
    if errors:
        detail += f", 실패 {len(errors)}곳"
    return detail


# ==============================================================================
# weekly — 모의 매매 트랙레코드 후보 기관 (운영자 전용 기능)
# ==============================================================================
# browse-edgar 한 쪽의 행 수. 단계 0에서 count=100 한 쪽에 후보 27곳 모두 원본 30건이 들어왔습니다(정정 공시 포함 행 수).
TRACK_RECORD_LIST_COUNT = 100


def task_sec_13f_track_record() -> str:
    """
    트랙레코드 후보 기관(indicators.TRACK_RECORD_FILERS, 27곳)의 13F를 기관당 30분기(catalog.TRACK_RECORD_QUARTERS)까지
    ``sec.13f.{cik}.q30``에 저장하고, 후보 목록·수집 진행률을 ``SNAP_TRACK_RECORD_INDEX``에 남깁니다(설계 §4-0 ②).

    [증분·예산] 30분기 × 27곳은 약 810건이라 실행마다 다 받지 않습니다. 저장본에 있는 공시는 다시 받지 않고(reuse_stored),
    새로 내려받는 공시는 실행당 예산(settings.track_record_fetch_budget, 기본 400건) 안에서만 — 저장 분기가 적은(완료되지 않은)
    기관부터 채웁니다. 예산을 다 쓰면 남은 기관은 다음 실행이 이어 받고, 목록에는 이전 값과 '예산 소진'으로 남습니다.
    [선행 CIK] CIK를 바꿔 신고하는 기관은 옛 CIK도 받아 잇습니다(sec_service.chain_predecessors). 분기마다 ``filerCik``를 적어
    다음 실행이 CIK별 저장본을 나눠 넘깁니다.
    [실패] 한 CIK라도 실패하면 그 기관은 저장본을 덮지 않습니다 — 기존 sec_13f와 같은 규칙(QA-031·QA-140).
    [티커] q30에만 CUSIP 매핑표(equities_cusip.TRACK_RECORD_CUSIPS)를 붙입니다. 기존 13F 화면(q8)은 그대로입니다.
    [complete] 받을 수 있는 공시를 다 본 기관 — 30분기가 찼거나, CIK마다 EDGAR에 더 오래된 원본이 없거나 원본 링크를
    요청한 만큼 다 봤고(쓸 수 없는 공시를 건너뛰어 30이 안 되는 기관이 '수집 중'에 묶이지 않게), 예산 때문에 건너뛴 공시가
    없을 때. 백엔드는 complete가 아닌 기관을 '수집 중'으로 자격에서 뺍니다.
    """
    filers = indicators.TRACK_RECORD_FILERS
    # 설정이 없으면 27곳에 같은 실패를 27번 만들지 않고 여기서 한 번 말합니다.
    try:
        http.sec_user_agent()
    except http.SecUserAgentInvalid as exc:
        raise EmptyResult(f"0/{len(filers)} 기관 — {exc}") from exc

    target = catalog.TRACK_RECORD_QUARTERS
    initial_budget = settings.track_record_fetch_budget()
    budget = initial_budget

    # 목록 한 줄(요약)만 들고 다닙니다. q30 저장본은 기관 하나가 수 MB(보유 1,000줄 × 30분기)라 27곳을 한꺼번에 들면
    # 수집기 메모리 상한(1g, docker-compose.yml)에 닿습니다 — 처리할 때 그 기관 것만 다시 읽습니다.
    summaries = {filer["cik"]: _index_entry(filer, *_stored(filer["cik"])) for filer in filers}
    # 저장 분기가 적은 기관부터 — 완료된 기관은 새 분기 한 건만 확인하면 되니 뒤로 둡니다(같으면 목록 순서).
    order = sorted(
        range(len(filers)),
        key=lambda i: (summaries[filers[i]["cik"]]["complete"], summaries[filers[i]["cik"]]["storedQuarters"], i),
    )

    notes: dict[str, str] = {}
    errors: list[str] = []
    updated = 0
    fetched_total = 0
    for index in order:
        filer = filers[index]
        cik = filer["cik"]
        if budget <= 0:
            notes[cik] = "예산 소진 — 다음 실행에서 이어 받음"
            continue
        try:
            payload, fetched, error, exhausted = _collect_track_record_filer(filer, _stored(cik)[0], budget)
        except Exception as exc:  # noqa: BLE001 — 한 기관의 예기치 못한 오류로 나머지 26곳을 멈추지 않습니다
            logger.exception("13F 트랙레코드 수집 오류 (%s)", cik)
            payload, fetched, error, exhausted = None, 0, f"예기치 못한 오류: {type(exc).__name__}: {exc}", False
        budget -= fetched
        fetched_total += fetched
        if payload is None:
            # 목록에는 저장본의 값(summaries) 그대로 — 빠지면 화면이 그 기관을 잃습니다.
            logger.info("13F 트랙레코드 실패(저장본 유지): %s (%s)", filer["name"], error)
            errors.append(f"{filer['name']}: {error}")
            notes[cik] = f"수집 실패(저장본 유지): {error}"
            continue
        store.put_snapshot(catalog.snap_sec_13f(cik, target), payload)
        summaries[cik] = _index_entry(filer, payload, datetime.now(timezone.utc).isoformat())
        updated += 1
        if exhausted:
            notes[cik] = "예산 소진 — 다음 실행에서 이어 받음"

    if not updated:
        raise EmptyResult(
            f"0/{len(filers)} 기관 — 기존 저장본 유지" + _reason_suffix(errors[:2])
        )

    entries = [{**summaries[filer["cik"]], "note": notes.get(filer["cik"])} for filer in filers]
    store.put_snapshot(catalog.SNAP_TRACK_RECORD_INDEX, {
        "filers": entries,
        "targetQuarters": target,
        "budget": initial_budget,
        "fetchedThisRun": fetched_total,
    })

    complete = sum(1 for entry in entries if entry["complete"])
    detail = f"{updated}/{len(filers)} 기관 갱신, 새 공시 {fetched_total}건, 완료 {complete}곳"
    waiting = sum(1 for note in notes.values() if note.startswith("예산 소진"))
    if waiting:
        detail += f", 예산 소진 — {waiting}곳은 다음 실행에서 이어 받음"
    if errors:
        detail += f", 실패 {len(errors)}곳" + _reason_suffix(errors[:2])
    return detail


def _stored(cik: str) -> tuple[dict, str | None]:
    """그 기관의 q30 저장본(없으면 빈 사전)과 저장 시각."""
    snap = store.read_snapshot(catalog.snap_sec_13f(cik, catalog.TRACK_RECORD_QUARTERS))
    payload = snap.payload if snap and isinstance(snap.payload, dict) else {}
    return payload, (snap.collected_at.isoformat() if snap and snap.collected_at else None)


def _collect_track_record_filer(
    filer: dict, previous: dict, budget: int,
) -> tuple[dict | None, int, str | None, bool]:
    """
    후보 기관 하나의 q30 저장 내용 → (저장할 내용 또는 실패면 None, 새로 내려받은 공시 수, 실패 사유, 예산이 모자랐는지).

    지금 CIK부터, 그다음 옛 CIK를 같은 방식으로 받습니다(남은 예산을 이어서). 저장본의 분기는 ``filerCik``로 CIK마다 나눠
    넘깁니다 — ``filerCik``가 없는 옛 분기는 지금 CIK의 것으로 봅니다.

    ``supersededQuarters``: 받았지만 잇는 규칙에서 빠진 분기(선행 CIK와 겹치는 지금 CIK의 공시, 같은 보고 분기의 늦은 공시).
    트랙레코드는 쓰지 않고, 다음 실행이 그 공시를 다시 내려받지 않도록 보관만 합니다(퍼싱 스퀘어라면 겹치는 4분기를 실행마다).
    """
    cik = filer["cik"]
    predecessors = tuple(filer.get("predecessors") or ())
    target = catalog.TRACK_RECORD_QUARTERS
    stored = [
        q for q in (previous.get("quarters") or []) + (previous.get("supersededQuarters") or []) if isinstance(q, dict)
    ]

    fetched = 0
    results: list[tuple[dict, int]] = []   # (collect_13f 결과, 요청한 분기 수)
    for filer_cik in (cik, *predecessors):
        own = [q for q in stored if q.get("filerCik", cik) == filer_cik]
        wanted = target if filer_cik == cik else _predecessor_quarters_needed(own, results[0][0]["quarters"], target)
        if wanted <= 0:
            continue   # 지금 CIK만으로 30분기가 찼습니다 — 옛 CIK는 더 받지 않습니다
        result = sec_service.collect_13f(
            filer_cik, wanted, own,
            reuse_stored=True, list_count=TRACK_RECORD_LIST_COUNT, fetch_budget=max(0, budget - fetched),
        )
        fetched += int(result.get("fetchedFilings") or 0)
        if result.get("error") or (not result.get("quarters") and not result.get("budgetExhausted")):
            return None, fetched, f"{filer_cik} {result.get('error') or '빈 결과'}", False
        for quarter in result.get("quarters") or []:
            quarter["filerCik"] = filer_cik
        results.append((result, wanted))

    current = results[0][0]["quarters"]
    quarters = sec_service.chain_predecessors(current, [r["quarters"] for r, _wanted in results[1:]], target)
    equities.attach_tickers(quarters, cusip_map=equities_cusip.TRACK_RECORD_CUSIPS)
    # 30분기 밖으로 밀려난(가장 오래된) 분기는 보관하지 않습니다 — 다음 실행은 옛 CIK에서 그만큼만 묻습니다.
    used = {id(q) for q in quarters}
    oldest = min((q.get("reportDate") or "" for q in quarters), default=None)
    superseded = [
        q for r, _wanted in results for q in r.get("quarters") or []
        if id(q) not in used and oldest is not None and (q.get("reportDate") or "") >= oldest
    ]

    exhausted = any(r.get("budgetExhausted") for r, _wanted in results)
    seen_all = all(r.get("noMoreFilings") or (r.get("linksFound") or 0) >= wanted for r, wanted in results)
    payload = {
        "cik": cik,
        "name": filer["name"],
        "style": filer["style"],
        "predecessors": list(predecessors),
        "quarters": quarters,
        "complete": not exhausted and (len(quarters) >= target or seen_all),
        "fetchedThisRun": fetched,
        "supersededQuarters": superseded,
    }
    return payload, fetched, None, exhausted


def _predecessor_quarters_needed(own: list[dict], current: list[dict], target: int) -> int:
    """
    옛 CIK에서 받을 분기 수. 옛 CIK의 마지막 보고 분기를 저장본으로 알면 30 − (지금 CIK의 그 뒤 분기 수)만 — 매번 30건을
    물으면 잇고 남은 오래된 분기(30분기 밖이라 저장하지 않음)를 실행마다 다시 내려받습니다(그린라이트라면 DME 이후 분기 수만큼).
    처음(저장본 없음)에는 30.
    """
    last = max((q.get("reportDate") or "" for q in own), default="")
    if not last:
        return target
    return target - sum(1 for q in current if (q.get("reportDate") or "") > last)


def _index_entry(filer: dict, payload: dict, updated_at: str | None) -> dict:
    """후보 목록 한 줄(``note`` 제외). 이름·스타일·선행 CIK는 지금 목록(indicators)의 값, 나머지는 그 기관의 q30 저장본에서."""
    quarters = [q for q in payload.get("quarters") or [] if isinstance(q, dict)]
    filing_dates = [q.get("filingDate") for q in quarters if q.get("filingDate")]
    report_dates = [q.get("reportDate") for q in quarters if q.get("reportDate")]
    return {
        "cik": filer["cik"],
        "name": filer["name"],
        "style": filer["style"],
        "predecessors": list(filer.get("predecessors") or ()),
        "storedQuarters": len(quarters),
        "complete": bool(payload.get("complete")),
        "lastFilingDate": max(filing_dates) if filing_dates else None,
        "lastReportDate": max(report_dates) if report_dates else None,
        "updatedAt": updated_at,
    }
