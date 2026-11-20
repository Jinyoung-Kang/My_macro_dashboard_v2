"""
app/tasks/security.py
flex 그룹 — KISA 보호나라 보안공지(ADR 0046). 운영자 화면 '보안 공지'의 원자료이고, 판정(해당·패치됨·확인 필요·무관)은 백엔드가 읽을 때 합니다.

[한 실행] 목록 한 쪽 → 처음 본 글 넣기 → 상세 최대 ``DETAIL_LIMIT``건. 요청과 요청 사이는 3~6초(무작위)를 쉽니다.
  - 평소에는 목록 1쪽. 처음 ``BACKFILL_DAYS``일을 메우는 동안은 아직 못 본 번호가 있는 다음 쪽(번호 칸으로 셈 — 그 사이 새 글이 올라오면
    쪽이 밀려 겹쳐 읽을 뿐 건너뛰지 않음). 메우는 동안에도 1쪽은 평소 간격마다 한 번 읽습니다(새 글을 늦게 보지 않게).
  - 메우기는 번호 칸이 있는 글 가운데 가장 오래된 게시일이 ``BACKFILL_DAYS``일 전보다 오래되거나, 번호 1번까지 읽었거나, ``MAX_BACKFILL_PAGE``쪽에
    닿으면 끝납니다. 그보다 오래된 글은 넣되 상세는 받지 않습니다(skipped).
  - 한계: 메우기가 끝난 뒤 수집이 오래 멈춰 새 글이 1쪽을 넘게 쌓이면 그 사이 글은 다시 찾지 않습니다(실행 기록에 못 본 번호 수만 남김).
  - 상세는 아직 받지 않은 글·받지 못한 글(시도 ``MAX_ATTEMPTS``번까지)을 최근 글부터. 틀이 깨진 상세는 '형식 바뀜'.
[언제] fetch_schedule ``kisa_security_notices/next``(flex 틱이 봄). 처음(일정 없음)에는 받지 않고 2~25분 뒤로 정합니다. 평소 3~6시간,
  메우는 동안(목록이 덜 찼거나 받을 상세가 남음)만 20~40분. 1쪽 다시 읽기는 ``kisa_security_notices/page1``.
[출처 상태] 실행마다 ``store.note_source_state``(ok·blocked·format·failed) — 백엔드 SourceAlertJob의 끊김·형식 바뀜 알림과 수집 현황이 그대로
  붙습니다(ADR 0046 결정 4). '오래 못 받음'은 평소 간격 상한의 3배.
[실패 규칙] 목록을 받지 못하면 EmptyResult(저장한 글 그대로). 출처가 거부하면(403·429 — 공용 세션의 거부 래치) 그 예외를 그대로 올려
  실행 기록에 '거부됨'으로 남깁니다. 상세 하나의 실패는 나머지를 멈추지 않습니다(거부만 그 실행을 멈춤).
"""
from __future__ import annotations

import logging
import random
import time
from datetime import date, datetime, timedelta, timezone

import requests

from .. import http, kst, store
from ..http import get_session
from ..services import kisa_notices
from ..services.info_text import ShapeError
from . import flex
from .base import EmptyResult

logger = logging.getLogger(__name__)

TASK_NAME = "kisa_security_notices"
SCHEDULE_ITEM = "next"
PAGE1_ITEM = "page1"

DETAIL_LIMIT = 8                      # 한 실행의 상세 요청 상한
MAX_ATTEMPTS = 3                      # 상세 한 건의 시도 상한(받지 못함·틀 깨짐)
BACKFILL_DAYS = 90
MAX_BACKFILL_PAGE = 60                # 메우기가 이 쪽을 넘지 않음(쪽 크기가 바뀌어 셈이 어긋나도 끝없이 내려가지 않게)
PAGE_SIZE = 10                        # 목록 한 쪽의 번호 줄 수(고정 공지는 세지 않음)
GAP_SECONDS = (3.0, 6.0)              # 요청 사이 쉼
NORMAL_MINUTES = (180.0, 360.0)
BACKFILL_MINUTES = (20.0, 40.0)
FIRST_MINUTES = (2.0, 25.0)
STALE_FACTOR = 3
REQUEST_TIMEOUT = 20.0
# 새 상세를 더 시작하지 않는 경과 시간(초) — flex 상한(runner.TASK_DEADLINE_SECONDS["flex"] = 600초)보다 넉넉히 짧게.
TIME_LIMIT_SECONDS = 300.0

