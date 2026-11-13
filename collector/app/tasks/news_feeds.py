"""
app/tasks/news_feeds.py
사건 뉴스 RSS(미국 ``news_headlines``·한국 ``kr_news_headlines``)를 피드마다 탄력 주기로, 조건부 요청으로 받는 규칙(ADR 0040 단계 1 — C1·C2).

두 태스크(tasks/news·tasks/kr_news)는 저장 규칙(중복·보관·알 수 있는 시각)만 따로 갖고, 언제·어떻게 받는지는 여기 하나를 씁니다.
속도군은 flex(tasks/flex — 1분 틱, 로컬에서도 돎)입니다.

[언제 받나 — 피드마다]
  - 표 ``CADENCES``: 활발한 시간(미국 세션 21:00~07:00 KST·한국 07:00~16:00 KST — 그 시장 거래일만, 주말·휴장일은 '그 밖')이면 활발 구간,
    아니면 그 밖 구간에서 실행마다 다음 시각을 무작위로 정해 fetch_schedule(``news_headlines/investing_stock`` 등)에 둡니다. 그 밖에서 정한
    시각이 다음 활발한 시간의 시작을 넘으면 그 시작 + 0~(활발 구간 하한)분으로 당깁니다(물러난 피드는 당기지 않음).
  - 처음(일정이 없는 피드)에는 받지 않고 ``FIRST_MINUTES`` 안에서 흩어 정합니다 — 첫 배포·새 피드 직후 한꺼번에 묻지 않게.
  - 하한: 그 피드에 마지막으로 요청한 뒤 ``floor_minutes``(인베스팅닷컴 12분, 그 밖 10분 이상)가 지나지 않았으면 어떤 경우에도 묻지 않습니다
    (때가 됐어도 미룸). 응답의 ``Cache-Control: max-age``(SEC 42~48초 등)가 남아 있어도 묻지 않습니다.
  - 거부(403·429·봇 차단 — 세션의 http.SourceRejected)나 Retry-After가 붙은 실패면 그 피드의 간격을 두 배씩(최대 2^``BACKOFF_MAX_LEVEL``배)
    늘리고, Retry-After가 더 길면 그 뒤로 미룹니다. 받으면(200·304) 되돌립니다. 그 밖의 실패(5xx·연결·형식)는 간격을 늘리지 않습니다.
  - 거부는 호스트 단위로도 지킵니다: 보낸 요청이 거부되면 같은 호스트의 다른 피드는 그 실행에서 보내지 않고, 다음 시각이 '거부 시각 +
    max(래치 5분, Retry-After)'보다 이르면 그 뒤로 미룹니다. 공용 세션의 래치(http.REJECT_LATCH_SECONDS)로 닫힌 호스트의 피드는 보내지 않고
    래치가 풀린 뒤로 미룹니다 — 나가지 않은 요청은 요청·거부로 세지 않고 간격도 늘리지 않습니다.
  - 서버 지시(max-age·Retry-After)는 ``SERVER_WAIT_CAP_SECONDS``(하루)까지만 따릅니다 — 잘못 설정된 머리글 하나로 피드가 몇 해씩 멈추지 않게.
  - 요청 바로 전에 다음 시각을 먼저 적어 둡니다 — 실행이 도중에 끊겨도 다음 틱(1분 뒤)이 같은 피드를 곧바로 다시 묻지 않게. 다음 시각과
    하한은 실행 시작이 아니라 **그 피드를 실제로 보낸 시각**에서 잽니다(같은 호스트 차례 요청은 몇 초씩 늦게 나감).

[어떻게 받나]
  - 직전에 읽은 응답의 ETag·Last-Modified를 If-None-Match·If-Modified-Since로 붙입니다. 304면 읽지 않고 '변경 없음'(직전 저장본 그대로).
  - 200이면 본문 sha256이 직전에 읽은 본문과 같을 때 읽지 않습니다('같은 본문' — 검증 값을 주지 않는 재정경제부·국가데이터처).
  - 검증 값은 **읽기에 성공한 응답의 것만** 남깁니다 — 형식이 다른 응답(HTML 오류 페이지 등)을 받으면 지웁니다. 그 응답의 ETag를 남기면
    그 뒤로 304만 받아 다시 읽지 못합니다.
  - 직전에 읽은 본문에 '미래 시각'으로 미뤄 둔 항목이 있으면(skippedFuture > 0) 검증 값을 보내지 않고 같은 본문이어도 다시 읽습니다 —
    그 항목은 시간이 지나면 넣을 수 있게 되는데, 304·같은 본문으로 건너뛰면 본문이 바뀔 때까지 들어오지 않습니다(태스크의 거르기 중
    시각에 따라 결과가 바뀌는 것은 이것뿐 — 보관 기한 밖 항목은 다시 읽어도 넣지 않음).
  - 같은 호스트의 피드는 차례로, 사이 ``HOST_SPACING_SECONDS``(무작위) + 세션의 호스트 간격(http.pace). 세션(UA)은 피드별 지금 값 그대로 —
    UA 돌리기·프록시·차단 우회는 하지 않습니다. 무작위 흔들림은 부하를 흩기 위한 것입니다.

[상태 — 저장본 ``feeds.<키>``에 합침, :func:`settle`]
  status("ok"|"실패")·error·lastOkAt(받은 마지막 시각 — 304·같은 본문도 받은 것), 마지막으로 읽은 본문의 수(entries·new·seen·skipped*·
  newestAt — 그 본문을 읽은 시각이 lastChangedAt, 304·같은 본문이면 잇습니다), 그리고 이 모듈의 칸: lastRequestAt·lastResult(changed|
  notModified|unchanged|failed)·lastChangedAt·etag·lastModified·bodyHash·freshUntil·backoff(0~BACKOFF_MAX_LEVEL)·nextDueAt·
  notModifiedTotal·today{date(KST), requests, changed, notModified, unchanged, failed, rejected}·previousDay(날짜가 바뀌기 전의 today).
  이번 실행에 받지 않은 피드의 줄은 그대로 잇습니다(:func:`merge`).
"""
from __future__ import annotations

