"""
app/tasks/kr_paper.py
🧪 모의 알고리즘 매매 한국 책(v2 2단계)의 자료 — 유니버스·수집 범위·관측치(토스 봉)·종목별 수급·종가 이력.

태스크는 "받아서 저장"만 합니다. 후보·점수·체결·평가·기업행위 판정은 백엔드(feature/paper)가 저장본을 읽어 합니다 — 수집기가
장부를 건드리면 테이블마다 쓰는 프로세스가 하나라는 규칙(ADR 0008)이 깨집니다. 백엔드 표(보유·주문·설정)도 읽지 않습니다 —
수집 범위는 수집기 자기 저장본(유니버스 이력)만으로 정합니다(명세 §4-5 '끈적 목록').

[유니버스 U — 명세 §4-5·K3, 정의는 이 파일 한 곳]
  금융위 주식시세의 최신 기준일 B(< 오늘)에서 코스피 시가총액 상위 100 보통주. 제외(추정 규칙 — 고정본 테스트가 잠금):
    우선주   코드 끝자리 ≠ '0' 또는 이름이 '우'·'우B'·'우C'로 끝남
    스팩     이름에 '스팩'
    리츠     이름에 '리츠' — 단 '메리츠'의 '리츠'는 아님([확인] 2026-10-23 코스피 '리츠' 포함 24종목 중 메리츠금융지주만 리츠가 아님).
             이름에 '리츠'가 없는 리츠는 코드 표 KR_UNIVERSE_EXCLUDED_CODES(맵스리얼티 094800 — 사용자 결정 2026-10-28)
    투융자회사 코드 표 KR_UNIVERSE_EXCLUDED_CODES(맥쿼리인프라 088980·KB발해인프라 415640 — 사용자 결정 2026-10-27). 금융위 행에는
             종목 유형 칸이 없고, 토스 securityType(INFRASTRUCTURE_FUND)은 수집 범위(= U에서 나옴)의 종목에만 있어 U를 정하는 데
             쓸 수 없습니다 — 이름('인프라')은 보통 회사(NICE인프라 등)에도 있어 쓰지 않습니다. 새 투융자회사가 상장하면 표에 더하고 판을 올립니다
    거래정지 B의 금융위 거래량이 0이거나 없음(금융위 행에는 정지 표시가 없어 '그날 체결 없음'으로 읽음 — 외부 호출 없이)
    DART     고유번호 표(kr.dart_corp_codes — dart_fundamentals가 받음)에 없음. 표가 없으면 계산하지 않습니다(추측하지 않음)
  ETF·ETN은 주식시세에 없습니다. 같은 시가총액이면 코드 순.
  결과 문구는 저장된 paper.kr.quotes의 토스 securityType이 알려졌고 STOCK이 아닌 U 종목을 '확인 필요'로 보입니다(경고만 — U 계산에는
  쓰지 않음, 코드 표에 더할지 사람이 정함).
[수집 범위]
  ETF 2(069500·153130) → 최신 U(순위 순) → 끈적 목록(보존 400일 안의 유니버스 이력에 한 번이라도 든 다른 종목, 코드 순).
  모든 보유는 U에서 사므로 U를 벗어난 보유도 가격·수급을 계속 받습니다.
[하루 1회 — 명세 K17·§4-9]
  토스 태스크는 KR 거래일 D의 20:30 KST 뒤 하루 한 번입니다(통합 세션 20:00 마감·수급 저녁판 20:21~20:23 뒤). 그 뒤에 받은 종목은
  그날 다시 부르지 않고(호출 0회), 받지 못한 종목만 다음 slow 주기에 다시 받습니다. 일봉은 받았는데 1분봉 개장 봉을 묻지 못한(FAILED)
  종목은 다음 slow 주기에 그 봉만 다시 묻습니다. PAPER_ENABLED와 상관없이 돕니다(미국 paper_quotes와 같음).
  토큰은 services/toss 한 곳에서 발급·캐시하고(401이면 한 번만 재발급), 403(허용 IP)이면 남은 종목도 같은 답이라 그 실행을 멈춥니다.
"""
from __future__ import annotations

import copy
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from datetime import time as clock_time

from .. import catalog, krcalendar, publicapi, store
from ..services import toss as toss_service

from .base import EmptyResult, KST, _parse_time, _reason_suffix, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)


# ==============================================================================
# 유니버스 U
# ==============================================================================
KR_UNIVERSE_SIZE = 100
KR_UNIVERSE_MARKET = "KOSPI"
# 규칙 판 — 행마다 남깁니다. 위 정의(제외 규칙·크기)를 바꾸면 판을 올려, 같은 기준일도 다시 계산하고 결정 행이 어느 판인지 알게 합니다.
# v2(2026-10-27): 투융자회사 제외(KR_UNIVERSE_EXCLUDED_CODES)를 더함 — v1 행이 있는 최신 기준일도 다시 계산합니다.
# v3(2026-10-28): 이름에 '리츠'가 없는 리츠 맵스리얼티(094800)를 코드 표에 더함 — v2 행이 있는 최신 기준일도 다시 계산합니다.
KR_UNIVERSE_RULE = "kospi-mcap-top100-common/v3"
KR_UNIVERSE_RETENTION_DAYS = 400
# 코드로 빼는 종목 — 코드 → (사유, 이름). 이름은 읽는 사람을 위한 것이고 판정은 코드로만 합니다. 사유는 _EXCLUSIONS에 있어야 합니다.
# [확인] 토스 /api/v1/stocks가 088980을 securityType INFRASTRUCTURE_FUND로 줍니다(로컬 paper.kr.quotes, 2026-10-27).
# [확인, 이름 검색] 2026-10-26 금융위 코스피 913종목에서 이 둘 말고 투융자회사로 보이는 종목은 찾지 못했습니다
# (415640은 시총 약 1.2조로 지금 U 밖 — 100위 약 3.9조이지만, 들어오는 날 하루라도 U에 들지 않게 미리 넣음).
# 094800 맵스리얼티는 이름에 '리츠'가 없는 리츠라 이름 규칙에 걸리지 않습니다(사용자 결정 2026-10-28 — 사유 '리츠').
# [확인] 로컬 금융위 저장본 2026-10-20~26 코스피 '맵스리얼티'(시총 약 6,229억 — 지금 U 밖, 들어오는 날 하루라도 U에 들지 않게).
KR_UNIVERSE_EXCLUDED_CODES: dict[str, tuple[str, str]] = {
    "088980": ("투융자회사", "맥쿼리인프라"),
    "415640": ("투융자회사", "KB발해인프라"),
    "094800": ("리츠", "맵스리얼티"),
}
# 한국 책 벤치마크·현금성 ETF(명세 K2) — 유니버스와 상관없이 늘 수집 범위의 맨 앞입니다.
KR_SCOPE_ETFS = ("069500", "153130")

_PREFERRED_NAME = re.compile(r"우[BC]?$")
_REIT_NAME = re.compile(r"(?<!메)리츠")

# 제외 사유(결과 문구의 이름과 순서)
_EXCLUSIONS = ("우선주", "스팩", "리츠", "투융자회사", "거래정지", "DART 없음", "시총 없음")
# 결과 문구의 '확인 필요' — 저장된 paper.kr.quotes의 토스 securityType이 이 값이 아닌 U 종목(모르면 보이지 않음). 보이는 종목 수 상한.
KR_SECURITY_TYPE_STOCK = "STOCK"
KR_SECURITY_TYPE_WARN_LIMIT = 10


def universe_exclusion(row: dict, dart_codes) -> str | None:
    """코스피 행 하나가 U 후보에서 빠지는 사유(위 순서로 첫 사유). 빠지지 않으면 None."""
    code = str(row.get("code") or "")
    name = str(row.get("name") or "").strip()
    if not code.endswith("0") or _PREFERRED_NAME.search(name):
        return "우선주"
    if "스팩" in name:
        return "스팩"
    if _REIT_NAME.search(name):
        return "리츠"
    if code in KR_UNIVERSE_EXCLUDED_CODES:
        return KR_UNIVERSE_EXCLUDED_CODES[code][0]
    if not row.get("volume"):
        return "거래정지"
    if code not in dart_codes:
        return "DART 없음"
    if row.get("marketCap") is None:
        return "시총 없음"
    return None


