"""
app/tasks/runner.py
실행기 — 같은 태스크의 동시 실행 합치기, 속도군별 시간 상한, 그룹 실행.
"""
from __future__ import annotations

import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime, timezone

from .. import http, store

from .base import EmptyResult, Task
from .registry import ALL_TASKS, TASKS_BY_NAME

logger = logging.getLogger(__name__)


# ==============================================================================
# 같은 태스크의 동시 실행 합치기 (coalescing)
# ==============================================================================
# 화면 한 번 여는 것만으로 같은 태스크가 여러 번 돕니다. 백엔드는 스냅샷을
# 읽다가 오래됐으면 수집을 요청하는데, 한 화면이 여러 스냅샷을 병렬로 읽으면
# 그 요청이 각각 나갑니다. 실제 로그에서 확인된 모습입니다.
#
#   05:02:02 수집 시작 (cot_history): 1개 작업   ← 같은 초에 4번
#   05:02:02 수집 시작 (cot_history): 1개 작업
#   05:02:02 수집 시작 (cot_history): 1개 작업
#   05:02:02 수집 시작 (cot_history): 1개 작업
#
#   05:02:26 ✅ fred_series 80.03s   ← 스케줄러(slow)
#   05:03:07 ✅ fred_series 36.30s   ← 요청 1
#   05:03:08 ✅ fred_series 50.43s   ← 요청 2  (셋이 동시에 FRED를 두드림)
#
# 외부 API 호출이 그대로 몇 배가 되고(FRED·SEC는 호출 한도가 있습니다),
# 같은 행을 동시에 쓰게 됩니다.
#
# 뒤늦게 온 호출을 **거절하지 않고 기다리게** 합니다. 호출자가 원하는 것은
# "지금 새로 받아라"가 아니라 "신선한 값을 달라"이기 때문입니다. 이미 도는
# 수집이 끝나면 그 결과를 함께 씁니다.
_COALESCE_WAIT_SECONDS = 180.0

_inflight: dict[str, "_InFlight"] = {}
_inflight_lock = threading.Lock()


class _InFlight:
    """
    실행 중인 태스크 하나와 그 결과를 기다리는 자리.

    ``overdue`` — 시간 상한을 넘겨 호출자에게는 '시간 초과'를 돌려줬지만 작업 스레드가 아직 도는 중(좀비).
    이때 등록은 작업이 실제로 끝날 때까지 남겨 둡니다(QA-079).
    """

    __slots__ = ("done", "result", "overdue")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: tuple[bool, str] = (False, "결과 없음")
        self.overdue = False


def run_task(task: Task, run_id: int | None = None) -> tuple[bool, str]:
    """
    태스크 1건을 실행하고 결과를 DB에 남깁니다.

    같은 태스크가 이미 돌고 있으면 새로 시작하지 않고 그 결과를 기다립니다.
    """
    with _inflight_lock:
        entry = _inflight.get(task.name)
        leader = entry is None
        if leader:
            entry = _InFlight()
            _inflight[task.name] = entry
        overdue = entry.overdue

    if not leader:
        if overdue:
            return _still_running(task, run_id)
        return _wait_for_inflight(task, entry)

    try:
        result = _execute_task(task, run_id, entry)
        entry.result = result
        return result
    except BaseException as exc:      # 기다리는 쪽을 영원히 붙잡아 두지 않습니다.
        entry.result = (False, f"{type(exc).__name__}: {exc}")
        raise
    finally:
        # 먼저 등록을 지워야 다음 호출이 새 수집을 시작할 수 있습니다. 단, 시간 상한을 넘겨 작업 스레드가 아직
        # 돌면(overdue) 그 작업이 끝날 때 지웁니다(_finish_overdue). 여기서 지우면 다음 호출이 같은 태스크를
        # 좀비와 나란히 또 시작해, 같은 소스를 동시에 두드리고 같은 행을 동시에 썼습니다(QA-079).
        if not entry.overdue:
            _release(task.name, entry)
        entry.done.set()


def _release(name: str, entry: "_InFlight") -> None:
    """등록을 지웁니다 — 그 사이 다른 실행이 같은 이름으로 등록했으면 그것은 건드리지 않습니다."""
    with _inflight_lock:
        if _inflight.get(name) is entry:
            del _inflight[name]


