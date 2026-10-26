#!/usr/bin/env bash
# scripts/qa/auth-probe.sh — 인증 누락·경로 변형·메서드·헤더·CORS·쿠키 점검 (QA 스택 대상)
#
# 사용: bash scripts/qa/auth-probe.sh [호스트:포트]   (기본 127.0.0.1:18082 — .env.qa의 BACKEND_PORT)
# 출력: 사람이 읽는 표 + 실패 수. 결과를 docs/qa/evidence/에 저장해 두세요.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="$(grep -s '^BACKEND_PORT=' "$ROOT/.env.qa" | cut -d= -f2)"; PORT="${PORT:-18082}"
BASE="${1:-127.0.0.1:$PORT}"
FRONT_PORT="$(grep -s '^FRONTEND_PORT=' "$ROOT/.env.qa" | cut -d= -f2)"; FRONT_PORT="${FRONT_PORT:-13002}"
fails=0
check() {  # check <설명> <기대코드(정규식)> <실제코드>
  if [[ "$3" =~ ^($2)$ ]]; then printf '  ✓ %-70s %s\n' "$1" "$3"; else printf '  ✗ %-70s %s (기대 %s)\n' "$1" "$3" "$2"; fails=$((fails+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

echo "## 1. 쿠키 없이 — 로그인이 필요한 경로(routes.json의 routes)는 모두 401, 공개 경로(public)는 401이 아님"
# routes.json은 백엔드 경로 전체를 담고 public은 AccessPolicy의 공개 경로와 같습니다(RouteInventoryTest가 대조, QA-110).
# 목록을 먼저 받아 두고 돕니다 — 예전처럼 `python3 … | while`로 돌면 루프가 서브셸이라 이 절의 실패가 끝의 합계에
# 더해지지 않았습니다.
probe_list="$(python3 - "$ROOT/scripts/qa/routes.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
sample = {"seriesId": "DGS10", "taskName": "fred_series"}
fill = lambda p: re.sub(r"\{(\w+)\}", lambda m: sample.get(m.group(1), "1"), p)
for r in d["routes"]:
    print("auth", r["m"], fill(r["p"]))
for route in d["public"]:
    m, p = route.split(" ", 1)
    print("public", m, fill(p))
PY
)"
while read -r kind m p; do
  [ -n "$kind" ] || continue
  if [ "$kind" = "auth" ]; then
    check "$m $p" "401" "$(code -X "$m" "http://$BASE$p")"
    continue
  fi
  case "$m $p" in
    "GET /api/health") check "$m $p (공개)" "200|503" "$(code "http://$BASE$p")" ;;
    "GET /api/auth/session") check "$m $p (공개)" "200" "$(code "http://$BASE$p")" ;;
    # 로그인은 4절에서 따로 봅니다(여기서 부르면 실패 기록·지연만 늘어남, 빈 자격 증명의 401은 처리기의 응답).
    "POST /api/auth/login") ;;
    # 가입·인증·재설정: 빈 본문이면 400, 메일이 꺼진 QA 스택의 가입·재설정 요청은 503, 연속 호출은 429
    *) check "$m $p (공개)" "400|429|503" "$(code -X "$m" -H 'Content-Type: application/json' \
         -H "Origin: http://localhost:$FRONT_PORT" --data-binary '{}' "http://$BASE$p")" ;;
  esac
done <<< "$probe_list"

echo "## 2. 경로 변형으로 공개 경로 판정 우회 시도 → 401 (또는 404/400), 200은 실패"
for p in "/api/health/../status" "/api/health/..;/status" "/api//status" "/API/status" "/api/status/" "/api/status%2f" "/api/health%2F..%2Fstatus" "/api/status;x" "/api/status?x=/api/health" "//api/status" "/api/./status" "/api/auth/session/../../status"; do
  c=$(code "http://$BASE$p"); check "GET $p" "401|404|400" "$c"
done

echo "## 3. 가짜·조작 쿠키 → 401"
check "session=garbage" "401" "$(code -b 'session=garbage' "http://$BASE/api/status")"
check "session=빈 값" "401" "$(code -b 'session=' "http://$BASE/api/status")"
check "alg=none JWT" "401" "$(code -b "session=eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImV4cCI6NDEwMjQ0NDgwMH0." "http://$BASE/api/status")"
check "기본 비밀(change-me…)로 서명한 HS256 JWT" "401" "$(code -b "session=$(python3 - <<'PY'
import hmac, hashlib, base64, json, time
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
h = b64(json.dumps({"alg":"HS256","typ":"JWT"}).encode()); p = b64(json.dumps({"sub":"admin","exp":int(time.time())+3600}).encode())
sig = b64(hmac.new(b"change-me-please-change-me-please-32b", f"{h}.{p}".encode(), hashlib.sha256).digest())
print(f"{h}.{p}.{sig}")
PY
)" "http://$BASE/api/status")"
check "Authorization: Bearer 토큰(쿠키 아님)" "401" "$(code -H 'Authorization: Bearer x' "http://$BASE/api/status")"

