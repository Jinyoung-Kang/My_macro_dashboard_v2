"""
tests/test_table_ownership.py
테이블마다 쓰는 프로세스는 하나(ADR 0008) — 수집기는 백엔드가 쓰는 테이블에 쓰지 않습니다.

백엔드 쪽은 ArchitectureRulesTest가 "백엔드는 수집기 테이블에 쓰지 않는다"를 검사합니다. 여기는 그 반대입니다.
수집기가 읽기만 하는 백엔드 테이블은 alert_rules(관심 종목 코드)·paper_positions·paper_books(장중 평가 범위 — ADR 0020)·
paper_orders(Claude 계좌2 1분봉 범위 — ADR 0022)·paper_checkpoints(계좌2 장중 확인 감시 범위 — 단계 2, ADR 0022)·
paper_intraday_plans(자유 시점 판의 장중 판단 감시 범위 — ADR 0027)·search_watches·search_media_excludes(정보 검색 — ADR 0041)입니다.
"""
from __future__ import annotations

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
BACKEND_TABLES = (
    "regime_log", "users", "user_sessions", "audit_log", "email_tokens", "usage_counters",
    "alert_rules", "alert_events", "alert_deliveries",
    # 모의 알고리즘 매매(V8, 운영자 전용) — 장부·결정·설정은 백엔드 feature/paper만 씁니다. 수집기는 가격만 받습니다.
    "paper_books", "paper_book_state", "paper_positions", "paper_lockouts", "paper_decisions", "paper_orders",
    "paper_fills", "paper_nav_daily", "paper_gate_log", "paper_track_record", "paper_selection_log",
    "paper_framework_versions", "paper_notes", "paper_framework_proposals", "paper_settings",
    "paper_settings_history", "paper_job_runs", "paper_api_usage", "paper_start_prices",
    # 주간 복기(V12, 2단계 D) — 백엔드 정기 작업만 씁니다.
    "paper_reviews",
    # 한국 책 확정 조정(V14, v2 2단계 K29) — 금융위 확정가는 수집기가 받고, 조정 행은 백엔드 장부만 씁니다.
    "paper_fill_confirmations",
    # 미국 체결 비용 소급 조정(V26, ADR 0030) — 조정 행은 백엔드 장부만 씁니다. 수집기는 읽지도 쓰지도 않습니다.
    "paper_cost_adjustments",
    # 미국 Claude 계좌2 실행 감사(V17, ADR 0022) — 1분봉은 수집기가 받고, 주문별 감사 행은 백엔드만 씁니다.
    "paper_order_exec",
    # 미국 Claude 계좌2 장중 확인(V18, ADR 0022 단계 2) — 계획·결과는 백엔드만 씁니다. 수집기는 감시 범위를 읽기만 합니다.
    "paper_checkpoints",
    # 자유 시점 판의 장중 판단 계획(V23, ADR 0027) — 계획·결과는 백엔드만 씁니다. 수집기는 감시 범위를 읽기만 합니다.
    "paper_intraday_plans",
    # 마감 브리핑의 기록(V36, ADR 0039) — 백엔드 정기 작업만 씁니다. 수집기는 읽지도 쓰지도 않습니다.
    "paper_briefings",
    # 실제 매매(V24, ADR 0028) — 설정·이벤트·묶음·주문 기록은 백엔드 feature/realtrade만 씁니다. 수집기는 읽지도 쓰지도 않습니다
    # (주문은 백엔드가 수집기 /toss/trading/*를 불러 보냄 — 기록은 백엔드가 남김).
    "real_trade_config", "real_trade_events", "real_trade_batches", "real_trade_orders",
    # 마지막 운용 평가액(V29, 2026-11-08 — ADR 0028 결정 7 범위)도 백엔드 feature/realtrade만 씁니다.
    "real_trade_valuation",
    # 수집 출처 끊김 알림의 기록(V34 — ADR 0035) — 백엔드 SourceAlertJob만 씁니다.
    "source_alerts",
    # 한국어 번역 저장(V35 — ADR 0037) — 백엔드 store.TranslationStore만 씁니다.
    "info_translations",
    # ISA 계좌(V25, ADR 0029) — 연결되지 않은 다른 증권사 계좌의 장부·지시는 백엔드 feature/realtrade만 씁니다. 수집기는 읽지도 쓰지도 않습니다.
    # 장중 스탑 매도 지시(V28, ADR 0033)도 같습니다.
    "manual_accounts", "manual_ledger", "manual_instructions", "manual_sessions", "manual_stop_instructions",
    # 잔고 구조(V31, ADR 0034)도 같습니다.
    "manual_balance", "manual_positions", "manual_trades",
    # 정보 검색의 관심 대상·사용자가 더한 제외 매체(V37, ADR 0041) — 백엔드 feature/search만 씁니다. 수집기는 읽기만 합니다
    # (store.search_watch_targets·search_media_excludes — 관심 대상 정기 수집과 매체 제외).
    "search_watches", "search_media_excludes",
)
WRITE = re.compile(
    r"(?i)(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(" + "|".join(BACKEND_TABLES) + r")\b"
)


