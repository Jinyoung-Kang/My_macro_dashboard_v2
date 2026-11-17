"""
app/services/search_article.py
정보 검색 본문 보기(ADR 0043, 계약 docs/specs/2026-11-14-info-search-contract.md §10) — 운영자가 결과 줄의 '본문 보기'를 누르면 운영 서버가 그 글
한 건을 받아 본문만 추려 보입니다. **저장하지 않습니다**(DB·로그·알림·AI 요약·모의 매매 패킷 없음 — 이 과정의 메모리에 24시간).

- 꼬리표(:func:`annotate`): 결과(``search.feed``)의 줄 가운데 종류가 ``news``·``headline``이고 받아 둔 글(``readerId``)이 아니며 주소가 http(s)인 줄에
  ``bodyRef``(주소의 sha-256 앞 32자)를 답니다. 받지 않는 매체(:data:`REFUSED` — 네이버·Yahoo·인베스팅닷컴·Finviz·정기 수집 출처·검색 엔진·계좌·
  공시 출처·유료 구독 매체·제외 매체)는 ``bodyRef`` 대신 그 까닭(``bodyNote``). 구글 경유 주소는 최종 호스트를 모르므로 늘 꼬리표(누를 때 풀린
  호스트에 같은 규칙을 다시). 줄마다 새 사전을 만들어 출처 캐시의 줄을 고치지 않습니다.
- 기억표: 꼬리표 → 그 줄의 주소·제목·매체(메모리, 24시간·1만 건). **화면은 주소를 보내지 않고 꼬리표만** 보냅니다 — 수집기는 자기가 결과로 내준 주소만
  받습니다(SSRF). 수집기를 다시 켜면 비어 '결과를 다시 불러 주세요'입니다.
- 받기(:func:`request`): 순서는 서버 스위치(POLITE_FETCH_ENABLED — 로컬·QA는 꺼짐, 그러면 기억표·DB·네트워크 0건) → 프록시 환경 → 캐시 → 받는 중 →
  (start가 거짓이면 not_cached) → 기억표 → 받지 않는 매체 → 호스트 닫힘 → 줄 상한(:data:`QUEUE_LIMIT`) → 하루 전체 예산(fetch_budgets ``*``/article,
  :data:`DAILY_BUDGET`) → 작업자 하나(한 번에 한 건, 작업 상한 :data:`JOB_DEADLINE`초)에 넘기고 ``pending``·``queued``.
- 작업자: 구글 경유면 원문 주소로 풀기(services/search_relay — 요청 0~2건) → 한 건 받기(app/fetch/article — 홉마다 주소 검사·고정 주소·리다이렉트 3번·
  3MB·HTML만) → 본문 추출(:func:`extract` — trafilatura 2.3.1, 처음 쓸 때 가져옴, 여는 태그 :data:`MAX_TAGS`개 넘으면 하지 않음) → 메모리 캐시(성공 24시간, 실패는 사유별 — :func:`_ttl`).
- 사유 글·로그에는 호스트·상태·사유 코드만(경로·인자·제목·본문·꼬리표 없음).
"""
from __future__ import annotations

import collections
import concurrent.futures as futures
import hashlib
import logging
import math
import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone

from .. import http, store
from ..fetch import article as fetch_article
from ..fetch import policy
from . import search_relay
from . import search_rules as rules
from . import search_store

logger = logging.getLogger(__name__)

