"""
tests/test_live_ticker.py
차트 시계열 조회(/live/ticker — 화면의 단일 지표 차트·상세 차트)의 요청 하나 예산과 짧은 기억(QA-1039, 사용자 결정 D-3).

고치기 전: 이 경로만 화면 조회 예산(http.run_with_budget — QA-993)에서 빠져 있어, Yahoo가 연결만 받고 응답하지 않으면 yfinance의 crumb 받기·
시세 요청이 고정 timeout대로 이어져 약 60초 붙잡혔습니다(QA 프록시 hang 59.98초). 결과도 기억하지 않아 화면을 열 때마다 Yahoo를 새로 불렀습니다
(운영 100~180 ms, 가끔 0.8~1.3초).

고정하는 규칙
  1. Yahoo가 먹통이어도 요청 하나에 예산(운영 10초) 안에 지금의 '받지 못함' 꼴(points 빈 목록 + error)로 끝납니다. 예산 안에서는 Yahoo로 보냅니다.
  2. 받은 결과는 같은 심볼·기간에 일봉(1개월 이상) 5분·분봉(1일·5일) 60초 동안 기억해, 그 사이에는 Yahoo를 다시 부르지 않습니다.
  3. 받지 못한 결과(빈 points)는 기억하지 않습니다 — 다음 요청이 다시 묻습니다.
  4. 기억은 크기 상한(심볼·기간 조합 수)을 넘지 않습니다. 같은 심볼·기간을 함께 묻는 요청은 Yahoo를 한 번만 부릅니다.
  5. 정기 수집이 쓰는 collect_ticker는 기억을 거치지 않습니다(태스크의 Yahoo 호출은 그대로).
  6. 바로 답하면 응답은 기억·예산을 거치지 않은 collect_ticker의 결과와 같습니다(응답 모양 그대로).
외부 네트워크에 나가지 않습니다 — 127.0.0.1의 먹통 프록시(test_yahoo_budget의 fixture)와 바꿔 끼운 _download·가짜 시계만 씁니다.
"""
from __future__ import annotations

import threading
import time

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import http as app_http
from app import main
from app.services import market
from tests.test_yahoo_budget import blackhole  # noqa: F401 — 무응답 프록시 fixture(yfinance 설정·환경변수에 걸고 끝에 되돌림)

BUDGET = 3.0          # 시험용 예산(초) — 운영은 app.http.LIVE_BUDGET_SECONDS(10초)
SLACK = 1.5           # 예산 + 남김(0.5초) 위로 허용하는 여유(시험 기계의 흔들림)

FIX = pytest.mark.xfail(strict=True, reason="QA-1039: /live/ticker에 화면 조회 예산과 짧은 기억이 없음")


def _frame(close: float = 101.0) -> pd.DataFrame:
    index = pd.DatetimeIndex(["2026-11-25", "2026-11-26"], tz="America/New_York")
    return pd.DataFrame({"Open": [100.0, 100.5], "High": [102.0, 102.5], "Low": [99.0, 99.5], "Close": [100.5, close],
                         "Volume": [1000, 1100]}, index=index)


