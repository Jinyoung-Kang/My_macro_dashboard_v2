"""
tests/test_search_links.py
정보 검색 연결 보강(services/search_links · search.links · /live/search/links — 계약 §7-5, ADR 0041 단계 4) — 네트워크 없이 합성 값으로.

- Yahoo 내부자 명단(yfinance ``insider_roster_holders``): relation insider·kind person·key null, detail = 직위 + ' · 최근 <거래> <날짜>',
  공용 거부 래치를 먼저 봄, 미국 상장 회사가 아니면 skipped
- GLEIF(LEI로만): direct-parent·ultimate-parent(404 = 관계 없음 — 오류 아님)·direct-children?page[size]=20, 일반 이름 UA(Wikidata와 같음),
  자회사 20곳 넘으면 안내, 하루 캐시(일부라도 실패하면 60초), LEI가 없으면 skipped
- 응답 {entityKey, links, sources, fetchedAt}, 출처 상태 줄, 중국어 이름은 빼고 셈, external=false면 캐시만(offline, 바깥 0건)
- 경로: 대상 키 검사(틀리면 400), owner·external을 넘김
"""
from __future__ import annotations

from datetime import datetime

import pandas as pd
import pytest
import requests
from fastapi.testclient import TestClient
from yfinance.exceptions import YFRateLimitError

from app import http, main
from app.services import search, search_entities, search_links, search_store, search_wikidata

LEI = "SYNTH00000000000001"[:18] + "42"
PARENT_LEI = "SYNTHPARENT0000000" + "07"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    search.reset_cache()
    http.reset_guards()
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    monkeypatch.setattr(search_store, "guru_names", lambda: [])
    yield
    search.reset_cache()
    http.reset_guards()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "")
    monkeypatch.setattr(main.store, "ping", lambda: None)
    return TestClient(main.app, raise_server_exceptions=False)


# ------------------------------------------------------------------ Yahoo 내부자 명단

ROSTER = pd.DataFrame([
    {"Name": "Synthia Q. Founder", "Position": "Chief Executive Officer", "URL": "",
     "Most Recent Transaction": "Sale", "Latest Transaction Date": pd.Timestamp("2026-09-15"), "Shares Owned Directly": 10.0},
    {"Name": "Example Director", "Position": "Director", "URL": "", "Most Recent Transaction": "nan",
     "Latest Transaction Date": pd.NaT, "Shares Owned Directly": 1.0},
    {"Name": "", "Position": "Officer", "URL": "", "Most Recent Transaction": "Buy",
     "Latest Transaction Date": pd.Timestamp("2026-01-02")},
])


def test_내부자_명단_연결():
    links = search_links.insider_links(search_links.roster_rows(ROSTER))
    assert links == [
        {"relation": "insider", "key": None, "name": "Synthia Q. Founder", "kind": "person", "source": "yahoo",
         "detail": "Chief Executive Officer · 최근 Sale 2026-09-15"},
        {"relation": "insider", "key": None, "name": "Example Director", "kind": "person", "source": "yahoo",
         "detail": "Director"},
    ], "이름 없는 줄은 뺌, 거래가 없으면 직위만"


class Ticker:
    def __init__(self, value):
        self.value = value

    @property
    def insider_roster_holders(self):
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


def test_내부자_명단은_래치를_먼저_보고_요청_제한이면_래치를_닫는다(monkeypatch):
    monkeypatch.setattr(search_links, "_ticker", lambda symbol: Ticker(YFRateLimitError()))
    out = search_links.insiders("SCHP")
    assert out.error.startswith(http.REJECTED_MARK)
    monkeypatch.setattr(search_links, "_ticker", lambda symbol: pytest.fail("래치가 닫혀 있으면 부르지 않음"))
    assert search_links.insiders("SCHP").error.startswith(http.REJECTED_MARK)


def test_내부자_명단이_비면_빈_결과와_안내이고_60초만_캐시(monkeypatch):
    monkeypatch.setattr(search_links, "_ticker", lambda symbol: Ticker(pd.DataFrame()))
    out = search_links.insiders("SCHP")
    assert out.error is None and out.items == [] and out.note
    assert out.partial, "yfinance는 HTTP 오류도 빈 표로 줘 '명단 없음'과 가를 수 없음 — 일시 실패가 15분 동안 '없음'으로 남지 않게"
    calls = []
    fetch = lambda: calls.append(1) or search_links.insiders("SCHP")  # noqa: E731
    search_links.cached(("insiders", "SCHP"), fetch, ttl=search_links.INSIDERS_TTL)
    monotonic = search_links.time.monotonic
    monkeypatch.setattr(search_links.time, "monotonic", lambda: monotonic() + search_links.FAILURE_TTL + 1)
    search_links.cached(("insiders", "SCHP"), fetch, ttl=search_links.INSIDERS_TTL)
    assert calls == [1, 1], "빈 명단은 60초 뒤 다시 묻는다"


