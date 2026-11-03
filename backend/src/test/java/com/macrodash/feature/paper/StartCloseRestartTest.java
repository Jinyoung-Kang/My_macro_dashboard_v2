package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCosts;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.feature.paper.PaperMarketData.SourcedClose;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 출발일 종가로 다시 출발({@link StartCloseRestart} — 사용자 결정 2026-11-02): 출발 주문을 취소하고 같은 종목·비중을 출발일 종가로 사후 체결(미국 종가 ×
 * 슬리피지, 한국 금융위 확정 종가 + 비용 칸), 관측치 처리 기억은 그대로, 종가가 하나라도 없거나 체결이 이미 있거나 확인 문구가 다르면 아무것도 바꾸지 않음.
 */
class StartCloseRestartTest {

    /** 한국 출발일(금)·그 마감(15:30 KST)·그 밤 관측치 수집 시각. */
    private static final LocalDate KR_START = LocalDate.of(2026, 10, 30);
    private static final Instant KR_CLOSE = kst("2026-10-30T15:30");
    private static final Instant KR_NIGHT = kst("2026-10-30T21:05");

    private FakePaperStore store;
    private PaperMarketData marketData;
    private StoreReader reader;
    private StartCloseRestart restart;

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), com.macrodash.analytics.KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        when(marketData.sourcedCloseOn(anyString(), any())).thenReturn(Optional.empty());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, MAPPER);
        restart = new StartCloseRestart(store, marketData, reader, ledger, MAPPER, new PaperMarkets(store, reader));
    }

    // ------------------------------------------------------------------ 미국
    private long usBook(String code) {
        store.insertBookIfAbsent(new Book(code, PaperBooks.KIND_CLAUDE, "Claude 계좌2", 100_000, FRI, PaperBooks.ACTIVE, null));
        store.upsertState(new BookState(code, 100_000, 100_000, 0, 0, MON_INTRADAY, MON_INTRADAY, FRI, null));
        long decision = decision(code, FRI);
        order(code, decision, "XLV", 8.0, PaperBooks.AT_1000, FRI);
        order(code, decision, "XLE", 7.0, PaperBooks.AT_1000, FRI);
        return decision;
    }

    private long decision(String code, LocalDate asOf) {
        return store.insertDecisionIfAbsent(new Decision(0, code, asOf, RuleBookService.INITIAL, null, "OK", "claude-test", 5,
                1, null, 15.0, null, null, null, MAPPER.createObjectNode(), null, null, null, true, null, 0)).orElseThrow();
    }

    private long order(String code, long decision, String ticker, double weight, String timing, LocalDate asOf) {
        ObjectNode reason = MAPPER.createObjectNode().put("thesis", ticker + " 근거");
        return store.insertOrder(new Order(0, code, decision, ticker, PaperBooks.BUY, null, weight, null, timing,
                PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null, reason, asOf, MON_INTRADAY.minusSeconds(3600),
                asOf.plusDays(3), null));
    }

    @Test
    @DisplayName("미국 계좌2: 출발 주문(AT_1000)을 취소하고 같은 비중을 출발일 종가 × 1.0005로 사후 체결, 관측치 처리 기억은 그대로")
    void usClaude2() {
        long decision = usBook(PaperBooks.CLAUDE2);
        when(marketData.sourcedCloseOn("XLV", FRI)).thenReturn(Optional.of(new SourcedClose(150, "equity_close")));
        when(marketData.sourcedCloseOn("XLE", FRI)).thenReturn(Optional.of(new SourcedClose(90, "paper.quotes")));

        StartCloseRestart.Result result = restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2);

        assertThat(result.startDate()).isEqualTo(FRI);
        assertThat(result.cancelled()).hasSize(2);
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).filteredOn(o -> PaperBooks.AT_1000.equals(o.timing()))
                .allSatisfy(o -> {
                    assertThat(o.status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
                    assertThat(o.rejectReason()).isEqualTo(StartCloseRestart.CANCEL_REASON);
                });
        // 8,000 ÷ 150.075 = 53.3 → 53주, 7,000 ÷ 90.045 = 77.7 → 77주
        List<Fill> fills = store.fillsOf(PaperBooks.CLAUDE2);
        assertThat(fills).extracting(Fill::ticker, Fill::qty, Fill::price, Fill::rawPrice, Fill::backfill, Fill::observedAt)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("XLV", 53, 150.075, 150.0, true, FRI_CLOSE),
                        org.assertj.core.groups.Tuple.tuple("XLE", 77, 90.045, 90.0, true, FRI_CLOSE));
        List<Order> backfilled = store.ordersOf(PaperBooks.CLAUDE2).stream()
                .filter(o -> PaperBooks.BACKFILL.equals(o.timing())).toList();
        assertThat(backfilled).hasSize(2).allSatisfy(o -> {
            assertThat(o.decisionId()).isEqualTo(decision);
            assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(o.source()).isEqualTo(PacketBuilder.SOURCE_CLAUDE);
            assertThat(o.reason().path(StartCloseRestart.REASON_KEY).path("originalTiming").asString()).isEqualTo("AT_1000");
            assertThat(o.reason().path("thesis").asString()).endsWith("근거");
        });
        BookState state = store.states.get(PaperBooks.CLAUDE2);
        double cash = PaperLedger.round4(100_000 - 53 * 150.075 - 77 * 90.045);
        assertThat(state.cash()).isEqualTo(cash);
        assertThat(state.nav()).isEqualTo(PaperLedger.round4(cash + 53 * 150 + 77 * 90));
        assertThat(state.lastProcessedCollectedAt()).as("이미 처리한 관측치를 다시 처리하지 않음").isEqualTo(MON_INTRADAY);
        assertThat(state.lastNavTradingDate()).isEqualTo(FRI);
        assertThat(store.navSeries(PaperBooks.CLAUDE2)).singleElement().satisfies(row -> {
            assertThat(row.tradingDate()).isEqualTo(FRI);
            assertThat(row.pricesFinal()).isTrue();
        });
        assertThat(store.books.get(PaperBooks.CLAUDE2).status()).isEqualTo(PaperBooks.ACTIVE);
        assertThat(store.books.get(PaperBooks.CLAUDE2).startedOn()).isEqualTo(FRI);
    }

    @Test
    @DisplayName("종가가 하나라도 없거나·확인 문구가 다르거나·이미 체결이 있으면 거절하고 아무것도 바꾸지 않는다")
    void refusals() {
        usBook(PaperBooks.CLAUDE2);
        when(marketData.sourcedCloseOn("XLV", FRI)).thenReturn(Optional.of(new SourcedClose(150, "equity_close")));

        assertThatThrownBy(() -> restart.restart(PaperBooks.CLAUDE2, "claude")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("XLE 종가가 없습니다");
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).allSatisfy(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING));
        assertThat(store.fillsOf(PaperBooks.CLAUDE2)).isEmpty();

        when(marketData.sourcedCloseOn("XLE", FRI)).thenReturn(Optional.of(new SourcedClose(90, "equity_close")));
        restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2);
        assertThatThrownBy(() -> restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("이미 체결");
    }

    @Test
    @org.junit.jupiter.api.Disabled("QA-177 재현 — 수정 전: 잠금 밖에서 본 '체결 없음·대기 2건'으로 취소해 FILLED를 CANCELLED로 덮고 XLV를 한 번 더 삼")
    @DisplayName("QA-177: 잠금 밖에서 대기 주문을 읽은 뒤 겹친 리스크 점검이 출발 주문 하나를 체결했으면 거절하고 아무것도 바꾸지 않는다")
    void refusesWhenFilledMeanwhile() {
        usBook(PaperBooks.CLAUDE2);
        long xlv = store.ordersOf(PaperBooks.CLAUDE2).stream().filter(o -> o.ticker().equals("XLV")).findFirst()
                .orElseThrow().id();
        Instant filledAt = Instant.parse("2026-10-26T14:05:00Z");   // 월 10:05 ET — AT_1000 체결
        when(marketData.sourcedCloseOn("XLV", FRI)).thenReturn(Optional.of(new SourcedClose(150, "equity_close")));
        // XLE 종가 읽기는 대기 주문을 읽은 뒤·장부 잠금 앞 — 그 사이 리스크 점검이 XLV를 체결해 커밋한 것처럼.
        when(marketData.sourcedCloseOn("XLE", FRI)).thenAnswer(invocation -> {
            store.markOrderFilled(xlv, filledAt);
            store.insertFill(new Fill(0, xlv, PaperBooks.CLAUDE2, "XLV", PaperBooks.BUY, 53, 151.0755, 151.0, 5,
                    PaperLedger.round4(53 * 151.0755), filledAt, PaperFixtures.MON, "paper.bars", false, null,
                    BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO));
            store.upsertPosition(new Position(PaperBooks.CLAUDE2, "XLV", 53, 151.0755, PaperFixtures.MON, filledAt,
                    151.0755, filledAt, 151.0, filledAt, false, PaperFixtures.MON, 151.0, null));
            store.upsertState(new BookState(PaperBooks.CLAUDE2, PaperLedger.round4(100_000 - 53 * 151.0755), 99_996.0,
                    53 * 151.0, 8.0, filledAt, filledAt, FRI, null));
            return Optional.of(new SourcedClose(90, "equity_close"));
        });

        assertThatThrownBy(() -> restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class);

        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).filteredOn(o -> o.id() == xlv).singleElement()
                .satisfies(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED));
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).filteredOn(o -> o.ticker().equals("XLE")).singleElement()
                .satisfies(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING));
        assertThat(store.fillsOf(PaperBooks.CLAUDE2)).as("겹친 체결 하나 그대로").hasSize(1);
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).noneMatch(o -> PaperBooks.BACKFILL.equals(o.timing()));
        assertThat(store.navSeries(PaperBooks.CLAUDE2)).as("출발일 확정 순자산 줄을 쓰지 않음").isEmpty();
    }

    @Test
    @org.junit.jupiter.api.Disabled("QA-177 재현 — 수정 전: 거의 동시에 온 두 번째 요청이 이미 끝난 다시 출발 위에 한 번 더 사후 체결(XLV·XLE 두 번)")
    @DisplayName("QA-177: 같은 요청이 거의 동시에 두 번 오면 잠금을 늦게 얻은 쪽은 거절한다 — 사후 체결은 한 번")
    void refusesDuplicateRestart() {
        usBook(PaperBooks.CLAUDE2);
        when(marketData.sourcedCloseOn("XLV", FRI)).thenReturn(Optional.of(new SourcedClose(150, "equity_close")));
        boolean[] first = {true};
        // 바깥 요청이 대기 주문을 읽은 뒤·잠금 앞에서, 다른 요청이 처음부터 끝까지 다시 출발을 마친 것처럼.
        when(marketData.sourcedCloseOn("XLE", FRI)).thenAnswer(invocation -> {
            if (first[0]) {
                first[0] = false;
                restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2);
            }
            return Optional.of(new SourcedClose(90, "equity_close"));
        });

        assertThatThrownBy(() -> restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class);

        assertThat(store.fillsOf(PaperBooks.CLAUDE2)).as("먼저 끝난 다시 출발의 두 건만").hasSize(2);
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).filteredOn(o -> PaperBooks.BACKFILL.equals(o.timing())).hasSize(2);
    }

    @Test
    @DisplayName("출발 결정이 아닌 대기 주문(정기 결정의 주문)이 섞였으면 거절한다")
    void onlyStartOrders() {
        long start = usBook(PaperBooks.CLAUDE2);
        long scheduled = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE2, FRI.plusDays(3),
                RuleBookService.SCHEDULED, null, "OK", "claude-test", 5, 1, null, 15.0, null, null, null,
                MAPPER.createObjectNode(), null, null, null, true, null, 0)).orElseThrow();
        assertThat(scheduled).isNotEqualTo(start);
        order(PaperBooks.CLAUDE2, scheduled, "CB", 5.0, PaperBooks.AT_1000, FRI.plusDays(3));

        assertThatThrownBy(() -> restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("출발 결정의 매수 주문이 아닙니다");
    }

    // ------------------------------------------------------------------ 한국
    private void krBook(String code) {
        store.insertBookIfAbsent(new Book(code, PaperBooks.KIND_CLAUDE, "한국 Claude 계좌", 100_000_000, KR_START,
                PaperBooks.ACTIVE, null, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.upsertState(new BookState(code, 100_000_000, 100_000_000, 0, 0, KR_NIGHT, KR_NIGHT, KR_START, null));
        long decision = decision(code, KR_START);
        order(code, decision, "005930", 5.0, PaperBooks.NEXT_OPEN, KR_START);
        order(code, decision, "153130", 30.0, PaperBooks.NEXT_OPEN, KR_START);
    }

    private void confirmed(Map<String, KrConfirmed.Series> series) {
        when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenReturn(new KrConfirmed(series));
    }

    private static KrConfirmed.Series series(String source, BigDecimal close, long volume, String market) {
        TreeMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
        days.put(KR_START, new KrConfirmed.Day(KR_START, close, volume, null, close, market));
        return new KrConfirmed.Series(source, KR_START, days);
    }

    @Test
    @DisplayName("한국: 금융위 확정 종가로 체결(체결가 = 확정 종가, 수수료·슬리피지는 비용 칸, 세금 없음), 확정 순자산 줄, 처리 기억 그대로")
    void krClaude() {
        krBook(PaperBooks.KR_CLAUDE);
        confirmed(Map.of("005930", series(KrConfirmed.SOURCE_FSC, new BigDecimal("70000"), 1_000_000, "KOSPI"),
                "153130", series(KrConfirmed.SOURCE_FSC_ETF, new BigDecimal("108500"), 20_000, null)));

        StartCloseRestart.Result result = restart.restart(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE);

        PaperSettings settings = new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE).settings();
        KrxCosts.Rates rates = settings.costRates().rates(settings.slippageBp());
        int stockQty = KrxCosts.affordableQty(BigDecimal.valueOf(5_000_000.0), new BigDecimal("70000"), rates);
        KrxCosts.Costs stock = KrxCosts.fill(PaperLedger.Side.BUY, KrxCosts.Instrument.KOSPI, KR_START, stockQty,
                new BigDecimal("70000"), rates);
        int etfQty = KrxCosts.affordableQty(BigDecimal.valueOf(30_000_000.0), new BigDecimal("108500"), rates);
        KrxCosts.Costs etf = KrxCosts.fill(PaperLedger.Side.BUY, KrxCosts.Instrument.ETF, KR_START, etfQty,
                new BigDecimal("108500"), rates);

        assertThat(result.cancelled()).hasSize(2);
        assertThat(result.skipped()).isEmpty();
        assertThat(store.fillsOf(PaperBooks.KR_CLAUDE)).extracting(Fill::ticker, Fill::qty, Fill::price, Fill::priceSource,
                        Fill::backfill, Fill::observedAt, Fill::observationDate)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("005930", stockQty, 70000.0, "FSC", true, KR_CLOSE, KR_START),
                        org.assertj.core.groups.Tuple.tuple("153130", etfQty, 108500.0, "FSC_ETF", true, KR_CLOSE, KR_START));
        Fill first = store.fillsOf(PaperBooks.KR_CLAUDE).get(0);
        assertThat(first.fee()).isEqualByComparingTo(stock.commission());
        assertThat(first.slippageCost()).isEqualByComparingTo(stock.slippage());
        assertThat(first.tax()).isEqualByComparingTo(BigDecimal.ZERO);
        double cash = PaperLedger.round4(PaperLedger.round4(100_000_000 + stock.cashFlow().doubleValue()) + etf.cashFlow().doubleValue());
        BookState state = store.states.get(PaperBooks.KR_CLAUDE);
        assertThat(state.cash()).isEqualTo(cash);
        assertThat(state.nav()).isEqualTo(PaperLedger.round4(cash + stockQty * 70000.0 + etfQty * 108500.0));
        assertThat(state.lastProcessedCollectedAt()).isEqualTo(KR_NIGHT);
        Position position = store.positions(PaperBooks.KR_CLAUDE).stream().filter(p -> p.ticker().equals("005930"))
                .findFirst().orElseThrow();
        assertThat(position.avgCost()).as("평단은 체결가로만(비용은 비용 칸)").isEqualTo(70000.0);
        assertThat(position.fillRefDate()).isEqualTo(KR_START);
        assertThat(position.fillRefClose()).isEqualTo(70000.0);
        NavRow nav = store.navSeries(PaperBooks.KR_CLAUDE).get(0);
        assertThat(nav.tradingDate()).isEqualTo(KR_START);
        assertThat(nav.pricesFinal()).isTrue();
        assertThat(store.ordersOf(PaperBooks.KR_CLAUDE)).filteredOn(o -> PaperBooks.BACKFILL.equals(o.timing()))
                .extracting(Order::asOfTradingDate).containsOnly(LocalDate.of(2026, 10, 29));
    }

    /** 지금 한국 관측치 저장본 — 종목마다 출발일 봉 하나(종가·거래량·봉 출처). */
    private void tossBars(Map<String, KrQuotes.Day> days) {
        Map<String, PaperMarketData.Bar> bars = new java.util.LinkedHashMap<>();
        days.forEach((code, day) -> bars.put(code, new PaperMarketData.Bar(code, day.date(),
                day.close() == null ? 0 : day.close().doubleValue(), false, null,
                new KrQuotes.Quote(code, KR_NIGHT, null, true, false, List.of(day), null, null))));
        when(marketData.quotes(any(PaperMarket.class))).thenReturn(Optional.of(
                new PaperMarketData.Quotes(KR_NIGHT, bars, KR_START, java.util.Set.of())));
    }

    private static KrQuotes.Day tossDay(String close, long volume, String source) {
        return new KrQuotes.Day(KR_START, new BigDecimal(close), new BigDecimal(close), volume, source, null, null);
    }

    @Test
    @DisplayName("한국 토스 종가(사용자 결정 2026-11-02): 금융위 행 없이 관측치 저장본의 출발일 봉 종가로 체결(행 출처 = 봉 출처), 비용 종목 구분은 최신 금융위 시장 구분, 출발일 순자산 줄은 확정 아님")
    void krTossClose() {
        krBook(PaperBooks.KR_CLAUDE2);
        confirmed(Map.of());
        tossBars(Map.of("005930", tossDay("70100", 1_000_000, KrQuotes.SOURCE_INTEGRATED),
                "153130", tossDay("108500", 20_000, KrQuotes.SOURCE_DAILY)));
        when(marketData.fscMarkets(anyCollection())).thenReturn(Map.of("005930", "KOSPI"));

        StartCloseRestart.Result result = restart.restart(PaperBooks.KR_CLAUDE2, PaperBooks.KR_CLAUDE2, StartCloseRestart.SOURCE_TOSS);

        PaperSettings settings = new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE).settings();
        KrxCosts.Rates rates = settings.costRates().rates(settings.slippageBp());
        int stockQty = KrxCosts.affordableQty(BigDecimal.valueOf(5_000_000.0), new BigDecimal("70100"), rates);
        KrxCosts.Costs stock = KrxCosts.fill(PaperLedger.Side.BUY, KrxCosts.Instrument.KOSPI, KR_START, stockQty,
                new BigDecimal("70100"), rates);
        assertThat(result.skipped()).isEmpty();
        assertThat(store.fillsOf(PaperBooks.KR_CLAUDE2)).extracting(Fill::ticker, Fill::price, Fill::priceSource, Fill::backfill)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("005930", 70100.0, KrQuotes.SOURCE_INTEGRATED, true),
                        org.assertj.core.groups.Tuple.tuple("153130", 108500.0, KrQuotes.SOURCE_DAILY, true));
        assertThat(store.fillsOf(PaperBooks.KR_CLAUDE2).get(0).fee()).isEqualByComparingTo(stock.commission());
        assertThat(store.navSeries(PaperBooks.KR_CLAUDE2).get(0).pricesFinal()).as("토스 잠정가 — 확정 아님").isFalse();
        assertThat(store.states.get(PaperBooks.KR_CLAUDE2).lastProcessedCollectedAt()).isEqualTo(KR_NIGHT);
    }

    @Test
    @DisplayName("한국 토스 종가: 출발일 봉이 없거나 거래량 0이면·종목 구분을 모르면 거절, 모르는 출처·미국 계좌의 출처도 거절 — 아무것도 바꾸지 않음")
    void krTossRefusals() {
        krBook(PaperBooks.KR_CLAUDE);
        tossBars(Map.of("005930", tossDay("70100", 0, KrQuotes.SOURCE_INTEGRATED),
                "153130", tossDay("108500", 20_000, KrQuotes.SOURCE_DAILY)));
        when(marketData.fscMarkets(anyCollection())).thenReturn(Map.of("005930", "KOSPI"));
        assertThatThrownBy(() -> restart.restart(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE, StartCloseRestart.SOURCE_TOSS))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("005930 토스 종가가 한국 관측치 저장본에 없습니다");

        tossBars(Map.of("005930", tossDay("70100", 10, KrQuotes.SOURCE_INTEGRATED),
                "153130", tossDay("108500", 20_000, KrQuotes.SOURCE_DAILY)));
        when(marketData.fscMarkets(anyCollection())).thenReturn(Map.of());
        assertThatThrownBy(() -> restart.restart(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE, StartCloseRestart.SOURCE_TOSS))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("종목 구분을 모릅니다");
        assertThatThrownBy(() -> restart.restart(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE, "NAVER"))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("가격 출처");
        assertThat(store.fillsOf(PaperBooks.KR_CLAUDE)).isEmpty();
        assertThat(store.ordersOf(PaperBooks.KR_CLAUDE)).allSatisfy(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING));

        usBook(PaperBooks.CLAUDE2);
        assertThatThrownBy(() -> restart.restart(PaperBooks.CLAUDE2, PaperBooks.CLAUDE2, StartCloseRestart.SOURCE_TOSS))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("가격 출처는 한국 계좌만");
    }

    @Test
    @DisplayName("한국: 그날 금융위 행이 없거나 거래량 0이면·종목 구분을 모르면 거절(짐작하지 않음)")
    void krRefusals() {
        krBook(PaperBooks.KR_CLAUDE);
        confirmed(Map.of("005930", series(KrConfirmed.SOURCE_FSC, new BigDecimal("70000"), 0, "KOSPI"),
                "153130", series(KrConfirmed.SOURCE_FSC_ETF, new BigDecimal("108500"), 20_000, null)));
        assertThatThrownBy(() -> restart.restart(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("005930 금융위 확정 종가가 아직 없습니다");

        confirmed(Map.of("005930", series(KrConfirmed.SOURCE_FSC, new BigDecimal("70000"), 10, "KONEX?"),
                "153130", series(KrConfirmed.SOURCE_FSC_ETF, new BigDecimal("108500"), 20_000, null)));
        assertThatThrownBy(() -> restart.restart(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("종목 구분을 모릅니다");
        assertThat(store.fillsOf(PaperBooks.KR_CLAUDE)).isEmpty();
        assertThat(store.ordersOf(PaperBooks.KR_CLAUDE)).allSatisfy(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING));
    }
}