REF_PATTERN = re.compile(r"^[0-9a-f]{32}$")
KINDS = ("news", "headline")              # 꼬리표를 다는 줄의 종류(기사·글) — 공시·리서치·거장 견해·속보는 없음
REF_TTL = 86_400.0                        # 기억표 — 결과로 내준 뒤 24시간
REF_LIMIT = 10_000
RESULT_LIMIT = 150                        # 본문 캐시 줄 수(오래 안 쓴 것부터 뺌)
QUEUE_LIMIT = 5                           # 줄(기다림 + 받는 중) 상한
JOB_DEADLINE = 60.0                       # 작업 하나의 시간 상한(초)
DAILY_BUDGET = 80                         # 하루(KST) 전체 받기(작업 수) — fetch_budgets('*', article)
TOTAL_HOST = "*"
MAX_CHARS = 40_000                        # 본문 상한(글자) — 백엔드 번역 상한(InfoTranslator.BODY_MAX_CHARS)과 같은 값
SHORT_CHARS = 400                         # 이보다 짧으면 성공이되 short
MIN_CHARS = 80                            # 이보다 짧으면 no_body
AUTHOR_MAX = 200
TITLE_MAX = 500
# 추출 앞 관문 — 여는 태그 어림수('<' 수 − '</' 수 — 주석·스크립트 안의 '<'도 셈, 넉넉히 많게 셈)가 이보다 많으면 추출하지 않습니다. 추출(trafilatura —
# lxml 트리와 그 복사본)은 시간 상한(JOB_DEADLINE — 네트워크에만 걸림) 밖에서 이 과정의 메모리를 씁니다. 이 PC 실측(Python 3.11, trafilatura 2.3.1,
# lxml 6.1.3): 여는 태그 6만 개(<div><span><a> 반복 0.8MB) 2.3초·최대 +73MB, 4만 개(표 칸 반복) 0.9초·+55MB, 12만 개 4.4초·+145MB — 3MB 전부가
# 태그면 수 초·수백 MB라 수집기(mem_limit 1g — 실제 매매 주문 길·모의 매매 입력 수집과 같은 과정)를 지키려고 둡니다. 보통 기사 쪽은 수천 개입니다.
MAX_TAGS = 50_000

SUCCESS_TTL = 86_400.0                    # 성공 24시간(사용자 결정)
SHAPE_TTL = 1_800.0                       # no_body·not_html·too_large·http_error(4xx) 30분
BLOCKED_TTL = 6 * 3_600.0                 # 거부 6시간(호스트 닫힘과 같이)
RULE_TTL = 3_600.0                        # refused_host·unsafe_address·bad_redirect·relay_unresolved(모양) 1시간
TRANSIENT_TTL = 60.0                      # timeout·transport·5xx·relay_unresolved(전송) 60초
# 작업자가 낸 결과 가운데 캐시하지 않는 사유(호스트 하루 예산·프록시 환경)도 다시 묻는 화면에 한 번 전하려고 이만큼은 둡니다 — 두지 않으면 다음 다시
# 묻기가 같은 글을 새로 줄에 넣어 하루 예산을 또 씁니다.
DELIVERY_TTL = 120.0

SERVER_ONLY = "본문 보기는 운영 서버에서만 됩니다 — 이 PC·QA에서는 원문 열기로 보세요"
PROXY_ONLY = "프록시가 설정된 곳에서는 본문을 받지 않습니다 — 원문 열기로 보세요"
NOT_CACHED = "받아 둔 본문이 없습니다"
UNKNOWN_REF = "이 결과를 찾지 못했습니다 — 결과를 다시 불러 주세요(수집기가 다시 켜졌거나 24시간이 지남)"
QUEUE_FULL = "다른 글을 받는 중이라 대기열이 가득 찼습니다 — 잠시 뒤 다시"
BUDGET_SPENT = f"오늘 본문 받기 {DAILY_BUDGET}건을 다 썼습니다 — 내일(KST) 다시"
BUDGET_UNKNOWN = "예산을 확인하지 못해 보내지 않았습니다"
PENDING = "운영 서버가 글을 받는 중입니다"
NO_BODY = "본문을 찾지 못했습니다 — 유료·로그인 글이거나 스크립트로 그리는 화면일 수 있습니다"

# 받지 않는 매체(점 경계로 맞춤 — 그 도메인이거나 그 하위 호스트). 같은 서버 IP로 도는 정기 수집을 지키고 앞선 결정을 깨지 않으려는 '처음 값'입니다
# (서버에서 실제로 막히는 매체를 보며 고치고 ADR 0043에 덧붙임). 시작 주소(꼬리표 때 — bodyNote)와 풀린 구글 주소·리다이렉트 홉(받기 때 — refused_host)에 적용.
PAYWALLED = ("bloomberg.com", "wsj.com", "ft.com", "economist.com", "barrons.com", "nikkei.com", "seekingalpha.com", "nytimes.com",
             "washingtonpost.com")
