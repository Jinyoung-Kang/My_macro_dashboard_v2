"""
app/tasks/security.py
flex 그룹 — KISA 보호나라 보안공지(ADR 0046). 운영자 화면 '보안 공지'의 원자료이고, 판정(해당·패치됨·확인 필요·무관)은 백엔드가 읽을 때 합니다.

[한 실행] 목록 1쪽 → (메우는 중이면) 메우기 쪽 → 처음 본 글 넣기 → 상세 최대 ``DETAIL_LIMIT``건. 요청과 요청 사이는 3~6초(무작위)를 쉽니다.
  실행 전체의 시간 예산은 ``TIME_LIMIT_SECONDS``(넘으면 새 요청을 시작하지 않음 — flex 상한 600초 안).
  - 목록 1쪽은 늘 읽습니다. 처음 ``BACKFILL_DAYS``일을 메우는 동안은 같은 실행에서 아직 못 본 번호가 있는 다음 쪽도 읽습니다(목록 요청 최대 2 —
    쪽은 1쪽을 넣은 뒤의 번호 칸으로 셈. 그 사이 새 글이 올라와도 1쪽이 함께 들어와 셈이 맞음).
  - 메우기는 번호 칸이 있는 글 가운데 가장 오래된 게시일이 ``BACKFILL_DAYS``일 전보다 오래되거나, 번호 1번까지 읽었거나, ``MAX_BACKFILL_PAGE``쪽에
    닿으면 끝납니다. 그보다 오래된 글은 넣되 상세는 받지 않습니다(skipped). 메우기 쪽을 받지 못해도 1쪽과 상세는 그대로 이어 갑니다.
  - 한계: 메우기가 끝난 뒤 수집이 오래 멈춰 새 글이 1쪽을 넘게 쌓이면 그 사이 글은 다시 찾지 않습니다(실행 기록에 못 본 번호 수만 남김).
  - 상세는 아직 받지 않은 글·받지 못한 글(시도 ``MAX_ATTEMPTS``번까지)을 최근 글부터. 틀이 깨진 상세는 '형식 바뀜'.
[언제] fetch_schedule ``kisa_security_notices/next``(flex 틱이 봄). KST 하루를 [00,06)·[06,12)·[12,18)·[18,24) 넷으로 나누고, 다음 시각은 늘
  지금 실행이 속한 구간의 **다음 구간** 안 [시작+30분, 시작+5시간30분]에서 무작위 한 번입니다. 받기·실패·거부와 무관하게 한 실행은 다음 구간으로만
  미루므로(요청 전에 적어 둠) 구간마다 최대 한 번 = 하루 최대 네 번입니다. 처음(일정 없음)에는 받지 않고 다음 구간으로 정하고, 때가 아니면
  외부 호출 없이 끝납니다(일정 그대로).
[출처 상태] 실행마다 ``store.note_source_state``(ok·blocked·format·failed) — 백엔드 SourceAlertJob의 끊김·형식 바뀜 알림과 수집 현황이 그대로
  붙습니다(ADR 0046 결정 4). '오래 못 받음'은 ``STALE_AFTER_MINUTES``(30시간 — 구간 넷을 건너뛰어도 넘지 않게).
[실패 규칙] 목록 1쪽을 받지 못하면 EmptyResult(저장한 글 그대로 — 추적기도 건너뜀). 출처가 거부하면(403·429 — 공용 세션의 거부 래치) 그 예외를
  그대로 올려 실행 기록에 '거부됨'으로 남깁니다. 상세 하나의 실패는 나머지를 멈추지 않습니다(거부만 그 실행의 보호나라 요청을 멈춤).
[배포판 보안 추적기] (ADR 0046 덧붙임 2026-11-21) 같은 실행에서 보호나라 상세 다음에, 백엔드가 표 ``security_tracker_wants``에 둔 '물어볼 것'
  (변경 기록으로 가리지 못한 배포판·스위트·원본 패키지·CVE) 가운데 결과(표 ``distro_cve_status``)가 없거나, open·unknown이고
  ``TRACKER_OPEN_HOURS``시간·fixed·not_affected이고 ``TRACKER_SETTLED_DAYS``일보다 오래된 것을 오래된 것부터 묻습니다. 읽기는
  ``services.distro_trackers``(Ubuntu CVE JSON·Debian 보안 추적기 HTML·Alpine secdb).
  - Ubuntu·Debian은 CVE마다 요청 하나(같은 CVE의 패키지·스위트 여럿을 한 응답으로), 둘 합쳐 한 실행에 ``TRACKER_REQUEST_LIMIT``개까지.
    HTTP 404는 unknown. Alpine은 원하는 행이 있는 스위트마다 secdb ``main``·``community``를 한 번씩(상한과 별도 — 스위트 ``TRACKER_ALPINE_SUITES``개까지).
  - 요청 사이 3~6초, 보호나라와 같은 공용 세션과 시간 예산. 받지 못함(연결·5xx 등)·틀이 다름은 행을 쓰지 않고(직전 결과 그대로) 실행 메시지에
    건수만. 추적기의 거부(공용 세션의 거부 래치)는 추적기 조회만 멈춥니다(보호나라 결과는 이미 저장, 출처 상태는 보호나라 것만).
  - 실행 메시지에는 요청 수·결과 건수만 남깁니다(판 값·CVE 번호 없음 — 공개 저장소·로그).
"""
from __future__ import annotations

