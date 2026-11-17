"""
app/services/search_relay.py
구글 뉴스 경유 주소(``https://news.google.com/rss/articles/<ID>?oc=5``)를 원문 주소로 풉니다 — 정보 검색 본문 보기(ADR 0043)에서 운영자가 그 줄의
'본문 보기'를 **누를 때만**. 검색 결과를 만들 때는 풀지 않습니다(ADR 0041 결정 7 그대로).

요청이 가장 적은 순서로, 앞 단계에서 끝나면 멈춥니다.
  1. 요청 0건 — 옛 모양: ``<ID>``를 base64url로 풀어 그 안에 http(s) 주소가 통째로 들어 있으면 그 주소(protobuf 필드 머리 ``08 13 22`` + 길이 + 주소).
  2. 요청 1건 — 경유 쪽 ``GET https://news.google.com/rss/articles/<ID>``(HTML, 1MB까지): 원문 주소가 바로 있으면(``data-n-au`` 속성·
     ``meta refresh``·구글 밖을 가리키는 ``link rel=canonical``·``noscript`` 안의 구글 밖 링크) 끝. 없으면 같은 쪽에서 서명(``data-n-a-sg``)·
     시각(``data-n-a-ts``)을 읽어 3으로.
  3. 요청 1건 더 — 구글 내부 경로 ``POST https://news.google.com/_/DotsSplashUi/data/batchexecute``(양식 ``f.req`` — ``garturlreq`` 묶음에 ID·시각·
     서명), 답의 머리 ``)]}'``를 떼고 ``garturlres`` 다음 글자를 원문 주소로.
2·3은 공개 문서가 없는 구글 내부 모양이라(공개 디코더들이 쓰는 모양 — 코드는 가져오지 않고 요청 모양만 참고) 바뀌면 그날부터 '풀지 못함'입니다.
시험은 합성 표본만이라 모양 변화를 잡지 못합니다 — 서버 첫 사용 때 실측합니다.

- 세션은 공용 HTTP 층의 재시도 없는 세션(``http.get_relay_session`` — 래치·간격·거부 판정). news.google.com이 닫혀 있으면 보내지 않고, 이 요청이
  거부되면 그 호스트를 5분 닫습니다(구글 RSS 검색도 5분 멈춤 — 같은 IP라 어차피 함께 막힘).
- 하루 예산: ``fetch_budgets(news.google.com, article)`` :data:`DAILY_BUDGET`건(요청마다 한 건, KST). 읽지 못하면 보내지 않음.
- 리다이렉트는 따라가지 않습니다 — 2의 답이 3xx(동의 화면 등)면 '풀지 못함'.
- 풀린 주소는 http(s)이고 구글이 아닌 호스트여야 합니다(부르는 쪽이 받지 않는 매체·주소 검사를 처음부터 다시 함 — 구글이 준 주소도 믿지 않음).
- 로그에는 호스트·상태만(ID·주소 없음).
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from .. import http, kst, store
from . import search_rules as rules

logger = logging.getLogger(__name__)

HOST = "news.google.com"
PAGE_URL = "https://news.google.com/rss/articles/{id}"
BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute"
PURPOSE = "article"
DAILY_BUDGET = 60                 # 구글 경유 풀기 요청의 하루(KST) 상한
PAGE_MAX_BYTES = 1_000_000
TIMEOUT = (5.0, 10.0)
GOOGLE_SUFFIXES = ("google.com", "google.co.kr", "googleusercontent.com", "gstatic.com", "googleapis.com", "youtube.com", "goo.gl")
_ID = re.compile(r"^/(?:rss/)?articles/([A-Za-z0-9_\-]{8,4096})/?$")
_REFRESH = re.compile(r"url\s*=\s*['\"]?([^'\";]+)", re.IGNORECASE)
_GARTURL = re.compile(r'garturlres\\*",\\*"(https?:[^"\\]+)')

UNRESOLVED = "구글 경유 주소를 원문 주소로 풀지 못했습니다 — 원문 열기는 브라우저가 옮겨 줍니다"


class RelayUnresolved(Exception):
    """
    풀지 못함 — ``reason``은 본문 보기의 사유 코드(계약 §10-3 — 하루 예산을 다 썼거나 읽지 못하면 ``budget``, 그 밖은 ``relay_unresolved``),
    ``retryable``은 전송 실패(잠시 뒤 다시 누르면 될 수 있음), ``requests``는 보낸 요청 수.
    """

    def __init__(self, message: str, *, retryable: bool = False, requests: int = 0, reason: str = "relay_unresolved") -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable
        self.requests = requests
        self.reason = reason


@dataclass(frozen=True)
class Resolved:
    """풀린 원문 주소와 그때 보낸 요청 수(0~2)."""
    url: str
    requests: int


# ------------------------------------------------------------------ 순수 함수

def relay_id(url: str | None) -> str | None:
    """경유 주소 → ``<ID>``. news.google.com의 ``/rss/articles/<ID>``·``/articles/<ID>``가 아니면 None."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or (parts.hostname or "").lower() != HOST:
        return None
    match = _ID.match(parts.path)
    return match.group(1) if match else None