def select_universe(rows: list[dict], dart_codes) -> tuple[list[dict], dict[str, int]]:
    """
    금융위 하루치 행 → U(순위 순, 최대 KR_UNIVERSE_SIZE)와 사유별 제외 수. 코스피가 아닌 행은 세지 않습니다.

    :returns: ([{code, name, rank, marketCap, listedShares, close, rule}], {사유: 수})
    """
    kept: list[dict] = []
    excluded = {reason: 0 for reason in _EXCLUSIONS}
    for row in rows:
        if row.get("market") != KR_UNIVERSE_MARKET or not row.get("code"):
            continue
        reason = universe_exclusion(row, dart_codes)
        if reason:
            excluded[reason] += 1
        else:
            kept.append(row)
    kept.sort(key=lambda r: (-float(r["marketCap"]), str(r["code"])))
    members = [
        {"code": str(r["code"]), "name": r.get("name"), "rank": rank, "marketCap": r.get("marketCap"),
         "listedShares": r.get("listedShares"), "close": r.get("close"), "rule": KR_UNIVERSE_RULE}
        for rank, r in enumerate(kept[:KR_UNIVERSE_SIZE], start=1)
    ]
    return members, {reason: n for reason, n in excluded.items() if n}


def security_type_warning(members: list[dict]) -> str:
    """
    U 구성원 중 저장된 paper.kr.quotes의 토스 securityType이 알려졌고 STOCK이 아닌 종목 → 결과 문구 꼬리(없으면 "").

    경고만입니다 — U는 금융위 행과 코드 표로만 정합니다(토스 유형은 수집 범위 = U에서 나온 종목에만 있어, U를 정하는 데 쓰면 U가 토스
    성패에 따라 달라짐 — 위 '투융자회사' 설명). 유형을 모르는 종목(저장본 없음·그 종목 항목 없음·null·빈 값)과 STOCK은 보이지 않습니다.
    외부 호출 없음(수집기 자기 저장본만 읽음).
    """
    snap = store.read_snapshot(catalog.SNAP_KR_PAPER_QUOTES)
    payload = snap.payload if snap else None
    entries = payload.get("codes") if isinstance(payload, dict) else None
    if not isinstance(entries, dict):
        return ""
    flagged: list[str] = []
    for member in members:
        code = str(member.get("code") or "")
        entry = entries.get(code)
        kind = entry.get("securityType") if isinstance(entry, dict) else None
        if not isinstance(kind, str) or not kind.strip() or kind.strip() == KR_SECURITY_TYPE_STOCK:
            continue
        name = str(member.get("name") or "").strip()
        flagged.append(f"{code} {name}({kind.strip()})" if name else f"{code}({kind.strip()})")
    if not flagged:
        return ""
    shown = ", ".join(flagged[:KR_SECURITY_TYPE_WARN_LIMIT]) + ("…" if len(flagged) > KR_SECURITY_TYPE_WARN_LIMIT else "")
    return (f" · 확인 필요 — 토스 유형이 STOCK이 아닌 U 종목 {len(flagged)}: {shown}"
            " (U 계산에는 쓰지 않음 — 제외 코드 표에 더할지 확인)")


def task_kr_paper_universe() -> str:
    """
    🧪 한국 책 유니버스 U — 금융위 최신 기준일 B(< 오늘)의 코스피 시가총액 상위 100 보통주 → observations ``kr_paper_universe``.

    외부 호출 0회입니다(금융위 저장본·DART 고유번호 표만 읽음). 백엔드는 이 저장본을 그대로 쓰고 결정 행에 동결합니다 — 정의는
    수집기 한 곳(명세 §4-5).

    규칙
      - 그 기준일의 U가 같은 규칙 판으로 이미 있으면 다시 쓰지 않습니다(최신 상태). 기준일이 바뀌면(밤 첫 slow에 금융위 D−1이 들어옴)
        그날 U를 통째로 씁니다(같은 날짜의 옛 구성원이 남지 않게 — replace).
      - 금융위 저장본이나 DART 고유번호 표가 없으면 EmptyResult — 저장본을 그대로 둡니다(DART 대상 아님을 가리지 못한 U를 만들지 않음).
      - 400일이 지난 행은 지웁니다(끈적 목록의 보존 기간).
    """
    today = datetime.now(KST).date()
    basis = store.latest_observation_date_before(catalog.OBS_FSC_PRICE, today.isoformat())
    if not basis:
        raise EmptyResult("금융위 주식시세 저장본이 없습니다 — fsc_prices가 먼저 돌아야 합니다 · 기존 저장본 유지")

    stored = store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=basis)
    if stored and all(row.get("rule") == KR_UNIVERSE_RULE for row in stored):
        ranked = sorted(stored, key=lambda row: (row.get("rank") or 10**9, str(row.get("code"))))
        return f"최신 상태 (기준일 {basis}, {len(stored)}종목)" + security_type_warning(ranked)

    snap = store.read_snapshot(catalog.SNAP_DART_CORP_CODES)
    dart_codes = ((snap.payload or {}).get("codes") or {}) if snap else {}
    if not dart_codes:
        raise EmptyResult("DART 고유번호 표가 없습니다 — dart_fundamentals(DART_API_KEY)가 먼저 돌아야 우선주·ETF 아닌 상장 보통주를 "
                          "가립니다 · 기존 저장본 유지")

    rows = store.read_observations(catalog.OBS_FSC_PRICE, obs_date=basis)
    members, excluded = select_universe(rows, dart_codes)
    if not members:
        raise EmptyResult(f"기준일 {basis}에 U에 들 코스피 종목이 없습니다 · 기존 저장본 유지")

    store.replace_observations(catalog.OBS_KR_PAPER_UNIVERSE, basis, "", members, entity_key="code")
    cutoff = (today - timedelta(days=KR_UNIVERSE_RETENTION_DAYS)).isoformat()
    store.delete_observations_before(catalog.OBS_KR_PAPER_UNIVERSE, cutoff)
    kospi = sum(1 for row in rows if row.get("market") == KR_UNIVERSE_MARKET)
    short = f" — {KR_UNIVERSE_SIZE}종목에 못 미침" if len(members) < KR_UNIVERSE_SIZE else ""
    excluded_text = "·".join(f"{reason} {n}" for reason, n in excluded.items())
    return (f"기준일 {basis} 코스피 {kospi}종목 → {len(members)}종목{short}"
            + (f" (제외 {excluded_text})" if excluded_text else "") + security_type_warning(members))


# ==============================================================================
# 수집 범위
# ==============================================================================
def kr_scope() -> tuple[list[str], str | None]:
    """
    한국 책 수집 범위 — ETF 2 → 최신 U(순위 순) → 끈적 목록(보존 기간 안 유니버스 이력의 다른 종목, 코드 순). 중복 없음.

    :returns: (코드 목록, 쓴 U의 기준일 — 유니버스 저장본이 없으면 None이고 범위는 ETF 2뿐)
    """
    codes: list[str] = list(KR_SCOPE_ETFS)
    basis = store.latest_observation_date(catalog.OBS_KR_PAPER_UNIVERSE)
    if basis:
        current = sorted(store.read_observations(catalog.OBS_KR_PAPER_UNIVERSE, obs_date=basis),
                         key=lambda row: (row.get("rank") or 10**9, str(row.get("code"))))
        for row in current:
            code = str(row.get("code") or "")
            if code and code not in codes:
                codes.append(code)
        since = (datetime.now(KST).date() - timedelta(days=KR_UNIVERSE_RETENTION_DAYS)).isoformat()
        for code in sorted(store.observation_entities_since(catalog.OBS_KR_PAPER_UNIVERSE, since)):
            if code not in codes:
                codes.append(code)
    return codes, basis


