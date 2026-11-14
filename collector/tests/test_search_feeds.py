"""
tests/test_search_feeds.py
정보 검색의 새 피드 묶음(ADR 0041 결정 8, 계약 §6-1 — services/search_feeds·tasks/search_feeds).

고정하는 규칙
  1. 피드 표: 12개(FXStreet 없음), 키·주소가 사건 뉴스(services.news의 FEEDS·KR_FEEDS — 모의 매매 패킷의 입력)와 겹치지 않고, 데이터셋·상태 저장본
     이름도 사건 뉴스와 다르다. 사건 뉴스의 간격 표(news_feeds.CADENCES)에 들어가지 않는다. 간격은 ADR 0041 결정 8의 표, 하한 10분.
  2. 읽기: 요약은 피드의 description·summary만 300자 — 본문 칸(content:encoded)은 쓰지 않는다. 시각이 없는 글도 남긴다(처음 받은 시각).
  3. 받기(사건 뉴스와 같은 flex 규칙): 처음엔 받지 않고 2~25분 안에서 흩어 정함, 때가 된 피드만, 조건부 요청(304), 거부되면 간격 두 배(최대 8배)·
     같은 호스트의 다른 피드는 미룸, 같은 호스트는 차례로 2~5초.
  4. 저장: search_feed_headline에만(사건 뉴스 데이터셋에 쓰지 않음) — entity = 같은 글 키, payload 모양, 90일 밖·중국어 제목은 넣지 않음, 이미 있는
     글은 다시 넣지 않음, 90일 지난 행은 지움, 상태 저장본 search.feeds.status.
  5. 정보 검색이 읽는 저장본(search_store.feed_bundle·recent_bundle).

외부 네트워크를 쓰지 않습니다 — 가짜 세션이 합성 피드(구조만 흉내 낸 글)를 돌려줍니다. 태스크 시험은 PostgreSQL이 필요합니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import requests

from app import catalog, http, tasks
from app.services import info_text
from app.services import news
from app.services import search_feeds as svc
from app.services import search_rules as rules
from app.services import search_store
from app.tasks import flex, news_feeds
from app.tasks import search_feeds as task
from app.tasks.base import EmptyResult

NOW = datetime(2026, 11, 14, 3, 0, tzinfo=timezone.utc)      # KST 11-14(토) 12:00
URL = {feed.key: feed.url for feed in svc.SEARCH_FEEDS}


def _rss(items: list[dict]) -> bytes:
    body = []
    for item in items:
        parts = [f"<title>{item['title']}</title>"]
        if item.get("link"):
            parts.append(f"<link>{item['link']}</link>")
        if item.get("description") is not None:
            parts.append(f"<description><![CDATA[{item['description']}]]></description>")
        if item.get("content") is not None:
            parts.append(f"<content:encoded><![CDATA[{item['content']}]]></content:encoded>")
        if item.get("date"):
            parts.append(f"<pubDate>{item['date']}</pubDate>")
        body.append("<item>" + "".join(parts) + "</item>")
    return ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">'
            "<channel><title>Synthetic</title><link>https://www.example.org/</link><description>d</description>"
            + "".join(body) + "</channel></rss>").encode("utf-8")


def _rdf(items: list[dict]) -> bytes:
    body = "".join(f'<item rdf:about="{item["link"]}"><title>{item["title"]}</title><link>{item["link"]}</link></item>'
                   for item in items)
    return ('<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
            'xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://asia.example.org/"><title>Synthetic Asia</title>'
            '<link>https://asia.example.org/</link><description>d</description></channel>' + body + "</rdf:RDF>").encode("utf-8")


BLOOMBERG = _rss([
    {"title": "Synthetic stocks rally on rate hopes", "link": "https://www.bloomberg.com/news/articles/s1",
     "description": "Markets rose as traders bet on cuts.", "date": "Fri, 13 Nov 2026 21:00:00 GMT"},
    {"title": "Synthetic bond yields slip", "link": "https://www.bloomberg.com/news/articles/s2",
     "description": "Treasuries gained.", "content": "<p>FULL BODY TEXT THAT MUST NOT BE STORED</p>",
     "date": "Fri, 13 Nov 2026 20:00:00 GMT"},
    {"title": "合成芯片发布新一代加速器", "link": "https://www.bloomberg.com/news/articles/s3", "date": "Fri, 13 Nov 2026 19:00:00 GMT"},
    {"title": "Synthetic story from the summer", "link": "https://www.bloomberg.com/news/articles/s4",
     "date": "Wed, 01 Jul 2026 10:00:00 GMT"},
    {"title": "Synthetic story from next week", "link": "https://www.bloomberg.com/news/articles/s5",
     "date": "Mon, 23 Nov 2026 10:00:00 GMT"},
])
NIKKEI = _rdf([
    {"title": "Synthetic Asia markets open higher", "link": "https://asia.nikkei.com/s/a1"},
    {"title": "Synthetic chipmaker expands in Japan", "link": "https://asia.nikkei.com/s/a2"},
])
GENERIC = _rss([{"title": "Synthetic generic headline", "link": "https://www.example.org/generic",
                 "description": "Generic summary.", "date": "Fri, 13 Nov 2026 10:00:00 GMT"}])
ETAG_FEEDS = {"bloomberg_markets", "cnbc_finance", "cnbc_world"}


class _Response:
    def __init__(self, status: int, content: bytes = b"", headers: dict | None = None):
        self.status_code = status
        self._content = content
        self.headers = {"Content-Type": "application/rss+xml", **(headers or {})}

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self._content), chunk_size):
            yield self._content[i:i + chunk_size]

    def close(self):
        pass


class FakeWeb:
    """피드마다 합성 본문을 주는 가짜 세션 — ETAG_FEEDS는 ETag를 싣고 같은 ETag가 오면 304. ``override``에 URL → 예외·(상태, 본문)."""

    def __init__(self):
        self.bodies = {url: GENERIC for url in URL.values()}
        self.bodies[URL["bloomberg_markets"]] = BLOOMBERG
        self.bodies[URL["nikkei_asia"]] = NIKKEI
        self.override: dict = {}
        self.calls: list[tuple[str, dict]] = []
        self.clock = {"now": NOW, "mono": 0.0}
        self.sleeps: list[float] = []

    def key(self, url: str) -> str:
        return next(k for k, u in URL.items() if u == url)

    def session(self):
        web = self

        class _Session:
            def get(self, url, timeout=None, stream=False, headers=None):
                web.calls.append((url, dict(headers or {})))
                outcome = web.override.get(url)
                if isinstance(outcome, BaseException):
                    raise outcome
                if outcome is not None:
                    return _Response(*outcome)
                etag = f'"{len(web.bodies[url])}"' if web.key(url) in ETAG_FEEDS else None
                if etag and (headers or {}).get("If-None-Match") == etag:
                    return _Response(304, b"", {"ETag": etag})
                return _Response(200, web.bodies[url], {"ETag": etag} if etag else {})

        return _Session()

    def requested(self) -> list[str]:
        return [self.key(url) for url, _ in self.calls]


@pytest.fixture()
def web(monkeypatch):
    fake = FakeWeb()
    monkeypatch.setattr(news, "get_session", lambda: fake.session())
    monkeypatch.setattr(task, "_now", lambda: fake.clock["now"])
    monkeypatch.setattr(task, "_clock", lambda: fake.clock["mono"])
    monkeypatch.setattr(task, "_sleep", lambda seconds: fake.sleeps.append(seconds))
    monkeypatch.setattr(flex, "_utcnow", lambda: fake.clock["now"])

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return fake


def _only_due(keys, now: datetime) -> None:
    for feed in svc.SEARCH_FEEDS:
        flex.set_due(task.TASK_NAME, feed.key, now + timedelta(days=2))
    for key in keys:
        flex.set_due(task.TASK_NAME, key, now - timedelta(seconds=1))


def _rows(store) -> dict:
    with store.connection() as conn:
        found = conn.execute("SELECT obs_date, entity, payload FROM observations WHERE dataset = %s",
                             (catalog.OBS_SEARCH_FEED_HEADLINE,)).fetchall()
    return {row["entity"]: dict(row["payload"], obsDate=row["obs_date"].isoformat()) for row in found}


def _status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_SEARCH_FEEDS_STATUS).payload


class _Edge:
    def __init__(self, upper: bool):
        self.upper = upper

    def uniform(self, a, b):
        return b if self.upper else a


# ==============================================================================
# 1. 피드 표 — 사건 뉴스와 따로 (DB·네트워크 없음)
# ==============================================================================
def test_피드_표는_12개이고_사건_뉴스의_키·주소·데이터셋과_겹치지_않는다():
    keys = svc.SEARCH_FEED_KEYS
    assert len(svc.SEARCH_FEEDS) == 12 and len(set(keys)) == 12
    assert not set(keys) & (set(news.FEED_KEYS) | set(news.KR_FEED_KEYS))
    event_urls = {feed.url for feed in (*news.FEEDS, *news.KR_FEEDS)}
    assert not {feed.url for feed in svc.SEARCH_FEEDS} & event_urls
    assert not set(keys) & set(news_feeds.CADENCES), "사건 뉴스의 간격 표에 넣지 않음(그 표는 FEEDS ∪ KR_FEEDS만)"
    assert all("fxstreet" not in feed.url for feed in svc.SEARCH_FEEDS), "FXStreet는 서버 IP에서 403이라 뺌(D-11)"
    assert all(isinstance(feed, news.Feed) and feed.session == "default" and feed.url.startswith("https://")
               for feed in svc.SEARCH_FEEDS)
    assert catalog.OBS_SEARCH_FEED_HEADLINE == "search_feed_headline"
    assert catalog.OBS_SEARCH_FEED_HEADLINE not in (catalog.OBS_NEWS_HEADLINE, catalog.OBS_KR_NEWS_HEADLINE)
    assert catalog.SNAP_SEARCH_FEEDS_STATUS == "search.feeds.status"
    assert catalog.SNAP_SEARCH_FEEDS_STATUS not in (catalog.SNAP_NEWS_STATUS, catalog.SNAP_KR_NEWS_STATUS)


def test_간격은_ADR_0041_결정_8의_표이고_하한_10분():
    expected = {
        "fed_press_all": (120, 240), "ecb_press": (120, 240), "boe_news": (120, 240), "bbc_business": (90, 180),
        "economist_finance": (180, 360), "bloomberg_markets": (60, 120), "cnbc_finance": (60, 120), "cnbc_world": (90, 180),
        "nikkei_asia": (60, 120), "marketwatch_top": (45, 90), "benzinga": (45, 90), "seekingalpha_currents": (30, 60),
    }
    assert {feed.key: feed.minutes for feed in svc.SEARCH_FEEDS} == expected
    assert all(feed.minutes[0] >= task.FLOOR_MINUTES == 10.0 for feed in svc.SEARCH_FEEDS)
    assert (task.FIRST_MINUTES, task.HOST_SPACING_SECONDS, task.BACKOFF_MAX_LEVEL) == ((2.0, 25.0), (2.0, 5.0), 3)
    assert task.RETENTION_DAYS == 90


def test_같은_호스트의_CNBC_두_피드는_표에서_붙어_있다():
    hosts = [feed.url.split("/")[2] for feed in svc.SEARCH_FEEDS]
    index = hosts.index("search.cnbc.com")
    assert hosts.count("search.cnbc.com") == 2 and hosts[index + 1] == "search.cnbc.com"


def test_태스크는_flex로_등록되고_due가_있다():
    registered = tasks.TASKS_BY_NAME["search_feeds"]
    assert registered.speed == flex.SPEED and registered.run is task.task_search_feeds and registered.due is task.due


# ==============================================================================
# 2. 읽기 — 요약은 description·summary만, 시각 없는 글도 남김
# ==============================================================================
def test_요약은_description만_300자이고_본문_칸은_쓰지_않는다():
    long_teaser = "word " * 120
    content = _rss([
        {"title": "Teaser and body", "link": "https://www.example.org/1", "description": "<p>Short <b>teaser</b></p>",
         "content": "<p>BODY ONE</p>", "date": "Fri, 13 Nov 2026 10:00:00 GMT"},
        {"title": "Body only", "link": "https://www.example.org/2", "content": "<p>BODY TWO</p>",
         "date": "Fri, 13 Nov 2026 10:00:00 GMT"},
        {"title": "Long teaser", "link": "https://www.example.org/3", "description": long_teaser},
        {"title": "Same as title", "link": "javascript:alert(1)", "description": "Same as title"},
    ])
    parsed = svc.parse(content, "application/rss+xml")
    by_title = {item["title"]: item for item in parsed.items}
    assert by_title["Teaser and body"]["summary"] == "Short teaser"
    assert by_title["Body only"]["summary"] is None, "description이 없으면 본문 칸을 요약으로 쓰지 않음"
    long_summary = by_title["Long teaser"]["summary"]
    assert len(long_summary) == svc.SUMMARY_MAX_CHARS == 300 and long_summary.endswith("…")
    assert by_title["Long teaser"]["publishedAt"] is None and parsed.no_time == 2
    assert by_title["Same as title"]["summary"] is None and by_title["Same as title"]["url"] is None
    assert by_title["Teaser and body"]["publishedAt"] == datetime(2026, 11, 13, 10, tzinfo=timezone.utc)
    assert all("BODY" not in (item["summary"] or "") for item in parsed.items)


def test_시각_칸이_없는_RDF도_읽고_피드가_아니면_형식_오류():
    parsed = svc.parse(NIKKEI, None)
    assert [item["title"] for item in parsed.items] == ["Synthetic Asia markets open higher", "Synthetic chipmaker expands in Japan"]
    assert all(item["publishedAt"] is None for item in parsed.items) and parsed.no_time == 2
    with pytest.raises(news.FeedShapeError):
        svc.parse(b"<html><body>Access denied</body></html>", "text/html")
    with pytest.raises(news.FeedShapeError):
        svc.parse(_rss([{"title": " ", "link": "https://www.example.org/x"}]), None)


# ==============================================================================
# 3. 간격 — 다음 시각·하한 (DB·네트워크 없음)
# ==============================================================================
@pytest.mark.parametrize("upper", [False, True])
def test_다음_시각은_피드_구간_안이고_물러나면_두_배씩(monkeypatch, upper):
    monkeypatch.setattr(task, "_rng", _Edge(upper))
    feed = svc.FEEDS_BY_KEY["seekingalpha_currents"]
    pick = 60.0 if upper else 30.0
    assert task.draw_next(feed, NOW) == NOW + timedelta(minutes=pick)
    assert task.draw_next(feed, NOW, level=3) == NOW + timedelta(minutes=pick * 8)
    assert task.draw_next(feed, NOW, retry_after=6 * 3600) == max(NOW + timedelta(minutes=pick), NOW + timedelta(hours=6))
    assert task.draw_next(feed, NOW, retry_after=10 * 86400) <= NOW + timedelta(days=1), "서버 지시는 하루까지만"


def test_하한은_마지막_요청_뒤_10분과_max_age_가운데_늦은_것():
    last = "2026-11-14T02:55:00+00:00"
    assert task.hold_until({"lastRequestAt": last}) == datetime(2026, 11, 14, 3, 5, tzinfo=timezone.utc)
    assert task.hold_until({"lastRequestAt": last, "freshUntil": "2026-11-14T04:00:00+00:00"}) == datetime(2026, 11, 14, 4,
                                                                                                         tzinfo=timezone.utc)
    assert task.hold_until({}) is None


# ==============================================================================
# 3·4. 태스크 (PostgreSQL)
# ==============================================================================
def test_처음에는_받지_않고_2_25분_안에서_흩어_정한다(store, web):
    assert task.due() is True
    with pytest.raises(EmptyResult, match="피드 일정 처음 정함 12개 — 정한 직후에는 받지 않음"):
        task.task_search_feeds()
    assert web.calls == []
    schedule = flex.due_map(task.TASK_NAME)
    assert set(schedule) == set(svc.SEARCH_FEED_KEYS)
    assert all(timedelta(minutes=2) <= when - NOW <= timedelta(minutes=25) for when in schedule.values())
    assert store.read_snapshot(catalog.SNAP_SEARCH_FEEDS_STATUS) is None
    assert task.due() is False


def test_때가_된_피드만_받아_새_데이터셋에만_넣는다(store, web):
    _only_due(["bloomberg_markets", "nikkei_asia"], NOW)

    detail = task.task_search_feeds()

    assert web.requested() == ["bloomberg_markets", "nikkei_asia"]
    assert detail.startswith("새 글 4건 · 받은 피드 2/2(새 본문 2) · 90일 보관 4건")
    assert "중국어 제목 1건 뺌" in detail and "미래 시각 1건 건너뜀" in detail
    rows = _rows(store)
    first = rows[info_text.item_id("https://www.bloomberg.com/news/articles/s1")]
    assert first == {
        "title": "Synthetic stocks rally on rate hopes", "summary": "Markets rose as traders bet on cuts.",
        "url": "https://www.bloomberg.com/news/articles/s1", "publisher": "Bloomberg", "publisherDomain": "bloomberg.com",
        "feed": "bloomberg_markets", "publishedAt": "2026-11-13T21:00:00+00:00", "fetchedAt": "2026-11-14T03:00:00+00:00",
        "timeBasis": "published", "lang": "en", "obsDate": "2026-11-13",
    }
    assert rows[info_text.item_id("https://www.bloomberg.com/news/articles/s2")]["summary"] == "Treasuries gained."
    nikkei = rows[info_text.item_id("https://asia.nikkei.com/s/a1")]
    assert nikkei["publishedAt"] is None and nikkei["timeBasis"] == "fetched" and nikkei["fetchedAt"] == "2026-11-14T03:00:00+00:00"
    assert nikkei["obsDate"] == "2026-11-14" and nikkei["publisher"] == "Nikkei Asia"
    titles = {row["title"] for row in rows.values()}
    assert "Synthetic story from the summer" not in titles, "90일 밖은 넣지 않음"
    assert not any(rules.is_chinese_title(title) for title in titles)
    with store.connection() as conn:
        others = conn.execute("SELECT count(*) AS n FROM observations WHERE dataset = ANY(%s)",
                              ([catalog.OBS_NEWS_HEADLINE, catalog.OBS_KR_NEWS_HEADLINE],)).fetchone()["n"]
    assert others == 0, "사건 뉴스 데이터셋(모의 매매 패킷의 입력)에는 쓰지 않음"
    assert store.read_snapshot(catalog.SNAP_NEWS_STATUS) is None and store.read_snapshot(catalog.SNAP_KR_NEWS_STATUS) is None

    status = _status(store)
    assert (status["feedsOk"], status["feedsTotal"], status["stored"], status["insertedThisRun"]) == (2, 12, 4, 4)
    assert status["retentionDays"] == 90 and status["retainedFrom"] == "2026-08-16"
    bloomberg = status["feeds"]["bloomberg_markets"]
    assert bloomberg["status"] == "ok" and bloomberg["new"] == 2 and bloomberg["skippedOld"] == 1
    assert bloomberg["skippedChinese"] == 1 and bloomberg["skippedFuture"] == 1 and bloomberg["etag"]
    assert status["feeds"]["nikkei_asia"]["noTime"] == 2
    schedule = flex.due_map(task.TASK_NAME)
    assert timedelta(minutes=60) <= schedule["bloomberg_markets"] - NOW <= timedelta(minutes=120)


def test_다시_받으면_조건부_요청이고_이미_있는_글은_넣지_않는다(store, web):
    due = ["bloomberg_markets", "cnbc_finance", "nikkei_asia"]
    _only_due(due, NOW)
    task.task_search_feeds()
    before = _rows(store)

    web.clock["now"] = NOW + timedelta(hours=3)
    _only_due(due, web.clock["now"])
    detail = task.task_search_feeds()

    cnbc = [headers for url, headers in web.calls if url == URL["cnbc_finance"]]
    assert "If-None-Match" not in cnbc[0] and cnbc[1]["If-None-Match"] == f'"{len(GENERIC)}"'
    bloomberg = [headers for url, headers in web.calls if url == URL["bloomberg_markets"]]
    assert "If-None-Match" not in bloomberg[1], "미래 시각으로 미룬 글이 있으면 조건 없이 다시 읽음(사건 뉴스와 같음)"
    assert detail.startswith("새 글 0건")
    after = _rows(store)
    assert after == before, "Nikkei 글(시각 없음)도 처음 받은 시각 그대로 — 다시 넣지 않음"
    status = _status(store)
    assert status["feeds"]["cnbc_finance"]["lastResult"] == news_feeds.RESULT_NOT_MODIFIED
    assert status["feeds"]["bloomberg_markets"]["lastResult"] == news_feeds.RESULT_CHANGED
    assert status["feeds"]["nikkei_asia"]["lastResult"] == news_feeds.RESULT_UNCHANGED


def test_하한_안이면_때가_됐어도_묻지_않는다(store, web):
    store.put_snapshot(catalog.SNAP_SEARCH_FEEDS_STATUS, {"feeds": {
        "benzinga": {"status": "ok", "lastRequestAt": (NOW - timedelta(minutes=4)).isoformat()}}})
    _only_due(["benzinga"], NOW)
    with pytest.raises(EmptyResult, match="하한 간격"):
        task.task_search_feeds()
    assert web.calls == []
    assert flex.due_map(task.TASK_NAME)["benzinga"] >= NOW + timedelta(minutes=6)


def test_같은_호스트는_차례로_2_5초_사이를_두고_거부되면_간격을_두_배로_늘리고_형제는_미룬다(store, web, monkeypatch):
    monkeypatch.setattr(task, "_rng", _Edge(upper=False))
    _only_due(["cnbc_finance", "cnbc_world"], NOW)
    task.task_search_feeds()
    assert web.requested() == ["cnbc_finance", "cnbc_world"]
    assert web.sleeps == [2.0], "같은 호스트 두 번째 요청 앞에 2~5초"

    web.calls.clear()
    web.clock["now"] = later = NOW + timedelta(hours=5)
    web.override[URL["cnbc_finance"]] = http.SourceRejected("search.cnbc.com", "HTTP 429")
    _only_due(["cnbc_finance", "cnbc_world"], later)
    detail = task.task_search_feeds()
    assert web.requested() == ["cnbc_finance"], "거부된 호스트의 다른 피드는 그 실행에서 보내지 않음"
    status = _status(store)
    assert status["feeds"]["cnbc_finance"]["backoff"] == 1 and status["feeds"]["cnbc_finance"]["status"] == "실패"
    schedule = flex.due_map(task.TASK_NAME)
    assert schedule["cnbc_finance"] == later + timedelta(minutes=120), "간격 60분 × 2"
    assert schedule["cnbc_world"] >= later + timedelta(seconds=http.REJECT_LATCH_SECONDS)
    assert "호스트 거부로 미룸: cnbc_world" in detail


def test_90일_지난_행은_지운다(store, web):
    store.insert_new_observations(catalog.OBS_SEARCH_FEED_HEADLINE, [
        ("2026-08-01", "old-entity", {"title": "Synthetic old", "url": None, "publishedAt": "2026-08-01T00:00:00+00:00",
                                      "fetchedAt": "2026-08-01T00:00:00+00:00", "timeBasis": "published"}),
    ])
    _only_due(["fed_press_all"], NOW)
    detail = task.task_search_feeds()
    assert "old-entity" not in _rows(store) and "(지움 1건)" in detail


def test_받은_피드가_없으면_행은_그대로이고_실패한_피드_줄만_고친다(store, web):
    store.put_snapshot(catalog.SNAP_SEARCH_FEEDS_STATUS, {"generatedAt": "2026-11-13T00:00:00+00:00", "feeds": {}})
    web.override[URL["ecb_press"]] = (503, b"", {})
    _only_due(["ecb_press"], NOW)
    with pytest.raises(EmptyResult, match="피드 0/1 — 기존 저장본 유지 · 실패 1개: ecb_press"):
        task.task_search_feeds()
    status = _status(store)
    assert status["generatedAt"] == "2026-11-13T00:00:00+00:00" and status["feeds"]["ecb_press"]["status"] == "실패"
    assert _rows(store) == {}


# ==============================================================================
# 5. 정보 검색이 읽는 저장본 (PostgreSQL)
# ==============================================================================
def _bundle_row(entity, title, *, published="2026-11-13T07:00:00+00:00", fetched="2026-11-13T07:05:00+00:00", summary=None,
                url=None):
    url = url or f"https://www.example.org/{entity}"
    return ("2026-11-13", entity, {"title": title, "summary": summary, "url": url, "publisher": "Synthetic Wire",
                                   "publisherDomain": rules.domain_of(url), "feed": "bloomberg_markets", "publishedAt": published,
                                   "fetchedAt": fetched, "timeBasis": "published" if published else "fetched", "lang": "en"})


def test_정보_검색은_묶음에서_별칭이_든_글을_읽는다(store):
    store.insert_new_observations(catalog.OBS_SEARCH_FEED_HEADLINE, [
        _bundle_row("b1", "Synthetic Corp beats estimates"),
        _bundle_row("b2", "Macro wrap", summary="Analysts mention Synthetic Corp in passing"),
        _bundle_row("b3", "SyntheticCorpus dataset released"),
        _bundle_row("b4", "Synthetic Corp opens office", published=None, fetched="2026-11-12T01:00:00+00:00"),
    ])
    fetched = search_store.feed_bundle(["Synthetic Corp"])
    assert fetched.error is None
    by_title = {item["title"]: item for item in fetched.items}
    assert set(by_title) == {"Synthetic Corp beats estimates", "Macro wrap", "Synthetic Corp opens office"}
    first = by_title["Synthetic Corp beats estimates"]
    assert (first["source"], first["kind"], first["lang"], first["publisher"], first["publisherDomain"]) == \
        ("feeds", "news", "en", "Synthetic Wire", "example.org")
    assert first["id"] == info_text.item_id("https://www.example.org/b1") and first["readerId"] is None
    undated = by_title["Synthetic Corp opens office"]
    assert undated["timeBasis"] == "fetched" and undated["publishedAt"] == "2026-11-12T01:00:00+00:00"
    assert search_store.feed_bundle([]).items == []


def test_첫_화면_최근_글은_작성_시각_없으면_받은_시각으로_최신순(store):
    store.insert_new_observations(catalog.OBS_SEARCH_FEED_HEADLINE, [
        _bundle_row("r1", "Older", published="2026-11-12T00:00:00+00:00"),
        _bundle_row("r2", "Newest undated", published=None, fetched="2026-11-13T09:00:00+00:00"),
        _bundle_row("r3", "Middle", published="2026-11-13T08:00:00+00:00"),
    ])
    fetched = search_store.recent_bundle(2)
    assert [item["title"] for item in fetched.items] == ["Newest undated", "Middle"]
    assert fetched.items[0]["timeBasis"] == "fetched"
