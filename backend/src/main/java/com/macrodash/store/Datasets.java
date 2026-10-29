package com.macrodash.store;

import java.util.List;

/**
 * 데이터셋 이름과 신선도 기준의 단일 출처 (Java 쪽).
 *
 * <p><b>중요</b> — 이 파일은 수집기의 {@code collector/app/catalog.py}와 <b>같은 문자열</b>을
 * 정의해야 합니다. 한쪽이 오타를 내면 "수집은 되는데 화면에는 안 보이는" 버그가
 * 생기고, 그 증상만으로는 원인을 찾기 어렵습니다. 두 파일이 어긋나지 않는지는
 * {@code DatasetsParityTest}가 실제 catalog.py를 읽어 대조합니다.
 */
public final class Datasets {

    private Datasets() {
    }

    // ---------------------------------------------------------------- 스냅샷
    public static final String SNAP_MACRO_COLLECTED = "macro.collected";
    public static final String SNAP_SCRAPER_MARKETS = "macro.scraper_markets";
    public static final String SNAP_FED_LIQUIDITY = "liquidity.fed_net";
    public static final String SNAP_KRX_FUTURES = "krx.futures_history";
    public static final String SNAP_SECTOR_HISTORY = "sector.etf_history";
    public static final String SNAP_FX_HISTORY = "macro.fx_history";
    public static final String SNAP_EQUITY_HISTORY = "equity.price_history";
    public static final String SNAP_COT_HISTORY = "cot.multi_asset";
    /** 한국 공휴일 (천문연 특일정보). 거래소 휴장 판정에 씁니다. */
    public static final String SNAP_KR_HOLIDAYS = "calendar.kr_holidays";
    /**
     * DART 사업보고서 주요계정 — 한국 책 수집 범위(먼저, v2 2단계 B8)와 수급 레이더 종목. 수집기 {@code dart_fundamentals}(weekly)만 씁니다(ADR 0008).
     * payload {@code {source, companies: {code: {name, corpCode, bsnsYear, fsDiv, rceptNo, currency, accounts}}, universe, krScope, unmapped}} —
     * 회사마다 마지막으로 받은 보고서 하나만 있고(저장본보다 이른 사업연도로는 덮지 않음), 이번에 받지 못한 회사는 이전 값이 남습니다.
     *
     * <p><b>시점 규칙</b>(한국 책 — 규칙 계좌 재무 필터 D1·Claude 패킷 {@code 8b_fundamentals} E1, 명세 §4-5): 접수번호 {@code rceptNo}(14자리)의
     * 앞 8자리 {@code yyyyMMdd}가 접수일이고, <b>접수일 ≤ 기준일</b>인 회사만 씁니다. 기준일은 그 결정의 기준 KR 세션 D
     * (결정 행에 동결하는 다른 입력과 같은 날 — 재선정 따라잡기는 {@code selectionAsOf})입니다.
     * <ul>
     *   <li>접수일이 기준일 뒤면 '자료 없음'(사유 '접수일이 기준일 뒤') — 저장본에 이전 보고서가 없으므로 다른 판으로 대신하지 않습니다.</li>
     *   <li>{@code rceptNo}가 14자리 숫자가 아니면 '자료 없음'(사유 '접수일 모름') — 시점을 확인하지 못한 재무를 쓰지 않습니다.</li>
     *   <li>밤 결정은 그때 이미 받은 보고서만 보므로 보통 걸리지 않습니다 — 다시 계산·시험에서 기준일 뒤 보고서를 쓰지 않게 막는 자리입니다.
     *       [확인] 2026-10-26 로컬 저장본 96사 모두 14자리이고 13사는 접수일이 4월 뒤(KB금융 2025 사업보고서 2026-06-19 등 — 정정 보고서의
     *       접수번호로 보임 [추정]).</li>
     * </ul>
     * 화면 레이더 재무({@code feature.publicdata.KrFundamentalsService})는 이 규칙 없이 최신 판을 보입니다.
     */
    public static final String SNAP_DART_FUNDAMENTALS = "kr.dart_fundamentals";
    /** 금융위 시세 최신 기준일·시장 합계. 종목별 값은 {@link #OBS_FSC_PRICE}. */
    public static final String SNAP_FSC_PRICES_META = "kr.fsc_prices_meta";
    /** 코스피·코스닥 투자자별 매매대금 (토스증권 공식, 일별). */
    public static final String SNAP_TOSS_MARKET_FLOWS = "kr.toss_market_flows";
    /** 거래대금 상위 100종목의 투자자 매매 (토스증권 공식) — 레이더 폴백용. */
    public static final String SNAP_TOSS_RADAR_UNIVERSE = "kr.toss_radar_universe";
    /**
     * 모의 매매 유니버스의 최근 3개월 일봉 — 장부 관측치의 유일한 출처입니다. 장중에는 마지막 봉이 지연 시세라,
     * 확정 종가인지는 봉 날짜와 수집 시각(마감 + 15분)으로 가립니다.
     */
    public static final String SNAP_PAPER_QUOTES = "paper.quotes";
    /**
     * 🧪 한국 책 장부 관측치(v2 2단계 B4) — 수집 범위의 토스 일봉 최근 5봉(adjusted=false 원시 시고저종·거래량·출처 {@code TOSS_DAILY}/
     * {@code TOSS_INTEGRATED}, 같은 날 수정 종가·수정 비율), 1분봉 개장 봉({@code 09:01}·{@code 10:01} 라벨, {@code TOSS_1M_OPEN}),
     * 종목 상태(NXT·KRX 정지), 종목별 받은 시각 {@code fetchedAt}. 미국 {@link #SNAP_PAPER_QUOTES}와 모양이 다르고 파싱은 시장 묶음(C2)이
     * 합니다 — 계약 {@code contract 1}은 명세 2026-10-26-v2-kr-paper-spec.md §9 'paper.kr.quotes 계약'. KR 거래일 D 20:30 KST 뒤 하루 1회.
     */
    public static final String SNAP_KR_PAPER_QUOTES = "paper.kr.quotes";
    /**
     * 🧪 모의 매매 장중 평가(표시 전용) — 보유 종목의 최신 1분봉 가격·봉 시각(미국 Yahoo, 한국 토스). 정기 수집이 없고(수집기 속도군 live)
     * 운영자가 모의 매매 화면을 보는 정규장 동안 {@code GET /api/paper/live}가 live 읽기({@link #MAX_AGE_LIVE})로 요청합니다. 체결·스탑·확정
     * 순자산에는 쓰지 않습니다. 모양 {@code {market, source, scope, tickers:{T:{price, at, isStale?}}, missing, error}}.
     */
    public static final String SNAP_PAPER_LIVE_US = "paper.live.us";
    public static final String SNAP_PAPER_LIVE_KR = "paper.live.kr";
    /**
     * 🧪 미국 Claude 계좌2(체결 시점 실험)의 1분봉 — 단계 0 측정(명세 2026-10-30-claude-book2-timing-design.md §7-1·§12-1, ADR 0022).
     * 수집 범위(Claude 계좌1·계좌2의 대기 주문 ∪ 최근 8일 주문 ∪ 계좌2 보유, + 지연 기준 SPY)의 종목·세션(최근 3, 뉴욕 날짜)마다 메뉴 창
     * (09:30·10:00~15:00 ET, 각 T~T+4분) 1분봉, 창마다 T 뒤 첫 거래 봉({@code firstTradeAfter}), 첫·마지막 봉, 검증용 일봉 시가(X2).
     * 봉 시각 {@code t}는 늘 봉 시작의 UTC({@code barLabel} — X1). {@code lagSeconds}는 SPY 정규장 안에서 받은 저장본만, 아니면 null이고
     * {@code declaredDelayMin}은 늘 null. 모양(contract 1)은 수집기 {@code app/tasks/paper_bars.py} 머리말. 수집기 slow(매시, paper.quotes 바로 뒤).
     * 읽는 코드는 실행 감사 작업(단계 0-4)부터이고 장부·패킷은 읽지 않습니다.
     */
    public static final String SNAP_PAPER_BARS_US = "paper.bars.us";
    /**
     * 모의 매매 트랙레코드 후보 기관 목록과 기관별 수집 진행률(저장 분기 수·완료 여부). 기관마다의 공시는
     * {@code sec13f(cik, TRACK_RECORD_QUARTERS)}에 있고, 이 저장본은 "누가 후보이고 어디까지 받았나"만 담습니다.
     */
    public static final String SNAP_TRACK_RECORD_INDEX = "sec.13f.track_record_index";
    /**
     * 모의 매매 미국 종목 재무(SEC XBRL, D28)의 회사별 수집 상태 — 받은 시각·최신 공시일·최신 기간 end·분류체계·통화·사실 수·오류와
     * 실행 집계(universe·mapped·fetchedThisRun·failedThisRun). 사실 자체는 {@link #OBS_US_FUNDAMENTALS}에 있습니다.
     */
    public static final String SNAP_US_FUNDAMENTALS_STATUS = "us.fundamentals.status";
    /**
     * 모의 매매 Claude 계좌 패킷 {@code 1b_calendar}의 원자료(2단계 A) — 거시 발표일(FRED 릴리스·FOMC 상수, 앞으로 45일)과
     * 유니버스 종목(ETF 제외)의 다음 실적 발표일(yfinance, 종목당 24시간 캐시). 기준일 창과 보유·후보 고르기는 백엔드가 합니다.
     */
    public static final String SNAP_US_CALENDAR = "calendar.us_events";
    /**
     * 🧪 한국 책 Claude 계좌 패킷 {@code 1b_calendar}의 한국 거시 일정(v2 2단계 B9·K20) — 금통위 상수와 연 1회 손으로 옮기는 주요 발표 상수
     * (앞으로 45일, KST). {@link #SNAP_US_CALENDAR}와 같은 모양({@code macro.events}·{@code macro.horizon}, 금통위 {@code macro.bok}, 발표 상수
     * {@code macro.releases} — 날짜를 옮기지 않은 발표는 {@code status} "일정 미확인"), {@code earnings}·{@code consensus}는 null + 사유.
     * 창(다음 세션부터 10거래일, {@code KrxCalendar})은 백엔드가 자릅니다.
     */
    public static final String SNAP_KR_CALENDAR = "calendar.kr_events";
    /**
     * 🧪 미국 경제 지표 컨센서스(v2 2단계 B9·K22 — Nasdaq {@code api/calendar/economicevents}, 비공식 참고). 미국 패킷({@code PacketBuilder})이
     * 설정 {@code calendar.consensus}가 켜졌을 때만 읽어 {@code 1b_calendar} 거시 줄에 붙입니다(E1b — 대응표 {@code analytics.CalendarConsensus}).
     * 그 밖의 코드는 읽지 않습니다(수집기 시험 {@code test_us_consensus}가 대조).
     * {@code {forDate, days: {동부 날짜: {rows: [{name, timeEt, forecast, previous, actual, unit, forecastText, previousText, actualText,
     * importance}], fetchedAt, isStale?}}, failed}} — 날짜는 공식 출처(FRED·FOMC)가 정하고 이 값은 이름 대응표로 그 줄에 붙이는 층입니다.
     */
    public static final String SNAP_US_CONSENSUS = "calendar.us_consensus";
    /**
     * 모의 매매 Claude 계좌 패킷 {@code 11b_events}(2단계 B)의 수집 상태 — 피드별 성공·실패와 사유({@code feeds}·{@code failedFeeds}),
     * {@code feedsOk}·{@code feedsTotal}, 7일 보관 건수 {@code stored7d}, 마지막 수집 시각 {@code generatedAt}(UTC). 헤드라인 자체는
     * {@link #OBS_NEWS_HEADLINE}에 있습니다.
     */
    public static final String SNAP_NEWS_STATUS = "news.headlines.status";
    /**
     * 🧪 한국 책 Claude 계좌 패킷 {@code 11b_events}(v2 2단계 B9)의 한국 사건 헤드라인 수집 상태 — {@link #SNAP_NEWS_STATUS}와 같은 칸 +
     * 피드별 시각 형식({@code timeFormat})·형식이 다른 시각 수({@code skippedBadTime}). 헤드라인 자체는 {@link #OBS_KR_NEWS_HEADLINE}에 있습니다.
     */
    public static final String SNAP_KR_NEWS_STATUS = "kr.news.headlines.status";
    /**
     * 모의 매매 Claude 계좌 패킷 {@code 8b_fundamentals}의 EPS 서프라이즈(2단계 C) 수집 상태 — 종목별 {@code items}
     * ({@code fetchedAt}·{@code rows}·{@code latestReported}·{@code error}?·{@code isStale}?)와 실행 집계({@code universe}·
     * {@code covered}·{@code withEstimate4}·{@code fetchedThisRun}·{@code failedThisRun}·{@code stoppedReason}?), 받은 시각
     * {@code generatedAt}(UTC). 분기 값 자체는 {@link #OBS_US_EARNINGS_SURPRISE}에 있습니다.
     */
    public static final String SNAP_EARNINGS_SURPRISE_STATUS = "us.earnings_surprise.status";

