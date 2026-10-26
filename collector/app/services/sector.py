"""
app/services/sector.py
섹터·자산군 ETF 종가 수집.

여러 티커를 한 요청으로 묶어 받습니다(yf.download). 티커마다 따로 부르면
20개 티커에 HTTP 왕복이 20번 생기고 Yahoo 레이트리밋에도 그만큼 노출됩니다.
배치에서 비어 온 티커만 개별로 다시 받습니다 — 상한(SINGLE_RETRY_MAX)까지, 하나씩, Yahoo 호스트 간격을 두고. 상한·멈춤으로
이번에 묻지 못한 티커는 다음 실행에서 먼저 묻습니다.
Yahoo가 429로 거부하면 공용 래치(http.YAHOO_HOST)를 닫아 남은 개별 요청을 멈추고, 래치가 닫혀 있는 동안에는 배치도
보내지 않습니다. 받지 못한 티커는 이유(빈 응답·거부됨·상한 밖)를 ``error``에 남깁니다 — 이어받기(isStale)는 태스크가 합니다.

수익률 매트릭스·모멘텀 순위 계산은 여기서 하지 않습니다. 백엔드(Java)가
저장된 종가로 계산합니다. 수집기는 "받아서 적재", 백엔드는 "계산"으로
역할을 나눠 두면 같은 원본에서 두 결과가 갈라지는 일이 없습니다.
"""
from __future__ import annotations

import logging

import pandas as pd
import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from .. import http, yfcache

from ..http import brief_error

logger = logging.getLogger(__name__)

# 병렬 수집 전에 캐시 폴더를 만들어 둡니다 (yfcache 참고).
yfcache.configure()

# 배치에서 비어 온 티커를 개별로 다시 받는 최대 수(호출 한 번). 배치가 통째로 비면(Yahoo 차단·형식 변경) 유니버스 전체
# (600여 종목)를 하나씩 다시 묻게 되는데, 그 요청이 차단을 늘리기만 합니다. 넘는 티커는 다음 실행으로 넘깁니다.
SINGLE_RETRY_MAX = 30
# 배치도 개별 재시도도 한 종목을 받지 못한 채 개별 재시도가 이만큼 연달아 실패하면 나머지를 멈춥니다 — 출처가 지금 주지 않는
# 것으로 봅니다. 배치가 무엇이든 줬으면 출처는 살아 있으므로(연달아 비는 것은 폐지 티커) 상한까지 묻습니다.
SINGLE_RETRY_STOP_AFTER = 5
# 태스크 시간 예산이 이보다 적게 남으면 개별 재시도를 멈춥니다(받은 것을 저장할 시간).
SINGLE_RETRY_RESERVE_SECONDS = 15.0
# 개별 요청 사이 간격(Yahoo 호스트 하나, 지터는 http.HOST_JITTER_MAX).
YAHOO_SINGLE_INTERVAL = 0.3

NO_USABLE_DATA = "빈 응답(쓸 수 있는 종가 없음)"

# 개별 재시도를 다음에 시작할 티커 — (period, 유니버스)별, 프로세스 메모리. 상한·멈춤으로 이번에 묻지 못한 티커가 다음 실행에서
# 먼저 차례를 받습니다. 대기열이 늘 유니버스 순서 그대로면, 늘 비는 폐지 티커가 앞을 차지할 때 그 뒤에서 배치가 잠깐 놓친 티커는
# 개별 재시도를 영영 받지 못합니다. 다 물었으면 지웁니다(다음 실행은 다시 유니버스 순서).
_retry_resume: dict[tuple[str, tuple[str, ...]], str] = {}


