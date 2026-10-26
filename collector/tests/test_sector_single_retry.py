"""
tests/test_sector_single_retry.py
배치(yf.download)에서 비어 온 티커만 개별로 다시 받기 — 상한·멈춤·Yahoo 공용 래치·이유 남기기 (v2 1단계 6번).

고정하는 규칙
  1. 배치에 없는 티커만 하나씩, Yahoo 호스트 간격을 두고 다시 받습니다. 받지 못한 티커는 이유(빈 응답·거부됨·상한 밖)가
     ``error``에 남습니다 — 예전에는 한 티커라도 받으면 error가 None이라 빠진 이유가 어디에도 없었습니다.
  2. 개별 재시도는 SINGLE_RETRY_MAX개까지. 배치·개별 모두 한 종목도 받지 못한 채 SINGLE_RETRY_STOP_AFTER번 연달아 실패하면
     멈춥니다(배치가 무엇이든 줬으면 출처는 살아 있어 폐지 티커가 몰려 있어도 멈추지 않음). 태스크 시간 예산이 모자라도 멈춥니다.
     상한·멈춤으로 묻지 못한 티커는 다음 실행에서 먼저 묻습니다 — 늘 비는 티커가 앞을 차지해도 뒤의 티커가 굶지 않게.
  3. 429(YFRateLimitError)는 Yahoo 공용 래치를 닫아 남은 개별 요청을 멈추고, 닫힌 동안에는 배치도 보내지 않습니다.
     같은 래치를 us_calendar·earnings_surprise·매크로 카드(market)·KRX 선물의 KODEX 폴백도 봅니다(같은 Yahoo 한도).
  4. 태스크는 빠진 티커를 직전 저장본으로 잇고(isStale), 그 staleReason에 '거부됨'이 실립니다(DB 필요한 테스트만 store).

yfinance는 바꿔 끼웁니다 — 네트워크에 나가지 않습니다.
"""
from __future__ import annotations

import time

import pandas as pd
import pytest
from yfinance.exceptions import YFRateLimitError

from app import catalog, http, paper_universe, tasks
from app.services import earnings_surprise as surprise_service
from app.services import krx, market, sector
from app.services import us_calendar as calendar_service


def _frame(*closes: float) -> pd.DataFrame:
    index = pd.to_datetime([f"2026-10-{day:02d}" for day in range(20, 20 + len(closes))])
    return pd.DataFrame({"Close": list(closes), "Volume": [1] * len(closes)}, index=index)


