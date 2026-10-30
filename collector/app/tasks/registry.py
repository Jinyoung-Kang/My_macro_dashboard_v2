"""
app/tasks/registry.py
태스크 목록 — 이름·속도군·함수·설명. 새 태스크는 여기에 한 줄.
"""
from __future__ import annotations

import logging
from .base import Task
from .earnings_surprise import task_earnings_surprise
from .filings import task_sec_13f, task_sec_13f_track_record
from .fundamentals import task_sec_fundamentals
from .korea_public import task_dart_fundamentals, task_fsc_etf_prices, task_fsc_prices, task_kr_holidays
from .kr_calendar import task_kr_calendar
from .kr_news import task_kr_news_headlines
from .kr_paper import task_kr_paper_flows, task_kr_paper_price_history, task_kr_paper_quotes, task_kr_paper_universe
from .maintenance import task_run_log_retention
from .markets import task_macro_collected, task_radar_rankings, task_scraper_markets
from .news import task_news_headlines
from .paper import task_paper_price_history, task_paper_quotes
from .paper_bars import task_paper_bars_us
from .paper_watch import task_paper_watch_us
from .paper_live import task_paper_live_kr, task_paper_live_us
from .series import (
    task_cot_history, task_daum_futures_trend, task_equity_history, task_fed_liquidity,
    task_fred_series, task_fx_history, task_krx_futures, task_sector_history, task_volatility_history,
)
from .toss import task_toss_market_flows, task_toss_radar_universe, task_toss_stock_flows
from .us_calendar import task_us_calendar
from .us_consensus import task_us_calendar_consensus

logger = logging.getLogger(__name__)


