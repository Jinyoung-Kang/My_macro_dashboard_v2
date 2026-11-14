"""
app/services/search_finviz.py
정보 검색 단계 5 — Finviz 종목 뉴스(ADR 0041 결정 10, 계약 docs/specs/2026-11-14-info-search-contract.md §8). **화면의 요청이 차단 통과
계층(app/fetch)을 부르는 첫 길**이라 아래를 모두 지킵니다. 결과는 회원에게도 보이고, 모의 매매의 입력이 아닙니다.

- 받는 것: ``https://finviz.com/quote.ashx?t=<티커>`` 한 쪽의 뉴스 표(``id="news-table"``)에서 시각·제목·매체·링크만(최대 100줄). 'Show Previous
  News'·``news.ashx``·유료·로그인·차트·시세·스크리너·내려받기·Finviz 안쪽 글의 본문은 받지 않습니다. 검색 한 번이 보내는 요청은 1건(계층 올림
  1건 더 가능). 프록시·IP 돌려쓰기·퍼즐 풀이·로그인은 하지 않고, 거부당하면 다른 길로 다시 시도하지 않습니다. 같은 호스트 안의 다른 화면(로그인·
  유료·검색 등)으로 옮겨진 답은 뉴스 표가 있어도 쓰지 않습니다(:data:`MOVED` — 최종 주소가 ``/quote.ashx``가 아님). 계층은 표 안의 호스트로 가는
  리다이렉트를 따라가므로 그 홉의 요청까지 막지는 못합니다(계층에 '따라가지 않음' 선택이 생기면 그것을 씀).
- 서버에서만: 계층은 ``POLITE_FETCH_ENABLED``를 보지 않으므로 이 길이 직접 확인합니다(``polite.enabled()``). 꺼진 곳(로컬·QA)은 줄에 넣지
  않고 상태 ``server_only`` — 예산·계층·네트워크 0건.
- 줄 세우기: 과정 하나에 작업자 하나(``ThreadPoolExecutor(max_workers=1)``)와 finviz.com 요청 잠금 하나(:data:`_send_lock`). 즉석 검색의 작업과
  관심 대상 수집의 동기 입구(:func:`for_watch`)가 같은 잠금을 거쳐 finviz.com에 동시에 두 건이 나가지 않습니다(계층의 같은 호스트 간격은
  원자적이지 않음). 요청 사이 간격은 계층 그대로(``pacing``). 작업 하나에는 시간 상한(:data:`JOB_DEADLINE`)을 겁니다(``http.run_guarded``).
- 브라우저 컨테이너(계층 2)는 한 번에 한 건이고 polite 태스크들은 차례로 돌며 그것을 씁니다. 즉석 검색의 작업자는 그 차례 밖의 스레드라
  계층의 :func:`fetch.browser_client.send`가 과정 안의 컨테이너 호출을 한 줄로 세웁니다(겹치면 기다림 — 바쁨 429가 거부로 기록되지 않게).
- 캐시: 티커마다 성공 30분·실패 5분 — 즉석 검색과 관심 대상 수집이 같은 캐시를 씁니다(잠금을 기다리는 사이 다른 길이 남긴 결과는 성공·실패
  모두 그대로 씀). 같은 티커가 줄에 있거나 받는 중이면 새로 넣지 않고, 줄 상한은 :data:`QUEUE_LIMIT`. '지금 새로 받기'(refresh)도 이 캐시를
  건너뛰지 않습니다(같은 티커는 30분 다시 씀 — 결정 10). 호스트가 닫혀 있으면(표 fetch_hosts) 줄에 넣지 않고 예산도 쓰지 않습니다.
- 예산: 즉석 검색은 줄에 넣기 전에 ``fetch_budgets(finviz.com, search)``에서 한 건(하루 :data:`SEARCH_BUDGET`), 관심 대상 수집은 부르는 쪽이
  ``(finviz.com, watch)``에서(:data:`WATCH_BUDGET`). 둘 다 호스트 계층 예산(policy — 250) 안입니다.
- 판정: 계층 예산·시간(``FetchSkipped``)은 '예산 소진', 거부(``FetchRejected`` — 닫힘·포기)는 ``error``와 그 사유, 그리고 즉석 검색이 **새로
  거부당했으면** 끊김 알림(관심 대상 수집 태스크의 판정 ``blocked`` — 그 태스크의 다음 성공이 지움. 이미 닫혀 있어 보내지 않은 요청은 알림을
  다시 걸지 않음 — 닫힌 동안 blocked와 ok가 번갈아 쌓이지 않게). 관심 대상 수집의 거부는 그 대상의 Finviz만 건너뜁니다(호스트 닫힘은 계층이
  표 fetch_hosts에 기록). 뉴스 표가 없거나 줄을 만들지 못하면 ``error``('형식이 바뀜' — 깨진 링크 한 줄은 그 줄만 건너뜀).
- 사유 글·로그에 티커·경로·인자를 남기지 않습니다(호스트·상태만).
"""
from __future__ import annotations

