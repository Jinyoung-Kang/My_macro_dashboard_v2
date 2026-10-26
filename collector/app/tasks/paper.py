"""
app/tasks/paper.py
모의 알고리즘 매매(운영자 전용 기능)의 가격 수집 — 관측치(slow)·10년 이력(weekly).

태스크는 "받아서 저장"만 합니다. 체결·평가·스탑·분할 판단은 백엔드(feature/paper)가 저장본을 읽어 합니다 — 수집기가
장부를 건드리면 테이블마다 쓰는 프로세스가 하나라는 규칙(ADR 0008)이 깨집니다.

[두 저장본을 나눈 이유 — 명세 D23]
  paper.quotes            : 최근 3개월 일봉, 1시간마다. 장중에는 마지막 봉이 그 시각의 지연 시세라 장부 관측치가 됩니다.
  timeseries equity_close : 10년 일별 종가(수정주가), 12시간마다. 종목별 행이라 백엔드가 필요한 종목·기간만 읽습니다.
                            종가가 확정된 날짜(동부 마감 + 15분 뒤)까지만 씁니다 — 장중 봉은 관측치 쪽에만 있습니다.
10년 × 150여 종목을 스냅샷 하나에 넣으면 16MB 기준과 백엔드 힙을 넘었습니다(단계 0 측정).
"""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from .. import catalog, paper_universe, store
from ..services import sector as sector_service

from .base import EmptyResult, _reason_suffix, carried_suffix, carry_over_missing, previous_payload

logger = logging.getLogger(__name__)

NEW_YORK = ZoneInfo("America/New_York")
# 미국 정규장 마감(동부)과 '확정 종가'로 보는 여유. 백엔드 PaperMarketData.isFinal(마감 + FINAL_DELAY 15분)과 같은 기준이라야
# 이력(equity_close)과 관측치(paper.quotes) 어느 쪽에서 사후 체결가를 찾든 장중 값이 종가로 들어가지 않습니다.
US_CLOSE = time(16, 0)
FINAL_DELAY = timedelta(minutes=15)

# 10년 이력을 한 번에 받는 티커 수. yf.download는 받은 표 전체를 메모리에 올리므로(10년 ≈ 2,500행 × 티커) 유니버스가
# 1b에서 600여 종목으로 늘어 한 번에 다 받지 않게 나눕니다. 120개면 지금 유니버스(615개)는 여섯 번에 나눠 받습니다.
HISTORY_CHUNK = 120

# 실행 결과에 이름까지 적는 '받지 못한 티커' 수. 상태 화면 detail 길이(1000자)를 넘기지 않게 몇 개만 적습니다.
_MISSING_SHOWN = 5


def _has_bars(frame: dict) -> bool:
    return bool(frame.get("close")) and bool(frame.get("dates"))


def latest_final_date(now: datetime) -> str:
    """
    ``now`` 시점에 종가가 확정된 가장 늦은 미국 세션 날짜(YYYY-MM-DD, 동부 날짜). 동부 시각으로 마감 + 15분(16:15)이
    지났으면 오늘, 아니면 어제입니다. ``now``는 시간대가 있는 시각이어야 합니다(서버 TZ는 UTC, 화면은 KST라 날짜가 다를 수 있음).

    휴장일·주말은 따지지 않습니다 — 그날은 봉이 없으니 '그날까지 허용'이어도 쓸 행이 없습니다. 조기 폐장일(13:00 마감)도
    16:15까지 기다립니다. 백엔드 달력과 달리 조기 폐장을 몰라도, 확정 종가를 몇 시간 늦게 쓸 뿐 장중 값이 들어가는 쪽으로는
    틀리지 않습니다.
    """
    local = now.astimezone(NEW_YORK)
    today = local.date()
    final_at = datetime.combine(today, US_CLOSE, tzinfo=NEW_YORK) + FINAL_DELAY
    return (today if local >= final_at else today - timedelta(days=1)).isoformat()


def _now() -> datetime:
    """지금 시각. 테스트가 시계를 바꿔 끼우는 자리입니다."""
    return datetime.now(NEW_YORK)


def _held_back_suffix(held_back: set[str]) -> str:
    if not held_back:
        return ""
    return f" — {', '.join(sorted(held_back))} 봉은 장 마감 + 15분 전이라 쓰지 않음(장중 값)"


def _missing_suffix(missing: list[str]) -> str:
    """이어받지도 못하고 빠진 티커의 이름. 서비스의 error는 이유별로 묶어 이름을 몇 개만 싣기 때문에 따로 남깁니다."""
    if not missing:
        return ""
    shown = ", ".join(missing[:_MISSING_SHOWN]) + ("…" if len(missing) > _MISSING_SHOWN else "")
    return f" — 받지 못함 {len(missing)}개({shown})"


