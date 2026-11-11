"""
app/tasks/news.py
slow 그룹 — 모의 매매(운영자 전용 기능) Claude 계좌 패킷 섹션 ``11b_events``의 사건 뉴스 헤드라인(2단계 명세 B1·B2·§10).

태스크는 "받아서 저장"만 합니다. 결정 시각 직전 24시간 창, 보유·후보 종목·매크로 키워드 거르기, 하루 상한(news.maxPerDay),
켜고 끄기(news.enabled — 꺼도 수집은 계속)는 백엔드가 이 저장본을 읽어 합니다(ADR 0008). 피드 목록은 services.news.FEEDS.

[저장]
  observations ``news_headline`` : entity = 정규화한 제목의 해시(services.news.title_entity), obs_date = 발행 시각의 UTC 날짜,
                                   payload {title, link, source, feed, feeds, publishedAt, fetchedAt, summary(피드가 줄 때만)} — 시각은 ISO UTC, fetchedAt은 처음
                                   받은 시각. feed·source·link는 처음 실어 온 피드의 것, feeds는 그 제목을 실어 온 피드 키 전부(처음 것부터).
  스냅샷 ``news.headlines.status`` : generatedAt(이번 수집 시각, UTC)·feedsOk·feedsTotal·failedFeeds[{feed, source, reason}]·
                                   stored7d(보관 중인 헤드라인 수)·insertedThisRun·deletedThisRun·maybeMissed·retentionDays·
                                   retainedFrom·feeds{키: 피드별 결과와 lastOkAt}.

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
    스냅샷 failedFeeds에 남습니다.
  - 전부 실패하면 EmptyResult — 행·상태 스냅샷을 건드리지 않습니다(보관 정리도 하지 않음).
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
from urllib.parse import urlparse

from .. import catalog, logredact, store
from ..http import brief_error
from ..services import news as news_service

from .base import EmptyResult, previous_payload

logger = logging.getLogger(__name__)

# 보관 일수(명세 B2). 백엔드 창은 결정 시각 직전 24시간이라 최근 기준일에는 넉넉하고, 같은 제목 중복 제거도 이 기간 안에서 봅니다.
RETENTION_DAYS = 7

# 발행 시각이 이만큼 넘게 미래면 건너뜁니다(모듈 설명 '중복·보관').
FUTURE_TOLERANCE = timedelta(days=1)

# 새 피드를 더 시작하지 않는 경과 시간(초). slow 상한(runner.TASK_DEADLINE_SECONDS["slow"] = 600초)을 넘기면 '시간 초과'로 끝나
# 받은 피드도 저장하지 못하므로 상한 전에 멈춥니다. 남는 300초는 진행 중인 요청 하나(SEC 세션 재시도 5회 × 읽기 대기 20초 + 백오프)와
# 저장의 여유입니다. 정상이면 피드 8개에 3~7초.
TIME_LIMIT_SECONDS = 300.0

# 같은 호스트(인베스팅닷컴 넷, BLS 둘)에 잇달아 보낼 때 사이 간격(초). 단계 0과 같은 0.6초 — 몰아 보내지 않습니다.
HOST_SPACING_SECONDS = 0.6


def task_news_headlines() -> str:
    """사건 뉴스 RSS 7개 → observations ``news_headline`` + 상태 ``news.headlines.status``."""
    now = _now()
    stamp = now.isoformat(timespec="seconds")
    cutoff = now.date() - timedelta(days=RETENTION_DAYS)
    previous = previous_payload(catalog.SNAP_NEWS_STATUS)
    prev_feeds = previous.get("feeds") if isinstance(previous.get("feeds"), dict) else {}

    parsed, failed = _fetch_all()
    if not parsed:
        raise EmptyResult(f"피드 0/{len(news_service.FEEDS)} — 기존 저장본 유지" + _failed_suffix(failed))

    # 보관 기간 안에 이미 있는 제목 — 날짜를 가리지 않는 중복 제거와 '누락 가능' 판단에 씁니다(이번 실행 전 상태).
    existing = store.observation_entities_since(catalog.OBS_NEWS_HEADLINE, cutoff.isoformat())
    # 이번 실행에 넣을 행의 payload(entity → payload) — 같은 실행의 다른 피드가 같은 제목을 실으면 그 payload의 feeds에 더합니다.
    taken: dict[str, dict] = {}
    # 전 실행에 넣은 제목을 이번에 받은 피드 — 넣은 뒤 그 행의 feeds에 더합니다(모듈 설명 '중복·보관').
    carried: list[tuple[str, str]] = []
    rows: list[tuple] = []
    feeds: dict[str, dict] = {}
    maybe_missed: list[str] = []
    skipped = Counter()

    for feed in news_service.FEEDS:
        before = prev_feeds.get(feed.key) if isinstance(prev_feeds.get(feed.key), dict) else {}
        if feed.key in failed:
            feeds[feed.key] = {"source": feed.source, "url": feed.url, "status": "실패", "error": failed[feed.key],
                               "lastOkAt": before.get("lastOkAt")}
            continue
        result = parsed[feed.key]
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
        feeds[feed.key] = {
            "source": feed.source,
            "url": feed.url,
            "status": "ok",
            "entries": result.entries,
            "new": counts["new"],
            "seen": counts["seen"],
            "skippedOld": counts["old"],
            "skippedFuture": counts["future"],
            "skippedNoTime": result.no_time,
            "skippedNoTitle": result.no_title,
            "newestAt": newest.isoformat(timespec="seconds") if newest else None,
            "lastOkAt": stamp,
        }

    store.insert_new_observations(catalog.OBS_NEWS_HEADLINE, rows)
    store.add_headline_feeds(catalog.OBS_NEWS_HEADLINE, cutoff.isoformat(), carried)
    deleted = store.delete_observations_before(catalog.OBS_NEWS_HEADLINE, cutoff.isoformat())
    stored = len(existing | taken.keys())

    failed_feeds = [{"feed": feed.key, "source": feed.source, "reason": failed[feed.key]}
                    for feed in news_service.FEEDS if feed.key in failed]
    store.put_snapshot(catalog.SNAP_NEWS_STATUS, {
        "generatedAt": stamp,
        "source": news_service.SOURCE_NOTE,
        "retentionDays": RETENTION_DAYS,
        "retainedFrom": cutoff.isoformat(),
        "stored7d": stored,
        "insertedThisRun": len(rows),
        "deletedThisRun": deleted,
        "feedsOk": len(parsed),
        "feedsTotal": len(news_service.FEEDS),
        "failedFeeds": failed_feeds,
        "maybeMissed": maybe_missed,
        "feeds": feeds,
    })

    detail = (f"새 헤드라인 {len(rows)}건 · 피드 {len(parsed)}/{len(news_service.FEEDS)} · "
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
    return detail + _failed_suffix(failed)


def _fetch_all() -> tuple[dict[str, news_service.ParsedFeed], dict[str, str]]:
    """피드를 FEEDS 순서로 하나씩 받습니다. (키 → 읽은 결과, 키 → 실패 사유). 한 피드의 실패는 다음 피드를 멈추지 않습니다."""
    started = _clock()
    parsed: dict[str, news_service.ParsedFeed] = {}
    failed: dict[str, str] = {}
    last_host: str | None = None
    for index, feed in enumerate(news_service.FEEDS):
        host = urlparse(feed.url).hostname
        if host == last_host:
            _sleep(HOST_SPACING_SECONDS)
        # 간격을 쉰 뒤에 잽니다 — 쉬는 동안 상한을 넘었으면 새 요청을 보내지 않습니다.
        if _clock() - started > TIME_LIMIT_SECONDS:
            for rest in news_service.FEEDS[index:]:
                failed[rest.key] = f"시간 상한({TIME_LIMIT_SECONDS:.0f}초) — 다음 실행"
            break
        last_host = host
        try:
            content, content_type = news_service.fetch_feed(feed)
            parsed[feed.key] = news_service.parse_feed(content, content_type)
        except (news_service.FeedFetchError, news_service.FeedShapeError) as exc:
            failed[feed.key] = str(exc)
        except Exception as exc:  # noqa: BLE001 — feedparser 내부 오류 같은 예기치 못한 것도 그 피드만의 실패입니다
            failed[feed.key] = logredact.redact(brief_error(exc))
        if feed.key in failed:
            logger.warning("사건 뉴스 피드 실패 (%s): %s", feed.key, failed[feed.key])
    return parsed, failed


def _failed_suffix(failed: dict[str, str]) -> str:
    """실패한 피드를 모두 사유와 함께 적습니다(피드는 7개뿐이라 _reason_suffix처럼 두 개로 자르지 않음)."""
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
