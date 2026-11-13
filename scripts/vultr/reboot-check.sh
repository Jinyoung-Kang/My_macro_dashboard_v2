#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/reboot-check.sh — Vultr 서버에 재부팅이 필요한지, Livepatch가 제대로 도는지 봅니다(ADR 0023 개정 2026-11-12).
#
# 자동 보안 업데이트는 커널을 설치만 하고 재부팅하지 않습니다(매매 시각을 피해 사람이 재부팅). Livepatch(Ubuntu Pro)가 긴급 커널 패치를
# 재부팅 없이 막지만 모든 커널 수정을 덮지는 않고, 지금 커널의 Livepatch 지원 기한(UpgradeRequiredDate)이 지나면 새 커널로 재부팅해야
# 이어집니다. 이 스크립트가 그 신호를 모읍니다:
#   · /var/run/reboot-required(패키지 목록은 .pkgs)가 있음
#   · Livepatch가 지금 커널을 지원하지 않음, 점검·적용이 실패함, 지원 기한이 30일 안이거나 지남, 마지막 점검이 48시간보다 오래됨,
#     상태를 읽지 못함(canonical-livepatch 없음 등)
#
# 사용(저장소 최상위로 옮겨 .env·backups/를 봄):
#   bash scripts/vultr/reboot-check.sh                       cron — 걸린 것이 있으면 운영 텔레그램 봇으로 한 통(한 줄 요약 + 할 일 '실행:',
#                                                            같은 KST 날짜에 같은 글은 다시 보내지 않음), 없으면 syslog에만. 늘 0으로 끝남
#   bash scripts/vultr/reboot-check.sh --summary             한 줄만 찍음(deploy.sh 끝 요약 — 서버에서만 돎)
#   bash scripts/vultr/reboot-check.sh --summary-if-server   서버(.env의 COMPOSE_FILE에 compose.vultr.yml)일 때만 한 줄(make status —
#                                                            PC에는 Livepatch가 없어 늘 경고가 되므로 찍지 않음)
#
# cron(서버의 ubuntu 사용자, 서버 시간대는 UTC): 매일 07:10 UTC = 16:10 KST(한국 장이 끝난 뒤 — 권장 재부팅 시각 16:00~22:00의 앞):
#   10 7 * * * /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/reboot-check.sh
# 결과는 syslog(태그 my-macro-reboot-check):  journalctl -t my-macro-reboot-check
# 텔레그램은 backup-s3.sh와 같은 운영 봇(TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID)이고, 토큰·채팅 ID는 curl 설정(stdin)으로 넘겨 인자에 남기지 않습니다.
# 시험은 재부팅 표시 경로를 REBOOT_REQUIRED_FILE로 바꿉니다.
# =============================================================================
set -euo pipefail

# cron의 PATH는 /usr/bin:/bin뿐입니다 — canonical-livepatch는 snap(/snap/bin)입니다(뒤에 덧붙여 앞선 PATH가 먼저).
export PATH="${PATH:+$PATH:}/snap/bin:/usr/local/bin:/usr/bin:/bin"
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # env_file_value · BACKUP_DIR, 저장소 최상위로 이동

tag=my-macro-reboot-check
mode="${1:-}"
case "$mode" in
    '' | --summary) ;;
    --summary-if-server)
        case ":$(env_file_value COMPOSE_FILE):" in *:compose.vultr.yml:*) ;; *) exit 0 ;; esac ;;
    *) echo "사용: bash scripts/vultr/reboot-check.sh [--summary | --summary-if-server]" >&2; exit 2 ;;
esac

reasons=()
needs_reboot=""

# 1. 재부팅 표시 — 패키지 이름은 앞의 여덟 개까지.
flag="${REBOOT_REQUIRED_FILE:-/var/run/reboot-required}"
if [ -e "$flag" ]; then
    needs_reboot=1
    pkgs="$( (sort -u "$flag.pkgs" 2>/dev/null || true) | sed '/^$/d' | head -n 8 | paste -sd, - | sed 's/,/, /g')"
    reasons+=("재부팅 필요${pkgs:+(패키지: $pkgs)}")
fi

