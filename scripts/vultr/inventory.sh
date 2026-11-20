#!/usr/bin/env bash
# =============================================================================
# scripts/vultr/inventory.sh — 운영 환경의 버전 목록을 모아 수집기에 넘깁니다(보안 공지, ADR 0046 결정 1·2).
#
# 모으는 구역(구역마다 실패를 따로 잡고 나머지는 보냄 — 구역 상태 ok·failed·skipped를 함께 넘김):
#   host       서버에서만(.env의 COMPOSE_FILE에 compose.vultr.yml — reboot-check.sh와 같은 판별, 아니면 skipped):
#              dpkg-query(설치된 패키지·원본 패키지), uname -r(커널), docker(서버 버전)·docker compose·tailscale 버전,
#              apt 보류 목록(apt list --upgradable — apt-get update는 하지 않고 목록을 마지막으로 받은 시각을 함께 넘김)
#   postgres   SHOW server_version(scripts/db-common.sh의 run_psql) + 컨테이너 OS 패키지
#   backend    JDK(/opt/java/openjdk/release) + jar 의존성(BOOT-INF/lib/*.jar 이름) + 컨테이너 OS 패키지
#   frontend   Node + node_modules 최상위(범위 폴더 @… 한 단계 더) package.json + 컨테이너 OS 패키지
#   collector  Python + 설치된 배포(importlib.metadata) + 컨테이너 OS 패키지
#   browser    Chrome(google-chrome --version) + 컨테이너 OS 패키지
#   caddy      caddy version + 컨테이너 OS 패키지
#   컨테이너 OS 패키지는 alpine이면 /lib/apk/db/installed(P:·V:·o:), debian이면 dpkg-query. 컨테이너마다 `docker compose exec -T <서비스> sh -s`
#   한 번(아래 컨테이너 스크립트를 표준입력으로 — 컨테이너에 파일을 두지 않음).
# 넘기는 길: `docker compose exec -T collector python -m app.inventory`의 표준입력(형식은 collector/app/inventory.py). 수집기가 검증해
#   틀리면 아무것도 쓰지 않습니다.
#
# 버전은 운영 DB에만 남깁니다 — 이 스크립트의 출력과 syslog(태그 my-macro-inventory)에는 건수·구역 상태만(저장소가 공개, 배포 출력도 같음).
#
# 사용(저장소 최상위로 옮겨 .env를 봄):
#   bash scripts/vultr/inventory.sh                      모아 넘기고 한 줄(건수) — 배포(deploy.sh 끝)와 cron
#   bash scripts/vultr/inventory.sh --container-script   컨테이너 안에서 도는 sh 스크립트만 찍음(손으로 확인할 때 — 버전 없음)
# cron(서버의 ubuntu 사용자, 서버 시간대는 UTC) 제안: 매일 07:20·22:20 UTC = 16:20·07:20 KST
#   20 7,22 * * * /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/inventory.sh
# 결과: journalctl -t my-macro-inventory
# 시험은 컨테이너 스크립트의 경로를 INV_* 환경 변수로 바꿉니다(가짜 docker가 그 스크립트를 이 기계에서 돌림).
# =============================================================================
set -euo pipefail

export PATH="${PATH:+$PATH:}/snap/bin:/usr/local/bin:/usr/bin:/bin"
# shellcheck source=scripts/db-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../db-common.sh"   # env_file_value · run_psql, 저장소 최상위로 이동

tag=my-macro-inventory
CONTAINERS=(postgres backend frontend collector browser caddy)