import hashlib
import logging
import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable
from urllib.parse import urlparse

from .. import http, krcalendar, kst, logredact, uscalendar
from ..services import news as news_service
from . import flex

logger = logging.getLogger(__name__)

# 시험이 난수를 바꿔 끼우는 자리입니다.
_rng = random.Random()


@dataclass(frozen=True)
class Cadence:
    """
    피드 하나의 간격 규칙.

    :param market: 활발한 시간을 따르는 시장("us"|"kr") — None이면 늘 같은 구간
    :param active_minutes: 활발한 시간의 간격 구간(분)
    :param off_minutes: 그 밖의 간격 구간(분)
    :param floor_minutes: 하한 — 마지막 요청 뒤 이만큼은 어떤 경우에도 다시 묻지 않음
    """

    market: str | None
    active_minutes: tuple[float, float]
    off_minutes: tuple[float, float]
    floor_minutes: float


# 하한의 바닥(분) — 어떤 피드도 이보다 짧게 두지 않습니다. 인베스팅닷컴(Cloudflare 뒤 — 가장 조심)은 12분.
MIN_FLOOR_MINUTES = 10.0
INVESTING_FLOOR_MINUTES = 12.0

# 인베스팅닷컴은 RSS 파일을 약 10분마다 다시 만들어(ETag·Last-Modified가 바뀜) 조건부 요청에도 304가 거의 오지 않습니다(2026-11-14 배포 뒤
# 35분 동안 9건 중 304 0 — 진행 기록 §2). 그래서 지시문 §9대로 활발할 때 간격을 12~20분에서 30~45분으로 늘렸습니다(2026-11-14 사용자 결정).
_INVESTING = Cadence("us", (30.0, 45.0), (45.0, 90.0), INVESTING_FLOOR_MINUTES)
_YNA = Cadence("kr", (12.0, 20.0), (45.0, 90.0), MIN_FLOOR_MINUTES)
_STEADY = Cadence(None, (60.0, 120.0), (60.0, 120.0), MIN_FLOOR_MINUTES)

# 피드 키 → 간격 규칙(ADR 0040 결정 2의 표). 미국·한국 피드 표(services.news.FEEDS·KR_FEEDS)의 모든 키가 있어야 합니다(시험이 봄).
CADENCES: dict[str, Cadence] = {
    "investing_stock": _INVESTING,
    "investing_ind": _INVESTING,
    "investing_economy": _INVESTING,
    "investing_forex": _INVESTING,
    "fed_monetary": _STEADY,
    "bls_cpi": _STEADY,
    "bls_empsit": _STEADY,
    "sec_press": _STEADY,
    "bok_press": _STEADY,
    "mofe_press": _STEADY,
    "mods_press": _STEADY,
    "yna_market": _YNA,
}

