"""
app/yahoo.py
yfinance(Yahoo) 요청을 태스크 시간 예산과 무응답 래치 안에 둡니다(QA-255).

yfinance는 자기 curl_cffi 세션(프로세스에 하나 — ``yfinance.data.YfData`` 싱글턴)으로 Yahoo에 가서, 공용 requests 세션의 예산 층
(http._GuardedAdapter·_BudgetRetry)을 거치지 않았습니다. 출처가 연결만 받고 응답하지 않으면 crumb 받기(30초)·시간대 조회(10초)·시세
요청이 폴백마다 되풀이돼, 예산 15초인 호출이 130초(매크로 카드 4장은 400초) 걸렸고 태스크는 상한 뒤에도 좀비로 남았습니다.

1) 예산 — 그 싱글턴의 세션 자리에 :class:`BudgetedSession`을 넣습니다(``yf.download``에는 :func:`session`을 넘겨야 그 자리가 유지됨). 요청마다 지금 태스크의 남은 시간(``http.time_left``)에서
   ``http.RETRY_RESERVE_SECONDS``를 뺀 만큼으로 timeout을 줄이고, 그만큼(최소 ``http.MIN_REQUEST_TIMEOUT``)도 남지 않았으면 보내지
   않고 바로 실패합니다(:class:`YahooBudgetExhausted`). 태스크 밖(/live/*·종목 상세 — 예산 없음)은 timeout을 줄이지 않습니다.
2) 다운로드 스레드 — ``yf.download(threads=True)``는 multitasking 라이브러리로 종목마다 스레드를 따로 띄워, contextvars(태스크 예산)가
   넘어가지 않았습니다. 그 풀의 스레드 종류를 '만든 쪽의 contextvars를 복사해 그 안에서 도는 스레드'로 바꿉니다. 배치 안의 종목
   요청도 그 태스크의 예산을 봅니다(순서대로 받게 ``threads=False``로 바꾸면 종목 수만큼 느려져 쓰지 않음).
3) 무응답 래치 — Yahoo 요청이 연달아 ``NO_RESPONSE_LIMIT``번 시간 초과로 끝나면 ``NO_RESPONSE_LATCH_SECONDS`` 동안 Yahoo로 보내지 않고
   바로 실패합니다(:class:`YahooNoResponse`). 응답이 하나라도 오면(상태 코드와 상관없이) 셈을 비웁니다. 예산이 없는 화면 경로도
   이 동안은 기다리지 않습니다. 출처 거부 래치(``http.YAHOO_HOST`` — 403·429)와 따로 둡니다: 응답 없음은 거부가 아니라 실행 기록에
   '거부됨'으로 적지 않습니다.

남는 것: crumb 잠금(``YfData._cookie_lock``, 프로세스에 하나)을 기다리는 동안은 예산을 보지 않습니다. 잠금을 쥔 쪽의 요청이 예산·래치로
짧아지므로 기다림도 그만큼 짧아집니다. 두 예외는 curl_cffi ``Timeout``의 하위라, yfinance는 진짜 시간 초과와 같게 다룹니다
(crumb 없이 계속 → 요청 실패 → 그 종목 실패).
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


class YahooBudgetExhausted(curl_exceptions.Timeout):
    """태스크 시간 예산이 요청 하나도 못 보낼 만큼 남음 — 보내지 않았습니다."""


class YahooNoResponse(curl_exceptions.Timeout):
    """Yahoo가 연달아 응답하지 않아 잠시 닫혀 있음 — 보내지 않았습니다."""


_lock = threading.Lock()
_timeouts_in_row = 0
_closed_until: float | None = None


def _now() -> float:
    return time.monotonic()


def _check_latch() -> None:
    global _closed_until
    with _lock:
        if _closed_until is None:
            return
        left = _closed_until - _now()
        if left <= 0:
            _closed_until = None
            logger.info("Yahoo 무응답 래치 기한이 지나 다시 요청합니다")
            return
    raise YahooNoResponse(f"Yahoo 응답 없음 — 연달아 {NO_RESPONSE_LIMIT}번 시간 초과, {left:.0f}초 더 Yahoo 요청을 멈춤")


def _note_timeout() -> None:
    global _timeouts_in_row, _closed_until
    with _lock:
        _timeouts_in_row += 1
        if _timeouts_in_row < NO_RESPONSE_LIMIT or _closed_until is not None:
            return
        _closed_until = _now() + NO_RESPONSE_LATCH_SECONDS
        count = _timeouts_in_row
    logger.warning("Yahoo가 연달아 %d번 응답하지 않아 %d초 동안 Yahoo 요청을 멈춥니다", count, int(NO_RESPONSE_LATCH_SECONDS))


def _note_response() -> None:
    global _timeouts_in_row
    with _lock:
        _timeouts_in_row = 0


def reset_for_tests() -> None:
    """래치와 셈을 비웁니다. 시험 사이의 격리용입니다 — 운영에서는 기한과 응답으로만 풉니다."""
    global _timeouts_in_row, _closed_until
    with _lock:
        _timeouts_in_row = 0
        _closed_until = None


def _fit(timeout, default, allowed: float):
    """
    요청 timeout을 ``allowed``초 안으로 줄입니다. curl_cffi의 숫자 timeout은 요청 전체 상한이고, (연결, 읽기)는 둘을 같은 비율로 줄입니다.
    넘기지 않은 값(curl_cffi NOT_SET)은 세션 기본값(``default``)으로, 없음(None — 끝없이 기다림)은 ``allowed`` 전부로 봅니다.
    """
    if not (timeout is None or isinstance(timeout, (int, float, tuple))) or isinstance(timeout, bool):
        timeout = default
    if timeout is None:
        return allowed
    if isinstance(timeout, tuple) and len(timeout) == 2:
        connect, read = (allowed if part is None else float(part) for part in timeout)
        total = connect + read
        if total <= allowed:
            return (connect, read)
        scale = allowed / total
        return (connect * scale, read * scale)
    if isinstance(timeout, (int, float)):
        return min(float(timeout), allowed)
    return allowed


class BudgetedSession(curl_requests.Session):
    """yfinance가 쓰는 curl_cffi 세션 — 보내기 전 무응답 래치·태스크 예산을 보고, 받은 뒤 래치의 셈을 고칩니다(모듈 설명 1·3)."""

    def request(self, method, url, *args, **kwargs):
        _check_latch()
        left = http.time_left()
        if left is not None:
            allowed = left - http.RETRY_RESERVE_SECONDS
            if allowed < http.MIN_REQUEST_TIMEOUT:
                raise YahooBudgetExhausted(f"태스크 시간 예산이 {max(left, 0.0):.0f}초 남아 Yahoo 요청을 보내지 않음")
            kwargs["timeout"] = _fit(kwargs.get("timeout", self.timeout), self.timeout, allowed)
        try:
            response = super().request(method, url, *args, **kwargs)
        except (YahooBudgetExhausted, YahooNoResponse):
            raise
        except curl_exceptions.Timeout:
            _note_timeout()
            raise
        _note_response()
        return response


class _ContextThread(threading.Thread):
    """만드는 스레드의 contextvars를 복사해 그 안에서 target을 돕니다 — 태스크 예산이 yf.download의 종목 스레드로 넘어갑니다(모듈 설명 2)."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._context = contextvars.copy_context()

    def run(self) -> None:
        self._context.run(super().run)


