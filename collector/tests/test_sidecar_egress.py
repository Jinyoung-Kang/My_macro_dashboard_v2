"""
tests/test_sidecar_egress.py
브라우저 컨테이너의 나가는 길 필터 프록시 (collector/sidecar/egress.py — ADR 0026 덧붙임 2026-11-12, QA-414).

고정하는 규칙
  1. 127.0.0.1에만 엽니다(다른 주소에 열 방법이 없음).
  2. 목적지가 전역 주소가 아니면 — IP 글자든, 이름이 그런 주소로 풀리든, 여러 주소 중 하나만 그렇든, 풀리지 않든 — ``CONNECT``도 평문
     요청도 403이고 아무 데도 붙지 않습니다. 로그에는 호스트만 남습니다.
  3. 검사한 주소로만 붙습니다. 이름을 다시 풀지 않으므로 풀이 결과가 그 뒤에 바뀌어도(DNS 재결합) 따라가지 않습니다.
  4. ``CONNECT`` 터널은 바이트를 그대로 넘깁니다. 평문 http 전달은 머리글을 더하지 않고, 연결 하나에 요청 하나만 넘깁니다.
  5. 연결 수·수명 상한이 있고, 닫으면 열린 터널도 끊기며 그 뒤에는 붙을 수 없습니다(닫힌 쪽으로 실패).

브라우저 없이 소켓으로 돕니다. 루프백의 시험 서버를 '허용 목적지'로 쓰려고 검사 함수(``allow``)를 바꿔 끼웁니다 — 운영 기본값은
``guard.is_global_address``이고 그것도 여기서 고정합니다.
"""
from __future__ import annotations

import inspect
import logging
import socket
import threading
import time

import pytest

from sidecar import egress, guard

NOT_GLOBAL = [
    "10.0.0.5", "172.18.0.3", "192.168.1.1",         # 사설(도커 망 포함)
    "127.0.0.1", "::1",                              # 루프백
    "169.254.169.254", "fe80::1",                    # 링크 로컬(클라우드 메타데이터)
    "100.64.0.1",                                    # CGNAT — tailnet 주소 대역의 문서용 예시
    "fd7a:115c:a1e0::1",                             # IPv6 내부(tailnet)
    "0.0.0.0", "224.0.0.1", "240.0.0.1",             # 미지정·멀티캐스트·예약
    "::ffff:10.0.0.5", "::ffff:169.254.169.254",     # IPv4를 감싼 IPv6
]


class Upstream:
    """루프백의 시험 서버 — 받은 바이트를 연결마다 적고, 정해 둔 답을 보내거나(``reply``) 받은 대로 되돌립니다(``echo``)."""

    def __init__(self, address: str = "127.0.0.1", *, reply: bytes | None = None, echo: bool = False) -> None:
        self.reply = reply
        self.echo = echo
        self.received: list[bytes] = []
        self._server = socket.create_server((address, 0))
        self._server.settimeout(0.2)
        self.address, self.port = self._server.getsockname()[:2]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            index = len(self.received)
            self.received.append(b"")
            threading.Thread(target=self._serve, args=(conn, index), daemon=True).start()

    def _serve(self, conn: socket.socket, index: int) -> None:
        conn.settimeout(5)
        try:
            while True:
                data = conn.recv(65536)
                if not data:
                    break
                self.received[index] += data
                if self.echo:
                    conn.sendall(data)
                elif self.reply is not None and b"\r\n\r\n" in self.received[index]:
                    conn.sendall(self.reply)
                    break
        except OSError:
            pass
        finally:
            conn.close()

    def close(self) -> None:
        self._stop.set()
        self._server.close()


@pytest.fixture
def upstreams():
    made: list[Upstream] = []

    def make(*args, **kwargs) -> Upstream:
        made.append(Upstream(*args, **kwargs))
        return made[-1]

    yield make
    for upstream in made:
        upstream.close()


@pytest.fixture
def gates():
    made: list[egress.EgressFilter] = []

    def make(**kwargs) -> egress.EgressFilter:
        kwargs.setdefault("lifetime_seconds", 30.0)
        made.append(egress.EgressFilter(**kwargs))
        return made[-1]

    yield make
    for gate in made:
        gate.close()


