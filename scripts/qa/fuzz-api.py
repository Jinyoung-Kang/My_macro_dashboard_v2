#!/usr/bin/env python3
"""
scripts/qa/fuzz-api.py — 백엔드 API 경계값·비정상 입력 퍼저 (QA 스택 대상, 표준 라이브러리만).

routes.json의 모든 경로에 대해 파라미터 하나씩 경계값·조작 문자열을 넣어 호출하고
  - 500 / 10초 초과 / 예외·스택·SQL 문구가 든 응답 / 크기 1MB 초과
를 표시합니다. 결과: docs/qa/evidence/fuzz-results.jsonl(전부) + fuzz-summary.md(표시된 것만).

사용: python3 scripts/qa/fuzz-api.py [--only /api/경로] [--quick]
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/qa/evidence"
TIMEOUT = 20.0
SLOW_SECONDS = 10.0
BIG_BYTES = 1_000_000
LEAK = re.compile(r"Exception|Traceback|\bat com\.|org\.postgresql|PSQLException|SQLSTATE|syntax error at|java\.lang|NullPointer|/app/|/Users/", re.I)

VALUES = {
    "int": ["0", "-1", "1", "2147483648", "9223372036854775808", "1e308", "1.5", "abc", "", "NaN", "Infinity", "0x10", "-2147483648", "99999999999", " 5"],
    "str": ["' OR '1'='1", "\"; DROP TABLE snapshots; --", "../../../etc/passwd", "%00", "<script>alert(1)</script>", "A" * 5000, "{{7*7}}", "${jndi:ldap://x}", "삼성전자", "%", "_", "\\", "' UNION SELECT NULL--", "", "AAPL\r\nX-Injected: 1", "🙂", "DGS10;ls"],
    "date": ["9999-99-99", "0000-01-01", "2026-02-30", "20260101", "2026/01/01", "now", "1", "-1", "2026-13-01", "2026-01-01T00:00:00Z", "' OR 1=1", "", "2099-12-31", "1900-01-01"],
    "list": ["", ",", ",,,", "005930," * 3000, "a,b,c", "005930;DROP TABLE x", "../x", "NVDA,'--", "0001608046," * 500],
    "enum": ["", "XXX", "kospi", "KOSPI'--", "A" * 1000, "순매수 ", "1", "-1", "null"],
    "bool": ["", "yes", "1", "TRUE", "null", "maybe", "0"],
}
DEFAULTS = {  # 다른 파라미터는 이 값으로 둡니다(정상 요청이 되도록)
    "ids": "usdkrw,dxy", "period": "1y", "mode": "index", "longId": "DGS10", "shortId": "DGS2", "seriesId": "DGS10",
    "years": "3", "symbol": "AAPL", "cik": "0001608046", "quarters": "8", "topN": "30", "ciks": "0001608046,0001374170",
    "reportDate": "", "minHolders": "2", "q": "NVIDIA", "benchmark": "SPY", "name": "", "percentile": "95",
    "lookbackWeeks": "52", "days": "60", "minutes": "30", "market": "KOSPI", "investor": "외국인", "tradeType": "순매수",
    "intervalType": "TODAY", "targetDate": "", "latest": "true", "obsDate": "", "codes": "005930,000660", "task": "",
    "limit": "40", "runFast": "false", "taskName": "kr_holidays", "x": "fred:DGS10", "y": "fred:DGS2", "window": "60",
    "engineId": "", "prompt": "", "reportType": "", "base": "USD", "quote": "KRW", "symbols": "KOSPI,KOSDAQ", "live": "false",
    "asset": "SPY",
}


def env_value(key: str) -> str:
    for line in (ROOT / ".env.qa").read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def login(opener, base: str) -> None:
    body = json.dumps({"email": env_value("OWNER_EMAIL"), "password": env_value("APP_PASSWORD")}).encode()
    req = urllib.request.Request(f"{base}/api/auth/login", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Origin": f"http://localhost:{env_value('FRONTEND_PORT') or '13002'}"})
    with opener.open(req, timeout=TIMEOUT) as r:
        if r.status != 200:
            sys.exit(f"login failed: {r.status}")


def call(opener, method: str, url: str, body: dict | None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    started = time.perf_counter()
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            raw = r.read()
            return r.status, time.perf_counter() - started, raw
    except urllib.error.HTTPError as e:
        return e.code, time.perf_counter() - started, e.read()
    except Exception as e:  # noqa: BLE001  (타임아웃·연결 끊김)
        return -1, time.perf_counter() - started, str(e).encode()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--quick", action="store_true", help="파라미터당 값 5개만")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{env_value('BACKEND_PORT') or '18082'}"
    spec = json.loads((ROOT / "scripts/qa/routes.json").read_text())
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    login(opener, base)

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    out = (EVIDENCE / "fuzz-results.jsonl").open("w")
    flagged: list[dict] = []
    total = 0
    for route in spec["routes"]:
        if args.only and route["p"] != args.only:
            continue
        # fuzz: false — 세션을 끊거나 계정·사용자·알림 규칙을 바꾸는 경로(routes.json). 부르면 이후 요청이 전부 401이
        # 되거나 QA 계정 상태가 바뀝니다. 인증 누락 점검(auth-probe.sh)은 쿠키 없이 이 경로도 보냅니다.
        if route.get("fuzz") is False:
            continue
        params = {**route.get("q", {}), **route.get("path", {}), **route.get("body", {})}
        cases = [("(기본값)", None, None)]
        for name, kind in params.items():
            values = VALUES.get(kind, VALUES["str"])
            if args.quick:
                values = values[:5]
            cases += [(name, kind, v) for v in values]
        for name, kind, value in cases:
            q = {k: DEFAULTS.get(k, "") for k in route.get("q", {})}
            path_vals = {k: DEFAULTS.get(k, "x") for k in route.get("path", {})}
            body = {k: DEFAULTS.get(k, "") for k in route.get("body", {})} if route.get("body") else None
            if value is not None:
                if name in q:
                    q[name] = value
                elif name in path_vals:
                    path_vals[name] = value
                elif body is not None:
                    body[name] = value
            path = route["p"]
            for k, v in path_vals.items():
                path = path.replace("{" + k + "}", urllib.parse.quote(v, safe=""))
            url = base + path
            q = {k: v for k, v in q.items() if v != "" or (value is not None and k == name)}
            if q:
                url += "?" + urllib.parse.urlencode(q)
            status, elapsed, raw = call(opener, route["m"], url, body)
            total += 1
            text = raw[:4000].decode("utf-8", "replace")
            flags = []
            if status == 500 or status == -1:
                flags.append("500/끊김")
            if elapsed > SLOW_SECONDS:
                flags.append(f"느림 {elapsed:.1f}s")
            if LEAK.search(text):
                flags.append("내부 정보 노출 의심")
            if len(raw) > BIG_BYTES:
                flags.append(f"큰 응답 {len(raw)//1024}KB")
            if status == 200 and kind == "int" and value in ("-1", "2147483648", "9223372036854775808", "1e308", "abc", "NaN", "Infinity", "-2147483648", "99999999999"):
                flags.append("비정상 숫자를 200으로 받음")
            if status == 200 and kind == "date" and value in ("9999-99-99", "2026-02-30", "2026-13-01", "' OR 1=1", "now"):
                flags.append("비정상 날짜를 200으로 받음")
            rec = {"route": f"{route['m']} {route['p']}", "param": name, "value": (value or "")[:60], "status": status,
                   "ms": round(elapsed * 1000), "bytes": len(raw), "flags": flags, "body": text[:300]}
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if flags:
                flagged.append(rec)
            sys.stdout.write(f"\r{total:5d} {route['m']} {route['p']:<40} {name:<14} → {status} {rec['ms']:>6}ms {'  '.join(flags)}".ljust(140))
            sys.stdout.flush()
    print()
    lines = [f"# fuzz-api 결과 — 요청 {total}건, 표시 {len(flagged)}건", "", "| 경로 | 파라미터 | 값 | 상태 | ms | 표시 | 응답 앞부분 |", "|---|---|---|---|---|---|---|"]
    for r in flagged:
        body = r["body"].replace("|", "\\|").replace("\n", " ")[:120]
        lines.append(f"| {r['route']} | {r['param']} | `{r['value'].replace('|', '/')}` | {r['status']} | {r['ms']} | {', '.join(r['flags'])} | {body} |")
    (EVIDENCE / "fuzz-summary.md").write_text("\n".join(lines) + "\n")
    print(f"요청 {total}건, 표시 {len(flagged)}건 → docs/qa/evidence/fuzz-summary.md")


if __name__ == "__main__":
    main()
