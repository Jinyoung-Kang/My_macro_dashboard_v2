package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.store.StoreRepository.TimeseriesColumns;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_FINAL;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 시세 저장본 읽기 — 관측치 파싱(빠진 티커·길이 불일치·이어 쓴 봉), 최빈 봉 날짜, 사후 체결 종가의 출처.
 */
class PaperMarketDataTest {

    /** 출발일(금) 다음 주 화요일 — 금요일은 이미 '지금 세션'이 아님(이력 값을 믿음). */
    private static final Clock LATER = Clock.fixed(PaperFixtures.TUE_FINAL, ZoneOffset.UTC);

    private StoreReader reader;
    private StoreRepository repository;
    private PaperMarketData marketData;

    @BeforeEach
    void setUp() {
        reader = mock(StoreReader.class);
        repository = mock(StoreRepository.class);
        when(repository.readTimeseriesColumns(any(), anyCollection(), any(), any())).thenReturn(Map.of());
        marketData = new PaperMarketData(reader, repository, LATER);
    }

    private void snapshot(Instant collectedAt, String payload) throws Exception {
        JsonNode json = MAPPER.readTree(payload);
        when(reader.read(eq(Datasets.SNAP_PAPER_QUOTES), anyLong(), eq("paper_quotes")))
                .thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_QUOTES, json, "json", "ok", null, collectedAt)));
    }

    @Test
    @DisplayName("마지막 봉 = dates[-1]·close[-1]. 길이가 다르거나 마지막 값이 없는 티커는 뺀다(직전 값으로 채우지 않음)")
    void parsesLastBars() throws Exception {
        snapshot(MON_INTRADAY, """
                {"period":"3mo","universe":["AAA","BBB","CCC","DDD","EEE"],"tickers":{
                  "AAA":{"dates":["2026-10-23","2026-10-26"],"close":[100.0,101.5]},
                  "BBB":{"dates":["2026-10-23","2026-10-26"],"close":[50.0]},
                  "CCC":{"dates":["2026-10-23","2026-10-26"],"close":[10.0,null]},
                  "DDD":{"dates":["2026-10-22","2026-10-23"],"close":[5.0,5.5],"isStale":true,"staleReason":"x"},
                  "EEE":{"dates":["2026-10-23","2026-10-26"],"close":[null,7.0]}
                }}""");

        Quotes quotes = marketData.quotes().orElseThrow();

        assertThat(quotes.collectedAt()).isEqualTo(MON_INTRADAY);
        assertThat(quotes.bars().keySet()).containsExactly("AAA", "DDD", "EEE");
        assertThat(quotes.bars().get("AAA").date()).isEqualTo(MON);
        assertThat(quotes.bars().get("AAA").close()).isEqualTo(101.5);
        assertThat(quotes.bars().get("AAA").recent().valueOn(FRI)).isEqualTo(100.0);
        assertThat(quotes.bars().get("DDD").stale()).isTrue();
        assertThat(quotes.bars().get("EEE").recent().size()).as("중간의 빈 값은 건너뜀").isEqualTo(1);
        assertThat(quotes.staleTickers()).containsExactly("DDD");
        assertThat(quotes.modalBarDate()).as("이어 쓴 봉(금)은 세지 않음").isEqualTo(MON);
    }

    @Test
    @DisplayName("저장본이 없거나 수집 시각이 없거나 쓸 티커가 없으면 empty")
    void emptyCases() throws Exception {
        when(reader.read(any(), anyLong(), any())).thenReturn(Optional.empty());
        assertThat(marketData.quotes()).isEmpty();

        snapshot(null, "{\"tickers\":{\"AAA\":{\"dates\":[\"2026-10-23\"],\"close\":[1.0]}}}");
        assertThat(marketData.quotes()).isEmpty();

        snapshot(MON_INTRADAY, "{\"tickers\":{\"AAA\":{\"dates\":[],\"close\":[]}}}");
        assertThat(marketData.quotes()).isEmpty();
    }

    @Test
    @DisplayName("확정 종가: 거래일이고 마감 + 15분 뒤 수집. 주말 수집의 금요일 봉도 확정")
    void finalCloseRule() {
        assertThat(PaperMarketData.isFinal(MON, MON_INTRADAY)).isFalse();
        assertThat(PaperMarketData.isFinal(MON, Instant.parse("2026-10-26T20:14:59Z"))).isFalse();
        assertThat(PaperMarketData.isFinal(MON, Instant.parse("2026-10-26T20:15:00Z"))).isTrue();
        assertThat(PaperMarketData.isFinal(FRI, PaperFixtures.SAT)).isTrue();
        assertThat(PaperMarketData.isFinal(LocalDate.of(2026, 10, 24), PaperFixtures.SAT)).as("토요일 봉").isFalse();
    }

    @Test
    @DisplayName("사후 체결 종가: 10년 이력이 먼저, 없으면 마감 15분 뒤 수집한 관측치의 그날 봉, 장중 저장본이면 없음")
    void sourcedClose() throws Exception {
        when(repository.readTimeseriesColumns(eq(Datasets.TS_EQUITY_CLOSE), eq(List.of("SPY")), eq(FRI), eq(FRI)))
                .thenReturn(Map.of("SPY", new TimeseriesColumns(new int[]{(int) FRI.toEpochDay()}, new double[]{500})));
        assertThat(marketData.sourcedCloseOn("SPY", FRI)).hasValue(new PaperMarketData.SourcedClose(500, "equity_close"));

        snapshot(MON_FINAL, """
                {"tickers":{"SHY":{"dates":["2026-10-23","2026-10-26"],"close":[82.5,82.6]}}}""");
        assertThat(marketData.sourcedCloseOn("SHY", FRI)).hasValue(new PaperMarketData.SourcedClose(82.5, "paper.quotes"));
        assertThat(marketData.closeOn("SHY", LocalDate.of(2026, 10, 22))).as("다른 날로 대신하지 않음").isNull();

        snapshot(Instant.parse("2026-10-23T18:00:00Z"), """
                {"tickers":{"SHY":{"dates":["2026-10-22","2026-10-23"],"close":[82.4,82.5]}}}""");
        assertThat(marketData.sourcedCloseOn("SHY", FRI)).as("그날 장중에 수집한 봉은 종가가 아님").isEmpty();
    }

    @Test
    @DisplayName("그날이 아직 지금 세션이면 이력(equity_close) 값을 믿지 않고 마감 뒤 관측치로 넘어간다 — 장중에 쓴 이력 행일 수 있음")
    void historyOfCurrentSessionIsNotTrusted() throws Exception {
        // 출발일 14:00 ET에 이력 수집이 돌아 그날 행이 장중가(498)로 남고, 16:20 ET에 초기화한 상황.
        Instant initAt = Instant.parse("2026-10-23T20:20:00Z");
        PaperMarketData sameDay = new PaperMarketData(reader, repository, Clock.fixed(initAt, ZoneOffset.UTC));
        when(repository.readTimeseriesColumns(eq(Datasets.TS_EQUITY_CLOSE), anyCollection(), eq(FRI), eq(FRI)))
                .thenReturn(Map.of("SPY", new TimeseriesColumns(new int[]{(int) FRI.toEpochDay()}, new double[]{498})));
        snapshot(initAt, """
                {"tickers":{"SPY":{"dates":["2026-10-22","2026-10-23"],"close":[495.0,500.0]}}}""");

        assertThat(sameDay.sourcedCloseOn("SPY", FRI)).as("마감 뒤 관측치의 그날 봉")
                .hasValue(new PaperMarketData.SourcedClose(500, "paper.quotes"));

        // 토요일(세션은 아직 금요일)에도 같음, 다음 세션(월요일 개장 뒤)부터는 이력을 믿음.
        PaperMarketData saturday = new PaperMarketData(reader, repository, Clock.fixed(PaperFixtures.SAT, ZoneOffset.UTC));
        assertThat(saturday.sourcedCloseOn("SPY", FRI)).hasValue(new PaperMarketData.SourcedClose(500, "paper.quotes"));
        PaperMarketData monday = new PaperMarketData(reader, repository, Clock.fixed(MON_INTRADAY, ZoneOffset.UTC));
        assertThat(monday.sourcedCloseOn("SPY", FRI)).hasValue(new PaperMarketData.SourcedClose(498, "equity_close"));

        // 장중 관측치뿐이면 아무 값도 없음(이력 행을 대신 쓰지 않음).
        snapshot(Instant.parse("2026-10-23T18:00:00Z"), """
                {"tickers":{"SPY":{"dates":["2026-10-22","2026-10-23"],"close":[495.0,497.0]}}}""");
        assertThat(sameDay.sourcedCloseOn("SPY", FRI)).isEmpty();
    }

    @Test
    @DisplayName("이어 쓴(isStale) 봉의 그날 값은 그 뒤 세션까지 본 봉일 때만 믿는다 — 장중 봉을 이어 썼을 수 있음")
    void staleFrameValueOfSameDayIsNotTrusted() throws Exception {
        snapshot(MON_FINAL, """
                {"tickers":{
                  "AAA":{"dates":["2026-10-23","2026-10-26"],"close":[100.0,101.0],"isStale":true},
                  "BBB":{"dates":["2026-10-22","2026-10-23"],"close":[50.0,51.0],"isStale":true},
                  "CCC":{"dates":["2026-10-23","2026-10-26"],"close":[10.0,11.0]}}}""");

        Map<String, PaperMarketData.SourcedClose> got = marketData.sourcedClosesOn(List.of("AAA", "BBB", "CCC"), FRI);
        assertThat(got).containsOnlyKeys("AAA", "CCC");   // BBB의 금요일 봉은 그날 장중에 받은 값일 수 있음
        assertThat(marketData.sourcedClosesOn(List.of("AAA", "BBB", "CCC"), MON)).containsOnlyKeys("CCC");
    }

    @Test
    @DisplayName("기준일 종가의 시장 판(A6): 그 시장의 이력·관측치 데이터셋과 지금 세션·확정 판정, 출처 글자는 그 시장 데이터셋 이름 — 미국 판은 옛 판과 같음")
    void sourcedClosesPerMarket() throws Exception {
        PaperMarket kr = TestKrMarket.INSTANCE;
        // 지금 = 10-27(화) 21:00 KST — 시험용 한국 달력으로 10-27 세션 마감(15:30) 뒤, 10-26은 지난 세션이라 이력을 믿음
        PaperMarketData krEvening = new PaperMarketData(reader, repository,
                Clock.fixed(Instant.parse("2026-10-27T12:00:00Z"), ZoneOffset.UTC));
        when(repository.readTimeseriesColumns(eq(TestKrMarket.HISTORY_DATASET), anyCollection(), eq(MON), eq(MON)))
                .thenReturn(Map.of("005930", new TimeseriesColumns(new int[]{(int) MON.toEpochDay()},
                        new double[]{71_000})));
        when(reader.read(eq(TestKrMarket.QUOTES_DATASET), anyLong(), eq(TestKrMarket.QUOTES_TASK)))
                .thenReturn(Optional.of(new Snapshot(TestKrMarket.QUOTES_DATASET, MAPPER.readTree("""
                        {"tickers":{"000660":{"dates":["2026-10-26","2026-10-27"],"close":[200000,201000]}}}"""),
                        "json", "ok", null, Instant.parse("2026-10-27T11:00:00Z"))));

        assertThat(krEvening.sourcedClosesOn(kr, List.of("005930", "000660"), MON)).containsOnly(
                Map.entry("005930", new PaperMarketData.SourcedClose(71_000, TestKrMarket.HISTORY_DATASET)),
                Map.entry("000660", new PaperMarketData.SourcedClose(200_000, TestKrMarket.QUOTES_DATASET)));
        assertThat(krEvening.sourcedClosesOn(kr, List.of("000660"), PaperFixtures.TUE))
                .as("그날이 그 시장 지금 세션 — 이력을 보지 않고 마감 뒤 관측치의 그날 봉")
                .containsOnly(Map.entry("000660", new PaperMarketData.SourcedClose(201_000, TestKrMarket.QUOTES_DATASET)));

        when(repository.readTimeseriesColumns(eq(Datasets.TS_EQUITY_CLOSE), eq(List.of("SPY")), eq(FRI), eq(FRI)))
                .thenReturn(Map.of("SPY", new TimeseriesColumns(new int[]{(int) FRI.toEpochDay()}, new double[]{500})));
        assertThat(marketData.sourcedClosesOn(UsPaperMarket.INSTANCE, List.of("SPY"), FRI))
                .isEqualTo(marketData.sourcedClosesOn(List.of("SPY"), FRI))
                .containsOnly(Map.entry("SPY", new PaperMarketData.SourcedClose(500, "equity_close")));
    }

    @Test
    @DisplayName("설정 본문: 범위 밖·없는 키는 그 키만 기본값으로 읽고 어느 키인지 남긴다")
    void settingsFallbacks() throws Exception {
        PaperSettings settings = PaperSettings.from(MAPPER.readTree("""
                {"slippageBp": -3, "trailingStopPct": 12, "lockoutTradingDays": 2.5, "cashLikeTickers": ["shy", "TLT"],
                 "gate": {"us10yStage1": 4.9, "confirmDays": 0}}"""));

        assertThat(settings.slippageBp()).isEqualTo(5);
        assertThat(settings.trailingStopPct()).isEqualTo(12);
        assertThat(settings.lockoutTradingDays()).isEqualTo(20);
        assertThat(settings.cashLikeTickers()).containsExactly("SHY", "TLT");
        assertThat(settings.gate().us10yStage1()).isEqualTo(4.9);
        assertThat(settings.gate().confirmDays()).isEqualTo(3);
        assertThat(settings.fallbacks()).contains("slippageBp", "lockoutTradingDays", "gate.confirmDays", "gate.wtiMax");
        assertThat(PaperSettings.from(null)).isEqualTo(PaperSettings.defaults());
    }
}
