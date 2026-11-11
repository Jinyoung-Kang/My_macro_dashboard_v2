"""
tests/test_info_waedge.py
정보 수집(ADR 0035) — waedge 세 화면의 파서와 저장.

표본은 화면 구조(태그·data-testid·클래스 일부)만 흉내 낸 합성 HTML입니다(실제 응답 원문 아님). 화면은 밝은·어두운 판을 함께 그려 같은
항목이 두 번 나오므로, 표본도 두 번 넣어 하나로 줄이는지 봅니다. 네트워크를 쓰지 않습니다.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.fetch import ladder
from app.services import info_blogs, info_text, info_waedge
from app.services.info_text import ShapeError

LONG = "코스피는 반도체 강세로 올랐습니다. " * 12


def _list_item(n: int, title: str) -> str:
    return (f'<li><a href="a/{n}.html" class="block group"><div class="min-w-0 flex-1">'
            f'<div class="text-base font-bold leading-snug line-clamp-2 sm:line-clamp-1">{title}</div>'
            f'<div class="mt-1 text-[13.5px] line-clamp-1">요약 {n}</div>'
            f'<div class="mt-1.5"><div class="flex items-center gap-1.5 min-w-0 text-xs whitespace-nowrap">'
            f'<span class="shrink-0 font-bold">시장 · 국내</span><span class="min-w-0 truncate">데스크 · AI 작성</span>'
            f'<span class="shrink-0 tabular-nums">· <time dateTime="2026-11-11T05:30:00.000Z">14:30</time></span>'
            f'</div></div></div></a></li>')


def _list_page() -> str:
    block = '<ul data-nt-list="section">' + _list_item(11, "첫 글") + _list_item(12, "둘째 글") + "</ul>"
    return f'<html><head><base href="../"></head><body>{block}{block}<a href="s/brief.html">시장</a></body></html>'


def _article(n: int) -> str:
    return (f'<html><body><main><article><div class="sticky">목록으로</div><header><div>시장</div>'
            f'<h1 data-testid="news-article-title">글 {n}</h1><div data-testid="news-article-lead"><p>리드 문장 {n}.</p></div>'
            f'<span>입력 <time dateTime="2026-11-11T05:30:59.000Z">2026.11.11 14:30 한국</time></span></header>'
            f'<div class="grid"><div class="min-w-0"><figure><pre>표 그림</pre></figure>'
            f'<p class="my-5">{LONG}</p><p class="my-5">둘째 문단 {n}.</p></div><aside>관련 글</aside></div>'
            f'</article></main></body></html>')


def _guru(name: str, stance: str, score: str, bull: int, neutral: int, bear: int) -> str:
    return (f'<details><summary title="거장 {name}"></summary><div class="guru-spectrum-detail"><div class="mt-2 p-3">'
            f'<div class="flex items-center gap-2 mb-1 flex-wrap"><img src="x.svg"/>'
            f'<span class="font-semibold text-sm">거장 {name}</span>'
            f'<span class="text-[11px] font-semibold px-2">{stance} {score}</span>'
            f'<span class="text-gray-400">강세 {bull} · 중립 {neutral} · 약세 {bear}</span>'
            f'<span class="text-gray-400">· 최근 기사 7건 기준</span><span class="text-gray-400">· 2026-11-09</span></div>'
            f'<p class="whitespace-pre-wrap">{name}의 견해 요약.</p></div></div></details>')


def _people_page() -> str:
    header = ('<div data-testid="guru-sentiment-spectrum"><span>거장 시장 심리 분포 <span>· 거장 3명</span></span>'
              '<span><span>강세 1</span><span>중립 1</span><span>약세 1</span><span>· 2026-11-09</span>'
              '<span>· 얼굴을 누르면 근거를 봅니다</span></span><p>강세·중립·약세 100점으로 나눈 뒤</p>')
    gurus = _guru("Alpha Kim", "중립", "+0", 30, 40, 30) + _guru("Beta Lee", "강세", "+80", 85, 10, 5) \
        + _guru("Gamma Park", "약세", "-60", 10, 20, 70)
    return f"<html><body>{header}{gurus}{gurus}</div><ul>{_list_item(21, '거장 글')}</ul></body></html>"


def _blogs_page() -> str:
    row = ('<li data-testid="waisod-news-blog-row"><span class="w-11 tabular-nums">16:01</span><span>WS</span>'
           '<span class="min-w-0 flex-1"><a href="https://wolfstreet.com/2026/11/10/rates-spike/" target="_blank">금리 급등</a>'
           '<span><b>Wolf Street</b> · <span lang="en">Rates Spike</span></span></span></li>'
           '<li data-testid="waisod-news-blog-row"><span class="tabular-nums">09:00</span>'
           '<span><a href="https://unknown.example.org/post">모르는 블로그 글</a><span><b>Unknown</b></span></span></li>')
    return f"<html><body><ul>{row}</ul><ul>{row}</ul></body></html>"


class FakeFetch:
    def __init__(self, routes: dict[str, str]):
        self.routes = routes
        self.calls: list[str] = []

    def __call__(self, url, **_):
        self.calls.append(url)
        answer = self.routes.get(url)
        if answer is None:
            raise ladder.FetchFailed("HTTP 404")
        if isinstance(answer, Exception):
            raise answer
        return ladder.Fetched(url=url, status=200, content_type="text/html; charset=utf-8", body=answer.encode("utf-8"),
                              tier="impersonate", final_url=url)


# ==============================================================================
# 시장 글 목록·상세
# ==============================================================================
def test_글_목록은_밝은_어두운_판을_하나로_줄이고_칸을_읽는다():
    entries = info_waedge.parse_list(_list_page())

    assert [e["url"] for e in entries] == ["https://news.waedge.ai/a/11.html", "https://news.waedge.ai/a/12.html"]
    first = entries[0]
    assert first["title"] == "첫 글" and first["summary"] == "요약 11"
    assert first["category"] == "시장 · 국내" and first["author"] == "데스크 · AI 작성"
    assert first["published_at"] == datetime(2026, 11, 11, 5, 30, tzinfo=timezone.utc)


def test_글_목록이_비면_형식_바뀜():
    with pytest.raises(ShapeError, match="글 목록"):
        info_waedge.parse_list("<html><body><a href='s/brief.html'>시장</a></body></html>")


def test_상세_페이지는_리드와_문단만_본문으로_삼는다():
    parsed = info_waedge.parse_article(_article(5))

    assert parsed["title"] == "글 5"
    assert parsed["body"].startswith("리드 문장 5.")
    assert "둘째 문단 5." in parsed["body"]
    assert "표 그림" not in parsed["body"] and "관련 글" not in parsed["body"] and "목록으로" not in parsed["body"]
    assert parsed["published_at"] == datetime(2026, 11, 11, 5, 30, 59, tzinfo=timezone.utc)


def test_새_글만_상세_페이지를_열고_실행당_상한을_지킨다(store, monkeypatch):
    monkeypatch.setattr(info_waedge, "BRIEF_BODIES_PER_RUN", 1)
    fetch = FakeFetch({info_waedge.BRIEF_URL: _list_page(),
                       "https://news.waedge.ai/a/11.html": _article(11), "https://news.waedge.ai/a/12.html": _article(12)})

    listed, bodies, blocked = info_waedge.collect_list(info_waedge.BRIEF_URL, source="waedge.brief", kind="brief",
                                                       bodies_per_run=1, fetch=fetch)
    assert (listed, bodies, blocked) == (2, 1, None)
    again = info_waedge.collect_list(info_waedge.BRIEF_URL, source="waedge.brief", kind="brief", bodies_per_run=1, fetch=fetch)

    assert again[1] == 1
    assert fetch.calls.count("https://news.waedge.ai/a/11.html") == 1, "본문을 받은 글은 다시 열지 않습니다"
    row = store.info_item(info_text.item_id("https://news.waedge.ai/a/12.html"))
    assert row["body_status"] == "full" and row["kind"] == "brief" and row["meta"]["category"] == "시장 · 국내"


def test_QA393_상세_페이지를_보내지_못하면_시도_횟수를_세지_않는다(store):
    # 블로그 글 페이지와 같은 원인 — 보내지 못한 요청(예산·시간)을 그 글의 시도로 세면 두 번 만에 더 열지 않게 됩니다.
    routes = {info_waedge.BRIEF_URL: _list_page(),
              "https://news.waedge.ai/a/11.html": ladder.FetchSkipped("news.waedge.ai 오늘 요청 예산을 다 씀")}
    fetch = FakeFetch(routes)

    for _ in range(3):
        info_waedge.collect_list(info_waedge.BRIEF_URL, source="waedge.brief", kind="brief", bodies_per_run=4, fetch=fetch)

    row = store.info_item(info_text.item_id("https://news.waedge.ai/a/11.html"))
    assert row["meta"].get("pageTries") is None and row["body_status"] == "partial"
    assert fetch.calls.count("https://news.waedge.ai/a/12.html") == 0, "보내지 못한 뒤에는 그 실행에서 더 열지 않습니다"

    routes["https://news.waedge.ai/a/11.html"] = _article(11)
    info_waedge.collect_list(info_waedge.BRIEF_URL, source="waedge.brief", kind="brief", bodies_per_run=4, fetch=fetch)
    assert store.info_item(info_text.item_id("https://news.waedge.ai/a/11.html"))["body_status"] == "full"


def test_QA393_상세_페이지_하나의_처리_예외는_그_글만_요약으로_둔다(store, monkeypatch):
    fetch = FakeFetch({info_waedge.BRIEF_URL: _list_page(),
                       "https://news.waedge.ai/a/11.html": _article(11), "https://news.waedge.ai/a/12.html": _article(12)})
    real = info_waedge.parse_article

    def breaks_on_first(markup):
        if "글 11" in markup:
            raise ValueError("본문 고르기 실패")
        return real(markup)

    monkeypatch.setattr(info_waedge, "parse_article", breaks_on_first)

    listed, bodies, blocked = info_waedge.collect_list(info_waedge.BRIEF_URL, source="waedge.brief", kind="brief",
                                                       bodies_per_run=4, fetch=fetch)

    assert (listed, bodies, blocked) == (2, 1, None)
    assert store.info_item(info_text.item_id("https://news.waedge.ai/a/11.html"))["body_status"] == "partial"
    assert store.info_item(info_text.item_id("https://news.waedge.ai/a/12.html"))["body_status"] == "full"


# ==============================================================================
# 거장
# ==============================================================================
def test_거장_견해는_이름으로_하나씩_점수_내림차순():
    parsed = info_waedge.parse_gurus(_people_page())

    assert [g["name"] for g in parsed["gurus"]] == ["Beta Lee", "Alpha Kim", "Gamma Park"]
    beta = parsed["gurus"][0]
    assert (beta["stance"], beta["score"], beta["bull"], beta["neutral"], beta["bear"]) == ("강세", 80, 85, 10, 5)
    assert beta["basisArticles"] == 7 and beta["asOf"] == "2026-11-09" and beta["summary"] == "Beta Lee의 견해 요약."
    assert parsed["counts"] == {"total": 3, "bull": 1, "neutral": 1, "bear": 1}
    assert parsed["asOf"] == "2026-11-09"


def test_거장_견해가_없으면_형식_바뀜():
    with pytest.raises(ShapeError, match="거장"):
        info_waedge.parse_gurus("<html><body><p>준비 중</p></body></html>")


@pytest.mark.parametrize("stances", [
    # 견해 표기만 바뀜(강세·중립·약세가 아닌 글) — 이름은 읽히지만 견해·점수는 읽을 수 없습니다.
    (("Neutral", "+0"), ("Bullish", "+80"), ("Bearish", "-60")),
    (("관망", "0점"), ("낙관", "80점"), ("비관", "60점")),
])
def test_QA392_거장의_견해_표기가_바뀌면_형식_바뀜(stances):
    gurus = "".join(_guru(name, stance, score, 30, 40, 30)
                    for name, (stance, score) in zip(("Alpha Kim", "Beta Lee", "Gamma Park"), stances))
    page = f"<html><body>{gurus}</body></html>"

    with pytest.raises(ShapeError, match="견해"):
        info_waedge.parse_gurus(page)


def test_QA392_견해_칸이_없는데_분포_글의_강세를_견해로_읽지_않는다():
    # 견해 칸이 빠지면 뒤따르는 '강세 30 · 중립 40 · 약세 30'(분포)의 첫 낱말이 견해로 읽혔습니다 — 모두 '강세', 점수는 강세 비중.
    page = "<html><body>" + _guru("Alpha Kim", "", "", 30, 40, 30) + _guru("Beta Lee", "강세", "+80", 85, 10, 5) \
        + _guru("Gamma Park", "약세", "-60", 10, 20, 70) + "</body></html>"

    parsed = info_waedge.parse_gurus(page)

    alpha = next(g for g in parsed["gurus"] if g["name"] == "Alpha Kim")
    assert (alpha["stance"], alpha["score"]) == (None, None), "읽지 못한 견해는 모르는 값입니다(분포에서 지어내지 않음)"
    assert (alpha["bull"], alpha["neutral"], alpha["bear"]) == (30, 40, 30)
    assert len(parsed["gurus"]) == 3, "절반 넘게 읽혔으면 그대로 받습니다"


# ==============================================================================
# 해외 블로그 한국어 제목
# ==============================================================================
def test_해외_블로그_행은_원문_주소로_하나씩():
    rows = info_waedge.parse_blog_rows(_blogs_page())

    assert len(rows) == 2
    assert rows[0] == {"url": "https://wolfstreet.com/2026/11/10/rates-spike/", "titleKo": "금리 급등", "titleEn": "Rates Spike",
                       "blog": "Wolf Street", "timeLabel": "16:01"}


def test_한국어_제목과_원문_본문이_어느_쪽이_먼저_와도_한_행으로_모인다(store):
    info_waedge.store_blog_titles(info_waedge.parse_blog_rows(_blogs_page()), fetch_tier="impersonate")
    item_id = info_text.item_id("https://wolfstreet.com/2026/11/10/rates-spike/")
    first = store.info_item(item_id)
    assert first["source"] == "blog.wolfstreet" and first["title_ko"] == "금리 급등" and first["body_status"] == "none"
    unknown = store.info_item(info_text.item_id("https://unknown.example.org/post"))
    assert unknown["source"] == "waedge.blogs"

    store.upsert_info_items([{"id": item_id, "source": "blog.wolfstreet", "kind": "article",
                              "url": "https://wolfstreet.com/2026/11/10/rates-spike/", "title": "Rates Spike",
                              "body": "본문 " * 300, "body_status": "full", "fetch_tier": "impersonate"}])
    info_waedge.store_blog_titles(info_waedge.parse_blog_rows(_blogs_page()), fetch_tier="impersonate")

    row = store.info_item(item_id)
    assert row["body_status"] == "full" and row["title_ko"] == "금리 급등", "다시 와도 본문을 지우지 않습니다"


QA394 = pytest.mark.xfail(strict=True, reason="QA-394: 원문 제목(title)이 충돌 갱신 목록에 없어 한국어 제목이 그대로 남습니다")
_NO_ENGLISH = {"url": "https://wolfstreet.com/2026/11/10/rates-spike/", "titleKo": "금리 급등", "titleEn": None,
               "blog": "Wolf Street", "timeLabel": "16:01"}
_FROM_FEED = {"id": info_text.item_id("https://wolfstreet.com/2026/11/10/rates-spike/"), "source": "blog.wolfstreet",
              "kind": "article", "url": "https://wolfstreet.com/2026/11/10/rates-spike/", "title": "Rates Spike",
              "body": "본문 " * 300, "body_status": "full", "fetch_tier": "impersonate"}


@QA394
def test_QA394_영어_제목_없이_먼저_온_행의_원문_제목은_피드가_오면_채워진다(store):
    info_waedge.store_blog_titles([_NO_ENGLISH], fetch_tier="impersonate")
    first = store.info_item(_FROM_FEED["id"])
    assert first["title"] == "금리 급등" and first["title_ko"] == "금리 급등", "영어 제목이 없으면 한국어 제목이 title 자리에 들어갑니다"

    store.upsert_info_items([_FROM_FEED])

    row = store.info_item(_FROM_FEED["id"])
    assert row["title"] == "Rates Spike" and row["title_ko"] == "금리 급등", "원문 피드가 오면 title은 원문 제목이 됩니다"


def test_QA394_원문_제목이_이미_있으면_바꾸지_않는다(store):
    store.upsert_info_items([_FROM_FEED])
    info_waedge.store_blog_titles([_NO_ENGLISH], fetch_tier="impersonate")
    store.upsert_info_items([dict(_FROM_FEED, title="Rates Spike (Updated)")])

    row = store.info_item(_FROM_FEED["id"])
    assert row["title"] == "Rates Spike" and row["title_ko"] == "금리 급등", "원문 제목이 있는 행은 그대로(한국어 제목만 채움)"


def test_QA394_한국어_글의_제목은_다시_와도_바뀌지_않는다(store):
    # waedge 시장 글처럼 원래 한국어인 글(title_ko 없음)은 '한국어 제목이 title 자리에 든 행'이 아닙니다.
    brief = {"id": "brief-1", "source": "waedge.brief", "kind": "brief", "url": "https://news.waedge.ai/a/1.html", "title": "첫 제목"}
    store.upsert_info_items([brief])
    store.upsert_info_items([dict(brief, title="고친 제목")])

    assert store.info_item("brief-1")["title"] == "첫 제목"


def test_블로그_호스트_표는_waedge_원문_주소를_출처에_묶는다():
    assert info_blogs.blog_for_url("https://www.theirrelevantinvestor.com/p/x").key == "blog.irrelevantinvestor"
    assert info_blogs.blog_for_url("https://marginalrevolution.com/marginalrevolution/2026/11/x.html").key == "blog.marginalrevolution"
    assert info_blogs.blog_for_url("https://example.org/x") is None
