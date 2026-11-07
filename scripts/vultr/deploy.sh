#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/deploy.sh — Vultr 서버(서울 my-macro-app)에서 main을 받아 다시 빌드·기동합니다(ADR 0023).
# 서버에서는 make up 대신 이것을 씁니다. scripts/aws/deploy.sh에서 갈라냈습니다(gate·CloudFront 대역 단계 없음).
#
# 사용(서버 셸 — PC에서 ssh ubuntu@my-macro-app(Tailscale SSH) 또는 비상용 ssh -i ~/.ssh/id_ed25519_vultr ubuntu@<서버 IP>):
#   bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh
#
# 순서
#   1. 점검: 폴더 이름(My_macro_dashboard_v2 — compose 프로젝트·DB 볼륨 이름이 폴더 이름을 따름), .env가 있고
#      서버에 적지 않는 이름(포트 네 줄·AWS 공개 주소용 값·PC 전용 값 등, .env.vultr.example)이 없는지. 값은 읽지도 찍지도 않습니다.
#      PAPER_ENABLED=false가 있으면 운영본의 모의 매매 정기 작업이 꺼진 채 뜬다고 '주의'를 찍습니다(끝 요약에도 다시 — QA-194).
#   2. git fetch → main 체크아웃 → origin/main으로 fast-forward. 서버에서 고친 파일이 있거나 갈라졌으면 멈춥니다.
#      받은 main에서 이 스크립트가 바뀌었으면 새 판으로 처음부터 한 번 다시 돕니다(QA-145).
#   3. 화면 왼쪽 아래 버전(APP_VERSION·APP_UPDATED). 실제 매매(ADR 0028)가 꺼져(OFF) 있지 않고 — 켜짐(LIVE)뿐 아니라 미체결을 취소하는 끄는 중(STOPPING)·
#      이상 멈춤(HALTED)도 셈(OPS-5) — 지금이 한국 거래 창(평일 08:45~15:35 KST — 정규장 전체: 시가 맞추기·개장 10분 뒤 맞추기·장중 스탑 매도·종가,
#      ADR 0033)이면 멈춥니다 —
#      창이 지난 뒤 다시 돌리거나, 알고 진행할 때만 REALTRADE_DEPLOY_OK=1. 빌드가 길어 6의 기동 직전에 한 번 더 봅니다.
#      상태는 postgres의 real_trade_config를 읽기만 하고(표가 없으면 통과), 읽지 못하면 경고만 하고 계속합니다.
#      장 시간 변경일(같은 psql 호출로 읽는 모의 설정 kr.calendar.openTimeOverrides의 오늘 값 — 예 수능 10:00~16:30)은 개장 −15분 ~
#      마감 +5분, 그 설정을 읽지 못했거나 모양이 틀리면 보수 창(평일 08:45~16:35)으로 봅니다.
#   4. 이미지를 하나씩 빌드: backend → frontend → collector → browser(베이스 이미지 보안 패치까지 --pull). browser는 차단 통과 수집 계층의
#      브라우저 컨테이너(ADR 0026 — Chrome 안정 채널을 빌드 때 받음).
#      4 GB라 동시에 빌드하면 메모리가 모자랍니다(make up은 한꺼번에 빌드). caddy·postgres 이미지도 새로 받습니다.
#   5. 배포 전 DB 덤프 backups/pre-deploy-YYYYmmdd-HHMMSS.sql(서버에만, 최근 BACKUP_KEEP개). 뜨지 못하면 배포하지 않습니다(QA-200).
#   6. up -d(건강해질 때까지 기다림) → 스키마 적용(make migrate와 같은 반복 — QA-016·QA-118) → caddy 다시 만들기(바뀐 Caddyfile)
#   7. 매달린 이미지·오래된 빌드 캐시 정리. 끝 요약에 디스크와 마지막 S3 백업(backups/.last-s3-ok — 36시간 넘었거나 없으면 경고, QA-199 —
#      판정은 make status와 같이 쓰는 scripts/vultr/backup-age.sh)
# 어느 단계든 실패하면 0이 아닌 값으로 끝납니다.
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

