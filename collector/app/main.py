"""
app/main.py
수집기 FastAPI 애플리케이션.

[역할 분담]
  수집기(Python)  : 외부 소스 수집·파싱·적재, 그리고 키가 필요한 실시간 조회
  백엔드(Java)    : 저장본 읽기·분석·캐시·인증·화면용 API
  프런트(Next.js) : 표시

구버전의 `python collector.py --loop` / `--status` / `--task` / `--verify`는
각각 스케줄러와 아래 엔드포인트로 옮겼습니다.

  --loop            → 상주 스케줄러 (COLLECTOR_SCHEDULER=true)
  --only fast       → POST /collect?group=fast
  --task krx_futures→ POST /collect/task/krx_futures
  --status          → GET  /status
  --history         → GET  /task-history
  --verify          → GET  /verify/* (판정은 백엔드가 합니다)
  --purge-days      → 없음 (금융위 시세·토스 종목 수급은 태스크가 보존 기한으로, 실행 기록은 run_log_retention이 정리)
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
import psycopg
from psycopg_pool import PoolTimeout
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import catalog, krcalendar, logredact, settings, store, tasks, verification, webguard
from .services import (
    detail as detail_service,
    kis as kis_service,
    krx as krx_service,
    live_prices as live_prices_service,
    market as market_service,
    radar as radar_service,
    search as search_service,
    toss as toss_service,
    toss_account as toss_account_service,
    toss_trade as toss_trade_service,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

# basicConfig 직후에 답니다. 이 뒤로 찍히는 모든 로그에서 API 키 같은
# 비밀값이 가려집니다 (서드파티 라이브러리가 찍는 것까지 포함).
logredact.install()

logger = logging.getLogger("collector")

KST = ZoneInfo("Asia/Seoul")

scheduler: BackgroundScheduler | None = None

# polite 속도군의 틱 — 이 간격으로 "때가 된 태스크가 있나"만 봅니다(외부 호출 없음). 지터는 틱이 정각에 맞물리지 않게 하는 정도.
POLITE_TICK_SECONDS = 300
POLITE_TICK_JITTER_SECONDS = 120

# 고정 위상 군(slow 매시 :15 · session 매 5분 :20초)이 늦게 깨어도 돌 수 있는 여유(초) — APScheduler 3.11의 기본은 1초라, 스케줄러가 조금만 늦어도
# 그 회차를 통째로 건너뜁니다(slow면 미국 결정이 한 시간 밀림). slow는 15분(다음 회차 전에 끝날 여유), session은 2분(주기 5분보다 짧게).
SLOW_MISFIRE_GRACE_SECONDS = 900
SESSION_MISFIRE_GRACE_SECONDS = 120
# 주기(interval) 갈래의 유예(초) — fast·weekly와, 주기를 바꾼 실험 스택의 slow·session. 이 갈래는 기동 직후 한 번(next_run_time = 기동 시각)을
# 돌리는데, 그 시각을 잡은 뒤 스케줄러가 시작하기 전에 DB 읽기(관측치 시각·끊긴 회차)가 끼어 기본 유예 1초를 넘기면 그 한 번을 버립니다 —
# fast는 5분 뒤, weekly는 12시간 뒤에야 처음 돕니다(QA-374). 군의 주기보다 짧게 잡습니다.
INTERVAL_MISFIRE_GRACE_SECONDS = {
    "fast": 60, "weekly": 900, "slow": SLOW_MISFIRE_GRACE_SECONDS, "session": SESSION_MISFIRE_GRACE_SECONDS,
}
# polite 틱(5분 + 지터)도 같은 이유로 — 늦게 깬 틱을 버리지 않고 늦게 돕니다(틱은 때가 된 태스크가 있나만 봄).
POLITE_TICK_MISFIRE_GRACE_SECONDS = 60


def slow_first_run(now: datetime, last_quotes_at: datetime | None, at_minute: int) -> datetime | None:
    """
    기동 직후 slow 한 번을 돌릴 시각 — 돌리면 ``now``, 아니면 None(그때는 ``next_run_time`` 인자를 아예 넘기지 않음 — APScheduler 3.11에서
    None은 작업을 일시정지로 등록합니다). 다음 고정 시각(매시 ``at_minute``분)까지 ``SLOW_STARTUP_GAP_MINUTES``분보다 많이 남았고, 관측치
    (``paper.quotes``) 저장본이 그보다 오래됐거나 없을 때만 돕니다.

    이유: 실행 감사의 관측치 사슬(백엔드 PaperExecutionAuditJob)은 5분마다 관측치 저장본을 하나씩 이어 증명하는데, 재기동 직후 한 번이 고정 시각
    몇 분 앞뒤에 저장본을 하나 더 만들면 감사가 그 사이 저장본을 놓쳐 그 뒤 대기 주문의 계좌1식 기준이 끝까지 비게 됩니다. 정시 직후(:15 회차가 막
    돈 뒤)·정시 직전(곧 돎)에는 기다리고, 그 밖(저장본이 오래됨)에는 바로 채웁니다.
    """
    gap = timedelta(minutes=settings.SLOW_STARTUP_GAP_MINUTES)
    if _next_slow_at(now, at_minute) - now <= gap:
        return None
    if last_quotes_at is not None and now - last_quotes_at <= gap:
        return None
    return now


# 끊긴 slow 회차를 이어 돌 때 늘 건너뛰는 태스크 — 관측치 저장본은 회차마다 하나(실행 감사의 관측치 사슬, slow_first_run 설명).
SLOW_RESUME_ALWAYS_SKIP = frozenset({"paper_quotes"})


def _next_slow_at(now: datetime, at_minute: int) -> datetime:
    """다음 고정 시각(매시 ``at_minute``분 — ``now``와 같으면 ``now``)."""
    fixed = now.replace(minute=at_minute, second=0, microsecond=0)
    return fixed if fixed >= now else fixed + timedelta(hours=1)


def slow_cycle_start(now: datetime, at_minute: int) -> datetime:
    """이번 slow 회차의 시작 — ``now`` 이하의 가장 최근 매시 ``at_minute``분."""
    fixed = now.replace(minute=at_minute, second=0, microsecond=0)
    return fixed if fixed <= now else fixed - timedelta(hours=1)


def slow_resume_skip(now: datetime, last_quotes_at: datetime | None, at_minute: int,
                     done: frozenset[str] | None) -> frozenset[str] | None:
    """
    기동 직후 slow 전체를 돌지 않기로 했는데(slow_first_run이 None) 이번 회차의 slow 실행이 중간에 끊겼으면(``done`` — 그 회차에 이미 끝난 태스크,
    store.unfinished_group_tasks) 남은 태스크만 곧바로 한 번 돌 때 건너뛸 태스크(``done`` + 관측치 ``paper_quotes``), 돌지 않으면 None(QA-308).

    이유: slow_first_run은 관측치(paper.quotes) 신선도만 봅니다. 그런데 paper_quotes는 slow 회차의 7번째(시작 뒤 1~2분)라, 그 뒤 재기동(배포 up -d,
    OOM·크래시 뒤 재시작)이 회차를 끊으면 관측치는 신선해도 남은 태스크(미국 1분봉 paper_bars_us, 한국 kr_paper_timed·kr_paper_quotes·kr_paper_flows …)가
    다음 정시까지 한 시간 돌지 않습니다 — 규칙 계좌 시각 지정 체결·감시 STOP 체결이 한 시간 밀리고, 한국 22:30 결정 앞의 밤 관측치가 22:15 한 번만 남습니다.
    관측치는 건너뛰어 회차마다 저장본 하나(감사 사슬)를 지킵니다. 다음 정시가 ``SLOW_STARTUP_GAP_MINUTES``분 안이면 그 회차에 맡깁니다.
    """
    if done is None or slow_first_run(now, last_quotes_at, at_minute) is not None:
        return None
    if _next_slow_at(now, at_minute) - now <= timedelta(minutes=settings.SLOW_STARTUP_GAP_MINUTES):
        return None
    return frozenset(done) | SLOW_RESUME_ALWAYS_SKIP


def _slow_done_this_cycle(now: datetime, at_minute: int) -> frozenset[str] | None:
    """이번 slow 회차에 끝나지 않은 실행이 있으면 그 회차에 끝난 태스크(store.unfinished_group_tasks). 읽지 못하면 None(이어 돌지 않음 — 다음 정시가 메움)."""
    try:
        return store.unfinished_group_tasks("slow", slow_cycle_start(now, at_minute))
    except Exception as exc:  # noqa: BLE001
        logger.warning("끊긴 slow 회차를 읽지 못해 남은 태스크를 이어 돌지 않습니다: %s", exc)
        return None


def _last_quotes_at() -> datetime | None:
    """관측치 저장본(paper.quotes — 수집기 표)의 수집 시각. 없거나 읽지 못하면 None(그때는 시각 규칙만으로 정함)."""
    try:
        snapshot = store.read_snapshot(catalog.SNAP_PAPER_QUOTES)
    except Exception as exc:  # noqa: BLE001
        logger.warning("관측치 저장본을 읽지 못해 slow 첫 실행을 시각으로만 정합니다: %s", exc)
        return None
    return None if snapshot is None else snapshot.collected_at

# 내부 서비스 간 호출용 토큰. make setup이 무작위 값으로 채웁니다.
# 비어 있으면 기동하지 않습니다 — COLLECTOR_ALLOW_NO_TOKEN=1을 명시했을 때만 경고하고 기동합니다.
API_TOKEN = os.environ.get("COLLECTOR_API_TOKEN", "")
ALLOW_NO_TOKEN = os.environ.get("COLLECTOR_ALLOW_NO_TOKEN", "").lower() in ("1", "true", "yes")

# Host 헤더 허용 목록. 수집기는 127.0.0.1에만 열려 있지만, DNS 리바인딩(공격자 도메인이 나중에
# 127.0.0.1을 가리킴)으로 브라우저가 '같은 출처' 요청을 보내게 할 수 있습니다. 그 요청의 Host는
# 공격자 도메인이므로 여기서 걸립니다. 백엔드는 compose 서비스 이름(collector)으로 부릅니다.
DEFAULT_ALLOWED_HOSTS = "localhost,127.0.0.1,[::1],collector"


def parse_allowed_hosts(raw: str | None) -> list[str]:
    """쉼표 목록 → Host 허용 목록. 비어 있으면(compose가 빈 문자열을 넘김) 기본 목록."""
    hosts = [h.strip() for h in (raw or "").split(",") if h.strip()]
    return hosts or [h.strip() for h in DEFAULT_ALLOWED_HOSTS.split(",")]


ALLOWED_HOSTS = parse_allowed_hosts(os.environ.get("COLLECTOR_ALLOWED_HOSTS"))


def check_token_configured() -> None:
    """토큰이 비어 있으면 기동을 거부합니다(명시적으로 허용했을 때만 경고로 끝냄)."""
    if API_TOKEN:
        return
    if ALLOW_NO_TOKEN:
        logger.warning(
            "COLLECTOR_API_TOKEN이 비어 있어 수집기가 인증 없이 요청을 받습니다 "
            "(COLLECTOR_ALLOW_NO_TOKEN=1). 로컬 개발용이 아니라면 make setup으로 토큰을 만드세요."
        )
        return
    raise RuntimeError(
        "COLLECTOR_API_TOKEN이 비어 있습니다. make setup이 .env에 토큰을 만들어 줍니다. "
        "인증 없이 띄우려면 COLLECTOR_ALLOW_NO_TOKEN=1을 명시하세요."
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    check_token_configured()
    store.get_pool()
    if os.environ.get("COLLECTOR_INIT_SCHEMA", "true").lower() in ("1", "true", "yes"):
        store.init_schema()

    try:
        removed = store.purge_retired_datasets()
        if removed:
            logger.info("없앤 기능의 누적 데이터 %d행 정리", removed)
    except Exception as exc:  # noqa: BLE001
        logger.warning("없앤 기능의 데이터 정리 실패: %s", exc)

    # 비정상 종료로 'running'에 남아 있던 기록을 먼저 정리합니다.
    try:
        store.mark_stale_runs_interrupted()
    except Exception as exc:  # noqa: BLE001
        logger.warning("오래된 실행 기록 정리 실패: %s", exc)

    # 거래일 판정이 공휴일을 알도록 저장된 공휴일을 올립니다(없으면 주말만 건너뜀).
    loaded = krcalendar.load_from_store()
    logger.info("공휴일 %d일 로드 — 거래일 판정에 사용", loaded)

    global scheduler
    if settings.scheduler_enabled():
        scheduler = BackgroundScheduler(timezone="UTC")
        now = datetime.now(tz=ZoneInfo("UTC"))
        # session: 계좌2 장중 확인 감시(paper_watch_us) — 확인 시각 앞뒤가 아니면 태스크가 외부를 부르지 않고 끝납니다.
        for group in ("fast", "slow", "weekly", "session"):
            seconds = settings.interval_seconds(group)
            common = {"args": [group], "id": f"collect-{group}", "max_instances": 1, "coalesce": True}
            slow_minute = settings.slow_at_minute() if group == "slow" else None
            session_second = settings.session_at_second() if group == "session" else None
            if slow_minute is not None:
                # slow는 매시 :15(실험 조건 — ADR 0018). 기동 직후 한 번은 slow_first_run이 정하고, 돌지 않을 때는 next_run_time을 아예 넘기지
                # 않습니다(None은 일시정지).
                quotes_at = _last_quotes_at()
                first = slow_first_run(now, quotes_at, slow_minute)
                if first is not None:
                    common["next_run_time"] = first
                scheduler.add_job(_run_group_job, "cron", minute=slow_minute, second=0, timezone="UTC",
                                  misfire_grace_time=SLOW_MISFIRE_GRACE_SECONDS, **common)
                logger.info("스케줄 등록: slow 매시 :%02d(기동 직후 %s)", slow_minute, "바로 한 번" if first else "다음 정시까지 기다림")
                # 관측치 저장 뒤 끊긴 이번 회차 — 남은 태스크만 곧바로 한 번(QA-308, slow_resume_skip).
                skip = None if first is not None else slow_resume_skip(now, quotes_at, slow_minute,
                                                                         _slow_done_this_cycle(now, slow_minute))
                if skip is not None and any(task.speed == "slow" and task.name not in skip for task in tasks.ALL_TASKS):
                    scheduler.add_job(_run_group_job, "date", run_date=now, args=["slow"], kwargs={"skip": skip},
                                      id="collect-slow-resume", max_instances=1, misfire_grace_time=SLOW_MISFIRE_GRACE_SECONDS)
                    logger.info("스케줄 등록: 끊긴 slow 회차의 남은 태스크를 바로 한 번(건너뜀 %d개 — 관측치 포함)", len(skip))
            elif session_second is not None:
                # session은 매 5분 :20초 — 개장(09:30 ET·09:00 KST)에서 5분 격자. 기동 직후 한 번은 그대로(확인·감시 시각 밖이면 외부 호출 없음).
                scheduler.add_job(_run_group_job, "cron", minute="*/5", second=session_second, timezone="UTC",
                                  misfire_grace_time=SESSION_MISFIRE_GRACE_SECONDS, next_run_time=now, **common)
                logger.info("스케줄 등록: session 매 5분 :%02d초", session_second)
            else:
                # 기동 직후 한 번씩 돌립니다. 싼 것부터(fast → slow → weekly → session)
                # 처리해야 가장 자주 보는 데이터가 먼저 채워집니다.
                scheduler.add_job(_run_group_job, "interval", seconds=seconds, next_run_time=now,
                                  misfire_grace_time=INTERVAL_MISFIRE_GRACE_SECONDS[group], **common)
                logger.info("스케줄 등록: %s 주기 %d초", group, seconds)
        # polite(차단 통과 수집 계층 — ADR 0026): 틱마다 때가 된 태스크만 실행합니다. next_run_time을 주지 않아 기동 직후에는 돌지 않고
        # (첫 틱은 한 주기 뒤), 틱 자체도 매번 0~POLITE_TICK_JITTER_SECONDS초 늦춰 정각에 맞물리지 않게 합니다. 태스크의 실행 시각은
        # 이 틱이 아니라 태스크마다 무작위로 정한 다음 실행 시각(표 fetch_schedule)이 정합니다.
        scheduler.add_job(
            _run_polite_job,
            "interval",
            seconds=POLITE_TICK_SECONDS,
            jitter=POLITE_TICK_JITTER_SECONDS,
            id="collect-polite",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=POLITE_TICK_MISFIRE_GRACE_SECONDS,
        )
        logger.info("스케줄 등록: polite 틱 %d초(+지터 %d초) — 때가 된 태스크만", POLITE_TICK_SECONDS, POLITE_TICK_JITTER_SECONDS)
        # flex(탄력 주기 — ADR 0040): 1분 틱이 때가 된 일이 있는 태스크만 실행합니다(사건 뉴스 RSS — 피드마다 다음 시각, 표 fetch_schedule).
        # polite처럼 next_run_time을 주지 않아 기동 직후에는 돌지 않습니다. 로컬에서도 돕니다(POLITE_FETCH_ENABLED와 무관).
        scheduler.add_job(
            _run_flex_job,
            "interval",
            seconds=tasks.flex.TICK_SECONDS,
            jitter=tasks.flex.TICK_JITTER_SECONDS,
            id="collect-flex",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=tasks.flex.TICK_MISFIRE_GRACE_SECONDS,
        )
        logger.info("스케줄 등록: flex 틱 %d초(+지터 %d초) — 때가 된 피드가 있는 태스크만", tasks.flex.TICK_SECONDS,
                    tasks.flex.TICK_JITTER_SECONDS)
        scheduler.start()
    else:
        logger.info("스케줄러 비활성화 — REST 요청으로만 수집합니다.")

    yield

    if scheduler:
        scheduler.shutdown(wait=False)
    store.close_pool()


app = FastAPI(
    title="Local Macro Dashboard — Collector",
    version="2.0.0",
    description="외부 시장 데이터 수집기 (PostgreSQL 적재 + 실시간 조회 API)",
    lifespan=lifespan,
)

# 브라우저에서 온 교차 출처 요청은 토큰 유무와 관계없이 막습니다(webguard 설명 참고).
app.add_middleware(webguard.CrossSiteRequestGuard)
# 모르는 Host 헤더는 400 — DNS 리바인딩으로 '같은 출처'가 된 브라우저 요청을 막습니다.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)


def _run_group_job(group: str, skip: frozenset[str] = frozenset()) -> None:
    try:
        tasks.run_group(group, skip=skip)
    except Exception as exc:  # noqa: BLE001
        logger.exception("스케줄 수집 실패 (%s): %s", group, exc)


def _run_polite_job() -> None:
    try:
        tasks.run_polite_due()
    except Exception as exc:  # noqa: BLE001
        logger.exception("스케줄 수집 실패 (polite): %s", exc)


def _run_flex_job() -> None:
    try:
        tasks.run_flex_due()
    except Exception as exc:  # noqa: BLE001
        logger.exception("스케줄 수집 실패 (flex): %s", exc)


def _check_token(token: str | None) -> None:
    """
    서비스 토큰을 검사합니다. 토큰이 비어 있으면 통과시킵니다 — 빈 토큰으로는 기동하지 않으므로
    (check_token_configured), COLLECTOR_ALLOW_NO_TOKEN=1을 명시해 띄운 경우뿐입니다.

    주의사항 — 비교는 hmac.compare_digest로 합니다. ``!=``는 앞에서부터 비교하다
    다른 글자에서 멈추므로 응답 시간 차이로 토큰을 한 글자씩 맞혀 볼 수 있습니다.
    """
    if API_TOKEN and not hmac.compare_digest(
        (token or "").encode("utf-8"), API_TOKEN.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="유효하지 않은 서비스 토큰입니다.")


def _parse_date(value: str | None) -> date | None:
    """
    'YYYY-MM-DD'를 날짜로 바꿉니다.

    형식이 틀리면 ValueError가 그대로 올라가 500(서버 오류)이 됐습니다.
    잘못 보낸 쪽이 무엇을 고쳐야 하는지 알 수 있게 400으로 답합니다.
    """
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"날짜 형식이 올바르지 않습니다: {value} (예: 2026-09-18)",
        ) from None


# ==============================================================================
# 상태
# ==============================================================================
@app.get("/health")
def health() -> JSONResponse:
    """
    DB 연결까지 확인합니다(QA-010). 예전에는 PostgreSQL이 끊겨도 {"status": "ok"}였습니다 — 백엔드의
    /api/health처럼 닿지 못하면 503 + database:unreachable로 답해 doctor·compose가 원인을 바로 보게 합니다.
    """
    body = {"status": "ok", "database": "ok", "schedulerEnabled": settings.scheduler_enabled()}
    try:
        store.ping()
    except (psycopg.Error, PoolTimeout) as exc:
        logger.warning("헬스체크: DB에 닿지 못했습니다: %s", exc)
        body.update(status="degraded", database="unreachable")
        return JSONResponse(body, status_code=503)
    return JSONResponse(body)


@app.exception_handler(psycopg.OperationalError)
@app.exception_handler(PoolTimeout)
def database_unavailable(request, exc):   # noqa: ARG001
    """
    DB에 연결하지 못한 요청은 평문 500이 아니라 503 JSON으로(QA-010). 원문·스택은 로그에만 남깁니다.
    """
    logger.warning("DB에 연결하지 못했습니다 (%s %s): %s", request.method, request.url.path, exc)
    return JSONResponse(
        {"error": "database_unavailable",
         "detail": "데이터베이스에 연결할 수 없습니다. PostgreSQL이 켜져 있는지 확인하세요 (make logs S=postgres)."},
        status_code=503,
    )


@app.get("/status")
def status() -> dict:
    """구버전 `collector.py --status`에 해당합니다."""
    stats = store.store_stats(task_names=[task.name for task in tasks.ALL_TASKS])
    stats["keys"] = {
        "fred": bool(settings.fred_key()),
        "krx": bool(settings.krx_key()),
        "kis": kis_service.has_credentials(),
        "toss": toss_service.has_credentials(),
        "dataGoKr": bool(settings.data_go_kr_key()),
        "dart": bool(settings.dart_key()),
    }
    stats["intervals"] = {
        group: settings.interval_seconds(group)
        for group in ("fast", "slow", "weekly", "session")
    }
    # 차단 통과 수집(polite — 관심 대상 정기 수집 포함)이 이 수집기에서 도는가(POLITE_FETCH_ENABLED, ADR 0035·0041). 값만 — 비밀 없음.
    from .tasks import polite

    stats["politeEnabled"] = polite.enabled()
    return stats


@app.get("/tasks")
def list_tasks() -> dict:
    return {
        "tasks": [
            {"name": t.name, "speed": t.speed, "description": t.description}
            for t in tasks.ALL_TASKS
        ]
    }


@app.get("/info/mechanism")
def info_mechanism(x_service_token: str | None = Header(default=None)) -> dict:
    """
    정보 수집의 작동 방식(ADR 0026·0035·0036) — 코드에 있는 실제 값: 스위치, 계층·물러남·포기·사람 확인 규칙, 요청 사이 지연, 호스트별 계층·하루
    예산, 태스크별 간격, 본문·보관 규칙. 외부를 부르지 않습니다(브라우저 컨테이너의 /health만 안쪽 망으로).
    호스트별 오늘 쓴 예산·마지막 통과 계층·닫힘과 다음 실행 시각은 백엔드가 표(fetch_hosts·fetch_schedule)에서 읽어 붙입니다.
    """
    _check_token(x_service_token)
    from .fetch import browser_client, policy as fetch_policy
    from .services import info_blogs, info_waedge, info_text
    from .tasks import info as info_tasks, polite

    gap = fetch_policy.Gap()
    browser = browser_client.health()
    return {
        "politeEnabled": polite.enabled(),
        "tickSeconds": POLITE_TICK_SECONDS,
        "tickJitterSeconds": POLITE_TICK_JITTER_SECONDS,
        "taskDeadlineSeconds": tasks.runner.TASK_DEADLINE_SECONDS.get("polite"),
        "browser": {
            "configured": browser_client.available(),
            "reachable": browser is not None,
            "pressCheckbox": None if browser is None else browser.get("pressCheckbox"),
            "allowedHosts": None if browser is None else browser.get("allowedHosts"),
        },
        "gap": {"medianSeconds": gap.median, "lowSeconds": gap.low, "highSeconds": gap.high, "longChance": gap.long_chance,
                "longLowSeconds": gap.long_low, "longHighSeconds": gap.long_high},
        "backoffMinutes": [list(pair) for pair in fetch_policy.BACKOFF_MINUTES],
        "humanCheckMinutes": list(fetch_policy.HUMAN_CHECK_MINUTES),
        "giveUpLevel": fetch_policy.GIVE_UP_LEVEL,
        "giveUpRecheckDays": polite.GIVE_UP_RECHECK_DAYS,
        "staleFactor": polite.STALE_FACTOR,
        "hosts": [{"host": rule.host, "tiers": list(rule.tiers), "dailyBudget": rule.daily_budget}
                  for rule in fetch_policy.POLICIES.values()],
        "cadences": info_tasks.cadences(),
        "articles": {
            "maxAgeDays": info_blogs.MAX_AGE_DAYS,
            "pageMaxAgeDays": info_blogs.PAGE_MAX_AGE_DAYS,
            "pageFetchesPerRun": info_blogs.PAGE_FETCHES_PER_RUN,
            "pageTriesPerItem": info_blogs.PAGE_TRIES_PER_ITEM,
            "feedBodyMinChars": info_blogs.FEED_BODY_MIN_CHARS,
            "waedgeBriefBodiesPerRun": info_waedge.BRIEF_BODIES_PER_RUN,
            "waedgePeopleBodiesPerRun": info_waedge.PEOPLE_BODIES_PER_RUN,
            "bodyMaxChars": store.INFO_BODY_MAX_CHARS,
            "summaryChars": info_text.SUMMARY_CHARS,
            "retentionDays": store.INFO_RETENTION_DAYS,
        },
    }


@app.get("/task-history")
def task_history(
    task: str | None = None,
    limit: int = Query(40, ge=1, le=200),
) -> dict:
    rows = store.read_task_history(task, limit)
    return {"history": [store._serialize_task(row) for row in rows]}


# ==============================================================================
# 수집 실행
# ==============================================================================
@app.post("/collect")
def collect(
    group: str = Query("all", pattern="^(fast|slow|weekly|session|all)$"),
    wait: bool = Query(True, description="false면 백그라운드로 실행하고 즉시 응답"),
    background: BackgroundTasks = None,          # type: ignore[assignment]
    x_service_token: str | None = Header(default=None),
) -> dict:
    _check_token(x_service_token)

    if wait:
        return tasks.run_group(group)

    background.add_task(tasks.run_group, group)
    return {"group": group, "accepted": True}


@app.post("/collect/task/{task_name}")
def collect_task(
    task_name: str,
    wait: bool = Query(True, description="false면 백그라운드로 실행하고 즉시 응답"),
    background: BackgroundTasks = None,          # type: ignore[assignment]
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    태스크 1건을 실행합니다.

    wait=false는 **화면이 수집을 기다리지 않게** 하려고 있습니다. 저장본이
    이미 있는데 조금 오래된 경우, 백엔드가 이 호출이 끝나기를 기다리면 화면이
    그만큼 멈춥니다. 실제로 sec_13f 한 건에 31.8초, fred_series에 11.5초
    동안 페이지가 붙잡혔습니다.
    """
    _check_token(x_service_token)
    if task_name not in tasks.TASKS_BY_NAME:
        raise HTTPException(
            status_code=404,
            detail=f"알 수 없는 태스크: {task_name} (가능: {sorted(tasks.TASKS_BY_NAME)})",
        )

    if not wait:
        background.add_task(tasks.run_group, task_name=task_name)
        return {"task": task_name, "accepted": True}

    return tasks.run_group(task_name=task_name)


