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

import os
import threading
from typing import Any
from urllib.parse import urlencode

import requests

from .. import http
from .reply import Reply, TransportError

ENV_URL = "BROWSER_FETCH_URL"
ENV_TOKEN = "BROWSER_FETCH_TOKEN"
TOKEN_HEADER = "X-Browser-Token"

# 입력 없는 검사가 지나가기를 기다리는 시간(초)과, 그 요청 전체를 기다리는 (연결, 읽기) 초.
WAIT_SECONDS = 25.0
TIMEOUT: tuple[float, float] = (5.0, 110.0)
# 이만큼은 남아 있어야 브라우저를 부릅니다(브라우저 기동 + 이동 + 검사 대기 + 저장).
MIN_TIME_LEFT = 150.0

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
    try:
        response = _http().post(
            f"{_base_url()}/fetch",
            json={"url": target, "waitSeconds": WAIT_SECONDS},
            headers={TOKEN_HEADER: _token()},
            timeout=TIMEOUT,
        )
    except requests.RequestException as exc:
        raise TransportError(f"브라우저 컨테이너에 닿지 못함 — {http.brief_error(exc)}") from exc
    if response.status_code != 200:
        raise TransportError(f"브라우저 컨테이너가 요청을 받지 않음(HTTP {response.status_code})")
    try:
        body = response.json()
        return Reply(
            status=int(body["status"]),
            headers={"content-type": str(body.get("contentType") or "")},
            body=str(body.get("body") or "").encode("utf-8"),
            final_url=str(body.get("finalUrl") or target),
            challenge=body.get("challenge") if body.get("challenge") in ("human", "js") else None,
            pressed=body.get("pressed") is True,
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise TransportError("브라우저 컨테이너의 답을 읽지 못함") from exc


def reset() -> None:
    """세션을 닫습니다(시험 사이의 격리용)."""
    global _session
    with _lock:
        if _session is not None:
            _session.close()
        _session = None
