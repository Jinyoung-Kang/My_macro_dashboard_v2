"""
app/catalog.py
데이터셋 이름과 신선도 기준의 단일 출처.

수집기(Python)와 백엔드(Java)가 **같은 문자열**을 써야 하므로 한쪽에서
오타가 나면 "수집은 되는데 화면에 안 보이는" 버그가 생깁니다. 구버전
services/datasets.py가 같은 이유로 존재했고, 이 파일이 그 역할을 잇습니다.

Java 쪽 대응 파일: backend/src/main/java/com/macrodash/store/Datasets.java
두 파일은 같은 문자열을 정의하며, 백엔드 테스트가 대조 검증합니다.
"""
from __future__ import annotations

# ==============================================================================
# 스냅샷 (최신 상태 1건)
# ==============================================================================
SNAP_MACRO_COLLECTED = "macro.collected"        # 매크로 카드 + 2Y/10Y 금리
SNAP_SCRAPER_MARKETS = "macro.scraper_markets"  # TradingView/Yahoo 참고 시세
SNAP_FED_LIQUIDITY = "liquidity.fed_net"        # 연준 순유동성
SNAP_KRX_FUTURES = "krx.futures_history"        # KOSPI200 선물 시계열
SNAP_SECTOR_HISTORY = "sector.etf_history"      # 섹터/자산군 ETF 종가
SNAP_FX_HISTORY = "macro.fx_history"            # 환율·달러인덱스 일별 종가 (겹쳐 보기)
SNAP_EQUITY_HISTORY = "equity.price_history"    # 13F 매핑 종목 일별 종가 + 이름→티커 매핑표
SNAP_COT_HISTORY = "cot.multi_asset"            # CFTC COT 통합
SNAP_KR_HOLIDAYS = "calendar.kr_holidays"       # 한국 공휴일 (천문연 특일정보) — 거래소 휴장 판정
SNAP_DART_CORP_CODES = "kr.dart_corp_codes"     # DART 고유번호 ↔ 종목코드 (상장사만)
SNAP_DART_FUNDAMENTALS = "kr.dart_fundamentals" # DART 사업보고서 주요계정 (수급 레이더 종목)
SNAP_FSC_PRICES_META = "kr.fsc_prices_meta"     # 금융위 시세 최신 기준일·시장 합계 (종목별 값은 observations)
SNAP_TOSS_MARKET_FLOWS = "kr.toss_market_flows" # 코스피·코스닥 투자자별 매매대금 (토스증권 공식, 일별)
SNAP_TOSS_RADAR_UNIVERSE = "kr.toss_radar_universe"  # 거래대금 상위 100종목의 투자자 매매 (레이더 폴백용)
SNAP_PAPER_QUOTES = "paper.quotes"      # 모의 매매 유니버스 최근 3개월 일봉(장중 마지막 봉 = 지연 시세) — 장부 관측치
SNAP_TRACK_RECORD_INDEX = "sec.13f.track_record_index"  # 모의 매매 트랙레코드 후보 기관 목록·기관별 수집 진행률(q30)
SNAP_US_FUNDAMENTALS_STATUS = "us.fundamentals.status"  # 모의 매매 미국 재무(SEC XBRL) 회사별 수집 상태 — 사실은 observations us.fundamentals
# 모의 매매 Claude 계좌 패킷 1b_calendar의 원자료(2단계 A) — 거시 발표일(FRED 릴리스·FOMC 상수, 앞으로 45일)과 유니버스 종목
# (ETF 제외)의 다음 실적 발표일(yfinance). 기준일 창·보유·후보 고르기는 백엔드가 합니다.
SNAP_US_CALENDAR = "calendar.us_events"
# 모의 매매 Claude 계좌 패킷 11b_events(2단계 B)의 수집 상태 — 피드별 성공·실패와 사유, 7일 보관 건수, 마지막 수집 시각.
# 헤드라인 자체는 observations news_headline에 있습니다.
SNAP_NEWS_STATUS = "news.headlines.status"
# 모의 매매 Claude 계좌 패킷 8b_fundamentals의 EPS 서프라이즈(2단계 C)의 수집 상태 — 종목별 받은 시각·저장 행 수·최신 발표일·오류와
# 실행 집계(universe·covered·withEstimate4·fetchedThisRun·failedThisRun). 분기 값 자체는 observations us.earnings_surprise에 있습니다.
SNAP_EARNINGS_SURPRISE_STATUS = "us.earnings_surprise.status"

