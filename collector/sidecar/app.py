"""
sidecar/app.py
브라우저 컨테이너의 내부 서비스 — ``POST /fetch`` 하나와 ``GET /health`` (ADR 0026 결정 8, 명세 docs/specs/2026-11-05-polite-fetch.md §5).

  - 공유 비밀(``BROWSER_FETCH_TOKEN``)이 맞아야 하고, 비밀이 설정돼 있지 않으면 모든 요청을 거절합니다(컨테이너는 뜨되 일하지 않음 —
    배포의 기동 확인을 멈추지 않으려고).
  - 갈 수 있는 곳은 허용 호스트(``BROWSER_ALLOWED_HOSTS``)의 https 주소뿐입니다. 받는 입력은 주소와 기다릴 시간뿐이고, 스크립트·클릭·
    머리글 같은 입력은 받지 않습니다.
  - 한 번에 한 건만 합니다. 브라우저는 요청마다 띄우고 닫습니다(드라이버가 맡음).
  - 사람 확인을 만나면 드라이버가 입력 없는 체크박스만 한 번 누르고(ADR 0035 결정 5), 그래도 막히거나 퍼즐이 뜨면 풀지 않고
    ``challenge: "human"``으로 돌려줍니다. 누를지·어디를 누를지는 바깥 입력으로 받지 않습니다.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Protocol

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import guard

logger = logging.getLogger("sidecar")

# 검사가 지나가기를 기다리는 시간의 기본값과 상한(초). 요청 하나의 전체 상한은 드라이버가 따로 둡니다.
DEFAULT_WAIT_SECONDS = 25.0
MAX_WAIT_SECONDS = 60.0
# 돌려주는 본문의 상한(UTF-8 바이트). 수집기 계층 1의 상한(app/fetch/impersonate.MAX_BODY_BYTES)과 같은 값입니다 — 이 이미지는 수집기
# 코드를 싣지 않아 따로 적고, 시험(test_sidecar)이 두 값을 대조합니다. 넘으면 본문을 싣지 않고 502로 답합니다(QA-389).
MAX_BODY_BYTES = 8 * 1024 * 1024


class DriverError(Exception):
    """브라우저를 띄우지 못했거나 페이지를 받지 못함 — 출처의 거부가 아닙니다."""


class Driver(Protocol):
    def fetch(self, url: str, *, wait_seconds: float, allowed: frozenset[str]) -> dict:
        """
        ``url``을 브라우저로 열어 받습니다 → ``{status, finalUrl, contentType, body, challenge}``.

        ``challenge``는 None(검사를 만나지 않았거나 지나감)·"js"(입력 없는 검사가 시간 안에 끝나지 않음)·"human"(사람 입력을 요구받음).
        ``pressed``는 체크박스를 한 번 눌렀는지(ADR 0035 결정 5).
        :raises DriverError: 띄우지 못함·받지 못함·시간 초과
        """


class FetchRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    waitSeconds: float = Field(default=DEFAULT_WAIT_SECONDS, ge=1.0, le=MAX_WAIT_SECONDS)


def create_app(driver: Driver | None = None, *, token: str | None = None, allowed_hosts: str | None = None) -> FastAPI:
    """
    앱을 만듭니다. 인자를 주지 않으면 환경변수와 실제 드라이버를 씁니다(시험은 가짜 드라이버·값을 넘김).

    실제 드라이버는 첫 요청 때 가져옵니다 — 브라우저 드라이버 패키지는 이 컨테이너의 이미지에만 있습니다.
    """
    secret = os.environ.get("BROWSER_FETCH_TOKEN", "") if token is None else token
    allowed = guard.parse_hosts(os.environ.get("BROWSER_ALLOWED_HOSTS") if allowed_hosts is None else allowed_hosts)
    busy = threading.Lock()
    holder: dict[str, Driver | None] = {"driver": driver}

    if not secret:
        logger.warning("BROWSER_FETCH_TOKEN이 비어 있어 모든 요청을 거절합니다")
    if not allowed:
        logger.warning("BROWSER_ALLOWED_HOSTS가 비어 있어 갈 수 있는 호스트가 없습니다")

    def get_driver() -> Driver:
        if holder["driver"] is None:
            from .driver import ChromeDriver      # 이미지 안에서만 가져올 수 있습니다

            holder["driver"] = ChromeDriver()
        return holder["driver"]

    app = FastAPI(title="Browser sidecar", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None)

    press = os.environ.get("BROWSER_PRESS_CHECKBOX", "true").strip().lower() != "false"

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "tokenConfigured": bool(secret), "allowedHosts": len(allowed), "pressCheckbox": press}

    @app.post("/fetch")
    def fetch(body: FetchRequest, x_browser_token: str | None = Header(default=None)) -> dict:
        if not guard.token_ok(secret, x_browser_token):
            raise HTTPException(status_code=401, detail="공유 비밀이 맞지 않습니다")
        if not guard.top_level_allowed(body.url, allowed):
            raise HTTPException(status_code=400, detail="허용 호스트의 https 주소가 아닙니다")
        if not busy.acquire(blocking=False):
            raise HTTPException(status_code=429, detail="다른 요청을 처리하는 중입니다(한 번에 한 건)")
        try:
            result = get_driver().fetch(body.url, wait_seconds=body.waitSeconds, allowed=allowed)
            size = len(str(result.get("body") or "").encode("utf-8"))
            if size > MAX_BODY_BYTES:
                raise DriverError(f"본문이 상한({MAX_BODY_BYTES // (1024 * 1024)}MB)보다 큼 — 싣지 않음(기대한 페이지가 아님)")
            return result
        except DriverError as exc:
            logger.warning("받지 못함: %s", exc)
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        finally:
            busy.release()

    return app
