"""
app/services/toss.py
토스증권 Open API — 연결 진단 + 국내 투자자별 매매동향.

쓰는 곳
  - 🔌 외부 API 연결 테스트 (진단·환율·지수)
  - 📡 수급 레이더 / 🇰🇷 국내 파생: 투자자별 매매 (공식 스펙 1.2.13부터 제공)
      GET /api/v1/market-indicators/{KOSPI|KOSDAQ}/investor-trading  시장 전체 매매**대금**(원)
      GET /api/v1/stocks/{symbol}/investor-trading                    종목별 매매**거래량**(주)
  - 🧪 모의 매매 한국 책(v2 2단계 B4): 종목 봉과 종목 상태
      GET /api/v1/candles?symbol=&interval=1d|1m&count=&before=&adjusted=  일봉·1분봉(최신순, 한 번에 200개, before로 과거 쪽)
      GET /api/v1/stocks?symbols=                                          종목 유형·NXT 거래 여부·KRX 정지·상장일(200개씩)

토스 API에 **없는 것** — 선물·옵션·미결제약정. 파생 수치는 계속 KRX·Daum에서 받습니다.
(공식 스펙 1.2.17의 시장 지표 심볼 카탈로그는 KOSPI·KOSDAQ·국채 6종뿐입니다.)

주의사항
  - client 하나에 유효한 토큰은 1개이고 재발급하면 이전 토큰이 즉시 무효가 됩니다
    (공식 스펙). 그래서 토큰은 이 모듈 한 곳에서만 발급·캐시하고, 401을 받으면
    한 번만 재발급해 다시 시도합니다. 같은 키를 다른 프로그램에서도 쓰면 서로의
    토큰을 무효화합니다.
  - 금액·수량은 정밀도 보존을 위해 **문자열 정수**로 옵니다("-291850").
  - 당일 잠정 기록은 개인·기관 세부·기타법인이 null입니다. **null을 0으로 바꾸지
    않습니다** — "개인 순매수 0"은 "모름"과 정반대의 신호입니다.
  - 오류 문구에 client_secret·토큰이 섞이지 않게 합니다(토큰은 헤더로만 보냄).
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

from ..numbers import to_float, to_int
from .. import http, settings

logger = logging.getLogger(__name__)

BASE_URL = "https://openapi.tossinvest.com"
AUTH_URL = f"{BASE_URL}/oauth2/token"

_lock = threading.Lock()
# 발급 자체를 한 번에 하나로 묶습니다. client당 유효 토큰이 1개라, 두 곳이 동시에 발급하면
# 먼저 받은 쪽 토큰이 즉시 무효가 됩니다(연결 테스트와 수집 태스크가 겹칠 때).
_issue_lock = threading.Lock()
_token_cache: tuple[str, float] | None = None


def _http() -> requests.Session:
    """이 클라이언트 전용 세션 — 연결만 재사용합니다(재시도·쿠키 없음, app/http.py)."""
    return http.get_api_session("toss")


def has_credentials() -> bool:
    client_id, client_secret = settings.toss_credentials()
    return bool(client_id and client_secret)


def get_access_token() -> tuple[str | None, str | None]:
    """(토큰, 오류 메시지). 성공한 토큰만 캐시합니다."""
    with _lock:
        if _token_cache and _token_cache[1] > time.time():
            return _token_cache[0], None

    with _issue_lock:
        # 기다리는 동안 다른 쪽이 이미 발급했으면 그 토큰을 씁니다.
        with _lock:
            if _token_cache and _token_cache[1] > time.time():
                return _token_cache[0], None
        return _issue_token()


def _issue_token() -> tuple[str | None, str | None]:
    global _token_cache
    client_id, client_secret = settings.toss_credentials()
    if not client_id or not client_secret:
        return None, "[toss] client_id / client_secret이 설정되지 않았습니다."

    try:
        res = _http().post(
            AUTH_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=8,
        )
        res.raise_for_status()
        payload = res.json()
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        body = exc.response.text[:300] if exc.response is not None else ""
        return None, f"HTTP {status} 오류: {body}"
    except Exception as exc:  # noqa: BLE001
        return None, f"토큰 발급 실패: {exc}"

    token = payload.get("access_token")
    if not token:
        return None, f"토큰 응답에 access_token이 없습니다: {payload}"

    expires_in = int(payload.get("expires_in", 3600))
    with _lock:
        _token_cache = (token, time.time() + max(60, expires_in - 60))
    return token, None


def test_connection() -> dict:
    token, error = get_access_token()
    if not token:
        return {"ok": False, "stage": "token", "message": error}

    try:
        res = _http().get(
            f"{BASE_URL}/api/v1/exchange-rate",
            headers={"Authorization": f"Bearer {token}"},
            params={"baseCurrency": "USD", "quoteCurrency": "KRW"},
            timeout=8,
        )
    except requests.Timeout:
        return {"ok": False, "stage": "network", "message": "요청 시간 초과(8초)"}
    except requests.ConnectionError as exc:
        return {"ok": False, "stage": "network", "message": f"연결 실패: {exc}"}

    if res.status_code == 403:
        return {
            "ok": False, "stage": "forbidden",
            "message": "HTTP 403 — 허용 IP 목록에 현재 IP가 없을 수 있습니다.",
        }
    if res.status_code == 400:
        return {
            "ok": False, "stage": "bad_request",
            "message": f"HTTP 400 — 요청 파라미터 오류: {res.text[:200]}",
        }
    if res.status_code != 200:
        return {
            "ok": False, "stage": "http_error",
            "message": f"HTTP {res.status_code}: {res.text[:200]}",
        }

    try:
        data = res.json()
    except ValueError:
        return {"ok": False, "stage": "bad_response", "message": "JSON 해석 실패"}

    return {
        "ok": True, "stage": "ok",
        "message": "연결 성공",
        "sample": data,
    }


def get_exchange_rate(base: str = "USD", quote: str = "KRW") -> dict:
    token, error = get_access_token()
    if not token:
        return {"ok": False, "error": error}

    try:
        res = _http().get(
            f"{BASE_URL}/api/v1/exchange-rate",
            headers={"Authorization": f"Bearer {token}"},
            params={"baseCurrency": base, "quoteCurrency": quote},
            timeout=8,
        )
        res.raise_for_status()
        return {"ok": True, "data": res.json()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:300]}


def get_index_prices(symbols: list[str]) -> dict:
    token, error = get_access_token()
    if not token:
        return {"ok": False, "error": error}

    try:
        res = _http().get(
            f"{BASE_URL}/api/v1/market-indicators/prices",
            headers={"Authorization": f"Bearer {token}"},
            params={"symbols": ",".join(symbols)},
            timeout=8,
        )
        res.raise_for_status()
        return {"ok": True, "data": res.json()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:300]}


# ==============================================================================
# 공통 GET — 401 재발급·429 대기
# ==============================================================================
class TossError(RuntimeError):
    """토스 API 호출 실패. 메시지에는 비밀값이 없습니다(상태 화면에 그대로 나갑니다)."""


class TossMissingKey(TossError):
    """TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 미설정."""


class TossForbidden(TossError):
    """403 — 허용 IP 목록 문제일 가능성이 높습니다. 같은 실행에서 더 부르지 않습니다."""


def _invalidate_token(failed: str | None = None) -> None:
    """
    캐시한 토큰을 버립니다.

    :param failed: 401을 받은 토큰. 주면 **그 토큰일 때만** 버립니다 — 다른 쪽이 방금
                   재발급한 새 토큰까지 버리면 서로 무효화를 반복합니다
    """
    global _token_cache
    with _lock:
        if failed is None or (_token_cache and _token_cache[0] == failed):
            _token_cache = None


def _error_text(res: requests.Response) -> str:
    try:
        err = (res.json() or {}).get("error") or {}
        code, message = err.get("code") or "", err.get("message") or ""
        return f"HTTP {res.status_code} {code} {message}".strip()
    except ValueError:
        return f"HTTP {res.status_code}"


def api_get(path: str, params: dict | None = None, timeout: float = 10.0) -> dict | list:
    """
    인증이 필요한 GET 한 번. 응답 envelope의 ``result``를 돌려줍니다.

    :raises TossMissingKey: 키 미설정 (호출하지 않음)
    :raises TossForbidden: 403
    :raises TossError: 그 밖의 실패
    """
    if not has_credentials():
        raise TossMissingKey("TOSS_CLIENT_ID / TOSS_CLIENT_SECRET이 설정되지 않았습니다")

    for attempt in range(3):
        token, error = get_access_token()
        if not token:
            raise TossError(f"토큰 발급 실패 — {error}")
        try:
            res = _http().get(
                f"{BASE_URL}{path}", headers={"Authorization": f"Bearer {token}"},
                params=params, timeout=timeout,
            )
        except requests.RequestException as exc:
            raise TossError(f"연결 실패: {type(exc).__name__}") from None

        if res.status_code == 401 and attempt == 0:
            _invalidate_token(token)  # 다른 곳에서 재발급해 무효가 됐을 수 있습니다 — 한 번만 다시
            continue
        if res.status_code == 429 and attempt < 2:
            try:
                wait = float(res.headers.get("Retry-After", "1"))
            except ValueError:
                wait = 1.0
            time.sleep(min(max(wait, 0.5), 5.0))
            continue
        if res.status_code == 403:
            raise TossForbidden(f"{_error_text(res)} — 토스 개발자 콘솔의 허용 IP에 이 맥의 공인 IP가 있는지 확인하세요")
        if res.status_code != 200:
            raise TossError(_error_text(res))
        try:
            return (res.json() or {}).get("result")
        except ValueError:
            raise TossError("JSON이 아닌 응답") from None
    raise TossError("재시도 한도 초과 (401/429)")


# ==============================================================================
# 투자자별 매매 — 정규화
# ==============================================================================
MARKET_SYMBOLS = ("KOSPI", "KOSDAQ")
INVESTORS = ("foreigner", "institution", "individual", "otherCorporation")
INSTITUTION_BREAKDOWN = (
    "pensionFund", "financialInvestment", "trust", "privateEquityFund",
    "insurance", "bank", "otherFinancialInstitution",
)


def _amounts(node) -> dict | None:
    """{buyAmount, sellAmount} → {buy, sell, net}. 노드가 없으면 None."""
    if not isinstance(node, dict):
        return None
    buy, sell = to_int(node.get("buyAmount")), to_int(node.get("sellAmount"))
    return {"buy": buy, "sell": sell, "net": buy - sell if buy is not None and sell is not None else None}


def _volumes(node) -> dict | None:
    """{buyVolume, sellVolume, netBuyVolume} → {buy, sell, net}. 노드가 없으면 None."""
    if not isinstance(node, dict):
        return None
    buy, sell = to_int(node.get("buyVolume")), to_int(node.get("sellVolume"))
    net = to_int(node.get("netBuyVolume"))
    if net is None and buy is not None and sell is not None:
        net = buy - sell
    return {"buy": buy, "sell": sell, "net": net}


def normalize_market_record(rec: dict) -> dict:
    """시장 투자자별 매매대금 기록 한 건 (금액 단위: 원)."""
    institution = rec.get("institution") or {}
    breakdown = institution.get("breakdown") if isinstance(institution, dict) else None
    return {
        "date": str(rec.get("date") or "")[:10] or None,
        "updatedAt": rec.get("updatedAt"),
        "investors": {key: _amounts(rec.get(key)) for key in INVESTORS},
        "breakdown": (
            {key: _amounts(breakdown.get(key)) for key in INSTITUTION_BREAKDOWN}
            if isinstance(breakdown, dict) else None
        ),
    }


def normalize_stock_record(rec: dict) -> dict:
    """종목 투자자별 매매동향 기록 한 건 (수량 단위: 주)."""
    institution = rec.get("institution") or {}
    breakdown = institution.get("breakdown") if isinstance(institution, dict) else None
    holding = rec.get("foreignerHolding")
    return {
        "date": str(rec.get("date") or "")[:10] or None,
        "updatedAt": rec.get("updatedAt"),
        "investors": {key: _volumes(rec.get(key)) for key in INVESTORS},
        "breakdown": (
            {key: _volumes(breakdown.get(key)) for key in INSTITUTION_BREAKDOWN}
            if isinstance(breakdown, dict) else None
        ),
        "foreignerHoldingRate": to_float(holding.get("holdingRate")) if isinstance(holding, dict) else None,
    }


def fetch_market_investor_trading(symbol: str, count: int = 30, interval: str = "1d") -> list[dict]:
    """코스피·코스닥 전체의 투자자별 매매대금 (최신순)."""
    if symbol not in MARKET_SYMBOLS:
        raise ValueError(f"지원하지 않는 시장: {symbol}")
    result = api_get(
        f"/api/v1/market-indicators/{symbol}/investor-trading",
        {"interval": interval, "count": min(max(count, 1), 100)},
    ) or {}
    return [normalize_market_record(r) for r in (result.get("records") or []) if isinstance(r, dict)]


def fetch_stock_investor_trading(code: str, count: int = 20) -> list[dict]:
    """국내 종목 하나의 일별 투자자별 매매동향 (최신순)."""
    result = api_get(
        f"/api/v1/stocks/{code}/investor-trading", {"count": min(max(count, 1), 100)},
    ) or {}
    return [normalize_stock_record(r) for r in (result.get("records") or []) if isinstance(r, dict)]


# ==============================================================================
# 수급 레이더 폴백용 — 거래대금 상위 종목 (공식 랭킹 + 종목 정보)
# ==============================================================================
def fetch_trading_amount_leaders(count: int = 100) -> list[dict]:
    """
    국내 시장 거래대금 상위 종목 (당일 기준, 시장 전체 집계).

    토스에는 **투자자별 순매수 순위** API가 없습니다. 레이더 폴백은 이 목록을 대상 종목으로
    삼아 종목별 투자자 매매로 순위를 매깁니다 — 그래서 "시장 전체 순위"가 아니라
    "거래대금 상위 N종목 안의 순위"입니다.

    :returns: [{code, lastPrice, changePct}] 순위 순. changeRate(소수 비율)는 %로 바꿉니다
    """
    result = api_get("/api/v1/rankings", {
        "type": "MARKET_TRADING_AMOUNT", "marketCountry": "KR",
        "duration": "1d", "count": min(max(count, 1), 100),
    }) or {}
    out = []
    for row in result.get("rankings") or []:
        if not isinstance(row, dict) or not row.get("symbol"):
            continue
        price = row.get("price") or {}
        rate = to_float(price.get("changeRate"))
        out.append({
            "code": str(row["symbol"]),
            "lastPrice": to_float(price.get("lastPrice")),
            "changePct": round(rate * 100, 2) if rate is not None else None,
        })
    return out


STOCK_INFO_MAX_SYMBOLS = 200   # /api/v1/stocks 한 번에 묻는 종목 수 상한(공식 스펙)


def fetch_stock_infos(codes: list[str]) -> dict[str, dict]:
    """
    종목명·시장(KOSPI/KOSDAQ)·종목 유형과 한국 시장 상태. 최대 200개를 한 번에(넘는 몫은 묻지 않음 — 부르는 쪽이 나눔).

    한국 상태(``koreanMarketDetail``)는 모의 매매 한국 책이 씁니다(v2 2단계 B4): ``nxtSupported``(NXT 거래 종목 — 토스 일봉이
    KRX+NXT 통합가), ``krxTradingSuspended``(KRX 매매정지), ``listDate``·``status``. 참·거짓이 아니거나 없으면 None(모름)입니다.
    """
    if not codes:
        return {}
    result = api_get("/api/v1/stocks", {"symbols": ",".join(codes[:STOCK_INFO_MAX_SYMBOLS])}) or []
    out: dict[str, dict] = {}
    for item in result:
        if not isinstance(item, dict) or not item.get("symbol"):
            continue
        detail = item.get("koreanMarketDetail") if isinstance(item.get("koreanMarketDetail"), dict) else {}
        out[str(item["symbol"])] = {
            "name": item.get("name"), "market": item.get("market"), "securityType": item.get("securityType"),
            "nxtSupported": _flag(detail.get("nxtSupported")),
            "krxTradingSuspended": _flag(detail.get("krxTradingSuspended")),
            "listDate": str(item["listDate"])[:10] if item.get("listDate") else None,
            "status": item.get("status"),
        }
    return out


def _flag(value) -> bool | None:
    return value if isinstance(value, bool) else None


# ==============================================================================
# 종목 봉 — 모의 매매 한국 책의 관측치·이력 (v2 2단계 B4, 명세 §4-1·§9 'paper.kr.quotes 계약')
# ==============================================================================
KST = ZoneInfo("Asia/Seoul")
CANDLE_MAX_COUNT = 200   # 한 번에 받는 봉 수 상한(공식 스펙 1.2.24 count 1~200)


def candle_time(stamp) -> datetime | None:
    """
    봉 ``timestamp`` → KST 시각. 읽을 수 없거나 시간대가 없으면 None.

    [확인] 2026-10-26 실제 응답은 ``2026-10-26T00:00:00.000+09:00``(일봉 = 거래일 KST 자정, 1분봉 = 봉 **끝** 시각)입니다. 앞 10자를
    날짜로 자르지 않고 시간대까지 읽어 KST로 옮깁니다 — UTC 표기로 와도 거래일이 하루 밀리지 않게.
    """
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(KST) if parsed.tzinfo else None


def _positive(value) -> float | None:
    number = to_float(value)
    return number if number is not None and number > 0 else None


def normalize_candle(rec) -> dict | None:
    """
    봉 하나 → ``{date, time, open, high, low, close, volume}``(날짜·시각은 KST, 시각은 HH:MM). 숫자는 문자열로 옵니다.

    가격은 양수만(아니면 None), 거래량은 0 이상 정수만(아니면 None — 0은 '그 봉에 체결 없음', 정지일 일봉은 거래량 0·시고저종 =
    전일 종가로 옵니다). 시각이나 종가를 읽을 수 없는 봉은 None(버림 — 날짜를 짐작하거나 0원 가격을 만들지 않음).
    """
    if not isinstance(rec, dict):
        return None
    at = candle_time(rec.get("timestamp"))
    close = _positive(rec.get("closePrice"))
    if at is None or close is None:
        return None
    volume = to_int(rec.get("volume"))
    return {
        "date": at.date().isoformat(), "time": at.strftime("%H:%M"),
        "open": _positive(rec.get("openPrice")), "high": _positive(rec.get("highPrice")),
        "low": _positive(rec.get("lowPrice")), "close": close,
        "volume": volume if volume is not None and volume >= 0 else None,
    }


def fetch_candles(symbol: str, interval: str, count: int, *, adjusted: bool,
                  before: str | None = None) -> tuple[list[dict], str | None]:
    """
    종목 하나의 봉(``GET /api/v1/candles``, 그룹 MARKET_DATA_CHART — [확인] 초당 20).

    :param interval: ``1d``(일봉) 또는 ``1m``(1분봉)
    :param count: 1~200(넘으면 200)
    :param adjusted: 수정주가 여부 — **기본값에 기대지 않고 늘 보냅니다**(토스 기본은 true = 수정주가, 장부는 false = 원시가).
        requests는 파이썬 bool을 'True'로 보내므로 소문자 문자열로 바꿉니다
    :param before: 이 시각 이하의 봉만(ISO 8601, 포함). 없으면 최신부터
    :returns: (정규화한 봉 — 최신순 그대로, 읽을 수 없는 봉은 뺌, 다음 쪽 ``nextBefore`` — 없으면 None)
    :raises TossMissingKey · TossForbidden · TossError: :func:`api_get`과 같음
    """
    if interval not in ("1d", "1m"):
        raise ValueError(f"지원하지 않는 봉 간격: {interval}")
    params = {"symbol": symbol, "interval": interval, "count": min(max(int(count), 1), CANDLE_MAX_COUNT),
              "adjusted": "true" if adjusted else "false"}
    if before:
        params["before"] = before
    result = api_get("/api/v1/candles", params) or {}
    if not isinstance(result, dict):
        raise TossError("봉 응답 형식이 다릅니다(result가 객체가 아님)")
    candles = [normalize_candle(rec) for rec in (result.get("candles") or [])]
    next_before = result.get("nextBefore")
    return [c for c in candles if c is not None], (str(next_before) if next_before else None)


# ==============================================================================
# 교차 검증용 읽기 — 판정은 백엔드(VerificationService)가 합니다
# ==============================================================================
def verification_reading(fetch, label: str) -> dict:
    """
    검증용 읽기 한 건을 ``{ok, value, asOf, detail}``로 감쌉니다.

    키가 없거나 호출이 실패하면 ok=False와 사유를 돌려줍니다. 예외를 올리지 않는 이유는
    한 출처의 실패가 다른 항목의 대조까지 막으면 안 되기 때문입니다.
    """
    if not has_credentials():
        return {"ok": False, "value": None, "detail": "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET이 없습니다."}
    try:
        return fetch()
    except TossError as exc:
        return {"ok": False, "value": None, "detail": f"{label} — {exc}"[:300]}
    except Exception as exc:  # noqa: BLE001 — 예상 못 한 응답 형식
        return {"ok": False, "value": None, "detail": f"{label} — 응답 해석 실패: {type(exc).__name__}"}


def fetch_index_daily_close(symbol: str = "KOSPI") -> dict:
    """
    시장 지표(코스피·코스닥) 일봉의 최신 종가.

    캔들은 최신순이고 ``timestamp``는 봉 시작 시각이라, 앞 10자리가 곧 기준 거래일입니다.
    장중에는 첫 봉이 아직 닫히지 않은 당일 봉입니다 — 그래서 백엔드는 장 마감 후에만 대조합니다.
    """
    result = api_get(f"/api/v1/market-indicators/{symbol}/candles", {"interval": "1d", "count": 2}) or {}
    candles = [c for c in (result.get("candles") or []) if isinstance(c, dict)]
    if not candles:
        return {"ok": False, "value": None, "detail": "응답에 일봉이 없습니다"}
    value = to_float(candles[0].get("closePrice"))
    as_of = str(candles[0].get("timestamp") or "")[:10] or None
    if value is None:
        return {"ok": False, "value": None, "detail": "응답에 종가(closePrice)가 없습니다"}
    return {"ok": True, "value": value, "asOf": as_of, "detail": f"{symbol} 일봉 · 기준일 {as_of}"}


def fetch_usdkrw_mid() -> dict:
    """
    원/달러 매매기준율(midRate).

    ``rate``는 매수 환율(스프레드 포함)이라 시장 시세와 비교하면 늘 높게 나옵니다.
    그래서 은행 간 중간값인 ``midRate``를 씁니다.
    """
    result = api_get("/api/v1/exchange-rate", {"baseCurrency": "USD", "quoteCurrency": "KRW"}) or {}
    value = to_float(result.get("midRate"))
    if value is None:
        return {"ok": False, "value": None, "detail": "응답에 매매기준율(midRate)이 없습니다"}
    valid_from = str(result.get("validFrom") or "")
    return {
        "ok": True, "value": value,
        "detail": f"매매기준율 · {valid_from[:16].replace('T', ' ')}" if valid_from else "매매기준율",
    }


def test_connection_flows() -> dict:
    """
    수급 레이더 진단용 — 화면이 쓰는 투자자별 매매 경로를 실제로 한 번 부릅니다.

    연결 테스트 메뉴의 {@link test_connection}(환율)과 달리, 레이더가 쓰는
    ``market-indicators/KOSPI/investor-trading``을 확인합니다.
    """
    if not has_credentials():
        return {"ok": False, "stage": "no_keys", "message": "[toss] TOSS_CLIENT_ID / TOSS_CLIENT_SECRET이 없습니다."}
    try:
        records = fetch_market_investor_trading("KOSPI", count=1)
    except TossForbidden as exc:
        return {"ok": False, "stage": "forbidden", "message": str(exc)}
    except TossError as exc:
        return {"ok": False, "stage": "http_error", "message": str(exc)}
    if not records:
        return {"ok": False, "stage": "empty", "message": "빈 결과입니다."}
    latest = records[0]
    return {
        "ok": True, "stage": "ok",
        "message": f"코스피 투자자별 매매대금 수신 (기준일 {latest.get('date')}, 갱신 {latest.get('updatedAt')})",
    }
