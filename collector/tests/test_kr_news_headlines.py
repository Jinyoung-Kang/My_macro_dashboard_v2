"""
tests/test_kr_news_headlines.py
한국 사건 뉴스 RSS 헤드라인(태스크 kr_news_headlines, v2 2단계 명세 §4-11·K21·B9) — 한국 책 Claude 계좌 패킷 11b_events의 원자료.

고정하는 규칙
  1. 피드는 한국은행 보도자료(전체)·재정경제부 보도·참고자료·국가데이터처 보도자료·연합뉴스 마켓+ 네 개(KR_FEEDS). 미국 표(FEEDS)와 따로이고
     금융위원회(503 점검 중)는 없다. 세션은 설명형 UA(BLS 세션과 같은 것, 403에 BLS 안내를 붙이지 않음).
  2. 시각은 피드마다 정한 형식으로 원문을 직접 읽는다 — rfc822(초)·yyyyMMddHHmm(분, KST)·date_only(날짜만, KST). 형식과 다른 원문은
     지어내지 않고 건너뛰어 센다. 미국 피드의 읽기(feedparser 값)는 그대로다.
  3. 저장: observations kr_news_headline(obs_date = 발행 KST 날짜) + 상태 kr.news.headlines.status — 미국 news_headline·news.headlines.status를
     건드리지 않는다. 날짜만 있는 항목의 알 수 있는 시각(knownAt) = min(처음 받은 시각, 그 KST 날짜 다음 자정), 처음 받을 때 정해 다시 쓰지 않는다.
  4. 보관 7일은 KST 날짜, 같은 제목은 7일 안에 다시 넣지 않고 실어 온 피드는 feeds에 더한다. 피드 하나의 실패는 나머지를 멈추지 않고,
     전부 실패하면 EmptyResult(행·상태 그대로).

외부 네트워크를 쓰지 않습니다 — 고정본은 tests/fixtures/news_kr/(연합뉴스는 합성 자료, README). 가짜 세션이 그 응답을 돌려주고 requests
전송은 막아 둡니다. 태스크 테스트는 PostgreSQL이 필요합니다(store 픽스처, macrodash_test).
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path

import pytest
import requests

from app import catalog, http, tasks
from app.services import news as svc
from app.tasks import kr_news as task_module
from app.tasks.base import EmptyResult

FIXTURES = Path(__file__).parent / "fixtures" / "news_kr"
FILES = {
    "bok_press": "bok_press.xml",
    "mofe_press": "mofe_press.xml",
    "mods_press": "mods_press.xml",
    "yna_market": "yna_market.xml",
}
FEED = {feed.key: feed for feed in svc.KR_FEEDS}


def _fixture(key: str) -> bytes:
    return (FIXTURES / FILES[key]).read_bytes()


def _replace(raw: bytes, old: str, new: str, count: int = 1) -> bytes:
    text = raw.decode("utf-8")
    assert old in text, old
    return text.replace(old, new, count).encode("utf-8")


def _parse(key: str, raw: bytes | None = None) -> svc.ParsedFeed:
    return svc.parse_feed(_fixture(key) if raw is None else raw, "application/rss+xml", feed=FEED[key])


# ==============================================================================
# 1. 피드 표
# ==============================================================================
def test_한국_피드는_네_개이고_미국_표와_따로다():
    assert [(f.key, f.source, f.url, f.session, f.time_format, f.naive_tz) for f in svc.KR_FEEDS] == [
        ("bok_press", "한국은행", "https://www.bok.or.kr/portal/bbs/B0000552/news.rss?menuNo=200690", "product",
         "rfc822", "Asia/Seoul"),
        ("mofe_press", "재정경제부", "https://mofe.go.kr/com/detailRssTagService.do?bbsId=MOSFBBS_000000000028", "product",
         "date_only", "Asia/Seoul"),
        ("mods_press", "국가데이터처", "https://mods.go.kr/board.es?mid=a10301010000&bid=a103010100&act=rss", "product",
         "yyyyMMddHHmm", "Asia/Seoul"),
        ("yna_market", "연합뉴스", "https://www.yna.co.kr/rss/market.xml", "product", "rfc822", "Asia/Seoul"),
    ]
    assert svc.KR_FEED_KEYS == tuple(FILES)
    assert not set(svc.KR_FEED_KEYS) & set(svc.FEED_KEYS)
    # 금융위 RSS는 점검 중(503, G10)·금감원은 RSS 없음·정책브리핑은 중단 — 표에 없습니다.
    urls = " ".join(feed.url for feed in svc.KR_FEEDS)
    assert "fsc.go.kr" not in urls and "fss.or.kr" not in urls and "korea.kr" not in urls and "einfomax" not in urls
    assert {feed.time_format for feed in svc.KR_FEEDS} == set(svc.TIME_FORMATS)


def test_미국_피드는_시각을_feedparser로_읽는_그대로다():
    assert all(feed.time_format is None and feed.naive_tz == "UTC" for feed in svc.FEEDS)


def test_한국_피드는_설명형_UA_세션이고_403에_BLS_안내를_붙이지_않는다(monkeypatch):
    calls = []

    class _Session:
        def get(self, url, timeout=None, stream=False):
            calls.append(url)
            raise http.SourceRejected("www.bok.or.kr", "HTTP 403")

    monkeypatch.setattr(svc, "get_bls_session", lambda: _Session())
    monkeypatch.setattr(svc, "get_session", lambda: pytest.fail("한국 피드가 브라우저 UA 세션을 썼습니다"))
    with pytest.raises(svc.FeedFetchError) as caught:
        svc.fetch_feed(FEED["bok_press"])
    assert str(caught.value) == "거부됨 — www.bok.or.kr HTTP 403 · 5분 동안 이 출처 호출을 멈춤"
    assert calls == [FEED["bok_press"].url]


# ==============================================================================
# 2. 시각 형식 세 가지 (고정본)
# ==============================================================================
def test_rfc822_시간대_오프셋을_읽고_KST_날짜와_초_정밀도():
    parsed = _parse("bok_press")

    assert parsed.version == "rss20" and parsed.entries == 3 and parsed.bad_time == 0
    first = parsed.items[0]
    assert first["title"] == "한국은행 부총재보 인사"
    assert first["publishedAt"] == datetime(2026, 10, 26, 8, 30, tzinfo=timezone.utc)   # 17:30 +0900
    assert first["publishedDate"] == date(2026, 10, 26) and first["precision"] == "second"
    assert first["link"] == "https://www.bok.or.kr/portal/bbs/B0000502/view.do?nttId=11065937&menuNo=200690"
    assert first["entity"] == svc.title_entity(first["title"])
    # 09:00 KST는 UTC로는 자정 — 날짜는 KST 날짜 그대로입니다.
    third = parsed.items[2]
    assert third["publishedAt"] == datetime(2026, 10, 26, 0, 0, tzinfo=timezone.utc)
    assert third["publishedDate"] == date(2026, 10, 26)


def test_yyyyMMddHHmm은_KST_분_단위로_읽고_feedparser처럼_시각을_버리지_않는다():
    parsed = _parse("mods_press")

    first = parsed.items[0]
    assert first["title"] == "2025년 이주배경인구 통계 결과(등록센서스 방식)"
    assert first["publishedAt"] == datetime(2026, 10, 25, 10, 5, tzinfo=timezone.utc)   # 원문 202610251905 = 19:05 KST
    assert first["publishedDate"] == date(2026, 10, 25) and first["precision"] == "minute"
    assert [item["publishedAt"] for item in parsed.items[1:]] == [
        datetime(2026, 10, 22, 1, 36, tzinfo=timezone.utc), datetime(2026, 10, 21, 4, 27, tzinfo=timezone.utc)]
    # 형식 없이(미국 피드처럼) 읽으면 feedparser가 시각을 버리고 UTC 자정으로 읽습니다 — 그래서 한국 피드는 원문을 직접 읽습니다.
    assert svc.parse_feed(_fixture("mods_press")).items[0]["publishedAt"] == datetime(2026, 10, 25, tzinfo=timezone.utc)


def test_date_only는_날짜만_남기고_발행_시각은_None():
    parsed = _parse("mofe_press")

    assert [(item["title"], item["publishedAt"], item["publishedDate"], item["precision"]) for item in parsed.items] == [
        ("경제현안간담회 개최", None, date(2026, 10, 25), "date"),
        ("'26.10월 국고채 「모집 방식 비경쟁인수」 발행 미실시", None, date(2026, 10, 23), "date"),
        ("제9회 디지털 이코노미 포럼 개최", None, date(2026, 10, 23), "date"),
    ]
    assert parsed.items[0]["link"].startswith("http://mofe.go.kr/nw/nes/detailNesDtaView.do?")   # http 링크도 그대로


def test_연합뉴스_합성_고정본도_rfc822로_읽는다():
    parsed = _parse("yna_market")
    assert [(item["publishedAt"], item["precision"]) for item in parsed.items] == [
        (datetime(2026, 10, 26, 14, 2, 50, tzinfo=timezone.utc), "second"),
        (datetime(2026, 10, 26, 10, 35, 57, tzinfo=timezone.utc), "second"),
        (datetime(2026, 10, 26, 10, 35, 12, tzinfo=timezone.utc), "second"),
    ]


@pytest.mark.parametrize("raw, time_format, expected", [
    # 시간대 없는 rfc822는 naive_tz(KST)로 봅니다.
    ("Mon, 26 Oct 2026 17:30:00", "rfc822", (datetime(2026, 10, 26, 8, 30, tzinfo=timezone.utc), date(2026, 10, 26), "second")),
    # UTC 저녁은 KST로 다음 날 — 날짜는 KST 달력입니다.
    ("Sun, 25 Oct 2026 16:00:00 +0000", "rfc822", (datetime(2026, 10, 25, 16, 0, tzinfo=timezone.utc), date(2026, 10, 26), "second")),
    ("  202610251905\n", "yyyyMMddHHmm", (datetime(2026, 10, 25, 10, 5, tzinfo=timezone.utc), date(2026, 10, 25), "minute")),
    ("2026-10-25 00:00:00.0", "date_only", (None, date(2026, 10, 25), "date")),
    ("2026-10-25", "date_only", (None, date(2026, 10, 25), "date")),
    # 형식과 다르면 None — 지어내지 않습니다.
    ("2026-10-25 19:05", "yyyyMMddHHmm", None),
    ("20261025190", "yyyyMMddHHmm", None),
    ("202613251905", "yyyyMMddHHmm", None),
    ("202610251905", "date_only", None),
    ("2026-13-01 00:00:00.0", "date_only", None),
    ("26 Oct 2026", "rfc822", None),
    ("어제", "rfc822", None),
])
def test_read_time(raw, time_format, expected):
    assert svc.read_time(raw, time_format, "Asia/Seoul") == expected


def test_모르는_형식은_코드_오류():
    with pytest.raises(ValueError, match="모르는 시각 형식"):
        svc.read_time("202610251905", "iso8601", "Asia/Seoul")


def test_형식과_다른_시각은_건너뛰고_따로_센다():
    raw = _replace(_fixture("mods_press"), "<pubDate>202610221036</pubDate>", "<pubDate>2026-10-22 10:36</pubDate>")
    raw = _replace(raw, "<pubDate>202610211327</pubDate>", "")
    parsed = _parse("mods_press", raw)

    assert (parsed.entries, parsed.bad_time, parsed.no_time) == (3, 1, 1)
    assert [item["title"] for item in parsed.items] == ["2025년 이주배경인구 통계 결과(등록센서스 방식)"]


def test_모두_형식이_다르면_FeedShapeError에_그_수가_나온다():
    raw = _fixture("mofe_press").decode("utf-8").replace(" 00:00:00.0</pubDate>", "T00:00:00+09:00Z!</pubDate>").encode("utf-8")
    with pytest.raises(svc.FeedShapeError, match=r"쓸 항목 없음\(항목 3개 — 시각 없음 0, 시각 형식 다름 3, 제목 없음 0\)"):
        _parse("mofe_press", raw)


# ==============================================================================
# 3. 알 수 있는 시각 (순수 함수)
# ==============================================================================
def test_알_수_있는_시각은_시각이_있으면_발행_시각():
    published = datetime(2026, 10, 26, 8, 30, tzinfo=timezone.utc)
    assert task_module.known_at(published, date(2026, 10, 26), datetime(2026, 10, 27, tzinfo=timezone.utc)) == published


def test_날짜만이면_처음_받은_시각과_다음_KST_자정_중_이른_것():
    day = date(2026, 10, 25)
    next_midnight = datetime(2026, 10, 25, 15, 0, tzinfo=timezone.utc)   # 10-26 00:00 KST
    # 그날 밤에 처음 받음 → 받은 시각(그 전에 게시됐음은 확실).
    fetched = datetime(2026, 10, 25, 13, 0, tzinfo=timezone.utc)          # 10-25 22:00 KST
    assert task_module.known_at(None, day, fetched) == fetched
    # 다음 날 처음 받음 → 그 날짜 다음 자정(게시는 그날 안이므로 늦어도 그때는 알 수 있음).
    assert task_module.known_at(None, day, datetime(2026, 10, 26, 13, 0, tzinfo=timezone.utc)) == next_midnight
    # 두 값 모두 실제 게시 시각(그날 00:00~24:00 KST, 받기 전)보다 앞서지 않습니다.
    assert task_module.known_at(None, day, next_midnight) == next_midnight


# ==============================================================================
# 4. 태스크 (PostgreSQL)
# ==============================================================================
URL = {feed.key: feed.url for feed in svc.KR_FEEDS}
NOW = datetime(2026, 10, 26, 14, 0, tzinfo=timezone.utc)     # 10-26 23:00 KST
CUTOFF = date(2026, 10, 19)                                    # NOW의 KST 날짜 − 7일


class _Response:
    def __init__(self, status: int, content: bytes = b"", content_type: str = "application/rss+xml"):
        self.status_code = status
        self._content = content
        self.headers = {"Content-Type": content_type}
        self.closed = False

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self._content), chunk_size):
            yield self._content[i:i + chunk_size]

    def close(self):
        self.closed = True


class FakeWeb:
    """URL → (상태, 본문) 또는 예외. 부른 (세션, URL)을 기록합니다."""

    def __init__(self):
        self.outcomes: dict = {URL[key]: (200, _fixture(key)) for key in FILES}
        self.calls: list[tuple] = []
        self.clock = {"now": NOW, "mono": 0.0}

    def session(self, name: str):
        web = self

        class _Session:
            def get(self, url, timeout=None, stream=False):
                web.calls.append((name, url))
                outcome = web.outcomes[url]
                if isinstance(outcome, Exception):
                    raise outcome
                status, body = outcome
                return _Response(status, body)

        return _Session()


@pytest.fixture()
def web(monkeypatch):
    fake = FakeWeb()
    monkeypatch.setattr(svc, "get_bls_session", lambda: fake.session("product"))
    monkeypatch.setattr(svc, "get_session", lambda: fake.session("default"))
    monkeypatch.setattr(svc, "get_sec_session", lambda: fake.session("sec"))
    monkeypatch.setattr(task_module, "_now", lambda: fake.clock["now"])
    monkeypatch.setattr(task_module, "_clock", lambda: fake.clock["mono"])
    monkeypatch.setattr(task_module, "_sleep", lambda seconds: fake.calls.append(("sleep", seconds)))

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return fake


def _rows(store, dataset: str = catalog.OBS_KR_NEWS_HEADLINE) -> dict[str, tuple[date, dict]]:
    with store.connection() as conn:
        found = conn.execute(
            "SELECT obs_date, entity, payload FROM observations WHERE dataset = %s", (dataset,),
        ).fetchall()
    return {row["entity"]: (row["obs_date"], row["payload"]) for row in found}


def _by_title(rows: dict) -> dict[str, tuple[date, dict]]:
    return {payload["title"]: (day, payload) for day, payload in rows.values()}


def _status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_KR_NEWS_STATUS).payload


def test_slow에서_미국_뉴스_바로_뒤에_돌고_태스크는_35개():
    task = tasks.TASKS_BY_NAME["kr_news_headlines"]
    assert task.speed == "slow" and task.run is task_module.task_kr_news_headlines
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("kr_news_headlines") == names.index("news_headlines") + 1
    assert task_module.TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 35


def test_데이터셋_이름은_미국과_따로다():
    assert catalog.OBS_KR_NEWS_HEADLINE == "kr_news_headline"
    assert catalog.SNAP_KR_NEWS_STATUS == "kr.news.headlines.status"
    assert catalog.OBS_KR_NEWS_HEADLINE != catalog.OBS_NEWS_HEADLINE
    assert catalog.SNAP_KR_NEWS_STATUS != catalog.SNAP_NEWS_STATUS


def test_네_피드를_받아_세_형식을_저장하고_미국_저장본은_건드리지_않는다(store, web):
    detail = task_module.task_kr_news_headlines()

    rows = _rows(store)
    assert len(rows) == 12
    titles = _by_title(rows)
    day, bok = titles["한국은행 부총재보 인사"]
    assert day == date(2026, 10, 26)
    assert bok == {
        "title": "한국은행 부총재보 인사",
        "link": "https://www.bok.or.kr/portal/bbs/B0000502/view.do?nttId=11065937&menuNo=200690",
        "source": "한국은행",
        "feed": "bok_press",
        "feeds": ["bok_press"],
        "publishedAt": "2026-10-26T08:30:00+00:00",
        "publishedDate": "2026-10-26",
        "timePrecision": "second",
        "knownAt": "2026-10-26T08:30:00+00:00",
        "fetchedAt": "2026-10-26T14:00:00+00:00",
    }
    assert rows[svc.title_entity(bok["title"])][1] == bok
    day, mods = titles["2025년 이주배경인구 통계 결과(등록센서스 방식)"]
    assert day == date(2026, 10, 25)
    assert (mods["publishedAt"], mods["timePrecision"], mods["knownAt"], mods["source"]) == (
        "2026-10-25T10:05:00+00:00", "minute", "2026-10-25T10:05:00+00:00", "국가데이터처")
    # 날짜만(재정경제부): 다음 날 밤에 처음 받았으므로 알 수 있는 시각 = 그 날짜 다음 KST 자정.
    day, mofe = titles["경제현안간담회 개최"]
    assert day == date(2026, 10, 25)
    assert (mofe["publishedAt"], mofe["publishedDate"], mofe["timePrecision"], mofe["knownAt"]) == (
        None, "2026-10-25", "date", "2026-10-25T15:00:00+00:00")
    assert titles["제9회 디지털 이코노미 포럼 개최"][1]["knownAt"] == "2026-10-23T15:00:00+00:00"
    assert titles["시험 제목 가 — 코스피 외국인 순매수에 상승 마감"][1]["feed"] == "yna_market"

    status = _status(store)
    assert (status["feedsOk"], status["feedsTotal"], status["failedFeeds"]) == (4, 4, [])
    assert (status["stored7d"], status["insertedThisRun"], status["deletedThisRun"]) == (12, 12, 0)
    assert (status["retentionDays"], status["retainedFrom"], status["timeZone"]) == (7, "2026-10-19", "Asia/Seoul")
    assert status["feeds"]["mofe_press"]["timeFormat"] == "date_only"
    assert status["feeds"]["mofe_press"]["newestAt"] == "2026-10-25T15:00:00+00:00"
    assert status["feeds"]["mods_press"]["skippedBadTime"] == 0
    assert status["maybeMissed"] == []
    assert detail == "새 헤드라인 12건 · 피드 4/4 · 7일 보관 12건"

    # 설명형 UA 세션 하나로 표 순서대로, 호스트가 모두 달라 쉬지 않음.
    assert web.calls == [("product", URL[key]) for key in FILES]
    # 미국 사건 뉴스 저장본은 그대로(없음).
    assert _rows(store, catalog.OBS_NEWS_HEADLINE) == {}
    assert store.read_snapshot(catalog.SNAP_NEWS_STATUS) is None


def test_그날_밤에_처음_받은_날짜만_항목은_받은_시각이고_다시_돌아도_바뀌지_않는다(store, web):
    web.clock["now"] = datetime(2026, 10, 25, 13, 0, tzinfo=timezone.utc)   # 10-25 22:00 KST
    detail = task_module.task_kr_news_headlines()

    mofe = _by_title(_rows(store))["경제현안간담회 개최"][1]
    assert mofe["knownAt"] == mofe["fetchedAt"] == "2026-10-25T13:00:00+00:00"
    # 연합뉴스 첫 항목(10-26 14:02Z)은 지금 + 1일(10-26 13:00Z)보다 뒤 — 미래 시각으로 건너뜀.
    assert "미래 시각 1건 건너뜀" in detail

    # 다음 날 다시 받아도 같은 제목은 넣지 않으므로 처음 정한 knownAt이 그대로입니다(저장본만으로 결정적).
    web.clock["now"] = NOW
    task_module.task_kr_news_headlines()
    again = _by_title(_rows(store))["경제현안간담회 개최"][1]
    assert again == mofe
    assert _status(store)["insertedThisRun"] == 1   # 전날 미래로 건너뛴 연합뉴스 한 건만 새로


def test_날짜만_항목도_하루_넘게_미래면_건너뛴다(store, web):
    web.outcomes[URL["mofe_press"]] = (200, _replace(_fixture("mofe_press"), "2026-10-25 00:00:00.0", "2026-10-28 00:00:00.0"))
    task_module.task_kr_news_headlines()   # 지금 10-26 23:00 KST + 1일 = 10-27 KST까지

    titles = _by_title(_rows(store))
    assert "경제현안간담회 개최" not in titles and len(titles) == 11
    assert _status(store)["feeds"]["mofe_press"]["skippedFuture"] == 1


def test_보관은_KST_날짜로_자르고_지난_행을_지운다(store, web):
    # 11-01 01:00 KST — UTC 날짜(10-31)로 자르면 10-24가 남지만, KST 날짜 기준 기한은 10-25입니다.
    web.clock["now"] = datetime(2026, 10, 31, 16, 0, tzinfo=timezone.utc)
    store.insert_new_observations(catalog.OBS_KR_NEWS_HEADLINE, [("2026-10-24", "0123456789abcdef", {"title": "old"})])

    detail = task_module.task_kr_news_headlines()

    titles = _by_title(_rows(store))
    assert "old" not in titles
    assert sorted(day.isoformat() for day, _ in titles.values()) == ["2026-10-25"] * 2 + ["2026-10-26"] * 6
    status = _status(store)
    assert (status["retainedFrom"], status["deletedThisRun"]) == ("2026-10-25", 1)
    assert status["feeds"]["mods_press"]["skippedOld"] == 2
    assert "(지움 1건)" in detail


def test_같은_제목을_다른_피드가_실으면_feeds에_더한다(store, web):
    # 연합뉴스가 한국은행 보도자료 제목을 그대로 실은 경우(같은 실행).
    web.outcomes[URL["yna_market"]] = (200, _replace(
        _fixture("yna_market"), "시험 제목 다 — 애프터마켓 급등 종목", "한국은행 부총재보 인사"))
    task_module.task_kr_news_headlines()

    bok = _by_title(_rows(store))["한국은행 부총재보 인사"][1]
    assert bok["feeds"] == ["bok_press", "yna_market"] and bok["feed"] == "bok_press"
    assert len(_rows(store)) == 11


def test_피드_하나가_실패해도_나머지는_저장되고_사유가_남는다(store, web):
    web.outcomes[URL["mods_press"]] = requests.ConnectionError("connection refused")
    web.outcomes[URL["yna_market"]] = (200, b"<!DOCTYPE html><html><body>maintenance</body></html>")

    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["kr_news_headlines"])

    assert ok is True
    assert len(_rows(store)) == 6   # 한국은행 3 + 재정경제부 3
    recorded = store.read_task_history("kr_news_headlines")[0]
    assert recorded["status"] == "ok" and "피드 2/4" in recorded["detail"]
    assert ("실패 2개: mods_press(ConnectionError — 서버가 연결을 거부했습니다); yna_market(RSS·Atom 피드가 아님(HTML 등))"
            in recorded["detail"])
    status = _status(store)
    assert [failed["feed"] for failed in status["failedFeeds"]] == ["mods_press", "yna_market"]
    assert status["feeds"]["mods_press"] == {
        "source": "국가데이터처", "url": URL["mods_press"], "timeFormat": "yyyyMMddHHmm", "status": "실패",
        "error": "ConnectionError — 서버가 연결을 거부했습니다", "lastOkAt": None}


def test_형식이_다른_시각은_상태와_결과에_남는다(store, web):
    web.outcomes[URL["mods_press"]] = (200, _replace(_fixture("mods_press"), "<pubDate>202610221036</pubDate>",
                                                     "<pubDate>2026-10-22 10:36</pubDate>"))
    detail = task_module.task_kr_news_headlines()

    assert "시각 형식 다름 1건 건너뜀" in detail
    assert _status(store)["feeds"]["mods_press"]["skippedBadTime"] == 1
    assert len(_rows(store)) == 11


def test_전부_실패하면_EmptyResult이고_행과_상태를_그대로_둔다(store, web):
    store.put_snapshot(catalog.SNAP_KR_NEWS_STATUS, {"marker": "이전 상태"})
    store.insert_new_observations(catalog.OBS_KR_NEWS_HEADLINE, [("2026-10-01", "0123456789abcdef", {"title": "old"})])
    for key in FILES:
        web.outcomes[URL[key]] = requests.ConnectionError("Max retries exceeded")

    with pytest.raises(EmptyResult) as caught:
        task_module.task_kr_news_headlines()

    assert str(caught.value).startswith("피드 0/4 — 기존 저장본 유지 · 실패 4개: bok_press(")
    assert _status(store) == {"marker": "이전 상태"}
    assert [payload["title"] for _, payload in _rows(store).values()] == ["old"]


def test_시간_상한이_지나면_남은_피드는_다음_실행(store, web):
    web.clock["mono"] = 0.0
    calls = {"n": 0}
    original = web.session

    def slow_session(name):
        inner = original(name)

        class _Session:
            def get(self, url, timeout=None, stream=False):
                calls["n"] += 1
                web.clock["mono"] += task_module.TIME_LIMIT_SECONDS   # 첫 피드에서 상한을 다 씀
                return inner.get(url, timeout=timeout, stream=stream)

        return _Session()

    web.session = slow_session
    detail = task_module.task_kr_news_headlines()

    assert calls["n"] == 2   # 상한 직전(경과 = 상한)까지는 시작하고, 넘은 뒤로는 새 요청을 보내지 않음
    assert "실패 2개: mods_press(시간 상한(300초) — 다음 실행); yna_market(시간 상한(300초) — 다음 실행)" in detail
