"""
tests/test_paper_bars.py
🧪 미국 Claude 계좌2 단계 0 측정 — 태스크 paper_bars_us → 스냅샷 paper.bars.us (명세 2026-10-30-claude-book2-timing-design.md §12-1~12-3·§19, ADR 0022).

고정하는 규칙
  1. 범위 = Claude 계좌1·계좌2의 대기 주문 ∪ 최근 8일 주문(상태 무관) ∪ 계좌2 보유 — 백엔드 표를 읽기만(읽기 전용 트랜잭션에서도 돎).
     범위가 비면 EmptyResult이고 Yahoo를 부르지 않는다(SPY 혼자서는 묻지 않음).
  2. 메뉴 창 시각은 그 세션 날짜의 America/New_York 시각 — 2026-10-30(EDT) 09:30 ET = 13:30Z, 2026-11-02(EST) 09:30 ET = 14:30Z.
     조기 폐장일(2026-11-27)은 13:00 뒤 창이 null. 창에는 거래량 0 봉도 그대로, firstTradeAfter는 거래량 > 0 봉만(없으면 null).
  3. lagSeconds는 SPY 정규장 안에서 받은 저장본만(장 밖·다른 날·이어받은 SPY는 null — 0으로 채우지 않음), declaredDelayMin은 늘 null.
  4. Yahoo 래치가 닫혀 있으면 묻지 않고, 배치 안의 429(yfinance가 로그로만 남김)도 래치를 닫는다. 두 회차 연달아 429면 한 회차를 쉰다.
  5. 기동 뒤 처음 받을 때까지 period "5d", 받은 뒤 "1d". 일봉 시가(X2)는 확정된 세션마다 배치 한 번.
  6. 받지 못한 종목은 직전 값을 isStale로 잇고, 하나도 못 받으면 EmptyResult로 저장본을 둔다. 세션은 종목마다 최근 3개.
  7. 이 저장본을 읽는 백엔드·화면 코드는 아직 없다(장부·패킷 그대로 — 단계 0-4의 실행 감사 작업부터).

외부 네트워크를 쓰지 않습니다 — 1분봉 표는 yfinance 1.7.0 yf.download(group_by="ticker")의 모양(종목 × Open·High·Low·Close·Adj Close·Volume,
종목들의 분을 합친 인덱스 — 봉이 없던 분은 NaN 줄)을 합성해 만듭니다. 태스크·범위 시험은 PostgreSQL이 필요합니다.
"""
from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from yfinance.exceptions import YFRateLimitError

from app import catalog, http, tasks
from app.services import market as market_service
from app.tasks import paper_bars
from app.tasks.base import EmptyResult

ROOT = Path(__file__).resolve().parents[2]
NY = ZoneInfo("America/New_York")
UTC = timezone.utc
FIELDS = ["Open", "High", "Low", "Close", "Adj Close", "Volume"]


@pytest.fixture(autouse=True)
def _fresh_process(monkeypatch):
    """태스크의 프로세스 상태(5d 따라잡기·429 횟수)를 시험마다 기동 직후로 둡니다."""
    monkeypatch.setattr(paper_bars, "_caught_up", False)
    monkeypatch.setattr(paper_bars, "_rejected_rounds", 0)
    monkeypatch.setattr(paper_bars, "_rest_rounds", 0)


def _at(day: date, hh: int, mm: int) -> datetime:
    return datetime.combine(day, time(hh, mm), tzinfo=NY).astimezone(UTC)


def _rows(day: date, start: time, end: time, price: float = 100.0, volume: int | None = 10) -> list[dict]:
    """day의 start ~ end(포함, 뉴욕 시각) 1분봉 줄 — market.minute_bars가 돌려주는 모양."""
    out = []
    at = datetime.combine(day, start, tzinfo=NY)
    while at.time() <= end:
        out.append({"at": at.astimezone(UTC), "open": price, "high": price + 1, "low": price - 1, "close": price + 0.5,
                    "volume": volume})
        price += 0.1
        at += timedelta(minutes=1)
    return out


def _session(day: date, last: time = time(15, 59)) -> list[dict]:
    return _rows(day, time(9, 30), last)


# ==============================================================================
# 1. 등록·이름·백엔드와 같은 글자
# ==============================================================================
def test_slow에서_paper_quotes_바로_뒤에_돌고_태스크는_38개():
    task = tasks.TASKS_BY_NAME["paper_bars_us"]
    assert task.speed == "slow" and task.run is paper_bars.task_paper_bars_us
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("paper_bars_us") == names.index("paper_quotes") + 1, "같은 Yahoo 래치 — 관측치를 먼저 받음(§12-2)"
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 38  # 장중 평가 paper_live_us·paper_live_kr·계좌2 단계 0의 paper_bars_us까지