def _still_running(task: Task, run_id: int | None) -> tuple[bool, str]:
    """
    시간 상한을 넘긴 앞선 실행이 아직 끝나지 않았을 때 — 새로 시작하지도, 기다리지도 않습니다.

    기다리게 하면 스케줄러의 그룹 실행이 좀비 수명만큼 길어집니다. 실패가 아닙니다(앞선 실행이 이미 '시간 초과'로
    기록됐고, 그 작업이 끝나면 저장본은 그 작업이 씁니다) — 합류 대기 한도를 넘긴 경우와 같은 이유로 성공으로 둡니다.

    실행 기록은 한 줄 남깁니다 — ⚠️ empty(이번 호출은 아무것도 받지 않음, 기존 저장본 유지), 소요 0. 상태 화면의
    '다시 실행'은 시작만 요청하고 실행 기록에 새 행이 생길 때까지 기다리는데, 남기지 않으면 15분을 기다린 뒤
    '끝나면 아래 표에 결과가 나타납니다'라고 틀리게 안내했습니다(좀비의 늦은 결과는 로그에만 남음). ✅로 적지 않는
    것은 아무것도 받지 않았는데 정상으로 보이기 때문입니다(QA-117).
    """
    logger.info("%s: 시간 상한을 넘긴 이전 실행이 아직 끝나지 않아 새로 시작하지 않습니다.", task.name)
    # 앞머리(store.STILL_RUNNING_PREFIX)로 태스크별 요약이 이 행을 건너뜁니다 — 요약은 앞선 ❌ 시간 초과를 계속 보입니다(QA-139).
    detail = (f"{store.STILL_RUNNING_PREFIX} — 시간 상한을 넘긴 앞선 실행이 끝나지 않아 새로 시작하지 않았습니다"
              "(그 실행이 끝나면 결과가 저장본에 반영됩니다)")
    store.record_task_run(
        run_id,
        task.name,
        speed=task.speed,
        status="empty",
        started_at=datetime.now(timezone.utc),
        duration_ms=0,
        detail=detail,
    )
    return True, detail


def _wait_for_inflight(task: Task, entry: "_InFlight") -> tuple[bool, str]:
    """이미 도는 같은 태스크가 끝나기를 기다렸다가 그 결과를 씁니다."""
    logger.info("%s: 이미 실행 중입니다. 새로 시작하지 않고 결과를 기다립니다.", task.name)

    if not entry.done.wait(timeout=_COALESCE_WAIT_SECONDS):
        # 실패가 아닙니다 — 수집은 앞선 호출이 계속 진행 중이고 결과는 다음 조회에 반영됩니다.
        # 예전엔 False를 돌려줘 백엔드가 요청한 13F(10분 넘게 걸림)가 주간 수집과 겹칠 때마다
        # collector_runs에 'fail' 행이 남고 make status가 "마지막 실행: 실패"라고 말했습니다.
        return True, (
            f"이미 실행 중인 수집에 합류 — {int(_COALESCE_WAIT_SECONDS)}초 안에 끝나지 않아 "
            "결과는 그 수집이 끝난 뒤 반영됩니다"
        )

    ok, detail = entry.result
    return ok, f"{detail} (동시에 실행 중이던 수집 결과를 함께 사용)"


EMPTY_PREFIX = "수집 결과 없음: "

# 출처가 거부해 아무것도 받지 못한 실행의 detail 앞머리(상태는 error — ❌). '수집 결과 없음'(⚠️, 소스가 새 데이터를 안 줌)과
# 가릅니다: 거부는 기다리거나 조치(키·UA·요청 빈도)가 필요한 일이고, 저장본은 그대로 남습니다(http.SourceRejected).
REJECTED_PREFIX = f"{http.REJECTED_MARK}: "


def _rejected_hosts(rejected: dict[str, str]) -> str:
    """{호스트: 사유} → 'api.stlouisfed.org(HTTP 429), …' (세 곳까지)."""
    shown = [f"{host}({why})" for host, why in list(rejected.items())[:3]]
    return ", ".join(shown) + ("…" if len(rejected) > 3 else "")


def _rejected_detail(rejected: dict[str, str], detail: str) -> str:
    """전부 실패한 실행이 출처 거부 때문일 때의 detail — 거부한 호스트를 앞에 두고 원래 사유를 잇습니다."""
    who = f"{_rejected_hosts(rejected)}가 요청을 거부" if rejected else "출처가 요청을 거부"
    return f"{REJECTED_PREFIX}{who} · {detail}"


def _run_status(ok_count: int, failures: list[str]) -> str:
    """
    실행(run) 상태를 태스크 결과에서 유도합니다.

    ok      전부 성공            partial  일부 성공
    empty   실패가 전부 '수집 결과 없음'(소스가 새 데이터를 안 줌 — 저장본 유지)
    fail    오류가 하나라도 있음
    예전에는 empty를 fail로 적어, 금융위 시세가 '새 기준일 없음'으로 끝난 평일마다 make status가
    "마지막 실행: 실패"라고 말했습니다. 태스크 화면은 같은 것을 '데이터 없음'이라고 부릅니다.
    """
    if not failures:
        return "ok"
    if ok_count:
        return "partial"
    if all(f.split(": ", 1)[-1].startswith(EMPTY_PREFIX) for f in failures):
        return "empty"
    return "fail"


