"""
tests/test_kr_paper_price_history.py
🧪 한국 책 종가 이력 kr_paper_price_history → timeseries kr_close_adj (v2 2단계 B4). 저장은 PostgreSQL, 토스는 가짜(before 쪽 넘기기).

고정하는 규칙
  1. 메우기: 저장 첫 날이 1년 전(상장일이 늦으면 상장일)보다 늦으면 그 앞을 before로 200봉씩 거슬러 받는다 — 다 메우면 호출 0회.
  2. 다시 받기: 관측치가 수정주가 기준 바뀜을 걸었고 저장값이 옛 기준이면 저장 구간 전체를 새 기준으로 — 끝까지 받았을 때만 쓴다.
  3. 빈 구간: 저장된 마지막 날이 일주일 넘게 오래됐거나 관측치의 최근 5봉과 이어지지 않으면 최신부터 그 날까지 — 관측치가 먼저 돌아도
     (관측치는 빈 구간 너머로 덧붙이지 않음).
  4. 오늘 장중 봉(대상 세션 뒤)은 쓰지 않는다. 기존 점은 지우지 않는다.
  5. 실행당 호출 예산, 403이면 멈춤, 한 종목 실패가 다른 종목을 막지 않음.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app import catalog, krcalendar, tasks
from app.services import toss as toss_service
from app.tasks import kr_paper
from app.tasks.base import KST

NIGHT = datetime(2026, 10, 27, 21, 0, tzinfo=KST)


def _weekdays(start: str, end: str) -> list[str]:
    out, day = [], date.fromisoformat(start)
    while day <= date.fromisoformat(end):
        if day.weekday() < 5:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


class FakeHistory:
    """종목마다 (날짜, 수정 종가) 전체 이력을 들고 before·count대로 최신순 한 쪽과 nextBefore를 돌려줍니다."""

    def __init__(self):
        self.series: dict[str, list[tuple[str, float]]] = {}
        self.errors: dict[tuple[str, int], Exception] = {}     # (코드, 몇 번째 호출) → 예외
        self.calls: list[tuple[str, str | None]] = []

    def candles(self, symbol, interval, count, *, adjusted, before=None):
        assert interval == "1d" and adjusted is True
        self.calls.append((symbol, before))
        nth = sum(1 for code, _ in self.calls if code == symbol)
        if (symbol, nth) in self.errors:
            raise self.errors[(symbol, nth)]
        bars = [(d, v) for d, v in self.series.get(symbol, []) if before is None or d <= before[:10]]
        page = list(reversed(bars))[:count]
        older = [d for d, _ in bars if d < page[-1][0]] if page else []
        next_before = f"{older[-1]}T00:00:00.000+09:00" if older else None
        return [{"date": d, "time": "00:00", "open": v, "high": v, "low": v, "close": v, "volume": 1} for d, v in page], next_before


@pytest.fixture()
def history(monkeypatch):
    fake = FakeHistory()
    monkeypatch.setattr(kr_paper.toss_service, "fetch_candles", fake.candles)
    monkeypatch.setattr(kr_paper, "KR_CANDLE_SPACING", 0)
    monkeypatch.setattr(kr_paper, "_now", lambda: NIGHT)
    monkeypatch.setattr(krcalendar, "_holidays", set())
    return fake


def _scope(monkeypatch, codes):
    monkeypatch.setattr(kr_paper, "kr_scope", lambda: (list(codes), "2026-10-26"))


def _stored(store, code):
    return [(p["date"], p["value"]) for p in store.read_timeseries(catalog.TS_KR_CLOSE_ADJ, code)]


DAYS = _weekdays("2025-06-02", "2026-10-27")
FLOOR = (NIGHT.date() - timedelta(days=kr_paper.KR_HISTORY_DAYS)).isoformat()


def test_처음이면_1년을_200봉씩_거슬러_메우고_다시_돌면_0회(store, history, monkeypatch):
    _scope(monkeypatch, ["069500"])
    history.series["069500"] = [(d, 100.0 + i) for i, d in enumerate(DAYS)]

    detail = tasks.task_kr_paper_price_history()

    assert [before for _code, before in history.calls] == [None, f"{DAYS[-201]}T00:00:00.000+09:00"]
    stored = _stored(store, "069500")
    assert stored[-1] == ("2026-10-27", 100.0 + len(DAYS) - 1) and stored[0][0] <= FLOOR
    assert len(stored) == len(DAYS)            # 둘째 쪽이 1년 앞을 넘어 첫 봉까지 — 받은 쪽은 다 씀
    assert detail == f"1/1 종목 — 메우기 1 · 점 {len(DAYS)}개 · 호출 2회"

    history.calls.clear()
    assert tasks.task_kr_paper_price_history() == "최신 상태 (1종목, 호출 0회)"
    assert history.calls == []


def test_관측치가_덧붙인_최근_점만_있으면_그_앞부터_이어_메운다(store, history, monkeypatch):
    _scope(monkeypatch, ["069500"])
    history.series["069500"] = [(d, 100.0) for d in DAYS]
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, "069500", [("2026-10-26", 100.0), ("2026-10-27", 100.0)])

    tasks.task_kr_paper_price_history()

    assert history.calls[0] == ("069500", "2026-10-25T00:00:00+09:00")
    assert _stored(store, "069500")[0][0] <= FLOOR


def test_상장일이_1년_안이면_상장일까지만(store, history, monkeypatch):
    _scope(monkeypatch, ["0088M0"])
    young = _weekdays("2026-05-04", "2026-10-27")
    history.series["0088M0"] = [(d, 10.0) for d in young]
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, {"contract": 1, "codes": {"0088M0": {"listDate": "2026-05-04", "bars": []}}})

    tasks.task_kr_paper_price_history()
    history.calls.clear()

    assert tasks.task_kr_paper_price_history() == "최신 상태 (1종목, 호출 0회)"
    assert _stored(store, "0088M0")[0][0] == "2026-05-04"


def test_상장일을_모르고_더_오래된_봉이_없으면_그렇게_적는다(store, history, monkeypatch):
    _scope(monkeypatch, ["0088M0"])
    history.series["0088M0"] = [(d, 10.0) for d in _weekdays("2026-09-01", "2026-10-27")]
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, "0088M0", [(d, 10.0) for d in _weekdays("2026-09-01", "2026-10-27")])

    detail = tasks.task_kr_paper_price_history()

    assert history.calls == [("0088M0", "2026-08-31T00:00:00+09:00")]
    assert detail == "1/1 종목 — 더 오래된 봉 없음 1(0088M0) · 점 0개 · 호출 1회"


def test_수정주가_기준이_바뀌면_저장_구간_전체를_새_기준으로_다시_받는다(store, history, monkeypatch):
    _scope(monkeypatch, ["005930"])
    old = [(d, 2_520_000.0) for d in DAYS if d >= "2025-10-27"]
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, "005930", old)                        # 옛 기준(분할 전 가격)
    history.series["005930"] = [(d, 50_400.0) for d in DAYS]                             # 새 기준
    bars = [{"date": d, "adjClose": 50_400.0} for d in DAYS[-5:]]
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES,
                       {"contract": 1, "codes": {"005930": {"adjBasisChanged": True, "bars": bars, "listDate": "1975-06-11"}}})

    detail = tasks.task_kr_paper_price_history()

    stored = _stored(store, "005930")
    assert {v for d, v in stored if d >= old[0][0]} == {50_400.0}
    assert "다시 받기 1(005930)" in detail

    history.calls.clear()
    assert tasks.task_kr_paper_price_history() == "최신 상태 (1종목, 호출 0회)"   # 저장값이 이미 새 기준 — 표시만 남아도 다시 안 받음


def test_다시_받기는_끝까지_못_받으면_쓰지_않는다(store, history, monkeypatch):
    _scope(monkeypatch, ["005930"])
    old = [(d, 2_520_000.0) for d in DAYS if d >= "2025-10-27"]
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, "005930", old)
    history.series["005930"] = [(d, 50_400.0) for d in DAYS]
    bars = [{"date": d, "adjClose": 50_400.0} for d in DAYS[-5:]]
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, {"contract": 1, "codes": {"005930": {"adjBasisChanged": True, "bars": bars}}})
    monkeypatch.setattr(kr_paper, "KR_HISTORY_CALL_BUDGET", 1)

    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_price_history()

    assert {v for _d, v in _stored(store, "005930")} == {2_520_000.0}
    assert "다시 받기를 끝내지 못함" in str(exc.value)


def test_오래_꺼져_생긴_빈_구간을_메운다(store, history, monkeypatch):
    _scope(monkeypatch, ["069500"])
    history.series["069500"] = [(d, 1.0) for d in DAYS]
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, "069500", [(d, 1.0) for d in DAYS if d <= "2026-10-01"])

    detail = tasks.task_kr_paper_price_history()

    assert history.calls == [("069500", None)]
    assert _stored(store, "069500")[-1][0] == "2026-10-27"
    assert "빈 구간 1(069500)" in detail


def test_관측치가_먼저_돌아도_오래_꺼져_생긴_빈_구간을_메운다(store, history, monkeypatch):
    """
    기동 때 slow(관측치 kr_paper_quotes)가 weekly(이 태스크)보다 먼저 최근 5봉을 덧붙이면 저장된 마지막 날이 최신이 되어 '빈 구간'
    (마지막 날이 일주일 넘게 오래됨)이 걸리지 않았고, 2026-10-02~10-20 평일 13일이 영영 비었습니다. 관측치는 빈 구간 너머로 덧붙이지
    않고(adjGap) 이 태스크가 그 사이를 메운 뒤, 다음 관측치가 이어 덧붙입니다.
    """
    days = DAYS + ["2026-10-28"]
    _scope(monkeypatch, ["069500"])
    history.series["069500"] = [(d, 1.0) for d in days]
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, "069500", [(d, 1.0) for d in days if d <= "2026-10-01"])

    def candles(symbol, interval, count, *, adjusted, before=None):
        if interval == "1m":
            return [], None
        if adjusted:
            return history.candles(symbol, interval, count, adjusted=True, before=before)
        return [{"date": d, "time": "00:00", "open": 2.0, "high": 2.0, "low": 2.0, "close": 2.0, "volume": 5}
                for d in reversed(days)][:count], None

    monkeypatch.setattr(kr_paper.toss_service, "fetch_candles", candles)
    monkeypatch.setattr(kr_paper.toss_service, "fetch_stock_infos", lambda codes: {})

    quotes = tasks.task_kr_paper_quotes()                                        # 기동 직후 slow가 먼저

    assert "수정 종가 빈 구간 1(069500)" in quotes
    assert _stored(store, "069500")[-1][0] == "2026-10-01", "빈 구간 너머로 덧붙이지 않음"
    assert store.read_snapshot(catalog.SNAP_KR_PAPER_QUOTES).payload["codes"]["069500"]["adjGap"] is True

    history.calls.clear()
    detail = tasks.task_kr_paper_price_history()                                # 그 뒤 weekly

    assert "빈 구간 1(069500)" in detail and history.calls == [("069500", None)]
    stored = [d for d, _ in _stored(store, "069500")]
    assert [d for d in days if d <= "2026-10-27" and d not in stored] == []

    monkeypatch.setattr(kr_paper, "_now", lambda: datetime(2026, 10, 28, 21, 0, tzinfo=KST))
    tasks.task_kr_paper_quotes()                                                 # 다음 날 관측치가 이어 덧붙이고 표시를 푼다
    assert _stored(store, "069500")[-1][0] == "2026-10-28"
    assert store.read_snapshot(catalog.SNAP_KR_PAPER_QUOTES).payload["codes"]["069500"]["adjGap"] is False
    history.calls.clear()
    assert tasks.task_kr_paper_price_history() == "최신 상태 (1종목, 호출 0회)"


def test_빈_구간은_달력의_직전_거래일로_가른다(monkeypatch):
    monkeypatch.setattr(krcalendar, "_holidays", {"2026-10-09"})
    assert kr_paper._adj_gap(None, "2026-10-21") is False                     # 저장본 없음 — 이력 태스크의 메우기
    assert kr_paper._adj_gap("2026-10-27", "2026-10-21") is False             # 겹침
    assert kr_paper._adj_gap("2026-10-20", "2026-10-21") is False             # 바로 앞 거래일
    assert kr_paper._adj_gap("2026-10-23", "2026-10-26") is False             # 금 → 월
    assert kr_paper._adj_gap("2026-10-08", "2026-10-12") is False             # 공휴일(10-09)·주말을 건너뜀
    assert kr_paper._adj_gap("2026-10-16", "2026-10-21") is True              # 10-19·10-20이 빔


def test_20시30분_전에는_오늘_장중_봉을_쓰지_않는다(store, history, monkeypatch):
    _scope(monkeypatch, ["069500"])
    history.series["069500"] = [(d, 1.0) for d in DAYS]
    monkeypatch.setattr(kr_paper, "_now", lambda: datetime(2026, 10, 27, 15, 0, tzinfo=KST))

    tasks.task_kr_paper_price_history()

    assert _stored(store, "069500")[-1][0] == "2026-10-26"


def test_한_종목_실패는_다른_종목을_막지_않고_둘째_쪽_실패는_받은_쪽까지_쓴다(store, history, monkeypatch):
    _scope(monkeypatch, ["069500", "153130"])
    history.series["069500"] = [(d, 1.0) for d in DAYS]
    history.series["153130"] = [(d, 2.0) for d in DAYS]
    history.errors[("069500", 2)] = toss_service.TossError("HTTP 500")
    history.errors[("153130", 1)] = toss_service.TossError("HTTP 502")

    detail = tasks.task_kr_paper_price_history()

    assert len(_stored(store, "069500")) == 200 and _stored(store, "153130") == []
    assert "1/2 종목" in detail and "069500: HTTP 500 — 받은 쪽까지만" in detail and "153130: HTTP 502" in detail
    tasks.task_kr_paper_price_history()          # 다음 실행이 069500은 저장 첫 날 앞부터, 153130은 처음부터
    assert _stored(store, "069500")[0][0] <= FLOOR


def test_403이면_멈춘다(store, history, monkeypatch):
    _scope(monkeypatch, ["069500", "153130"])
    history.series["153130"] = [(d, 2.0) for d in DAYS]
    history.errors[("069500", 1)] = toss_service.TossForbidden("HTTP 403 — 허용 IP")

    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_price_history()

    assert history.calls == [("069500", None)]
    assert "허용 IP" in str(exc.value)


def test_예산이_떨어지면_나머지는_다음_실행(store, history, monkeypatch):
    _scope(monkeypatch, ["069500", "153130"])
    history.series["069500"] = [(d, 1.0) for d in DAYS]
    history.series["153130"] = [(d, 2.0) for d in DAYS]
    monkeypatch.setattr(kr_paper, "KR_HISTORY_CALL_BUDGET", 2)

    detail = tasks.task_kr_paper_price_history()

    assert "1/1 종목" in detail and "호출 예산 소진" in detail and _stored(store, "153130") == []


def test_시간_상한은_weekly_상한보다_짧다():
    assert kr_paper.KR_HISTORY_TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["weekly"]


def test_weekly에_등록되고_태스크는_35개():
    task = tasks.TASKS_BY_NAME["kr_paper_price_history"]
    assert task.speed == "weekly" and task.run is kr_paper.task_kr_paper_price_history
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 39  # 장중 평가 paper_live_us·paper_live_kr·계좌2 단계 0의 paper_bars_us·계좌2 단계 2의 paper_watch_us까지
