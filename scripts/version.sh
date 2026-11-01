#!/usr/bin/env bash
# =============================================================================
# scripts/version.sh — 지금 돌고 있는 코드가 무엇인지 (make version)
#
# --brief 를 주면 "받을 것이 남아 있을 때만" 한 줄 경고합니다(make up이 씁니다).
#
# 네트워크를 쓰지 않습니다. 마지막 fetch 시점의 정보로 판단하므로, 확실히
# 하려면 'make update'를 먼저 실행하세요.
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."

brief=0
[ "${1:-}" = "--brief" ] && brief=1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [ "$brief" = "1" ] && exit 0
  echo "git 저장소가 아닙니다 — 버전을 알 수 없습니다."
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
commit="$(git rev-parse --short HEAD)"
subject="$(git log -1 --pretty=%s)"
when="$(git log -1 --pretty=%cd --date=format:'%Y-%m-%d %H:%M')"

behind=0
ahead=0
if git rev-parse --abbrev-ref "@{u}" >/dev/null 2>&1; then
  behind="$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)"
  # 아직 원격에 올리지 않은 커밋. 다른 기기에서는 이 코드를 받을 수 없습니다.
  ahead="$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)"
fi

# 이 브랜치에 없는 커밋을 가진 다른 원격 브랜치 (git pull이 놓치는 그 경우)
others=""
# origin/HEAD는 기본 브랜치의 별칭입니다(짧은 이름이 "origin"). 세면 중복됩니다.
while IFS='|' read -r full short; do
  [ -z "$short" ] && continue
  [ "$full" = "refs/remotes/origin/HEAD" ] && continue
  [ "$short" = "origin/$branch" ] && continue
  count="$(git rev-list --count "HEAD..$short" 2>/dev/null || echo 0)"
  [ "$count" = "0" ] && continue
  others+="$short(+$count) "
done < <(git for-each-ref --sort=-committerdate refs/remotes/origin \
           --format='%(refname)|%(refname:short)')

if [ "$brief" = "1" ]; then
  if [ "$ahead" != "0" ] && [ "$behind" = "0" ]; then
    echo "  참고: 로컬에만 있는 커밋 ${ahead}개 — 'git push origin $branch' (원격에는 아직 없습니다)"
    echo ""
  fi
  if [ "$behind" != "0" ]; then
    echo "  주의: 원격 $branch 에 새 커밋 ${behind}개가 있습니다 — 'make update' 후 'make up'"
    echo ""
  elif [ -n "$others" ]; then
    echo "  주의: 다른 브랜치에 이 브랜치에 없는 작업이 있습니다: $others"
    echo "     ('make update'가 자세히 알려 줍니다)"
    echo ""
  fi
  exit 0
fi

echo ""
echo "  브랜치   : $branch"
echo "  커밋     : $commit — $subject ($when)"
[ -n "$(git status --porcelain --untracked-files=no)" ] \
  && echo "  작업본   : 수정 중인 파일이 있습니다 (git status)"
if [ "$behind" = "0" ] && [ "$ahead" = "0" ]; then
  echo "  원격     : 이 브랜치는 origin/$branch 와 같습니다"
else
  [ "$behind" != "0" ] && echo "  원격     : origin/$branch 에 새 커밋 ${behind}개 — 'make update'"
  [ "$ahead" != "0" ] && echo "  올릴 것  : 로컬에만 있는 커밋 ${ahead}개 — 'git push origin $branch'"
fi
if [ -n "$others" ]; then
  echo "  다른 곳  : $others  ← 여기에 최신 작업이 있을 수 있습니다"
fi
echo ""
echo "  ※ 마지막 fetch 기준입니다. 확실히 하려면 'make update'를 먼저 실행하세요."
echo ""
