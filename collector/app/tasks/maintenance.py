"""
app/tasks/maintenance.py
유지보수 — 수집 실행 기록 정리, 정보 수집 글 보관 기간 정리.
"""
from __future__ import annotations

import logging

from .. import settings, store

logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)


# ==============================================================================
# 유지보수
# ==============================================================================
def task_run_log_retention() -> str:
    """
    수집 실행 기록 정리 — 보존 기간(기본 90일)이 지난 실행 기록만 지웁니다.

    실행 기록은 하루 약 1,200행씩 쌓입니다(1년이면 43만 행). 그대로 두면 DB가 커지고
    상태 화면 조회가 느려집니다. 수집한 데이터(시계열·누적 레코드)는 지우지 않습니다.
    기간은 COLLECTOR_RUN_LOG_RETENTION_DAYS로 바꿉니다.
    """
    days = settings.run_log_retention_days()
    removed = store.purge_run_logs(days)
    # 정보 수집(ADR 0035)의 글은 본문까지 저장해 커지므로 180일만 둡니다(원문 링크는 출처에 남아 있음).
    info = store.delete_info_items_before(store.INFO_RETENTION_DAYS)
    return (
        f"{days}일 지난 실행 기록 정리 — 태스크 {removed['taskRuns']:,}건 · "
        f"실행 {removed['collectorRuns']:,}건 · 정보 수집 글 {store.INFO_RETENTION_DAYS}일 지난 것 {info:,}건"
    )


