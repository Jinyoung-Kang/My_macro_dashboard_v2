"""
sidecar/egress.py
브라우저의 나가는 길 — 컨테이너 루프백에만 여는 작은 필터 프록시 (ADR 0026 덧붙임 2026-11-12, QA-414).

요청 가로채기(driver의 route 처리기)는 리다이렉트로 이어진 요청과 웹소켓에는 불리지 않고, 이름을 검사한 시점과 Chrome이 붙는 시점 사이에
주소가 바뀌는 것도 막지 못합니다. 그래서 Chrome을 이 프록시로만 나가게 하고, 연결마다 여기서 목적지를 다시 봅니다.

  - 연결마다(https·웹소켓은 ``CONNECT``, 평문 http는 절대 주소 요청) 목적지 이름을 **여기서** 풀고, 풀린 주소가 전부 전역 주소일 때만
    (:func:`guard.checked_addresses` — 가로채기와 같은 규칙) **그 검사한 주소로** 붙습니다. 이름을 다시 풀지 않습니다.
  - 막은 목적지에는 403으로 답하고 아무 데도 붙지 않습니다. 로그에는 호스트만 남깁니다(경로·쿼리·포트 없음).
  - 브라우저의 겉모습을 바꾸지 않습니다. ``CONNECT`` 터널은 바이트를 그대로 넘기고(TLS는 Chrome과 원 서버 사이 그대로), 평문 http 전달에
    ``Via``·``X-Forwarded-*`` 같은 머리글을 더하지 않습니다. 나가는 IP도 그대로입니다 — 차단을 지나가려는 수단이 아니라 목적지 제한입니다.
  - 평문 http는 연결 하나에 요청 하나만 넘깁니다(``Connection: close``, 본문은 ``Content-Length``만큼). 같은 연결에 다른 호스트의
    요청이 이어 실리는 길을 두지 않으려는 것입니다.
  - ``127.0.0.1``에만 엽니다(다른 주소에 열 방법을 두지 않음 — 컨테이너 망에 열리면 옆 컨테이너의 열린 프록시가 됩니다). 포트는 0번으로
    받아 드라이버가 그 값을 Chrome에 넘깁니다. 브라우저 한 번에 프록시 하나를 띄우고, 닫으면 열린 터널도 함께 끊깁니다. 수명 상한을 넘기면
    스스로 닫힙니다. 닫힌 뒤에는 Chrome이 프록시에 붙지 못해 요청이 실패합니다(직접 나가지 않음).

표준 라이브러리만 씁니다. 브라우저 드라이버를 가져오지 않습니다(시험이 드라이버 없이 소켓으로 돕니다).
"""
from __future__ import annotations

import logging
import re
import selectors
import socket
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from . import guard

logger = logging.getLogger("sidecar.egress")

BIND_HOST = "127.0.0.1"
# 한꺼번에 열어 두는 연결 수의 상한. 넘으면 503으로 답하고 닫습니다. 브라우저 하나가 여는 수보다 넉넉한 값입니다 — 프록시를 둔 Chrome 157은
# 호스트 60개에 동시에 60개를 열었습니다(프록시 때문에 줄 서지 않음).
MAX_CONNECTIONS = 256
# 요청 머리(요청 줄 + 머리글)의 상한과 그것을 다 받기까지의 시간, 목적지 주소 하나에 붙기까지의 시간, 붙어 볼 주소 수, 보내기가 막혔을 때의 상한.
MAX_HEAD_BYTES = 64 * 1024
HEAD_SECONDS = 15.0
CONNECT_SECONDS = 10.0
MAX_ADDRESSES = 4
SEND_SECONDS = 30.0
_CHUNK = 64 * 1024

_HOST = re.compile(r"[a-z0-9._:-]{1,255}")      # 이름·IPv4·IPv6 글자(대괄호는 뗀 뒤). 그 밖의 글자가 든 대상은 400
# 평문 http 전달에서 원 서버로 넘기지 않는 머리글(프록시에게 하는 말).
_PROXY_ONLY = (b"proxy-connection", b"proxy-authorization")

