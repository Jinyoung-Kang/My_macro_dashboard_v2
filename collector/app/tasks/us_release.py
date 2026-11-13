"""
app/tasks/us_release.py
flex 그룹 — 미국 경제지표 실제치를 발표 직후에(ADR 0040 단계 2 — B). Nasdaq 컨센서스 저장본(calendar.us_consensus)의 **오늘(동부) 줄만**
발표 시각 + 2~4분에 다시 받아 바꾸고(다른 날짜·이어받은 값·머리 칸은 그대로), 운영 서버면 TradingView 경제 캘린더(polite)의 다음 시각을
그 발표 뒤로 당깁니다.

하루 1회 태스크(us_calendar_consensus)는 같은 날짜를 그날 다시 묻지 않아, 08:30 발표치가 그날 결정 패킷(개장 45분 전 = 08:45)에 실리지
않았습니다. 패킷 모양은 그대로이고(백엔드 CalendarConsensus가 그 날을 받은 시각 ≤ 결정 순간일 때만 발표치를 실음) 실릴 때만 빨라집니다.

[발표 시각 — 오늘(동부)]
  - 패킷이 읽는 이름(백엔드 analytics.CalendarConsensus — CPI·Nonfarm Payrolls·GDP·Core PCE Price Index·Fed Interest Rate Decision)의 Nasdaq 줄
    시각(timeEt). 이름은 백엔드처럼 대소문자·공백을 빼고 맞추고, **그날 그 이름이 한 줄일 때만** 씁니다 — Nasdaq은 CPI·Core PCE를 전월비·전년비
    두 줄로 같은 이름에 주고 백엔드는 그런 이름에 값을 붙이지 않으므로(가를 수 없음), 다시 받아도 패킷에 실리지 않아 묻지 않습니다.
  - 오늘 줄을 아직 받지 못했으면(하루 1회 태스크 실패) FRED 일정(calendar.us_events)의 오늘 발표(CPI·고용·GDP·PCE — 08:30, FOMC — 14:00)로 —
    다시 받기가 오늘 줄(예상치 포함)을 채웁니다. 패킷이 읽지 않는 줄의 시각에는 묻지 않습니다 — 발표가 없는 날은 추가 요청 0회.
  - 같은 시각의 여러 지표는 한 번에.
[언제 묻나 — fetch_schedule ``us_consensus_release/next``]
  - 발표 시각 + 2~4분(무작위)에 Nasdaq을 오늘 날짜 하나만(요청 1회). 그 시각의 이름 줄 가운데 실제치가 아직 빈 것이 있으면 + 15~25분에 한 번 더.
  - Nasdaq 추가 요청은 하루(동부) ``NASDAQ_DAILY_CAP``회, TradingView 당기기는 ``TV_DAILY_CAP``회까지. TradingView는 polite 계층의 일정만 당깁니다 —
    하루 예산·닫힘·포기 규칙은 그 태스크가 그대로 지킵니다(운영 서버에서만 — POLITE_FETCH_ENABLED).
  - 그날 남은 발표가 없으면 다음 평일 07:00 ET + 0~20분에 그날 일정을 다시 봅니다(외부 호출 없음).
[저장]
  calendar.us_consensus의 ``days[오늘]``만 바꿉니다(rows·count·withForecast·fetchedAt = 다시 받은 시각, status "ok" — 이어받음 표시는 지움).
  상태는 같은 저장본의 ``releaseRefetch``{etDate, nasdaqRequests, tvPulls, slots{"HH:MM": {names, requests, filled}}, lastRunAt, nextDueAt}.
  하루 1회 태스크와 같은 저장본이라, 쓰기는 그 모듈(tasks/us_consensus.rewrite_snapshot — 이 저장본의 유일한 쓰는 모듈, 표 소유권 시험 B9)이
  같은 잠금(services.us_consensus.SNAPSHOT_LOCK) 안에서 합니다. 이 모듈은 무엇을 바꿀지만 넘깁니다.
[실패 규칙]
  받지 못하면 저장본 그대로(EmptyResult). 날짜 어긋남 확인(실업수당 청구는 목요일)은 오늘 하루라 할 수 없어, 하루 1회 태스크가 같은 규칙으로
  저장해 둔 오늘 줄과 이름 집합이 크게 다르면(겹치는 이름이 절반 미만 — 저장된 줄이 있는데 빈 응답 포함) 저장하지 않습니다. 다시 묻기(그 시각의
  두 번째 요청)가 새 실제치를 하나도 더하지 못하면 오늘 줄을 바꾸지 않습니다 — 그날 받은 시각(fetchedAt)이 늦어져 앞서 받은 실제치가 그 뒤
  다시 만든 패킷에서 가려지지 않게(백엔드의 시점 규칙은 날 단위). 컨센서스 저장본이 아직 없으면(새 DB) 묻지 않습니다 — 하루 상한을 셀 자리가
  없으므로.
"""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .. import catalog, kst
from ..fetch import state as polite_state
from ..services import us_consensus as consensus_service
from . import flex, polite
from . import us_consensus as daily
from .base import EmptyResult, previous_payload

