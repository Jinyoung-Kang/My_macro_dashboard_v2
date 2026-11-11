"""
app/tasks/info.py
polite 속도군 — 정보 수집(ADR 0035). 운영자 화면 '정보 수집'(/paper/info)만 읽고, Claude 결정 패킷·한국 규칙 계좌는 읽지 않습니다.

[info_blog_<이름>] 해외 블로그 14곳의 RSS → info_items (app/services/info_blogs — 피드 본문 우선, 없을 때만 글 페이지)
[info_waedge_brief] waedge 시장 글 목록 + 새 글 본문 → info_items (source waedge.brief)
[info_waedge_people] waedge 거장 견해 → 스냅샷 info.waedge.gurus, 같은 화면의 글 → info_items (source waedge.people)
[info_waedge_blogs] waedge 해외 블로그의 한국어 제목 → 원문 글 행의 title_ko
[info_wire_financialjuice] Financial Juice 속보 RSS(ADR 0037) → info_items (source wire.financialjuice, kind headline — 제목·링크·시각, 본문 없음)
[info_naver_flows] 네이버 투자자별 매매동향·외국인·기관 매매상위 → 스냅샷 info.naver.flows
[info_krx_daily] KRX 정보데이터시스템(로그인, ADR 0036) — 기준일의 투자자별 순매수 상위 → 관측치 krx_investor_rank(레이더가 읽음),
                 시장 합계·외국인 보유·공매도 거래·잔고 → 스냅샷 info.krx.daily. 거래일 18:30 뒤 그날 것을 한 번, 이미 받은 날은 외부 호출 없이 끝.

[일정] 출처마다 다음 실행을 구간 안에서 무작위로(app/tasks/polite). 기동 직후에는 받지 않고, 운영 서버(POLITE_FETCH_ENABLED)에서만 돕니다.
[실패 규칙] 받지 못하면 저장본을 그대로 둡니다 — 거부는 '거부됨'(그 호스트를 물러남), 형식이 다르면 '형식 바뀜'(polite.ShapeChanged).
"""
from __future__ import annotations

import random
from datetime import date, datetime, time, timezone
from typing import Callable

from .. import catalog, kst, krcalendar, store
from ..fetch import ladder, state
from ..services import info_blogs, info_naver, info_waedge, info_wire, krx_data
from ..services.info_text import ShapeError
from . import polite

WAEDGE_BRIEF_TASK = "info_waedge_brief"
WAEDGE_PEOPLE_TASK = "info_waedge_people"
WAEDGE_BLOGS_TASK = "info_waedge_blogs"
NAVER_TASK = "info_naver_flows"

WAEDGE_BRIEF_CADENCE = polite.Cadence(low_minutes=60, high_minutes=180)
WAEDGE_PEOPLE_CADENCE = polite.Cadence(low_minutes=480, high_minutes=960)
WAEDGE_BLOGS_CADENCE = polite.Cadence(low_minutes=240, high_minutes=480)
# 네이버 — 정규장(거래일 08:50~15:40 KST)에는 40~90분, 그 밖의 거래일 3~6시간, 쉬는 날 8~15시간.
NAVER_SESSION_CADENCE = polite.Cadence(low_minutes=40, high_minutes=90)
NAVER_OFF_CADENCE = polite.Cadence(low_minutes=180, high_minutes=360)
NAVER_HOLIDAY_CADENCE = polite.Cadence(low_minutes=480, high_minutes=900)
NAVER_SESSION = (time(8, 50), time(15, 40))
# Financial Juice 속보 — 피드가 최근 100건(한산할 때 약 11시간, 바쁠 때도 한두 시간 분량)이라 25~70분에 한 번이면 빠지지 않습니다.
WIRE_TASK = info_wire.TASK
WIRE_CADENCE = polite.Cadence(low_minutes=25, high_minutes=70)
KRX_TASK = "info_krx_daily"
# 받을 것이 없으면(이미 받은 날·쉬는 날) 외부를 부르지 않고 끝나므로 자주 깨도 출처 부하가 없습니다.
KRX_CADENCE = polite.Cadence(low_minutes=120, high_minutes=300)
# KRX가 그날 투자자별 자료를 확정해 싣는 시각(KST) — 이 뒤에야 그날을 기준일로 받습니다.
KRX_READY = time(18, 30)
# 공매도 잔고는 2~3거래일 늦게 공개됩니다 — 기준일 2거래일 앞부터 이만큼 거슬러 처음 나오는 날.
KRX_BALANCE_LAG_DAYS = (2, 3, 4)


