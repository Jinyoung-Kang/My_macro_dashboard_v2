"""
app/store.py
PostgreSQL 저장 계층 (구버전 services/store.py의 SQLite 버전을 대체).

[무엇이 같고 무엇이 달라졌나]
같은 것 — 저장 형태 네 가지(snapshots / timeseries / observations / 실행 로그)와
"수집과 표시를 분리한다"는 구조. 수집기는 쓰기만, API는 읽기만 합니다.

달라진 것
  - SQLite 파일 + WAL → PostgreSQL. 수집기와 백엔드가 서로 다른 컨테이너에서
    도는 구조라 파일 공유가 불가능합니다.
  - payload를 pandas DataFrame으로 직렬화하던 부분을 **명시적 JSON 계약**으로
    바꿨습니다. 구버전은 DataFrame을 JSON으로 저장하면서 dtype을 함께 남겨야
    했습니다. 그러지 않으면 "069500" 같은 종목코드가 int로 추론돼 앞자리 0이
    사라졌기 때문입니다(실제 있었던 버그). 이제 종목코드는 애초에 문자열
    필드로 정의되므로 그 위험 자체가 없습니다.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from . import catalog, logredact, migrations, settings

logger = logging.getLogger(__name__)

# heartbeat가 이 시간 동안 갱신되지 않은 'running' 레코드는 죽은 것으로 봅니다.
# 가장 느린 태스크(13F)보다 넉넉하게 잡습니다.
STALE_RUN_SECONDS = 30 * 60

_pool: ConnectionPool | None = None

# 풀에서 연결을 기다리는 최대 시간. 기본값 30초면 PostgreSQL이 끊겼을 때 요청 하나가 30초를 삼키고
# (백엔드의 제어 타임아웃 3초를 넘겨 상태 화면이 "수집기에 연결하지 못함"으로 바뀜), 스케줄러 태스크도
# 연결 하나당 30초씩 묶입니다. 백엔드의 DB 확인 시간(5초)과 맞춥니다. (QA-010)
POOL_WAIT_SECONDS = 5.0


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            conninfo=settings.database_url(),
            min_size=1,
            max_size=8,
            kwargs={"row_factory": dict_row},
            open=True,
            timeout=POOL_WAIT_SECONDS,
            # PostgreSQL이 재시작하면 풀의 연결이 전부 죽습니다. 검사 없이 나눠 주면 첫 사용에서야
            # 터져 태스크 최대 8개가 연달아 실패하고, 실패 기록 자체도 유실됐습니다. 빌려줄 때 확인합니다.
            check=ConnectionPool.check_connection,
        )
    return _pool


def ping() -> None:
    """DB에 닿는지 확인합니다(SELECT 1). 닿지 못하면 psycopg 예외가 그대로 올라옵니다."""
    with connection() as conn:
        conn.execute("SELECT 1").fetchone()


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


_current = threading.local()


@contextmanager
def connection():
    """
    풀에서 연결을 하나 빌립니다. 블록이 정상으로 끝나면 커밋, 예외면 롤백입니다.

    transaction() 블록 안에서 불리면 새 연결 대신 **그 트랜잭션의 연결**을 돌려주고
    커밋도 하지 않습니다 — 블록 안의 put_* 호출이 전부 한 트랜잭션에 묶입니다.
    """
    current = getattr(_current, "conn", None)
    if current is not None:
        yield current
        return
    with get_pool().connection() as conn:
        yield conn


@contextmanager
def transaction():
    """
    여러 put_* 호출을 한 트랜잭션으로 묶습니다. 중첩되면 바깥 트랜잭션에 합류합니다.

    예: 금융위 하루치는 observations + timeseries + 메타 스냅샷을 함께 써야 합니다.
    따로 커밋하면 중간에 멈췄을 때 '종목은 있는데 시장 합계는 없는 날'이 생기고,
    다음 실행은 그날을 이미 받은 날로 보고 건너뜁니다.
    """
    if getattr(_current, "conn", None) is not None:
        yield _current.conn
        return
    with get_pool().connection() as conn:
        _current.conn = conn
        try:
            yield conn
        finally:
            _current.conn = None


def init_schema(path: str | None = None) -> None:
    """
    스키마를 최신 버전으로 맞춥니다 — db/migrations에서 아직 적용하지 않은 파일만
    번호 순서로 적용합니다(app/migrations.py).

    쓰기는 수집기의 몫이라 수집기가 기동할 때 적용합니다. 백엔드는 읽기만 합니다.

    :param path: 마이그레이션 디렉터리. 파일 경로를 주면 그 파일이 있는 디렉터리를 씁니다
    :raises psycopg.Error: 적용에 실패하면 전부 되돌리고 그대로 올립니다(기동 중단)
    """
    directory = _resolve_migrations_dir(path)
    if directory is None:
        logger.warning(
            "마이그레이션 디렉터리를 찾지 못했습니다. MACRO_MIGRATIONS_DIR로 경로를 지정하세요."
        )
        return

    found = migrations.discover(directory)
    with connection() as conn:
        migrations.apply_pending(conn, found)
    logger.info("저장 계층 준비 완료: %s (V%d까지)", directory, found[-1].version if found else 0)


def _resolve_migrations_dir(path: str | None) -> Path | None:
    """
    마이그레이션 디렉터리를 찾습니다.

    배포 형태마다 경로가 다릅니다.
      - 저장소 실행 : <repo>/db/migrations
      - 컨테이너    : /app/db/migrations (compose가 마운트)
    명시 인자 → MACRO_MIGRATIONS_DIR → MACRO_SCHEMA_SQL(예전 설정: V1 파일 경로) →
    관례적 위치 순으로 찾고, 없으면 None을 돌려줍니다(잘못된 경로를 조용히 만들어 내지 않습니다).
    """
    candidates: list[Path] = []
    for value in (path, os.environ.get("MACRO_MIGRATIONS_DIR"), os.environ.get("MACRO_SCHEMA_SQL")):
        if value and value.strip():
            candidate = Path(value.strip())
            candidates.append(candidate.parent if candidate.suffix == ".sql" else candidate)

    here = Path(__file__).resolve()
    # app/ → collector/ → <repo> 순으로 거슬러 올라가며 찾습니다.
    candidates.extend(parent / "db" / "migrations" for parent in here.parents)

    for candidate in candidates:
        if candidate.is_dir() and any(candidate.glob("V*__*.sql")):
            return candidate
    return None


# ==============================================================================
# 1. 스냅샷
# ==============================================================================
@dataclass(frozen=True)
class Snapshot:
    name: str
    payload: Any
    kind: str
    status: str
    error: str | None
    collected_at: datetime | None

    @property
    def age_seconds(self) -> float:
        if self.collected_at is None:
            return float("inf")
        delta = datetime.now(timezone.utc) - self.collected_at
        return max(0.0, delta.total_seconds())

    def is_fresh(self, max_age_seconds: float) -> bool:
        return self.age_seconds <= max_age_seconds


def put_snapshot(
    name: str,
    payload: Any,
    *,
    kind: str = "json",
    status: str = "ok",
    error: str | None = None,
) -> None:
    """스냅샷 upsert. 같은 이름은 최신 1건만 유지합니다."""
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO snapshots (name, payload, kind, status, error, collected_at)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (name) DO UPDATE SET
                payload      = EXCLUDED.payload,
                kind         = EXCLUDED.kind,
                status       = EXCLUDED.status,
                error        = EXCLUDED.error,
                collected_at = EXCLUDED.collected_at
            """,
            (name, Jsonb(payload), kind, status, error),
        )


