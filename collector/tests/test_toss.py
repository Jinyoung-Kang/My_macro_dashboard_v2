"""
tests/test_toss.py
토스증권 Open API — 투자자별 매매 정규화와 호출 규칙.

고정하는 규칙
  1. 문자열 정수를 int로 옮기고, **null은 None으로 둔다**(0으로 바꾸지 않음).
  2. 401이면 토큰을 한 번만 재발급해 다시 부른다(client당 토큰 1개 — 다른 곳에서
     재발급하면 우리 토큰이 무효가 됨).
  3. 429는 Retry-After만큼 기다려 다시, 403은 즉시 TossForbidden.
  4. 키가 없으면 HTTP를 부르지 않는다.
  5. 태스크: 레이더 화면 종목부터 받고, 날짜별로 observations에 쌓고, 403이면 멈춘다.

입력(fixtures/toss)은 실제 호출 결과가 아니라 공식 스펙 1.2.17로 만든 응답입니다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import catalog, tasks
from app.services import toss

FIXTURES = Path(__file__).parent / "fixtures" / "toss"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeResponse:
    def __init__(self, status: int, body: dict | None = None, headers: dict | None = None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = json.dumps(body or {})

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


@pytest.fixture
def creds(monkeypatch):
    monkeypatch.setattr(toss.settings, "toss_credentials", lambda: ("cid", "secret-value"))
    toss._invalidate_token()
    issued: list[int] = []

    def fake_post(url, data=None, headers=None, timeout=None):
        issued.append(1)
        return type("R", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: {"access_token": f"tok{len(issued)}", "expires_in": 3600},
        })()

    monkeypatch.setattr(toss._http(), "post", fake_post)
    yield issued
    toss._invalidate_token()


# ------------------------------------------------------------------ 정규화
def test_market_record_amounts_and_breakdown():
    record = toss.normalize_market_record(
        _fixture("market_investor_trading_kospi.json")["result"]["records"][0]
    )
    eok = 10**8
    assert record["date"] == "2026-09-25"
    assert record["investors"]["foreigner"] == {"buy": 52000 * eok, "sell": 50000 * eok, "net": 2000 * eok}
    assert record["investors"]["individual"]["net"] == -3000 * eok
    # 기관 합계 = 세부 7개 합 (공식 설명) — 순매수도 같아야 합니다
    breakdown_net = sum(v["net"] for v in record["breakdown"].values())
    assert breakdown_net == record["investors"]["institution"]["net"]
    assert record["breakdown"]["pensionFund"]["net"] == 200 * eok


def test_provisional_stock_record_keeps_nulls():
    """당일 잠정 기록의 개인·기관 세부·기타법인·외국인 보유는 '모름'이지 0이 아닙니다."""
    record = toss.normalize_stock_record(
        _fixture("stock_investor_trading_005930.json")["result"]["records"][0]
    )
    assert record["investors"]["foreigner"]["net"] == 291850
    assert record["investors"]["institution"]["net"] == 37900
    assert record["investors"]["individual"] is None
    assert record["investors"]["otherCorporation"] is None
    assert record["breakdown"] is None
    assert record["foreignerHoldingRate"] is None


def test_confirmed_stock_record_negative_net_and_holding():
    record = toss.normalize_stock_record(
        _fixture("stock_investor_trading_005930.json")["result"]["records"][1]
    )
    assert record["investors"]["individual"]["net"] == -600000
    assert record["breakdown"]["pensionFund"]["net"] == 2000
    assert record["foreignerHoldingRate"] == pytest.approx(0.5089)


def test_non_numeric_amount_is_none():
    assert toss.to_int("-") is None
    assert toss.to_int(None) is None
    assert toss.to_int("-291850") == -291850


# ------------------------------------------------------------------ 호출 규칙
def test_missing_key_does_not_call(monkeypatch):
    monkeypatch.setattr(toss.settings, "toss_credentials", lambda: ("", ""))
    monkeypatch.setattr(toss._http(), "get", lambda *a, **k: pytest.fail("호출하면 안 됩니다"))
    with pytest.raises(toss.TossMissingKey):
        toss.fetch_stock_investor_trading("005930")


def test_401_reissues_token_once(monkeypatch, creds):
    calls: list[str] = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append(headers["Authorization"])
        if len(calls) == 1:
            return FakeResponse(401, {"error": {"code": "invalid-token", "message": "", "requestId": "x"}})
        return FakeResponse(200, _fixture("stock_investor_trading_005930.json"))

    monkeypatch.setattr(toss._http(), "get", fake_get)
    records = toss.fetch_stock_investor_trading("005930", count=3)
    assert len(records) == 3
    assert calls == ["Bearer tok1", "Bearer tok2"]  # 재발급한 새 토큰으로 다시
    assert len(creds) == 2


def test_concurrent_callers_issue_one_token(monkeypatch):
    """client당 토큰 1개 — 동시에 두 곳이 발급하면 먼저 받은 토큰이 무효가 됩니다."""
    import threading
    import time as real_time

    monkeypatch.setattr(toss.settings, "toss_credentials", lambda: ("cid", "secret-value"))
    toss._invalidate_token()
    issued: list[int] = []

    def slow_post(url, data=None, headers=None, timeout=None):
        issued.append(1)
        real_time.sleep(0.2)  # 발급 중에 다른 호출자가 들어오게
        return type("R", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: {"access_token": f"tok{len(issued)}", "expires_in": 3600},
        })()

    monkeypatch.setattr(toss._http(), "post", slow_post)
    tokens: list[str | None] = []
    threads = [threading.Thread(target=lambda: tokens.append(toss.get_access_token()[0])) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    toss._invalidate_token()

    assert len(issued) == 1
    assert tokens == ["tok1"] * 4


def test_401_does_not_drop_a_newer_token():
    """다른 호출자가 이미 재발급한 새 토큰은, 옛 토큰의 401 때문에 버리지 않습니다."""
    toss._token_cache = ("new-token", toss.time.time() + 600)
    toss._invalidate_token("old-token")
    assert toss._token_cache[0] == "new-token"
    toss._invalidate_token("new-token")
    assert toss._token_cache is None


def test_429_waits_retry_after(monkeypatch, creds):
    slept: list[float] = []
    responses = iter([
        FakeResponse(429, None, {"Retry-After": "2"}),
        FakeResponse(200, _fixture("market_investor_trading_kospi.json")),
    ])
    monkeypatch.setattr(toss.time, "sleep", slept.append)
    monkeypatch.setattr(toss._http(), "get", lambda *a, **k: next(responses))
    assert len(toss.fetch_market_investor_trading("KOSPI")) == 2
    assert slept == [2.0]


def test_403_is_forbidden_without_secret_in_message(monkeypatch, creds):
    monkeypatch.setattr(toss._http(), "get", lambda *a, **k: FakeResponse(
        403, {"error": {"code": "forbidden-ip", "message": "허용되지 않은 IP", "requestId": "r"}}))
    with pytest.raises(toss.TossForbidden) as info:
        toss.fetch_stock_investor_trading("005930")
    assert "forbidden-ip" in str(info.value)
    assert "secret-value" not in str(info.value) and "tok1" not in str(info.value)


def test_unsupported_market_symbol_rejected_before_call():
    with pytest.raises(ValueError):
        toss.fetch_market_investor_trading("KOSPI200")


# ------------------------------------------------------------------ 태스크 (DB)
def _radar_snapshot(store, codes):
    market, investor, trade_type, interval = tasks.RADAR_COMBINATIONS[0]
    store.put_snapshot(
        catalog.snap_radar_scanner(market, investor, trade_type, interval),
        {"rows": [{"code": c, "name": c} for c in codes]},
    )


def test_stock_flows_task_saves_by_date(store, monkeypatch):
    _radar_snapshot(store, ["005930", "000660", "bad!"])
    monkeypatch.setattr(tasks.toss, "TOSS_STOCK_SPACING", 0)
    fixture = _fixture("stock_investor_trading_005930.json")["result"]["records"]
    monkeypatch.setattr(
        tasks.toss_service, "fetch_stock_investor_trading",
        lambda code, count: [toss.normalize_stock_record(r) for r in fixture],
    )

    detail = tasks.task_toss_stock_flows()

    assert detail.startswith("2/2 종목")  # 형식이 틀린 코드는 대상에서 빠집니다
    from app import store as store_module
    with store_module.connection() as conn:
        rows = conn.execute(
            "SELECT obs_date::text AS d, entity, payload FROM observations WHERE dataset = %s ORDER BY 1, 2",
            (catalog.OBS_TOSS_STOCK_FLOW,),
        ).fetchall()
    assert [(r["d"], r["entity"]) for r in rows] == [
        ("2026-09-23", "000660"), ("2026-09-23", "005930"),
        ("2026-09-24", "000660"), ("2026-09-24", "005930"),
        ("2026-09-25", "000660"), ("2026-09-25", "005930"),
    ]
    provisional = next(r["payload"] for r in rows if r["d"] == "2026-09-25")
    assert provisional["investors"]["individual"] is None


def test_stock_flows_task_stops_on_forbidden(store, monkeypatch):
    _radar_snapshot(store, ["005930", "000660", "035420"])
    monkeypatch.setattr(tasks.toss, "TOSS_STOCK_SPACING", 0)
    calls: list[str] = []

    def forbidden(code, count):
        calls.append(code)
        raise toss.TossForbidden("HTTP 403 forbidden-ip — 허용 IP 확인")

    monkeypatch.setattr(tasks.toss_service, "fetch_stock_investor_trading", forbidden)
    with pytest.raises(tasks.EmptyResult) as info:
        tasks.task_toss_stock_flows()
    assert calls == ["005930"]  # 같은 답을 받을 나머지는 부르지 않습니다
    assert "허용 IP" in str(info.value)


def test_market_flows_keeps_previous_market_on_partial_failure(store, monkeypatch):
    store.put_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS, {"markets": {"KOSDAQ": {"records": [{"date": "old"}]}}})
    fixture = _fixture("market_investor_trading_kospi.json")["result"]["records"]

    def fetch(symbol, count):
        if symbol == "KOSDAQ":
            raise toss.TossError("HTTP 500")
        return [toss.normalize_market_record(r) for r in fixture]

    monkeypatch.setattr(tasks.toss_service, "fetch_market_investor_trading", fetch)
    detail = tasks.task_toss_market_flows()

    assert detail.startswith("1/2 시장")
    payload = store.read_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS).payload
    # 값은 그대로 잇되, 이어받았다는 표시가 붙습니다(QA-076 — 예전엔 표시 없이 같은 사전을 그대로 이어 썼음).
    assert payload["markets"]["KOSDAQ"]["records"] == [{"date": "old"}]
    assert payload["markets"]["KOSDAQ"]["isStale"] is True
    assert payload["markets"]["KOSPI"]["records"][0]["date"] == "2026-09-25"


def _kospi_only(fixture, kosdaq):
    """KOSPI는 고정본을 돌려주고, KOSDAQ은 ``kosdaq``(예외면 던지고, 아니면 그 값을 돌려줌)."""
    def fetch(symbol, count):
        if symbol == "KOSDAQ":
            if isinstance(kosdaq, Exception):
                raise kosdaq
            return kosdaq
        return [toss.normalize_market_record(r) for r in fixture]
    return fetch


def test_QA076_한_시장이_실패하면_이어받은_시장에_이전_값_표시와_그_시장을_받은_시각을_남긴다(store, monkeypatch):
    """
    한 시장만 실패하면 직전 저장본의 그 시장을 표시 없이 이어 써, 저장본 수집 시각(방금 받은 다른 시장의 시각)이
    멈춘 시장에도 붙었습니다. 백엔드 알림은 그 시각으로 '그날이 지난 뒤 다시 받은 기록'을 확정으로 보므로, 장중에
    마지막으로 받은 KOSDAQ 기록이 다음 날 확정치로 세졌습니다(QA-040 수정이 이 경로에서 무력화).
    """
    received = "2026-09-25T02:00:00+00:00"   # KOSDAQ을 마지막으로 받은 시각(25일 11시 KST, 장중)
    store.put_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS, {"markets": {
        "KOSDAQ": {"records": [{"date": "2026-09-25"}], "fetchedAt": received}}})
    fixture = _fixture("market_investor_trading_kospi.json")["result"]["records"]
    monkeypatch.setattr(tasks.toss_service, "fetch_market_investor_trading",
                        _kospi_only(fixture, toss.TossError("HTTP 500")))

    detail = tasks.task_toss_market_flows()

    markets = store.read_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS).payload["markets"]
    kosdaq = markets["KOSDAQ"]
    assert kosdaq["records"] == [{"date": "2026-09-25"}]          # 값은 그대로 잇되
    assert kosdaq["isStale"] is True and kosdaq["staleSince"]      # 이전 값이라는 표시와
    assert "HTTP 500" in kosdaq["staleReason"]
    assert kosdaq["fetchedAt"] == received                         # 그 시장을 실제로 받은 시각은 옛 시각 그대로
    assert markets["KOSPI"]["fetchedAt"] and not markets["KOSPI"].get("isStale")
    assert "이전 값" in detail and "KOSDAQ" in detail


def test_QA076_빈_응답인_시장도_사유를_남기고_이어받는다(store, monkeypatch):
    store.put_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS, {"markets": {"KOSDAQ": {"records": [{"date": "2026-09-24"}]}}})
    fixture = _fixture("market_investor_trading_kospi.json")["result"]["records"]
    monkeypatch.setattr(tasks.toss_service, "fetch_market_investor_trading", _kospi_only(fixture, []))

    detail = tasks.task_toss_market_flows()

    snapshot = store.read_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS)
    kosdaq = snapshot.payload["markets"]["KOSDAQ"]
    assert "KOSDAQ" in detail and "빈 응답" in detail                # 예전엔 '1/2 시장'뿐 — 왜 빠졌는지 몰랐음
    assert kosdaq["isStale"] is True
    assert kosdaq["fetchedAt"], "받은 시각이 없던 예전 저장본은 그 저장본의 수집 시각으로 채웁니다"


def test_QA076_오래_이어받은_시장은_더_잇지_않는다(store, monkeypatch):
    """실패가 몇 주 이어져도 멈춘 시장 값이 기한 없이 남았습니다(QA-056의 이어받기 기한과 같은 규칙)."""
    from datetime import datetime, timedelta, timezone

    long_ago = (datetime.now(timezone.utc) - timedelta(days=4)).isoformat()
    store.put_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS, {"markets": {"KOSDAQ": {
        "records": [{"date": "2026-09-20"}], "fetchedAt": long_ago,
        "isStale": True, "staleReason": "HTTP 500", "staleSince": long_ago}}})
    fixture = _fixture("market_investor_trading_kospi.json")["result"]["records"]
    monkeypatch.setattr(tasks.toss_service, "fetch_market_investor_trading",
                        _kospi_only(fixture, toss.TossError("HTTP 500")))

    tasks.task_toss_market_flows()

    assert "KOSDAQ" not in store.read_snapshot(catalog.SNAP_TOSS_MARKET_FLOWS).payload["markets"]


def test_market_flows_without_key_is_empty_result(store, monkeypatch):
    monkeypatch.setattr(toss.settings, "toss_credentials", lambda: ("", ""))
    with pytest.raises(tasks.EmptyResult) as info:
        tasks.task_toss_market_flows()
    assert "TOSS_CLIENT_ID" in str(info.value)


# ------------------------------------------------------------------ 레이더 폴백 (DB)
def _universe_record(date: str, foreigner, individual, pension):
    return {
        "date": date,
        "investors": {
            "foreigner": {"net": foreigner} if foreigner is not None else None,
            "institution": {"net": 0},
            "individual": {"net": individual} if individual is not None else None,
            "otherCorporation": None,
        },
        "breakdown": {"pensionFund": {"net": pension}} if pension is not None else None,
    }


def _seed_universe(store):
    store.put_snapshot(catalog.SNAP_TOSS_RADAR_UNIVERSE, {"universe": 100, "stocks": [
        {"code": "005930", "name": "삼성전자", "market": "KOSPI", "lastPrice": 70000.0, "changePct": 1.0,
         "records": [_universe_record("2026-09-25", 300000, None, None),       # 당일 잠정: 개인·연기금 없음
                     _universe_record("2026-09-24", 100000, -50000, 20000)]},
        {"code": "000660", "name": "SK하이닉스", "market": "KOSPI", "lastPrice": 200000.0, "changePct": -0.5,
         "records": [_universe_record("2026-09-25", -10000, None, None),
                     _universe_record("2026-09-24", 5000, 80000, -3000)]},
        {"code": "247540", "name": "에코프로비엠", "market": "KOSDAQ", "lastPrice": 150000.0, "changePct": 2.0,
         "records": [_universe_record("2026-09-25", 999999, None, None)]},
    ]})


def test_toss_ranking_uses_latest_date_with_values(store):
    _seed_universe(store)
    from app.services import radar

    foreign = radar.fetch_toss_ranking("KOSPI", "외국인", "순매수", 30)
    assert [row["code"] for row in foreign] == ["005930"]          # 코스닥 종목은 빠짐
    assert foreign[0]["netAmountEok"] == pytest.approx(210.0)      # 300,000주 × 70,000원
    assert "2026-09-25 기준" in foreign[0]["source"]
    assert "시장 전체 순위 아님" in foreign[0]["source"]

    # 개인·연기금은 당일 잠정치가 없어 전 거래일(09-24) 확정치로 — 날짜를 섞지 않습니다
    individual = radar.fetch_toss_ranking("KOSPI", "개인", "순매수", 30)
    assert [row["code"] for row in individual] == ["000660"]
    assert "2026-09-24 기준" in individual[0]["source"]
    pension_sell = radar.fetch_toss_ranking("KOSPI", "연기금", "순매도", 30)
    assert [row["code"] for row in pension_sell] == ["000660"]
    assert pension_sell[0]["netAmountEok"] < 0


def test_toss_ranking_without_snapshot_explains_why(store):
    from app.services import radar
    assert radar.fetch_toss_ranking("KOSPI", "외국인", "순매수", 30) == []
    assert radar._TOSS_LAST_REASON["value"]


# ------------------------------------------------------------------ 교차 검증용 읽기
def test_index_daily_close_uses_newest_candle_and_date(monkeypatch):
    monkeypatch.setattr(toss, "api_get", lambda path, params=None, timeout=10.0: {
        "candles": [
            {"timestamp": "2026-09-23T09:00:00+09:00", "closePrice": "3456.78"},
            {"timestamp": "2026-09-22T09:00:00+09:00", "closePrice": "3400.00"},
        ],
    })
    reading = toss.fetch_index_daily_close("KOSPI")
    assert reading["ok"] is True
    assert reading["value"] == 3456.78
    assert reading["asOf"] == "2026-09-23"


def test_usdkrw_uses_mid_rate_not_buy_rate(monkeypatch):
    monkeypatch.setattr(toss, "api_get", lambda path, params=None, timeout=10.0: {
        "rate": "1380.5", "midRate": "1375", "validFrom": "2026-09-23T15:30:00+09:00",
    })
    reading = toss.fetch_usdkrw_mid()
    assert reading["ok"] is True
    assert reading["value"] == 1375.0  # 스프레드가 붙은 rate(1380.5)가 아님


def test_verification_reading_never_raises(monkeypatch):
    monkeypatch.setattr(toss, "has_credentials", lambda: True)

    def boom():
        raise toss.TossForbidden("403")

    reading = toss.verification_reading(boom, "환율")
    assert reading["ok"] is False
    assert "403" in reading["detail"]


def test_verification_reading_without_keys(monkeypatch):
    monkeypatch.setattr(toss, "has_credentials", lambda: False)
    reading = toss.verification_reading(lambda: {"ok": True, "value": 1.0}, "환율")
    assert reading["ok"] is False
    assert "TOSS_CLIENT_ID" in reading["detail"]


def test_market_fixture_honors_spec_identities():
    """스펙: 4개 분류 매수 합계 = 매도 합계, 기관 합계 = 세부 7개 합. 테스트 입력도 이 등식을 지킵니다."""
    for rec in _fixture("market_investor_trading_kospi.json")["result"]["records"]:
        record = toss.normalize_market_record(rec)
        sides = [record["investors"][key] for key in toss.INVESTORS]
        if any(side is None or side["buy"] is None or side["sell"] is None for side in sides):
            continue  # 잠정치
        assert sum(s["buy"] for s in sides) == sum(s["sell"] for s in sides)
        if record["breakdown"]:
            for field in ("buy", "sell"):
                assert record["investors"]["institution"][field] == sum(
                    part[field] for part in record["breakdown"].values()
                )


# ------------------------------------------------------------------ QA-350: 봉투 모양이 아닌 응답
@pytest.mark.parametrize("body", [
    {"status": 404, "error": "Not Found"},          # error가 글자(게이트웨이·프레임워크 기본 오류 본문)
    ["oops"],                                        # 본문이 목록
    {"error": ["oops"]},                             # error가 목록
], ids=["error-글자", "본문-목록", "error-목록"])
def test_QA350_오류_본문이_봉투_모양이_아니어도_TossError로_올린다(monkeypatch, creds, body):
    monkeypatch.setattr(toss._http(), "get", lambda *a, **k: FakeResponse(404, body))

    with pytest.raises(toss.TossError) as info:
        toss.api_get("/api/v1/anything")

    assert info.value.status == 404 and info.value.code is None
    assert str(info.value).startswith("HTTP 404")


def test_QA350_200_본문이_객체가_아니면_TossError(monkeypatch, creds):
    monkeypatch.setattr(toss._http(), "get", lambda *a, **k: FakeResponse(200, ["not", "an", "envelope"]))

    with pytest.raises(toss.TossError) as info:
        toss.api_get("/api/v1/anything")

    assert info.value.status == 200


@pytest.mark.parametrize("payload", [
    ["not", "an", "object"],                                   # 본문이 목록
    {"access_token": "tok", "expires_in": "soon"},             # 수명이 숫자가 아님
    {"access_token": "tok", "expires_in": None},
], ids=["본문-목록", "수명-글자", "수명-null"])
def test_QA350_토큰_응답의_형식이_틀리면_예외_없이_실패_글을_돌려준다(monkeypatch, payload):
    monkeypatch.setattr(toss.settings, "toss_credentials", lambda: ("cid", "secret-value"))
    toss._invalidate_token()
    monkeypatch.setattr(toss._http(), "post", lambda *a, **k: type("R", (), {
        "raise_for_status": lambda self: None, "json": lambda self: payload})())

    token, error = toss.get_access_token()

    assert token is None and error and error.startswith("토큰 발급 실패")
    assert toss._cached_token() is None, "형식이 틀린 응답의 토큰은 캐시하지 않습니다"


# ------------------------------------------------------------------ QA-367: 시간 상한
def test_QA367_stock_flows는_시간_상한이_지나면_남은_종목을_다음_주기로(store, monkeypatch):
    codes = [f"{n:06d}" for n in range(100001, 100041)]                    # 40종목
    _radar_snapshot(store, codes)
    monkeypatch.setattr(tasks.toss, "TOSS_STOCK_SPACING", 0)
    fixture = _fixture("stock_investor_trading_005930.json")["result"]["records"]
    elapsed = [0.0]
    calls: list[str] = []

    def slow(code, count):                    # 토스 호출은 태스크 시간 예산 층을 거치지 않습니다 — 건당 한도 10초를 다 쓰는 밤
        calls.append(code)
        elapsed[0] += 10.0
        return [toss.normalize_stock_record(r) for r in fixture]

    monkeypatch.setattr(tasks.toss_service, "fetch_stock_investor_trading", slow)
    monkeypatch.setattr(tasks.toss, "_clock", lambda: elapsed[0], raising=False)       # 수정 전에는 이 시계가 없습니다

    detail = tasks.task_toss_stock_flows()

    assert calls == codes[:30], "300초 뒤에는 새 종목을 묻지 않습니다(수정 전 40회 — 400초)"
    assert detail.startswith("30/40 종목") and "시간 상한 300초" in detail
    assert tasks.toss.TOSS_TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]


def test_QA367_radar_universe는_시간_상한이_지나면_남은_종목을_직전_저장본으로_잇는다(store, monkeypatch):
    codes = [f"{n:06d}" for n in range(100001, 100041)]
    store.put_snapshot(catalog.SNAP_TOSS_RADAR_UNIVERSE, {"universe": 40, "stocks": [
        {"code": code, "market": "KOSPI", "records": [{"date": "2026-09-10"}]} for code in codes]})
    monkeypatch.setattr(tasks.toss, "TOSS_STOCK_SPACING", 0)
    monkeypatch.setattr(tasks.toss_service, "fetch_trading_amount_leaders", lambda n: [{"code": code} for code in codes])
    monkeypatch.setattr(tasks.toss_service, "fetch_stock_infos", lambda asked: {})
    elapsed = [0.0]
    calls: list[str] = []

    def slow(code, days):
        calls.append(code)
        elapsed[0] += 10.0
        return [{"date": "2026-09-11"}]

    monkeypatch.setattr(tasks.toss_service, "fetch_stock_investor_trading", slow)
    monkeypatch.setattr(tasks.toss, "_clock", lambda: elapsed[0], raising=False)

    detail = tasks.task_toss_radar_universe()

    assert calls == codes[:30]
    stocks = {s["code"]: s for s in store.read_snapshot(catalog.SNAP_TOSS_RADAR_UNIVERSE).payload["stocks"]}
    assert stocks[codes[0]]["records"] == [{"date": "2026-09-11"}]
    assert stocks[codes[-1]]["records"] == [{"date": "2026-09-10"}] and stocks[codes[-1]]["isStale"] is True, "묻지 못한 종목은 직전 값으로"
    assert detail.startswith("30/40 종목") and "시간 상한 300초" in detail
