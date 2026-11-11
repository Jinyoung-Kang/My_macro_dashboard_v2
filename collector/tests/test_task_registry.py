"""
tests/test_task_registry.py
태스크 목록의 수 — 한 곳에서만 셉니다.

예전에는 태스크를 더한 시험 파일마다 같은 수를 단언해(16곳) 태스크 하나를 더할 때마다 모두 고쳐야 했습니다. 각 파일은 자기 태스크의 등록·
속도군·순서와 '이름이 겹치지 않음'만 보고, 수는 여기서 봅니다. 문서의 태스크 수(CLAUDE.md, README.md, docs/DATA_SOURCES.md §1)도 이 수와
같아야 합니다.
"""
from __future__ import annotations

from app import tasks

# 장중 평가 paper_live_us·paper_live_kr, 2단계 A의 us_calendar·B의 news_headlines·C의 earnings_surprise, v2 B3의 fsc_etf_prices,
# v2 B4의 kr_paper_universe·kr_paper_quotes·kr_paper_flows·kr_paper_price_history, v2 B9의 kr_calendar·kr_news_headlines·us_calendar_consensus,
# 계좌2 단계 0의 paper_bars_us·단계 2의 paper_watch_us, 한국 계좌2 단계 2a의 kr_paper_timed·2b의 paper_watch_kr,
# 차단 통과 수집 계층(ADR 0026, polite)의 econ_calendar_tradingview, 장중 스탑 감시(ADR 0032)의 paper_stopwatch_us·paper_stopwatch_kr,
# 정보 수집(ADR 0035, polite)의 블로그 14·waedge 3·네이버 1, KRX 정보데이터시스템(ADR 0036)의 info_krx_daily까지.
EXPECTED_TASKS = 63


def test_태스크_수와_이름():
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == EXPECTED_TASKS