die() {
    echo "✗ $*" >&2
    exit 1
}

# ---------------------------------------------------------------- 1) 점검
[ "$(basename "$PWD")" = "My_macro_dashboard_v2" ] ||
    die "폴더 이름이 My_macro_dashboard_v2가 아닙니다($(basename "$PWD")). compose 프로젝트·DB 볼륨 이름이 폴더 이름을 따릅니다."
[ -f .env ] || die ".env가 없습니다 — docs/DEVELOPMENT.md '서버 .env 전달'을 보세요."
[ -n "$(find .env -maxdepth 0 -perm 600)" ] || echo "경고: .env 권한이 600이 아닙니다(비밀값) — chmod 600 .env"

# 서버 .env에 적지 않는 이름(.env.vultr.example). 포트 네 줄이 들어오면 로컬 포트(3002…)로 뜨고, LOCAL_NO_LOGIN·FRONTEND_ORIGIN·
# PUBLIC_URL은 compose.vultr.yml이 박아 둔 값이라 적어도 쓰이지 않으며, AWS 공개 주소용 값(ORIGIN_SECRET·GATE_*)은 Vultr에 없는 서비스의 값,
# AWS_INSTANCE_ID·VULTR_*·TAILSCALE_*·TAILNET_DOMAIN은 PC 전용(비밀값이 섞임)입니다. 이름만 봅니다.
unwanted=""
for name in DATABASE_PORT BACKEND_PORT COLLECTOR_PORT FRONTEND_PORT LOCAL_NO_LOGIN FRONTEND_ORIGIN PUBLIC_URL AWS_INSTANCE_ID \
    ORIGIN_SECRET GATE_SECRET GATE_CODES GATE_HOURS TAILNET_DOMAIN 'VULTR_[A-Z0-9_]*' 'TAILSCALE_[A-Z0-9_]*'; do
    found="$(grep -Eo "^[[:space:]]*(export[[:space:]]+)?${name}=" .env | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=$//' | sort -u | tr '\n' ' ')" || true
    [ -z "$found" ] || unwanted="$unwanted ${found% }"
done
[ -z "$unwanted" ] || die "서버 .env에 적지 않는 이름이 있습니다:$unwanted — 그 줄을 지우고 다시 실행하세요(.env.vultr.example)."
if grep -Eq '^[[:space:]]*COOKIE_SECURE=' .env; then
    echo "참고: .env에 COOKIE_SECURE가 있어 기본값(true) 대신 그 값을 씁니다(ADR 0023)."
fi
# 운영본은 이 서버 한 곳이라(ADR 0023 — 2026-11-03 컷오버) 그 줄이 없는 것(켜짐)이 정상입니다. false는 정비 때 일부러 끄는 경우라
# 막지는 않지만, 지우는 것을 잊으면 리스크 점검(스탑)·결정·체결이 조용히 멈추므로 '주의'로 알리고 끝 요약에서 한 번 더 찍습니다(QA-194).
paper_off=
if grep -Eiq '^[[:space:]]*(export[[:space:]]+)?PAPER_ENABLED=[[:space:]]*["'"'"']?(false|0|off|no)' .env; then
    paper_off=1
    echo "주의: .env의 PAPER_ENABLED=false — 운영본의 모의 매매 정기 작업(리스크 점검·결정·체결)이 꺼진 채 뜹니다. 정비가 끝났으면 그 줄을 지우고 다시 배포하세요."
else
    echo "참고: 모의 매매 정기 작업 켜짐(.env에 PAPER_ENABLED=false 없음 — 정기 작업은 이 서버 한 곳에서만)."
fi

# 대화형 셸에서 물려받은 umask(예: .env를 받을 때의 077)로 git이 파일을 0600으로 쓰면 컨테이너(root가 아닌 사용자)가 읽지 못합니다.
umask 022

# ---------------------------------------------------------------- 2) 코드 받기
echo "코드를 받습니다(main)…"
self_before="$(git rev-parse HEAD:scripts/vultr/deploy.sh)"
git fetch --prune --quiet origin
# 추적 중인 파일만 봅니다(.env·backups는 추적하지 않음).
[ -z "$(git status --porcelain --untracked-files=no)" ] ||
    die "서버에서 고친 파일이 있어 받지 않았습니다 — git status로 확인하고 git restore <파일>로 되돌리세요."