import concurrent.futures as futures
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable
from urllib.parse import quote, urljoin, urlsplit
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from .. import http, store
from ..fetch import browser_client, impersonate, ladder, policy, state
from . import info_text
from . import search_rules as rules
from . import search_sources as sources

logger = logging.getLogger(__name__)

HOST = "finviz.com"
QUOTE_URL = "https://finviz.com/quote.ashx"
BASE_URL = "https://finviz.com/"
SOURCE = "finviz"
LABEL = "Finviz 종목 뉴스"
NEW_YORK = ZoneInfo("America/New_York")      # 날짜 칸의 시각은 미국 동부(단계 0 실측 — 배포 뒤 다른 출처의 같은 기사 시각과 대조)

SEARCH_BUDGET = 60              # 즉석 검색의 하루 예산(fetch_budgets — 용도 search, KST 날짜)
WATCH_BUDGET = 100              # 관심 대상 수집의 하루 예산(용도 watch — tasks/search_watch가 씀)
SUCCESS_TTL = 1800.0            # 받은 결과 30분
FAILURE_TTL = 300.0             # 실패·예산 소진 5분
QUEUE_LIMIT = 5                 # 줄(기다리는 것 + 받는 중) 상한
JOB_DEADLINE = 300.0            # 작업 하나의 시간 상한(초)
MAX_ROWS = 100
WATCH_LOCK_WAIT = 90.0          # 관심 대상 수집이 즉석 검색의 요청이 끝나기를 기다리는 상한(초)
# 관심 대상 수집의 남은 시간이 이보다 적으면 Finviz를 묻지 않음(다음 깨기) — 계층 1이 거부했을 때 한 번 올라갈 시간: 같은 호스트 지연 두 번
# (가끔 20~45초 + 1초 미만 흔들림) + 계층 1 요청(연결·읽기 상한) + 브라우저 계층이 부르기 전에 남아 있어야 하는 시간. 모자라면 계층이 올라가지
# 못한 채 아래 계층의 거부를 최종으로 닫거나(물러남) 지연을 건너뛰어 거부를 적지 못함.
_LONGEST_PAUSE = policy.POLICIES[HOST].gap.long_high + 1.0
WATCH_MIN_TIME_LEFT = 2 * _LONGEST_PAUSE + sum(impersonate.DEFAULT_TIMEOUT) + browser_client.MIN_TIME_LEFT
WATCH_TASK = "search_watch"     # 끊김 알림을 거는 태스크(관심 대상 정기 수집 — 출처 표 InfoSources의 한 줄)
BLOCKED_STALE_MINUTES = 120     # 그 태스크의 '오래 못 받음' 간격 = 간격 상한 40분 × polite.STALE_FACTOR 3(시험이 대조)

SERVER_ONLY = "Finviz는 운영 서버에서만"
PENDING = "받는 중 — 몇 초 뒤 채움"
BUDGET_SPENT = "오늘 Finviz 검색 예산 소진"
USER_LIMIT = "한 사람이 한 시간에 Finviz를 새로 부를 수 있는 횟수를 넘음 — 받아 둔 결과만"
QUEUE_FULL = "대기열이 가득 참 — 잠시 뒤 다시"
SHAPE_CHANGED = "형식이 바뀜"
MOVED = "Finviz 종목 화면이 아닌 곳으로 옮겨짐 — 쓰지 않음"
TIME_SHORT = "태스크 시간이 모자라 다음 깨기"
QUOTE_PATH = "/quote.ashx"

