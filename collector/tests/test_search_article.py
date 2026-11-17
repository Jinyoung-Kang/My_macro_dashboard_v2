"""
tests/test_search_article.py
정보 검색 본문 보기(ADR 0043, 계약 §10 — services/search_article). 실제 요청·DB 0건 — 한 건 받기(fetch_page)·경유 풀기(resolve)·예산·제외 매체를
바꿔 끼우고, 추출 표본은 직접 지은 합성 HTML(tests/fixtures/article — 실제 기사 글을 옮기지 않음)입니다.

고정하는 규칙
  1. 꼬리표: 기사·글 줄(news·headline)에만, 받아 둔 글(readerId)·공시·리서치·거장 견해·속보에는 없음. 받지 않는 매체는 꼬리표 대신 까닭(bodyNote).
     구글 경유 주소는 늘 꼬리표. 출처 캐시의 줄을 고치지 않음(새 사전).
  2. 결과로 내준 주소만 받음 — 모르는 꼬리표는 unknown_ref(외부 0건).
  3. 서버가 아니면(POLITE_FETCH_ENABLED 꺼짐) 기억표·DB·네트워크 0건(server_only). 프록시 환경도 server_only.
  4. 처음 부름은 줄에 넣고(pending·queued), 받는 동안 pending, 받은 뒤 캐시(처음 읽기 cached=false, 그다음 true). 같은 글은 줄에 하나, 줄 상한 5,
     하루 전체 예산 80(fetch_budgets '*'/article, 읽지 못하면 보내지 않음), start가 거짓이면 외부를 부르지 않음(not_cached).
  5. 추출: 문단으로 나누고 40,000자(빈 줄로 이은 길이)에서 문단 경계로 자름(truncated·totalChars), 400자 미만 short, 80자 미만 no_body, 유료 표시
     (JSON-LD isAccessibleForFree false), 언어(한글 30% → ko, 가나 → ja, 라틴 절반 → en, 그 밖 html lang), 모르는 메타데이터는 null.
  6. 캐시 시간: 성공 24시간, 사유별(형식 30분·거부 6시간·규칙 1시간·일시 60초 + retryAfterSeconds). 풀린 구글 주소에도 받지 않는 매체·중화권 제외.
  7. 모의 매매 모듈은 search_article을 가져오지 않음(본문이 패킷에 들어갈 길이 없음).
"""
from __future__ import annotations

import ast
import re
import threading
import time
from pathlib import Path

import pytest

from app.fetch import article as fetch_article
from app.services import search_article as sa
from app.services import search_relay, search_store
from app.services import search_rules as rules
from app.tasks import polite

FIXTURES = Path(__file__).parent / "fixtures" / "article"
APP = Path(__file__).resolve().parents[1] / "app"


# 실제 구글 경유 풀기 — 모듈을 읽을 때 잡아 둡니다(env가 이 자리를 '부르면 실패'로 바꿔 끼움). 네트워크 자리(_get·_post)는 conftest가 막아 둠.
REAL_RESOLVE = search_relay.resolve


def _row(url, *, kind="news", source="bing", reader=None, title="Synthetic headline", publisher="Example Ledger") -> dict:
    return {"id": f"id-{abs(hash(url)) % 10_000}", "kind": kind, "title": title, "url": url, "publisher": publisher,
            "publisherDomain": rules.domain_of(url) if url else None, "publishedAt": "2026-11-16T00:00:00Z", "timeBasis": "published",
            "source": source, "lang": "en", "summary": None, "readerId": reader}


