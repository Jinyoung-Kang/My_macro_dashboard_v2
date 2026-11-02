"""
tests/test_live_prices.py
화면 실시간 시세(services/live_prices.py, ADR 0024) — 네트워크 없이 고정 응답(2026-11-03 운영 서버에서 받은 응답을 줄인 것)으로 봅니다.

- 요청 읽기: 'US:심볼'·'KR:6자리'만, 같은 것은 하나, 60개까지
- 파싱: Yahoo spark(정규장 시각으로 장 상태, 전일 대비 계산), 네이버(국내 부호 없는 글은 방향 코드로, NXT 시간 외), 다음(KST 거래 시각), 토스 1분봉
- 출처 순서: 앞 출처가 못 준 종목만 다음 출처에 — 미국 네이버 → Yahoo(QA-166), 국내 네이버 → 다음 → 토스
- 거부: Yahoo 래치가 닫혀 있으면 묻지 않고, Yahoo가 거부하면 yfinance와 같은 래치 이름(YAHOO_HOST)을 닫음
- 캐시: 같은 종목은 3초 동안 한 번만, 못 찾은 종목도 3초 동안 다시 묻지 않음
- 경로: 형식이 틀리면 400(부르지 않음)
- 2단계(시장 메뉴 카드): 'TV:거래소:심볼'은 트레이딩뷰 global/scan 한 번(지연은 update_mode, 거래 시각은 모름), 'NI:.INX'는 네이버 해외 지수
- 시간 외(미국 프리·애프터, 국내 NXT): 열려 있으면 그 가격·전일 대비·거래 시각, 지연은 네이버 delayTime
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import http, main
from app.services import live_prices as lp

NOW = 1793645000.0   # 2026-11-02 18:43:20 UTC — 뉴욕 정규장 안


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    lp.reset_cache()
    http.reset_guards()
    monkeypatch.setattr(lp, "_reuters_code", lambda code: {"AAPL": "AAPL.O", "SPY": "SPY", "BRK-B": "BRKb"}.get(code))
    yield
    lp.reset_cache()
    http.reset_guards()


def _yahoo_meta(symbol: str, price: float | None, previous: float | None = 344.63, at: float = NOW - 3) -> dict:
    return {"symbol": symbol, "response": [{"meta": {
        "currency": "USD", "symbol": symbol, "regularMarketPrice": price, "regularMarketTime": at, "previousClose": previous,
        "chartPreviousClose": previous, "regularMarketChangePercent": None,
        "currentTradingPeriod": {"pre": {"start": NOW - 30000, "end": NOW - 10000}, "regular": {"start": NOW - 10000, "end": NOW + 13000},
                                 "post": {"start": NOW + 13000, "end": NOW + 27400}},
    }}]}


SPARK = {"spark": {"result": [_yahoo_meta("AAPL", 337.2), _yahoo_meta("SPY", 756.83, 755.72), _yahoo_meta("ZERO", None)], "error": None}}

NAVER_WORLD = {"pollingInterval": 7000, "datas": [{
    "reutersCode": "AAPL.O", "symbolCode": "AAPL", "closePrice": "337.77", "closePriceRaw": "337.77",
    "compareToPreviousClosePrice": "-6.86", "compareToPreviousClosePriceRaw": "-6.86",
    "compareToPreviousPrice": {"code": "5", "text": "하락", "name": "FALLING"}, "fluctuationsRatio": "-1.99", "fluctuationsRatioRaw": "-1.99",
    "localTradedAt": "2026-11-02T13:57:58-05:00", "marketStatus": "OPEN", "currencyType": {"code": "USD"}, "overMarketPriceInfo": None,
}]}

NAVER_KR = {"pollingInterval": 70000, "datas": [
    {"itemCode": "005930", "closePrice": "230,000", "closePriceRaw": "230000", "compareToPreviousClosePrice": "5,000",
     "compareToPreviousClosePriceRaw": "5000", "compareToPreviousPrice": {"code": "2", "name": "RISING"}, "fluctuationsRatio": "2.22",
     "localTradedAt": "2026-11-02T15:30:00+09:00", "marketStatus": "CLOSE",
     "overMarketPriceInfo": {"tradingSessionType": "AFTER_MARKET", "overMarketStatus": "OPEN", "overPrice": "230,500",
                             "compareToPreviousClosePrice": "5,500", "compareToPreviousPrice": {"code": "2"}, "fluctuationsRatio": "2.44",
                             "localTradedAt": "2026-11-02T19:59:58.000000+09:00"}},
    {"itemCode": "069500", "closePrice": "92,945", "compareToPreviousClosePrice": "2,145", "compareToPreviousPrice": {"code": "5"},
     "fluctuationsRatio": "-2.36", "localTradedAt": "2026-11-03T10:15:02.000000+09:00", "marketStatus": "OPEN"},
]}

DAUM = {"symbolCode": "A005930", "tradePrice": 230000.0, "tradeTime": "195900", "tradeDate": "20261102", "change": "FALL",
        "changePrice": 5000.0, "changeRate": 0.0222222222, "prevClosingPrice": 235000.0, "marketStatus": "CLOSING"}


# --------------------------------------------------------------------------- 요청 읽기
def test_요청은_US_심볼과_KR_6자리만_같은_것은_하나_대문자로():
    assert lp.parse_items("US:aapl, KR:005930,US:AAPL,us:^GSPC,KR:0088m0") == [
        ("US", "AAPL"), ("KR", "005930"), ("US", "^GSPC"), ("KR", "0088M0")]
    assert lp.parse_items("TV:tvc:dxy,TV:CME_MINI:ES1!,NI:.INX") == [("TV", "TVC:DXY"), ("TV", "CME_MINI:ES1!"), ("NI", ".INX")]


@pytest.mark.parametrize("text", ["", "AAPL", "JP:7203", "KR:12345", "US:" + "A" * 25, ",".join(f"US:A{i}" for i in range(61)),
                                  "TV:DXY", "TV:TVC:DX Y", "NI:INX", "NI:.IN/X"])
def test_형식이_틀리거나_60개를_넘으면_ValueError(text):
    with pytest.raises(ValueError):
        lp.parse_items(text)


# --------------------------------------------------------------------------- 파싱
def test_Yahoo_spark는_정규장_시각으로_장_상태_전일_대비는_계산_가격_없는_심볼은_뺌():
    out = lp.yahoo_from_spark(SPARK, NOW)
    assert set(out) == {"AAPL", "SPY"}
    aapl = out["AAPL"]
    assert aapl["price"] == 337.2 and aapl["prevClose"] == 344.63 and aapl["source"] == "Yahoo" and aapl["currency"] == "USD"
    assert aapl["change"] == pytest.approx(-7.43) and aapl["changePct"] == pytest.approx(-7.43 / 344.63 * 100)
    assert aapl["status"] == "OPEN" and aapl["tradedAt"] == "2026-11-02T18:43:17Z"
    assert lp.yahoo_from_spark(SPARK, NOW + 20000)["AAPL"]["status"] == "POST"
    assert lp.yahoo_from_spark(SPARK, NOW + 90000)["AAPL"]["status"] == "CLOSED"
    assert lp.yahoo_from_spark({"spark": {"result": None}}, NOW) == {}


def test_네이버_해외는_부호_있는_글을_숫자로_거래_시각은_UTC():
    out = lp.naver_from_polling(NAVER_WORLD, "US", lambda data: {"AAPL.O": "AAPL"}.get(data["reutersCode"]))
    aapl = out["AAPL"]
    assert aapl["price"] == 337.77 and aapl["change"] == -6.86 and aapl["changePct"] == -1.99
    assert aapl["prevClose"] == pytest.approx(344.63) and aapl["tradedAt"] == "2026-11-02T18:57:58Z" and aapl["status"] == "OPEN"
    assert aapl["source"] == "네이버" and aapl["currency"] == "USD"


def test_네이버_국내는_부호_없는_글을_방향_코드로_NXT_시간_외가_열려_있으면_POST와_그_가격():
    out = lp.naver_from_polling(NAVER_KR, "KR", lambda data: data["itemCode"])
    samsung, kodex = out["005930"], out["069500"]
    assert samsung["price"] == 230000 and samsung["change"] == 5000 and samsung["status"] == "POST"
    assert samsung["overPrice"] == 230500 and samsung["overSession"] == "AFTER_MARKET" and samsung["currency"] == "KRW"
    assert samsung["overChange"] == 5500 and samsung["overChangePct"] == 2.44 and samsung["overTradedAt"] == "2026-11-02T10:59:58Z"
    assert samsung["tradedAt"] == "2026-11-02T06:30:00Z"
    assert kodex["change"] == -2145, "방향 코드 5(하락)면 음수"
    assert kodex["status"] == "OPEN" and kodex["overPrice"] is None and kodex["overTradedAt"] is None
    assert kodex["tradedAt"] == "2026-11-03T01:15:02Z"


def test_다음은_KST_거래_시각을_UTC로_하락은_음수_마감은_CLOSED():
    out = lp.daum_from_quote("005930", DAUM)
    assert out["price"] == 230000 and out["change"] == -5000 and out["changePct"] == pytest.approx(-2.22222222)
    assert out["prevClose"] == 235000 and out["tradedAt"] == "2026-11-02T10:59:00Z" and out["status"] == "CLOSED"
    assert lp.daum_from_quote("005930", {"tradePrice": None}) is None


def test_토스_1분봉은_KST_봉_시각과_종가_전일_대비는_모름():
    out = lp.toss_from_candle("005930", {"date": "2026-11-03", "time": "10:15", "close": 231000})
    assert out["price"] == 231000 and out["tradedAt"] == "2026-11-03T01:15:00Z" and out["source"] == "토스 1분봉"
    assert out["change"] is None and out["changePct"] is None and out["prevClose"] is None
    assert lp.toss_from_candle("005930", None) is None


# --------------------------------------------------------------------------- 출처 순서·거부·캐시
def _stub_chain(monkeypatch, calls, results):
    """출처 함수를 바꿔 끼웁니다 — results[이름] = {코드: 가격}, 부른 순서와 받은 종목을 calls에."""
    def make(name):
        def fetch(codes, errors):
            calls.append((name, list(codes)))
            got = results.get(name, {})
            if got is None:
                errors[name] = "실패"
                return {}
            return {code: {"market": "?", "code": code, "price": got[code], "source": name} for code in codes if code in got}
        return fetch
    monkeypatch.setattr(lp, "CHAINS", {"US": (make("yahoo"), make("naver_us")),
                                       "KR": (make("naver_kr"), make("daum"), make("toss"))})


def test_앞_출처가_못_준_종목만_다음_출처에_묻는다(monkeypatch):
    calls: list = []
    _stub_chain(monkeypatch, calls, {"yahoo": {"AAPL": 1.0}, "naver_us": {"SPY": 2.0},
                                     "naver_kr": None, "daum": {"005930": 3.0}, "toss": {"069500": 4.0}})
    out = lp.prices(lp.parse_items("US:AAPL,US:SPY,US:NOPE,KR:005930,KR:069500"))
    assert calls == [("yahoo", ["AAPL", "SPY", "NOPE"]), ("naver_us", ["SPY", "NOPE"]),
                     ("naver_kr", ["005930", "069500"]), ("daum", ["005930", "069500"]), ("toss", ["069500"])]
    assert {key: item["source"] for key, item in out["items"].items()} == {
        "US:AAPL": "yahoo", "US:SPY": "naver_us", "KR:005930": "daum", "KR:069500": "toss"}
    assert out["missing"] == ["US:NOPE"] and out["errors"] == {"naver_kr": "실패"}
    assert out["fetchedAt"].endswith("Z")


def test_같은_종목은_3초_동안_한_번만_못_찾은_종목도_다시_묻지_않는다(monkeypatch):
    calls: list = []
    _stub_chain(monkeypatch, calls, {"yahoo": {"AAPL": 1.0}, "naver_us": {}})
    now = [1000.0]
    monkeypatch.setattr(lp.time, "monotonic", lambda: now[0])
    lp.prices([("US", "AAPL"), ("US", "NOPE")])
    lp.prices([("US", "AAPL"), ("US", "NOPE")])
    assert len(calls) == 2, "두 번째는 캐시(Yahoo·네이버 각 한 번)"
    now[0] += lp.TTL_SECONDS + 0.1
    out = lp.prices([("US", "AAPL")])
    assert len(calls) == 3 and out["items"]["US:AAPL"]["price"] == 1.0


def test_Yahoo_래치가_닫혀_있으면_묻지_않고_사유를_남긴다(monkeypatch):
    http.reject_host(http.YAHOO_HOST, "HTTP 429")
    monkeypatch.setattr(lp, "_get_json", lambda *a, **k: pytest.fail("Yahoo를 부르면 안 됩니다"))
    errors: dict = {}
    assert lp._fetch_yahoo(["AAPL"], errors) == {}
    assert "거부됨" in errors["Yahoo"]


def test_Yahoo가_거부하면_yfinance와_같은_래치_이름을_닫는다(monkeypatch):
    def rejected(*args, **kwargs):
        raise http.SourceRejected("query1.finance.yahoo.com", "HTTP 429")
    monkeypatch.setattr(lp, "_get_json", rejected)
    errors: dict = {}
    assert lp._fetch_yahoo(["AAPL"], errors) == {}
    assert http.active_rejection(http.YAHOO_HOST) is not None, "같은 Yahoo 한도 — 장중 1분봉·매크로 수집도 5분 쉼"


def test_Yahoo는_공용_세션과_다른_브라우저_표시로_묻는다(monkeypatch):
    seen: dict = {}

    def fake(url, **kwargs):
        seen.update(kwargs)
        return SPARK
    monkeypatch.setattr(lp, "_get_json", fake)
    monkeypatch.setattr(lp.time, "time", lambda: NOW)
    out = lp._fetch_yahoo(["AAPL", "SPY"], {})
    assert set(out) == {"AAPL", "SPY"}
    assert seen["params"]["symbols"] == "AAPL,SPY" and seen["headers"]["User-Agent"] != http.BROWSER_HEADERS["User-Agent"]


def test_네이버_해외는_로이터_코드로_묻고_화면_코드로_돌려준다(monkeypatch):
    urls: list = []
    monkeypatch.setattr(lp, "_get_json", lambda url, **k: urls.append(url) or NAVER_WORLD)
    out = lp._fetch_naver_us(["AAPL", "SPY", "NOPE"], {})
    assert urls == ["https://polling.finance.naver.com/api/realtime/worldstock/stock/AAPL.O,SPY"]
    assert list(out) == ["AAPL"]


# --------------------------------------------------------------------------- 경로
@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "")
    monkeypatch.setattr(main.store, "ping", lambda: None)
    return TestClient(main.app)


def test_경로는_형식이_틀리면_400이고_부르지_않는다(client, monkeypatch):
    monkeypatch.setattr(lp, "prices", lambda items: pytest.fail("호출하면 안 됩니다"))
    assert client.get("/live/prices", params={"items": "JP:7203"}).status_code == 400


def test_경로는_읽은_종목으로_부른다(client, monkeypatch):
    seen: list = []
    monkeypatch.setattr(lp, "prices", lambda items: seen.append(items) or {"items": {}, "missing": [], "errors": {},
                                                                          "fetchedAt": datetime.now(timezone.utc).isoformat()})
    res = client.get("/live/prices", params={"items": "US:AAPL,KR:005930"})
    assert res.status_code == 200 and seen == [[("US", "AAPL"), ("KR", "005930")]]


# --------------------------------------------------------------------------- QA-166
# 운영 배포 뒤 확인(2026-11-03 04:55 KST, 미국 정규장): Yahoo spark는 5초 간격 13번 동안 AAPL·NVDA 모두 같은 값·같은 거래 시각(1분 넘게 캐시된 응답)이었고,
# 네이버 해외는 13번 모두 새 거래 시각(가격 9번 바뀜). 미국을 Yahoo부터 물어 Yahoo가 값을 주면 네이버는 묻지 않아, 5초 주기를 골라도 미국 가격이 1분 넘게
# 그대로였습니다. 실시간 값을 주는 네이버를 먼저 묻고, 네이버가 못 주는 종목(지수 ^…·환율 =X 등)만 Yahoo에 묻습니다.
def test_QA166_미국은_네이버를_먼저_묻고_못_준_종목만_Yahoo에(monkeypatch):
    asked: list = []
    stale = {"spark": {"result": [_yahoo_meta("AAPL", 330.0, at=NOW - 70), _yahoo_meta("^GSPC", 7500.0, at=NOW - 70)]}}

    def fake(url, **kwargs):
        asked.append((url, (kwargs.get("params") or {}).get("symbols")))
        if "spark" in url:
            return stale
        return NAVER_WORLD
    monkeypatch.setattr(lp, "_get_json", fake)
    monkeypatch.setattr(lp.time, "time", lambda: NOW)
    out = lp.prices([("US", "AAPL"), ("US", "^GSPC")])
    assert out["items"]["US:AAPL"]["source"] == "네이버" and out["items"]["US:AAPL"]["price"] == 337.77
    assert out["items"]["US:^GSPC"]["source"] == "Yahoo", "네이버가 못 찾는 지수는 Yahoo"
    assert "polling.finance.naver.com" in asked[0][0], "네이버를 먼저"
    assert [symbols for url, symbols in asked if "spark" in url] == ["^GSPC"], "Yahoo에는 네이버가 못 준 종목만"


# --------------------------------------------------------------------------- 2단계 — 지수·환율·금리·원자재
TV_SCAN = {"totalCount": 3, "data": [
    {"s": "TVC:DXY", "d": [101.77, -0.189, -0.193, "streaming", "market"]},
    {"s": "NYMEX:CL1!", "d": [95.88, -7.91, -8.24, "delayed_streaming_600", "market"]},
    {"s": "KRX:KOSPI", "d": [5859.08, 2.24, 128.34, "streaming", "out_of_session"]},
    {"s": "BAD:NOPRICE", "d": [None, None, None, "streaming", "market"]},
]}


def test_트레이딩뷰는_update_mode로_지연_장_상태는_current_session_거래_시각은_모름():
    out = lp.tradingview_from_scan(TV_SCAN)
    assert set(out) == {"TVC:DXY", "NYMEX:CL1!", "KRX:KOSPI"}
    dxy, wti, kospi = out["TVC:DXY"], out["NYMEX:CL1!"], out["KRX:KOSPI"]
    assert dxy["market"] == "TV" and dxy["price"] == 101.77 and dxy["change"] == -0.193 and dxy["changePct"] == -0.189
    assert dxy["delayMinutes"] == 0 and dxy["status"] == "OPEN" and dxy["tradedAt"] is None and dxy["source"] == "TradingView"
    assert dxy["prevClose"] == pytest.approx(101.963)
    assert wti["delayMinutes"] == 10, "선물은 공개 시세가 10분 지연 — 숨기지 않음"
    assert kospi["status"] == "CLOSED"


def test_트레이딩뷰는_global_scan_한_번에_여러_심볼(monkeypatch):
    sent: list = []

    class Res:
        status_code = 200

        @staticmethod
        def json():
            return TV_SCAN

    class Session:
        @staticmethod
        def post(url, json=None, headers=None, timeout=None):
            sent.append((url, json))
            return Res()
    monkeypatch.setattr(lp, "get_session", lambda: Session())
    out = lp.prices([("TV", "TVC:DXY"), ("TV", "NYMEX:CL1!"), ("TV", "KRX:KOSPI")])
    assert len(sent) == 1 and sent[0][0] == "https://scanner.tradingview.com/global/scan"
    assert sent[0][1]["symbols"]["tickers"] == ["TVC:DXY", "NYMEX:CL1!", "KRX:KOSPI"]
    assert set(out["items"]) == {"TV:TVC:DXY", "TV:NYMEX:CL1!", "TV:KRX:KOSPI"}


def test_네이버_해외_지수는_로이터_코드로_지연은_delayTime(monkeypatch):
    payload = {"datas": [{"reutersCode": ".INX", "closePrice": "7,541.40", "compareToPreviousClosePrice": "-38.67",
                          "compareToPreviousPrice": {"code": "5"}, "fluctuationsRatio": "-0.51", "localTradedAt": "2026-11-02T16:16:21-05:00",
                          "marketStatus": "CLOSE", "stockExchangeType": {"delayTime": 0}}]}
    urls: list = []
    monkeypatch.setattr(lp, "_get_json", lambda url, **k: urls.append(url) or payload)
    out = lp.prices([("NI", ".INX"), ("NI", ".NDX")])
    assert urls == ["https://polling.finance.naver.com/api/realtime/worldstock/index/.INX,.NDX"]
    spx = out["items"]["NI:.INX"]
    assert spx["price"] == 7541.4 and spx["change"] == -38.67 and spx["delayMinutes"] == 0 and spx["status"] == "CLOSED"
    assert spx["tradedAt"] == "2026-11-02T21:16:21Z" and out["missing"] == ["NI:.NDX"]
