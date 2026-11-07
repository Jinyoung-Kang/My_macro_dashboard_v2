"""
tests/test_toss_account.py
토스증권 실제 계좌 — 읽기 전용 조회(ADR 0025, 명세 docs/specs/2026-11-05-toss-account-readonly.md §6).

고정하는 규칙
  1. 공유 토스 세션은 GET과 ``POST /oauth2/token``만, ``https://openapi…``로만 보낸다. 스펙의 쓰기 경로 6개·다른 호스트·http는
     네트워크 전에 TossReadOnlyViolation이다(HTTPAdapter.send 기록기로 '한 번도 보내지 않음'을 본다). AST로 쓰기 호출이 토큰
     발급 하나뿐인지, 계좌 모듈에는 없는지도 본다.
  2. 계좌 경로의 401은 expired-token·token-revoked·invalid-token일 때만, 10분에 한 번만 재발급한다. 429는 잠들지 않는다.
  3. 기다리지 않는 single-flight, 성공 10초 캐시(ADR 0030 — 갱신 시작부터, 여유 1초), 실패 뒤 이전 값(다음 성공까지 — 2026-11-08, 그 전 30분)·30초 쉼,
     호출이 모두 성공해야 바꿈.
  4. 원화(KR)·달러(US)로 나누고 맞지 않는 항목은 세기만 한다. 모르는 값은 None이다(0으로 바꾸지 않음).
  5. 토스 오류 message·예외 문구·계좌번호·accountSeq·orderId는 응답과 로그에 없다.
  6. 꺼져 있거나 서비스 토큰이 없으면 토스를 부르지 않는다.

실제 토스를 부르지 않습니다 — autouse fixture가 TOSS_* 환경변수를 지우고 키를 가짜로 바꾸며, tossinvest 호스트로 가는
HTTPAdapter.send는 예외를 냅니다. 입력(fixtures/toss/account_*.json)은 공식 스펙 1.2.28 예시값으로 만든 합성 응답입니다.
"""
from __future__ import annotations

import ast
import copy
import io
import json
import logging
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

import pytest
import requests
from fastapi.testclient import TestClient
from requests.adapters import HTTPAdapter
from requests.structures import CaseInsensitiveDict

from app import http as app_http
from app import main, settings
from app.services import toss, toss_account

APP = Path(__file__).resolve().parents[1] / "app"
FIXTURES = Path(__file__).parent / "fixtures" / "toss"
KST = ZoneInfo("Asia/Seoul")
CANARY = "CANARY-7f3a"
OPEN_ORDER_IDS = [order["orderId"] for order in
                  json.loads((FIXTURES / "account_orders_open.json").read_text(encoding="utf-8"))["result"]["orders"]]


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _response(request, status: int, body=None, headers: dict | None = None) -> requests.Response:
    """네트워크 없이 만든 응답. 본문이 None이면 JSON이 아닌 글."""
    resp = requests.Response()
    resp.status_code = status
    resp._content = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else b"<html>oops</html>"
    resp._content_consumed = True
    resp.raw = io.BytesIO(resp._content)
    resp.headers = CaseInsensitiveDict({"Content-Type": "application/json", **(headers or {})})
    resp.encoding = "utf-8"
    resp.url = request.url
    resp.request = request
    return resp


def _error(code: str | None, message: str = "") -> dict:
    return {"error": {"requestId": "01HXYZABCDEFG123456789", "code": code, "message": message}}