REFUSED: tuple[tuple[tuple[str, ...], str], ...] = (
    (("naver.com",), "네이버 글은 받지 않습니다 — 정보 검색이 네이버를 부르는 길을 늘리지 않기로 함(ADR 0041 결정 5)"),
    (("yahoo.com",), "Yahoo 글은 받지 않습니다 — 같은 서버 IP로 받는 시세가 막히지 않게"),
    (("investing.com",), "인베스팅닷컴 글은 받지 않습니다 — 같은 IP의 사건 뉴스 RSS를 지키려고(ADR 0026 결정 11)"),
    (("finviz.com",), "Finviz 안쪽 글의 본문은 받지 않습니다(ADR 0041 결정 10)"),
    (("google.com", "bing.com"), "검색 엔진 경유 주소라 원문 주소를 찾지 못했습니다"),
    # 증권사 호스트 글자는 토스 클라이언트 한 곳만 압니다(tests/test_toss_account — 실제 계좌 길의 격리 시험). 그래서 그 호스트는 여기 적지 않습니다 —
    # 이 길은 공용 래치·자격 증명을 쓰지 않는 따로 선 길이라, 그 매체의 공개 글이 결과에 오면 다른 매체처럼 받습니다(ADR 0043 결과 9).
    (("toss.im", "sec.gov", "krx.co.kr", "fss.or.kr"), "계좌·공시 출처라 이 길로 받지 않습니다"),
    (PAYWALLED, "유료 구독 매체입니다 — 원문 열기로 보세요(로그인·유료 장벽을 넘지 않음)"),
)
POLICY_NOTE = "정기 수집 출처라 따로 받지 않습니다"
EXCLUDED_NOTE = "제외 매체입니다(정보 검색 규칙 3)"


# ------------------------------------------------------------------ 받지 않는 매체(순수)

def _matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def refusal(host: str | None, *, excludes: rules.Excludes | None = None) -> str | None:
    """그 호스트의 글을 받지 않는 까닭(화면 글), 받아도 되면 None. 구글 경유 시작 주소(news.google.com/rss/articles)는 부르는 쪽이 따로 다룹니다."""
    host = (host or "").lower().rstrip(".")
    if not host:
        return None
    for domains, why in REFUSED:
        if any(_matches(host, domain) for domain in domains):
            return why
    if any(_matches(host, known) for known in policy.POLICIES):
        return POLICY_NOTE
    if rules.is_excluded_media(host, None, excludes):
        return EXCLUDED_NOTE
    return None


def ref_of(url: str) -> str:
    """주소의 정확한 글자 → 꼬리표(sha-256 앞 32자 — 같은 주소는 같은 꼬리표라 캐시가 이어짐)."""
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]


def check_ref(ref: str | None) -> str:
    """꼬리표 모양(32자 소문자 16진) — 아니면 ValueError(경로가 400)."""
    if not isinstance(ref, str) or not REF_PATTERN.match(ref):
        raise ValueError("ref는 32자 소문자 16진입니다.")
    return ref


# ------------------------------------------------------------------ 기억표(메모리)

@dataclass(frozen=True)
class _Origin:
    """꼬리표가 가리키는 줄 — 받을 주소와 화면에 보일 이름들."""
    url: str
    title: str | None
    publisher: str | None
    domain: str | None
    source: str | None
    lang: str | None


_lock = threading.Lock()
_refs: collections.OrderedDict[str, tuple[float, _Origin]] = collections.OrderedDict()


def _remember(ref: str, item: dict) -> None:
    """잠금(_lock) 안에서 부릅니다. 다시 내주면 시각을 새로 고치고 뒤로 옮깁니다."""
    _refs[ref] = (_clock() + REF_TTL, _Origin(url=item["url"], title=item.get("title"), publisher=item.get("publisher"),
                                              domain=item.get("publisherDomain"), source=item.get("source"), lang=item.get("lang")))
    _refs.move_to_end(ref)
    while len(_refs) > REF_LIMIT:
        _refs.popitem(last=False)


def _lookup(ref: str) -> _Origin | None:
    with _lock:
        hit = _refs.get(ref)
        if hit is None:
            return None
        if hit[0] <= _clock():
            _refs.pop(ref, None)
            return None
        return hit[1]


