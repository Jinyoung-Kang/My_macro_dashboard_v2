"""
tests/test_toss_trade.py
토스증권 실제 계좌 — 모의 책을 따라 하는 실제 매매의 수집기 쪽(ADR 0028, 명세 docs/specs/2026-11-06-real-trade-mirror.md §4·§5·§11).

고정하는 규칙
  1. 쓰기 전용 세션은 https + 토스 호스트의 ``POST /api/v1/orders``·``POST /api/v1/orders/{id}/cancel``만 보낸다. 그 밖의 메서드·경로·
     쿼리·인코딩·다른 호스트·http·사용자 정보·리다이렉트(같은 호스트 307 포함)는 네트워크 전에 막힌다(HTTPAdapter.send 기록기).
     공유 ``toss`` 세션은 그대로 읽기 전용이다. AST로 쓰기 호출이 toss_trade.py의 두 경로뿐인지 본다.
  2. 결과는 명세 §4 표의 네 갈래(ACCEPTED·REJECTED·UNKNOWN·NOT_SENT)이고, 모르는 결과를 거절로 바꾸지 않는다.
  3. 수집기 검사(형식·창·1건 금액·오늘 건수와 매수 합)를 통과하지 못하거나 확인하지 못하면 보내지 않는다(NOT_SENT, POST 0건).
  4. 401은 재발급 대상 세 코드일 때만, 계좌 조회와 같은 10분 창으로 한 번 재발급하고 같은 키·같은 본문으로 한 번 더 보낸다.
     취소는 10분 창을 이미 썼어도 한 번 재발급한다(끄기·이상 멈춤의 미체결 취소). 10분 안에 token-revoked를 2번 넘게 보면
     tokenContention이다. 미리 받기는 발급에 성공할 때만 토큰을 바꾼다(실패해도 옛 토큰으로 주문이 나감).
  7. 취소의 409 already-processing(처리 중, 잠시 뒤 다시)은 끝난 거절이 아니라 UNKNOWN이다.
  8. 사전 조회 예산은 종목 수에 맞추고(최대 35초 — 백엔드 읽기 시간 초과 40초 안), 넘칠 목록은 invalid-request로 미리 거절한다.
  5. 토스 오류 message·응답 본문·accountSeq는 응답과 로그에 없다(카나리). 보내는 본문은 여섯 칸뿐이다(price·confirmHighValueOrder 없음).
  6. 스위치(TOSS_TRADING_ENABLED 정확히 true + TOSS_ACCOUNT_ENABLED + 서비스 토큰 + 한도 네 값)가 맞지 않으면 토스를 부르지 않고
     쓰기 세션도 만들지 않는다.

실제 토스를 부르지 않습니다 — conftest의 전역 fixture가 TOSS_* 환경변수를 지우고 키를 가짜로 바꾸며, 토스 호스트로 가는
HTTPAdapter.send는 예외를 냅니다. 여기 응답은 모두 공식 스펙 1.2.28 모양으로 만든 합성본입니다(계좌 응답 fixture도 합성본).
"""
from __future__ import annotations

import ast
import io
import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from http.client import RemoteDisconnected
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

import pytest
import requests
from fastapi.testclient import TestClient
from requests.adapters import HTTPAdapter
from requests.structures import CaseInsensitiveDict
from urllib3.exceptions import MaxRetryError, NewConnectionError, ProtocolError
from urllib3.exceptions import SSLError as Urllib3SSLError

from app import http as app_http
from app import main, settings
from app.services import toss, toss_account, toss_ratelimit, toss_trade

APP = Path(__file__).resolve().parents[1] / "app"
FIXTURES = Path(__file__).parent / "fixtures" / "toss"
KST = ZoneInfo("Asia/Seoul")
CANARY = "CANARY-9c1d"
DAY = "2026-11-09"                              # 월요일
CID = "3f2b8c1e-0d4a-4c6b-9a7e-1b2c3d4e5f60"   # clientOrderId 모양(36자)
NON_JSON = object()


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _at(hour: int, minute: int, second: int = 0, day: str = DAY) -> datetime:
    return datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}:{second:02d}+09:00")


def _http_date(moment: datetime) -> str:
    return format_datetime(moment.astimezone(timezone.utc), usegmt=True)


def _response(request, status: int, body=None, headers: dict | None = None) -> requests.Response:
    """네트워크 없이 만든 응답. 본문이 NON_JSON이면 JSON이 아닌 글, None이면 빈 본문."""
    resp = requests.Response()
    resp.status_code = status
    if body is NON_JSON:
        resp._content = b"<html>oops</html>"
    elif body is None:
        resp._content = b""
    else:
        resp._content = json.dumps(body, ensure_ascii=False).encode("utf-8")
    resp._content_consumed = True
    resp.raw = io.BytesIO(resp._content)
    resp.headers = CaseInsensitiveDict({"Content-Type": "application/json", **(headers or {})})
    resp.encoding = "utf-8"
    resp.url = request.url
    resp.request = request
    return resp


def _error(code: str | None, message: str = "") -> dict:
    return {"error": {"requestId": "01HXYZABCDEFG123456789", "code": code, "message": message}}


def _calendar_body(day: str = DAY, *, integrated: bool = True, pre: bool = True, auction: bool = True,
                   regular: tuple[str, str] = ("09:00", "15:30"), closing: str | None = "15:20") -> dict:
    def session_day(on: str) -> dict:
        if not integrated:
            return {"date": on, "integrated": None}
        return {"date": on, "integrated": {
            "preMarket": {
                "startTime": f"{on}T08:00:00+09:00",
                "singlePriceAuctionStartTime": f"{on}T08:50:00+09:00" if auction else None,
                "endTime": f"{on}T09:00:00+09:00",
            } if pre else None,
            "regularMarket": {
                "startTime": f"{on}T{regular[0]}:00+09:00",
                "singlePriceAuctionStartTime": f"{on}T{closing}:00+09:00" if closing else None,
                "endTime": f"{on}T{regular[1]}:00+09:00",
            },
            "afterMarket": {"startTime": f"{on}T15:30:00+09:00", "singlePriceAuctionEndTime": f"{on}T15:40:00+09:00",
                            "endTime": f"{on}T20:00:00+09:00"},
        }}

    today = session_day(day)
    return {"result": {"today": today, "previousBusinessDay": session_day("2026-11-06"),
                       "nextBusinessDay": session_day("2026-11-10")}}


def _toss_order(order_id: str, *, symbol: str = "005930", side: str = "BUY", status: str = "FILLED",
                quantity: str = "10", filled: str = "10", avg: str | None = "72000", amount: str | None = "720000",
                currency: str = "KRW", tif: str = "DAY") -> dict:
    return {
        "orderId": order_id, "symbol": symbol, "side": side, "orderType": "MARKET", "timeInForce": tif,
        "status": status, "price": None, "quantity": quantity, "orderAmount": None, "currency": currency,
        "orderedAt": f"{DAY}T09:01:00+09:00", "canceledAt": None,
        "execution": {"filledQuantity": filled, "averageFilledPrice": avg, "filledAmount": amount,
                      "commission": "0" if amount else None, "tax": "0" if amount else None,
                      "filledAt": f"{DAY}T09:01:02+09:00" if amount else None, "settlementDate": None},
        "unknownField": CANARY,
    }


class FakeToss:
    """
    HTTPAdapter.send 자리의 가짜 토스. GET은 경로마다 (상태, 본문[, 헤더])나 ``(params, headers) → 그 튜플`` 함수,
    POST는 ``post(path, body, headers)`` 함수(튜플을 돌려주거나 예외를 냄). 쓰기 세션 가드를 통과한 요청만 여기에 닿습니다.
    """

    def __init__(self, clock) -> None:
        self.clock = clock
        self.sent: list[dict] = []
        self.issued = 0
        self.token_route = None
        self._lock = threading.Lock()
        self.open: list[dict] = []
        self.closed: list[list[dict]] = [[]]              # 쪽마다 — 마지막 쪽 앞은 hasNext
        self.last = {"005930": "72000", "069500": "35000", "000660": "180000"}
        self.upper = {"005930": "93600", "069500": "45500", "000660": "234000"}
        self.details: dict[str, dict] = {}
        self.routes = {
            "/api/v1/accounts": (200, _fixture("account_accounts.json")),
            "/api/v1/holdings": (200, _fixture("account_holdings.json")),
            "/api/v1/buying-power": lambda params, headers: (
                200, _fixture(f"account_buying_power_{params['currency'].lower()}.json")),
            "/api/v1/orders": self.orders,
            "/api/v1/prices": self.prices,
            "/api/v1/price-limits": self.price_limits,
            "/api/v1/sellable-quantity": lambda params, headers: (200, {"result": {"sellableQuantity": "100"}}),
            "/api/v1/market-calendar/KR": lambda params, headers: (
                200, _calendar_body(), {"Date": _http_date(self.clock.now)}),
        }
        self.post = self.accept

    @staticmethod
    def accept(path, body, headers):
        if path.endswith("/cancel"):
            return 200, {"result": {"orderId": "cancel-ord-2"}}
        return 200, {"result": {"orderId": "ord-1", "clientOrderId": json.loads(body)["clientOrderId"]}}

    def orders(self, params, headers):
        if params["status"] == "OPEN":
            return 200, {"result": {"orders": self.open, "nextCursor": None, "hasNext": False}}
        index = int(params.get("cursor", "0"))
        more = index + 1 < len(self.closed)
        return 200, {"result": {"orders": self.closed[index], "nextCursor": str(index + 1) if more else None,
                                "hasNext": more}}

    def prices(self, params, headers):
        return 200, {"result": [{"symbol": symbol, "timestamp": None, "lastPrice": self.last[symbol], "currency": "KRW"}
                                for symbol in params["symbols"].split(",")]}

    def price_limits(self, params, headers):
        upper = self.upper.get(params["symbol"])
        return 200, {"result": {"timestamp": f"{DAY}T08:00:00+09:00", "upperLimitPrice": upper,
                                "lowerLimitPrice": "50400" if upper else None, "currency": "KRW"}}

    def send(self, request, kwargs) -> requests.Response:
        parts = urlsplit(request.url)
        params = dict(parse_qsl(parts.query))
        headers = dict(request.headers)
        body = request.body
        if isinstance(body, str):
            body = body.encode("utf-8")
        with self._lock:
            self.sent.append({"method": request.method, "path": parts.path, "params": params, "headers": headers,
                              "body": body, "timeout": kwargs.get("timeout")})
        if parts.path == "/oauth2/token":
            if self.token_route is not None:
                return _response(request, *self.token_route())
            with self._lock:
                self.issued += 1
                token = f"tok{self.issued}"
            return _response(request, 200, {"access_token": token, "expires_in": 3600})
        if request.method == "POST":
            return _response(request, *self.post(parts.path, body, headers))
        route = self.routes.get(parts.path)
        if route is None and parts.path.startswith("/api/v1/orders/"):
            order_id = parts.path.rsplit("/", 1)[1]
            detail = self.details.get(order_id)
            route = (200, {"result": detail}) if detail else (404, _error("order-not-found", CANARY))
        result = route(params, headers) if callable(route) else route
        return _response(request, *result)

    def posts(self) -> list[dict]:
        return [call for call in self.sent if call["method"] == "POST" and call["path"] != "/oauth2/token"]

    def gets(self, path: str | None = None) -> list[dict]:
        return [call for call in self.sent if call["method"] == "GET" and (path is None or call["path"] == path)]


