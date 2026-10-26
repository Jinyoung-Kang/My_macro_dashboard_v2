#!/usr/bin/env bash
# scripts/qa/lighthouse.sh — 로그인 쿠키로 Lighthouse(성능·접근성·모범 사례)를 돌립니다 (QA 스택, 로컬 Chrome).
# 사용: bash scripts/qa/lighthouse.sh [출력폴더]   → 폴더에 페이지별 JSON, 표준출력에 점수 표
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
OUT="${1:-/tmp/lighthouse-qa}"; mkdir -p "$OUT"
env_value() { grep -s "^$1=" .env.qa | head -1 | cut -d= -f2-; }
FRONT="http://localhost:$(env_value FRONTEND_PORT)"; BACK="http://127.0.0.1:$(env_value BACKEND_PORT)"
JAR="$(mktemp -t lhcookie)"; trap 'rm -f "$JAR"' EXIT
curl -s -o /dev/null -c "$JAR" -H 'Content-Type: application/json' -H "Origin: $FRONT" \
  --data-binary "$( (env_value OWNER_EMAIL; env_value APP_PASSWORD) | python3 -c 'import json,sys; e,p=sys.stdin.read().split("\n")[:2]; print(json.dumps({"email": e.strip(), "password": p.strip()}))')" "$BACK/api/auth/login"
COOKIE="$(awk '$6=="my_macro_v2_session"{print $7}' "$JAR")"
[ -n "$COOKIE" ] || { echo "로그인 실패"; exit 1; }
printf '%-16s %-8s %5s %5s %5s %8s %8s %6s\n' 페이지 폼팩터 성능 접근성 모범 'LCP(ms)' 'TBT(ms)' CLS
for page in /login / /macro /institutions /radar /status /paper/us; do
  for form in desktop mobile; do
    name="$(echo "${page#/}" | tr '/' '_')"; [ -n "$name" ] || name=root
    extra=(); [ "$form" = desktop ] && extra=(--preset=desktop)
    npx --yes lighthouse@12 "$FRONT$page" --quiet --chrome-flags="--headless=new --no-sandbox" \
      --only-categories=performance,accessibility,best-practices --output=json --output-path="$OUT/$name-$form.json" \
      --extra-headers="{\"Cookie\":\"my_macro_v2_session=$COOKIE\"}" ${extra[@]+"${extra[@]}"} >/dev/null 2>&1 \
      || { printf '%-16s %-8s 실패\n' "$page" "$form"; continue; }
    python3 - "$OUT/$name-$form.json" "$page" "$form" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); c = d["categories"]; a = d["audits"]
def score(k): return round((c[k]["score"] or 0) * 100)
def ms(k): return round(a[k]["numericValue"]) if a.get(k) and a[k].get("numericValue") is not None else "-"
print(f"{sys.argv[2]:<16} {sys.argv[3]:<8} {score('performance'):>5} {score('accessibility'):>5} {score('best-practices'):>5} {ms('largest-contentful-paint'):>8} {ms('total-blocking-time'):>8} {a['cumulative-layout-shift']['numericValue']:>6.3f}")
PY
  done
done