def collect_etf_history(tickers: tuple[str, ...], period: str = "2y") -> dict:
    """
    반환 계약(JSON):
    {"tickers": {"XLK": {"dates": ["2026-01-02", ...], "close": [123.4, ...]}},
     "error": 받지 못한 티커가 있으면 그 이유 한 줄(이유별로 묶음, '거부됨' 먼저), 다 받았으면 None}

    종가만 저장합니다. OHLCV 전체는 화면이 쓰지 않는데 저장량만 커집니다.
    """
    symbols = [t for t in dict.fromkeys(tickers) if t]
    if not symbols:
        return {"tickers": {}, "error": "요청된 티커가 없습니다"}

    # 다른 태스크(같은 Yahoo 한도를 나눠 씀)가 방금 거부를 받았으면 배치도 보내지 않습니다 — 같은 답이 올 뿐입니다.
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return {"tickers": {}, "error": str(latched)}

    frames: dict[str, pd.DataFrame] = {}
    failed: dict[str, str] = {}       # 티커 → 받지 못한 이유
    batch_error: str | None = None

    try:
        raw = yf.download(
            tickers=" ".join(symbols),
            period=period,
            interval="1d",
            auto_adjust=True,
            actions=False,
            progress=False,
            group_by="ticker",
            threads=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("ETF 배치 수집 실패, 개별 수집으로 폴백합니다: %s", exc)
        batch_error = f"배치 {brief_error(exc)}"
        raw = None

    if raw is not None and not raw.empty:
        for symbol in symbols:
            try:
                if isinstance(raw.columns, pd.MultiIndex):
                    if symbol not in raw.columns.get_level_values(0):
                        continue
                    frame = raw[symbol].dropna(how="all")
                else:
                    frame = raw.dropna(how="all")
                if not frame.empty and "Close" in frame.columns:
                    frames[symbol] = frame
            except Exception as exc:  # noqa: BLE001
                logger.warning("ETF 배치 결과 분해 실패 (%s): %s", symbol, exc)

    missing = [t for t in symbols if t not in frames]
    if missing:
        logger.info("ETF 개별 재시도: %d개(상한 %d) %s", len(missing), SINGLE_RETRY_MAX, missing[:10])
        _retry_singles(missing, period, frames, failed, symbols)

    out: dict[str, dict] = {}
    for symbol in symbols:
        frame = frames.get(symbol)
        if frame is None:
            continue
        closes = frame["Close"].dropna()
        if closes.empty:
            failed[symbol] = NO_USABLE_DATA
            continue
        out[symbol] = {
            "dates": [pd.Timestamp(i).strftime("%Y-%m-%d") for i in closes.index],
            "close": [float(v) for v in closes.tolist()],
        }

    return {"tickers": out, "error": _error_text(out, failed, batch_error)}


def _retry_singles(missing: list[str], period: str, frames: dict, failed: dict[str, str], symbols: list[str]) -> None:
    """
    배치에서 빠진 티커를 하나씩 다시 받습니다(Vibe yfinance_loader의 '빈 슬라이스만 개별 재다운로드'). 받은 프레임은
    ``frames``에, 받지 못한 이유는 ``failed``에 적습니다.

    예전에는 빠진 티커 전부를 8스레드로 한꺼번에 보냈습니다. 배치가 통째로 비면 600여 요청이 몰려 차단을 늘렸고, 429를 받아도
    나머지가 계속 나갔습니다. 이제는 상한까지 하나씩, Yahoo 호스트 간격을 두고 보내며 아래에서 멈춥니다.
      - Yahoo 래치가 닫힘(이 호출이나 다른 태스크가 429를 받음) → 나머지는 '거부됨'
      - 배치·개별 모두 한 종목도 받지 못한 채 SINGLE_RETRY_STOP_AFTER번 연달아 실패 → 나머지는 다음 실행
      - 태스크 시간 예산이 SINGLE_RETRY_RESERVE_SECONDS보다 적게 남음 → 나머지는 다음 실행
    다음 실행은 이번에 묻지 못한 첫 티커부터 묻습니다(_retry_resume).

    :param symbols: 이번 호출의 유니버스(순서 그대로) — 다음 시작 자리의 기준
    """
    key = (period, tuple(symbols))
    ordered = _rotated(missing, symbols, _retry_resume.pop(key, None))
    queue = ordered[:SINGLE_RETRY_MAX]
    for symbol in ordered[SINGLE_RETRY_MAX:]:
        failed[symbol] = f"개별 재시도 상한({SINGLE_RETRY_MAX}개) 밖 — 다음 실행"
    if len(ordered) > SINGLE_RETRY_MAX:
        _retry_resume[key] = ordered[SINGLE_RETRY_MAX]

    # 배치가 쓸 수 있는 종가를 하나라도 줬으면 출처는 살아 있습니다 — 연달아 비는 개별 응답은 폐지 티커로 보고 멈추지 않습니다.
    received = sum(1 for frame in frames.values() if frame["Close"].notna().any())
    consecutive = 0
    for index, symbol in enumerate(queue):
        stop = _stop_reason(received, consecutive)
        if stop is not None:
            for rest in queue[index:]:
                failed[rest] = stop
            _retry_resume[key] = symbol
            logger.warning("ETF 개별 재시도 멈춤(%d개 남음): %s", len(queue) - index, stop)
            return
        http.pace(http.YAHOO_HOST, YAHOO_SINGLE_INTERVAL)
        try:
            frame = _fetch_single(symbol, period)
        except YFRateLimitError:
            failed[symbol] = str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)"))
            consecutive += 1
            continue
        except Exception as exc:  # noqa: BLE001 — 한 종목의 실패로 나머지를 멈추지 않습니다
            logger.warning("ETF 수집 실패 (%s): %s", symbol, exc)
            failed[symbol] = brief_error(exc)
            consecutive += 1
            continue
        if frame is None or frame.empty:
            failed[symbol] = NO_USABLE_DATA
            consecutive += 1
            continue
        frames[symbol] = frame
        failed.pop(symbol, None)
        received += 1
        consecutive = 0


