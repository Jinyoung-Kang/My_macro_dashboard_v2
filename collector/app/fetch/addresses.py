"""
app/fetch/addresses.py
기사 한 건 받기(ADR 0043 — app/fetch/article.py)가 보내기 전에 거치는 주소 검사. 화면이 고른 글의 주소는 바깥 매체가 정한 것이라, 그 주소나
리다이렉트 목적지가 이 서버 안쪽(컨테이너 망·Tailscale·클라우드 메타데이터)을 가리키게 해서 요청을 대신 보내게 하는 길(SSRF)을 막습니다.

- 정적 검사(:func:`check_url` — 네트워크 없음): scheme http·https만, 포트는 없음·80·443만, 사용자 정보(``user:pass@``) 없음, 조각(``#…``)은 뗌,
  IP 글자 호스트(``10.0.0.1``·``[::1]``·``0x7f.1``·``2130706433`` 같은 변형)와 점이 없는 한 낱말 호스트(``postgres``·``backend`` 같은 compose
  서비스 이름)·내부 이름 끝(``.local``·``.internal``·``.localhost``·``.ts.net``)은 막음, 국제화 도메인은 ASCII(punycode)로, 주소 2,048자 상한.
- 이름 풀기(:func:`checked_addresses`): 풀린 주소 **전부**가 공인(:func:`is_global_address`)이어야 합니다. 판정은 브라우저 컨테이너 문지기
  (sidecar/guard.is_global_address)와 같은 규칙이고, 6to4(2002::/16)·Teredo(2001::/32)·NAT64(64:ff9b::/96)는 안에 IPv4를 실어 나르는 터널
  대역이라 통째로 막습니다(문지기보다 엄격한 쪽 — 시험이 같은 주소 표로 대조).
- 부르는 쪽은 돌려받은 주소로만 붙습니다(:func:`pin_entry` — curl의 RESOLVE). 이름을 검사한 순간과 붙는 순간 사이에 답이 바뀌는 DNS 재바인딩을
  막으려고입니다(문지기 sidecar/egress.py와 같은 생각).
"""
from __future__ import annotations

import concurrent.futures as futures
import ipaddress
import re
import socket
from dataclasses import dataclass
from urllib.parse import quote, urlsplit, urlunsplit

import idna

ALLOWED_SCHEMES = ("http", "https")
DEFAULT_PORTS = {"http": 80, "https": 443}
MAX_URL_CHARS = 2048
INTERNAL_SUFFIXES = (".local", ".internal", ".localhost", ".ts.net", ".lan", ".home.arpa")
RESOLVE_TIMEOUT = 5.0           # 이름 풀기의 상한(초) — 남은 작업 시간이 더 짧으면 그만큼
# 안에 IPv4를 실어 나르는 IPv6 터널 대역 — 공인 주소처럼 보여도 안쪽 주소로 갈 수 있어 통째로 막습니다.
TUNNEL_NETWORKS = (
    ipaddress.ip_network("2002::/16"),          # 6to4
    ipaddress.ip_network("2001::/32"),          # Teredo
    ipaddress.ip_network("64:ff9b::/96"),       # NAT64(잘 알려진 접두사)
    ipaddress.ip_network("64:ff9b:1::/48"),     # NAT64(지역 접두사)
)
_IP_LIKE_LABEL = re.compile(r"^(?:0x[0-9a-f]*|[0-9]+)$")
_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
# 경로·인자에서 그대로 두는 글자(이미 % 인코딩된 것 포함) — 나머지(한글·공백 등)는 % 인코딩합니다.
_PATH_SAFE = "/%:@!$&'()*+,;=-._~"
_QUERY_SAFE = "/%:@!$&'()*+,;=-._~?"


class AddressRefused(Exception):
    """보내지 않는 주소 — ``reason``은 ``unsafe_address``(내부·특수 주소)나 ``bad_url``(주소 모양이 규칙 밖), ``message``는 화면 글(호스트만)."""

    def __init__(self, reason: str, message: str, host: str | None = None) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.host = host


@dataclass(frozen=True)
class Target:
    """검사를 지난 주소 — ``url``은 조각을 떼고 호스트를 ASCII로 바꾼 보낼 주소, ``host``는 ASCII 소문자, ``port``는 실제로 붙을 포트."""
    url: str
    scheme: str
    host: str
    port: int


def is_global_address(address: str) -> bool:
    """
    공인 주소인가 — 브라우저 컨테이너 문지기(sidecar/guard.is_global_address)와 같은 규칙에 터널 대역(:data:`TUNNEL_NETWORKS`)을 더 막습니다.

    사설·루프백·링크 로컬(169.254/16 — 클라우드 메타데이터 포함)·site-local·멀티캐스트·예약·미지정이면 아님, CGNAT 100.64/10(Tailscale)은
    ``is_global``이 거짓이라 아님, IPv4를 감싼 IPv6(``::ffff:a.b.c.d``)는 안의 IPv4로 봅니다. IPv6 ULA(fc00::/7 — Tailscale fd7a:115c:a1e0::/48
    포함)·fe80::/10·::1도 막힙니다. 읽을 수 없는 글자는 False.
    """
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif any(ip in network for network in TUNNEL_NETWORKS):
            return False
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return False
    if getattr(ip, "is_site_local", False):
        return False
    return ip.is_global


