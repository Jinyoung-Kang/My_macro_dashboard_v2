#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/backup-s3.sh — Vultr 서버의 DB를 백업해 S3에 올립니다(ADR 0023). scripts/aws/backup-s3.sh에서 갈라냈습니다.
#
# cron(서버의 ubuntu 사용자, 서버 시간대는 UTC): 매일 23:00 UTC = 08:00 KST(미국 결정 뒤 — 겨울(EST)에는 결정이 07시대까지 밀릴 수 있어
# 2026-11-08에 06:45에서 옮김, 한국 첫 주문 앞)와 일요일 14:00 UTC = 23:00 KST(주간 복기 뒤). 서버는 24시간 켜져 있습니다:
#   0 23 * * * /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/backup-s3.sh
#   0 14 * * 0 /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/backup-s3.sh
# 결과는 syslog(태그 my-macro-backup):  journalctl -t my-macro-backup
# 실패하면 서버 .env의 텔레그램 봇(TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID — 모의 매매 알림과 같은 봇)으로 한 줄 알리고, 성공하면
# backups/.last-s3-ok에 시각을 남깁니다 — make status와 deploy.sh 끝 요약이 그 시각이 36시간을 넘으면 경고합니다(deploy.sh는 없을 때도,
# 판정은 scripts/vultr/backup-age.sh — QA-199).
#
# make backup(backups/에 접두어별 최근 BACKUP_KEEP개 보존, ADR 0003)이 만든 파일 하나만 s3://<AWS_BACKUP_BUCKET>/db/vultr/에
# 올립니다 — AWS 서버와 같은 버킷, 접두어로 구분(병행 중 AWS의 db/와 섞이지 않게). 60일 지난 객체는 db/ 아래에 걸린 수명주기가
# 지웁니다(db/vultr/ 포함 — 2026-11-03 AWS 정리 때 버킷 전체에서 db/로 좁히고 AWS 마지막 덤프는 만료 없는 archive/에 둠). 실패하면 syslog에 err로 남기고 0이 아닌 값으로 끝납니다. 버킷 이름은 .env의 AWS_BACKUP_BUCKET
# (환경변수가 먼저). 인증은 인스턴스 역할이 없어 서버 ubuntu의 ~/.aws/credentials(600) — 이 버킷의 db/vultr/에만 쓰고 db/는 읽기만 하는
# IAM 사용자의 키입니다(ADR 0023).
# =============================================================================
set -euo pipefail

# cron의 PATH는 /usr/bin:/bin뿐입니다 — AWS CLI v2는 /usr/local/bin에 깔립니다(뒤에 덧붙여 앞선 PATH가 먼저).
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin"
export COMPOSE_FILE=docker-compose.yml:compose.vultr.yml
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # DB_NAME · BACKUP_DIR · env_file_value, 저장소 최상위로 이동

tag=my-macro-backup
# QA-199: 실패를 운영자에게 밀어서 알립니다 — syslog만으로는 journalctl을 보기 전까지 아무도 모르고, 그동안 db/ 수명주기(60일)가
# 서버 밖 사본을 지워 갑니다. 둘 중 하나라도 비면 조용히 건너뜁니다. 토큰·채팅 ID는 curl 설정(stdin, -K -)으로 넘겨 프로세스 목록·로그에
# 남기지 않고(출력도 버림), 알림이 실패해도 백업의 종료 코드(1)는 그대로입니다. 보내는 글은 fail의 사유 한 줄 그대로입니다 — 걸러 내는 것은
# make backup 출력에서 고른 원인 줄뿐이고(compose 경고 줄을 빼고, .env 해석 오류로 보이면 '값 생략'으로 바꿈 — 아래), S3 올리기 실패는
# 버킷 이름(.env의 AWS_BACKUP_BUCKET)과 aws 오류 끝 두 줄을 그대로 담습니다.
notify_failure() {
    local token chat
    token="$(env_file_value TELEGRAM_BOT_TOKEN)"
    chat="$(env_file_value TELEGRAM_CHAT_ID)"
    [ -n "$token" ] && [ -n "$chat" ] || return 0
    # curl 설정의 따옴표 값에 그대로 넣을 수 없는 글자가 있으면 보내지 않습니다(정상 토큰·채팅 ID에는 없음).
    if [[ "$token$chat" =~ [[:space:]\"\\] ]]; then return 0; fi
    command -v curl >/dev/null 2>&1 || return 0
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\n' "$token" "$chat" |
        curl -sS --fail -o /dev/null --max-time 10 -K - --data-urlencode "text=my-macro 서버 — $1 (journalctl -t $tag)" >/dev/null 2>&1 ||
        logger -t "$tag" -p user.warning "백업 실패 텔레그램 알림을 보내지 못했습니다" || true
}
fail() {
    logger -t "$tag" -p user.err "백업 실패: $*" || true
    echo "✗ 백업 실패: $*" >&2
    notify_failure "백업 실패: $*" || true
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
    reason="$(printf '%s\n' "$output" | grep -v -e '^make: \*\*\*' -e '^✗' -e 'level=warning' -e '^WARN' | tail -n 1)" || true
    case "$reason" in *.env*|*"failed to read"*|*"variable is not set"*) reason="(.env 해석 오류 — 값 생략)" ;; esac
    fail "make backup — ${reason:-원인 모름} (전체 출력: backups/backup-s3-last-error.log)"
fi
latest="$( (comm -13 <(printf '%s\n' "$before") <(list_backups) || true) | sed '/^$/d')"
[ -n "$latest" ] || fail "make backup이 새 파일을 남기지 않았습니다($BACKUP_DIR)"
[ "$(printf '%s\n' "$latest" | wc -l | tr -d ' ')" = 1 ] || fail "새 백업 파일이 하나가 아닙니다 — 올리지 않았습니다"

key="db/vultr/$(basename "$latest")"
if ! upload="$(aws s3 cp --only-show-errors "$latest" "s3://$bucket/$key" 2>&1)"; then
    fail "S3 올리기(s3://$bucket/$key) — $(printf '%s\n' "$upload" | tail -n 2 | tr '\n' ' ')"
fi
size="$(du -h "$latest" | cut -f1)"
logger -t "$tag" "백업을 올렸습니다: s3://$bucket/$key ($size)" || true
# QA-199: 마지막으로 서버 밖 사본을 올린 시각(유닉스 초 · UTC · 키 — 버킷 이름은 적지 않음). 쓰지 못해도 올리기는 끝났으므로 실패로 보지 않고,
# 그러면 make status·deploy.sh가 오래됐다고 알립니다(backup-age.sh).
{ printf '%s %s %s\n' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$key" > "$BACKUP_DIR/.last-s3-ok.tmp" &&
    mv -f "$BACKUP_DIR/.last-s3-ok.tmp" "$BACKUP_DIR/.last-s3-ok"; } ||
    logger -t "$tag" -p user.warning "마지막 성공 시각(backups/.last-s3-ok)을 남기지 못했습니다" || true
echo "✓ s3://$bucket/$key ($size)"