@app.post("/refresh")
def refresh(
    scope: str = "global",
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    수동 새로고침 기준 시각을 갱신합니다.

    저장본을 지우지 않습니다 — 수집이 실패하면 보여 줄 값이 아예 없어지기
    때문입니다. "이 시각 이전 저장본은 낡은 것으로 본다"는 기준만 세웁니다.
    """
    _check_token(x_service_token)
    requested_at = store.request_refresh(scope)
    return {"scope": scope, "requestedAt": requested_at.isoformat()}


# ==============================================================================
# 실시간 조회 (백엔드가 auto 모드에서 호출)
# ==============================================================================
@app.get("/live/radar")
def live_radar(
    market: str = "KOSPI",
    investor: str = "외국인",
    tradeType: str = "순매수",
    topN: int = Query(30, ge=5, le=100),
    intervalType: str = Query("TODAY", pattern="^(TODAY|DAYS_5|DAYS_20)$"),
    targetDate: str | None = None,
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    수급 랭킹을 지금 수집합니다 (폴백 체인 전체를 탑니다).

    저장도 함께 합니다. 화면이 기다린 수집 결과를 버리면 다음 사용자가 또
    기다리게 되기 때문입니다.
    """
    _check_token(x_service_token)
    market = _normalize_market(market)
    _require_one_of("investor", investor, radar_service.RADAR_INVESTORS)
    _require_one_of("tradeType", tradeType, radar_service.RADAR_TRADE_TYPES)
    _require_one_of("intervalType", intervalType, tuple(radar_service.INTERVAL_LABELS))
    requested = _parse_date(targetDate)
    day = requested or datetime.now(KST).date()
    result = radar_service.collect_radar_ranking(
        day, market, investor, tradeType, topN, intervalType
    )

    # 저장은 스케줄러와 같은 조건(오늘·상위 30)일 때만 합니다. 백엔드는 topN≠30이나
    # 과거 날짜 요청이면 저장본을 건너뛰지만, 그 결과를 기본 이름에 저장하면 다음
    # 15분 동안 5행짜리나 과거 랭킹이 '현재 랭킹'으로 나가고 이력에도 쌓입니다.
    is_default_query = requested is None and topN == RADAR_DEFAULT_TOP_N
    # 요청한 기간과 실제로 받은 기간이 다르면(기관 5일 → Daum 당일) 요청한 이름에 쓰지 않습니다(QA-028).
    same_interval = result.get("intervalType", intervalType) == intervalType
    if result.get("rows") and is_default_query and same_interval:
        store.put_snapshot(
            catalog.snap_radar_scanner(market, investor, tradeType, intervalType),
            result,
        )
        if not result.get("isHistorical"):
            radar_service.accumulate_history(
                result["rows"], market, investor, tradeType, intervalType
            )
    return result


RADAR_DEFAULT_TOP_N = 30
RADAR_MARKETS = ("KOSPI", "KOSDAQ")


def _require_one_of(name: str, value: str, allowed: tuple[str, ...]) -> None:
    if value not in allowed:
        raise HTTPException(status_code=400, detail=f"{name}은(는) {' · '.join(allowed)} 가운데 하나여야 합니다: {value!r}")


def _normalize_market(market: str) -> str:
    """
    시장 이름을 KOSPI/KOSDAQ로 맞춥니다. 소문자나 한글이 그대로 저장본 이름·이력 payload에
    들어가면 같은 시장이 다른 키로 갈라져 이력 조회가 빗나갑니다.
    """
    text = (market or "").strip().upper()
    if "코스닥" in text or text == "KOSDAQ":
        return "KOSDAQ"
    if "코스피" in text or text == "KOSPI":
        return "KOSPI"
    raise HTTPException(status_code=400, detail=f"market은 {' 또는 '.join(RADAR_MARKETS)}여야 합니다: {market!r}")


_TICKER_SYMBOL = re.compile(r"^[A-Za-z0-9^=.\-]{1,24}$")


@app.get("/live/ticker/{symbol:path}")
def live_ticker(
    symbol: str,
    period: str = "1mo",
    x_service_token: str | None = Header(default=None),
) -> dict:
    """저장 대상이 아닌 개별 티커 차트(단일 지표 조회 화면)용. 심볼은 야후 형식(^VIX, ZT=F, BRK-B)만."""
    _check_token(x_service_token)
    if not _TICKER_SYMBOL.match(symbol):
        raise HTTPException(status_code=400, detail="심볼 형식이 올바르지 않습니다 (영문·숫자·^=.- 24자 이내).")
    return market_service.collect_ticker(symbol, period)


def _detail_target(market: str, code: str) -> tuple[str, str]:
    """상세 화면의 시장·코드 검사 — 'us'(Yahoo 심볼 형식)·'kr'(국내 6자리, 대문자 영숫자)."""
    market = (market or "").strip().lower()
    code = (code or "").strip()
    if market == "kr":
        code = code.upper()
        if not detail_service.KR_CODE.match(code):
            raise HTTPException(status_code=400, detail="국내 코드는 영문 대문자·숫자 6자리입니다.")
    elif market == "us":
        if not detail_service.US_CODE.match(code):
            raise HTTPException(status_code=400, detail="심볼 형식이 올바르지 않습니다 (영문·숫자·^=.- 24자 이내).")
        code = code.upper()
    else:
        raise HTTPException(status_code=400, detail="market은 us 또는 kr입니다.")
    return market, code


@app.get("/live/quote")
def live_quote(
    market: str = Query(...),
    code: str = Query(...),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """검색 상세 화면의 시세·핵심 지표·개요(미국·해외 Yahoo, 국내 네이버 — services/detail.py). 저장하지 않고 5분 캐시."""
    _check_token(x_service_token)
    return detail_service.quote(*_detail_target(market, code))


@app.get("/live/prices")
def live_prices(
    items: str = Query(..., max_length=1200),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """화면 실시간 시세(ADR 0024) — 'US:AAPL,KR:005930'(최대 60개). 저장하지 않고 3초 캐시(services/live_prices.py)."""
    _check_token(x_service_token)
    try:
        targets = live_prices_service.parse_items(items)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return live_prices_service.prices(targets)


@app.get("/live/news")
def live_news(
    market: str | None = Query(None),
    code: str | None = Query(None),
    q: str | None = Query(None, max_length=60),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """검색 상세 화면의 주요 뉴스(종목 뉴스 Yahoo·네이버 + 검색어 구글 뉴스 RSS). 코드나 검색어 중 하나는 있어야 합니다. 15분 캐시."""
    _check_token(x_service_token)
    query = (q or "").strip() or None
    if code:
        target_market, target_code = _detail_target(market or "us", code)
    elif query:
        target_market, target_code = ((market or "").strip().lower() or None), None
    else:
        raise HTTPException(status_code=400, detail="code나 q 중 하나가 있어야 합니다.")
    return detail_service.news(target_market, target_code, query)


@app.get("/live/symbols")
def live_symbols(
    q: str = Query(..., min_length=1, max_length=40),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """종목 찾기(네이버 자동완성 + Yahoo 검색) — 통합 검색이 저장된 색인 밖의 종목을 찾을 때. 1시간 캐시."""
    _check_token(x_service_token)
    return detail_service.symbols(q.strip())


def _search_input(check, value):
    """정보 검색 입력 검사(services/search) — 틀리면 400(FastAPI의 422가 아니라 계약대로). 검색어는 응답·로그에 되풀이하지 않습니다."""
    try:
        return check(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@app.get("/live/search/suggest")
def live_search_suggest(
    q: str | None = Query(None),
    owner: bool = Query(False),
    external: bool = Query(True),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """정보 검색 — 치는 동안의 후보(이미 가진 색인만, 바깥 호출 없음 — ADR 0041). owner면 거장 이름도. external은 받기만 합니다."""
    _check_token(x_service_token)
    text = _search_input(search_service.clean_query, q)
    return search_service.suggest(text, owner=owner)


@app.get("/live/search/resolve")
def live_search_resolve(
    q: str | None = Query(None),
    owner: bool = Query(False),
    external: bool = Query(True),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """정보 검색 — Enter의 후보(로컬 + Wikidata 1시간 캐시, 맨 끝에 topic:<q>). external=false면 Wikidata를 부르지 않습니다."""
    _check_token(x_service_token)
    text = _search_input(search_service.clean_query, q)
    return search_service.resolve(text, owner=owner, external=external)


@app.get("/live/search/entity")
def live_search_entity(
    e: str | None = Query(None),
    owner: bool = Query(False),
    external: bool = Query(True),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """정보 검색 — 대상 풀기(SEC·DART 저장본·13F·Wikidata, 하루 캐시). external=false면 저장본·캐시만."""
    _check_token(x_service_token)
    prefix, value = _search_input(search_service.parse_key, e)
    return search_service.entity(f"{prefix}:{value}", external=external)


@app.get("/live/search/feed")
def live_search_feed(
    e: str | None = Query(None),
    tab: str | None = Query(None),
    owner: bool = Query(False),
    external: bool = Query(True),
    refresh: bool = Query(False),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    정보 검색 — 탭 하나의 결과(최근 2년 묶음, 출처별 상태). 운영자 전용 저장본은 owner일 때만, external=false면 바깥 출처는 캐시만.
    refresh면 출처 캐시를 건너뜀('지금 새로 받기' — 사용자당 빈도는 백엔드가 막음).
    """
    _check_token(x_service_token)
    prefix, value = _search_input(search_service.parse_key, e)
    checked_tab = _search_input(search_service.check_tab, tab)
    return search_service.feed(f"{prefix}:{value}", checked_tab, owner=owner, external=external, refresh=refresh)


@app.get("/live/search/links")
def live_search_links(
    e: str | None = Query(None),
    owner: bool = Query(False),
    external: bool = Query(True),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    정보 검색 — 연결 보강(계약 §7-5: Yahoo 내부자 명단·GLEIF 법인 관계, 출처마다 캐시). 대상 풀기와 따로 부릅니다(연결 탭을 열 때).
    external=false면 캐시만. 운영자 전용 출처는 없어 owner는 받기만 합니다.
    """
    _check_token(x_service_token)
    prefix, value = _search_input(search_service.parse_key, e)
    return search_service.links(f"{prefix}:{value}", external=external, owner=owner)


@app.get("/live/search/recent")
def live_search_recent(
    owner: bool = Query(False),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """정보 검색 첫 화면 — 새 피드 묶음 최근 30건(owner면 속보 최근 20건을 더함). 저장본만(바깥 호출 0건)."""
    _check_token(x_service_token)
    return search_service.recent(owner=owner)


@app.get("/live/search/excludes")
def live_search_excludes(x_service_token: str | None = Header(default=None)) -> dict:
    """
    정보 검색 매체 제외 목록의 처음 값(묶음 이름과 함께)과 늘 적용하는 규칙. 바깥 호출·DB 없음. 이 수집기에서 관심 대상 정기 수집이 도는지
    (politeEnabled — POLITE_FETCH_ENABLED)도 함께 답합니다(백엔드의 /api/search/watch collecting — /status보다 가벼움).
    """
    _check_token(x_service_token)
    from .tasks import polite

    return {**search_service.excludes(), "politeEnabled": polite.enabled()}


@app.get("/live/daum-intraday")
def live_daum_intraday(
    minutes: int = Query(30, ge=5, le=180),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """장중 선물 수급 가속도. 1분 단위로 변하므로 저장하지 않습니다."""
    _check_token(x_service_token)
    return krx_service.collect_daum_intraday_acceleration(minutes)


# ==============================================================================
# 교차 검증용 읽기 (판정은 백엔드가 합니다) — 읽는 코드는 verification.py
# ==============================================================================
@app.get("/verify/readings")
def verification_readings(
    market: str = "KOSPI",
    investor: str = "외국인",
    tradeType: str = "순매수",
    x_service_token: str | None = Header(default=None),
) -> dict:
    """같은 수치를 서로 다른 출처에서 읽어 원자료 그대로 돌려줍니다(verification.readings)."""
    _check_token(x_service_token)
    return verification.readings(market, investor, tradeType)


# ==============================================================================
# 연결 진단
# ==============================================================================
@app.get("/diagnostics/connections")
def diagnostics(
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    수급 레이더 폴백 체인의 소스별 연결 상태 (KIS·Daum·Naver·토스).

    진단은 **화면이 실제로 쓰는 경로**를 그대로 호출합니다. 진단이 다른
    경로를 보면 "진단은 정상인데 화면은 빈" 상황을 설명할 수 없습니다.
    """
    _check_token(x_service_token)
    return {
        "checkedAt": datetime.now(KST).isoformat(),
        "sources": {
            "kis": kis_service.test_connection(),
            "daum": radar_service.test_daum_connection(),
            "naver": radar_service.test_naver_connection(),
            "toss": radar_service.test_toss_connection(),
        },
    }


@app.get("/diagnostics/public-apis")
def public_api_diagnostics(
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    국내 공공 API(공공데이터포털·DART) 연결 진단. API마다 1회씩 호출합니다.

    결과에 키는 들어 있지 않습니다(설정 여부만 true/false).
    """
    _check_token(x_service_token)
    from .services import publicprobe
    return publicprobe.run()


@app.get("/diagnostics/toss")
def toss_diagnostics(
    x_service_token: str | None = Header(default=None),
) -> dict:
    _check_token(x_service_token)
    return toss_service.test_connection()


@app.get("/toss/exchange-rate")
def toss_exchange_rate(
    base: str = "USD",
    quote: str = "KRW",
    x_service_token: str | None = Header(default=None),
) -> dict:
    _check_token(x_service_token)
    return toss_service.get_exchange_rate(base, quote)


@app.get("/toss/indices")
def toss_indices(
    symbols: str = Query(..., description="쉼표로 구분"),
    x_service_token: str | None = Header(default=None),
) -> dict:
    _check_token(x_service_token)
    return toss_service.get_index_prices([s.strip() for s in symbols.split(",") if s.strip()])


@app.get("/toss/account")
def toss_account(
    x_service_token: str | None = Header(default=None),
) -> dict:
    """
    토스증권 실제 계좌 읽기 전용 조회(ADR 0025, 명세 docs/specs/2026-11-05-toss-account-readonly.md §3). 토큰 검사 뒤에는 늘 200.

    서비스 토큰 없이 뜬 수집기(COLLECTOR_ALLOW_NO_TOKEN)에서는 이 경로를 막을 문이 없으므로 토스를 부르지 않습니다.
    본문 전체를 감싸, 예상 못 한 예외는 클래스 이름만 로그에 남깁니다 — 예외 문구·스택에 계좌 값이 섞일 수 있어서입니다.
    """
    _check_token(x_service_token)
    try:
        if not API_TOKEN:
            return toss_account_service.empty_view(enabled=False, reason="no-service-token")
        return toss_account_service.get_account()
    except Exception as exc:  # noqa: BLE001
        logger.warning("토스 계좌 조회 중 예상 못 한 예외: %s", type(exc).__name__)
        return toss_account_service.empty_view(enabled=settings.toss_account_enabled(), reason="internal")


# ==============================================================================
# 실제 매매 — 수집기 쪽 주문 길(ADR 0028, 명세 docs/specs/2026-11-06-real-trade-mirror.md §5.2). 백엔드 전용
# ==============================================================================
# 토큰 검사 뒤에는 늘 200입니다. 서비스 토큰 없이 뜬 수집기(COLLECTOR_ALLOW_NO_TOKEN)에서는 막을 문이 없으므로 토스를 부르지 않고
# {"ok": false, "enabled": false, "reason": "no-service-token"}입니다. 본문 전체를 감싸 예상 못 한 예외는 클래스 이름만 남깁니다.
def _trading_read(call, *args) -> dict:
    if not API_TOKEN:
        return toss_trade_service.no_service_token_view()
    try:
        return call(*args)
    except Exception as exc:  # noqa: BLE001
        logger.warning("토스 매매 조회 중 예상 못 한 예외: %s", type(exc).__name__)
        return {"ok": False, "enabled": settings.toss_trading_disabled_reason() is None, "reason": "internal"}


def _trading_write(kind: str, call, *args) -> dict:
    if not API_TOKEN:
        return toss_trade_service.no_service_token_write(kind)
    try:
        return call(*args)
    except Exception as exc:  # noqa: BLE001 — 보냈는지 모르는 자리일 수 있어 UNKNOWN(모르면 멈춤)
        logger.warning("토스 매매 주문 중 예상 못 한 예외: %s", type(exc).__name__)
        return toss_trade_service.write_result(kind, toss_trade_service.UNKNOWN, "internal")


@app.get("/toss/trading/status")
def toss_trading_status(x_service_token: str | None = Header(default=None)) -> dict:
    """켜짐 여부·꺼진 사유·한도·토큰 경합·서버 시각. 토스를 부르지 않습니다."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.status)


@app.get("/toss/trading/calendar")
def toss_trading_calendar(x_service_token: str | None = Header(default=None)) -> dict:
    """그날 토스 장 운영 정보(통합 모드)와 시계 차이 — KST 날짜마다 한 번 받아 둡니다."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.calendar)


@app.post("/toss/trading/warmup")
def toss_trading_warmup(x_service_token: str | None = Header(default=None)) -> dict:
    """토큰 남은 시간이 30분 미만이면 미리 다시 받습니다(백엔드가 창마다 3분 전에 부름)."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.warmup)


@app.get("/toss/trading/preflight")
def toss_trading_preflight(
    symbols: str = Query("", max_length=2000),
    sell: str = Query("", max_length=2000),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """캐시 없이 새로 읽은 원화 매수 가능 금액·국내 보유·시세·매도 가능 수량. 하나라도 실패하면 ok:false."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.preflight, symbols, sell)


@app.get("/toss/trading/restrictions")
def toss_trading_restrictions(
    symbols: str = Query("", max_length=2000),
    x_service_token: str | None = Header(default=None),
) -> dict:
    """VI가 진행 중인 종목과 코스피·코스닥 등락률(읽기만). 읽지 못한 종목은 unknown."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.restrictions, symbols)


@app.post("/toss/trading/orders")
async def toss_trading_order(request: Request, x_service_token: str | None = Header(default=None)) -> dict:
    """
    주문 한 건 — 수집기 검사를 모두 통과해야 보냅니다. 결과 outcome은 ACCEPTED·REJECTED·UNKNOWN·NOT_SENT(명세 §4).

    본문을 직접 읽습니다 — JSON이 아니어도 422가 아니라 200 NOT_SENT(invalid-request)로 답해, 백엔드가 '보내지 않음'을 확실히 알게.
    """
    _check_token(x_service_token)
    raw = await request.body()
    try:
        payload = json.loads(raw) if raw else None
    except (ValueError, RecursionError):
        payload = None
    return await run_in_threadpool(_trading_write, "order", toss_trade_service.place_order, payload)


@app.post("/toss/trading/orders/{order_id}/cancel")
def toss_trading_cancel(order_id: str, x_service_token: str | None = Header(default=None)) -> dict:
    """주문 취소 — 주문 번호 형식이 틀리면 보내지 않습니다(NOT_SENT)."""
    _check_token(x_service_token)
    return _trading_write("cancel", toss_trade_service.cancel_order, order_id)


@app.get("/toss/trading/orders/open")
def toss_trading_open_orders(x_service_token: str | None = Header(default=None)) -> dict:
    """진행 중 국내 주문 전량(앱 주문 포함)."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.open_orders)


@app.get("/toss/trading/orders/today")
def toss_trading_today_orders(x_service_token: str | None = Header(default=None)) -> dict:
    """오늘(KST) 국내 주문 전부(진행 중 + 끝남)."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.today_orders)


@app.get("/toss/trading/orders/{order_id}")
def toss_trading_order_detail(order_id: str, x_service_token: str | None = Header(default=None)) -> dict:
    """주문 하나(어느 상태든). 위의 open·today보다 뒤에 두어야 그 두 경로가 이 경로에 먹히지 않습니다."""
    _check_token(x_service_token)
    return _trading_read(toss_trade_service.order_detail, order_id)