@pytest.fixture()
def env(monkeypatch):
    """서버(스위치 켬)·프록시 없음·제외 매체 없음·하루 예산 넉넉함·받기는 합성 쪽."""
    for name in fetch_article.PROXY_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(search_store, "user_excludes", lambda: rules.Excludes())
    budget: list[int] = []
    monkeypatch.setattr(sa, "_take_total_budget", lambda: budget.append(1) or True)
    fetched: list[str] = []
    gate = threading.Event()
    gate.set()
    body = {"value": (FIXTURES / "en_utf8.html").read_bytes(), "type": "text/html; charset=utf-8"}

    def fetch_page(url, *, deadline, refused=None):
        fetched.append(url)
        gate.wait(5)
        host = url.split("/")[2]
        why = refused(host) if refused else None
        if why:
            raise fetch_article.ArticleFetchError("refused_host", f"{host}의 글은 받지 않습니다 — {why}", host=host)
        return fetch_article.Page(final_url=url, host=host, status=200, content_type=body["type"], body=body["value"], hops=0)

    monkeypatch.setattr(sa.fetch_article, "fetch_page", fetch_page)
    monkeypatch.setattr(search_relay, "resolve", lambda url: pytest.fail("구글 경유가 아닌데 풀려 함"))
    return type("Env", (), {"budget": budget, "fetched": fetched, "gate": gate, "body": body})


def _register(url: str, **kwargs) -> str:
    rows = sa.annotate([_row(url, **kwargs)])
    assert rows[0]["bodyRef"], rows[0]
    return rows[0]["bodyRef"]


def _done(ref: str) -> dict:
    assert sa.wait_idle(5)
    return sa.request(ref, start=False)


# ==============================================================================
# 1. 꼬리표
# ==============================================================================
def test_꼬리표는_기사·글_줄에만_붙고_받아_둔_글·공시·리서치·거장_견해에는_없다():
    rows = sa.annotate([
        _row("https://news.example.com/a", kind="news"),
        _row("https://press.example.org/b", kind="headline", source="feeds"),
        _row("https://blog.example.net/post", kind="post", source="info", reader="r1"),
        _row("https://news.example.com/stored", kind="news", source="watch", reader="r2"),
        _row("https://www.sec.gov/Archives/x", kind="filing", source="sec"),
        _row("https://research.example.com/r", kind="research", source="yahoo_research"),
        _row("https://guru.example.com/list", kind="opinion", source="guru"),
        _row("https://wire.example.com/w", kind="wire", source="wire", reader="w1"),
        _row(None, kind="news"),
        _row("mailto:someone@example.com", kind="news"),
    ])
    assert [bool(row["bodyRef"]) for row in rows] == [True, True, False, False, False, False, False, False, False, False]
    assert all(row["bodyNote"] is None for row in rows)
    assert all(len(row["bodyRef"]) == 32 and set(row["bodyRef"]) <= set("0123456789abcdef") for row in rows[:2])
    assert rows[0]["bodyRef"] == sa.ref_of("https://news.example.com/a"), "같은 주소는 같은 꼬리표(캐시가 이어짐)"


@pytest.mark.parametrize("url,word", [
    ("https://n.news.naver.com/mnews/article/001/0000000001", "네이버"),
    ("https://finance.yahoo.com/news/synthetic-1.html", "Yahoo"),
    ("https://www.investing.com/news/stock-market-news/x", "인베스팅닷컴"),
    ("https://finviz.com/news/123/synthetic", "Finviz"),
    ("https://www.bing.com/news/apiclick.aspx?x=1", "검색 엔진"),
    ("https://www.google.com/url?q=x", "검색 엔진"),
    ("https://toss.im/x", "계좌·공시"),
    ("https://www.sec.gov/news/x", "계좌·공시"),
    ("https://data.krx.co.kr/x", "계좌·공시"),
    ("https://www.wsj.com/articles/x", "유료 구독"),
    ("https://www.bloomberg.com/news/articles/x", "유료 구독"),
    ("https://www.ft.com/content/x", "유료 구독"),
    ("https://wolfstreet.com/2026/11/16/x/", "정기 수집"),
    ("https://www.financialjuice.com/x", "정기 수집"),
    ("https://economic-calendar.tradingview.com/x", "정기 수집"),
    ("https://www.globaltimes.cn/x", "제외 매체"),
    ("https://www.tradingview.com/news/x", "정기 수집"),
    ("https://v.daum.net/v/x", "정기 수집"),
    ("https://www.yna.co.kr/view/AKR0000", "정기 수집"),
    ("https://www.federalreserve.gov/newsevents/pressreleases/x.htm", "정기 수집"),
    ("https://www.bls.gov/news.release/x.htm", "정기 수집"),
    ("https://www.bok.or.kr/portal/x", "정기 수집"),
    ("https://synthetic.substack.com/p/x", "정기 수집"),
    ("https://www.nasdaq.com/articles/x", "정기 수집"),
])
def test_받지_않는_매체는_꼬리표_대신_까닭(url, word):
    row = sa.annotate([_row(url)])[0]
    assert row["bodyRef"] is None and word in row["bodyNote"]
    assert "ADR" not in row["bodyNote"] and "—" not in row["bodyNote"], "화면 글은 짧은 한 문장(내부 번호·줄표 없음)"


