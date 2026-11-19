package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static com.macrodash.feature.paper.KrIntradayFillTest.PREV;
import static com.macrodash.feature.paper.KrIntradayFillTest.S;
import static com.macrodash.feature.paper.KrIntradayFillTest.entry;
import static com.macrodash.feature.paper.KrIntradayFillTest.kst;
import static com.macrodash.feature.paper.KrIntradayFillTest.minutes;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 한국 장중 감시 STOP 체결의 장중 단계({@link KrStopFillStep} — ADR 0045, SHADOW): 관문 시각(G5)·R1이 갖춰진 첫 주기에 근거 {@code intradayFill}을 한 번 남기고
 * 장부(보유·현금·체결·주문 상태)는 그대로, 관문(G2·G3·G4·종목 구분)에 걸리면 사유를 남겨 밤에 맡김, R1이 마감 1분 전까지 없으면 NO_R1, 밤이 닫은 뒤 대조 칸과
 * 불일치 알림, 스위치 유효 값이 OFF면 아무것도 읽지 않음, 저장본·금융위·장부 밀림 판정은 장부 잠금 밖에서 읽음.
 */
class KrStopFillStepTest {

    private static final String BOOK = PaperBooks.KR_RULES;
    private static final String A = "005930";
    private static final String B = "000660";

