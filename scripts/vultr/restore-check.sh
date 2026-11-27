#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/restore-check.sh — 서버 밖 사본(S3 db/vultr/)의 가장 최근 덤프가 실제로 복원되는지 주 1회 확인합니다(ADR 0023 덧붙임 2026-11-27).
#
# 백업은 날마다 뜨지만 그 덤프가 읽히는지 보는 절차는 없었습니다(docs/improve/2026-11-27-quality-plan.md §3). backup-s3.sh가 마지막으로 올린
# 객체(backups/.last-s3-ok의 키)를 받아 **운영과 떨어진 일회용 postgres 컨테이너**에 적재하고 판정합니다.
#   · 컨테이너: 이름 my-macro-restore-check, 망 없음(--network none) · 포트 게시 없음 · 메모리 768MB(스왑 없음) · CPU 1, 운영 postgres와 같은 이미지
#     (받지 않음 — --pull never), 끝·중단 때 익명 볼륨까지 지움. 운영 DB·운영 컨테이너·운영 볼륨에는 쓰지 않습니다(운영 컨테이너에서 읽는 것은
#     이미지 ID 하나 — docker inspect).
#   · 판정(순서대로, 걸린 사유 코드를 모두 모음):
#       받은 파일의 끝 표시·크기 → 적재(ON_ERROR_STOP)와 적재 끝 표시 → 꼭 있어야 하는 표 · 스키마 번호(schema_migrations)
#       → 주요 표의 행 수(0보다 크고 직전 성공 기록보다 10% 넘게 줄지 않음) → 최근 자료 시각(snapshots.collected_at의 최댓값이 덤프 시각 앞 24시간 안)
#       → 실제 계좌 표 13개(real_trade_* 5 · manual_* 8)는 count(*)만 — 건수는 backups/.last-restore-ok(권한 600)에만, 알림·syslog에는 '읽힘'만.
#   · 안전장치: 평일 08:45~16:35 KST(실제 매매 창과 그 뒤 한 시간)에는 시작하지 않음, 여유 디스크 6 GB · 여유 메모리 1 GB 미만이면 건너뛰고 알림,
#     전체 30분 상한, 겹쳐 돌지 않게 잠금(flock), 끝·중단 때 컨테이너와 받은 파일 정리.
#
# 사용(저장소 최상위로 옮겨 .env·backups/를 봄):
#   bash scripts/vultr/restore-check.sh                       S3의 마지막 덤프를 받아 확인. 정상이면 syslog 한 줄 + backups/.last-restore-ok(알리지 않음),
#                                                             실패하면 운영 봇으로 한 통. 0 정상 · 1 실패 · 3 건너뜀
#   bash scripts/vultr/restore-check.sh --rebase              직전 성공 기록과 견주지 않고 확인(행 수·크기가 줄어든 것이 맞을 때 — 정상이면 기록을 새로 씀)
#   bash scripts/vultr/restore-check.sh --file <덤프.sql>     이 파일을 확인(받지 않음, 알리지 않음, 기록을 읽지도 쓰지도 않음 — 손으로 보는 길. 덤프 시각은 파일 시각)
#   bash scripts/vultr/restore-check.sh --summary             '마지막 복원 확인 N일 전' 한 줄(deploy.sh 끝 요약 — 9일 넘거나 기록이 없으면 '경고:')
#   bash scripts/vultr/restore-check.sh --summary-if-server   서버(.env의 COMPOSE_FILE에 compose.vultr.yml)일 때만 그 한 줄(make status)
#
# cron(서버의 ubuntu 사용자, 서버 시간대는 UTC): 토요일 00:30 UTC = 09:30 KST(08:00 정기 백업 뒤, 두 시장 모두 닫힘, 다른 cron과 겹치지 않음):
#   30 0 * * 6 /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/restore-check.sh >/dev/null 2>&1
# 결과는 syslog(태그 my-macro-restore-check):  journalctl -t my-macro-restore-check
# 텔레그램은 scripts/vultr/notify-common.sh(운영 봇). 알림·syslog·출력에는 상태·사유 코드·표 이름·건수(모의·수집 표의 개수)만 넣습니다 —
# psql·aws의 오류 글은 싣지 않습니다(COPY 오류의 줄에 행 값이, aws 오류에 버킷 이름이 섞일 수 있음). 실제 계좌 표의 건수는 기록 파일에만.
#
# 환경변수(평소에는 쓰지 않음): RESTORE_CHECK_ANYTIME=1(평일 낮에도 시작) · RESTORE_CHECK_IMAGE(운영 postgres 대신 쓸 이미지 — PC에서 --file로 볼 때)
#   · RESTORE_CHECK_FRESH_HOURS(최근 자료 시각 허용 폭, 기본 24) · RESTORE_CHECK_MEMINFO(시험용 — /proc/meminfo 자리).
# 버킷 이름은 .env의 AWS_BACKUP_BUCKET(환경변수가 먼저), 인증은 backup-s3.sh와 같은 ~/.aws/credentials입니다.
# 보는 것은 '읽히고 최근 자료가 있음'까지입니다 — 값이 옳은지, make restore의 뒤처리, 앱 기동은 보지 않습니다.
# =============================================================================
set -euo pipefail