def _batch(present: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """yf.download(group_by='ticker')와 같은 (티커, 열) 2단 열."""
    return pd.concat(present, axis=1) if present else pd.DataFrame()


@pytest.fixture()
def yahoo(monkeypatch):
    """배치·개별 응답을 정하고 부른 기록을 남깁니다. 호스트 간격은 자지 않고 기록만 합니다."""
    state = {"batch": {}, "single": {}, "downloads": [], "singles": [], "paced": []}

    def download(tickers, **kwargs):
        state["downloads"].append(tickers.split())
        return _batch({t: f for t, f in state["batch"].items() if t in tickers.split()})

    def fetch_single(symbol, period):
        state["singles"].append(symbol)
        outcome = state["single"].get(symbol)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(sector.yf, "download", download)
    monkeypatch.setattr(sector, "_fetch_single", fetch_single)
    monkeypatch.setattr(http, "pace", lambda host, interval, jitter=http.HOST_JITTER_MAX:
                        state["paced"].append((host, interval)))
    sector._retry_resume.clear()        # 다음 시작 자리는 프로세스 메모리 — 테스트마다 비웁니다
    yield state
    sector._retry_resume.clear()


def test_배치에_빠진_티커만_하나씩_간격을_두고_다시_받고_이유를_남긴다(yahoo):
    yahoo["batch"] = {"AAA": _frame(1.0, 2.0)}
    yahoo["single"] = {"BBB": _frame(3.0), "CCC": None}

    result = sector.collect_etf_history(("AAA", "BBB", "CCC"))

    assert yahoo["singles"] == ["BBB", "CCC"], "배치에서 받은 AAA는 다시 묻지 않습니다"
    assert yahoo["paced"] == [(http.YAHOO_HOST, sector.YAHOO_SINGLE_INTERVAL)] * 2
    assert result["tickers"]["AAA"] == {"dates": ["2026-10-20", "2026-10-21"], "close": [1.0, 2.0]}
    assert result["tickers"]["BBB"]["close"] == [3.0]
    assert "CCC" not in result["tickers"], "받지 못한 티커를 0으로 채우지 않습니다"
    assert result["error"] == f"{sector.NO_USABLE_DATA}: 1개(CCC)"


def test_다_받으면_error는_None(yahoo):
    yahoo["batch"] = {"AAA": _frame(1.0)}
    yahoo["single"] = {"BBB": _frame(2.0)}

    assert sector.collect_etf_history(("AAA", "BBB"))["error"] is None


def test_개별_재시도는_상한까지만(yahoo, monkeypatch):
    monkeypatch.setattr(sector, "SINGLE_RETRY_MAX", 3)
    names = ("T1", "T2", "T3", "T4", "T5")
    yahoo["single"] = {name: _frame(1.0) for name in names}

    result = sector.collect_etf_history(names)

    assert yahoo["singles"] == ["T1", "T2", "T3"]
    assert sorted(result["tickers"]) == ["T1", "T2", "T3"]
    assert result["error"] == "개별 재시도 상한(3개) 밖 — 다음 실행: 2개(T4, T5)"


def test_한_종목도_못_받은_채_연달아_비면_멈춘다(yahoo):
    names = tuple(f"E{i}" for i in range(8))     # 배치도 비고 개별도 전부 빈 응답

    result = sector.collect_etf_history(names)

    assert yahoo["singles"] == list(names[:sector.SINGLE_RETRY_STOP_AFTER])
    assert result["tickers"] == {}
    # 예외도 429도 없이 비었으면 버전 안내를 앞에 둡니다(형식 변경 의심) — 멈춘 이유도 함께.
    assert result["error"].startswith("yfinance(") and "라이브러리 버전 불일치" in result["error"]
    assert f"{sector.NO_USABLE_DATA}: 5개(E0, E1, E2…)" in result["error"]
    assert "개별 재시도가 5번 연달아 실패해 멈춤 — 다음 실행: 3개(E5, E6, E7)" in result["error"]


def test_한_종목이라도_받았으면_연달아_비어도_상한까지_묻는다(yahoo):
    names = ("OK1", *(f"D{i}" for i in range(7)))
    yahoo["single"] = {"OK1": _frame(1.0)}

    result = sector.collect_etf_history(names)

    assert yahoo["singles"] == list(names), "폐지 티커가 몰려 있어도 받을 수 있는 티커를 버리지 않습니다"
    assert list(result["tickers"]) == ["OK1"]


def test_배치가_받았으면_앞의_폐지_티커가_연달아_비어도_뒤의_티커까지_묻는다(yahoo):
    """폐지 다섯 개가 유니버스 앞에 있고, 배치가 잠깐 놓친 정상 티커 둘이 뒤에 있음 — 예전에는 다섯 번째에서 멈춰 둘을 놓쳤습니다."""
    dead = tuple(f"D{i}" for i in range(sector.SINGLE_RETRY_STOP_AFTER))
    yahoo["batch"] = {"OK": _frame(1.0)}
    yahoo["single"] = {"GOOD1": _frame(2.0), "GOOD2": _frame(3.0)}

    result = sector.collect_etf_history((*dead, "GOOD1", "GOOD2", "OK"))

    assert yahoo["singles"] == [*dead, "GOOD1", "GOOD2"]
    assert sorted(result["tickers"]) == ["GOOD1", "GOOD2", "OK"]
    assert result["error"] == f"{sector.NO_USABLE_DATA}: 5개(D0, D1, D2…)"


def test_묻지_못한_티커는_다음_실행에서_먼저_묻는다(yahoo, monkeypatch):
    monkeypatch.setattr(sector, "SINGLE_RETRY_MAX", 3)
    names = ("T1", "T2", "T3", "T4", "T5")

    sector.collect_etf_history(names)
    second = sector.collect_etf_history(names)

    # 첫 실행은 T1~T3, 다음 실행은 남은 T4부터 한 바퀴(T4·T5·T1) — 상한 밖으로 밀린 티커가 계속 굶지 않습니다.
    assert yahoo["singles"] == ["T1", "T2", "T3", "T4", "T5", "T1"]
    assert second["error"].endswith("개별 재시도 상한(3개) 밖 — 다음 실행: 2개(T2, T3)")

    yahoo["single"] = {name: _frame(1.0) for name in names}
    yahoo["singles"].clear()
    sector.collect_etf_history(names)        # 앞 실행이 남긴 자리(T2)에서 이어 갑니다
    assert yahoo["singles"] == ["T2", "T3", "T4"]


def test_멈춘_자리도_다음_실행에서_먼저_묻는다(yahoo):
    names = tuple(f"E{i}" for i in range(8))     # 배치·개별 모두 빈 응답 — 다섯 번째에서 멈춤

    sector.collect_etf_history(names)
    yahoo["singles"].clear()
    sector.collect_etf_history(names)

    assert yahoo["singles"] == ["E5", "E6", "E7", "E0", "E1"]


def test_모두_조용히_비면_yfinance_버전을_사유로(yahoo):
    result = sector.collect_etf_history(("XLK", "XLF"))

    assert result["tickers"] == {}
    assert "yfinance(" in result["error"] and "Yahoo 차단 또는 라이브러리 버전 불일치" in result["error"]


def test_429면_Yahoo_래치를_닫아_남은_요청을_멈추고_다음_호출은_배치도_보내지_않는다(yahoo):
    yahoo["batch"] = {"AAA": _frame(1.0)}
    yahoo["single"] = {"BBB": YFRateLimitError(), "CCC": _frame(2.0)}

    first = sector.collect_etf_history(("AAA", "BBB", "CCC", "DDD"))

    assert yahoo["singles"] == ["BBB"], "429 뒤의 개별 요청은 나가지 않습니다"
    assert list(first["tickers"]) == ["AAA"]
    rejected = "거부됨 — finance.yahoo.com HTTP 429(요청 제한) · 5분 동안 이 출처 호출을 멈춤"
    assert first["error"] == f"{rejected}: 3개(BBB, CCC, DDD)", "거부된 티커는 '빈 응답'과 갈라 적습니다"

    second = sector.collect_etf_history(("AAA",))
    assert yahoo["downloads"] == [["AAA", "BBB", "CCC", "DDD"]], "래치가 닫힌 동안에는 배치도 보내지 않습니다"
    assert second == {"tickers": {}, "error": rejected}


def test_시간_예산이_모자라면_개별_재시도를_하지_않는다(yahoo):
    yahoo["single"] = {"AAA": _frame(1.0)}
    guard = http.TaskGuard(deadline=time.monotonic() + sector.SINGLE_RETRY_RESERVE_SECONDS - 1)

    result = http.run_guarded(guard, lambda: sector.collect_etf_history(("AAA",)))

    assert yahoo["singles"] == []
    assert result["error"] == "태스크 시간 예산이 모자라 멈춤 — 다음 실행: 1개(AAA)"


def test_다른_태스크가_닫은_Yahoo_래치를_실적_일정과_어닝도_본다(monkeypatch):
    def must_not_call(*args, **kwargs):
        raise AssertionError("래치가 닫힌 동안 yfinance를 부르면 안 됩니다")

    monkeypatch.setattr(calendar_service.yf, "Ticker", must_not_call)
    http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")

    with pytest.raises(calendar_service.RateLimited, match="거부됨 — finance.yahoo.com"):
        calendar_service.fetch_calendar_events("AAPL")
    with pytest.raises(surprise_service.RateLimited, match="거부됨 — finance.yahoo.com"):
        surprise_service.fetch_earnings("AAPL")


def test_매크로_카드와_KODEX_폴백도_Yahoo_래치를_본다(monkeypatch):
    def must_not_call(*args, **kwargs):
        raise AssertionError("래치가 닫힌 동안 yfinance를 부르면 안 됩니다")

    monkeypatch.setattr(market.yf, "Ticker", must_not_call)
    http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")
    rejected = "거부됨 — finance.yahoo.com HTTP 429(요청 제한) · 5분 동안 이 출처 호출을 멈춤"

    card = market.collect_ticker("CL=F", "5d")
    assert card["points"] == [] and card["error"] == rejected, "없는 숫자를 만들지 않고 사유만 남깁니다"
    assert market.last_two_closes("069500.KS") == (None, None, rejected)

    fallback = krx._fallback_from_kodex(20)
    assert fallback["rows"] == [] and fallback["isEstimated"] is True
    assert fallback["error"].endswith(rejected)


def test_매크로_카드와_KODEX_폴백의_429는_Yahoo_래치를_닫는다(monkeypatch):
    asked: list[str] = []

    class Ticker:
        def __init__(self, symbol):
            asked.append(symbol)

        def history(self, **kwargs):
            raise YFRateLimitError()

    monkeypatch.setattr(market.yf, "Ticker", Ticker)

    card = market.collect_ticker("CL=F", "5d")
    assert card["error"].startswith("거부됨 — finance.yahoo.com HTTP 429")
    assert http.active_rejection(http.YAHOO_HOST) is not None

    http.reset_guards()
    asked.clear()
    fallback = krx._fallback_from_kodex(20)
    assert asked == ["069500.KS"], "429 뒤에 ^KS200을 또 묻지 않습니다"
    assert "거부됨 — finance.yahoo.com HTTP 429" in fallback["error"]
    assert http.active_rejection(http.YAHOO_HOST) is not None


@pytest.mark.parametrize("fetch", [calendar_service.fetch_calendar_events, surprise_service.fetch_earnings],
                         ids=["us_calendar", "earnings_surprise"])
def test_실적_호출의_429는_Yahoo_래치를_닫는다(monkeypatch, fetch):
    class Quote:
        def _fetch(self, modules):
            raise YFRateLimitError()

    class Ticker:
        def __init__(self, symbol):
            self._quote = Quote()

    monkeypatch.setattr(calendar_service.yf, "Ticker", Ticker)

    with pytest.raises(calendar_service.RateLimited, match=r"^Yahoo 429\(요청 제한\)$"):
        fetch("AAPL")
    assert http.active_rejection(http.YAHOO_HOST) is not None


# ==============================================================================
# 태스크 — 이어받기와 실행 기록 (PostgreSQL)
# ==============================================================================
_OLD = {"dates": ["2026-10-15", "2026-10-16"], "close": [90.0, 91.0]}


def test_거부로_빠진_티커는_직전_값을_잇고_사유에_거부됨이_실린다(store, monkeypatch, yahoo):
    monkeypatch.setattr(paper_universe, "tradable", lambda: ("AAA", "BBB"))
    store.put_snapshot(catalog.SNAP_PAPER_QUOTES, {"period": "3mo", "tickers": {"AAA": _OLD, "BBB": _OLD},
                                                   "universe": ["AAA", "BBB"]})
    yahoo["batch"] = {"AAA": _frame(100.0, 101.0)}
    yahoo["single"] = {"BBB": YFRateLimitError()}

    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["paper_quotes"])

    saved = store.read_snapshot(catalog.SNAP_PAPER_QUOTES).payload["tickers"]
    assert saved["AAA"]["close"] == [100.0, 101.0] and "isStale" not in saved["AAA"]
    assert saved["BBB"]["close"] == _OLD["close"] and saved["BBB"]["isStale"] is True
    assert saved["BBB"]["staleReason"].startswith("거부됨 — finance.yahoo.com HTTP 429")
    assert ok is True
    assert detail.startswith("1/2 티커 · 이전 값 1개(BBB)")
    assert detail.endswith(" · 거부됨: finance.yahoo.com(HTTP 429(요청 제한))")
    assert store.read_task_history("paper_quotes")[0]["status"] == "ok"


def test_래치가_닫혀_아무것도_못_받으면_저장본을_두고_거부됨으로_기록(store, monkeypatch, yahoo):
    monkeypatch.setattr(paper_universe, "tradable", lambda: ("AAA", "BBB"))
    before = {"period": "3mo", "tickers": {"AAA": _OLD, "BBB": _OLD}, "universe": ["AAA", "BBB"]}
    store.put_snapshot(catalog.SNAP_PAPER_QUOTES, before)
    http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")     # 다른 Yahoo 태스크가 방금 거부를 받음

    ok, detail = tasks.run_task(tasks.TASKS_BY_NAME["paper_quotes"])

    assert yahoo["downloads"] == []
    assert store.read_snapshot(catalog.SNAP_PAPER_QUOTES).payload == before
    recorded = store.read_task_history("paper_quotes")[0]
    assert ok is False and recorded["status"] == "error"
    assert detail.startswith("거부됨: finance.yahoo.com(HTTP 429(요청 제한))가 요청을 거부")
    assert "0/2 티커 — 기존 저장본 유지" in detail
