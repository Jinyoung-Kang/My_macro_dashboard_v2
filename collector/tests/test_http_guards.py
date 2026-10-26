"""
tests/test_http_guards.py
공용 HTTP 층의 거부 래치·호스트 간격·시간 예산 안 재시도와, 실행기가 그것을 '거부됨'으로 적는지 (v2 1단계 6번).

고정하는 규칙
  1. 403·429·봇 차단 페이지는 출처의 거부 — 다시 보내지 않고(Retry-After도 기다리지 않음) 그 호스트를 5분 동안 닫습니다.
     닫힌 동안의 같은 호스트 요청은 네트워크에 나가지 않고 같은 SourceRejected로 끝납니다. 다른 호스트는 열려 있습니다.
  2. 봇 차단 판정은 차단 서비스의 머리글·차단 페이지 본문 표지로만 합니다 — 정상 HTML(Daum·Naver)·JSON은 그대로 받습니다.
  3. 다시 보내는 것은 일시 오류(5xx·408·연결 끊김)뿐이고, 그 밖의 4xx는 한 번만 보냅니다. 태스크 안에서는 요청 timeout을 남은
     예산에 맞춰 줄이고, 다음 시도(대기 + timeout)가 예산 안에 끝나지 않으면 더 보내지 않습니다.
  4. 같은 호스트로 가는 요청 사이에는 최소 간격 + 지터를 둡니다. SEC 세션은 간격을 두지 않고 기존 토큰 버킷(초당 8건)만 씁니다.
  5. 실행기 — 출처 거부로 아무것도 받지 못한 실행은 ❌ '거부됨: …'(⚠️ '수집 결과 없음'이 아님), 일부만 거부되면 ✅에 '· 거부됨: …'.
     태스크가 안에서 연 스레드 풀(bind_guard)에서 난 거부도 같습니다 — 실제 cot_history 태스크로 확인합니다.
  6. 거부를 받은 자리의 조치 안내 — BLS·SEC·FRED 세션의 403은 어댑터가 SourceRejected로 올리므로, 상태 코드가 아니라 그 예외에
     안내(UA·키)를 붙입니다. 실제 어댑터(127.0.0.1 서버)로 확인합니다.

외부 네트워크에 나가지 않습니다(127.0.0.1의 로컬 서버와 가짜 시계만).
"""
from __future__ import annotations

import dataclasses
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import requests
import urllib3.util.retry as retry_module
from requests.adapters import HTTPAdapter

from app import http as app_http
from app import indicators, settings, tasks
from app.services import cot, news, sec_fundamentals, us_calendar
from app.tasks import runner

JSON = {"Content-Type": "application/json"}
HTML = {"Content-Type": "text/html; charset=UTF-8"}

CLOUDFLARE_CHALLENGE = (b"<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment...</title>"
                        b"<script>window._cf_chl_opt={cvId: '3'};</script></head><body>Enable JavaScript</body></html>")
# 정상 페이지에도 들어가는 흔적 — Cloudflare가 보통 페이지에 넣는 스크립트 경로, 본문의 'captcha' 단어. 거부로 보면 안 됩니다.
NORMAL_PAGE = ("<html><head><title>코스피 지수 : 네이버페이 증권</title>"
               "<script src=\"/cdn-cgi/challenge-platform/scripts/jsd/main.js\"></script></head>"
               "<body>로그인 captcha 안내 · 코스피 2,600.12</body></html>").encode("utf-8")


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

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):  # noqa: N802 — http.server 규약
            path = self.path.split("?", 1)[0]
            hits.append(path)
            queue = routes.get(path) or [(200, JSON, b"{}")]
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
        yield types.SimpleNamespace(base=f"http://127.0.0.1:{port}", port=port, routes=routes, hits=hits)
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture()
def slept(monkeypatch):
    """urllib3 재시도 대기와 호스트 간격 대기를 실제로 자지 않고 기록만 합니다."""
    record: dict[str, list[float]] = {"retry": [], "pace": []}
    monkeypatch.setattr(retry_module, "time",
                        types.SimpleNamespace(sleep=record["retry"].append, time=retry_module.time.time))
    monkeypatch.setattr(app_http, "_sleep", record["pace"].append)
    return record


