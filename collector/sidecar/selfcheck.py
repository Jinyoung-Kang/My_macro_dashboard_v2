"""
sidecar/selfcheck.py
이미지 안 확인 — 실제 Chrome과 필터 프록시로 '막아야 할 목적지가 요청을 받지 않는가'(ADR 0026 덧붙임 2026-11-12, QA-414)와 '페이지가 메인
스레드를 붙잡아도 요청이 강제 상한 안에 끝나는가'(덧붙임 2026-11-13, QA-416)를 봅니다.

    xvfb-run -a python -m sidecar.selfcheck        # 브라우저 컨테이너 이미지 안에서. 통과하면 0, 아니면 1

밖으로 나가는 요청이 없습니다. 이 프로세스가 컨테이너 루프백에 띄우는 서버만 씁니다 — '허용' 서버 A는 127.0.0.1, '금지' 서버 B는 127.0.0.2.
프록시의 검사 함수를 'A의 주소만 허용'으로 바꿔 끼우고(운영 기본값은 전역 주소 검사 — 그 규칙 자체는 tests/test_sidecar_egress.py가 고정)
이름 풀이는 꺼 둡니다. Chrome은 운영과 같은 함수(:func:`sidecar.driver.launch`)로 띄웁니다. 단위 시험이 볼 수 없는 것 — Chrome이 정말로
모든 요청을 프록시로 보내는가 — 을 여기서 봅니다. 망이 없는 컨테이너(``docker run --network none``)에서도 돕니다.

확인하는 것
  0. Chrome의 실제 명령줄에 프록시 주소와 ``<-loopback>``이 있다.
  1. 허용 목적지의 페이지가 뜬다(드라이버의 페이지 받기 ``_load`` 그대로 — 요청 가로채기 포함).
  2. 최상위 302 → 금지 주소: 가로채기는 그 홉을 보지 못해도 B는 요청을 받지 않는다.
  3. 하위 요청(이미지)의 302 → 금지 주소: 그 홉이 프록시로 와서 막히고 B는 받지 않는다.
  4. 스크립트의 fetch·웹소켓이 금지 주소로 가도 B는 받지 않는다. 링크 로컬(169.254.169.254)·localhost행도 프록시로 와서 막힌다
     (Chrome의 암묵 우회가 꺼져 있음). 허용 주소의 웹소켓은 프록시를 지나 연결된다.
  5. 프록시가 보지 못하는 UDP(WebRTC의 STUN, WebTransport의 QUIC)가 나가지 않는다. WebRTC의 TCP 길(TURN TCP, 원격 후보로 붙는 ICE-TCP)은
     프록시로 와서 막히고 금지 주소는 연결을 받지 않는다.
  6. 프록시가 닫히면 Chrome의 요청은 실패한다(직접 나가지 않음).
  8. Chrome이 이름을 스스로 풀지 않는다(넷로그에 이름 풀이가 없음) — WebRTC의 TURN(TCP) 서버 이름까지. 그 이름의 연결은 프록시로 온다.
  9. 메인 스레드를 붙잡는 페이지(DOMContentLoaded 뒤 끝나지 않는 스크립트)를 운영 경로(``ChromeDriver.fetch``) 그대로 열면, 짧게 준 강제 상한에
     오류로 돌아오고, 그 뒤 Chrome 프로세스와 프로필 잠금이 남지 않고, 바로 이어 연 평소 페이지가 같은 프로필로 뜬다(QA-416). 돌아오지
     않으면 이 뒤의 확인을 하지 않고 실패로 끝냅니다(붙잡힌 브라우저가 떠 있는 채로는 이어 갈 수 없음).
  7. 대조: WebRTC 정책 스위치와 이름 풀이 규칙을 뺀 Chrome에서는 STUN이 나가고 TURN 이름을 DNS로 묻는다 — 5·8의 확인이 비어 있지 않음을
     보입니다(Chrome 스위치 이름이 바뀌면 여기나 5·8이 실패).

5·7·8은 WebRTC가 루프백에서 후보를 모으게 하는 확인 전용 인자(``--allow-loopback-in-peer-connection``)와 넷로그 기록 인자를 더해 띄웁니다.
망 없는 컨테이너에는 루프백뿐이라 앞의 인자 없이는 WebRTC가 아무것도 보내지 않습니다. 7의 DNS 대조는 Chrome이 ``.test`` 이름 하나를 풀이
서버에 묻게 하므로 **망이 없는 컨테이너에서만** 합니다(망이 있으면 건너뛰고 그렇게 적습니다).
"""
from __future__ import annotations

