# shellcheck shell=bash
# =============================================================================
# scripts/vultr/api-common.sh — PC의 Vultr API 스크립트(instance.sh·firewall-pc-ip.sh)가 source하는 공통 부분(ADR 0023). 혼자 실행하지 않습니다
# (scripts/db-common.sh처럼 — bash 옵션은 부르는 스크립트의 set -euo pipefail을 따름).
#
#   · .env 읽기(scripts/db-common.sh의 env_file_value — 환경변수가 먼저), 저장소 최상위로 이동
#   · vultr_api METHOD 경로 [JSON 본문] — 응답 본문은 $VULTR_BODY 파일, HTTP 상태는 $VULTR_STATUS.
#     API 키는 curl 인자에 넣지 않습니다(헤더를 파일 설명자로 넘김 — 프로세스 목록·셸 기록에 남지 않게).
#   · 401·403이면 API 키의 허용 IP(이 PC의 공인 IP)를 안내하고 멈춥니다 — 허용 IP는 Vultr 콘솔(Account → API → Access Control)에서만 바뀝니다.
# 필요한 것: curl, python3(JSON 읽기 — 맥·WSL 기본).
# =============================================================================

# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # env_file_value(.env 한 줄 읽기), 저장소 최상위로 이동

VULTR_API="https://api.vultr.com/v2"

die() {
    echo "✗ $*" >&2
    exit 1
}

command -v curl >/dev/null || die "curl이 없습니다."
command -v python3 >/dev/null || die "python3이 없습니다(JSON 읽기)."
VULTR_API_KEY="${VULTR_API_KEY:-$(env_file_value VULTR_API_KEY)}"
[ -n "$VULTR_API_KEY" ] || die ".env에 VULTR_API_KEY가 없습니다(Vultr 콘솔 Account → API)."

VULTR_BODY="$(mktemp)"
trap 'rm -f "$VULTR_BODY"' EXIT
VULTR_STATUS=000

vultr_api() {
    local method=$1 path=$2 body=${3:-}
    local data=()
    [ -z "$body" ] || data=(-H "Content-Type: application/json" --data "$body")
    VULTR_STATUS="$(curl -sS --max-time 30 -o "$VULTR_BODY" -w '%{http_code}' -X "$method" \
        -H @<(printf 'Authorization: Bearer %s\n' "$VULTR_API_KEY") ${data[@]+"${data[@]}"} "$VULTR_API$path")" || VULTR_STATUS=000
    case "$VULTR_STATUS" in
        2??) return 0 ;;
        401|403)
            die "Vultr API가 거절했습니다(HTTP $VULTR_STATUS) — API 키의 허용 IP가 이 PC의 지금 공인 IP와 다를 수 있습니다." \
                "허용 IP는 Vultr 콘솔(Account → API → Access Control)에서만 바꿀 수 있습니다." ;;
        000) die "Vultr API에 닿지 못했습니다($method $path) — 네트워크를 확인하세요." ;;
        *) die "Vultr API 오류(HTTP $VULTR_STATUS, $method $path): $(head -c 300 "$VULTR_BODY" | tr '\n' ' ')" ;;
    esac
}
