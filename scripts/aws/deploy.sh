#!/usr/bin/env bash
# =============================================================================
# scripts/aws/deploy.sh — AWS 개인용 서버(EC2 my-macro-app)에서 main을 받아 다시 빌드·기동합니다(ADR 0019).
# 서버에서는 make up 대신 이것을 씁니다.
#
# 사용(서버 셸 — PC에서 aws ssm start-session으로 붙은 뒤 `sudo -iu ubuntu`):
#   bash ~/My_macro_dashboard_v2/scripts/aws/deploy.sh
#
# 순서
#   1. 점검: 폴더 이름(My_macro_dashboard_v2 — compose 프로젝트·DB 볼륨 이름이 폴더 이름을 따름), .env가 있고
#      서버에 적지 않는 이름(포트 네 줄 등, .env.aws.example)이 없는지. 값은 읽지도 찍지도 않습니다.
#   2. git fetch → main 체크아웃 → origin/main으로 fast-forward. 서버에서 고친 파일이 있거나 갈라졌으면 멈춥니다.
#      받은 main에서 이 스크립트가 바뀌었으면 새 판으로 처음부터 한 번 다시 돕니다(QA-145).
#   3. 화면 왼쪽 아래 버전(APP_VERSION·APP_UPDATED)
#   4. 이미지를 하나씩 빌드: backend → frontend → collector → gate(베이스 이미지 보안 패치까지 --pull).
#      CloudFront 원본용 대역 파일(deploy/aws/trusted_proxies.caddy)을 새로 받음 — 못 받으면 지난 파일로(없으면 멈춤, ADR 0019 결정 16)
#      4 GiB라 동시에 빌드하면 메모리가 모자랍니다(make up은 한꺼번에 빌드). caddy·postgres 이미지도 새로 받습니다.
#   5. up -d(건강해질 때까지 기다림) → 스키마 적용(make migrate와 같은 반복 — QA-016·QA-118) → caddy 다시 만들기(바뀐 Caddyfile)
#   6. 매달린 이미지·오래된 빌드 캐시 정리
# 어느 단계든 실패하면 0이 아닌 값으로 끝납니다.
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

die() {
    echo "❌ $*" >&2
    exit 1
}

# ---------------------------------------------------------------- 1) 점검
[ "$(basename "$PWD")" = "My_macro_dashboard_v2" ] ||
    die "폴더 이름이 My_macro_dashboard_v2가 아닙니다($(basename "$PWD")). compose 프로젝트·DB 볼륨 이름이 폴더 이름을 따릅니다."
[ -f .env ] || die ".env가 없습니다 — docs/DEVELOPMENT.md '서버 .env 전달'을 보세요."
[ -n "$(find .env -maxdepth 0 -perm 600)" ] || echo "⚠️  .env 권한이 600이 아닙니다(비밀값) — chmod 600 .env"

# 서버 .env에 적지 않는 이름(.env.aws.example). 포트 네 줄이 들어오면 로컬 포트(3002…)로 뜨고, 나머지는
# compose.aws.yml이 박아 둔 값이라 적어도 쓰이지 않아 헷갈리기만 합니다. 이름만 봅니다.
unwanted=""
for name in DATABASE_PORT BACKEND_PORT COLLECTOR_PORT FRONTEND_PORT LOCAL_NO_LOGIN FRONTEND_ORIGIN PUBLIC_URL AWS_INSTANCE_ID; do
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${name}=" .env; then
        unwanted="$unwanted $name"
    fi
done
[ -z "$unwanted" ] || die "서버 .env에 적지 않는 이름이 있습니다:$unwanted — 그 줄을 지우고 다시 실행하세요(.env.aws.example)."
if grep -Eq '^[[:space:]]*COOKIE_SECURE=' .env; then
    echo "ℹ️  .env에 COOKIE_SECURE가 있어 기본값(true) 대신 그 값을 씁니다(ADR 0019)."
fi
if grep -Eiq '^[[:space:]]*(export[[:space:]]+)?PAPER_ENABLED=[[:space:]]*["'"'"']?(false|0|off|no)' .env; then
    echo "ℹ️  .env의 PAPER_ENABLED=false — 🧪 모의 매매 정기 작업이 꺼진 채 뜹니다."
fi

# 대화형 셸에서 물려받은 umask(예: .env를 받을 때의 077)로 git이 파일을 0600으로 쓰면 컨테이너(root가 아닌 사용자)가 읽지 못합니다.
umask 022

