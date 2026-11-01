#!/usr/bin/env bash
# =============================================================================
# scripts/update.sh — 최신 코드 받기 (make update)
#
# 왜 'git pull'을 쓰지 않는가
#   git pull은 "지금 체크아웃된 브랜치"만 당깁니다. 그래서 새 작업이 다른
#   브랜치에 올라가 있으면 아무것도 받지 않고 조용히 끝나고, 이어서 make up을
#   해도 예전 코드가 그대로 다시 뜹니다. 화면은 멀쩡해 보이는데 고친 것이
#   하나도 없는 상태가 됩니다 — 실제로 겪은 일입니다.
#
# 그래서 이 스크립트는
#   1) 모든 브랜치 정보를 받아 오고
#   2) 지금 브랜치를 fast-forward로 당긴 뒤
#   3) "이 브랜치에 없는 최신 작업이 다른 브랜치에 있는지"를 반드시 알려 줍니다.
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "경고: git 저장소가 아닙니다. git clone으로 받은 폴더에서 실행하세요."
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "HEAD" ]; then
  echo "경고: 특정 커밋에 머물러 있습니다(detached HEAD)."
  echo "    브랜치로 돌아가세요:  git checkout main"
  exit 1
fi

echo ""
echo "현재 브랜치 : $branch ($(git rev-parse --short HEAD))"

echo "원격 정보를 받아 옵니다…"
if ! git fetch --prune --quiet origin; then
  echo "경고: 원격에서 받지 못했습니다(네트워크·권한 확인). 지금 코드로 계속합니다."
fi

# ---------------------------------------------------------------- 1) 현재 브랜치 당기기
before="$(git rev-parse HEAD)"

# 추적 중인 파일만 봅니다. 새로 만든 파일(.env·backups 등)은 fast-forward를
# 막지 않고, 정말 덮어쓸 위험이 있으면 git이 스스로 거부합니다.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo ""
  echo "경고: 수정 중인 파일이 있어 당기지 않았습니다. 먼저 정리하세요:"
  git status --short --untracked-files=no | sed 's/^/      /'
  echo "      (되돌리려면 git restore <파일>, 보관하려면 git stash)"
  exit 1
fi

if git rev-parse --abbrev-ref "@{u}" >/dev/null 2>&1; then
  # git의 오류 문구는 버리지 않고 받아 둡니다. 실패 이유가 '갈라짐'만 있는 것이 아닙니다(아래).
  if merge_err="$(git merge --ff-only --quiet "@{u}" 2>&1 >/dev/null)"; then
    after="$(git rev-parse HEAD)"
    if [ "$before" = "$after" ]; then
      echo "이미 최신입니다 ($branch)."
    else
      echo ""
      echo "받은 커밋:"
      git --no-pager log --oneline "$before..$after" | sed 's/^/      /'
    fi
    # 아직 올리지 않은 커밋. 이 상태에서는 다른 기기·원격이 이 코드를 못 받습니다.
    ahead="$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)"
    if [ "$ahead" != "0" ]; then
      echo ""
      echo "참고: 로컬에만 있는 커밋 ${ahead}개 — 아직 원격에 올리지 않았습니다."
      echo "    올리려면:  git push origin $branch"
      echo "    403(denied)이 나면 맥의 GitHub 자격 증명 문제입니다 — README 9장을 보세요."
    fi
  else
    # 양쪽에 서로 없는 커밋이 있을 때만 '갈라짐'입니다. 그 밖의 실패(받는 커밋이 새로 만드는 파일과 같은 이름의
    # 추적 안 된 파일, 남은 .git/index.lock 등)를 갈라짐으로 알리면 graph에 아무것도 보이지 않아 원인을 찾을 수
    # 없었습니다(QA-109). 그때는 git이 알려 준 이유를 그대로 보여 줍니다.
    ahead="$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)"
    behind="$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)"
    echo ""
    if [ "$ahead" != "0" ] && [ "$behind" != "0" ]; then
      echo "경고: 자동으로 합칠 수 없습니다(로컬 커밋이 갈라져 있습니다 — 로컬에만 ${ahead}개, 원격에만 ${behind}개)."
      echo "    확인:  git log --oneline --graph $branch origin/$branch | head"
    else
      echo "경고: 받지 못했습니다. git이 알려 준 이유:"
      printf '%s\n' "$merge_err" | sed 's/^/      /'
      if printf '%s' "$merge_err" | grep -q "untracked working tree files would be overwritten"; then
        echo "    받는 코드에 같은 이름의 새 파일이 있습니다 — 위 파일을 다른 곳으로 옮기거나 지운 뒤 다시 make update"
      fi
    fi
    exit 1
  fi
else
  echo "참고: 이 브랜치는 원격에 연결돼 있지 않습니다(로컬 전용)."
fi

# ---------------------------------------------------------------- 2) 다른 브랜치 확인
# git pull이 조용히 아무것도 안 하던 그 상황을 여기서 드러냅니다.
echo ""
newer=""
# refs/remotes/origin/HEAD는 기본 브랜치를 가리키는 별칭이라 세면 중복입니다.
# 짧은 이름이 그냥 "origin"으로 나오므로 전체 이름으로 걸러야 합니다.
while IFS='|' read -r full short date; do
  [ -z "$short" ] && continue
  [ "$full" = "refs/remotes/origin/HEAD" ] && continue
  [ "$short" = "origin/$branch" ] && continue
  count="$(git rev-list --count "HEAD..$short" 2>/dev/null || echo 0)"
  [ "$count" = "0" ] && continue
  newer+="      $short — 이 브랜치에 없는 커밋 ${count}개 (마지막 작업 $date)"$'\n'
done < <(git for-each-ref --sort=-committerdate refs/remotes/origin \
           --format='%(refname)|%(refname:short)|%(committerdate:format:%Y-%m-%d %H:%M)')

if [ -n "$newer" ]; then
  echo "주의: 다른 브랜치에 이 브랜치가 갖고 있지 않은 작업이 있습니다."
  printf '%s' "$newer"
  echo ""
  echo "    최신 작업으로 옮기려면:  git checkout <위 브랜치 이름>  &&  make up"
  echo "    (기본 브랜치 main에 합치는 것은 저장소 관리자가 합니다)"
else
  echo "✓ 원격의 모든 브랜치 작업이 이 브랜치에 들어 있습니다."
fi

echo ""
echo "다음:  make up      # 받은 코드로 다시 빌드·기동"
echo ""