TASK_NAME = "us_consensus_release"
SCHEDULE_ITEM = "next"
TV_TASK = "econ_calendar_tradingview"
NEW_YORK = ZoneInfo("America/New_York")

# 패킷이 읽는 Nasdaq 이름(백엔드 CalendarConsensus.RELEASE_NAMES·FOMC_NAME과 같아야 함 — 시험이 백엔드 파일과 대조).
PACKET_NAMES: tuple[str, ...] = ("CPI", "Nonfarm Payrolls", "GDP", "Core PCE Price Index", "Fed Interest Rate Decision")
# FRED 릴리스 번호(calendar.us_events macro.events[].releaseId) → 발표 시각(동부). FOMC는 kind "FOMC".
FRED_TIMES: dict[int, time] = {10: time(8, 30), 50: time(8, 30), 53: time(8, 30), 54: time(8, 30)}
FOMC_TIME = time(14, 0)

AFTER_MINUTES = (2.0, 4.0)
RETRY_MINUTES = (15.0, 25.0)
PLAN_AT = time(7, 0)
PLAN_JITTER_MINUTES = (0.0, 20.0)
NASDAQ_DAILY_CAP = 8
TV_DAILY_CAP = 6
# 한 시각에 묻는 횟수(첫 요청 + 실제치가 비면 한 번 더).
SLOT_TRIES = 2
# 다시 받은 줄과 저장된 오늘 줄의 이름이 이만큼도 겹치지 않으면 저장하지 않음(모듈 설명 '실패 규칙').
MIN_NAME_OVERLAP = 0.5

_rng = random.Random()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def due() -> bool:
    """flex 틱이 이 태스크를 부를 때인가 — 일정이 없거나 다음 시각이 지났으면 참(표만 읽음)."""
    when = flex.due_map(TASK_NAME).get(SCHEDULE_ITEM)
    return when is None or when <= flex._utcnow()


# ==============================================================================
# 오늘의 발표 시각
# ==============================================================================
def normalize(name) -> str:
    """백엔드 CalendarConsensus.normalize와 같음 — 앞뒤·사이 공백을 하나로, 소문자."""
    return " ".join(str(name or "").split()).lower()


_PACKET = {normalize(name): name for name in PACKET_NAMES}


def release_slots(et_day: date, consensus: dict) -> dict[str, list[str]]:
    """
    오늘(동부) 패킷이 읽는 발표의 시각 → 이름들("HH:MM" 순)(모듈 설명 '발표 시각'). 오늘 줄이 있으면 그날 한 줄뿐인 패킷 이름의 시각만,
    오늘 줄을 아직 받지 못했으면 FRED·FOMC 일정의 시각.
    """
    slots: dict[str, list[str]] = {}
    rows = _today_rows(consensus, et_day)
    counts: dict[str, int] = {}
    for row in rows:
        counts[normalize(row.get("name"))] = counts.get(normalize(row.get("name")), 0) + 1
    for row in rows:
        key = normalize(row.get("name"))
        when = row.get("timeEt")
        if key in _PACKET and counts[key] == 1 and isinstance(when, str) and len(when) == 5:
            slots.setdefault(when, [])
            slots[when].append(_PACKET[key])
    if rows:
        return dict(sorted(slots.items()))
    events = previous_payload(catalog.SNAP_US_CALENDAR).get("macro")
    for event in (events.get("events") if isinstance(events, dict) else None) or []:
        if not isinstance(event, dict) or event.get("date") != et_day.isoformat():
            continue
        if event.get("kind") == "FOMC":
            name, at = "Fed Interest Rate Decision", FOMC_TIME
        elif event.get("releaseId") in FRED_TIMES:
            name, at = _fred_name(event.get("releaseId")), FRED_TIMES[event["releaseId"]]
        else:
            continue
        key = at.strftime("%H:%M")
        slots.setdefault(key, [])
        if name not in slots[key]:
            slots[key].append(name)
    return dict(sorted(slots.items()))