def _shape(work: Callable[[], "str | polite.Partial"]) -> Callable[[], "str | polite.Partial"]:
    """서비스의 형식 오류를 polite의 '형식 바뀜'으로 바꿉니다."""
    def run():
        try:
            return work()
        except ShapeError as exc:
            raise polite.ShapeChanged(str(exc)) from exc
    return run


# ------------------------------------------------------------------ 블로그
def blog_task(blog: info_blogs.Blog) -> Callable[[], str]:
    """블로그 하나의 태스크 함수."""
    cadence = polite.Cadence(low_minutes=blog.minutes[0], high_minutes=blog.minutes[1])

    def work() -> "str | polite.Partial":
        report = info_blogs.collect_report(blog)
        if report.page_issue:
            return polite.Partial(report.detail, report.page_issue)       # 글 페이지의 본문 자리가 바뀐 것으로 보임 — '형식 바뀜'(QA-391)
        return report.detail

    def run() -> str:
        return polite.scheduled(blog.task, cadence, _shape(work))

    run.__name__ = f"task_{blog.task}"
    return run


# ------------------------------------------------------------------ waedge
def task_info_waedge_brief() -> str:
    """waedge 시장 글 목록과 새 글 본문 → info_items."""
    def work() -> str:
        listed, bodies, blocked = info_waedge.collect_list(
            info_waedge.BRIEF_URL, source="waedge.brief", kind="brief", bodies_per_run=info_waedge.BRIEF_BODIES_PER_RUN)
        if blocked is not None:
            raise blocked
        return f"waedge 시장 글 {listed}건 · 본문 새로 받음 {bodies}"
    return polite.scheduled(WAEDGE_BRIEF_TASK, WAEDGE_BRIEF_CADENCE, _shape(work))


def task_info_waedge_people() -> str:
    """waedge 거장 견해 → 스냅샷 info.waedge.gurus, 같은 화면의 글 → info_items."""
    def work() -> "str | polite.Partial":
        from ..fetch import ladder

        now = datetime.now(timezone.utc)
        page = ladder.fetch(info_waedge.PEOPLE_URL)
        parsed = info_waedge.parse_gurus(page.text())
        store.put_snapshot(catalog.SNAP_INFO_WAEDGE_GURUS, info_waedge.guru_snapshot(parsed, fetch_tier=page.tier, now=now))
        detail = f"waedge 거장 견해 {len(parsed['gurus'])}명(기준일 {parsed['asOf'] or '모름'}) · 계층 {page.tier}"
        try:
            listed, bodies, blocked = info_waedge.collect_list(
                info_waedge.PEOPLE_URL, source="waedge.people", kind="guru",
                bodies_per_run=info_waedge.PEOPLE_BODIES_PER_RUN, listed=page)
        except ShapeError as exc:
            return polite.Partial(detail, str(exc))
        if blocked is not None:
            raise blocked
        return f"{detail} · 글 {listed}건 · 본문 새로 받음 {bodies}"
    return polite.scheduled(WAEDGE_PEOPLE_TASK, WAEDGE_PEOPLE_CADENCE, _shape(work))


def task_info_waedge_blogs() -> str:
    """waedge 해외 블로그의 한국어 제목 → 원문 글 행."""
    def work() -> str:
        from ..fetch import ladder

        page = ladder.fetch(info_waedge.BLOGS_URL)
        rows = info_waedge.parse_blog_rows(page.text())
        info_waedge.store_blog_titles(rows, fetch_tier=page.tier)
        return f"waedge 해외 블로그 한국어 제목 {len(rows)}건 · 계층 {page.tier}"
    return polite.scheduled(WAEDGE_BLOGS_TASK, WAEDGE_BLOGS_CADENCE, _shape(work))


# ------------------------------------------------------------------ 속보
def task_info_wire_financialjuice() -> str:
    """Financial Juice 속보 RSS → info_items(제목·링크·시각)."""
    return polite.scheduled(WIRE_TASK, WIRE_CADENCE, _shape(lambda: info_wire.collect()))