# ------------------------------------------------------------------ GLEIF

def _record(lei, name, country):
    return {"type": "lei-records", "id": lei,
            "attributes": {"lei": lei, "entity": {"legalName": {"name": name, "language": "en"},
                                                  "legalAddress": {"country": country}}}}


class Response:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload
        self.headers = {}

    def json(self):
        return self._payload


class GleifSession:
    def __init__(self, replies):
        self.replies = replies
        self.calls: list[dict] = []

    def get(self, url, params=None, timeout=None, headers=None):
        self.calls.append({"url": url, "params": params, "headers": headers})
        reply = self.replies[url.rsplit("/", 1)[-1].split("?", 1)[0]]
        if isinstance(reply, Exception):
            raise reply
        return reply


def _children(n, total=None):
    return {"meta": {"pagination": {"currentPage": 1, "perPage": 20, "total": n if total is None else total}},
            "data": [_record(f"SYNTHCHILD{index:08d}" + "11", f"Synth Child {index}", "US") for index in range(n)]}


def test_GLEIF_모회사·최상위_모회사·자회사(monkeypatch):
    session = GleifSession({
        "direct-parent": Response(200, {"data": _record(PARENT_LEI, "Synth Parent Holdings", "KR")}),
        "ultimate-parent": Response(404, {"errors": [{"status": "404", "title": "Not Found"}]}),
        "direct-children": Response(200, _children(20, total=34)),
    })
    monkeypatch.setattr(http, "pace", lambda *a, **k: None)
    out = search_links.gleif(LEI, session=session)
    assert out.error is None and out.note == "자회사 20곳까지(전체 34곳)"
    assert out.items[0] == {"relation": "parent", "key": None, "name": "Synth Parent Holdings", "kind": "company",
                            "source": "gleif", "detail": f"KR · LEI {PARENT_LEI}"}
    assert [link["relation"] for link in out.items].count("subsidiary") == 20
    assert not any(link["relation"] == "ultimate_parent" for link in out.items), "404는 관계 없음(오류 아님)"
    urls = [call["url"] for call in session.calls]
    assert urls == [f"https://api.gleif.org/api/v1/lei-records/{LEI}/direct-parent",
                    f"https://api.gleif.org/api/v1/lei-records/{LEI}/ultimate-parent",
                    f"https://api.gleif.org/api/v1/lei-records/{LEI}/direct-children?page[size]=20"]
    for call in session.calls:
        assert call["headers"]["User-Agent"] == search_wikidata.USER_AGENT and "@" not in call["headers"]["User-Agent"]


def test_GLEIF_실패는_호스트와_상태만이고_일부_실패는_안내(monkeypatch):
    monkeypatch.setattr(http, "pace", lambda *a, **k: None)
    failing = GleifSession({name: Response(503) for name in ("direct-parent", "ultimate-parent", "direct-children")})
    out = search_links.gleif(LEI, session=failing)
    assert out.error == "api.gleif.org HTTP 503" and out.items == []
    partial = GleifSession({"direct-parent": Response(200, {"data": _record(PARENT_LEI, "Synth Parent Holdings", "KR")}),
                            "ultimate-parent": requests.ConnectionError(f"/api/v1/lei-records/{LEI}/ultimate-parent"),
                            "direct-children": Response(200, _children(0))})
    out = search_links.gleif(LEI, session=partial)
    assert out.error is None and len(out.items) == 1 and out.partial
    assert out.note.startswith("일부 받지 못함(api.gleif.org") and LEI not in out.note


