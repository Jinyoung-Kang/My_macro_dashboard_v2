"""
tests/test_sidecar_driver_launch.py
브라우저 드라이버가 Chrome을 띄울 때 넘기는 것 (collector/sidecar/driver.py — ADR 0026 덧붙임 2026-11-12, QA-414).

요청 가로채기(route 처리기)는 리다이렉트로 이어진 요청에는 불리지 않습니다(이미지의 patchright 1.64.4 + Chrome 157에서 확인 — 허용 주소가
302로 내부 주소를 가리키면 처리기는 첫 요청만 보고, 내부 주소가 요청을 받음). 그래서 Chrome의 나가는 길을 컨테이너 루프백의 필터 프록시
하나로 묶습니다. 이 시험은 브라우저 없이, 드라이버가 Chrome을 띄울 때 넘기는 인자를 가짜 드라이버 패키지로 받아 그 약속을 고정합니다.

  - 프록시 주소는 ``http://127.0.0.1:<포트>``이고 띄우는 동안 실제로 열려 있습니다. 요청이 끝나면 닫힙니다.
  - 루프백·링크 로컬행 요청도 프록시를 지납니다(``<-loopback>`` — Chrome은 기본으로 이 대역을 프록시 없이 직접 붙음).
  - 프록시가 볼 수 없는 UDP 길(WebRTC·QUIC)을 닫는 인자를 함께 넘깁니다.

실제 Chrome으로 하는 확인은 이미지 안의 ``python -m sidecar.selfcheck``(CI의 이미지 빌드 잡)입니다.
"""
from __future__ import annotations

import re
import socket
import sys
import types

import pytest

PAGE = {"status": 200, "finalUrl": "https://blog.example.org/feed", "contentType": "text/html", "body": "<html></html>",
        "challenge": None, "pressed": False}


class _FakePlaywright:
    """``sync_playwright()``의 대역 — 띄우기 인자를 받아 적고, 그 순간 프록시가 열려 있는지 붙어 봅니다."""

    def __init__(self) -> None:
        self.launches: list[dict] = []
        self.proxy_open_at_launch: list[bool] = []
        self.closed = 0
        self.chromium = self

    def __enter__(self) -> "_FakePlaywright":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def launch_persistent_context(self, profile_dir: str, **kwargs):
        self.launches.append({"profile_dir": profile_dir, **kwargs})
        self.proxy_open_at_launch.append(_can_connect((kwargs.get("proxy") or {}).get("server", "")))
        return self

    def close(self) -> None:
        self.closed += 1


def _can_connect(server: str) -> bool:
    found = re.fullmatch(r"http://(127\.0\.0\.1):(\d+)", server)
    if not found:
        return False
    try:
        socket.create_connection((found.group(1), int(found.group(2))), timeout=2).close()
    except OSError:
        return False
    return True


@pytest.fixture
def fake_browser(monkeypatch):
    """드라이버 패키지를 가짜로 끼우고 페이지 받기(_load)를 고정 답으로 바꿉니다 — 브라우저를 띄우지 않습니다."""
    import sidecar.driver as driver

    playwright = _FakePlaywright()
    package = types.ModuleType("patchright")
    api = types.ModuleType("patchright.sync_api")
    api.Error = type("Error", (Exception,), {})
    api.sync_playwright = lambda: playwright
    monkeypatch.setitem(sys.modules, "patchright", package)
    monkeypatch.setitem(sys.modules, "patchright.sync_api", api)
    monkeypatch.setattr(driver.ChromeDriver, "_load", lambda self, context, *args, **kwargs: dict(PAGE))
    return playwright


