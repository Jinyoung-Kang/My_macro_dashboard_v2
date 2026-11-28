"""
tests/test_maintenance_script.py
Vultr 서버 주간 자동 유지보수(scripts/vultr/maintenance.sh — ADR 0053) 시험.

서버 역할의 임시 클론에 진짜 deploy.sh·realtrade-guard.sh·backup-s3.sh·reboot-check.sh·inventory.sh·tailscale-up.sh를 두고, 바깥 명령은
가짜로 바꿉니다(tests/fake_server_tools.py의 make·aws·logger·sleep·df·sudo·dpkg-query와 아래의 docker·apt·apt-get·tailscale·systemctl·
needrestart·getent·id·curl). 가짜 sudo는 FAKE_AS_ROOT=1로 명령을 그대로 부르고, 가짜 id는 그때만 root(0)라고 답해 진짜 tailscale-up.sh가
복구 길에서 돕니다. 보는 것: 가드·잠금·판 대조에 걸리면 아무것도 바꾸지 않음, 단계가 실패하면 뒤 단계를 건너뛰고 알림, 미리 보기는 쓰기 0,
Tailscale은 다른 패키지·이미지 뒤·재부팅 앞에 따로, 복구는 한 번뿐이고 그래도 어긋나면 재부팅하지 않음, 재부팅 뒤 이어 하기, 보고·syslog에
버전 문자열과 비밀값이 없음, 보내지 못한 보고를 다시 보냄.
"""
from __future__ import annotations

import fcntl
import shutil
import time
from pathlib import Path

import pytest

from tests import fake_server_tools as tools

ROOT = Path(__file__).resolve().parents[2]
SECRET = tools.SECRET
CHAT = "424242"
# 가짜 apt가 보류 줄에 찍는 판 — 보고·syslog에 나오면 안 됩니다.
FAKE_VERSIONS = ("9.9.9-0fake2", "9.9.9-0fake1", "0.90.1", "6.8.0-fake")

