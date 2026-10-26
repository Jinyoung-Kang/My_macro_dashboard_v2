#!/usr/bin/env python3
"""
scripts/qa/crosscheck.py — 핵심 계산을 저장본에서 **독립적으로** 다시 계산해 API 값과 대조합니다 (QA 스택).

  유동성 4주·12주 변화 : netLiquidityT 계열에서 기준일 − N주 이하의 마지막 값과의 차
  COT 백분위           : 자산별 ncNet 전체 표본에서 (마지막 값 이하 개수 / 표본 수) × 100
  13F 분기 대비 액션    : CUSIP(없으면 이름+종류) 키로 최신·직전 분기를 대조해 신규/전량 매도 수

표준 라이브러리만 씁니다. 사용: python3 scripts/qa/crosscheck.py
"""
from __future__ import annotations

import http.cookiejar
import json
import pathlib
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROJECT = "my_macrodash_v2_qa"


def env_value(key: str) -> str:
    for line in (ROOT / ".env.qa").read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def snapshot(name: str) -> dict:
    out = subprocess.run(["docker", "exec", "-i", f"{PROJECT}-postgres-1", "psql", "-U", env_value("DATABASE_USER") or "macro",
                          "-d", env_value("DATABASE_NAME") or "macrodash", "-At", "-c",
                          f"select payload::text from snapshots where name = '{name}'"], text=True, capture_output=True, check=True).stdout
    return json.loads(out)


def api(opener, base: str, path: str) -> dict:
    with opener.open(base + path, timeout=60) as r:
        return json.load(r)


def value_as_of(series: dict[date, float], when: date) -> float | None:
    keys = [d for d in series if d <= when]
    return series[max(keys)] if keys else None


def close(a, b, tol=1e-6) -> str:
    if a is None or b is None:
        return "✓" if a == b else f"✗ (API={a}, 독립={b})"
    return "✓" if abs(a - b) <= tol * max(1.0, abs(b)) else f"✗ (API={a}, 독립={b})"


def main() -> None:
    base = f"http://127.0.0.1:{env_value('BACKEND_PORT') or '18082'}"
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    body = json.dumps({"email": env_value("OWNER_EMAIL"), "password": env_value("APP_PASSWORD")}).encode()
    opener.open(urllib.request.Request(f"{base}/api/auth/login", data=body, method="POST",
                headers={"Content-Type": "application/json", "Origin": f"http://localhost:{env_value('FRONTEND_PORT') or '13002'}"}), timeout=30)
    results: list[str] = []

    # ---- 유동성
    rows = snapshot("liquidity.fed_net")["rows"]
    series = {date.fromisoformat(r["date"]): r["netLiquidityT"] for r in rows if r.get("netLiquidityT") is not None}
    last = max(series)
    for weeks in (4, 12):
        mine = series[last] - value_as_of(series, last - timedelta(weeks=weeks))
        got = api(opener, base, "/api/liquidity?years=3")["momentum"][f"change{weeks}w"]
        results.append(f"유동성 change{weeks}w (조 달러): {close(got, mine)}")

    # ---- COT 백분위·변화
    assets = snapshot("cot.multi_asset")["assets"]
    for name, asset in list(assets.items())[:6]:
        nc = [r["ncNet"] for r in asset["rows"] if r.get("ncNet") is not None]
        mine_pct = sum(1 for v in nc if v <= nc[-1]) / len(nc) * 100.0
        mine_4w = nc[-1] - nc[-5] if len(nc) > 4 else None
        got = api(opener, base, "/api/cot/asset?" + urllib.parse.urlencode({"name": name}))
        summary = got.get("summary") or {}
        results.append(f"COT {name} 백분위: {close(summary.get('percentile'), mine_pct)} · 4주 변화: {close(summary.get('change4w'), mine_4w)}")

    # ---- 13F 분기 대비 (버크셔)
    cik = "0001067983"
    quarters = snapshot(f"sec.13f.{cik}.q8")["quarters"]
    def key(h):  # noqa: E306
        c = (h.get("cusip") or "").strip()
        return f"cusip:{c}" if c else f"name:{h.get('name')}|{(h.get('class') or '').strip()}"
    cur = {key(h): h for h in quarters[0]["holdings"]}
    prev = {key(h): h for h in quarters[1]["holdings"]}
    mine_new = sum(1 for k in cur if k not in prev)
    mine_closed = sum(1 for k in prev if k not in cur)
    got = api(opener, base, f"/api/sec13f/portfolio?cik={cik}&quarters=8&topN=1000")
    holdings = got.get("holdings") or got.get("rows") or []
    got_new = sum(1 for h in holdings if "신규 매수" in str(h.get("action")))
    got_closed = sum(1 for h in holdings if "전량 매도" in str(h.get("action")))
    results.append(f"13F {cik} 신규 매수 수: {close(got_new, mine_new)} · 전량 매도 수: {close(got_closed, mine_closed)}")

    print("\n".join(results))
    sys.exit(1 if any("✗" in r for r in results) else 0)


if __name__ == "__main__":
    main()
