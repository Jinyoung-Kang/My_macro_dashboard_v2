"""
tests/conftest.py
테스트 공통 설정.

저장 계층 테스트는 실제 PostgreSQL을 씁니다. TEST_DATABASE_URL이 없으면
그 테스트만 건너뜁니다(순수 로직 테스트는 DB 없이도 돌아야 합니다).
"""
from __future__ import annotations

import os
import uuid

import pytest

# TestClient의 기본 Host는 'testserver'입니다. 운영 기본 허용 목록에는 두지 않고(QA-038) 테스트에서만 더합니다 —
# app.main이 불러와지기 전에(이 파일이 먼저 실행됨) 정해야 미들웨어가 이 목록으로 만들어집니다.
os.environ.setdefault("COLLECTOR_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],collector,testserver")


@pytest.fixture(autouse=True)
def _reset_http_guards():
    """
    공용 HTTP 층의 거부 래치·호스트 간격 기록은 프로세스 전역입니다(app/http.py). 한 테스트가 닫은 호스트(127.0.0.1,
    finance.yahoo.com)가 5분 동안 다음 테스트의 요청까지 막지 않게 테스트마다 비웁니다.
    """
    from app import http

    http.reset_guards()
    yield
    http.reset_guards()


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "")
    if not url:
        pytest.skip("TEST_DATABASE_URL이 없어 저장 계층 테스트를 건너뜁니다.")
    return url


@pytest.fixture()
def store(database_url, monkeypatch):
    """
    테스트 전용 스키마를 만들어 그 안에서만 동작하게 합니다.

    같은 DB를 쓰더라도 테스트가 운영 데이터를 건드리지 않고, 테스트끼리도
    서로를 오염시키지 않습니다.
    """
    schema = f"test_{uuid.uuid4().hex[:12]}"
    monkeypatch.setenv(
        "DATABASE_URL", f"{database_url}?options=-csearch_path%3D{schema}"
    )

    from app import store as store_module

    store_module.close_pool()

    # 스키마를 먼저 만들어야 search_path가 유효합니다.
    import psycopg

    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')

    store_module.init_schema(_migrations_dir())
    yield store_module

    store_module.close_pool()
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')


def _migrations_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "db", "migrations"))
