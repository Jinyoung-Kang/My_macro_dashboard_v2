"""
tests/test_paper_watch.py
🧪 미국 Claude 계좌2 단계 2 장중 확인 감시 — 태스크 paper_watch_us → 스냅샷 paper.watch.us (명세 2026-10-30-claude-book2-timing-design.md §5-2·§12-1·
§12-3, ADR 0022).

고정하는 규칙
  1. 범위 = 계좌2의 뉴욕 오늘 세션 장중 확인 행 가운데 PLANNED·MINUTE 하나(감시 목록) ∪ 계좌2 보유·대기 주문 ∪ {SPY, QQQ} — 백엔드 표를 읽기만
     (읽기 전용 트랜잭션에서도 돎). HOURLY·다른 계좌·다른 날·PLANNED가 아닌 행은 범위가 아니다.
  2. 확인 시각 T(그 세션 날짜의 뉴욕 시각)의 −15분 ~ +30분 밖이거나 범위가 없거나 Yahoo 래치가 닫혀 있으면 묻지 않는다(호출 0). 범위 없음·창 밖은
     정상 반환('호출 0회' — session 군 실행이 늘 empty가 되지 않게), 래치는 EmptyResult. 창 안이면 배치 한 번.
     서머타임이 끝난 주(2026-11-02 10:00 ET = 15:00Z)도 뉴욕 시각 그대로.
  3. 종목마다 완성된 봉(시작 + 60초 ≤ 받은 시각)만 최근 30개, 그 세션의 시가·고가·저가와 마지막 봉. 진행 중인 봉은 싣지 않는다.
  4. lagSeconds는 이번 회차 SPY의 그날 정규장 안에서만(지난 세션 봉뿐이면 null — 0으로 채우지 않음), declaredDelayMin은 늘 null.
  5. 받지 못한 종목은 같은 확인의 직전 저장본에서 isStale로 잇고(다른 확인의 것은 잇지 않음), 하나도 못 받으면 EmptyResult로 저장본을 둔다.
  6. 이 저장본을 읽는 백엔드 코드는 장중 확인 작업·패킷(판단 입력)과 상태 응답의 계좌2 장중 확인 묶음(PaperQueryService — 받은 시각·지연 표시만,
     같은 watchUs 경유)뿐이다 — 화면은 읽지 않는다.

외부 네트워크를 쓰지 않습니다 — 1분봉은 market.minute_bars를 바꿔 끼웁니다. 범위·태스크 시험은 PostgreSQL이 필요합니다.
"""
from __future__ import annotations

import inspect
import re
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app import catalog, http, tasks
from app.services import market as market_service
from app.tasks import paper_watch
from app.tasks.base import EmptyResult

ROOT = Path(__file__).resolve().parents[2]
NY = ZoneInfo("America/New_York")
UTC = timezone.utc
SESSION = date(2026, 11, 2)          # 서머타임이 끝난 첫 거래일(EST) — 계좌2 첫 장중 확인 세션
AT = time(10, 0)                     # 10:00 ET = 15:00Z = 00:00 KST(11-03)


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


def _ny(hh: int, mm: int, ss: int = 0, day: date = SESSION) -> datetime:
    return datetime.combine(day, time(hh, mm, ss), tzinfo=NY).astimezone(UTC)


# ==============================================================================
# 1. 등록·이름·백엔드와 같은 글자
# ==============================================================================
def test_session_군에서_paper_bars_us_뒤에_돌고_태스크는_39개():
    task = tasks.TASKS_BY_NAME["paper_watch_us"]
    assert task.speed == "session" and task.run is paper_watch.task_paper_watch_us
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("paper_watch_us") == names.index("paper_bars_us") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 39  # 계좌2 단계 2의 paper_watch_us까지


def test_데이터셋_이름():
    assert catalog.SNAP_PAPER_WATCH_US == "paper.watch.us"


