"""
app/yahoo.py
yfinance(Yahoo) 요청을 태스크 시간 예산과 무응답 래치 안에 둡니다(QA-255).

yfinance는 자기 curl_cffi 세션(프로세스에 하나 — ``yfinance.data.YfData`` 싱글턴)으로 Yahoo에 가서, 공용 requests 세션의 예산 층
(http._GuardedAdapter·_BudgetRetry)을 거치지 않았습니다. 출처가 연결만 받고 응답하지 않으면 crumb 받기(30초)·시간대 조회(10초)·시세
요청이 폴백마다 되풀이돼, 예산 15초인 호출이 130초(매크로 카드 4장은 400초) 걸렸고 태스크는 상한 뒤에도 좀비로 남았습니다.

1) 예산 — 그 싱글턴의 세션 자리에 :class:`BudgetedSession`을 넣습니다(``yf.download``에는 :func:`session`을 넘겨야 그 자리가 유지됨).
   요청마다 지금 태스크의 남은 시간(``http.time_left``)에서 ``http.RETRY_RESERVE_SECONDS``를 뺀 만큼으로 timeout을 줄이고, 그만큼(최소
   ``http.MIN_REQUEST_TIMEOUT``)도 남지 않았으면 보내지 않고 바로 실패합니다(:class:`YahooBudgetExhausted`). 태스크 밖(/live/*·종목
   상세 — 예산 없음)은 timeout을 줄이지 않습니다.
2) 다운로드 스레드 — ``yf.download(threads=True)``는 multitasking 라이브러리로 종목마다 스레드를 따로 띄워, contextvars(태스크 예산)가
   넘어가지 않았습니다. 그 풀의 스레드 종류를 '만든 쪽의 contextvars를 복사해 그 안에서 도는 스레드'로 바꿉니다(순서대로 받게
   ``threads=False``로 바꾸면 종목 수만큼 느려져 쓰지 않음). 그 풀의 동시 실행 자리(프로세스에 하나 — cpu_count, 운영 서버 2자리)도
   예산을 보며 기다립니다: 예산이 다 되도록 자리가 나지 않으면 자리 없이 들어가고, 그 종목의 요청은 1)에서 바로 실패합니다
   (예외로 끊으면 yfinance가 그 종목의 결과를 끝없이 기다림).
3) 무응답 래치 — Yahoo 요청이 연달아 ``NO_RESPONSE_LIMIT``번 시간 초과로 끝나면 ``NO_RESPONSE_LATCH_SECONDS`` 동안 Yahoo로 보내지 않고
   바로 실패합니다(:class:`YahooNoResponse`). 1)이 예산 때문에 줄인 timeout으로 끝난 요청은 세지 않습니다(출처가 아니라 그 태스크의
   남은 시간 때문). 응답이 하나라도 오면(5xx는 아래) 셈을 비우고 닫힌 래치도 풉니다. 기한이 지난 뒤 첫 요청이 또 시간 초과면
   바로 다시 닫습니다. 예산이 없는 화면 경로도 닫힌 동안은 기다리지 않습니다. 출처 거부 래치(``http.YAHOO_HOST`` — 403·429)와 따로
   둡니다: 응답 없음은 거부가 아니라 실행 기록에 '거부됨'으로 적지 않습니다.
   연결 실패(연결 거절·DNS·TLS·프록시 CONNECT 거절 — curl ``ConnectionError``·``ProxyError``)나 HTTP 5xx로 연달아 ``FAILURE_LIMIT``번
   끝나도 같은 래치를 닫습니다(QA-335, 사유 'Yahoo 연결 실패 — …'). yfinance는 crumb·쿠키를 받지 못하면(연결 실패도 5xx도) 요청마다
   전략을 바꿔(basic ↔ csrf) 다시 받고, 받은 응답이 4xx·5xx면 한 번 더 받은 뒤 다시 보내, 출처가 끊긴 동안 한 회차에 수천 번을
   보냈습니다(QA 스택 차단 프록시 실측 약 6,000번 — 시간 초과만 세던 래치는 닫히지 않았고 사유는 '빈 응답 — 버전 불일치를 의심'이었음).
   5xx 응답은 '응답이 옴'이지만 쓸 수 없는 답이라 시간 초과 셈만 비우고 닫힌 래치는 풀지 않으며, 2xx·3xx·4xx 응답(살아 있는 Yahoo
   — crumb 401 등)은 두 셈을 모두 비우고 닫힌 래치도 풉니다.

부르는 쪽(services.market·sector)은 보내기 전에 :func:`unavailable_reason`을 보고, 받은 표가 비었을 때도 이것을 먼저 사유로 씁니다 —
yfinance는 이 예외를 삼키고 빈 표를 돌려줘, 그대로 두면 사유가 '라이브러리 버전 불일치를 의심'으로 보였습니다. 두 예외는 curl_cffi
``Timeout``의 하위라 yfinance는 진짜 시간 초과와 같게 다룹니다(crumb 없이 계속 → 요청 실패 → 그 종목 실패).

남는 것: crumb 잠금(``YfData._cookie_lock``, 프로세스에 하나)을 기다리는 동안은 예산을 보지 않습니다. 잠금을 쥔 쪽이 예산 있는
태스크면 그 예산만큼, 예산 없는 화면 요청(종목 상세의 ``Ticker.info`` 등)이면 crumb을 새로 받을 때 최대 약 60초(쿠키 30초 + crumb 30초,
yfinance 고정값 — 그 뒤 시세 요청의 세 번째 시간 초과로 래치가 닫힘)를 기다릴 수 있습니다.
"""
from __future__ import annotations

