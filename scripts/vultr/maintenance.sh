#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/maintenance.sh — Vultr 서버의 주간 자동 유지보수(ADR 0053). 손으로 하던 "백업 → Docker·Git 올림 → 이미지 다시 빌드 →
# Tailscale 올림 → 필요하면 재부팅 → 확인 → 보고"를 토요일에 한 번 돌립니다. 실패하면 그 단계에서 멈추고 운영 텔레그램 봇으로 알리며,
# 자동으로 되돌리지 않습니다(예외는 이름 조회·Tailscale이 어긋났을 때 문서의 복구 한 번 — 이름 조회가 깨지면 알림조차 못 나가므로).
#
# 순서
#   0 점검 — 하나라도 걸리면 아무것도 바꾸지 않고 '건너뜀'으로 알림:
#     ubuntu 사용자(root 아님)·서버(.env의 COMPOSE_FILE에 compose.vultr.yml)·잠금(backups/.deploy.lock — deploy.sh와 같은 잠금, 쥔 채
#     deploy.sh를 부름)·도는 복원 확인·S3 백업·서버 폴더의 판이 끝까지 배포된 판(backups/.last-deploy-ok — deploy.sh가 남김)인지·
#     sudo -n·실제 매매 가드(scripts/vultr/realtrade-guard.sh — deploy.sh와 같은 판정. REALTRADE_DEPLOY_OK는 지움 — 우회 없음).
#   1 S3 백업(backup-s3.sh)
#   2 apt-get update 뒤 Docker 출처(docker-ce·docker-ce-cli·docker-ce-rootless-extras·docker-compose-plugin·containerd.io·docker-buildx-plugin)와
#     Git PPA(git·git-man) 가운데 보류된 것만 --only-upgrade. 그 밖의 보류는 올리지 않고 이름만 보고(배포판 보안 수정은 자동 업데이트가 맡음).
#   3 이미지 다시 빌드·기동 — deploy.sh --no-fetch(코드를 받지 않음: 날짜를 정해 배포하기로 한 main의 변경이 저절로 나가지 않게) +
#     OS_PKG_REFRESH=그날 날짜(이미지 안 OS 패키지 층을 새로 만듦)
#   4 Tailscale — 보류가 있으면 다른 것을 다 올린 뒤·재부팅 앞에 따로 올림. 그다음 확인 넷(tailscaled 동작·tailnet 연결 Running·serve의
#     https:443 → 127.0.0.1:8201 줄·이름 조회와 /etc/resolv.conf가 Tailscale 리졸버가 아님). 어긋나면 복구 한 번(sudo bash
#     scripts/vultr/tailscale-up.sh — 이미 tailnet에 있으면 키를 읽지 않음, stdin은 /dev/null — + 앱 컨테이너 재시작) 뒤 다시 확인,
#     그래도 어긋나면 멈춤(재부팅하지 않음). 로그아웃·재가입·키·방화벽으로는 고치지 않습니다.
#   5 재부팅 — /var/run/reboot-required가 있거나 needrestart(-b)가 커널·서비스 재시작을 말할 때만. 표시 파일(backups/.maintenance-reboot)을
#     남기고 재부팅하면 @reboot cron이 --after-reboot로 6·7을 마저 합니다(표시가 2시간보다 오래됐으면 무시 — 손으로 한 재부팅에서 돌지 않게).
#   6 확인 — Tailscale 넷(이름 조회 포함 — 재부팅 뒤 어긋나면 같은 복구 한 번)·컨테이너 모두 동작·건강·백엔드 /api/health·스키마 번호·
#     reboot-check.sh --summary. 기동(재부팅) 뒤 5분의 ERROR 줄 수는 참고로만 셉니다(재부팅 전 줄은 빼고).
#   7 inventory.sh(버전 목록 — ADR 0046) → 텔레그램 운영 봇 한 통. 보내지 못하면 backups/.maintenance-unsent에 남겨 다음 실행과
#     매일의 reboot-check.sh(16:10 KST)가 다시 보냅니다.
#
# 사용(서버의 ubuntu 사용자 — 저장소 최상위로 옮겨 .env·backups/를 봄):
#   bash scripts/vultr/maintenance.sh --dry-run      아무것도 바꾸지 않고(쓰기·syslog·알림 없음) 점검 결과와 할 일만 찍음
#   bash scripts/vultr/maintenance.sh                실제 실행(cron). 출력은 backups/maintenance/<UTC 시각>.log(소유자만)로
#   bash scripts/vultr/maintenance.sh --after-reboot 재부팅 뒤 이어 하기(@reboot cron — 표시 파일이 없으면 아무것도 하지 않음)
#   손으로 실제 실행할 때는 Tailscale을 올리는 동안 SSH가 끊겨도 끝까지 돌도록:
#     sudo systemd-run --uid=ubuntu --gid=ubuntu --setenv=HOME=/home/ubuntu --unit=my-macro-maintenance-manual \
#       bash /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/maintenance.sh
# cron(서버의 ubuntu 사용자, 서버 시간대는 UTC — 08:30 UTC = 토 17:30 KST, 한국·미국 장과 실제 매매 창 밖):
#   30 8 * * 6 /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/maintenance.sh
#   @reboot /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/maintenance.sh --after-reboot
# 결과는 syslog(태그 my-macro-maintenance):  journalctl -t my-macro-maintenance
# 보고·syslog에는 패키지 이름·건수·단계 결과만 넣고 버전 문자열은 넣지 않습니다(저장소가 공개 — ADR 0046과 같은 규칙, 판은 /security 버전 목록).
# 자세한 출력(apt·docker 빌드)에는 판이 찍히므로 서버 밖으로 옮기지 않습니다. 텔레그램 값은 .env에서 읽고 찍지 않습니다(notify-common.sh).
# 시험은 경로·시각을 REBOOT_REQUIRED_FILE·RESOLV_CONF·MAINT_BOOT_EPOCH·MAINT_MARKER_MAX_SECONDS로 바꿉니다.
# =============================================================================
set -euo pipefail