# 2. Livepatch — 지금 돌고 있는 커널의 항목(없으면 첫 항목)을 봅니다. 판정은 아래 python 한 곳.
livepatch_ok=""
livepatch_issue=""
# QA-417: 2026-11-13 16:10 KST cron에서 status가 한 번 실패했고(원인 미확인 — 그때는 오류를 버렸음) 바로 뒤에는 늘 읽혔습니다.
# 세 번까지(사이 REBOOT_CHECK_RETRY_SECONDS초, 기본 10) 다시 묻고, 끝내 못 읽으면 마지막 오류의 첫 줄을 사유에 남깁니다.
lp_json=""
lp_err=""
if command -v canonical-livepatch >/dev/null 2>&1; then
    err_file="$(mktemp)"
    trap 'rm -f "$err_file"' EXIT
    for attempt in 1 2 3; do
        if lp_json="$(canonical-livepatch status --format json 2>"$err_file")"; then
            lp_err=""
            break
        fi
        lp_json=""
        lp_err="$(head -n 1 "$err_file" | tr -d '\r' | cut -c1-120)"
        [ "$attempt" = 3 ] || sleep "${REBOOT_CHECK_RETRY_SECONDS:-10}"
    done
fi
if ! command -v canonical-livepatch >/dev/null 2>&1; then
    reasons+=("Livepatch 상태를 읽지 못함(canonical-livepatch 없음 — pro status를 보세요)")
    livepatch_issue=1
elif [ -z "$lp_json" ]; then
    reasons+=("Livepatch 상태를 읽지 못함(canonical-livepatch status 3번 실패${lp_err:+: $lp_err} — pro status를 보세요)")
    livepatch_issue=1
else
    lp_out="$(LP_JSON="$lp_json" python3 - <<'PY' 2>/dev/null
import json, os
from datetime import date, datetime, timezone

try:
    data = json.loads(os.environ["LP_JSON"])
    entries = data.get("Status") or []
    entry = next((e for e in entries if e.get("Running")), entries[0])
except Exception:
    print("WARN\tLivepatch 상태를 읽지 못함(응답 모양이 다름)")
    raise SystemExit(0)

kernel = entry.get("Kernel") or "?"
supported = entry.get("Supported") or ""
patch = entry.get("Livepatch") or {}
check_state, state = patch.get("CheckState") or "", patch.get("State") or ""
warn = []
if supported != "supported":
    warn.append(f"Livepatch가 지금 커널({kernel})을 지원하지 않음({supported or '모름'})")
if "fail" in check_state or "fail" in state:
    warn.append(f"Livepatch 실패(점검 {check_state or '?'} · 적용 {state or '?'})")
due = entry.get("UpgradeRequiredDate") or ""
if due:
    try:
        left = (date.fromisoformat(due) - datetime.now(timezone.utc).date()).days
        if left < 0:
            warn.append(f"Livepatch 지원 기한이 지남({due} — 새 커널로 재부팅 필요)")
        elif left <= 30:
            warn.append(f"Livepatch 지원 기한 임박({due}, {left}일 남음 — 새 커널로 재부팅 필요)")
    except ValueError:
        pass
last = data.get("Last-Check") or ""
if last:
    try:
        hours = (datetime.now(timezone.utc) - datetime.fromisoformat(last.replace("Z", "+00:00"))).total_seconds() / 3600
        if hours > 48:
            warn.append(f"Livepatch 마지막 점검이 {int(hours)}시간 전")
    except ValueError:
        pass
for line in warn:
    print("WARN\t" + line)
if not warn:
    print(f"OK\tLivepatch 정상(커널 {kernel}{', 기한 ' + due if due else ''})")
PY
)" || true
    [ -n "$lp_out" ] || lp_out=$'WARN\tLivepatch 상태를 읽지 못함(판정 실패)'
    while IFS=$'\t' read -r kind text; do
        case "$kind" in
            OK) livepatch_ok="$text" ;;
            WARN)
                reasons+=("$text")
                case "$text" in *"새 커널로 재부팅"*) needs_reboot=1 ;; *) livepatch_issue=1 ;; esac ;;
        esac
    done <<< "$lp_out"
fi

if [ "${#reasons[@]}" -eq 0 ]; then
    summary="재부팅 필요 없음 · $livepatch_ok"
