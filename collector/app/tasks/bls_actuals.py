"""
app/tasks/bls_actuals.py
flex 그룹 — 미국 경제지표의 BLS 공식 발표치를 발표 직후에(ADR 0040 '단계 2 앞당김 — BLS 공식 실제치'). **저장만** 합니다 — 결정 패킷·
화면은 이 저장본을 읽지 않습니다(패킷의 실제치는 지금처럼 Nasdaq 컨센서스 층). Nasdaq 실제치와 대조한 결과를 함께 남깁니다.

[언제 받나 — fetch_schedule ``us_bls_actuals/next``(flex 틱이 봄)]
  - 동부 평일마다 두 시각: 08:30 + 2~4분(CPI·고용·PPI — BLS의 08:30 발표), 10:00 + 2~4분(JOLTS). 몇 분은 실행마다 무작위로 정합니다.
    증시 휴장일에도 묻습니다 — BLS는 증시가 쉬는 날(성금요일 등)에도 발표합니다. 주말은 묻지 않습니다.
  - 그 시각의 발표가 오늘 나올 예정인데(FRED 일정 calendar.us_events의 CPI·고용, Nasdaq calendar.us_consensus의 같은 이름 줄) 아직 새 달이
    보이지 않거나, 그 발표의 시리즈가 '잠김'(발표 직전·도중)이면 15~25분 뒤 한 번 더 — 그 시각마다 한 번.
  - 처음(일정 없음)에는 받지 않고 2~25분 뒤로 정합니다(기준을 채우는 첫 요청).
  - 요청이 실패해도(연결·형식·전부 잠김) 그 발표 시각이면 15~25분 뒤 한 번 더 — 시도는 저장본 lastAttempt에 남겨 그 시각마다 한 번만.
  - 요청 한 번에 시리즈 11개를 함께(2년 전 1월~올해 — 1월에도 전년 대비의 기준 달이 들게). 하루 최대 4회 — 키 없는 v1 한도(하루 25)·v2 한도(500) 안.
  - 거부(403·429·한도 초과)면 한 시간 뒤 이후의 다음 발표 시각으로(Retry-After가 더 길면 그 뒤 — 하루까지).

[저장] 스냅샷 ``calendar.us_bls_actuals`` (한 건)
  generatedAt(받은 실행, UTC)·source·api("v2"|"v1")·keyConfigured(키를 넣었나 — 값은 싣지 않음)
  series{키: {seriesId, label, unit, release, seasonallyAdjusted, month, value, preliminary, previousMonth, previousValue,
              derived{momPct|change|yoyPct}(공식 값에서 셈 — BLS가 낸 %와 반올림이 다를 수 있음), firstSeenAt(이 달을 처음 본 시각 — 첫 수집은
              모름이라 null), points[최근 13달], status "ok"|"locked"|"missing", isStale·staleReason(받지 못해 직전 값을 이음)}}
  releases{CPI|EMPLOYMENT|PPI|JOLTS: {month, firstSeenAt}} — 발표마다 계절조정 머리 시리즈의 최신 달
  checks[{etDate, name, nasdaqActualText, nasdaqActual, unit, blsKey, blsMonth, blsValue, agree, note?}] — 오늘(동부) Nasdaq 줄 가운데 이름이 표
  ``CHECKS``와 똑같은 것만. agree는 BLS 쪽 달을 오늘 처음 봤을 때만 참·거짓(아니면 null — 같은 발표인지 모름). Nasdaq은 CPI·근원 CPI·PPI를
  전월 대비·전년 대비 두 줄로 같은 이름에 주므로(이름표 없음), 그날 같은 이름이 둘 이상이면 대조하지 않고 null + note(백엔드
  CalendarConsensus와 같은 규칙)
  lastRun{at, etDate, slot("08:30"|"10:00"|"first"|"other"), retry, locked, missing, waiting, nextDueAt} — 받은 실행
  lastAttempt{at, etDate, slot, ok} — 마지막 시도(실패 포함 — 실패면 저장 시각을 바꾸지 않고 이 칸만 고침). 다시 묻기를 그 시각마다 한 번으로

[실패 규칙 — 수집기 공통]
  요청이 실패하면 EmptyResult — 저장본 그대로. 일부 시리즈가 잠김·없음이면 그 시리즈만 직전 값을 잇고(isStale) 나머지는 새로 씁니다.
"""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .. import catalog, kst, settings, store
from ..services import bls as bls_service
from . import flex
from .base import EmptyResult, previous_payload