# cron의 PATH는 /usr/bin:/bin뿐입니다 — needrestart는 /usr/sbin, AWS CLI는 /usr/local/bin(뒤에 덧붙여 앞선 PATH가 먼저).
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # env_file_value · BACKUP_DIR, 저장소 최상위로 이동
# shellcheck source=scripts/vultr/notify-common.sh
source scripts/vultr/notify-common.sh                      # notify_telegram
# shellcheck source=scripts/vultr/realtrade-guard.sh
source scripts/vultr/realtrade-guard.sh                    # realtrade_guard — deploy.sh와 같은 판정
export COMPOSE_FILE=docker-compose.yml:compose.vultr.yml
# 실제 매매 가드의 우회 값은 이 스크립트(와 여기서 부르는 deploy.sh)에서 받지 않습니다(ADR 0053 — cron에 넣지 않음).
unset REALTRADE_DEPLOY_OK DEPLOY_LOCK_HELD DEPLOY_REEXEC OS_PKG_REFRESH
# git status가 색인(.git/index)을 고쳐 쓰지 않게 — 미리 보기는 아무것도 쓰지 않아야 합니다.
export GIT_OPTIONAL_LOCKS=0

tag=my-macro-maintenance
mode=run
case "${1:-}" in
    '') ;;
    --dry-run) mode=dry ;;
    --after-reboot) mode=after ;;
    *) echo "사용: bash scripts/vultr/maintenance.sh [--dry-run | --after-reboot]" >&2; exit 2 ;;
esac

DOCKER_PKGS=(docker-ce docker-ce-cli docker-ce-rootless-extras docker-compose-plugin containerd.io docker-buildx-plugin)
GIT_PKGS=(git git-man)
APP_SERVICES=(backend collector frontend browser caddy)   # 복구 때 다시 시작(컨테이너는 시작할 때의 DNS 설정을 씀 — DEVELOPMENT §7)
marker="$BACKUP_DIR/.maintenance-reboot"
unsent="$BACKUP_DIR/.maintenance-unsent"
reboot_flag="${REBOOT_REQUIRED_FILE:-/var/run/reboot-required}"
resolv="${RESOLV_CONF:-/etc/resolv.conf}"

report=()          # 보고의 단계 줄(✓·✗·건너뜀 — 버전 없음)
pending_after=""   # 끝난 뒤 남은 보류 이름
log_file=""

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
syslog() { [ "$mode" = dry ] || logger -t "$tag" -p "user.${2:-info}" "$1" || true; }
step() { report+=("$1"); log "$1"; syslog "$1"; }