git checkout --quiet main
git merge --ff-only --quiet origin/main ||
    die "서버의 main이 origin/main과 갈라져 fast-forward하지 못했습니다 — git log --oneline --graph main origin/main"
# QA-145: 받은 main에서 이 스크립트가 바뀌었으면 새 판으로 처음부터 한 번 다시 돕니다. bash는 이미 연 옛 파일을 끝까지 읽어,
# 새 판의 빌드 목록·단계가 빠진 채 기동합니다(2026-10-30 AWS gate). 다시 돈 판은 받을 것이 없어 여기를 그냥 지나갑니다.
if [ -z "${DEPLOY_REEXEC:-}" ] && [ "$(git rev-parse HEAD:scripts/vultr/deploy.sh)" != "$self_before" ]; then
    echo "  deploy.sh가 바뀌어 받은 새 판으로 다시 돕니다."
    DEPLOY_REEXEC=1 exec bash scripts/vultr/deploy.sh "$@"
fi
# 받은 코드에 Caddyfile이 없으면 docker가 그 자리에 빈 폴더를 만들고 caddy가 뜨지 못합니다.
[ -f deploy/vultr/Caddyfile ] || die "deploy/vultr/Caddyfile이 없습니다 — 받은 main(git log -1)을 확인하세요."

# ---------------------------------------------------------------- 3) 버전
export COMPOSE_FILE=docker-compose.yml:compose.vultr.yml
APP_VERSION="main@$(git rev-parse --short HEAD)"
APP_UPDATED="$(TZ=Asia/Seoul git log -1 --format=%cd --date=format-local:%Y-%m-%d)"
export APP_VERSION APP_UPDATED
echo "  코드: $APP_VERSION (최종 수정 $APP_UPDATED)"

# 실제 매매(ADR 0028) — 꺼져(OFF) 있지 않은 시장 수와 오늘(KST)의 장 시간 변경을 한 줄로 냅니다: "<수>"(변경 없음) | "<수> <개장> <마감>"(모의 설정
# kr.calendar.openTimeOverrides의 오늘 값 — 예 "1 10:00 16:30") | "<수> bad"(그 설정을 읽지 못했거나 모양이 틀림 — 보수 창).
# 시장 수는 LIVE·STOPPING·HALTED를 모두 셉니다(OPS-5) — 끄는 중은 이 기능의 미체결을 취소하고 이상 멈춤도 주기마다 취소를 보내, 그 사이에 백엔드·수집기를
# 다시 만들면 보내던 취소가 끊기고 다시 뜨는 동안 시가 단일가 체결이 일어날 수 있습니다(LIVE만 세던 판은 이때 창 안에서도 통과했음).
# 표가 없으면(V24 전) none, 읽지 못하면(postgres가 꺼짐 등) 빈 값. 값·종목은 읽지 않습니다.
# 장 시간 변경은 백엔드가 그날 옮긴 시각으로 매매하는 조건(모의 달력 = 토스 장 운영 정보 — 명세 §3)과 같은 출처(paper_settings 한 행, 점 경로를
# 중첩 객체로 저장)라 수집기 토큰도 .env도 필요 없습니다. 백엔드가 표 전체를 버리는 모양(날짜 키·개장·마감 HH:mm·개장 < 마감 중 하나라도 틀림 —
# KrPaperMarket.sessionHours)이면 bad. 이 질의만 실패해도 꺼지지 않은 시장 수는 그대로 내도록 그동안만 ON_ERROR_STOP을 끕니다(rt_hours는 bad로 남음).
# DB 이름·계정은 postgres 컨테이너의 환경(compose가 넣은 POSTGRES_USER·POSTGRES_DB)으로 — .env를 읽지 않습니다.
realtrade_state() {
    # shellcheck disable=SC2016  # $POSTGRES_*는 컨테이너 안의 sh가 풉니다
    docker compose exec -T postgres sh -c 'psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null <<'SQL' || true
SELECT to_regclass('public.real_trade_config') IS NOT NULL AS has_real_trade \gset
\if :has_real_trade
\set rt_hours bad
\set ON_ERROR_STOP 0
SELECT coalesce((
    SELECT CASE
        WHEN m IS NULL THEN ''
        WHEN jsonb_typeof(m) <> 'object' THEN 'bad'
        WHEN EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(m) = 'object' THEN m ELSE '{}' END) e
                     WHERE e.key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR jsonb_typeof(e.value) <> 'object'
                        OR coalesce(e.value ->> 'open', '') !~ '^[0-9]{2}:[0-9]{2}$'
                        OR coalesce(e.value ->> 'close', '') !~ '^[0-9]{2}:[0-9]{2}$'
                        OR (e.value ->> 'open') >= (e.value ->> 'close')) THEN 'bad'
        ELSE coalesce((m -> d ->> 'open') || ' ' || (m -> d ->> 'close'), '')
    END
    FROM (SELECT body -> 'kr' -> 'calendar' -> 'openTimeOverrides' AS m,
                 to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS d
          FROM public.paper_settings WHERE id = 1) s), '') AS rt_hours \gset