_MONTHS = {name: number for number, name in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), start=1)}
_STAMP = re.compile(r"^(?:(?P<today>today)|(?P<mon>[a-z]{3})-(?P<day>\d{1,2})-(?P<year>\d{2}))?\s*"
                    r"(?P<hour>\d{1,2}):(?P<minute>\d{2})\s*(?P<half>[ap]m)$", re.IGNORECASE)
_PARENS = re.compile(r"^\(\s*(.+?)\s*\)$")
_URLS = re.compile(r"https?://[^\s'\"<>)]+")
_PATH = re.compile(r"/quote\.ashx\S*")


class ShapeError(ValueError):
    """종목 화면의 모양이 기대와 다름 — 뉴스 표가 없거나 줄을 하나도 읽지 못함('형식이 바뀜')."""


# ------------------------------------------------------------------ 주소·줄 만들기(순수)

def finviz_ticker(ticker: str) -> str:
    """정보 검색의 티커 → Finviz의 표기(점은 줄표 — BRK.B → BRK-B)."""
    return ticker.strip().upper().replace(".", "-")


def quote_url(ticker: str) -> str:
    """종목 화면 한 쪽의 주소(그 밖의 Finviz 경로는 만들지 않음)."""
    return f"{QUOTE_URL}?t={quote(finviz_ticker(ticker), safe='-')}"


def _stamp(text: str, carry: date | None, today: date) -> tuple[datetime | None, date | None]:
    """
    날짜 칸 → (UTC 시각, 다음 줄이 이어받을 날짜). 'Nov-13-26 11:24PM'은 그 날, '10:40PM'은 앞 줄의 날짜(``carry``), 'Today 10:40PM'은 미국
    동부의 오늘. 읽지 못한 날짜 칸 뒤의 시각만 줄은 날짜를 지어내지 않습니다(이어받을 날짜를 지움).
    """
    cleaned = " ".join(text.split())
    match = _STAMP.match(cleaned)
    if match is None:
        return None, (carry if not cleaned else None)
    if match.group("today"):
        day: date | None = today
    elif match.group("mon"):
        month = _MONTHS.get(match.group("mon").title())
        try:
            day = date(2000 + int(match.group("year")), month, int(match.group("day"))) if month else None
        except ValueError:
            day = None
        if day is None:
            return None, None
    else:
        day = carry
    if day is None:
        return None, None
    hour, minute = int(match.group("hour")), int(match.group("minute"))
    if not 1 <= hour <= 12 or minute > 59:
        return None, day
    hour = hour % 12 + (12 if match.group("half").lower() == "pm" else 0)
    local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=NEW_YORK)
    return local.astimezone(timezone.utc), day


def _absolute(href: str | None) -> str | None:
    """링크 → 절대 주소(상대 경로면 https://finviz.com + 경로). http(s)가 아니거나 주소로 읽히지 않으면(깨진 링크) None."""
    if not href or not href.strip():
        return None
    try:
        url = urljoin(BASE_URL, href.strip())
    except ValueError:
        return None
    return url if rules.domain_of(url) else None


def _publisher(row) -> str | None:
    """줄의 매체 칸 — 괄호를 뗀 글. 없으면 None."""
    holder = row.find(class_="news-link-right")
    spans = (holder.find_all("span") if holder is not None else []) or row.find_all("span")
    for span in spans:
        text = " ".join(span.get_text(" ", strip=True).split())
        found = _PARENS.match(text)
        if found:
            return found.group(1)
    if holder is not None:
        text = " ".join(holder.get_text(" ", strip=True).split())
        found = _PARENS.match(text)
        return (found.group(1) if found else text) or None
    return None


