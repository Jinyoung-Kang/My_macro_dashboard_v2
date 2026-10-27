"""
app/services/kr_calendar.py
🧪 모의 매매 한국 책 Claude 계좌 패킷 ``1b_calendar``의 한국 거시 일정 상수(v2 2단계 명세 §4-11·K20).

외부 호출이 없습니다. 금통위 일정과 주요 발표일은 받을 API가 없어 공식 페이지에서 손으로 옮긴 상수입니다 — 미국 FOMC 상수
(services/us_calendar.FOMC_MEETINGS)와 같은 방식이고 연 1회 갱신합니다.
  - 상수 끝(``through``)이 수집 창 안에 들어오면 '갱신 필요'입니다(그 뒤 일정이 저장본에서 조용히 빠지지 않게).
  - 날짜를 아직 옮기지 않은 발표는 '일정 미확인'이고 날짜를 지어내지 않습니다(명세 §7 G8 — 출발 전에 옮김, 못 옮기면 그 줄은 미확인).
  - 한국 실적 일정·컨센서스는 출처가 없습니다(명세 K20 — TradingView 403, Nasdaq 한국 0행). 저장본에 null + 사유로 둡니다.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

# ==============================================================================
# 금통위(통화정책방향 결정회의) — 한국은행 공개 연간 일정 (상수)
# ==============================================================================
BOK_MPB_SOURCE = "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755"
# 이 상수를 한국은행 '통화정책방향 결정회의 일정 및 자료' 페이지와 대조한 날.
BOK_MPB_CHECKED_AT = "2026-10-26"
# 2026년 8회(결정 당일 날짜). 04-10만 금요일이고 나머지는 목요일입니다(달력 계산과 일치). 임시 회의는 들어오지 않습니다.
BOK_MPB_MEETINGS: tuple[str, ...] = (
    "2026-01-15",
    "2026-02-26",
    "2026-04-10",
    "2026-05-28",
    "2026-07-16",
    "2026-08-27",
    "2026-10-22",
    "2026-11-26",
)
BOK_MPB_THROUGH = BOK_MPB_MEETINGS[-1]
# 상수 끝 뒤를 적는 말 — 같은 페이지의 2027 표가 비어 있었습니다(명세 §7 G9: 2026-12 중순까지 다시 확인).
BOK_MPB_NOTE = "2027 일정 미게시 — 한국은행 통화정책방향 결정회의 일정의 2027 표가 비어 있음(2026-10-26 확인)"
BOK_MPB_NAME = "금통위 통화정책방향 결정"

# 상태 — 미국 calendar.us_events의 fomc.status와 같은 말.
STATUS_OK = "ok"
STATUS_RENEW = "갱신 필요"
STATUS_UNCONFIRMED = "일정 미확인"


def mpb_events(start: date, end: date) -> list[dict]:
    """결정일이 ``start``~``end``(양끝 포함)인 금통위."""
    return [{"name": BOK_MPB_NAME, "date": day, "kind": "MPB", "source": BOK_MPB_SOURCE}
            for day in BOK_MPB_MEETINGS if start <= date.fromisoformat(day) <= end]


def mpb_status(end: date) -> str:
    """수집 창 끝이 상수 끝을 넘으면 '갱신 필요'."""
    return STATUS_OK if end <= date.fromisoformat(BOK_MPB_THROUGH) else STATUS_RENEW


# ==============================================================================
# 주요 발표 — 연 1회 손으로 옮기는 상수 (명세 §4-11·G8)
# ==============================================================================
@dataclass(frozen=True)
class KrRelease:
    key: str                     # 저장본 macro.releases의 키
    name: str                    # 패킷에 나가는 이름
    agency: str                  # 발표 기관
    source: str                  # 날짜를 옮길(옮긴) 공표일정 — 주소를 확인한 곳만 URL, 아니면 페이지 이름
    dates: tuple[str, ...] = ()  # 옮긴 발표일(YYYY-MM-DD). 비면 '일정 미확인'
    checked_at: str | None = None
    through: str | None = None   # 옮긴 범위의 끝(그 뒤는 '갱신 필요')


# 한국은행 통계공표일정 — [확인] 2026-10-26 HTTP 200, 다만 표가 스크립트로 채워져 HTML만으로는 날짜가 보이지 않음(조사 기록).
BOK_STATS_SCHEDULE = "https://www.bok.or.kr/portal/stats/statsPublictSchdul/listCldr.do?menuNo=200775"

# 날짜는 아직 옮기지 않았습니다(G8 — 출발 전). 옮길 때 dates·checked_at·through를 함께 채웁니다.
KR_RELEASES: tuple[KrRelease, ...] = (
    KrRelease("CPI", "소비자물가동향", "국가데이터처", "국가데이터처 국가통계 공표일정(주소 미확인)"),
    KrRelease("EMPLOYMENT", "고용동향", "국가데이터처", "국가데이터처 국가통계 공표일정(주소 미확인)"),
    KrRelease("GDP", "실질 국내총생산(속보)", "한국은행", BOK_STATS_SCHEDULE),
    KrRelease("CURRENT_ACCOUNT", "국제수지(잠정) — 경상수지", "한국은행", BOK_STATS_SCHEDULE),
    KrRelease("TRADE", "수출입동향", "산업통상부", "산업통상부 수출입동향 발표 일정(주소 미확인)"),
)

UNCONFIRMED_NOTE = "공식 공표일정에서 날짜를 옮기기 전 — 지어내지 않음(명세 §7 G8)"


def release_events(release: KrRelease, start: date, end: date) -> list[dict]:
    """옮긴 발표일 중 ``start``~``end``(양끝 포함)."""
    return [{"name": release.name, "key": release.key, "date": day, "kind": "RELEASE", "agency": release.agency,
             "source": release.source}
            for day in release.dates if start <= date.fromisoformat(day) <= end]


def release_status(release: KrRelease, end: date) -> str:
    """날짜가 없으면 '일정 미확인', 옮긴 범위 끝을 수집 창 끝이 넘으면 '갱신 필요'."""
    if not release.dates:
        return STATUS_UNCONFIRMED
    through = release.through or max(release.dates)
    return STATUS_OK if end <= date.fromisoformat(through) else STATUS_RENEW


# 한국 실적 일정·컨센서스 — 출처 없음(명세 K20). 빈 목록은 '0건'으로 읽히므로 null + 사유로 둡니다.
EARNINGS_NOTE = "한국 실적 발표 일정 출처 없음"
CONSENSUS_NOTE = "한국 컨센서스 출처 없음"