# ------------------------------------------------------------------ 네이버
def naver_cadence(now: datetime | None = None) -> polite.Cadence:
    """지금이 정규장(거래일 08:50~15:40 KST)이면 짧게, 장 밖이면 길게, 쉬는 날이면 더 길게."""
    local = (now or datetime.now(timezone.utc)).astimezone(kst.KST)
    if not krcalendar.is_trading_day(local.date()):
        return NAVER_HOLIDAY_CADENCE
    if NAVER_SESSION[0] <= local.time() <= NAVER_SESSION[1]:
        return NAVER_SESSION_CADENCE
    return NAVER_OFF_CADENCE


def task_info_naver_flows() -> str:
    """네이버 투자자별 매매동향·매매상위 → 스냅샷 info.naver.flows."""
    def work() -> "str | polite.Partial":
        previous = store.read_snapshot(catalog.SNAP_INFO_NAVER_FLOWS)
        unsent: list[str] = []
        snapshot = info_naver.collect(previous.payload if previous else None, unsent=unsent)
        store.put_snapshot(catalog.SNAP_INFO_NAVER_FLOWS, snapshot)
        got = 6 - len(snapshot["failed"])
        detail = f"네이버 매매동향·매매상위 {got}/6 · 계층 {snapshot['fetchTier']}"
        estimated = [f"{inv}.{mkt}" for inv, by in snapshot["rankings"].items() for mkt, part in by.items()
                     if part.get("estimated") and not part.get("isStale")]
        if estimated:
            detail += f" · 장중 추정 순위 {len(estimated)}"
        if snapshot["failed"]:
            detail += f" · 이어받음 {', '.join(snapshot['failed'])}"
        if snapshot["shapeErrors"]:
            return polite.Partial(detail, "; ".join(snapshot["shapeErrors"][:2]))
        # 형식은 맞는데 받지 못한 부분(404·5xx) — 그 부분은 '이전 값'으로 남으므로 '정상'으로 적지 않습니다(QA-391). 예산·시간이 모자라
        # 보내지 않은 부분은 출처의 실패가 아니라 셈에서 뺍니다.
        missed = [name for name in snapshot["failed"] if name not in unsent]
        if missed:
            return polite.Partial(detail, f"받지 못함: {', '.join(missed)}", kind=polite.PARTIAL_FAILED)
        return detail
    return polite.scheduled(NAVER_TASK, naver_cadence, _shape(work))


# ------------------------------------------------------------------ KRX 정보데이터시스템
def krx_target_day(now: datetime | None = None) -> date:
    """받을 기준일 — 거래일 18:30(KST) 뒤면 그날, 아니면 앞 거래일."""
    local = (now or datetime.now(timezone.utc)).astimezone(kst.KST)
    if krcalendar.is_trading_day(local.date()) and local.time() >= KRX_READY:
        return local.date()
    return krcalendar.previous_trading_day(local.date())


def task_info_krx_daily() -> str:
    """KRX 정보데이터시스템(로그인) — 투자자별 순매수 상위·시장 합계·외국인 보유·공매도 거래·잔고."""
    return polite.scheduled(KRX_TASK, KRX_CADENCE, _shape(lambda: collect_krx()))


def _krx_login(fetch) -> None:
    """
    KRX에 로그인합니다. KRX가 로그인을 **거절**하면(비밀번호 변경 요구·그 밖의 거절 코드) 그 호스트를 길게 닫고 거부로 올립니다(QA-390).

    거절은 사람이 고쳐야 풀립니다(krx.co.kr에서 비밀번호를 바꾸고 서버 .env를 고침). 닫지 않으면 태스크가 깰 때마다(2~5시간) 로그인 요청을
    다시 보내 계정이 막힐 수 있습니다. 닫힘은 사람 확인을 만났을 때와 같은 규칙(12~24시간 — state.note_human_check)이고, 닫힌 동안에는
    받기 계층이 그 호스트로 아무것도 보내지 않습니다. 일시 실패(5xx·시간 초과)와 계정 값이 설정되지 않은 경우(보낸 요청 없음)는 닫지 않습니다.

    :raises ladder.FetchRejected: KRX가 로그인을 거절해 닫음(사유에 계정 값을 싣지 않음)
    :raises krx_data.KrxLoginError: 계정 값이 설정되지 않음
    """
    try:
        krx_data.login(fetch)
    except krx_data.KrxLoginError as exc:
        if exc.code is None:
            raise
        why = f"KRX 로그인 거절({exc.code})"
        if exc.code == "CD010":
            why += " — 비밀번호 변경 필요(krx.co.kr에서 바꾼 뒤 서버 .env를 고침)"
        raise ladder.FetchRejected(state.note_human_check(krx_data.HOST, why)) from exc


