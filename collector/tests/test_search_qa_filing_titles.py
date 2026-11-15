"""
tests/test_search_qa_filing_titles.py
정보 검색 공시 줄 제목(services/search_filings — 계약 §7-2)의 다음 회차 결함 — 네트워크·DB 없이 합성 응답·합성 행으로.

- QA-451: 운영 화면 확인(2026-11-15)에서 드문 SEC 양식(F-N·F-3ASR·N-PX·S-8·IRANNOTICE)은 설명이 비면 양식 기호만 보였고, Form 3·4·5 줄은 모두
  '4 · 지분 변동 보고'라 누구·어느 회사의 보고인지 제목으로 가를 수 없었음. 받은 자료에 있는 이름만 씀 — EDGAR 전문 검색 줄은 같은 접수의 이름
  (``display_names``)을 모두 받으므로 그 이름을 제목에 싣고, 회사별 목록(submissions)에는 상대 이름 칸이 없어 SEC를 더 부르지 않음.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.services import search_filings, search_store

CIK = "0009000001"
NOW = datetime(2026, 11, 15, 5, 0, tzinfo=timezone.utc)


def _submissions(rows):
    columns = ("accessionNumber", "filingDate", "reportDate", "acceptanceDateTime", "form", "primaryDocDescription")
    recent = {column: [row.get(column, "") for row in rows] for column in columns}
    return {"cik": "9000001", "name": "SYNTHETIC FINANCIAL GROUP INC", "filings": {"recent": recent, "files": []}}


def _fts(*hits):
    return {"hits": {"total": {"value": len(hits), "relation": "eq"},
                     "hits": [{"_id": f"{hit['adsh']}:doc.xml", "_source": hit} for hit in hits]}}


def _hit(adsh, form, *names, ciks=("0009000077",)):
    return {"adsh": adsh, "ciks": list(ciks), "display_names": list(names), "file_date": "2026-11-02", "form": form,
            "root_forms": [form]}


OWNER = "Synthetic Owner Jane  (CIK 0009000077)"
ISSUER_A = "SYNTHCHIP CORP  (SYNC)  (CIK 0009000088)"
ISSUER_B = "SYNTHBANK GROUP INC  (SYNB, SYNB-PA)  (CIK 0009000099)"


@pytest.mark.xfail(strict=True, reason="QA-451: 수정 전 실패 — 드문 양식은 뜻 없이 양식 기호만")
def test_QA451_드문_SEC_양식에도_짧은_뜻을_붙인다():
    forms = [("F-N", ""), ("F-3ASR", "FORM F-3 ASR"), ("N-PX", ""), ("S-8", "S-8"), ("IRANNOTICE", ""), ("N-PX/A", "")]
    rows = [{"accessionNumber": f"0009000001-26-{n:06d}", "filingDate": "2026-11-10", "form": form, "primaryDocDescription": described}
            for n, (form, described) in enumerate(forms)]
    items, _ = search_filings.parse_submissions(_submissions(rows), cik=CIK, start_day="2024-11-15")
    assert [item["title"] for item in items] == [
        "F-N · 외국 금융기관의 송달 대리인 지정",
        "F-3ASR · 외국 기업 일괄 증권 신고서(자동 효력)",
        "N-PX · 연간 의결권 행사 기록",
        "S-8 · 임직원 보상 계획 증권 신고서",
        "IRANNOTICE · 이란 관련 활동 공시 통지",
        "N-PX/A · 연간 의결권 행사 기록 수정",
    ]


@pytest.mark.xfail(strict=True, reason="QA-451: 수정 전 실패 — 전문 검색의 Form 4 줄이 첫 이름(보고자)만 실어 발행사가 다른 줄을 가를 수 없음")
def test_QA451_전문_검색의_지분_보고_줄은_같은_접수의_다른_이름도_싣는다():
    payload = _fts(
        _hit("0009000077-26-000001", "4", OWNER, ISSUER_A, ciks=("0009000077", "0009000088")),
        _hit("0009000077-26-000002", "4", OWNER, ISSUER_B, ciks=("0009000077", "0009000099")),
        _hit("0009000077-26-000003", "3/A", OWNER, ISSUER_A, ciks=("0009000077", "0009000088")),
    )
    items, _, _ = search_filings.parse_fts(payload)
    assert [item["title"] for item in items] == [
        "4 · 지분 변동 보고 · Synthetic Owner Jane · SYNTHCHIP CORP",
        "4 · 지분 변동 보고 · Synthetic Owner Jane · SYNTHBANK GROUP INC",
        "3/A · 최초 지분 보고 수정 · Synthetic Owner Jane · SYNTHCHIP CORP",
    ]
    assert {item["publisher"] for item in items} == {"Synthetic Owner Jane"}, "매체 칸은 그대로 첫 이름"


@pytest.mark.xfail(strict=True, reason="QA-451: 수정 전 실패 — 모은 전문 검색 줄의 제목을 첫 이름으로만 다시 만들어 다른 이름을 지움")
def test_QA451_모은_전문_검색_줄은_읽을_때_다른_이름을_지킨다(monkeypatch):
    sec_url = "https://www.sec.gov/Archives/edgar/data/9000077/000900007726000001/0009000077-26-000001-index.htm"
    stored = "4 · 지분 변동 보고 · Synthetic Owner Jane · SYNTHCHIP CORP"
    row = {"item_id": "f1", "kind": "filing", "title": stored, "url": sec_url, "publisher": "Synthetic Owner Jane",
           "publisher_domain": "sec.gov", "source": "sec_fts", "lang": "en", "summary": None, "published_at": NOW,
           "first_seen_at": NOW}
    monkeypatch.setattr(search_store, "_watch_rows", lambda key, kinds: [row])
    items = search_store.watch_items("wd:Q900077", owner=True).items
    assert [item["title"] for item in items] == [stored]
