"""
app/services/bls.py
BLS(미국 노동통계국) Public Data API — 미국 경제지표의 공식 발표치(ADR 0040 '단계 2 앞당김 — BLS 공식 실제치'). 받아서 읽기까지만 합니다.

[출처 — api.bls.gov, 공식]
  - 등록 키(``BLS_API_KEY``)가 있으면 v2: ``POST https://api.bls.gov/publicAPI/v2/timeseries/data/`` JSON
    ``{seriesid, startyear, endyear, registrationkey}``. 없으면 같은 모양의 v1(키 없음). 한도(공식 FAQ, 2026-11-13 확인): v2 등록 하루 500회·
    요청당 50개 시리즈·20년, v1 하루 25회·25개·10년, 두 판 모두 10초에 50회. 등록은 해마다 갱신해야 합니다.
  - 키는 POST 본문에만 싣습니다 — 주소에 넣지 않아 로그·오류 글·실행 기록에 남지 않습니다. 응답 메시지도 :mod:`app.logredact`를 거칩니다.
  - 세션은 BLS 세션(설명형 UA, 연락처 없음 — ``http.get_bls_session``). 2026-11-13 서버에서 v1 요청 200을 확인했습니다(같은 날
    ``www.bls.gov`` 보도자료 RSS는 403 — 다른 서비스라 이 키로 풀리지 않음).
  - 응답 ``{status, message: [...], Results: {series: [{seriesID, data: [{year, period "M10", periodName, value "337.476", latest "true",
    footnotes: [{code, text}]}]}]}}``. 발표 직전·도중에는 ``message``에 'Database is locked for Series …'가 오고 그 시리즈의 ``data``가 비어
    있습니다(2026-11-13 PPI 세 시리즈) — '아직 없음'으로 읽습니다. 한도를 넘으면 ``REQUEST_NOT_PROCESSED``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .. import logredact
from ..http import SourceRejected, brief_error, get_bls_session, retry_after_seconds

V2_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
V1_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
SOURCE = "BLS Public Data API (api.bls.gov)"

# 요청 하나의 (연결, 읽기) 대기(초). 시리즈 11개 · 2년 치 응답은 수십 KB입니다.
FETCH_TIMEOUT = (10, 30)


@dataclass(frozen=True)
class BlsSeries:
    """
    받는 시리즈 하나.

    :param unit: "index"(지수 — 전월 대비 %를 셈) · "thousands"(천 명 — 전월 대비 증감) · "percent"(그대로) · "dollars"(전월 대비 %)
    :param release: 그 시리즈를 내는 발표("CPI"·"EMPLOYMENT"·"PPI"·"JOLTS") — 발표 시각과 다시 묻기를 정함
    :param yoy: 전년 같은 달 대비 %를 셈(계절조정 전 지수 — BLS가 전년 대비를 내는 기준)
    """

    series_id: str
    key: str
    label: str
    unit: str
    release: str
    seasonally_adjusted: bool
    yoy: bool = False


# 2026-11-13 서버에서 v1 한 번으로 확인한 ID(PPI 셋은 그때 'Database is locked' — 있는 시리즈가 잠긴 것).
SERIES: tuple[BlsSeries, ...] = (
    BlsSeries("CUSR0000SA0", "cpi", "CPI-U 전 품목(계절조정)", "index", "CPI", True),
    BlsSeries("CUSR0000SA0L1E", "core_cpi", "CPI-U 식품·에너지 제외(계절조정)", "index", "CPI", True),
    BlsSeries("CUUR0000SA0", "cpi_nsa", "CPI-U 전 품목(계절조정 전 — 전년 대비)", "index", "CPI", False, yoy=True),
    BlsSeries("CUUR0000SA0L1E", "core_cpi_nsa", "CPI-U 식품·에너지 제외(계절조정 전 — 전년 대비)", "index", "CPI", False, yoy=True),
    BlsSeries("CES0000000001", "nonfarm_payrolls", "비농업 고용(계절조정, 천 명)", "thousands", "EMPLOYMENT", True),
    BlsSeries("LNS14000000", "unemployment_rate", "실업률(계절조정, %)", "percent", "EMPLOYMENT", True),
    BlsSeries("CES0500000003", "avg_hourly_earnings", "민간 평균 시급(계절조정, 달러)", "dollars", "EMPLOYMENT", True),
    BlsSeries("WPSFD4", "ppi_final_demand", "PPI 최종 수요(계절조정)", "index", "PPI", True),
    BlsSeries("WPSFD49116", "ppi_core_trade", "PPI 최종 수요 — 식품·에너지·무역 서비스 제외(계절조정)", "index", "PPI", True),
    BlsSeries("WPUFD4", "ppi_final_demand_nsa", "PPI 최종 수요(계절조정 전 — 전년 대비)", "index", "PPI", False, yoy=True),
    BlsSeries("JTS000000000000000JOL", "jolts_openings", "JOLTS 구인(계절조정, 천 건)", "thousands", "JOLTS", True),
)

SERIES_BY_ID = {series.series_id: series for series in SERIES}


class BlsFetchError(RuntimeError):
    """한 번의 요청을 받지 못함 — 사유는 화면에 뜨는 한 줄(키·응답 본문 없음)."""

    def __init__(self, message: str, *, rejected: bool = False, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.rejected = rejected
        self.retry_after = retry_after


class BlsShapeError(ValueError):
    """받았지만 응답 모양이 조사 때와 다름."""


def fetch(series_ids: list[str], start_year: int, end_year: int, key: str | None) -> dict:
    """
    시리즈를 한 요청으로 받습니다 → 응답 본문(dict). 키가 있으면 v2, 없으면 v1.

    :raises BlsFetchError: 연결·HTTP·출처 거부·한도 초과(``REQUEST_NOT_PROCESSED`` — rejected)
    :raises BlsShapeError: JSON이 아니거나 모르는 상태
    """
    payload: dict = {"seriesid": list(series_ids), "startyear": str(start_year), "endyear": str(end_year)}
    url = V1_URL
    if key:
        payload["registrationkey"] = key
        url = V2_URL
    try:
        res = get_bls_session().post(url, json=payload, timeout=FETCH_TIMEOUT)
    except SourceRejected as exc:
        raise BlsFetchError(brief_error(exc), rejected=True, retry_after=exc.retry_after) from None
    except Exception as exc:  # noqa: BLE001 — 연결 오류는 이 요청의 실패입니다
        raise BlsFetchError(logredact.redact(brief_error(exc))) from None
    try:
        if res.status_code != 200:
            raise BlsFetchError(f"HTTP {res.status_code}", retry_after=retry_after_seconds(res.headers.get("Retry-After")))
        try:
            body = res.json()
        except ValueError:
            raise BlsShapeError("JSON이 아님") from None
    finally:
        res.close()
    if not isinstance(body, dict):
        raise BlsShapeError("JSON 객체가 아님")
    status = body.get("status")
    if status == "REQUEST_NOT_PROCESSED":
        raise BlsFetchError(f"요청을 처리하지 않음 — {messages_text(body, key)}", rejected=True)
    if status != "REQUEST_SUCCEEDED":
        raise BlsShapeError(f"모르는 상태 {str(status)[:40]} — {messages_text(body, key)}")
    return body


def messages_text(body: dict, key: str | None = None, limit: int = 3) -> str:
    """
    응답 message의 앞 몇 줄(가린 뒤). 없으면 '메시지 없음'.

    BLS가 메시지에 키를 되풀이해도(잘못된 키·한도 초과 안내 등) 실행 기록·로그에 남지 않게 키 글자를 먼저 지웁니다.
    """
    messages = [str(m) for m in body.get("message") or [] if m]
    if not messages:
        return "메시지 없음"
    if key:
        messages = [m.replace(key, "***") for m in messages]
    shown = "; ".join(logredact.redact(m)[:120] for m in messages[:limit])
    return shown + (f" 외 {len(messages) - limit}건" if len(messages) > limit else "")


_LOCKED = re.compile(r"Database is locked for Series\s+([A-Z0-9_#-]+)", re.IGNORECASE)
_MONTH = re.compile(r"M(0[1-9]|1[0-2])")


@dataclass
class Parsed:
    points: dict            # 시리즈 ID → [{month "YYYY-MM", value float|None, preliminary bool}] — 최신부터
    locked: list            # 'Database is locked'였던 시리즈 ID(발표 직전·도중 — 아직 없음)
    missing: list           # 응답에 없거나 값이 하나도 없던 시리즈 ID(잠김 제외)


def parse(body: dict, series_ids: list[str]) -> Parsed:
    """
    응답 → 시리즈별 월 값. 연평균(M13)·월이 아닌 기간은 건너뜁니다. 값이 숫자가 아니면 None(지어내지 않음).

    :raises BlsShapeError: Results.series가 목록이 아님
    """
    results = body.get("Results")
    series_list = results.get("series") if isinstance(results, dict) else None
    if not isinstance(series_list, list):
        raise BlsShapeError("Results.series가 없음")
    locked = sorted({m.group(1).upper() for text in body.get("message") or [] if isinstance(text, str)
                     for m in [_LOCKED.search(text)] if m})
    points: dict[str, list[dict]] = {}
    for series in series_list:
        if not isinstance(series, dict):
            continue
        series_id = str(series.get("seriesID") or "").upper()
        rows = []
        for item in series.get("data") or []:
            if not isinstance(item, dict):
                continue
            matched = _MONTH.fullmatch(str(item.get("period") or ""))
            year = str(item.get("year") or "")
            if not matched or not year.isdigit():
                continue
            footnotes = [str(f.get("text") or "").lower() for f in item.get("footnotes") or [] if isinstance(f, dict)]
            rows.append({"month": f"{year}-{matched.group(1)}", "value": _number(item.get("value")),
                         "preliminary": any("preliminary" in text for text in footnotes)})
        rows.sort(key=lambda row: row["month"], reverse=True)
        if rows:
            points[series_id] = rows
    missing = [series_id for series_id in series_ids if series_id not in points and series_id not in locked]
    return Parsed(points, [series_id for series_id in series_ids if series_id in locked], missing)


def _number(value) -> float | None:
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if number == number else None   # NaN 거름
