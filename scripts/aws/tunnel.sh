#!/usr/bin/env bash
# =============================================================================
# scripts/aws/tunnel.sh — PC에서 AWS 개인용 서버의 화면을 엽니다(ADR 0019).
#
#   bash scripts/aws/tunnel.sh        → 브라우저 http://localhost:8201 (로그인: OWNER_EMAIL). Ctrl-C로 닫습니다.
#
# SSM 포트 포워딩: 이 PC의 127.0.0.1:8201 → 서버의 Caddy(127.0.0.1:8201). 서버는 인바운드 포트를 하나도 열지 않습니다.
# 필요한 것: aws CLI v2 + session-manager-plugin, `aws login`으로 로그인해 둔 세션, .env의 AWS_INSTANCE_ID(서버 인스턴스 ID,
# 환경변수가 먼저). 리전은 AWS_REGION(기본 ap-northeast-2).
# 세션이 끊기면(유휴 제한·네트워크) 3초 뒤 다시 잇습니다. 끊긴 뒤 AWS에 닿지 않으면 1분 동안 기다려 보고(잠자기·와이파이 전환),
# 그래도 안 되면(로그인 만료·네트워크 없음) 멈춥니다. 연결이 연달아 곧바로 끊겨도(서버 꺼짐) 멈춥니다.
# =============================================================================
set -euo pipefail

# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # env_file_value(.env 한 줄 읽기), 저장소 최상위로 이동

PORT=8201
REGION="${AWS_REGION:-ap-northeast-2}"
QUICK_FAIL_SECONDS=10   # 이보다 빨리 끝난 세션은 '연결 실패'로 셉니다
MAX_QUICK_FAILS=5
SIGN_IN_RETRIES=6       # 끊긴 뒤 로그인 확인을 10초 간격으로 몇 번 더 할지(약 1분)

die() {
    echo "✗ $*" >&2
    exit 1
}

instance="${AWS_INSTANCE_ID:-$(env_file_value AWS_INSTANCE_ID)}"
[ -n "$instance" ] || die ".env에 AWS_INSTANCE_ID(서버 인스턴스 ID, i-로 시작)가 없습니다."
[[ "$instance" =~ ^i-[0-9a-f]{8,17}$ ]] || die "AWS_INSTANCE_ID가 인스턴스 ID 모양(i-0123…)이 아닙니다."
command -v aws >/dev/null || die "aws CLI가 없습니다(v2 필요)."
command -v session-manager-plugin >/dev/null || die "session-manager-plugin이 없습니다 — AWS 문서의 'Session Manager plugin 설치'."
signed_in() { aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; }
signed_in || die "AWS에 로그인돼 있지 않습니다 — aws login 뒤 다시 실행하세요."
# 서버는 매일 21:55~08:00 KST(토 ~10:00)에만 켜져 있습니다. 꺼져 있으면 붙지 못하고 곧바로 끊기기만 하므로 먼저 알립니다.
state="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$instance" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null)" || state=""
case "$state" in
    stopped|stopping)
        die "서버가 꺼져 있습니다($state) — 정기 가동은 매일 21:55~08:00 KST(토 ~10:00). 지금 보려면 bash scripts/aws/instance.sh start" ;;
    pending) echo "서버가 켜지는 중입니다 — 컨테이너가 뜨는 1~2분 동안은 연결이 끊겼다 다시 이어질 수 있습니다." ;;
esac
# 이미 다른 터널(또는 다른 프로그램)이 이 포트를 쓰면 새 터널은 바로 실패합니다.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    die "이 PC의 $PORT 포트를 이미 쓰고 있습니다 — 열려 있는 터널이 있으면 그 창에서 http://localhost:$PORT 를 쓰세요."
fi

trap 'echo ""; echo "터널을 닫았습니다."; exit 0' INT TERM

echo ""
echo "  화면: http://localhost:$PORT   (로그인: OWNER_EMAIL · 닫기: Ctrl-C)"
echo "  서버: $instance ($REGION)"
echo ""

quick_fails=0
while true; do
    started=$SECONDS
    aws ssm start-session --region "$REGION" --target "$instance" \
        --document-name AWS-StartPortForwardingSession \
        --parameters "{\"portNumber\":[\"$PORT\"],\"localPortNumber\":[\"$PORT\"]}" || true
    lasted=$((SECONDS - started))   # 아래 로그인 확인을 기다린 시간은 빼고 셉니다
    # 로그인 만료와 네트워크 끊김은 sts 실패로 똑같이 보입니다 — 잠깐 기다려 네트워크가 돌아오면 이어 갑니다.
    tries=0
    until signed_in; do
        tries=$((tries + 1))
        [ "$tries" -le "$SIGN_IN_RETRIES" ] ||
            die "AWS에 닿지 않습니다 — 로그인이 만료됐거나 네트워크가 끊겼습니다. aws sts get-caller-identity로 확인하고, 필요하면 aws login 뒤 다시 실행하세요."
        echo "AWS에 닿지 않습니다 — 10초 뒤 다시 확인합니다($tries/$SIGN_IN_RETRIES)." >&2
        sleep 10
    done
    if [ "$lasted" -lt "$QUICK_FAIL_SECONDS" ]; then
        quick_fails=$((quick_fails + 1))
        [ "$quick_fails" -lt "$MAX_QUICK_FAILS" ] ||
            die "연결이 ${MAX_QUICK_FAILS}번 연달아 곧바로 끊겼습니다 — 서버가 꺼져 있거나 SSM 에이전트가 연결되지 않았습니다(bash scripts/aws/instance.sh status)."
    else
        quick_fails=0
    fi
    echo "터널이 끊겼습니다 — 3초 뒤 다시 잇습니다(닫기: Ctrl-C)." >&2
    sleep 3
done
