"""
sidecar/driver.py
실제 브라우저 드라이버 — 요청마다 Chrome을 띄워 페이지 하나를 받고 닫습니다 (ADR 0026 결정 8, ADR 0035 결정 5).

이 모듈은 브라우저 컨테이너의 이미지 안에서만 가져올 수 있습니다(드라이버 패키지가 수집기 이미지·CI에는 없음). 시험은 가짜 드라이버를 씁니다.

  - 프로필(쿠키)은 ``BROWSER_PROFILE_DIR``(이름 있는 볼륨)에 남겨 다음 요청이 이어 씁니다. 브라우저 프로세스는 요청이 끝나면 닫힙니다.
  - 브라우저가 보내려는 요청마다 목적지를 봅니다(guard) — 최상위 이동은 허용 호스트만, 하위 요청은 전역 주소만. 서비스 워커와 내려받기는 끕니다.
  - 이 가로채기는 리다이렉트로 이어진 요청과 웹소켓에는 불리지 않습니다. 그래서 Chrome의 나가는 길을 요청마다 띄우는 루프백의 필터 프록시
    (sidecar.egress) 하나로 묶습니다 — 연결마다 거기서 목적지를 다시 풀어 전역 주소일 때만, 검사한 그 주소로 붙습니다(QA-414). 프록시를 열지
    못하면 브라우저를 띄우지 않고, 프록시가 닫히면 Chrome의 요청은 실패합니다(직접 나가지 않음). 프록시가 볼 수 없는 UDP 길은 인자로 닫습니다.
  - 입력 없이 지나가는 JS 검사는 ``wait_seconds``까지 기다립니다. 사람 확인 틀이 떠 있으면 **입력 없는 체크박스(Turnstile·hCaptcha·
    reCAPTCHA v2의 '사람입니다' 칸)만 요청 한 번에 한 번** 마우스로 누르고(:func:`press_checkbox_once` — 누르기 호출은 이 함수에만 있음),
    남은 시간 동안 다시 기다립니다. 그림·글자 퍼즐이 뜨거나 누른 뒤에도 막혀 있으면 풀지 않고 ``challenge``를 "human"으로 돌려줍니다.
    키보드 입력·풀이 서비스는 없습니다. 서버 .env의 ``BROWSER_PRESS_CHECKBOX=false``로 누르기를 끕니다.
  - 받은 응답이 JSON·XML(피드)이면 화면에 그린 것이 아니라 받은 본문 그대로 돌려줍니다.
  - 크래시 보고·배경 통신·구성요소 갱신을 끕니다(CHROME_ARGS).
  - 요청 하나는 **강제 상한**(``HARD_SECONDS``) 안에 끝납니다(QA-416). 페이지가 메인 스레드를 붙잡으면(끝나지 않는 스크립트·동기 XHR·
    ``print()``) ``page.evaluate``·``page.content()``·마우스 호출이 돌아오지 않고 그 호출들에는 시간 상한이 없습니다(이미지에서 확인). 그래서
    띄우기부터 닫기까지를 작업 스레드에서 돌리고, 부른 스레드는 상한까지만 기다립니다. 넘기면 **그 요청의 Chrome 프로세스**를 끝내(sidecar.reap —
    붙잡혀 있던 호출이 바로 오류로 돌아와 작업 스레드가 평소 길로 정리함) ``DriverError``로 답합니다. 그 요청의 본문은 버립니다.
"""
from __future__ import annotations

import logging
import os
import random
import re
import threading
import time
from urllib.parse import urlsplit

from . import egress, guard, reap
from .app import DriverError

logger = logging.getLogger("sidecar.driver")