import base64
import glob
import hashlib
import json
import logging
import os
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from urllib.parse import urlsplit

from . import driver, egress, guard, reap
from .app import DriverError

ALLOWED_ADDRESS = "127.0.0.1"
FORBIDDEN_ADDRESS = "127.0.0.2"
TURN_ADDRESS = "127.0.0.3"          # WebRTC의 TURN(TCP) 서버로 주는 금지 주소
ICE_TCP_ADDRESS = "127.0.0.4"       # WebRTC의 원격 후보(ICE-TCP)로 주는 금지 주소
TURN_NAME = "selfcheck-turn.test"   # TURN(TCP) 서버로 주는 이름 — 풀리지 않는 예약 최상위 이름
LINK_LOCAL = "169.254.169.254"
WATCHDOG_SECONDS = 240
RTC_LOOPBACK_ARG = "--allow-loopback-in-peer-connection"
# 넷로그에서 'Chrome이 스스로 이름을 풀었다'로 보는 이벤트 종류(앞머리).
_RESOLVE_EVENTS = ("DNS_TRANSACTION", "HOST_RESOLVER_SYSTEM_TASK", "HOST_RESOLVER_DNS_TASK", "HOST_RESOLVER_MANAGER_JOB")
MARK = "selfcheck-allowed-page"
# 9번 확인에서만 쓰는 짧은 강제 상한(초) — 운영 값은 driver.HARD_SECONDS. Chrome이 뜨고 페이지가 메인 스레드를 붙잡기까지(1초 안팎)보다 넉넉히.
CAP_SECONDS = 4.0

# DOMContentLoaded 뒤에 메인 스레드를 붙잡는 페이지 — 드라이버의 page.evaluate·page.content()·마우스 호출이 돌아오지 않습니다.
_SPIN_PAGE = """<html><head><title>spin</title></head><body>spin<script>
document.addEventListener('DOMContentLoaded', () => setTimeout(() => { for (;;) {} }, 0));
</script></body></html>"""

_SCRIPT_PAGE = """<html><body>script<script>
(async () => {
  const out = {};
  const within = (promise, ms) => Promise.race([promise, new Promise((done) => setTimeout(() => done('timeout'), ms))]);
  const get = (url) => within(fetch(url, {mode: 'no-cors'}).then(() => 'answered', () => 'failed'), 8000);
  out.fetchForbidden = await get('http://%(forbidden)s:%(b)d/secret-fetch');
  out.fetchLinkLocal = await get('http://%(link_local)s/latest/meta-data/');
  out.fetchLocalhost = await get('http://localhost:%(b)d/secret-localhost');
  out.wsForbidden = await within(new Promise((done) => {
    const ws = new WebSocket('ws://%(forbidden)s:%(b)d/secret-ws'); ws.onopen = () => done('open'); ws.onerror = () => done('error'); }), 8000);
  out.wsAllowed = await within(new Promise((done) => {
    const ws = new WebSocket('ws://%(allowed)s:%(a)d/ws'); ws.onmessage = (e) => done('message:' + e.data); ws.onerror = () => done('error'); }), 8000);
  document.body.setAttribute('data-out', JSON.stringify(out)); document.title = 'done';
})();
</script></body></html>"""

_RTC_PAGE = """<html><body>rtc<script>
(async () => {
  const out = {};
  const within = (promise, ms) => Promise.race([promise, new Promise((done) => setTimeout(() => done('timeout'), ms))]);
  try {
    const pc = new RTCPeerConnection({iceServers: [
      {urls: ['stun:%(forbidden)s:%(u_forbidden)d', 'stun:%(allowed)s:%(u_allowed)d']},
      {urls: [%(turn_urls)s], username: 'u', credential: 'p'}]});
    const peer = new RTCPeerConnection();
    pc.createDataChannel('x');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await pc.setRemoteDescription(answer);
    await pc.addIceCandidate({candidate: 'candidate:2 1 tcp 1518280447 %(ice_tcp)s %(t_ice)d typ host tcptype passive', sdpMid: '0', sdpMLineIndex: 0});
    window.keep = [pc, peer];
    out.webrtc = 'started';
  } catch (e) { out.webrtc = 'error ' + e.name; }
  try {
    if (typeof WebTransport === 'undefined') out.webtransport = 'no api';
    else out.webtransport = await within(new WebTransport('https://%(forbidden)s:%(u_forbidden)d/x').ready.then(() => 'ready', () => 'failed'), 3000);
  } catch (e) { out.webtransport = 'error ' + e.name; }
  document.body.setAttribute('data-out', JSON.stringify(out)); document.title = 'done';
})();
</script></body></html>"""