# ==============================================================================
# 관측치 paper.kr.quotes — 토스 일봉(원시·수정)·1분봉 개장 봉 (계약은 명세 §9 'paper.kr.quotes 계약')
# ==============================================================================
# KR 거래일 D의 이 시각(KST) 뒤에 하루 한 번 받습니다(명세 K17). 통합(KRX+NXT) 세션 20:00 마감과 수급 저녁판(20:21~20:23) 뒤입니다.
KR_COLLECT_AFTER = clock_time(20, 30)
# 그날 받았는데 세션 D의 자료(관측치는 D 봉, 수급은 D 기록)가 없던 종목을 다시 묻는 하룻밤 종목당 횟수(첫 시도 포함) — 토스가 늦은 판을
# 준 밤에 다음 slow 주기가 다시 묻되, 휴장일·거래가 끝난 종목을 매시 끝없이 부르지 않게. 다른 종목은 KR_SESSION_ANCHOR에 그날 봉이
# 있을 때만 다시 묻습니다(069500 자신은 늘) — 069500에 D 봉이 없으면 늦게 지정된 휴장일일 수 있습니다(명세 §4-4, 결정 게이트 ⑤).
KR_SESSION_RETRY_LIMIT = 3
KR_SESSION_ANCHOR = "069500"
# 매번 다시 받는 최근 일봉 수 — 토스가 지난 봉을 고치면 다음 날 흡수하고, 기업행위 감지(B7)가 이웃 봉의 수정 비율을 봅니다.
# 호출은 한 봉 더(6개) 묻습니다 — 20:30 전 실행에서 오늘 장중 봉을 버려도 5봉이 남게.
KR_QUOTES_BARS = 5
# 실행당 토스 호출 상한 — 종목 상태(200종목에 1회) + 종목마다 일봉 원시 1·수정 1·1분봉 개장 1. 수집 범위 약 140종목이면 약 420회입니다.
# 일봉을 받은 종목마다 1분봉 1회를 떼어 두므로 한 실행에 (500 − 1) ÷ 3 ≈ 166종목까지 일봉·1분봉을 함께 받고, 넘는 종목은 받지 않은 채로
# 남아 다음 slow 주기에 이어 받습니다. DATA_SOURCES.md '한국 책 호출 예산'과 같아야 합니다(test_toss_call_budget).
KR_QUOTES_CALL_BUDGET = 500
# 새 종목을 더 시작하지 않는 경과 시간(초, 태스크 시작부터). slow 상한 600초 안 — 남는 시간은 진행 중인 종목(호출마다 timeout 10초)의 여유.
KR_QUOTES_TIME_LIMIT_SECONDS = 300.0
# 봉 호출 사이 간격(초). 이 그룹(MARKET_DATA_CHART)은 [확인] 초당 20회(응답 헤더 X-RateLimit-Limit)라 절반 아래로 부릅니다.
KR_CANDLE_SPACING = 0.1
# 1분봉 개장 봉의 라벨(봉 끝 시각, KST) — 정규장 09:00 개장이면 09:01, 개장 시각 변경일(수능일·신년 첫날 10:00)이면 10:01.
# 변경일은 백엔드 설정(kr.calendar.openTimeOverrides)이라 수집기가 모르므로 둘 다 싣고 C2가 고릅니다(명세 §4-4).
KR_OPEN_PROBE_LABELS = ("09:01", "10:01")
# 1분봉 한 번으로 두 라벨을 다 받는 인자: 10:01부터 거슬러 61개(10:01~09:01, 분마다 봉이 있으면 정확히 09:01까지).
KR_OPEN_PROBE_BEFORE = "10:01"
KR_OPEN_PROBE_COUNT = 61
# 수정주가 기준이 바뀌었다고 보는 차이(상대값) — 같은 날짜의 저장값과 새 값이 이만큼 넘게 다르면(분할·병합 등으로 과거 수정가가 다시
# 쓰임) 이력에 덧붙이지 않고 adjBasisChanged를 겁니다. 정수 원으로 반올림한 수정가의 잡음보다 큽니다(백엔드 KrxCorporateActions.RATIO_NOISE와 같음).
KR_ADJ_BASIS_TOLERANCE = 0.005
KR_QUOTES_CONTRACT = 1


def _now() -> datetime:
    """지금 시각(KST). 테스트가 시계를 바꿔 끼우는 자리입니다."""
    return datetime.now(KST)


def _clock() -> float:
    """경과 시간 시계(초). 테스트가 시간 상한을 시험할 때 바꿔 끼웁니다."""
    return time.monotonic()


def kr_target_session(now: datetime) -> date:
    """
    그 시각에 받을 KR 세션 D — 오늘이 거래일이고 20:30 KST가 지났으면 오늘, 아니면 그 앞 거래일(그날 20:30은 이미 지남).
    로컬 맥(24시간)에서도 장중 봉을 받지 않습니다. 달력은 krcalendar(저장된 공휴일 — 모르는 해는 주말만 건너뜀)입니다.
    """
    local = now.astimezone(KST)
    if krcalendar.is_trading_day(local.date()) and local.time() >= KR_COLLECT_AFTER:
        return local.date()
    return krcalendar.previous_trading_day(local.date())


def collected_after(entry, after: datetime) -> bool:
    """그 종목 항목을 ``after`` 이후에 새로 받았는가(이어받은 isStale 항목은 아님) — 그날 다시 부르지 않는 기준."""
    if not isinstance(entry, dict) or entry.get("isStale"):
        return False
    at = _parse_time(entry.get("fetchedAt"))
    return at is not None and at >= after


def _last_bar_date(entry) -> str | None:
    bars = entry.get("bars") if isinstance(entry, dict) else None
    dates = [bar["date"] for bar in bars or [] if isinstance(bar, dict) and bar.get("date")]
    return max(dates) if dates else None


def _has_session_bar(entry, session: str) -> bool:
    """관측치 항목에 세션 D의 봉이 있는가(이어받은 isStale 항목은 아님) — 그날 장이 열렸다고 보는 근거(KR_SESSION_ANCHOR)."""
    return isinstance(entry, dict) and not entry.get("isStale") and _last_bar_date(entry) == session


def _session_attempts(entry, session: str) -> int:
    """그날 받은 항목이 세션 자료 없이 받은 횟수 — 표시(sessionMiss)가 없으면 한 번."""
    miss = entry.get("sessionMiss") if isinstance(entry, dict) else None
    if isinstance(miss, dict) and miss.get("session") == session and isinstance(miss.get("attempts"), int):
        return miss["attempts"]
    return 1


def _retry_session(entry, session: str, has_session: bool, market_open: bool) -> bool:
    """그날 받았는데 세션 자료가 없어 이번 주기에 다시 물을까 — 장이 열렸다고 볼 때만, 종목당 KR_SESSION_RETRY_LIMIT회까지."""
    return not has_session and market_open and _session_attempts(entry, session) < KR_SESSION_RETRY_LIMIT


def _session_miss(entry: dict, session: str, attempt: int) -> dict:
    """세션 자료 없이 받은 항목에 다시 물은 횟수를 남깁니다(sessionMiss) — 다음 주기의 _retry_session이 셉니다."""
    return {**entry, "sessionMiss": {"session": session, "attempts": attempt}}


class _TossRun:
    """한 실행의 토스 호출 예산·간격과 멈춤(403) 기록."""

    def __init__(self, limit: int, spacing: float) -> None:
        self.budget = publicapi.CallBudget(limit)
        self.spacing = spacing
        self.reasons: list[str] = []
        self.forbidden: str | None = None

    def take(self) -> bool:
        """호출 하나를 씁니다(앞 호출과 간격을 둠). 예산이 없거나 403으로 멈췄으면 False — 부르지 말 것."""
        if self.forbidden or not self.budget.take():
            return False
        if self.budget.used > 1 and self.spacing:
            time.sleep(self.spacing)
        return True

    @property
    def remaining(self) -> int:
        return self.budget.limit - self.budget.used


def _has_quote(entry: dict) -> bool:
    return entry.get("status") in ("OK", "NO_BARS")


def _static_info(info: dict | None, previous: dict | None) -> dict:
    """
    종목 상태 칸. 이번 종목 상태 호출에 그 종목이 있으면 그 값, 없으면(호출 실패·응답에 없음) 잘 바뀌지 않는 칸(유형·NXT 여부·상장일)만
    직전 항목에서 잇고 그날의 KRX 정지 여부는 모름(None)으로 둡니다.
    """
    if info:
        return {key: info.get(key) for key in ("name", "securityType", "nxtSupported", "krxTradingSuspended", "listDate")}
    previous = previous or {}
    return {"name": previous.get("name"), "securityType": previous.get("securityType"),
            "nxtSupported": previous.get("nxtSupported"), "krxTradingSuspended": None, "listDate": previous.get("listDate")}