    /** 변동성 지수는 가장 긴 기간으로 한 번 저장하고 짧은 기간은 잘라 씁니다. */
    public static final String VOLATILITY_STORE_PERIOD = "5y";

    /** 수집기가 저장하는 최대 분기 수. q1은 q8의 앞부분입니다. */
    public static final int MAX_TRACKED_QUARTERS = 8;

    /**
     * 모의 매매 트랙레코드 후보 기관의 13F 분기 수(저장 이름 {@code sec13f(cik, 30)}). 7년 창(28분기)에 공시 지연 여유를 더한
     * 값입니다 — 재선정일에는 최신 분기 공시가 아직 없을 수 있고, 창의 첫 구간은 창 시작 전에 낸 공시로 시작합니다.
     * 기존 13F 화면(q8)과 따로 받습니다.
     */
    public static final int TRACK_RECORD_QUARTERS = 30;

    /** Daum 선물 수급 조회 기간 (수집기와 동일해야 합니다). */
    public static final int DAUM_TREND_LOOKBACK = 25;

    public static String daumFuturesTrend(int lookbackDays) {
        // .CONTRACT 접미사는 "계약수 기준"임을 명시합니다.
        // (금액(억원) 모드는 Daum이 제공하지 않아 제거됐습니다.)
        return "krx.daum_futures_trend.d" + lookbackDays + ".CONTRACT";
    }

