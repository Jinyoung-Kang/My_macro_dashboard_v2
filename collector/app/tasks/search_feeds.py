"""
app/tasks/search_feeds.py
flex 그룹(탄력 주기 — ADR 0040) — 정보 검색의 새 피드 묶음(ADR 0041 결정 8, 계약 docs/specs/2026-11-14-info-search-contract.md §6-1).

보도자료·경제지 RSS 12개(services/search_feeds.SEARCH_FEEDS)를 피드마다 무작위 간격·조건부 요청으로 받아 관측치 ``search_feed_headline``에
쌓습니다. 사건 뉴스(tasks/news·kr_news — 모의 매매 패킷의 입력)와 다른 피드 표·다른 데이터셋이고, **모의 매매 패킷은 이 묶음을 읽지 않습니다.**
쓰는 곳은 정보 검색(뉴스·타임라인의 저장본 출처 ``feeds``·첫 화면 최근 글)과 관심 대상 대조(tasks/search_watch)입니다.

[언제 받나 — 피드마다, 사건 뉴스(tasks/news_feeds)와 같은 규칙]
  - 피드마다 표의 간격 구간(분 — 시장 시간과 상관없이 같음)에서 실행마다 다음 시각을 무작위로 정해 fetch_schedule(``search_feeds/<피드>``)에 둡니다.
  - 처음(일정이 없는 피드)에는 받지 않고 FIRST_MINUTES(2~25분) 안에서 흩어 정합니다.
  - 하한: 마지막 요청 뒤 FLOOR_MINUTES(10분)가 지나지 않았거나 응답의 max-age가 남았으면 때가 됐어도 묻지 않고 미룹니다.
  - 거부(403·429·봇 차단)나 Retry-After가 붙은 실패면 그 피드의 간격을 두 배씩(최대 8배) 늘리고, 받으면 되돌립니다. 보낸 요청이 거부되면 같은
    호스트의 다른 피드는 그 실행에서 보내지 않고 거부 기한 뒤로 미룹니다. 공용 세션의 거부 래치로 닫힌 호스트의 피드는 보내지 않고 미룹니다.
  - 같은 호스트의 피드(CNBC 둘)는 한 실행에서 차례로, 사이 HOST_SPACING_SECONDS(2~5초, 무작위) + 세션의 호스트 간격.
  - 요청 바로 전에 다음 시각을 먼저 적습니다(실행이 끊겨도 다음 틱이 곧바로 다시 묻지 않게). 로컬에서도 돕니다(공용 세션 — 사건 뉴스와 같음).
  - 받기·상태 줄의 셈(조건부 요청·304·같은 본문·검증 값 지우기·today/previousDay)은 tasks/news_feeds의 함수를 그대로 씁니다. 간격 표만 이 모듈의
    것입니다(news_feeds.CADENCES는 사건 뉴스 피드만 담음 — 시험이 봄).

[저장 — catalog.OBS_SEARCH_FEED_HEADLINE]
  entity = 같은 글 키(원문 주소면 info_text.item_id, 없으면 제목 앞 24자), obs_date = 작성 시각(없으면 처음 받은 시각)의 UTC 날짜,
  payload {title, summary, url, publisher, publisherDomain, feed, publishedAt|null, fetchedAt, timeBasis, lang}.
  - 보관 90일: 오늘(UTC) − 90일보다 앞 날짜의 행을 실행마다 지우고, 그보다 오래된 글은 처음부터 넣지 않습니다(넣으면 다음 실행이 지우고 그다음
    실행이 다시 넣기를 되풀이). 2년 규칙은 이 안에 듭니다. 중국어 제목은 넣지 않습니다(정보 검색 규칙 2).
  - 같은 글이 보관 기간 안에 이미 있으면 다시 넣지 않습니다(처음 받은 시각 fetchedAt을 지킴). 한 실행 안에서 여러 피드가 같은 글을 실으면 표 순서로
    먼저 온 피드의 것.
  - 작성 시각이 없는 글(Nikkei Asia)은 처음 받은 시각을 timeBasis ``fetched``로 넣습니다. 지금 + 1일보다 미래인 글은 건너뜁니다(다음에 다시 읽음).
  - 상태 저장본 ``search.feeds.status``: 사건 뉴스 상태와 같은 피드별 줄(feeds{키: 줄})·feedsOk·feedsTotal·failedFeeds·thisRun·nextFeed·nextDueAt과
    retentionDays·retainedFrom·stored(보관 중인 글 수)·insertedThisRun·deletedThisRun. 받은 피드가 하나도 없으면 행은 그대로이고 상태는 실패한
    피드의 줄만 고칩니다(저장본이 아직 없으면 쓰지 않음 — ADR 0040 결정 4와 같음).
"""
from __future__ import annotations

