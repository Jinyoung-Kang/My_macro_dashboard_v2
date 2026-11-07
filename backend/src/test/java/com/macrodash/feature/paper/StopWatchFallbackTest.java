package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
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
 * 감시가 덮지 못한 종목의 대체 스탑(ADR 0032 결정 7) — 감시가 ON인 시장에서만: 미국 시간별 스탑은 감시가 지켜본 종목을 건너뛰고(덮지 못한 종목은 예전처럼
 * 즉시 스탑 + {@code stopMode HOURLY_FALLBACK}), 한국 밤 스탑은 지켜본 종목을 건너뛰며 덮지 못한 종목은 다음 거래일 첫 분(09:10, 수능일 10:10) 지정 시각으로
 * 냅니다. OFF·SHADOW는 예전 그대로이고, 대기 STOP이 있는 종목은 어느 스위치에서든 시간별 스탑이 보지 않습니다.
 */
class StopWatchFallbackTest {

    @Nested
    @DisplayName("미국 — 시간별 스탑")
    class Us {

        private static final String BOOK = PaperBooks.RULES;
        private FakePaperStore store;
        private PaperMarketData marketData;
        private PaperLedgerService ledger;

        @BeforeEach
        void setUp() {
            store = new FakePaperStore();
            marketData = mock(PaperMarketData.class);
            when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
            ledger = new PaperLedgerService(store, marketData, MAPPER, new PaperCheckpointJobTest.MovableClock(et(TUE, 11, 2)));
            activeBook(store, BOOK, PaperBooks.KIND_RULES, 1_000, null);
            store.upsertPosition(new Position(BOOK, "AAA", 10, 95, MON, et(MON, 16, 20), 100, et(MON, 16, 20), 100.0, et(MON, 16, 20),
                    false, MON, 100, null));
        }

        private void mode(String value) {
            ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
            ((ObjectNode) body.get("stopWatch")).put("mode", value);
            store.initSettingsIfAbsent(body);
        }