else
    summary="경고: $(printf '%s; ' "${reasons[@]}")"
    summary="${summary%; }"
    if [ -n "$needs_reboot" ]; then
        summary+=" — 재부팅은 16:00~22:00 KST에(한국 장·한국 결정 22:30·미국 장 23:30을 피함, DEVELOPMENT §7 '재부팅 뒤 확인')"
    else
        summary+=" — DEVELOPMENT §7 '재부팅 뒤 확인'"
    fi
fi

if [ "$mode" != "" ]; then
    echo "$summary"
    exit 0
fi

# cron — 걸린 것이 없으면 syslog에만 남깁니다.
if [ "${#reasons[@]}" -eq 0 ]; then
    logger -t "$tag" "점검: $summary" || true
    exit 0
fi
logger -t "$tag" -p user.warning "점검: $summary" || true

# 같은 KST 날짜에 같은 글은 한 번만(손으로 다시 돌려도 겹쳐 보내지 않음). 보낸 뒤에만 남깁니다.
sent="$BACKUP_DIR/.reboot-check-sent"
stamp="$(TZ=Asia/Seoul date +%F) $(printf '%s' "$summary" | md5sum | cut -c1-16)"
if [ "$(cat "$sent" 2>/dev/null || true)" = "$stamp" ]; then
    logger -t "$tag" "오늘 같은 알림을 이미 보냄 — 건너뜀" || true
    exit 0
fi

# 운영 알림에는 할 일을 함께 적습니다(2026-11-13 사용자 요청 — 받은 사람이 그대로 따라 할 수 있게). 한 줄 요약(--summary)은 그대로입니다.
actions=""
if [ -n "$needs_reboot" ]; then
    actions+=$'\n\n실행(재부팅 — 16:00~22:00 KST):'
    actions+=$'\n1. Vultr 화면 > my-macro-app > Server > Restart'
    actions+=$'\n   또는 셸: ssh ubuntu@my-macro-app 다음 sudo reboot'
    actions+=$'\n2. 1~2분 뒤 셸에서 확인:'
    actions+=$'\n   cd ~/My_macro_dashboard_v2 && getent hosts api.telegram.org && docker compose ps && bash scripts/vultr/reboot-check.sh --summary'
    actions+=$'\n3. 2의 첫 줄(주소)이 비면 DNS 복구(QA-415):'
    actions+=$'\n   sudo bash scripts/vultr/tailscale-up.sh && docker compose restart backend collector frontend browser caddy'
fi
if [ -n "$livepatch_issue" ]; then
    actions+=$'\n\n실행(Livepatch 확인):'
    actions+=$'\n   셸: ssh ubuntu@my-macro-app 다음 canonical-livepatch status; pro status'
    actions+=$'\n   다음 날 점검에서 사라지면 할 일 없음.'
fi
if [ -n "$needs_reboot" ]; then
    actions+=$'\n\n직접 하기 어려우면 Claude Code에 "재부팅해 줘"라고 하면 됩니다.'
else
    actions+=$'\n\n직접 하기 어려우면 Claude Code에 "Livepatch 확인해 줘"라고 하면 됩니다.'
fi

token="$(env_file_value TELEGRAM_BOT_TOKEN)"
chat="$(env_file_value TELEGRAM_CHAT_ID)"
if [ -z "$token" ] || [ -z "$chat" ] || [[ "$token$chat" =~ [[:space:]\"\\] ]] || ! command -v curl >/dev/null 2>&1; then
    logger -t "$tag" -p user.warning "텔레그램 값이 없어 알리지 않음" || true
    exit 0
fi
if printf 'url = "https://api.telegram.org/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\n' "$token" "$chat" |
        curl -sS --fail -o /dev/null --max-time 10 -K - --data-urlencode "text=my-macro 서버 — $summary$actions" >/dev/null 2>&1; then
    { mkdir -p "$BACKUP_DIR" && printf '%s\n' "$stamp" > "$sent"; } || logger -t "$tag" -p user.warning "보낸 기록을 남기지 못함" || true
else
    logger -t "$tag" -p user.warning "텔레그램 알림을 보내지 못함 — 다음 실행에 다시" || true
fi
exit 0