# 태스크 하나의 시간 상한(초, 속도군별). 요청마다 timeout이 있어도 재시도 × 소스 수만큼 곱해져, 외부가
# '연결은 받고 응답하지 않는' 상태에서는 2초짜리 fast 태스크가 3~4분씩 돌았습니다(QA-011). 상한을 넘기면
# 실패로 기록하고 다음 태스크로 넘어갑니다. 작업 스레드는 요청 timeout들이 끝날 때까지 남아 뒤늦게
# 끝나는데, 그 결과는 로그로만 남깁니다(저장본은 그 작업이 알아서 씁니다 — 진짜 데이터입니다). 그동안 같은
# 태스크는 새로 시작하지 않고 ⚠️ '이전 수집이 아직 진행 중' 한 줄만 기록합니다(QA-079·QA-117). 상한에는
# 대기열에서 워커를 기다린 시간도 들어가므로, 아직 시작도 못 한 작업은 취소하고 '워커 대기 초과'로 따로
# 적습니다 — 외부 장애가 아니라 풀이 꽉 찬 것입니다.
# weekly(13F)는 한 태스크가 10분 넘게 걸리는 것이 정상이라 길게 둡니다.
# live: 정기 수집이 없고 화면이 볼 때만 백엔드가 부르는 장중 평가(paper_live_*) — 보유 종목 수십 개라 1분이면 넉넉합니다.
# session: 🧪 계좌2 장중 확인 감시(paper_watch_us, 5분마다) — 감시·보유·대기 종목 1분봉 배치 한 번이라 1분이면 넉넉하고, 주기(300초)보다 짧아야
# 다음 회차와 겹치지 않습니다.
TASK_DEADLINE_SECONDS: dict[str, float] = {"fast": 120.0, "slow": 600.0, "weekly": 1800.0, "live": 60.0, "session": 60.0}
_task_threads = ThreadPoolExecutor(max_workers=8, thread_name_prefix="task")


def deadline_for(task: Task) -> float:
    return TASK_DEADLINE_SECONDS.get(task.speed, TASK_DEADLINE_SECONDS["slow"])


def _execute_task(task: Task, run_id: int | None, entry: "_InFlight | None" = None) -> tuple[bool, str]:
    started_wall = datetime.now(timezone.utc)
    started = time.perf_counter()

    status = "ok"
    ok = True
    detail = ""

    deadline = deadline_for(task)
    # 작업 스레드에 시간 예산과 '이번 실행이 만난 출처 거부' 기록을 겁니다(http.TaskGuard). 예산은 이 상한과 같은 시각에
    # 끝나 — 대기열에서 기다린 시간도 셈 — 재시도가 상한을 넘겨 좀비로 남지 않게 합니다.
    guard = http.TaskGuard(deadline=time.monotonic() + deadline)
    future = _task_threads.submit(http.run_guarded, guard, task.run)
    try:
        detail = future.result(timeout=deadline) or ""
        if guard.rejected:
            # 받은 것은 저장했지만 일부 출처가 거부했습니다 — 빠진 항목은 직전 값을 이어받았습니다(isStale). 성공으로 두되 보이게.
            detail += f" · {REJECTED_PREFIX}{_rejected_hosts(guard.rejected)}"
    except FuturesTimeoutError:
        status, ok = "error", False
        if future.cancel():
            # 대기열에서 워커를 기다리다 상한에 닿았습니다 — 시작도 안 했으니 외부 응답과 무관합니다. 취소해 두지
            # 않으면 워커가 풀린 뒤 몰아서 실행됐습니다(QA-079).
            detail = (f"워커 대기 초과(시작 못 함): {deadline:.0f}초 동안 작업 스레드를 얻지 못했습니다 — "
                      "다른 수집이 작업 스레드를 모두 쓰는 중. 이번 실행은 취소했습니다(다음 주기에 다시)")
        else:
            detail = (f"시간 초과: {deadline:.0f}초 안에 끝나지 않았습니다 — 외부 응답 없음 의심. "
                      "작업은 뒤에서 계속 끝나기를 기다립니다(결과는 로그에만, 끝날 때까지 같은 태스크는 새로 "
                      "시작하지 않음)")
            if entry is not None:
                with _inflight_lock:
                    entry.overdue = True
            future.add_done_callback(
                lambda done, name=task.name, t0=started: _finish_overdue(name, entry, t0, done))
    except EmptyResult as exc:
        rejected = guard.rejected
        # 거부는 기록(이 작업 스레드와 http.bind_guard로 묶은 풀에서 난 것)이나 사유 문자열의 표지(묶지 않은 스레드에서 난 것)로
        # 압니다.
        if rejected or http.REJECTED_MARK in str(exc):
            status, ok, detail = "error", False, _rejected_detail(rejected, str(exc))
        else:
            status, ok, detail = "empty", False, f"{EMPTY_PREFIX}{exc}"
    except Exception as exc:  # noqa: BLE001
        status, ok = "error", False
        detail = f"{type(exc).__name__}: {exc}"
        rejected = guard.rejected
        if rejected or isinstance(exc, http.SourceRejected):
            # SourceRejected의 메시지는 이미 화면용 한 줄이라 예외 이름을 붙이지 않습니다.
            detail = _rejected_detail(rejected, str(exc) if isinstance(exc, http.SourceRejected) else detail)
        logger.debug(traceback.format_exc())

    elapsed = time.perf_counter() - started
    icon = {"ok": "✅", "empty": "⚠️", "error": "❌"}[status]
    (logger.info if ok else logger.warning)(
        "  %s %-22s %6.2fs  %s", icon, task.name, elapsed, detail
    )

    store.record_task_run(
        run_id,
        task.name,
        speed=task.speed,
        status=status,
        started_at=started_wall,
        duration_ms=int(elapsed * 1000),
        detail=detail,
    )
    return ok, detail