_DOCKER = r"""#!/usr/bin/env bash
args="$*"
echo "${args//$'\n'/ } | COMPOSE_FILE=${COMPOSE_FILE:-} APP_VERSION=${APP_VERSION:-}" >> "$FAKE_LOG"
case " $* " in
    *" exec -T postgres sh -c psql "*) [ "${FAKE_RT_RC:-0}" = 0 ] || exit 1; printf '%s\n' "${FAKE_RT_OUT:-}"; exit 0 ;;
    *" exec -T postgres pg_dump "*) printf '%s\n' 'COPY public.t (a) FROM stdin;' '\.' '-- PostgreSQL database dump complete'; exit 0 ;;
    *" exec -T postgres true "*) exit 0 ;;
    *" exec -T backend wget "*) [ -z "${FAKE_HEALTH_FAIL:-}" ]; exit $? ;;
    *schema_line*) printf '%s\n' "${FAKE_SCHEMA_LINE:-스키마: 이미지 V99 · DB V99}"; exit 0 ;;
    *" exec "*) exit 0 ;;
    " info ") exit 0 ;;
    *" compose config --services "*) printf '%s\n' postgres collector backend frontend caddy browser; exit 0 ;;
    *" compose ps --all --format "*)
        for s in postgres collector backend frontend caddy browser; do
            h=healthy; [ "$s" != caddy ] || h=
            case " ${FAKE_UNHEALTHY:-} " in *" $s "*) h=unhealthy ;; esac
            printf '%s\trunning\t%s\n' "$s" "$h"
        done
        exit 0 ;;
    *" compose logs "*)
        for ((i = 0; i < ${FAKE_ERROR_LINES:-0}; i++)); do echo "backend-1  | 2026-12-05 ERROR fake failure $i"; done
        echo "backend-1  | 2026-12-05 INFO fine"
        exit 0 ;;
    *" system df "*)
        printf 'Images\t9.9GB\t1.1GB (11%%)\nContainers\t12.3MB\t0B (0%%)\nLocal Volumes\t7.7GB\t0B (0%%)\nBuild Cache\t1.2GB\t0.8GB\n'
        exit 0 ;;
esac
if [ -n "${FAKE_DOCKER_FAIL:-}" ] && [[ "$*" == *"$FAKE_DOCKER_FAIL"* ]]; then exit 1; fi
exit 0
"""
# 보류 목록은 <기록>.upg(줄마다 이름). 줄 모양은 apt list --upgradable 그대로(판 포함).
_APT = r"""#!/usr/bin/env bash
echo "apt $*" >> "$FAKE_LOG.host"
[ "$*" = "list --upgradable" ] || exit 3
echo "WARNING: apt does not have a stable CLI interface. Use with caution in scripts." >&2
echo "Listing..."
while read -r n; do
    [ -z "$n" ] || echo "$n/fakecode-updates 9.9.9-0fake2 amd64 [upgradable from: 9.9.9-0fake1]"
done < "$FAKE_LOG.upg"
"""
# install은 올린 이름을 보류 목록에서 지웁니다. FAKE_APT_FAIL=update|install|tailscale이면 그 호출이 실패. tailscale을 올리면
# FAKE_TS_UPGRADE_BREAKS(serve — 화면 프록시 줄이 사라짐, dns — resolv.conf가 Tailscale 리졸버로 바뀜, down — tailscaled가 멈춤)를 흉내 냅니다.
# FAKE_SET_REBOOT가 있으면 install 뒤 재부팅 표시를 남깁니다.
_APT_GET = r"""#!/usr/bin/env bash
echo "apt-get $* | root=${FAKE_AS_ROOT:-} NR=${NEEDRESTART_MODE:-} FE=${DEBIAN_FRONTEND:-}" >> "$FAKE_LOG"
case "${1:-}" in
    update) [ "${FAKE_APT_FAIL:-}" != update ] || exit 100; exit 0 ;;
    install)
        shift
        names=()
        for a in "$@"; do case "$a" in -* | Dpkg::*) ;; *) names+=("$a") ;; esac; done
        case " ${names[*]} " in
            *" tailscale "*)
                [ "${FAKE_APT_FAIL:-}" != tailscale ] || exit 100
                case "${FAKE_TS_UPGRADE_BREAKS:-}" in
                    serve) : > "$FAKE_LOG.ts-serve-missing" ;;
                    dns) echo "nameserver 100.100.100.100" > "$RESOLV_CONF" ;;
                    down) : > "$FAKE_LOG.tsd-down" ;;
                esac ;;
            *) [ "${FAKE_APT_FAIL:-}" != install ] || exit 100 ;;
        esac
        for n in "${names[@]}"; do
            (grep -vxF -- "$n" "$FAKE_LOG.upg" || true) > "$FAKE_LOG.upg.tmp"; mv "$FAKE_LOG.upg.tmp" "$FAKE_LOG.upg"
        done
        if [ -n "${FAKE_SET_REBOOT:-}" ]; then echo linux-image-fake > "$REBOOT_REQUIRED_FILE.pkgs"; : > "$REBOOT_REQUIRED_FILE"; fi
        exit 0 ;;
esac
exit 3
"""
_TAILSCALE = r"""#!/usr/bin/env bash
echo "tailscale $* | root=${FAKE_AS_ROOT:-}" >> "$FAKE_LOG.ts"
case "$*" in
    version) printf '0.90.1\n  tailscale commit: fake\n' ;;
    "status --json") printf '{"BackendState": "%s", "Self": {"DNSName": "my-macro-app.example.ts.net."}}\n' "$(cat "$FAKE_LOG.ts-state" 2>/dev/null || echo Running)" ;;
    "serve status --json")
        if [ -e "$FAKE_LOG.ts-serve-missing" ]; then echo '{}'
        else echo '{"Web": {"my-macro-app.example.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8201"}}}}}'; fi ;;
    "serve status") echo "https://my-macro-app.example.ts.net (tailnet only)" ;;
    "serve --bg"*) [ -n "${FAKE_TS_RECOVERY_FAILS:-}" ] || rm -f "$FAKE_LOG.ts-serve-missing" ;;
    "ip -4") echo 100.64.0.1 ;;
esac
exit 0
"""
_SYSTEMCTL = r"""#!/usr/bin/env bash
echo "systemctl $* | root=${FAKE_AS_ROOT:-}" >> "$FAKE_LOG"
case "$*" in
    "is-active --quiet tailscaled") [ ! -e "$FAKE_LOG.tsd-down" ]; exit $? ;;
    "enable --now tailscaled") [ -n "${FAKE_TS_RECOVERY_FAILS:-}" ] || rm -f "$FAKE_LOG.tsd-down" ;;
    reboot) exit "${FAKE_REBOOT_RC:-0}" ;;
esac
exit 0
"""
_NEEDRESTART = r"""#!/usr/bin/env bash
echo "needrestart $* | root=${FAKE_AS_ROOT:-}" >> "$FAKE_LOG.host"
printf '%s\n' "NEEDRESTART-VER: 3.6" "NEEDRESTART-KCUR: 6.8.0-fake" "NEEDRESTART-KEXP: 6.8.0-fake" "NEEDRESTART-KSTA: ${FAKE_KSTA:-1}"
for s in ${FAKE_NR_SVC:-}; do echo "NEEDRESTART-SVC: $s.service"; done
"""
# 이름 조회 — resolv.conf가 Tailscale 리졸버를 가리키거나 <기록>.dns-down이 있으면 실패.
_GETENT = r"""#!/usr/bin/env bash
if grep -q '^nameserver 100\.100\.100\.100' "$RESOLV_CONF" 2>/dev/null || [ -e "$FAKE_LOG.dns-down" ]; then exit 2; fi
echo "203.0.113.5 ${2:-x}"
"""
# 텔레그램 — 보낸 글(text=…)을 <기록>.msgs에 '----'로 나눠 남깁니다. 설정(stdin)은 tools와 같이 .curl-config에.
_CURL = r"""#!/usr/bin/env bash
echo "curl" >> "$FAKE_LOG"
case " $* " in *" -K - "*) cat >> "${FAKE_LOG%.log}.curl-config" ;; esac
[ "${FAKE_CURL_RC:-0}" = 0 ] || exit "$FAKE_CURL_RC"
for a in "$@"; do case "$a" in text=*) printf '%s\n----\n' "${a#text=}" >> "$FAKE_LOG.msgs" ;; esac; done
exit 0
"""
_REAL_ID = shutil.which("id") or "/usr/bin/id"
_ID = f"""#!/usr/bin/env bash
if [ "${{1:-}}" = -u ] && [ "${{FAKE_AS_ROOT:-}}" = 1 ]; then echo 0; exit 0; fi
exec {_REAL_ID} "$@"
"""
_REAL_DATE = shutil.which("date") or "/usr/bin/date"
_DATE = ('#!/usr/bin/env bash\n'
         'if [ "$1" = "+%u %H%M" ]; then echo "$FAKE_KST_NOW"; else exec ' + _REAL_DATE + ' "$@"; fi\n')

