"""
tests/test_kr_paper_flows.py
🧪 한국 책 종목별 수급 kr_paper_flows → observations kr_paper_flow + kr.paper_flows.status (v2 2단계 B4). 저장은 PostgreSQL, 토스는 가짜.

고정하는 규칙
  1. payload = 레이더 수급(toss_stock_flow)과 같은 칸 + code + fetchedAt — 토스 updatedAt(판)을 그대로 남긴다(입력 동결 K26의 근거).
     null(당일 잠정치의 개인·기관 세부)을 0으로 바꾸지 않는다.
  2. 처음 보는 종목은 100거래일(스펙 상한), 그 뒤로는 20거래일. 같은 날짜는 나중 판으로 덮는다.
  3. KR 거래일 D 20:30 KST 뒤 하루 1회 — 그 뒤에 받은 종목은 다시 부르지 않는다. D보다 늦은 날짜(오늘 장중 잠정치)는 쓰지 않는다.
  4. 일부 실패 → 기록은 지우지 않고 상태만 isStale로 잇는다. 전부 실패 → EmptyResult. 403이면 멈춘다. 기록 0건은 NO_RECORDS.
  5. 실행당 호출 예산 — 넘는 종목은 다음 주기에.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from app import catalog, krcalendar, tasks
from app.services import toss as toss_service
from app.tasks import kr_paper
from app.tasks.base import KST

NIGHT = datetime(2026, 10, 27, 21, 0, tzinfo=KST)
FIXTURE = Path(__file__).parent / "fixtures" / "toss" / "stock_investor_trading_005930.json"


def _record(day, net, updated="2026-10-27T20:21:00+09:00", individual=5):
    return {"date": day, "updatedAt": updated,
            "investors": {"foreigner": {"buy": None, "sell": None, "net": net}, "institution": {"buy": None, "sell": None, "net": net},
                          "individual": {"buy": None, "sell": None, "net": individual} if individual is not None else None,
                          "otherCorporation": None},
            "breakdown": None, "foreignerHoldingRate": None}


class FakeFlows:
    def __init__(self):
        self.records: dict[str, list[dict]] = {}
        self.errors: dict[str, Exception] = {}
        self.calls: list[tuple[str, int]] = []

    def fetch(self, code, count=20):
        self.calls.append((code, count))
        if code in self.errors:
            raise self.errors[code]
        return [r for r in self.records.get(code, [])][:count]


@pytest.fixture()
def flows(monkeypatch):
    fake = FakeFlows()
    monkeypatch.setattr(kr_paper.toss_service, "fetch_stock_investor_trading", fake.fetch)
    monkeypatch.setattr(kr_paper, "KR_FLOW_SPACING", 0)
    monkeypatch.setattr(kr_paper, "_now", lambda: NIGHT)
    monkeypatch.setattr(krcalendar, "_holidays", set())
    return fake


def _scope(monkeypatch, codes):
    monkeypatch.setattr(kr_paper, "kr_scope", lambda: (list(codes), "2026-10-26"))


def _status(store):
    return store.read_snapshot(catalog.SNAP_KR_PAPER_FLOWS_STATUS).payload


def test_수급은_레이더와_같은_칸에_받은_시각을_더하고_null을_지킨다(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930"])
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))["result"]["records"]
    normalized = [toss_service.normalize_stock_record(r) for r in raw]
    flows.records["005930"] = normalized

    detail = tasks.task_kr_paper_flows()

    rows = {r["date"]: r for r in store.read_observations(catalog.OBS_KR_PAPER_FLOW)}
    first = normalized[0]
    saved = rows[first["date"]]
    assert {k: v for k, v in saved.items() if k not in ("code", "fetchedAt", "obsDate")} == first
    assert saved["code"] == "005930" and datetime.fromisoformat(saved["fetchedAt"]) == NIGHT
    assert saved["investors"]["individual"] is None and saved["breakdown"] is None     # 당일 잠정치의 null은 0이 아님
    status = _status(store)
    assert status["session"] == "2026-10-27" and status["scope"] == ["005930"]
    entry = status["codes"]["005930"]
    assert entry["status"] == "OK" and entry["records"] == len(normalized)
    assert entry["latestDate"] == max(r["date"] for r in normalized)
    assert flows.calls == [("005930", kr_paper.KR_FLOW_FIRST_DAYS)]
    assert detail == f"세션 2026-10-27 · 1/1 종목 · {len(normalized)}건 · 호출 1회"


def test_처음은_100거래일_다음부터는_20거래일이고_같은_날짜는_나중_판으로_덮는다(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930"])
    flows.records["005930"] = [_record("2026-10-27", 10, "2026-10-27T15:35:00+09:00"), _record("2026-10-26", 7)]
    tasks.task_kr_paper_flows()

    monkeypatch.setattr(kr_paper, "_now", lambda: datetime(2026, 10, 28, 21, 0, tzinfo=KST))
    flows.records["005930"] = [_record("2026-10-28", 3, "2026-10-28T20:22:00+09:00"),
                               _record("2026-10-27", 11, "2026-10-28T06:50:00+09:00")]
    tasks.task_kr_paper_flows()

    assert [count for _code, count in flows.calls] == [100, 20]
    day = {r["obsDate"]: r for r in store.read_observations(catalog.OBS_KR_PAPER_FLOW)}
    assert day["2026-10-27"]["investors"]["foreigner"]["net"] == 11
    assert day["2026-10-27"]["updatedAt"] == "2026-10-28T06:50:00+09:00"      # 판(updatedAt)을 그대로
    assert set(day) == {"2026-10-26", "2026-10-27", "2026-10-28"}


def test_그날_받았으면_다시_부르지_않고_20시30분_전_장중_기록은_버린다(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930"])
    flows.records["005930"] = [_record("2026-10-27", 1, "2026-10-27T13:00:00+09:00", individual=None),
                               _record("2026-10-26", 7)]
    monkeypatch.setattr(kr_paper, "_now", lambda: datetime(2026, 10, 27, 13, 5, tzinfo=KST))

    tasks.task_kr_paper_flows()
    assert [r["obsDate"] for r in store.read_observations(catalog.OBS_KR_PAPER_FLOW)] == ["2026-10-26"]
    assert _status(store)["session"] == "2026-10-26"

    flows.calls.clear()
    assert tasks.task_kr_paper_flows() == "최신 상태 (세션 2026-10-26, 1종목, 호출 0회)"
    assert flows.calls == []


def test_일부_실패는_기록을_지우지_않고_상태만_잇는다(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930", "000660"])
    for code in ("005930", "000660"):
        flows.records[code] = [_record("2026-10-27", 1)]
    tasks.task_kr_paper_flows()

    monkeypatch.setattr(kr_paper, "_now", lambda: datetime(2026, 10, 28, 21, 0, tzinfo=KST))
    flows.errors["000660"] = toss_service.TossError("HTTP 500")
    flows.records["005930"] = [_record("2026-10-28", 2)]
    detail = tasks.task_kr_paper_flows()

    status = _status(store)["codes"]
    assert status["000660"]["isStale"] is True and "HTTP 500" in status["000660"]["staleReason"]
    assert status["005930"]["latestDate"] == "2026-10-28" and "isStale" not in status["005930"]
    assert {(r["obsDate"], r["code"]) for r in store.read_observations(catalog.OBS_KR_PAPER_FLOW)} == {
        ("2026-10-27", "005930"), ("2026-10-27", "000660"), ("2026-10-28", "005930")}
    assert "1/2 종목" in detail and "이전 값 1개(000660)" in detail


def test_전부_실패하면_EmptyResult(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930"])
    flows.errors["005930"] = toss_service.TossError("HTTP 503")
    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_flows()
    assert "0/1 종목" in str(exc.value) and "HTTP 503" in str(exc.value)
    assert store.read_snapshot(catalog.SNAP_KR_PAPER_FLOWS_STATUS) is None


def test_403이면_멈추고_키가_없으면_EmptyResult(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930", "000660", "035420"])
    flows.records["005930"] = [_record("2026-10-27", 1)]
    flows.errors["000660"] = toss_service.TossForbidden("HTTP 403 — 허용 IP")

    detail = tasks.task_kr_paper_flows()

    assert [code for code, _ in flows.calls] == ["005930", "000660"]
    assert "1/3 종목" in detail and "허용 IP" in detail

    flows.errors = {"005930": toss_service.TossMissingKey("TOSS_CLIENT_ID / TOSS_CLIENT_SECRET이 설정되지 않았습니다")}
    monkeypatch.setattr(kr_paper, "_now", lambda: datetime(2026, 10, 28, 21, 0, tzinfo=KST))
    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_flows()
    assert "TOSS_CLIENT_ID" in str(exc.value)


def test_기록이_0건이면_응답에_없음(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930", "999990"])
    flows.records["005930"] = [_record("2026-10-27", 1)]

    detail = tasks.task_kr_paper_flows()

    entry = _status(store)["codes"]["999990"]
    assert entry["status"] == "NO_RECORDS" and entry["records"] == 0 and entry["latestDate"] is None
    assert "2/2 종목(기록 없음 1)" in detail


def test_예산이_모자라면_나머지는_다음_주기(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930", "000660"])
    for code in ("005930", "000660"):
        flows.records[code] = [_record("2026-10-27", 1)]
    monkeypatch.setattr(kr_paper, "KR_FLOWS_CALL_BUDGET", 1)

    detail = tasks.task_kr_paper_flows()
    assert "1/2 종목" in detail and "호출 예산 소진" in detail

    monkeypatch.setattr(kr_paper, "KR_FLOWS_CALL_BUDGET", 200)
    flows.calls.clear()
    tasks.task_kr_paper_flows()
    assert [code for code, _ in flows.calls] == ["000660"]
    assert set(_status(store)["codes"]) == {"005930", "000660"}


def test_보존_기간이_지난_수급_행은_지운다(store, flows, monkeypatch):
    _scope(monkeypatch, ["005930"])
    store.put_observations(catalog.OBS_KR_PAPER_FLOW, "2025-01-02", [{"code": "005930"}], entity_key="code")
    flows.records["005930"] = [_record("2026-10-27", 1)]

    tasks.task_kr_paper_flows()

    assert [r["obsDate"] for r in store.read_observations(catalog.OBS_KR_PAPER_FLOW)] == ["2026-10-27"]


def test_시간_상한은_slow_상한보다_짧다():
    assert kr_paper.KR_FLOWS_TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]


def test_slow에서_관측치_바로_뒤에_돌고_태스크는_34개():
    task = tasks.TASKS_BY_NAME["kr_paper_flows"]
    assert task.speed == "slow" and task.run is kr_paper.task_kr_paper_flows
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("kr_paper_flows") == names.index("kr_paper_quotes") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 34
