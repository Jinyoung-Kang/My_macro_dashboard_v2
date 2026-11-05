"""
app/tasks/paper_watch_kr.py
한국 Claude 계좌2의 단계 2b 장중 확인 — 확인 날 감시·보유·대기 종목의 최근 토스 1분봉 → 스냅샷 paper.watch.kr(속도군 session, 5분).

명세 docs/specs/2026-11-02-kr-claude2-stage2.md §5·§10. 이 저장본은 장중 확인 패킷(판단 입력)과 예상 상태의 가격에만 쓰입니다 — 장부 체결은 지금처럼
paper.kr.quotes·paper.kr.timed입니다(체결 출처를 늘리지 않음).

[범위] store.watch_plans("KR", 서울 오늘) — 오늘 세션의 PLANNED 계획 전부: 끈 판 한국 계좌2의 장중 확인 행 하나(store.watch_scope)와 켠 판(자유 시점 —
  ADR 0027) 한국 계좌들의 장중 판단 행(store.intraday_watch_plans), 그리고 그 계좌의 보유·대기 주문 종목(백엔드 표를 읽기만 — ADR 0008) + 기준 종목
  069500. 계획이 없으면 토스를 부르지 않고 정상으로 끝냅니다('… 호출 0회'). 지금 창 안인 계획이 여럿이면 저장본 한 장이 그 계획들의 종목 합집합과
  신원 목록(checkpoints)을 싣습니다.
[한 번] 확인 시각 T(그 세션 날짜의 서울 시각) ~ T + WATCH_AFTER 안에서, 이 확인(계좌·세션·시각)의 저장본이 T 뒤에 이미 있고 빠진 종목이 없으면 묻지
  않습니다(빠진 종목이 있으면 다음 회차에 다시 — 이 확인에서 WATCH_ATTEMPTS번까지). 토스 1분봉은 지연이 몇 초라(명세 §8 측정) T 뒤 한 장이면 확인 패킷에 충분합니다 — 미국 감시처럼 앞뒤 45분 동안 5분마다 받지 않습니다.
  창 밖·계획 없음도 호출 0회로 정상 끝(EmptyResult로 두면 session 군 실행이 늘 'empty' — paper_watch_us와 같은 까닭).
[받는 법] 종목마다 fetch_candles(1m, 200개, 원시가) 한 쪽 — 가장 최근 봉은 진행 중인 봉(라벨 = 봉 끝 > 받은 시각)이라 뺍니다. 실행당 호출 상한
  WATCH_CALL_BUDGET(감시 목록·기준 종목 먼저).
[실패] 받지 못한 종목은 같은 확인의 직전 저장본에서 잇고 isStale. 다른 확인의 저장본은 잇지 않습니다. 하나도 받지 못하면 EmptyResult로 저장본을 둡니다.

[저장본 모양 — contract 1]
  {contract, source, barLabel "END", reference "069500", checkpoint {book, sessionDate, atKst "HH:MM"},   # 창 안 계획 가운데 가장 이른 것
   checkpoints [{book, sessionDate, atKst, slot}…],   # 창 안 계획 전부(끈 판 장중 확인은 slot null, 켠 판 장중 판단은 1·2)
   scope [종목…], fetchedAt,
   attempt,                 # 이 확인에서 T 뒤에 받은 회차(1부터)
   lagSeconds,              # 기준 종목을 받은 시각 − 그 종목의 마지막 완성 봉 끝(라벨), 이번 회차에 받은 그날 봉일 때만, 아니면 null
   tickers {종목: {fetchedAt,
       session,             # 마지막 완성 봉의 날짜(오늘이 아니면 그 종목은 받지 못한 것으로 봄 — 휴장·정지)
       bars [{label, o, h, l, c, v}…],   # 그날 완성 봉 최근 BARS_KEPT개, 오래된 것부터(라벨은 봉 끝 KST HH:MM)
       windows {"09:00"·"10:00"…: [{label, open, volume}…]},  # 그날 지난 기준 시각의 창(라벨 T+1~T+5) — kr_paper_timed와 같은 모양.
                            # 그 계좌 대기 주문의 지정 시각(AT_MINUTE)·장중 시장가(MARKET) 기준 분도 지났으면 함께(예상 상태의 가격)
       firstAfter {"09:00"…: {label, open, volume} | null},     # 창 뒤(라벨 ≥ T+1) 첫 거래 봉
       lastBar {label, c, v},
       isStale?, staleReason?, staleSince?}},
   missing [이번에 받지 못한 종목], error}
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, time as clock_time, timedelta, timezone

from .. import catalog, store
from ..services import toss as toss_service

from . import kr_paper_timed
from .base import KST, EmptyResult, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)

CONTRACT = 1
SOURCE = "토스증권 1분봉(원시가) — 장중 확인 감시(확인 시각 뒤 한 번)"
BAR_LABEL = "END"
# 확인 시각 T 뒤로 묻는 창 — 백엔드 호출 창(T + 2 ~ + 20분)과 같은 끝.
WATCH_AFTER = timedelta(minutes=20)
# 종목마다 남기는 완성 봉 수(최근 30분).
BARS_KEPT = 30
PAGE = 200
# 지연 기준 종목(KODEX 200 — 늘 거래되는 KRX ETF). 범위 행이 있을 때만 받습니다.
REFERENCE = "069500"
# 실행당 토스 호출 상한 — 감시 ≤10 + 보유·대기(계좌2 주문은 하루 12건 안) + 기준 종목(DATA_SOURCES.md '한국 책 호출 예산').
WATCH_CALL_BUDGET = 30
SPACING_SECONDS = 0.1
# 한 확인에서 T 뒤에 받는 회차 상한 — 빠진 종목(정지 등)이 있어도 창 끝까지 5분마다 다시 묻지 않게.
WATCH_ATTEMPTS = 3
# 창을 뽑는 기준 시각 — 시가(09:00)와 매시 10:00~15:00(장중 확인 예상 상태가 기준 시각이 지난 대기 주문의 가격으로 씀).
OPEN_KEY = "09:00"


def _now() -> datetime:
    """지금 시각(서울). 테스트가 시계를 바꿔 끼우는 자리입니다."""
    return datetime.now(tz=KST)


def target_at(session: date, at_local: clock_time) -> datetime:
    """확인 시각 T — 그 세션 날짜의 서울 시각."""
    return datetime.combine(session, at_local, tzinfo=KST)


def _end(day: str, label: str) -> datetime:
    return datetime.combine(date.fromisoformat(day), datetime.strptime(label, "%H:%M").time(), tzinfo=KST)


def identity(plan: dict) -> dict:
    """계획 하나의 신원(저장본 checkpoints의 한 줄) — 계좌·세션·확인 시각(KST)·순번(끈 판 장중 확인은 None)."""
    return {"book": plan["book"], "sessionDate": plan["sessionDate"].isoformat(), "atKst": plan["atLocal"].strftime("%H:%M"),
            "slot": plan.get("slot")}


def identities(payload: dict) -> list[dict]:
    """저장본이 실은 계획 신원 — ``checkpoints`` 목록, 없으면(이 목록이 생기기 전 저장본) ``checkpoint`` 하나를 순번 없는 신원으로."""
    listed = payload.get("checkpoints")
    if isinstance(listed, list):
        return [item for item in listed if isinstance(item, dict)]
    single = payload.get("checkpoint")
    return [{**single, "slot": None}] if isinstance(single, dict) else []


def ticker_entry(candles: list[dict], fetched_at: datetime, extra_keys: tuple[str, ...] = ()) -> dict | None:
    """
    한 종목의 1분봉(fetch_candles의 봉 — 최신순) → 항목(모양은 머리말). 완성된 봉(라벨 = 봉 끝 ≤ 받은 시각)만 쓰고, 받은 날(서울)의 봉만 남깁니다.
    그날 완성 봉이 없으면 None. ``extra_keys``는 창을 더 뽑을 기준 분(그 계좌 대기 주문의 지정 시각·장중 시장가 — 'HH:MM')입니다. 외부 호출·DB
    없음 — 시험이 직접 부릅니다.
    """
    today = fetched_at.astimezone(KST).date().isoformat()
    done = {c["time"]: c for c in candles
            if c.get("date") == today and c.get("time") and _end(today, c["time"]) <= fetched_at}
    if not done:
        return None
    ordered = sorted(done)
    keys = [key for key in kr_paper_timed.window_keys((OPEN_KEY, *extra_keys)) if _end(today, key) < fetched_at]
    windows, first_after = kr_paper_timed.summarize_windows(done, keys)
    last = done[ordered[-1]]
    return {
        "fetchedAt": fetched_at.astimezone(timezone.utc).isoformat(),
        "session": today,
        "bars": [{"label": label, "o": done[label]["open"], "h": done[label]["high"], "l": done[label]["low"],
                  "c": done[label]["close"], "v": done[label]["volume"]} for label in ordered[-BARS_KEPT:]],
        "windows": windows,
        "firstAfter": first_after,
        "lastBar": {"label": last["time"], "c": last["close"], "v": last["volume"]},
    }


def lag_seconds(fetched_at: datetime, entry: dict | None) -> int | None:
    """저장본의 지연 — 받은 시각 − 기준 종목 마지막 완성 봉의 끝(라벨). 기준 종목을 받지 못했으면 null(0으로 채우지 않음)."""
    if not entry or not entry.get("lastBar"):
        return None
    return int((fetched_at - _end(entry["session"], entry["lastBar"]["label"])).total_seconds())


def _has_data(entry: dict) -> bool:
    return bool(entry.get("bars"))


def _ordered_scope(plans: list[dict]) -> list[str]:
    """받을 종목 — 감시 목록·기준 종목 먼저(호출 상한에 걸려도 판단 자료가 먼저), 그다음 보유·대기, 중복 없이. 계획이 여럿이면 합집합."""
    watch = [code for plan in plans for code in plan["watch"]]
    held = sorted({code for plan in plans for code in plan["held"]})
    pending = sorted({code for plan in plans for code in plan["pending"]})
    out: list[str] = []
    for code in [*watch, REFERENCE, *held, *pending]:
        if code not in out:
            out.append(code)
    return out


def _minute_keys(plans: list[dict], session: date) -> tuple[str, ...]:
    """
    창을 더 뽑을 기준 분 — 창 안 계획 계좌들의 대기 주문 가운데 오늘이 목표 세션인 분 단위 지정 시각(AT_MINUTE)의 그 시각과 장중 시장가(MARKET)의
    기준 분(kr_paper_timed.market_target). 예상 상태가 기준 시각이 지난 대기 주문의 가격을 이 창에서 읽습니다(없으면 마지막 봉 종가로 어림).
    목표 세션은 기준 거래일의 다음 KRX 거래일(kr_paper_timed.next_trading_day)입니다.
    """
    books = sorted({plan["book"] for plan in plans})
    keys: set[str] = set()
    for _code, as_of, at in store.kr_minute_orders(books):
        if kr_paper_timed.next_trading_day(as_of) == session:
            keys.add(at.strftime("%H:%M"))
    for _code, as_of, created_at in store.kr_market_orders(books):
        if kr_paper_timed.next_trading_day(as_of) == session:
            keys.add(kr_paper_timed.market_target(created_at))
    return tuple(sorted(keys))


def task_paper_watch_kr() -> str:
    """한국 계좌2 장중 확인 날 확인 시각 뒤의 감시·보유·대기 종목 최근 1분봉(토스) → 스냅샷 paper.watch.kr."""
    now = _now()
    plans = store.watch_plans("KR", now.date())
    if not plans:
        return "오늘 한국 장중 확인 계획 없음 — 호출 0회"
    session = plans[0]["sessionDate"]
    active = [plan for plan in plans
              if target_at(plan["sessionDate"], plan["atLocal"]) <= now <= target_at(plan["sessionDate"], plan["atLocal"]) + WATCH_AFTER]
    if not active:
        labels = "·".join(dict.fromkeys(plan["atLocal"].strftime("%H:%M") for plan in plans))
        return (f"한국 장중 확인 {session.isoformat()} {labels} KST ~ 뒤 {int(WATCH_AFTER.total_seconds() // 60)}분 밖 — 호출 0회")
    label = "·".join(dict.fromkeys(plan["atLocal"].strftime("%H:%M") for plan in active))
    checkpoints = [identity(plan) for plan in active]
    checkpoint = {key: checkpoints[0][key] for key in ("book", "sessionDate", "atKst")}
    previous = previous_payload(catalog.SNAP_PAPER_WATCH_KR)
    carried_from = identities(previous)
    same = any(item in carried_from for item in checkpoints) and isinstance(previous.get("tickers"), dict)
    # 창 안 계획이 모두 직전 저장본에 실려 있고 그 저장본을 가장 늦은 확인 시각 뒤에 받았으면 '이미 받음'(계획이 더해졌으면 다시 받음).
    latest = max(target_at(plan["sessionDate"], plan["atLocal"]) for plan in active)
    after = (same and all(item in carried_from for item in checkpoints) and bool(previous.get("fetchedAt"))
             and datetime.fromisoformat(previous["fetchedAt"]) >= latest)
    attempt = (previous.get("attempt") or 0) if after and isinstance(previous.get("attempt"), int) else 0
    if after and (not previous.get("missing") or attempt >= WATCH_ATTEMPTS):
        return (f"한국 장중 확인 {session.isoformat()} {label} KST 감시 저장본 있음(T 뒤 {attempt}회) — 호출 0회")

    tickers = _ordered_scope(active)
    extra_keys = _minute_keys(active, session)
    asked = tickers[:WATCH_CALL_BUDGET]
    fresh: dict[str, dict] = {}
    failed: list[str] = []
    reason = None
    fetched_at = now
    reference_at = None   # 기준 종목을 받은 시각 — 지연은 이것으로(뒤에 받는 보유·대기 종목의 시각을 섞지 않음 — QA-193)
    for index, code in enumerate(asked):
        if index and SPACING_SECONDS:
            time.sleep(SPACING_SECONDS)
        try:
            candles, _ = toss_service.fetch_candles(code, "1m", PAGE, adjusted=False)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"토스 키 없음 — 기존 저장본 유지 ({exc})") from exc
        except toss_service.TossForbidden as exc:
            failed.append(f"{code} 거부됨")
            logger.warning("한국 감시 1분봉 403 (%s): %s — 나머지는 묻지 않음", code, exc)
            break
        except toss_service.TossError as exc:
            failed.append(f"{code} {exc}")
            continue
        fetched_at = _now()
        entry = ticker_entry(candles, fetched_at, extra_keys)
        if entry is None:
            failed.append(f"{code} 그날 완성 봉 없음")
            continue
        fresh[code] = entry
        if code == REFERENCE:
            reference_at = fetched_at
    if len(tickers) > len(asked):
        failed.append(f"호출 상한 {WATCH_CALL_BUDGET}회 — {len(tickers) - len(asked)}종목 묻지 않음")
    if failed:
        reason = f"받지 못함 {len(failed)}개({'; '.join(failed[:3])}{'…' if len(failed) > 3 else ''})"
    if not fresh:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지" + (f" ({reason})" if reason else ""))

    received = sorted(fresh)
    missing = [code for code in tickers if code not in fresh]
    carried = carry_over_missing(fresh, previous["tickers"] if same else {}, tickers, reason, _has_data)
    lag = lag_seconds(reference_at, fresh.get(REFERENCE)) if reference_at is not None else None
    store.put_snapshot(catalog.SNAP_PAPER_WATCH_KR, {
        "contract": CONTRACT,
        "source": SOURCE,
        "barLabel": BAR_LABEL,
        "reference": REFERENCE,
        "checkpoint": checkpoint,
        "checkpoints": checkpoints,
        "scope": tickers,
        "fetchedAt": fetched_at.astimezone(timezone.utc).isoformat(),
        "attempt": attempt + 1,
        "lagSeconds": lag,
        "tickers": fresh,
        "missing": missing,
        "error": reason,
    })
    detail = (f"{len(received)}/{len(tickers)} 종목 · 한국 장중 확인 {session.isoformat()} {label} KST" + carried_suffix(carried)
              + (f" · 지연 {lag}초({REFERENCE})" if lag is not None else ""))
    if reason:
        detail += f" — {reason}"
    return detail
