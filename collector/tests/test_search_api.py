"""
tests/test_search_api.py
정보 검색 경로(/live/search/suggest·resolve·entity·feed)와 결과 묶기(services/search.feed) — 네트워크·DB 없이.

- 입력 검사: q 1~60자, 대상 키 문법, 탭 — 틀리면 400(422가 아님)이고 서비스를 부르지 않음
- external=false: 바깥으로 나가는 요청 0건(공용 세션·yfinance·네이버·Wikidata·SEC 모두), 바깥 출처는 상태 offline
- owner=false: 운영자 전용 저장본(수집 글·거장 견해·속보)을 읽지 않고 상태 owner_only
- 결과: 출처마다 상태 한 줄과 거른 건수, 같은 글은 우선순위 높은 출처 하나, 최신순, 기간별 건수, 2년 밖만 있으면 olderOnlyLatest
- 출처별 캐시(두 번째 부름은 cached, 실패는 그대로 error), 늦은 출처는 상한 시각에 '시간 초과'로
- 공시·리서치 탭(단계 4, 계약 §7-2·§7-3): 대상 종류마다 부를 출처(주제는 공시·리서치 없음, 기관·사람은 리서치 없음), 타임라인은 허락된 탭의 합,
  SEC 두 출처의 같은 접수는 한 줄(sec가 먼저), 모은 글은 탭에 맞는 종류만(§7-6)
- 로그에 검색어가 남지 않음
- Finviz 종목 뉴스(단계 5, 계약 §8-4): 미국 상장 회사의 뉴스·타임라인에만, 처음엔 받는 중(pending·finvizQueued), 받은 뒤 채움, finviz=0이면
  줄에 넣지 않음, 서버가 아니면 server_only(네트워크 0건), 합치기는 Yahoo 바로 뒤
- 단계 4 QA: SEC 표·DART 저장본·대상 풀기를 읽지 못해 식별자를 모르면 공시 줄은 '건너뜀'이 아니라 error(Q1), 첫 화면은 사용자 제외 매체를
  캐시 없이 바로 읽음(Q3)
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

import pytest
import requests
from fastapi.testclient import TestClient

from app import http, main, publicapi
from app import store as app_store
from app.fetch import ladder, policy
from app.services import detail, search, search_entities, search_filings, search_links, search_research, search_store, search_wikidata
from app.services import search_finviz
from app.services import search_sources as sources
from app.tasks import polite

SECRET = "Synthetic Secret Holdings"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    search.reset_cache()
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    monkeypatch.setattr(search_store, "guru_names", lambda: [])
    # 단계 3의 저장본 출처·사용자 제외 매체 — 시험마다 따로 바꿔 끼우지 않으면 비어 있음(DB 없음).
    monkeypatch.setattr(search_store, "feed_bundle", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "watch_items", lambda key, owner, kinds=None: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "user_excludes", lambda: search.rules.Excludes())
    # 첫 화면은 사용자 제외 매체를 캐시 없이 읽음(Q3) — DB 없이.
    monkeypatch.setattr(app_store, "search_media_excludes", lambda: [])
    # Finviz(단계 5) — 시험마다 따로 바꿔 끼우지 않으면 검색 예산이 없어 줄에 넣지 않고, 계층은 부르지 않음(DB·네트워크 없음).
    monkeypatch.setattr(app_store, "take_search_budget", lambda *a, **k: False)
    monkeypatch.setattr(app_store, "fetch_host", lambda host: None)       # 표 fetch_hosts(닫힘·통과한 계층) — 열려 있고 기록 없음
    monkeypatch.setattr(ladder, "fetch", lambda *a, **k: pytest.fail("Finviz 계층을 부르면 안 됩니다"))
    yield
    search_finviz.wait_idle(5)
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
                  "wikidata": "Q900001", "lei": None},
          "links": [], "sources": ["sec", "wikidata"]}
KR_ENTITY = {"key": "kr:900001", "kind": "company", "name": "합성전자", "nameKo": "합성전자", "nameEn": None,
             "aliases": ["합성전자"], "description": None,
             "ids": {"ticker": "900001", "market": "kr", "stockCode": "900001", "cik": None, "dartCorpCode": "00900001",
                     "wikidata": None, "lei": None},
             "links": [], "sources": ["dart"]}
INSTITUTION = {"key": "cik:0009000077", "kind": "institution", "name": "합성 패밀리 오피스", "nameKo": "합성 패밀리 오피스",
               "nameEn": "Synthetic Family Office", "aliases": ["합성 패밀리 오피스", "Synthetic Family Office", "SFO"],
               "description": None,
               "ids": {"ticker": None, "market": None, "stockCode": None, "cik": "0009000077", "dartCorpCode": None,
                       "wikidata": None, "lei": None},
               "links": [], "sources": ["13f"]}
PERSON = {"key": "wd:Q900020", "kind": "person", "name": "Synth Founder", "nameKo": None, "nameEn": "Synth Founder",
          "aliases": ["Synth Founder", "Synthia Q. Founder"], "description": None,
          "ids": {"ticker": None, "market": None, "stockCode": None, "cik": None, "dartCorpCode": None, "wikidata": "Q900020",
                  "lei": None},
          "links": [], "sources": ["wikidata"]}


class Stubs:
    """바깥 출처·저장본 자리 — 부른 횟수를 셉니다."""

    def __init__(self, monkeypatch):
        self.monkeypatch = monkeypatch
        self.calls: list[str] = []
        self.bing_tickers: list[str | None] = []
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
            # 단계 4 — 공시·리서치(시험마다 따로 넣지 않으면 비어 있음)
            "sec": sources.Fetched(items=[]),
            "sec_fts": sources.Fetched(items=[]),
            "dart": sources.Fetched(items=[]),
            "yahoo_research": sources.Fetched(items=[]),
            "naver_research": sources.Fetched(items=[]),
            # 단계 5 — Finviz(시험마다 따로 넣지 않으면 받아 둔 빈 결과)
            "finviz": sources.Fetched(items=[]),
        }
        self.finviz_calls: list[tuple] = []
        monkeypatch.setattr(search_finviz, "request", self.finviz)
        self.filing_args: list[tuple] = []
        monkeypatch.setattr(sources, "google", lambda terms, lang, after: self._hit(f"google_{lang}"))
        monkeypatch.setattr(sources, "bing", lambda terms_by_lang, ticker=None: self.bing_call(terms_by_lang, ticker))
        monkeypatch.setattr(sources, "yahoo_news", lambda ticker: self._hit("yahoo"))
        monkeypatch.setattr(sources, "infomax", lambda terms, after: self._hit("infomax"))
        monkeypatch.setattr(sources, "naver", lambda code: self._hit("naver"))
        monkeypatch.setattr(search_store, "event_news", lambda terms: self._hit("event_news"))
        monkeypatch.setattr(search_store, "wire", lambda terms: self._hit("wire"))
        monkeypatch.setattr(search_store, "info_posts", lambda terms: self._hit("info"))
        monkeypatch.setattr(search_store, "guru_views", lambda terms: self._hit("guru"))
        monkeypatch.setattr(search_store, "feed_bundle", lambda terms: self._hit("feeds"))
        monkeypatch.setattr(search_store, "watch_items", lambda key, owner, kinds=None: self._watch(key, owner, kinds))
        monkeypatch.setattr(search_filings, "sec_submissions",
                            lambda cik, start_day: self.filing_args.append(("sec", cik, start_day)) or self._hit("sec"))
        monkeypatch.setattr(search_filings, "sec_fts",
                            lambda phrases, start_day, end_day: self.filing_args.append(("sec_fts", tuple(phrases), start_day,
                                                                                         end_day)) or self._hit("sec_fts"))
        monkeypatch.setattr(search_filings, "dart_list",
                            lambda corp, start_day, end_day: self.filing_args.append(("dart", corp, start_day, end_day))
                            or self._hit("dart"))
        monkeypatch.setattr(search_research, "yahoo_grades", lambda ticker: self._hit("yahoo_research"))
        monkeypatch.setattr(search_research, "naver_research", lambda code: self._hit("naver_research"))
        self.use(ENTITY)
        self.watch_calls: list[tuple] = []
        self.watch_kinds: list = []

    def use(self, entity, errors=None):
        self.monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": entity, "errors": dict(errors or {}),
                                                                               "fetchedAt": None})

    def finviz(self, ticker, *, external=True, allow_queue=True):
        """Finviz 자리 — 받아 둔 결과(외부를 끈 요청이면 offline). 실제 길은 자기 30분 캐시가 있어 calls(바깥 부름)에 세지 않음."""
        self.finviz_calls.append((ticker, external, allow_queue))
        if not external:
            return search_finviz.Answer("offline")
        result = self.results["finviz"]
        if result.error:
            return search_finviz.Answer("error", message=result.error)
        return search_finviz.Answer("ok", items=tuple(result.items))

    def _watch(self, key, owner, kinds=None):
        """모은 글 자리 — 저장본처럼 그 종류의 줄만 돌려줍니다."""
        self.watch_calls.append((key, owner))
        self.watch_kinds.append(kinds)
        result = self._hit("watch")
        return sources.Fetched(items=[item for item in result.items if kinds is None or item["kind"] in kinds], error=result.error)

    def _hit(self, source):
        self.calls.append(source)
        return self.results[source]

    def bing_call(self, terms_by_lang, ticker):
        self.bing_tickers.append(ticker)
        return self._hit("bing")


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
    monkeypatch.setattr(search, "feed", lambda e, tab, owner=False, external=True, refresh=False, finviz=True:
                        seen.append(("feed", e, tab, owner, external, refresh, finviz)) or {"items": []})
    assert client.get("/live/search/suggest?q=%20합성%20&owner=true").status_code == 200
    assert client.get("/live/search/resolve?q=Synth&external=false").status_code == 200
    assert client.get("/live/search/entity?e=topic:AI%20반도체").status_code == 200
    assert client.get("/live/search/feed?e=us:BRK.B&tab=news&owner=true&external=false").status_code == 200
    assert client.get("/live/search/feed?e=us:BRK.B&tab=news&refresh=true").status_code == 200
    assert client.get("/live/search/feed?e=us:BRK.B&tab=news&finviz=0").status_code == 200
    assert client.get("/live/search/feed?e=us:BRK.B&tab=news&finviz=1").status_code == 200
    assert seen == [("suggest", "합성", True), ("resolve", "Synth", False, False), ("entity", "topic:AI 반도체", True),
                    ("feed", "us:BRK.B", "news", True, False, False, True), ("feed", "us:BRK.B", "news", False, True, True, True),
                    ("feed", "us:BRK.B", "news", False, True, False, False), ("feed", "us:BRK.B", "news", False, True, False, True)]


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
    monkeypatch.setattr(http, "get_sec_session", refuse("sec_session"))
    monkeypatch.setattr(publicapi, "get", refuse("dart"))
    monkeypatch.setattr(search_research, "_ticker", refuse("yfinance.Ticker"))
    monkeypatch.setattr(search_links, "_ticker", refuse("yfinance.Ticker(links)"))
    monkeypatch.setattr(ladder, "fetch", refuse("finviz"))
    monkeypatch.setattr(app_store, "take_search_budget", refuse("finviz budget"))
    monkeypatch.setattr(search_store, "event_news", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "wire", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "info_posts", lambda terms: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "guru_views", lambda terms: sources.Fetched(items=[]))

    for path in ("/live/search/suggest?q=NVDA&external=false", "/live/search/resolve?q=NVIDIA&external=false",
                 "/live/search/entity?e=us:NVDA&external=false", "/live/search/entity?e=wd:Q182477&external=false",
                 "/live/search/feed?e=us:NVDA&tab=timeline&owner=true&external=false",
                 "/live/search/feed?e=kr:005930&tab=news&external=false",
                 "/live/search/feed?e=wd:Q182477&tab=news&external=false",
                 "/live/search/feed?e=us:NVDA&tab=filings&external=false",
                 "/live/search/feed?e=us:NVDA&tab=research&external=false",
                 "/live/search/feed?e=kr:005930&tab=filings&external=false",
                 "/live/search/feed?e=wd:Q3195170&tab=filings&external=false",
                 "/live/search/links?e=us:NVDA&external=false"):
        response = client.get(path)
        assert response.status_code == 200, path
    assert attempts == []

    out = client.get("/live/search/feed?e=us:NVDA&tab=timeline&owner=true&external=false").json()
    for source in ("google_en", "bing", "yahoo", "finviz", "infomax"):
        assert _row(out, source)["status"] == "offline", source
    assert out["pending"] is False and out["finvizQueued"] is False
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
    assert _row(out, "sec")["status"] == "empty" and _row(out, "yahoo_research")["status"] == "empty"
    assert not {"sec_fts", "dart", "naver_research"} & {row["source"] for row in out["sources"]}, \
        "미국 회사 — 이름 전문 검색(사람·기관)·DART(국내)·네이버 리포트(국내)는 줄 없음"
    assert all(row["status"] != "later" for row in out["sources"])
    assert _row(out, "feeds") == {"source": "feeds", "label": "보도자료·경제지 피드", "status": "ok", "count": 1,
                                  "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": None}
    assert _row(out, "watch")["label"] == "관심 대상 수집" and _row(out, "watch")["count"] == 1
    assert stubs.watch_calls == [("us:SCHP", True)], "관심 대상이 모은 글은 대표 키로 읽고 운영자 여부를 넘김"
    assert [row["source"] for row in out["sources"]] == ["google_ko", "google_en", "bing", "yahoo", "finviz", "infomax",
                                                        "event_news", "feeds", "watch", "wire", "info", "guru", "sec",
                                                        "yahoo_research"]
    assert _row(out, "finviz")["label"] == "Finviz 종목 뉴스" and out["finvizQueued"] is False
    assert stubs.watch_kinds == [None], "타임라인은 모은 글 전부"
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


def _filing(title, accession, *, source, ago=timedelta(days=3), basis="date"):
    return sources.feed_item(title=title, url=search_filings.sec_index_url("0009000001", accession), publisher="SYNTHCHIP CORP",
                             domain="sec.gov", published=_iso(ago), source=source, lang="en", kind="filing", basis=basis,
                             item_id=search_filings.sec_item_id(accession))


def test_공시_탭은_CIK가_있으면_SEC_회사별_목록과_모은_공시(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.results["sec"] = sources.Fetched(items=[
        _filing("10-Q · Quarterly report", "0009000001-26-000101", source="sec", basis="published"),
        _filing("8-K", "0009000001-22-000001", source="sec", ago=timedelta(days=1500)),
    ], note="최근 1,000건만 — 그 앞은 SEC에서")
    out = search.feed("us:SCHP", "filings", owner=False, external=True)
    assert [row["source"] for row in out["sources"]] == ["watch", "sec"], "미국 회사 — DART·이름 전문 검색 줄 없음"
    assert stubs.watch_kinds == [("filing",)], "모은 글은 공시 줄만"
    sec = _row(out, "sec")
    assert (sec["status"], sec["count"], sec["dropped"]["old"]) == ("ok", 1, 1)
    assert sec["label"] == "SEC 공시(회사별)" and sec["message"] == "최근 1,000건만 — 그 앞은 SEC에서"
    assert [item["title"] for item in out["items"]] == ["10-Q · Quarterly report"]
    window_from = out["window"]["from"]
    assert stubs.filing_args == [("sec", "0009000001", window_from)]
    assert not {"google_ko", "bing", "yahoo", "event_news", "yahoo_research"} & set(stubs.calls), "공시 탭은 공시 출처만"


def test_관심_대상이_모은_공시와_겹치면_실시간_공시_출처가_남고_건수도_그쪽에(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.results["sec"] = sources.Fetched(items=[
        _filing("10-Q · Quarterly report", "0009000001-26-000101", source="sec", basis="published"),
        _filing("8-K · Current report", "0009000001-26-000090", source="sec", ago=timedelta(days=9)),
    ], note="최근 1,000건만 — 그 앞은 SEC에서")
    # 관심 대상 수집이 같은 회사별 목록에서 모은 줄(같은 접수번호 id) + 지금 목록에 없는 줄 하나 + 뉴스 한 줄.
    stubs.results["watch"] = sources.Fetched(items=[
        _filing("10-Q · Quarterly report", "0009000001-26-000101", source="watch", basis="published"),
        _filing("S-8 · Registration", "0009000001-26-000011", source="watch", ago=timedelta(days=60)),
        _item("SynthChip watch find", "https://www.example.info/w1", source="watch", ago=timedelta(days=40)),
    ])
    for tab in ("filings", "timeline"):
        search.reset_cache()
        out = search.feed("us:SCHP", tab, owner=False, external=True)
        filed =[(item["source"], item["title"]) for item in out["items"] if item["kind"] == "filing"]
        assert filed == [("sec", "10-Q · Quarterly report"), ("sec", "8-K · Current report"), ("watch", "S-8 · Registration")], tab
        sec = _row(out, "sec")
        assert (sec["status"], sec["count"]) == ("ok", 2), f"{tab}: 회사별 목록이 줄을 줬으면 '빈 결과'가 아님"
        assert sum(row["count"] for row in out["sources"]) == len(out["items"]), tab
    stubs.results["sec"] = sources.Fetched(error="data.sec.gov HTTP 503")
    search.reset_cache()
    out = search.feed("us:SCHP", "filings", owner=False, external=True)
    assert _row(out, "sec")["status"] == "error" and _row(out, "watch")["count"] == 2, "회사별 목록이 실패하면 모은 줄이 남음"


def test_SEC_두_출처의_같은_접수는_한_줄이고_회사별_목록이_남는다(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.use(INSTITUTION)
    stubs.results["sec"] = sources.Fetched(items=[_filing("13F-HR · Holdings", "0009000077-26-000005", source="sec")])
    stubs.results["sec_fts"] = sources.Fetched(items=[
        _filing("13F-HR · Synthetic Family Office LLC", "0009000077-26-000005", source="sec_fts"),
        _filing("8-K · Example Corp", "0009000088-26-000001", source="sec_fts", ago=timedelta(days=10)),
    ])
    out = search.feed("cik:0009000077", "filings", owner=False, external=True)
    assert [(item["source"], item["title"]) for item in out["items"]] == [("sec", "13F-HR · Holdings"),
                                                                          ("sec_fts", "8-K · Example Corp")]
    assert _row(out, "sec")["count"] == 1 and _row(out, "sec_fts")["count"] == 1
    phrases = next(args for args in stubs.filing_args if args[0] == "sec_fts")[1]
    assert phrases == ('"Synthetic Family Office"',), "Bing과 같은 구문 규칙(티커·세 글자 별칭 없이, 영문만)"
    assert sum(row["count"] for row in out["sources"]) == len(out["items"])


def test_사람의_공시는_CIK가_없으면_SEC_목록은_건너뛰고_이름_전문_검색(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.use(PERSON)
    out = search.feed("wd:Q900020", "filings", owner=False, external=True)
    assert _row(out, "sec")["status"] == "skipped" and _row(out, "sec")["message"] == "CIK가 없어 묻지 않음"
    assert _row(out, "sec_fts")["status"] == "empty"
    assert [args[1] for args in stubs.filing_args] == [('"Synth Founder"', '"Synthia Q. Founder"')], "이름 먼저(같은 여러 단어)"
    research = search.feed("wd:Q900020", "research", owner=False, external=True)
    assert [(row["source"], row["status"]) for row in research["sources"]] == [("yahoo_research", "skipped"),
                                                                              ("naver_research", "skipped")]
    assert "yahoo_research" not in stubs.calls and "naver_research" not in stubs.calls
    timeline = search.feed("wd:Q900020", "timeline", owner=False, external=True)
    assert {"sec", "sec_fts"} <= {row["source"] for row in timeline["sources"]}
    assert not {"yahoo_research", "naver_research"} & {row["source"] for row in timeline["sources"]}, "사람은 리서치 없음"


def test_상장되지_않은_기업은_리서치_탭에만_건너뜀_줄이고_타임라인에는_없다(monkeypatch):
    """화면은 상장되지 않은 기업에 리서치 탭을 두지 않음 — 타임라인의 상태 줄에도 리서치 건너뜀을 두지 않음(주제·비기업과 같게)."""
    stubs = Stubs(monkeypatch)
    unlisted = dict(PERSON, key="wd:Q900030", kind="company", name="Synthetic Holdings",
                    ids=dict(PERSON["ids"], ticker=None, market=None, stockCode=None))
    stubs.use(unlisted)
    research = search.feed("wd:Q900030", "research", owner=False, external=True)
    assert [(row["source"], row["status"]) for row in research["sources"]] == [("yahoo_research", "skipped"),
                                                                              ("naver_research", "skipped")]
    timeline = search.feed("wd:Q900030", "timeline", owner=False, external=True)
    assert not {"yahoo_research", "naver_research"} & {row["source"] for row in timeline["sources"]}


def test_국내_회사는_DART_공시와_네이버_리포트(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.use(KR_ENTITY)
    stubs.results["dart"] = sources.Fetched(items=[sources.feed_item(
        title="분기보고서", url="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261113000123", publisher="합성전자",
        domain="dart.fss.or.kr", published=_iso(timedelta(days=1)), source="dart", lang="ko", kind="filing", basis="date")])
    out = search.feed("kr:900001", "filings", owner=False, external=True)
    assert [row["source"] for row in out["sources"]] == ["watch", "dart"], "국내 회사는 SEC 줄 없음"
    assert out["items"][0]["timeBasis"] == "date" and _row(out, "dart")["label"] == "DART 공시"
    assert stubs.filing_args == [("dart", "00900001", out["window"]["from"], out["window"]["to"])]
    research = search.feed("kr:900001", "research", owner=False, external=True)
    assert [row["source"] for row in research["sources"]] == ["naver_research"]
    assert _row(research, "naver_research")["label"] == "증권사 리포트(네이버)"


def test_미국_회사의_리서치는_Yahoo_투자의견_변경(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.results["yahoo_research"] = sources.Fetched(items=[sources.feed_item(
        title="Synthetic Securities: 상향 Neutral → Overweight", url="https://finance.yahoo.com/quote/SCHP/analysis/",
        publisher="Synthetic Securities", domain="finance.yahoo.com", published=_iso(timedelta(days=2)),
        source="yahoo_research", lang="en", kind="research", item_id="g1")])
    out = search.feed("us:SCHP", "research", owner=False, external=True)
    assert [row["source"] for row in out["sources"]] == ["yahoo_research"]
    assert _row(out, "yahoo_research")["label"] == "투자의견 변경(Yahoo)" and out["items"][0]["kind"] == "research"
    assert stubs.watch_calls == [], "리서치는 모으지 않음(모은 글 없음)"


def test_주제에는_공시·리서치가_없다(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.use(search_entities.topic_entity("합성 반도체"))
    for tab, expected in (("filings", ["sec", "sec_fts", "dart"]), ("research", ["yahoo_research", "naver_research"])):
        out = search.feed("topic:합성 반도체", tab, owner=False, external=True)
        assert [row["source"] for row in out["sources"]] == expected and {row["status"] for row in out["sources"]} == {"skipped"}
        assert out["items"] == []
    timeline = search.feed("topic:합성 반도체", "timeline", owner=False, external=True)
    assert not {"sec", "sec_fts", "dart", "yahoo_research", "naver_research"} & {row["source"] for row in timeline["sources"]}
    assert stubs.filing_args == [] and stubs.watch_kinds == [search.TOPIC_TIMELINE_KINDS], "주제의 타임라인은 공시 줄 없이"


def test_뉴스_탭의_모은_글은_뉴스·헤드라인·속보만(monkeypatch):
    stubs = Stubs(monkeypatch)
    search.feed("us:SCHP", "news", owner=True, external=True)
    assert stubs.watch_kinds == [("news", "headline", "wire")]


def test_풀지_못한_대상의_공시·리서치_탭(monkeypatch):
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": None, "errors": {}, "fetchedAt": None})
    seen = []
    monkeypatch.setattr(search_store, "watch_items", lambda key, owner, kinds=None: seen.append(kinds) or sources.Fetched(items=[]))
    out = search.feed("wd:Q900099", "filings", owner=False, external=True)
    assert {row["source"]: row["status"] for row in out["sources"]} == {"watch": "empty", "sec": "skipped", "sec_fts": "skipped",
                                                                       "dart": "skipped"}
    assert seen == [("filing",)]
    out = search.feed("wd:Q900099", "research", owner=False, external=False)
    assert {row["status"] for row in out["sources"]} == {"offline"}


def test_Bing에는_미국_종목의_티커만_넘긴다(monkeypatch):
    stubs = Stubs(monkeypatch)
    search.feed("us:SCHP", "news", owner=False, external=True)
    assert stubs.bing_tickers == ["SCHP"]


def test_늦은_출처는_상한_시각에_시간_초과(monkeypatch):
    stubs = Stubs(monkeypatch)
    monkeypatch.setattr(search, "SOURCE_DEADLINE", 0.3)

    def slow(terms_by_lang, ticker=None):
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


# ------------------------------------------------------------------ 단계 4 QA — 식별자를 모름(Q1)·첫 화면 제외 매체(Q3)

@pytest.mark.parametrize("errors, external, status, message", [
    ({"sec": "www.sec.gov HTTP 503"}, True, "error", "CIK를 모름 — www.sec.gov HTTP 503"),
    ({"entity": "대상 풀기가 15초를 넘어 저장본 이름으로만 답함"}, True, "error",
     "CIK를 모름 — 대상 풀기가 15초를 넘어 저장본 이름으로만 답함"),
    ({"sec": search.OFFLINE}, False, "offline", search.OFFLINE),
    ({"wikidata": "www.wikidata.org HTTP 503"}, True, "skipped", "CIK가 없어 묻지 않음"),
    ({}, True, "skipped", "CIK가 없어 묻지 않음"),
])
def test_SEC_표를_읽지_못해_CIK를_모르면_건너뜀이_아니라_모름(monkeypatch, errors, external, status, message):
    """계약 §5 — 확인하지 못한 것을 '없음'으로 보이지 않음. SEC 표를 읽었는데 그 티커가 없을 때만 '건너뜀'."""
    stubs = Stubs(monkeypatch)
    stubs.use(dict(ENTITY, ids=dict(ENTITY["ids"], cik=None)), errors=errors)
    for tab in ("filings", "timeline"):
        search.reset_cache()
        out = search.feed("us:SCHP", tab, owner=False, external=external)
        row = _row(out, "sec")
        assert (row["status"], row["message"]) == (status, message), tab
    assert not [args for args in stubs.filing_args if args[0] == "sec"], "CIK 없이 부르지 않음"


_DART_OTHER = {"900002": {"corpCode": "00900002", "name": "합성화학"}}      # 저장본을 읽었고 이 종목(900001)은 없음 — ETF·우선주 등
_DART_SELF = {"900001": {"corpCode": "00900001", "name": "합성전자"}}       # 저장본에 있는데 대상에 고유번호가 없음(저장본을 못 읽던 때 푼 대상)
_DART_MISSING = "DART 고유번호 저장본에 이 종목이 없음"       # 대상 풀기는 저장본을 읽었든 못 읽었든 이 사유를 남김(search_entities._build_kr)


@pytest.mark.parametrize("codes, errors, external, status, message", [
    (_DART_OTHER, {"dart": _DART_MISSING}, True, "skipped", "DART 고유번호가 없어 묻지 않음"),
    (_DART_OTHER, {"dart": _DART_MISSING, "entity": "대상 풀기가 15초를 넘어 저장본 이름으로만 답함"}, True, "skipped",
     "DART 고유번호가 없어 묻지 않음"),
    ({}, {"dart": _DART_MISSING}, True, "error", "DART 고유번호를 모름 — DART 고유번호 저장본을 읽지 못함"),
    ({}, {"dart": _DART_MISSING}, False, "offline", search.OFFLINE),
    (_DART_SELF, {"dart": _DART_MISSING}, True, "error", "DART 고유번호를 모름 — 대상을 풀 때 저장본을 읽지 못함"),
    ({}, {}, True, "skipped", "DART 고유번호가 없어 묻지 않음"),
])
def test_DART_저장본을_읽지_못해_고유번호를_모르면_모름(monkeypatch, codes, errors, external, status, message):
    """저장본을 읽었는데 그 종목이 없으면(ETF 등) '건너뜀', 저장본을 읽지 못했으면 '모름'(error) — 대상 풀기의 사유 글만으로는 둘을 못 가름."""
    stubs = Stubs(monkeypatch)
    monkeypatch.setattr(search_store, "dart_codes", lambda: dict(codes))
    stubs.use(dict(KR_ENTITY, ids=dict(KR_ENTITY["ids"], dartCorpCode=None)), errors=errors)
    out = search.feed("kr:900001", "filings", owner=False, external=external)
    row = _row(out, "dart")
    assert (row["status"], row["message"]) == (status, message)
    assert stubs.filing_args == []


def test_첫_화면은_사용자_제외_매체를_캐시_없이_바로_읽는다(monkeypatch):
    bundle = [_item("Synthetic outlet story", "https://www.synthetic-daily.com/p1", source="feeds", ago=timedelta(hours=1)),
              _item("Fed statement on rates", "https://www.federalreserve.gov/p2", source="feeds", ago=timedelta(hours=2),
                    publisher="Federal Reserve")]
    monkeypatch.setattr(search_store, "recent_bundle", lambda limit: sources.Fetched(items=bundle))
    rows: list[dict] = []
    monkeypatch.setattr(app_store, "search_media_excludes", lambda: list(rows))
    monkeypatch.setattr(search_store, "user_excludes", lambda: pytest.fail("첫 화면은 60초 캐시를 거치지 않음"))
    assert [item["title"] for item in search.recent()["items"]] == ["Synthetic outlet story", "Fed statement on rates"]
    rows.append({"kind": "domain", "value": "synthetic-daily.com"})
    assert [item["title"] for item in search.recent()["items"]] == ["Fed statement on rates"], "제외를 더한 바로 다음 읽기에 빠짐"

    def broken():
        raise RuntimeError("down")

    monkeypatch.setattr(app_store, "search_media_excludes", broken)
    monkeypatch.setattr(search_store, "user_excludes", lambda: search.rules.make_excludes([{"kind": "name", "value": "Example"}]))
    assert [item["title"] for item in search.recent()["items"]] == ["Fed statement on rates"], "읽지 못하면 결과 경로의 값(직전 값)"


# ------------------------------------------------------------------ 단계 5 — Finviz 종목 뉴스(계약 §8-4)

_real_finviz_request = search_finviz.request
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _finviz_stamp(ago: timedelta) -> str:
    moment = (datetime.now(timezone.utc) - ago).astimezone(search_finviz.NEW_YORK)
    hour = moment.hour % 12 or 12
    return f"{_MONTHS[moment.month - 1]}-{moment.day:02d}-{moment.year % 100:02d} {hour:02d}:{moment.minute:02d}" \
           f"{'PM' if moment.hour >= 12 else 'AM'}"


def _finviz_page(*rows) -> str:
    body = "".join(f'<tr><td width="130" align="right">{_finviz_stamp(ago)}</td><td align="left"><div class="news-link-container">'
                   f'<a class="tab-link-news" href="{href}">{title}</a><div class="news-link-right"><span>({publisher})</span>'
                   f'</div></div></td></tr>' for ago, title, href, publisher in rows)
    return f'<html><body><table id="news-table">{body}</table></body></html>'


class FinvizNet:
    """Finviz의 계층·예산 자리 — 실제 search_finviz.request를 쓰고 그 아래만 바꿔 끼웁니다."""

    def __init__(self, monkeypatch, page: str):
        self.urls: list[str] = []
        self.budget: list[tuple] = []
        monkeypatch.setattr(search_finviz, "request", _real_finviz_request)
        monkeypatch.setattr(ladder, "fetch", self.fetch)
        monkeypatch.setattr(app_store, "take_search_budget", lambda *args: self.budget.append(args) or True)
        self.page = page

    def fetch(self, url, *, expect=policy.EXPECT_HTML, **kwargs):
        self.urls.append(url)
        return ladder.Fetched(url=url, status=200, content_type="text/html; charset=utf-8", body=self.page.encode("utf-8"),
                              tier=policy.TIER_IMPERSONATE, final_url=url)


def test_Finviz는_미국_종목의_뉴스에_받는_중으로_먼저_보이고_받은_뒤_채운다(monkeypatch):
    stubs = Stubs(monkeypatch)
    stubs.results["yahoo"] = sources.Fetched(items=[_item("SynthChip on Yahoo", "https://www.example.com/same", source="yahoo",
                                                          ago=timedelta(hours=4))])
    net = FinvizNet(monkeypatch, _finviz_page(
        (timedelta(hours=2), "SynthChip wins synthetic contract", "https://www.example.com/fz1", "Synthetic Wire"),
        (timedelta(hours=4), "SynthChip on Yahoo (Finviz copy)", "https://www.example.com/same", "Yahoo Finance"),
        (timedelta(days=20), "SynthChip quarterly preview (Finviz)", "https://www.example.net/p1", "Example Markets"),
        (timedelta(hours=6), "Synthetic note on Finviz", "/news/900001/synthetic-note", "Synthetic Blog"),
    ))
    first = search.feed("us:SCHP", "news", owner=False, external=True)
    row = _row(first, "finviz")
    assert (row["status"], row["message"], row["count"]) == ("pending", "받는 중 — 몇 초 뒤 채움", 0)
    assert first["pending"] is True and first["finvizQueued"] is True
    assert [args[:2] for args in net.budget] == [("finviz.com", "search")]
    assert search_finviz.wait_idle(5) and net.urls == ["https://finviz.com/stock?t=SCHP"]

    second = search.feed("us:SCHP", "news", owner=False, external=True)
    row = _row(second, "finviz")
    assert row["status"] == "ok" and second["pending"] is False and second["finvizQueued"] is False
    by_url = {item["url"]: item["source"] for item in second["items"]}
    assert by_url["https://www.example.com/same"] == "yahoo", "같은 글은 Yahoo가 먼저(Finviz는 Yahoo 바로 뒤)"
    assert by_url["https://www.example.net/p1"] == "finviz", "Finviz는 Bing보다 먼저"
    assert by_url["https://finviz.com/news/900001/synthetic-note"] == "finviz"
    assert row["count"] == 3 and _row(second, "bing")["count"] == 0
    assert sum(r["count"] for r in second["sources"]) == len(second["items"])
    timeline = search.feed("us:SCHP", "timeline", owner=False, external=True)
    assert _row(timeline, "finviz")["status"] == "cached" and len(net.urls) == 1, "같은 티커는 30분 다시 씀"


def test_Finviz_새로_부르기_한도를_넘으면_줄에_넣지_않는다(monkeypatch):
    Stubs(monkeypatch)
    net = FinvizNet(monkeypatch, _finviz_page())
    out = search.feed("us:SCHP", "news", owner=False, external=True, finviz=False)
    row = _row(out, "finviz")
    assert (row["status"], row["message"]) == ("skipped", "한 사람이 한 시간에 Finviz를 새로 부를 수 있는 횟수를 넘음 — 받아 둔 결과만")
    assert out["finvizQueued"] is False and out["pending"] is False and net.budget == [] and net.urls == []


def test_Finviz는_서버가_아니면_server_only이고_네트워크_0건(monkeypatch):
    Stubs(monkeypatch)
    monkeypatch.setattr(search_finviz, "request", _real_finviz_request)
    monkeypatch.delenv(polite.ENV_ENABLED, raising=False)
    out = search.feed("us:SCHP", "timeline", owner=False, external=True)
    row = _row(out, "finviz")
    assert (row["status"], row["message"]) == ("server_only", "Finviz는 운영 서버에서만")
    assert out["pending"] is False and out["finvizQueued"] is False
    assert search_finviz.wait_idle(1)


def test_Finviz는_미국_상장_회사의_뉴스·타임라인에만(monkeypatch):
    stubs = Stubs(monkeypatch)
    for tab in ("filings", "research", "posts"):
        assert "finviz" not in {row["source"] for row in search.feed("us:SCHP", tab, owner=True, external=True)["sources"]}, tab
    for entity, key in ((KR_ENTITY, "kr:900001"), (INSTITUTION, "cik:0009000077"), (PERSON, "wd:Q900020"),
                        (search_entities.topic_entity("합성 반도체"), "topic:합성 반도체")):
        stubs.use(entity)
        out = search.feed(key, "timeline", owner=False, external=True)
        assert "finviz" not in {row["source"] for row in out["sources"]}, key
        assert out["finvizQueued"] is False
    assert stubs.finviz_calls == []
