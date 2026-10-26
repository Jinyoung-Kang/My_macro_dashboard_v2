"""
app/services/liquidity.py
연준 순유동성(Net Liquidity = WALCL − TGA − ON RRP) 수집.

[구버전과 달라진 점 — 의도한 변경]
구버전 services/liquidity_service._build_emergency_fallback_series()는 FRED
접속이 모두 실패했을 때 **사인파로 만든 가짜 시계열**을 반환했습니다
(is_estimated=True 표시는 붙었습니다).

    vals = 964000.0 + np.sin(np.linspace(0, 20, len(dates))) * 150000

이 값에는 정보가 전혀 없는데 차트는 그럴듯하게 그려집니다. 구버전 README가
스스로 정한 규칙 — "수집 실패 시 그럴듯한 가짜 숫자를 만들지 마세요" —
과도 정면으로 충돌합니다. 이 버전은 그 폴백을 만들지 않고 **빈 결과**를
돌려주며, 화면은 "수집 실패"를 그대로 표시합니다.

(KRX 선물의 KODEX 200 폴백은 성격이 다릅니다. 실제 시장 가격에서 파생된
추정치이므로 is_estimated 표시와 함께 유지합니다. services/krx.py 참고)
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from . import fred
from ..http import bind_guard

logger = logging.getLogger(__name__)

SERIES = ("WALCL", "WTREGEN", "RRPONTSYD")


def collect_fed_liquidity(period_years: int = 10) -> dict:
    """
    순유동성 시계열을 만듭니다.

    반환 계약(JSON):
    {
      "isEstimated": false,          # 이 버전은 추정치를 만들지 않습니다
      "rows": [
        {"date","walcl","wtregen","rrpM","rrpB","netLiquidityM","netLiquidityT",
         "walclT","wtregenB"}
      ]
    }
    단위: WALCL/WTREGEN은 $M, RRPONTSYD는 $B로 오는 경우가 있어 정규화합니다.
    """
    with ThreadPoolExecutor(max_workers=3) as pool:
        collected = list(pool.map(
            bind_guard(lambda sid: fred.collect_series_with_reason(sid, period_years)), SERIES
        ))
    walcl, wtregen, rrp = (points for points, _ in collected)

    if not walcl or not wtregen or not rrp:
        # 어느 시계열이 왜 비었는지까지 남깁니다. "순유동성 빈 결과"만으로는
        # FRED 키 문제인지 망 문제인지 구분할 수 없습니다.
        missing = [
            f"{sid}({reason})" if reason else sid
            for sid, (points, reason) in zip(SERIES, collected)
            if not points
        ]
        logger.warning("순유동성 구성 시계열 수집 실패: %s", missing)
        return {
            "isEstimated": False,
            "rows": [],
            "error": "구성 시계열 수집 실패: " + ", ".join(missing),
        }

    walcl_map = _as_map(walcl)
    wtregen_map = _as_map(wtregen)
    rrp_map = _as_map(rrp)

    all_dates = sorted(set(walcl_map) | set(wtregen_map) | set(rrp_map))

    # RRP 단위 정규화: 최대값이 10,000 미만이면 $B 단위입니다.
    rrp_max = max(rrp_map.values())
    rrp_is_billions = rrp_max < 10_000

    rows: list[dict] = []
    last_walcl = last_wtregen = last_rrp = None

    for day in all_dates:
        # 세 시계열의 발표 주기가 달라 구멍이 납니다. 직전 값으로 채웁니다
        # (forward fill). 앞쪽에 값이 없는 날짜는 건너뜁니다.
        last_walcl = walcl_map.get(day, last_walcl)
        last_wtregen = wtregen_map.get(day, last_wtregen)
        last_rrp = rrp_map.get(day, last_rrp)

        if last_walcl is None or last_wtregen is None or last_rrp is None:
            continue

        rrp_m = last_rrp * 1000.0 if rrp_is_billions else last_rrp
        rrp_b = last_rrp if rrp_is_billions else last_rrp / 1000.0
        net_m = last_walcl - last_wtregen - rrp_m

        rows.append({
            "date": day,
            "walcl": last_walcl,
            "wtregen": last_wtregen,
            "rrpM": rrp_m,
            "rrpB": rrp_b,
            "netLiquidityM": net_m,
            "netLiquidityT": net_m / 1e6,
            "walclT": last_walcl / 1e6,
            "wtregenB": last_wtregen / 1e3,
        })

    return {"isEstimated": False, "rows": rows}


def _as_map(points: list[dict]) -> dict[str, float]:
    return {p["date"]: float(p["value"]) for p in points if p.get("value") is not None}