def parse_news_table(markup: str, *, now: datetime) -> list[dict]:
    """
    종목 화면 → FeedItem 목록(표의 순서 그대로, 최대 MAX_ROWS줄). ``now``는 'Today'의 날짜(미국 동부)를 정하는 데만 씁니다.

    :raises ShapeError: 뉴스 표가 없거나, 줄이 있는데 하나도 읽지 못함
    """
    soup = BeautifulSoup(markup or "", "lxml")
    table = soup.find(id="news-table")
    if table is None:
        raise ShapeError("뉴스 표 없음")
    rows = [row for row in table.find_all("tr") if row.find_parent("table") is table]
    today = now.astimezone(NEW_YORK).date()
    carry: date | None = None
    items: list[dict] = []
    for row in rows:
        cell = row.find("td")
        if cell is None:
            continue
        moment, carry = _stamp(cell.get_text(" ", strip=True), carry, today)
        link = row.find("a", class_="tab-link-news", href=True) or row.find("a", href=True)
        url = _absolute(link.get("href")) if link is not None else None
        title = " ".join(link.get_text(" ", strip=True).split()) if link is not None else ""
        if not url or not title:
            continue
        try:
            item = sources.feed_item(title=title, url=url, publisher=_publisher(row), domain=rules.domain_of(url),
                                     published=moment, source=SOURCE, lang="en", kind="news", basis="published",
                                     item_id=info_text.item_id(url))
        except ValueError:
            continue            # 주소를 정규화하지 못한 줄 — 그 줄만 건너뜀(날짜는 이어받은 그대로)
        items.append(item)
        if len(items) >= MAX_ROWS:
            break
    if rows and not items:
        raise ShapeError("뉴스 표의 줄을 읽지 못함")
    return items


# ------------------------------------------------------------------ 받기 한 번(잠금 안에서)

@dataclass(frozen=True)
class _Outcome:
    """받기 한 번의 결과 — status ``ok``·``error``·``skipped``(계층 예산·시간), ``rejected``는 출처의 거부(닫힘·포기), ``sent``는 요청이 나갔는지."""
    status: str
    items: tuple = ()
    message: str | None = None
    rejected: bool = False
    sent: bool = True


@dataclass
class _Entry:
    expires: float
    outcome: _Outcome
    unread: bool           # 즉석 검색 작업이 막 받아 아직 아무도 읽지 않음(처음 읽을 때 '받음', 그다음은 '캐시')


def _scrub(text: str) -> str:
    """사유 글에서 주소·경로·인자를 지웁니다 — 주소는 호스트만 남김(티커가 실리지 않게)."""
    text = _URLS.sub(lambda match: http.host_of(match.group(0)) or "", text)
    return " ".join(_PATH.sub("", text).split())


def _fetch_page(url: str) -> ladder.Fetched:
    """계층으로 종목 화면 한 쪽(HTML을 기대). 정책 표의 규칙(간격·예산·올림·물러남)은 계층이 지킵니다."""
    return ladder.fetch(url, expect=policy.EXPECT_HTML)


def _on_quote_page(url: str) -> bool:
    """답의 최종 주소가 finviz.com의 종목 화면(``/quote.ashx``)인가 — 같은 호스트의 로그인·유료·검색 화면으로 옮겨진 답을 가름."""
    try:
        parts = urlsplit(url or "")
    except ValueError:
        return False
    return (parts.hostname or "").lower() == HOST and parts.path.rstrip("/").lower() == QUOTE_PATH


def _fetch_outcome(ticker: str) -> _Outcome:
    try:
        got = _fetch_page(quote_url(ticker))
    except ladder.FetchSkipped as exc:
        return _Outcome("skipped", message=_scrub(str(exc)), sent=False)
    except ladder.FetchRejected as exc:
        return _Outcome("error", message=exc.closed.message(), rejected=True, sent=exc.sent)
    except ladder.FetchFailed as exc:
        return _Outcome("error", message=_scrub(str(exc)))
    except policy.UnknownHost:
        return _Outcome("error", message=f"{HOST} 차단 통과 계층의 정책 표에 없음", sent=False)
    except Exception as exc:  # noqa: BLE001 — 계층 밖의 예외도 상태 한 줄로(경로 없이)
        return _Outcome("error", message=sources.safe_reason(exc, HOST))
    if not _on_quote_page(got.final_url):
        return _Outcome("error", message=MOVED)
    try:
        items = parse_news_table(got.text(), now=_now())
    except ShapeError:
        return _Outcome("error", message=SHAPE_CHANGED)
    except Exception as exc:  # noqa: BLE001 — 받은 화면 때문에 줄을 만들지 못함도 '형식이 바뀜'(관심 대상 수집을 멈추지 않게)
        logger.info("Finviz 종목 뉴스: 줄을 만들지 못함(%s)", type(exc).__name__)
        return _Outcome("error", message=SHAPE_CHANGED)
    return _Outcome("ok", items=tuple(items))


def _guarded_fetch(ticker: str, deadline: float) -> _Outcome:
    """시간 상한을 건 받기 한 번(``http.run_guarded``) — 잠금 안에서 부릅니다."""
    guard = http.TaskGuard(deadline=time.monotonic() + max(deadline, 0.0))
    return http.run_guarded(guard, lambda: _fetch_outcome(ticker))