# cron의 PATH는 /usr/bin:/bin뿐입니다 — AWS CLI v2는 /usr/local/bin에 깔립니다(뒤에 덧붙여 앞선 PATH가 먼저).
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # DB_USER · BACKUP_DIR · env_file_value · dump_is_complete, 저장소 최상위로 이동
# shellcheck source=scripts/vultr/notify-common.sh
source "$DB_SCRIPTS_DIR/vultr/notify-common.sh"           # notify_telegram

tag=my-macro-restore-check
record="$BACKUP_DIR/.last-restore-ok"
usage="사용: bash scripts/vultr/restore-check.sh [--rebase | --file <덤프.sql> | --summary | --summary-if-server]"

mode=check
file=""
rebase=""
case "${1:-}" in
    '') ;;
    --rebase) rebase=1 ;;
    --file) mode=file; file="${2:-}" ;;
    --summary) mode=summary ;;
    --summary-if-server)
        mode=summary
        case ":$(env_file_value COMPOSE_FILE):" in *:compose.vultr.yml:*) ;; *) exit 0 ;; esac ;;
    *) echo "$usage" >&2; exit 2 ;;
esac
if { [ "$mode" = file ] && { [ -z "$file" ] || [ "$#" -ne 2 ]; }; } || { [ "$mode" != file ] && [ "$#" -gt 1 ]; }; then
    echo "$usage" >&2
    exit 2
fi