def annotate(items: list[dict]) -> list[dict]:
    """결과 줄마다 ``bodyRef``·``bodyNote``를 단 새 사전 목록(출처 캐시의 줄은 그대로). 꼬리표를 단 줄은 기억표에 둡니다."""
    out: list[dict] = []
    remembered: list[tuple[str, dict]] = []
    for item in items:
        row = dict(item)
        row["bodyRef"] = None
        row["bodyNote"] = None
        url = item.get("url")
        if item.get("kind") in KINDS and not item.get("readerId") and isinstance(url, str) and rules.domain_of(url):
            if rules.is_relay(url):
                row["bodyRef"] = ref_of(url)
            else:
                why = refusal(http.host_of(url))
                if why:
                    row["bodyNote"] = why
                else:
                    row["bodyRef"] = ref_of(url)
            if row["bodyRef"]:
                remembered.append((row["bodyRef"], item))
        out.append(row)
    if remembered:
        with _lock:
            for ref, item in remembered:
                _remember(ref, item)
    return out


# ------------------------------------------------------------------ 본문 추출(순수 — trafilatura는 처음 쓸 때 가져옴)

@dataclass
class Extracted:
    title: str | None
    site_name: str | None
    author: str | None
    published_date: str | None
    lang: str | None
    paragraphs: list[str]
    chars: int
    total_chars: int
    truncated: bool
    short: bool
    paywalled: bool


class NoBody(Exception):
    """본문을 추리지 못함(80자 미만·추출 실패 — 사유 no_body, 태그가 너무 많아 추출하지 않음 — 사유 too_large)."""

    def __init__(self, message: str, *, reason: str = "no_body") -> None:
        super().__init__(message)
        self.reason = reason


_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)""", re.IGNORECASE)
_HTML_LANG = re.compile(r"""<html[^>]*\blang\s*=\s*["']?([A-Za-z]{2,3})""", re.IGNORECASE)
_PAYWALL = re.compile(r"""["']isAccessibleForFree["']\s*:\s*(?:false|["']false["'])""", re.IGNORECASE)
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_HANGUL = re.compile(r"[가-힣ᄀ-ᇿ㄰-㆏]")
_KANA = re.compile(r"[ぁ-ゟ゠-ヿ]")
_LATIN = re.compile(r"[A-Za-zÀ-ÖØ-öø-ɏ]")
_config = None
_config_lock = threading.Lock()


def _charset_of(content_type: str | None) -> str | None:
    found = re.search(r"charset\s*=\s*[\"']?([A-Za-z0-9_\-:.]+)", content_type or "", re.IGNORECASE)
    return found.group(1) if found else None


def decode(body: bytes, content_type: str | None = None) -> str:
    """HTML 바이트 → 글. 응답의 charset → 문서 앞 4KB의 meta charset → UTF-8 → 추정(charset_normalizer) → UTF-8 대체."""
    for name in (_charset_of(content_type), (_CHARSET.search(body[:4096]) or [None, None])[1]):
        if not name:
            continue
        label = name.decode("ascii", "ignore") if isinstance(name, bytes) else name
        try:
            return body.decode(label)
        except (LookupError, UnicodeDecodeError):
            continue
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(body[:200_000]).best()
        if best is not None and best.encoding:
            return body.decode(best.encoding, errors="replace")
    except Exception:  # noqa: BLE001 — 추정이 실패하면 아래 대체
        pass
    return body.decode("utf-8", errors="replace")


def _clean(text: str) -> str:
    kept = "".join(ch for ch in text if ch in "\t\n" or unicodedata.category(ch)[0] != "C")
    return " ".join(kept.split())


def language_of(text: str, html_lang: str | None) -> str | None:
    """글자 비율로 언어 — 한글 30% 이상이면 ko, 가나가 있으면 ja, 라틴 글자가 절반 이상이면 en(영어가 아닐 수도 — 화면은 '한국어가 아닌 글'로만 씀),
    그 밖은 ``<html lang>``의 첫 부분, 그것도 없으면 None."""
    letters = sum(1 for ch in text if unicodedata.category(ch).startswith("L"))
    if letters:
        if len(_HANGUL.findall(text)) / letters >= 0.3:
            return "ko"
        if _KANA.search(text):
            return "ja"
        if len(_LATIN.findall(text)) / letters >= 0.5:
            return "en"
    return html_lang.lower() if html_lang else None


