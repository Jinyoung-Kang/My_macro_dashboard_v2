#!/usr/bin/env bash
# =============================================================================
# scripts/aws/backup-s3.sh — AWS 개인용 서버의 DB를 백업해 S3에 올립니다(ADR 0019).
#
# cron(서버의 ubuntu 사용자, 서버 시간대는 UTC) — 매일 21:10 UTC = 06:10 KST:
#   10 21 * * * /home/ubuntu/My_macro_dashboard_v2/scripts/aws/backup-s3.sh
# 결과는 syslog(태그 my-macro-backup):  journalctl -t my-macro-backup
#
# make backup(backups/에 접두어별 최근 BACKUP_KEEP개 보존, ADR 0003)이 만든 파일 하나만 s3://<AWS_BACKUP_BUCKET>/db/에
# 올립니다. 60일 지난 객체는 버킷의 수명주기가 지웁니다. 실패하면 syslog에 err로 남기고 0이 아닌 값으로 끝납니다.
# 버킷 이름은 .env의 AWS_BACKUP_BUCKET(환경변수가 먼저). 서버의 IAM 역할이 이 버킷 하나에만 쓸 수 있습니다.
# =============================================================================
set -euo pipefail

# cron의 PATH는 /usr/bin:/bin뿐입니다 — AWS CLI v2는 /usr/local/bin에 깔립니다(뒤에 덧붙여 앞선 PATH가 먼저).
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin"
export COMPOSE_FILE=docker-compose.yml:compose.aws.yml
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # DB_NAME · BACKUP_DIR · env_file_value, 저장소 최상위로 이동

tag=my-macro-backup
fail() {
    logger -t "$tag" -p user.err "백업 실패: $*" || true
    echo "❌ 백업 실패: $*" >&2
    exit 1
}

bucket="${AWS_BACKUP_BUCKET:-$(env_file_value AWS_BACKUP_BUCKET)}"
[ -n "$bucket" ] || fail "AWS_BACKUP_BUCKET이 .env에 없습니다"

# make backup이 남기는 이름(<DB 이름>-YYYYmmdd-HHMMSS.sql)의 목록.
list_backups() {
    ls "$BACKUP_DIR/$DB_NAME"-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].sql 2>/dev/null | sort
}

# 이번 실행이 만든 파일만 올립니다 — 실행 전 목록에 없던 파일 하나. 이름 순서로 고르지 않는 것은, 이름이 그 기계의 현지 시각이라
# 맥(KST)에서 옮겨 온 백업이 서버(UTC)가 방금 만든 것보다 뒤에 정렬될 수 있어서입니다.
before="$(list_backups)" || true
if ! output="$(make --no-print-directory backup 2>&1)"; then
    # 전체 출력은 소유자만 읽는 파일로. syslog에는 원인 줄 하나만 — compose의 .env 해석 오류는 값을 찍을 수 있어 빼고 적습니다.
    (umask 077 && printf '%s\n' "$output" > "$BACKUP_DIR/backup-s3-last-error.log") || true
    # compose 경고(level=warning … "X" variable is not set)는 .env 값의 조각을 담을 수 있어 원인 후보에서 뺍니다.
    reason="$(printf '%s\n' "$output" | grep -v -e '^make: \*\*\*' -e '^❌' -e 'level=warning' -e '^WARN' | tail -n 1)" || true
    case "$reason" in *.env*|*"failed to read"*|*"variable is not set"*) reason="(.env 해석 오류 — 값 생략)" ;; esac
    fail "make backup — ${reason:-원인 모름} (전체 출력: backups/backup-s3-last-error.log)"
fi
latest="$( (comm -13 <(printf '%s\n' "$before") <(list_backups) || true) | sed '/^$/d')"
[ -n "$latest" ] || fail "make backup이 새 파일을 남기지 않았습니다($BACKUP_DIR)"
[ "$(printf '%s\n' "$latest" | wc -l | tr -d ' ')" = 1 ] || fail "새 백업 파일이 하나가 아닙니다 — 올리지 않았습니다"

key="db/$(basename "$latest")"
if ! upload="$(aws s3 cp --only-show-errors "$latest" "s3://$bucket/$key" 2>&1)"; then
    fail "S3 올리기(s3://$bucket/$key) — $(printf '%s\n' "$upload" | tail -n 2 | tr '\n' ' ')"
fi
size="$(du -h "$latest" | cut -f1)"
logger -t "$tag" "백업을 올렸습니다: s3://$bucket/$key ($size)" || true
echo "✅ s3://$bucket/$key ($size)"