# ------------------------------------------------------------------ 캐시·줄(과정 안)

_lock = threading.Lock()                 # 아래 상태를 지키는 잠금(짧게만 잡음)
_send_lock = threading.Lock()            # finviz.com 요청 잠금 — 즉석 검색 작업과 관심 대상 수집이 함께 거침
_results: dict[str, _Entry] = {}
_jobs: dict[str, str] = {}               # 티커 → queued·running
_executor: futures.ThreadPoolExecutor | None = None
_generation = 0                          # reset 앞의 작업이 끝나며 새 캐시에 적지 않게
_exhausted_day: date | None = None       # 검색 예산이 바닥난 KST 날짜(그날은 표를 다시 묻지 않음)


def _store_outcome(ticker: str, outcome: _Outcome, *, unread: bool) -> None:
    """잠금(_lock) 안에서 부릅니다."""
    life = SUCCESS_TTL if outcome.status == "ok" else FAILURE_TTL
    stamp = _clock()
    _results[ticker] = _Entry(expires=stamp + life, outcome=outcome, unread=unread)
    if len(_results) > 500:
        for stale in [key for key, entry in _results.items() if entry.expires <= stamp]:
            _results.pop(stale, None)


def _cached(ticker: str) -> _Entry | None:
    """잠금(_lock) 안에서 부릅니다."""
    entry = _results.get(ticker)
    return entry if entry is not None and entry.expires > _clock() else None


def _job(ticker: str, generation: int) -> None:
    """
    작업자 스레드 — 잠금을 얻은 뒤 시간 상한을 걸고 한 쪽을 받습니다. 그 사이 다른 길(관심 대상 수집)이 남긴 결과가 있으면 성공·실패 모두
    그대로 씁니다(다시 보내지 않고 기한도 늘리지 않음).
    """
    with _lock:
        if generation != _generation:
            return
        _jobs[ticker] = "running"
    outcome: _Outcome | None = None
    with _send_lock:
        try:
            with _lock:
                ready = _cached(ticker)
            if ready is None:
                outcome = _guarded_fetch(ticker, JOB_DEADLINE)
        except Exception as exc:  # noqa: BLE001 — 작업자 스레드가 죽지 않게
            outcome = _Outcome("error", message=sources.safe_reason(exc, HOST))
        # 결과와 줄 지우기는 잠금을 놓기 전에 — 그 틈에 같은 티커의 관심 대상 수집이 빈 캐시를 보고 다시 받지 않게.
        with _lock:
            if generation == _generation:
                _jobs.pop(ticker, None)
                if outcome is not None:
                    _store_outcome(ticker, outcome, unread=True)
    if outcome is not None:
        if outcome.rejected and outcome.sent:
            _note_blocked(outcome.message or f"{HOST} 거부")        # 이번에 새로 거부당함 — 이미 닫혀 보내지 않은 것은 다시 걸지 않음
        if outcome.status != "ok":
            logger.info("Finviz 종목 뉴스: %s — %s", outcome.status, outcome.message)


def _submit(ticker: str) -> None:
    """잠금(_lock) 안에서 부릅니다 — 작업자 하나에 넘깁니다."""
    global _executor
    if _executor is None:
        _executor = futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="search-finviz")
    _jobs[ticker] = "queued"
    _executor.submit(_job, ticker, _generation)


# ------------------------------------------------------------------ 즉석 검색

@dataclass(frozen=True)
class Answer:
    """
    즉석 검색 한 번의 Finviz 줄 — status ``ok``(막 받음)·``cached``·``error``·``skipped``·``pending``·``server_only``·``offline``.
    ``queued``는 이 요청이 새로 줄에 넣었는지(백엔드가 사용자 빈도를 셈 — 계약 §8-5).
    """
    status: str
    items: tuple = ()
    message: str | None = None
    queued: bool = False


def _from_entry(entry: _Entry, *, mark_read: bool) -> Answer:
    outcome = entry.outcome
    if outcome.status == "ok":
        status = "ok" if entry.unread and mark_read else "cached"
        if mark_read:
            entry.unread = False
        return Answer(status, items=outcome.items)
    if outcome.status == "skipped":
        return Answer("skipped", message=BUDGET_SPENT)
    return Answer("error", message=outcome.message)


