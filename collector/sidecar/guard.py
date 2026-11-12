"""
sidecar/guard.py
브라우저 컨테이너의 문지기 — 공유 비밀, 최상위 이동의 허용 호스트, 전역 주소가 아닌 목적지 차단 (ADR 0026 결정 8).

브라우저는 제3자 스크립트를 실행합니다. 그 스크립트나 리다이렉트가 컨테이너 안쪽 망(수집기·도커 게이트웨이·클라우드 메타데이터·tailnet)을
두드리지 못하게, 브라우저가 보내려는 요청마다 목적지를 봅니다.

  - 최상위 이동(주소창이 바뀌는 요청)은 허용 호스트 목록에 있는 https 주소만.
  - 그 밖의 하위 요청(스크립트·이미지·XHR)은 호스트를 가리지 않되, 그 이름이 풀리는 주소가 모두 전역 주소여야 합니다 — 사설·루프백·
    링크 로컬·CGNAT(100.64.0.0/10, tailnet)·멀티캐스트·예약 대역이면 막습니다. 이름이 풀리지 않으면 막습니다.

이 모듈은 브라우저 드라이버를 가져오지 않습니다(시험이 드라이버 없이 돕니다).
"""
from __future__ import annotations

import hmac
import ipaddress
import socket
from typing import Callable, Iterable
from urllib.parse import urlsplit

Resolver = Callable[[str], Iterable[str]]


def parse_hosts(raw: str | None) -> frozenset[str]:
    """쉼표 목록 → 허용 호스트(소문자). 비어 있으면 빈 집합 — 아무 데도 가지 않습니다."""
    return frozenset(part.strip().lower() for part in (raw or "").split(",") if part.strip())


def token_ok(expected: str, given: str | None) -> bool:
    """공유 비밀이 맞는가. 서버에 비밀이 없으면(``expected`` 빈 값) 무엇을 보내도 거절합니다 — 비밀 없이 열어 두지 않습니다."""
    if not expected:
        return False
    return hmac.compare_digest((given or "").encode("utf-8"), expected.encode("utf-8"))


def top_level_allowed(url: str, allowed: frozenset[str]) -> bool:
    """최상위 이동으로 갈 수 있는 주소인가 — https이고 호스트가 허용 목록에 있음."""
    parts = urlsplit(url)
    return parts.scheme == "https" and (parts.hostname or "").lower() in allowed


def is_global_address(address: str) -> bool:
    """
    전역(공인) 주소인가. 읽을 수 없는 글자는 False.

    ``is_global`` 하나로는 모자랍니다 — 멀티캐스트(224.0.0.0/4)는 전역으로 분류됩니다. 사설·루프백·링크 로컬·멀티캐스트·예약·미지정을 따로
    거르고, IPv4를 감싼 IPv6 주소(``::ffff:10.0.0.5``)는 안의 IPv4로 봅니다.
    """
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return False
    return ip.is_global


def system_resolver(host: str) -> list[str]:
    """그 이름이 풀리는 주소 전부(IPv4·IPv6). 풀리지 않으면 빈 목록."""
    try:
        found = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        return []
    return sorted({entry[4][0] for entry in found})


def checked_addresses(host: str, resolve: Resolver = system_resolver,
                      allow: Callable[[str], bool] = is_global_address) -> list[str]:
    """
    그 호스트로 붙어도 되는 주소들 — IP 글자면 그 주소 하나, 이름이면 풀린 주소 전부.

    풀리지 않거나 **하나라도** ``allow``(기본: 전역 주소인가)를 지나지 못하면 빈 목록입니다. 돌려준 주소가 곧 '검사한 주소'라, 부르는 쪽은
    이름을 다시 풀지 않고 이 주소로 붙어야 합니다(푸는 시점과 붙는 시점 사이에 답이 바뀌는 것을 막으려고 — sidecar/egress.py).
    """
    try:
        ipaddress.ip_address(host)
        addresses: list[str] = [host]
    except ValueError:
        addresses = list(resolve(host))
    return addresses if addresses and all(allow(address) for address in addresses) else []


def destination_allowed(url: str, resolve: Resolver = system_resolver) -> bool:
    """
    하위 요청으로 갈 수 있는 목적지인가 — http(s)이고, 호스트(이름이면 풀린 주소 전부)가 전역 주소.

    ``data:``·``blob:``·``about:`` 같은 네트워크로 나가지 않는 주소는 부르는 쪽이 이 함수에 넘기지 않습니다.
    """
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or not host:
        return False
    return bool(checked_addresses(host, resolve))
