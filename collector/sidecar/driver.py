"""
sidecar/driver.py
실제 브라우저 드라이버 — 요청마다 Chrome을 띄워 페이지 하나를 받고 닫습니다 (ADR 0026 결정 5·8).

이 모듈은 브라우저 컨테이너의 이미지 안에서만 가져올 수 있습니다(드라이버 패키지가 수집기 이미지·CI에는 없음). 시험은 가짜 드라이버를 씁니다.

  - 프로필(쿠키)은 ``BROWSER_PROFILE_DIR``(이름 있는 볼륨)에 남겨 다음 요청이 이어 씁니다. 브라우저 프로세스는 요청이 끝나면 닫힙니다.
  - 브라우저가 보내려는 요청마다 목적지를 봅니다(guard) — 최상위 이동은 허용 호스트만, 하위 요청은 전역 주소만. 서비스 워커와 내려받기는 끕니다.
  - 입력 없이 지나가는 JS 검사는 ``wait_seconds``까지 기다립니다. 그 안에 지나가지 않으면 사람 확인 틀(CAPTCHA·체크박스)이 떠 있는지 보고
    ``challenge``를 "human" 또는 "js"로 돌려줍니다. **풀거나 누르지 않습니다.**
  - 크래시 보고·배경 통신·구성요소 갱신을 끕니다(CHROME_ARGS).
"""
from __future__ import annotations

import logging
import os
import random
import time
from urllib.parse import urlsplit

from . import guard
from .app import DriverError

logger = logging.getLogger("sidecar.driver")

PROFILE_DIR = os.environ.get("BROWSER_PROFILE_DIR", "/profile")
# 브라우저 샌드박스. 컨테이너가 사용자 네임스페이스를 만들 수 없으면 Chrome이 뜨지 않습니다 — 그때만 서버 .env에서 끕니다(ADR 0026에 기록).
SANDBOX = os.environ.get("BROWSER_SANDBOX", "true").strip().lower() != "false"
# 요청 하나의 전체 상한(초)과 첫 이동의 상한(ms).
REQUEST_SECONDS = 90.0
NAVIGATION_TIMEOUT_MS = 45_000

CHROME_ARGS = (
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
)

# 검사 화면에만 있는 흔적(제목·틀). 정상 페이지에도 들어가는 스크립트 경로나 'captcha' 단어는 보지 않습니다.
_INTERSTITIAL_SCRIPT = """
() => {
  const title = (document.title || '').toLowerCase();
  const has = (selector) => !!document.querySelector(selector);
  return title.includes('just a moment') || title.includes('attention required')
      || has('#challenge-form') || has('#challenge-running') || has('#cf-challenge-running') || has('#px-captcha');
}
"""
_HUMAN_FRAME_MARKS = ("challenges.cloudflare.com", "hcaptcha.com", "recaptcha", "captcha-delivery.com")
_BLOCK_STATUSES = (403, 429, 503)


class ChromeDriver:
    """요청마다 Chrome을 띄우고 닫는 드라이버(sidecar.app.Driver)."""

    def fetch(self, url: str, *, wait_seconds: float, allowed: frozenset[str]) -> dict:
        try:
            from patchright.sync_api import Error as BrowserError
            from patchright.sync_api import sync_playwright
        except ImportError as exc:      # 이미지 밖에서 불렸음
            raise DriverError("브라우저 드라이버가 설치돼 있지 않습니다") from exc

        started = time.monotonic()
        try:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    PROFILE_DIR,
                    channel="chrome",
                    headless=False,
                    no_viewport=True,
                    accept_downloads=False,
                    service_workers="block",
                    chromium_sandbox=SANDBOX,
                    args=list(CHROME_ARGS),
                )
                try:
                    return self._load(context, url, wait_seconds, allowed, started)
                finally:
                    context.close()
        except BrowserError as exc:
            raise DriverError(f"브라우저 오류: {_brief(exc)}") from exc

    def _load(self, context, url: str, wait_seconds: float, allowed: frozenset[str], started: float) -> dict:
        page = context.pages[0] if context.pages else context.new_page()
        verdicts: dict[str, bool] = {}
        last: dict[str, object] = {"status": 0, "contentType": "", "response": None}

        def on_route(route, request) -> None:
            target = request.url
            if urlsplit(target).scheme not in ("http", "https"):
                route.continue_()               # data:·blob:·about: — 네트워크로 나가지 않음
                return
            if request.is_navigation_request() and request.frame == page.main_frame:
                ok = guard.top_level_allowed(target, allowed)
            else:
                host = (urlsplit(target).hostname or "").lower()
                ok = verdicts.get(host)
                if ok is None:
                    ok = verdicts[host] = guard.destination_allowed(target)
            if ok:
                route.continue_()
            else:
                logger.warning("막은 목적지: %s", urlsplit(target).hostname)
                route.abort("blockedbyclient")

        def on_response(response) -> None:
            request = response.request
            if request.is_navigation_request() and request.frame == page.main_frame:
                last["status"] = response.status
                last["contentType"] = (response.headers.get("content-type") or "").lower()
                last["response"] = response

        context.route("**/*", on_route)
        page.on("response", on_response)
        page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)

        challenge = None
        deadline = time.monotonic() + wait_seconds
        while self._blocked(page, int(last["status"] or 0)):
            if time.monotonic() >= deadline or time.monotonic() - started >= REQUEST_SECONDS:
                challenge = "human" if self._human_frame(page) else "js"
                break
            page.wait_for_timeout(1000)

        if challenge is None:
            # 읽기 전에 잠깐 머뭅니다 — 열자마자 본문만 떠 가지 않게.
            page.wait_for_timeout(int(random.uniform(600, 2200)))
            page.mouse.wheel(0, random.uniform(200, 900))
            page.wait_for_timeout(int(random.uniform(300, 1100)))

        content_type = str(last["contentType"])
        response = last["response"]
        if challenge is None and response is not None and "json" in content_type:
            body = response.text()              # JSON은 화면에 그린 것이 아니라 받은 본문 그대로
        else:
            body = page.content()
        return {
            "status": int(last["status"] or 0),
            "finalUrl": page.url,
            "contentType": content_type,
            "body": body,
            "challenge": challenge,
        }

    @staticmethod
    def _human_frame(page) -> bool:
        """사람 확인 틀(Turnstile·hCaptcha·reCAPTCHA·DataDome)이 떠 있는가 — 닫힌 그림자 DOM 안의 틀도 프레임 목록에는 보입니다."""
        return any(mark in (frame.url or "") for frame in page.frames for mark in _HUMAN_FRAME_MARKS)

    def _blocked(self, page, status: int) -> bool:
        """지금 화면이 검사 화면인가 — 검사 화면의 제목·틀이 있거나, 거부 상태 코드에 사람 확인 틀이 떠 있음."""
        try:
            interstitial = bool(page.evaluate(_INTERSTITIAL_SCRIPT))
        except Exception:  # noqa: BLE001 — 이동 중이라 문맥이 바뀐 순간이면 다음 바퀴에 다시 봅니다
            return True
        return interstitial or (status in _BLOCK_STATUSES and self._human_frame(page))


def _brief(exc: BaseException) -> str:
    """오류를 한 줄로 — 주소·호출 기록을 싣지 않습니다."""
    first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    return first[:160]
