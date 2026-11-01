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
