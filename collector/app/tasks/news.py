"""
app/tasks/news.py
flex 그룹(탄력 주기 — ADR 0040) — 모의 매매(운영자 전용 기능) Claude 계좌 패킷 섹션 ``11b_events``의 사건 뉴스 헤드라인(2단계 명세 B1·B2·§10).

태스크는 "받아서 저장"만 합니다. 결정 시각 직전 24시간 창, 보유·후보 종목·매크로 키워드 거르기, 하루 상한(news.maxPerDay),
켜고 끄기(news.enabled — 꺼도 수집은 계속)는 백엔드가 이 저장본을 읽어 합니다(ADR 0008). 피드 목록은 services.news.FEEDS.
언제·어떻게 받는지(피드마다 다른 간격·무작위 흔들림·조건부 요청·거부 뒤 물러남)는 tasks/news_feeds — 한 실행은 때가 된 피드만 받습니다.

[저장]
  observations ``news_headline`` : entity = 정규화한 제목의 해시(services.news.title_entity), obs_date = 발행 시각의 UTC 날짜,
                                   payload {title, link, source, feed, feeds, publishedAt, fetchedAt, summary(피드가 줄 때만)} — 시각은 ISO UTC, fetchedAt은 처음
                                   받은 시각. feed·source·link는 처음 실어 온 피드의 것, feeds는 그 제목을 실어 온 피드 키 전부(처음 것부터).
  스냅샷 ``news.headlines.status`` : generatedAt(피드를 하나라도 받은(304 포함) 마지막 실행 시각, UTC)·feedsOk·feedsTotal·
                                   failedFeeds[{feed, source, reason}](피드마다의 마지막 요청 기준 — 지금 정상인 수·지금 실패 중인 피드)·
                                   stored7d(보관 중인 헤드라인 수)·insertedThisRun·deletedThisRun·maybeMissed(이번에 읽은 피드 가운데)·
                                   retentionDays·retainedFrom·cadence·thisRun{requested, changed, notModified, unchanged, failed, unsent, deferred}·
                                   nextFeed·nextDueAt·feeds{키: 피드별 줄 — tasks/news_feeds 모듈 설명 '상태'}.

[중복·보관]
  - 보관은 7일: 오늘(UTC) − 7일보다 앞 날짜의 행을 실행마다 지웁니다. 그보다 오래된 항목은 처음부터 넣지 않습니다 — 연준·BLS 피드는
    몇 달 치를 주므로, 넣으면 다음 실행이 지우고 그다음 실행이 다시 넣기를 되풀이합니다.
  - 같은 제목(entity)이 보관 기간 안에 이미 있으면 **날짜가 달라도** 다시 넣지 않습니다(기본 키는 날짜별이라 따로 막음). 한 실행
    안에서 여러 피드에 같은 제목이 오면 FEEDS 순서로 먼저 온 피드의 것을 씁니다.
  - 그래도 그 제목을 실어 온 피드는 모두 ``feeds``에 남깁니다 — 같은 실행이면 넣는 payload에, 다음 실행이면 이미 넣은 행에 피드 키만
    더합니다(store.add_headline_feeds — publishedAt·fetchedAt은 그대로). 백엔드가 news.feeds를 '이 피드가 실어 온 제목'으로 거르므로,
    처음 실어 온 피드 하나만 남기면 다른 피드만 고른 설정에서 그 사건이 빠집니다.
  - 발행 시각이 지금보다 하루 넘게 뒤인 항목은 건너뜁니다 — 시간대를 잘못 읽은 항목이 보관 기한을 넘어 남지 않게.
  - 시각이 없는 항목은 건너뛰고 셉니다(지어낸 시각을 넣지 않음).

[실패 규칙 — 수집기 공통]
  - 피드 하나의 실패는 나머지를 멈추지 않습니다. 실패한 피드와 사유는 실행 기록(collector_task_runs의 detail)과 상태
    스냅샷의 그 피드 줄·failedFeeds에 남습니다.
  - 이번 실행에 받은 피드가 하나도 없으면 행은 건드리지 않고(보관 정리도 하지 않음), 상태 스냅샷은 실패한 피드의 줄(물러남·다음 시각)만
    고쳐 씁니다 — generatedAt 등 다른 칸과 저장 시각(collected_at)은 직전 값 그대로, 저장본이 아직 없으면 쓰지 않음(ADR 0040 결정 4). 다른
    피드가 지금 정상이면 실행은 성공(실패한 피드를 적음 — 예전 매시 실행과 같은 모양), 모두 실패 중이면 EmptyResult입니다.
  - 헤드라인은 쌓기만 해서 '이전 값 이어받기'가 따로 없습니다 — 실패한 피드가 전에 넣은 행은 그대로 남습니다. 상태의 피드 줄은
    마지막 성공 시각(lastOkAt)을 잇습니다.
  - 피드가 준 항목이 모두 처음 보는 것이면(인베스팅닷컴은 최근 10건만 줌) 지난 수집과 겹치지 않아 그 사이 항목을 놓쳤을 수
    있습니다 — detail과 상태(maybeMissed)에 '누락 가능'. 그 피드를 전에 받은 적이 있을 때만 셉니다(첫 수집은 늘 전부 처음).
"""
from __future__ import annotations

