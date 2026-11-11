"""
app/services/info_naver.py
정보 수집(ADR 0035) — 네이버 증권 투자자별 매매동향·매매상위(stock.naver.com/market/stock/kr/trend/trader·foreigner·organization).

화면이 표를 채우는 JSON API를 그대로 부릅니다(한 실행에 6건, 순서는 무작위).
  - 매매동향(일자별) ``/api/domestic/market/trend/daily`` — 코스피·코스닥, 최근 10거래일, 투자자 구분별 순매수 금액(원)
  - 외국인·기관 매매상위 ``/api/domestic/market/trend/trendForeignOrg`` — 코스피·코스닥, 당일(DAY), 순매수·순매도 상위 20

스냅샷 ``info.naver.flows`` 모양(contract 1)
  generatedAt · collectedAt(KST) · source · sourceUrls{trader, foreigner, organization} · fetchTier · unit('억원')
  trend    : {KOSPI|KOSDAQ: {rows: [{date, individual, foreign, institution, financial, insurance, trust, bank, otherFinancial,
              pension, otherCorp}], isStale?}} — 금액은 억 원(소수 첫째 자리). 화면과 같이 투신(사모)=3000+3100, 연기금등=6000+7000,
              외국인=9000+9001, 기관계=금융투자·보험·투신·은행·기타금융·연기금의 합입니다. 구분이 응답에 없으면 그 칸은 null(합도 null).
  rankings : {FOREIGNER|ORGANIZATION: {KOSPI|KOSDAQ: {buy: [...], sell: [...], estimated, period{from, to}, rankedAt, isStale?}}}
             행은 {rank, code, name, price, changePct, netVolume, netAmountEok} — 장중 추정(estimated) 순위는 금액이 오지 않아
             netAmountEok가 null입니다(0으로 채우지 않음, 주식 수 netVolume만).
  failed   : 이번에 받지 못한 부분의 이름(그 부분은 직전 저장본의 값을 이어받고 isStale: true)
"""
from __future__ import annotations

import random
from datetime import datetime
from typing import Callable

from .. import kst
from ..fetch import ladder, policy
from ..numbers import to_float, to_int
from .info_text import ShapeError

API = "https://stock.naver.com/api/domestic/market/trend"
PAGES = {
    "trader": "https://stock.naver.com/market/stock/kr/trend/trader",
    "foreigner": "https://stock.naver.com/market/stock/kr/trend/foreigner",
    "organization": "https://stock.naver.com/market/stock/kr/trend/organization",
}
SOURCE = "네이버 증권 투자자별 매매동향·매매상위"
MARKETS = ("KOSPI", "KOSDAQ")
INVESTORS = ("FOREIGNER", "ORGANIZATION")
TREND_DAYS = 10
RANK_PAGE_SIZE = 20

# 응답의 투자자 구분 코드 → 칸(화면 스크립트와 같은 묶음). 둘 이상이 한 칸으로 합쳐지는 것은 화면이 그렇게 보여 주기 때문입니다.
TREND_CODES: dict[str, tuple[str, ...]] = {
    "individual": ("8000",),
    "foreign": ("9000", "9001"),
    "financial": ("1000",),
    "insurance": ("2000",),
    "trust": ("3000", "3100"),
    "bank": ("4000",),
    "otherFinancial": ("5000",),
    "pension": ("6000", "7000"),
    "otherCorp": ("7100",),
}
INSTITUTION_PARTS = ("financial", "insurance", "trust", "bank", "otherFinancial", "pension")

Fetch = Callable[..., ladder.Fetched]


def _eok(won: float | None) -> float | None:
    return None if won is None else round(won / 100_000_000.0, 1)


def _iso(day: str | None) -> str | None:
    text = str(day or "").strip()
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}" if len(text) == 8 and text.isdigit() else None