class Clock:
    def __init__(self) -> None:
        self.now = _at(10, 0)


@pytest.fixture
def clock(monkeypatch) -> Clock:
    fake_clock = Clock()
    monkeypatch.setattr(toss_trade, "_now", lambda: fake_clock.now)
    return fake_clock


@pytest.fixture(autouse=True)
def limiter_clock(monkeypatch) -> dict:
    """속도 조절의 시계를 가짜로 — 기다림은 잠들지 않고 시계만 앞으로(시험이 빠르고 결과가 같게)."""
    state = {"now": 1_000.0, "sleeps": [], "advance": True}

    def sleep(seconds):
        state["sleeps"].append(seconds)
        if state["advance"]:
            state["now"] += seconds

    monkeypatch.setattr(toss_ratelimit, "_monotonic", lambda: state["now"])
    monkeypatch.setattr(toss_ratelimit, "_sleep", sleep)
    return state


@pytest.fixture
def fake(monkeypatch, clock) -> FakeToss:
    server = FakeToss(clock)
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


LIMITS = {
    "TOSS_TRADING_MAX_ORDER_KRW": "5000000",
    "TOSS_TRADING_MAX_ORDERS_PER_DAY": "50",
    "TOSS_TRADING_MAX_BUY_KRW_PER_DAY": "20000000",
    "TOSS_TRADING_MAX_EQUITY_KRW": "100000000",
}


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("TOSS_TRADING_ENABLED", "true")
    monkeypatch.setenv("TOSS_ACCOUNT_ENABLED", "true")
    monkeypatch.setenv("COLLECTOR_API_TOKEN", "test-token")
    for name, value in LIMITS.items():
        monkeypatch.setenv(name, value)


def _payload(clock: Clock, **overrides) -> dict:
    body = {"clientOrderId": CID, "symbol": "005930", "side": "BUY", "timeInForce": "DAY", "quantity": "10",
            "firstSentAt": clock.now.isoformat()}
    body.update(overrides)
    return body


def _expected_body(**overrides) -> bytes:
    body = {"clientOrderId": CID, "symbol": "005930", "side": "BUY", "orderType": "MARKET", "timeInForce": "DAY",
            "quantity": "10"}
    body.update(overrides)
    return json.dumps(body, separators=(",", ":")).encode("ascii")


# ==============================================================================
# 1. 쓰기 세션 가드 — 네트워크 전에 막힘
# ==============================================================================
def test_쓰기_세션은_주문·취소_POST_두_길만_보낸다(recorder):
    session = toss_trade._session()
    session.post(f"{toss.BASE_URL}/api/v1/orders", data=b"{}", timeout=1, allow_redirects=False)
    session.post(f"{toss.BASE_URL}/api/v1/orders/Ab-_09/cancel", data=b"{}", timeout=1, allow_redirects=False)
    session.post(f"https://{toss._HOST}:443/api/v1/orders", data=b"{}", timeout=1, allow_redirects=False)
    assert [method for method, _ in recorder] == ["POST", "POST", "POST"]


BLOCKED = [
    ("GET", f"{toss.BASE_URL}/api/v1/orders"),
    ("GET", f"{toss.BASE_URL}/api/v1/holdings"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders/x/modify"),
    ("POST", f"{toss.BASE_URL}/api/v1/conditional-orders"),
    ("POST", f"{toss.BASE_URL}/api/v1/conditional-orders/x/modify"),
    ("DELETE", f"{toss.BASE_URL}/api/v1/conditional-orders/x"),
    ("DELETE", f"{toss.BASE_URL}/api/v1/orders/x"),
    ("PUT", f"{toss.BASE_URL}/api/v1/orders"),
    ("PATCH", f"{toss.BASE_URL}/api/v1/orders"),
    ("POST", f"{toss.BASE_URL}/oauth2/token"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders?memo=x"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders#frag"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders/"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders/x/cancel?y=1"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders/a%2Fb/cancel"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders/a.b/cancel"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders/x/../../conditional-orders"),
    ("POST", f"{toss.BASE_URL}/api/v1/orders/{'a' * 129}/cancel"),
    ("POST", f"http://{toss._HOST}/api/v1/orders"),
    ("POST", f"{toss.BASE_URL}:8443/api/v1/orders"),
    ("POST", f"https://user:pw@{toss._HOST}/api/v1/orders"),
    ("POST", f"https://{toss._HOST}.example.net/api/v1/orders"),
    ("POST", "https://example.com/api/v1/orders"),
    ("POST", "http://127.0.0.1:9/api/v1/orders"),
]


@pytest.mark.parametrize("method,url", BLOCKED)
def test_쓰기_세션은_허용_밖의_요청을_보내기_전에_막는다(recorder, method, url):
    with pytest.raises(toss_trade.TossTradeViolation):
        toss_trade._session().request(method, url, data=b"{}", timeout=1, allow_redirects=False)
    assert recorder == []


def test_가드는_준비된_요청의_퍼센트·점점_경로도_막는다():
    for path in ("/api/v1/orders/..", "/api/v1/orders/x/../cancel", "/api/v1/orders%2F", "/api/v1/%6Frders"):
        prepared = requests.Request("POST", f"{toss.BASE_URL}/api/v1/orders").prepare()
        prepared.url = f"{toss.BASE_URL}{path}"      # 준비 뒤에 바뀐 URL(정규화 전 글자)도 어댑터가 봄
        with pytest.raises(toss_trade.TossTradeViolation):
            toss_trade._write_check(prepared)


def test_리다이렉트는_같은_호스트_307도_따라가지_않는다(monkeypatch, enabled, fake, clock):
    fake.post = lambda path, body, headers: (307, None, {"Location": f"{toss.BASE_URL}/api/v1/orders"})
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"], result["httpStatus"]) == ("UNKNOWN", "redirect", 307)
    assert len(fake.posts()) == 1


@pytest.mark.parametrize("location", [f"{toss.BASE_URL}/api/v1/orders", "https://example.com/collect"])
def test_allow_redirects를_빠뜨려도_다음_요청을_보내지_않는다(monkeypatch, location):
    sent: list = []

    def redirect(adapter, request, *args, **kwargs):
        sent.append(request.url)
        return _response(request, 307, {}, {"Location": location})

    monkeypatch.setattr(HTTPAdapter, "send", redirect)
    with pytest.raises(requests.TooManyRedirects):
        toss_trade._session().post(f"{toss.BASE_URL}/api/v1/orders", data=b"{}", timeout=1)
    assert sent == [f"{toss.BASE_URL}/api/v1/orders"]


def test_가드의_예외_문구에는_경로·쿼리·본문이_없다(recorder):
    with pytest.raises(toss_trade.TossTradeViolation) as info:
        toss_trade._session().post(f"{toss.BASE_URL}/api/v1/orders/{CANARY}/modify?memo={CANARY}",
                                   json={"memo": CANARY}, timeout=1, allow_redirects=False)
    assert CANARY not in str(info.value) and "/api/v1/orders" not in str(info.value)
    assert recorder == []


def test_가드_위반은_연결_실패로_바뀌지_않는다():
    assert issubclass(toss_trade.TossTradeViolation, toss.TossError)
    assert not issubclass(toss_trade.TossTradeViolation, requests.RequestException)


def test_쓰기_세션은_따로이고_공유_토스_세션은_그대로_읽기_전용이다(recorder):
    trade = toss_trade._session()
    shared = toss._http()
    assert trade is not shared
    assert {type(trade.adapters[prefix]) for prefix in ("https://", "http://")} == {toss_trade._TradeWriteAdapter}
    assert trade.trust_env is False and trade.max_redirects == 0
    assert {type(shared.adapters[prefix]) for prefix in ("https://", "http://")} == {toss._ReadOnlyAdapter}
    with pytest.raises(toss.TossReadOnlyViolation):
        shared.post(f"{toss.BASE_URL}/api/v1/orders", data=b"{}", timeout=1)
    assert recorder == []


# ==============================================================================
# 2. 소스 모양(AST) — 쓰기 호출은 toss_trade.py의 두 길뿐
# ==============================================================================
WRITE_METHODS = {"post", "put", "patch", "delete", "request"}


def _tree(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def _write_calls(tree: ast.AST) -> list[ast.Call]:
    return [node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in WRITE_METHODS]


def test_toss_trade_py의_쓰기_호출은_주문·취소_두_길_하나뿐이다():
    tree = _tree(APP / "services" / "toss_trade.py")
    calls = _write_calls(tree)
    assert len(calls) == 1, [ast.unparse(call) for call in calls]
    call = calls[0]
    assert call.func.attr == "post" and ast.unparse(call.func.value) == "session"
    assert ast.unparse(call.args[0]) == "f'{toss.BASE_URL}{path}'"
    assert {kw.arg: ast.unparse(kw.value) for kw in call.keywords}["allow_redirects"] == "False"
    owner = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                 and any(inner is call for inner in ast.walk(node)))
    assert owner.name == "_send"
    # _send를 부르는 곳은 둘 — 주문(ORDER_PATH)과 취소(_cancel_path)
    sends = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Name) and node.func.id == "_send"]
    assert sorted(ast.unparse(node.args[1]) for node in sends) == ["ORDER_PATH", "_cancel_path(order_id)"]
    assert toss_trade.ORDER_PATH == "/api/v1/orders"
    assert toss_trade._cancel_path("Ab-_09") == "/api/v1/orders/Ab-_09/cancel"
    with pytest.raises(ValueError):
        toss_trade._cancel_path("a/b")


def test_쓰기_세션과_가드는_toss_trade_py만_알고_toss_trade를_부르는_곳은_main_py뿐이다():
    owners, importers = [], []
    for path in sorted(APP.rglob("*.py")):
        rel = path.relative_to(APP).as_posix()
        text = path.read_text(encoding="utf-8")
        if "_TradeWriteAdapter" in text or '"toss_trade"' in text:
            owners.append(rel)
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and any(alias.name == "toss_trade" for alias in node.names):
                importers.append(rel)
    assert owners == ["services/toss_trade.py"]
    assert importers == ["main.py"]
    main_tree = _tree(APP / "main.py")
    used = {node.attr for node in ast.walk(main_tree)
            if isinstance(node, ast.Attribute) and ast.unparse(node.value) == "toss_trade_service"}
    assert used <= {"status", "calendar", "warmup", "preflight", "restrictions", "place_order", "cancel_order", "open_orders",
                    "today_orders", "order_detail", "no_service_token_view", "no_service_token_write", "write_result",
                    "UNKNOWN"}