def collect_krx(*, fetch=ladder.fetch, now: datetime | None = None, rng: random.Random | None = None) -> "str | polite.Partial":
    """
    기준일 자료를 받아 저장합니다 → 실행 기록 한 줄(일부의 모양이 다르거나 일부를 받지 못했으면 polite.Partial).

    이미 그 기준일을 빠짐없이 받았으면 외부를 부르지 않고 끝납니다. 같은 기준일을 다시 받을 때는 **받지 못한 부분만** 받습니다 — 직전 저장본의
    ``failed``에 남은 부분과, 그날 관측치가 아직 없는 (시장, 투자주체)의 순위(QA-390). 받지 못한 부분은 직전 저장본의 그 부분을 이어받고
    ``isStale``을 답니다(부분마다 제 기준일을 적어 다른 날의 값이 이 날 값으로 보이지 않게). 순매수 상위는 받은 (시장, 투자주체)만 그 날짜를
    교체합니다. 출처가 거부하거나 하루 예산·시간이 떨어지면 남은 부분은 보내지 않습니다.
    :raises ShapeError: 모든 부분의 모양이 다름
    :raises krx_data.KrxLoginError: 계정 값이 설정되지 않음
    :raises ladder.FetchRejected: 출처가 거부(받은 것은 저장한 뒤), 또는 KRX가 로그인을 거절해 닫음
    :raises ladder.FetchSkipped: 하루 예산·시간이 모자라 하나도 받지 못함
    """
    now = now or datetime.now(timezone.utc)
    day = krx_target_day(now)
    iso, compact = day.isoformat(), day.strftime("%Y%m%d")
    previous = store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY)
    prev = previous.payload if previous and isinstance(previous.payload, dict) else {}
    same_day = prev.get("asOf") == iso
    if same_day and not prev.get("failed"):
        return f"KRX 기준일 {iso} 이미 받음 — 외부 호출 0회"
    # 같은 기준일을 다시 받는 실행이면 직전에 받지 못한 부분의 이름, 새 기준일이면 None(전부 받음).
    pending: set[str] | None = {str(name) for name in prev.get("failed") or []} if same_day else None

    def wanted(name: str) -> bool:
        return pending is None or name in pending

    parts: dict[str, dict] = {"totals": {}, "foreign": {}, "shortTrades": {}, "shortBalances": {}}
    ranks: dict[str, int] = {}
    jobs: list[tuple[str, str, str | None]] = []
    for market in krx_data.MARKETS:
        for investor in krx_data.INVESTORS:
            # 순위는 받을 때마다 (시장, 투자주체) 단위로 그날을 통째로 교체합니다 — 그날 관측치가 있으면 이미 받은 쌍입니다.
            stored = len(store.read_observations(catalog.OBS_KRX_INVESTOR_RANK, obs_date=iso,
                                                 filters={"market": market, "investor": investor}))
            if stored:
                ranks[f"{market}|{investor}"] = stored
            else:
                jobs.append(("rank", market, investor))
    for kind in ("totals", "foreign", "shortTrades"):
        for market in krx_data.MARKETS:
            if wanted(f"{kind}.{market}"):
                jobs.append((kind, market, None))
            elif (prev.get(kind) or {}).get(market) is not None:
                parts[kind][market] = prev[kind][market]          # 오늘 이미 받은 부분 — 그대로
    balance_markets = []
    for market in krx_data.MARKETS:
        if wanted(f"shortBalances.{market}"):
            balance_markets.append(market)
        elif (prev.get("shortBalances") or {}).get(market) is not None:
            parts["shortBalances"][market] = prev["shortBalances"][market]
    (rng or random).shuffle(jobs)                  # 사람이 화면을 오가는 순서처럼 매번 다르게

    if jobs or balance_markets:
        _krx_login(fetch)

    failed: list[str] = []
    missed: list[str] = []                          # failed 가운데 보냈는데 받지 못한 부분(404·5xx·빈 답) — 출처 상태 '받지 못함'의 근거
    shape_errors: list[str] = []
    blocked: ladder.FetchRejected | None = None
    skipped: ladder.FetchSkipped | None = None     # 하루 예산·시간이 떨어짐 — 남은 부분은 보내지 않습니다(부분마다 지연만 쌓임)

    def remember_failure(name: str, kind: str, market: str) -> None:
        failed.append(name)
        old = (prev.get(kind) or {}).get(market)
        if old is not None and kind in parts:
            parts[kind][market] = {**old, "isStale": True}

    for kind, market, investor in jobs:
        name = f"{kind}.{market}" + (f".{investor}" if investor else "")
        if blocked is not None or skipped is not None:
            remember_failure(name, kind, market)
            continue
        try:
            if kind == "rank":
                rows = krx_data.parse_rankings(
                    krx_data.data("dbms/MDC/STAT/standard/MDCSTAT02401", krx_data.ranking_params(market, investor, compact), fetch),
                    market=market, investor=investor, day=iso)
                if rows:
                    store.replace_observations(catalog.OBS_KRX_INVESTOR_RANK, iso, f"{market}|{investor}|", rows,
                                               entity_key="entity")
                    ranks[f"{market}|{investor}"] = len(rows)
                else:
                    failed.append(name)          # 휴장·아직 집계 전 — 그날 행을 비우지 않습니다
                    missed.append(name)
                continue
            if kind == "totals":
                rows = krx_data.parse_totals(
                    krx_data.data("dbms/MDC/STAT/standard/MDCSTAT02201", krx_data.totals_params(market, compact), fetch))
            elif kind == "foreign":
                rows = krx_data.parse_foreign(
                    krx_data.data("dbms/MDC/STAT/standard/MDCSTAT03701", krx_data.foreign_params(market, compact), fetch))
            else:
                rows = krx_data.parse_short_trades(
                    krx_data.data("dbms/MDC/STAT/srt/MDCSTAT30101", krx_data.short_trade_params(market, compact), fetch))
            if rows:
                parts[kind][market] = {"asOf": iso, "rows": rows}
            else:
                remember_failure(name, kind, market)
                missed.append(name)
        except ShapeError as exc:
            shape_errors.append(f"{name}: {exc}")
            remember_failure(name, kind, market)
        except ladder.FetchFailed:
            remember_failure(name, kind, market)
            missed.append(name)
        except ladder.FetchSkipped as exc:
            skipped = exc
            remember_failure(name, kind, market)
        except ladder.FetchRejected as exc:
            blocked = exc
            remember_failure(name, kind, market)

    # 공매도 잔고 — 늦게 공개되어 기준일 2거래일 앞부터 거슬러 처음 나오는 날.
    lagged = krcalendar.previous_trading_days(day, max(KRX_BALANCE_LAG_DAYS))
    for market in balance_markets:
        name = f"shortBalances.{market}"
        found = False
        asked = True                   # 보냈는데 받지 못했는가(404·5xx·세 날짜 모두 빈 답) — 형식·예산·거부로 끝난 것은 따로 셉니다
        for lag in KRX_BALANCE_LAG_DAYS:
            if blocked is not None or skipped is not None:
                asked = False
                break
            when = lagged[lag - 1]
            try:
                rows = krx_data.parse_short_balances(krx_data.data(
                    "dbms/MDC/STAT/srt/MDCSTAT30501", krx_data.short_balance_params(market, when.strftime("%Y%m%d")), fetch))
            except ShapeError as exc:
                shape_errors.append(f"{name}: {exc}")
                asked = False
                break
            except ladder.FetchFailed:
                break
            except ladder.FetchSkipped as exc:
                skipped = exc
                asked = False
                break
            except ladder.FetchRejected as exc:
                blocked = exc
                asked = False
                break
            if rows:
                parts["shortBalances"][market] = {"asOf": when.isoformat(), "rows": rows}
                found = True
                break
        if not found:
            remember_failure(name, "shortBalances", market)
            if asked:
                missed.append(name)

    got = len(ranks) + sum(1 for kind in ("totals", "foreign", "shortTrades", "shortBalances")
                           for part in parts[kind].values() if not part.get("isStale"))
    if got == 0 and blocked is None:
        if shape_errors:
            raise ShapeError("; ".join(shape_errors[:2]))
        if skipped is not None:
            raise skipped                           # 보내지 못했을 뿐 — 형식 바뀜이 아닙니다
        raise ShapeError(f"KRX 기준일 {iso}의 자료가 하나도 없음(휴장이거나 아직 집계 전)")
    store.put_snapshot(catalog.SNAP_INFO_KRX_DAILY, {
        "contract": 1,
        "asOf": iso,
        "generatedAt": now.isoformat(timespec="seconds"),
        "collectedAt": kst.stamp(now),
        "source": krx_data.SOURCE,
        "sourceUrl": krx_data.SOURCE_URL,
        "fetchTier": "impersonate",
        "rankings": ranks,
        **parts,
        "failed": failed,
        "shapeErrors": shape_errors[:4],
    })
    if blocked is not None:
        raise blocked
    detail = (f"KRX 기준일 {iso} · 순매수 상위 {len(ranks)}/12 · 시장 합계·외국인 보유·공매도 거래 "
              f"{sum(1 for k in ('totals', 'foreign', 'shortTrades') for p in parts[k].values() if not p.get('isStale'))}/6 · "
              f"공매도 잔고 {sum(1 for p in parts['shortBalances'].values() if not p.get('isStale'))}/2")
    if failed:
        detail += f" · 못 받음 {len(failed)}"
    if shape_errors:
        return polite.Partial(detail, "; ".join(shape_errors[:2]))
    if missed:
        # 형식은 맞는데 받지 못한 부분 — 그 부분은 '이전 값'이거나 비어 있으므로 '정상'으로 적지 않습니다(QA-391).
        more = f" 외 {len(missed) - 4}" if len(missed) > 4 else ""
        return polite.Partial(detail, f"받지 못함: {', '.join(missed[:4])}{more}", kind=polite.PARTIAL_FAILED)
    return detail