import logging
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

from .. import catalog, store
from ..services import news as news_service

from . import news_feeds
from .base import EmptyResult, previous_payload

logger = logging.getLogger(__name__)

# 보관 일수(명세 B2). 백엔드 창은 결정 시각 직전 24시간이라 최근 기준일에는 넉넉하고, 같은 제목 중복 제거도 이 기간 안에서 봅니다.
RETENTION_DAYS = 7

# 발행 시각이 이만큼 넘게 미래면 건너뜁니다(모듈 설명 '중복·보관').
FUTURE_TOLERANCE = timedelta(days=1)

# 새 피드를 더 시작하지 않는 경과 시간(초). flex 상한(runner.TASK_DEADLINE_SECONDS["flex"] = 600초)을 넘기면 '시간 초과'로 끝나
# 받은 피드도 저장하지 못하므로 상한 전에 멈춥니다. 남는 300초는 진행 중인 요청 하나(SEC 세션 재시도 5회 × 읽기 대기 20초 + 백오프)와
# 저장의 여유입니다. 보내지 못한 피드는 일정을 건드리지 않아 다음 틱이 다시 고릅니다. 같은 호스트 사이 간격은 news_feeds.HOST_SPACING_SECONDS.
TIME_LIMIT_SECONDS = 300.0

TASK_NAME = "news_headlines"


def due() -> bool:
    """flex 틱이 이 태스크를 부를 때인가 — 일정이 없거나 때가 된 피드가 있으면 참(tasks/news_feeds.any_due, 외부 호출 없음)."""
    return news_feeds.any_due(TASK_NAME, news_service.FEEDS)


def _parse(content: bytes, content_type: str | None, feed) -> news_service.ParsedFeed:   # noqa: ARG001 — 미국 피드는 feedparser 시각 그대로
    return news_service.parse_feed(content, content_type)


