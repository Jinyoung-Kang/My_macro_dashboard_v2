"""
tests/test_migrations.py
스키마 버전 관리 (ARC-01).

[왜 필요한가]
예전에는 V1__init.sql을 기동할 때마다 다시 실행해서, 이미 있는 DB를 바꾸는 변경(예: 쓰지 않는
인덱스 삭제)을 넣어도 다음 기동 때 V1이 되돌려 놓았습니다. 파일마다 한 번만 적용하고 기록을
남기는지, 번호 순서(문자열 순서가 아님)를 지키는지, 실패하면 전부 되돌리는지 확인합니다.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from app import migrations

REPO_MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture()
def conn(database_url):
    """테스트 전용 스키마 안에서만 동작하는 연결."""
    schema = f"test_mig_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f'CREATE SCHEMA "{schema}"')
    connection = psycopg.connect(
        database_url, autocommit=True, row_factory=dict_row,
        options=f"-csearch_path={schema}",
    )
    try:
        yield connection
    finally:
        connection.close()
        with psycopg.connect(database_url, autocommit=True) as admin:
            admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')


def _write(directory, name, sql):
    (directory / name).write_text(sql, encoding="utf-8")


def test_번호_순서대로_한_번씩_적용하고_기록한다(conn, tmp_path):
    _write(tmp_path, "V1__init.sql", "CREATE TABLE IF NOT EXISTS t (id INT);")
    _write(tmp_path, "V2__add_column.sql", "ALTER TABLE t ADD COLUMN IF NOT EXISTS name TEXT;")
    _write(tmp_path, "V10__index.sql", "CREATE INDEX IF NOT EXISTS t_name ON t (name);")
    _write(tmp_path, "README.md", "마이그레이션이 아닌 파일은 무시")

    found = migrations.discover(tmp_path)
    assert [m.version for m in found] == [1, 2, 10]      # V10은 V2 다음 (문자열 순서라면 V10이 먼저)

    assert migrations.apply_pending(conn, found) == [1, 2, 10]
    assert migrations.apply_pending(conn, found) == []    # 두 번째 기동: 할 일 없음

    versions = [r["version"] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    assert versions == [1, 2, 10]


def test_적용한_뒤_지운_인덱스를_다시_만들지_않는다(conn, tmp_path):
    """예전 방식(V1을 매번 다시 실행)에서는 V2가 지운 인덱스를 V1이 되살렸습니다."""
    _write(tmp_path, "V1__init.sql",
           "CREATE TABLE IF NOT EXISTS t (id INT); CREATE INDEX IF NOT EXISTS t_dup ON t (id);")
    _write(tmp_path, "V2__drop_dup.sql", "DROP INDEX IF EXISTS t_dup;")
    found = migrations.discover(tmp_path)

    migrations.apply_pending(conn, found)
    migrations.apply_pending(conn, found)                 # 재기동

    exists = conn.execute("SELECT to_regclass('t_dup') AS idx").fetchone()["idx"]
    assert exists is None


def test_새_파일만_추가로_적용한다(conn, tmp_path):
    _write(tmp_path, "V1__init.sql", "CREATE TABLE IF NOT EXISTS t (id INT);")
    migrations.apply_pending(conn, migrations.discover(tmp_path))

    _write(tmp_path, "V2__more.sql", "CREATE TABLE IF NOT EXISTS u (id INT);")
    assert migrations.apply_pending(conn, migrations.discover(tmp_path)) == [2]


def test_하나라도_실패하면_전부_되돌린다(conn, tmp_path):
    _write(tmp_path, "V1__init.sql", "CREATE TABLE IF NOT EXISTS t (id INT);")
    _write(tmp_path, "V2__broken.sql", "ALTER TABLE no_such_table ADD COLUMN x INT;")

    with pytest.raises(psycopg.Error):
        migrations.apply_pending(conn, migrations.discover(tmp_path))

    assert conn.execute("SELECT to_regclass('t') AS t").fetchone()["t"] is None
    assert conn.execute("SELECT to_regclass('schema_migrations') AS m").fetchone()["m"] is None


def test_적용한_파일이_바뀌면_경고한다(conn, tmp_path, caplog):
    _write(tmp_path, "V1__init.sql", "CREATE TABLE IF NOT EXISTS t (id INT);")
    migrations.apply_pending(conn, migrations.discover(tmp_path))

    _write(tmp_path, "V1__init.sql", "CREATE TABLE IF NOT EXISTS t (id INT, x INT);")
    with caplog.at_level("WARNING"):
        assert migrations.apply_pending(conn, migrations.discover(tmp_path)) == []
    assert "V1" in caplog.text


def test_같은_번호가_둘이면_거부한다(tmp_path):
    _write(tmp_path, "V1__a.sql", "SELECT 1;")
    _write(tmp_path, "V1__b.sql", "SELECT 1;")
    with pytest.raises(ValueError):
        migrations.discover(tmp_path)


def test_저장소의_마이그레이션은_여러_번_실행해도_안전하다(conn):
    """postgres 초기화·CI가 psql로 먼저 실행해도, 수집기가 다시 적용해도 깨지지 않아야 합니다."""
    found = migrations.discover(REPO_MIGRATIONS)
    assert found, "db/migrations에서 파일을 찾지 못했습니다"
    for migration in found:                               # psql로 먼저 한 번씩 실행한 상태
        conn.execute(migration.sql)
    assert [m.version for m in found] == migrations.apply_pending(conn, found)


def test_수집기_기동은_저장소의_모든_버전을_적용한다(store):
    with store.connection() as conn:
        versions = [r["version"] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY 1")]
    assert versions == [m.version for m in migrations.discover(REPO_MIGRATIONS)]


def test_디렉터리는_인자_새_설정_예전_설정_순으로_찾는다(tmp_path, monkeypatch):
    from app import store

    new_dir, old_dir = tmp_path / "new", tmp_path / "old"
    for directory in (new_dir, old_dir):
        directory.mkdir()
        _write(directory, "V1__init.sql", "SELECT 1;")

    monkeypatch.delenv("MACRO_MIGRATIONS_DIR", raising=False)
    monkeypatch.setenv("MACRO_SCHEMA_SQL", str(old_dir / "V1__init.sql"))  # 예전 설정: V1 파일 경로
    assert store._resolve_migrations_dir(None) == old_dir

    monkeypatch.setenv("MACRO_MIGRATIONS_DIR", str(new_dir))
    assert store._resolve_migrations_dir(None) == new_dir
    assert store._resolve_migrations_dir(str(old_dir)) == old_dir


def test_V2는_기본키와_겹치는_인덱스를_지우고_GIN을_레이더_행으로_좁힌다(store):
    """PERF-05. 지운 인덱스가 되살아나거나 레이더 데이터셋 이름이 바뀌면 여기서 잡힙니다."""
    from app import catalog

    with store.connection() as conn:
        rows = conn.execute(
            "SELECT indexname, indexdef FROM pg_indexes "
            "WHERE schemaname = current_schema() AND tablename IN ('observations', 'timeseries')"
        ).fetchall()
    indexes = {r["indexname"]: r["indexdef"] for r in rows}

    assert not {"idx_timeseries_lookup", "idx_observations_lookup", "idx_observations_radar_filter"} & indexes.keys()
    # 부분 인덱스는 조건의 데이터셋 이름이 정확히 같아야 쓰입니다.
    assert f"WHERE (dataset = '{catalog.OBS_RADAR}'::text)" in indexes["idx_observations_radar_payload"]


def test_QA282_결정_번호로_주문과_장중_확인을_찾는_색인이_있다(store):
    """QA-282. 결정 요약(PaperStore DECISION_SUMMARY_COLUMNS)의 결정별 주문 COUNT가 결정마다 주문 표 전체를 훑어,
    개요·결정 목록이 주문 누적에 비례해 느려졌습니다(QA 스택 합성 주문 12.2k에서 개요 17ms → 124ms, 색인 31.5ms).
    장중 확인 표의 결정 번호 외래 키 둘도 색인이 없어 계좌 초기화(결정 행 삭제)의 외래 키 검사가 표 전체를 훑었습니다."""
    with store.connection() as conn:
        rows = conn.execute(
            "SELECT tablename, indexdef FROM pg_indexes "
            "WHERE schemaname = current_schema() AND tablename IN ('paper_orders', 'paper_checkpoints')"
        ).fetchall()
    # 색인의 첫 열만 봅니다 — 그 열로 시작하는 색인이면 그 열의 같음 조건을 색인으로 찾습니다.
    leading = set()
    for r in rows:
        m = re.search(r"USING \w+ \((\w+)", r["indexdef"])
        if m:
            leading.add((r["tablename"], m.group(1)))
    assert {("paper_orders", "decision_id"),
            ("paper_checkpoints", "source_decision_id"),
            ("paper_checkpoints", "checkpoint_decision_id")} <= leading


def test_번호_파일이_없으면_아무것도_적용하지_않고_기동을_이어_간다(store, tmp_path):
    """V*__*.sql 모양이어도 번호가 아니면 마이그레이션이 아닙니다. 그때도 기동이 멈추면 안 됩니다."""
    _write(tmp_path, "Vnext__draft.sql", "SELECT 1;")
    store.init_schema(str(tmp_path))