# 변동성 지수(^VIX / ^MOVE)는 가장 긴 기간으로 한 번 저장하고, 짧은 기간
# 요청은 잘라 씁니다 (13F에서 q1을 q8에서 유도하는 것과 같은 방식).
VOLATILITY_STORE_PERIOD = "5y"

# 모의 매매(운영자 전용 기능)의 가격 기간. 관측치(paper.quotes)는 장부가 마지막 봉을 체결·평가에 쓰고, 앞부분은 10년 이력
# (12시간 주기)에 아직 들어오지 않은 최근 종가를 메웁니다 — 1시간마다 받으므로 짧게 둡니다. 10년 이력은 트랙레코드 7년 창 + 여유.
# 기존 equity.price_history(5년·138종목)를 10년·유니버스 전체로 키우지 않은 이유는 docs/specs/2026-10-24-paper-trading-spec.md D23
# (한 저장본이 16MB 기준·백엔드 힙을 넘음).
PAPER_QUOTES_PERIOD = "3mo"
PAPER_HISTORY_PERIOD = "10y"


def snap_daum_futures_trend(lookback_days: int) -> str:
    """
    Daum 선물 투자주체별 매매동향.

    접미사 .CONTRACT는 "계약수 기준"임을 명시합니다. 금액(억원) 모드는
    Daum이 제공하지 않아 제거됐지만(응답이 계약수 그대로였고 1억으로 나눠
    화면이 전부 0이 됐습니다), 예전 키의 저장본과 섞이지 않도록 남깁니다.
    """
    return f"krx.daum_futures_trend.d{lookback_days}.CONTRACT"


def snap_ticker_history(symbol: str, period: str) -> str:
    safe = symbol.replace("^", "").replace("=", "_").replace(".", "_")
    return f"ticker.{safe}.{period}"


def snap_cot_contract(contract_code: str, limit: int) -> str:
    return f"cot.contract.{contract_code}.l{limit}"


def snap_sec_13f(cik: str, max_quarters: int) -> str:
    return f"sec.13f.{cik}.q{max_quarters}"


def snap_fred_series(series_id: str) -> str:
    return f"fred.series.{series_id}"


def snap_radar_scanner(
    market: str,
    investor: str,
    trade_type: str,
    interval_type: str,
) -> str:
    return f"radar.scanner.{market}.{investor}.{trade_type}.{interval_type}"


# ==============================================================================
# 누적 이력 (timeseries / observations)
# ==============================================================================
TS_FRED = "fred"                # series_id = FRED 시리즈 ID
TS_KRX_FUTURES = "krx_futures"  # series_id = 종가/거래량/미결제약정
TS_LIQUIDITY = "fed_liquidity"  # series_id = WALCL/WTREGEN/RRP_M/Net_Liquidity_M

