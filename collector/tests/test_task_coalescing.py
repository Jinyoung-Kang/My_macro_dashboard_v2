"""
tests/test_task_coalescing.py
같은 태스크가 동시에 두 번 돌지 않는지 고정합니다.

실제 로그에서 나온 문제입니다. 화면 하나를 여는 것만으로 백엔드가 스냅샷을
병렬로 읽고, 오래된 것마다 수집을 요청해 같은 태스크가 네 번 시작됐습니다.

    05:02:02 수집 시작 (cot_history): 1개 작업   ← 같은 초에 4번
    05:02:26 ✓ fred_series 80.03s   ← 스케줄러
    05:03:07 ✓ fred_series 36.30s   ← 요청 1
    05:03:08 ✓ fred_series 50.43s   ← 요청 2

FRED·SEC는 호출 한도가 있고, 같은 행을 동시에 쓰는 것도 안전하지 않습니다.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import tasks


@pytest.fixture(autouse=True)
def _clean_registry():
    tasks._inflight.clear()
    yield
    tasks._inflight.clear()


@pytest.fixture(autouse=True)
def _no_db(monkeypatch):
    """실행 기록은 이 테스트의 관심사가 아닙니다."""
    monkeypatch.setattr(tasks.store, "record_task_run", lambda *a, **kw: None)


def _slow_task(counter: list[int], barrier: threading.Event, name="slow_task"):
    def run() -> str:
        counter.append(1)
        barrier.wait(timeout=5)
        return f"{len(counter)}회차 실행"

    return tasks.Task(name, "fast", run, "")


def test_동시_호출은_한_번만_실행된다():
    counter: list[int] = []
    barrier = threading.Event()
    task = _slow_task(counter, barrier)

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(tasks.run_task, task) for _ in range(4)]
        time.sleep(0.3)          # 네 호출이 모두 도착할 시간
        barrier.set()
        results = [f.result(timeout=10) for f in futures]

    assert len(counter) == 1, f"태스크가 {len(counter)}번 실행됐습니다 (1번이어야 합니다)"
    assert all(ok for ok, _ in results), "기다린 쪽도 성공 결과를 받아야 합니다"


def test_기다린_쪽은_같은_결과를_받는다():
    counter: list[int] = []
    barrier = threading.Event()
    task = _slow_task(counter, barrier)

    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(tasks.run_task, task)
        time.sleep(0.2)
        follower = pool.submit(tasks.run_task, task)
        time.sleep(0.2)
        barrier.set()
        leader_ok, leader_detail = leader.result(timeout=10)
        follower_ok, follower_detail = follower.result(timeout=10)

    assert leader_ok and follower_ok
    assert leader_detail in follower_detail
    # 화면에 "왜 이 값인지"가 보여야 합니다.
    assert "함께 사용" in follower_detail


def test_끝나면_다음_호출은_새로_실행된다():
    """합치기가 태스크를 영구히 막아 버리면 안 됩니다."""
    counter: list[int] = []
    barrier = threading.Event()
    barrier.set()
    task = _slow_task(counter, barrier)

    tasks.run_task(task)
    tasks.run_task(task)

    assert len(counter) == 2
    assert tasks._inflight == {}, "끝난 뒤에는 등록이 남아 있으면 안 됩니다"


def test_실패해도_기다리는_쪽을_붙잡아_두지_않는다():
    started = threading.Event()

    def run() -> str:
        started.set()
        time.sleep(0.4)
        raise RuntimeError("외부 소스 폭발")

    task = tasks.Task("boom", "fast", run, "")

    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(tasks.run_task, task)
        started.wait(timeout=5)
        follower = pool.submit(tasks.run_task, task)

        leader_ok, _ = leader.result(timeout=10)
        follower_ok, follower_detail = follower.result(timeout=10)

    assert leader_ok is False
    assert follower_ok is False
    assert "폭발" in follower_detail, "기다린 쪽도 실패 사유를 알아야 합니다"
    assert tasks._inflight == {}


def test_다른_태스크는_서로를_막지_않는다():
    counter_a: list[int] = []
    counter_b: list[int] = []
    barrier = threading.Event()
    task_a = _slow_task(counter_a, barrier, "task_a")
    task_b = _slow_task(counter_b, barrier, "task_b")

    with ThreadPoolExecutor(max_workers=2) as pool:
        fa = pool.submit(tasks.run_task, task_a)
        fb = pool.submit(tasks.run_task, task_b)
        time.sleep(0.3)
        barrier.set()
        fa.result(timeout=10)
        fb.result(timeout=10)

    assert len(counter_a) == 1
    assert len(counter_b) == 1


def test_기다리다_한도를_넘기면_실패가_아니라_합류다(monkeypatch):
    """
    백엔드가 요청한 13F가 주간 수집(10분 넘게)과 겹치면 180초 뒤 (False, …)가 돌아와
    collector_runs에 'fail' 행이 남고 make status가 "마지막 실행: 실패"라고 말했습니다.
    수집은 앞선 호출이 계속 진행 중이고 결과는 다음 조회에 반영되므로 실패가 아닙니다.
    """
    import threading
    from app import tasks

    monkeypatch.setattr(tasks.runner, "_COALESCE_WAIT_SECONDS", 0.05)
    release = threading.Event()
    task = tasks.Task("slow_one", "fast", lambda: release.wait(5) or "끝", "느린 태스크")

    leader = threading.Thread(target=lambda: tasks.run_task(task))
    leader.start()
    deadline = time.time() + 2
    while task.name not in tasks._inflight and time.time() < deadline:
        time.sleep(0.005)

    ok, detail = tasks.run_task(task)      # 두 번째 호출: 기다리다 한도 초과

    assert ok is True
    assert "합류" in detail
    release.set()
    leader.join(timeout=5)
    assert tasks._inflight == {}


# ---- QA-079: 시간 상한을 넘긴 작업(좀비)과 같은 태스크가 동시에 다시 돌던 문제 ------------------------------
def test_상한을_넘긴_작업이_끝나기_전에는_같은_태스크를_다시_시작하지_않는다(monkeypatch):
    """
    시간 상한을 넘기면 호출자는 '시간 초과'로 돌아가지만 작업 스레드는 요청 timeout이 끝날 때까지 남습니다.
    예전에는 그 순간 합치기 등록이 풀려, 백엔드가 30초 뒤 같은 태스크를 다시 요청하면 좀비와 나란히 두 번째
    실행이 시작됐습니다(같은 소스를 동시에 두드리고 같은 행을 동시에 씀). 좀비가 끝날 때까지는 새로 시작하지 않고
    곧바로 '이전 수집이 아직 진행 중'으로 돌려줘야 합니다 — 기다리게 하면 스케줄러의 그룹 실행이 길어집니다.
    """
    monkeypatch.setitem(tasks.TASK_DEADLINE_SECONDS, "fast", 0.2)
    lock = threading.Lock()
    runs: list[int] = []
    active = [0]
    peak = [0]
    release = threading.Event()

    def run() -> str:
        with lock:
            runs.append(1)
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        try:
            release.wait(5)
        finally:
            with lock:
                active[0] -= 1
        return "늦은 결과"

    task = tasks.Task("zombie_task", "fast", run, "")
    try:
        ok, detail = tasks.run_task(task)            # 0.2초 뒤 시간 초과 — 작업 스레드는 계속 돕니다
        assert ok is False and "시간 초과" in detail

        started = time.perf_counter()
        again_ok, again_detail = tasks.run_task(task)  # 좀비가 아직 도는 중
        waited = time.perf_counter() - started

        assert len(runs) == 1, f"좀비와 나란히 {len(runs)}번째 실행이 시작됐습니다"
        assert again_ok is True and "아직 진행 중" in again_detail
        assert waited < 0.5, "좀비를 기다리지 않고 곧바로 돌려줘야 합니다(그룹 실행을 늘리지 않음)"
    finally:
        release.set()

    deadline = time.time() + 3
    while task.name in tasks._inflight and time.time() < deadline:
        time.sleep(0.01)
    assert tasks._inflight == {}, "좀비가 끝나면 등록이 풀려야 합니다"
    assert tasks.run_task(task)[0] is True             # 끝난 뒤에는 새로 실행
    assert len(runs) == 2 and peak[0] == 1


def test_QA117_좀비가_도는_동안의_호출도_실행_기록을_한_줄_남긴다(monkeypatch):
    """
    상태 화면의 '다시 실행'은 시작만 요청하고(백그라운드), 실행 기록에 기준 시각보다 새 행이 생길 때까지 최대 15분
    기다립니다. 좀비가 도는 동안의 호출은 '이전 수집이 아직 진행 중'을 돌려주기만 하고 기록을 남기지 않아, 화면이
    15분을 기다린 뒤 '아직 진행 중… 끝나면 아래 표에 결과가 나타납니다'라고 틀리게 안내했습니다(좀비의 늦은 결과는
    기록되지 않으므로 표에 새 행이 생기지 않음). 그 15분 동안 다른 태스크의 '다시 실행'도 막혔습니다.
    곧바로 empty(기존 저장본 유지) 한 줄을 남겨 화면 폴링이 바로 끝나고 사실대로 안내되게 합니다.
    """
    monkeypatch.setitem(tasks.TASK_DEADLINE_SECONDS, "fast", 0.2)
    recorded: list[dict] = []
    monkeypatch.setattr(tasks.store, "record_task_run",
                        lambda run_id, task, **kw: recorded.append({"run_id": run_id, "task": task, **kw}))
    release = threading.Event()
    task = tasks.Task("zombie_task", "fast", lambda: release.wait(5) and "늦은 결과", "")
    try:
        tasks.run_task(task, 1)                       # 시간 초과 — 기록 1건('error'), 작업 스레드는 계속 돕니다
        assert [row["status"] for row in recorded] == ["error"]

        ok, detail = tasks.run_task(task, 2)          # 좀비가 아직 도는 중(수동 '다시 실행'과 같은 호출)
    finally:
        release.set()
        deadline = time.time() + 3
        while task.name in tasks._inflight and time.time() < deadline:
            time.sleep(0.01)

    assert ok is True and "아직 진행 중" in detail
    assert len(recorded) == 2, f"좀비가 도는 동안의 호출이 실행 기록을 {len(recorded) - 1}건 남겼습니다(1건이어야 함)"
    row = recorded[-1]
    assert row["run_id"] == 2 and row["task"] == "zombie_task" and row["speed"] == "fast"
    assert row["status"] == "empty", "ok로 적으면 아무것도 받지 않았는데 정상으로 보입니다"
    assert row["duration_ms"] == 0
    assert row["detail"] == detail
    assert row["started_at"] is not None


def test_워커를_얻지_못한_작업은_취소하고_외부_장애와_다른_사유로_남긴다(monkeypatch):
    """
    태스크는 워커 8개짜리 풀 하나를 함께 씁니다. 좀비가 워커를 모두 잡고 있으면 소스가 멀쩡한 태스크도 상한 안에
    시작하지 못하는데, 예전에는 이것을 '외부 응답 없음 의심'으로 적고 대기열의 작업을 취소하지 않아 좀비가 풀린 뒤
    몰아서 실행했습니다. 시작 못 한 작업은 취소하고 '워커 대기 초과'로 따로 적어야 실행 기록이 원인을 가리킵니다.
    """
    monkeypatch.setitem(tasks.TASK_DEADLINE_SECONDS, "fast", 0.2)
    pool = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(tasks.runner, "_task_threads", pool)
    recorded: list[dict] = []
    monkeypatch.setattr(tasks.store, "record_task_run", lambda *a, **kw: recorded.append(kw))
    hang = threading.Event()
    ran: list[int] = []
    blocker = tasks.Task("blocker_task", "fast", lambda: hang.wait(5) and "끝", "")
    healthy = tasks.Task("healthy_task", "fast", lambda: ran.append(1) or "정상", "")
    try:
        tasks.run_task(blocker)                      # 하나뿐인 워커를 잡은 채 시간 초과
        ok, detail = tasks.run_task(healthy)         # 워커를 얻지 못하고 상한에 닿음
    finally:
        hang.set()
        pool.shutdown(wait=True)

    assert ok is False
    assert "워커 대기 초과" in detail
    assert "외부 응답 없음" not in detail
    assert recorded[-1]["detail"] == detail
    assert ran == [], "시작 못 한 작업은 취소돼 나중에 몰아서 실행되면 안 됩니다"
    assert tasks._inflight == {}