PROFILE_DIR = os.environ.get("BROWSER_PROFILE_DIR", "/profile")
# 브라우저 샌드박스. 컨테이너가 사용자 네임스페이스를 만들 수 없으면 Chrome이 뜨지 않습니다 — 그때만 서버 .env에서 끕니다(ADR 0026에 기록).
SANDBOX = os.environ.get("BROWSER_SANDBOX", "true").strip().lower() != "false"
# 사람 확인 체크박스를 한 번 누르는가(ADR 0035 결정 5). 끄면 ADR 0026의 '누르지 않음'으로 돌아갑니다.
PRESS_CHECKBOX = os.environ.get("BROWSER_PRESS_CHECKBOX", "true").strip().lower() != "false"
# 요청 하나의 전체 상한(초)과 첫 이동의 상한(ms). 전체 상한은 페이지 받기의 반복문이 도는 사이에 봅니다(검사가 지나가기를 기다리는 시간의 끝).
REQUEST_SECONDS = 90.0
NAVIGATION_TIMEOUT_MS = 45_000
# 강제 상한(초, QA-416) — 요청이 시작된 지 이만큼 지나도 끝나지 않으면 그 요청의 Chrome을 끝냅니다. 페이지가 메인 스레드를 붙잡으면 드라이버의
# 호출이 돌아오지 않아 위 상한의 검사에 닿지 못합니다. 값은 두 쪽에서 정해집니다(시험 test_QA416_상한들의_선후가 고정):
#   - 위 상한보다 10초 깁니다. 가장 긴 정상 경로는 '90초 직전에 시작한 반복 한 바퀴(체크박스를 누르면 약 5.5초) + 본문 읽기 + 닫기'로 96초쯤이라
#     그 경로를 끊지 않습니다.
#   - 수집기가 이 컨테이너의 답을 기다리는 시간(110초 — app/fetch/browser_client.TIMEOUT)보다 짧습니다. 아래 정리 대기를 더해도(104초) 수집기가
#     포기하기 전에 502로 답합니다.
# 이 모듈의 값을 부를 때 읽습니다(시험과 이미지 안 확인이 짧은 값으로 바꿔 끼움).
HARD_SECONDS = REQUEST_SECONDS + 10.0
# 브라우저를 끝낸 뒤 작업 스레드의 정리(붙잡혀 있던 호출이 오류로 돌아옴 → 문맥·드라이버 닫기)를 기다리는 시간(초). 이미지에서 잰 정리는 0.05초
# 안쪽입니다. 절반이 지나도 끝나지 않으면 그 브라우저를 띄운 드라이버 프로세스까지 끝내고 나머지 절반을 기다립니다. 그래도 끝나지 않으면 더
# 기다리지 않고 답합니다(오류 로그).
CLEANUP_SECONDS = 4.0
# 필터 프록시의 수명 상한(초). 프록시는 요청이 끝나면 닫히고, 이 값은 닫히지 못했을 때의 안전망입니다 — 요청 하나가 쓸 수 있는 가장 긴 시간
# (강제 상한 + 정리 대기 = 104초)과 수집기가 이 컨테이너의 답을 기다리는 시간(110초)보다 길게 둡니다.
EGRESS_LIFETIME_SECONDS = REQUEST_SECONDS + 30.0

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
# Chrome이 프록시를 건너뛰는 길을 닫습니다(QA-414 — 이미지의 Chrome 157에서 확인, ADR 0026 덧붙임).
#   - Chrome은 기본으로 루프백·링크 로컬행 요청을 프록시 없이 직접 붙습니다. ``<-loopback>``이 그 암묵 우회를 끕니다(드라이버 패키지도 기본으로
#     더하지만 환경변수 하나로 꺼지므로 직접 넘깁니다).
#   - WebRTC는 프록시로 갈 수 없는 UDP(STUN·후보 연결 확인)를 쓰지 않습니다. 스위치 이름은 Chrome 157 바이너리에 있는 것입니다
#     (옛 이름 ``--force-webrtc-ip-handling-policy``는 그 판에서 아무 효과가 없었습니다). 이름이 또 바뀌면 sidecar.selfcheck가 잡습니다.
#   - QUIC(HTTP/3·WebTransport)은 UDP라 프록시가 보지 못합니다. 프록시가 있으면 Chrome이 쓰지 않는 것을 WebTransport로 확인했고, HTTP/3은
#     확인할 서버가 없어 스위치로 꺼 둡니다.
#   - Chrome은 프록시로 가는 요청의 이름은 스스로 풀지 않지만(프록시가 풂), WebRTC의 TURN(TCP·TLS) 서버 이름은 **프록시 없이 직접 DNS로
#     묻습니다**(연결 자체는 프록시로 와서 막힘 — 53번 포트를 들어 확인). 페이지가 고른 이름이 풀이 서버로 나가지 않게, Chrome의 이름 풀이를
#     전부 '없음'으로 돌립니다. 프록시 주소(127.0.0.1)는 빼야 합니다 — 빼지 않으면 프록시 연결 자체가 실패합니다(확인함).
PROXY_BYPASS = "<-loopback>"
EGRESS_ARGS = (
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic",
    f"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE {egress.BIND_HOST}",
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
            gate = egress.EgressFilter(lifetime_seconds=EGRESS_LIFETIME_SECONDS)
        except OSError as exc:
            raise DriverError("나가는 길 필터 프록시를 열지 못해 브라우저를 띄우지 않음") from exc
        outcome: dict[str, object] = {}

        def work() -> None:
            # 드라이버의 동기 API는 띄운 스레드에서만 부를 수 있습니다 — 띄우기부터 닫기까지 이 스레드 하나에서 합니다.
            try:
                with sync_playwright() as playwright:
                    context = launch(playwright, gate.url)
                    try:
                        outcome["result"] = self._load(context, url, wait_seconds, allowed, started)
                    finally:
                        context.close()
            except BaseException as exc:  # noqa: BLE001 — 부른 스레드가 받아 아래에서 다시 던집니다
                outcome["error"] = exc

        worker = threading.Thread(target=work, name="sidecar-fetch", daemon=True)
        try:
            # 프록시는 브라우저보다 먼저 열리고 나중에 닫힙니다.
            worker.start()
            worker.join(max(0.0, started + HARD_SECONDS - time.monotonic()))
            if worker.is_alive():
                _end_overdue(gate.url, worker)
                # 정리하는 사이에 끝났더라도 그 답은 쓰지 않습니다(브라우저를 끝낸 요청의 본문은 믿지 않음).
                raise DriverError(f"요청 상한({HARD_SECONDS:g}초)을 넘겨 브라우저를 끝냄: {urlsplit(url).hostname}")
        finally:
            gate.close()
        error = outcome.get("error")
        if isinstance(error, BrowserError):
            raise DriverError(f"브라우저 오류: {_brief(error)}") from error
        if isinstance(error, BaseException):
            raise error
        return outcome["result"]

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


def _end_overdue(proxy_url: str, worker: threading.Thread) -> None:
    """
    강제 상한을 넘긴 요청의 브라우저를 끝내고, 작업 스레드가 정리를 마치기를 ``CLEANUP_SECONDS``까지 기다립니다 (QA-416).

    끝내는 것은 그 요청의 Chrome(명령줄에 그 요청의 프록시 주소를 가진 프로세스와 그 자손)입니다. 그러면 붙잡혀 있던 호출이 '닫혔다'는 오류로
    돌아오고 작업 스레드가 문맥·드라이버를 평소 길로 닫습니다. 그래도 돌아오지 않으면(드라이버 프로세스가 멎은 경우) 그 브라우저를 띄운 드라이버
    프로세스도 끝냅니다. 강제로 끝난 Chrome이 프로필에 남긴 잠금 링크는 치웁니다(컨테이너가 다시 만들어지면 다음 기동을 막음 — sidecar.reap).
    """
    found = reap.find_browser(proxy_url)
    ended = reap.end(found.processes)
    worker.join(CLEANUP_SECONDS / 2)
    if worker.is_alive():
        again = reap.find_browser(proxy_url)        # 처음 볼 때 아직 뜨지 않았던 브라우저까지
        ended += reap.end(again.processes)
        ended += reap.end(reap.children_of_this_process({*found.launchers, *again.launchers}))
        worker.join(CLEANUP_SECONDS / 2)
    reap.clear_stale_lock(PROFILE_DIR, ended=ended)
    if worker.is_alive():
        logger.error("상한을 넘긴 요청의 정리가 끝나지 않음 — 작업 스레드 하나가 남습니다(끝낸 프로세스 %d개)", len(ended))


def launch(playwright, proxy_url: str, *, profile_dir: str | None = None, extra_args: tuple[str, ...] = ()):
    """
    Chrome을 띄웁니다 → 브라우저 문맥. 나가는 길은 ``proxy_url``(sidecar.egress의 필터 프록시) 하나입니다.

    운영 경로(:meth:`ChromeDriver.fetch`)는 ``profile_dir``·``extra_args``를 넘기지 않습니다. 이미지 안 확인(sidecar/selfcheck.py)이 같은 인자로
    띄우되 임시 프로필과 확인용 인자를 쓰려고 둔 자리입니다.
    """
    return playwright.chromium.launch_persistent_context(
        PROFILE_DIR if profile_dir is None else profile_dir,
        channel="chrome",
        headless=False,
        no_viewport=True,
        accept_downloads=False,
        service_workers="block",
        chromium_sandbox=SANDBOX,
        proxy={"server": proxy_url, "bypass": PROXY_BYPASS},
        args=[*CHROME_ARGS, *EGRESS_ARGS, *extra_args],
    )


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


_URL_IN_TEXT = re.compile(r"""[a-z][a-z0-9+.\-]*://[^\s"'<>]+""", re.IGNORECASE)
_INLINE_URL_IN_TEXT = re.compile(r"""\b(?:data|blob|javascript):[^\s"']+""", re.IGNORECASE)


def _host_only(match: re.Match[str]) -> str:
    try:
        host = urlsplit(match.group(0)).hostname
    except ValueError:
        host = None
    return host or "(주소)"


def _brief(exc: BaseException) -> str:
    """
    오류를 한 줄로 — 호출 기록은 싣지 않고, 주소는 호스트만 남깁니다.

    브라우저 오류의 첫 줄은 요청 주소 전체를 달고 옵니다(``Page.goto: net::ERR_… at http://호스트/경로?쿼리``). 이 글은 로그와 502 답에
    실리므로 경로·쿼리·포트를 떼어 냅니다(막힌 홉이면 그 주소는 출처나 제3자 스크립트가 고른 내부 주소입니다).
    """
    first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    return _INLINE_URL_IN_TEXT.sub("(주소)", _URL_IN_TEXT.sub(_host_only, first))[:160]
