"""
sidecar/selfcheck.py
이미지 안 확인 — 실제 Chrome과 필터 프록시로 '막아야 할 목적지가 요청을 받지 않는가'를 봅니다 (ADR 0026 덧붙임 2026-11-12, QA-414).

    xvfb-run -a python -m sidecar.selfcheck        # 브라우저 컨테이너 이미지 안에서. 통과하면 0, 아니면 1

밖으로 나가는 요청이 없습니다. 이 프로세스가 컨테이너 루프백에 띄우는 서버만 씁니다 — '허용' 서버 A는 127.0.0.1, '금지' 서버 B는 127.0.0.2.
프록시의 검사 함수를 'A의 주소만 허용'으로 바꿔 끼우고(운영 기본값은 전역 주소 검사 — 그 규칙 자체는 tests/test_sidecar_egress.py가 고정)
이름 풀이는 꺼 둡니다. Chrome은 운영과 같은 함수(:func:`sidecar.driver.launch`)로 띄웁니다. 단위 시험이 볼 수 없는 것 — Chrome이 정말로
모든 요청을 프록시로 보내는가 — 을 여기서 봅니다. 망이 없는 컨테이너(``docker run --network none``)에서도 돕니다.

확인하는 것
  0. Chrome의 실제 명령줄에 프록시 주소와 ``<-loopback>``이 있다.
  1. 허용 목적지의 페이지가 뜬다(드라이버의 페이지 받기 ``_load`` 그대로 — 요청 가로채기 포함).
  2. 최상위 302 → 금지 주소: 가로채기는 그 홉을 보지 못해도 B는 요청을 받지 않는다.
  3. 하위 요청(이미지)의 302 → 금지 주소: B는 받지 않는다.
  4. 스크립트의 fetch·웹소켓이 금지 주소로 가도 B는 받지 않는다. 링크 로컬(169.254.169.254)·localhost행도 프록시로 와서 막힌다
     (Chrome의 암묵 우회가 꺼져 있음). 허용 주소의 웹소켓은 프록시를 지나 연결된다.
  5. 프록시가 보지 못하는 UDP(WebRTC의 STUN, WebTransport의 QUIC)가 나가지 않는다.
  6. 프록시가 닫히면 Chrome의 요청은 실패한다(직접 나가지 않음).
  7. 대조: WebRTC 정책 스위치를 뺀 Chrome에서는 STUN이 나간다 — 5의 확인이 비어 있지 않음을 보입니다(Chrome 스위치 이름이 바뀌면 여기나 5가 실패).

5·7은 WebRTC가 루프백에서 후보를 모으게 하는 확인 전용 인자(``--allow-loopback-in-peer-connection``)를 더해 띄웁니다. 망 없는 컨테이너에는
루프백뿐이라 그 인자 없이는 WebRTC가 아무것도 보내지 않습니다.
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

from . import driver, egress, guard

ALLOWED_ADDRESS = "127.0.0.1"
FORBIDDEN_ADDRESS = "127.0.0.2"
LINK_LOCAL = "169.254.169.254"
WATCHDOG_SECONDS = 240
RTC_LOOPBACK_ARG = "--allow-loopback-in-peer-connection"
MARK = "selfcheck-allowed-page"

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

_UDP_PAGE = """<html><body>udp<script>
(async () => {
  const out = {};
  const within = (promise, ms) => Promise.race([promise, new Promise((done) => setTimeout(() => done('timeout'), ms))]);
  try {
    const pc = new RTCPeerConnection({iceServers: [{urls: ['stun:%(forbidden)s:%(u_forbidden)d', 'stun:%(allowed)s:%(u_allowed)d']}]});
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((done) => setTimeout(done, %(rtc_ms)d));
    out.webrtc = 'gathering started';
  } catch (e) { out.webrtc = 'error ' + e.name; }
  try {
    if (typeof WebTransport === 'undefined') out.webtransport = 'no api';
    else out.webtransport = await within(new WebTransport('https://%(forbidden)s:%(u_forbidden)d/x').ready.then(() => 'ready', () => 'failed'), 3000);
  } catch (e) { out.webtransport = 'error ' + e.name; }
  document.body.setAttribute('data-out', JSON.stringify(out)); document.title = 'done';
})();
</script></body></html>"""


class _Lab:
    """루프백의 서버들 — 허용 A(http·웹소켓), 금지 B(http — 받은 것을 전부 적음), UDP 둘(받은 것을 적음)."""

    def __init__(self) -> None:
        self.hits_a: list[str] = []
        self.hits_b: list[str] = []
        self.udp_hits: list[str] = []
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
                ports = {"allowed": ALLOWED_ADDRESS, "forbidden": FORBIDDEN_ADDRESS, "link_local": LINK_LOCAL, "a": lab.port_a,
                         "b": lab.port_b, "u_forbidden": lab.port_udp_forbidden, "u_allowed": lab.port_udp_allowed}
                if self.path == "/sub":
                    body = '<html><body><img src="/img-redirect">sub</body></html>'
                elif self.path == "/script":
                    body = _SCRIPT_PAGE % ports
                elif self.path.startswith("/udp"):
                    body = _UDP_PAGE % {**ports, "rtc_ms": 2500}
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
    wanted = (b"--proxy", b"--webrtc", b"--disable-quic", b"--no-proxy")
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


def _short(text: object, lab: _Lab) -> str:
    return str(text).splitlines()[0][:150].replace(f":{lab.port_a}", ":A").replace(f":{lab.port_b}", ":B")


def _allow_lab_at_the_request_layer() -> None:
    """
    이 프로세스 안에서만, 요청 가로채기의 규칙을 '허용 서버 A는 지나감'으로 바꿉니다(운영 규칙은 https·전역 주소라 루프백 서버를 쓸 수 없음).

    가로채기가 금지 주소 B를 **첫 요청으로는** 막고 A는 지나가게 두어, B로 가는 것은 리다이렉트 홉(가로채기가 보지 못하는 길)뿐이게 합니다.
    """
    guard.top_level_allowed = lambda url, allowed: (urlsplit(url).hostname or "") in allowed
    guard.destination_allowed = lambda url, resolve=None: (urlsplit(url).hostname or "") == ALLOWED_ADDRESS


def run() -> int:
    from patchright.sync_api import Error as BrowserError
    from patchright.sync_api import sync_playwright

    blocked_log: list[str] = []
    logging.getLogger("sidecar").addHandler(_Collect(blocked_log))      # '막은 목적지' 줄은 모아 두었다가 끝에 한 번에
    logging.getLogger("sidecar").propagate = False

    lab = _Lab()
    report = _Report()
    only_lab = {"resolve": lambda name: [], "allow": lambda address: address == ALLOWED_ADDRESS}
    print(f"patchright {version('patchright')} · 허용 A={ALLOWED_ADDRESS} · 금지 B={FORBIDDEN_ADDRESS} · 샌드박스 {'켬' if driver.SANDBOX else '끔'}", flush=True)

    with tempfile.TemporaryDirectory(prefix="selfcheck-profile-") as profile, \
            egress.EgressFilter(lifetime_seconds=WATCHDOG_SECONDS, **only_lab) as gate, sync_playwright() as playwright:
        context = driver.launch(playwright, gate.url, profile_dir=profile, extra_args=(RTC_LOOPBACK_ARG,))
        try:
            page = context.pages[0] if context.pages else context.new_page()
            print(f"  {page.evaluate('navigator.userAgent')}", flush=True)

            flags = _chrome_flags(profile)
            report.line(f"--proxy-server={gate.url}" in flags and f"--proxy-bypass-list={driver.PROXY_BYPASS}" in flags
                        and all(arg in flags for arg in driver.EGRESS_ARGS) and not any(flag.startswith("--no-proxy") for flag in flags),
                        "0. Chrome 명령줄의 프록시·UDP 인자", " ".join(flag.replace(gate.url, "http://127.0.0.1:<포트>") for flag in flags))

            # 3. 하위 요청의 리다이렉트 (가로채기 없이 — 프록시만으로)
            page.goto(lab.url("/sub"), wait_until="load", timeout=30_000)
            page.wait_for_timeout(800)
            report.line("/img-redirect" in lab.hits_a and lab.hits_b == [], "3. 하위 요청의 302 → 금지 주소: B가 받지 않음",
                        f"A가 받음 {lab.hits_a[-2:]}, B가 받음 {lab.hits_b}")

            # 4. 스크립트의 fetch·웹소켓
            lab.hits_b.clear()
            seen = _page_result(page, lab.url("/script"))
            blocked = gate.blocked_hosts()
            report.line(lab.hits_b == [] and seen.get("wsForbidden") == "error", "4. fetch·웹소켓의 금지 주소행: B가 받지 않음",
                        f"B가 받음 {lab.hits_b}, 페이지가 본 것 {seen}")
            report.line({FORBIDDEN_ADDRESS, LINK_LOCAL, "localhost"} <= blocked,
                        "4. 루프백·링크 로컬·localhost행도 프록시로 와서 막힘", f"프록시가 막은 호스트 {sorted(blocked)}")
            report.line(seen.get("wsAllowed") == "message:hello" and "/ws" in lab.hits_a, "4. 허용 주소의 웹소켓은 프록시를 지나 연결됨",
                        str(seen.get("wsAllowed")))

            # 5. UDP
            seen = _page_result(page, lab.url("/udp"))
            report.line(lab.udp_hits == [], "5. WebRTC(STUN)·WebTransport(QUIC)의 UDP가 나가지 않음",
                        f"UDP가 받음 {sorted(set(lab.udp_hits))}, 페이지가 본 것 {seen}")

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
            report.line("/top-redirect" in lab.hits_a and lab.hits_b == [] and not reached,
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

    # 7. 대조 — WebRTC 정책 스위치를 뺀 Chrome에서는 STUN이 나간다(5의 확인이 비어 있지 않음)
    lab.udp_hits.clear()
    with tempfile.TemporaryDirectory(prefix="selfcheck-control-") as profile, \
            egress.EgressFilter(lifetime_seconds=WATCHDOG_SECONDS, **only_lab) as gate, sync_playwright() as playwright:
        context = driver.launch(playwright, gate.url, profile_dir=profile,
                                extra_args=(RTC_LOOPBACK_ARG, "--webrtc-ip-handling-policy=default"))
        try:
            page = context.pages[0] if context.pages else context.new_page()
            _page_result(page, lab.url("/udp"))
            stun = sorted({hit for hit in lab.udp_hits if "STUN" in hit})
            report.line(bool(stun), "7. 대조: 정책 스위치를 뺀 Chrome에서는 STUN이 나감(5의 확인이 살아 있음)", f"UDP가 받음 {sorted(set(lab.udp_hits))}")
        finally:
            context.close()

    noise = sorted({line for line in blocked_log if not any(mark in line for mark in (FORBIDDEN_ADDRESS, LINK_LOCAL, "localhost"))})
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