def _fred_name(release_id) -> str:
    return {10: "CPI", 50: "Nonfarm Payrolls", 53: "GDP", 54: "Core PCE Price Index"}[release_id]


def _today_rows(consensus: dict, et_day: date) -> list[dict]:
    days = consensus.get("days") if isinstance(consensus.get("days"), dict) else {}
    entry = days.get(et_day.isoformat())
    rows = entry.get("rows") if isinstance(entry, dict) else None
    return [row for row in rows or [] if isinstance(row, dict)]


def _slot_time(et_day: date, key: str) -> datetime:
    hour, minute = (int(part) for part in key.split(":"))
    return datetime.combine(et_day, time(hour, minute), tzinfo=NEW_YORK).astimezone(timezone.utc)


def _next_plan(after: datetime) -> datetime:
    """다음 평일 07:00 ET + 0~20분(오늘 07:00이 아직이면 오늘)."""
    local = after.astimezone(NEW_YORK)
    for offset in range(10):
        day = local.date() + timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        start = datetime.combine(day, PLAN_AT, tzinfo=NEW_YORK)
        if start > local:
            return (start + timedelta(minutes=_rng.uniform(*PLAN_JITTER_MINUTES))).astimezone(timezone.utc)
    raise RuntimeError("열흘 안에 평일이 없음")


def _missing_actual(rows: list[dict], names: list[str]) -> list[str]:
    """그 시각의 이름 가운데 실제치가 아직 빈 것(이름은 백엔드처럼 정규화해 맞춤)."""
    out = []
    for name in names:
        matched = [row for row in rows if normalize(row.get("name")) == normalize(name)]
        if not matched or any(row.get("actualText") is None for row in matched):
            out.append(name)
    return out


def _state(previous: dict, today: str) -> dict:
    state = previous.get("releaseRefetch") if isinstance(previous.get("releaseRefetch"), dict) else {}
    if state.get("etDate") != today:
        return {"etDate": today, "nasdaqRequests": 0, "tvPulls": 0, "slots": {}}
    return {"etDate": today, "nasdaqRequests": int(state.get("nasdaqRequests") or 0), "tvPulls": int(state.get("tvPulls") or 0),
            "slots": dict(state.get("slots") or {})}


def _next_due(now: datetime, et_day: date, slots: dict[str, list[str]], run_state: dict) -> datetime:
    """아직 끝나지 않은 오늘 시각의 첫 요청(발표 + 2~4분) 가운데 가장 이른 것, 없으면 다음 평일 계획 시각."""
    candidates = []
    for key in slots:
        info = run_state["slots"].get(key) or {}
        if info.get("requests"):
            continue                     # 이미 시작한 시각(다시 묻기는 그 실행이 정함)
        at = _slot_time(et_day, key) + timedelta(minutes=_rng.uniform(*AFTER_MINUTES))
        if at > now:
            candidates.append(at)
    return min(candidates) if candidates else _next_plan(now)


def _pull_tradingview(now: datetime, run_state: dict) -> bool:
    """
    운영 서버면 TradingView 경제 캘린더(polite)의 다음 시각을 지금(Nasdaq 다시 받기 = 발표 + 2~4분) 뒤 1~3분으로 당깁니다 — 발표 약 3~7분 뒤,
    polite 틱(5분 + 지터) 지연은 별도. 하루 상한 안, 이미 그보다 이르면 그대로. 예산·닫힘·포기는 그 태스크가 지킵니다.
    """
    if not polite.enabled() or run_state["tvPulls"] >= TV_DAILY_CAP:
        return False
    target = now + timedelta(minutes=_rng.uniform(1.0, 3.0))
    current = polite_state.due_at(TV_TASK)
    if current is not None and current <= target:
        return False
    polite_state.set_due_at(TV_TASK, target)
    run_state["tvPulls"] += 1
    return True


