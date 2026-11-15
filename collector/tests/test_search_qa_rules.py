"""
tests/test_search_qa_rules.py
정보 검색 규칙(계약 §4·§9-7)의 QA 결함 재현·고정 시험 — 네트워크·DB 없이 합성 값으로(실제 법인 이름을 쓰지 않음).

- QA-441: 가나 없이 한자로만 쓴 일본 법인명('株式会社…'·'…株式会社' — GLEIF 법인명의 꼴)과 일본 신자체가 든 제목은 중국어 제목으로 빼지 않음
  (연결 탭 GLEIF 이름 포함). 중국어 제목(간체·번체 '股份有限公司', '会社'가 낱말 경계에 걸친 중국어 글)은 그대로 뺌
- QA-442: 같은 매체의 다른 표기(도메인 꼴 이름·붙여 쓴 이름·꼬리 'Media')는 같은 사건 묶음의 '매체 n곳'에서 한 곳으로 셈 — 화면
  (infoSearch publisherCount)과 같은 고정본(fixtures/search/publisher_keys.json)으로 대조. 서로 다른 매체는 그대로 따로
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app import http
from app.services import search, search_links, search_store
from app.services import search_rules as rules


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    search.reset_cache()
    http.reset_guards()
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    monkeypatch.setattr(search_store, "guru_names", lambda: [])
    yield
    search.reset_cache()
    http.reset_guards()


# ------------------------------------------------------------------ QA-441 일본 법인명·신자체 제목

# 가나가 없는 일본어 — 법인 형태(株式会社·有限会社·合同会社·相互会社)를 앞이나 뒤에 붙인 법인명, 전각 라틴 글자가 섞인 법인명,
# 일본 신자체(経·済·険)나 반복 부호(々)가 든 글.
JAPANESE_WITHOUT_KANA = [
    "株式会社架空銀行",
    "架空信託銀行株式会社",
    "株式会社架空ＵＦＪ銀行",
    "合同会社架空商事",
    "有限会社架空工業",
    "架空生命保険相互会社",
    "架空経済研究所",
    "佐々木架空",
]


@pytest.mark.parametrize("title", JAPANESE_WITHOUT_KANA)
def test_가나_없는_일본_법인명과_신자체_글은_중국어_제목이_아니다(title):
    assert rules.is_chinese_title(title) is False


def test_일본_신자체_목록은_중국_간체·번체·홍콩_표에_없는_일본_한자뿐이다():
    """목록에 중국어 글에도 쓰는 글자가 들어가면 그 글자가 든 중국어 제목이 남으므로, 세 표 어디에도 없고 일본 표(JIS)에는 있는 글자만."""
    assert len(set(rules.JA_ONLY_KANJI)) == len(rules.JA_ONLY_KANJI)
    for char in rules.JA_ONLY_KANJI:
        char.encode("shift_jis")
        for codec in ("gb2312", "big5", "big5hkscs"):
            with pytest.raises(UnicodeEncodeError):
                char.encode(codec)


@pytest.mark.parametrize("title", [
    "架空フィナンシャル株式会社",          # 가나가 있으면 지금도 남음
    "日経平均が反発",
    "架空銀行 (Fictional Bank) announces results for the second quarter",
])
def test_가나가_있거나_라틴이_많은_글은_지금처럼_남는다(title):
    assert rules.is_chinese_title(title) is False


@pytest.mark.parametrize("title", [
    "某某银行股份有限公司",                 # 간체
    "某某銀行股份有限公司",                 # 번체 — '銀行'은 일본어와 같은 글자지만 법인 형태가 중국어
    "架空证券有限责任公司",
    "架空芯片上海有限公司",
    "两会社会保障议题",                     # '会社'가 낱말 경계(两会 + 社会)에 걸친 중국어 글
    "華爾街日報：美聯儲官員暗示降息",
    "英伟达发布新一代芯片",
])
def test_중국어_제목은_그대로_빠진다(title):
    assert rules.is_chinese_title(title) is True


US = {"key": "us:SCHP", "kind": "company", "name": "합성칩", "nameKo": "합성칩", "nameEn": "SynthChip", "aliases": ["SynthChip"],
      "description": None, "links": [], "sources": [],
      "ids": {"ticker": "SCHP", "market": "us", "stockCode": None, "cik": "0009000001", "dartCorpCode": None,
              "wikidata": "Q900001", "lei": "SYNTH" + "0" * 13 + "42"}}


def test_GLEIF_일본_자회사_법인명은_연결에서_빠지지_않는다(monkeypatch):
    gleif = search_links.Linked(items=[
        {"relation": "subsidiary", "key": None, "name": "株式会社架空銀行", "kind": "company", "source": "gleif", "detail": "JP · LEI A"},
        {"relation": "subsidiary", "key": None, "name": "架空信託銀行株式会社", "kind": "company", "source": "gleif", "detail": "JP · LEI B"},
        {"relation": "subsidiary", "key": None, "name": "架空芯片上海有限公司", "kind": "company", "source": "gleif", "detail": "CN · LEI C"},
    ])
    monkeypatch.setattr(search, "entity", lambda key, external=True: {"entity": US, "errors": {}, "fetchedAt": None})
    monkeypatch.setattr(search_links, "insiders", lambda ticker: search_links.Linked())
    asked = []
    monkeypatch.setattr(search_links, "gleif", lambda lei: asked.append(lei) or gleif)
    out = search.links("us:SCHP", external=True)
    assert asked == [US["ids"]["lei"]], "시험의 전제: GLEIF를 물음(LEI 모양이 맞음)"
    assert [link["name"] for link in out["links"]] == ["株式会社架空銀行", "架空信託銀行株式会社"], "중국 자회사 이름만 뺌"
    row = next(row for row in out["sources"] if row["source"] == "gleif")
    assert (row["count"], row["dropped"]["chinese"]) == (2, 1)


# ------------------------------------------------------------------ QA-442 같은 매체의 다른 표기

PUBLISHER_CASES = json.loads((Path(__file__).parent / "fixtures" / "search" / "publisher_keys.json").read_text(encoding="utf-8"))
_BASE = datetime(2026, 11, 13, 1, 0, tzinfo=timezone.utc)


def _cluster_publishers(rows: list) -> int | None:
    """고정본의 줄([이름, 도메인]) → 같은 제목·한 시간 간격의 묶음 하나 → 대표 줄의 매체 수."""
    items = [{"id": f"p{n}", "kind": "news", "title": "SynthChip recalls accelerator boards", "url": f"https://news.example/p{n}",
              "publisher": name, "publisherDomain": domain, "timeBasis": "published", "source": "bing", "lang": "en",
              "publishedAt": (_BASE + timedelta(hours=n)).isoformat(), "summary": None, "readerId": None}
             for n, (name, domain) in enumerate(rows)]
    leads = [row for row in rules.cluster_items(items) if row["cluster"]]
    assert len(leads) == 1 and leads[0]["cluster"]["size"] == len(rows), "시험의 전제: 줄이 모두 한 묶음"
    return leads[0]["cluster"]["publishers"]


@pytest.mark.parametrize("case", PUBLISHER_CASES["sameOutlet"], ids=lambda case: f"rows{len(case['rows'])}")
def test_같은_매체의_다른_표기는_한_곳으로_센다(case):
    assert _cluster_publishers(case["rows"]) == case["publishers"]


@pytest.mark.parametrize("case", PUBLISHER_CASES["distinctOutlets"], ids=lambda case: f"rows{len(case['rows'])}")
def test_서로_다른_매체는_그대로_따로_센다(case):
    assert _cluster_publishers(case["rows"]) == case["publishers"]


def test_매체_세기_키는_화면과_같은_고정본대로():
    for name, key in PUBLISHER_CASES["keys"]:
        assert rules.publisher_key(name) == key, name


def test_매체_제외의_이름_대조는_세기_키가_아니라_지금처럼_완전_일치():
    """세기 키는 '매체 n곳'에만 — 사용자가 더한 이름 'Kalsynth'가 'Kalsynth Media'·'www.kalsynth.com'까지 빼지 않음(계약 §4-3)."""
    extra = rules.make_excludes([{"kind": "name", "value": "Kalsynth"}])
    assert rules.is_excluded_media(None, "KALSYNTH on MSN", extra) is True
    assert rules.is_excluded_media(None, "Kalsynth Media", extra) is False
    assert rules.is_excluded_media(None, "www.kalsynth.com", extra) is False
    assert rules.is_excluded_media(None, "Xinhua News", None) is False and rules.is_excluded_media(None, "xinhua", None) is True