def request(ticker: str, *, external: bool = True, allow_queue: bool = True) -> Answer:
    """
    즉석 검색의 Finviz 줄(바로 답함 — 받기는 작업자가). 순서: 캐시 → 외부를 끈 요청(offline) → 서버가 아님(server_only) → 줄에 있거나
    받는 중(pending) → 새로 부르기 한도(``allow_queue=False`` — skipped) → 호스트가 닫힘(error, 그 사유) →
    (캐시·줄을 한 번 더 보고) 줄이 가득 참 → 자리를 잡고 검색 예산 한 건 → 줄에 넣음(pending, queued). 자리를 먼저 잡아 예산을 세는 사이
    같은 티커가 두 번 들어가지 않고, 그 사이 작업이 끝났으면 예산을 쓰지 않고 그 결과를 씁니다.
    """
    global _exhausted_day
    ticker = finviz_ticker(ticker)
    with _lock:
        entry = _cached(ticker)
        if entry is not None:
            return _from_entry(entry, mark_read=external)
    if not external:
        return Answer("offline")
    if not _server_enabled():
        return Answer("server_only", message=SERVER_ONLY)
    with _lock:
        if ticker in _jobs:
            return Answer("pending", message=PENDING)
    if not allow_queue:
        return Answer("skipped", message=USER_LIMIT)
    shut = _closed()
    if shut is not None:
        return Answer("error", message=shut.message())      # 보내지 않음 — 예산·끊김 알림도 쓰지 않음(닫힘은 계층이 이미 기록)
    today = rules.kst_today()
    with _lock:
        entry = _cached(ticker)
        if entry is not None:
            return _from_entry(entry, mark_read=True)
        if ticker in _jobs:
            return Answer("pending", message=PENDING)
        if len(_jobs) >= QUEUE_LIMIT:
            return Answer("skipped", message=QUEUE_FULL)
        if _exhausted_day == today:
            return Answer("skipped", message=BUDGET_SPENT)
        _jobs[ticker] = "queued"            # 자리 잡기(작업자에 넘기기 전)
    try:
        allowed = _take_search_budget(today)
    except Exception as exc:  # noqa: BLE001 — 예산을 셀 수 없으면 보내지 않음
        logger.info("Finviz 종목 뉴스: 검색 예산을 읽지 못함(%s)", type(exc).__name__)
        with _lock:
            _jobs.pop(ticker, None)
        return Answer("error", message=f"Finviz 검색 예산을 확인하지 못함({type(exc).__name__}) — 보내지 않음")
    with _lock:
        if not allowed:
            _jobs.pop(ticker, None)
            _exhausted_day = today
            return Answer("skipped", message=BUDGET_SPENT)
        _submit(ticker)
    return Answer("pending", message=PENDING, queued=True)


# ------------------------------------------------------------------ 관심 대상 수집의 동기 입구(계약 §8-7)

@dataclass(frozen=True)
class WatchAnswer:
    """
    관심 대상 수집 한 대상의 Finviz — ``took``은 하루 예산을 썼는지(부르는 쪽의 ``take``가 참), ``sent``는 요청이 실제로 나갔는지.
    ``failure``는 받지 못함·형식 바뀜(판정 '받지 못함'), ``note``는 건너뜀(거부·직전 실패·잠금 대기·시간·계층 예산 — 판정과 무관).
    """
    items: tuple = ()
    took: bool = False
    sent: bool = False
    failure: str | None = None
    note: str | None = None