_COPIED = ["scripts/vultr/maintenance.sh", "scripts/vultr/deploy.sh", "scripts/vultr/realtrade-guard.sh", "scripts/vultr/backup-s3.sh",
           "scripts/vultr/backup-age.sh", "scripts/vultr/reboot-check.sh", "scripts/vultr/disk-check.sh", "scripts/vultr/notify-common.sh",
           "scripts/vultr/inventory.sh", "scripts/vultr/tailscale-up.sh", "scripts/db-backup.sh", "scripts/db-common.sh",
           "deploy/vultr/Caddyfile"]


@pytest.fixture()
def maint(tmp_path):
    """서버 역할의 클론(마지막으로 끝까지 배포한 판 = HEAD), 가짜 실행 파일, 실행 도우미."""
    if shutil.which("git") is None:
        pytest.skip("git이 없어 건너뜁니다.")
    origin, here, seed = tmp_path / "origin.git", tmp_path / "home" / "My_macro_dashboard_v2", tmp_path / "seed"
    tools._git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    tools._git(tmp_path, "clone", "-q", str(origin), str(seed))
    tools._git(seed, "symbolic-ref", "HEAD", "refs/heads/main")
    for rel in _COPIED:
        (seed / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, seed / rel)
    (seed / "README.md").write_text("readme\n", encoding="utf-8")
    tools._git(seed, "add", ".")
    tools._git(seed, "commit", "-q", "-m", "seed")
    tools._git(seed, "push", "-q", "origin", "main")
    here.parent.mkdir(parents=True)
    tools._git(tmp_path, "clone", "-q", "-b", "main", str(origin), str(here))
    (here / ".env").write_text(f"OWNER_EMAIL=owner@example.invalid\nAPP_PASSWORD={SECRET}\n"
                               "COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\nAWS_BACKUP_BUCKET=b\n"
                               "PUBLIC_ORIGIN=https://my-macro-app.example.ts.net\n"
                               f"TELEGRAM_BOT_TOKEN={SECRET}\nTELEGRAM_CHAT_ID={CHAT}\n", encoding="utf-8")
    (here / ".env").chmod(0o600)
    (here / "backups").mkdir()
    head = tools._git(here, "rev-parse", "HEAD")
    (here / "backups/.last-deploy-ok").write_text(f"{int(time.time())} 2026-12-01T00:00:00Z {head}\n", encoding="utf-8")

    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    for name, text in {"make": tools._FAKE_MAKE, "aws": tools._FAKE_AWS, "logger": tools._FAKE_LOGGER, "sleep": tools._FAKE_SLEEP,
                       "df": tools._FAKE_DF, "canonical-livepatch": tools._FAKE_LIVEPATCH, "sudo": tools._FAKE_SUDO,
                       "dpkg-query": tools._FAKE_DPKG_QUERY, "docker": _DOCKER, "apt": _APT, "apt-get": _APT_GET,
                       "tailscale": _TAILSCALE, "systemctl": _SYSTEMCTL, "needrestart": _NEEDRESTART, "getent": _GETENT,
                       "curl": _CURL, "id": _ID, "date": _DATE}.items():
        tools._write_exec(bin_dir / name, text)
    log.touch()
    (Path(f"{log}.upg")).write_text("", encoding="utf-8")
    etc = tmp_path / "etc"
    etc.mkdir()
    (etc / "resolv.conf").write_text("nameserver 108.61.10.10\n", encoding="utf-8")
    (etc / "resolv.pre-tailscale-backup.conf").write_text("nameserver 108.61.10.10\n", encoding="utf-8")

    class Maint:
        def __init__(self):
            self.here, self.seed, self.log, self.tmp = here, seed, log, tmp_path

        def env(self, **extra: str) -> dict[str, str]:
            env = tools._env((bin_dir, log), REBOOT_REQUIRED_FILE=str(tmp_path / "reboot-required"),
                             RESOLV_CONF=str(etc / "resolv.conf"), RESOLV_BACKUP=str(etc / "resolv.pre-tailscale-backup.conf"),
                             FAKE_KST_NOW="6 1730")
            env.update(extra)
            return env

        def upgradable(self, *names: str) -> None:
            Path(f"{log}.upg").write_text("".join(f"{n}\n" for n in names), encoding="utf-8")

        def run(self, *args: str, **extra: str):
            return tools._run_args(here / "scripts/vultr/maintenance.sh", list(args), here, self.env(**extra))

        def calls(self) -> list[str]:
            return log.read_text(encoding="utf-8").splitlines()

        def side(self, suffix: str) -> str:
            path = Path(f"{log}{suffix}")
            return path.read_text(encoding="utf-8") if path.exists() else ""

        def messages(self) -> list[str]:
            return [m.strip("\n") for m in self.side(".msgs").split("\n----\n") if m.strip()]

        def syslog(self) -> list[str]:
            return [c for c in self.calls() if c.startswith("logger -t my-macro-maintenance")]

        def index(self, prefix: str) -> int:
            return next(i for i, c in enumerate(self.calls()) if c.startswith(prefix))

    return Maint()