def parse_trend(payload) -> list[dict]:
    """
    매매동향(일자별) 응답 → 날짜별 행(최근 날짜부터).

    :raises ShapeError: content 목록이 없거나 날짜·구분을 하나도 읽지 못함
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("content"), list):
        raise ShapeError("네이버 매매동향 응답 모양이 다름(content 없음)")
    rows = []
    for day in payload["content"]:
        if not isinstance(day, dict):
            continue
        date = _iso(day.get("bizdate"))
        amounts = {str(n.get("investorGubun")): to_float(n.get("diffValue"))
                   for n in day.get("netAmounts") or [] if isinstance(n, dict)}
        if date is None or not amounts:
            continue
        row: dict = {"date": date}
        for column, codes in TREND_CODES.items():
            values = [amounts.get(code) for code in codes if code in amounts]
            # 묶음의 첫 코드(주 구분)가 없으면 모르는 값입니다. 덧붙는 코드(9001·3100·7000)는 없으면 더하지 않습니다(화면과 같음).
            row[column] = _eok(sum(v for v in values if v is not None)) if codes[0] in amounts and amounts[codes[0]] is not None else None
        parts = [row[name] for name in INSTITUTION_PARTS]
        row["institution"] = None if any(part is None for part in parts) else round(sum(parts), 1)
        rows.append(row)
    if not rows:
        raise ShapeError("네이버 매매동향에서 날짜별 값을 읽지 못함(bizdate·netAmounts 없음)")
    return rows


def parse_rankings(payload) -> dict:
    """
    외국인·기관 매매상위 응답 → {buy, sell, estimated, period{from, to}, rankedAt}.

    :raises ShapeError: sections.buyRankList·sellRankList가 없음
    """
    sections = payload.get("sections") if isinstance(payload, dict) else None
    if not isinstance(sections, dict) or not isinstance(sections.get("buyRankList"), list) \
            or not isinstance(sections.get("sellRankList"), list):
        raise ShapeError("네이버 매매상위 응답 모양이 다름(sections.buyRankList·sellRankList 없음)")
    out: dict = {"estimated": False, "period": {"from": None, "to": None}, "rankedAt": None}
    for side, key in (("buy", "buyRankList"), ("sell", "sellRankList")):
        rows = []
        for index, row in enumerate([r for r in sections[key] if isinstance(r, dict)], start=1):
            estimated = row.get("estimated") is True
            amount = to_float(row.get("accTradeAmount"))
            if estimated:
                out["estimated"] = True
                out["rankedAt"] = row.get("toRankingAt") or out["rankedAt"]
            out["period"] = {"from": _iso(row.get("bizdateFrom")) or out["period"]["from"],
                             "to": _iso(row.get("bizdateTo")) or out["period"]["to"]}
            rows.append({
                "rank": index,
                "code": str(row.get("itemcode") or "").strip() or None,
                "name": str(row.get("itemname") or "").strip() or None,
                "price": to_float(row.get("nowPrice")),
                "changePct": to_float(row.get("prevChangeRate")),
                "netVolume": to_int(row.get("accTradeVolume")),
                # 추정 순위의 금액 칸은 "0"(주지 않음)입니다 — 0원이 아니라 모르는 값.
                "netAmountEok": None if estimated or amount in (None, 0) else _eok(amount),
            })
        out[side] = rows
    return out


def collect(previous: dict | None, *, fetch: Fetch = ladder.fetch, now: datetime | None = None,
            rng: random.Random | None = None) -> dict:
    """
    여섯 부분을 받아 스냅샷을 만듭니다. 받지 못한 부분(형식이 다르거나 404·5xx)은 직전 저장본의 값을 이어받고 ``isStale``을 답니다.

    :raises ShapeError: 모든 부분의 형식이 달라 하나도 받지 못함
    :raises ladder.FetchRejected: 출처가 거부함(그때까지 받은 것도 버림 — 직전 저장본 유지)
    :raises ladder.FetchSkipped: 하나도 보내지 못함(예산·시간)
    :raises ladder.FetchFailed: 하나도 받지 못함
    """
    now = now or datetime.now(kst.KST)
    today = now.astimezone(kst.KST).strftime("%Y%m%d")
    jobs: list[tuple[str, str, str, dict, str]] = []
    for market in MARKETS:
        jobs.append(("trend", market, f"{API}/daily",
                     {"tradeType": "KRX", "marketType": market, "bizdate": today, "startIdx": 0, "pageSize": TREND_DAYS},
                     PAGES["trader"]))
    for investor in INVESTORS:
        for market in MARKETS:
            jobs.append((investor, market, f"{API}/trendForeignOrg",
                         {"investorType": investor, "tradeType": "KRX", "marketType": market, "startIdx": 0,
                          "pageSize": RANK_PAGE_SIZE, "periodType": "DAY"},
                         PAGES["foreigner" if investor == "FOREIGNER" else "organization"]))
    (rng or random).shuffle(jobs)          # 사람이 화면을 오가는 순서처럼 매번 다르게

    previous = previous or {}
    trend: dict = {}
    rankings: dict = {investor: {} for investor in INVESTORS}
    failed: list[str] = []
    shape_errors: list[str] = []
    tiers: set[str] = set()
    skipped: ladder.FetchSkipped | None = None
    failure: ladder.FetchFailed | None = None
    for part, market, url, params, referer in jobs:
        name = f"{part}.{market}"
        try:
            got = fetch(url, expect=policy.EXPECT_JSON, params=params,
                        headers={"Referer": referer, "Accept": "application/json"})
            payload = got.json()
            if part == "trend":
                trend[market] = {"rows": parse_trend(payload)}
            else:
                rankings[part][market] = parse_rankings(payload)
            tiers.add(got.tier)
            continue
        except (ShapeError, ValueError) as exc:
            shape_errors.append(f"{name}: {exc}")
        except ladder.FetchSkipped as exc:
            skipped = exc
        except ladder.FetchFailed as exc:
            failure = exc
        failed.append(name)
        old = (previous.get("trend") or {}).get(market) if part == "trend" else \
            ((previous.get("rankings") or {}).get(part) or {}).get(market)
        if old is not None:
            target = trend if part == "trend" else rankings[part]
            target[market] = {**old, "isStale": True}
        if skipped is not None:
            # 예산·시간이 모자라면 남은 부분은 보내지 않습니다 — 이어받기만.
            for rest_part, rest_market, *_ in jobs[jobs.index((part, market, url, params, referer)) + 1:]:
                rest = f"{rest_part}.{rest_market}"
                if rest in failed:
                    continue
                failed.append(rest)
                old = (previous.get("trend") or {}).get(rest_market) if rest_part == "trend" else \
                    ((previous.get("rankings") or {}).get(rest_part) or {}).get(rest_market)
                if old is not None:
                    (trend if rest_part == "trend" else rankings[rest_part])[rest_market] = {**old, "isStale": True}
            break

    if not tiers:                          # 하나도 받지 못함 — 저장본을 덮지 않습니다
        if shape_errors:
            raise ShapeError("; ".join(shape_errors[:2]))
        if failure is not None:
            raise failure
        raise skipped or ShapeError("네이버에서 하나도 받지 못함")
    return {
        "contract": 1,
        "generatedAt": now.isoformat(timespec="seconds"),
        "collectedAt": kst.stamp(now),
        "source": SOURCE,
        "sourceUrls": dict(PAGES),
        "fetchTier": "browser" if "browser" in tiers else (next(iter(tiers)) if tiers else None),
        "unit": "억원",
        "trend": trend,
        "rankings": rankings,
        "failed": failed,
        "shapeErrors": shape_errors[:4],
    }