def _collector_hosts() -> dict[str, set[str]]:
    """collector/app 안의 바깥 주소(http(s) 글자)와 이름이 HOST로 끝나는 호스트 상수 → 그것이 든 파일."""
    found: dict[str, set[str]] = {}
    for path in sorted(APP.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(APP).as_posix()
        for match in re.finditer(r"https?://([A-Za-z0-9.-]+\.[A-Za-z]{2,})", text):
            found.setdefault(match.group(1).lower(), set()).add(rel)
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                value = node.value.value
                if "." in value and " " not in value and any(isinstance(t, ast.Name) and t.id.upper().endswith("HOST") for t in node.targets):
                    found.setdefault(value.lower(), set()).add(rel)
    return found


def test_수집기가_부르는_호스트는_모두_받지_않는다():
    """
    같은 서버 IP로 정기 수집하거나 부르는 호스트(수집기 코드의 주소·HOST 상수)는 그 등록 도메인째 받지 않습니다 — 기사 쪽을 받다가 서버 IP가 의심받아
    정기 수집이 막히지 않게. 예외는 정보 검색 자체 피드만 부르는 매체(SEARCH_FEED_ONLY_DOMAINS)뿐. 새 출처를 더하면 이 시험이 그 도메인을 정하라고 알립니다.
    """
    hosts = _collector_hosts()
    assert len(hosts) > 40, "주소를 찾는 방식이 깨지지 않았는지"
    missing = {host: sorted(files) for host, files in hosts.items()
               if sa.refusal(host) is None and sa.registered_domain(host) not in sa.SEARCH_FEED_ONLY_DOMAINS}
    assert missing == {}
    for domain in sa.SEARCH_FEED_ONLY_DOMAINS:
        assert sa.refusal("www." + domain) is None, "정보 검색 자체 피드만 부르는 매체는 받음"
        assert any(sa.registered_domain(host) == domain for host in hosts), f"{domain}을 부르는 주소가 없으면 예외 목록에서 뺄 것"


def test_증권사_도메인은_글자_없이_막는다():
    """실제 계좌 조회·실제 매매가 쓰는 API와 같은 등록 도메인의 웹 호스트 — 글자는 토스 클라이언트 한 곳만 알아 해시로 맞춥니다."""
    from app.services import toss

    domain = sa.registered_domain(toss._HOST)
    for host in (toss._HOST, domain, "www." + domain, "static." + domain):
        assert sa.refusal(host) == sa.ACCOUNT_NOTE
    assert sa.refusal(domain + ".example.net") is None, "점 경계 — 다른 도메인의 하위 이름은 아님"
    assert sa.refusal("www.koreainvestment.com") == sa.ACCOUNT_NOTE


@pytest.mark.parametrize("host,domain", [
    ("www.yna.co.kr", "yna.co.kr"), ("feeds.bbci.co.uk", "bbci.co.uk"), ("ecb.europa.eu", "europa.eu"), ("apis.data.go.kr", "data.go.kr"),
    ("klementoninvesting.substack.com", "substack.com"), ("www.example.com.", "example.com"), ("localhost", None), ("", None),
])
def test_등록_도메인_어림(host, domain):
    assert sa.registered_domain(host) == domain


def test_구글_경유_주소는_늘_꼬리표():
    url = "https://news.google.com/rss/articles/CBMiFEFVX3lxTHN5bnRoZXRpYzAwMDAw0gEA?oc=5"
    row = sa.annotate([_row(url, source="google_en")])[0]
    assert row["bodyRef"] == sa.ref_of(url) and row["bodyNote"] is None


def test_꼬리표는_출처_캐시의_줄을_고치지_않는다():
    original = _row("https://news.example.com/a")
    snapshot = dict(original)
    rows = sa.annotate([original])
    assert original == snapshot and "bodyRef" not in original and rows[0] is not original


# ==============================================================================
# 2~4. 받기 흐름
# ==============================================================================
def test_결과로_내준_주소만_받는다(env):
    answer = sa.request("0" * 32, start=True)
    assert (answer["status"], answer["reason"]) == ("error", "unknown_ref") and env.fetched == [] and env.budget == []
    with pytest.raises(ValueError):
        sa.request("../../etc/passwd", start=True)
    with pytest.raises(ValueError):
        sa.check_ref("ABCDEF" + "0" * 26)


def test_서버가_아니면_기억표·DB·네트워크_0건(monkeypatch):
    monkeypatch.setenv(polite.ENV_ENABLED, "false")
    monkeypatch.setattr(sa, "_lookup", lambda ref: pytest.fail("기억표를 읽으면 안 됨"))
    monkeypatch.setattr(sa, "_take_total_budget", lambda: pytest.fail("DB를 부르면 안 됨"))
    monkeypatch.setattr(sa.fetch_article, "fetch_page", lambda *a, **k: pytest.fail("받으면 안 됨"))
    for start in (True, False):
        answer = sa.request("a" * 32, start=start)
        assert (answer["status"], answer["reason"], answer["queued"]) == ("error", "server_only", False)
        assert "운영 서버에서만" in answer["message"]


def test_프록시_환경이면_보내지_않는다(env, monkeypatch):
    ref = _register("https://news.example.com/a")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    answer = sa.request(ref, start=True)
    assert (answer["reason"], env.fetched, env.budget) == ("server_only", [], [])
    assert "프록시" in answer["message"]


def test_처음_부름은_줄에_넣고_받는_중_받은_뒤_캐시(env):
    ref = _register("https://news.example.com/a?x=1")
    env.gate.clear()
    first = sa.request(ref, start=True)
    assert (first["status"], first["queued"], first["article"]) == ("pending", True, None)
    again = sa.request(ref, start=True)
    assert (again["status"], again["queued"]) == ("pending", False), "받는 동안은 다시 넣지 않음(예산·사용자 셈 없음)"
    assert env.budget == [1]
    env.gate.set()
    done = _done(ref)
    assert done["status"] == "ok" and done["reason"] is None and done["queued"] is False
    body = done["article"]
    assert body["cached"] is False and body["sourceUrl"] == "https://news.example.com/a?x=1" and body["sourceHost"] == "news.example.com"
    assert body["title"] == "Synthetic Widgets revenue rises" and body["siteName"] == "Example Ledger"
    assert body["author"] == "Jane Placeholder" and body["publishedDate"] == "2026-11-15" and body["lang"] == "en"
    assert len(body["paragraphs"]) == 4 and body["viaGoogle"] is False and body["paywalled"] is False
    assert body["fetchedAt"].endswith("+00:00"), "UTC ISO(다른 정보 검색 시각과 같은 모양)"
    later = sa.request(ref, start=True)
    assert later["article"]["cached"] is True and later["article"]["fetchedAt"] == body["fetchedAt"]
    assert env.fetched == ["https://news.example.com/a?x=1"] and env.budget == [1], "캐시에서는 다시 받지 않음"


def test_같은_글은_줄에_하나(env):
    ref = _register("https://news.example.com/a")
    env.gate.clear()
    answers = [sa.request(ref, start=True) for _ in range(4)]
    assert [answer["queued"] for answer in answers] == [True, False, False, False]
    env.gate.set()
    assert _done(ref)["status"] == "ok" and len(env.fetched) == 1


def test_줄_상한은_5(env):
    env.gate.clear()
    refs = [_register(f"https://news.example.com/{index}") for index in range(6)]
    answers = [sa.request(ref, start=True) for ref in refs]
    assert [answer["status"] for answer in answers[:5]] == ["pending"] * 5
    assert (answers[5]["status"], answers[5]["reason"], answers[5]["retryable"]) == ("error", "queue_full", True)
    assert len(env.budget) == 5, "줄이 가득 차면 예산을 쓰지 않음"
    env.gate.set()
    assert sa.wait_idle(10)


def test_하루_전체_예산(env, monkeypatch):
    ref = _register("https://news.example.com/a")
    monkeypatch.setattr(sa, "_take_total_budget", lambda: False)
    answer = sa.request(ref, start=True)
    assert (answer["reason"], env.fetched) == ("budget", []) and str(sa.DAILY_BUDGET) in answer["message"]

    def broken():
        raise RuntimeError("db down")

    monkeypatch.setattr(sa, "_take_total_budget", broken)
    answer = sa.request(ref, start=True)
    assert answer["reason"] == "budget" and "확인하지 못해" in answer["message"] and env.fetched == []
    seen = []
    monkeypatch.setattr(sa.store, "take_search_budget", lambda host, purpose, day, limit: seen.append((host, purpose, limit)) or True)
    monkeypatch.setattr(sa, "_take_total_budget", sa.__dict__["_take_total_budget"])
    assert seen == [] and sa.DAILY_BUDGET == 80


def test_하루_전체_예산은_표의_별_줄(monkeypatch):
    seen = []
    monkeypatch.setattr(sa.store, "take_search_budget", lambda host, purpose, day, limit: seen.append((host, purpose, limit)) or True)
    assert sa._take_total_budget() is True and seen == [("*", "article", 80)]


def test_start가_거짓이면_외부를_부르지_않는다(env):
    ref = _register("https://news.example.com/a")
    answer = sa.request(ref, start=False)
    assert (answer["status"], answer["reason"], env.fetched, env.budget) == ("error", "not_cached", [], [])


def test_받지_않는_매체와_닫힌_호스트는_줄에_넣지_않는다(env, monkeypatch):
    ref = _register("https://news.example.com/a")
    fetch_article._block("news.example.com", "HTTP 403", None)
    answer = sa.request(ref, start=True)
    assert answer["reason"] == "blocked" and env.budget == [] and "약 6시간" in answer["message"]


def test_사유_글과_응답에_꼬리표·경로가_없다(env, caplog):
    import logging

    caplog.set_level(logging.INFO)
    ref = _register("https://news.example.com/private/SECRETPATH?q=SECRETQUERY")
    sa.request(ref, start=True)
    _done(ref)
    assert "SECRETPATH" not in caplog.text and "SECRETQUERY" not in caplog.text and ref not in caplog.text


# ==============================================================================
# 5. 추출
# ==============================================================================
def test_추출은_문단으로_나누고_40000자에서_자른다():
    paragraphs = "".join(f"<p>{'Synthetic sentence number %d keeps going for the test. ' % index * 20}</p>" for index in range(80))
    html = f"<html lang='en'><head><title>Long one</title></head><body><article><h1>Long one</h1>{paragraphs}</article></body></html>"
    found = sa.extract(html.encode(), content_type="text/html")
    joined = "\n\n".join(found.paragraphs)
    assert found.truncated is True and found.chars == len(joined) <= sa.MAX_CHARS
    assert found.total_chars > sa.MAX_CHARS and found.short is False
    assert all(paragraph.startswith("Synthetic sentence") for paragraph in found.paragraphs), "문단 경계에서 자름"

    huge = "<html><body><article><p>" + "word " * 12_000 + "</p></article></body></html>"
    found = sa.extract(huge.encode(), content_type="text/html")
    assert len(found.paragraphs) == 1 and found.chars <= sa.MAX_CHARS and found.truncated is True, "문단 하나가 넘으면 그 안에서"


def test_한국어_EUC_KR_기사는_문단과_메타데이터():
    found = sa.extract((FIXTURES / "ko_euckr.html").read_bytes(), content_type="text/html")
    assert found.lang == "ko" and found.title == "합성전자, 분기 매출 늘어" and found.site_name == "가상일보"
    assert found.author == "홍길동 기자" and found.published_date == "2026-11-16" and found.short is False
    assert found.paragraphs[0].startswith("합성전자는 지난 분기") and any("| 매출 |" in p for p in found.paragraphs), "표는 넣음"
    assert not any("많이 본 기사" in p or "정치" == p for p in found.paragraphs), "메뉴·추천 글은 뺌"


def test_짧은_글은_short_80자_미만은_no_body():
    found = sa.extract((FIXTURES / "short.html").read_bytes(), content_type="text/html")
    assert found.short is True and found.chars >= sa.MIN_CHARS
    with pytest.raises(sa.NoBody):
        sa.extract((FIXTURES / "menu_only.html").read_bytes(), content_type="text/html")
    with pytest.raises(sa.NoBody):
        sa.extract(b"<html><body><article><p>Too short.</p></article></body></html>")
    with pytest.raises(sa.NoBody):
        sa.extract(b"\x00\x01\x02 not html at all")


def test_태그가_너무_많은_쪽은_추출하지_않는다(monkeypatch):
    """추출은 시간 상한 밖에서 이 과정의 메모리를 씁니다 — 여는 태그 어림수가 MAX_TAGS를 넘으면 trafilatura를 부르지 않고 too_large."""
    import trafilatura

    called = []
    monkeypatch.setattr(trafilatura, "bare_extraction", lambda *args, **kwargs: called.append(1))
    unit = "<div><span><a href='#'>x</a></span></div>"
    crowded = ("<html><body><article><p>" + "Body sentence words here. " * 20 + "</p>" + unit * (sa.MAX_TAGS // 3 + 10)
               + "</article></body></html>").encode()
    assert sa.start_tags(crowded.decode()) > sa.MAX_TAGS
    with pytest.raises(sa.NoBody) as caught:
        sa.extract(crowded, content_type="text/html")
    assert caught.value.reason == "too_large" and called == [] and "50,000" in str(caught.value)
    assert sa.MAX_TAGS == 50_000
    assert sa.start_tags("<p>a</p><br/><!-- c --><div>") == 4, "닫는 태그는 빼고 주석은 셈(넉넉히 많게)"


def test_태그_관문을_넘은_실패는_too_large로_캐시(env):
    unit = "<tr><td>1</td></tr>"
    env.body["value"] = ("<html><body><table>" + unit * (sa.MAX_TAGS // 2 + 10) + "</table></body></html>").encode()
    ref = _register("https://news.example.com/a")
    sa.request(ref, start=True)
    answer = _done(ref)
    assert (answer["status"], answer["reason"], answer["retryable"]) == ("error", "too_large", False)


def test_유료_표시():
    assert sa.extract((FIXTURES / "paywall.html").read_bytes(), content_type="text/html").paywalled is True
    assert sa.extract((FIXTURES / "en_utf8.html").read_bytes(), content_type="text/html").paywalled is False


@pytest.mark.parametrize("text,html_lang,lang", [
    ("합성 기사는 한국어로 쓴 글이며 영어 단어 Apple이 섞여 있다.", None, "ko"),
    ("これは試験のための日本語の文章です。漢字も含みます。", None, "ja"),
    ("This is a synthetic English paragraph for the test suite.", "de", "en"),
    ("Это синтетический абзац на русском языке.", "ru", "ru"),
    ("12345 67890", None, None),
])
def test_언어_판정(text, html_lang, lang):
    assert sa.language_of(text, html_lang) == lang


def test_메타데이터가_없으면_null():
    html = ("<html><head></head><body><article>"
            + "".join(f"<p>Synthetic paragraph {index} without metadata keeps a distinct line of invented text for tests only.</p>"
                      for index in range(8))
            + "</article></body></html>")
    found = sa.extract(html.encode(), content_type="text/html", fallback_title=None, fallback_site=None)
    assert found.author is None and found.published_date is None and found.site_name is None


def test_문자셋은_응답_머리글을_먼저():
    text = "합성 글"
    assert sa.decode(text.encode("cp949"), "text/html; charset=EUC-KR") == text
    assert sa.decode(text.encode("utf-8"), "text/html") == text
    assert sa.decode(b'<meta charset="euc-kr">' + text.encode("euc-kr"), None).endswith(text)


# ==============================================================================
# 6. 캐시 시간·경유 풀기
# ==============================================================================
@pytest.mark.parametrize("reason,retryable,ttl", [
    ("no_body", False, sa.SHAPE_TTL), ("not_html", False, sa.SHAPE_TTL), ("too_large", False, sa.SHAPE_TTL), ("http_error", False, sa.SHAPE_TTL),
    ("blocked", False, sa.BLOCKED_TTL), ("refused_host", False, sa.RULE_TTL), ("unsafe_address", False, sa.RULE_TTL),
    ("bad_redirect", False, sa.RULE_TTL), ("relay_unresolved", False, sa.RULE_TTL),
    ("timeout", True, sa.TRANSIENT_TTL), ("transport", True, sa.TRANSIENT_TTL), ("http_error", True, sa.TRANSIENT_TTL),
    ("relay_unresolved", True, sa.TRANSIENT_TTL),
    ("budget", False, 0.0), ("queue_full", True, 0.0), ("server_only", False, 0.0), ("unknown_ref", False, 0.0), ("not_cached", False, 0.0),
])
def test_성공은_24시간_실패는_사유별_시간(reason, retryable, ttl):
    assert sa._ttl(reason, retryable) == ttl
    assert sa.SUCCESS_TTL == 86_400.0


def test_일시_실패는_다시_시도까지_남은_초(env, monkeypatch):
    ref = _register("https://news.example.com/a")

    def slow(url, *, deadline, refused=None):
        raise fetch_article.ArticleFetchError("timeout", "news.example.com의 응답이 늦어 끊었습니다", retryable=True, host="news.example.com")

    monkeypatch.setattr(sa.fetch_article, "fetch_page", slow)
    sa.request(ref, start=True)
    answer = _done(ref)
    assert (answer["reason"], answer["retryable"]) == ("timeout", True) and 1 <= answer["retryAfterSeconds"] <= 60
    again = sa.request(ref, start=True)
    assert again["reason"] == "timeout", "60초 안에는 다시 받지 않음"


def test_작업이_낸_호스트_예산_소진도_다시_묻는_화면에_전한다(env, monkeypatch):
    ref = _register("https://news.example.com/a")
    calls = []

    def spent(url, *, deadline, refused=None):
        calls.append(url)
        raise fetch_article.ArticleFetchError("budget", "오늘 news.example.com에서 20건을 받았습니다", host="news.example.com")

    monkeypatch.setattr(sa.fetch_article, "fetch_page", spent)
    sa.request(ref, start=True)
    answer = _done(ref)
    assert answer["reason"] == "budget" and answer["retryAfterSeconds"] is None
    assert sa.request(ref, start=True)["reason"] == "budget" and len(calls) == 1 and len(env.budget) == 1, "다시 줄에 넣어 예산을 또 쓰지 않음"


def test_풀린_구글_주소에도_받지_않는_매체와_중화권_제외를_적용(env, monkeypatch):
    relay_url = "https://news.google.com/rss/articles/CBMiFEFVX3lxTHN5bnRoZXRpYzAwMDAw0gEA?oc=5"
    ref = _register(relay_url, source="google_en")
    for target, reason, word in (("https://finance.yahoo.com/news/x.html", "refused_host", "Yahoo"),
                                 ("https://www.globaltimes.cn/page/x.shtml", "refused_host", "제외 매체")):
        sa.reset()
        ref = _register(relay_url, source="google_en")
        monkeypatch.setattr(search_relay, "resolve", lambda url, target=target: search_relay.Resolved(target, 1))
        sa.request(ref, start=True)
        answer = _done(ref)
        assert (answer["reason"], word in answer["message"]) == (reason, True)

    sa.reset()
    ref = _register(relay_url, source="google_en")
    monkeypatch.setattr(search_relay, "resolve", lambda url: search_relay.Resolved("https://news.example.com/real", 2))
    sa.request(ref, start=True)
    answer = _done(ref)
    assert answer["status"] == "ok" and answer["article"]["viaGoogle"] is True and answer["article"]["sourceHost"] == "news.example.com"

    sa.reset()
    ref = _register(relay_url, source="google_en")

    def unresolved(url):
        raise search_relay.RelayUnresolved(search_relay.UNRESOLVED, requests=1)

    monkeypatch.setattr(search_relay, "resolve", unresolved)
    sa.request(ref, start=True)
    answer = _done(ref)
    assert (answer["reason"], answer["retryable"]) == ("relay_unresolved", False)


@pytest.mark.parametrize("budget_answer", [False, RuntimeError("db down")])
def test_구글_풀기_예산_실패는_사유_budget이고_오래_캐시하지_않는다(env, monkeypatch, budget_answer):
    """구글 경유 풀기의 하루 예산을 다 썼거나 읽지 못하면 사유 budget(계약 §10-3) — 1시간(RULE_TTL)이 아니라 전하는 몫(DELIVERY_TTL)만."""
    relay_url = "https://news.google.com/rss/articles/CBMiFEFVX3lxTHN5bnRoZXRpYzAwMDAw0gEA?oc=5"
    ref = _register(relay_url, source="google_en")
    monkeypatch.setattr(search_relay, "resolve", REAL_RESOLVE)

    def take():
        if isinstance(budget_answer, Exception):
            raise budget_answer
        return budget_answer

    monkeypatch.setattr(search_relay, "_take_budget", take)
    monkeypatch.setattr(search_relay, "decode_offline", lambda article_id: None)
    clock = {"now": 5000.0}
    monkeypatch.setattr(sa, "_clock", lambda: clock["now"])
    entry = sa._work(sa._lookup(ref), deadline=clock["now"] + sa.JOB_DEADLINE)
    assert (entry.reason, entry.retryable) == ("budget", False)
    assert entry.expires - clock["now"] == sa.DELIVERY_TTL
    assert env.fetched == [], "풀지 못했으면 기사 쪽은 받지 않음"


def test_사용자가_더한_제외_매체도_풀린_주소에_적용(env, monkeypatch):
    relay_url = "https://news.google.com/rss/articles/CBMiFEFVX3lxTHN5bnRoZXRpYzAwMDAw0gEA?oc=5"
    monkeypatch.setattr(search_store, "user_excludes", lambda: rules.make_excludes([{"kind": "domain", "value": "blocked.example"}]))
    ref = _register(relay_url, source="google_en")
    monkeypatch.setattr(search_relay, "resolve", lambda url: search_relay.Resolved("https://www.blocked.example/a", 1))
    sa.request(ref, start=True)
    assert _done(ref)["reason"] == "refused_host"


def test_기억표는_24시간과_1만_건(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(sa, "_clock", lambda: clock["now"])
    ref = _register("https://news.example.com/a")
    assert sa._lookup(ref) is not None
    clock["now"] += sa.REF_TTL + 1
    assert sa._lookup(ref) is None
    assert sa.REF_LIMIT == 10_000 and sa.RESULT_LIMIT == 150 and sa.QUEUE_LIMIT == 5 and sa.JOB_DEADLINE == 60.0


def test_작업은_시간_상한을_건다(env, monkeypatch):
    seen = {}

    def fetch_page(url, *, deadline, refused=None):
        seen["left"] = deadline - time.monotonic()
        seen["guard"] = sa.http.time_left()
        raise fetch_article.ArticleFetchError("http_error", "news.example.com HTTP 404 — 글을 찾지 못했습니다", host="news.example.com")

    monkeypatch.setattr(sa.fetch_article, "fetch_page", fetch_page)
    ref = _register("https://news.example.com/a")
    sa.request(ref, start=True)
    assert _done(ref)["reason"] == "http_error"
    assert 50 < seen["left"] <= 60 and seen["guard"] is not None and 50 < seen["guard"] <= 60


# ==============================================================================
# 7. 모의 매매와의 경계
# ==============================================================================
def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
    return names


def test_모의_매매_모듈은_search_article을_가져오지_않는다():
    paper = [path for path in APP.rglob("*.py") if "paper" in path.name or path.parent.name == "paper"]
    assert paper, "모의 매매 모듈을 찾지 못함"
    for path in paper:
        imported = _imports(path)
        assert not any("search_article" in name or "search_relay" in name for name in imported), path
        assert "article" not in imported or "fetch" not in " ".join(imported), path
