"""
tests/test_live_budget_rest.py
화면이 열 때 외부를 부르는 나머지 조회(/live/prices·/live/symbols·/live/radar)의 요청 하나 예산(QA-1039).

2차(QA-993)가 시세·뉴스·다음 장중 셋에 건 예산에서 빠져 있던 경로들입니다. QA 프록시 hang에서 기억과 잠금을 비우고 수집기를 바로 부른 값
(2026-11-27): /live/symbols 120초 넘음 · /live/prices 100초 · /live/ticker 70초 · /live/radar 62초 — 출처마다 재시도 × timeout이 사슬로 이어졌습니다.
(/live/ticker는 tests/test_live_ticker.py. 검색의 15·45초는 ADR 0041의 설계 값이라 그대로.)

고정하는 규칙: 출처가 연결만 받고 응답하지 않아도 그 조회는 예산 + 남김 안에 지금의 '받지 못함' 꼴로 끝나고, 출처가 바로 답하면 결과는 예산을
걸지 않았을 때와 같습니다. 외부 네트워크에 나가지 않습니다 — 127.0.0.1의 먹통 서버(test_live_budget의 fixture)와 먹통 프록시(test_yahoo_budget)만.
"""
from __future__ import annotations

import threading
import time

import pytest

from app import http as app_http
from app.services import detail, live_prices
from app.services import radar as radar_service
from tests.test_live_budget import answer, client, hang  # noqa: F401 — 먹통 서버·응답 서버·토큰 없는 클라이언트 fixture
from tests.test_yahoo_budget import blackhole  # noqa: F401 — 무응답 프록시 fixture(yfinance)

BUDGET = 3.0          # 시험용 예산(초) — 운영은 app.http.LIVE_BUDGET_SECONDS(10초)
SLACK = 1.5

FIX = pytest.mark.xfail(strict=True, reason="QA-1039: /live/prices·/live/symbols·/live/radar에 화면 조회 예산이 없음")


@pytest.fixture(autouse=True)
def _short(monkeypatch):
    live_prices.reset_cache()
    monkeypatch.setattr(app_http, "LIVE_BUDGET_SECONDS", BUDGET)
    monkeypatch.setattr(detail, "FETCH_TIMEOUT", 2)
    monkeypatch.setattr(live_prices, "FETCH_TIMEOUT", 2)
    yield
    live_prices.reset_cache()


def _timed(get, server=None, started_threads: list | None = None):
    """
    요청을 따로 스레드에서 보내고 예산 + 여유까지만 기다립니다 → (끝났나, 걸린 초, 응답).
    그때까지 끝나지 않았으면(고치기 전) 먹통 서버를 닫아 걸려 있던 요청을 바로 실패시키고 그 스레드가 끝나기를 기다립니다 — 주소를 바꿔 끼운
    것(monkeypatch)이 풀린 뒤에 남은 사슬이 실제 출처로 나가지 않게. yfinance 스레드는 먹통 프록시 fixture가 같은 순서로 정리합니다.
    """
    box: dict = {}
    thread = threading.Thread(target=lambda: box.update(res=get()), daemon=True)
    if started_threads is not None:
        started_threads.append(thread)
    started = time.monotonic()
    thread.start()
    thread.join(BUDGET + SLACK)
    finished, took = not thread.is_alive(), time.monotonic() - started
    if not finished and server is not None:
        server.close()
        if started_threads is None:
            thread.join(90)
    return finished, took, box.get("res")