# 시험이 난수·시계·쉼을 바꿔 끼우는 자리입니다.
_rng = random.Random()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clock() -> float:
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def due() -> bool:
    """flex 틱이 이 태스크를 부를 때인가 — 일정이 없거나 다음 시각이 지났으면 참(표만 읽음)."""
    when = flex.due_map(TASK_NAME).get(SCHEDULE_ITEM)
    return when is None or when <= flex._utcnow()


def _today_kst(now: datetime) -> date:
    return now.astimezone(kst.KST).date()


def _later(now: datetime, minutes: tuple[float, float]) -> datetime:
    return now + timedelta(minutes=_rng.uniform(*minutes))


class _Failed(Exception):
    """받지 못함(연결·HTTP 상태) — 출처 상태 'failed'."""


def _get(url: str) -> bytes:
    """
    공용 세션으로 한 번 받습니다 → 본문.

    :raises http.SourceRejected: 출처가 거부함(공용 세션의 거부 래치)
    :raises _Failed: 연결 오류·200이 아닌 상태
    """
    try:
        response = get_session().get(url, timeout=REQUEST_TIMEOUT)
    except http.SourceRejected:
        raise
    except requests.exceptions.RequestException as exc:
        raise _Failed(http.brief_error(exc)) from None
    if response.status_code != 200:
        raise _Failed(f"HTTP {response.status_code}")
    return response.content


def _backfill_page(bounds: dict, cutoff: date) -> int | None:
    """메우기로 읽을 쪽(1부터) — 메우기가 끝났으면 None."""
    max_no, min_no, oldest = bounds["maxNo"], bounds["minNo"], bounds["oldestNumbered"]
    if max_no is None or min_no is None:
        return 1
    if (oldest is not None and oldest < cutoff) or min_no <= 1:
        return None
    page = (int(max_no) - (int(min_no) - 1)) // PAGE_SIZE + 1
    return page if page <= MAX_BACKFILL_PAGE else None


def _note(status: str, reason: str | None) -> None:
    try:
        store.note_source_state(TASK_NAME, status, reason, stale_after_minutes=int(NORMAL_MINUTES[1] * STALE_FACTOR))
    except Exception as exc:  # noqa: BLE001
        logger.warning("출처 상태를 남기지 못함(%s): %s", TASK_NAME, exc)