def read_snapshot(name: str) -> Snapshot | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT name, payload, kind, status, error, collected_at "
            "FROM snapshots WHERE name = %s",
            (name,),
        ).fetchone()

    if row is None:
        return None
    return Snapshot(
        name=row["name"],
        payload=row["payload"],
        kind=row["kind"],
        status=row["status"],
        error=row["error"],
        collected_at=row["collected_at"],
    )


def list_snapshots() -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT name, status, error, collected_at FROM snapshots ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]


# ==============================================================================
# 2. 시계열 누적
# ==============================================================================
def put_timeseries(
    dataset: str,
    series_id: str,
    points: Sequence[tuple[Any, float | None]],
) -> int:
    """
    (dataset, series_id, 날짜) → 값 upsert. 반영된 행 수를 반환합니다.

    같은 날짜는 최신 값으로 덮어씁니다. 매일 수집하면 과거는 유지되고
    최근 값만 갱신됩니다.

    값을 모르는 점(None·NaN)은 **쓰지 않습니다.** 외부 소스가 하루 값을 빼먹을
    때 NULL로 덮으면 전에 받아 둔 확정치가 지워지고, read_timeseries는 NULL을
    숨기므로 조용히 구멍이 납니다. 반환값에도 세지 않습니다.

    값이 같은 행은 갱신하지 않습니다(DO UPDATE … WHERE IS DISTINCT FROM). 같은 값을 다시
    쓰면 PostgreSQL은 새 행 버전을 만들어 WAL과 죽은 행이 생깁니다 — 31k행 테이블에
    갱신 346만 번이 쌓인 원인입니다. 반환값은 '보낸 점 수'입니다(갱신된 행 수가 아님).
    """
    rows = []
    for raw_date, value in points:
        day = _coerce_date(raw_date)
        number = _coerce_float(value)
        if day is None or number is None:
            continue
        rows.append((dataset, series_id, day, number))

    if not rows:
        return 0

    with connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO timeseries (dataset, series_id, obs_date, value, updated_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (dataset, series_id, obs_date) DO UPDATE SET
                value      = EXCLUDED.value,
                updated_at = EXCLUDED.updated_at
            WHERE timeseries.value IS DISTINCT FROM EXCLUDED.value
            """,
            rows,
        )
    return len(rows)


def latest_timeseries_date(dataset: str, series_id: str) -> str | None:
    """그 시리즈의 가장 최근 obs_date (YYYY-MM-DD). 없으면 None."""
    with connection() as conn:
        row = conn.execute(
            "SELECT MAX(obs_date) AS d FROM timeseries WHERE dataset = %s AND series_id = %s",
            (dataset, series_id),
        ).fetchone()
    return row["d"].isoformat() if row and row["d"] else None


def earliest_timeseries_date(dataset: str, series_id: str) -> str | None:
    """그 시리즈의 가장 이른 obs_date (YYYY-MM-DD). 없으면 None. 과거 쪽 메우기의 시작점입니다(한국 책 종가 이력)."""
    with connection() as conn:
        row = conn.execute(
            "SELECT MIN(obs_date) AS d FROM timeseries WHERE dataset = %s AND series_id = %s",
            (dataset, series_id),
        ).fetchone()
    return row["d"].isoformat() if row and row["d"] else None


def read_timeseries(
    dataset: str,
    series_id: str,
    *,
    start_date: str | None = None,
) -> list[dict]:
    sql = (
        "SELECT obs_date, value FROM timeseries "
        "WHERE dataset = %s AND series_id = %s"
    )
    params: list[Any] = [dataset, series_id]
    if start_date:
        sql += " AND obs_date >= %s"
        params.append(start_date)
    sql += " ORDER BY obs_date"

    with connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [
        {"date": r["obs_date"].isoformat(), "value": r["value"]}
        for r in rows
        if r["value"] is not None
    ]


def count_timeseries() -> int:
    with connection() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM timeseries").fetchone()
    return int(row["n"])


# ==============================================================================
# 3. 레코드 누적 (수급 랭킹처럼 행이 여러 컬럼인 데이터)
# ==============================================================================
def put_observations(
    dataset: str,
    obs_date: str,
    records: Iterable[dict],
    *,
    entity_key: str,
) -> int:
    rows = []
    for rec in records:
        entity = rec.get(entity_key)
        if entity is None:
            continue
        rows.append((dataset, obs_date, str(entity), Jsonb(rec)))

    if not rows:
        return 0

    with connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO observations (dataset, obs_date, entity, payload, updated_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (dataset, obs_date, entity) DO UPDATE SET
                payload    = EXCLUDED.payload,
                updated_at = EXCLUDED.updated_at
            WHERE observations.payload IS DISTINCT FROM EXCLUDED.payload
            """,
            rows,
        )
    return len(rows)