echo "## 4. 메서드"
check "HEAD /api/status (쿠키 없음)" "401|405" "$(code -I "http://$BASE/api/status")"
check "OPTIONS /api/status (preflight 아님)" "401|200|405|403" "$(code -X OPTIONS "http://$BASE/api/status")"
check "PUT /api/status" "401|405" "$(code -X PUT "http://$BASE/api/status")"
check "TRACE /api/status" "401|405|403" "$(code -X TRACE "http://$BASE/api/status")"
check "POST /api/auth/login 빈 본문" "400|401" "$(code -X POST -H 'Content-Type: application/json' "http://$BASE/api/auth/login")"
check "POST /api/auth/login 5KB 본문" "413|400|401" "$(code -X POST -H 'Content-Type: application/json' --data-binary "{\"password\":\"$(head -c 5000 /dev/zero | tr '\0' a)\"}" "http://$BASE/api/auth/login")"
check "POST /api/auth/login 깨진 JSON" "400|401" "$(code -X POST -H 'Content-Type: application/json' --data-binary '{"password":' "http://$BASE/api/auth/login")"
check "POST /api/auth/login 틀린 비밀번호" "401" "$(code -X POST -H 'Content-Type: application/json' -H "Origin: http://localhost:$FRONT_PORT" --data-binary '{"password":"definitely-wrong-password"}' "http://$BASE/api/auth/login")"

echo "## 5. CORS — 다른 출처"
hdrs=$(curl -s -D - -o /dev/null --max-time 10 -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: GET' -X OPTIONS "http://$BASE/api/status")
if printf '%s' "$hdrs" | grep -qi '^access-control-allow-origin: *http://evil.example'; then echo "  ✗ evil.example 출처가 CORS 허용됨"; fails=$((fails+1)); else echo "  ✓ evil.example 출처 CORS 불허"; fi
hdrs=$(curl -s -D - -o /dev/null --max-time 10 -H "Origin: http://192.168.0.77:$FRONT_PORT" -H 'Access-Control-Request-Method: GET' -X OPTIONS "http://$BASE/api/status")
if printf '%s' "$hdrs" | grep -qi "^access-control-allow-origin: *http://192.168.0.77:$FRONT_PORT"; then echo "  ✓ LAN 호스트:화면 포트 출처 허용(의도)"; else echo "  ✗ LAN 호스트:화면 포트 출처가 불허됨(휴대폰 접속 회귀)"; fails=$((fails+1)); fi
hdrs=$(curl -s -D - -o /dev/null --max-time 10 -H "Origin: http://192.168.0.77:9999" -H 'Access-Control-Request-Method: GET' -X OPTIONS "http://$BASE/api/status")
if printf '%s' "$hdrs" | grep -qi '^access-control-allow-origin:'; then echo "  ✗ 다른 포트 출처가 허용됨"; fails=$((fails+1)); else echo "  ✓ 다른 포트 출처 불허"; fi

echo "## 6. 보안 헤더 (/api/health)"
hdrs=$(curl -s -D - -o /dev/null --max-time 10 "http://$BASE/api/health")
for h in "x-content-type-options: nosniff" "cache-control: no-store" "x-frame-options: deny"; do
  if printf '%s' "$hdrs" | tr 'A-Z' 'a-z' | grep -q "^$h"; then echo "  ✓ $h"; else echo "  ✗ $h 없음"; fails=$((fails+1)); fi
done
if printf '%s' "$hdrs" | grep -qi '^server:'; then echo "  ! Server 헤더 노출: $(printf '%s' "$hdrs" | grep -i '^server:' | tr -d '\r')"; else echo "  ✓ Server 헤더 없음"; fi
if printf '%s' "$hdrs" | grep -qi '^x-powered-by:'; then echo "  ! X-Powered-By 노출"; fi
echo "## 7. 화면 응답 헤더 (/login)"
fh=$(curl -s -D - -o /dev/null --max-time 10 "http://127.0.0.1:$FRONT_PORT/login")
for h in "x-content-type-options: nosniff" "x-frame-options: deny" "content-security-policy:" "referrer-policy:"; do
  if printf '%s' "$fh" | tr 'A-Z' 'a-z' | grep -qi "^$h"; then echo "  ✓ $h"; else echo "  ! $h 없음"; fi
done
if printf '%s' "$fh" | grep -qi '^x-powered-by:'; then echo "  ! 화면 X-Powered-By 노출: $(printf '%s' "$fh" | grep -i '^x-powered-by:' | tr -d '\r')"; fi

echo "## 8. 수집기 — 호스트에서 토큰 없이"
CPORT="$(grep -s '^COLLECTOR_PORT=' "$ROOT/.env.qa" | cut -d= -f2)"; CPORT="${CPORT:-18002}"
# 읽기 전용 진단 경로(/status·/tasks·/task-history)는 설계상 토큰 없이 열려 있습니다(doctor·make status가
# 씁니다). 127.0.0.1에만 열려 있고 Host 검증이 있어 외부에서는 닿지 않습니다 — 결함이 아니라 설계로 기록합니다.
for p in /status /tasks /task-history; do
  check "GET $p 토큰 없음 (읽기 전용 진단 — 설계상 공개)" "200" "$(code "http://127.0.0.1:$CPORT$p")"
done
for p in "/live/radar" "/live/ticker/AAPL" "/diagnostics/connections"; do
  check "GET $p 토큰 없음" "401|403" "$(code "http://127.0.0.1:$CPORT$p")"
done
for p in /collect "/collect/task/fred_series" /refresh; do
  check "POST $p 토큰 없음" "401|403" "$(code -X POST "http://127.0.0.1:$CPORT$p")"
done
check "GET /health 토큰 없음(공개)" "200" "$(code "http://127.0.0.1:$CPORT/health")"
check "GET /health Host: attacker.example" "400" "$(code -H 'Host: attacker.example' "http://127.0.0.1:$CPORT/health")"
check "GET /live/radar Bearer 틀린 토큰" "401|403" "$(code -H 'Authorization: Bearer wrong' "http://127.0.0.1:$CPORT/live/radar")"

echo; echo "실패 ${fails}건"; exit $(( fails > 0 ))