# ==============================================================================
# 태스크
# ==============================================================================
def task_us_consensus_release() -> str:
    """오늘 발표 시각의 Nasdaq 다시 받기(모듈 설명)."""
    now = _now()
    when = flex.due_map(TASK_NAME).get(SCHEDULE_ITEM)
    if when is None:
        first = _next_due(now, now.astimezone(NEW_YORK).date(), release_slots(now.astimezone(NEW_YORK).date(),
                                                                                previous_payload(catalog.SNAP_US_CONSENSUS)),
                          _state({}, ""))
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, first)
        raise EmptyResult(f"일정 처음 정함 — 다음 {kst.stamp(first)} · 외부 호출 0회")
    if when > now:
        raise EmptyResult(f"다음 {kst.stamp(when)} — 아직 때가 아님 · 외부 호출 0회")

    et_day = now.astimezone(NEW_YORK).date()
    today = et_day.isoformat()
    consensus = previous_payload(catalog.SNAP_US_CONSENSUS)
    if not consensus:
        next_at = _next_plan(now)
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_at)
        raise EmptyResult(f"컨센서스 저장본이 아직 없음(하루 1회 태스크가 먼저 채움) — 묻지 않음 · 다음 {kst.stamp(next_at)} · 외부 호출 0회")
    run_state = _state(consensus, today)
    slots = release_slots(et_day, consensus)
    # 지금 다룰 시각: 발표가 지났고(2분 이상) 아직 시도 횟수가 남은 시각 — 같은 실행에서 함께(요청 1회).
    started = [key for key in slots if now >= _slot_time(et_day, key) + timedelta(minutes=AFTER_MINUTES[0])
               and int((run_state["slots"].get(key) or {}).get("requests") or 0) < SLOT_TRIES
               and not (run_state["slots"].get(key) or {}).get("filled")]
    if not started:
        next_at = _next_due(now, et_day, slots, run_state)
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_at)
        listed = ", ".join(f"{key}({'·'.join(names)})" for key, names in slots.items()) or "없음"
        raise EmptyResult(f"오늘(동부 {today}) 패킷 발표 시각: {listed} · 다음 {kst.stamp(next_at)} · 외부 호출 0회")
    if run_state["nasdaqRequests"] >= NASDAQ_DAILY_CAP:
        next_at = _next_plan(now)
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_at)
        raise EmptyResult(f"오늘 Nasdaq 추가 요청 상한({NASDAQ_DAILY_CAP}회)에 닿음 · 다음 {kst.stamp(next_at)} · 외부 호출 0회")

    # 먼저 다음 시각을 적어 둡니다(이 요청 중에 실행이 끊겨도 다음 틱이 곧바로 다시 묻지 않게).
    flex.set_due(TASK_NAME, SCHEDULE_ITEM, now + timedelta(minutes=_rng.uniform(*RETRY_MINUTES)))
    first_try = [key for key in started if not (run_state["slots"].get(key) or {}).get("requests")]
    pulled = _pull_tradingview(now, run_state) if first_try else False
    run_state["nasdaqRequests"] += 1
    for key in started:
        info = dict(run_state["slots"].get(key) or {})
        info["names"] = slots[key]
        info["requests"] = int(info.get("requests") or 0) + 1
        run_state["slots"][key] = info
    stamp = now.isoformat(timespec="seconds")
    try:
        rows = consensus_service.fetch_day(et_day)
        fetch_error = None
    except (consensus_service.ConsensusFetchError, consensus_service.ConsensusShapeError) as exc:
        rows, fetch_error = None, str(exc)

    outcome: dict = {}

    def change(latest: dict) -> tuple[dict | None, bool]:
        """잠금 안에서 최신 저장본을 받아 (새 저장본 | None, 오늘 줄을 바꿨나)(하루 1회 태스크가 그 사이 썼을 수 있어 다시 읽은 것)."""
        saved = False
        reason = fetch_error
        fresh = rows
        if fresh is not None:
            stored = _today_rows(latest, et_day)
            retry_only = all(int(run_state["slots"][key]["requests"]) > 1 for key in started)
            if stored and not _similar(stored, fresh):
                reason = "받은 줄의 이름이 저장된 오늘 줄과 크게 다름(빈 응답 포함) — 날짜 어긋남 의심, 저장하지 않음"
            elif retry_only and not _adds_actual(stored, fresh):
                reason = "다시 물었지만 새 실제치 없음 — 오늘 줄과 받은 시각을 그대로 둠"
                fresh = stored
            elif latest:
                days = dict(latest.get("days") or {})
                days[today] = {
                    "date": today,
                    "queryDate": consensus_service.query_date(et_day).isoformat(),
                    "status": "ok",
                    "fetchedAt": stamp,
                    "rows": fresh,
                    "count": len(fresh),
                    "withForecast": sum(1 for row in fresh if row["forecastText"] is not None),
                    "refetchedAfterRelease": True,
                }
                latest = {**latest, "days": days}
                saved = True
            else:
                reason = "컨센서스 저장본이 아직 없음(하루 1회 태스크가 먼저 채움)"
        waiting = []
        for key in started:
            info = run_state["slots"][key]
            missing = _missing_actual(fresh, slots[key]) if saved else list(slots[key])
            info["filled"] = not missing
            if missing and info["requests"] < SLOT_TRIES and run_state["nasdaqRequests"] < NASDAQ_DAILY_CAP:
                waiting.append(key)
        next_at = (now + timedelta(minutes=_rng.uniform(*RETRY_MINUTES))) if waiting else _next_due(now, et_day, slots, run_state)
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_at)
        run_state["lastRunAt"] = stamp
        run_state["nextDueAt"] = next_at.isoformat(timespec="seconds")
        outcome.update(saved=saved, reason=reason, waiting=waiting, next_at=next_at)
        # 저장 시각은 실제로 줄을 바꿨을 때만 새로(상태 칸만 바뀐 실행은 내용만 고침 — us_consensus.rewrite_snapshot).
        return ({**latest, "releaseRefetch": run_state} if latest else None), saved

    # 이 저장본을 쓰는 모듈은 하루 1회 태스크 하나라(표 소유권 시험 B9) 쓰기는 그 모듈의 함수가 잠금 안에서 합니다.
    daily.rewrite_snapshot(change)
    saved, reason, waiting, next_at = outcome["saved"], outcome["reason"], outcome["waiting"], outcome["next_at"]

    label = ", ".join(f"{key}({'·'.join(slots[key])})" for key in started)
    if not saved:
        raise EmptyResult(f"오늘 발표 {label} — {reason} · 기존 저장본 유지 · 다음 {kst.stamp(next_at)}")
    filled = [key for key in started if run_state["slots"][key]["filled"]]
    detail = (f"오늘 발표 {label} 다시 받음 — 실제치 {'있음' if len(filled) == len(started) else '일부 아직'} · "
              f"Nasdaq 추가 {run_state['nasdaqRequests']}/{NASDAQ_DAILY_CAP}")
    if pulled:
        detail += f" · TradingView 일정 당김({run_state['tvPulls']}/{TV_DAILY_CAP})"
    if waiting:
        detail += f" · 다시 묻기({', '.join(waiting)})"
    return detail + f" · 다음 {kst.stamp(next_at)}"


def _similar(stored: list[dict], fresh: list[dict]) -> bool:
    """다시 받은 줄이 저장된 오늘 줄과 같은 날의 것인가 — 이름 집합이 절반 이상 겹침. 저장된 줄이 있는데 빈 응답이면 아님."""
    before = {normalize(row.get("name")) for row in stored if row.get("name")}
    after = {normalize(row.get("name")) for row in fresh if row.get("name")}
    if not before:
        return True
    if not after:
        return False
    return len(before & after) / len(before) >= MIN_NAME_OVERLAP


def _adds_actual(stored: list[dict], fresh: list[dict]) -> bool:
    """받은 줄이 저장된 줄에 없던 실제치를 하나라도 더하나(이름·시각이 같은 줄끼리)."""
    known = {(normalize(row.get("name")), row.get("timeEt")) for row in stored if row.get("actualText") is not None}
    return any(row.get("actualText") is not None and (normalize(row.get("name")), row.get("timeEt")) not in known for row in fresh)
