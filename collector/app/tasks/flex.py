"""
app/tasks/flex.py
flex 속도군(탄력 주기 — ADR 0040). 주기로 돌지 않고, 1분 틱(main)이 '때가 된 일이 있는' 태스크만 이름으로 실행합니다.

  - polite(app/tasks/polite)처럼 '때가 된 것만' 돌지만 차단 통과 수집 계층이 아닙니다 — 공용 세션으로 받고 **로컬에서도 돕니다**
    (``POLITE_FETCH_ENABLED``와 무관). 서버 IP·사용자 PC IP 어느 쪽으로 받아도 되는 출처만 둡니다(지금은 사건 뉴스 RSS).
  - 틱은 태스크마다 ``Task.due``(때가 된 항목이 있나 — 외부 호출 없이 표만 읽음)를 묻고, 아니면 그 태스크를 부르지 않습니다. 할 일이
    없던 틱은 실행 기록을 남기지 않습니다(polite와 같은 관례 — ADR 0040 결정 5). 수동 단일 실행·전체 수집은 태스크 머리의 같은 확인을 지나
    때가 아니면 외부를 부르지 않고 EmptyResult로 끝납니다.
  - 항목(피드 등)마다의 다음 시각은 표 ``fetch_schedule``에 ``태스크/항목`` 이름으로 둡니다 — 재기동해도 이어지고, polite 태스크의 줄
    (태스크 이름에 ``/``가 없음)과 겹치지 않습니다.
  - 틱이 1분인 까닭: 뒤 단계(경제지표 발표 + 2~4분, 결정 5~3분 전)가 몇 분 단위 창에 맞춰 받아야 해서입니다. 틱 자체는 표를 한 번 읽을
    뿐이라(외부 호출 없음) 짧아도 부담이 없습니다.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .. import store

SPEED = "flex"

# 틱 간격(초)과 그 위에 얹는 지터 상한(초 — APScheduler interval의 jitter는 0~이 값만큼 늦춤). 지터는 다른 속도군 작업과 같은 초에
# 맞물리지 않게 하는 정도입니다. 항목의 실행 시각은 틱이 아니라 항목마다 무작위로 정한 다음 시각이 정합니다.
TICK_SECONDS = 60
TICK_JITTER_SECONDS = 10
# 늦게 깬 틱을 버리지 않는 유예(초) — 틱보다 짧아야 밀린 틱과 다음 틱이 겹치지 않습니다(QA-374와 같은 규칙).
TICK_MISFIRE_GRACE_SECONDS = 30

# fetch_schedule 이름의 구분자 — '태스크/항목'. polite 태스크 이름에는 이 글자가 없습니다.
KEY_SEPARATOR = "/"


def _utcnow() -> datetime:
    """지금 시각(UTC). 시험이 바꿔 끼우는 자리입니다."""
    return datetime.now(timezone.utc)


def key(task: str, item: str) -> str:
    """fetch_schedule 이름 — ``news_headlines/investing_stock``."""
    return f"{task}{KEY_SEPARATOR}{item}"


def due_map(task: str) -> dict[str, datetime]:
    """그 태스크 항목들의 다음 시각(항목 이름 → 시각). 정한 적이 없는 항목은 빠집니다."""
    prefix = f"{task}{KEY_SEPARATOR}"
    return {name[len(prefix):]: when for name, when in store.fetch_due_rows(prefix).items()}


def set_due(task: str, item: str, when: datetime) -> None:
    store.set_fetch_due_at(key(task, item), when)
