"""
app/services/cot.py
CFTC COT(Commitments of Traders) 수집.

CFTC 공개 API는 응답이 느리고 간헐적으로 연결이 끊깁니다(Connection reset).
일시적 실패를 영구 실패로 보고하지 않도록 지수 백오프로 재시도합니다.
주 1회(금요일) 발표이므로 저장본만으로도 화면은 충분히 최신입니다.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from ..http import get_session
from ..numbers import to_float

logger = logging.getLogger(__name__)

CFTC_URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"


class CFTCTransientError(RuntimeError):
    """일시적 장애. 저장본이 있으면 그것으로 대체할 수 있다는 신호입니다."""


def collect_contract(contract_code: str, limit: int = 300) -> list[dict]:
    """
    계약 코드 1종의 주간 포지션 시계열.

    반환: [{"date","ncLong","ncShort","commLong","commShort","nrLong","nrShort",
            "ncNet","commNet","nrNet"}, ...] (날짜 오름차순)
    """
    params = {
        "cftc_contract_market_code": contract_code,
        "$limit": limit,
        "$order": "report_date_as_yyyy_mm_dd DESC",
    }

    response, error = _get_with_retry(params)
    if error:
        raise CFTCTransientError(f"CFTC 재시도 후 실패: {error}")

    try:
        rows = response.json()
    except ValueError as exc:
        raise CFTCTransientError(f"JSON 해석 실패: {exc}") from exc

    if not rows:
        raise CFTCTransientError("결과 없음")

    records: list[dict] = []
    for row in rows:
        date_text = row.get("report_date_as_yyyy_mm_dd")
        if not date_text:
            continue
        # Socrata는 null 필드를 아예 빼고 보냅니다. 빠진 값은 모르는 값이고, 순포지션은 두 값을 다 알 때만 냅니다
        # (QA-036 — 예전에는 0으로 채워 롱만 있는 '순포지션'을 만들었습니다).
        nc_long = to_float(row.get("noncomm_positions_long_all"))
        nc_short = to_float(row.get("noncomm_positions_short_all"))
        comm_long = to_float(row.get("comm_positions_long_all"))
        comm_short = to_float(row.get("comm_positions_short_all"))
        nr_long = to_float(row.get("nonrept_positions_long_all"))
        nr_short = to_float(row.get("nonrept_positions_short_all"))

        records.append({
            "date": str(date_text)[:10],
            "ncLong": nc_long,
            "ncShort": nc_short,
            "commLong": comm_long,
            "commShort": comm_short,
            "nrLong": nr_long,
            "nrShort": nr_short,
            "ncNet": _net(nc_long, nc_short),
            "commNet": _net(comm_long, comm_short),
            "nrNet": _net(nr_long, nr_short),
        })

    if not records:
        raise CFTCTransientError("파싱 결과 없음")

    records.sort(key=lambda r: r["date"])
    return records


def _net(long: float | None, short: float | None) -> float | None:
    return None if long is None or short is None else long - short


def collect_multi_asset(assets: dict, weeks: int, max_workers: int = 4) -> dict:
    """
    여러 자산을 병렬 수집합니다. 한 자산이 실패해도 나머지는 진행합니다.

    반환: {"assets": {자산명: {"code","category","error","rows":[...]}}}
    """
    out: dict[str, dict] = {}

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(collect_contract, info["code"], weeks): (name, info)
            for name, info in assets.items()
        }
        for future in as_completed(futures):
            name, info = futures[future]
            try:
                rows = future.result()
                out[name] = {
                    "code": info["code"],
                    "category": info["category"],
                    "error": None,
                    "rows": rows,
                }
            except Exception as exc:  # noqa: BLE001
                logger.warning("COT 수집 실패 (%s): %s", name, exc)
                out[name] = {
                    "code": info["code"],
                    "category": info["category"],
                    "error": str(exc)[:300],
                    "rows": [],
                }

    return {"assets": out}


def _get_with_retry(params: dict, max_attempts: int = 3):
    last_error = None
    for attempt in range(max_attempts):
        try:
            response = get_session().get(
                CFTC_URL,
                params=params,
                timeout=(5, 30),
                # CFTC(Socrata)는 연락처를 요구하지 않습니다. 자리표시 주소를 코드 기본값으로 싣지 않습니다(QA-038).
                headers={"User-Agent": "my-macro-dashboard-v2/1.0"},
            )
            response.raise_for_status()
            return response, None
        except requests.RequestException as exc:
            last_error = exc
            if attempt < max_attempts - 1:
                time.sleep(2 ** attempt)
    return None, str(last_error)
