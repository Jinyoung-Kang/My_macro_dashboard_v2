#!/usr/bin/env bash
# 임시(저장소 밖): QA postgres에 모든 문장 기록을 잠깐 켜고, 화면이 부르는 GET 경로를 하나씩 두 번 불러 경로마다 SQL 문장 수·DB 시간을 센다.
# QA 스택에만 쓴다. 끝나면 기록 설정을 되돌린다.
# 사용: sql-replay.sh <저장소> <GET 목록 파일> <출력 폴더>
set -uo pipefail
REPO="$1"; URLS="$2"; OUT="$3"
PG=my_macrodash_v2_qa-postgres-1
BASE=http://127.0.0.1:18082
psqlq() { docker exec -i "$PG" sh -c 'psql -q -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"' ; }
restore() {
  printf '%s\n' "ALTER SYSTEM RESET log_min_duration_statement;" "ALTER SYSTEM RESET log_line_prefix;" "SELECT pg_reload_conf();" | psqlq >/dev/null
}
trap restore EXIT
printf '%s\n' "ALTER SYSTEM SET log_min_duration_statement = 0;" "ALTER SYSTEM SET log_line_prefix = '%m [%p] ';" "SELECT pg_reload_conf();" | psqlq >/dev/null
sleep 2
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
: > "$OUT/sql-times.tsv"
n=0
while read -r u; do
  [ -n "$u" ] || continue
  n=$((n + 1))
  for pass in 1 2; do
    echo "SELECT 'QMARK $n $pass begin';" | psqlq >/dev/null
    t=$(curl -s -m 60 -o /dev/null -w '%{time_total} %{http_code}' "$BASE$u")
    echo "SELECT 'QMARK $n $pass end';" | psqlq >/dev/null
    printf '%s\t%s\t%s\t%s\n' "$n" "$pass" "$t" "$u" >> "$OUT/sql-times.tsv"
  done
done < "$URLS"
sleep 1
docker logs --since "$START" "$PG" > "$OUT/sql-log.txt" 2>&1
wc -l "$OUT/sql-log.txt"
