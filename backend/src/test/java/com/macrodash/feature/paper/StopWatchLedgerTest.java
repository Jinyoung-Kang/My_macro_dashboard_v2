package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.ExecutionAuditFixtures.Bars;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.TUE;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.et;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 장중 감시 STOP의 장부 체결(ADR 0032 결정 6) — 미국은 다음 관측치의 시각 지정 체결(2b)·종가 STOP은 확정 종가 관측치, 한국은 그날 밤 1분봉 사다리.
 * 모두 재진입 금지를 걸고, 한국 장중 STOP은 금융위 종가로 다시 판정하지 않으며, 늦은 주문 가드(⑤)를 그대로 씁니다.
 */
class StopWatchLedgerTest {

    private static ObjectNode intradayReason() {
        ObjectNode reason = MAPPER.createObjectNode();
        reason.put("trigger", "TRAILING_STOP").put("stopMode", PaperStopWatchJob.STOP_MODE).put("stopPct", 8.0)
                .put("highWatermark", 100.0).put("stopPrice", 92.0).put("observedPrice", 91.0);
        return reason;
    }

    @Nested
    @DisplayName("미국 — 다음 관측치의 2b(시장가)·확정 종가 관측치(종가 STOP)")
    class Us {

        private static final String BOOK = PaperBooks.RULES;
        private FakePaperStore store;
        private PaperMarketData marketData;
        private PaperCheckpointJobTest.MovableClock clock;
        private PaperLedgerService ledger;

        @BeforeEach
        void setUp() {
            store = new FakePaperStore();
            marketData = mock(PaperMarketData.class);
            when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
            clock = new PaperCheckpointJobTest.MovableClock(et(TUE, 9, 0));
            ledger = new PaperLedgerService(store, marketData, MAPPER, clock);
            activeBook(store, BOOK, PaperBooks.KIND_RULES, 1_000, null);
            store.upsertPosition(new Position(BOOK, "AAPL", 10, 100, MON, et(MON, 16, 20), 100, et(MON, 16, 20), 100.0,
                    et(MON, 16, 20), false, MON, 100, null));
        }

        private long stop(String timing, Instant created) {
            return store.insertOrder(new Order(0, BOOK, null, "AAPL", PaperBooks.SELL, null, null, null, timing,
                    PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, intradayReason(), MON, created, TUE, null));
        }

        private Outcome observe(Instant collectedAt, PaperMarketData.Bar... observed) {
            clock.now = collectedAt.plusSeconds(90);
            return ledger.process(quotes(collectedAt, observed));
        }

        @Test
        @DisplayName("장중 STOP(시장가 T 10:24)은 다음 관측치의 1분봉 T 봉 시가로 팔리고 재진입 금지(E부터 20거래일), 같은 W의 더 늦은 T 매수는 재진입 금지로 취소")
        void marketStopFillsAtTheNextObservationWithLockout() {
            long id = stop(PaperBooks.MARKET, et(TUE, 10, 22).plusSeconds(20));
            long rebuy = store.insertOrder(new Order(0, BOOK, 9L, "AAPL", PaperBooks.BUY, 5, null, null, PaperBooks.MARKET,
                    "CLAUDE", PaperBooks.ORDER_PENDING, null, null, MON, et(TUE, 10, 30).plusSeconds(10), TUE, null));
            when(marketData.barsUs()).thenReturn(Optional.of(new Bars(et(TUE, 11, 21)).market(LocalTime.of(10, 24))
                    .market(LocalTime.of(10, 32)).bar("AAPL", TUE, et(TUE, 10, 24), 91.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 32), 90.0, 500.0).bar("AAPL", TUE, et(TUE, 10, 40), 90.2, 500.0).snapshot()));

            Outcome outcome = observe(et(TUE, 11, 20), bar("AAPL", MON, 100.0, TUE, 90.5));

