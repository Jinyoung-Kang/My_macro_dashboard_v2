"""
app/tasks/kr_news.py
slow 그룹 — 🧪 모의 매매 한국 책 Claude 계좌 패킷 ``11b_events``의 한국 사건 헤드라인(v2 2단계 명세 §4-11·K21·B9).

미국 ``news_headlines``(tasks/news.py)와 같은 규칙으로 받아 저장만 하고, 따로 된 데이터셋에 씁니다 — 같은 ``news_headline``에 섞으면 한국
행의 받은 시각이 미국 패킷의 '수집 공백(STALE)' 판정을 가리고, 백엔드 설정 ``news.feeds``·``NewsFeedsParityTest``는 미국 여덟 피드가
전제입니다. 거르기(종목 이름·한글 조사·별칭·키워드)·창·하루 상한은 백엔드(E1)가 이 저장본을 읽어 합니다(ADR 0008). 피드 표는
``services.news.KR_FEEDS``.

[저장]
  observations ``kr_news_headline`` : entity = 정규화한 제목의 해시(services.news.title_entity), obs_date = 발행 KST 날짜,
      payload {title, link, source, feed, feeds, publishedAt, publishedDate, timePrecision, knownAt, fetchedAt}.
      publishedAt = 원문 발행 시각(ISO UTC, 날짜만 있는 피드는 null) · publishedDate = KST 날짜 · timePrecision = second|minute|date ·
      knownAt = '알 수 있는 시각'(아래, ISO UTC) · fetchedAt = 처음 받은 시각(ISO UTC). feed·source·link는 처음 실어 온 피드의 것.
  스냅샷 ``kr.news.headlines.status`` : 미국 news.headlines.status와 같은 칸 + 피드별 timeFormat·skippedBadTime.

[알 수 있는 시각 — 명세 §4-11]
  시각이 있는 항목은 발행 시각 그대로입니다. 날짜만 있는 항목(재정경제부)은 min(처음 받은 시각, 그 KST 날짜 다음 자정)입니다 — 실제
  게시 시각은 그 날짜 안 어딘가이고 처음 받은 시각보다 늦을 수 없으므로 이 값은 실제 게시보다 앞서지 않아 룩어헤드가 없습니다.
  처음 받을 때 정해 payload에 남기므로(같은 제목은 다시 넣지 않음) 저장본만으로 결정적입니다. 백엔드 창은 이 값을 씁니다.

[중복·보관 — 미국과 같음, 날짜만 KST]
  - 보관 7일: 오늘(KST) − 7일보다 앞 날짜(obs_date)의 행을 실행마다 지우고, 그보다 오래된 항목은 넣지 않습니다(한국은행·재정경제부는
    몇 주~몇 달 치를 줌).
  - 같은 제목은 보관 기간 안이면 날짜가 달라도 다시 넣지 않고, 실어 온 피드는 모두 ``feeds``에 남깁니다(store.add_headline_feeds).
  - 발행 시각(날짜만이면 그 날짜)이 지금보다 하루 넘게 뒤면 건너뜁니다. 시각이 없거나 형식이 다른 항목은 건너뛰고 셉니다.

[실패 규칙 — 수집기 공통, 미국과 같음]
  피드 하나의 실패는 나머지를 멈추지 않고, 전부 실패하면 EmptyResult(행·상태 그대로). 헤드라인은 쌓기만 해 '이전 값 이어받기'가
  없고, 상태의 피드 줄은 마지막 성공 시각(lastOkAt)을 잇습니다. 받은 항목이 모두 처음 보는 것이면 '누락 가능'(maybeMissed).
"""
from __future__ import annotations

import logging
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from datetime import time as clock_time
from urllib.parse import urlparse

from .. import catalog, logredact, store
from ..http import brief_error
from ..services import news as news_service

from .base import KST, EmptyResult, previous_payload

logger = logging.getLogger(__name__)

# 보관 일수 — 미국 news_headlines와 같은 7일(명세 §4-15). 날짜는 KST입니다.
RETENTION_DAYS = 7

# 발행 시각이 이만큼 넘게 미래면 건너뜁니다(모듈 설명 '중복·보관').
FUTURE_TOLERANCE = timedelta(days=1)

