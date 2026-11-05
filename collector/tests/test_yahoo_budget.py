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

import importlib
import socket
import threading
import time

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
        _yahoo_module().reset_for_tests()
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


@pytest.mark.xfail(strict=True, reason="QA-255 재현 — yfinance 요청이 태스크 예산을 보지 않아 응답 없는 출처에서 130초 걸림")
def test_QA255_yfinance_요청도_태스크_예산_안에_끝난다(blackhole):
    finished, elapsed, result = _call(blackhole, lambda: market.last_two_closes("CL=F"), budget=BUDGET)

    assert blackhole.accepted > 0, "요청이 무응답 프록시로 가지 않았습니다 — 시험 설정 확인"
    assert finished, f"예산 {BUDGET}초인 호출이 {elapsed:.1f}초 넘게 끝나지 않음"
    assert result[0] is None and result[2], result


@pytest.mark.xfail(strict=True, reason="QA-255 재현 — yf.download(threads=True)의 종목 스레드에는 태스크 예산이 넘어가지 않음")
def test_QA255_yf_download_배치의_종목_스레드도_예산을_본다(blackhole):
    finished, elapsed, result = _call(blackhole, lambda: market.minute_bars(["AAA", "BBB"], "1d"), budget=BUDGET)

    assert blackhole.accepted > 0, "요청이 무응답 프록시로 가지 않았습니다 — 시험 설정 확인"
    assert finished, f"예산 {BUDGET}초인 배치가 {elapsed:.1f}초 넘게 끝나지 않음"
    bars, reason, _limited = result
    assert bars == {} and reason, result


@pytest.mark.xfail(strict=True, reason="QA-255 재현 — Yahoo가 연달아 응답하지 않아도 다음 요청을 그대로 보냄(무응답 래치 없음)")
def test_QA255_연달아_응답이_없으면_Yahoo_요청을_잠시_멈춘다(blackhole, monkeypatch):
    yahoo = _yahoo_module()
    monkeypatch.setattr(yahoo, "NO_RESPONSE_LIMIT", 1)

    finished, elapsed, _ = _call(blackhole, lambda: market.last_two_closes("CL=F"), budget=BUDGET)
    assert finished, f"래치를 닫는 첫 호출이 {elapsed:.1f}초 넘게 끝나지 않음"

    # 태스크 밖(화면 상세·/live 경로 — 예산 없음)도 래치가 닫힌 동안은 기다리지 않고 바로 끝납니다.
    accepted = blackhole.accepted
    finished, elapsed, result = _call(blackhole, lambda: market.last_two_closes("CL=F"), budget=None)
    assert finished and elapsed < 1.5, f"래치가 닫힌 뒤 예산 없는 호출이 {elapsed:.1f}초 걸림"
    assert blackhole.accepted == accepted, "래치가 닫힌 동안 Yahoo로 연결을 새로 열었습니다"
    assert result[0] is None and result[2], result


@pytest.mark.xfail(strict=True, reason="QA-255 재현 — Yahoo 태스크가 다른 태스크와 같은 작업 스레드 8개를 써서, 좀비가 한국 장부 입력을 밀어냄")
def test_QA255_Yahoo_태스크의_좀비가_다른_태스크의_작업_스레드를_뺏지_않는다(monkeypatch):
    monkeypatch.setattr(tasks.store, "record_task_run", lambda *a, **kw: None)
    monkeypatch.setitem(tasks.runner.TASK_DEADLINE_SECONDS, "fast", 0.3)
    tasks._inflight.clear()
    release = threading.Event()
    try:
        # 응답 없는 Yahoo 태스크 8개(지금 작업 스레드 수) — 상한 0.3초에 '시간 초과'로 기록되고 작업 스레드는 좀비로 남습니다.
        zombies = [tasks.Task(f"yahoo_probe_{i}", "fast", lambda: release.wait(10) and "끝", "") for i in range(8)]
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
    "paper_price_history",
}


@pytest.mark.xfail(strict=True, reason="QA-255 재현 — 태스크 목록에 Yahoo 태스크 표시가 없음")
def test_QA255_Yahoo가_주_출처인_태스크만_따로_표시한다():
    marked = {task.name for task in tasks.ALL_TASKS if getattr(task, "yahoo", False)}
    assert marked == YAHOO_TASKS
    # 한국 장부 입력은 Yahoo 몫에 넣지 않습니다(그 좀비에 밀리지 않게).
    assert not marked & {"kr_paper_timed", "kr_paper_quotes", "kr_paper_flows", "paper_watch_kr", "paper_live_kr"}
