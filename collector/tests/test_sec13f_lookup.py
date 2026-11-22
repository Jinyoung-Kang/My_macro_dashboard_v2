"""
13F 즐겨찾기의 SEC 조회(services/sec13f_lookup — ADR 0048). SEC 응답은 2026-11-23 실제 응답의 모양을 줄인 고정 자료입니다(이름·CIK는 가짜).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import http
from app.services import sec13f_lookup as lookup

ATOM = b"""<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <author><email>webmaster@sec.gov</email><name>Webmaster</name></author>
  <entry>
    <content type="text/xml"><company-info>
      <cik>0009900001</cik><name>FAKE CAPITAL LLC /ADV</name><state>MA</state>
    </company-info></content>
    <title>FAKE CAPITAL LLC /ADV</title>
  </entry>
  <entry>
    <content type="text/xml"><company-info>
      <cik>0009900002</cik><name>FAKE   CAPITAL GROUP LLC/MA</name>
    </company-info></content>
    <title>FAKE CAPITAL GROUP LLC/MA</title>
  </entry>
  <entry>
    <content type="text/xml"><company-info><cik>0009900002</cik><name>DUPLICATE</name></company-info></content>
  </entry>
  <entry><content type="text/xml"><company-info><name>NO CIK</name></company-info></content></entry>
  <title>Company Search Feed</title>
</feed>"""

EMPTY_ATOM = b"""<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom"><author><name>Webmaster</name></author><title>Company Search Feed</title></feed>"""


def test_atom_후보는_CIK와_이름_응답_차례_겹치면_처음_것():
    assert lookup.parse_company_atom(ATOM) == [
        {"cik": "0009900001", "name": "FAKE CAPITAL LLC /ADV"},
        {"cik": "0009900002", "name": "FAKE CAPITAL GROUP LLC/MA"},
    ]


def test_atom_빈_피드와_XML이_아닌_응답은_빈_목록():
    assert lookup.parse_company_atom(EMPTY_ATOM) == []
    assert lookup.parse_company_atom(b"<html>not xml") == []


def test_submissions는_원본_13F_HR의_가장_최근_공시만():
    payload = {
        "name": "FAKE  CAPITAL GROUP LLC/MA",
        "filings": {
            "recent": {
                "form": ["13F-HR/A", "13F-HR", "SC 13G", "13F-HR", "13F-NT"],
                "filingDate": ["2026-09-01", "2026-08-14", "2026-08-20", "2026-05-15", "2026-11-14"],
                "reportDate": ["2026-06-30", "2026-06-30", "", "2026-03-31", "2026-09-30"],
            },
            "files": [],
        },
    }
    assert lookup.parse_submissions_13f(payload) == {
        "name": "FAKE CAPITAL GROUP LLC/MA",
        "latest13F": {"filingDate": "2026-08-14", "reportDate": "2026-06-30"},
        "olderFiles": False,
    }


def test_submissions에_13F_HR이_없으면_latest13F_None():
    payload = {"name": "FAKE", "filings": {"recent": {"form": ["13F-NT", "10-K"], "filingDate": ["2026-11-14", "2026-03-01"]}}}
    assert lookup.parse_submissions_13f(payload)["latest13F"] is None
    assert lookup.parse_submissions_13f(None)["name"] is None


@pytest.mark.parametrize("raw,expected", [("1061768", "0001061768"), (" 0001061768 ", "0001061768"), ("0", None), ("abc", None),
                                          ("12345678901", None), ("", None)])
def test_CIK_정규화(raw, expected):
    assert lookup.normalize_cik(raw) == expected


class _Session:
    def __init__(self, response):
        self.response = response
        self.calls: list[tuple[str, dict | None]] = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return self.response


@pytest.fixture
def session(monkeypatch):
    holder = {}

    def install(response):
        fake = _Session(response)
        holder["session"] = fake
        monkeypatch.setattr(http, "get_sec_session", lambda: fake)
        monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
        return fake

    return install


def test_이름_검색은_13F_HR_회사_검색_atom과_전문_검색_제출자_묶음(session):
    # 두 번째(전문 검색) 응답은 제출자 묶음이 없는 빈 JSON — 앞부분 일치 후보만 남습니다(QA-985 뒤 SEC 두 번).
    fake = session(SimpleNamespace(status_code=200, content=ATOM, json=lambda: {}))
    out = lookup.search_filers("  fake   capital ")
    assert out["error"] is None and out["query"] == "fake capital"
    assert [row["cik"] for row in out["candidates"]][:2] == ["0009900001", "0009900002"]
    (url, params), (fts_url, fts_params) = fake.calls[:2]
    assert url == lookup.EDGAR_BROWSE
    assert params["company"] == "fake capital" and params["type"] == "13F-HR" and params["output"] == "atom"
    assert "efts.sec.gov" in fts_url and fts_params == {"q": "", "entityName": "fake capital", "forms": "13F-HR"}


def test_검색어가_맞지_않으면_SEC를_부르지_않는다(session):
    fake = session(SimpleNamespace(status_code=200, content=ATOM))
    assert lookup.search_filers("a")["error"]
    assert lookup.search_filers("x" * 61)["error"]
    assert fake.calls == []


