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
            payload.put("mode", "ON");   // 운영 수집기가 회차마다 적는 감시 모드 — ON일 때만 덮음(QA-360)
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
            payload.put("mode", "ON");   // 운영 수집기가 회차마다 적는 감시 모드 — ON일 때만 덮음(QA-360)
            payload.put("fetchedAt", fetchedAt.toString());
            payload.putObject("tickers").set(ticker, StopWatchTest.usEntry(TUE, bars, 99.0, prevClose));
            when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok",
                    null, fetchedAt.plusSeconds(1))));
        }

        /** 지금 저장본의 최상위 {@code mode}(수집기가 그 회차의 감시 모드를 적는 칸)를 {@code value}로 바꿉니다. */
        private void snapshotMode(String value) {
            Snapshot current = marketData.stopWatch(false).orElseThrow();
            ((ObjectNode) current.payload()).put("mode", value);
        }

        /**
         * 감시 작업이 TUE 세션의 마지막 격자(15:55 ET)를 {@code mode}로 판정하고 바로 남긴 기록(운영 형식 — {@code PaperStopWatchJob}의 마지막 격자 판정
         * 기록). 격자 끝 뒤의 덮음은 ON 기록이 있을 때만입니다(QA-384) — 마지막 격자까지 지켜본 평소 날의 고정 자료는 이 기록을 함께 둡니다.
         */
        private void lastGridJudged(String mode) {
            ObjectNode detail = MAPPER.createObjectNode();
            detail.put("market", "US");
            detail.put("mode", mode);
            detail.put("tradingDate", TUE.toString());
            detail.put("lastJudgedGrid", et(TUE, 15, 55).toString());
            store.recordJobRun(PaperStopWatchJob.LAST_GRID_JOB, et(TUE, 15, 55).plusSeconds(40), et(TUE, 15, 55).plusSeconds(40), "OK", detail);
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
        @DisplayName("ON — 감시가 하루 종일 갭 가드로 뺀 종목(Yahoo 전일 종가 103 ≠ 장부 전일 종가 100)은 16:15 확정 종가 관측치에서도 덮지 않아 종가 스탑(QA-305)")
        void guardedTickerKeepsTheCloseFallback() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 103.0);
            lastGridJudged("ON");   // 감시 작업은 15:55 격자까지 판정함(이 종목은 가드로 뺌) — 덮지 않는 까닭은 가드(QA-384 뒤에도 이 조건을 봄)

            closeObservation();

            assertThat(stops()).as("관측치 처리가 기준일을 그날로 옮긴 뒤에도 감시 작업이 본 기준값(월 종가 100)으로 가드를 판정")
                    .singleElement().satisfies(o -> {
                        assertThat(o.timing()).isEqualTo(PaperBooks.IMMEDIATE);
                        assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
                        assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK);
                    });
        }

        @Test
        @DisplayName("ON — 마지막 감시 회차를 놓쳐 15:50:20 저장본(마지막 봉 15:49)뿐이면 16:15 확정 종가 관측치는 덮지 않아 종가 스탑(QA-307)")
        void missedLastGridKeepsTheCloseFallback() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 49), et(TUE, 15, 50).plusSeconds(20), 100.0);

            closeObservation();

            assertThat(stops()).singleElement().satisfies(o -> {
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
            lastGridJudged("ON");   // 평소 날 — 감시 작업이 15:55 격자를 판정하고 남긴 기록(QA-384)

            Outcome outcome = closeObservation();

            assertThat(stops()).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("장중 감시에 맡김"));
        }

        @Test
        @DisplayName("QA-360 설정은 ON이지만 저장본은 SHADOW 때 받은 것(그날 감시는 주문을 내지 않음) — 16:15 확정 종가 관측치는 덮지 않아 종가 스탑")
        void shadowSnapshotDoesNotCoverAfterSwitchingOn() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);
            snapshotMode("SHADOW");
            // 15:55 격자는 SHADOW로 판정했고(기록 SHADOW), 판정 창 끝(16:05) 전에 ON으로 바꿔 세션 요약은 ON·15:55로 남음 — 덮지 않는 까닭은 저장본의 모드
            lastGridJudged("SHADOW");
            summary("ON", et(TUE, 15, 55), false);

            closeObservation();

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.IMMEDIATE);
                assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK);
            });
        }

        // QA-384: 덮음은 수집기의 감시 저장본만 봐서, 저장본에 마지막 격자(15:55 ET) 가격이 있어도 백엔드의 감시 작업이 그 격자를 실제로 판정하지 못한 날
        // (그 시각에 백엔드가 재기동 중·죽어 있음)에 16:15 확정 종가 관측치가 '감시에 맡김'으로 읽어 그날의 종가 스탑이 빠집니다. 근거는 DB의 감시 작업
        // 기록(세션 요약 stopwatch.summary의 lastJudgedGrid·mode)입니다.

        /** 감시 작업이 TUE 세션에 남긴 세션 요약 기록(운영 형식 — {@code PaperStopWatchJob.summarize}) — 마지막 판정 격자 {@code lastJudgedGrid}(없으면 null). */
        private void summary(String mode, Instant lastJudgedGrid, boolean partial) {
            ObjectNode detail = MAPPER.createObjectNode();
            detail.put("market", "US");
            detail.put("mode", mode);
            detail.put("tradingDate", TUE.toString());
            detail.put("partial", partial);
            if (lastJudgedGrid == null) {
                detail.putNull("lastJudgedGrid");
            } else {
                detail.put("lastJudgedGrid", lastJudgedGrid.toString());
            }
            store.recordJobRun("stopwatch.summary", et(TUE, 16, 5).plusSeconds(20), et(TUE, 16, 5).plusSeconds(20), "OK", detail);
        }

        @Test
        @DisplayName("QA-384 ON — 저장본에는 15:55 격자 가격이 있지만 감시 작업이 그 세션에 남긴 기록이 없으면(15:55에 백엔드가 죽어 있었음) 16:15 확정 종가 "
                + "관측치는 덮지 않아 종가 스탑")
        void lastGridNeverJudgedKeepsTheCloseFallback() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);

            Outcome outcome = closeObservation();

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.IMMEDIATE);
                assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK);
            });
            assertThat(outcome.notes()).noneMatch(n -> n.contains("장중 감시에 맡김"));
        }

        @Test
        @DisplayName("QA-384 ON — 감시 작업의 세션 요약이 앞 격자(15:50)까지만 판정했다고 적었거나 판정한 격자가 없으면(lastJudgedGrid null) 16:15 확정 종가 "
                + "관측치는 덮지 않아 종가 스탑")
        void summaryShortOfTheLastGridKeepsTheCloseFallback() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);
            summary("ON", et(TUE, 15, 50), false);

            closeObservation();

            assertThat(stops()).as("15:50까지만 판정").singleElement().satisfies(o ->
                    assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK));

            setUp();
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);
            summary("ON", null, true);   // 15:59에 뜬 프로세스 — 저장본이 이미 7분 넘어 한 격자도 판정하지 못함

            closeObservation();

            assertThat(stops()).as("판정한 격자 없음").singleElement().satisfies(o ->
                    assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK));
        }

        @Test
        @DisplayName("QA-384 평소 날 불변 — 감시 작업이 마지막 격자(15:55)까지 ON으로 판정했다는 세션 요약이 있으면 16:15 확정 종가 관측치는 지금처럼 감시에 맡김"
                + "(장중에 뜬 partial 세션도 같음)")
        void judgedLastGridIsLeftToTheWatchAtTheClose() {
            for (boolean partial : new boolean[]{false, true}) {
                setUp();
                mode("ON");
                watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);
                summary("ON", et(TUE, 15, 55), partial);

                Outcome outcome = closeObservation();

                assertThat(stops()).as("partial=%s", partial).isEmpty();
                assertThat(store.positions(BOOK)).singleElement().satisfies(p -> assertThat(p.qty()).isEqualTo(10));
                assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("장중 감시에 맡김"));
            }
        }

        @Test
        @DisplayName("QA-384 ON — 마지막 격자 판정 기록이 SHADOW뿐이면(그 격자는 주문 없이 판정) 저장본이 ON이어도 덮지 않아 종가 스탑, 작업 기록에 까닭을 남김")
        void shadowJudgedLastGridKeepsTheCloseFallback() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);
            lastGridJudged("SHADOW");

            Outcome outcome = closeObservation();

            assertThat(stops()).singleElement().satisfies(o ->
                    assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK));
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("AAA").contains("마지막 격자 가격이 있지만")
                    .contains("판정한 기록(ON)이 없어"));
        }

        @Test
        @DisplayName("QA-384 ON — 마지막 격자는 SHADOW로 판정했는데(판정 기록 SHADOW) 세션 요약은 요약 전에 바꾼 ON으로 남은 세션: 저장본이 ON이어도 "
                + "덮지 않아 종가 스탑(요약의 mode는 요약 시점 값 — 판정 기록이 있으면 요약을 근거로 쓰지 않음)")
        void summaryModeDoesNotOverrideAShadowJudgedLastGrid() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);   // 수집기는 15:55:20에 ON으로 읽음
            lastGridJudged("SHADOW");                                                      // 15:55:30에 SHADOW로 바꿔 작업은 SHADOW로 판정
            summary("ON", et(TUE, 15, 55), false);                                         // 16:00에 다시 ON — 요약은 ON·15:55

            Outcome outcome = closeObservation();

            assertThat(stops()).singleElement().satisfies(o ->
                    assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK));
            assertThat(outcome.notes()).noneMatch(n -> n.contains("장중 감시에 맡김"));
        }

        @Test
        @DisplayName("QA-384 격자 끝 전의 판정(시간별 관측치 15:15 ET — 그 시각 − 10분 뒤의 표본)은 감시 작업 기록을 묻지 않고 지금처럼 감시에 맡김")
        void hourlyObservationBeforeTheGridEndDoesNotAskForTheRecord() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 14), et(TUE, 15, 15).plusSeconds(20), 100.0);
            PaperLedgerService hourly = new PaperLedgerService(store, marketData, MAPPER,
                    new PaperCheckpointJobTest.MovableClock(et(TUE, 15, 17)));

            Outcome outcome = hourly.process(quotes(et(TUE, 15, 15).plusSeconds(40), bar("AAA", MON, 100.0, TUE, 90.0)));

            assertThat(stops()).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("장중 감시에 맡김"));
        }

        @Test
        @DisplayName("QA-384 이중 스탑 없음 — 감시가 앞 격자에서 낸 종가 STOP이 대기 중이면, 마지막 격자를 판정한 기록이 없는 날에도 16:15 확정 종가 관측치는 "
                + "그 STOP 하나만 체결(대체 스탑을 겹쳐 내지 않음)")
        void pendingWatchStopIsNotDoubledWhenTheLastGridWasNotJudged() {
            mode("ON");
            watchedUntil("AAA", et(TUE, 15, 54), et(TUE, 15, 55).plusSeconds(20), 100.0);
            ObjectNode reason = MAPPER.createObjectNode().put("trigger", "TRAILING_STOP").put("stopMode", PaperStopWatchJob.STOP_MODE);
            long watch = store.insertOrder(new Order(0, BOOK, null, "AAA", PaperBooks.SELL, null, null, null, PaperBooks.NEXT_CLOSE,
                    PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, reason, MON, et(TUE, 15, 54), TUE, null));

            closeObservation();

            assertThat(stops()).as("STOP 주문은 감시가 낸 하나뿐").singleElement().satisfies(o -> {
                assertThat(o.id()).isEqualTo(watch);
                assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
            });
            assertThat(store.fillsOf(BOOK)).as("매도 체결 한 번").hasSize(1);
            assertThat(store.positions(BOOK)).isEmpty();
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
        /** 장부의 지금 시각 — 관측치를 처리하는 시각(늦은 처리는 수집 시각보다 뒤, QA-327). */
        private PaperCheckpointJobTest.MovableClock clock;
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
            clock = new PaperCheckpointJobTest.MovableClock(COLLECTED_D1);
            ledger = new PaperLedgerService(store, marketData, MAPPER, clock);
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

        /** D1 세션을 마지막 격자 15:20까지 지켜본 감시 저장본(갭 가드 통과). */
        private void watched(String code) {
            watched(code, kst("2026-11-03T15:20:20"), "15:05", "15:15", "15:20");
        }

        /** D1 세션의 봉(끝 라벨 {@code labels}, 93,000)을 담아 {@code fetchedAt}에 받은 감시 저장본(갭 가드 통과). */
        private void watched(String code, Instant fetchedAt, String... labels) {
            watched(code, D1, fetchedAt, 93_000.0, labels);
        }

        /** {@code session} 세션의 봉(끝 라벨 {@code labels}, 가격 {@code price})을 담아 {@code fetchedAt}에 받은 감시 저장본(갭 가드 통과). */
        private void watched(String code, LocalDate session, Instant fetchedAt, double price, String... labels) {
            Map<String, Double> bars = new LinkedHashMap<>();
            for (String label : labels) {
                bars.put(label, price);
            }
            ObjectNode entry = StopWatchTest.krEntry(session, bars, List.of(), 99_000.0, 100_000.0, 100_000.0);
            ObjectNode payload = MAPPER.createObjectNode();
            payload.put("mode", "ON");   // 운영 수집기가 회차마다 적는 감시 모드 — ON일 때만 덮음(QA-360)
            payload.put("fetchedAt", fetchedAt.toString());
            payload.putObject("tickers").set(code, entry);
            when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok",
                    null, fetchedAt.plusSeconds(1))));
        }

        /** 지금 저장본의 최상위 {@code mode}(수집기가 그 회차의 감시 모드를 적는 칸)를 {@code value}로 바꿉니다. */
        private void snapshotMode(String value) {
            Snapshot current = marketData.stopWatch(true).orElseThrow();
            ((ObjectNode) current.payload()).put("mode", value);
        }

        private Outcome nightD1(double close) {
            return d1Observation(close, COLLECTED_D1);
        }

        /** 세션 D1 관측치(005930 — D1 잠정 종가 {@code close})를 {@code collected}에 저장한 것으로 처리 — 다음 세션 장중의 다시 저장(QA-317)도 같은 본문. */
        private Outcome d1Observation(double close, Instant collected) {
            return d1Observation(close, collected, collected);
        }

        /** {@link #d1Observation(double, Instant)}를 장부 시계 {@code processed}에 처리(수집 뒤 늦게 돈 처리 — QA-327). */
        private Outcome d1Observation(double close, Instant collected, Instant processed) {
            clock.now = processed;
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 99_000, close, 2_000).minute("OK", "09:01", 99_000, 100);
            return ledger.process(run(), KrQuotes.parse(payload.snapshot(collected)).orElseThrow());
        }

        private List<Order> stops() {
            return store.orders.values().stream().filter(o -> PaperBooks.SOURCE_STOP.equals(o.source())).toList();
        }

        @Test
        @DisplayName("ON — 감시가 그 세션을 지켜본 종목은 밤 잠정 종가 한 번으로 내지 않음")
        void coveredTickerIsLeftToTheWatch() {
            mode("ON", null);
            watched("005930");
            lastGridJudgedD1();   // 평소 날 — 감시 작업이 15:20 격자를 판정하고 남긴 기록(QA-384)

            Outcome outcome = nightD1(91_000);

            assertThat(stops()).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("밤 스탑을 장중 감시에 맡김"));
        }

        @Test
        @DisplayName("QA-360 설정은 ON이지만 저장본은 SHADOW 때 받은 것(그날 감시는 주문을 내지 않음) — 밤 감지는 덮지 않아 다음 거래일 09:10 NIGHT_FALLBACK. "
                + "저장본에 mode가 없어도 덮지 않음")
        void shadowSnapshotDoesNotCoverAfterSwitchingOn() {
            mode("ON", null);
            watched("005930");
            snapshotMode("SHADOW");
            // 15:20 격자는 SHADOW로 판정했고(기록 SHADOW), 판정 창 끝(15:35) 전에 ON으로 바꿔 세션 요약은 ON·15:20으로 남음 — 덮지 않는 까닭은 저장본의 모드
            lastGridJudged(D1, "SHADOW", kst("2026-11-03T15:20"));
            summary(D1, "ON", kst("2026-11-03T15:20"), false);

            nightD1(91_000);

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.AT_MINUTE);
                assertThat(o.targetLocal()).isEqualTo(LocalTime.of(9, 10));
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
            });
        }

        @Test
        @DisplayName("ON — 마지막 감시 회차를 놓쳐 15:15:20 저장본(마지막 봉 끝 15:15)뿐이면 밤 감지는 덮지 않아 다음 거래일 09:10 NIGHT_FALLBACK(QA-307)")
        void missedLastGridKeepsTheNightFallback() {
            mode("ON", null);
            watched("005930", kst("2026-11-03T15:15:20"), "15:05", "15:15");

            nightD1(91_000);

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.AT_MINUTE);
                assertThat(o.targetLocal()).isEqualTo(LocalTime.of(9, 10));
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
            });
        }

        // QA-384: 저장본에 마지막 격자(15:20 KST) 가격이 있어도 백엔드의 감시 작업이 그 격자를 판정하지 못한 날(그 시각에 재기동 중·죽어 있음)에 밤 감지가
        // '감시에 맡김'으로 읽어 밤 대체 스탑이 빠집니다. 근거는 DB의 감시 작업 기록(세션 요약 kr.stopwatch.summary의 lastJudgedGrid·mode)입니다.

        /**
         * 감시 작업이 {@code session} 세션의 마지막 격자({@code grid} — 보통 날 15:20 KST)를 {@code mode}로 판정하고 바로 남긴 기록(운영 형식 —
         * {@code PaperStopWatchJob}의 마지막 격자 판정 기록). 격자 끝 뒤의 덮음은 ON 기록이 있을 때만입니다(QA-384).
         */
        private void lastGridJudged(LocalDate session, String mode, Instant grid) {
            ObjectNode detail = MAPPER.createObjectNode();
            detail.put("market", "KR");
            detail.put("mode", mode);
            detail.put("tradingDate", session.toString());
            detail.put("lastJudgedGrid", grid.toString());
            store.recordJobRun("kr." + PaperStopWatchJob.LAST_GRID_JOB, grid.plusSeconds(40), grid.plusSeconds(40), "OK", detail);
        }

        /** D1 세션의 마지막 격자 15:20을 ON으로 판정한 기록(평소 날). */
        private void lastGridJudgedD1() {
            lastGridJudged(D1, "ON", kst("2026-11-03T15:20"));
        }

        /** 감시 작업이 {@code session} 세션에 남긴 세션 요약 기록(운영 형식) — 마지막 판정 격자 {@code lastJudgedGrid}(없으면 null). */
        private void summary(LocalDate session, String mode, Instant lastJudgedGrid, boolean partial) {
            ObjectNode detail = MAPPER.createObjectNode();
            detail.put("market", "KR");
            detail.put("mode", mode);
            detail.put("tradingDate", session.toString());
            detail.put("partial", partial);
            if (lastJudgedGrid == null) {
                detail.putNull("lastJudgedGrid");
            } else {
                detail.put("lastJudgedGrid", lastJudgedGrid.toString());
            }
            Instant at = ZonedDateTime.of(session, LocalTime.of(15, 35, 20), KrxCalendar.SEOUL).toInstant();
            store.recordJobRun("kr.stopwatch.summary", at, at, "OK", detail);
        }

        @Test
        @DisplayName("QA-384 ON — 저장본에는 15:20 격자 가격이 있지만 감시 작업이 그 세션에 남긴 기록이 없거나 앞 격자(15:15)까지만 판정했으면 밤 감지는 덮지 않아 "
                + "다음 거래일 09:10 NIGHT_FALLBACK")
        void lastGridNeverJudgedKeepsTheNightFallback() {
            mode("ON", null);
            watched("005930");

            Outcome outcome = nightD1(91_000);

            assertThat(stops()).as("감시 작업 기록 없음").singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.AT_MINUTE);
                assertThat(o.targetLocal()).isEqualTo(LocalTime.of(9, 10));
                assertThat(o.asOfTradingDate()).isEqualTo(D1);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
            });
            assertThat(outcome.notes()).noneMatch(n -> n.contains("밤 스탑을 장중 감시에 맡김"));

            setUp();
            mode("ON", null);
            watched("005930");
            summary(D1, "ON", kst("2026-11-03T15:15"), false);

            nightD1(91_000);

            assertThat(stops()).as("15:15까지만 판정").singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.AT_MINUTE);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
            });

            setUp();
            mode("ON", null);
            watched("005930");
            summary(D, "ON", kst("2026-11-02T15:20"), false);   // 전 세션(D)은 끝까지 판정했지만 D1의 기록은 없음

            nightD1(91_000);

            assertThat(stops()).as("전 세션의 요약은 D1의 근거가 아님").singleElement().satisfies(o ->
                    assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK));
        }

        @Test
        @DisplayName("QA-384 평소 날 불변 — 감시 작업이 마지막 격자(15:20)까지 ON으로 판정했다는 세션 요약이 있으면 밤 감지는 지금처럼 감시에 맡김"
                + "(장중에 뜬 partial 세션도 같음, 다른 세션의 요약은 근거가 아님)")
        void judgedLastGridIsLeftToTheWatchAtNight() {
            for (boolean partial : new boolean[]{false, true}) {
                setUp();
                mode("ON", null);
                watched("005930");
                summary(D, "ON", kst("2026-11-02T15:20"), false);   // 전 세션의 요약 — D1의 근거가 아님(있어도 결과는 같음)
                summary(D1, "ON", kst("2026-11-03T15:20"), partial);

                Outcome outcome = nightD1(91_000);

                assertThat(stops()).as("partial=%s", partial).isEmpty();
                assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("밤 스탑을 장중 감시에 맡김"));
            }
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
        @DisplayName("ON — 그 세션에 이 책이 새로 산 종목은 감시 저장본에 같은 종목(다른 책 보유)이 있어도 덮지 않아 다음 거래일 09:10 NIGHT_FALLBACK(QA-316)")
        void boughtThatSessionKeepsTheNightFallback() {
            mode("ON", null);
            store.states.put(BOOK, new BookState(BOOK, 10_000_000, 10_000_000, 0, 0, null, null, null, null));
            when(marketData.fscMarkets(anyCollection())).thenReturn(Map.of("005930", "KOSPI", "000660", "KOSPI"));
            watched("000660");   // 다른 한국 책이 000660을 들고 있어 감시 저장본에는 D1 15:20까지 그 종목이 있음
            lastGridJudgedD1();   // 감시 작업은 15:20 격자까지 판정함 — 덮지 않는 까닭은 이 책이 그 세션에 새로 산 보유(QA-384 뒤에도 이 조건을 봄)
            long buy = store.insertOrder(new Order(0, BOOK, null, "000660", PaperBooks.BUY, 10, null, null, PaperBooks.NEXT_OPEN,
                    RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, D, kst("2026-11-02T22:30"), D2, null));
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 99_000, 100_000, 2_000).minute("OK", "09:01", 99_000, 100);
            payload.code("000660", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 100_000, 91_000, 2_000)
                    .minute("OK", "09:01", 100_000, 100);

            Outcome outcome = ledger.process(run(), KrQuotes.parse(payload.snapshot(COLLECTED_D1)).orElseThrow());

            assertThat(store.orders.get(buy).status()).as("D1 시가에 새로 삼").isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.ticker()).isEqualTo("000660");
                assertThat(o.timing()).isEqualTo(PaperBooks.AT_MINUTE);
                assertThat(o.targetLocal()).isEqualTo(LocalTime.of(9, 10));
                assertThat(o.asOfTradingDate()).isEqualTo(D1);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
            });
            assertThat(outcome.notes()).noneMatch(n -> n.contains("000660 밤 스탑을 장중 감시에 맡김"));
        }

        @Test
        @DisplayName("ON — 다음 거래일이 장 시간 변경일(수능일형 10:00 개장)이면 그날 첫 분 10:10")
        void uncoveredTickerOnAShiftedDay() {
            mode("ON", D2.toString());

            nightD1(91_000);

            assertThat(stops()).singleElement().satisfies(o -> assertThat(o.targetLocal()).isEqualTo(LocalTime.of(10, 10)));
        }

        @Test
        @DisplayName("ON — D1 밤에 감시에 맡긴 보유는 D2 장중에 다시 저장된 D1 관측치로 다시 판정하지 않음 — STOP·체결 없음(QA-317)")
        void daytimeResaveDoesNotRejudgeTheNight() {
            mode("ON", null);
            watched("005930");
            lastGridJudgedD1();   // 평소 날 — 감시 작업이 15:20 격자를 판정하고 남긴 기록(QA-384)
            nightD1(91_000);
            assertThat(stops()).as("D1 밤 — 감시에 맡김").isEmpty();

            // D2 13:17 — 금융위 값이 낮에 들어와 수집 범위가 늘어 세션 D1 관측치가 다시 저장됨. 감시 저장본은 D2이고 가격은 스탑가 위로 돌아옴.
            watched("005930", D2, kst("2026-11-04T13:15:20"), 97_000.0, "13:05", "13:10", "13:15");
            d1Observation(91_000, kst("2026-11-04T13:17"));
            assertThat(stops()).as("D1 봉은 D1 밤이 이미 판정함").isEmpty();

            KrFixtures.Payload night = new KrFixtures.Payload(D2);
            night.code("005930", kst("2026-11-04T21:57")).bar(D1, 99_000, 91_000, 2_000).bar(D2, 97_000, 97_500, 3_000)
                    .minute("OK", "09:01", 97_000, 100);
            ledger.process(run(), KrQuotes.parse(night.snapshot(kst("2026-11-04T22:01"))).orElseThrow());
            assertThat(store.fillsOf(BOOK)).as("D2 시가로 팔지 않음").isEmpty();
            assertThat(store.positions(BOOK)).singleElement().satisfies(p -> assertThat(p.ticker()).isEqualTo("005930"));
            assertThat(store.lockouts(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("ON — 다음 세션 첫 분이 지난 뒤 처음 처리한 D1 관측치는 감시가 지금 세션을 지켜보지 않는 종목만 그 세션 장중 시장가 STOP(시가 아님, QA-317)")
        void lateFirstProcessingStopsAtTheNextMinute() {
            mode("ON", null);
            watched("000660", D2, kst("2026-11-04T13:15:20"), 97_000.0, "13:05", "13:10", "13:15");   // 005930은 지금 감시에 없음

            Outcome outcome = d1Observation(91_000, kst("2026-11-04T13:17"));

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.MARKET);
                assertThat(o.asOfTradingDate()).isEqualTo(D1);
                assertThat(o.createdAt()).isEqualTo(kst("2026-11-04T13:17"));
                assertThat(ExecutionAudit.marketTarget(o.createdAt())).isEqualTo(kst("2026-11-04T13:19"));
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
                assertThat(o.reason().path("detection").asString()).contains("13:19 KST");
            });
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("005930").contains("13:19"));
        }

        @Test
        @DisplayName("ON — 다음 세션 첫 분이 지난 뒤 처음 처리한 D1 관측치라도 감시가 지금 세션을 지켜보는 종목은 감시에 맡김(QA-317)")
        void lateFirstProcessingLeavesAWatchedTickerToTheWatch() {
            mode("ON", null);
            watched("005930", D2, kst("2026-11-04T13:15:20"), 97_000.0, "13:05", "13:10", "13:15");

            Outcome outcome = d1Observation(91_000, kst("2026-11-04T13:17"));

            assertThat(stops()).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("005930").contains("감시가 지금 세션 " + D2));
        }

        // QA-327: 2차 리뷰 재검증 R2V-1 — 늦은 밤 스탑 경로(QA-317)가 시각을 관측치의 수집 시각(run.at)으로 판정해, 백엔드가 밤새 꺼졌다가 다음 세션
        // 장중에 처음 처리한 D1 밤 관측치는 첫 분 검사를 통과한 채 D2 09:10 지정 시각 STOP(생성 = D1 22:01)이 되어 D2 밤에 주문을 만든 시각(D2 10:00)보다
        // 이른 09:10 값으로 체결·재진입 금지(실제 계좌는 09:10~09:13 창이 지난 뒤에야 봐서 놓침). 늦은 장중 시장가도 T가 수집 + 2분이라 5분 주기 처리가
        // T 뒤에 주문을 쓸 수 있고, 늦은 종가·시장가 대체 STOP의 알림 시점 이름은 '다음 거래일 종가'·'장중 시장가'로 남음.
        @Test
        @DisplayName("ON — 백엔드가 밤새 꺼졌다가 D2 10:00에 처음 처리한 D1 밤 관측치는 처리 시각으로 판정 — 감시가 지금 세션을 지켜보면 맡기고, 주문 전 "
                + "시각(09:10)에 체결되는 지정 시각 STOP을 내지 않음(QA-327)")
        void outageFirstProcessingJudgesAtTheProcessingTime() {
            mode("ON", null);
            // 수집기는 계속 돌아 지금 감시 저장본은 D2 것(005930 97,000 — 스탑가 92,000 위)
            watched("005930", D2, kst("2026-11-04T09:55:20"), 97_000.0, "09:45", "09:50", "09:55");

            Outcome outcome = d1Observation(91_000, COLLECTED_D1, kst("2026-11-04T10:00"));

            assertThat(stops()).as("D2 10:00에 D2 09:10 지정 시각 STOP을 만들지 않음").isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("005930").contains("감시가 지금 세션 " + D2));

            // D2 밤 — 09:10 1분봉은 스탑가 아래(90,200)였지만 그 시각에는 주문이 없었음
            when(marketData.krTimed()).thenReturn(Map.of("005930", Map.of(D2, new KrQuotes.Timed(KrQuotes.TIMED_OK, null,
                    kst("2026-11-04T21:50"), Map.of("09:10", List.of(new KrQuotes.Bar1m("09:11", java.math.BigDecimal.valueOf(90_200), 300L))),
                    Map.of(), Map.of()))));
            clock.now = kst("2026-11-04T22:03");
            KrFixtures.Payload night = new KrFixtures.Payload(D2);
            night.code("005930", kst("2026-11-04T21:57")).bar(D1, 99_000, 91_000, 2_000).bar(D2, 90_000, 97_500, 3_000)
                    .minute("OK", "09:01", 90_000, 100);
            ledger.process(run(), KrQuotes.parse(night.snapshot(kst("2026-11-04T22:01"))).orElseThrow());

            assertThat(store.fillsOf(BOOK)).as("주문을 만들기 전 시각(09:10)의 값으로 팔지 않음").isEmpty();
            assertThat(store.lockouts(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("ON — D2 13:17에 수집한 D1 관측치를 5분 뒤(13:22)에 처음 처리하면 장중 시장가 대체 STOP의 생성·기준 시각은 처리 시각에서 셈"
                + "(T 13:24 — 처리 뒤), 알림 시점 이름은 '장중 시장가 13:24 KST'(QA-327)")
        void lateMarketFallbackCountsFromTheProcessingTime() {
            mode("ON", null);
            watched("000660", D2, kst("2026-11-04T13:20:20"), 97_000.0, "13:10", "13:15", "13:20");   // 005930은 지금 감시에 없음
            Instant processed = kst("2026-11-04T13:22");

            d1Observation(91_000, kst("2026-11-04T13:17"), processed);

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.MARKET);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
                assertThat(o.createdAt()).as("주문을 만든 시각 = 처리 시각").isEqualTo(processed);
                assertThat(ExecutionAudit.marketTarget(o.createdAt())).isEqualTo(kst("2026-11-04T13:24"))
                        .isAfter(processed.plus(ExecutionAudit.AFTER_CREATED));
                assertThat(o.reason().path("detection").asString()).contains("13:24 KST");
                assertThat(PaperNotifications.timingName(o, true)).isEqualTo("장중 시장가 13:24 KST");
            });
        }

        @Test
        @DisplayName("ON — D2 종가 단일가 시간(15:22)에 처음 처리한 D1 관측치의 대체 STOP은 그날(D2) 종가 — 알림 시점 이름도 '그날 종가'(QA-327)")
        void lateCloseFallbackIsNamedTheSameDay() {
            mode("ON", null);
            watched("000660", D2, kst("2026-11-04T15:20:20"), 97_000.0, "15:10", "15:15", "15:20");   // 005930은 지금 감시에 없음

            d1Observation(91_000, kst("2026-11-04T15:21"), kst("2026-11-04T15:22"));

            assertThat(stops()).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.NEXT_CLOSE);
                assertThat(o.reason().path("detection").asString()).contains("그날(" + D2 + ") 종가 단일가");
                assertThat(PaperNotifications.timingName(o, true)).isEqualTo("그날 종가");
            });
        }

        @Test
        @DisplayName("QA-384 ON — D2 종가 단일가 시간(15:22)에 처음 처리한 D1 관측치: 감시 작업이 D2 마지막 격자(15:20)를 판정한 기록이 있으면 감시에 맡기고, "
                + "저장본에 15:20 가격만 있고 기록이 없으면 그날(D2) 종가 대체 STOP")
        void lateProcessingAfterTheGridEndNeedsTheRecord() {
            mode("ON", null);
            watched("005930", D2, kst("2026-11-04T15:20:20"), 97_000.0, "15:10", "15:15", "15:20");
            lastGridJudged(D2, "ON", kst("2026-11-04T15:20"));

            Outcome outcome = d1Observation(91_000, kst("2026-11-04T15:21"), kst("2026-11-04T15:22"));

            assertThat(stops()).as("D2 마지막 격자를 판정한 기록 있음").isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("005930").contains("감시가 지금 세션 " + D2));

            setUp();
            mode("ON", null);
            watched("005930", D2, kst("2026-11-04T15:20:20"), 97_000.0, "15:10", "15:15", "15:20");

            d1Observation(91_000, kst("2026-11-04T15:21"), kst("2026-11-04T15:22"));

            assertThat(stops()).as("기록 없음 — 15:20 격자를 아무도 판정하지 않음").singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.NEXT_CLOSE);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
            });
        }

        @Test
        @DisplayName("ON — 다음 세션 장이 끝난 뒤 처음 처리한 D1 관측치는 대체 STOP을 내지 않고 그 세션 밤 관측치에 맡김(QA-317)")
        void processingAfterTheNextCloseWaitsForItsNight() {
            mode("ON", null);
            watched("000660", D2, kst("2026-11-04T15:20:20"), 97_000.0, "15:05", "15:15", "15:20");

            Outcome outcome = d1Observation(91_000, kst("2026-11-04T16:00"));

            assertThat(stops()).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("005930").contains(D2 + " 장이 끝난 뒤"));
        }

        @Test
        @DisplayName("ON — 그 세션에 체결할 수 없는(그날 1분봉 없음) 감시 STOP은 밤에 만료로 닫고, 감시가 덮지 못했으면 다음 거래일 첫 분 NIGHT_FALLBACK(QA-318)")
        void unfillableWatchStopIsClosedAndFallsBack() {
            mode("ON", null);
            watched("000660");   // 005930은 감시가 덮지 못함
            ObjectNode reason = MAPPER.createObjectNode();
            reason.put("trigger", "TRAILING_STOP");
            reason.put("stopMode", PaperStopWatchJob.STOP_MODE);
            long watch = store.insertOrder(new Order(0, BOOK, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.MARKET,
                    PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, reason, D, kst("2026-11-03T10:00"), D1, null));
            KrQuotes.Timed none = new KrQuotes.Timed(KrQuotes.TIMED_NO_BARS, null, kst("2026-11-03T21:50"), Map.of(), Map.of(), Map.of());
            when(marketData.krTimed()).thenReturn(Map.of("005930", Map.of(D1, none)));

            Outcome outcome = nightD1(91_000);

            assertThat(store.orders.get(watch).status()).isEqualTo(PaperBooks.ORDER_EXPIRED);
            assertThat(store.orders.get(watch).rejectReason()).contains("1분봉 없음").contains("체결할 수 없어");
            assertThat(stops()).filteredOn(o -> PaperBooks.ORDER_PENDING.equals(o.status())).singleElement().satisfies(o -> {
                assertThat(o.timing()).isEqualTo(PaperBooks.AT_MINUTE);
                assertThat(o.targetLocal()).isEqualTo(LocalTime.of(9, 10));
                assertThat(o.asOfTradingDate()).isEqualTo(D1);
                assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
            });
            assertThat(outcome.expired()).isEqualTo(1);
        }

        @Test
        @DisplayName("ON — 밤 대체 STOP이 다음 거래일 09:10에 체결되면 재진입 금지 사유는 '지정 시각 09:10 … 체결'(시가 아님, QA-320)")
        void nightFallbackLockoutNamesTheMinute() {
            mode("ON", null);
            watched("000660");
            nightD1(91_000);
            assertThat(stops()).singleElement().satisfies(o -> assertThat(o.targetLocal()).isEqualTo(LocalTime.of(9, 10)));
            when(marketData.krTimed()).thenReturn(Map.of("005930", Map.of(D2, new KrQuotes.Timed(KrQuotes.TIMED_OK, null,
                    kst("2026-11-04T21:50"), Map.of("09:10", List.of(new KrQuotes.Bar1m("09:11", java.math.BigDecimal.valueOf(90_200), 300L))),
                    Map.of(), Map.of()))));

            KrFixtures.Payload night = new KrFixtures.Payload(D2);
            night.code("005930", kst("2026-11-04T21:57")).bar(D1, 99_000, 91_000, 2_000).bar(D2, 90_000, 90_500, 3_000)
                    .minute("OK", "09:01", 90_000, 100);
            ledger.process(run(), KrQuotes.parse(night.snapshot(kst("2026-11-04T22:01"))).orElseThrow());

            assertThat(store.fillsOf(BOOK)).singleElement().satisfies(f -> assertThat(f.priceSource()).isEqualTo(KrTimedLadder.SOURCE_AT));
            assertThat(store.lockouts(BOOK)).singleElement().satisfies(l -> {
                assertThat(l.reason()).containsPattern(D2 + " 지정 시각 09:10 [0-9.]+ 체결");
                assertThat(l.reason()).doesNotContain("시가");
                assertThat(l.reason()).contains("판정 PROVISIONAL");
            });
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
