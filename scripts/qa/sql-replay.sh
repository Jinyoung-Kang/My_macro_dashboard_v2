#!/usr/bin/env bash
# scripts/qa/sql-replay.sh — QA postgres에 모든 문장 기록(log_min_duration_statement = 0)을 잠깐 켜고, 화면이 부르는 GET 경로를 하나씩 두 번 불러
# 경로마다 SQL 문장 수·DB 시간을 셉니다(성능 개선 2차 재측정 — 첫 호출과 기억된 둘째 호출을 견줌). 끝나면(중단해도) 기록 설정을 되돌립니다.
# 사용: bash scripts/qa/sql-replay.sh <GET 목록> <출력 폴더>
#   GET 목록: hang-test.sh와 같음(한 줄에 '/api/…' 하나, 또는 page-apis.js의 결과 JSON).
# 출력: 폴더에 sql-times.tsv(번호·회차·'초 상태'·경로)와 sql-log.txt(그동안의 postgres 로그 — 'QMARK 번호 회차 begin/end' 표시 사이가 그 호출의 문장).
#   표준출력에 경로마다 회차별 문장 수·문장 시간 합(ms) 상위 30줄.
# 안전: GET만, 경로마다 두 번. QA 스택에만 쓰세요 — 로컬 스택·운영 서버에는 쓰지 않습니다(CLAUDE.md). 로그에 질의 인자 값이 남으니 sql-log.txt를
#   저장소에 넣지 마세요(표로 정리한 값만 docs/qa/evidence/).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
LIST="${1:?GET 목록 파일이 필요합니다(머리 설명)}"; OUT="${2:?출력 폴더가 필요합니다}"
mkdir -p "$OUT"
env_value() { grep -s "^$1=" .env.qa | head -1 | cut -d= -f2-; }
BASE="http://127.0.0.1:$(env_value BACKEND_PORT)"
psqlq() { bash scripts/qa/qa-stack.sh exec postgres sh -c 'psql -q -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; }
URLS="$(mktemp "${TMPDIR:-/tmp}/sql-replay.XXXXXX")"
restore() {
  printf '%s\n' "ALTER SYSTEM RESET log_min_duration_statement;" "ALTER SYSTEM RESET log_line_prefix;" "SELECT pg_reload_conf();" | psqlq >/dev/null
  rm -f "$URLS"
}
trap restore EXIT
case "$LIST" in
  *.json) python3 -c 'import json,sys
seen = []
for page in json.load(open(sys.argv[1])):
    for a in page.get("apis", []):
        if a.get("method") == "GET" and not a.get("sse") and a["url"].startswith("/api/") and a["url"] not in seen:
            seen.append(a["url"])
print("\n".join(seen))' "$LIST" > "$URLS" ;;
  *) sed -e 's/#.*$//' -e 's/[[:space:]]*$//' "$LIST" | grep -v '^$' > "$URLS" ;;
esac
printf '%s\n' "ALTER SYSTEM SET log_min_duration_statement = 0;" "ALTER SYSTEM SET log_line_prefix = '%m [%p] ';" "SELECT pg_reload_conf();" | psqlq >/dev/null
sleep 2
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
: > "$OUT/sql-times.tsv"
n=0
while read -r u; do
  n=$((n + 1))
  for pass in 1 2; do
    echo "SELECT 'QMARK $n $pass begin';" | psqlq >/dev/null
    t=$(curl -s -m 60 -o /dev/null -w '%{time_total} %{http_code}' "$BASE$u")
    echo "SELECT 'QMARK $n $pass end';" | psqlq >/dev/null
    printf '%s\t%s\t%s\t%s\n' "$n" "$pass" "$t" "$u" >> "$OUT/sql-times.tsv"
  done
done < "$URLS"
sleep 1
TAIL=all bash scripts/qa/qa-stack.sh logs --no-log-prefix --since "$START" postgres > "$OUT/sql-log.txt" 2>&1
python3 - "$OUT" <<'PY'
import re, sys
out = sys.argv[1]
paths = {}
for line in open(f"{out}/sql-times.tsv", encoding="utf-8"):
    n, p, t, u = line.rstrip("\n").split("\t")
    paths[(n, p)] = (u, t.split()[0])
cur, stats = None, {}
for line in open(f"{out}/sql-log.txt", encoding="utf-8", errors="replace"):
    m = re.search(r"QMARK (\d+) (\d+) (begin|end)", line)
    if m:
        cur = (m.group(1), m.group(2)) if m.group(3) == "begin" else None
        continue
    d = re.search(r"duration: ([0-9.]+) ms", line)
    if cur and d:
        s = stats.setdefault(cur, [0, 0.0]); s[0] += 1; s[1] += float(d.group(1))
rows = sorted(((paths[k][0], k[1], v[0], v[1], paths[k][1]) for k, v in stats.items() if k in paths), key=lambda r: -r[3])
print(f"{'문장':>4} {'DB ms':>8} {'응답 초':>7} 회차 경로")
for u, p, cnt, ms, t in rows[:30]:
    print(f"{cnt:>4} {ms:>8.1f} {float(t):>7.3f} {p:>4} {u[:100]}")
PY
