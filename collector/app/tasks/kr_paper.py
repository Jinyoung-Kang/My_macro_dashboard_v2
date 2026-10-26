"""
app/tasks/kr_paper.py
🧪 모의 알고리즘 매매 한국 책(v2 2단계)의 자료 — 유니버스·수집 범위.

태스크는 "받아서 저장"만 합니다. 후보·점수·체결·평가·기업행위 판정은 백엔드(feature/paper)가 저장본을 읽어 합니다 — 수집기가
장부를 건드리면 테이블마다 쓰는 프로세스가 하나라는 규칙(ADR 0008)이 깨집니다. 백엔드 표(보유·주문·설정)도 읽지 않습니다 —
수집 범위는 수집기 자기 저장본(유니버스 이력)만으로 정합니다(명세 §4-5 '끈적 목록').

[유니버스 U — 명세 §4-5·K3, 정의는 이 파일 한 곳]
  금융위 주식시세의 최신 기준일 B(< 오늘)에서 코스피 시가총액 상위 100 보통주. 제외(추정 규칙 — 고정본 테스트가 잠금):
    우선주   코드 끝자리 ≠ '0' 또는 이름이 '우'·'우B'·'우C'로 끝남
    스팩     이름에 '스팩'
    리츠     이름에 '리츠' — 단 '메리츠'의 '리츠'는 아님([확인] 2026-10-23 코스피 '리츠' 포함 24종목 중 메리츠금융지주만 리츠가 아님)
    거래정지 B의 금융위 거래량이 0이거나 없음(금융위 행에는 정지 표시가 없어 '그날 체결 없음'으로 읽음 — 외부 호출 없이)
    DART     고유번호 표(kr.dart_corp_codes — dart_fundamentals가 받음)에 없음. 표가 없으면 계산하지 않습니다(추측하지 않음)
  ETF·ETN은 주식시세에 없습니다. 같은 시가총액이면 코드 순.
[수집 범위]
  ETF 2(069500·153130) → 최신 U(순위 순) → 끈적 목록(보존 400일 안의 유니버스 이력에 한 번이라도 든 다른 종목, 코드 순).
  모든 보유는 U에서 사므로 U를 벗어난 보유도 가격·수급을 계속 받습니다.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta

from .. import catalog, store

from .base import EmptyResult, KST

logger = logging.getLogger(__name__)


# ==============================================================================
# 유니버스 U
# ==============================================================================
KR_UNIVERSE_SIZE = 100
KR_UNIVERSE_MARKET = "KOSPI"
# 규칙 판 — 행마다 남깁니다. 위 정의(제외 규칙·크기)를 바꾸면 판을 올려, 같은 기준일도 다시 계산하고 결정 행이 어느 판인지 알게 합니다.
KR_UNIVERSE_RULE = "kospi-mcap-top100-common/v1"
KR_UNIVERSE_RETENTION_DAYS = 400
# 한국 책 벤치마크·현금성 ETF(명세 K2) — 유니버스와 상관없이 늘 수집 범위의 맨 앞입니다.
KR_SCOPE_ETFS = ("069500", "153130")

_PREFERRED_NAME = re.compile(r"우[BC]?$")
_REIT_NAME = re.compile(r"(?<!메)리츠")

# 제외 사유(결과 문구의 이름과 순서)
_EXCLUSIONS = ("우선주", "스팩", "리츠", "거래정지", "DART 없음", "시총 없음")


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
        return f"최신 상태 (기준일 {basis}, {len(stored)}종목)"

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
            + (f" (제외 {excluded_text})" if excluded_text else ""))


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