import contextvars
import logging
import threading
import time

from curl_cffi import requests as curl_requests
from curl_cffi.requests import exceptions as curl_exceptions

from . import http

logger = logging.getLogger(__name__)

# 연달아 이만큼 시간 초과로 끝나면 Yahoo를 잠시 닫습니다. 배치(yf.download)는 종목 스레드가 함께 끝나 한 번에 여럿이 셀 수 있습니다.
NO_RESPONSE_LIMIT = 3
# 닫아 두는 시간 — fast 태스크 주기(5분)보다 짧아, 다음 주기에는 한 번 다시 물어봅니다.
NO_RESPONSE_LATCH_SECONDS = 120.0
# 연결 실패나 HTTP 5xx로 연달아 이만큼 끝나면 같은 래치를 닫습니다(QA-335 — 모듈 설명 3). crumb 받기 한 번이 실패 셋 안팎을 내므로(쿠키·crumb·
# 시세) 보통 첫 시세 요청 한두 번 안에 닫힙니다. 정상 Yahoo는 4xx·2xx로 답해 셈이 이어지지 않습니다.
FAILURE_LIMIT = 5
# 연결 실패로 세는 예외 — 응답을 받지 못한 것(시간 초과는 따로 셈). ProxyError는 ConnectionError의 하위가 아니라 따로 둡니다.
_CONNECTION_FAILURES = (curl_exceptions.ConnectionError, curl_exceptions.ProxyError)


class YahooBudgetExhausted(curl_exceptions.Timeout):
    """태스크 시간 예산이 요청 하나도 못 보낼 만큼 남음 — 보내지 않았습니다."""


class YahooNoResponse(curl_exceptions.Timeout):
    """Yahoo가 연달아 응답하지 않거나(시간 초과) 연결 오류·서버 오류로 끝나(QA-335) 잠시 닫혀 있음 — 보내지 않았습니다."""


_lock = threading.Lock()
_timeouts_in_row = 0
_failures_in_row = 0
_closed_until: float | None = None
# 닫힌 래치의 사유 머리(시간 초과·연결 실패) — 닫을 때 정합니다.
_closed_head: str | None = None


def _now() -> float:
    return time.monotonic()


def _timeout_head() -> str:
    return f"Yahoo 응답 없음 — 연달아 {NO_RESPONSE_LIMIT}번 시간 초과"


