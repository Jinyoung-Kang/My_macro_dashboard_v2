"""
tests/test_kr_calendar.py
한국 거시 일정(태스크 kr_calendar, v2 2단계 명세 §4-11·K20·B9) — 한국 책 Claude 계좌 패킷 1b_calendar의 원자료.

고정하는 규칙
  1. 금통위 2026년 8회 상수(한국은행 페이지 2026-10-26 확인), 끝 11-26. 수집 창(KST 오늘부터 45일) 끝이 넘으면 '갱신 필요' + 2027 미게시 메모.
  2. 주요 발표(소비자물가·고용·GDP 속보·경상수지·수출입)는 날짜를 옮기기 전이라 모두 '일정 미확인' — 날짜를 지어내지 않는다(G8).
     날짜를 옮기면 창 안의 날짜가 events에 들고, 옮긴 범위 끝을 넘으면 '갱신 필요'.
  3. 한국 실적·컨센서스는 null + 사유(빈 목록이 아님). 외부 호출이 없고 실행마다 저장본을 다시 쓴다.
  4. 날짜는 KST — 서버 TZ(UTC) 날짜와 다를 때도 KST 오늘부터.

태스크 테스트는 PostgreSQL이 필요합니다(store 픽스처, macrodash_test).
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
import requests

from app import catalog, tasks
from app.services import kr_calendar as svc
from app.tasks import kr_calendar as task_module

NOW = datetime(2026, 10, 27, 13, 0, tzinfo=timezone.utc)   # 10-27 22:00 KST


@pytest.fixture()
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(task_module, "_now", lambda: moment["now"])

    def no_network(*args, **kwargs):
        raise AssertionError("kr_calendar가 외부로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return moment


def _payload(store) -> dict:
    return store.read_snapshot(catalog.SNAP_KR_CALENDAR).payload


def test_weekly에서_공휴일_바로_뒤에_돌고_태스크는_35개():
    task = tasks.TASKS_BY_NAME["kr_calendar"]
    assert task.speed == "weekly" and task.run is task_module.task_kr_calendar
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("kr_calendar") == names.index("kr_holidays") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 35


def test_데이터셋_이름():
    assert catalog.SNAP_KR_CALENDAR == "calendar.kr_events"


def test_금통위_2026_상수():
    assert svc.BOK_MPB_MEETINGS == ("2026-01-15", "2026-02-26", "2026-04-10", "2026-05-28", "2026-07-16", "2026-08-27",
                                    "2026-10-22", "2026-11-26")
    assert svc.BOK_MPB_THROUGH == "2026-11-26" and svc.BOK_MPB_CHECKED_AT == "2026-10-26"
    weekdays = [date.fromisoformat(day).isoweekday() for day in svc.BOK_MPB_MEETINGS]
    assert weekdays == [4, 4, 5, 4, 4, 4, 4, 4]   # 04-10만 금요일
    assert svc.BOK_MPB_SOURCE.startswith("https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/")


def test_주요_발표는_모두_일정_미확인이고_날짜를_지어내지_않는다():
    assert [(r.key, r.name, r.agency) for r in svc.KR_RELEASES] == [
        ("CPI", "소비자물가동향", "국가데이터처"),
        ("EMPLOYMENT", "고용동향", "국가데이터처"),
        ("GDP", "실질 국내총생산(속보)", "한국은행"),
        ("CURRENT_ACCOUNT", "국제수지(잠정) — 경상수지", "한국은행"),
        ("TRADE", "수출입동향", "산업통상부"),
    ]
    assert all(r.dates == () and r.checked_at is None and r.through is None for r in svc.KR_RELEASES)
    assert {svc.release_status(r, date(2026, 12, 31)) for r in svc.KR_RELEASES} == {"일정 미확인"}


def test_창_안의_금통위만_싣고_상수_끝을_넘으면_갱신_필요(store, clock):
    detail = task_module.task_kr_calendar()

    payload = _payload(store)
    macro = payload["macro"]
    assert macro["horizon"] == {"from": "2026-10-27", "to": "2026-12-11"}
    assert macro["events"] == [
        {"name": "금통위 통화정책방향 결정", "date": "2026-11-26", "kind": "MPB", "source": svc.BOK_MPB_SOURCE}]
    assert macro["bok"] == {
        "source": svc.BOK_MPB_SOURCE,
        "checkedAt": "2026-10-26",
        "through": "2026-11-26",
        "status": "갱신 필요",
        "note": "2027 일정 미게시 — 한국은행 통화정책방향 결정회의 일정의 2027 표가 비어 있음(2026-10-26 확인)",
    }
    assert macro["unconfirmed"] == ["CPI", "EMPLOYMENT", "GDP", "CURRENT_ACCOUNT", "TRADE"]
    assert macro["releases"]["GDP"] == {
        "name": "실질 국내총생산(속보)", "agency": "한국은행", "source": svc.BOK_STATS_SCHEDULE, "checkedAt": None,
        "through": None, "status": "일정 미확인", "note": svc.UNCONFIRMED_NOTE}
    # 실적·컨센서스는 빈 목록이 아니라 null + 사유입니다(빈 목록은 0건으로 읽힘).
    assert (payload["earnings"], payload["earningsNote"]) == (None, "한국 실적 발표 일정 출처 없음")
    assert (payload["consensus"], payload["consensusNote"]) == (None, "한국 컨센서스 출처 없음")
    assert payload["generatedAt"] == "2026-10-27T13:00:00+00:00"
    assert detail == ("금통위 1회 · 주요 발표 0건(확인 0/5종) · 창 2026-10-27~2026-12-11 · 외부 호출 없음 · "
                      "갱신 필요: 금통위(상수 끝 2026-11-26 뒤 미게시) · "
                      "일정 미확인: 소비자물가동향, 고용동향, 실질 국내총생산(속보), 국제수지(잠정) — 경상수지, 수출입동향")


def test_창_끝이_상수_안이면_ok(store, clock):
    clock["now"] = datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc)
    task_module.task_kr_calendar()

    macro = _payload(store)["macro"]
    assert macro["horizon"] == {"from": "2026-09-10", "to": "2026-10-25"}
    assert [event["date"] for event in macro["events"]] == ["2026-10-22"]
    assert macro["bok"]["status"] == "ok"


def test_창은_KST_오늘부터(store, clock):
    # 11-26 15:30 UTC = 11-27 00:30 KST — UTC 날짜(11-26)로 보면 11-26 금통위가 들지만 KST로는 이미 지남.
    clock["now"] = datetime(2026, 11, 26, 15, 30, tzinfo=timezone.utc)
    task_module.task_kr_calendar()

    macro = _payload(store)["macro"]
    assert macro["horizon"]["from"] == "2026-11-27" and macro["events"] == []


def test_발표일을_옮기면_창_안의_날짜가_들고_범위_끝을_넘으면_갱신_필요(store, clock, monkeypatch):
    cpi = svc.KrRelease("CPI", "소비자물가동향", "국가데이터처", "공표일정", dates=("2026-11-03", "2026-12-02"),
                        checked_at="2026-10-28", through="2026-12-02")
    trade = svc.KrRelease("TRADE", "수출입동향", "산업통상부", "일정", dates=("2026-11-01", "2027-01-01"),
                          checked_at="2026-10-28", through="2027-01-01")
    monkeypatch.setattr(svc, "KR_RELEASES", (cpi, trade))

    detail = task_module.task_kr_calendar()

    macro = _payload(store)["macro"]
    assert [(event["date"], event["kind"], event.get("key")) for event in macro["events"]] == [
        ("2026-11-01", "RELEASE", "TRADE"), ("2026-11-03", "RELEASE", "CPI"), ("2026-11-26", "MPB", None),
        ("2026-12-02", "RELEASE", "CPI")]
    assert macro["events"][0] == {"name": "수출입동향", "key": "TRADE", "date": "2026-11-01", "kind": "RELEASE",
                                  "agency": "산업통상부", "source": "일정"}
    assert macro["releases"]["CPI"]["status"] == "갱신 필요"     # 창 끝 12-11 > 12-02
    assert macro["releases"]["TRADE"]["status"] == "ok"          # 2027-01-01까지 옮김
    assert "note" not in macro["releases"]["CPI"] and macro["unconfirmed"] == []
    assert "주요 발표 3건(확인 2/2종)" in detail and "갱신 필요: 금통위(상수 끝 2026-11-26 뒤 미게시), 소비자물가동향" in detail


def test_실행마다_다시_쓴다(store, clock):
    store.put_snapshot(catalog.SNAP_KR_CALENDAR, {"marker": "이전"})
    task_module.task_kr_calendar()
    assert "marker" not in _payload(store)
