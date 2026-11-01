"""
app/services/kis.py
한국투자증권(KIS) Open API 통신.

[지켜야 할 것]
- **실패한 토큰은 캐시하지 않습니다.** 구버전은 발급 실패 시의 빈 문자열까지
  6시간 캐시해서, 키를 고쳐도 앱을 재시작하기 전까지 계속 실패했습니다.
  "무엇을 고쳐도 안 되는" 상태가 되므로 성공한 토큰만 캐시합니다.
- 장중 가집계 TR(FHPTJ04400000)은 **장 마감 후에는 빈 데이터를 정상적으로**
  돌려줍니다. 이것은 오류가 아니며, 진단 메시지가 둘을 구분해야 합니다.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

from ..numbers import to_float
from .. import http, settings
from .. import kst

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")

TR_INDEX_PRICE = "FHPUP02100000"      # 업종 지수 시세
TR_FUTURES_PRICE = "FHMIF10000000"    # 국내 선물옵션 시세
TR_INVESTOR_TOTAL = "FHPTJ04400000"   # 외국인·기관 매매종목 가집계 (장중 전용)

INDEX_CODE_KOSPI = "0001"
INDEX_CODE_KOSPI200 = "2001"

# FHPTJ04400000 요청 코드 — 공식 예제(koreainvestment/open-trading-api,
# examples_llm/domestic_stock/foreign_institution_total)의 명세 그대로입니다(QA-074).
#   FID_INPUT_ISCD 0000 전체 · 0001 코스피 · 1001 코스닥 / FID_DIV_CLS_CODE 0 수량 · 1 금액
#   FID_RANK_SORT_CLS_CODE 0 순매수상위 · 1 순매도상위 / FID_ETC_CLS_CODE 0 전체 · 1 외국인 · 2 기관계 · 3 기타
# 예전에는 KOSPI에 0000(전체 시장)을 보내 KOSDAQ 종목이 KOSPI 레이더에 섞였습니다. 응답 행에는 시장 필드가
# 없어 받은 뒤에는 거를 수 없으므로 요청에서 맞춰야 합니다.
DEAL_MARKET_CODES = {"KOSPI": "0001", "KOSDAQ": "1001"}
DEAL_AMOUNT_SORT = "1"
DEAL_RANK_SORT = {"순매수": "0", "순매도": "1"}
# 투자자 구분 코드가 있는 투자주체만 지원합니다. 투신·은행 등은 코드가 없어 '전체 투자자' 순위를 받아
# 그 투자주체 금액으로 다시 거르게 되는데, 그 순위 밖의 종목은 빠집니다 — 부르지 않고 빈 결과로 둡니다.
DEAL_INVESTOR_CODES = {"외국인": "1", "기관": "2"}

# 토큰 수명은 24시간이지만 여유를 두고 6시간마다 재발급합니다.
_TOKEN_TTL_SECONDS = 6 * 60 * 60

_token_lock = threading.Lock()
_token_cache: dict[str, tuple[str, float]] = {}

# 투자자별 순매수 필드 (FHPTJ04400000 응답)
INVESTOR_FIELDS = {
    "외국인": {"quantity": "frgn_ntby_qty", "amount": "frgn_ntby_tr_pbmn"},
    "기관": {"quantity": "orgn_ntby_qty", "amount": "orgn_ntby_tr_pbmn"},
    "투신": {"quantity": "ivtr_ntby_qty", "amount": "ivtr_ntby_tr_pbmn"},
    "은행": {"quantity": "bank_ntby_qty", "amount": "bank_ntby_tr_pbmn"},
    "보험": {"quantity": "insu_ntby_qty", "amount": "insu_ntby_tr_pbmn"},
    "종금": {"quantity": "mrbn_ntby_qty", "amount": "mrbn_ntby_tr_pbmn"},
    "기금": {"quantity": "fund_ntby_qty", "amount": "fund_ntby_tr_pbmn"},
    "기타기관": {"quantity": "etcorgt_ntby_vol", "amount": "etcorgt_ntby_tr_pbmn"},
    "기타법인": {"quantity": "etccorp_ntby_vol", "amount": "etccorp_ntby_tr_pbmn"},
}


def _http() -> requests.Session:
    """이 클라이언트 전용 세션 — 연결만 재사용합니다(재시도·쿠키 없음, app/http.py)."""
    return http.get_api_session("kis")


def has_credentials() -> bool:
    app_key, app_secret = settings.kis_credentials()
    return bool(app_key and app_secret)


def get_access_token() -> str:
    """성공한 토큰만 캐시합니다. 실패는 다음 호출에서 즉시 재시도됩니다."""
    app_key, app_secret = settings.kis_credentials()
    if not app_key or not app_secret:
        return ""

    cache_key = f"{app_key[:8]}:{app_secret[:8]}"
    with _token_lock:
        cached = _token_cache.get(cache_key)
        if cached and cached[1] > time.time():
            return cached[0]

    token = _request_token(app_key, app_secret)
    if token:
        with _token_lock:
            _token_cache[cache_key] = (token, time.time() + _TOKEN_TTL_SECONDS)
    return token


def _request_token(app_key: str, app_secret: str) -> str:
    try:
        res = _http().post(
            f"{settings.KIS_BASE_URL}/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": app_key,
                "appsecret": app_secret,
            },
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("KIS 토큰 발급 예외: %s", exc)
        return ""

    if res.status_code != 200:
        logger.warning("KIS 토큰 발급 거절 (%s): %s", res.status_code, res.text[:200])
        return ""

    try:
        return res.json().get("access_token", "")
    except ValueError:
        return ""


def call_api(tr_id: str, endpoint: str, params: dict) -> dict:
    """KIS GET 공통 호출기. 실패도 구조화된 dict로 돌려줍니다."""
    app_key, app_secret = settings.kis_credentials()
    if not app_key or not app_secret:
        return {"rt_cd": "-1", "msg1": "KIS app_key / app_secret이 설정되지 않았습니다."}

    token = get_access_token()
    if not token:
        return {
            "rt_cd": "-1",
            "msg1": (
                "KIS OAuth2 토큰 발급 실패 "
                "(키가 유효하지 않거나 실전/모의 서버가 불일치합니다)"
            ),
        }

    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": f"Bearer {token}",
        "appkey": app_key,
        "appsecret": app_secret,
        "tr_id": tr_id,
        "custtype": "P",
    }

    try:
        res = _http().get(
            f"{settings.KIS_BASE_URL}{endpoint}",
            headers=headers,
            params=params,
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("KIS API (%s) 호출 실패: %s", tr_id, exc)
        return {"rt_cd": "-1", "msg1": f"서버 통신 예외: {exc}"}

    if res.status_code == 200:
        try:
            return res.json()
        except ValueError:
            return {"rt_cd": "-1", "msg1": "응답을 JSON으로 읽지 못했습니다."}

    try:
        message = res.json().get("msg1", f"HTTP {res.status_code}")
    except ValueError:
        message = f"HTTP {res.status_code}"
    return {"rt_cd": "-1", "msg1": message}


# ==============================================================================
# 교차 검증용 조회
# ==============================================================================
def fetch_index_close(index_code: str = INDEX_CODE_KOSPI200) -> dict:
    """KIS 업종 지수 현재가. 반환: {ok, value, detail}"""
    res = call_api(
        tr_id=TR_INDEX_PRICE,
        endpoint="/uapi/domestic-stock/v1/quotations/inquire-index-price",
        params={"FID_COND_MRKT_DIV_CODE": "U", "FID_INPUT_ISCD": index_code},
    )
    if not res or res.get("rt_cd") != "0":
        return {"ok": False, "value": None, "detail": (res or {}).get("msg1", "응답 없음")}

    value = _to_float((res.get("output") or {}).get("bstp_nmix_prpr"))
    if value is None:
        return {
            "ok": False,
            "value": None,
            "detail": "응답에 지수 현재가(bstp_nmix_prpr)가 없습니다.",
        }
    return {"ok": True, "value": value, "detail": f"업종코드 {index_code}"}


def fetch_kospi200_futures() -> dict:
    """
    KIS 국내 선물 시세(코스피200 최근월물).

    종목코드는 최근월물 연속 코드 "101000"을 씁니다. 월물이 바뀌어도 코드를
    갱신할 필요가 없습니다.
    """
    symbol = "101000"
    res = call_api(
        tr_id=TR_FUTURES_PRICE,
        endpoint="/uapi/domestic-futureoption/v1/quotations/inquire-price",
        params={"FID_COND_MRKT_DIV_CODE": "F", "FID_INPUT_ISCD": symbol},
    )

    if not res or res.get("rt_cd") != "0":
        return {
            "ok": False, "value": None, "openInterest": None,
            "symbol": symbol, "detail": (res or {}).get("msg1", "응답 없음"),
        }

    output = res.get("output1") or res.get("output") or {}
    if isinstance(output, list):
        output = output[0] if output else {}

    price = _to_float(output.get("futs_prpr"))
    open_interest = _to_float(output.get("hts_otst_stpl_qty"))

    if price is None:
        return {
            "ok": False, "value": None, "openInterest": None, "symbol": symbol,
            "detail": (
                "응답에 선물 현재가(futs_prpr)가 없습니다. "
                f"받은 필드: {sorted(output)[:12]}"
            ),
        }

    return {
        "ok": True,
        "value": price,
        "openInterest": int(open_interest) if open_interest else None,
        "symbol": symbol,
        "detail": f"종목코드 {symbol} (최근월물)",
    }


# ==============================================================================
# 장중 수급 가집계 (수급 레이더 1순위 소스)
# ==============================================================================
def fetch_deal_ranking(
    target_date: str,
    market: str,
    investor: str,
    trade_type: str,
    top_n: int,
) -> list[dict]:
    """
    FHPTJ04400000 장중 외국인·기관 가집계 Top N.

    주의: 장중 가집계이며 KRX 장마감 확정치와 다를 수 있습니다.
    주의: 이 TR은 당일 데이터만 조회합니다. 장 마감 후에는 정상적으로 빈 결과입니다.
    """
    field_map = INVESTOR_FIELDS.get(investor)
    investor_code = DEAL_INVESTOR_CODES.get(investor)
    if field_map is None or investor_code is None:
        logger.warning("KIS 가집계 미지원 투자주체: %s", unsupported_reason(investor))
        return []

    is_kospi = "KOSPI" in market.upper() or "코스피" in market
    issue_code = DEAL_MARKET_CODES["KOSPI" if is_kospi else "KOSDAQ"]

    base_params = {
        "FID_COND_SCR_DIV_CODE": "16449",
        "FID_INPUT_ISCD": issue_code,
        "FID_DIV_CLS_CODE": DEAL_AMOUNT_SORT,
        "FID_RANK_SORT_CLS_CODE": DEAL_RANK_SORT["순매수" if trade_type == "순매수" else "순매도"],
        "FID_ETC_CLS_CODE": investor_code,
    }

    rows: list[dict] = []
    for division in ("V", "J"):
        res = call_api(
            tr_id=TR_INVESTOR_TOTAL,
            endpoint="/uapi/domestic-stock/v1/quotations/foreign-institution-total",
            params={**base_params, "FID_COND_MRKT_DIV_CODE": division},
        )
        if res and res.get("rt_cd") == "0":
            candidate = res.get("output") or []
            if isinstance(candidate, list) and candidate:
                rows = candidate
                break
        if res:
            logger.warning("KIS 가집계 실패 (%s): %s", division, res.get("msg1"))

    if not rows:
        return []

    collected_at = kst.stamp()
    records: list[dict] = []

    for row in rows:
        code = str(row.get("stck_shrn_iscd") or row.get("mksc_shrn_iscd") or "").strip()
        name = str(row.get("hts_kor_isnm") or "").strip()
        if not code or not name:
            continue

        # 모르는 가격·등락률은 None입니다. 0.0이면 '0원·보합'으로 저장본과 이력에 남습니다(QA-036).
        price = _to_float(row.get("stck_prpr"))
        change_pct = _to_float(row.get("prdy_ctrt"))
        net_amount_raw = _to_float(row.get(field_map["amount"])) or 0.0
        net_quantity = _to_float(row.get(field_map["quantity"])) or 0.0

        if net_amount_raw:
            net_eok = net_amount_raw / 100.0
            basis = "KIS 원본 순매수 거래대금"
        elif net_quantity and price and price > 0:
            net_eok = (net_quantity * price) / 100_000_000.0
            basis = "KIS 원본 순매수 수량×현재가 환산"
        else:
            continue

        if trade_type == "순매수" and net_eok <= 0:
            continue
        if trade_type == "순매도" and net_eok >= 0:
            continue

        records.append({
            "code": code.zfill(6),      # 앞자리 0 보존 — 문자열로만 다룹니다
            "name": name,
            "price": price,
            "changePct": change_pct,
            "netAmountEok": round(net_eok, 1),
            "amountBasis": basis,
            "collectedAt": collected_at,
            "source": f"KIS 장중 가집계 / {TR_INVESTOR_TOTAL} ({target_date})",
        })

    if not records:
        logger.warning(
            "KIS 가집계 파싱 결과 없음: 시장=%s, 투자주체=%s, 방향=%s",
            market, investor, trade_type,
        )
        return []

    records.sort(
        key=lambda r: r["netAmountEok"],
        reverse=(trade_type == "순매수"),
    )
    top = records[:top_n]
    for index, record in enumerate(top, start=1):
        record["rank"] = index
    return top


def unsupported_reason(investor: str) -> str | None:
    """가집계가 이 투자주체를 주지 않으면 그 사유(화면·로그용), 주면 None."""
    if investor in DEAL_INVESTOR_CODES:
        return None
    return f"KIS 장중 가집계는 '{investor}' 구분이 없습니다 (외국인·기관계만)"


def test_connection() -> dict:
    """
    연결 진단. 화면이 실제로 쓰는 경로(가집계 TR)를 그대로 호출합니다.

    진단이 다른 경로를 보면 "진단은 정상인데 화면은 빈" 상황을 설명할 수
    없습니다. 구버전에서 실제로 겪었던 문제입니다.
    """
    if not has_credentials():
        return {
            "ok": False,
            "stage": "no_keys",
            "message": "KIS app_key / app_secret이 설정되지 않았습니다.",
        }

    if not get_access_token():
        return {
            "ok": False,
            "stage": "rejected",
            "message": "OAuth2 토큰 발급이 거절됐습니다. 앱키·시크릿과 실전/모의 서버를 확인하세요.",
        }

    rows = fetch_deal_ranking(
        datetime.now(KST).strftime("%Y%m%d"), "KOSPI", "외국인", "순매수", 5,
    )
    if rows:
        return {
            "ok": True,
            "stage": "ok",
            "message": f"인증 성공 · 가집계 {len(rows)}건 수신",
            "sample": rows[:3],
        }

    return {
        "ok": True,
        "stage": "authenticated_empty",
        "message": (
            "인증 성공 · 조회 데이터 없음. 가집계 TR은 장중 전용이라 "
            "정규장(09:00~15:30)이 아니면 빈 결과가 정상입니다."
        ),
    }


def _to_float(value) -> float | None:
    """KIS는 모르는 값을 0으로 줍니다 — 0도 None으로 봅니다(원래 동작 유지). 해석 규칙은 app/numbers."""
    return to_float(value) or None