def test_toss_trade_py는_토큰을_따로_발급하지_않고_읽기는_공유_세션_한_길이다():
    tree = _tree(APP / "services" / "toss_trade.py")
    names = ({node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
             | {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)})
    assert names & {"AUTH_URL", "AUTH_PATH", "_issue_token", "api_get"} == set()
    assert {"_authorized_get", "_http", "get_access_token", "account_seq"} <= names


# ==============================================================================
# 3. 결과 분류 — 명세 §4 표
# ==============================================================================
ORDER_TABLE = [
    (200, {"result": {"orderId": "ord-1", "clientOrderId": CID}}, "ACCEPTED", None),
    (200, {"result": {"orderId": "ord-1", "clientOrderId": None}}, "ACCEPTED", None),
    (200, NON_JSON, "UNKNOWN", "bad-response"),
    (200, {"result": {}}, "UNKNOWN", "bad-response"),
    (200, {"result": {"orderId": "a/b"}}, "UNKNOWN", "bad-response"),
    (200, {"result": {"orderId": "ord-1", "clientOrderId": "other"}}, "UNKNOWN", "bad-response"),
    (201, {"result": {"orderId": "ord-1"}}, "UNKNOWN", "http-201"),
    (400, _error("invalid-request"), "REJECTED", "invalid-request"),
    (400, _error("confirm-high-value-required"), "REJECTED", "confirm-high-value-required"),
    (400, _error("account-header-required"), "REJECTED", "account-header-required"),
    (400, NON_JSON, "REJECTED", "http-400"),
    (401, _error("login-user-not-found"), "REJECTED", "login-user-not-found"),
    (403, _error("forbidden"), "REJECTED", "forbidden"),
    (404, _error("stock-not-found"), "REJECTED", "stock-not-found"),
    (409, _error("opposite-pending-order-exists"), "REJECTED", "opposite-pending-order-exists"),
    (409, _error("request-in-progress"), "UNKNOWN", "request-in-progress"),
    (409, _error("already-filled"), "UNKNOWN", "already-filled"),
    (409, NON_JSON, "UNKNOWN", "http-409"),
    (422, _error("insufficient-buying-power"), "REJECTED", "insufficient-buying-power"),
    (422, _error("order-hours-closed"), "REJECTED", "order-hours-closed"),
    (422, _error("stock-restricted"), "REJECTED", "stock-restricted"),
    (422, _error("idempotency-key-conflict"), "UNKNOWN", "idempotency-key-conflict"),
    (422, NON_JSON, "UNKNOWN", "http-422"),
    (429, _error("rate-limit-exceeded"), "REJECTED", "rate-limited"),
    (429, _error("edge-rate-limit-exceeded"), "REJECTED", "rate-limited"),
    (500, _error("internal-error"), "UNKNOWN", "internal-error"),
    (500, _error("maintenance"), "UNKNOWN", "maintenance"),
    (503, NON_JSON, "UNKNOWN", "http-503"),
    (302, None, "UNKNOWN", "redirect"),
    (418, _error("teapot"), "UNKNOWN", "teapot"),
]


@pytest.mark.parametrize("status,body,outcome,code", ORDER_TABLE)
def test_주문_응답은_표대로_네_갈래로_나뉜다(enabled, fake, clock, status, body, outcome, code):
    fake.post = lambda path, sent, headers: (status, body)
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"], result["httpStatus"]) == (outcome, code, status)
    assert result["orderId"] == ("ord-1" if outcome == "ACCEPTED" else None)
    assert len(fake.posts()) == 1                               # 수집기 안에서 다시 보내지 않음


def _connect_refused() -> requests.ConnectionError:
    return requests.ConnectionError(MaxRetryError(None, "/api/v1/orders", reason=NewConnectionError(None, "refused")))


@pytest.mark.parametrize("raised,outcome,code", [
    (lambda: requests.ConnectTimeout("connect"), "NOT_SENT", "connect-timeout"),
    (_connect_refused, "NOT_SENT", "connect-failed"),
    (lambda: requests.ReadTimeout("read"), "UNKNOWN", "read-timeout"),
    (lambda: requests.ConnectionError(ProtocolError("Connection aborted.", RemoteDisconnected("x"))),
     "UNKNOWN", "connection-lost"),
    (lambda: requests.exceptions.ChunkedEncodingError("cut"), "UNKNOWN", "connection-lost"),
    (lambda: requests.exceptions.SSLError(MaxRetryError(None, "/", reason=Urllib3SSLError("eof"))),
     "UNKNOWN", "connection-lost"),
    (lambda: RuntimeError(f"{CANARY} 12345678901"), "UNKNOWN", "internal"),
])
def test_보내는_중의_예외는_연결을_못_맺은_것만_NOT_SENT(enabled, fake, clock, caplog, raised, outcome, code):
    caplog.set_level(logging.DEBUG)

    def boom(path, body, headers):
        raise raised()

    fake.post = boom
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"], result["httpStatus"]) == (outcome, code, None)
    assert CANARY not in json.dumps(result) and CANARY not in caplog.text
    assert len(fake.posts()) == 1


CANCEL_TABLE = [
    (200, {"result": {"orderId": "cancel-ord-2"}}, "ACCEPTED", None),
    (200, {"result": {}}, "UNKNOWN", "bad-response"),
    (400, _error("account-header-required"), "REJECTED", "account-header-required"),
    (404, _error("order-not-found"), "REJECTED", "order-not-found"),
    (409, _error("already-filled"), "REJECTED", "already-filled"),
    (409, _error("already-canceled"), "REJECTED", "already-canceled"),
    (409, _error("already-modified"), "REJECTED", "already-modified"),
    (409, _error("already-rejected"), "REJECTED", "already-rejected"),
    (409, _error("already-processing"), "UNKNOWN", "already-processing"),   # 처리 중 — 잠시 뒤 다시(끝난 거절 아님)
    (409, _error("request-in-progress"), "UNKNOWN", "request-in-progress"),
    (422, _error("cancel-restricted"), "REJECTED", "cancel-restricted"),
    (422, _error("order-hours-closed"), "REJECTED", "order-hours-closed"),
    (429, _error("rate-limit-exceeded"), "REJECTED", "rate-limited"),
    (500, _error("internal-error"), "UNKNOWN", "internal-error"),
]


@pytest.mark.parametrize("status,body,outcome,code", CANCEL_TABLE)
def test_취소_응답도_네_갈래로_나뉜다(enabled, fake, status, body, outcome, code):
    fake.post = lambda path, sent, headers: (status, body)
    result = toss_trade.cancel_order("ord-1")
    assert result == {"outcome": outcome, "cancelOrderId": "cancel-ord-2" if outcome == "ACCEPTED" else None,
                      "code": code, "httpStatus": status}
    posts = fake.posts()
    assert [(c["path"], c["body"]) for c in posts] == [("/api/v1/orders/ord-1/cancel", b"{}")]
    assert posts[0]["headers"][toss.ACCOUNT_HEADER] == "1"


def test_취소의_409_already_processing은_끝난_거절이_아니라_UNKNOWN():
    """토스 스펙의 alreadyProcessing은 '처리 중, 잠시 뒤 다시'(retryAfterSeconds 1) — REJECTED면 백엔드가 그 취소를 다시 보내지 않음."""
    assert toss_trade._classify("cancel", 409, "already-processing") == ("UNKNOWN", "already-processing")
    for code in ("already-filled", "already-canceled", "already-modified", "already-rejected"):
        assert toss_trade._classify("cancel", 409, code) == ("REJECTED", code)
    assert toss_trade._classify("order", 409, "already-processing") == ("UNKNOWN", "already-processing")


@pytest.mark.parametrize("order_id", ["a/b", "../x", "a.b", "", "a" * 129, "a b", f"{CANARY}%2F"])
def test_취소는_주문_번호_형식이_틀리면_보내지_않는다(enabled, fake, order_id):
    result = toss_trade.cancel_order(order_id)
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "invalid-order-id")
    assert fake.sent == []


def test_취소는_창과_한도를_보지_않는다(enabled, fake, clock, monkeypatch):
    clock.now = _at(20, 30)                                      # 장 밖
    monkeypatch.setenv("TOSS_TRADING_MAX_ORDERS_PER_DAY", "1")
    fake.closed = [[_toss_order("c1"), _toss_order("c2")]]
    assert toss_trade.cancel_order("ord-1")["outcome"] == "ACCEPTED"
    assert fake.gets("/api/v1/orders") == [] and fake.gets("/api/v1/market-calendar/KR") == []


# ==============================================================================
# 4. 보내는 본문 — 여섯 칸, 같은 요청이면 같은 바이트
# ==============================================================================
def test_보내는_본문은_여섯_칸뿐이고_헤더는_계좌·토큰·JSON(enabled, fake, clock):
    result = toss_trade.place_order(_payload(clock, quantity=10))      # 정수로 와도 같은 글자
    assert result == {"outcome": "ACCEPTED", "orderId": "ord-1", "code": None, "httpStatus": 200}
    post = fake.posts()[0]
    assert post["path"] == "/api/v1/orders" and post["params"] == {}
    assert post["body"] == _expected_body()
    sent = json.loads(post["body"])
    assert set(sent) == {"clientOrderId", "symbol", "side", "orderType", "timeInForce", "quantity"}
    assert "price" not in sent and "confirmHighValueOrder" not in sent
    assert post["headers"][toss.ACCOUNT_HEADER] == "1"
    assert post["headers"]["Authorization"] == "Bearer tok1"
    assert post["headers"]["Content-Type"] == "application/json"
    assert post["timeout"][0] <= 3 and post["timeout"][1] <= 8


def test_같은_요청을_다시_보내면_같은_키·같은_바이트다(enabled, fake, clock):
    responses = iter([(500, _error("internal-error")), (200, {"result": {"orderId": "ord-1", "clientOrderId": CID}})])
    fake.post = lambda path, body, headers: next(responses)
    payload = _payload(clock, side="SELL", timeInForce="DAY")
    assert toss_trade.place_order(payload)["outcome"] == "UNKNOWN"
    clock.now += timedelta(minutes=2)
    assert toss_trade.place_order(payload)["outcome"] == "ACCEPTED"
    first, second = fake.posts()
    assert first["body"] == second["body"] == _expected_body(side="SELL")