def _finish_overdue(name: str, entry: "_InFlight | None", started: float, done) -> None:
    """시간 상한을 넘긴 작업이 실제로 끝났을 때 — 로그를 남기고 합치기 등록을 풉니다."""
    try:
        _log_late_finish(name, started, done)
    finally:
        if entry is not None:
            _release(name, entry)


def _log_late_finish(name: str, started: float, done) -> None:
    elapsed = time.perf_counter() - started
    exc = done.exception()
    if exc is None:
        logger.warning("  ⏱️ %-22s %6.1fs  뒤늦게 끝남(이미 시간 초과로 기록): %s", name, elapsed, done.result())
    else:
        logger.warning("  ⏱️ %-22s %6.1fs  뒤늦게 실패(이미 시간 초과로 기록): %s: %s", name, elapsed, type(exc).__name__, exc)


def run_group(group: str | None = None, task_name: str | None = None) -> dict:
    """
    작업군 또는 단일 태스크를 1회 실행합니다.

    반환: {"group","okCount","failCount","elapsedSeconds","results":[...]}
    """
    if task_name:
        selected = [TASKS_BY_NAME[task_name]] if task_name in TASKS_BY_NAME else []
    elif group in (None, "all"):
        selected = list(ALL_TASKS)
    else:
        selected = [task for task in ALL_TASKS if task.speed == group]

    label = task_name or group or "all"
    if not selected:
        logger.warning("실행할 작업이 없습니다 (%s)", label)
        return {"group": label, "okCount": 0, "failCount": 0, "results": []}

    logger.info("수집 시작 (%s): %d개 작업", label, len(selected))

    run_id = None
    try:
        run_id = store.start_run(group_name=label)
    except Exception as exc:  # noqa: BLE001
        logger.warning("실행 로그 기록 실패(수집은 계속합니다): %s", exc)

    started = time.perf_counter()
    results = []
    ok_count = 0
    failures: list[str] = []

    for task in selected:
        success, detail = run_task(task, run_id)
        results.append({
            "task": task.name,
            "speed": task.speed,
            "ok": success,
            "detail": detail,
        })
        if success:
            ok_count += 1
        else:
            failures.append(f"{task.name}: {detail}")

        # 태스크마다 heartbeat를 남겨, 죽은 수집기를 "진행 중"으로 오인하지
        # 않게 합니다 (13F는 한 태스크가 10분 넘게 걸립니다).
        if run_id is not None:
            store.heartbeat_run(run_id)

    elapsed = time.perf_counter() - started

    if run_id is not None:
        try:
            store.finish_run(
                run_id,
                status=_run_status(ok_count, failures),
                ok_count=ok_count,
                fail_count=len(failures),
                detail="; ".join(failures) or None,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("실행 로그 마감 실패: %s", exc)

    logger.info(
        "수집 완료 (%s): 성공 %d · 실패 %d · %.1fs",
        label, ok_count, len(failures), elapsed,
    )

    return {
        "group": label,
        "runId": run_id,
        "okCount": ok_count,
        "failCount": len(failures),
        "elapsedSeconds": round(elapsed, 2),
        "results": results,
    }

