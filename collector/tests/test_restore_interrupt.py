"""
tests/test_restore_interrupt.py
복원(scripts/db-restore.sh)이 서비스를 멈추고 다시 켜는 순서와, 도중에 끊겼을 때의 다시 켜기.

QA-370: 복원 중 터미널이 닫히면(SIGHUP + 출력이 닫힘) EXIT trap의 첫 줄 ``echo``가 닫힌 출력에 쓰다 실패해(``set -e``) 그 아래의
``docker compose start``에 닿지 못했습니다. 수집기·백엔드는 ``docker compose stop``으로 멈춘 것이라 자동으로 다시 뜨지 않습니다 —
서버에서 실제 매매가 켜진 채 그렇게 되면 DB는 되돌려졌는데 백엔드가 멈춰 있고, 알림도 백엔드가 보내므로 알아챌 수단이 없습니다.

docker는 PATH 앞의 가짜 실행 파일입니다(부른 인자를 기록). psql·pg_dump 클라이언트와 DB가 필요 없어 test_db_scripts.py(이 PC처럼
클라이언트가 없으면 통째로 건너뜀) 밖에 둡니다 — 선례는 test_backup_prune.py.
"""
from __future__ import annotations

import os
import signal
import stat
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RESTORE = ROOT / "scripts" / "db-restore.sh"

# 컨테이너 모드(DB_EXEC 기본값 `docker compose exec -T postgres`)의 docker 대역.
#   ps      — 돌고 있는 서비스 목록
#   pg_dump — 끝 표시가 있는 덤프
#   psql    — FAKE_PSQL_HANG(초)이 있으면 입력을 읽지 않고 그만큼 멈춤(시작 표시 파일을 남김), 없으면 입력을 다 읽고 커밋 표시를 찍음
_FAKE_DOCKER = """#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case " $* " in
    *" compose ps --status running --services "*) printf 'postgres\\ncollector\\nbackend\\nfrontend\\n'; exit 0 ;;
    *" exec -T postgres pg_dump "*) printf '%s\\n' '-- dump' '-- PostgreSQL database dump complete'; exit 0 ;;
    *" exec -T postgres psql "*)
        if [ -n "${FAKE_PSQL_HANG:-}" ]; then
            : > "$FAKE_LOG.psql-started"
            /bin/sleep "$FAKE_PSQL_HANG"
            exit 1
        fi
        cat > /dev/null
        echo "__restore_committed__"
        exit 0 ;;
esac
exit 0
"""


@pytest.fixture()
def restore_env(tmp_path):
    bin_dir, log = tmp_path / "bin", tmp_path / "docker.log"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(_FAKE_DOCKER, encoding="utf-8")
    docker.chmod(docker.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    log.touch()
    env_file = tmp_path / "env"
    env_file.write_text("DATABASE_USER=macro\nDATABASE_NAME=macrodash_restore_probe_test\n", encoding="utf-8")
    dump = tmp_path / "backup.sql"
    dump.write_text("-- dump\nSELECT 1;\n-- PostgreSQL database dump complete\n", encoding="utf-8")
    # 개발자 셸의 DB·compose 값이 끼어들지 않게 최소한의 환경만 넘깁니다. DB_EXEC는 넘기지 않습니다(기본값 = 컨테이너 모드).
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", "HOME": str(tmp_path), "LANG": "C.UTF-8",
           "FAKE_LOG": str(log), "ENV_FILE": str(env_file), "BACKUP_DIR": str(tmp_path / "backups")}
    return env, log, dump


def _calls(log: Path) -> list[str]:
    return log.read_text(encoding="utf-8").splitlines()


def test_QA370_복원_도중_출력이_닫히고_HUP을_받아도_멈춘_서비스를_다시_켠다(restore_env):
    env, log, dump = restore_env
    # 파이썬은 SIGPIPE를 무시합니다. restore_signals=False로 그 상태를 물려주면 닫힌 출력에 쓰는 echo가 신호로 죽지 않고 오류(EPIPE)로
    # 실패합니다 — 닫힌 터미널에 쓸 때(EIO)와 같은 길입니다. start_new_session은 끝난 뒤 남은 자식을 한꺼번에 치우려고.
    proc = subprocess.Popen(["bash", str(RESTORE), str(dump), "--yes"], cwd=ROOT, env={**env, "FAKE_PSQL_HANG": "3"},
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, restore_signals=False, start_new_session=True)
    try:
        started = Path(str(log) + ".psql-started")
        deadline = time.monotonic() + 20
        while not started.exists() and time.monotonic() < deadline and proc.poll() is None:
            time.sleep(0.05)
        assert started.exists(), f"복원 단계(psql)에 닿지 못했습니다: {_calls(log)}"
        assert "compose stop collector backend" in _calls(log)

        proc.stdout.close()                       # 읽는 쪽을 닫음 — 터미널 창이 닫힘
        os.kill(proc.pid, signal.SIGHUP)          # 그리고 끊김 신호
        proc.wait(timeout=30)
        deadline = time.monotonic() + 10          # 다시 켜기는 trap 안에서 돕니다 — 기록이 남을 때까지 잠깐
        while "compose start collector backend" not in _calls(log) and time.monotonic() < deadline:
            time.sleep(0.05)

        assert "compose start collector backend" in _calls(log), f"멈춘 서비스를 다시 켜지 않았습니다: {_calls(log)}"
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)   # 멈춰 있는 가짜 psql과 그 부모 셸
        except ProcessLookupError:
            pass
        proc.wait(timeout=10)


