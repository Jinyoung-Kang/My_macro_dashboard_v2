"""
app/http.py
공용 HTTP 세션 (커넥션 풀 + 재시도 + 출처 거부 래치 + 호스트별 간격).

구버전 services/http_client.py와 같은 목적입니다. 요청마다 새 Session을 만들면
TCP/TLS 핸드셰이크를 매번 반복하고, 레이트리밋 대응(재시도)도 제각각이 됩니다.

[공용·FRED·SEC·BLS 세션이 요청마다 하는 일 — _GuardedAdapter, v2 1단계 6번(OSS 채택 목록 §1)]
  1) 거부 래치 — 403·429·봇 차단 페이지는 '데이터 없음'이 아니라 **출처가 거부**한 것입니다. 그 호스트를 5분 동안 닫고
     (SourceRejected), 그 사이의 같은 호스트 요청은 네트워크에 나가지 않고 바로 같은 예외로 끝납니다. 같은 거절을 되풀이하면
     차단이 길어질 뿐이라서입니다. 실행기(tasks/runner)가 이것을 실행 기록에 '거부됨'으로 적습니다.
  2) 호스트별 최소 간격 + 작은 지터 — 병렬 수집이 한 호스트를 한꺼번에 두드리지 않게 합니다(SEC는 기존 토큰 버킷만).
  3) 일시 오류만 다시 보냄 — 연결 오류·읽기 시간 초과·5xx·408. 그 밖의 4xx는 다시 보내지 않습니다(429는 1의 래치). 태스크
     안에서는 그 태스크의 시간 상한(TASK_DEADLINE_SECONDS)에 맞춰 요청 timeout을 줄이고, 다음 시도가 상한 안에 끝나지 않으면 더
     보내지 않습니다. 태스크가 안에서 연 스레드 풀은 :func:`bind_guard`로 묶어야 1·3이 그 태스크에 적히고 예산을 봅니다.
증권사 Open API 세션(get_api_session)과 공공 API 세션(publicapi)은 이 층을 거치지 않습니다 — 부르는 쪽이 401·403·429를
직접 다루고, 공공데이터포털의 403은 차단이 아니라 서비스별 키 승인 문제라 호스트를 닫으면 다른 서비스까지 막힙니다.
"""
from __future__ import annotations

import contextvars
import functools
import logging
import random
import threading
import time
from http.cookiejar import DefaultCookiePolicy
from typing import Callable, TypeVar
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.exceptions import MaxRetryError, ResponseError
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

_T = TypeVar("_T")

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
}

# ==============================================================================
# SEC EDGAR User-Agent
# ==============================================================================
# SEC는 연락처가 포함된 User-Agent를 **의무**로 요구합니다(미준수 시 403).
#
# 이 값은 코드에 두지 않습니다. 연락처는 사람마다 다르고, 남의 이메일이 기본값으로
# 박혀 있으면 (a) 본인 것을 넣을 이유가 사라지고 (b) SEC 입장에서는 정체를 숨긴
# 요청이 됩니다. .env의 SEC_USER_AGENT로만 받습니다.
#   open -e .env  →  SEC_USER_AGENT=your-name@example.com
#
# 미설정이면 SecUserAgentMissing을 던져 13F 수집만 멈춥니다. 예시 주소로 조용히
# 요청을 보내면 403이 났을 때 원인을 찾기 어렵기 때문입니다.
_UA_PRODUCT = "LocalMacroDashboard/2.0"


_ENV_HINT = "(open -e .env → SEC_USER_AGENT=your-name@example.com → make up)"

# .env에 안내 문구를 지우지 않고 그대로 둔 경우를 걸러 냅니다.
_PLACEHOLDERS = (
    "이메일", "본인이메일", "your-name@example.com", "your-email",
    "youremail", "example@example.com", "name@example.com",
)


class SecUserAgentInvalid(RuntimeError):
    """SEC_USER_AGENT 값이 쓸 수 없는 상태입니다."""


class SecUserAgentMissing(SecUserAgentInvalid):
    """SEC_USER_AGENT가 비어 있습니다."""

    def __init__(self) -> None:
        super().__init__(
            "SEC_USER_AGENT가 설정되지 않았습니다. SEC EDGAR는 연락처 없는 요청을 "
            f"403으로 막습니다. .env에 본인 이메일을 넣으세요 {_ENV_HINT}"
        )