def task_kisa_security_notices() -> str:
    """보호나라 보안공지 목록 한 쪽과 상세 몇 건 → 표 security_notices·security_notice_rows(모듈 설명)."""
    now = _now()
    when = flex.due_map(TASK_NAME).get(SCHEDULE_ITEM)
    if when is None:
        first = _later(now, FIRST_MINUTES)
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, first)
        raise EmptyResult(f"일정 처음 정함 — 첫 요청 {kst.stamp(first)} · 외부 호출 0회")
    if when > now:
        raise EmptyResult(f"다음 요청 {kst.stamp(when)} — 아직 때가 아님 · 외부 호출 0회")

    # 먼저 다음 시각을 적어 둡니다(이 실행 중에 끊겨도 다음 틱이 곧바로 다시 묻지 않게). 끝에서 메우기 여부로 다시 정합니다.
    flex.set_due(TASK_NAME, SCHEDULE_ITEM, _later(now, NORMAL_MINUTES))
    cutoff = _today_kst(now) - timedelta(days=BACKFILL_DAYS)
    bounds = store.security_list_bounds()
    backfill = _backfill_page(bounds, cutoff)
    page1_due = flex.due_map(TASK_NAME).get(PAGE1_ITEM)
    page = 1 if backfill is None or page1_due is None or page1_due <= now else backfill
    if page == 1:
        flex.set_due(TASK_NAME, PAGE1_ITEM, _later(now, NORMAL_MINUTES))
    started = _clock()

    try:
        items = kisa_notices.parse_list(_get(kisa_notices.list_url(page)))
        if page == 1 and not items:
            raise ShapeError("목록 1쪽에 글이 없음")
    except http.SourceRejected as exc:
        _note("blocked", str(exc))
        raise
    except _Failed as exc:
        _note("failed", f"목록 {page}쪽 받지 못함 — {exc}")
        _reschedule(now, backfill is not None)
        raise EmptyResult(f"목록 {page}쪽 받지 못함 — {exc} · 저장한 글 그대로") from None
    except ShapeError as exc:
        _note("format", f"목록 {page}쪽 모양이 다름 — {exc}")
        _reschedule(now, backfill is not None)
        raise EmptyResult(f"목록 {page}쪽 모양이 다름 — {exc} · 저장한 글 그대로") from None

    new = store.upsert_security_notices(items, first_page=page == 1, detail_since=cutoff)
    issues: list[tuple[str, str]] = []
    # 메우기 쪽의 셈이 맞으면 그 쪽의 가장 큰 번호가 아직 못 본 가장 큰 번호(지금 가장 작은 번호 - 1) 이상입니다. 작으면 그 사이를 건너뛴 것 —
    # 쪽 크기가 바뀐 것이라 '형식 바뀜'으로 남깁니다(받은 글은 넣음).
    numbers = [item.list_no for item in items if item.list_no is not None]
    if page > 1 and numbers and bounds["minNo"] is not None and max(numbers) < int(bounds["minNo"]) - 1:
        issues.append(("format", f"목록 {page}쪽이 번호 {int(bounds['minNo']) - 1 - max(numbers)}개를 건너뜀 — 쪽 크기가 바뀐 듯"))
    # 1쪽의 가장 작은 번호가 앞서 본 가장 큰 번호보다 2 넘게 크면 그 사이 글을 못 봤습니다(수집기가 오래 멈춰 새 글이 한 쪽을 넘게 쌓임).
    # 메우기 범위 밖이라 실행 기록에만 남깁니다(출처의 탓이 아님 — 출처 상태는 그대로).
    missed = (min(numbers) - int(bounds["maxNo"]) - 1) if page == 1 and numbers and bounds["maxNo"] is not None else 0

    ok = failed = shaped = 0
    rejected: http.SourceRejected | None = None
    for ntt_id in store.security_pending_details(DETAIL_LIMIT, max_attempts=MAX_ATTEMPTS, since=cutoff):
        if _clock() - started > TIME_LIMIT_SECONDS:
            break
        _sleep(_rng.uniform(*GAP_SECONDS))
        try:
            detail = kisa_notices.parse_detail(_get(kisa_notices.detail_url(ntt_id)))
        except http.SourceRejected as exc:
            rejected = exc
            break
        except _Failed as exc:
            failed += 1
            store.mark_security_detail_failed(ntt_id, f"받지 못함 — {exc}")
            issues.append(("failed", f"상세 받지 못함 — {exc}"))
            continue
        except ShapeError as exc:
            shaped += 1
            store.mark_security_detail_failed(ntt_id, f"모양이 다름 — {exc}")
            issues.append(("format", f"상세 모양이 다름 — {exc}"))
            continue
        store.save_security_detail(ntt_id, detail, now=_now())
        ok += 1

    remaining = store.security_pending_details(1, max_attempts=MAX_ATTEMPTS, since=cutoff)
    still_backfilling = _backfill_page(store.security_list_bounds(), cutoff) is not None
    next_at = _reschedule(now, still_backfilling or bool(remaining))

    if rejected is not None:
        _note("blocked", str(rejected))
    elif any(kind == "format" for kind, _ in issues):
        _note("format", next(reason for kind, reason in issues if kind == "format"))
    elif failed:
        _note("failed", next(reason for kind, reason in issues if kind == "failed"))
    else:
        _note("ok", None)

    parts = [f"목록 {page}쪽 {len(items)}건(처음 본 글 {new})", f"상세 {ok}건"]
    if failed or shaped:
        parts.append(f"상세 실패 {failed + shaped}건(받지 못함 {failed}·모양이 다름 {shaped})")
    parts.extend(reason for kind, reason in issues if reason.startswith("목록"))
    if missed > 0:
        parts.append(f"앞서 본 글과 1쪽 사이 번호 {missed}개를 못 봄(수집이 오래 멈춤)")
    if rejected is not None:
        parts.append("출처 거부로 상세 멈춤")
    if still_backfilling:
        parts.append(f"{BACKFILL_DAYS}일 메우는 중")
    elif remaining:
        parts.append("받을 상세 남음")
    parts.append(f"다음 {kst.stamp(next_at)}")
    return " · ".join(parts)


def _reschedule(now: datetime, busy: bool) -> datetime:
    """다음 실행 시각 — 메우는 중이면 20~40분, 아니면 3~6시간."""
    next_at = _later(now, BACKFILL_MINUTES if busy else NORMAL_MINUTES)
    flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_at)
    return next_at