# 활발한 시간(KST 시 — 시작 포함·끝 제외). 미국은 자정을 넘습니다(21:00~다음 날 07:00 = 그날 미국 세션의 동부 07·08시~17·18시).
ACTIVE_HOURS: dict[str, tuple[int, int]] = {"us": (21, 7), "kr": (7, 16)}

# 일정이 없는 피드의 첫 시각(분) — 지금 + 이 구간에서 무작위.
FIRST_MINUTES = (2.0, 25.0)
# 같은 호스트에 잇달아 보낼 때 사이 간격(초, 무작위). 세션의 호스트 간격(http.pace)이 그 위에 걸립니다.
HOST_SPACING_SECONDS = (2.0, 5.0)
# 거부가 이어질 때 간격을 두 배씩 늘리는 횟수의 상한 — 2^3 = 8배(인베스팅 활발 30~45분 → 4~6시간, 연준·BLS 60~120분 → 8~16시간).
BACKOFF_MAX_LEVEL = 3
# 하한·max-age·호스트 거부로 미룬 피드는 그 시각 + 0~이 초(무작위) 뒤로.
HOLD_JITTER_SECONDS = 60.0
# 서버 지시(max-age·Retry-After)를 따르는 상한(초) — 하루. 그보다 긴 지시는 하루로 봅니다(물러남은 그와 별개로 걸림).
SERVER_WAIT_CAP_SECONDS = 24 * 3600.0

# 저장본 cadence 칸 — 수집 방식 한 줄(화면·사람이 읽음).
CADENCE_NOTE = ("flex 탄력 주기(ADR 0040) — 피드마다 무작위 간격(인베스팅 미국 세션 30~45분·그 밖 45~90분, 연합뉴스 한국 장 12~20분·"
                "그 밖 45~90분, 공공기관 60~120분), 조건부 요청(ETag·Last-Modified → 304), 거부 시 간격 두 배(최대 8배)")

RESULT_CHANGED = "changed"            # 200 — 새 본문을 읽음
RESULT_NOT_MODIFIED = "notModified"   # 304
RESULT_UNCHANGED = "unchanged"        # 200 — 본문 해시가 직전과 같아 읽지 않음
RESULT_FAILED = "failed"
RECEIVED = frozenset({RESULT_CHANGED, RESULT_NOT_MODIFIED, RESULT_UNCHANGED})

_TODAY_COUNTS = ("requests", "changed", "notModified", "unchanged", "failed", "rejected")


# ==============================================================================
# 활발한 시간
# ==============================================================================
def _trading(market: str, day: date) -> bool:
    return uscalendar.is_trading_day(day) if market == "us" else krcalendar.is_trading_day(day)


def _session_day(market: str, now: datetime) -> date | None:
    """지금이 그 시장 활발한 시간 안이면 그 세션 날짜(KST 날짜 — 미국은 그 세션의 동부 날짜와 같음), 밖이면 None."""
    local = now.astimezone(kst.KST)
    start, end = ACTIVE_HOURS[market]
    if start > end:          # 자정을 넘는 창(미국)
        if local.hour >= start:
            return local.date()
        if local.hour < end:
            return local.date() - timedelta(days=1)
        return None
    return local.date() if start <= local.hour < end else None


def is_active(market: str | None, now: datetime) -> bool:
    """지금이 그 시장의 활발한 시간인가(그 세션 날짜가 거래일일 때만). market이 None이면 늘 False."""
    if market is None:
        return False
    day = _session_day(market, now)
    return day is not None and _trading(market, day)


def next_window_start(market: str, now: datetime, within: timedelta) -> datetime | None:
    """``now`` 뒤 ``within`` 안에 시작하는 그 시장의 다음 활발한 시간의 시작(UTC). 없으면 None."""
    local = now.astimezone(kst.KST)
    start_hour = ACTIVE_HOURS[market][0]
    for offset in range(15):
        day = local.date() + timedelta(days=offset)
        begin = datetime.combine(day, time(start_hour), tzinfo=kst.KST)
        if begin <= local:
            continue
        if begin - local > within:
            return None
        if _trading(market, day):
            return begin.astimezone(timezone.utc)
    return None