# ---------------------------------------------------------------- 요약(deploy.sh 끝 · make status) — 알리지 않고 0으로 끝남
# cron은 주 1회라 9일이 넘으면 한 번 이상 놓친 것입니다. 실패는 텔레그램으로 오지만 cron이 빠지면 아무 신호가 없어 이 줄로 봅니다.
if [ "$mode" = summary ]; then
    last="$(head -n 1 "$record" 2>/dev/null | cut -d' ' -f1)" || true
    case "$last" in
        '' | *[!0-9]*)
            echo "경고: 백업 복원 확인 기록(backups/.last-restore-ok)이 없습니다 — crontab -l과 journalctl -t my-macro-restore-check을 보세요(처음이면 DEVELOPMENT §7 '백업 복원 확인'의 cron 한 줄 등록)." ;;
        *)
            age_d=$(( ($(date +%s) - 10#$last) / 86400 ))
            if [ "$age_d" -gt 9 ]; then
                echo "경고: 마지막 백업 복원 확인이 ${age_d}일 전입니다(9일 넘음) — crontab -l과 journalctl -t my-macro-restore-check을 보세요."
            else
                echo "마지막 백업 복원 확인: ${age_d}일 전"
            fi ;;
    esac
    exit 0
fi

# ---------------------------------------------------------------- 끝내기 · 정리
ctr=my-macro-restore-check
work="$BACKUP_DIR/.restore-check-tmp"   # 받은 덤프를 잠깐 두는 자리(권한 700 — 끝·중단 때 지움)
started="$(date +%s)"
deadline=$((started + 1800))
cleanup_on=""
source_name=""                           # 알림·syslog에 적는 덤프 이름(S3 키 또는 파일 이름 — 버킷 이름은 적지 않음)

child=""                                 # 오래 걸리는 단계(받기·적재)의 프로세스 — 중단 때 먼저 끝냄

cleanup() {
    [ -n "$cleanup_on" ] || return 0
    [ -z "$child" ] || kill "$child" 2>/dev/null || true
    docker rm -f -v "$ctr" >/dev/null 2>&1 || true
    rm -rf "$work" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

say_log() {   # <syslog 우선순위> <글>
    logger -t "$tag" -p "$1" "$2" || true
}
# 알림 — --file(손으로 보는 길)에서는 보내지 않습니다. 보내지 못해도 종료 코드는 그대로입니다.
notify() {
    [ "$mode" = check ] || return 0
    local rc=0
    notify_telegram "$1" || rc=$?
    case "$rc" in
        0) ;;
        2) say_log user.warning "텔레그램 값이 없어 알리지 않음" ;;
        *) say_log user.warning "텔레그램 알림을 보내지 못함" ;;
    esac
}
fail() {   # <사유 코드들>
    say_log user.err "복원 확인 실패: $1${source_name:+ ($source_name)}"
    echo "✗ 백업 복원 확인 실패: $1${source_name:+ ($source_name)}" >&2
    local text="my-macro 서버 — 백업 복원 확인 실패: $1${source_name:+ ($source_name)}"
    text+=$'\n\n실행:'
    text+=$'\n1. 기록 보기 — 셸: ssh ubuntu@my-macro-app 다음 journalctl -t my-macro-restore-check --since today'
    text+=$'\n2. 다시 돌리기(평일 08:45~16:35 KST 밖): cd ~/My_macro_dashboard_v2 && bash scripts/vultr/restore-check.sh'
    text+=$'\n3. 행 수·크기가 줄어든 것이 맞으면(rows_dropped·size_dropped): bash scripts/vultr/restore-check.sh --rebase'
    text+=$'\n사유 코드의 뜻은 docs/DEVELOPMENT.md §7 \'백업 복원 확인\'. 운영 DB는 건드리지 않았습니다.'
    text+=$'\n직접 하기 어려우면 Claude Code에 "복원 확인 실패 봐 줘"라고 하면 됩니다.'
    notify "$text"
    exit 1
}
skip() {   # <사유 코드> <글> [notify]
    say_log user.warning "복원 확인 건너뜀: $1 — $2"
    echo "경고: 백업 복원 확인을 건너뜁니다($1) — $2" >&2
    if [ "${3:-}" = notify ]; then
        notify "my-macro 서버 — 백업 복원 확인 건너뜀: $1 — $2"$'\n\n'"자리가 나면 다시: cd ~/My_macro_dashboard_v2 && bash scripts/vultr/restore-check.sh (디스크는 DEVELOPMENT §7 '디스크')"
    fi
    exit 3
}
# 남은 시간(전체 30분 상한) 안에서만 돌립니다 — 넘으면 124(timeout). timeout이 없으면 그대로 돌립니다.
# time_limit은 앞에 붙일 명령(배열 lim)을 정하고, 남은 시간이 없으면 1을 돌려줍니다.
lim=()
time_limit() {
    local left=$((deadline - $(date +%s)))
    lim=()
    [ "$left" -gt 0 ] || return 1
    ! command -v timeout >/dev/null 2>&1 || lim=(timeout --kill-after=30 "$left")
}
limited() {
    time_limit || return 124
    "${lim[@]}" "$@"
}
# 오래 걸리는 단계는 뒤에서 돌리고 기다립니다 — bash는 앞에서 도는 명령이 끝나야 신호를 처리해, 그대로 두면 중단(TERM)해도 그 단계가 끝날 때까지
# 정리가 밀립니다. 뒤에서 도는 명령의 표준 입력은 /dev/null입니다.
waited() {
    local rc=0
    time_limit || return 124
    "${lim[@]}" "$@" &
    child=$!
    wait "$child" || rc=$?
    child=""
    return "$rc"
}

# ---------------------------------------------------------------- 안전장치
# 실제 매매 창(평일 08:45~15:35 KST — deploy.sh의 가드와 같은 창)과 그 뒤 한 시간에는 시작하지 않습니다(적재가 CPU 하나와 디스크를 씀).
# 휴장일도 평일이면 창으로 봅니다. 장 시간 변경일의 옮긴 창은 보지 않습니다(운영 DB를 읽지 않음 — cron은 토요일).
if [ "${RESTORE_CHECK_ANYTIME:-}" != 1 ]; then
    now="$(TZ=Asia/Seoul date '+%u %H%M')"
    dow="${now% *}"
    hm="${now#* }"
    hm=$((10#${hm:0:2} * 60 + 10#${hm:2:2}))
    if [ "$dow" -le 5 ] && [ "$hm" -ge 525 ] && [ "$hm" -le 995 ]; then
        skip trade_window "평일 08:45~16:35 KST(실제 매매 창과 그 뒤 한 시간)에는 시작하지 않습니다(알고 진행할 때만 RESTORE_CHECK_ANYTIME=1)"
    fi
fi

# 여기서 만드는 파일(잠금·받은 덤프·기록)은 소유자만 읽습니다 — 덤프에는 DB가 통째로, 기록에는 실제 계좌 표의 건수가 들어 있습니다.
umask 077

# 겹쳐 돌지 않게 — 잠금은 이 프로세스가 끝나면 풀립니다. flock이 없으면(서버·이 PC에는 있음) 잠금 없이 갑니다.
mkdir -p "$BACKUP_DIR"
if command -v flock >/dev/null 2>&1; then
    exec 9> "$BACKUP_DIR/.restore-check.lock"
    flock -n 9 || skip locked "다른 복원 확인이 돌고 있습니다"
fi
cleanup_on=1   # 여기부터 끝·중단 때 컨테이너와 받은 파일을 지웁니다(잠금을 쥔 쪽만 — 돌고 있는 다른 실행의 것을 지우지 않게)

# 여유 디스크 6 GB(받은 덤프 약 0.5 GB + 적재한 DB) · 여유 메모리 1 GB(컨테이너 상한 768 MB). 읽지 못하면 그대로 갑니다(컨테이너 상한이 지킴).
avail_kb="$( (df -P / 2>/dev/null || true) | awk 'NR == 2 { print $4 }')" || avail_kb=""
case "$avail_kb" in
    '' | *[!0-9]*) ;;
    *) [ "$avail_kb" -ge 6291456 ] || skip low_disk "여유 디스크가 6GB 미만입니다(지금 $(awk -v k="$avail_kb" 'BEGIN { printf "%.1fGB", k / 1048576 }'))" notify ;;
esac
mem_kb="$(awk '$1 == "MemAvailable:" { print $2 }' "${RESTORE_CHECK_MEMINFO:-/proc/meminfo}" 2>/dev/null)" || mem_kb=""
case "$mem_kb" in
    '' | *[!0-9]*) ;;
    *) [ "$mem_kb" -ge 1048576 ] || skip low_memory "여유 메모리가 1GB 미만입니다(지금 $((mem_kb / 1024))MB)" notify ;;