def test_복원이_끝나면_멈춘_서비스를_다시_켠다(restore_env):
    """정상 경로(지금 동작 고정) — 멈춘 것만, 복원 뒤에 다시 켭니다."""
    env, log, dump = restore_env

    result = subprocess.run(["bash", str(RESTORE), str(dump), "--yes"], cwd=ROOT, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60)

    assert result.returncode == 0, result.stdout + result.stderr
    calls = _calls(log)
    stop, start = calls.index("compose stop collector backend"), calls.index("compose start collector backend")
    restore = next(i for i, call in enumerate(calls) if " exec -T postgres psql " in f" {call} ")
    assert stop < restore < start, calls
    assert "복원했습니다" in result.stdout and "다시 켭니다: collector backend" in result.stdout


def test_QA370_다시_켜기가_실패하면_경고를_남긴다(restore_env):
    """다시 켜기의 출력은 버리지만(닫힌 출력에 쓰지 않게) 실패는 알립니다."""
    env, log, dump = restore_env
    docker = Path(env["PATH"].split(os.pathsep)[0]) / "docker"
    docker.write_text(docker.read_text(encoding="utf-8").replace(
        'case " $* " in\n', 'case " $* " in\n    *" compose start "*) echo "boom" >&2; exit 1 ;;\n', 1), encoding="utf-8")

    result = subprocess.run(["bash", str(RESTORE), str(dump), "--yes"], cwd=ROOT, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60)

    assert "compose start collector backend" in _calls(log)
    assert "서비스를 다시 켜지 못했습니다" in result.stderr


def test_QA372_복원_전_안전_백업은_서비스를_멈춘_뒤에_뜬다(restore_env):
    env, log, dump = restore_env

    result = subprocess.run(["bash", str(RESTORE), str(dump), "--yes"], cwd=ROOT, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60)

    assert result.returncode == 0, result.stdout + result.stderr
    calls = _calls(log)
    stop = calls.index("compose stop collector backend")
    safety = next(i for i, call in enumerate(calls) if " exec -T postgres pg_dump " in f" {call} ")
    restore = next(i for i, call in enumerate(calls) if " exec -T postgres psql " in f" {call} ")
    assert stop < safety < restore, f"정지 → 안전 백업 → 복원 순서여야 합니다: {calls}"
    assert len(list(Path(env["BACKUP_DIR"]).glob("pre-restore-*.sql"))) == 1


def test_QA372_안전_백업이_실패하면_복원하지_않고_멈춘_서비스를_다시_켠다(restore_env):
    """안전 백업이 정지 뒤로 가면, 백업 실패 때도 다시 켜기에 닿아야 합니다(순서가 바뀌기 전에는 멈춘 것이 없어 저절로 성립)."""
    env, log, dump = restore_env
    docker = Path(env["PATH"].split(os.pathsep)[0]) / "docker"
    docker.write_text(docker.read_text(encoding="utf-8").replace(
        'case " $* " in\n', 'case " $* " in\n    *" exec -T postgres pg_dump "*) echo "pg_dump: error: boom" >&2; exit 1 ;;\n', 1), encoding="utf-8")

    result = subprocess.run(["bash", str(RESTORE), str(dump), "--yes"], cwd=ROOT, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60)

    calls = _calls(log)
    assert result.returncode != 0 and "복원하지 않았습니다" in result.stderr
    assert not any(" exec -T postgres psql " in f" {call} " for call in calls), "안전 백업 없이 복원하지 않습니다"
    if "compose stop collector backend" in calls:
        assert "compose start collector backend" in calls, f"멈춘 서비스를 다시 켜지 않았습니다: {calls}"
