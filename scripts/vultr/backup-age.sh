#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/backup-age.sh — 서버 밖 사본(S3 db/vultr/)을 마지막으로 올린 뒤 몇 시간이 지났는지 한 줄로 찍습니다(QA-199).
# deploy.sh 끝 요약과 make status가 같이 불러, 36시간 판정과 문구가 한 곳에만 있게 합니다.
#
# 기록은 backup-s3.sh가 성공할 때 남기는 backups/.last-s3-ok(유닉스 초 · UTC 시각 · 올린 키)입니다. cron은 매일 08:00 KST라
# 36시간이 넘으면 한 번 이상 놓친 것입니다. 실패는 텔레그램으로도 오지만 cron이 빠지면(crontab 유실·서버 재구성) 아무 신호가 없어
# 이 줄로 봅니다.
#
# 사용(저장소 최상위로 옮겨 backups/를 봄 — BACKUP_DIR가 있으면 그 폴더):
#   bash scripts/vultr/backup-age.sh               기록이 없거나 읽지 못해도 경고(deploy.sh — 서버에서만 돎)
#   bash scripts/vultr/backup-age.sh --if-present  기록 파일이 없으면 아무것도 찍지 않음(make status — PC에는 S3 cron이 없어
#                                                  파일이 늘 없음. 서버를 다시 만든 직후의 '없음'은 deploy.sh가 잡음)
# 알리기만 하고 0으로 끝납니다(배포·상태 확인을 막지 않음).
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

record="${BACKUP_DIR:-backups}/.last-s3-ok"
case "${1:-}" in
    '') ;;
    --if-present) [ -e "$record" ] || exit 0 ;;
    *) echo "사용: bash scripts/vultr/backup-age.sh [--if-present]" >&2; exit 2 ;;
esac

last_s3="$(head -n 1 "$record" 2>/dev/null | cut -d' ' -f1)" || true
case "$last_s3" in
    '' | *[!0-9]*)
        echo "경고: 마지막 S3 백업 기록(backups/.last-s3-ok)이 없습니다 — crontab -l과 journalctl -t my-macro-backup을 보세요(처음이면 bash scripts/vultr/backup-s3.sh를 한 번 돌리면 생김)." ;;
    *)
        age_h=$(( ($(date +%s) - 10#$last_s3) / 3600 ))
        if [ "$age_h" -ge 36 ]; then
            echo "경고: 마지막 S3 백업이 ${age_h}시간 전입니다(36시간 넘음) — journalctl -t my-macro-backup을 보세요."
        else
            echo "마지막 S3 백업: ${age_h}시간 전"
        fi ;;
esac
