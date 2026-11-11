"""
tests/test_deploy_migrations.py
QA-016: 스키마 파일만 바뀐 배포에서 새 테이블이 생기지 않던 결함.

스키마 파일(db/migrations)은 수집기에 볼륨으로 들어가고, 수집기가 **기동할 때만** 적용됩니다. 백엔드만 바뀐
배포(예: V4 계정 테이블)에서는 `make up`이 수집기를 다시 만들지 않아 새 파일이 적용되지 않았고, 백엔드는
테이블이 없어 로그인을 받지 못했습니다(QA 스택에서 재현: schema_migrations가 V3에서 멈춤).
`make up`(과 QA 스택 up)이 기동 뒤에 대기 중인 스키마를 늘 적용해야 합니다.

QA-107: 같은 결함이 AWS 데모 배포 절차(README·compose.aws.yml 머리말)에 남아 있었습니다. 절차가 `build --pull`과
`up -d` 두 줄뿐이라, 스키마 파일과 백엔드만 바뀐 릴리스에서는 수집기가 다시 만들어지지 않아 새 스키마가 적용되지
않습니다. 문서에 적힌 배포 명령도 `up -d` 뒤에 스키마를 적용해야 합니다. 서버(Vultr, ADR 0023)에서는 README가
scripts/vultr/deploy.sh를 가리키고(그 스크립트의 스키마 적용은 tests/test_vultr_scripts.py), compose.vultr.yml 머리말에는
손으로 배포할 때의 명령이 남습니다(AWS 개인용 서버 ADR 0019의 compose.aws.yml도 같은 시험을 받다가 2026-11-03에 지움).

QA-118: 그 반복문(`… && break; sleep 3; done`)은 10번 모두 실패해도 마지막 명령이 `sleep`이라 종료 코드 0으로
끝났습니다. 문서는 'make migrate와 같다'고 적지만 make migrate는 경고를 찍고 exit 1입니다. SSM이나 `&&`로 이은
스크립트로 배포하면 스키마가 빠진 배포가 성공으로 보입니다. 문서의 명령을 그대로 셸에 넘겨(docker는 가짜 함수)
실패 경로를 확인합니다.

QA-126: QA 스택(`scripts/qa/qa-stack.sh up`)의 같은 반복문이 그대로 남아, 10번 모두 실패해도 경고 없이 0으로
끝났습니다. 스키마가 빠진 QA 스택이 정상으로 보여 그 위의 시험 결과가 틀어집니다. up 블록의 스키마 적용 부분을
떼어 같은 방법으로 실패·성공 경로를 확인합니다.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
# 서버 덧붙임 — 머리말에 손 배포 명령이 있는 파일(Vultr 서버 ADR 0023)
OVERLAYS = ["compose.vultr.yml"]


def _recipe(makefile: str, target: str) -> str:
    match = re.search(rf"^{re.escape(target)}:.*?\n((?:\t.*\n|\s*\n)*)", makefile, re.M)
    assert match, f"Makefile에 {target} 타깃이 없습니다"
    return match.group(1)


def test_QA016_make_up은_기동_뒤_대기_중인_스키마를_적용한다():
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "migrate" in _recipe(makefile, "up")
    assert "init_schema" in _recipe(makefile, "migrate")


def test_QA016_QA_스택_up도_스키마를_적용한다():
    script = (ROOT / "scripts/qa/qa-stack.sh").read_text(encoding="utf-8")
    up = script[script.index("  up)"):script.index(";;", script.index("  up)"))]
    assert "init_schema" in up


def _server_readme_blocks() -> list[str]:
    """README '### Vultr 서버' 절의 bash 블록들."""
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    section = readme[readme.index("### Vultr 서버"):]
    section = section[:section.index("\n## ")]
    return [chunk.split("```", 1)[0] for chunk in section.split("```bash")[1:]]


def _header_commands(overlay: str) -> str:
    """서버 덧붙임 머리말의 배포 명령 블록(첫 docker compose 줄부터 빈 주석 줄 앞까지, 이어지는 줄 포함)."""
    text = (ROOT / overlay).read_text(encoding="utf-8")
    block = text[text.index("docker compose"):text.index("\nservices:")]
    return block[:block.index("\n#\n")]


def test_QA107_README의_서버_배포는_deploy_sh이고_손으로_적은_up_뒤에는_스키마를_적용한다():
    blocks = _server_readme_blocks()
    assert any("scripts/vultr/deploy.sh" in block for block in blocks), "README가 서버 배포 명령(deploy.sh)을 보여야 합니다"
    for block in blocks:
        if " up -d" in block:
            assert "init_schema" in block[block.index(" up -d"):], "README: up -d 뒤에 스키마 적용(init_schema)이 없습니다"


@pytest.mark.parametrize("overlay", OVERLAYS)
def test_QA107_서버_덧붙임_머리말의_손_배포도_up_뒤에_스키마를_적용한다(overlay):
    commands = _header_commands(overlay)
    up = commands.index(" up -d")
    assert "init_schema" in commands[up:], f"{overlay}: up -d 뒤에 스키마 적용(init_schema)이 없습니다"
    # 수집기가 막 다시 만들어진 직후에는 exec가 실패할 수 있어 make migrate처럼 기다렸다 다시 시도합니다.
    schema_line = next(line for line in commands[up:].splitlines() if "init_schema" in line)
    assert "sleep" in schema_line, f"{overlay}: 스키마 적용에 재시도가 없습니다"


def test_QA107_docker_compose_머리말의_실행_안내는_make_up():
    text = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    run_line = next(line for line in text.splitlines() if line.startswith("# 실행:"))
    assert "make up" in run_line


def _schema_snippet(overlay: str) -> str:
    """서버 덧붙임 머리말의 `up -d` 다음 줄부터의 스키마 적용 명령(이어지는 줄 포함) — 주석 표시를 떼고 '↑' 설명 앞까지."""
    commands = _header_commands(overlay)
    lines = commands[commands.index(" up -d"):].splitlines()[1:]
    out: list[str] = []
    for line in lines:
        line = re.sub(r"^#", "", line)
        if line.strip().startswith("↑"):
            break
        out.append(line)
    return "\n".join(out)


# docker는 가짜 함수(부른 횟수만 셈), sleep은 바로 돌아옴. 끝나면 종료 코드와 부른 횟수를 남깁니다.
_FAKE = "calls=0\ndocker() {{ calls=$((calls+1)); return {rc}; }}\nsleep() {{ :; }}\n"
_REPORT = '\nrc=$?\necho "calls=$calls"\nexit $rc\n'
_SHELLS = [s for s in ("/bin/bash", "/bin/sh") if Path(s).exists()]   # 맥의 /bin/bash는 3.2


def _run_schema(overlay: str, shell: str, docker_rc: int) -> subprocess.CompletedProcess:
    script = _FAKE.format(rc=docker_rc) + _schema_snippet(overlay) + _REPORT
    return subprocess.run([shell, "-c", script], capture_output=True, text=True, timeout=30)


@pytest.mark.parametrize("overlay", OVERLAYS)
@pytest.mark.parametrize("shell", _SHELLS)
def test_QA118_스키마_적용이_10번_모두_실패하면_알리고_0이_아닌_값으로_끝난다(shell, overlay):
    result = _run_schema(overlay, shell, docker_rc=1)
    assert "calls=10" in result.stdout, f"10번 다시 시도해야 합니다 — {result.stdout!r} {result.stderr!r}"
    assert result.returncode != 0, f"{overlay}({shell}): 10번 모두 실패했는데 종료 코드 0 — 배포가 성공으로 보입니다"
    assert "스키마" in result.stderr, "실패를 사람에게도 알려야 합니다(make migrate의 경고처럼)"


@pytest.mark.parametrize("overlay", OVERLAYS)
@pytest.mark.parametrize("shell", _SHELLS)
def test_QA118_스키마_적용이_성공하면_한_번으로_끝나고_0이다(shell, overlay):
    result = _run_schema(overlay, shell, docker_rc=0)
    assert result.returncode == 0, f"{overlay}({shell}): {result.stdout!r} {result.stderr!r}"
    assert "calls=1" in result.stdout
    assert result.stderr == ""


# 실패할 때 원인 한 줄을 stderr에 쓰는 docker(실제 `docker compose exec … init_schema()`의 Python 예외 자리). 성공하면 아무것도 쓰지 않습니다.
_FAKE_LOUD = ("calls=0\ndocker() {{ calls=$((calls+1)); [ {rc} = 0 ] || echo 'psycopg.errors.Fake: V99 failed' >&2; return {rc}; }}\n"
              "sleep() {{ :; }}\n")


def _qa_stack_schema_snippet() -> str:
    """qa-stack.sh up 블록에서 `docker compose up -d --build` 다음 줄부터 `docker compose ps` 줄 앞까지(스키마 적용)."""
    script = (ROOT / "scripts/qa/qa-stack.sh").read_text(encoding="utf-8")
    up = script[script.index("  up)"):script.index(";;", script.index("  up)"))]
    lines = up.splitlines()
    start = next(i for i, line in enumerate(lines) if "docker compose up -d --build" in line) + 1
    end = next(i for i, line in enumerate(lines) if line.strip() == "docker compose ps")
    return "\n".join(lines[start:end])


def _run_qa_stack_schema(shell: str, docker_rc: int) -> subprocess.CompletedProcess:
    script = _FAKE.format(rc=docker_rc) + _qa_stack_schema_snippet() + _REPORT
    return subprocess.run([shell, "-c", script], capture_output=True, text=True, timeout=30)


@pytest.mark.parametrize("shell", _SHELLS)
def test_QA126_QA_스택_up의_스키마_적용이_10번_모두_실패하면_알리고_0이_아닌_값으로_끝난다(shell):
    result = _run_qa_stack_schema(shell, docker_rc=1)
    assert "calls=10" in result.stdout, f"10번 다시 시도해야 합니다 — {result.stdout!r} {result.stderr!r}"
    assert result.returncode != 0, f"qa-stack.sh({shell}): 10번 모두 실패했는데 종료 코드 0 — 스키마 없는 QA 스택이 정상으로 보입니다"
    assert "스키마" in result.stderr, "실패를 사람에게도 알려야 합니다(make migrate의 경고처럼)"


@pytest.mark.parametrize("shell", _SHELLS)
def test_QA126_QA_스택_up의_스키마_적용이_성공하면_한_번으로_끝나고_0이다(shell):
    result = _run_qa_stack_schema(shell, docker_rc=0)
    assert result.returncode == 0, f"qa-stack.sh({shell}): {result.stdout!r} {result.stderr!r}"
    assert "calls=1" in result.stdout
    assert result.stderr == ""


# ------------------------------------------------------------------ QA-373: 실패의 원인을 버리지 않는다
# 스키마 적용 명령의 출력을 버리고 10번 실패하면 '수집기 로그를 보세요'라고 했는데, 그 출력은 컨테이너 로그에 남지 않습니다(수집기가
# 그대로이고 이 명령이 그 스키마 파일을 처음 적용하다 실패할 때). 마지막 시도의 오류는 그대로 보여 줍니다 — 앞의 아홉 번은 조용히.
@pytest.mark.parametrize("shell", _SHELLS)
def test_QA373_QA_스택_up의_스키마_적용이_실패하면_마지막_시도의_원인을_보여_준다(shell):
    script = _FAKE_LOUD.format(rc=1) + _qa_stack_schema_snippet() + _REPORT
    result = subprocess.run([shell, "-c", script], capture_output=True, text=True, timeout=30)
    assert "calls=10" in result.stdout and result.returncode != 0
    assert result.stderr.count("psycopg.errors.Fake: V99 failed") == 1, result.stderr
    assert "스키마" in result.stderr


@pytest.mark.parametrize("shell", _SHELLS)
def test_QA373_QA_스택_up의_스키마_적용이_성공하면_조용하다(shell):
    script = _FAKE_LOUD.format(rc=0) + _qa_stack_schema_snippet() + _REPORT
    result = subprocess.run([shell, "-c", script], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0 and "calls=1" in result.stdout and result.stderr == ""


def _make_migrate(tmp_path: Path, rc: str) -> tuple[subprocess.CompletedProcess, list[str]]:
    """저장소 Makefile의 migrate를 가짜 docker·sleep으로 돌립니다(임시 폴더, .env 없음)."""
    import shutil

    from tests import fake_server_tools as tools

    if shutil.which("make") is None:
        pytest.skip("make가 없어 건너뜁니다.")
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    tools._write_exec(bin_dir / "docker", tools._FAKE_DOCKER)
    tools._write_exec(bin_dir / "sleep", tools._FAKE_SLEEP)
    log.touch()
    env = tools._env((bin_dir, log), FAKE_EXEC_RC=rc, FAKE_EXEC_ERROR="psycopg.errors.Fake: V99 failed")
    result = subprocess.run(["make", "--no-print-directory", "-C", str(tmp_path), "-f", str(ROOT / "Makefile"), "migrate"],
                            env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    return result, [line.split(" | ")[0] for line in tools._calls((bin_dir, log))]


def test_QA373_make_migrate가_실패하면_마지막_시도의_원인을_보여_준다(tmp_path):
    result, calls = _make_migrate(tmp_path, "1")
    assert result.returncode != 0
    assert len([call for call in calls if "init_schema" in call]) == 10
    assert (result.stdout + result.stderr).count("psycopg.errors.Fake: V99 failed") == 1, result.stdout + result.stderr
    assert "스키마를 적용하지 못했습니다" in result.stdout + result.stderr


def test_make_migrate가_성공하면_한_번으로_끝난다(tmp_path):
    """지금 동작 고정."""
    result, calls = _make_migrate(tmp_path, "0")
    assert result.returncode == 0, result.stdout + result.stderr
    assert len([call for call in calls if "init_schema" in call]) == 1
    assert "스키마: 최신" in result.stdout and result.stderr == ""