def test_감시_피드와_계좌_코드는_V18·백엔드와_같은_글자():
    sql = next((ROOT / "db/migrations").glob("V18__*.sql")).read_text(encoding="utf-8")
    feeds = re.search(r"feed\s+TEXT\s+NOT NULL CHECK \(feed IN \(([^)]*)\)\)", sql)
    assert feeds, "V18에서 paper_checkpoints.feed CHECK를 찾지 못했습니다"
    assert re.findall(r"'([A-Z]+)'", feeds.group(1)) == ["MINUTE", "HOURLY"]
    assert paper_watch.store.FEED_MINUTE == "MINUTE"
    status = re.search(r"status\s+TEXT\s+NOT NULL CHECK \(status IN \(([^)]*)\)\)", sql)
    assert paper_watch.store.CHECKPOINT_PLANNED in re.findall(r"'([A-Z]+)'", status.group(1))

    java = (ROOT / "backend/src/main/java/com/macrodash/feature/paper/PaperBooks.java").read_text(encoding="utf-8")
    claude2 = re.search(r'static final String CLAUDE2 = "([^"]+)";', java).group(1)
    assert paper_watch.store.WATCH_BOOKS == {"US": claude2}


def test_감시_저장본을_읽는_백엔드_코드는_장중_확인_작업과_패킷과_상태_표시뿐이고_화면은_읽지_않는다():
    """읽는 곳은 PaperMarketData.watchUs(조용히 읽음)를 부르는 장중 확인 작업(PaperCheckpointJob — 호출 조건·지연)과 장중 확인 패킷
    (CheckpointPacket — MINUTE 피드)(판단 입력), 상태 응답의 계좌2 장중 확인 묶음(PaperQueryService — 받은 시각·나이·지연 표시만)뿐입니다.
    체결(장부)은 paper.bars.us 한 출처이고 이 저장본을 읽지 않습니다. 이름을 쓰지 않고 PaperMarketData.watchUs()를 거치는 새 독자도 잡도록
    부르는 파일도 셉니다."""
    readers = []
    for folder in (ROOT / "backend/src/main/java", ROOT / "frontend/src"):
        if not folder.exists():
            continue
        for path in folder.rglob("*"):
            if path.suffix in (".java", ".ts", ".tsx") and path.is_file():
                text = path.read_text(encoding="utf-8")
                if "SNAP_PAPER_WATCH_US" in text or "paper.watch.us" in text:
                    readers.append(path.relative_to(ROOT).as_posix())
    assert sorted(readers) == ["backend/src/main/java/com/macrodash/feature/paper/CheckpointPacket.java",
                               "backend/src/main/java/com/macrodash/feature/paper/PaperCheckpointJob.java",
                               "backend/src/main/java/com/macrodash/feature/paper/PaperMarketData.java",
                               "backend/src/main/java/com/macrodash/store/Datasets.java"]
    callers = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "backend/src/main/java").rglob("*.java")
                     if ".watchUs()" in path.read_text(encoding="utf-8"))
    assert callers == ["backend/src/main/java/com/macrodash/feature/paper/PaperCheckpointJob.java",
                       "backend/src/main/java/com/macrodash/feature/paper/PaperQueryService.java"], \
        "PaperMarketData.watchUs()를 부르는 곳 = 장중 확인 작업과 상태 응답(표시)뿐"
    java = (ROOT / "backend/src/main/java/com/macrodash/store/Datasets.java").read_text(encoding="utf-8")
    assert re.search(r"MAX_AGE_WATCH_US = 10 \* 60L;", java), "session 주기(300초) + 여유"


# ==============================================================================
# 2. 창·봉 (DB·네트워크 없음)
# ==============================================================================
@pytest.mark.parametrize("now, inside", [
    (_ny(9, 44, 59), False),
    (_ny(9, 45), True),            # T − 15분
    (_ny(10, 30), True),           # T + 30분
    (_ny(10, 31), False),
    (_ny(10, 0, day=date(2026, 11, 3)), False),   # 다른 날 같은 시각
])
def test_창은_확인_시각_앞_15분_뒤_30분(now, inside):
    assert paper_watch.in_window(now, SESSION, AT) is inside


def test_확인_시각은_그_세션_날짜의_뉴욕_시각이다():
    assert paper_watch.target_at(SESSION, AT).isoformat() == "2026-11-02T15:00:00+00:00", "EST(UTC−5)"
    assert paper_watch.target_at(date(2026, 10, 30), AT).isoformat() == "2026-10-30T14:00:00+00:00", "EDT(UTC−4)"


