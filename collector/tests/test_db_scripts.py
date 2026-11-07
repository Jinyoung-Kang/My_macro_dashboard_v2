"""
tests/test_db_scripts.py
DB 백업·복원 스크립트(scripts/db-backup.sh · scripts/db-restore.sh).

[왜 필요한가]
예전 `make restore`는 데이터가 있는 DB에 덤프를 그대로 부었습니다. 덤프에는 기존 표를 지우는
문장이 없어 CREATE·COPY가 오류 21건으로 실패했는데도 psql은 0으로 끝났고, 값은 백업 시점으로
돌아오지 않았습니다. `make backup`도 pg_dump가 실패하면 0바이트 파일을 남기고 0으로 끝났습니다.

고정하는 것
  - 복원하면 DB가 **백업 시점과 같아진다** (값·행 수 모두)
  - 복원 전에 지금 DB를 먼저 백업해 둔다
  - 복원 도중 실패하면 **아무것도 바뀌지 않는다** (한 트랜잭션)
  - 입력이 중간에 끊겨도(창을 닫음·Ctrl-C·읽기 오류) 반쯤 복원된 상태를 확정하지 않는다
  - 끝까지 기록되지 않은 백업·확인 없는 실행은 거부한다
  - 백업이 실패하면 파일을 남기지 않고 0이 아닌 코드로 끝난다
  - 실제 매매 표(ADR 0028, RESTORE_REAL_TRADE): halt(기본)는 꺼지지 않은 설정만 이상 멈춤(restored)으로 바꾸고 기록은 그대로,
    clear(QA)는 기록을 비우고 설정을 꺼짐으로, 그 밖의 값은 시작하지 않고, 표가 없는 백업은 그 단계를 건너뛰고,
    멈추지 못하면 복원 전체를 되돌린다

각 테스트는 전용 임시 데이터베이스를 만들어 씁니다. 복원은 public 스키마를 통째로
바꾸므로, 다른 테스트가 쓰는 테스트 DB를 건드리면 안 됩니다.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse

import psycopg
import pytest

from app import migrations

ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / "scripts" / "db-backup.sh"
RESTORE = ROOT / "scripts" / "db-restore.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("pg_dump") is None or shutil.which("psql") is None,
    reason="pg_dump·psql 클라이언트가 없어 백업·복원 스크립트 테스트를 건너뜁니다.",
)


@pytest.fixture()
def scratch_db(database_url):
    """이 테스트만 쓰는 데이터베이스. 저장소의 마이그레이션을 적용한 상태로 줍니다."""
    name = f"scripts_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    url = urlparse(database_url)
    db_url = url._replace(path=f"/{name}").geturl()
    with psycopg.connect(db_url, autocommit=True) as conn:
        migrations.apply_pending(conn, migrations.discover(ROOT / "db" / "migrations"))
    try:
        yield name, db_url
    finally:
        with psycopg.connect(database_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def _env(database_url: str, db_name: str, backup_dir: Path) -> dict[str, str]:
    """스크립트가 컨테이너 대신 테스트 DB에 직접 붙도록 하는 환경."""
    url = urlparse(database_url)
    env = dict(os.environ)
    env.update({
        "DB_EXEC": "",                      # docker compose exec 없이 psql·pg_dump를 바로 실행
        "RESTORE_STOP_SERVICES": "",        # 테스트에는 멈출 컨테이너가 없습니다
        "DATABASE_USER": url.username or "macro",
        "DATABASE_NAME": db_name,
        "PGHOST": url.hostname or "localhost",
        "PGPORT": str(url.port or 5432),
        "PGPASSWORD": url.password or "",
        "BACKUP_DIR": str(backup_dir),
    })
    return env


def _run(script: Path, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script), *args], env=env, cwd=ROOT,
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120,
    )


def _snapshot_values(db_url: str) -> dict[str, str | None]:
    with psycopg.connect(db_url) as conn:
        rows = conn.execute("SELECT name, payload->>'v' FROM snapshots ORDER BY name").fetchall()
    return {name: value for name, value in rows}


def _set(db_url: str, sql: str) -> None:
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(sql)


def _backups(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.sql"))


# ------------------------------------------------------------------------ 백업
def test_백업이_실패하면_파일을_남기지_않고_실패로_끝난다(database_url, tmp_path):
    result = _run(BACKUP, env=_env(database_url, "no_such_database_for_backup", tmp_path))

    assert result.returncode != 0
    assert list(tmp_path.iterdir()) == []            # 0바이트 .sql도, .partial도 남지 않습니다
    assert "백업 실패" in result.stderr


def test_백업은_끝까지_기록된_덤프를_남긴다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('a', '{\"v\":\"1\"}', now())")

    result = _run(BACKUP, env=_env(database_url, name, tmp_path))

    assert result.returncode == 0, result.stderr
    files = _backups(tmp_path)
    assert len(files) == 1
    assert "PostgreSQL database dump complete" in files[0].read_text(encoding="utf-8")


# ------------------------------------------------------------------------ 복원
def test_복원하면_백업_시점과_같아지고_복원_전_상태도_남긴다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _env(database_url, name, tmp_path)
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('macro', '{\"v\":\"backup-time\"}', now())")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]

    # 백업 뒤에 값이 망가지고 행이 늘었습니다.
    _set(db_url, "UPDATE snapshots SET payload = '{\"v\":\"corrupted\"}'")
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('extra', '{}', now())")

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _snapshot_values(db_url) == {"macro": "backup-time"}
    safety = [f for f in _backups(tmp_path) if f.name.startswith("pre-restore-")]
    assert len(safety) == 1                          # 되돌릴 수 있게 복원 직전 상태를 남깁니다
    assert "corrupted" in safety[0].read_text(encoding="utf-8")


def test_복원_도중_실패하면_아무것도_바뀌지_않는다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _env(database_url, name, tmp_path)
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('macro', '{\"v\":\"before\"}', now())")
    assert _run(BACKUP, env=env).returncode == 0
    good = _backups(tmp_path)[0]
    broken = tmp_path / "broken.sql.txt"
    # 끝 표시는 그대로 두고 중간 문장만 망가뜨립니다(복원이 중간까지 진행된 뒤 실패하는 상황).
    broken.write_text(good.read_text(encoding="utf-8").replace(
        "CREATE TABLE public.snapshots", "CREATE TABLEX public.snapshots", 1), encoding="utf-8")
    _set(db_url, "UPDATE snapshots SET payload = '{\"v\":\"current\"}'")

    result = _run(RESTORE, str(broken), "--yes", env=env)

    assert result.returncode != 0
    assert _snapshot_values(db_url) == {"macro": "current"}   # 스키마를 지운 것까지 되돌아갔습니다


def test_끝까지_기록되지_않은_백업은_복원하지_않는다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _env(database_url, name, tmp_path)
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('macro', '{\"v\":\"current\"}', now())")
    truncated = tmp_path / "truncated.sql.txt"
    truncated.write_text("-- PostgreSQL database dump\nCREATE TABLE public.x (id int);\n", encoding="utf-8")

    result = _run(RESTORE, str(truncated), "--yes", env=env)

    assert result.returncode != 0
    assert _snapshot_values(db_url) == {"macro": "current"}
    assert _backups(tmp_path) == []                  # 시작도 하지 않았으므로 안전 백업도 없습니다


def test_확인_없이는_복원하지_않는다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _env(database_url, name, tmp_path)
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('macro', '{\"v\":\"current\"}', now())")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _set(db_url, "UPDATE snapshots SET payload = '{\"v\":\"changed\"}'")

    result = _run(RESTORE, str(backup_file), env=env)   # --yes 없음, 표준입력은 터미널이 아님

    assert result.returncode != 0
    assert _snapshot_values(db_url) == {"macro": "changed"}


def test_입력이_중간에_끊기면_반쯤_복원된_상태를_확정하지_않는다(database_url, scratch_db, tmp_path):
    """
    psql은 --single-transaction이어도 입력이 오류 없이 끝나면(EOF) COMMIT을 보냅니다. 복원 중에
    터미널을 닫거나 Ctrl-C를 누르면 컨테이너 안의 psql은 입력이 끊긴 채로 남아, 스키마를 지우고
    일부만 적재한 상태가 확정될 수 있었습니다. 입력을 COPY 한가운데서 끊어 그 상황을 흉내냅니다.
    """
    name, db_url = scratch_db
    env = _env(database_url, name, tmp_path)
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES "
                 "('a', '{\"v\":\"1\"}', now()), ('b', '{\"v\":\"2\"}', now())")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _set(db_url, "DELETE FROM snapshots; INSERT INTO snapshots(name, payload, collected_at) "
                 "VALUES ('macro', '{\"v\":\"current\"}', now())")

    # psql에만 표준입력을 "snapshots의 첫 데이터 줄"까지 넘기고 끊습니다(pg_dump는 그대로).
    wrapper = tmp_path / "cut-stdin.sh"
    wrapper.write_text(
        "#!/bin/bash\n"
        'if [ "$1" = "psql" ]; then\n'
        "  awk '{print} /^COPY public\\.snapshots /{getline; print; exit}' | \"$@\"\n"
        "else\n"
        '  exec "$@"\n'
        "fi\n", encoding="utf-8")
    wrapper.chmod(0o755)
    env["DB_EXEC"] = str(wrapper)

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode != 0
    assert "복원했습니다" not in result.stdout
    assert _snapshot_values(db_url) == {"macro": "current"}   # 스키마를 지운 것까지 되돌아갔습니다


def test_복원은_돌고_있는_서비스를_멈췄다가_다시_켠다(database_url, scratch_db, tmp_path):
    """
    컨테이너 모드에서는 쓰기가 겹치지 않게 수집기·백엔드를 멈춥니다. 예전에는
    `docker compose ps … | grep -q`를 pipefail 아래에서 써서, grep이 먼저 찾고 끝나면 docker가
    SIGPIPE로 죽어 "돌고 있지 않음"으로 판정 — 수집기를 멈추지 않고 복원했습니다.
    가짜 docker가 첫 줄을 쓴 뒤 잠시 쉬었다가 나머지를 써서 그 상황을 만듭니다.
    """
    name, db_url = scratch_db
    env = _env(database_url, name, tmp_path)
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('macro', '{\"v\":\"1\"}', now())")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker.log"
    fake_docker = bin_dir / "docker"
    fake_docker.write_text(
        "#!/bin/bash\n"
        'echo "$*" >> "$DOCKER_LOG"\n'
        'if [ "$1 $2" = "compose ps" ]; then echo collector; sleep 0.3; echo backend; echo frontend; fi\n',
        encoding="utf-8")
    fake_docker.chmod(0o755)
    passthrough = tmp_path / "passthrough.sh"          # 컨테이너 모드로 돌리되 psql·pg_dump는 바로 실행
    passthrough.write_text('#!/bin/bash\nexec "$@"\n', encoding="utf-8")
    passthrough.chmod(0o755)
    env.update({
        "DB_EXEC": str(passthrough),
        "RESTORE_STOP_SERVICES": "collector backend",
        "PATH": f"{bin_dir}:{env['PATH']}",
        "DOCKER_LOG": str(log),
    })

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    calls = log.read_text(encoding="utf-8").splitlines()
    assert "compose stop collector backend" in calls
    assert "compose start collector backend" in calls


@pytest.mark.parametrize("line", [
    'DATABASE_NAME="{name}"',
    "DATABASE_NAME='{name}'",
    "DATABASE_NAME={name}  # 로컬 DB",
    "DATABASE_NAME={name}\r",
])
def test_env_파일의_값을_docker_compose와_같게_읽는다(database_url, scratch_db, tmp_path, line):
    """따옴표·줄 끝 주석·윈도 줄바꿈이 있어도 compose가 읽는 DB 이름과 같은 DB를 백업합니다."""
    name, _ = scratch_db
    env = _env(database_url, name, tmp_path)
    env.pop("DATABASE_NAME")
    env_file = tmp_path / "test.env"
    env_file.write_bytes(("DATABASE_USER=macro\n" + line.format(name=name) + "\n").encode("utf-8"))
    env["ENV_FILE"] = str(env_file)

    result = _run(BACKUP, env=env)

    assert result.returncode == 0, result.stderr
    assert _backups(tmp_path)[0].name.startswith(f"{name}-")


# ------------------------------------------------------------------------ 실제 매매 표(ADR 0028)
def _real_trade_env(database_url: str, db_name: str, backup_dir: Path, **extra: str) -> dict[str, str]:
    """실제 매매 표 시험의 환경 — 개발자 셸의 RESTORE_REAL_TRADE·.env가 끼어들지 않게 합니다."""
    env = _env(database_url, db_name, backup_dir)
    env.pop("RESTORE_REAL_TRADE", None)
    env["ENV_FILE"] = os.devnull
    env.update(extra)
    return env


def _seed_real_trade(db_url: str, kr_state: str = "LIVE") -> None:
    """합성 자료 — KR 설정은 kr_state(꺼지지 않음), US 설정은 꺼짐(OFF), 묶음·주문·이벤트 하나씩. 계좌·토스 주문 번호는 없습니다."""
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO real_trade_config(market, state, source_book, book_generation, baseline_equity, buys_paused,"
            " sync_pending, halt_reason, version) VALUES"
            " ('KR', %s, 'kr_claude2', '2026-10-30', 12345678.00, true, true, %s, 3),"
            " ('US', 'OFF', NULL, NULL, NULL, false, false, NULL, 7)",
            (kr_state, "loss-limit" if kr_state == "HALTED" else None))
        batch_columns = {row[0] for row in conn.execute(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = 'real_trade_batches'")}
        columns, values = ["market", "session", "kind", "source_book"], ["KR", "2026-11-09", "SYNC", "kr_claude2"]
        if "book_generation" in batch_columns:   # 묶음에 책 세대를 싣는 판
            columns.append("book_generation")
            values.append("2026-10-30")
        batch_id = conn.execute(
            f"INSERT INTO real_trade_batches({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(values))}) RETURNING id",
            values).fetchone()[0]
        conn.execute(
            "INSERT INTO real_trade_orders(market, session, purpose, batch_id, source_book, book_generation, symbol, side,"
            " quantity, time_in_force, client_order_id, request_body, send_outcome, first_sent_at)"
            " VALUES ('KR', '2026-11-09', 'SYNC', %s, 'kr_claude2', '2026-10-30', '000000', 'BUY', 1, 'OPG',"
            " '00000000-0000-0000-0000-000000000000', '{}', 'ACCEPTED', now())", (batch_id,))
        conn.execute("INSERT INTO real_trade_events(market, kind) VALUES ('KR', 'ENABLE')")
        if conn.execute("SELECT to_regclass('public.real_trade_valuation')").fetchone()[0] is not None:   # V29 — 마지막 운용 평가액
            conn.execute("INSERT INTO real_trade_valuation(market, fetched_at, equity) VALUES ('KR', now(), 1.00)")


def _real_trade_counts(db_url: str) -> tuple[int, int, int]:
    with psycopg.connect(db_url) as conn:
        return conn.execute("SELECT (SELECT count(*) FROM real_trade_orders), (SELECT count(*) FROM real_trade_batches),"
                            " (SELECT count(*) FROM real_trade_events)").fetchone()


def _real_trade_config(db_url: str, columns: str) -> list[tuple]:
    with psycopg.connect(db_url) as conn:
        return conn.execute(f"SELECT market, {columns} FROM real_trade_config ORDER BY market").fetchall()


@pytest.mark.parametrize("kr_state", ["LIVE", "STOPPING", "HALTED"])
def test_복원은_꺼지지_않은_실제_매매_설정만_이상_멈춤으로_바꾸고_기록은_그대로_둔다(database_url, scratch_db, tmp_path,
                                                                                     kr_state):
    """백업 시점 뒤에 토스로 나간 실제 주문의 기록이 빠진 채 따라 하기가 이어지지 않게 — 꺼진 시장은 그대로 둡니다."""
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    _seed_real_trade(db_url, kr_state)
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _set(db_url, "UPDATE real_trade_config SET state = 'OFF', version = 99")     # 백업 뒤의 변경은 복원이 되돌림

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _real_trade_config(db_url, "state, halt_reason, version, updated_by") == [
        ("KR", "HALTED", "restored", 4, None),
        ("US", "OFF", None, 7, None),                                              # 꺼진 행은 버전도 그대로
    ]
    assert _real_trade_config(db_url, "source_book, baseline_equity, buys_paused, sync_pending") == [
        ("KR", "kr_claude2", Decimal("12345678.00"), True, True),
        ("US", None, None, False, False),
    ]
    assert _real_trade_counts(db_url) == (1, 1, 1)                                 # 주문·묶음·이벤트 기록은 그대로
    assert "실제 매매 설정 1개 시장을 이상 멈춤(restored)으로" in result.stdout
    assert "__real_trade_rows__" not in result.stdout + result.stderr


def test_QA_복원은_실제_매매_기록을_비우고_설정을_꺼짐으로_둔다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path, RESTORE_REAL_TRADE="clear")
    _seed_real_trade(db_url, "LIVE")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _real_trade_counts(db_url) == (0, 0, 0)
    with psycopg.connect(db_url) as conn:                   # V29 마지막 운용 평가액도 비움
        assert conn.execute("SELECT count(*) FROM real_trade_valuation").fetchone()[0] == 0
    assert _real_trade_config(db_url, "state, baseline_equity, buys_paused, sync_pending, halt_reason, version") == [
        ("KR", "OFF", None, False, False, None, 4),
        ("US", "OFF", None, False, False, None, 8),
    ]
    assert "꺼짐(OFF)으로 두었습니다" in result.stdout
    assert "__real_trade_rows__" not in result.stdout + result.stderr


def test_복원_halt는_오늘까지의_ISA_스탑_지시를_건너뜀으로_닫는다(database_url, scratch_db, tmp_path):
    """R13(ADR 0033) — 백업 뒤에 이미 알린 장중 스탑을 복원한 DB가 다시 알리지 않게, 오늘(KST)까지의 PLANNED 스탑 지시만 닫습니다."""
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute("INSERT INTO manual_accounts(code, label, market, source_book, state, started_at, start_cash)"
                     " VALUES ('isa', 'ISA', 'KR', 'kr_rules', 'ACTIVE', now(), 1000)")
        conn.execute(
            "INSERT INTO manual_stop_instructions(account, session, paper_order_id, symbol, quantity, timing, target_at, status) VALUES"
            " ('isa', (now() AT TIME ZONE 'Asia/Seoul')::date, 1, '000000', 1, 'MARKET', now(), 'PLANNED'),"
            " ('isa', (now() AT TIME ZONE 'Asia/Seoul')::date - 1, 2, '000000', 1, 'NEXT_CLOSE', now(), 'PLANNED'),"
            " ('isa', (now() AT TIME ZONE 'Asia/Seoul')::date + 3, 3, '000000', 1, 'AT_MINUTE', now(), 'PLANNED'),"
            " ('isa', (now() AT TIME ZONE 'Asia/Seoul')::date, 4, '000000', 1, 'MARKET', now(), 'RECORDED')")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    with psycopg.connect(db_url) as conn:
        rows = conn.execute("SELECT paper_order_id, status, reason ->> 'autoNote' FROM manual_stop_instructions ORDER BY paper_order_id").fetchall()
    assert rows == [(1, "SKIPPED", "restored"), (2, "SKIPPED", "restored"), (3, "PLANNED", None), (4, "RECORDED", None)]


@pytest.mark.parametrize("mode", ["wipe", "HALT", "clear;"])
def test_RESTORE_REAL_TRADE가_halt·clear가_아니면_시작하지_않는다(database_url, scratch_db, tmp_path, mode):
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    _seed_real_trade(db_url, "LIVE")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _set(db_url, "UPDATE real_trade_config SET version = 99 WHERE market = 'KR'")

    result = _run(RESTORE, str(backup_file), "--yes", env={**env, "RESTORE_REAL_TRADE": mode})

    assert result.returncode != 0
    assert "halt 또는 clear" in result.stderr
    assert [f for f in _backups(tmp_path) if f.name.startswith("pre-restore-")] == []   # 복원 전 백업도 뜨지 않음
    assert _real_trade_config(db_url, "state, version") == [("KR", "LIVE", 99), ("US", "OFF", 7)]


@pytest.mark.parametrize("mode", ["halt", "clear"])
def test_실제_매매_표가_없는_백업은_그_단계를_건너뛴다(database_url, scratch_db, tmp_path, mode):
    """V24 전의 백업 — 표가 없으면 아무것도 하지 않고 복원은 그대로 성공합니다."""
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path, RESTORE_REAL_TRADE=mode)
    _set(db_url, "DROP TABLE real_trade_orders, real_trade_batches, real_trade_events, real_trade_config")
    _set(db_url, "INSERT INTO snapshots(name, payload, collected_at) VALUES ('macro', '{\"v\":\"backup-time\"}', now())")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _set(db_url, "UPDATE snapshots SET payload = '{\"v\":\"changed\"}'")

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _snapshot_values(db_url) == {"macro": "backup-time"}
    assert "실제 매매" not in result.stdout


def test_실제_매매_설정을_멈추지_못하면_복원_전체를_되돌린다(database_url, scratch_db, tmp_path):
    """멈추는 문장이 실패하는 백업(열이 다른 표) — 멈추지 못한 채 복원하지 않고, DB는 복원 전 그대로입니다."""
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    _seed_real_trade(db_url, "LIVE")
    _set(db_url, "ALTER TABLE real_trade_config DROP COLUMN halt_reason")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _set(db_url, "UPDATE real_trade_config SET source_book = 'after-backup' WHERE market = 'KR'")

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode != 0
    assert "복원했습니다" not in result.stdout
    assert _real_trade_config(db_url, "state, source_book") == [("KR", "LIVE", "after-backup"), ("US", "OFF", None)]


# ------------------------------------------------------------------------ OPS-4: 복원 전(지금) DB와 견줌
# halt의 멈춤은 백업 쪽 상태만 봅니다. 켜기 전(또는 V24 전) 백업을 복원하면 조용히 꺼짐(OFF)이 되고, 지금 DB가 추적하던 토스 미체결은
# 이 기능이 더 취소하지 않습니다. 복원은 같은 트랜잭션에서 지금 DB의 상태를 읽어 두었다가 그때 경고합니다(시장:상태만 — 건수·종목 없음).
_OPS4_ORDER_ID = "11111111-1111-1111-1111-111111111111"


def _turn_on_after_backup(db_url: str, kr_state: str) -> None:
    """백업 뒤에 켜고(또는 끄는 중·이상 멈춤) 시가 맞추기 주문 하나가 토스에 접수된 채 끝나지 않은 지금 DB."""
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO real_trade_config(market, state, source_book, book_generation, halt_reason, version)"
            " VALUES ('KR', %s, 'kr_rules', '2026-10-30', %s, 5)"
            " ON CONFLICT (market) DO UPDATE SET state = EXCLUDED.state, source_book = EXCLUDED.source_book,"
            " book_generation = EXCLUDED.book_generation, halt_reason = EXCLUDED.halt_reason",
            (kr_state, "repeated-error" if kr_state == "HALTED" else None))
        batch_id = conn.execute(
            "INSERT INTO real_trade_batches(market, session, kind, source_book) VALUES ('KR', '2026-11-10', 'SYNC', 'kr_rules')"
            " ON CONFLICT (market, session, kind) DO UPDATE SET updated_at = now() RETURNING id").fetchone()[0]
        conn.execute(
            "INSERT INTO real_trade_orders(market, session, purpose, batch_id, source_book, book_generation, symbol, side,"
            " quantity, time_in_force, client_order_id, request_body, send_outcome, first_sent_at)"
            " VALUES ('KR', '2026-11-10', 'SYNC', %s, 'kr_rules', '2026-10-30', '000000', 'BUY', 1, 'OPG', %s, '{}', 'ACCEPTED', now())",
            (batch_id, _OPS4_ORDER_ID))


@pytest.mark.parametrize("kr_state", ["LIVE", "STOPPING", "HALTED"])
def test_OPS4_켜기_전_백업을_복원하면_복원_전_DB가_꺼져_있지_않았다고_경고한다(database_url, scratch_db, tmp_path, kr_state):
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    _set(db_url, "INSERT INTO real_trade_config(market, state) VALUES ('US', 'OFF')")      # 켜기 전 — KR 행 없음(꺼짐)
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _turn_on_after_backup(db_url, kr_state)

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _real_trade_config(db_url, "state") == [("US", "OFF")]                          # 백업 그대로 — 꺼짐(새 주문 없음)
    assert f"경고: 복원 전 DB에서 실제 매매가 꺼져 있지 않았는데(KR:{kr_state})" in result.stdout
    assert "끝나지 않았던 실제 주문 가운데 복원한 DB에 없는 것" in result.stdout
    assert "토스증권 앱에서 미체결 주문을 직접 확인·취소" in result.stdout
    assert _OPS4_ORDER_ID not in result.stdout + result.stderr and "000000" not in result.stdout + result.stderr
    assert "__real_trade_" not in result.stdout + result.stderr


def test_OPS4_V24_전_백업을_복원해도_복원_전_DB가_켜져_있었다고_경고한다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    _set(db_url, "DROP TABLE real_trade_orders, real_trade_batches, real_trade_events, real_trade_config")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _set(db_url, (ROOT / "db" / "migrations" / "V24__real_trade.sql").read_text(encoding="utf-8"))   # 그 뒤 V24 적용·켜기
    _turn_on_after_backup(db_url, "LIVE")

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    with psycopg.connect(db_url) as conn:
        assert conn.execute("SELECT to_regclass('public.real_trade_config')").fetchone()[0] is None   # 백업 그대로 — 표 없음
    assert "경고: 복원 전 DB에서 실제 매매가 꺼져 있지 않았는데(KR:LIVE)" in result.stdout
    assert "끝나지 않았던 실제 주문 가운데 복원한 DB에 없는 것" in result.stdout


def test_OPS4_백업_뒤에_나간_주문만_없으면_멈춤과_함께_그_주문만_경고한다(database_url, scratch_db, tmp_path):
    """켜진 뒤의 백업(08:00) → 그 뒤 시가 맞추기 주문(08:50) → 복원: 시장은 이상 멈춤(restored)이 되지만 그 주문의 기록은 없습니다."""
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    _seed_real_trade(db_url, "LIVE")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _turn_on_after_backup(db_url, "LIVE")

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _real_trade_config(db_url, "state, halt_reason") == [("KR", "HALTED", "restored"), ("US", "OFF", None)]
    assert "실제 매매 설정 1개 시장을 이상 멈춤(restored)으로" in result.stdout
    assert "꺼져 있지 않았는데" not in result.stdout, "시장은 이상 멈춤이라 그 경고는 아님"
    assert "끝나지 않았던 실제 주문 가운데 복원한 DB에 없는 것" in result.stdout


def test_OPS4_복원한_DB가_지금_DB의_미체결을_그대로_추적하면_경고하지_않는다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path)
    _seed_real_trade(db_url, "LIVE")                                                         # 끝나지 않은 주문 하나 포함
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "경고" not in result.stdout + result.stderr


def test_OPS4_QA_복원은_지금_DB와_견주지_않는다(database_url, scratch_db, tmp_path):
    name, db_url = scratch_db
    env = _real_trade_env(database_url, name, tmp_path, RESTORE_REAL_TRADE="clear")
    assert _run(BACKUP, env=env).returncode == 0
    backup_file = _backups(tmp_path)[0]
    _turn_on_after_backup(db_url, "LIVE")

    result = _run(RESTORE, str(backup_file), "--yes", env=env)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "경고" not in result.stdout + result.stderr