import logging
import random
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from .. import catalog, http, store
from ..services import search_feeds as svc
from ..services import search_rules as rules
from . import flex, news_feeds
from .base import EmptyResult, previous_payload

logger = logging.getLogger(__name__)

TASK_NAME = "search_feeds"
RETENTION_DAYS = 90
FUTURE_TOLERANCE = timedelta(days=1)
# 새 피드를 더 시작하지 않는 경과 시간(초) — flex 상한(600초) 전에 멈추고 받은 것을 저장합니다(tasks/news와 같은 값).
TIME_LIMIT_SECONDS = 300.0
FLOOR_MINUTES = news_feeds.MIN_FLOOR_MINUTES          # 10분
FIRST_MINUTES = news_feeds.FIRST_MINUTES              # 2~25분
HOST_SPACING_SECONDS = news_feeds.HOST_SPACING_SECONDS  # 2~5초
BACKOFF_MAX_LEVEL = news_feeds.BACKOFF_MAX_LEVEL      # 2^3 = 8배
HOLD_JITTER_SECONDS = news_feeds.HOLD_JITTER_SECONDS
SERVER_WAIT_CAP_SECONDS = news_feeds.SERVER_WAIT_CAP_SECONDS

CADENCE_NOTE = ("flex 탄력 주기(ADR 0040·0041) — 피드마다 무작위 간격(연준·ECB·영란은행 120~240분, BBC·CNBC 세계 90~180분, Economist 180~360분, "
                "Bloomberg·CNBC 금융·Nikkei Asia 60~120분, MarketWatch·Benzinga 45~90분, Seeking Alpha 30~60분), 하한 10분, "
                "조건부 요청(ETag·Last-Modified → 304), 거부 시 간격 두 배(최대 8배), 같은 호스트는 차례로 2~5초")

# 시험이 난수를 바꿔 끼우는 자리입니다.
_rng = random.Random()


def due() -> bool:
    """flex 틱이 이 태스크를 부를 때인가 — 일정이 없거나 때가 된 피드가 있으면 참(표만 읽음, 외부 호출 없음)."""
    return news_feeds.any_due(TASK_NAME, svc.SEARCH_FEEDS)


# ==============================================================================
# 다음 시각
# ==============================================================================
def draw_next(feed: svc.SearchFeed, now: datetime, *, level: int = 0, retry_after: float | None = None,
              fresh_until: datetime | None = None) -> datetime:
    """그 피드의 다음 요청 시각 — 간격 구간 × 2^level(무작위), 서버 지시(Retry-After·max-age)보다 앞서지 않음(하루까지만 따름)."""
    low, high = feed.minutes
    when = now + timedelta(minutes=_rng.uniform(low, high) * (2 ** max(0, level)))
    if retry_after is not None and retry_after > 0:
        when = max(when, now + timedelta(seconds=min(retry_after, SERVER_WAIT_CAP_SECONDS)))
    if fresh_until is not None and fresh_until > when:
        when = min(fresh_until, now + timedelta(seconds=SERVER_WAIT_CAP_SECONDS))
    return when


def hold_until(entry: dict) -> datetime | None:
    """하한(마지막 요청 + FLOOR_MINUTES)·max-age가 막는 시각까지. 막는 것이 없으면 None."""
    last = news_feeds._instant(entry.get("lastRequestAt")) or news_feeds._instant(entry.get("lastOkAt"))
    hold = last + timedelta(minutes=FLOOR_MINUTES) if last is not None else None
    fresh = news_feeds._instant(entry.get("freshUntil"))
    if fresh is not None and (hold is None or fresh > hold):
        hold = fresh
    return hold