def sec_user_agent() -> str:
    """
    SEC EDGAR에 보낼 User-Agent.

    .env에 이메일만 적어도 되도록, 연락처 형태가 아니면 SEC가 요구하는
    "제품명 (contact: 연락처)" 형태로 감싸 줍니다.

    값이 잘못돼 있으면 **요청을 보내기 전에** 멈춥니다. 특히 한글이 섞이면
    requests가 헤더를 latin-1로 인코딩하다가 이렇게 터집니다.

        UnicodeEncodeError: 'latin-1' codec can't encode characters …

    이 메시지만 보고 .env를 고쳐야 한다는 걸 알아채기는 어렵습니다.
    """
    from . import settings  # 순환 import 방지를 위해 함수 안에서 가져옵니다.

    configured = settings.sec_user_agent()
    if not configured:
        raise SecUserAgentMissing()

    # HTTP 헤더는 latin-1로만 보낼 수 있습니다. 한글 주소는 애초에 불가능합니다.
    try:
        configured.encode("latin-1")
    except UnicodeEncodeError:
        raise SecUserAgentInvalid(
            f"SEC_USER_AGENT에 영문/숫자가 아닌 문자가 있습니다: {configured!r}. "
            "HTTP 헤더는 한글을 담을 수 없습니다. 실제 이메일 주소를 "
            f"영문 그대로 적어 주세요 {_ENV_HINT}"
        ) from None

    lowered = configured.lower()
    if any(token in lowered for token in _PLACEHOLDERS):
        raise SecUserAgentInvalid(
            f"SEC_USER_AGENT가 예시 값 그대로입니다: {configured!r}. "
            "SEC는 연락이 닿지 않는 요청을 차단합니다. 실제 이메일로 바꿔 주세요 "
            f"{_ENV_HINT}"
        )

    if "@" not in configured:
        raise SecUserAgentInvalid(
            f"SEC_USER_AGENT에 이메일 주소가 없습니다: {configured!r}. "
            f"SEC는 연락처를 요구합니다 {_ENV_HINT}"
        )

    if "(" not in configured:
        # 이메일만 적어 둔 경우(구버전 secrets.toml 형식)
        return f"{_UA_PRODUCT} (contact: {configured})"
    return configured


def sec_headers() -> dict:
    return {
        "User-Agent": sec_user_agent(),
        "Accept-Encoding": "gzip, deflate",
    }

_lock = threading.Lock()
_sessions: dict[str, requests.Session] = {}

# 서버가 Retry-After로 요구하는 대기의 상한(초, QA-080). urllib3 기본은 6시간(21600초)까지 그대로 time.sleep하고,
# 이 대기는 requests의 timeout에 들어가지 않습니다. 503에 'Retry-After: 3600'이 오면 요청 하나가 수집기
# 스레드를 몇 시간 붙잡아 태스크 시간 상한 뒤에도 남고, /live/* 요청 경로는 스레드 한도(40)를 채웁니다.
# 토스 클라이언트(services/toss.api_get)와 같은 5초로 자릅니다 — 더 오래 쉬라는 소스는 재시도를 다 쓴 뒤
# 실패로 기록되고 다음 주기에 다시 시도합니다(재시도 수 × 5초가 요청 하나의 대기 상한).
# (429는 다시 보내지 않고 거부 래치로 닫으므로 Retry-After를 기다리지 않습니다 — 아래 _BudgetRetry.)
RETRY_AFTER_MAX_SECONDS = 5

# 공용·FRED·SEC·BLS 세션이 다시 보내는 응답 코드 — 일시 오류(5xx·408)만. 연결 오류·읽기 시간 초과(연결 끊김 포함)는 상태
# 코드와 별개로 urllib3 Retry의 total 안에서 다시 보냅니다. 408(Request Timeout)은 거절이 아니라 일시 상태라 다시 보냅니다
# (RFC 9110 §15.5.9 — 클라이언트가 같은 요청을 다시 보내도 됨). 그 밖의 4xx는 다시 보내지 않습니다 — 400·404는 같은 요청에
# 같은 답이 오고, 403·429는 출처의 거절이라 되풀이하면 차단이 길어집니다(아래 거부 래치). 예전에는 403·429도 다시 보냈습니다.
TRANSIENT_STATUSES = (408, 500, 502, 503, 504)

# 태스크 안의 요청은 끝난 뒤에도 이만큼(받은 것 저장·실행 기록) 남게 합니다. 첫 요청의 timeout을 그만큼 남기도록 줄이고
# (_GuardedAdapter), 재시도는 다음 대기 + 그 시도의 timeout 뒤에도 이만큼 남을 때만 합니다(_BudgetRetry).
RETRY_RESERVE_SECONDS = 10.0
# 예산이 거의 없을 때도 요청 timeout을 이보다 짧게 줄이지는 않습니다(0이나 음수 timeout은 requests가 받지 않음).
MIN_REQUEST_TIMEOUT = 1.0


