"""
tests/test_yahoo_budget.py
QA-255: yfinance 경로가 태스크 시간 예산(http.TaskGuard)을 따르지 않던 결함.

yfinance는 자기 curl_cffi 세션(프로세스에 하나)으로 Yahoo에 가서 공용 requests 세션의 예산 층을 거치지 않았습니다. 출처가 연결만 받고
응답하지 않으면 crumb 받기(30초)·시간대 조회(10초)·시세 요청이 폴백마다 되풀이돼, 예산 15초인 호출이 130초(카드 4장은 400초) 걸렸고
태스크는 상한 뒤에도 좀비로 남아 작업 스레드를 쥐었습니다(QA 스택 실측 480초).

시험은 실제 Yahoo로 나가지 않습니다: 연결을 받고 아무 말도 하지 않는 로컬 프록시를 yfinance 설정(yf.config.network.proxy)과 환경변수
(curl_cffi trust_env) 양쪽에 걸고, 끝날 때는 프록시를 닫아 남은 요청이 바로 실패하게 한 뒤 그 스레드가 끝나기를 기다렸다가 설정을 되돌립니다.
"""
from __future__ import annotations

import ast
import http.server
import importlib
import socket
import threading
import time
from pathlib import Path

import pytest
import yfinance as yf

from app import http as app_http
from app import tasks
from app.services import market

# 예산을 짧게 잡아 시험을 몇 초 안에 끝냅니다 — 요청이 끝난 뒤 남겨 두는 몫(RETRY_RESERVE_SECONDS, 운영 10초)도 함께 줄입니다.
BUDGET = 4.0
RESERVE = 1.0
SLACK = 2.5