def _no_versions_or_secrets(m, *texts: str) -> None:
    joined = "\n".join([*m.messages(), *m.syslog(), *texts])
    for version in FAKE_VERSIONS:
        assert version not in joined, f"보고·syslog에 버전 문자열({version})이 없어야 합니다(ADR 0046·0053)"
    assert SECRET not in joined, "텔레그램 토큰·.env 값을 찍지 않음"
    assert SECRET not in "\n".join(m.calls()), "토큰은 curl 인자가 아니라 설정(stdin)으로만"


def _snapshot(root: Path) -> dict[str, tuple[int, int, bytes]]:
    out = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and "bin" not in path.relative_to(root).parts[:1] and not path.name.startswith("calls.log"):
            st = path.stat()
            out[str(path.relative_to(root))] = (st.st_mtime_ns, st.st_size, path.read_bytes())
    return out


# --------------------------------------------------------------------------- 미리 보기
def test_ADR0053_미리_보기는_아무것도_바꾸지_않고_할_일만_찍는다(maint):
    maint.upgradable("docker-ce", "containerd.io", "git", "tailscale", "libfake-other")
    (maint.tmp / "reboot-required").write_text("", encoding="utf-8")
    before = _snapshot(maint.tmp)

    result = maint.run("--dry-run")

    assert result.returncode == 0, result.stderr
    assert _snapshot(maint.tmp) == before, "파일(서버 폴더·.git·backups·resolv.conf)을 하나도 쓰지 않음"
    calls = maint.calls()
    assert not [c for c in calls if c.startswith(("apt-get", "systemctl reboot", "logger", "curl", "make"))], calls
    assert not [c for c in calls if c.startswith(("compose build", "compose up", "compose restart", "compose pull"))], calls
    sudo = [line.removeprefix("sudo ") for line in maint.side(".sudo").splitlines()]
    assert set(sudo) <= {"-n true", "-n needrestart -b -r l", "-n tailscale status --json", "-n tailscale serve status --json"}, sudo
    out = result.stdout
    assert "아무것도 바꾸지 않음" in out
    assert "Docker·Git 보류 docker-ce, containerd.io, git" in out
    assert "4 Tailscale: 보류 tailscale · 확인 넷 ✓" in out
    assert "5 재부팅: 재부팅 표시" in out
    assert "남은 보류(올리지 않음): libfake-other" in out
    assert "지금 실행하면 위 순서로 돕니다" in out
    for version in FAKE_VERSIONS:
        assert version not in out