@pytest.fixture()
def clock(monkeypatch):
    """래치·간격·예산이 보는 시계(app.http._now)를 손으로 돌립니다."""
    now = {"t": 1_000.0}
    monkeypatch.setattr(app_http, "_now", lambda: now["t"])
    return now


# ==============================================================================
# 1. 거부 래치
# ==============================================================================
def test_429는_다시_보내지도_기다리지도_않고_호스트를_5분_닫는다(server, slept):
    server.routes["/limited"] = [(429, {"Retry-After": "3600", **JSON}, b"{}")]
    session = app_http.get_session()

    with pytest.raises(app_http.SourceRejected) as caught:
        session.get(f"{server.base}/limited", timeout=2)

    assert server.hits == ["/limited"], "429는 다시 보내지 않습니다(같은 거절을 되풀이하면 차단이 길어짐)"
    assert slept["retry"] == [], "Retry-After 3600을 기다리지 않습니다"
    message = str(caught.value)
    assert message == "거부됨 — 127.0.0.1 HTTP 429 · 5분 동안 이 출처 호출을 멈춤"
    assert app_http.brief_error(caught.value) == message, "화면 사유에 예외 이름을 붙이지 않아 '거부됨'이 첫머리에 옵니다"
    assert "/limited" not in message, "주소(쿼리의 키)는 사유에 싣지 않습니다"

    # 닫힌 동안의 같은 호스트 요청은 네트워크에 나가지 않고 같은 메시지로 끝납니다 — 다른 세션이어도.
    for other in (session, app_http.get_fred_session()):
        with pytest.raises(app_http.SourceRejected) as again:
            other.get(f"{server.base}/fine", timeout=2)
        assert str(again.value) == message
    assert server.hits == ["/limited"]


def test_403도_거부이고_다른_호스트는_열려_있다(server, slept):
    server.routes["/forbidden"] = [(403, HTML, b"<html>Forbidden</html>")]
    session = app_http.get_session()

    with pytest.raises(app_http.SourceRejected, match="HTTP 403"):
        session.get(f"{server.base}/forbidden", timeout=2)

    # 같은 서버라도 호스트 이름이 다르면 래치가 따로입니다(래치 단위는 호스트).
    response = session.get(f"http://localhost:{server.port}/ok", timeout=5)
    assert response.status_code == 200
    assert server.hits == ["/forbidden", "/ok"]


def test_래치는_5분이_지나면_풀려_다시_물어본다(server, slept, clock):
    server.routes["/flaky"] = [(429, JSON, b"{}"), (200, JSON, b"{}")]
    session = app_http.get_session()
    with pytest.raises(app_http.SourceRejected):
        session.get(f"{server.base}/flaky", timeout=2)

    clock["t"] += app_http.REJECT_LATCH_SECONDS - 1
    with pytest.raises(app_http.SourceRejected):
        session.get(f"{server.base}/flaky", timeout=2)
    assert server.hits == ["/flaky"]

    clock["t"] += 1
    assert session.get(f"{server.base}/flaky", timeout=2).status_code == 200
    assert server.hits == ["/flaky", "/flaky"]


@pytest.mark.parametrize("headers, body, label", [
    pytest.param(HTML, CLOUDFLARE_CHALLENGE, "Cloudflare 챌린지", id="cloudflare-body"),
    pytest.param({"cf-mitigated": "challenge", **HTML}, b"<html></html>", "cf-mitigated", id="cloudflare-header"),
    pytest.param({"x-amzn-waf-action": "captcha", **HTML}, b"<html></html>", "x-amzn-waf-action", id="aws-waf"),
    pytest.param(HTML, b"<html><script src=\"https://ct.captcha-delivery.com/c.js\"></script></html>",
                 "DataDome", id="datadome"),
])
def test_200이어도_봇_차단_페이지면_거부(server, slept, headers, body, label):
    server.routes["/wall"] = [(200, headers, body)]

    with pytest.raises(app_http.SourceRejected) as caught:
        app_http.get_session().get(f"{server.base}/wall", timeout=2)

    assert label in str(caught.value) and "HTTP 200" in str(caught.value)
    assert server.hits == ["/wall"]