    public static String tickerHistory(String symbol, String period) {
        String safe = symbol.replace("^", "").replace("=", "_").replace(".", "_");
        return "ticker." + safe + "." + period;
    }

    public static String cotContract(String contractCode, int limit) {
        return "cot.contract." + contractCode + ".l" + limit;
    }

    public static String sec13f(String cik, int maxQuarters) {
        return "sec.13f." + cik + ".q" + maxQuarters;
    }

    public static String fredSeries(String seriesId) {
        return "fred.series." + seriesId;
    }

    /**
     * 수집기가 받아 저장하는 FRED 시계열 (collector/app/indicators.py의 FRED_ALL_SERIES).
     *
     * <p>이 목록에 없는 ID는 저장본이 생길 수 없습니다. 화면 API가 모르는 ID로 저장본을 찾으면
     * "없음" → FRED 전체 수집을 동기로 기다리게 되므로, 입구에서 거릅니다.
     * 두 목록이 같은지는 DatasetsParityTest가 확인합니다.
     */
    public static final List<String> FRED_SERIES = List.of(
            "DGS2", "DGS10", "DGS30", "DGS3MO", "BAMLH0A0HYM2", "STLFSI4", "CPF3M",
            "T10Y3M", "DFII10", "T10YIE", "BAMLC0A0CM", "NFCI");