def start_tags(markup: str) -> int:
    """여는 태그 어림수 — '<' 수에서 닫는 태그 '</' 수를 뺌(C 속도의 셈 두 번 — 정규식이나 목록을 만들지 않음)."""
    return markup.count("<") - markup.count("</")


def _trafilatura_config():
    global _config
    with _config_lock:
        if _config is None:
            from trafilatura.settings import use_config

            for name in ("trafilatura", "htmldate", "courlan", "justext"):
                logging.getLogger(name).setLevel(logging.ERROR)     # 경고 글에 주소·제목이 섞이지 않게
            config = use_config()
            config.set("DEFAULT", "EXTRACTION_TIMEOUT", "0")
            config.set("DEFAULT", "EXTENSIVE_DATE_SEARCH", "off")
            config.set("DEFAULT", "MAX_FILE_SIZE", str(fetch_article.MAX_BYTES))
            config.set("DEFAULT", "MAX_TREE_SIZE", "50000")
            _config = config
        return _config


def _cut(paragraphs: list[str]) -> tuple[list[str], int, int]:
    """문단을 빈 줄로 이은 길이가 :data:`MAX_CHARS` 이하가 되게 문단 경계에서 자름(첫 문단 하나가 넘으면 그 안에서). → (남은 문단, 남은 글자, 전체 글자)."""
    total = len("\n\n".join(paragraphs))
    if total <= MAX_CHARS:
        return paragraphs, total, total
    kept: list[str] = []
    used = 0
    for paragraph in paragraphs:
        extra = len(paragraph) + (2 if kept else 0)
        if used + extra <= MAX_CHARS:
            kept.append(paragraph)
            used += extra
            continue
        if not kept:
            piece = paragraph[:MAX_CHARS]
            space = piece.rfind(" ")
            piece = piece[:space] if space > MAX_CHARS // 2 else piece
            kept.append(piece)
            used = len(piece)
        break
    return kept, used, total


def extract(body: bytes, *, content_type: str | None = None, fallback_title: str | None = None,
            fallback_site: str | None = None) -> Extracted:
    """
    HTML → 본문 문단과 메타데이터. 메뉴·추천 글보다 덜 가져오는 쪽(favor_precision), 표는 넣음(실적·지표 표 — 칸은 ' | '로 이어짐), 댓글·그림·링크는 뺌.

    :raises NoBody: 추린 글이 :data:`MIN_CHARS`자 미만이거나 추출이 실패함(no_body), 여는 태그가 :data:`MAX_TAGS`개를 넘어 추출하지 않음(too_large)
    """
    markup = decode(body, content_type)
    if start_tags(markup) > MAX_TAGS:
        logger.info("본문 추출 건너뜀(여는 태그 %d개 넘음)", MAX_TAGS)
        raise NoBody(f"페이지 구조가 너무 커서(태그 {MAX_TAGS:,}개 넘음) 본문을 추리지 않았습니다 — 원문 열기로 보세요", reason="too_large")
    try:
        from trafilatura import bare_extraction

        document = bare_extraction(markup, url=None, favor_precision=True, include_comments=False, include_tables=True,
                                   include_images=False, include_links=False, include_formatting=False, deduplicate=False,
                                   with_metadata=True, config=_trafilatura_config())
    except Exception as exc:  # noqa: BLE001 — 추출 예외는 '본문 없음'으로(작업자가 죽지 않게)
        logger.info("본문 추출 실패(%s)", type(exc).__name__)
        raise NoBody(NO_BODY) from None
    if document is None or not getattr(document, "text", None):
        raise NoBody(NO_BODY)
    title = _clean(getattr(document, "title", None) or "") or (fallback_title or None)
    lines = [_clean(line) for line in str(document.text).splitlines()]
    paragraphs = [line for line in lines if line]
    while paragraphs and title and paragraphs[0].casefold() == title.casefold():
        paragraphs.pop(0)                    # 머리의 제목 줄은 대화상자 제목과 겹침
    kept, chars, total = _cut(paragraphs)
    if chars < MIN_CHARS:
        raise NoBody(NO_BODY)
    html_lang = _HTML_LANG.search(markup[:4096])
    date_text = str(getattr(document, "date", None) or "")
    author = _clean(getattr(document, "author", None) or "")
    site = _clean(getattr(document, "sitename", None) or "")
    return Extracted(
        title=title[:TITLE_MAX] if title else None,
        site_name=site or (fallback_site or None),
        author=author[:AUTHOR_MAX] or None,
        published_date=date_text if _DATE.match(date_text) else None,
        lang=language_of(" ".join(kept), html_lang.group(1) if html_lang else None),
        paragraphs=kept,
        chars=chars,
        total_chars=total,
        truncated=total > chars,
        short=chars < SHORT_CHARS,
        paywalled=bool(_PAYWALL.search(markup)),
    )