def test_OPG는_시가_단일가_창에서_보낸다(enabled, fake, clock):
    clock.now = _at(8, 52)
    result = toss_trade.place_order(_payload(clock, timeInForce="OPG"))
    assert result["outcome"] == "ACCEPTED"
    assert json.loads(fake.posts()[0]["body"])["timeInForce"] == "OPG"


# ==============================================================================
# 5. 수집기 검사 — 통과하지 못하면 POST 0건
# ==============================================================================
@pytest.mark.parametrize("overrides,code", [
    ({"symbol": "AAPL"}, "invalid-symbol"),
    ({"symbol": "5930"}, "invalid-symbol"),
    ({"symbol": "a05930"}, "invalid-symbol"),
    ({"side": "buy"}, "invalid-side"),
    ({"side": None}, "invalid-side"),
    ({"timeInForce": "CLS"}, "invalid-time-in-force"),
    ({"timeInForce": "GTC"}, "invalid-time-in-force"),
    ({"quantity": "0"}, "invalid-quantity"),
    ({"quantity": "1.5"}, "invalid-quantity"),
    ({"quantity": "-1"}, "invalid-quantity"),
    ({"quantity": "01"}, "invalid-quantity"),
    ({"quantity": "1000000000"}, "invalid-quantity"),
    ({"quantity": True}, "invalid-quantity"),
    ({"quantity": 1.0}, "invalid-quantity"),
    ({"quantity": 0}, "invalid-quantity"),
    ({"clientOrderId": CID[:-1]}, "invalid-client-order-id"),
    ({"clientOrderId": CID[:-1] + "."}, "invalid-client-order-id"),
    ({"clientOrderId": None}, "invalid-client-order-id"),
    ({"firstSentAt": "2026-11-09T10:00:00"}, "invalid-first-sent-at"),
    ({"firstSentAt": "어제"}, "invalid-first-sent-at"),
    ({"firstSentAt": "2026-11-09T09:52:59+09:00"}, "resend-window-passed"),
    ({"firstSentAt": "2026-11-09T10:00:31+09:00"}, "invalid-first-sent-at"),
    ({"price": "70000"}, "invalid-request"),
    ({"confirmHighValueOrder": True}, "invalid-request"),
    ({"orderType": "LIMIT"}, "invalid-request"),
])
def test_형식이_틀리면_보내지_않는다(enabled, fake, clock, overrides, code):
    result = toss_trade.place_order(_payload(clock, **overrides))
    assert result == {"outcome": "NOT_SENT", "orderId": None, "code": code, "httpStatus": None}
    assert fake.posts() == []


@pytest.mark.parametrize("payload", [None, [], "x", 1])
def test_본문이_객체가_아니면_보내지_않는다(enabled, fake, payload):
    assert toss_trade.place_order(payload)["code"] == "invalid-request"
    assert fake.sent == []


@pytest.mark.parametrize("tif,moment,ok", [
    ("DAY", _at(9, 0, 29), False),        # 정규장 시작 + 30초 전
    ("DAY", _at(9, 0, 30), True),
    ("DAY", _at(15, 29, 0), True),        # 끝 1분 전까지
    ("DAY", _at(15, 29, 1), False),
    ("DAY", _at(16, 0), False),           # 정규장 끝 뒤
    ("DAY", _at(8, 30), False),           # NXT 프리마켓 접속매매 시간
    ("OPG", _at(8, 50, 29), False),       # 시가 단일가 시작 + 30초 전
    ("OPG", _at(8, 50, 30), True),
    ("OPG", _at(8, 59, 0), True),
    ("OPG", _at(8, 59, 1), False),        # 프리마켓 끝 1분 전 뒤
    ("OPG", _at(10, 0), False),
])
def test_창_밖이면_보내지_않는다(enabled, fake, clock, tif, moment, ok):
    clock.now = moment
    result = toss_trade.place_order(_payload(clock, timeInForce=tif))
    if ok:
        assert result["outcome"] == "ACCEPTED"
    else:
        assert (result["outcome"], result["code"]) == ("NOT_SENT", "outside-window")
        assert fake.posts() == []


@pytest.mark.parametrize("calendar,tif,moment", [
    (_calendar_body(integrated=False), "DAY", _at(10, 0)),                        # 휴장
    (_calendar_body(pre=False), "OPG", _at(8, 52)),                                # 프리마켓 휴장
    (_calendar_body(auction=False), "OPG", _at(8, 52)),                            # 단일가 시각 결손
    (_calendar_body(regular=("10:00", "16:30")), "DAY", _at(9, 40)),               # 수능일처럼 늦게 열림
    (_calendar_body(day="2026-11-10"), "DAY", _at(10, 0)),                         # 토스의 오늘이 우리 오늘과 다름
])
def test_그날_토스_장_운영_정보로_창을_정한다(enabled, fake, clock, calendar, tif, moment):
    clock.now = moment
    fake.routes["/api/v1/market-calendar/KR"] = (200, calendar)
    result = toss_trade.place_order(_payload(clock, timeInForce=tif))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "outside-window")
    assert fake.posts() == []


def test_시계가_5초_넘게_어긋나면_보내지_않는다(enabled, fake, clock):
    fake.routes["/api/v1/market-calendar/KR"] = lambda params, headers: (
        200, _calendar_body(), {"Date": _http_date(clock.now + timedelta(seconds=7))})
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "clock-skew")
    assert fake.posts() == []


def test_장_운영_정보를_받지_못하면_보내지_않고_실패는_캐시하지_않는다(enabled, fake, clock):
    fake.routes["/api/v1/market-calendar/KR"] = (500, _error("internal-error"))
    assert toss_trade.place_order(_payload(clock))["code"] == "calendar-unavailable"
    fake.routes["/api/v1/market-calendar/KR"] = lambda params, headers: (
        200, _calendar_body(), {"Date": _http_date(clock.now)})
    assert toss_trade.place_order(_payload(clock))["outcome"] == "ACCEPTED"
    assert len(fake.gets("/api/v1/market-calendar/KR")) == 2
    toss_trade.place_order(_payload(clock))
    assert len(fake.gets("/api/v1/market-calendar/KR")) == 2         # 성공은 그날 한 번


@pytest.mark.parametrize("side,quantity,ok", [
    ("BUY", "53", True),      # 상한가 93,600 × 53 = 4,960,800
    ("BUY", "54", False),     # 5,054,400 > 5,000,000
    ("SELL", "69", True),     # 현재가 72,000 × 69 = 4,968,000
    ("SELL", "70", False),    # 5,040,000
])
def test_1건_금액은_수집기가_받은_상한가·현재가로_본다(enabled, fake, clock, side, quantity, ok):
    result = toss_trade.place_order(_payload(clock, side=side, quantity=quantity))
    if ok:
        assert result["outcome"] == "ACCEPTED"
    else:
        assert (result["outcome"], result["code"]) == ("NOT_SENT", "over-order-limit")
        assert fake.posts() == []
    assert len(fake.gets("/api/v1/price-limits" if side == "BUY" else "/api/v1/prices")) >= 1


@pytest.mark.parametrize("route,value", [
    ("/api/v1/price-limits", (500, _error("internal-error"))),
    ("/api/v1/price-limits", (200, {"result": {"timestamp": "x", "upperLimitPrice": None, "currency": "KRW"}})),
    ("/api/v1/price-limits", (200, {"result": {"timestamp": "x", "upperLimitPrice": "1e5", "currency": "KRW"}})),
    ("/api/v1/price-limits", (200, {"result": {"timestamp": "x", "upperLimitPrice": "0", "currency": "KRW"}})),
    ("/api/v1/price-limits", (200, {"result": {"timestamp": "x", "upperLimitPrice": "93600", "currency": "USD"}})),
])
def test_상한가를_받지_못하면_보내지_않는다(enabled, fake, clock, route, value):
    fake.routes[route] = value
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "price-unavailable")
    assert fake.posts() == []


def test_오늘_건수는_토스_목록의_국내_주문으로_센다(enabled, fake, clock, monkeypatch):
    monkeypatch.setenv("TOSS_TRADING_MAX_ORDERS_PER_DAY", "3")
    fake.closed = [[_toss_order("c1"), _toss_order("u1", symbol="AAPL", currency="USD")]]
    fake.open = [_toss_order("o1", status="PENDING", filled="0", avg=None, amount=None),
                 _toss_order("c1")]                                         # 같은 번호는 한 번
    assert toss_trade.place_order(_payload(clock))["outcome"] == "ACCEPTED"   # 국내 2건 < 3
    fake.open.append(_toss_order("o2", side="SELL", status="PENDING", filled="0", avg=None, amount=None))
    result = toss_trade.place_order(_payload(clock, side="SELL"))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "over-daily-orders")
    assert len(fake.posts()) == 1
    params = [c["params"] for c in fake.gets("/api/v1/orders")]
    assert {"status": "OPEN", "from": DAY, "to": DAY} in params
    assert {"status": "CLOSED", "from": DAY, "to": DAY, "limit": "100"} in params


def test_오늘_매수_합은_체결_금액과_진행_중_잔량_곱하기_상한가(enabled, fake, clock, monkeypatch):
    monkeypatch.setenv("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "3000000")
    fake.closed = [[_toss_order("c1", amount="720000"),
                    _toss_order("c2", side="SELL", amount="9999999"),                      # 매도는 세지 않음
                    _toss_order("c3", status="CANCELED", filled="2", avg="70000", amount=None)]]   # 2 × 70,000
    fake.open = [_toss_order("o1", symbol="000660", status="PARTIAL_FILLED", quantity="5", filled="2",
                             avg="180000", amount="360000")]   # 360,000 + 잔량 3 × 상한가 234,000
    # 720,000 + 140,000 + 360,000 + 702,000 = 1,922,000 — 이번 매수 10 × 93,600 = 936,000 → 2,858,000 ≤ 3,000,000
    assert toss_trade.place_order(_payload(clock))["outcome"] == "ACCEPTED"
    result = toss_trade.place_order(_payload(clock, quantity="12"))                # 1,123,200 → 3,045,200
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "over-daily-buy")
    assert toss_trade.place_order(_payload(clock, side="SELL", quantity="12"))["outcome"] == "ACCEPTED"
    assert len(fake.posts()) == 2
    assert {"symbol": "000660"} in [c["params"] for c in fake.gets("/api/v1/price-limits")]


