"""
tests/test_radar_task.py
수급 레이더 스케줄 태스크(radar_rankings)의 결과 글.

외부 네트워크와 DB를 쓰지 않습니다(체인·저장을 대체합니다).
"""
from __future__ import annotations

import pytest

from app.tasks import markets


def _result(kind: str, *, historical: bool = False) -> dict:
    return {
        "source": kind, "sourceKind": kind, "isHistorical": historical, "intervalType": "TODAY",
        "rows": [{"rank": 1, "code": "005930", "name": "삼성전자", "netAmountEok": 1.0}],
    }


@pytest.fixture()
def quiet_store(monkeypatch):
    saved: list[str] = []
    monkeypatch.setattr(markets.store, "put_snapshot", lambda name, payload: saved.append(name))
    monkeypatch.setattr(markets.radar_service, "accumulate_history", lambda *a, **k: None)
    return saved


def test_QA396_결과_글에_출처별_건수를_적는다(monkeypatch, quiet_store):
    """
    Daum이 비어 KRX 앞 거래일 확정 순위로 대체돼도 태스크는 '3/3 조합 수집'으로 끝났습니다. 며칠 끊겨도 실행 기록에서 알 수 없었습니다.
    """
    kinds = iter(["daum", "daum", "krx"])
    monkeypatch.setattr(markets.radar_service, "collect_radar_ranking", lambda *a, **k: _result(next(kinds)))

    message = markets.task_radar_rankings()

    assert message.startswith("3/3 조합")
    assert "daum 2" in message and "krx 1" in message
    assert len(quiet_store) == 3