# 공백으로 나눈 이름 목록을 쉼표로(최대 12개 + 건수).
join_names() {
    local -a names
    read -r -a names <<< "$*"
    local n=${#names[@]} shown
    [ "$n" -gt 0 ] || { printf '없음'; return; }
    shown="$(printf '%s, ' "${names[@]:0:12}")"
    shown="${shown%, }"
    [ "$n" -le 12 ] || shown+=" 외 $((n - 12))개"
    printf '%s' "$shown"
}

# ---------------------------------------------------------------- 보고(텔레그램 한 통 + syslog)
# $1 = ok | failed | skipped, $2 = 제목 끝(예 "3 이미지에서 멈춤"), $3… = 할 일 줄
finish() {
    local result="$1" headline="$2"
    shift 2
    local text prefix="" rc=0
    case "$result" in
        ok) text="my-macro 서버 — 주간 유지보수 ✓ $headline" ;;
        failed) text="my-macro 서버 — 주간 유지보수 ✗ $headline" ;;
        *) text="my-macro 서버 — 주간 유지보수 건너뜀: $headline" ;;
    esac
    if [ "${#report[@]}" -gt 0 ]; then
        text+=$'\n'"$(printf '%s\n' "${report[@]}")"
    fi
    [ -z "$pending_after" ] || text+=$'\n'"남은 보류(올리지 않음 — 배포판 보안 수정은 자동 업데이트): $pending_after"
    if [ "$#" -gt 0 ]; then
        text+=$'\n\n실행:'
        local i=1 line
        for line in "$@"; do
            text+=$'\n'"$i. $line"
            i=$((i + 1))
        done
        text+=$'\n'"직접 하기 어려우면 Claude Code에 \"주간 유지보수 확인해 줘\"라고 하면 됩니다."
    fi
    [ -z "$log_file" ] || text+=$'\n'"(자세한 출력: ${log_file#"$PROJECT_ROOT"/} · journalctl -t $tag)"
    if [ -s "$unsent" ]; then
        prefix="지난 주간 유지보수 보고를 보내지 못해 함께 보냅니다:"$'\n'"$(cat "$unsent")"$'\n\n'
    fi
    case "$result" in
        failed) syslog "끝: 실패 — $headline" err ;;
        skipped) syslog "끝: 건너뜀 — $headline" warning ;;
        *) syslog "끝: 성공" ;;
    esac
    log "보고:"
    printf '%s%s\n' "$prefix" "$text"
    notify_telegram "$prefix$text" || rc=$?
    case "$rc" in
        0) rm -f "$unsent" ;;
        2) syslog "텔레그램 값(.env의 TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID)이 없거나 쓸 수 없어 보고를 보내지 않았습니다" warning ;;
        *)
            # 이름 조회가 깨졌을 때 등 — 다음 실행과 매일의 reboot-check.sh가 다시 보냅니다(지난 미발송분은 이번 글에 이미 붙어 있음).
            (umask 077 && printf '%s%s\n' "$prefix" "$text" > "$unsent.tmp" && mv -f "$unsent.tmp" "$unsent") || true
            syslog "보고를 보내지 못해 $unsent에 남겼습니다(다음 실행·reboot-check.sh가 다시 보냄)" warning ;;
    esac
    case "$result" in failed) exit 1 ;; *) exit 0 ;; esac
}

fail_stop() {   # $1 = 단계 줄(✗ …), $2… = 할 일
    local line="$1"
    shift
    step "$line"
    finish failed "${line#✗ }에서 멈춤" "$@"
}

# ---------------------------------------------------------------- 판정 도우미(읽기만)
guard_ok() {   # 실제 매매 가드 — 걸리면 1. 출력은 로그로.
    local out rc=0
    out="$( (die() { echo "✗ $*" >&2; exit 1; }; realtrade_guard before-build) 2>&1)" || rc=$?
    [ -z "$out" ] || printf '%s\n' "$out"
    return "$rc"
}

upgradable_names() {   # apt list --upgradable의 이름만(마지막으로 받은 목록)
    (apt list --upgradable 2>/dev/null || true) | awk -F/ 'index($0, "/") > 0 { print $1 }' | sort -u
}

pick() {   # $1 = 보류 이름(줄마다), 나머지 = 고를 이름 — 겹치는 것만 공백으로
    local list="$1" name out=""
    shift
    for name in "$@"; do
        if printf '%s\n' "$list" | grep -qxF -- "$name"; then out+="$name "; fi
    done
    printf '%s' "${out% }"
}

reboot_reasons() {   # 재부팅이 필요한 까닭(없으면 빈 값) — 패키지·서비스 이름만
    local out=() nr ksta svcs
    if [ -e "$reboot_flag" ]; then
        local n
        n="$( (sort -u "$reboot_flag.pkgs" 2>/dev/null || true) | sed '/^$/d' | wc -l | tr -d ' ')"
        if [ "$n" -gt 0 ]; then out+=("재부팅 표시(패키지 ${n}개)"); else out+=("재부팅 표시"); fi
    fi
    if command -v needrestart >/dev/null 2>&1 && nr="$(sudo -n needrestart -b -r l 2>/dev/null)"; then
        ksta="$(printf '%s\n' "$nr" | sed -n 's/^NEEDRESTART-KSTA: *//p' | head -n 1)"
        case "$ksta" in 2 | 3) out+=("새 커널 대기") ;; esac
        svcs="$(printf '%s\n' "$nr" | sed -n 's/^NEEDRESTART-SVC: *//p' | sed 's/\.service$//' | sort -u | tr '\n' ' ')"
        [ -z "${svcs// /}" ] || out+=("재시작이 필요한 서비스: $(join_names "$svcs")")
    else
        log "참고: needrestart를 읽지 못했습니다(재부팅 표시 파일만 봄)."
    fi
    [ "${#out[@]}" -eq 0 ] || printf '%s; ' "${out[@]}" | sed 's/; $//'
}

