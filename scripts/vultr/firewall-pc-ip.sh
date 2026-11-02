#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/firewall-pc-ip.sh — PC 공인 IP가 바뀌었을 때 Vultr 방화벽 그룹의 22/tcp(비상용 SSH) 규칙을 지금 IP/32로 바꿉니다(ADR 0023).
#
#   bash scripts/vultr/firewall-pc-ip.sh
#
# 순서: 지금 PC 공인 IPv4(checkip.amazonaws.com) → 방화벽 그룹의 규칙 목록 → 22/tcp IPv4 규칙이 이미 그 IP/32 하나면 끝 →
# 아니면 새 규칙(지금 IP/32)을 먼저 넣고 옛 22/tcp IPv4 규칙을 지웁니다(넣기 전에 지우면 그 사이 SSH가 막힘). 그 밖의 규칙
# (Tailscale 직접 연결 41641/udp 등)은 건드리지 않습니다. 평소 접속은 Tailscale(ssh ubuntu@my-macro-app)이라 이 규칙은 비상용입니다.
#
# Vultr API 키 자체에도 허용 IP(이 PC 공인 IP)가 걸려 있어, PC IP가 바뀌면 이 스크립트의 API 호출도 거절(401·403)됩니다. API 키의
# 허용 IP는 Vultr 콘솔(Account → API → Access Control)에서만 바꿀 수 있습니다 — 거기서 먼저 고친 뒤 이 스크립트를 돌립니다.
# 필요한 것: curl, python3, .env의 VULTR_API_KEY·VULTR_FIREWALL_GROUP_ID(환경변수가 먼저).
# =============================================================================
set -euo pipefail

# shellcheck source=scripts/vultr/api-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/api-common.sh"   # vultr_api · die, .env 읽기, 저장소 최상위로 이동

group="${VULTR_FIREWALL_GROUP_ID:-$(env_file_value VULTR_FIREWALL_GROUP_ID)}"
[ -n "$group" ] || die ".env에 VULTR_FIREWALL_GROUP_ID(방화벽 그룹 ID)가 없습니다."
[[ "$group" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die "VULTR_FIREWALL_GROUP_ID가 방화벽 그룹 ID 모양(8-4-4-4-12 소문자 16진)이 아닙니다."

ip="$(curl -fsS --max-time 15 https://checkip.amazonaws.com | tr -d '[:space:]')" || die "이 PC의 공인 IP를 알아내지 못했습니다(checkip.amazonaws.com)."
[[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "받은 공인 IP가 IPv4 모양이 아닙니다."

vultr_api GET "/firewalls/$group/rules?per_page=500"
# 22/tcp IPv4 규칙: "이미 맞음"이면 ok, 아니면 지울 규칙 번호들(공백 구분).
plan="$(python3 -I - "$VULTR_BODY" "$ip" <<'PY'
import json
import sys

rules = json.load(open(sys.argv[1], encoding="utf-8"))["firewall_rules"]
ssh = [r for r in rules if r["ip_type"] == "v4" and r["protocol"] == "tcp" and str(r["port"]) == "22"]
if len(ssh) == 1 and ssh[0]["subnet"] == sys.argv[2] and int(ssh[0]["subnet_size"]) == 32:
    print("ok")
else:
    print(" ".join(str(r["id"]) for r in ssh))
PY
)"
if [ "$plan" = ok ]; then
    echo "✓ 22/tcp 규칙이 이미 이 PC의 지금 공인 IP/32입니다 — 바꿀 것이 없습니다."
    exit 0
fi

vultr_api POST "/firewalls/$group/rules" \
    "{\"ip_type\": \"v4\", \"protocol\": \"tcp\", \"subnet\": \"$ip\", \"subnet_size\": 32, \"port\": \"22\", \"notes\": \"ssh from pc\"}"
added="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["firewall_rule"]["id"])' "$VULTR_BODY")"
for old in $plan; do
    vultr_api DELETE "/firewalls/$group/rules/$old"
done
echo "✓ 22/tcp 규칙을 이 PC의 지금 공인 IP/32로 바꿨습니다(새 규칙 $added, 지운 규칙: ${plan:-없음})."
echo "   참고: Vultr API 키의 허용 IP는 이 스크립트가 바꾸지 못합니다 — Vultr 콘솔(Account → API → Access Control)."