TASK_NAME = "us_bls_actuals"
SCHEDULE_ITEM = "next"
NEW_YORK = ZoneInfo("America/New_York")

# 동부 평일의 발표 시각과 그 시각에 나오는 발표.
SLOTS: tuple[tuple[time, tuple[str, ...]], ...] = (
    (time(8, 30), ("CPI", "EMPLOYMENT", "PPI")),
    (time(10, 0), ("JOLTS",)),
)
AFTER_SLOT_MINUTES = (2.0, 4.0)       # 발표 시각 + 이 구간에서 묻기
RETRY_MINUTES = (15.0, 25.0)          # 새 달이 아직 없거나 잠김이면 그 뒤 한 번 더
FIRST_MINUTES = (2.0, 25.0)           # 일정이 없을 때 첫 요청
REJECTED_WAIT = timedelta(hours=1)    # 거부되면 적어도 이만큼 뒤의 다음 발표 시각
SERVER_WAIT_CAP_SECONDS = 24 * 3600.0
SLOT_SPAN = timedelta(minutes=90)     # 발표 시각에서 이만큼 안에 돈 실행을 그 시각의 실행으로 봄(다시 묻기 판단)
POINTS_KEPT = 13

# 발표마다의 머리 시리즈(releases 칸 — 계절조정).
HEADLINE = {"CPI": "cpi", "EMPLOYMENT": "nonfarm_payrolls", "PPI": "ppi_final_demand", "JOLTS": "jolts_openings"}
# FRED 릴리스 번호(calendar.us_events macro.events[].releaseId) → 발표.
FRED_RELEASES = {10: "CPI", 50: "EMPLOYMENT"}
# Nasdaq 줄 이름(calendar.us_consensus) → 발표. 서버 저장본·백엔드 CalendarConsensus에서 본 이름만 — 모르는 이름은 짓지 않습니다.
NASDAQ_RELEASES = {"CPI": "CPI", "Core CPI": "CPI", "Nonfarm Payrolls": "EMPLOYMENT", "Unemployment Rate": "EMPLOYMENT",
                   "PPI": "PPI", "Core PPI": "PPI", "JOLTS Job Openings": "JOLTS"}
# 대조: Nasdaq 이름 → (BLS 키, 값 이름, Nasdaq 단위, 허용 차이). 이름이 똑같은 줄만.
CHECKS: dict[str, tuple[str, str, str, float]] = {
    "CPI": ("cpi", "momPct", "%", 0.05),
    "Core CPI": ("core_cpi", "momPct", "%", 0.05),
    "Nonfarm Payrolls": ("nonfarm_payrolls", "change", "K", 0.5),
    "Unemployment Rate": ("unemployment_rate", "value", "%", 0.05),
    "Average Hourly Earnings": ("avg_hourly_earnings", "momPct", "%", 0.05),
    "PPI": ("ppi_final_demand", "momPct", "%", 0.05),
    "JOLTS Job Openings": ("jolts_openings", "valueMillions", "M", 0.005),
}

# 시험이 난수·시계를 바꿔 끼우는 자리입니다.
_rng = random.Random()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def due() -> bool:
    """flex 틱이 이 태스크를 부를 때인가 — 일정이 없거나 다음 시각이 지났으면 참(표만 읽음)."""
    when = flex.due_map(TASK_NAME).get(SCHEDULE_ITEM)
    return when is None or when <= flex._utcnow()


# ==============================================================================
# 일정
# ==============================================================================
def next_slot(after: datetime) -> datetime:
    """
    ``after`` 뒤에 **시작하는** 다음 발표 시각 + 2~4분(동부 평일, UTC로). 이미 시작한 발표 시각(그 2~4분 창 안 포함)은 건너뜁니다 — 창 안에서
    다시 뽑으면 같은 시각이 또 잡혀 1~2분 뒤 요청이 한 번 더 나가므로.
    """
    local = after.astimezone(NEW_YORK)
    for offset in range(10):
        day = local.date() + timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        for at, _ in SLOTS:
            start = datetime.combine(day, at, tzinfo=NEW_YORK)
            if start <= local:
                continue
            return (start + timedelta(minutes=_rng.uniform(*AFTER_SLOT_MINUTES))).astimezone(timezone.utc)
    raise RuntimeError("열흘 안에 평일이 없음")       # 일어날 수 없음


