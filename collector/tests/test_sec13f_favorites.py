"""
tests/test_sec13f_favorites.py
13F 즐겨찾기 기관(ADR 0048) — 수집기는 백엔드 표 sec13f_favorites를 읽기만 하고, sec_13f 태스크 대상 = 기본 12곳 + 즐겨찾기(기본 12곳·트랙레코드
후보 CIK와 선행 CIK는 뺌 — 불변식 2), 단건 수집(백엔드가 더하기 때 부름)은 같은 수집·저장 길이고 실패하면 저장본을 덮지 않습니다.

외부 네트워크를 쓰지 않습니다(collect_13f를 대체합니다). PostgreSQL이 필요합니다(store 픽스처). CIK는 가짜(99억대).
"""
from __future__ import annotations

import pytest

from app import catalog, indicators, tasks
from app.tasks import filings

FAV, FAV2 = "0009900001", "0009900002"
CANDIDATE = indicators.TRACK_RECORD_FILERS[1]["cik"]
PREDECESSOR = next(p for f in indicators.TRACK_RECORD_FILERS for p in (f.get("predecessors") or ()))


def _quarter(report: str, filed: str) -> dict:
    return {"filingDate": filed, "reportDate": report, "totalValue": 100.0,
            "holdings": [{"name": "FAKE CO", "cusip": "999999991", "class": "COM", "value": 100.0, "shares": 1.0, "weight": 100.0}]}


def _favorite(store, cik: str, sec_name: str, display: str | None = None) -> None:
    with store.connection() as conn:
        conn.execute("INSERT INTO sec13f_favorites (cik, sec_name, display_name) VALUES (%s, %s, %s)", (cik, sec_name, display))


@pytest.fixture
def fake_sec(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "test@example.com")
    asked: list[str] = []
    responses: dict[str, dict] = {}

    def fake_collect(cik, quarters, previous_quarters=None):
        asked.append(cik)
        return responses.get(cik) or {"cik": cik, "error": "응답 없음", "quarters": None}

    monkeypatch.setattr(tasks.sec_service, "collect_13f", fake_collect)
    return asked, responses


def test_즐겨찾기는_표시_이름_없으면_SEC_이름_더한_차례(store):
    _favorite(store, FAV2, "SECOND FAKE LLC")
    _favorite(store, FAV, "FIRST FAKE LLC", "가짜 운용")
    assert store.sec13f_favorites() == [{"cik": FAV2, "name": "SECOND FAKE LLC"}, {"cik": FAV, "name": "가짜 운용"}]


def test_sec_13f_대상은_기본_12곳_다음_즐겨찾기_후보와_기본_CIK는_뺌(store, fake_sec, monkeypatch):
    asked, responses = fake_sec
    berkshire = next(inst for inst in indicators.INSTITUTIONS if inst["key"] == "berkshire")
    monkeypatch.setattr(tasks.indicators, "INSTITUTIONS", [berkshire], raising=False)
    for cik, name in ((FAV, "FAKE ONE"), (CANDIDATE, "CANDIDATE"), (PREDECESSOR, "OLD CIK"), (berkshire["cik"], "DUP")):
        _favorite(store, cik, name)
    responses[berkshire["cik"]] = {"cik": berkshire["cik"], "error": None, "quarters": [_quarter("2026-06-30", "2026-08-14")]}
    responses[FAV] = {"cik": FAV, "error": None, "quarters": [_quarter("2026-06-30", "2026-08-10")]}

    detail = tasks.task_sec_13f()

    assert sorted(asked) == sorted([berkshire["cik"], FAV])
    assert detail.startswith("2/2 기관")
    assert store.read_snapshot(catalog.snap_sec_13f(FAV, 8)).payload["quarters"][0]["reportDate"] == "2026-06-30"
    assert store.read_snapshot(catalog.snap_sec_13f(FAV, 1)) is not None
    # 트랙레코드 후보·선행 CIK에는 q8을 만들지 않습니다(불변식 2).
    assert store.read_snapshot(catalog.snap_sec_13f(CANDIDATE, 8)) is None
    assert store.read_snapshot(catalog.snap_sec_13f(PREDECESSOR, 8)) is None


def test_단건_수집은_그_기관만_q8_q1(store, fake_sec):
    asked, responses = fake_sec
    _favorite(store, FAV, "FAKE ONE")
    responses[FAV] = {"cik": FAV, "error": None, "quarters": [_quarter("2026-06-30", "2026-08-10"), _quarter("2026-03-31", "2026-05-12")]}

    out = filings.collect_favorite_13f("9900001")

    assert out == {"cik": FAV, "ok": True, "refused": None, "error": None, "quarters": 2, "latestReportDate": "2026-06-30"}
    assert asked == [FAV]
    assert len(store.read_snapshot(catalog.snap_sec_13f(FAV, 8)).payload["quarters"]) == 2
    assert len(store.read_snapshot(catalog.snap_sec_13f(FAV, 1)).payload["quarters"]) == 1


def test_단건_수집이_실패하면_저장본을_덮지_않는다(store, fake_sec):
    asked, _responses = fake_sec
    _favorite(store, FAV, "FAKE ONE")
    kept = {"cik": FAV, "error": None, "quarters": [_quarter("2026-06-30", "2026-08-10")]}
    store.put_snapshot(catalog.snap_sec_13f(FAV, 8), kept)

    out = filings.collect_favorite_13f(FAV)

    assert out["ok"] is False and out["error"] == "응답 없음"
    assert store.read_snapshot(catalog.snap_sec_13f(FAV, 8)).payload == kept


@pytest.mark.parametrize("cik,reason", [(CANDIDATE, "track_record"), (PREDECESSOR, "track_record"),
                                        (indicators.INSTITUTIONS[0]["cik"], "default"), (FAV2, "not_favorite")])
def test_단건_수집은_후보_기본_즐겨찾기_밖_CIK를_모으지_않는다(store, fake_sec, cik, reason):
    asked, _responses = fake_sec
    _favorite(store, CANDIDATE, "CANDIDATE")     # 표에 있어도 후보는 모으지 않음
    out = filings.collect_favorite_13f(cik)
    assert out["refused"] == reason and out["ok"] is False
    assert asked == []
    assert store.read_snapshot(catalog.snap_sec_13f(cik, 8)) is None


def test_빠진_저장본_목록에_즐겨찾기가_있다(store):
    _favorite(store, FAV, "FAKE ONE (Fake)")
    _favorite(store, CANDIDATE, "CANDIDATE")
    names = {row["name"]: row["label"] for row in store.missing_datasets()}
    assert names[catalog.snap_sec_13f(FAV, 8)] == "13F 즐겨찾기 FAKE ONE q8"
    assert catalog.snap_sec_13f(CANDIDATE, 8) not in names or "즐겨찾기" not in names[catalog.snap_sec_13f(CANDIDATE, 8)]
