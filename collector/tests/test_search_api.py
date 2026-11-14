"""
tests/test_search_api.py
정보 검색 경로(/live/search/suggest·resolve·entity·feed)와 결과 묶기(services/search.feed) — 네트워크·DB 없이.

- 입력 검사: q 1~60자, 대상 키 문법, 탭 — 틀리면 400(422가 아님)이고 서비스를 부르지 않음
- external=false: 바깥으로 나가는 요청 0건(공용 세션·yfinance·네이버·Wikidata·SEC 모두), 바깥 출처는 상태 offline
- owner=false: 운영자 전용 저장본(수집 글·거장 견해·속보)을 읽지 않고 상태 owner_only
- 결과: 출처마다 상태 한 줄과 거른 건수, 같은 글은 우선순위 높은 출처 하나, 최신순, 기간별 건수, 2년 밖만 있으면 olderOnlyLatest
- 출처별 캐시(두 번째 부름은 cached, 실패는 그대로 error), 늦은 출처는 상한 시각에 '시간 초과'로
- 공시·리서치 탭은 빈 목록 + later(대상도 풀지 않음)
- 로그에 검색어가 남지 않음
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

import pytest
import requests
from fastapi.testclient import TestClient

from app import main
from app.services import detail, search, search_entities, search_store, search_wikidata
from app.services import search_sources as sources

SECRET = "Synthetic Secret Holdings"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    search.reset_cache()
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    monkeypatch.setattr(search_store, "guru_names", lambda: [])
    # 단계 3의 저장본 출처·사용자 제외 매체 — 시험마다 따로 바꿔 끼우지 않으면 비어 있음(DB 없음).
    monkeypatch.setattr(search_store, "feed_bundle", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "watch_items", lambda key, owner: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "user_excludes", lambda: search.rules.Excludes())
    yield
    search.reset_cache()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "")
    monkeypatch.setattr(main.store, "ping", lambda: None)
    return TestClient(main.app, raise_server_exceptions=False)


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) - delta).astimezone(timezone.utc).isoformat(timespec="seconds")


def _item(title, url, *, source, ago=timedelta(days=1), domain=None, publisher="Example", basis="published", kind="news",
          reader=None):
    return sources.feed_item(title=title, url=url, publisher=publisher, domain=domain or search.rules.domain_of(url),
                             published=_iso(ago) if ago is not None else None, source=source, lang="en", kind=kind,
                             basis=basis, reader_id=reader)


ENTITY = {"key": "us:SCHP", "kind": "company", "name": "합성칩", "nameKo": "합성칩", "nameEn": "SynthChip",
          "aliases": ["합성칩", "SynthChip", "SynthChip Corporation"], "description": None,
          "ids": {"ticker": "SCHP", "market": "us", "stockCode": None, "cik": "0009000001", "dartCorpCode": None,
                  "wikidata": "Q900001"},
          "links": [], "sources": ["sec", "wikidata"]}


class Stubs:
    """바깥 출처·저장본 자리 — 부른 횟수를 셉니다."""

    def __init__(self, monkeypatch):
        self.calls: list[str] = []
        stored = _item("SynthChip unveils new accelerator", "https://www.example.org/a1", source="event_news", kind="headline")
        self.results = {
            "google_ko": sources.Fetched(items=[
                _item("합성칩, 새 가속기 공개", "https://news.google.com/rss/articles/K1", source="google_ko", ago=timedelta(hours=5)),
                _item("合成芯片发布新一代加速器", "https://news.google.com/rss/articles/K2", source="google_ko"),
                _item("합성칩 옛 기사", "https://news.google.com/rss/articles/K3", source="google_ko", ago=timedelta(days=900)),
            ]),
            "google_en": sources.Fetched(items=[
                _item("SynthChip unveils new accelerator chips", "https://news.google.com/rss/articles/E1", source="google_en"),
                _item("SynthChip story from an excluded outlet", "https://news.google.com/rss/articles/E2", source="google_en",
                      domain="xinhuanet.com"),
            ]),
            "bing": sources.Fetched(items=[
                _item("SynthChip accelerator, updated", "https://example.org/a1/?utm_source=bing", source="bing"),
                _item("SynthChip quarterly preview", "https://www.example.net/p1", source="bing", ago=timedelta(days=20)),
                _item("SynthChip undated note", "https://www.example.net/p2", source="bing", ago=None),
            ]),
            "yahoo": sources.Fetched(error="finance.yahoo.com HTTP 503"),
            "infomax": sources.Fetched(items=[]),
            "event_news": sources.Fetched(items=[stored]),
            "wire": sources.Fetched(items=[_item("SYNTHCHIP HALTED", "https://www.example.com/w1", source="wire", kind="wire",
                                                 reader="w1", ago=timedelta(hours=2))]),
            "info": sources.Fetched(items=[_item("On SynthChip margins", "https://blog.example.org/i1", source="info", kind="post",
                                                 reader="i1", basis="fetched", ago=timedelta(days=200))]),
            "guru": sources.Fetched(items=[]),
            "feeds": sources.Fetched(items=[_item("Central bank notes SynthChip supply", "https://www.example.edu/f1",
                                                  source="feeds", ago=timedelta(days=3))]),
            "watch": sources.Fetched(items=[_item("SynthChip watch find", "https://www.example.info/w1", source="watch",
                                                  ago=timedelta(days=40))]),
        }
        monkeypatch.setattr(sources, "google", lambda terms, lang, after: self._hit(f"google_{lang}"))
        monkeypatch.setattr(sources, "bing", lambda terms_by_lang: self._hit("bing"))
        monkeypatch.setattr(sources, "yahoo_news", lambda ticker: self._hit("yahoo"))
        monkeypatch.setattr(sources, "infomax", lambda terms, after: self._hit("infomax"))
        monkeypatch.setattr(sources, "naver", lambda code: self._hit("naver"))
        monkeypatch.setattr(search_store, "event_news", lambda terms: self._hit("event_news"))
        monkeypatch.setattr(search_store, "wire", lambda terms: self._hit("wire"))
        monkeypatch.setattr(search_store, "info_posts", lambda terms: self._hit("info"))
        monkeypatch.setattr(search_store, "guru_views", lambda terms: self._hit("guru"))
        monkeypatch.setattr(search_store, "feed_bundle", lambda terms: self._hit("feeds"))
        monkeypatch.setattr(search_store, "watch_items", lambda key, owner: self._watch(key, owner))
        monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": ENTITY, "errors": {}, "fetchedAt": None})
        self.watch_calls: list[tuple] = []

    def _watch(self, key, owner):
        self.watch_calls.append((key, owner))
        return self._hit("watch")

    def _hit(self, source):
        self.calls.append(source)
        return self.results[source]


def _row(out, source):
    return next(row for row in out["sources"] if row["source"] == source)


# ------------------------------------------------------------------ 입력 검사

@pytest.mark.parametrize("path", [
    "/live/search/suggest", "/live/search/suggest?q=", "/live/search/suggest?q=%20%20", "/live/search/suggest?q=" + "a" * 61,
    "/live/search/resolve?q=", "/live/search/resolve?q=" + "가" * 61,
    "/live/search/entity", "/live/search/entity?e=NVDA", "/live/search/entity?e=us:nvda", "/live/search/entity?e=kr:5930",
    "/live/search/entity?e=topic:", "/live/search/feed?e=us:NVDA", "/live/search/feed?e=us:NVDA&tab=holdings",
    "/live/search/feed?e=wd:123&tab=news", "/live/search/feed?tab=news",
])
def test_틀린_입력은_400이고_서비스를_부르지_않는다(client, monkeypatch, path):
    for name in ("suggest", "resolve", "entity", "feed"):
        monkeypatch.setattr(search, name, lambda *a, **k: pytest.fail("부르면 안 됩니다"))
    assert client.get(path).status_code == 400


def test_경로는_검사한_값과_owner·external을_넘긴다(client, monkeypatch):
    seen = []
    monkeypatch.setattr(search, "suggest", lambda q, owner=False: seen.append(("suggest", q, owner)) or {"items": []})
    monkeypatch.setattr(search, "resolve", lambda q, owner=False, external=True: seen.append(("resolve", q, owner, external))
                        or {"items": []})
    monkeypatch.setattr(search, "entity", lambda e, external=True: seen.append(("entity", e, external)) or {"entity": None})
    monkeypatch.setattr(search, "feed", lambda e, tab, owner=False, external=True, refresh=False:
                        seen.append(("feed", e, tab, owner, external, refresh)) or {"items": []})
    assert client.get("/live/search/suggest?q=%20합성%20&owner=true").status_code == 200
    assert client.get("/live/search/resolve?q=Synth&external=false").status_code == 200
    assert client.get("/live/search/entity?e=topic:AI%20반도체").status_code == 200
    assert client.get("/live/search/feed?e=us:BRK.B&tab=news&owner=true&external=false").status_code == 200
    assert client.get("/live/search/feed?e=us:BRK.B&tab=news&refresh=true").status_code == 200
    assert seen == [("suggest", "합성", True), ("resolve", "Synth", False, False), ("entity", "topic:AI 반도체", True),
                    ("feed", "us:BRK.B", "news", True, False, False), ("feed", "us:BRK.B", "news", False, True, True)]


# ------------------------------------------------------------------ external=false

def test_외부_호출을_끄면_바깥으로_나가는_요청이_0건(client, monkeypatch):
    attempts: list[str] = []

    def refuse(name):
        def blocked(*args, **kwargs):
            attempts.append(name)
            raise AssertionError(f"{name} 호출")
        return blocked

    monkeypatch.setattr(requests.Session, "get", refuse("session.get"))
    monkeypatch.setattr(requests.Session, "request", refuse("session.request"))
    monkeypatch.setattr(sources.yf, "Search", refuse("yfinance.Search"))
    monkeypatch.setattr(detail, "_naver_json", refuse("naver"))
    monkeypatch.setattr(search_wikidata, "request", refuse("wikidata"))
    monkeypatch.setattr(search_entities, "_fetch_sec_table", refuse("sec"))
    monkeypatch.setattr(search_store, "event_news", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "wire", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "info_posts", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "guru_views", lambda terms: sources.Fetched(items=[]))

    for path in ("/live/search/suggest?q=NVDA&external=false", "/live/search/resolve?q=NVIDIA&external=false",
                 "/live/search/entity?e=us:NVDA&external=false", "/live/search/entity?e=wd:Q182477&external=false",
                 "/live/search/feed?e=us:NVDA&tab=timeline&owner=true&external=false",
                 "/live/search/feed?e=kr:005930&tab=news&external=false",
                 "/live/search/feed?e=wd:Q182477&tab=news&external=false"):
        response = client.get(path)
        assert response.status_code == 200, path
    assert attempts == []

    out = client.get("/live/search/feed?e=us:NVDA&tab=timeline&owner=true&external=false").json()
    for source in ("google_en", "bing", "yahoo", "infomax"):
        assert _row(out, source)["status"] == "offline", source
    assert _row(out, "event_news")["status"] in ("empty", "cached")
    assert _row(out, "info")["status"] in ("empty", "cached")


# ------------------------------------------------------------------ 결과 묶기

def test_결과는_규칙을_거쳐_합치고_출처마다_상태를_적는다(monkeypatch):
    stubs = Stubs(monkeypatch)
    out = search.feed("us:SCHP", "timeline", owner=True, external=True)
    titles = [item["title"] for item in out["items"]]
    assert titles == ["SYNTHCHIP HALTED", "합성칩, 새 가속기 공개", "SynthChip unveils new accelerator",
                      "Central bank notes SynthChip supply", "SynthChip quarterly preview", "SynthChip watch find",
                      "On SynthChip margins"]
    stamps = [item["publishedAt"] for item in out["items"]]
    assert stamps == sorted(stamps, reverse=True)
    assert out["entityKey"] == "us:SCHP" and out["tab"] == "timeline" and out["pending"] is False
    assert out["window"]["to"] == search.rules.kst_today().isoformat()
    assert out["rangeCounts"] == {"7d": 4, "30d": 5, "1y": 7, "2y": 7}
    assert out["olderOnlyLatest"] is None

    google_ko = _row(out, "google_ko")
    assert google_ko["status"] == "ok" and google_ko["count"] == 1
    assert google_ko["dropped"] == {"old": 1, "noTime": 0, "chinese": 1, "excluded": 0}
    google_en = _row(out, "google_en")
    assert google_en["count"] == 0 and google_en["dropped"]["excluded"] == 1 and google_en["status"] == "empty", \
        "같은 글은 저장본이 남음"
    bing = _row(out, "bing")
    assert bing["count"] == 1 and bing["dropped"]["noTime"] == 1
    assert _row(out, "yahoo") == {"source": "yahoo", "label": "Yahoo 종목 뉴스", "status": "error", "count": 0,
                                  "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0},
                                  "message": "finance.yahoo.com HTTP 503"}
    assert _row(out, "infomax")["status"] == "empty"
    assert _row(out, "event_news")["count"] == 1 and _row(out, "wire")["count"] == 1
    assert _row(out, "guru")["status"] == "empty"
    assert _row(out, "filings")["status"] == "later" and _row(out, "research")["status"] == "later"
    assert _row(out, "feeds") == {"source": "feeds", "label": "보도자료·경제지 피드", "status": "ok", "count": 1,
                                  "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": None}
    assert _row(out, "watch")["label"] == "관심 대상 수집" and _row(out, "watch")["count"] == 1
    assert stubs.watch_calls == [("us:SCHP", True)], "관심 대상이 모은 글은 대표 키로 읽고 운영자 여부를 넘김"
    assert [row["source"] for row in out["sources"]] == ["google_ko", "google_en", "bing", "yahoo", "infomax", "event_news",
                                                        "feeds", "watch", "wire", "info", "guru", "filings", "research"]
    assert all(set(row) == {"source", "label", "status", "count", "dropped", "message"} for row in out["sources"])
    info = next(item for item in out["items"] if item["source"] == "info")
    assert info["timeBasis"] == "fetched" and info["readerId"] == "i1"
    assert sorted(set(stubs.calls)) == sorted(stubs.calls), "출처마다 한 번"


def test_두_번째_부름은_캐시_실패는_그대로_error(monkeypatch):
    stubs = Stubs(monkeypatch)
    search.feed("us:SCHP", "news", owner=True, external=True)
    first_calls = list(stubs.calls)
    out = search.feed("us:SCHP", "news", owner=True, external=True)
    assert stubs.calls == first_calls, "15분 안에는 다시 부르지 않음(실패한 Yahoo는 60초)"
    assert _row(out, "google_ko")["status"] == "cached" and _row(out, "google_ko")["count"] == 1
    assert _row(out, "yahoo")["status"] == "error"


def test_운영자가_아니면_운영자_전용_저장본을_읽지_않는다(monkeypatch):
    stubs = Stubs(monkeypatch)
    out = search.feed("us:SCHP", "timeline", owner=False, external=True)
    assert not {"wire", "info", "guru"} & set(stubs.calls)
    for source in ("wire", "info", "guru"):
        row = _row(out, source)
        assert row["status"] == "owner_only" and row["count"] == 0 and row["message"] is None
    assert all(item["source"] not in ("wire", "info", "guru") for item in out["items"])
    posts = search.feed("us:SCHP", "posts", owner=False, external=True)
    assert posts["items"] == [] and {row["status"] for row in posts["sources"]} == {"owner_only"}


def test_2년_밖만_있으면_가장_최근_날짜(monkeypatch):
    stubs = Stubs(monkeypatch)
    old = timedelta(days=800)
    for source in list(stubs.results):
        stubs.results[source] = sources.Fetched(items=[])
    stubs.results["google_en"] = sources.Fetched(items=[
        _item("Old SynthChip story", "https://news.google.com/rss/articles/O1", source="google_en", ago=old),
        _item("Older SynthChip story", "https://news.google.com/rss/articles/O2", source="google_en", ago=timedelta(days=1500)),
    ])
    out = search.feed("us:SCHP", "news", owner=False, external=True)
    assert out["items"] == [] and out["rangeCounts"] == {"7d": 0, "30d": 0, "1y": 0, "2y": 0}
    expected = (datetime.now(timezone.utc) - old).astimezone(search.rules.KST).date().isoformat()
    assert out["olderOnlyLatest"] == expected


def test_공시·리서치_탭은_빈_목록과_later(monkeypatch):
    monkeypatch.setattr(search, "entity", lambda *a, **k: pytest.fail("대상을 풀지 않습니다"))
    for tab in ("filings", "research"):
        out = search.feed("us:SCHP", tab, owner=True, external=True)
        assert out["items"] == [] and [row["status"] for row in out["sources"]] == ["later"]
        assert out["rangeCounts"] == {"7d": 0, "30d": 0, "1y": 0, "2y": 0} and out["olderOnlyLatest"] is None


def test_늦은_출처는_상한_시각에_시간_초과(monkeypatch):
    stubs = Stubs(monkeypatch)
    monkeypatch.setattr(search, "SOURCE_DEADLINE", 0.3)

    def slow(terms_by_lang):
        time.sleep(1.0)
        return stubs.results["bing"]

    monkeypatch.setattr(sources, "bing", slow)
    started = time.monotonic()
    out = search.feed("us:SCHP", "news", owner=False, external=True)
    assert time.monotonic() - started < 0.9
    assert _row(out, "bing")["status"] == "error" and "답이 없음" in _row(out, "bing")["message"]
    assert _row(out, "google_ko")["status"] == "ok"
    time.sleep(0.8)              # 늦게 끝난 출처가 캐시에 적는 것을 기다렸다가 비움(다음 시험과 섞이지 않게)
    search.reset_cache()


def test_주제는_글자에_맞는_판만_부른다(monkeypatch):
    stubs = Stubs(monkeypatch)
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": search_entities.topic_entity("AI 반도체"),
                                                                       "errors": {}, "fetchedAt": None})
    out = search.feed("topic:AI 반도체", "news", owner=False, external=True)
    assert _row(out, "google_en")["status"] == "skipped" and "영어" in _row(out, "google_en")["message"]
    assert "google_ko" in stubs.calls and "google_en" not in stubs.calls
    assert not {"yahoo", "naver", "infomax"} & {row["source"] for row in out["sources"]}


def test_로그에_검색어가_남지_않는다(monkeypatch, caplog):
    def failing(*args, **kwargs):
        raise requests.ConnectionError(f"HTTPSConnectionPool(host='news.google.com'): /rss/search?q={SECRET}")

    monkeypatch.setattr(requests.Session, "get", failing)
    monkeypatch.setattr(search_wikidata, "api", lambda params: {"search": [], "query": {"search": []}, "entities": {}})
    monkeypatch.setattr(search_store, "event_news", lambda terms: sources.Fetched(items=[]))
    with caplog.at_level(logging.DEBUG):
        out = search.feed(f"topic:{SECRET}", "news", owner=False, external=True)
        search.resolve(SECRET, owner=False, external=True)
    assert SECRET not in caplog.text and SECRET.replace(" ", "+") not in caplog.text
    assert all(SECRET not in (row["message"] or "") for row in out["sources"])


def test_대상_풀기가_늦으면_저장본_이름으로만_답한다(client, monkeypatch):
    monkeypatch.setattr(search, "ENTITY_DEADLINE", 0.3)
    real_build = search_entities.build

    def slow_build(prefix, value, *, external):
        if external:
            time.sleep(1.0)
        return real_build(prefix, value, external=False)

    monkeypatch.setattr(search_entities, "build", slow_build)
    started = time.monotonic()
    out = client.get("/live/search/entity?e=us:NVDA").json()
    assert time.monotonic() - started < 0.9
    assert out["entity"]["key"] == "us:NVDA" and "entity" in out["errors"]
    assert search.OFFLINE not in out["errors"].values(), "외부 호출을 켠 요청에 '외부 호출을 끈 요청' 사유를 싣지 않음"
    assert set(out["errors"]) == {"entity"}
    time.sleep(0.8)
    search.reset_cache()


def test_외부_호출을_끈_요청에서_풀지_못한_대상은_바깥_출처가_offline(monkeypatch):
    monkeypatch.setattr(search_wikidata, "request", lambda *a, **k: pytest.fail("Wikidata를 부르면 안 됩니다"))
    monkeypatch.setattr(search_store, "event_news", lambda terms: pytest.fail("이름 없이 저장본을 읽지 않음"))
    out = search.feed("wd:Q900001", "timeline", owner=True, external=False)
    assert out["items"] == []
    for source in ("google_ko", "google_en", "bing"):
        row = _row(out, source)
        assert row["status"] == "offline" and row["message"] == search.OFFLINE, source
    assert _row(out, "event_news")["status"] == "skipped"
    for source in ("wire", "info", "guru"):
        assert _row(out, source)["status"] == "skipped", source


def test_외부_호출을_켠_요청에서_풀지_못한_대상은_skipped(monkeypatch):
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": None, "errors": {}, "fetchedAt": None})
    out = search.feed("wd:Q900001", "news", owner=False, external=True)
    assert _row(out, "google_ko")["status"] == "skipped" and _row(out, "bing")["status"] == "skipped"
    assert _row(out, "wire")["status"] == "owner_only"


# ------------------------------------------------------------------ 단계 3 — 지금 새로 받기·사용자 제외 매체·첫 화면·제외 목록

def test_지금_새로_받기는_출처_캐시를_건너뛰고_새_결과로_캐시를_고친다(monkeypatch):
    stubs = Stubs(monkeypatch)
    search.feed("us:SCHP", "news", owner=False, external=True)
    first = list(stubs.calls)
    stubs.results["google_ko"] = sources.Fetched(items=[
        _item("합성칩, 새 소식", "https://news.google.com/rss/articles/K9", source="google_ko", ago=timedelta(hours=1))])
    out = search.feed("us:SCHP", "news", owner=False, external=True, refresh=True)
    assert len(stubs.calls) == 2 * len(first), "출처마다 다시 부름(저장본 포함)"
    assert _row(out, "google_ko")["status"] == "ok" and "합성칩, 새 소식" in [item["title"] for item in out["items"]]
    again = search.feed("us:SCHP", "news", owner=False, external=True)
    assert len(stubs.calls) == 2 * len(first) and _row(again, "google_ko")["status"] == "cached"
    assert "합성칩, 새 소식" in [item["title"] for item in again["items"]], "새로 받은 결과가 캐시에 남음"


def test_외부_호출을_끈_요청은_새로_받기여도_바깥을_부르지_않는다(monkeypatch):
    stubs = Stubs(monkeypatch)
    out = search.feed("us:SCHP", "news", owner=False, external=False, refresh=True)
    assert not {"google_ko", "google_en", "bing", "yahoo", "infomax"} & set(stubs.calls)
    assert _row(out, "google_ko")["status"] == "offline"


def test_사용자가_더한_제외_매체는_처음_값과_함께_빠진다(monkeypatch):
    Stubs(monkeypatch)
    excludes = {"rows": [{"kind": "domain", "value": "Example.NET"}]}
    monkeypatch.setattr(search_store, "user_excludes", lambda: search.rules.make_excludes(excludes["rows"]))
    out = search.feed("us:SCHP", "news", owner=False, external=True)
    assert _row(out, "bing")["dropped"]["excluded"] == 2, "example.net 두 줄(시각 없는 줄도 매체로 먼저 셈)"
    assert _row(out, "google_en")["dropped"]["excluded"] == 1, "처음 값(xinhuanet.com)도 그대로"
    assert "SynthChip quarterly preview" not in [item["title"] for item in out["items"]]

    excludes["rows"] = [{"kind": "name", "value": "example"}]       # 이름은 대소문자 무시 완전 일치
    search.reset_cache()
    out = search.feed("us:SCHP", "news", owner=False, external=True)
    assert out["items"] == [] and _row(out, "event_news")["dropped"]["excluded"] == 1


def test_회원의_관심_대상_글은_운영자_아님으로_읽는다(monkeypatch):
    stubs = Stubs(monkeypatch)
    search.feed("us:SCHP", "timeline", owner=False, external=True)
    assert stubs.watch_calls == [("us:SCHP", False)]


def test_첫_화면은_새_피드_묶음과_운영자에게만_속보(monkeypatch):
    bundle = [
        _item("Fed statement on rates", "https://www.federalreserve.gov/p1", source="feeds", ago=timedelta(hours=3)),
        _item("中国央行发布新政策", "https://www.example.org/zh", source="feeds", ago=timedelta(hours=2)),
        _item("Nikkei story", "https://asia.nikkei.com/a1", source="feeds", basis="fetched", ago=timedelta(minutes=30)),
    ]
    wire = [_item("BREAKING: synthetic headline", "https://www.example.com/w9", source="wire", kind="wire", reader="w9",
                  ago=timedelta(minutes=10))]
    calls = []
    monkeypatch.setattr(search_store, "recent_bundle", lambda limit: calls.append(("feeds", limit)) or sources.Fetched(items=bundle))
    monkeypatch.setattr(search_store, "recent_wire", lambda limit: calls.append(("wire", limit)) or sources.Fetched(items=wire))
    member = search.recent(owner=False)
    assert [item["title"] for item in member["items"]] == ["Nikkei story", "Fed statement on rates"]
    assert member["errors"] == {} and calls == [("feeds", 30)]
    owner = search.recent(owner=True)
    assert [item["title"] for item in owner["items"]] == ["BREAKING: synthetic headline", "Nikkei story", "Fed statement on rates"]
    assert calls[-1] == ("wire", 20)
    monkeypatch.setattr(search_store, "recent_bundle", lambda limit: sources.Fetched(error="저장소를 읽지 못함(OperationalError)"))
    failed = search.recent(owner=False)
    assert failed["items"] == [] and failed["errors"] == {"feeds": "저장소를 읽지 못함(OperationalError)"}


def test_첫_화면·제외_목록_경로(client, monkeypatch):
    monkeypatch.setattr(search, "recent", lambda owner=False: {"items": [], "errors": {}, "owner": owner})
    assert client.get("/live/search/recent?owner=true").json()["owner"] is True
    assert client.get("/live/search/recent").json()["owner"] is False
    monkeypatch.delenv("POLITE_FETCH_ENABLED", raising=False)
    body = client.get("/live/search/excludes").json()
    assert body["politeEnabled"] is False
    assert {"kind": "domain", "value": "xinhuanet.com", "group": "중국 국가·당 매체"} in body["seed"]
    assert {"kind": "name", "value": "moomoo", "group": "중국 자본 금융 매체"} in body["seed"]
    assert all(set(row) == {"kind", "value", "group"} and row["kind"] in ("domain", "name") for row in body["seed"])
    assert len(body["seed"]) == len(search.rules.EXCLUDED_DOMAINS) + len(search.rules.EXCLUDED_NAMES)
    assert body["fixedRules"] and all(isinstance(rule, str) for rule in body["fixedRules"])
    monkeypatch.setenv("POLITE_FETCH_ENABLED", "true")
    assert client.get("/live/search/excludes").json()["politeEnabled"] is True


def test_상태_경로는_차단_통과_수집이_켜졌는지_알린다(client, monkeypatch):
    monkeypatch.setattr(main.store, "store_stats", lambda task_names=None: {})
    monkeypatch.delenv("POLITE_FETCH_ENABLED", raising=False)
    assert client.get("/status").json()["politeEnabled"] is False
    monkeypatch.setenv("POLITE_FETCH_ENABLED", "true")
    assert client.get("/status").json()["politeEnabled"] is True