def test_ADR0053_미리_보기는_건너뛸_까닭을_모두_찍는다(maint):
    (maint.here / "backups/.last-deploy-ok").write_text("1 x 0123456789abcdef0123456789abcdef01234567\n", encoding="utf-8")
    result = maint.run("--dry-run", FAKE_RT_OUT="1", FAKE_KST_NOW="3 1000")
    assert result.returncode == 0, result.stderr
    assert "건너뛸 까닭: 서버 폴더의 판" in result.stdout
    assert "건너뛸 까닭: 실제 매매 가드" in result.stdout
    assert "지금 실행하면 건너뜁니다" in result.stdout


# --------------------------------------------------------------------------- 건너뜀(아무것도 바꾸지 않음)
def _nothing_changed(m) -> None:
    calls = m.calls()
    assert not [c for c in calls if c.startswith(("make ", "apt-get", "systemctl reboot"))], calls
    assert not [c for c in calls if c.startswith(("compose build", "compose up", "compose restart", "compose pull"))], calls


def test_ADR0053_실제_매매_가드에_걸리면_우회_값이_있어도_아무것도_하지_않고_알린다(maint):
    maint.upgradable("docker-ce")
    result = maint.run(FAKE_RT_OUT="1", FAKE_KST_NOW="3 1000", REALTRADE_DEPLOY_OK="1")
    assert result.returncode == 0, result.stderr
    _nothing_changed(maint)
    [msg] = maint.messages()
    assert "주간 유지보수 건너뜀" in msg and "실제 매매 가드" in msg
    _no_versions_or_secrets(maint)


def test_ADR0053_서버_폴더의_판이_끝까지_배포한_판과_다르면_다시_빌드하지_않는다(maint):
    (maint.here / "backups/.last-deploy-ok").unlink()
    result = maint.run()
    assert result.returncode == 0
    _nothing_changed(maint)
    [msg] = maint.messages()
    assert "건너뜀" in msg and "기록 없음" in msg and "deploy.sh" in msg


def test_ADR0053_배포가_잠금을_쥐고_있으면_건너뛴다(maint):
    with (maint.here / "backups/.deploy.lock").open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = maint.run()
    assert result.returncode == 0
    _nothing_changed(maint)
    assert "돌고 있음" in maint.messages()[0]


@pytest.mark.parametrize("case", ["root", "not-server", "arg"])
def test_ADR0053_root이거나_서버가_아니거나_모르는_인자면_아무것도_하지_않는다(maint, case):
    if case == "root":
        result = maint.run(FAKE_AS_ROOT="1")
    elif case == "not-server":
        env_file = maint.here / ".env"
        env_file.write_text(env_file.read_text(encoding="utf-8").replace("COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\n", ""),
                            encoding="utf-8")
        result = maint.run()
    else:
        result = maint.run("--dryrun")
    assert result.returncode == 2
    assert maint.calls() == [] and maint.messages() == []


