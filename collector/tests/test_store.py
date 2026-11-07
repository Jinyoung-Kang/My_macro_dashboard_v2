"""
tests/test_store.py
저장 계층 회귀 테스트.

구버전 tests/test_store.py가 지키던 성질을 PostgreSQL 위에서 다시 확인합니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


from app import catalog


def test_snapshot_upsert_keeps_single_row(store):
    store.put_snapshot("demo.snap", {"value": 1})
    store.put_snapshot("demo.snap", {"value": 2})

    snapshot = store.read_snapshot("demo.snap")
    assert snapshot is not None
    assert snapshot.payload == {"value": 2}
    assert len(store.list_snapshots()) == 1


def test_snapshot_freshness(store):
    store.put_snapshot("demo.snap", {"value": 1})
    snapshot = store.read_snapshot("demo.snap")

    assert snapshot.is_fresh(60) is True
    assert snapshot.age_seconds < 60


def test_missing_snapshot_returns_none(store):
    assert store.read_snapshot("never.collected") is None


def test_stock_codes_keep_leading_zeros(store):
    """
    "069500"이 숫자로 바뀌면 69500이 되어 이후 모든 조회가 실패합니다.
    구버전에서 실제로 났던 사고라 계약으로 고정합니다.
    """
    store.put_snapshot("radar.demo", {"rows": [{"code": "069500", "name": "KODEX 200"}]})

    payload = store.read_snapshot("radar.demo").payload
    assert payload["rows"][0]["code"] == "069500"


def test_timeseries_upsert_is_idempotent(store):
    points = [("2026-01-02", 1.0), ("2026-01-03", 2.0)]
    assert store.put_timeseries("demo", "SERIES", points) == 2

    # 같은 날짜를 다시 쓰면 갱신만 되고 행이 늘지 않습니다.
    store.put_timeseries("demo", "SERIES", [("2026-01-03", 9.9)])

    rows = store.read_timeseries("demo", "SERIES")
    assert len(rows) == 2
    assert rows[-1] == {"date": "2026-01-03", "value": 9.9}


def test_timeseries_drops_unparseable_points(store):
    written = store.put_timeseries(
        "demo", "SERIES",
        [("2026-01-02", 1.0), ("bad-date", 5.0), (None, 7.0)],
    )
    assert written == 1


def test_observations_filter_by_payload(store):
    records = [
        {"entity": "K|F|B|001", "market": "KOSPI", "investor": "외국인",
         "tradeType": "순매수", "code": "005930", "netAmountEok": 120.0},
        {"entity": "K|I|B|002", "market": "KOSPI", "investor": "기관",
         "tradeType": "순매수", "code": "000660", "netAmountEok": 80.0},
    ]
    store.put_observations(catalog.OBS_RADAR, "2026-09-11", records, entity_key="entity")

    foreign = store.read_observations(
        catalog.OBS_RADAR, filters={"investor": "외국인"}
    )
    assert len(foreign) == 1
    assert foreign[0]["code"] == "005930"

    assert store.list_observation_dates(catalog.OBS_RADAR) == ["2026-09-11"]


def test_run_lifecycle_and_task_summary(store):
    run_id = store.start_run("fast")
    store.record_task_run(
        run_id, "macro_collected",
        speed="fast", status="ok",
        started_at=datetime.now(timezone.utc), duration_ms=1200, detail="21/21 지표",
    )
    store.finish_run(run_id, status="ok", ok_count=1, fail_count=0)

    last = store.read_last_run()
    assert last["status"] == "ok"
    assert store.resolve_run_status(last) == "ok"

    summary = store.read_task_summary()
    assert summary[0]["task"] == "macro_collected"
    assert summary[0]["status"] == "ok"


def test_dead_running_record_is_reported_as_interrupted(store):
    """
    수집기가 Ctrl+C·절전으로 죽으면 status가 'running'에 영구히 남습니다.
    그것을 "진행 중"이라고 보고하면 상태 화면이 거짓말을 합니다.
    """
    dead = {
        "status": "running",
        "pid": 999_999,                 # 존재하지 않는 PID
        "host": None,                   # None이면 같은 호스트로 간주
        "heartbeat_at": datetime.now(timezone.utc),
        "started_at": datetime.now(timezone.utc),
    }
    assert store.resolve_run_status(dead) == "interrupted"


def test_stale_heartbeat_is_interrupted(store):
    stale = {
        "status": "running",
        "pid": None,
        "host": "other-host",
        "heartbeat_at": datetime.now(timezone.utc) - timedelta(hours=2),
        "started_at": datetime.now(timezone.utc) - timedelta(hours=3),
    }
    assert store.resolve_run_status(stale) == "interrupted"


def test_mark_stale_runs_interrupted(store):
    run_id = store.start_run("fast")
    with store.connection() as conn:
        conn.execute(
            "UPDATE collector_runs SET pid = 999999, heartbeat_at = now() - interval '2 hours' "
            "WHERE id = %s",
            (run_id,),
        )

    assert store.mark_stale_runs_interrupted() == 1
    assert store.read_last_run()["status"] == "interrupted"


def test_restart_with_reused_pid_marks_previous_running_run_interrupted(store):
    """
    BUG-04. 컨테이너가 재시작되면 새 수집기도 PID 1이고 호스트 이름도 같습니다.
    이전 프로세스가 남긴 'running' 기록이 "살아 있는 PID"로 보여, heartbeat 기준(30분)이
    지날 때까지 "진행 중"으로 남았습니다.
    """
    store.start_run("fast")     # 같은 호스트·같은 PID로 남은 기록 = PID를 물려받은 재시작 직전 상태
    assert store.resolve_run_status(store.read_last_run()) == "running"

    # 기동 직후에는 이 프로세스가 시작한 실행이 없으므로 이전 프로세스의 기록입니다.
    assert store.mark_stale_runs_interrupted() == 1
    assert store.read_last_run()["status"] == "interrupted"


def test_startup_cleanup_keeps_live_runs_of_other_processes(store):
    """다른 호스트(또는 같은 호스트의 다른 살아 있는 프로세스)가 돌리는 실행은 건드리지 않습니다."""
    run_id = store.start_run("fast")
    with store.connection() as conn:
        conn.execute("UPDATE collector_runs SET host = 'other-host' WHERE id = %s", (run_id,))

    assert store.mark_stale_runs_interrupted() == 0
    assert store.read_last_run()["status"] == "running"


def test_QA308_기동_때_이번_회차의_끝나지_않은_slow_실행에서_끝난_태스크를_모은다(store):
    """
    store.unfinished_group_tasks — since 뒤에 시작한 그 군의 가장 최근 실행이 끝나지 않았으면(running·interrupted) 그 회차 실행들에서 끝난
    태스크 이름들, 끝났거나 없으면 None. 상태가 아니라 finished_at으로 봅니다(배포로 호스트 이름이 바뀌면 'running'이 그대로 남음).
    """
    now = datetime.now(timezone.utc)
    since = now - timedelta(minutes=5)
    assert store.unfinished_group_tasks("slow", since) is None, "실행 없음"

    old = store.start_run("slow")                     # 지난 회차 — since 앞에 시작, 끝나지 않음
    store.record_task_run(old, "fred_series", speed="slow", status="ok", started_at=now, duration_ms=1)
    with store.connection() as conn:
        conn.execute("UPDATE collector_runs SET started_at = now() - interval '70 minutes' WHERE id = %s", (old,))
    assert store.unfinished_group_tasks("slow", since) is None, "지난 회차 실행은 보지 않음"

    cut = store.start_run("slow")                     # 이번 회차 — paper_quotes까지 끝내고 끊김
    for task in ("fred_series", "paper_quotes"):
        store.record_task_run(cut, task, speed="slow", status="ok", started_at=now, duration_ms=1)
    store.start_run("fast")                           # 다른 군은 보지 않음
    assert store.unfinished_group_tasks("slow", since) == frozenset({"fred_series", "paper_quotes"})

    resumed = store.start_run("slow")                 # 이어 돈 실행도 끊김 — 그 회차에 끝난 태스크를 모두 모음
    store.record_task_run(resumed, "paper_bars_us", speed="slow", status="error", started_at=now, duration_ms=1)
    assert store.unfinished_group_tasks("slow", since) == frozenset({"fred_series", "paper_quotes", "paper_bars_us"})

    store.finish_run(resumed, status="partial", ok_count=0, fail_count=1)
    assert store.unfinished_group_tasks("slow", since) is None, "가장 최근 실행이 끝났으면 이어 돌 것 없음"


def test_run_details_are_redacted_when_stored_and_served(store):
    """
    SEC-05. 실패 사유(detail)는 상태 화면에 그대로 나가고 복사됩니다. 로그에서만 가리던
    비밀값을 저장할 때도 가리고, 예전에 가리지 않고 저장된 기록은 내보낼 때 가립니다.
    """
    leaked = "HTTPError: 500 for url: https://apis.data.go.kr/x?serviceKey=SECRET123&pageNo=1"
    run_id = store.start_run("slow")
    store.record_task_run(run_id, "fsc_prices", speed="slow", status="error",
                          started_at=datetime.now(timezone.utc), duration_ms=1, detail=leaked)
    store.finish_run(run_id, status="fail", fail_count=1, detail="fsc_prices: " + leaked)
    with store.connection() as conn:
        stored = [row["detail"] for row in conn.execute(
            "SELECT detail FROM collector_task_runs UNION ALL SELECT detail FROM collector_runs")]
        # 수정 전에 저장된 기록 흉내 (가리지 않은 원문)
        conn.execute(
            "INSERT INTO collector_task_runs (task, status, detail) VALUES ('kr_holidays', 'error', %s)",
            (leaked,),
        )
    assert len(stored) == 2
    assert all("SECRET123" not in text and "serviceKey=***redacted***" in text for text in stored)

    stats = store.store_stats()
    served = [task["detail"] for task in stats["taskSummary"]] + [stats["lastRun"]["detail"]]
    served += [store._serialize_task(row)["detail"] for row in store.read_task_history(limit=10)]
    assert len(served) == 5
    assert all("SECRET123" not in text for text in served)


def test_refresh_request_moves_forward(store):
    first = store.request_refresh()
    second = store.request_refresh()

    assert second >= first
    assert store.refresh_requested_at() == second


def test_missing_datasets_lists_expected_names(store):
    """
    존재하는 스냅샷만 나열하면 "수집이 아예 안 된" 데이터셋을 놓칩니다.
    기대 목록과 대조해야 누락을 알아챌 수 있습니다.
    """
    missing = store.missing_datasets()
    names = {entry["name"] for entry in missing}

    assert catalog.SNAP_MACRO_COLLECTED in names
    assert catalog.snap_fred_series("T10Y3M") in names

    store.put_snapshot(catalog.SNAP_MACRO_COLLECTED, {"categories": []})
    names_after = {entry["name"] for entry in store.missing_datasets()}
    assert catalog.SNAP_MACRO_COLLECTED not in names_after


def test_task_summary_hides_removed_tasks(store):
    """없앤 태스크의 옛 실행 기록이 상태 화면에 남지 않아야 합니다(다시 실행할 수 없는 버튼)."""
    run_id = store.start_run("weekly")
    for name in ("kr_holidays", "seoul_apartments"):
        store.record_task_run(
            run_id, name, speed="weekly", status="ok",
            started_at=datetime.now(timezone.utc), duration_ms=10, detail="x",
        )

    names = [row["task"] for row in store.read_task_summary(["kr_holidays", "fsc_prices"])]
    assert names == ["kr_holidays"]
    # 거르지 않으면 둘 다 보입니다(이전 동작).
    assert {row["task"] for row in store.read_task_summary()} == {"kr_holidays", "seoul_apartments"}


def test_task_summary_is_last_recorded_row_per_task_in_name_order(store):
    """
    태스크마다 마지막에 기록한 1건을 태스크 이름 순으로 돌려줍니다 (PERF-03).

    실행 기록 전체를 훑던 DISTINCT ON을 태스크별 인덱스 첫 행 조회로 바꿨으므로,
    결과가 예전과 같은지(최신 기준 = 기록 순서, 이름 순, 같은 컬럼) 고정해 둡니다.
    """
    run_id = store.start_run("fast")
    base = datetime(2026, 9, 1, tzinfo=timezone.utc)
    for task, status, minutes in (
        ("radar_rankings", "ok", 0),
        ("fx_history", "error", 5),
        ("radar_rankings", "error", 10),
        ("fx_history", "ok", 1),         # 시작 시각은 더 이르지만 나중에 기록 → 이것이 최신
        ("cot_history", "empty", 3),
    ):
        store.record_task_run(
            run_id, task, speed="fast", status=status,
            started_at=base + timedelta(minutes=minutes), duration_ms=1, detail=None,
        )

    everything = store.read_task_summary()
    assert [(row["task"], row["status"]) for row in everything] == [
        ("cot_history", "empty"), ("fx_history", "ok"), ("radar_rankings", "error"),
    ]
    assert list(everything[0]) == ["task", "speed", "status", "started_at", "duration_ms", "detail", "run_id"]

    # 한 번도 돌지 않은 이름은 행이 없고, 같은 이름을 두 번 줘도 한 행입니다.
    named = store.read_task_summary(["radar_rankings", "never_ran", "fx_history", "fx_history"])
    assert [(row["task"], row["status"]) for row in named] == [("fx_history", "ok"), ("radar_rankings", "error")]
    assert store.read_task_summary([]) == []


def test_purge_retired_datasets(store):
    store.put_observations("molit_apt", "2026-08-01", [{"lawd": "11680"}], entity_key="lawd")
    store.put_observations(catalog.OBS_RADAR, "2026-09-23", [{"code": "005930"}], entity_key="code")

    assert store.purge_retired_datasets() == 1
    assert store.read_observations("molit_apt") == []
    assert len(store.read_observations(catalog.OBS_RADAR)) == 1


def test_purge_run_logs_only_touches_old_run_logs(store):
    """
    보존 기간이 지난 실행 기록만 지웁니다 (ARC-03). 수집한 데이터는 기간과 무관하게 남습니다.

    기간과 무관하게 남기는 실행 기록
      - 태스크마다 가장 최근 1건: 오래 돌지 않은 태스크도 상태 화면이 "마지막 실행"을 보여 줍니다.
      - 최근 실행 50건(collector_runs).
    """
    long_ago = datetime.now(timezone.utc) - timedelta(days=100)
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO collector_runs (started_at, status, group_name) "
            "SELECT %s + g * interval '1 minute', 'ok', 'slow' FROM generate_series(1, 55) g",
            (long_ago,),
        )
    recent_run = store.start_run("slow")
    for task, started_at in (
        ("fx_history", long_ago),                                      # 오래됨 + 더 최근 기록 있음 → 삭제
        ("fx_history", datetime.now(timezone.utc) - timedelta(days=1)),
        ("cot_history", long_ago),                                     # 오래됐지만 이 태스크의 마지막 기록 → 유지
    ):
        store.record_task_run(recent_run, task, speed="slow", status="ok",
                              started_at=started_at, duration_ms=1, detail=None)
    old_day = (long_ago - timedelta(days=300)).date().isoformat()
    store.put_timeseries("demo", "S", [(old_day, 1.0)])
    store.put_observations("demo_obs", old_day, [{"code": "005930"}], entity_key="code")

    removed = store.purge_run_logs(90)

    assert removed == {"taskRuns": 1, "collectorRuns": 6}    # 오래된 실행 55건 중 최근 50건 안에 드는 49건은 유지
    remaining = {(row["task"], row["started_at"].date()) for row in store.read_task_history(limit=10)}
    assert remaining == {
        ("fx_history", (datetime.now(timezone.utc) - timedelta(days=1)).date()),
        ("cot_history", long_ago.date()),
    }
    assert [row["date"] for row in store.read_timeseries("demo", "S")] == [old_day]
    assert len(store.read_observations("demo_obs")) == 1
    assert store.purge_run_logs(90) == {"taskRuns": 0, "collectorRuns": 0}


def test_replace_observations_swaps_only_the_matching_prefix_for_that_day(store):
    def rec(entity, code, amount):
        return {"entity": entity, "code": code, "netAmountEok": amount}

    store.put_observations(catalog.OBS_RADAR, "2026-09-11", [
        rec("K|F|B|T|A", "A", 10.0), rec("K|F|B|T|B", "B", 9.0),
        rec("K|I|B|T|Z", "Z", 5.0),                      # 다른 조합, 같은 날
    ], entity_key="entity")
    store.put_observations(catalog.OBS_RADAR, "2026-09-10", [
        rec("K|F|B|T|A", "A", 1.0),                      # 같은 조합, 다른 날
    ], entity_key="entity")

    written = store.replace_observations(
        catalog.OBS_RADAR, "2026-09-11", "K|F|B|T|",
        [rec("K|F|B|T|B", "B", 50.0), rec("K|F|B|T|C", "C", 40.0)],
        entity_key="entity",
    )

    assert written == 2
    today = {r["code"]: r["netAmountEok"]
             for r in store.read_observations(catalog.OBS_RADAR, obs_date="2026-09-11")}
    assert today == {"B": 50.0, "C": 40.0, "Z": 5.0}
    assert [r["code"] for r in store.read_observations(catalog.OBS_RADAR, obs_date="2026-09-10")] == ["A"]


def test_replace_observations_with_nothing_to_write_deletes_nothing(store):
    store.put_observations(catalog.OBS_RADAR, "2026-09-11",
                           [{"entity": "K|F|B|T|A", "code": "A"}], entity_key="entity")

    assert store.replace_observations(catalog.OBS_RADAR, "2026-09-11", "K|F|B|T|",
                                      [{"code": "no-entity"}], entity_key="entity") == 0
    assert len(store.read_observations(catalog.OBS_RADAR, obs_date="2026-09-11")) == 1


def test_timeseries_never_overwrites_a_value_with_unknown(store):
    """
    외부 소스가 하루 값을 빼먹으면(필드 이름 변경·빈 문자열) None이 옵니다.
    그걸 NULL로 upsert하면 전에 받아 둔 확정치가 지워지고, 읽기는 NULL을 숨기므로
    조용히 구멍이 납니다. 모르는 값은 쓰지 않고, 쓴 행 수에도 세지 않습니다.
    """
    assert store.put_timeseries("demo", "S", [("2026-01-02", 1.0), ("2026-01-03", 2.0)]) == 2
    assert store.put_timeseries("demo", "S", [("2026-01-02", None), ("2026-01-03", 3.0),
                                              ("2026-01-04", float("nan"))]) == 1

    assert store.read_timeseries("demo", "S") == [
        {"date": "2026-01-02", "value": 1.0},
        {"date": "2026-01-03", "value": 3.0},
    ]


def test_timeseries_same_value_does_not_create_a_new_row_version(store):
    """
    값이 같은 점을 다시 쓰면 PostgreSQL은 새 행 버전을 만듭니다(WAL·죽은 행). 매시간 10년치를
    다시 upsert해 31k행 테이블에 갱신이 346만 번 쌓였습니다. 같은 값은 건드리지 않습니다.
    """
    store.put_timeseries("demo", "S", [("2026-01-02", 1.0), ("2026-01-03", 2.0)])
    with store.connection() as conn:
        before = conn.execute("SELECT xmin FROM timeseries WHERE dataset='demo' ORDER BY obs_date").fetchall()

    store.put_timeseries("demo", "S", [("2026-01-02", 1.0), ("2026-01-03", 2.5)])   # 하나만 바뀜
    with store.connection() as conn:
        after = conn.execute("SELECT xmin FROM timeseries WHERE dataset='demo' ORDER BY obs_date").fetchall()

    assert after[0]["xmin"] == before[0]["xmin"], "같은 값은 새 버전을 만들지 않는다"
    assert after[1]["xmin"] != before[1]["xmin"], "바뀐 값은 갱신된다"
    assert store.read_timeseries("demo", "S")[1]["value"] == 2.5
    assert store.latest_timeseries_date("demo", "S") == "2026-01-03"
    assert store.latest_timeseries_date("demo", "none") is None


def test_QA139_좀비가_도는_동안에도_태스크_요약의_최근_결과는_시간_초과다(store):
    """
    시간 상한을 넘긴 실행이 뒤에서 계속 도는 동안의 호출은 empty '이전 수집이 아직 진행 중' 한 줄을 남깁니다(QA-117 — 수동
    '다시 실행'이 15분 기다리지 않게). 그런데 태스크별 요약이 그 행을 최근 결과로 골라, 실제로는 멈춰 있는 태스크가 상태
    화면의 '현재 오류'에서 빠졌습니다. 요약은 그 안내 행 대신 앞선 실행(✗ 시간 초과)을 씁니다. 실행 기록에는 남습니다.
    """
    from app.tasks import runner
    from app.tasks.base import Task

    run_id = store.start_run("fast")
    store.record_task_run(
        run_id, "macro_collected", speed="fast", status="error",
        started_at=datetime.now(timezone.utc), duration_ms=120_000,
        detail="시간 초과: 120초 안에 끝나지 않았습니다 — 외부 응답 없음 의심.",
    )
    runner._still_running(Task("macro_collected", "fast", lambda: "", "매크로 카드"), run_id)

    latest = {row["task"]: row for row in store.read_task_summary()}["macro_collected"]
    assert (latest["status"], latest["detail"][:5]) == ("error", "시간 초과")