@FIX
def test_QA1039_실시간_시세는_출처_사슬이_먹통이어도_예산_안에_못_받은_종목으로_끝난다(client, hang, monkeypatch):  # noqa: F811
    monkeypatch.setattr(live_prices, "NAVER_POLLING", hang.base + "/api/realtime")
    monkeypatch.setattr(live_prices, "DAUM_QUOTES", hang.base + "/api/quotes")
    monkeypatch.setattr(live_prices.toss_service, "fetch_candles",
                        lambda *args, **kwargs: (_ for _ in ()).throw(live_prices.toss_service.TossMissingKey("시험 — 키 없음")))

    finished, took, res = _timed(lambda: client.get("/live/prices?items=KR:005930,KR:000660"), hang)

    assert finished, f"예산 {BUDGET}초인 조회가 {took:.1f}초가 지나도 끝나지 않음"
    body = res.json()
    assert res.status_code == 200
    assert body["items"] == {} and sorted(body["missing"]) == ["KR:000660", "KR:005930"], "못 받은 종목은 missing(값을 지어내지 않음)"
    assert live_prices.SOURCE_NAVER in body["errors"]
    assert hang.accepted <= 3, f"먹통 출처에 보낸 요청 {hang.accepted}건 — 예산 안에서는 다시 보내지 않음"


@FIX
def test_QA1039_종목_찾기는_두_출처가_먹통이어도_예산_안에_출처별_실패로_끝난다(client, hang, blackhole, monkeypatch):  # noqa: F811
    detail.reset_cache()
    monkeypatch.setattr(detail, "NAVER_AC", hang.base + "/ac")

    finished, took, res = _timed(lambda: client.get("/live/symbols?q=NVDA"), hang, blackhole.started)

    assert finished, f"예산 {BUDGET}초인 조회가 {took:.1f}초가 지나도 끝나지 않음"
    body = res.json()
    assert body["items"] == [] and body["error"], "지금의 '찾지 못함' 꼴"
    assert detail.NAVER_SOURCE in body["errors"] and "Yahoo Finance" in body["errors"]
    detail.reset_cache()


@FIX
def test_QA1039_수급_랭킹은_다음_네이버가_먹통이어도_예산_안에_받지_못함으로_끝난다(client, hang, monkeypatch):  # noqa: F811
    monkeypatch.setattr(radar_service, "DAUM_RANKING_URL", hang.base + "/api/trend/investor_purchase/")
    monkeypatch.setattr(radar_service, "NAVER_RANKING_URL", hang.base + "/api/domestic/market/trend/trendForeignOrg")
    # 저장본·이력·증권사 API는 이 시험의 대상이 아닙니다(DB·키 없이 돌게).
    monkeypatch.setattr(radar_service.kis, "fetch_deal_ranking", lambda *args, **kwargs: [])
    monkeypatch.setattr(radar_service, "fetch_krx_stored_ranking", lambda *args, **kwargs: [])
    monkeypatch.setattr(radar_service, "fetch_toss_ranking", lambda *args, **kwargs: [])
    monkeypatch.setattr(radar_service, "read_from_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(radar_service, "diagnose_sources", lambda investor: ["시험 — 출처 먹통"])

    finished, took, res = _timed(lambda: client.get("/live/radar?market=KOSPI&investor=외국인&tradeType=순매수"), hang)

    assert finished, f"예산 {BUDGET}초인 조회가 {took:.1f}초가 지나도 끝나지 않음"
    body = res.json()
    assert res.status_code == 200
    assert body["rows"] == [] and body["sourceKind"] == "none" and body["reasons"], "지금의 '받지 못함' 꼴(rows 빈 목록 + 사유)"


def test_실시간_시세는_출처가_바로_답하면_예산을_건_결과가_걸지_않은_결과와_같다(client, monkeypatch):  # noqa: F811
    def fake(market, codes, errors):
        return {code: {"code": code, "price": 70000.0, "source": "시험"} for code in codes}

    monkeypatch.setattr(live_prices, "_fetch", fake)
    plain = live_prices.prices([("KR", "005930")])
    live_prices.reset_cache()
    body = client.get("/live/prices?items=KR:005930").json()

    for payload in (plain, body):
        payload.pop("fetchedAt")
    assert body == plain and body["items"]["KR:005930"]["price"] == 70000.0