import logging
import random
import time
from datetime import date, datetime, timedelta, timezone

import requests

from .. import http, kst, store
from ..http import get_session
from ..services import distro_trackers, kisa_notices
from ..services.info_text import ShapeError
from . import flex
from .base import EmptyResult

logger = logging.getLogger(__name__)

TASK_NAME = "kisa_security_notices"
SCHEDULE_ITEM = "next"

DETAIL_LIMIT = 12                     # 한 실행의 상세 요청 상한
MAX_ATTEMPTS = 3                      # 상세 한 건의 시도 상한(받지 못함·틀 깨짐)
BACKFILL_DAYS = 90
MAX_BACKFILL_PAGE = 60                # 메우기가 이 쪽을 넘지 않음(쪽 크기가 바뀌어 셈이 어긋나도 끝없이 내려가지 않게)
PAGE_SIZE = 10                        # 목록 한 쪽의 번호 줄 수(고정 공지는 세지 않음)
GAP_SECONDS = (3.0, 6.0)              # 요청 사이 쉼
WINDOW_HOURS = 6                      # KST 하루를 넷으로 — [00,06)·[06,12)·[12,18)·[18,24)
WINDOW_MARGIN_MINUTES = 30            # 구간의 처음·끝 30분은 비움 → [시작+30분, 시작+5시간30분]
STALE_AFTER_MINUTES = 30 * 60         # '오래 못 받음' — 구간 사이 간격은 길어야 11시간이라 연달아 몇 번 빠져야 넘음
REQUEST_TIMEOUT = 20.0
# 새 요청을 더 시작하지 않는 경과 시간(초) — flex 상한(runner.TASK_DEADLINE_SECONDS["flex"] = 600초)에서 마지막 요청 하나(쉼 + 공용 세션의
# 다시 보내기 포함)가 들어갈 자리를 남깁니다.
TIME_LIMIT_SECONDS = 420.0
# 배포판 보안 추적기(모듈 설명 '배포판 보안 추적기').
TRACKER_REQUEST_LIMIT = 20            # 한 실행의 Ubuntu·Debian 요청 합계 상한
TRACKER_ALPINE_SUITES = 4             # 한 실행에 secdb를 받는 Alpine 스위트 상한(스위트마다 main·community 두 요청 — 위 상한과 별도)
TRACKER_OPEN_HOURS = 20               # open·unknown을 다시 묻는 간격
TRACKER_SETTLED_DAYS = 7              # fixed·not_affected를 다시 묻는 간격
_TRACKER_NAMES = {"ubuntu": "Ubuntu", "debian": "Debian", "alpine": "Alpine"}
_STATUS_NAMES = {"fixed": "고침", "not_affected": "영향 없음", "open": "열림", "unknown": "모름"}

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


