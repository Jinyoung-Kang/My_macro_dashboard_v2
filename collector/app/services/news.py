"""
app/services/news.py
사건 뉴스 RSS — 모의 매매(운영자 전용 기능) Claude 계좌 패킷 섹션 ``11b_events``의 원자료(2단계 명세 B1·B2·§10, D29·D34).

이 모듈은 "받아서 읽는다"까지만 합니다. 기준일 창(결정 시각 직전 24시간), 보유·후보 종목·키워드 거르기, 하루 상한은 백엔드가
저장본을 읽어 합니다(ADR 0008 — 계좌 보유는 백엔드 테이블이라 수집기는 모릅니다). 규칙 계좌·검증기는 읽지 않습니다(D35).

[출처 — RSS만, 제목·링크·출처·시각만(D29)]
단계 0(2026-10-25)에 고정했습니다. HTML 페이지는 받지 않고, 본문·요약(description)은 저장하지 않습니다.
  - 인베스팅닷컴 ``news_25``(주식)·``news_95``(경제 지표)·``news_14``(경제) — 피드당 최근 10항목, 시각은 시간대 없이 UTC.
    ``news.rss``(전체)는 자동 생성 내부자 거래 항목이 대부분이라 뺐습니다.
  - 연준 ``press_monetary.xml`` — ``press_all``은 제재·인가 공지가 많아 뺐습니다.
  - BLS ``cpi.rss``·``empsit.rss`` — 주소는 .rss지만 실제로는 Atom 1.0. 브라우저 UA는 403이라 BLS 세션(설명형 UA, 연락처 없음,
    403 재시도 없음)으로 받습니다.
  - SEC ``pressreleases.rss`` — 기존 SEC 세션(연락처 UA 의무)과 SEC 속도 제한을 함께 씁니다.
  - 야후 파이낸스는 뺐습니다 — 404·429이고 robots.txt가 전체를 막습니다(``Disallow: /``).

[받기와 읽기를 나눕니다]
HTTP는 수집기 세션(재시도·Retry-After 상한·UA)이 하고, feedparser(D34)는 받은 바이트를 **읽기만** 합니다. feedparser.parse에
URL 문자열을 주면 urllib로 직접 받고, bytes를 주면 먼저 **파일 이름으로 열어 봅니다**(feedparser 6.0.14 api._open_resource) —
응답 본문이 우연히(또는 일부러) 로컬 경로 모양이면 그 파일을 읽습니다. 그래서 io.BytesIO로 감싸 넘깁니다(read가 있는 객체는
그대로 읽음). 외부 엔티티(XXE)는 feedparser가 끕니다(feature_external_ges 0).
"""
from __future__ import annotations

import calendar
import hashlib
import io
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

import feedparser

from ..http import (
    SecUserAgentInvalid,
    SecUserAgentMissing,
    SourceRejected,
    brief_error,
    get_bls_session,
    get_sec_session,
    get_session,
    sec_rate_limit,
)

logger = logging.getLogger(__name__)


# ==============================================================================
# 피드 목록 (단계 0 고정)
# ==============================================================================
@dataclass(frozen=True)
class Feed:
    key: str        # 저장본 payload.feed·feeds, 백엔드 설정 news.feeds의 값
    source: str     # 패킷에 나가는 출처 이름(payload.source)
    url: str
    session: str    # "default" | "bls" | "sec"


FEEDS: tuple[Feed, ...] = (
    Feed("investing_stock", "Investing.com", "https://www.investing.com/rss/news_25.rss", "default"),
    Feed("investing_ind", "Investing.com", "https://www.investing.com/rss/news_95.rss", "default"),
    Feed("investing_economy", "Investing.com", "https://www.investing.com/rss/news_14.rss", "default"),
    # 외환(2026-10-25 추가) — 사용자가 고른 인베스팅 뉴스 네 분류(외환·주식·경제 지표·경제) 가운데 RSS로 아직 받지 않던 하나.
    # 같은 분류의 HTML 페이지(/news/forex-news 등)는 Cloudflare가 자동 요청을 모두 403으로 막아(브라우저·제품명 UA 모두) 받지 않습니다.
    Feed("investing_forex", "Investing.com", "https://www.investing.com/rss/news_1.rss", "default"),
    Feed("fed_monetary", "Federal Reserve", "https://www.federalreserve.gov/feeds/press_monetary.xml", "default"),
    Feed("bls_cpi", "BLS", "https://www.bls.gov/feed/cpi.rss", "bls"),
    Feed("bls_empsit", "BLS", "https://www.bls.gov/feed/empsit.rss", "bls"),
    Feed("sec_press", "SEC", "https://www.sec.gov/news/pressreleases.rss", "sec"),
)

FEED_KEYS: tuple[str, ...] = tuple(feed.key for feed in FEEDS)

