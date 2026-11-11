"""
app/services/toss.py
토스증권 Open API — 연결 진단 + 국내 투자자별 매매동향.

쓰는 곳
  - 외부 API 연결 테스트 (진단·환율·지수)
  - 수급 레이더 / 국내 파생: 투자자별 매매 (공식 스펙 1.2.13부터 제공)
      GET /api/v1/market-indicators/{KOSPI|KOSDAQ}/investor-trading  시장 전체 매매**대금**(원)
      GET /api/v1/stocks/{symbol}/investor-trading                    종목별 매매**거래량**(주)
  - 모의 매매 한국 책(v2 2단계 B4): 종목 봉과 종목 상태
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
  - **이 모듈의 세션은 읽기 전용입니다**(ADR 0025). 키에 권한 구분(scope)이 없어 같은 키로 주문 POST가 나갈 수 있으므로,
    세션 자체에 가드 어댑터(:class:`_ReadOnlyAdapter`)를 붙여 GET과 토큰 발급 POST 하나만 내보냅니다. 실제 계좌 조회
    (services/toss_account.py)도 이 세션과 이 모듈의 토큰을 씁니다.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import Callable
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import requests
from requests.adapters import HTTPAdapter

from ..numbers import to_float, to_int
from .. import http, settings

logger = logging.getLogger(__name__)

_HOST = "openapi.tossinvest.com"
BASE_URL = f"https://{_HOST}"
AUTH_PATH = "/oauth2/token"
AUTH_URL = f"{BASE_URL}{AUTH_PATH}"
# 계좌 문맥 API에 싣는 헤더(값은 /api/v1/accounts의 accountSeq). 이름을 여기 한 곳에 둡니다 — 호스트 이름이 들어간 글자는
# 이 모듈 밖에 두지 않습니다(test_toss_account의 AST 시험).
ACCOUNT_HEADER = "X-Tossinvest-Account"

_lock = threading.Lock()
# 발급 자체를 한 번에 하나로 묶습니다. client당 유효 토큰이 1개라, 두 곳이 동시에 발급하면
# 먼저 받은 쪽 토큰이 즉시 무효가 됩니다(연결 테스트와 수집 태스크가 겹칠 때).
_issue_lock = threading.Lock()
_token_cache: tuple[str, float] | None = None


def _http() -> requests.Session:
    """
    이 클라이언트 전용 세션 — 연결만 재사용합니다(재시도·쿠키 없음, app/http.py).

    읽기 전용 가드(:class:`_ReadOnlyAdapter`)를 ``https://``·``http://`` 둘 다에 붙입니다(ADR 0025). 이 세션으로 나가는
    요청은 GET과 ``POST /oauth2/token``뿐이고, 나머지는 네트워크에 나가기 전에 :class:`TossReadOnlyViolation`으로 끝납니다.
    """
    return http.get_api_session("toss", adapter_class=_ReadOnlyAdapter)


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


def refresh_token(stale: str | None = None) -> tuple[str | None, str | None]:
    """
    (토큰, 오류 메시지) — 토큰을 미리 다시 받습니다(토스 매매의 미리 받기, services/toss_trade.warmup).

    캐시를 먼저 비우지 않습니다. 발급에 성공했을 때만 캐시를 바꾸므로(:func:`_issue_token`), 토스 인증이 잠깐 실패해도
    아직 유효한 옛 토큰으로 주문·취소를 계속 보낼 수 있습니다. 401 때문에 버리는 경로(:func:`_invalidate_token`)와는 다릅니다.

    :param stale: 미리 받기 전에 본 토큰. 발급 차례를 기다리는 동안 다른 곳이 이미 새 토큰을 받아 캐시가 바뀌었으면 다시
                  발급하지 않고 그 토큰을 돌려줍니다(client당 유효 토큰 1개 — 방금 받은 토큰을 무효로 만들지 않게)
    """
    with _issue_lock:
        with _lock:
            current = _token_cache
        if stale is not None and current is not None and current[0] != stale and current[1] > time.time():
            return current[0], None
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
        # 본문 해석도 try 안에서 합니다(QA-350) — 응답이 객체가 아니거나 수명이 숫자가 아니면 예외가 부르는 쪽으로 올라가, 주문 길에서
        # '보내지 않음(token-failed)' 대신 일반 예외로 분류됐습니다.
        if not isinstance(payload, dict):
            return None, "토큰 발급 실패: 응답이 객체가 아닙니다"
        token = payload.get("access_token")
        if not token:
            return None, f"토큰 응답에 access_token이 없습니다: {payload}"
        expires_in = int(payload.get("expires_in", 3600))
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        body = exc.response.text[:300] if exc.response is not None else ""
        return None, f"HTTP {status} 오류: {body}"
    except Exception as exc:  # noqa: BLE001
        return None, f"토큰 발급 실패: {exc}"

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
    """
    토스 API 호출 실패. 메시지에는 비밀값이 없습니다(상태 화면에 그대로 나갑니다).

    ``status``는 HTTP 상태(응답을 받지 못했으면 None), ``code``는 토스 오류 envelope의 ``error.code``(없으면 None) —
    토큰 발급 실패는 ``token-ip-denied``(발급 403)·``token-failed``(그 밖)입니다. 실제 계좌 조회는 메시지(토스 ``message`` 포함)를
    쓰지 않고 이 두 속성으로만 사유를 정합니다(ADR 0025).
    """

    def __init__(self, message: str = "", *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class TossMissingKey(TossError):
    """TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 미설정."""


class TossForbidden(TossError):
    """403 — 허용 IP 목록 문제일 가능성이 높습니다. 같은 실행에서 더 부르지 않습니다."""


class TossReadOnlyViolation(TossError):
    """
    읽기 전용 가드가 막은 요청(ADR 0025) — 네트워크에 나가지 않았습니다.

    ``requests.RequestException``이 아니라서 :func:`_authorized_get`의 '연결 실패'로 바뀌지 않고 그대로 올라갑니다.
    """


def _read_only_check(request: requests.PreparedRequest) -> None:
    """
    이 세션이 보내도 되는 요청인지 봅니다 — ``https://openapi…`` 호스트(포트 없음·443)이고, 본문 없는 GET이거나
    ``POST /oauth2/token``일 때만 통과합니다. 주문·정정·취소·조건주문(POST·DELETE)과 다른 호스트·http는 여기서 끝납니다.

    경로는 비교만 하고 메시지에 싣지 않습니다(주문 번호가 경로에 들어갈 수 있음). 쿼리·본문도 싣지 않습니다.

    :raises TossReadOnlyViolation: 허용 밖의 요청
    """
    method = (request.method or "").upper()
    try:
        parts = urlsplit(request.url or "")
        port = parts.port
    except ValueError:
        parts, port = None, -1
    scheme = parts.scheme.lower() if parts else ""
    host = (parts.hostname or "").lower() if parts else ""
    if scheme == "https" and host == _HOST and port in (None, 443):
        if method == "GET" and not request.body:
            return
        if method == "POST" and parts.path == AUTH_PATH:
            return
    raise TossReadOnlyViolation(
        f"토스 세션은 읽기 전용입니다 — {method} {scheme}://{host} 요청을 보내지 않았습니다"
        f"(허용: {BASE_URL}의 GET, POST {AUTH_PATH})"
    )


class _ReadOnlyAdapter(HTTPAdapter):
    """
    토스 공유 세션의 어댑터 — 보내기 전에 :func:`_read_only_check`를 거칩니다(app/http.py ``_GuardedAdapter``와 같은 자리).

    리다이렉트의 다음 요청도 이 ``send``를 거치므로, 다른 호스트로 넘기는 응답이 와도 토큰·계좌 헤더가 그쪽으로 나가지 않습니다.
    """

    def send(self, request, stream=False, timeout=None, **kwargs):
        _read_only_check(request)
        return super().send(request, stream=stream, timeout=timeout, **kwargs)


def _cached_token() -> str | None:
    """지금 캐시에 있는 유효한 토큰(없으면 None). 발급하지 않습니다."""
    with _lock:
        if _token_cache and _token_cache[1] > time.time():
            return _token_cache[0]
        return None


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
    """오류 글 — 토스 오류 envelope(``error.code``·``error.message``)이면 그것을 붙이고, 그 모양이 아니면(JSON 아님·본문이 목록·``error``가 글자) 상태만."""
    try:
        body = res.json()
    except ValueError:
        return f"HTTP {res.status_code}"
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return f"HTTP {res.status_code}"     # 게이트웨이·프레임워크의 기본 오류 본문({"status": 404, "error": "Not Found"}) 등(QA-350)
    code, message = err.get("code") or "", err.get("message") or ""
    return f"HTTP {res.status_code} {code} {message}".strip()


def _error_code(res: requests.Response) -> str | None:
    """토스 오류 envelope의 ``error.code``. 없거나 JSON이 아니면 None(message는 읽지 않음)."""
    try:
        body = res.json()
    except ValueError:
        return None
    err = body.get("error") if isinstance(body, dict) else None
    code = err.get("code") if isinstance(err, dict) else None
    return code if isinstance(code, str) and code else None


def api_get(path: str, params: dict | None = None, timeout: float = 10.0) -> dict | list:
    """
    인증이 필요한 GET 한 번. 응답 envelope의 ``result``를 돌려줍니다.

    :raises TossMissingKey: 키 미설정 (호출하지 않음)
    :raises TossForbidden: 403
    :raises TossError: 그 밖의 실패
    """
    return _authorized_get(_http(), path, params, timeout)


def _authorized_get(session: requests.Session, path: str, params: dict | None = None,
                    timeout: float | tuple[float, float] = 10.0, extra_headers: dict | None = None, *,
                    reissue_codes: frozenset[str] | set[str] | None = None, retry_on_429: bool = True,
                    on_reissue: Callable[[], None] | None = None,
                    remaining: Callable[[], float] | None = None) -> dict | list:
    """
    ``api_get``의 본체 — 토큰을 붙인 GET과 401(한 번 재발급)·429(Retry-After)·403 처리.

    토큰 캐시·발급은 이 모듈 한 곳에만 있습니다(client당 유효 토큰 1개). 세션을 인자로 받는 것은 부르는 쪽이
    연결을 고르게 하려는 것이고, 토큰을 따로 갖게 하려는 것이 아닙니다.

    :param extra_headers: 더 실을 헤더(계좌 문맥 API의 :data:`ACCOUNT_HEADER`). ``Authorization``은 덮어쓰지 못합니다
    :param reissue_codes: None이면 첫 401에 늘 재발급(지금까지의 동작). 주면 401의 ``error.code``가 그 안에 있을 때만
        재발급하고, 아니면 토큰을 버리지 않고 ``TossError(status=401)``로 끝냅니다 — 실제 계좌 조회가 운영 1분봉의 토큰을
        함부로 무효화하지 않게(ADR 0025). 빈 집합이면 재발급하지 않습니다
    :param retry_on_429: False면 429에서 잠들지 않고 바로 ``TossError(status=429)`` — 요청 스레드를 붙잡지 않게
    :param on_reissue: 401 때문에 토큰을 버린 바로 뒤에 부릅니다(부르는 쪽이 재발급 횟수를 셈). 다른 곳이 이미 새 토큰을
        받아 둔 401은 발급 없이 그 토큰으로 한 번 더 보내고 부르지 않습니다
    :param remaining: 남은 시간(초)을 돌려주는 함수. 주면 시도마다 0 이하인지 보고(그러면 보내지 않고 ``TossError`` —
        ``status`` 없음), GET 시간 상한을 남은 시간 안으로 줄입니다. 진행 중인 토큰 발급은 끊지 않습니다 — 발급 응답을 못 받으면
        서버에서는 새 토큰이 나가 다른 경로의 토큰만 무효가 될 수 있습니다
    :raises TossMissingKey: 키 미설정 (호출하지 않음)
    :raises TossForbidden: 403
    :raises TossReadOnlyViolation: 세션 가드가 막음(GET이 아니게 된 요청 — 보내지 않음)
    :raises TossError: 그 밖의 실패. ``status``·``code`` 속성을 채웁니다
    """
    if not has_credentials():
        raise TossMissingKey("TOSS_CLIENT_ID / TOSS_CLIENT_SECRET이 설정되지 않았습니다")

    for attempt in range(3):
        if remaining is not None and remaining() <= 0:
            raise TossError("시간 예산 초과")
        token, error = get_access_token()
        if not token:
            code = "token-ip-denied" if (error or "").startswith("HTTP 403") else "token-failed"
            raise TossError(f"토큰 발급 실패 — {error}", code=code)
        headers = {key: value for key, value in (extra_headers or {}).items() if str(key).lower() != "authorization"}
        headers["Authorization"] = f"Bearer {token}"
        send_timeout = timeout
        if remaining is not None:
            left = remaining()   # 토큰 발급을 기다린 만큼 줄어 있을 수 있음
            if left <= 0:
                raise TossError("시간 예산 초과")
            send_timeout = (tuple(min(part, left) for part in timeout) if isinstance(timeout, tuple)
                            else min(timeout, left))
        try:
            res = session.get(
                f"{BASE_URL}{path}", headers=headers,
                params=params, timeout=send_timeout,
            )
        except requests.RequestException as exc:
            raise TossError(f"연결 실패: {type(exc).__name__}") from None

        if res.status_code == 401 and attempt == 0:
            current = _cached_token()
            if current is not None and current != token:
                continue  # 다른 곳이 이미 새 토큰을 받아 둠 — 발급 없이 그 토큰으로 한 번 더
            if reissue_codes is None or _error_code(res) in reissue_codes:
                _invalidate_token(token)  # 다른 곳에서 재발급해 무효가 됐을 수 있습니다 — 한 번만 다시
                if on_reissue is not None:
                    on_reissue()
                continue
        if res.status_code == 429 and retry_on_429 and attempt < 2:
            try:
                wait = float(res.headers.get("Retry-After", "1"))
            except ValueError:
                wait = 1.0
            time.sleep(min(max(wait, 0.5), 5.0))
            continue
        if res.status_code == 403:
            raise TossForbidden(f"{_error_text(res)} — 토스 개발자 콘솔의 허용 IP에 이 맥의 공인 IP가 있는지 확인하세요",
                                status=403, code=_error_code(res))
        if res.status_code != 200:
            raise TossError(_error_text(res), status=res.status_code, code=_error_code(res))
        try:
            body = res.json() or {}
        except ValueError:
            raise TossError("JSON이 아닌 응답", status=200) from None
        if not isinstance(body, dict):
            raise TossError("봉투 모양이 아닌 응답", status=200)      # 예전에는 AttributeError가 그대로 올라갔습니다(QA-350)
        return body.get("result")
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
