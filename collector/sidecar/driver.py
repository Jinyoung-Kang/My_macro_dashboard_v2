"""
sidecar/driver.py
실제 브라우저 드라이버 — 요청마다 Chrome을 띄워 페이지 하나를 받고 닫습니다 (ADR 0026 결정 8, ADR 0035 결정 5).

이 모듈은 브라우저 컨테이너의 이미지 안에서만 가져올 수 있습니다(드라이버 패키지가 수집기 이미지·CI에는 없음). 시험은 가짜 드라이버를 씁니다.

  - 프로필(쿠키)은 ``BROWSER_PROFILE_DIR``(이름 있는 볼륨)에 남겨 다음 요청이 이어 씁니다. 브라우저 프로세스는 요청이 끝나면 닫힙니다.
  - 브라우저가 보내려는 요청마다 목적지를 봅니다(guard) — 최상위 이동은 허용 호스트만, 하위 요청은 전역 주소만. 서비스 워커와 내려받기는 끕니다.
  - 입력 없이 지나가는 JS 검사는 ``wait_seconds``까지 기다립니다. 사람 확인 틀이 떠 있으면 **입력 없는 체크박스(Turnstile·hCaptcha·
    reCAPTCHA v2의 '사람입니다' 칸)만 요청 한 번에 한 번** 마우스로 누르고(:func:`press_checkbox_once` — 누르기 호출은 이 함수에만 있음),
    남은 시간 동안 다시 기다립니다. 그림·글자 퍼즐이 뜨거나 누른 뒤에도 막혀 있으면 풀지 않고 ``challenge``를 "human"으로 돌려줍니다.
    키보드 입력·풀이 서비스는 없습니다. 서버 .env의 ``BROWSER_PRESS_CHECKBOX=false``로 누르기를 끕니다.
  - 받은 응답이 JSON·XML(피드)이면 화면에 그린 것이 아니라 받은 본문 그대로 돌려줍니다.
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
# 사람 확인 체크박스를 한 번 누르는가(ADR 0035 결정 5). 끄면 ADR 0026의 '누르지 않음'으로 돌아갑니다.
PRESS_CHECKBOX = os.environ.get("BROWSER_PRESS_CHECKBOX", "true").strip().lower() != "false"
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
# 누를 수 있는 체크박스 틀(주소 표지)과 그 틀 안에서 체크박스가 있는 자리(틀의 왼쪽에서 px, 세로는 가운데).
#   Turnstile — 틀 전체가 위젯(왼쪽에 체크박스), hCaptcha — frame=checkbox 틀, reCAPTCHA v2 — anchor 틀.
_CHECKBOX_FRAMES = (("challenges.cloudflare.com", 30), ("hcaptcha.com", 30), ("frame=checkbox", 30),
                    ("recaptcha/api2/anchor", 27), ("recaptcha/enterprise/anchor", 27))
# 누르면 안 되는 틀 — 그림·글자 퍼즐(이것이 뜨면 사람 입력이 필요한 것이고 풀지 않습니다).
_PUZZLE_FRAMES = ("frame=challenge", "recaptcha/api2/bframe", "recaptcha/enterprise/bframe", "captcha-delivery.com")
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
        pressed = False
        deadline = time.monotonic() + wait_seconds
        while self._blocked(page, int(last["status"] or 0)):
            if _puzzle_frame(page):
                challenge = "human"             # 그림·글자 퍼즐 — 풀지 않습니다
                break
            if time.monotonic() >= deadline or time.monotonic() - started >= REQUEST_SECONDS:
                challenge = "human" if self._human_frame(page) else "js"
                break
            if PRESS_CHECKBOX and not pressed and self._human_frame(page):
                page.wait_for_timeout(int(random.uniform(1200, 3200)))     # 틀이 다 그려질 때까지(사람이 읽는 시간처럼)
                pressed = press_checkbox_once(page)
                if pressed:
                    logger.info("사람 확인 체크박스를 한 번 누름: %s", urlsplit(url).hostname)
                    deadline = max(deadline, time.monotonic() + 15.0)
            page.wait_for_timeout(1000)

        if challenge is None:
            # 읽기 전에 잠깐 머뭅니다 — 열자마자 본문만 떠 가지 않게.
            page.wait_for_timeout(int(random.uniform(600, 2200)))
            page.mouse.wheel(0, random.uniform(200, 900))
            page.wait_for_timeout(int(random.uniform(300, 1100)))

        content_type = str(last["contentType"])
        response = last["response"]
        if challenge is None and response is not None and ("json" in content_type or "xml" in content_type):
            body = response.text()              # JSON·피드(XML)는 화면에 그린 것이 아니라 받은 본문 그대로
        else:
            body = page.content()
        return {
            "status": int(last["status"] or 0),
            "finalUrl": page.url,
            "contentType": content_type,
            "body": body,
            "challenge": challenge,
            "pressed": pressed,
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


def _puzzle_frame(page) -> bool:
    """그림·글자 퍼즐 틀이 떠 있는가(이것은 누르거나 풀지 않습니다)."""
    return any(mark in (frame.url or "") for frame in page.frames for mark in _PUZZLE_FRAMES)


def press_checkbox_once(page) -> bool:
    """
    사람 확인 체크박스 틀을 찾아 그 체크박스 자리를 마우스로 한 번 누릅니다 → 눌렀으면 True.

    누르기 호출은 드라이버에서 이 함수에만 있습니다(시험이 AST로 확인). 틀 안의 요소를 찾거나 글자를 넣지 않고, 사람처럼 틀 위의 한 점으로
    마우스를 몇 단계에 나눠 옮긴 뒤 누릅니다. 퍼즐 틀은 고르지 않습니다. 틀의 위치를 모르면(보이지 않음) 누르지 않습니다.
    """
    for frame in page.frames:
        address = frame.url or ""
        if any(mark in address for mark in _PUZZLE_FRAMES):
            continue
        offset = next((left for mark, left in _CHECKBOX_FRAMES if mark in address), None)
        if offset is None:
            continue
        try:
            box = frame.frame_element().bounding_box()
        except Exception:  # noqa: BLE001 — 틀이 막 사라졌거나 다시 그려지는 중
            continue
        if not box or box["width"] < 20 or box["height"] < 20:
            continue
        x = box["x"] + min(offset, box["width"] / 2) + random.uniform(-4, 4)
        y = box["y"] + box["height"] / 2 + random.uniform(-4, 4)
        page.mouse.move(x - random.uniform(80, 220), y - random.uniform(30, 90))
        page.mouse.move(x, y, steps=random.randint(12, 28))
        page.wait_for_timeout(int(random.uniform(120, 420)))
        page.mouse.click(x, y, delay=random.randint(40, 140))
        return True
    return False


def _brief(exc: BaseException) -> str:
    """오류를 한 줄로 — 주소·호출 기록을 싣지 않습니다."""
    first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    return first[:160]
