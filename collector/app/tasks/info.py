"""
app/tasks/info.py
polite 속도군 — 정보 수집(ADR 0035). 운영자 화면 '정보 수집'(/paper/info)만 읽고, Claude 결정 패킷·한국 규칙 계좌는 읽지 않습니다.

[info_blog_<이름>] 해외 블로그 14곳의 RSS → info_items (app/services/info_blogs — 피드 본문 우선, 없을 때만 글 페이지)
[info_waedge_brief] waedge 시장 글 목록 + 새 글 본문 → info_items (source waedge.brief)
[info_waedge_people] waedge 거장 견해 → 스냅샷 info.waedge.gurus, 같은 화면의 글 → info_items (source waedge.people)
[info_waedge_blogs] waedge 해외 블로그의 한국어 제목 → 원문 글 행의 title_ko
[info_naver_flows] 네이버 투자자별 매매동향·외국인·기관 매매상위 → 스냅샷 info.naver.flows

[일정] 출처마다 다음 실행을 구간 안에서 무작위로(app/tasks/polite). 기동 직후에는 받지 않고, 운영 서버(POLITE_FETCH_ENABLED)에서만 돕니다.
[실패 규칙] 받지 못하면 저장본을 그대로 둡니다 — 거부는 '거부됨'(그 호스트를 물러남), 형식이 다르면 '형식 바뀜'(polite.ShapeChanged).
"""
from __future__ import annotations

from datetime import datetime, time, timezone
from typing import Callable

from .. import catalog, kst, krcalendar, store
from ..services import info_blogs, info_naver, info_waedge
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

    def run() -> str:
        return polite.scheduled(blog.task, cadence, _shape(lambda: info_blogs.collect(blog)))

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
        snapshot = info_naver.collect(previous.payload if previous else None)
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
        return detail
    return polite.scheduled(NAVER_TASK, naver_cadence, _shape(work))