ts_failures() {   # Tailscale 확인 넷 — 어긋난 것을 '; '로(모두 맞으면 빈 값)
    local bad=()
    systemctl is-active --quiet tailscaled 2>/dev/null || bad+=("tailscaled가 돌지 않음")
    (sudo -n tailscale status --json 2>/dev/null || true) | grep -q '"BackendState": *"Running"' ||
        bad+=("tailnet 연결이 Running이 아님")
    (sudo -n tailscale serve status --json 2>/dev/null || true) | grep -q '"Proxy": *"http://127\.0\.0\.1:8201"' ||
        bad+=("tailscale serve의 화면 프록시(127.0.0.1:8201) 줄이 없음")
    if grep -q '^nameserver 100\.100\.100\.100' "$resolv" 2>/dev/null; then
        bad+=("/etc/resolv.conf가 Tailscale 리졸버를 가리킴")
    fi
    getent hosts api.telegram.org >/dev/null 2>&1 || bad+=("이름 조회 실패(api.telegram.org)")
    [ "${#bad[@]}" -eq 0 ] || printf '%s; ' "${bad[@]}" | sed 's/; $//'
}

ts_check_wait() {   # $1 = 시도 수(10초 간격) — 끝내 어긋나면 그 목록을 찍고 1
    local tries="$1" i out=""
    for ((i = 1; i <= tries; i++)); do
        out="$(ts_failures)"
        [ -n "$out" ] || return 0
        [ "$i" = "$tries" ] || sleep 10
    done
    printf '%s' "$out"
    return 1
}

recover_tailscale() {   # 문서의 복구 한 번(DEVELOPMENT §7 '재부팅 뒤 확인') — 결과는 로그로
    log "복구: sudo bash scripts/vultr/tailscale-up.sh(이미 tailnet에 있으면 키를 읽지 않음) + 앱 컨테이너 재시작"
    sudo -n bash scripts/vultr/tailscale-up.sh </dev/null || log "경고: tailscale-up.sh가 0이 아닌 값으로 끝났습니다."
    docker compose restart "${APP_SERVICES[@]}" || log "경고: 앱 컨테이너 재시작이 실패했습니다."
}

containers_bad() {   # 동작하지 않거나 건강하지 않은 서비스(없으면 빈 값)
    local services ps svc line state health bad=()
    services="$(docker compose config --services 2>/dev/null)" || { printf '서비스 목록을 읽지 못함'; return; }
    ps="$(docker compose ps --all --format '{{.Service}}\t{{.State}}\t{{.Health}}' 2>/dev/null)" || ps=""
    for svc in $services; do
        line="$(printf '%s\n' "$ps" | awk -F'\t' -v s="$svc" '$1 == s { print; exit }')"
        state="$(printf '%s' "$line" | cut -f2)"
        health="$(printf '%s' "$line" | cut -f3)"
        if [ "$state" != running ] || { [ -n "$health" ] && [ "$health" != healthy ]; }; then
            bad+=("$svc(${state:-없음}${health:+·$health})")
        fi
    done
    [ "${#bad[@]}" -eq 0 ] || printf '%s ' "${bad[@]}" | sed 's/ $//'
}

