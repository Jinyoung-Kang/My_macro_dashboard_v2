"""
app/tasks/paper_watch.py
🧪 미국 Claude 계좌2(체결 시점 실험)의 단계 2 장중 확인 — MINUTE 확인 날 감시·보유·대기 종목의 최근 1분봉 → 스냅샷 paper.watch.us
(속도군 session, 5분).

명세 docs/specs/2026-10-30-claude-book2-timing-design.md §5-2·§7-3·§9-5·§12-1·§12-3, ADR 0022. 이 저장본은 장중 확인 패킷(판단 입력)과
예상 상태의 가격에만 쓰입니다 — 장부 체결은 지금처럼 paper.bars.us 한 출처입니다(체결 출처를 둘로 늘리지 않음).

[범위] store.watch_scope("US", 뉴욕 오늘) — 계좌2의 오늘(뉴욕 날짜) 세션 장중 확인 행 가운데 PLANNED·MINUTE인 것 하나(확인 시각·감시 목록)와
  계좌2 보유·대기 주문 종목(백엔드 표를 읽기만 — ADR 0008·0022) + 기준 종목 SPY·QQQ. 행이 없으면 EmptyResult이고 Yahoo를 부르지 않습니다.
[창] 확인 시각 T(그 세션 날짜의 America/New_York 시각)의 −WATCH_BEFORE ~ +WATCH_AFTER 안에서만 묻습니다. 그 밖은 EmptyResult(호출 0) —
  확인이 없는 날·시각에는 외부 호출이 없습니다(§12-3: MINUTE 확인 날만 약 10건).
[받는 법] market.minute_bars(…, "1d") 배치 한 번(paper_bars_us와 같은 함수 — 정규장·원시가). 공용 Yahoo 래치(http.YAHOO_HOST)가 닫혀 있으면
  그 회차는 묻지 않습니다(다음 session 회차가 다시 봄). 이 회차가 받은 429는 같은 함수가 래치를 닫습니다.
[실패] 받지 못한 종목은 같은 확인(계좌·세션·시각)의 직전 저장본에서 잇고 isStale. 다른 확인의 저장본은 잇지 않습니다(어제 값을 오늘 감시로
  보이지 않게). 하나도 받지 못하면 EmptyResult로 저장본을 둡니다.

[저장본 모양 — contract 1]
  {contract, source, barLabel "START", reference "SPY", checkpoint {book, sessionDate, atEt "HH:MM"}, scope [티커…], fetchedAt,
   lagSeconds,              # paper_bars.lag_seconds와 같은 뜻 — fetchedAt − (SPY 마지막 봉 시작 + 60초), 이번 회차에 받은 SPY의 그날 정규장
                            # 안에서만, 아니면 null. 진행 중인 봉까지 받았으면 음수(X1 단서 — 그 봉은 bars에는 넣지 않음)
   declaredDelayMin null,   # 출처가 밝힌 지연 — yf.download 응답에 없어 늘 null(§7-3)
   tickers {T: {fetchedAt,
       session,             # 마지막 완성 봉의 뉴욕 날짜(임시 휴장이면 지난 세션 — 백엔드가 E와 대조)
       bars [{t, o, h, l, c, v}…],   # 그 세션의 완성된 봉(시작 + 60초 ≤ fetchedAt) 최근 BARS_KEPT개, 오래된 것부터
       day {open(첫 봉 시가), high, low},   # 그 세션 완성 봉 전부로
       lastBar {t, c, v},
       isStale?, staleReason?, staleSince?}},
   missing [이번에 받지 못한 티커], error(배치의 사유 그대로)}
  t는 늘 봉 **시작**의 UTC ISO입니다(paper_bars.BAR_LABEL과 같은 가정 — X1).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone

from .. import catalog, http, store
from ..services import market as market_service

from . import paper_bars
from .base import EmptyResult, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)

CONTRACT = 1
SOURCE = "Yahoo(yfinance) 1분봉 — 정규장·원시가, 장중 확인 감시(5분 수집)"
# 확인 시각 T 앞뒤로 묻는 창(§12-1). 앞 15분은 확인 직전 흐름, 뒤 30분은 호출 창(+2~+20분)을 덮고 남는 여유입니다.
WATCH_BEFORE = timedelta(minutes=15)
WATCH_AFTER = timedelta(minutes=30)
# 종목마다 남기는 완성 봉 수(최근 30분).
BARS_KEPT = 30
PERIOD = "1d"
REFERENCE = paper_bars.REFERENCE
# 감시 범위에 늘 더하는 기준 종목(지연 SPY, 시장 흐름 QQQ). 범위 행이 있을 때만 받습니다.
BENCHMARKS = (REFERENCE, "QQQ")
BAR = timedelta(seconds=60)


def _now() -> datetime:
    """지금 시각(UTC). 테스트가 시계를 바꿔 끼우는 자리입니다."""
    return datetime.now(timezone.utc)


def target_at(session: date, at_et: time) -> datetime:
    """확인 시각 T(UTC) — 그 세션 날짜의 뉴욕 시각이라 서머타임 전환 주에도 10:00 ET 그대로입니다."""
    return datetime.combine(session, at_et, tzinfo=paper_bars.NEW_YORK).astimezone(timezone.utc)


def in_window(now: datetime, session: date, at_et: time) -> bool:
    target = target_at(session, at_et)
    return target - WATCH_BEFORE <= now <= target + WATCH_AFTER


def ticker_entry(rows: list[dict], fetched_at: datetime) -> dict | None:
    """
    한 종목의 1분봉(market.minute_bars의 줄) → 항목(모양은 머리말). 완성된 봉(시작 + 60초 ≤ 받은 시각)만 쓰고, 마지막 완성 봉의 뉴욕 날짜
    세션만 남깁니다. 완성 봉이 없으면 None. 외부 호출·DB 없음 — 시험이 직접 부릅니다.
    """
    done = sorted(((paper_bars._bar_start(row["at"]), row) for row in rows
                   if paper_bars._bar_start(row["at"]) + BAR <= fetched_at), key=lambda item: item[0])
    if not done:
        return None
    session = done[-1][0].astimezone(paper_bars.NEW_YORK).date()
    day = [(start, row) for start, row in done if start.astimezone(paper_bars.NEW_YORK).date() == session]
    last_start, last = day[-1]
    return {
        "fetchedAt": fetched_at.isoformat(),
        "session": session.isoformat(),
        "bars": [paper_bars._bar(start, row) for start, row in day[-BARS_KEPT:]],
        "day": {"open": day[0][1]["open"], "high": max(row["high"] for _, row in day),
                "low": min(row["low"] for _, row in day)},
        "lastBar": {"t": last_start.isoformat(), "c": last["close"], "v": last["volume"]},
    }


def watch_lag_seconds(fetched_at: datetime, rows: list[dict] | None) -> int | None:
    """
    저장본의 지연 — paper_bars.lag_seconds에 이번 회차 SPY 응답의 마지막 봉(진행 중인 봉 포함 — 음수면 X1 단서)을 넘겨 셉니다. SPY를 받지
    못했으면 null.
    """
    if not rows:
        return None
    reference = {"sessions": paper_bars.session_entries(rows, fetched_at)}
    return paper_bars.lag_seconds(fetched_at, reference)


def _has_data(entry: dict) -> bool:
    return bool(entry.get("bars"))


def task_paper_watch_us() -> str:
    """🧪 계좌2 장중 확인(MINUTE) 날 확인 시각 앞뒤의 감시·보유·대기 종목 최근 1분봉(Yahoo) → 스냅샷 paper.watch.us."""
    now = _now()
    scope = store.watch_scope("US", now.astimezone(paper_bars.NEW_YORK).date())
    if not scope:
        raise EmptyResult("오늘 장중 확인(MINUTE) 계획이 없습니다 — Yahoo를 부르지 않음")
    session, at_et = scope["sessionDate"], scope["atEt"]
    label = at_et.strftime("%H:%M")
    if not in_window(now, session, at_et):
        raise EmptyResult(f"장중 확인 {session.isoformat()} {label} ET 앞 {int(WATCH_BEFORE.total_seconds() // 60)}분 ~ "
                          f"뒤 {int(WATCH_AFTER.total_seconds() // 60)}분 밖 — Yahoo를 부르지 않음")
    tickers = sorted(set(scope["watch"]) | set(scope["held"]) | set(scope["pending"]) | set(BENCHMARKS))
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지 ({latched})")

    rows, reason, _limited = market_service.minute_bars(tickers, PERIOD)
    fetched_at = _now()
    checkpoint = {"book": scope["book"], "sessionDate": session.isoformat(), "atEt": label}

    previous = previous_payload(catalog.SNAP_PAPER_WATCH_US)
    same = previous.get("checkpoint") == checkpoint and isinstance(previous.get("tickers"), dict)
    before = previous["tickers"] if same else {}
    fresh: dict[str, dict] = {}
    for ticker in tickers:
        entry = ticker_entry(rows.get(ticker) or [], fetched_at)
        if entry is not None:
            fresh[ticker] = entry
    if not fresh:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지" + (f" ({reason})" if reason else ""))

    received = sorted(fresh)
    missing = [ticker for ticker in tickers if ticker not in fresh]
    carried = carry_over_missing(fresh, before, tickers, reason, _has_data)
    lag = watch_lag_seconds(fetched_at, rows.get(REFERENCE))
    store.put_snapshot(catalog.SNAP_PAPER_WATCH_US, {
        "contract": CONTRACT,
        "source": SOURCE,
        "barLabel": paper_bars.BAR_LABEL,
        "reference": REFERENCE,
        "checkpoint": checkpoint,
        "scope": tickers,
        "fetchedAt": fetched_at.isoformat(),
        "lagSeconds": lag,
        "declaredDelayMin": None,
        "tickers": fresh,
        "missing": missing,
        "error": reason,
    })

    detail = (f"{len(received)}/{len(tickers)} 종목 · 장중 확인 {session.isoformat()} {label} ET" + carried_suffix(carried)
              + (f" · 지연 {lag}초({REFERENCE})" if lag is not None else ""))
    if reason:
        detail += f" — {reason}"
    return detail