def _failure_head(last: str) -> str:
    return f"Yahoo 연결 실패 — 연달아 {FAILURE_LIMIT}번 연결 오류·서버 오류(마지막 {last})"


def _closed_message(left: float, head: str | None = None) -> str:
    return f"{head or _timeout_head()}, {left:.0f}초 더 Yahoo 요청을 멈춤"


def _budget_message(left: float) -> str:
    return f"태스크 시간 예산이 {max(left, 0.0):.0f}초 남아 Yahoo 요청을 보내지 않음"


def _closed_state() -> tuple[float, str] | None:
    """래치가 닫혀 있으면 (남은 초, 사유 머리), 아니면 None. 기한이 지난 래치는 여기서 풉니다."""
    global _closed_until, _closed_head
    with _lock:
        if _closed_until is None:
            return None
        left = _closed_until - _now()
        if left > 0:
            return left, _closed_head or _timeout_head()
        _closed_until = None
        _closed_head = None
    logger.info("Yahoo 래치(무응답·연결 실패) 기한이 지나 다시 요청합니다")
    return None


def closed_reason() -> str | None:
    """
    Yahoo 래치(무응답·연결 실패)가 닫혀 있으면 그 사유 한 줄, 아니면 None — 태스크 예산은 보지 않습니다. yfinance 밖의 길로 같은 Yahoo를 부르는
    태스크(미국 장중 스탑 감시의 spark — 공용 requests 세션, 예산은 그 층이 봄)가 봅니다(QA-335).
    """
    closed = _closed_state()
    return None if closed is None else _closed_message(*closed)


def _budget_left_if_short() -> float | None:
    """지금 태스크의 예산이 요청 하나도 못 보낼 만큼이면 그 남은 초, 아니면(또는 태스크 밖이면) None."""
    left = http.time_left()
    if left is not None and left - http.RETRY_RESERVE_SECONDS < http.MIN_REQUEST_TIMEOUT:
        return left
    return None


def unavailable_reason() -> str | None:
    """
    지금 Yahoo로 보내지 않을 이유 한 줄 — 무응답 래치가 닫혔거나 지금 태스크의 예산이 모자람. 보낼 수 있으면 None.

    부르는 쪽이 yfinance를 부르기 전과, 받은 표가 비었을 때 사유를 고르기 전에 봅니다(모듈 설명 맨 끝).
    """
    closed = closed_reason()
    if closed is not None:
        return closed
    short = _budget_left_if_short()
    if short is not None:
        return _budget_message(short)
    return None


def _note_timeout() -> None:
    global _timeouts_in_row, _closed_until, _closed_head
    with _lock:
        _timeouts_in_row += 1
        if _timeouts_in_row < NO_RESPONSE_LIMIT or _closed_until is not None:
            return
        _closed_until = _now() + NO_RESPONSE_LATCH_SECONDS
        _closed_head = _timeout_head()
        count = _timeouts_in_row
    logger.warning("Yahoo가 연달아 %d번 응답하지 않아 %d초 동안 Yahoo 요청을 멈춥니다", count, int(NO_RESPONSE_LATCH_SECONDS))


def _note_failure(what: str) -> None:
    """연결 실패·HTTP 5xx 한 번(``what`` — 예외 이름이나 'HTTP 502'). 연달아 FAILURE_LIMIT번이면 래치를 닫습니다(QA-335)."""
    global _failures_in_row, _closed_until, _closed_head
    with _lock:
        _failures_in_row += 1
        if _failures_in_row < FAILURE_LIMIT or _closed_until is not None:
            return
        _closed_until = _now() + NO_RESPONSE_LATCH_SECONDS
        _closed_head = _failure_head(what)
        count = _failures_in_row
    logger.warning("Yahoo 요청이 연달아 %d번 연결 오류·서버 오류(마지막 %s)로 끝나 %d초 동안 Yahoo 요청을 멈춥니다",
                   count, what, int(NO_RESPONSE_LATCH_SECONDS))


