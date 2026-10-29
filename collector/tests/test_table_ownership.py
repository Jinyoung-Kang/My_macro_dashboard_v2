"""
tests/test_table_ownership.py
테이블마다 쓰는 프로세스는 하나(ADR 0008) — 수집기는 백엔드가 쓰는 테이블에 쓰지 않습니다.

백엔드 쪽은 ArchitectureRulesTest가 "백엔드는 수집기 테이블에 쓰지 않는다"를 검사합니다. 여기는 그 반대입니다.
수집기가 읽기만 하는 백엔드 테이블은 alert_rules(관심 종목 코드)·paper_positions·paper_books(장중 평가 범위 — ADR 0020)·
paper_orders(Claude 계좌2 1분봉 범위 — ADR 0022)입니다.
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
    # 미국 Claude 계좌2 실행 감사(V17, ADR 0022) — 1분봉은 수집기가 받고, 주문별 감사 행은 백엔드만 씁니다.
    "paper_order_exec",
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


# 🧪 한국 책(v2 2단계 B4) 데이터셋 — 쓰는 곳은 app/tasks/kr_paper.py 하나입니다(읽기·누락 점검은 어디서든).
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


# 🧪 한국 책(v2 2단계 B9) 데이터셋 — 데이터셋마다 쓰는 모듈이 하나입니다(읽기는 어디서든).
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


# 🧪 미국 Claude 계좌2 단계 0(명세 2026-10-30 §12-1·ADR 0022) — 1분봉 저장본을 쓰는 모듈은 하나입니다(읽기는 백엔드 실행 감사 작업, 0-4).
CLAUDE2_WRITERS = {"SNAP_PAPER_BARS_US": "tasks/paper_bars.py"}
CLAUDE2_WRITE = re.compile(
    r"\b(put_snapshot|put_observations|put_entity_observations|replace_observations|insert_new_observations|"
    r"add_headline_feeds|put_timeseries|delete_observations_before)\(\s*catalog\.(" + "|".join(CLAUDE2_WRITERS) + r")\b"
)


def test_계좌2_1분봉_데이터셋은_paper_bars_태스크만_쓴다():
    writers = {}
    for path in APP.rglob("*.py"):
        for match in CLAUDE2_WRITE.finditer(path.read_text(encoding="utf-8")):
            writers.setdefault(match.group(2), set()).add(path.relative_to(APP).as_posix())
    assert writers == {name: {module} for name, module in CLAUDE2_WRITERS.items()}