# ---------------------------------------------------------------- 2) 코드 받기
echo "코드를 받습니다(main)…"
self_before="$(git rev-parse HEAD:scripts/aws/deploy.sh)"
git fetch --prune --quiet origin
# 추적 중인 파일만 봅니다(.env·backups는 추적하지 않음).
[ -z "$(git status --porcelain --untracked-files=no)" ] ||
    die "서버에서 고친 파일이 있어 받지 않았습니다 — git status로 확인하고 git restore <파일>로 되돌리세요."
git checkout --quiet main
git merge --ff-only --quiet origin/main ||
    die "서버의 main이 origin/main과 갈라져 fast-forward하지 못했습니다 — git log --oneline --graph main origin/main"
# QA-145: 받은 main에서 이 스크립트가 바뀌었으면 새 판으로 처음부터 한 번 다시 돕니다. bash는 이미 연 옛 파일을 끝까지 읽어,
# 새 판의 빌드 목록·단계가 빠진 채 기동합니다(2026-10-30 gate). 다시 돈 판은 받을 것이 없어 여기를 그냥 지나갑니다.
if [ -z "${DEPLOY_REEXEC:-}" ] && [ "$(git rev-parse HEAD:scripts/aws/deploy.sh)" != "$self_before" ]; then
    echo "  deploy.sh가 바뀌어 받은 새 판으로 다시 돕니다."
    DEPLOY_REEXEC=1 exec bash scripts/aws/deploy.sh "$@"
fi
# 받은 코드에 Caddyfile이 없으면 docker가 그 자리에 빈 폴더를 만들고 caddy가 뜨지 못합니다.
[ -f deploy/aws/Caddyfile ] || die "deploy/aws/Caddyfile이 없습니다 — 받은 main(git log -1)을 확인하세요."

# ---------------------------------------------------------------- 3) 버전
export COMPOSE_FILE=docker-compose.yml:compose.aws.yml
APP_VERSION="main@$(git rev-parse --short HEAD)"
APP_UPDATED="$(TZ=Asia/Seoul git log -1 --format=%cd --date=format-local:%Y-%m-%d)"
export APP_VERSION APP_UPDATED
echo "  코드: $APP_VERSION (최종 수정 $APP_UPDATED)"

# ---------------------------------------------------------------- 4) 빌드(하나씩)
for service in backend frontend collector gate; do
    echo "빌드: $service"
    docker compose build --pull "$service"
done
docker compose pull --quiet caddy postgres

# 공개 주소(:8301)의 Caddy는 이 대역이 보낸 X-Forwarded-For만 믿습니다. AWS가 대역을 바꾸므로 배포 때마다 새로 받습니다.
if ! bash scripts/aws/update-cloudfront-ranges.sh; then
    [ -s deploy/aws/trusted_proxies.caddy ] ||
        die "CloudFront 대역 파일을 만들지 못했습니다(deploy/aws/trusted_proxies.caddy) — scripts/aws/update-cloudfront-ranges.sh"
    echo "⚠️  CloudFront 대역을 새로 받지 못해 지난 파일을 씁니다."
fi

# ---------------------------------------------------------------- 5) 기동·스키마
echo "기동합니다(건강해질 때까지 최대 5분)…"
docker compose up -d --no-build --wait --wait-timeout 300

# make migrate와 같은 반복. 수집기는 기동할 때만 스키마를 적용해, 스키마와 백엔드만 바뀐 배포에서는 새 스키마가
# 빠집니다(QA-016). 10번 모두 실패하면 ⚠️와 0이 아닌 값(QA-118).
ok=
for i in 1 2 3 4 5 6 7 8 9 10; do
    docker compose exec -T collector python -c "from app import store; store.init_schema()" >/dev/null 2>&1 && { ok=1; break; }
    sleep 3
done
[ -n "$ok" ] || { echo "⚠️  스키마를 적용하지 못했습니다 — docker compose logs collector를 보세요." >&2; exit 1; }
echo "  스키마: 최신 (db/migrations)"
# Caddyfile은 파일 하나를 bind mount해, git이 새 파일로 바꿔도 돌던 컨테이너는 옛 내용을 계속 봅니다 — 늘 다시 만듭니다(앞단만 1초 안팎 끊김).
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 60 caddy

# ---------------------------------------------------------------- 6) 정리
# 다시 빌드할 때마다 이름 없는 옛 이미지가 남습니다(30 GB 디스크). 빌드 캐시는 다음 빌드를 빠르게 하므로 일주일 넘은 것만.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null

echo ""
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo ""
echo "✅ 배포했습니다: $APP_VERSION — 공개 주소(CloudFront, 잠금화면) 또는 PC에서 bash scripts/aws/tunnel.sh → http://localhost:8201"
echo "   디스크: $(df -P / | awk 'NR == 2 {print $5}') 사용"
