"""
tests/test_search_sources.py
정보 검색의 바깥 출처(services/search_sources.py) — 네트워크 없이 합성 응답으로 봅니다(실제 응답 원문은 넣지 않음 — ADR 0026 결정 12).

- 구글 뉴스 RSS: 제목 끝 ' - 매체'를 떼고, 매체 도메인은 <source url>의 호스트, 주소는 경유 주소 그대로, 같은 글 키는 제목 앞 24자
- Bing 뉴스 RSS: 원문 주소는 링크의 인자 url, 매체는 News:Source, 요약은 300자 상한
- Yahoo 검색 뉴스: relatedTickers에 그 티커가 있는 줄만(BRK.B ↔ BRK-B)
- 요청: 구글은 판마다 hl·gl·ceid와 after:, Bing은 format=rss·setlang·cc — 공용 세션으로
- 출처별 캐시: 성공 15분·실패 60초, 외부 호출을 끈 경우(external=false)는 캐시만 보고 부르지 않음(offline)
- 오류 글에 경로·검색어를 싣지 않음, urllib3 재시도 경고에서도 검색어를 지움
"""
from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from app.services import detail, info_text
from app.services import search_sources as sources

GOOGLE_RSS = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>합성</title>
<item><title>합성 기업, 새 칩 공개 - 합성 통신</title><link>https://news.google.com/rss/articles/SYNTH1?oc=5</link>
<pubDate>Fri, 13 Nov 2026 07:00:00 GMT</pubDate><description>&lt;a href="x"&gt;합성&lt;/a&gt;</description>
<source url="https://www.synthetic-wire.example">합성 통신</source></item>
<item><title>No source item</title><link>https://news.google.com/rss/articles/SYNTH2</link></item>
<item><title>Item without link</title></item>
</channel></rss>""".encode()

BING_RSS = b"""<?xml version="1.0" encoding="utf-8"?><rss xmlns:News="https://www.bing.com:443/news/search?q=x&amp;format=rss" version="2.0">
<channel><title>synthetic</title>
<item><title>Fund manager adds stake</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=1&amp;url=https%3a%2f%2fwww.example.org%2fnews%2fa1%3fid%3d7&amp;c=1&amp;mkt=en-us</link>
<description>Short synthetic summary.</description><pubDate>Thu, 12 Nov 2026 15:04:00 GMT</pubDate><News:Source>Example Org on MSN</News:Source></item>
<item><title>Link without url parameter</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss</link>
<description></description><pubDate>Thu, 12 Nov 2026 14:00:00 GMT</pubDate></item>
</channel></rss>"""


@pytest.fixture(autouse=True)
def _fresh():
    sources.reset_cache()
    yield
    sources.reset_cache()


class FakeSession:
    def __init__(self, responses=None, error=None):
        self.calls = []
        self.responses = list(responses or [])
        self.error = error

    def get(self, url, params=None, timeout=None, headers=None):
        self.calls.append({"url": url, "params": dict(params or {}), "timeout": timeout, "headers": headers})
        if self.error is not None:
            raise self.error
        status, body = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        return SimpleNamespace(status_code=status, content=body, headers={"Content-Type": "application/rss+xml"},
                               json=lambda: None)


# ------------------------------------------------------------------ 파싱

def test_구글_뉴스_파싱():
    items = sources.parse_google(GOOGLE_RSS, "application/rss+xml", source="google_ko", lang="ko")
    assert len(items) == 2
    first = items[0]
    assert first["title"] == "합성 기업, 새 칩 공개"
    assert first["publisher"] == "합성 통신" and first["publisherDomain"] == "synthetic-wire.example"
    assert first["url"] == "https://news.google.com/rss/articles/SYNTH1?oc=5"
    assert first["publishedAt"] == "2026-11-13T07:00:00+00:00" and first["timeBasis"] == "published"
    assert first["id"] == "합성기업새칩공개"
    assert first["source"] == "google_ko" and first["lang"] == "ko" and first["kind"] == "news"
    assert first["summary"] is None and first["readerId"] is None
    assert items[1]["publishedAt"] is None and items[1]["publisherDomain"] is None, "모르는 값은 null"


def test_Bing_뉴스_파싱은_인자_url에서_원문을_꺼낸다():
    items = sources.parse_bing(BING_RSS, "application/rss+xml", lang="en")
    first = items[0]
    assert first["url"] == "https://www.example.org/news/a1?id=7"
    assert first["publisherDomain"] == "example.org" and first["publisher"] == "Example Org on MSN"
    assert first["id"] == info_text.item_id("https://www.example.org/news/a1?id=7")
    assert first["summary"] == "Short synthetic summary." and first["source"] == "bing" and first["lang"] == "en"
    assert first["publishedAt"] == "2026-11-12T15:04:00+00:00"
    second = items[1]
    assert second["publisherDomain"] is None and second["publisher"] is None and second["summary"] is None


def test_Bing_요약은_300자_상한():
    long_rss = BING_RSS.replace(b"Short synthetic summary.", b"x" * 900)
    assert len(sources.parse_bing(long_rss, None, lang="en")[0]["summary"]) == 300


def test_Yahoo는_relatedTickers에_그_티커가_있는_줄만():
    news = [
        {"title": "Synthetic A", "link": "https://finance.yahoo.com/news/a", "publisher": "Wire A",
         "providerPublishTime": 1_794_553_200, "relatedTickers": ["BRK-B", "AAPL"]},
        {"title": "Synthetic B", "link": "https://finance.yahoo.com/news/b", "publisher": "Wire B",
         "providerPublishTime": 1_794_553_200, "relatedTickers": ["MSFT"]},
        {"title": "Synthetic C", "link": "https://finance.yahoo.com/news/c", "publisher": "Wire C",
         "providerPublishTime": 1_794_553_200},
    ]
    items, other = sources.yahoo_items(news, "BRK.B")
    assert [item["title"] for item in items] == ["Synthetic A"] and other == 2
    assert items[0]["source"] == "yahoo" and items[0]["publisherDomain"] == "finance.yahoo.com"


# ------------------------------------------------------------------ 요청

def test_구글_요청은_판의_인자와_after를_붙인다(monkeypatch):
    session = FakeSession([(200, GOOGLE_RSS)])
    monkeypatch.setattr(sources.http, "get_session", lambda: session)
    fetched = sources.google(["Ken Griffin", "Kenneth Cordele Griffin"], "en", after="2024-11-14")
    assert fetched.error is None and len(fetched.items) == 2
    call = session.calls[0]
    assert call["url"] == "https://news.google.com/rss/search"
    assert call["params"] == {"q": '"Ken Griffin" OR "Kenneth Cordele Griffin" after:2024-11-14',
                              "hl": "en-US", "gl": "US", "ceid": "US:en"}
    assert all(item["source"] == "google_en" for item in fetched.items)
    sources.google(["삼성전자"], "ko", after="2024-11-14")
    assert session.calls[1]["params"]["hl"] == "ko" and session.calls[1]["params"]["ceid"] == "KR:ko"


def test_연합인포맥스는_사이트로_좁힌_구글_검색():
    session = FakeSession([(200, GOOGLE_RSS)])
    sources.http.get_session  # noqa: B018 — 모듈 속성 존재 확인
    fetched = sources.infomax(["삼성전자"], after="2024-11-14", session=session)
    assert session.calls[0]["params"]["q"] == '"삼성전자" site:news.einfomax.co.kr after:2024-11-14'
    assert all(item["source"] == "infomax" for item in fetched.items)


def test_Bing은_판마다_부르고_합친다(monkeypatch):
    session = FakeSession([(200, BING_RSS)])
    monkeypatch.setattr(sources.http, "get_session", lambda: session)
    fetched = sources.bing({"ko": ["삼성전자"], "en": ["Samsung Electronics"]})
    assert [call["params"]["setlang"] for call in session.calls] == ["ko-KR", "en-US"]
    assert [call["params"]["cc"] for call in session.calls] == ["KR", "US"]
    assert all(call["params"]["format"] == "rss" for call in session.calls)
    assert session.calls[0]["url"] == "https://www.bing.com/news/search"
    assert len(fetched.items) == 4 and fetched.error is None


EMPTY_RSS = b"""<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>empty</title></channel></rss>"""


def test_Bing_구문은_판마다_하나씩_여러_단어_이름_먼저_최대_2개():
    """서버 실측(2026-11-14): Bing 뉴스 RSS는 '"A" OR "B"' 모양과 아주 흔한 한 단어(NVIDIA)에 0건 — 여러 단어 구문·한글 이름에는 줌."""
    assert sources.bing_queries(["NVIDIA", "Nvidia Corp", "NVIDIA Corporation"]) == ['"Nvidia Corp"', '"NVIDIA Corporation"']
    assert sources.bing_queries(["엔비디아"]) == ['"엔비디아"']
    assert sources.bing_queries(['  Ken   "Griffin"  ', "ken griffin", "Griffin"]) == ['"Ken Griffin"', '"Griffin"']
    assert sources.bing_queries(["", '""', "  "]) == []


def test_Bing_한_단어_이름뿐인_미국_종목은_티커를_붙여_먼저_묻는다():
    """서버 실측(2026-11-14): '"NVIDIA"'는 0건, '"NVIDIA" NVDA' 9건·'"Apple" AAPL' 12건 — 티커는 검색을 넓히지 않고 좁힘(따옴표 밖 낱말)."""
    assert sources.bing_queries(["NVIDIA"], ticker="NVDA") == ['"NVIDIA" NVDA']
    assert sources.bing_queries(["NVIDIA", "NVIDIA Corporation"], ticker="NVDA") == ['"NVIDIA Corporation"', '"NVIDIA" NVDA']
    assert sources.bing_queries(["NVIDIA"], ticker="nv da") == ['"NVIDIA"'], "티커 모양이 아니면 붙이지 않음"
    assert sources.bing_queries(["NVIDIA"], ticker="BRK.B") == ['"NVIDIA" BRK.B']
    assert sources.bing_queries([], ticker="NVDA") == []


def test_Bing은_구문_하나씩_묻고_0건이면_다음_구문으로_한_번_더(monkeypatch):
    session = FakeSession([(200, EMPTY_RSS), (200, EMPTY_RSS), (200, BING_RSS)])
    fetched = sources.bing({"ko": ["삼성전자"], "en": ["Samsung", "Samsung Electronics"]}, session=session)
    queries = [(call["params"]["setlang"], call["params"]["q"]) for call in session.calls]
    assert queries == [("ko-KR", '"삼성전자"'), ("en-US", '"Samsung Electronics"'), ("en-US", '"Samsung"')]
    assert all(" OR " not in query for _, query in queries)
    assert len(fetched.items) == 2 and fetched.error is None, "한국어 판 0건(구문 하나뿐) + 영어 판 두 번째 구문"


def test_Bing은_영어_판에만_티커를_붙인다():
    session = FakeSession([(200, BING_RSS)])
    sources.bing({"ko": ["엔비디아"], "en": ["NVIDIA"]}, session=session, ticker="NVDA")
    assert [call["params"]["q"] for call in session.calls] == ['"엔비디아"', '"NVIDIA" NVDA']


def test_Bing은_받은_글이_있거나_실패하면_다음_구문을_묻지_않는다():
    session = FakeSession([(200, BING_RSS)])
    sources.bing({"en": ["Samsung Electronics", "Samsung Electronics Co"]}, session=session)
    assert len(session.calls) == 1
    failing = FakeSession([(503, b"")])
    fetched = sources.bing({"en": ["Samsung Electronics", "Samsung Electronics Co"]}, session=failing)
    assert len(failing.calls) == 1 and fetched.error and "503" in fetched.error


def test_Bing_두_번째_구문은_before_retry가_허락할_때만():
    asked = []
    session = FakeSession([(200, EMPTY_RSS)])
    fetched = sources.bing({"en": ["Samsung Electronics", "Samsung"]}, session=session,
                           before_retry=lambda: asked.append("retry") or False)
    assert asked == ["retry"] and len(session.calls) == 1 and fetched.items == [] and fetched.error is None
    session = FakeSession([(200, EMPTY_RSS)])
    sources.bing({"en": ["Samsung Electronics", "Samsung"]}, session=session, before_retry=lambda: True)
    assert len(session.calls) == 2


def test_Bing_한_판만_실패하면_받은_것과_안내():
    class Half(FakeSession):
        def get(self, url, params=None, timeout=None, headers=None):
            if params["setlang"] == "ko-KR":
                self.calls.append(params)
                return SimpleNamespace(status_code=503, content=b"", headers={}, json=lambda: None)
            return super().get(url, params, timeout, headers)
    session = Half([(200, BING_RSS)])
    fetched = sources.bing({"ko": ["삼성전자"], "en": ["Samsung Electronics"]}, session=session)
    assert fetched.error is None and len(fetched.items) == 2
    assert "한국어" in fetched.note and "503" in fetched.note


def test_실패_사유에는_경로·검색어가_없다(monkeypatch):
    error = ConnectionError("HTTPSConnectionPool(host='news.google.com', port=443): Read failed: "
                            "/rss/search?q=%22Secret+Name%22 (Caused by X)")
    session = FakeSession(error=error)
    monkeypatch.setattr(sources.http, "get_session", lambda: session)
    fetched = sources.google(["Secret Name"], "en", after="2024-11-14")
    assert fetched.items == [] and fetched.error
    assert "Secret" not in fetched.error and "/rss/search" not in fetched.error and "?q=" not in fetched.error
    fetched = sources.google(["Secret Name"], "en", after="2024-11-14", session=FakeSession([(429, b"")]))
    assert fetched.error == "news.google.com HTTP 429"


def test_urllib3_재시도_경고에서_검색어를_지운다(caplog):
    logger = logging.getLogger("urllib3.connectionpool")
    with caplog.at_level(logging.WARNING, logger="urllib3.connectionpool"):
        logger.warning("Retrying (%r) after connection broken by '%r': %s", "Retry(total=1)", "ReadTimeout",
                       '/rss/search?q=%22Secret+Name%22+after%3A2024-11-14&hl=en-US')
        logger.warning("Retrying after: %s", "/api/other?series_id=X")
        logger.warning("Retrying after: %s", "/api/news/stock/900001?pageSize=20&page=1")
    messages = [record.getMessage() for record in caplog.records]
    assert "900001" not in messages[2], "종목 뉴스 경로의 종목코드도 지움"
    assert "Secret" not in messages[0] and "/rss/search" not in messages[0] and "생략" in messages[0]
    assert messages[1].endswith("/api/other?series_id=X"), "검색 경로가 아닌 로그는 그대로"


# ------------------------------------------------------------------ 출처별 캐시

def test_성공은_15분_실패는_60초_캐시(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(sources.time, "monotonic", lambda: now[0])
    calls = []

    def good():
        calls.append("good")
        return sources.Fetched(items=[{"id": "x"}])

    def bad():
        calls.append("bad")
        return sources.Fetched(items=[], error="HTTP 503")

    first = sources.cached(("t", "good"), good)
    assert first.cached is False and calls == ["good"]
    again = sources.cached(("t", "good"), good)
    assert again.cached is True and again.items == [{"id": "x"}] and calls == ["good"]
    sources.cached(("t", "bad"), bad)
    sources.cached(("t", "bad"), bad)
    assert calls == ["good", "bad"]
    now[0] += 61
    sources.cached(("t", "bad"), bad)
    sources.cached(("t", "good"), good)
    assert calls == ["good", "bad", "bad"], "실패만 60초 뒤 다시"
    now[0] += 900
    sources.cached(("t", "good"), good)
    assert calls == ["good", "bad", "bad", "good"]


def test_외부_호출을_끄면_캐시만_보고_부르지_않는다(monkeypatch):
    def boom():
        raise AssertionError("부르면 안 됩니다")

    offline = sources.cached(("t", "never"), boom, external=False)
    assert offline.offline is True and offline.items == []
    sources.cached(("t", "seen"), lambda: sources.Fetched(items=[{"id": "y"}]))
    cached = sources.cached(("t", "seen"), boom, external=False)
    assert cached.cached is True and cached.items == [{"id": "y"}]


def test_네이버_종목_뉴스는_상세의_함수를_쓴다(monkeypatch):
    asked = []
    payload = [{"total": 1, "items": [{"title": "합성 기사", "officeId": "001", "articleId": "0000000001",
                                         "officeName": "합성일보", "datetime": "202611131530"}]}]
    monkeypatch.setattr(detail, "_naver_json", lambda path: asked.append(path) or (payload, None))
    fetched = sources.naver("005930")
    assert asked == ["/news/stock/005930?pageSize=20&page=1"]
    item = fetched.items[0]
    assert item["url"] == "https://n.news.naver.com/mnews/article/001/0000000001" and item["publisher"] == "합성일보"
    assert item["publishedAt"] == "2026-11-13T06:30:00+00:00" and item["source"] == "naver" and item["lang"] == "ko"


def test_같은_출처를_부르는_중이면_한_번만_보낸다():
    import threading

    started = threading.Event()
    release = threading.Event()
    calls = []

    def slow():
        calls.append(1)
        started.set()
        release.wait(2)
        return sources.Fetched(items=[{"id": "z"}])

    results = []
    first = threading.Thread(target=lambda: results.append(sources.cached(("t", "inflight"), slow)))
    first.start()
    started.wait(2)
    second = threading.Thread(target=lambda: results.append(sources.cached(("t", "inflight"), slow)))
    second.start()
    release.set()
    first.join(3)
    second.join(3)
    assert len(calls) == 1, "부르는 중인 같은 출처는 다시 보내지 않고 그 결과를 기다림"
    assert sorted(result.cached for result in results) == [False, True]
    assert all(result.items == [{"id": "z"}] for result in results)