def next_slot(now: datetime) -> datetime:
    """
    다음 실행 시각(UTC) — ``now``가 속한 KST 구간의 다음 구간 안 [시작+30분, 시작+5시간30분]에서 무작위(모듈 설명 '언제').

    KST에는 서머타임이 없어 벽시계 더하기가 그대로 맞습니다(18시 구간의 다음은 다음 날 00시 구간).
    """
    local = now.astimezone(kst.KST)
    start = local.replace(hour=local.hour - local.hour % WINDOW_HOURS, minute=0, second=0, microsecond=0)
    following = start + timedelta(hours=WINDOW_HOURS)
    minutes = _rng.uniform(WINDOW_MARGIN_MINUTES, WINDOW_HOURS * 60 - WINDOW_MARGIN_MINUTES)
    return (following + timedelta(minutes=minutes)).astimezone(timezone.utc)


class _Failed(Exception):
    """받지 못함(연결·HTTP 상태) — 출처 상태 'failed'."""


class _OutOfTime(Exception):
    """실행의 시간 예산을 넘김 — 추적기 요청을 더 시작하지 않음."""


def _get(url: str, *, missing_ok: bool = False) -> bytes | None:
    """
    공용 세션으로 한 번 받습니다 → 본문(``missing_ok``이면 HTTP 404에 None).

    :raises http.SourceRejected: 출처가 거부함(공용 세션의 거부 래치)
    :raises _Failed: 연결 오류·200이 아닌 상태
    """
    try:
        response = get_session().get(url, timeout=REQUEST_TIMEOUT)
    except http.SourceRejected:
        raise
    except requests.exceptions.RequestException as exc:
        raise _Failed(http.brief_error(exc)) from None
    if missing_ok and response.status_code == 404:
        return None
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
        store.note_source_state(TASK_NAME, status, reason, stale_after_minutes=STALE_AFTER_MINUTES)
    except Exception as exc:  # noqa: BLE001
        logger.warning("출처 상태를 남기지 못함(%s): %s", TASK_NAME, exc)


