"""
app/fetch/impersonate.py
계층 1 — 브라우저와 같은 TLS·HTTP/2 지문과 기본 헤더로 보냅니다(curl_cffi, Yahoo 세션과 같은 라이브러리).

  - 호스트마다 세션 하나(쿠키를 그 호스트 안에서만 이어 씀). 쿠키는 메모리에만 있어 재기동하면 사라지고, 프로필은 표에 남아 그대로입니다.
  - User-Agent를 덮어쓰지 않습니다 — 프로필이 정한 값(지문과 맞는 값)을 그대로 둡니다. 부르는 쪽이 얹는 것은 Referer·Origin·Accept 같은
    요청 문맥뿐입니다.
  - 프록시 인자를 넘기지 않습니다(ADR 0026 결정 4). 환경변수 프록시는 curl_cffi 기본값대로 따릅니다 — QA 스택의 차단 프록시가 그대로 막습니다.
  - 태스크 안에서는 요청 timeout을 남은 시간 예산에 맞춰 줄이고, 그만큼도 남지 않았으면 보내지 않습니다(app/yahoo.py와 같은 규칙).
"""
from __future__ import annotations

import threading
from typing import Any

from curl_cffi import requests as curl_requests
from curl_cffi.requests import exceptions as curl_exceptions

from .. import http
from .reply import Reply, TransportError

# (연결, 읽기) 초. 페이지 하나를 받는 데 넉넉한 값이고, 태스크 안에서는 남은 예산에 맞춰 줄어듭니다.
DEFAULT_TIMEOUT: tuple[float, float] = (10.0, 30.0)
# 받는 본문의 상한(바이트). 캘린더·뉴스 목록은 수백 KB라, 이보다 크면 기대한 페이지가 아닙니다.
MAX_BODY_BYTES = 8 * 1024 * 1024

_lock = threading.Lock()
_sessions: dict[tuple[str, str], curl_requests.Session] = {}     # (호스트, 프로필) → 세션


def _session(host: str, profile: str) -> curl_requests.Session:
    key = (host, profile)
    with _lock:
        made = _sessions.get(key)
        if made is None:
            # 그 호스트의 프로필이 바뀌었으면(curl_cffi 판 올림) 옛 세션의 쿠키를 이어 쓰지 않습니다.
            for old in [k for k in _sessions if k[0] == host]:
                _sessions.pop(old).close()
            made = curl_requests.Session(impersonate=profile)
            _sessions[key] = made
        return made


def _fit(timeout: tuple[float, float]) -> tuple[float, float]:
    """
    태스크 안이면 (연결, 읽기)를 남은 예산에 맞춰 같은 비율로 줄입니다.

    :raises TransportError: 요청 하나도 못 보낼 만큼 남음
    """
    left = http.time_left()
    if left is None:
        return timeout
    allowed = left - http.RETRY_RESERVE_SECONDS
    if allowed < http.MIN_REQUEST_TIMEOUT:
        raise TransportError(f"태스크 시간 예산이 {max(left, 0.0):.0f}초 남아 보내지 않음")
    total = timeout[0] + timeout[1]
    if total <= allowed:
        return timeout
    scale = allowed / total
    return (timeout[0] * scale, timeout[1] * scale)


def send(
    method: str,
    url: str,
    *,
    profile: str,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    data: Any = None,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
) -> Reply:
    """
    ``url``을 고정 프로필로 한 번 보냅니다(다시 보내지 않음).

    :param profile: curl_cffi impersonate 이름 — :func:`app.fetch.state.profile_for`가 호스트마다 고정한 값
    :param headers: 프로필의 기본 헤더 위에 얹을 요청 문맥(Referer 등). User-Agent는 넣지 않습니다
    :raises TransportError: 보내지 못했거나 답이 없음, 본문이 상한보다 큼
    """
    if headers and any(name.lower() == "user-agent" for name in headers):
        raise ValueError("계층 1은 User-Agent를 덮어쓰지 않습니다 — 프로필이 정한 값을 씁니다(ADR 0026 결정 3)")
    host = http.host_of(url)
    session = _session(host, profile)
    try:
        response = session.request(method, url, headers=headers, params=params, data=data, timeout=_fit(timeout))
    except curl_exceptions.RequestException as exc:
        raise TransportError(http.brief_error(exc)) from exc
    body = response.content or b""
    if len(body) > MAX_BODY_BYTES:
        raise TransportError(f"본문이 상한({MAX_BODY_BYTES // (1024 * 1024)}MB)보다 큼 — 기대한 페이지가 아님")
    return Reply(
        status=response.status_code,
        headers={str(name).lower(): str(value) for name, value in response.headers.items()},
        body=body,
        final_url=str(response.url),
    )


def reset() -> None:
    """세션(쿠키)을 모두 닫습니다(시험 사이의 격리용)."""
    with _lock:
        for made in _sessions.values():
            made.close()
        _sessions.clear()