esac

# 앞 실행이 강제로 죽어 남은 것(같은 이름의 컨테이너·받다 만 파일)을 먼저 치웁니다.
docker rm -f -v "$ctr" >/dev/null 2>&1 || true
rm -rf "$work"

# ---------------------------------------------------------------- 덤프 고르기
prev() {   # 직전 성공 기록의 <이름>=<값> — --file·--rebase면 견주지 않음(빈 값)
    [ "$mode" = check ] && [ -z "$rebase" ] || return 0
    (grep -s "^$1=" "$record" || true) | head -n 1 | cut -d= -f2
}
if [ "$mode" = file ]; then
    [ -f "$file" ] || { echo "✗ 덤프 파일이 없습니다: $file" >&2; exit 2; }
    source_name="$(basename "$file")"
    dump="$file"
    dump_epoch="$(date -r "$file" +%s)"
else
    # backup-s3.sh가 남긴 "<유닉스 초> <UTC 시각> <키>" — 키는 db/vultr/<이름>.sql 모양만 받습니다.
    dump_epoch=""
    key=""
    [ ! -r "$BACKUP_DIR/.last-s3-ok" ] || read -r dump_epoch _ key _ < "$BACKUP_DIR/.last-s3-ok" || true
    key_re='^db/vultr/[A-Za-z0-9._-]+\.sql$'
    case "$dump_epoch" in '' | *[!0-9]*) fail no_backup_record ;; esac
    [[ "$key" =~ $key_re ]] || fail no_backup_record
    source_name="$key"
    bucket="${AWS_BACKUP_BUCKET:-$(env_file_value AWS_BACKUP_BUCKET)}"
    [ -n "$bucket" ] || fail no_bucket
    mkdir -p "$work"
    dump="$work/$(basename "$key")"
    rc=0
    waited aws s3 cp --only-show-errors "s3://$bucket/$key" "$dump" >/dev/null 2>&1 || rc=$?
    case "$rc" in 0) ;; 124 | 137) fail timeout_download ;; *) fail download_failed ;; esac