def task_kisa_security_notices() -> str:
    """보호나라 보안공지 목록(1쪽 + 메우기 쪽)과 상세 몇 건 → 표 security_notices·security_notice_rows(모듈 설명)."""
    now = _now()
    when = flex.due_map(TASK_NAME).get(SCHEDULE_ITEM)
    if when is None:
        first = next_slot(now)
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, first)
        raise EmptyResult(f"일정 처음 정함 — 첫 요청 {kst.stamp(first)} · 외부 호출 0회")
    if when > now:
        raise EmptyResult(f"다음 요청 {kst.stamp(when)} — 아직 때가 아님 · 외부 호출 0회")

    # 결과와 무관하게 다음 구간으로만 미룹니다 — 요청 전에 적어 두어 이 실행이 실패·거부되거나 중간에 끊겨도 같은 구간에 다시 묻지 않게.
    next_at = next_slot(now)
    flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_at)
    cutoff = _today_kst(now) - timedelta(days=BACKFILL_DAYS)
    before = store.security_list_bounds()
    started = _clock()

    try:
        items = kisa_notices.parse_list(_get(kisa_notices.list_url(1)))
        if not items:
            raise ShapeError("목록 1쪽에 글이 없음")
    except http.SourceRejected as exc:
        _note("blocked", str(exc))
        raise
    except _Failed as exc:
        _note("failed", f"목록 1쪽 받지 못함 — {exc}")
        raise EmptyResult(f"목록 1쪽 받지 못함 — {exc} · 저장한 글 그대로 · 다음 {kst.stamp(next_at)}") from None
    except ShapeError as exc:
        _note("format", f"목록 1쪽 모양이 다름 — {exc}")
        raise EmptyResult(f"목록 1쪽 모양이 다름 — {exc} · 저장한 글 그대로 · 다음 {kst.stamp(next_at)}") from None

    new = store.upsert_security_notices(items, first_page=True, detail_since=cutoff)
    parts = [f"목록 1쪽 {len(items)}건(처음 본 글 {new})"]
    issues: list[tuple[str, str]] = []
    # 1쪽의 가장 작은 번호가 앞서 본 가장 큰 번호보다 2 넘게 크면 그 사이 글을 못 봤습니다(수집기가 오래 멈춰 새 글이 한 쪽을 넘게 쌓임).
    # 메우기 범위 밖이라 실행 기록에만 남깁니다(출처의 탓이 아님 — 출처 상태는 그대로).
    numbers = [item.list_no for item in items if item.list_no is not None]
    missed = (min(numbers) - int(before["maxNo"]) - 1) if numbers and before["maxNo"] is not None else 0

    rejected: http.SourceRejected | None = None
    bounds = store.security_list_bounds()
    page = _backfill_page(bounds, cutoff)
    if page is not None and page > 1 and _clock() - started <= TIME_LIMIT_SECONDS:
        _sleep(_rng.uniform(*GAP_SECONDS))
        try:
            more = kisa_notices.parse_list(_get(kisa_notices.list_url(page)))
        except http.SourceRejected as exc:
            rejected = exc
        except _Failed as exc:
            issues.append(("failed", f"목록 {page}쪽 받지 못함 — {exc}"))
        except ShapeError as exc:
            issues.append(("format", f"목록 {page}쪽 모양이 다름 — {exc}"))
        else:
            added = store.upsert_security_notices(more, first_page=False, detail_since=cutoff)
            parts.append(f"목록 {page}쪽 {len(more)}건(처음 본 글 {added})")
            # 메우기 쪽의 셈이 맞으면 그 쪽의 가장 큰 번호가 아직 못 본 가장 큰 번호(지금 가장 작은 번호 - 1) 이상입니다. 작으면 그 사이를
            # 건너뛴 것 — 쪽 크기가 바뀐 것이라 '형식 바뀜'으로 남깁니다(받은 글은 넣음).
            got = [item.list_no for item in more if item.list_no is not None]
            if got and bounds["minNo"] is not None and max(got) < int(bounds["minNo"]) - 1:
                issues.append(("format", f"목록 {page}쪽이 번호 {int(bounds['minNo']) - 1 - max(got)}개를 건너뜀 — 쪽 크기가 바뀐 듯"))

    ok = failed = shaped = 0
    pending = [] if rejected is not None else store.security_pending_details(DETAIL_LIMIT, max_attempts=MAX_ATTEMPTS, since=cutoff)
    for ntt_id in pending:
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
    try:
        tracker_parts = _ask_trackers(started)
    except Exception as exc:  # noqa: BLE001 — 추적기의 탈은 보호나라 결과·출처 상태를 막지 않음
        logger.warning("배포판 보안 추적기 조회가 멈춤(%s)", type(exc).__name__)
        tracker_parts = [f"추적기 조회 멈춤 — {type(exc).__name__}"]

    if rejected is not None:
        _note("blocked", str(rejected))
    elif any(kind == "format" for kind, _ in issues):
        _note("format", next(reason for kind, reason in issues if kind == "format"))
    elif any(kind == "failed" for kind, _ in issues):
        _note("failed", next(reason for kind, reason in issues if kind == "failed"))
    else:
        _note("ok", None)

    parts.append(f"상세 {ok}건")
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
    parts.extend(tracker_parts)
    parts.append(f"다음 {kst.stamp(next_at)}")
    return " · ".join(parts)