# 컨테이너 안에서 도는 POSIX sh(alpine busybox·debian dash 둘 다) — 첫 인자가 서비스 이름. 줄마다 '생태계<탭>이름<탭>버전<탭>원본'.
# 종료 코드: 3 OS 패키지 목록 실패, 4 런타임 버전 실패, 5 의존성 목록 실패, 2 모르는 서비스.
container_script() {
    cat <<'SH'
svc="$1"
pkgs() {
    apk_db="${INV_APK_DB:-/lib/apk/db/installed}"
    if [ -f "$apk_db" ]; then
        awk 'function out() { if (p != "" && substr(p, 1, 1) != ".") print "apk\t" p "\t" v "\t" (o == "" ? p : o); p = v = o = "" }
             /^P:/ { p = substr($0, 3) } /^V:/ { v = substr($0, 3) } /^o:/ { o = substr($0, 3) } /^$/ { out() } END { out() }' "$apk_db"
    elif command -v dpkg-query >/dev/null 2>&1; then
        list=$(dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${source:Package}\n') || return 1
        printf '%s\n' "$list" | awk -F '\t' '$1 ~ /^ii/ { print "dpkg\t" $2 "\t" $3 "\t" ($4 == "" ? $2 : $4) }'
    else
        return 1
    fi
}
case "$svc" in
    postgres)
        pkgs || exit 3 ;;
    backend)
        release="${INV_JAVA_RELEASE:-/opt/java/openjdk/release}"
        [ -r "$release" ] || exit 4
        version=$(sed -n 's/^JAVA_RUNTIME_VERSION="\(.*\)"$/\1/p' "$release")
        vendor=$(sed -n 's/^IMPLEMENTOR="\(.*\)"$/\1/p' "$release")
        [ -n "$version" ] || exit 4
        printf 'runtime\tjdk\t%s\t%s\n' "$version" "${vendor:--}"
        jars=$(unzip -l "${INV_APP_JAR:-/app/app.jar}") || exit 5
        printf '%s\n' "$jars" | awk '{ f = $4; if (f !~ /^BOOT-INF\/lib\/.+\.jar$/) next; sub(/^BOOT-INF\/lib\//, "", f); sub(/\.jar$/, "", f)
            if (match(f, /-[0-9]/)) print "maven\t" substr(f, 1, RSTART - 1) "\t" substr(f, RSTART + 1) "\t-"; else print "maven\t" f "\tunknown\t-" }'
        pkgs || exit 3 ;;
    frontend)
        node -e '
const fs = require("fs"), path = require("path");
const rows = [["runtime", "node", process.version.replace(/^v/, ""), "-"]];
const root = path.join(process.env.INV_APP_DIR || process.cwd(), "node_modules");
for (const dir of fs.readdirSync(root).sort()) {
    if (dir.startsWith(".")) continue;
    const names = dir.startsWith("@") ? fs.readdirSync(path.join(root, dir)).sort().map((x) => dir + "/" + x) : [dir];
    for (const name of names) {
        let pkg;
        try { pkg = JSON.parse(fs.readFileSync(path.join(root, name, "package.json"), "utf8")); } catch (e) { continue; }
        if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") rows.push(["npm", pkg.name, pkg.version, "-"]);
    }
}
process.stdout.write(rows.map((row) => row.join("\t")).join("\n") + "\n");
' || exit 4
        pkgs || exit 3 ;;
    collector)
        python -c '
import importlib.metadata as metadata, platform, re
rows = {("runtime", "python", platform.python_version(), "-")}
for dist in metadata.distributions():
    name = dist.metadata["Name"]
    if name and dist.version:
        rows.add(("pypi", re.sub(r"[-_.]+", "-", name).lower(), dist.version, "-"))
print("\n".join("\t".join(row) for row in sorted(rows)))
' || exit 4
        pkgs || exit 3 ;;
    browser)
        version=$(google-chrome --version) || exit 4
        version=$(printf '%s\n' "$version" | sed -n '1{s/^Google Chrome //;s/[[:space:]]*$//;p;}')
        [ -n "$version" ] || exit 4
        printf 'runtime\tchrome\t%s\t-\n' "$version"
        pkgs || exit 3 ;;
    caddy)
        version=$(caddy version) || exit 4
        version=$(printf '%s\n' "$version" | awk 'NR == 1 { sub(/^v/, "", $1); print $1 }')
        [ -n "$version" ] || exit 4
        printf 'runtime\tcaddy\t%s\t-\n' "$version"
        pkgs || exit 3 ;;
    *)
        exit 2 ;;
esac
SH
}

case "${1:-}" in
    '') ;;
    --container-script) container_script; exit 0 ;;
    *) echo "사용: bash scripts/vultr/inventory.sh [--container-script]" >&2; exit 2 ;;
esac

sections=""
components=""
pending=""

# 구역 하나를 적습니다 — ok이면 본문 줄이 모두 '생태계<탭>이름<탭>버전<탭>원본'이어야 함(아니면 failed '출력 모양이 다름').
add_section() {
    local name="$1" status="$2" reason="$3" body="${4:-}"
    if [ "$status" = ok ]; then
        if [ -z "$body" ]; then
            status=failed reason="빈 출력"
        elif ! awk -F '\t' 'NF != 4 || $1 == "" || $2 == "" || $3 == "" { bad = 1 } END { exit bad }' <<< "$body"; then
            status=failed reason="출력 모양이 다름"
        fi
    fi
    sections+="section"$'\t'"$name"$'\t'"$status"$'\t'"$reason"$'\n'
    if [ "$status" = ok ]; then
        components+="$(awk -v s="$name" '{ print "component\t" s "\t" $0 }' <<< "$body")"$'\n'
    fi
}