def _varint(data: bytes, pos: int) -> tuple[int, int] | None:
    value = 0
    shift = 0
    while pos < len(data) and shift < 35:
        byte = data[pos]
        value |= (byte & 0x7F) << shift
        pos += 1
        if not byte & 0x80:
            return value, pos
        shift += 7
    return None


def decode_offline(article_id: str) -> str | None:
    """요청 0건 풀기 — 옛 모양 ID(풀린 바이트 안에 주소가 통째로 있음)면 그 주소, 새 모양(불투명한 표지)이거나 읽지 못하면 None."""
    try:
        raw = base64.urlsafe_b64decode(article_id + "=" * (-len(article_id) % 4))
    except (binascii.Error, ValueError):
        return None
    if raw.startswith(b"\x08\x13\x22"):
        raw = raw[3:]
    elif raw.startswith(b"\x22"):
        raw = raw[1:]
    else:
        return None
    read = _varint(raw, 0)
    if read is None:
        return None
    length, pos = read
    text = raw[pos:pos + length]
    if len(text) != length or not text.startswith((b"http://", b"https://")):
        return None
    try:
        url = text.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return url if usable(url) else None


def is_google(host: str) -> bool:
    host = host.lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix) for suffix in GOOGLE_SUFFIXES)


def usable(url: str | None) -> bool:
    """풀린 주소로 쓸 수 있는가 — http(s)이고 호스트가 있고 구글이 아님(나머지 검사는 부르는 쪽이 처음부터)."""
    domain = rules.domain_of(url)
    if not domain:
        return False
    return not is_google(http.host_of(url or ""))


def parse_page(markup: str) -> tuple[str | None, tuple[str, str] | None]:
    """
    경유 쪽 HTML → (바로 찾은 원문 주소, 없으면 None · (서명, 시각) — 3단계 재료, 없으면 None).
    """
    soup = BeautifulSoup(markup or "", "lxml")
    for tag in soup.find_all(attrs={"data-n-au": True}):
        candidate = str(tag.get("data-n-au") or "").strip()
        if usable(candidate):
            return candidate, None
    for meta in soup.find_all("meta"):
        if str(meta.get("http-equiv") or "").lower() == "refresh":
            found = _REFRESH.search(str(meta.get("content") or ""))
            if found and usable(found.group(1).strip()):
                return found.group(1).strip(), None
    for link in soup.find_all("link", href=True):
        rel = link.get("rel") or []
        rel = rel if isinstance(rel, list) else [rel]
        if "canonical" in [str(value).lower() for value in rel] and usable(str(link["href"]).strip()):
            return str(link["href"]).strip(), None
    for holder in soup.find_all("noscript"):
        inner = BeautifulSoup(holder.decode_contents(), "lxml")
        for anchor in inner.find_all("a", href=True):
            candidate = str(anchor["href"]).strip()
            if usable(candidate):
                return candidate, None
    for tag in soup.find_all(attrs={"data-n-a-sg": True, "data-n-a-ts": True}):
        signature = str(tag.get("data-n-a-sg") or "").strip()
        stamp = str(tag.get("data-n-a-ts") or "").strip()
        if signature and stamp.isdigit():
            return None, (signature, stamp)
    return None, None