SOURCE_NOTE = ("RSS 제목·링크·출처·시각만 — Investing.com news_25·news_95·news_14, 연준 press_monetary, BLS cpi·empsit(Atom), "
               "SEC pressreleases. 야후 파이낸스는 robots.txt가 막아 제외")

# 요청 하나의 (연결, 읽기) 대기(초). 피드는 수 KB라 넉넉합니다.
FETCH_TIMEOUT = (10, 20)

# 이보다 큰 응답은 피드가 아닌 것으로 봅니다(단계 0의 피드는 3~30KB). 잘못 연결된 페이지를 통째로 읽지 않게 — 본문을 나눠 받으며
# 이 크기를 넘는 순간 끊습니다(fetch_feed). Content-Length가 이미 넘으면 본문을 받지 않습니다.
MAX_FEED_BYTES = 5 * 1024 * 1024

# 본문을 나눠 받는 단위(바이트). 피드 하나는 보통 한두 조각입니다.
READ_CHUNK_BYTES = 64 * 1024

# 제목 길이 상한(글자). 헤드라인은 길어야 200자 안팎이라, 넘으면 요약문이 제목 칸에 들어온 것으로 보고 자릅니다.
MAX_TITLE_CHARS = 300


class FeedFetchError(RuntimeError):
    """피드 하나를 받지 못함 — 사유는 상태 화면에 뜨는 한 줄(연락처·응답 본문 없음)."""


# 출처가 403으로 거부했을 때 세션별로 덧붙이는 조치 안내. 403은 BLS·SEC 세션의 어댑터가 출처 거부(SourceRejected, 거부됨 — …)로
# 올리므로 상태 코드가 아니라 그 예외에 붙입니다(http.py). 공용 세션은 '거부됨'만으로 충분해 붙이지 않습니다.
_FORBIDDEN_HINTS = {"bls": " — BLS 차단(UA)", "sec": " — SEC_USER_AGENT 확인"}


class FeedShapeError(RuntimeError):
    """받았지만 RSS·Atom 피드가 아니거나 쓸 항목이 없음 — 그 피드만 실패로 셉니다."""


def fetch_feed(feed: Feed) -> tuple[bytes, str | None]:
    """
    피드 하나를 수집기 세션으로 받습니다. (본문, Content-Type).

    :raises FeedFetchError: 연결·HTTP·크기 오류(상한을 넘으면 그 자리에서 끊음), SEC 연락처 UA 미설정
    """
    try:
        if feed.session == "sec":
            session = get_sec_session()
            sec_rate_limit()
        elif feed.session == "bls":
            session = get_bls_session()
        else:
            session = get_session()
    except SecUserAgentMissing:
        raise FeedFetchError("SEC_USER_AGENT 미설정 — SEC는 연락처 없는 요청을 403으로 막음") from None
    except SecUserAgentInvalid:
        raise FeedFetchError("SEC_USER_AGENT 값을 쓸 수 없음(예시 값·한글·이메일 없음)") from None
    try:
        # stream=True — 본문을 한 번에 받지 않고 상한까지만 읽습니다(MAX_FEED_BYTES). 그래서 응답은 어느 길로 나가든 닫습니다.
        res = session.get(feed.url, timeout=FETCH_TIMEOUT, stream=True)
    except Exception as exc:  # noqa: BLE001 — 연결 오류는 그 피드만의 실패입니다
        hint = _FORBIDDEN_HINTS.get(feed.session, "") if isinstance(exc, SourceRejected) and exc.why == "HTTP 403" else ""
        raise FeedFetchError(f"{brief_error(exc)}{hint}") from None
    try:
        if res.status_code != 200:
            raise FeedFetchError(f"HTTP {res.status_code}")
        declared = _content_length(res.headers.get("Content-Length"))
        if declared is not None and declared > MAX_FEED_BYTES:
            raise FeedFetchError(f"응답이 너무 큼({declared // 1024}KB 예고) — 피드가 아닌 것으로 봄")
        return _read_capped(res), res.headers.get("Content-Type")
    finally:
        res.close()


def _content_length(value) -> int | None:
    """Content-Length 머리글 → 바이트 수. 없거나 읽을 수 없으면 None(그때는 읽으면서 셉니다)."""
    try:
        length = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return length if length >= 0 else None


