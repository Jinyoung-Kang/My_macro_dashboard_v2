#!/usr/bin/env python3
"""
미국 모의 계좌 유니버스의 종목 이름표를 만듭니다 — backend/src/main/resources/paper/us-ticker-names.json.

텔레그램 알림이 티커 옆에 종목명을 적을 때 씁니다(2026-11-08 사용자 요청). 유니버스는 코드에 고정되어 있어(collector/app/paper_universe.py) 이름표도 파일 하나로
두고, 유니버스가 바뀌면 다시 돌립니다. 표에 없는 종목은 알림에 티커만 나갑니다.

이름 순서: 아래 OVERRIDES(자주 쓰는 ETF·영문으로만 나오는 종목) → 네이버 증권 자동완성의 한글 이름 → SEC company_tickers.json의 등록 이름 → 지금 표의 이름.

    SEC_USER_AGENT=... collector/.venv/bin/python scripts/gen_us_ticker_names.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))

from app import paper_universe  # noqa: E402

OUT = ROOT / "backend/src/main/resources/paper/us-ticker-names.json"
NAVER_AC = "https://ac.stock.naver.com/ac"
SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
BROWSER = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
SPACING_SECONDS = 0.25
OVERRIDES = {
    "XLK": "기술 섹터 SPDR", "XLC": "커뮤니케이션 섹터 SPDR", "XLY": "임의소비재 섹터 SPDR", "XLI": "산업재 섹터 SPDR",
    "XLF": "금융 섹터 SPDR", "XLV": "헬스케어 섹터 SPDR", "XLP": "필수소비재 섹터 SPDR", "XLE": "에너지 섹터 SPDR",
    "XLB": "소재 섹터 SPDR", "XLU": "유틸리티 섹터 SPDR", "XLRE": "부동산 섹터 SPDR", "SPY": "S&P 500 ETF", "QQQ": "나스닥 100 ETF",
    "SHY": "미국채 1-3년 ETF", "IEF": "미국채 7-10년 ETF", "TLT": "미국채 20년 이상 ETF", "UUP": "달러 강세 ETF", "GLD": "금 ETF",
    "DBC": "원자재 ETF", "BRK-A": "버크셔 해서웨이 A", "BRK-B": "버크셔 해서웨이 B",
}


def naver_name(ticker: str) -> str | None:
    """자동완성에서 코드가 같은 미국 종목의 이름. 'BRK-B'는 'BRK.B'로도 맞춥니다."""
    wanted = {ticker.upper(), ticker.upper().replace("-", "."), ticker.upper().replace("-", " ")}
    res = requests.get(NAVER_AC, params={"q": ticker, "target": "stock,worldstock,etf,worldetf"}, headers=BROWSER, timeout=10)
    res.raise_for_status()
    for item in res.json().get("items") or []:
        if item.get("nationCode") == "USA" and str(item.get("code") or "").upper() in wanted and item.get("name"):
            name = str(item["name"]).strip()
            inner = re.fullmatch(r"[A-Za-z0-9&.\- ]+\((.+)\)", name)      # 'AMD(어드밴스드 …)' — 티커 옆 괄호 안에 또 괄호가 생기지 않게
            return inner.group(1).strip() if inner else name
    return None


def sec_names() -> dict[str, str]:
    agent = os.environ.get("SEC_USER_AGENT")
    if not agent:
        return {}
    res = requests.get(SEC_TICKERS, headers={"User-Agent": agent}, timeout=30)
    res.raise_for_status()
    return {row["ticker"].upper(): row["title"].strip() for row in res.json().values()}


def main() -> int:
    tickers = paper_universe.tradable()
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    sec = sec_names()
    names: dict[str, str] = {}
    missing: list[str] = []
    for ticker in tickers:
        try:
            name = OVERRIDES.get(ticker) or naver_name(ticker)
        except requests.RequestException as exc:
            print(f"경고: {ticker} 자동완성 실패 — {type(exc).__name__}", file=sys.stderr)
            name = None
        time.sleep(SPACING_SECONDS)
        name = name or sec.get(ticker.upper()) or previous.get(ticker)
        if name:
            names[ticker] = name
        else:
            missing.append(ticker)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(names, ensure_ascii=False, indent=0, sort_keys=True) + "\n", encoding="utf-8")
    print(f"✓ {len(names)}/{len(tickers)}종목 이름을 적었습니다. 이름 없음: {' '.join(missing) or '없음'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
