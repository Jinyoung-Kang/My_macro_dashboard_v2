package com.macrodash.feature.info;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 수집 출처 표(ADR 0035·0036) — 수집기 태스크마다 화면 이름·정보 수집 화면의 탭·종류·출처 링크·기관·접근 방식·데이터를 보는 화면.
 * 정보 수집 화면의 출처 카드·출처 상태와 끊김 알림(출처 이름)이 이 표를 씁니다.
 *
 * <p>수집기 태스크 목록과 같아야 합니다({@code InfoSourcesParityTest} — {@code collector/app/tasks/registry.py}의 태스크와 블로그 표
 * {@code info_blogs.BLOGS}를 대조). 수집기에 없는 줄은 보류한 출처({@code saveticker} — 서버 IP 차단, ADR 0036) 하나뿐입니다.
 */
public final class InfoSources {

    private InfoSources() {
    }

    /** 정보 수집 화면의 탭(큰 분류). */
    public static final String TAB_NEWS = "news";
    public static final String TAB_KR = "kr";
    public static final String TAB_GLOBAL = "global";
    public static final String TAB_FILINGS = "filings";
    public static final String TAB_PAPER = "paper";
    public static final String TAB_OPS = "ops";
    public static final List<String> TABS = List.of(TAB_NEWS, TAB_KR, TAB_GLOBAL, TAB_FILINGS, TAB_PAPER, TAB_OPS);

    /** 글 출처의 종류 — 글 목록 거름(블로그·waedge)에 씁니다. */
    public static final String BLOG = "blog";
    public static final String WAEDGE = "waedge";
    /** 속보 한 줄(Financial Juice — 제목·링크·시각, 본문 없는 출처. ADR 0037). */
    public static final String WIRE = "wire";

    /** 접근 방식 — 공식 API·비공식 공개 경로·차단 통과 계층(polite)·외부 호출 없음·보류. */
    public static final String OFFICIAL = "official";
    public static final String UNOFFICIAL = "unofficial";
    public static final String BYPASS = "bypass";
    public static final String INTERNAL = "internal";
    public static final String DEFERRED = "deferred";

    /** 보류한 출처의 태스크 이름(수집기에 태스크가 없음 — 서버 IP 차단, ADR 0036). */
    public static final String SAVETICKER = "saveticker";

    /**
     * 출처 하나.
     *
     * @param task    수집기 태스크 이름(collector_task_runs·fetch_source_state의 task)
     * @param key     글 출처 키(info_items.source) 또는 그에 준하는 이름
     * @param tab     정보 수집 화면의 탭({@link #TABS})
     * @param kind    종류(blog·waedge·wire·naver·krx·calendar·rss·data·internal·deferred)
     * @param siteUrl 출처 링크(없으면 빈 글)
     * @param origin  자료를 내는 곳
     * @param access  접근 방식({@link #OFFICIAL} 등)
     * @param screen  데이터를 보는 화면 경로(없으면 null)
     */
    public record Source(String task, String key, String label, String tab, String kind, String siteUrl, String origin,
                         String access, String screen) {
    }