def slot_of(now: datetime) -> tuple[str, tuple[str, ...]]:
    """지금 실행이 속한 발표 시각("08:30"·"10:00")과 그 발표들. 발표 시각에서 SLOT_SPAN 밖이면 ("other", ())."""
    local = now.astimezone(NEW_YORK)
    if local.weekday() >= 5:
        return "other", ()
    for at, releases in reversed(SLOTS):
        start = datetime.combine(local.date(), at, tzinfo=NEW_YORK)
        if start <= local < start + SLOT_SPAN:
            return at.strftime("%H:%M"), releases
    return "other", ()


def expected_today(et_day: date) -> set[str]:
    """오늘(동부) 나올 예정인 발표 — FRED 일정(CPI·고용)과 Nasdaq 줄 이름."""
    out: set[str] = set()
    events = previous_payload(catalog.SNAP_US_CALENDAR).get("macro")
    for event in (events.get("events") if isinstance(events, dict) else None) or []:
        if isinstance(event, dict) and event.get("date") == et_day.isoformat() and event.get("releaseId") in FRED_RELEASES:
            out.add(FRED_RELEASES[event["releaseId"]])
    for row in _nasdaq_rows(et_day):
        release = NASDAQ_RELEASES.get(row.get("name"))
        if release:
            out.add(release)
    return out


def _nasdaq_rows(et_day: date) -> list[dict]:
    days = previous_payload(catalog.SNAP_US_CONSENSUS).get("days")
    entry = days.get(et_day.isoformat()) if isinstance(days, dict) else None
    rows = entry.get("rows") if isinstance(entry, dict) else None
    return [row for row in rows or [] if isinstance(row, dict)]


# ==============================================================================
# 값
# ==============================================================================
def _previous_month(month: str, back: int = 1) -> str:
    year, mon = int(month[:4]), int(month[5:])
    total = year * 12 + (mon - 1) - back
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def derived(series: bls_service.BlsSeries, points: list[dict]) -> dict:
    """공식 값에서 세는 변화(없으면 빈 dict — 지어내지 않음). points는 최신부터."""
    by_month = {point["month"]: point["value"] for point in points}
    latest = points[0] if points else None
    if latest is None or latest["value"] is None:
        return {}
    value = latest["value"]
    if series.yoy:
        base = by_month.get(_previous_month(latest["month"], 12))
        return {"yoyPct": round((value / base - 1) * 100, 1)} if base else {}
    prior = by_month.get(_previous_month(latest["month"]))
    if prior is None:
        return {}
    if series.unit in ("index", "dollars"):
        return {"momPct": round((value / prior - 1) * 100, 1)} if prior else {}
    if series.unit == "thousands":
        return {"change": round(value - prior, 1)}
    return {}


def _entry(series: bls_service.BlsSeries, points: list[dict], before: dict, stamp: str) -> dict:
    latest, previous = points[0], (points[1] if len(points) > 1 else None)
    if before.get("month") == latest["month"]:
        first_seen = before.get("firstSeenAt")
    else:
        first_seen = stamp if before.get("month") else None      # 처음 받은 저장본은 언제 나왔는지 모름
    return {
        "seriesId": series.series_id, "label": series.label, "unit": series.unit, "release": series.release,
        "seasonallyAdjusted": series.seasonally_adjusted,
        "month": latest["month"], "value": latest["value"], "preliminary": latest["preliminary"],
        "previousMonth": previous["month"] if previous else None, "previousValue": previous["value"] if previous else None,
        "derived": derived(series, points), "firstSeenAt": first_seen,
        "points": points[:POINTS_KEPT], "status": "ok",
    }


def _carried(series: bls_service.BlsSeries, before: dict, status: str, reason: str) -> dict | None:
    if not before:
        return None
    return {**before, "status": status, "isStale": True, "staleReason": reason}


DUPLICATE_NOTE = "같은 이름 줄이 둘 이상 — 전월 대비·전년 대비를 가를 수 없어 대조하지 않음"


