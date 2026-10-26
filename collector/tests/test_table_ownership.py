"""
tests/test_table_ownership.py
테이블마다 쓰는 프로세스는 하나(ADR 0008) — 수집기는 백엔드가 쓰는 테이블에 쓰지 않습니다.

백엔드 쪽은 ArchitectureRulesTest가 "백엔드는 수집기 테이블에 쓰지 않는다"를 검사합니다. 여기는 그 반대입니다.
수집기가 읽어도 되는 백엔드 테이블은 alert_rules(관심 종목 코드) 하나뿐입니다.
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
