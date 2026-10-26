"""
tests/test_toss_call_budget.py
DATA_SOURCES.md의 토스 호출 예산이 코드의 상수와 맞는지.

문서는 투자자 매매 그룹(STOCK_TRADING_TREND·MARKET_INDICATOR)을 '1시간에 최대 42회'(레이더 40종목 + 시장 2)로
적었지만, 그 뒤 관심 종목(최대 60)과 레이더 폴백(거래대금 상위 100종목)이 같은 시간 주기에 붙어 실제로는
최대 202회입니다. 한도를 가늠하거나 403·429 원인을 찾는 사람이 문서의 숫자를 믿으면 부하를 5배 낮게 봅니다.
상수를 바꾸면 이 테스트가 문서도 함께 고치게 합니다.
"""
from __future__ import annotations

import re
from pathlib import Path

from app.services import toss as toss_service
from app.tasks import kr_paper, toss

ROOT = Path(__file__).resolve().parents[2]


def _bullet(title: str) -> str:
    doc = (ROOT / "docs/DATA_SOURCES.md").read_text(encoding="utf-8")
    line = next((ln for ln in doc.splitlines() if ln.startswith(f"- **{title}**")), None)
    assert line, f"DATA_SOURCES.md에 '{title}' 항목이 없습니다"
    start = doc.index(line)
    return doc[start:doc.index("\n- **", start + 1)]


def _budget_line() -> str:
    return _bullet("호출 간격")


def test_DATA_SOURCES의_토스_호출_예산이_코드_상수와_같다():
    text = _budget_line()
    stated = re.search(r"1시간에 최대 (\d+)회", text)
    assert stated, text
    per_hour = (toss.TOSS_STOCK_LIMIT + toss.TOSS_WATCHED_LIMIT + toss.TOSS_RADAR_UNIVERSE
                + len(toss_service.MARKET_SYMBOLS))
    assert int(stated.group(1)) == per_hour
    # 숫자만 다시 적으면 또 어긋나므로, 어떤 상수의 합인지 함께 적습니다.
    for name in ("TOSS_STOCK_LIMIT", "TOSS_WATCHED_LIMIT", "TOSS_RADAR_UNIVERSE"):
        assert name in text, name


# 🧪 한국 책(v2 2단계 B4) — 하루 한 번 도는 태스크마다 실행당 상한. (태스크, 상수 이름) — 문서의 숫자와 상수 이름을 함께 대조합니다.
KR_BUDGETS = (
    ("kr_paper_quotes", "KR_QUOTES_CALL_BUDGET"),
)


def test_DATA_SOURCES의_한국_책_호출_예산이_코드_상수와_같다():
    text = _bullet("한국 책 호출 예산")
    for task, constant in KR_BUDGETS:
        stated = re.search(rf"`{task}` 실행당 최대 ([\d,]+)회", text)
        assert stated, f"{task}의 실행당 상한이 문서에 없습니다"
        assert int(stated.group(1).replace(",", "")) == getattr(kr_paper, constant), task
        assert constant in text, constant


def test_한국_책_관측치_예산은_종목_상태와_두_일봉을_함께_담는다():
    """일봉 원시·수정은 한 종목에 2회라, 상태 1회 뒤 적어도 한 종목은 끝까지 받을 수 있어야 합니다."""
    assert kr_paper.KR_QUOTES_CALL_BUDGET >= 1 + 2 + 1