def _note_server_error(status: int) -> None:
    """HTTP 5xx 응답 — 응답은 왔으니 시간 초과 셈은 비우고, 쓸 수 없는 답이라 실패로 셉니다(닫힌 래치는 풀지 않음)."""
    global _timeouts_in_row
    with _lock:
        _timeouts_in_row = 0
    _note_failure(f"HTTP {status}")


def _note_response() -> None:
    global _timeouts_in_row, _failures_in_row, _closed_until, _closed_head
    with _lock:
        _timeouts_in_row = 0
        _failures_in_row = 0
        reopened = _closed_until is not None
        _closed_until = None
        _closed_head = None
    if reopened:
        logger.info("Yahoo가 다시 응답해 래치(무응답·연결 실패)를 풉니다")


def reset_for_tests() -> None:
    """래치와 셈을 비웁니다. 시험 사이의 격리용입니다 — 운영에서는 기한과 응답으로만 풉니다."""
    global _timeouts_in_row, _failures_in_row, _closed_until, _closed_head
    with _lock:
        _timeouts_in_row = 0
        _failures_in_row = 0
        _closed_until = None
        _closed_head = None


def _fit(timeout, default, allowed: float) -> tuple[float | tuple[float, float], bool]:
    """
    요청 timeout을 ``allowed``초 안으로 줄입니다 → (보낼 timeout, 줄였나). curl_cffi의 숫자 timeout은 요청 전체 상한이고, (연결, 읽기)는
    둘을 같은 비율로 줄입니다. 넘기지 않은 값(curl_cffi NOT_SET)은 세션 기본값(``default``)으로 보고, 없음(None)과 0 이하는 curl_cffi에서
    '끝없이 기다림'이라 ``allowed`` 전부로 봅니다.
    """
    if not (timeout is None or isinstance(timeout, (int, float, tuple))) or isinstance(timeout, bool):
        timeout = default
    if isinstance(timeout, tuple) and len(timeout) == 2:
        connect, read = (allowed if part is None or part <= 0 else float(part) for part in timeout)
        total = connect + read
        if total <= allowed:
            return (connect, read), False
        scale = allowed / total
        return (connect * scale, read * scale), True
    if isinstance(timeout, (int, float)) and timeout > 0:
        return (float(timeout), False) if timeout <= allowed else (allowed, True)
    return allowed, True


class BudgetedSession(curl_requests.Session):
    """yfinance가 쓰는 curl_cffi 세션 — 보내기 전 무응답 래치·태스크 예산을 보고, 받은 뒤 래치의 셈을 고칩니다(모듈 설명 1·3)."""

    def request(self, method, url, *args, **kwargs):
        closed = _closed_state()
        if closed is not None:
            raise YahooNoResponse(_closed_message(*closed))
        clamped = False
        left = http.time_left()
        if left is not None:
            allowed = left - http.RETRY_RESERVE_SECONDS
            if allowed < http.MIN_REQUEST_TIMEOUT:
                raise YahooBudgetExhausted(_budget_message(left))
            kwargs["timeout"], clamped = _fit(kwargs.get("timeout", self.timeout), self.timeout, allowed)
        try:
            response = super().request(method, url, *args, **kwargs)
        except (YahooBudgetExhausted, YahooNoResponse):
            raise
        except curl_exceptions.Timeout:
            if not clamped:          # 이 태스크의 남은 시간 때문에 끝난 것은 출처의 무응답이 아닙니다
                _note_timeout()
            raise
        except _CONNECTION_FAILURES as exc:
            _note_failure(type(exc).__name__)      # 연결 거절·프록시 CONNECT 거절·DNS·TLS(QA-335)
            raise
        status = getattr(response, "status_code", None)
        if isinstance(status, int) and status >= 500:
            _note_server_error(status)
        else:
            _note_response()
        return response