    public static final List<Source> ALL = List.of(
            new Source("scraper_markets", "scraper_markets", "참고 시세(미국채·아시아 선물 등)", "global", "data", "https://www.tradingview.com/", "TradingView Scanner·Yahoo", "unofficial", "/macro"),
            new Source("macro_collected", "macro_collected", "매크로 카드 전 지표", "global", "data", "https://finance.yahoo.com/", "Yahoo·TradingView·FRED", "unofficial", "/macro"),
            new Source("radar_rankings", "radar_rankings", "국내 수급 랭킹(레이더)", "kr", "data", "https://finance.daum.net/domestic/investors", "KIS·Daum·Naver·KRX·토스", "unofficial", "/radar"),
            new Source("fred_series", "fred_series", "FRED 금리·신용 시계열", "global", "data", "https://fred.stlouisfed.org/", "FRED(세인트루이스 연준)", "official", "/macro"),
            new Source("fed_liquidity", "fed_liquidity", "연준 순유동성", "global", "data", "https://fred.stlouisfed.org/", "FRED", "official", "/liquidity"),
            new Source("krx_futures", "krx_futures", "KRX 선물·미결제약정", "kr", "data", "https://openapi.krx.co.kr/", "KRX Open API", "official", "/krx"),
            new Source("sector_history", "sector_history", "섹터·자산군 ETF 종가", "global", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/sector"),
            new Source("fx_history", "fx_history", "환율·달러인덱스 종가", "global", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/macro"),
            new Source("equity_history", "equity_history", "13F 매핑 종목 종가", "filings", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/institutions"),
            new Source("paper_quotes", "paper_quotes", "모의매매 미국 유니버스 일봉", "paper", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/paper/us"),
            new Source("paper_bars_us", "paper_bars_us", "미국 Claude 계좌2 1분봉", "paper", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/paper/us"),
            new Source("paper_watch_us", "paper_watch_us", "미국 계좌2 장중 확인 1분봉", "paper", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/paper/us"),
            new Source("paper_watch_kr", "paper_watch_kr", "한국 계좌2 장중 확인 1분봉", "paper", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/paper/kr"),
            new Source("paper_stopwatch_us", "paper_stopwatch_us", "미국 장중 스탑 감시", "paper", "data", "https://finance.yahoo.com/", "Yahoo spark", "unofficial", "/paper/us"),
            new Source("paper_stopwatch_kr", "paper_stopwatch_kr", "한국 장중 스탑 감시", "paper", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/paper/kr"),
            new Source("paper_live_us", "paper_live_us", "미국 장중 평가(화면이 볼 때)", "paper", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/paper/us"),
            new Source("paper_live_kr", "paper_live_kr", "한국 장중 평가(화면이 볼 때)", "paper", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/paper/kr"),
            new Source("us_calendar", "us_calendar", "미국 발표·실적 일정", "global", "data", "https://fred.stlouisfed.org/releases/calendar", "FRED·연준 FOMC 일정·yfinance", "official", "/paper/us"),
            new Source("us_calendar_consensus", "us_calendar_consensus", "미국 지표 컨센서스", "global", "data", "https://www.nasdaq.com/market-activity/economic-calendar", "Nasdaq 경제 캘린더", "unofficial", "/paper/us"),
            new Source("us_bls_actuals", "us_bls_actuals", "미국 경제지표 BLS 공식 발표치(저장만)", "global", "data", "https://www.bls.gov/developers/", "BLS Public Data API", "official", null),
            new Source("us_consensus_release", "us_consensus_release", "미국 지표 실제치 발표 직후(컨센서스 오늘 줄)", "global", "data", "https://www.nasdaq.com/market-activity/economic-calendar", "Nasdaq 경제 캘린더", "unofficial", "/paper/us"),
            new Source("news_headlines", "news_headlines", "사건 뉴스 RSS(미국)", "news", "rss", "https://www.investing.com/", "Investing.com·연준·BLS·SEC", "official", "/info/news"),
            new Source("kr_news_headlines", "kr_news_headlines", "사건 뉴스 RSS(한국)", "news", "rss", "https://www.bok.or.kr/", "한국은행·재정경제부·국가데이터처·연합뉴스", "official", "/info/news"),
            new Source("search_feeds", "search_feeds", "보도자료·경제지 피드(정보 검색)", "news", "rss", "https://www.federalreserve.gov/feeds/", "연준·ECB·영란은행·Bloomberg·MarketWatch·CNBC·Benzinga·Seeking Alpha·BBC·Economist·Nikkei Asia", "official", "/info/news"),
            new Source("search_watch", "search_watch", "관심 대상 수집(뉴스·공시·Finviz)", "news", "rss", "https://news.google.com/", "구글 뉴스·Bing 뉴스 RSS·SEC·DART 공시·Finviz 종목 뉴스(차단 통과 계층 — 화면발 Finviz 거부도 이 줄) + 저장본 대조", "bypass", "/search"),
            new Source("volatility_history", "volatility_history", "VIX·MOVE 변동성", "global", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/macro"),
            new Source("cot_history", "cot_history", "CFTC COT", "global", "data", "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm", "CFTC", "official", "/cot"),
            new Source("daum_futures_trend", "daum_futures_trend", "선물 투자주체별 수급", "kr", "data", "https://finance.daum.net/domestic/investors/DERIVATIVES", "Daum 금융", "unofficial", "/krx"),
            new Source("fsc_prices", "fsc_prices", "국내 공식 일별 시세", "kr", "data", "https://www.data.go.kr/", "금융위원회(공공데이터포털)", "official", null),
            new Source("fsc_etf_prices", "fsc_etf_prices", "국내 ETF 공식 일별 시세", "kr", "data", "https://www.data.go.kr/", "금융위원회(공공데이터포털)", "official", null),
            new Source("toss_market_flows", "toss_market_flows", "코스피·코스닥 투자자별 매매대금", "kr", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/krx"),
            new Source("toss_stock_flows", "toss_stock_flows", "레이더 종목 투자자별 매매", "kr", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/radar"),
            new Source("toss_radar_universe", "toss_radar_universe", "거래대금 상위 100종목 투자자 매매", "kr", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/radar"),
            new Source("kr_paper_universe", "kr_paper_universe", "한국 계좌 유니버스(외부 호출 없음)", "paper", "internal", "", "금융위 저장본으로 계산", "internal", "/paper/kr"),
            new Source("kr_paper_timed", "kr_paper_timed", "한국 계좌2 시각 지정 체결 1분봉", "paper", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/paper/kr"),
            new Source("kr_paper_quotes", "kr_paper_quotes", "한국 계좌 관측치(일봉·개장 봉)", "paper", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/paper/kr"),
            new Source("kr_paper_flows", "kr_paper_flows", "한국 계좌 종목별 수급", "paper", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/paper/kr"),
            new Source("sec_13f", "sec_13f", "SEC 13F 기관 포트폴리오", "filings", "data", "https://www.sec.gov/edgar", "SEC EDGAR", "official", "/institutions"),
            new Source("sec_13f_track_record", "sec_13f_track_record", "13F 트랙레코드 후보 30분기", "filings", "data", "https://www.sec.gov/edgar", "SEC EDGAR", "official", "/paper/us"),
            new Source("sec_fundamentals", "sec_fundamentals", "미국 종목 재무(XBRL)", "filings", "data", "https://www.sec.gov/edgar", "SEC EDGAR XBRL", "official", "/paper/us"),
            new Source("earnings_surprise", "earnings_surprise", "어닝 서프라이즈", "filings", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/paper/us"),
            new Source("kr_holidays", "kr_holidays", "한국 공휴일", "kr", "data", "https://www.data.go.kr/", "한국천문연구원 특일정보", "official", null),
            new Source("kr_calendar", "kr_calendar", "한국 거시 일정(상수)", "kr", "internal", "https://www.bok.or.kr/", "금통위 상수·주요 발표 상수", "internal", "/paper/kr"),
            new Source("dart_fundamentals", "dart_fundamentals", "국내 종목 재무", "filings", "data", "https://opendart.fss.or.kr/", "금융감독원 Open DART", "official", "/radar"),
            new Source("paper_price_history", "paper_price_history", "미국 유니버스 10년 종가", "paper", "data", "https://finance.yahoo.com/", "Yahoo(yfinance)", "unofficial", "/paper/us"),
            new Source("kr_paper_price_history", "kr_paper_price_history", "한국 계좌 종가 이력", "paper", "data", "https://tossinvest.com/", "토스증권 Open API", "official", "/paper/kr"),
            new Source("run_log_retention", "run_log_retention", "실행 기록·수집 글 정리", "ops", "internal", "", "외부 호출 없음", "internal", "/status"),
            new Source("econ_calendar_tradingview", "calendar.tradingview", "TradingView 경제 캘린더", "global", "calendar", "https://www.tradingview.com/economic-calendar/", "TradingView", "bypass", "/macro"),
            new Source("info_blog_wolfstreet", "blog.wolfstreet", "Wolf Street", "news", "blog", "https://wolfstreet.com/", "Wolf Street", "bypass", "/info/news"),
            new Source("info_blog_abnormalreturns", "blog.abnormalreturns", "Abnormal Returns", "news", "blog", "https://abnormalreturns.com/", "Abnormal Returns", "bypass", "/info/news"),
            new Source("info_blog_awealthofcommonsense", "blog.awealthofcommonsense", "A Wealth of Common Sense", "news", "blog", "https://awealthofcommonsense.com/", "A Wealth of Common Sense", "bypass", "/info/news"),
            new Source("info_blog_marginalrevolution", "blog.marginalrevolution", "Marginal Revolution", "news", "blog", "https://marginalrevolution.com/", "Marginal Revolution", "bypass", "/info/news"),
            new Source("info_blog_ritholtz", "blog.ritholtz", "The Big Picture (Ritholtz)", "news", "blog", "https://ritholtz.com/", "The Big Picture (Ritholtz)", "bypass", "/info/news"),
            new Source("info_blog_calculatedrisk", "blog.calculatedrisk", "Calculated Risk", "news", "blog", "https://calculatedrisk.substack.com/", "Calculated Risk", "bypass", "/info/news"),
            new Source("info_blog_libertystreet", "blog.libertystreet", "Liberty Street Economics (NY Fed)", "news", "blog", "https://libertystreeteconomics.newyorkfed.org/", "Liberty Street Economics (NY Fed)", "bypass", "/info/news"),
            new Source("info_blog_klement", "blog.klement", "Klement on Investing", "news", "blog", "https://klementoninvesting.substack.com/", "Klement on Investing", "bypass", "/info/news"),
            new Source("info_blog_econbrowser", "blog.econbrowser", "Econbrowser", "news", "blog", "https://econbrowser.com/", "Econbrowser", "bypass", "/info/news"),
            new Source("info_blog_conversableeconomist", "blog.conversableeconomist", "Conversable Economist", "news", "blog", "https://conversableeconomist.com/", "Conversable Economist", "bypass", "/info/news"),
            new Source("info_blog_alphaarchitect", "blog.alphaarchitect", "Alpha Architect", "news", "blog", "https://alphaarchitect.com/", "Alpha Architect", "bypass", "/info/news"),
            new Source("info_blog_humbledollar", "blog.humbledollar", "HumbleDollar", "news", "blog", "https://humbledollar.com/", "HumbleDollar", "bypass", "/info/news"),
            new Source("info_blog_damodaran", "blog.damodaran", "Musings on Markets (Damodaran)", "news", "blog", "https://aswathdamodaran.blogspot.com/", "Musings on Markets (Damodaran)", "bypass", "/info/news"),
            new Source("info_blog_irrelevantinvestor", "blog.irrelevantinvestor", "The Irrelevant Investor", "news", "blog", "https://www.theirrelevantinvestor.com/", "The Irrelevant Investor", "bypass", "/info/news"),
            new Source("info_waedge_brief", "waedge.brief", "waedge 시장", "news", "waedge", "https://news.waedge.ai/s/brief.html", "WAEDGE NEWS", "bypass", "/info/news"),
            new Source("info_waedge_people", "waedge.people", "waedge 거장", "news", "waedge", "https://news.waedge.ai/s/people.html", "WAEDGE NEWS", "bypass", "/info/news"),
            new Source("info_waedge_blogs", "waedge.blogs", "waedge 해외 블로그(한국어 제목)", "news", "waedge", "https://news.waedge.ai/s/blogs.html", "WAEDGE NEWS", "bypass", "/info/news"),
            new Source("info_wire_financialjuice", "wire.financialjuice", "Financial Juice 속보", "news", "wire", "https://www.financialjuice.com/home", "Financial Juice", "bypass", "/info/news"),
            new Source("info_naver_flows", "naver.flows", "네이버 투자자별 매매동향·매매상위", "kr", "naver", "https://stock.naver.com/market/stock/kr/trend/trader", "네이버 증권", "bypass", "/info/kr"),
            new Source("info_krx_daily", "krx.daily", "KRX 정보데이터시스템(로그인)", "kr", "krx", "https://data.krx.co.kr/", "한국거래소 정보데이터시스템", "bypass", "/info/kr"),
            new Source("saveticker", "saveticker.news", "saveticker 뉴스(보류)", "news", "deferred", "https://www.saveticker.com/news", "SAVE(Fivelines)", "deferred", null));

    private static final Map<String, Source> BY_TASK = new LinkedHashMap<>();
    private static final Map<String, Source> BY_KEY = new LinkedHashMap<>();

    static {
        ALL.forEach(source -> {
            BY_TASK.put(source.task(), source);
            BY_KEY.put(source.key(), source);
        });
    }

    public static Optional<Source> byTask(String task) {
        return Optional.ofNullable(BY_TASK.get(task));
    }

    public static Optional<Source> byKey(String key) {
        return Optional.ofNullable(BY_KEY.get(key));
    }

    /** 태스크의 화면 이름 — 표에 없으면 태스크 이름 그대로. */
    public static String label(String task) {
        return byTask(task).map(Source::label).orElse(task);
    }

    /** 그 종류의 글 출처 키. */
    public static List<String> keysOf(String kind) {
        return ALL.stream().filter(source -> source.kind().equals(kind)).map(Source::key).toList();
    }
}