def test_데이터셋_이름():
    assert catalog.SNAP_PAPER_BARS_US == "paper.bars.us"


def test_메뉴_시점은_V17_timing_CHECK와_같은_글자():
    """수집기의 시각 지정 시점 목록 = DB가 받는 시점(V17). 백엔드 상수는 단계 1(1-4·1-5)에서 생기면 그 커밋이 여기에 대조를 더합니다."""
    sql = next((ROOT / "db/migrations").glob("V17__*.sql")).read_text(encoding="utf-8")
    check = re.search(r"CHECK \(timing IN \(([^)]*)\)\)", sql)
    assert check, "V17에서 paper_orders.timing CHECK를 찾지 못했습니다"
    allowed = set(re.findall(r"'([A-Z_0-9]+)'", check.group(1)))
    assert set(paper_bars.MENU) <= allowed
    assert {value for value in allowed if value.startswith("AT_")} == {key for key in paper_bars.MENU if key.startswith("AT_")}
    assert paper_bars.MENU["NEXT_OPEN"] == time(9, 30)
    assert all(paper_bars.MENU[key] == time(int(key[3:5]), 0) for key in paper_bars.MENU if key.startswith("AT_"))


def test_범위_계좌_코드는_백엔드_PaperBooks와_같다():
    java = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/PaperBooks.java").read_text(encoding="utf-8")
    claude = re.search(r'static final String CLAUDE = "([^"]+)";', java).group(1)
    pending = re.search(r'static final String ORDER_PENDING = "([^"]+)";', java).group(1)
    store_module = paper_bars.store
    assert store_module.TIMED_ORDER_BOOKS["US"][0] == claude == "claude"
    assert "claude2" in store_module.TIMED_ORDER_BOOKS["US"] and store_module.TIMED_HOLDING_BOOKS["US"] == ("claude2",)
    assert pending == "PENDING"
    assert store_module.TIMED_RECENT_DAYS == 8


def test_1분봉_저장본을_읽는_백엔드_코드는_실행_감사_작업뿐이고_화면은_읽지_않는다():
    """단계 0은 재기만 합니다 — 읽는 곳은 실행 감사 작업(0-4, 반사실·지연을 paper_order_exec에)뿐이고 계좌1의 결정·패킷·장부는 그대로.
    시각 지정 체결(단계 1-4)이 장부에서 읽기 시작하면 그 커밋이 이 시험을 고칩니다."""
    readers = []
    for folder in (ROOT / "backend/src/main/java", ROOT / "frontend/src"):
        if not folder.exists():
            continue
        for path in folder.rglob("*"):
            if path.suffix in (".java", ".ts", ".tsx") and path.is_file():
                text = path.read_text(encoding="utf-8")
                if "SNAP_PAPER_BARS_US" in text or "paper.bars.us" in text:
                    readers.append(path.relative_to(ROOT).as_posix())
    assert sorted(readers) == ["backend/src/main/java/com/macrodash/feature/paper/PaperExecutionAuditJob.java",
                               "backend/src/main/java/com/macrodash/store/Datasets.java"]


# ==============================================================================
# 2. 메뉴 창·첫 거래 봉·합치기·지연 (DB·네트워크 없음)
# ==============================================================================
FETCHED = datetime(2026, 11, 2, 22, 0, tzinfo=UTC)