    public static String radarScanner(String market, String investor,
                                      String tradeType, String intervalType) {
        return "radar.scanner." + market + "." + investor + "." + tradeType + "." + intervalType;
    }

    // ------------------------------------------------------------- 누적 이력
    public static final String TS_FRED = "fred";
    public static final String TS_KRX_FUTURES = "krx_futures";
    public static final String TS_LIQUIDITY = "fed_liquidity";
    public static final String OBS_RADAR = "radar_ranking";
    /** 금융위 공식 일별 시세 (entity = 6자리 종목코드). */
    public static final String OBS_FSC_PRICE = "fsc_price";
    /**
     * 금융위 ETF 일별 시세(증권상품시세 {@code getETFPriceInfo_V2}, v2 2단계 B3·K15). entity = 6자리 코드(영문 섞임 포함), obs_date = 기준일,
     * payload {@code {code, name, close, open, high, low, volume, tradingValue, marketCap, nav, netAssets, listedUnits, indexName,
     * indexClose, basDt}}. 주식시세({@link #OBS_FSC_PRICE})에는 ETF가 없습니다. 한국 책의 ETF 확정가(069500·153130)가 읽고,
     * 수집기만 쓰며(ADR 0008) 400일이 지난 행은 수집기가 지웁니다.
     */
    public static final String OBS_FSC_ETF_PRICE = "fsc_etf_price";
    /**
     * 🧪 한국 책 유니버스 U(v2 2단계 B4·K3) — 금융위 최신 기준일 B(&lt; 오늘)의 코스피 시가총액 상위 100 보통주(우선주·스팩·리츠·
     * 거래정지·DART 고유번호 없음 제외). entity = 6자리 코드, obs_date = B, payload {@code {code, name, rank, marketCap, listedShares,
     * close, rule}}. 그날 U에 든 종목만 있고 날짜마다 통째로 교체됩니다. 정의는 수집기 한 곳({@code collector/app/tasks/kr_paper.py}) —
     * 백엔드는 그대로 읽어 결정 행에 동결합니다. 수집기만 쓰며(ADR 0008) 400일이 지난 행은 수집기가 지웁니다.
     */
    public static final String OBS_KR_PAPER_UNIVERSE = "kr_paper_universe";
    /** 시장별 합계 시가총액·거래대금 (series = "KOSPI.marketCap" 등). */
    public static final String TS_FSC_MARKET = "fsc_market";
    /** 종목별 일별 투자자 매매동향 (토스증권 공식, entity = 종목코드). */
    public static final String OBS_TOSS_STOCK_FLOW = "toss_stock_flow";
    /**
     * 🧪 한국 책 종목별 수급(v2 2단계 B4) — 수집 범위의 토스 투자자별 매매동향(주, KRX·NXT 통합). entity = 코드, obs_date = 기록 날짜,
     * payload = {@link #OBS_TOSS_STOCK_FLOW}와 같은 칸(투자자 4분류·기관 세부 7·외국인 보유율·토스 {@code updatedAt}) + {@code code}·
     * {@code fetchedAt}. 같은 날짜는 나중 판으로 덮이므로 결정·선정은 그때 읽은 값과 {@code updatedAt}을 결정 행에 동결합니다(명세 K26).
     * 수집기만 쓰며(ADR 0008) 400일이 지난 행은 수집기가 지웁니다.
     */
    public static final String OBS_KR_PAPER_FLOW = "kr_paper_flow";
    /**
     * 위 수급의 종목별 수집 상태 — {@code {session, universeDate, scope, codes: {code: {status OK|NO_RECORDS, fetchedAt, records,
     * latestDate, latestUpdatedAt, isStale?}}}}. {@code scope}에 있는데 {@code codes}에 없거나 {@code isStale}이면 '호출 실패',
     * {@code NO_RECORDS}면 '응답에 없음'입니다.
     */
    public static final String SNAP_KR_PAPER_FLOWS_STATUS = "kr.paper_flows.status";
    /**
     * 모의 매매 유니버스의 10년 일별 종가(수정주가, series = 야후 티커). 분할·배당으로 과거 값이 다시 쓰일 수 있어
     * 분할 감지가 이 값을 기준 종가와 대조합니다. 기간으로 지우지 않습니다.
     */
    public static final String TS_EQUITY_CLOSE = "equity_close";
    /**
     * 🧪 한국 책 종가 이력(v2 2단계 B4) — 토스 {@code adjusted=true} 일봉 종가(NXT 종목은 KRX+NXT 통합가), series = 6자리 코드. 수집기가
     * 1년을 메우고 날마다 최근 5봉을 덧붙이며, 수정주가 기준이 바뀌면(분할·병합) 저장 구간 전체를 새 기준으로 다시 받습니다. 지우지 않습니다.
     */
    public static final String TS_KR_CLOSE_ADJ = "kr_close_adj";
    /**
     * 모의 매매 미국 종목 재무(SEC XBRL Company Facts, D28). entity = 티커, obs_date = 공시일(filed), payload
     * {@code {"cik": [...], "facts": [...]}}는 그날 처음 낸(또는 값이 바뀐) 사실 묶음입니다. 수집기만 쓰고(ADR 0008),
     * 그 시점 값을 고르려면 옛 공시일 행이 있어야 하므로 기간으로 지우지 않습니다. 결정에는 obs_date ≤ 기준일만 씁니다.
     */
    public static final String OBS_US_FUNDAMENTALS = "us.fundamentals";
    /**
     * 모의 매매 사건 뉴스 헤드라인(RSS 제목·링크·출처·시각만, 2단계 B·D29). entity = 정규화한 제목의 sha256 앞 16자, obs_date = 발행
     * 시각의 UTC 날짜, payload {@code {title, link, source, feed, publishedAt, fetchedAt}}(시각은 ISO UTC). 수집기만 쓰고(ADR 0008)
     * 7일이 지난 행은 수집기가 지웁니다. 거르기(종목·키워드)와 패킷 창은 백엔드가 합니다.
     */
    public static final String OBS_NEWS_HEADLINE = "news_headline";
    /**
     * 🧪 한국 책 사건 헤드라인(v2 2단계 B9·K21 — 한국은행·재정경제부·국가데이터처·연합뉴스 마켓+ RSS 제목·링크·시각만). 미국
     * {@link #OBS_NEWS_HEADLINE}과 따로입니다. entity = 같은 제목 해시, obs_date = 발행 KST 날짜, payload {@code {title, link, source, feed,
     * feeds, publishedAt, publishedDate, timePrecision, knownAt, fetchedAt}} — {@code publishedAt}은 날짜만 주는 피드(재정경제부)에서 null,
     * {@code timePrecision}은 second·minute·date. 창은 {@code knownAt}('알 수 있는 시각' — 날짜만이면 min(처음 받은 시각, 그 KST 날짜 다음
     * 자정), 명세 §4-11)으로 자릅니다. 수집기만 쓰고(ADR 0008) 7일이 지난 행은 수집기가 지웁니다.
     */
    public static final String OBS_KR_NEWS_HEADLINE = "kr_news_headline";
    /**
     * 모의 매매 어닝 서프라이즈(yfinance quoteSummary {@code earnings.earningsChart}, 2단계 C·D36). entity = 티커, obs_date = 실제
     * 발표 시각({@code reportedDate})의 미국 동부 날짜, payload {@code {periodEnd, actual, estimate, surprisePct, currency, smallBase,
     * reportedAt, source}}({@code reportedAt}은 동부 시간대 오프셋을 붙인 ISO). 수집기만 쓰고(ADR 0008) (날짜, 티커)마다 덮어쓰며
     * 지우지 않습니다(출처가 최근 4분기만 줘 쌓아야 8분기가 됨). 결정에는 obs_date ≤ 기준일만 씁니다.
     */
    public static final String OBS_US_EARNINGS_SURPRISE = "us.earnings_surprise";