# ------------------------------------------------------------------ 캐시·줄·작업자(과정 안)

@dataclass
class _Entry:
    expires: float
    status: str                      # ok · error
    reason: str | None = None
    message: str | None = None
    retryable: bool = False
    article: dict | None = None
    unread: bool = True              # 작업자가 막 받아 아직 아무도 읽지 않음(처음 읽을 때 cached=false)
    transient: bool = False          # 짧게 캐시한 일시 실패 — 남은 초를 retryAfterSeconds로


@dataclass
class _Job:
    """줄의 한 칸 — reserved(예산을 세는 동안 자리만)·queued·running, 받을 줄."""
    state: str = "queued"
    origin: _Origin | None = None


_results: collections.OrderedDict[str, _Entry] = collections.OrderedDict()
_jobs: dict[str, _Job] = {}
_executor: futures.ThreadPoolExecutor | None = None
_generation = 0


def _clock() -> float:
    return time.monotonic()


def _now_iso() -> str:
    return rules.utc_iso(datetime.now(timezone.utc))


def _ttl(reason: str | None, retryable: bool) -> float:
    """실패 사유 → 캐시 시간(0이면 캐시하지 않음)."""
    if reason in ("budget", "queue_full", "server_only", "unknown_ref", "not_cached"):
        return 0.0
    if reason in ("timeout", "transport") or (retryable and reason in ("http_error", "relay_unresolved", "blocked")):
        return TRANSIENT_TTL
    if reason == "blocked":
        return BLOCKED_TTL
    if reason in ("refused_host", "unsafe_address", "bad_redirect", "relay_unresolved"):
        return RULE_TTL
    return SHAPE_TTL


def _store_result(ref: str, entry: _Entry) -> None:
    """잠금(_lock) 안에서 부릅니다."""
    _results[ref] = entry
    _results.move_to_end(ref)
    while len(_results) > RESULT_LIMIT:
        _results.popitem(last=False)


def _cached(ref: str) -> _Entry | None:
    """잠금(_lock) 안에서 부릅니다."""
    entry = _results.get(ref)
    if entry is None:
        return None
    if entry.expires <= _clock():
        _results.pop(ref, None)
        return None
    _results.move_to_end(ref)
    return entry


def _answer(ref: str, status: str, *, reason: str | None = None, message: str | None = None, retryable: bool = False,
            retry_after: int | None = None, queued: bool = False, article: dict | None = None) -> dict:
    return {
        "ref": ref,
        "status": status,
        "reason": reason,
        "message": message,
        "retryable": retryable,
        "retryAfterSeconds": retry_after,
        "queued": queued,
        "article": article,
        "fetchedAt": _now_iso(),
    }


def _from_entry(ref: str, entry: _Entry) -> dict:
    """잠금(_lock) 안에서 부릅니다 — 처음 읽는 성공은 cached=false, 그다음부터 true."""
    if entry.status == "ok":
        article = dict(entry.article or {}, cached=not entry.unread)
        entry.unread = False
        return _answer(ref, "ok", article=article)
    retry_after = max(1, math.ceil(entry.expires - _clock())) if entry.transient else None
    return _answer(ref, "error", reason=entry.reason, message=entry.message, retryable=entry.retryable, retry_after=retry_after)


