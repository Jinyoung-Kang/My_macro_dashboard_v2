#!/usr/bin/env bash
# scripts/qa/lighthouse.sh — Lighthouse 13.6.0(성능·접근성·모범 사례)을 화면마다 N번 돌려 중앙값을 냅니다 (QA 스택, 로컬 Chrome).
# 사용: bash scripts/qa/lighthouse.sh [출력폴더=/tmp/lighthouse-qa] [N=3]
#       PAGES="/ /macro" FORMS="mobile" bash scripts/qa/lighthouse.sh …   (화면·폼팩터를 좁힐 때)
# 출력: 폴더에 실행마다 JSON(<화면>-<폼팩터>-<회차>.json), 표준출력에 화면·폼팩터마다 N회 중앙값 한 줄 —
#       성능·접근성·모범 사례 점수, FCP·LCP·TBT(ms), CLS, 스크립트 전송량(KB), RSC 미리 받기 수(?_rsc= 요청), 스크립트 수.
# 로그인: 백엔드가 로그인 없는 모드(GET /api/auth/session의 noLogin — QA_NO_LOGIN=1)면 쿠키 없이, 아니면 .env.qa의 운영자 계정으로 로그인해 쿠키로.
# WSL에서 Lighthouse(chrome-launcher)는 실행한 폴더에 'C:\Users\…\lighthouse.XXXXXX' 이름의 폴더를 남깁니다 — 그래서 임시 폴더로 옮겨 가서
# 돌리고 끝에 그 폴더를 통째로 지웁니다. 캡처·JSON은 커밋하지 않습니다(표로 정리한 값만 docs/qa/evidence/).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
OUT="${1:-/tmp/lighthouse-qa}"; N="${2:-3}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
env_value() { grep -s "^$1=" .env.qa | head -1 | cut -d= -f2-; }
FRONT="http://localhost:$(env_value FRONTEND_PORT)"; BACK="http://127.0.0.1:$(env_value BACKEND_PORT)"
PAGES="${PAGES:-/ /macro /institutions /paper/us /paper/kr /info/overview /s/us/NVDA}"
FORMS="${FORMS:-desktop mobile}"
if [ -z "${CHROME_PATH:-}" ] && [ -x /usr/bin/google-chrome ]; then export CHROME_PATH=/usr/bin/google-chrome; fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lhwork.XXXXXX")"; JAR="$WORK/cookie"
trap 'cd /; rm -rf "$WORK"' EXIT

HEADERS=()
NO_LOGIN=$(curl -s "$BACK/api/auth/session" | python3 -c 'import json,sys
try: print("1" if json.load(sys.stdin).get("noLogin") is True else "")
except Exception: print("")')
if [ -z "$NO_LOGIN" ]; then
  curl -s -o /dev/null -c "$JAR" -H 'Content-Type: application/json' -H "Origin: $FRONT" \
    --data-binary "$( (env_value OWNER_EMAIL; env_value APP_PASSWORD) | python3 -c 'import json,sys; e,p=sys.stdin.read().split("\n")[:2]; print(json.dumps({"email": e.strip(), "password": p.strip()}))')" "$BACK/api/auth/login"
  COOKIE="$(awk '$6=="my_macro_v2_session"{print $7}' "$JAR")"
  [ -n "$COOKIE" ] || { echo "로그인 실패"; exit 1; }
  HEADERS=(--extra-headers="{\"Cookie\":\"my_macro_v2_session=$COOKIE\"}")
fi

cd "$WORK"
echo "# $(TZ=Asia/Seoul date '+%F %T') KST lighthouse 13.6.0 N=$N $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null) $([ -n "$NO_LOGIN" ] && echo 로그인없음)"
printf '%-16s %-8s %4s %4s %4s %7s %7s %7s %6s %6s %4s %4s\n' 페이지 폼팩터 성능 접근 모범 'FCP' 'LCP' 'TBT' CLS 'JS(KB)' RSC JS수
for page in $PAGES; do
  for form in $FORMS; do
    name="$(echo "${page#/}" | tr '/' '_')"; [ -n "$name" ] || name=root
    extra=(); [ "$form" = desktop ] && extra=(--preset=desktop)
    files=()
    for i in $(seq 1 "$N"); do
      f="$OUT/$name-$form-$i.json"
      npx --yes lighthouse@13.6.0 "$FRONT$page" --quiet --chrome-flags="--headless=new --no-sandbox" \
        --only-categories=performance,accessibility,best-practices --output=json --output-path="$f" \
        ${HEADERS[@]+"${HEADERS[@]}"} ${extra[@]+"${extra[@]}"} >/dev/null 2>&1 && files+=("$f")
    done
    [ "${#files[@]}" -gt 0 ] || { printf '%-16s %-8s 실패\n' "$page" "$form"; continue; }
    python3 - "$page" "$form" "${files[@]}" <<'PY'
import json, statistics, sys
page, form, files = sys.argv[1], sys.argv[2], sys.argv[3:]
rows = []
for path in files:
    d = json.load(open(path)); c = d["categories"]; a = d["audits"]
    reqs = (a.get("network-requests", {}).get("details") or {}).get("items") or []
    scripts = [r for r in reqs if r.get("resourceType") == "Script"]
    rows.append({
        "perf": round((c["performance"]["score"] or 0) * 100),
        "a11y": round((c["accessibility"]["score"] or 0) * 100),
        "bp": round((c["best-practices"]["score"] or 0) * 100),
        "fcp": a["first-contentful-paint"]["numericValue"],
        "lcp": a["largest-contentful-paint"]["numericValue"],
        "tbt": a["total-blocking-time"]["numericValue"],
        "cls": a["cumulative-layout-shift"]["numericValue"],
        "js": sum(r.get("transferSize") or 0 for r in scripts) / 1024,
        "rsc": sum(1 for r in reqs if "_rsc=" in (r.get("url") or "")),
        "jsn": len(scripts),
    })
med = lambda k: statistics.median(r[k] for r in rows)
print(f"{page:<16} {form:<8} {med('perf'):>4.0f} {med('a11y'):>4.0f} {med('bp'):>4.0f} {med('fcp'):>7.0f} {med('lcp'):>7.0f} "
      f"{med('tbt'):>7.0f} {med('cls'):>6.3f} {med('js'):>6.0f} {med('rsc'):>4.0f} {med('jsn'):>4.0f}"
      + ("" if len(rows) == 1 else f"   (n={len(rows)}, 성능 {min(r['perf'] for r in rows)}~{max(r['perf'] for r in rows)})"))
PY
  done
done
