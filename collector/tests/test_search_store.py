"""
tests/test_search_store.py
정보 검색의 저장본 출처(services/search_store.py) — 테스트 DB의 전용 스키마(store 픽스처)에 합성 행을 넣고 봅니다. 쓰지 않고 읽기만 합니다.

- 사건 뉴스 관측치(news_headline·kr_news_headline): 제목·요약에서 별칭(영문 단어 경계·한글 포함), 시각이 없는 줄은 처음 받은 시각('fetched')
- 수집 글(info_items의 블로그·waedge): 제목·한국어 제목·요약·본문에서 별칭, 건수 상한, 원문 팝업 id(readerId)
- 속보(info_items kind headline)는 따로, 거장 견해(스냅샷)는 이름·요약에서
- DART 고유번호 저장본·거장 이름 목록
"""
from __future__ import annotations

from datetime import datetime, timezone

from app import catalog
from app.services import info_text
from app.services import search_store


def _headline(title, link, *, published="2026-11-13T07:00:00+00:00", summary=None, source="합성 피드", **extra):
    payload = {"title": title, "link": link, "source": source, "feed": "synthetic", "feeds": ["synthetic"],
               "publishedAt": published, "fetchedAt": "2026-11-13T07:05:00+00:00"}
    if summary:
        payload["summary"] = summary
    payload.update(extra)
    return payload


def test_사건_뉴스_저장본에서_별칭이_든_줄(store):
    store.insert_new_observations(catalog.OBS_NEWS_HEADLINE, [
        ("2026-11-13", "e1", _headline("Synthetic Corp beats estimates", "https://www.example.org/n1")),
        ("2026-11-13", "e2", _headline("Unrelated macro story", "https://www.example.org/n2",
                                       summary="Analysts mention Synthetic Corp in passing")),
        ("2026-11-13", "e3", _headline("SyntheticCorpus dataset released", "https://www.example.org/n3")),
    ])
    store.insert_new_observations(catalog.OBS_KR_NEWS_HEADLINE, [
        ("2026-11-13", "k1", _headline("합성전자, 3분기 실적 발표", "https://www.example.kr/k1", published=None,
                                       publishedDate="2026-11-13", timePrecision="date",
                                       knownAt="2026-11-13T00:00:00+00:00")),
    ])
    fetched = search_store.event_news(["Synthetic Corp", "합성전자"])
    assert fetched.error is None
    by_title = {item["title"]: item for item in fetched.items}
    assert set(by_title) == {"Synthetic Corp beats estimates", "Unrelated macro story", "합성전자, 3분기 실적 발표"}
    first = by_title["Synthetic Corp beats estimates"]
    assert first["kind"] == "headline" and first["source"] == "event_news" and first["lang"] == "en"
    assert first["publisher"] == "합성 피드" and first["publisherDomain"] == "example.org"
    assert first["id"] == info_text.item_id("https://www.example.org/n1") and first["readerId"] is None
    korean = by_title["합성전자, 3분기 실적 발표"]
    assert korean["timeBasis"] == "fetched" and korean["publishedAt"] == "2026-11-13T07:05:00+00:00"
    assert korean["lang"] == "ko"
    assert search_store.event_news([]).items == []


def _info(item_id, *, source="blog.wolfstreet", kind="article", title="Synthetic title", title_ko=None, summary=None,
          body=None, published=datetime(2026, 11, 12, 1, tzinfo=timezone.utc), url=None):
    return {"id": item_id, "source": source, "kind": kind, "url": url or f"https://blog.example.org/{item_id}", "title": title,
            "title_ko": title_ko, "published_at": published, "summary": summary, "body": body,
            "body_status": "full" if body else "none"}