def _fail(reason: str, message: str, *, retryable: bool = False) -> _Entry:
    """작업자가 낸 실패 — 사유별 캐시 시간(:func:`_ttl`), 캐시하지 않는 사유는 :data:`DELIVERY_TTL`만(다시 묻는 화면에 전하려고)."""
    life = _ttl(reason, retryable)
    return _Entry(expires=_clock() + (life or DELIVERY_TTL), status="error", reason=reason, message=message, retryable=retryable,
                  transient=life == TRANSIENT_TTL)


def _excludes() -> rules.Excludes | None:
    """사용자가 더한 제외 매체(60초 캐시) — 읽지 못하면 처음 값만(코드 규칙은 그대로 걸림)."""
    try:
        return search_store.user_excludes()
    except Exception:  # noqa: BLE001
        return None


def _work(origin: _Origin, deadline: float) -> _Entry:
    """작업자가 하는 일 — 경유 풀기 → 한 건 받기 → 추출. 결과는 캐시에 넣을 줄."""
    url = origin.url
    via_google = False
    excludes = _excludes()
    if rules.is_relay(url):
        try:
            resolved = search_relay.resolve(url)
        except search_relay.RelayUnresolved as exc:
            # 구글 풀기 예산(다 씀·읽지 못함)은 사유 budget — 캐시하지 않는 사유라 전하는 몫(DELIVERY_TTL)만 둡니다(계약 §10-3).
            return _fail(exc.reason, exc.message, retryable=exc.retryable)
        url, via_google = resolved.url, True
    try:
        page = fetch_article.fetch_page(url, deadline=deadline, refused=lambda host: refusal(host, excludes=excludes))
    except fetch_article.ArticleFetchError as exc:
        return _fail(exc.reason, exc.message, retryable=exc.retryable)
    try:
        found = extract(page.body, content_type=page.content_type, fallback_title=origin.title, fallback_site=origin.publisher)
    except NoBody as exc:
        return _fail(exc.reason, str(exc))
    stamp = _now_iso()
    article = {
        "title": found.title,
        "siteName": found.site_name,
        "author": found.author,
        "publishedDate": found.published_date,
        "lang": found.lang,
        "paragraphs": found.paragraphs,
        "chars": found.chars,
        "totalChars": found.total_chars,
        "truncated": found.truncated,
        "short": found.short,
        "paywalled": found.paywalled,
        "sourceUrl": page.final_url,
        "sourceHost": page.host,
        "viaGoogle": via_google,
        "fetchedAt": stamp,
    }
    return _Entry(expires=_clock() + SUCCESS_TTL, status="ok", article=article)


def _job(ref: str, generation: int) -> None:
    """작업자 스레드 — 시간 상한을 건 한 건(``http.run_guarded`` — 경유 풀기의 공용 세션 timeout도 이 상한을 봄)."""
    with _lock:
        job = _jobs.get(ref)
        if generation != _generation or job is None or job.origin is None:
            return
        job.state = "running"
        origin = job.origin
    deadline = _clock() + JOB_DEADLINE
    try:
        entry = http.run_guarded(http.TaskGuard(deadline=deadline), lambda: _work(origin, deadline))
    except Exception as exc:  # noqa: BLE001 — 작업자 스레드가 죽지 않게(사유는 이름만)
        logger.warning("본문 받기 작업 실패(%s)", type(exc).__name__)
        entry = _fail("transport", "받는 중 오류가 났습니다", retryable=True)
    with _lock:
        if generation == _generation:
            _jobs.pop(ref, None)
            _store_result(ref, entry)
    logger.info("본문 받기: %s%s", entry.status, f" — {entry.reason}" if entry.reason else "")


def _submit(ref: str, origin: _Origin) -> None:
    """잠금(_lock) 안에서 부릅니다."""
    global _executor
    if _executor is None:
        _executor = futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="search-article")
    _jobs[ref] = _Job(state="queued", origin=origin)
    _executor.submit(_job, ref, _generation)


# ------------------------------------------------------------------ 바꿔 끼우는 자리