# ==============================================================================
# 다음 시각
# ==============================================================================
def draw_next(feed_key: str, now: datetime, *, level: int = 0, retry_after: float | None = None,
              fresh_until: datetime | None = None) -> datetime:
    """
    그 피드의 다음 요청 시각(모듈 설명 '언제 받나').

    :param level: 물러남 단계(0이면 보통) — 구간에 2^level을 곱하고, 활발한 시간 시작으로 당기지 않음
    :param retry_after: 서버가 요구한 대기(초) — 이보다 앞서지 않음
    :param fresh_until: max-age가 끝나는 시각 — 이보다 앞서지 않음
    """
    cadence = CADENCES[feed_key]
    active = is_active(cadence.market, now)
    low, high = cadence.active_minutes if active else cadence.off_minutes
    when = now + timedelta(minutes=_rng.uniform(low, high) * (2 ** max(0, level)))
    if level == 0 and cadence.market is not None and not active:
        begin = next_window_start(cadence.market, now, when - now)
        if begin is not None:
            pulled = begin + timedelta(minutes=_rng.uniform(0.0, cadence.active_minutes[0]))
            when = min(when, max(pulled, now + timedelta(minutes=cadence.floor_minutes)))
    if retry_after is not None and retry_after > 0:
        when = max(when, now + timedelta(seconds=min(retry_after, SERVER_WAIT_CAP_SECONDS)))
    if fresh_until is not None and fresh_until > when:
        when = min(fresh_until, now + timedelta(seconds=SERVER_WAIT_CAP_SECONDS))
    return when