def _daily(code: str, previous: dict | None, info: dict | None, run: _TossRun, fetched_at: str,
           session: str, attempt: int = 1) -> dict | None:
    """
    종목 하나의 일봉 — 원시(adjusted=false) 최근 5봉 + 같은 날 수정(adjusted=true) 종가·수정 비율. 원시 호출이 실패하면 TossError를 그대로
    올립니다(그 종목은 이번에 못 받음 — 직전 값을 이음). 수정 호출만 실패하면 adjClose·adjRatio를 None으로 두고 사유를 남깁니다.
    예산이 원시·수정 두 번에 모자라면 None(시작하지 않음). 봉은 있는데 세션 D 봉이 없으면 ``sessionMiss``(이번이 그 세션의
    ``attempt``번째 시도)를 남깁니다 — 다음 slow 주기가 다시 묻는 근거(_retry_session).

    대상 세션 ``session``보다 늦은 날짜의 봉은 버립니다 — 20:30 전에 돈 실행(로컬 맥의 낮, 손으로 켠 서버)에서 토스는 오늘의 장중 봉을
    주는데, 그 값은 그날 종가가 아닙니다(명세 §0 '장중 관측치 없음').
    """
    if run.remaining < 2 or not run.take():
        return None
    raw, _ = toss_service.fetch_candles(code, "1d", KR_QUOTES_BARS + 1, adjusted=False)
    static = _static_info(info, previous)
    entry = {"code": code, "fetchedAt": fetched_at, **static,
             "adjBasisChanged": bool((previous or {}).get("adjBasisChanged")),
             "adjGap": bool((previous or {}).get("adjGap"))}
    by_date: dict[str, dict] = {}
    for candle in raw:                       # 최신순 — 같은 날짜가 두 번 오면 앞(최신) 것
        if candle["date"] <= session:
            by_date.setdefault(candle["date"], candle)
    days = sorted(by_date)[-KR_QUOTES_BARS:]
    if not days:
        return {**entry, "status": "NO_BARS", "bars": []}

    adjusted: dict[str, float] = {}
    if run.take():
        try:
            adjusted = {c["date"]: c["close"]
                        for c in toss_service.fetch_candles(code, "1d", KR_QUOTES_BARS + 1, adjusted=True)[0]}
        except toss_service.TossForbidden as exc:
            run.forbidden = str(exc)
        except toss_service.TossError as exc:
            run.reasons.append(f"{code} 수정주가: {exc}")
    source = "TOSS_DAILY" if static.get("nxtSupported") is False else "TOSS_INTEGRATED"
    bars = []
    for day in days:
        candle = by_date[day]
        adj_close = adjusted.get(day)
        bars.append({"date": day, "open": candle["open"], "high": candle["high"], "low": candle["low"],
                     "close": candle["close"], "volume": candle["volume"], "priceSource": source,
                     "adjClose": adj_close, "adjRatio": adj_close / candle["close"] if adj_close else None})
    entry = {**entry, "status": "OK", "bars": bars}
    return entry if days[-1] == session else _session_miss(entry, session, attempt)


def _probe_open(code: str, day: str) -> dict:
    """그날 1분봉 개장 봉(KR_OPEN_PROBE_LABELS) — 한 번 호출. 그날 그 라벨 봉이 없으면 NO_BAR(전날 봉이 같은 응답에 섞여 와도 날짜로 거름)."""
    candles, _ = toss_service.fetch_candles(code, "1m", KR_OPEN_PROBE_COUNT, adjusted=False,
                                            before=f"{day}T{KR_OPEN_PROBE_BEFORE}:00+09:00")
    opens = {c["time"]: {"open": c["open"], "volume": c["volume"]}
             for c in candles if c["date"] == day and c["time"] in KR_OPEN_PROBE_LABELS}
    return {"status": "OK" if opens else "NO_BAR", "priceSource": "TOSS_1M_OPEN", "opens": dict(sorted(opens.items()))}


def _probe_targets(entry: dict, previous: dict | None) -> list[dict]:
    """
    1분봉 개장 봉을 물을 봉(최신 날부터). 직전 항목에서 확정된 결과(OK·NO_BAR)는 그대로 옮기고, 묻는 것은
      - 직전 항목의 마지막 봉보다 **새 날짜**의 봉(보통 그날 하나, 서버가 며칠 꺼졌으면 그 며칠) — 처음 보는 종목은 최신 봉 하나만
        (그 전 날은 주문이 없던 때라 쓰일 데가 없음 — 첫 실행에 호출을 다섯 배로 쓰지 않게),
      - 직전에 FAILED였던 봉(최근 5봉 안에 있는 동안)
    입니다. 거래량이 0이거나 모르는 봉(정지일 — 시가 단일가 체결이 없음)은 묻지 않습니다. 물을 봉에는 먼저 FAILED('아직 묻지 못함')를
    걸어 둡니다 — 이번 실행이 예산·시간 상한으로 그 봉까지 못 가도 다음 slow 주기가 그 봉만 다시 묻게(_failed_probe_bars).
    """
    previous_bars = [bar for bar in ((previous or {}).get("bars") or []) if isinstance(bar, dict) and bar.get("date")]
    carried = {bar["date"]: bar.get("minute") for bar in previous_bars}
    previous_latest = max((bar["date"] for bar in previous_bars), default=None)
    targets = []
    for index, bar in enumerate(reversed(entry.get("bars") or [])):
        before = carried.get(bar["date"])
        status = before.get("status") if isinstance(before, dict) else None
        if status in ("OK", "NO_BAR"):
            bar["minute"] = before
            continue
        new = index == 0 if previous_latest is None else bar["date"] > previous_latest
        if bar.get("volume") and (new or status == "FAILED"):
            bar["minute"] = before if status == "FAILED" else {
                "status": "FAILED", "priceSource": "TOSS_1M_OPEN", "reason": "아직 묻지 못함 — 호출 예산·시간 상한"}
            targets.append(bar)
    return targets


def _failed_probe_bars(entry) -> list[dict]:
    """
    그 항목에서 1분봉 개장 봉을 다시 물을 봉(최신 날부터) — ``minute``가 FAILED(호출 실패·'아직 묻지 못함')이고 거래량이 있는 봉.
    그날 일봉을 이미 받은 종목은 일봉을 다시 부르지 않고 이 봉만 다음 slow 주기에 묻습니다 — 예산·시간 상한으로 못 물은 봉이 다음
    날 밤(그 체결을 장부가 이미 처리한 뒤)까지 남지 않게.
    """
    bars = entry.get("bars") if isinstance(entry, dict) and not entry.get("isStale") else None
    return [bar for bar in reversed(bars or []) if isinstance(bar, dict) and bar.get("volume")
            and isinstance(bar.get("minute"), dict) and bar["minute"].get("status") == "FAILED"]


def _append_adj_closes(entry: dict) -> None:
    """
    수정 종가를 timeseries ``kr_close_adj``에 덧붙입니다 — 같은 날짜의 저장값과 KR_ADJ_BASIS_TOLERANCE 넘게 다르면 수정주가 기준이 바뀐
    것이라(분할·병합 뒤 토스가 과거 수정가를 다시 씀) 덧붙이지 않고 ``adjBasisChanged``를 겁니다 — 옛 기준 값과 새 기준 값이 한
    시계열에 섞이지 않게. kr_paper_price_history가 그 종목의 저장 구간 전체를 새 기준으로 다시 받은 뒤 다음 수집에서 풀립니다.

    저장된 마지막 날과 덧붙일 첫 날 사이에 빠진 거래일이 있으면(수집기가 최근 5봉보다 오래 꺼져 있었음) 역시 덧붙이지 않고 ``adjGap``을
    겁니다 — 덧붙이면 저장된 마지막 날이 최신이 되어 이력 태스크의 '빈 구간'(마지막 날이 일주일 넘게 오래됨)이 걸리지 않고, 사이
    날짜가 빈 채로 수익률·변동성이 조용히 계산됩니다. 이력 태스크가 그 사이를 메운 뒤 다음 수집에서 덧붙이고 풀립니다(_history_plan).
    수정 종가를 못 받았으면 아무것도 바꾸지 않습니다(직전 표시 유지).
    """
    points = [(bar["date"], bar["adjClose"]) for bar in entry.get("bars") or [] if bar.get("adjClose")]
    if not points:
        return
    stored = {row["date"]: row["value"] for row in store.read_timeseries(catalog.TS_KR_CLOSE_ADJ, entry["code"],
                                                                          start_date=points[0][0])}
    if any(day in stored and stored[day] and abs(value / stored[day] - 1) > KR_ADJ_BASIS_TOLERANCE
           for day, value in points):
        entry["adjBasisChanged"] = True
        return
    if _adj_gap(store.latest_timeseries_date(catalog.TS_KR_CLOSE_ADJ, entry["code"]), points[0][0]):
        entry["adjGap"] = True
        return
    store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, entry["code"], points)
    entry["adjBasisChanged"] = False
    entry["adjGap"] = False


