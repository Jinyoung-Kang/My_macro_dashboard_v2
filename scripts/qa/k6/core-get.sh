#!/usr/bin/env bash
# scripts/qa/k6/core-get.sh — 11경로 혼합 부하(core-get.js)를 동시 1·5·20·50명으로 차례로 돌리고, 단계마다 QA 컨테이너의 CPU 평균·최대와
# 메모리 최대(docker stats 3초 간격)를 함께 적습니다. QA 스택에서만 — 로컬 스택·운영 서버에는 돌리지 않습니다(CLAUDE.md).
# 사용: bash scripts/qa/k6/core-get.sh [출력파일]   (VUS_LIST="1 5 20 50" DURATION=60s 로 바꿀 수 있음)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"; cd "$ROOT"
OUT="${1:-/dev/stdout}"
PROJECT="${QA_PROJECT:-my_macrodash_v2_qa}"
STATS="$(mktemp "${TMPDIR:-/tmp}/core-get-stats.XXXXXX")"; trap 'rm -f "$STATS"' EXIT
{
  echo "# $(TZ=Asia/Seoul date '+%F %T') KST core-get.js $(git rev-parse --short HEAD 2>/dev/null)"
  for vus in ${VUS_LIST:-1 5 20 50}; do
    : > "$STATS"
    ( while true; do
        docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' 2>/dev/null | grep "^${PROJECT}-" >> "$STATS"
        sleep 3
      done ) &
    sampler=$!
    docker run --rm --network host -v "$ROOT/scripts/qa/k6:/s:ro" grafana/k6:2.3.0 run -q \
      -e VUS="$vus" -e DURATION="${DURATION:-60s}" /s/core-get.js 2>/dev/null
    kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
    python3 - "$STATS" "$vus" <<'PY'
import re, sys
rows = {}
for line in open(sys.argv[1]):
    parts = line.split()
    if len(parts) < 3:
        continue
    name, cpu, mem = parts[0], float(parts[1].rstrip('%')), parts[2]
    m = re.match(r'([\d.]+)([KMG]i?B)', mem)
    mib = float(m.group(1)) * {'KiB': 1 / 1024, 'MiB': 1, 'GiB': 1024, 'kB': 1 / 1024, 'MB': 1, 'GB': 1024}.get(m.group(2), 1) if m else 0
    r = rows.setdefault(name, [[], 0.0])
    r[0].append(cpu)
    r[1] = max(r[1], mib)
for name in sorted(rows):
    if not any(k in name for k in ('backend', 'collector', 'postgres')):
        continue
    cpus, mem = rows[name]
    print(f"   자원 vu{sys.argv[2]} {name} cpu_avg={sum(cpus) / len(cpus):.0f}% cpu_max={max(cpus):.0f}% mem_max={mem:.1f}MiB")
PY
  done
} > "$OUT"