# 새 피드를 더 시작하지 않는 경과 시간(초) — 미국 news_headlines와 같은 값(slow 상한 600초의 절반, 남는 시간은 진행 중인 요청과 저장).
# 정상이면 피드 4개에 2~5초(한국은행 피드는 200~460KB).
TIME_LIMIT_SECONDS = 300.0

# 같은 호스트에 잇달아 보낼 때 사이 간격(초). 지금 네 피드는 호스트가 모두 달라 쉬지 않습니다(피드를 더할 때를 위한 자리).
HOST_SPACING_SECONDS = 0.6


def known_at(published_at: datetime | None, published_date: date, fetched_at: datetime) -> datetime:
    """
    '알 수 있는 시각'(UTC) — 시각이 있으면 발행 시각, 날짜만이면 min(처음 받은 시각, 그 KST 날짜 다음 자정)(모듈 설명).

    :param fetched_at: 처음 받은 시각(UTC)
    """
    if published_at is not None:
        return published_at
    next_midnight = datetime.combine(published_date + timedelta(days=1), clock_time(0), tzinfo=KST)
    return min(fetched_at, next_midnight.astimezone(timezone.utc))


def task_kr_news_headlines() -> str:
    """한국 사건 뉴스 RSS 4개 → observations ``kr_news_headline`` + 상태 ``kr.news.headlines.status``."""
    feeds_table = news_service.KR_FEEDS
    now = _now()
    stamp = now.isoformat(timespec="seconds")
    cutoff = now.astimezone(KST).date() - timedelta(days=RETENTION_DAYS)
    latest_day = (now + FUTURE_TOLERANCE).astimezone(KST).date()
    previous = previous_payload(catalog.SNAP_KR_NEWS_STATUS)
    prev_feeds = previous.get("feeds") if isinstance(previous.get("feeds"), dict) else {}

    parsed, failed = _fetch_all(feeds_table)
    if not parsed:
        raise EmptyResult(f"피드 0/{len(feeds_table)} — 기존 저장본 유지" + _failed_suffix(failed))

    existing = store.observation_entities_since(catalog.OBS_KR_NEWS_HEADLINE, cutoff.isoformat())
    taken: dict[str, dict] = {}
    carried: list[tuple[str, str]] = []
    rows: list[tuple] = []
    feeds: dict[str, dict] = {}
    maybe_missed: list[str] = []
    skipped = Counter()

    for feed in feeds_table:
        before = prev_feeds.get(feed.key) if isinstance(prev_feeds.get(feed.key), dict) else {}
        if feed.key in failed:
            feeds[feed.key] = {"source": feed.source, "url": feed.url, "timeFormat": feed.time_format, "status": "실패",
                               "error": failed[feed.key], "lastOkAt": before.get("lastOkAt")}
            continue
        result = parsed[feed.key]
        counts = Counter()
        newest: datetime | None = None
        overlap = 0
        for item in result.items:
            published: datetime | None = item["publishedAt"]
            day: date = item["publishedDate"]
            if (published > now + FUTURE_TOLERANCE) if published is not None else (day > latest_day):
                counts["future"] += 1
                continue
            if day < cutoff:
                counts["old"] += 1
                continue
            known = known_at(published, day, now)
            newest = known if newest is None or known > newest else newest
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
                "publishedAt": published.isoformat(timespec="seconds") if published is not None else None,
                "publishedDate": day.isoformat(),
                "timePrecision": item["precision"],
                "knownAt": known.isoformat(timespec="seconds"),
                "fetchedAt": stamp,
            }
            taken[entity] = payload
            rows.append((day, entity, payload))
            counts["new"] += 1
        if before.get("lastOkAt") and not counts["old"] and not counts["future"] and not overlap:
            maybe_missed.append(feed.key)
        skipped["noTime"] += result.no_time
        skipped["badTime"] += result.bad_time
        skipped["noTitle"] += result.no_title
        skipped["future"] += counts["future"]
        feeds[feed.key] = {
            "source": feed.source,
            "url": feed.url,
            "timeFormat": feed.time_format,
            "status": "ok",
            "entries": result.entries,
            "new": counts["new"],
            "seen": counts["seen"],
            "skippedOld": counts["old"],
            "skippedFuture": counts["future"],
            "skippedNoTime": result.no_time,
            "skippedBadTime": result.bad_time,
            "skippedNoTitle": result.no_title,
            "newestAt": newest.isoformat(timespec="seconds") if newest else None,
            "lastOkAt": stamp,
        }

    store.insert_new_observations(catalog.OBS_KR_NEWS_HEADLINE, rows)
    store.add_headline_feeds(catalog.OBS_KR_NEWS_HEADLINE, cutoff.isoformat(), carried)
    deleted = store.delete_observations_before(catalog.OBS_KR_NEWS_HEADLINE, cutoff.isoformat())
    stored = len(existing | taken.keys())

    failed_feeds = [{"feed": feed.key, "source": feed.source, "reason": failed[feed.key]}
                    for feed in feeds_table if feed.key in failed]
    store.put_snapshot(catalog.SNAP_KR_NEWS_STATUS, {
        "generatedAt": stamp,
        "source": news_service.KR_SOURCE_NOTE,
        "timeZone": "Asia/Seoul",
        "retentionDays": RETENTION_DAYS,
        "retainedFrom": cutoff.isoformat(),
        "stored7d": stored,
        "insertedThisRun": len(rows),
        "deletedThisRun": deleted,
        "feedsOk": len(parsed),
        "feedsTotal": len(feeds_table),
        "failedFeeds": failed_feeds,
        "maybeMissed": maybe_missed,
        "feeds": feeds,
    })

    detail = f"새 헤드라인 {len(rows)}건 · 피드 {len(parsed)}/{len(feeds_table)} · {RETENTION_DAYS}일 보관 {stored}건"
    if deleted:
        detail += f"(지움 {deleted}건)"
    if skipped["noTime"]:
        detail += f" · 시각 없음 {skipped['noTime']}건 건너뜀"
    if skipped["badTime"]:
        detail += f" · 시각 형식 다름 {skipped['badTime']}건 건너뜀"
    if skipped["noTitle"]:
        detail += f" · 제목 없음 {skipped['noTitle']}건 건너뜀"
    if skipped["future"]:
        detail += f" · 미래 시각 {skipped['future']}건 건너뜀"
    if maybe_missed:
        detail += f" · 누락 가능: {', '.join(maybe_missed)}(받은 항목이 모두 처음 봄 — 지난 수집 뒤 더 많이 나왔을 수 있음)"
    return detail + _failed_suffix(failed)