            Fill fill = store.fillsOf(BOOK).stream().filter(f -> f.orderId() == id).findFirst().orElseThrow();
            assertThat(fill.rawPrice()).isEqualTo(91.0);
            assertThat(fill.qty()).isEqualTo(10);
            assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_FILLED);
            LocalDate until = TrailingStop.lockoutUntil(UsMarketCalendar.CALENDAR, TUE, 20);
            assertThat(store.lockouts(BOOK)).singleElement().satisfies(l -> {
                assertThat(l.ticker()).isEqualTo("AAPL");
                assertThat(l.untilTradingDate()).isEqualTo(until);
                assertThat(l.reason()).contains("장중 감시").contains("92");
            });
            assertThat(store.orders.get(rebuy).status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
            assertThat(store.orders.get(rebuy).rejectReason()).contains("재진입 금지");
            assertThat(outcome.stopped()).isEqualTo(1);
            assertThat(store.positions(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("종가 STOP(15:55 뒤 감지)은 확정 종가 관측치에서 그 종가로 팔리고 재진입 금지")
        void closeStopFillsAtTheFinalObservationWithLockout() {
            long id = stop(PaperBooks.NEXT_CLOSE, et(TUE, 15, 55).plusSeconds(20));

            observe(et(TUE, 16, 0).plusSeconds(-600), bar("AAPL", MON, 100.0, TUE, 93.0));
            assertThat(store.orders.get(id).status()).as("마감 + 15분 전 관측치로는 체결하지 않음").isEqualTo(PaperBooks.ORDER_PENDING);
            Outcome outcome = observe(et(TUE, 16, 20), bar("AAPL", MON, 100.0, TUE, 90.0));

            assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(store.fillsOf(BOOK)).singleElement().satisfies(f -> assertThat(f.rawPrice()).isEqualTo(90.0));
            assertThat(store.lockouts(BOOK)).singleElement().satisfies(l ->
                    assertThat(l.untilTradingDate()).isEqualTo(TrailingStop.lockoutUntil(UsMarketCalendar.CALENDAR, TUE, 20)));
            assertThat(outcome.stopped()).isEqualTo(1);
        }
    }

    @Nested
    @DisplayName("한국 — 그날 밤 1분봉 사다리, 금융위 재판정 없음, 늦은 주문 가드")
    class Kr {

        private static final KrPaperMarket KR = KrPaperMarket.INSTANCE;
        private static final String BOOK = PaperBooks.KR_RULES;
        private static final LocalDate D = LocalDate.of(2026, 11, 2);
        private static final LocalDate D1 = LocalDate.of(2026, 11, 3);
        private static final Instant FETCHED_D1 = kst("2026-11-03T21:57");
        private static final Instant COLLECTED_D1 = kst("2026-11-03T22:01");

        private FakePaperStore store;
        private PaperMarketData marketData;
        private PaperLedgerService ledger;
        private final Map<String, KrConfirmed.Series> confirmed = new HashMap<>();

        private static Instant kst(String dateTime) {
            return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
        }

        @BeforeEach
        void setUp() {
            store = new FakePaperStore();
            store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
            marketData = mock(PaperMarketData.class);
            when(marketData.fscMarkets(anyCollection())).thenReturn(Map.of("005930", "KOSPI"));
            when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenAnswer(invocation -> new KrConfirmed(confirmed));
            ledger = new PaperLedgerService(store, marketData, MAPPER);
            store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_RULES, BOOK, 100_000_000, D, PaperBooks.ACTIVE, kst("2026-11-02T22:30"),
                    "KR", "KRW"));
            store.states.put(BOOK, new BookState(BOOK, 0, 0, 0, 0, null, null, null, null));
            store.upsertPosition(new Position(BOOK, "005930", 10, 100_000, LocalDate.of(2026, 10, 27), kst("2026-11-02T22:30"), 100_000,
                    kst("2026-11-02T22:30"), 100_000.0, kst("2026-11-02T22:30"), false, D, 100_000, null));
            store.updateFillRefVolume(BOOK, "005930", 1_000L);
        }

        private MarketRun run() {
            JsonNode body = store.settings.body();
            return new MarketRun(KR, KR.openCalendar(KrFixtures.inputs(body, KrFixtures.holidays(2026, 2027))), store.settings);
        }

        private long stop(String timing, Instant created, LocalTime at, JsonNode reason) {
            return store.insertOrder(new Order(0, BOOK, null, "005930", PaperBooks.SELL, null, null, null, timing, PaperBooks.SOURCE_STOP,
                    PaperBooks.ORDER_PENDING, null, reason, D, created, D1, null, at));
        }

        private static ObjectNode krReason() {
            ObjectNode reason = intradayReason();
            reason.put("highWatermark", 100_000.0).put("stopPrice", 92_000.0).put("observedPrice", 91_000.0);
            return reason;
        }

        @Test
        @DisplayName("장중 STOP(시장가 T 10:24)은 그날 밤 그 분 창 시가로 팔리고, 금융위 D 종가가 스탑가 위여도 취소하지 않으며(재판정 없음) 재진입 금지는 그날부터")
        void intradayStopFillsAtNightWithoutRejudge() {
            long id = stop(PaperBooks.MARKET, kst("2026-11-03T10:22:20"), null, krReason());
            java.util.TreeMap<LocalDate, KrConfirmed.Day> days = new java.util.TreeMap<>();
            days.put(D, new KrConfirmed.Day(D, BigDecimal.valueOf(95_000), 5_000L, null, null, "KOSPI"));
            confirmed.put("005930", new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, D, days));
            when(marketData.krTimed()).thenReturn(Map.of("005930", Map.of(D1, new KrQuotes.Timed(KrQuotes.TIMED_OK, null,
                    kst("2026-11-03T21:50"), Map.of("10:24", List.of(new KrQuotes.Bar1m("10:25", BigDecimal.valueOf(91_500), 300L))),
                    Map.of(), Map.of()))));
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", FETCHED_D1).bar(D, 100_000, 95_000, 1_000).bar(D1, 99_000, 91_000, 2_000)
                    .minute("OK", "09:01", 99_000, 100);

            Outcome outcome = ledger.process(run(), KrQuotes.parse(payload.snapshot(COLLECTED_D1)).orElseThrow());

            Order order = store.orders.get(id);
            assertThat(order.status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(order.reason().path("stopBasis").asString()).isEqualTo(PaperStopWatchJob.STOP_MODE);
            assertThat(store.fillsOf(BOOK)).singleElement().satisfies(f -> {
                assertThat(f.price()).isEqualTo(91_500.0);
                assertThat(f.priceSource()).isEqualTo(KrTimedLadder.SOURCE_AT);
            });
            TradingCalendar calendar = run().calendar();
            assertThat(store.lockouts(BOOK)).singleElement().satisfies(l -> {
                assertThat(l.untilTradingDate()).isEqualTo(TrailingStop.lockoutUntil(calendar, D1, 20));
                assertThat(l.reason()).contains("장중 감시");
            });
            assertThat(outcome.stopped()).isEqualTo(1);
            assertThat(store.orders.values()).as("팔린 보유에는 밤 감지 STOP을 더 내지 않음")
                    .filteredOn(o -> PaperBooks.SOURCE_STOP.equals(o.source())).hasSize(1);
        }

        @Test
        @DisplayName("늦은 주문 가드(⑤) — 장중 STOP은 기준 시각이 생성보다 앞이면 그날 체결하지 않고, 밤 감지 STOP은 예전처럼 우회")
        void lateOrderGuardAppliesToIntradayStops() {
            TradingCalendar calendar = run().calendar();
            Order intraday = new Order(1, BOOK, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.AT_MINUTE, PaperBooks.SOURCE_STOP,
                    PaperBooks.ORDER_PENDING, null, krReason(), D, kst("2026-11-03T09:30"), D1, null, LocalTime.of(9, 10));
            assertThat(KrFills.opensAfterOrder(intraday, D1, calendar)).isFalse();
            Order night = new Order(2, BOOK, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.AT_MINUTE, PaperBooks.SOURCE_STOP,
                    PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode().put("trigger", "TRAILING_STOP"), D, kst("2026-11-03T09:30"), D1,
                    null, LocalTime.of(9, 10));
            assertThat(KrFills.opensAfterOrder(night, D1, calendar)).isTrue();
            Order onTime = new Order(3, BOOK, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                    PaperBooks.ORDER_PENDING, null, krReason(), D, kst("2026-11-03T10:22:20"), D1, null);
            assertThat(KrFills.opensAfterOrder(onTime, D1, calendar)).isTrue();
            assertThat(StopWatch.intradayStop(intraday)).isTrue();
            assertThat(StopWatch.intradayStop(night)).isFalse();
        }
    }
}