def test_완성된_봉만_최근_30개와_그_세션의_시고저():
    fetched = _ny(10, 5, 20)
    rows = _rows(date(2026, 10, 30), time(15, 50), time(15, 59), price=90.0) + _rows(SESSION, time(9, 30), time(10, 5))
    entry = paper_watch.ticker_entry(rows, fetched)

    assert entry["session"] == "2026-11-02" and entry["fetchedAt"] == fetched.isoformat()
    starts = [bar["t"] for bar in entry["bars"]]
    assert len(starts) == 30 and starts[-1] == _ny(10, 4).isoformat(), "10:05 봉은 아직 진행 중(시작 + 60초 > 받은 시각)"
    assert starts[0] == _ny(9, 35).isoformat()
    assert set(entry["bars"][0]) == {"t", "o", "h", "l", "c", "v"}
    assert entry["day"] == {"open": 100.0, "high": pytest.approx(100.0 + 0.1 * 34 + 1), "low": 99.0}, "지난 세션 봉은 빠짐"
    assert entry["lastBar"] == {"t": _ny(10, 4).isoformat(), "c": pytest.approx(100.0 + 0.1 * 34 + 0.5), "v": 10}
    assert paper_watch.ticker_entry(_rows(SESSION, time(10, 5), time(10, 5)), fetched) is None, "완성 봉이 없으면 항목 없음"
    exact = paper_watch.ticker_entry(_rows(SESSION, time(10, 4), time(10, 4)), _ny(10, 5))
    assert [bar["t"] for bar in exact["bars"]] == [_ny(10, 4).isoformat()], "시작 + 60초 = 받은 시각이면 완성"


# ==============================================================================
# 3. 범위 읽기 (PostgreSQL)
# ==============================================================================
def _book(store, code: str, market: str = "US") -> None:
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, market, currency) "
            "VALUES (%s, 'CLAUDE', %s, 100000, %s, 'ACTIVE', %s, %s)",
            (code, code, date(2026, 10, 30), market, "USD" if market == "US" else "KRW"),
        )


def _checkpoint(store, book: str, session: date, feed: str = "MINUTE", status: str = "PLANNED",
                watch: tuple[str, ...] = ("NVDA", "AAPL")) -> None:
    with store.connection() as conn:
        decision = conn.execute(
            "INSERT INTO paper_decisions (book_code, as_of_trading_date, kind, status, settings_version) "
            "VALUES (%s, %s, 'SCHEDULED', 'OK', 1) RETURNING id", (book, session - timedelta(days=3)),
        ).fetchone()["id"]
        conn.execute(
            "INSERT INTO paper_checkpoints (book_code, session_date, at_et, feed, watch, question, source_decision_id, status) "
            "VALUES (%s, %s, %s, %s, %s, '갭 유지?', %s, %s)", (book, session, AT, feed, list(watch), decision, status),
        )


def _order(store, book: str, ticker: str, status: str) -> None:
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_orders (book_code, ticker, side, timing, source, status, as_of_trading_date) "
            "VALUES (%s, %s, 'BUY', 'AT_1100', 'CLAUDE', %s, %s)", (book, ticker, status, date(2026, 10, 30)),
        )


def _hold(store, book: str, ticker: str) -> None:
    now = datetime(2026, 10, 30, 20, 0, tzinfo=UTC)
    with store.connection() as conn:
        conn.execute(
            "INSERT INTO paper_positions (book_code, ticker, qty, avg_cost, opened_on, opened_at, high_watermark, "
            "watermark_at, fill_ref_date, fill_ref_close) VALUES (%s, %s, 10, 100, %s, %s, 100, %s, %s, 100)",
            (book, ticker, date(2026, 10, 30), now, now, date(2026, 10, 30)),
        )


def _read_only(store, monkeypatch) -> None:
    @contextmanager
    def read_only():
        with store.get_pool().connection() as conn:
            conn.execute("SET TRANSACTION READ ONLY")
            yield conn

    monkeypatch.setattr(store, "connection", read_only)


def test_범위는_계좌2의_오늘_PLANNED_MINUTE_확인과_보유·대기이고_읽기만_한다(store, monkeypatch):
    _book(store, "claude")
    _book(store, "claude2")
    _checkpoint(store, "claude2", SESSION)
    _checkpoint(store, "claude2", SESSION + timedelta(days=1), feed="HOURLY")
    _checkpoint(store, "claude2", SESSION + timedelta(days=2), status="SKIPPED")
    _checkpoint(store, "claude", SESSION, watch=("MSFT",))     # 계좌1 행(있을 수 없지만) — 범위 밖
    _hold(store, "claude2", "HELD2")
    _hold(store, "claude", "HELD1")
    _order(store, "claude2", "PEND2", "PENDING")
    _order(store, "claude2", "DONE2", "FILLED")
    _order(store, "claude", "PEND1", "PENDING")
    _read_only(store, monkeypatch)

    assert store.watch_scope("US", SESSION) == {"book": "claude2", "sessionDate": SESSION, "atEt": AT,
                                                "watch": ["NVDA", "AAPL"], "held": ["HELD2"], "pending": ["PEND2"]}
    assert store.watch_scope("US", SESSION + timedelta(days=1)) is None, "HOURLY는 감시 자료가 필요 없음"
    assert store.watch_scope("US", SESSION + timedelta(days=2)) is None, "PLANNED가 아님"
    assert store.watch_scope("US", SESSION - timedelta(days=1)) is None, "다른 날"
    assert store.watch_scope("KR", SESSION) is None