def _fetch_all(feeds_table) -> tuple[dict[str, news_service.ParsedFeed], dict[str, str]]:
    """피드를 표 순서로 하나씩 받습니다. (키 → 읽은 결과, 키 → 실패 사유). 한 피드의 실패는 다음 피드를 멈추지 않습니다."""
    started = _clock()
    parsed: dict[str, news_service.ParsedFeed] = {}
    failed: dict[str, str] = {}
    last_host: str | None = None
    for index, feed in enumerate(feeds_table):
        host = urlparse(feed.url).hostname
        if host == last_host:
            _sleep(HOST_SPACING_SECONDS)
        if _clock() - started > TIME_LIMIT_SECONDS:
            for rest in feeds_table[index:]:
                failed[rest.key] = f"시간 상한({TIME_LIMIT_SECONDS:.0f}초) — 다음 실행"
            break
        last_host = host
        try:
            content, content_type = news_service.fetch_feed(feed)
            parsed[feed.key] = news_service.parse_feed(content, content_type, feed=feed)
        except (news_service.FeedFetchError, news_service.FeedShapeError) as exc:
            failed[feed.key] = str(exc)
        except Exception as exc:  # noqa: BLE001 — feedparser 내부 오류 같은 예기치 못한 것도 그 피드만의 실패입니다
            failed[feed.key] = logredact.redact(brief_error(exc))
        if feed.key in failed:
            logger.warning("한국 사건 뉴스 피드 실패 (%s): %s", feed.key, failed[feed.key])
    return parsed, failed


def _failed_suffix(failed: dict[str, str]) -> str:
    if not failed:
        return ""
    return f" · 실패 {len(failed)}개: " + "; ".join(f"{key}({reason})" for key, reason in failed.items())


# ==============================================================================
# 작은 도구 — 테스트가 바꿔 끼우는 자리
# ==============================================================================
def _now() -> datetime:
    """지금 시각(UTC). 보관 기한·obs_date는 KST 날짜로 바꿔 씁니다(서버 TZ와 무관)."""
    return datetime.now(timezone.utc)


def _clock() -> float:
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)
