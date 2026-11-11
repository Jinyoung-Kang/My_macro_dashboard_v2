"""
tests/test_api_session.py
증권사 Open API(토스·KIS)용 HTTP 세션 (PERF-06).

예전에는 호출마다 requests.get/post로 새로 연결해 TCP·TLS 연결을 매번 다시 맺었습니다.
세션으로 연결을 재사용하되, 예전 동작 중 지켜야 할 두 가지를 고정합니다.
  1. 실패를 조용히 다시 보내지 않는다 — 401(토큰 재발급)·429(Retry-After)·403(허용 IP)은
     부르는 쪽이 직접 처리합니다. 토큰 발급 POST가 두 번 나가면 먼저 받은 토큰이 무효가 됩니다.
  2. 이전 응답의 쿠키를 다음 요청에 싣지 않는다.
"""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app import http as app_http
from app.services import kis, toss


@pytest.fixture()
def local_server(monkeypatch):
    """요청마다 (클라이언트 포트, Cookie 헤더, 경로)를 기록하는 로컬 HTTP/1.1 서버."""
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    seen: list[tuple[int, str | None, str]] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"   # keep-alive

        def _reply(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            seen.append((self.client_address[1], self.headers.get("Cookie"), self.path))
            body = b"{}"
            self.send_response(429 if self.path == "/limited" else 200)
            self.send_header("Set-Cookie", "sticky=1; Path=/")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = _reply
        do_POST = _reply

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", seen
    finally:
        server.shutdown()
        server.server_close()


def test_api_session_reuses_one_connection_without_retry_or_cookies(local_server):
    base, seen = local_server
    session = app_http.get_api_session("test-broker")
    assert app_http.get_api_session("test-broker") is session

    assert session.get(f"{base}/a", timeout=5).status_code == 200
    assert session.post(f"{base}/b", data={"x": "1"}, timeout=5).status_code == 200
    assert session.get(f"{base}/limited", timeout=5).status_code == 429

    assert len({port for port, _, _ in seen}) == 1                      # 세 요청이 한 연결로
    assert [cookie for _, cookie, _ in seen] == [None, None, None]      # 받은 쿠키를 다시 보내지 않음
    assert [path for _, _, path in seen] == ["/a", "/b", "/limited"]    # 429도 한 번만 보냄


def test_broker_clients_share_their_own_sessions():
    """각 클라이언트는 자기 세션을 계속 씁니다(요청마다 새로 연결하지 않음)."""
    for module in (toss, kis):
        assert module._http() is module._http()
    assert len({id(toss._http()), id(kis._http())}) == 2
