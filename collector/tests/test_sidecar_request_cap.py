"""
tests/test_sidecar_request_cap.py
브라우저 컨테이너의 요청 하나가 어디서 붙잡혀도 상한 안에 끝나는가 (collector/sidecar/driver.py — ADR 0026 덧붙임 2026-11-13, QA-416).

요청 하나의 상한(``REQUEST_SECONDS``)은 페이지 받기(_load)의 반복문이 도는 사이에만 검사됩니다. 페이지가 DOMContentLoaded 뒤에 메인 스레드를
붙잡으면(끝나지 않는 스크립트·동기 XHR·``print()`` 등) 드라이버의 ``page.evaluate``·``page.content()``·마우스 호출이 돌아오지 않습니다
(이미지의 patchright 1.64.4 + Chrome에서 확인 — 호출에 시간 상한이 없음). 그러면 ``/fetch``가 '한 번에 한 건' 잠금을 쥔 채 끝나지 않아
그 뒤의 모든 요청이 429로 거절되고, ``/health``는 ok라 컨테이너도 다시 뜨지 않습니다.

같은 실험에서 확인한 것: **그 요청의 브라우저 프로세스를 끝내면** 붙잡혀 있던 호출이 바로 오류로 돌아옵니다. 이 시험의 가짜 브라우저는 그 모양
그대로입니다 — 띄우면 실제 프로세스 하나가 생기고(명령줄에 그 요청의 프록시 주소), 페이지 받기는 **그 프로세스가 끝날 때까지** 돌아오지 않습니다.
브라우저를 띄우지 않습니다(드라이버 패키지는 이 시험 환경에 없음). 프로세스 표(/proc)를 쓰므로 리눅스에서만 돕니다.

실제 Chrome으로 하는 확인은 이미지 안의 ``python -m sidecar.selfcheck``입니다.
"""
from __future__ import annotations

import subprocess
import sys
import threading
import time
import types

import pytest
from fastapi.testclient import TestClient

from sidecar.app import DriverError, create_app

pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="프로세스 표(/proc)가 있는 리눅스에서만(브라우저 컨테이너와 CI)")

TOKEN = "test-secret-not-a-real-one"
HOST = "blog.example.org"
STUCK_URL = f"https://{HOST}/stuck?session=abc"
PLAIN_URL = f"https://{HOST}/feed"
PAGE = {"status": 200, "finalUrl": PLAIN_URL, "contentType": "text/html", "body": "<html></html>", "challenge": None, "pressed": False}
# 시험에서 쓰는 짧은 상한(초)과, 그 안에 돌아왔는지 판정하는 바깥 시간.
CAP = 0.4
OUTER = 5.0

_SLEEPER = "import time; time.sleep(300)"


def _spawn(*arguments: str) -> subprocess.Popen:
    """아무 일도 하지 않고 떠 있는 프로세스 — 명령줄 인자만 다릅니다."""
    return subprocess.Popen([sys.executable, "-c", _SLEEPER, *arguments])


def _alive(process: subprocess.Popen) -> bool:
    return process.poll() is None


class _FakeBrowser:
    """
    ``sync_playwright()``의 대역. 띄우면 '브라우저 프로세스'(명령줄에 ``--proxy-server=<그 요청의 프록시>``)가 실제로 생깁니다.

    정상으로 닫으면(``close``) 그 프로세스를 끝내고 거둡니다. ``processes``는 띄운 순서대로.
    """

    def __init__(self) -> None:
        self.processes: list[subprocess.Popen] = []
        self.closed = 0
        self.chromium = self

    def __enter__(self) -> "_FakeBrowser":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def launch_persistent_context(self, profile_dir: str, **kwargs):
        self.processes.append(_spawn(f"--proxy-server={kwargs['proxy']['server']}"))
        return self

    def close(self) -> None:
        self.closed += 1
        process = self.processes[-1]
        if _alive(process):
            process.terminate()
        process.wait(timeout=5)

    def reap(self) -> None:
        """시험이 끝날 때 — 남은 프로세스를 끝내 붙잡힌 스레드를 풀어 줍니다(수정 전 코드에서는 이것이 유일한 출구)."""
        for process in self.processes:
            if _alive(process):
                process.kill()
            process.wait(timeout=5)


