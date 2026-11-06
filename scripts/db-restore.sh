#!/usr/bin/env bash
# scripts/db-restore.sh — 백업 파일로 데이터베이스를 **통째로 바꿉니다** (make restore F=…)
#
# 사용: bash scripts/db-restore.sh backups/파일.sql [--yes]
#
# 순서
#   1. 백업 파일이 끝까지 기록된 것인지 확인합니다(중간에 끊긴 파일이면 시작하지 않음).
#   2. 확인을 받습니다(--yes가 없으면 터미널에서 y를 눌러야 함).
#   3. 지금 DB를 backups/pre-restore-….sql로 먼저 백업합니다 — 잘못 복원해도 되돌릴 수 있게.
#   4. 수집기·백엔드를 잠시 멈추고(쓰기 경합 방지), **한 트랜잭션 안에서** public 스키마를 비운 뒤
#      백업을 적재합니다. 도중에 한 문장이라도 실패하거나 입력이 끊기면(창을 닫음·Ctrl-C) 전부
#      되돌려 DB는 3번 시점 그대로입니다.
#      같은 트랜잭션의 끝에서 꺼져 있지 않은 실제 매매 설정(real_trade_config, ADR 0028)을 이상 멈춤(HALTED, 사유 restored)으로
#      바꿉니다 — 아래 RESTORE_REAL_TRADE.
#   5. 멈췄던 서비스를 다시 켭니다(실패해도).
#
# RESTORE_REAL_TRADE  복원한 DB의 실제 매매 표(ADR 0028)를 어떻게 둘지. 표가 없는 백업(V24 전)이면 둘 다 아무것도 하지 않습니다.
#   halt(기본)  real_trade_config에서 OFF가 아닌 행을 HALTED·halt_reason='restored'(version + 1)로(꺼진 행은 그대로). 백업 시점 뒤에 토스로 나간 실제 주문의
#               기록이 빠진 채 따라 하기가 이어지지 않게 — 해제는 운영자가 화면에서(확인 글자 + 비밀번호). make restore·서버 복원
#   clear       real_trade_orders·real_trade_batches·real_trade_events를 비우고 설정은 꺼짐(OFF, 기준 평가액 등 비움)으로.
#               QA 스택 복원(scripts/qa/qa-stack.sh restore)이 씁니다 — 운영 백업의 실제 계좌 주문 기록을 QA DB에 남기지 않음
#   이 단계가 실패하면 복원 전체를 되돌립니다(멈추지 못한 채로 복원하지 않음).
#
# 예전 `make restore`는 데이터가 있는 DB에 덤프를 그대로 부었습니다. 덤프에는 기존 표를 지우는
# 문장이 없어 CREATE·COPY가 줄줄이 실패했는데도 0으로 끝났고, 값은 백업 시점으로 돌아오지
# 않았습니다(재현: 오류 21건, 종료 코드 0, 값 그대로).
set -euo pipefail
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/db-common.sh"

die() {
    echo "✗ $*" >&2
    exit 1
}

file="${1:-}"
assume_yes="no"
[ "${2:-}" = "--yes" ] && assume_yes="yes"
real_trade_mode="${RESTORE_REAL_TRADE:-halt}"
case "$real_trade_mode" in
    halt | clear) ;;
    *) die "RESTORE_REAL_TRADE는 halt 또는 clear만 받습니다 — 아무것도 바꾸지 않았습니다." ;;
esac

[ -n "$file" ] || die "사용법: make restore F=backups/파일.sql"
[ -f "$file" ] || die "백업 파일이 없습니다: $file"
[ -s "$file" ] || die "백업 파일이 비어 있습니다: $file"
dump_is_complete "$file" || die "끝까지 기록되지 않은 백업입니다(pg_dump 끝 표시 없음): $file — 복원하지 않았습니다."

if [ "$assume_yes" != "yes" ]; then
    [ -t 0 ] || die "확인 없이 복원하지 않습니다. 터미널에서 실행하거나 --yes를 붙이세요."
    echo "경고: DB '$DB_NAME'의 지금 내용을 모두 지우고 $file 로 바꿉니다."
    echo "   (바꾸기 전에 지금 상태를 backups/pre-restore-….sql로 먼저 백업합니다)"
    read -r -p "계속할까요? [y/N] " answer
    [ "$answer" = "y" ] || die "취소했습니다. 아무것도 바꾸지 않았습니다."
fi

echo "1/3 지금 DB를 먼저 백업합니다…"
safety="$(new_backup_path pre-restore)"
dump_to "$safety" || die "복원 전 백업에 실패해 복원하지 않았습니다."
echo "    → $safety"

# 컨테이너 모드에서만: 돌고 있던 서비스를 멈췄다가 끝나면 다시 켭니다.
# 목록은 한 번 받아 둔 뒤 비교합니다. `docker compose ps … | grep -q`는 pipefail 아래에서 grep이 먼저
# 찾고 끝나면 docker가 SIGPIPE로 죽어 "돌고 있지 않음"으로 판정되고, 그 서비스를 멈추지 않았습니다.
stopped=""
if [ -n "$DB_EXEC" ]; then
    running="$(docker compose ps --status running --services 2>/dev/null || true)"
    for service in ${RESTORE_STOP_SERVICES-collector backend}; do
        if grep -qx "$service" <<< "$running"; then
            stopped="$stopped $service"
        fi
    done