def _server_enabled() -> bool:
    """POLITE_FETCH_ENABLED — 운영 서버에서만 켜짐(부를 때 가져옴 — 서비스가 태스크 패키지를 가져올 때의 순환을 피함)."""
    from ..tasks import polite

    return polite.enabled()


def _take_total_budget() -> bool:
    return store.take_search_budget(TOTAL_HOST, fetch_article.PURPOSE, rules.kst_today(), DAILY_BUDGET)


# ------------------------------------------------------------------ 경로

def request(ref: str, *, start: bool) -> dict:
    """
    본문 보기 한 번(바로 답함 — 받기는 작업자가). 계약 §10-4의 모양. ``start``가 거짓이면 캐시와 받는 중만 보고 외부를 부르지 않습니다(없으면
    ``not_cached``). 응답의 ``queued``는 이 요청이 새로 줄에 넣었는지(백엔드가 사용자 한 시간 한도에 셈 — 화면에 넘기지 않음).
    """
    ref = check_ref(ref)
    if not _server_enabled():
        return _answer(ref, "error", reason="server_only", message=SERVER_ONLY)
    if fetch_article.proxy_configured():
        return _answer(ref, "error", reason="server_only", message=PROXY_ONLY)
    with _lock:
        entry = _cached(ref)
        if entry is not None:
            return _from_entry(ref, entry)
        if ref in _jobs:
            return _answer(ref, "pending", message=PENDING)
    if not start:
        return _answer(ref, "error", reason="not_cached", message=NOT_CACHED)
    origin = _lookup(ref)
    if origin is None:
        return _answer(ref, "error", reason="unknown_ref", message=UNKNOWN_REF)
    if not rules.is_relay(origin.url):
        host = http.host_of(origin.url)
        why = refusal(host, excludes=_excludes())
        if why:
            return _answer(ref, "error", reason="refused_host", message=f"{host}의 글은 받지 않습니다 — {why}")
        shut = fetch_article.blocked_reason(host)
        if shut is not None:
            hours = max(1, math.ceil(shut[0] / 3600))
            return _answer(ref, "error", reason="blocked",
                           message=f"{host}가 요청을 거부해({shut[1]}) 약 {hours}시간 동안 이 매체는 다시 묻지 않습니다")
    with _lock:
        entry = _cached(ref)
        if entry is not None:
            return _from_entry(ref, entry)
        if ref in _jobs:
            return _answer(ref, "pending", message=PENDING)
        if len(_jobs) >= QUEUE_LIMIT:
            return _answer(ref, "error", reason="queue_full", message=QUEUE_FULL, retryable=True)
        _jobs[ref] = _Job(state="reserved")           # 자리 잡기(예산을 세는 사이 같은 글이 두 번 들어가지 않게)
    try:
        allowed = _take_total_budget()
    except Exception as exc:  # noqa: BLE001 — 예산을 셀 수 없으면 보내지 않음(닫힌 실패)
        logger.info("본문 받기: 하루 예산을 읽지 못함(%s)", type(exc).__name__)
        with _lock:
            _jobs.pop(ref, None)
        return _answer(ref, "error", reason="budget", message=BUDGET_UNKNOWN)
    with _lock:
        if not allowed:
            _jobs.pop(ref, None)
            return _answer(ref, "error", reason="budget", message=BUDGET_SPENT)
        _submit(ref, origin)
    return _answer(ref, "pending", message=PENDING, queued=True)


# ------------------------------------------------------------------ 시험용

def wait_idle(timeout: float = 5.0) -> bool:
    """시험용 — 줄이 빌 때까지 기다립니다(빈 채로 끝나면 True)."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        with _lock:
            if not _jobs:
                return True
        time.sleep(0.01)
    with _lock:
        return not _jobs


def reset() -> None:
    """시험용 — 기억표·캐시·줄을 비우고 작업자를 새로 둡니다(앞 시험의 작업이 끝나며 새 캐시에 적지 않게)."""
    global _executor, _generation
    with _lock:
        _generation += 1
        _refs.clear()
        _results.clear()
        _jobs.clear()
        old, _executor = _executor, None
    if old is not None:
        old.shutdown(wait=False, cancel_futures=True)
    fetch_article.reset()
