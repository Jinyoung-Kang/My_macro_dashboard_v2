"""
tests/test_search_qa_dart.py
정보 검색 국내 종목의 DART 고유번호 사유(QA-429) — 네트워크·DB 없이.

- 대상 풀기(search_entities._build_kr)가 DART 고유번호를 찾지 못한 사유: 저장본을 읽었는데 그 종목이 없으면 errors.dart에 '저장본에 이 종목이 없음',
  저장본이 없거나 읽지 못해 빈 표면 errors.dart_store에 '저장본을 읽지 못함'(계약 §5 — 확인하지 못한 것을 '없음'으로 보이지 않음, 다시 물으면
  달라지는 사유라 키를 따로 — 관심 대상 등록이 partial로 받음)
- 같은 화면의 두 안내(속성 칸의 '대상을 푸는 데 받지 못한 출처' = 대상 응답 errors, 공시 탭 출처 상태 줄 = 피드 dart 줄)가 같은 사유를 말함
- 저장본을 읽지 못한 풀기는 하루가 아니라 실패 캐시(60초)만 — 저장본이 돌아오면 곧 다시 풂
"""
from __future__ import annotations

import time

import pytest

from app.services import search, search_entities, search_store, search_wikidata
from app.services import search_sources as sources

_OTHER = {"900002": {"corpCode": "00900002", "name": "합성화학"}}      # 저장본을 읽었고 물은 종목(900001)은 없음 — ETF·우선주 등
_MISSING = "DART 고유번호 저장본에 이 종목이 없음"
_UNREAD = "DART 고유번호 저장본을 읽지 못함"


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    """바깥 호출은 모두 막고(부르면 실패), 저장본 읽기는 합성 값으로(DB 없음)."""
    search.reset_cache()

    def refuse(*args, **kwargs):
        raise AssertionError("시험이 바깥으로 나가려 했습니다")

    monkeypatch.setattr(search_wikidata, "api", refuse)
    monkeypatch.setattr(search_entities, "_fetch_sec_table", refuse)
    monkeypatch.setattr(search_store, "guru_names", lambda: [])
    monkeypatch.setattr(search_store, "watch_items", lambda key, owner, kinds=None: sources.Fetched(items=[]))
    monkeypatch.setattr(search_store, "user_excludes", lambda: search.rules.Excludes())
    yield
    search.reset_cache()


def _dart_row(out: dict) -> dict:
    return next(row for row in out["sources"] if row["source"] == "dart")


@pytest.mark.parametrize("external", [False, True])
def test_DART_저장본을_읽지_못하면_대상_풀기도_읽지_못함이라_적는다(monkeypatch, external):
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    out = search_entities.build("kr", "900001", external=external)
    assert out["entity"]["ids"]["dartCorpCode"] is None
    assert out["errors"] == {search_entities.DART_STORE: _UNREAD}, "읽었는데 없다고 단정하지 않음 — 다시 물으면 달라지는 사유의 키"


def test_DART_저장본을_읽었는데_종목이_없으면_이_종목이_없음(monkeypatch):
    monkeypatch.setattr(search_store, "dart_codes", lambda: dict(_OTHER))
    out = search_entities.build("kr", "900001", external=False)
    assert out["errors"] == {"dart": _MISSING}
    feed = search.feed("kr:900001", "filings", owner=False, external=True)
    row = _dart_row(feed)
    assert (row["status"], row["message"]) == ("skipped", "DART 고유번호가 없어 묻지 않음"), "읽었는데 없으면 '건너뜀'"


def test_같은_화면의_속성_칸과_공시_줄이_같은_사유를_말한다(monkeypatch):
    """화면(/search?e=kr:…&tab=filings)이 함께 부르는 대상 풀기와 공시 탭 결과 — 저장본을 읽지 못했을 때 두 안내의 사유가 같음."""
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    reason = search.entity("kr:900001", external=True)["errors"][search_entities.DART_STORE]
    row = _dart_row(search.feed("kr:900001", "filings", owner=False, external=True))
    assert row["status"] == "error"
    assert row["message"] == f"DART 고유번호를 모름 — {reason}"