fi
restart_services() {
    if [ -n "$stopped" ]; then
        echo "3/3 멈췄던 서비스를 다시 켭니다:$stopped"
        # shellcheck disable=SC2086
        docker compose start $stopped >/dev/null || echo "경고: 서비스를 다시 켜지 못했습니다. make up으로 켜세요." >&2
    fi
}
trap restart_services EXIT
if [ -n "$stopped" ]; then
    echo "2/3 쓰기가 겹치지 않게 서비스를 잠시 멈춥니다:$stopped"
    # shellcheck disable=SC2086
    docker compose stop $stopped >/dev/null
fi

echo "2/3 복원합니다 (한 트랜잭션 — 실패하면 전부 되돌립니다)…"
# 트랜잭션은 psql의 --single-transaction이 아니라 입력 안의 BEGIN … COMMIT으로 엽니다.
# --single-transaction은 입력이 오류 없이 끝나기만 하면(EOF) COMMIT을 보내서, 복원 중에 창을 닫거나
# Ctrl-C를 누르거나 파일 읽기가 끊기면 "스키마를 지우고 일부만 적재한" 상태가 확정됐습니다.
# 이제 COMMIT은 덤프를 끝까지 보낸 뒤에만 입력에 들어 있고, 그 전에 끊기면 연결이 닫히면서
# 서버가 되돌립니다. 성공 여부는 COMMIT 뒤에 찍는 표시로 판단합니다(끊겨도 psql은 0으로 끝날 수 있음).
#
# 덤프 자체가 `SET lock_timeout = 0`을 넣으므로, 잠금 대기 한도는 스키마를 지우는 문장 앞에 둡니다.
# 새로 만드는 public 스키마의 소유자·권한은 PostgreSQL 15+ 기본값과 같게 맞춥니다.
committed_marker="__restore_committed__"
real_trade_marker="__real_trade_rows__"

# 덤프를 적재한 뒤, COMMIT 전에 넣는 실제 매매 표 처리(위 RESTORE_REAL_TRADE). 덤프는 search_path를 비워 두므로 표 이름에 public.을 붙입니다.
# 바꾼 설정 행 수를 트랜잭션 안 설정 값으로 넘겨 끝에 \echo로 찍습니다(표가 없으면 0).
real_trade_sql() {
    # shellcheck disable=SC2016  # $real_trade$는 PostgreSQL의 달러 따옴표입니다
    printf 'DO $real_trade$\nDECLARE n integer := 0;\nBEGIN\n'
    if [ "$real_trade_mode" = "clear" ]; then
        # 주문이 묶음을 참조하므로 주문 → 묶음 순서로 지웁니다.
        cat <<'SQL'
    IF to_regclass('public.real_trade_orders') IS NOT NULL THEN
        DELETE FROM public.real_trade_orders;
    END IF;
    IF to_regclass('public.real_trade_batches') IS NOT NULL THEN
        DELETE FROM public.real_trade_batches;
    END IF;
    IF to_regclass('public.real_trade_events') IS NOT NULL THEN
        DELETE FROM public.real_trade_events;
    END IF;
    IF to_regclass('public.real_trade_config') IS NOT NULL THEN
        UPDATE public.real_trade_config
           SET state = 'OFF', baseline_equity = NULL, baseline_total = NULL, buys_paused = false, sync_pending = false,
               halt_reason = NULL, halt_detail = NULL, version = version + 1, updated_at = now(), updated_by = NULL;
        GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
SQL
    else
        cat <<'SQL'
    IF to_regclass('public.real_trade_config') IS NOT NULL THEN
        UPDATE public.real_trade_config
           SET state = 'HALTED', halt_reason = 'restored', halt_detail = NULL,
               version = version + 1, updated_at = now(), updated_by = NULL
         WHERE state <> 'OFF';
        GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
SQL
    fi
    printf "    PERFORM set_config('macrodash.real_trade_rows', n::text, true);\nEND\n\$real_trade\$;\n"
    printf "SELECT current_setting('macrodash.real_trade_rows') AS real_trade_rows \\\\gset\n"
    printf '\\echo %s :real_trade_rows\n' "$real_trade_marker"
}

output="$({
    printf "SET lock_timeout = '30s';\n"
    printf "BEGIN;\n"
    printf "DROP SCHEMA public CASCADE;\n"
    printf "CREATE SCHEMA public AUTHORIZATION pg_database_owner;\n"
    printf "GRANT USAGE ON SCHEMA public TO PUBLIC;\n"
    cat "$file"
    real_trade_sql
    printf "COMMIT;\n"
    printf '\\echo %s\n' "$committed_marker"
} | run_psql -q -v ON_ERROR_STOP=1 -f -)" || true
if [ "${output##*$'\n'}" != "$committed_marker" ]; then
    die "복원에 실패해 전부 되돌렸습니다. DB는 복원 전과 같습니다(복원 전 백업: $safety)."
fi

echo "✓ 복원했습니다: $file"
real_trade_rows="$(sed -n "s/^$real_trade_marker //p" <<< "$output" | tail -n 1)"
case "$real_trade_rows" in
    '' | 0 | *[!0-9]*) ;;
    *)
        if [ "$real_trade_mode" = "clear" ]; then
            echo "참고: 실제 매매 기록(real_trade_orders·batches·events)을 비우고 설정 ${real_trade_rows}개 시장을 꺼짐(OFF)으로 두었습니다."
        else
            echo "참고: 실제 매매 설정 ${real_trade_rows}개 시장을 이상 멈춤(restored)으로 바꿨습니다(ADR 0028) — 화면 '실제 계좌' 탭에서 확인한 뒤 멈춤 해제 또는 끄기."
        fi ;;
esac
echo "   되돌리려면: make restore F=$safety"
