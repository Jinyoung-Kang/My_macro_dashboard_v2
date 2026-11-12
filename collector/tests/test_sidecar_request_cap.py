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

import ast
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import types
from pathlib import Path

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

    Chrome처럼 프로필 폴더에 잠금 링크(``SingletonLock`` → ``호스트이름-pid``)를 두고, 정상으로 닫으면(``close``) 그 프로세스를 끝내 거두고
    링크를 지웁니다. ``processes``·``proxies``는 띄운 순서대로.
    """

    def __init__(self) -> None:
        self.processes: list[subprocess.Popen] = []
        self.proxies: list[str] = []
        self.profile = ""
        self.closed = 0
        self.chromium = self

    def __enter__(self) -> "_FakeBrowser":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def launch_persistent_context(self, profile_dir: str, **kwargs):
        self.proxies.append(kwargs["proxy"]["server"])
        self.processes.append(_spawn(f"--proxy-server={kwargs['proxy']['server']}"))
        self.profile = profile_dir
        os.makedirs(profile_dir, exist_ok=True)
        for name, target in (("SingletonLock", f"{socket.gethostname()}-{self.processes[-1].pid}"),
                             ("SingletonSocket", "/tmp/com.google.Chrome.x/SingletonSocket"), ("SingletonCookie", "1234567890")):
            if os.path.lexists(os.path.join(profile_dir, name)):
                os.unlink(os.path.join(profile_dir, name))
            os.symlink(target, os.path.join(profile_dir, name))
        return self

    def close(self) -> None:
        self.closed += 1
        process = self.processes[-1]
        if _alive(process):
            # 정상 닫기 — 브라우저가 스스로 끝나며 잠금을 지웁니다. 강제로 끝난 뒤에는(프로세스가 이미 없음) 링크가 남습니다.
            process.terminate()
            for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
                os.unlink(os.path.join(self.profile, name))
        process.wait(timeout=5)

    def cleanup(self) -> None:
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
    monkeypatch.setattr(driver, "HARD_SECONDS", CAP)
    monkeypatch.setattr(driver, "CLEANUP_SECONDS", 2.0)
    yield fake
    fake.cleanup()


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


# ==============================================================================
# 상한으로 끝날 때 무엇이 끝나고 무엇이 남는가
# ==============================================================================
def _threads(prefix: str) -> list[str]:
    return [thread.name for thread in threading.enumerate() if thread.name.startswith(prefix) and thread.is_alive()]


def _settled(condition, seconds: float = 3.0) -> bool:
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


def _proxy_open(server: str) -> bool:
    host, _, port = server.removeprefix("http://").partition(":")
    try:
        socket.create_connection((host, int(port)), timeout=1).close()
    except OSError:
        return False
    return True


def test_QA416_상한으로_끝나면_그_요청의_브라우저와_프록시와_스레드와_프로필_잠금이_남지_않는다(browser):
    import sidecar.driver as driver

    profile = Path(driver.PROFILE_DIR)
    with pytest.raises(DriverError, match="요청 상한"):
        driver.ChromeDriver().fetch(STUCK_URL, wait_seconds=5.0, allowed=frozenset({HOST}))

    assert not _alive(browser.processes[0])
    assert not _proxy_open(browser.proxies[0]), "그 요청의 필터 프록시도 닫힙니다"
    assert _settled(lambda: not _threads("sidecar-fetch") and not _threads("egress-")), "작업 스레드·프록시 스레드가 남지 않습니다"
    assert browser.closed == 1, "붙잡혀 있던 호출이 오류로 돌아온 뒤 작업 스레드가 문맥을 닫습니다(정리는 평소 길 그대로)"
    assert not any(os.path.lexists(profile / name) for name in ("SingletonLock", "SingletonSocket", "SingletonCookie")), \
        "강제로 끝난 브라우저가 남긴 프로필 잠금 — 컨테이너가 다시 만들어지면 다음 기동을 막습니다"


def test_QA416_그_요청의_브라우저_밖의_프로세스는_끝내지_않는다(browser):
    import sidecar.driver as driver

    bystanders = [_spawn("--proxy-server=http://127.0.0.1:9"),             # 다른 포트의 프록시 인자(다른 요청의 브라우저 꼴)
                  _spawn("--user-data-dir=/profile"),                       # 프록시 인자가 없는 것
                  _spawn("--note=--proxy-server=http://127.0.0.1:9")]
    try:
        with pytest.raises(DriverError, match="요청 상한"):
            driver.ChromeDriver().fetch(STUCK_URL, wait_seconds=5.0, allowed=frozenset({HOST}))

        assert not _alive(browser.processes[0])
        time.sleep(0.2)
        assert all(_alive(process) for process in bystanders), "다른 프로세스를 끝냈습니다"
    finally:
        for process in bystanders:
            process.kill()
            process.wait(timeout=5)


def test_QA416_평소_요청은_아무것도_끝내지_않고_작업_스레드도_남지_않는다(browser, monkeypatch):
    import sidecar.driver as driver

    touched: list[str] = []
    monkeypatch.setattr(driver.reap, "find_browser", lambda *args, **kwargs: touched.append("find") or driver.reap.Found())
    monkeypatch.setattr(driver.reap, "end", lambda *args, **kwargs: touched.append("end") or [])
    monkeypatch.setattr(driver.reap, "clear_stale_lock", lambda *args, **kwargs: touched.append("lock") or False)
    monkeypatch.setattr(driver, "HARD_SECONDS", 30.0)

    started = time.monotonic()
    result = driver.ChromeDriver().fetch(PLAIN_URL, wait_seconds=5.0, allowed=frozenset({HOST}))

    assert result == PAGE and time.monotonic() - started < 5.0, "상한까지 기다리지 않고 끝나는 대로 돌아옵니다"
    assert touched == [], "평소 요청에서는 프로세스 표를 보지도, 무엇을 끝내지도, 프로필에 손대지도 않습니다"
    assert browser.closed == 1 and not _proxy_open(browser.proxies[0])
    assert _settled(lambda: not _threads("sidecar-fetch") and not _threads("egress-")), "요청이 끝나면 작업 스레드도 끝납니다"


def test_QA416_작업_스레드의_브라우저_오류와_그_밖의_예외는_부른_쪽에_그대로_전달된다(browser, monkeypatch):
    import sidecar.driver as driver

    browser_error = sys.modules["patchright.sync_api"].Error

    def failing(error):
        def load(self, context, *args, **kwargs):
            raise error
        return load

    monkeypatch.setattr(driver.ChromeDriver, "_load", failing(browser_error("Page.goto: Timeout 45000ms exceeded.")))
    with pytest.raises(DriverError, match="브라우저 오류: Page.goto: Timeout 45000ms exceeded."):
        driver.ChromeDriver().fetch(PLAIN_URL, wait_seconds=5.0, allowed=frozenset({HOST}))

    monkeypatch.setattr(driver.ChromeDriver, "_load", failing(ZeroDivisionError("드라이버 코드의 결함")))
    with pytest.raises(ZeroDivisionError):
        driver.ChromeDriver().fetch(PLAIN_URL, wait_seconds=5.0, allowed=frozenset({HOST}))
    assert browser.closed == 2 and not _threads("sidecar-fetch")


# ------------------------------------------------------------------------------ 브라우저를 끝내도 안 돌아올 때 — 드라이버 프로세스
# 드라이버(node)의 대역 — 미리 떠 있다가, 표준 입력으로 인자를 받으면 그 인자를 명령줄에 가진 '브라우저'를 자식으로 띄웁니다.
_LAUNCHER = ("import subprocess, sys, time\n"
             "print('ready', flush=True)\n"
             "argument = sys.stdin.readline().strip()\n"
             "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)', argument])\n"
             "print('launched', flush=True)\n"
             "time.sleep(300)\n")


def _start_launcher() -> subprocess.Popen:
    launcher = subprocess.Popen([sys.executable, "-c", _LAUNCHER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert launcher.stdout.readline().strip() == "ready"
    return launcher


def _launch_through(launcher: subprocess.Popen, argument: str) -> int:
    """드라이버 대역에게 브라우저를 띄우게 합니다 → 그 브라우저의 번호(띄운 것을 확인한 뒤 돌아옵니다)."""
    launcher.stdin.write(argument + "\n")
    launcher.stdin.flush()
    assert launcher.stdout.readline().strip() == "launched"
    return _pids_with(argument)[0]


def _stop_launcher(launcher: subprocess.Popen, argument: str) -> None:
    launcher.kill()
    launcher.wait(timeout=5)
    for stream in (launcher.stdin, launcher.stdout):
        stream.close()
    for pid in _pids_with(argument):
        os.kill(pid, signal.SIGKILL)


def _pids_with(argument: str) -> list[int]:
    """명령줄에 그 인자를 통째로 가진 프로세스(시험이 /proc을 직접 읽습니다 — 운영 코드의 찾기와 따로)."""
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/cmdline", "rb") as handle:
                if argument.encode() in handle.read().split(b"\0"):
                    found.append(int(name))
        except OSError:
            continue
    return found


def _gone(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat", "rb") as handle:
            stat = handle.read()
    except OSError:
        return True
    return stat[stat.rindex(b")") + 2:stat.rindex(b")") + 3] in (b"Z", b"X")


@pytest.mark.parametrize("stuck_until", ["브라우저가 끝날 때까지", "드라이버가 끝날 때까지"])
def test_QA416_드라이버_프로세스는_브라우저를_끝내도_안_돌아올_때만_끝낸다(monkeypatch, tmp_path, stuck_until):
    """
    실제 구조는 '이 프로세스 → 드라이버(node) → Chrome'입니다. 브라우저만 끝내면 호출이 돌아오는 것이 보통이고(이미지에서 확인), 드라이버가
    멎어 있으면 브라우저를 끝내도 돌아오지 않다가 드라이버를 끝내면 돌아옵니다(같은 실험 — SIGSTOP으로 흉내). 앞의 경우에는 드라이버를 끝내지 않습니다.
    """
    import sidecar.driver as driver

    api = types.ModuleType("patchright.sync_api")
    api.Error = type("Error", (Exception,), {})
    launcher = _start_launcher()                    # 드라이버는 요청보다 먼저 떠 있습니다(상한이 브라우저가 뜨기 전에 오지 않게)
    made: dict = {"argument": ""}
    cap, cleanup = 1.0, 2.0

    class Playwright:
        chromium = None

        def __enter__(self):
            self.chromium = self
            return self

        def __exit__(self, *exc_info: object) -> None:
            return None

        def launch_persistent_context(self, profile_dir: str, **kwargs):
            made["argument"] = f"--proxy-server={kwargs['proxy']['server']}"
            made["browser"] = _launch_through(launcher, made["argument"])
            return self

        def close(self) -> None:
            pass

    def load(self, context, *args, **kwargs):
        if stuck_until == "브라우저가 끝날 때까지":
            while not _gone(made["browser"]):
                time.sleep(0.02)
            raise api.Error("Page.evaluate: Target page, context or browser has been closed")
        launcher.wait()
        raise RuntimeError("Page.evaluate: Connection closed while reading from the driver")

    monkeypatch.setitem(sys.modules, "patchright", types.ModuleType("patchright"))
    monkeypatch.setitem(sys.modules, "patchright.sync_api", api)
    api.sync_playwright = Playwright
    monkeypatch.setattr(driver.ChromeDriver, "_load", load)
    monkeypatch.setattr(driver, "PROFILE_DIR", str(tmp_path / "profile"))
    monkeypatch.setattr(driver, "HARD_SECONDS", cap)
    monkeypatch.setattr(driver, "CLEANUP_SECONDS", cleanup)
    try:
        started = time.monotonic()
        with pytest.raises(DriverError, match="요청 상한"):
            driver.ChromeDriver().fetch(STUCK_URL, wait_seconds=5.0, allowed=frozenset({HOST}))
        elapsed = time.monotonic() - started

        assert _settled(lambda: _gone(made["browser"])), "브라우저는 어느 경우에나 끝납니다"
        assert elapsed < cap + cleanup + 1.5, f"강제 상한 + 정리 대기 안에 돌아와야 합니다: {elapsed:.2f}초"
        assert _settled(lambda: not _threads("sidecar-fetch"))
        if stuck_until == "브라우저가 끝날 때까지":
            assert _alive(launcher), "브라우저를 끝내 호출이 돌아왔으면 드라이버 프로세스는 건드리지 않습니다(스스로 닫힘)"
            assert elapsed < cap + cleanup / 2, "정리 대기의 절반(드라이버까지 끝내는 때)을 넘기지 않습니다"
        else:
            assert _settled(lambda: not _alive(launcher)), "브라우저를 끝내도 안 돌아오면 그 브라우저를 띄운 드라이버를 끝냅니다"
            assert elapsed >= cap + cleanup / 2, "드라이버는 브라우저를 끝내고 기다린 뒤에만 끝냅니다"
    finally:
        _stop_launcher(launcher, made["argument"])


def test_QA416_정리가_끝나지_않아도_기다리지_않고_답한다(monkeypatch, tmp_path, caplog):
    """브라우저도 드라이버도 찾지 못한 채 작업 스레드가 붙잡혀 있어도(확인된 재현은 없음) 부른 쪽은 상한 + 정리 대기에 돌아옵니다."""
    import sidecar.driver as driver

    api = types.ModuleType("patchright.sync_api")
    api.Error = type("Error", (Exception,), {})
    release = threading.Event()

    class Playwright:
        chromium = None

        def __enter__(self):
            release.wait(timeout=30)                # 브라우저를 띄우기도 전에 붙잡힘 — 끝낼 프로세스가 없습니다
            raise api.Error("드라이버를 시작하지 못함")

        def __exit__(self, *exc_info: object) -> None:
            return None

    api.sync_playwright = Playwright
    monkeypatch.setitem(sys.modules, "patchright", types.ModuleType("patchright"))
    monkeypatch.setitem(sys.modules, "patchright.sync_api", api)
    monkeypatch.setattr(driver, "PROFILE_DIR", str(tmp_path / "profile"))
    monkeypatch.setattr(driver, "HARD_SECONDS", 0.2)
    monkeypatch.setattr(driver, "CLEANUP_SECONDS", 0.4)
    try:
        started = time.monotonic()
        with caplog.at_level("ERROR", logger="sidecar.driver"), pytest.raises(DriverError, match="요청 상한"):
            driver.ChromeDriver().fetch(STUCK_URL, wait_seconds=5.0, allowed=frozenset({HOST}))

        assert time.monotonic() - started < 0.2 + 0.4 + 1.5
        assert any("정리가 끝나지 않음" in record.getMessage() for record in caplog.records), "남은 스레드는 오류 로그로 알립니다"
        assert not _threads("egress-"), "프록시는 어느 경우에나 닫습니다"
    finally:
        release.set()
    assert _settled(lambda: not _threads("sidecar-fetch"))


def test_QA416_상한들의_선후():
    """반복문의 상한 < 강제 상한 < (정리 대기까지) 수집기가 기다리는 시간 < 필터 프록시의 수명 — 한쪽만 바꾸지 않게."""
    import sidecar.driver as driver
    from app.fetch import browser_client

    collector_waits = browser_client.TIMEOUT[1]
    assert driver.REQUEST_SECONDS < driver.HARD_SECONDS, "정상 경로(반복문의 상한 뒤 본문 읽기·닫기)를 강제로 끊지 않게"
    assert driver.HARD_SECONDS - driver.REQUEST_SECONDS >= 10.0, "90초 직전에 시작한 반복 한 바퀴(체크박스 누르기 약 5.5초)와 닫기의 몫"
    assert driver.HARD_SECONDS + driver.CLEANUP_SECONDS < collector_waits, "수집기가 포기하기 전에 502로 답할 수 있게"
    assert collector_waits < driver.EGRESS_LIFETIME_SECONDS, "프록시의 수명은 닫히지 못했을 때의 안전망 — 요청보다 먼저 닫히지 않게"


# ==============================================================================
# 프로세스 표에서 그 요청의 브라우저 찾기 (sidecar/reap.py — 가짜 /proc)
# ==============================================================================
PROXY = "http://127.0.0.1:41000"
SWITCH = f"--proxy-server={PROXY}"


def _proc(root: Path, rows: dict[int, tuple[int, list[str]]], *, names: dict[int, str] | None = None, states: dict[int, str] | None = None) -> str:
    """가짜 /proc — {번호: (부모, 명령줄 인자들)}."""
    for pid, (parent, arguments) in rows.items():
        folder = root / str(pid)
        folder.mkdir(parents=True)
        name = (names or {}).get(pid, "proc")
        state = (states or {}).get(pid, "S")
        (folder / "stat").write_text(f"{pid} ({name}) {state} {parent} {pid} {pid} 0 -1 4194560 0 0", encoding="utf-8")
        (folder / "cmdline").write_bytes(b"".join(argument.encode() + b"\0" for argument in arguments))
    (root / "self").mkdir(exist_ok=True)                    # 번호가 아닌 항목 — 건너뜁니다
    (root / "meminfo").write_text("x", encoding="utf-8")
    return str(root)


# 컨테이너의 실제 모양(이미지에서 본 것): init → xvfb-run → {Xvfb, uvicorn(이 프로세스) → node 드라이버 → chrome → zygote → 렌더러}
_TREE = {
    1: (0, ["/sbin/docker-init", "--", "xvfb-run"]),
    7: (1, ["/bin/sh", "/usr/bin/xvfb-run", "-a", "uvicorn"]),
    17: (7, ["Xvfb", ":99"]),
    20: (7, ["/usr/local/bin/python", "/usr/local/bin/uvicorn", "sidecar.app:create_app"]),
    25: (20, ["/usr/local/lib/python3.11/site-packages/patchright/driver/node", "cli.js", "run-driver"]),
    38: (25, ["/opt/google/chrome/chrome", "--disable-quic", SWITCH, "--user-data-dir=/profile", "about:blank"]),
    40: (1, ["/opt/google/chrome/chrome_crashpad_handler", "--monitor-self"]),
    48: (38, ["/opt/google/chrome/chrome", "--type=zygote", "--no-zygote-sandbox"]),
    49: (38, ["/opt/google/chrome/chrome", "--type=zygote"]),
    51: (49, ["/opt/google/chrome/chrome", "--type=zygote"]),
    76: (48, ["/opt/google/chrome/chrome", "--type=gpu-process"]),
    79: (38, ["/opt/google/chrome/chrome", "--type=utility", "--utility-sub-type=network.mojom.NetworkService"]),
    155: (51, ["/opt/google/chrome/chrome", "--type=renderer"]),
}


def test_QA416_그_요청의_프록시_주소를_가진_프로세스와_그_자손만_찾는다(tmp_path):
    from sidecar import reap

    found = reap.find_browser(PROXY, proc_root=_proc(tmp_path, _TREE), own_pid=20)

    assert found.browsers == (38,), "프록시 인자를 가진 것은 브라우저 프로세스 하나"
    assert sorted(found.descendants) == [48, 49, 51, 76, 79, 155], "zygote·GPU·망 서비스·렌더러"
    assert found.processes[0] == 38, "브라우저 프로세스부터 끝냅니다(자식을 다시 띄우지 못하게)"
    assert found.launchers == (25,), "그 브라우저를 띄운 드라이버 — 이 프로세스의 직접 자식"
    untouched = {1, 7, 17, 20, 25, 40} & set(found.processes)
    assert not untouched, f"init·xvfb-run·Xvfb·이 프로세스·드라이버·다른 나무의 프로세스는 대상이 아닙니다: {untouched}"


@pytest.mark.parametrize("arguments", [
    ["chrome", "--proxy-server=http://127.0.0.1:4100"],                 # 포트의 앞머리만 같음
    ["chrome", "--proxy-server=http://127.0.0.1:410001"],               # 그 포트로 시작하는 다른 포트
    ["chrome", f"--note={SWITCH}"],                                      # 다른 인자 안에 들어 있음
    ["chrome", f"{SWITCH}/"],
    ["chrome", "--proxy-server=http://127.0.0.2:41000"],                # 다른 주소
    ["sh", "-c", f"echo {SWITCH}"],                                      # 한 인자 안의 글
    ["chrome"],
    [],                                                                  # 커널 스레드·좀비(명령줄 없음)
])
def test_QA416_프록시_인자가_통째로_같지_않으면_그_요청의_브라우저가_아니다(tmp_path, arguments):
    from sidecar import reap

    rows = {1: (0, ["init"]), 20: (1, ["uvicorn"]), 300: (20, arguments), 301: (300, ["child"])}

    assert reap.find_browser(PROXY, proc_root=_proc(tmp_path, rows), own_pid=20) == reap.Found()


def test_QA416_이_프로세스와_그_조상과_init은_프록시_인자를_가졌어도_대상이_아니다(tmp_path):
    from sidecar import reap

    rows = {1: (0, ["init", SWITCH]), 7: (1, ["xvfb-run", SWITCH]), 20: (7, ["uvicorn", SWITCH]),
            30: (20, ["child-with-switch", SWITCH]), 31: (30, ["grandchild"])}

    found = reap.find_browser(PROXY, proc_root=_proc(tmp_path, rows), own_pid=20)

    assert found.browsers == (30,) and found.descendants == (31,)
    assert found.launchers == (), "브라우저의 부모가 이 프로세스 자신이면 드라이버로 보지 않습니다"


def test_QA416_드라이버로_보는_것은_이_프로세스의_직접_자식뿐이다(tmp_path):
    from sidecar import reap

    # 브라우저(60)의 부모(50)가 이 프로세스(20)의 자식이 아니라 손자입니다 — 끝낼 드라이버로 보지 않습니다.
    rows = {1: (0, ["init"]), 20: (1, ["uvicorn"]), 40: (20, ["wrapper"]), 50: (40, ["node"]), 60: (50, ["chrome", SWITCH]),
            70: (1, ["node"]), 80: (70, ["chrome", SWITCH])}            # 다른 나무(init의 자식이 띄운 것)

    found = reap.find_browser(PROXY, proc_root=_proc(tmp_path, rows), own_pid=20)

    assert found.browsers == (60, 80) and found.launchers == ()
    assert reap.children_of_this_process([40, 50, 70, 20, 1, 999], proc_root=str(tmp_path), own_pid=20) == (40,)


def test_QA416_프로세스_이름에_괄호와_공백이_있어도_부모를_바로_읽는다(tmp_path):
    from sidecar import reap

    rows = {1: (0, ["init"]), 20: (1, ["uvicorn"]), 30: (20, ["chrome", SWITCH]), 31: (30, ["renderer"])}
    root = _proc(tmp_path, rows, names={31: "Web Content) R 1 (x"})

    assert reap.find_browser(PROXY, proc_root=root, own_pid=20).descendants == (31,)


def test_QA416_프로세스_표가_없으면_아무것도_찾지_못한다(tmp_path):
    from sidecar import reap

    assert reap.find_browser(PROXY, proc_root=str(tmp_path / "없음"), own_pid=20) == reap.Found()
    assert reap.children_of_this_process([5], proc_root=str(tmp_path / "없음"), own_pid=20) == ()


def test_QA416_끝내기는_SIGKILL이고_사라진_프로세스와_보내지_못한_프로세스는_건너뛴다(caplog):
    from sidecar import reap

    sent: list[tuple[int, int]] = []

    def send(pid: int, sig: int) -> None:
        if pid == 2:
            raise ProcessLookupError
        if pid == 3:
            raise PermissionError
        sent.append((pid, sig))

    with caplog.at_level("WARNING", logger="sidecar.reap"):
        assert reap.end([1, 2, 3, 4], send=send) == [1, 4]
    assert sent == [(1, signal.SIGKILL), (4, signal.SIGKILL)]
    assert any("끝내지 못함(PermissionError)" in record.getMessage() for record in caplog.records)


def test_QA416_실제_프로세스로_찾아_끝낸다():
    """가짜 /proc이 아니라 이 PC의 프로세스 표로 — 명령줄 읽기·자손 찾기·SIGKILL이 실제로 맞물리는지."""
    from sidecar import reap

    # 운영처럼 그 요청만의 포트 — 쥐고 있는 동안 이 PC의 다른 프로세스(같은 시험의 다른 실행 포함)가 같은 번호를 받지 못합니다.
    held = socket.create_server(("127.0.0.1", 0))
    proxy = f"http://127.0.0.1:{held.getsockname()[1]}"
    target_argument = f"--proxy-server={proxy}"
    launcher = _start_launcher()
    bystander = _spawn(f"{target_argument}0")
    try:
        browser_pid = _launch_through(launcher, target_argument)
        found = reap.find_browser(proxy)
        assert found.browsers == (browser_pid,) and found.launchers == (launcher.pid,)
        assert reap.children_of_this_process([launcher.pid, browser_pid]) == (launcher.pid,)

        ended = reap.end(found.processes)

        assert ended == [browser_pid] and _settled(lambda: _gone(browser_pid))
        assert _alive(launcher) and _alive(bystander), "드라이버와 포트가 다른 프로세스는 그대로"
        assert reap.find_browser(proxy) == reap.Found()
    finally:
        _stop_launcher(launcher, target_argument)
        bystander.kill()
        bystander.wait(timeout=5)
        held.close()


# ==============================================================================
# 프로필의 잠금 링크 (sidecar/reap.clear_stale_lock)
# ==============================================================================
def _lock(profile: Path, owner: str) -> None:
    profile.mkdir(parents=True, exist_ok=True)
    os.symlink(owner, profile / "SingletonLock")
    os.symlink("/tmp/com.google.Chrome.x/SingletonSocket", profile / "SingletonSocket")
    os.symlink("1234567890", profile / "SingletonCookie")
    (profile / "Default").mkdir()
    (profile / "Local State").write_text("{}", encoding="utf-8")


def _links(profile: Path) -> list[str]:
    return sorted(name for name in ("SingletonLock", "SingletonSocket", "SingletonCookie") if os.path.lexists(profile / name))


@pytest.mark.parametrize("owner, ended, cleared", [
    ("box-a-38", [38], True),               # 방금 끝낸 브라우저의 잠금
    ("box-a-38", [], False),                # 이 컨테이너에서 살아 있는 프로세스의 잠금 — 손대지 않음
    ("box-a-39", [], True),                 # 주인이 좀비(끝났고 아직 거두지 않음)
    ("box-a-4000", [], True),               # 주인이 없음
    ("box-old-38", [], True),               # 다른 호스트 이름 — 다시 만들어지기 전의 컨테이너(번호가 우연히 같아도)
    ("my-host-with-dash-38", [], True),
    ("garbage", [], True),                  # 모양이 아닌 잠금
])
def test_QA416_주인_없는_프로필_잠금만_치운다(tmp_path, owner, ended, cleared):
    from sidecar import reap

    proc_root = _proc(tmp_path / "proc", {1: (0, ["init"]), 38: (1, ["chrome"]), 39: (1, [])}, states={39: "Z"})
    profile = tmp_path / "profile"
    _lock(profile, owner)

    assert reap.clear_stale_lock(str(profile), ended=ended, proc_root=proc_root, hostname="box-a") is cleared

    assert _links(profile) == ([] if cleared else ["SingletonCookie", "SingletonLock", "SingletonSocket"])
    assert (profile / "Default").is_dir() and (profile / "Local State").exists(), "프로필의 다른 것(쿠키 등)은 그대로"


def test_QA416_잠금이_없으면_프로필에_손대지_않는다(tmp_path):
    from sidecar import reap

    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "SingletonLock").write_text("링크가 아닌 파일", encoding="utf-8")

    assert reap.clear_stale_lock(str(profile), proc_root=str(tmp_path / "proc"), hostname="box-a") is False
    assert (profile / "SingletonLock").exists()
    assert reap.clear_stale_lock(str(tmp_path / "없는-프로필"), proc_root=str(tmp_path / "proc"), hostname="box-a") is False


# ==============================================================================
# 끝내는 코드가 있는 자리
# ==============================================================================
def _source(name: str) -> ast.Module:
    return ast.parse((Path(__file__).resolve().parents[1] / "sidecar" / name).read_text(encoding="utf-8"))


def test_QA416_프로세스를_끝내는_호출은_reap에만_있고_표준_라이브러리만_쓴다():
    killing = {"kill", "killpg", "terminate", "send_signal", "pidfd_send_signal"}
    for name in ("driver.py", "app.py", "egress.py", "guard.py"):
        calls = {node.func.attr for node in ast.walk(_source(name)) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        assert not (calls & killing), f"{name}에 프로세스를 끝내는 호출: {sorted(calls & killing)}"

    tree = _source("reap.py")
    imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    imported |= {node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert imported <= {"__future__", "logging", "os", "signal", "socket", "dataclasses", "typing"}, f"표준 라이브러리 밖의 것: {sorted(imported)}"
    signals = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute) and node.attr.startswith("SIG")}
    assert signals == {"SIGKILL"}