def task_news_headlines() -> str:
    """때가 된 사건 뉴스 RSS 피드 → observations ``news_headline`` + 상태 ``news.headlines.status``(피드별 줄을 합침)."""
    feeds_table = news_service.FEEDS
    now = _now()
    stamp = now.isoformat(timespec="seconds")
    cutoff = now.date() - timedelta(days=RETENTION_DAYS)
    previous = previous_payload(catalog.SNAP_NEWS_STATUS)
    prev_feeds = previous.get("feeds") if isinstance(previous.get("feeds"), dict) else {}

    plan = news_feeds.plan(TASK_NAME, feeds_table, prev_feeds, now)
    if not plan.due:
        raise EmptyResult(plan.idle_message())
    fetched = news_feeds.fetch(TASK_NAME, feeds_table, plan.due, prev_feeds, now, parse=_parse, clock=_clock, sleep=_sleep,
                               time_limit=TIME_LIMIT_SECONDS, wall=_now)
    outcomes = fetched.outcomes
    failed = {key: outcome.error for key, outcome in outcomes.items() if outcome.result == news_feeds.RESULT_FAILED}
    received = [key for key, outcome in outcomes.items() if outcome.result in news_feeds.RECEIVED]
    sent = [feed for feed in plan.due if feed.key in outcomes]

    if not received:
        # 받은 피드가 없음 — 행은 그대로. 상태는 실패한 피드의 줄(물러남·다음 시각)만 고쳐 쓰고 나머지 칸·저장 시각(collected_at)은 그대로입니다
        # (ADR 0040 결정 4 — 피드를 나눠 받아, 쓰지 않으면 한 피드만 받는 실행의 실패가 어디에도 남지 않음. 저장 시각을 바꾸면 모두 실패한
        # 동안 상태 화면의 '오래됨'이 가려짐). 저장본이 아직 없으면 쓰지 않습니다. 다른 피드가 지금 정상이면 예전 매시 실행처럼 성공으로 남기고
        # 실패를 적습니다 — 막힌 피드 하나만 도는 실행마다 태스크가 '실패'로 깜박이지 않게.
        entries = {feed.key: news_feeds.settle(TASK_NAME, feed, outcomes[feed.key], news_feeds.entry_of(prev_feeds, feed.key), now)
                   for feed in sent}
        merged, ok_count, failed_feeds = news_feeds.merge(feeds_table, prev_feeds, entries)
        next_key, next_at = news_feeds.head_next(TASK_NAME, feeds_table)
        if previous:
            store.update_snapshot_payload(catalog.SNAP_NEWS_STATUS, {
                **previous, "feeds": merged, "feedsOk": ok_count, "feedsTotal": len(feeds_table), "failedFeeds": failed_feeds,
                "thisRun": news_feeds.run_note(fetched), "nextFeed": next_key, "nextDueAt": next_at,
            })
        if previous and ok_count:
            return (f"새 헤드라인 0건 · {news_feeds.run_label(outcomes)} · 다른 피드 정상 {ok_count}/{len(feeds_table)}"
                    + _failed_suffix(failed) + news_feeds.tail_note(TASK_NAME, feeds_table, fetched))
        # 실패 글에는 다음 시각을 넣지 않습니다 — 같은 실패가 상태 화면의 오류 모음에서 한 줄로 묶이게.
        raise EmptyResult(f"피드 0/{len(outcomes)} — 기존 저장본 유지" + _failed_suffix(failed)
                          + news_feeds.tail_note(TASK_NAME, feeds_table, fetched, with_next=False))

    # 보관 기간 안에 이미 있는 제목 — 날짜를 가리지 않는 중복 제거와 '누락 가능' 판단에 씁니다(이번 실행 전 상태).
    existing = store.observation_entities_since(catalog.OBS_NEWS_HEADLINE, cutoff.isoformat())
    # 이번 실행에 넣을 행의 payload(entity → payload) — 같은 실행의 다른 피드가 같은 제목을 실으면 그 payload의 feeds에 더합니다.
    taken: dict[str, dict] = {}
    # 전 실행에 넣은 제목을 이번에 받은 피드 — 넣은 뒤 그 행의 feeds에 더합니다(모듈 설명 '중복·보관').
    carried: list[tuple[str, str]] = []
    rows: list[tuple] = []
    entries: dict[str, dict] = {}
    maybe_missed: list[str] = []
    skipped = Counter()

    for feed in sent:
        outcome = outcomes[feed.key]
        before = news_feeds.entry_of(prev_feeds, feed.key)
        if outcome.result != news_feeds.RESULT_CHANGED:
            # 실패·304·같은 본문 — 읽은 것이 없습니다. 상태 줄만 고칩니다(마지막으로 읽은 본문의 수는 그대로).
            entries[feed.key] = news_feeds.settle(TASK_NAME, feed, outcome, before, now)
            continue
        result = outcome.parsed
        counts = Counter()
        newest: datetime | None = None
        overlap = 0
        for item in result.items:
            published: datetime = item["publishedAt"]
            if published > now + FUTURE_TOLERANCE:
                counts["future"] += 1
                continue
            if published.date() < cutoff:
                counts["old"] += 1
                continue
            newest = published if newest is None or published > newest else newest
            entity = item["entity"]
            if entity in existing:
                overlap += 1
                carried.append((entity, feed.key))
                counts["seen"] += 1
                continue
            if entity in taken:
                carriers = taken[entity]["feeds"]
                if feed.key not in carriers:
                    carriers.append(feed.key)
                counts["seen"] += 1
                continue
            payload = {
                "title": item["title"],
                "link": item["link"],
                "source": feed.source,
                "feed": feed.key,
                "feeds": [feed.key],
                "publishedAt": published.isoformat(timespec="seconds"),
                "fetchedAt": stamp,
            }
            if item.get("summary"):
                payload["summary"] = item["summary"]      # 피드가 준 요약(정보 수집 화면용 — 패킷은 읽지 않음, ADR 0037)
            taken[entity] = payload
            rows.append((published.date(), entity, payload))
            counts["new"] += 1
        # 피드가 준 항목이 모두 보관 기간 안이고 하나도 전에 본 적이 없음 → 지난 수집과 겹치지 않음(모듈 설명 '실패 규칙').
        if before.get("lastOkAt") and not counts["old"] and not counts["future"] and not overlap:
            maybe_missed.append(feed.key)
        skipped["noTime"] += result.no_time
        skipped["noTitle"] += result.no_title
        skipped["future"] += counts["future"]
        entries[feed.key] = news_feeds.settle(TASK_NAME, feed, outcome, before, now, stats={
            "entries": result.entries,
            "new": counts["new"],
            "seen": counts["seen"],
            "skippedOld": counts["old"],
            "skippedFuture": counts["future"],
            "skippedNoTime": result.no_time,
            "skippedNoTitle": result.no_title,
            "newestAt": newest.isoformat(timespec="seconds") if newest else None,
        })

    store.insert_new_observations(catalog.OBS_NEWS_HEADLINE, rows)
    store.add_headline_feeds(catalog.OBS_NEWS_HEADLINE, cutoff.isoformat(), carried)
    deleted = store.delete_observations_before(catalog.OBS_NEWS_HEADLINE, cutoff.isoformat())
    stored = len(existing | taken.keys())

    merged, ok_count, failed_feeds = news_feeds.merge(feeds_table, prev_feeds, entries)
    next_key, next_at = news_feeds.head_next(TASK_NAME, feeds_table)
    store.put_snapshot(catalog.SNAP_NEWS_STATUS, {
        "generatedAt": stamp,
        "source": news_service.SOURCE_NOTE,
        "cadence": news_feeds.CADENCE_NOTE,
        "retentionDays": RETENTION_DAYS,
        "retainedFrom": cutoff.isoformat(),
        "stored7d": stored,
        "insertedThisRun": len(rows),
        "deletedThisRun": deleted,
        "feedsOk": ok_count,
        "feedsTotal": len(feeds_table),
        "failedFeeds": failed_feeds,
        "maybeMissed": maybe_missed,
        "thisRun": news_feeds.run_note(fetched),
        "nextFeed": next_key,
        "nextDueAt": next_at,
        "feeds": merged,
    })

    detail = (f"새 헤드라인 {len(rows)}건 · {news_feeds.run_label(outcomes)} · "
              f"{RETENTION_DAYS}일 보관 {stored}건")
    if deleted:
        detail += f"(지움 {deleted}건)"
    if skipped["noTime"]:
        detail += f" · 시각 없음 {skipped['noTime']}건 건너뜀"
    if skipped["noTitle"]:
        detail += f" · 제목 없음 {skipped['noTitle']}건 건너뜀"
    if skipped["future"]:
        detail += f" · 미래 시각 {skipped['future']}건 건너뜀"
    if maybe_missed:
        detail += f" · 누락 가능: {', '.join(maybe_missed)}(받은 항목이 모두 처음 봄 — 지난 수집 뒤 더 많이 나왔을 수 있음)"
    return detail + _failed_suffix(failed) + news_feeds.tail_note(TASK_NAME, feeds_table, fetched)


def _failed_suffix(failed: dict[str, str]) -> str:
    """실패한 피드를 모두 사유와 함께 적습니다(피드는 8개뿐이라 _reason_suffix처럼 두 개로 자르지 않음)."""
    if not failed:
        return ""
    return f" · 실패 {len(failed)}개: " + "; ".join(f"{key}({reason})" for key, reason in failed.items())


# ==============================================================================
# 작은 도구 — 테스트가 바꿔 끼우는 자리
# ==============================================================================
def _now() -> datetime:
    """지금 시각(UTC). 테스트가 시계를 바꿔 끼우는 자리입니다 — 보관 기한·obs_date는 UTC 날짜입니다(서버 TZ와 무관)."""
    return datetime.now(timezone.utc)


def _clock() -> float:
    """경과 시간 시계(초). 테스트가 시간 상한을 시험할 때 바꿔 끼웁니다."""
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)