# ==============================================================================
# 출처 거부 래치 (403·429·봇 차단 페이지) — Vibe stooq_loader의 래치를 공용 세션 층으로
# ==============================================================================
REJECT_STATUSES = frozenset({403, 429})
# 한 번 거부한 호스트를 닫아 두는 시간. 프로세스 수명 내내 닫지 않고 기한으로 풉니다 — 한 번의 일시 차단으로 그 출처를
# 계속 버리지 않게. fast 태스크 주기(5분)와 같아 다음 주기에 한 번 다시 물어봅니다.
REJECT_LATCH_SECONDS = 300.0
# 실행 기록·이어받은 값의 사유(staleReason)에 붙는 표지. 실행기(tasks/runner)가 이 글자로도 '거부됨'을 판정합니다.
REJECTED_MARK = "거부됨"
# yfinance는 자기 세션(curl_cffi)으로 query1·query2.finance.yahoo.com에 가서 이 층을 거치지 않습니다. 부르는 쪽
# (services/sector·us_calendar·earnings_surprise·market·krx의 KODEX 폴백)이 이 이름 하나로 래치를 함께 씁니다 — 같은 Yahoo
# 한도를 나눠 씀. 호스트 간격은 sector의 개별 재시도만 둡니다.
YAHOO_HOST = "finance.yahoo.com"

# 봇 차단(챌린지) 응답의 표지. 공용 세션은 HTML 페이지(Daum·Naver)도 받으므로 'HTML이면 거부'로 보지 않고(Vibe의 Stooq
# 판정은 CSV 엔드포인트라 그렇게 함), 차단 서비스가 붙이는 머리글과 차단 페이지에만 있는 본문 표지만 봅니다. 정상 페이지에도
# 들어가는 흔적 — Cloudflare가 보통 페이지에 넣는 /cdn-cgi/challenge-platform/ 스크립트, 본문의 'captcha' 단어 — 은 쓰지 않습니다.
_CHALLENGE_HEADERS: tuple[tuple[str, frozenset[str]], ...] = (
    ("cf-mitigated", frozenset({"challenge"})),                    # Cloudflare 챌린지 응답
    ("x-amzn-waf-action", frozenset({"challenge", "captcha"})),    # AWS WAF
)
_CHALLENGE_MARKERS: tuple[tuple[bytes, str], ...] = (
    (b"<title>just a moment...</title>", "Cloudflare 챌린지"),
    (b"window._cf_chl_opt", "Cloudflare 챌린지"),
    (b"<title>attention required! | cloudflare</title>", "Cloudflare 차단"),
    (b"_incapsula_resource", "Imperva 차단"),
    (b"captcha-delivery.com", "DataDome 캡차"),
    (b'id="px-captcha"', "PerimeterX 캡차"),
)
# 본문 표지는 앞부분만 봅니다(차단 페이지는 작고 표지가 앞에 있음 — 큰 정상 페이지를 끝까지 훑지 않게).
_CHALLENGE_SCAN_BYTES = 65536