def put_entity_observations(
    dataset: str,
    entity: str,
    rows: Iterable[tuple[Any, dict]],
    *,
    keep_ciks: list[str] | None = None,
) -> int:
    """
    한 entity의 (날짜, payload) 여러 행을 **한 트랜잭션에서** upsert합니다. 보낸 행 수(날짜를 읽을 수 없는 행은 뺌).

    put_observations와 같은 upsert지만 payload를 그대로 씁니다 — entity를 payload 안의 필드로 두지 않는 데이터
    (us.fundamentals: entity = 티커, payload = {"cik", "facts"})를 위해서입니다. 한 블록(풀 연결 하나 = 한 트랜잭션)이라
    한 회사의 행이 중간에 끊겨 일부 공시일만 새 내용으로 바뀌지 않습니다. 이번에 없는 날짜의 행은 그대로 남습니다.
    값이 같은 행은 다시 쓰지 않습니다(IS DISTINCT FROM — 12시간마다 같은 사실을 받아도 죽은 행이 쌓이지 않게).

    :param keep_ciks: 주면 같은 트랜잭션에서 그 entity의 행 가운데 payload ``cik``가 이 목록과 하나도 겹치지 않는 행을 먼저
        지웁니다(rows가 비어도). 티커의 CIK가 다른 회사로 바뀌거나 잘못 넣은 별칭을 빼면, 옛 CIK로 쌓은 행이 그 티커 아래 남아
        '가장 늦게 낸 값' 규칙으로 새 회사에 없는 기간(1년 전 TTM·시점 값)을 다른 회사 숫자로 채웠습니다. ``cik`` 칸이 없는 행은
        누가 냈는지 모르므로 지우지 않습니다.
    """
    params = []
    for raw_date, payload in rows:
        day = _coerce_date(raw_date)
        if day is None or payload is None:
            continue
        params.append((dataset, day, str(entity), Jsonb(payload)))

    if not params and keep_ciks is None:
        return 0

    with connection() as conn, conn.cursor() as cur:
        if keep_ciks is not None:
            cur.execute(
                """
                DELETE FROM observations
                WHERE dataset = %s AND entity = %s
                  AND jsonb_typeof(payload->'cik') = 'array'
                  AND NOT (payload->'cik' ?| %s::text[])
                """,
                (dataset, str(entity), [str(cik) for cik in keep_ciks]),
            )
        if params:
            cur.executemany(
                """
                INSERT INTO observations (dataset, obs_date, entity, payload, updated_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (dataset, obs_date, entity) DO UPDATE SET
                    payload    = EXCLUDED.payload,
                    updated_at = EXCLUDED.updated_at
                WHERE observations.payload IS DISTINCT FROM EXCLUDED.payload
                """,
                params,
            )
    return len(params)


def replace_observations(
    dataset: str,
    obs_date: str,
    entity_prefix: str,
    records: Iterable[dict],
    *,
    entity_key: str,
) -> int:
    """
    같은 날짜·같은 entity 접두어의 레코드를 **통째로 교체**합니다. 반영된 행 수.

    put_observations(upsert)는 이전에 있던 행을 지우지 않습니다. 하루에 여러 번
    받는 "상위 N" 같은 데이터는 구성이 바뀌므로, 밀려난 행이 옛 값으로 남아
    그날 데이터가 N행이 아니라 합집합이 됩니다. 삭제와 삽입을 한 트랜잭션에서
    해, 중간에 끊겨도 반쯤 지워진 날은 생기지 않습니다.

    레코드가 비어 있으면 아무것도 지우지 않습니다 — 빈 수집 결과로 이력을
    날리는 것이 가장 나쁜 결과입니다.
    """
    rows = []
    for rec in records:
        entity = rec.get(entity_key)
        if entity is None:
            continue
        rows.append((dataset, obs_date, str(entity), Jsonb(rec)))

    if not rows:
        return 0

    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM observations "
            "WHERE dataset = %s AND obs_date = %s AND starts_with(entity, %s)",
            (dataset, obs_date, entity_prefix),
        )
        cur.executemany(
            """
            INSERT INTO observations (dataset, obs_date, entity, payload, updated_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (dataset, obs_date, entity) DO UPDATE SET
                payload    = EXCLUDED.payload,
                updated_at = EXCLUDED.updated_at
            """,
            rows,
        )
    return len(rows)


def read_observations(
    dataset: str,
    *,
    obs_date: str | None = None,
    start_date: str | None = None,
    filters: dict[str, str] | None = None,
) -> list[dict]:
    sql = "SELECT obs_date, payload FROM observations WHERE dataset = %s"
    params: list[Any] = [dataset]

    if obs_date:
        sql += " AND obs_date = %s"
        params.append(obs_date)
    if start_date:
        sql += " AND obs_date >= %s"
        params.append(start_date)
    if filters:
        sql += " AND payload @> %s"
        params.append(Jsonb(filters))
    sql += " ORDER BY obs_date, entity"

    with connection() as conn:
        rows = conn.execute(sql, params).fetchall()

    out = []
    for r in rows:
        rec = dict(r["payload"])
        rec.setdefault("obsDate", r["obs_date"].isoformat())
        out.append(rec)
    return out


def watched_stock_codes(limit: int) -> list[str]:
    """
    알림 규칙(관심 종목 외국인 연속 순매수)에 걸린 종목코드 — 종목별 수급 수집 범위에 더합니다(명세 C3).

    alert_rules는 백엔드가 쓰는 테이블입니다(ADR 0008). 수집기는 **읽기만** 하며, 이것이 테이블 소유 규칙의
    유일한 교차 읽기입니다. 백엔드가 만들 때 전체 60종목으로 막지만, 여기서도 limit으로 한 번 더 자릅니다.
    """
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT params->>'code' AS code
            FROM alert_rules
            WHERE kind = 'FOREIGN_STREAK' AND enabled AND params->>'target' = 'STOCK'
            ORDER BY 1 LIMIT %s
            """,
            (limit,),
        ).fetchall()
    return [r["code"] for r in rows if r["code"]]


def recent_observation_codes(dataset: str, since: str, limit: int) -> list[str]:
    """
    최근 누적 레코드에 등장한 종목코드(payload.code), 등장 횟수 많은 순.

    :param dataset: 누적 데이터셋 이름 (예: radar_ranking)
    :param since: 이 날짜(YYYY-MM-DD) 이후만
    :param limit: 최대 개수 — 외부 API 호출 수가 여기에 비례합니다
    """
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT payload->>'code' AS code, COUNT(*) AS n
            FROM observations
            WHERE dataset = %s AND obs_date >= %s AND payload ? 'code'
            GROUP BY 1 ORDER BY n DESC, code LIMIT %s
            """,
            (dataset, since, limit),
        ).fetchall()
    return [r["code"] for r in rows if r["code"]]


