"""
app/tasks/registry.py
태스크 목록 — 이름·속도군·함수·설명. 새 태스크는 여기에 한 줄.
"""
from __future__ import annotations

import logging
from .base import Task
from .earnings_surprise import task_earnings_surprise
from .econ_calendar import task_econ_calendar_tradingview
from .filings import task_sec_13f, task_sec_13f_track_record
from .info import (
    blog_task, task_info_krx_daily, task_info_naver_flows, task_info_waedge_blogs, task_info_waedge_brief, task_info_waedge_people,
)
from .fundamentals import task_sec_fundamentals
from .korea_public import task_dart_fundamentals, task_fsc_etf_prices, task_fsc_prices, task_kr_holidays
from .kr_calendar import task_kr_calendar
from .kr_news import task_kr_news_headlines
from ..services.info_blogs import BLOGS
from .kr_paper import task_kr_paper_flows, task_kr_paper_price_history, task_kr_paper_quotes, task_kr_paper_universe
from .kr_paper_timed import task_kr_paper_timed
from .maintenance import task_run_log_retention
from .markets import task_macro_collected, task_radar_rankings, task_scraper_markets
from .news import task_news_headlines
from .paper import task_paper_price_history, task_paper_quotes
from .paper_bars import task_paper_bars_us
from .paper_stopwatch import task_paper_stopwatch_kr, task_paper_stopwatch_us
from .paper_watch import task_paper_watch_us
from .paper_watch_kr import task_paper_watch_kr
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
    Task("scraper_markets", "fast", task_scraper_markets, "TradingView/Yahoo 참고 시세", yahoo=True),
    Task("macro_collected", "fast", task_macro_collected, "매크로 카드 전 지표", yahoo=True),
    Task("radar_rankings", "fast", task_radar_rankings, "국내 수급 랭킹 (이력 누적)"),
    Task("fred_series", "slow", task_fred_series, "FRED 금리/신용 시계열 (이력 누적)"),
    Task("fed_liquidity", "slow", task_fed_liquidity, "연준 순유동성 (이력 누적)"),
    Task("krx_futures", "slow", task_krx_futures, "KRX 선물/미결제약정 (이력 누적)"),
    Task("sector_history", "slow", task_sector_history, "섹터·자산군 ETF 종가", yahoo=True),
    Task("fx_history", "slow", task_fx_history, "환율·달러인덱스 일별 종가", yahoo=True),
    Task("equity_history", "slow", task_equity_history, "13F 매핑 종목 일별 종가", yahoo=True),
    Task("paper_quotes", "slow", task_paper_quotes, "모의 매매 유니버스 최근 3개월 일봉 (장부 관측치)", yahoo=True),
    # 관측치 바로 뒤 — 같은 Yahoo 래치를 나눠 써서, 1분봉이 429를 받아도 그 회차 장부 관측치는 이미 받은 뒤입니다(명세 2026-10-30 §12-2).
    Task("paper_bars_us", "slow", task_paper_bars_us, "Claude 계좌2 시각 지정 체결·실행 감사 — 대기·최근 주문 종목의 메뉴 창 1분봉 (Yahoo)", yahoo=True),
    # 속도군 session(5분) — 장중 확인(MINUTE) 날 확인 시각 −15~+30분에만 외부를 부르고, 그 밖의 회차는 호출 없이 EmptyResult(명세 2026-10-30 §12-1).
    Task("paper_watch_us", "session", task_paper_watch_us, "Claude 계좌2 장중 확인 — MINUTE 확인 날 감시 종목 1분봉 (확인 시각 −15~+30분에만, Yahoo)", yahoo=True),
    Task("paper_watch_kr", "session", task_paper_watch_kr, "한국 Claude 계좌2 장중 확인 — 확인 날 감시 종목 1분봉 (확인 시각 뒤 한 번, 토스)"),
    # 장중 스탑 감시(ADR 0032) — 설정 stopWatch.mode·kr.stopWatch.mode가 SHADOW·ON이고 정규장일 때만 외부를 부르고(미국은 slow 군이 Yahoo를 쓰는
    # 동안 쉼), 그 밖은 호출 0회. 미국·한국 세션이 겹치지 않아 한 회차에 실제로 부르는 쪽은 하나입니다.
    Task("paper_stopwatch_us", "session", task_paper_stopwatch_us, "장중 스탑 감시 — 미국 모의 계좌 보유 종목 1분봉 (정규장 5분마다, 설정이 켜졌을 때만, Yahoo spark)", yahoo=True),
    Task("paper_stopwatch_kr", "session", task_paper_stopwatch_kr, "한국 장중 스탑 감시 — 한국 모의 계좌 보유 종목 1분봉·전일 종가 (정규장 5분마다, 설정이 켜졌을 때만, 토스)"),
    Task("paper_live_us", "live", task_paper_live_us, "장중 평가 — 미국 보유 종목 최신 1분봉 (화면이 볼 때만, 표시 전용)", yahoo=True),
    Task("paper_live_kr", "live", task_paper_live_kr, "장중 평가 — 한국 보유 종목 최신 1분봉 (화면이 볼 때만, 표시 전용)"),
    Task("us_calendar", "slow", task_us_calendar, "미국 발표·실적 일정 — FRED 릴리스·FOMC 상수·yfinance 실적일 (모의 매매 Claude 계좌 패킷)", yahoo=True),
    Task("us_calendar_consensus", "slow", task_us_calendar_consensus, "미국 지표 컨센서스 — Nasdaq 경제 캘린더, 동부 하루 1회·저장만 (패킷은 calendar.consensus를 켠 뒤)"),
    Task("news_headlines", "slow", task_news_headlines, "사건 뉴스 RSS 헤드라인 — 인베스팅닷컴·연준·BLS·SEC, 7일 보관 (모의 매매 Claude 계좌 패킷)"),
    Task("kr_news_headlines", "slow", task_kr_news_headlines, "한국 사건 뉴스 RSS 헤드라인 — 한국은행·재정경제부·국가데이터처·연합뉴스 마켓+, 7일 보관 (한국 Claude 계좌 패킷)"),
    Task("volatility_history", "slow", task_volatility_history, "VIX·MOVE 변동성 시계열", yahoo=True),
    Task("cot_history", "slow", task_cot_history, "CFTC COT (주 1회 발표)"),
    Task("daum_futures_trend", "slow", task_daum_futures_trend, "Daum 선물 투자주체별 수급"),
    Task("fsc_prices", "slow", task_fsc_prices, "국내 공식 일별 시세 (금융위)"),
    # 주식시세 바로 뒤 — 같은 slow 바퀴에서 한국 확정가(주식 → ETF)가 토스 태스크보다 먼저 들어옵니다(v2 2단계 명세 §4-9).
    Task("fsc_etf_prices", "slow", task_fsc_etf_prices, "국내 ETF 공식 일별 시세 (금융위 증권상품시세)"),
    Task("toss_market_flows", "slow", task_toss_market_flows, "코스피·코스닥 투자자별 매매대금 (토스증권)"),
    Task("toss_stock_flows", "slow", task_toss_stock_flows, "레이더 종목 투자자별 매매동향 (토스증권)"),
    Task("toss_radar_universe", "slow", task_toss_radar_universe, "레이더 폴백 — 거래대금 상위 100종목 투자자 매매 (토스증권)"),
    # 한국 책(v2 2단계 B4) — 금융위·토스 태스크 뒤(명세 §4-9 순서). 유니버스는 외부 호출 0회(금융위 저장본으로 계산).
    Task("kr_paper_universe", "slow", task_kr_paper_universe, "한국 계좌 유니버스 — 금융위 최신 기준일 코스피 시총 상위 100 보통주 (외부 호출 없음)"),
    # 관측치 바로 앞 — 장부는 새 관측치(paper.kr.quotes)가 들어올 때만 처리하므로, 그 밤 처리 때 목표 세션 1분봉이 이미 있게(단계 2a).
    Task("kr_paper_timed", "slow", task_kr_paper_timed, "한국 Claude 계좌2 시각 지정 체결 — 매시·종가 대기 주문 종목의 목표 세션 1분봉 (토스, 세션 15:40 뒤)"),
    Task("kr_paper_quotes", "slow", task_kr_paper_quotes, "한국 계좌 관측치 — 수집 범위 토스 일봉 최근 5봉·1분봉 개장 봉 (KR 거래일 20:30 뒤 하루 1회)"),
    Task("kr_paper_flows", "slow", task_kr_paper_flows, "한국 계좌 종목별 수급 — 수집 범위 토스 투자자별 매매동향 (KR 거래일 20:30 뒤 하루 1회)"),
    Task("sec_13f", "weekly", task_sec_13f, "SEC 13F 기관 포트폴리오 (분기 공시)"),
    Task("sec_13f_track_record", "weekly", task_sec_13f_track_record, "13F 트랙레코드 후보 27곳 30분기 (모의 매매)"),
    Task("sec_fundamentals", "weekly", task_sec_fundamentals, "미국 종목 재무 SEC XBRL (모의 매매 Claude 계좌 패킷, 실행당 200 CIK)"),
    Task("earnings_surprise", "weekly", task_earnings_surprise, "어닝 서프라이즈 — yfinance 최근 4분기 EPS 실제치·컨센서스, 지우지 않고 누적 (모의 매매 Claude 계좌 패킷, 실행당 100종목)", yahoo=True),
    Task("kr_holidays", "weekly", task_kr_holidays, "한국 공휴일 (천문연 특일정보)"),
    Task("kr_calendar", "weekly", task_kr_calendar, "한국 거시 일정 — 금통위 상수·주요 발표 상수, 외부 호출 없음 (한국 Claude 계좌 패킷)"),
    Task("dart_fundamentals", "weekly", task_dart_fundamentals, "국내 종목 재무 (DART 사업보고서)"),
    Task("paper_price_history", "weekly", task_paper_price_history, "모의 매매 유니버스 10년 일별 종가 (이력 누적)", yahoo=True),
    Task("kr_paper_price_history", "weekly", task_kr_paper_price_history, "한국 계좌 종가 이력 — 수집 범위 토스 수정주가 1년 메우기·기준 바뀜 다시 받기"),
    Task("run_log_retention", "weekly", task_run_log_retention, "수집 실행 기록 정리 (보존 기간이 지난 것만)"),
    # 속도군 polite(비주기) — 차단 통과 수집 계층(ADR 0026). 주기로 돌지 않고 때가 된 태스크만 실행하며, 기동 직후에는 받지 않습니다.
    Task("econ_calendar_tradingview", "polite", task_econ_calendar_tradingview, "경제 캘린더 — TradingView 미국·한국 지표 일정·예상치·중요도 (3~6시간에 한 번, 운영자 화면 전용)"),
    # 정보 수집(ADR 0035) — 운영자 화면 '정보 수집'만 읽음(패킷 불변). 운영 서버(POLITE_FETCH_ENABLED)에서만 돕니다.
    *(Task(blog.task, "polite", blog_task(blog),
           f"정보 수집 — {blog.label} RSS·본문 ({blog.minutes[0] // 60}~{blog.minutes[1] // 60}시간에 한 번, 운영자 화면 전용)")
      for blog in BLOGS),
    Task("info_waedge_brief", "polite", task_info_waedge_brief, "정보 수집 — waedge 시장 글·본문 (1~3시간에 한 번, 운영자 화면 전용)"),
    Task("info_waedge_people", "polite", task_info_waedge_people, "정보 수집 — waedge 거장 견해·글 (8~16시간에 한 번, 운영자 화면 전용)"),
    Task("info_waedge_blogs", "polite", task_info_waedge_blogs, "정보 수집 — waedge 해외 블로그 한국어 제목 (4~8시간에 한 번, 운영자 화면 전용)"),
    Task("info_naver_flows", "polite", task_info_naver_flows, "정보 수집 — 네이버 투자자별 매매동향·외국인·기관 매매상위 (정규장 40~90분·장 밖 3~6시간, 운영자 화면 전용)"),
    Task("info_krx_daily", "polite", task_info_krx_daily, "정보 수집 — KRX 정보데이터시스템(로그인) 투자자별 순매수 상위·시장 합계·외국인 보유·공매도 (거래일 18:30 뒤 하루 한 번, 레이더·정보 수집 화면)"),
)

TASKS_BY_NAME = {task.name: task for task in ALL_TASKS}


