"""
app/services/search_research.py
정보 검색 리서치 탭(ADR 0041 단계 4, 계약 docs/specs/2026-11-14-info-search-contract.md §7-3) — 기업(상장 종목)만.

- ``yahoo_research``: 미국 종목의 투자의견 변경 이력 — yfinance ``Ticker(t).upgrades_downgrades``(이미 쓰는 라이브러리의 다른 칸). 상세 화면·Yahoo
  종목 뉴스와 같이 공용 거부 래치(``http.YAHOO_HOST``)와 무응답 래치(``app.yahoo``)를 먼저 보고, 닫혀 있으면 부르지 않습니다. 2년 자르기는
  규칙(search_rules)이 합니다. yfinance는 HTTP 오류를 삼키고 빈 표를 돌려주므로 빈 표는 '받지 못함', 이력이 없다는 예외는 빈 결과로 봅니다.
- ``naver_research``: 국내 종목의 증권사 리포트 — 종목 상세가 쓰는 네이버 ``integration`` 응답의 ``researches``(상세 화면 함수
  ``detail._naver_json``으로 같은 경로를 부름 — 새 네이버 경로를 늘리지 않음, 받은 만큼). 주소는 상세 화면과 같은 리포트 쪽.
  상세의 ``detail.quote``는 ``integration`` 실패를 빈 목록으로 삼켜 '없음'과 '받지 못함'을 가를 수 없어 쓰지 않습니다.
- 날짜만 주는 네이버 리포트는 KST 00:00 ``timeBasis: "date"``(§7-1). 실패 사유는 호스트와 상태만. 이 결과는 모의 매매의 입력이 아닙니다.
"""
from __future__ import annotations

import html
import math
import re
from typing import Any

import yfinance as yf
from yfinance.exceptions import YFDataException, YFRateLimitError

from .. import http, yahoo
from . import detail, info_text
from . import search_rules as rules
from .search_filings import KST, date_moment
from .search_sources import Fetched, feed_item, safe_reason

YAHOO_ANALYSIS_URL = "https://finance.yahoo.com/quote/{ticker}/analysis/"
YAHOO_DOMAIN = "finance.yahoo.com"
NAVER_REPORT_URL = "https://finance.naver.com/research/company_read.naver?nid={nid}"
NAVER_HOST = "m.stock.naver.com"
ACTION_WORDS = {"up": "상향", "down": "하향", "main": "유지", "init": "신규", "reit": "재개"}
_NO_HISTORY = "No upgrade/downgrade history"
_NID = re.compile(r"^\d{1,12}$")


# ------------------------------------------------------------------ Yahoo 투자의견 변경

def _ticker(symbol: str):
    """시험이 바꿔 끼우는 자리 — yfinance Ticker."""
    return yf.Ticker(symbol)


