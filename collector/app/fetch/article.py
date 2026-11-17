"""
app/fetch/article.py
기사 한 건 받기(ADR 0043 — 정보 검색 본문 보기). 운영자가 '본문 보기'를 누른 글 하나의 HTML을 받습니다. 차단 통과 계층의 정책 표(policy.POLICIES)
밖의 호스트를 받는 **유일한 길**이고, 사다리(ladder.fetch)·정책 표·표 fetch_hosts를 쓰지 않습니다. 부르는 쪽은 services/search_article의
작업자 하나뿐입니다(운영 서버에서만 — POLITE_FETCH_ENABLED).

홉마다(시작 주소·리다이렉트 목적지 모두) 같은 검사를 처음부터 다시 받습니다.
  1) 정적 주소 검사(addresses.check_url) → 받지 않는 호스트(부르는 쪽의 규칙 — ``refused``) → 이 기능이 닫은 호스트(6시간) → 공용 세션의 5분
     래치가 닫은 호스트(읽기만 — http.latch_remaining) → 남은 시간(5초 미만이면 보내지 않음)
  2) 이름 풀기 — 풀린 주소 전부가 공인일 때만(addresses.checked_addresses), 그 주소로 고정해 붙음(curl RESOLVE — DNS 재바인딩 막기)
  3) 호스트 하루 예산(fetch_budgets — 그 호스트, 용도 article, 하루 :data:`HOST_DAILY_BUDGET`) → 같은 호스트 간격(http.pace 2초)
  4) 한 번 보냄 — 브라우저와 같은 TLS·헤더(curl_cffi impersonate, 설치된 데스크톱 Chrome 프로필 가운데 가장 새것 하나로 고정), User-Agent를
     덮어쓰지 않고 Accept·Accept-Language만 얹음, Referer 없음, 리다이렉트를 따라가지 않음(아래에서 직접), http·https만(PROTOCOLS_STR),
     압축을 푼 본문 :data:`MAX_BYTES`까지(받는 도중 세다가 넘으면 끊음). 홉마다 요청 하나뿐인 새 세션이라 받은 Alt-Svc 머리글이 다른 요청을
     옮길 수 없습니다(alt-svc 캐시 파일 CURLOPT_ALTSVC를 걸지 않음 — ALTSVC_CTRL 0은 libcurl이 '잘못된 인자'로 거절해 모든 요청이 실패했음).
  5) 판정 — 3xx(301·302·303·307·308)는 목적지로 다시 1부터(최대 :data:`MAX_REDIRECTS`번), 403·429·봇 확인 표지는 거부(이 기능 안에서만 그
     호스트를 6시간 닫음 — 공용 세션의 래치는 부르지 않음, ADR 0026 결정 2와 같은 이유), 401·402·451도 거부(닫지 않음), 404·410·그 밖 4xx·5xx는
     HTTP 오류, 2xx는 HTML(text/html·application/xhtml+xml)일 때만.
프록시 환경변수가 있으면 고정 주소가 뜻이 없으므로 보내지 않습니다(QA 수집기는 차단 프록시를 이 이름으로 받음 — 스위치와 두 겹).
로그·사유 글에는 호스트와 상태만 남깁니다(경로·인자·제목 없음 — ADR 0041 결정 12와 같은 규칙).
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from urllib.parse import urljoin

from curl_cffi import requests as curl_requests
from curl_cffi.const import CurlECode, CurlOpt
from curl_cffi.curl import CURL_WRITEFUNC_ERROR, CurlError
from curl_cffi.requests import exceptions as curl_exceptions

from .. import http, kst, store
from . import addresses, state

logger = logging.getLogger(__name__)

PURPOSE = "article"                 # 표 fetch_budgets의 용도
MAX_BYTES = 3_000_000               # 압축을 푼 본문의 상한(바이트)
MAX_REDIRECTS = 3                   # 따라가는 리다이렉트 수(요청은 최대 4건)
CONNECT_TIMEOUT = 5.0
READ_TIMEOUT = 15.0
MIN_SEND_SECONDS = 5.0              # 남은 작업 시간이 이보다 적으면 보내지 않음
HOST_INTERVAL = 2.0                 # 같은 호스트 요청 사이(초)
HOST_DAILY_BUDGET = 20              # 기사 호스트 하나의 하루(KST) 요청 수 — 홉마다 한 건
BLOCK_SECONDS = 6 * 3600.0          # 거부한 호스트를 이 기능 안에서 닫아 두는 시간
BLOCK_MAX_SECONDS = 24 * 3600.0     # Retry-After가 더 길어도 이만큼까지
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
REJECT_STATUSES = frozenset({403, 429})
LOGIN_STATUSES = frozenset({401, 402, 451})
HTML_TYPES = ("text/html", "application/xhtml+xml")
PROXY_ENV = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
ACCEPT_LANGUAGE = "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"


class ArticleFetchError(Exception):
    """
    받지 못함 — ``reason``은 사유 코드(계약 §10 표 — refused_host·unsafe_address·bad_redirect·blocked·budget·timeout·transport·too_large·not_html·
    http_error·server_only), ``message``는 화면 글(호스트·상태만), ``retryable``은 잠시 뒤 다시 누르면 될 수 있는지, ``status``는 HTTP 상태(있으면),
    ``sent``는 요청이 하나라도 나갔는지.
    """

    def __init__(self, reason: str, message: str, *, retryable: bool = False, host: str | None = None,
                 status: int | None = None, sent: bool = False) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.retryable = retryable
        self.host = host
        self.status = status
        self.sent = sent


@dataclass(frozen=True)
class Page:
    """받은 쪽 — 마지막 홉의 주소(조각 없음)·상태·Content-Type·본문(압축을 푼 바이트)·따라간 리다이렉트 수."""
    final_url: str
    host: str
    status: int
    content_type: str
    body: bytes
    hops: int


@dataclass
class Reply:
    """한 홉의 답(:func:`_send_hop`) — 머리글 이름은 소문자, ``cookies``는 이 홉에서 받은 쿠키(같은 호스트의 다음 홉에만 넘김)."""
    status: int
    headers: dict[str, str]
    body: bytes
    cookies: dict[str, str] = field(default_factory=dict)


# ------------------------------------------------------------------ 이 기능 안의 호스트 닫힘(메모리)

_lock = threading.Lock()
_blocked: dict[str, tuple[float, str]] = {}     # 호스트 → (풀리는 시각 monotonic, 사유)


def _clock() -> float:
    return time.monotonic()


def blocked_reason(host: str) -> tuple[float, str] | None:
    """이 기능이 그 호스트를 닫아 두었으면 (남은 초, 사유), 아니면 None."""
    with _lock:
        entry = _blocked.get(host)
        if entry is None:
            return None
        left = entry[0] - _clock()
        if left <= 0:
            _blocked.pop(host, None)
            return None
        return left, entry[1]


def _block(host: str, why: str, retry_after: float | None) -> float:
    seconds = min(max(BLOCK_SECONDS, retry_after or 0.0), BLOCK_MAX_SECONDS)
    with _lock:
        _blocked[host] = (_clock() + seconds, why)
    logger.warning("기사 받기: %s %s — 이 기능 안에서 %d시간 다시 묻지 않습니다", host, why, int(seconds // 3600))
    return seconds


def reset() -> None:
    """시험용 — 이 기능의 호스트 닫힘을 비웁니다."""
    with _lock:
        _blocked.clear()


# ------------------------------------------------------------------ 바꿔 끼우는 자리

def proxy_configured() -> bool:
    """프록시 환경변수가 있는가 — 있으면 고정 주소가 뜻이 없어 받지 않습니다."""
    return any((os.environ.get(name) or "").strip() for name in PROXY_ENV)


def profile() -> str:
    """고정 프로필 — 설치된 curl_cffi가 아는 데스크톱 Chrome 가운데 가장 새것(표에 쓰지 않음 — 기사 호스트마다 fetch_hosts 줄을 만들지 않음)."""
    return state.profile_candidates()[0]


def _today() -> date:
    return datetime.now(timezone.utc).astimezone(kst.KST).date()


def _take_host_budget(host: str) -> bool:
    return store.take_search_budget(host, PURPOSE, _today(), HOST_DAILY_BUDGET)


def _send_hop(url: str, *, pin: str, cookies: dict[str, str], timeout: tuple[float, float]) -> Reply:
    """
    한 홉을 보냅니다(네트워크 — 시험이 바꿔 끼우는 자리). 홉마다 새 세션(고정 주소는 세션 단위 값)이고 리다이렉트를 따라가지 않습니다.

    :raises ArticleFetchError: 연결·시간 초과(transport·timeout), 본문이 상한을 넘음(too_large), 세션 옵션을 걸지 못함(transport — 요청이
        나가기 전이라 ``sent``가 거짓)
    """
    received = 0
    chunks: list[bytes] = []
    too_big = False

    def take(chunk: bytes) -> int:
        nonlocal received, too_big
        received += len(chunk)
        if received > MAX_BYTES:
            too_big = True
            return CURL_WRITEFUNC_ERROR
        chunks.append(chunk)
        return len(chunk)

    host = http.host_of(url)
    session = curl_requests.Session(
        impersonate=profile(),
        curl_options={
            CurlOpt.RESOLVE: [pin],
            CurlOpt.PROTOCOLS_STR: "http,https",
            CurlOpt.MAXFILESIZE_LARGE: MAX_BYTES,
        },
    )
    try:
        response = session.request("GET", url, headers={"Accept": ACCEPT, "Accept-Language": ACCEPT_LANGUAGE},
                                   cookies=cookies or None, timeout=timeout, allow_redirects=False, content_callback=take)
        got_cookies = {name: value for name, value in session.cookies.items()}
    except curl_exceptions.RequestException as exc:
        code = getattr(exc, "code", 0)
        if too_big or code == CurlECode.FILESIZE_EXCEEDED:
            raise ArticleFetchError("too_large", f"페이지가 {MAX_BYTES // 1_000_000}MB를 넘어 받지 않았습니다", host=host,
                                    sent=True) from None
        if code == CurlECode.OPERATION_TIMEDOUT or isinstance(exc, curl_exceptions.Timeout):
            raise ArticleFetchError("timeout", f"{host}의 응답이 늦어 끊었습니다", retryable=True, host=host, sent=True) from None
        raise ArticleFetchError("transport", f"{host}에 연결하지 못했습니다", retryable=True, host=host, sent=True) from None
    except CurlError as exc:
        # 요청 오류(RequestException)가 아닌 curl 오류 — 세션 옵션을 거는 단계(setopt)에서 나서 요청이 나가지 않았습니다. 잡지 않으면 작업자의
        # 일반 예외 처리까지 올라가 사유가 흐려졌습니다(코드만 남김 — 글에는 옵션 번호뿐이지만 같은 규칙).
        logger.warning("기사 받기: curl 설정 실패(코드 %s)", getattr(exc, "code", "?"))
        raise ArticleFetchError("transport", f"{host}에 보낼 준비를 하지 못했습니다", retryable=True, host=host, sent=False) from None
    finally:
        session.close()
    return Reply(status=response.status_code,
                 headers={str(name).lower(): str(value) for name, value in response.headers.items()},
                 body=b"".join(chunks), cookies=got_cookies)


# ------------------------------------------------------------------ 한 건 받기

def _is_html(content_type: str, body: bytes) -> bool:
    lowered = content_type.lower()
    if any(kind in lowered for kind in HTML_TYPES):
        return True
    if lowered.strip():
        return False
    head = body[:1024].lower()
    return b"<!doctype html" in head or b"<html" in head


def _check_hop(url: str, *, hop: int, refused) -> addresses.Target:
    """홉 하나의 정적 검사 + 받지 않는 호스트 + 닫힌 호스트. 첫 홉의 주소 모양 실패는 unsafe_address, 리다이렉트의 것은 bad_redirect."""
    try:
        target = addresses.check_url(url)
    except addresses.AddressRefused as exc:
        if hop == 0:
            raise ArticleFetchError("unsafe_address", exc.message, host=exc.host) from None
        raise ArticleFetchError("bad_redirect", f"허용하지 않는 곳으로 옮겨져 받지 않았습니다({exc.message})", host=exc.host) from None
    why = refused(target.host) if refused is not None else None
    if why:
        raise ArticleFetchError("refused_host", f"{why}({target.host})", host=target.host)
    shut = blocked_reason(target.host)
    if shut is not None:
        hours = max(1, int(shut[0] // 3600) + (1 if shut[0] % 3600 else 0))
        raise ArticleFetchError("blocked", f"{target.host}가 요청을 거부해({shut[1]}) 약 {hours}시간 동안 이 매체는 다시 묻지 않습니다",
                                host=target.host)
    if http.latch_remaining(target.host) is not None:
        raise ArticleFetchError("blocked", f"{target.host}가 같은 서버의 다른 수집을 거부해 잠시 묻지 않습니다", retryable=True,
                                host=target.host)
    return target


def fetch_page(url: str, *, deadline: float, refused=None) -> Page:
    """
    ``url``의 HTML 한 쪽(리다이렉트 포함). ``deadline``은 ``time.monotonic()`` 기준 작업의 끝, ``refused(host)``는 받지 않는 호스트면 그 까닭
    (화면 글), 받아도 되면 None을 돌려주는 함수입니다(부르는 쪽의 규칙 — 시작 주소와 모든 리다이렉트 홉에 적용).

    :raises ArticleFetchError: 받지 못함(사유 코드는 클래스 설명)
    """
    if proxy_configured():
        raise ArticleFetchError("server_only", "프록시가 설정된 곳에서는 본문을 받지 않습니다")
    current = url
    cookies: dict[str, str] = {}
    cookie_host: str | None = None
    sent = False
    for hop in range(MAX_REDIRECTS + 1):
        target = _check_hop(current, hop=hop, refused=refused)
        host = target.host
        left = deadline - _clock()
        if left < MIN_SEND_SECONDS:
            raise ArticleFetchError("timeout", "작업 시간이 모자라 보내지 않았습니다", retryable=True, host=host, sent=sent)
        try:
            pinned = addresses.checked_addresses(host, target.port, timeout=min(addresses.RESOLVE_TIMEOUT, left - 1.0))
        except addresses.AddressRefused as exc:
            if exc.reason == "unresolved":
                raise ArticleFetchError("transport", exc.message, retryable=True, host=host, sent=sent) from None
            raise ArticleFetchError("unsafe_address", exc.message, host=host, sent=sent) from None
        try:
            allowed = _take_host_budget(host)
        except Exception as exc:  # noqa: BLE001 — 예산을 셀 수 없으면 보내지 않음(닫힌 실패)
            logger.info("기사 받기: 호스트 예산을 읽지 못함(%s)", type(exc).__name__)
            raise ArticleFetchError("budget", "예산을 확인하지 못해 보내지 않았습니다", host=host, sent=sent) from None
        if not allowed:
            raise ArticleFetchError("budget", f"오늘 {host}에서 {HOST_DAILY_BUDGET}건을 받았습니다 — 내일(KST) 다시", host=host, sent=sent)
        http.pace(host, HOST_INTERVAL)
        left = deadline - _clock()
        if left < MIN_SEND_SECONDS:
            raise ArticleFetchError("timeout", "작업 시간이 모자라 보내지 않았습니다", retryable=True, host=host, sent=sent)
        scale = min(1.0, (left - 1.0) / (CONNECT_TIMEOUT + READ_TIMEOUT))
        timeout = (CONNECT_TIMEOUT * scale, READ_TIMEOUT * scale)
        pin = addresses.pin_entry(host, target.port, pinned)
        try:
            reply = _send_hop(target.url, pin=pin, cookies=cookies if cookie_host == host else {}, timeout=timeout)
        except ArticleFetchError as exc:
            exc.sent = exc.sent or sent        # 한 홉 보내기가 정한 값(설정 실패면 거짓) + 앞 홉
            logger.info("기사 받기: %s %s", host, exc.reason)
            raise
        sent = True
        status = reply.status
        sign = http.challenge_sign(reply.headers, reply.body)
        if status in REJECT_STATUSES or sign is not None:
            why = f"HTTP {status}" + (f" · {sign}" if sign else "")
            _block(host, why, http.retry_after_seconds(reply.headers.get("retry-after")))
            raise ArticleFetchError("blocked", f"{host}가 요청을 거부했습니다({why}) — 6시간 동안 이 매체는 다시 묻지 않습니다",
                                    host=host, status=status, sent=True)
        if status in REDIRECT_STATUSES:
            location = (reply.headers.get("location") or "").strip()
            logger.info("기사 받기: %s HTTP %d(옮김)", host, status)
            if not location:
                raise ArticleFetchError("bad_redirect", f"{host}가 목적지 없이 옮기라고 답해 받지 않았습니다", host=host, status=status,
                                        sent=True)
            if hop >= MAX_REDIRECTS:
                raise ArticleFetchError("bad_redirect", f"{MAX_REDIRECTS}번을 넘게 옮겨져 받지 않았습니다", host=host, status=status, sent=True)
            try:
                current = urljoin(target.url, location)
            except ValueError:
                raise ArticleFetchError("bad_redirect", "옮길 곳의 주소를 읽지 못해 받지 않았습니다", host=host, status=status,
                                        sent=True) from None
            cookies, cookie_host = reply.cookies, host
            continue
        logger.info("기사 받기: %s HTTP %d", host, status)
        if status in LOGIN_STATUSES:
            raise ArticleFetchError("blocked", f"{host} HTTP {status} — 로그인·유료·법적 사유로 막힌 글입니다", host=host, status=status,
                                    sent=True)
        if status in (404, 410):
            raise ArticleFetchError("http_error", f"{host} HTTP {status} — 글을 찾지 못했습니다", host=host, status=status, sent=True)
        if status >= 500:
            raise ArticleFetchError("http_error", f"{host} HTTP {status} — 매체 쪽 오류입니다", retryable=True, host=host, status=status,
                                    sent=True)
        if not 200 <= status < 300:
            raise ArticleFetchError("http_error", f"{host} HTTP {status}", host=host, status=status, sent=True)
        content_type = reply.headers.get("content-type") or ""
        if not _is_html(content_type, reply.body):
            raise ArticleFetchError("not_html", "HTML 글이 아닙니다(PDF 등) — 원문 열기로 보세요", host=host, status=status, sent=True)
        return Page(final_url=target.url, host=host, status=status, content_type=content_type, body=reply.body, hops=hop)
    raise ArticleFetchError("bad_redirect", f"{MAX_REDIRECTS}번을 넘게 옮겨져 받지 않았습니다", sent=sent)  # pragma: no cover — 위 고리가 끝냄
