"""
tests/test_sidecar.py
브라우저 컨테이너(collector/sidecar — ADR 0026 결정 8·ADR 0035 결정 5, 명세 docs/specs/2026-11-05-polite-fetch.md §5)의 문지기와 내부 서비스.

고정하는 규칙
  1. 공유 비밀이 맞아야 하고, 서버에 비밀이 없으면 모든 요청을 거절합니다(드라이버를 부르지 않음).
  2. 갈 수 있는 곳은 허용 호스트의 https 주소뿐입니다 — http, 다른 호스트, 허용 호스트를 흉내 낸 주소(사용자 정보 칸·하위 도메인)는 거절.
  3. 하위 요청의 목적지는 전역 주소만 — 사설·루프백·링크 로컬(클라우드 메타데이터)·CGNAT(tailnet)·IPv6 내부 대역, 풀리지 않는 이름,
     전역과 내부가 섞여 풀리는 이름은 막습니다.
  4. 한 번에 한 건만 합니다. 받는 입력은 주소와 기다릴 시간뿐입니다.
  5. 사람 확인은 입력 없는 체크박스만 한 번 누르고 퍼즐은 풀지 않습니다(ADR 0035 결정 5) — 드라이버의 답(challenge)을 그대로 돌려주고,
     드라이버 코드의 누르기 호출은 체크박스 함수 하나에만 있고 글자·키보드 입력 호출은 없습니다.

브라우저를 띄우지 않습니다(가짜 드라이버). 드라이버 패키지는 이 시험 환경에 없습니다.
"""
from __future__ import annotations

import ast
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sidecar import guard
from sidecar.app import DriverError, create_app

TOKEN = "test-secret-not-a-real-one"
ALLOWED = "www.investing.com, Economic-Calendar.TradingView.com"
PAGE = {"status": 200, "finalUrl": "https://www.investing.com/economic-calendar/", "contentType": "text/html",
        "body": "<html><body>calendar</body></html>", "challenge": None}


class FakeDriver:
    def __init__(self, result: dict | None = None, error: Exception | None = None) -> None:
        self.result = result or PAGE
        self.error = error
        self.calls: list[tuple[str, float]] = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.hold = False

    def fetch(self, url: str, *, wait_seconds: float, allowed: frozenset[str]) -> dict:
        self.calls.append((url, wait_seconds))
        if self.hold:
            self.entered.set()
            self.release.wait(timeout=5)
        if self.error is not None:
            raise self.error
        return self.result


def _client(driver: FakeDriver, token: str = TOKEN, allowed: str = ALLOWED) -> TestClient:
    return TestClient(create_app(driver, token=token, allowed_hosts=allowed))


def _post(client: TestClient, url: str, token: str | None = TOKEN, **body):
    headers = {"X-Browser-Token": token} if token is not None else {}
    return client.post("/fetch", json={"url": url, **body}, headers=headers)


# ==============================================================================
# 1. 공유 비밀
# ==============================================================================
def test_비밀이_맞으면_드라이버의_답을_그대로_돌려준다():
    driver = FakeDriver()

    response = _post(_client(driver), "https://www.investing.com/economic-calendar/")

    assert response.status_code == 200 and response.json() == PAGE
    assert driver.calls == [("https://www.investing.com/economic-calendar/", 25.0)]


@pytest.mark.parametrize("given", [None, "", "wrong", TOKEN + "x"])
def test_비밀이_없거나_틀리면_거절하고_드라이버를_부르지_않는다(given):
    driver = FakeDriver()

    assert _post(_client(driver), "https://www.investing.com/", token=given).status_code == 401
    assert driver.calls == []


@pytest.mark.parametrize("given", [None, "", "anything"])
def test_서버에_비밀이_없으면_무엇을_보내도_거절한다(given):
    driver = FakeDriver()
    client = _client(driver, token="")

    assert _post(client, "https://www.investing.com/", token=given).status_code == 401
    assert driver.calls == []
    assert client.get("/health").json() == {"status": "ok", "tokenConfigured": False, "allowedHosts": 2,
                                            "pressCheckbox": True}, "뜨기는 합니다"


# ==============================================================================
# 2. 허용 호스트
# ==============================================================================
@pytest.mark.parametrize("url", [
    "http://www.investing.com/economic-calendar/",            # https 아님
    "https://example.org/",                                    # 목록에 없음
    "https://www.investing.com.evil.example/",                 # 허용 호스트로 시작하는 다른 호스트
    "https://www.investing.com@evil.example/",                 # 사용자 정보 칸에 허용 호스트
    "https://evil.example/?next=https://www.investing.com/",
    "https://collector:8000/status",                           # 안쪽 서비스
    "https://127.0.0.1/",
    "file:///etc/passwd",
    "javascript:alert(1)",
])
def test_허용_호스트의_https_주소가_아니면_거절한다(url):
    driver = FakeDriver()

    assert _post(_client(driver), url).status_code == 400
    assert driver.calls == []