\set ON_ERROR_STOP 1
SELECT concat_ws(' ', count(*), nullif(:'rt_hours', '')) FROM public.real_trade_config WHERE state <> 'OFF';
\else
SELECT 'none';
\endif
SQL
}
# 한국 거래 창 — 평일 08:45~15:35 KST, 정규장 전체(시가 맞추기 08:50·개장 10분 뒤 맞추기 09:10~09:13·장중 스탑 매도는 장중 아무 때나 3분 창 —
# ADR 0033). 장 시간 변경일(모의 설정 kr.calendar.openTimeOverrides — 예 2026-11-19 수능 10:00~16:30)은 같은 여유로 개장 −15분 ~ 마감 +5분
# (09:45~16:35), 그 설정을 읽지 못했거나 모양이 틀리면 둘을 합친 보수 창(평일 08:45~16:35)입니다. 이 창 안에서 백엔드·수집기를 다시 만들면
# 보내던 주문의 결과를 놓쳐 '모름'(UNKNOWN) 처리·이상 멈춤으로 이어지거나 장중 스탑 매도가 다음 날로 밀릴 수 있습니다. 휴장일도 평일이면 창으로
# 봅니다(넘기려면 REALTRADE_DEPLOY_OK=1).
kr_hhmm() {
    printf '%02d:%02d' $(($1 / 60)) $(($1 % 60))
}
# $1 = realtrade_state의 장 시간 변경 칸(빈 값 | "HH:MM HH:MM" | 그 밖). kr_win(자정부터의 분 — 창 시작·끝)과 알림 글 kr_win_text를 정합니다.
kr_trade_window_for() {
    local hours="$1" re='^([01][0-9]|2[0-3]):[0-5][0-9] ([01][0-9]|2[0-3]):[0-5][0-9]$' open close
    if [ -z "$hours" ]; then
        kr_win=(525 935)
        kr_win_text="평일 08:45~15:35 KST(정규장 전체 — 장중 스탑 매도)"
        return 0
    fi
    if [[ "$hours" =~ $re ]]; then
        open=$((10#${hours:0:2} * 60 + 10#${hours:3:2}))
        close=$((10#${hours:6:2} * 60 + 10#${hours:9:2}))
        if [ "$open" -lt "$close" ]; then
            kr_win=($((open - 15)) $((close + 5)))
            kr_win_text="오늘 장 시간 변경 ${hours% *}~${hours#* } — $(kr_hhmm "${kr_win[0]}")~$(kr_hhmm "${kr_win[1]}") KST(정규장 전체)"
            return 0
        fi
    fi
    kr_win=(525 995)
    kr_win_text="오늘 장 시간 변경(paper_settings의 kr.calendar.openTimeOverrides)을 읽지 못했거나 모양이 틀려 보수 창 — 평일 08:45~16:35 KST"
}
in_kr_trade_window() {
    local now dow hm
    now="$(TZ=Asia/Seoul date '+%u %H%M')"
    dow="${now% *}"
    hm="${now#* }"
    hm=$((10#${hm:0:2} * 60 + 10#${hm:2:2}))
    [ "$dow" -le 5 ] || return 1
    [ "$hm" -ge "${kr_win[0]}" ] && [ "$hm" -le "${kr_win[1]}" ]
}
# $1 = before-build(빌드 전 — 켜짐·읽지 못함도 알림) | before-up(기동 직전 — 창 안일 때만 말함)
realtrade_guard() {
    local out live hours=
    out="$(realtrade_state)"
    case "$out" in *$'\n'*) out= ;; esac   # 여러 줄은 모양이 틀린 응답 — 읽지 못함과 같이 봅니다
    live="${out%% *}"
    [ "$live" = "$out" ] || hours="${out#* }"
    case "$live" in
        none | 0) return 0 ;;
        '' | *[!0-9]*)
            [ "$1" != "before-build" ] ||
                echo "경고: 실제 매매 상태(real_trade_config)를 읽지 못했습니다 — 꺼져 있지 않으면(켜짐·끄는 중·이상 멈춤) 한국 거래 창(평일 08:45~15:35 KST — 정규장 전체, 장 시간 변경일은 개장 −15분 ~ 마감 +5분) 밖에서 배포하세요."
            return 0 ;;
    esac
    kr_trade_window_for "$hours"
    if in_kr_trade_window; then
        if [ "${REALTRADE_DEPLOY_OK:-}" = "1" ]; then
            echo "경고: 실제 매매가 꺼져 있지 않고(켜짐 LIVE·끄는 중 STOPPING·이상 멈춤 HALTED — 미체결 취소도 돎) 지금은 한국 거래 창($kr_win_text)이지만 REALTRADE_DEPLOY_OK=1이라 계속합니다."
            return 0
        fi
        if [ "$1" = "before-build" ]; then
            die "실제 매매가 꺼져 있지 않고(켜짐 LIVE·끄는 중 STOPPING·이상 멈춤 HALTED — 미체결 취소도 돎) 지금은 한국 거래 창($kr_win_text)이라 배포하지 않았습니다 — 창이 지난 뒤 다시 실행하세요(알고 진행할 때만 REALTRADE_DEPLOY_OK=1). 비상 끄기라면 deploy.sh가 아니라 docs/DEVELOPMENT.md §7 비상 끄기(먼저 화면의 끄기, 안 되면 서버 셸의 끄기 한 줄, 그래도 안 되면 TOSS_TRADING_ENABLED=false로 바꾸고 수집기만 다시 만들기)."
        fi
        die "실제 매매가 꺼져 있지 않고(켜짐 LIVE·끄는 중 STOPPING·이상 멈춤 HALTED — 미체결 취소도 돎) 빌드하는 동안 한국 거래 창($kr_win_text)에 들어와 기동하지 않았습니다(빌드·배포 전 덤프까지 함, 돌던 컨테이너 그대로) — 창이 지난 뒤 다시 실행하세요(알고 진행할 때만 REALTRADE_DEPLOY_OK=1). 비상 끄기라면 deploy.sh가 아니라 docs/DEVELOPMENT.md §7 비상 끄기(먼저 화면의 끄기, 안 되면 서버 셸의 끄기 한 줄, 그래도 안 되면 TOSS_TRADING_ENABLED=false로 바꾸고 수집기만 다시 만들기)."
    fi
    [ "$1" != "before-build" ] ||
        echo "참고: 실제 매매 켜짐(LIVE)·끄는 중(STOPPING)·이상 멈춤(HALTED) 가운데 하나 — 기동하는 동안 장중 따라 하기 주문이나 미체결 취소의 결과를 놓칠 수 있어 정규장 밖 배포가 낫습니다(오늘 한국 거래 창: $kr_win_text)."
}
realtrade_guard before-build

# ---------------------------------------------------------------- 4) 빌드(하나씩)
for service in backend frontend collector browser; do
    echo "빌드: $service"
    docker compose build --pull "$service"
done
docker compose pull --quiet caddy postgres

# ---------------------------------------------------------------- 5) 배포 전 덤프(QA-200)
# up이 컨테이너를 바꾸고 수집기가 기동하며 새 마이그레이션을 적용하기 전의 DB를 한 번 떠 둡니다. 배포가 장부를 망가뜨린 것을 곧바로
# 알아채면 그날 08:00 정기 백업이 아니라 이 시점으로 되돌릴 수 있습니다(make restore F=… — 그 뒤 쌓인 행도 함께 되돌아감).
# 접두어가 달라 정기 백업(macrodash-…, S3로 올리는 것)·복원 전 백업(pre-restore-…)의 정리와 섞이지 않고, 접두어별로 BACKUP_KEEP개(기본 10)만 남습니다.
# pg_dump는 일관된 스냅숏이라 정기 작업이 쓰는 중에 떠도 됩니다. postgres가 떠 있지 않으면(새 서버의 첫 배포, 손으로 down한 뒤) 그것만 먼저 띄웁니다.
echo "배포 전 DB 덤프(backups/pre-deploy-…)…"
if ! docker compose exec -T postgres true >/dev/null 2>&1; then
    docker compose up -d --no-build --wait --wait-timeout 120 postgres ||
        die "postgres를 띄우지 못해 배포 전 덤프를 뜨지 못했습니다 — 배포하지 않았습니다(docker compose logs postgres)."
fi
bash scripts/db-backup.sh pre-deploy ||
    die "배포 전 DB 덤프에 실패해 배포하지 않았습니다(돌던 컨테이너 그대로) — 위 메시지와 df -h를 보세요."

# ---------------------------------------------------------------- 6) 기동·스키마
# 빌드가 몇 분 걸려 그 사이 거래 창에 들어왔을 수 있습니다 — 컨테이너를 바꾸기 직전에 한 번 더 봅니다(3의 실제 매매 가드).
realtrade_guard before-up
echo "기동합니다(건강해질 때까지 최대 5분)…"
docker compose up -d --no-build --wait --wait-timeout 300

# make migrate와 같은 반복. 수집기는 기동할 때만 스키마를 적용해, 스키마와 백엔드만 바뀐 배포에서는 새 스키마가
# 빠집니다(QA-016). 10번 모두 실패하면 경고와 0이 아닌 값(QA-118).
ok=
for i in 1 2 3 4 5 6 7 8 9 10; do
    docker compose exec -T collector python -c "from app import store; store.init_schema()" >/dev/null 2>&1 && { ok=1; break; }
    sleep 3
done
[ -n "$ok" ] || { echo "경고: 스키마를 적용하지 못했습니다 — docker compose logs collector를 보세요." >&2; exit 1; }
echo "  스키마: 최신 (db/migrations)"
# Caddyfile은 파일 하나를 bind mount해, git이 새 파일로 바꿔도 돌던 컨테이너는 옛 내용을 계속 봅니다 — 늘 다시 만듭니다(앞단만 1초 안팎 끊김).
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 60 caddy

# ---------------------------------------------------------------- 7) 정리
# 다시 빌드할 때마다 이름 없는 옛 이미지가 남습니다(128 GB 디스크지만 쌓이면 끝이 없음). 빌드 캐시는 다음 빌드를 빠르게 하므로 일주일 넘은 것만.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null

echo ""
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo ""
echo "✓ 배포했습니다: $APP_VERSION — tailnet 안에서 https://my-macro-app.<tailnet>.ts.net(서버 .env의 PUBLIC_ORIGIN)"
echo "   디스크: $(df -P / | awk 'NR == 2 {print $5}') 사용"
# QA-199: 서버 밖 사본(S3 db/vultr/)을 마지막으로 올린 뒤의 나이 — 36시간 넘었거나 기록이 없으면 경고. 판정은 make status와 같이 쓰는
# backup-age.sh 한 곳에 있습니다(cron이 빠지면 텔레그램 알림도 없어 여기와 make status에서 봄).
bash scripts/vultr/backup-age.sh
[ -z "$paper_off" ] ||
    echo "주의: 모의 매매 정기 작업이 꺼진 채 떴습니다(.env의 PAPER_ENABLED=false) — 정비가 끝났으면 그 줄을 지우고 다시 배포하세요."
