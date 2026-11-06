"""
tests/test_api_token.py
수집기 API의 서비스 토큰 검사.

[왜 필요한가]
수집기는 데이터를 받아오는 쪽이라 호출 한 번이 외부 API 호출과 저장을
일으킵니다. 예전에는 /collect·/refresh·/maintenance에만 토큰 검사가 있고
/live/* · /verify/* · /toss/* · /diagnostics/*에는 없었습니다. 토큰을 켜 둬도
수집을 유발하는 경로가 그대로 열려 있었던 셈입니다.

토큰을 설정하지 않으면(로컬 기본값) 아무것도 막지 않는다는 성질은 그대로
유지해야 합니다. 그렇지 않으면 `make collect`가 바로 401로 죽습니다.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main

# 검사가 걸려 있어야 하는 경로. 외부 호출·수집·저장을 일으키거나
# 시장 데이터를 그대로 돌려주는 것들입니다.
PROTECTED = [
    ("get", "/live/ticker/^VIX"),
    ("get", "/live/daum-intraday"),
    ("get", "/verify/readings"),
    ("get", "/diagnostics/connections"),
    ("get", "/diagnostics/toss"),
    ("get", "/diagnostics/public-apis"),
    ("get", "/toss/exchange-rate"),
    ("get", "/toss/indices?symbols=KOSPI"),
    ("get", "/toss/account"),
    ("get", "/toss/trading/status"),
    ("get", "/toss/trading/calendar"),
    ("post", "/toss/trading/warmup"),
    ("get", "/toss/trading/preflight?symbols=005930"),
    ("post", "/toss/trading/orders"),
    ("post", "/toss/trading/orders/ord-1/cancel"),
    ("get", "/toss/trading/orders/open"),
    ("get", "/toss/trading/orders/today"),
    ("get", "/toss/trading/orders/ord-1"),
    ("post", "/collect?group=fast"),
    ("post", "/refresh"),
]

# 토큰 없이도 열려 있어야 하는 경로.
#   /health  컨테이너 헬스체크가 헤더 없이 호출합니다.
#   /status  make status·scripts/doctor.sh가 호출하며, 비밀값은 담지 않습니다
#            (키는 설정 여부만 true/false로 알립니다).
OPEN = ["/health", "/status"]


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "test-token")
    # lifespan(스케줄러·DB 연결)을 띄우지 않고 라우팅만 확인합니다.
    #
    # raise_server_exceptions=False — 이 테스트가 보는 것은 '인증에서 막히는가'
    # 하나입니다. DB가 없는 환경(CI의 수집기 잡은 앱용 DB를 띄우지 않습니다)에서
    # /status가 DB 연결 실패로 터지는 것은 여기서 판단할 문제가 아닙니다.
    # 예외를 그대로 올리면 그 환경 차이가 인증 테스트의 실패로 둔갑합니다.
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.mark.parametrize("method,path", PROTECTED)
def test_토큰_없으면_401(client, method, path):
    response = getattr(client, method)(path)
    assert response.status_code == 401, f"{path} 가 토큰 없이 통과했습니다"


@pytest.mark.parametrize("method,path", PROTECTED)
def test_틀린_토큰도_401(client, method, path):
    response = getattr(client, method)(path, headers={"X-Service-Token": "wrong"})
    assert response.status_code == 401, f"{path} 가 잘못된 토큰으로 통과했습니다"


@pytest.mark.parametrize("path", OPEN)
def test_상태_경로는_토큰_없이도_401이_아니다(client, path):
    """
    응답 내용이 아니라 '인증으로 막히지 않는다'만 봅니다.
    (DB가 없는 환경에서는 /status가 500일 수 있습니다.)
    """
    assert client.get(path).status_code != 401


def test_토큰을_설정하지_않으면_막지_않는다(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "")
    # 검사 함수만 직접 확인합니다. 실제 호출은 외부 네트워크를 타기 때문입니다.
    main._check_token(None)
    main._check_token("아무값")
