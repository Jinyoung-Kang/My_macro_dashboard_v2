"""
tests/test_test_isolated.py
격리 실행(scripts/test-isolated.sh · make test-isolated — docs/improve/2026-11-27-quality-plan.md §7 (나)).

떠 있는 로컬 스택의 postgres(512m)에 전체 시험 여러 벌을 붙였다가 그 postgres가 죽은 적이 있어, 벌마다 일회용 postgres를 띄우는
스크립트를 둡니다. 이 스크립트가 틀리면 떠 있는 스택을 건드리거나(프로젝트 이름·.env), 떠 있는 스택의 DB에 붙거나(TEST_DATABASE_URL),
컨테이너·볼륨을 남깁니다 — 그 세 가지를 고정합니다.

docker·make는 PATH 앞에 둔 가짜 실행 파일입니다(부른 인자와 그때의 환경을 기록 파일에 남김). flock은 진짜를 씁니다(칸·폴더 잠금이
실제로 막는지 보려고). 컨테이너를 띄우지 않고 DB·네트워크가 필요 없습니다.
"""
from __future__ import annotations

import fcntl
import os
import shutil
import signal
import socket
import subprocess
import time
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/test-isolated.sh"
COMPOSE_FILE = ROOT / "scripts/test/docker-compose.testdb.yml"

pytestmark = pytest.mark.skipif(shutil.which("flock") is None, reason="flock이 없어 건너뜁니다(리눅스 util-linux).")

_FAKE_DOCKER = """#!/usr/bin/env bash
echo "docker $* | TESTDB_PORT=${TESTDB_PORT-(unset)}" >> "$FAKE_LOG"
if [ -n "${FAKE_DOCKER_FAIL:-}" ] && [[ " $* " == *" $FAKE_DOCKER_FAIL "* ]]; then echo "fake docker: $FAKE_DOCKER_FAIL 실패" >&2; exit 1; fi
exit 0
"""
# FAKE_MAKE_SLEEP이 있으면 '돌고 있음' 표시 파일을 만들고 그만큼 잡니다(중단·잠금 시험). 잠금 fd(8·9)를 물려받았는지도 남깁니다.
_FAKE_MAKE = """#!/usr/bin/env bash
{
    echo "make $*"
    echo "env TEST_DATABASE_URL=${TEST_DATABASE_URL-(unset)} DATABASE_USER=${DATABASE_USER-(unset)} DATABASE_PASSWORD=${DATABASE_PASSWORD-(unset)}"
    echo "env XDG_CACHE_HOME=${XDG_CACHE_HOME-(unset)} YFINANCE_CACHE_DIR=${YFINANCE_CACHE_DIR-(unset)}"
    echo "env VITEST_MAX_WORKERS=${VITEST_MAX_WORKERS-(unset)} TESTDB_PORT=${TESTDB_PORT-(unset)} MAKEFLAGS=${MAKEFLAGS-(unset)}"
    echo "env LOCKFDS=$( [ -e /proc/$$/fd/8 ] && echo 8 )$( [ -e /proc/$$/fd/9 ] && echo 9 )"
    echo "env SIGIGN=$(grep -s SigIgn /proc/$$/status | tr -d '[:space:]' | cut -d: -f2)"
} >> "$FAKE_LOG"
if [ -n "${FAKE_MAKE_SLEEP:-}" ]; then : > "$FAKE_LOG.running"; sleep "$FAKE_MAKE_SLEEP"; fi
exit "${FAKE_MAKE_RC:-0}"
"""


def _free_port_base() -> int:
    """칸 1·2의 포트(값+1·값+2)가 지금 비어 있는 자리 — 실제 격리 실행(25441·25442)이 돌고 있어도 시험이 흔들리지 않게."""
    for _ in range(50):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            base = probe.getsockname()[1] - 1
        try:
            for port in (base + 1, base + 2):
                with socket.socket() as s:
                    s.bind(("127.0.0.1", port))
        except OSError:
            continue
        return base
    raise AssertionError("빈 포트 두 개를 찾지 못했습니다")