def batch_form(article_id: str, signature: str, stamp: str) -> dict[str, str]:
    """3단계 요청의 양식 — ``garturlreq`` 묶음(공개 디코더들이 쓰는 모양)."""
    inner = json.dumps([
        "garturlreq",
        [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None, None, None, None, 0, 1],
         "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
        article_id, int(stamp), signature,
    ], separators=(",", ":"))
    return {"f.req": json.dumps([[["Fbv4je", inner, None, "generic"]]], separators=(",", ":"))}


def _walk(value):
    if isinstance(value, list):
        for item in value:
            yield from _walk(item)
    else:
        yield value


def parse_batch(text: str) -> str | None:
    """3단계 답 → 원문 주소(없으면 None). 머리 ``)]}'``를 떼고 JSON 조각에서 ``garturlres`` 묶음을 찾습니다(못 읽으면 글자 모양으로 한 번 더)."""
    body = (text or "").lstrip()
    if body.startswith(")]}'"):
        body = body[4:]
    for chunk in re.split(r"\n\s*\n|\n\d+\n", body):
        chunk = chunk.strip()
        if not chunk.startswith("["):
            continue
        try:
            parsed = json.loads(chunk)
        except ValueError:
            continue
        for value in _walk(parsed):
            if isinstance(value, str) and "garturlres" in value:
                try:
                    inner = json.loads(value)
                except ValueError:
                    continue
                if isinstance(inner, list) and len(inner) > 1 and isinstance(inner[1], str) and usable(inner[1]):
                    return inner[1]
    found = _GARTURL.search(body)
    if found and usable(found.group(1)):
        return found.group(1)
    return None


# ------------------------------------------------------------------ 부르기

def _today():
    return datetime.now(timezone.utc).astimezone(kst.KST).date()


def _take_budget() -> bool:
    return store.take_search_budget(HOST, PURPOSE, _today(), DAILY_BUDGET)


def _spend(sent: int) -> None:
    """
    요청 한 건 앞의 하루 예산 — 다 썼거나 읽지 못하면 보내지 않습니다. news.google.com이 공용 래치로 닫혀 있으면 예산을 쓰지 않고 먼저 멈춥니다
    (보내지 않을 요청에 예산을 쓰지 않게 — 래치 확인은 읽기만).
    """
    if http.latch_remaining(HOST) is not None:
        raise RelayUnresolved(f"{HOST}가 잠시 닫혀 있어(같은 서버의 다른 수집이 거부당함) 풀지 못했습니다 — 잠시 뒤 다시", retryable=True,
                              requests=sent)
    try:
        allowed = _take_budget()
    except Exception as exc:  # noqa: BLE001 — 예산을 셀 수 없으면 보내지 않음(닫힌 실패)
        logger.info("구글 경유 풀기: 예산을 읽지 못함(%s)", type(exc).__name__)
        raise RelayUnresolved("구글 경유 풀기 예산을 확인하지 못해 보내지 않았습니다", requests=sent, reason="budget") from None
    if not allowed:
        raise RelayUnresolved(f"오늘 구글 경유 풀기 {DAILY_BUDGET}건을 다 썼습니다 — 내일(KST) 다시", requests=sent, reason="budget")


def _read_limited(response, limit: int) -> bytes:
    chunks: list[bytes] = []
    received = 0
    for chunk in response.iter_content(chunk_size=65536):
        received += len(chunk)
        if received > limit:
            raise RelayUnresolved("구글 경유 쪽이 너무 커서 읽지 않았습니다")
        chunks.append(chunk)
    return b"".join(chunks)