def test_GLEIF는_하루_캐시_일부라도_실패하면_60초(monkeypatch):
    calls = []
    results = {"ok": search_links.Linked(items=[{"relation": "parent"}]), "partial": search_links.Linked(items=[], partial=True)}
    first = search_links.cached(("gleif", "A"), lambda: calls.append("A") or results["ok"], ttl=search_links.GLEIF_TTL)
    again = search_links.cached(("gleif", "A"), lambda: calls.append("A") or results["ok"], ttl=search_links.GLEIF_TTL)
    assert calls == ["A"] and not first.cached and again.cached and again.items == [{"relation": "parent"}]
    search_links.cached(("gleif", "B"), lambda: calls.append("B") or results["partial"], ttl=search_links.GLEIF_TTL)
    monotonic = search_links.time.monotonic
    monkeypatch.setattr(search_links.time, "monotonic", lambda: monotonic() + search_links.FAILURE_TTL + 1)
    search_links.cached(("gleif", "B"), lambda: calls.append("B") or results["partial"], ttl=search_links.GLEIF_TTL)
    search_links.cached(("gleif", "A"), lambda: calls.append("A") or results["ok"], ttl=search_links.GLEIF_TTL)
    assert calls == ["A", "B", "B"], "일부 실패는 60초 뒤 다시, 성공은 하루"
    offline = search_links.cached(("gleif", "C"), lambda: pytest.fail("부르면 안 됩니다"), ttl=1.0, external=False)
    assert offline.offline


# ------------------------------------------------------------------ search.links

US = {"key": "us:SCHP", "kind": "company", "name": "합성칩", "nameKo": "합성칩", "nameEn": "SynthChip", "aliases": ["SynthChip"],
      "description": None, "links": [], "sources": [],
      "ids": {"ticker": "SCHP", "market": "us", "stockCode": None, "cik": "0009000001", "dartCorpCode": None,
              "wikidata": "Q900001", "lei": LEI}}
PERSON = {"key": "wd:Q900020", "kind": "person", "name": "Synth Founder", "nameKo": None, "nameEn": "Synth Founder",
          "aliases": [], "description": None, "links": [], "sources": [],
          "ids": {"ticker": None, "market": None, "stockCode": None, "cik": None, "dartCorpCode": None, "wikidata": "Q900020",
                  "lei": None}}


def _row(out, source):
    return next(row for row in out["sources"] if row["source"] == source)


def _stub(monkeypatch, entity, *, insiders=None, gleif=None):
    calls = []
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": entity, "errors": {}, "fetchedAt": None})
    monkeypatch.setattr(search_links, "insiders",
                        lambda ticker: calls.append(("insiders", ticker)) or (insiders or search_links.Linked()))
    monkeypatch.setattr(search_links, "gleif", lambda lei: calls.append(("gleif", lei)) or (gleif or search_links.Linked()))
    return calls


def test_연결_응답과_출처_상태(monkeypatch):
    gleif = search_links.Linked(items=[
        {"relation": "parent", "key": None, "name": "Synth Parent Holdings", "kind": "company", "source": "gleif",
         "detail": "KR · LEI X"},
        {"relation": "subsidiary", "key": None, "name": "合成芯片上海有限公司", "kind": "company", "source": "gleif",
         "detail": "CN · LEI Y"},
    ], note="자회사 20곳까지(전체 34곳)")
    insiders = search_links.Linked(items=[{"relation": "insider", "key": None, "name": "Synthia Q. Founder", "kind": "person",
                                           "source": "yahoo", "detail": "Chief Executive Officer"}])
    calls = _stub(monkeypatch, US, insiders=insiders, gleif=gleif)
    out = search.links("us:SCHP", external=True, owner=False)
    assert set(out) == {"entityKey", "links", "sources", "fetchedAt"} and out["entityKey"] == "us:SCHP"
    assert sorted(calls) == [("gleif", LEI), ("insiders", "SCHP")]
    assert [link["name"] for link in out["links"]] == ["Synthia Q. Founder", "Synth Parent Holdings"], "중국어 이름은 뺌"
    assert [row["source"] for row in out["sources"]] == ["insiders", "gleif"]
    assert _row(out, "insiders") == {"source": "insiders", "label": "내부자 명단(Yahoo)", "status": "ok", "count": 1,
                                     "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": None}
    gleif_row = _row(out, "gleif")
    assert (gleif_row["status"], gleif_row["count"], gleif_row["dropped"]["chinese"]) == ("ok", 1, 1)
    assert gleif_row["label"] == "법인 관계(GLEIF)" and gleif_row["message"] == "자회사 20곳까지(전체 34곳)"
    datetime.fromisoformat(out["fetchedAt"])

    again = search.links("us:SCHP", external=True, owner=False)
    assert len(calls) == 2 and _row(again, "gleif")["status"] == "cached", "캐시"