    // ------------------------------------------------------------- 신선도(초)
    /** 장중 시세성 데이터 (수집 주기 5분의 3배). */
    public static final long MAX_AGE_REALTIME = 15 * 60L;

    /**
     * 매크로 화면이 "자동 갱신"을 켜고 보고 있을 때의 신선도 기준.
     *
     * <p><b>왜 60초가 하한인가</b> — 매크로 카드 21개는 전부 Yahoo를 폴링해
     * 받아옵니다(한 번에 약 3초). 화면이 10초마다 다시 읽는다고 수집까지
     * 10초마다 하면 시간당 요청이 252건에서 7,560건으로 뜁니다. 이 저장소는
     * 이미 <b>Yahoo 429로 스크래핑이 막혀 화면이 빈 적</b>이 있습니다.
     *
     * <p>그렇다고 15분 기준을 그대로 쓰면, 사용자가 10초를 골라도 저장본이
     * 15분 동안 그대로라 <b>같은 숫자만 다시 그립니다</b>. 그래서 보고 있는
     * 동안만 기준을 60초로 낮춥니다. 값은 최대 1분마다 움직이고, 외부 요청은
     * 시간당 1,260건으로 5배에 그칩니다.
     *
     * <p>더 짧게 낮추지 않는 이유가 하나 더 있습니다. Yahoo 카드는 출처부터가
     * 최대 20분 지연 시세(카드 배지)라, 초 단위로 받아도 같은 값입니다. TradingView
     * 실시간 카드는 수집기가 이 주기에 맞춰 바로 받습니다(QA-138).
     */
    public static final long MAX_AGE_LIVE = 60L;
    /**
     * 🧪 {@link #SNAP_PAPER_BARS_US}를 '그 회차의 1분봉'으로 볼 최대 나이 — slow 주기(60분) + 앞 태스크 몇 분 여유(명세 §12-1). 이보다 오래된
     * 저장본은 1분봉 수집이 한 회차 넘게 멈춘 것으로 봅니다(실행 감사의 '1분봉 없음', 단계 1의 대체 체결 R3). 읽는 코드는 단계 0-4부터입니다.
     */
    public static final long MAX_AGE_BARS_US = 70 * 60L;
    /** 일별 확정치 (FRED/KRX 마감). */
    public static final long MAX_AGE_DAILY = 6 * 60 * 60L;
    /** 분기 공시(13F) 등 거의 변하지 않는 데이터. */
    public static final long MAX_AGE_SLOW = 24 * 60 * 60L;
    /** 주 단위로 바뀌는 데이터 (공휴일 발표·분기 공시 기반 재무). */
    public static final long MAX_AGE_WEEKLY = 7 * 24 * 60 * 60L;

