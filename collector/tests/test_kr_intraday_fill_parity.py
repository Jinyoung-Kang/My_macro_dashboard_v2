"""
tests/test_kr_intraday_fill_parity.py
한국 장중 감시 STOP 체결의 두 길 대조 표(ADR 0045) — backend/src/test/resources/paper/kr-intraday-fill/cases.json.

표의 사례마다 입력(토스 정규화 1분봉·주문 생성 시각·감시 회차 시각)으로 수집기의 실제 함수가 만드는 두 조각을 다시 만들어 표에 적힌 조각과 같은지
본다 — 밤 조각은 kr_paper_timed._summarize(장중 시장가 기준 분 market_target의 창 포함), 감시 조각은 paper_stopwatch.kr_entry(이어받은 항목이면
isStale). 백엔드 시험 KrIntradayFillParityTest가 같은 표의 두 조각으로 밤 사다리(길 A)와 장중 R1(길 B)을 세어, 길 B가 R1이면 길 A도 같은 값·출처인지
본다. 수집기 함수가 바뀌어 조각이 달라지면 이 시험이 먼저 깨진다(백엔드 시험이 옛 조각으로 지나가지 않게).

DB·네트워크를 쓰지 않는다.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from app.tasks import kr_paper_timed, paper_stopwatch

CASES = Path(__file__).resolve().parents[2] / "backend" / "src" / "test" / "resources" / "paper" / "kr-intraday-fill" / "cases.json"


def _cases() -> list[dict]:
    if not CASES.exists():
        pytest.skip("backend/src/test/resources/paper/kr-intraday-fill/cases.json을 찾을 수 없습니다")
    return json.loads(CASES.read_text(encoding="utf-8"))["cases"]


def test_table_has_the_planned_cases():
    names = [case["name"] for case in _cases()]
    assert names == ["r1", "t1-no-volume", "not-settled", "before-t1", "label-t-traded", "t1-no-open", "out-of-40", "exam-day",
                     "stale", "other-session", "corrected", "t1-no-close"]


@pytest.mark.parametrize("index", range(12))
def test_fragments_match_the_collector_functions(index):
    case = _cases()[index]
    created = datetime.fromisoformat(case["createdAt"])
    key = kr_paper_timed.market_target(created)
    assert key == case["marketKey"], case["name"]
    night = case["nightCandles"] if case["nightCandles"] is not None else case["candles"]
    assert kr_paper_timed._summarize(night, case["session"], [key]) == case["night"], case["name"]
    entry = paper_stopwatch.kr_entry(case["candles"], datetime.fromisoformat(case["watchFetchedAt"]), case["watchFirstLabel"])
    if entry is not None and case["watchStale"]:
        entry["isStale"] = True
    assert entry == case["watch"], case["name"]


def test_watch_entry_drops_bars_without_close_but_the_night_summary_keeps_them():
    """비대칭 하나(ADR 0045 대조 표 t1-no-close): 감시 항목은 종가가 없는 봉을 버리고 밤 요약은 거르지 않는다 — 장중 길이 R1을 못 고르는 쪽(밤에 맡김)."""
    case = next(c for c in _cases() if c["name"] == "t1-no-close")
    labels = [bar["label"] for bar in case["watch"]["bars"]]
    assert "13:12" not in labels
    assert case["night"]["windows"]["13:11"][0] == {"label": "13:12", "open": 70170, "volume": 100}