def test_허용_호스트는_대소문자와_공백을_가리지_않고_비어_있으면_아무_데도_가지_않는다():
    assert guard.parse_hosts(ALLOWED) == frozenset({"www.investing.com", "economic-calendar.tradingview.com"})
    assert guard.top_level_allowed("https://ECONOMIC-calendar.tradingview.com/events", guard.parse_hosts(ALLOWED))
    assert guard.parse_hosts("") == guard.parse_hosts(None) == frozenset()

    driver = FakeDriver()
    assert _post(_client(driver, allowed=""), "https://www.investing.com/").status_code == 400


# ==============================================================================
# 3. 하위 요청의 목적지
# ==============================================================================
@pytest.mark.parametrize("address", [
    "10.0.0.5", "172.18.0.3", "192.168.1.1",         # 사설(도커 망 포함)
    "127.0.0.1", "::1",                              # 루프백
    "169.254.169.254", "fe80::1",                    # 링크 로컬(클라우드 메타데이터)
    "100.66.107.111",                                # CGNAT — tailnet 주소
    "fd7a:115c:a1e0::1",                             # IPv6 내부(tailnet)
    "0.0.0.0", "224.0.0.1", "ff02::1", "240.0.0.1",   # 미지정·멀티캐스트·예약
    "::ffff:10.0.0.5", "::ffff:169.254.169.254",     # IPv4를 감싼 IPv6
])
def test_전역_주소가_아닌_목적지는_막는다(address):
    host = f"[{address}]" if ":" in address else address

    assert guard.destination_allowed(f"http://{host}/x") is False
    assert guard.destination_allowed("https://cdn.example.org/app.js", resolve=lambda name: [address]) is False


def test_전역_주소로만_풀리는_이름은_지나간다():
    assert guard.destination_allowed("https://cdn.example.org/app.js", resolve=lambda name: ["8.8.8.8", "2001:4860:4860::8888"])
    assert guard.destination_allowed("https://8.8.8.8/x")


def test_내부_주소가_섞여_풀리거나_풀리지_않는_이름은_막는다():
    assert guard.destination_allowed("https://rebind.example.org/", resolve=lambda name: ["8.8.8.8", "10.0.0.5"]) is False
    assert guard.destination_allowed("https://nowhere.example.org/", resolve=lambda name: []) is False


@pytest.mark.parametrize("url", ["ftp://8.8.8.8/x", "ws://8.8.8.8/x", "https:///x", "data:text/plain,hi"])
def test_http와_https가_아닌_목적지는_지나가지_못한다(url):
    assert guard.destination_allowed(url, resolve=lambda name: ["8.8.8.8"]) is False


# ==============================================================================
# 4. 한 번에 한 건 · 입력
# ==============================================================================
def test_한_번에_한_건만_한다():
    driver = FakeDriver()
    driver.hold = True
    client = _client(driver)
    first: list[int] = []
    worker = threading.Thread(target=lambda: first.append(_post(client, "https://www.investing.com/a").status_code))
    worker.start()
    assert driver.entered.wait(timeout=5)

    assert _post(client, "https://www.investing.com/b").status_code == 429

    driver.release.set()
    worker.join(timeout=5)
    assert first == [200] and [url for url, _ in driver.calls] == ["https://www.investing.com/a"]
    driver.hold = False
    assert _post(client, "https://www.investing.com/c").status_code == 200, "끝나면 다음 요청을 받습니다"


@pytest.mark.parametrize("body", [{"waitSeconds": 0.5}, {"waitSeconds": 61}, {"waitSeconds": "long"}])
def test_기다릴_시간은_1초에서_60초(body):
    driver = FakeDriver()

    assert _post(_client(driver), "https://www.investing.com/", **body).status_code == 422
    assert driver.calls == []


def test_드라이버가_받지_못하면_502(caplog):
    driver = FakeDriver(error=DriverError("브라우저 오류: 시간 초과"))

    response = _post(_client(driver), "https://www.investing.com/")

    assert response.status_code == 502 and response.json()["detail"] == "브라우저 오류: 시간 초과"


def test_주소_밖의_입력은_드라이버에_전달되지_않는다():
    driver = FakeDriver()

    response = _post(_client(driver), "https://www.investing.com/", script="document.title", click="#verify",
                     headers={"User-Agent": "x"})

    assert response.status_code == 200
    assert driver.calls == [("https://www.investing.com/", 25.0)], "스크립트·클릭·머리글 입력은 받지 않습니다"


