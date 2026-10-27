"""
app/tasks/kr_calendar.py
weekly 그룹 — 🧪 모의 매매 한국 책 Claude 계좌 패킷 ``1b_calendar``의 한국 거시 일정(v2 2단계 명세 §4-11·K20·B9). 외부 호출 없음.

상수(services/kr_calendar)에서 앞으로 45일(KST 오늘부터)의 금통위·주요 발표일을 골라 저장만 합니다. 기준일 다음 세션부터 10거래일 창
(``KrxCalendar``)은 백엔드가 이 저장본을 읽어 자릅니다(ADR 0008). 지금은 저장만이고 패킷 연결은 E1입니다.

[저장] 스냅샷 ``calendar.kr_events`` (한 건) — 미국 ``calendar.us_events``와 같은 모양
  generatedAt
  macro.events      : [{name, date, kind "MPB"|"RELEASE", source, key?, agency?}] — 앞으로 45일, 날짜·종류·이름 순
  macro.horizon     : {from, to} — 위 45일(KST). 패킷 창이 이 밖이면 '수집 범위 밖'(미국과 같음)
  macro.bok         : {source, checkedAt, through, status "ok"|"갱신 필요", note} — 금통위 상수(미국 macro.fomc 자리)
  macro.releases    : {키: {name, agency, source, checkedAt, through, status "ok"|"갱신 필요"|"일정 미확인", note?}} — 주요 발표 상수
  macro.unconfirmed : '일정 미확인'인 발표 키(상수 순서)
  earnings          : null + earningsNote — 한국 실적 일정 출처 없음(빈 목록은 0건으로 읽힘)
  consensus         : null + consensusNote — 한국 컨센서스 출처 없음
[실패 규칙] 받는 것이 없어 실패하지 않습니다. 실행마다 상수로 다시 씁니다(상수를 고친 배포가 다음 실행에 바로 반영).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .. import catalog, store
from ..services import kr_calendar as calendar_service

from .base import KST

# 앞으로 며칠의 일정을 싣는가 — 미국 us_calendar와 같은 45일(패킷 창 10거래일 ≈ 14일보다 넉넉히, weekly 12시간 주기의 묵음 포함).
HORIZON_DAYS = 45


def task_kr_calendar() -> str:
    """금통위 상수 + 주요 발표 상수 → 스냅샷 ``calendar.kr_events``."""
    now = _now()
    today = now.astimezone(KST).date()
    end = today + timedelta(days=HORIZON_DAYS)

    events = calendar_service.mpb_events(today, end)
    releases: dict[str, dict] = {}
    unconfirmed: list[str] = []
    for release in calendar_service.KR_RELEASES:
        events += calendar_service.release_events(release, today, end)
        status = calendar_service.release_status(release, end)
        entry = {"name": release.name, "agency": release.agency, "source": release.source,
                 "checkedAt": release.checked_at, "through": release.through or (max(release.dates) if release.dates else None),
                 "status": status}
        if status == calendar_service.STATUS_UNCONFIRMED:
            entry["note"] = calendar_service.UNCONFIRMED_NOTE
            unconfirmed.append(release.key)
        releases[release.key] = entry
    events.sort(key=lambda event: (event["date"], event["kind"], event["name"]))

    bok_status = calendar_service.mpb_status(end)
    bok = {
        "source": calendar_service.BOK_MPB_SOURCE,
        "checkedAt": calendar_service.BOK_MPB_CHECKED_AT,
        "through": calendar_service.BOK_MPB_THROUGH,
        "status": bok_status,
        "note": calendar_service.BOK_MPB_NOTE,
    }
    store.put_snapshot(catalog.SNAP_KR_CALENDAR, {
        "generatedAt": now.isoformat(timespec="seconds"),
        "macro": {
            "events": events,
            "horizon": {"from": today.isoformat(), "to": end.isoformat()},
            "bok": bok,
            "releases": releases,
            "unconfirmed": unconfirmed,
        },
        "earnings": None,
        "earningsNote": calendar_service.EARNINGS_NOTE,
        "consensus": None,
        "consensusNote": calendar_service.CONSENSUS_NOTE,
    })

    mpb = sum(1 for event in events if event["kind"] == "MPB")
    confirmed = len(calendar_service.KR_RELEASES) - len(unconfirmed)
    detail = (f"금통위 {mpb}회 · 주요 발표 {len(events) - mpb}건(확인 {confirmed}/{len(calendar_service.KR_RELEASES)}종) · "
              f"창 {today.isoformat()}~{end.isoformat()} · 외부 호출 없음")
    renew = [f"금통위(상수 끝 {calendar_service.BOK_MPB_THROUGH} 뒤 미게시)"] if bok_status == calendar_service.STATUS_RENEW else []
    renew += [entry["name"] for entry in releases.values() if entry["status"] == calendar_service.STATUS_RENEW]
    if renew:
        detail += f" · 갱신 필요: {', '.join(renew)}"
    if unconfirmed:
        detail += f" · 일정 미확인: {', '.join(releases[key]['name'] for key in unconfirmed)}"
    return detail


def _now() -> datetime:
    """지금 시각(UTC). 테스트가 시계를 바꿔 끼우는 자리입니다 — 창은 KST 날짜입니다(서버 TZ와 무관)."""
    return datetime.now(timezone.utc)
