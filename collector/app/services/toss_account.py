"""
app/services/toss_account.py
토스증권 실제 계좌 — 읽기 전용 조회(ADR 0025, 명세 docs/specs/2026-11-05-toss-account-readonly.md §2·§3).

운영자 본인 계좌의 보유 종목·매수 가능 금액·주문 내역(진행 중 전부, 최근 30일 끝남)을 **읽기만** 해서 원화 쪽(KR)과
달러 쪽(US)으로 나눕니다. ``GET /toss/account``(main.py)가 이 모듈의 응답을 그대로 돌려줍니다. 모의 매매와는 별개 기능입니다.

지키는 것
  - 쓰기 없음 — 호출은 모두 ``toss._authorized_get(toss._http(), …)`` 한 길(GET)입니다. 그 세션에는 읽기 전용 가드가 붙어 있고,
    토큰도 toss 모듈 한 곳의 것을 씁니다(client당 유효 토큰 1개 — 여기서 따로 발급하면 운영 1분봉의 토큰이 무효가 됨).
  - 저장하지 않음 — 이 모듈의 메모리에만 둡니다(DB·스냅숏·태스크 기록·/status로 퍼지지 않음).
  - 최소 보유 — 허용 목록의 필드만 옮깁니다. 계좌번호(``accountNo``)는 읽지 않고, ``accountSeq``(헤더 값)·``orderId``(중복 제거)는
    응답에 싣지 않습니다.
  - 누출 없음 — 토스 오류 ``message``·응답 본문·예외 문구를 응답과 로그에 싣지 않습니다. 사유(``reason``)와 형식이 맞는
    ``error.code``만 싣습니다.
  - 토큰 보호 — 401은 ``expired-token``·``token-revoked``·``invalid-token``일 때만, 그것도 10분에 한 번만 재발급합니다.
    429는 잠들지 않고 바로 실패합니다(수집기 요청 스레드를 붙잡지 않게).
  - 실제 매매(services/toss_trade, ADR 0028)와 나눠 쓰는 것 — 그룹별 속도 조절(services/toss_ratelimit), 10분 재발급 창,
    accountSeq(:func:`account_seq`).

캐시(명세 §2)
  - 성공은 10초 동안 그대로 씁니다(ADR 0030 — 화면 새로고침 주기, 그 전 60초). 나이는 갱신을 **시작한** 시각부터 세고, 화면 주기의 흔들림(타이머·
    네트워크)에 1초 여유를 둡니다 — 시작부터 9초가 지난 요청은 새로 읽으므로 10초 주기 요청마다 새 값입니다(끝난 시각부터 세면 약 20초마다 바뀜).
    갱신은 호출이 **모두** 성공해야 캐시를 바꿉니다(새 값과 옛 값을 섞지 않음).
  - 갱신이 실패하면 직전 성공값 전체를 ``isStale``로 보이되, 받은 지 30분이 지나면 버립니다. 실패 직후 30초는 다시 부르지 않습니다.
  - 갱신은 한 번에 하나이고 **기다리지 않습니다** — 갱신 중에 온 요청은 지금 캐시(없으면 ``reason: "refreshing"``)를 바로 받습니다.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .. import settings
from . import toss, toss_ratelimit

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")

SUCCESS_TTL_SECONDS = 10.0             # ADR 0030(ADR 0025 결정 3 개정) — 갱신 한 번에 토스 5~7회라 호출 한도 안
TTL_SLACK_SECONDS = 1.0                # 화면 10초 주기의 흔들림 여유 — 갱신 시작부터 9초 지나면 새로 읽음
STALE_MAX_SECONDS = 30 * 60.0          # 받은 시각부터 — 이보다 오래된 성공값은 이전 값으로도 보이지 않음
FAILURE_BACKOFF_SECONDS = 30.0
REFRESH_BUDGET_SECONDS = 12.0          # 갱신 한 번 전체. 넘으면 남은 호출을 하지 않고 실패(reason "timeout")
CONNECT_TIMEOUT_SECONDS = 3.0
READ_TIMEOUT_SECONDS = 4.0
REISSUE_CODES = frozenset({"expired-token", "token-revoked", "invalid-token"})
REISSUE_WINDOW_SECONDS = 10 * 60.0     # 계좌 경로가 일으키는 토큰 재발급은 이 안에 한 번
CLOSED_LOOKBACK_DAYS = 30
CLOSED_PAGE_LIMIT = 100
CLOSED_MAX_PAGES = 3

ACCOUNT_LABEL = "토스증권 종합매매"
ACCOUNT_TYPE = "BROKERAGE"
_ERROR_CODE = re.compile(r"[a-z0-9-]{1,40}")
_ACCOUNT_SEQ = re.compile(r"[0-9]{1,19}")
# 토큰 발급 실패에 toss 모듈이 붙이는 이름 — 토스 error.code가 아니라서 errorCode로 싣지 않습니다.
_LOCAL_CODES = frozenset({"token-ip-denied", "token-failed"})

# (응답 쪽, 통화, HoldingsOverview Price의 키). 주문은 통화로, 보유는 (시장, 통화)가 둘 다 맞을 때만 그 쪽에 둡니다.
SIDES = (("KR", "KRW", "krw"), ("US", "USD", "usd"))
_HOLDING_SIDE = {("KR", "KRW"): "KR", ("US", "USD"): "US"}
_ORDER_SIDE = {"KRW": "KR", "USD": "US"}

# 허용 목록 — (응답 이름, 토스 원문 경로). 숫자는 토스 문자열 그대로, 문자열이 아니거나 없으면 None.
SUMMARY_FIELDS = (
    ("purchaseAmount", ("totalPurchaseAmount",)),
    ("marketValue", ("marketValue", "amount")),
    ("marketValueAfterCost", ("marketValue", "amountAfterCost")),
    ("profitLoss", ("profitLoss", "amount")),
    ("profitLossAfterCost", ("profitLoss", "amountAfterCost")),
    ("dailyProfitLoss", ("dailyProfitLoss", "amount")),
)   # 요약의 rate·rateAfterCost·dailyProfitLoss.rate는 원화 환산 합산이라 옮기지 않습니다
HOLDING_FIELDS = (
    ("symbol", ("symbol",)),
    ("name", ("name",)),
    ("marketCountry", ("marketCountry",)),
    ("currency", ("currency",)),
    ("quantity", ("quantity",)),
    ("lastPrice", ("lastPrice",)),
    ("averagePurchasePrice", ("averagePurchasePrice",)),
    ("purchaseAmount", ("marketValue", "purchaseAmount")),
    ("marketValue", ("marketValue", "amount")),
    ("marketValueAfterCost", ("marketValue", "amountAfterCost")),
    ("profitLoss", ("profitLoss", "amount")),
    ("profitLossAfterCost", ("profitLoss", "amountAfterCost")),
    ("profitLossRate", ("profitLoss", "rate")),
    ("profitLossRateAfterCost", ("profitLoss", "rateAfterCost")),
    ("dailyProfitLoss", ("dailyProfitLoss", "amount")),
    ("dailyProfitLossRate", ("dailyProfitLoss", "rate")),
)
ORDER_FIELDS = (                       # name은 symbol 뒤에 보유 이름표에서 채웁니다(/stocks를 부르지 않음)
    ("side", ("side",)),
    ("orderType", ("orderType",)),
    ("timeInForce", ("timeInForce",)),
    ("status", ("status",)),
    ("currency", ("currency",)),
    ("price", ("price",)),
    ("quantity", ("quantity",)),
    ("orderAmount", ("orderAmount",)),
    ("orderedAt", ("orderedAt",)),
    ("canceledAt", ("canceledAt",)),
    ("filledQuantity", ("execution", "filledQuantity")),
    ("averageFilledPrice", ("execution", "averageFilledPrice")),
    ("filledAmount", ("execution", "filledAmount")),
    ("commission", ("execution", "commission")),
    ("tax", ("execution", "tax")),
    ("filledAt", ("execution", "filledAt")),
    ("settlementDate", ("execution", "settlementDate")),
)


class _Failure(Exception):
    """갱신 실패 — 응답의 reason과 (형식이 맞을 때만) 토스 error.code. 토스 message는 받지 않습니다."""

    def __init__(self, reason: str, code: str | None = None, *, account_count: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code if isinstance(code, str) and code not in _LOCAL_CODES and _ERROR_CODE.fullmatch(code) else None
        self.account_count = account_count


class _AccountNotFound(_Failure):
    """토스 ``account-not-found`` — 기억한 accountSeq를 버리고 /accounts를 한 번 다시 부릅니다."""


class AccountUnavailable(Exception):
    """
    :func:`account_seq`가 accountSeq를 정하지 못함 — ``reason``(no-account·upstream-error·timeout …)과 형식이 맞는 토스
    ``code``만 담습니다. 계좌번호·accountSeq·토스 message는 담지 않습니다.
    """

    def __init__(self, reason: str, code: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code


class _State:
    def __init__(self) -> None:
        # {"data", "mono"(갱신을 시작한 시각, 단조 — 10초 캐시), "receivedMono"(받은 시각, 단조 — 30분 이전 값 창),
        #  "fetchedAt"(받은 시각, KST 문자열)}
        self.entry: dict | None = None
        self.failure: _Failure | None = None    # 마지막 갱신이 실패했으면 그 사유(성공하면 비움)
        self.failed_mono: float | None = None
        self.stale_since: str | None = None     # 마지막 성공 뒤 첫 실패 시각
        self.account_seq: int | None = None
        self.last_reissue: float | None = None  # 계좌 경로가 토큰을 버린 시각(단조)


_refresh_lock = threading.Lock()   # 갱신은 한 번에 하나 — acquire(blocking=False)로만 잡습니다
_state_lock = threading.Lock()
_seq_lock = threading.Lock()       # account_seq()의 계좌 찾기는 한 번에 하나 — 기다린 쪽은 찾은 값을 그대로 씀
_state = _State()


def _monotonic() -> float:
    return time.monotonic()


def _now() -> datetime:
    return datetime.now(KST)


def _stamp() -> str:
    return _now().isoformat(timespec="seconds")


def reset_for_tests() -> None:
    """캐시·실패·accountSeq·재발급 기록을 비웁니다. 시험 사이의 격리용입니다."""
    global _state
    with _state_lock:
        _state = _State()


# ==============================================================================
# 응답 모양
# ==============================================================================
def empty_view(*, enabled: bool, reason: str, error_code: str | None = None,
               account_count: int | None = None) -> dict:
    """보일 데이터가 없는 응답(``ok: false``). main.py도 no-service-token·internal에 씁니다."""
    return {
        "ok": False, "enabled": enabled, "reason": reason, "errorCode": error_code,
        "fetchedAt": None, "isStale": False, "staleSince": None,
        "account": None, "accountCount": account_count, "sides": None,
        "closedFrom": None, "closedTruncated": False, "unclassifiedCount": 0,
    }


def _data_view(entry: dict, failure: _Failure | None, stale_since: str | None) -> dict:
    data = entry["data"]
    count = data["accountCount"]
    if failure is not None and failure.account_count is not None:
        count = failure.account_count
    return {
        "ok": True, "enabled": True,
        "reason": failure.reason if failure is not None else None,
        "errorCode": failure.code if failure is not None else None,
        "fetchedAt": entry["fetchedAt"],
        "isStale": failure is not None,
        "staleSince": stale_since if failure is not None else None,
        "account": {"label": ACCOUNT_LABEL, "type": ACCOUNT_TYPE},
        "accountCount": count,
        "sides": data["sides"],
        "closedFrom": data["closedFrom"],
        "closedTruncated": data["closedTruncated"],
        "unclassifiedCount": data["unclassifiedCount"],
    }


def _usable_entry(now: float) -> dict | None:
    """받은 지 30분 안의 성공값. 지났으면 버립니다. ``_state_lock`` 안에서 부릅니다."""
    entry = _state.entry
    if entry is not None and now - entry["receivedMono"] > STALE_MAX_SECONDS:
        _state.entry = entry = None
    return entry


def _failure_view(entry: dict | None) -> dict:
    failure = _state.failure
    if entry is not None:
        return _data_view(entry, failure, _state.stale_since)
    return empty_view(enabled=True, reason=failure.reason, error_code=failure.code,
                      account_count=failure.account_count)


def _cached_view(now: float) -> dict | None:
    """캐시로 답할 차례면 그 응답(새 값 — 갱신 시작부터 10초에서 여유 1초를 뺀 9초 안, 또는 실패 뒤 30초 안), 갱신할 차례면 None."""
    with _state_lock:
        entry = _usable_entry(now)
        if entry is not None and _state.failure is None \
                and now - entry["mono"] < SUCCESS_TTL_SECONDS - TTL_SLACK_SECONDS:
            return _data_view(entry, None, None)
        if _state.failure is not None and now - _state.failed_mono < FAILURE_BACKOFF_SECONDS:
            return _failure_view(entry)
        return None


def _in_flight_view(now: float) -> dict:
    """다른 요청이 갱신 중일 때 — 지금 캐시를 그대로, 없으면 refreshing."""
    with _state_lock:
        entry = _usable_entry(now)
        if entry is None:
            return empty_view(enabled=True, reason="refreshing")
        return _data_view(entry, _state.failure, _state.stale_since)


def _record_success(data: dict, started: float) -> dict:
    """``started``는 갱신을 시작한 단조 시각 — 10초 캐시 나이를 여기서부터 셉니다. 30분 이전 값 창과 ``fetchedAt``은 받은 시각부터."""
    entry = {"data": data, "mono": started, "receivedMono": _monotonic(), "fetchedAt": _stamp()}
    with _state_lock:
        _state.entry = entry
        _state.failure = _state.failed_mono = _state.stale_since = None
        return _data_view(entry, None, None)


def _record_failure(failure: _Failure) -> dict:
    logger.warning("토스 계좌 갱신 실패 — %s%s", failure.reason, f" ({failure.code})" if failure.code else "")
    now = _monotonic()
    with _state_lock:
        _state.failure, _state.failed_mono = failure, now
        if _state.stale_since is None:
            _state.stale_since = _stamp()
        return _failure_view(_usable_entry(now))


# ==============================================================================
# 진입점
# ==============================================================================
def get_account() -> dict:
    """
    ``GET /toss/account``의 본문(명세 §3). 서비스 토큰 확인과 마지막 방어선(예상 못 한 예외)은 main.py가 맡습니다.

    켜져 있지 않으면(``TOSS_ACCOUNT_ENABLED``) 토스를 한 번도 부르지 않습니다.
    """
    if not settings.toss_account_enabled():
        return empty_view(enabled=False, reason="disabled")
    if not toss.has_credentials():
        return empty_view(enabled=True, reason="not-configured")
    view = _cached_view(_monotonic())
    if view is not None:
        return view
    if not _refresh_lock.acquire(blocking=False):
        return _in_flight_view(_monotonic())
    try:
        view = _cached_view(_monotonic())   # 확인과 잠금 사이에 다른 요청의 갱신이 끝났을 수 있습니다
        if view is not None:
            return view
        started = _monotonic()
        try:
            data = _refresh()
        except _Failure as failure:
            return _record_failure(failure)
        except Exception as exc:  # noqa: BLE001 — 예상 못 한 응답 형식·코드 결함. 예외 문구는 싣지 않습니다
            logger.warning("토스 계좌 갱신 중 예상 못 한 예외: %s", type(exc).__name__)
            return _record_failure(_Failure("internal"))
        return _record_success(data, started)
    finally:
        _refresh_lock.release()


def account_seq(*, stale: int | None = None, budget_seconds: float = REFRESH_BUDGET_SECONDS) -> int:
    """
    BROKERAGE 계좌가 정확히 하나일 때 그 accountSeq — 실제 매매(services/toss_trade, ADR 0028)가 계좌 헤더에 씁니다.

    기억한 값이 있으면 다시 부르지 않고 그 값을 씁니다(계좌 조회와 같은 칸). 찾기는 잠금 안에서 한 번에 하나이고, 기다린 쪽은
    앞선 쪽이 찾은 값을 씁니다. 값은 헤더로만 쓰고 응답·로그에 싣지 않습니다.

    :param stale: 토스가 ``account-not-found``로 거절한 값. 기억한 값이 아직 이것이면 버리고 /accounts를 다시 부릅니다
        (그사이 다른 쪽이 다시 찾았으면 그 값을 씀)
    :param budget_seconds: 찾기(/accounts 한 번)에 쓸 시간 상한
    :raises AccountUnavailable: 찾지 못함(계좌가 0개·2개 이상, 토스 실패, 시간 초과)
    """
    with _seq_lock:
        current = _state.account_seq
        if current is not None and current != stale:
            return current
        _state.account_seq = None
        try:
            seq = _discover(toss._http(), _monotonic() + budget_seconds)
        except _Failure as failure:
            raise AccountUnavailable(failure.reason, failure.code) from None
        _state.account_seq = seq
        return seq


# ==============================================================================
# 호출 — 모두 toss._authorized_get(GET) 한 길
# ==============================================================================
def _reissue_codes() -> frozenset[str]:
    last = _state.last_reissue
    if last is not None and _monotonic() - last < REISSUE_WINDOW_SECONDS:
        return frozenset()   # 10분 안에 이미 한 번 — 이번 401은 토큰을 버리지 않고 auth-failed
    return REISSUE_CODES


def _note_reissue() -> None:
    _state.last_reissue = _monotonic()


def _classify(exc: toss.TossError, deadline: float) -> _Failure:
    """토스 오류 → 갱신 실패 사유. ``status``·``code`` 속성만 봅니다(메시지에는 토스 message가 들어 있음)."""
    status, code = exc.status, exc.code
    if isinstance(exc, toss.TossMissingKey):
        return _Failure("not-configured")
    if isinstance(exc, toss.TossReadOnlyViolation):
        return _Failure("internal")
    if code == "token-ip-denied":
        return _Failure("ip-not-allowed")
    if code == "token-failed":
        return _Failure("auth-failed")
    if status == 403:
        return _Failure("ip-not-allowed" if code == "ip-not-allowed" else "upstream-error", code)
    if status == 401:
        return _Failure("auth-failed", code)
    if status == 429:
        return _Failure("rate-limited", code)
    if code == "account-not-found":   # 엔드포인트마다 400·404로 다르게 옴 — 상태가 아니라 code로
        return _AccountNotFound("no-account", code)
    if status is None and _monotonic() >= deadline:
        return _Failure("timeout")
    return _Failure("upstream-error", code)


def _call(session, path: str, params: dict | None, seq: int | None, deadline: float):
    remaining = deadline - _monotonic()
    if remaining <= 0:
        raise _Failure("timeout")
    # 실제 매매(toss_trade)와 함께 쓰는 그룹별 속도 조절(ADR 0028) — 기다림이 상한(남은 예산)을 넘으면 보내지 않음
    if not toss_ratelimit.acquire(toss_ratelimit.group_for("GET", path),
                                  min(toss_ratelimit.MAX_WAIT_SECONDS, remaining)):
        raise _Failure("rate-limited")
    headers = {toss.ACCOUNT_HEADER: str(seq)} if seq is not None else None
    timeout = (min(CONNECT_TIMEOUT_SECONDS, remaining), min(READ_TIMEOUT_SECONDS, remaining))
    try:
        return toss._authorized_get(session, path, params, timeout, headers, reissue_codes=_reissue_codes(),
                                    retry_on_429=False, on_reissue=_note_reissue,
                                    remaining=lambda: deadline - _monotonic())
    except toss.TossError as exc:
        raise _classify(exc, deadline) from None


def _discover(session, deadline: float) -> int:
    """BROKERAGE 계좌가 정확히 하나일 때 그 accountSeq. ``accountNo``는 읽지 않습니다."""
    result = _call(session, "/api/v1/accounts", None, None, deadline)
    if not isinstance(result, list):
        raise _Failure("upstream-error")
    brokerage = [item for item in result if isinstance(item, dict) and item.get("accountType") == ACCOUNT_TYPE]
    if len(brokerage) != 1:
        raise _Failure("no-account", account_count=len(brokerage))
    value = brokerage[0].get("accountSeq")
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and _ACCOUNT_SEQ.fullmatch(value):
        return int(value)
    raise _Failure("upstream-error")


def _order_page(result) -> tuple[list, str | None, bool]:
    if not isinstance(result, dict) or not isinstance(result.get("orders"), list):
        raise _Failure("upstream-error")
    cursor = result.get("nextCursor")
    return result["orders"], (cursor if isinstance(cursor, str) and cursor else None), result.get("hasNext") is True


def _fetch(session, seq: int, deadline: float, closed_from: str) -> tuple:
    """holdings 1 + buying-power 2 + orders OPEN 1 + CLOSED 1~3. 하나라도 실패하면 _Failure — 받은 것은 버립니다."""
    holdings = _call(session, "/api/v1/holdings", None, seq, deadline)
    buying = {}
    for _side, currency, _key in SIDES:
        buying[currency] = _call(session, "/api/v1/buying-power", {"currency": currency}, seq, deadline)
    open_orders, _cursor, _more = _order_page(_call(session, "/api/v1/orders", {"status": "OPEN"}, seq, deadline))
    closed: list = []
    truncated = False
    cursor = None
    for page in range(CLOSED_MAX_PAGES):
        params = {"status": "CLOSED", "from": closed_from, "limit": CLOSED_PAGE_LIMIT}
        if cursor:
            params["cursor"] = cursor
        orders, cursor, more = _order_page(_call(session, "/api/v1/orders", params, seq, deadline))
        closed.extend(orders)
        if not more:
            break
        if cursor is None or page == CLOSED_MAX_PAGES - 1:
            truncated = True   # 토스에 더 남았는데 끊음(3쪽 상한, 또는 다음 커서가 없음)
            break
    return holdings, buying, open_orders, closed, truncated


def _refresh() -> dict:
    deadline = _monotonic() + REFRESH_BUDGET_SECONDS
    session = toss._http()
    closed_from = (_now().date() - timedelta(days=CLOSED_LOOKBACK_DAYS)).isoformat()
    seq = _state.account_seq
    may_rediscover = seq is not None   # 이번 갱신에서 막 찾은 accountSeq면 다시 찾아도 같음
    if seq is None:
        seq = _state.account_seq = _discover(session, deadline)
    while True:
        try:
            raw = _fetch(session, seq, deadline, closed_from)
            break
        except _AccountNotFound as missing:
            _state.account_seq = None
            if not may_rediscover:
                raise _Failure("no-account", missing.code, account_count=1) from None
            may_rediscover = False
            seq = _state.account_seq = _discover(session, deadline)
    return _build(*raw, closed_from=closed_from)


# ==============================================================================
# 정리 — 허용 목록만, KRW·USD로 나눔
# ==============================================================================
def _text(node, path: tuple[str, ...]) -> str | None:
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, str) else None


def _buying_power(result, currency: str) -> str | None:
    if not isinstance(result, dict):
        raise _Failure("upstream-error")
    reported = result.get("currency")
    if isinstance(reported, str) and reported != currency:
        return None   # 다른 통화의 금액을 이 쪽에 싣지 않습니다
    return _text(result, ("cashBuyingPower",))


def _order_row(order: dict, names: dict[str, str]) -> dict:
    symbol = _text(order, ("symbol",))
    row = {"symbol": symbol, "name": names.get(symbol) if symbol else None}
    row.update((name, _text(order, path)) for name, path in ORDER_FIELDS)
    return row


def _unique(orders: list, seen: set[str]) -> list:
    """orderId로 중복을 뺍니다(먼저 본 쪽을 남김). id 없는 주문은 그대로 둡니다. orderId는 여기서만 읽습니다."""
    out = []
    for order in orders:
        order_id = order.get("orderId") if isinstance(order, dict) else None
        if isinstance(order_id, str) and order_id:
            if order_id in seen:
                continue
            seen.add(order_id)
        out.append(order)
    return out


def _ordered_at(row: dict) -> tuple[bool, float]:
    """정렬 키 — 읽을 수 있는 orderedAt이 먼저, 그 안에서 시각 순. 시간대가 없거나 읽을 수 없으면 맨 뒤."""
    value = row.get("orderedAt")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        parsed = None
    if parsed is None or parsed.tzinfo is None:
        return False, 0.0
    return True, parsed.timestamp()


def _build(holdings, buying: dict, open_orders: list, closed_orders: list, truncated: bool, *,
           closed_from: str) -> dict:
    if not isinstance(holdings, dict) or not isinstance(holdings.get("items"), list):
        raise _Failure("upstream-error")
    sides = {
        side: {
            "currency": currency,
            "buyingPower": _buying_power(buying.get(currency), currency),
            "summary": {name: _text(holdings, path + (price_key,)) for name, path in SUMMARY_FIELDS},
            "holdings": [], "openOrders": [], "closedOrders": [],
        }
        for side, currency, price_key in SIDES
    }
    unclassified = 0
    names: dict[str, str] = {}
    for item in holdings["items"]:
        if not isinstance(item, dict):
            unclassified += 1
            continue
        row = {name: _text(item, path) for name, path in HOLDING_FIELDS}
        if row["symbol"] and row["name"]:
            names.setdefault(row["symbol"], row["name"])
        side = _HOLDING_SIDE.get((row["marketCountry"], row["currency"]))
        if side is None:
            unclassified += 1   # 시장·통화가 어긋나거나 처음 보는 값 — 어느 쪽에도 넣지 않음
            continue
        sides[side]["holdings"].append(row)

    seen: set[str] = set()
    closed = _unique(closed_orders, seen)   # 같은 id가 두 쪽에 있으면 CLOSED를 남김
    for key, orders in (("closedOrders", closed), ("openOrders", _unique(open_orders, seen))):
        for order in orders:
            side = _ORDER_SIDE.get(_text(order, ("currency",)))
            if side is None:
                unclassified += 1
                continue
            sides[side][key].append(_order_row(order, names))
    for side in sides.values():
        side["closedOrders"].sort(key=_ordered_at, reverse=True)

    return {
        "accountCount": 1,
        "sides": sides,
        "closedFrom": closed_from,
        "closedTruncated": truncated,
        "unclassifiedCount": unclassified,
    }