def _clean(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text if text and text.casefold() not in ("nan", "none") else None


def _price(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _dollars(value: float) -> str:
    return f"${int(value):,}" if value == int(value) else f"${value:,.2f}"


def grade_rows(frame: Any) -> list[dict]:
    """yfinance ``upgrades_downgrades`` 표(색인 GradeDate) → 줄 사전 목록(``GradeDate`` 칸 포함). 표가 아니거나 비었으면 빈 목록."""
    if frame is None or not hasattr(frame, "reset_index") or getattr(frame, "empty", True):
        return []
    table = frame.reset_index()
    if "GradeDate" not in table.columns:
        table = table.rename(columns={table.columns[0]: "GradeDate"})
    return table.to_dict("records")


def grade_items(rows: list[dict], ticker: str) -> list[dict]:
    """투자의견 변경 줄 → FeedItem(계약 §7-3). 회사 이름이나 시각이 없는 줄은 뺍니다."""
    out = []
    for row in rows:
        firm = _clean(row.get("Firm"))
        moment = rules.parse_time(row.get("GradeDate"))
        if not firm or moment is None:
            continue
        action = _clean(row.get("Action")) or ""
        to_grade, from_grade = _clean(row.get("ToGrade")), _clean(row.get("FromGrade"))
        change = f"{from_grade} → {to_grade}" if from_grade and to_grade else (to_grade or "")
        word = ACTION_WORDS.get(action.casefold(), action)
        parts = " ".join(part for part in (word, change) if part)
        title = f"{firm}: {parts}" if parts else firm
        current, prior = _price(row.get("currentPriceTarget")), _price(row.get("priorPriceTarget"))
        summary = (f"목표가 {_dollars(prior)} → {_dollars(current)}" if prior and current
                   else f"목표가 {_dollars(current)}" if current else None)
        stamp = rules.utc_iso(moment)
        key = f"yahoo-grade:{ticker}:{stamp}:{firm}:{action}:{to_grade or ''}"
        out.append(feed_item(title=title, url=YAHOO_ANALYSIS_URL.format(ticker=ticker), publisher=firm, domain=YAHOO_DOMAIN,
                             published=moment, source="yahoo_research", lang="en", kind="research", summary=summary,
                             item_id=info_text.item_id(key)))
    return out


def yahoo_grades(ticker: str) -> Fetched:
    """미국 종목의 투자의견 변경 이력(yfinance) — 공용 거부 래치·무응답 래치가 닫혀 있으면 부르지 않습니다."""
    latched = http.active_rejection(http.YAHOO_HOST)
    if latched is not None:
        return Fetched(error=str(latched))
    closed = yahoo.unavailable_reason()
    if closed:
        return Fetched(error=closed)
    symbol = ticker.upper().replace(".", "-")
    try:
        frame = _ticker(symbol).upgrades_downgrades
    except YFRateLimitError:
        return Fetched(error=str(http.reject_host(http.YAHOO_HOST, "HTTP 429(요청 제한)")))
    except YFDataException as exc:
        if str(exc).startswith(_NO_HISTORY):
            return Fetched()
        return Fetched(error=f"{http.YAHOO_HOST} 응답 모양이 다름")
    except Exception as exc:  # noqa: BLE001 — 출처 하나의 실패
        return Fetched(error=safe_reason(exc, http.YAHOO_HOST))
    rows = grade_rows(frame)
    if not rows:
        # yfinance는 HTTP 오류를 삼키고 빈 표를 돌려줍니다(이력이 없으면 위의 예외) — '없음'이 아니라 받지 못함.
        return Fetched(error=yahoo.unavailable_reason() or f"{http.YAHOO_HOST} 응답을 받지 못함(빈 표)")
    return Fetched(items=grade_items(rows, symbol))


# ------------------------------------------------------------------ 네이버 증권사 리포트

def naver_items(integration: Any) -> list[dict]:
    """네이버 ``integration`` 응답의 ``researches`` → FeedItem(받은 만큼). id·제목이 없는 줄은 뺍니다."""
    rows = integration.get("researches") if isinstance(integration, dict) else None
    out = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        nid = str(row.get("id") if row.get("id") is not None else "").strip()
        title = _clean(html.unescape(row["tit"])) if isinstance(row.get("tit"), str) else None
        if not _NID.match(nid) or not title:
            continue
        out.append(feed_item(title=title, url=NAVER_REPORT_URL.format(nid=nid), publisher=_clean(row.get("bnm")),
                             domain="finance.naver.com", published=date_moment(str(row.get("wdt") or ""), KST), basis="date",
                             source="naver_research", lang="ko", kind="research"))
    return out


def naver_research(code: str) -> Fetched:
    """국내 종목의 증권사 리포트 — 상세 화면이 쓰는 네이버 ``integration`` 경로 그대로(``detail._naver_json``)."""
    payload, error = detail._naver_json(f"/stock/{code}/integration")
    if error:
        # 상세 화면의 함수가 준 사유에는 요청 주소가 섞일 수 있어 상태 코드만 옮깁니다(search_sources.naver와 같음).
        return Fetched(error=f"{NAVER_HOST} {error}" if re.fullmatch(r"HTTP \d{3}", error) else
                       error if error.startswith(http.REJECTED_MARK) else f"{NAVER_HOST} 연결·응답 실패")
    if not isinstance(payload, dict):
        return Fetched(error=f"{NAVER_HOST} 응답 모양이 다름")
    return Fetched(items=naver_items(payload))