# ==============================================================================
# 고르기 · 받기 · 상태 줄 (tasks/news_feeds와 같은 규칙 — 간격 표만 다름)
# ==============================================================================
def plan(feeds_table, prev_feeds: dict, now: datetime) -> news_feeds.Plan:
    """일정과 직전 상태로 이번에 받을 피드를 고릅니다. 처음 보는 피드·미룬 피드의 다음 시각은 여기서 적습니다."""
    schedule = flex.due_map(TASK_NAME)
    due_feeds, first, held = [], [], []
    for feed in feeds_table:
        when = schedule.get(feed.key)
        if when is None:
            when = now + timedelta(minutes=_rng.uniform(*FIRST_MINUTES))
            flex.set_due(TASK_NAME, feed.key, when)
            schedule[feed.key] = when
            first.append(feed)
            continue
        if when > now:
            continue
        hold = hold_until(news_feeds.entry_of(prev_feeds, feed.key))
        if hold is not None and hold > now:
            later = hold + timedelta(seconds=_rng.uniform(0.0, HOLD_JITTER_SECONDS))
            flex.set_due(TASK_NAME, feed.key, later)
            schedule[feed.key] = later
            held.append(feed)
            continue
        due_feeds.append(feed)
    taken = {feed.key for feed in due_feeds}
    rest = {feed.key: schedule[feed.key] for feed in feeds_table if feed.key not in taken and feed.key in schedule}
    next_key = min(rest, key=rest.__getitem__) if rest else None
    return news_feeds.Plan(due_feeds, first, held, rest.get(next_key) if next_key else None, next_key)


def fetch(feeds_table, due_feeds: list, prev_feeds: dict, now: datetime, *, clock, sleep, time_limit: float,
          wall=None) -> news_feeds.Fetched:
    """
    ``due_feeds``를 차례로 받습니다(조건부 요청). 시간 상한으로 보내지 못한 피드는 일정을 건드리지 않고, 호스트 거부·래치로 보내지 않은 피드는
    그 뒤로 미룹니다. 같은 호스트는 사이 HOST_SPACING_SECONDS.
    """
    wall = wall or (lambda: now)
    started = clock()
    outcomes: dict[str, news_feeds.Outcome] = {}
    unsent: list = []
    deferred: dict[str, datetime] = {}
    blocked: dict[str, datetime] = {}
    last_host: str | None = None
    for index, feed in enumerate(due_feeds):
        host = urlparse(feed.url).hostname or ""
        sent_at = wall()
        if host in blocked:
            deferred[feed.key] = news_feeds._defer(TASK_NAME, feed, blocked[host])
            continue
        latch = http.latch_remaining(host)
        if latch is not None:
            deferred[feed.key] = news_feeds._defer(TASK_NAME, feed, sent_at + timedelta(seconds=latch))
            continue
        if host == last_host:
            sleep(_rng.uniform(*HOST_SPACING_SECONDS))
        if clock() - started > time_limit:
            unsent = [rest for rest in due_feeds[index:] if rest.key not in deferred]
            break
        last_host = host
        entry = news_feeds.entry_of(prev_feeds, feed.key)
        sent_at = wall()
        flex.set_due(TASK_NAME, feed.key, draw_next(feed, sent_at, level=news_feeds._level(entry)))
        outcome = news_feeds._fetch_one(feed, entry, sent_at, svc.parse)
        if outcome.latched:
            latch = http.latch_remaining(host) or 0.0
            deferred[feed.key] = news_feeds._defer(TASK_NAME, feed, sent_at + timedelta(seconds=latch))
            continue
        outcome.requested_at = sent_at
        outcomes[feed.key] = outcome
        if outcome.result == news_feeds.RESULT_FAILED:
            logger.warning("보도자료·경제지 피드 실패 (%s): %s", feed.key, outcome.error)
            if outcome.rejected:
                wait = max(http.REJECT_LATCH_SECONDS, min(outcome.retry_after or 0.0, SERVER_WAIT_CAP_SECONDS))
                blocked[host] = sent_at + timedelta(seconds=wait)
    if blocked:
        news_feeds._hold_siblings(TASK_NAME, feeds_table, blocked, deferred, outcomes)
    return news_feeds.Fetched(outcomes, unsent, deferred)