OBS_RADAR = "radar_ranking"     # 날짜별 수급 상위 종목 (과거 조회 불가 소스)
# 기능을 없애 더 쓰지 않는 누적 데이터셋. 수집기가 기동할 때 지웁니다.
#   molit_apt — 서울 아파트 실거래 (2026-09 제거)
RETIRED_OBSERVATION_DATASETS = ("molit_apt",)
OBS_FSC_PRICE = "fsc_price"     # 금융위 공식 일별 시세 (entity = 6자리 종목코드)
# 금융위 ETF 일별 시세(증권상품시세 getETFPriceInfo_V2, v2 2단계 B3·K15). entity = 6자리 코드(영문 섞임 포함), obs_date = 기준일,
# payload {code, name, close, open, high, low, volume, tradingValue, marketCap, nav, netAssets, listedUnits, indexName, indexClose, basDt}.
# 주식시세(fsc_price)에는 ETF가 없습니다. 모의 매매 한국 책의 ETF 확정가(069500·153130 — 체결 확정 조정·순자산 확정)가 읽습니다. 400일 보존.
OBS_FSC_ETF_PRICE = "fsc_etf_price"
TS_FSC_MARKET = "fsc_market"    # 시장별 합계 시가총액·거래대금 (series = "KOSPI.marketCap" 등)
OBS_TOSS_STOCK_FLOW = "toss_stock_flow"  # 종목별 일별 투자자 매매동향 (토스증권 공식, entity = 종목코드)
TS_EQUITY_CLOSE = "equity_close"        # 모의 매매 유니버스 10년 일별 종가(수정주가), series_id = 야후 티커
# 모의 매매 미국 종목 재무(SEC XBRL Company Facts, 명세 D28). entity = 티커, obs_date = 공시일(filed) —
# payload {"cik": [...], "facts": [...]}는 그날 처음 낸(또는 값이 바뀐) 사실 묶음. 백엔드는 obs_date ≤ 기준일만 읽습니다.
OBS_US_FUNDAMENTALS = "us.fundamentals"
# 모의 매매 사건 뉴스 헤드라인(RSS 제목·링크·출처·시각만, 2단계 B·D29). entity = 정규화한 제목(공백 하나로·앞뒤 공백 제거·casefold)의
# sha256 앞 16자, obs_date = 발행 시각의 UTC 날짜, payload {title, link, source, feed, publishedAt, fetchedAt}.
# 같은 제목은 7일 안에 다시 넣지 않고(날짜가 달라도), 7일이 지난 행은 태스크가 지웁니다. 거르기·패킷 창은 백엔드가 합니다.
OBS_NEWS_HEADLINE = "news_headline"
# 모의 매매 어닝 서프라이즈(yfinance quoteSummary earnings.earningsChart, 2단계 C·D36). entity = 티커, obs_date = 실제 발표 시각
# (reportedDate)의 미국 동부 날짜 — 백엔드가 obs_date ≤ 기준일로 시점(PIT)을 자릅니다. payload {periodEnd, actual, estimate,
# surprisePct, currency, smallBase, reportedAt, source}. (날짜, 티커)마다 upsert(나중에 받은 값이 추정치를 채우거나 고침), 지우지 않음.
OBS_US_EARNINGS_SURPRISE = "us.earnings_surprise"

# 기간으로 지워도 되는 누적 데이터셋은 태스크가 스스로 보존 기한을 두는 fsc_price·fsc_etf_price·toss_stock_flow(각 400일)·news_headline(7일)뿐입니다(QA-070).
# radar_ranking(다시 받을 수 없음, ADR 0005)·fred·fed_liquidity(증분 적재, 판정 성과가 전 구간을 씀, ADR 0009)·
# krx_futures(원천이 최근 40일만 줌)·fsc_market(보충은 최근 7일만 함)·equity_close(모의 매매 트랙레코드가 10년 창을 통째로 쓰고,
# 상장폐지되면 야후가 그 종목의 과거 종가를 더 주지 않음)·us.fundamentals(사실은 공시로 쌓이기만 하고, 그 시점 값을 고르려면
# 옛 공시일 행이 있어야 함)·us.earnings_surprise(출처가 최근 4분기만 줘 지우면 다시 받을 수 없음)는 기간이 지나도 지우지 않습니다.


# ==============================================================================
# 신선도 기준 (초)
# ==============================================================================
MAX_AGE_REALTIME = 15 * 60      # 장중 시세성 (수집 주기 5분의 3배)
MAX_AGE_DAILY = 6 * 60 * 60     # 일별 확정치 (FRED/KRX 마감)
MAX_AGE_SLOW = 24 * 60 * 60     # 분기 공시(13F) 등 거의 변하지 않는 데이터

# 13F 수집기가 저장하는 최대 분기 수. q1은 q8의 앞부분을 잘라 만듭니다.
MAX_TRACKED_QUARTERS = 8

# 모의 매매 트랙레코드 후보 기관(indicators.TRACK_RECORD_FILERS)의 13F 분기 수 — 저장 이름은 snap_sec_13f(cik, 30).
# 7년 창(28분기) + 공시 지연 여유: 재선정일에는 최신 분기 공시가 아직 없을 수 있고(마감 45일), 창의 첫 구간은 창 시작 전에
# 낸 공시로 시작합니다. 기존 13F 화면(q8)과 따로 받습니다.
TRACK_RECORD_QUARTERS = 30
