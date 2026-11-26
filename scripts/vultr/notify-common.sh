# shellcheck shell=bash
# =============================================================================
# scripts/vultr/notify-common.sh — 서버 스크립트가 운영 텔레그램 봇으로 한 통 보낼 때 source하는 공용 함수(ADR 0023). 혼자 실행하지 않습니다
# (scripts/db-common.sh처럼 — bash 옵션은 부르는 스크립트의 set -euo pipefail을 따름).
#
# 먼저 scripts/db-common.sh를 source해 env_file_value가 있어야 합니다(.env의 TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID — reboot-check.sh·
# backup-s3.sh와 같은 운영 봇, 같은 이름).
#
#   notify_telegram <글>
#     0  보냄
#     1  보내지 못함(curl이 실패 — 네트워크·텔레그램 응답)
#     2  보낼 수 없음(토큰·채팅 ID가 비었거나 curl 설정의 따옴표 값에 넣을 수 없는 글자가 있음, curl 없음)
#   set -e 아래에서는 if·case·|| 안에서 부릅니다. 아무것도 찍지 않고 syslog에도 남기지 않습니다 — 남길 글은 부르는 쪽이 정합니다.
#
# 토큰·채팅 ID는 curl 설정(stdin, -K -)으로 넘겨 명령 인자(서버의 프로세스 목록)·로그에 남기지 않고, curl의 출력도 버립니다
# (오류 글에 주소 — 토큰이 든 경로 — 가 실릴 수 있음). 글은 인자로 갑니다 — 비밀값·실제 계좌 자료를 글에 넣지 않습니다.
# 지금 쓰는 곳: disk-check.sh. reboot-check.sh·backup-s3.sh는 같은 방식의 자기 코드를 그대로 씁니다(2026-11-27 — 옮기지 않음).
# =============================================================================

notify_telegram() {
    local token chat
    token="$(env_file_value TELEGRAM_BOT_TOKEN)"
    chat="$(env_file_value TELEGRAM_CHAT_ID)"
    if [ -z "$token" ] || [ -z "$chat" ]; then return 2; fi
    # curl 설정의 따옴표 값에 그대로 넣을 수 없는 글자가 있으면 보내지 않습니다(정상 토큰·채팅 ID에는 없음).
    if [[ "$token$chat" =~ [[:space:]\"\\] ]]; then return 2; fi
    command -v curl >/dev/null 2>&1 || return 2
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\n' "$token" "$chat" |
        curl -sS --fail -o /dev/null --max-time 10 -K - --data-urlencode "text=$1" >/dev/null 2>&1 || return 1
    return 0
}
