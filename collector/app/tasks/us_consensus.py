"""
app/tasks/us_consensus.py
slow 그룹(하루 1회) — 🧪 미국 경제 지표 컨센서스(v2 2단계 명세 §4-12·K22·B9). **저장만** — 어떤 패킷·화면도 읽지 않습니다.

미국 동부 오늘부터 16일 안의 평일(패킷 창 '다음 세션부터 10거래일'을 공휴일 두 개까지 덮음)마다 Nasdaq에 한 번 묻습니다(하루 약 12회).
같은 동부 날짜에 이미 받은 날은 다시 묻지 않습니다 — 서버 창(KST 21:55~08:00 = 동부 08:55~19:00 같은 날)에서 하루 한 번입니다.
출처·날짜 어긋남(date=D → D−1)·값 모양은 services/us_consensus.

[저장] 스냅샷 ``calendar.us_consensus`` (한 건)
  generatedAt · forDate(그 실행의 동부 날짜 — 하루 1회의 기준) · source · sourceNote · queryOffsetDays · horizon{from, to}
  importance null + importanceNote · tradingView{status, checkedAt, note}
  days   : {동부 날짜: {date, queryDate, status "ok", fetchedAt, rows: [services.us_consensus.us_row], count, withForecast}}
           — 날짜 순. 이번에 받지 못한 날은 직전 값을 isStale·staleReason·staleSince로 잇고(3일 기한), 직전 값도 없으면 빠집니다.
  failed : 이번 실행에서 받지 못한 날과 사유
[실패 규칙]
  - 날짜 하나의 실패는 나머지를 멈추지 않습니다. 출처 거부(403·429)면 남은 날도 같은 답이라 그 실행을 멈춥니다.
  - 물을 날이 있었는데 하나도 받지 못하면 EmptyResult — 저장본을 덮지 않습니다.
  - 실업수당 청구(Initial Jobless Claims — 목요일 발표, 공휴일 주는 수요일)가 받은 날 둘 이상에 있는데 목요일이 하나도 없으면 Nasdaq의
    날짜 어긋남이 바뀐 것으로 보고 EmptyResult — 날짜가 밀린 값을 저장하지 않습니다(성탄·신년이 모두 목요일인 해의 연말 두 주는 잘못
    걸릴 수 있음 — 그때는 다음 주까지 직전 저장본 유지).
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .. import catalog, http, store
from ..services import us_consensus as consensus_service

from .base import EmptyResult, _parse_time, _reason_suffix, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)

NEW_YORK = ZoneInfo("America/New_York")

# 동부 오늘부터 며칠 안의 평일을 묻는가(양끝 포함). 10거래일 + 공휴일 두 개(성탄·신년 같은 주)를 덮습니다.
HORIZON_DAYS = 16

# 새 요청을 더 시작하지 않는 경과 시간(초). slow 상한 600초 안에서 진행 중인 요청(대기 20초 × 공용 세션 재시도)과 저장의 여유를 남깁니다.
# 정상이면 12회 × (0.5초 간격 + 응답 1초 안팎) ≈ 20초.
TIME_LIMIT_SECONDS = 240.0

# 같은 호스트에 잇달아 보내는 사이 간격(초).
SPACING_SECONDS = 0.5

# 날짜 어긋남 확인에 쓰는 목요일 발표(모듈 설명 '실패 규칙').
ALIGNMENT_ANCHOR = "Initial Jobless Claims"

IMPORTANCE_NOTE = "Nasdaq은 중요도를 주지 않음"


def horizon_days(today: date) -> list[date]:
    """동부 ``today``부터 HORIZON_DAYS일 안의 평일(월~금, 공휴일 포함 — 공휴일은 행이 비어 옴)."""
    days = (today + timedelta(days=offset) for offset in range(HORIZON_DAYS + 1))
    return [day for day in days if day.weekday() < 5]


def task_us_calendar_consensus() -> str:
    """미국 지표 컨센서스(Nasdaq) → 스냅샷 ``calendar.us_consensus``."""
    now = _now()
    stamp = now.isoformat(timespec="seconds")
    today = now.astimezone(NEW_YORK).date()
    days = horizon_days(today)
    previous = previous_payload(catalog.SNAP_US_CONSENSUS)
    prev_days = previous.get("days") if isinstance(previous.get("days"), dict) else {}

    keep = {day.isoformat(): prev_days[day.isoformat()] for day in days if _fetched_today(prev_days.get(day.isoformat()), today)}
    todo = [day for day in days if day.isoformat() not in keep]
    if not todo:
        return f"오늘(미국 동부 {today.isoformat()}) 이미 받음 — 호출 0회 · {len(keep)}일"

    fetched, failed, calls = _fetch(todo, stamp)
    if not fetched:
        raise EmptyResult(f"새로 받은 날 없음(0/{len(todo)}) — 기존 저장본 유지" + _reason_suffix(list(failed.values())))
    misaligned = _misaligned(fetched)
    if misaligned:
        raise EmptyResult(misaligned + " — 기존 저장본 유지")

    merged = {**keep, **fetched}
    carried: list[str] = []
    for key, reason in failed.items():
        carried += carry_over_missing(merged, prev_days, [key], reason, has_data=lambda entry: entry.get("status") == "ok")
    ordered = {day.isoformat(): merged[day.isoformat()] for day in days if day.isoformat() in merged}

    store.put_snapshot(catalog.SNAP_US_CONSENSUS, {
        "generatedAt": stamp,
        "forDate": today.isoformat(),
        "source": consensus_service.SOURCE,
        "sourceNote": consensus_service.SOURCE_NOTE,
        "queryOffsetDays": consensus_service.QUERY_OFFSET_DAYS,
        "horizon": {"from": today.isoformat(), "to": (today + timedelta(days=HORIZON_DAYS)).isoformat()},
        "importance": None,
        "importanceNote": IMPORTANCE_NOTE,
        "tradingView": consensus_service.TRADINGVIEW_NOTE,
        "days": ordered,
        "failed": failed,
    })

    rows = sum(entry["count"] for entry in fetched.values())
    with_forecast = sum(entry["withForecast"] for entry in fetched.values())
    detail = (f"미국 컨센서스 {len(fetched)}/{len(todo)}일 받음(호출 {calls}회) · 미국 행 {rows}개 · 컨센서스 있는 행 {with_forecast}개 · "
              f"창 {today.isoformat()}~{(today + timedelta(days=HORIZON_DAYS)).isoformat()}(동부)")
    if keep:
        detail += f" · 오늘 이미 받은 {len(keep)}일은 그대로"
    detail += carried_suffix(carried)
    if failed:
        detail += f" · 실패 {len(failed)}일" + _reason_suffix(list(failed.values()))
    return detail


def _fetched_today(entry, today: date) -> bool:
    """오늘(동부) 제대로 받은 날 — 이어받은 값(isStale)은 아님."""
    if not isinstance(entry, dict) or entry.get("status") != "ok" or entry.get("isStale"):
        return False
    fetched_at = _parse_time(entry.get("fetchedAt"))
    return fetched_at is not None and fetched_at.astimezone(NEW_YORK).date() == today


def _fetch(todo: list[date], stamp: str) -> tuple[dict[str, dict], dict[str, str], int]:
    """날짜를 오래된 것부터 하나씩. (날짜 → 저장 항목, 날짜 → 실패 사유, 보낸 요청 수)."""
    started = _clock()
    fetched: dict[str, dict] = {}
    failed: dict[str, str] = {}
    calls = 0
    for index, day in enumerate(todo):
        if index:
            _sleep(SPACING_SECONDS)
        if _clock() - started > TIME_LIMIT_SECONDS:
            for rest in todo[index:]:
                failed[rest.isoformat()] = f"시간 상한({TIME_LIMIT_SECONDS:.0f}초) — 다음 실행"
            break
        calls += 1
        try:
            rows = consensus_service.fetch_day(day)
        except (consensus_service.ConsensusFetchError, consensus_service.ConsensusShapeError) as exc:
            failed[day.isoformat()] = str(exc)
            logger.warning("미국 컨센서스 실패 (%s): %s", day.isoformat(), exc)
            if isinstance(exc.__cause__, http.SourceRejected):
                # 거부 래치가 닫혀 남은 날도 같은 답입니다 — 묻지 않고 같은 사유로 둡니다.
                for rest in todo[index + 1:]:
                    failed[rest.isoformat()] = str(exc)
                break
            continue
        fetched[day.isoformat()] = {
            "date": day.isoformat(),
            "queryDate": consensus_service.query_date(day).isoformat(),
            "status": "ok",
            "fetchedAt": stamp,
            "rows": rows,
            "count": len(rows),
            "withForecast": sum(1 for row in rows if row["forecastText"] is not None),
        }
    return fetched, failed, calls


def _misaligned(fetched: dict[str, dict]) -> str | None:
    """받은 날의 실업수당 청구가 목요일에 하나도 없으면 날짜 어긋남이 바뀐 것(모듈 설명). 아니면 None."""
    anchored = [date.fromisoformat(key) for key, entry in fetched.items()
                if any(row.get("name") == ALIGNMENT_ANCHOR for row in entry["rows"])]
    if len(anchored) < 2 or any(day.weekday() == 3 for day in anchored):
        return None
    labels = ", ".join(f"{day.isoformat()}({'월화수목금토일'[day.weekday()]})" for day in anchored)
    return (f"Nasdaq 날짜 어긋남이 바뀐 것 같음 — 실업수당 청구(목요일 발표)가 {labels}에 옴"
            f"(date=D → 동부 D−{consensus_service.QUERY_OFFSET_DAYS} 가정, services/us_consensus 확인)")


# ==============================================================================
# 작은 도구 — 테스트가 바꿔 끼우는 자리
# ==============================================================================
def _now() -> datetime:
    """지금 시각(UTC). 하루 1회·창은 미국 동부 날짜입니다(서버 TZ와 무관)."""
    return datetime.now(timezone.utc)


def _clock() -> float:
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)
