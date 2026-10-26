"""
app/services/fred.py
FRED 시계열 수집 (공식 API → 웹 CSV 폴백).

수집에 실패하면 **가짜 값을 만들지 않고 빈 결과**를 돌려줍니다.
구버전 services/macro_service.collect_fred_series()와 같은 원칙입니다.
(연준 순유동성만 예외적으로 '추정치' 경로가 있는데, 그쪽은 반드시
is_estimated 플래그를 달아 화면이 경고할 수 있게 합니다.)
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import datetime, timedelta

from .. import settings
from ..http import SourceRejected, brief_error, get_fred_session

logger = logging.getLogger(__name__)

# FRED 응답 대기 한도(초).
#
# 10년치 일별 관측치는 응답이 제법 큽니다. 15초로는 자주 모자라서 urllib3가
# 재시도로 넘어갔고, 그때마다 같은 요청이 다시 나갔습니다. 실제 로그:
#
#   WARNING urllib3: Retrying (...) ReadTimeoutError(host='api.stlouisfed.org'
#   ... read timeout=15) : /fred/series/observations?series_id=WALCL...
#
# 재시도는 느린 서버를 더 밀어붙일 뿐입니다. 한 번에 넉넉히 기다리는 쪽이
# 전체 수집 시간도 짧습니다(fred_series가 24~38초까지 늘어났습니다).
FRED_TIMEOUT = 30


def collect_series(series_id: str, period_years: int = 10) -> list[dict]:
    """
    FRED 시계열 1종을 수집합니다.

    반환: [{"date": "YYYY-MM-DD", "value": float}, ...] (오름차순)
          실패하면 빈 리스트.
    """
    points, _ = collect_series_with_reason(series_id, period_years)
    return points


def collect_series_with_reason(
    series_id: str, period_years: int = 10
) -> tuple[list[dict], str | None]:
    """
    수집 결과와 **실패 사유**를 함께 돌려줍니다.

    사유가 필요한 이유: 상태 화면이 "0/12 시리즈"라고만 말하면 운영자가
    무엇을 고쳐야 할지 알 수 없습니다. "HTTP 403", "키 없음 + CSV 차단"처럼
    조치로 이어지는 문장이어야 합니다.
    """
    start_date = (
        datetime.now() - timedelta(days=period_years * 365 + 90)
    ).strftime("%Y-%m-%d")

    points, api_reason = _from_api(series_id, start_date)
    if len(points) >= 2:
        return points, None

    points, csv_reason = _from_csv(series_id)
    if len(points) >= 2:
        return points, None

    reason = " / ".join(r for r in (api_reason, csv_reason) if r) or "알 수 없는 실패"
    logger.error(
        "%s: FRED API와 CSV가 모두 실패했습니다 (%s). "
        "가짜 데이터를 만들지 않고 빈 결과를 반환합니다.",
        series_id, reason,
    )
    return [], reason


def _from_api(series_id: str, start_date: str) -> tuple[list[dict], str | None]:
    key = settings.fred_key()
    if not key:
        logger.info("%s: FRED API 키가 없어 웹 CSV 경로로 진행합니다.", series_id)
        return [], "API 키 없음"

    url = f"{settings.FRED_API_BASE}/series/observations"
    params = {
        "series_id": series_id,
        "api_key": key,
        "file_type": "json",
        "observation_start": start_date,
    }
    try:
        res = get_fred_session().get(url, params=params, timeout=FRED_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        logger.warning("FRED API 실패 (%s): %s", series_id, exc)
        return [], f"API {brief_error(exc)}"

    if res.status_code != 200:
        logger.warning(
            "FRED API 응답 실패 (%s): HTTP %s - %s",
            series_id, res.status_code, res.text[:200],
        )
        return [], f"API HTTP {res.status_code}"

    try:
        observations = res.json().get("observations", [])
    except ValueError as exc:
        logger.warning("FRED API JSON 해석 실패 (%s): %s", series_id, exc)
        return [], "API 응답을 JSON으로 읽지 못했습니다"

    points = _clean_points(
        (row.get("date"), row.get("value")) for row in observations
    )
    return points, (None if points else "API 응답에 관측치가 없습니다")


_CSV_BLOCKED_HINT = " — FRED_API_KEY를 설정하면 공식 API 경로로 우회됩니다"


def _from_csv(series_id: str) -> tuple[list[dict], str | None]:
    """
    FRED 웹 CSV 폴백.

    FRED가 날짜 컬럼명을 'DATE'에서 'observation_date'로 바꾼 이력이 있어,
    컬럼명을 고정하지 않고 탐색합니다.
    """
    try:
        res = get_fred_session().get(
            settings.FRED_CSV_BASE, params={"id": series_id}, timeout=FRED_TIMEOUT
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("FRED CSV 다운로드 실패 (%s): %s", series_id, exc)
        # 403·429는 공용 세션이 출처 거부(SourceRejected)로 올립니다 — 아래와 같은 키 안내를 붙입니다.
        hint = _CSV_BLOCKED_HINT if isinstance(exc, SourceRejected) else ""
        return [], f"CSV {brief_error(exc)}{hint}"

    if res.status_code != 200:
        logger.warning(
            "FRED CSV 응답 비정상 (%s): HTTP %s", series_id, res.status_code
        )
        # 403은 보통 차단(데이터센터 IP·User-Agent)입니다. 키를 넣으면 API
        # 경로로 우회되므로 사유에 그 힌트를 함께 담습니다.
        hint = _CSV_BLOCKED_HINT if res.status_code in (403, 429) else ""
        return [], f"CSV HTTP {res.status_code}{hint}"

    if len(res.text) < 30:
        return [], "CSV 응답이 비어 있습니다"

    reader = csv.DictReader(io.StringIO(res.text))
    fieldnames = reader.fieldnames or []
    date_col = next(
        (c for c in ("observation_date", "DATE", "date") if c in fieldnames), None
    )
    if date_col is None:
        logger.warning(
            "FRED CSV에서 날짜 컬럼을 찾지 못했습니다 (%s): %s", series_id, fieldnames
        )
        return [], f"CSV에 날짜 컬럼이 없습니다 (받은 컬럼: {fieldnames[:4]})"

    value_col = next((c for c in fieldnames if c != date_col), None)
    if value_col is None:
        return [], "CSV에 값 컬럼이 없습니다"

    points = _clean_points(
        (row.get(date_col), row.get(value_col)) for row in reader
    )
    return points, (None if points else "CSV에 유효한 관측치가 없습니다")


def _clean_points(rows) -> list[dict]:
    """'.'(결측)과 파싱 불가 값을 버리고 날짜 오름차순으로 정리합니다."""
    out: list[dict] = []
    for raw_date, raw_value in rows:
        if not raw_date or raw_value in (None, "", "."):
            continue
        try:
            value = float(str(raw_value).strip())
        except (TypeError, ValueError):
            continue
        if value != value:      # NaN
            continue
        out.append({"date": str(raw_date)[:10], "value": value})

    out.sort(key=lambda p: p["date"])
    return out


def latest_value(points: list[dict]) -> float | None:
    """마지막 값. FRED는 하루 지연이므로 이 값이 곧 직전 거래일 확정치입니다."""
    if not points:
        return None
    value = points[-1]["value"]
    return float(value) if value is not None else None