def test_수집기는_백엔드_테이블에_쓰지_않는다():
    found = []
    for path in APP.rglob("*.py"):
        for match in WRITE.finditer(path.read_text(encoding="utf-8")):
            found.append(f"{path.name}: {match.group(0)}")
    assert found == []


# 한국 책(v2 2단계 B4) 데이터셋 — 쓰는 곳은 app/tasks/kr_paper.py 하나입니다(읽기·누락 점검은 어디서든).
KR_DATASETS = ("OBS_KR_PAPER_UNIVERSE", "SNAP_KR_PAPER_QUOTES", "TS_KR_CLOSE_ADJ", "OBS_KR_PAPER_FLOW",
               "SNAP_KR_PAPER_FLOWS_STATUS")
STORE_WRITE = re.compile(
    r"\b(put_snapshot|put_observations|put_entity_observations|replace_observations|insert_new_observations|"
    r"add_headline_feeds|put_timeseries|delete_observations_before)\(\s*catalog\.(" + "|".join(KR_DATASETS) + r")\b"
)


def test_한국_책_데이터셋은_kr_paper_태스크만_쓴다():
    writers = {}
    for path in APP.rglob("*.py"):
        for match in STORE_WRITE.finditer(path.read_text(encoding="utf-8")):
            writers.setdefault(match.group(2), set()).add(path.relative_to(APP).as_posix())
    assert writers == {name: {"tasks/kr_paper.py"} for name in KR_DATASETS}


def test_한국_책_수집_범위는_백엔드_표를_읽지_않는다():
    """끈적 목록은 수집기 자기 저장본(유니버스 이력)으로 정합니다 — 보유·주문 표를 읽으면 교차 읽기 예외(alert_rules 하나)가 늘어납니다."""
    text = (APP / "tasks" / "kr_paper.py").read_text(encoding="utf-8")
    assert [name for name in BACKEND_TABLES if re.search(rf"\b{name}\b", text)] == []
    assert "watched_stock_codes" not in text


# 한국 책(v2 2단계 B9) 데이터셋 — 데이터셋마다 쓰는 모듈이 하나입니다(읽기는 어디서든).
B9_WRITERS = {
    "OBS_KR_NEWS_HEADLINE": "tasks/kr_news.py",
    "SNAP_KR_NEWS_STATUS": "tasks/kr_news.py",
    "SNAP_KR_CALENDAR": "tasks/kr_calendar.py",
    "SNAP_US_CONSENSUS": "tasks/us_consensus.py",
}
B9_WRITE = re.compile(
    r"\b(put_snapshot|put_observations|put_entity_observations|replace_observations|insert_new_observations|"
    r"add_headline_feeds|put_timeseries|delete_observations_before)\(\s*catalog\.(" + "|".join(B9_WRITERS) + r")\b"
)


def test_B9_데이터셋은_정해진_태스크_하나만_쓴다():
    writers = {}
    for path in APP.rglob("*.py"):
        for match in B9_WRITE.finditer(path.read_text(encoding="utf-8")):
            writers.setdefault(match.group(2), set()).add(path.relative_to(APP).as_posix())
    assert writers == {name: {module} for name, module in B9_WRITERS.items()}


# 미국 Claude 계좌2 단계 0(명세 2026-10-30 §12-1·ADR 0022) — 1분봉 저장본을 쓰는 모듈은 하나입니다(읽기는 백엔드 실행 감사 작업, 0-4).
# 단계 2의 장중 확인 감시 저장본도 쓰는 모듈은 하나입니다(읽기는 백엔드 장중 확인 — B1).
CLAUDE2_WRITERS = {"SNAP_PAPER_BARS_US": "tasks/paper_bars.py", "SNAP_PAPER_WATCH_US": "tasks/paper_watch.py"}
CLAUDE2_WRITE = re.compile(
    r"\b(put_snapshot|put_observations|put_entity_observations|replace_observations|insert_new_observations|"
    r"add_headline_feeds|put_timeseries|delete_observations_before)\(\s*catalog\.(" + "|".join(CLAUDE2_WRITERS) + r")\b"
)


def test_계좌2_1분봉·감시_데이터셋은_정해진_태스크_하나만_쓴다():
    writers = {}
    for path in APP.rglob("*.py"):
        for match in CLAUDE2_WRITE.finditer(path.read_text(encoding="utf-8")):
            writers.setdefault(match.group(2), set()).add(path.relative_to(APP).as_posix())
    assert writers == {name: {module} for name, module in CLAUDE2_WRITERS.items()}


