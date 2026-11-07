"""
app/tasks/paper_stopwatch.py
모의 장중 스탑 감시(ADR 0032) — 미국·한국 모의 책(규칙·Claude 계좌1·2, 벤치마크 제외)의 보유 종목 1분봉을 정규장 동안 5분마다 받아
스냅샷 paper.stopwatch.us·paper.stopwatch.kr(속도군 session — 매 5분 :20초).

판정(스탑선 아래가 5분 감시 두 번 이어짐·개장 10분 전 매도 없음·갭 가드)과 주문은 백엔드가 합니다(설정·최고가·재진입 금지를 아는 곳, 주문 표를 쓰는
프로세스 — ADR 0008). 이 태스크는 그 판정의 입력만 모읍니다.

[스위치] 설정 ``stopWatch.mode``(미국)·``kr.stopWatch.mode``(한국)가 SHADOW·ON일 때만 받습니다(백엔드 표 ``paper_settings``를 읽기만 —
  store.stopwatch_settings). OFF(기본 — 키가 없는 행도)면 외부 호출 0회로 정상 끝. 로컬 스택(복원 데이터)이 장중에 외부를 부르지 않게(통합 검토 R8).
[범위] store.stopwatch_scope(시장) — 운용 중이고 벤치마크가 아닌 책의 보유 종목(백엔드 표를 읽기만) + 기준 종목(미국 SPY·한국 069500 — 지연과
  지수 사건의 입력). 보유가 없으면 호출 0회.
[창] 그 세션의 개장 + 4분 ~ 장 끝 여유 앞 + 1분(미국 09:34~15:56 ET — 격자 끝 15:55, 한국 09:04~15:21 KST — 격자 끝 15:20, 수능일 등 장 시간 변경일은
  설정 ``kr.calendar.openTimeOverrides``의 그날 개장·마감에서). 미국 휴장·조기 폐장은 수집기가 모르므로 첫 응답의 SPY로 배웁니다 — 그날 세션 봉이
  없으면(휴장) 그날 남은 회차는 묻지 않고, 정규장 끝(Yahoo currentTradingPeriod)을 그날의 창 끝으로 씁니다. 한국은 KRX 휴장일에 묻지 않고, 기준 종목에
  그날 완성 봉이 없으면 나머지를 묻지 않습니다(임시 휴장 — 호출 1회). 마지막 격자(미국 15:55·한국 15:20)는 그 회차 하나만 받을 수 있어 다음
  회차가 메우지 못합니다 — 그 회차가 빠지면(session 군의 앞 태스크가 길어 창 끝을 넘김·쉼·래치) 백엔드의 덮음 판정이 거짓이 되어 장부의 대체 경로
  (미국 마감 뒤 관측치의 종가 스탑·한국 밤 스탑)가 그날 끝을 맡습니다(StopWatch.covered — QA-307).
[미국 쉼] slow 군이 Yahoo를 쓰는 동안(runner.slow_yahoo_busy — 매시 :15 관측치·1분봉) 이번 회차를 쉽니다(통합 검토 R7 — 429 경합으로 장부 관측치를
  잃지 않게). 쉬어도 다음 회차가 그날 1분봉을 통째로 받으므로(spark range=1d) 빠진 격자는 백엔드가 그 저장본으로 판정합니다. 공용 Yahoo 래치나 spark
  호스트 래치가 닫혀 있으면 묻지 않고, 이 회차가 거부를 받으면 다음 두 회차를 쉽니다.
[받는 법] 미국: Yahoo spark(``v7/finance/spark``, range=1d·interval=1m — 20종목 한 요청, 2026-11-06 실측: 종가만·봉 시각은 시작 epoch, 진행 중인 봉은
  분에 맞지 않는 시각) — yfinance 종목별 요청의 약 1/20. 한국: 토스 1분봉(원시가, 200개 한 쪽 — 개장 봉까지 닿게)과, 그 세션에 처음 보는 종목은
  토스 일봉 원시·수정 각 1쪽(전일 종가 — 백엔드 갭 가드). 실행당 호출 상한 ``KR_CALL_BUDGET``(1분봉 먼저), 호출 사이 0.1초, ``KR_TIME_BUDGET``초가
  지나면 새 호출을 시작하지 않음.
[실패] 받지 못한 종목은 같은 세션의 직전 항목을 잇고 isStale(다른 세션 항목은 잇지 않음 — 어제 값을 오늘 감시로 보이지 않게). 하나도 받지 못하면
  EmptyResult로 저장본을 둡니다.

[저장본 모양 — contract 1]
  미국 {contract, source, market "US", barLabel "START", reference "SPY", mode, scope [티커…], fetchedAt, lagSeconds,
        tickers {T: {fetchedAt, session(마지막 완성 봉의 뉴욕 날짜),
                     bars [{t(봉 시작 UTC ISO), c}…](그 세션 완성 봉 최근 BARS_KEPT개 — spark는 거래량을 주지 않음),
                     day {first {t, c}}(그 세션 첫 봉 — 응답이 정규장 첫 분부터일 때만, 아니면 직전 같은 세션 항목에서 이음),
                     lastBar {t, c}, prevClose(Yahoo previousClose — 전일 정규장 종가, 없으면 null), isStale?…}},
        missing, error}
  한국 {contract, source, market "KR", barLabel "END", reference "069500", mode, scope, fetchedAt, lagSeconds,
        tickers {종목: {fetchedAt, session(받은 날 — 서울),
                       bars [{label(봉 끝 KST HH:MM), o, h, l, c, v}…](그날 완성 봉 최근 BARS_KEPT개),
                       day {first {label, o}}(그날 첫 봉 — 쪽이 개장 봉까지 닿았을 때만, 아니면 직전 같은 세션 항목에서 이음),
                       lastBar {label, c, v}, prevClose {date, raw, adjusted}(토스 일봉 전일 원시·수정 종가 — 그 세션에 한 번), isStale?…}},
        missing, error}
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, time as clock_time, timedelta, timezone
from zoneinfo import ZoneInfo

from .. import catalog, http, krcalendar, store
from ..services import live_prices
from ..services import toss as toss_service

from .base import KST, EmptyResult, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)

CONTRACT = 1
NEW_YORK = ZoneInfo("America/New_York")
WATCHING = ("SHADOW", "ON")
# 종목마다 남기는 완성 봉 수 — 감시 회차를 몇 번 쉬어도(slow 군·래치) 빠진 격자의 앞뒤 두 표본이 남게 40분.
BARS_KEPT = 40
BAR = timedelta(seconds=60)
# 격자 G = 개장 + 5분 × k(백엔드 StopWatch)의 첫 G를 받는 회차부터, 마지막 G(장 끝 여유 앞)를 받는 회차까지.
WINDOW_LEAD = timedelta(minutes=4)
WINDOW_TAIL = timedelta(minutes=1)

# ---- 미국 ----
US_SOURCE = "Yahoo spark 1분봉(종가만) — 정규장·원시가, 장중 스탑 감시(5분 수집)"
US_REFERENCE = "SPY"
US_OPEN = clock_time(9, 30)
US_CLOSE = clock_time(16, 0)
# 장 끝 여유 — 마감 5분 전부터는 감시 격자가 없음(백엔드 SessionWindows.US_MARKET_TAIL과 같은 값).
US_TAIL = timedelta(minutes=5)
SPARK_BATCH = live_prices.BATCH
SPARK_TIMEOUT = live_prices.FETCH_TIMEOUT
SPARK_HOST = http.host_of(live_prices.YAHOO_SPARK)
# 거부(403·429)를 받은 뒤 쉬는 회차 수.
REST_AFTER_REJECT = 2
# 미국 휴장(첫 응답의 SPY 세션이 오늘이 아님)으로 볼 수 있는 가장 이른 뉴욕 시각 — 개장 직후 Yahoo가 그날 봉을 아직 주지 않은 지연과 가르려고.
US_CLOSED_AFTER = clock_time(9, 45)

# ---- 한국 ----
KR_SOURCE = "토스증권 1분봉(원시가)·일봉 전일 종가 — 장중 스탑 감시(5분 수집)"
KR_REFERENCE = "069500"
KR_OPEN = krcalendar.OPEN
KR_CLOSE = krcalendar.CLOSE
# 종가 단일가 — 마감 10분 전부터는 감시 격자가 없음(백엔드 SessionWindows.KR_CLOSING_AUCTION과 같은 값).
KR_TAIL = timedelta(minutes=10)
KR_PAGE = 200
KR_DAILY_PAGE = 3
KR_CALL_BUDGET = 120
KR_TIME_BUDGET = 40.0
SPACING_SECONDS = 0.1
# 일봉 전일 종가의 원시·수정 값이 이만큼 넘게 다르면 백엔드가 그날 그 종목을 감시에서 뺍니다(갭 가드) — 여기서는 값만 싣습니다.

# 이 프로세스의 상태(메모리 — 기동하면 처음부터).
_us_rest_rounds = 0                        # 거부 뒤 쉬어야 할 남은 회차
_us_days: dict[date, dict] = {}            # 뉴욕 날짜 → {"closed": bool, "end": datetime | None} — 첫 응답에서 배운 그날의 세션


def _now() -> datetime:
    """지금 시각(UTC). 테스트가 시계를 바꿔 끼우는 자리입니다."""
    return datetime.now(timezone.utc)


def reset_state() -> None:
    """프로세스 상태를 기동 직후로(시험용)."""
    global _us_rest_rounds
    _us_rest_rounds = 0
    _us_days.clear()


def _slow_busy() -> bool:
    from . import runner   # runner가 registry → 이 모듈을 읽으므로 함수 안에서(순환 import 방지)

    return runner.slow_yahoo_busy()


def _same_session(previous: dict, session: str) -> dict:
    """직전 저장본의 항목 가운데 같은 세션 것만(다른 세션 항목은 잇지 않음)."""
    tickers = previous.get("tickers") if isinstance(previous.get("tickers"), dict) else {}
    return {key: entry for key, entry in tickers.items() if isinstance(entry, dict) and entry.get("session") == session}


def _has_data(entry: dict) -> bool:
    return bool(entry.get("bars"))


# ==============================================================================
# 미국 — Yahoo spark
# ==============================================================================
def spark_series(payload) -> dict[str, dict]:
    """
    spark 응답 → {심볼: {"points": [(epoch초, 종가|None)…], "prevClose": float|None, "regular": (시작 epoch, 끝 epoch)|None}}. 모양이 다른 줄은
    뺍니다. 외부 호출·DB 없음 — 시험이 고정 응답으로 부릅니다.
    """
    out: dict[str, dict] = {}
    results = ((payload or {}).get("spark") or {}).get("result") if isinstance(payload, dict) else None
    for result in results if isinstance(results, list) else []:
        responses = result.get("response") if isinstance(result, dict) else None
        response = responses[0] if isinstance(responses, list) and responses and isinstance(responses[0], dict) else None
        if response is None:
            continue
        meta = response.get("meta") if isinstance(response.get("meta"), dict) else {}
        symbol = str(meta.get("symbol") or result.get("symbol") or "").upper()
        stamps = response.get("timestamp") if isinstance(response.get("timestamp"), list) else []
        quotes = ((response.get("indicators") or {}).get("quote") or [{}]) if isinstance(response.get("indicators"), dict) else [{}]
        closes = quotes[0].get("close") if quotes and isinstance(quotes[0], dict) and isinstance(quotes[0].get("close"), list) else []
        if not symbol or len(stamps) != len(closes):
            continue
        points = []
        for stamp, close in zip(stamps, closes):
            if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
                continue
            value = float(close) if isinstance(close, (int, float)) and not isinstance(close, bool) and close > 0 else None
            points.append((int(stamp), value))
        prev = meta.get("previousClose", meta.get("chartPreviousClose"))
        period = ((meta.get("currentTradingPeriod") or {}).get("regular") or {}) if isinstance(meta.get("currentTradingPeriod"), dict) else {}
        start, end = period.get("start"), period.get("end")
        out[symbol] = {
            "points": points,
            "prevClose": float(prev) if isinstance(prev, (int, float)) and not isinstance(prev, bool) and prev > 0 else None,
            "regular": (int(start), int(end)) if isinstance(start, (int, float)) and isinstance(end, (int, float)) else None,
        }
    return out


def us_entry(series: dict | None, fetched_at: datetime) -> dict | None:
    """
    한 종목의 spark 줄 → 항목(모양은 머리말). 분에 맞고(진행 중인 봉은 마지막 거래 시각이라 분에 맞지 않음) 완성된(시작 + 60초 ≤ 받은 시각) 거래 봉만
    쓰고, 마지막 완성 봉의 뉴욕 날짜 세션만 남깁니다. 완성 봉이 없으면 None. 첫 봉(``day.first``)은 그 세션의 정규장 첫 분 봉이 응답에 있을 때만.
    """
    if not series:
        return None
    done = []
    for stamp, close in series["points"]:
        start = datetime.fromtimestamp(stamp, timezone.utc)
        if stamp % 60 == 0 and close is not None and start + BAR <= fetched_at:
            done.append((start, close))
    if not done:
        return None
    done.sort(key=lambda item: item[0])
    session = done[-1][0].astimezone(NEW_YORK).date()
    day = [(start, close) for start, close in done if start.astimezone(NEW_YORK).date() == session]
    first_start, first_close = day[0]
    regular = series.get("regular")
    opened = (datetime.fromtimestamp(regular[0], timezone.utc) if regular
              and datetime.fromtimestamp(regular[0], timezone.utc).astimezone(NEW_YORK).date() == session
              else datetime.combine(session, US_OPEN, tzinfo=NEW_YORK).astimezone(timezone.utc))
    last_start, last_close = day[-1]
    entry = {
        "fetchedAt": fetched_at.isoformat(),
        "session": session.isoformat(),
        "bars": [{"t": start.isoformat(), "c": close} for start, close in day[-BARS_KEPT:]],
        "lastBar": {"t": last_start.isoformat(), "c": last_close},
        "prevClose": series.get("prevClose"),
    }
    if first_start == opened:
        entry["day"] = {"first": {"t": first_start.isoformat(), "c": first_close}}
    return entry


def us_lag_seconds(fetched_at: datetime, entry: dict | None, today: date) -> int | None:
    """지연 — 받은 시각 − (SPY 마지막 완성 봉 시작 + 60초), 그날 세션 항목일 때만. 아니면 null(0으로 채우지 않음)."""
    if not entry or entry.get("session") != today.isoformat():
        return None
    return int((fetched_at - (datetime.fromisoformat(entry["lastBar"]["t"]) + BAR)).total_seconds())


def _fetch_spark(tickers: list[str]) -> tuple[dict[str, dict], str | None]:
    """spark를 20종목씩 — 거부·오류가 나면 나머지 묶음은 묻지 않음. (심볼 → 줄, 사유)"""
    out: dict[str, dict] = {}
    for start in range(0, len(tickers), SPARK_BATCH):
        chunk = tickers[start:start + SPARK_BATCH]
        try:
            res = http.get_session().get(live_prices.YAHOO_SPARK, timeout=SPARK_TIMEOUT, headers=live_prices.YAHOO_HEADERS,
                                         params={"symbols": ",".join(chunk), "range": "1d", "interval": "1m"})
            if res.status_code != 200:
                return out, f"spark HTTP {res.status_code}"
            out.update(spark_series(res.json()))
        except http.SourceRejected:
            raise
        except Exception as exc:  # noqa: BLE001 — 한 묶음의 실패는 사유로 남기고 받은 것은 저장
            return out, f"spark {http.brief_error(exc)}"
    return out, None


def _us_window(now: datetime) -> tuple[datetime, datetime, str | None]:
    """그 뉴욕 날짜의 감시 창과 쉼 사유(주말·배운 휴장) — (시작, 끝, 사유|None)."""
    local = now.astimezone(NEW_YORK)
    day = local.date()
    start = datetime.combine(day, US_OPEN, tzinfo=NEW_YORK) + WINDOW_LEAD
    end = datetime.combine(day, US_CLOSE, tzinfo=NEW_YORK) - US_TAIL + WINDOW_TAIL
    if local.weekday() >= 5:
        return start, end, "주말"
    learned = _us_days.get(day)
    if learned and learned.get("closed"):
        return start, end, "휴장(첫 응답에 그날 세션 봉 없음)"
    if learned and learned.get("end"):
        end = min(end, learned["end"] - US_TAIL + WINDOW_TAIL)
    return start, end, None


def _learn_us_day(now: datetime, series: dict | None, entry: dict | None) -> None:
    """
    응답의 SPY로 그날 세션을 배웁니다 — 정규장 끝(조기 폐장)과 휴장(개장 15분 뒤에도 그날 세션 봉 없음). SPY 줄을 받지 못했으면(묶음 실패) 배우지
    않습니다(받지 못한 것을 휴장으로 읽지 않게). 날짜는 오늘 하나만 둡니다.
    """
    if series is None:
        return
    local = now.astimezone(NEW_YORK)
    day = local.date()
    state = {"closed": False, "end": None}
    regular = (series or {}).get("regular")
    if regular:
        end = datetime.fromtimestamp(regular[1], timezone.utc)
        if end.astimezone(NEW_YORK).date() == day:
            state["end"] = end
    if (entry is None or entry.get("session") != day.isoformat()) and local.time() >= US_CLOSED_AFTER:
        state["closed"] = True
    _us_days.clear()
    _us_days[day] = state


def task_paper_stopwatch_us() -> str:
    """미국 장중 스탑 감시 — 정규장 동안 미국 모의 책 보유 종목·SPY의 1분봉(Yahoo spark) → 스냅샷 paper.stopwatch.us."""
    global _us_rest_rounds
    mode = store.stopwatch_settings()["US"]
    if mode not in WATCHING:
        return "장중 스탑 감시 꺼짐(stopWatch.mode OFF) — 호출 0회"
    now = _now()
    start, end, closed = _us_window(now)
    if closed:
        return f"{closed} — 호출 0회"
    if not start <= now <= end:
        return (f"정규장 감시 창({start.astimezone(NEW_YORK):%H:%M}~{end.astimezone(NEW_YORK):%H:%M} ET) 밖 — 호출 0회")
    if _slow_busy():
        return "slow 군이 Yahoo를 쓰는 중 — 이번 회차 쉼(호출 0회, 다음 회차가 그날 1분봉으로 메움)"
    if _us_rest_rounds > 0:
        _us_rest_rounds -= 1
        return f"거부 뒤 쉼(남은 {_us_rest_rounds}회) — 호출 0회"
    scope = store.stopwatch_scope("US")
    if not scope:
        return "감시할 보유 없음 — 호출 0회"
    tickers = [US_REFERENCE] + [ticker for ticker in scope if ticker != US_REFERENCE]
    for host in (http.YAHOO_HOST, SPARK_HOST):
        latched = http.active_rejection(host)
        if latched is not None:
            raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지 ({latched})")

    try:
        series, reason = _fetch_spark(tickers)
    except http.SourceRejected as exc:
        _us_rest_rounds = REST_AFTER_REJECT
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지 ({exc})") from exc
    fetched_at = _now()
    today = fetched_at.astimezone(NEW_YORK).date()
    fresh: dict[str, dict] = {}
    for ticker in tickers:
        entry = us_entry(series.get(ticker), fetched_at)
        if entry is not None:
            fresh[ticker] = entry
    _learn_us_day(fetched_at, series.get(US_REFERENCE), fresh.get(US_REFERENCE))
    if not fresh:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지" + (f" ({reason})" if reason else ""))

    session = today.isoformat()
    before = _same_session(previous_payload(catalog.SNAP_PAPER_STOPWATCH_US), session)
    for ticker, entry in fresh.items():
        carried = before.get(ticker)
        if "day" not in entry and entry["session"] == session and isinstance(carried, dict) and isinstance(carried.get("day"), dict):
            entry["day"] = carried["day"]
    missing = [ticker for ticker in tickers if ticker not in fresh]
    carried = carry_over_missing(fresh, before, tickers, reason, _has_data)
    lag = us_lag_seconds(fetched_at, fresh.get(US_REFERENCE), today)
    store.put_snapshot(catalog.SNAP_PAPER_STOPWATCH_US, {
        "contract": CONTRACT,
        "source": US_SOURCE,
        "market": "US",
        "barLabel": "START",
        "reference": US_REFERENCE,
        "mode": mode,
        "scope": tickers,
        "fetchedAt": fetched_at.isoformat(),
        "lagSeconds": lag,
        "tickers": fresh,
        "missing": missing,
        "error": reason,
    })
    detail = (f"{len(tickers) - len(missing)}/{len(tickers)} 종목 · {mode}" + carried_suffix(carried)
              + (f" · 지연 {lag}초({US_REFERENCE})" if lag is not None else ""))
    return detail + (f" — {reason}" if reason else "")


# ==============================================================================
# 한국 — 토스 1분봉·일봉
# ==============================================================================
def _end(day: str, label: str) -> datetime:
    return datetime.combine(date.fromisoformat(day), datetime.strptime(label, "%H:%M").time(), tzinfo=KST)


def kr_hours(day: date, overrides: dict) -> tuple[clock_time, clock_time]:
    """그날의 개장·마감(KST) — 설정 ``kr.calendar.openTimeOverrides``에 그날이 있으면 그 값(수능일 등), 아니면 09:00·15:30. 읽을 수 없는 값은 보통 날."""
    item = overrides.get(day.isoformat()) if isinstance(overrides, dict) else None
    if isinstance(item, dict):
        try:
            return (datetime.strptime(str(item.get("open")), "%H:%M").time(),
                    datetime.strptime(str(item.get("close")), "%H:%M").time())
        except ValueError:
            pass
    return KR_OPEN, KR_CLOSE


def kr_entry(candles: list[dict], fetched_at: datetime, first_label: str) -> dict | None:
    """
    한 종목의 토스 1분봉(최신순) → 항목(모양은 머리말). 그날(서울) 완성 봉(라벨 = 봉 끝 ≤ 받은 시각)만 쓰고, 그날 완성 봉이 없으면 None. 첫 봉
    (``day.first``)은 쪽이 그날 개장 봉(``first_label`` — 개장 + 1분)까지 닿았을 때만 — 그날 가장 이른 봉이 개장 봉이거나 쪽에 전날 봉이 있을 때.
    """
    today = fetched_at.astimezone(KST).date().isoformat()
    done = {c["time"]: c for c in candles
            if c.get("date") == today and c.get("time") and c.get("close") and _end(today, c["time"]) <= fetched_at}
    if not done:
        return None
    ordered = sorted(done)
    last = done[ordered[-1]]
    entry = {
        "fetchedAt": fetched_at.astimezone(timezone.utc).isoformat(),
        "session": today,
        "bars": [{"label": label, "o": done[label]["open"], "h": done[label]["high"], "l": done[label]["low"],
                  "c": done[label]["close"], "v": done[label]["volume"]} for label in ordered[-BARS_KEPT:]],
        "lastBar": {"label": last["time"], "c": last["close"], "v": last["volume"]},
    }
    reached = ordered[0] <= first_label or any((c.get("date") or "") < today for c in candles)
    if reached and done[ordered[0]].get("open"):
        entry["day"] = {"first": {"label": ordered[0], "o": done[ordered[0]]["open"]}}
    return entry


def prev_close(raw: list[dict], adjusted: list[dict], today: date) -> dict | None:
    """토스 일봉 원시·수정(최신순) → 오늘 전 마지막 날의 {date, raw, adjusted}(수정 값은 같은 날짜가 있을 때만, 없으면 null). 원시 값이 없으면 None."""
    before = sorted((c for c in raw if (c.get("date") or "") < today.isoformat() and c.get("close")), key=lambda c: c["date"])
    if not before:
        return None
    last = before[-1]
    same = next((c for c in adjusted if c.get("date") == last["date"] and c.get("close")), None)
    return {"date": last["date"], "raw": last["close"], "adjusted": same["close"] if same else None}


def kr_lag_seconds(fetched_at: datetime | None, entry: dict | None) -> int | None:
    """지연 — 기준 종목을 받은 시각 − 그 종목 마지막 완성 봉 끝(라벨). 받지 못했으면 null."""
    if fetched_at is None or not entry or not entry.get("lastBar"):
        return None
    return int((fetched_at - _end(entry["session"], entry["lastBar"]["label"])).total_seconds())


def task_paper_stopwatch_kr() -> str:
    """한국 장중 스탑 감시 — 정규장 동안 한국 모의 책 보유 종목·069500의 토스 1분봉(+ 그 세션 처음이면 일봉 전일 종가) → paper.stopwatch.kr."""
    settings = store.stopwatch_settings()
    mode = settings["KR"]
    if mode not in WATCHING:
        return "한국 장중 스탑 감시 꺼짐(kr.stopWatch.mode OFF) — 호출 0회"
    now = _now().astimezone(KST)
    today = now.date()
    if not krcalendar.is_trading_day(today):
        return "한국 휴장일 — 호출 0회"
    opens, closes = kr_hours(today, settings.get("krOpenOverrides") or {})
    start = datetime.combine(today, opens, tzinfo=KST) + WINDOW_LEAD
    end = datetime.combine(today, closes, tzinfo=KST) - KR_TAIL + WINDOW_TAIL
    if not start <= now <= end:
        return f"정규장 감시 창({start:%H:%M}~{end:%H:%M} KST) 밖 — 호출 0회"
    scope = store.stopwatch_scope("KR")
    if not scope:
        return "감시할 보유 없음 — 호출 0회"
    tickers = [KR_REFERENCE] + [code for code in scope if code != KR_REFERENCE]
    first_label = (datetime.combine(today, opens) + BAR).strftime("%H:%M")
    session = today.isoformat()
    before = _same_session(previous_payload(catalog.SNAP_PAPER_STOPWATCH_KR), session)

    began = time.monotonic()
    calls = 0
    fresh: dict[str, dict] = {}
    failed: list[str] = []
    reference_at = None
    stopped = False

    def call(*args, **kwargs):
        nonlocal calls
        if calls and SPACING_SECONDS:
            time.sleep(SPACING_SECONDS)
        calls += 1
        return toss_service.fetch_candles(*args, **kwargs)

    def room() -> bool:
        return calls < KR_CALL_BUDGET and time.monotonic() - began < KR_TIME_BUDGET

    for code in tickers:
        if not room():
            failed.append(f"호출 상한·시간 — {len(tickers) - tickers.index(code)}종목 묻지 않음")
            break
        try:
            candles, _ = call(code, "1m", KR_PAGE, adjusted=False)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"토스 키 없음 — 기존 저장본 유지 ({exc})") from exc
        except toss_service.TossForbidden as exc:
            failed.append(f"{code} 거부됨")
            logger.warning("한국 스탑 감시 1분봉 403 (%s): %s — 나머지는 묻지 않음", code, exc)
            stopped = True
            break
        except toss_service.TossError as exc:
            failed.append(f"{code} {exc}")
            continue
        fetched_at = _now().astimezone(KST)
        entry = kr_entry(candles, fetched_at, first_label)
        if entry is None:
            if code == KR_REFERENCE:
                return f"{KR_REFERENCE}에 그날 완성 봉 없음(임시 휴장·개장 지연) — 호출 1회"
            failed.append(f"{code} 그날 완성 봉 없음")
            continue
        carried = before.get(code) if isinstance(before.get(code), dict) else {}
        if "day" not in entry and isinstance(carried.get("day"), dict):
            entry["day"] = carried["day"]
        if isinstance(carried.get("prevClose"), dict):
            entry["prevClose"] = carried["prevClose"]
        fresh[code] = entry
        if code == KR_REFERENCE:
            reference_at = fetched_at

    # 그 세션에 처음 보는 종목의 전일 종가(일봉 원시·수정 — 갭 가드의 입력). 1분봉을 다 받은 뒤 남은 예산으로.
    for code in [code for code in tickers if code in fresh and "prevClose" not in fresh[code]]:
        if stopped or calls + 2 > KR_CALL_BUDGET or not room():
            break   # 원시·수정 두 쪽을 함께 받을 예산이 없으면 다음 회차에(한쪽만 받은 전일 종가를 만들지 않음)
        try:
            raw, _ = call(code, "1d", KR_DAILY_PAGE, adjusted=False)
            adjusted, _ = call(code, "1d", KR_DAILY_PAGE, adjusted=True)
        except toss_service.TossForbidden as exc:
            failed.append(f"{code} 일봉 거부됨")
            logger.warning("한국 스탑 감시 일봉 403 (%s): %s — 나머지는 묻지 않음", code, exc)
            break
        except toss_service.TossError as exc:
            failed.append(f"{code} 일봉 {exc}")
            continue
        close = prev_close(raw, adjusted, today)
        if close is not None:
            fresh[code]["prevClose"] = close

    reason = (f"받지 못함 {len(failed)}개({'; '.join(failed[:3])}{'…' if len(failed) > 3 else ''})" if failed else None)
    if not fresh:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지" + (f" ({reason})" if reason else ""))
    missing = [code for code in tickers if code not in fresh]
    carried = carry_over_missing(fresh, before, tickers, reason, _has_data)
    lag = kr_lag_seconds(reference_at, fresh.get(KR_REFERENCE))
    without_close = [code for code in fresh if "prevClose" not in fresh[code]]
    store.put_snapshot(catalog.SNAP_PAPER_STOPWATCH_KR, {
        "contract": CONTRACT,
        "source": KR_SOURCE,
        "market": "KR",
        "barLabel": "END",
        "reference": KR_REFERENCE,
        "mode": mode,
        "scope": tickers,
        "fetchedAt": _now().isoformat(),
        "lagSeconds": lag,
        "tickers": fresh,
        "missing": missing,
        "error": reason,
    })
    detail = (f"{len(tickers) - len(missing)}/{len(tickers)} 종목 · {mode} · 호출 {calls}회" + carried_suffix(carried)
              + (f" · 전일 종가 없음 {len(without_close)}종목" if without_close else "")
              + (f" · 지연 {lag}초({KR_REFERENCE})" if lag is not None else ""))
    return detail + (f" — {reason}" if reason else "")
