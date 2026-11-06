"""
tests/test_paper_watch_kr.py
한국 Claude 계좌2 장중 확인 감시 paper_watch_kr → paper.watch.kr(계약 1, 단계 2b — 명세 2026-11-02 §10). 저장은 PostgreSQL, 토스는 가짜.

고정하는 규칙
  1. 범위는 한국 계좌2의 오늘(서울) PLANNED 확인 — 없거나 T ~ T + 20분 밖이면 토스를 부르지 않고 정상 끝(호출 0회).
  2. T 뒤 한 번: 감시 → 기준 069500 → 보유 → 대기 순으로 종목당 한 쪽(200개). 진행 중인 봉(라벨 = 봉 끝 > 받은 시각)은 뺀다.
  3. 저장본 = 종목마다 그날 완성 봉 최근 30개·지난 기준 시각(09:00·10:00~15:00) 창과 창 뒤 첫 거래 봉·마지막 봉, 지연 = 기준 종목을 받은 시각 − 그 종목 마지막 봉 끝.
  4. 같은 확인의 저장본이 T 뒤에 있고 빠진 종목이 없으면 다시 묻지 않고, 빠진 종목이 있으면 3회까지 다시(빠진 것은 이어받기 isStale).
  5. 계좌 글자·저장본 이름은 백엔드와 같다. 범위 읽기는 DB 실제 표(한국 계좌 행).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import pytest

from app import catalog, tasks
from app.services import toss as toss_service
from app.tasks import paper_watch_kr
from app.tasks.base import EmptyResult, KST

SESSION = date(2026, 11, 3)
AT = time(11, 0)
ROOT = Path(__file__).resolve().parents[2]


def _bar(label, price, volume=100, day=SESSION):
    return {"date": day.isoformat(), "time": label, "open": float(price), "high": float(price) + 1,
            "low": float(price) - 1, "close": float(price) + 0.5, "volume": volume}


def _day(until="11:03", day=SESSION, quiet=()):
    """그날 09:01부터 until(진행 중인 봉 라벨)까지의 1분봉(최신순 — 토스 응답 순서). quiet 라벨은 거래량 0."""
    out = []
    start = datetime.combine(day, time(9, 1))
    end = datetime.combine(day, datetime.strptime(until, "%H:%M").time())
    at = start
    while at <= end:
        label = at.strftime("%H:%M")
        out.append(_bar(label, 1000 + (at - start).seconds // 60, 0 if label in quiet else 100, day))
        at += timedelta(minutes=1)
    return list(reversed(out))[:200]


class FakeToss:
    def __init__(self):
        self.bars: dict[str, list[dict]] = {}
        self.errors: dict[str, Exception] = {}
        self.calls: list[str] = []

    def candles(self, symbol, interval, count, *, adjusted, before=None):
        assert interval == "1m" and adjusted is False and before is None and count == 200
        self.calls.append(symbol)
        if symbol in self.errors:
            raise self.errors[symbol]
        return self.bars.get(symbol, [])[:count], None


SCOPE = {"book": "kr_claude2", "sessionDate": SESSION, "atLocal": AT, "watch": ["005930", "000660"],
         "held": ["035720"], "pending": ["005930", "051910"]}


@pytest.fixture()
def toss(monkeypatch):
    fake = FakeToss()
    monkeypatch.setattr(paper_watch_kr.toss_service, "fetch_candles", fake.candles)
    monkeypatch.setattr(paper_watch_kr, "SPACING_SECONDS", 0)
    return fake


def _at(clock: str, seconds: int = 0) -> datetime:
    return datetime.combine(SESSION, datetime.strptime(clock, "%H:%M").time(), tzinfo=KST) + timedelta(seconds=seconds)


def _clock(monkeypatch, clock: str, seconds: int = 0) -> None:
    monkeypatch.setattr(paper_watch_kr, "_now", lambda: _at(clock, seconds))


def _scope(monkeypatch, scope):
    monkeypatch.setattr(paper_watch_kr.store, "watch_scope", lambda market, day: scope if market == "KR" and day == SESSION else None)


def _payload(store):
    return store.read_snapshot(catalog.SNAP_PAPER_WATCH_KR).payload


# ==============================================================================
# 1. 한 종목 항목(순수 함수)
# ==============================================================================
def test_항목은_완성_봉만_그날_것만_지난_기준_시각_창과_창_뒤_첫_거래_봉():
    candles = _day("11:03", quiet=("10:01", "10:02")) + [_bar("15:20", 1, day=SESSION - timedelta(days=1))]
    entry = paper_watch_kr.ticker_entry(candles, _at("11:02", 30))
    assert entry["session"] == "2026-11-03"
    labels = [bar["label"] for bar in entry["bars"]]
    assert labels[-1] == "11:02", "11:03 봉은 진행 중(봉 끝 11:03 > 받은 시각 11:02:30)"
    assert len(labels) == paper_watch_kr.BARS_KEPT and labels == sorted(labels)
    assert entry["bars"][-1] == {"label": "11:02", "o": 1121.0, "h": 1122.0, "l": 1120.0, "c": 1121.5, "v": 100}
    assert set(entry["windows"]) == {"09:00", "10:00", "11:00"}, "지난 기준 시각만(11:00 < 받은 시각)"
    assert [b["label"] for b in entry["windows"]["09:00"]] == ["09:01", "09:02", "09:03", "09:04", "09:05"]
    assert [b["label"] for b in entry["windows"]["11:00"]] == ["11:01", "11:02"]
    assert entry["firstAfter"]["10:00"]["label"] == "10:03", "10:01·10:02는 거래량 0"
    assert entry["lastBar"] == {"label": "11:02", "c": 1121.5, "v": 100}
    assert paper_watch_kr.ticker_entry(candles, _at("09:00", 30)) is None, "그날 완성 봉 없음"


def test_지연은_받은_시각_빼기_기준_종목_마지막_완성_봉_끝():
    entry = paper_watch_kr.ticker_entry(_day("11:03"), _at("11:02", 7))
    assert paper_watch_kr.lag_seconds(_at("11:02", 7), entry) == 7
    assert paper_watch_kr.lag_seconds(_at("11:02", 7), None) is None


# ==============================================================================
# 2. 태스크
# ==============================================================================
def test_계획이_없거나_창_밖이면_부르지_않고_정상_끝(store, toss, monkeypatch):
    _scope(monkeypatch, None)
    _clock(monkeypatch, "11:05")
    assert "호출 0회" in tasks.task_paper_watch_kr()
    _scope(monkeypatch, SCOPE)
    for clock in ("10:59", "11:21"):
        _clock(monkeypatch, clock)
        assert "호출 0회" in tasks.task_paper_watch_kr()
    assert toss.calls == []


def test_T_뒤_한_번_감시_기준_보유_대기_순으로_받아_저장하고_다시_묻지_않는다(store, toss, monkeypatch):
    _scope(monkeypatch, SCOPE)
    for code in ("005930", "000660", "069500", "035720", "051910"):
        toss.bars[code] = _day("11:03")
    _clock(monkeypatch, "11:02", 4)

    detail = tasks.task_paper_watch_kr()

    assert toss.calls == ["005930", "000660", "069500", "035720", "051910"]
    payload = _payload(store)
    assert payload["contract"] == 1 and payload["barLabel"] == "END" and payload["reference"] == "069500"
    assert payload["checkpoint"] == {"book": "kr_claude2", "sessionDate": "2026-11-03", "atKst": "11:00"}
    assert payload["checkpoints"] == [{"book": "kr_claude2", "sessionDate": "2026-11-03", "atKst": "11:00", "slot": None}], \
        "창 안 계획의 신원 목록 — 끈 판 장중 확인 행은 순번 없음"
    assert payload["scope"] == ["005930", "000660", "069500", "035720", "051910"]
    assert payload["attempt"] == 1 and payload["missing"] == [] and payload["error"] is None
    assert payload["lagSeconds"] == 4
    assert payload["tickers"]["005930"]["lastBar"]["label"] == "11:02"
    assert detail.startswith("5/5 종목") and "지연 4초(069500)" in detail

    _clock(monkeypatch, "11:07")
    assert "호출 0회" in tasks.task_paper_watch_kr()
    assert len(toss.calls) == 5


def test_빠진_종목은_이어받고_세_번까지_다시_묻는다(store, toss, monkeypatch):
    _scope(monkeypatch, SCOPE)
    for code in ("005930", "000660", "069500", "035720"):
        toss.bars[code] = _day("11:03")
    toss.errors["051910"] = toss_service.TossError("HTTP 500")
    _clock(monkeypatch, "11:02", 4)
    tasks.task_paper_watch_kr()
    assert _payload(store)["missing"] == ["051910"] and "HTTP 500" in _payload(store)["error"]

    toss.bars["000660"] = []                                 # 이번엔 000660도 그날 봉 없음 → 직전 것을 이어받음
    _clock(monkeypatch, "11:07")
    tasks.task_paper_watch_kr()
    payload = _payload(store)
    assert payload["attempt"] == 2
    assert payload["tickers"]["000660"]["isStale"] is True
    assert "051910" not in payload["tickers"]
    _clock(monkeypatch, "11:12")
    tasks.task_paper_watch_kr()
    calls = len(toss.calls)
    _clock(monkeypatch, "11:17")
    assert "T 뒤 3회" in tasks.task_paper_watch_kr()
    assert len(toss.calls) == calls


def test_하나도_못_받으면_EmptyResult로_저장본을_둔다(store, toss, monkeypatch):
    _scope(monkeypatch, SCOPE)
    _clock(monkeypatch, "11:02", 4)
    with pytest.raises(EmptyResult):
        tasks.task_paper_watch_kr()


def test_다른_확인의_저장본은_잇지_않는다(store, toss, monkeypatch):
    _scope(monkeypatch, SCOPE)
    for code in ("005930", "000660", "069500", "035720", "051910"):
        toss.bars[code] = _day("11:03")
    _clock(monkeypatch, "11:02", 4)
    tasks.task_paper_watch_kr()
    _scope(monkeypatch, {**SCOPE, "atLocal": time(11, 30)})
    toss.bars["000660"] = []
    _clock(monkeypatch, "11:31")
    tasks.task_paper_watch_kr()
    payload = _payload(store)
    assert payload["checkpoint"]["atKst"] == "11:30" and payload["attempt"] == 1
    assert "000660" not in payload["tickers"] and payload["missing"] == ["000660"]


def test_창_안_계획이_여럿이면_합집합을_받고_계획이_더해지면_다시_받는다(store, toss, monkeypatch):
    """끈 판 계좌2의 장중 확인(11:00)과 켠 판 계좌1의 장중 판단(11:10 — ADR 0027)이 겹칩니다. 11:02에는 11:00 계획만 창 안(T ~ T + 20분),
    11:12에는 둘 다 — 직전 저장본에 11:10 계획의 신원이 없으므로 '이미 받음'이 아니라 다시 받습니다(회차는 1부터)."""
    plans = [dict(SCOPE, slot=None),
             {"book": "kr_claude", "sessionDate": SESSION, "atLocal": time(11, 10), "slot": 1, "watch": ["035420"],
              "held": ["035720"], "pending": []}]
    monkeypatch.setattr(paper_watch_kr.store, "watch_plans", lambda market, day: [dict(plan) for plan in plans])
    for code in ("005930", "000660", "069500", "035720", "051910", "035420"):
        toss.bars[code] = _day("11:20")
    _clock(monkeypatch, "11:02", 4)
    tasks.task_paper_watch_kr()
    first = _payload(store)
    assert [item["atKst"] for item in first["checkpoints"]] == ["11:00"] and "035420" not in first["scope"]

    _clock(monkeypatch, "11:07")
    assert "호출 0회" in tasks.task_paper_watch_kr(), "11:00 계획은 이미 받음, 11:10 계획은 아직 창 전"

    _clock(monkeypatch, "11:12", 3)
    detail = tasks.task_paper_watch_kr()
    payload = _payload(store)
    assert payload["checkpoint"] == {"book": "kr_claude2", "sessionDate": "2026-11-03", "atKst": "11:00"}
    assert payload["checkpoints"] == [
        {"book": "kr_claude2", "sessionDate": "2026-11-03", "atKst": "11:00", "slot": None},
        {"book": "kr_claude", "sessionDate": "2026-11-03", "atKst": "11:10", "slot": 1},
    ]
    assert payload["scope"] == ["005930", "000660", "035420", "069500", "035720", "051910"], "감시 목록(두 계획)·기준 종목 먼저"
    assert payload["attempt"] == 1, "더해진 계획의 첫 회차"
    assert "한국 장중 확인 2026-11-03 11:00·11:10 KST" in detail

    _clock(monkeypatch, "11:17")
    assert "호출 0회" in tasks.task_paper_watch_kr(), "두 계획 모두 가장 늦은 확인 시각 뒤에 받은 저장본이 있음"

    _clock(monkeypatch, "11:25")          # 11:00 계획의 창이 끝남 — 11:10 계획만, 그 신원의 저장본이 이미 있음
    assert "11:10 KST 감시 저장본 있음" in tasks.task_paper_watch_kr()


def test_그_계좌_대기_주문의_지정_시각과_장중_시장가_기준_분도_창으로_뽑는다(store, toss, monkeypatch):
    """예상 상태가 기준 시각이 지난 대기 주문(AT_MINUTE 10:47·MARKET 생성 10:31:20 → 기준 분 10:33)의 가격을 감시 저장본의 창에서 읽습니다.
    아직 오지 않은 지정 시각(13:15)·다른 계좌의 주문·다른 세션의 주문은 창을 만들지 않습니다."""
    with store.connection() as conn:
        for code in ("kr_claude", "kr_claude2"):
            conn.execute(
                "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
                "VALUES (%s, 'CLAUDE', %s, 100000000, %s, 'ACTIVE', 'KR', 'KRW')", (code, code, date(2026, 10, 30)))
        for book, ticker, timing, at, as_of, created in (
                ("kr_claude", "005930", "AT_MINUTE", time(10, 47), date(2026, 11, 2), None),
                ("kr_claude", "000660", "AT_MINUTE", time(13, 15), date(2026, 11, 2), None),
                ("kr_claude", "035720", "MARKET", None, date(2026, 11, 2), datetime(2026, 11, 3, 10, 31, 20, tzinfo=KST)),
                ("kr_claude", "051910", "AT_MINUTE", time(9, 40), date(2026, 10, 30), None),      # 지난 세션의 주문
                ("kr_claude2", "005930", "AT_MINUTE", time(10, 5), date(2026, 11, 2), None)):     # 다른 계좌
            conn.execute(
                "INSERT INTO paper_orders (book_code, ticker, side, timing, target_local, source, status, as_of_trading_date, "
                "created_at) VALUES (%s, %s, 'BUY', %s, %s, 'CLAUDE', 'PENDING', %s, COALESCE(%s, now()))",
                (book, ticker, timing, at, as_of, created))
    plan = {"book": "kr_claude", "sessionDate": SESSION, "atLocal": AT, "slot": 2, "watch": ["005930"], "held": [],
            "pending": ["000660", "005930", "035720", "051910"]}
    monkeypatch.setattr(paper_watch_kr.store, "watch_plans", lambda market, day: [dict(plan)])
    for code in ("005930", "069500", "000660", "035720", "051910"):
        toss.bars[code] = _day("11:03")
    _clock(monkeypatch, "11:02", 4)

    tasks.task_paper_watch_kr()

    windows = _payload(store)["tickers"]["005930"]["windows"]
    assert set(windows) == {"09:00", "10:00", "10:33", "10:47", "11:00"}, "지난 기준 시각만 — 13:15는 아직, 10:05·09:40은 이 계획의 것이 아님"
    assert [bar["label"] for bar in windows["10:47"]] == ["10:48", "10:49", "10:50", "10:51", "10:52"]
    assert _payload(store)["tickers"]["035720"]["firstAfter"]["10:33"]["label"] == "10:34"
    assert _payload(store)["checkpoints"] == [{"book": "kr_claude", "sessionDate": "2026-11-03", "atKst": "11:00", "slot": 2}]


# ==============================================================================
# 3. 범위 읽기(PostgreSQL)·글자 대조
# ==============================================================================
def test_범위는_한국_계좌2의_오늘_PLANNED_확인과_보유·대기(store):
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
            "VALUES ('kr_claude2', 'CLAUDE', '한국 Claude 계좌2', 100000000, %s, 'ACTIVE', 'KR', 'KRW')", (date(2026, 10, 30),))
        decision = conn.execute(
            "INSERT INTO paper_decisions (book_code, as_of_trading_date, kind, status, settings_version) "
            "VALUES ('kr_claude2', %s, 'SCHEDULED', 'OK', 1) RETURNING id", (date(2026, 11, 2),)).fetchone()["id"]
        conn.execute(
            "INSERT INTO paper_checkpoints (book_code, session_date, at_local, feed, watch, question, source_decision_id, status) "
            "VALUES ('kr_claude2', %s, %s, 'MINUTE', %s, '갭 유지?', %s, 'PLANNED')", (SESSION, AT, ["005930"], decision))
        conn.execute(
            "INSERT INTO paper_orders (book_code, ticker, side, timing, source, status, as_of_trading_date) "
            "VALUES ('kr_claude2', '000660', 'BUY', 'AT_1400', 'CLAUDE', 'PENDING', %s)", (date(2026, 11, 2),))
    assert store.watch_scope("KR", SESSION) == {"book": "kr_claude2", "sessionDate": SESSION, "atLocal": AT,
                                                "watch": ["005930"], "held": [], "pending": ["000660"]}
    assert store.watch_scope("KR", SESSION + timedelta(days=1)) is None


def test_계좌_글자와_저장본_이름은_백엔드와_같다():
    books = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/PaperBooks.java").read_text(encoding="utf-8")
    assert f'KR_CLAUDE2 = "{paper_watch_kr.store.WATCH_BOOKS["KR"]}"' in books
    datasets = (ROOT / "backend/src/main/java/com/macrodash/store/Datasets.java").read_text(encoding="utf-8")
    assert f'SNAP_PAPER_WATCH_KR = "{catalog.SNAP_PAPER_WATCH_KR}"' in datasets


def test_한국_감시_저장본을_읽는_백엔드_코드는_한국_장중_확인_작업과_상태_표시뿐이고_화면은_읽지_않는다():
    """읽는 곳은 PaperMarketData.watchKr(조용히 읽음)를 부르는 한국 장중 확인 작업(PaperKrCheckpointJob — 호출 조건)·자유 시점 판의 한국 장중 판단
    작업(PaperKrIntradayJob — ADR 0027, 같은 조건)과 그 작업들이 넘기는 패킷·예상 상태(KrCheckpointPacket·KrExpectedState — 판단 입력), 상태 응답의
    한국 계좌2 묶음(PaperQueryService — 받은 시각·나이·지연 표시만)뿐입니다. 체결(장부)은 paper.kr.quotes·paper.kr.timed이고 이 저장본을 읽지 않습니다."""
    readers = []
    for folder in (ROOT / "backend/src/main/java", ROOT / "frontend/src"):
        for path in folder.rglob("*"):
            if path.suffix in (".java", ".ts", ".tsx") and path.is_file():
                text = path.read_text(encoding="utf-8")
                if "SNAP_PAPER_WATCH_KR" in text or "paper.watch.kr" in text:
                    readers.append(path.relative_to(ROOT).as_posix())
    assert sorted(readers) == ["backend/src/main/java/com/macrodash/feature/paper/KrCheckpointPacket.java",
                               "backend/src/main/java/com/macrodash/feature/paper/KrExpectedState.java",
                               "backend/src/main/java/com/macrodash/feature/paper/PaperKrCheckpointJob.java",
                               "backend/src/main/java/com/macrodash/feature/paper/PaperKrIntradayJob.java",
                               "backend/src/main/java/com/macrodash/feature/paper/PaperMarketData.java",
                               "backend/src/main/java/com/macrodash/store/Datasets.java"]
    # 메서드 참조(::watchKr)도 부르는 것으로 셉니다. PaperMirrorService는 실제 매매의 장중 따라 하기가 '그 주문 뒤 예상 비중'을 셀 때(weightAfter —
    # KrExpectedState와 같은 가격 고르기, ADR 0028)만 읽습니다 — 장중 판단 입력과 같은 쓰임이고 ISA 평가(lastPrices)는 밤 종가만 씁니다(ADR 0029).
    callers = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "backend/src/main/java").rglob("*.java")
                     if ".watchKr()" in (text := path.read_text(encoding="utf-8")) or "::watchKr" in text)
    assert callers == ["backend/src/main/java/com/macrodash/feature/paper/PaperKrCheckpointJob.java",
                       "backend/src/main/java/com/macrodash/feature/paper/PaperKrIntradayJob.java",
                       "backend/src/main/java/com/macrodash/feature/paper/PaperMirrorService.java",
                       "backend/src/main/java/com/macrodash/feature/paper/PaperQueryService.java"]


def test_QA193_지연은_기준_종목을_받은_시각으로_센다(store, toss, monkeypatch):
    # 부를 때마다 5초씩 가는 시계 — 감시 둘 뒤 기준 069500(11:04:15), 그 뒤 보유·대기 둘(11:04:25)을 받음.
    _scope(monkeypatch, SCOPE)
    for code in ("005930", "000660", "069500", "035720", "051910"):
        toss.bars[code] = _day("11:05")
    ticks = iter(range(0, 600, 5))
    monkeypatch.setattr(paper_watch_kr, "_now", lambda: _at("11:04", next(ticks)))

    detail = tasks.task_paper_watch_kr()

    payload = _payload(store)
    assert toss.calls == ["005930", "000660", "069500", "035720", "051910"]
    assert payload["tickers"]["069500"]["fetchedAt"] == _at("11:04", 15).astimezone(timezone.utc).isoformat()
    assert payload["lagSeconds"] == 15, "기준 종목을 받은 11:04:15 − 마지막 완성 봉 끝 11:04"
    assert "지연 15초(069500)" in detail
    assert payload["fetchedAt"] == _at("11:04", 25).astimezone(timezone.utc).isoformat(), "저장본 받은 시각은 마지막 종목 그대로"