@pytest.mark.parametrize("setup", [
    lambda fake: fake.routes.__setitem__("/api/v1/orders", (500, _error("internal-error", CANARY))),
    lambda fake: fake.routes.__setitem__("/api/v1/orders", (200, {"result": {"orders": None}})),
    lambda fake: fake.routes.__setitem__("/api/v1/orders", (200, {"result": {"orders": ["x"]}})),
    lambda fake: setattr(fake, "closed", [[_toss_order("c1")]] * 6),                         # 쪽 상한(5) 넘음
    lambda fake: fake.routes.__setitem__("/api/v1/orders", lambda params, headers: (
        200, {"result": {"orders": [], "nextCursor": None, "hasNext": params["status"] == "CLOSED"}})),
    lambda fake: setattr(fake, "closed", [[_toss_order("c1", amount=None, avg=None, filled="3")]]),
    lambda fake: setattr(fake, "closed", [[_toss_order("c1", amount="7e5")]]),
    lambda fake: setattr(fake, "open", [_toss_order("o1", symbol="999999", status="PENDING", filled="0",
                                                    avg=None, amount=None)]),                # 상한가 없음
])
def test_오늘을_세지_못하면_보내지_않는다(enabled, fake, clock, setup):
    setup(fake)
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "count-unavailable")
    assert fake.posts() == []


@pytest.mark.xfail(strict=True, reason="QA-350: 봉투 모양이 아닌 오류 본문이면 일반 예외가 올라가 단계 코드 대신 internal로 분류됩니다")
@pytest.mark.parametrize("body", [{"status": 500, "error": "Internal Server Error"}, ["oops"]], ids=["error-글자", "본문-목록"])
def test_QA350_주문_목록이_봉투_밖_오류_본문으로_실패해도_count_unavailable(enabled, fake, clock, body):
    fake.routes["/api/v1/orders"] = (500, body)
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "count-unavailable")
    assert fake.posts() == []


def test_목록이_429면_rate_limited로_보내지_않는다(enabled, fake, clock):
    fake.routes["/api/v1/orders"] = (429, _error("rate-limit-exceeded"))
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "rate-limited")
    assert fake.posts() == []


def test_주문_속도_버킷이_비면_보내지_않는다(enabled, fake, clock, limiter_clock):
    limiter_clock["advance"] = False
    for _ in range(25):                                                     # ORDER 5/초 버킷을 3초 넘게 앞당겨 씀
        toss_ratelimit.acquire("ORDER")
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "rate-limited")
    assert fake.posts() == []


def test_BROKERAGE_계좌가_하나가_아니면_보내지_않는다(enabled, fake, clock):
    fake.routes["/api/v1/accounts"] = (200, {"result": [
        {"accountNo": "12345678901", "accountSeq": 1, "accountType": "BROKERAGE"},
        {"accountNo": "12345678902", "accountSeq": 2, "accountType": "BROKERAGE"}]})
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "account-unavailable")
    assert toss_trade.cancel_order("ord-1")["code"] == "account-unavailable"
    assert fake.posts() == []


def test_토큰을_받지_못하면_보내지_않는다(enabled, fake, clock):
    toss_trade._calendar_view(time.monotonic() + 5)      # 장 운영 정보는 받아 둔 채(토큰 발급 전)
    toss_account.account_seq()
    fake.token_route = lambda: (500, {"error": "server_error"})
    toss._invalidate_token()
    result = toss_trade.cancel_order("ord-1")
    assert (result["outcome"], result["code"]) == ("NOT_SENT", "token-failed")
    assert fake.posts() == []


# ==============================================================================
# 6. 401 — 재발급 대상 세 코드만, 같은 키로 한 번(계좌 조회와 10분 창 공유)
# ==============================================================================
@pytest.mark.parametrize("code", ["expired-token", "token-revoked", "invalid-token"])
def test_401_재발급_뒤_같은_키·같은_본문으로_한_번_더(enabled, fake, clock, code):
    responses = iter([(401, _error(code)), (200, {"result": {"orderId": "ord-1", "clientOrderId": CID}})])
    fake.post = lambda path, body, headers: next(responses)
    result = toss_trade.place_order(_payload(clock))
    assert result["outcome"] == "ACCEPTED"
    first, second = fake.posts()
    assert first["body"] == second["body"] == _expected_body()
    assert (first["headers"]["Authorization"], second["headers"]["Authorization"]) == ("Bearer tok1", "Bearer tok2")
    assert fake.issued == 2
    assert toss_account._reissue_codes() == frozenset()          # 계좌 조회와 같은 10분 창을 썼음


def test_401이_두_번이면_REJECTED(enabled, fake, clock):
    fake.post = lambda path, body, headers: (401, _error("expired-token"))
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"], result["httpStatus"]) == ("REJECTED", "expired-token", 401)
    assert len(fake.posts()) == 2 and fake.issued == 2


@pytest.mark.parametrize("code", ["login-user-not-found", "edge-blocked", None])
def test_재발급_대상이_아닌_401은_다시_보내지_않는다(enabled, fake, clock, code):
    fake.post = lambda path, body, headers: (401, _error(code) if code else NON_JSON)
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("REJECTED", code or "http-401")
    assert len(fake.posts()) == 1 and fake.issued == 1


def test_계좌_조회가_10분_창을_썼으면_재발급하지_않는다(enabled, fake, clock):
    toss_account._note_reissue()
    fake.post = lambda path, body, headers: (401, _error("expired-token"))
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"]) == ("REJECTED", "expired-token")
    assert len(fake.posts()) == 1 and fake.issued == 1


@pytest.mark.parametrize("code", ["expired-token", "token-revoked", "invalid-token"])
def test_취소는_10분_창을_이미_썼어도_재발급_대상_401이면_한_번_다시_받아_같은_본문으로_보낸다(enabled, fake, code):
    """
    토큰 경합(token-contention) 이상 멈춤 때는 읽기 경로의 401이 10분 창을 이미 썼고, 캐시에는 무효가 된 토큰이 남아 있다.
    창을 따르면 멈춤 직후의 취소가 401로만 끝나 시가·종가 단일가의 미체결 주문이 살아 남는다.
    """
    with toss._lock:
        toss._token_cache = ("tok-stale", time.time() + 3600)        # 캐시에 남은 무효 토큰(밖에서 같은 키로 받음)
    toss_account._note_reissue()                                      # 읽기 경로가 10분 창을 이미 씀
    fake.post = lambda path, body, headers: (
        (401, _error(code)) if headers["Authorization"] == "Bearer tok-stale"
        else (200, {"result": {"orderId": "cancel-ord-2"}}))
    result = toss_trade.cancel_order("ord-1")
    assert result == {"outcome": "ACCEPTED", "cancelOrderId": "cancel-ord-2", "code": None, "httpStatus": 200}
    posts = fake.posts()
    assert [(p["path"], p["body"]) for p in posts] == [("/api/v1/orders/ord-1/cancel", b"{}")] * 2
    assert [p["headers"]["Authorization"] for p in posts] == ["Bearer tok-stale", "Bearer tok1"]
    assert fake.issued == 1


def test_취소도_재발급_대상이_아닌_401은_다시_받지_않는다(enabled, fake):
    toss_account._note_reissue()
    fake.post = lambda path, body, headers: (401, _error("login-user-not-found"))
    result = toss_trade.cancel_order("ord-1")
    assert (result["outcome"], result["code"], result["httpStatus"]) == ("REJECTED", "login-user-not-found", 401)
    assert len(fake.posts()) == 1 and fake.issued == 1


def test_다른_곳이_새_토큰을_받아_뒀으면_발급_없이_한_번_더_보내고_창을_쓰지_않는다(enabled, fake, clock):
    state = {"first": True}

    def post(path, body, headers):
        if state["first"]:
            state["first"] = False
            with toss._lock:
                toss._token_cache = ("tok-other", time.time() + 3600)
            return 401, _error("token-revoked")
        return 200, {"result": {"orderId": "ord-1", "clientOrderId": CID}}

    fake.post = post
    assert toss_trade.place_order(_payload(clock))["outcome"] == "ACCEPTED"
    assert [p["headers"]["Authorization"] for p in fake.posts()] == ["Bearer tok1", "Bearer tok-other"]
    assert fake.issued == 1 and toss_account._state.last_reissue is None


def test_두_번째를_보낼_수_없으면_첫_401을_REJECTED로(enabled, fake, clock):
    responses = iter([(401, _error("expired-token"))])
    fake.post = lambda path, body, headers: next(responses)
    issued = {"n": 0}

    def token():
        issued["n"] += 1
        if issued["n"] == 1:
            return 200, {"access_token": "tok1", "expires_in": 3600}
        return 500, {"error": "server_error"}

    fake.token_route = token
    result = toss_trade.place_order(_payload(clock))
    assert (result["outcome"], result["code"], result["httpStatus"]) == ("REJECTED", "expired-token", 401)
    assert len(fake.posts()) == 1


def test_10분_안에_token_revoked를_2번_넘게_보면_tokenContention(enabled, fake, clock, monkeypatch):
    mono = {"now": 50_000.0}
    monkeypatch.setattr(toss_trade, "_monotonic", lambda: mono["now"])
    fake.post = lambda path, body, headers: (401, _error("token-revoked"))
    toss_trade.place_order(_payload(clock))                 # 두 번 봄(재발급 뒤에도 401)
    assert toss_trade.status()["tokenContention"] is False
    toss_trade.place_order(_payload(clock))                 # 창을 썼으니 한 번 — 모두 세 번
    assert toss_trade.status()["tokenContention"] is True
    mono["now"] += 10 * 60 + 1
    assert toss_trade.status()["tokenContention"] is False


def test_읽기의_token_revoked도_센다(enabled, fake, clock):
    fake.routes["/api/v1/orders"] = (401, _error("token-revoked"))
    for _ in range(3):
        assert toss_trade.open_orders()["reason"] == "auth-failed"
    assert toss_trade.status()["tokenContention"] is True


# ==============================================================================
# 7. 누출 — 토스 message·본문·accountSeq(카나리)
# ==============================================================================
def test_토스_오류_message와_본문·accountSeq는_응답과_로그에_없다(enabled, fake, clock, caplog):
    caplog.set_level(logging.DEBUG)
    accounts = _fixture("account_accounts.json")
    accounts["result"][0]["accountSeq"] = 987654321
    fake.routes["/api/v1/accounts"] = (200, accounts)
    fake.post = lambda path, body, headers: (422, {"error": {
        "requestId": CANARY, "code": "insufficient-buying-power", "message": f"{CANARY} 12345678901",
        "data": {"x": CANARY}}})
    results = [toss_trade.place_order(_payload(clock))]
    fake.post = lambda path, body, headers: (500, {"error": {"code": f"{CANARY} Not A Code", "message": CANARY}})
    results.append(toss_trade.place_order(_payload(clock)))
    results.append(toss_trade.cancel_order("ord-1"))
    fake.routes["/api/v1/orders"] = (500, {"error": {"code": "internal-error", "message": f"{CANARY} 12345678901"}})
    results.append(toss_trade.open_orders())
    results.append(toss_trade.today_orders())
    text = json.dumps(results, ensure_ascii=False)
    assert results[0]["code"] == "insufficient-buying-power" and results[1]["code"] == "http-500"
    for needle in (CANARY, "12345678901", "987654321", "accountSeq", "accountNo"):
        assert needle not in text, needle
        assert needle not in caplog.text, needle
    assert {p["headers"][toss.ACCOUNT_HEADER] for p in fake.posts()} == {"987654321"}   # 헤더로만 씀


