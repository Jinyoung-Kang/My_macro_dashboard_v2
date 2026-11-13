"""
tests/test_bls_actuals.py
BLS 공식 발표치(태스크 us_bls_actuals — ADR 0040 '단계 2 앞당김 — BLS 공식 실제치').

고정하는 규칙
  1. 받기: 키(BLS_API_KEY)가 있으면 v2에 POST 본문 registrationkey로, 없으면 v1에 키 없이. 키는 주소·오류 글에 실리지 않는다.
     REQUEST_NOT_PROCESSED·403·429는 거부(rejected), 5xx의 Retry-After를 읽는다. JSON이 아니면 모양이 다름.
  2. 읽기: 월 값만(연평균 M13 등 건너뜀), 숫자가 아니면 None, 'preliminary' 각주, 'Database is locked' 시리즈는 잠김.
  3. 셈: 지수·시급은 전월 대비 %, 천 단위는 전월 대비 증감, 계절조정 전 지수는 전년 같은 달 대비 %, 실업률은 그대로. 앞 달이 없으면 셈하지 않음.
  4. 일정: 동부 평일 08:30·10:00 + 2~4분(주말 건너뜀, 서머타임은 동부 시각 그대로, 이미 시작한 발표 시각은 건너뜀). 처음에는 받지 않고
     2~25분 뒤로. 그 시각의 발표가 오늘 예정인데 새 달을 오늘 보지 못했거나 잠김이거나 요청이 실패하면 15~25분 뒤 한 번 더(그 시각마다 한 번).
     거부면 한 시간 뒤 이후의 다음 발표 시각. 요청은 2년 전 1월부터(1월에도 전년 대비 기준 달이 듦).
  5. 저장: 시리즈마다 최신 달·앞 달·셈·처음 본 시각(첫 수집은 null)·최근 13달. 잠김·없음은 직전 값을 잇고 isStale. 전부 못 받으면 저장본 그대로.
     Nasdaq 오늘 줄 가운데 이름이 같은 것만 대조하고, BLS 달을 오늘 처음 봤을 때만 일치 여부를 냄.

외부 네트워크를 쓰지 않습니다(가짜 세션). 태스크 시험은 PostgreSQL이 필요합니다(store 픽스처).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
import requests

from app import catalog, http, settings, tasks
from app.services import bls as svc
from app.tasks import bls_actuals as task
from app.tasks import flex
from app.tasks.base import EmptyResult

NY = ZoneInfo("America/New_York")
KEY = "k" * 32      # 가짜 키 — 비밀값 검사(gitleaks)가 진짜 키로 보지 않게 엔트로피가 낮은 값
IDS = [series.series_id for series in svc.SERIES]


def _et(year, month, day, hour, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=NY).astimezone(timezone.utc)


def _points(series_id: str, months: list[tuple[str, str]], prelim: bool = False) -> dict:
    data = []
    for month, value in months:
        year, mon = month.split("-")
        data.append({"year": year, "period": f"M{mon}", "periodName": "x", "value": value,
                     "footnotes": [{"code": "P", "text": "preliminary"}] if prelim else [{}]})
    return {"seriesID": series_id, "data": data}


def _body(overrides: dict | None = None, locked: list[str] = (), status: str = "REQUEST_SUCCEEDED") -> dict:
    """기본: 2026-10이 최신인 시리즈 11개(지수 300→303, 고용 159000→159100, 실업률 4.1, 시급 38.00, 구인 7500)."""
    base = {
        "CUSR0000SA0": [("2026-10", "303.000"), ("2026-09", "300.000")],
        "CUSR0000SA0L1E": [("2026-10", "330.330"), ("2026-09", "330.000")],
        "CUUR0000SA0": [("2026-10", "309.000"), ("2026-09", "308.000"), ("2025-10", "300.000")],
        "CUUR0000SA0L1E": [("2026-10", "318.000"), ("2025-10", "300.000")],
        "CES0000000001": [("2026-10", "159,100"), ("2026-09", "159000")],
        "LNS14000000": [("2026-10", "4.1"), ("2026-09", "4.0")],
        "CES0500000003": [("2026-10", "38.38"), ("2026-09", "38.00")],
        "WPSFD4": [("2026-10", "150.300"), ("2026-09", "150.000")],
        "WPSFD49116": [("2026-10", "140.000"), ("2026-09", "140.000")],
        "WPUFD4": [("2026-10", "151.500"), ("2025-10", "150.000")],
        "JTS000000000000000JOL": [("2026-09", "7523"), ("2026-08", "7400")],
    }
    base.update(overrides or {})
    series = [_points(sid, months) for sid, months in base.items() if sid not in locked and months]
    return {"status": status, "responseTime": 50, "message": [f"Database is locked for Series {sid}" for sid in locked],
            "Results": {"series": series}}


class _Response:
    def __init__(self, status: int, body=None, headers: dict | None = None, text: bool = False):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self._text = text

    def json(self):
        if self._text:
            raise ValueError("not json")
        return self._body

    def close(self):
        pass


class FakeBls:
    def __init__(self):
        self.reply = _Response(200, _body())
        self.calls: list[tuple[str, dict]] = []

    def session(self):
        fake = self

        class _Session:
            def post(self, url, json=None, timeout=None):
                fake.calls.append((url, json))
                if isinstance(fake.reply, BaseException):
                    raise fake.reply
                return fake.reply

        return _Session()


@pytest.fixture()
def bls(monkeypatch):
    fake = FakeBls()
    monkeypatch.setattr(svc, "get_bls_session", fake.session)
    monkeypatch.delenv("BLS_API_KEY", raising=False)

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return fake


@pytest.fixture()
def clock(monkeypatch):
    now = {"t": _et(2026, 11, 12, 8, 33)}           # 목 08:33 ET — 08:30 발표 직후
    monkeypatch.setattr(task, "_now", lambda: now["t"])
    monkeypatch.setattr(flex, "_utcnow", lambda: now["t"])
    return now


class _Edge:
    def __init__(self, upper: bool):
        self.upper = upper

    def uniform(self, a, b):
        return b if self.upper else a


# ==============================================================================
# 1. 받기 (네트워크 없음)
# ==============================================================================
def test_키가_있으면_v2에_본문으로_없으면_v1에_키_없이(bls):
    svc.fetch(IDS, 2025, 2026, KEY)
    svc.fetch(IDS, 2025, 2026, None)

    (v2_url, v2_body), (v1_url, v1_body) = bls.calls
    assert v2_url == svc.V2_URL and v2_body == {"seriesid": IDS, "startyear": "2025", "endyear": "2026", "registrationkey": KEY}
    assert v1_url == svc.V1_URL and "registrationkey" not in v1_body
    assert KEY not in v2_url, "키는 주소에 싣지 않습니다"


@pytest.mark.parametrize("reply, message, rejected, retry_after", [
    (_Response(200, _body(status="REQUEST_NOT_PROCESSED") | {"message": ["daily threshold"]}),
     "요청을 처리하지 않음 — daily threshold", True, None),
    (_Response(503, None, {"Retry-After": "120"}), "HTTP 503", False, 120.0),
    (http.SourceRejected("api.bls.gov", "HTTP 429", retry_after=600), "거부됨 — api.bls.gov HTTP 429 · 5분 동안 이 출처 호출을 멈춤", True, 600),
    (requests.ConnectionError("down"), None, False, None),
])
def test_거부와_실패(bls, reply, message, rejected, retry_after):
    bls.reply = reply
    with pytest.raises(svc.BlsFetchError) as caught:
        svc.fetch(IDS, 2025, 2026, KEY)
    if message is not None:
        assert str(caught.value) == message
    assert (caught.value.rejected, caught.value.retry_after) == (rejected, retry_after)
    assert KEY not in str(caught.value)


def test_JSON이_아니거나_모르는_상태면_모양이_다름(bls):
    bls.reply = _Response(200, text=True)
    with pytest.raises(svc.BlsShapeError, match="JSON이 아님"):
        svc.fetch(IDS, 2025, 2026, None)
    bls.reply = _Response(200, {"status": "WHAT", "message": []})
    with pytest.raises(svc.BlsShapeError, match="모르는 상태"):
        svc.fetch(IDS, 2025, 2026, None)


# ==============================================================================
# 2·3. 읽기와 셈
# ==============================================================================
def test_월_값만_읽고_잠김과_예비치를_가린다():
    body = _body(locked=["WPSFD4"], overrides={
        "LNS14000000": [("2026-10", "4.1"), ("2026-09", "-")],
        "CES0000000001": [],
    })
    body["Results"]["series"].append({"seriesID": "CUSR0000SA0L1E", "data": [{"year": "2025", "period": "M13", "value": "1"}]})
    body["Results"]["series"].append(_points("CES0500000003", [("2026-11", "38.50")], prelim=True))
    parsed = svc.parse(body, IDS)

    assert parsed.locked == ["WPSFD4"] and parsed.missing == ["CES0000000001"]
    assert parsed.points["LNS14000000"][1] == {"month": "2026-09", "value": None, "preliminary": False}
    assert all(point["month"] != "2025-13" for point in parsed.points["CUSR0000SA0L1E"])
    assert parsed.points["CES0500000003"][0] == {"month": "2026-11", "value": 38.5, "preliminary": True}


def test_셈은_단위마다_다르고_앞_달이_없으면_셈하지_않는다():
    parsed = svc.parse(_body(), IDS)
    by_key = {series.key: task.derived(series, parsed.points[series.series_id]) for series in svc.SERIES}
    assert by_key["cpi"] == {"momPct": 1.0}
    assert by_key["core_cpi"] == {"momPct": 0.1}
    assert by_key["cpi_nsa"] == {"yoyPct": 3.0}
    assert by_key["nonfarm_payrolls"] == {"change": 100.0}
    assert by_key["unemployment_rate"] == {}
    assert by_key["avg_hourly_earnings"] == {"momPct": 1.0}
    assert by_key["jolts_openings"] == {"change": 123.0}
    gap = svc.SERIES_BY_ID["CUSR0000SA0"]
    assert task.derived(gap, [{"month": "2026-10", "value": 303.0, "preliminary": False},
                              {"month": "2026-08", "value": 300.0, "preliminary": False}]) == {}


# ==============================================================================
# 4. 일정 (DB 없음)
# ==============================================================================
@pytest.mark.parametrize("after, expected", [
    (_et(2026, 11, 12, 7, 0), _et(2026, 11, 12, 8, 32)),       # 목 아침 → 그날 08:30 + 2분
    (_et(2026, 11, 12, 8, 40), _et(2026, 11, 12, 10, 2)),      # 08:30 뒤 → 10:00 + 2분
    (_et(2026, 11, 13, 10, 5), _et(2026, 11, 16, 8, 32)),      # 금 10:00 뒤 → 월 08:30(주말 건너뜀)
    (_et(2026, 10, 30, 10, 5), _et(2026, 11, 2, 8, 32)),       # 서머타임이 끝난 주말을 지나도 동부 08:30
    (_et(2026, 11, 12, 8, 31), _et(2026, 11, 12, 10, 2)),      # 08:30 창 안(2~4분 전) — 같은 시각을 다시 잡지 않음
])
def test_다음_발표_시각은_동부_평일_08시30분과_10시(monkeypatch, after, expected):
    monkeypatch.setattr(task, "_rng", _Edge(upper=False))
    assert task.next_slot(after) == expected


def test_실행이_속한_발표_시각():
    assert task.slot_of(_et(2026, 11, 12, 8, 33)) == ("08:30", ("CPI", "EMPLOYMENT", "PPI"))
    assert task.slot_of(_et(2026, 11, 12, 10, 20)) == ("10:00", ("JOLTS",))
    assert task.slot_of(_et(2026, 11, 12, 13, 0)) == ("other", ())
    assert task.slot_of(_et(2026, 11, 14, 8, 33)) == ("other", ())      # 토


# ==============================================================================
# 4·5. 태스크 (PostgreSQL)
# ==============================================================================
def _status(store) -> dict:
    return store.read_snapshot(catalog.SNAP_US_BLS_ACTUALS).payload


def _due(clock) -> None:
    flex.set_due(task.TASK_NAME, task.SCHEDULE_ITEM, clock["t"] - timedelta(seconds=1))


def test_처음에는_받지_않고_2_25분_뒤로_정한다(store, bls, clock):
    assert task.due() is True
    with pytest.raises(EmptyResult, match="일정 처음 정함 — 첫 요청 .* 외부 호출 0회"):
        task.task_us_bls_actuals()
    assert bls.calls == []
    when = flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM]
    assert timedelta(minutes=2) <= when - clock["t"] <= timedelta(minutes=25)
    assert task.due() is False
    with pytest.raises(EmptyResult, match="아직 때가 아님"):
        task.task_us_bls_actuals()
    assert bls.calls == []


def test_첫_수집은_처음_본_시각을_모르고_다음_달부터_적는다(store, bls, clock, monkeypatch):
    monkeypatch.setenv("BLS_API_KEY", KEY)
    _due(clock)
    detail = task.task_us_bls_actuals()

    assert (bls.calls[-1][1]["startyear"], bls.calls[-1][1]["endyear"]) == ("2024", "2026"), "2년 전 1월부터"
    status = _status(store)
    assert (status["api"], status["keyConfigured"]) == ("v2", True)
    assert KEY not in str(status) and KEY not in detail
    cpi = status["series"]["cpi"]
    assert (cpi["month"], cpi["value"], cpi["previousMonth"], cpi["derived"], cpi["firstSeenAt"]) == ("2026-10", 303.0, "2026-09",
                                                                                                    {"momPct": 1.0}, None)
    assert status["releases"]["CPI"] == {"month": "2026-10", "firstSeenAt": None}
    assert detail.startswith("BLS 시리즈 11/11 · v2")

    # 다음 날 CPI 새 달(11월)이 보이면 처음 본 시각을 적습니다.
    clock["t"] = _et(2026, 12, 10, 8, 33)
    bls.reply = _Response(200, _body({"CUSR0000SA0": [("2026-11", "306.030"), ("2026-10", "303.000")]}))
    _due(clock)
    detail = task.task_us_bls_actuals()
    stamp = clock["t"].isoformat(timespec="seconds")
    status = _status(store)
    assert status["series"]["cpi"]["firstSeenAt"] == stamp and status["releases"]["CPI"]["firstSeenAt"] == stamp
    assert status["series"]["core_cpi"]["firstSeenAt"] is None, "같은 달이면 앞 값을 이음"
    assert "새 달: CPI 2026-11" in detail


def test_오늘_예정인_발표가_아직이면_15_25분_뒤_한_번_더(store, bls, clock):
    _due(clock)
    task.task_us_bls_actuals()                               # 기준(10월)
    clock["t"] = _et(2026, 12, 10, 8, 33)
    store.put_snapshot(catalog.SNAP_US_CALENDAR, {"macro": {"events": [
        {"name": "CPI", "date": "2026-12-10", "kind": "RELEASE", "releaseId": 10}]}})
    _due(clock)
    detail = task.task_us_bls_actuals()                      # 아직 10월 그대로

    retry_at = flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM]
    assert timedelta(minutes=15) <= retry_at - clock["t"] <= timedelta(minutes=25)
    assert "다시 묻기(CPI 아직)" in detail and _status(store)["lastRun"]["waiting"] == ["CPI"]

    clock["t"] = retry_at
    task.task_us_bls_actuals()                               # 다시 물어도 아직 — 그 시각에는 더 묻지 않음
    run = _status(store)["lastRun"]
    assert run["retry"] is True and run["waiting"] == []
    assert flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM] > _et(2026, 12, 10, 10, 0)


def test_잠긴_시리즈는_직전_값을_잇고_다시_묻는다(store, bls, clock):
    _due(clock)
    task.task_us_bls_actuals()
    clock["t"] = _et(2026, 12, 11, 8, 33)
    bls.reply = _Response(200, _body(locked=["WPSFD4", "WPSFD49116", "WPUFD4"]))
    _due(clock)
    detail = task.task_us_bls_actuals()

    ppi = _status(store)["series"]["ppi_final_demand"]
    assert (ppi["status"], ppi["isStale"], ppi["month"]) == ("locked", True, "2026-10")
    assert "잠김 3개" in detail and "다시 묻기(PPI 아직)" in detail


def test_거부되면_한_시간_뒤_이후의_다음_발표_시각으로_저장본은_그대로(store, bls, clock):
    _due(clock)
    task.task_us_bls_actuals()
    before = _status(store)
    bls.reply = http.SourceRejected("api.bls.gov", "HTTP 429", retry_after=4 * 3600)
    clock["t"] = _et(2026, 12, 10, 8, 33)
    _due(clock)
    with pytest.raises(EmptyResult, match="BLS 받지 못함 — 거부됨"):
        task.task_us_bls_actuals()
    assert _status(store) == before
    assert flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM] >= clock["t"] + timedelta(hours=4)


def test_전부_못_받으면_저장본을_쓰지_않는다(store, bls, clock):
    bls.reply = _Response(200, _body(locked=IDS))
    _due(clock)
    with pytest.raises(EmptyResult, match="BLS 시리즈 0/11"):
        task.task_us_bls_actuals()
    assert store.read_snapshot(catalog.SNAP_US_BLS_ACTUALS) is None


def test_Nasdaq_오늘_줄과_이름이_같은_것만_대조한다(store, bls, clock):
    _due(clock)
    task.task_us_bls_actuals()
    clock["t"] = _et(2026, 12, 10, 8, 33)
    bls.reply = _Response(200, _body({"CUSR0000SA0": [("2026-11", "306.030"), ("2026-10", "303.000")],
                                      "CES0000000001": [("2026-11", "159219"), ("2026-10", "159100")]}))
    store.put_snapshot(catalog.SNAP_US_CONSENSUS, {"days": {"2026-12-10": {"rows": [
        {"name": "CPI", "actual": 1.0, "unit": "%", "actualText": "1.0%"},
        {"name": "Nonfarm Payrolls", "actual": 150.0, "unit": "K", "actualText": "150K"},
        {"name": "CPI YoY", "actual": 3.0, "unit": "%", "actualText": "3.0%"},
        {"name": "Unemployment Rate", "actual": None, "unit": None, "actualText": None},
    ]}}})
    _due(clock)
    detail = task.task_us_bls_actuals()

    checks = {check["name"]: check for check in _status(store)["checks"]}
    assert set(checks) == {"CPI", "Nonfarm Payrolls", "Unemployment Rate"}, "이름이 표와 똑같은 줄만"
    assert (checks["CPI"]["blsValue"], checks["CPI"]["agree"]) == (1.0, True)
    assert (checks["Nonfarm Payrolls"]["blsValue"], checks["Nonfarm Payrolls"]["agree"]) == (119.0, False)
    assert checks["Unemployment Rate"]["agree"] is None, "실업률은 오늘 새 달이 아님·Nasdaq 값 없음"
    assert "Nasdaq 대조 1/2 일치" in detail


def test_flex에_등록되고_키_이름은_BLS_API_KEY(monkeypatch):
    registered = tasks.TASKS_BY_NAME["us_bls_actuals"]
    assert registered.speed == flex.SPEED and registered.run is task.task_us_bls_actuals and registered.due is task.due
    monkeypatch.setenv("BLS_API_KEY", "  abc  ")
    assert settings.bls_key() == "abc"
    monkeypatch.delenv("BLS_API_KEY")
    assert settings.bls_key() == ""
    assert catalog.SNAP_US_BLS_ACTUALS == "calendar.us_bls_actuals"


# ==============================================================================
# 검토에서 고친 것 — 같은 이름 두 줄·1월 전년 대비·실패 뒤 다시 묻기·메시지의 키
# ==============================================================================
def test_Nasdaq이_같은_이름으로_두_줄을_주면_대조하지_않는다(store, bls, clock):
    _due(clock)
    task.task_us_bls_actuals()
    clock["t"] = _et(2026, 12, 10, 8, 33)
    bls.reply = _Response(200, _body({"CUSR0000SA0": [("2026-11", "306.030"), ("2026-10", "303.000")]}))
    store.put_snapshot(catalog.SNAP_US_CONSENSUS, {"days": {"2026-12-10": {"rows": [
        {"name": "CPI", "actual": 1.0, "unit": "%", "actualText": "1.0%"},      # 전월 대비
        {"name": "CPI", "actual": 3.0, "unit": "%", "actualText": "3.0%"},      # 전년 대비(이름표 없음)
    ]}}})
    _due(clock)
    detail = task.task_us_bls_actuals()

    checks = _status(store)["checks"]
    assert [check["agree"] for check in checks] == [None, None]
    assert all(check["note"] == task.DUPLICATE_NOTE for check in checks)
    assert "Nasdaq 대조" not in detail


def test_1월에도_전년_대비의_기준_달이_요청_범위에_든다(store, bls, clock):
    clock["t"] = _et(2027, 1, 20, 8, 33)
    bls.reply = _Response(200, _body({"CUUR0000SA0": [("2026-12", "315.000"), ("2026-11", "314.000"), ("2025-12", "300.000")]}))
    _due(clock)
    task.task_us_bls_actuals()

    assert (bls.calls[-1][1]["startyear"], bls.calls[-1][1]["endyear"]) == ("2025", "2027")
    assert _status(store)["series"]["cpi_nsa"]["derived"] == {"yoyPct": 5.0}


def test_발표_시각에_요청이_실패하면_15_25분_뒤_한_번만_더(store, bls, clock):
    _due(clock)
    task.task_us_bls_actuals()                               # 기준 저장본
    before = store.read_snapshot(catalog.SNAP_US_BLS_ACTUALS)
    bls.reply = requests.ConnectionError("down")
    clock["t"] = _et(2026, 12, 10, 10, 3)                    # JOLTS 시각
    _due(clock)
    with pytest.raises(EmptyResult, match="BLS 받지 못함"):
        task.task_us_bls_actuals()

    retry_at = flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM]
    assert timedelta(minutes=15) <= retry_at - clock["t"] <= timedelta(minutes=25)
    after = store.read_snapshot(catalog.SNAP_US_BLS_ACTUALS)
    assert after.collected_at == before.collected_at, "실패는 저장 시각을 바꾸지 않음"
    assert after.payload["lastAttempt"] == {"at": clock["t"].isoformat(timespec="seconds"), "etDate": "2026-12-10",
                                            "slot": "10:00", "ok": False}
    assert after.payload["series"] == before.payload["series"]

    clock["t"] = retry_at                                    # 다시 물어도 실패 — 그 시각에는 더 묻지 않음
    with pytest.raises(EmptyResult):
        task.task_us_bls_actuals()
    assert flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM] >= _et(2026, 12, 11, 8, 32)


def test_BLS_메시지에_키가_되풀이돼도_지운다(bls):
    bls.reply = _Response(200, {"status": "REQUEST_NOT_PROCESSED", "message": [f"The key:{KEY} provided by the User is invalid."]})
    with pytest.raises(svc.BlsFetchError) as caught:
        svc.fetch(IDS, 2024, 2026, KEY)
    assert KEY not in str(caught.value) and "The key:*** provided" in str(caught.value)