def _never_dial(address: str, port: int) -> socket.socket:
    raise AssertionError(f"막아야 할 목적지에 붙으려 함: {address}")


def _never_resolve(name: str) -> list[str]:
    raise AssertionError(f"IP 글자는 풀지 않습니다: {name}")


def _send(gate: egress.EgressFilter, payload: bytes, *, read_all: bool = True) -> bytes:
    """프록시에 붙어 ``payload``를 보내고 상대가 닫을 때까지 받은 것."""
    with socket.create_connection(gate.address, timeout=5) as conn:
        conn.sendall(payload)
        if not read_all:
            return conn.recv(65536)
        chunks = []
        while True:
            data = conn.recv(65536)
            if not data:
                break
            chunks.append(data)
        return b"".join(chunks)


def _bracket(address: str) -> str:
    return f"[{address}]" if ":" in address else address


def _status(answer: bytes) -> int:
    return int(answer.split(b" ", 2)[1])


# ==============================================================================
# 1. 여는 곳
# ==============================================================================
def test_127_0_0_1에만_열고_포트는_그때그때_받는다(gates):
    first, second = gates(), gates()

    assert first.address[0] == second.address[0] == "127.0.0.1"
    assert first.address[1] != second.address[1] and first.address[1] > 0
    assert first.url == f"http://127.0.0.1:{first.address[1]}"
    assert egress.BIND_HOST == "127.0.0.1"
    assert "host" not in inspect.signature(egress.EgressFilter).parameters, "다른 주소에 여는 인자를 두지 않습니다"


def test_이_기계의_다른_주소로는_프록시에_붙을_수_없다(gates):
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))          # 문서용 주소 — 보내는 것은 없고 나갈 때 쓸 이 기계의 주소만 알아냅니다
        own = probe.getsockname()[0]
    except OSError:
        pytest.skip("루프백 말고는 주소가 없는 환경")
    finally:
        probe.close()
    if own.startswith("127."):
        pytest.skip("루프백 말고는 주소가 없는 환경")
    gate = gates()

    with pytest.raises(OSError):
        socket.create_connection((own, gate.address[1]), timeout=2).close()


def test_운영_기본값은_시스템_이름_풀이와_전역_주소_검사():
    parameters = inspect.signature(egress.EgressFilter).parameters

    assert parameters["allow"].default is guard.is_global_address
    assert parameters["resolve"].default is guard.system_resolver


# ==============================================================================
# 2. 전역 주소가 아닌 목적지
# ==============================================================================
@pytest.mark.parametrize("address", NOT_GLOBAL)
def test_QA414_전역_주소가_아닌_IP로의_CONNECT와_평문_요청을_막는다(gates, address):
    gate = gates(resolve=_never_resolve, dial=_never_dial)
    host = _bracket(address)

    tunnel = _send(gate, f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode())
    plain = _send(gate, f"GET http://{host}/latest/meta-data/?x=1 HTTP/1.1\r\nHost: {host}\r\n\r\n".encode())

    assert _status(tunnel) == 403 and _status(plain) == 403
    assert gate.blocked_hosts() == {address.lower()} and gate.passed_hosts() == frozenset()


@pytest.mark.parametrize("address", NOT_GLOBAL)
def test_QA414_이름이_전역_아닌_주소로_풀리면_막는다(gates, address):
    gate = gates(resolve=lambda name: [address], dial=_never_dial)

    assert _status(_send(gate, b"CONNECT internal.example.org:443 HTTP/1.1\r\n\r\n")) == 403
    assert _status(_send(gate, b"GET http://internal.example.org/x HTTP/1.1\r\nHost: internal.example.org\r\n\r\n")) == 403


def test_QA414_여러_주소_중_하나만_내부여도_풀리지_않아도_막는다(gates):
    answers = {"mixed.example.org": ["8.8.8.8", "10.0.0.5"], "nowhere.example.org": []}
    gate = gates(resolve=lambda name: answers[name], dial=_never_dial)

    assert _status(_send(gate, b"CONNECT mixed.example.org:443 HTTP/1.1\r\n\r\n")) == 403
    assert _status(_send(gate, b"CONNECT nowhere.example.org:443 HTTP/1.1\r\n\r\n")) == 403
    assert gate.blocked_hosts() == {"mixed.example.org", "nowhere.example.org"}


