"""
app/tasks/korea_public.py
국내 공공 데이터 — 공휴일(천문연)·금융위 일별 시세·DART 재무.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from .. import catalog, krcalendar, publicapi, store
from ..services import (
    dart as dart_service,
    fsc as fsc_service,
    kasi as kasi_service,
)

from .base import EmptyResult, KST, RADAR_COMBINATIONS, _reason_suffix

logger = logging.getLogger(__name__)


# ==============================================================================
# 매크로 카드 보정
# ==============================================================================
# 공휴일 저장본에 남기는 가장 이른 해 — 고정 하한(해가 지나도 올라가지 않음). 모의 매매 한국 책의 지난 거래일 계산
# (통계 표본·보유 거래일)이 출발일(2026-11 이후)부터 세고, 2025년은 토스 1년 이력 백필 범위의 시작입니다(v2 2단계 명세 K35).
# 한 해 20여 건이라 몇십 년이 쌓여도 저장본은 작습니다.
KR_HOLIDAYS_KEEP_FROM = 2025


def task_kr_holidays() -> str:
    """
    📅 한국 공휴일 (천문연 특일정보) — 올해·내년을 받아 2025년부터 남김.

    저장 규칙
      - 연도별로 합칩니다. 이번에 받지 못한 해는 이전 저장본을 그대로 둡니다.
      - **0건 응답이 기존 목록을 지우지 않게** 합니다. 아직 발표되지 않은 해는
        정상적으로 0건이 오지만, 이미 받아 둔 해가 0건으로 바뀌는 것은 데이터가
        아니라 부재(서비스 만료·일시 오류)일 가능성이 큽니다.
      - **KR_HOLIDAYS_KEEP_FROM(2025)년부터** 남깁니다. 시계는 올해·내년만 보지만, 모의 매매 한국 책
        (백엔드 KrxCalendar)은 출발일부터의 통계 표본·보유 거래일을 지난 해 목록으로 셉니다 — 예전 규칙
        ('지난해까지')이면 2028-01-01에 2026년 목록이 사라졌습니다(v2 2단계 명세 K35).
    """
    now = datetime.now(KST)
    years = (now.year, now.year + 1)

    previous = store.read_snapshot(catalog.SNAP_KR_HOLIDAYS)
    stored: dict = dict(((previous.payload or {}).get("years") or {}) if previous else {})

    fetched, kept, reasons = [], [], []
    for year in years:
        try:
            holidays = kasi_service.fetch_year(year)
        except publicapi.MissingKey:
            raise EmptyResult("DATA_GO_KR_SERVICE_KEY 미설정 — .env에 공공데이터포털 인증키를 넣으세요") from None
        except publicapi.PublicApiError as exc:
            reasons.append(f"{year}: {exc}")
            continue

        old = (stored.get(str(year)) or {}).get("holidays") or []
        if not holidays and old:
            kept.append(year)
            reasons.append(f"{year}: 0건 응답 — 기존 {len(old)}건 유지")
            continue
        stored[str(year)] = {
            "holidays": holidays,
            # 0건은 "휴일이 없다"가 아니라 "아직 발표 전"입니다. 화면이 구분할 수 있게 적습니다.
            "announced": bool(holidays),
            "fetchedAt": now.isoformat(),
        }
        fetched.append(year)

    if not fetched:
        raise EmptyResult("0/2 연도 — 기존 저장본 유지" + _reason_suffix(reasons))

    stored = {y: v for y, v in stored.items() if y.isdigit() and int(y) >= KR_HOLIDAYS_KEEP_FROM}
    store.put_snapshot(catalog.SNAP_KR_HOLIDAYS, {
        "source": "한국천문연구원 특일정보 (getRestDeInfo, isHoliday=Y)",
        "years": stored,
    })
    # 거래일 판정(수급 레이더 기준일·금융위 후보일)이 바로 새 목록을 쓰게 합니다.
    krcalendar.set_holidays(
        day["date"] for year in stored.values() for day in (year.get("holidays") or [])
    )
    counts = ", ".join(f"{y} {len(stored[str(y)]['holidays'])}건" for y in fetched)
    return counts + (f" (유지: {', '.join(map(str, kept))})" if kept else "")


FSC_CALL_BUDGET = 12
FSC_LOOKBACK_DAYS = 7
FSC_RETENTION_DAYS = 400


def _fsc_candidate_dates(today) -> list:
    """어제부터 거슬러 올라가며 거래일(평일·비공휴일)만. 오늘은 아직 발표 전이라 넣지 않습니다."""
    return krcalendar.previous_trading_days(today, FSC_LOOKBACK_DAYS)


def task_fsc_prices() -> str:
    """
    🏛️ 금융위 공식 일별 시세 — 전 종목 종가·시가총액 + 시장별 합계.

    규칙
      - 저장된 마지막 기준일 **이후의 영업일을 전부** 받습니다(오래된 날부터). 수집기가
        며칠 꺼져 있었어도 빠진 날이 생기지 않습니다. 최신 상태면 호출 0회로 끝납니다
        (1시간마다 돌아도 한도를 쓰지 않음). 저장본이 아예 없으면 가장 최근 하루만 받습니다.
      - 하루치(종목별 observations + 시장 합계 timeseries + 메타 스냅샷)는 한 트랜잭션입니다.
        따로 커밋하면 중간에 멈췄을 때 '종목은 있는데 합계는 없는 날'이 생기고, 다음
        실행은 그날을 이미 받은 날로 보고 건너뜁니다.
      - 종목별 값은 observations(종목코드 = entity)에 쌓습니다. 한 스냅샷에 3천 행을
        넣으면 화면 요청마다 그 전체를 읽어야 합니다. 인덱스로 필요한 종목만 읽습니다.
      - 400일이 지난 행은 정리합니다.
    """
    today = datetime.now(KST).date()
    stored_latest = store.latest_observation_date(catalog.OBS_FSC_PRICE)
    budget = publicapi.CallBudget(FSC_CALL_BUDGET)
    reasons: list[str] = []

    pending = [d for d in _fsc_candidate_dates(today) if not stored_latest or d.isoformat() > stored_latest]
    if not pending:
        return f"최신 상태 (기준일 {stored_latest}, 호출 {budget.used}회)"

    # 저장본이 있으면 빠진 날을 오래된 순서로 전부 메웁니다(메타 스냅샷의 latestBasDt가
    # 가장 최근 날이 되도록). 저장본이 없으면 시작점을 잡는 것이라, 최신부터 보다가
    # 처음 발표된 하루만 받습니다.
    order = list(reversed(pending)) if stored_latest else pending
    only_first = not stored_latest

    written: list[tuple[str, int]] = []
    for day in order:
        try:
            rows, url = fsc_service.fetch_day(day.strftime("%Y%m%d"), budget)
        except publicapi.MissingKey:
            raise EmptyResult("DATA_GO_KR_SERVICE_KEY 미설정 — .env에 공공데이터포털 인증키를 넣으세요") from None
        except publicapi.PublicApiError as exc:
            reasons.append(f"{day}: {exc}")
            # 보충 중이면 실패한 날에서 멈춥니다. 뒤 날짜를 먼저 저장하면 저장된 마지막 기준일이 그날을 앞질러
            # 다음 실행이 그날을 다시 받지 않았습니다(QA-034). 시작점을 찾는 중(저장본 없음)이면 하루 앞을 봅니다.
            if budget.exhausted or stored_latest:
                break
            continue
        if not rows:
            continue  # 아직 발표 전이거나 휴장일

        obs_date = day.isoformat()
        totals = fsc_service.market_totals(rows)
        with store.transaction():
            saved = store.put_observations(catalog.OBS_FSC_PRICE, obs_date, rows, entity_key="code")
            for market, agg in totals.items():
                store.put_timeseries(catalog.TS_FSC_MARKET, f"{market}.marketCap", [(obs_date, agg["marketCap"])])
                store.put_timeseries(catalog.TS_FSC_MARKET, f"{market}.tradingValue", [(obs_date, agg["tradingValue"])])
            store.put_snapshot(catalog.SNAP_FSC_PRICES_META, {
                "source": "금융위원회 주식시세정보 (거래소 확정치, 기준일 다음 영업일 13시 이후 갱신)",
                "latestBasDt": obs_date,
                "rows": saved,
                "markets": totals,
                "endpoint": url,
            })
        written.append((obs_date, saved))
        if only_first:
            break

    if not written:
        raise EmptyResult("새 기준일 데이터가 없습니다 — 기존 저장본 유지" + _reason_suffix(reasons))

    cutoff = (today - timedelta(days=FSC_RETENTION_DAYS)).isoformat()
    store.delete_observations_before(catalog.OBS_FSC_PRICE, cutoff)
    latest_date, latest_rows = written[-1]
    days = f" · {len(written)}일 보충" if len(written) > 1 else ""
    return f"{latest_date} {latest_rows}종목{days} (호출 {budget.used}회)" + _reason_suffix(reasons)


# DART 재무를 받을 종목 수 상한과 대상 기간. 호출 수 = 상한 / BATCH (+ 이전 연도 재시도).
DART_UNIVERSE_LIMIT = 150
DART_UNIVERSE_DAYS = 30
DART_CALL_BUDGET = 40
_CORP_CODES_MAX_AGE = timedelta(days=7)


def _dart_universe() -> list[str]:
    """최근 30일 수급 레이더에 등장한 종목 + 지금 화면에 걸린 종목."""
    since = (datetime.now(KST).date() - timedelta(days=DART_UNIVERSE_DAYS)).isoformat()
    codes = store.recent_observation_codes(catalog.OBS_RADAR, since, DART_UNIVERSE_LIMIT)
    for market, investor, trade_type, interval in RADAR_COMBINATIONS:
        snap = store.read_snapshot(catalog.snap_radar_scanner(market, investor, trade_type, interval))
        for row in ((snap.payload or {}).get("rows") or []) if snap else []:
            code = str(row.get("code") or "")
            if code and code not in codes:
                codes.append(code)
    return codes[:DART_UNIVERSE_LIMIT]


def _dart_corp_codes() -> dict[str, dict]:
    """고유번호 표. 일주일 안에 받은 것이 있으면 다시 받지 않습니다(수십 MB 파일)."""
    snap = store.read_snapshot(catalog.SNAP_DART_CORP_CODES)
    if snap and snap.payload and snap.collected_at and \
            datetime.now(timezone.utc) - snap.collected_at < _CORP_CODES_MAX_AGE:
        return snap.payload.get("codes") or {}
    codes = dart_service.fetch_corp_codes()
    store.put_snapshot(catalog.SNAP_DART_CORP_CODES, {"codes": codes, "count": len(codes)})
    return codes


def _latest_annual_year(today) -> int:
    """
    사업보고서가 나와 있을 가장 최근 사업연도.

    12월 결산 법인의 사업보고서 제출 기한은 다음 해 3월 말입니다. 4월 전에는
    작년 보고서가 없는 회사가 많으므로 재작년을 봅니다.
    """
    return today.year - 1 if today.month >= 4 else today.year - 2


def task_dart_fundamentals() -> str:
    """
    📑 DART 사업보고서 주요계정 — 수급 레이더에 오른 국내 종목.

    규칙
      - 최신 사업연도로 받고, 보고서가 없는 회사만 한 해 전으로 다시 받습니다. '보고서가 없다'는 최신 연도 호출이
        **성공했는데** 그 회사 행이 없는 경우입니다. 호출이 실패한 묶음(시간 초과·5xx)은 전년도로 다시 받지 않고
        이번 주기에서 뺍니다 — 예전에는 그 묶음 20개 회사의 저장된 최신 연도 재무를 한 해 전 자료로 덮었습니다(QA-077).
      - 저장본보다 이른 사업연도로는 덮지 않습니다(최신 연도 응답에서 행이 빠진 날에도 후퇴하지 않게).
      - 호출 예산(DART_CALL_BUDGET) 안에서만 진행합니다. 남은 종목은 다음 주기.
      - 이번에 받지 못한 종목은 이전 저장본을 유지합니다(부분 실패로 지우지 않음).
    """
    universe = _dart_universe()
    if not universe:
        raise EmptyResult("대상 종목이 없습니다 — 수급 레이더(radar_rankings)가 먼저 쌓여야 합니다")

    try:
        corp_map = _dart_corp_codes()
    except publicapi.MissingKey:
        raise EmptyResult("DART_API_KEY 미설정 — .env에 Open DART 인증키를 넣으세요") from None
    except publicapi.PublicApiError as exc:
        raise EmptyResult(f"고유번호 표를 받지 못했습니다 — {exc}") from None

    targets = {code: corp_map[code] for code in universe if code in corp_map}
    unmapped = [code for code in universe if code not in corp_map]  # ETF·ETN 등은 DART 대상이 아님

    budget = publicapi.CallBudget(DART_CALL_BUDGET)
    year = _latest_annual_year(datetime.now(KST).date())
    fetched: dict[str, dict] = {}
    reasons: list[str] = []
    # 직전 연도 호출이 성공한 회사. 다음(한 해 전) 연도는 이 안에서 행이 없던 회사만 봅니다.
    answered: list[str] = list(targets)

    for attempt_year in (year, year - 1):
        pending = [code for code in answered if code not in fetched]
        answered = []
        for start in range(0, len(pending), dart_service.BATCH):
            if not budget.take():
                reasons.append("호출 예산 소진 — 나머지는 다음 주기")
                break
            chunk = pending[start:start + dart_service.BATCH]
            try:
                rows = dart_service.fetch_accounts([targets[c]["corpCode"] for c in chunk], attempt_year)
            except publicapi.PublicApiError as exc:
                reasons.append(str(exc))
                continue
            answered += chunk
            for code, company in dart_service.group_by_company(rows).items():
                if code in targets and code not in fetched:
                    company["name"] = targets[code]["name"]
                    company["corpCode"] = targets[code]["corpCode"]
                    fetched[code] = company

    if not fetched:
        raise EmptyResult(f"0/{len(targets)} 종목 — 기존 저장본 유지" + _reason_suffix(reasons))

    previous = store.read_snapshot(catalog.SNAP_DART_FUNDAMENTALS)
    companies = dict(((previous.payload or {}).get("companies") or {}) if previous else {})
    kept_newer = [code for code, company in fetched.items() if _older_year(company, companies.get(code))]
    for code in kept_newer:
        del fetched[code]
    if not fetched:
        raise EmptyResult(f"0/{len(targets)} 종목 — 저장본이 더 최신이라 유지 {len(kept_newer)}" + _reason_suffix(reasons))
    companies.update(fetched)
    store.put_snapshot(catalog.SNAP_DART_FUNDAMENTALS, {
        "source": "금융감독원 Open DART 다중회사 주요계정 (사업보고서)",
        "companies": companies,
        "universe": len(universe),
        "unmapped": unmapped[:50],
    })
    return (f"{len(fetched)}/{len(targets)} 종목 ({_years_text(fetched, year)}, 호출 {budget.used}회)"
            + (f" · 저장본이 더 최신이라 유지 {len(kept_newer)}" if kept_newer else "")
            + (f" · DART 대상 아님 {len(unmapped)}" if unmapped else "") + _reason_suffix(reasons))


def _year_of(company: dict | None) -> int | None:
    try:
        return int(str((company or {}).get("bsnsYear") or ""))
    except ValueError:
        return None


def _older_year(new: dict, stored: dict | None) -> bool:
    """새로 받은 것이 저장본보다 이른 사업연도인가. 어느 한쪽 연도를 모르면 덮습니다(지금까지와 같음)."""
    new_year, stored_year = _year_of(new), _year_of(stored)
    return new_year is not None and stored_year is not None and new_year < stored_year


def _years_text(fetched: dict[str, dict], year: int) -> str:
    """결과 문구의 기준 연도 — 실제로 받은 연도별 종목 수. 전부 최신 연도면 예전 문구 그대로."""
    counts: dict[str, int] = {}
    for company in fetched.values():
        label = f"{company['bsnsYear']}년" if company.get("bsnsYear") else "연도 모름"
        counts[label] = counts.get(label, 0) + 1
    if set(counts) == {f"{year}년"}:
        return f"{year}년 기준"
    return " · ".join(f"{label} {n}" for label, n in sorted(counts.items(), key=lambda kv: (kv[0] != "연도 모름", kv[0]), reverse=True)) + " 기준"