class _Blackhole:
    """연결을 받고 읽지도 답하지도 않는 TCP 서버(프록시 자리). 닫으면 받은 연결도 모두 끊습니다."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.accepted = 0
        self._conns: list[socket.socket] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def _accept(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.accepted += 1
            self._conns.append(conn)

    def close(self) -> None:
        self._stop.set()
        self._thread.join(2)
        for conn in self._conns:
            try:
                conn.close()
            except OSError:
                pass
        self.sock.close()


def _yahoo_module():
    """수정 뒤에 생기는 모듈(app.yahoo). 수정 전에는 ModuleNotFoundError — 그 시험은 실패(xfail)로 셉니다."""
    return importlib.import_module("app.yahoo")


@pytest.fixture()
def blackhole(monkeypatch):
    hole = _Blackhole()
    proxy = f"http://127.0.0.1:{hole.port}"
    monkeypatch.setattr(yf.config.network, "proxy", proxy)
    for name in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        monkeypatch.setenv(name, proxy)
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(app_http, "RETRY_RESERVE_SECONDS", RESERVE)
    started: list[threading.Thread] = []
    hole.started = started
    yield hole
    # 프록시를 먼저 닫아 남은 요청이 바로 실패하게 하고, 그 스레드가 끝난 뒤에 프록시 설정을 되돌립니다(실제 Yahoo로 나가지 않게).
    hole.close()
    for thread in started:
        thread.join(30)
    try:
        yahoo = _yahoo_module()
        yahoo.reset_for_tests()
        # yfinance는 설정의 프록시를 세션에 직접 적어 두고 지우지 않습니다 — 닫은 프록시가 다음 시험의 세션에 남지 않게.
        yahoo.session().proxies = {}
    except ModuleNotFoundError:
        pass


def _call(hole: _Blackhole, fn, *, budget: float | None):
    """``fn``을 따로 스레드에서 부릅니다(예산이 있으면 그 TaskGuard를 걸고). → (끝났나, 걸린 초, 결과)"""
    box: dict = {}

    def run() -> None:
        if budget is None:
            box["result"] = fn()
        else:
            guard = app_http.TaskGuard(deadline=time.monotonic() + budget)
            box["result"] = app_http.run_guarded(guard, fn)

    thread = threading.Thread(target=run, daemon=True)
    hole.started.append(thread)
    t0 = time.monotonic()
    thread.start()
    thread.join((budget or 0.0) + SLACK)
    return not thread.is_alive(), time.monotonic() - t0, box.get("result")


def test_QA255_yfinance_요청도_태스크_예산_안에_끝난다(blackhole):
    finished, elapsed, result = _call(blackhole, lambda: market.last_two_closes("CL=F"), budget=BUDGET)

    assert blackhole.accepted > 0, "요청이 무응답 프록시로 가지 않았습니다 — 시험 설정 확인"
    assert finished and elapsed <= BUDGET + 0.5, f"예산 {BUDGET}초인 호출이 {elapsed:.1f}초 걸림(또는 끝나지 않음)"
    assert result[0] is None and result[2], result


def test_QA255_yf_download_배치의_종목_스레드도_예산을_본다(blackhole):
    finished, elapsed, result = _call(blackhole, lambda: market.minute_bars(["AAA", "BBB"], "1d"), budget=BUDGET)

    assert blackhole.accepted > 0, "요청이 무응답 프록시로 가지 않았습니다 — 시험 설정 확인"
    assert finished and elapsed <= BUDGET + 0.5, f"예산 {BUDGET}초인 배치가 {elapsed:.1f}초 걸림(또는 끝나지 않음)"
    bars, reason, _limited = result
    assert bars == {} and reason, result


def test_QA255_연달아_응답이_없으면_Yahoo_요청을_잠시_멈춘다(blackhole, monkeypatch):
    from curl_cffi.requests import exceptions as curl_exceptions

    yahoo = _yahoo_module()
    monkeypatch.setattr(yahoo, "NO_RESPONSE_LIMIT", 1)

    # 무응답 출처에 자기 timeout(예산 때문에 줄인 것이 아님)으로 끝난 요청 — 운영에서는 yfinance의 10~30초 timeout이 태스크 예산 안이라 이 경우.
    proxy = f"http://127.0.0.1:{blackhole.port}"
    with pytest.raises(curl_exceptions.Timeout):
        yahoo.session().get("https://query1.finance.yahoo.com/v8/finance/chart/CL=F", timeout=0.5,
                            proxies={"http": proxy, "https": proxy})
    assert yahoo._closed_until is not None

    # 태스크 밖(화면 상세·/live 경로 — 예산 없음)도 래치가 닫힌 동안은 기다리지 않고 바로 끝납니다.
    accepted = blackhole.accepted
    finished, elapsed, result = _call(blackhole, lambda: market.last_two_closes("CL=F"), budget=None)
    assert finished and elapsed < 1.5, f"래치가 닫힌 뒤 예산 없는 호출이 {elapsed:.1f}초 걸림"
    assert blackhole.accepted == accepted, "래치가 닫힌 동안 Yahoo로 연결을 새로 열었습니다"
    assert result[0] is None and result[2] and "Yahoo 응답 없음" in result[2], result


def test_QA255_Yahoo_태스크의_좀비가_다른_태스크의_작업_스레드를_뺏지_않는다(monkeypatch):
    monkeypatch.setattr(tasks.store, "record_task_run", lambda *a, **kw: None)
    monkeypatch.setitem(tasks.runner.TASK_DEADLINE_SECONDS, "fast", 0.3)
    tasks._inflight.clear()
    release = threading.Event()
    try:
        # 응답 없는 Yahoo 태스크를 일반 작업 스레드 수만큼 — 상한 0.3초에 '시간 초과'로 기록되고 작업 스레드는 좀비로 남습니다.
        workers = tasks.runner._task_threads._max_workers
        zombies = [tasks.Task(f"yahoo_probe_{i}", "fast", lambda: release.wait(10) and "끝", "") for i in range(workers)]
        for task in zombies:
            object.__setattr__(task, "yahoo", True)      # 태스크 목록의 Yahoo 표시와 같음(수정 전에도 같은 모양으로 재현)
        runners = [threading.Thread(target=tasks.run_task, args=(task,), daemon=True) for task in zombies]
        for thread in runners:
            thread.start()
        for thread in runners:
            thread.join(5)

        ok, detail = tasks.run_task(tasks.Task("kr_probe", "fast", lambda: "한국 장부 입력", ""))

        assert ok, detail
        assert detail == "한국 장부 입력"
    finally:
        release.set()
        deadline = time.monotonic() + 10
        while tasks._inflight and time.monotonic() < deadline:
            time.sleep(0.05)
        tasks._inflight.clear()


YAHOO_TASKS = {
    "scraper_markets", "macro_collected", "sector_history", "fx_history", "equity_history", "volatility_history",
    "paper_quotes", "paper_bars_us", "paper_watch_us", "paper_live_us", "us_calendar", "earnings_surprise",
    "paper_price_history", "paper_stopwatch_us",
}


def test_QA255_Yahoo가_주_출처인_태스크만_따로_표시한다():
    marked = {task.name for task in tasks.ALL_TASKS if getattr(task, "yahoo", False)}
    assert marked == YAHOO_TASKS
    # 한국 장부 입력은 Yahoo 몫에 넣지 않습니다(그 좀비에 밀리지 않게).
    assert not marked & {"kr_paper_timed", "kr_paper_quotes", "kr_paper_flows", "paper_watch_kr", "paper_live_kr", "paper_stopwatch_kr"}


def test_저장소의_yf_download는_모두_예산_세션을_넘긴다():
    # 넘기지 않으면 yfinance 1.7.0이 부를 때마다 새 기본 세션으로 싱글턴의 세션을 바꿔, 그 뒤 모든 Yahoo 요청이 예산을 보지 않습니다.
    # 모양: yf.download·yfinance.download·from yfinance import download·Tickers(…)(그 history·download도 multi.download를 부름).
    root = Path(__file__).resolve().parents[1] / "app"
    calls = []
    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        modules = {"yfinance"}
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules |= {alias.asname or alias.name for alias in node.names if alias.name == "yfinance"}
            elif isinstance(node, ast.ImportFrom) and node.module == "yfinance":
                imported |= {alias.asname or alias.name for alias in node.names if alias.name in ("download", "Tickers")}
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            hit = ((isinstance(func, ast.Attribute) and func.attr in ("download", "Tickers")
                    and isinstance(func.value, ast.Name) and func.value.id in modules)
                   or (isinstance(func, ast.Name) and func.id in imported))
            if hit:
                session = next((k.value for k in node.keywords if k.arg == "session"), None)
                calls.append((f"{path.relative_to(root)}:{node.lineno}", ast.unparse(session) if session else None))
    assert len(calls) >= 3, calls
    assert [where for where, session in calls if session != "yahoo.session()"] == []


def test_download_뒤에도_yfinance_세션은_예산_세션이다(blackhole):
    from yfinance.data import YfData

    yahoo = _yahoo_module()
    _call(blackhole, lambda: market.minute_bars(["AAA"], "1d"), budget=BUDGET)
    assert YfData()._session is yahoo.session()


def test_timeout은_남은_예산_안으로_줄인다():
    yahoo = _yahoo_module()
    assert yahoo._fit(30, 30, 5.0) == (5.0, True)
    assert yahoo._fit(3, 30, 5.0) == (3.0, False)
    assert yahoo._fit(None, 30, 5.0) == (5.0, True)
    assert yahoo._fit(object(), 30, 5.0) == (5.0, True)         # 넘기지 않은 값(curl_cffi NOT_SET) → 세션 기본값 30 → 5
    assert yahoo._fit(object(), 3, 5.0) == (3.0, False)
    assert yahoo._fit((10, 30), 30, 8.0) == ((2.0, 6.0), True)
    assert yahoo._fit((1, 2), 30, 8.0) == ((1.0, 2.0), False)


def test_예산이_요청_하나도_못_보낼_만큼이면_보내지_않는다(blackhole):
    yahoo = _yahoo_module()
    guard = app_http.TaskGuard(deadline=time.monotonic() + RESERVE + 0.2)
    with pytest.raises(yahoo.YahooBudgetExhausted):
        app_http.run_guarded(guard, lambda: yahoo.session().get("https://query1.finance.yahoo.com/v8/finance/chart/AAA"))
    assert blackhole.accepted == 0



# ==============================================================================
# QA-255 후속 — 독립 검토(워크플로 wf_9076167a-f79)가 찾은 빈 곳
# ==============================================================================
class _SlowServer:
    """``delay``초 뒤에 200으로 답하는 로컬 HTTP 서버(살아 있지만 느린 Yahoo 자리)."""

    def __init__(self, delay: float) -> None:
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — http.server 규약
                time.sleep(delay)
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"{}")
                except OSError:
                    pass

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v8/finance/chart/AAA"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def slow_yahoo(monkeypatch):
    for name in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(app_http, "RETRY_RESERVE_SECONDS", RESERVE)
    yahoo = _yahoo_module()
    yahoo.reset_for_tests()
    monkeypatch.setattr(yahoo.session(), "proxies", {})
    server = _SlowServer(delay=2.0)
    yield server
    server.close()
    yahoo.reset_for_tests()


def test_QA255_후속_예산_때문에_줄인_timeout의_시간_초과는_래치에_세지_않는다(slow_yahoo):
    from curl_cffi.requests import exceptions as curl_exceptions

    yahoo = _yahoo_module()
    for _ in range(yahoo.NO_RESPONSE_LIMIT):
        guard = app_http.TaskGuard(deadline=time.monotonic() + RESERVE + 1.3)     # 요청 timeout이 약 1.3초로 줄어듦 — 서버는 2초 뒤 답
        with pytest.raises(curl_exceptions.Timeout):
            app_http.run_guarded(guard, lambda: yahoo.session().get(slow_yahoo.url))
    assert yahoo._closed_until is None, "자기 예산 때문에 끝난 요청으로 Yahoo를 모든 태스크·화면에 닫았습니다"
    assert yahoo.session().get(slow_yahoo.url, timeout=10).status_code == 200


def test_QA255_후속_응답이_오면_래치를_바로_푼다():
    yahoo = _yahoo_module()
    yahoo.reset_for_tests()
    try:
        for _ in range(yahoo.NO_RESPONSE_LIMIT):
            yahoo._note_timeout()
        assert yahoo._closed_until is not None
        yahoo._note_response()            # 닫히기 전에 나간 요청이 늦게나마 답을 받음 — Yahoo는 살아 있음
        assert yahoo._closed_until is None
    finally:
        yahoo.reset_for_tests()


def test_QA255_후속_다운로드_풀_자리를_기다리는_동안에도_예산을_본다(blackhole):
    import multitasking

    slots = multitasking.config["POOLS"][multitasking.config["POOL_NAME"]]["pool"]
    inner = getattr(slots, "_inner", slots)          # 수정 뒤에는 예산을 보는 감싸개 안에 원래 세마포어가 있음
    taken = 0
    while inner.acquire(blocking=False):             # 다른 태스크의 큰 배치가 자리를 모두 쥔 상태(운영 서버는 cpu_count = 2자리)
        taken += 1
    try:
        assert taken > 0
        finished, elapsed, result = _call(blackhole, lambda: market.minute_bars(["AAA"], "1d"), budget=BUDGET)
        assert finished and elapsed <= BUDGET + 0.5, f"예산 {BUDGET}초인 배치가 자리를 기다리느라 {elapsed:.1f}초 넘게 걸림"
        assert result[0] == {} and result[1], result
    finally:
        for _ in range(taken):
            inner.release()


def _close_latch(yahoo) -> None:
    for _ in range(yahoo.NO_RESPONSE_LIMIT):
        yahoo._note_timeout()
    assert yahoo._closed_until is not None


def test_QA255_후속_래치가_닫히면_사유에_그_이유가_보인다(blackhole):
    from app.services import sector

    yahoo = _yahoo_module()
    _close_latch(yahoo)

    _bars, reason, _ = market.minute_bars(["AAA", "BBB"], "1d")
    assert reason and reason.startswith("Yahoo 응답 없음"), reason
    _prices, reason = market.latest_minute_prices(["AAA"])
    assert reason and reason.startswith("Yahoo 응답 없음"), reason
    _cur, _prev, reason = market.last_two_closes("CL=F")
    assert reason and "Yahoo 응답 없음" in reason, reason
    error = sector.collect_etf_history(("XLK", "XLF"))["error"]
    assert error and "Yahoo 응답 없음" in error and "버전 불일치" not in error, error
    assert blackhole.accepted == 0, "래치가 닫힌 동안 Yahoo로 연결을 열었습니다"


def test_QA255_후속_예산이_모자라면_사유에_그_이유가_보인다(blackhole):
    guard = app_http.TaskGuard(deadline=time.monotonic() + RESERVE + 0.2)
    _bars, reason, _ = app_http.run_guarded(guard, lambda: market.minute_bars(["AAA", "BBB"], "1d"))
    assert reason and "시간 예산" in reason, reason
    assert blackhole.accepted == 0


def test_QA255_후속_timeout_0도_예산_안으로_줄인다():
    yahoo = _yahoo_module()
    fitted, clamped = yahoo._fit(0, 30, 5.0)
    assert (fitted, clamped) == (5.0, True)


# ==============================================================================
# QA-335 — Yahoo가 연결을 거절하거나 5xx로 답하면 crumb·쿠키·시세 요청이 종목·폴백마다 되풀이됨(QA 스택 실측: 한 회차에 약 6,000번)
# ==============================================================================
class _Deny502:
    """
    CONNECT·GET·POST 모두 바로 502로 답하는 서버 — 프록시 자리면 QA 스택 차단 프록시(scripts/qa/blackhole-proxy.py)의 기본 block 모드와 같고
    (curl은 CONNECT 거절을 연결 오류로 올림), 직접 부르면 Yahoo가 HTTP 502로 답하는 경우입니다. 받은 요청 수를 셉니다.
    """

    def __init__(self) -> None:
        owner = self
        self.hits = 0
        self._lock = threading.Lock()

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _deny(self):
                with owner._lock:
                    owner.hits += 1
                try:
                    self.send_response(502, "QA blackhole")
                    self.send_header("Content-Length", "0")
                    self.send_header("Connection", "close")
                    self.end_headers()
                except OSError:
                    pass

            do_CONNECT = do_GET = do_POST = _deny

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}/v8/finance/chart/AAA"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _reset_yfinance_cookie_state() -> None:
    # yfinance 싱글턴은 crumb 전략을 실패마다 basic ↔ csrf로 바꿔 둡니다 — 다음 시험이 같은 출발점에서 시작하게.
    from yfinance.data import YfData

    data = YfData()
    data._cookie_strategy = "basic"
    data._cookie = None
    data._crumb = None


@pytest.fixture()
def deny_proxy(monkeypatch):
    server = _Deny502()
    proxy = f"http://127.0.0.1:{server.port}"
    monkeypatch.setattr(yf.config.network, "proxy", proxy)
    for name in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        monkeypatch.setenv(name, proxy)
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(app_http, "RETRY_RESERVE_SECONDS", RESERVE)
    yahoo = _yahoo_module()
    yahoo.reset_for_tests()
    _reset_yfinance_cookie_state()
    yield server
    server.close()
    yahoo.reset_for_tests()
    yahoo.session().proxies = {}
    _reset_yfinance_cookie_state()


@pytest.fixture()
def yahoo_502(monkeypatch):
    for name in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    yahoo = _yahoo_module()
    yahoo.reset_for_tests()
    monkeypatch.setattr(yahoo.session(), "proxies", {})
    server = _Deny502()
    yield server
    server.close()
    yahoo.reset_for_tests()


def _guarded(fn, budget: float = 20.0):
    guard = app_http.TaskGuard(deadline=time.monotonic() + budget)
    return app_http.run_guarded(guard, fn)


def test_QA335_연결이_거절되면_Yahoo를_닫아_한_회차의_요청_폭주를_멈춘다(deny_proxy):
    import os

    from app.services import sector

    yahoo = _yahoo_module()
    limit = getattr(yahoo, "FAILURE_LIMIT", 5)
    # 이미 나간 요청(다운로드 풀의 다른 종목 스레드)은 막지 못하므로 동시 자리만큼 여유를 둡니다 — 수정 전에는 이 회차에 약 140번.
    bound = limit + (os.cpu_count() or 2) + 2

    _bars, reason, _ = _guarded(lambda: market.minute_bars([f"T{i}" for i in range(10)], "1d"))
    closed = yahoo.unavailable_reason()
    assert closed and "Yahoo 연결 실패" in closed, f"연결 실패가 이어졌는데 Yahoo를 닫지 않음(사유: {reason})"

    # 같은 회차의 다음 Yahoo 태스크들 — 보내지 않고 닫힌 이유를 사유로(빈 응답·버전 불일치 의심이 아니라)
    _prices, reason2 = _guarded(lambda: market.latest_minute_prices([f"T{i}" for i in range(10)]))
    error = _guarded(lambda: sector.collect_daily_closes([f"S{i}" for i in range(10)], period="3mo"))["error"]
    _cur, _prev, reason3 = _guarded(lambda: market.last_two_closes("CL=F"))
    for text in (reason2, error, reason3):
        assert text and "Yahoo 연결 실패" in text and "버전 불일치" not in text, text
    assert deny_proxy.hits <= bound, f"Yahoo로 {deny_proxy.hits}번 보냄(상한 {bound})"


def test_QA335_HTTP_5xx가_이어져도_Yahoo를_닫는다(yahoo_502):
    yahoo = _yahoo_module()
    limit = getattr(yahoo, "FAILURE_LIMIT", 5)
    for _ in range(limit):
        assert yahoo.session().get(yahoo_502.url, timeout=5).status_code == 502
    reason = yahoo.unavailable_reason()
    assert reason and "Yahoo 연결 실패" in reason and "HTTP 502" in reason, reason
    with pytest.raises(yahoo.YahooNoResponse):
        yahoo.session().get(yahoo_502.url, timeout=5)
    assert yahoo_502.hits == limit


def test_QA335_정상_응답은_실패_셈을_비우고_5xx는_닫힌_래치를_풀지_않는다():
    yahoo = _yahoo_module()
    yahoo.reset_for_tests()
    try:
        for _ in range(yahoo.FAILURE_LIMIT - 1):
            yahoo._note_failure("ConnectionError")
        yahoo._note_response()            # 살아 있는 Yahoo의 답(2xx·3xx·4xx — crumb 401 포함)
        for _ in range(yahoo.FAILURE_LIMIT - 1):
            yahoo._note_failure("ConnectionError")
        assert yahoo.unavailable_reason() is None, "정상 응답 사이의 실패가 이어진 것으로 셈"

        yahoo.reset_for_tests()
        _close_latch(yahoo)               # 시간 초과로 닫힘 — 사유 머리는 예전 그대로
        yahoo._note_server_error(503)     # 닫히기 전에 나간 요청이 늦게 5xx를 받음 — 쓸 수 없는 답이라 풀지 않음
        reason = yahoo.unavailable_reason()
        assert reason and reason.startswith(f"Yahoo 응답 없음 — 연달아 {yahoo.NO_RESPONSE_LIMIT}번 시간 초과"), reason
    finally:
        yahoo.reset_for_tests()


# ==============================================================================
# QA-368 — yf.download 배치의 끝난 스레드 객체가 프로세스 수명 내내 쌓이지 않게
# ==============================================================================
def _run_empty_tasks(count: int) -> tuple[int, int]:
    """yfinance가 쓰는 것과 같은 ``@multitasking.task``로 빈 함수를 ``count``번 부르고 모두 끝난 뒤 — (부르기 전 목록 길이, 끝난 뒤 길이)."""
    import multitasking

    _yahoo_module().install()

    @multitasking.task
    def nothing() -> None:
        pass

    def settle() -> None:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and any(t.is_alive() for t in list(multitasking.config["TASKS"])):
            time.sleep(0.01)

    settle()
    nothing()                    # 직전 시험이 남긴 끝난 스레드를 먼저 솎아 기준 길이를 잡습니다(수정 전에는 솎지 않음)
    settle()
    before = len(multitasking.config["TASKS"])
    made = [nothing() for _ in range(count)]
    for thread in made:
        thread.join(30)
    settle()
    nothing()                    # 솎는 것은 다음 작업을 넣을 때입니다
    settle()
    return before, len(multitasking.config["TASKS"])


def test_QA368_끝난_다운로드_스레드는_전역_목록에_쌓이지_않는다():
    # paper_quotes가 615종목을 매시 받으므로 하루 1.5만 개 이상이 남았습니다(개당 약 2KB — 수집기 메모리 상한 1g).
    before, after = _run_empty_tasks(200)

    assert after - before <= 1, f"끝난 스레드 {after - before}개가 목록에 남았습니다"


def test_QA368_아직_시작하지_않은_작업과_도는_작업은_목록에_남는다():
    """multitasking은 목록에 넣은 뒤에 start()합니다 — 솎을 때 '살아 있는가'만 보면 방금 넣은 것을 지웁니다(지금 동작 고정)."""
    import multitasking

    _yahoo_module().install()
    gate = threading.Event()

    @multitasking.task
    def waiting() -> None:
        gate.wait(30)

    try:
        running = [waiting() for _ in range(3)]
        assert all(thread in multitasking.config["TASKS"] for thread in running), "도는 작업은 목록에 있어야 합니다(get_active_tasks)"
        assert len(multitasking.get_active_tasks()) >= 3
    finally:
        gate.set()
        for thread in running:
            thread.join(30)