class SourceRejected(requests.exceptions.RequestException):
    """
    출처가 이 수집기를 거부함 — 403·429·봇 차단 페이지(``why``), 또는 그 호스트가 래치로 닫혀 있는 동안의 요청(네트워크에
    나가지 않음). '데이터 없음'이 아닙니다.

    requests 예외라서 지금 ``except requests.RequestException``·``except Exception``으로 그 항목의 실패를 적는 자리가 그대로
    받습니다. 메시지는 화면에 뜨는 한 줄이라 주소(쿼리에 든 키)는 싣지 않고 호스트만 적습니다. 처음 거부와 닫힌 동안의 요청이
    같은 메시지라 사유 목록(_reason_suffix)에서 한 번으로 합쳐집니다.
    """

    def __init__(self, host: str, why: str) -> None:
        self.host = host
        self.why = why
        minutes = int(REJECT_LATCH_SECONDS // 60)
        super().__init__(f"{REJECTED_MARK} — {host} {why} · {minutes}분 동안 이 출처 호출을 멈춤")


class TaskGuard:
    """
    태스크 한 번의 실행이 HTTP 층과 나누는 것 — 시간 예산의 끝(``time.monotonic`` 기준)과 이번 실행이 만난 출처 거부.

    실행기(tasks/runner)가 만들어 작업 스레드에 걸고(:func:`run_guarded`), 끝난 뒤 ``rejected``로 '거부됨'을 판정합니다.
    태스크가 안에서 따로 연 스레드 풀에는 저절로 넘어가지 않습니다(contextvars는 ThreadPoolExecutor로 옮겨지지 않음). 그래서
    풀에 넘기는 함수를 :func:`bind_guard`로 묶습니다 — 기록은 잠금 안에서 하므로 여러 스레드가 함께 적어도 됩니다. 묶지 않은
    스레드의 거부는 사유 문자열의 표지(REJECTED_MARK)로만 판정되고, 그 재시도는 세션의 고정 횟수만 따릅니다.
    """

    __slots__ = ("deadline", "_rejected", "_lock")

    def __init__(self, deadline: float | None = None) -> None:
        self.deadline = deadline
        self._rejected: dict[str, str] = {}
        self._lock = threading.Lock()

    def note(self, host: str, why: str) -> None:
        with self._lock:
            self._rejected.setdefault(host, why)

    @property
    def rejected(self) -> dict[str, str]:
        """이번 실행이 만난 거부(호스트 → 처음 본 사유), 만난 순서대로."""
        with self._lock:
            return dict(self._rejected)

    def time_left(self) -> float | None:
        return None if self.deadline is None else self.deadline - _now()


_task_guard: contextvars.ContextVar[TaskGuard | None] = contextvars.ContextVar("collector_task_guard", default=None)


def run_guarded(guard: TaskGuard, fn: Callable[[], _T]) -> _T:
    """``guard``를 건 채 ``fn``을 부릅니다(작업 스레드에서). 끝나면 걸기 전 상태로 되돌립니다."""
    token = _task_guard.set(guard)
    try:
        return fn()
    finally:
        _task_guard.reset(token)


def bind_guard(fn: Callable[..., _T]) -> Callable[..., _T]:
    """
    지금 태스크의 TaskGuard를 ``fn``에 묶어 돌려줍니다 — 태스크가 안에서 연 스레드 풀에 넘길 함수에 씁니다
    (``pool.submit(bind_guard(f), …)``, ``pool.map(bind_guard(f), …)``). 묶은 함수는 어느 스레드에서 돌든 그 태스크의 거부
    기록과 시간 예산을 봅니다. 태스크 밖(/live/* 요청 경로)이면 ``fn``을 그대로 돌려줍니다.

    ``contextvars.copy_context().run``으로 감싸지 않는 이유: 한 Context는 두 스레드가 동시에 들어갈 수 없어(RuntimeError) 풀의
    여러 작업 스레드가 같은 함수를 부르는 map에서 깨집니다. 여기서는 가드 하나만 부를 때마다 걸고 되돌립니다.
    """
    guard = _task_guard.get()
    if guard is None:
        return fn

    @functools.wraps(fn)
    def bound(*args, **kwargs):
        return run_guarded(guard, lambda: fn(*args, **kwargs))

    return bound


def time_left() -> float | None:
    """지금 도는 태스크의 남은 시간(초). 태스크 밖(/live/* 요청 경로, bind_guard로 묶지 않은 스레드)이면 None."""
    guard = _task_guard.get()
    return guard.time_left() if guard is not None else None


# 테스트가 시계·잠을 바꿔 끼우는 자리입니다(SEC 토큰 버킷은 이것을 쓰지 않습니다 — 동작 그대로).
_now = time.monotonic
_sleep = time.sleep

_guard_lock = threading.Lock()
_latched: dict[str, tuple[float, str]] = {}    # 호스트 → (풀리는 시각, 사유)
_last_fire: dict[str, float] = {}              # 호스트 → 마지막으로 예약한 보낼 시각(pace)


def host_of(url: str) -> str:
    """요청 주소의 호스트(소문자). 래치·간격의 단위입니다."""
    return (urlsplit(url).hostname or "").lower()


def reject_host(host: str, why: str) -> SourceRejected:
    """
    ``host``를 REJECT_LATCH_SECONDS 동안 닫고 지금 태스크에 적은 뒤, 그 예외를 돌려줍니다(부르는 쪽이 raise).

    :param why: 거부 근거 한 줄("HTTP 429", "봇 차단 페이지(…)") — 주소·응답 본문은 싣지 않습니다
    """
    host = host.lower()
    with _guard_lock:
        _latched[host] = (_now() + REJECT_LATCH_SECONDS, why)
    logger.warning("출처 거부: %s %s — %d초 동안 이 호스트로 요청하지 않습니다", host, why, int(REJECT_LATCH_SECONDS))
    return _noted(SourceRejected(host, why))


def active_rejection(host: str) -> SourceRejected | None:
    """``host``가 래치로 닫혀 있으면 그 예외(지금 태스크에 적음), 아니면 None. 기한이 지난 래치는 여기서 풉니다."""
    host = host.lower()
    with _guard_lock:
        entry = _latched.get(host)
        if entry is None:
            return None
        until, why = entry
        if _now() >= until:
            del _latched[host]
            logger.info("출처 거부 래치 기한이 지나 %s에 다시 요청합니다", host)
            return None
    return _noted(SourceRejected(host, why))


def check_host(host: str) -> None:
    """:raises SourceRejected: ``host``가 래치로 닫혀 있을 때(요청을 보내지 않음)"""
    rejected = active_rejection(host)
    if rejected is not None:
        raise rejected


def _noted(exc: SourceRejected) -> SourceRejected:
    guard = _task_guard.get()
    if guard is not None:
        guard.note(exc.host, exc.why)
    return exc


def reset_guards() -> None:
    """래치·간격 기록을 비웁니다. 테스트 사이의 격리용입니다 — 운영에서는 기한으로만 풉니다."""
    with _guard_lock:
        _latched.clear()
        _last_fire.clear()


# ==============================================================================
# 호스트별 최소 간격 + 지터 — Vibe _http.HostThrottle과 같은 방식
# ==============================================================================
# 공용 세션의 한 호스트에 보내는 요청 사이 최소 간격(초)과 그 위에 얹는 지터 상한. 병렬 수집(KRX 8스레드 등)이 한 호스트를
# 같은 순간에 두드리지 않게 하는 정도로만 둡니다 — 호스트당 초당 약 3~5건.
DEFAULT_HOST_INTERVAL = 0.2
HOST_JITTER_MAX = 0.2
# FRED는 한 태스크가 시리즈 수십 개를 잇달아 묻습니다. 호스트당 초당 2건 아래로 둡니다.
FRED_HOST_INTERVAL = 0.5


def pace(host: str, min_interval: float, jitter: float = HOST_JITTER_MAX) -> None:
    """
    같은 호스트로 가는 요청 사이를 ``min_interval``초 이상 띄웁니다(프로세스 안, 스레드 사이).

    앞 요청과 이미 그만큼 떨어져 있으면 바로 보내고, 붙어 있으면 앞 예약 + 간격 + 지터(0~``jitter``초) 뒤로 줄을 세웁니다 —
    지터는 병렬 스레드가 같은 순간에 한꺼번에 깨어나지 않게 합니다. 예약한 시각(지터 포함)을 적어 두므로 몰려도 간격이
    줄지 않습니다. 잠금은 계산하는 동안만 잡고 기다리는 동안은 놓습니다(다른 호스트를 막지 않음).
    """
    if min_interval <= 0:
        return
    host = host.lower()
    with _guard_lock:
        now = _now()
        last = _last_fire.get(host)
        if last is None or now >= last + min_interval:
            fire_at = now
        else:
            fire_at = last + min_interval + random.uniform(0.0, max(jitter, 0.0))
        _last_fire[host] = fire_at
    wait = fire_at - _now()
    if wait > 0:
        _sleep(wait)


def rejection_reason(response: requests.Response, *, streamed: bool = False) -> str | None:
    """
    응답이 출처의 거부인지 — 403·429, 차단 서비스의 챌린지 머리글, 차단 페이지 본문 표지. 아니면 None.

    :param streamed: ``stream=True`` 요청이면 본문을 미리 읽지 않습니다(부르는 쪽의 크기 상한 읽기가 깨짐) — 상태·머리글만 봅니다
    """
    status = response.status_code
    if status in REJECT_STATUSES:
        return f"HTTP {status}"
    for name, values in _CHALLENGE_HEADERS:
        if (response.headers.get(name) or "").strip().lower() in values:
            return f"봇 차단 응답(HTTP {status}, {name})"
    if streamed:
        return None
    content_type = (response.headers.get("Content-Type") or "").lower()
    if content_type and "html" not in content_type:
        return None        # JSON·CSV·XML — 차단 페이지는 HTML입니다
    head = (response.content or b"")[:_CHALLENGE_SCAN_BYTES].lower()
    for marker, label in _CHALLENGE_MARKERS:
        if marker in head:
            return f"봇 차단 페이지(HTTP {status}, {label})"
    return None


class _BudgetRetry(Retry):
    """
    urllib3 Retry에 두 가지를 더합니다.

      - 408 말고는 4xx를 Retry-After가 있어도 다시 보내지 않습니다. urllib3는 413·429에 Retry-After가 붙으면 status_forcelist와
        상관없이 다시 보냅니다(Retry.RETRY_AFTER_STATUS_CODES). 429는 거부 래치가 맡습니다.
      - 태스크 안에서는 다음 대기 + 다음 시도의 timeout(_GuardedAdapter가 예산에 맞춰 줄인 값) 뒤에 RETRY_RESERVE_SECONDS가 남지
        않으면 더 보내지 않고 마지막 응답·오류를 그대로 돌려줍니다. 재시도 수 × (대기 + 요청 timeout)이 태스크 상한을 넘으면
        태스크가 '시간 초과'로 끝나고 작업 스레드가 좀비로 남습니다.
    """

    def is_retry(self, method: str, status_code: int, has_retry_after: bool = False) -> bool:
        if status_code < 500 and status_code not in TRANSIENT_STATUSES:
            return False
        return super().is_retry(method, status_code, has_retry_after)

    def increment(self, method=None, url=None, response=None, error=None, _pool=None, _stacktrace=None):
        retry = super().increment(method=method, url=url, response=response, error=error,
                                  _pool=_pool, _stacktrace=_stacktrace)
        left = time_left()
        if left is None:
            return retry
        wait = retry.get_backoff_time()
        if response is not None and retry.respect_retry_after_header:
            try:
                wait = max(wait, retry.get_retry_after(response) or 0.0)
            except Exception:  # noqa: BLE001 — 읽을 수 없는 Retry-After는 urllib3가 다시 보낼 때 따로 다룹니다
                pass
        attempt = _attempt_seconds.get() or 0.0
        if left - wait - attempt < RETRY_RESERVE_SECONDS:
            reason = error or ResponseError(f"태스크 시간 예산이 {max(left, 0.0):.0f}초 남아 다시 보내지 않음")
            raise MaxRetryError(_pool, url, reason) from reason
        return retry


# 지금 보내는 요청의 한 번 시도가 걸릴 수 있는 최대 초(연결 + 읽기 timeout). _GuardedAdapter가 적고, 같은 스레드에서 도는
# urllib3 재시도(_BudgetRetry.increment)가 '다음 시도도 예산 안에 끝나는지' 볼 때 씁니다. 태스크 밖이거나 모르면 None.
_attempt_seconds: contextvars.ContextVar[float | None] = contextvars.ContextVar("collector_attempt_seconds", default=None)


def _fit_timeout(timeout, left: float):
    """
    태스크 안의 요청 timeout을 남은 예산에 맞춥니다 → (보낼 timeout, 한 번의 시도가 걸릴 수 있는 최대 초).

    한 번의 시도는 연결 timeout + 읽기 timeout까지 걸립니다. 그 합이 '남은 예산 − RETRY_RESERVE_SECONDS'(최소
    MIN_REQUEST_TIMEOUT)를 넘으면 둘을 같은 비율로 줄입니다 — 예산 15초에 timeout 30초인 요청이 응답 없는 서버를 만나도 상한
    안에 끝나게. 없는 timeout(None, 끝없이 기다림)은 그 몫 전부로 봅니다. 모양을 모르는 값(urllib3 Timeout 객체)은 건드리지
    않습니다 — 이 저장소의 코드는 숫자나 (연결, 읽기)만 넘깁니다.
    """
    if isinstance(timeout, tuple) and len(timeout) == 2:
        connect, read = timeout
    elif timeout is None or (isinstance(timeout, (int, float)) and not isinstance(timeout, bool)):
        connect = read = timeout
    else:
        return timeout, None
    allowed = max(left - RETRY_RESERVE_SECONDS, MIN_REQUEST_TIMEOUT)
    connect = allowed if connect is None else float(connect)
    read = allowed if read is None else float(read)
    total = connect + read
    if total <= allowed:
        return timeout, total
    scale = allowed / total
    return (connect * scale, read * scale), allowed


class _GuardedAdapter(HTTPAdapter):
    """
    보내기 전 래치 확인 → 호스트 간격 → (태스크 안이면 timeout을 예산에 맞춤) → (urllib3가 일시 오류만 다시 보냄) → 받은 뒤
    거부 판정. 모듈 설명 1~3.
    """

    __attrs__ = [*HTTPAdapter.__attrs__, "min_interval"]

    def __init__(self, *, min_interval: float = 0.0, **kwargs) -> None:
        self.min_interval = min_interval
        super().__init__(**kwargs)

    def send(self, request, stream=False, timeout=None, **kwargs):
        host = host_of(request.url)
        check_host(host)
        pace(host, self.min_interval)
        check_host(host)        # 줄을 서 있는 사이 다른 스레드가 같은 호스트의 거부를 만났을 수 있습니다
        attempt = None
        left = time_left()      # 간격을 기다린 뒤에 잽니다
        if left is not None:
            timeout, attempt = _fit_timeout(timeout, left)
        token = _attempt_seconds.set(attempt)
        try:
            response = super().send(request, stream=stream, timeout=timeout, **kwargs)
        finally:
            _attempt_seconds.reset(token)
        why = rejection_reason(response, streamed=bool(stream))
        if why is not None:
            response.close()
            raise reject_host(host, why)
        return response


def _build_session(
    name: str,
    *,
    headers: dict,
    total_retries: int,
    backoff: float,
    pool_size: int,
    min_interval: float = 0.0,
) -> requests.Session:
    session = requests.Session()
    retry = _BudgetRetry(
        total=total_retries,
        backoff_factor=backoff,
        status_forcelist=TRANSIENT_STATUSES,
        allowed_methods=("GET", "POST"),
        raise_on_status=False,
        retry_after_max=RETRY_AFTER_MAX_SECONDS,
    )
    adapter = _GuardedAdapter(
        min_interval=min_interval,
        max_retries=retry,
        pool_connections=pool_size,
        pool_maxsize=pool_size,
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(headers)
    logger.debug("HTTP 세션 생성: %s", name)
    return session


def get_session() -> requests.Session:
    """일반 웹 소스(Daum/Naver/TradingView/CFTC)용 공용 세션."""
    return _get("default", headers=BROWSER_HEADERS, retries=2, backoff=0.5, pool=16,
                min_interval=DEFAULT_HOST_INTERVAL)


def get_fred_session() -> requests.Session:
    """
    FRED 전용 세션.

    FRED 웹 CSV는 기본 User-Agent로 요청하면 403을 주는 경우가 있어
    브라우저 헤더를 붙입니다.
    """
    return _get("fred", headers=BROWSER_HEADERS, retries=3, backoff=0.8, pool=8, min_interval=FRED_HOST_INTERVAL)


def get_sec_session() -> requests.Session:
    """
    SEC EDGAR 전용 세션 (연락처 포함 UA + 넉넉한 재시도).

    UA가 없으면 여기서 SecUserAgentMissing이 납니다. 세션을 만들어 두고
    나중에 403을 받는 것보다, 요청 전에 설정 누락을 말하는 쪽이 낫습니다.

    호스트 간격은 두지 않습니다(min_interval 0) — SEC의 속도는 부르는 쪽이 먼저 거치는 토큰 버킷(:func:`sec_rate_limit`,
    전체 합계 초당 8건)이 정합니다. 여기에 간격을 더 얹으면 병렬 13F 수집이 그만큼 느려집니다. 거부 래치는 그대로 걸립니다
    (SEC는 한도를 넘긴 요청을 403으로 막음).
    """
    headers = sec_headers()
    session = _get("sec", headers=headers, retries=5, backoff=1.5, pool=10)
    # .env를 고치고 컨테이너만 재시작한 경우에도 새 UA가 반영되도록 맞춰 둡니다.
    if session.headers.get("User-Agent") != headers["User-Agent"]:
        session.headers.update(headers)
    return session


# BLS(www.bls.gov) RSS — 모의 매매 사건 뉴스(2단계 B). BLS 앞단(Akamai)은 브라우저 User-Agent를 403으로 막고, 무엇을 하는
# 프로그램인지 밝힌 설명형 UA는 받습니다(단계 0). 연락처는 싣지 않습니다 — 소유자 이메일(SEC_USER_AGENT)은 SEC가 의무로 요구해서
# 그쪽에만 보내는 값이고, 다른 기관에 넘길 이유가 없습니다.
BLS_HEADERS = {
    "User-Agent": _UA_PRODUCT,
    "Accept": "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.5",
}


def get_bls_session() -> requests.Session:
    """
    BLS 전용 세션 — 설명형 UA.

    BLS의 403은 일시 장애가 아니라 차단 판정이라 다시 보내도 같고, 같은 거절을 되풀이하면 차단이 길어질 수 있습니다. 예전에는
    이 세션만 403을 다시 보내지 않았는데, 지금은 모든 공용 세션이 403·429를 다시 보내지 않고 거부 래치로 닫습니다.
    5xx·연결 오류는 두 번까지 다시 보냅니다.
    """
    return _get("bls", headers=BLS_HEADERS, retries=2, backoff=0.8, pool=2, min_interval=DEFAULT_HOST_INTERVAL)


def get_api_session(name: str) -> requests.Session:
    """
    증권사 Open API(토스·KIS·LS)용 세션 — 연결(TCP·TLS)만 재사용합니다.

    예전에는 호출마다 requests.get/post로 새로 연결했습니다. 아래 두 가지는 그때와 같습니다.
      - 재시도하지 않습니다. 이 API들은 부르는 쪽이 401(토큰 재발급)·429(Retry-After 대기)·
        403(허용 IP)을 직접 처리합니다. 공용 세션처럼 어댑터가 403·429를 다시 보내면 그
        처리와 겹치고, 토큰 발급 POST가 두 번 나가 먼저 받은 토큰이 무효가 될 수 있습니다.
      - 쿠키를 저장하지 않습니다. 이전 응답의 쿠키가 다음 요청에 실리지 않습니다.
    인증 헤더는 요청마다 넘깁니다(세션에 두지 않음). 거부 래치·호스트 간격도 걸지 않습니다(같은 이유 — 부르는 쪽이 다룸).

    :param name: 클라이언트 이름 (toss / kis / ls). 이름마다 세션이 하나입니다
    """
    with _lock:
        session = _sessions.get(name)
        if session is None:
            session = requests.Session()
            session.cookies.set_policy(DefaultCookiePolicy(allowed_domains=[]))
            adapter = HTTPAdapter(pool_connections=4, pool_maxsize=8)  # max_retries 기본값 0
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            _sessions[name] = session
            logger.debug("HTTP 세션 생성: %s", name)
        return session


def _get(
    name: str, *, headers: dict, retries: int, backoff: float, pool: int, min_interval: float = 0.0,
) -> requests.Session:
    with _lock:
        session = _sessions.get(name)
        if session is None:
            session = _build_session(
                name,
                headers=headers,
                total_retries=retries,
                backoff=backoff,
                pool_size=pool,
                min_interval=min_interval,
            )
            _sessions[name] = session
        return session


# ==============================================================================
# 실패 사유 문자열
# ==============================================================================
# requests 예외를 그대로 문자열로 만들면 urllib3 스택이 통째로 들어옵니다.
#   "HTTPSConnectionPool(host='fred.stlouisfed.org', port=443): Max retries
#    exceeded with url: /graph/fredgraph.csv?id=DGS2 (Caused by ProxyError(…"
# 이걸 120자로 자르면 괄호가 짝이 안 맞는 채로 끊겨 더 읽기 어려워집니다.
# 사유는 로그가 아니라 **화면에 뜨는 한 줄**이므로, 조치로 이어지는 문장으로
# 압축합니다.
_ERROR_HINTS: tuple[tuple[str, str], ...] = (
    ("proxy", "프록시가 연결을 막았습니다 (회사망·보안 프로그램·Docker 프록시 설정 확인)"),
    ("timed out", "응답이 없어 시간이 초과됐습니다"),
    ("timeout", "응답이 없어 시간이 초과됐습니다"),
    ("ssl", "TLS 검증에 실패했습니다"),
    ("name or service not known", "도메인 이름을 찾지 못했습니다 (DNS)"),
    ("nodename nor servname", "도메인 이름을 찾지 못했습니다 (DNS)"),
    ("connection refused", "서버가 연결을 거부했습니다"),
    ("max retries exceeded", "재시도를 모두 소진했습니다 (연결 불가)"),
)


def brief_error(exc: BaseException, *, limit: int = 110) -> str:
    """예외를 '무엇을 해야 하는지'가 보이는 한 줄로 줄입니다."""
    if isinstance(exc, SourceRejected):
        # 이미 화면용 한 줄입니다(호스트·근거·멈춘 시간). 앞에 예외 이름을 붙이지 않아야 '거부됨'이 첫머리에 보입니다.
        return str(exc)
    text = str(exc)
    lowered = text.lower()
    for needle, hint in _ERROR_HINTS:
        if needle in lowered:
            return f"{type(exc).__name__} — {hint}"

    collapsed = " ".join(text.split())
    if len(collapsed) > limit:
        # 자를 때 괄호가 열린 채 끝나지 않도록 마지막 '(' 이후를 버립니다.
        collapsed = collapsed[:limit]
        opened = collapsed.rfind("(")
        if opened > limit // 2 and collapsed.count("(") > collapsed.count(")"):
            collapsed = collapsed[:opened]
        collapsed = collapsed.rstrip(" ,;:(") + "…"
    return f"{type(exc).__name__}: {collapsed}" if collapsed else type(exc).__name__


# ==============================================================================
# SEC 레이트 리미터 (초당 요청 한도 준수 + 병렬 수집 허용)
# ==============================================================================
# SEC EDGAR는 초당 10요청을 넘기면 차단합니다. 요청 사이에 sleep을 넣는 방식은
# 호출을 **직렬화**해서 기관 12곳 × 8분기 = 약 200요청이 한 줄로 늘어섭니다.
# 토큰 버킷은 "전체 합계가 초당 N건"만 지키므로 병렬 수집이 가능합니다.
# 한도는 10이 아니라 8로 둡니다(버스트·시계 오차 여유분).
_SEC_MAX_RPS = 8.0
_sec_lock = threading.Lock()
_sec_next_slot = [0.0]


def sec_rate_limit() -> None:
    interval = 1.0 / _SEC_MAX_RPS
    with _sec_lock:
        now = time.monotonic()
        slot = max(now, _sec_next_slot[0])
        _sec_next_slot[0] = slot + interval
    wait = slot - time.monotonic()
    if wait > 0:
        time.sleep(wait)