def test_정상_HTML과_JSON은_거부로_보지_않는다(server, slept):
    server.routes["/page"] = [(200, HTML, NORMAL_PAGE)]
    server.routes["/json"] = [(200, JSON, b'{"title": "<title>Just a moment...</title>"}')]
    session = app_http.get_session()

    assert "코스피" in session.get(f"{server.base}/page", timeout=2).text
    assert session.get(f"{server.base}/json", timeout=2).json()["title"].startswith("<title>")
    assert app_http.active_rejection("127.0.0.1") is None


def test_스트리밍_요청은_본문을_미리_읽지_않는다(server, slept):
    """뉴스 피드는 stream=True로 크기 상한까지만 읽습니다. 어댑터가 본문을 먼저 읽으면 그 상한이 무력해집니다."""
    server.routes["/feed"] = [(200, HTML, CLOUDFLARE_CHALLENGE)]

    response = app_http.get_session().get(f"{server.base}/feed", timeout=2, stream=True)
    try:
        assert response._content_consumed is False
        assert b"Just a moment" in response.raw.read()
    finally:
        response.close()


# ==============================================================================
# 2. 일시 오류만 다시 보냄 + 시간 예산
# ==============================================================================
@pytest.mark.parametrize("answers, status, hits", [
    pytest.param([(503, JSON, b"{}"), (503, JSON, b"{}"), (200, JSON, b"{}")], 200, 3, id="503-twice-then-ok"),
    pytest.param(["RESET", (200, JSON, b"{}")], 200, 2, id="connection-reset-then-ok"),
    pytest.param([(500, JSON, b"{}")], 500, 3, id="500-gives-up-after-2-retries"),
    pytest.param([(404, JSON, b"{}")], 404, 1, id="404-once"),
    # 408(Request Timeout)은 거절이 아니라 일시 상태 — RFC 9110 §15.5.9: 클라이언트가 같은 요청을 다시 보내도 됩니다.
    pytest.param([(408, JSON, b"{}"), (200, JSON, b"{}")], 200, 2, id="408-then-ok"),
    pytest.param([(413, {"Retry-After": "1", **JSON}, b"{}")], 413, 1, id="413-with-retry-after-once"),
])
def test_일시_오류만_다시_보내고_그_밖의_4xx는_한_번만(server, slept, answers, status, hits):
    server.routes["/x"] = list(answers)

    response = app_http.get_session().get(f"{server.base}/x", timeout=2)

    assert response.status_code == status
    assert len(server.hits) == hits
    assert app_http.active_rejection("127.0.0.1") is None, "5xx·404·408은 거부가 아닙니다"


def test_태스크_예산이_모자라면_다시_보내지_않고_마지막_응답을_돌려준다(server, slept):
    server.routes["/slow"] = [(503, JSON, b"{}"), (200, JSON, b"{}")]
    session = app_http.get_session()

    short = app_http.TaskGuard(deadline=time.monotonic() + app_http.RETRY_RESERVE_SECONDS - 1)
    response = app_http.run_guarded(short, lambda: session.get(f"{server.base}/slow", timeout=2))
    assert response.status_code == 503 and server.hits == ["/slow"]

    server.routes["/slow"] = [(503, JSON, b"{}"), (200, JSON, b"{}")]
    roomy = app_http.TaskGuard(deadline=time.monotonic() + 600)
    response = app_http.run_guarded(roomy, lambda: session.get(f"{server.base}/slow", timeout=2))
    assert response.status_code == 200 and server.hits == ["/slow", "/slow", "/slow"]


def test_태스크_예산이_모자라면_연결_오류도_다시_보내지_않는다(server, slept):
    server.routes["/drop"] = ["RESET", (200, JSON, b"{}")]
    short = app_http.TaskGuard(deadline=time.monotonic() + 1)

    with pytest.raises(requests.ConnectionError):
        app_http.run_guarded(short, lambda: app_http.get_session().get(f"{server.base}/drop", timeout=2))
    assert server.hits == ["/drop"]