class Sandbox:
    def __init__(self, tmp_path: Path):
        self.tmp = tmp_path
        self.log = tmp_path / "calls.log"
        self.locks = tmp_path / "locks"
        self.port_base = _free_port_base()
        bindir = tmp_path / "bin"
        bindir.mkdir()
        for name, body in (("docker", _FAKE_DOCKER), ("make", _FAKE_MAKE)):
            (bindir / name).write_text(body, encoding="utf-8")
            (bindir / name).chmod(0o755)
        (tmp_path / "tmp").mkdir()
        drop = {"TEST_ISOLATED_SLOTS", "TEST_ISOLATED_WAIT", "VITEST_MAX_WORKERS", "DATABASE_USER", "DATABASE_PASSWORD",
                "DATABASE_PORT", "TEST_DATABASE_URL", "XDG_CACHE_HOME", "YFINANCE_CACHE_DIR", "TESTDB_PORT",
                "MAKEFLAGS", "MFLAGS", "MAKELEVEL"}
        self.env = {k: v for k, v in os.environ.items() if k not in drop}
        self.env.update({
            "PATH": f"{bindir}{os.pathsep}{self.env.get('PATH', '')}",
            "FAKE_LOG": str(self.log),
            "TMPDIR": str(tmp_path / "tmp"),
            "TEST_ISOLATED_LOCK_DIR": str(self.locks),
            "TEST_ISOLATED_PORT_BASE": str(self.port_base),
            "TEST_ISOLATED_WAIT": "0",
        })

    # 스크립트는 INT 처리가 기본값인 채로 띄웁니다. 이 pytest가 INT를 무시하는 부모(비대화형 셸의 `&` 등) 아래에서 돌면 그 상태가
    # 물려 내려가고, bash는 시작할 때 무시돼 있던 신호에는 trap을 걸 수 없어 중단 시험이 부모의 사정에 따라 달라집니다(실제로 겪음).
    def popen(self, *targets: str, sigint=signal.SIG_DFL, **extra: str) -> subprocess.Popen:
        return subprocess.Popen(["bash", str(SCRIPT), *targets], env={**self.env, **extra}, cwd=self.tmp,
                                preexec_fn=lambda: signal.signal(signal.SIGINT, sigint),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")

    def run(self, *targets: str, sigint=signal.SIG_DFL, **extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(SCRIPT), *targets], env={**self.env, **extra}, cwd=self.tmp,
                              preexec_fn=lambda: signal.signal(signal.SIGINT, sigint),
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)

    def lines(self) -> list[str]:
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def docker_calls(self) -> list[str]:
        return [line for line in self.lines() if line.startswith("docker ")]

    def make_env(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for line in self.lines():
            if line.startswith("env "):
                out.update(pair.split("=", 1) for pair in line[4:].split(" ") if "=" in pair)
        return out

    def wait_running(self, proc: subprocess.Popen) -> None:
        marker = Path(f"{self.log}.running")
        deadline = time.monotonic() + 20
        while not marker.exists():
            assert proc.poll() is None, proc.stderr.read()
            assert time.monotonic() < deadline, "가짜 make가 시작되지 않았습니다"
            time.sleep(0.05)

    def leftovers(self) -> list[str]:
        return [p.name for p in (self.tmp / "tmp").iterdir()]


@pytest.fixture
def box(tmp_path):
    return Sandbox(tmp_path)


def _compose_prefix(slot: int) -> str:
    return f"docker compose --env-file /dev/null -p my_macrodash_v2_test_{slot} -f {COMPOSE_FILE}"


def test_compose는_env_파일_없이_프로젝트_이름과_파일을_적어_부르고_up은_기다린다(box):
    r = box.run()
    assert r.returncode == 0, r.stdout + r.stderr
    calls = box.docker_calls()
    assert calls, "docker를 부르지 않았습니다"
    port = box.port_base + 1
    for call in calls:
        # .env를 읽지 않고(--env-file /dev/null) 프로젝트 이름(-p)·파일(-f)을 늘 적습니다 — 하나라도 빠지면 이 폴더 이름의 프로젝트(떠 있는 로컬 스택)를 봅니다.
        assert call.startswith(_compose_prefix(1) + " "), call
        assert call.endswith(f"| TESTDB_PORT={port}"), call
    actions = [call.split(" | ")[0].removeprefix(_compose_prefix(1) + " ") for call in calls]
    assert actions == ["down -v --remove-orphans", "up -d --wait", "down -v --remove-orphans"], "앞의 down은 죽은 실행의 찌꺼기 치우기"
    for stack in ("my_macro_dashboard_v2", "my_macrodash_v2_qa"):
        assert not any(f"-p {stack} " in call for call in calls)


def test_make에_포트와_COMPOSE를_넘기고_기본_대상은_test(box):
    r = box.run()
    assert r.returncode == 0, r.stdout + r.stderr
    port = box.port_base + 1
    make = [line for line in box.lines() if line.startswith("make ")]
    assert make == [f"make test DATABASE_PORT={port} COMPOSE={_compose_prefix(1)}"]
    # 순서: postgres가 뜬 뒤에 make, make가 끝난 뒤에 down
    order = [line.split(" | ")[0].split(" ")[-1] if line.startswith("docker ") else "make"
             for line in box.lines() if line.startswith(("docker ", "make "))]
    assert order == ["--remove-orphans", "--wait", "make", "--remove-orphans"]


def test_대상을_골라_넘길_수_있고_make_변수나_선택지는_받지_않는다(box):
    r = box.run("test-collector", "test-backend")
    assert r.returncode == 0, r.stdout + r.stderr
    assert any(line.startswith("make test-collector test-backend DATABASE_PORT=") for line in box.lines())

    for bad in ("DATABASE_PORT=5434", "COMPOSE=docker compose", "-C", "a b"):
        box.log.unlink(missing_ok=True)
        r = box.run(bad)
        assert r.returncode == 1 and "✗" in r.stderr, bad
        assert box.lines() == [], f"거절한 인자로는 docker·make를 부르지 않습니다: {bad}"


def test_시험_환경에_TEST_DATABASE_URL이_없고_계정은_공개_기본값이며_캐시는_벌마다_따로(box):
    r = box.run(TEST_DATABASE_URL="postgresql://someone:else@localhost:5434/macrodash_test",
                DATABASE_USER="from-shell", DATABASE_PASSWORD="from-shell", MAKEFLAGS="-n T=x",
                XDG_CACHE_HOME="/shared/cache", YFINANCE_CACHE_DIR="/shared/yf")
    assert r.returncode == 0, r.stdout + r.stderr
    seen = box.make_env()
    # 셸의 TEST_DATABASE_URL은 Makefile의 DATABASE_PORT를 조용히 이깁니다 — 남아 있으면 떠 있는 스택의 DB에 붙습니다.
    assert seen["TEST_DATABASE_URL"] == "(unset)"
    assert (seen["DATABASE_USER"], seen["DATABASE_PASSWORD"]) == ("macro", "macro")
    assert seen["TESTDB_PORT"] == str(box.port_base + 1), "make가 부르는 compose exec도 같은 포트 값으로 해석돼야 합니다"
    assert seen["MAKEFLAGS"] == "(unset)", "바깥 make의 선택지가 안쪽 make로 새지 않게"
    assert seen["LOCKFDS"] == "", "잠금 fd를 자식에게 넘기지 않습니다(고아가 칸을 쥐지 않게)"
    # yfinance sqlite 캐시가 여러 벌 사이에서 잠겼습니다 — 벌마다 임시 폴더 아래로.
    tmp_root = str(box.tmp / "tmp")
    assert seen["XDG_CACHE_HOME"].startswith(tmp_root) and seen["YFINANCE_CACHE_DIR"].startswith(tmp_root)
    assert int(seen["VITEST_MAX_WORKERS"]) >= 1
    assert box.leftovers() == [], "임시 폴더를 지웁니다"


def test_화면_일꾼_수는_셸에서_준_값이_먼저(box):
    assert box.run(VITEST_MAX_WORKERS="3").returncode == 0
    assert box.make_env()["VITEST_MAX_WORKERS"] == "3"


@pytest.mark.parametrize("rc", [1, 2, 7])
def test_make가_실패해도_down_v를_부르고_종료_코드를_그대로_돌려준다(box, rc):
    r = box.run(FAKE_MAKE_RC=str(rc))
    assert r.returncode == rc, r.stdout + r.stderr
    assert box.docker_calls()[-1].split(" | ")[0].endswith(" down -v --remove-orphans")
    assert box.leftovers() == []


def test_postgres를_띄우지_못하면_make를_부르지_않고_정리한다(box):
    r = box.run(FAKE_DOCKER_FAIL="up")
    assert r.returncode == 1 and "✗" in r.stderr
    assert not any(line.startswith("make ") for line in box.lines())
    assert box.docker_calls()[-1].split(" | ")[0].endswith(" down -v --remove-orphans"), "반쯤 뜬 것도 지웁니다"


@pytest.mark.parametrize(("sig", "rc"), [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_중단되면_make를_멈추고_down_v를_부른다(box, sig, rc):
    proc = box.popen(FAKE_MAKE_SLEEP="60")
    try:
        box.wait_running(proc)
        started = time.monotonic()
        proc.send_signal(sig)
        out, err = proc.communicate(timeout=30)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == rc, out + err
    assert time.monotonic() - started < 20, "가짜 make의 60초를 기다리지 않고 멈춥니다"
    assert box.docker_calls()[-1].split(" | ")[0].endswith(" down -v --remove-orphans")
    assert box.leftovers() == []


def _ignores_sigint(box) -> bool:
    return bool(int(box.make_env()["SIGIGN"], 16) & (1 << (signal.SIGINT - 1)))


@pytest.mark.parametrize("sigint", [signal.SIG_DFL, signal.SIG_IGN])
def test_시험_프로세스는_INT를_무시하지_않는_채로_뜬다(box, sigint):
    # 스크립트가 make를 `&`로 띄우므로 그대로 두면 make 아래 전부가 INT를 무시합니다 — INT를 보내 보는 시험이 멈춥니다.
    # 스크립트 자신이 INT가 무시된 채 불렸을 때(백그라운드 실행)도 같습니다.
    if subprocess.run(["env", "--default-signal=INT,QUIT", "true"], capture_output=True).returncode != 0:
        pytest.skip("이 env는 --default-signal을 모릅니다(coreutils 8.32 미만).")
    r = box.run(sigint=sigint)
    assert r.returncode == 0, r.stdout + r.stderr
    assert not _ignores_sigint(box)


def test_INT가_무시된_채_띄우면_INT로는_멈추지_않고_TERM으로_정리한다(box):
    # 한계를 고정합니다(스크립트 머리·DEVELOPMENT §2): 백그라운드로 띄운 실행은 TERM으로 끝냅니다.
    proc = box.popen(FAKE_MAKE_SLEEP="60", sigint=signal.SIG_IGN)
    try:
        box.wait_running(proc)
        proc.send_signal(signal.SIGINT)
        time.sleep(1.0)
        assert proc.poll() is None, "INT는 무시됩니다(정리 없이 죽지도 않음)"
        assert len(box.docker_calls()) == 2, "아직 정리(down)를 부르지 않았습니다"
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=30)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == 143, out + err
    assert box.docker_calls()[-1].split(" | ")[0].endswith(" down -v --remove-orphans")
    assert box.leftovers() == []


def test_포트가_이미_쓰이고_있으면_알기_쉬운_글로_끝낸다(box):
    port = box.port_base + 1
    with socket.socket() as busy:
        busy.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        busy.bind(("127.0.0.1", port))
        busy.listen(1)
        r = box.run()
    assert r.returncode == 1
    assert "✗" in r.stderr and str(port) in r.stderr and "이미 쓰이고" in r.stderr
    assert not any(" up " in call for call in box.docker_calls()), "남의 포트 위에 띄우려 하지 않습니다"
    assert not any(line.startswith("make ") for line in box.lines())
    # 띄운 적이 없으므로 끝의 정리(down)도 없습니다 — 앞의 찌꺼기 치우기 한 번뿐.
    assert len(box.docker_calls()) == 1


def _hold(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("w")
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return handle


def test_칸은_둘까지이고_다_차면_떠_있는_것을_건드리지_않고_끝낸다(box):
    first = _hold(box.locks / "slot-1.lock")
    try:
        r = box.run()
        assert r.returncode == 0, r.stdout + r.stderr
        # 칸 1이 쓰이고 있으면 칸 2 — 프로젝트 이름과 포트가 다릅니다.
        assert all(call.startswith(_compose_prefix(2) + " ") for call in box.docker_calls())
        assert any(line.startswith(f"make test DATABASE_PORT={box.port_base + 2} ") for line in box.lines())

        box.log.unlink()
        second = _hold(box.locks / "slot-2.lock")
        try:
            r = box.run()
            assert r.returncode == 1 and "✗" in r.stderr and "빈 칸이 없습니다" in r.stderr
            assert box.lines() == [], "칸을 잡지 못하면 docker(down 포함)·make를 부르지 않습니다"
        finally:
            second.close()
    finally:
        first.close()


def test_같은_작업_폴더에서_두_벌은_돌지_않는다(box):
    proc = box.popen(FAKE_MAKE_SLEEP="60")
    try:
        box.wait_running(proc)
        before = box.lines()
        r = box.run()
        assert r.returncode == 1 and "✗" in r.stderr and "이미 격리 시험이 돌고" in r.stderr
        assert box.lines() == before, "두 번째 벌은 아무것도 부르지 않습니다(첫 벌의 postgres를 지우지 않음)"
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=30)
    assert proc.returncode == 143


def test_compose_파일은_postgres_하나를_루프백에만_열고_메모리_상한이_없다():
    compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
    assert list(compose["services"]) == ["postgres"], "make db-test가 `exec -T postgres`를 부릅니다"
    service = compose["services"]["postgres"]
    assert service["ports"] and all(str(port).startswith("127.0.0.1:") for port in service["ports"])
    assert "${TESTDB_PORT:?" in service["ports"][0], "포트 값이 없으면 해석부터 실패해야 합니다(기본 포트로 뜨지 않게)"
    # 떠 있는 로컬 스택의 512m 상한이 여러 벌에서 postgres를 죽였습니다 — 여기에는 두지 않습니다.
    assert "mem_limit" not in service and "deploy" not in service
    # 계정은 저장소의 공개 기본값뿐 — 셸·.env의 값을 읽지 않습니다.
    assert service["environment"]["POSTGRES_USER"] == "macro" and service["environment"]["POSTGRES_PASSWORD"] == "macro"
    assert "volumes" not in service and "volumes" not in compose, "이름 붙은 볼륨을 두지 않습니다(down -v가 익명 볼륨까지 지움)"
    assert "restart" not in service


def test_Makefile의_test_isolated는_스크립트를_부르고_test의_뜻은_그대로():
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "\ntest: test-collector test-backend test-frontend ##" in makefile
    recipe = makefile[makefile.index("\ntest-isolated:"):].split("\n\n", 1)[0]
    assert "bash scripts/test-isolated.sh $(T)" in recipe


def test_CI는_시험용_compose_파일의_루프백을_단언한다():
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    runs = [s.get("run") or "" for job in workflow["jobs"].values() for s in job.get("steps", [])]
    script = next((run for run in runs if "scripts/test/docker-compose.testdb.yml" in run), "")
    assert script, "compose 해석 단계가 시험용 compose 파일을 보지 않습니다"
    lines = [line.strip() for line in script.splitlines() if "testdb" in line]
    assert any("--env-file /dev/null" in line and "config --format json" in line for line in lines)
    assert any('all(.host_ip == "127.0.0.1")' in line for line in lines)