# ---------------------------------------------------------------- 호스트(서버에서만)
host_lines() {
    local list v
    list="$(dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${source:Package}\n')" || return 11
    awk -F '\t' '$1 ~ /^ii/ { print "dpkg\t" $2 "\t" $3 "\t" ($4 == "" ? $2 : $4) }' <<< "$list"
    v="$(uname -r)" || return 12
    printf 'runtime\tkernel\t%s\t-\n' "$v"
    v="$(docker version --format '{{.Server.Version}}')" || return 13
    printf 'runtime\tdocker\t%s\t-\n' "${v#v}"
    v="$(docker compose version --short)" || return 14
    printf 'runtime\tcompose\t%s\t-\n' "${v#v}"
    v="$(tailscale version | head -n 1)" || return 15
    printf 'runtime\ttailscale\t%s\t-\n' "$v"
}

# apt 보류 — '이름/저장소[,저장소] 후보 아키텍처 [upgradable from: 설치]'(첫 줄 'Listing...'). → pending 줄.
pending_lines() {
    local list
    list="$(apt list --upgradable 2>/dev/null)" || return 21
    awk '{ i = index($0, "[upgradable from: "); if (!i || split($1, name, "/") != 2) next
           installed = substr($0, i + 18); sub(/\].*$/, "", installed)
           print "pending\t" name[1] "\t" $3 "\t" installed "\t" $2 "\t" name[2] }' <<< "$list"
}

host_flag=0
apt_at="-"
case ":$(env_file_value COMPOSE_FILE):" in
    *:compose.vultr.yml:*)
        host_flag=1
        if body="$(host_lines)" && apt_body="$(pending_lines)"; then
            add_section host ok - "$body"
            pending="$apt_body"
            [ -z "$pending" ] || pending+=$'\n'
            stamp="${INV_APT_STAMP:-/var/lib/apt/periodic/update-success-stamp}"
            if [ -e "$stamp" ]; then
                apt_at="$(date -u -d "@$(stat -c %Y "$stamp")" +%Y-%m-%dT%H:%M:%SZ)" || apt_at="-"
            fi
        else
            add_section host failed "읽지 못함(종료 코드 $?)"
        fi
        ;;
    *) add_section host skipped "서버가 아님" ;;
esac

# ---------------------------------------------------------------- 컨테이너
for svc in "${CONTAINERS[@]}"; do
    rc=0
    body="$(container_script | docker compose exec -T "$svc" sh -s -- "$svc" 2>/dev/null)" || rc=$?
    if [ "$rc" = 0 ] && [ "$svc" = postgres ]; then
        # 서버 버전은 psql로(첫 낱말 — '16.x (…)' 꼴이어도 숫자만).
        version="$(run_psql -tAc 'SHOW server_version' 2>/dev/null | awk 'NR == 1 { print $1 }')" || rc=$?
        if [ "$rc" = 0 ] && [ -z "$version" ]; then
            rc=4
        fi
        if [ "$rc" = 0 ]; then
            body="runtime"$'\t'"postgres"$'\t'"$version"$'\t'"-"$'\n'"$body"
        fi
    fi
    if [ "$rc" = 0 ]; then
        add_section "$svc" ok - "$body"
    else
        add_section "$svc" failed "읽지 못함(종료 코드 $rc)"
    fi
done

# ---------------------------------------------------------------- 넘기기
doc="$(mktemp)"
out="$(mktemp)"
trap 'rm -f "$doc" "$out"' EXIT
chmod 600 "$doc"
{
    printf 'inventory\t1\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$host_flag" "$apt_at"
    printf '%s' "$sections" "$components" "$pending"
} > "$doc"

rc=0
docker compose exec -T collector python -m app.inventory < "$doc" > "$out" 2>&1 || rc=$?
line="$(head -n 1 "$out" | cut -c1-300)"
if [ "$rc" = 0 ]; then
    echo "  버전 목록: ${line:-넘김}"
    logger -t "$tag" "${line:-버전 목록 넘김}" || true
    exit 0
fi
echo "경고: 버전 목록을 넘기지 못했습니다(종료 코드 $rc)${line:+ — $line}" >&2
logger -t "$tag" -p user.warning "버전 목록을 넘기지 못함(종료 코드 $rc)${line:+ — $line}" || true
exit 1