# --------------------------------------------------------------------------- 실제 실행
def test_ADR0053_순서대로_올리고_Tailscale은_이미지_뒤에_따로_올리며_코드는_받지_않는다(maint):
    maint.upgradable("docker-ce", "containerd.io", "git", "tailscale", "libfake-other")
    head, remote = tools._git(maint.here, "rev-parse", "HEAD"), tools._git(maint.here, "rev-parse", "origin/main")
    (maint.seed / "README.md").write_text("날짜를 정해 배포하기로 한 변경\n", encoding="utf-8")
    tools._git(maint.seed, "commit", "-qam", "dated change")
    tools._git(maint.seed, "push", "-q", "origin", "main")

    result = maint.run()

    assert result.returncode == 0, maint.side("") + result.stdout + result.stderr
    assert tools._git(maint.here, "rev-parse", "HEAD") == head and tools._git(maint.here, "rev-parse", "origin/main") == remote, \
        "코드를 받지 않음(fetch도 병합도 없음 — ADR 0053 결정 3)"
    calls = maint.calls()
    backup, update = maint.index("make --no-print-directory backup"), maint.index("apt-get update")
    pkgs = maint.index("apt-get install -y -q --only-upgrade")
    build = maint.index("compose build")
    ts = maint.index("apt-get install -y -q --only-upgrade -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold tailscale")
    assert backup < update < pkgs < build < ts, "백업 → apt → Docker·Git → 이미지 → Tailscale(따로)"
    assert calls[pkgs].split(" | ")[0].endswith("docker-ce containerd.io git"), "Docker·Git만 — 그 밖의 보류(libfake-other)는 올리지 않음"
    assert "root=1 NR=l FE=noninteractive" in calls[pkgs] and "root=1 NR=l" in calls[ts], "sudo로, needrestart는 목록만"
    builds = [c for c in calls if c.startswith("compose build")]
    today = time.strftime("%Y-%m-%d", time.gmtime())
    assert len(builds) == 4 and all(f"OS_PKG_REFRESH={today}" in b for b in builds), "이미지 안 OS 패키지 층을 그날 새로 만듦"
    assert not [c for c in calls if c.startswith("systemctl reboot")], "재부팅 필요 표시가 없으면 재부팅하지 않음"
    assert "restart" not in " ".join(c for c in calls if c.startswith("compose ")), "어긋나지 않으면 복구(재시작)도 없음"

    [msg] = maint.messages()
    assert msg.startswith("my-macro 서버 — 주간 유지보수 ✓ 끝")
    for line in ("✓ 1 S3 백업", "✓ 2 패키지: Docker·Git 3개 올림(docker-ce, containerd.io, git)",
                 f"✓ 3 이미지: 다시 빌드·기동(main@{head[:7]}", "✓ 4 Tailscale: 올림, 확인 넷 통과", "✓ 5 재부팅: 필요 없음",
                 "✓ 6 확인:", "참고: 기동 뒤 5분의 ERROR 줄 0개", "✓ 7 버전 목록 갱신", "남은 보류(올리지 않음 — 배포판 보안 수정은 자동 업데이트): libfake-other"):
        assert line in msg, (line, msg)
    assert "실행:" not in msg
    _no_versions_or_secrets(maint, result.stdout, result.stderr)
    logs = list((maint.here / "backups/maintenance").glob("*.log"))
    assert len(logs) == 1 and oct(logs[0].stat().st_mode & 0o777) == "0o600", "자세한 출력은 소유자만"
    assert SECRET not in logs[0].read_text(encoding="utf-8")


def test_ADR0053_올릴_것이_없어도_이미지는_다시_빌드하고_ERROR_줄을_센다(maint):
    result = maint.run(FAKE_ERROR_LINES="3")
    assert result.returncode == 0, maint.side("")
    [msg] = maint.messages()
    assert "✓ 2 패키지: 올릴 Docker·Git 없음" in msg and "✓ 4 Tailscale: 올릴 것 없음, 확인 넷 통과" in msg
    assert "ERROR 줄 3개" in msg and "남은 보류" in msg and "없음" in msg
    assert len([c for c in maint.calls() if c.startswith("compose build")]) == 4


@pytest.mark.parametrize("fail,stopped,never", [
    ({"FAKE_MAKE_RC": "1"}, "✗ 1 S3 백업", ("apt-get", "compose build")),
    ({"FAKE_APT_FAIL": "update"}, "✗ 2 패키지: apt-get update 실패", ("apt-get install", "compose build")),
    ({"FAKE_APT_FAIL": "install"}, "✗ 2 패키지: Docker·Git 올림 실패(docker-ce)", ("compose build",)),
    ({"FAKE_DOCKER_FAIL": "--wait-timeout 300"}, "✗ 3 이미지: 다시 빌드·기동 실패", ("apt-get install -y -q --only-upgrade -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold tailscale",)),
])
def test_ADR0053_단계가_실패하면_뒤_단계를_건너뛰고_멈춘_곳과_할_일을_알린다(maint, fail, stopped, never):
    maint.upgradable("docker-ce", "tailscale")
    result = maint.run(FAKE_SET_REBOOT="1", **fail)
    assert result.returncode == 1
    for prefix in never:
        assert not [c for c in maint.calls() if c.startswith(prefix)], prefix
    assert not [c for c in maint.calls() if c.startswith("systemctl reboot")], "실패한 채 재부팅하지 않음"
    [msg] = [m for m in maint.messages() if "주간 유지보수" in m]
    assert "주간 유지보수 ✗" in msg and stopped in msg and "에서 멈춤" in msg and "실행:" in msg
    _no_versions_or_secrets(maint)
    assert any("끝: 실패" in line for line in maint.syslog())