@pytest.fixture
def browser(monkeypatch, tmp_path):
    """
    드라이버 패키지를 가짜로 끼웁니다. 페이지 받기(_load)는 주소에 ``stuck``이 있으면 **브라우저 프로세스가 끝날 때까지 돌아오지 않고**,
    끝나면 실제 드라이버처럼 '닫혔다'는 브라우저 오류를 던집니다. 그 밖의 주소는 바로 고정 답을 돌려줍니다.
    """
    import sidecar.driver as driver

    fake = _FakeBrowser()
    package = types.ModuleType("patchright")
    api = types.ModuleType("patchright.sync_api")
    api.Error = type("Error", (Exception,), {})
    api.sync_playwright = lambda: fake

    def load(self, context, url, *args, **kwargs):
        if "stuck" in url:
            context.processes[-1].wait()
            raise api.Error("Page.evaluate: Target page, context or browser has been closed")
        return dict(PAGE)

    monkeypatch.setitem(sys.modules, "patchright", package)
    monkeypatch.setitem(sys.modules, "patchright.sync_api", api)
    monkeypatch.setattr(driver.ChromeDriver, "_load", load)
    monkeypatch.setattr(driver, "PROFILE_DIR", str(tmp_path / "profile"))
    # 강제 상한과 정리 대기를 짧게 — 드라이버는 이 값을 부를 때 읽습니다.
    monkeypatch.setattr(driver, "HARD_SECONDS", CAP, raising=False)
    monkeypatch.setattr(driver, "CLEANUP_SECONDS", 2.0, raising=False)
    yield fake
    fake.reap()


def _in_thread(call) -> tuple[threading.Thread, dict]:
    """``call``을 다른 스레드에서 부릅니다 → (스레드, {'value' 또는 'error', 'seconds'}). 끝나지 않는 호출을 바깥 시간으로 판정하려는 것입니다."""
    box: dict = {}

    def run() -> None:
        started = time.monotonic()
        try:
            box["value"] = call()
        except BaseException as exc:  # noqa: BLE001 — 시험이 종류를 봅니다
            box["error"] = exc
        box["seconds"] = time.monotonic() - started

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, box


@pytest.mark.xfail(strict=True, reason="QA-416 — 요청 하나의 강제 상한이 없어 붙잡힌 페이지에서 끝나지 않음")
def test_QA416_메인_스레드를_붙잡는_페이지도_상한_안에_오류로_돌아온다(browser):
    import sidecar.driver as driver

    thread, box = _in_thread(lambda: driver.ChromeDriver().fetch(STUCK_URL, wait_seconds=5.0, allowed=frozenset({HOST})))
    thread.join(timeout=OUTER)

    assert not thread.is_alive(), f"상한({CAP}초)을 넘겨 {OUTER}초가 지나도 돌아오지 않음 — /fetch가 잠금을 쥔 채 멈춥니다"
    assert isinstance(box.get("error"), DriverError), f"성공도 다른 예외도 아니라 DriverError여야 합니다: {box}"
    assert CAP <= box["seconds"] < CAP + 2.5, f"상한에 맞춰 돌아와야 합니다: {box['seconds']:.2f}초"
    assert not _alive(browser.processes[0]), "그 요청의 브라우저 프로세스가 남지 않습니다"
    message = str(box["error"])
    assert "요청 상한" in message and HOST in message, "어느 출처의 요청이 상한으로 끝났는지 호스트만 남깁니다"
    assert "session" not in message and "/stuck" not in message, "경로·쿼리는 싣지 않습니다"


@pytest.mark.xfail(strict=True, reason="QA-416 — 붙잡힌 요청이 '한 번에 한 건' 잠금을 놓지 않아 그 뒤의 요청이 모두 429")
def test_QA416_상한으로_끝난_뒤에는_잠금이_풀려_다음_요청을_받는다(browser):
    import sidecar.driver as driver

    client = TestClient(create_app(driver.ChromeDriver(), token=TOKEN, allowed_hosts=HOST))

    def post(url: str):
        return client.post("/fetch", json={"url": url, "waitSeconds": 5}, headers={"X-Browser-Token": TOKEN})

    thread, box = _in_thread(lambda: post(STUCK_URL))
    thread.join(timeout=OUTER)
    stuck_finished = not thread.is_alive()
    following = post(PLAIN_URL)

    assert stuck_finished, "붙잡힌 요청이 상한 안에 끝나지 않음"
    assert box["value"].status_code == 502, "출처의 거부가 아니라 '받지 못함'으로 답합니다"
    assert "요청 상한" in box["value"].json()["detail"]
    assert following.status_code == 200 and following.json() == PAGE, f"다음 요청이 처리되지 않음: HTTP {following.status_code}"
    assert len(browser.processes) == 2 and not any(_alive(process) for process in browser.processes)