    private FakePaperStore store;
    private PaperMarketData marketData;
    private StoreReader reader;
    private PaperCheckpointJobTest.MovableClock clock;
    private PaperLedgerService ledger;
    private KrStopFillStep step;
    private ObjectNode tickers;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        when(marketData.quotes(any())).thenReturn(Optional.empty());
        when(marketData.fscMarkets(any())).thenReturn(Map.of(A, "KOSPI", B, "KOSDAQ"));
        when(marketData.krConfirmed(any(), any(), any())).thenReturn(new KrConfirmed(Map.of(A, listed(), B, listed())));
        clock = new PaperCheckpointJobTest.MovableClock(kst("2026-11-17T13:15:20"));
        ledger = new PaperLedgerService(store, marketData, MAPPER);
        step = new KrStopFillStep(store, reader, marketData, ledger, PaperFixtures.config(), MAPPER, clock,
                new PaperMarkets(store, reader, List.of(KrPaperMarket.INSTANCE)));
        settings("ON", "SHADOW");
        store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_RULES, BOOK, 100_000_000, LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE,
                Instant.parse("2026-10-29T13:00:00Z"), Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(BOOK, new BookState(BOOK, 5_000_000, 6_400_000, 1_400_000, 21.875, kst("2026-11-16T20:40"),
                kst("2026-11-16T20:40"), PREV, null));
        hold(A, 10, 70_000);
        hold(B, 5, 140_000);
        tickers = MAPPER.createObjectNode();
        snapshot(kst("2026-11-17T13:15:20"));
        tickers.set(A, entry(S, kst("2026-11-17T13:15:20"), minutes("12:55", "13:15", 70_000), List.of()));
    }

    private static KrConfirmed.Series listed() {
        NavigableMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
        days.put(LocalDate.of(2026, 11, 13), new KrConfirmed.Day(LocalDate.of(2026, 11, 13), BigDecimal.valueOf(70_000), 1_000L, 1_000_000L,
                BigDecimal.valueOf(70_000), "KOSPI"));
        days.put(PREV, new KrConfirmed.Day(PREV, BigDecimal.valueOf(70_000), 1_000L, 1_000_000L, BigDecimal.valueOf(70_000), "KOSPI"));
        return new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, PREV, days);
    }

    private void settings(String mode, String fill) {
        ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
        ((ObjectNode) body.get("kr").get("stopWatch")).put("mode", mode).put("fill", fill);
        if (store.settings == null) {
            store.initSettingsIfAbsent(body);
        } else {
            store.saveSettings(body, List.of("kr.stopWatch.mode", "kr.stopWatch.fill"));
        }
    }

    private void hold(String ticker, int qty, double price) {
        store.upsertPosition(new Position(BOOK, ticker, qty, price * 0.9, LocalDate.of(2026, 11, 3), kst("2026-11-03T09:10"), price,
                kst("2026-11-16T20:40"), price, kst("2026-11-16T20:40"), false, PREV, price, null));
    }

    private void snapshot(Instant fetched) {
        ObjectNode payload = MAPPER.createObjectNode().put("fetchedAt", fetched.toString()).put("mode", "ON");
        payload.set("tickers", tickers);
        when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null,
                fetched.plusSeconds(1))));
    }

    private long stop(String ticker, String created) {
        return store.insertOrder(KrIntradayFillTest.watchStop(0, ticker, kst(created)));
    }

    private JsonNode record(long id) {
        return store.orders.get(id).reason().get(KrIntradayFill.FIELD);
    }

    @Test
    @DisplayName("SHADOW — G5 시각·R1이 갖춰진 첫 주기에 근거를 한 번(R1 값·비용·설정 판·관문 시각), 장부(보유·현금·체결·주문 상태)는 그대로, 두 번째 주기는 다시 쓰지 않음")
    void shadowRecordsOnce() {
        long id = stop(A, "2026-11-17T13:10:42");
        Map<String, Position> before = Map.copyOf(store.positions.get(BOOK));
        BookState state = store.states.get(BOOK);

        clock.now = kst("2026-11-17T13:14:59");
        assertThat(step.run(KrPaperMarket.INSTANCE).skipped()).as("G5 전(창 끝 13:14 + 60초)").isEqualTo("기록할 대상 없음");
        verify(marketData, never()).stopWatch(anyBoolean());

        clock.now = kst("2026-11-17T13:15:20");
        KrStopFillStep.Outcome outcome = step.run(KrPaperMarket.INSTANCE);
        assertThat(outcome.error()).isNull();
        assertThat(outcome.recorded()).singleElement().satisfies(r -> assertThat(r.get("outcome")).isEqualTo(KrIntradayFill.RECORD));
        assertThat(outcome.lockMillis()).isNotNull();
        JsonNode record = record(id);
        assertThat(record.path(KrIntradayFill.MODE).asString()).isEqualTo("SHADOW");
        assertThat(record.path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.RECORD);
        assertThat(record.path(KrIntradayFill.REASONS)).isEmpty();
        assertThat(record.path(KrIntradayFill.BAR_LABEL).asString()).isEqualTo("13:12");
        assertThat(record.path(KrIntradayFill.RAW_PRICE).decimalValue()).isEqualByComparingTo("70170");
        assertThat(record.path(KrIntradayFill.PRICE_SOURCE).asString()).isEqualTo(KrTimedLadder.SOURCE_AT);
        assertThat(record.path(KrIntradayFill.QTY).asInt()).isEqualTo(10);
        assertThat(record.path(KrIntradayFill.VOLUME).asLong()).isEqualTo(100);
        assertThat(record.path(KrIntradayFill.TARGET_AT).asString()).isEqualTo(kst("2026-11-17T13:11").toString());
        assertThat(record.path(KrIntradayFill.GATE_AT).asString()).isEqualTo(kst("2026-11-17T13:15").toString());
        assertThat(record.path(KrIntradayFill.SNAPSHOT_FETCHED_AT).asString()).isEqualTo(kst("2026-11-17T13:15:20").toString());
        assertThat(record.path(KrIntradayFill.SETTINGS_VERSION).asInt()).isEqualTo(store.settings.version());
        FillTerms.Costs costs = KrFills.termsFor(com.macrodash.analytics.PaperLedger.Side.SELL, A, new KrQuotes.Choice(S,
                BigDecimal.valueOf(70_170), KrTimedLadder.SOURCE_AT, null), "KOSPI", PaperSettings.from(store.settings.body(),
                KrPaperMarket.INSTANCE), KrPaperMarket.BENCHMARK_TICKERS).costs(10);
        assertThat(record.path(KrIntradayFill.CASH_DELTA).asDouble()).as("밤 체결과 같은 함수의 현금 변화").isEqualTo(costs.cashDelta());
        assertThat(record.path(KrIntradayFill.TAX).decimalValue()).isEqualByComparingTo(costs.tax());
        assertThat(record.path(KrIntradayFill.FEE).decimalValue()).isEqualByComparingTo(costs.fee());
        assertThat(store.orders.get(id).reason().path("stopMode").asString()).as("앞 근거 그대로").isEqualTo(PaperStopWatchJob.STOP_MODE);

        assertThat(store.orders.get(id).status()).as("SHADOW — 장부 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.fills).isEmpty();
        assertThat(store.positions.get(BOOK)).isEqualTo(before);
        assertThat(store.states.get(BOOK)).isEqualTo(state);
        assertThat(store.lockouts.getOrDefault(BOOK, new TreeMap<>())).isEmpty();
        assertThat(store.recentJobRuns(5)).singleElement().satisfies(r -> {
            assertThat(r.job()).isEqualTo("kr.stopwatch.fill");
            assertThat(r.detail().path("recorded").get(0).path("orderId").asLong()).isEqualTo(id);
        });

        clock.now = kst("2026-11-17T13:15:40");
        assertThat(step.run(KrPaperMarket.INSTANCE).recorded()).as("한 번만").isEmpty();
        assertThat(store.recentJobRuns(5)).as("할 일이 없으면 기록하지 않음").hasSize(1);
    }

    @Test
    @DisplayName("관문에 걸리면 사유를 남겨 밤에 맡김 — 장부 밀림(G2)·같은 시각 Claude 주문(G3)·미처리 기업행위(G4)·금융위 시장 구분 없음, 다른 종목 STOP은 함께 RECORD")
    void gatesDefer() {
        long a = stop(A, "2026-11-17T13:10:42");
        long b = stop(B, "2026-11-17T13:10:50");
        tickers.set(B, entry(S, kst("2026-11-17T13:15:20"), minutes("12:55", "13:15", 140_000), List.of()));
        step.run(KrPaperMarket.INSTANCE);
        assertThat(record(a).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.RECORD);
        assertThat(record(b).path(KrIntradayFill.OUTCOME).asString()).as("다른 종목 STOP 매도끼리는 막지 않음").isEqualTo(KrIntradayFill.RECORD);

        // 새 주문 둘 — 다른 조건에서.
        store.orders.clear();
        long gated = stop(A, "2026-11-17T13:10:42");
        store.insertOrder(new Order(0, BOOK, null, "035420", PaperBooks.BUY, null, 5.0, null, PaperBooks.AT_MINUTE, RuleBookService.SOURCE_RULE,
                PaperBooks.ORDER_PENDING, null, null, PREV, kst("2026-11-16T22:40"), S.plusDays(2), null, LocalTime.of(13, 0)));
        store.corpHolds.computeIfAbsent(BOOK, k -> new TreeMap<>()).put(A, "2026-11-16 기업행위 확인 필요 — 시험");
        when(marketData.fscMarkets(any())).thenReturn(Map.of());
        store.states.put(BOOK, new BookState(BOOK, 5_000_000, 6_400_000, 1_400_000, 21.875, kst("2026-11-13T20:40"),
                kst("2026-11-13T20:40"), LocalDate.of(2026, 11, 13), null));                                    // 마지막 처리 11-13 — S−1 밤 전
        step.run(KrPaperMarket.INSTANCE);
        assertThat(record(gated).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.DEFER);
        assertThat(record(gated).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString).containsExactly(KrIntradayFill.LEDGER_BEHIND,
                KrIntradayFill.EARLIER_ORDER, KrIntradayFill.CORP_HOLD, KrIntradayFill.NO_FSC_MARKET);
        assertThat(record(gated).path(KrIntradayFill.RAW_PRICE).decimalValue()).as("R1 값은 남김(대조 통계)").isEqualByComparingTo("70170");
        assertThat(record(gated).path(KrIntradayFill.CASH_DELTA).isNull()).as("체결 조건 보류 — 비용 없음").isTrue();
    }

    @Test
    @DisplayName("R1 자료를 기다림 — 덜 굳은 항목·항목 없음은 쓰지 않고, 마감 1분 전부터 NO_R1로 한 번 남김")
    void givesUpBeforeTheClose() {
        long id = stop(A, "2026-11-17T13:10:42");
        tickers.set(A, entry(S, kst("2026-11-17T13:12:30"), minutes("12:55", "13:12", 70_000), List.of()));
        assertThat(step.run(KrPaperMarket.INSTANCE).skipped()).isEqualTo("R1 자료를 기다림");
        assertThat(store.orders.get(id).reason().has(KrIntradayFill.FIELD)).isFalse();
        tickers.remove(A);
        clock.now = kst("2026-11-17T15:28:50");
        assertThat(step.run(KrPaperMarket.INSTANCE).skipped()).isEqualTo("R1 자료를 기다림");
        clock.now = kst("2026-11-17T15:29:00");
        step.run(KrPaperMarket.INSTANCE);
        assertThat(record(id).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.DEFER);
        assertThat(record(id).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString).as("항목이 없으면 갭 가드도 판정하지 못함")
                .containsExactly(KrIntradayFill.NO_R1, KrIntradayFill.CORP_GUARD);
        assertThat(record(id).path("note").asString()).contains("감시 항목 없음");
        clock.now = kst("2026-11-17T15:30:00");
        assertThat(step.run(KrPaperMarket.INSTANCE).skipped()).as("마감 뒤").isEqualTo("기록 창 밖");
    }

    @Test
    @DisplayName("R1이 아님이 굳으면(라벨 T+1 봉 완성·거래 없음 — 사다리가 R2를 고름) 기다리지 않고 바로 NO_R1로 남김")
    void decidedNoR1IsRecordedAtOnce() {
        long id = stop(A, "2026-11-17T13:10:42");
        tickers.set(A, entry(S, kst("2026-11-17T13:15:20"), minutes("12:55", "13:15", 70_000), List.of("13:12")));
        step.run(KrPaperMarket.INSTANCE);
        assertThat(record(id).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.DEFER);
        assertThat(record(id).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString).containsExactly(KrIntradayFill.NO_R1);
        assertThat(record(id).path(KrIntradayFill.RAW_PRICE).isNull()).isTrue();
        assertThat(record(id).path("note").asString()).contains("TOSS_1M_NEXT");
    }

    @Test
    @DisplayName("스위치 — 유효 값 OFF(기록 OFF·감시 SHADOW)면 저장본·실행(공휴일 저장본)을 읽지 않고 아무것도 남기지 않음")
    void switchOff() {
        long id = stop(A, "2026-11-17T13:10:42");
        settings("ON", "OFF");
        assertThat(step.run(KrPaperMarket.INSTANCE).skipped()).contains("유효 값 OFF");
        settings("SHADOW", "SHADOW");
        assertThat(step.run(KrPaperMarket.INSTANCE).skipped()).contains("유효 값 OFF");
        verify(marketData, never()).stopWatch(anyBoolean());
        verify(reader, never()).read(org.mockito.ArgumentMatchers.eq(com.macrodash.store.Datasets.SNAP_KR_HOLIDAYS),
                org.mockito.ArgumentMatchers.anyLong(), any());
        assertThat(store.orders.get(id).reason().has(KrIntradayFill.FIELD)).isFalse();
        assertThat(store.recentJobRuns(5)).isEmpty();
    }

    @Test
    @DisplayName("ON — G5·R1이 갖춰진 첫 주기에 밤 auctionSell과 같은 칸으로 장부에 적음: 체결 행(관측 시각 = 감시 항목 수집 시각·관측일 S·R1), 주문 FILLED, "
            + "보유 삭제, 재진입 금지(체결한 날부터), 판정 근거 칸·intradayFill(ON·기록 시각·보유 사본·직전·직후 현금), 상태 네 칸만(마지막 관측·처리·순자산 줄 날짜 그대로)")
    void onWritesTheLedger() {
        settings("ON", "ON");
        long id = stop(A, "2026-11-17T13:10:42");
        Position held = store.positions.get(BOOK).get(A);
        BookState state = store.states.get(BOOK);

        KrStopFillStep.Outcome outcome = step.run(KrPaperMarket.INSTANCE);

        assertThat(outcome.error()).isNull();
        assertThat(outcome.recorded()).singleElement().satisfies(r -> assertThat(r.get("orderId")).isEqualTo(id));
        PaperSettings settings = PaperSettings.from(store.settings.body(), KrPaperMarket.INSTANCE);
        FillTerms terms = KrFills.termsFor(com.macrodash.analytics.PaperLedger.Side.SELL, A, new KrQuotes.Choice(S, BigDecimal.valueOf(70_170),
                KrTimedLadder.SOURCE_AT, null), "KOSPI", settings, KrPaperMarket.BENCHMARK_TICKERS);
        FillTerms.Costs costs = terms.costs(10);
        assertThat(store.fills.values()).singleElement().satisfies(f -> {
            assertThat(f.orderId()).isEqualTo(id);
            assertThat(f.qty()).isEqualTo(10);
            assertThat(f.rawPrice()).isEqualTo(70_170);
            assertThat(f.priceSource()).isEqualTo(KrTimedLadder.SOURCE_AT);
            assertThat(f.observedAt()).isEqualTo(kst("2026-11-17T13:15:20"));
            assertThat(f.observationDate()).isEqualTo(S);
            assertThat(f.fee()).isEqualByComparingTo(costs.fee());
            assertThat(f.tax()).isEqualByComparingTo(costs.tax());
        });
        Order filled = store.orders.get(id);
        assertThat(filled.status()).isEqualTo(PaperBooks.ORDER_FILLED);
        assertThat(filled.filledAt()).isEqualTo(kst("2026-11-17T13:15:20"));
        assertThat(store.positions.get(BOOK)).containsOnlyKeys(B);
        assertThat(store.lockouts.get(BOOK)).containsKey(A);
        assertThat(store.lockouts.get(BOOK).get(A).untilTradingDate()).isEqualTo(com.macrodash.analytics.TrailingStop.lockoutUntil(
                KrIntradayFillTest.CALENDAR, S, settings.lockoutTradingDays()));
        assertThat(filled.reason().path("stopBasis").asString()).isEqualTo(PaperLedgerService.STOP_BASIS_INTRADAY);
        assertThat(filled.reason().path("stopBasisNote").asString()).contains("장중 감시 STOP");
        JsonNode record = record(id);
        assertThat(record.path(KrIntradayFill.MODE).asString()).isEqualTo("ON");
        assertThat(record.path(KrIntradayFill.RECORDED_AT).asString()).isEqualTo(kst("2026-11-17T13:15:20").toString());
        assertThat(record.path(KrIntradayFill.BEFORE).path("qty").asInt()).isEqualTo(10);
        assertThat(KrIntradayFill.position(BOOK, A, record.path(KrIntradayFill.BEFORE))).as("보유 사본 — 되감기가 그대로 되살림").isEqualTo(held);
        double after = com.macrodash.analytics.PaperLedger.round4(state.cash() + costs.cashDelta());
        assertThat(record.path(KrIntradayFill.CASH_BEFORE).asDouble()).isEqualTo(state.cash());
        assertThat(record.path(KrIntradayFill.CASH_AFTER).asDouble()).isEqualTo(after);
        BookState now = store.states.get(BOOK);
        assertThat(now.cash()).isEqualTo(after);
        assertThat(now.equityValue()).as("남은 보유 B 5주 × 마지막 평가 가격").isEqualTo(5 * 140_000.0);
        assertThat(now.nav()).isEqualTo(com.macrodash.analytics.PaperLedger.round4(after + 5 * 140_000.0));
        assertThat(now.lastObservedAt()).isEqualTo(state.lastObservedAt());
        assertThat(now.lastProcessedCollectedAt()).isEqualTo(state.lastProcessedCollectedAt());
        assertThat(now.lastNavTradingDate()).isEqualTo(state.lastNavTradingDate());
        assertThat(store.recentJobRuns(5)).singleElement().satisfies(r -> assertThat(r.detail().path("mode").asString()).isEqualTo("ON"));

        clock.now = kst("2026-11-17T13:15:40");
        assertThat(step.run(KrPaperMarket.INSTANCE).recorded()).as("멱등 — 대기가 아님").isEmpty();
        assertThat(store.fills).hasSize(1);
    }

    @Test
    @DisplayName("ON — 관문에 걸리면 대기 그대로(밤 장부가 체결)·근거를 쓰지 않고 미룬 사유는 작업 기록에 처음 한 번, 같은 저장본으로는 다시 판정하지 않음, "
            + "막던 주문이 사라지고 새 저장본이 오면 적음")
    void onDefersUntilTheGateClears() {
        settings("ON", "ON");
        long id = stop(A, "2026-11-17T13:10:42");
        long blocking = store.insertOrder(new Order(0, BOOK, null, "035420", PaperBooks.BUY, null, 5.0, null, PaperBooks.AT_MINUTE,
                RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, PREV, kst("2026-11-16T22:40"), S.plusDays(2), null, LocalTime.of(13, 0)));

        KrStopFillStep.Outcome first = step.run(KrPaperMarket.INSTANCE);
        assertThat(first.recorded()).isEmpty();
        assertThat(first.deferred()).singleElement().satisfies(d -> assertThat(d.get(KrIntradayFill.REASONS))
                .isEqualTo(List.of(KrIntradayFill.EARLIER_ORDER)));
        assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.orders.get(id).reason().has(KrIntradayFill.FIELD)).as("ON은 미룬 판정을 근거에 쓰지 않음").isFalse();
        assertThat(store.fills).isEmpty();
        assertThat(store.recentJobRuns(5)).singleElement().satisfies(r -> assertThat(r.detail().path("deferred")).hasSize(1));

        clock.now = kst("2026-11-17T13:15:40");
        KrStopFillStep.Outcome second = step.run(KrPaperMarket.INSTANCE);
        assertThat(second.deferred()).as("같은 저장본 — 다시 판정하지 않음").isEmpty();
        verify(marketData, org.mockito.Mockito.times(1)).fscMarkets(any());
        assertThat(store.recentJobRuns(5)).as("할 일이 없으면 기록하지 않음").hasSize(1);

        store.markOrderStatus(blocking, PaperBooks.ORDER_CANCELLED, "장중 교체");
        clock.now = kst("2026-11-17T13:20:20");
        snapshot(kst("2026-11-17T13:20:20"));
        tickers.set(A, entry(S, kst("2026-11-17T13:20:20"), minutes("12:55", "13:20", 70_000), List.of()));
        assertThat(step.run(KrPaperMarket.INSTANCE).recorded()).singleElement().satisfies(r -> assertThat(r.get("orderId")).isEqualTo(id));
        assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_FILLED);
    }

    @Test
    @DisplayName("ON — 같은 분의 다른 종목 STOP 둘은 한 트랜잭션에 기준 시각 순으로 함께 적음(직전·직후 현금이 같은 한 기록)")
    void onWritesTwoStopsInOneTransaction() {
        settings("ON", "ON");
        long a = stop(A, "2026-11-17T13:10:42");
        long b = stop(B, "2026-11-17T13:10:50");
        tickers.set(B, entry(S, kst("2026-11-17T13:15:20"), minutes("12:55", "13:15", 140_000), List.of()));

        KrStopFillStep.Outcome outcome = step.run(KrPaperMarket.INSTANCE);

        assertThat(outcome.recorded()).hasSize(2);
        assertThat(store.positions.get(BOOK)).isEmpty();
        assertThat(record(a).path(KrIntradayFill.CASH_BEFORE).asDouble()).isEqualTo(record(b).path(KrIntradayFill.CASH_BEFORE).asDouble());
        assertThat(record(a).path(KrIntradayFill.CASH_AFTER).asDouble()).isEqualTo(record(b).path(KrIntradayFill.CASH_AFTER).asDouble());
        assertThat(store.states.get(BOOK).cash()).isEqualTo(record(a).path(KrIntradayFill.CASH_AFTER).asDouble());
        assertThat(store.states.get(BOOK).equityValue()).isZero();
        List<Fill> fills = store.fills.values().stream().sorted(java.util.Comparator.comparingLong(Fill::id)).toList();
        assertThat(PaperNotifyJob.batches(fills, PaperNotifyJob.FETCH_LIMIT, kst("2026-11-17T14:00"), Fill::bookCode, Fill::createdAt, Fill::id))
                .as("체결 알림 — 한 트랜잭션(같은 만든 시각)의 두 체결은 계좌 묶음 한 통").singleElement()
                .satisfies(batch -> assertThat(batch.rows()).hasSize(2));
    }

    @Test
    @DisplayName("ON — 잠금 안 다시 확인: 판정 뒤 쓰기 전에 그 책의 대기 주문이 바뀌면(새 주문) 그 책 기록을 버림(다음 주기에 다시 판정)")
    void onDiscardsWhenPendingOrdersChanged() {
        settings("ON", "ON");
        long id = stop(A, "2026-11-17T13:10:42");
        PaperLedgerService racing = new PaperLedgerService(store, marketData, MAPPER) {
            @Override
            <T> T exclusively(java.util.function.Supplier<T> work) {
                store.insertOrder(new Order(0, BOOK, null, "035420", PaperBooks.BUY, null, 5.0, null, PaperBooks.NEXT_OPEN, "CLAUDE",
                        PaperBooks.ORDER_PENDING, null, null, S, kst("2026-11-17T13:15:30"), S.plusDays(4), null));
                return super.exclusively(work);
            }
        };
        KrStopFillStep raced = new KrStopFillStep(store, reader, marketData, racing, PaperFixtures.config(), MAPPER, clock,
                new PaperMarkets(store, reader, List.of(KrPaperMarket.INSTANCE)));
        assertThat(raced.run(KrPaperMarket.INSTANCE).recorded()).isEmpty();
        assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.fills).isEmpty();
    }

    @Test
    @DisplayName("QA-790: ON 잠금 안 다시 확인 — 판정 입력(보유·기업행위 표시·since 거래량)을 읽은 뒤 마지막 처리 저장본을 읽기 전에 밤 장부 처리(S−1 재저장본)가 "
            + "대기 주문·보유 수량은 그대로 두고 기업행위 표시만 걸면, 그 책 기록을 버리고(대기 그대로) 다음 주기에 CORP_HOLD로 밤에 맡김")
    void onDiscardsWhenTheLedgerProcessedDuringTheEvaluation() {
        settings("ON", "ON");
        long id = stop(A, "2026-11-17T13:10:42");
        java.util.concurrent.atomic.AtomicBoolean processed = new java.util.concurrent.atomic.AtomicBoolean();
        when(marketData.krConfirmed(any(), any(), any())).thenAnswer(invocation -> {
            if (processed.compareAndSet(false, true)) {
                // 판정 입력을 읽은 뒤 확정 시세를 읽는 사이에 리스크 점검이 낮에 다시 저장된 S−1 관측치를 처리(잠금 밖 판정과 겹침) — 표시만 걸고 마지막 처리
                // 저장본을 옮김(S 13:15 수집 — 세션 S−1이라 장부 밀림은 아님).
                store.corpHolds.computeIfAbsent(BOOK, k -> new TreeMap<>()).put(A, "2026-11-17 기업행위 확인 필요 — 시험");
                BookState s = store.states.get(BOOK);
                store.states.put(BOOK, new BookState(BOOK, s.cash(), s.nav(), s.equityValue(), s.exposurePct(), s.lastObservedAt(),
                        kst("2026-11-17T13:15:00"), s.lastNavTradingDate(), s.updatedAt()));
            }
            return new KrConfirmed(Map.of(A, listed(), B, listed()));
        });

        KrStopFillStep.Outcome first = step.run(KrPaperMarket.INSTANCE);

        assertThat(first.error()).isNull();
        assertThat(first.recorded()).as("판정 뒤 처리가 끼면 버림").isEmpty();
        assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.fills).isEmpty();
        assertThat(store.positions.get(BOOK)).containsKey(A);

        clock.now = kst("2026-11-17T13:15:40");
        KrStopFillStep.Outcome second = step.run(KrPaperMarket.INSTANCE);
        assertThat(second.recorded()).isEmpty();
        assertThat(second.deferred()).singleElement().satisfies(d -> assertThat(d.get(KrIntradayFill.REASONS))
                .isEqualTo(List.of(KrIntradayFill.CORP_HOLD)));
        assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.fills).isEmpty();
    }

    @Test
    @DisplayName("밤 뒤 대조 — 밤이 같은 값으로 체결하면 check.match=true, 만료로 닫히면 NIGHT_NOT_FILLED와 운영 알림(건수·사유 코드), 대조는 한 번만")
    void checksAfterTheNight() {
        long same = stop(A, "2026-11-17T13:10:42");
        long expired = stop(B, "2026-11-17T13:10:50");
        tickers.set(B, entry(S, kst("2026-11-17T13:15:20"), minutes("12:55", "13:15", 140_000), List.of()));
        step.run(KrPaperMarket.INSTANCE);
        assertThat(record(same).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.RECORD);
        assertThat(record(expired).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.RECORD);

        // S 밤 처리(가짜) — A는 같은 값으로 체결, B는 만료.
        clock.now = kst("2026-11-17T21:05");
        store.dbNow = kst("2026-11-17T21:00");
        FillTerms.Costs costs = KrFills.termsFor(com.macrodash.analytics.PaperLedger.Side.SELL, A, new KrQuotes.Choice(S, BigDecimal.valueOf(70_170),
                KrTimedLadder.SOURCE_AT, null), "KOSPI", PaperSettings.from(store.settings.body(), KrPaperMarket.INSTANCE),
                KrPaperMarket.BENCHMARK_TICKERS).costs(10);   // 밤도 같은 체결 조건(같은 설정·시장 구분)
        store.insertFill(new Fill(0, same, BOOK, A, PaperBooks.SELL, 10, 70_170, 70_170, 5, 701_700, kst("2026-11-17T20:55"), S,
                KrTimedLadder.SOURCE_AT, false, kst("2026-11-17T21:00"), costs.fee(), costs.tax(), costs.slippageCost()));
        store.markOrderFilled(same, kst("2026-11-17T20:55"));
        store.markOrderStatus(expired, PaperBooks.ORDER_EXPIRED, "1분봉 없음");
        KrStopFillStep.Outcome outcome = step.run(KrPaperMarket.INSTANCE);
        assertThat(outcome.checks()).hasSize(2);
        assertThat(record(same).path(KrIntradayFill.CHECK).path("match").asBoolean()).isTrue();
        assertThat(record(same).path(KrIntradayFill.CHECK).path("nightSettingsVersion").asInt()).isEqualTo(store.settings.version());
        assertThat(record(expired).path(KrIntradayFill.CHECK).path("match").asBoolean(true)).isFalse();
        assertThat(record(expired).path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.NIGHT_NOT_FILLED);
        assertThat(outcome.alerts()).singleElement().satisfies(text -> assertThat(text).isEqualTo(
                "장중 체결 대조 불일치 1건 — 사유 {NIGHT_NOT_FILLED=1}"));
        assertThat(store.recentJobRuns(5).get(0).detail().path("alerts")).hasSize(1);

        clock.now = kst("2026-11-17T21:05:20");
        assertThat(step.run(KrPaperMarket.INSTANCE).checks()).as("대조는 한 번").isEmpty();
    }

    @Test
    @DisplayName("잠금 — 감시 저장본·금융위 시장 구분·확정 시세·장부 밀림 판정은 장부 잠금 밖에서 읽고, 잠금 안에서는 다시 읽지 않음(실제 매매 선점이 같은 잠금을 기다림)")
    void readsOutsideTheLedgerLock() throws Exception {
        long id = stop(A, "2026-11-17T13:10:42");
        AtomicInteger reads = new AtomicInteger();
        ObjectNode payload = MAPPER.createObjectNode().put("fetchedAt", kst("2026-11-17T13:15:20").toString()).put("mode", "ON");
        payload.set("tickers", tickers);
        when(marketData.stopWatch(true)).thenAnswer(invocation -> {
            reads.incrementAndGet();
            return Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null, kst("2026-11-17T13:15:21")));
        });
        when(marketData.fscMarkets(any())).thenAnswer(invocation -> {
            reads.incrementAndGet();
            return Map.of(A, "KOSPI");
        });
        when(marketData.krConfirmed(any(), any(), any())).thenAnswer(invocation -> {
            reads.incrementAndGet();
            return new KrConfirmed(Map.of(A, listed()));
        });
        when(marketData.quotes(any())).thenAnswer(invocation -> {
            reads.incrementAndGet();
            return Optional.empty();
        });
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<?> holder = pool.submit(() -> ledger.exclusively(() -> {
                locked.countDown();
                try {
                    release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return null;
            }));
            assertThat(locked.await(5, TimeUnit.SECONDS)).isTrue();
            Future<KrStopFillStep.Outcome> running = pool.submit(() -> step.run(KrPaperMarket.INSTANCE));
            long until = System.currentTimeMillis() + 5_000;
            while (reads.get() < 4 && System.currentTimeMillis() < until) {
                Thread.sleep(10);
            }
            Thread.sleep(200);
            assertThat(reads.get()).as("저장본·시장 구분·확정 시세·관측치(장부 밀림) — 잠금을 기다리기 전에 모두 읽음").isEqualTo(4);
            assertThat(running.isDone()).as("잠금을 쥔 다른 일을 기다림").isFalse();
            release.countDown();
            holder.get(5, TimeUnit.SECONDS);
            assertThat(running.get(5, TimeUnit.SECONDS).recorded()).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
        assertThat(reads.get()).as("잠금 안에서는 읽지 않음").isEqualTo(4);
        assertThat(record(id).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.RECORD);
    }

    @Test
    @DisplayName("잠금 안 다시 확인 — 판정 뒤 쓰기 전에 그 주문이 대기가 아니게 됐으면(밤 처리·일시정지) 버림")
    void discardsWhenTheOrderMovedOn() {
        long id = stop(A, "2026-11-17T13:10:42");
        PaperLedgerService racing = new PaperLedgerService(store, marketData, MAPPER) {
            @Override
            <T> T exclusively(java.util.function.Supplier<T> work) {
                store.cancelPendingOrders(BOOK);   // 판정과 잠금 사이에 일시정지
                return super.exclusively(work);
            }
        };
        KrStopFillStep raced = new KrStopFillStep(store, reader, marketData, racing, PaperFixtures.config(), MAPPER, clock,
                new PaperMarkets(store, reader, List.of(KrPaperMarket.INSTANCE)));
        assertThat(raced.run(KrPaperMarket.INSTANCE).recorded()).isEmpty();
        assertThat(store.orders.get(id).reason().has(KrIntradayFill.FIELD)).isFalse();
        assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
    }

    @Test
    @DisplayName("장중 스탑 감시 작업이 한국 판정 뒤 주기마다 단계를 부름 — 판정 쪽이 '판정 창 밖'으로 일찍 끝나도")
    void jobCallsTheStepEveryCycle() {
        long id = stop(A, "2026-11-17T13:10:42");
        PaperStopWatchJob job = new PaperStopWatchJob(store, reader, marketData, ledger, PaperFixtures.config(), MAPPER, clock,
                new PaperMarkets(store, reader, List.of(KrPaperMarket.INSTANCE)));
        when(marketData.stopWatch(true)).thenReturn(Optional.empty());
        job.run();
        assertThat(job.lastFill()).isNotNull();
        assertThat(job.lastFill().skipped()).isEqualTo("R1 자료를 기다림");
        snapshot(kst("2026-11-17T13:15:20"));
        job.run();
        assertThat(record(id).path(KrIntradayFill.OUTCOME).asString()).isEqualTo(KrIntradayFill.RECORD);
    }
}
