"""
tests/test_http_retry_after.py
공용 HTTP 세션이 서버의 Retry-After를 짧게 잘라 기다리는지 (QA-080).

urllib3 Retry는 기본으로 Retry-After를 6시간(21600초)까지 그대로 time.sleep합니다. 이 대기는 requests의
timeout에 들어가지 않아, 429·503에 'Retry-After: 3600'이 붙어 오면 요청 하나가 수집기 스레드를 몇 시간
붙잡았습니다(요청 경로 /live/*는 anyio 스레드 40개를, 태스크는 8-워커 풀을 함께 씁니다). 토스 클라이언트만
5초로 잘라 쓰고 있었습니다.

실제로 기다리면 테스트가 몇 시간 걸리므로, urllib3가 '얼마나 자려 했는지'만 기록합니다(가상 시계).

v2 1단계 6번부터 공용·FRED·SEC 세션은 429를 다시 보내지 않고 거부 래치로 닫습니다(test_http_guards.py). 그 세션들은
여전히 다시 보내는 503 + Retry-After로 같은 상한을 고정하고, 429를 다시 보내는 공공 API 세션은 429로 고정합니다.
"""
from __future__ import annotations

import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import urllib3.util.retry as retry_module

from app import http as app_http
from app import publicapi

RETRY_AFTER_CAP = 5.0   # 토스 클라이언트(services/toss.api_get)와 같은 상한


@pytest.fixture()
def throttling_server(monkeypatch, request):
    """모든 GET에 (매개변수의 상태 코드) + Retry-After: 3600을 주는 로컬 서버와, urllib3가 자려 한 시간 기록."""
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    status = getattr(request, "param", 429)
    hits: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):  # noqa: N802 — http.server 규약
            hits.append(self.path)
            body = b"slow down"
            self.send_response(status)
            self.send_header("Retry-After", "3600")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    slept: list[float] = []
    # urllib3.util.retry 모듈이 보는 time만 바꿉니다 — 전역 time.sleep은 그대로 둡니다.
    fake_time = types.SimpleNamespace(sleep=slept.append, time=retry_module.time.time)
    monkeypatch.setattr(retry_module, "time", fake_time)
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", hits, slept
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("make_session, throttling_server", [
    pytest.param(app_http.get_session, 503, id="default-503"),
    pytest.param(app_http.get_fred_session, 503, id="fred-503"),
    pytest.param(lambda: app_http._build_session("sec-like", headers={}, total_retries=5, backoff=1.5, pool_size=1),
                 503, id="sec-like-503"),
    pytest.param(publicapi._get_session, 429, id="publicapi-429"),
], indirect=["throttling_server"])
def test_공용_세션은_긴_Retry_After를_짧게_잘라_기다린다(throttling_server, make_session):
    base, hits, slept = throttling_server

    response = make_session().get(f"{base}/x", timeout=1)

    assert response.status_code in (429, 503)   # 재시도를 다 쓰면 마지막 응답을 그대로 돌려줌(raise_on_status=False)
    assert len(hits) >= 2, "재시도가 실제로 일어나야 이 테스트가 의미가 있습니다"
    assert slept, "Retry-After에 따라 기다린 기록이 있어야 합니다"
    assert max(slept) <= RETRY_AFTER_CAP, f"Retry-After 3600을 그대로 기다렸습니다: {slept}"
    # 요청 하나가 붙잡는 시간 = 재시도 수 × 상한 — 호출이 정해진 시간 안에 돌아옵니다.
    assert sum(slept) <= RETRY_AFTER_CAP * (len(hits) - 1)