@pytest.mark.parametrize("day, open_utc, ten_utc", [
    (date(2026, 10, 30), "2026-10-30T13:30:00+00:00", "2026-10-30T14:00:00+00:00"),   # EDT(UTC−4)
    (date(2026, 11, 2), "2026-11-02T14:30:00+00:00", "2026-11-02T15:00:00+00:00"),    # EST(UTC−5) — 11-01 서머타임 끝
])
def test_창_시각은_그_세션_날짜의_뉴욕_시각이다(day, open_utc, ten_utc):
    entry = paper_bars.session_entries(_session(day), FETCHED)[day.isoformat()]

    assert [bar["t"] for bar in entry["windows"]["09:30"]] == [
        (datetime.fromisoformat(open_utc) + timedelta(minutes=i)).isoformat() for i in range(5)], "09:30~09:34 다섯 봉, 09:35는 밖"
    assert entry["windows"]["10:00"][0]["t"] == ten_utc
    assert set(entry["windows"]) == {"09:30", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"}
    assert entry["firstBar"] == {"t": open_utc, "o": 100.0, "v": 10}
    assert entry["lastBar"]["t"] == _at(day, 15, 59).isoformat() and entry["barCount"] == 390
    assert entry["firstTradeAfter"]["09:30"] == {"t": open_utc, "o": 100.0, "v": 10}
    assert entry["dailyOpen"] is None and entry["fetchedAt"] == FETCHED.isoformat()
    first = entry["windows"]["09:30"][0]
    assert set(first) == {"t", "o", "h", "l", "c", "v"} and first["h"] == 101.0 and first["c"] == 100.5


def test_조기_폐장일은_13시_뒤_창과_첫_거래_봉이_null이다():
    day = date(2026, 11, 27)   # 추수감사절 다음 날 13:00 마감(백엔드 UsMarketCalendar) — 수집기는 달력을 모르고 봉이 없을 뿐
    entry = paper_bars.session_entries(_session(day, last=time(12, 59)), FETCHED)[day.isoformat()]

    assert entry["windows"]["12:00"] is not None and len(entry["windows"]["12:00"]) == 5
    assert entry["windows"]["13:00"] is None and entry["windows"]["14:00"] is None and entry["windows"]["15:00"] is None
    assert entry["firstTradeAfter"]["13:00"] is None and entry["firstTradeAfter"]["15:00"] is None
    assert entry["lastBar"]["t"] == "2026-11-27T17:59:00+00:00" and entry["barCount"] == 210


def test_첫_거래_봉은_거래량_0을_건너뛰고_창_밖까지_찾으며_없으면_null():
    day = date(2026, 10, 30)
    rows = (_rows(day, time(9, 30), time(10, 6), volume=0)          # 10:00 창 다섯 봉 모두 거래량 0
            + _rows(day, time(10, 7), time(10, 7), price=50.0, volume=300)
            + _rows(day, time(10, 8), time(15, 59), volume=None))    # 거래량을 모르는 봉은 거래로 보지 않음
    entry = paper_bars.session_entries(rows, FETCHED)[day.isoformat()]

    assert [bar["v"] for bar in entry["windows"]["10:00"]] == [0, 0, 0, 0, 0], "창에는 받은 거래량 그대로(0도)"
    assert entry["firstTradeAfter"]["09:30"] == {"t": _at(day, 10, 7).isoformat(), "o": 50.0, "v": 300}
    assert entry["firstTradeAfter"]["10:00"] == {"t": _at(day, 10, 7).isoformat(), "o": 50.0, "v": 300}, "창(10:00~10:04) 밖의 첫 거래"
    assert entry["firstTradeAfter"]["11:00"] is None, "11:00 뒤 거래량 > 0 봉 없음(거래 정지·무거래 가능 — T18은 백엔드가 판정)"
    assert entry["windows"]["11:00"] is not None and entry["windows"]["11:00"][0]["v"] is None


def test_봉_라벨이_끝이면_저장하는_t는_라벨_1분_전(monkeypatch):
    day = date(2026, 10, 30)
    rows = _rows(day, time(9, 31), time(9, 40))   # 끝 라벨 09:31 = 09:30에 시작한 봉
    monkeypatch.setattr(paper_bars, "BAR_LABEL", "END")
    entry = paper_bars.session_entries(rows, FETCHED)[day.isoformat()]
    assert entry["windows"]["09:30"][0]["t"] == "2026-10-30T13:30:00+00:00"
    assert entry["firstBar"]["t"] == "2026-10-30T13:30:00+00:00"


def test_세션_합치기는_최근_3개와_더_늦게까지_본_쪽을_남긴다():
    def entry(last_hhmm: str, daily=None) -> dict:
        return {"lastBar": {"t": f"2026-10-30T{last_hhmm}:00+00:00"}, "dailyOpen": daily, "barCount": 1}

    before = {"2026-10-27": entry("19:59"), "2026-10-28": entry("19:59"), "2026-10-29": entry("19:59", daily=10.0),
              "2026-10-30": entry("18:00")}
    fresh = {"2026-10-29": entry("19:59"), "2026-10-30": entry("15:00")}   # 10-30은 더 짧게 옴(Yahoo가 덜 줌)

    merged = paper_bars.merge_sessions(fresh, before)

    assert list(merged) == ["2026-10-28", "2026-10-29", "2026-10-30"]
    assert merged["2026-10-30"]["lastBar"]["t"] == "2026-10-30T18:00:00+00:00", "이미 받은 창을 잃지 않음"
    assert merged["2026-10-29"] is not before["2026-10-29"] and merged["2026-10-29"]["dailyOpen"] == 10.0, "일봉 시가는 이어 둠"


def _spy(rows: list[dict], fetched: datetime) -> dict:
    """그 시각에 받은 SPY 항목 — 세션의 받은 시각 = 저장본의 받은 시각(태스크가 이번 회차에 받은 세션과 같은 모양)."""
    return {"sessions": paper_bars.session_entries(rows, fetched.astimezone(UTC))}


@pytest.mark.parametrize("fetched_et, expected", [
    (datetime(2026, 10, 30, 11, 5, 30, tzinfo=NY), 90),       # 정규장 — 11:05:30 − (11:03 + 60초)
    (datetime(2026, 10, 30, 9, 29, tzinfo=NY), None),         # 개장 전
    (datetime(2026, 10, 30, 16, 0, tzinfo=NY), None),         # 마감 뒤
    (datetime(2026, 10, 31, 11, 5, tzinfo=NY), None),         # 다른 날(토요일) — 장이 닫힌 시간은 지연이 아님
])
def test_지연은_SPY_정규장_안에서_받은_저장본만(fetched_et, expected):
    spy = _spy(_rows(date(2026, 10, 30), time(9, 30), time(11, 3)), fetched_et)
    assert paper_bars.lag_seconds(fetched_et.astimezone(UTC), spy) == expected


def test_지연은_이어받은_SPY·진행_중_봉·조기_폐장_뒤를_가린다():
    rows = _rows(date(2026, 10, 30), time(9, 30), time(11, 5))
    forming = datetime(2026, 10, 30, 11, 5, 20, tzinfo=NY)
    assert paper_bars.lag_seconds(forming, _spy(rows, forming)) == -40, "진행 중인 봉까지 받으면 음수(X1 단서)"
    later = datetime(2026, 10, 30, 11, 6, tzinfo=NY)
    assert paper_bars.lag_seconds(later, {**_spy(rows, later), "isStale": True}) is None
    assert paper_bars.lag_seconds(later, None) is None

    early_rows = _session(date(2026, 11, 27), last=time(12, 59))

    def early(hh: int, mm: int, ss: int = 0) -> int | None:
        at = datetime(2026, 11, 27, hh, mm, ss, tzinfo=NY)
        return paper_bars.lag_seconds(at, _spy(early_rows, at))

    assert early(13, 55) is None, "조기 폐장 — 닫힌 시간을 지연으로 적지 않음"
    assert early(13, 0, 30) is None, "13:00 직후도 가림(구분 불가)"
    assert early(12, 59, 50) == -10, "13:00 전은 그대로 잼"


@pytest.mark.xfail(strict=True, reason="이번 회차에 받지 않은(직전 저장본에서 남긴) SPY 세션으로 지연을 잼 — 수정 전")
def test_지연은_이번_회차에_받은_SPY_세션만이고_짧게_온_응답으로_남긴_세션은_null():
    """Yahoo가 이번에 더 짧게 줘 merge_sessions가 직전 세션을 남기면 그 마지막 봉은 이번 응답의 것이 아닙니다 — 지금 받은 시각과 섞으면
    직전 회차보다 한 시간 긴 값(3600초)이 되고, 이번 응답의 실제 지연(10:30 봉까지 → 5040초)과도 다릅니다. 모르는 값은 null."""
    day = date(2026, 10, 30)
    first = datetime(2026, 10, 30, 10, 55, tzinfo=NY)
    before = _spy(_rows(day, time(9, 30), time(10, 54)), first)["sessions"]
    assert paper_bars.lag_seconds(first, {"sessions": before}) == 0, "10:55:00 − (10:54 + 60초)"

    second = datetime(2026, 10, 30, 11, 55, tzinfo=NY)
    kept = paper_bars.merge_sessions(_spy(_rows(day, time(9, 30), time(10, 30)), second)["sessions"], before)
    assert kept[day.isoformat()] == before[day.isoformat()], "이미 받은 세션을 남김(받은 시각도 직전 회차 그대로)"
    assert paper_bars.lag_seconds(second, {"sessions": kept}) is None

    third = datetime(2026, 10, 30, 12, 55, tzinfo=NY)
    again = paper_bars.merge_sessions(_spy(_rows(day, time(9, 30), time(12, 53)), third)["sessions"], kept)
    assert paper_bars.lag_seconds(third, {"sessions": again}) == 60, "다시 더 늦게까지 받은 세션은 그대로 잼"


# ==============================================================================
# 3. 1분봉 배치(yf.download 합성 표) — 빈 줄·래치·배치 안의 429
# ==============================================================================
def _frame(per_ticker: dict[str, list[tuple[str, float | None, float | None]]]) -> pd.DataFrame:
    """{T: [(뉴욕 'YYYY-MM-DD HH:MM', 가격 또는 None, 거래량 또는 None)]} → yf.download(group_by="ticker") 모양의 표(종목들의 분을 합친 인덱스)."""
    stamps = sorted({stamp for rows in per_ticker.values() for stamp, _, _ in rows})
    index = pd.DatetimeIndex(stamps).tz_localize("America/New_York")
    columns = pd.MultiIndex.from_product([list(per_ticker), FIELDS])
    frame = pd.DataFrame(index=index, columns=columns, dtype=float)
    for ticker, rows in per_ticker.items():
        for stamp, price, volume in rows:
            at = pd.Timestamp(stamp).tz_localize("America/New_York")
            for field in ("Open", "High", "Low", "Close", "Adj Close"):
                frame.loc[at, (ticker, field)] = price
            frame.loc[at, (ticker, "Volume")] = volume
    return frame


def test_1분봉_배치는_원시가_정규장으로_받고_빈_줄을_버린다(monkeypatch):
    frame = _frame({
        "AAA": [("2026-10-30 09:30", 100.0, 1200.0), ("2026-10-30 09:31", 100.5, 0.0)],
        "BBB": [("2026-10-30 09:31", 50.0, None)],     # 09:30에는 봉이 없음 → 합친 표에서 NaN 줄
        "CCC": [("2026-10-30 09:30", 0.0, 10.0)],      # 0 이하 가격은 버림
    })
    seen = {}

    def fake_download(**kwargs):
        seen.update(kwargs)
        return frame

    monkeypatch.setattr(market_service.yf, "download", fake_download)

    rows, reason, limited = market_service.minute_bars(["AAA", "BBB", "CCC"], "5d")

    assert seen["interval"] == "1m" and seen["period"] == "5d" and seen["prepost"] is False and seen["auto_adjust"] is False
    assert seen["group_by"] == "ticker" and seen["tickers"] == "AAA BBB CCC"
    assert [(row["at"].isoformat(), row["open"], row["volume"]) for row in rows["AAA"]] == [
        ("2026-10-30T13:30:00+00:00", 100.0, 1200), ("2026-10-30T13:31:00+00:00", 100.5, 0)]
    assert [(row["at"].isoformat(), row["volume"]) for row in rows["BBB"]] == [("2026-10-30T13:31:00+00:00", None)]
    assert "CCC" not in rows and reason == "받지 못함 1개(CCC)" and limited is False


def test_배치_안의_429는_로그로만_와도_래치를_닫는다(monkeypatch):
    """yfinance 1.7.0은 종목별 YFRateLimitError를 삼키고 부른 스레드에서 'yfinance' 로거에 한 줄만 찍습니다(multi._download_impl)."""
    frame = _frame({"AAA": [("2026-10-30 09:30", 100.0, 10.0)], "BBB": [("2026-10-30 09:30", None, None)]})

    def fake_download(**kwargs):
        logging.getLogger("yfinance").error("['BBB']: YFRateLimitError('Too Many Requests. Rate limited. Try after a while.')")
        return frame

    monkeypatch.setattr(market_service.yf, "download", fake_download)

    rows, reason, limited = market_service.minute_bars(["AAA", "BBB"], "1d")

    assert limited is True and list(rows) == ["AAA"], "받은 종목은 그대로 씀"
    assert http.REJECTED_MARK in reason and "받지 못함 1개(BBB)" in reason
    assert http.active_rejection(http.YAHOO_HOST) is not None, "공용 래치가 닫힘 — paper_quotes 등도 5분 동안 묻지 않음"


def test_다른_스레드의_429_로그는_세지_않는다(monkeypatch):
    import threading

    def fake_download(**kwargs):
        worker = threading.Thread(target=lambda: logging.getLogger("yfinance").error("['X']: YFRateLimitError('Too Many Requests')"))
        worker.start()
        worker.join()
        return _frame({"AAA": [("2026-10-30 09:30", 100.0, 10.0)]})

    monkeypatch.setattr(market_service.yf, "download", fake_download)
    _, reason, limited = market_service.minute_bars(["AAA"], "1d")
    assert limited is False and reason is None and http.active_rejection(http.YAHOO_HOST) is None


def test_배치가_429를_올리면_래치를_닫고_래치가_닫혀_있으면_묻지_않는다(monkeypatch):
    def limited_download(**kwargs):
        raise YFRateLimitError()

    monkeypatch.setattr(market_service.yf, "download", limited_download)
    rows, reason, limited = market_service.minute_bars(["AAA"], "1d")
    assert rows == {} and limited is True and http.REJECTED_MARK in reason

    def boom(**kwargs):
        raise AssertionError("래치가 닫혔는데 Yahoo를 불렀습니다")

    monkeypatch.setattr(market_service.yf, "download", boom)
    rows, reason, limited = market_service.minute_bars(["AAA"], "1d")
    assert rows == {} and limited is False and http.REJECTED_MARK in reason
    opens, reason, limited = market_service.daily_opens(["AAA"], "5d")
    assert opens == {} and limited is False and http.REJECTED_MARK in reason


def test_일봉_시가는_원시가_일봉_배치(monkeypatch):
    index = pd.DatetimeIndex(["2026-10-29", "2026-10-30"])   # 일봉은 시간대 없는 날짜(ignore_tz)
    frame = pd.DataFrame([[10.0, 11.0, 9.0, 10.5, 10.5, 100.0, 20.0, 21.0, 19.0, 20.5, 20.5, 5.0],
                          [10.6, 11.0, 9.0, 10.5, 10.5, 100.0, float("nan")] + [float("nan")] * 5],
                         index=index, columns=pd.MultiIndex.from_product([["AAA", "BBB"], FIELDS]))
    seen = {}

    def fake_download(**kwargs):
        seen.update(kwargs)
        return frame

    monkeypatch.setattr(market_service.yf, "download", fake_download)
    opens, reason, limited = market_service.daily_opens(["AAA", "BBB"], "5d")

    assert seen["interval"] == "1d" and seen["auto_adjust"] is False and seen["period"] == "5d"
    assert opens == {"AAA": {"2026-10-29": 10.0, "2026-10-30": 10.6}, "BBB": {"2026-10-29": 20.0}}
    assert reason is None and limited is False


# ==============================================================================
# 4. 범위 읽기 (PostgreSQL)
# ==============================================================================
def _book(store, code: str, market: str = "US", kind: str = "CLAUDE") -> None:
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
            "VALUES (%s, %s, %s, 100000, %s, 'ACTIVE', %s, %s)",
            (code, kind, code, date(2026, 10, 23), market, "USD" if market == "US" else "KRW"),
        )


