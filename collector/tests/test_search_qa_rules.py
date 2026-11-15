"""
tests/test_search_qa_rules.py
정보 검색 규칙(계약 §4·§9-7)의 QA 결함 재현·고정 시험 — 네트워크·DB 없이 합성 값으로(실제 법인 이름을 쓰지 않음).

- QA-441: 가나 없이 한자로만 쓴 일본 법인명('株式会社…'·'…株式会社' — GLEIF 법인명의 꼴)과 일본 신자체가 든 제목은 중국어 제목으로 빼지 않음
  (연결 탭 GLEIF 이름 포함). 중국어 제목(간체·번체 '股份有限公司', '会社'가 낱말 경계에 걸친 중국어 글)은 그대로 뺌
"""
from __future__ import annotations

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


@pytest.mark.xfail(strict=True, reason="QA-441: 가나 없이 한자로만 쓴 일본 법인명·신자체 글을 중국어 제목으로 봄")
@pytest.mark.parametrize("title", JAPANESE_WITHOUT_KANA)
def test_가나_없는_일본_법인명과_신자체_글은_중국어_제목이_아니다(title):
    assert rules.is_chinese_title(title) is False


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


@pytest.mark.xfail(strict=True, reason="QA-441: 연결 탭 GLEIF의 일본 자회사 법인명(株式会社…)을 중국어 제목으로 빼고 건수에 셈")
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