# --------------------------------------------------------------------------- Tailscale(결정 2)
@pytest.mark.parametrize("breaks", ["serve", "dns", "down"])
def test_ADR0053_Tailscale을_올린_뒤_어긋나면_문서의_복구를_한_번_하고_이어간다(maint, breaks):
    maint.upgradable("tailscale")
    result = maint.run(FAKE_TS_UPGRADE_BREAKS=breaks)
    assert result.returncode == 0, maint.side("") + result.stdout
    ts = maint.side(".ts")
    assert ts.count("tailscale set --ssh --hostname my-macro-app --accept-dns=false | root=1") == 1, \
        "tailscale-up.sh(이미 tailnet에 있음 — 키를 읽지 않음)를 root로 한 번"
    assert "up " not in ts and "logout" not in ts, "재가입·로그아웃은 하지 않음"
    restarts = [c for c in maint.calls() if c.startswith("compose restart")]
    assert restarts == [f"compose restart backend collector frontend browser caddy | COMPOSE_FILE=docker-compose.yml:compose.vultr.yml APP_VERSION={restarts[0].split('APP_VERSION=')[1]}"], restarts
    assert "nameserver 100.100.100.100" not in (maint.tmp / "etc/resolv.conf").read_text(encoding="utf-8")
    [msg] = maint.messages()
    assert "✓ 4 Tailscale: 올림, 확인 넷 통과(복구 한 번 씀)" in msg and "✓ 끝" in msg


def test_ADR0053_복구_한_번_뒤에도_어긋나면_재부팅하지_않고_멈춘다(maint):
    maint.upgradable("docker-ce", "tailscale")
    result = maint.run(FAKE_TS_UPGRADE_BREAKS="serve", FAKE_TS_RECOVERY_FAILS="1", FAKE_SET_REBOOT="1", FAKE_KSTA="3")
    assert result.returncode == 1
    calls = maint.calls()
    assert not [c for c in calls if c.startswith("systemctl reboot")], "어긋난 채로 재부팅하지 않음"
    assert len([c for c in calls if c.startswith("compose restart")]) == 1, "복구는 한 번뿐"
    assert maint.side(".ts").count("tailscale set ") == 1
    assert not (maint.here / "backups/.maintenance-reboot").exists()
    [msg] = maint.messages()
    assert "✗ 4 Tailscale: 올림, 복구 한 번 뒤에도 어긋남(tailscale serve의 화면 프록시(127.0.0.1:8201) 줄이 없음) — 재부팅하지 않음" in msg
    assert "비상용 셸" in msg and "firewall-pc-ip.sh" in msg
    _no_versions_or_secrets(maint)


# --------------------------------------------------------------------------- 재부팅(결정 4)과 이어 하기
@pytest.mark.parametrize("why,expect", [
    ({"FAKE_SET_REBOOT": "1"}, "재부팅 표시(패키지 1개)"),
    ({"FAKE_KSTA": "3"}, "새 커널 대기"),
    ({"FAKE_NR_SVC": "dbus systemd-logind"}, "재시작이 필요한 서비스: dbus, systemd-logind"),
])
def test_ADR0053_재부팅이_필요하면_Tailscale_뒤에_재부팅하고_부팅_뒤_이어서_확인하고_한_통으로_알린다(maint, why, expect):
    maint.upgradable("docker-ce", "tailscale")
    result = maint.run(**why)
    assert result.returncode == 0, maint.side("") + result.stdout
    ts = maint.index("apt-get install -y -q --only-upgrade -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold tailscale")
    reboot = maint.index("systemctl reboot")
    assert ts < reboot and maint.calls()[reboot].endswith("root=1"), "Tailscale을 올리고 확인한 뒤 sudo로 재부팅"
    assert maint.messages() == [], "재부팅 전에는 보내지 않음(보고는 한 통)"
    marker = maint.here / "backups/.maintenance-reboot"
    assert marker.exists() and oct(marker.stat().st_mode & 0o777) == "0o600"

    # 재부팅 — 표시 파일·needrestart 상태가 풀림.
    for name in ("reboot-required", "reboot-required.pkgs"):
        (maint.tmp / name).unlink(missing_ok=True)
    after = maint.run("--after-reboot", MAINT_BOOT_EPOCH=str(int(time.time()) - 400), FAKE_ERROR_LINES="2")

    assert after.returncode == 0, maint.side("")
    assert not marker.exists()
    [msg] = maint.messages()
    for line in ("✓ 1 S3 백업", "✓ 2 패키지: Docker·Git 1개 올림(docker-ce)", "✓ 4 Tailscale: 올림", f"✓ 5 재부팅 필요: {expect}",
                 "✓ 5 재부팅함", "✓ 6 확인:", "ERROR 줄 2개", "✓ 끝"):
        assert line in msg, (line, msg)
    logs = list((maint.here / "backups/maintenance").glob("*.log"))
    assert len(logs) == 1, "재부팅 뒤 출력은 같은 파일에 이어 씀"
    _no_versions_or_secrets(maint, after.stdout)