def _order(store, book: str, ticker: str, status: str, days_ago: int) -> None:
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_orders (book_code, ticker, side, timing, source, status, as_of_trading_date, created_at) "
            "VALUES (%s, %s, 'BUY', 'NEXT_OBSERVATION', 'CLAUDE', %s, %s, now() - make_interval(days => %s))",
            (book, ticker, status, date(2026, 10, 29), days_ago),
        )


def _hold(store, book: str, ticker: str) -> None:
    now = datetime(2026, 10, 23, 20, 0, tzinfo=UTC)
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_positions (book_code, ticker, qty, avg_cost, opened_on, opened_at, high_watermark, "
            "watermark_at, fill_ref_date, fill_ref_close) VALUES (%s, %s, 10, 100, %s, %s, 100, %s, %s, 100)",
            (book, ticker, date(2026, 10, 23), now, now, date(2026, 10, 23)),
        )


def test_범위는_Claude_계좌의_대기·최근_8일_주문과_계좌2_보유이고_읽기만_한다(store, monkeypatch):
    _book(store, "claude")
    _book(store, "claude2")
    _book(store, "rules", kind="RULES")
    _book(store, "kr_claude", market="KR")
    _order(store, "claude", "OLDP", "PENDING", 20)      # 오래됐어도 대기 → 넣음
    _order(store, "claude", "RECENT", "FILLED", 2)      # 최근 8일 → 상태 무관 넣음
    _order(store, "claude", "REJ", "REJECTED", 7)
    _order(store, "claude", "STALE", "FILLED", 9)       # 9일 전 체결 → 뺌
    _order(store, "claude2", "TIMED", "PENDING", 0)
    _order(store, "rules", "RULEP", "PENDING", 0)       # 규칙 계좌 → 뺌
    _order(store, "kr_claude", "005930", "PENDING", 0)  # 한국 → 뺌
    _hold(store, "claude2", "HELD2")
    _hold(store, "claude", "HELD1")                     # 계좌1 보유는 범위 밖(주문만)
    _order(store, "claude", "TIMED", "PENDING", 1)      # 중복 없음

    @contextmanager
    def read_only():
        with store.get_pool().connection() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            yield conn

    monkeypatch.setattr(store, "connection", read_only)

    assert store.timed_scope("US") == ["HELD2", "OLDP", "RECENT", "REJ", "TIMED"]
    assert store.timed_scope("KR") == []