def _adj_gap(latest: str | None, first: str) -> bool:
    """
    저장된 마지막 날 ``latest``와 덧붙일 첫 날 ``first`` 사이에 빠진 거래일이 있는가 — latest가 first의 직전 거래일(krcalendar)보다
    앞이면 참. 저장본이 없거나 겹치면 거짓(처음 보는 종목은 이력 태스크가 그 앞을 메움). 달력이 모르는 공휴일이 끼면 거짓 양성이 날 수
    있는데, 그때는 이력 태스크가 한 쪽(1회)을 다시 받고 이어집니다.
    """
    if not latest or latest >= first:
        return False
    return latest < krcalendar.previous_trading_day(date.fromisoformat(first)).isoformat()


def task_kr_paper_quotes() -> str:
    """
    🧪 한국 책 관측치 — 수집 범위(kr_scope)의 토스 일봉 최근 5봉(원시·수정)·1분봉 개장 봉 → 스냅샷 ``paper.kr.quotes``
    (+ 수정 종가를 timeseries ``kr_close_adj``에 덧붙임). 모양은 명세 §9 'paper.kr.quotes 계약'(contract 1).

    규칙
      - KR 세션 D(kr_target_session)의 20:30 KST 뒤에 받았고 D 봉이 있는(또는 NO_BARS) 종목은 일봉을 다시 부르지 않습니다 — 모두
        받았으면 호출 0회. 그중 1분봉 개장 봉이 FAILED로 남은 종목은 그 봉만 다시 묻습니다(_failed_probe_bars). 받았는데 D 봉이 없던
        종목(토스의 늦은 판)은 다음 주기에 다시 받습니다 — 069500에 D 봉이 있을 때만(069500 자신은 늘), 종목당 하룻밤
        KR_SESSION_RETRY_LIMIT회까지(늦게 지정된 휴장일에 범위 전체를 매시 부르지 않게).
      - 순서: 종목 상태(200종목에 1회) → 종목마다 일봉 원시·수정 → 1분봉 개장 봉. 일봉을 시작할 때마다 그 종목과 앞서 받은 종목의
        1분봉 몫(종목마다 가장 새 봉 1회)을 예산에서 떼어 두고, 1분봉은 종목마다 가장 새 봉부터 묻습니다(더 지난 봉은 남은 예산으로).
        실행당 KR_QUOTES_CALL_BUDGET·KR_QUOTES_TIME_LIMIT_SECONDS 안에서만, 넘는 종목·봉은 다음 주기에(결과 문구 '1분봉 미요청 N').
      - 받지 못한 종목은 직전 항목을 isStale로 잇습니다(QA-032, 3일 지나면 뺌) — 장부는 isStale 봉으로 체결하지 않습니다. 한 종목도
        새로 받지 못하면 EmptyResult로 저장본을 그대로 둡니다. 토스가 답했는데 봉이 없으면 status NO_BARS('응답에 없음').
      - 403(허용 IP)이면 그 실행을 멈춥니다. 키가 없으면 EmptyResult.
    """
    started = _clock()
    now = _now()
    session = kr_target_session(now)
    after = datetime.combine(session, KR_COLLECT_AFTER, tzinfo=KST)
    scope, basis = kr_scope()
    previous = previous_payload(catalog.SNAP_KR_PAPER_QUOTES).get("codes") or {}
    session_iso = session.isoformat()
    market_open = _has_session_bar(previous.get(KR_SESSION_ANCHOR), session_iso)
    # 받지 못한 종목(missing)과, 받았는데 D 봉이 없던 종목(retry — 토스의 늦은 판, 069500에 D 봉이 있을 때·횟수 안에서만).
    missing: set[str] = set()
    retry: dict[str, int] = {}               # 코드 → 이번이 그 세션의 몇 번째 시도
    for code in scope:
        entry = previous.get(code)
        if not collected_after(entry, after):
            missing.add(code)
        elif _retry_session(entry, session_iso, entry.get("status") == "NO_BARS" or _last_bar_date(entry) == session_iso,
                            market_open or code == KR_SESSION_ANCHOR):
            retry[code] = _session_attempts(entry, session_iso) + 1
    pending = [code for code in scope if code in missing or code in retry]
    # 그날 일봉은 받았는데 1분봉 개장 봉이 FAILED로 남은 종목 — 일봉은 다시 부르지 않고 그 봉만 묻습니다(직전 항목의 복사본을 고침).
    reprobe = {code: copy.deepcopy(previous[code]) for code in scope
               if code not in missing and code not in retry and _failed_probe_bars(previous.get(code))}
    if not pending and not reprobe:
        return f"최신 상태 (세션 {session}, {len(scope)}종목, 호출 0회)"

    run = _TossRun(KR_QUOTES_CALL_BUDGET, KR_CANDLE_SPACING)
    fetched_at = now.astimezone(timezone.utc).isoformat()
    infos: dict[str, dict] = {}
    try:
        for start in range(0, len(pending), toss_service.STOCK_INFO_MAX_SYMBOLS):
            if not run.take():
                break
            infos.update(toss_service.fetch_stock_infos(pending[start:start + toss_service.STOCK_INFO_MAX_SYMBOLS]))
    except toss_service.TossMissingKey as exc:
        raise EmptyResult(f"{exc} — 한국 책 관측치를 받지 않습니다 · 기존 저장본 유지") from None
    except toss_service.TossForbidden as exc:
        raise EmptyResult(f"0/{len(pending)} 종목 — {exc} · 기존 저장본 유지") from None
    except toss_service.TossError as exc:
        run.reasons.append(f"종목 상태: {exc}")   # 일봉은 계속 받습니다 — 상태 칸은 직전 항목에서 잇고 정지 여부는 모름

    # 1분봉을 물을 봉(종목 → 최신 날부터). 일봉을 시작할 때마다 이미 정해진 종목의 몫(종목마다 가장 새 봉 1회 — owed)과 그 종목의
    # 일봉 2회·1분봉 1회가 남아 있어야 합니다 — 일봉만 다 받고 뒤쪽 종목(끈적 목록 = U를 벗어난 보유)의 개장 봉을 매번 못 묻지 않게.
    work: dict[str, list[dict]] = {code: _failed_probe_bars(entry) for code, entry in reprobe.items()}
    owed = len(work)
    fresh: dict[str, dict] = {}
    retry_failed: list[str] = []
    stop = ""
    for code in pending:
        if run.forbidden:
            break
        if _clock() - started >= KR_QUOTES_TIME_LIMIT_SECONDS:
            stop = f"시간 상한 {KR_QUOTES_TIME_LIMIT_SECONDS:.0f}초 — 나머지는 다음 주기"
            break
        if run.remaining < 3 + owed:
            stop = "호출 예산 소진 — 나머지는 다음 주기"
            break
        try:
            entry = _daily(code, previous.get(code), infos.get(code), run, fetched_at, session_iso, retry.get(code, 1))
        except toss_service.TossForbidden as exc:
            run.forbidden = str(exc)
            break
        except toss_service.TossError as exc:
            run.reasons.append(f"{code}: {exc}")
            if code in retry:
                retry_failed.append(code)
            continue
        if entry is None:
            stop = "호출 예산 소진 — 나머지는 다음 주기"
            break
        fresh[code] = entry
        targets = _probe_targets(entry, previous.get(code))
        if targets:
            work[code] = targets
            owed += 1

    # 종목마다 가장 새 봉(보통 그날 하나)을 먼저, 서버가 며칠 꺼졌던 뒤의 더 지난 봉은 그다음에 남은 예산으로 — 범위 순서대로.
    ordered = [code for code in scope if code in work]
    queue = ([(code, bar) for code in ordered for bar in work[code][:1]]
             + [(code, bar) for code in ordered for bar in work[code][1:]])
    probes = 0
    answered: set[str] = set()
    probe_reasons: list[str] = []      # 결과 문구에만 — 이어받은 종목의 사유(carry_over_missing)는 일봉 쪽 사유 그대로
    unasked = 0
    probe_stop = ""
    for index, (code, bar) in enumerate(queue):
        if run.forbidden:
            probe_stop = "토스 거부로 멈춤"
        elif _clock() - started >= KR_QUOTES_TIME_LIMIT_SECONDS:
            probe_stop = f"시간 상한 {KR_QUOTES_TIME_LIMIT_SECONDS:.0f}초"
        elif not run.take():
            probe_stop = "호출 예산 소진"
        if probe_stop:
            unasked = len(queue) - index
            break
        try:
            bar["minute"] = _probe_open(code, bar["date"])
            probes += bar["minute"]["status"] == "OK"
            answered.add(code)
        except toss_service.TossForbidden as exc:
            run.forbidden = str(exc)
            probe_stop = "토스 거부로 멈춤"
            unasked = len(queue) - index
            break
        except toss_service.TossError as exc:
            bar["minute"] = {"status": "FAILED", "priceSource": "TOSS_1M_OPEN", "reason": str(exc)[:200]}
            probe_reasons.append(f"{code} 1분봉: {exc}")

    if run.forbidden:
        run.reasons.insert(0, run.forbidden)
    if not fresh and not answered & set(reprobe):
        what = f"0/{len(pending)} 종목" if pending else f"1분봉만 다시 0/{len(reprobe)}종목"
        stops = " · ".join(part for part in (stop, f"1분봉 미요청 {unasked}({probe_stop})" if unasked else "") if part)
        raise EmptyResult(f"{what} — 기존 저장본 유지" + (f" ({stops})" if stops else "")
                          + _reason_suffix(run.reasons + probe_reasons))

    for entry in fresh.values():
        if entry["status"] == "OK":
            _append_adj_closes(entry)
    # 다시 묻다 실패한 종목은 그날 받은 직전 항목 그대로(이어받기 표시 없이) 두고 시도 수만 셉니다.
    codes = {code: previous[code] for code in scope if code not in missing and code in previous}
    codes.update({code: _session_miss(previous[code], session_iso, retry[code]) for code in retry_failed})
    codes.update(reprobe)
    codes.update(fresh)
    carried = carry_over_missing(codes, previous, scope, (run.reasons[0] if run.reasons else stop) or None, _has_quote)
    store.put_snapshot(catalog.SNAP_KR_PAPER_QUOTES, {
        "contract": KR_QUOTES_CONTRACT,
        "source": "토스증권 Open API — /api/v1/candles 일봉(adjusted=false 원시·true 수정)·1분봉 개장 봉, /api/v1/stocks 종목 상태",
        "session": session.isoformat(),
        "universeDate": basis,
        "scope": scope,
        "codes": {code: codes[code] for code in scope if code in codes},
    })

    no_bars = sum(1 for entry in fresh.values() if entry["status"] == "NO_BARS")
    rebase = sorted(code for code, entry in fresh.items() if entry.get("adjBasisChanged"))
    detail = f"세션 {session}"
    if pending:
        detail += f" · {len(fresh)}/{len(pending)} 종목" + (f"(봉 없음 {no_bars})" if no_bars else "")
    if reprobe:
        detail += f" · 1분봉만 다시 {len(reprobe)}종목"
    detail += f" · 1분봉 개장 {probes}건 · 호출 {run.budget.used}회" + carried_suffix(carried)
    if basis is None:
        detail += " · 유니버스 저장본 없음 — ETF 2만"
    if rebase:
        detail += f" · 수정주가 기준 바뀜 {len(rebase)}({', '.join(rebase[:5])}) — kr_paper_price_history가 다시 받음"
    gaps = sorted(code for code, entry in fresh.items() if entry.get("adjGap"))
    if gaps:
        detail += (f" · 수정 종가 빈 구간 {len(gaps)}({', '.join(gaps[:5])}) — 덧붙이지 않음, "
                   "kr_paper_price_history가 메운 뒤 덧붙임")
    late = [code for code in scope if code in fresh and fresh[code].get("sessionMiss")]
    if late:
        detail += (f" · 세션 봉 없음 {len(late)}({', '.join(late[:5])}{'…' if len(late) > 5 else ''}) — "
                   f"하룻밤 {KR_SESSION_RETRY_LIMIT}회까지 다시")
    if stop:
        detail += f" · {stop}"
    if unasked:
        detail += f" · 1분봉 미요청 {unasked}({probe_stop} — 다음 주기)"
    return detail + _reason_suffix(run.reasons + probe_reasons)