def held_tickers(market: str) -> list[str]:
    """
    🧪 모의 매매에서 지금 보유한 종목(그 시장의 출발한 계좌들, 중복 없음·정렬) — 장중 평가(paper.live.*)의 범위입니다.

    백엔드 표 ``paper_positions``·``paper_books``를 **읽기만** 합니다(쓰는 프로세스는 백엔드 하나 — ADR 0008, 이 읽기의 결정은 v2 ADR 0020).
    보유는 장부가 정하므로 수집기가 따로 셈하지 않습니다.
    """
    with connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT p.ticker FROM paper_positions p JOIN paper_books b ON b.code = p.book_code "
            "WHERE b.market = %s AND b.status <> 'NOT_STARTED' ORDER BY p.ticker", (market,),
        ).fetchall()
    return [row["ticker"] for row in rows]


# 🧪 미국 1분봉(paper.bars.us) 수집 범위의 계좌(명세 2026-10-30-claude-book2-timing-design.md §12-1) — 주문은 Claude 계좌1·계좌2, 보유는
# 계좌2만(계좌2 시각 지정 체결의 'T 시각 순자산'에 보유 종목의 창 가격이 필요 — §10-3). 계좌2(claude2)는 단계 1에서 생기지만 미리 둡니다
# (행이 없으면 고르는 것이 없음). 코드는 백엔드 PaperBooks와 같은 글자입니다(test_paper_bars가 파일로 대조).
TIMED_ORDER_BOOKS = {"US": ("claude", "claude2")}
TIMED_HOLDING_BOOKS = {"US": ("claude2",)}
# 최근 주문을 범위에 두는 달력일 수 — 수집기는 미국 거래일을 모릅니다. 마감 뒤 결정(기준일) → 다음 세션 E → 서버가 꺼졌던 세션의 늦은
# 따라잡기까지, 긴 연휴를 넘어도 덮는 길이입니다(1분봉을 되짚을 수 있는 기간도 8일 안 — yfinance period="max" 기준).
TIMED_RECENT_DAYS = 8


def timed_scope(market: str) -> list[str]:
    """
    🧪 1분봉(paper.bars.us) 수집 범위 — 그 시장 Claude 계좌들의 대기 주문 ∪ 최근 ``TIMED_RECENT_DAYS``일(달력일, DB 시각)에 만든 주문(상태 무관)
    ∪ 계좌2 보유의 종목(중복 없음·정렬). 지연 기준 종목(SPY)은 태스크가 더합니다 — 여기는 표에서 고른 것만이라 빈 목록이면 부르지 않습니다.

    백엔드 표 ``paper_orders``·``paper_positions``·``paper_books``를 **읽기만** 합니다(쓰는 프로세스는 백엔드 하나 — ADR 0008, held_tickers와
    같은 교차 읽기 — v2 ADR 0020·0022). 범위를 정하는 시점·주문은 백엔드가 정하므로 수집기가 따로 셈하지 않습니다.
    """
    order_books = TIMED_ORDER_BOOKS.get(market)
    if not order_books:
        return []
    with connection() as conn:
        rows = conn.execute(
            "SELECT o.ticker FROM paper_orders o JOIN paper_books b ON b.code = o.book_code "
            "WHERE b.market = %s AND o.book_code = ANY(%s) "
            "AND (o.status = 'PENDING' OR o.created_at >= now() - make_interval(days => %s)) "
            "UNION "
            "SELECT p.ticker FROM paper_positions p JOIN paper_books b ON b.code = p.book_code "
            "WHERE b.market = %s AND p.book_code = ANY(%s) ORDER BY 1",
            (market, list(order_books), TIMED_RECENT_DAYS, market, list(TIMED_HOLDING_BOOKS.get(market, ()))),
        ).fetchall()
    return [row["ticker"] for row in rows]


# 🧪 장중 확인 감시(paper.watch.us) 범위의 계좌·피드·상태(명세 2026-10-30 §12-1, ADR 0022 단계 2) — 계좌는 백엔드 PaperBooks.CLAUDE2, 피드·상태는
# V18 paper_checkpoints CHECK와 같은 글자입니다(test_paper_watch가 파일로 대조). HOURLY 확인은 시간별 관측치를 쓰므로 감시 범위가 아닙니다.
WATCH_BOOKS = {"US": "claude2"}
FEED_MINUTE = "MINUTE"
CHECKPOINT_PLANNED = "PLANNED"


def watch_scope(market: str, session: date) -> dict | None:
    """
    🧪 장중 확인 감시 범위 — 그 시장 계좌2의 ``session``(뉴욕 날짜) 장중 확인 행 가운데 PLANNED·MINUTE인 것(계좌·세션마다 한 행)과 계좌2의
    보유·대기 주문 종목. 행이 없으면 None(태스크가 Yahoo를 부르지 않음).
    ``{book, sessionDate, atEt(time), watch[…], held[…], pending[…]}``

    백엔드 표 ``paper_checkpoints``·``paper_positions``·``paper_orders``·``paper_books``를 **읽기만** 합니다(쓰는 프로세스는 백엔드 하나 —
    ADR 0008, timed_scope와 같은 교차 읽기 — ADR 0022). 확인 시각·감시 목록은 아침 결정이 정하고 백엔드가 적습니다.
    """
    book = WATCH_BOOKS.get(market)
    if not book:
        return None
    with connection() as conn:
        row = conn.execute(
            "SELECT c.book_code, c.session_date, c.at_et, c.watch FROM paper_checkpoints c "
            "JOIN paper_books b ON b.code = c.book_code "
            "WHERE b.market = %s AND c.book_code = %s AND c.session_date = %s AND c.status = %s AND c.feed = %s",
            (market, book, session, CHECKPOINT_PLANNED, FEED_MINUTE),
        ).fetchone()
        if row is None:
            return None
        held = conn.execute(
            "SELECT ticker FROM paper_positions WHERE book_code = %s ORDER BY ticker", (book,),
        ).fetchall()
        pending = conn.execute(
            "SELECT DISTINCT ticker FROM paper_orders WHERE book_code = %s AND status = 'PENDING' ORDER BY ticker", (book,),
        ).fetchall()
    return {"book": row["book_code"], "sessionDate": row["session_date"], "atEt": row["at_et"],
            "watch": list(row["watch"] or []), "held": [r["ticker"] for r in held], "pending": [r["ticker"] for r in pending]}


def latest_observation_date(dataset: str) -> str | None:
    """그 데이터셋의 가장 최근 obs_date (YYYY-MM-DD). 없으면 None."""
    with connection() as conn:
        row = conn.execute(
            "SELECT MAX(obs_date) AS d FROM observations WHERE dataset = %s", (dataset,),
        ).fetchone()
    return row["d"].isoformat() if row and row["d"] else None