def test_범위_읽기는_쓰기_문장이_없다():
    source = inspect.getsource(paper_watch.store.watch_scope)
    assert not re.search(r"(?i)\b(INSERT|UPDATE|DELETE|TRUNCATE)\b", source)


# ==============================================================================
# 4. 태스크 (PostgreSQL — 범위·1분봉은 바꿔 끼움)
# ==============================================================================
SCOPE = {"book": "claude2", "sessionDate": SESSION, "atEt": AT, "watch": ["NVDA"], "held": ["HELD"], "pending": ["PEND"]}


@pytest.fixture()
def clock(monkeypatch):
    def pin(when: datetime) -> datetime:
        monkeypatch.setattr(paper_watch, "_now", lambda: when.astimezone(UTC))
        return when
    pin(_ny(10, 5))
    return pin


@pytest.fixture()
def yahoo(monkeypatch):
    state = {"calls": [], "minute": ({}, None, False)}

    def minute(tickers, period):
        state["calls"].append((tuple(tickers), period))
        return state["minute"]

    monkeypatch.setattr(market_service, "minute_bars", minute)
    return state


@pytest.fixture()
def scope(store, monkeypatch):
    seen = []

    def fake(market, session):
        seen.append((market, session))
        return dict(SCOPE) if session == SESSION else None

    monkeypatch.setattr(store, "watch_scope", fake)
    return seen


def _all(day: date = SESSION, end: time = time(10, 4)) -> dict[str, list[dict]]:
    return {ticker: _rows(day, time(9, 30), end) for ticker in ("HELD", "NVDA", "PEND", "QQQ", "SPY")}


def test_범위가_없으면_Yahoo를_부르지_않는다(store, monkeypatch, yahoo, clock):
    monkeypatch.setattr(store, "watch_scope", lambda market, session: None)
    assert paper_watch.task_paper_watch_us() == "오늘 장중 확인(MINUTE) 계획 없음 — 호출 0회"
    assert yahoo["calls"] == [] and store.read_snapshot(catalog.SNAP_PAPER_WATCH_US) is None


@pytest.mark.parametrize("hh, mm", [(9, 44), (10, 31), (15, 0)])
def test_창_밖이면_부르지_않는다(store, yahoo, scope, clock, hh, mm):
    clock(_ny(hh, mm))
    assert paper_watch.task_paper_watch_us().endswith("밖 — 호출 0회")
    assert yahoo["calls"] == [] and scope == [("US", SESSION)], "범위는 뉴욕 오늘 날짜로 읽음"


def test_계획이_없거나_창_밖이면_정상_반환이고_호출_0회(store, monkeypatch, yahoo, scope, clock):
    # session 군은 이 태스크 하나뿐이라 EmptyResult면 실행 전체가 늘 empty — 상태 화면 경고·doctor 비정상·마지막 실행 가림(리뷰 OPS-2).
    clock(_ny(15, 0))
    detail = paper_watch.task_paper_watch_us()
    assert "밖" in detail and "호출 0회" in detail
    monkeypatch.setattr(store, "watch_scope", lambda market, session: None)
    detail = paper_watch.task_paper_watch_us()
    assert "계획 없음" in detail and "호출 0회" in detail
    assert yahoo["calls"] == [] and store.read_snapshot(catalog.SNAP_PAPER_WATCH_US) is None


def test_래치가_닫혀_있으면_묻지_않는다(store, yahoo, scope, clock):
    http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")
    with pytest.raises(EmptyResult, match=http.REJECTED_MARK):
        paper_watch.task_paper_watch_us()
    assert yahoo["calls"] == []