# ==============================================================================
# 종목별 수급 kr_paper_flow — 토스 투자자별 매매동향 (명세 §4-6·K26)
# ==============================================================================
# 종목마다 다시 받는 최근 거래일 수 — 규칙 계좌의 20거래일 누적·연속일에 쓰고, 토스가 지난 기록을 고친 판(저녁 확정·다음 날 새벽 CFD·
# 오전 외국인 보유 — 공식 스펙 1.2.24 '데이터 적시성')을 흡수합니다. 처음 보는 종목은 스펙 상한(100)만큼 한 번에 받습니다(같은 1회).
KR_FLOW_DAYS = 20
KR_FLOW_FIRST_DAYS = 100
# 실행당 토스 호출 상한 — 종목마다 1회. 수집 범위 약 140종목. DATA_SOURCES.md '한국 책 호출 예산'과 같아야 합니다(test_toss_call_budget).
KR_FLOWS_CALL_BUDGET = 200
KR_FLOWS_TIME_LIMIT_SECONDS = 300.0
# 이 그룹(STOCK_TRADING_TREND)의 초당 한도는 공개 표에 없어 레이더 수급(toss.TOSS_STOCK_SPACING)과 같은 간격을 둡니다.
KR_FLOW_SPACING = 0.3
KR_FLOW_RETENTION_DAYS = 400


