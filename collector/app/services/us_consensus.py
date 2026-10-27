"""
app/services/us_consensus.py
🧪 미국 경제 지표 컨센서스 — 모의 매매 캘린더 컨센서스 층의 원자료(v2 2단계 명세 §4-12·K22·B9). **저장만** 합니다.

패킷 ``1b_calendar``에 싣는 것은 설정 ``calendar.consensus``를 한국 책 출발일에 켠 뒤이고(K22 — E1에서 연결), 그 전에는 어떤 패킷·화면도
이 저장본을 읽지 않습니다. 발표 날짜는 공식 출처(FRED·FOMC 상수)가 정하고, 컨센서스는 그 줄에 값만 붙이는 층입니다 — 이름 대응표
(Nasdaq 이름 ↔ FRED 릴리스)는 패킷을 만드는 E1이 정합니다. 수집기는 미국 행을 받은 그대로 남깁니다.

[출처 — Nasdaq ``api/calendar/economicevents``, ADR 0017과 같은 '비공식 참고']
- TradingView 경제 캘린더(``economic-calendar.tradingview.com/events``)는 이 PC에서 HTTP 403입니다(2026-10-26 두 번·10-27 한 번, 기본 요청).
  명세 §7 G11대로 머리글을 바꾼 재시도는 하지 않고(교체 뒤 서버에서 기본 요청 1회) Nasdaq만 씁니다(K22 'Nasdaq 먼저'). Nasdaq은 중요도를
  주지 않아 ``importance``는 null입니다.
- 응답: ``{data: {asOf, headers, rows: [{gmt, country, eventName, actual, consensus, previous, description}]}, message, status: {rCode}}``.
  행에 날짜가 없고, 값은 단위가 붙은 글자(``'1,728K'``·``'-130.80B'``·``'4.00%'``·``'80.5'``)이며 빈 값은 ``' '``·``'&nbsp;'``입니다.
- **``date=D``는 미국 동부 D−1의 행을 줍니다** — [확인] 2026-10-26 23:3x UTC: date=10-22 → 수 10-21(MBA·EIA 원유 재고), 10-23 → 목 10-22
  (실업수당 청구·천연가스 재고), 10-28 → 화 10-27(레드북·CB 소비자신뢰), 10-29 → 수 10-28(MBA·FOMC 성명). 그래서 동부 날짜 E의 행은
  date=E+1로 묻습니다(``QUERY_OFFSET_DAYS``). 이 어긋남이 바뀌면 날짜가 하루씩 밀리므로 태스크가 실업수당 청구(목요일 발표)로 확인합니다.
- ``gmt`` 칸은 이름과 달리 미국 동부 시각입니다([확인] FOMC 성명 14:00·실업수당 청구 08:30) — ``timeEt``.
- 브라우저 UA가 필요해(조사 기록) 공용 세션(``get_session``)을 씁니다. 403·429는 공용 거부 래치가 닫습니다(http.py).
- 응답 본문의 ``description``(제3자 설명문)은 저장하지 않습니다.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from ..http import brief_error, get_session

NASDAQ_URL = "https://api.nasdaq.com/api/calendar/economicevents"
SOURCE = "Nasdaq api/calendar/economicevents"
SOURCE_NOTE = ("비공식 참고(ADR 0017과 같은 지위) — 발표 날짜는 공식 출처(FRED·FOMC 상수)가 정하고 이 값은 같은 날 줄에 붙이는 층(명세 K22). "
               "저장만 하고 패킷은 calendar.consensus를 켠 뒤")

# 동부 날짜 E의 행은 date=E+QUERY_OFFSET_DAYS로 묻습니다(모듈 설명).
QUERY_OFFSET_DAYS = 1

US_COUNTRY = "United States"

# 요청 하나의 (연결, 읽기) 대기(초). 응답은 30KB 안팎입니다.
FETCH_TIMEOUT = (10, 20)

# TradingView를 쓰지 않는 이유(저장본 tradingView 칸) — 명세 §7 G11.
TRADINGVIEW_NOTE = {
    "status": "HTTP 403",
    "checkedAt": "2026-10-27",
    "note": "이 PC에서 기본 요청 403(2026-10-26 두 번·10-27 한 번) — 교체 뒤 서버에서 기본 요청 1회(G11), 머리글을 바꾼 재시도는 하지 않음",
}


class ConsensusFetchError(RuntimeError):
    """한 날짜를 받지 못함 — 사유는 화면에 뜨는 한 줄(응답 본문 없음)."""


class ConsensusShapeError(ValueError):
    """받았지만 응답 모양이 조사 때와 다름 — 그 날짜만 실패로 셉니다."""


def query_date(event_day: date) -> date:
    """동부 날짜 ``event_day``의 행을 주는 date 값."""
    return event_day + timedelta(days=QUERY_OFFSET_DAYS)


def fetch_day(event_day: date) -> list[dict]:
    """
    동부 날짜 하루의 미국 행(:func:`us_row` 모양, 응답 순서). 행이 없는 날은 빈 목록입니다.

    :raises ConsensusFetchError: 연결·HTTP 오류, 출처 거부(SourceRejected — 메시지에 '거부됨')
    :raises ConsensusShapeError: JSON이 아니거나 모양이 다름
    """
    try:
        res = get_session().get(NASDAQ_URL, params={"date": query_date(event_day).isoformat()}, timeout=FETCH_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — 연결 오류·거부는 그 날짜만의 실패입니다
        raise ConsensusFetchError(brief_error(exc)) from exc
    if res.status_code != 200:
        raise ConsensusFetchError(f"HTTP {res.status_code}")
    try:
        body = res.json()
    except ValueError:
        raise ConsensusShapeError("응답을 JSON으로 읽지 못했습니다") from None
    return parse_rows(body)


def parse_rows(body) -> list[dict]:
    """응답 → 미국 행. 다른 나라 행·이름 없는 행은 버립니다.

    :raises ConsensusShapeError: data.rows가 없음, rCode가 200이 아님, 행이 객체가 아님
    """
    if not isinstance(body, dict):
        raise ConsensusShapeError("응답이 객체가 아님")
    status = body.get("status")
    code = status.get("rCode") if isinstance(status, dict) else None
    if code not in (None, 200):
        raise ConsensusShapeError(f"응답 rCode {code}")
    data = body.get("data")
    rows = data.get("rows") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ConsensusShapeError("응답에 data.rows가 없음")
    out: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ConsensusShapeError("data.rows에 객체가 아닌 행")
        if clean(row.get("country")) != US_COUNTRY or not clean(row.get("eventName")):
            continue
        out.append(us_row(row))
    return out


def clean(text) -> str | None:
    """글자 칸 정리 — ``&nbsp;``·NBSP를 공백으로, 공백을 하나로, 앞뒤 공백 제거. 비면 None."""
    if not isinstance(text, str):
        return None
    collapsed = " ".join(text.replace("&nbsp;", " ").replace("\xa0", " ").split())
    return collapsed or None


# 숫자 + 단위: 부호 · $ · 숫자(천 단위 쉼표 허용) · 단위(% K M B T). 그 밖의 모양은 나누지 않습니다(null).
_VALUE = re.compile(r"(?P<sign>[+-])?(?P<cur>\$)?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?P<unit>%|K|M|B|T)?")
_TIME = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d")


def parse_value(text) -> tuple[float | None, str | None]:
    """``'1,728K'`` → (1728.0, 'K'), ``'-130.80B'`` → (-130.8, 'B'), ``'80.5'`` → (80.5, None). 못 나누면 (None, None) — 지어내지 않음."""
    cleaned = clean(text)
    if cleaned is None:
        return None, None
    matched = _VALUE.fullmatch(cleaned)
    if not matched:
        return None, None
    number = float(matched["num"].replace(",", ""))
    if matched["sign"] == "-":
        number = -number
    unit = (matched["cur"] or "") + (matched["unit"] or "")
    return number, unit or None


def us_row(row: dict) -> dict:
    """
    미국 행 하나 → 저장 모양 {name, timeEt, timeText, forecast, previous, actual, unit, forecastText, previousText, actualText, importance}.

    ``forecast``는 Nasdaq ``consensus``입니다. 세 값의 단위가 서로 다르면(나눈 값끼리) 숫자를 모두 null로 두고 ``unitMismatch``를 붙입니다 —
    글자(…Text)는 그대로 남습니다. ``timeEt``는 ``HH:MM``일 때만(``24H``·``Tentative`` 같은 말은 ``timeText``에만).
    """
    texts = {"forecast": clean(row.get("consensus")), "previous": clean(row.get("previous")), "actual": clean(row.get("actual"))}
    parsed = {key: parse_value(text) for key, text in texts.items()}
    units = {unit for value, unit in parsed.values() if value is not None}
    consistent = len(units) <= 1
    time_text = clean(row.get("gmt"))
    out = {
        "name": clean(row.get("eventName")),
        "timeEt": time_text if time_text and _TIME.fullmatch(time_text) else None,
        "timeText": time_text,
        "forecast": parsed["forecast"][0] if consistent else None,
        "previous": parsed["previous"][0] if consistent else None,
        "actual": parsed["actual"][0] if consistent else None,
        "unit": next(iter(units)) if len(units) == 1 else None,
        "forecastText": texts["forecast"],
        "previousText": texts["previous"],
        "actualText": texts["actual"],
        "importance": None,
    }
    if not consistent:
        out["unitMismatch"] = True
    return out
