#!/usr/bin/env bash
# scripts/qa/dep-advisories.sh — Maven 런타임 의존성(백엔드)의 알려진 취약점을 GitHub Advisory DB에서 조회.
# 사용: bash scripts/qa/dep-advisories.sh  (gh CLI 로그인 필요, 네트워크 1회/의존성)
# pip-audit·npm audit은 CI(.github/workflows/ci.yml)와 make test가 다루므로 여기서는 Maven만.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null)}"
list="$(mktemp "${TMPDIR:-/tmp}/mvndeps.XXXXXX")"; trap 'rm -f "$list"' EXIT
(cd "$ROOT/backend" && mvn -q -B dependency:list -DincludeScope=runtime -DoutputFile="$list" >/dev/null) || { echo "mvn dependency:list 실패"; exit 1; }
found=0
grep -E "^\s+[a-zA-Z]" "$list" | sed -E 's/^\s+//; s/:(jar|pom):/:/; s/:(compile|runtime).*//' | sort -u | while IFS=: read -r group artifact version; do
  result="$(gh api -X GET /advisories -f ecosystem=maven -f affects="$group:$artifact@$version" -f per_page=20 --jq '.[] | "\(.severity) \(.ghsa_id) \(.cve_id // "-") \(.summary)"' 2>/dev/null)"
  if [ -n "$result" ]; then
    echo "✗ $group:$artifact:$version"; printf '%s\n' "$result" | sed 's/^/    /'; found=1
  else
    echo "✓ $group:$artifact:$version"
  fi
done