def test_계좌2_감시_범위는_백엔드_표를_읽기만_한다():
    """장중 감시(paper_watch.py·paper_watch_kr.py)는 범위를 store.watch_plans(끈 판 장중 확인 행 watch_scope + 켠 판 장중 판단 행
    intraday_watch_plans — ADR 0027)로만 읽습니다 — 태스크 모듈에는 SQL이 없고, 범위 함수에는 쓰기 문장이 없습니다."""
    import inspect

    from app import store

    for module in ("paper_watch.py", "paper_watch_kr.py"):
        task = (APP / "tasks" / module).read_text(encoding="utf-8")
        assert [name for name in BACKEND_TABLES if re.search(rf"\b{name}\b", task)] == [], module
        assert not re.search(r"(?i)\b(SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\s", task), module
        assert "store.watch_plans(" in task and "store.watch_scope(" not in task, module
    scope = inspect.getsource(store.watch_scope)
    assert not re.search(r"(?i)\b(INSERT|UPDATE|DELETE|TRUNCATE)\b", scope)
    assert "paper_checkpoints" in scope
    plans = inspect.getsource(store.intraday_watch_plans)
    assert not re.search(r"(?i)\b(INSERT|UPDATE|DELETE|TRUNCATE)\b", plans)
    assert "paper_intraday_plans" in plans
    assert not re.search(r"(?i)\b(SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\s", inspect.getsource(store.watch_plans))


# 정보 검색(ADR 0041 단계 3) — 수집기 표 search_watch_items(관심 대상이 모은 글)·fetch_budgets(검색·관심 대상 호스트 예산)는 store.py만 쓰고,
# 새 피드 묶음 데이터셋은 tasks/search_feeds.py만 씁니다(읽기는 어디서든 — 정보 검색·관심 대상 대조).
SEARCH_TABLE_WRITE = re.compile(r"(?i)(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(search_watch_items|fetch_budgets)\b")
SEARCH_WRITERS = {"OBS_SEARCH_FEED_HEADLINE": "tasks/search_feeds.py", "SNAP_SEARCH_FEEDS_STATUS": "tasks/search_feeds.py"}
SEARCH_DATASET_WRITE = re.compile(
    r"\b(put_snapshot|update_snapshot_payload|put_observations|put_entity_observations|replace_observations|insert_new_observations|"
    r"add_headline_feeds|put_timeseries|delete_observations_before)\(\s*catalog\.(" + "|".join(SEARCH_WRITERS) + r")\b"
)


def test_정보_검색_수집기_표는_store_py만_쓴다():
    writers = {}
    for path in APP.rglob("*.py"):
        for match in SEARCH_TABLE_WRITE.finditer(path.read_text(encoding="utf-8")):
            writers.setdefault(match.group(2).lower(), set()).add(path.relative_to(APP).as_posix())
    assert writers == {"search_watch_items": {"store.py"}, "fetch_budgets": {"store.py"}}


def test_새_피드_묶음_데이터셋은_search_feeds_태스크만_쓴다():
    writers = {}
    for path in APP.rglob("*.py"):
        for match in SEARCH_DATASET_WRITE.finditer(path.read_text(encoding="utf-8")):
            writers.setdefault(match.group(2), set()).add(path.relative_to(APP).as_posix())
    assert writers == {name: {module} for name, module in SEARCH_WRITERS.items()}


def test_관심_대상_수집은_백엔드_표를_store_함수로만_읽는다():
    """tasks/search_watch.py에는 SQL이 없고, 백엔드 표를 읽는 store 함수에는 쓰기 문장이 없습니다."""
    import inspect

    from app import store

    code = (APP / "tasks" / "search_watch.py").read_text(encoding="utf-8").split('"""', 2)[2]     # 모듈 설명 뒤
    assert ".execute(" not in code and "connection(" not in code
    assert [name for name in BACKEND_TABLES if re.search(rf"\b{name}\b", code)] == []
    for reader in (store.search_watch_targets, store.search_media_excludes):
        source = inspect.getsource(reader)
        assert not re.search(r"(?i)\b(INSERT|UPDATE|DELETE|TRUNCATE)\b", source), reader.__name__


def test_수집기는_관심_대상_알림_칸을_읽지도_쓰지도_않는다():
    """V38의 notify·notified_at(계약 §9-5)은 백엔드 알림 작업만 씁니다 — 수집기는 그 칸을 쓰지 않고, 관심 대상 읽기도 칸을 골라 읽습니다."""
    import inspect

    from app import store

    assert [path.name for path in APP.rglob("*.py") if re.search(r"\bnotified_at\b", path.read_text(encoding="utf-8"))] == []
    source = inspect.getsource(store.search_watch_targets)
    assert "SELECT entity_key, kind, name, name_ko, name_en, aliases, ids FROM search_watches" in source and "SELECT *" not in source
    assert not re.search(r"\bnotify\b", source), "알림 칸은 읽지 않음(이름 두 칸 name_ko·name_en만 V38에서 더 읽음)"
