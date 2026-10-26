"""
tests/test_kr_news_headlines.py
한국 사건 뉴스 RSS 헤드라인(태스크 kr_news_headlines, v2 2단계 명세 §4-11·K21·B9) — 한국 책 Claude 계좌 패킷 11b_events의 원자료.

고정하는 규칙
  1. 피드는 한국은행 보도자료(전체)·재정경제부 보도·참고자료·국가데이터처 보도자료·연합뉴스 마켓+ 네 개(KR_FEEDS). 미국 표(FEEDS)와 따로이고
     금융위원회(503 점검 중)는 없다. 세션은 설명형 UA(BLS 세션과 같은 것, 403에 BLS 안내를 붙이지 않음).
  2. 시각은 피드마다 정한 형식으로 원문을 직접 읽는다 — rfc822(초)·yyyyMMddHHmm(분, KST)·date_only(날짜만, KST). 형식과 다른 원문은
     지어내지 않고 건너뛰어 센다. 미국 피드의 읽기(feedparser 값)는 그대로다.

외부 네트워크를 쓰지 않습니다 — 고정본은 tests/fixtures/news_kr/(연합뉴스는 합성 자료, README).
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from app import http
from app.services import news as svc

FIXTURES = Path(__file__).parent / "fixtures" / "news_kr"
FILES = {
    "bok_press": "bok_press.xml",
    "mofe_press": "mofe_press.xml",
    "mods_press": "mods_press.xml",
    "yna_market": "yna_market.xml",
}
FEED = {feed.key: feed for feed in svc.KR_FEEDS}


def _fixture(key: str) -> bytes:
    return (FIXTURES / FILES[key]).read_bytes()


def _replace(raw: bytes, old: str, new: str, count: int = 1) -> bytes:
    text = raw.decode("utf-8")
    assert old in text, old
    return text.replace(old, new, count).encode("utf-8")


def _parse(key: str, raw: bytes | None = None) -> svc.ParsedFeed:
    return svc.parse_feed(_fixture(key) if raw is None else raw, "application/rss+xml", feed=FEED[key])


# ==============================================================================
# 1. 피드 표
# ==============================================================================
def test_한국_피드는_네_개이고_미국_표와_따로다():
    assert [(f.key, f.source, f.url, f.session, f.time_format, f.naive_tz) for f in svc.KR_FEEDS] == [
        ("bok_press", "한국은행", "https://www.bok.or.kr/portal/bbs/B0000552/news.rss?menuNo=200690", "product",
         "rfc822", "Asia/Seoul"),
        ("mofe_press", "재정경제부", "https://mofe.go.kr/com/detailRssTagService.do?bbsId=MOSFBBS_000000000028", "product",
         "date_only", "Asia/Seoul"),
        ("mods_press", "국가데이터처", "https://mods.go.kr/board.es?mid=a10301010000&bid=a103010100&act=rss", "product",
         "yyyyMMddHHmm", "Asia/Seoul"),
        ("yna_market", "연합뉴스", "https://www.yna.co.kr/rss/market.xml", "product", "rfc822", "Asia/Seoul"),
    ]
    assert svc.KR_FEED_KEYS == tuple(FILES)
    assert not set(svc.KR_FEED_KEYS) & set(svc.FEED_KEYS)
    # 금융위 RSS는 점검 중(503, G10)·금감원은 RSS 없음·정책브리핑은 중단 — 표에 없습니다.
    urls = " ".join(feed.url for feed in svc.KR_FEEDS)
    assert "fsc.go.kr" not in urls and "fss.or.kr" not in urls and "korea.kr" not in urls and "einfomax" not in urls
    assert {feed.time_format for feed in svc.KR_FEEDS} == set(svc.TIME_FORMATS)


def test_미국_피드는_시각을_feedparser로_읽는_그대로다():
    assert all(feed.time_format is None and feed.naive_tz == "UTC" for feed in svc.FEEDS)


def test_한국_피드는_설명형_UA_세션이고_403에_BLS_안내를_붙이지_않는다(monkeypatch):
    calls = []

    class _Session:
        def get(self, url, timeout=None, stream=False):
            calls.append(url)
            raise http.SourceRejected("www.bok.or.kr", "HTTP 403")

    monkeypatch.setattr(svc, "get_bls_session", lambda: _Session())
    monkeypatch.setattr(svc, "get_session", lambda: pytest.fail("한국 피드가 브라우저 UA 세션을 썼습니다"))
    with pytest.raises(svc.FeedFetchError) as caught:
        svc.fetch_feed(FEED["bok_press"])
    assert str(caught.value) == "거부됨 — www.bok.or.kr HTTP 403 · 5분 동안 이 출처 호출을 멈춤"
    assert calls == [FEED["bok_press"].url]


# ==============================================================================
# 2. 시각 형식 세 가지 (고정본)
# ==============================================================================
def test_rfc822_시간대_오프셋을_읽고_KST_날짜와_초_정밀도():
    parsed = _parse("bok_press")

    assert parsed.version == "rss20" and parsed.entries == 3 and parsed.bad_time == 0
    first = parsed.items[0]
    assert first["title"] == "한국은행 부총재보 인사"
    assert first["publishedAt"] == datetime(2026, 10, 26, 8, 30, tzinfo=timezone.utc)   # 17:30 +0900
    assert first["publishedDate"] == date(2026, 10, 26) and first["precision"] == "second"
    assert first["link"] == "https://www.bok.or.kr/portal/bbs/B0000502/view.do?nttId=11065937&menuNo=200690"
    assert first["entity"] == svc.title_entity(first["title"])
    # 09:00 KST는 UTC로는 자정 — 날짜는 KST 날짜 그대로입니다.
    third = parsed.items[2]
    assert third["publishedAt"] == datetime(2026, 10, 26, 0, 0, tzinfo=timezone.utc)
    assert third["publishedDate"] == date(2026, 10, 26)


def test_yyyyMMddHHmm은_KST_분_단위로_읽고_feedparser처럼_시각을_버리지_않는다():
    parsed = _parse("mods_press")

    first = parsed.items[0]
    assert first["title"] == "2025년 이주배경인구 통계 결과(등록센서스 방식)"
    assert first["publishedAt"] == datetime(2026, 10, 25, 10, 5, tzinfo=timezone.utc)   # 원문 202610251905 = 19:05 KST
    assert first["publishedDate"] == date(2026, 10, 25) and first["precision"] == "minute"
    assert [item["publishedAt"] for item in parsed.items[1:]] == [
        datetime(2026, 10, 22, 1, 36, tzinfo=timezone.utc), datetime(2026, 10, 21, 4, 27, tzinfo=timezone.utc)]
    # 형식 없이(미국 피드처럼) 읽으면 feedparser가 시각을 버리고 UTC 자정으로 읽습니다 — 그래서 한국 피드는 원문을 직접 읽습니다.
    assert svc.parse_feed(_fixture("mods_press")).items[0]["publishedAt"] == datetime(2026, 10, 25, tzinfo=timezone.utc)


def test_date_only는_날짜만_남기고_발행_시각은_None():
    parsed = _parse("mofe_press")

    assert [(item["title"], item["publishedAt"], item["publishedDate"], item["precision"]) for item in parsed.items] == [
        ("경제현안간담회 개최", None, date(2026, 10, 25), "date"),
        ("'26.10월 국고채 「모집 방식 비경쟁인수」 발행 미실시", None, date(2026, 10, 23), "date"),
        ("제9회 디지털 이코노미 포럼 개최", None, date(2026, 10, 23), "date"),
    ]
    assert parsed.items[0]["link"].startswith("http://mofe.go.kr/nw/nes/detailNesDtaView.do?")   # http 링크도 그대로


def test_연합뉴스_합성_고정본도_rfc822로_읽는다():
    parsed = _parse("yna_market")
    assert [(item["publishedAt"], item["precision"]) for item in parsed.items] == [
        (datetime(2026, 10, 26, 14, 2, 50, tzinfo=timezone.utc), "second"),
        (datetime(2026, 10, 26, 10, 35, 57, tzinfo=timezone.utc), "second"),
        (datetime(2026, 10, 26, 10, 35, 12, tzinfo=timezone.utc), "second"),
    ]


@pytest.mark.parametrize("raw, time_format, expected", [
    # 시간대 없는 rfc822는 naive_tz(KST)로 봅니다.
    ("Mon, 26 Oct 2026 17:30:00", "rfc822", (datetime(2026, 10, 26, 8, 30, tzinfo=timezone.utc), date(2026, 10, 26), "second")),
    # UTC 저녁은 KST로 다음 날 — 날짜는 KST 달력입니다.
    ("Sun, 25 Oct 2026 16:00:00 +0000", "rfc822", (datetime(2026, 10, 25, 16, 0, tzinfo=timezone.utc), date(2026, 10, 26), "second")),
    ("  202610251905\n", "yyyyMMddHHmm", (datetime(2026, 10, 25, 10, 5, tzinfo=timezone.utc), date(2026, 10, 25), "minute")),
    ("2026-10-25 00:00:00.0", "date_only", (None, date(2026, 10, 25), "date")),
    ("2026-10-25", "date_only", (None, date(2026, 10, 25), "date")),
    # 형식과 다르면 None — 지어내지 않습니다.
    ("2026-10-25 19:05", "yyyyMMddHHmm", None),
    ("20261025190", "yyyyMMddHHmm", None),
    ("202613251905", "yyyyMMddHHmm", None),
    ("202610251905", "date_only", None),
    ("2026-13-01 00:00:00.0", "date_only", None),
    ("26 Oct 2026", "rfc822", None),
    ("어제", "rfc822", None),
])
def test_read_time(raw, time_format, expected):
    assert svc.read_time(raw, time_format, "Asia/Seoul") == expected


def test_모르는_형식은_코드_오류():
    with pytest.raises(ValueError, match="모르는 시각 형식"):
        svc.read_time("202610251905", "iso8601", "Asia/Seoul")


def test_형식과_다른_시각은_건너뛰고_따로_센다():
    raw = _replace(_fixture("mods_press"), "<pubDate>202610221036</pubDate>", "<pubDate>2026-10-22 10:36</pubDate>")
    raw = _replace(raw, "<pubDate>202610211327</pubDate>", "")
    parsed = _parse("mods_press", raw)

    assert (parsed.entries, parsed.bad_time, parsed.no_time) == (3, 1, 1)
    assert [item["title"] for item in parsed.items] == ["2025년 이주배경인구 통계 결과(등록센서스 방식)"]


def test_모두_형식이_다르면_FeedShapeError에_그_수가_나온다():
    raw = _fixture("mofe_press").decode("utf-8").replace(" 00:00:00.0</pubDate>", "T00:00:00+09:00Z!</pubDate>").encode("utf-8")
    with pytest.raises(svc.FeedShapeError, match=r"쓸 항목 없음\(항목 3개 — 시각 없음 0, 시각 형식 다름 3, 제목 없음 0\)"):
        _parse("mofe_press", raw)