# ==============================================================================
# 태스크 목록 및 실행
# ==============================================================================
ALL_TASKS: tuple[Task, ...] = (
    Task("scraper_markets", "fast", task_scraper_markets, "TradingView/Yahoo 참고 시세"),
    Task("macro_collected", "fast", task_macro_collected, "매크로 카드 전 지표"),
    Task("radar_rankings", "fast", task_radar_rankings, "국내 수급 랭킹 (이력 누적)"),
    Task("fred_series", "slow", task_fred_series, "FRED 금리/신용 시계열 (이력 누적)"),
    Task("fed_liquidity", "slow", task_fed_liquidity, "연준 순유동성 (이력 누적)"),
    Task("krx_futures", "slow", task_krx_futures, "KRX 선물/미결제약정 (이력 누적)"),
    Task("sector_history", "slow", task_sector_history, "섹터·자산군 ETF 종가"),
    Task("fx_history", "slow", task_fx_history, "환율·달러인덱스 일별 종가"),
    Task("equity_history", "slow", task_equity_history, "13F 매핑 종목 일별 종가"),
    Task("paper_quotes", "slow", task_paper_quotes, "모의 매매 유니버스 최근 3개월 일봉 (장부 관측치)"),
    # 관측치 바로 뒤 — 같은 Yahoo 래치를 나눠 써서, 1분봉이 429를 받아도 그 회차 장부 관측치는 이미 받은 뒤입니다(명세 2026-10-30 §12-2).
    Task("paper_bars_us", "slow", task_paper_bars_us, "🧪 Claude 계좌2 단계 0 측정 — 대기·최근 주문 종목의 메뉴 창 1분봉 (Yahoo, 체결에는 아직 쓰지 않음)"),
    # 속도군 session(5분) — 장중 확인(MINUTE) 날 확인 시각 −15~+30분에만 외부를 부르고, 그 밖의 회차는 호출 없이 EmptyResult(명세 2026-10-30 §12-1).
    Task("paper_watch_us", "session", task_paper_watch_us, "🧪 Claude 계좌2 장중 확인 — MINUTE 확인 날 감시 종목 1분봉 (확인 시각 −15~+30분에만, Yahoo)"),
    Task("paper_live_us", "live", task_paper_live_us, "🧪 장중 평가 — 미국 보유 종목 최신 1분봉 (화면이 볼 때만, 표시 전용)"),
    Task("paper_live_kr", "live", task_paper_live_kr, "🧪 장중 평가 — 한국 보유 종목 최신 1분봉 (화면이 볼 때만, 표시 전용)"),
    Task("us_calendar", "slow", task_us_calendar, "미국 발표·실적 일정 — FRED 릴리스·FOMC 상수·yfinance 실적일 (모의 매매 Claude 계좌 패킷)"),
    Task("us_calendar_consensus", "slow", task_us_calendar_consensus, "🧪 미국 지표 컨센서스 — Nasdaq 경제 캘린더, 동부 하루 1회·저장만 (패킷은 calendar.consensus를 켠 뒤)"),
    Task("news_headlines", "slow", task_news_headlines, "사건 뉴스 RSS 헤드라인 — 인베스팅닷컴·연준·BLS·SEC, 7일 보관 (모의 매매 Claude 계좌 패킷)"),
    Task("kr_news_headlines", "slow", task_kr_news_headlines, "🧪 한국 사건 뉴스 RSS 헤드라인 — 한국은행·재정경제부·국가데이터처·연합뉴스 마켓+, 7일 보관 (한국 책 Claude 계좌 패킷)"),
    Task("volatility_history", "slow", task_volatility_history, "VIX·MOVE 변동성 시계열"),
    Task("cot_history", "slow", task_cot_history, "CFTC COT (주 1회 발표)"),
    Task("daum_futures_trend", "slow", task_daum_futures_trend, "Daum 선물 투자주체별 수급"),
    Task("fsc_prices", "slow", task_fsc_prices, "국내 공식 일별 시세 (금융위)"),
    # 주식시세 바로 뒤 — 같은 slow 바퀴에서 한국 확정가(주식 → ETF)가 토스 태스크보다 먼저 들어옵니다(v2 2단계 명세 §4-9).
    Task("fsc_etf_prices", "slow", task_fsc_etf_prices, "국내 ETF 공식 일별 시세 (금융위 증권상품시세)"),
    Task("toss_market_flows", "slow", task_toss_market_flows, "코스피·코스닥 투자자별 매매대금 (토스증권)"),
    Task("toss_stock_flows", "slow", task_toss_stock_flows, "레이더 종목 투자자별 매매동향 (토스증권)"),
    Task("toss_radar_universe", "slow", task_toss_radar_universe, "레이더 폴백 — 거래대금 상위 100종목 투자자 매매 (토스증권)"),
    # 🧪 한국 책(v2 2단계 B4) — 금융위·토스 태스크 뒤(명세 §4-9 순서). 유니버스는 외부 호출 0회(금융위 저장본으로 계산).
    Task("kr_paper_universe", "slow", task_kr_paper_universe, "🧪 한국 책 유니버스 — 금융위 최신 기준일 코스피 시총 상위 100 보통주 (외부 호출 없음)"),
    Task("kr_paper_quotes", "slow", task_kr_paper_quotes, "🧪 한국 책 관측치 — 수집 범위 토스 일봉 최근 5봉·1분봉 개장 봉 (KR 거래일 20:30 뒤 하루 1회)"),
    Task("kr_paper_flows", "slow", task_kr_paper_flows, "🧪 한국 책 종목별 수급 — 수집 범위 토스 투자자별 매매동향 (KR 거래일 20:30 뒤 하루 1회)"),
    Task("sec_13f", "weekly", task_sec_13f, "SEC 13F 기관 포트폴리오 (분기 공시)"),
    Task("sec_13f_track_record", "weekly", task_sec_13f_track_record, "13F 트랙레코드 후보 27곳 30분기 (모의 매매)"),
    Task("sec_fundamentals", "weekly", task_sec_fundamentals, "미국 종목 재무 SEC XBRL (모의 매매 Claude 계좌 패킷, 실행당 200 CIK)"),
    Task("earnings_surprise", "weekly", task_earnings_surprise, "어닝 서프라이즈 — yfinance 최근 4분기 EPS 실제치·컨센서스, 지우지 않고 누적 (모의 매매 Claude 계좌 패킷, 실행당 100종목)"),
    Task("kr_holidays", "weekly", task_kr_holidays, "한국 공휴일 (천문연 특일정보)"),
    Task("kr_calendar", "weekly", task_kr_calendar, "🧪 한국 거시 일정 — 금통위 상수·주요 발표 상수, 외부 호출 없음 (한국 책 Claude 계좌 패킷)"),
    Task("dart_fundamentals", "weekly", task_dart_fundamentals, "국내 종목 재무 (DART 사업보고서)"),
    Task("paper_price_history", "weekly", task_paper_price_history, "모의 매매 유니버스 10년 일별 종가 (이력 누적)"),
    Task("kr_paper_price_history", "weekly", task_kr_paper_price_history, "🧪 한국 책 종가 이력 — 수집 범위 토스 수정주가 1년 메우기·기준 바뀜 다시 받기"),
    Task("run_log_retention", "weekly", task_run_log_retention, "수집 실행 기록 정리 (보존 기간이 지난 것만)"),
)

TASKS_BY_NAME = {task.name: task for task in ALL_TASKS}