# ==============================================================================
# 5. 사람 확인 — 입력 없는 체크박스만 한 번 누르고 퍼즐은 풀지 않는다 (ADR 0035 결정 5, ADR 0026 결정 5 개정)
# ==============================================================================
def test_사람_확인은_그대로_돌려준다():
    driver = FakeDriver(result={**PAGE, "status": 403, "challenge": "human"})

    assert _post(_client(driver), "https://www.investing.com/").json()["challenge"] == "human"
    assert len(driver.calls) == 1, "다시 시도하지 않습니다 — 닫을지는 수집기가 정합니다"


def _driver_tree() -> ast.Module:
    source = (Path(__file__).resolve().parents[1] / "sidecar" / "driver.py").read_text(encoding="utf-8")
    return ast.parse(source)


def _calls_in(node: ast.AST) -> set[str]:
    return {sub.func.attr for sub in ast.walk(node) if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute)}


def test_누르기_호출은_체크박스_함수_하나에만_있고_입력_호출은_없다():
    """체크박스를 누르는 호출(마우스)은 press_checkbox_once 안에만, 글자·키보드 입력과 요소 조작은 드라이버 어디에도 없습니다."""
    tree = _driver_tree()
    pressing = {"click", "dblclick", "tap", "down", "up", "move"}
    typing = {"fill", "type", "press", "press_sequentially", "select_option", "set_checked", "check", "uncheck",
              "drag_to", "drag_and_drop", "dispatch_event", "set_input_files", "insert_text"}
    functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    press = functions["press_checkbox_once"]

    outside = set()
    for name, node in functions.items():
        if name != "press_checkbox_once":
            outside |= _calls_in(node)
    assert not (outside & pressing), f"체크박스 함수 밖에 누르기 호출: {sorted(outside & pressing)}"
    assert not (_calls_in(tree) & typing), f"입력 호출: {sorted(_calls_in(tree) & typing)}"
    assert _calls_in(press) & pressing == {"move", "click"}
    attributes = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    assert "keyboard" not in attributes and "touchscreen" not in attributes
    assert "wheel" in _calls_in(tree), "그 밖에 마우스로 하는 일은 스크롤뿐입니다"


class _Mouse:
    def __init__(self):
        self.clicks: list[tuple[float, float]] = []

    def move(self, x, y, steps=1):
        pass

    def click(self, x, y, delay=0):
        self.clicks.append((x, y))


class _Element:
    def __init__(self, box):
        self._box = box

    def bounding_box(self):
        return self._box


class _Frame:
    def __init__(self, url, box=None):
        self.url = url
        self._box = box or {"x": 100.0, "y": 200.0, "width": 300.0, "height": 65.0}

    def frame_element(self):
        return _Element(self._box)


class _Page:
    def __init__(self, frames):
        self.frames = frames
        self.mouse = _Mouse()

    def wait_for_timeout(self, ms):
        pass


@pytest.mark.parametrize("url", [
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal",
    "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0",
    "https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&co=x",
])
def test_체크박스_틀이면_그_칸을_한_번만_누른다(url):
    driver_module = pytest.importorskip("sidecar.driver")
    page = _Page([_Frame("https://site.example/"), _Frame(url)])

    assert driver_module.press_checkbox_once(page) is True
    assert len(page.mouse.clicks) == 1
    x, y = page.mouse.clicks[0]
    assert 100 <= x <= 100 + 40 and 200 + 25 <= y <= 200 + 40, "틀 왼쪽의 체크박스 자리"


@pytest.mark.parametrize("url", [
    "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=0",
    "https://www.google.com/recaptcha/api2/bframe?hl=ko&k=key",
    "https://geo.captcha-delivery.com/captcha/?initialCid=x",
])
def test_퍼즐_틀은_누르지_않는다(url):
    driver_module = pytest.importorskip("sidecar.driver")
    page = _Page([_Frame(url)])

    assert driver_module.press_checkbox_once(page) is False
    assert page.mouse.clicks == []
    assert driver_module._puzzle_frame(page) is True


def test_보이지_않는_틀은_누르지_않는다():
    driver_module = pytest.importorskip("sidecar.driver")
    page = _Page([_Frame("https://challenges.cloudflare.com/x", box={"x": 0, "y": 0, "width": 0, "height": 0})])

    assert driver_module.press_checkbox_once(page) is False


def test_문지기는_브라우저_드라이버를_가져오지_않는다():
    for name in ("guard.py", "app.py"):
        tree = ast.parse((Path(__file__).resolve().parents[1] / "sidecar" / name).read_text(encoding="utf-8"))
        imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        imported |= {node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level == 0}
        assert not any(name.startswith(("patchright", "playwright", "selenium")) for name in imported)