def settle(feed: svc.SearchFeed, outcome: news_feeds.Outcome, entry_before: dict, now: datetime,
           stats: dict | None = None) -> dict:
    """받은 결과로 그 피드의 새 상태 줄을 만들고 다음 시각을 적습니다(직전 줄의 칸은 잇고 바뀐 칸만 고침 — news_feeds.settle과 같은 칸)."""
    entry = dict(entry_before)
    now = outcome.requested_at or now
    stamp = rules.utc_iso(now)
    level = news_feeds._level(entry_before)
    today, previous = news_feeds._today(entry_before, now)
    today["requests"] += 1
    entry["source"] = feed.source
    entry["url"] = feed.url
    entry["lastRequestAt"] = stamp
    entry["lastResult"] = outcome.result
    if outcome.result in news_feeds.RECEIVED:
        level = 0
        entry["status"] = "ok"
        entry.pop("error", None)
        entry["lastOkAt"] = stamp
        entry["etag"] = outcome.etag
        entry["lastModified"] = outcome.last_modified
        entry["bodyHash"] = outcome.body_hash
        entry["freshUntil"] = news_feeds._iso(outcome.fresh_until)
        if outcome.result == news_feeds.RESULT_CHANGED:
            entry.update(stats or {})
            entry["lastChangedAt"] = stamp
            today["changed"] += 1
        elif outcome.result == news_feeds.RESULT_NOT_MODIFIED:
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
    when = draw_next(feed, now, level=level, retry_after=outcome.retry_after, fresh_until=outcome.fresh_until)
    flex.set_due(TASK_NAME, feed.key, when)
    entry["nextDueAt"] = news_feeds._iso(when)
    entry["today"] = today
    entry["previousDay"] = previous
    return entry