Dial = Callable[[str, int], socket.socket]
Allow = Callable[[str], bool]


class _Reject(Exception):
    """이 연결을 받지 않음 — 상태 줄을 답하고 닫습니다."""

    def __init__(self, status: int, reason: str, blocked_host: str | None = None) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason
        self.blocked_host = blocked_host


def _dial(address: str, port: int) -> socket.socket:
    return socket.create_connection((address, port), timeout=CONNECT_SECONDS)


def _no_delay(sock: socket.socket) -> None:
    """
    작은 쓰기를 모으지 않습니다(TCP_NODELAY) — Chrome이 직접 붙을 때의 소켓과 같게. 없으면 작은 쓰기가 연달아 올 때(TLS 기록, HTTP/2 프레임)
    Nagle과 상대의 늦은 ACK가 맞물려 한 번에 약 40ms씩 늦습니다.
    """
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass


class EgressFilter:
    """
    루프백의 필터 프록시 하나. 만들면 바로 듣기 시작하고 :meth:`close`(또는 ``with`` 끝)에서 열린 연결까지 닫습니다.

    ``resolve``·``allow``·``dial``은 시험과 이미지 안 확인(sidecar/selfcheck.py)이 바꿔 끼우는 자리입니다. 운영 경로(driver)는 기본값만
    씁니다 — 시스템 이름 풀이, 전역 주소 검사, 실제 연결.
    """

    def __init__(self, *, lifetime_seconds: float, resolve: guard.Resolver = guard.system_resolver,
                 allow: Allow = guard.is_global_address, dial: Dial = _dial) -> None:
        self._resolve = resolve
        self._allow = allow
        self._dial = dial
        self._deadline = time.monotonic() + lifetime_seconds
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self._sockets: set[socket.socket] = set()
        self._workers: set[threading.Thread] = set()
        self._verdicts: dict[str, tuple[str, ...]] = {}
        self._passed: set[str] = set()
        self._blocked: set[str] = set()
        self._listener = socket.create_server((BIND_HOST, 0))
        self._listener.settimeout(0.2)
        self.address: tuple[str, int] = self._listener.getsockname()[:2]
        self._acceptor = threading.Thread(target=self._accept_loop, name="egress-accept", daemon=True)
        self._acceptor.start()

    # ------------------------------------------------------------------ 바깥에서 쓰는 것
    @property
    def url(self) -> str:
        """Chrome에 넘기는 프록시 주소."""
        return f"http://{self.address[0]}:{self.address[1]}"

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def passed_hosts(self) -> frozenset[str]:
        """지나간 목적지의 호스트(진단·확인용)."""
        with self._lock:
            return frozenset(self._passed)

    def blocked_hosts(self) -> frozenset[str]:
        """막은 목적지의 호스트(진단·확인용). 풀리지 않는 이름도 여기에 듭니다."""
        with self._lock:
            return frozenset(self._blocked)

    def close(self) -> None:
        """더 받지 않고, 열린 연결을 끊고, 일하던 스레드가 끝나기를 잠깐 기다립니다. 여러 번 불러도 됩니다."""
        if self._closed.is_set():
            return
        self._closed.set()
        with self._lock:
            sockets = list(self._sockets)
            workers = list(self._workers)
        for sock in sockets:
            # 닫는 것은 그 소켓을 쥔 스레드가 합니다 — 여기서는 깨우기만 합니다(다른 스레드가 쓰는 번호를 닫지 않으려고).
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if threading.current_thread() is not self._acceptor:
            try:                                    # 받기를 기다리는 스레드를 바로 깨웁니다(깨우지 못해도 0.2초 안에 스스로 봅니다)
                socket.create_connection(self.address, timeout=0.5).close()
            except OSError:
                pass
            self._acceptor.join(timeout=2.0)
        until = time.monotonic() + 3.0
        for worker in workers:
            if worker is not threading.current_thread():
                worker.join(timeout=max(0.0, until - time.monotonic()))

    def __enter__(self) -> "EgressFilter":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # ------------------------------------------------------------------ 받기
    def _accept_loop(self) -> None:
        try:
            while not self._closed.is_set():
                if time.monotonic() >= self._deadline:
                    logger.warning("프록시의 수명 상한을 넘겨 닫습니다")
                    break
                try:
                    client, _peer = self._listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                if self._closed.is_set():
                    client.close()
                    break
                _no_delay(client)
                if not self._slots.acquire(blocking=False):
                    self._answer(client, 503, "Service Unavailable", linger=0.2)
                    client.close()
                    continue
                worker = threading.Thread(target=self._serve, args=(client,), name="egress-conn", daemon=True)
                with self._lock:
                    self._sockets.add(client)
                    self._workers.add(worker)
                worker.start()
        finally:
            # 어떤 이유로 끝나든 닫힌 쪽으로 — 듣는 소켓이 없으면 Chrome은 프록시에 붙지 못해 실패합니다(직접 나가지 않음).
            try:
                self._listener.close()
            except OSError:
                pass
            self.close()

    def _serve(self, client: socket.socket) -> None:
        upstream: socket.socket | None = None
        try:
            if self._closed.is_set():
                return
            client.settimeout(HEAD_SECONDS)
            head, rest = self._read_head(client)
            method, target, version, lines = _parse_head(head)
            tunnel = method == b"CONNECT"
            if tunnel:
                host, port = _connect_target(target)
            else:
                host, port = _plain_target(target)
                forward, body_bytes = _origin_request(method, target, version, lines)
                if len(rest) > body_bytes:
                    raise _Reject(400, "Bad Request")      # 요청 하나만 — 이어 붙은 다음 요청은 넘기지 않습니다
            addresses = self._checked(host)
            upstream = self._connect(addresses, port)
            with self._lock:
                self._sockets.add(upstream)
            # 닫기는 '닫힘'을 먼저 세우고 그때 열려 있던 소켓을 깨웁니다. 그 뒤에 붙기가 끝난 이 소켓은 깨워지지 않으므로 여기서 봅니다 —
            # 브라우저가 닫힌 뒤에는 아무것도 내보내지 않습니다.
            if self._closed.is_set():
                return
            with self._lock:
                self._passed.add(host)
            client.settimeout(SEND_SECONDS)
            upstream.settimeout(SEND_SECONDS)
            if tunnel:
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                if rest:
                    upstream.sendall(rest)
                self._relay(client, upstream, budget=None)
            else:
                upstream.sendall(forward + rest)
                self._relay(client, upstream, budget=body_bytes - len(rest))
        except _Reject as refusal:
            if refusal.blocked_host is not None:
                self._note_blocked(refusal.blocked_host)
            self._answer(client, refusal.status, refusal.reason)
        except (OSError, ValueError):
            pass                                            # 끊긴 연결·닫는 중 — 조용히 끝냅니다
        finally:
            for sock in (client, upstream):
                if sock is None:
                    continue
                with self._lock:
                    self._sockets.discard(sock)
                try:
                    sock.close()
                except OSError:
                    pass
            with self._lock:
                self._workers.discard(threading.current_thread())
            self._slots.release()

    # ------------------------------------------------------------------ 목적지 검사와 연결
    def _checked(self, host: str) -> tuple[str, ...]:
        """그 호스트의 '검사한 주소'. 프록시 하나의 수명 동안 호스트마다 한 번만 풀고, 그 답으로만 붙습니다."""
        with self._lock:
            known = self._verdicts.get(host)
        if known is None:
            found = tuple(guard.checked_addresses(host, self._resolve, self._allow))
            with self._lock:
                known = self._verdicts.setdefault(host, found)
        if not known:
            raise _Reject(403, "Forbidden", blocked_host=host)
        return known

    def _connect(self, addresses: tuple[str, ...], port: int) -> socket.socket:
        """검사한 주소에만 붙습니다(IPv4 먼저). 이름을 넘기지 않으므로 여기서 다시 풀리지 않습니다."""
        ordered = sorted(addresses, key=lambda address: ":" in address)[:MAX_ADDRESSES]
        for address in ordered:
            if self._closed.is_set():
                break
            try:
                upstream = self._dial(address, port)
            except OSError:
                continue
            _no_delay(upstream)
            return upstream
        raise _Reject(502, "Bad Gateway")

    def _note_blocked(self, host: str) -> None:
        with self._lock:
            first = host not in self._blocked
            self._blocked.add(host)
        if first:
            logger.warning("막은 목적지: %s", host)

    # ------------------------------------------------------------------ 바이트 나르기
    def _read_head(self, client: socket.socket) -> tuple[bytes, bytes]:
        """요청 머리(빈 줄까지)와 그 뒤에 이미 따라온 바이트. 상한·시간을 넘기거나 끊기면 받지 않습니다."""
        started = time.monotonic()
        data = b""
        while b"\r\n\r\n" not in data:
            if len(data) > MAX_HEAD_BYTES:
                raise _Reject(431, "Request Header Fields Too Large")
            if time.monotonic() - started > HEAD_SECONDS:
                raise OSError("요청 머리가 시간 안에 오지 않음")     # 답 없이 닫습니다 — 브라우저가 미리 열어 둔 빈 연결일 수 있습니다
            chunk = client.recv(_CHUNK)
            if not chunk:
                raise OSError("요청 머리를 받기 전에 끊김")
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        if len(head) > MAX_HEAD_BYTES:
            raise _Reject(431, "Request Header Fields Too Large")
        return head, rest

    def _relay(self, client: socket.socket, upstream: socket.socket, *, budget: int | None) -> None:
        """
        두 소켓 사이에 바이트를 그대로 나릅니다. 한쪽이 보내기를 끝내면 반대쪽에 그것만 알리고, 둘 다 끝나면 돌아옵니다.

        ``budget``은 브라우저 → 목적지 쪽으로 더 넘길 수 있는 바이트(평문 http의 남은 본문). 넘으면 끊습니다. ``None``은 제한 없음(터널).
        """
        with selectors.PollSelector() as waiting:
            waiting.register(client, selectors.EVENT_READ, upstream)
            waiting.register(upstream, selectors.EVENT_READ, client)
            sending = 2                              # 아직 보내기를 끝내지 않은 쪽의 수
            while sending and not self._closed.is_set():
                if time.monotonic() >= self._deadline:
                    return
                for key, _events in waiting.select(0.5):
                    source, sink = key.fileobj, key.data
                    data = source.recv(_CHUNK)
                    if not data:
                        waiting.unregister(source)
                        sending -= 1
                        try:
                            sink.shutdown(socket.SHUT_WR)
                        except OSError:
                            return
                        continue
                    if source is client and budget is not None:
                        if len(data) > budget:
                            return
                        budget -= len(data)
                    sink.sendall(data)

    @staticmethod
    def _answer(client: socket.socket, status: int, reason: str, *, linger: float = 1.0) -> None:
        """
        상태 줄 하나로 답하고 보내기를 끝냅니다. 상대가 보내던 것은 ``linger``초까지 받아 버립니다 — 읽지 않은 바이트가 남은 채 닫으면
        답이 닿기 전에 연결이 끊긴 것(RST)으로 보일 수 있습니다.
        """
        try:
            client.settimeout(linger)
            client.sendall(f"HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode("ascii"))
            client.shutdown(socket.SHUT_WR)
            until = time.monotonic() + linger
            while time.monotonic() < until and client.recv(_CHUNK):
                pass
        except OSError:
            pass


# ---------------------------------------------------------------------- 요청 머리 읽기 (순수 함수)
def _parse_head(head: bytes) -> tuple[bytes, bytes, bytes, list[bytes]]:
    """요청 머리 → (메서드, 요청 대상, HTTP 판, 머리글 줄들). 모양이 아니면 400."""
    lines = head.split(b"\r\n")
    if any(mark in line for line in lines for mark in (b"\n", b"\r", b"\0")):
        raise _Reject(400, "Bad Request")              # 줄 안의 CR·LF 단독·NUL — 원 서버가 줄을 다르게 나눠 읽을 수 있는 머리는 넘기지 않습니다
    parts = lines[0].split(b" ")
    if len(parts) != 3 or not parts[2].startswith(b"HTTP/1.") or not parts[0].isalpha():
        raise _Reject(400, "Bad Request")
    if any(b":" not in line or line[:1] in (b" ", b"\t") for line in lines[1:]):
        raise _Reject(400, "Bad Request")
    return parts[0].upper(), parts[1], parts[2], lines[1:]


def _host_port(authority: str, default_port: int | None) -> tuple[str, int]:
    try:
        parts = urlsplit("//" + authority)
        host = (parts.hostname or "").lower()
        port = parts.port if parts.port is not None else default_port
    except ValueError as exc:
        raise _Reject(400, "Bad Request") from exc
    if parts.username is not None or not _HOST.fullmatch(host) or port is None or not 0 < port < 65536:
        raise _Reject(400, "Bad Request")
    return host, port


def _text(raw: bytes) -> str:
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise _Reject(400, "Bad Request") from exc


def _connect_target(target: bytes) -> tuple[str, int]:
    """``CONNECT host:port`` → (호스트, 포트). 포트가 없으면 400."""
    return _host_port(_text(target), None)


def _plain_target(target: bytes) -> tuple[str, int]:
    """``GET http://host[:port]/path`` → (호스트, 포트). 절대 주소의 http가 아니면 400(https는 ``CONNECT``로만 옵니다)."""
    text = _text(target)
    if text[:7].lower() != "http://":
        raise _Reject(400, "Bad Request")
    authority = re.split(r"[/?#]", text[7:], maxsplit=1)[0]
    return _host_port(authority, 80)


def _origin_request(method: bytes, target: bytes, version: bytes, lines: list[bytes]) -> tuple[bytes, int]:
    """
    평문 http 요청을 원 서버에 보낼 모양으로 → (요청 머리 바이트, 뒤따를 본문 길이).

    요청 줄의 절대 주소를 경로로 바꾸고, 프록시에게 하는 머리글(``Proxy-Connection`` 등)을 빼고, ``Connection: close`` 하나를 그 자리에
    둡니다. 그 밖의 머리글은 순서·글자 그대로이고 더하는 것은 없습니다. 본문은 ``Content-Length``만큼만 — 조각 전송 본문은 받지 않습니다(501).
    """
    after = target[7:]
    cut = min((index for index in (after.find(b"/"), after.find(b"?")) if index >= 0), default=len(after))
    path = after[cut:] or b"/"
    if path.startswith(b"?"):
        path = b"/" + path
    kept: list[bytes] = []
    lengths: list[bytes] = []
    slot: int | None = None
    for line in lines:
        name = line.split(b":", 1)[0].strip().lower()
        if name in _PROXY_ONLY or name == b"connection":
            if slot is None:
                slot = len(kept)
                kept.append(b"Connection: close")
            continue
        if name == b"transfer-encoding":
            raise _Reject(501, "Not Implemented")
        if name == b"content-length":
            lengths.append(line.split(b":", 1)[1].strip())
        kept.append(line)
    if slot is None:
        kept.append(b"Connection: close")
    if len(set(lengths)) > 1 or any(not value.isdigit() for value in lengths):
        raise _Reject(400, "Bad Request")
    body_bytes = int(lengths[0]) if lengths else 0
    return b"\r\n".join([method + b" " + path + b" " + version, *kept]) + b"\r\n\r\n", body_bytes