_session: BudgetedSession | None = None
_install_lock = threading.Lock()


def session() -> BudgetedSession:
    """
    yfinance에 넘길 세션(프로세스에 하나). ``yf.download``에는 꼭 ``session=yahoo.session()``으로 넘깁니다 — 넘기지 않으면 yfinance 1.7.0이
    부를 때마다 새 기본 세션을 만들어 싱글턴의 세션을 바꿔 버립니다(multi._download_impl). ``Ticker``·``Search``는 넘기지 않으면 싱글턴을
    그대로 씁니다. 저장소의 ``yf.download`` 호출은 시험(test_yahoo_budget)이 훑습니다.
    """
    install()
    assert _session is not None
    return _session


def install() -> None:
    """yfinance의 세션과 다운로드 스레드 종류를 바꿉니다. 여러 번 불러도 한 번만 합니다(app.services를 가져올 때 부름)."""
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
    """multitasking 풀(yfinance.multi가 가져올 때 만듦)의 스레드 종류를 :class:`_ContextThread`로. 모양이 다르면 경고만 남깁니다."""
    try:
        import multitasking
        import yfinance.multi  # noqa: F401 — 가져올 때 @multitasking.task가 기본 풀을 만듭니다

        pools = multitasking.config["POOLS"]
        patched = 0
        for pool in pools.values():
            if pool.get("engine") is threading.Thread:
                pool["engine"] = _ContextThread
                patched += 1
            elif pool.get("engine") is _ContextThread:
                patched += 1
    except Exception as exc:  # noqa: BLE001 — 라이브러리 내부가 바뀌어도 수집은 계속합니다(예산만 종목 스레드에 안 넘어감)
        logger.warning("yfinance 다운로드 스레드에 태스크 예산을 넘기지 못합니다(multitasking 구조 변경?): %s", exc)
        return
    if not patched:
        logger.warning("yfinance 다운로드 스레드에 태스크 예산을 넘기지 못합니다 — multitasking 스레드 풀이 없습니다")