    /**
     * 수동 새로고침이라도 이 간격 안에는 다시 받지 않습니다.
     *
     * <p><b>왜 필요한가</b> — 수동 새로고침은 "이 시각 이전 저장본은 낡은
     * 것으로 본다"는 기준을 세웁니다. 그런데 그 기준이 데이터셋 종류를
     * 가리지 않아서, 버튼 한 번에 <b>분기마다 바뀌는 13F까지</b> 다시
     * 받았습니다. 실제 로그에서 5분 사이에 SEC 전수 수집이 세 번 돌았습니다.
     *
     * <pre>
     * 07:20:33 sec_13f 51.80s   ← 스케줄(weekly)
     * 07:21:34 POST /refresh → 07:22:01 sec_13f 31.77s
     * 07:24:33 POST /refresh → 07:24:44 sec_13f 32.05s
     * </pre>
     *
     * SEC는 호출 한도를 명시하고 초과하면 차단합니다. 3분 전에 받은
     * 분기 공시를 다시 받을 이유는 없습니다 — 새로 나온 것이 없습니다.
     *
     * <p>빠르게 바뀌는 데이터는 거의 제한하지 않습니다(1분). 새로고침을
     * 누르는 이유가 대개 그쪽이기 때문입니다.
     */
    public static long minRefetchSeconds(long maxAgeSeconds) {
        if (maxAgeSeconds <= MAX_AGE_REALTIME) {
            return 60L;                 // 시세성: 1분
        }
        if (maxAgeSeconds <= MAX_AGE_DAILY) {
            return 30 * 60L;            // 일별 확정치: 30분
        }
        return 6 * 60 * 60L;            // 분기 공시 등: 6시간
    }
}