def test_미국_상장_회사가_아니면_내부자는_LEI가_없으면_GLEIF는_skipped(monkeypatch):
    calls = _stub(monkeypatch, PERSON)
    out = search.links("wd:Q900020", external=True)
    assert calls == [] and out["links"] == []
    assert _row(out, "insiders")["status"] == "skipped" and "미국 상장 회사" in _row(out, "insiders")["message"]
    assert _row(out, "gleif")["status"] == "skipped"
    assert _row(out, "gleif")["message"] == "LEI 없음 — Wikidata에 법인 식별자가 없음"


NO_LEI = "LEI 없음 — Wikidata에 법인 식별자가 없음"
NO_ITEM = "Wikidata 항목을 찾지 못해 LEI를 모름"


@pytest.mark.parametrize("errors, external, wikidata, status, message", [
    ({"wikidata": search.OFFLINE}, False, "Q900001", "offline", None),
    ({"wikidata": search.OFFLINE}, True, "Q900001", "offline", None),
    ({"wikidata": "www.wikidata.org HTTP 503"}, True, "Q900001", "error", None),
    ({"wikidata": "www.wikidata.org HTTP 503"}, False, "Q900001", "offline", None),
    ({"entity": "대상 풀기가 15초를 넘어 저장본 이름으로만 답함"}, True, "Q900001", "error", None),
    # Wikidata 항목을 읽었고 LEI가 없을 때만 'LEI 없음'(QA 단계 4 Q2) — 항목을 찾지 못했거나 묻지 않았으면 '모름'.
    ({}, False, "Q900001", "skipped", NO_LEI),
    ({}, True, "Q900001", "skipped", NO_LEI),
    ({"wikidata": search_entities.WD_MISSING}, True, None, "skipped", NO_ITEM),
    ({"wikidata": search_entities.WD_MISSING}, True, "Q900001", "skipped", NO_ITEM),
    ({}, True, None, "skipped", NO_ITEM),
])
def test_Wikidata를_읽지_못해_LEI를_모르면_LEI_없음이라_하지_않는다(monkeypatch, errors, external, wikidata, status, message):
    no_lei = dict(US, ids=dict(US["ids"], lei=None, wikidata=wikidata))
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": no_lei, "errors": errors, "fetchedAt": None})
    monkeypatch.setattr(search_links, "insiders", lambda ticker: search_links.Linked())
    monkeypatch.setattr(search_links, "gleif", lambda lei: pytest.fail("LEI 없이 부르면 안 됩니다"))
    row = _row(search.links("us:SCHP", external=external), "gleif")
    assert row["status"] == status
    if status == "skipped":
        assert row["message"] == message, "Wikidata가 항목을 답했는데 LEI가 없을 때만 'LEI 없음'"
    else:
        assert "LEI 없음" not in row["message"], "확인하지 못한 것을 '없음'으로 보이지 않음"
    if status == "offline":
        assert row["message"] == search.OFFLINE
    if status == "error":
        assert next(iter(errors.values())) in row["message"]


def test_외부_호출을_끄면_캐시만_보고_바깥으로_나가지_않는다(monkeypatch):
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": US, "errors": {}, "fetchedAt": None})
    monkeypatch.setattr(requests.Session, "get", lambda *a, **k: pytest.fail("바깥 요청"))
    monkeypatch.setattr(search_links, "_ticker", lambda symbol: pytest.fail("yfinance"))
    out = search.links("us:SCHP", external=False)
    assert {row["source"]: row["status"] for row in out["sources"]} == {"insiders": "offline", "gleif": "offline"}


def test_풀지_못한_대상은_건너뜀(monkeypatch):
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": None, "errors": {}, "fetchedAt": None})
    out = search.links("wd:Q900099", external=True)
    assert out["links"] == [] and {row["status"] for row in out["sources"]} == {"skipped"}
    out = search.links("wd:Q900099", external=False)
    assert {row["status"] for row in out["sources"]} == {"offline"}


def test_연결_경로는_키를_검사하고_인자를_넘긴다(client, monkeypatch):
    seen = []
    monkeypatch.setattr(search, "links", lambda e, external=True, owner=False: seen.append((e, external, owner)) or {"links": []})
    for path in ("/live/search/links", "/live/search/links?e=NVDA", "/live/search/links?e=us:nvda", "/live/search/links?e=topic:"):
        assert client.get(path).status_code == 400, path
    assert seen == []
    assert client.get("/live/search/links?e=us:BRK.B&external=false&owner=true").status_code == 200
    assert client.get("/live/search/links?e=topic:%20AI%20반도체").status_code == 200
    assert seen == [("us:BRK.B", False, True), ("topic:AI 반도체", True, False)]