# ---------------------------------------------------------------- 6·7단계(재부팅 없이 이어서, 또는 재부팅 뒤)
# $1 = 기준 시각(유닉스 초 — 재부팅이면 부팅 시각, 아니면 기동이 끝난 시각): ERROR 줄은 그 뒤 5분만 셉니다.
final_checks_and_report() {
    local since="$1" recovered="$2" problems=() out bad i health schema rc_line errors until_s

    # Tailscale 넷(이름 조회 포함). 재부팅 뒤에는 연결이 늦게 붙을 수 있어 2분까지 기다립니다.
    if ! out="$(ts_check_wait 12)"; then
        if [ -z "$recovered" ]; then
            log "Tailscale·이름 조회가 어긋남: $out"
            recover_tailscale
            recovered=1
            out="$(ts_check_wait 6)" || problems+=("Tailscale·이름 조회: $out(복구 한 번 뒤에도)")
        else
            problems+=("Tailscale·이름 조회: $out")
        fi
    fi

    # 컨테이너 — 재부팅 뒤 docker가 띄우는 데 시간이 걸려 10분까지 기다립니다.
    bad=""
    for ((i = 1; i <= 40; i++)); do
        bad="$(containers_bad)"
        [ -n "$bad" ] || break
        [ "$i" = 40 ] || sleep 15
    done
    [ -z "$bad" ] || problems+=("컨테이너: $bad")

    docker compose exec -T backend wget -qO- http://localhost:8080/api/health >/dev/null 2>&1 ||
        problems+=("백엔드 /api/health 실패")
    schema="$(docker compose exec -T collector python -c "from app import store; print(store.schema_line())" 2>/dev/null)" || schema=""
    case "$schema" in
        스키마:*) ;;
        경고*) problems+=("스키마: DB가 이미지보다 앞섬(make doctor)") ;;
        *) problems+=("스키마 번호를 읽지 못함") ;;
    esac
    # 한 줄에는 커널 판이 들어 있어 보고에는 결과만 넣습니다(줄 자체는 로그로).
    rc_line="$(bash scripts/vultr/reboot-check.sh --summary 2>/dev/null)" || rc_line=""
    log "재부팅 점검: $rc_line"
    case "$rc_line" in
        경고:*) problems+=("재부팅 점검 경고(bash scripts/vultr/reboot-check.sh --summary)") ;;
        '') problems+=("재부팅 점검을 읽지 못함") ;;
    esac

    # 기동 뒤 5분의 ERROR 줄 수(참고) — 5분이 덜 지났으면 기다립니다(재부팅 중의 정상 종료 줄은 since 앞이라 빠짐).
    for ((i = 1; i <= 12; i++)); do
        [ "$(($(date +%s) - since))" -lt 300 ] || break
        sleep 30
    done
    until_s=$((since + 300))
    errors="$( (docker compose logs --no-color --since "$(date -u -d "@$since" +%Y-%m-%dT%H:%M:%SZ)" \
        --until "$(date -u -d "@$until_s" +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true) | grep -c -w 'ERROR' || true)"

    if [ "${#problems[@]}" -gt 0 ]; then
        step "✗ 6 확인: $(printf '%s; ' "${problems[@]}" | sed 's/; $//')"
        step "참고: 기동 뒤 5분의 ERROR 줄 ${errors:-0}개"
        bash scripts/vultr/inventory.sh || true
        pending_after="$(join_names "$(upgradable_names | tr '\n' ' ')")"
        finish failed "6 확인에서 어긋남" \
            "상태 보기 — 셸: ssh ubuntu@my-macro-app(안 되면 비상용 ssh -i ~/.ssh/id_ed25519_vultr ubuntu@<서버 IP>) 다음 cd ~/My_macro_dashboard_v2 && getent hosts api.telegram.org && docker compose ps && bash scripts/vultr/reboot-check.sh --summary" \
            "이름 조회·Tailscale이 어긋났으면 DEVELOPMENT §7 '재부팅 뒤 확인'(sudo bash scripts/vultr/tailscale-up.sh 뒤 docker compose restart backend collector frontend browser caddy)" \
            "컨테이너가 어긋났으면 docker compose logs <서비스> 뒤 bash scripts/vultr/deploy.sh --no-fetch"
    fi
    step "✓ 6 확인: Tailscale·이름 조회·컨테이너 모두 건강·백엔드·스키마·재부팅 점검${recovered:+(복구 한 번 씀)}"
    step "참고: 기동 뒤 5분의 ERROR 줄 ${errors:-0}개"
    if bash scripts/vultr/inventory.sh; then
        step "✓ 7 버전 목록 갱신(판은 /security 버전 목록)"
    else
        step "경고: 7 버전 목록을 넘기지 못함(journalctl -t my-macro-inventory)"
    fi
    pending_after="$(join_names "$(upgradable_names | tr '\n' ' ')")"
    finish ok "끝"
}

# ---------------------------------------------------------------- 0) 점검
[ "$(id -u)" != 0 ] || { echo "ubuntu 사용자로 실행하세요(root면 backups·빌드 파일의 소유자가 바뀝니다 — 손으로는 sudo systemd-run --uid=ubuntu …)." >&2; exit 2; }
case ":$(env_file_value COMPOSE_FILE):" in
    *:compose.vultr.yml:*) ;;
    *) echo "서버(.env의 COMPOSE_FILE에 compose.vultr.yml)가 아니라 아무것도 하지 않습니다." >&2; exit 2 ;;
esac

