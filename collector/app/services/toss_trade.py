"""
app/services/toss_trade.py
토스증권 실제 계좌 — 모의 책을 따라 하는 실제 매매의 수집기 쪽(ADR 0028, 명세 docs/specs/2026-11-06-real-trade-mirror.md §4·§5).

백엔드(feature.realtrade)가 무엇을 언제 얼마나 사고팔지 정하고, 이 모듈은 그 주문을 토스에 보내기 전에 **한 번 더 검사**한 뒤 보내
결과를 네 갈래(ACCEPTED·REJECTED·UNKNOWN·NOT_SENT — 명세 §4 표)로 돌려줍니다. ``/toss/trading/*``(main.py)가 이 모듈의 응답을
그대로 돌려줍니다. 모의 매매와는 별개 기능입니다(모의 장부·패킷·프롬프트에 이 자료가 들어가지 않음).

지키는 것
  - 쓰기 길은 하나 — 전용 세션 ``toss_trade``(:class:`_TradeWriteAdapter`)만 ``POST /api/v1/orders``와
    ``POST /api/v1/orders/{orderId}/cancel``을 보냅니다. 그 밖의 메서드·경로·쿼리·인코딩·다른 호스트·http는 네트워크 전에
    :class:`TossTradeViolation`이고, 리다이렉트는 따라가지 않습니다. 공유 ``toss`` 세션은 읽기 전용 그대로이고, 읽기(보유·매수 가능
    금액·시세·주문 조회·장 운영 정보)는 그 세션의 ``toss._authorized_get`` 한 길로 합니다.
  - 첫째 스위치 — ``settings.toss_trading_disabled_reason()``이 사유를 내면 토스를 한 번도 부르지 않고 쓰기 세션도 만들지 않습니다.
  - 백엔드 값을 믿지 않음 — 보내기 직전에 형식·창(토스 장 운영 정보)·1건 금액(여기서 직접 받은 상한가·현재가)·오늘 건수와 매수 합
    (토스 목록에서 셈, 앱 주문 포함)을 다시 봅니다. 하나라도 확인하지 못하면 보내지 않습니다(NOT_SENT). 보내는 본문은
    clientOrderId·symbol·side·orderType(MARKET)·timeInForce·quantity뿐입니다(price·confirmHighValueOrder 없음).
  - 모르면 UNKNOWN — 주문이 생겼는지 모르는 결과(읽기 시간 초과·연결 뒤 끊김·5xx·3xx·해석 실패 …)를 거절로 바꾸지 않습니다.
    수집기 안의 재전송은 401(재발급 대상 코드) 뒤 같은 키·같은 본문으로 한 번뿐이고, 그 밖의 재시도는 백엔드 한 곳에서 합니다.
  - 누출 없음 — 계좌번호·accountSeq·토스 오류 message·응답 본문을 응답과 로그에 싣지 않습니다. 오류 code는 형식이 맞을 때만 싣고,
    예상 못 한 예외는 클래스 이름만 남깁니다. 토스 주문 번호(orderId)는 백엔드에 돌려주기만 하고 로그에 쓰지 않습니다.
  - 토큰은 toss 모듈 한 곳의 것을 쓰고(client당 유효 토큰 1개), 401 재발급은 계좌 조회와 같은 10분 1회 창을 나눠 씁니다
    (취소만은 창을 이미 썼어도 한 번 — 끄기·이상 멈춤의 미체결 취소가 막히지 않게). 미리 받기는 발급에 성공할 때만 토큰을 바꿉니다.
    호출 속도는 계좌 조회와 함께 쓰는 그룹별 토큰 버킷(services/toss_ratelimit)으로 조절합니다. 호스트 글자는 toss 모듈의 것을 씁니다.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import requests
from requests.adapters import HTTPAdapter
from urllib3.exceptions import MaxRetryError, NewConnectionError

from .. import http, settings
from . import toss, toss_account, toss_ratelimit

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")

SESSION_NAME = "toss_trade"
ORDER_PATH = "/api/v1/orders"
CALENDAR_PATH = "/api/v1/market-calendar/KR"
_ORDER_PATH = re.compile(r"/api/v1/orders")
_CANCEL_PATH = re.compile(r"/api/v1/orders/[A-Za-z0-9_-]{1,128}/cancel")
_ORDER_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_SYMBOL = re.compile(r"[0-9][0-9A-Z]{5}")
_QUANTITY = re.compile(r"[1-9][0-9]{0,8}")
_CLIENT_ORDER_ID = re.compile(r"[A-Za-z0-9_-]{36}")
_ERROR_CODE = re.compile(r"[a-z0-9-]{1,40}")
_DECIMAL = re.compile(r"-?[0-9]{1,24}(\.[0-9]{1,12})?")
# 토큰 발급 실패에 toss 모듈이 붙이는 이름 — 토스 error.code가 아니라서 code로 싣지 않습니다.
_LOCAL_CODES = frozenset({"token-ip-denied", "token-failed"})

SIDES = frozenset({"BUY", "SELL"})
TIMES_IN_FORCE = frozenset({"DAY", "OPG"})
ORDER_FIELDS = frozenset({"clientOrderId", "symbol", "side", "timeInForce", "quantity", "firstSentAt"})
# 취소의 409 가운데 '원 주문이 이미 끝남'(종료) — REJECTED. already-processing은 '처리 중, 잠시 뒤 다시'(토스 스펙
# retryAfterSeconds 1)라 끝난 상태가 아니므로 넣지 않습니다(그 409는 UNKNOWN — 백엔드가 간격을 두고 다시 보냄).
ALREADY_CODES = frozenset({"already-filled", "already-canceled", "already-modified", "already-rejected"})

ACCEPTED, REJECTED, UNKNOWN, NOT_SENT = "ACCEPTED", "REJECTED", "UNKNOWN", "NOT_SENT"

CONNECT_TIMEOUT_SECONDS = 3.0
READ_TIMEOUT_SECONDS = 4.0
WRITE_READ_TIMEOUT_SECONDS = 8.0
MIN_WRITE_SECONDS = 5.0                 # 쓰기 한 번을 보내려면 남아 있어야 하는 예산
ORDER_BUDGET_SECONDS = 20.0             # 주문 한 건 전체(검사 + 401 뒤 한 번 더) — 백엔드의 주문 읽기 시간 초과 25초 안
CANCEL_BUDGET_SECONDS = 15.0
READ_BUDGET_SECONDS = 15.0
# 사전 조회 예산은 종목 수에 맞춥니다 — 매도 가능 수량(ORDER_INFO 2/초)과 상한가(MARKET_DATA 8/초)를 종목마다 차례로 물어서,
# 고정 20초로는 매도 종목 35개 안팎부터 늘 시간이 모자랐습니다. 어림 = 기본 + 매도 종목 × 0.6 + 시세 종목 × 0.15(버킷 간격 + 호출 지연).
# 예산은 어림을 [최소, 최대]로 자른 값이고, 어림이 최대를 넘는 목록은 토스를 부르기 전에(보유를 더해 넘치면 시세를 묻기 전에)
# invalid-request로 거절합니다 — 늘 시간 초과로 끝나는 대신 원인이 보이게. 최대는 백엔드 사전 조회 읽기 시간 초과 40초 안(여유 5초).
PREFLIGHT_MIN_BUDGET_SECONDS = 20.0
PREFLIGHT_MAX_BUDGET_SECONDS = 35.0
PREFLIGHT_BASE_SECONDS = 5.0            # 계좌 번호·보유·매수 가능 금액·현재가 묶음
PREFLIGHT_SELL_SECONDS = 0.6            # 매도 가능 수량 한 종목 — ORDER_INFO 2/초(0.5초) + 호출 지연
PREFLIGHT_QUOTE_SECONDS = 0.15          # 상한가 한 종목 — MARKET_DATA 8/초(0.125초) + 호출 지연
RESEND_WINDOW = timedelta(minutes=7)    # 같은 키 재전송은 firstSentAt부터 이 안에서만(토스 멱등 10분보다 짧게)
FIRST_SENT_FUTURE_TOLERANCE = timedelta(seconds=30)
REVOKED_WINDOW_SECONDS = 10 * 60.0
REVOKED_CONTENTION_COUNT = 2            # 10분 안에 token-revoked를 이보다 많이 보면 tokenContention
WARMUP_MIN_TOKEN_SECONDS = 30 * 60.0
MAX_CLOCK_SKEW_SECONDS = 5.0
CLOSED_PAGE_LIMIT = 100
TODAY_MAX_PAGES = 5                     # 오늘 끝난 주문을 이보다 많이 넘기면 세지 못한 것으로 봄(하루 건수 상한은 200)
PREFLIGHT_MAX_SYMBOLS = 100
PRICES_CHUNK = 200                      # /api/v1/prices 한 번에 묻는 종목 수 상한(공식 스펙)

# 수집기 쪽 창(명세 §3·§5.2) — 백엔드 창을 감쌉니다. OPG는 프리마켓 단일가 창 안에서만, DAY는 정규장 시작 + 30초부터
# 정규장 끝 1분 전까지(백엔드의 가장 늦은 창은 끝 2분 전에 닫힘 — 같은 키 재전송·지연의 여유).
OPG_OPEN_AFTER = timedelta(seconds=30)
OPG_CLOSE_BEFORE = timedelta(seconds=60)
DAY_OPEN_AFTER = timedelta(seconds=30)
DAY_CLOSE_BEFORE = timedelta(seconds=60)

# 정리된 주문(명세 §5.2) — (응답 이름, 토스 원문 경로). 모르는 칸은 버리고, 숫자는 토스 문자열 그대로(문자열이 아니면 None).
ORDER_VIEW_FIELDS = (
    ("orderId", ("orderId",)),
    ("symbol", ("symbol",)),
    ("side", ("side",)),
    ("orderType", ("orderType",)),
    ("timeInForce", ("timeInForce",)),
    ("status", ("status",)),
    ("quantity", ("quantity",)),
    ("filledQuantity", ("execution", "filledQuantity")),
    ("averageFilledPrice", ("execution", "averageFilledPrice")),
    ("filledAmount", ("execution", "filledAmount")),
    ("commission", ("execution", "commission")),
    ("tax", ("execution", "tax")),
    ("orderedAt", ("orderedAt",)),
    ("canceledAt", ("canceledAt",)),
    ("filledAt", ("execution", "filledAt")),
    ("currency", ("currency",)),
)


class TossTradeViolation(toss.TossError):
    """
    쓰기 세션 가드가 막은 요청 — 네트워크에 나가지 않았습니다.

    ``requests.RequestException``이 아니라서 '연결 실패'로 바뀌지 않고, 주문 결과는 늘 NOT_SENT(``guard``)입니다.
    """


class _Failure(Exception):
    """읽기·검사 실패 — 사유(reason)와 형식이 맞는 토스 error.code. 토스 message는 받지 않습니다."""

    def __init__(self, reason: str, code: str | None = None, *, account_missing: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = _clean_code(code)
        self.account_missing = account_missing


class _State:
    def __init__(self) -> None:
        self.calendar: dict | None = None             # {"key": KST 날짜, "view": 장 운영 정보} — 실패는 두지 않음
        self.revoked: deque[float] = deque()          # token-revoked를 본 시각(단조)


_state_lock = threading.Lock()
_warmup_lock = threading.Lock()
_state = _State()


def _monotonic() -> float:
    return time.monotonic()


def _now() -> datetime:
    return datetime.now(KST)


def reset_for_tests() -> None:
    """장 운영 정보 캐시·token-revoked 기록·공용 속도 조절 버킷을 비웁니다. 시험 사이의 격리용입니다."""
    global _state
    with _state_lock:
        _state = _State()
    toss_ratelimit.reset_for_tests()


def _clean_code(code) -> str | None:
    if isinstance(code, str) and code not in _LOCAL_CODES and _ERROR_CODE.fullmatch(code):
        return code
    return None


# ==============================================================================
# 쓰기 세션 — 주문·취소 POST 두 길만
# ==============================================================================
def _write_check(request: requests.PreparedRequest) -> None:
    """
    쓰기 세션이 보내도 되는 요청인지 봅니다 — ``https://`` + 토스 호스트(포트 없음·443)의 POST이고, 경로가 정확히
    ``/api/v1/orders`` 또는 ``/api/v1/orders/{orderId}/cancel``이며, 사용자 정보·쿼리·조각·``%``·``..``가 없을 때만 통과합니다.

    경로·본문은 비교만 하고 메시지에 싣지 않습니다(주문 번호가 경로에 들어감).

    :raises TossTradeViolation: 허용 밖의 요청
    """
    method = (request.method or "").upper()
    url = request.url or ""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        parts, port = None, -1
    if (parts is not None and method == "POST" and parts.scheme.lower() == "https"
            and (parts.hostname or "").lower() == toss._HOST and port in (None, 443)
            and "@" not in parts.netloc and "?" not in url and "#" not in url
            and "%" not in parts.path and ".." not in parts.path
            and (_ORDER_PATH.fullmatch(parts.path) or _CANCEL_PATH.fullmatch(parts.path))):
        return
    raise TossTradeViolation(f"토스 쓰기 세션이 막은 요청입니다 — {method} 요청을 보내지 않았습니다"
                             f"(허용: {toss.BASE_URL}의 주문·취소 POST)")


class _TradeWriteAdapter(HTTPAdapter):
    """
    쓰기 세션의 어댑터 — 네트워크에 나가기 전에 :func:`_write_check`를 거치고 통과할 때만 보냅니다.

    리다이렉트의 다음 요청도 이 ``send``를 거칩니다(쓰기 호출은 ``allow_redirects=False``라 애초에 따라가지 않음).
    """

    def send(self, request, stream=False, timeout=None, **kwargs):
        _write_check(request)
        return super().send(request, stream=stream, timeout=timeout, **kwargs)


def _session() -> requests.Session:
    """
    쓰기 전용 세션(:class:`_TradeWriteAdapter`). 매매가 켜져 있을 때 보내기 직전에만 부릅니다 — 꺼져 있으면 만들지 않습니다.

    환경의 프록시·.netrc를 쓰지 않고(``trust_env=False``), 리다이렉트는 하나도 따라가지 않습니다(``max_redirects=0`` — 호출마다
    ``allow_redirects=False``도 줌). requests는 이때 3xx 응답을 ``TooManyRedirects``(응답을 실음)로 올립니다 — :func:`_send`가 받음.
    """
    session = http.get_api_session(SESSION_NAME, adapter_class=_TradeWriteAdapter)
    session.trust_env = False
    session.max_redirects = 0
    return session


def _cancel_path(order_id: str) -> str:
    if not _ORDER_ID.fullmatch(order_id):
        raise ValueError("주문 번호 형식이 아닙니다")
    return f"{ORDER_PATH}/{order_id}/cancel"


# ==============================================================================
# 토큰 — token-revoked 기록(경합)과 미리 받기
# ==============================================================================
def _prune_revoked(now: float) -> None:
    while _state.revoked and now - _state.revoked[0] > REVOKED_WINDOW_SECONDS:
        _state.revoked.popleft()


def _note_revoked() -> None:
    now = _monotonic()
    with _state_lock:
        _state.revoked.append(now)
        _prune_revoked(now)


def token_contention() -> bool:
    """10분 안에 token-revoked를 2번 넘게 봤는지 — 서버 밖에서 같은 키로 토큰을 받는 곳이 있다는 뜻(백엔드가 이상 멈춤)."""
    now = _monotonic()
    with _state_lock:
        _prune_revoked(now)
        return len(_state.revoked) > REVOKED_CONTENTION_COUNT


class _WatchedCodes:
    """``toss._authorized_get``의 ``reissue_codes`` 자리 — 401의 code를 볼 때 token-revoked를 세고, 재발급 여부는 받은 집합대로."""

    def __init__(self, allowed: frozenset[str]) -> None:
        self._allowed = allowed

    def __contains__(self, code) -> bool:
        if code == "token-revoked":
            _note_revoked()
        return code in self._allowed


def warmup() -> dict:
    """
    ``POST /toss/trading/warmup`` — 토큰 남은 시간이 30분 미만이면 미리 다시 받습니다(백엔드가 창마다 3분 전에 부름).

    401 때문에 다시 받는 것이 아니라서 10분 재발급 창에 세지 않습니다(창 안의 401이 재발급을 못 하게 되지 않게).
    발급이 실패하면 캐시의 옛 토큰을 그대로 둡니다(``toss.refresh_token`` — 성공할 때만 교체).
    """
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return {"ok": False, "enabled": False, "reason": reason, "tokenRefreshed": False}
    if not toss.has_credentials():
        return {"ok": False, "enabled": True, "reason": "not-configured", "tokenRefreshed": False}
    with _warmup_lock:
        with toss._lock:
            cached = toss._token_cache
        if cached is not None and cached[1] - time.time() >= WARMUP_MIN_TOKEN_SECONDS:
            return {"ok": True, "tokenRefreshed": False}
        # 옛 토큰을 먼저 버리지 않습니다 — 발급이 실패하면 아직 유효한 옛 토큰으로 그 창의 주문·취소를 보냅니다(성공할 때만 교체).
        # 오류 문구에는 토스 본문이 섞일 수 있어 쓰지 않습니다.
        if cached is None:
            token, _error = toss.get_access_token()
        else:
            token, _error = toss.refresh_token(stale=cached[0])
    if not token:
        logger.warning("토스 매매 토큰 미리 받기 실패")
        return {"ok": False, "enabled": True, "reason": "token-failed", "tokenRefreshed": False}
    return {"ok": True, "tokenRefreshed": True}


# ==============================================================================
# 읽기 — 공유 읽기 세션의 toss._authorized_get 한 길
# ==============================================================================
class _DateRecorder:
    """읽기 세션을 감싸 마지막 응답의 ``Date`` 헤더와 받은 시각을 적습니다(장 운영 정보의 시계 차이). 보내는 일은 읽기 세션이 합니다."""

    def __init__(self, session: requests.Session) -> None:
        self._session = session
        self.date_header: str | None = None
        self.received_at: datetime | None = None

    def get(self, *args, **kwargs):
        res = self._session.get(*args, **kwargs)
        self.date_header = res.headers.get("Date")
        self.received_at = _now()
        return res


def _read_failure(exc: toss.TossError, deadline: float) -> _Failure:
    """토스 읽기 오류 → 실패 사유. ``status``·``code`` 속성만 봅니다(메시지에는 토스 message가 들어 있음)."""
    status, code = exc.status, exc.code
    if isinstance(exc, toss.TossMissingKey):
        return _Failure("not-configured")
    if isinstance(exc, toss.TossReadOnlyViolation):
        return _Failure("internal")
    if code == "token-ip-denied":
        return _Failure("ip-not-allowed")
    if code == "token-failed":
        return _Failure("token-failed")
    if code == "account-not-found":   # 엔드포인트마다 400·404로 다르게 옴 — 상태가 아니라 code로
        return _Failure("no-account", code, account_missing=True)
    if status == 429:
        return _Failure("rate-limited", code)
    if status == 401:
        return _Failure("auth-failed", code)
    if status == 403:
        return _Failure("ip-not-allowed" if code == "ip-not-allowed" else "forbidden", code)
    if status == 404:
        return _Failure("not-found", code)
    if status is None and _monotonic() >= deadline:
        return _Failure("timeout")
    return _Failure("upstream-error", code)


def _read(path: str, params: dict | None, deadline: float, *, seq: int | None = None, session=None):
    remaining = deadline - _monotonic()
    if remaining <= 0:
        raise _Failure("timeout")
    if not toss_ratelimit.acquire(toss_ratelimit.group_for("GET", path),
                                  min(toss_ratelimit.MAX_WAIT_SECONDS, remaining)):
        raise _Failure("rate-limited")
    headers = {toss.ACCOUNT_HEADER: str(seq)} if seq is not None else None
    try:
        return toss._authorized_get(session if session is not None else toss._http(), path, params,
                                    (CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS), headers,
                                    reissue_codes=_WatchedCodes(toss_account._reissue_codes()), retry_on_429=False,
                                    on_reissue=toss_account._note_reissue,
                                    remaining=lambda: deadline - _monotonic())
    except toss.TossError as exc:
        raise _read_failure(exc, deadline) from None


def _account_seq(deadline: float, stale: int | None = None) -> int:
    remaining = deadline - _monotonic()
    if remaining <= 0:
        raise _Failure("timeout")
    try:
        return toss_account.account_seq(stale=stale, budget_seconds=remaining)
    except toss_account.AccountUnavailable as missing:
        raise _Failure(missing.reason, missing.code) from None


def _account_read(path: str, params: dict | None, deadline: float):
    """계좌 문맥 GET — accountSeq 헤더를 붙이고, 토스가 ``account-not-found``면 한 번 다시 찾아 다시 부릅니다."""
    seq = _account_seq(deadline)
    try:
        return _read(path, params, deadline, seq=seq)
    except _Failure as failure:
        if not failure.account_missing:
            raise
    return _read(path, params, deadline, seq=_account_seq(deadline, stale=seq))


def _text(node, path: tuple[str, ...]) -> str | None:
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, str) else None


def _decimal_text(value, *, required: bool = True) -> str | None:
    """토스 decimal 문자열을 형식만 확인해 그대로. 없으면 None(required면 실패), 형식이 틀리면 실패."""
    if value is None and not required:
        return None
    if isinstance(value, str) and _DECIMAL.fullmatch(value):
        return value
    raise _Failure("upstream-error")


def _decimal(value) -> Decimal:
    text = _decimal_text(value)
    try:
        return Decimal(text)
    except InvalidOperation:
        raise _Failure("upstream-error") from None


def _dict_orders(orders) -> list[dict]:
    """주문 목록의 항목이 모두 객체인지 — 하나라도 아니면 세지 못한 것으로 봅니다."""
    if not isinstance(orders, list) or not all(isinstance(order, dict) for order in orders):
        raise _Failure("upstream-error")
    return orders


def _order_page(result) -> tuple[list[dict], str | None, bool]:
    if not isinstance(result, dict):
        raise _Failure("upstream-error")
    orders = _dict_orders(result.get("orders"))
    cursor = result.get("nextCursor")
    return orders, (cursor if isinstance(cursor, str) and cursor else None), result.get("hasNext") is True


def _open_list(deadline: float, day: str | None = None) -> list[dict]:
    params = {"status": "OPEN"}
    if day is not None:
        params.update({"from": day, "to": day})
    orders, _cursor, _more = _order_page(_account_read(ORDER_PATH, params, deadline))
    return orders


def _closed_list(deadline: float, day: str) -> list[dict]:
    """오늘(KST) 끝난 주문 전부. 쪽 상한을 넘기거나 다음 커서가 없는데 더 있다고 하면 실패(일부만 세지 않음)."""
    out: list[dict] = []
    cursor = None
    for _page in range(TODAY_MAX_PAGES):
        params = {"status": "CLOSED", "from": day, "to": day, "limit": CLOSED_PAGE_LIMIT}
        if cursor:
            params["cursor"] = cursor
        orders, cursor, more = _order_page(_account_read(ORDER_PATH, params, deadline))
        out.extend(orders)
        if not more:
            return out
        if cursor is None:
            raise _Failure("upstream-error")
    raise _Failure("too-many-orders")


def _today_orders(deadline: float, day: str) -> list[tuple[dict, bool]]:
    """
    오늘의 주문(끝난 것 먼저, 같은 orderId는 한 번) — (주문, 진행 중인지). 통화는 거르지 않습니다.

    진행 중 목록을 먼저 받습니다 — 두 조회 사이에 끝난 주문은 양쪽에 나오고(끝난 쪽을 씀), 빠지지 않습니다.
    """
    opened = _open_list(deadline, day)
    closed = _closed_list(deadline, day)
    seen: set[str] = set()
    out: list[tuple[dict, bool]] = []
    for orders, is_open in ((closed, False), (opened, True)):
        for order in orders:
            order_id = order.get("orderId")
            if isinstance(order_id, str) and order_id:
                if order_id in seen:
                    continue
                seen.add(order_id)
            out.append((order, is_open))
    return out


def _order_view(order: dict) -> dict:
    return {name: _text(order, path) for name, path in ORDER_VIEW_FIELDS}


def _price_limits(symbol: str, deadline: float) -> tuple[str | None, str | None]:
    result = _read("/api/v1/price-limits", {"symbol": symbol}, deadline)
    if not isinstance(result, dict) or result.get("currency") not in (None, "KRW"):
        raise _Failure("upstream-error")
    return (_decimal_text(result.get("upperLimitPrice"), required=False),
            _decimal_text(result.get("lowerLimitPrice"), required=False))


def _last_prices(symbols: list[str], deadline: float) -> dict[str, str]:
    prices: dict[str, str] = {}
    for start in range(0, len(symbols), PRICES_CHUNK):
        chunk = symbols[start:start + PRICES_CHUNK]
        result = _read("/api/v1/prices", {"symbols": ",".join(chunk)}, deadline)
        if not isinstance(result, list):
            raise _Failure("upstream-error")
        for item in result:
            if isinstance(item, dict) and item.get("symbol") in chunk and item.get("currency") in (None, "KRW"):
                prices[item["symbol"]] = _decimal_text(item.get("lastPrice"))
    if any(symbol not in prices for symbol in symbols):
        raise _Failure("upstream-error")
    return prices


# ==============================================================================
# 상태·장 운영 정보
# ==============================================================================
def _disabled_view(reason: str) -> dict:
    return {"ok": False, "enabled": False, "reason": reason}


def no_service_token_view() -> dict:
    """서비스 토큰 없이 뜬 수집기의 읽기 경로 응답(main.py) — 토스를 부르지 않습니다."""
    return _disabled_view("no-service-token")


def _failure_view(failure: _Failure, what: str) -> dict:
    logger.warning("토스 매매 %s 실패 — %s%s", what, failure.reason, f" ({failure.code})" if failure.code else "")
    return {"ok": False, "enabled": True, "reason": failure.reason, "code": failure.code}


def status() -> dict:
    """``GET /toss/trading/status`` — 토스를 부르지 않습니다. 한도는 형식이 맞으면 꺼져 있어도 보입니다(화면의 서버 안전 상한)."""
    reason = settings.toss_trading_disabled_reason()
    return {
        "ok": True,
        "enabled": reason is None,
        "reason": reason,
        "limits": settings.toss_trading_limits(),
        "tokenContention": token_contention(),
        "serverTime": _now().isoformat(timespec="milliseconds"),
    }


def _skew_seconds(recorder: _DateRecorder) -> float | None:
    """토스 응답 ``Date`` − 받은 시각(초). 헤더가 없거나 읽을 수 없으면 None. Date는 초 단위라 1초 안쪽은 잘림."""
    if not recorder.date_header or recorder.received_at is None:
        return None
    try:
        stamp = parsedate_to_datetime(recorder.date_header)
    except (TypeError, ValueError, IndexError):
        return None
    if stamp is None or stamp.tzinfo is None:
        return None
    return round((stamp - recorder.received_at).total_seconds(), 3)


def _moment(value, *, required: bool) -> datetime | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise _Failure("upstream-error")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise _Failure("upstream-error") from None
    if parsed.tzinfo is None:
        raise _Failure("upstream-error")
    return parsed.astimezone(KST)


def _session_view(node, middle_name: str, middle_key: str) -> dict | None:
    """세션 하나(시작·단일가 시작·끝) → 응답 모양. 노드가 null이면 None, 순서가 맞지 않거나 읽을 수 없으면 실패."""
    if node is None:
        return None
    if not isinstance(node, dict):
        raise _Failure("upstream-error")
    start = _moment(node.get("startTime"), required=True)
    middle = _moment(node.get(middle_key), required=False)
    end = _moment(node.get("endTime"), required=True)
    if not start < end or (middle is not None and not start <= middle <= end):
        raise _Failure("upstream-error")
    return {"start": start.isoformat(), middle_name: middle.isoformat() if middle else None, "end": end.isoformat()}


def _business_day(node) -> str:
    try:
        return date.fromisoformat(_text(node, ("date",))).isoformat()
    except (TypeError, ValueError):
        raise _Failure("upstream-error") from None


def _calendar_parse(result, skew: float | None) -> dict:
    if not isinstance(result, dict) or not isinstance(result.get("today"), dict):
        raise _Failure("upstream-error")
    today = result["today"]
    integrated = today.get("integrated")
    if integrated is not None and not isinstance(integrated, dict):
        raise _Failure("upstream-error")
    sessions = None
    if integrated is not None:
        sessions = {
            "preMarket": _session_view(integrated.get("preMarket"), "auctionStart", "singlePriceAuctionStartTime"),
            "regular": _session_view(integrated.get("regularMarket"), "closingAuctionStart",
                                     "singlePriceAuctionStartTime"),
        }
    return {
        "date": _business_day(today),
        "skewSeconds": skew,
        "today": sessions,
        "previousBusinessDay": _business_day(result.get("previousBusinessDay")),
        "nextBusinessDay": _business_day(result.get("nextBusinessDay")),
    }


def _calendar_view(deadline: float) -> dict:
    """오늘(KST) 장 운영 정보 — 날짜마다 한 번 받아 둡니다. 토스의 오늘이 우리 오늘과 다르거나 실패하면 두지 않습니다."""
    key = _now().date().isoformat()
    with _state_lock:
        cached = _state.calendar
    if cached is not None and cached["key"] == key:
        return cached["view"]
    recorder = _DateRecorder(toss._http())
    result = _read(CALENDAR_PATH, None, deadline, session=recorder)
    view = _calendar_parse(result, _skew_seconds(recorder))
    if view["date"] == key:
        with _state_lock:
            _state.calendar = {"key": key, "view": view}
    return view


def calendar() -> dict:
    """``GET /toss/trading/calendar`` — 그날 토스 장 운영 정보(통합 모드)와 시계 차이(``skewSeconds``)."""
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _disabled_view(reason)
    try:
        view = _calendar_view(_monotonic() + READ_BUDGET_SECONDS)
    except _Failure as failure:
        return _failure_view(failure, "장 운영 정보")
    return {"ok": True, **view}


def _window_code(time_in_force: str, view: dict, now: datetime) -> str | None:
    """수집기 쪽 창 검사 — 들어가면 None, 아니면 NOT_SENT 코드."""
    if view["date"] != now.date().isoformat():
        return "outside-window"
    skew = view["skewSeconds"]
    if skew is not None and abs(skew) > MAX_CLOCK_SKEW_SECONDS:
        return "clock-skew"
    sessions = view["today"] or {}
    if time_in_force == "OPG":
        pre = sessions.get("preMarket")
        if not pre or not pre["auctionStart"]:
            return "outside-window"
        start = datetime.fromisoformat(pre["auctionStart"]) + OPG_OPEN_AFTER
        end = datetime.fromisoformat(pre["end"]) - OPG_CLOSE_BEFORE
    else:
        regular = sessions.get("regular")
        if not regular:
            return "outside-window"
        start = datetime.fromisoformat(regular["start"]) + DAY_OPEN_AFTER
        end = datetime.fromisoformat(regular["end"]) - DAY_CLOSE_BEFORE
    return None if start <= now <= end else "outside-window"


# ==============================================================================
# 사전 조회(preflight)·주문 조회
# ==============================================================================
def _symbol_list(raw: str | None) -> list[str]:
    out: list[str] = []
    for item in (raw or "").split(","):
        symbol = item.strip()
        if not symbol:
            continue
        if not _SYMBOL.fullmatch(symbol):
            raise ValueError("종목 형식이 아닙니다")
        if symbol not in out:
            out.append(symbol)
    if len(out) > PREFLIGHT_MAX_SYMBOLS:
        raise ValueError("종목이 너무 많습니다")
    return out


def _kr_holdings(result) -> list[dict]:
    """국내(KR·KRW) 보유 전부. 항목을 읽을 수 없으면 실패 — 모르는 보유를 빼고 운용 평가액을 내지 않습니다."""
    if not isinstance(result, dict) or not isinstance(result.get("items"), list):
        raise _Failure("upstream-error")
    holdings = []
    for item in result["items"]:
        if not isinstance(item, dict):
            raise _Failure("upstream-error")
        if (item.get("marketCountry"), item.get("currency")) != ("KR", "KRW"):
            continue
        symbol = item.get("symbol")
        if not isinstance(symbol, str) or not symbol:
            raise _Failure("upstream-error")
        holdings.append({
            "symbol": symbol,
            "name": _text(item, ("name",)),
            "quantity": _decimal_text(item.get("quantity")),
            "lastPrice": _decimal_text(item.get("lastPrice"), required=False),
        })
    return holdings


def _cash_buying_power(result) -> str:
    if not isinstance(result, dict) or result.get("currency") not in (None, "KRW"):
        raise _Failure("upstream-error")
    return _decimal_text(result.get("cashBuyingPower"))


def _sellable(symbol: str, deadline: float) -> str:
    result = _account_read("/api/v1/sellable-quantity", {"symbol": symbol}, deadline)
    if not isinstance(result, dict):
        raise _Failure("upstream-error")
    return _decimal_text(result.get("sellableQuantity"))


def _preflight_seconds(sell_count: int, quote_count: int) -> float:
    """사전 조회에 드는 시간 어림(초) — 위 PREFLIGHT_* 상수의 식."""
    return PREFLIGHT_BASE_SECONDS + PREFLIGHT_SELL_SECONDS * sell_count + PREFLIGHT_QUOTE_SECONDS * quote_count


def _preflight_fits(sell_count: int, quote_count: int) -> bool:
    """그 목록이 최대 예산 안에 끝날 만한지. 아니면 종목 수만 로그에 남깁니다(종목 코드는 싣지 않음)."""
    if _preflight_seconds(sell_count, quote_count) <= PREFLIGHT_MAX_BUDGET_SECONDS:
        return True
    logger.warning("토스 매매 사전 조회 거절 — 예산(%.0f초) 안에 끝나지 않을 종목 수(매도 가능 수량 %d·시세 %d)",
                   PREFLIGHT_MAX_BUDGET_SECONDS, sell_count, quote_count)
    return False


def _preflight_budget(sell_count: int, quote_count: int) -> float:
    return min(PREFLIGHT_MAX_BUDGET_SECONDS,
               max(PREFLIGHT_MIN_BUDGET_SECONDS, _preflight_seconds(sell_count, quote_count)))


def preflight(symbols_raw: str | None, sell_raw: str | None) -> dict:
    """
    ``GET /toss/trading/preflight?symbols=a,b&sell=c,d`` — 캐시 없이 새로 읽은 원화 매수 가능 금액·국내 보유 전부·시세(symbols ∪
    보유 종목)·매도 가능 수량(sell 목록). 하나라도 실패하면 ``ok: false``(받은 값은 버림 — 부분 값 없음).

    예산은 종목 수에 맞추고(위 PREFLIGHT_* 상수), 예산 안에 끝나지 않을 목록은 ``invalid-request``로 거절합니다 — symbols·sell만으로
    넘치면 토스를 부르기 전에, 보유 종목을 더해 넘치면 시세·매도 가능 수량을 묻기 전에.
    """
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _disabled_view(reason)
    invalid = {"ok": False, "enabled": True, "reason": "invalid-request", "code": None}
    try:
        symbols, sell = _symbol_list(symbols_raw), _symbol_list(sell_raw)
    except ValueError:
        return invalid
    if not _preflight_fits(len(sell), len(symbols)):
        return invalid
    started = _monotonic()
    deadline = started + _preflight_budget(len(sell), len(symbols))
    try:
        holdings = _kr_holdings(_account_read("/api/v1/holdings", None, deadline))
        cash = _cash_buying_power(_account_read("/api/v1/buying-power", {"currency": "KRW"}, deadline))
        quote_symbols = list(symbols)
        for holding in holdings:
            if _SYMBOL.fullmatch(holding["symbol"]) and holding["symbol"] not in quote_symbols:
                quote_symbols.append(holding["symbol"])
        if not _preflight_fits(len(sell), len(quote_symbols)):
            return invalid
        deadline = started + _preflight_budget(len(sell), len(quote_symbols))
        last = _last_prices(quote_symbols, deadline) if quote_symbols else {}
        quotes = {}
        for symbol in quote_symbols:
            upper, lower = _price_limits(symbol, deadline)
            quotes[symbol] = {"lastPrice": last[symbol], "upperLimitPrice": upper, "lowerLimitPrice": lower}
        sellable = {symbol: _sellable(symbol, deadline) for symbol in sell}
    except _Failure as failure:
        return _failure_view(failure, "사전 조회")
    return {
        "ok": True,
        "fetchedAt": _now().isoformat(timespec="seconds"),
        "cashBuyingPowerKrw": cash,
        "holdings": holdings,
        "quotes": quotes,
        "sellable": sellable,
    }


# ==============================================================================
# 매매 제한(VI·서킷브레이커) — 읽기만, 시각 맞추기 직전(2026-11-09 사용자 결정)
# ==============================================================================
RESTRICTION_INDICES = ("KOSPI", "KOSDAQ")
RESTRICTION_MAX_SYMBOLS = 60
RESTRICTION_BUDGET_SECONDS = 25.0
_index_prev_close: dict[tuple[str, str], Decimal] = {}


def _vi_active(result, day: str) -> bool:
    """유의사항 목록에 오늘 시작해 아직 끝나지 않은 VI가 있나(스펙 — ``endDate`` null이 진행 중, 모르는 warningType은 허용)."""
    if not isinstance(result, list):
        raise _Failure("upstream-error")
    return any(isinstance(item, dict) and str(item.get("warningType") or "").startswith("VI_") and item.get("endDate") is None
               and str(item.get("startDate") or "")[:10] == day for item in result)


def _previous_close(symbol: str, day: str, deadline: float) -> Decimal | None:
    """지수의 전 거래일 종가(날짜마다 캐시) — 일봉은 최신순이고 장중 첫 봉은 오늘 봉입니다."""
    key = (symbol, day)
    if key in _index_prev_close:
        return _index_prev_close[key]
    result = _read(f"/api/v1/market-indicators/{symbol}/candles", {"interval": "1d", "count": 2}, deadline)
    for candle in (result.get("candles") or []) if isinstance(result, dict) else []:
        if isinstance(candle, dict) and str(candle.get("timestamp") or "")[:10] < day:
            close = _decimal(candle.get("closePrice"))
            if close > 0:
                _index_prev_close[key] = close
                return close
    return None


def _index_changes(day: str, deadline: float) -> dict[str, float | None]:
    """코스피·코스닥의 전 거래일 대비 등락률(%). 토스에 서킷브레이커 표시가 없어 백엔드가 이 값으로 추정합니다. 못 읽은 지수는 None."""
    changes: dict[str, float | None] = dict.fromkeys(RESTRICTION_INDICES)
    try:
        result = _read("/api/v1/market-indicators/prices", {"symbols": ",".join(RESTRICTION_INDICES)}, deadline)
        for item in result if isinstance(result, list) else []:
            symbol = item.get("symbol") if isinstance(item, dict) else None
            if symbol not in changes or str(item.get("timestamp") or "")[:10] != day:
                continue
            previous = _previous_close(symbol, day, deadline)
            if previous is not None:
                changes[symbol] = float((_decimal(item.get("lastPrice")) - previous) / previous * 100)
    except _Failure as failure:
        logger.warning("토스 지수 조회 실패 — %s", failure.reason)
    except ValueError:
        logger.warning("토스 지수 응답 해석 실패")
    return changes


def restrictions(symbols_raw: str | None) -> dict:
    """
    ``GET /toss/trading/restrictions?symbols=a,b`` — VI가 진행 중인 종목과 지수 등락률. 읽지 못한 종목은 ``unknown``에 넣고 나머지는 돌려줍니다
    (제한을 몰라도 주문을 막지 않음 — 거절되면 백엔드가 대기합니다).
    """
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _disabled_view(reason)
    try:
        symbols = _symbol_list(symbols_raw)
    except ValueError:
        return {"ok": False, "enabled": True, "reason": "invalid-request", "code": None}
    if len(symbols) > RESTRICTION_MAX_SYMBOLS:
        return {"ok": False, "enabled": True, "reason": "invalid-request", "code": None}
    deadline = _monotonic() + RESTRICTION_BUDGET_SECONDS
    day = _now().date().isoformat()
    active: list[str] = []
    unknown: list[str] = []
    for symbol in symbols:
        try:
            if _vi_active(_read(f"/api/v1/stocks/{symbol}/warnings", None, deadline), day):
                active.append(symbol)
        except _Failure:
            unknown.append(symbol)
    return {"ok": True, "viActive": active, "unknown": unknown, "indexChangePct": _index_changes(day, deadline)}


def open_orders() -> dict:
    """``GET /toss/trading/orders/open`` — 진행 중 주문 전량(국내 KRW만, 앱 주문 포함)을 정리해서."""
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _disabled_view(reason)
    try:
        orders = _open_list(_monotonic() + READ_BUDGET_SECONDS)
    except _Failure as failure:
        return _failure_view(failure, "진행 중 주문 조회")
    return {"ok": True, "orders": [_order_view(order) for order in orders if order.get("currency") == "KRW"]}


def today_orders() -> dict:
    """``GET /toss/trading/orders/today`` — 오늘(KST) 주문한 국내 주문 전부(진행 중 + 끝남, 같은 orderId는 끝난 쪽)."""
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _disabled_view(reason)
    try:
        rows = _today_orders(_monotonic() + READ_BUDGET_SECONDS, _now().date().isoformat())
    except _Failure as failure:
        return _failure_view(failure, "오늘 주문 조회")
    return {"ok": True, "orders": [_order_view(order) for order, _open in rows if order.get("currency") == "KRW"]}


def order_detail(order_id: str) -> dict:
    """``GET /toss/trading/orders/{orderId}`` — 주문 하나(어느 상태든)."""
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _disabled_view(reason)
    if not isinstance(order_id, str) or not _ORDER_ID.fullmatch(order_id):
        return {"ok": False, "enabled": True, "reason": "invalid-order-id", "code": None}
    try:
        result = _account_read(f"{ORDER_PATH}/{order_id}", None, _monotonic() + READ_BUDGET_SECONDS)
        if not isinstance(result, dict):
            raise _Failure("upstream-error")
    except _Failure as failure:
        return _failure_view(failure, "주문 조회")
    return {"ok": True, "order": _order_view(result)}


# ==============================================================================
# 주문 — 검사 → 보내기 → 네 갈래
# ==============================================================================
@dataclass(frozen=True)
class _OrderRequest:
    client_order_id: str
    symbol: str
    side: str
    time_in_force: str
    quantity: int
    first_sent_at: datetime

    def body(self) -> bytes:
        """토스로 보내는 본문 — 이 여섯 칸뿐이고, 같은 요청이면 늘 같은 바이트(같은 키 재전송이 '같은 본문'이 되게)."""
        return json.dumps({
            "clientOrderId": self.client_order_id,
            "symbol": self.symbol,
            "side": self.side,
            "orderType": "MARKET",
            "timeInForce": self.time_in_force,
            "quantity": str(self.quantity),
        }, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def write_result(kind: str, outcome: str, code: str | None = None, http_status: int | None = None,
                 order_id: str | None = None) -> dict:
    """주문(``order``)·취소(``cancel``) 응답 모양. 취소는 새로 받은 번호를 ``cancelOrderId``로 싣습니다."""
    return {"outcome": outcome, "cancelOrderId" if kind == "cancel" else "orderId": order_id,
            "code": code, "httpStatus": http_status}


def no_service_token_write(kind: str) -> dict:
    """서비스 토큰 없이 뜬 수집기의 주문·취소 경로 응답(main.py) — 보내지 않았고 읽기 경로와 같은 칸도 싣습니다."""
    return {**no_service_token_view(), **write_result(kind, NOT_SENT, "no-service-token")}


def _parse_order(payload) -> _OrderRequest | str:
    """요청 본문 검사 — 통과하면 요청, 아니면 NOT_SENT 코드. 정한 여섯 칸 밖의 칸이 있으면 받지 않습니다."""
    if not isinstance(payload, dict) or not set(payload) <= ORDER_FIELDS:
        return "invalid-request"
    client_order_id = payload.get("clientOrderId")
    if not isinstance(client_order_id, str) or not _CLIENT_ORDER_ID.fullmatch(client_order_id):
        return "invalid-client-order-id"
    symbol = payload.get("symbol")
    if not isinstance(symbol, str) or not _SYMBOL.fullmatch(symbol):
        return "invalid-symbol"
    side = payload.get("side")
    if side not in SIDES:
        return "invalid-side"
    time_in_force = payload.get("timeInForce")
    if time_in_force not in TIMES_IN_FORCE:
        return "invalid-time-in-force"
    quantity = payload.get("quantity")
    if isinstance(quantity, int) and not isinstance(quantity, bool):
        quantity = str(quantity)
    if not isinstance(quantity, str) or not _QUANTITY.fullmatch(quantity):
        return "invalid-quantity"
    first_sent = payload.get("firstSentAt")
    try:
        first_sent_at = datetime.fromisoformat(first_sent) if isinstance(first_sent, str) else None
    except ValueError:
        first_sent_at = None
    if first_sent_at is None or first_sent_at.tzinfo is None:
        return "invalid-first-sent-at"
    return _OrderRequest(client_order_id, symbol, side, time_in_force, int(quantity), first_sent_at)


def _timing_code(order: _OrderRequest, view: dict) -> str | None:
    """보내기 직전의 시각 검사 — 같은 키 재전송 창(firstSentAt + 7분)과 수집기 쪽 창."""
    now = _now()
    if order.first_sent_at > now + FIRST_SENT_FUTURE_TOLERANCE:
        return "invalid-first-sent-at"
    if now > order.first_sent_at + RESEND_WINDOW:
        return "resend-window-passed"
    return _window_code(order.time_in_force, view, now)


def _stage_code(failure: _Failure, stage: str) -> str:
    return "rate-limited" if failure.reason == "rate-limited" else stage


def _filled_amount(order: dict) -> Decimal:
    execution = order.get("execution")
    if not isinstance(execution, dict):
        raise _Failure("upstream-error")
    if execution.get("filledAmount") is not None:
        return _decimal(execution["filledAmount"])
    filled = _decimal(execution.get("filledQuantity"))
    if filled == 0:
        return Decimal(0)
    return filled * _decimal(execution.get("averageFilledPrice"))


def _today_usage(day: str, deadline: float, uppers: dict[str, Decimal]) -> tuple[int, Decimal]:
    """
    오늘(KST) 국내 주문 수와 매수 금액 합(체결 금액 + 진행 중 잔량 × 상한가) — 토스 목록에서 셉니다(앱 주문 포함).

    방향을 모르는 주문은 매수로 셉니다(상한에 일찍 닿는 쪽). 읽을 수 없는 값이 하나라도 있으면 실패 — 보내지 않습니다.
    """
    count = 0
    bought = Decimal(0)
    for order, is_open in _today_orders(deadline, day):
        if order.get("currency") != "KRW":
            continue
        count += 1
        if order.get("side") == "SELL":
            continue
        bought += _filled_amount(order)
        if not is_open:
            continue
        execution = order.get("execution") if isinstance(order.get("execution"), dict) else {}
        remaining = _decimal(order.get("quantity")) - _decimal(execution.get("filledQuantity"))
        if remaining <= 0:
            continue
        symbol = order.get("symbol")
        if not isinstance(symbol, str) or not symbol:
            raise _Failure("upstream-error")
        if symbol not in uppers:
            upper, _lower = _price_limits(symbol, deadline)
            if upper is None:
                raise _Failure("upstream-error")
            uppers[symbol] = _decimal(upper)
        bought += remaining * uppers[symbol]
    return count, bought


def _pre_send_code(order: _OrderRequest, limits: dict[str, int], deadline: float) -> tuple[str | None, dict | None]:
    """수집기 자체 검사(명세 §5.2). 통과하면 (None, 장 운영 정보), 아니면 (NOT_SENT 코드, None)."""
    try:
        view = _calendar_view(deadline)
    except _Failure as failure:
        return _stage_code(failure, "calendar-unavailable"), None
    code = _timing_code(order, view)
    if code is not None:
        return code, None
    try:
        _account_seq(deadline)
    except _Failure as failure:
        return _stage_code(failure, "account-unavailable"), None
    uppers: dict[str, Decimal] = {}
    try:
        if order.side == "BUY":
            upper, _lower = _price_limits(order.symbol, deadline)
            if upper is None:
                raise _Failure("upstream-error")
            unit = uppers[order.symbol] = _decimal(upper)
        else:
            unit = _decimal(_last_prices([order.symbol], deadline)[order.symbol])
    except _Failure as failure:
        return _stage_code(failure, "price-unavailable"), None
    if unit <= 0:
        return "price-unavailable", None
    amount = unit * order.quantity
    if amount > limits["maxOrderKrw"]:
        return "over-order-limit", None
    try:
        count, bought = _today_usage(view["date"], deadline, uppers)
    except _Failure as failure:
        return _stage_code(failure, "count-unavailable"), None
    if count >= limits["maxOrdersPerDay"]:
        return "over-daily-orders", None
    if order.side == "BUY" and bought + amount > limits["maxBuyKrwPerDay"]:
        return "over-daily-buy", None
    return None, view


def _classify(kind: str, status: int, code: str | None) -> tuple[str, str | None]:
    """
    응답 상태 → (outcome, code) — 명세 §4 표. 표에 없는 상태·code를 모르는 409·422는 UNKNOWN(모르면 멈춤).

    :param code: 형식이 맞는 토스 error.code(아니면 None)
    """
    if 300 <= status < 400:
        return UNKNOWN, "redirect"
    if status >= 500:
        return UNKNOWN, code or f"http-{status}"
    if status == 429:
        return REJECTED, "rate-limited"
    if status in (400, 401, 403, 404):
        return REJECTED, code or f"http-{status}"
    if status == 409:
        if kind == "order" and code == "opposite-pending-order-exists":
            return REJECTED, code
        if kind == "cancel" and code in ALREADY_CODES:
            return REJECTED, code
        return UNKNOWN, code or "http-409"
    if status == 422:
        if code is None or code == "idempotency-key-conflict":
            return UNKNOWN, code or "http-422"
        return REJECTED, code
    return UNKNOWN, code or f"http-{status}"


def _network_outcome(exc: requests.RequestException) -> tuple[str, str]:
    """보내는 중의 예외 → (outcome, code). 연결을 맺지 못한 것이 확실할 때만 NOT_SENT, 나머지는 UNKNOWN."""
    if isinstance(exc, requests.ConnectTimeout):
        return NOT_SENT, "connect-timeout"
    if isinstance(exc, requests.ConnectionError) and not isinstance(
            exc, (requests.exceptions.SSLError, requests.exceptions.ProxyError)):
        cause = exc.args[0] if exc.args else None
        if isinstance(cause, MaxRetryError) and isinstance(cause.reason, NewConnectionError):
            return NOT_SENT, "connect-failed"
    if isinstance(exc, requests.ReadTimeout):
        return UNKNOWN, "read-timeout"
    return UNKNOWN, "connection-lost"


def _accepted_id(res: requests.Response, kind: str, client_order_id: str | None) -> str | None:
    """200 응답의 주문 번호. 해석할 수 없거나 형식이 틀리거나 돌려받은 clientOrderId가 다르면 None(UNKNOWN)."""
    try:
        body = res.json()
    except ValueError:
        return None
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict):
        return None
    order_id = result.get("orderId")
    if not isinstance(order_id, str) or not _ORDER_ID.fullmatch(order_id):
        return None
    if kind == "order" and result.get("clientOrderId") not in (None, client_order_id):
        return None
    return order_id


def _send(kind: str, path: str, body: bytes, deadline: float, client_order_id: str | None = None) -> dict:
    """
    쓰기 한 번 — 401(재발급 대상 코드)이면 같은 본문(같은 키)으로 한 번 더. 결과는 :func:`write_result` 모양.
    주문은 계좌 조회와 같은 10분 재발급 창을 나눠 쓰고, 취소는 창과 상관없이 한 번 재발급합니다.

    두 번째를 보내지 못하면(토큰·시간·속도) 첫 401을 그대로 REJECTED로 돌려줍니다 — 401은 주문이 생기지 않은 응답입니다.
    """
    session = _session()
    first_401: list[str | None] = []   # 첫 시도가 401이었으면 그 code 하나

    def stop(outcome: str, code: str | None) -> dict:
        if first_401 and outcome == NOT_SENT:
            return write_result(kind, REJECTED, first_401[0] or "http-401", 401)
        return write_result(kind, outcome, code)

    for attempt in range(2):
        try:
            seq = _account_seq(deadline)
        except _Failure as failure:
            return stop(NOT_SENT, _stage_code(failure, "account-unavailable"))
        token, _error = toss.get_access_token()   # 오류 문구에는 토스 본문이 섞일 수 있어 쓰지 않습니다
        if not token:
            return stop(NOT_SENT, "token-failed")
        left = deadline - _monotonic()
        if left < MIN_WRITE_SECONDS:
            return stop(NOT_SENT, "timeout")
        if not toss_ratelimit.acquire(toss_ratelimit.group_for("POST", path),
                                      min(toss_ratelimit.MAX_WAIT_SECONDS, left - MIN_WRITE_SECONDS)):
            return stop(NOT_SENT, "rate-limited")
        left = deadline - _monotonic()
        headers = {
            toss.ACCOUNT_HEADER: str(seq),
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        try:
            res = session.post(f"{toss.BASE_URL}{path}", data=body, headers=headers,
                               timeout=(min(CONNECT_TIMEOUT_SECONDS, left), min(WRITE_READ_TIMEOUT_SECONDS, left)),
                               allow_redirects=False)
        except requests.TooManyRedirects as exc:
            res = exc.response   # max_redirects=0이라 3xx는 다음 요청 없이 이 예외로 옴 — 받은 응답으로 나눔(UNKNOWN)
            if res is None:
                return stop(UNKNOWN, "redirect")
        except TossTradeViolation:
            return stop(NOT_SENT, "guard")
        except requests.RequestException as exc:
            outcome, code = _network_outcome(exc)
            return stop(outcome, code)
        except Exception as exc:  # noqa: BLE001 — 보냈는지 모르는 자리라 UNKNOWN(모르면 멈춤). 예외 문구는 싣지 않습니다
            logger.warning("토스 매매 쓰기 중 예상 못 한 예외: %s", type(exc).__name__)
            return write_result(kind, UNKNOWN, "internal")

        status_code = res.status_code
        code = _clean_code(toss._error_code(res)) if status_code != 200 else None
        if status_code == 401:
            current = toss._cached_token()
            replaced = current is not None and current != token   # 이 수집기 안의 다른 곳이 이미 새 토큰을 받아 둠
            if code == "token-revoked" and not replaced:
                _note_revoked()   # 안에서 바뀐 토큰 때문이 아닌 무효 — 밖에서 같은 키로 받는 곳이 있다는 신호
            if attempt == 0:
                first_401.append(code)
                if replaced:
                    continue   # 발급 없이 그 토큰으로 같은 본문을 한 번 더(10분 창을 쓰지 않음)
                # 취소는 10분 창을 이미 썼어도 재발급 대상 세 코드면 한 번 다시 받습니다 — 토큰 경합(읽기가 창을 씀) 중에도
                # 끄기·이상 멈춤의 미체결 취소가 401로만 끝나 원 주문이 살아 남지 않게. 주문은 창을 그대로 나눠 씁니다.
                reissue = toss_account.REISSUE_CODES if kind == "cancel" else toss_account._reissue_codes()
                if code in reissue:
                    toss._invalidate_token(token)
                    toss_account._note_reissue()
                    continue
        if status_code == 200:
            order_id = _accepted_id(res, kind, client_order_id)
            if order_id is None:
                return write_result(kind, UNKNOWN, "bad-response", 200)
            return write_result(kind, ACCEPTED, None, 200, order_id)
        outcome, code = _classify(kind, status_code, code)
        return write_result(kind, outcome, code, status_code)
    return write_result(kind, UNKNOWN, "internal")   # 닿지 않음 — 두 번째 시도는 늘 위에서 돌려줌


def _log_result(kind: str, result: dict) -> dict:
    logger.info("토스 매매 %s 결과 — %s%s%s", "취소" if kind == "cancel" else "주문", result["outcome"],
                f" ({result['code']})" if result.get("code") else "",
                f" HTTP {result['httpStatus']}" if result.get("httpStatus") else "")
    return result


def place_order(payload) -> dict:
    """
    ``POST /toss/trading/orders`` — 본문 ``{"clientOrderId","symbol","side","timeInForce","quantity","firstSentAt"}``.

    검사(명세 §5.2)를 모두 통과해야 보냅니다. 응답 ``{"outcome","orderId","code","httpStatus"}`` — outcome은 명세 §4 표.
    예상 못 한 예외는 보내기 전이면 NOT_SENT(``internal``), 보내는 중·뒤면 UNKNOWN(``internal``)입니다.
    """
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _log_result("order", write_result("order", NOT_SENT, reason))
    limits = settings.toss_trading_limits()
    order = _parse_order(payload)
    if isinstance(order, str):
        return _log_result("order", write_result("order", NOT_SENT, order))
    deadline = _monotonic() + ORDER_BUDGET_SECONDS
    try:
        code, view = _pre_send_code(order, limits, deadline)
        if code is None:
            code = _timing_code(order, view)   # 검사에 쓴 시간만큼 지났으니 보내기 직전에 시각을 다시 봄
    except Exception as exc:  # noqa: BLE001 — 아직 보내지 않은 자리. 예외 문구는 싣지 않습니다
        logger.warning("토스 매매 주문 검사 중 예상 못 한 예외: %s", type(exc).__name__)
        return _log_result("order", write_result("order", NOT_SENT, "internal"))
    if code is not None:
        return _log_result("order", write_result("order", NOT_SENT, code))
    return _log_result("order", _send("order", ORDER_PATH, order.body(), deadline, order.client_order_id))


def cancel_order(order_id) -> dict:
    """
    ``POST /toss/trading/orders/{orderId}/cancel`` — 응답 ``{"outcome","cancelOrderId","code","httpStatus"}``.

    창·한도 검사는 하지 않습니다(끄기·이상 멈춤의 미체결 취소는 언제든). 주문 번호 형식이 틀리면 보내지 않습니다.
    """
    reason = settings.toss_trading_disabled_reason()
    if reason is not None:
        return _log_result("cancel", write_result("cancel", NOT_SENT, reason))
    if not isinstance(order_id, str) or not _ORDER_ID.fullmatch(order_id):
        return _log_result("cancel", write_result("cancel", NOT_SENT, "invalid-order-id"))
    deadline = _monotonic() + CANCEL_BUDGET_SECONDS
    return _log_result("cancel", _send("cancel", _cancel_path(order_id), b"{}", deadline))
