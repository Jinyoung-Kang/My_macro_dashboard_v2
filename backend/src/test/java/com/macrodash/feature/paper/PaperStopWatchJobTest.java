package com.macrodash.feature.paper;

import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 장중 스탑 감시 작업(ADR 0032) — ON은 STOP 한 건(멱등), SHADOW는 기록만, OFF는 읽지 않음, 갭 가드·제외·창 밖·늦은 저장본, 한국 최고가 보정.
 *
 * <p>시각: 미국 2026-11-09(월, 표준시 — 09:30 ET = 14:30Z, 전 거래일 11-06). 한국 같은 날. 스탑 8% — 최고가 100이면 스탑가 92.
 */
class PaperStopWatchJobTest {

    private static final LocalDate DAY = LocalDate.of(2026, 11, 9);
    private static final LocalDate PREV = LocalDate.of(2026, 11, 6);

    private FakePaperStore store;
    private PaperMarketData marketData;
    private StoreReader reader;
    private PaperCheckpointJobTest.MovableClock clock;
    private PaperStopWatchJob job;

    private static Instant et(int h, int m, int s) {
        return ZonedDateTime.of(DAY, LocalTime.of(h, m, s), UsMarketCalendar.NEW_YORK).toInstant();
    }

    private static Instant kst(int h, int m, int s) {
        return ZonedDateTime.of(DAY, LocalTime.of(h, m, s), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        clock = new PaperCheckpointJobTest.MovableClock(et(10, 20, 40));
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        job = new PaperStopWatchJob(store, reader, marketData, ledger, PaperFixtures.config(), PaperFixtures.MAPPER, clock,
                new PaperMarkets(store, reader, List.of(UsPaperMarket.INSTANCE, KrPaperMarket.INSTANCE)));
    }

    private void settings(String usMode, String krMode) {
        ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
        ((ObjectNode) body.get("stopWatch")).put("mode", usMode);
        ((ObjectNode) body.get("kr").get("stopWatch")).put("mode", krMode);
        store.initSettingsIfAbsent(body);
    }

    private void usBook(String code, String kind, String status) {
        store.books.put(code, new Book(code, kind, code, 100_000, PaperFixtures.FRI, status, PaperFixtures.FRI_CLOSE,
                Book.MARKET_US, Book.CURRENCY_USD));
        store.states.put(code, new BookState(code, 1000, 1000, 0, 0, null, null, null, null));
    }

    private void hold(String book, String ticker, double watermark, LocalDate refDate, double refClose) {
        store.upsertPosition(new Position(book, ticker, 10, 90, PaperFixtures.FRI, PaperFixtures.FRI_CLOSE, watermark,
                PaperFixtures.FRI_CLOSE, null, null, false, refDate, refClose, null));
    }

    /** 미국 감시 저장본 — 종목마다 09:30부터 {@code until}(봉 시작)까지의 봉, 10:10부터는 {@code low}. */
    private void usSnapshot(Instant fetchedAt, Instant collectedAt, Map<String, double[]> tickers, Instant until) {
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("fetchedAt", fetchedAt.toString());
        ObjectNode entries = payload.putObject("tickers");
        tickers.forEach((ticker, prices) -> {
            Map<Instant, Double> bars = new LinkedHashMap<>();
            for (Instant at = et(9, 30, 0); !at.isAfter(until); at = at.plus(Duration.ofMinutes(1))) {
                bars.put(at, at.isBefore(et(10, 10, 0)) ? prices[0] : prices[1]);
            }
            entries.set(ticker, StopWatchTest.usEntry(DAY, bars, prices[0], prices.length > 2 ? prices[2] : null));
        });
        when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json",
                "ok", null, collectedAt)));
    }

    private List<Order> stops() {
        return store.orders.values().stream().filter(o -> PaperBooks.SOURCE_STOP.equals(o.source())).toList();
    }

    @Test
    @DisplayName("ON — 두 격자 모두 스탑가 이하면 STOP 한 건(T = 감지 + 60초 뒤 첫 분 시장가), 같은 저장본·다음 저장본에도 다시 내지 않음")
    void onPlacesOneStop() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        hold(PaperBooks.RULES, "BBB", 100, PREV, 99);
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("AAA", new double[]{99, 91}, "BBB", new double[]{99, 93}), et(10, 19, 0));

        List<PaperStopWatchJob.Outcome> outcomes = job.run();

        assertThat(outcomes.get(0).grids()).containsExactly(et(10, 20, 0));
        assertThat(stops()).singleElement().satisfies(o -> {
            assertThat(o.ticker()).isEqualTo("AAA");
            assertThat(o.side()).isEqualTo(PaperBooks.SELL);
            assertThat(o.qty()).isNull();
            assertThat(o.timing()).isEqualTo(PaperBooks.MARKET);
            assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(o.decisionId()).isNull();
            assertThat(o.asOfTradingDate()).isEqualTo(PREV);
            assertThat(o.createdAt()).isEqualTo(et(10, 20, 40));
            assertThat(o.expiresOn()).isEqualTo(DAY);
            assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperStopWatchJob.STOP_MODE);
            assertThat(o.reason().path("stopPrice").asDouble()).isEqualTo(92.0);
            assertThat(o.reason().path("checks")).hasSize(2);
            assertThat(o.reason().path("targetAt").asString()).isEqualTo(et(10, 22, 0).toString());
            assertThat(o.reason().path("note").asString()).contains("10:15", "10:20", "10:22 ET 시장가 매도");
        });
        assertThat(store.recentJobRuns(5)).singleElement().satisfies(r -> assertThat(r.job()).isEqualTo("stopwatch"));

        clock.now = et(10, 21, 0);
        job.run();
        usSnapshot(et(10, 25, 20), et(10, 25, 21), Map.of("AAA", new double[]{99, 91}, "BBB", new double[]{99, 93}), et(10, 24, 0));
        clock.now = et(10, 25, 40);
        job.run();
        assertThat(stops()).as("대기 STOP이 곧 '이미 냄'").hasSize(1);
    }

    @Test
    @DisplayName("SHADOW — 주문 없이 '걸렸을 것'만 그 세션에 한 번 기록, OFF는 저장본도 읽지 않음")
    void shadowAndOff() {
        settings("SHADOW", "OFF");
        usBook(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, PaperBooks.ACTIVE);
        hold(PaperBooks.CLAUDE, "AAA", 100, PREV, 99);
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("AAA", new double[]{99, 91}), et(10, 19, 0));

        PaperStopWatchJob.Outcome outcome = job.run().get(0);

        assertThat(stops()).isEmpty();
        assertThat(outcome.wouldStop()).singleElement().satisfies(w -> assertThat(w.get("ticker")).isEqualTo("AAA"));
        assertThat(store.recentJobRuns(5)).singleElement().satisfies(r ->
                assertThat(r.detail().path("wouldStop").get(0).path("book").asString()).isEqualTo(PaperBooks.CLAUDE));
        usSnapshot(et(10, 25, 20), et(10, 25, 21), Map.of("AAA", new double[]{99, 91}), et(10, 24, 0));
        clock.now = et(10, 25, 40);
        assertThat(job.run().get(0).wouldStop()).as("같은 세션에 다시 기록하지 않음").isEmpty();
        assertThat(store.recentJobRuns(5)).hasSize(1);

        FakePaperStore off = new FakePaperStore();
        PaperMarketData untouched = mock(PaperMarketData.class);
        PaperStopWatchJob offJob = new PaperStopWatchJob(off, reader, untouched, new PaperLedgerService(off, untouched, PaperFixtures.MAPPER),
                PaperFixtures.config(), PaperFixtures.MAPPER, clock, new PaperMarkets(off, reader, List.of(UsPaperMarket.INSTANCE)));
        off.initSettingsIfAbsent(PaperFixtures.settings(off).defaultsJson());
        assertThat(offJob.run().get(0).skipped()).contains("스위치 꺼짐");
        verify(untouched, never()).stopWatch(anyBoolean());
    }

    @Test
    @DisplayName("벤치마크·일시정지 책, 현금성, 앞선 전량 매도 대기 종목은 보지 않고, 갭 가드 종목은 그날 한 번 기록하고 뺌")
    void exclusionsAndGuard() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        usBook(PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, PaperBooks.PAUSED);
        usBook(PaperBooks.BENCH_SPY, PaperBooks.KIND_BENCHMARK, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "SHY", 100, PREV, 99);
        hold(PaperBooks.RULES, "SOLD", 100, PREV, 99);
        hold(PaperBooks.RULES, "GAP", 200, PREV, 200);        // 첫 분 99 ≤ 200 × 0.85 — 분할형 갭
        hold(PaperBooks.CLAUDE2, "AAA", 100, PREV, 99);
        hold(PaperBooks.BENCH_SPY, "AAA", 100, PREV, 99);
        store.insertOrder(new Order(0, PaperBooks.RULES, 7L, "SOLD", PaperBooks.SELL, null, null, null, PaperBooks.AT_MINUTE,
                RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, PREV, et(6, 30, 0), DAY.plusDays(3), null,
                LocalTime.of(9, 40)));
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("SHY", new double[]{99, 91}, "SOLD", new double[]{99, 91},
                "GAP", new double[]{99, 91}, "AAA", new double[]{99, 91}), et(10, 19, 0));

        PaperStopWatchJob.Outcome outcome = job.run().get(0);

        assertThat(stops()).isEmpty();
        assertThat(outcome.guards()).singleElement().satisfies(g -> {
            assertThat(g.get("ticker")).isEqualTo("GAP");
            assertThat((String) g.get("reason")).contains("0.85");
        });
    }

    @Test
    @DisplayName("개장 10분 전·마감 뒤에는 판정하지 않고, 저장본이 늦으면 판정하지 않으며 세션 중 15분 넘게 늦으면 한 번 기록")
    void windowAndLateSnapshot() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("AAA", new double[]{99, 91}), et(10, 19, 0));
        clock.now = et(9, 39, 0);
        assertThat(job.run().get(0).skipped()).contains("창 밖");
        clock.now = et(16, 6, 0);
        assertThat(job.run().get(0).skipped()).contains("창 밖");

        clock.now = et(10, 40, 0);   // 저장본 수집 10:20:21 — 7분 넘게 지남
        PaperStopWatchJob.Outcome late = job.run().get(0);
        assertThat(late.late()).contains("15분");
        assertThat(stops()).isEmpty();
        clock.now = et(10, 41, 0);
        assertThat(job.run().get(0).late()).as("세션에 한 번").isNull();
        assertThat(store.recentJobRuns(5)).hasSize(1);
    }

    @Test
    @DisplayName("한국 — 최고가는 저장 값과 금융위 확정 종가(전날까지) 중 큰 값, 미처리 기업행위 보유는 보지 않음, STOP은 kr.stopwatch로 기록")
    void koreaWatermarkAndHolds() {
        settings("OFF", "ON");
        clock.now = kst(10, 20, 40);
        store.books.put(PaperBooks.KR_RULES, new Book(PaperBooks.KR_RULES, PaperBooks.KIND_RULES, "한국 규칙", 100_000_000,
                LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(PaperBooks.KR_RULES, new BookState(PaperBooks.KR_RULES, 1000, 1000, 0, 0, null, null, null, null));
        store.upsertPosition(new Position(PaperBooks.KR_RULES, "005930", 10, 48_000, LocalDate.of(2026, 11, 2), PaperFixtures.FRI_CLOSE,
                50_000, PaperFixtures.FRI_CLOSE, null, null, false, PREV, 50_500, null));
        store.upsertPosition(new Position(PaperBooks.KR_RULES, "000660", 10, 48_000, LocalDate.of(2026, 11, 2), PaperFixtures.FRI_CLOSE,
                50_000, PaperFixtures.FRI_CLOSE, null, null, false, PREV, 50_500, null));
        store.holdForCorpAction(PaperBooks.KR_RULES, "000660", "시험 보류");
        TreeMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
        days.put(PREV, new KrConfirmed.Day(PREV, BigDecimal.valueOf(55_000), 1000L, null, null, "KOSPI"));
        KrConfirmed confirmed = new KrConfirmed(Map.of("005930", new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, PREV, days)));
        when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenReturn(confirmed);

        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("fetchedAt", kst(10, 20, 20).toString());
        ObjectNode entries = payload.putObject("tickers");
        Map<String, Double> bars = new LinkedHashMap<>();
        for (int m = 6; m <= 20; m++) {
            bars.put(String.format("10:%02d", m), 50_000.0);
        }
        entries.set("005930", StopWatchTest.krEntry(DAY, bars, List.of(), 50_500.0, 50_500.0, 50_500.0));
        entries.set("000660", StopWatchTest.krEntry(DAY, bars, List.of(), 50_500.0, 50_500.0, 50_500.0));
        when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null,
                kst(10, 20, 21))));

        job.run();

        assertThat(stops()).singleElement().satisfies(o -> {
            assertThat(o.ticker()).isEqualTo("005930");
            assertThat(o.reason().path("highWatermark").asDouble()).as("저장 50,000 < 금융위 11-06 55,000").isEqualTo(55_000.0);
            assertThat(o.reason().path("storedHighWatermark").asDouble()).isEqualTo(50_000.0);
            assertThat(o.reason().path("stopPrice").asDouble()).isEqualTo(50_600.0);
            assertThat(o.reason().path("note").asString()).contains("KST");
        });
        assertThat(store.recentJobRuns(5)).singleElement().satisfies(r -> assertThat(r.job()).isEqualTo("kr.stopwatch"));
    }
}