class _Yahoo:
    """market._download 자리 — 부른 횟수를 세고 정해 둔 표(또는 실패 사유)를 돌려줍니다."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail: str | None = None

    def __call__(self, symbol: str, period: str):
        self.calls.append((symbol, period))
        if self.fail:
            return None, False, self.fail
        return _frame(100.0 + len(self.calls)), period in ("1d", "5d"), None


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture()
def yahoo(monkeypatch):
    fake = _Yahoo()
    monkeypatch.setattr(market, "_download", fake)
    return fake


@pytest.fixture()
def clock(monkeypatch):
    fake = _Clock()
    monkeypatch.setattr(market, "_live_now", fake, raising=True)
    return fake


@pytest.fixture(autouse=True)
def _fresh():
    reset = getattr(market, "reset_live_ticker_cache", None)
    if reset:
        reset()
    yield
    if reset:
        reset()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(main, "_check_token", lambda token: None)
    return TestClient(main.app, raise_server_exceptions=False)


@FIX
def test_QA1039_차트_시계열은_Yahoo가_먹통이어도_예산_안에_받지_못함으로_끝난다(client, blackhole, monkeypatch):  # noqa: F811
    monkeypatch.setattr(app_http, "LIVE_BUDGET_SECONDS", BUDGET)
    box: dict = {}

    def run() -> None:
        box["res"] = client.get("/live/ticker/NVDA?period=1y")

    thread = threading.Thread(target=run, daemon=True)
    blackhole.started.append(thread)       # fixture가 프록시를 닫은 뒤 이 스레드가 끝나기를 기다림(실제 Yahoo로 나가지 않게)
    started = time.monotonic()
    thread.start()
    thread.join(BUDGET + SLACK)
    took = time.monotonic() - started

    assert not thread.is_alive(), f"예산 {BUDGET}초인 조회가 {took:.1f}초가 지나도 끝나지 않음"
    assert blackhole.accepted > 0, "예산 안이면 Yahoo로 보냄(먹통 프록시가 받음)"
    body = box["res"].json()
    assert box["res"].status_code == 200
    assert body["points"] == [] and body["error"], "지금의 '받지 못함' 꼴(_empty)"
    assert body["symbol"] == "NVDA" and body["period"] == "1y"


@FIX
def test_QA1039_같은_심볼_기간은_기억_시간_안에_Yahoo를_다시_부르지_않는다(client, yahoo, clock):
    first = client.get("/live/ticker/NVDA?period=1y").json()
    clock.now += 299.0
    again = client.get("/live/ticker/NVDA?period=1y").json()
    assert yahoo.calls == [("NVDA", "1y")], "일봉은 5분 안에 다시 부르지 않음"
    assert again == first

    clock.now += 2.0                                      # 5분이 지남
    later = client.get("/live/ticker/NVDA?period=1y").json()
    assert yahoo.calls == [("NVDA", "1y"), ("NVDA", "1y")]
    assert later["points"][-1]["close"] != first["points"][-1]["close"], "기억 시간이 지나면 새로 받은 값"


@FIX
def test_QA1039_분봉_기간은_60초만_기억한다(client, yahoo, clock):
    client.get("/live/ticker/NVDA?period=5d")
    clock.now += 59.0
    client.get("/live/ticker/NVDA?period=5d")
    assert len(yahoo.calls) == 1
    clock.now += 2.0
    client.get("/live/ticker/NVDA?period=5d")
    assert len(yahoo.calls) == 2, "분봉(1일·5일)은 60초가 지나면 다시 물음"
    client.get("/live/ticker/NVDA?period=1d")
    client.get("/live/ticker/%5ETNX?period=5d")
    assert len(yahoo.calls) == 4, "기간·심볼이 다르면 따로"


@FIX
def test_QA1039_받지_못한_결과는_기억하지_않는다(client, yahoo, clock):
    yahoo.fail = "Yahoo 응답 없음 — 시험"
    failed = client.get("/live/ticker/NVDA?period=1y").json()
    assert failed["points"] == [] and failed["error"] == "Yahoo 응답 없음 — 시험"

    yahoo.fail = None
    clock.now += 1.0
    ok = client.get("/live/ticker/NVDA?period=1y").json()
    assert len(yahoo.calls) == 2, "받지 못한 결과는 기억하지 않아 바로 다시 물음"
    assert ok["points"], "출처가 돌아오면 다음 요청에 바로 값"
    clock.now += 1.0
    client.get("/live/ticker/NVDA?period=1y")
    assert len(yahoo.calls) == 2, "받은 결과는 기억"


@FIX
def test_QA1039_기억은_크기_상한을_넘지_않는다(yahoo, clock):
    limit = market.LIVE_TICKER_CACHE_LIMIT
    for n in range(limit + 20):
        market.live_ticker(f"SYM{n}", "1y")
        clock.now += 0.01
    assert market.live_ticker_cache_size() <= limit
    market.live_ticker(f"SYM{limit + 19}", "1y")
    assert len(yahoo.calls) == limit + 20, "가장 최근에 받은 것은 남아 있음"


@FIX
def test_QA1039_같은_심볼_기간을_함께_물으면_Yahoo를_한_번만_부른다(monkeypatch):
    calls: list[str] = []
    gate = threading.Event()

    def slow(symbol: str, period: str):
        calls.append(symbol)
        gate.wait(5)
        return _frame(), False, None

    monkeypatch.setattr(market, "_download", slow)
    results: list[dict] = []
    threads = [threading.Thread(target=lambda: results.append(market.live_ticker("NVDA", "1y")), daemon=True) for _ in range(3)]
    for thread in threads:
        thread.start()
    time.sleep(0.3)                # 셋 다 들어와 하나만 Yahoo를 부르는 중
    gate.set()
    for thread in threads:
        thread.join(10)

    assert calls == ["NVDA"], "한 화면의 차트 둘이 같은 조회를 함께 보내도 Yahoo에는 한 번"
    assert len(results) == 3 and all(result is results[0] for result in results)


def test_정기_수집의_collect_ticker는_기억을_거치지_않는다(yahoo):
    market.collect_ticker("NVDA", "1y")
    market.collect_ticker("NVDA", "1y")
    assert yahoo.calls == [("NVDA", "1y"), ("NVDA", "1y")], "태스크의 Yahoo 호출은 그대로(기억은 화면 조회 경로에만)"


def test_바로_답하면_응답은_collect_ticker의_결과와_같다(client, yahoo):
    body = client.get("/live/ticker/%5ETNX?period=1y").json()
    yahoo.calls.clear()
    plain = market.collect_ticker("^TNX", "1y")
    # 가짜 Yahoo는 부를 때마다 마지막 종가를 1씩 올림 — 모양과 나머지 값만 견줌
    for payload in (body, plain):
        payload["points"][-1]["close"] = None
    assert body == plain
    assert set(body) == {"symbol", "period", "isIntraday", "isProxy", "isSynthetic", "sourceLabel", "error", "points"}


def test_심볼_형식이_틀리면_Yahoo를_부르지_않고_400(client, yahoo):
    assert client.get("/live/ticker/NVDA%20;x").status_code == 400
    assert yahoo.calls == []