def test_QA414_기본_검사로는_루프백의_서버에_닿지_못한다(gates, upstreams):
    """검사 함수를 바꿔 끼우지 않은 운영 기본값 — 실제로 열려 있는 루프백 서버도 요청을 받지 못합니다."""
    secret = upstreams(reply=b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecret")
    gate = gates()

    tunnel = _send(gate, f"CONNECT 127.0.0.1:{secret.port} HTTP/1.1\r\n\r\n".encode())
    plain = _send(gate, f"GET http://localhost:{secret.port}/status HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())

    assert _status(tunnel) == 403 and _status(plain) == 403 and b"secret" not in tunnel + plain
    assert secret.received == [], "목적지는 연결조차 받지 않습니다"


def test_막은_목적지는_호스트만_한_번_로그에_남긴다(gates, caplog):
    gate = gates(resolve=lambda name: ["10.0.0.5"], dial=_never_dial)

    with caplog.at_level(logging.WARNING, logger="sidecar.egress"):
        for _ in range(3):
            _send(gate, b"GET http://internal.example.org:8000/admin/secret-path?token=abc HTTP/1.1\r\n"
                        b"Host: internal.example.org:8000\r\nCookie: session=xyz\r\n\r\n")

    assert [record.getMessage() for record in caplog.records] == ["막은 목적지: internal.example.org"]
    assert not any(mark in caplog.text for mark in ("secret-path", "token", "8000", "session", "10.0.0.5"))


@pytest.mark.parametrize("payload", [
    b"GET / HTTP/1.1\r\nHost: 8.8.8.8\r\n\r\n",                        # 절대 주소가 아님(프록시에게 온 요청이 아님)
    b"GET https://8.8.8.8/x HTTP/1.1\r\n\r\n",                         # https는 CONNECT로만
    b"GET ftp://8.8.8.8/x HTTP/1.1\r\n\r\n",
    b"CONNECT 8.8.8.8 HTTP/1.1\r\n\r\n",                               # 포트 없음
    b"CONNECT 8.8.8.8:0 HTTP/1.1\r\n\r\n",
    b"CONNECT user@8.8.8.8:443 HTTP/1.1\r\n\r\n",
    b"CONNECT 8.8.8.8:443\r\n\r\n",                                    # 요청 줄 모양이 아님
    b"GET http://exa mple.org/ HTTP/1.1\r\n\r\n",
    "GET http://예시.example/ HTTP/1.1\r\n\r\n".encode(),              # 브라우저는 이름을 ASCII(퓨니코드)로 보냅니다
    b"GET http://8.8.8.8/x HTTP/1.1\r\nno-colon-line\r\n\r\n",
    b"POST http://8.8.8.8/x HTTP/1.1\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc",
    b"POST http://8.8.8.8/x HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
])
def test_모양이_아닌_요청은_400이고_어디에도_붙지_않는다(gates, payload):
    gate = gates(resolve=_never_resolve, dial=_never_dial)

    assert _status(_send(gate, payload)) == 400


def test_조각_전송_본문과_너무_긴_머리는_받지_않는다(gates):
    gate = gates(resolve=_never_resolve, dial=_never_dial)

    chunked = _send(gate, b"POST http://8.8.8.8/x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
    assert _status(chunked) == 501
    with socket.create_connection(gate.address, timeout=5) as conn:
        try:
            conn.sendall(b"GET http://8.8.8.8/x HTTP/1.1\r\nX-Pad: " + b"a" * (egress.MAX_HEAD_BYTES + 1024))
            conn.settimeout(5)
            answer = conn.recv(65536)
        except OSError:
            answer = b""                     # 답을 다 쓰기 전에 끊긴 것도 '받지 않음'입니다
    assert answer == b"" or _status(answer) == 431


# ==============================================================================
# 3. 검사한 주소로만 붙는다
# ==============================================================================
def test_QA414_검사한_주소로만_붙고_풀이가_그_뒤에_바뀌어도_따라가지_않는다(gates, upstreams):
    """
    DNS 재결합 — 첫 풀이는 허용 주소(A), 그 뒤의 풀이는 금지 주소(B)를 줍니다. 프록시는 검사한 A에만 붙고, 같은 이름의 다음 연결도
    처음 검사한 주소를 씁니다. B는 아무것도 받지 않습니다.
    """
    ok = upstreams("127.0.0.1", echo=True)
    internal = upstreams("127.0.0.2", echo=True)
    calls: list[str] = []

    def rebinding(name: str) -> list[str]:
        calls.append(name)
        return ["127.0.0.1"] if len(calls) == 1 else ["127.0.0.2"]

    dialed: list[str] = []

    def dial(address: str, port: int) -> socket.socket:
        dialed.append(address)
        target = ok if address == "127.0.0.1" else internal
        return socket.create_connection((address, target.port), timeout=5)

    gate = gates(resolve=rebinding, allow=lambda address: address == "127.0.0.1", dial=dial)

    for _ in range(2):
        with socket.create_connection(gate.address, timeout=5) as conn:
            conn.sendall(b"CONNECT rebind.example.org:443 HTTP/1.1\r\n\r\n")
            assert conn.recv(4096) == b"HTTP/1.1 200 Connection established\r\n\r\n"
            conn.sendall(b"ping")
            assert conn.recv(4096) == b"ping"

    assert dialed == ["127.0.0.1", "127.0.0.1"], "붙는 곳은 검사한 주소 글자 — 이름을 넘기지 않습니다"
    assert calls == ["rebind.example.org"], "프록시 하나의 수명 동안 이름은 한 번만 풉니다"
    assert internal.received == []


def test_풀이가_금지_주소로_바뀐_새_프록시에서는_막는다(gates):
    gate = gates(resolve=lambda name: ["127.0.0.2"], allow=lambda address: address == "127.0.0.1", dial=_never_dial)

    assert _status(_send(gate, b"CONNECT rebind.example.org:443 HTTP/1.1\r\n\r\n")) == 403


def test_붙을_때는_IPv4를_먼저_쓰고_안_되면_다음_검사한_주소로(gates, upstreams):
    ok = upstreams(echo=True)
    tried: list[str] = []

    def dial(address: str, port: int) -> socket.socket:
        tried.append(address)
        if address != "127.0.0.1":
            raise OSError("닿지 않음")
        return socket.create_connection((address, ok.port), timeout=5)

    gate = gates(resolve=lambda name: ["2001:db8::1", "192.0.2.7", "127.0.0.1"], allow=lambda address: True, dial=dial)

    assert _send(gate, b"CONNECT multi.example.org:443 HTTP/1.1\r\n\r\n", read_all=False).startswith(b"HTTP/1.1 200")
    assert tried == ["192.0.2.7", "127.0.0.1"]


def test_검사는_지났지만_붙지_못하면_502(gates):
    def refuse(address: str, port: int) -> socket.socket:
        raise ConnectionRefusedError

    gate = gates(resolve=_never_resolve, allow=lambda address: True, dial=refuse)

    assert _status(_send(gate, b"CONNECT 127.0.0.1:9 HTTP/1.1\r\n\r\n")) == 502
    assert gate.blocked_hosts() == frozenset(), "출구가 막은 것이 아니라 목적지가 받지 않은 것"


# ==============================================================================
# 4. 바이트 그대로
# ==============================================================================
def test_허용된_목적지의_터널은_바이트를_그대로_넘긴다(gates, upstreams):
    echo = upstreams(echo=True)
    gate = gates(allow=lambda address: address == "127.0.0.1")
    blob = bytes(range(256)) * 1200                     # 약 300KB — 0x00~0xFF 전부

    with socket.create_connection(gate.address, timeout=5) as conn:
        conn.sendall(f"CONNECT 127.0.0.1:{echo.port} HTTP/1.1\r\nHost: 127.0.0.1:{echo.port}\r\n"
                     "Proxy-Connection: keep-alive\r\n\r\n".encode())
        assert conn.recv(4096) == b"HTTP/1.1 200 Connection established\r\n\r\n", "답은 상태 줄 하나 — 머리글을 더하지 않습니다"
        sender = threading.Thread(target=lambda: (conn.sendall(blob), conn.shutdown(socket.SHUT_WR)))
        sender.start()
        back = b""
        while True:
            data = conn.recv(65536)
            if not data:
                break
            back += data
        sender.join(timeout=5)

    assert back == blob
    assert echo.received == [blob], "CONNECT 요청 머리는 목적지에 가지 않고, 그 뒤의 바이트만 그대로 갑니다"
    assert gate.passed_hosts() == {"127.0.0.1"}


def test_평문_요청은_머리글을_더하지_않고_원_서버_모양으로_넘긴다(gates, upstreams):
    body = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-From: origin\r\nConnection: close\r\n\r\nhello"
    origin = upstreams(reply=body)
    gate = gates(allow=lambda address: address == "127.0.0.1")

    answer = _send(gate, (
        f"GET http://127.0.0.1:{origin.port}/feed/atom.xml?page=2&q=a%20b HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{origin.port}\r\n"
        "Proxy-Connection: keep-alive\r\n"
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/157.0.0.0\r\n"
        "Accept: text/html,*/*;q=0.8\r\n"
        "Proxy-Authorization: Basic xxxx\r\n"
        "Accept-Encoding: gzip, deflate\r\n"
        "Cookie: a=1; b=2\r\n\r\n").encode())

    assert answer == body, "답은 원 서버가 보낸 바이트 그대로"
    assert origin.received == [(
        "GET /feed/atom.xml?page=2&q=a%20b HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{origin.port}\r\n"
        "Connection: close\r\n"
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/157.0.0.0\r\n"
        "Accept: text/html,*/*;q=0.8\r\n"
        "Accept-Encoding: gzip, deflate\r\n"
        "Cookie: a=1; b=2\r\n\r\n").encode()], "프록시에게 하는 머리글만 빠지고 순서·글자는 그대로"
    lowered = origin.received[0].lower()
    assert not any(mark in lowered for mark in (b"via:", b"x-forwarded", b"forwarded:", b"proxy-", b"x-real-ip"))


@pytest.mark.parametrize("target, path", [
    ("http://127.0.0.1:{port}", "/"),
    ("http://127.0.0.1:{port}?a=1", "/?a=1"),
    ("HTTP://127.0.0.1:{port}/A/b", "/A/b"),
])
def test_평문_요청의_경로는_절대_주소에서_그대로_떼어_낸다(gates, upstreams, target, path):
    origin = upstreams(reply=b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
    gate = gates(allow=lambda address: address == "127.0.0.1")

    _send(gate, f"GET {target.format(port=origin.port)} HTTP/1.1\r\nHost: x\r\n\r\n".encode())

    assert origin.received[0].split(b"\r\n")[0] == f"GET {path} HTTP/1.1".encode()
    assert origin.received[0].endswith(b"Host: x\r\nConnection: close\r\n\r\n"), "Connection 줄이 없던 요청에는 끝에 하나"


def test_평문_요청은_연결_하나에_요청_하나만_넘긴다(gates, upstreams):
    """본문은 Content-Length만큼만 넘깁니다. 같은 연결에 이어 온 다음 요청(다른 호스트일 수 있음)은 넘기지 않고 끊습니다."""
    origin = upstreams()                                  # 답하지 않는 서버 — 연결을 열어 둔 채 받기만 합니다
    gate = gates(allow=lambda address: address == "127.0.0.1")
    first = f"POST http://127.0.0.1:{origin.port}/submit HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n".encode()

    with socket.create_connection(gate.address, timeout=5) as conn:
        conn.sendall(first + b"he")
        conn.sendall(b"llo")
        deadline = time.monotonic() + 5
        while not (origin.received and origin.received[0].endswith(b"hello")) and time.monotonic() < deadline:
            time.sleep(0.02)
        conn.sendall(b"GET http://10.0.0.5/admin HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n")
        conn.settimeout(5)
        assert conn.recv(4096) == b"", "다음 요청을 받으면 연결을 끊습니다"

    assert len(origin.received) == 1 and origin.received[0].endswith(b"\r\n\r\nhello")
    assert b"10.0.0.5" not in origin.received[0]

    glued = _send(gate, first + b"hello" + b"GET http://10.0.0.5/admin HTTP/1.1\r\n\r\n")
    assert _status(glued) == 400 and len(origin.received) == 1, "한 번에 이어 붙여 보낸 것도 넘기지 않습니다"


# ==============================================================================
# 5. 상한과 닫기
# ==============================================================================
def test_닫으면_열린_터널이_끊기고_그_뒤에는_붙을_수_없다(gates, upstreams):
    echo = upstreams(echo=True)
    gate = gates(allow=lambda address: address == "127.0.0.1")
    conn = socket.create_connection(gate.address, timeout=5)
    conn.sendall(f"CONNECT 127.0.0.1:{echo.port} HTTP/1.1\r\n\r\n".encode())
    assert conn.recv(4096).startswith(b"HTTP/1.1 200")
    conn.sendall(b"alive")
    assert conn.recv(4096) == b"alive"

    gate.close()
    gate.close()                                          # 여러 번 불러도 됩니다

    try:
        assert conn.recv(4096) == b"", "브라우저가 닫히면 열린 터널도 정리됩니다"
    except OSError:
        pass                                              # 끊김(RST)으로 보여도 같습니다
    finally:
        conn.close()
    assert gate.closed
    with pytest.raises(OSError):
        socket.create_connection(gate.address, timeout=2).close()


def test_수명_상한을_넘기면_스스로_닫힌다(gates, upstreams):
    echo = upstreams(echo=True)
    gate = gates(lifetime_seconds=0.6, allow=lambda address: address == "127.0.0.1")
    conn = socket.create_connection(gate.address, timeout=5)
    conn.sendall(f"CONNECT 127.0.0.1:{echo.port} HTTP/1.1\r\n\r\n".encode())
    assert conn.recv(4096).startswith(b"HTTP/1.1 200")

    try:
        assert conn.recv(4096) == b""                     # 수명이 다하면 터널이 끊깁니다(최대 5초 기다림)
    except socket.timeout:
        pytest.fail("수명 상한이 지나도 터널이 열려 있음")
    except OSError:
        pass
    finally:
        conn.close()
    deadline = time.monotonic() + 3
    while not gate.closed and time.monotonic() < deadline:
        time.sleep(0.05)
    assert gate.closed
    with pytest.raises(OSError):
        socket.create_connection(gate.address, timeout=2).close()


def test_연결_수_상한을_넘으면_503(gates, upstreams, monkeypatch):
    monkeypatch.setattr(egress, "MAX_CONNECTIONS", 2)
    echo = upstreams(echo=True)
    gate = gates(allow=lambda address: address == "127.0.0.1")
    held = []
    for _ in range(2):
        conn = socket.create_connection(gate.address, timeout=5)
        conn.sendall(f"CONNECT 127.0.0.1:{echo.port} HTTP/1.1\r\n\r\n".encode())
        assert conn.recv(4096).startswith(b"HTTP/1.1 200")
        held.append(conn)

    assert _status(_send(gate, f"CONNECT 127.0.0.1:{echo.port} HTTP/1.1\r\n\r\n".encode())) == 503

    held.pop().close()
    deadline = time.monotonic() + 5
    answer = b""
    while time.monotonic() < deadline:
        answer = _send(gate, f"CONNECT 127.0.0.1:{echo.port} HTTP/1.1\r\n\r\n".encode(), read_all=False)
        if answer.startswith(b"HTTP/1.1 200"):
            break
        time.sleep(0.05)
    assert answer.startswith(b"HTTP/1.1 200"), "자리가 나면 다시 받습니다"
    for conn in held:
        conn.close()


def test_프록시는_표준_라이브러리와_guard만_가져온다():
    import ast
    from pathlib import Path

    tree = ast.parse((Path(egress.__file__)).read_text(encoding="utf-8"))
    imported = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    imported |= {(node.module or "").split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level == 0}
    relative = {alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level == 1 for alias in node.names}

    assert imported <= set(sys_stdlib()), f"표준 라이브러리 밖의 모듈: {sorted(imported - set(sys_stdlib()))}"
    assert relative == {"guard"}


def sys_stdlib() -> frozenset[str]:
    import sys

    return sys.stdlib_module_names