def test_SEC_실패는_호스트와_상태만(session):
    session(SimpleNamespace(status_code=403, content=b""))
    out = lookup.search_filers("fake capital")
    assert out == {"query": "fake capital", "candidates": [], "error": "www.sec.gov HTTP 403"}


def test_filer_info_404는_공시_목록_없음(session):
    session(SimpleNamespace(status_code=404, content=b""))
    assert lookup.filer_info("9900001")["error"] == "이 CIK의 SEC 공시 목록이 없습니다"


def test_filer_info는_이름과_최근_13F(session):
    payload = {"name": "FAKE CAPITAL", "filings": {"recent": {"form": ["13F-HR"], "filingDate": ["2026-08-14"], "reportDate": ["2026-06-30"]}}}
    session(SimpleNamespace(status_code=200, json=lambda: payload))
    assert lookup.filer_info("9900001") == {
        "cik": "0009900001", "name": "FAKE CAPITAL", "latest13F": {"filingDate": "2026-08-14", "reportDate": "2026-06-30"}, "error": None,
    }


# QA-983: SEC 등록 이름은 영문뿐인데 한글 검색어를 그대로 보내면 SEC가 47초쯤 뒤 503을 돌려줘(2026-11-23 서버 재현), 백엔드가 25초에 끊고
# '수집기에 닿지 못해'로 적었습니다. 영문(ASCII)이 아닌 검색어는 SEC를 부르지 않고 바로 까닭을 돌려줘야 합니다.
def test_QA983_영문이_아닌_검색어는_SEC를_부르지_않는다(session):
    fake = session(SimpleNamespace(status_code=200, content=ATOM))
    out = lookup.search_filers("아팔루사")
    assert fake.calls == []
    assert out["candidates"] == [] and "영문" in (out["error"] or "")



# ------------------------------------------------------------------ QA-985·986 (2026-11-23)

FTS_GREENLIGHT = {
    "hits": {"total": {"value": 97}, "hits": []},
    "aggregations": {"entity_filter": {"buckets": [
        {"key": "GREENLIGHT CAPITAL INC  (CIK 0009900011)", "doc_count": 97},
        {"key": "FAKE GREENLIGHT FUND LP  (GLX, GLX-W)  (CIK 0009900012)", "doc_count": 3},
    ]}},
}


def _submissions(name: str, form: str = "13F-HR", filed: str = "2026-08-14") -> dict:
    return {"name": name, "filings": {"recent": {"form": [form], "filingDate": [filed], "reportDate": ["2026-06-30"]}}}


class _Router:
    """주소마다 다른 가짜 응답 — 회사 검색(atom)·전문 검색(JSON)·submissions(JSON)."""

    def __init__(self, atom: bytes, fts: dict | None, submissions: dict[str, dict]):
        self.atom, self.fts, self.submissions = atom, fts, submissions
        self.calls: list[str] = []

    def get(self, url, params=None, timeout=None):
        self.calls.append(url)
        if url == lookup.EDGAR_BROWSE:
            return SimpleNamespace(status_code=200, content=self.atom)
        if "efts.sec.gov" in url:
            if self.fts is None:
                return SimpleNamespace(status_code=503, content=b"", json=lambda: {})
            return SimpleNamespace(status_code=200, json=lambda: self.fts)
        cik = url.rsplit("CIK", 1)[-1].split(".")[0]
        body = self.submissions.get(cik)
        if body is None:
            return SimpleNamespace(status_code=404, content=b"", json=lambda: {})
        return SimpleNamespace(status_code=200, json=lambda body=body: body)


@pytest.fixture
def router(monkeypatch):
    def install(atom=EMPTY_ATOM, fts=None, submissions=None):
        fake = _Router(atom, fts, submissions or {})
        monkeypatch.setattr(http, "get_sec_session", lambda: fake)
        monkeypatch.setattr(http, "sec_rate_limit", lambda: None)
        return fake
    return install


# QA-985: 회사 검색(앞부분 일치)만 써서 'greenlight'로 옛 13F 제출자(GREENLIGHT CAPITAL INC)·이름 가운데 낱말('square')을 찾지 못했습니다.
def test_QA985_이름_가운데_낱말과_옛_제출자도_전문_검색_제출자_묶음으로_찾는다(router):
    router(fts=FTS_GREENLIGHT)
    out = lookup.search_filers("greenlight")
    assert out["error"] is None
    assert [(row["cik"], row["name"]) for row in out["candidates"]] == [
        ("0009900011", "GREENLIGHT CAPITAL INC"), ("0009900012", "FAKE GREENLIGHT FUND LP")]


# QA-986: 후보마다 최근 13F 공시일이 없어 오래 전에 멈춘 제출자인지 고르기 전에 알 수 없었습니다.
def test_QA986_후보마다_최근_원본_13F_HR_공시일(router):
    router(atom=ATOM, submissions={"0009900001": _submissions("FAKE CAPITAL LLC"),
                                   "0009900002": _submissions("FAKE CAPITAL GROUP", form="13F-NT")})
    out = lookup.search_filers("fake capital")
    by_cik = {row["cik"]: row for row in out["candidates"]}
    assert by_cik["0009900001"]["latest13F"] == {"filingDate": "2026-08-14", "reportDate": "2026-06-30"}
    assert by_cik["0009900001"]["checked"] is True
    assert by_cik["0009900002"]["latest13F"] is None and by_cik["0009900002"]["checked"] is True
