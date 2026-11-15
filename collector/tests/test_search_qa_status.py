"""
tests/test_search_qa_status.py
정보 검색 결과의 출처 상태 줄이 그 출처가 준 것을 말하는지(QA-437) — 네트워크·DB 없이, 모두 합성 값.

- 같은 글(계약 §4 규칙 4)은 우선순위가 앞선 출처 하나로 남고 건수(``count``)도 그쪽에 셉니다(상태 줄 건수의 합 = 줄 수 — §6-4).
  그래서 관심 대상 수집(``watch``)이 같은 기사를 이미 모아 두었으면 뒤의 출처(Finviz·Bing·구글)는 줄을 줬어도 0건이었고, 막 받은 결과면
  상태가 '결과 없음'(``empty``)이었음 — 운영 화면에서 Finviz 줄을 모두 관심 대상 수집이 가져가 '결과 없음 · 0건'(타임라인)·'캐시 · 0건'(뉴스 탭).
- 고친 뒤: 같은 글이라 다른 줄과 합친 수를 ``dropped.duplicate``에 셈(받은 줄 = 이 출처 건수 + 뺀 건수의 합), 거른 뒤 남은 줄이 있으면
  ``ok``(합친 줄만 있어도), 거른 뒤 하나도 없을 때만 ``empty``. 합치는 우선순위는 그대로.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services import search, search_filings, search_finviz, search_research, search_store
from app.services import search_sources as sources

COMPANY = {"key": "us:SYNB", "kind": "company", "name": "합성은행", "nameKo": "합성은행", "nameEn": "SynthBank Group",
           "aliases": ["합성은행", "SynthBank Group"], "description": None,
           "ids": {"ticker": "SYNB", "market": "us", "stockCode": None, "cik": None, "dartCorpCode": None,
                   "wikidata": "Q900031", "lei": None},
           "links": [], "sources": ["wikidata"]}
PERSON = {"key": "wd:Q900032", "kind": "person", "name": "Synth Investor", "nameKo": None, "nameEn": "Synth Investor",
          "aliases": ["Synth Investor"], "description": None,
          "ids": {"ticker": None, "market": None, "stockCode": None, "cik": None, "dartCorpCode": None, "wikidata": "Q900032",
                  "lei": None},
          "links": [], "sources": ["wikidata"]}


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) - delta).isoformat(timespec="seconds")


def _item(title: str, url: str, *, source: str, ago: timedelta = timedelta(days=1), kind: str = "news") -> dict:
    return sources.feed_item(title=title, url=url, publisher="Synthetic Wire", domain=search.rules.domain_of(url),
                             published=_iso(ago), source=source, lang="en", kind=kind)


# 관심 대상 수집이 이미 모은 Finviz 줄 — Finviz 안쪽 글 둘(finviz.com 주소)과 바깥 기사 하나. 같은 주소라 같은 id.
FINVIZ_ROWS = (
    ("SynthBank raises dividend outlook", "https://finviz.com/news/900101/synthbank-dividend", timedelta(hours=3)),
    ("SynthBank trims branch network", "https://finviz.com/news/900102/synthbank-branches", timedelta(days=2)),
    ("SynthBank third-quarter preview", "https://www.example.com/synthbank-q3", timedelta(days=5)),
)
WATCH_ONLY = ("SynthBank watch-only find", "https://www.example.org/synthbank-watch", timedelta(days=9))


class Net:
    """바깥 출처·저장본 자리. 시험이 ``results``를 바꿔 끼웁니다(넣지 않은 출처는 빈 결과)."""

    def __init__(self, monkeypatch, entity: dict):
        self.results: dict[str, sources.Fetched] = {}
        self.finviz = search_finviz.Answer("server_only", message="Finviz는 운영 서버에서만")
        monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": entity, "errors": {}, "fetchedAt": None})
        monkeypatch.setattr(sources, "google", lambda terms, lang, after: self._hit(f"google_{lang}"))
        monkeypatch.setattr(sources, "bing", lambda terms_by_lang, ticker=None: self._hit("bing"))
        monkeypatch.setattr(sources, "yahoo_news", lambda ticker: self._hit("yahoo"))
        monkeypatch.setattr(sources, "infomax", lambda terms, after: self._hit("infomax"))
        monkeypatch.setattr(sources, "naver", lambda code: self._hit("naver"))
        for name, source in (("event_news", "event_news"), ("wire", "wire"), ("info_posts", "info"), ("guru_views", "guru"),
                             ("feed_bundle", "feeds")):
            monkeypatch.setattr(search_store, name, lambda terms, source=source: self._hit(source))
        monkeypatch.setattr(search_store, "watch_items", self._watch)
        monkeypatch.setattr(search_filings, "sec_submissions", lambda cik, start_day: self._hit("sec"))
        monkeypatch.setattr(search_filings, "sec_fts", lambda phrases, start_day, end_day: self._hit("sec_fts"))
        monkeypatch.setattr(search_filings, "dart_list", lambda corp, start_day, end_day: self._hit("dart"))
        monkeypatch.setattr(search_research, "yahoo_grades", lambda ticker: self._hit("yahoo_research"))
        monkeypatch.setattr(search_research, "naver_research", lambda code: self._hit("naver_research"))
        monkeypatch.setattr(search_finviz, "request", lambda ticker, external=True, allow_queue=True: self.finviz)

    def _hit(self, source: str) -> sources.Fetched:
        return self.results.get(source, sources.Fetched(items=[]))

    def _watch(self, key, owner, kinds=None):
        result = self._hit("watch")
        return sources.Fetched(items=[item for item in result.items if kinds is None or item["kind"] in kinds])


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    search.reset_cache()
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    monkeypatch.setattr(search_store, "guru_names", lambda: [])
    monkeypatch.setattr(search_store, "user_excludes", lambda: search.rules.Excludes())
    yield
    search.reset_cache()


def _row(out: dict, source: str) -> dict:
    return next(row for row in out["sources"] if row["source"] == source)


def _finviz_case(monkeypatch, answer_status: str) -> Net:
    net = Net(monkeypatch, COMPANY)
    net.results["watch"] = sources.Fetched(items=[_item(title, url, source="watch", ago=ago) for title, url, ago in FINVIZ_ROWS]
                                           + [_item(WATCH_ONLY[0], WATCH_ONLY[1], source="watch", ago=WATCH_ONLY[2])])
    net.finviz = search_finviz.Answer(answer_status, items=tuple(_item(title, url, source="finviz", ago=ago)
                                                                 for title, url, ago in FINVIZ_ROWS))
    return net


@pytest.mark.xfail(strict=True, reason="QA-437: 수정 전 실패 — 관심 대상 수집과 같은 글뿐인 Finviz가 막 받았는데 '결과 없음'이고 합친 건수가 없음")
def test_Finviz_줄이_모두_관심_대상_수집과_같은_글이어도_받음이고_합친_건수를_적는다(monkeypatch):
    _finviz_case(monkeypatch, "ok")
    out = search.feed("us:SYNB", "timeline", owner=False, external=True)
    assert {item["source"] for item in out["items"]} == {"watch"}, "합치는 우선순위는 그대로 — 같은 글은 관심 대상 수집 줄로 남음"
    finviz = _row(out, "finviz")
    assert finviz["count"] == 0, "건수는 그 줄을 내준 출처에서(상태 줄 건수의 합 = 줄 수)"
    assert finviz["status"] == "ok", "줄을 3건 준 출처를 '결과 없음'으로 적지 않음"
    assert finviz["dropped"].get("duplicate") == 3, "같은 글이라 다른 줄과 합친 수"
    watch = _row(out, "watch")
    assert (watch["count"], watch["dropped"].get("duplicate")) == (4, 0)
    assert sum(row["count"] for row in out["sources"]) == len(out["items"])


@pytest.mark.xfail(strict=True, reason="QA-437: 수정 전 실패 — 캐시에서 읽은 Finviz도 합친 건수가 없어 '캐시 · 0건'만")
def test_뉴스_탭의_캐시된_Finviz도_합친_건수를_적는다(monkeypatch):
    _finviz_case(monkeypatch, "cached")
    out = search.feed("us:SYNB", "news", owner=False, external=True)
    finviz = _row(out, "finviz")
    assert (finviz["status"], finviz["count"]) == ("cached", 0)
    assert finviz["dropped"].get("duplicate") == 3


@pytest.mark.xfail(strict=True, reason="QA-437: 수정 전 실패 — 관심 대상 수집과 같은 글뿐인 Bing이 '결과 없음 · 0건'")
def test_사람의_Bing_줄이_관심_대상_수집과_겹치면_합친_건수를_적는다(monkeypatch):
    net = Net(monkeypatch, PERSON)
    shared = [("Synth Investor backs new fund", "https://www.example.net/backs-fund", timedelta(days=1)),
              ("Synth Investor letter to partners", "https://www.example.net/letter", timedelta(days=4))]
    net.results["watch"] = sources.Fetched(items=[_item(title, url, source="watch", ago=ago) for title, url, ago in shared])
    net.results["bing"] = sources.Fetched(items=[_item(title, url, source="bing", ago=ago) for title, url, ago in shared])
    out = search.feed("wd:Q900032", "timeline", owner=False, external=True)
    bing = _row(out, "bing")
    assert (bing["status"], bing["count"], bing["dropped"].get("duplicate")) == ("ok", 0, 2)

    search.reset_cache()
    net.results["bing"] = sources.Fetched(items=[_item(title, url, source="bing", ago=ago) for title, url, ago in shared]
                                          + [_item("Synth Investor interview", "https://www.example.net/interview", source="bing")])
    out = search.feed("wd:Q900032", "news", owner=False, external=True)
    bing = _row(out, "bing")
    assert (bing["status"], bing["count"], bing["dropped"].get("duplicate")) == ("ok", 1, 2)


@pytest.mark.xfail(strict=True, reason="QA-437: 수정 전 실패 — 같은 글로 합친 줄이 어디에도 세지 않아 받은 줄 수와 맞지 않음")
def test_받은_줄은_이_출처_건수와_뺀_건수의_합(monkeypatch):
    """출처마다 받은 줄 = 이 출처 줄로 남은 수 + 뺀 수(2년 밖·시각 모름·중국어 제목·제외 매체·같은 글). 같은 출처 안의 같은 글도 셈."""
    net = Net(monkeypatch, COMPANY)
    net.results["watch"] = sources.Fetched(items=[_item("SynthBank names new chief", "https://www.example.org/chief", source="watch")])
    net.results["google_en"] = sources.Fetched(items=[
        _item("SynthBank posts record quarterly profit", "https://news.google.com/rss/articles/S1", source="google_en",
              ago=timedelta(hours=5)),
        # 제목 앞 24자가 같은 경유 주소 — 같은 출처 안의 같은 글
        _item("SynthBank posts record quarterly profit - Example Times", "https://news.google.com/rss/articles/S2",
              source="google_en", ago=timedelta(hours=6)),
        _item("SynthBank old story", "https://news.google.com/rss/articles/S3", source="google_en", ago=timedelta(days=900)),
        # 관심 대상 수집이 원문 주소로 모은 같은 기사 — 다른 출처와 같은 글
        _item("SynthBank names new chief", "https://news.google.com/rss/articles/S4", source="google_en"),
    ])
    received = {"watch": 1, "google_en": 4}
    out = search.feed("us:SYNB", "news", owner=False, external=True)
    google = _row(out, "google_en")
    assert (google["status"], google["count"], google["dropped"]["old"], google["dropped"].get("duplicate")) == ("ok", 1, 1, 2)
    for source, total in received.items():
        row = _row(out, source)
        assert row["count"] + sum(row["dropped"].values()) == total, source
    assert sum(row["count"] for row in out["sources"]) == len(out["items"])


def test_거른_뒤_남은_줄이_없으면_지금처럼_결과_없음(monkeypatch):
    """준 줄이 없거나 모두 2년 밖이면 그대로 '결과 없음'(합친 줄 0)."""
    net = Net(monkeypatch, COMPANY)
    net.results["bing"] = sources.Fetched(items=[_item("SynthBank archive note", "https://www.example.net/archive", source="bing",
                                                       ago=timedelta(days=900))])
    out = search.feed("us:SYNB", "news", owner=False, external=True)
    bing = _row(out, "bing")
    assert (bing["status"], bing["count"], bing["dropped"]["old"], bing["dropped"].get("duplicate", 0)) == ("empty", 0, 1, 0)
    infomax = _row(out, "infomax")
    assert (infomax["status"], infomax["count"], infomax["dropped"].get("duplicate", 0)) == ("empty", 0, 0)
