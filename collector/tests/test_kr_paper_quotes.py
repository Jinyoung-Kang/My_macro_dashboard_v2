"""
tests/test_kr_paper_quotes.py
🧪 한국 책 관측치 kr_paper_quotes → paper.kr.quotes(계약 1)·kr_close_adj (v2 2단계 B4). 저장은 PostgreSQL, 토스는 가짜.

고정하는 규칙
  1. 저장본 모양 = 명세 §9 'paper.kr.quotes 계약' — 봉은 오래된 날부터 최근 5봉, 원시가·출처(NXT면 통합가)·수정 비율·종목별 받은 시각.
  2. KR 거래일 D 20:30 KST 뒤 하루 1회 — 그 뒤에 받은 종목은 다시 부르지 않는다(호출 0회). 20:30 전에는 전 거래일이 대상이고 장중 봉은 버린다.
  3. 일부 실패 → 그 종목만 직전 값을 isStale로 잇는다. 전부 실패 → EmptyResult(저장본 그대로). 403이면 멈춘다. 키가 없으면 EmptyResult.
  4. '응답에 없음'(봉 0개)은 NO_BARS로 '호출 실패'(이음·없음)와 가른다.
  5. 1분봉 개장 봉은 그날 09:01·10:01 라벨만, 처음 보는 종목은 최신 봉만, 확정된 결과는 다시 묻지 않고 FAILED는 다시 묻는다.
  6. 수정주가 기준이 바뀌면 kr_close_adj에 덧붙이지 않고 adjBasisChanged를 건다.
  7. 실행당 호출 예산·시간 상한 — 일봉을 1분봉보다 먼저, 남은 종목은 다음 주기에.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from app import catalog, krcalendar, tasks
from app.services import toss as toss_service
from app.tasks import kr_paper
from app.tasks.base import KST

DAYS = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"]   # 2026-10-27(화)이 세션 D
NIGHT = datetime(2026, 10, 27, 21, 0, tzinfo=KST)


def _bar(day, close, volume=1000, time_="00:00"):
    return {"date": day, "time": time_, "open": close - 10, "high": close + 10, "low": close - 20, "close": float(close),
            "volume": volume}


class FakeToss:
    """종목마다 원시·수정 일봉, 1분봉, 종목 상태를 돌려주는 가짜. errors[(code, kind)] = 예외로 그 호출을 실패시킵니다."""

    def __init__(self, raw=None, adjusted=None, minute=None, infos=None):
        self.raw = raw or {}
        self.adjusted = adjusted or {}
        self.minute = minute or {}
        self.infos = infos if infos is not None else {}
        self.errors: dict[tuple[str, str], Exception] = {}
        self.calls: list[tuple] = []

    def candles(self, symbol, interval, count, *, adjusted, before=None):
        kind = "1m" if interval == "1m" else ("adj" if adjusted else "raw")
        self.calls.append((symbol, kind, before))
        if (symbol, kind) in self.errors:
            raise self.errors[(symbol, kind)]
        if kind == "1m":
            return list(self.minute.get((symbol, before[:10]), [])), None
        source = self.adjusted if adjusted else self.raw
        bars = source.get(symbol, [])
        return list(reversed(bars))[:count], None   # 토스는 최신순

    def stock_infos(self, codes):
        self.calls.append((tuple(codes), "info", None))
        if ("*", "info") in self.errors:
            raise self.errors[("*", "info")]
        return {code: self.infos[code] for code in codes if code in self.infos}


def _info(nxt):
    return {"name": "이름", "market": "KOSPI", "securityType": "ETF" if nxt is False else "STOCK", "nxtSupported": nxt,
            "krxTradingSuspended": False, "listDate": "2002-10-14", "status": "ACTIVE"}


@pytest.fixture()
def toss(monkeypatch):
    fake = FakeToss()
    monkeypatch.setattr(kr_paper.toss_service, "fetch_candles", fake.candles)
    monkeypatch.setattr(kr_paper.toss_service, "fetch_stock_infos", fake.stock_infos)
    monkeypatch.setattr(kr_paper, "KR_CANDLE_SPACING", 0)
    monkeypatch.setattr(krcalendar, "_holidays", set())
    return fake


@pytest.fixture()
def clock(monkeypatch):
    def pin(when):
        monkeypatch.setattr(kr_paper, "_now", lambda: when)
        return when
    pin(NIGHT)
    return pin


def _scope(monkeypatch, codes):
    monkeypatch.setattr(kr_paper, "kr_scope", lambda: (list(codes), "2026-10-26"))


def _standard(fake, codes, *, nxt=None):
    for code in codes:
        fake.raw[code] = [_bar(day, 1000 + i) for i, day in enumerate(DAYS)]
        fake.adjusted[code] = [_bar(day, 500 + i) for i, day in enumerate(DAYS)]
        fake.infos[code] = _info(nxt.get(code) if nxt else None)
        fake.minute[(code, "2026-10-27")] = [_bar("2026-10-27", 1105, 900, "10:01"), _bar("2026-10-27", 1101, 777, "09:01"),
                                             _bar("2026-10-27", 1100, 0, "09:00"), _bar("2026-10-26", 1004, 50, "20:00")]


def _payload(store):
    return store.read_snapshot(catalog.SNAP_KR_PAPER_QUOTES).payload


def test_저장본은_계약_1의_모양이다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500", "005930"])
    _standard(toss, ["069500", "005930"], nxt={"069500": False, "005930": True})

    detail = tasks.task_kr_paper_quotes()

    payload = _payload(store)
    assert payload["contract"] == 1 and payload["session"] == "2026-10-27" and payload["universeDate"] == "2026-10-26"
    assert payload["scope"] == ["069500", "005930"] and set(payload["codes"]) == {"069500", "005930"}   # 순서는 scope(JSONB는 키 순서를 지키지 않음)
    etf, stock = payload["codes"]["069500"], payload["codes"]["005930"]
    assert etf["status"] == "OK"
    assert datetime.fromisoformat(etf["fetchedAt"]) == NIGHT
    assert etf["nxtSupported"] is False and etf["securityType"] == "ETF" and etf["krxTradingSuspended"] is False
    assert [b["date"] for b in etf["bars"]] == DAYS[1:]                       # 오래된 날부터 최근 5봉
    assert {b["priceSource"] for b in etf["bars"]} == {"TOSS_DAILY"}
    assert {b["priceSource"] for b in stock["bars"]} == {"TOSS_INTEGRATED"}    # NXT 종목 = KRX+NXT 통합가
    last = stock["bars"][-1]
    assert (last["open"], last["close"], last["volume"], last["adjClose"]) == (995.0, 1005.0, 1000, 505.0)
    assert last["adjRatio"] == pytest.approx(505 / 1005)
    assert last["minute"] == {"status": "OK", "priceSource": "TOSS_1M_OPEN",
                              "opens": {"09:01": {"open": 1091.0, "volume": 777}, "10:01": {"open": 1095.0, "volume": 900}}}
    assert all("minute" not in bar for bar in stock["bars"][:-1])             # 처음 보는 종목은 최신 봉만
    assert stock["adjBasisChanged"] is False and "isStale" not in stock
    assert detail == "세션 2026-10-27 · 2/2 종목 · 1분봉 개장 2건 · 호출 7회"
    series = store.read_timeseries(catalog.TS_KR_CLOSE_ADJ, "005930")
    assert [(p["date"], p["value"]) for p in series] == [(day, 500.0 + i) for i, day in enumerate(DAYS) if i]


def test_그날_받았으면_다시_돌아도_호출_0회(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500"])
    _standard(toss, ["069500"])
    tasks.task_kr_paper_quotes()
    toss.calls.clear()

    clock(datetime(2026, 10, 28, 7, 0, tzinfo=KST))     # 다음 날 아침 — 아직 20:30 전이라 대상은 10-27
    assert tasks.task_kr_paper_quotes() == "최신 상태 (세션 2026-10-27, 1종목, 호출 0회)"
    assert toss.calls == []


def test_20시30분_전에는_전_거래일이_대상이고_장중_봉은_버린다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500"])
    _standard(toss, ["069500"])
    clock(datetime(2026, 10, 27, 15, 0, tzinfo=KST))

    tasks.task_kr_paper_quotes()

    payload = _payload(store)
    assert payload["session"] == "2026-10-26"
    assert [b["date"] for b in payload["codes"]["069500"]["bars"]] == DAYS[:5]   # 10-27 장중 봉 없음
    assert [p["date"] for p in store.read_timeseries(catalog.TS_KR_CLOSE_ADJ, "069500")][-1] == "2026-10-26"
    assert ("069500", "1m", "2026-10-26T10:01:00+09:00") in toss.calls


def test_주말에는_금요일이_대상(toss):
    assert kr_paper.kr_target_session(datetime(2026, 10, 25, 23, 0, tzinfo=KST)).isoformat() == "2026-10-23"
    assert kr_paper.kr_target_session(datetime(2026, 10, 26, 20, 29, tzinfo=KST)).isoformat() == "2026-10-23"
    assert kr_paper.kr_target_session(datetime(2026, 10, 26, 20, 30, tzinfo=KST)).isoformat() == "2026-10-26"


def test_일부_실패는_그_종목만_직전_값을_isStale로_잇는다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500", "005930"])
    _standard(toss, ["069500", "005930"])
    tasks.task_kr_paper_quotes()
    before = _payload(store)["codes"]["005930"]

    clock(datetime(2026, 10, 28, 21, 0, tzinfo=KST))
    toss.errors[("005930", "raw")] = toss_service.TossError("HTTP 500")
    detail = tasks.task_kr_paper_quotes()

    codes = _payload(store)["codes"]
    assert codes["069500"]["fetchedAt"] != before["fetchedAt"] and "isStale" not in codes["069500"]
    carried = codes["005930"]
    assert carried["isStale"] is True and carried["staleSince"] and "HTTP 500" in carried["staleReason"]
    assert carried["bars"] == before["bars"] and carried["fetchedAt"] == before["fetchedAt"]
    assert "1/2 종목" in detail and "이전 값 1개(005930)" in detail

    toss.errors.clear()
    toss.calls.clear()
    tasks.task_kr_paper_quotes()                        # 같은 날 다음 주기 — 받지 못한 종목만
    assert {call[0] for call in toss.calls if call[1] != "info"} == {"005930"}


def test_전부_실패하면_EmptyResult이고_저장본을_덮지_않는다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500"])
    before = {"contract": 1, "session": "2026-10-26", "scope": ["069500"], "codes": {}}
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, before)
    toss.errors[("069500", "raw")] = toss_service.TossError("HTTP 503")

    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_quotes()

    assert "0/1 종목" in str(exc.value) and "HTTP 503" in str(exc.value)
    assert _payload(store) == before


def test_403이면_그_실행을_멈춘다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500", "153130", "005930"])
    _standard(toss, ["069500", "153130", "005930"])
    toss.errors[("153130", "raw")] = toss_service.TossForbidden("HTTP 403 — 허용 IP")

    detail = tasks.task_kr_paper_quotes()

    assert [c[0] for c in toss.calls if c[1] == "raw"] == ["069500", "153130"]   # 005930은 부르지 않음
    assert "1/3 종목" in detail and "허용 IP" in detail


def test_종목_상태에서_403이면_봉을_부르지_않는다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500"])
    toss.errors[("*", "info")] = toss_service.TossForbidden("HTTP 403 — 허용 IP")
    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_quotes()
    assert "허용 IP" in str(exc.value) and [c[1] for c in toss.calls] == ["info"]


def test_키가_없으면_EmptyResult(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500"])
    toss.errors[("*", "info")] = toss_service.TossMissingKey("TOSS_CLIENT_ID / TOSS_CLIENT_SECRET이 설정되지 않았습니다")
    with pytest.raises(tasks.EmptyResult) as exc:
        tasks.task_kr_paper_quotes()
    assert "TOSS_CLIENT_ID" in str(exc.value)


def test_봉이_0개면_응답에_없음_NO_BARS(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500", "999990"])
    _standard(toss, ["069500"])

    detail = tasks.task_kr_paper_quotes()

    gone = _payload(store)["codes"]["999990"]
    assert gone["status"] == "NO_BARS" and gone["bars"] == [] and "isStale" not in gone
    assert "2/2 종목(봉 없음 1)" in detail


def test_종목_상태가_실패하면_잘_안_바뀌는_칸만_잇고_정지_여부는_모름(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500"])
    _standard(toss, ["069500"], nxt={"069500": False})
    tasks.task_kr_paper_quotes()

    clock(datetime(2026, 10, 28, 21, 0, tzinfo=KST))
    toss.errors[("*", "info")] = toss_service.TossError("HTTP 500")
    detail = tasks.task_kr_paper_quotes()

    entry = _payload(store)["codes"]["069500"]
    assert entry["nxtSupported"] is False and entry["securityType"] == "ETF" and entry["krxTradingSuspended"] is None
    assert {b["priceSource"] for b in entry["bars"]} == {"TOSS_DAILY"}
    assert "종목 상태: HTTP 500" in detail


def test_수정주가_호출만_실패하면_비율은_모름이고_이력에_쓰지_않는다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500"])
    _standard(toss, ["069500"])
    toss.errors[("069500", "adj")] = toss_service.TossError("HTTP 500")

    detail = tasks.task_kr_paper_quotes()

    entry = _payload(store)["codes"]["069500"]
    assert entry["status"] == "OK" and {b["adjClose"] for b in entry["bars"]} == {None}
    assert {b["adjRatio"] for b in entry["bars"]} == {None}
    assert store.read_timeseries(catalog.TS_KR_CLOSE_ADJ, "069500") == []
    assert "069500 수정주가: HTTP 500" in detail


def test_수정주가_기준이_바뀌면_덧붙이지_않고_표시한다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["005930"])
    _standard(toss, ["005930"])
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, "005930", [("2026-10-23", 25_150.0)])   # 옛 기준(50배)

    detail = tasks.task_kr_paper_quotes()

    assert _payload(store)["codes"]["005930"]["adjBasisChanged"] is True
    assert store.read_timeseries(catalog.TS_KR_CLOSE_ADJ, "005930") == [{"date": "2026-10-23", "value": 25_150.0}]
    assert "수정주가 기준 바뀜 1(005930)" in detail


def test_1분봉_확정_결과는_다시_묻지_않고_실패는_다시_묻는다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["005930", "000660"])
    _standard(toss, ["005930", "000660"])
    toss.minute[("000660", "2026-10-27")] = [_bar("2026-10-27", 1, 5, "09:02")]       # 그날 개장 라벨 봉 없음
    toss.errors[("005930", "1m")] = toss_service.TossError("HTTP 500")
    tasks.task_kr_paper_quotes()
    first = _payload(store)["codes"]
    assert first["005930"]["bars"][-1]["minute"]["status"] == "FAILED"
    assert first["000660"]["bars"][-1]["minute"] == {"status": "NO_BAR", "priceSource": "TOSS_1M_OPEN", "opens": {}}

    clock(datetime(2026, 10, 28, 21, 0, tzinfo=KST))
    for code in ("005930", "000660"):
        toss.raw[code].append(_bar("2026-10-28", 2000))
        toss.adjusted[code].append(_bar("2026-10-28", 1000))
        toss.minute[(code, "2026-10-28")] = [_bar("2026-10-28", 2001, 10, "09:01")]
    toss.errors.clear()
    toss.minute[("005930", "2026-10-27")] = [_bar("2026-10-27", 1101, 777, "09:01")]
    toss.calls.clear()
    tasks.task_kr_paper_quotes()

    probes = [(c[0], c[2][:10]) for c in toss.calls if c[1] == "1m"]
    assert sorted(probes) == [("000660", "2026-10-28"), ("005930", "2026-10-27"), ("005930", "2026-10-28")]
    second = _payload(store)["codes"]
    assert second["005930"]["bars"][-2]["minute"]["status"] == "OK"                 # 10-27 다시 물어 채움
    assert second["000660"]["bars"][-2]["minute"]["status"] == "NO_BAR"             # 확정 결과는 옮김


def test_거래량_0인_봉은_1분봉을_묻지_않는다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["005930"])
    _standard(toss, ["005930"])
    toss.raw["005930"][-1] = _bar("2026-10-27", 1005, 0)     # 정지일

    tasks.task_kr_paper_quotes()

    assert [c for c in toss.calls if c[1] == "1m"] == []
    assert "minute" not in _payload(store)["codes"]["005930"]["bars"][-1]


def test_예산이_모자라면_일봉을_먼저_받고_나머지는_다음_주기(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500", "153130", "005930"])
    _standard(toss, ["069500", "153130", "005930"])
    monkeypatch.setattr(kr_paper, "KR_QUOTES_CALL_BUDGET", 1 + 2 * 2 + 1)    # 상태 1 + 두 종목 일봉 + 1분봉 1

    detail = tasks.task_kr_paper_quotes()

    codes = _payload(store)["codes"]
    assert set(codes) == {"069500", "153130"}
    assert [c[1] for c in toss.calls] == ["info", "raw", "adj", "raw", "adj", "1m"]
    assert "2/3 종목" in detail and "호출 예산 소진" in detail and "호출 6회" in detail
    assert codes["153130"]["bars"][-1]["minute"]["status"] == "FAILED"     # 못 물은 봉은 다음 수집이 다시 묻게

    monkeypatch.setattr(kr_paper, "KR_QUOTES_CALL_BUDGET", 500)
    toss.calls.clear()
    tasks.task_kr_paper_quotes()
    assert {c[0] for c in toss.calls if c[1] == "raw"} == {"005930"}
    assert set(_payload(store)["codes"]) == {"069500", "153130", "005930"}


def test_시간_상한이_지나면_새_종목을_시작하지_않는다(store, toss, clock, monkeypatch):
    _scope(monkeypatch, ["069500", "153130"])
    _standard(toss, ["069500", "153130"])
    ticks = iter([0.0, 0.0, kr_paper.KR_QUOTES_TIME_LIMIT_SECONDS + 1] + [10_000.0] * 20)
    monkeypatch.setattr(kr_paper, "_clock", lambda: next(ticks))

    detail = tasks.task_kr_paper_quotes()

    assert set(_payload(store)["codes"]) == {"069500"}
    assert "시간 상한 300초" in detail


def test_토스_키가_있을_때만_관측치_누락을_알린다(store, monkeypatch):
    from app import settings

    monkeypatch.setattr(settings, "toss_credentials", lambda: ("", ""))
    assert catalog.SNAP_KR_PAPER_QUOTES not in {entry["name"] for entry in store.missing_datasets()}
    monkeypatch.setattr(settings, "toss_credentials", lambda: ("cid", "secret"))
    assert catalog.SNAP_KR_PAPER_QUOTES in {entry["name"] for entry in store.missing_datasets()}
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, {"contract": 1, "codes": {}})
    assert catalog.SNAP_KR_PAPER_QUOTES not in {entry["name"] for entry in store.missing_datasets()}


def test_시간_상한은_slow_상한보다_짧다():
    assert kr_paper.KR_QUOTES_TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]


def test_slow에서_유니버스_바로_뒤에_돌고_태스크는_35개():
    task = tasks.TASKS_BY_NAME["kr_paper_quotes"]
    assert task.speed == "slow" and task.run is kr_paper.task_kr_paper_quotes
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("kr_paper_quotes") == names.index("kr_paper_universe") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 35