def test_다음_시도의_timeout까지_예산에_들어가야_다시_보낸다(server, slept):
    """
    예산 25초(여유 10초를 빼면 15초)에 timeout 10초 요청 — 한 번의 시도가 연결 10 + 읽기 10 = 20초까지 걸릴 수 있어 15초로
    줄이고, 그 뒤 503이 오면 다시 보내지 않습니다(또 15초가 걸리면 상한을 넘김). 예전에는 대기만 보고 다시 보냈습니다.
    """
    server.routes["/busy"] = [(503, JSON, b"{}"), (200, JSON, b"{}")]
    session = app_http.get_session()
    budget = app_http.RETRY_RESERVE_SECONDS + 15

    guard = app_http.TaskGuard(deadline=time.monotonic() + budget)
    response = app_http.run_guarded(guard, lambda: session.get(f"{server.base}/busy", timeout=10))
    assert response.status_code == 503 and server.hits == ["/busy"]

    server.routes["/busy"] = [(503, JSON, b"{}"), (200, JSON, b"{}")]
    guard = app_http.TaskGuard(deadline=time.monotonic() + budget)
    response = app_http.run_guarded(guard, lambda: session.get(f"{server.base}/busy", timeout=2))
    assert response.status_code == 200 and server.hits == ["/busy", "/busy", "/busy"], "짧은 timeout은 예산에 들어갑니다"


def test_태스크_안에서는_요청_timeout을_남은_예산에_맞춰_줄인다(server, slept):
    """예산이 여유 + 2초 남은 태스크가 timeout 30초로 응답 없는 서버를 부르면 30초를 기다리지 않고 상한 안에 끝냅니다."""
    server.routes["/hang"] = ["HANG"]
    guard = app_http.TaskGuard(deadline=time.monotonic() + app_http.RETRY_RESERVE_SECONDS + 2)

    started = time.monotonic()
    with pytest.raises(requests.RequestException):
        app_http.run_guarded(guard, lambda: app_http.get_session().get(f"{server.base}/hang", timeout=30))
    elapsed = time.monotonic() - started

    assert elapsed < 2 + 1, f"timeout을 줄이지 않았습니다({elapsed:.1f}초)"
    assert server.hits == ["/hang"], "줄인 timeout으로도 다음 시도가 예산에 들어가지 않으면 다시 보내지 않습니다"


@pytest.mark.parametrize("timeout, left, expected", [
    pytest.param(30, 600, (30, 60.0), id="roomy-unchanged"),
    pytest.param((5, 30), 600, ((5, 30), 35.0), id="tuple-unchanged"),
    pytest.param(30, 15, ((2.5, 2.5), 5.0), id="float-scaled"),
    pytest.param((5, 15), 30, ((5.0, 15.0), 20.0), id="tuple-fits"),
    pytest.param((10, 30), 30, ((5.0, 15.0), 20.0), id="tuple-scaled"),
    pytest.param(None, 30, ((10.0, 10.0), 20.0), id="none-is-bounded"),
    pytest.param(10, 3, ((0.5, 0.5), 1.0), id="floor"),
])
def test_예산에_맞춘_timeout(timeout, left, expected):
    assert app_http._fit_timeout(timeout, left) == expected


def test_세션의_재시도_목록은_일시_오류뿐():
    for session in (app_http.get_session(), app_http.get_fred_session(), app_http.get_bls_session()):
        retry = session.get_adapter("https://example.org/").max_retries
        assert tuple(retry.status_forcelist) == app_http.TRANSIENT_STATUSES
        assert not {403, 429} & set(retry.status_forcelist)
        assert not retry.is_retry("GET", 429, has_retry_after=True), "urllib3 기본은 429 + Retry-After를 다시 보냅니다"
        assert not retry.is_retry("GET", 413, has_retry_after=True)
        assert retry.is_retry("GET", 408)
        assert retry.is_retry("GET", 503, has_retry_after=True)


# ==============================================================================
# 3. 호스트별 간격 + 지터, SEC 토큰 버킷
# ==============================================================================
def test_같은_호스트는_간격_지터_뒤로_줄을_서고_다른_호스트는_바로(monkeypatch, clock, slept):
    monkeypatch.setattr(app_http.random, "uniform", lambda low, high: high / 2)

    for _ in range(3):
        app_http.pace("Data.KRX.co.kr", 0.2, 0.2)
    app_http.pace("finance.naver.com", 0.2, 0.2)

    # 첫 요청은 바로, 다음부터는 앞 예약 + 0.2 + 지터 0.1 — 예약이 쌓이므로 기다림이 늘어납니다(대소문자는 같은 호스트).
    assert slept["pace"] == pytest.approx([0.3, 0.6])

    clock["t"] += 10       # 충분히 떨어진 뒤에는 기다리지 않습니다
    app_http.pace("data.krx.co.kr", 0.2, 0.2)
    assert len(slept["pace"]) == 2