def task_kr_paper_flows() -> str:
    """
    🧪 한국 책 종목별 수급 — 수집 범위(kr_scope)의 토스 투자자별 매매동향(주, 최근 20거래일·처음이면 100) → observations ``kr_paper_flow``
    (entity = 코드, obs_date = 기록 날짜) + 종목별 수집 상태 스냅샷 ``kr.paper_flows.status``.

    payload는 레이더 수급(toss_stock_flow)과 같은 칸(투자자 4분류·기관 세부 7·외국인 보유율·토스 ``updatedAt``)에 ``code``·``fetchedAt``
    (우리가 받은 시각)을 더한 것입니다. 같은 날짜를 다시 받으면 덮으므로(D 저녁판 → D+1 새벽판), 결정·선정은 그때 읽은 값과 ``updatedAt``을
    결정 행에 동결합니다(명세 K26). 레이더 수급 수집(toss_stock_flows, 매시)과 따로 돕니다.

    규칙
      - KR 세션 D(kr_target_session)의 20:30 KST 뒤에 받았고 D 기록이 있는(또는 NO_RECORDS) 종목은 다시 부르지 않습니다. 받았는데
        D 기록이 없던 종목(토스의 늦은 판)은 다음 주기에 다시 받습니다 — 관측치 저장본의 069500에 D 봉이 있을 때만(늦게 지정된 휴장일이면
        다시 묻지 않음), 종목당 하룻밤 KR_SESSION_RETRY_LIMIT회까지. D보다 늦은 날짜의 기록(20:30 전 실행의 오늘 장중 잠정치)은 쓰지 않습니다.
      - 실행당 KR_FLOWS_CALL_BUDGET·KR_FLOWS_TIME_LIMIT_SECONDS 안에서만, 넘는 종목은 다음 주기에. 403이면 멈춥니다.
      - 받지 못한 종목은 기록을 지우지 않고(저장된 날짜 행이 그대로) 상태 항목만 직전 것을 isStale로 잇습니다. 한 종목도 받지 못하면
        EmptyResult. 토스가 답했는데 기록이 0건이면 상태 NO_RECORDS('응답에 없음').
      - 400일이 지난 행은 지웁니다.
    """
    started = _clock()
    now = _now()
    session = kr_target_session(now)
    session_iso = session.isoformat()
    after = datetime.combine(session, KR_COLLECT_AFTER, tzinfo=KST)
    scope, basis = kr_scope()
    previous = previous_payload(catalog.SNAP_KR_PAPER_FLOWS_STATUS).get("codes") or {}
    # 그날 장이 열렸는지는 같은 slow 주기에 먼저 도는 관측치의 069500 D 봉으로 봅니다(수집기 자기 저장본).
    quotes = previous_payload(catalog.SNAP_KR_PAPER_QUOTES).get("codes") or {}
    market_open = _has_session_bar(quotes.get(KR_SESSION_ANCHOR), session_iso)
    missing: set[str] = set()
    retry: dict[str, int] = {}
    for code in scope:
        entry = previous.get(code)
        if not collected_after(entry, after):
            missing.add(code)
        elif _retry_session(entry, session_iso, entry.get("status") == "NO_RECORDS" or entry.get("latestDate") == session_iso,
                            market_open):
            retry[code] = _session_attempts(entry, session_iso) + 1
    pending = [code for code in scope if code in missing or code in retry]
    if not pending:
        return f"최신 상태 (세션 {session}, {len(scope)}종목, 호출 0회)"

    run = _TossRun(KR_FLOWS_CALL_BUDGET, KR_FLOW_SPACING)
    fetched_at = now.astimezone(timezone.utc).isoformat()
    by_date: dict[str, list[dict]] = {}
    fresh: dict[str, dict] = {}
    retry_failed: list[str] = []
    stop = ""
    for code in pending:
        if _clock() - started >= KR_FLOWS_TIME_LIMIT_SECONDS:
            stop = f"시간 상한 {KR_FLOWS_TIME_LIMIT_SECONDS:.0f}초 — 나머지는 다음 주기"
            break
        if not run.take():
            stop = "호출 예산 소진 — 나머지는 다음 주기"
            break
        seen_before = isinstance(previous.get(code), dict) and previous[code].get("status") == "OK"
        try:
            records = toss_service.fetch_stock_investor_trading(code, KR_FLOW_DAYS if seen_before else KR_FLOW_FIRST_DAYS)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"{exc} — 한국 책 수급을 받지 않습니다 · 기존 저장본 유지") from None
        except toss_service.TossForbidden as exc:
            run.forbidden = str(exc)
            break
        except toss_service.TossError as exc:
            run.reasons.append(f"{code}: {exc}")
            if code in retry:
                retry_failed.append(code)
            continue
        kept = [record for record in records if record.get("date") and record["date"] <= session_iso]
        for record in kept:
            by_date.setdefault(record["date"], []).append({**record, "code": code, "fetchedAt": fetched_at})
        latest = max(kept, key=lambda record: record["date"], default=None)
        entry = {"code": code, "status": "OK" if kept else "NO_RECORDS", "fetchedAt": fetched_at, "records": len(kept),
                 "latestDate": latest["date"] if latest else None,
                 "latestUpdatedAt": latest.get("updatedAt") if latest else None}
        fresh[code] = entry if not latest or latest["date"] == session_iso else _session_miss(entry, session_iso,
                                                                                           retry.get(code, 1))

    if run.forbidden:
        run.reasons.insert(0, run.forbidden)
    if not fresh:
        raise EmptyResult(f"0/{len(pending)} 종목 — 기존 저장본 유지" + (f" ({stop})" if stop else "")
                          + _reason_suffix(run.reasons))

    saved = sum(store.put_observations(catalog.OBS_KR_PAPER_FLOW, obs_date, rows, entity_key="code")
                for obs_date, rows in sorted(by_date.items()))
    cutoff = (now.astimezone(KST).date() - timedelta(days=KR_FLOW_RETENTION_DAYS)).isoformat()
    store.delete_observations_before(catalog.OBS_KR_PAPER_FLOW, cutoff)

    # 다시 묻다 실패한 종목은 그날 받은 직전 항목 그대로(이어받기 표시 없이) 두고 시도 수만 셉니다.
    codes = {code: previous[code] for code in scope if code not in missing and code in previous}
    codes.update({code: _session_miss(previous[code], session_iso, retry[code]) for code in retry_failed})
    codes.update(fresh)
    carried = carry_over_missing(codes, previous, scope, (run.reasons[0] if run.reasons else stop) or None,
                                 lambda entry: entry.get("status") in ("OK", "NO_RECORDS"))
    store.put_snapshot(catalog.SNAP_KR_PAPER_FLOWS_STATUS, {
        "source": "토스증권 Open API — /api/v1/stocks/{symbol}/investor-trading (주, KRX·NXT 통합)",
        "session": session_iso,
        "universeDate": basis,
        "scope": scope,
        "codes": {code: codes[code] for code in scope if code in codes},
    })
    empty = sum(1 for entry in fresh.values() if entry["status"] == "NO_RECORDS")
    detail = (f"세션 {session} · {len(fresh)}/{len(pending)} 종목" + (f"(기록 없음 {empty})" if empty else "")
              + f" · {saved}건 · 호출 {run.budget.used}회" + carried_suffix(carried))
    late = [code for code in scope if code in fresh and fresh[code].get("sessionMiss")]
    if late:
        detail += (f" · 세션 기록 없음 {len(late)}({', '.join(late[:5])}{'…' if len(late) > 5 else ''}) — "
                   + (f"하룻밤 {KR_SESSION_RETRY_LIMIT}회까지 다시" if market_open else "069500 세션 봉이 없어 다시 묻지 않음"))
    if stop:
        detail += f" · {stop}"
    return detail + _reason_suffix(run.reasons)


# ==============================================================================
# 종가 이력 kr_close_adj — 토스 수정주가 1년 메우기·기준 바뀜 다시 받기 (명세 §4-1 '이력', §4-15)
# ==============================================================================
# 처음 메우는 기간(달력일) — 수익률·패킷 요약의 1년 창. 2025년은 공휴일 보존 하한(K35)과 같은 해입니다.
KR_HISTORY_DAYS = 365
# 실행당 토스 호출 상한 — 1년 ≈ 250거래일이라 종목마다 200봉 쪽 2번. 수집 범위 약 140종목을 한 실행에 메웁니다(그 뒤로는 거의 0회).
# DATA_SOURCES.md '한국 책 호출 예산'과 같아야 합니다(test_toss_call_budget).
KR_HISTORY_CALL_BUDGET = 300
# 새 종목을 더 시작하지 않는 경과 시간(초) — weekly 상한 1800초 안.
KR_HISTORY_TIME_LIMIT_SECONDS = 900.0
# 저장된 마지막 날이 이만큼(달력일) 넘게 오래되면 그 사이를 메웁니다 — kr_paper_quotes가 날마다 최근 5봉을 덧붙이므로, 수집기가 일주일
# 넘게 꺼져 있었을 때만 생기는 빈 구간입니다. kr_paper_quotes는 그런 빈 구간 너머로 덧붙이지 않아(adjGap) 마지막 날이 앞당겨지지 않습니다.
KR_HISTORY_GAP_DAYS = 7


def _adjusted_back_to(code: str, stop: str, run: _TossRun, session: str,
                      before: str | None = None) -> tuple[list[tuple[str, float]], bool]:
    """
    수정 일봉 종가를 최신 쪽(``before``가 있으면 그 시각 이하)부터 200봉씩 거슬러 받습니다 — 가장 오래된 봉이 ``stop`` 이하이거나
    더 오래된 봉이 없으면(``nextBefore`` 없음·빈 쪽 — 상장일) 끝. 대상 세션보다 늦은 날짜(오늘 장중 봉)는 버립니다.

    :returns: (날짜·종가 점, 끝까지 받았는가 — 예산·403·둘째 쪽부터의 실패로 멈췄으면 False, 실패 사유는 run.reasons)
    :raises toss_service.TossError: 첫 쪽 호출 실패(403 제외 — run.forbidden에 남기고 False)
    """
    points: list[tuple[str, float]] = []
    cursor = before
    while True:
        if not run.take():
            return points, False
        try:
            candles, next_before = toss_service.fetch_candles(code, "1d", toss_service.CANDLE_MAX_COUNT, adjusted=True,
                                                              before=cursor)
        except toss_service.TossForbidden as exc:
            run.forbidden = str(exc)
            return points, False
        except toss_service.TossMissingKey:
            raise
        except toss_service.TossError as exc:
            if not points:
                raise
            run.reasons.append(f"{code}: {exc} — 받은 쪽까지만")
            return points, False
        points += [(c["date"], c["close"]) for c in candles if c["date"] <= session]
        if not candles or not next_before or min(c["date"] for c in candles) <= stop:
            return points, True
        cursor = next_before


