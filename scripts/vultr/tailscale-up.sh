#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/tailscale-up.sh — Vultr 서버를 tailnet에 넣고 화면을 Tailscale HTTPS로 엽니다(ADR 0023). 서버에서 root로 한 번.
#
#   PC에서:  scp scripts/vultr/tailscale-up.sh root@<서버 IP>:/root/ && printf '%s\n' "$TAILSCALE_AUTH_KEY" | ssh root@<서버 IP> bash /root/tailscale-up.sh
#   (키는 stdin — 인자·셸 기록에 남기지 않음. 'bash -s < 스크립트'로 보내면 stdin이 스크립트가 되어 키를 못 읽음)
#   서버에서 다시 돌려도 됩니다(된 단계는 건너뜀). 키는 처음 등록할 때만 읽습니다(이미 들어가 있으면 stdin을 읽지 않음).
#
#   · 공식 apt 저장소에서 tailscale 설치
#   · tailscale up --ssh --hostname my-macro-app  → Tailscale SSH(포트 22 없이 ssh ubuntu@my-macro-app)
#   · tailscale serve https:443 → 127.0.0.1:8201(caddy, compose.vultr.yml) — tailnet 안에서만. funnel(공개)은 쓰지 않습니다.
#     인증서는 Tailscale이 받습니다(관리 콘솔 DNS에서 MagicDNS·HTTPS Certificates가 켜져 있어야 함).
# =============================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "root로 실행하세요." >&2; exit 1; }
HOST=my-macro-app

if ! command -v tailscale >/dev/null; then
    echo "== tailscale 설치"
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
    install -m 0755 -d /usr/share/keyrings
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q tailscale
fi
systemctl enable --now tailscaled

if tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
    echo "== 이미 tailnet에 있음"
    tailscale set --ssh --hostname "$HOST"
else
    echo "== tailnet 등록(auth key는 stdin)"
    key="$(cat)"
    [ -n "$key" ] || { echo "✗ stdin에 auth key가 없습니다." >&2; exit 1; }
    tailscale up --ssh --hostname "$HOST" --auth-key "$key"
    unset key
fi

echo "== serve: https:443 → 127.0.0.1:8201"
tailscale serve --bg --https=443 http://127.0.0.1:8201 >/dev/null
tailscale serve status
echo "== 끝: $(tailscale version | head -1) · $(tailscale ip -4) · $(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"])')"
