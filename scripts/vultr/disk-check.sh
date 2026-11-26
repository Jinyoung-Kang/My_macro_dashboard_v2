#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/disk-check.sh — Vultr 서버의 디스크(/)와 inode 사용률을 보고, 임계를 넘으면 운영 텔레그램 봇으로 알립니다(ADR 0023 덧붙임 2026-11-27).
#
# 서버 디스크는 Docker 빌드 캐시와 backups/의 덤프로 찹니다(2026-11-27에 120 GB 가운데 77%, 빌드 캐시 61 GB — docs/improve/2026-11-27-quality-plan.md §4).
# 배포 끝 요약의 한 줄 말고는 문턱도 알림도 없어, 꽉 차면 postgres가 쓰지 못하고 배포 전 덤프가 실패한 뒤에야 알게 됩니다.
#   · df -P / 의 사용률과 df -Pi / 의 inode 사용률 가운데 하나라도 80% 이상이면 '경고', 90% 이상이면 '위험'
#     (DISK_WARN_PCT·DISK_CRIT_PCT — 환경변수 → .env → 기본 80·90, 1~100의 정수이고 경고 ≤ 위험이 아니면 기본값)
#   · inode를 읽지 못하거나 사용률을 내지 않는 파일 시스템이면 inode는 '모름'으로 두고 디스크만 봅니다. 디스크를 읽지 못하면 알리지 않고 syslog에만 남깁니다.
#
# 사용(저장소 최상위로 옮겨 .env·backups/를 봄):
#   bash scripts/vultr/disk-check.sh                       임계를 넘으면 운영 봇으로 한 통(사용률·여유·docker system df의 종류별 크기·backups/ 크기 +
#                                                          할 일 '실행:'), 같은 KST 날짜에는 한 번만(경고로 보낸 날 위험으로 오르면 한 번 더). 늘 0으로 끝남
#   bash scripts/vultr/disk-check.sh --summary             한 줄만 찍음(deploy.sh 끝 요약 — 알리지 않음, docker도 부르지 않음)
#   bash scripts/vultr/disk-check.sh --summary-if-server   서버(.env의 COMPOSE_FILE에 compose.vultr.yml)일 때만 한 줄(make status — PC의 디스크는 보지 않음)
#
# cron 줄은 따로 없습니다 — 매일 16:10 KST에 도는 reboot-check.sh의 cron 길이 먼저 이것을 부릅니다(그 cron이 빠지면 함께 빠짐 —
# 그때도 make status와 deploy.sh 끝 요약의 한 줄은 남음).
# 결과는 syslog(태그 my-macro-disk-check):  journalctl -t my-macro-disk-check
# 텔레그램은 scripts/vultr/notify-common.sh(운영 봇 TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID — 토큰·채팅 ID는 curl 설정(stdin)으로).
# 알림에는 서버 디스크 숫자만 넣습니다(DB 내용·계좌 자료 없음). 이 스크립트는 아무것도 지우지 않습니다.
# =============================================================================
set -euo pipefail

# cron의 PATH는 /usr/bin:/bin뿐입니다(뒤에 덧붙여 앞선 PATH가 먼저).
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin"
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # env_file_value · BACKUP_DIR, 저장소 최상위로 이동
# shellcheck source=scripts/vultr/notify-common.sh
source "$DB_SCRIPTS_DIR/vultr/notify-common.sh"           # notify_telegram

tag=my-macro-disk-check
mode="${1:-}"
case "$mode" in
    '' | --summary) ;;
    --summary-if-server)
        case ":$(env_file_value COMPOSE_FILE):" in *:compose.vultr.yml:*) ;; *) exit 0 ;; esac ;;
    *) echo "사용: bash scripts/vultr/disk-check.sh [--summary | --summary-if-server]" >&2; exit 2 ;;
esac

# 임계 — 1~100의 정수가 아니거나 경고 > 위험이면 기본값(잘못 적은 값으로 알림이 꺼지지 않게).
pct_or() {
    case "$1" in
        '' | *[!0-9]* | ????*) echo "$2" ;;
        *) if [ "$((10#$1))" -ge 1 ] && [ "$((10#$1))" -le 100 ]; then echo "$((10#$1))"; else echo "$2"; fi ;;
    esac
}
warn_pct="$(pct_or "${DISK_WARN_PCT:-$(env_file_value DISK_WARN_PCT)}" 80)"
crit_pct="$(pct_or "${DISK_CRIT_PCT:-$(env_file_value DISK_CRIT_PCT)}" 90)"
if [ "$warn_pct" -gt "$crit_pct" ]; then
    warn_pct=80
    crit_pct=90
fi

# df -P는 파일 시스템 이름이 길어도 한 줄입니다. "<사용률> <넷째 칸>"(디스크는 남은 KB, inode는 남은 수) — 사용률이 숫자가 아니면 아무것도 내지 않습니다.
df_row() {
    df "$1" / 2>/dev/null | awk 'NR == 2 { p = $5; sub(/%$/, "", p); if (p ~ /^[0-9]+$/) print p, $4 }'
}
disk_row="$(df_row -P)" || disk_row=""
inode_row="$(df_row -Pi)" || inode_row=""
disk_pct="${disk_row%% *}"
inode_pct="${inode_row%% *}"

