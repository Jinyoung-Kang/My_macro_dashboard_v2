"""
app/services/fsc.py
금융위원회 주식시세정보 — 국내 상장 종목 일별 공식 시세(종가·시가총액).

왜 필요한가 — 수급 레이더의 가격은 포털·증권사 API에서 장중에 받은 값입니다.
금융위 시세는 거래소 확정치를 기준일 단위로 주므로 시가총액의 기준이 되고,
DART 재무와 합쳐 PER·PBR을 계산할 수 있습니다.

갱신 — 기준일 다음 영업일 오후 1시 이후 (금요일 데이터는 월요일에).
그래서 "오늘"을 조회하지 않고 어제부터 거슬러 올라가며 데이터가 있는 날을 찾습니다.

응답 필드 (실제로 동작하는 코드가 읽는 필드와 공개된 필드 설명 기준)
  basDt 기준일(YYYYMMDD) · srtnCd 단축코드 · isinCd · itmsNm 종목명 · mrktCtg 시장구분
  clpr 종가 · mkp 시가 · hipr 고가 · lopr 저가 · vs 대비 · fltRt 등락률 · trqu 거래량 · trPrc 거래대금
  lstgStCnt 상장주식수 · mrktTotAmt 시가총액
  srtnCd가 "A005930"처럼 A 접두어로 오는 경우가 있어 떼어 냅니다. 코드는 숫자·영문 대문자 6자리입니다
  (영문이 섞인 새 코드 — 토스 종목코드 규칙 ^[0-9A-Z]{6}$과 같음, v2 2단계 명세 §4-5).
  거래가 없던 날(거래정지 등, trqu 0)은 시가·고가·저가가 0으로 오고 종가는 직전 종가입니다
  ([확인] 2026-10-27 실제 응답 — tests/fixtures/public/fsc_getStockPriceInfo_V2_halted_101530.xml).

주소·필드 — 금융위원회_주식시세정보 오픈API 활용가이드(GetStockSecuritiesInfoService_V2)의
"주식시세" 상세기능 `getStockPriceInfo_V2`. 응답 예시는 tests/fixtures/public에 있습니다.
(처음에는 오퍼레이션 이름을 확인하지 못해 `getStockPriceInfo`로 불렀고, 실제 호출에서
NO_OPENAPI_SERVICE_ERROR(코드 12)가 나와 활용가이드로 바로잡았습니다.)
FSC_STOCK_PRICE_URL로 주소를 직접 지정할 수 있습니다.
"""
from __future__ import annotations

import os
import re

from ..numbers import to_float
from .. import publicapi, settings

URL = "https://apis.data.go.kr/1160100/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2"

# 한 페이지 행 수와 최대 페이지. 상장 종목은 KOSPI·KOSDAQ·KONEX 합쳐 3천 개 안팎입니다.
ROWS_PER_PAGE = 1000
MAX_PAGES = 5

# 단축코드 — 숫자·영문 대문자 6자리(앞의 A 접두어는 뗌). 예전 규칙(숫자 6자리)은 영문이 섞인 새 코드를 버렸습니다.
_CODE = re.compile(r"^A?([0-9A-Z]{6})$")


def endpoint() -> str:
    """호출할 주소. FSC_STOCK_PRICE_URL이 있으면 그것을 씁니다."""
    return os.environ.get("FSC_STOCK_PRICE_URL", "").strip() or URL


def fetch_day(bas_dt: str, budget: publicapi.CallBudget) -> tuple[list[dict], str]:
    """
    그 기준일의 전 종목 시세.

    :param bas_dt: 기준일 YYYYMMDD
    :param budget: 호출 예산. 페이지마다 하나씩 씁니다
    :returns: (정규화한 행 목록, 호출한 주소). 그날 데이터가 없으면 ([], 주소)
    :raises publicapi.MissingKey: DATA_GO_KR_SERVICE_KEY 미설정
    :raises publicapi.BudgetExhausted: 예산 부족(PublicApiError의 하위 — 출처 실패와 가를 때만 따로 잡음)
    :raises publicapi.PublicApiError: 인증·서비스 오류
    """
    url = endpoint()
    return _fetch_pages(url, bas_dt, settings.data_go_kr_key(), budget), url