def test_DART_저장본을_읽지_못한_풀기는_실패_캐시만(monkeypatch):
    """저장본을 읽지 못한 풀기를 '이 종목이 없음'처럼 하루 동안 붙들지 않음 — 실패가 섞인 결과의 60초 캐시."""
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    search.entity("kr:900001", external=True)
    until, _ = search._cache[("entity", "kr:900001", True)]
    assert until - time.monotonic() <= search.FAILURE_TTL


# ------------------------------------------------------------------ Wikidata 항목(wd:)으로 연 국내 상장사(QA-429 검토 지적)

def _claim(qid: str, ticker: str | None = None) -> dict:
    claim = {"mainsnak": {"snaktype": "value", "datavalue": {"value": {"entity-type": "item", "id": qid}, "type": "wikibase-entityid"}},
             "rank": "normal"}
    if ticker:
        claim["qualifiers"] = {"P249": [{"snaktype": "value", "datavalue": {"value": ticker, "type": "string"}}]}
    return claim


# 한국 거래소(Q495372)에 종목코드 900001로 상장된 합성 회사 — P31 = 상장 회사(Q891723)
_WD_KR = {"id": "Q900050", "labels": {"ko": {"language": "ko", "value": "합성전자"}}, "aliases": {}, "descriptions": {},
          "claims": {"P31": [_claim("Q891723")], "P414": [_claim("Q495372", "900001")]}}


def _use_wikidata(monkeypatch) -> None:
    def api(params):
        if params.get("action") == "wbgetentities":
            return {"entities": {qid: (_WD_KR if qid == "Q900050" else {"id": qid, "missing": ""}) for qid in params["ids"].split("|")}}
        raise AssertionError(f"모르는 요청: {params}")

    monkeypatch.setattr(search_wikidata, "api", api)


@pytest.mark.xfail(strict=True, reason="QA-429 검토 지적: 저장본을 읽지 못하면 wd: 국내 상장사가 사유 없이 국내 종목이 아닌 것처럼 하루 캐시됨")
def test_DART_저장본을_읽지_못하면_wd_국내_상장사도_모름이라_적고_실패_캐시만(monkeypatch):
    """
    한국 거래소 코드가 있는 Wikidata 항목을 저장본 없이 풀면 국내 종목인지 확인하지 못한 것 — 사유 없이 '국내 종목 아님'으로 하루 붙들지 않고
    (errors.dart_store → 60초 캐시·관심 대상 등록 partial), 공시 탭에 DART 줄을 빼지 않고 '모름'으로 둠.
    """
    _use_wikidata(monkeypatch)
    monkeypatch.setattr(search_store, "dart_codes", lambda: {})
    out = search.entity("wd:Q900050", external=True)
    assert out["entity"]["ids"]["dartCorpCode"] is None
    assert out["errors"] == {search_entities.DART_STORE: _UNREAD}
    until, _ = search._cache[("entity", "wd:Q900050", True)]
    assert until - time.monotonic() <= search.FAILURE_TTL
    row = _dart_row(search.feed("wd:Q900050", "filings", owner=False, external=True))
    assert (row["status"], row["message"]) == ("error", f"DART 고유번호를 모름 — {_UNREAD}")


def test_DART_저장본을_읽었는데_wd_항목의_코드가_없으면_사유도_DART_줄도_없다(monkeypatch):
    """대조 — 저장본을 읽었고 그 코드가 없으면(상장 폐지 등) 국내 종목이 아니라고 확인한 것: 사유 없이 하루 캐시, 공시 탭에 DART 줄 없음."""
    _use_wikidata(monkeypatch)
    monkeypatch.setattr(search_store, "dart_codes", lambda: dict(_OTHER))
    out = search.entity("wd:Q900050", external=True)
    assert out["entity"]["ids"]["market"] is None and out["errors"] == {}
    sources_ = {row["source"] for row in search.feed("wd:Q900050", "filings", owner=False, external=True)["sources"]}
    assert "dart" not in sources_