def _checks(et_day: date, series: dict[str, dict]) -> list[dict]:
    out = []
    today = et_day.isoformat()
    rows = _nasdaq_rows(et_day)
    counts: dict[str, int] = {}
    for row in rows:
        counts[row.get("name")] = counts.get(row.get("name"), 0) + 1
    for row in rows:
        rule = CHECKS.get(row.get("name"))
        if rule is None:
            continue
        key, field, unit, tolerance = rule
        entry = series.get(key) or {}
        if field == "value":
            bls_value = entry.get("value")
        elif field == "valueMillions":
            bls_value = round(entry["value"] / 1000, 3) if entry.get("value") is not None else None
        else:
            bls_value = (entry.get("derived") or {}).get(field)
        nasdaq_value = row.get("actual") if row.get("unit") == unit else None
        seen_today = _et_date(entry.get("firstSeenAt")) == today
        duplicated = counts[row.get("name")] > 1
        agree = None
        if not duplicated and seen_today and nasdaq_value is not None and bls_value is not None:
            agree = abs(float(nasdaq_value) - float(bls_value)) <= tolerance
        check = {"etDate": today, "name": row.get("name"), "nasdaqActualText": row.get("actualText"),
                 "nasdaqActual": nasdaq_value, "unit": unit, "blsKey": key, "blsMonth": entry.get("month"),
                 "blsValue": bls_value, "agree": agree}
        if duplicated:
            check["note"] = DUPLICATE_NOTE
        out.append(check)
    return out


def _et_date(stamp) -> str | None:
    if not isinstance(stamp, str):
        return None
    try:
        return datetime.fromisoformat(stamp).astimezone(NEW_YORK).date().isoformat()
    except ValueError:
        return None


# ==============================================================================
# 태스크
# ==============================================================================
def _retry_after_failure(previous: dict, attempt: dict, in_slot: bool, retried: bool, now: datetime) -> None:
    """
    받지 못한 실행(거부 밖 — 연결·형식·전부 잠김) — 발표 시각 안의 첫 시도면 15~25분 뒤 한 번 더. 시도는 저장본 lastAttempt에만 남깁니다
    (저장 시각·다른 칸은 그대로 — 저장본이 아직 없으면 남기지 않음, 그때는 처음 실행이라 다시 묻기도 없음).
    """
    if in_slot and not retried:
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, now + timedelta(minutes=_rng.uniform(*RETRY_MINUTES)))
    if previous:
        store.update_snapshot_payload(catalog.SNAP_US_BLS_ACTUALS, {**previous, "lastAttempt": {**attempt, "ok": False}})