def _ask_trackers(started: float) -> list[str]:
    """
    배포판 보안 추적기에 묻고 결과를 표 distro_cve_status에 씁니다 → 실행 메시지 조각(모듈 설명 '배포판 보안 추적기').
    """
    due_rows = store.distro_tracker_due(now=_now(), open_hours=TRACKER_OPEN_HOURS, settled_days=TRACKER_SETTLED_DAYS)
    if not due_rows:
        return ["추적기 물을 것 없음"]
    alpine: dict[str, list[dict]] = {}
    groups: dict[tuple[str, str], list[dict]] = {}
    for row in due_rows:
        if row["distro"] == "alpine":
            alpine.setdefault(row["suite"], []).append(row)
        else:
            groups.setdefault((row["distro"], row["cve"]), []).append(row)

    asked = dict.fromkeys(_TRACKER_NAMES, 0)
    results = dict.fromkeys(_STATUS_NAMES, 0)
    failed = shaped = 0
    stop: str | None = None

    def fetch(distro: str, url: str) -> bytes | None:
        """요청 하나 — 시간 예산을 넘겼으면 _OutOfTime(새 요청을 시작하지 않음)."""
        if _clock() - started > TIME_LIMIT_SECONDS:
            raise _OutOfTime
        _sleep(_rng.uniform(*GAP_SECONDS))
        asked[distro] += 1
        return _get(url, missing_ok=True)

    def save(pairs: list[tuple[dict, distro_trackers.Status]]) -> None:
        store.save_distro_cve_status(
            [(row["distro"], row["suite"], row["package"], row["cve"], st.status, st.fixed_version, st.detail) for row, st in pairs],
            checked_at=_now())
        for _, st in pairs:
            results[st.status] += 1

    try:
        for suite, rows in list(alpine.items())[:TRACKER_ALPINE_SUITES]:
            try:
                urls = [distro_trackers.alpine_url(suite, repo) for repo in distro_trackers.ALPINE_REPOS]
            except ValueError:
                shaped += 1                              # secdb 주소로 쓸 수 없는 스위트(edge 등) — 묻지 않음
                continue
            indexes = []
            for repo, url in zip(distro_trackers.ALPINE_REPOS, urls):
                try:
                    body = fetch("alpine", url)
                    indexes.append({} if body is None else distro_trackers.parse_alpine(body, suite, repo))
                except _Failed:
                    failed += 1
                    break
                except ShapeError:
                    shaped += 1
                    break
            if len(indexes) != len(distro_trackers.ALPINE_REPOS):
                continue                                 # 둘 다 봐야 unknown을 말할 수 있음 — 이 스위트는 쓰지 않음
            pairs = []
            for row in rows:
                try:
                    pairs.append((row, distro_trackers.alpine_status(indexes, row["package"], row["cve"], distro_trackers.ALPINE_REPOS)))
                except ShapeError:
                    shaped += 1
            save(pairs)

        sent = 0
        for (distro, cve), rows in groups.items():
            if sent >= TRACKER_REQUEST_LIMIT:
                break
            sent += 1
            url = distro_trackers.ubuntu_url(cve) if distro == "ubuntu" else distro_trackers.debian_url(cve)
            try:
                body = fetch(distro, url)
                if body is None:
                    pairs = [(row, distro_trackers.Status("unknown", None, "HTTP 404")) for row in rows]
                else:
                    record = distro_trackers.parse_ubuntu(body, cve) if distro == "ubuntu" else distro_trackers.parse_debian(body, cve)
                    pairs = []
                    for row in rows:
                        try:
                            if distro == "ubuntu":
                                pairs.append((row, distro_trackers.ubuntu_status(record, row["package"], row["suite"])))
                            else:
                                pairs.append((row, distro_trackers.debian_status(record, row["package"], row["suite"])))
                        except ShapeError:
                            shaped += 1
            except _Failed:
                failed += 1
                continue
            except ShapeError:
                shaped += 1
                continue
            save(pairs)
    except http.SourceRejected:
        stop = "추적기 거부로 멈춤"
    except _OutOfTime:
        stop = "시간 예산으로 추적기 멈춤"

    written = sum(results.values())
    parts = [f"추적기 요청 {sum(asked.values())}({'·'.join(f'{name} {asked[key]}' for key, name in _TRACKER_NAMES.items())})",
             f"추적기 결과 {written}({'·'.join(f'{name} {results[key]}' for key, name in _STATUS_NAMES.items())})"]
    if failed or shaped:
        parts.append(f"추적기 실패 {failed + shaped}(받지 못함 {failed}·모양이 다름 {shaped})")
    if stop:
        parts.append(stop)
    if len(due_rows) > written:
        parts.append(f"추적기 남음 {len(due_rows) - written}")
    logger.info("배포판 보안 추적기 — 요청 %d·결과 %d·실패 %d", sum(asked.values()), written, failed + shaped)
    return parts
