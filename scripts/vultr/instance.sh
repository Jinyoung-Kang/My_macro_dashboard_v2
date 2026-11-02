#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/instance.sh — PC에서 Vultr 서버(서울 my-macro-app)의 상태와 주소를 봅니다(ADR 0023).
#
#   bash scripts/vultr/instance.sh status    이름·지역·요금제·상태(status · power · server) 한 줄과 공인 IPv4·IPv6
#
# start·stop은 두지 않습니다 — 24시간 켜 두는 서버이고, Vultr는 꺼 둔 인스턴스에도 요금을 매깁니다. 다시 켤 일이 있으면 Vultr 콘솔.
# 화면은 tailnet 안에서 https://my-macro-app.<tailnet>.ts.net, 셸은 ssh ubuntu@my-macro-app(Tailscale SSH) — 공인 IP는 비상용 SSH
# (ssh -i ~/.ssh/id_ed25519_vultr ubuntu@<IP>, 방화벽 22는 PC IP만 — PC IP가 바뀌면 scripts/vultr/firewall-pc-ip.sh)에만 씁니다.
# 필요한 것: curl, python3, .env의 VULTR_API_KEY·VULTR_INSTANCE_ID(환경변수가 먼저).
# =============================================================================
set -euo pipefail

# shellcheck source=scripts/vultr/api-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/api-common.sh"   # vultr_api · die, .env 읽기, 저장소 최상위로 이동

[ "${1:-}" = status ] || die "사용법: bash scripts/vultr/instance.sh status"
instance="${VULTR_INSTANCE_ID:-$(env_file_value VULTR_INSTANCE_ID)}"
[ -n "$instance" ] || die ".env에 VULTR_INSTANCE_ID(서버 인스턴스 ID)가 없습니다."
[[ "$instance" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die "VULTR_INSTANCE_ID가 인스턴스 ID 모양(8-4-4-4-12 소문자 16진)이 아닙니다."

vultr_api GET "/instances/$instance"
python3 -I - "$VULTR_BODY" <<'PY'
import json
import sys

i = json.load(open(sys.argv[1], encoding="utf-8"))["instance"]
print(f"서버 {i['label']}: {i['region']} · {i['plan']} · status {i['status']} · power {i['power_status']} · server {i['server_status']}")
print(f"  공인 IPv4 {i['main_ip']} · IPv6 {i.get('v6_main_ip') or '-'}")
if i["power_status"] != "running":
    print("  참고: 꺼져 있습니다 — 24시간 켜 두는 서버입니다. Vultr 콘솔에서 켜세요.")
PY