if [ "$mode" = after ]; then
    [ -f "$marker" ] || exit 0                         # 손으로 한 재부팅 등 — 이어 할 것이 없음
    m_epoch="$(sed -n 1p "$marker")"
    m_log="$(sed -n 2p "$marker")"
    mapfile -t report < <(sed -n '3,$p' "$marker")
    rm -f "$marker"                                    # 다시 부팅해도 되풀이하지 않게 먼저 지웁니다
    case "$m_epoch" in '' | *[!0-9]*) m_epoch=0 ;; esac
    if [ "$(($(date +%s) - m_epoch))" -gt "${MAINT_MARKER_MAX_SECONDS:-7200}" ]; then
        syslog "재부팅 뒤 이어 하기 표시가 오래돼(2시간 넘음) 무시했습니다" warning
        exit 0
    fi
    case "$m_log" in "$BACKUP_DIR"/maintenance/*.log) log_file="$m_log" ;; esac
fi

if [ "$mode" != dry ]; then
    umask 077
    mkdir -p "$BACKUP_DIR/maintenance"
    [ -n "$log_file" ] || log_file="$BACKUP_DIR/maintenance/$(date -u +%Y%m%d-%H%M%S).log"
    echo "출력: $log_file"
    exec >>"$log_file" 2>&1
    # 오래된 출력은 12개만 남깁니다.
    (ls -1t "$BACKUP_DIR"/maintenance/*.log 2>/dev/null || true) | tail -n +13 | while read -r old; do rm -f "$old"; done
fi

if [ "$mode" = after ]; then
    log "재부팅 뒤 이어 하기(--after-reboot)"
    syslog "재부팅 뒤 이어 하기 시작"
    exec 9>>"$BACKUP_DIR/.deploy.lock"
    flock -w 600 9 || log "경고: 잠금을 10분 안에 얻지 못해 잠금 없이 확인합니다."
    for ((i = 1; i <= 30; i++)); do
        docker info >/dev/null 2>&1 && break
        [ "$i" = 30 ] || sleep 10
    done
    boot_epoch="${MAINT_BOOT_EPOCH:-$(($(date +%s) - $(cut -d. -f1 /proc/uptime)))}"
    step "✓ 5 재부팅함"
    final_checks_and_report "$boot_epoch" ""
fi

# 실행·미리 보기 공통 점검. 미리 보기는 걸린 것도 모두 찍고 계속합니다.
checks=()     # 걸린 것(건너뛸 까닭)
notes=()      # 미리 보기에서 찍을 줄

if [ "$mode" = dry ]; then
    if [ -f "$BACKUP_DIR/.deploy.lock" ] && command -v flock >/dev/null 2>&1; then
        if (exec 9<"$BACKUP_DIR/.deploy.lock" && flock -n 9); then notes+=("✓ 잠금 비어 있음"); else checks+=("배포나 다른 유지보수가 돌고 있음(backups/.deploy.lock)"); fi
    else
        notes+=("✓ 잠금 비어 있음")
    fi
else
    exec 9>>"$BACKUP_DIR/.deploy.lock"
    flock -n 9 || checks+=("배포나 다른 유지보수가 돌고 있음(backups/.deploy.lock)")
fi
if [ -f "$BACKUP_DIR/.restore-check.lock" ] && ! (exec 8<"$BACKUP_DIR/.restore-check.lock" && flock -n 8); then
    checks+=("백업 복원 확인(restore-check.sh)이 돌고 있음")
fi
backup_re="$(printf '%s' "$PROJECT_ROOT/scripts/vultr/backup-s3.sh" | sed 's/[][\.*^$]/\\&/g')"
if pgrep -f -- "$backup_re" >/dev/null 2>&1; then
    checks+=("S3 백업(backup-s3.sh)이 돌고 있음")
fi

head_full="$(git rev-parse HEAD 2>/dev/null || true)"
head_short="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
deployed="$( (cut -d' ' -f3 "$BACKUP_DIR/.last-deploy-ok" 2>/dev/null || true) | head -n 1)"
if [ -z "$head_full" ] || [ "$deployed" != "$head_full" ]; then
    checks+=("서버 폴더의 판(main@$head_short)이 마지막으로 끝까지 배포한 판(${deployed:+main@${deployed:0:8}}${deployed:-기록 없음})과 다름 — 날짜를 정한 변경이 저절로 나가지 않게 다시 빌드하지 않음")
elif [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || [ "$(git symbolic-ref -q --short HEAD || true)" != main ]; then
    checks+=("서버 폴더에 고친 파일이 있거나 main이 아님(git status)")
else
    notes+=("✓ 서버 폴더의 판 main@$head_short = 마지막으로 끝까지 배포한 판")
fi
if sudo -n true >/dev/null 2>&1; then notes+=("✓ sudo -n"); else checks+=("sudo -n이 되지 않음(apt·재부팅에 필요)"); fi
if guard_out="$(guard_ok)"; then
    notes+=("✓ 실제 매매 가드 통과")
else
    checks+=("실제 매매 가드(한국 거래 창 — 꺼지지 않은 실제 매매가 있음)")
fi
[ -z "$guard_out" ] || log "$guard_out"

# ---------------------------------------------------------------- 미리 보기(--dry-run) — 여기서 끝
if [ "$mode" = dry ]; then
    upg="$(upgradable_names)"
    targets="$(pick "$upg" "${DOCKER_PKGS[@]}" "${GIT_PKGS[@]}")"
    ts_pending="$(pick "$upg" tailscale)"
    others=""
    for name in $upg; do
        case " ${DOCKER_PKGS[*]} ${GIT_PKGS[*]} tailscale " in *" $name "*) ;; *) others+="$name " ;; esac
    done
    echo "주간 유지보수 미리 보기(--dry-run — 아무것도 바꾸지 않음)"
    echo "0 점검:"
    for line in "${notes[@]}"; do echo "   $line"; done
    for line in "${checks[@]}"; do echo "   ✗ 건너뛸 까닭: $line"; done
    [ ! -s "$unsent" ] || echo "   참고: 지난 보고를 보내지 못한 기록이 있음(다음 보고에 붙여 보냄)"
    echo "1 S3 백업: bash scripts/vultr/backup-s3.sh"
    echo "2 패키지(apt 목록은 마지막으로 받은 것 — 미리 보기는 apt-get update를 하지 않음): Docker·Git 보류 $(join_names "$targets")"
    echo "3 이미지: deploy.sh --no-fetch(코드를 받지 않음, OS_PKG_REFRESH=$(date -u +%F))"
    if ts="$(ts_failures)" && [ -z "$ts" ]; then ts_now="확인 넷 ✓"; else ts_now="지금 어긋남: $ts"; fi
    echo "4 Tailscale: 보류 ${ts_pending:-없음} · $ts_now"
    rr="$(reboot_reasons)"
    echo "5 재부팅: ${rr:-지금 기준 필요 없음}(2·4단계 뒤에 다시 판정)"
    echo "남은 보류(올리지 않음): $(join_names "$others")"
    if [ "${#checks[@]}" -gt 0 ]; then echo "→ 지금 실행하면 건너뜁니다."; else echo "→ 지금 실행하면 위 순서로 돕니다."; fi
    exit 0
fi

if [ "${#checks[@]}" -gt 0 ]; then
    finish skipped "$(printf '%s; ' "${checks[@]}" | sed 's/; $//')" \
        "까닭을 고친 뒤(서버 폴더의 판이 다르면 bash scripts/vultr/deploy.sh로 배포를 끝까지) 다음 토요일을 기다리거나 손으로: sudo systemd-run --uid=ubuntu --gid=ubuntu --setenv=HOME=/home/ubuntu --unit=my-macro-maintenance-manual bash /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/maintenance.sh"
fi
syslog "시작: 서버 폴더의 판 main@$head_short"
step "✓ 0 점검: 잠금·판(main@$head_short)·sudo·실제 매매 가드"

# ---------------------------------------------------------------- 1) S3 백업
log "1 S3 백업"
bash scripts/vultr/backup-s3.sh ||
    fail_stop "✗ 1 S3 백업" "원인 보기 — 셸: journalctl -t my-macro-backup --since today" \
        "고친 뒤 다시: sudo systemd-run --uid=ubuntu --gid=ubuntu --setenv=HOME=/home/ubuntu --unit=my-macro-maintenance-manual bash /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/maintenance.sh"
step "✓ 1 S3 백업"

# ---------------------------------------------------------------- 2) Docker·Git 올림
log "2 apt-get update · Docker·Git 보류"
guard_ok || fail_stop "✗ 2 패키지: 실제 매매 가드에 걸림" "한국 거래 창이 지난 뒤 손으로 다시 실행(sudo systemd-run … maintenance.sh)"
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -q ||
    fail_stop "✗ 2 패키지: apt-get update 실패" "원인 보기 — 셸: cd ~/My_macro_dashboard_v2 && tail -n 50 ${log_file#"$PROJECT_ROOT"/}" "고친 뒤 손으로 다시 실행"
upg="$(upgradable_names)"
targets="$(pick "$upg" "${DOCKER_PKGS[@]}" "${GIT_PKGS[@]}")"
if [ -n "$targets" ]; then
    # 서비스 재시작은 needrestart에 맡기지 않습니다(목록만 — 재부팅을 이 스크립트가 정함). Docker를 올리면 dockerd가 다시 뜨며 컨테이너도 다시 섭니다.
    # shellcheck disable=SC2086  # 이름 목록은 나뉘어야 합니다
    sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -q --only-upgrade \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold $targets ||
        fail_stop "✗ 2 패키지: Docker·Git 올림 실패($(join_names "$targets"))" \
            "상태 보기 — 셸: cd ~/My_macro_dashboard_v2 && docker compose ps && tail -n 80 ${log_file#"$PROJECT_ROOT"/}" \
            "고친 뒤(sudo dpkg --configure -a 등) bash scripts/vultr/deploy.sh --no-fetch로 다시 띄우기"
    for ((i = 1; i <= 30; i++)); do
        docker info >/dev/null 2>&1 && break
        [ "$i" = 30 ] || sleep 2
    done
    n_targets="$(wc -w <<< "$targets" | tr -d ' ')"
    step "✓ 2 패키지: Docker·Git ${n_targets}개 올림($(join_names "$targets"))"
else
    step "✓ 2 패키지: 올릴 Docker·Git 없음"
fi

# ---------------------------------------------------------------- 3) 이미지 다시 빌드·기동(코드는 받지 않음)
log "3 deploy.sh --no-fetch"
refresh="$(date -u +%F)"
DEPLOY_LOCK_HELD=1 OS_PKG_REFRESH="$refresh" bash scripts/vultr/deploy.sh --no-fetch ||
    fail_stop "✗ 3 이미지: 다시 빌드·기동 실패(deploy.sh --no-fetch)" \
        "상태 보기 — 셸: cd ~/My_macro_dashboard_v2 && docker compose ps && tail -n 80 ${log_file#"$PROJECT_ROOT"/}" \
        "고친 뒤 bash scripts/vultr/deploy.sh --no-fetch(코드를 받지 않음)"
up_epoch="$(date +%s)"
step "✓ 3 이미지: 다시 빌드·기동(main@$head_short 그대로, OS 패키지 층 $refresh)"

# ---------------------------------------------------------------- 4) Tailscale(따로 — 다른 것을 다 올린 뒤, 재부팅 앞)
recovered=""
ts_did="올릴 것 없음"
if [ -n "$(pick "$(upgradable_names)" tailscale)" ]; then
    log "4 Tailscale 올림"
    guard_ok || fail_stop "✗ 4 Tailscale: 실제 매매 가드에 걸림" "한국 거래 창이 지난 뒤 손으로 다시 실행"
    sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -q --only-upgrade \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold tailscale ||
        log "경고: Tailscale 올림이 0이 아닌 값으로 끝났습니다 — 확인 넷으로 판정합니다."
    ts_did="올림"
fi
if ! ts_out="$(ts_check_wait 6)"; then
    log "Tailscale 확인이 어긋남: $ts_out"
    guard_ok || fail_stop "✗ 4 Tailscale: 어긋났고($ts_out) 실제 매매 가드에 걸려 복구하지 않음" "한국 거래 창이 지난 뒤 DEVELOPMENT §7 '재부팅 뒤 확인'대로 복구"
    recover_tailscale
    recovered=1
    ts_out="$(ts_check_wait 6)" ||
        fail_stop "✗ 4 Tailscale: $ts_did, 복구 한 번 뒤에도 어긋남($ts_out) — 재부팅하지 않음" \
            "비상용 셸: ssh -i ~/.ssh/id_ed25519_vultr ubuntu@<서버 IP>(22는 PC IP만 — 바뀌었으면 PC에서 bash scripts/vultr/firewall-pc-ip.sh)" \
            "확인: sudo tailscale status && sudo tailscale serve status && getent hosts api.telegram.org && cat /etc/resolv.conf" \
            "DEVELOPMENT §7 '재부팅 뒤 확인'과 ADR 0023 개정 2026-11-12(QA-415)를 따라 손으로 고침"
fi
step "✓ 4 Tailscale: ${ts_did}, 확인 넷 통과${recovered:+(복구 한 번 씀)}"

# ---------------------------------------------------------------- 5) 재부팅(필요할 때만)
reasons="$(reboot_reasons)"
if [ -n "$reasons" ]; then
    guard_ok || fail_stop "✗ 5 재부팅: 필요($reasons)하지만 실제 매매 가드에 걸려 하지 않음" "한국 거래 창이 지난 뒤 sudo reboot 하고 DEVELOPMENT §7 '재부팅 뒤 확인'"
    step "✓ 5 재부팅 필요: $reasons"
    { printf '%s\n%s\n' "$(date +%s)" "$log_file"; printf '%s\n' "${report[@]}"; } > "$marker.tmp" && mv -f "$marker.tmp" "$marker" ||
        fail_stop "✗ 5 재부팅: 이어 하기 표시를 남기지 못해 하지 않음" "df -h 확인 뒤 sudo reboot 하고 DEVELOPMENT §7 '재부팅 뒤 확인'"
    syslog "재부팅합니다(재부팅 뒤 @reboot cron이 --after-reboot로 이어 함)"
    log "재부팅합니다."
    if ! sudo -n systemctl reboot; then
        rm -f "$marker"
        fail_stop "✗ 5 재부팅 명령 실패" "셸: sudo reboot 하고 DEVELOPMENT §7 '재부팅 뒤 확인'"
    fi
    exit 0
fi
step "✓ 5 재부팅: 필요 없음"
final_checks_and_report "$up_epoch" "$recovered"