def test_QA414_드라이버는_Chrome을_루프백의_필터_프록시로만_내보낸다(fake_browser):
    import sidecar.driver as driver

    result = driver.ChromeDriver().fetch("https://blog.example.org/feed", wait_seconds=5.0,
                                         allowed=frozenset({"blog.example.org"}))

    assert result == PAGE and len(fake_browser.launches) == 1 and fake_browser.closed == 1
    launch = fake_browser.launches[0]
    proxy = launch["proxy"]
    assert re.fullmatch(r"http://127\.0\.0\.1:\d+", proxy["server"]), "컨테이너 루프백의 프록시"
    assert proxy["bypass"] == "<-loopback>", "루프백·링크 로컬행도 프록시를 지나야 합니다(Chrome의 암묵 우회를 끔)"
    assert set(proxy) == {"server", "bypass"}, "프록시 계정 같은 다른 칸은 없습니다"
    assert fake_browser.proxy_open_at_launch == [True], "띄우는 순간 프록시가 열려 있어야 합니다"
    assert not _can_connect(proxy["server"]), "요청이 끝나면 프록시도 닫힙니다"
    # 프록시가 볼 수 없는 UDP 길: WebRTC는 프록시로 갈 수 없는 UDP를 쓰지 않고, QUIC(HTTP/3·WebTransport)은 끕니다.
    assert "--webrtc-ip-handling-policy=disable_non_proxied_udp" in launch["args"]
    assert "--disable-quic" in launch["args"]
    assert not any(arg.startswith(("--proxy-server", "--proxy-bypass-list", "--no-proxy-server", "--proxy-pac-url"))
                   for arg in launch["args"]), "프록시 설정은 proxy 칸 하나로만 넘깁니다(인자로 덮어쓰지 않음)"


def test_QA414_운영_경로는_검사를_바꿔_끼우지_않는다(fake_browser, monkeypatch):
    """드라이버가 프록시를 만들 때 넘기는 것은 수명뿐 — 이름 풀이·주소 검사·연결은 기본값(시스템 풀이, 전역 주소 검사, 실제 연결)입니다."""
    import sidecar.driver as driver
    from sidecar import egress

    made: list[dict] = []
    real = egress.EgressFilter

    def spy(**kwargs):
        made.append(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(driver.egress, "EgressFilter", spy)

    driver.ChromeDriver().fetch("https://blog.example.org/feed", wait_seconds=5.0, allowed=frozenset({"blog.example.org"}))

    assert made == [{"lifetime_seconds": driver.EGRESS_LIFETIME_SECONDS}]
    assert driver.EGRESS_LIFETIME_SECONDS > driver.REQUEST_SECONDS, "요청이 끝나기 전에 프록시가 먼저 닫히지 않게"
    launch = fake_browser.launches[0]
    assert launch["profile_dir"] == driver.PROFILE_DIR and launch["args"] == [*driver.CHROME_ARGS, *driver.EGRESS_ARGS]


def test_QA414_프록시를_열지_못하면_브라우저를_띄우지_않는다(fake_browser, monkeypatch):
    import sidecar.driver as driver
    from sidecar.app import DriverError

    def broken(**kwargs):
        raise OSError("주소를 쓸 수 없음")

    monkeypatch.setattr(driver.egress, "EgressFilter", broken)

    with pytest.raises(DriverError, match="필터 프록시를 열지 못해"):
        driver.ChromeDriver().fetch("https://blog.example.org/feed", wait_seconds=5.0, allowed=frozenset({"blog.example.org"}))
    assert fake_browser.launches == [], "프록시 없이 Chrome을 띄우는 길은 없습니다"


def test_QA414_페이지를_받다가_실패해도_브라우저와_프록시를_닫는다(fake_browser, monkeypatch):
    import sidecar.driver as driver
    from sidecar.app import DriverError

    browser_error = sys.modules["patchright.sync_api"].Error

    def failing(self, context, *args, **kwargs):
        raise browser_error("Page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://blog.example.org/feed\nCall log: ...")

    monkeypatch.setattr(driver.ChromeDriver, "_load", failing)

    with pytest.raises(DriverError, match="브라우저 오류"):
        driver.ChromeDriver().fetch("https://blog.example.org/feed", wait_seconds=5.0, allowed=frozenset({"blog.example.org"}))
    assert fake_browser.closed == 1
    assert not _can_connect(fake_browser.launches[0]["proxy"]["server"])
