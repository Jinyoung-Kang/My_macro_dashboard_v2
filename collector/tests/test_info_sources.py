"""
tests/test_info_sources.py
정보 수집(ADR 0035) — 블로그 피드와 공통 규칙.

고정하는 규칙
  1. 피드에 본문이 있으면 그 본문을 쓰고 글 페이지를 열지 않습니다(출처 부하가 가장 적음).
  2. 본문이 없거나 짧은 글만 글 페이지를 열고, 최근 7일 글만, 실행 한 번에 최대 6건(ADR 0037에서 4 → 6), 한 글에 두 번까지입니다.
  3. 이미 본문까지 받은 글은 다시 받지 않고, 30일보다 오래된 글은 넣지 않습니다.
  4. 피드에서 글을 하나도 읽지 못하면 '형식 바뀜'이고, 304면 '바뀐 것 없음'으로 끝납니다.
  5. 글 페이지가 거부되면 그때까지 받은 글은 넣고 거부를 올립니다.
  6. 모든 출처 호스트가 차단 통과 계층의 정책 표에 있고(하루 예산), 브라우저 계층 허용 목록과 같습니다.

표본은 구조만 흉내 낸 합성 피드·페이지입니다(실제 응답 원문 아님). 네트워크를 쓰지 않습니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

from app import http
from app.fetch import ladder, policy, state
from app.services import info_blogs, info_text
from app.services.info_text import ShapeError
from app.tasks import registry

NOW = datetime(2026, 11, 11, 3, 0, tzinfo=timezone.utc)
BLOG = info_blogs.Blog("blog.example", "info_blog_example", "Example Blog", "https://blog.example.com/",
                       "https://blog.example.com/feed/")
LONG = " ".join(["The quick analysis of rates and spreads continues here."] * 20)


def _item(n: int, *, days_ago: float = 0.0, content: str | None = LONG, summary: str = "Short teaser.") -> str:
    when = format_datetime(NOW - timedelta(days=days_ago))
    body = f"<content:encoded><![CDATA[<p>{content}</p><p>The post X appeared first on Example.</p>]]></content:encoded>" \
        if content is not None else ""
    return (f"<item><title>Post {n}</title><link>https://blog.example.com/2026/11/post-{n}/?utm_source=rss</link>"
            f"<pubDate>{when}</pubDate><dc:creator>Writer</dc:creator><description><![CDATA[{summary}]]></description>{body}</item>")


def _feed(*items: str) -> bytes:
    return ('<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Example</title>'
            + "".join(items) + "</channel></rss>").encode("utf-8")


def _page(n: int) -> bytes:
    return (f"<html><head><title>Post {n}</title></head><body><nav>menu</nav><article><h1>Post {n}</h1>"
            f"<p>{LONG}</p><p>Second paragraph of post {n}.</p></article><footer>foot</footer></body></html>").encode("utf-8")


class FakeFetch:
    """ladder.fetch 대역 — 주소별 답(바이트·예외·304)을 돌려주고 부른 주소를 적습니다."""

    def __init__(self, routes: dict[str, object]):
        self.routes = routes
        self.calls: list[tuple[str, dict | None]] = []

    def __call__(self, url, *, headers=None, **_):
        self.calls.append((url, headers))
        answer = self.routes.get(url)
        if answer is None:
            raise ladder.FetchFailed(f"{http.host_of(url)} HTTP 404")
        if isinstance(answer, Exception):
            raise answer
        if answer == 304:
            return ladder.Fetched(url=url, status=304, content_type="", body=b"", tier="impersonate", final_url=url)
        return ladder.Fetched(url=url, status=200, content_type="application/rss+xml; charset=utf-8", body=answer,
                              tier="impersonate", final_url=url, headers={"etag": '"v1"'})

    def pages(self) -> list[str]:
        return [url for url, _ in self.calls if url != BLOG.feed]


@pytest.fixture()
def example_host(monkeypatch):
    """합성 블로그 호스트를 정책 표에 넣습니다(글 페이지를 열 수 있는 호스트)."""
    monkeypatch.setitem(policy.POLICIES, "blog.example.com",
                        policy.HostPolicy("blog.example.com", (policy.TIER_IMPERSONATE,), daily_budget=20))


# ==============================================================================
# 1·2. 피드 본문 우선, 글 페이지는 본문이 없을 때만
# ==============================================================================
def test_피드에_본문이_있으면_글_페이지를_열지_않는다(store, example_host):
    fetch = FakeFetch({BLOG.feed: _feed(_item(1), _item(2, days_ago=1))})

    detail = info_blogs.collect(BLOG, fetch=fetch, now=NOW)

    assert fetch.pages() == []
    row = store.info_item(info_text.item_id("https://blog.example.com/2026/11/post-1/"))
    assert row["body_status"] == "full" and row["source"] == "blog.example" and row["author"] == "Writer"
    assert "appeared first on" not in row["body"], "워드프레스 꼬리 줄은 본문이 아닙니다"
    assert row["published_at"] == NOW
    assert "피드 본문 2" in detail


def test_본문이_없는_최근_글만_글_페이지를_열고_실행당_상한까지(store, example_host):
    items = [_item(n, days_ago=n * 0.1, content=None) for n in range(1, 9)] + [_item(9, days_ago=10, content=None)]
    routes = {BLOG.feed: _feed(*items)}
    routes.update({f"https://blog.example.com/2026/11/post-{n}/?utm_source=rss": _page(n) for n in range(1, 10)})
    fetch = FakeFetch(routes)

    info_blogs.collect(BLOG, fetch=fetch, now=NOW)

    assert len(fetch.pages()) == info_blogs.PAGE_FETCHES_PER_RUN
    assert all("post-9" not in url for url in fetch.pages()), "7일보다 오래된 글은 페이지를 열지 않습니다"
    newest = store.info_item(info_text.item_id("https://blog.example.com/2026/11/post-1/"))
    assert newest["body_status"] == "full" and "Second paragraph of post 1" in newest["body"]
    assert info_blogs.PAGE_FETCHES_PER_RUN == 6
    left = store.info_item(info_text.item_id("https://blog.example.com/2026/11/post-8/"))
    assert left["body_status"] == "partial" and left["body"] == "Short teaser.", "못 연 글은 피드 요약으로 둡니다"


@pytest.mark.xfail(strict=True, reason="QA-388: _page_worthy가 정책 표의 아무 호스트나 글 페이지로 엽니다")
def test_QA388_피드_항목의_링크가_그_블로그의_호스트가_아니면_글_페이지를_열지_않는다(store, example_host):
    """
    피드 항목의 링크가 정책 표의 **다른** 호스트(KRX 등)를 가리켜도 글 페이지로 열면, 그 호스트의 세션 쿠키가 붙은 요청이 나가고
    응답이 이 블로그의 글로 저장됩니다. 글 페이지는 그 블로그 자신의 호스트(피드·사이트 주소의 호스트)일 때만 엽니다.
    """
    other = "https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd"
    assert "data.krx.co.kr" in policy.POLICIES
    when = format_datetime(NOW)
    foreign = (f"<item><title>Elsewhere</title><link>{other}</link><pubDate>{when}</pubDate>"
               f"<description><![CDATA[Short teaser.]]></description></item>")
    fetch = FakeFetch({BLOG.feed: _feed(foreign, _item(2, content=None)),
                       "https://blog.example.com/2026/11/post-2/?utm_source=rss": _page(2)})

    info_blogs.collect(BLOG, fetch=fetch, now=NOW)

    assert fetch.pages() == ["https://blog.example.com/2026/11/post-2/?utm_source=rss"]
    row = store.info_item(info_text.item_id(other))
    assert row["body_status"] == "partial" and row["meta"] == {}, "열지 않은 글은 피드 요약으로 두고 시도 횟수도 세지 않습니다"


def test_본문을_받은_글은_다시_받지_않고_못_받은_글은_두_번까지만_연다(store, example_host):
    routes = {BLOG.feed: _feed(_item(1, content=None), _item(2, content=None))}
    routes["https://blog.example.com/2026/11/post-1/?utm_source=rss"] = _page(1)
    fetch = FakeFetch(routes)          # post-2의 페이지는 404

    info_blogs.collect(BLOG, fetch=fetch, now=NOW)
    info_blogs.collect(BLOG, fetch=fetch, now=NOW)
    info_blogs.collect(BLOG, fetch=fetch, now=NOW)

    opened = fetch.pages()
    assert opened.count("https://blog.example.com/2026/11/post-1/?utm_source=rss") == 1
    assert opened.count("https://blog.example.com/2026/11/post-2/?utm_source=rss") == info_blogs.PAGE_TRIES_PER_ITEM


def test_30일보다_오래된_글은_넣지_않는다(store, example_host):
    fetch = FakeFetch({BLOG.feed: _feed(_item(1), _item(2, days_ago=45))})

    info_blogs.collect(BLOG, fetch=fetch, now=NOW)

    assert store.info_item(info_text.item_id("https://blog.example.com/2026/11/post-2/")) is None


# ==============================================================================
# 4. 304·형식 바뀜
# ==============================================================================
def test_바뀐_것이_없으면_304로_끝나고_다음_요청에_검증값을_보낸다(store, example_host):
    fetch = FakeFetch({BLOG.feed: _feed(_item(1))})
    info_blogs.collect(BLOG, fetch=fetch, now=NOW)
    fetch.routes[BLOG.feed] = 304

    detail = info_blogs.collect(BLOG, fetch=fetch, now=NOW)

    assert "304" in detail
    assert fetch.calls[-1][1] == {"If-None-Match": '"v1"'}


def test_피드가_HTML이면_형식_바뀜(store, example_host):
    fetch = FakeFetch({BLOG.feed: b"<html><body><h1>Our new site</h1></body></html>"})

    with pytest.raises(ShapeError, match="피드에서 글을 읽지 못함"):
        info_blogs.collect(BLOG, fetch=fetch, now=NOW)


# ==============================================================================
# 5. 거부
# ==============================================================================
def test_QA387_받은_본문이_파일_경로_모양이어도_그_파일을_열지_않는다(tmp_path):
    """
    feedparser는 ``read``가 없는 입력을 먼저 파일 이름으로 열어 보고 실패할 때만 데이터로 봅니다. 출처가 본문으로 경로를 주면
    (``/dev/zero`` 같은 끝없는 파일이면 수집기가 메모리 부족으로 죽음) 그 파일을 읽으면 안 됩니다 — 받은 바이트는 데이터로만 읽습니다.
    """
    path = tmp_path / "feed.xml"
    path.write_bytes(_feed(_item(1)))

    with pytest.raises(ShapeError):
        info_blogs.parse_feed(str(path).encode("utf-8"))


def test_글_페이지가_거부되면_받은_글은_넣고_거부를_올린다(store, example_host):
    closed = state.Closed("blog.example.com", "HTTP 403(계층 impersonate)", NOW + timedelta(hours=1), False)
    routes = {BLOG.feed: _feed(_item(1), _item(2, content=None), _item(3, content=None))}
    routes["https://blog.example.com/2026/11/post-2/?utm_source=rss"] = ladder.FetchRejected(closed)
    fetch = FakeFetch(routes)

    with pytest.raises(ladder.FetchRejected):
        info_blogs.collect(BLOG, fetch=fetch, now=NOW)

    assert store.info_item(info_text.item_id("https://blog.example.com/2026/11/post-1/"))["body_status"] == "full"
    assert store.info_item(info_text.item_id("https://blog.example.com/2026/11/post-3/"))["body_status"] == "partial"
    assert len(fetch.pages()) == 1, "거부된 뒤에는 그 실행에서 페이지를 더 열지 않습니다"


# ==============================================================================
# 글자 다루기
# ==============================================================================
@pytest.mark.parametrize("left,right", [
    ("https://www.example.com/a/b/?utm_source=x&id=3#c", "http://example.com/a/b?id=3"),
    ("https://example.com/p?fbclid=1", "https://EXAMPLE.com/p"),
])
def test_같은_글의_주소는_같은_id(left, right):
    assert info_text.item_id(left) == info_text.item_id(right)


def test_다른_인자는_다른_글():
    assert info_text.item_id("https://example.com/p?id=1") != info_text.item_id("https://example.com/p?id=2")


def test_본문_고르기는_내비게이션과_꼬리말을_버린다():
    text = info_text.extract_article(_page(3).decode())

    assert "Second paragraph of post 3" in text and "menu" not in text and "foot" not in text


def test_본문을_못_고르면_빈_글이다():
    assert info_text.extract_article("<html><body><p>short</p></body></html>") == ""


# ==============================================================================
# 6. 정책 표·등록
# ==============================================================================
def test_모든_출처_호스트는_정책_표에_있고_브라우저_계층으로_올라갈_수_있다():
    from app.services import info_naver, info_waedge

    hosts = {http.host_of(blog.feed) for blog in info_blogs.BLOGS} | {http.host_of(blog.site) for blog in info_blogs.BLOGS}
    hosts |= {http.host_of(info_waedge.BRIEF_URL), http.host_of(info_naver.API)}
    hosts -= {"theirrelevantinvestor.com"}
    for host in hosts:
        rules = policy.policy_for(host)
        assert rules.daily_budget > 0
        assert policy.TIER_BROWSER in rules.tiers, host


def test_정보_수집_태스크는_모두_polite이고_이름이_겹치지_않는다():
    names = [task.name for task in registry.ALL_TASKS if task.name.startswith("info_")]

    assert len(names) == len(set(names)) == len(info_blogs.BLOGS) + 6
    assert all(registry.TASKS_BY_NAME[name].speed == "polite" for name in names)
