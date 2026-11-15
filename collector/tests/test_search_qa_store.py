"""
tests/test_search_qa_store.py
정보 검색 운영 화면 점검(2026-11-15)에서 찾은 저장본 출처의 결함 — services/search_store·search_filings. DB 없이 읽는 함수를 바꿔 끼워 봅니다
(합성 행 — 실제 계좌·운영 자료 없음).

- QA-438: 수집 글·속보의 언어는 화면이 보이는 원문 제목으로 가름(번역 제목 title_ko가 아님) — 모은 글에 이미 들어간 줄도 읽을 때 같은 규칙
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone

import pytest

from app import store
from app.services import search_store

NOW = datetime(2026, 11, 15, 5, 0, tzinfo=timezone.utc)


def _info_row(item_id, *, title, title_ko=None, source="blog.abnormalreturns", kind="article", summary=None):
    return {"id": item_id, "source": source, "kind": kind, "url": f"https://blog.example.org/{item_id}", "title": title,
            "title_ko": title_ko, "published_at": NOW, "first_seen_at": NOW, "summary": summary}


def _watch_row(item_id, *, title, source, kind="news", lang="en", publisher="Example", published_at=NOW, url=None):
    return {"item_id": item_id, "kind": kind, "title": title, "url": url or f"https://www.example.org/{item_id}",
            "publisher": publisher, "publisher_domain": "example.org", "source": source, "lang": lang, "summary": None,
            "published_at": published_at, "first_seen_at": NOW}


class _Conn:
    """store.connection() 자리 — 어떤 문장이든 정한 행을 돌려줍니다(문 시간 상한 설정 포함)."""

    def __init__(self, rows):
        self.rows = rows

    def execute(self, *_args, **_kwargs):
        return self

    def fetchall(self):
        return list(self.rows)


# ------------------------------------------------------------------ QA-438 언어

ENGLISH_POST = _info_row("i1", title="Longform links: synthetic demographic assumptions", title_ko="롱폼 링크: 합성 인구 가정",
                         summary="Links about synthetic demographics.")
KOREAN_POST = _info_row("i2", source="waedge.brief", kind="brief", title="합성전자 수급 정리")


@pytest.mark.xfail(strict=True, reason="QA-438: 수정 전 실패 — 수집 글의 언어를 번역 제목(title_ko)으로 정해 영어 글이 'ko'")
def test_QA438_수집_글의_언어는_화면이_보이는_원문_제목으로(monkeypatch):
    monkeypatch.setattr(search_store, "_info_rows", lambda kinds, terms: [ENGLISH_POST, KOREAN_POST])
    items = {item["readerId"]: item for item in search_store.info_posts(["synthetic", "합성전자"]).items}
    assert items["i1"]["title"] == "Longform links: synthetic demographic assumptions", "화면은 원문 제목"
    assert items["i1"]["lang"] == "en", "영어 원문에 한국어 제목이 붙어 있어도 영어"
    assert items["i2"]["lang"] == "ko"


@pytest.mark.xfail(strict=True, reason="QA-438: 수정 전 실패 — 첫 화면의 최근 속보도 번역 제목으로 언어를 정함")
def test_QA438_첫_화면의_최근_속보도_원문_제목으로(monkeypatch):
    wire_row = _info_row("w1", source="wire.financialjuice", kind="headline", title="SYNTHETIC CENTRAL BANK HOLDS RATES",
                         title_ko="합성 중앙은행 금리 동결")

    @contextmanager
    def connection():
        yield _Conn([wire_row])

    monkeypatch.setattr(store, "connection", connection)
    items = search_store.recent_wire(5).items
    assert [(item["readerId"], item["lang"]) for item in items] == [("w1", "en")]


@pytest.mark.xfail(strict=True, reason="QA-438: 수정 전 실패 — 모은 글에 이미 'ko'로 들어간 영어 수집 글이 그대로 'ko'")
def test_QA438_모은_글의_수집_글·속보_줄은_읽을_때_원문_제목으로_언어를_다시_가름(monkeypatch):
    rows = [
        _watch_row("i1", title="Longform links: synthetic demographic assumptions", source="info", kind="post", lang="ko"),
        _watch_row("w1", title="SYNTHETIC CENTRAL BANK HOLDS RATES", source="wire", kind="wire", lang="ko"),
        _watch_row("i2", title="합성전자 수급 정리", source="info", kind="post", lang="en"),
        # 뉴스 출처의 lang은 받은 판(구글 한국어 판의 영어 제목 — 계약 §9-7 묶기의 설명)이라 그대로 둡니다.
        _watch_row("g1", title="Synthetic Corp opens plant", source="google_ko", lang="ko"),
    ]
    monkeypatch.setattr(search_store, "_watch_rows", lambda key, kinds: rows)
    items = {item["id"]: item for item in search_store.watch_items("topic:Synthetic", owner=True).items}
    assert {key: item["lang"] for key, item in items.items()} == {"i1": "en", "w1": "en", "i2": "ko", "g1": "ko"}