fi

# 받은 파일의 끝 표시와 크기.
[ -s "$dump" ] || fail dump_empty
dump_is_complete "$dump" || fail dump_incomplete
size="$(wc -c < "$dump" | tr -d ' ')"
problems=()
prev_size="$(prev size)"
case "$prev_size" in
    '' | *[!0-9]*) ;;
    *) [ $((size * 10)) -ge $((prev_size * 9)) ] || problems+=(size_dropped) ;;
esac

# ---------------------------------------------------------------- 일회용 postgres
# 이미지는 운영 postgres 컨테이너가 쓰는 것 그대로(ID — 받지 않아도 이 서버에 있음, 같은 판). 읽기만 합니다.
image="${RESTORE_CHECK_IMAGE:-}"
if [ -z "$image" ]; then
    prod="$(docker compose ps -q postgres 2>/dev/null | head -n 1)" || prod=""
    [ -z "$prod" ] || image="$(docker inspect --format '{{.Image}}' "$prod" 2>/dev/null)" || image=""
    [ -n "$image" ] || fail image_unknown
fi

# 망 없음(포트 게시 없음) · 메모리 768MB(스왑 없음) · CPU 1. 인증은 trust — 망이 없어 컨테이너 안의 루프백으로만 닿습니다(비밀값 없음).
# 덤프의 OWNER TO가 통하도록 사용자 이름은 운영과 같게, DB 이름은 운영과 다르게 둡니다. fsync 등은 버릴 DB라 꺼서 디스크 쓰기를 줄이고,
# 병렬 작업자는 /dev/shm(64MB)을 넘지 않게 끕니다.
if ! limited docker run -d --name "$ctr" --label my-macro.role=restore-check --pull never \
        --network none --memory 768m --memory-swap 768m --cpus 1 \
        -e POSTGRES_USER="$DB_USER" -e POSTGRES_DB=restore_check -e POSTGRES_HOST_AUTH_METHOD=trust -e LANG=C.UTF-8 \
        "$image" -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
        -c max_parallel_maintenance_workers=0 -c max_parallel_workers_per_gather=0 >/dev/null 2>&1; then
    fail container_start_failed