def test_주문_번호는_백엔드에_돌려주되_로그에는_없다(enabled, fake, clock, caplog):
    caplog.set_level(logging.DEBUG)
    fake.post = lambda path, body, headers: (200, {"result": {"orderId": f"{CANARY}-ord", "clientOrderId": CID}})
    assert toss_trade.place_order(_payload(clock))["orderId"] == f"{CANARY}-ord"
    assert toss_trade.cancel_order(f"{CANARY}-ord")["cancelOrderId"] == f"{CANARY}-ord"
    assert CANARY not in caplog.text and CID not in caplog.text
    assert "ACCEPTED" in caplog.text


# ==============================================================================
# 8. 스위치·한도 해석 — 꺼져 있으면 토스를 부르지 않고 쓰기 세션도 없음
# ==============================================================================
@pytest.mark.parametrize("value", [None, "", "false", "TRUE", "True", "1", "yes", "on", "true1"])
def test_TOSS_TRADING_ENABLED는_정확한_true만_켠다(enabled, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("TOSS_TRADING_ENABLED")
    else:
        monkeypatch.setenv("TOSS_TRADING_ENABLED", value)
    assert settings.toss_trading_switch() is False
    assert settings.toss_trading_disabled_reason() == "disabled"
    monkeypatch.setenv("TOSS_TRADING_ENABLED", "  true \n")
    assert settings.toss_trading_disabled_reason() is None


def test_스위치는_secrets_toml을_보지_않는다(enabled, monkeypatch):
    monkeypatch.delenv("TOSS_TRADING_ENABLED")
    monkeypatch.setattr(settings, "_load_secrets_file", lambda: {"toss": {"trading_enabled": "true"},
                                                                  "TOSS_TRADING_ENABLED": "true"})
    assert settings.toss_trading_disabled_reason() == "disabled"


def test_꺼진_사유의_순서(enabled, monkeypatch):
    assert settings.toss_trading_disabled_reason() is None
    monkeypatch.setenv("TOSS_TRADING_MAX_EQUITY_KRW", "x")
    assert settings.toss_trading_disabled_reason() == "limits-invalid"
    monkeypatch.delenv("COLLECTOR_API_TOKEN")
    assert settings.toss_trading_disabled_reason() == "no-service-token"
    monkeypatch.setenv("TOSS_ACCOUNT_ENABLED", "false")
    assert settings.toss_trading_disabled_reason() == "account-disabled"
    monkeypatch.setenv("TOSS_TRADING_ENABLED", "false")
    assert settings.toss_trading_disabled_reason() == "disabled"


@pytest.mark.parametrize("name,value,valid", [
    ("TOSS_TRADING_MAX_ORDER_KRW", "99999999", True),
    ("TOSS_TRADING_MAX_ORDER_KRW", "100000000", False),       # 1억 이상은 확인 플래그가 필요 — 받지 않음
    ("TOSS_TRADING_MAX_ORDER_KRW", "0", False),
    ("TOSS_TRADING_MAX_ORDER_KRW", " 1 ", True),
    ("TOSS_TRADING_MAX_ORDERS_PER_DAY", "200", True),
    ("TOSS_TRADING_MAX_ORDERS_PER_DAY", "201", False),
    ("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "1", True),
    ("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "-1", False),
    ("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "+5", False),
    ("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "1.5", False),
    ("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "1_000", False),
    ("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "1e6", False),
    ("TOSS_TRADING_MAX_BUY_KRW_PER_DAY", "１２", False),        # 전각 숫자
    ("TOSS_TRADING_MAX_EQUITY_KRW", "", False),
    ("TOSS_TRADING_MAX_EQUITY_KRW", None, False),
    ("TOSS_TRADING_MAX_EQUITY_KRW", "1" * 16, False),
])
def test_한도는_네_값이_모두_범위_안의_정수일_때만(enabled, monkeypatch, name, value, valid):
    if value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, value)
    limits = settings.toss_trading_limits()
    assert (limits is not None) is valid
    assert settings.toss_trading_disabled_reason() == (None if valid else "limits-invalid")
    if valid:
        assert set(limits) == {"maxOrderKrw", "maxOrdersPerDay", "maxBuyKrwPerDay", "maxEquityKrw"}


@pytest.mark.parametrize("reason,setup", [
    ("disabled", lambda mp: mp.delenv("TOSS_TRADING_ENABLED")),
    ("account-disabled", lambda mp: mp.setenv("TOSS_ACCOUNT_ENABLED", "false")),
    ("no-service-token", lambda mp: mp.delenv("COLLECTOR_API_TOKEN")),
    ("limits-invalid", lambda mp: mp.delenv("TOSS_TRADING_MAX_ORDER_KRW")),
])
def test_꺼져_있으면_어느_경로도_토스를_부르지_않고_쓰기_세션을_만들지_않는다(enabled, fake, clock, monkeypatch,
                                                                               reason, setup):
    setup(monkeypatch)
    monkeypatch.delitem(app_http._sessions, toss_trade.SESSION_NAME, raising=False)
    assert toss_trade.place_order(_payload(clock)) == {"outcome": "NOT_SENT", "orderId": None, "code": reason,
                                                       "httpStatus": None}
    assert toss_trade.cancel_order("ord-1")["code"] == reason
    for body in (toss_trade.calendar(), toss_trade.warmup(), toss_trade.preflight("005930", ""),
                 toss_trade.open_orders(), toss_trade.today_orders(), toss_trade.order_detail("ord-1")):
        assert (body["ok"], body["enabled"], body["reason"]) == (False, False, reason)
    status = toss_trade.status()
    assert (status["ok"], status["enabled"], status["reason"]) == (True, False, reason)
    assert fake.sent == []
    assert toss_trade.SESSION_NAME not in app_http._sessions


def test_상태는_한도·토큰_경합·서버_시각을_싣고_토스를_부르지_않는다(enabled, fake, clock):
    assert toss_trade.status() == {
        "ok": True, "enabled": True, "reason": None,
        "limits": {"maxOrderKrw": 5_000_000, "maxOrdersPerDay": 50, "maxBuyKrwPerDay": 20_000_000,
                   "maxEquityKrw": 100_000_000},
        "tokenContention": False, "serverTime": "2026-11-09T10:00:00.000+09:00",
    }
    assert fake.sent == []


# ==============================================================================
# 9. 장 운영 정보·미리 받기·사전 조회·주문 조회
# ==============================================================================
def test_장_운영_정보는_정리해서_날짜마다_한_번(enabled, fake, clock):
    body = toss_trade.calendar()
    assert body == {
        "ok": True, "date": DAY, "skewSeconds": 0.0,
        "today": {
            "preMarket": {"start": f"{DAY}T08:00:00+09:00", "auctionStart": f"{DAY}T08:50:00+09:00",
                          "end": f"{DAY}T09:00:00+09:00"},
            "regular": {"start": f"{DAY}T09:00:00+09:00", "closingAuctionStart": f"{DAY}T15:20:00+09:00",
                        "end": f"{DAY}T15:30:00+09:00"},
        },
        "previousBusinessDay": "2026-11-06", "nextBusinessDay": "2026-11-10",
    }
    assert toss_trade.calendar() == body
    assert len(fake.gets("/api/v1/market-calendar/KR")) == 1
    clock.now = _at(10, 0, day="2026-11-10")                        # 날이 바뀌면 다시 받음
    toss_trade.calendar()
    assert len(fake.gets("/api/v1/market-calendar/KR")) == 2


def test_장_운영_정보의_휴장·Date_없음·형식_오류(enabled, fake, clock):
    fake.routes["/api/v1/market-calendar/KR"] = (200, _calendar_body(integrated=False))
    body = toss_trade.calendar()
    assert (body["ok"], body["today"], body["skewSeconds"]) == (True, None, None)
    toss_trade.reset_for_tests()
    broken = _calendar_body()
    broken["result"]["today"]["integrated"]["regularMarket"]["endTime"] = f"{DAY}T08:00:00+09:00"   # 끝이 시작보다 앞
    fake.routes["/api/v1/market-calendar/KR"] = (200, broken)
    assert toss_trade.calendar() == {"ok": False, "enabled": True, "reason": "upstream-error", "code": None}


def test_미리_받기는_남은_시간이_30분_미만일_때만_새로_받고_10분_창을_쓰지_않는다(enabled, fake):
    assert toss_trade.warmup() == {"ok": True, "tokenRefreshed": True}           # 캐시가 비어 있음
    assert fake.issued == 1
    assert toss_trade.warmup() == {"ok": True, "tokenRefreshed": False}          # 남은 시간 충분
    with toss._lock:
        toss._token_cache = ("tok1", time.time() + 29 * 60)
    assert toss_trade.warmup() == {"ok": True, "tokenRefreshed": True}
    assert fake.issued == 2 and toss._token_cache[0] == "tok2"
    assert toss_account._state.last_reissue is None
    fake.token_route = lambda: (500, {"error": "server_error", "error_description": CANARY})
    with toss._lock:
        toss._token_cache = ("tok2", time.time() + 60)
    body = toss_trade.warmup()
    assert body == {"ok": False, "enabled": True, "reason": "token-failed", "tokenRefreshed": False}


def test_미리_받기의_발급이_실패해도_옛_토큰을_버리지_않고_그_토큰으로_주문이_나간다(enabled, fake, clock, caplog):
    caplog.set_level(logging.DEBUG)
    with toss._lock:
        toss._token_cache = ("tok-old", time.time() + 20 * 60)        # 남은 20분 — 미리 받기 대상이지만 아직 유효
    fake.token_route = lambda: (500, {"error": "server_error", "error_description": CANARY})
    body = toss_trade.warmup()
    assert body == {"ok": False, "enabled": True, "reason": "token-failed", "tokenRefreshed": False}
    assert len([c for c in fake.sent if c["path"] == "/oauth2/token"]) == 1        # 발급은 시도했음
    assert toss._token_cache[0] == "tok-old"
    result = toss_trade.place_order(_payload(clock))
    assert result == {"outcome": "ACCEPTED", "orderId": "ord-1", "code": None, "httpStatus": 200}
    assert [p["headers"]["Authorization"] for p in fake.posts()] == ["Bearer tok-old"]
    assert len([c for c in fake.sent if c["path"] == "/oauth2/token"]) == 1        # 주문 때 다시 발급하지 않음
    assert CANARY not in caplog.text


def test_다시_받기는_기다리는_동안_다른_곳이_받은_새_토큰을_무효로_만들지_않는다(fake):
    with toss._lock:
        toss._token_cache = ("tok-other", time.time() + 3600)         # 미리 받기 전에 본 토큰(tok-old)이 이미 바뀜
    assert toss.refresh_token(stale="tok-old") == ("tok-other", None)
    assert fake.issued == 0
    assert toss.refresh_token(stale="tok-other") == ("tok1", None)    # 아직 그 토큰이면 새로 받음
    assert fake.issued == 1 and toss._token_cache[0] == "tok1"


def test_사전_조회는_새로_읽은_원화_보유·시세·매도_가능_수량(enabled, fake, clock):
    body = toss_trade.preflight("005930,069500", "005930")
    assert body == {
        "ok": True, "fetchedAt": "2026-11-09T10:00:00+09:00", "cashBuyingPowerKrw": "5000000",
        "holdings": [{"symbol": "005930", "name": "삼성전자", "quantity": "100", "lastPrice": "72000"}],
        "quotes": {
            "005930": {"lastPrice": "72000", "upperLimitPrice": "93600", "lowerLimitPrice": "50400"},
            "069500": {"lastPrice": "35000", "upperLimitPrice": "45500", "lowerLimitPrice": "50400"},
        },
        "sellable": {"005930": "100"},
    }
    toss_trade.preflight("069500", "")
    assert len(fake.gets("/api/v1/holdings")) == 2                  # 캐시 없음
    assert {c["params"]["currency"] for c in fake.gets("/api/v1/buying-power")} == {"KRW"}
    assert fake.gets("/api/v1/prices")[-1]["params"] == {"symbols": "069500,005930"}   # 보유 종목도 함께


@pytest.mark.parametrize("route", ["/api/v1/holdings", "/api/v1/buying-power", "/api/v1/prices",
                                   "/api/v1/price-limits", "/api/v1/sellable-quantity"])
def test_사전_조회는_하나라도_실패하면_부분_값_없이_ok_false(enabled, fake, clock, route):
    fake.routes[route] = (500, _error("internal-error", CANARY))
    body = toss_trade.preflight("005930", "005930")
    assert body == {"ok": False, "enabled": True, "reason": "upstream-error", "code": "internal-error"}


@pytest.mark.parametrize("symbols,sell", [("AAPL", ""), ("005930", "../x"), (",".join(f"{n:06d}" for n in range(101)), "")])
def test_사전_조회의_종목_형식이_틀리면_부르지_않는다(enabled, fake, symbols, sell):
    assert toss_trade.preflight(symbols, sell)["reason"] == "invalid-request"
    assert fake.sent == []


def _many(count: int, start: int = 100000) -> list[str]:
    return [f"{start + n:06d}" for n in range(count)]


@pytest.fixture
def slow_toss(monkeypatch, fake, limiter_clock):
    """
    속도 조절 버킷과 같은 가짜 시계로 — 토스 호출마다 0.1초 지연을 더하고, 수집기의 예산 시계도 그 시계를 씁니다.
    돌려주는 함수는 그 종목들을 국내 보유로 두고 시세를 채웁니다.
    """
    monkeypatch.setattr(toss_trade, "_monotonic", lambda: limiter_clock["now"])

    def send(adapter, request, *args, **kwargs):
        limiter_clock["now"] += 0.1
        return fake.send(request, kwargs)

    monkeypatch.setattr(HTTPAdapter, "send", send)

    def hold(symbols: list[str]) -> None:
        fake.routes["/api/v1/holdings"] = (200, {"result": {"items": [
            {"symbol": symbol, "name": None, "marketCountry": "KR", "currency": "KRW", "quantity": "10",
             "lastPrice": "10000"} for symbol in symbols]}})
        for symbol in symbols:
            fake.last[symbol], fake.upper[symbol] = "10000", "13000"

    return hold


PREFLIGHT_INVALID = {"ok": False, "enabled": True, "reason": "invalid-request", "code": None}


def test_사전_조회_예산은_종목_수에_맞춰_늘어_40종목_매도도_끝난다(enabled, clock, fake, slow_toss, limiter_clock):
    """책 20종목 + 다른 보유 20종목. 매도 가능 수량(2/초)만으로 19초 넘게 걸려 예전 고정 20초 예산은 늘 시간이 모자랐다."""
    symbols = _many(40)
    slow_toss(symbols)
    started = limiter_clock["now"]
    body = toss_trade.preflight(",".join(symbols), ",".join(symbols))
    elapsed = limiter_clock["now"] - started
    assert body["ok"] is True, body
    assert len(body["quotes"]) == 40 and len(body["sellable"]) == 40
    assert 20 < elapsed <= toss_trade.PREFLIGHT_MAX_BUDGET_SECONDS, elapsed
    assert toss_trade.PREFLIGHT_MAX_BUDGET_SECONDS < 40          # 백엔드 사전 조회 읽기 시간 초과(40초) 안


def test_사전_조회는_예산_안에_끝나지_않을_목록을_토스를_부르기_전에_거절한다(enabled, clock, fake, slow_toss, caplog):
    caplog.set_level(logging.DEBUG)
    symbols = _many(41)
    slow_toss(symbols)
    assert toss_trade.preflight(",".join(symbols), ",".join(symbols)) == PREFLIGHT_INVALID
    assert fake.sent == []
    assert "사전 조회 거절" in caplog.text and symbols[0] not in caplog.text    # 종목 수만 남기고 코드는 싣지 않음


def test_사전_조회는_보유를_더해_넘치면_시세·매도_가능_수량을_묻기_전에_거절한다(enabled, clock, fake, slow_toss):
    held = _many(70)
    slow_toss(held)
    assert toss_trade.preflight("005930", ",".join(held[:40])) == PREFLIGHT_INVALID
    assert len(fake.gets("/api/v1/holdings")) == 1
    for path in ("/api/v1/prices", "/api/v1/price-limits", "/api/v1/sellable-quantity"):
        assert fake.gets(path) == [], path


def test_사전_조회는_종목이_적으면_예전처럼_20초_예산을_쓴다():
    assert toss_trade._preflight_budget(0, 1) == toss_trade.PREFLIGHT_MIN_BUDGET_SECONDS == 20
    assert toss_trade._preflight_budget(40, 40) == toss_trade.PREFLIGHT_MAX_BUDGET_SECONDS


def test_진행_중_주문은_국내만_정리한_칸으로(enabled, fake, clock):
    fake.open = [_toss_order("o1", status="PENDING", filled="0", avg=None, amount=None),
                 _toss_order("o2", symbol="AAPL", currency="USD", status="PENDING")]
    body = toss_trade.open_orders()
    assert body["ok"] is True and [o["orderId"] for o in body["orders"]] == ["o1"]
    assert set(body["orders"][0]) == {name for name, _ in toss_trade.ORDER_VIEW_FIELDS}
    assert body["orders"][0]["filledQuantity"] == "0" and body["orders"][0]["averageFilledPrice"] is None
    assert CANARY not in json.dumps(body)                               # 모르는 칸은 버림
    assert fake.gets("/api/v1/orders")[0]["params"] == {"status": "OPEN"}


def test_오늘_주문은_진행_중과_끝남을_합치고_같은_번호는_끝난_쪽(enabled, fake, clock):
    fake.closed = [[_toss_order("c1")], [_toss_order("c2", status="CANCELED", filled="0", avg=None, amount=None)]]
    fake.open = [_toss_order("c2", status="PENDING_CANCEL"), _toss_order("o1", status="PENDING", filled="0",
                                                                         avg=None, amount=None)]
    body = toss_trade.today_orders()
    assert [(o["orderId"], o["status"]) for o in body["orders"]] == [("c1", "FILLED"), ("c2", "CANCELED"),
                                                                      ("o1", "PENDING")]
    assert [c["params"].get("cursor") for c in fake.gets("/api/v1/orders")
            if c["params"]["status"] == "CLOSED"] == [None, "1"]


def test_주문_하나_조회(enabled, fake, clock):
    fake.details["ord-1"] = _toss_order("ord-1")
    body = toss_trade.order_detail("ord-1")
    assert body["ok"] is True and body["order"]["orderId"] == "ord-1" and body["order"]["filledAmount"] == "720000"
    assert fake.gets("/api/v1/orders/ord-1")[0]["headers"][toss.ACCOUNT_HEADER] == "1"
    missing = toss_trade.order_detail("ord-9")
    assert missing == {"ok": False, "enabled": True, "reason": "not-found", "code": "order-not-found"}
    assert toss_trade.order_detail("a/b")["reason"] == "invalid-order-id"
    assert len(fake.gets()) == 3                                         # accounts + 두 번의 조회


# ==============================================================================
# 10. accountSeq·속도 조절 — 계좌 조회와 나눠 씀
# ==============================================================================
def test_accountSeq는_계좌_조회가_찾은_값을_다시_쓴다(enabled, fake, clock):
    assert toss_account.get_account()["ok"] is True
    assert toss_trade.place_order(_payload(clock))["outcome"] == "ACCEPTED"
    assert len(fake.gets("/api/v1/accounts")) == 1


def test_account_not_found면_한_번_다시_찾아_다시_부른다(enabled, fake, clock):
    seqs = iter([1, 2])
    fake.routes["/api/v1/accounts"] = lambda params, headers: (
        200, {"result": [{"accountNo": "12345678901", "accountSeq": next(seqs), "accountType": "BROKERAGE"}]})

    def orders(params, headers):
        if headers[toss.ACCOUNT_HEADER] == "1":
            return 404, _error("account-not-found")
        return 200, {"result": {"orders": [], "nextCursor": None, "hasNext": False}}

    fake.routes["/api/v1/orders"] = orders
    assert toss_trade.open_orders() == {"ok": True, "orders": []}
    assert [c["headers"][toss.ACCOUNT_HEADER] for c in fake.gets("/api/v1/orders")] == ["1", "2"]
    assert toss_account.account_seq() == 2


def test_account_seq는_한_번에_하나만_찾는다(enabled, fake):
    def slow(params, headers):
        time.sleep(0.05)
        return 200, _fixture("account_accounts.json")

    fake.routes["/api/v1/accounts"] = slow
    results: list[int] = []
    threads = [threading.Thread(target=lambda: results.append(toss_account.account_seq())) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [1, 1, 1, 1]
    assert len(fake.gets("/api/v1/accounts")) == 1
    with pytest.raises(toss_account.AccountUnavailable):
        fake.routes["/api/v1/accounts"] = (200, {"result": []})
        toss_account.account_seq(stale=1)


def test_속도_조절_그룹은_스펙의_Rate_Limits_Group대로():
    cases = {
        ("POST", "/api/v1/orders"): "ORDER",
        ("POST", "/api/v1/orders/x/cancel"): "ORDER",
        ("GET", "/api/v1/orders"): "ORDER_HISTORY",
        ("GET", "/api/v1/orders/x"): "ORDER_HISTORY",
        ("GET", "/api/v1/buying-power"): "ORDER_INFO",
        ("GET", "/api/v1/sellable-quantity"): "ORDER_INFO",
        ("GET", "/api/v1/holdings"): "ASSET",
        ("GET", "/api/v1/prices"): "MARKET_DATA",
        ("GET", "/api/v1/price-limits"): "MARKET_DATA",
        ("GET", "/api/v1/stocks/005930/warnings"): "STOCK",
        ("GET", "/api/v1/accounts"): None,
        ("GET", "/api/v1/market-calendar/KR"): None,
    }
    assert {key: toss_ratelimit.group_for(*key) for key in cases} == cases
    assert toss_ratelimit.RATES == {"ORDER": 5.0, "ORDER_HISTORY": 3.0, "ORDER_INFO": 2.0, "ASSET": 3.0,
                                    "MARKET_DATA": 8.0, "STOCK": 3.0}


def test_버킷은_비면_기다리고_3초를_넘기면_쓰지_않는다(limiter_clock):
    assert all(toss_ratelimit.acquire("ORDER_INFO") for _ in range(2))
    assert limiter_clock["sleeps"] == []
    assert toss_ratelimit.acquire("ORDER_INFO") is True
    assert limiter_clock["sleeps"] == [0.5]
    limiter_clock["advance"] = False
    granted = [toss_ratelimit.acquire("ORDER_INFO") for _ in range(8)]
    assert granted == [True] * 6 + [False] * 2                         # 다음 토큰까지 3초를 넘기면 거절
    assert toss_ratelimit.acquire("ORDER_INFO", max_wait=0) is False
    assert toss_ratelimit.acquire(None) is True and toss_ratelimit.acquire("ACCOUNT") is True


def test_계좌_조회도_같은_버킷을_쓴다(fake, limiter_clock, monkeypatch):
    monkeypatch.setenv("TOSS_ACCOUNT_ENABLED", "true")
    limiter_clock["advance"] = False
    while toss_ratelimit.acquire("ORDER_INFO"):                         # 매매 쪽이 ORDER_INFO를 다 씀
        pass
    body = toss_account.get_account()
    assert (body["ok"], body["reason"]) == (False, "rate-limited")
    assert fake.gets("/api/v1/buying-power") == []                      # 보내지 않음
    assert [c["path"] for c in fake.gets()] == ["/api/v1/accounts", "/api/v1/holdings"]


# ==============================================================================
# 11. 수집기 경로 /toss/trading/*
# ==============================================================================
@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "test-token")
    return TestClient(main.app, raise_server_exceptions=False)


HEADERS = {"X-Service-Token": "test-token"}


def test_경로는_서비스_토큰을_검사하고_켜져_있으면_답한다(client, enabled, fake, clock):
    assert client.get("/toss/trading/status").status_code == 401
    assert client.post("/toss/trading/orders", json=_payload(clock)).status_code == 401
    status = client.get("/toss/trading/status", headers=HEADERS).json()
    assert (status["ok"], status["enabled"]) == (True, True)
    placed = client.post("/toss/trading/orders", json=_payload(clock), headers=HEADERS)
    assert placed.status_code == 200 and placed.json() == {"outcome": "ACCEPTED", "orderId": "ord-1", "code": None,
                                                           "httpStatus": 200}
    canceled = client.post("/toss/trading/orders/ord-1/cancel", headers=HEADERS).json()
    assert (canceled["outcome"], canceled["cancelOrderId"]) == ("ACCEPTED", "cancel-ord-2")
    assert client.get("/toss/trading/calendar", headers=HEADERS).json()["date"] == DAY
    assert client.post("/toss/trading/warmup", headers=HEADERS).json()["ok"] is True
    assert client.get("/toss/trading/preflight?symbols=005930&sell=", headers=HEADERS).json()["ok"] is True
    assert client.get("/toss/trading/orders/open", headers=HEADERS).json() == {"ok": True, "orders": []}
    assert client.get("/toss/trading/orders/today", headers=HEADERS).json() == {"ok": True, "orders": []}
    assert client.get("/toss/trading/orders/ord-9", headers=HEADERS).json()["reason"] == "not-found"


@pytest.mark.parametrize("raw", [b"{not json", b"", b"[1, 2]", "{\"symbol\": \"\xff\"}".encode("latin-1")])
def test_주문_본문이_JSON_객체가_아니면_200_NOT_SENT(client, enabled, fake, raw):
    response = client.post("/toss/trading/orders", content=raw, headers={**HEADERS, "Content-Type": "application/json"})
    assert response.status_code == 200
    assert response.json() == {"outcome": "NOT_SENT", "orderId": None, "code": "invalid-request", "httpStatus": None}
    assert fake.sent == []


def test_서비스_토큰_없이_뜬_수집기는_토스를_부르지_않는다(enabled, fake, clock, monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "")
    client = TestClient(main.app)
    expected = {"ok": False, "enabled": False, "reason": "no-service-token"}
    for path in ("/toss/trading/status", "/toss/trading/calendar", "/toss/trading/preflight?symbols=005930",
                 "/toss/trading/orders/open", "/toss/trading/orders/today", "/toss/trading/orders/ord-1"):
        assert client.get(path).json() == expected, path
    assert client.post("/toss/trading/warmup").json() == expected
    placed = client.post("/toss/trading/orders", json=_payload(clock)).json()
    assert placed == {**expected, "outcome": "NOT_SENT", "orderId": None, "code": "no-service-token",
                      "httpStatus": None}
    canceled = client.post("/toss/trading/orders/ord-1/cancel").json()
    assert (canceled["outcome"], canceled["cancelOrderId"], canceled["code"]) == ("NOT_SENT", None,
                                                                                  "no-service-token")
    assert fake.sent == []


def test_경로_안의_예상_못_한_예외는_주문이면_UNKNOWN·조회면_internal(client, enabled, fake, clock, monkeypatch,
                                                                     caplog):
    caplog.set_level(logging.DEBUG)

    def boom(*args):
        raise RuntimeError(f"{CANARY} 12345678901")

    for name in ("place_order", "cancel_order", "open_orders"):
        monkeypatch.setattr(toss_trade, name, boom)
    placed = client.post("/toss/trading/orders", json=_payload(clock), headers=HEADERS)
    assert placed.status_code == 200
    assert placed.json() == {"outcome": "UNKNOWN", "orderId": None, "code": "internal", "httpStatus": None}
    canceled = client.post("/toss/trading/orders/ord-1/cancel", headers=HEADERS).json()
    assert (canceled["outcome"], canceled["code"]) == ("UNKNOWN", "internal")
    assert client.get("/toss/trading/orders/open", headers=HEADERS).json() == {"ok": False, "enabled": True,
                                                                               "reason": "internal"}
    assert CANARY not in caplog.text and "RuntimeError" in caplog.text


# ==============================================================================
# 매매 제한 조회(VI·지수 등락률) — 읽기만
# ==============================================================================
def _restriction_routes(fake, *, kospi="2300", kosdaq="800", day="2026-11-09") -> None:
    fake.routes["/api/v1/market-indicators/prices"] = (200, {"result": [
        {"symbol": "KOSPI", "timestamp": f"{day}T10:00:00+09:00", "lastPrice": kospi},
        {"symbol": "KOSDAQ", "timestamp": f"{day}T10:00:00+09:00", "lastPrice": kosdaq}]})
    for symbol, close in (("KOSPI", "2500"), ("KOSDAQ", "800")):
        fake.routes[f"/api/v1/market-indicators/{symbol}/candles"] = (200, {"result": {"candles": [
            {"timestamp": f"{day}T09:00:00+09:00", "closePrice": "1"},
            {"timestamp": "2026-11-06T09:00:00+09:00", "closePrice": close}]}})


@pytest.fixture
def clean_index_cache():
    toss_trade._index_prev_close.clear()
    yield
    toss_trade._index_prev_close.clear()


def test_매매_제한은_진행_중인_VI만_세고_지수는_전_거래일_종가와_견준다(enabled, fake, clock, clean_index_cache):
    _restriction_routes(fake)
    fake.routes["/api/v1/stocks/005930/warnings"] = (200, {"result": [
        {"warningType": "VI_DYNAMIC", "exchange": "KRX", "startDate": "2026-11-09", "endDate": None}]})
    fake.routes["/api/v1/stocks/000660/warnings"] = (200, {"result": [
        {"warningType": "VI_STATIC", "exchange": "KRX", "startDate": "2026-11-09", "endDate": "2026-11-09"},
        {"warningType": "OVERHEATED", "exchange": "KRX", "startDate": "2026-11-09", "endDate": None},
        {"warningType": "VI_DYNAMIC", "exchange": "KRX", "startDate": "2026-11-06", "endDate": None}]})
    fake.routes["/api/v1/stocks/035420/warnings"] = (200, {"result": []})
    body = toss_trade.restrictions("005930,000660,035420")
    assert body["ok"] is True and body["viActive"] == ["005930"] and body["unknown"] == []
    assert body["indexChangePct"]["KOSPI"] == pytest.approx(-8.0)
    assert body["indexChangePct"]["KOSDAQ"] == pytest.approx(0.0)
    toss_trade.restrictions("035420")
    assert len(fake.gets("/api/v1/market-indicators/KOSPI/candles")) == 1            # 전 거래일 종가는 날짜마다 캐시
    assert not fake.posts()


def test_매매_제한은_못_읽은_종목만_unknown으로_두고_지수_실패도_막지_않는다(enabled, fake, clock, clean_index_cache):
    fake.routes["/api/v1/market-indicators/prices"] = (500, _error("internal-error", CANARY))
    fake.routes["/api/v1/stocks/005930/warnings"] = (500, _error("internal-error", CANARY))
    fake.routes["/api/v1/stocks/000660/warnings"] = (200, {"result": []})
    body = toss_trade.restrictions("005930,000660")
    assert body == {"ok": True, "viActive": [], "unknown": ["005930"], "indexChangePct": {"KOSPI": None, "KOSDAQ": None}}
    assert CANARY not in str(body)


def test_매매_제한은_오늘_시세가_아닌_지수를_세지_않고_잘못된_종목은_거절한다(enabled, fake, clock, clean_index_cache):
    _restriction_routes(fake, day="2026-11-06")
    assert toss_trade.restrictions("")["indexChangePct"] == {"KOSPI": None, "KOSDAQ": None}
    assert toss_trade.restrictions("../x")["reason"] == "invalid-request"
