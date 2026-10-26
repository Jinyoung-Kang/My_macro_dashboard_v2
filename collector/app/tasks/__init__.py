"""
app/tasks/ — 수집 작업 정의(패키지).

예전 tasks.py(1,300줄)를 기능별 모듈로 나눴습니다. 바깥에서는 지금처럼 `app.tasks.X`로 씁니다 — 이 파일이
모듈들의 이름을 다시 내보냅니다. 테스트가 모듈 전역(store·상수)을 바꿔 끼울 때는 그 이름이 실제로 쓰이는
모듈(`app.tasks.toss` 등)을 대상으로 해야 합니다.

  base · markets(fast) · series · filings · fundamentals · korea_public · toss · kr_paper · maintenance · registry · runner

[작업군과 주기 — 구버전과 동일]
  fast   (5분)  : scraper_markets · macro_collected · radar_rankings
  slow   (1시간): fred_series · fed_liquidity · krx_futures · sector_history · fx_history ·
                  volatility_history · cot_history · daum_futures_trend · fsc_prices · fsc_etf_prices
  weekly (12시간): sec_13f · kr_holidays · dart_fundamentals

[규칙]
- 수집이 예외 없이 끝났지만 쓸 데이터가 없으면 EmptyResult로 **실패 집계**
  합니다. 이것을 성공으로 보고하면 "✅ 0/10 수집" 같은 모순된 로그가 남고
  운영자가 장애를 알아채지 못합니다.
- 빈 결과로 **기존 저장본을 덮어쓰지 않습니다.** 네트워크 일시 장애로 어제
  받아 둔 데이터를 날리면 안 됩니다.
- 추정치(isEstimated=true)는 **누적 테이블에 넣지 않습니다.** 한 번 섞이면
  실제 확정치와 구분할 수 없습니다.
"""
from __future__ import annotations

from .. import catalog, equities, http, indicators, krcalendar, macro_cards, publicapi, settings, store  # noqa: F401 — 테스트·main이 tasks.store 등으로 씁니다
from ..services import (  # noqa: F401 — 테스트가 tasks.sector_service 등을 바꿔 끼웁니다
    cot as cot_service,
    dart as dart_service,
    fred as fred_service,
    fsc as fsc_service,
    kasi as kasi_service,
    krx as krx_service,
    liquidity as liquidity_service,
    market as market_service,
    radar as radar_service,
    scraper as scraper_service,
    sec13f as sec_service,
    sector as sector_service,
    toss as toss_service,
)

from .base import (  # noqa: F401
    KST,
    RADAR_COMBINATIONS,
    DAUM_TREND_LOOKBACK,
    EmptyResult,
    _reason_suffix,
    Task,
)
from .markets import (  # noqa: F401
    STALE_NOTE,
    _USABLE_STATUSES,
    _carry_over_failed_items,
    _previous_payload,
    task_scraper_markets,
    task_macro_collected,
    task_radar_rankings,
)
from .series import (  # noqa: F401
    task_fred_series,
    TIMESERIES_OVERLAP_DAYS,
    _recent_points,
    FRED_SHRINK_MIN_STORED,
    FRED_SHRINK_RATIO,
    _fred_stored_point_count,
    _is_shrunken,
    task_fed_liquidity,
    task_krx_futures,
    task_sector_history,
    task_fx_history,
    task_equity_history,
    task_volatility_history,
    task_cot_history,
    task_daum_futures_trend,
)
from .filings import (  # noqa: F401
    task_sec_13f,
)
from .korea_public import (  # noqa: F401
    task_kr_holidays,
    FSC_CALL_BUDGET,
    FSC_LOOKBACK_DAYS,
    FSC_RETENTION_DAYS,
    FSC_BACKFILL_CALL_BUDGET,
    FSC_BACKFILL_TIME_LIMIT_SECONDS,
    _fsc_candidate_dates,
    _fsc_backfill_dates,
    task_fsc_prices,
    FSC_ETF_CALL_BUDGET,
    FSC_ETF_TIME_LIMIT_SECONDS,
    FSC_ETF_NOT_REGISTERED,
    task_fsc_etf_prices,
    DART_UNIVERSE_LIMIT,
    DART_UNIVERSE_DAYS,
    DART_CALL_BUDGET,
    _CORP_CODES_MAX_AGE,
    _dart_universe,
    _dart_corp_codes,
    _latest_annual_year,
    task_dart_fundamentals,
)
from .toss import (  # noqa: F401
    TOSS_MARKET_DAYS,
    TOSS_STOCK_DAYS,
    TOSS_STOCK_LIMIT,
    TOSS_WATCHED_LIMIT,
    TOSS_STOCK_SPACING,
    TOSS_STOCK_RETENTION_DAYS,
    _KR_CODE,
    task_toss_market_flows,
    _toss_universe,
    task_toss_stock_flows,
    TOSS_RADAR_UNIVERSE,
    task_toss_radar_universe,
)
from .kr_paper import (  # noqa: F401
    KR_UNIVERSE_SIZE,
    KR_UNIVERSE_RULE,
    KR_SCOPE_ETFS,
    task_kr_paper_universe,
    kr_scope,
    KR_COLLECT_AFTER,
    KR_QUOTES_BARS,
    KR_QUOTES_CALL_BUDGET,
    KR_QUOTES_TIME_LIMIT_SECONDS,
    kr_target_session,
    task_kr_paper_quotes,
)
from .maintenance import (  # noqa: F401
    task_run_log_retention,
)
from .us_calendar import (  # noqa: F401
    task_us_calendar,
)
from .news import (  # noqa: F401
    task_news_headlines,
)
from .earnings_surprise import (  # noqa: F401
    task_earnings_surprise,
)
from .registry import (  # noqa: F401
    ALL_TASKS,
    TASKS_BY_NAME,
)
from .runner import (  # noqa: F401
    _COALESCE_WAIT_SECONDS,
    _inflight,
    _inflight_lock,
    _InFlight,
    run_task,
    _wait_for_inflight,
    EMPTY_PREFIX,
    REJECTED_PREFIX,
    _run_status,
    TASK_DEADLINE_SECONDS,
    _task_threads,
    deadline_for,
    _execute_task,
    _log_late_finish,
    run_group,
)
from . import base, earnings_surprise, filings, fundamentals, korea_public, kr_paper, maintenance, markets, news, registry, runner, series, toss, us_calendar  # noqa: F401,E402