fi
in_db() {   # 컨테이너 안의 psql — TCP 루프백으로(초기화 중의 임시 서버는 유닉스 소켓만 열어, 소켓으로 붙으면 준비 전에 닿음)
    limited docker exec -i "$ctr" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_USER" -d restore_check "$@"
}
# 컨테이너가 메모리 상한에 걸려 죽었는지 — 실패 사유를 가릅니다.
oom_or() {
    if [ "$(docker inspect --format '{{.State.OOMKilled}}' "$ctr" 2>/dev/null || true)" = true ]; then echo out_of_memory; else echo "$1"; fi
}

ready=""
for _ in $(seq 1 60); do
    if docker exec "$ctr" pg_isready -q -h 127.0.0.1 -U "$DB_USER" -d restore_check >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 2
done
[ -n "$ready" ] || fail "$(oom_or container_not_ready)"

# 적재 — 한 문장이라도 실패하면 멈춥니다(ON_ERROR_STOP). 덤프 뒤에 끝 표시를 덧붙여, psql이 입력을 끝까지 읽었는지 따로 봅니다.
# psql의 출력·오류 글은 버립니다(COPY 오류의 줄에 행 값이 섞일 수 있음).
load_started="$(date +%s)"
rc=0
if time_limit; then
    { cat "$dump" && printf '\n%s\n' 'CREATE SCHEMA restore_check; CREATE TABLE restore_check.loaded AS SELECT 1 AS ok;'; } |
        "${lim[@]}" docker exec -i "$ctr" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_USER" -d restore_check >/dev/null 2>&1 &
    child=$!
    wait "$child" || rc=$?
    child=""
else
    rc=124
fi
case "$rc" in 0) ;; 124 | 137) fail "$(oom_or timeout_load)" ;; *) fail "$(oom_or load_failed)" ;; esac
load_seconds=$(( $(date +%s) - load_started ))

# ---------------------------------------------------------------- 판정
# 꼭 있어야 하는 표(수집·모의 매매·계정·실제 계좌의 뼈대)와 행 수를 보는 주요 표. 실제 계좌 표(ADR 0025·0028·0029·0034)는 따로 — 건수를 기록 파일에만.
required="schema_migrations snapshots timeseries observations collector_runs users paper_books paper_settings paper_positions paper_orders paper_fills paper_decisions paper_nav_daily real_trade_config manual_accounts"
main_tables="snapshots timeseries observations users paper_orders paper_fills paper_decisions paper_nav_daily"
real_tables="real_trade_config real_trade_batches real_trade_orders real_trade_events real_trade_valuation manual_accounts manual_sessions manual_instructions manual_stop_instructions manual_trades manual_positions manual_balance manual_ledger"

# 한 줄에 <이름>=<값>. 표가 없어도 질의가 실패하지 않게 행 수는 있는 표만 셉니다(query_to_xml — 함수를 만들지 않음).
facts_sql() {
    cat <<'SQL'
SELECT 'marker=' || (to_regclass('restore_check.loaded') IS NOT NULL)::int;
SELECT 'tables=' || count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';
SELECT 'missing=' || coalesce(string_agg(t, ',' ORDER BY t), '')
FROM unnest(string_to_array(:'required', ' ')) AS t WHERE to_regclass('public.' || t) IS NULL;
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has_schema,
       to_regclass('public.snapshots') IS NOT NULL AS has_snapshots \gset
\if :has_schema
SELECT 'schema=' || coalesce(max(version)::text, '') FROM public.schema_migrations;
\endif
\if :has_snapshots
SELECT 'fresh=' || coalesce(floor(extract(epoch FROM max(collected_at)))::bigint::text, '') FROM public.snapshots;
\endif
SELECT 'rows.' || t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text
FROM unnest(string_to_array(:'counted', ' ')) AS t WHERE to_regclass('public.' || t) IS NOT NULL ORDER BY t;
SQL
}
facts="$(facts_sql | in_db -At -v required="$required" -v counted="$main_tables" 2>/dev/null)" || fail "$(oom_or query_failed)"
real_facts="$(facts_sql | in_db -At -v required="" -v counted="$real_tables" 2>/dev/null)" || fail "$(oom_or query_failed)"
fact() {   # <이름> — 숫자·표 이름 모양의 값만 받습니다(그 밖은 빈 값)
    printf '%s\n' "${2:-$facts}" | awk -F= -v k="$1" '$1 == k && $2 ~ /^[0-9a-z_,]*$/ { print $2; exit }'
}