def test_ADR0053_재부팅_뒤_이름_조회가_깨져_있으면_복구를_한_번_한다(maint):
    marker = maint.here / "backups/.maintenance-reboot"
    marker.write_text(f"{int(time.time())}\n{maint.here}/backups/maintenance/x.log\n✓ 1 S3 백업\n", encoding="utf-8")
    (maint.tmp / "etc/resolv.conf").write_text("nameserver 100.100.100.100\n", encoding="utf-8")   # 2026-11-12 장애 꼴
    result = maint.run("--after-reboot", MAINT_BOOT_EPOCH=str(int(time.time()) - 400))
    assert result.returncode == 0, maint.side("")
    assert len([c for c in maint.calls() if c.startswith("compose restart")]) == 1
    [msg] = maint.messages()
    assert "✓ 6 확인:" in msg and "복구 한 번 씀" in msg


def test_ADR0053_재부팅_뒤에도_이름_조회가_안_되면_보고를_남기고_reboot_check가_다시_보낸다(maint):
    marker = maint.here / "backups/.maintenance-reboot"
    marker.write_text(f"{int(time.time())}\n\n✓ 1 S3 백업\n", encoding="utf-8")
    Path(f"{maint.log}.dns-down").touch()
    result = maint.run("--after-reboot", MAINT_BOOT_EPOCH=str(int(time.time()) - 400), FAKE_CURL_RC="6")
    assert result.returncode == 1
    assert len([c for c in maint.calls() if c.startswith("compose restart")]) == 1, "복구는 한 번뿐"
    unsent = maint.here / "backups/.maintenance-unsent"
    assert unsent.exists() and "✗ 6 확인" in unsent.read_text(encoding="utf-8")
    assert oct(unsent.stat().st_mode & 0o777) == "0o600"

    Path(f"{maint.log}.dns-down").unlink()
    check = tools._run(maint.here / "scripts/vultr/reboot-check.sh", maint.here, maint.env())
    assert check.returncode == 0, check.stderr
    resent = [m for m in maint.messages() if "지난 주간 유지보수 보고를 보내지 못해 다시 보냅니다" in m]
    assert len(resent) == 1 and "✗ 6 확인" in resent[0]
    assert not unsent.exists()


def test_ADR0053_보내지_못한_보고는_다음_실행의_보고에_붙여_보낸다(maint):
    (maint.here / "backups/.maintenance-unsent").write_text("my-macro 서버 — 주간 유지보수 ✗ 지난주\n", encoding="utf-8")
    result = maint.run()
    assert result.returncode == 0, maint.side("")
    [msg] = maint.messages()
    assert msg.startswith("지난 주간 유지보수 보고를 보내지 못해 함께 보냅니다:") and "✗ 지난주" in msg and "✓ 끝" in msg
    assert not (maint.here / "backups/.maintenance-unsent").exists()


@pytest.mark.parametrize("age", [None, 3 * 3600])
def test_ADR0053_이어_하기_표시가_없거나_오래됐으면_재부팅_뒤에_아무것도_하지_않는다(maint, age):
    marker = maint.here / "backups/.maintenance-reboot"
    if age is not None:
        marker.write_text(f"{int(time.time()) - age}\n\n✓ 1 S3 백업\n", encoding="utf-8")
    result = maint.run("--after-reboot")
    assert result.returncode == 0
    assert not marker.exists()
    assert maint.messages() == []
    assert [c for c in maint.calls() if not c.startswith("logger")] == [], "손으로 한 재부팅 뒤에는 확인·알림 없음"


def test_ADR0053_재부팅_뒤_건강하지_않은_컨테이너가_있으면_실패로_알린다(maint):
    marker = maint.here / "backups/.maintenance-reboot"
    marker.write_text(f"{int(time.time())}\n\n✓ 1 S3 백업\n", encoding="utf-8")
    result = maint.run("--after-reboot", MAINT_BOOT_EPOCH=str(int(time.time()) - 400), FAKE_UNHEALTHY="backend",
                       FAKE_HEALTH_FAIL="1")
    assert result.returncode == 1
    [msg] = maint.messages()
    assert "✗ 6 확인: 컨테이너: backend(running·unhealthy); 백엔드 /api/health 실패" in msg and "실행:" in msg