def _read_capped(res) -> bytes:
    """
    본문을 조각으로 받아 MAX_FEED_BYTES를 넘는 순간 멈춥니다(압축은 풀린 크기로 셈 — 작게 압축된 큰 본문도 막힘).

    Content-Length는 없거나 틀릴 수 있어(청크 전송·압축) 머리글만 믿지 않고 실제로 받은 바이트를 셉니다.

    :raises FeedFetchError: 상한을 넘음, 받는 도중 끊김
    """
    chunks: list[bytes] = []
    size = 0
    try:
        for chunk in res.iter_content(chunk_size=READ_CHUNK_BYTES):
            if not chunk:
                continue
            size += len(chunk)
            if size > MAX_FEED_BYTES:
                raise FeedFetchError(f"응답이 너무 큼({MAX_FEED_BYTES // 1024}KB 넘음) — 피드가 아닌 것으로 봄")
            chunks.append(chunk)
    except FeedFetchError:
        raise
    except Exception as exc:  # noqa: BLE001 — 받는 도중의 끊김·읽기 대기 초과도 그 피드만의 실패입니다
        raise FeedFetchError(brief_error(exc)) from None
    return b"".join(chunks)


# ==============================================================================
# 읽기 (feedparser — 파싱만)
# ==============================================================================
@dataclass
class ParsedFeed:
    items: list[dict] = field(default_factory=list)  # {entity, title, link, publishedAt(datetime UTC)} — 피드 순서 그대로
    entries: int = 0          # 피드가 준 항목 수
    no_time: int = 0          # 시각이 없거나 읽을 수 없어 건너뜀
    no_title: int = 0         # 제목이 비어 건너뜀
    version: str = ""         # feedparser가 알아본 형식(rss20·atom10 등)


def parse_feed(content: bytes, content_type: str | None = None) -> ParsedFeed:
    """
    받은 바이트 → 항목(제목·링크·발행 시각). 시각이 없는 항목은 건너뛰고 셉니다(없는 시각을 지어내지 않음).

    시각은 ``published_parsed``(없으면 ``updated_parsed`` — Atom)를 calendar.timegm으로 UTC로 읽습니다. feedparser가 시간대를
    UTC로 맞춘 struct_time을 주고, 시간대가 없는 인베스팅닷컴 시각(``2026-10-25 02:48:34``)은 UTC로 읽습니다(단계 0에서 미국 지표
    발표 시각과 대조한 [해석]).

    :raises FeedShapeError: RSS·Atom이 아님(HTML 오류 페이지 등), 항목 없음, 쓸 항목 없음
    """
    headers = {"content-type": content_type} if content_type else None
    # BytesIO — 모듈 설명 '받기와 읽기를 나눕니다'(bytes를 넘기면 feedparser가 파일 이름으로 열어 봄).
    parsed = feedparser.parse(io.BytesIO(content), response_headers=headers)
    version = parsed.get("version") or ""
    entries = list(parsed.get("entries") or [])
    if not version:
        raise FeedShapeError("RSS·Atom 피드가 아님(HTML 등)")
    if not entries:
        raise FeedShapeError("항목 0개")

    out = ParsedFeed(entries=len(entries), version=version)
    for entry in entries:
        title = normalise_title(entry.get("title"))
        if not title:
            out.no_title += 1
            continue
        published = _entry_time(entry)
        if published is None:
            out.no_time += 1
            continue
        out.items.append({
            "entity": title_entity(title),
            "title": title,
            "link": _link(entry.get("link")),
            "publishedAt": published,
        })
    if not out.items:
        raise FeedShapeError(f"쓸 항목 없음(항목 {out.entries}개 — 시각 없음 {out.no_time}, 제목 없음 {out.no_title})")
    return out


def normalise_title(text) -> str:
    """
    제목 정규화 — 모든 공백(줄바꿈·탭 포함)을 하나로, 앞뒤 공백 제거, 제어 문자 제거. 대소문자는 그대로 둡니다(저장·패킷용).

    SEC 제목은 앞뒤에 공백·줄바꿈이 붙어 옵니다(단계 0). 너무 길면 MAX_TITLE_CHARS에서 자르고 '…'를 붙입니다.
    """
    if not isinstance(text, str):
        return ""
    cleaned = "".join(ch if ch.isprintable() else " " for ch in text)
    collapsed = " ".join(cleaned.split())
    if len(collapsed) > MAX_TITLE_CHARS:
        collapsed = collapsed[:MAX_TITLE_CHARS].rstrip() + "…"
    return collapsed


def title_entity(title: str) -> str:
    """
    entity = 정규화한 제목을 casefold한 것의 sha256 16진수 앞 16자.

    같은 헤드라인이 피드마다 대소문자·공백만 다르게 와도 한 건으로 셉니다. 64비트라 7일 보관(수천 건)에서 충돌은 사실상 없습니다.
    """
    key = " ".join(title.split()).casefold()
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _entry_time(entry) -> datetime | None:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    try:
        return datetime.fromtimestamp(calendar.timegm(parsed), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _link(value) -> str | None:
    """http(s) 링크만 남깁니다 — 화면이 그대로 걸 수 있는 값만(javascript: 등은 버림). 없으면 None."""
    if not isinstance(value, str):
        return None
    link = value.strip()
    return link if link.lower().startswith(("https://", "http://")) else None