def _ascii_host(host: str) -> str | None:
    """호스트 → ASCII 소문자(국제화 도메인은 punycode, 끝의 점은 뗌). 바꿀 수 없으면 None."""
    text = host.strip().rstrip(".").lower()
    if not text:
        return None
    if text.isascii():
        return text
    try:
        return idna.encode(text, uts46=True).decode("ascii")
    except (idna.IDNAError, UnicodeError, ValueError):
        return None


def _looks_like_ip(host: str) -> bool:
    """IP 글자 호스트인가 — 표준 표기와 브라우저·curl이 IP로 읽는 변형(``0x7f.1``·``2130706433``·``127.1``)."""
    if ":" in host:
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    last = host.rsplit(".", 1)[-1]
    return bool(_IP_LIKE_LABEL.match(last))


def check_url(url: str | None) -> Target:
    """
    정적 검사(네트워크 없음). 지나면 보낼 주소, 아니면 :class:`AddressRefused`.

    경로·인자의 비 ASCII 글자는 % 인코딩합니다(이미 인코딩된 것은 그대로).
    """
    text = (url or "").strip()
    if not text or len(text) > MAX_URL_CHARS or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
        raise AddressRefused("bad_url", "주소 모양이 규칙 밖이라 받지 않습니다")
    try:
        parts = urlsplit(text)
        raw_host = parts.hostname
        port = parts.port
    except ValueError:
        raise AddressRefused("bad_url", "주소를 읽지 못해 받지 않습니다") from None
    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise AddressRefused("bad_url", "http·https 주소만 받습니다")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise AddressRefused("bad_url", "사용자 정보가 든 주소는 받지 않습니다")
    host = _ascii_host(raw_host or "")
    if host is None:
        raise AddressRefused("bad_url", "호스트가 없거나 읽지 못해 받지 않습니다")
    if port is not None and port not in (80, 443):
        raise AddressRefused("bad_url", f"{host}의 포트 {port}는 받지 않습니다(80·443만)", host)
    if _looks_like_ip(host):
        raise AddressRefused("unsafe_address", "IP 주소로 된 주소는 받지 않습니다 — 이름이 있는 매체만", host)
    labels = host.split(".")
    if len(labels) < 2 or not all(_HOST_LABEL.match(label) for label in labels):
        raise AddressRefused("unsafe_address", f"{host}는 공개 매체의 이름이 아니라 받지 않습니다", host)
    if host == "localhost" or any(host.endswith(suffix) for suffix in INTERNAL_SUFFIXES):
        raise AddressRefused("unsafe_address", f"{host}는 내부 이름이라 받지 않습니다", host)
    netloc = host if port is None else f"{host}:{port}"
    path = quote(parts.path or "/", safe=_PATH_SAFE)
    query = quote(parts.query, safe=_QUERY_SAFE)
    return Target(url=urlunsplit((scheme, netloc, path, query, "")), scheme=scheme, host=host,
                  port=port if port is not None else DEFAULT_PORTS[scheme])


# ------------------------------------------------------------------ 이름 풀기

_resolver_pool = futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="article-dns")


def _resolve(host: str, port: int) -> list[str]:
    """그 이름이 풀리는 주소 전부(시험이 바꿔 끼우는 자리). 풀리지 않으면 빈 목록."""
    try:
        found = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError):
        return []
    return sorted({entry[4][0] for entry in found})


def checked_addresses(host: str, port: int, *, timeout: float = RESOLVE_TIMEOUT) -> list[str]:
    """
    그 호스트로 붙어도 되는 주소들 — 풀린 주소 전부가 공인일 때만 그 목록.

    :raises AddressRefused: ``unresolved``(풀리지 않음·시간 안에 답이 없음) 또는 ``unsafe_address``(하나라도 내부·특수 주소)
    """
    job = _resolver_pool.submit(_resolve, host, port)
    try:
        addresses = job.result(timeout=max(min(timeout, RESOLVE_TIMEOUT), 0.1))
    except futures.TimeoutError:
        raise AddressRefused("unresolved", f"{host} 이름을 시간 안에 풀지 못했습니다", host) from None
    if not addresses:
        raise AddressRefused("unresolved", f"{host} 이름을 찾지 못했습니다(DNS)", host)
    if not all(is_global_address(address) for address in addresses):
        raise AddressRefused("unsafe_address", f"{host}가 내부·특수 주소로 풀려 받지 않습니다", host)
    return addresses


def pin_entry(host: str, port: int, addresses: list[str]) -> str:
    """curl RESOLVE 한 줄(``host:port:addr``) — 검사한 주소 가운데 첫 IPv4, 없으면 첫 IPv6(대괄호)."""
    ipv4 = [address for address in addresses if ":" not in address]
    if ipv4:
        return f"{host}:{port}:{ipv4[0]}"
    return f"{host}:{port}:[{addresses[0].split('%', 1)[0]}]"