class _Lab:
    """루프백의 서버들 — 허용 A(http·웹소켓), 금지 B(http — 받은 것을 전부 적음), UDP 둘과 금지 TCP 둘(받은 것을 적음)."""

    def __init__(self) -> None:
        self.hits_a: list[str] = []
        self.hits_b: list[str] = []
        self.udp_hits: list[str] = []
        self.tcp_hits: list[str] = []
        lab = self

        class Forbidden(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                lab.hits_b.append(self.path)
                self.send_response(200)
                self.send_header("content-type", "text/html")
                self.end_headers()
                self.wfile.write(b"<html><body>forbidden secret</body></html>")

            def log_message(self, *args: object) -> None:
                pass

        class Allowed(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                lab.hits_a.append(self.path)
                if self.path == "/ws":
                    accept = base64.b64encode(hashlib.sha1(
                        (self.headers.get("Sec-WebSocket-Key", "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                    self.send_response(101)
                    self.send_header("Upgrade", "websocket")
                    self.send_header("Connection", "Upgrade")
                    self.send_header("Sec-WebSocket-Accept", accept)
                    self.end_headers()
                    self.wfile.write(b"\x81\x05hello")          # 글자 프레임 하나
                    self.wfile.flush()
                    self.close_connection = True
                    return
                redirects = {"/top-redirect": "/secret-top", "/img-redirect": "/secret-img"}
                if self.path in redirects:
                    self.send_response(302)
                    self.send_header("location", f"http://{FORBIDDEN_ADDRESS}:{lab.port_b}{redirects[self.path]}")
                    self.end_headers()
                    return
                turn_urls = [f"turn:{TURN_ADDRESS}:{lab.port_turn}?transport=tcp"]
                if self.path != "/rtc-without-names":
                    turn_urls.append(f"turn:{TURN_NAME}:3478?transport=tcp")
                ports = {"allowed": ALLOWED_ADDRESS, "forbidden": FORBIDDEN_ADDRESS, "link_local": LINK_LOCAL, "a": lab.port_a,
                         "b": lab.port_b, "u_forbidden": lab.port_udp_forbidden, "u_allowed": lab.port_udp_allowed,
                         "ice_tcp": ICE_TCP_ADDRESS, "t_ice": lab.port_ice_tcp, "turn_urls": ", ".join(f"'{url}'" for url in turn_urls)}
                if self.path == "/sub":
                    body = '<html><body><img src="/img-redirect">sub</body></html>'
                elif self.path == "/script":
                    body = _SCRIPT_PAGE % ports
                elif self.path.startswith("/rtc"):
                    body = _RTC_PAGE % ports
                elif self.path == "/spin":
                    body = _SPIN_PAGE
                else:
                    body = f"<html><body>{MARK}</body></html>"
                self.send_response(200)
                self.send_header("content-type", "text/html")
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *args: object) -> None:
                pass

        self.port_udp_forbidden = self._udp(FORBIDDEN_ADDRESS)
        self.port_udp_allowed = self._udp(ALLOWED_ADDRESS)
        self.port_turn = self._tcp(TURN_ADDRESS)
        self.port_ice_tcp = self._tcp(ICE_TCP_ADDRESS)
        self._b = ThreadingHTTPServer((FORBIDDEN_ADDRESS, 0), Forbidden)
        self._a = ThreadingHTTPServer((ALLOWED_ADDRESS, 0), Allowed)
        self.port_b = self._b.server_address[1]
        self.port_a = self._a.server_address[1]
        for server in (self._a, self._b):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def _udp(self, address: str) -> int:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind((address, 0))

        def loop() -> None:
            while True:
                data, _peer = sock.recvfrom(4096)
                kind = "STUN" if data[:2] == b"\x00\x01" else "QUIC" if data[:1] and data[0] & 0x80 else "기타"
                self.udp_hits.append(f"{address} {kind} {len(data)}B")

        threading.Thread(target=loop, daemon=True).start()
        return sock.getsockname()[1]

    def _tcp(self, address: str) -> int:
        """금지 주소의 TCP 포트 — 연결이 오면 적기만 하고 닫습니다(와서는 안 됩니다)."""
        server = socket.create_server((address, 0))

        def loop() -> None:
            while True:
                conn, _peer = server.accept()
                self.tcp_hits.append(f"{address} TCP 연결")
                conn.close()

        threading.Thread(target=loop, daemon=True).start()
        return server.getsockname()[1]

    def url(self, path: str) -> str:
        return f"http://{ALLOWED_ADDRESS}:{self.port_a}{path}"


class _Report:
    def __init__(self) -> None:
        self.failed = 0

    def line(self, ok: bool, name: str, detail: str = "") -> bool:
        self.failed += 0 if ok else 1
        print(f"{'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""), flush=True)
        return ok


class _Collect(logging.Handler):
    def __init__(self, lines: list[str]) -> None:
        super().__init__()
        self._lines = lines

    def emit(self, record: logging.LogRecord) -> None:
        self._lines.append(record.getMessage())


def _chrome_flags(profile_dir: str) -> list[str]:
    """이 확인이 띄운 Chrome(브라우저 프로세스)의 명령줄에서 프록시·UDP 관련 인자."""
    wanted = (b"--proxy", b"--webrtc", b"--disable-quic", b"--no-proxy", b"--host-resolver")
    for path in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            with open(path, "rb") as handle:
                parts = handle.read().split(b"\0")
        except OSError:
            continue
        if f"--user-data-dir={profile_dir}".encode() in parts and not any(part.startswith(b"--type=") for part in parts):
            return sorted(part.decode() for part in parts if part.startswith(wanted))
    return []


def _page_result(page, url: str, timeout_ms: int = 40_000) -> dict:
    """페이지를 열고 그 스크립트가 DOM에 적어 둔 결과를 읽습니다(드라이버의 평가는 페이지 스크립트의 변수를 보지 못하는 세계에서 돕니다)."""
    page.goto(url, wait_until="load", timeout=30_000)
    page.wait_for_function("document.title === 'done'", timeout=timeout_ms)
    return json.loads(page.evaluate("document.body.getAttribute('data-out')") or "{}")


def _wait_for(condition, *, at_least: float, at_most: float) -> None:
    """``at_least``초는 기다리고(나가면 안 되는 것이 나갈 시간을 줌), 그 뒤 ``condition``이 참이 되거나 ``at_most``초가 될 때까지 기다립니다."""
    started = time.monotonic()
    while time.monotonic() - started < at_most:
        if time.monotonic() - started >= at_least and condition():
            return
        time.sleep(0.1)


def _has_network() -> bool:
    """이 컨테이너에 루프백 말고 나갈 길이 있는가(보내는 것은 없음 — 문서용 주소로 나갈 때 쓸 주소만 물어봄)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        return not probe.getsockname()[0].startswith("127.")
    except OSError:
        return False
    finally:
        probe.close()


def _own_lookups(netlog: str) -> list[str] | None:
    """넷로그에서 Chrome이 스스로 한 이름 풀이('이벤트 종류 이름') 목록. 읽지 못하면 None. 브라우저를 닫은 뒤에 부릅니다."""
    try:
        with open(netlog, encoding="utf-8") as handle:
            raw = handle.read()
    except OSError:
        return None
    try:
        log = json.loads(raw)
    except ValueError:
        try:
            log = json.loads(raw.rstrip().rstrip(",") + "]}")       # 끝맺음 없이 닫힌 기록
        except ValueError:
            return None
    try:
        kinds = {number: name for name, number in log["constants"]["logEventTypes"].items()}
    except (KeyError, TypeError, AttributeError):
        return None
    found: list[str] = []
    for event in log.get("events") or []:
        kind = kinds.get(event.get("type"), "")
        if kind.startswith(_RESOLVE_EVENTS):
            params = event.get("params") or {}
            name = str(params.get("hostname") or params.get("qname") or params.get("host") or "").rstrip(".")
            found.append(f"{kind} {name}".strip())
    return found


def _short(text: object, lab: _Lab) -> str:
    return str(text).splitlines()[0][:150].replace(f":{lab.port_a}", ":A").replace(f":{lab.port_b}", ":B")


def _allow_lab_at_the_request_layer() -> None:
    """
    이 프로세스 안에서만, 요청 가로채기의 규칙을 '허용 서버 A는 지나감'으로 바꿉니다(운영 규칙은 https·전역 주소라 루프백 서버를 쓸 수 없음).

    가로채기가 금지 주소 B를 **첫 요청으로는** 막고 A는 지나가게 두어, B로 가는 것은 리다이렉트 홉(가로채기가 보지 못하는 길)뿐이게 합니다.
    """
    guard.top_level_allowed = lambda url, allowed: (urlsplit(url).hostname or "") in allowed
    guard.destination_allowed = lambda url, resolve=None: (urlsplit(url).hostname or "") == ALLOWED_ADDRESS


def _chrome_processes() -> list[str]:
    """지금 떠 있는 Chrome 프로세스('번호 종류' — 끝났지만 아직 거두지 않은 것은 빼고)."""
    found: list[str] = []
    for path in glob.glob("/proc/[0-9]*/cmdline"):
        pid = path.split("/")[2]
        try:
            with open(path, "rb") as handle:
                words = handle.read().replace(b"\0", b" ").split()       # 자식 프로세스의 명령줄은 공백으로 이어진 한 덩어리입니다
            with open(f"/proc/{pid}/stat", "rb") as handle:
                stat = handle.read()
        except OSError:
            continue
        state = stat[stat.rindex(b")") + 1:].split()[:1]
        if words and os.path.basename(words[0]).startswith(b"chrome") and state not in ([b"Z"], [b"X"]):
            kind = next((word.decode()[len("--type="):] for word in words if word.startswith(b"--type=")), "browser")
            found.append(f"{pid} {kind}")
    return found


def _check_request_cap(lab: _Lab, report: _Report, only_lab: dict) -> None:
    """
    9. 요청의 강제 상한(QA-416) — 운영 경로(:meth:`sidecar.driver.ChromeDriver.fetch`) 그대로, 붙잡는 페이지 → 평소 페이지 순서로 두 번.

    이 프로세스 안에서만 세 가지를 바꿔 끼웁니다: 운영 경로가 여는 프록시의 검사('허용 서버 A만' — 다른 확인과 같음), 프로필 폴더(임시),
    강제 상한(짧게). 요청 가로채기의 규칙은 :func:`_allow_lab_at_the_request_layer`가 이미 바꿔 둔 상태에서 부릅니다.
    """
    real_filter, real_profile, real_cap = egress.EgressFilter, driver.PROFILE_DIR, driver.HARD_SECONDS
    chrome = driver.ChromeDriver()
    allowed = frozenset({ALLOWED_ADDRESS})
    with tempfile.TemporaryDirectory(prefix="selfcheck-cap-", ignore_cleanup_errors=True) as profile:
        egress.EgressFilter = lambda **kwargs: real_filter(**{**only_lab, **kwargs})
        driver.PROFILE_DIR, driver.HARD_SECONDS = profile, CAP_SECONDS
        try:
            lab.hits_a.clear()
            seen: dict = {}

            def stuck_request() -> None:
                started = time.monotonic()
                try:
                    chrome.fetch(lab.url("/spin"), wait_seconds=2.0, allowed=allowed)
                    seen["outcome"] = "페이지를 받음"
                except DriverError as exc:
                    seen["outcome"], seen["refused"] = f"DriverError({_short(exc, lab)})", True
                except Exception as exc:  # noqa: BLE001 — 무엇으로 끝났는지 그대로 적습니다
                    seen["outcome"] = f"{type(exc).__name__}({_short(exc, lab)})"
                seen["seconds"] = time.monotonic() - started

            # 방어가 없으면 이 호출은 끝나지 않습니다 — 다른 스레드에서 부르고 바깥 시간으로 판정합니다.
            outer = CAP_SECONDS + driver.CLEANUP_SECONDS + 10.0
            caller = threading.Thread(target=stuck_request, daemon=True)
            caller.start()
            caller.join(outer)
            name = f"9. 메인 스레드를 붙잡는 페이지: 강제 상한({CAP_SECONDS:g}초)에 오류로 돌아옴(운영 경로 그대로)"
            if caller.is_alive():
                report.line(False, name, f"{outer:g}초가 지나도 돌아오지 않음, 떠 있는 Chrome {len(_chrome_processes())}개 — 이 뒤의 확인은 하지 않음")
                print(f"결과: 실패 {report.failed}건", flush=True)
                os._exit(1)
            # 브라우저만 끝내 돌아왔으면 정리 대기의 절반(드라이버 프로세스까지 끝내는 때)을 넘기지 않습니다.
            in_time = CAP_SECONDS <= seen["seconds"] < CAP_SECONDS + driver.CLEANUP_SECONDS / 2
            report.line(bool(seen.get("refused")) and in_time and "/spin" in lab.hits_a and "요청 상한" in seen["outcome"], name,
                        f"{seen['seconds']:.1f}초에 {seen['outcome']}, A가 받음 {lab.hits_a[:1]}")

            _wait_for(lambda: not _chrome_processes(), at_least=0.0, at_most=5.0)
            locks = [link for link in reap.SINGLETON_LINKS if os.path.lexists(os.path.join(profile, link))]
            report.line(_chrome_processes() == [] and locks == [], "9. 그 뒤 Chrome 프로세스와 프로필 잠금이 남지 않음",
                        f"떠 있는 Chrome {_chrome_processes()}, 프로필의 잠금 링크 {locks}")

            lab.hits_a.clear()
            try:
                got = chrome.fetch(lab.url("/"), wait_seconds=2.0, allowed=allowed)
                opened = got["status"] == 200 and MARK in got["body"]
                outcome = f"상태 {got['status']}"
            except DriverError as exc:
                opened, outcome = False, f"DriverError({_short(exc, lab)})"
            report.line(opened and lab.hits_a[:1] == ["/"] and "/spin" not in lab.hits_a,
                        "9. 바로 이어 연 평소 페이지가 같은 프로필로 뜸(붙잡던 페이지를 다시 열지 않음)", f"{outcome}, A가 받음 {lab.hits_a}")
        finally:
            egress.EgressFilter, driver.PROFILE_DIR, driver.HARD_SECONDS = real_filter, real_profile, real_cap


def run() -> int:
    from patchright.sync_api import Error as BrowserError
    from patchright.sync_api import sync_playwright

    blocked_log: list[str] = []
    logging.getLogger("sidecar").addHandler(_Collect(blocked_log))      # '막은 목적지' 줄은 모아 두었다가 끝에 한 번에
    logging.getLogger("sidecar").propagate = False

    lab = _Lab()
    report = _Report()
    only_lab = {"resolve": lambda name: [], "allow": lambda address: address == ALLOWED_ADDRESS}
    networked = _has_network()
    print(f"patchright {version('patchright')} · 허용 A={ALLOWED_ADDRESS} · 금지 B={FORBIDDEN_ADDRESS} · 샌드박스 {'켬' if driver.SANDBOX else '끔'}"
          f" · 컨테이너 망 {'있음' if networked else '없음'}", flush=True)

    with tempfile.TemporaryDirectory(prefix="selfcheck-") as scratch:
        profile, netlog = os.path.join(scratch, "profile"), os.path.join(scratch, "netlog.json")
        with egress.EgressFilter(lifetime_seconds=WATCHDOG_SECONDS, **only_lab) as gate, sync_playwright() as playwright:
            context = driver.launch(playwright, gate.url, profile_dir=profile, extra_args=(RTC_LOOPBACK_ARG, f"--log-net-log={netlog}"))
            try:
                page = context.pages[0] if context.pages else context.new_page()
                print(f"  {page.evaluate('navigator.userAgent')}", flush=True)

                flags = _chrome_flags(profile)
                report.line(f"--proxy-server={gate.url}" in flags and f"--proxy-bypass-list={driver.PROXY_BYPASS}" in flags
                            and all(arg in flags for arg in driver.EGRESS_ARGS) and not any(flag.startswith("--no-proxy") for flag in flags),
                            "0. Chrome 명령줄의 프록시·UDP·이름 풀이 인자", " ".join(flag.replace(gate.url, "http://127.0.0.1:<포트>") for flag in flags))

                # 3. 하위 요청의 리다이렉트 (가로채기 없이 — 프록시만으로). B로 가는 첫 요청이라, 프록시가 B를 막았다면 이 홉입니다.
                page.goto(lab.url("/sub"), wait_until="load", timeout=30_000)
                _wait_for(lambda: FORBIDDEN_ADDRESS in gate.blocked_hosts(), at_least=0.8, at_most=5.0)
                report.line("/img-redirect" in lab.hits_a and lab.hits_b == [] and FORBIDDEN_ADDRESS in gate.blocked_hosts(),
                            "3. 하위 요청의 302 → 금지 주소: 홉이 프록시로 와서 막히고 B가 받지 않음",
                            f"A가 받음 {lab.hits_a[-2:]}, B가 받음 {lab.hits_b}, 프록시가 막은 호스트 {sorted(gate.blocked_hosts() & {FORBIDDEN_ADDRESS})}")

                # 4. 스크립트의 fetch·웹소켓
                lab.hits_b.clear()
                seen = _page_result(page, lab.url("/script"))
                blocked = gate.blocked_hosts()
                report.line(lab.hits_b == [] and seen.get("fetchForbidden") == "answered" and seen.get("wsForbidden") == "error",
                            "4. fetch·웹소켓의 금지 주소행: B가 받지 않음", f"B가 받음 {lab.hits_b}, 페이지가 본 것 {seen}")
                report.line({FORBIDDEN_ADDRESS, LINK_LOCAL, "localhost"} <= blocked,
                            "4. 루프백·링크 로컬·localhost행도 프록시로 와서 막힘", f"프록시가 막은 호스트 {sorted(blocked)}")
                report.line(seen.get("wsAllowed") == "message:hello" and "/ws" in lab.hits_a, "4. 허용 주소의 웹소켓은 프록시를 지나 연결됨",
                            str(seen.get("wsAllowed")))

                # 5. WebRTC·WebTransport — UDP는 나가지 않고, TCP 길은 프록시로 와서 막힘
                seen = _page_result(page, lab.url("/rtc"))
                rtc_tcp = {TURN_ADDRESS, ICE_TCP_ADDRESS, TURN_NAME}
                _wait_for(lambda: rtc_tcp <= gate.blocked_hosts(), at_least=3.0, at_most=20.0)
                blocked = gate.blocked_hosts()
                report.line(lab.udp_hits == [] and seen.get("webrtc") == "started" and seen.get("webtransport") == "failed",
                            "5. WebRTC(STUN)·WebTransport(QUIC)의 UDP가 나가지 않음",
                            f"UDP가 받음 {sorted(set(lab.udp_hits))}, 페이지가 본 것 {seen}")
                report.line(lab.tcp_hits == [] and {TURN_ADDRESS, ICE_TCP_ADDRESS} <= blocked,
                            "5. WebRTC의 TCP 길(TURN TCP·ICE-TCP)은 프록시로 와서 막히고 금지 주소가 연결을 받지 않음",
                            f"금지 주소가 받은 TCP {lab.tcp_hits}, 프록시가 막은 호스트 {sorted(blocked & rtc_tcp)}")
                turn_name_at_proxy = TURN_NAME in blocked

                # 1·2. 드라이버의 페이지 받기 그대로(요청 가로채기 포함)
                _allow_lab_at_the_request_layer()
                chrome = driver.ChromeDriver()
                allowed = frozenset({ALLOWED_ADDRESS})
                lab.hits_a.clear()
                try:
                    got = chrome._load(context, lab.url("/"), 2.0, allowed, time.monotonic())
                    report.line(got["status"] == 200 and MARK in got["body"] and lab.hits_a[:1] == ["/"]
                                and ALLOWED_ADDRESS in gate.passed_hosts(), "1. 허용 목적지의 페이지가 뜸(드라이버의 페이지 받기)",
                                f"상태 {got['status']}, A가 받음 {lab.hits_a[:1]}, 프록시 통과 {sorted(gate.passed_hosts())}")
                except BrowserError as exc:
                    report.line(False, "1. 허용 목적지의 페이지가 뜸(드라이버의 페이지 받기)", _short(exc, lab))

                lab.hits_a.clear()
                lab.hits_b.clear()
                routed: list[str] = []
                page.on("request", lambda request: routed.append(_short(request.url + (" (리다이렉트 홉)" if request.redirected_from else ""), lab)))
                try:
                    got = chrome._load(context, lab.url("/top-redirect"), 2.0, allowed, time.monotonic())
                    outcome = f"상태 {got['status']}, 끝 주소 {_short(got['finalUrl'], lab)}"
                    reached = "forbidden secret" in got["body"]
                except BrowserError as exc:
                    outcome, reached = f"오류 {_short(exc, lab)}", False
                report.line("/top-redirect" in lab.hits_a and lab.hits_b == [] and not reached and any("리다이렉트 홉" in line for line in routed),
                            "2. 최상위 302 → 금지 주소: B가 받지 않음(드라이버의 페이지 받기)",
                            f"{outcome}, B가 받음 {lab.hits_b}, 브라우저가 보낸 요청 {routed}")

                # 6. 프록시가 닫히면
                gate.close()
                lab.hits_a.clear()
                fresh = context.new_page()
                try:
                    fresh.goto(lab.url("/"), wait_until="domcontentloaded", timeout=15_000)
                    outcome = "페이지가 열림"
                except BrowserError as exc:
                    outcome = _short(exc, lab)
                report.line(lab.hits_a == [] and outcome != "페이지가 열림", "6. 프록시가 닫히면 요청이 실패함(직접 나가지 않음)",
                            f"{outcome}, A가 받음 {lab.hits_a}")
            finally:
                context.close()

        # 8. Chrome이 이름을 스스로 풀지 않음 — 브라우저를 닫은 뒤 넷로그에서
        lookups = _own_lookups(netlog)
        report.line(lookups == [] and turn_name_at_proxy, "8. Chrome이 이름을 스스로 풀지 않음(TURN TCP 이름 포함 — 그 연결은 프록시로 옴)",
                    "넷로그를 읽지 못함" if lookups is None else
                    f"넷로그의 이름 풀이 {sorted(set(lookups))}, TURN 이름이 프록시에 옴: {'예' if turn_name_at_proxy else '아니오'}")

    # 9. 요청의 강제 상한 — 메인 스레드를 붙잡는 페이지를 운영 경로 그대로
    _check_request_cap(lab, report, only_lab)

    # 7. 대조 — 정책 스위치와 이름 풀이 규칙을 뺀 Chrome에서는 STUN이 나가고 TURN 이름을 DNS로 묻는다(5·8의 확인이 비어 있지 않음)
    lab.udp_hits.clear()
    control_args = [RTC_LOOPBACK_ARG, "--webrtc-ip-handling-policy=default"]
    with tempfile.TemporaryDirectory(prefix="selfcheck-control-") as scratch:
        profile, netlog = os.path.join(scratch, "profile"), os.path.join(scratch, "netlog.json")
        if not networked:
            # 뒤에 온 같은 스위치가 앞의 것을 덮습니다 — 이름 풀이 규칙을 아무 이름에도 걸리지 않는 것으로.
            control_args += ["--host-resolver-rules=MAP selfcheck-unused.invalid ~NOTFOUND", f"--log-net-log={netlog}"]
        with egress.EgressFilter(lifetime_seconds=WATCHDOG_SECONDS, **only_lab) as gate, sync_playwright() as playwright:
            context = driver.launch(playwright, gate.url, profile_dir=profile, extra_args=tuple(control_args))
            try:
                page = context.pages[0] if context.pages else context.new_page()
                _page_result(page, lab.url("/rtc-without-names" if networked else "/rtc"))
                _wait_for(lambda: any("STUN" in hit for hit in lab.udp_hits) and (networked or TURN_NAME in gate.blocked_hosts()),
                          at_least=1.0, at_most=20.0)
                stun = sorted({hit for hit in lab.udp_hits if "STUN" in hit})
                report.line(bool(stun), "7. 대조: 정책 스위치를 뺀 Chrome에서는 STUN이 나감(5의 확인이 살아 있음)",
                            f"UDP가 받음 {sorted(set(lab.udp_hits))}")
            finally:
                context.close()
        if networked:
            print("참고: 컨테이너에 망이 있어 DNS 대조는 건너뜀(풀이 서버에 질문이 나가지 않게) — 8의 확인이 살아 있는지는 망 없는 컨테이너에서 봅니다", flush=True)
        else:
            lookups = _own_lookups(netlog) or []
            asked = sorted({line for line in lookups if TURN_NAME in line})
            report.line(bool(asked), "7. 대조: 이름 풀이 규칙을 뺀 Chrome은 TURN 이름을 DNS로 물음(8의 확인이 살아 있음)",
                        f"넷로그의 이름 풀이 {asked or sorted(set(lookups))}")

    noise = sorted({line for line in blocked_log
                    if not any(mark in line for mark in (FORBIDDEN_ADDRESS, TURN_ADDRESS, ICE_TCP_ADDRESS, TURN_NAME, LINK_LOCAL, "localhost"))})
    if noise:
        print(f"참고: 그 밖에 프록시가 막은 것(Chrome 자신의 요청 — 이 확인은 이름을 풀지 않음): {noise}", flush=True)
    print("결과: " + ("통과" if report.failed == 0 else f"실패 {report.failed}건"), flush=True)
    return 0 if report.failed == 0 else 1


def main() -> int:
    def give_up() -> None:
        print(f"✗ {WATCHDOG_SECONDS}초 안에 끝나지 않음", flush=True)
        os._exit(2)

    watchdog = threading.Timer(WATCHDOG_SECONDS, give_up)
    watchdog.daemon = True
    watchdog.start()
    try:
        return run()
    finally:
        watchdog.cancel()


if __name__ == "__main__":
    sys.exit(main())
