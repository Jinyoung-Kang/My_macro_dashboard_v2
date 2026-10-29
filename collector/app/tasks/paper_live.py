"""
app/tasks/paper_live.py
🧪 모의 매매 장중 평가 — 보유 종목의 최신 1분봉 가격(속도군 live: 정기 수집 없음).

운영자가 모의 매매 화면을 보는 정규장 동안에만 백엔드가 요청합니다(live 읽기 — 저장본이 60초보다 오래됐을 때). 결과는 화면의
'장중 평가 추정'에만 쓰이고 체결·스탑·확정 순자산·통계는 지금처럼 관측치(paper.quotes·paper.kr.quotes)와 확정 종가로 합니다 — 실험
조건을 바꾸지 않습니다.

범위는 백엔드 표 ``paper_positions``에서 읽은 보유 종목입니다(store.held_tickers — 읽기만). 이번에 받지 못한 종목은 직전 저장본의 같은
종목으로 잇고 ``isStale``을 붙입니다(봉 시각은 그대로라 백엔드가 장중 값으로 쓰지 않음). 전부 실패하면 EmptyResult로 저장본을 둡니다.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from .. import catalog, store
from ..services import market as market_service
from ..services import toss as toss_service

from .base import KST, EmptyResult, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)

US_SOURCE = "Yahoo(yfinance) 1분봉"
KR_SOURCE = "토스증권 1분봉"
# 토스 차트 그룹 초당 20회 — 보유 수십 종목이면 1초 남짓. 한국 관측치 태스크(KR_CANDLE_SPACING)와 같은 간격.
KR_SPACING_SECONDS = 0.1


def _has_price(entry: dict) -> bool:
    return isinstance(entry.get("price"), (int, float)) and entry["price"] > 0 and bool(entry.get("at"))


def _save(name: str, market: str, source: str, tickers: list[str], fresh: dict, reason: str | None) -> str:
    """받은 것(fresh)에 빠진 종목을 이어 붙여 저장하고 실행 결과 한 줄을 돌려줍니다. 받은 것이 하나도 없으면 EmptyResult."""
    if not fresh:
        raise EmptyResult(f"0/{len(tickers)} 종목 — 기존 저장본 유지" + (f" ({reason})" if reason else ""))
    missing = [t for t in tickers if t not in fresh]  # 이번에 받지 못한 종목(이어받기 전)
    carried = carry_over_missing(fresh, previous_payload(name).get("tickers"), tickers, reason, _has_price)
    store.put_snapshot(name, {
        "market": market,
        "source": source,
        "scope": len(tickers),
        "tickers": fresh,
        "missing": missing,
        "error": reason,
    })
    return f"{len(fresh) - len(carried)}/{len(tickers)} 종목" + carried_suffix(carried)


def task_paper_live_us() -> str:
    """🧪 미국 보유 종목의 최신 정규장 1분봉(Yahoo) → 스냅샷 paper.live.us."""
    tickers = store.held_tickers("US")
    if not tickers:
        raise EmptyResult("미국 계좌에 보유 종목이 없습니다 — 저장하지 않음")
    fresh, reason = market_service.latest_minute_prices(tickers)
    return _save(catalog.SNAP_PAPER_LIVE_US, "US", US_SOURCE, tickers, dict(fresh), reason)


def task_paper_live_kr() -> str:
    """🧪 한국 보유 종목의 최신 1분봉(토스, 원시가) → 스냅샷 paper.live.kr. 봉 시각은 KST 날짜·시각을 ISO(+09:00)로."""
    tickers = store.held_tickers("KR")
    if not tickers:
        raise EmptyResult("한국 계좌에 보유 종목이 없습니다 — 저장하지 않음")
    fresh: dict[str, dict] = {}
    failed: list[str] = []
    for index, code in enumerate(tickers):
        if index and KR_SPACING_SECONDS:
            time.sleep(KR_SPACING_SECONDS)
        try:
            candles, _ = toss_service.fetch_candles(code, "1m", 1, adjusted=False)
        except toss_service.TossMissingKey as exc:
            raise EmptyResult(f"토스 키 없음 — 기존 저장본 유지 ({exc})") from exc
        except toss_service.TossForbidden as exc:
            failed.append(f"{code} 거부됨")
            logger.warning("장중 1분봉 403 (%s): %s — 나머지는 묻지 않음", code, exc)
            break
        except toss_service.TossError as exc:
            failed.append(f"{code} {exc}")
            continue
        if not candles:
            failed.append(f"{code} 봉 없음")
            continue
        bar = candles[0]
        at = datetime.fromisoformat(f"{bar['date']}T{bar['time']}:00").replace(tzinfo=KST)
        fresh[code] = {"price": float(bar["close"]), "at": at.astimezone(timezone.utc).isoformat()}
    reason = None
    if failed:
        reason = f"받지 못함 {len(failed)}개({'; '.join(failed[:3])}{'…' if len(failed) > 3 else ''})"
    return _save(catalog.SNAP_PAPER_LIVE_KR, "KR", KR_SOURCE, tickers, fresh, reason)