# ==============================================================================
# 5. 태스크 (PostgreSQL — 범위·1분봉은 바꿔 끼움)
# ==============================================================================
DAY = date(2026, 10, 30)


@pytest.fixture()
def clock(monkeypatch):
    def pin(when: datetime) -> datetime:
        monkeypatch.setattr(paper_bars, "_now", lambda: when.astimezone(UTC))
        return when
    pin(datetime(2026, 10, 30, 11, 5, tzinfo=NY))   # 정규장(EDT) 11:05 ET = 00:05 KST
    return pin


@pytest.fixture()
def yahoo(monkeypatch):
    """1분봉·일봉 배치를 바꿔 끼웁니다. calls에 (종류, 티커, period)를 적고, minute에 돌려줄 값을 넣습니다."""
    state = {"calls": [], "minute": ({}, None, False), "daily": ({}, None, False)}

    def minute(tickers, period):
        state["calls"].append(("1m", tuple(tickers), period))
        return state["minute"]

    def daily(tickers, period):
        state["calls"].append(("1d", tuple(tickers), period))
        return state["daily"]

    monkeypatch.setattr(market_service, "minute_bars", minute)
    monkeypatch.setattr(market_service, "daily_opens", daily)
    return state


def test_범위가_비면_Yahoo를_부르지_않는다(store, monkeypatch, yahoo):
    monkeypatch.setattr(store, "timed_scope", lambda market: [])
    with pytest.raises(EmptyResult, match="수집 범위가 비었습니다"):
        paper_bars.task_paper_bars_us()
    assert yahoo["calls"] == [] and store.read_snapshot(catalog.SNAP_PAPER_BARS_US) is None


