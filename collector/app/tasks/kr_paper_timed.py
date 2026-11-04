"""
app/tasks/kr_paper_timed.py
한국 Claude 계좌2 시각 지정 체결의 1분봉 — 스냅샷 ``paper.kr.timed``(contract 1, 단계 2a — 명세 docs/specs/2026-11-02-kr-claude2-stage2.md §3).

한국 Claude 계좌2(``kr_claude2``)가 매시(``AT_1000``~``AT_1500``)·종가(``NEXT_CLOSE``)·장중 시장가(``MARKET`` — 장중 확인 응답, 단계 2b)로 낸 대기 주문의
종목마다, 목표 세션 E(기준 거래일 다음 KR 거래일)가 끝난 뒤(E 15:40 KST) 토스 1분봉을 한 번 받아 장부가 쓸 칸만 저장합니다. 시가(``NEXT_OPEN``)
체결은 지금처럼 ``paper.kr.quotes``의 개장 봉입니다. E 칸이 ``NO_BARS``(그날 봉 없음 — 종목 종일 정지, 백엔드 설정에만 있는 늦은 임시휴장)면 만료 창
(기준일 + ``KR_TIMED_EXPIRY_SESSIONS`` 거래일) 안의 다음 거래일도 그날이 끝난 뒤 받습니다 — 장부는 기준일 뒤 **첫 관측 봉**(거래량 > 0)의 날로 체결하므로
그날과 받는 날을 같게(QA-201).

실행 감사(단계 2c — 명세 §11)를 위해 장부 몫 뒤에 **한국 Claude 계좌1·2의 최근 결정 주문**(상태 무관, 최근 ``KR_AUDIT_RECENT_DAYS``일)의 (종목, E)도
같은 모양으로 받습니다. 개장 창(``09:00`` — 시가 반사실)도 늘 싣고, 이미 받은 칸에 필요한 창 키가 없으면 그 칸만 다시 받습니다.

모양(contract 1)::

    {"contract": 1, "source": "토스증권 1분봉(원시가)",
     "sessions": {"2026-11-03": {"005930": {
         "status": "OK" | "NO_BARS" | "FAILED", "reason": str | null, "fetchedAt": ISO(UTC),
         "windows": {"09:00": […], "10:00": [{"label": "10:01", "open": 71200.0, "volume": 1234}, …(라벨 hh:01~hh:05, 있는 봉만)], …"15:00": […]},
         "firstAfter": {"09:00": …, "10:00": {"label": "10:07", "open": …, "volume": …} | null, …},
         "closes": {"15:30": {"close": …, "volume": …}, "15:31": {…}, "16:30": …, "16:31": …}   # 있는 라벨만
     }}}}

- 라벨은 봉 **끝** 시각(KST ``HH:MM`` — 토스 1분봉 그대로, 개장 봉 09:01과 같은 뜻). 창 ``hh:00``의 봉은 라벨 hh:01~hh:05(봉 시작 hh:00~hh:04).
  창 ``09:00``은 개장 창(시가 반사실 — 실행 감사)이고, 장 시간 변경일(10:00 개장)에는 ``10:00`` 창이 그 일을 합니다(고르는 것은 백엔드).
  장중 시장가 주문은 그 기준 분 T((생성 + 60초)를 분으로 내린 뒤 + 1분 — 백엔드 ExecutionAudit.marketTarget과 같은 식)의 창 ``HH:MM``(라벨 T+1~T+5)을 같은 모양으로 더합니다
  (같은 종목·세션에 그 주문이 있을 때만 — 키가 매시와 같으면 같은 창).
- ``firstAfter[hh:00]``는 E 안에서 라벨이 hh:01 이후이고 거래량이 0보다 큰 첫 봉(창 밖 대체 체결 R2b), 없으면 null.
- 마감 봉은 정규장 마감 단일가 봉 — 라벨이 NXT 종목은 마감 + 1분(15:31), 그 밖(NXT 미지원 표시 주식·ETF)은 마감 시각(15:30)입니다(G2, 명세
  §8). 장 시간 변경일(16:30 마감)을 위해 16:30·16:31도 싣습니다. 고르는 것은 백엔드입니다(그날 마감·NXT 여부를 앎).
- E 봉이 하나도 없으면 ``NO_BARS``(거래 정지·휴장), 호출이 실패하면 ``FAILED``(다음 slow 주기에 그 종목만 다시). ``OK``·``NO_BARS``는 다시 받지 않습니다
  — 다만 ``OK`` 칸을 E ``KR_TIMED_RECHECK``(16:40 — 덮는 가장 늦은 마감 16:30 + 10분) 전에 받았으면 그 뒤 한 번 더 받습니다(장 시간 변경일의 마감 봉 —
  수집기는 그날 마감을 모름, QA-174). 다시 받기가 실패하거나 다시 받은 응답에 그날 봉이 없으면 직전 ``OK`` 칸을 ``FAILED``·``NO_BARS``로 덮지 않고
  그대로 둡니다(다음 slow 주기에 다시).
- 세션은 최근 ``KR_TIMED_KEEP_SESSIONS``개만 남깁니다(늦게 푸는 장부·실행 감사가 볼 기간).

범위는 백엔드 표 ``paper_orders``를 읽기만 합니다(store.kr_timed_orders·kr_market_orders·kr_audit_orders — ADR 0008). 토스 차트 그룹(초당 20회)의 간격은 한국 관측치 태스크와 같습니다.
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
# 마감 + 10분(16:40) 전에 받은 저장본은 백엔드가 '아직 받지 않음'으로 봅니다(종가만) — 그래서 아래 KR_TIMED_RECHECK 뒤에 한 번 더 받습니다.
KR_TIMED_AFTER = clock_time(15, 40)
# 이 시각(KST — 덮는 가장 늦은 마감 16:30 + 10분, 백엔드 KrTimedLadder.CLOSE_COVERED_AFTER) 전에 받은 OK 칸은 이 시각 뒤에 한 번 더 받습니다(QA-174).
# 수집기는 백엔드 설정(kr.calendar.openTimeOverrides)을 읽지 않아 그날 마감을 모르므로 보통 날에도 (종목, E)마다 한 번 더 부릅니다. 덮는 마감의
# 목록은 백엔드 PaperSettingKeys.KR_OVERRIDE_CLOSES(15:30·16:30)와 같습니다(마감 봉 라벨 KR_TIMED_CLOSE_LABELS·받는 끝 KR_TIMED_BEFORE도 — KrSettingsParityTest).
KR_TIMED_RECHECK = clock_time(16, 40)
# 매시 창의 기준 시각(KST) — 백엔드 PaperBooks.AT_1000~AT_1500과 같은 시각.
KR_TIMED_HOURS = (10, 11, 12, 13, 14, 15)
# 개장 창(시가 반사실 — 실행 감사, 단계 2c)의 키와 그 첫 라벨. 1분봉은 이 라벨까지 거슬러 받습니다.
KR_TIMED_OPEN = "09:00"
KR_TIMED_FIRST_LABEL = "09:01"
# 창 하나의 봉 수 — 라벨 hh:01~hh:05(T 봉 + 다음 4분, 미국 R1·R2와 같은 폭).
KR_TIMED_WINDOW = 5
KR_TIMED_CLOSE_LABELS = ("15:30", "15:31", "16:30", "16:31")
# 1분봉을 거슬러 받는 시작점과 쪽 수 — 16:36부터 200개씩, E 09:01 봉에 닿으면 멈춤(분마다 봉이 있는 NXT 종목은 세 쪽, 그 밖은 두 쪽).
KR_TIMED_BEFORE = "16:36"
KR_TIMED_PAGE = 200
KR_TIMED_PAGES = 3
KR_TIMED_KEEP_SESSIONS = 8
# 계좌2 주문의 만료 창 — 기준일 + 3거래일(백엔드 RuleBookService.ORDER_EXPIRY_TRADING_DAYS, test_kr_paper_timed가 파일로 대조). 목표 세션 E가 NO_BARS면
# 이 창 안의 다음 거래일까지 차례로 받습니다(장부가 그 봉을 고름 — QA-201).
KR_TIMED_EXPIRY_SESSIONS = 3
# 실행당 토스 호출 상한 — 종목·세션 × 최대 3쪽. 장부 몫(계좌2 대기 주문)을 먼저 받고 실행 감사 몫은 남은 예산으로, 넘치면 다음 slow 주기
# (DATA_SOURCES.md '한국 책 호출 예산').
KR_TIMED_CALL_BUDGET = 60
KR_TIMED_SPACING = 0.1
# 백엔드 PaperBooks와 같은 글자(test_kr_paper_timed가 파일로 대조).
KR_TIMED_BOOKS = ("kr_claude2",)
KR_TIMED_TIMINGS = ("AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400", "AT_1500", "NEXT_CLOSE", "MARKET")
# 실행 감사(단계 2c) 범위 — 한국 Claude 계좌1·2(백엔드 PaperBooks.KR_CLAUDE·KR_CLAUDE2)의 최근 이 일수(달력일, DB 시각)에 만든 결정 주문(백엔드
# PaperKrExecutionAuditJob.WINDOW_DAYS와 같은 폭).
KR_AUDIT_BOOKS = ("kr_claude", "kr_claude2")
KR_AUDIT_RECENT_DAYS = 8
MARKET_TIMING = "MARKET"
# 장중 시장가의 기준 분 — (생성 + 이만큼)을 분으로 내린 뒤 + 1분(백엔드 ExecutionAudit.AFTER_CREATED).
KR_MARKET_DELAY = timedelta(seconds=60)


def _now() -> datetime:
    return datetime.now(tz=KST)


def next_trading_day(day: date) -> date:
    """그날 다음 KR 거래일(krcalendar — 저장된 공휴일, 모르는 해는 주말만 건너뜀)."""
    candidate = day + timedelta(days=1)
    while not krcalendar.is_trading_day(candidate):
        candidate += timedelta(days=1)
    return candidate


def target_sessions(code: str, as_of: date, sessions: dict[str, dict]) -> list[str]:
    """
    그 주문 종목의 목표 세션들(ISO 날짜, 차례로) — 기준일 다음 KR 거래일 E, 그 칸이 ``NO_BARS``면 만료 창(기준일 + ``KR_TIMED_EXPIRY_SESSIONS`` 거래일)
    안의 다음 거래일도. 백엔드 장부(KrFills.choose)는 기준일 뒤 첫 관측 봉의 날을 고르는데, 수집기 달력은 백엔드 설정의 임시휴장을 모르고 종목
    정지도 달력에 없으므로 E에 봉이 없으면 다음 날을 고릅니다(QA-201). 그 칸이 아직 없거나 봉이 있으면 거기서 멈춥니다.
    """
    out: list[str] = []
    session = next_trading_day(as_of)
    for _ in range(KR_TIMED_EXPIRY_SESSIONS):
        out.append(session.isoformat())
        entry = sessions.get(session.isoformat(), {}).get(code)
        if not (isinstance(entry, dict) and entry.get("status") == "NO_BARS"):
            break
        session = next_trading_day(session)
    return out


def _label(hour: int, minute: int) -> str:
    return f"{hour:02d}:{minute:02d}"


def market_target(created_at: datetime) -> str:
    """
    장중 시장가 주문의 기준 분 T(KST ``HH:MM``) — (생성 + 60초)를 분으로 내린 뒤 + 1분이라 늘 생성 + 60초보다 뒤입니다(백엔드
    ExecutionAudit.marketTarget·미국 paper_bars.market_target과 같은 식 — :00초 생성이면 T = 생성 + 2분).
    """
    at = (created_at + KR_MARKET_DELAY).astimezone(KST).replace(second=0, microsecond=0) + timedelta(minutes=1)
    return _label(at.hour, at.minute)


def window_keys(extra: list[str] | tuple[str, ...] | set[str] = ()) -> list[str]:
    """창 키 — 개장 창 09:00, 매시 hh:00 여섯과 더할 기준 분(장중 시장가 등), 중복 없이 시각 순."""
    return sorted({KR_TIMED_OPEN} | {_label(hour, 0) for hour in KR_TIMED_HOURS} | set(extra))


def summarize_windows(bars: dict[str, dict], keys: list[str]) -> tuple[dict[str, list[dict]], dict[str, dict | None]]:
    """
    한 세션의 봉(라벨 → 봉)에서 창 키마다 창(라벨 T+1~T+5 가운데 있는 봉)과 창 뒤 첫 거래 봉(라벨 ≥ T+1·거래량 > 0, 없으면 None)을 뽑습니다.
    감시 저장본(paper_watch_kr)도 같은 함수를 씁니다.
    """
    windows: dict[str, list[dict]] = {}
    first_after: dict[str, dict | None] = {}
    ordered = sorted(bars)
    for key in keys:
        base = datetime.strptime(key, "%H:%M")
        labels = [(base + timedelta(minutes=minute)).strftime("%H:%M") for minute in range(1, KR_TIMED_WINDOW + 1)]
        windows[key] = [{"label": bars[label]["time"], "open": bars[label]["open"], "volume": bars[label]["volume"]}
                        for label in labels if label in bars]
        after = next((bars[label] for label in ordered if label >= labels[0] and (bars[label].get("volume") or 0) > 0), None)
        first_after[key] = None if after is None else {"label": after["time"], "open": after["open"], "volume": after["volume"]}
    return windows, first_after


def _summarize(candles: list[dict], session: str, extra: list[str] | tuple[str, ...] | set[str] = ()) -> dict:
    """E의 봉(라벨 → 봉)에서 창·창 뒤 첫 거래 봉·마감 봉을 뽑습니다(모듈 설명의 모양)."""
    bars = {c["time"]: c for c in candles if c.get("date") == session and c.get("time")}
    windows, first_after = summarize_windows(bars, window_keys(extra))
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
        if not page or not next_before or len(same_day) < len(page) or any(c["time"] <= KR_TIMED_FIRST_LABEL for c in same_day):
            break
        before = next_before
    return candles, True


def _done(entry, keys: list[str], recheck_at: datetime, now: datetime) -> bool:
    """
    그 종목·세션을 다시 받지 않아도 되나 — 그날 봉 없음(NO_BARS)이거나, 받았고(OK) 필요한 창 키가 모두 있고 E ``KR_TIMED_RECHECK``(``recheck_at``)
    뒤에 받았거나 아직 그 시각 전(``now``)임. 받은 시각을 읽지 못하는 OK 칸도 그 시각 뒤 한 번 더 받습니다.
    """
    if not isinstance(entry, dict):
        return False
    if entry.get("status") == "NO_BARS":
        return True
    windows = entry.get("windows")
    if not (entry.get("status") == "OK" and isinstance(windows, dict) and set(keys) <= set(windows)):
        return False
    if now < recheck_at:
        return True
    try:
        fetched = datetime.fromisoformat(entry.get("fetchedAt") or "")
    except (TypeError, ValueError):
        return False
    return fetched.tzinfo is not None and fetched >= recheck_at


def _failed(sessions: dict[str, dict], session: str, code: str, reason: str, fetched_at: str) -> bool:
    """
    받기 실패를 적습니다 — 직전 칸이 OK면 덮지 않고 그대로 둡니다(장부·실행 감사가 쓰던 값 — 수집 실패는 직전 값을 버리지 않음, 다음 slow
    주기에 다시). FAILED를 새로 적었으면 True.
    """
    previous = sessions.get(session, {}).get(code)
    if isinstance(previous, dict) and previous.get("status") == "OK":
        return False
    sessions.setdefault(session, {})[code] = {"status": "FAILED", "reason": reason, "fetchedAt": fetched_at}
    return True


def task_kr_paper_timed() -> str:
    """한국 Claude 계좌2 시각 지정 대기 주문과 실행 감사 주문 종목의 목표 세션 1분봉(모듈 설명) → 스냅샷 paper.kr.timed."""
    now = _now()
    previous = previous_payload(catalog.SNAP_KR_PAPER_TIMED).get("sessions") or {}
    sessions: dict[str, dict] = {key: dict(value) for key, value in previous.items() if isinstance(value, dict)}
    due: list[tuple[str, str]] = []
    targets: dict[tuple[str, str], set[str]] = {}
    for code, as_of, created_at in store.kr_market_orders(KR_TIMED_BOOKS):
        targets.setdefault((code, next_trading_day(as_of).isoformat()), set()).add(market_target(created_at))
    audit = store.kr_audit_orders(KR_AUDIT_BOOKS, KR_AUDIT_RECENT_DAYS)
    for code, as_of, timing, created_at in audit:
        if timing == MARKET_TIMING and created_at is not None:
            targets.setdefault((code, next_trading_day(as_of).isoformat()), set()).add(market_target(created_at))
    # 장부 몫(계좌2 대기 주문 — 그 밤 체결에 필요)을 먼저, 그 뒤 실행 감사 몫 — 예산이 모자라면 뒤쪽이 다음 주기로 밀림.
    wanted = list(store.kr_timed_orders(KR_TIMED_BOOKS, KR_TIMED_TIMINGS)) + [(code, as_of) for code, as_of, _, _ in audit]
    for code, as_of in wanted:
        for session in target_sessions(code, as_of, sessions):
            closed_at = datetime.combine(date.fromisoformat(session), KR_TIMED_AFTER, tzinfo=KST)
            if now < closed_at:
                break
            recheck_at = datetime.combine(date.fromisoformat(session), KR_TIMED_RECHECK, tzinfo=KST)
            if _done(sessions.get(session, {}).get(code), window_keys(targets.get((code, session), ())), recheck_at, now):
                continue
            if (code, session) not in due:
                due.append((code, session))
    if not due:
        raise EmptyResult("받을 시각 지정 주문 1분봉 없음 — 기존 저장본 유지")

    fetched_at = now.astimezone(timezone.utc).isoformat()
    budget = [KR_TIMED_CALL_BUDGET]
    done = failed = kept = 0
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
            failed += 1
            if not _failed(sessions, session, code, str(exc), fetched_at):
                kept += 1
            continue
        if not complete:
            failed += 1
            if not _failed(sessions, session, code, "호출 예산 소진 — 다음 주기에 다시", fetched_at):
                kept += 1
            stop = "호출 예산 소진 — 나머지는 다음 주기"
            break
        summary = _summarize(candles, session, targets.get((code, session), ()))
        has_bars = any(c.get("date") == session for c in candles)
        previous = sessions.get(session, {}).get(code)
        if not has_bars and isinstance(previous, dict) and previous.get("status") == "OK":
            # 봉이 있던 칸을 다시 받았는데 응답에 그날 봉이 없음 — 받기 이상으로 보고 직전 OK 칸을 그대로 둠(다음 slow 주기에 다시).
            failed += 1
            kept += 1
            continue
        sessions.setdefault(session, {})[code] = {"status": "OK" if has_bars else "NO_BARS", "reason": None,
                                                  "fetchedAt": fetched_at, **summary}
        done += 1
    if done == 0 and failed == kept:
        # 바뀐 칸이 없음 — 받은 것도, 새로 적은 실패도 없음(다시 받기 실패는 직전 OK 칸 그대로).
        note = f"다시 받기 실패 {kept} — 직전 OK 칸 유지" if kept else ""
        raise EmptyResult(" · ".join(part for part in (stop, note) if part) or "받은 것 없음 — 기존 저장본 유지")
    trimmed = dict(sorted(sessions.items())[-KR_TIMED_KEEP_SESSIONS:])
    store.put_snapshot(catalog.SNAP_KR_PAPER_TIMED, {"contract": KR_TIMED_CONTRACT, "source": KR_TIMED_SOURCE, "sessions": trimmed})
    return (f"{done}/{len(due)} 종목·세션" + (f", 실패 {failed}" if failed else "")
            + (f"(직전 OK 칸 유지 {kept})" if kept else "") + (f" — {stop}" if stop else ""))
