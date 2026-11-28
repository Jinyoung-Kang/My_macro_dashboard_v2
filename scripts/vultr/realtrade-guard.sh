# shellcheck shell=bash
# =============================================================================
# scripts/vultr/realtrade-guard.sh — 실제 매매 가드(ADR 0028·0033, OPS-5) 함수. scripts/vultr/deploy.sh에서 옮겼습니다(2026-11-28 — 주간 유지보수
# scripts/vultr/maintenance.sh도 같은 판정을 씀). 혼자 실행하지 않고 source합니다(scripts/db-common.sh처럼 — bash 옵션은 부르는 스크립트를 따름).
#
# 부르는 쪽이 할 일: 저장소 최상위로 옮겨 있고, COMPOSE_FILE(Vultr 덧붙임)을 내보내고, die(글을 stderr에 찍고 0이 아닌 값으로 끝냄)를 정의합니다.
#   realtrade_guard before-fetch | before-build | before-up    판정·문구는 아래 함수 주석
# =============================================================================

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
# $1 = before-fetch(코드를 받기 전 — 창 안일 때만 말함, QA-1015) | before-build(빌드 전 — 켜짐·읽지 못함도 알림) | before-up(기동 직전 — 창 안일 때만 말함)
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
        if [ "$1" = "before-fetch" ]; then
            die "실제 매매가 꺼져 있지 않고(켜짐 LIVE·끄는 중 STOPPING·이상 멈춤 HALTED — 미체결 취소도 돎) 지금은 한국 거래 창($kr_win_text)이라 코드를 받기 전에 멈췄습니다(서버 폴더와 돌던 컨테이너 그대로) — 창이 지난 뒤 다시 실행하세요(알고 진행할 때만 REALTRADE_DEPLOY_OK=1). 비상 끄기라면 deploy.sh가 아니라 docs/DEVELOPMENT.md §7 비상 끄기(먼저 화면의 끄기, 안 되면 서버 셸의 끄기 한 줄, 그래도 안 되면 TOSS_TRADING_ENABLED=false로 바꾸고 수집기만 다시 만들기)."
        fi
        if [ "$1" = "before-build" ]; then
            die "실제 매매가 꺼져 있지 않고(켜짐 LIVE·끄는 중 STOPPING·이상 멈춤 HALTED — 미체결 취소도 돎) 지금은 한국 거래 창($kr_win_text)이라 배포하지 않았습니다 — 창이 지난 뒤 다시 실행하세요(알고 진행할 때만 REALTRADE_DEPLOY_OK=1). 비상 끄기라면 deploy.sh가 아니라 docs/DEVELOPMENT.md §7 비상 끄기(먼저 화면의 끄기, 안 되면 서버 셸의 끄기 한 줄, 그래도 안 되면 TOSS_TRADING_ENABLED=false로 바꾸고 수집기만 다시 만들기)."
        fi
        die "실제 매매가 꺼져 있지 않고(켜짐 LIVE·끄는 중 STOPPING·이상 멈춤 HALTED — 미체결 취소도 돎) 빌드하는 동안 한국 거래 창($kr_win_text)에 들어와 기동하지 않았습니다(빌드·배포 전 덤프까지 함, 돌던 컨테이너 그대로) — 창이 지난 뒤 다시 실행하세요(알고 진행할 때만 REALTRADE_DEPLOY_OK=1). 비상 끄기라면 deploy.sh가 아니라 docs/DEVELOPMENT.md §7 비상 끄기(먼저 화면의 끄기, 안 되면 서버 셸의 끄기 한 줄, 그래도 안 되면 TOSS_TRADING_ENABLED=false로 바꾸고 수집기만 다시 만들기)."
    fi
    [ "$1" != "before-build" ] ||
        echo "참고: 실제 매매 켜짐(LIVE)·끄는 중(STOPPING)·이상 멈춤(HALTED) 가운데 하나 — 기동하는 동안 장중 따라 하기 주문이나 미체결 취소의 결과를 놓칠 수 있어 정규장 밖 배포가 낫습니다(오늘 한국 거래 창: $kr_win_text)."
}