def _fetch_pages(url: str, bas_dt: str, key: str, budget: publicapi.CallBudget) -> list[dict]:
    """
    그날 전 종목을 끝까지 받습니다. 끝까지 받았는지 확인할 수 없으면 실패입니다(QA-078).

    - 1페이지가 비고 totalCount가 없거나 0이면 아직 발표 전(또는 휴장일) — 빈 목록.
    - totalCount를 모르거나, totalCount에 못 미친 채 페이지가 비면 PublicApiError. 예전에는 잘린 행을 그날 전체로
      돌려줘 시장 합계가 실제의 일부로 저장되고, 저장된 마지막 기준일이 그날로 올라가 다시 받지 않았습니다.
      실패로 올리면 태스크가 그날에서 멈추고 다음 실행이 그날부터 다시 받습니다(QA-034).
    """
    rows: list[dict] = []
    total: int | None = None
    for page in range(1, MAX_PAGES + 1):
        if not budget.take():
            raise publicapi.BudgetExhausted("호출 예산 소진")
        response = publicapi.get(
            url, {"basDt": bas_dt, "numOfRows": ROWS_PER_PAGE, "pageNo": page}, key=key, timeout=30,
        )
        root = publicapi.parse_xml(response, key=key)
        items = publicapi.xml_items(root)
        if page == 1:
            total = publicapi.total_count(root)
            if not items and not total:
                return []
            if total is None:
                raise publicapi.PublicApiError(
                    "응답에 totalCount가 없습니다 — 그날 전 종목을 다 받았는지 알 수 없어 저장하지 않습니다"
                )
        rows.extend(normalize(item) for item in items)
        if len(rows) >= total:
            break
        if not items:
            raise publicapi.PublicApiError(
                f"{page}페이지가 비었습니다 — totalCount {total}건 중 {len(rows)}건만 받아 저장하지 않습니다"
            )
    else:
        raise publicapi.PublicApiError(f"{MAX_PAGES}페이지를 넘었습니다 — 행 수가 예상보다 많습니다")
    return [row for row in rows if row["code"]]


def normalize(item: dict) -> dict:
    """
    응답 한 행을 저장 형태로 옮깁니다. 숫자가 아니면 None (0으로 채우지 않음).

    시가·고가·저가(``open``·``high``·``low``)는 0 이하도 None입니다 — 거래가 없던 날은 0으로 오는데(모듈 설명),
    0원은 가격이 아니라 '체결 없음'입니다. 고가·저가는 대조·화면용이고 체결·스탑에 쓰지 않습니다(명세 §4-1).

    :returns: ``{"code", "name", "market", "close", "open", "high", "low", "change", "changePct", "volume",
              "tradingValue", "listedShares", "marketCap", "basDt"}``
    """
    match = _CODE.match((item.get("srtnCd") or "").strip())
    return {
        "code": match.group(1) if match else None,
        "name": (item.get("itmsNm") or "").strip() or None,
        "market": (item.get("mrktCtg") or "").strip() or None,
        "close": to_float(item.get("clpr")),
        "open": _price(item.get("mkp")),
        "high": _price(item.get("hipr")),
        "low": _price(item.get("lopr")),
        "change": to_float(item.get("vs")),
        "changePct": to_float(item.get("fltRt")),
        "volume": to_float(item.get("trqu")),
        "tradingValue": to_float(item.get("trPrc")),
        "listedShares": to_float(item.get("lstgStCnt")),
        "marketCap": to_float(item.get("mrktTotAmt")),
        "basDt": (item.get("basDt") or "").strip() or None,
    }


def _price(value) -> float | None:
    """가격 칸 — 숫자가 아니거나 0 이하면 None(거래 없음)."""
    number = to_float(value)
    return number if number is not None and number > 0 else None


def market_totals(rows: list[dict]) -> dict[str, dict]:
    """
    시장별 합계: 시가총액·거래대금·종목 수.

    시장구분(mrktCtg)이 없는 행은 "기타"로 모읍니다. 합계에 None을 0으로 섞지
    않도록, 값이 있는 행만 더하고 몇 행이 빠졌는지 함께 남깁니다. 한 행도 값이
    없으면 합계는 0.0이 아니라 None입니다 — 0.0은 timeseries에 "시가총액 0원"으로
    쌓여 화면 차트가 0으로 떨어집니다.
    """
    out: dict[str, dict] = {}
    for row in rows:
        market = row.get("market") or "기타"
        agg = out.setdefault(market, {"count": 0, "marketCap": None, "tradingValue": None, "missingCap": 0})
        agg["count"] += 1
        if row.get("marketCap") is None:
            agg["missingCap"] += 1
        else:
            agg["marketCap"] = (agg["marketCap"] or 0.0) + row["marketCap"]
        if row.get("tradingValue") is not None:
            agg["tradingValue"] = (agg["tradingValue"] or 0.0) + row["tradingValue"]
    return out
