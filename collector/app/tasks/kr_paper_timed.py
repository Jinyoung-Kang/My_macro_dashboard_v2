"""
app/tasks/kr_paper_timed.py
한국 Claude 계좌2 시각 지정 체결의 1분봉 — 스냅샷 ``paper.kr.timed``(contract 1, 단계 2a — 명세 docs/specs/2026-11-02-kr-claude2-stage2.md §3).

한국 Claude 계좌2(``kr_claude2``)가 매시(``AT_1000``~``AT_1500``)·종가(``NEXT_CLOSE``)로 낸 대기 주문의 종목마다, 목표 세션 E(기준 거래일 다음 KR
거래일)가 끝난 뒤(E 15:40 KST) 토스 1분봉을 한 번 받아 장부가 쓸 칸만 저장합니다. 시가(``NEXT_OPEN``)는 지금처럼 ``paper.kr.quotes``의 개장 봉입니다.

모양(contract 1)::

    {"contract": 1, "source": "토스증권 1분봉(원시가)",
     "sessions": {"2026-11-03": {"005930": {
         "status": "OK" | "NO_BARS" | "FAILED", "reason": str | null, "fetchedAt": ISO(UTC),
         "windows": {"10:00": [{"label": "10:01", "open": 71200.0, "volume": 1234}, …(라벨 hh:01~hh:05, 있는 봉만)], …"15:00": […]},
         "firstAfter": {"10:00": {"label": "10:07", "open": …, "volume": …} | null, …},
         "closes": {"15:30": {"close": …, "volume": …}, "15:31": {…}, "16:30": …, "16:31": …}   # 있는 라벨만
     }}}}

- 라벨은 봉 **끝** 시각(KST ``HH:MM`` — 토스 1분봉 그대로, 개장 봉 09:01과 같은 뜻). 창 ``hh:00``의 봉은 라벨 hh:01~hh:05(봉 시작 hh:00~hh:04).
- ``firstAfter[hh:00]``는 E 안에서 라벨이 hh:01 이후이고 거래량이 0보다 큰 첫 봉(창 밖 대체 체결 R2b), 없으면 null.
- 마감 봉은 정규장 마감 단일가 봉 — 라벨이 NXT 종목은 마감 + 1분(15:31), 그 밖(NXT 미지원 표시 주식·ETF)은 마감 시각(15:30)입니다(G2, 명세
  §8). 장 시간 변경일(16:30 마감)을 위해 16:30·16:31도 싣습니다. 고르는 것은 백엔드입니다(그날 마감·NXT 여부를 앎).
- E 봉이 하나도 없으면 ``NO_BARS``(거래 정지·휴장), 호출이 실패하면 ``FAILED``(다음 slow 주기에 그 종목만 다시). ``OK``·``NO_BARS``는 다시 받지 않습니다.
- 세션은 최근 ``KR_TIMED_KEEP_SESSIONS``개만 남깁니다(늦게 푸는 장부·실행 감사가 볼 기간).

범위는 백엔드 표 ``paper_orders``를 읽기만 합니다(store.kr_timed_orders — ADR 0008). 토스 차트 그룹(초당 20회)의 간격은 한국 관측치 태스크와 같습니다.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, time as clock_time, timedelta, timezone

from .. import catalog, krcalendar, store
from ..services import toss as toss_service

from .base import KST, EmptyResult, previous_payload

logger = logging.getLogger(__name__)

KR_TIMED_CONTRACT = 1
KR_TIMED_SOURCE = "토스증권 1분봉(원시가)"
# E가 끝났다고 보는 시각(KST) — 정규장 마감(15:30) + 10분. 장 시간 변경일(16:30 마감)에는 이 시각에 받은 봉이 마감 봉을 덮지 못할 수 있어
# 마감 + 10분(16:40) 전에 받은 저장본은 백엔드가 '아직 받지 않음'으로 봅니다(종가만).
KR_TIMED_AFTER = clock_time(15, 40)
# 매시 창의 기준 시각(KST) — 백엔드 PaperBooks.AT_1000~AT_1500과 같은 시각.
KR_TIMED_HOURS = (10, 11, 12, 13, 14, 15)
# 창 하나의 봉 수 — 라벨 hh:01~hh:05(T 봉 + 다음 4분, 미국 R1·R2와 같은 폭).
KR_TIMED_WINDOW = 5
KR_TIMED_CLOSE_LABELS = ("15:30", "15:31", "16:30", "16:31")
# 1분봉을 거슬러 받는 시작점과 쪽 수 — 16:36부터 200개씩, E 10:00 전에 닿으면 멈춤(분마다 봉이 있는 NXT 종목은 두 쪽, 세 쪽까지).
KR_TIMED_BEFORE = "16:36"
KR_TIMED_PAGE = 200
KR_TIMED_PAGES = 3
KR_TIMED_KEEP_SESSIONS = 8
# 실행당 토스 호출 상한 — 대기 주문 종목 × 최대 3쪽. 계좌2 주문은 하루 12건 안이라 넉넉합니다(DATA_SOURCES.md '한국 책 호출 예산').
KR_TIMED_CALL_BUDGET = 60
KR_TIMED_SPACING = 0.1
# 백엔드 PaperBooks와 같은 글자(test_kr_paper_timed가 파일로 대조).
KR_TIMED_BOOKS = ("kr_claude2",)
KR_TIMED_TIMINGS = ("AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400", "AT_1500", "NEXT_CLOSE")


def _now() -> datetime:
    return datetime.now(tz=KST)


def next_trading_day(day: date) -> date:
    """그날 다음 KR 거래일(krcalendar — 저장된 공휴일, 모르는 해는 주말만 건너뜀)."""
    candidate = day + timedelta(days=1)
    while not krcalendar.is_trading_day(candidate):
        candidate += timedelta(days=1)
    return candidate


def _label(hour: int, minute: int) -> str:
    return f"{hour:02d}:{minute:02d}"


def _summarize(candles: list[dict], session: str) -> dict:
    """E의 봉(라벨 → 봉)에서 창·창 뒤 첫 거래 봉·마감 봉을 뽑습니다(모듈 설명의 모양)."""
    bars = {c["time"]: c for c in candles if c.get("date") == session and c.get("time")}
    windows: dict[str, list[dict]] = {}
    first_after: dict[str, dict | None] = {}
    ordered = sorted(bars)
    for hour in KR_TIMED_HOURS:
        key = _label(hour, 0)
        window = []
        for minute in range(1, KR_TIMED_WINDOW + 1):
            bar = bars.get(_label(hour, minute))
            if bar is not None:
                window.append({"label": bar["time"], "open": bar["open"], "volume": bar["volume"]})
        windows[key] = window
        start = _label(hour, 1)
        after = next((bars[label] for label in ordered if label >= start and (bars[label].get("volume") or 0) > 0), None)
        first_after[key] = None if after is None else {"label": after["time"], "open": after["open"], "volume": after["volume"]}
    closes = {label: {"close": bars[label]["close"], "volume": bars[label]["volume"]}
              for label in KR_TIMED_CLOSE_LABELS if label in bars}
    return {"windows": windows, "firstAfter": first_after, "closes": closes}


def _fetch(code: str, session: str, budget: list[int]) -> tuple[list[dict], bool]:
    """E의 1분봉 — 16:36부터 거슬러 최대 KR_TIMED_PAGES쪽. (봉, 예산 안에서 끝까지 받았나)."""
    candles: list[dict] = []
    before = f"{session}T{KR_TIMED_BEFORE}:00+09:00"
    for _ in range(KR_TIMED_PAGES):
        if budget[0] <= 0:
            return candles, False
        budget[0] -= 1
        page, next_before = toss_service.fetch_candles(code, "1m", KR_TIMED_PAGE, adjusted=False, before=before)
        if KR_TIMED_SPACING:
            time.sleep(KR_TIMED_SPACING)
        candles.extend(page)
        same_day = [c for c in page if c.get("date") == session]
        if not page or not next_before or len(same_day) < len(page) or any(c["time"] <= "10:00" for c in same_day):
            break
        before = next_before
    return candles, True


def task_kr_paper_timed() -> str:
    """한국 Claude 계좌2 시각 지정 대기 주문 종목의 목표 세션 1분봉(모듈 설명) → 스냅샷 paper.kr.timed."""
    now = _now()
    previous = previous_payload(catalog.SNAP_KR_PAPER_TIMED).get("sessions") or {}
    sessions: dict[str, dict] = {key: dict(value) for key, value in previous.items() if isinstance(value, dict)}
    due: list[tuple[str, str]] = []
    for code, as_of in store.kr_timed_orders(KR_TIMED_BOOKS, KR_TIMED_TIMINGS):
        session = next_trading_day(as_of).isoformat()
        closed_at = datetime.combine(date.fromisoformat(session), KR_TIMED_AFTER, tzinfo=KST)
        if now < closed_at:
            continue
        entry = sessions.get(session, {}).get(code)
        if isinstance(entry, dict) and entry.get("status") in ("OK", "NO_BARS"):
            continue
        if (code, session) not in due:
            due.append((code, session))
    if not due:
        raise EmptyResult("받을 시각 지정 주문 1분봉 없음 — 기존 저장본 유지")

    fetched_at = now.astimezone(timezone.utc).isoformat()
    budget = [KR_TIMED_CALL_BUDGET]
    done = failed = 0
    stop = ""
    for code, session in due:
        if budget[0] <= 0:
            stop = "호출 예산 소진 — 나머지는 다음 주기"
            break
        try:
            candles, complete = _fetch(code, session, budget)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"{exc} — 시각 지정 1분봉을 받지 않습니다 · 기존 저장본 유지") from None
        except toss_service.TossForbidden as exc:
            stop = f"토스 거부로 멈춤({exc})"
            break
        except toss_service.TossError as exc:
            sessions.setdefault(session, {})[code] = {"status": "FAILED", "reason": str(exc), "fetchedAt": fetched_at}
            failed += 1
            continue
        if not complete:
            sessions.setdefault(session, {})[code] = {"status": "FAILED", "reason": "호출 예산 소진 — 다음 주기에 다시",
                                                      "fetchedAt": fetched_at}
            failed += 1
            stop = "호출 예산 소진 — 나머지는 다음 주기"
            break
        summary = _summarize(candles, session)
        has_bars = any(c.get("date") == session for c in candles)
        sessions.setdefault(session, {})[code] = {"status": "OK" if has_bars else "NO_BARS", "reason": None,
                                                  "fetchedAt": fetched_at, **summary}
        done += 1
    if done == 0 and failed == 0:
        raise EmptyResult(stop or "받은 것 없음 — 기존 저장본 유지")
    kept = dict(sorted(sessions.items())[-KR_TIMED_KEEP_SESSIONS:])
    store.put_snapshot(catalog.SNAP_KR_PAPER_TIMED, {"contract": KR_TIMED_CONTRACT, "source": KR_TIMED_SOURCE, "sessions": kept})
    return f"{done}/{len(due)} 종목·세션" + (f", 실패 {failed}" if failed else "") + (f" — {stop}" if stop else "")