def task_paper_quotes() -> str:
    """
    📒 모의 매매 유니버스의 최근 3개월 일봉 → 스냅샷 paper.quotes (장부 관측치의 유일한 출처).

    빠진 티커는 직전 저장본의 같은 티커로 잇고 ``isStale``을 붙입니다 — 장부는 isStale 봉으로 체결하지 않고,
    보유 평가는 마지막으로 본 값으로 하되 '가격 없음'으로 표시합니다. 이어받을 값도 없으면 그 티커는 저장본에서 빠집니다
    (0으로 채우지 않습니다). 전부 실패하면 EmptyResult로 저장본을 그대로 둡니다.
    """
    tickers = paper_universe.tradable()
    raw = sector_service.collect_daily_closes(tickers, period=catalog.PAPER_QUOTES_PERIOD)
    frames = {ticker: frame for ticker, frame in (raw.get("tickers") or {}).items()
              if isinstance(frame, dict) and _has_bars(frame)}

    if not frames:
        raise EmptyResult(
            f"0/{len(tickers)} 티커 — 기존 저장본 유지"
            + _reason_suffix([raw.get("error")] if raw.get("error") else [])
        )

    fresh_count = len(frames)
    carried = carry_over_missing(
        frames, previous_payload(catalog.SNAP_PAPER_QUOTES).get("tickers"), tickers,
        raw.get("error"), _has_bars,
    )
    store.put_snapshot(catalog.SNAP_PAPER_QUOTES, {
        "period": catalog.PAPER_QUOTES_PERIOD,
        "tickers": frames,
        # 받으려던 목록. 저장본에 없는 티커가 '유니버스 밖'인지 '수집 실패'인지 백엔드·화면이 가를 수 있게 함께 둡니다.
        "universe": list(tickers),
    })
    missing = [ticker for ticker in tickers if ticker not in frames]
    detail = f"{fresh_count}/{len(tickers)} 티커" + carried_suffix(carried) + _missing_suffix(missing)
    if fresh_count < len(tickers) and raw.get("error"):
        detail += f" — 실패: {raw['error']}"
    return detail


def task_paper_price_history() -> str:
    """
    📒 모의 매매 유니버스의 10년 일별 종가(수정주가) → timeseries ``equity_close`` (series_id = 야후 티커).

    매번 10년 전체를 보냅니다. 수정주가는 배당·분할이 생길 때마다 **과거 값이 바뀌므로** 최근 구간만 보내면
    옛 값과 새 값이 한 시계열에 섞입니다. put_timeseries가 값이 같은 행은 다시 쓰지 않아 실제로 바뀌는 행은 그 몫뿐입니다.
    기존 행은 지우지 않습니다(upsert) — 이번에 받지 못한 티커·날짜는 전에 받은 값이 남습니다. 값이 없는 점(None·NaN)은
    put_timeseries가 거릅니다. 한 티커도 받지 못하면 EmptyResult.

    아직 확정되지 않은 오늘 세션의 봉(동부 16:15 전)은 쓰지 않습니다. 장중에 돌면 그 봉은 그 시각의 지연 시세인데, 백엔드는
    이 시계열의 값을 확정 종가로 믿고 사후 체결가(price_source=equity_close)와 분할 판정의 기준가로 씁니다. 다음 실행은
    최대 12시간 뒤라 그동안 장중 값이 '그날 종가'로 남습니다. 관측치(paper.quotes)는 반대로 장중 마지막 봉이 곧
    관측치이므로 이 규칙을 적용하지 않습니다 — 그쪽 확정 여부는 백엔드가 수집 시각으로 가립니다(isFinal).
    """
    tickers = paper_universe.history()
    # 실행 한 번에 한 번만 정합니다. 묶음마다 다시 재면 16:15를 걸친 실행에서 티커마다 기준이 달라집니다.
    final_through = latest_final_date(_now())
    received = 0
    points = 0
    missing: list[str] = []
    reasons: list[str | None] = []
    held_back: set[str] = set()

    for start in range(0, len(tickers), HISTORY_CHUNK):
        chunk = tickers[start:start + HISTORY_CHUNK]
        raw = sector_service.collect_daily_closes(chunk, period=catalog.PAPER_HISTORY_PERIOD)
        frames = raw.get("tickers") or {}
        reasons.append(raw.get("error"))
        for ticker in chunk:
            frame = frames.get(ticker)
            frame = frame if isinstance(frame, dict) else {}
            dates = frame.get("dates") or []
            closes = frame.get("close") or []
            if not dates or len(dates) != len(closes):
                # 날짜·값 길이가 다르면 어느 값이 어느 날짜인지 알 수 없어 그 티커를 통째로 건너뜁니다.
                if dates and len(dates) != len(closes):
                    reasons.append(f"{ticker}: 날짜 {len(dates)}개 · 종가 {len(closes)}개로 길이가 다름")
                missing.append(ticker)
                continue
            # 날짜는 거래소 현지(동부) 날짜 문자열이라 ISO 문자열 비교로 충분합니다. 앞 10자만 보는 것은 시각이 붙은
            # 표기("2026-10-23 00:00:00")가 와도 같은 날짜로 비교하기 위해서입니다.
            rows = []
            for day, close in zip(dates, closes):
                if str(day)[:10] > final_through:
                    held_back.add(str(day)[:10])
                else:
                    rows.append((day, close))
            written = store.put_timeseries(catalog.TS_EQUITY_CLOSE, ticker, rows)
            if written:
                received += 1
                points += written
            else:
                missing.append(ticker)

    if not received:
        raise EmptyResult(
            f"0/{len(tickers)} 티커 — 기존 이력 유지" + _reason_suffix(reasons)
        )
    return (f"{received}/{len(tickers)} 티커, 점 {points}개"
            + _missing_suffix(missing) + _held_back_suffix(held_back) + _reason_suffix(reasons))