def test_수집_글은_제목·한국어_제목·요약·본문에서_찾는다(store):
    store.upsert_info_items([
        _info("i1", title="On Synthetic Corp margins"),
        _info("i2", title="Weekly links", title_ko="합성전자 이야기"),
        _info("i3", title="Rates and credit", summary="A note about Synthetic Corp."),
        _info("i4", title="Long essay", body="Deep inside the body we discuss Synthetic Corp at length."),
        _info("i5", title="Synthetic Corporation history"),              # 단어 경계 — 'Synthetic Corp'의 다른 낱말
        _info("i6", source="waedge.brief", kind="brief", title="합성전자 수급", published=None),
        _info("i7", source="waedge.people", kind="guru", title="거장의 합성전자 언급"),
        _info("w1", source="wire.financialjuice", kind="headline", title="Synthetic Corp halted"),
    ])
    fetched = search_store.info_posts(["Synthetic Corp", "합성전자"])
    assert fetched.error is None
    ids = {item["readerId"] for item in fetched.items}
    assert ids == {"i1", "i2", "i3", "i4", "i6", "i7"}
    by_reader = {item["readerId"]: item for item in fetched.items}
    assert by_reader["i1"]["source"] == "info" and by_reader["i1"]["kind"] == "post"
    assert by_reader["i1"]["publisher"] == "Wolf Street"
    assert by_reader["i7"]["kind"] == "opinion" and by_reader["i6"]["publisher"] == "WAEDGE NEWS"
    assert by_reader["i6"]["timeBasis"] == "fetched" and by_reader["i6"]["publishedAt"], "작성 시각이 없으면 처음 받은 시각"
    assert all("body" not in item for item in fetched.items)

    wire = search_store.wire(["Synthetic Corp"])
    assert [item["readerId"] for item in wire.items] == ["w1"]
    assert wire.items[0]["kind"] == "wire" and wire.items[0]["source"] == "wire"
    assert wire.items[0]["publisher"] == "Financial Juice"


def test_수집_글은_건수_상한까지만(store, monkeypatch):
    store.upsert_info_items([_info(f"c{n}", title=f"Synthetic Corp note {n}") for n in range(5)])
    monkeypatch.setattr(search_store, "INFO_ROW_LIMIT", 3)
    fetched = search_store.info_posts(["Synthetic Corp"])
    assert len(fetched.items) == 3
    assert fetched.note and "3" in fetched.note


def test_거장_견해는_이름·요약에서(store):
    store.put_snapshot(catalog.SNAP_INFO_WAEDGE_GURUS, {
        "sourceUrl": "https://news.example.org/people", "asOf": "2026-11-12",
        "gurus": [
            {"name": "합성 투자자", "stance": "강세", "score": 40, "asOf": "2026-11-12", "summary": "합성전자 비중을 늘림"},
            {"name": "다른 투자자", "stance": "약세", "score": -20, "asOf": None, "summary": "채권 선호"},
            {"name": "Synthetic Investor", "stance": None, "score": None, "asOf": "2026-11-10", "summary": None},
        ]})
    fetched = search_store.guru_views(["합성전자", "Synthetic Investor"])
    titles = [item["title"] for item in fetched.items]
    assert len(titles) == 2
    first = next(item for item in fetched.items if "합성 투자자" in item["title"])
    assert first["kind"] == "opinion" and first["source"] == "guru" and first["summary"] == "합성전자 비중을 늘림"
    assert first["publishedAt"] == "2026-11-11T15:00:00+00:00", "기준일 00:00 KST"
    assert "강세" in first["title"] and "+40" in first["title"]
    assert search_store.guru_names() == ["합성 투자자", "다른 투자자", "Synthetic Investor"]


def test_DART_고유번호_저장본(store):
    assert search_store.dart_codes() == {}
    store.put_snapshot(catalog.SNAP_DART_CORP_CODES, {"codes": {"005930": {"corpCode": "00126380", "name": "합성전자"},
                                                                "bad": "x"}, "count": 2})
    assert search_store.dart_codes() == {"005930": {"corpCode": "00126380", "name": "합성전자"}}