def test_저장본_모양과_지연(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    yahoo["minute"] = ({"AAA": _rows(DAY, time(9, 30), time(11, 4)), "SPY": _rows(DAY, time(9, 30), time(11, 3))}, None, False)

    detail = paper_bars.task_paper_bars_us()

    assert yahoo["calls"] == [("1m", ("AAA", "SPY"), "5d")], "기동 뒤 첫 수집은 5d, SPY는 지연 기준으로 함께"
    payload = store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload
    assert payload["contract"] == 1 and payload["barLabel"] == "START" and payload["reference"] == "SPY"
    assert payload["menu"] == {"NEXT_OPEN": "09:30", "AT_1000": "10:00", "AT_1100": "11:00", "AT_1200": "12:00",
                               "AT_1300": "13:00", "AT_1400": "14:00", "AT_1500": "15:00"}
    assert payload["scope"] == ["AAA", "SPY"] and payload["period"] == "5d" and payload["missing"] == []
    assert payload["fetchedAt"] == "2026-10-30T15:05:00+00:00"
    assert payload["lagSeconds"] == 60, "11:05:00 − (SPY 11:03 + 60초)"
    assert payload["declaredDelayMin"] is None and payload["error"] is None and payload["dailyOpenSessions"] == {}
    aaa = payload["tickers"]["AAA"]["sessions"]["2026-10-30"]
    assert len(aaa["windows"]["11:00"]) == 5 and aaa["windows"]["12:00"] is None, "아직 오지 않은 창은 null"
    assert aaa["firstTradeAfter"]["12:00"] is None
    assert detail.startswith("2/2 종목 · 세션 2026-10-30 (period 5d)") and "지연 60초(SPY)" in detail


def test_한_번_받은_뒤로는_1d이고_실패한_첫_회차는_5d를_유지한다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    yahoo["minute"] = ({}, "빈 응답", False)
    with pytest.raises(EmptyResult, match="0/2 종목 — 기존 저장본 유지"):
        paper_bars.task_paper_bars_us()

    yahoo["minute"] = ({"AAA": _session(DAY), "SPY": _session(DAY)}, None, False)
    paper_bars.task_paper_bars_us()
    paper_bars.task_paper_bars_us()

    assert [call[2] for call in yahoo["calls"]] == ["5d", "5d", "1d"]


def test_래치가_닫혀_있으면_묻지_않는다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")   # 같은 회차의 paper_quotes가 받은 429
    with pytest.raises(EmptyResult, match=http.REJECTED_MARK):
        paper_bars.task_paper_bars_us()
    assert yahoo["calls"] == []


def test_두_회차_연달아_429면_한_회차를_쉰다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    yahoo["minute"] = ({"AAA": _session(DAY)}, "거부됨 — finance.yahoo.com HTTP 429", True)

    paper_bars.task_paper_bars_us()       # 1회차 429(받은 것은 저장)
    http.reset_guards()                   # 래치(300초)는 다음 slow 회차(60분) 전에 풀림
    paper_bars.task_paper_bars_us()       # 2회차 429
    http.reset_guards()
    with pytest.raises(EmptyResult, match="이번 회차는 묻지 않고 쉼"):
        paper_bars.task_paper_bars_us()   # 3회차 쉼
    yahoo["minute"] = ({"AAA": _session(DAY)}, None, False)
    paper_bars.task_paper_bars_us()       # 4회차 다시 받음

    assert len(yahoo["calls"]) == 3
    assert store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload["error"] is None


def test_429_다음_정상_회차는_횟수를_되돌린다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    for limited in (True, False, True):
        yahoo["minute"] = ({"AAA": _session(DAY)}, "거부됨" if limited else None, limited)
        paper_bars.task_paper_bars_us()
        http.reset_guards()
    paper_bars.task_paper_bars_us()       # 연달아가 아니므로 쉬지 않음
    assert len(yahoo["calls"]) == 4


def test_빠진_종목은_이어받고_하나도_못_받으면_저장본을_둔다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA", "BBB"])
    yahoo["minute"] = ({"AAA": _session(DAY), "BBB": _session(DAY), "SPY": _session(DAY)}, None, False)
    paper_bars.task_paper_bars_us()

    clock(datetime(2026, 10, 30, 12, 5, tzinfo=NY))
    yahoo["minute"] = ({"AAA": _session(DAY), "SPY": _rows(DAY, time(9, 30), time(12, 3))}, "받지 못함 1개(BBB)", False)
    detail = paper_bars.task_paper_bars_us()

    payload = store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload
    bbb = payload["tickers"]["BBB"]
    assert bbb["isStale"] is True and bbb["staleReason"] == "받지 못함 1개(BBB)"
    assert bbb["sessions"]["2026-10-30"]["fetchedAt"] == "2026-10-30T15:05:00+00:00", "세션의 받은 시각은 실제로 받은 때 그대로"
    assert payload["missing"] == ["BBB"] and payload["error"] == "받지 못함 1개(BBB)"
    assert payload["tickers"]["SPY"]["sessions"]["2026-10-30"]["lastBar"]["t"] == "2026-10-30T19:59:00+00:00", \
        "더 짧게 온 응답(12:03)은 이미 받은 세션(15:59)을 덮지 않음"
    assert detail.startswith("2/3 종목") and "이전 값 1개(BBB)" in detail

    yahoo["minute"] = ({}, "거부됨 — finance.yahoo.com HTTP 429", True)
    with pytest.raises(EmptyResult, match="0/3 종목 — 기존 저장본 유지"):
        paper_bars.task_paper_bars_us()
    assert store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload == payload


def test_세션은_종목마다_최근_3개만_남는다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    days = [date(2026, 10, 26), date(2026, 10, 27), date(2026, 10, 28), date(2026, 10, 29)]
    yahoo["minute"] = ({"AAA": [row for day in days for row in _session(day)]}, None, False)   # 5d 따라잡기 — 네 세션
    paper_bars.task_paper_bars_us()
    assert list(store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload["tickers"]["AAA"]["sessions"]) == [
        "2026-10-27", "2026-10-28", "2026-10-29"]

    yahoo["minute"] = ({"AAA": _rows(DAY, time(9, 30), time(11, 4))}, None, False)            # 1d — 오늘 세션만
    paper_bars.task_paper_bars_us()
    payload = store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload
    assert list(payload["tickers"]["AAA"]["sessions"]) == ["2026-10-28", "2026-10-29", "2026-10-30"]
    assert payload["lagSeconds"] is None, "SPY를 받지 못한 회차는 지연을 재지 않음"
    assert payload["missing"] == ["SPY"]


def test_일봉_시가는_확정된_세션마다_한_번(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    clock(datetime(2026, 10, 30, 16, 55, tzinfo=NY))   # 16:15 뒤 — 10-30까지 확정
    yahoo["minute"] = ({"AAA": _session(date(2026, 10, 29)) + _session(DAY), "SPY": _session(DAY)}, None, False)
    yahoo["daily"] = ({"AAA": {"2026-10-29": 99.0, "2026-10-30": 100.2}, "SPY": {"2026-10-30": 500.0}}, None, False)

    detail = paper_bars.task_paper_bars_us()

    assert yahoo["calls"][1] == ("1d", ("AAA", "SPY"), "5d")
    payload = store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload
    assert payload["tickers"]["AAA"]["sessions"]["2026-10-29"]["dailyOpen"] == 99.0
    assert payload["tickers"]["AAA"]["sessions"]["2026-10-30"]["dailyOpen"] == 100.2
    assert payload["tickers"]["SPY"]["sessions"]["2026-10-30"]["dailyOpen"] == 500.0
    assert set(payload["dailyOpenSessions"]) == {"2026-10-29", "2026-10-30"}
    assert payload["lagSeconds"] is None, "마감 뒤에 받은 저장본 — 지연이 아니라 장이 닫힌 시간"
    assert "일봉 시가 2026-10-29, 2026-10-30" in detail

    paper_bars.task_paper_bars_us()
    assert [call[0] for call in yahoo["calls"]] == ["1m", "1d", "1m"], "같은 세션은 다시 부르지 않음"
    assert store.read_snapshot(catalog.SNAP_PAPER_BARS_US).payload["tickers"]["AAA"]["sessions"]["2026-10-30"]["dailyOpen"] == 100.2


def test_장중에는_일봉을_부르지_않고_1분봉이_429면_일봉도_묻지_않는다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "timed_scope", lambda market: ["AAA"])
    yahoo["minute"] = ({"AAA": _rows(DAY, time(9, 30), time(11, 4))}, None, False)
    paper_bars.task_paper_bars_us()                     # 11:05 ET — 10-30은 확정 전, 앞 세션 없음
    assert [call[0] for call in yahoo["calls"]] == ["1m"]

    clock(datetime(2026, 10, 30, 16, 55, tzinfo=NY))
    yahoo["minute"] = ({"AAA": _session(DAY)}, "거부됨", True)
    paper_bars.task_paper_bars_us()
    assert [call[0] for call in yahoo["calls"]] == ["1m", "1m"]
