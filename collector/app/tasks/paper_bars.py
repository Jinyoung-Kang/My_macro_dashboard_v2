"""
app/tasks/paper_bars.py
🧪 미국 Claude 계좌2(체결 시점 실험)의 단계 0 측정 — 대기·최근 주문 종목의 메뉴 창 1분봉 → 스냅샷 paper.bars.us (slow, paper_quotes 바로 뒤).

명세 docs/specs/2026-10-30-claude-book2-timing-design.md §7-1·§12-1~12-3·§19(X1~X5·X9), ADR 0022. 단계 0은 **재기만** 합니다 — 이
저장본을 읽는 것은 백엔드 실행 감사 작업(단계 0-4: 계좌1 주문의 메뉴 반사실·1분봉 지연)이고, 장부·패킷·결정은 읽지 않습니다. 체결은
지금처럼 paper.quotes 관측치로만 합니다.

[범위] store.timed_scope("US") — Claude 계좌1·계좌2의 대기 주문 ∪ 최근 8일(달력일)에 만든 주문 ∪ 계좌2 보유(백엔드 표를 읽기만 — ADR 0008·0022)
  + 지연 기준 SPY. 표에서 고른 종목이 없으면 EmptyResult이고 Yahoo를 부르지 않습니다 — SPY 혼자서는 묻지 않습니다(잴 주문이 없음).
[받는 법] yf.download(interval="1m", prepost=False, auto_adjust=False) 배치 한 번. 이 프로세스에서 1분봉을 처음 받기 전까지는 period "5d"
  (서버가 꺼졌던 세션 따라잡기 — 서버는 밤에만 켜져 날마다 새로 기동), 한 번 받은 뒤로는 "1d". 1d가 장 전·마감 뒤에 어느 세션을 주는지,
  5d가 며칠 전 세션까지 주는지는 [모름 — X9, 기동 직후 저장본의 세션 날짜로 확인]. 확정된 세션(동부 16:15 뒤 — paper.latest_final_date)은
  검증용 일봉 시가(X2) 배치를 세션마다 한 번 더 부릅니다(dailyOpenSessions에 적어 다시 부르지 않음).
[래치] Yahoo 공용 래치(http.YAHOO_HOST)가 닫혀 있으면 그 회차는 묻지 않고(빠진 창은 다음 slow 회차의 같은 날 다운로드에 들어 있음), 이 회차가
  받은 429는 래치를 닫습니다. 두 회차 연달아 429면 다음 한 회차를 쉽니다(§12-2 — 이 태스크는 paper_quotes 뒤라 그 회차 관측치는 이미 받았고,
  쉬는 것은 다음 회차 관측치가 같은 거부에 걸리는 일을 줄이려는 것).
[실패] 받지 못한 종목은 직전 저장본의 같은 종목으로 잇고 isStale(세션마다의 fetchedAt은 실제로 받은 시각 그대로). 하나도 받지 못하면 EmptyResult로
  저장본을 둡니다.
[봉 0개] 응답에 봉이 하나도 없는 종목(종일 거래 정지 등)은 기준 종목 SPY가 이번 회차에 세션을 받았으면 '받지 못함'이 아니라 그 세션들의 거래 없음으로
  봅니다 — 이어받지 않고 세션 없는 새 항목(noBarSessions)으로 저장해, 장부가 1분봉 자료 없음(R3·종가 대체)이 아니라 'T 뒤 거래 없음'(T18)으로
  판정합니다(no_bar_entries). 429를 받은 회차·SPY가 세션을 받지 못한 회차·직전 저장본에 그 종목의 그 세션이 이미 있는 종목은 지금처럼 이어받습니다.

[저장본 모양 — contract 1]
  {contract, source, barLabel "START", menu {NEXT_OPEN: "09:30", AT_1000: "10:00", …}, period, reference "SPY", scope [티커…], fetchedAt,
   lagSeconds,              # fetchedAt − (SPY 마지막 봉 시작 + 60초) — SPY 정규장 안(그 세션 날 09:30~16:00 ET)에서 받았을 때만, 아니면 null.
                            # 이번 회차에 받은 SPY 세션만 — Yahoo가 짧게 줘 직전 세션을 남겼으면 null(그 봉은 이번 응답이 아님)
                            # 음수면 진행 중인 봉까지 받은 것(X1의 단서). 조기 폐장일 13:00 뒤는 수집기가 구분하지 못해 null
   declaredDelayMin null,   # 출처가 밝힌 지연 — yf.download 1분봉 응답에는 없어 늘 null(§7-3)
   tickers {T: {fetchedAt, sessions {YYYY-MM-DD(뉴욕 날짜, 최근 3): {
       fetchedAt, barCount,
       firstBar {t, o, v}, lastBar {t, o, h, l, c, v},
       windows {"09:30"|"10:00"…"15:00": [{t, o, h, l, c, v}…] | null},   # T ~ T+4분에 시작한 봉. 없으면 null(아직·조기 폐장·무거래)
       firstTradeAfter {"HH:MM": {t, o, v} | null},                    # T 이후(T 포함) 그 세션의 첫 거래량 > 0 봉. 없으면 null
       dailyOpen}},                                                   # 검증용 일봉 시가(X2). 확정 전·못 받음은 null
     noBarSessions?,        # 봉 0개 항목만 — SPY가 이번 회차에 받은 세션(뉴욕 날짜) 가운데 이 종목 봉이 하나도 없던 세션. sessions는 직전 것 그대로(없으면 {})
     isStale?, staleReason?, staleSince?}},
   missing [이번에 받지 못한 티커 — 봉 0개 항목은 빠짐], error(배치의 사유 그대로 — 봉 0개 종목도 '받지 못함'으로 셈),
   dailyOpenSessions {YYYY-MM-DD: 일봉 배치를 부른 시각}}
  t는 늘 봉 **시작**의 UTC ISO입니다(BAR_LABEL). 창 시각은 그 세션 날짜의 America/New_York 시각이라 서머타임 전환에도 09:30 ET 그대로입니다
  (2026-10-30 EDT 13:30Z, 2026-11-02 EST 14:30Z — 고정 UTC 오프셋 없음). 거래량 0 봉도 창에는 그대로 두고(받은 값), 첫 거래 봉에서만 건너뜁니다.
  수집기는 미국 달력을 모릅니다 — 휴장일은 봉이 없어 세션이 생기지 않고, 조기 폐장일(13:00)은 13:00 뒤 창이 null입니다.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .. import catalog, http, store
from ..services import market as market_service

from .base import EmptyResult, carried_suffix, carry_over_missing, previous_payload
from .paper import latest_final_date

logger = logging.getLogger(__name__)

NEW_YORK = ZoneInfo("America/New_York")
CONTRACT = 1
SOURCE = "Yahoo(yfinance) 1분봉 — 정규장·원시가"

# Yahoo 1분봉의 인덱스 시각이 봉의 시작인가 끝인가 — '시작'으로 가정합니다[추정 — 명세 §19 X1: 09:30 봉이 있고 마지막 봉이 15:59인지 단계 0에서 잼].
# 끝 라벨로 판명되면 이 상수만 "END"로 바꿉니다 — 저장하는 t는 늘 봉 시작이고(END면 라벨 − 1분), 규칙은 '봉 시작' 기준 그대로입니다(§6-2).
BAR_LABEL = "START"

# 계좌2 메뉴의 시각 지정 시점과 기준 시각 T(뉴욕 시간, 명세 §6-2 — T5). 이름은 V17 paper_orders.timing CHECK와 같은 글자입니다(시험이 파일로 대조).
MENU = {
    "NEXT_OPEN": time(9, 30),
    "AT_1000": time(10, 0),
    "AT_1100": time(11, 0),
    "AT_1200": time(12, 0),
    "AT_1300": time(13, 0),
    "AT_1400": time(14, 0),
    "AT_1500": time(15, 0),
}
# 창 하나 = T ~ T+4분에 시작한 봉(사다리 R1 T 봉·R2 다음 4분 — §6-2).
WINDOW = timedelta(minutes=5)
SESSIONS_KEPT = 3
# 지연(lagSeconds)을 재는 기준 종목. 범위가 있을 때만 함께 받습니다.
REFERENCE = "SPY"
CATCH_UP_PERIOD = "5d"
STEADY_PERIOD = "1d"
DAILY_OPEN_PERIOD = "5d"
REJECTED_ROUNDS_BEFORE_REST = 2
# 일봉 배치를 부른 세션 기록을 남기는 수 — 세션 항목(최근 3)보다 넉넉히. 짧으면 오래된 세션이 남은 종목(무거래) 때문에 같은 세션을 다시 부릅니다.
DAILY_OPEN_SESSIONS_KEPT = 10

REGULAR_OPEN = time(9, 30)
REGULAR_CLOSE = time(16, 0)
# 조기 폐장일(13:00 마감)의 마지막 봉. 수집기는 달력을 모르므로, SPY 마지막 봉이 12:59이고 13:00 뒤에 받았으면 '장이 닫혔을 수 있음'으로 보고
# 지연을 null로 둡니다 — 보통 날 13:00 직후의 지연 한두 개를 잃는 대신, 장이 닫힌 시간을 지연으로 적지 않습니다(백엔드는 달력으로 다시 셀 수 있음).
EARLY_CLOSE_LAST_BAR = time(12, 59)
EARLY_CLOSE = time(13, 0)

# 이 프로세스의 수집 상태(프로세스 메모리 — 기동하면 처음부터: 5d 따라잡기, 429 횟수 0).
_caught_up = False      # 1분봉을 한 번이라도 받아 저장했나 — 그 뒤로 period "1d"
_rejected_rounds = 0    # 연달아 429를 받은 회차 수
_rest_rounds = 0        # 쉬어야 할 남은 회차 수


def _now() -> datetime:
    """지금 시각(UTC). 테스트가 시계를 바꿔 끼우는 자리입니다."""
    return datetime.now(timezone.utc)


def _bar_start(at: datetime) -> datetime:
    start = at if BAR_LABEL == "START" else at - timedelta(minutes=1)
    return start.astimezone(timezone.utc)


def _bar(start: datetime, row: dict) -> dict:
    return {"t": start.isoformat(), "o": row["open"], "h": row["high"], "l": row["low"], "c": row["close"],
            "v": row["volume"]}


def _short(start: datetime, row: dict) -> dict:
    return {"t": start.isoformat(), "o": row["open"], "v": row["volume"]}


def _traded(row: dict) -> bool:
    """거래량 > 0인 봉. 거래량을 모르면(None) 거래가 있었다고 보지 않습니다."""
    return row["volume"] is not None and row["volume"] > 0


def session_entries(rows: list[dict], fetched_at: datetime) -> dict[str, dict]:
    """
    한 종목의 1분봉(market.minute_bars의 줄) → 뉴욕 날짜별 세션 항목(모양은 머리말). 외부 호출·DB 없음 — 시험이 직접 부릅니다.

    창 시각 T는 그 세션 날짜의 America/New_York 시각으로 만들어 UTC로 바꿉니다(서머타임 전환 주에도 같은 규칙).
    """
    by_day: dict[str, list[tuple[datetime, dict]]] = {}
    for row in rows:
        start = _bar_start(row["at"])
        by_day.setdefault(start.astimezone(NEW_YORK).date().isoformat(), []).append((start, row))

    out: dict[str, dict] = {}
    for day, items in sorted(by_day.items()):
        items.sort(key=lambda item: item[0])
        session = date.fromisoformat(day)
        windows: dict[str, list[dict] | None] = {}
        first_trade: dict[str, dict | None] = {}
        for at in MENU.values():
            label = at.strftime("%H:%M")
            begin = datetime.combine(session, at, tzinfo=NEW_YORK).astimezone(timezone.utc)
            windows[label] = [_bar(start, row) for start, row in items if begin <= start < begin + WINDOW] or None
            trade = next(((start, row) for start, row in items if start >= begin and _traded(row)), None)
            first_trade[label] = _short(*trade) if trade else None
        out[day] = {
            "fetchedAt": fetched_at.isoformat(),
            "barCount": len(items),
            "firstBar": _short(*items[0]),
            "lastBar": _bar(*items[-1]),
            "windows": windows,
            "firstTradeAfter": first_trade,
            "dailyOpen": None,
        }
    return out


def _last_bar_at(entry: dict) -> datetime | None:
    text = (entry.get("lastBar") or {}).get("t") if isinstance(entry, dict) else None
    return _parse_at(text)


def _fetched_at(entry: dict) -> datetime | None:
    return _parse_at(entry.get("fetchedAt") if isinstance(entry, dict) else None)


def _parse_at(text) -> datetime | None:
    try:
        return datetime.fromisoformat(text) if isinstance(text, str) else None
    except ValueError:
        return None


def merge_sessions(fresh: dict[str, dict], before: dict | None) -> dict[str, dict]:
    """
    이번 세션 항목을 직전 저장본의 같은 종목 세션과 합쳐 최근 SESSIONS_KEPT개(뉴욕 날짜 순)를 남깁니다.

    같은 세션은 새 항목이 더 늦게까지 본 경우(마지막 봉 시각 ≥ 직전)에만 바꿉니다 — Yahoo가 한 번 짧게 준 응답으로 이미 받은 창을 잃지
    않게. 새 항목에 일봉 시가가 없으면 직전 값을 이어 둡니다.
    """
    merged = {day: dict(entry) for day, entry in (before or {}).items() if isinstance(entry, dict)}
    for day, entry in fresh.items():
        old = merged.get(day)
        if old is not None:
            old_last, new_last = _last_bar_at(old), _last_bar_at(entry)
            if old_last is not None and (new_last is None or old_last > new_last):
                continue
            if entry.get("dailyOpen") is None:
                entry = {**entry, "dailyOpen": old.get("dailyOpen")}
        merged[day] = entry
    return {day: merged[day] for day in sorted(merged)[-SESSIONS_KEPT:]}


def lag_seconds(fetched_at: datetime, reference: dict | None) -> int | None:
    """
    저장본의 지연 = 받은 시각 − (기준 종목 마지막 봉 시작 + 60초)(명세 §7-1). 기준 종목을 이번에 받았고, 그 마지막 세션 날짜의 정규장
    (09:30~16:00 ET) 안에서 받았을 때만 셉니다 — 장 밖·휴장·주말의 값은 지연이 아니라 장이 닫힌 시간이라 null(0으로 채우지 않음).
    그 마지막 세션도 이번 회차에 받은 것이어야 합니다 — Yahoo가 짧게 줘 merge_sessions가 직전 세션을 남겼으면 그 봉은 이번 응답이 아니라
    지금 받은 시각과 섞지 않습니다(직전 회차보다 한 시간 긴 값이 됨). 그 회차의 지연은 모르므로 null.
    """
    if not isinstance(reference, dict) or reference.get("isStale"):
        return None
    sessions = reference.get("sessions") or {}
    if not sessions:
        return None
    day = max(sessions)
    last = _last_bar_at(sessions[day])
    if last is None or _fetched_at(sessions[day]) != fetched_at:
        return None
    local = fetched_at.astimezone(NEW_YORK)
    if local.date().isoformat() != day or not REGULAR_OPEN <= local.time() < REGULAR_CLOSE:
        return None
    if last.astimezone(NEW_YORK).time() == EARLY_CLOSE_LAST_BAR and local.time() >= EARLY_CLOSE:
        return None
    return round((fetched_at - (last + timedelta(seconds=60))).total_seconds())


def _has_data(entry: dict) -> bool:
    """이어받기의 '값 있음' — 세션이 있거나, 봉 0개 항목(noBarSessions — 세션이 하나도 없어도 거래 없음을 본 항목)."""
    return bool(entry.get("sessions")) or bool(entry.get("noBarSessions"))


def no_bar_entries(tickers: list[str], fresh: dict[str, dict], before: dict, fetched_at: datetime,
                   limited: bool) -> tuple[dict[str, dict], list[str]]:
    """
    응답에 봉이 0개인 종목(종일 거래 정지 등) → '세션 없는 새 항목'(그 세션의 거래 없음 — 장부가 NO_TRADE로 봄, 명세 §6-2·T18).
    (종목 → 항목, 기준 종목이 이번 회차에 받은 세션) — 외부 호출·DB 없음.

    기준 종목(SPY)이 이번 회차에 받은 세션(합친 뒤에도 이번 응답의 것으로 남은 세션 — fetchedAt이 이번 회차)이 있을 때만이고, 그 세션들을
    ``noBarSessions``에 적습니다. 직전 저장본의 세션은 받은 시각 그대로 둡니다(merge_sessions — 최근 3). 장부는 SPY의 그 세션이 이 항목과 같은
    회차(같은 fetchedAt)일 때만 거래 없음으로 봅니다(UsTimedFills.evidence).

    다음 경우는 항목을 만들지 않아 지금처럼 이어받습니다(isStale): 이번 회차가 429를 받음(그 종목만 거부됐을 수 있음), SPY가 이번
    회차에 세션을 받지 못함(응답째 믿을 수 없음 — 짧게 온 응답으로 직전 세션을 남긴 때 포함), 직전 저장본에 그 종목의 그 세션이 이미 있음(그날
    거래가 있었는데 이번 응답에 없음 — 받지 못한 것).
    """
    reference = fresh.get(REFERENCE)
    if limited or reference is None:
        return {}, []
    stamp = fetched_at.isoformat()
    covered = sorted(day for day, entry in reference["sessions"].items()
                     if isinstance(entry, dict) and entry.get("fetchedAt") == stamp)
    if not covered:
        return {}, []
    out: dict[str, dict] = {}
    for ticker in tickers:
        if ticker in fresh:
            continue
        prior = before.get(ticker)
        sessions = prior.get("sessions") if isinstance(prior, dict) else None
        sessions = sessions if isinstance(sessions, dict) else {}
        if any(day in sessions for day in covered):
            continue
        out[ticker] = {"fetchedAt": stamp, "sessions": merge_sessions({}, sessions), "noBarSessions": covered}
    return out, covered


def _after_round(limited: bool) -> None:
    """회차 끝의 429 횟수. 두 회차 연달아 429면 다음 한 회차를 쉽니다. 한 회차에 두 번 불려도(1분봉 → 일봉) 그 회차는 한 번만 셉니다."""
    global _rejected_rounds, _rest_rounds
    if not limited:
        _rejected_rounds = 0
        return
    _rejected_rounds += 1
    if _rejected_rounds >= REJECTED_ROUNDS_BEFORE_REST:
        _rejected_rounds, _rest_rounds = 0, 1


def _fill_daily_opens(fresh: dict[str, dict], done: dict[str, str], fetched_at: datetime) -> str:
    """
    확정된 세션 가운데 일봉 배치를 아직 부르지 않은 세션이 있으면 한 번 불러 그 세션의 dailyOpen을 채웁니다(X2). 결과 문구 한 조각을 돌려줍니다.

    받은 것이 있으면 그 세션들을 ``done``에 적어 다시 부르지 않습니다(그 종목에 그날 값이 없으면 null 그대로 — 세션마다 배치 한 번).
    하나도 못 받으면 적지 않아 다음 회차가 다시 부릅니다.
    """
    final_through = latest_final_date(fetched_at)
    need = sorted({day for entry in fresh.values() for day in entry["sessions"] if day <= final_through and day not in done})
    if not need:
        return ""
    opens, reason, limited = market_service.daily_opens(sorted(fresh), DAILY_OPEN_PERIOD)
    if limited:
        _after_round(True)
    if not opens:
        return f" · 일봉 시가 못 받음({reason or '빈 응답'})"
    for ticker, entry in fresh.items():
        for day in need:
            value = (opens.get(ticker) or {}).get(day)
            if value is not None and day in entry["sessions"]:
                entry["sessions"][day]["dailyOpen"] = value
    for day in need:
        done[day] = fetched_at.isoformat()
    return f" · 일봉 시가 {', '.join(need)}"


def task_paper_bars_us() -> str:
    """🧪 Claude 계좌 주문·계좌2 보유 종목의 메뉴 창 1분봉(Yahoo) → 스냅샷 paper.bars.us (단계 0 측정 — 체결에는 아직 쓰지 않음)."""
    global _caught_up, _rest_rounds
    scope = store.timed_scope("US")
    if not scope:
        raise EmptyResult("수집 범위가 비었습니다(Claude 계좌 대기·최근 8일 주문·계좌2 보유 없음) — Yahoo를 부르지 않음")
    tickers = sorted(set(scope) | {REFERENCE})
    if _rest_rounds > 0:
        _rest_rounds -= 1
        raise EmptyResult(f"Yahoo 429가 {REJECTED_ROUNDS_BEFORE_REST}회차 연달아 — 이번 회차는 묻지 않고 쉼(다음 slow 회차가 다시 받음), "
                          "기존 저장본 유지")
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지 ({latched})")

    period = STEADY_PERIOD if _caught_up else CATCH_UP_PERIOD
    rows, reason, limited = market_service.minute_bars(tickers, period)
    fetched_at = _now()
    _after_round(limited)

    previous = previous_payload(catalog.SNAP_PAPER_BARS_US)
    before = previous.get("tickers") if isinstance(previous.get("tickers"), dict) else {}
    fresh: dict[str, dict] = {}
    for ticker in tickers:
        sessions = session_entries(rows.get(ticker) or [], fetched_at)
        if not sessions:
            continue
        prior = before.get(ticker)
        fresh[ticker] = {"fetchedAt": fetched_at.isoformat(),
                         "sessions": merge_sessions(sessions, prior.get("sessions") if isinstance(prior, dict) else None)}
    if not fresh:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지" + (f" ({reason})" if reason else ""))

    done = previous.get("dailyOpenSessions")
    done = dict(done) if isinstance(done, dict) else {}
    daily_note = "" if limited else _fill_daily_opens(fresh, done, fetched_at)

    received = sorted(fresh)
    no_bars, covered = no_bar_entries(tickers, fresh, before, fetched_at, limited)
    fresh.update(no_bars)
    missing = [ticker for ticker in tickers if ticker not in fresh]
    carried = carry_over_missing(fresh, before, tickers, reason, _has_data)
    lag = lag_seconds(fetched_at, fresh.get(REFERENCE))
    store.put_snapshot(catalog.SNAP_PAPER_BARS_US, {
        "contract": CONTRACT,
        "source": SOURCE,
        "barLabel": BAR_LABEL,
        "menu": {timing: at.strftime("%H:%M") for timing, at in MENU.items()},
        "period": period,
        "reference": REFERENCE,
        "scope": tickers,
        "fetchedAt": fetched_at.isoformat(),
        "lagSeconds": lag,
        "declaredDelayMin": None,
        "tickers": fresh,
        "missing": missing,
        "error": reason,
        "dailyOpenSessions": dict(sorted(done.items())[-DAILY_OPEN_SESSIONS_KEPT:]),
    })
    _caught_up = True

    days = sorted({day for ticker in received for day in fresh[ticker]["sessions"]})
    shown = sorted(no_bars)
    no_bar_note = (f" · 봉 0개 {len(shown)}개({', '.join(shown[:5])}{'…' if len(shown) > 5 else ''}) — {REFERENCE} 세션 "
                   f"{', '.join(covered)}의 거래 없음으로 저장") if shown else ""
    detail = (f"{len(received)}/{len(tickers)} 종목 · 세션 {', '.join(days)} (period {period})" + no_bar_note
              + carried_suffix(carried) + (f" · 지연 {lag}초({REFERENCE})" if lag is not None else "") + daily_note)
    if reason:
        detail += f" — {reason}"
    return detail