def cadences() -> list[dict]:
    """polite 태스크마다의 간격(분) — 정보 수집 화면의 '메커니즘'용. 네이버는 시각에 따라 바뀌어 세 구간을 함께 적습니다."""
    from .econ_calendar import TRADINGVIEW_CADENCE, TRADINGVIEW_TASK

    def row(task: str, cadence: polite.Cadence, note: str | None = None) -> dict:
        return {"task": task, "lowMinutes": cadence.low_minutes, "highMinutes": cadence.high_minutes, "note": note}

    out = [row(TRADINGVIEW_TASK, TRADINGVIEW_CADENCE)]
    out += [row(blog.task, polite.Cadence(blog.minutes[0], blog.minutes[1])) for blog in info_blogs.BLOGS]
    out += [row(WAEDGE_BRIEF_TASK, WAEDGE_BRIEF_CADENCE), row(WAEDGE_PEOPLE_TASK, WAEDGE_PEOPLE_CADENCE),
            row(WAEDGE_BLOGS_TASK, WAEDGE_BLOGS_CADENCE),
            row(WIRE_TASK, WIRE_CADENCE, "피드 한 번에 최근 100건 — 제목·링크·시각만(본문 없는 출처)"),
            row(NAVER_TASK, NAVER_SESSION_CADENCE,
                f"정규장(거래일 08:50~15:40) {NAVER_SESSION_CADENCE.low_minutes:.0f}~{NAVER_SESSION_CADENCE.high_minutes:.0f}분 · "
                f"장 밖 {NAVER_OFF_CADENCE.low_minutes:.0f}~{NAVER_OFF_CADENCE.high_minutes:.0f}분 · "
                f"쉬는 날 {NAVER_HOLIDAY_CADENCE.low_minutes:.0f}~{NAVER_HOLIDAY_CADENCE.high_minutes:.0f}분"),
            row(KRX_TASK, KRX_CADENCE, "거래일 18:30 뒤 그날 것을 한 번 — 이미 받은 날은 외부 호출 0회")]
    return out

