"""
app/verification.py
교차 검증용 읽기 — 같은 수치를 서로 다른 출처에서 읽어 **원자료 그대로** 돌려줍니다.

[무엇을 하나]
KOSPI200 지수·선물, 코스피, 원/달러 환율, 수급 1위 종목을 KRX·KIS·토스·yfinance·Daum에서
각각 읽습니다. 출처마다 ok·value·asOf(기준일)·detail(사람이 읽는 설명)을 담습니다.

[왜 판정은 여기서 하지 않나]
일치/불일치 판정은 백엔드(Java)의 VerificationService가 합니다. 판정 규칙(허용 오차, 장 시간
게이트, "확인 못 함"과 "일치"를 섞지 않기)을 한 곳에 모아 두기 위해서입니다.

main.py에 있던 코드를 그대로 옮겼습니다(C1). 동작은 같고, tests/test_verify_readings.py가 고정합니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from . import kst, settings
from .services import (
    kis as kis_service,
    krx as krx_service,
    market as market_service,
    radar as radar_service,
    toss as toss_service,
)

KST = kst.KST


def readings(market: str = "KOSPI", investor: str = "외국인", trade_type: str = "순매수") -> dict:
    """
    출처별 원자료.

    :param market: 수급 1위를 읽을 시장 (KOSPI·KOSDAQ)
    :param investor: 투자자 (외국인·기관 …)
    :param trade_type: 매매 구분 (순매수·순매도)
    :returns: checkedAt · keys(키 설정 여부) · 출처별 읽기 결과
    """
    now = datetime.now(KST)
    top_row = _top_ranking_row(market, investor, trade_type, now)

    return {
        "checkedAt": now.isoformat(),
        "keys": {
            "krx": bool(settings.krx_key()),
            "kis": kis_service.has_credentials(),
            "toss": toss_service.has_credentials(),
        },
        "kisFutures": kis_service.fetch_kospi200_futures(),
        "kisIndex": kis_service.fetch_index_close(),
        "krxIndex": _krx_index_reading(),
        "yfinanceIndex": _yfinance_index_reading(),
        "rankingTop": top_row,
        # 토스증권 공식 — 코스피 종합지수·환율 (KOSPI200은 토스 심볼 카탈로그에 없습니다)
        "tossKospi": toss_service.verification_reading(
            lambda: toss_service.fetch_index_daily_close("KOSPI"), "코스피 일봉"),
        "kisKospi": kis_service.fetch_index_close(kis_service.INDEX_CODE_KOSPI),
        "yfinanceKospi": _yfinance_index_reading("^KS11"),
        "tossUsdKrw": toss_service.verification_reading(toss_service.fetch_usdkrw_mid, "환율"),
    }


def _krx_index_reading() -> dict:
    """확정치는 하루 지연될 수 있어 최근 영업일을 며칠 거슬러 봅니다."""
    if not settings.krx_key():
        return {"ok": False, "value": None, "detail": "KRX api_key가 없습니다."}

    today = datetime.now(KST).date()
    for back in range(0, 7):
        day = today - timedelta(days=back)
        value = krx_service.fetch_kospi200_index_close(day.strftime("%Y%m%d"))
        if value:
            # asOf는 판정에 쓰입니다(백엔드가 기준일이 다른 값을 비교하지 않도록).
            # detail은 사람이 읽는 문구, asOf는 기계가 읽는 날짜로 나눠 둡니다.
            return {
                "ok": True,
                "value": float(value),
                "asOf": day.isoformat(),
                "detail": f"기준일 {day.isoformat()}",
            }
    return {"ok": False, "value": None, "detail": "최근 7일 안에 확정 지수가 없습니다."}


def _yfinance_index_reading(ticker: str = "^KS200") -> dict:
    """제3의 참고 출처. 공식은 아니지만 두 공식 출처가 갈릴 때 표를 던집니다."""
    payload = market_service.collect_ticker(ticker, "5d")
    points = [p for p in payload.get("points", []) if p.get("close")]
    if not points:
        return {
            "ok": False,
            "value": None,
            "detail": f"{ticker} 조회 실패{_reason(payload)}",
        }

    last = points[-1]
    as_of = str(last.get("date") or "")[:10] or None
    return {
        "ok": True,
        "value": float(last["close"]),
        "asOf": as_of,
        "detail": f"{ticker} (참고{', 기준일 ' + as_of if as_of else ''})",
    }


def _reason(payload: dict) -> str:
    error = payload.get("error")
    return f" — {error}" if error else ""


def _top_ranking_row(market: str, investor: str, trade_type: str, now: datetime) -> dict:
    """
    KIS 가집계와 Daum이 말하는 '1위 종목'을 각각 읽습니다.

    주의: 가격·지수와 시간 조건이 **정반대**입니다. KIS 가집계 TR은 장중 전용이라
    마감 후에는 빈 데이터가 정상입니다. 그래서 이 대조는 정규장에만 가능합니다.
    """
    date_str = now.strftime("%Y%m%d")

    def read(fetch, label: str) -> dict:
        try:
            rows = fetch(date_str, market, investor, trade_type, 10)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "source": label, "detail": str(exc)[:200]}
        if not rows:
            return {"ok": False, "source": label, "detail": "빈 결과"}
        top = rows[0]
        return {
            "ok": True,
            "source": label,
            "name": top.get("name"),
            "code": top.get("code"),
            "value": top.get("netAmountEok"),
        }

    return {
        "isRegularSession": radar_service.is_regular_session(now),
        "kis": read(kis_service.fetch_deal_ranking, "KIS 장중 가집계"),
        "daum": read(
            lambda d, m, i, t, n: radar_service.fetch_daum_ranking(d, m, i, t, n, "TODAY"),
            "Daum (화면이 쓰는 값)",
        ),
    }
