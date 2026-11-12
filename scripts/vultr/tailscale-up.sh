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
#   · Tailscale DNS는 쓰지 않습니다(--accept-dns=false, QA-415 — ADR 0023 개정 2026-11-12). 서버는 tailnet 이름을 조회할 일이 없고,
#     2026-11-12 재부팅 뒤 tailscaled가 이 이미지의 DNS 관리 방식을 openresolv로 잘못 보고 상위 DNS를 잃어 /etc/resolv.conf의
#     100.100.100.100이 모든 조회에 실패를 돌려줬습니다(서버·컨테이너의 외부 조회 전부). 이미 그렇게 바뀌어 있으면 원래 설정으로 되돌립니다.
#   · tailscale serve https:443 → 127.0.0.1:8201(caddy, compose.vultr.yml) — tailnet 안에서만. funnel(공개)은 쓰지 않습니다.
#     인증서는 Tailscale이 받습니다(관리 콘솔 DNS에서 MagicDNS·HTTPS Certificates가 켜져 있어야 함 — 서버의 accept-dns와 무관).
#   · 끝에 서버의 이름 조회를 확인하고, 실패하면 0이 아닌 값으로 끝납니다.
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
    tailscale set --ssh --hostname "$HOST" --accept-dns=false
else
    echo "== tailnet 등록(auth key는 stdin)"
    key="$(cat)"
    [ -n "$key" ] || { echo "✗ stdin에 auth key가 없습니다." >&2; exit 1; }
    tailscale up --ssh --hostname "$HOST" --accept-dns=false --auth-key "$key"
    unset key
fi

# Tailscale이 전에 /etc/resolv.conf를 자기 리졸버로 바꿔 두었으면 Tailscale 이전 설정(Tailscale이 남긴 백업)으로 되돌립니다 — 위 오판 상태에서는
# accept-dns를 꺼도 tailscaled가 되돌리지 않습니다(2026-11-12 실측). 링크(systemd-resolved 스텁)는 건드리지 않고, 바꾼 파일은 지우지 않고 남깁니다.
# 시험은 두 경로를 환경변수로 바꿉니다.
resolv="${RESOLV_CONF:-/etc/resolv.conf}"
backup="${RESOLV_BACKUP:-/etc/resolv.pre-tailscale-backup.conf}"
ts_dns='^nameserver 100\.100\.100\.100'
if grep -q "$ts_dns" "$resolv" 2>/dev/null; then
    if [ -f "$resolv" ] && [ ! -L "$resolv" ] && [ -s "$backup" ] && ! grep -q "$ts_dns" "$backup"; then
        cp -p "$resolv" "$resolv.tailscale-$(date +%Y%m%d%H%M%S)"
        cp "$backup" "$resolv"
        echo "== $resolv를 Tailscale 이전 설정($backup)으로 되돌림"
    else
        echo "경고: $resolv가 Tailscale 리졸버(100.100.100.100)를 가리키는데 되돌릴 원래 설정이 없습니다 — 손으로 고치세요(DEVELOPMENT §7)." >&2
    fi
fi

echo "== serve: https:443 → 127.0.0.1:8201"
tailscale serve --bg --https=443 http://127.0.0.1:8201 >/dev/null
tailscale serve status

if ! getent hosts pkgs.tailscale.com >/dev/null 2>&1; then
    echo "✗ 서버의 이름 조회가 실패합니다(getent hosts pkgs.tailscale.com) — $resolv를 확인하세요(QA-415, DEVELOPMENT §7)." >&2
    exit 1
fi
echo "== 끝: $(tailscale version | head -1) · $(tailscale ip -4) · $(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"])')"