def task_us_bls_actuals() -> str:
    """BLS 공식 발표치 → 스냅샷 ``calendar.us_bls_actuals``(모듈 설명)."""
    now = _now()
    when = flex.due_map(TASK_NAME).get(SCHEDULE_ITEM)
    if when is None:
        first = now + timedelta(minutes=_rng.uniform(*FIRST_MINUTES))
        flex.set_due(TASK_NAME, SCHEDULE_ITEM, first)
        raise EmptyResult(f"일정 처음 정함 — 첫 요청 {kst.stamp(first)} · 외부 호출 0회")
    if when > now:
        raise EmptyResult(f"다음 요청 {kst.stamp(when)} — 아직 때가 아님 · 외부 호출 0회")

    # 먼저 다음 시각을 적어 둡니다(이 요청 중에 실행이 끊겨도 다음 틱이 곧바로 다시 묻지 않게).
    flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_slot(now))
    previous = previous_payload(catalog.SNAP_US_BLS_ACTUALS)
    prev_series = previous.get("series") if isinstance(previous.get("series"), dict) else {}
    prev_attempt = previous.get("lastAttempt") if isinstance(previous.get("lastAttempt"), dict) else {}
    et_day = now.astimezone(NEW_YORK).date()
    today = et_day.isoformat()
    slot, slot_releases = slot_of(now) if previous else ("first", ())
    in_slot = slot in ("08:30", "10:00")
    # 그 발표 시각에 이미 한 번 시도했으면(성공·실패 모두) 이번이 다시 묻기 — 더는 묻지 않음(그 시각마다 한 번).
    retried = in_slot and prev_attempt.get("etDate") == today and prev_attempt.get("slot") == slot
    attempt = {"at": now.isoformat(timespec="seconds"), "etDate": today, "slot": slot}
    key = settings.bls_key()
    ids = [series.series_id for series in bls_service.SERIES]
    try:
        # 2년 전 1월부터 — 1월~2월 중순(새해 첫 발표 전)에도 전년 대비의 기준 달(전전년 같은 달)이 들게.
        body = bls_service.fetch(ids, et_day.year - 2, et_day.year, key or None)
        parsed = bls_service.parse(body, ids)
    except bls_service.BlsFetchError as exc:
        if exc.rejected or exc.retry_after:
            wait = timedelta(seconds=min(exc.retry_after or 0.0, SERVER_WAIT_CAP_SECONDS))
            flex.set_due(TASK_NAME, SCHEDULE_ITEM, max(next_slot(now + REJECTED_WAIT), now + wait))
        else:
            _retry_after_failure(previous, attempt, in_slot, retried, now)
        raise EmptyResult(f"BLS 받지 못함 — {exc} · 기존 저장본 유지") from None
    except bls_service.BlsShapeError as exc:
        _retry_after_failure(previous, attempt, in_slot, retried, now)
        raise EmptyResult(f"BLS 응답 모양이 다름 — {exc} · 기존 저장본 유지") from None

    stamp = now.isoformat(timespec="seconds")
    series_out: dict[str, dict] = {}
    for series in bls_service.SERIES:
        before = prev_series.get(series.key) if isinstance(prev_series.get(series.key), dict) else {}
        points = parsed.points.get(series.series_id)
        if points:
            series_out[series.key] = _entry(series, points, before, stamp)
            continue
        status = "locked" if series.series_id in parsed.locked else "missing"
        reason = "발표 직전·도중이라 BLS가 잠금(Database is locked)" if status == "locked" else "응답에 값 없음"
        carried = _carried(series, before, status, reason)
        if carried is not None:
            series_out[series.key] = carried
    if not any(entry.get("status") == "ok" for entry in series_out.values()):
        _retry_after_failure(previous, attempt, in_slot, retried, now)
        raise EmptyResult(f"BLS 시리즈 0/{len(ids)} — 잠김 {len(parsed.locked)} · 없음 {len(parsed.missing)} · 기존 저장본 유지")

    releases = {}
    for release, head in HEADLINE.items():
        entry = series_out.get(head) or {}
        releases[release] = {"month": entry.get("month"), "firstSeenAt": entry.get("firstSeenAt")}

    # 다시 묻기: 그 시각의 발표가 오늘 예정인데 새 달을 오늘 보지 못했거나, 그 발표의 시리즈가 잠김이면(그 시각마다 한 번).
    waiting = []
    if in_slot and not retried:
        expected = expected_today(et_day)
        for release in slot_releases:
            locked = any(bls_service.SERIES_BY_ID[sid].release == release for sid in parsed.locked)
            pending = release in expected and _et_date(releases[release]["firstSeenAt"]) != today
            if locked or pending:
                waiting.append(release)
    next_at = now + timedelta(minutes=_rng.uniform(*RETRY_MINUTES)) if waiting else next_slot(now)
    flex.set_due(TASK_NAME, SCHEDULE_ITEM, next_at)

    checks = _checks(et_day, series_out)
    store.put_snapshot(catalog.SNAP_US_BLS_ACTUALS, {
        "generatedAt": stamp,
        "source": bls_service.SOURCE,
        "api": "v2" if key else "v1",
        "keyConfigured": bool(key),
        "series": series_out,
        "releases": releases,
        "checks": checks,
        "lastRun": {"at": stamp, "etDate": today, "slot": slot, "retry": retried, "locked": parsed.locked,
                    "missing": parsed.missing, "waiting": waiting, "nextDueAt": next_at.isoformat(timespec="seconds")},
        "lastAttempt": {**attempt, "ok": True},
    })

    fresh = [release for release, info in releases.items() if info["firstSeenAt"] == stamp]
    ok_count = sum(1 for entry in series_out.values() if entry.get("status") == "ok")
    detail = f"BLS 시리즈 {ok_count}/{len(ids)} · {'v2' if key else 'v1(키 없음)'}"
    if fresh:
        detail += " · 새 달: " + ", ".join(f"{release} {releases[release]['month']}" for release in fresh)
    if parsed.locked:
        detail += f" · 잠김 {len(parsed.locked)}개(발표 직전·도중)"
    if parsed.missing:
        detail += f" · 값 없음: {', '.join(parsed.missing)}"
    decided = [check for check in checks if check["agree"] is not None]
    if decided:
        detail += f" · Nasdaq 대조 {sum(1 for c in decided if c['agree'])}/{len(decided)} 일치"
    if waiting:
        detail += f" · 다시 묻기({', '.join(waiting)} 아직)"
    return detail + f" · 다음 {kst.stamp(next_at)}"
