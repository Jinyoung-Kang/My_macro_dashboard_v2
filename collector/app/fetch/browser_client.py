"""
app/fetch/browser_client.py
계층 2 — 브라우저 컨테이너(collector/sidecar)에 페이지 하나를 열어 달라고 부탁합니다 (ADR 0026 결정 8).

  - 주소(``BROWSER_FETCH_URL``)와 공유 비밀(``BROWSER_FETCH_TOKEN``)이 둘 다 있어야 켜집니다. 운영 서버의 compose 덧붙임과 서버 .env에만
    있는 값이라, 로컬·QA에서는 계층 2가 없습니다(그때는 계층 1의 거부가 최종).
  - 보내는 것은 주소와 기다릴 시간뿐입니다. 요청 문맥 머리글은 넘기지 않습니다 — 브라우저가 사람이 주소를 연 것처럼 스스로 보냅니다.
  - 컨테이너에 닿지 못했거나(연결 실패·비밀 불일치·허용 호스트 아님·바쁨) 브라우저가 페이지를 받지 못한 것은 출처의 거부가 아니라
    :class:`TransportError`입니다. 출처의 답(상태 코드·본문·검사 상태)은 그대로 :class:`Reply`로 돌려주고 판정은 ladder가 합니다.
  - 안쪽 망의 호출이라 환경변수 프록시를 따르지 않습니다(``trust_env = False``).
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any
from urllib.parse import urlencode

import requests

from .. import http
from . import impersonate
from .reply import Reply, TransportError

ENV_URL = "BROWSER_FETCH_URL"
ENV_TOKEN = "BROWSER_FETCH_TOKEN"
TOKEN_HEADER = "X-Browser-Token"

# 입력 없는 검사가 지나가기를 기다리는 시간(초)과, 그 요청 전체를 기다리는 (연결, 읽기) 초.
WAIT_SECONDS = 25.0
TIMEOUT: tuple[float, float] = (5.0, 110.0)
# 이만큼은 남아 있어야 브라우저를 부릅니다(브라우저 기동 + 이동 + 검사 대기 + 저장).
MIN_TIME_LEFT = 150.0
# 컨테이너의 답(JSON 봉투)을 읽는 상한 — 본문 상한(impersonate.MAX_BODY_BYTES, 계층 1과 같은 값)의 이 배수 + 봉투의 나머지 칸 몫.
# JSON 문자열은 따옴표·줄바꿈·제어 문자를 이스케이프해 본문보다 길어질 수 있어 봉투는 넉넉히 읽고, 풀어 낸 본문을 본문 상한으로 다시 봅니다.
ENVELOPE_FACTOR = 2
ENVELOPE_EXTRA_BYTES = 64 * 1024
_READ_CHUNK = 64 * 1024

_lock = threading.Lock()
_session: requests.Session | None = None


def _base_url() -> str:
    return os.environ.get(ENV_URL, "").strip().rstrip("/")


def _token() -> str:
    return os.environ.get(ENV_TOKEN, "").strip()


def available() -> bool:
    """계층 2를 쓸 수 있는가 — 브라우저 컨테이너의 주소와 공유 비밀이 둘 다 설정됨."""
    return bool(_base_url()) and bool(_token())


def _http() -> requests.Session:
    global _session
    with _lock:
        if _session is None:
            _session = requests.Session()
            _session.trust_env = False
        return _session


def send(method: str, url: str, *, host: str, headers: Any = None, params: dict[str, Any] | None = None, data: Any = None) -> Reply:
    """
    ``url``을 브라우저로 열어 받습니다(한 번, 다시 보내지 않음).

    :raises TransportError: 켜져 있지 않음, GET이 아님, 시간 예산 부족, 컨테이너에 닿지 못함·거절·오류
    """
    if not available():
        raise TransportError("브라우저 컨테이너가 설정돼 있지 않음")
    if method.upper() != "GET" or data is not None:
        raise TransportError("브라우저 계층은 GET으로 여는 페이지만 받습니다")
    left = http.time_left()
    if left is not None and left < MIN_TIME_LEFT:
        raise TransportError(f"태스크 시간 예산이 {max(left, 0.0):.0f}초 남아 브라우저를 부르지 않음")
    target = f"{url}{'&' if '?' in url else '?'}{urlencode(params)}" if params else url
    limit = impersonate.MAX_BODY_BYTES
    try:
        response = _http().post(
            f"{_base_url()}/fetch",
            json={"url": target, "waitSeconds": WAIT_SECONDS},
            headers={TOKEN_HEADER: _token()},
            timeout=TIMEOUT,
            stream=True,            # 답을 통째로 메모리에 올리지 않고 상한까지만 읽습니다(QA-389)
        )
    except requests.RequestException as exc:
        raise TransportError(f"브라우저 컨테이너에 닿지 못함 — {http.brief_error(exc)}") from exc
    try:
        if response.status_code != 200:
            raise TransportError(f"브라우저 컨테이너가 요청을 받지 않음(HTTP {response.status_code})")
        try:
            raw = _read_capped(response, limit * ENVELOPE_FACTOR + ENVELOPE_EXTRA_BYTES)
        except requests.RequestException as exc:
            raise TransportError(f"브라우저 컨테이너의 답을 받다가 끊김 — {http.brief_error(exc)}") from exc
    finally:
        response.close()
    if raw is None:
        raise TransportError(f"본문이 상한({impersonate._size(limit)})보다 큼 — 브라우저 컨테이너의 답을 읽지 않음(기대한 페이지가 아님)")
    try:
        body = json.loads(raw)
        page = str(body.get("body") or "").encode("utf-8")
        reply = Reply(
            status=int(body["status"]),
            headers={"content-type": str(body.get("contentType") or "")},
            body=page,
            final_url=str(body.get("finalUrl") or target),
            challenge=body.get("challenge") if body.get("challenge") in ("human", "js") else None,
            pressed=body.get("pressed") is True,
        )
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise TransportError("브라우저 컨테이너의 답을 읽지 못함") from exc
    if len(page) > limit:
        raise TransportError(f"본문이 상한({impersonate._size(limit)})보다 큼 — 기대한 페이지가 아님")
    return reply


def _read_capped(response, limit: int) -> bytes | None:
    """
    답의 본문을 ``limit`` 바이트까지만 읽습니다 → 본문, 넘으면 None(더 읽지 않음).

    ``Content-Length``가 상한을 넘으면 한 바이트도 읽지 않습니다. 길이를 알리지 않는 답은 조각을 세다가 넘는 순간 멈춥니다.
    """
    declared = response.headers.get("content-length")
    if declared is not None and str(declared).strip().isdigit() and int(declared) > limit:
        return None
    chunks: list[bytes] = []
    received = 0
    for chunk in response.iter_content(chunk_size=_READ_CHUNK):
        received += len(chunk)
        if received > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def health() -> dict | None:
    """
    브라우저 컨테이너의 상태(공유 비밀 설정 여부·허용 호스트 수·체크박스 누르기 스위치) — 정보 수집의 '메커니즘' 화면용. 켜져 있지 않거나
    닿지 못하면 None. 출처로 나가는 요청이 아니라 안쪽 망 호출입니다.
    """
    if not available():
        return None
    try:
        response = _http().get(f"{_base_url()}/health", timeout=(3.0, 5.0))
        return response.json() if response.status_code == 200 else None
    except (requests.RequestException, ValueError):
        return None


def reset() -> None:
    """세션을 닫습니다(시험 사이의 격리용)."""
    global _session
    with _lock:
        if _session is not None:
            _session.close()
        _session = None