def test_병렬_스레드도_같은_호스트에는_간격을_두고_보낸다():
    fired: list[float] = []
    lock = threading.Lock()

    def worker():
        app_http.pace("burst.example", 0.05, 0.02)
        with lock:
            fired.append(time.monotonic())

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    fired.sort()
    gaps = [later - earlier for earlier, later in zip(fired, fired[1:])]
    assert min(gaps) >= 0.05 - 0.01, gaps


def test_세션별_간격과_SEC는_토큰_버킷만(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "owner-contact@example.org")
    url = "https://example.org/"
    assert app_http.get_session().get_adapter(url).min_interval == app_http.DEFAULT_HOST_INTERVAL
    assert app_http.get_fred_session().get_adapter(url).min_interval == app_http.FRED_HOST_INTERVAL
    assert app_http.get_bls_session().get_adapter(url).min_interval == app_http.DEFAULT_HOST_INTERVAL
    assert app_http.get_sec_session().get_adapter(url).min_interval == 0, "SEC 속도는 sec_rate_limit이 정합니다"
    # 증권사 Open API 세션은 이 층을 거치지 않습니다(401·403·429를 부르는 쪽이 다룸).
    api_adapter = app_http.get_api_session("toss").get_adapter(url)
    assert type(api_adapter) is HTTPAdapter

    # SEC 토큰 버킷은 그대로 — 전체 합계 초당 8건(연달아 부르면 1/8초 간격).
    assert app_http._SEC_MAX_RPS == 8.0
    app_http.sec_rate_limit()
    started = time.monotonic()
    app_http.sec_rate_limit()
    app_http.sec_rate_limit()
    assert time.monotonic() - started >= 2 / app_http._SEC_MAX_RPS - 0.02


# ==============================================================================
# 4. 실행기 — '거부됨'으로 적기
# ==============================================================================
@pytest.fixture()
def recorded(monkeypatch):
    rows: list[dict] = []
    monkeypatch.setattr(tasks.store, "record_task_run", lambda *args, **kwargs: rows.append(kwargs))
    return rows


def _run(fn, speed="slow"):
    return tasks.run_task(tasks.Task("guard_probe", speed, fn, ""))


def test_거부로_아무것도_받지_못하면_데이터_없음이_아니라_거부됨(recorded):
    def task():
        app_http.reject_host("api.example.org", "HTTP 429")
        raise tasks.EmptyResult("0/3 시리즈 — 기존 저장본 유지")

    ok, detail = _run(task)

    assert ok is False
    assert recorded[-1]["status"] == "error", "⚠️ '데이터 없음'으로 보이면 조치(빈도·UA·키)가 필요한 줄 모릅니다"
    assert detail == recorded[-1]["detail"]
    assert detail.startswith("거부됨: api.example.org(HTTP 429)가 요청을 거부")
    assert "0/3 시리즈 — 기존 저장본 유지" in detail
    assert not detail.startswith(tasks.EMPTY_PREFIX)
    assert tasks.runner._run_status(0, [f"guard_probe: {detail}"]) == "fail"


def test_거부가_없으면_예전처럼_수집_결과_없음(recorded):
    def task():
        raise tasks.EmptyResult("0/3 시리즈 — 기존 저장본 유지")

    ok, detail = _run(task)

    assert ok is False and recorded[-1]["status"] == "empty"
    assert detail == f"{tasks.EMPTY_PREFIX}0/3 시리즈 — 기존 저장본 유지"


def test_일부만_거부되면_성공으로_두고_거부한_호스트를_덧붙인다(recorded):
    app_http.reject_host("www.example.org", "HTTP 403")      # 태스크 밖(다른 태스크)이 닫은 호스트

    def task():
        assert app_http.active_rejection("www.example.org") is not None   # 이 실행도 그 호스트를 건너뜀
        return "2/3 티커 · 이전 값 1개(BBB)"

    ok, detail = _run(task)

    assert ok is True and recorded[-1]["status"] == "ok"
    assert detail == "2/3 티커 · 이전 값 1개(BBB) · 거부됨: www.example.org(HTTP 403)"


