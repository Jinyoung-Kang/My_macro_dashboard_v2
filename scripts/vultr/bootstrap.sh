#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/bootstrap.sh — Vultr my-macro-app(서울 icn, vhf-2c-4gb, Ubuntu 24.04 LTS x64)의 첫 준비(ADR 0021).
# 인스턴스를 만들 때 cloud-init user-data로 넣으면 첫 기동 때 root로 한 번 돕니다. 기록은 /var/log/cloud-init-output.log.
# 다시 돌려도 됩니다(된 단계는 건너뜀). scripts/aws/bootstrap.sh에서 갈라냈고 다른 점은:
#
#   · Vultr 이미지는 root뿐이라 ubuntu 사용자(sudo·docker 그룹)를 만들고 root의 authorized_keys를 넘깁니다.
#   · sshd: 비밀번호 로그인 금지, root는 키로만. 방화벽은 Vultr 방화벽 그룹(22는 PC IP만, 443 공개)이 맡습니다.
#   · AWS CLI v2는 S3 백업(backup-s3.sh)을 계속 쓰기 위해 둡니다. 인증은 인스턴스 프로필이 없으니 ubuntu의 ~/.aws/credentials
#     (백업 버킷만 쓰는 IAM 사용자 키)로 — 이 스크립트는 비밀값을 다루지 않습니다.
#   · 나머지(Docker 공식 저장소, 스왑 2 GiB, journald 상한)는 같습니다. 디스크는 128 GB라 journald 상한은 500M.
# =============================================================================
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "root로 실행하세요(user-data는 root로 돕니다)." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

echo "== apt 갱신"
apt-get update -q
apt-get upgrade "${APT_OPTS[@]}"
apt-get install "${APT_OPTS[@]}" ca-certificates curl git make unzip

echo "== ubuntu 사용자"
if ! id ubuntu >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" ubuntu
fi
echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ubuntu
chmod 440 /etc/sudoers.d/90-ubuntu
if [ -f /root/.ssh/authorized_keys ] && [ ! -f /home/ubuntu/.ssh/authorized_keys ]; then
    install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
    install -m 600 -o ubuntu -g ubuntu /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
fi

echo "== sshd: 비밀번호 로그인 금지 (00- 으로 cloud-init의 50-cloud-init.conf보다 먼저 읽히게 — sshd는 먼저 나온 값이 이김)"
cat > /etc/ssh/sshd_config.d/00-my-macro.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh || systemctl reload sshd

echo "== Docker (공식 저장소)"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update -q
    apt-get install "${APT_OPTS[@]}" docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
id -nG ubuntu | grep -qw docker || usermod -aG docker ubuntu

echo "== AWS CLI v2 (S3 백업용)"
if ! command -v aws >/dev/null; then
    tmp="$(mktemp -d)"
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscliv2.zip"
    unzip -q "$tmp/awscliv2.zip" -d "$tmp"
    "$tmp/aws/install"
    rm -rf "$tmp"
fi
if [ ! -f /home/ubuntu/.aws/config ]; then
    install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.aws
    printf '[default]\nregion = ap-northeast-2\n' > /home/ubuntu/.aws/config
    chown ubuntu:ubuntu /home/ubuntu/.aws/config
fi

echo "== 스왑 2 GiB"
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
fi
swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "== journald 상한"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/my-macro.conf <<'EOF'
[Journal]
SystemMaxUse=500M
EOF
systemctl restart systemd-journald

echo "== 끝: $(docker --version) · $(docker compose version --short) · $(aws --version 2>&1 | cut -d' ' -f1) · 스왑 $(swapon --show=SIZE --noheadings | head -n 1)"