def _instant(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds") if value is not None else None


def entry_of(prev_feeds: dict, key: str) -> dict:
    """직전 저장본의 그 피드 줄(없거나 모양이 다르면 빈 dict)."""
    entry = prev_feeds.get(key) if isinstance(prev_feeds, dict) else None
    return entry if isinstance(entry, dict) else {}


def _level(entry: dict) -> int:
    value = entry.get("backoff")
    return value if isinstance(value, int) and 0 <= value <= BACKOFF_MAX_LEVEL else 0


def hold_until(feed_key: str, entry: dict) -> datetime | None:
    """하한(마지막 요청 + floor)·max-age가 막는 시각까지. 막는 것이 없으면 None."""
    last = _instant(entry.get("lastRequestAt")) or _instant(entry.get("lastOkAt"))
    hold = last + timedelta(minutes=CADENCES[feed_key].floor_minutes) if last is not None else None
    fresh = _instant(entry.get("freshUntil"))
    if fresh is not None and (hold is None or fresh > hold):
        hold = fresh
    return hold


# ==============================================================================
# 고르기 — 이번 실행에 받을 피드
# ==============================================================================
@dataclass
class Plan:
    due: list                          # 이번에 받을 피드(표 순서)
    first: list                        # 이번에 처음 일정을 정한 피드(받지 않음)
    held: list                         # 때가 됐지만 하한·max-age로 미룬 피드(받지 않음)
    next_at: datetime | None           # 받지 않을 피드 가운데 가장 이른 다음 시각
    next_key: str | None

    def idle_message(self) -> str:
        """받을 피드가 없을 때의 EmptyResult 사유."""
        tail = f" · 다음 {kst.stamp(self.next_at)}({self.next_key})" if self.next_at is not None else ""
        if self.first:
            return f"피드 일정 처음 정함 {len(self.first)}개 — 정한 직후에는 받지 않음{tail} · 외부 호출 0회"
        if self.held:
            keys = ", ".join(feed.key for feed in self.held)
            return f"때가 된 피드가 하한 간격·max-age 안이라 미룸({keys}){tail} · 외부 호출 0회"
        return f"때가 된 피드 없음{tail} · 외부 호출 0회"


def plan(task: str, feeds, prev_feeds: dict, now: datetime) -> Plan:
    """일정(fetch_schedule)과 직전 상태로 이번에 받을 피드를 고릅니다. 처음 보는 피드·미룬 피드의 다음 시각은 여기서 적습니다."""
    schedule = flex.due_map(task)
    due, first, held = [], [], []
    for feed in feeds:
        when = schedule.get(feed.key)
        if when is None:
            when = now + timedelta(minutes=_rng.uniform(*FIRST_MINUTES))
            flex.set_due(task, feed.key, when)
            schedule[feed.key] = when
            first.append(feed)
            continue
        if when > now:
            continue
        hold = hold_until(feed.key, entry_of(prev_feeds, feed.key))
        if hold is not None and hold > now:
            later = hold + timedelta(seconds=_rng.uniform(0.0, HOLD_JITTER_SECONDS))
            flex.set_due(task, feed.key, later)
            schedule[feed.key] = later
            held.append(feed)
            continue
        due.append(feed)
    taken = {feed.key for feed in due}
    rest = {feed.key: schedule[feed.key] for feed in feeds if feed.key not in taken and feed.key in schedule}
    next_key = min(rest, key=rest.__getitem__) if rest else None
    return Plan(due, first, held, rest.get(next_key) if next_key else None, next_key)


def next_scheduled(task: str, feeds) -> tuple[str | None, datetime | None]:
    """일정 표(fetch_schedule)에서 그 태스크 피드 가운데 가장 이른 다음 시각 → (피드 키, 시각). 없으면 (None, None)."""
    schedule = flex.due_map(task)
    found = [(schedule[feed.key], feed.key) for feed in feeds if feed.key in schedule]
    if not found:
        return None, None
    when, key = min(found)
    return key, when


def any_due(task: str, feeds) -> bool:
    """
    틱이 그 태스크를 부를 때인가(Task.due) — 일정이 없는 피드가 있거나 다음 시각이 지난 피드가 있으면 True. 표만 읽습니다(외부 호출 없음).
    """
    schedule = flex.due_map(task)
    now = flex._utcnow()
    return any(schedule.get(feed.key) is None or schedule[feed.key] <= now for feed in feeds)


# ==============================================================================
# 받기 — 조건부 요청
# ==============================================================================
@dataclass
class Outcome:
    """피드 하나를 받은 결과."""

    result: str                          # RESULT_*
    parsed: object | None = None         # 읽은 결과(services.news.ParsedFeed) — changed일 때만
    error: str | None = None             # 실패 사유(상태 화면에 뜨는 한 줄)
    rejected: bool = False               # 출처의 거부(403·429·봇 차단·래치)
    retry_after: float | None = None     # 서버가 요구한 대기(초)
    etag: str | None = None
    last_modified: str | None = None
    body_hash: str | None = None
    fresh_until: datetime | None = None
    clear_validators: bool = False       # 형식이 다른 200 — 남긴 검증 값을 지움
    latched: bool = False                # 래치로 막혀 나가지 않음(fetch가 '미룸'으로 옮김 — 결과로 남지 않음)
    requested_at: datetime | None = None # 실제로 보낸 시각(fetch가 채움)


@dataclass
class Fetched:
    """:func:`fetch`의 결과."""

    outcomes: dict                       # 키 → Outcome(보낸 피드만, 보낸 순서)
    unsent: list                         # 시간 상한으로 보내지 못한 피드(일정 그대로 — 다음 틱이 다시 고름)
    deferred: dict                       # 키 → 미룬 시각(호스트가 거부했거나 래치로 닫혀 보내지 않음 — 일정은 그 뒤로)


def fetch(task: str, feeds_table, due: list, prev_feeds: dict, now: datetime, *,
          parse: Callable[[bytes, str | None, object], object], clock: Callable[[], float],
          sleep: Callable[[float], None], time_limit: float, wall: Callable[[], datetime] | None = None) -> Fetched:
    """
    ``due``를 차례로 받습니다. 보내지 못한 피드(시간 상한)는 일정을 건드리지 않고, 호스트 거부·래치로 보내지 않은 피드는 그 뒤로 미룹니다.

    :param feeds_table: 그 태스크의 피드 표 전부 — 거부된 호스트의 다른 피드(이번에 때가 아닌 것 포함)를 미룰 때 씀
    :param parse: (본문, Content-Type, 피드) → ParsedFeed. 읽지 못하면 services.news.FeedShapeError
    :param wall: 지금 시각(UTC) — 피드마다 실제로 보낸 시각을 잽니다(없으면 ``now``)
    """
    wall = wall or (lambda: now)
    started = clock()
    outcomes: dict[str, Outcome] = {}
    unsent: list = []
    deferred: dict[str, datetime] = {}
    blocked: dict[str, datetime] = {}        # 호스트 → 이 시각 전에는 보내지 않음(이번 실행에서 거부됨)
    last_host: str | None = None
    for index, feed in enumerate(due):
        host = urlparse(feed.url).hostname or ""
        sent_at = wall()
        if host in blocked:
            deferred[feed.key] = _defer(task, feed, blocked[host])
            continue
        latch = http.latch_remaining(host)
        if latch is not None:
            deferred[feed.key] = _defer(task, feed, sent_at + timedelta(seconds=latch))
            continue
        if host == last_host:
            sleep(_rng.uniform(*HOST_SPACING_SECONDS))
        # 간격을 쉰 뒤에 잽니다 — 쉬는 동안 상한을 넘었으면 새 요청을 보내지 않습니다.
        if clock() - started > time_limit:
            unsent = [rest for rest in due[index:] if rest.key not in deferred]
            break
        last_host = host
        entry = entry_of(prev_feeds, feed.key)
        sent_at = wall()
        # 먼저 적어 둡니다 — 이 요청이 끝나기 전에 실행이 끊겨도 다음 틱이 곧바로 다시 묻지 않게(모듈 설명).
        flex.set_due(task, feed.key, draw_next(feed.key, sent_at, level=_level(entry)))
        outcome = _fetch_one(feed, entry, sent_at, parse)
        if outcome.latched:
            # 다른 스레드가 그 사이 같은 호스트를 닫음 — 나가지 않은 요청이라 미룸(요청·거부로 세지 않음).
            latch = http.latch_remaining(host) or 0.0
            deferred[feed.key] = _defer(task, feed, sent_at + timedelta(seconds=latch))
            continue
        outcome.requested_at = sent_at
        outcomes[feed.key] = outcome
        if outcome.result == RESULT_FAILED:
            logger.warning("사건 뉴스 피드 실패 (%s): %s", feed.key, outcome.error)
            if outcome.rejected:
                wait = max(http.REJECT_LATCH_SECONDS, min(outcome.retry_after or 0.0, SERVER_WAIT_CAP_SECONDS))
                blocked[host] = sent_at + timedelta(seconds=wait)
    if blocked:
        _hold_siblings(task, feeds_table, blocked, deferred, outcomes)
    return Fetched(outcomes, unsent, deferred)


def _defer(task: str, feed, until: datetime) -> datetime:
    """그 피드의 다음 시각을 ``until`` + 0~HOLD_JITTER_SECONDS초로 미룹니다(지금 일정이 더 늦으면 그대로)."""
    later = until + timedelta(seconds=_rng.uniform(0.0, HOLD_JITTER_SECONDS))
    current = flex.due_map(task).get(feed.key)
    if current is not None and current >= later:
        return current
    flex.set_due(task, feed.key, later)
    return later


def _hold_siblings(task: str, feeds_table, blocked: dict[str, datetime], deferred: dict, outcomes: dict) -> None:
    """
    거부된 호스트의 다른 피드(이번에 때가 되지 않은 것 포함)의 다음 시각이 거부 기한보다 이르면 그 뒤로 미룹니다.

    이번에 요청한 피드는 settle이 따로 정하므로 건드리지 않습니다.
    """
    schedule = flex.due_map(task)
    for feed in feeds_table:
        host = urlparse(feed.url).hostname or ""
        if host not in blocked or feed.key in outcomes or feed.key in deferred:
            continue
        current = schedule.get(feed.key)
        if current is not None and current < blocked[host]:
            deferred[feed.key] = _defer(task, feed, blocked[host])


def _text(value) -> str | None:
    return value if isinstance(value, str) and value else None


def _pending(entry: dict) -> bool:
    """직전에 읽은 본문에 '미래 시각'으로 미뤄 둔 항목이 있나(모듈 설명 '어떻게 받나' — 있으면 다시 읽음)."""
    value = entry.get("skippedFuture")
    return isinstance(value, int) and value > 0


def _fetch_one(feed, entry: dict, now: datetime, parse) -> Outcome:
    pending = _pending(entry)
    etag = None if pending else _text(entry.get("etag"))
    last_modified = None if pending else _text(entry.get("lastModified"))
    try:
        reply = news_service.fetch_feed_conditional(feed, etag=etag, last_modified=last_modified)
    except news_service.FeedFetchError as exc:
        return Outcome(RESULT_FAILED, error=str(exc), rejected=exc.rejected, retry_after=exc.retry_after, latched=exc.latched)
    except Exception as exc:  # noqa: BLE001 — 예기치 못한 것도 그 피드만의 실패입니다
        return Outcome(RESULT_FAILED, error=logredact.redact(http.brief_error(exc)))
    fresh_until = now + timedelta(seconds=min(reply.max_age, SERVER_WAIT_CAP_SECONDS)) if reply.max_age else None
    if reply.status == 304:
        return Outcome(RESULT_NOT_MODIFIED, etag=reply.etag or etag, last_modified=reply.last_modified or last_modified,
                       body_hash=_text(entry.get("bodyHash")), fresh_until=fresh_until)
    body_hash = hashlib.sha256(reply.content).hexdigest()
    if not pending and body_hash == entry.get("bodyHash"):
        return Outcome(RESULT_UNCHANGED, etag=reply.etag, last_modified=reply.last_modified, body_hash=body_hash,
                       fresh_until=fresh_until)
    try:
        parsed = parse(reply.content, reply.content_type, feed)
    except news_service.FeedShapeError as exc:
        return Outcome(RESULT_FAILED, error=str(exc), clear_validators=True)
    except Exception as exc:  # noqa: BLE001 — feedparser 내부 오류 같은 예기치 못한 것도 그 피드만의 실패입니다
        return Outcome(RESULT_FAILED, error=logredact.redact(http.brief_error(exc)), clear_validators=True)
    return Outcome(RESULT_CHANGED, parsed=parsed, etag=reply.etag, last_modified=reply.last_modified, body_hash=body_hash,
                   fresh_until=fresh_until)


# ==============================================================================
# 상태 줄과 다음 시각
# ==============================================================================
def _today(entry: dict, now: datetime) -> tuple[dict, dict | None]:
    """(오늘의 셈 — 날짜가 바뀌었으면 새로, 전날의 셈 — 바뀌었으면 직전 today, 아니면 직전 previousDay)."""
    day = now.astimezone(kst.KST).date().isoformat()
    before = entry.get("today") if isinstance(entry.get("today"), dict) else None
    if before is not None and before.get("date") == day:
        today = {"date": day, **{name: int(before.get(name) or 0) for name in _TODAY_COUNTS}}
        previous = entry.get("previousDay") if isinstance(entry.get("previousDay"), dict) else None
        return today, previous
    return {"date": day, **{name: 0 for name in _TODAY_COUNTS}}, before


def settle(task: str, feed, outcome: Outcome, entry_before: dict, now: datetime, stats: dict | None = None,
           fixed: dict | None = None) -> dict:
    """
    받은 결과로 그 피드의 새 상태 줄을 만들고 다음 시각을 적습니다(fetch_schedule). 직전 줄의 칸은 잇고 바뀐 칸만 고칩니다.

    :param stats: 새 본문을 읽었을 때(changed) 그 본문의 수(entries·new·seen·skipped*·newestAt 등 — 태스크가 셈)
    :param fixed: 결과와 상관없이 늘 적는 칸(한국 피드의 timeFormat)
    """
    entry = dict(entry_before)
    entry.update(fixed or {})
    now = outcome.requested_at or now        # 하한·다음 시각은 실제로 보낸 시각에서(모듈 설명)
    stamp = _iso(now)
    level = _level(entry_before)
    today, previous = _today(entry_before, now)
    today["requests"] += 1
    entry["source"] = feed.source
    entry["url"] = feed.url
    entry["lastRequestAt"] = stamp
    entry["lastResult"] = outcome.result
    if outcome.result in RECEIVED:
        level = 0
        entry["status"] = "ok"
        entry.pop("error", None)
        entry["lastOkAt"] = stamp
        entry["etag"] = outcome.etag
        entry["lastModified"] = outcome.last_modified
        entry["bodyHash"] = outcome.body_hash
        entry["freshUntil"] = _iso(outcome.fresh_until)
        if outcome.result == RESULT_CHANGED:
            entry.update(stats or {})
            entry["lastChangedAt"] = stamp
            today["changed"] += 1
        elif outcome.result == RESULT_NOT_MODIFIED:
            today["notModified"] += 1
            entry["notModifiedTotal"] = int(entry_before.get("notModifiedTotal") or 0) + 1
        else:
            today["unchanged"] += 1
    else:
        entry["status"] = "실패"
        entry["error"] = outcome.error
        entry["freshUntil"] = None
        today["failed"] += 1
        if outcome.rejected:
            today["rejected"] += 1
        if outcome.rejected or outcome.retry_after:
            level = min(level + 1, BACKOFF_MAX_LEVEL)
        if outcome.clear_validators:
            entry["etag"] = None
            entry["lastModified"] = None
    entry["backoff"] = level
    when = draw_next(feed.key, now, level=level, retry_after=outcome.retry_after, fresh_until=outcome.fresh_until)
    flex.set_due(task, feed.key, when)
    entry["nextDueAt"] = _iso(when)
    entry["today"] = today
    entry["previousDay"] = previous
    return entry


def merge(feeds_table, prev_feeds: dict, entries: dict[str, dict]) -> tuple[dict[str, dict], int, list[dict]]:
    """
    이번 실행의 줄(``entries``)과 직전 저장본의 줄을 합칩니다 → (피드 표 순서의 feeds, 지금 정상인 피드 수, 지금 실패 중인 피드 목록).

    feedsOk·failedFeeds는 '그 실행'이 아니라 피드마다의 마지막 요청 기준입니다 — 피드를 나눠 받게 되어, 한 실행의 수만 보면 전체를 말하지
    못합니다(ADR 0040 결정 4).
    """
    merged: dict[str, dict] = {}
    for feed in feeds_table:
        entry = entries.get(feed.key) or entry_of(prev_feeds, feed.key)
        if entry:
            merged[feed.key] = entry
    ok = sum(1 for entry in merged.values() if entry.get("status") == "ok")
    failed = [{"feed": key, "source": entry.get("source"), "reason": entry.get("error")}
              for key, entry in merged.items() if entry.get("status") == "실패"]
    return merged, ok, failed


def head_next(task: str, feeds_table) -> tuple[str | None, str | None]:
    """저장본 머리의 nextFeed·nextDueAt — 일정 표에서(처음 정한·미룬 피드 포함)."""
    key, when = next_scheduled(task, feeds_table)
    return key, _iso(when)


def run_note(fetched: Fetched) -> dict:
    """저장본 thisRun — 이번 실행에 요청한 피드와 결과별 수, 보내지 못한 피드·미룬 피드."""
    counts = {name: 0 for name in (RESULT_CHANGED, RESULT_NOT_MODIFIED, RESULT_UNCHANGED, RESULT_FAILED)}
    for outcome in fetched.outcomes.values():
        counts[outcome.result] += 1
    return {"requested": list(fetched.outcomes), **counts, "unsent": [feed.key for feed in fetched.unsent],
            "deferred": list(fetched.deferred)}


def run_label(outcomes: dict[str, Outcome]) -> str:
    """실행 기록의 한 토막 — '받은 피드 3/4(새 본문 1 · 304 2)'."""
    received = [o for o in outcomes.values() if o.result in RECEIVED]
    parts = []
    for result, label in ((RESULT_CHANGED, "새 본문"), (RESULT_NOT_MODIFIED, "304"), (RESULT_UNCHANGED, "같은 본문")):
        count = sum(1 for o in received if o.result == result)
        if count:
            parts.append(f"{label} {count}")
    inner = f"({' · '.join(parts)})" if parts else ""
    return f"받은 피드 {len(received)}/{len(outcomes)}{inner}"


def tail_note(task: str, feeds_table, fetched: Fetched, *, with_next: bool = True) -> str:
    """실행 기록 끝 — 미룬 피드·보내지 못한 피드와(``with_next``면) 다음 시각. 실패 글에는 다음 시각을 넣지 않습니다(같은 실패가 한 줄로 묶이게)."""
    note = ""
    if fetched.deferred:
        note += f" · 호스트 거부로 미룸: {', '.join(fetched.deferred)}"
    if fetched.unsent:
        note += f" · 시간 상한으로 다음 실행: {', '.join(feed.key for feed in fetched.unsent)}"
    if with_next:
        key, when = next_scheduled(task, feeds_table)
        if key is not None:
            note += f" · 다음 {kst.stamp(when)}({key})"
    return note
