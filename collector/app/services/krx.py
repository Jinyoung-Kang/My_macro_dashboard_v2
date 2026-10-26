"""
app/services/krx.py
KRX 파생(KOSPI200 선물) · Daum 선물 투자자별 수급 수집.

[이 파일이 지키는 규칙 — 구버전에서 실제 사고가 났던 지점들]

1. **등락률은 연속된 확정 종가에서 직접 계산합니다.**
   KRX 응답의 FLUC_RT를 그대로 쓰지 않습니다. 그 필드가 오지 않을 때 예전
   코드가 0.0으로 메웠고, 화면이 매일 "+0.00%"를 보여줬습니다. 더 나쁜 것은
   4대 국면 판정이 `등락률 >= 0`을 쓰기 때문에 **하락한 날에도 '신규 롱'
   (강세)으로 뒤집혀** 표시된 점입니다(2026-09-11: 실제 -2.13%).
   KRX가 준 값은 changePctReported로 남겨 대조에만 씁니다.

2. **모르면 "판정 불가"입니다.** 등락률이나 미결제약정 증감이 없으면 국면을
   어느 쪽으로도 기울이지 않습니다.

3. **Daum 선물 수급은 계약수만 제공합니다.** 예전의 "금액(억원)" 모드는
   type=PRICE가 먹힌다는 가정 위에 있었는데 응답은 계약수 그대로였고, 그
   값을 1억으로 나눠 화면이 전부 0이 됐습니다. 계약수 기준만 다룹니다.

4. **추정치는 추정치라고 말합니다.** KRX 수집이 실패하면 KODEX 200(069500.KS)
   기반 가격 추정치로 폴백하되 isEstimated=true를 답니다. 다만 미결제약정과
   베이시스는 **만들어내지 않습니다** — 구버전은 sin/linspace로 합성했는데,
   실제 OI와 무관한 숫자가 화면에 OI로 표시되면 그 자체가 오류입니다.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from ..numbers import to_float
from .. import yfcache

from .. import settings
from .. import http
from ..http import bind_guard, brief_error, get_session

logger = logging.getLogger(__name__)

# 병렬 수집 전에 캐시 폴더를 만들어 둡니다 (yfcache 참고).
yfcache.configure()

KST = ZoneInfo("Asia/Seoul")

DAUM_FUTURES_DAYS_URL = "https://finance.daum.net/api/investor/future/days"
DAUM_FUTURES_TIMES_URL = "https://finance.daum.net/api/investor/future/times"

DAUM_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Referer": "https://finance.daum.net/domestic/investors/DERIVATIVES",
    "X-Requested-With": "XMLHttpRequest",
}

# Daum 응답 필드 → 표시 이름. 순서는 스마트머니(외국인)를 맨 위에 둡니다.
DAUM_INVESTOR_FIELDS = [
    ("외국인 (스마트머니)", "foreignSettlement"),
    ("기관계", "institutionalSettlement"),
    ("금융투자 (차익거래)", "financialInvestment"),
    ("보험", "insuranceInvestment"),
    ("투신", "trustInvestment"),
    ("은행", "bankInvestment"),
    ("기타금융", "etcInvestment"),
    ("연기금등", "pensionFundInvestment"),
    ("기타법인", "etcCorporationSettlement"),
    ("개인 (리테일)", "privateSettlement"),
]

PHASE_UNKNOWN = "판정 불가 (등락률 미제공)"


# ==============================================================================
# 1. KRX Open API
# ==============================================================================
def fetch_derivatives_daily(date_str: str) -> list[dict]:
    """KRX 선물 일별매매정보(drv/fut_bydd_trd). 키가 없으면 빈 리스트."""
    auth_key = settings.krx_key()
    if not auth_key:
        return []

    try:
        res = get_session().get(
            f"{settings.KRX_BASE_URL}/drv/fut_bydd_trd",
            headers={"AUTH_KEY": auth_key},
            params={"basDd": date_str},
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("KRX 파생 API 조회 실패 (%s): %s", date_str, exc)
        return []

    if res.status_code != 200:
        return []

    try:
        data = res.json()
    except ValueError:
        return []

    return _extract_rows(data)


def fetch_kospi200_index_close(date_str: str) -> float | None:
    """
    KRX Open API 지수 서비스로 코스피200 현물 종가를 조회합니다.

    pykrx 웹 스크래핑 대신 정식 AUTH_KEY 엔드포인트를 씁니다(클라우드에서
    pykrx가 차단 페이지를 받는 문제를 피합니다).
    """
    auth_key = settings.krx_key()
    if not auth_key:
        return None

    try:
        res = get_session().get(
            f"{settings.KRX_BASE_URL}/idx/kospi_dd_trd",
            headers={"AUTH_KEY": auth_key},
            params={"basDd": date_str},
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("KRX 지수 API 조회 실패 (%s): %s", date_str, exc)
        return None

    if res.status_code != 200:
        return None

    try:
        rows = _extract_rows(res.json())
    except ValueError:
        return None

    for row in rows:
        name = str(_pick(row, "IDX_NM") or "")
        if "코스피200" in name.replace(" ", ""):
            close = to_float(_pick(row, "CLSPRC_IDX", "TDD_CLSPRC"))
            return close if close and close > 0 else None
    return None


def _extract_rows(data) -> list[dict]:
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        for key in ("OutBlock_1", "output", "block1", "items"):
            value = data.get(key)
            if isinstance(value, list) and value and isinstance(value[0], dict):
                return value
        for value in data.values():
            if isinstance(value, list) and value and isinstance(value[0], dict):
                return value
    return []


# ==============================================================================
# 2. 선물 시계열
# ==============================================================================
def collect_futures_history(days: int = 40) -> dict:
    """
    최근 N영업일 KOSPI200 선물 최근월물 시계열.

    반환 계약(JSON):
    {
      "isEstimated": bool,
      "rows": [{"date","futuresClose","changePct","changePctReported","volume",
                "openInterest","oiChange","theoryPrice","marketBasis",
                "contractName","marketPhase","cotOiIndex"}]
    }
    """
    today = datetime.now(KST)
    candidates: list[str] = []
    cursor = today
    while len(candidates) < days + 10:
        if cursor.weekday() < 5:
            candidates.append(cursor.strftime("%Y%m%d"))
        cursor -= timedelta(days=1)

    with ThreadPoolExecutor(max_workers=8) as pool:
        daily = dict(zip(candidates, pool.map(bind_guard(fetch_derivatives_daily), candidates)))

    parsed: dict[str, dict] = {}
    for date_str, rows in daily.items():
        record = _parse_futures_day(date_str, rows)
        if record:
            parsed[date_str] = record

    if len(parsed) < 5:
        logger.warning(
            "KRX 선물 수집 부족(%d일). KODEX 200 기반 추정치로 대체하며 "
            "isEstimated=true로 표시합니다.",
            len(parsed),
        )
        return _fallback_from_kodex(days)

    with ThreadPoolExecutor(max_workers=8) as pool:
        spots = dict(zip(
            parsed.keys(), pool.map(bind_guard(fetch_kospi200_index_close), parsed.keys())
        ))

    rows: list[dict] = []
    for date_str in sorted(parsed):
        record = parsed[date_str]
        spot = spots.get(date_str)
        rows.append({
            "date": f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}",
            "futuresClose": record["close"],
            "changePct": None,                 # 아래에서 종가로 계산합니다
            "changePctReported": record["reportedPct"],
            "volume": record["volume"],
            "openInterest": record["openInterest"],
            "oiChange": None,
            "theoryPrice": spot,
            "marketBasis": (
                round(record["close"] - spot, 2) if spot and spot > 0 else None
            ),
            "contractName": record["contractName"],
            "marketPhase": PHASE_UNKNOWN,
            "cotOiIndex": None,
        })

    _derive_series(rows)

    if all(row["marketBasis"] is None for row in rows):
        logger.warning(
            "전체 구간에서 베이시스 계산이 실패했습니다 (KRX 지수 조회 불가). "
            "marketBasis는 null로 두고 화면이 '데이터 미제공'으로 표시해야 합니다."
        )

    return {"isEstimated": False, "rows": rows[-days:]}


def _parse_futures_day(date_str: str, rows: list[dict]) -> dict | None:
    if not rows:
        return None

    candidates = []
    for row in rows:
        name = str(_pick(row, "ISU_NM", "PROD_NM") or "")
        compact = name.replace(" ", "")
        if "코스피200" not in compact and "KOSPI200" not in compact.upper():
            continue
        if any(word in name for word in ("국채", "달러", "미니", "위클리")):
            continue
        candidates.append(row)

    if not candidates:
        return None

    # 최근월물 = 거래량이 가장 많은 종목
    candidates.sort(
        key=lambda r: to_float(_pick(r, "ACC_TRDVOL", "TRDVOL")) or 0.0,
        reverse=True,
    )
    row = candidates[0]

    close = to_float(_pick(row, "TDD_CLSPRC", "CLSPRC"))
    if not close or close <= 0:
        return None

    # 없으면 없다고 둡니다. 0.0으로 메우면 국면 판정이 강세로 뒤집힙니다.
    reported = None
    for field in ("FLUC_RT", "FLUC_RATE", "CMPPREVDD_RT"):
        raw = row.get(field)
        if raw is not None and str(raw).strip() not in ("", "nan"):
            reported = to_float(raw)
            break

    # 거래량·미결제약정도 모르면 None입니다. 0.0으로 메우면 (1) 40일 이력 위에
    # 0이 upsert돼 확정치가 덮이고 (2) 0 - 직전 OI로 국면을 지어냅니다.
    return {
        "close": close,
        "reportedPct": reported,
        "volume": to_float(_pick(row, "ACC_TRDVOL", "TRDVOL")),
        "openInterest": to_float(_pick(row, "ACC_OPNINT_QTY", "OPNINT_QTY")),
        "contractName": str(_pick(row, "ISU_NM", "PROD_NM") or "KOSPI 200 선물"),
    }


def _contract_changed(previous: dict, row: dict) -> bool:
    """두 행의 계약(종목명)이 다른가. 어느 쪽이든 이름을 모르면 같은 계약으로 봅니다(예전 동작)."""
    before, now = previous.get("contractName"), row.get("contractName")
    return bool(before) and bool(now) and before != now


def _derive_series(rows: list[dict]) -> None:
    """등락률·OI 증감·국면·COT OI Index를 계산해 rows를 갱신합니다."""
    for index, row in enumerate(rows):
        if index == 0:
            # 첫 행은 직전 종가가 없으므로 KRX 보고값이 있으면 그것을 씁니다.
            row["changePct"] = row["changePctReported"]
            row["oiChange"] = None
        elif _contract_changed(rows[index - 1], row):
            # 근월물이 바뀐 날(만기 롤오버) — 다른 계약끼리의 종가·OI 차는 변화가 아닙니다(QA-035). 등락률은 KRX가 그
            # 계약 기준으로 보고한 값, OI 변화는 모름입니다(국면도 판정하지 않음).
            row["changePct"] = row["changePctReported"]
            row["oiChange"] = None
        else:
            previous = rows[index - 1]
            prev_close = previous["futuresClose"]
            row["changePct"] = (
                round((row["futuresClose"] / prev_close - 1) * 100.0, 4)
                if prev_close else None
            )
            prev_oi = previous["openInterest"]
            row["oiChange"] = (
                row["openInterest"] - prev_oi
                if (row["openInterest"] is not None and prev_oi is not None)
                else None
            )
        row["marketPhase"] = diagnose_phase(row["changePct"], row["oiChange"])

    # KRX 보고값과 계산값이 크게 다르면 둘 중 하나가 깨진 것입니다.
    gaps = [
        abs(row["changePct"] - row["changePctReported"])
        for row in rows
        if row["changePct"] is not None and row["changePctReported"] is not None
    ]
    big = [gap for gap in gaps if gap > 0.5]
    if big:
        logger.warning(
            "KRX 등락률(FLUC_RT)과 종가 기반 계산값이 %d일에서 0.5%%p 넘게 "
            "다릅니다. 화면은 종가 기반 계산값을 씁니다.",
            len(big),
        )

    # 한국판 선물 COT Index (최근 20일 OI 범위 내 백분위)
    window = min(20, len(rows))
    for index, row in enumerate(rows):
        start = max(0, index - window + 1)
        segment = [
            r["openInterest"] for r in rows[start: index + 1]
            if r["openInterest"] is not None
        ]
        if not segment or row["openInterest"] is None:
            row["cotOiIndex"] = None
            continue
        low, high = min(segment), max(segment)
        span = (high - low) or 1
        row["cotOiIndex"] = round((row["openInterest"] - low) / span * 100.0, 1)


def diagnose_phase(change_pct: float | None, oi_change: float | None) -> str:
    """
    4대 국면 판정.

    등락률이나 OI 증감을 모르면 어느 쪽으로도 기울이지 않습니다.
    (구버전은 결측을 0.0으로 메워 항상 '상승'으로 판정했습니다.)
    """
    if change_pct is None or oi_change is None:
        return PHASE_UNKNOWN

    price_up = change_pct >= 0
    oi_up = oi_change >= 0

    if price_up and oi_up:
        return "신규 롱 (Long Accumulation)"
    if price_up and not oi_up:
        return "숏 커버링 (Short Covering)"
    if not price_up and oi_up:
        return "신규 숏 (Short Accumulation)"
    return "롱 청산 (Long Liquidation)"


def _fallback_from_kodex(days: int) -> dict:
    """
    KRX 응답이 없을 때의 **가격 추정치**.

    KODEX 200(069500.KS) 또는 ^KS200 종가를 지수 스케일로 환산해 선물 종가를
    근사합니다. 실제 시장 가격에서 파생된 값이므로 추정치로서 의미가 있습니다.

    ⚠️ 미결제약정·베이시스는 만들어내지 않습니다(null). 구버전은 sin/linspace로
    합성했는데, 실제 OI와 무관한 숫자를 OI라고 표시하는 것은 그 자체가 오류이고
    교차 검증도 무의미해집니다.
    """
    frame = None
    last_error: str | None = None
    for symbol in ("069500.KS", "^KS200"):
        # Yahoo 공용 래치(http.YAHOO_HOST) — 다른 Yahoo 수집이 방금 429를 받았으면 묻지 않고, 여기서 받은 429는 래치를 닫습니다.
        latched = http.active_rejection(http.YAHOO_HOST)
        if latched is not None:
            last_error = str(latched)
            break
        try:
            candidate = yf.Ticker(symbol).history(period=f"{days + 30}d")
        except YFRateLimitError:
            last_error = str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)"))
            break
        except Exception as exc:  # noqa: BLE001
            logger.warning("추정치 소스 조회 실패 (%s): %s", symbol, exc)
            last_error = f"{symbol} {brief_error(exc)}"
            continue
        if candidate is not None and not candidate.empty and len(candidate) >= 5:
            frame = candidate
            break

    if frame is None:
        logger.error("KRX 선물 추정치 생성 실패: 대체 소스도 수집하지 못했습니다.")
        return {
            "isEstimated": True,
            "rows": [],
            "error": (
                "KRX 응답이 부족해 KODEX 200 추정치로 대체하려 했으나 "
                f"{last_error or '대체 소스(069500.KS/^KS200)도 비어 있습니다'}"
            ),
        }

    closes = frame["Close"].dropna()
    closes = closes[closes > 0].tail(days)
    if closes.empty:
        return {
            "isEstimated": True,
            "rows": [],
            "error": "대체 소스에 유효한 종가가 없습니다",
        }

    # KODEX 200은 지수의 약 100배 가격이라 스케일을 맞춥니다.
    scale = 0.01 if float(closes.iloc[-1]) > 1000 else 1.0

    rows: list[dict] = []
    previous_close = None
    for index, value in closes.items():
        close = round(float(value) * scale, 2)
        change_pct = (
            round((close / previous_close - 1) * 100.0, 4) if previous_close else None
        )
        rows.append({
            "date": index.strftime("%Y-%m-%d"),
            "futuresClose": close,
            "changePct": change_pct,
            "changePctReported": None,
            "volume": None,
            "openInterest": None,
            "oiChange": None,
            "theoryPrice": None,
            "marketBasis": None,
            "contractName": "KOSPI 200 최근월물 (KODEX 200 기반 추정)",
            # OI를 모르므로 국면도 판정하지 않습니다.
            "marketPhase": PHASE_UNKNOWN,
            "cotOiIndex": None,
        })
        previous_close = close

    return {"isEstimated": True, "rows": rows}


# ==============================================================================
# 3. Daum 선물 투자자별 수급 (계약수 기준)
# ==============================================================================
def collect_daum_futures_trend(lookback_days: int = 25) -> dict:
    """
    Daum '투자주체별 매매동향(선물)'의 일자별 순매수 **계약수**.

    반환 계약(JSON):
    {
      "dataDate": "YYYY-MM-DD", "measure": "CONTRACT", "unit": "계약",
      "isPlaceholder": false,
      "rows": [{"investor","netToday","net5d","net20d","stance"}]
    }
    """
    params = {
        "page": 1,
        "perPage": max(lookback_days, 20),
        "terms": "days",
        "pagination": "true",
    }

    try:
        res = get_session().get(
            DAUM_FUTURES_DAYS_URL, headers=DAUM_HEADERS, params=params, timeout=10
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Daum 선물 수급 수집 실패: %s", exc)
        return _empty_trend()

    if res.status_code != 200:
        logger.warning("Daum 선물 수급 HTTP 실패: %s", res.status_code)
        return _empty_trend()

    try:
        rows = res.json().get("data") or []
    except ValueError:
        return _empty_trend()

    if not isinstance(rows, list) or not rows:
        logger.warning("Daum 선물 수급 빈 응답 (lookback=%s)", lookback_days)
        return _empty_trend()

    # 응답은 최신 거래일이 첫 행인 DESC 순서입니다.
    today_row = rows[0]
    window_5 = rows[: min(5, len(rows))]
    window_20 = rows[: min(20, len(rows))]

    records = []
    for label, field in DAUM_INVESTOR_FIELDS:
        # 모르는 값은 0이 아니라 None입니다. 0으로 메우면 "순매수 0계약"이 되어 AI 텍스트와
        # 화면이 '거래 없음'으로 읽고, 창 합계도 실제보다 작아집니다. 창 안에 하루라도
        # 모르는 날이 있으면 그 합계도 모르는 것입니다.
        net_today = _contracts(today_row.get(field))
        net_5d = _window_sum(window_5, field)
        net_20d = _window_sum(window_20, field)

        if net_20d is None:
            stance = "⚪ 판정 불가"
        elif net_20d > 0:
            stance = "🟢 매수 우위(Long)"
        elif net_20d < 0:
            stance = "🔴 매도 우위(Short)"
        else:
            stance = "⚪ 중립"

        records.append({
            "investor": label,
            "netToday": net_today,
            "net5d": net_5d,
            "net20d": net_20d,
            "stance": stance,
        })

    return {
        "dataDate": str(today_row.get("date", ""))[:10],
        "measure": "CONTRACT",
        "unit": "계약",
        "isPlaceholder": False,
        "rows": records,
    }


def _contracts(value) -> int | None:
    """계약 수. 숫자가 아니면 None."""
    number = to_float(value)
    return None if number is None else int(number)


def _window_sum(rows: list[dict], field: str) -> int | None:
    """창 안의 합계. 하루라도 값을 모르면 None."""
    values = [_contracts(r.get(field)) for r in rows]
    if not values or any(v is None for v in values):
        return None
    return int(sum(values))


def _empty_trend() -> dict:
    return {
        "dataDate": None,
        "measure": "CONTRACT",
        "unit": "계약",
        "isPlaceholder": False,
        "rows": [],
    }


def collect_daum_intraday_acceleration(lookback_minutes: int = 30) -> dict:
    """
    Daum 시간별 선물 수급에서 최근 N분 수급 변화량(가속도)을 계산합니다.

    ⚠️ 장중 누적 수급이며, 마감 후 정산 집계로 값이 달라질 수 있습니다.
    ⚠️ Daum 내부 API 기반 비공식 데이터입니다.
    """
    default = {
        "available": False,
        "lookbackMinutes": lookback_minutes,
        "flowStatus": "시간별 수급 데이터 미제공",
        "flowStatusColor": "gray",
        "source": "Daum 금융 시간별 선물 수급 (비공식)",
        "error": None,
    }

    try:
        res = get_session().get(
            DAUM_FUTURES_TIMES_URL,
            headers=DAUM_HEADERS,
            params={"page": 1, "perPage": 500, "terms": "times", "pagination": "true"},
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        return {**default, "error": str(exc)[:200]}

    if res.status_code != 200:
        return {**default, "error": f"Daum API HTTP {res.status_code}"}

    try:
        rows = res.json().get("data") or []
    except ValueError as exc:
        return {**default, "error": f"JSON 해석 실패: {exc}"}

    parsed = []
    for row in rows:
        stamp = row.get("date")
        if not stamp:
            continue
        try:
            parsed.append((datetime.fromisoformat(str(stamp).replace("Z", "+00:00")), row))
        except ValueError:
            continue

    if not parsed:
        return {**default, "error": "유효한 시간 데이터가 없습니다."}

    parsed.sort(key=lambda item: item[0])
    latest_time, latest_row = parsed[-1]

    # 페이지 경계를 넘어 전일 데이터가 섞이지 않게 최신 거래일만 씁니다.
    same_day = [item for item in parsed if item[0].date() == latest_time.date()]
    target = latest_time - timedelta(minutes=lookback_minutes)
    earlier = [item for item in same_day if item[0] <= target]
    reference_time, reference_row = earlier[-1] if earlier else same_day[0]

    def delta(field: str) -> tuple[int | None, int | None]:
        # 빠진 값은 모르는 값입니다. 0으로 채우면 '30분 새 -1000계약' 같은 변화를 지어냅니다(QA-036).
        current = to_float(latest_row.get(field))
        before = to_float(reference_row.get(field))
        current = None if current is None else int(current)
        change = None if current is None or before is None else current - int(before)
        return current, change

    foreign_current, foreign_change = delta("foreignSettlement")
    inst_current, inst_change = delta("institutionalSettlement")
    private_current, private_change = delta("privateSettlement")
    fin_current, fin_change = delta("financialInvestment")
    pension_current, pension_change = delta("pensionFundInvestment")

    if foreign_change is None or inst_change is None:
        status, color = "수급 방향 판정 불가 (값 미제공)", "gray"
    elif foreign_change > 0 and inst_change > 0:
        status, color = "외국인·기관 동반 매수", "green"
    elif foreign_change < 0 and inst_change < 0:
        status, color = "외국인·기관 동반 매도", "red"
    elif foreign_change > 0 and inst_change < 0:
        status, color = "외국인 매수 · 기관 매도", "blue"
    elif foreign_change < 0 and inst_change > 0:
        status, color = "외국인 매도 · 기관 매수", "orange"
    else:
        status, color = "수급 방향 중립 또는 혼조", "gray"

    return {
        "available": True,
        "dataDate": latest_time.strftime("%Y-%m-%d"),
        "latestTime": latest_time.strftime("%H:%M"),
        "referenceTime": reference_time.strftime("%H:%M"),
        "lookbackMinutes": lookback_minutes,
        "foreignCurrent": foreign_current, "foreignChange": foreign_change,
        "institutionCurrent": inst_current, "institutionChange": inst_change,
        "privateCurrent": private_current, "privateChange": private_change,
        "financialCurrent": fin_current, "financialChange": fin_change,
        "pensionCurrent": pension_current, "pensionChange": pension_change,
        "flowStatus": status,
        "flowStatusColor": color,
        "source": "Daum 금융 시간별 선물 수급 (비공식)",
        "error": None,
    }


# ==============================================================================
# 내부 헬퍼
# ==============================================================================
def _pick(row: dict, *names: str):
    """대소문자가 섞인 KRX 응답에서 필드를 찾습니다."""
    upper = {str(k).upper(): v for k, v in row.items()}
    for name in names:
        if name in row:
            return row[name]
        if name.upper() in upper:
            return upper[name.upper()]
    return None
