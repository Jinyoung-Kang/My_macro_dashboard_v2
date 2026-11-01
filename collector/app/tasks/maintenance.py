"""
app/tasks/maintenance.py
유지보수 — 수집 실행 기록 정리.
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
    return (
        f"{days}일 지난 실행 기록 정리 — 태스크 {removed['taskRuns']:,}건 · "
        f"실행 {removed['collectorRuns']:,}건"
    )


