#!/usr/bin/env bash
# =============================================================================
# scripts/aws/instance.sh — PC에서 AWS 개인용 서버(EC2 my-macro-app)를 손으로 켜고 끄고, 지금 켜져 있는지 봅니다(ADR 0019).
#
#   bash scripts/aws/instance.sh status         지금 상태 한 줄(running · stopped …)
#   bash scripts/aws/instance.sh start          켜고 running이 될 때까지 기다림 — 다음 정지 일정(매일 07:00, 평일 15:50, 일 23:30 KST)에 꺼집니다
#   bash scripts/aws/instance.sh stop [--force] 끔. 정기 가동 시간(아래 세 창)에는 모의 매매 리스크 점검·결정·복기·백업이 빠지므로
#                                               --force 없이는 끄지 않습니다
#
# 정기 가동 시간(ADR 0019 결정 14 — 2026-11-02): 평일 밤 뉴욕 09:20(미국 개장 10분 전 — 겨울 23:20·서머타임 22:20 KST) ~ 07:00 KST,
# 평일 낮 08:55~15:50 KST, 일요일 밤 20:50~23:30 KST(주간 복기). 정기 켜기·끄기는 EventBridge Scheduler(my-macro-start ·
# my-macro-stop · my-macro-day-start · my-macro-day-stop · my-macro-sun-start · my-macro-sun-stop)가 합니다. 이 스크립트는 토요일처럼
# 가동 시간 밖에 화면을 볼 때용입니다. 필요한 것: aws CLI v2, `aws login`, .env의 AWS_INSTANCE_ID(환경변수가 먼저).
# 리전은 AWS_REGION(기본 ap-northeast-2).
# =============================================================================
set -euo pipefail

# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # env_file_value(.env 한 줄 읽기), 저장소 최상위로 이동

REGION="${AWS_REGION:-ap-northeast-2}"
WINDOW="평일 밤 뉴욕 09:20(겨울 23:20·서머타임 22:20 KST)~07:00, 평일 낮 08:55~15:50, 일요일 20:50~23:30 KST"

die() {
    echo "✗ $*" >&2
    exit 1
}

action="${1:-}"
case "$action" in
    status|start|stop) ;;
    *) die "사용법: bash scripts/aws/instance.sh status|start|stop [--force]" ;;
esac
instance="${AWS_INSTANCE_ID:-$(env_file_value AWS_INSTANCE_ID)}"
[ -n "$instance" ] || die ".env에 AWS_INSTANCE_ID(서버 인스턴스 ID, i-로 시작)가 없습니다."
[[ "$instance" =~ ^i-[0-9a-f]{8,17}$ ]] || die "AWS_INSTANCE_ID가 인스턴스 ID 모양(i-0123…)이 아닙니다."
command -v aws >/dev/null || die "aws CLI가 없습니다(v2 필요)."

state() {
    aws ec2 describe-instances --region "$REGION" --instance-ids "$instance" \
        --query 'Reservations[0].Instances[0].State.Name' --output text
}

# 지금이 정기 가동 시간 안인지(위 세 창). 요일은 1=월 … 6=토 … 7=일. 밤 창은 뉴욕 평일 09:20 뒤이면서 KST로 아직 07:00 전
# (켜진 KST 날 22:00 뒤이거나 다음 날 07:00 전) — 시작이 뉴욕 시각이라 서머타임 전환을 따릅니다.
in_window() {
    local kst ny kst_day kst_hm ny_day ny_hm
    kst="$(TZ=Asia/Seoul date +%u%H%M)"
    ny="$(TZ=America/New_York date +%u%H%M)"
    kst_day="${kst:0:1}"
    kst_hm=$((10#${kst:1}))
    ny_day="${ny:0:1}"
    ny_hm=$((10#${ny:1}))
    if [ "$ny_day" -le 5 ] && [ "$ny_hm" -ge 920 ] && { [ "$kst_hm" -ge 2200 ] || [ "$kst_hm" -lt 700 ]; }; then
        return 0
    fi
    if [ "$kst_day" -le 5 ] && [ "$kst_hm" -ge 855 ] && [ "$kst_hm" -lt 1550 ]; then
        return 0
    fi
    [ "$kst_day" = 7 ] && [ "$kst_hm" -ge 2050 ] && [ "$kst_hm" -lt 2330 ]
}

current="$(state 2>/dev/null)" || die "서버 상태를 읽지 못했습니다 — AWS 로그인(aws login)과 AWS_INSTANCE_ID를 확인하세요."

case "$action" in
    status)
        case "$current" in
            running) echo "서버($instance): running — 켜져 있습니다. 화면: bash scripts/aws/tunnel.sh" ;;
            stopped) echo "서버($instance): stopped — 꺼져 있습니다. 정기 가동은 $WINDOW, 지금 보려면 bash scripts/aws/instance.sh start" ;;
            *) echo "서버($instance): $current" ;;
        esac
        ;;
    start)
        case "$current" in
            running) echo "이미 켜져 있습니다(running)."; exit 0 ;;
            stopping) die "꺼지는 중입니다(stopping) — 잠시 뒤 다시 실행하세요." ;;
        esac
        aws ec2 start-instances --region "$REGION" --instance-ids "$instance" >/dev/null
        echo "켜는 중입니다…"
        aws ec2 wait instance-running --region "$REGION" --instance-ids "$instance"
        echo "✓ 켜졌습니다. 컨테이너가 뜨는 데 1~2분 걸립니다 — 그다음 bash scripts/aws/tunnel.sh"
        echo "   다음 정지 일정(매일 07:00, 평일 15:50, 일 23:30 KST)에 꺼집니다. 그 전에 끄려면 bash scripts/aws/instance.sh stop"
        ;;
    stop)
        case "$current" in
            stopped) echo "이미 꺼져 있습니다(stopped)."; exit 0 ;;
        esac
        if [ "${2:-}" != "--force" ] && in_window; then
            die "지금은 정기 가동 시간($WINDOW)입니다 — 끄면 모의 매매 리스크 점검·결정·백업이 빠집니다. 꼭 끄려면 --force를 붙이세요."
        fi
        aws ec2 stop-instances --region "$REGION" --instance-ids "$instance" >/dev/null
        echo "끄는 중입니다…"
        aws ec2 wait instance-stopped --region "$REGION" --instance-ids "$instance"
        echo "✓ 꺼졌습니다. 다음 켜기 일정은 평일 08:55·뉴욕 09:20(겨울 23:20·서머타임 22:20 KST), 일요일 20:50 KST입니다."
        ;;
esac
