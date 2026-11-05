"""
tests/conftest.py
테스트 공통 설정.

저장 계층 테스트는 실제 PostgreSQL을 씁니다. TEST_DATABASE_URL이 없으면
그 테스트만 건너뜁니다(순수 로직 테스트는 DB 없이도 돌아야 합니다).
"""
from __future__ import annotations

import os
import threading
import time
import types
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

# TestClient의 기본 Host는 'testserver'입니다. 운영 기본 허용 목록에는 두지 않고(QA-038) 테스트에서만 더합니다 —
# app.main이 불러와지기 전에(이 파일이 먼저 실행됨) 정해야 미들웨어가 이 목록으로 만들어집니다.
os.environ.setdefault("COLLECTOR_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],collector,testserver")


@pytest.fixture(autouse=True)
def _reset_http_guards():
    """
    공용 HTTP 층의 거부 래치·호스트 간격 기록과 Yahoo 무응답 래치는 프로세스 전역입니다(app/http.py·app/yahoo.py). 한 테스트가 닫은
    호스트(127.0.0.1, finance.yahoo.com)나 Yahoo가 다음 테스트의 요청까지 막지 않게 테스트마다 비웁니다.
    """
    from app import http, yahoo
    from app.fetch import ladder

    http.reset_guards()
    yahoo.reset_for_tests()       # Yahoo 무응답 래치·셈도 프로세스 전역입니다(app/yahoo.py, QA-255)
    ladder.reset()                # 차단 통과 계층의 지연 기록·세션(쿠키)도 프로세스 전역입니다(app/fetch)
    yield
    http.reset_guards()
    yahoo.reset_for_tests()
    ladder.reset()


@pytest.fixture()
def server(monkeypatch):
    """
    경로마다 응답 목록을 차례로 주는 로컬 서버. 목록의 마지막 응답은 계속 반복합니다. 쿼리 문자열은 떼고 경로로 찾습니다.
    응답 대신 "RESET"이면 아무것도 보내지 않고 연결을 끊습니다(연결 끊김 — 일시 오류). "HANG"이면 2초 동안 답하지 않다가
    끊습니다(응답 없는 서버 — 읽기 시간 초과).
    """
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    routes: dict[str, list] = {}
    hits: list[str] = []
    seen: list[dict[str, str]] = []      # 받은 요청의 머리글(이름은 소문자), hits와 같은 순서

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):  # noqa: N802 — http.server 규약
            path = self.path.split("?", 1)[0]
            hits.append(path)
            seen.append({name.lower(): value for name, value in self.headers.items()})
            queue = routes.get(path) or [(200, {"Content-Type": "application/json"}, b"{}")]
            answer = queue.pop(0) if len(queue) > 1 else queue[0]
            if answer in ("RESET", "HANG"):
                if answer == "HANG":
                    time.sleep(2)
                self.close_connection = True
                return
            status, headers, body = answer
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    class Server(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            pass        # 클라이언트가 먼저 끊은 연결(거부 뒤 close·RESET)의 BrokenPipe를 테스트 출력에 찍지 않습니다

    httpd = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    try:
        yield types.SimpleNamespace(base=f"http://127.0.0.1:{port}", port=port, routes=routes, hits=hits, seen=seen)
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "")
    if not url:
        pytest.skip("TEST_DATABASE_URL이 없어 저장 계층 테스트를 건너뜁니다.")
    return url


@pytest.fixture()
def store(database_url, monkeypatch):
    """
    테스트 전용 스키마를 만들어 그 안에서만 동작하게 합니다.

    같은 DB를 쓰더라도 테스트가 운영 데이터를 건드리지 않고, 테스트끼리도
    서로를 오염시키지 않습니다.
    """
    schema = f"test_{uuid.uuid4().hex[:12]}"
    monkeypatch.setenv(
        "DATABASE_URL", f"{database_url}?options=-csearch_path%3D{schema}"
    )

    from app import store as store_module

    store_module.close_pool()

    # 스키마를 먼저 만들어야 search_path가 유효합니다.
    import psycopg

    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')

    store_module.init_schema(_migrations_dir())
    yield store_module

    store_module.close_pool()
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')


def _migrations_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "db", "migrations"))