def latest_observation_date_before(dataset: str, before: str) -> str | None:
    """그 데이터셋에서 obs_date < before(YYYY-MM-DD)인 가장 최근 날짜. 없으면 None. 한국 책 유니버스의 금융위 기준일 B(< 오늘)입니다."""
    with connection() as conn:
        row = conn.execute(
            "SELECT MAX(obs_date) AS d FROM observations WHERE dataset = %s AND obs_date < %s", (dataset, before),
        ).fetchone()
    return row["d"].isoformat() if row and row["d"] else None


def earliest_observation_date(dataset: str) -> str | None:
    """그 데이터셋의 가장 이른 obs_date (YYYY-MM-DD). 없으면 None. 과거 쪽 메우기의 시작점입니다(금융위 시세)."""
    with connection() as conn:
        row = conn.execute(
            "SELECT MIN(obs_date) AS d FROM observations WHERE dataset = %s", (dataset,),
        ).fetchone()
    return row["d"].isoformat() if row and row["d"] else None


def delete_observations_before(dataset: str, before: str) -> int:
    """오래된 누적 레코드 정리. 지운 행 수."""
    with connection() as conn:
        cur = conn.execute(
            "DELETE FROM observations WHERE dataset = %s AND obs_date < %s", (dataset, before),
        )
        return cur.rowcount or 0


def observation_entities_since(dataset: str, since: str) -> set[str]:
    """
    그 데이터셋에서 obs_date ≥ since(YYYY-MM-DD)인 행의 entity(중복 없음).

    날짜를 가리지 않는 중복 제거에 씁니다 — 사건 뉴스(news_headline)는 같은 제목이 다른 날짜로 다시 와도(피드가 시각을 고침)
    7일 안이면 다시 넣지 않습니다. 기본 키는 (데이터셋, 날짜, entity)라 키만으로는 막히지 않습니다.
    """
    with connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT entity FROM observations WHERE dataset = %s AND obs_date >= %s", (dataset, since),
        ).fetchall()
    return {r["entity"] for r in rows}


def insert_new_observations(dataset: str, rows: Iterable[tuple[Any, str, dict]]) -> int:
    """
    (날짜, entity, payload) 행을 **넣기만** 합니다 — 같은 (날짜, entity)가 이미 있으면 그대로 둡니다. 보낸 행 수(날짜를 읽을 수 없는 행은 뺌).

    put_observations는 payload가 다르면 덮어씁니다. 사건 뉴스는 처음 본 행(처음 받은 시각 fetchedAt)을 지켜야 해서 덮지 않습니다.
    """
    params = []
    for raw_date, entity, payload in rows:
        day = _coerce_date(raw_date)
        if day is None or not entity or payload is None:
            continue
        params.append((dataset, day, str(entity), Jsonb(payload)))
    if not params:
        return 0
    with connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO observations (dataset, obs_date, entity, payload, updated_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (dataset, obs_date, entity) DO NOTHING
            """,
            params,
        )
    return len(params)


# 행이 지금 가진 피드 목록 — ``feeds``가 없는 예전 행(피드 키 하나만 ``feed``에 둔 것)은 그 하나로 시작합니다.
_HEADLINE_FEEDS = (
    "(CASE WHEN jsonb_typeof(payload->'feeds') = 'array' THEN payload->'feeds'"
    " WHEN jsonb_typeof(payload->'feed') = 'string' THEN jsonb_build_array(payload->'feed')"
    " ELSE '[]'::jsonb END)"
)


def add_headline_feeds(dataset: str, since: str, pairs: Iterable[tuple[str, str]]) -> int:
    """
    이미 넣은 헤드라인 행(obs_date ≥ since)의 payload ``feeds``에 피드 키를 더합니다 — 아직 없는 키만, 다른 칸(publishedAt·
    fetchedAt 등)은 그대로. (entity, 피드 키) 쌍을 받고, 바꾼 행 수를 돌려줍니다.

    같은 제목이 다른 피드에도 실리면 행은 하나지만, 그 피드만 고른 설정(news.feeds)에서도 보여야 해서 실어 온 피드를 모두 남깁니다.
    insert_new_observations는 덮지 않으므로(처음 받은 시각을 지킴) 목록만 따로 고칩니다.
    """
    params = []
    for entity, feed in dict.fromkeys(pairs):
        if entity and feed:
            params.append((str(feed), dataset, str(entity), since, str(feed)))
    if not params:
        return 0
    sql = (
        "UPDATE observations SET payload = jsonb_set(payload, '{feeds}', "
        + _HEADLINE_FEEDS + " || jsonb_build_array(%s::text)), updated_at = now() "
        "WHERE dataset = %s AND entity = %s AND obs_date >= %s AND NOT ("
        + _HEADLINE_FEEDS + " @> jsonb_build_array(%s::text))"
    )
    changed = 0
    with connection() as conn, conn.cursor() as cur:
        for row in params:
            cur.execute(sql, row)
            changed += cur.rowcount or 0
    return changed


def observation_entity_summary(dataset: str, number_field: str, period_field: str) -> dict[str, dict]:
    """
    entity마다 저장 행 수(``rows``), payload ``number_field``가 숫자인 기간 수(``periodsWithNumber`` — ``period_field`` 값마다 한 번,
    그 칸이 없는 행은 한 행씩), 가장 늦은 obs_date(``latest``).

    어닝 서프라이즈 상태(us.earnings_surprise.status)의 커버리지를 이번 응답이 아니라 **저장된 행**으로 셉니다 — 행은 지우지 않고
    쌓이므로(출처는 최근 4분기만 줌). 기간으로 묶는 것은 출처가 한 분기의 발표일을 바꾸면 같은 ``periodEnd``가 다른 obs_date로 한 행
    더 쌓이기 때문입니다 — 행으로 세면 3분기뿐인 종목이 '4분기 이상'에 들지만, 백엔드 패킷(EarningsHistory)은 분기마다 한 행만
    싣습니다. 기간을 모르는 행은 어느 분기인지 알 수 없어 묶지 않습니다(백엔드와 같음). JSON null은 숫자가 아니라 세지 않습니다.
    """
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT entity, COUNT(*) AS n,
                   COUNT(DISTINCT payload->>%(period)s) FILTER (WHERE jsonb_typeof(payload->%(number)s) = 'number')
                   + COUNT(*) FILTER (WHERE jsonb_typeof(payload->%(number)s) = 'number'
                                      AND payload->>%(period)s IS NULL) AS k,
                   MAX(obs_date) AS latest
            FROM observations WHERE dataset = %(dataset)s GROUP BY entity
            """,
            {"number": number_field, "period": period_field, "dataset": dataset},
        ).fetchall()
    return {r["entity"]: {"rows": int(r["n"]), "periodsWithNumber": int(r["k"]), "latest": r["latest"].isoformat()}
            for r in rows}


