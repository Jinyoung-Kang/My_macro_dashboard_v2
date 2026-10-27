"""
tests/test_us_consensus.py
미국 경제 지표 컨센서스(태스크 us_calendar_consensus, v2 2단계 명세 §4-12·K22·B9) — **저장만**, 패킷은 calendar.consensus를 켠 뒤(E1).

고정하는 규칙
  1. 출처는 Nasdaq(TradingView는 이 PC에서 403 — G11). date=D는 동부 D−1의 행이라 동부 날짜 E는 date=E+1로 묻는다.
  2. 미국 행만, 값은 숫자 + 단위로 나누고 못 나누면 null(글자는 …Text에 그대로), 단위가 서로 다르면 숫자를 모두 null. 중요도는 null.
  3. 동부 오늘부터 18일 안의 평일을 하루 한 번(같은 동부 날짜에 받은 날은 다시 묻지 않음). 날짜 하나의 실패는 직전 값을 isStale로 잇고,
     하나도 못 받으면 EmptyResult. 출처 거부면 그 실행을 멈춘다. 실업수당 청구가 목요일에 없으면 날짜 어긋남이 바뀐 것으로 보고 저장하지 않는다.
  4. 백엔드·화면 코드는 이 저장본을 읽지 않는다(이름 상수만).

외부 네트워크를 쓰지 않습니다 — 고정본은 tests/fixtures/calendar/nasdaq_*.json(README). 태스크 테스트는 PostgreSQL이 필요합니다.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests

from app import catalog, http, tasks
from app.services import us_consensus as svc
from app.tasks import us_consensus as task_module
from app.tasks.base import EmptyResult

FIXTURES = Path(__file__).parent / "fixtures" / "calendar"
ROOT = Path(__file__).resolve().parents[2]
THURSDAY = json.loads((FIXTURES / "nasdaq_economicevents_date_2026-10-23.json").read_text(encoding="utf-8"))   # 목 10-22의 행
WEDNESDAY = json.loads((FIXTURES / "nasdaq_economicevents_date_2026-10-29.json").read_text(encoding="utf-8"))  # 수 10-28의 행
EMPTY = {"data": {"asOf": "Mon, Oct 26, 2026", "headers": {}, "rows": []}, "message": None, "status": {"rCode": 200}}
NOW = datetime(2026, 10, 27, 13, 0, tzinfo=timezone.utc)   # 동부 10-27(화) 09:00, KST 22:00


# ==============================================================================
# 1. 등록·이름·저장만
# ==============================================================================
def test_slow에서_미국_일정_바로_뒤에_돌고_태스크는_35개():
    task = tasks.TASKS_BY_NAME["us_calendar_consensus"]
    assert task.speed == "slow" and task.run is task_module.task_us_calendar_consensus
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("us_calendar_consensus") == names.index("us_calendar") + 1
    assert task_module.TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 35


def test_데이터셋_이름():
    assert catalog.SNAP_US_CONSENSUS == "calendar.us_consensus"


def test_백엔드와_화면은_컨센서스_저장본을_읽지_않는다():
    """저장만(명세 K22) — 패킷 스위치 calendar.consensus는 E1. 이름 상수 말고 읽는 코드가 생기면 그 커밋이 이 시험을 고친다."""
    readers = []
    for folder in (ROOT / "backend/src/main/java", ROOT / "frontend/src"):
        if not folder.exists():
            continue
        for path in folder.rglob("*"):
            if path.suffix in (".java", ".ts", ".tsx") and path.is_file():
                text = path.read_text(encoding="utf-8")
                if "SNAP_US_CONSENSUS" in text or "calendar.us_consensus" in text:
                    readers.append(path.relative_to(ROOT).as_posix())
    assert readers == ["backend/src/main/java/com/macrodash/store/Datasets.java"]


# ==============================================================================
# 2. 값 나누기·행 읽기 (DB·네트워크 없음)
# ==============================================================================
@pytest.mark.parametrize("text, expected", [
    ("1,728K", (1728.0, "K")),
    ("197.75K", (197.75, "K")),
    ("-130.80B", (-130.8, "B")),
    ("6,754B", (6754.0, "B")),
    ("2.969T", (2.969, "T")),
    ("-0.300M", (-0.3, "M")),
    ("4.00%", (4.0, "%")),
    ("-0.1%", (-0.1, "%")),
    ("+0.2%", (0.2, "%")),
    ("80.5", (80.5, None)),
    ("11", (11.0, None)),
    ("$-1.2B", (None, None)),
    ("-$77.9B", (-77.9, "$B")),
    (" ", (None, None)),
    ("&nbsp;", (None, None)),
    ("\xa0", (None, None)),
    (None, (None, None)),
    ("1,72K", (None, None)),
    ("N/A", (None, None)),
    ("0.4%  ", (0.4, "%")),
])
def test_값을_숫자와_단위로_나누고_못_나누면_null(text, expected):
    assert svc.parse_value(text) == expected


def test_동부_날짜_E는_date_E_더하기_1로_묻는다():
    assert svc.QUERY_OFFSET_DAYS == 1
    assert svc.query_date(date(2026, 10, 22)) == date(2026, 10, 23)
    assert svc.query_date(date(2026, 10, 30)) == date(2026, 10, 31)   # 금요일 행은 토요일 date로


def test_목요일_고정본의_미국_행():
    rows = svc.parse_rows(THURSDAY)

    assert len(rows) == 11   # 영국 두 행은 버림
    assert rows[0] == {
        "name": "Continuing Jobless Claims", "timeEt": "08:30", "timeText": "08:30",
        "forecast": 1720.0, "previous": 1703.0, "actual": 1728.0, "unit": "K",
        "forecastText": "1,720K", "previousText": "1,703K", "actualText": "1,728K", "importance": None,
    }
    by_name = {row["name"]: row for row in rows}
    assert by_name["Initial Jobless Claims"]["forecast"] == 200.0
    # 컨센서스가 ' '이면 null(0이 아님) — 다른 값은 그대로.
    kc = by_name["KC Fed Manufacturing Index"]
    assert (kc["forecast"], kc["forecastText"], kc["previous"], kc["actual"], kc["unit"]) == (None, None, 20.0, 16.0, None)
    assert by_name["Fed's Balance Sheet"]["actual"] == 6754.0 and by_name["Fed's Balance Sheet"]["unit"] == "B"
    assert "description" not in rows[0]


def test_수요일_고정본의_FOMC와_빈_값():
    by_name = {row["name"]: row for row in svc.parse_rows(WEDNESDAY)}

    assert by_name["Fed Interest Rate Decision"] == {
        "name": "Fed Interest Rate Decision", "timeEt": "14:00", "timeText": "14:00",
        "forecast": 4.0, "previous": 4.0, "actual": None, "unit": "%",
        "forecastText": "4.00%", "previousText": "4.00%", "actualText": None, "importance": None,
    }
    statement = by_name["FOMC Statement"]
    assert (statement["forecast"], statement["previous"], statement["actual"], statement["unit"]) == (None, None, None, None)
    assert by_name["Goods Trade Balance"]["forecast"] == -130.8
    assert "EIA Refinery Crude Runs" in by_name   # 이름 끝 공백 정리
    assert "MBA Mortgage Applications" in by_name and len(by_name) == 10


def test_단위가_서로_다르면_숫자를_모두_null():
    row = svc.us_row({"gmt": "Tentative", "country": "United States", "eventName": "Odd", "actual": "&nbsp;",
                      "consensus": "0.4%", "previous": "650K"})
    assert (row["forecast"], row["previous"], row["unit"], row["unitMismatch"]) == (None, None, None, True)
    assert (row["forecastText"], row["previousText"], row["timeEt"], row["timeText"]) == ("0.4%", "650K", None, "Tentative")


@pytest.mark.parametrize("body, reason", [
    ([], "응답이 객체가 아님"),
    ({"data": None, "status": {"rCode": 200}}, "data.rows가 없음"),
    ({"data": {"rows": {}}, "status": {"rCode": 200}}, "data.rows가 없음"),
    ({"data": {"rows": []}, "status": {"rCode": 400}}, "rCode 400"),
    ({"data": {"rows": ["x"]}, "status": {"rCode": 200}}, "객체가 아닌 행"),
])
def test_모양이_다르면_ConsensusShapeError(body, reason):
    with pytest.raises(svc.ConsensusShapeError, match=reason):
        svc.parse_rows(body)


# ==============================================================================
# 3. 받기 (가짜 세션)
# ==============================================================================
class _Response:
    def __init__(self, status: int, body=None, text_only: bool = False):
        self.status_code = status
        self._body = body
        self._text_only = text_only

    def json(self):
        if self._text_only:
            raise ValueError("not json")
        return self._body


class FakeNasdaq:
    """date 값 → 응답. 기본은 동부 요일로 고름(목 → 목요일 고정본, 수 → 수요일 고정본, 그 밖 → 빈 행)."""

    def __init__(self):
        self.calls: list[str] = []
        self.outcomes: dict[str, object] = {}
        self.clock = {"now": NOW, "mono": 0.0}
        self.sleeps: list[float] = []

    def default(self, query: str):
        event_day = date.fromisoformat(query) - timedelta(days=1)
        if event_day.weekday() == 3:
            return _Response(200, THURSDAY)
        if event_day.weekday() == 2:
            return _Response(200, WEDNESDAY)
        return _Response(200, EMPTY)

    def session(self):
        fake = self

        class _Session:
            def get(self, url, params=None, timeout=None):
                assert url == svc.NASDAQ_URL and timeout == svc.FETCH_TIMEOUT
                query = params["date"]
                fake.calls.append(query)
                outcome = fake.outcomes.get(query)
                if outcome is None:
                    return fake.default(query)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome

        return _Session()


@pytest.fixture()
def nasdaq(monkeypatch):
    fake = FakeNasdaq()
    monkeypatch.setattr(svc, "get_session", fake.session)
    monkeypatch.setattr(task_module, "_now", lambda: fake.clock["now"])
    monkeypatch.setattr(task_module, "_clock", lambda: fake.clock["mono"])
    monkeypatch.setattr(task_module, "_sleep", lambda seconds: fake.sleeps.append(seconds))

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return fake


def test_받기_오류는_그_날짜의_실패(nasdaq):
    nasdaq.outcomes["2026-10-23"] = _Response(500)
    with pytest.raises(svc.ConsensusFetchError, match="HTTP 500"):
        svc.fetch_day(date(2026, 10, 22))
    nasdaq.outcomes["2026-10-23"] = _Response(200, text_only=True)
    with pytest.raises(svc.ConsensusShapeError, match="JSON"):
        svc.fetch_day(date(2026, 10, 22))
    nasdaq.outcomes["2026-10-23"] = http.SourceRejected("api.nasdaq.com", "HTTP 403")
    with pytest.raises(svc.ConsensusFetchError, match="거부됨 — api.nasdaq.com HTTP 403") as caught:
        svc.fetch_day(date(2026, 10, 22))
    assert isinstance(caught.value.__cause__, http.SourceRejected)
    assert nasdaq.calls == ["2026-10-23"] * 3


def test_창은_동부_오늘부터_18일_안의_평일():
    days = task_module.horizon_days(date(2026, 10, 27))
    assert days[0] == date(2026, 10, 27) and days[-1] == date(2026, 11, 13)
    assert len(days) == 14 and all(day.weekday() < 5 for day in days)


def test_창은_패킷_창_끝을_공휴일_둘까지_덮는다():
    """
    패킷 창(백엔드 CalendarWindow)은 기준일 다음 세션 ~ 기준일 + 10거래일입니다. 미국 07:30 KST 결정 전 마지막 수집의 동부 오늘이
    기준일일 수 있어, 16일이면 금요일 기준일에 공휴일 하나(추수감사절)·목·금 기준일에 공휴일 둘(성탄·신년)일 때 창 끝이 밖이었습니다.
    끝 날짜는 NYSE 휴장(2026-11-26·12-25, 2027-01-01)으로 손으로 센 값입니다.
    """
    for basis, window_end in ((date(2026, 11, 13), date(2026, 11, 30)),    # 금 + 추수감사절 → 월(+17일)
                              (date(2026, 12, 17), date(2027, 1, 4)),      # 목 + 성탄·신년 → 월(+18일)
                              (date(2026, 12, 18), date(2027, 1, 5))):     # 금 + 성탄·신년 → 화(+18일)
        assert window_end in task_module.horizon_days(basis), basis


# ==============================================================================
# 4. 태스크 (PostgreSQL)
# ==============================================================================
def _payload(store) -> dict:
    return store.read_snapshot(catalog.SNAP_US_CONSENSUS).payload


def test_창의_평일마다_하루_뒤_date로_묻고_저장만_한다(store, nasdaq):
    detail = task_module.task_us_calendar_consensus()

    expected_days = [day.isoformat() for day in task_module.horizon_days(date(2026, 10, 27))]
    assert nasdaq.calls == [svc.query_date(date.fromisoformat(day)).isoformat() for day in expected_days]
    assert nasdaq.sleeps == [task_module.SPACING_SECONDS] * 13
    payload = _payload(store)
    assert list(payload["days"]) == expected_days
    assert (payload["forDate"], payload["horizon"]) == ("2026-10-27", {"from": "2026-10-27", "to": "2026-11-14"})
    assert (payload["source"], payload["queryOffsetDays"], payload["importance"]) == (svc.SOURCE, 1, None)
    assert payload["tradingView"]["status"] == "HTTP 403" and payload["failed"] == {}
    thursday = payload["days"]["2026-10-29"]
    assert {key: thursday[key] for key in ("date", "queryDate", "status", "fetchedAt", "count", "withForecast")} == {
        "date": "2026-10-29", "queryDate": "2026-10-30", "status": "ok", "fetchedAt": "2026-10-27T13:00:00+00:00",
        "count": 11, "withForecast": 6}
    assert thursday["rows"][0]["name"] == "Continuing Jobless Claims"
    assert payload["days"]["2026-10-28"]["rows"][8]["name"] == "Fed Interest Rate Decision"
    assert payload["days"]["2026-10-27"]["rows"] == []
    # 목 3일 × 11행 + 수 3일 × 10행, 컨센서스는 목 6행·수 4행.
    assert detail == ("미국 컨센서스 14/14일 받음(호출 14회) · 미국 행 63개 · 컨센서스 있는 행 30개 · "
                      "창 2026-10-27~2026-11-14(동부)")


def test_같은_동부_날짜에는_다시_묻지_않는다(store, nasdaq):
    task_module.task_us_calendar_consensus()
    saved = _payload(store)
    nasdaq.calls.clear()

    nasdaq.clock["now"] = datetime(2026, 10, 27, 23, 0, tzinfo=timezone.utc)   # 동부 19:00(KST 다음 날 08:00 — 같은 서버 창)
    detail = task_module.task_us_calendar_consensus()

    assert nasdaq.calls == [] and detail == "오늘(미국 동부 2026-10-27) 이미 받음 — 호출 0회 · 14일"
    assert _payload(store) == saved

    # 다음 동부 날짜(다음 서버 창)에는 창 전체를 다시 받습니다.
    nasdaq.clock["now"] = datetime(2026, 10, 28, 13, 0, tzinfo=timezone.utc)
    task_module.task_us_calendar_consensus()
    assert len(nasdaq.calls) == 13 and nasdaq.calls[0] == "2026-10-29"
    assert list(_payload(store)["days"])[0] == "2026-10-28"


def test_날짜_하나가_실패하면_직전_값을_잇고_다음_실행은_그날만_다시(store, nasdaq):
    task_module.task_us_calendar_consensus()
    before = _payload(store)["days"]["2026-10-29"]

    nasdaq.clock["now"] = datetime(2026, 10, 28, 13, 0, tzinfo=timezone.utc)
    nasdaq.outcomes["2026-10-30"] = _Response(503)
    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["us_calendar_consensus"])

    assert ok is True and "실패 1일 (사유: HTTP 503)" in detail and "이전 값 1개(2026-10-29)" in detail
    payload = _payload(store)
    carried = payload["days"]["2026-10-29"]
    assert carried["isStale"] is True and carried["staleReason"] == "HTTP 503"
    assert carried["rows"] == before["rows"] and carried["fetchedAt"] == before["fetchedAt"]
    assert payload["failed"] == {"2026-10-29": "HTTP 503"}

    # 같은 동부 날짜의 다음 실행은 실패한(이어받은) 날만 다시 묻습니다.
    nasdaq.calls.clear()
    nasdaq.outcomes.clear()
    detail = task_module.task_us_calendar_consensus()
    assert nasdaq.calls == ["2026-10-30"]
    assert "오늘 이미 받은 12일은 그대로" in detail
    assert "isStale" not in _payload(store)["days"]["2026-10-29"] and _payload(store)["failed"] == {}


def test_하나도_못_받으면_EmptyResult이고_저장본을_덮지_않는다(store, nasdaq):
    store.put_snapshot(catalog.SNAP_US_CONSENSUS, {"marker": "이전"})
    for day in task_module.horizon_days(date(2026, 10, 27)):
        nasdaq.outcomes[svc.query_date(day).isoformat()] = requests.ConnectionError("connection refused")

    with pytest.raises(EmptyResult, match=r"새로 받은 날 없음\(0/14\) — 기존 저장본 유지 \(사유: ConnectionError"):
        task_module.task_us_calendar_consensus()
    assert _payload(store) == {"marker": "이전"}


def test_출처가_거부하면_그_실행을_멈춘다(store, nasdaq):
    nasdaq.outcomes["2026-10-29"] = http.SourceRejected("api.nasdaq.com", "HTTP 429")   # 둘째 날(10-28)

    detail = task_module.task_us_calendar_consensus()

    assert nasdaq.calls == ["2026-10-28", "2026-10-29"]
    payload = _payload(store)
    assert list(payload["days"]) == ["2026-10-27"]
    assert len(payload["failed"]) == 13 and set(payload["failed"].values()) == {
        "거부됨 — api.nasdaq.com HTTP 429 · 5분 동안 이 출처 호출을 멈춤"}
    assert "미국 컨센서스 1/14일 받음(호출 2회)" in detail


def test_실업수당_청구가_목요일에_없으면_날짜가_밀린_것으로_보고_저장하지_않는다(store, nasdaq):
    store.put_snapshot(catalog.SNAP_US_CONSENSUS, {"marker": "이전"})
    # Nasdaq이 어긋남을 고쳐 date=D가 D의 행을 준다면, date=E+1로 물은 수요일 칸에 목요일 행이 옵니다.
    for day in task_module.horizon_days(date(2026, 10, 27)):
        query = svc.query_date(day).isoformat()
        nasdaq.outcomes[query] = _Response(200, THURSDAY if day.weekday() == 2 else EMPTY)

    with pytest.raises(EmptyResult, match=r"Nasdaq 날짜 어긋남이 바뀐 것 같음 — 실업수당 청구\(목요일 발표\)가 2026-10-28\(수\), "
                                          r"2026-11-04\(수\), 2026-11-11\(수\)에 옴"):
        task_module.task_us_calendar_consensus()
    assert _payload(store) == {"marker": "이전"}


def test_공휴일_주처럼_수요일에_한_번만_오면_그대로_저장(store, nasdaq):
    for day in task_module.horizon_days(date(2026, 10, 27)):
        query = svc.query_date(day).isoformat()
        nasdaq.outcomes[query] = _Response(200, THURSDAY if day == date(2026, 11, 4) else EMPTY)
    task_module.task_us_calendar_consensus()
    assert _payload(store)["days"]["2026-11-04"]["count"] == 11


def test_시간_상한이_지나면_남은_날은_다음_실행(store, nasdaq, monkeypatch):
    original = nasdaq.session

    def slow_session():
        inner = original()

        class _Session:
            def get(self, url, params=None, timeout=None):
                nasdaq.clock["mono"] += task_module.TIME_LIMIT_SECONDS / 2
                return inner.get(url, params=params, timeout=timeout)

        return _Session()

    monkeypatch.setattr(svc, "get_session", slow_session)
    detail = task_module.task_us_calendar_consensus()

    assert len(nasdaq.calls) == 3   # 0·120·240초에 시작, 360초부터는 새 요청 없음
    payload = _payload(store)
    assert len(payload["days"]) == 3 and len(payload["failed"]) == 11
    assert set(payload["failed"].values()) == {"시간 상한(240초) — 다음 실행"}
    assert "미국 컨센서스 3/14일 받음(호출 3회)" in detail
