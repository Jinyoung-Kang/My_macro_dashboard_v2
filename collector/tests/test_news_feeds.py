"""
tests/test_news_feeds.py
사건 뉴스 RSS의 탄력 주기·조건부 요청(app/tasks/news_feeds·flex — ADR 0040 단계 1, C1·C2).

고정하는 규칙
  1. 간격 표: 미국·한국 피드 모두에 규칙이 있다. 인베스팅닷컴 미국 세션(21:00~07:00 KST) 12~20분·그 밖 45~90분, 연합뉴스 한국 장
     (07:00~16:00 KST) 12~20분·그 밖 45~90분, 공공기관 60~120분. 하한은 인베스팅 12분·그 밖 10분 이상. 활발한 시간은 그 시장 거래일만.
     그 밖에서 뽑은 시각이 다음 활발한 시간의 시작을 넘으면 시작 근처로 당긴다.
  2. 처음(일정 없음)에는 받지 않고 2~25분 안에서 흩어 정한다(첫 배포·재기동 직후 한꺼번에 묻지 않음).
  3. 때가 된 피드만 받는다. 하한(마지막 요청 + floor)·max-age 안이면 때가 됐어도 묻지 않고 미룬다.
  4. 조건부 요청: 직전에 읽은 응답의 ETag·Last-Modified를 보내고 304면 읽지 않는다(행 그대로, 받은 시각은 갱신). 검증 값이 없으면 본문 해시가
     같을 때 읽지 않는다. 형식이 다른 200은 검증 값을 지운다. 미래 시각으로 미룬 항목이 있으면 조건 없이 다시 읽는다.
  5. 거부(403·429·봇 차단)나 Retry-After면 그 피드 간격을 두 배씩(최대 8배), Retry-After가 더 길면 그 뒤로. 받으면 되돌린다.
  6. 요청 전에 다음 시각을 먼저 적는다(끊겨도 다음 틱이 곧바로 다시 묻지 않음).
  7. 틱: flex 태스크는 due()가 참일 때만 실행되고, 할 일이 없던 틱은 실행 기록을 남기지 않는다. 앞선 실행이 아직 돌면 부르지 않는다.
     로컬(POLITE_FETCH_ENABLED 꺼짐)에서도 돈다.
  8. 서비스: 조건부 머리글은 검증 값이 있을 때만, 304는 검증 값을 보냈을 때만 받아들이고, max-age(Age를 뺀)·Retry-After를 읽는다.

외부 네트워크를 쓰지 않습니다 — 가짜 세션이 tests/fixtures/news·news_kr의 응답을 돌려줍니다. 태스크 시험은 PostgreSQL이 필요합니다.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests

from app import catalog, http, krcalendar, tasks
from app.services import news as svc
from app.tasks import flex, news_feeds, runner
from app.tasks import kr_news as kr_task
from app.tasks import news as us_task
from app.tasks.base import EmptyResult

FIXTURES = Path(__file__).parent / "fixtures"
US_FILES = {
    "investing_stock": "news/investing_news_25.xml",
    "investing_ind": "news/investing_news_95.xml",
    "investing_economy": "news/investing_news_14.xml",
    "investing_forex": "news/investing_news_1.xml",
    "fed_monetary": "news/fed_press_monetary.xml",
    "bls_cpi": "news/bls_cpi.xml",
    "bls_empsit": "news/bls_empsit.xml",
    "sec_press": "news/sec_pressreleases.xml",
}
KR_FILES = {
    "bok_press": "news_kr/bok_press.xml",
    "mofe_press": "news_kr/mofe_press.xml",
    "mods_press": "news_kr/mods_press.xml",
    "yna_market": "news_kr/yna_market.xml",
}
FEEDS = {feed.key: feed for feed in (*svc.FEEDS, *svc.KR_FEEDS)}
URL = {key: feed.url for key, feed in FEEDS.items()}
# 검증 값을 주지 않는 피드(2026-11-13 서버 확인 — 한국은행·재정경제부·국가데이터처). 나머지는 ETag·Last-Modified를 줌.
NO_VALIDATORS = {"bok_press", "mofe_press", "mods_press"}
LAST_MODIFIED = "Sun, 25 Oct 2026 06:00:00 GMT"

US_NOW = datetime(2026, 10, 25, 7, 0, tzinfo=timezone.utc)     # KST 10-25(일) 16:00 — 미국·한국 모두 '그 밖'
KR_NOW = datetime(2026, 10, 26, 14, 0, tzinfo=timezone.utc)    # KST 10-26(월) 23:00


def _kst(year, month, day, hour, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone(timedelta(hours=9))).astimezone(timezone.utc)


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
    """
    피드마다 고정본을 주는 가짜 세션 — 검증 값을 주는 피드는 ETag(본문이 바뀌면 바뀜)·Last-Modified를 싣고, 같은 ETag가 오면 304.
    ``override``에 URL → 예외·(상태, 본문, 머리글)을 넣으면 그것을 줍니다. 부른 (세션, URL, 보낸 조건부 머리글)을 기록합니다.
    """

    def __init__(self):
        self.bodies = {URL[key]: (FIXTURES / path).read_bytes() for key, path in {**US_FILES, **KR_FILES}.items()}
        self.override: dict = {}
        self.calls: list[tuple[str, str, dict]] = []
        self.clock = {"now": US_NOW, "mono": 0.0}
        self.due_at_request: dict[str, datetime | None] = {}

    def etag(self, url: str) -> str | None:
        key = next(k for k, u in URL.items() if u == url)
        if key in NO_VALIDATORS:
            return None
        return f'W/"{len(self.bodies[url])}-{hash(self.bodies[url]) & 0xffff:x}"'

    def session(self, name: str):
        web = self

        class _Session:
            def get(self, url, timeout=None, stream=False, headers=None):
                web.calls.append((name, url, dict(headers or {})))
                key = next(k for k, u in URL.items() if u == url)
                task = "news_headlines" if key in US_FILES else "kr_news_headlines"
                web.due_at_request[key] = flex.due_map(task).get(key)
                outcome = web.override.get(url)
                if isinstance(outcome, BaseException):
                    raise outcome
                if outcome is not None:
                    status, body, extra = outcome
                    return _Response(status, body, extra)
                etag = web.etag(url)
                if etag and (headers or {}).get("If-None-Match") == etag:
                    return _Response(304, b"", {"ETag": etag})
                extra = {"ETag": etag, "Last-Modified": LAST_MODIFIED} if etag else {}
                return _Response(200, web.bodies[url], extra)

        return _Session()

    def requested(self) -> list[str]:
        return [next(k for k, u in URL.items() if u == url) for _, url, _ in self.calls]

    def sent_headers(self, key: str) -> list[dict]:
        return [headers for _, url, headers in self.calls if url == URL[key]]


@pytest.fixture()
def web(monkeypatch):
    fake = FakeWeb()
    monkeypatch.setattr(svc, "get_session", lambda: fake.session("default"))
    monkeypatch.setattr(svc, "get_bls_session", lambda: fake.session("bls"))
    monkeypatch.setattr(svc, "get_sec_session", lambda: fake.session("sec"))
    monkeypatch.setattr(svc, "sec_rate_limit", lambda: None)
    for module in (us_task, kr_task):
        monkeypatch.setattr(module, "_now", lambda: fake.clock["now"])
        monkeypatch.setattr(module, "_clock", lambda: fake.clock["mono"])
        monkeypatch.setattr(module, "_sleep", lambda seconds: None)
    monkeypatch.setattr(flex, "_utcnow", lambda: fake.clock["now"])

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return fake


def _make_due(task: str, keys, now: datetime) -> None:
    for key in keys:
        flex.set_due(task, key, now - timedelta(seconds=1))


def _only_due(task: str, keys, now: datetime) -> None:
    """그 태스크의 피드 가운데 ``keys``만 때가 됨 — 나머지는 한참 뒤로."""
    table = US_FILES if task == "news_headlines" else KR_FILES
    for key in table:
        flex.set_due(task, key, now + timedelta(days=2))
    _make_due(task, keys, now)


def _us_status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_NEWS_STATUS).payload


def _kr_status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_KR_NEWS_STATUS).payload


def _rows(store, dataset: str) -> dict:
    with store.connection() as conn:
        found = conn.execute("SELECT entity, payload FROM observations WHERE dataset = %s", (dataset,)).fetchall()
    return {row["entity"]: row["payload"] for row in found}


class _Edge:
    """uniform(a, b)가 늘 한쪽 끝을 주는 난수 — 구간의 끝을 시험합니다."""

    def __init__(self, upper: bool):
        self.upper = upper

    def uniform(self, a, b):
        return b if self.upper else a


# ==============================================================================
# 1. 간격 표와 활발한 시간 (DB·네트워크 없음)
# ==============================================================================
def test_간격_표는_모든_피드를_덮고_하한을_지킨다():
    assert set(news_feeds.CADENCES) == set(svc.FEED_KEYS) | set(svc.KR_FEED_KEYS)
    for key, cadence in news_feeds.CADENCES.items():
        assert cadence.floor_minutes >= news_feeds.MIN_FLOOR_MINUTES, key
        assert cadence.active_minutes[0] >= cadence.floor_minutes and cadence.off_minutes[0] >= cadence.floor_minutes, key
        if key.startswith("investing_"):
            assert cadence.floor_minutes >= news_feeds.INVESTING_FLOOR_MINUTES == 12.0
            assert (cadence.market, cadence.active_minutes, cadence.off_minutes) == ("us", (12.0, 20.0), (45.0, 90.0))
    assert news_feeds.CADENCES["yna_market"].market == "kr"
    assert news_feeds.CADENCES["yna_market"].active_minutes == (12.0, 20.0)
    for key in ("fed_monetary", "bls_cpi", "bls_empsit", "sec_press", "bok_press", "mofe_press", "mods_press"):
        cadence = news_feeds.CADENCES[key]
        assert (cadence.market, cadence.active_minutes, cadence.off_minutes) == (None, (60.0, 120.0), (60.0, 120.0)), key
    assert news_feeds.BACKOFF_MAX_LEVEL == 3 and news_feeds.FIRST_MINUTES == (2.0, 25.0)
    assert news_feeds.HOST_SPACING_SECONDS == (2.0, 5.0)


@pytest.mark.parametrize("moment, active", [
    (_kst(2026, 11, 13, 20, 59), False),     # 금 — 시작 전
    (_kst(2026, 11, 13, 21, 0), True),       # 금 21:00 — 금요일 세션
    (_kst(2026, 11, 14, 3, 0), True),        # 토 03:00 — 아직 금요일 세션
    (_kst(2026, 11, 14, 7, 0), False),       # 토 07:00 — 끝(포함하지 않음)
    (_kst(2026, 11, 14, 21, 30), False),     # 토요일 세션은 없음
    (_kst(2026, 11, 16, 6, 59), False),      # 월 06:59 — 일요일 세션(없음)
    (_kst(2026, 11, 16, 21, 30), True),      # 월 세션
    (_kst(2026, 11, 26, 21, 30), False),     # 추수감사절 세션
    (_kst(2026, 11, 27, 2, 0), False),       # 추수감사절 세션의 새벽
    (_kst(2026, 11, 27, 21, 30), True),      # 추수감사절 다음 날(조기 폐장이어도 거래일)
])
def test_미국_활발한_시간은_KST_21시부터_7시까지_그_세션이_거래일일_때(moment, active):
    assert news_feeds.is_active("us", moment) is active


def test_한국_활발한_시간은_KST_7시부터_16시까지_거래일(monkeypatch):
    monkeypatch.setattr(krcalendar, "_holidays", {"2026-11-17"})
    assert news_feeds.is_active("kr", _kst(2026, 11, 16, 7, 0)) is True
    assert news_feeds.is_active("kr", _kst(2026, 11, 16, 15, 59)) is True
    assert news_feeds.is_active("kr", _kst(2026, 11, 16, 16, 0)) is False
    assert news_feeds.is_active("kr", _kst(2026, 11, 16, 6, 59)) is False
    assert news_feeds.is_active("kr", _kst(2026, 11, 14, 10, 0)) is False     # 토
    assert news_feeds.is_active("kr", _kst(2026, 11, 17, 10, 0)) is False     # 휴장일
    assert news_feeds.is_active(None, _kst(2026, 11, 16, 10, 0)) is False


@pytest.mark.parametrize("upper", [False, True])
def test_다음_시각은_활발할_때와_그_밖의_구간_끝_안(monkeypatch, upper):
    monkeypatch.setattr(news_feeds, "_rng", _Edge(upper))
    active_now = _kst(2026, 11, 16, 22, 0)        # 월 미국 세션
    off_now = _kst(2026, 11, 16, 9, 0)            # 미국 세션 밖, 다음 시작(21:00)까지 12시간
    pick = (lambda pair: pair[1]) if upper else (lambda pair: pair[0])
    assert news_feeds.draw_next("investing_stock", active_now) == active_now + timedelta(minutes=pick((12, 20)))
    assert news_feeds.draw_next("investing_stock", off_now) == off_now + timedelta(minutes=pick((45, 90)))
    assert news_feeds.draw_next("fed_monetary", active_now) == active_now + timedelta(minutes=pick((60, 120)))


def test_그_밖에서_뽑은_시각이_활발한_시간_시작을_넘으면_시작_근처로_당긴다(monkeypatch):
    monkeypatch.setattr(news_feeds, "_rng", _Edge(upper=True))
    now = _kst(2026, 11, 13, 20, 40)              # 금 20:40 — 그 밖(45~90분), 21:00에 금요일 세션 시작
    # 위쪽 끝 90분(22:10)은 시작을 넘으므로 시작 + 0~12분의 위쪽 끝(21:12)으로 당깁니다.
    assert news_feeds.draw_next("investing_stock", now) == _kst(2026, 11, 13, 21, 12)
    # 물러난 피드(level ≥ 1)는 당기지 않습니다.
    assert news_feeds.draw_next("investing_stock", now, level=1) == now + timedelta(minutes=180)
    # 토요일 저녁은 세션이 없어(다음은 월 21:00) 당기지 않습니다.
    saturday = _kst(2026, 11, 14, 20, 40)
    assert news_feeds.draw_next("investing_stock", saturday) == saturday + timedelta(minutes=90)


def test_물러남은_두_배씩_최대_8배이고_Retry_After와_max_age보다_앞서지_않는다(monkeypatch):
    monkeypatch.setattr(news_feeds, "_rng", _Edge(upper=False))
    now = _kst(2026, 11, 16, 10, 0)
    assert news_feeds.draw_next("fed_monetary", now, level=1) == now + timedelta(minutes=120)
    assert news_feeds.draw_next("fed_monetary", now, level=3) == now + timedelta(minutes=480)
    assert news_feeds.draw_next("fed_monetary", now, retry_after=4 * 3600) == now + timedelta(hours=4)
    fresh = now + timedelta(hours=3)
    assert news_feeds.draw_next("fed_monetary", now, fresh_until=fresh) == fresh


def test_하한_시각은_마지막_요청_뒤_floor와_max_age_가운데_늦은_것():
    last = "2026-11-16T01:00:00+00:00"
    assert news_feeds.hold_until("investing_stock", {"lastRequestAt": last}) == datetime(2026, 11, 16, 1, 12, tzinfo=timezone.utc)
    assert news_feeds.hold_until("sec_press", {"lastRequestAt": last}) == datetime(2026, 11, 16, 1, 10, tzinfo=timezone.utc)
    # 예전(이 ADR 전) 줄은 lastRequestAt이 없어 마지막 성공 시각으로 봅니다.
    assert news_feeds.hold_until("sec_press", {"lastOkAt": last}) == datetime(2026, 11, 16, 1, 10, tzinfo=timezone.utc)
    late = "2026-11-16T02:00:00+00:00"
    assert news_feeds.hold_until("sec_press", {"lastRequestAt": last, "freshUntil": late}) == datetime(2026, 11, 16, 2, 0,
                                                                                                         tzinfo=timezone.utc)
    assert news_feeds.hold_until("sec_press", {}) is None


# ==============================================================================
# 2·3·6. 처음·때가 된 피드만·하한·먼저 적기 (PostgreSQL)
# ==============================================================================
def test_처음에는_받지_않고_2_25분_안에서_흩어_정한다(store, web):
    with pytest.raises(EmptyResult, match=r"피드 일정 처음 정함 8개 — 정한 직후에는 받지 않음 · 다음 .* · 외부 호출 0회"):
        us_task.task_news_headlines()

    assert web.calls == []
    schedule = flex.due_map("news_headlines")
    assert set(schedule) == set(US_FILES)
    assert all(timedelta(minutes=2) <= when - US_NOW <= timedelta(minutes=25) for when in schedule.values())
    assert len(set(schedule.values())) == len(schedule), "피드마다 다른 시각"
    assert store.read_snapshot(catalog.SNAP_NEWS_STATUS) is None
    # 다시 불러도 때가 아니면 받지 않습니다.
    assert us_task.due() is False
    with pytest.raises(EmptyResult, match="때가 된 피드 없음"):
        us_task.task_news_headlines()
    assert web.calls == []


def test_때가_된_피드만_받고_요청_전에_다음_시각을_먼저_적는다(store, web):
    for key in US_FILES:
        flex.set_due("news_headlines", key, US_NOW + timedelta(hours=1))
    _make_due("news_headlines", ["investing_ind", "fed_monetary"], US_NOW)
    assert us_task.due() is True

    detail = us_task.task_news_headlines()

    assert web.requested() == ["investing_ind", "fed_monetary"]
    assert detail.startswith("새 헤드라인 3건 · 받은 피드 2/2(새 본문 2)")
    # 요청하는 순간에 이미 다음 시각이 지금 뒤로 적혀 있었습니다(실행이 끊겨도 다음 틱이 곧바로 다시 묻지 않음).
    assert all(web.due_at_request[key] > US_NOW for key in ("investing_ind", "fed_monetary"))
    status = _us_status(store)
    assert set(status["feeds"]) == {"investing_ind", "fed_monetary"}
    assert (status["feedsOk"], status["feedsTotal"]) == (2, 8)
    assert status["thisRun"] == {"requested": ["investing_ind", "fed_monetary"], "changed": 2, "notModified": 0,
                                 "unchanged": 0, "failed": 0, "unsent": [], "deferred": []}
    # 10-25(일) 16:00 KST는 미국 세션 밖 — 인베스팅 45~90분, 연준 60~120분.
    schedule = flex.due_map("news_headlines")
    assert timedelta(minutes=45) <= schedule["investing_ind"] - US_NOW <= timedelta(minutes=90)
    assert timedelta(minutes=60) <= schedule["fed_monetary"] - US_NOW <= timedelta(minutes=120)
    assert status["feeds"]["investing_ind"]["nextDueAt"] == schedule["investing_ind"].isoformat(timespec="seconds")
    assert status["nextFeed"] in US_FILES and status["nextDueAt"] is not None


def test_하한_안이면_때가_됐어도_묻지_않고_미룬다(store, web):
    store.put_snapshot(catalog.SNAP_NEWS_STATUS, {"feeds": {
        "investing_stock": {"status": "ok", "lastRequestAt": (US_NOW - timedelta(minutes=5)).isoformat()},
        "sec_press": {"status": "ok", "freshUntil": (US_NOW + timedelta(seconds=30)).isoformat()},
    }})
    for key in US_FILES:
        flex.set_due("news_headlines", key, US_NOW + timedelta(hours=1))
    _make_due("news_headlines", ["investing_stock", "sec_press"], US_NOW)

    with pytest.raises(EmptyResult, match=r"하한 간격·max-age 안이라 미룸\(investing_stock, sec_press\)"):
        us_task.task_news_headlines()

    assert web.calls == []
    schedule = flex.due_map("news_headlines")
    hold = US_NOW + timedelta(minutes=7)          # 마지막 요청 + 12분
    assert hold <= schedule["investing_stock"] <= hold + timedelta(seconds=news_feeds.HOLD_JITTER_SECONDS)
    fresh = US_NOW + timedelta(seconds=30)
    assert fresh <= schedule["sec_press"] <= fresh + timedelta(seconds=news_feeds.HOLD_JITTER_SECONDS)


# ==============================================================================
# 4. 조건부 요청
# ==============================================================================
def test_304면_읽지_않고_행은_그대로_받은_시각은_갱신한다(store, web, monkeypatch):
    _make_due("news_headlines", US_FILES, US_NOW)
    us_task.task_news_headlines()
    rows_before = _rows(store, catalog.OBS_NEWS_HEADLINE)
    first = _us_status(store)
    assert first["feeds"]["investing_stock"]["etag"] == web.etag(URL["investing_stock"])
    assert first["feeds"]["investing_stock"]["lastModified"] == LAST_MODIFIED

    def no_parse(*args, **kwargs):
        raise AssertionError("304에 본문을 읽었습니다")

    monkeypatch.setattr(svc, "parse_feed", no_parse)
    later = US_NOW + timedelta(hours=3)
    web.clock["now"] = later
    _make_due("news_headlines", US_FILES, later)
    detail = us_task.task_news_headlines()

    assert detail.startswith("새 헤드라인 0건 · 받은 피드 8/8(304 8) · 7일 보관 15건")
    sent = web.sent_headers("investing_stock")[-1]
    assert sent == {"If-None-Match": web.etag(URL["investing_stock"]), "If-Modified-Since": LAST_MODIFIED}
    assert _rows(store, catalog.OBS_NEWS_HEADLINE) == rows_before
    status = _us_status(store)
    entry = status["feeds"]["investing_stock"]
    stamp = later.isoformat(timespec="seconds")
    assert (entry["lastResult"], entry["lastOkAt"], entry["lastRequestAt"]) == ("notModified", stamp, stamp)
    assert entry["lastChangedAt"] == US_NOW.isoformat(timespec="seconds")
    assert entry["etag"] == web.etag(URL["investing_stock"]), "304가 ETag를 싣지 않아도 직전 값을 잇습니다"
    assert entry["entries"] == 3 and entry["new"] == 3, "마지막으로 읽은 본문의 수는 그대로"
    assert entry["notModifiedTotal"] == 1
    assert entry["today"] == {"date": "2026-10-25", "requests": 2, "changed": 1, "notModified": 1, "unchanged": 0, "failed": 0,
                              "rejected": 0}
    assert status["generatedAt"] == stamp and status["insertedThisRun"] == 0


def test_검증_값이_없으면_같은_본문을_읽지_않는다(store, web, monkeypatch):
    web.clock["now"] = KR_NOW
    _make_due("kr_news_headlines", KR_FILES, KR_NOW)
    kr_task.task_kr_news_headlines()
    parsed = []
    original = svc.parse_feed
    monkeypatch.setattr(svc, "parse_feed", lambda *a, **k: parsed.append(k.get("feed").key) or original(*a, **k))

    later = KR_NOW + timedelta(hours=2)
    web.clock["now"] = later
    web.bodies[URL["mods_press"]] += b"\n"            # 국가데이터처만 본문이 바뀜
    _make_due("kr_news_headlines", KR_FILES, later)
    detail = kr_task.task_kr_news_headlines()

    assert parsed == ["mods_press"]
    assert "받은 피드 4/4(새 본문 1 · 304 1 · 같은 본문 2)" in detail
    assert web.sent_headers("mofe_press")[-1] == {}, "검증 값을 주지 않는 피드에는 조건부 머리글을 보내지 않습니다"
    feeds = _kr_status(store)["feeds"]
    assert (feeds["mofe_press"]["lastResult"], feeds["bok_press"]["lastResult"]) == ("unchanged", "unchanged")
    assert feeds["yna_market"]["lastResult"] == "notModified"
    assert feeds["mofe_press"]["timeFormat"] == "date_only"


def test_형식이_다른_200은_검증_값을_지우고_다음에는_조건_없이_받는다(store, web):
    _only_due("news_headlines", ["investing_stock"], US_NOW)
    us_task.task_news_headlines()
    web.override[URL["investing_stock"]] = (200, b"<!DOCTYPE html><html>maintenance</html>", {"ETag": '"bad"'})

    later = US_NOW + timedelta(hours=1)
    web.clock["now"] = later
    _only_due("news_headlines", ["investing_stock"], later)
    with pytest.raises(EmptyResult, match="RSS·Atom 피드가 아님"):
        us_task.task_news_headlines()
    entry = _us_status(store)["feeds"]["investing_stock"]
    assert (entry["status"], entry["etag"], entry["lastModified"]) == ("실패", None, None)
    assert entry["backoff"] == 0, "형식이 다른 응답은 거부가 아니라 간격을 늘리지 않습니다"

    del web.override[URL["investing_stock"]]
    again = later + timedelta(hours=1)
    web.clock["now"] = again
    _only_due("news_headlines", ["investing_stock"], again)
    us_task.task_news_headlines()
    assert web.sent_headers("investing_stock")[-1] == {}
    assert _us_status(store)["feeds"]["investing_stock"]["lastResult"] == "unchanged"


def test_미래_시각으로_미룬_항목이_있으면_조건_없이_다시_읽는다(store, web):
    early = datetime(2026, 10, 15, 0, 0, tzinfo=timezone.utc)   # 인베스팅 항목(10-23~10-25)이 하루 넘게 미래
    web.clock["now"] = early
    _only_due("news_headlines", ["investing_stock"], early)
    us_task.task_news_headlines()
    assert _us_status(store)["feeds"]["investing_stock"]["skippedFuture"] == 3
    assert _rows(store, catalog.OBS_NEWS_HEADLINE) == {}

    web.clock["now"] = US_NOW                                    # 본문은 같지만 이제 넣을 수 있음
    _only_due("news_headlines", ["investing_stock"], US_NOW)
    detail = us_task.task_news_headlines()

    assert web.sent_headers("investing_stock")[-1] == {}, "미룬 항목이 있으면 검증 값을 보내지 않습니다"
    assert detail.startswith("새 헤드라인 3건 · 받은 피드 1/1(새 본문 1)")
    assert _us_status(store)["feeds"]["investing_stock"]["skippedFuture"] == 0


# ==============================================================================
# 5. 거부 뒤 물러남
# ==============================================================================
def test_거부되면_간격을_두_배로_늘리고_받으면_되돌린다(store, web):
    web.override[URL["bls_cpi"]] = http.SourceRejected("www.bls.gov", "HTTP 403")
    web.clock["now"] = _kst(2026, 11, 16, 10, 0)
    now = web.clock["now"]
    _only_due("news_headlines", ["bls_cpi", "fed_monetary"], now)
    us_task.task_news_headlines()

    entry = _us_status(store)["feeds"]["bls_cpi"]
    assert (entry["status"], entry["backoff"], entry["today"]["rejected"]) == ("실패", 1, 1)
    assert timedelta(minutes=120) <= flex.due_map("news_headlines")["bls_cpi"] - now <= timedelta(minutes=240)

    # 거부가 이어지면 4배·8배에서 멈춥니다. 다른 피드(연준)는 정상이라 실행은 성공으로 남고 실패를 적습니다(예전 매시 실행과 같은 모양).
    for level in (2, 3, 3):
        now += timedelta(hours=20)
        web.clock["now"] = now
        _only_due("news_headlines", ["bls_cpi"], now)
        detail = us_task.task_news_headlines()
        assert detail.startswith("새 헤드라인 0건 · 받은 피드 0/1 · 다른 피드 정상 1/8 · 실패 1개: bls_cpi(")
        assert _us_status(store)["feeds"]["bls_cpi"]["backoff"] == level
    assert timedelta(minutes=480) <= flex.due_map("news_headlines")["bls_cpi"] - now <= timedelta(minutes=960)

    # 받으면 되돌립니다.
    del web.override[URL["bls_cpi"]]
    now += timedelta(hours=20)
    web.clock["now"] = now
    _only_due("news_headlines", ["bls_cpi"], now)
    us_task.task_news_headlines()
    entry = _us_status(store)["feeds"]["bls_cpi"]
    assert (entry["status"], entry["backoff"]) == ("ok", 0)
    assert timedelta(minutes=60) <= flex.due_map("news_headlines")["bls_cpi"] - now <= timedelta(minutes=120)


def test_Retry_After가_간격보다_길면_그_뒤로(store, web):
    web.override[URL["sec_press"]] = http.SourceRejected("www.sec.gov", "HTTP 429", retry_after=6 * 3600)
    web.override[URL["fed_monetary"]] = (503, b"", {"Retry-After": "18000"})
    now = web.clock["now"]
    _only_due("news_headlines", ["fed_monetary", "sec_press"], now)

    with pytest.raises(EmptyResult):
        us_task.task_news_headlines()

    schedule = flex.due_map("news_headlines")
    assert schedule["sec_press"] >= now + timedelta(hours=6)
    assert schedule["fed_monetary"] >= now + timedelta(hours=5)
    feeds = _us_status(store) if store.read_snapshot(catalog.SNAP_NEWS_STATUS) else None
    assert feeds is None, "저장본이 아직 없으면 실패만으로 쓰지 않습니다"


# ==============================================================================
# 7. 틱
# ==============================================================================
def test_틱은_때가_된_태스크만_부르고_할_일이_없으면_기록을_남기지_않는다(store, web, monkeypatch):
    monkeypatch.delenv("POLITE_FETCH_ENABLED", raising=False)     # 로컬(차단 통과 수집 꺼짐)에서도 돕니다
    for key in US_FILES:
        flex.set_due("news_headlines", key, US_NOW + timedelta(hours=1))
    for key in KR_FILES:
        flex.set_due("kr_news_headlines", key, US_NOW + timedelta(hours=1))
    flex.set_due("us_bls_actuals", "next", US_NOW + timedelta(hours=1))       # 같은 flex 군의 BLS 태스크도 때가 아님

    assert tasks.run_flex_due() == []
    assert store.read_task_history("news_headlines") == [] and store.read_task_history("kr_news_headlines") == []
    assert web.calls == []

    _make_due("news_headlines", ["sec_press"], US_NOW)
    assert tasks.run_flex_due() == ["news_headlines"]
    history = store.read_task_history("news_headlines")
    assert len(history) == 1 and history[0]["speed"] == "flex" and history[0]["status"] == "ok"
    assert web.requested() == ["sec_press"]
    assert store.read_task_history("kr_news_headlines") == []


def test_틱은_앞선_실행이_아직_돌면_그_태스크를_부르지_않는다(monkeypatch):
    called = []
    monkeypatch.setattr(runner, "run_group", lambda **kwargs: called.append(kwargs["task_name"]))
    monkeypatch.setattr(us_task, "due", lambda: True)
    monkeypatch.setattr(kr_task, "due", lambda: True)
    monkeypatch.setitem(tasks.TASKS_BY_NAME, "news_headlines", tasks.TASKS_BY_NAME["news_headlines"])
    patched = [task if task.speed != flex.SPEED else type(task)(task.name, task.speed, task.run, task.description, task.yahoo,
                                                                   lambda: True)
               for task in runner.ALL_TASKS]
    monkeypatch.setattr(runner, "ALL_TASKS", tuple(patched))
    monkeypatch.setitem(runner._inflight, "news_headlines", runner._InFlight())

    assert runner.run_flex_due() == ["kr_news_headlines", "us_bls_actuals"]
    assert called == ["kr_news_headlines", "us_bls_actuals"]


def test_틱이_일정을_읽지_못하면_그_태스크만_건너뛴다(monkeypatch):
    called = []
    monkeypatch.setattr(runner, "run_group", lambda **kwargs: called.append(kwargs["task_name"]))

    def broken():
        raise RuntimeError("표를 읽지 못함")

    patched = [task if task.speed != flex.SPEED else type(task)(task.name, task.speed, task.run, task.description, task.yahoo,
                                                                   broken if task.name == "news_headlines" else (lambda: True))
               for task in runner.ALL_TASKS]
    monkeypatch.setattr(runner, "ALL_TASKS", tuple(patched))

    assert runner.run_flex_due() == ["kr_news_headlines", "us_bls_actuals"]


def test_flex_태스크는_뉴스_둘과_BLS이고_due가_있다():
    flex_tasks = [task for task in tasks.ALL_TASKS if task.speed == flex.SPEED]
    assert [task.name for task in flex_tasks] == ["news_headlines", "kr_news_headlines", "us_bls_actuals"]
    assert all(task.due is not None for task in flex_tasks)
    assert all(task.due is None for task in tasks.ALL_TASKS if task.speed != flex.SPEED)
    assert tasks.TASK_DEADLINE_SECONDS["flex"] == 600.0


def test_일정_이름은_태스크_슬래시_피드이고_polite_줄과_섞이지_않는다(store):
    store.set_fetch_due_at("econ_calendar_tradingview", datetime(2026, 11, 16, tzinfo=timezone.utc))
    store.set_fetch_due_at("news_headlinesX/odd", datetime(2026, 11, 16, tzinfo=timezone.utc))
    flex.set_due("news_headlines", "sec_press", datetime(2026, 11, 17, tzinfo=timezone.utc))
    flex.set_due("kr_news_headlines", "bok_press", datetime(2026, 11, 18, tzinfo=timezone.utc))

    assert flex.key("news_headlines", "sec_press") == "news_headlines/sec_press"
    assert flex.due_map("news_headlines") == {"sec_press": datetime(2026, 11, 17, tzinfo=timezone.utc)}
    assert flex.due_map("kr_news_headlines") == {"bok_press": datetime(2026, 11, 18, tzinfo=timezone.utc)}


# ==============================================================================
# 8. 서비스 — 조건부 요청·max-age·Retry-After (네트워크 없음)
# ==============================================================================
class _RecordingSession:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.kwargs: list[dict] = []

    def get(self, url, **kwargs):
        self.kwargs.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


def _with_session(monkeypatch, session) -> None:
    monkeypatch.setattr(svc, "get_session", lambda: session)


def test_검증_값이_없으면_조건부_머리글을_넘기지_않는다(monkeypatch):
    session = _RecordingSession(_Response(200, b"<rss/>", {"ETag": '"a"', "Cache-Control": "public, max-age=42", "Age": "2"}))
    _with_session(monkeypatch, session)

    reply = svc.fetch_feed_conditional(FEEDS["investing_stock"])

    assert "headers" not in session.kwargs[0], "검증 값이 없으면 예전 요청과 같습니다"
    assert (reply.status, reply.content, reply.etag, reply.max_age) == (200, b"<rss/>", '"a"', 40)


def test_검증_값을_보내고_304를_받는다(monkeypatch):
    session = _RecordingSession(_Response(304, b"", {}))
    _with_session(monkeypatch, session)

    reply = svc.fetch_feed_conditional(FEEDS["investing_stock"], etag='W/"1"', last_modified=LAST_MODIFIED)

    assert session.kwargs[0]["headers"] == {"If-None-Match": 'W/"1"', "If-Modified-Since": LAST_MODIFIED}
    assert (reply.status, reply.content, reply.etag, reply.last_modified) == (304, None, None, None)


def test_검증_값_없이_온_304는_실패(monkeypatch):
    _with_session(monkeypatch, _RecordingSession(_Response(304, b"", {})))
    with pytest.raises(svc.FeedFetchError, match="HTTP 304"):
        svc.fetch_feed_conditional(FEEDS["investing_stock"])


def test_5xx의_Retry_After와_거부의_Retry_After를_싣는다(monkeypatch):
    _with_session(monkeypatch, _RecordingSession(_Response(503, b"", {"Retry-After": "120"})))
    with pytest.raises(svc.FeedFetchError) as caught:
        svc.fetch_feed_conditional(FEEDS["investing_stock"])
    assert (str(caught.value), caught.value.rejected, caught.value.retry_after) == ("HTTP 503", False, 120.0)

    _with_session(monkeypatch, _RecordingSession(error=http.SourceRejected("www.investing.com", "HTTP 429", retry_after=600)))
    with pytest.raises(svc.FeedFetchError) as caught:
        svc.fetch_feed_conditional(FEEDS["investing_stock"])
    assert (caught.value.rejected, caught.value.retry_after) == (True, 600)
    assert str(caught.value) == "거부됨 — www.investing.com HTTP 429 · 5분 동안 이 출처 호출을 멈춤"


@pytest.mark.parametrize("headers, expected", [
    ({"Cache-Control": "public, max-age=48"}, 48),
    ({"Cache-Control": "max-age=48", "Age": "18"}, 30),
    ({"Cache-Control": "max-age=10", "Age": "18"}, None),
    ({"Cache-Control": "no-cache"}, None),
    ({"Cache-Control": "no-store, max-age=60"}, None),
    ({"Cache-Control": "private"}, None),
    ({"Cache-Control": "s-maxage=60"}, None),
    ({}, None),
])
def test_max_age는_Age를_빼고_no_cache면_없음(headers, expected):
    assert svc.cache_max_age(headers) == expected


def test_today_셈은_KST_날짜가_바뀌면_전날로_넘긴다():
    entry = {"today": {"date": "2026-11-15", "requests": 9, "changed": 2, "notModified": 6, "unchanged": 0, "failed": 1,
                       "rejected": 0}}
    today, previous = news_feeds._today(entry, _kst(2026, 11, 16, 0, 5))
    assert today == {"date": "2026-11-16", "requests": 0, "changed": 0, "notModified": 0, "unchanged": 0, "failed": 0,
                     "rejected": 0}
    assert previous == entry["today"]
    same, kept = news_feeds._today({**entry, "previousDay": {"date": "2026-11-14"}}, _kst(2026, 11, 15, 23, 0))
    assert same["requests"] == 9 and kept == {"date": "2026-11-14"}


def test_KST_날짜는_한국_날짜다():
    assert news_feeds._today({}, datetime(2026, 11, 15, 15, 30, tzinfo=timezone.utc))[0]["date"] == date(2026, 11, 16).isoformat()


# ==============================================================================
# 검토에서 고친 것 — 실제 보낸 시각·서버 지시 상한·호스트 단위 거부·래치·저장 시각
# ==============================================================================
def test_하한과_다음_시각은_피드를_실제로_보낸_시각에서_잰다(store, web, monkeypatch):
    original = web.session

    def slow_session(name):
        inner = original(name)

        class _Session:
            def get(self, url, **kwargs):
                response = inner.get(url, **kwargs)
                web.clock["now"] += timedelta(seconds=30)           # 요청마다 30초 걸림
                return response

        return _Session()

    monkeypatch.setattr(web, "session", slow_session)
    monkeypatch.setattr(news_feeds, "_rng", _Edge(upper=False))
    now = _kst(2026, 11, 16, 22, 0)                                   # 미국 세션 — 인베스팅 12~20분(아래쪽 끝 12분)
    web.clock["now"] = now
    _only_due("news_headlines", ["investing_stock", "investing_ind"], now)

    us_task.task_news_headlines()

    feeds = _us_status(store)["feeds"]
    sent_second = now + timedelta(seconds=30)                         # 둘째 피드는 첫 요청이 끝난 뒤에 나감
    assert feeds["investing_stock"]["lastRequestAt"] == now.isoformat(timespec="seconds")
    assert feeds["investing_ind"]["lastRequestAt"] == sent_second.isoformat(timespec="seconds")
    assert flex.due_map("news_headlines")["investing_ind"] == sent_second + timedelta(minutes=12)
    assert web.due_at_request["investing_ind"] == sent_second + timedelta(minutes=12), "먼저 적는 시각도 보낸 시각에서"


def test_서버_지시는_하루까지만_따른다():
    now = _kst(2026, 11, 16, 10, 0)
    cap = timedelta(seconds=news_feeds.SERVER_WAIT_CAP_SECONDS)
    assert news_feeds.draw_next("fed_monetary", now, retry_after=1e12) == now + cap
    assert news_feeds.draw_next("fed_monetary", now, fresh_until=now + timedelta(days=3650)) == now + cap


def test_max_age가_아주_길어도_하루까지만_묻지_않는다(store, web):
    web.override[URL["sec_press"]] = (200, web.bodies[URL["sec_press"]], {"Cache-Control": "max-age=999999999999"})
    now = web.clock["now"]
    _only_due("news_headlines", ["sec_press"], now)

    us_task.task_news_headlines()

    entry = _us_status(store)["feeds"]["sec_press"]
    assert entry["freshUntil"] == (now + timedelta(days=1)).isoformat(timespec="seconds")
    assert flex.due_map("news_headlines")["sec_press"] == now + timedelta(days=1)


def test_거부한_호스트의_다른_피드는_그_실행에서_보내지_않고_기한_뒤로_미룬다(store, web):
    web.override[URL["investing_stock"]] = http.SourceRejected("www.investing.com", "HTTP 429", retry_after=1800)
    now = _kst(2026, 11, 16, 22, 0)
    web.clock["now"] = now
    _only_due("news_headlines", ["investing_stock", "investing_ind", "fed_monetary"], now)
    flex.set_due("news_headlines", "investing_economy", now + timedelta(minutes=10))    # 기한 안에 때가 될 형제

    detail = us_task.task_news_headlines()

    assert web.requested() == ["investing_stock", "fed_monetary"]
    assert "호스트 거부로 미룸: investing_ind, investing_economy" in detail
    schedule = flex.due_map("news_headlines")
    limit = now + timedelta(seconds=1800)
    for key in ("investing_stock", "investing_ind", "investing_economy"):
        assert schedule[key] >= limit, key
    assert schedule["investing_forex"] == now + timedelta(days=2), "기한보다 늦은 형제는 그대로"
    status = _us_status(store)
    assert status["thisRun"]["deferred"] == ["investing_ind", "investing_economy"]
    assert "investing_ind" not in status["feeds"], "보내지 않은 피드는 요청으로 세지 않습니다"


def test_래치로_닫힌_호스트의_피드는_보내지_않고_세지도_않는다(store, web):
    http.reject_host("www.investing.com", "HTTP 403")           # 다른 실행이 막 닫음(5분)
    now = web.clock["now"]
    store.put_snapshot(catalog.SNAP_NEWS_STATUS, {"feeds": {"investing_stock": {"status": "ok", "backoff": 0}}})
    _only_due("news_headlines", ["investing_stock", "fed_monetary"], now)

    us_task.task_news_headlines()

    assert web.requested() == ["fed_monetary"]
    entry = _us_status(store)["feeds"]["investing_stock"]
    assert entry == {"status": "ok", "backoff": 0}, "요청·거부로 세지 않고 간격도 늘리지 않습니다"
    assert flex.due_map("news_headlines")["investing_stock"] > now + timedelta(minutes=4)


def test_래치가_요청_사이에_걸려도_보낸_요청으로_세지_않는다(store, web):
    web.override[URL["investing_stock"]] = http.SourceRejected("www.investing.com", "HTTP 403", latched=True)
    now = web.clock["now"]
    _only_due("news_headlines", ["investing_stock", "fed_monetary"], now)

    us_task.task_news_headlines()

    status = _us_status(store)
    assert "investing_stock" not in status["feeds"] and status["thisRun"]["deferred"] == ["investing_stock"]


def test_받은_것이_없는_실행은_저장_시각을_바꾸지_않고_다른_피드가_정상이면_성공(store, web):
    _only_due("news_headlines", ["fed_monetary"], web.clock["now"])
    us_task.task_news_headlines()
    before = store.read_snapshot(catalog.SNAP_NEWS_STATUS)

    web.override[URL["bls_cpi"]] = requests.ConnectionError("down")
    later = web.clock["now"] + timedelta(hours=1)
    web.clock["now"] = later
    _only_due("news_headlines", ["bls_cpi"], later)
    detail = us_task.task_news_headlines()

    after = store.read_snapshot(catalog.SNAP_NEWS_STATUS)
    assert after.collected_at == before.collected_at, "받은 것이 없으면 저장 시각을 바꾸지 않습니다(상태 화면의 '오래됨')"
    assert after.payload["generatedAt"] == before.payload["generatedAt"]
    assert after.payload["feeds"]["bls_cpi"]["status"] == "실패"
    assert after.payload["nextFeed"] is not None and after.payload["nextDueAt"] > later.isoformat(), "머리의 다음 시각도 새로"
    assert detail.startswith("새 헤드라인 0건 · 받은 피드 0/1 · 다른 피드 정상 1/8 · 실패 1개: bls_cpi(")


def test_모두_실패_중이면_EmptyResult이고_실패_글에는_다음_시각이_없다(store, web):
    store.put_snapshot(catalog.SNAP_NEWS_STATUS, {"feeds": {"fed_monetary": {"status": "실패", "error": "HTTP 503"}}})
    web.override[URL["fed_monetary"]] = (503, b"", {})
    _only_due("news_headlines", ["fed_monetary"], web.clock["now"])

    with pytest.raises(EmptyResult) as caught:
        us_task.task_news_headlines()

    assert str(caught.value) == "피드 0/1 — 기존 저장본 유지 · 실패 1개: fed_monetary(HTTP 503)"


def test_Retry_After의_숫자가_아닌_글자는_읽지_않는다():
    assert http.retry_after_seconds("²") is None
    assert http.retry_after_seconds("1²") is None