        /** AAA를 09:30~10:59 ET(봉 시작) 지켜본 감시 저장본. */
        private void watched(String ticker) {
            Map<Instant, Double> bars = new LinkedHashMap<>();
            for (Instant at = et(TUE, 9, 30); !at.isAfter(et(TUE, 10, 59)); at = at.plus(Duration.ofMinutes(1))) {
                bars.put(at, 99.0);
            }
            ObjectNode payload = MAPPER.createObjectNode();
            payload.put("fetchedAt", et(TUE, 11, 0).plusSeconds(20).toString());
            payload.putObject("tickers").set(ticker, StopWatchTest.usEntry(TUE, bars, 99.0, 100.0));
            when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok",
                    null, et(TUE, 11, 0).plusSeconds(21))));
        }

        /** {@code ticker}를 09:30부터 {@code until}(봉 시작)까지 99로 지켜본 감시 저장본 — 받은 시각 {@code fetchedAt}, Yahoo 전일 종가 {@code prevClose}. */
        private void watchedUntil(String ticker, Instant until, Instant fetchedAt, double prevClose) {
            Map<Instant, Double> bars = new LinkedHashMap<>();
            for (Instant at = et(TUE, 9, 30); !at.isAfter(until); at = at.plus(Duration.ofMinutes(1))) {
                bars.put(at, 99.0);
            }
            ObjectNode payload = MAPPER.createObjectNode();
            payload.put("fetchedAt", fetchedAt.toString());
            payload.putObject("tickers").set(ticker, StopWatchTest.usEntry(TUE, bars, 99.0, prevClose));
            when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok",
                    null, fetchedAt.plusSeconds(1))));
        }

        /** 16:15 ET 확정 종가 관측치(그날 종가 90 ≤ 스탑가 92)를 16:17 시계의 장부로 처리합니다. */
        private Outcome closeObservation() {
            PaperLedgerService closing = new PaperLedgerService(store, marketData, MAPPER,
                    new PaperCheckpointJobTest.MovableClock(et(TUE, 16, 17)));
            return closing.process(quotes(et(TUE, 16, 15), bar("AAA", MON, 100.0, TUE, 90.0)));
        }

        private List<Order> stops() {
            return store.orders.values().stream().filter(o -> PaperBooks.SOURCE_STOP.equals(o.source())).toList();
        }

        @Test
        @Disabled("QA-305 재현 — 수정 전에는 16:15 관측치가 기준일을 그날로 옮긴 뒤 덮음 판정이 장부 전일 종가 없이 가드를 봐 불일치 가드가 빠지고, 덮음으로 종가 스탑을 건너뜀. fix(QA-305)에서 켭니다")
        @DisplayName("ON — 감시가 하루 종일 갭 가드로 뺀 종목(Yahoo 전일 종가 103 ≠ 장부 전일 종가 100)은 16:15 확정 종가 관측치에서도 덮지 않아 종가 스탑(QA-305)")
        void guardedTickerKeepsTheCloseFallback() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 103.0);

            closeObservation();

            assertThat(stops()).as("관측치 처리가 기준일을 그날로 옮긴 뒤에도 감시 작업이 본 기준값(월 종가 100)으로 가드를 판정")
                    .singleElement().satisfies(o -> {
                        assertThat(o.timing()).isEqualTo(PaperBooks.IMMEDIATE);
                        assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
                        assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK);
                    });
        }

        @Test
        @DisplayName("ON — 가드를 통과해 15:55 격자까지 지켜본 종목은 16:15 확정 종가 관측치에서 감시에 맡김(대조)")
        void watchedTickerIsLeftToTheWatchAtTheClose() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);

            Outcome outcome = closeObservation();

            assertThat(stops()).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("장중 감시에 맡김"));
        }

        @Test
        @DisplayName("ON — 감시가 지켜본 종목은 시간별 표본 한 번으로 팔지 않고 감시에 맡김")
        void coveredTickerIsLeftToTheWatch() {
            mode("ON");
            watched("AAA");

            Outcome outcome = ledger.process(quotes(et(TUE, 11, 0), bar("AAA", MON, 100.0, TUE, 90.0)));

            assertThat(stops()).isEmpty();
            assertThat(store.positions(BOOK)).singleElement().satisfies(p -> assertThat(p.qty()).isEqualTo(10));
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("장중 감시에 맡김"));
        }

        @Test
        @DisplayName("ON — 감시가 덮지 못한 종목은 예전처럼 그 관측가로 즉시 스탑, 근거에 stopMode HOURLY_FALLBACK")
        void uncoveredTickerKeepsTheHourlyStop() {
            mode("ON");
            watched("BBB");

            ledger.process(quotes(et(TUE, 11, 0), bar("AAA", MON, 100.0, TUE, 90.0)));

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.IMMEDIATE);
                assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK);
            });
            assertThat(store.lockouts(BOOK)).hasSize(1);
        }

        @Test
        @DisplayName("OFF·SHADOW — 감시 저장본이 있어도 예전 그대로(근거에 stopMode 없음)")
        void offAndShadowKeepTheOldPath() {
            mode("SHADOW");
            watched("AAA");

            ledger.process(quotes(et(TUE, 11, 0), bar("AAA", MON, 100.0, TUE, 90.0)));

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.IMMEDIATE);
                assertThat(o.reason().has("stopMode")).isFalse();
            });
        }

        @Test
        @DisplayName("대기 STOP(장중 감시의 종가 STOP)이 있는 종목은 스위치와 상관없이 시간별 스탑이 보지 않음 — 같은 보유를 두 번 팔지 않게")
        void pendingStopIsNotDoubled() {
            ObjectNode reason = MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE);
            store.insertOrder(new Order(0, BOOK, null, "AAA", PaperBooks.SELL, null, null, null, PaperBooks.NEXT_CLOSE, PaperBooks.SOURCE_STOP,
                    PaperBooks.ORDER_PENDING, null, reason, MON, et(TUE, 10, 55), TUE, null));

            Outcome outcome = ledger.process(quotes(et(TUE, 11, 0), bar("AAA", MON, 100.0, TUE, 90.0)));

            assertThat(stops()).singleElement().satisfies(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING));
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("대기 STOP이 이미 있음"));
        }
    }

    @Nested
    @DisplayName("한국 — 밤 스탑")
    class Kr {

        private static final KrPaperMarket KR = KrPaperMarket.INSTANCE;
        private static final String BOOK = PaperBooks.KR_RULES;
        private static final LocalDate D = LocalDate.of(2026, 11, 2);
        private static final LocalDate D1 = LocalDate.of(2026, 11, 3);
        private static final LocalDate D2 = LocalDate.of(2026, 11, 4);
        private static final Instant FETCHED_D1 = kst("2026-11-03T21:57");
        private static final Instant COLLECTED_D1 = kst("2026-11-03T22:01");

        private FakePaperStore store;
        private PaperMarketData marketData;
        private PaperLedgerService ledger;

        private static Instant kst(String dateTime) {
            return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
        }

        @BeforeEach
        void setUp() {
            store = new FakePaperStore();
            marketData = mock(PaperMarketData.class);
            when(marketData.fscMarkets(anyCollection())).thenReturn(Map.of("005930", "KOSPI"));
            when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenReturn(KrConfirmed.NONE);
            ledger = new PaperLedgerService(store, marketData, MAPPER);
            store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_RULES, BOOK, 100_000_000, D, PaperBooks.ACTIVE, kst("2026-11-02T22:30"),
                    "KR", "KRW"));
            store.states.put(BOOK, new BookState(BOOK, 0, 0, 0, 0, null, null, null, null));
            store.upsertPosition(new Position(BOOK, "005930", 10, 100_000, LocalDate.of(2026, 10, 27), kst("2026-11-02T22:30"), 100_000,
                    kst("2026-11-02T22:30"), 100_000.0, kst("2026-11-02T22:30"), false, D, 100_000, null));
            store.updateFillRefVolume(BOOK, "005930", 1_000L);
        }

        private void mode(String value, String overrideDay) {
            ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
            ObjectNode kr = (ObjectNode) body.get("kr");
            ((ObjectNode) kr.get("stopWatch")).put("mode", value);
            if (overrideDay != null) {
                ((ObjectNode) kr.get("calendar")).putObject("openTimeOverrides").putObject(overrideDay).put("open", "10:00").put("close", "16:30");
            }
            store.initSettingsIfAbsent(body);
        }

        private MarketRun run() {
            JsonNode body = store.settings.body();
            return new MarketRun(KR, KR.openCalendar(KrFixtures.inputs(body, KrFixtures.holidays(2026, 2027))), store.settings);
        }

        /** D1 세션을 15:15까지 지켜본 감시 저장본(갭 가드 통과). */
        private void watched(String code) {
            Map<String, Double> bars = new LinkedHashMap<>();
            bars.put("15:05", 93_000.0);
            bars.put("15:15", 93_000.0);
            ObjectNode entry = StopWatchTest.krEntry(D1, bars, List.of(), 99_000.0, 100_000.0, 100_000.0);
            ObjectNode payload = MAPPER.createObjectNode();
            payload.put("fetchedAt", kst("2026-11-03T15:20:20").toString());
            payload.putObject("tickers").set(code, entry);
            when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok",
                    null, kst("2026-11-03T15:20:21"))));
        }

        private Outcome nightD1(double close) {
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 99_000, close, 2_000).minute("OK", "09:01", 99_000, 100);
            return ledger.process(run(), KrQuotes.parse(payload.snapshot(COLLECTED_D1)).orElseThrow());
        }

        private List<Order> stops() {
            return store.orders.values().stream().filter(o -> PaperBooks.SOURCE_STOP.equals(o.source())).toList();
        }

        @Test
        @DisplayName("ON — 감시가 그 세션을 지켜본 종목은 밤 잠정 종가 한 번으로 내지 않음")
        void coveredTickerIsLeftToTheWatch() {
            mode("ON", null);
            watched("005930");

            Outcome outcome = nightD1(91_000);

            assertThat(stops()).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("밤 스탑을 장중 감시에 맡김"));
        }

        @Test
        @DisplayName("ON — 덮지 못한 종목은 다음 거래일 첫 분 09:10 지정 시각 STOP(NIGHT_FALLBACK, 재판정 근거는 그대로)")
        void uncoveredTickerStopsAtTheNextFirstMinute() {
            mode("ON", null);
            watched("000660");

            nightD1(91_000);

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.AT_MINUTE);
                assertThat(o.targetLocal()).isEqualTo(LocalTime.of(9, 10));
                assertThat(o.asOfTradingDate()).isEqualTo(D1);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
                assertThat(o.reason().path("highWatermark").asDouble()).isEqualTo(100_000);
                assertThat(o.reason().path("observedPrice").asDouble()).isEqualTo(91_000);
            });
            assertThat(StopWatch.intradayStop(stops().get(0))).as("밤 경로 STOP — 금융위 재판정·⑤ 우회 그대로").isFalse();
        }

        @Test
        @DisplayName("ON — 다음 거래일이 장 시간 변경일(수능일형 10:00 개장)이면 그날 첫 분 10:10")
        void uncoveredTickerOnAShiftedDay() {
            mode("ON", D2.toString());

            nightD1(91_000);

            assertThat(stops()).singleElement().satisfies(o -> assertThat(o.targetLocal()).isEqualTo(LocalTime.of(10, 10)));
        }

        @Test
        @DisplayName("SHADOW — 예전처럼 다음 거래일 시가(NEXT_OPEN), 근거에 stopMode 없음")
        void shadowKeepsTheNextOpenStop() {
            mode("SHADOW", null);
            watched("005930");

            nightD1(91_000);

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.NEXT_OPEN);
                assertThat(o.reason().has("stopMode")).isFalse();
            });
        }
    }
}