def list_observation_dates(
    dataset: str, *, filters: dict[str, str] | None = None,
) -> list[str]:
    """
    레코드가 있는 날짜(YYYY-MM-DD) 오름차순. filters를 주면 payload가 그 값을
    모두 포함하는 레코드가 있는 날짜만 — "이 조합의 이력이 실제로 있는 날".
    """
    sql = "SELECT DISTINCT obs_date FROM observations WHERE dataset = %s"
    params: list[Any] = [dataset]
    if filters:
        sql += " AND payload @> %s"
        params.append(Jsonb(filters))
    sql += " ORDER BY obs_date"
    with connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [r["obs_date"].isoformat() for r in rows]


def count_observations() -> int:
    with connection() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM observations").fetchone()
    return int(row["n"])


# ==============================================================================
# 4. 수집 실행 로그
# ==============================================================================
def start_run(group_name: str | None = None) -> int:
    with connection() as conn:
        row = conn.execute(
            "INSERT INTO collector_runs "
            "(started_at, status, pid, host, heartbeat_at, group_name) "
            "VALUES (now(), 'running', %s, %s, now(), %s) RETURNING id",
            (os.getpid(), socket.gethostname(), group_name),
        ).fetchone()
    return int(row["id"])


def heartbeat_run(run_id: int) -> None:
    try:
        with connection() as conn:
            conn.execute(
                "UPDATE collector_runs SET heartbeat_at = now() WHERE id = %s",
                (run_id,),
            )
    except psycopg.Error as exc:
        logger.debug("heartbeat 갱신 실패: %s", exc)


def finish_run(
    run_id: int,
    *,
    status: str,
    ok_count: int = 0,
    fail_count: int = 0,
    detail: str | None = None,
) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE collector_runs SET finished_at = now(), status = %s, "
            "ok_count = %s, fail_count = %s, detail = %s, heartbeat_at = now() "
            "WHERE id = %s",
            (status, ok_count, fail_count, _safe_detail(detail, 2000), run_id),
        )


def _safe_detail(detail: str | None, limit: int) -> str | None:
    """
    실행 기록에 남길 실패 사유 — 비밀값을 가리고 길이를 자릅니다.

    사유는 예외 문구 그대로라 요청 URL(쿼리의 API 키)이 섞일 수 있고, 상태 화면에 나가
    복사됩니다. 로그만 가리던 것을 저장할 때도 가립니다.
    """
    return (_redacted(detail) or "")[:limit] or None


def _redacted(detail: str | None) -> str | None:
    """가리기 전에 저장된 옛 기록을 내보낼 때 씁니다 (길이는 그대로)."""
    return logredact.redact(detail) if detail else detail


def record_task_run(
    run_id: int | None,
    task: str,
    *,
    speed: str | None,
    status: str,
    started_at: datetime,
    duration_ms: int,
    detail: str | None = None,
) -> None:
    """status: ok | empty(수집됐지만 데이터 없음) | error"""
    try:
        with connection() as conn:
            conn.execute(
                "INSERT INTO collector_task_runs "
                "(run_id, task, speed, status, started_at, duration_ms, detail) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    run_id, task, speed, status,
                    started_at.astimezone(timezone.utc),
                    duration_ms, _safe_detail(detail, 1000),
                ),
            )
    except psycopg.Error as exc:
        logger.warning("태스크 로그 기록 실패 (%s): %s", task, exc)


def _pid_is_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)   # 시그널 0 = 존재 확인만
    except ProcessLookupError:
        return False
    except PermissionError:
        return True            # 존재하지만 권한이 없음
    except (TypeError, ValueError, OSError):
        return False
    return True


def resolve_run_status(run: dict | None) -> str:
    """
    기록된 status를 실제 상태로 보정합니다.

    'running'으로 남아 있지만 프로세스가 죽었거나 heartbeat가 끊긴 경우
    'interrupted'로 보고합니다. 그래야 상태 화면이 거짓말을 하지 않습니다.
    """
    if not run:
        return "none"

    status = run.get("status") or "?"
    if status != "running":
        return status

    same_host = (run.get("host") or socket.gethostname()) == socket.gethostname()
    if same_host and not _pid_is_alive(run.get("pid")):
        return "interrupted"

    beat = run.get("heartbeat_at") or run.get("started_at")
    if isinstance(beat, datetime):
        age = (datetime.now(timezone.utc) - beat).total_seconds()
        if age > STALE_RUN_SECONDS:
            return "interrupted"

    return "running"


def mark_stale_runs_interrupted() -> int:
    """
    죽은 'running' 레코드를 정리합니다. **수집기 기동 시에만** 호출합니다.

    기동 직후에는 이 프로세스가 시작한 실행이 아직 없으므로, 같은 호스트·같은 PID로 남은
    'running' 기록은 이전 프로세스의 것입니다. 컨테이너가 재시작되면 새 수집기도 PID 1이라
    "살아 있는 PID"로 보여, 예전에는 heartbeat 기준(30분)이 지날 때까지 "진행 중"으로 남았습니다.
    """
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM collector_runs WHERE status = 'running'"
        ).fetchall()

        stale = [
            r["id"] for r in rows
            if _left_by_previous_process(r) or resolve_run_status(dict(r)) == "interrupted"
        ]
        if not stale:
            return 0

        conn.execute(
            "UPDATE collector_runs SET status = 'interrupted', "
            "detail = COALESCE(detail, '') || ' [비정상 종료로 판정]' "
            "WHERE id = ANY(%s)",
            (stale,),
        )
    logger.info("비정상 종료된 수집 기록 %d건을 정리했습니다.", len(stale))
    return len(stale)


def _left_by_previous_process(run: dict) -> bool:
    """이 호스트에서 지금 프로세스와 같은 PID로 남은 기록인지 (기동 시 판정 전용)."""
    same_host = (run.get("host") or socket.gethostname()) == socket.gethostname()
    return same_host and run.get("pid") == os.getpid()


def read_last_run() -> dict | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM collector_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return dict(row) if row else None


# 시간 상한을 넘긴 실행이 뒤에서 계속 도는 동안의 호출이 남기는 ⚠️ 안내 행의 앞머리(tasks/runner._still_running, QA-117).
# 태스크별 요약은 이 행을 최근 결과로 고르지 않습니다(QA-139). 백엔드 StoreRepository가 같은 글자를 씁니다
# (StillRunningNoticeParityTest가 대조).
STILL_RUNNING_PREFIX = "이전 수집이 아직 진행 중"