[ "$(fact marker)" = 1 ] || problems+=(load_incomplete)
missing="$(fact missing)"
[ -z "$missing" ] || problems+=("tables_missing:$missing")
tables="$(fact tables)"
schema="$(fact schema)"
case "$schema" in '' | *[!0-9]* | 0) problems+=(schema_unreadable) ;; esac

rows_lines=""
rows_seen=0
for t in $main_tables; do
    n="$(fact "rows.$t")"
    case "$n" in
        '' | *[!0-9]*) continue ;;   # 없는 표는 tables_missing이 이미 잡음
        0) problems+=("rows_zero:$t") ;;
        *)
            p="$(prev "rows.$t")"
            case "$p" in
                '' | *[!0-9]*) ;;
                *) [ $((n * 10)) -ge $((p * 9)) ] || problems+=("rows_dropped:$t") ;;
            esac ;;
    esac
    rows_lines+="rows.$t=$n"$'\n'
    rows_seen=$((rows_seen + 1))
done

# 최근 자료 시각 — 수집기는 쉬는 날에도 돌아, 덤프 시각 앞 24시간 안에 수집한 스냅숏이 하나도 없으면 옛 자료입니다. 덤프 시각보다 한 시간 넘게
# 뒤면 받은 파일이 그 덤프가 아닙니다.
fresh_hours="${RESTORE_CHECK_FRESH_HOURS:-24}"
case "$fresh_hours" in '' | *[!0-9]* | ??????*) fresh_hours=24 ;; esac
fresh="$(fact fresh)"
case "$fresh" in
    '' | *[!0-9]*) problems+=(fresh_unreadable) ;;
    *)
        if [ $((dump_epoch - fresh)) -gt $((10#$fresh_hours * 3600)) ]; then
            problems+=(data_stale)
        elif [ $((fresh - dump_epoch)) -gt 3600 ]; then
            problems+=(data_after_dump)
        fi ;;
esac

# 실제 계좌 표 — 13개가 모두 세어졌는지만 봅니다(건수는 아래 기록 파일에만).
real_lines=""
real_read=0
real_total=0
for t in $real_tables; do
    real_total=$((real_total + 1))
    n="$(fact "rows.$t" "$real_facts")"
    case "$n" in '' | *[!0-9]*) continue ;; esac
    real_read=$((real_read + 1))
    real_lines+="real.$t=$n"$'\n'
done
[ "$real_read" = "$real_total" ] || problems+=("real_tables_unreadable:$((real_total - real_read))")

[ "${#problems[@]}" = 0 ] || fail "${problems[*]}"

# ---------------------------------------------------------------- 결과
summary="${source_name} — 표 ${tables:-?}개 · 스키마 V$schema · 주요 표 ${rows_seen}개 행 수 정상 · 실제 계좌 표 ${real_read}개 읽힘 · 적재 ${load_seconds}초"
if [ "$mode" = check ]; then
    # 첫 줄은 backup-s3.sh의 기록과 같은 모양(유닉스 초 · UTC 시각 · 키), 다음 줄부터 다음 실행이 견줄 값. 실제 계좌 표의 건수가 들어 있어 권한 600.
    if (umask 077 && { printf '%s %s %s\n' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$source_name"
                       printf 'size=%s\ntables=%s\nschema=%s\n%s%s' "$size" "$tables" "$schema" "$rows_lines" "$real_lines"; } > "$record.tmp" &&
            mv -f "$record.tmp" "$record"); then
        say_log user.notice "복원 확인 정상: $summary"
    else
        say_log user.warning "복원 확인 정상: $summary — 기록(backups/.last-restore-ok)을 남기지 못함"
    fi
else
    say_log user.notice "복원 확인 정상(--file, 기록하지 않음): $summary"
fi
echo "✓ 백업 복원 확인: $summary"
