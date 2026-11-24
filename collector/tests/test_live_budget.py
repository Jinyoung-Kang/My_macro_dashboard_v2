"""
tests/test_live_budget.py
화면이 열 때 외부를 부르는 조회(/live/quote·/live/news·/live/daum-intraday)의 요청 하나 예산(QA-993, 사용자 결정 D-3 — 10초).

고정하는 규칙
  1. 출처가 연결을 받고 응답하지 않아도(먹통) 그 조회는 예산 + 남김 안에 지금의 '받지 못함' 꼴로 끝납니다 — 예전에는 공용 세션의 재시도 2회 ×
     timeout 10초로 출처 하나에 약 31초, 뉴스는 출처·질의가 둘이면 두 배였습니다.
  2. 예산 안에서는 다시 보내지 않아(다음 시도가 예산 안에 끝나지 않음) 먹통 출처에 보내는 요청이 늘지 않습니다.
  3. 출처가 여럿이면 예산을 앞에서부터 나눠 쓰고, 먼저 받은 것은 지금처럼 돌려줍니다(뉴스 — 네이버가 먹통이어도 구글 뉴스는 받음).
  4. 공용 세션 밖의 호출(yfinance)은 within_budget으로 예산 안에서만 기다리고, 넘으면 BudgetExceeded('응답 없음').
  5. 출처가 바로 답하면 결과는 예산을 걸지 않았을 때와 같습니다.
외부 네트워크에 나가지 않습니다 — 127.0.0.1에 띄운 먹통 서버와 응답 서버만 씁니다. 시험이 짧게 끝나게 예산·출처 timeout을 줄여 씁니다.
"""
from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app import http as app_http
from app import main
from app.services import detail

BUDGET = 3.0          # 시험용 예산(초) — 운영은 app.http.LIVE_BUDGET_SECONDS(10초)
SLACK = 1.5           # 예산 + 남김(0.5초) 위로 허용하는 여유(시험 기계의 흔들림)


class _Hang:
    """연결은 받고 아무것도 보내지 않는 서버(QA 프록시의 hang과 같은 꼴). 받은 연결 수를 셉니다."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.accepted = 0
        self._held: list[socket.socket] = []
        self._stop = False
        threading.Thread(target=self._loop, daemon=True).start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}"

    def _loop(self) -> None:
        self.sock.settimeout(0.2)
        while not self._stop:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                continue
            self.accepted += 1
            self._held.append(conn)

    def close(self) -> None:
        self._stop = True
        for conn in self._held:
            conn.close()
        self.sock.close()


class _Answer(BaseHTTPRequestHandler):
    """경로마다 고정 응답 — 구글 뉴스 RSS 하나와 네이버 시세 JSON 하나."""

    def do_GET(self):  # noqa: N802 — http.server의 이름
        if self.path.startswith("/rss"):
            body = ("<?xml version='1.0'?><rss><channel><item><title>가짜 기사 - 가짜 매체</title>"
                    "<link>https://example.invalid/a</link><pubDate>Mon, 24 Nov 2026 01:00:00 GMT</pubDate></item></channel></rss>").encode()
            kind = "application/rss+xml"
        else:
            body = json.dumps({"stockName": "가짜전자", "closePrice": "70,000", "compareToPreviousClosePrice": "1,000",
                               "fluctuationsRatio": "1.45", "stockExchangeType": {"code": "KS"}}).encode()
            kind = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # 시험 출력을 더럽히지 않음
        pass


@pytest.fixture()
def hang():
    server = _Hang()
    yield server
    server.close()


@pytest.fixture()
def answer():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Answer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture(autouse=True)
def _short(monkeypatch):
    """출처 timeout·예산을 줄이고(시험 시간), 상세의 다른 출처(해외주식 찾기·국내 기업개요)는 네트워크 없이."""
    detail.reset_cache()
    monkeypatch.setattr(detail, "FETCH_TIMEOUT", 2)
    monkeypatch.setattr(app_http, "LIVE_BUDGET_SECONDS", BUDGET, raising=False)
    monkeypatch.setattr(detail, "naver_world", lambda code: None)
    monkeypatch.setattr(detail, "_wisereport_profile", lambda code: {"profile": None, "error": "시험 — 네트워크 없음"})
    yield
    detail.reset_cache()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(main, "_check_token", lambda token: None)
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.mark.xfail(strict=True, reason="QA-993 재현 — 예산이 없어 공용 세션의 재시도 2회 × timeout만큼 붙잡힘(고친 뒤 뺌)")
def test_QA993_국내_시세는_네이버가_먹통이어도_예산_안에_받지_못함으로_끝난다(client, hang, monkeypatch):
    monkeypatch.setattr(detail, "NAVER_API", hang.base + "/api")
    started = time.monotonic()
    res = client.get("/live/quote?market=kr&code=005930")
    took = time.monotonic() - started

    assert res.status_code == 200
    body = res.json()
    assert body["price"] is None and body["error"], "지금의 '받지 못함' 꼴(_empty_quote)"
    assert took < BUDGET + SLACK, f"{took:.1f}초 — 예산 {BUDGET}초 + 여유 안"
    assert hang.accepted == 1, "예산 안에서는 다시 보내지 않음(먹통 출처에 요청이 늘지 않음)"


@pytest.mark.xfail(strict=True, reason="QA-993 재현 — 예산이 없어 공용 세션의 재시도 2회 × timeout만큼 붙잡힘(고친 뒤 뺌)")
def test_뉴스는_앞_출처가_먹통이어도_예산_안에_끝나고_뒤_출처에서_받은_것을_돌려준다(client, hang, answer, monkeypatch):
    monkeypatch.setattr(detail, "NAVER_API", hang.base + "/api")
    monkeypatch.setattr(detail, "GOOGLE_NEWS_RSS", answer + "/rss")
    started = time.monotonic()
    res = client.get("/live/news?market=kr&code=005930&q=가짜전자")
    took = time.monotonic() - started

    body = res.json()
    assert took < BUDGET + SLACK, f"{took:.1f}초"
    assert len(body["items"]) == 1 and body["items"][0]["title"].startswith("가짜 기사"), "먼저(뒤 출처에서) 받은 것은 그대로"
    assert "네이버 증권" in body["errors"], "먹통 출처는 출처별 실패로 남음"