def read_task_summary(task_names: Sequence[str] | None = None) -> list[dict]:
    """
    태스크별 '가장 최근 실행 결과'.

    :param task_names: 지금 등록된 태스크 이름. 주면 그 태스크만 돌려줍니다.
    주의사항 — 실행 기록은 태스크를 없앤 뒤에도 남습니다. 거르지 않으면 없어진
    태스크가 상태 화면에 영원히 남고, 누를 수 없는 "다시 실행" 버튼이 생깁니다.

    태스크마다 (task, id DESC) 인덱스의 첫 행만 읽습니다. 예전 DISTINCT ON은 실행 기록
    전체를 정렬해, 1년치(43만 행)에서 125ms가 걸렸습니다(지금 0.14ms).

    좀비가 도는 동안의 ⚠️ 안내 행(STILL_RUNNING_PREFIX)은 건너뛰고 그 앞 실행(❌ 시간 초과)을 씁니다 — 그 행을
    고르면 실제로는 멈춰 있는 태스크가 상태 화면의 '현재 오류'에서 빠졌습니다(QA-139). 실행 기록에는 그대로 남습니다.
    """
    params: list[Any] = []
    if task_names is None:
        # 기록에 있는 태스크 이름을 인덱스에서 하나씩 건너뛰며 찾습니다.
        names_sql = """
            WITH RECURSIVE names AS (
                (SELECT task FROM collector_task_runs ORDER BY task LIMIT 1)
                UNION ALL
                SELECT (SELECT r.task FROM collector_task_runs r
                        WHERE r.task > n.task ORDER BY r.task LIMIT 1)
                FROM names n WHERE n.task IS NOT NULL
            )
            SELECT task FROM names
        """
    else:
        names_sql = "SELECT DISTINCT unnest(%s::text[]) AS task"
        params.append(list(task_names))
    sql = f"""
        SELECT latest.* FROM ({names_sql}) t
        CROSS JOIN LATERAL (
            SELECT task, speed, status, started_at, duration_ms, detail, run_id
            FROM collector_task_runs r
            WHERE r.task = t.task
              AND NOT (r.status = 'empty' AND r.detail IS NOT NULL AND r.detail LIKE %s)
            ORDER BY r.id DESC LIMIT 1
        ) latest
        ORDER BY latest.task
    """
    params.append(STILL_RUNNING_PREFIX + "%")
    with connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def read_task_history(task: str | None = None, limit: int = 50) -> list[dict]:
    sql = (
        "SELECT run_id, task, speed, status, started_at, duration_ms, detail "
        "FROM collector_task_runs"
    )
    params: list[Any] = []
    if task:
        sql += " WHERE task = %s"
        params.append(task)
    sql += " ORDER BY id DESC LIMIT %s"
    params.append(int(limit))

    with connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


# ==============================================================================
# 5. 수동 새로고침 기준 시각
# ==============================================================================
def request_refresh(scope: str = "global") -> datetime:
    """
    "이 시각 이전 저장본은 낡은 것으로 본다"는 기준을 세웁니다.

    저장본을 지우지 않는 이유: 수집이 실패하면 보여 줄 값이 아예 없어지기
    때문입니다. 구버전 store.request_refresh()와 같은 판단입니다.
    """
    with connection() as conn:
        row = conn.execute(
            "INSERT INTO refresh_requests (scope, requested_at) VALUES (%s, now()) "
            "ON CONFLICT (scope) DO UPDATE SET requested_at = now() "
            "RETURNING requested_at",
            (scope,),
        ).fetchone()
    return row["requested_at"]


def refresh_requested_at(scope: str = "global") -> datetime | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT requested_at FROM refresh_requests WHERE scope = %s",
            (scope,),
        ).fetchone()
    return row["requested_at"] if row else None


# ==============================================================================
# 6. 상태 요약 / 정리
# ==============================================================================
def purge_retired_datasets() -> int:
    """
    더 이상 쓰지 않는 누적 데이터셋을 지웁니다(기동 시 1회).

    기능을 없애도 쌓아 둔 행은 DB에 남아 용량과 백업 크기만 차지합니다.
    지운 행 수를 돌려줍니다.
    """
    removed = 0
    with connection() as conn:
        for dataset in catalog.RETIRED_OBSERVATION_DATASETS:
            cur = conn.execute("DELETE FROM observations WHERE dataset = %s", (dataset,))
            removed += cur.rowcount or 0
    return removed


def store_stats(task_names: Sequence[str] | None = None) -> dict:
    last = read_last_run()
    return {
        "snapshots": list_snapshots(),
        "timeseriesRows": count_timeseries(),
        "observationRows": count_observations(),
        "lastRun": _serialize_run(last),
        "lastRunStatus": resolve_run_status(last),
        "taskSummary": [_serialize_task(t) for t in read_task_summary(task_names)],
        "missingDatasets": missing_datasets(),
    }


def _serialize_run(run: dict | None) -> dict | None:
    if not run:
        return None
    out = dict(run)
    for key in ("started_at", "finished_at", "heartbeat_at"):
        value = out.get(key)
        if isinstance(value, datetime):
            out[key] = value.isoformat()
    return {
        "id": out.get("id"),
        "startedAt": out.get("started_at"),
        "finishedAt": out.get("finished_at"),
        "heartbeatAt": out.get("heartbeat_at"),
        "status": out.get("status"),
        "okCount": out.get("ok_count"),
        "failCount": out.get("fail_count"),
        "detail": _redacted(out.get("detail")),
        "pid": out.get("pid"),
        "host": out.get("host"),
        "groupName": out.get("group_name"),
    }


def _serialize_task(task: dict) -> dict:
    started = task.get("started_at")
    return {
        "task": task.get("task"),
        "speed": task.get("speed"),
        "status": task.get("status"),
        "startedAt": started.isoformat() if isinstance(started, datetime) else started,
        "durationMs": task.get("duration_ms"),
        "detail": _redacted(task.get("detail")),
        "runId": task.get("run_id"),
    }