# ==============================================================================
# 태스크
# ==============================================================================
def task_search_feeds() -> str:
    """때가 된 새 피드 묶음 피드 → observations ``search_feed_headline`` + 상태 ``search.feeds.status``(피드별 줄을 합침)."""
    feeds_table = svc.SEARCH_FEEDS
    now = _now()
    stamp = rules.utc_iso(now)
    cutoff = now.date() - timedelta(days=RETENTION_DAYS)
    window_start = rules.window_start(rules.kst_today(now))
    previous = previous_payload(catalog.SNAP_SEARCH_FEEDS_STATUS)
    prev_feeds = previous.get("feeds") if isinstance(previous.get("feeds"), dict) else {}

    planned = plan(feeds_table, prev_feeds, now)
    if not planned.due:
        raise EmptyResult(planned.idle_message())
    fetched = fetch(feeds_table, planned.due, prev_feeds, now, clock=_clock, sleep=_sleep, time_limit=TIME_LIMIT_SECONDS,
                    wall=_now)
    outcomes = fetched.outcomes
    failed = {key: outcome.error for key, outcome in outcomes.items() if outcome.result == news_feeds.RESULT_FAILED}
    received = [key for key, outcome in outcomes.items() if outcome.result in news_feeds.RECEIVED]
    sent = [feed for feed in planned.due if feed.key in outcomes]

    if not received:
        entries = {feed.key: settle(feed, outcomes[feed.key], news_feeds.entry_of(prev_feeds, feed.key), now) for feed in sent}
        merged, ok_count, failed_feeds = news_feeds.merge(feeds_table, prev_feeds, entries)
        next_key, next_at = news_feeds.next_scheduled(TASK_NAME, feeds_table)
        if previous:
            store.update_snapshot_payload(catalog.SNAP_SEARCH_FEEDS_STATUS, {
                **previous, "feeds": merged, "feedsOk": ok_count, "feedsTotal": len(feeds_table), "failedFeeds": failed_feeds,
                "thisRun": news_feeds.run_note(fetched), "nextFeed": next_key, "nextDueAt": news_feeds._iso(next_at),
            })
        if previous and ok_count:
            return (f"새 글 0건 · {news_feeds.run_label(outcomes)} · 다른 피드 정상 {ok_count}/{len(feeds_table)}"
                    + _failed_suffix(failed) + news_feeds.tail_note(TASK_NAME, feeds_table, fetched))
        raise EmptyResult(f"피드 0/{len(outcomes)} — 기존 저장본 유지" + _failed_suffix(failed)
                          + news_feeds.tail_note(TASK_NAME, feeds_table, fetched, with_next=False))

    existing = store.observation_entities_since(catalog.OBS_SEARCH_FEED_HEADLINE, cutoff.isoformat())
    taken: set[str] = set()
    rows: list[tuple] = []
    entries: dict[str, dict] = {}
    skipped = Counter()

    for feed in sent:
        outcome = outcomes[feed.key]
        before = news_feeds.entry_of(prev_feeds, feed.key)
        if outcome.result != news_feeds.RESULT_CHANGED:
            entries[feed.key] = settle(feed, outcome, before, now)
            continue
        result = outcome.parsed
        counts = Counter()
        newest: datetime | None = None
        for item in result.items:
            published: datetime | None = item["publishedAt"]
            if published is not None and published > now + FUTURE_TOLERANCE:
                counts["future"] += 1
                continue
            moment = published or now
            if moment.date() < cutoff or moment < window_start:
                counts["old"] += 1
                continue
            if rules.is_chinese_title(item["title"]):
                counts["chinese"] += 1
                continue
            newest = moment if newest is None or moment > newest else newest
            entity = rules.item_key(item["url"], item["title"])
            if not entity or entity in existing or entity in taken:
                counts["seen"] += 1
                continue
            payload = {
                "title": item["title"],
                "summary": item["summary"],
                "url": item["url"],
                "publisher": feed.source,
                "publisherDomain": rules.domain_of(item["url"]),
                "feed": feed.key,
                "publishedAt": rules.utc_iso(published) if published is not None else None,
                "fetchedAt": stamp,
                "timeBasis": "published" if published is not None else "fetched",
                "lang": feed.lang,
            }
            taken.add(entity)
            rows.append((moment.date(), entity, payload))
            counts["new"] += 1
        skipped["future"] += counts["future"]
        skipped["chinese"] += counts["chinese"]
        skipped["noTitle"] += result.no_title
        entries[feed.key] = settle(feed, outcome, before, now, stats={
            "entries": result.entries,
            "new": counts["new"],
            "seen": counts["seen"],
            "skippedOld": counts["old"],
            "skippedFuture": counts["future"],
            "skippedChinese": counts["chinese"],
            "skippedNoTitle": result.no_title,
            "noTime": result.no_time,
            "newestAt": rules.utc_iso(newest) if newest else None,
        })

    store.insert_new_observations(catalog.OBS_SEARCH_FEED_HEADLINE, rows)
    deleted = store.delete_observations_before(catalog.OBS_SEARCH_FEED_HEADLINE, cutoff.isoformat())
    stored = len(existing | taken)

    merged, ok_count, failed_feeds = news_feeds.merge(feeds_table, prev_feeds, entries)
    next_key, next_at = news_feeds.next_scheduled(TASK_NAME, feeds_table)
    store.put_snapshot(catalog.SNAP_SEARCH_FEEDS_STATUS, {
        "generatedAt": stamp,
        "source": svc.SOURCE_NOTE,
        "cadence": CADENCE_NOTE,
        "retentionDays": RETENTION_DAYS,
        "retainedFrom": cutoff.isoformat(),
        "stored": stored,
        "insertedThisRun": len(rows),
        "deletedThisRun": deleted,
        "feedsOk": ok_count,
        "feedsTotal": len(feeds_table),
        "failedFeeds": failed_feeds,
        "thisRun": news_feeds.run_note(fetched),
        "nextFeed": next_key,
        "nextDueAt": news_feeds._iso(next_at),
        "feeds": merged,
    })

    detail = f"새 글 {len(rows)}건 · {news_feeds.run_label(outcomes)} · {RETENTION_DAYS}일 보관 {stored}건"
    if deleted:
        detail += f"(지움 {deleted}건)"
    if skipped["chinese"]:
        detail += f" · 중국어 제목 {skipped['chinese']}건 뺌"
    if skipped["noTitle"]:
        detail += f" · 제목 없음 {skipped['noTitle']}건 건너뜀"
    if skipped["future"]:
        detail += f" · 미래 시각 {skipped['future']}건 건너뜀"
    return detail + _failed_suffix(failed) + news_feeds.tail_note(TASK_NAME, feeds_table, fetched)


def _failed_suffix(failed: dict[str, str]) -> str:
    if not failed:
        return ""
    return f" · 실패 {len(failed)}개: " + "; ".join(f"{key}({reason})" for key, reason in failed.items())


# ==============================================================================
# 작은 도구 — 테스트가 바꿔 끼우는 자리
# ==============================================================================
def _now() -> datetime:
    """지금 시각(UTC). 보관 기한·obs_date는 UTC 날짜입니다."""
    return datetime.now(timezone.utc)


def _clock() -> float:
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)
