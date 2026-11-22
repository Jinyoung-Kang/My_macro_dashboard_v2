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


def test_이름_검색은_13F_HR_회사_검색_한_번_atom(session):
    fake = session(SimpleNamespace(status_code=200, content=ATOM))
    out = lookup.search_filers("  fake   capital ")
    assert out["error"] is None and out["query"] == "fake capital"
    assert [row["cik"] for row in out["candidates"]] == ["0009900001", "0009900002"]
    (url, params), = fake.calls
    assert url == lookup.EDGAR_BROWSE
    assert params["company"] == "fake capital" and params["type"] == "13F-HR" and params["output"] == "atom"


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