def test_태스크_안의_묶지_않은_스레드에서_난_거부는_사유의_표지로_판정(recorded):
    """contextvars는 태스크가 연 스레드로 저절로 넘어가지 않습니다. bind_guard로 묶지 않았으면 사유 문자열의 '거부됨'으로 압니다."""
    def task():
        reasons: list[str] = []
        side = threading.Thread(
            target=lambda: reasons.append(app_http.brief_error(app_http.reject_host("cftc.example", "HTTP 403"))))
        side.start()
        side.join()
        raise tasks.EmptyResult("0/4 자산 — 기존 저장본 유지" + tasks._reason_suffix(reasons))

    ok, detail = _run(task)

    assert recorded[-1]["status"] == "error"
    assert detail.startswith("거부됨: 출처가 요청을 거부") and "cftc.example HTTP 403" in detail


def test_SourceRejected가_그대로_올라오면_예외_이름_없이_거부됨(recorded):
    def task():
        raise app_http.reject_host("query.example", "봇 차단 페이지(HTTP 200, Cloudflare 챌린지)")

    ok, detail = _run(task)

    assert recorded[-1]["status"] == "error"
    assert detail.startswith("거부됨: query.example(봇 차단 페이지(HTTP 200, Cloudflare 챌린지))")
    assert "SourceRejected" not in detail


def test_태스크_안에서는_속도군_상한만큼의_예산이_보인다(recorded):
    seen: list[float | None] = []
    ok, _ = _run(lambda: seen.append(app_http.time_left()) or "끝", speed="fast")

    assert ok is True
    deadline = runner.TASK_DEADLINE_SECONDS["fast"]
    assert seen[0] is not None and deadline - 5 < seen[0] <= deadline
    assert app_http.time_left() is None, "태스크 밖(요청 경로)에는 예산이 없습니다"


def test_한_실행에서_거부를_받으면_남은_요청은_나가지_않는다(server, slept, recorded):
    """시리즈 다섯 개를 잇달아 묻는 태스크 — 첫 요청이 429면 나머지 넷은 네트워크에 나가지 않고 실행은 '거부됨'."""
    server.routes["/series/0"] = [(429, JSON, b"{}")]
    reasons: list[str] = []

    def task():
        session = app_http.get_session()
        for index in range(5):
            try:
                session.get(f"{server.base}/series/{index}", timeout=2)
            except requests.RequestException as exc:
                reasons.append(app_http.brief_error(exc))
        raise tasks.EmptyResult("0/5 시리즈 — 기존 저장본 유지" + tasks._reason_suffix(reasons))

    ok, detail = _run(task)

    assert server.hits == ["/series/0"]
    assert len(reasons) == 5 and len(set(reasons)) == 1, "처음 거부와 닫힌 동안의 요청이 같은 사유라 한 번으로 합쳐집니다"
    assert recorded[-1]["status"] == "error"
    assert detail.startswith("거부됨: 127.0.0.1(HTTP 429)가 요청을 거부")


def test_bind_guard로_묶은_스레드_풀도_거부_기록과_예산을_본다(recorded):
    """태스크가 안에서 연 풀(cot·krx·13F·순유동성·참고 시세)에 넘기는 함수는 bind_guard로 묶습니다."""
    seen: list[float | None] = []

    def fetch(index):
        seen.append(app_http.time_left())
        if index == 0:
            app_http.reject_host("pool.example", "HTTP 403")
        return index

    unbound: list[float | None] = []

    def task():
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(app_http.bind_guard(fetch), range(3)))
            unbound.append(pool.submit(app_http.time_left).result())
        raise tasks.EmptyResult(f"0/{len(results)} — 기존 저장본 유지")

    ok, detail = _run(task)

    assert recorded[-1]["status"] == "error"
    assert detail.startswith("거부됨: pool.example(HTTP 403)가 요청을 거부 · 0/3 — 기존 저장본 유지")
    assert len(seen) == 3 and all(left is not None and left > 0 for left in seen), "묶은 함수는 태스크 예산을 봅니다"
    assert unbound == [None], "묶지 않은 함수는 태스크 밖과 같습니다"
    assert app_http.bind_guard(fetch) is fetch, "태스크 밖에서는 그대로 돌려줍니다"