def _rotated(missing: list[str], symbols: list[str], resume: str | None) -> list[str]:
    """``missing``(유니버스 순서)을 ``resume``의 유니버스 자리부터 한 바퀴 돌려 세웁니다. ``resume``이 없거나 유니버스 밖이면 그대로."""
    if resume is None or resume not in symbols:
        return missing
    position = {symbol: index for index, symbol in enumerate(symbols)}
    start = position[resume]
    return [t for t in missing if position[t] >= start] + [t for t in missing if position[t] < start]


def _stop_reason(received: int, consecutive: int) -> str | None:
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return str(latched)
    if not received and consecutive >= SINGLE_RETRY_STOP_AFTER:
        return f"개별 재시도가 {consecutive}번 연달아 실패해 멈춤 — 다음 실행"
    left = http.time_left()
    if left is not None and left < SINGLE_RETRY_RESERVE_SECONDS:
        return "태스크 시간 예산이 모자라 멈춤 — 다음 실행"
    return None


def _error_text(out: dict, failed: dict[str, str], batch_error: str | None) -> str | None:
    """
    받지 못한 티커의 이유 한 줄 — 이유별로 묶어 두 가지까지('거부됨'이 있으면 그것부터). 다 받았으면 None.

    태스크는 이 값을 상태 화면 detail과 이어받은 값의 staleReason에 씁니다. 예전에는 한 티커라도 받으면 None이라, 빠진 티커가
    왜 빠졌는지(폐지·차단) 어디에도 남지 않았습니다.
    """
    if not failed:
        return None
    groups: dict[str, list[str]] = {}
    for symbol, reason in failed.items():
        groups.setdefault(reason, []).append(symbol)
    ordered = sorted(groups.items(), key=lambda item: (http.REJECTED_MARK not in item[0], -len(item[1])))
    parts = [f"{reason}: {len(names)}개({', '.join(names[:3])}{'…' if len(names) > 3 else ''})"
             for reason, names in ordered[:2]]
    if not out and batch_error:
        parts.insert(0, batch_error)
    elif not out and all(reason == NO_USABLE_DATA or reason.startswith("개별 재시도") for reason in failed.values()):
        # ⚠️ yfinance는 Yahoo 응답 형식이 바뀌면 예외 없이 빈 프레임을 줍니다(예외도 429도 없음).
        # 사유가 없으면 "0/25 티커"만 남아 원인을 알 수 없습니다.
        silent = (f"yfinance({getattr(yf, '__version__', '?')})가 빈 응답을 받았습니다 "
                  "— Yahoo 차단 또는 라이브러리 버전 불일치를 의심하세요")
        if set(groups) == {NO_USABLE_DATA}:
            return silent
        parts.insert(0, silent)
    return "; ".join(parts)


# 이 함수는 사실 "야후 심볼 여러 개의 일별 종가"를 받는 일반 수집기입니다.
# 환율 비교 차트(KRW=X·JPY=X·DX-Y.NYB)도 같은 것이 필요합니다. 같은 코드를
# 한 벌 더 두면 배치 실패 폴백·빈 프레임 처리 같은 손질이 한쪽에만 들어가
# 조용히 갈라집니다. 이름만 하나 더 붙여 두고 구현은 하나로 둡니다.
collect_daily_closes = collect_etf_history


def _fetch_single(symbol: str, period: str) -> pd.DataFrame | None:
    frame = yf.Ticker(symbol).history(period=period, auto_adjust=True)
    if frame is None or frame.empty or "Close" not in frame.columns:
        return None
    return frame