class FakeToss:
    """HTTPAdapter.send 자리의 가짜 토스. 경로마다 (상태, 본문)이나 ``(params, headers) → (상태, 본문)`` 함수를 둡니다."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.issued = 0
        self.token_route = None
        self._lock = threading.Lock()
        self.routes = {
            "/api/v1/accounts": (200, _fixture("account_accounts.json")),
            "/api/v1/holdings": (200, _fixture("account_holdings.json")),
            "/api/v1/buying-power": lambda params, headers: (
                200, _fixture(f"account_buying_power_{params['currency'].lower()}.json")),
            "/api/v1/orders": self.orders,
        }

    @staticmethod
    def orders(params, headers):
        if params["status"] == "OPEN":
            return 200, _fixture("account_orders_open.json")
        if params.get("cursor"):
            return 200, {"result": {"orders": [], "nextCursor": None, "hasNext": False}}
        return 200, _fixture("account_orders_closed.json")

    def send(self, request, kwargs) -> requests.Response:
        parts = urlsplit(request.url)
        params = dict(parse_qsl(parts.query))
        headers = dict(request.headers)
        with self._lock:
            self.sent.append({"method": request.method, "path": parts.path, "params": params,
                              "headers": headers, "timeout": kwargs.get("timeout")})
        if parts.path == "/oauth2/token":
            if self.token_route is not None:
                return _response(request, *self.token_route())
            with self._lock:
                self.issued += 1
                token = f"tok{self.issued}"
            return _response(request, 200, {"access_token": token, "expires_in": 3600})
        route = self.routes[parts.path]
        status, body = route(params, headers) if callable(route) else route
        return _response(request, status, body)

    def data_calls(self, path: str | None = None) -> list[dict]:
        return [call for call in self.sent
                if call["path"] != "/oauth2/token" and (path is None or call["path"] == path)]


@pytest.fixture
def fake(monkeypatch) -> FakeToss:
    server = FakeToss()
    monkeypatch.setattr(HTTPAdapter, "send", lambda adapter, request, *args, **kwargs: server.send(request, kwargs))
    return server


@pytest.fixture
def recorder(monkeypatch) -> list:
    """보낸 요청을 적기만 하고 200을 돌려주는 send — 가드가 막았으면 비어 있어야 합니다."""
    sent: list = []

    def record(adapter, request, *args, **kwargs):
        sent.append((request.method, request.url))
        return _response(request, 200, {"result": {}})

    monkeypatch.setattr(HTTPAdapter, "send", record)
    return sent


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("TOSS_ACCOUNT_ENABLED", "true")


class Clock:
    START = datetime(2026, 11, 5, 14, 0, 0, tzinfo=KST)

    def __init__(self) -> None:
        self.seconds = 0.0

    def advance(self, seconds: float) -> None:
        self.seconds += seconds

    @classmethod
    def kst(cls, offset: float) -> str:
        return (cls.START + timedelta(seconds=offset)).isoformat(timespec="seconds")


@pytest.fixture
def clock(monkeypatch) -> Clock:
    fake_clock = Clock()
    monkeypatch.setattr(toss_account, "_monotonic", lambda: 10_000.0 + fake_clock.seconds)
    monkeypatch.setattr(toss_account, "_now", lambda: Clock.START + timedelta(seconds=fake_clock.seconds))
    return fake_clock


# ==============================================================================
# 1. 공유 토스 세션의 읽기 전용 가드
# ==============================================================================
WRITE_PATHS = [   # 공식 스펙 1.2.28의 쓰기 경로 전부
    ("POST", "/api/v1/orders"),
    ("POST", "/api/v1/orders/x/modify"),
    ("POST", "/api/v1/orders/x/cancel"),
    ("POST", "/api/v1/conditional-orders"),
    ("POST", "/api/v1/conditional-orders/x/modify"),
    ("DELETE", "/api/v1/conditional-orders/x"),
]


@pytest.mark.parametrize("method,path", WRITE_PATHS)
def test_가드는_스펙의_쓰기_경로_여섯_개를_보내기_전에_막는다(recorder, method, path):
    with pytest.raises(toss.TossReadOnlyViolation):
        toss._http().request(method, f"{toss.BASE_URL}{path}", json={"symbol": "005930", "quantity": "1"}, timeout=1)
    with pytest.raises(toss.TossReadOnlyViolation):
        toss._http().request(method, f"{toss.BASE_URL}{path}", timeout=1)   # 본문이 없어도
    assert recorder == []


@pytest.mark.parametrize("url", [
    "http://openapi.tossinvest.com/api/v1/holdings",
    f"{toss.BASE_URL}:8443/api/v1/holdings",   # 리터럴로 쓰면 gitleaks generic-api-key가 잡음(openapi + :포트)
    "https://openapi.tossinvest.com.example.net/api/v1/holdings",
    "https://example.com/api/v1/holdings",
    "http://127.0.0.1:9/api/v1/holdings",
])
def test_가드는_다른_호스트·포트와_http를_막는다(recorder, url):
    with pytest.raises(toss.TossReadOnlyViolation):
        toss._http().get(url, timeout=1)
    with pytest.raises(toss.TossReadOnlyViolation):
        toss._http().post(url.replace("/api/v1/holdings", "/oauth2/token"), data={"grant_type": "x"}, timeout=1)
    assert recorder == []


@pytest.mark.parametrize("method,path,kwargs", [
    ("GET", "/api/v1/holdings", {"data": "x=1"}),
    ("GET", "/api/v1/holdings", {"json": {"x": 1}}),
    ("HEAD", "/api/v1/holdings", {}),
    ("OPTIONS", "/api/v1/holdings", {}),
    ("PUT", "/api/v1/holdings", {}),
    ("PATCH", "/api/v1/orders/x", {}),
    ("POST", "/api/v1/holdings", {}),
    ("POST", "/oauth2/token/x", {}),
    ("POST", "/oauth2/../api/v1/orders", {"json": {}}),
])
def test_가드는_본문_있는_GET과_GET·토큰_발급_밖의_요청을_막는다(recorder, method, path, kwargs):
    with pytest.raises(toss.TossReadOnlyViolation):
        toss._http().request(method, f"{toss.BASE_URL}{path}", timeout=1, **kwargs)
    assert recorder == []


def test_가드는_GET과_토큰_발급_POST를_한_번씩_보낸다(recorder):
    session = toss._http()
    session.get(f"{toss.BASE_URL}/api/v1/holdings", headers={toss.ACCOUNT_HEADER: "1"}, timeout=1)
    assert len(recorder) == 1
    session.post(toss.AUTH_URL, data={"grant_type": "client_credentials"}, timeout=1)
    session.get("https://openapi.tossinvest.com:443/api/v1/orders?status=OPEN", timeout=1)
    assert [method for method, _ in recorder] == ["GET", "POST", "GET"]


def test_가드의_예외_문구에는_경로·쿼리·본문이_없다(recorder):
    with pytest.raises(toss.TossReadOnlyViolation) as info:
        toss._http().post(f"{toss.BASE_URL}/api/v1/orders/{CANARY}-id/cancel?memo={CANARY}-q",
                          json={"memo": f"{CANARY}-b"}, timeout=1)
    assert CANARY not in str(info.value)
    assert "/api/v1/orders" not in str(info.value)
    assert recorder == []


def test_가드_위반은_연결_실패로_바뀌지_않는다():
    assert issubclass(toss.TossReadOnlyViolation, toss.TossError)
    assert not issubclass(toss.TossReadOnlyViolation, requests.RequestException)


def test_리다이렉트의_다음_요청도_가드를_거친다(monkeypatch):
    sent: list = []

    def redirect(adapter, request, *args, **kwargs):
        sent.append(request.url)
        return _response(request, 302, {}, {"Location": "https://example.com/collect"})

    monkeypatch.setattr(HTTPAdapter, "send", redirect)
    with pytest.raises(toss.TossReadOnlyViolation):
        toss._http().get(f"{toss.BASE_URL}/api/v1/holdings", headers={"Authorization": "Bearer tok"}, timeout=1)
    assert sent == [f"{toss.BASE_URL}/api/v1/holdings"]


def test_가드는_토스_세션에만_붙고_다른_증권사_세션은_그대로다():
    from app.services import kis, ls

    for prefix in ("https://", "http://"):
        assert type(toss._http().adapters[prefix]) is toss._ReadOnlyAdapter
    # 이름만으로 받아도(가드 클래스를 주지 않아도) 붙은 가드를 떼지 않습니다.
    assert type(app_http.get_api_session("toss").adapters["https://"]) is toss._ReadOnlyAdapter
    for module in (kis, ls):
        assert type(module._http().get_adapter("https://example.org/")) is HTTPAdapter


def test_가드_없이_먼저_생긴_토스_세션에도_가드를_붙인다(monkeypatch, recorder):
    plain = requests.Session()
    monkeypatch.setitem(app_http._sessions, "toss", plain)
    session = toss._http()
    assert session is plain
    assert {type(session.adapters[prefix]) for prefix in ("https://", "http://")} == {toss._ReadOnlyAdapter}
    with pytest.raises(toss.TossReadOnlyViolation):
        session.post(f"{toss.BASE_URL}/api/v1/orders", json={}, timeout=1)
    assert recorder == []


# ==============================================================================
# 2. 소스 모양(AST) — 쓰기 호출은 토큰 발급 하나, 토스 호스트·세션은 toss.py 한 곳
# ==============================================================================
WRITE_METHODS = {"post", "put", "patch", "delete", "request"}


def _write_calls(path: Path) -> list[ast.Call]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in WRITE_METHODS]


def test_toss_py의_쓰기_호출은_AUTH_URL로_가는_토큰_발급_POST_하나뿐이다():
    calls = _write_calls(APP / "services" / "toss.py")
    assert len(calls) == 1, [ast.unparse(call) for call in calls]
    assert calls[0].func.attr == "post"
    assert isinstance(calls[0].args[0], ast.Name) and calls[0].args[0].id == "AUTH_URL"


def test_toss_account_py는_쓰기_호출도_토큰_발급도_따로_하지_않는다():
    path = APP / "services" / "toss_account.py"
    assert _write_calls(path) == []
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = ({node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
             | {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)})
    forbidden = {"AUTH_URL", "AUTH_PATH", "_issue_token", "_token_cache", "get_access_token", "_invalidate_token",
                 "api_get", "get_api_session", "send"}
    assert names & forbidden == set()
    assert {"_authorized_get", "_http"} <= names    # 호출은 이 한 길로
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert imported & {"requests", "urllib3", "httpx", "urllib", "http"} == set()


def test_토스_호스트_글자와_toss_세션은_toss_py만_안다():
    hosts, sessions = [], []
    for path in sorted(APP.rglob("*.py")):
        rel = path.relative_to(APP).as_posix()
        text = path.read_text(encoding="utf-8")
        if "tossinvest" in text.lower():
            hosts.append(rel)
        for node in ast.walk(ast.parse(text)):
            if not isinstance(node, ast.Call):
                continue
            name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
            values = [*node.args[:1], *(kw.value for kw in node.keywords if kw.arg == "name")]
            if name == "get_api_session" and any(isinstance(v, ast.Constant) and v.value == "toss" for v in values):
                sessions.append(rel)
    assert hosts == ["services/toss.py"]
    assert sessions == ["services/toss.py"]


# ==============================================================================
# 3. toss._authorized_get — 오류 속성·재발급 대상·429
# ==============================================================================
def test_TossError는_메시지_하나로도_만들어지고_status·code는_비어_있다():
    exc = toss.TossError("HTTP 500")
    assert str(exc) == "HTTP 500" and exc.status is None and exc.code is None
    forbidden = toss.TossForbidden("403")
    assert str(forbidden) == "403" and forbidden.status is None and forbidden.code is None
    with_attrs = toss.TossError("x", status=429, code="rate-limit-exceeded")
    assert (with_attrs.status, with_attrs.code) == (429, "rate-limit-exceeded")


def test_retry_on_429가_False면_잠들지_않고_바로_status_429(fake, monkeypatch):
    monkeypatch.setattr(toss.time, "sleep", lambda seconds: pytest.fail("잠들면 안 됩니다"))
    fake.routes["/api/v1/holdings"] = (429, _error("rate-limit-exceeded", CANARY))
    with pytest.raises(toss.TossError) as info:
        toss._authorized_get(toss._http(), "/api/v1/holdings", None, (3, 4), {toss.ACCOUNT_HEADER: "1"},
                             retry_on_429=False)
    assert (info.value.status, info.value.code) == (429, "rate-limit-exceeded")
    assert len(fake.data_calls()) == 1


@pytest.mark.parametrize("code,reissued", [
    ("expired-token", True), ("token-revoked", True), ("invalid-token", True),
    ("login-user-not-found", False), ("edge-blocked", False), (None, False),
])
def test_reissue_codes를_주면_그_코드의_401만_재발급한다(fake, code, reissued):
    hits: list[int] = []

    def holdings(params, headers):
        hits.append(1)
        if len(hits) == 1:
            return 401, (_error(code) if code else None)
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = holdings
    stamps: list[int] = []

    def call():
        return toss._authorized_get(toss._http(), "/api/v1/holdings", reissue_codes=toss_account.REISSUE_CODES,
                                    on_reissue=lambda: stamps.append(1))

    if reissued:
        assert call()["items"]
        assert fake.issued == 2 and stamps == [1]
    else:
        with pytest.raises(toss.TossError) as info:
            call()
        assert (info.value.status, info.value.code) == (401, code)
        assert fake.issued == 1 and stamps == []
        assert toss._token_cache[0] == "tok1"          # 토큰을 버리지 않음


def test_reissue_codes를_주지_않으면_지금처럼_첫_401에_늘_재발급한다(fake):
    responses = iter([(401, _error("login-user-not-found")), (200, _fixture("account_holdings.json"))])
    fake.routes["/api/v1/holdings"] = lambda params, headers: next(responses)
    assert toss.api_get("/api/v1/holdings")["items"]
    assert fake.issued == 2


def test_403은_지금과_같은_문구의_TossForbidden에_status·code가_붙는다(fake):
    fake.routes["/api/v1/holdings"] = (403, _error("ip-not-allowed", "허용되지 않은 IP"))
    with pytest.raises(toss.TossForbidden) as info:
        toss.api_get("/api/v1/holdings")
    assert str(info.value) == ("HTTP 403 ip-not-allowed 허용되지 않은 IP — 토스 개발자 콘솔의 허용 IP에 이 맥의 공인 IP가 "
                               "있는지 확인하세요")
    assert (info.value.status, info.value.code) == (403, "ip-not-allowed")


def test_그_밖의_실패는_status와_code를_싣는다(fake):
    fake.routes["/api/v1/holdings"] = (500, _error("internal-error", "x"))
    with pytest.raises(toss.TossError) as info:
        toss.api_get("/api/v1/holdings")
    assert str(info.value) == "HTTP 500 internal-error x"
    assert (info.value.status, info.value.code) == (500, "internal-error")


def test_extra_headers는_Authorization을_덮어쓰지_못한다(fake):
    toss._authorized_get(toss._http(), "/api/v1/holdings", extra_headers={
        "authorization": "Bearer evil", "Authorization": "Bearer evil2", toss.ACCOUNT_HEADER: "7"})
    sent = fake.data_calls()[0]["headers"]
    assert [key for key in sent if key.lower() == "authorization"] == ["Authorization"]
    assert sent["Authorization"] == "Bearer tok1" and sent[toss.ACCOUNT_HEADER] == "7"


@pytest.mark.parametrize("status,code", [(403, "token-ip-denied"), (401, "token-failed"), (500, "token-failed")])
def test_토큰_발급_실패는_code로_구분한다(fake, status, code):
    fake.token_route = lambda: (status, {"error": "access_denied", "error_description": "IP address not allowed"})
    with pytest.raises(toss.TossError) as info:
        toss._authorized_get(toss._http(), "/api/v1/holdings")
    assert info.value.code == code and info.value.status is None
    assert fake.data_calls() == []


# ==============================================================================
# 4. 켬 조건
# ==============================================================================
@pytest.mark.parametrize("value", [None, "", "false", "TRUE", "True", "1", "yes", "on", "true1"])
def test_꺼져_있으면_토스를_한_번도_부르지_않는다(fake, monkeypatch, value):
    if value is not None:
        monkeypatch.setenv("TOSS_ACCOUNT_ENABLED", value)
    assert toss_account.get_account() == toss_account.empty_view(enabled=False, reason="disabled")
    assert fake.sent == []


def test_켬은_환경변수가_앞뒤_공백을_뺀_정확한_true일_때만(monkeypatch):
    monkeypatch.setattr(settings, "_load_secrets_file",
                        lambda: {"toss": {"account_enabled": "true"}, "TOSS_ACCOUNT_ENABLED": "true"})
    assert settings.toss_account_enabled() is False      # secrets.toml은 보지 않음
    monkeypatch.setenv("TOSS_ACCOUNT_ENABLED", "  true \n")
    assert settings.toss_account_enabled() is True


def test_키가_없으면_not_configured이고_부르지_않는다(fake, enabled, monkeypatch):
    monkeypatch.setattr(settings, "toss_credentials", lambda: ("", ""))
    body = toss_account.get_account()
    assert (body["ok"], body["enabled"], body["reason"]) == (False, True, "not-configured")
    assert fake.sent == []


# ==============================================================================
# 5. 응답 — KRW·USD 나눔, 허용 목록, null
# ==============================================================================
def test_원화는_KR_달러는_US로_나눠_모두_받는다(fake, enabled, clock):
    body = toss_account.get_account()

    assert (body["ok"], body["enabled"], body["reason"], body["errorCode"]) == (True, True, None, None)
    assert (body["isStale"], body["staleSince"]) == (False, None)
    assert body["fetchedAt"] == "2026-11-05T14:00:00+09:00"
    assert body["account"] == {"label": "토스증권 종합매매", "type": "BROKERAGE"}
    assert body["accountCount"] == 1
    assert body["closedFrom"] == "2026-10-06"           # KST 오늘 - 30일
    assert (body["closedTruncated"], body["unclassifiedCount"]) == (False, 0)

    kr, us = body["sides"]["KR"], body["sides"]["US"]
    assert (kr["currency"], kr["buyingPower"]) == ("KRW", "5000000")
    assert (us["currency"], us["buyingPower"]) == ("USD", "3500.5")
    assert kr["summary"] == {"purchaseAmount": "6500000", "marketValue": "7200000", "marketValueAfterCost": "7050000",
                             "profitLoss": "700000", "profitLossAfterCost": "550000", "dailyProfitLoss": "100000"}
    assert us["summary"] == {"purchaseAmount": "1553", "marketValue": "1785", "marketValueAfterCost": "1771.43",
                             "profitLoss": "232", "profitLossAfterCost": "218.43", "dailyProfitLoss": "25"}
    assert kr["holdings"] == [{
        "symbol": "005930", "name": "삼성전자", "marketCountry": "KR", "currency": "KRW", "quantity": "100",
        "lastPrice": "72000", "averagePurchasePrice": "65000", "purchaseAmount": "6500000", "marketValue": "7200000",
        "marketValueAfterCost": "7050000", "profitLoss": "700000", "profitLossAfterCost": "550000",
        "profitLossRate": "0.1077", "profitLossRateAfterCost": "0.0846", "dailyProfitLoss": "100000",
        "dailyProfitLossRate": "0.0141",
    }]
    assert [h["symbol"] for h in us["holdings"]] == ["AAPL"]
    assert [o["symbol"] for o in kr["openOrders"]] == ["005930"]
    assert [o["symbol"] for o in kr["closedOrders"]] == ["005930"] and us["closedOrders"] == []
    assert us["openOrders"] == [{
        "symbol": "AAPL", "name": "Apple Inc.", "side": "SELL", "orderType": "LIMIT", "timeInForce": "DAY",
        "status": "PARTIAL_FILLED", "currency": "USD", "price": "185.5", "quantity": "5", "orderAmount": None,
        "orderedAt": "2026-03-29T10:00:00+09:00", "canceledAt": None, "filledQuantity": "2",
        "averageFilledPrice": "185.25", "filledAmount": "370.5", "commission": "0.66", "tax": "0",
        "filledAt": "2026-03-29T10:00:05+09:00", "settlementDate": None,
    }]
    assert kr["openOrders"][0]["name"] == "삼성전자"     # 이름은 보유 이름표에서만

    calls = fake.data_calls()
    cursor = _fixture("account_orders_closed.json")["result"]["nextCursor"]
    assert [(c["path"], c["params"]) for c in calls] == [
        ("/api/v1/accounts", {}),
        ("/api/v1/holdings", {}),
        ("/api/v1/buying-power", {"currency": "KRW"}),
        ("/api/v1/buying-power", {"currency": "USD"}),
        ("/api/v1/orders", {"status": "OPEN"}),
        ("/api/v1/orders", {"status": "CLOSED", "from": "2026-10-06", "limit": "100"}),
        ("/api/v1/orders", {"status": "CLOSED", "from": "2026-10-06", "limit": "100", "cursor": cursor}),
    ]
    assert {c["method"] for c in calls} == {"GET"}
    assert toss.ACCOUNT_HEADER not in calls[0]["headers"]
    assert {c["headers"][toss.ACCOUNT_HEADER] for c in calls[1:]} == {"1"}
    assert all(c["timeout"][0] <= 3 and c["timeout"][1] <= 4 for c in calls)


def test_계좌번호·accountSeq·orderId와_모르는_필드는_응답에_없다(fake, enabled):
    accounts = _fixture("account_accounts.json")
    accounts["result"][0]["accountSeq"] = 987654321
    fake.routes["/api/v1/accounts"] = (200, accounts)
    holdings = _fixture("account_holdings.json")
    holdings["result"]["accountNo"] = "12345678901"
    holdings["result"]["items"][0]["unknownField"] = CANARY
    fake.routes["/api/v1/holdings"] = (200, holdings)

    body = toss_account.get_account()
    text = json.dumps(body, ensure_ascii=False)
    assert body["ok"] is True
    for needle in ("12345678901", "987654321", "accountNo", "accountSeq", "orderId", "unknownField", CANARY,
                   *OPEN_ORDER_IDS, _fixture("account_orders_closed.json")["result"]["orders"][0]["orderId"]):
        assert needle not in text, needle
    assert set(body["sides"]["KR"]["holdings"][0]) == {name for name, _ in toss_account.HOLDING_FIELDS}
    assert fake.data_calls()[1]["headers"][toss.ACCOUNT_HEADER] == "987654321"   # 헤더로만 씀


def test_시장·통화가_맞지_않는_항목은_어느_쪽에도_넣지_않고_센다(fake, enabled):
    holdings = _fixture("account_holdings.json")
    items = holdings["result"]["items"]
    mismatched = copy.deepcopy(items[0])
    mismatched.update(symbol="ODD1", currency="USD")                         # 국내인데 달러
    unknown = copy.deepcopy(items[1])
    unknown.update(symbol="ODD2", marketCountry="JP", currency="JPY")        # 처음 보는 시장·통화
    items += [mismatched, unknown, "not-an-object"]
    fake.routes["/api/v1/holdings"] = (200, holdings)
    open_orders = _fixture("account_orders_open.json")
    yen = copy.deepcopy(open_orders["result"]["orders"][0])
    yen.update(orderId="yen-1", symbol="ODD3", currency="JPY")
    open_orders["result"]["orders"].append(yen)
    fake.routes["/api/v1/orders"] = lambda params, headers: (
        (200, open_orders) if params["status"] == "OPEN" else FakeToss.orders(params, headers))

    body = toss_account.get_account()
    assert body["unclassifiedCount"] == 4
    sides = json.dumps(body["sides"])
    assert "ODD1" not in sides and "ODD2" not in sides and "ODD3" not in sides
    assert [h["symbol"] for h in body["sides"]["KR"]["holdings"]] == ["005930"]
    assert [h["symbol"] for h in body["sides"]["US"]["holdings"]] == ["AAPL"]


def test_모르는_값은_None이고_0으로_바꾸지_않는다(fake, enabled):
    holdings = _fixture("account_holdings.json")
    result = holdings["result"]
    result["items"] = [result["items"][0]]                   # 국내만 — 스펙: 해외 종목이 없으면 usd는 null
    for path in (("totalPurchaseAmount",), ("marketValue", "amount"), ("marketValue", "amountAfterCost"),
                 ("profitLoss", "amount"), ("profitLoss", "amountAfterCost"), ("dailyProfitLoss", "amount")):
        node = result
        for key in path:
            node = node[key]
        node["usd"] = None
    result["items"][0]["lastPrice"] = 72000                  # 문자열이 아닌 숫자
    del result["items"][0]["dailyProfitLoss"]
    fake.routes["/api/v1/holdings"] = (200, holdings)
    fake.routes["/api/v1/buying-power"] = lambda params, headers: (200, {"result": {"currency": params["currency"]}})

    body = toss_account.get_account()
    kr, us = body["sides"]["KR"], body["sides"]["US"]
    assert set(us["summary"].values()) == {None}
    assert kr["buyingPower"] is None and us["buyingPower"] is None
    holding = kr["holdings"][0]
    assert holding["lastPrice"] is None
    assert holding["dailyProfitLoss"] is None and holding["dailyProfitLossRate"] is None
    assert holding["quantity"] == "100"
    order = kr["openOrders"][0]
    assert order["averageFilledPrice"] is None and order["filledQuantity"] == "0"   # "0"은 실제 0이라 그대로


def test_다른_통화로_온_매수_가능_금액은_그_쪽에_싣지_않는다(fake, enabled):
    fake.routes["/api/v1/buying-power"] = lambda params, headers: (
        200, {"result": {"currency": "USD", "cashBuyingPower": "3500.5"}})
    body = toss_account.get_account()
    assert body["sides"]["KR"]["buyingPower"] is None
    assert body["sides"]["US"]["buyingPower"] == "3500.5"


def test_OPEN과_CLOSED에_같은_주문이_있으면_CLOSED만_남긴다(fake, enabled):
    open_orders = _fixture("account_orders_open.json")
    moved = copy.deepcopy(open_orders["result"]["orders"][1])       # AAPL — 조회 사이에 체결됨
    moved["status"] = "FILLED"
    closed = _fixture("account_orders_closed.json")
    closed["result"].update(orders=[*closed["result"]["orders"], moved], nextCursor=None, hasNext=False)
    fake.routes["/api/v1/orders"] = lambda params, headers: (200, open_orders if params["status"] == "OPEN" else closed)

    us = toss_account.get_account()["sides"]["US"]
    assert us["openOrders"] == []
    assert [o["status"] for o in us["closedOrders"]] == ["FILLED"]


def _closed_order(order_id: str, ordered_at: str) -> dict:
    order = copy.deepcopy(_fixture("account_orders_closed.json")["result"]["orders"][0])
    order.update(orderId=order_id, orderedAt=ordered_at)
    return order


def test_끝난_주문은_orderedAt_최신순이고_읽을_수_없는_시각은_맨_뒤(fake, enabled):
    pages = {
        None: {"orders": [_closed_order("a", "2026-10-20T09:30:00+09:00"), _closed_order("b", "bad")],
               "nextCursor": "c2", "hasNext": True},
        "c2": {"orders": [_closed_order("c", "2026-10-21T00:10:00.000+09:00"),
                          _closed_order("d", "2026-10-20T01:00:00Z"),            # = 10:00 KST
                          _closed_order("e", "2026-10-22T09:00:00")],            # 시간대 없음
               "nextCursor": None, "hasNext": False},
    }
    fake.routes["/api/v1/orders"] = lambda params, headers: (
        FakeToss.orders(params, headers) if params["status"] == "OPEN" else (200, {"result": pages[params.get("cursor")]}))

    closed = toss_account.get_account()["sides"]["KR"]["closedOrders"]
    assert [o["orderedAt"] for o in closed] == [
        "2026-10-21T00:10:00.000+09:00", "2026-10-20T01:00:00Z", "2026-10-20T09:30:00+09:00", "bad",
        "2026-10-22T09:00:00",
    ]


def test_끝난_주문은_3쪽까지만_받고_남으면_closedTruncated(fake, enabled):
    def orders(params, headers):
        if params["status"] == "OPEN":
            return FakeToss.orders(params, headers)
        page = {None: 1, "p2": 2, "p3": 3}[params.get("cursor")]
        return 200, {"result": {"orders": [_closed_order(f"o{page}", f"2026-10-2{page}T09:00:00+09:00")],
                                "nextCursor": f"p{page + 1}", "hasNext": True}}

    fake.routes["/api/v1/orders"] = orders
    body = toss_account.get_account()
    assert body["closedTruncated"] is True
    assert [c["params"].get("cursor") for c in fake.data_calls("/api/v1/orders") if c["params"]["status"] == "CLOSED"] \
        == [None, "p2", "p3"]
    assert len(body["sides"]["KR"]["closedOrders"]) == 3


# ==============================================================================
# 6. 캐시 — TTL·이전 값·쉼·모두 성공해야 바꿈·기다리지 않는 갱신
# ==============================================================================
def test_10초_캐시와_실패_뒤_이전_값·30초_쉼·30분이_지나도_이전_값(fake, enabled, clock):
    assert toss_account.SUCCESS_TTL_SECONDS == 10.0          # ADR 0030(ADR 0025 결정 3 개정) — 60초에서 줄임
    assert toss_account.TTL_SLACK_SECONDS == 1.0             # 화면 10초 주기의 흔들림 여유
    first = toss_account.get_account()
    calls = len(fake.data_calls())
    assert calls == 7

    clock.advance(8)                                        # 9초 안 — 부르지 않음
    assert toss_account.get_account() == first and len(fake.data_calls()) == calls

    clock.advance(2)                                        # 10초 — 갱신했는데 holdings가 500
    fake.routes["/api/v1/holdings"] = (500, _error("internal-error", CANARY))
    stale = toss_account.get_account()
    assert (stale["ok"], stale["isStale"], stale["reason"], stale["errorCode"]) == (
        True, True, "upstream-error", "internal-error")
    assert stale["fetchedAt"] == first["fetchedAt"] and stale["staleSince"] == Clock.kst(10)
    assert stale["sides"] == first["sides"]
    assert len(fake.data_calls()) == calls + 1              # accountSeq는 기억(/accounts 다시 안 부름), holdings에서 멈춤

    clock.advance(29)                                       # 실패 뒤 30초 안 — 부르지 않음
    assert toss_account.get_account()["isStale"] is True and len(fake.data_calls()) == calls + 1

    clock.advance(2)                                        # 31초 — 다시 시도, 또 실패: staleSince는 첫 실패 그대로
    again = toss_account.get_account()
    assert len(fake.data_calls()) == calls + 2 and again["staleSince"] == Clock.kst(10)

    clock.advance(30 * 60)                                  # 받은 지 30분이 넘어도 이전 값 그대로(2026-11-08 — 그 전에는 버림)
    kept = toss_account.get_account()
    assert (kept["ok"], kept["isStale"], kept["fetchedAt"], kept["reason"], kept["staleSince"]) == (
        True, True, first["fetchedAt"], "upstream-error", Clock.kst(10))
    assert kept["sides"] == first["sides"]

    fake.routes["/api/v1/holdings"] = (200, _fixture("account_holdings.json"))
    clock.advance(31)
    fresh = toss_account.get_account()
    assert (fresh["ok"], fresh["isStale"], fresh["staleSince"], fresh["reason"]) == (True, False, None, None)


def test_캐시_나이는_갱신을_시작한_시각부터_세고_주기_흔들림에_1초_여유(fake, enabled, clock):
    """갱신에 1초 걸려도 첫 요청 10초 뒤의 요청은 새로 읽는다 — 끝난 시각부터 세면 화면 10초 주기에서 약 20초마다 바뀜(리뷰 지적)."""
    def slow(params, headers):
        clock.advance(1)
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = slow
    first = toss_account.get_account()                      # 0초 시작 → 1초 받음
    assert first["fetchedAt"] == Clock.kst(1)               # 받은 시각은 끝난 시각 그대로
    calls = len(fake.data_calls())

    clock.advance(9)                                        # 시작부터 10초(받은 뒤 9초) — 새로 읽음(accountSeq는 기억)
    second = toss_account.get_account()                     # 10초 시작 → 11초 받음
    assert len(fake.data_calls()) > calls and second["fetchedAt"] == Clock.kst(11)
    calls = len(fake.data_calls())

    clock.advance(7.5)                                      # 시작부터 8.5초 — 9초 안이라 캐시
    assert toss_account.get_account() == second and len(fake.data_calls()) == calls
    clock.advance(0.6)                                      # 시작부터 9.1초 — 흔들림 여유를 넘음, 새로 읽음
    toss_account.get_account()
    assert len(fake.data_calls()) > calls


def test_휴장일·토스_점검_동안_이전_값은_다음_성공까지(fake, enabled, clock):
    """받은 뒤 사흘 동안 토스가 점검(maintenance)으로 답해도 마지막 표를 받은 시각과 함께 이전 값으로 보이고, 점검이 끝나면 새 값(2026-11-08 사용자 결정 —
    ADR 0025 결정 3 개정, 그 전에는 받은 지 30분 뒤 버림)."""
    def slow(params, headers):
        clock.advance(5)
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = slow
    first = toss_account.get_account()                      # 0초 시작 → 5초 받음
    assert first["fetchedAt"] == Clock.kst(5)
    fake.routes["/api/v1/holdings"] = (503, _error("maintenance", CANARY))

    clock.advance(1828)                                     # 받은 지 30분을 넘김
    stale = toss_account.get_account()
    assert (stale["ok"], stale["isStale"], stale["fetchedAt"], stale["errorCode"]) == (True, True, Clock.kst(5), "maintenance")
    assert stale["sides"] == first["sides"]

    clock.advance(3 * 24 * 3600)                            # 사흘 뒤에도 점검 — 그대로 이전 값
    later = toss_account.get_account()
    assert (later["ok"], later["isStale"], later["fetchedAt"]) == (True, True, Clock.kst(5))

    fake.routes["/api/v1/holdings"] = (200, _fixture("account_holdings.json"))
    clock.advance(31)                                       # 점검이 끝남 — 새 값
    fresh = toss_account.get_account()
    assert (fresh["ok"], fresh["isStale"], fresh["staleSince"]) == (True, False, None)
    assert fresh["fetchedAt"] != Clock.kst(5)


def test_갱신은_호출이_모두_성공해야_바꾼다(fake, enabled, clock):
    first = toss_account.get_account()
    clock.advance(61)
    changed = _fixture("account_holdings.json")
    changed["result"]["totalPurchaseAmount"]["krw"] = "1"
    fake.routes["/api/v1/holdings"] = (200, changed)
    fake.routes["/api/v1/buying-power"] = lambda params, headers: (
        (500, None) if params["currency"] == "USD" else (200, _fixture("account_buying_power_krw.json")))

    body = toss_account.get_account()
    assert body["isStale"] is True and body["sides"] == first["sides"]
    assert body["sides"]["KR"]["summary"]["purchaseAmount"] == "6500000"   # 새 holdings를 섞지 않음
    assert body["errorCode"] is None                                       # 본문이 JSON이 아님


def test_갱신_중에_온_요청은_기다리지_않고_캐시가_없으면_refreshing(fake, enabled):
    entered, release = threading.Event(), threading.Event()

    def slow(params, headers):
        entered.set()
        assert release.wait(5)
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = slow
    results: list[dict] = []
    worker = threading.Thread(target=lambda: results.append(toss_account.get_account()))
    worker.start()
    try:
        assert entered.wait(5)
        started = time.monotonic()
        others = [toss_account.get_account() for _ in range(3)]
        elapsed = time.monotonic() - started
    finally:
        release.set()
        worker.join(5)
    assert elapsed < 1.0
    assert all((o["ok"], o["enabled"], o["reason"]) == (False, True, "refreshing") for o in others)
    assert results[0]["ok"] is True
    assert len(fake.data_calls("/api/v1/holdings")) == 1


def test_갱신_중에는_지금_캐시를_그대로_돌려준다(fake, enabled, clock):
    first = toss_account.get_account()
    clock.advance(61)
    entered, release = threading.Event(), threading.Event()

    def slow(params, headers):
        entered.set()
        assert release.wait(5)
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = slow
    worker = threading.Thread(target=toss_account.get_account)
    worker.start()
    try:
        assert entered.wait(5)
        during = toss_account.get_account()
    finally:
        release.set()
        worker.join(5)
    assert during == first


# ==============================================================================
# 7. 토큰 보호·오류 사유
# ==============================================================================
@pytest.mark.parametrize("code", sorted(toss_account.REISSUE_CODES))
def test_계좌_경로는_세_코드의_401에만_토큰을_다시_받는다(fake, enabled, code):
    responses = iter([(401, _error(code)), (200, _fixture("account_holdings.json"))])
    fake.routes["/api/v1/holdings"] = lambda params, headers: next(responses)
    body = toss_account.get_account()
    assert body["ok"] is True and fake.issued == 2


@pytest.mark.parametrize("code", ["login-user-not-found", "edge-blocked", None])
def test_그_밖의_401은_토큰을_버리지_않고_auth_failed(fake, enabled, code):
    fake.routes["/api/v1/holdings"] = (401, _error(code, CANARY) if code else None)
    body = toss_account.get_account()
    assert (body["ok"], body["reason"], body["errorCode"]) == (False, "auth-failed", code)
    assert fake.issued == 1 and toss._token_cache[0] == "tok1"


def test_계좌_경로의_재발급은_10분에_한_번(fake, enabled, clock):
    state = {"fail_next": True}

    def holdings(params, headers):
        if state["fail_next"]:
            state["fail_next"] = False
            return 401, _error("expired-token")
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = holdings
    assert toss_account.get_account()["ok"] is True and fake.issued == 2

    clock.advance(61)
    state["fail_next"] = True
    body = toss_account.get_account()
    assert (body["reason"], body["isStale"]) == ("auth-failed", True)
    assert fake.issued == 2 and toss._token_cache[0] == "tok2"     # 10분 안 — 버리지도 다시 받지도 않음

    clock.advance(10 * 60)
    state["fail_next"] = True
    body = toss_account.get_account()
    assert (body["ok"], body["isStale"]) == (True, False) and fake.issued == 3


def test_429는_잠들지_않고_rate_limited(fake, enabled, monkeypatch):
    monkeypatch.setattr(toss.time, "sleep", lambda seconds: pytest.fail("잠들면 안 됩니다"))
    fake.routes["/api/v1/buying-power"] = (429, _error("rate-limit-exceeded"))
    body = toss_account.get_account()
    assert (body["reason"], body["errorCode"]) == ("rate-limited", "rate-limit-exceeded")
    assert [c["path"] for c in fake.data_calls()] == ["/api/v1/accounts", "/api/v1/holdings", "/api/v1/buying-power"]


@pytest.mark.parametrize("code,reason", [
    ("ip-not-allowed", "ip-not-allowed"), ("forbidden", "upstream-error"), ("edge-blocked", "upstream-error"),
])
def test_403은_ip_not_allowed만_그_사유이고_나머지는_upstream_error(fake, enabled, code, reason):
    fake.routes["/api/v1/accounts"] = (403, _error(code, CANARY))
    body = toss_account.get_account()
    assert (body["reason"], body["errorCode"]) == (reason, code)


@pytest.mark.parametrize("status,reason", [(403, "ip-not-allowed"), (401, "auth-failed"), (500, "auth-failed")])
def test_토큰_발급이_실패하면_계좌를_부르지_않는다(fake, enabled, status, reason):
    fake.token_route = lambda: (status, {"error": "access_denied", "error_description": CANARY})
    body = toss_account.get_account()
    assert (body["reason"], body["errorCode"]) == (reason, None)
    assert fake.data_calls() == []


def test_account_not_found면_accounts를_한_번만_다시_찾는다(fake, enabled, clock):
    assert toss_account.get_account()["ok"] is True          # accountSeq 1을 기억
    accounts = _fixture("account_accounts.json")
    accounts["result"][0]["accountSeq"] = 2
    fake.routes["/api/v1/accounts"] = (200, accounts)
    fake.routes["/api/v1/holdings"] = lambda params, headers: (
        (404, _error("account-not-found", CANARY)) if headers[toss.ACCOUNT_HEADER] == "1"
        else (200, _fixture("account_holdings.json")))

    clock.advance(61)
    body = toss_account.get_account()
    assert (body["ok"], body["isStale"]) == (True, False)
    calls = fake.data_calls()
    assert [c["path"] for c in calls[7:9]] == ["/api/v1/holdings", "/api/v1/accounts"]
    assert {c["headers"][toss.ACCOUNT_HEADER] for c in calls[9:]} == {"2"}

    # 다시 찾은 계좌로도 account-not-found면 no-account(그 갱신에서 더 찾지 않음)
    fake.routes["/api/v1/holdings"] = (400, _error("account-not-found"))
    clock.advance(61)
    body = toss_account.get_account()
    assert (body["reason"], body["errorCode"], body["accountCount"]) == ("no-account", "account-not-found", 1)
    assert len(fake.data_calls("/api/v1/accounts")) == 3


def test_막_찾은_계좌가_account_not_found면_다시_찾지_않는다(fake, enabled):
    fake.routes["/api/v1/holdings"] = (404, _error("account-not-found"))
    body = toss_account.get_account()
    assert (body["ok"], body["reason"]) == (False, "no-account")
    assert len(fake.data_calls("/api/v1/accounts")) == 1


@pytest.mark.parametrize("accounts,count", [
    ([], 0),
    ([{"accountNo": "12345678901", "accountSeq": 1, "accountType": "PENSION_SAVINGS"}], 0),
    ([{"accountNo": "12345678901", "accountSeq": 1, "accountType": "BROKERAGE"},
      {"accountNo": "12345678902", "accountSeq": 2, "accountType": "BROKERAGE"}], 2),
])
def test_BROKERAGE_계좌가_정확히_하나가_아니면_no_account(fake, enabled, accounts, count):
    fake.routes["/api/v1/accounts"] = (200, {"result": accounts})
    body = toss_account.get_account()
    assert (body["ok"], body["reason"], body["accountCount"]) == (False, "no-account", count)
    assert [c["path"] for c in fake.data_calls()] == ["/api/v1/accounts"]
    assert "1234567890" not in json.dumps(body)


def test_갱신_예산_12초를_넘기면_남은_호출을_하지_않는다(fake, enabled, clock):
    def slow(params, headers):
        clock.advance(13)
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = slow
    body = toss_account.get_account()
    assert (body["ok"], body["reason"]) == (False, "timeout")
    assert [c["path"] for c in fake.data_calls()] == ["/api/v1/accounts", "/api/v1/holdings"]


def test_호출마다_timeout을_남은_예산_안으로_줄인다(fake, enabled, clock):
    def slow(params, headers):
        clock.advance(10)
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = slow
    assert toss_account.get_account()["ok"] is True
    timeouts = [c["timeout"] for c in fake.data_calls()]
    assert timeouts[:2] == [(3.0, 4.0), (3.0, 4.0)]
    assert set(timeouts[2:]) == {(2.0, 2.0)}


def test_토큰_발급이_예산을_다_쓰면_그_뒤의_GET을_보내지_않는다(fake, enabled, clock):
    """진행 중인 발급은 끊지 않지만, 발급이 끝난 뒤 남은 시간이 없으면 GET을 보내지 않고 timeout(백엔드 35초 안에 답함)."""
    def holdings(params, headers):
        toss._invalidate_token()   # 그사이 캐시가 비었다(만료·다른 경로의 무효화)
        return 200, _fixture("account_holdings.json")

    issued = {"count": 0}

    def issue():   # 첫 발급은 바로, 둘째 발급은 13초(갱신 예산 12초를 넘김)
        issued["count"] += 1
        if issued["count"] > 1:
            clock.advance(13)
        return 200, {"access_token": f"tok{issued['count']}", "expires_in": 3600}

    fake.routes["/api/v1/holdings"] = holdings
    fake.token_route = issue
    body = toss_account.get_account()
    assert (body["ok"], body["reason"]) == (False, "timeout")
    assert [c["path"] for c in fake.data_calls()] == ["/api/v1/accounts", "/api/v1/holdings"]


def test_다른_곳이_이미_새_토큰을_받았으면_발급_없이_다시_보내고_10분_한도에_세지_않는다(fake, enabled, clock):
    toss_account._state.last_reissue = toss_account._monotonic()   # 10분 창 안 — 계좌 경로는 스스로 다시 받지 못함
    state = {"first": True}

    def holdings(params, headers):
        if state["first"]:
            state["first"] = False
            with toss._lock:   # 그사이 1분봉 태스크가 새 토큰을 받았다
                toss._token_cache = ("tok-other", time.time() + 3600)
            return 401, _error("token-revoked")
        return 200, _fixture("account_holdings.json")

    fake.routes["/api/v1/holdings"] = holdings
    before = toss_account._state.last_reissue
    body = toss_account.get_account()
    assert (body["ok"], body["isStale"]) == (True, False)
    assert fake.issued == 1                                    # 처음 한 번만 — 계좌 경로는 발급하지 않음
    assert toss_account._state.last_reissue == before          # 10분 한도에 세지 않음
    holdings_calls = fake.data_calls("/api/v1/holdings")
    assert [c["headers"]["Authorization"] for c in holdings_calls] == ["Bearer tok1", "Bearer tok-other"]


# ==============================================================================
# 8. 누출 — 토스 message·예외 문구(카나리)
# ==============================================================================
def test_토스_오류_message와_본문은_응답과_로그에_없다(fake, enabled, caplog):
    caplog.set_level(logging.DEBUG)
    fake.routes["/api/v1/holdings"] = (500, {"error": {
        "requestId": CANARY, "code": f"{CANARY} Not A Code", "message": f"{CANARY} 12345678901", "data": {"x": CANARY}}})
    body = toss_account.get_account()
    assert (body["reason"], body["errorCode"]) == ("upstream-error", None)   # 정규식에 맞지 않는 code는 싣지 않음
    assert CANARY not in json.dumps(body, ensure_ascii=False)
    assert CANARY not in caplog.text and "12345678901" not in caplog.text


def test_예상_못_한_예외는_internal과_클래스_이름만_남긴다(fake, enabled, caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    raised: list[int] = []

    def boom(*args, **kwargs):
        raised.append(1)
        raise ValueError(f"{CANARY} 12345678901")

    monkeypatch.setattr(toss, "_authorized_get", boom)
    body = toss_account.get_account()
    assert (body["ok"], body["reason"], body["errorCode"]) == (False, "internal", None)
    assert CANARY not in json.dumps(body, ensure_ascii=False) and CANARY not in caplog.text
    assert "ValueError" in caplog.text
    toss_account.get_account()
    assert raised == [1]                                   # 실패 뒤 30초는 다시 부르지 않음


# ==============================================================================
# 9. 수집기 경로 GET /toss/account
# ==============================================================================
@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "test-token")
    return TestClient(main.app, raise_server_exceptions=False)


def _get(client):
    return client.get("/toss/account", headers={"X-Service-Token": "test-token"})


def test_경로는_토큰을_검사하고_꺼져_있으면_disabled(client, fake):
    assert client.get("/toss/account").status_code == 401
    response = _get(client)
    assert response.status_code == 200
    assert response.json() == toss_account.empty_view(enabled=False, reason="disabled")
    assert fake.sent == []


def test_서비스_토큰_없이_뜬_수집기는_토스를_부르지_않는다(fake, enabled, monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "")
    response = TestClient(main.app).get("/toss/account")
    assert response.status_code == 200
    assert response.json() == toss_account.empty_view(enabled=False, reason="no-service-token")
    assert fake.sent == []


def test_경로는_켜져_있으면_두_쪽을_돌려준다(client, fake, enabled):
    response = _get(client)
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True and set(body["sides"]) == {"KR", "US"}
    assert "accountSeq" not in response.text and "orderId" not in response.text


def test_경로_안의_예상_못_한_예외는_200_internal과_클래스_이름만(client, fake, enabled, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)

    def boom():
        raise RuntimeError(f"{CANARY} 12345678901")

    monkeypatch.setattr(toss_account, "get_account", boom)
    response = _get(client)
    assert response.status_code == 200
    assert response.json() == toss_account.empty_view(enabled=True, reason="internal")
    assert CANARY not in response.text and CANARY not in caplog.text
    assert "RuntimeError" in caplog.text