def _get(url: str) -> tuple[int, bytes]:
    """경유 쪽 한 번(네트워크 — 시험이 바꿔 끼우는 자리). 리다이렉트를 따라가지 않습니다."""
    response = http.get_relay_session().get(url, timeout=TIMEOUT, allow_redirects=False, stream=True)
    try:
        if response.status_code != 200:
            return response.status_code, b""
        return 200, _read_limited(response, PAGE_MAX_BYTES)
    finally:
        response.close()


def _post(form: dict[str, str]) -> tuple[int, str]:
    """내부 경로 한 번(네트워크 — 시험이 바꿔 끼우는 자리)."""
    response = http.get_relay_session().post(BATCH_URL, data=form, timeout=TIMEOUT, allow_redirects=False, stream=True,
                                             headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"})
    try:
        if response.status_code != 200:
            return response.status_code, ""
        return 200, _read_limited(response, PAGE_MAX_BYTES).decode("utf-8", errors="replace")
    finally:
        response.close()


def _call(step, sent: int):
    """요청 한 건 — 거부(래치 포함)·전송 실패를 '풀지 못함'으로(거부는 다시 누르지 않게, 전송 실패는 잠시 뒤 다시)."""
    try:
        return step()
    except http.SourceRejected as exc:
        logger.info("구글 경유 풀기: %s 거부(%s)", HOST, exc.why)
        raise RelayUnresolved(f"{HOST}가 요청을 거부해(또는 잠시 닫아 둠) 풀지 못했습니다", retryable=exc.latched, requests=sent) from None
    except RelayUnresolved:
        raise
    except Exception as exc:  # noqa: BLE001 — 연결·시간 초과
        logger.info("구글 경유 풀기: %s 연결 실패(%s)", HOST, type(exc).__name__)
        raise RelayUnresolved(f"{HOST}에 연결하지 못해 풀지 못했습니다", retryable=True, requests=sent) from None


def resolve(url: str) -> Resolved:
    """
    경유 주소 → 원문 주소(요청 0~2건). 부르는 쪽이 시간 상한(``http.run_guarded``)을 건 작업 스레드에서 부릅니다.

    :raises RelayUnresolved: 풀지 못함(모양이 다름·동의 화면·거부·예산·전송 실패)
    """
    article_id = relay_id(url)
    if article_id is None:
        raise RelayUnresolved(UNRESOLVED)
    offline = decode_offline(article_id)
    if offline is not None:
        return Resolved(offline, 0)
    sent = 0
    _spend(sent)
    status, raw = _call(lambda: _get(PAGE_URL.format(id=article_id)), sent)
    sent += 1
    logger.info("구글 경유 풀기: %s HTTP %d", HOST, status)
    if status != 200:
        raise RelayUnresolved(UNRESOLVED if not 300 <= status < 400 else f"{UNRESOLVED}(동의 화면 등으로 옮겨짐)",
                              retryable=status >= 500, requests=sent)
    found, signed = parse_page(raw.decode("utf-8", errors="replace"))
    if found is not None:
        return Resolved(found, sent)
    if signed is None:
        raise RelayUnresolved(f"{UNRESOLVED}(경유 쪽 모양이 바뀜)", requests=sent)
    _spend(sent)
    status, text = _call(lambda: _post(batch_form(article_id, *signed)), sent)
    sent += 1
    logger.info("구글 경유 풀기: %s HTTP %d(내부 경로)", HOST, status)
    if status != 200:
        raise RelayUnresolved(UNRESOLVED, retryable=status >= 500, requests=sent)
    found = parse_batch(text)
    if found is None:
        raise RelayUnresolved(f"{UNRESOLVED}(내부 경로 모양이 바뀜)", requests=sent)
    return Resolved(found, sent)