if [ -z "$disk_pct" ]; then
    summary="경고: 디스크 사용률을 읽지 못했습니다(df -P /)"
    if [ "$mode" != "" ]; then
        echo "$summary"
    else
        logger -t "$tag" -p user.warning "점검: $summary" || true
    fi
    exit 0
fi

avail_kb="${disk_row#* }"
case "$avail_kb" in '' | *[!0-9]*) avail="모름" ;; *) avail="$(awk -v k="$avail_kb" 'BEGIN { printf "%.1fGB", k / 1048576 }')" ;; esac
if [ -n "$inode_pct" ]; then inode_text="${inode_pct}%"; else inode_text="모름"; fi
usage="${disk_pct}% 사용(여유 $avail) · inode $inode_text"

# 등급 — 0 정상 · 1 경고 · 2 위험. 넘은 쪽(디스크·inode)을 사유에 적습니다.
level=0
over=()
grade() {
    local name="$1" pct="$2"
    [ -n "$pct" ] || return 0
    if [ "$pct" -ge "$crit_pct" ]; then
        level=2
        over+=("$name ${crit_pct}% 이상")
    elif [ "$pct" -ge "$warn_pct" ]; then
        [ "$level" -ge 1 ] || level=1
        over+=("$name ${warn_pct}% 이상")
    fi
}
grade 디스크 "$disk_pct"
grade inode "$inode_pct"

case "$level" in
    0) summary="디스크: $usage" ;;
    *)
        if [ "$level" = 2 ]; then word=위험; else word=경고; fi
        reason="$(printf '%s · ' "${over[@]}")"
        summary="경고: 디스크 $usage — $word(${reason% · }), DEVELOPMENT §7 '디스크'" ;;
esac

if [ "$mode" != "" ]; then
    echo "$summary"
    exit 0
fi

# 알림 길 — 임계 아래면 syslog에만 남깁니다.
if [ "$level" = 0 ]; then
    logger -t "$tag" "점검: $summary" || true
    exit 0
fi
logger -t "$tag" -p user.warning "점검: $summary" || true

# 같은 KST 날짜에는 한 번만(손으로 다시 돌리거나 사용률이 1% 움직여도 겹쳐 보내지 않음). 기록은 "<날짜> <등급>" — 경고로 보낸 날 위험으로
# 오르면 한 번 더 보내고, 위험에서 경고로 내려온 것은 다시 보내지 않습니다. 보낸 뒤에만 남깁니다.
sent="$BACKUP_DIR/.disk-check-sent"
today="$(TZ=Asia/Seoul date +%F)"
last="$(head -n 1 "$sent" 2>/dev/null || true)"
last_level="${last#* }"
case "$last_level" in 1 | 2) ;; *) last_level=0 ;; esac
if [ "${last%% *}" = "$today" ] && [ "$last_level" -ge "$level" ]; then
    logger -t "$tag" "오늘 같은 등급의 알림을 이미 보냄 — 건너뜀" || true
    exit 0
fi

# 무엇이 자리를 쓰는지 — Docker의 종류별 크기(이미지·컨테이너·볼륨·빌드 캐시)와 backups/. 캐시가 수십 GB면 docker system df가 오래 걸릴 수 있어
# 60초에서 끊고, 읽지 못하면 그렇게 적습니다(알림은 그대로 보냄).
docker_df() {
    if command -v timeout >/dev/null 2>&1; then
        timeout 60 docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'
    else
        docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'
    fi
}
docker_lines="$( (docker_df 2>/dev/null || true) | awk -F '\t' 'NF >= 2 && NR <= 6 { printf "\n  %s %s", $1, $2; if ($3 != "") printf "(회수 가능 %s)", $3 }')" || docker_lines=""
[ -n "$docker_lines" ] || docker_lines=$'\n  읽지 못함'
backups_size="$( (du -sh "$BACKUP_DIR" 2>/dev/null || true) | cut -f1)" || backups_size=""

text="my-macro 서버 — 디스크 $word: $usage (${reason% · } — 임계 경고 ${warn_pct}% · 위험 ${crit_pct}%)"
text+=$'\n\nDocker(docker system df):'"$docker_lines"
text+=$'\n'"backups/: ${backups_size:-읽지 못함}"
text+=$'\n\n실행:'
text+=$'\n1. 보기 — 셸: ssh ubuntu@my-macro-app 다음'
text+=$'\n   cd ~/My_macro_dashboard_v2 && bash scripts/vultr/disk-check.sh --summary && docker system df'
text+=$'\n2. 빌드 캐시(Build Cache)가 크면 배포가 돌지 않을 때(평일 16:00~22:00 KST나 주말 낮):'
text+=$'\n   docker builder prune -f --max-used-space 15GB'
text+=$'\n볼륨·쓰는 이미지·backups/는 지우지 않습니다(docker system prune류 금지).'
text+=$'\n직접 하기 어려우면 Claude Code에 "디스크 확인해 줘"라고 하면 됩니다.'

rc=0
notify_telegram "$text" || rc=$?
case "$rc" in
    0) { mkdir -p "$BACKUP_DIR" && printf '%s %s\n' "$today" "$level" > "$sent"; } ||
           logger -t "$tag" -p user.warning "보낸 기록을 남기지 못함" || true ;;
    2) logger -t "$tag" -p user.warning "텔레그램 값이 없어 알리지 않음" || true ;;
    *) logger -t "$tag" -p user.warning "텔레그램 알림을 보내지 못함 — 다음 실행에 다시" || true ;;
esac
exit 0