def _history_plan(code: str, entry: dict | None, floor: date, today: date) -> tuple[str, str, str | None] | None:
    """
    그 종목에 할 일 — (종류, 멈출 날짜, 시작 before) 또는 None(할 일 없음).
      다시 받기  관측치가 수정주가 기준 바뀜(adjBasisChanged)을 걸었고 저장값이 관측치의 수정 종가와 다름 → 최신부터 저장 첫 날까지 통째로
      메우기    저장 첫 날이 목표(1년 전, 상장일이 더 늦으면 상장일)보다 늦음 → 저장 첫 날 앞부터 목표까지
      빈 구간   저장된 마지막 날이 KR_HISTORY_GAP_DAYS보다 오래됐거나, 관측치의 최근 5봉 첫 날과 저장된 마지막 날 사이에 빠진 거래일이
                있음(관측치가 그 너머로 덧붙이지 않음 — adjGap, _adj_gap) → 최신부터 그 날까지. 관측치가 이 태스크보다 먼저 돌아도
                저장된 마지막 날이 앞당겨지지 않으므로 기동 때 순서와 상관없이 걸립니다.
    """
    earliest = store.earliest_timeseries_date(catalog.TS_KR_CLOSE_ADJ, code)
    latest = store.latest_timeseries_date(catalog.TS_KR_CLOSE_ADJ, code)
    entry = entry if isinstance(entry, dict) else {}
    if earliest and entry.get("adjBasisChanged") and _stored_differs(code, entry):
        return "다시 받기", earliest, None
    list_date = str(entry.get("listDate") or "")[:10]
    target = max(floor.isoformat(), list_date) if list_date else floor.isoformat()
    if earliest is None:
        return "메우기", target, None
    if earliest > target:
        before = (date.fromisoformat(earliest) - timedelta(days=1)).isoformat() + "T00:00:00+09:00"
        return "메우기", target, before
    observed = [bar["date"] for bar in entry.get("bars") or [] if isinstance(bar, dict) and bar.get("date") and bar.get("adjClose")]
    if latest and (latest < (today - timedelta(days=KR_HISTORY_GAP_DAYS)).isoformat()
                   or (observed and _adj_gap(latest, min(observed)))):
        return "빈 구간", latest, None
    return None


def _stored_differs(code: str, entry: dict) -> bool:
    """관측치의 수정 종가(최근 5봉)가 같은 날짜의 저장값과 KR_ADJ_BASIS_TOLERANCE 넘게 다른가 — 아직 옛 기준이면 참, 이미 다시 받았으면 거짓."""
    points = [(bar["date"], bar["adjClose"]) for bar in entry.get("bars") or [] if isinstance(bar, dict) and bar.get("adjClose")]
    if not points:
        return False
    stored = {row["date"]: row["value"] for row in store.read_timeseries(catalog.TS_KR_CLOSE_ADJ, code, start_date=points[0][0])}
    return any(day in stored and stored[day] and abs(value / stored[day] - 1) > KR_ADJ_BASIS_TOLERANCE for day, value in points)


def task_kr_paper_price_history() -> str:
    """
    🧪 한국 책 종가 이력 — 수집 범위(kr_scope)의 토스 수정주가(adjusted=true) 일봉 종가 → timeseries ``kr_close_adj``(series = 코드).

    kr_paper_quotes가 날마다 최근 5봉을 덧붙이고, 이 태스크는 그 앞을 메웁니다(weekly).
      - 메우기: 저장 첫 날이 1년 전(상장일이 늦으면 상장일)보다 늦으면 그 앞을 ``before``로 200봉씩 거슬러 받습니다 — 종목마다 한 번이고
        다 메우면 0회입니다. 받은 쪽은 바로 씁니다(다음 실행이 저장 첫 날 앞부터 이어 받음).
      - 다시 받기: 관측치가 수정주가 기준 바뀜(분할·병합 뒤 토스가 과거 수정가를 다시 씀)을 걸었고 저장값이 아직 옛 기준이면, 저장 구간
        전체를 새 기준으로 다시 받습니다. **끝까지 받았을 때만** 씁니다 — 반만 고친 시계열은 옛 기준과 새 기준이 섞입니다.
      - 빈 구간: 저장된 마지막 날이 일주일 넘게 오래됐거나 관측치의 최근 5봉과 이어지지 않으면(수집기가 오래 꺼져 있었음 — 관측치는
        그 너머로 덧붙이지 않고 adjGap을 검) 최신부터 그 날까지.
      - 대상 세션(kr_target_session)보다 늦은 날짜(오늘 장중 봉)는 쓰지 않습니다. 기존 점은 지우지 않습니다(upsert).
      - 실행당 KR_HISTORY_CALL_BUDGET·KR_HISTORY_TIME_LIMIT_SECONDS 안에서만, 403이면 멈춥니다. 할 일이 있었는데 한 종목도 받지 못하면
        EmptyResult(기존 이력 유지).
    """
    started = _clock()
    now = _now()
    today = now.astimezone(KST).date()
    session = kr_target_session(now).isoformat()
    floor = today - timedelta(days=KR_HISTORY_DAYS)
    scope, _basis = kr_scope()
    quotes = previous_payload(catalog.SNAP_KR_PAPER_QUOTES).get("codes") or {}
    run = _TossRun(KR_HISTORY_CALL_BUDGET, KR_CANDLE_SPACING)
    done: dict[str, list[str]] = {"메우기": [], "다시 받기": [], "빈 구간": [], "더 오래된 봉 없음": []}
    attempted = 0
    points_written = 0
    stop = ""
    for code in scope:
        if run.forbidden:
            break
        plan = _history_plan(code, quotes.get(code), floor, today)
        if plan is None:
            continue
        if _clock() - started >= KR_HISTORY_TIME_LIMIT_SECONDS:
            stop = f"시간 상한 {KR_HISTORY_TIME_LIMIT_SECONDS:.0f}초 — 나머지는 다음 실행"
            break
        if run.remaining < 1:
            stop = "호출 예산 소진 — 나머지는 다음 실행"
            break
        kind, until, before = plan
        attempted += 1
        try:
            points, complete = _adjusted_back_to(code, until, run, session, before)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"{exc} — 한국 책 종가 이력을 받지 않습니다 · 기존 이력 유지") from None
        except toss_service.TossError as exc:
            run.reasons.append(f"{code}: {exc}")
            continue
        if not complete and run.remaining < 1 and not run.forbidden:
            stop = "호출 예산 소진 — 나머지는 다음 실행"
        if kind == "다시 받기" and not complete:
            run.reasons.append(f"{code}: 다시 받기를 끝내지 못함 — 쓰지 않고 다음 실행에 처음부터")
            continue
        if points:
            points_written += store.put_timeseries(catalog.TS_KR_CLOSE_ADJ, code, points)
            done[kind].append(code)
        elif complete:
            done["더 오래된 봉 없음" if kind == "메우기" else kind].append(code)

    if run.forbidden:
        run.reasons.insert(0, run.forbidden)
    if not attempted:
        return f"최신 상태 ({len(scope)}종목, 호출 0회)"
    finished = sum(len(codes) for codes in done.values())
    if not finished:
        raise EmptyResult(f"0/{attempted} 종목 — 기존 이력 유지" + (f" ({stop})" if stop else "") + _reason_suffix(run.reasons))
    parts = [f"{kind} {len(codes)}" + (f"({', '.join(codes[:3])}{'…' if len(codes) > 3 else ''})" if kind != "메우기" else "")
             for kind, codes in done.items() if codes]   # 메우기는 처음에 수집 범위 전부라 이름을 늘어놓지 않음
    detail = f"{finished}/{attempted} 종목 — {' · '.join(parts)} · 점 {points_written}개 · 호출 {run.budget.used}회"
    if stop:
        detail += f" · {stop}"
    return detail + _reason_suffix(run.reasons)
