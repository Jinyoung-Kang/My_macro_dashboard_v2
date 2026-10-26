"""
tests/test_news_headlines.py
사건 뉴스 RSS 헤드라인(태스크 news_headlines, 2단계 명세 B1·B2·§4-3·§10) — 모의 매매 Claude 계좌 패킷 11b_events의 원자료.

고정하는 규칙
  1. 피드는 단계 0에서 고정한 일곱 개에 외환(news_1, 2026-10-25)을 더한 여덟 개(인베스팅닷컴 넷·연준 하나·BLS 둘·SEC 하나).
     야후·인베스팅 전체·연준 press_all은 없다.
     feedparser는 6.0.14로 고정하고 간접 의존성(feedparser-sgmllib)도 constraints.txt에 있다.
  2. feedparser는 읽기만 한다 — 받은 바이트가 URL·파일 경로 모양이어도 받거나 열지 않는다. RSS 2.0·Atom(BLS)·RFC 822·
     시간대 없는 인베스팅 시각(UTC)·SEC의 앞뒤 공백 제목을 읽는다. 시각이 없는 항목은 건너뛰고 센다. HTML·빈 피드는 그 피드의 실패.
  3. 세션: 인베스팅·연준은 공용, BLS는 설명형 UA(연락처 없음)·403 재시도 없음, SEC는 SEC 세션 + 속도 제한.
  4. 저장: entity = 정규화 제목 해시, obs_date = 발행 UTC 날짜, payload {title, link, source, feed, feeds, publishedAt, fetchedAt}.
     7일보다 오래된 항목은 넣지 않고, 7일 지난 행은 지운다. 같은 제목은 날짜가 달라도 7일 안에 다시 넣지 않되, 실어 온 피드는
     모두 feeds에 남긴다(다음 실행이면 그 행에 피드 키만 더함).
  5. 실패: 피드 하나의 실패는 나머지를 멈추지 않고 사유가 실행 기록(collector_task_runs)과 상태에 남는다. 전부 실패 → EmptyResult
     (행·상태 그대로). 피드 항목이 모두 처음 보는 것이면 '누락 가능'.

외부 네트워크를 쓰지 않습니다 — 가짜 세션이 tests/fixtures/news/의 응답을 돌려줍니다(requests 전송도 막아 둠).
태스크 테스트는 PostgreSQL이 필요합니다(store 픽스처, macrodash_test). 순수 함수 테스트는 DB 없이 돕니다.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import feedparser
import pytest
import requests

from app import catalog, http, tasks
from app.services import news as svc
from app.tasks import news as task_module
from app.tasks.base import EmptyResult

FIXTURES = Path(__file__).parent / "fixtures" / "news"
NOW = datetime(2026, 10, 25, 7, 0, tzinfo=timezone.utc)   # KST 10-25 16:00
CUTOFF = date(2026, 10, 18)                                # NOW의 UTC 날짜 − 7일

FILES = {
    "investing_stock": "investing_news_25.xml",
    "investing_ind": "investing_news_95.xml",
    "investing_economy": "investing_news_14.xml",
    "investing_forex": "investing_news_1.xml",
    "fed_monetary": "fed_press_monetary.xml",
    "bls_cpi": "bls_cpi.xml",
    "bls_empsit": "bls_empsit.xml",
    "sec_press": "sec_pressreleases.xml",
}
URL = {feed.key: feed.url for feed in svc.FEEDS}


def _fixture(key: str) -> bytes:
    return (FIXTURES / FILES[key]).read_bytes()


def _replace(raw: bytes, old: str, new: str, count: int = 1) -> bytes:
    text = raw.decode("utf-8")
    assert old in text, old
    return text.replace(old, new, count).encode("utf-8")


# ==============================================================================
# 1. 피드 목록·의존성·이름
# ==============================================================================
def test_피드는_단계0에서_고정한_일곱_개와_외환_하나():
    assert [(f.key, f.source, f.url, f.session) for f in svc.FEEDS] == [
        ("investing_stock", "Investing.com", "https://www.investing.com/rss/news_25.rss", "default"),
        ("investing_ind", "Investing.com", "https://www.investing.com/rss/news_95.rss", "default"),
        ("investing_economy", "Investing.com", "https://www.investing.com/rss/news_14.rss", "default"),
        ("investing_forex", "Investing.com", "https://www.investing.com/rss/news_1.rss", "default"),
        ("fed_monetary", "Federal Reserve", "https://www.federalreserve.gov/feeds/press_monetary.xml", "default"),
        ("bls_cpi", "BLS", "https://www.bls.gov/feed/cpi.rss", "bls"),
        ("bls_empsit", "BLS", "https://www.bls.gov/feed/empsit.rss", "bls"),
        ("sec_press", "SEC", "https://www.sec.gov/news/pressreleases.rss", "sec"),
    ]
    urls = " ".join(feed.url for feed in svc.FEEDS)
    # 야후는 robots.txt가 전체 금지, 인베스팅 전체 피드는 내부자 거래 자동 항목, 연준 press_all은 제재·인가 공지(B1).
    assert "yahoo" not in urls and "/rss/news.rss" not in urls and "press_all" not in urls
    # 인베스팅은 RSS만 — 뉴스 HTML 페이지(/news/…)는 Cloudflare가 자동 요청을 막아 받지 않음(D29, 2026-10-25 확인).
    assert all("/rss/" in feed.url for feed in svc.FEEDS if "investing.com" in feed.url)
    assert svc.FEED_KEYS == tuple(FILES)


def test_feedparser는_6_0_14로_고정하고_간접_의존성도_고정한다():
    root = Path(__file__).parents[1]
    assert "feedparser==6.0.14" in (root / "requirements.txt").read_text(encoding="utf-8").splitlines()
    constraints = (root / "constraints.txt").read_text(encoding="utf-8").splitlines()
    assert "feedparser==6.0.14" in constraints and "feedparser-sgmllib==2.1.0" in constraints
    assert feedparser.__version__ == "6.0.14"


def test_데이터셋_이름():
    assert catalog.OBS_NEWS_HEADLINE == "news_headline"
    assert catalog.SNAP_NEWS_STATUS == "news.headlines.status"


def test_slow에_등록되고_시간_상한은_slow_상한보다_짧다():
    task = tasks.TASKS_BY_NAME["news_headlines"]
    assert task.speed == "slow" and task.run is task_module.task_news_headlines
    assert task_module.TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 27  # 2단계 C의 earnings_surprise까지


# ==============================================================================
# 2. 읽기 (feedparser — 파싱만, DB·네트워크 없음)
# ==============================================================================
def test_인베스팅의_시간대_없는_시각은_UTC로_읽는다():
    parsed = svc.parse_feed(_fixture("investing_stock"), "application/rss+xml")

    assert parsed.version == "rss20" and parsed.entries == 3 and parsed.no_time == 0
    first = parsed.items[0]
    assert first["title"] == "Trump announces Audi will build $4 billion US factory in Georgia"
    assert first["publishedAt"] == datetime(2026, 10, 25, 2, 48, 34, tzinfo=timezone.utc)   # 원문 '2026-10-25 02:48:34'
    assert first["link"].startswith("https://www.investing.com/news/stock-market-news/")
    assert first["entity"] == svc.title_entity(first["title"])


def test_BLS는_주소가_rss여도_Atom으로_읽는다():
    parsed = svc.parse_feed(_fixture("bls_cpi"), "application/rss+xml")

    assert parsed.version == "atom10" and len(parsed.items) == 3
    first = parsed.items[0]
    assert first["title"] == "CPI for all items increases 0.6% in September; gasoline rises"
    assert first["publishedAt"] == datetime(2026, 10, 14, 11, 50, 31, tzinfo=timezone.utc)   # 07:50:31.2-04:00
    assert first["link"] == "https://www.bls.gov/news.release/archives/cpi_10142026.htm"


def test_연준_RFC822와_SEC_시간대_오프셋을_UTC로_바꾼다():
    fed = svc.parse_feed(_fixture("fed_monetary"))
    sec = svc.parse_feed(_fixture("sec_press"))

    assert fed.items[0]["publishedAt"] == datetime(2026, 10, 13, 18, 0, tzinfo=timezone.utc)
    assert sec.items[0]["publishedAt"] == datetime(2026, 10, 23, 14, 10, tzinfo=timezone.utc)   # 10:10:00 -0400


def test_SEC_제목의_앞뒤_공백과_줄바꿈을_정리한다():
    titles = [item["title"] for item in svc.parse_feed(_fixture("sec_press")).items]
    assert titles[0] == "SEC Announces Fiscal Year 2027 Examination Priorities"
    assert all(title == title.strip() and "\n" not in title and "  " not in title for title in titles)

    # 제목 안의 줄바꿈·연속 공백도 하나로(원문 SEC 제목의 앞뒤 공백 모양을 안쪽에 넣어 봄).
    raw = _replace(_fixture("sec_press"), "    SEC Announces Fiscal Year 2027 Examination Priorities\n",
                   "    SEC Announces\n   Fiscal\tYear  2027 Examination Priorities\n")
    assert svc.parse_feed(raw).items[0]["title"] == "SEC Announces Fiscal Year 2027 Examination Priorities"


def test_제목_정규화와_entity():
    assert svc.normalise_title("  Fed\n\tholds   rates \r\n") == "Fed holds rates"
    assert svc.normalise_title("Oil\x00 jumps\x07") == "Oil jumps"
    assert svc.normalise_title(None) == "" and svc.normalise_title("   ") == ""
    long_title = "x" * (svc.MAX_TITLE_CHARS + 50)
    assert svc.normalise_title(long_title) == "x" * svc.MAX_TITLE_CHARS + "…"

    entity = svc.title_entity("Fed Holds Rates")
    assert re.fullmatch(r"[0-9a-f]{16}", entity)
    # 대소문자·공백만 다른 제목은 같은 entity, 다른 제목은 다른 entity.
    assert svc.title_entity("  FED   holds\nrates ") == entity
    assert svc.title_entity("Fed Cuts Rates") != entity


def test_시각이_없는_항목은_건너뛰고_센다():
    raw = _replace(_fixture("investing_stock"), "<pubDate>2026-10-25 02:48:10</pubDate>", "")
    parsed = svc.parse_feed(raw)

    assert parsed.entries == 3 and parsed.no_time == 1
    assert [item["title"] for item in parsed.items] == [
        "Trump announces Audi will build $4 billion US factory in Georgia",
        "Chinese equities face prolonged downturn as earnings forecasts tumble"]


def test_제목이_없는_항목은_건너뛰고_센다():
    raw = _replace(_fixture("investing_stock"), "<title>HSBC sees cautious optimism in VC and PE activity</title>",
                   "<title>   </title>")
    parsed = svc.parse_feed(raw)
    assert parsed.no_title == 1 and len(parsed.items) == 2


def test_http가_아닌_링크는_버리고_None():
    raw = _replace(_fixture("investing_stock"),
                   "<link>https://www.investing.com/news/stock-market-news/hsbc-sees-cautious-optimism-in-vc-and-pe-activity-4971023</link>",
                   "<link>javascript:alert(1)</link>")
    items = svc.parse_feed(raw).items
    assert items[1]["link"] is None and items[0]["link"] is not None


@pytest.mark.parametrize("body, reason", [
    (b"<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>blocked</body></html>", "RSS·Atom 피드가 아님"),
    (b"<?xml version='1.0'?><rss version='2.0'><channel><title>t</title></channel></rss>", "항목 0개"),
    (b"<?xml version='1.0'?><rss version='2.0'><channel><title>t</title><item><title>a</title></item></channel></rss>",
     "쓸 항목 없음"),
    (b"", "RSS·Atom 피드가 아님"),
])
def test_피드가_아니거나_쓸_항목이_없으면_FeedShapeError(body, reason):
    with pytest.raises(svc.FeedShapeError, match=reason):
        svc.parse_feed(body, "text/html")


def test_받은_바이트가_파일_경로나_URL_모양이어도_열거나_받지_않는다(tmp_path, monkeypatch):
    # feedparser는 bytes를 먼저 파일 이름으로 열어 봅니다 — 진짜 피드 파일의 경로를 본문으로 넘겨도 그 파일을 읽으면 안 됩니다.
    path = tmp_path / "feed.xml"
    path.write_bytes(_fixture("investing_stock"))
    with pytest.raises(svc.FeedShapeError):
        svc.parse_feed(str(path).encode("utf-8"))

    def no_fetch(*args, **kwargs):
        raise AssertionError("feedparser가 직접 받으려 했습니다")

    monkeypatch.setattr(feedparser.api.http, "get", no_fetch)
    with pytest.raises(svc.FeedShapeError):
        svc.parse_feed(b"https://www.investing.com/rss/news_25.rss")


# ==============================================================================
# 3. 받기 — 세션 (네트워크 없음)
# ==============================================================================
class _Response:
    """requests 응답 흉내 — 본문은 iter_content로만 나눠 줍니다(stream=True로 받는 코드가 .content를 읽지 않는지도 봄)."""

    def __init__(self, status: int, content: bytes = b"", content_type: str = "application/rss+xml",
                 headers: dict | None = None, chunks=None):
        self.status_code = status
        self._content = content
        self._chunks = chunks
        self.headers = {"Content-Type": content_type, **(headers or {})}
        self.read_bytes = 0
        self.closed = False

    @property
    def content(self):
        raise AssertionError("stream=True로 받은 응답의 본문을 통째로 읽었습니다")

    def iter_content(self, chunk_size=1):
        source = self._chunks if self._chunks is not None else (
            self._content[i:i + chunk_size] for i in range(0, len(self._content), chunk_size))
        for chunk in source:
            self.read_bytes += len(chunk)
            yield chunk

    def close(self):
        self.closed = True


class FakeWeb:
    """URL → 응답(상태, 본문) 또는 예외. (세션 이름, URL)과 속도 제한·쉼을 부른 순서대로 기록합니다."""

    def __init__(self):
        self.outcomes: dict = {URL[key]: (200, _fixture(key)) for key in FILES}
        self.calls: list[tuple] = []
        self.clock = {"now": NOW, "mono": 0.0}
        self.advance_per_request = 0.0
        self.responses: list[_Response] = []
        self.streamed: list[bool] = []

    def session(self, name: str):
        web = self

        class _Session:
            def get(self, url, timeout=None, stream=False):
                web.calls.append((name, url))
                web.streamed.append(stream)
                web.clock["mono"] += web.advance_per_request
                outcome = web.outcomes[url]
                if isinstance(outcome, Exception):
                    raise outcome
                if isinstance(outcome, _Response):
                    response = outcome
                else:
                    status, body = outcome
                    response = _Response(status, body)
                web.responses.append(response)
                return response

        return _Session()

    def fetched(self) -> list[str]:
        return [url for name, url in self.calls if name in ("default", "bls", "sec")]


@pytest.fixture()
def web(monkeypatch):
    fake = FakeWeb()
    monkeypatch.setattr(svc, "get_session", lambda: fake.session("default"))
    monkeypatch.setattr(svc, "get_bls_session", lambda: fake.session("bls"))
    monkeypatch.setattr(svc, "get_sec_session", lambda: fake.session("sec"))
    monkeypatch.setattr(svc, "sec_rate_limit", lambda: fake.calls.append(("sec_rate_limit", None)))
    monkeypatch.setattr(task_module, "_now", lambda: fake.clock["now"])
    monkeypatch.setattr(task_module, "_clock", lambda: fake.clock["mono"])
    monkeypatch.setattr(task_module, "_sleep", lambda seconds: fake.calls.append(("sleep", seconds)))

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return fake


def test_세션은_피드마다_정해진_것을_쓰고_SEC는_속도_제한을_거친다(web):
    for feed in svc.FEEDS:
        content, content_type = svc.fetch_feed(feed)
        assert content == _fixture(feed.key) and content_type == "application/rss+xml"

    assert [name for name, _ in web.calls] == ["default"] * 5 + ["bls", "bls", "sec_rate_limit", "sec"]


def test_BLS_세션은_설명형_UA에_연락처가_없고_403을_다시_보내지_않는다(monkeypatch):
    # 소유자 연락처(SEC_USER_AGENT)가 설정돼 있어도 BLS에는 실리지 않습니다.
    monkeypatch.setenv("SEC_USER_AGENT", "owner-contact@example.org")
    session = http.get_bls_session()

    user_agent = session.headers["User-Agent"]
    assert user_agent == "LocalMacroDashboard/2.0"
    assert "@" not in user_agent and "Mozilla" not in user_agent
    retry = session.get_adapter("https://www.bls.gov/").max_retries
    assert 403 not in retry.status_forcelist and 503 in retry.status_forcelist
    # v2 1단계 6번부터 모든 공용 세션이 403·429를 다시 보내지 않고 거부 래치로 닫습니다(test_http_guards.py).
    for other in (http.get_session(), session):
        forcelist = other.get_adapter("https://www.investing.com/").max_retries.status_forcelist
        assert 403 not in forcelist and 429 not in forcelist


# 403은 실제 세션의 어댑터가 응답 대신 출처 거부(SourceRejected)로 올립니다(app/http.py) — 가짜 세션도 그대로 흉내 냅니다.
# 실제 어댑터(127.0.0.1 서버)를 거치는 같은 확인은 test_http_guards.py에 있습니다.
_BLS_REJECTED = "거부됨 — www.bls.gov HTTP 403 · 5분 동안 이 출처 호출을 멈춤"


@pytest.mark.parametrize("key, outcome, expected", [
    ("bls_cpi", http.SourceRejected("www.bls.gov", "HTTP 403"), f"{_BLS_REJECTED} — BLS 차단(UA)"),
    ("sec_press", http.SourceRejected("www.sec.gov", "HTTP 403"),
     "거부됨 — www.sec.gov HTTP 403 · 5분 동안 이 출처 호출을 멈춤 — SEC_USER_AGENT 확인"),
    ("investing_stock", http.SourceRejected("www.investing.com", "HTTP 403"),
     "거부됨 — www.investing.com HTTP 403 · 5분 동안 이 출처 호출을 멈춤"),
    ("sec_press", http.SourceRejected("www.sec.gov", "HTTP 429"),
     "거부됨 — www.sec.gov HTTP 429 · 5분 동안 이 출처 호출을 멈춤"),
    ("investing_stock", (404, b"<html>gone</html>"), "HTTP 404"),
])
def test_HTTP_오류는_상태_코드_또는_거부와_안내(web, key, outcome, expected):
    web.outcomes[URL[key]] = outcome
    feed = next(feed for feed in svc.FEEDS if feed.key == key)
    with pytest.raises(svc.FeedFetchError) as caught:
        svc.fetch_feed(feed)
    assert str(caught.value) == expected


def test_SEC_연락처가_없으면_그_피드만_요청_없이_실패(web, monkeypatch):
    def missing():
        raise http.SecUserAgentMissing()

    monkeypatch.setattr(svc, "get_sec_session", missing)
    feed = next(feed for feed in svc.FEEDS if feed.key == "sec_press")
    with pytest.raises(svc.FeedFetchError, match="SEC_USER_AGENT 미설정"):
        svc.fetch_feed(feed)
    assert web.calls == []


def test_너무_큰_응답은_피드가_아닌_것으로_본다(web):
    web.outcomes[URL["investing_stock"]] = (200, b"x" * (svc.MAX_FEED_BYTES + 1))
    with pytest.raises(svc.FeedFetchError, match="응답이 너무 큼"):
        svc.fetch_feed(svc.FEEDS[0])
    assert web.responses[-1].closed


def test_큰_응답은_상한을_넘는_순간_끊고_끝까지_받지_않는다(web):
    # 회귀(COL-4): 예전에는 stream 없이 받아 본문 전체를 메모리에 받은 뒤에야 크기를 봤습니다. 끝없이 오는 본문도 상한 + 한 조각에서 멈춰야 합니다.
    def endless():
        while True:
            yield b"x" * svc.READ_CHUNK_BYTES

    response = _Response(200, chunks=endless())
    web.outcomes[URL["investing_stock"]] = response
    with pytest.raises(svc.FeedFetchError, match="응답이 너무 큼"):
        svc.fetch_feed(svc.FEEDS[0])

    assert web.streamed == [True]
    assert svc.MAX_FEED_BYTES < response.read_bytes <= svc.MAX_FEED_BYTES + svc.READ_CHUNK_BYTES
    assert response.closed


def test_Content_Length가_상한을_넘으면_본문을_받지_않는다(web):
    response = _Response(200, b"<rss/>", headers={"Content-Length": str(svc.MAX_FEED_BYTES + 1)})
    web.outcomes[URL["investing_stock"]] = response
    with pytest.raises(svc.FeedFetchError, match="응답이 너무 큼"):
        svc.fetch_feed(svc.FEEDS[0])
    assert response.read_bytes == 0 and response.closed


def test_받는_도중_끊기면_그_피드의_실패이고_응답을_닫는다(web):
    def broken():
        yield b"<rss>"
        raise requests.exceptions.ChunkedEncodingError("Connection broken: IncompleteRead")

    response = _Response(200, chunks=broken())
    web.outcomes[URL["investing_stock"]] = response
    with pytest.raises(svc.FeedFetchError, match="ChunkedEncodingError"):
        svc.fetch_feed(svc.FEEDS[0])
    assert response.closed


def test_HTTP_오류_응답도_닫는다(web):
    web.outcomes[URL["investing_stock"]] = (503, b"busy")
    with pytest.raises(svc.FeedFetchError, match="HTTP 503"):
        svc.fetch_feed(svc.FEEDS[0])
    assert web.responses[-1].closed and web.responses[-1].read_bytes == 0


# ==============================================================================
# 4. 태스크 (PostgreSQL)
# ==============================================================================
def _rows(store, dataset: str = catalog.OBS_NEWS_HEADLINE) -> dict[str, tuple[date, dict]]:
    with store.connection() as conn:
        found = conn.execute(
            "SELECT obs_date, entity, payload FROM observations WHERE dataset = %s", (dataset,),
        ).fetchall()
    return {row["entity"]: (row["obs_date"], row["payload"]) for row in found}


def _status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_NEWS_STATUS).payload


def _by_title(rows: dict) -> dict[str, tuple[date, dict]]:
    return {payload["title"]: (day, payload) for day, payload in rows.values()}


def test_여덟_피드를_받아_7일_안의_항목만_저장한다(store, web):
    detail = task_module.task_news_headlines()

    rows = _rows(store)
    # 인베스팅 12건(10-23~10-25, 외환 3건 포함) + SEC 3건(10-20·10-23). 연준(10-13 이전)·BLS(10-14 이전)는 보관 기한(10-18) 밖이라 넣지 않습니다.
    assert len(rows) == 15
    assert {payload["feed"] for _, payload in rows.values()} == {
        "investing_stock", "investing_ind", "investing_economy", "investing_forex", "sec_press"}
    day, payload = _by_title(rows)["Trump announces Audi will build $4 billion US factory in Georgia"]
    assert day == date(2026, 10, 25)
    assert payload == {
        "title": "Trump announces Audi will build $4 billion US factory in Georgia",
        "link": "https://www.investing.com/news/stock-market-news/"
                "trump-set-to-announce-plan-by-audi-to-build-us-factory-in-georgia-source-says-4970975",
        "source": "Investing.com",
        "feed": "investing_stock",
        "feeds": ["investing_stock"],
        "publishedAt": "2026-10-25T02:48:34+00:00",
        "fetchedAt": "2026-10-25T07:00:00+00:00",
    }
    assert rows[svc.title_entity(payload["title"])][1] == payload
    sec_day, sec = _by_title(rows)["SEC Announces Fiscal Year 2027 Examination Priorities"]
    assert sec_day == date(2026, 10, 23) and sec["source"] == "SEC" and sec["publishedAt"] == "2026-10-23T14:10:00+00:00"

    status = _status(store)
    assert (status["feedsOk"], status["feedsTotal"], status["failedFeeds"]) == (8, 8, [])
    assert (status["stored7d"], status["insertedThisRun"], status["deletedThisRun"]) == (15, 15, 0)
    assert status["generatedAt"] == "2026-10-25T07:00:00+00:00"
    assert (status["retentionDays"], status["retainedFrom"]) == (7, "2026-10-18")
    assert status["maybeMissed"] == []   # 첫 수집은 늘 전부 처음이라 세지 않습니다
    assert status["feeds"]["fed_monetary"]["skippedOld"] == 3 and status["feeds"]["fed_monetary"]["new"] == 0
    assert status["feeds"]["investing_economy"]["newestAt"] == "2026-10-25T06:00:53+00:00"
    assert status["feeds"]["sec_press"]["lastOkAt"] == "2026-10-25T07:00:00+00:00"
    assert detail == "새 헤드라인 15건 · 피드 8/8 · 7일 보관 15건"

    # 같은 호스트에 잇달아 보낼 때만 쉽니다(인베스팅 셋 사이 2번, BLS 둘 사이 1번). SEC는 속도 제한을 거칩니다.
    assert [seconds for name, seconds in web.calls if name == "sleep"] == [task_module.HOST_SPACING_SECONDS] * 4
    assert web.fetched() == list(URL.values())
    assert ("sec_rate_limit", None) in web.calls


def test_BLS_Atom_항목이_저장되고_미래_시각은_건너뛴다(store, web):
    web.clock["now"] = datetime(2026, 10, 15, 0, 0, tzinfo=timezone.utc)   # 보관 기한 10-08

    detail = task_module.task_news_headlines()

    titles = _by_title(_rows(store))
    day, cpi = titles["CPI for all items increases 0.6% in September; gasoline rises"]
    assert day == date(2026, 10, 14) and cpi["feed"] == "bls_cpi" and cpi["source"] == "BLS"
    assert cpi["publishedAt"] == "2026-10-14T11:50:31+00:00"
    assert cpi["link"] == "https://www.bls.gov/news.release/archives/cpi_10142026.htm"
    assert "Minutes of the Board's discount rate meetings on August 17, September 9, and September 16, 2026" in titles
    assert len(titles) == 2   # BLS CPI 10-14 + 연준 10-13. 고용(10-02)·연준 10-07은 기한 밖
    # 인베스팅 12건·SEC 3건은 지금(10-15)보다 하루 넘게 뒤 — 시간대를 잘못 읽은 것으로 보고 넣지 않습니다.
    assert "미래 시각 15건 건너뜀" in detail
    assert _status(store)["feeds"]["investing_stock"]["skippedFuture"] == 3


def test_피드_하나가_실패해도_나머지는_저장되고_사유가_실행_기록에_남는다(store, web):
    web.outcomes[URL["bls_cpi"]] = http.SourceRejected("www.bls.gov", "HTTP 403")     # 실제 세션이 403을 올리는 모양
    web.outcomes[URL["sec_press"]] = requests.ConnectionError("connection refused")

    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["news_headlines"])

    assert ok is True
    assert len(_rows(store)) == 12   # 인베스팅 12건 — SEC 3건만 빠짐
    recorded = store.read_task_history("news_headlines")[0]
    assert recorded["status"] == "ok"
    assert "피드 6/8" in recorded["detail"]
    assert (f"실패 2개: bls_cpi({_BLS_REJECTED} — BLS 차단(UA)); sec_press(ConnectionError — 서버가 연결을 거부했습니다)"
            in recorded["detail"])
    status = _status(store)
    assert status["feedsOk"] == 6
    assert status["failedFeeds"] == [
        {"feed": "bls_cpi", "source": "BLS", "reason": f"{_BLS_REJECTED} — BLS 차단(UA)"},
        {"feed": "sec_press", "source": "SEC", "reason": "ConnectionError — 서버가 연결을 거부했습니다"},
    ]
    assert status["feeds"]["bls_cpi"]["status"] == "실패" and status["feeds"]["bls_cpi"]["lastOkAt"] is None


def test_HTML_응답은_그_피드만_실패(store, web):
    web.outcomes[URL["investing_ind"]] = (200, b"<!DOCTYPE html><html><body>Please enable JS</body></html>")

    detail = task_module.task_news_headlines()

    assert "investing_ind(RSS·Atom 피드가 아님(HTML 등))" in detail
    assert len(_rows(store)) == 12


def test_전부_실패하면_EmptyResult이고_행과_상태를_그대로_둔다(store, web):
    store.put_snapshot(catalog.SNAP_NEWS_STATUS, {"marker": "이전 상태"})
    store.insert_new_observations(catalog.OBS_NEWS_HEADLINE, [("2026-10-01", "0123456789abcdef", {"title": "old"})])
    for key in FILES:
        web.outcomes[URL[key]] = requests.ConnectionError("Max retries exceeded")

    with pytest.raises(EmptyResult) as caught:
        task_module.task_news_headlines()

    message = str(caught.value)
    assert message.startswith("피드 0/8 — 기존 저장본 유지 · 실패 8개: investing_stock(")
    assert all(f"{key}(" in message for key in FILES)
    assert _status(store) == {"marker": "이전 상태"}
    # 전부 실패한 실행은 보관 정리도 하지 않습니다.
    assert list(_rows(store)) == ["0123456789abcdef"]


def test_같은_제목은_날짜가_달라도_다시_넣지_않는다(store, web):
    task_module.task_news_headlines()
    first = _by_title(_rows(store))["Trump announces Audi will build $4 billion US factory in Georgia"]

    # 다음 날 같은 제목이 대소문자·공백만 바뀌고 시각이 고쳐져 다시 옴 → 날짜가 달라도 새로 넣지 않습니다.
    web.clock["now"] = NOW + timedelta(days=1)
    web.outcomes[URL["investing_stock"]] = (200, _replace(
        _replace(_fixture("investing_stock"), "<pubDate>2026-10-25 02:48:34</pubDate>", "<pubDate>2026-10-26 01:00:00</pubDate>"),
        "<title>Trump announces Audi will build $4 billion US factory in Georgia</title>",
        "<title>  TRUMP announces Audi will build $4 billion US factory\n in Georgia</title>"))

    detail = task_module.task_news_headlines()

    rows = _rows(store)
    assert len(rows) == 15 and detail.startswith("새 헤드라인 0건")
    assert _by_title(rows)["Trump announces Audi will build $4 billion US factory in Georgia"] == first


def test_한_실행_안에서_여러_피드의_같은_제목은_한_행이고_실어_온_피드를_모두_남긴다(store, web):
    # 경제 피드(investing_economy)에 주식 피드(investing_stock)와 같은 제목을 넣음 — 대소문자만 다름.
    web.outcomes[URL["investing_economy"]] = (200, _replace(
        _fixture("investing_economy"), "<title>Should Aggregators block AI Agents?</title>",
        "<title>HSBC SEES cautious optimism in VC and PE activity</title>"))

    task_module.task_news_headlines()

    rows = _rows(store)
    assert len(rows) == 14
    day, payload = rows[svc.title_entity("HSBC sees cautious optimism in VC and PE activity")]
    # 제목·출처·링크는 FEEDS 순서로 먼저 온 피드의 것, feeds에는 실어 온 피드 모두(회귀 COL-1 — 예전에는 처음 피드 하나만 남아
    # news.feeds = [investing_economy]인 설정에서 이 사건이 빠졌습니다).
    assert payload["feed"] == "investing_stock" and payload["title"] == "HSBC sees cautious optimism in VC and PE activity"
    assert payload["feeds"] == ["investing_stock", "investing_economy"]
    assert _status(store)["feeds"]["investing_economy"]["seen"] == 1


def test_다음_실행에서_다른_피드가_같은_제목을_실으면_그_행에_피드_키만_더한다(store, web):
    task_module.task_news_headlines()
    title = "HSBC sees cautious optimism in VC and PE activity"
    before_day, before = _rows(store)[svc.title_entity(title)]
    assert before["feeds"] == ["investing_stock"]

    # 한 시간 뒤 경제 피드가 같은 제목을 시각만 고쳐 실음 → 새 행 없이 feeds에만 더하고, 처음 받은 시각·발행 시각은 그대로(회귀 COL-1).
    web.clock["now"] = NOW + timedelta(hours=1)
    web.outcomes[URL["investing_economy"]] = (200, _replace(
        _fixture("investing_economy"), "<title>Should Aggregators block AI Agents?</title>", f"<title>{title}</title>"))
    detail = task_module.task_news_headlines()

    rows = _rows(store)
    day, after = rows[svc.title_entity(title)]
    assert len(rows) == 15 and detail.startswith("새 헤드라인 0건")
    assert day == before_day
    assert after == {**before, "feeds": ["investing_stock", "investing_economy"]}

    # 같은 피드가 또 실어도 다시 더하지 않습니다.
    web.clock["now"] = NOW + timedelta(hours=2)
    task_module.task_news_headlines()
    assert _rows(store)[svc.title_entity(title)][1]["feeds"] == ["investing_stock", "investing_economy"]


def test_feeds가_없는_예전_행은_feed_하나로_시작해_피드를_더한다(store, web):
    title = "HSBC sees cautious optimism in VC and PE activity"
    old = {"title": title, "link": None, "source": "Investing.com", "feed": "investing_stock",
           "publishedAt": "2026-10-25T02:48:10+00:00", "fetchedAt": "2026-10-25T03:00:00+00:00"}
    store.insert_new_observations(catalog.OBS_NEWS_HEADLINE, [("2026-10-25", svc.title_entity(title), old)])

    assert store.add_headline_feeds(catalog.OBS_NEWS_HEADLINE, CUTOFF.isoformat(), [
        (svc.title_entity(title), "investing_economy"), (svc.title_entity(title), "investing_economy"),
        (svc.title_entity(title), "investing_stock")]) == 1

    assert _rows(store)[svc.title_entity(title)][1] == {**old, "feeds": ["investing_stock", "investing_economy"]}
    # 보관 기한(since)보다 앞 날짜의 행·없는 entity는 건드리지 않습니다.
    assert store.add_headline_feeds(catalog.OBS_NEWS_HEADLINE, "2026-10-26", [(svc.title_entity(title), "sec_press")]) == 0
    assert store.add_headline_feeds(catalog.OBS_NEWS_HEADLINE, CUTOFF.isoformat(), [("ffffffffffffffff", "sec_press")]) == 0
    assert store.add_headline_feeds(catalog.OBS_NEWS_HEADLINE, CUTOFF.isoformat(), []) == 0


def test_7일이_지난_행은_지우고_기한_안은_남긴다(store, web):
    store.insert_new_observations(catalog.OBS_NEWS_HEADLINE, [
        (CUTOFF - timedelta(days=1), "aaaaaaaaaaaaaaaa", {"title": "8일 전"}),
        (CUTOFF, "bbbbbbbbbbbbbbbb", {"title": "7일 전 — 남음"}),
    ])
    store.put_observations(catalog.OBS_FSC_PRICE, "2026-01-02", [{"code": "005930", "close": 1.0}], entity_key="code")

    detail = task_module.task_news_headlines()

    rows = _rows(store)
    assert "aaaaaaaaaaaaaaaa" not in rows and "bbbbbbbbbbbbbbbb" in rows
    assert len(rows) == 16
    assert len(_rows(store, catalog.OBS_FSC_PRICE)) == 1   # 다른 데이터셋은 건드리지 않습니다
    status = _status(store)
    assert (status["deletedThisRun"], status["stored7d"]) == (1, 16)
    assert "7일 보관 16건(지움 1건)" in detail


def test_두_번째_실행은_새것이_없어도_성공이고_누락_가능이_아니다(store, web):
    task_module.task_news_headlines()
    web.clock["now"] = NOW + timedelta(hours=1)

    detail = task_module.task_news_headlines()

    assert detail == "새 헤드라인 0건 · 피드 8/8 · 7일 보관 15건"
    status = _status(store)
    assert status["maybeMissed"] == [] and status["insertedThisRun"] == 0
    assert status["feeds"]["investing_stock"]["seen"] == 3
    # 처음 받은 시각(fetchedAt)은 첫 수집 그대로입니다.
    assert {payload["fetchedAt"] for _, payload in _rows(store).values()} == {"2026-10-25T07:00:00+00:00"}


def test_피드_항목이_모두_처음_보는_것이면_누락_가능(store, web):
    task_module.task_news_headlines()
    web.clock["now"] = NOW + timedelta(hours=1)
    raw = _fixture("investing_stock")
    for old, new in (("Trump announces Audi will build $4 billion US factory in Georgia", "Oil jumps as OPEC trims output"),
                     ("HSBC sees cautious optimism in VC and PE activity", "Treasury yields climb before CPI"),
                     ("Chinese equities face prolonged downturn as earnings forecasts tumble", "Bank shares slide")):
        raw = _replace(raw, f"<title>{old}</title>", f"<title>{new}</title>")
    web.outcomes[URL["investing_stock"]] = (200, raw)

    detail = task_module.task_news_headlines()

    assert _status(store)["maybeMissed"] == ["investing_stock"]
    assert "누락 가능: investing_stock(받은 항목이 모두 처음 봄" in detail
    assert detail.startswith("새 헤드라인 3건")


def test_시각_없는_항목은_세고_저장하지_않는다(store, web):
    web.outcomes[URL["investing_stock"]] = (200, _replace(
        _fixture("investing_stock"), "<pubDate>2026-10-25 02:48:10</pubDate>", ""))

    detail = task_module.task_news_headlines()

    assert "시각 없음 1건 건너뜀" in detail
    assert len(_rows(store)) == 14
    assert _status(store)["feeds"]["investing_stock"]["skippedNoTime"] == 1


def test_시간_상한을_넘으면_남은_피드는_다음_실행으로(store, web):
    web.advance_per_request = 120.0   # 요청마다 120초 — 셋째 요청 뒤 360초 > 300초

    detail = task_module.task_news_headlines()

    assert web.fetched() == [URL["investing_stock"], URL["investing_ind"], URL["investing_economy"]]
    assert "피드 3/8" in detail and "실패 5개: investing_forex(시간 상한(300초) — 다음 실행)" in detail
    assert len(_rows(store)) == 9


def test_실패한_피드의_마지막_성공_시각을_잇는다(store, web):
    task_module.task_news_headlines()
    web.clock["now"] = NOW + timedelta(hours=1)
    web.outcomes[URL["bls_empsit"]] = (503, b"")

    task_module.task_news_headlines()

    entry = _status(store)["feeds"]["bls_empsit"]
    assert entry == {"source": "BLS", "url": URL["bls_empsit"], "status": "실패", "error": "HTTP 503",
                     "lastOkAt": "2026-10-25T07:00:00+00:00"}


def test_상태_스냅샷이_없으면_누락_데이터셋으로_보인다(store, web):
    assert catalog.SNAP_NEWS_STATUS in {entry["name"] for entry in store.missing_datasets()}
    task_module.task_news_headlines()
    assert catalog.SNAP_NEWS_STATUS not in {entry["name"] for entry in store.missing_datasets()}