class _ContextThread(threading.Thread):
    """만드는 스레드의 contextvars를 복사해 그 안에서 target을 돕니다 — 태스크 예산이 yf.download의 종목 스레드로 넘어갑니다(모듈 설명 2)."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._context: contextvars.Context | None = contextvars.copy_context()

    def run(self) -> None:
        context, self._context = self._context, None     # multitasking이 끝난 스레드 객체를 계속 쥐므로 지난 태스크의 가드를 놓습니다
        if context is None:
            super().run()
        else:
            context.run(super().run)


class _BudgetedSlots:
    """
    multitasking 풀의 세마포어(``with pool:``)를 감쌉니다 — 태스크 안의 종목 스레드는 남은 예산(− RETRY_RESERVE_SECONDS)만큼만 자리를
    기다리고, 그래도 자리가 없으면 자리 없이 들어갑니다(모듈 설명 2). 태스크 밖(예산 없음)은 원래처럼 자리가 날 때까지 기다립니다.
    """

    def __init__(self, inner) -> None:
        self._inner = inner
        self._held = threading.local()

    def __enter__(self):
        left = http.time_left()
        if left is None:
            got = self._inner.acquire()
        else:
            got = self._inner.acquire(timeout=max(0.0, left - http.RETRY_RESERVE_SECONDS))
        stack = getattr(self._held, "stack", None)
        if stack is None:
            stack = self._held.stack = []
        stack.append(bool(got))
        return self

    def __exit__(self, *exc) -> bool:
        if self._held.stack.pop():
            self._inner.release()
        return False


_session: BudgetedSession | None = None
_install_lock = threading.Lock()


def session() -> BudgetedSession:
    """
    yfinance에 넘길 세션(프로세스에 하나). ``yf.download``에는 꼭 ``session=yahoo.session()``으로 넘깁니다 — 넘기지 않으면 yfinance 1.7.0이
    부를 때마다 새 기본 세션을 만들어 싱글턴의 세션을 바꿔 버립니다(multi._download_impl). ``Ticker``·``Search``는 넘기지 않으면 싱글턴을
    그대로 씁니다. 저장소의 yfinance 다운로드 호출은 시험(test_yahoo_budget)이 훑습니다.
    """
    install()
    assert _session is not None
    return _session


def install() -> None:
    """yfinance의 세션과 다운로드 스레드 종류·자리를 바꿉니다. 여러 번 불러도 한 번만 합니다(app.services를 가져올 때 부름)."""
    global _session
    with _install_lock:
        if _session is not None:
            return
        from yfinance.data import YfData

        made = BudgetedSession(impersonate="chrome")
        YfData(session=made)     # 싱글턴 — 이미 있으면 세션만 바꿈
        _patch_download_threads()
        _session = made


def _patch_download_threads() -> None:
    """
    multitasking 풀(yfinance.multi가 가져올 때 만듦)의 스레드 종류를 :class:`_ContextThread`로, 자리 세마포어를 :class:`_BudgetedSlots`로.
    모양이 다르면 경고만 남깁니다(그때는 종목 스레드가 예산을 보지 않을 뿐 수집은 그대로).
    """
    try:
        import multitasking
        import yfinance.multi  # noqa: F401 — 가져올 때 @multitasking.task가 기본 풀을 만듭니다

        pools = multitasking.config["POOLS"]
        patched = 0
        for pool in pools.values():
            if pool.get("engine") is threading.Thread:
                pool["engine"] = _ContextThread
            if pool.get("engine") is _ContextThread:
                patched += 1
            slots = pool.get("pool")
            if slots is not None and not isinstance(slots, _BudgetedSlots):
                pool["pool"] = _BudgetedSlots(slots)
    except Exception as exc:  # noqa: BLE001 — 라이브러리 내부가 바뀌어도 수집은 계속합니다(예산만 종목 스레드에 안 넘어감)
        logger.warning("yfinance 다운로드 스레드에 태스크 예산을 넘기지 못합니다(multitasking 구조 변경?): %s", exc)
        return
    if not patched:
        logger.warning("yfinance 다운로드 스레드에 태스크 예산을 넘기지 못합니다 — multitasking 스레드 풀이 없습니다")