def for_watch(ticker: str, *, take: Callable[[], bool]) -> WatchAnswer:
    """
    관심 대상 수집(polite 태스크 — 그 작업 스레드에서 부름)의 Finviz 한 쪽. 같은 캐시(결과가 있으면 요청·예산 없음), 같은 잠금(즉석 검색의
    요청이 끝나기를 :data:`WATCH_LOCK_WAIT`까지 기다림). 남은 시간이 한 번 올라갈 만큼(:data:`WATCH_MIN_TIME_LEFT`) 없거나 호스트가 닫혀
    있으면 예산을 쓰지 않고 건너뜀. 예산은 ``take``(부르는 쪽 — fetch_budgets 용도 watch와 요청 간격)를 잠금 안에서.
    """
    ticker = finviz_ticker(ticker)
    if not _server_enabled():
        return WatchAnswer(note=SERVER_ONLY)
    with _lock:
        entry = _cached(ticker)
    if entry is not None:
        return _watch_from_entry(entry)
    left = http.time_left()
    if left is not None and left < WATCH_MIN_TIME_LEFT:
        return WatchAnswer(note=TIME_SHORT)
    wait = WATCH_LOCK_WAIT if left is None else min(WATCH_LOCK_WAIT, max(left - WATCH_MIN_TIME_LEFT, 0.0))
    lock = _send_lock
    if not lock.acquire(timeout=wait):
        return WatchAnswer(note="다른 Finviz 요청이 끝나지 않아 다음 깨기")
    marked = False
    try:
        with _lock:
            entry = _cached(ticker)
            if entry is None and ticker not in _jobs:
                # 받는 동안 즉석 검색이 같은 티커를 줄에 넣지 않게(예산·사용자 셈 없이 '받는 중') — 끝나면 지움.
                _jobs[ticker] = "running"
                marked = True
        if entry is not None:
            return _watch_from_entry(entry)
        left = http.time_left()
        if left is not None and left < WATCH_MIN_TIME_LEFT:
            return WatchAnswer(note=TIME_SHORT)
        shut = _closed()
        if shut is not None:
            return WatchAnswer(note=shut.message())
        if not take():
            return WatchAnswer()
        outcome = _guarded_fetch(ticker, JOB_DEADLINE if left is None else min(JOB_DEADLINE, left))
        if outcome.status != "skipped":
            with _lock:
                _store_outcome(ticker, outcome, unread=False)
    finally:
        if marked:
            with _lock:
                if _jobs.get(ticker) == "running":
                    _jobs.pop(ticker, None)
        lock.release()
    if outcome.status == "ok":
        return WatchAnswer(items=outcome.items, took=True, sent=True)
    if outcome.rejected or outcome.status == "skipped":
        return WatchAnswer(took=True, sent=outcome.sent, note=outcome.message)
    return WatchAnswer(took=True, sent=outcome.sent, failure=outcome.message)


def _watch_from_entry(entry: _Entry) -> WatchAnswer:
    outcome = entry.outcome
    if outcome.status == "ok":
        return WatchAnswer(items=outcome.items)
    return WatchAnswer(note=f"직전 결과가 실패라 {int(FAILURE_TTL // 60)}분 안에 다시 묻지 않음({outcome.message})")


# ------------------------------------------------------------------ 바꿔 끼우는 자리·시험용

def _server_enabled() -> bool:
    """POLITE_FETCH_ENABLED — 운영 서버에서만 켜짐. 서비스가 태스크 패키지를 가져올 때의 순환을 피해 부를 때 가져옵니다."""
    from ..tasks import polite

    return polite.enabled()


def _take_search_budget(today: date) -> bool:
    return store.take_search_budget(HOST, "search", today, SEARCH_BUDGET)


def _closed() -> state.Closed | None:
    """finviz.com이 닫혀 있으면 그 사정(표 fetch_hosts — 네트워크 없음). 표를 읽지 못하면 None(계층이 보내기 전에 다시 봄)."""
    try:
        return state.closed(HOST)
    except Exception as exc:  # noqa: BLE001
        logger.info("Finviz 종목 뉴스: 호스트 상태를 읽지 못함(%s)", type(exc).__name__)
        return None


def _note_blocked(reason: str) -> None:
    """거부를 끊김 알림에 겁니다(관심 대상 수집 태스크의 판정 blocked). 표에 쓰지 못해도 결과는 그대로(알림이 늦을 뿐)."""
    try:
        store.note_source_state(WATCH_TASK, "blocked", reason, stale_after_minutes=BLOCKED_STALE_MINUTES)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Finviz 거부를 끊김 알림에 남기지 못함(%s)", type(exc).__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clock() -> float:
    return time.monotonic()


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
    """시험용 — 캐시·줄을 비우고 작업자·잠금을 새로 둡니다(앞 시험의 작업이 끝나며 새 캐시에 적지 않게)."""
    global _executor, _send_lock, _generation, _exhausted_day
    with _lock:
        _generation += 1
        _results.clear()
        _jobs.clear()
        _exhausted_day = None
        old, _executor = _executor, None
        _send_lock = threading.Lock()
    if old is not None:
        old.shutdown(wait=False, cancel_futures=True)