def test_창_안이면_배치_한_번이고_저장본_모양과_지연(store, yahoo, scope, clock):
    clock(_ny(10, 5, 30))
    yahoo["minute"] = (_all(end=time(10, 5)), None, False)

    detail = paper_watch.task_paper_watch_us()

    assert yahoo["calls"] == [(("HELD", "NVDA", "PEND", "QQQ", "SPY"), "1d")], "감시 ∪ 보유 ∪ 대기 ∪ {SPY, QQQ}"
    payload = store.read_snapshot(catalog.SNAP_PAPER_WATCH_US).payload
    assert payload["contract"] == 1 and payload["barLabel"] == "START" and payload["reference"] == "SPY"
    assert payload["checkpoint"] == {"book": "claude2", "sessionDate": "2026-11-02", "atEt": "10:00"}
    assert payload["scope"] == ["HELD", "NVDA", "PEND", "QQQ", "SPY"] and payload["missing"] == []
    assert payload["fetchedAt"] == "2026-11-02T15:05:30+00:00"
    assert payload["lagSeconds"] == -30, "진행 중인 10:05 봉까지 받음 — 10:05:30 − (10:05 + 60초)(X1 단서)"
    assert payload["declaredDelayMin"] is None and payload["error"] is None
    nvda = payload["tickers"]["NVDA"]
    assert nvda["session"] == "2026-11-02" and len(nvda["bars"]) == 30
    assert nvda["bars"][-1]["t"] == "2026-11-02T15:04:00+00:00", "진행 중인 봉은 싣지 않음"
    assert nvda["day"]["open"] == 100.0 and "isStale" not in nvda
    assert detail.startswith("5/5 종목 · 장중 확인 2026-11-02 10:00 ET") and "지연 -30초(SPY)" in detail


def test_지난_세션_봉뿐이면_지연은_null(store, yahoo, scope, clock):
    """임시 휴장 등으로 오늘 봉이 없으면 항목의 session이 지난 날짜이고, 장이 닫힌 시간을 지연으로 적지 않습니다(백엔드가 E와 대조)."""
    yahoo["minute"] = (_all(day=date(2026, 10, 30), end=time(15, 59)), None, False)
    paper_watch.task_paper_watch_us()
    payload = store.read_snapshot(catalog.SNAP_PAPER_WATCH_US).payload
    assert payload["lagSeconds"] is None
    assert {entry["session"] for entry in payload["tickers"].values()} == {"2026-10-30"}


def test_빠진_종목은_같은_확인의_직전_값을_잇고_하나도_못_받으면_저장본을_둔다(store, yahoo, scope, clock):
    yahoo["minute"] = (_all(), None, False)
    paper_watch.task_paper_watch_us()

    clock(_ny(10, 10))
    partial = _all(end=time(10, 9))
    del partial["NVDA"]
    yahoo["minute"] = (partial, "받지 못함 1개(NVDA)", False)
    detail = paper_watch.task_paper_watch_us()
    payload = store.read_snapshot(catalog.SNAP_PAPER_WATCH_US).payload
    nvda = payload["tickers"]["NVDA"]
    assert nvda["isStale"] is True and nvda["fetchedAt"] == "2026-11-02T15:05:00+00:00", "받은 시각은 실제로 받은 때 그대로"
    assert payload["missing"] == ["NVDA"] and payload["error"] == "받지 못함 1개(NVDA)"
    assert "이전 값 1개(NVDA)" in detail

    clock(_ny(10, 15))
    yahoo["minute"] = ({}, "빈 응답", False)
    with pytest.raises(EmptyResult, match="0/5 종목 — 기존 저장본 유지"):
        paper_watch.task_paper_watch_us()
    assert store.read_snapshot(catalog.SNAP_PAPER_WATCH_US).payload["fetchedAt"] == "2026-11-02T15:10:00+00:00"


def test_다른_확인의_저장본은_잇지_않는다(store, monkeypatch, yahoo, clock):
    today = dict(SCOPE)
    monkeypatch.setattr(store, "watch_scope", lambda market, session: dict(today))
    yahoo["minute"] = (_all(), None, False)
    paper_watch.task_paper_watch_us()

    today.update(atEt=time(10, 30))         # 같은 날이라도 다른 확인 시각
    clock(_ny(10, 25))
    partial = _all(end=time(10, 24))
    del partial["NVDA"]
    yahoo["minute"] = (partial, "받지 못함 1개(NVDA)", False)
    paper_watch.task_paper_watch_us()
    payload = store.read_snapshot(catalog.SNAP_PAPER_WATCH_US).payload
    assert "NVDA" not in payload["tickers"] and payload["missing"] == ["NVDA"]