def missing_datasets() -> list[dict]:
    """
    "있어야 하는데 없는" 데이터셋을 찾습니다.

    존재하는 스냅샷만 나열하면 수집이 아예 안 된 데이터셋은 목록에서 조용히
    빠집니다. 기대 목록과 대조해야 누락을 알아챌 수 있습니다.
    """
    from . import indicators

    with connection() as conn:
        rows = conn.execute("SELECT name FROM snapshots").fetchall()
    present = {r["name"] for r in rows}

    expected: list[tuple[str, str]] = [
        (catalog.SNAP_MACRO_COLLECTED, "매크로 카드"),
        (catalog.SNAP_SCRAPER_MARKETS, "TradingView/Yahoo 참고 시세"),
        (catalog.SNAP_FED_LIQUIDITY, "연준 순유동성"),
        (catalog.SNAP_KRX_FUTURES, "KRX 선물 시계열"),
        (catalog.SNAP_SECTOR_HISTORY, "섹터·자산군 ETF 종가"),
        (catalog.SNAP_FX_HISTORY, "환율·달러인덱스 일별 종가"),
        (catalog.SNAP_EQUITY_HISTORY, "13F 매핑 종목 일별 종가"),
        (catalog.SNAP_COT_HISTORY, "CFTC COT 통합"),
        (catalog.snap_daum_futures_trend(25), "Daum 선물 수급 (계약수)"),
        (catalog.SNAP_PAPER_QUOTES, "모의 매매 시세"),
        (catalog.SNAP_TRACK_RECORD_INDEX, "모의 매매 13F 트랙레코드 수집 진행"),
        (catalog.SNAP_US_FUNDAMENTALS_STATUS, "모의 매매 미국 재무(SEC XBRL) 수집 상태"),
        # FRED 키가 없어도 FOMC 상수·실적 일정으로 저장본이 생기므로 키와 상관없이 기대합니다.
        (catalog.SNAP_US_CALENDAR, "모의 매매 미국 발표·실적 일정"),
        # 피드 하나라도 받으면 생깁니다(키 없음). 전부 실패하면 생기지 않아 여기서 '누락'으로 보입니다.
        (catalog.SNAP_NEWS_STATUS, "모의 매매 사건 뉴스(RSS) 수집 상태"),
        # 키가 필요 없습니다(yfinance). 한 종목이라도 받으면 생기고, 전부 실패·내부 API 변경이면 생기지 않아 '누락'으로 보입니다.
        (catalog.SNAP_EARNINGS_SURPRISE_STATUS, "모의 매매 어닝 서프라이즈(yfinance) 수집 상태"),
    ]

    # 키가 있어야 받을 수 있는 데이터셋은 키가 설정된 경우에만 "누락"으로 봅니다.
    # 키를 넣지 않은 사람에게 매번 누락 경고를 띄우면 진짜 누락이 묻힙니다.
    from . import settings
    if settings.data_go_kr_key():
        expected.append((catalog.SNAP_KR_HOLIDAYS, "한국 공휴일 (천문연)"))
    if settings.data_go_kr_key():
        expected.append((catalog.SNAP_FSC_PRICES_META, "국내 공식 시세 (금융위)"))
    if settings.dart_key():
        expected.append((catalog.SNAP_DART_FUNDAMENTALS, "국내 종목 재무 (DART)"))
    if all(settings.toss_credentials()):
        # 🧪 한국 책 관측치 — 토스 키가 있으면 첫 slow에 생깁니다(유니버스가 없어도 ETF 2는 받음). 없으면 토스가 막혔다는 뜻입니다.
        expected.append((catalog.SNAP_KR_PAPER_QUOTES, "모의 매매 한국 책 관측치 (토스)"))

    for sid in indicators.FRED_ALL_SERIES:
        expected.append((catalog.snap_fred_series(sid), f"FRED {sid}"))

    for symbol in ("^VIX", "^MOVE"):
        expected.append((
            catalog.snap_ticker_history(symbol, catalog.VOLATILITY_STORE_PERIOD),
            f"변동성 {symbol}",
        ))

    for asset, info in indicators.COT_ASSETS.items():
        expected.append((
            catalog.snap_cot_contract(info["code"], indicators.COT_WEEKS),
            f"COT {asset}",
        ))

    for market, investor, trade in (
        ("KOSPI", "외국인", "순매수"),
        ("KOSPI", "기관", "순매수"),
        ("KOSPI", "외국인", "순매도"),
    ):
        expected.append((
            catalog.snap_radar_scanner(market, investor, trade, "TODAY"),
            f"수급 레이더 {investor}/{trade}",
        ))

    for inst in indicators.INSTITUTIONS:
        short = inst["name"].split("(")[0].strip()
        for quarters in (1, catalog.MAX_TRACKED_QUARTERS):
            expected.append((
                catalog.snap_sec_13f(inst["cik"], quarters),
                f"13F {short} q{quarters}",
            ))

    return [
        {"name": name, "label": label}
        for name, label in expected
        if name not in present
    ]


def purge_run_logs(days: int) -> dict[str, int]:
    """
    보존 기간이 지난 수집 실행 기록(collector_task_runs · collector_runs)을 지웁니다.

    실행 기록은 하루 약 1,200행씩 쌓여 DB를 키우고 상태 화면 조회를 느리게 합니다.
    **수집한 데이터(timeseries · observations)는 건드리지 않습니다** — 외부에서 다시
    받을 수 없는 이력이 있습니다.

    기간과 무관하게 남기는 것
      - 태스크마다 가장 최근 1건: 오래 돌지 않은 태스크도 상태 화면이 "마지막 실행"을 보여 줍니다.
      - 최근 실행 50건(collector_runs).

    :param days: 보존 기간(일). 이보다 먼저 시작한 기록이 대상입니다
    :returns: {"taskRuns": 지운 태스크 기록 수, "collectorRuns": 지운 실행 기록 수}
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    with connection() as conn:
        task_runs = conn.execute(
            "DELETE FROM collector_task_runs old WHERE old.started_at < %s "
            "AND EXISTS (SELECT 1 FROM collector_task_runs newer "
            "            WHERE newer.task = old.task AND newer.id > old.id)",
            (cutoff,),
        ).rowcount
        runs = conn.execute(
            "DELETE FROM collector_runs WHERE started_at < %s "
            "AND id NOT IN (SELECT id FROM collector_runs ORDER BY id DESC LIMIT 50)",
            (cutoff,),
        ).rowcount
    return {"taskRuns": task_runs, "collectorRuns": runs}


# ==============================================================================
# 7. 내부 헬퍼
# ==============================================================================
def _coerce_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value)[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return None if out != out else out      # NaN 제거


def json_dumps(value: Any) -> str:
    """로그/디버그용. DB 저장에는 Jsonb를 씁니다."""
    return json.dumps(value, ensure_ascii=False, default=str)