def test_CFTC가_거부하면_cot_history는_수집_결과_없음이_아니라_거부됨(server, recorded, monkeypatch):
    """
    실제 cot_history 태스크 — 자산 여섯 개를 안쪽 스레드 풀(4개)로 묻습니다. 예전에는 그 풀의 거부가 실행 기록에 적히지 않아
    ⚠️ '수집 결과 없음: 0/6 자산'으로 남았습니다. 첫 403 뒤의 요청은 래치에 막혀 나가지 않고, 같은 거절을 다시 묻지도 않습니다.
    """
    server.routes["/cftc"] = [(403, JSON, b"{}")]
    monkeypatch.setattr(cot, "CFTC_URL", f"{server.base}/cftc")
    waited: list[float] = []
    monkeypatch.setattr(cot, "time", types.SimpleNamespace(sleep=waited.append))     # cot 자체 재시도의 대기
    assets = len(indicators.COT_ASSETS)

    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["cot_history"])

    assert ok is False and recorded[-1]["status"] == "error"
    rejected = "거부됨 — 127.0.0.1 HTTP 403 · 5분 동안 이 출처 호출을 멈춤"
    assert detail == f"거부됨: 127.0.0.1(HTTP 403)가 요청을 거부 · 0/{assets} 자산 — 기존 저장본 유지 (사유: {rejected})"
    assert 1 <= len(server.hits) < assets, "래치가 안쪽 풀의 다른 스레드에도 걸려 남은 요청을 막습니다"
    assert waited == [], "거부는 기다렸다 다시 묻지 않습니다"


# ==============================================================================
# 5. 거부를 받은 자리의 조치 안내 — 실제 어댑터로
# ==============================================================================
@pytest.fixture()
def sec_contact(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "owner-contact@example.org")


@pytest.mark.parametrize("key, hint", [
    pytest.param("bls_cpi", " — BLS 차단(UA)", id="bls"),
    pytest.param("sec_press", " — SEC_USER_AGENT 확인", id="sec"),
])
def test_뉴스_피드의_403은_어댑터를_거쳐도_세션별_안내가_붙는다(server, sec_contact, key, hint):
    server.routes["/feed"] = [(403, HTML, b"<html>Access Denied</html>")]
    feed = dataclasses.replace(next(feed for feed in news.FEEDS if feed.key == key), url=f"{server.base}/feed")

    with pytest.raises(news.FeedFetchError) as caught:
        news.fetch_feed(feed)

    assert str(caught.value) == f"거부됨 — 127.0.0.1 HTTP 403 · 5분 동안 이 출처 호출을 멈춤{hint}"
    assert server.hits == ["/feed"]


def test_SEC_재무의_403은_연결_실패가_아니라_거부됨에_UA_안내(server, sec_contact, monkeypatch):
    server.routes["/cf/CIK0000320193.json"] = [(403, HTML, b"<html>denied</html>")]
    monkeypatch.setattr(sec_fundamentals, "COMPANYFACTS_URL", f"{server.base}/cf/CIK{{cik}}.json")

    with pytest.raises(sec_fundamentals.FetchError) as caught:
        sec_fundamentals.fetch_companyfacts("320193")

    message = str(caught.value)
    assert message == ("거부됨 — 127.0.0.1 HTTP 403 · 5분 동안 이 출처 호출을 멈춤"
                       " — SEC_USER_AGENT에 본인 이메일을 넣으세요")
    assert "연결 실패" not in message and "@" not in message


def test_FRED_발표_일정의_403에도_키_안내가_붙고_키는_싣지_않는다(server, monkeypatch):
    server.routes["/fred/release/dates"] = [(403, JSON, b"{}")]
    monkeypatch.setattr(settings, "fred_key", lambda: "test-key-value")
    monkeypatch.setattr(settings, "FRED_API_BASE", f"{server.base}/fred")

    with pytest.raises(us_calendar.CalendarFetchError) as caught:
        us_calendar.fetch_release_dates(10, date(2026, 10, 1), date(2026, 11, 15))

    assert str(caught.value) == "거부됨 — 127.0.0.1 HTTP 403 · 5분 동안 이 출처 호출을 멈춤 — FRED_API_KEY 확인"
    assert "test-key-value" not in str(caught.value)
