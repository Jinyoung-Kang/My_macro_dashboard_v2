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
        // 16:06(판정 창 끝 16:05 뒤)의 회차는 그 세션 요약 한 줄도 남김(살아 있음 신호) — 늦음 기록은 하나
        assertThat(store.recentJobRuns(5)).extracting(r -> r.job()).containsExactlyInAnyOrder("stopwatch", "stopwatch.summary");
    }

    @Test
    @DisplayName("QA-319: 저장본이 7분 넘었지만 15분 안이면(미국 :15:20 회차 쉼) 늦음을 남기지 않고, 실제로 15분 넘게 늦을 때 세션에 한 번 남김")
    void lateOnlyWhenTheSnapshotIsReallyLate() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshot(et(10, 10, 20), et(10, 10, 21), Map.of("AAA", new double[]{99, 99}), et(10, 9, 0));

        clock.now = et(10, 18, 0);   // 저장본 나이 7분 39초 — 판정은 하지 않지만 늦음도 아님
        PaperStopWatchJob.Outcome rest = job.run().get(0);
        assertThat(rest.late()).isNull();
        assertThat(store.recentJobRuns(5)).isEmpty();

        clock.now = et(10, 26, 0);   // 15분 39초 — 늦음
        assertThat(job.run().get(0).late()).contains("15분");
        clock.now = et(10, 27, 0);
        assertThat(job.run().get(0).late()).as("세션에 한 번").isNull();
        assertThat(store.recentJobRuns(5)).hasSize(1);
    }

    @Test
    @DisplayName("쉰 회차가 있어도 다음 저장본으로 그 사이 격자를 판정 — 10:25·10:30 두 번 아래였다가 10:35에 회복해도 10:30 격자로 STOP")
    void missedGridsAreJudgedFromTheNextSnapshot() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("AAA", new double[]{99, 99}), et(10, 19, 0));
        job.run();
        assertThat(stops()).isEmpty();

        // 10:25 회차는 쉼(slow 군) — 10:35 저장본에 10:20~10:29 봉은 91, 10:30~10:34 봉은 99
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("fetchedAt", et(10, 35, 20).toString());
        Map<Instant, Double> bars = new LinkedHashMap<>();
        for (Instant at = et(9, 30, 0); !at.isAfter(et(10, 34, 0)); at = at.plus(Duration.ofMinutes(1))) {
            bars.put(at, !at.isBefore(et(10, 20, 0)) && at.isBefore(et(10, 30, 0)) ? 91.0 : 99.0);
        }
        payload.putObject("tickers").set("AAA", StopWatchTest.usEntry(DAY, bars, 99.0, null));
        when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok",
                null, et(10, 35, 21))));
        clock.now = et(10, 35, 40);

        PaperStopWatchJob.Outcome outcome = job.run().get(0);

        assertThat(outcome.grids()).containsExactly(et(10, 25, 0), et(10, 30, 0), et(10, 35, 0));
        assertThat(stops()).singleElement().satisfies(o ->
                assertThat(o.reason().path("checks").get(1).path("grid").asString()).isEqualTo(et(10, 30, 0).toString()));
    }

    @Test
    @DisplayName("개장 전부터 떠 있던 프로세스가 세션 첫 판정 전 회차들을 놓쳐도 다음 저장본으로 09:40부터 판정 — 09:35~09:49 아래였다가 09:50에 회복해도 09:45 격자로 STOP(QA-306)")
    void missedFirstGridsOfTheSessionAreJudged() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        clock.now = et(8, 0, 0);
        assertThat(job.run().get(0).skipped()).contains("창 밖");

        // 09:40:20~09:50:20 회차는 없음(spark 거부 뒤 쉼) — 09:55:20 저장본에 09:35~09:49 봉은 91, 그 밖은 99
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("fetchedAt", et(9, 55, 20).toString());
        Map<Instant, Double> bars = new LinkedHashMap<>();
        for (Instant at = et(9, 30, 0); !at.isAfter(et(9, 54, 0)); at = at.plus(Duration.ofMinutes(1))) {
            bars.put(at, !at.isBefore(et(9, 35, 0)) && at.isBefore(et(9, 50, 0)) ? 91.0 : 99.0);
        }
        payload.putObject("tickers").set("AAA", StopWatchTest.usEntry(DAY, bars, 99.0, null));
        when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok",
                null, et(9, 55, 21))));
        clock.now = et(9, 55, 40);

        PaperStopWatchJob.Outcome outcome = job.run().get(0);

        assertThat(outcome.grids()).containsExactly(et(9, 40, 0), et(9, 45, 0), et(9, 50, 0), et(9, 55, 0));
        assertThat(stops()).singleElement().satisfies(o ->
                assertThat(o.reason().path("checks").get(1).path("grid").asString()).isEqualTo(et(9, 45, 0).toString()));
    }

    @Test
    @DisplayName("세션 중 재기동(그 세션 상태를 첫 판정 격자 뒤에 엶)은 가장 최근 격자 하나만 판정(대조)")
    void restartJudgesOnlyTheLatestGrid() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("AAA", new double[]{99, 99}), et(10, 19, 0));

        assertThat(job.run().get(0).grids()).containsExactly(et(10, 20, 0));
    }

    @Test
    @DisplayName("한국 0.2주 무상증자형 갭 −17%(첫 봉 시가 41,500 ≤ 전일 원시 종가 50,000 × 0.85)는 주문 없이 가드 기록, 달력이 그해를 모르면 오류 없이 건너뜀")
    void koreaGapGuardAndUnknownCalendar() {
        settings("OFF", "ON");
        clock.now = kst(10, 20, 40);
        store.books.put(PaperBooks.KR_RULES, new Book(PaperBooks.KR_RULES, PaperBooks.KIND_RULES, "한국 규칙", 100_000_000,
                LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(PaperBooks.KR_RULES, new BookState(PaperBooks.KR_RULES, 1000, 1000, 0, 0, null, null, null, null));
        store.upsertPosition(new Position(PaperBooks.KR_RULES, "005930", 10, 48_000, LocalDate.of(2026, 11, 2), PaperFixtures.FRI_CLOSE,
                55_000, PaperFixtures.FRI_CLOSE, null, null, false, PREV, 50_000, null));
        when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenReturn(KrConfirmed.NONE);
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("fetchedAt", kst(10, 20, 20).toString());
        Map<String, Double> bars = new LinkedHashMap<>();
        for (int m = 6; m <= 20; m++) {
            bars.put(String.format("10:%02d", m), 41_000.0);
        }
        payload.putObject("tickers").set("005930", StopWatchTest.krEntry(DAY, bars, List.of(), 41_500.0, 50_000.0, 50_000.0));
        when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null,
                kst(10, 20, 21))));

        PaperStopWatchJob.Outcome outcome = job.run().get(1);

        assertThat(stops()).isEmpty();
        assertThat(outcome.guards()).singleElement().satisfies(g -> assertThat((String) g.get("reason")).contains("41500", "50000"));
        assertThat(store.recentJobRuns(5)).singleElement().satisfies(r -> assertThat(r.job()).isEqualTo("kr.stopwatch"));

        clock.now = ZonedDateTime.of(LocalDate.of(2028, 1, 4), LocalTime.of(10, 20, 40), KrxCalendar.SEOUL).toInstant();
        PaperStopWatchJob.Outcome unknown = job.run().get(1);
        assertThat(unknown.error()).isNull();
        assertThat(unknown.skipped()).startsWith(CalendarGaps.NO_CALENDAR);
    }

    @Test
    @DisplayName("한국 — 체결될 수 없는 대기 주문(만료가 지난 감시 STOP·전량 매도)과 지난 세션이 목표인 STOP은 오늘 감시를 막지 않음(QA-318)")
    void staleOrdersDoNotBlockTodaysWatch() {
        settings("OFF", "ON");
        clock.now = kst(10, 20, 40);
        store.books.put(PaperBooks.KR_RULES, new Book(PaperBooks.KR_RULES, PaperBooks.KIND_RULES, "한국 규칙", 100_000_000,
                LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(PaperBooks.KR_RULES, new BookState(PaperBooks.KR_RULES, 1000, 1000, 0, 0, null, null, null, null));
        when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenReturn(KrConfirmed.NONE);
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("fetchedAt", kst(10, 20, 20).toString());
        ObjectNode entries = payload.putObject("tickers");
        Map<String, Double> bars = new LinkedHashMap<>();
        for (int m = 6; m <= 20; m++) {
            bars.put(String.format("10:%02d", m), 45_000.0);   // 아침 내내 스탑가 50,600 한참 아래
        }
        LocalDate thu = LocalDate.of(2026, 11, 5);
        for (String code : List.of("005930", "000660", "035720")) {
            store.upsertPosition(new Position(PaperBooks.KR_RULES, code, 10, 48_000, LocalDate.of(2026, 11, 2), PaperFixtures.FRI_CLOSE,
                    55_000, PaperFixtures.FRI_CLOSE, null, null, false, PREV, 50_500, null));
            entries.set(code, StopWatchTest.krEntry(DAY, bars, List.of(), 50_000.0, 50_500.0, 50_500.0));
        }
        ObjectNode watch = PaperFixtures.MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE);
        ObjectNode night = PaperFixtures.MAPPER.createObjectNode().put("stopMode", PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
        // 금요일 11-06 감시 STOP(만료 11-06) — 11-06 밤에 체결하지 못해(T 뒤 거래 없음) 월요일에도 대기(한국 만료는 다음 밤 관측치 처리 때만 돎).
        store.insertOrder(new Order(0, PaperBooks.KR_RULES, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, watch, thu, ZonedDateTime.of(PREV, LocalTime.of(13, 0),
                KrxCalendar.SEOUL).toInstant(), PREV, null));
        // 목표 세션이 11-06인 밤 대체 STOP(만료 기준일 + 3거래일 — 아직 지나지 않음) — 11-06 09:10 값으로만 팔 수 있음.
        store.insertOrder(new Order(0, PaperBooks.KR_RULES, null, "000660", PaperBooks.SELL, null, null, null, PaperBooks.AT_MINUTE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, night, thu, ZonedDateTime.of(thu, LocalTime.of(21, 15),
                KrxCalendar.SEOUL).toInstant(), LocalDate.of(2026, 11, 10), null, LocalTime.of(9, 10)));
        // 만료가 지난(11-06) 전량 매도 규칙 주문 — 다음 밤 만료가 닫을 뿐 체결될 수 없음.
        store.insertOrder(new Order(0, PaperBooks.KR_RULES, 7L, "035720", PaperBooks.SELL, null, null, null, PaperBooks.NEXT_OPEN,
                RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, LocalDate.of(2026, 11, 3),
                ZonedDateTime.of(LocalDate.of(2026, 11, 3), LocalTime.of(22, 30), KrxCalendar.SEOUL).toInstant(), PREV, null));
        when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null,
                kst(10, 20, 21))));

        job.run();

        assertThat(stops()).filteredOn(o -> DAY.equals(o.expiresOn())).extracting(Order::ticker)
                .containsExactlyInAnyOrder("005930", "000660", "035720");
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

    // ------------------------------------------------------------------ 살아 있음 신호(조용한 날과 '돌지 않음'을 가르게)

    private PaperStopWatchJob jobWith(StopWatchStatus status) {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        return new PaperStopWatchJob(store, reader, marketData, ledger, PaperFixtures.config(), PaperFixtures.MAPPER, clock,
                new PaperMarkets(store, reader, List.of(UsPaperMarket.INSTANCE, KrPaperMarket.INSTANCE)), status);
    }

    @Test
    @DisplayName("지금 상태 — 쉰 회차는 시각·사유만, 판정한 회차는 판정 격자·저장본 수집 시각·그 세션의 회차·격자·계좌 종목·STOP 수, 끄면 지움")
    void liveStatusPerMarket() {
        StopWatchStatus status = new StopWatchStatus();
        PaperStopWatchJob watched = jobWith(status);
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        hold(PaperBooks.RULES, "BBB", 100, PREV, 99);
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("AAA", new double[]{99, 91}, "BBB", new double[]{99, 93}), et(10, 19, 0));

        clock.now = et(9, 0, 0);
        watched.run();
        assertThat(status.view("US")).hasValueSatisfying(v -> {
            assertThat(v.mode()).isEqualTo("ON");
            assertThat(v.session()).isEqualTo(DAY);
            assertThat(v.sessionOpenedAt()).isEqualTo(et(9, 0, 0));
            assertThat(v.lastCycleAt()).isEqualTo(et(9, 0, 0));
            assertThat(v.lastSkipped()).isEqualTo("판정 창 밖");
            assertThat(v.cyclesJudged()).isZero();
            assertThat(v.snapshotCollectedAt()).as("창 밖에서는 저장본을 읽지 않음").isNull();
        });
        assertThat(status.view("KR")).as("한국은 계좌가 없어 쉼 — 칸을 만들지 않음").isEmpty();

        clock.now = et(10, 20, 40);
        PaperStopWatchJob.Outcome judged = watched.run().get(0);
        assertThat(judged.grids()).hasSizeGreaterThan(1).last().isEqualTo(et(10, 20, 0));
        assertThat(status.view("US")).hasValueSatisfying(v -> {
            assertThat(v.lastSkipped()).isNull();
            assertThat(v.lastJudgedGrid()).isEqualTo(et(10, 20, 0));
            assertThat(v.lastJudgedAt()).isEqualTo(et(10, 20, 40));
            assertThat(v.snapshotCollectedAt()).isEqualTo(et(10, 20, 21));
            assertThat(v.cyclesJudged()).isOne();
            assertThat(v.gridsJudged()).isEqualTo(judged.grids().size());
            assertThat(v.tickersJudged()).isEqualTo(2);
            assertThat(v.stops()).isOne();
            assertThat(v.wouldStops()).isZero();
        });

        clock.now = et(10, 21, 0);
        watched.run();
        assertThat(status.view("US")).hasValueSatisfying(v -> {
            assertThat(v.lastCycleAt()).isEqualTo(et(10, 21, 0));
            assertThat(v.lastSkipped()).isEqualTo("이미 본 저장본");
            assertThat(v.cyclesJudged()).as("쉰 회차는 세지 않음").isOne();
            assertThat(v.lastJudgedGrid()).isEqualTo(et(10, 20, 0));
        });

        ((ObjectNode) store.settings.body().get("stopWatch")).put("mode", "OFF");
        watched.run();
        assertThat(status.view("US")).isEmpty();
    }

    @Test
    @DisplayName("세션 요약 — 판정 창이 끝난 뒤 첫 회차에 stopwatch.summary 한 줄(그 세션의 수, 세션 중 열었으면 partial), 다음 회차·재기동에도 한 줄")
    void sessionSummaryOncePerSession() {
        settings("SHADOW", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshot(et(10, 20, 20), et(10, 20, 21), Map.of("AAA", new double[]{99, 91}), et(10, 19, 0));
        clock.now = et(10, 20, 40);   // 세션 중 기동 — 가장 최근 격자 하나만
        assertThat(job.run().get(0).wouldStop()).hasSize(1);

        clock.now = et(16, 5, 0);
        job.run();
        assertThat(store.recentJobRuns("stopwatch.summary", 5)).as("판정 창(마감 + 5분) 안 — 아직").isEmpty();

        clock.now = et(16, 5, 20);
        job.run();
        assertThat(store.recentJobRuns("stopwatch.summary", 5)).singleElement().satisfies(r -> {
            assertThat(r.outcome()).isEqualTo("OK");
            assertThat(r.detail().path("market").asString()).isEqualTo("US");
            assertThat(r.detail().path("mode").asString()).isEqualTo("SHADOW");
            assertThat(r.detail().path("tradingDate").asString()).isEqualTo(DAY.toString());
            assertThat(r.detail().path("since").asString()).isEqualTo(et(10, 20, 40).toString());
            assertThat(r.detail().path("partial").asBoolean()).isTrue();
            assertThat(r.detail().path("cyclesJudged").asInt()).isOne();
            assertThat(r.detail().path("gridsJudged").asInt()).isOne();
            assertThat(r.detail().path("tickersJudged").asInt()).isOne();
            assertThat(r.detail().path("wouldStops").asInt()).isOne();
            assertThat(r.detail().path("stops").asInt()).isZero();
            assertThat(r.detail().path("guarded").asInt()).isZero();
            assertThat(r.detail().path("lastJudgedGrid").asString()).isEqualTo(et(10, 20, 0).toString());
            assertThat(r.detail().path("lastSnapshotCollectedAt").asString()).isEqualTo(et(10, 20, 21).toString());
        });
        clock.now = et(16, 5, 40);
        job.run();
        clock.now = et(20, 0, 0);
        job.run();
        assertThat(store.recentJobRuns("stopwatch.summary", 5)).as("세션에 한 번").hasSize(1);

        // 재기동 — 판정 창 끝 전에 연 새 프로세스도 같은 세션의 줄이 이미 있으면 남기지 않음
        PaperStopWatchJob restarted = jobWith(new StopWatchStatus());
        clock.now = et(15, 59, 0);
        restarted.run();
        clock.now = et(16, 6, 0);
        restarted.run();
        assertThat(store.recentJobRuns("stopwatch.summary", 5)).hasSize(1);
    }

    @Test
    @DisplayName("세션 요약 — 마감 뒤 기동(그 세션 판정 창을 못 봄)·거래일 아님·스위치 꺼짐은 남기지 않고, 한국은 kr.stopwatch.summary")
    void sessionSummaryConditions() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        clock.now = et(16, 30, 0);
        job.run();
        clock.now = ZonedDateTime.of(LocalDate.of(2026, 11, 8), LocalTime.of(17, 0), UsMarketCalendar.NEW_YORK).toInstant();
        assertThat(job.run().get(0).skipped()).isEqualTo("거래일 아님");
        assertThat(store.recentJobRuns(10)).isEmpty();

        ((ObjectNode) store.settings.body().get("stopWatch")).put("mode", "OFF");
        ((ObjectNode) store.settings.body().get("kr").get("stopWatch")).put("mode", "ON");
        store.books.put(PaperBooks.KR_RULES, new Book(PaperBooks.KR_RULES, PaperBooks.KIND_RULES, "한국 규칙", 100_000_000,
                LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        clock.now = kst(8, 50, 0);   // 개장 전에 엶 — partial 아님
        job.run();
        clock.now = kst(15, 35, 20);
        job.run();
        assertThat(store.recentJobRuns(10)).singleElement().satisfies(r -> {
            assertThat(r.job()).isEqualTo("kr.stopwatch.summary");
            assertThat(r.detail().path("market").asString()).isEqualTo("KR");
            assertThat(r.detail().path("partial").asBoolean()).isFalse();
            assertThat(r.detail().path("cyclesJudged").asInt()).isZero();
            assertThat(r.detail().path("lastJudgedGrid").isNull()).isTrue();
        });
    }

    // ------------------------------------------------------------------ QA-384: 감시 작업이 마지막 격자를 판정했는가 → 장부의 덮음(작업 → 장부를 이어서)

    /** 운영 형식의 미국 감시 저장본({@link #usSnapshot} + 수집기가 회차마다 적는 최상위 {@code mode ON} — 장부의 덮음은 ON 저장본만 봄, QA-360). */
    private void usSnapshotOn(Instant fetchedAt, Map<String, double[]> tickers, Instant until) {
        usSnapshot(fetchedAt, fetchedAt.plusSeconds(1), tickers, until);
        ((ObjectNode) marketData.stopWatch(false).orElseThrow().payload()).put("mode", "ON");
    }

    /** 16:15 ET 확정 종가 관측치(AAA 그날 종가 90 ≤ 스탑가 92)를 16:17에 뜬 장부(재기동한 프로세스 — 메모리 없음)로 처리합니다. */
    private PaperLedgerService.Outcome closeObservation() {
        PaperLedgerService closing = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER,
                new PaperCheckpointJobTest.MovableClock(et(16, 17, 0)));
        return closing.process(PaperFixtures.quotes(et(16, 15, 0), PaperFixtures.bar("AAA", PREV, 99.0, DAY, 90.0)));
    }

    @Test
    @DisplayName("QA-384 평소 날 불변 — 감시 작업이 15:55 격자까지 판정한 날의 16:15 확정 종가 관측치는 감시에 맡김(대체 스탑 없음). 판정 뒤·요약 전에 "
            + "백엔드가 재기동돼 그 세션 판정 창을 보지 못한 프로세스만 남아도 같음")
    void judgedLastGridLeavesTheCloseToTheWatch() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        clock.now = et(9, 0, 0);
        job.run();   // 개장 전부터 떠 있던 프로세스
        usSnapshotOn(et(15, 55, 20), Map.of("AAA", new double[]{99, 93}), et(15, 54, 0));
        clock.now = et(15, 55, 40);
        assertThat(job.run().get(0).grids()).last().isEqualTo(et(15, 55, 0));
        assertThat(stops()).as("93 > 스탑가 92 — 감시는 걸지 않음").isEmpty();

        // 15:58 재기동 — 새 프로세스는 16:10에 처음 돌아(판정 창 끝 16:05 뒤) 그 세션 요약을 남기지 않음
        PaperStopWatchJob restarted = jobWith(new StopWatchStatus());
        clock.now = et(16, 10, 0);
        restarted.run();
        assertThat(store.recentJobRuns("stopwatch.summary", 5)).isEmpty();

        PaperLedgerService.Outcome outcome = closeObservation();

        assertThat(stops()).isEmpty();
        assertThat(store.positions(PaperBooks.RULES)).singleElement().satisfies(p -> assertThat(p.qty()).isEqualTo(10));
        assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("장중 감시에 맡김"));
    }

    @Test
    @DisplayName("QA-384 이중 스탑 없음 — 감시가 마지막 격자(15:55)에서 낸 종가 STOP은 16:15 확정 종가 관측치가 한 번만 체결(대체 스탑을 겹쳐 내지 않음)")
    void lastGridStopIsFilledOnceAtTheClose() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshotOn(et(15, 55, 20), Map.of("AAA", new double[]{99, 91}), et(15, 54, 0));
        clock.now = et(15, 55, 40);   // 세션 중 기동 — 가장 최근 격자(15:55) 하나만: 15:50·15:55 두 격자 모두 91 ≤ 92
        job.run();
        assertThat(stops()).singleElement().satisfies(o -> {
            assertThat(o.timing()).as("T 15:57 — 장 끝 여유 안이라 그날 종가").isEqualTo(PaperBooks.NEXT_CLOSE);
            assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING);
        });

        closeObservation();

        assertThat(stops()).as("STOP 주문은 감시가 낸 하나뿐").singleElement().satisfies(o -> {
            assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperStopWatchJob.STOP_MODE);
        });
        assertThat(store.fillsOf(PaperBooks.RULES)).hasSize(1);
        assertThat(store.positions(PaperBooks.RULES)).isEmpty();
    }

    @Test
    @DisplayName("QA-384 — 감시 작업이 15:50 격자까지만 판정하고 백엔드가 죽은 날(수집기는 15:55:20 저장본을 남김)의 16:15 확정 종가 관측치는 덮지 않아 종가 스탑")
    void unjudgedLastGridKeepsTheCloseFallback() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        clock.now = et(9, 0, 0);
        job.run();
        usSnapshotOn(et(15, 50, 20), Map.of("AAA", new double[]{99, 93}), et(15, 49, 0));
        clock.now = et(15, 50, 40);
        assertThat(job.run().get(0).grids()).last().isEqualTo(et(15, 50, 0));
        // 15:52 백엔드가 죽음 — 수집기는 계속 돌아 15:55:20 저장본(15:55 격자 가격 있음)을 남기지만 아무도 그 격자를 판정하지 않음. 16:12에 다시 뜸.
        usSnapshotOn(et(15, 55, 20), Map.of("AAA", new double[]{99, 93}), et(15, 54, 0));
        PaperStopWatchJob restarted = jobWith(new StopWatchStatus());
        clock.now = et(16, 12, 0);
        restarted.run();

        PaperLedgerService.Outcome outcome = closeObservation();

        assertThat(stops()).singleElement().satisfies(o -> {
            assertThat(o.timing()).isEqualTo(PaperBooks.IMMEDIATE);
            assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK);
        });
        assertThat(outcome.notes()).noneMatch(n -> n.contains("장중 감시에 맡김"));
    }

    @Test
    @DisplayName("QA-384 마지막 격자 판정 기록 — 15:55 격자를 판정한 회차가 stopwatch.lastgrid 한 줄(세션·격자·판정 때의 모드)을 남기고, 앞 격자 회차·같은 "
            + "저장본을 다시 본 재기동은 남기지 않음. 장부의 근거(lastGridJudged)는 ON 기록만")
    void lastGridRecordOncePerSession() {
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        clock.now = et(9, 0, 0);
        job.run();
        usSnapshotOn(et(15, 50, 20), Map.of("AAA", new double[]{99, 93}), et(15, 49, 0));
        clock.now = et(15, 50, 40);
        job.run();
        assertThat(store.recentJobRuns(10)).as("앞 격자까지 — 기록 없음").isEmpty();
        assertThat(PaperStopWatchJob.lastGridJudged(store, UsPaperMarket.INSTANCE, DAY, et(15, 55, 0))).isFalse();

        usSnapshotOn(et(15, 55, 20), Map.of("AAA", new double[]{99, 93}), et(15, 54, 0));
        clock.now = et(15, 55, 40);
        job.run();

        assertThat(store.recentJobRuns(10)).singleElement().satisfies(r -> {
            assertThat(r.job()).isEqualTo("stopwatch.lastgrid");
            assertThat(r.outcome()).isEqualTo("OK");
            assertThat(r.startedAt()).isEqualTo(et(15, 55, 40));
            assertThat(r.detail().path("market").asString()).isEqualTo("US");
            assertThat(r.detail().path("mode").asString()).isEqualTo("ON");
            assertThat(r.detail().path("tradingDate").asString()).isEqualTo(DAY.toString());
            assertThat(r.detail().path("lastJudgedGrid").asString()).isEqualTo(et(15, 55, 0).toString());
            assertThat(r.detail().path("judgedAt").asString()).isEqualTo(et(15, 55, 40).toString());
            assertThat(r.detail().path("since").asString()).isEqualTo(et(9, 0, 0).toString());
            assertThat(r.detail().path("partial").asBoolean()).isFalse();
        });
        assertThat(PaperStopWatchJob.lastGridJudged(store, UsPaperMarket.INSTANCE, DAY, et(15, 55, 0))).isTrue();
        assertThat(PaperStopWatchJob.lastGridJudged(store, UsPaperMarket.INSTANCE, DAY, et(15, 50, 0))).as("다른 격자").isFalse();
        assertThat(PaperStopWatchJob.lastGridJudged(store, UsPaperMarket.INSTANCE, PREV, et(15, 55, 0))).as("다른 세션").isFalse();
        assertThat(PaperStopWatchJob.lastGridJudged(store, KrPaperMarket.INSTANCE, DAY, et(15, 55, 0))).as("다른 시장").isFalse();

        clock.now = et(15, 56, 0);
        job.run();
        // 15:57 재기동 — 새 프로세스가 아직 신선한 같은 저장본으로 15:55 격자를 다시 판정해도 같은 줄을 또 남기지 않음
        PaperStopWatchJob restarted = jobWith(new StopWatchStatus());
        clock.now = et(15, 58, 0);
        assertThat(restarted.run().get(0).grids()).containsExactly(et(15, 55, 0));
        assertThat(store.recentJobRuns("stopwatch.lastgrid", 10)).as("세션에 한 줄").hasSize(1);

        clock.now = et(16, 5, 20);
        job.run();
        assertThat(store.recentJobRuns(10)).extracting(r -> r.job()).as("세션 요약은 지금처럼 창 끝 뒤에 따로")
                .containsExactlyInAnyOrder("stopwatch.lastgrid", "stopwatch.summary");
    }

    @Test
    @DisplayName("QA-384 SHADOW로 판정한 마지막 격자의 기록은 mode SHADOW — 장부의 근거가 아님. 세션 요약만 있는 세션(이 기록이 생기기 전 판)은 요약의 "
            + "lastJudgedGrid·mode ON이 근거")
    void lastGridRecordModeAndSummaryEvidence() {
        settings("SHADOW", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshot(et(15, 55, 20), et(15, 55, 21), Map.of("AAA", new double[]{99, 93}), et(15, 54, 0));
        clock.now = et(15, 55, 40);
        job.run();

        assertThat(store.recentJobRuns("stopwatch.lastgrid", 5)).singleElement().satisfies(r -> {
            assertThat(r.detail().path("mode").asString()).isEqualTo("SHADOW");
            assertThat(r.detail().path("partial").asBoolean()).as("세션 중 기동").isTrue();
        });
        assertThat(PaperStopWatchJob.lastGridJudged(store, UsPaperMarket.INSTANCE, DAY, et(15, 55, 0))).isFalse();

        FakePaperStore old = new FakePaperStore();
        ObjectNode summary = PaperFixtures.MAPPER.createObjectNode();
        summary.put("mode", "ON").put("tradingDate", DAY.toString()).put("lastJudgedGrid", et(15, 55, 0).toString());
        old.recordJobRun("stopwatch.summary", et(16, 5, 20), et(16, 5, 20), "OK", summary);
        assertThat(PaperStopWatchJob.lastGridJudged(old, UsPaperMarket.INSTANCE, DAY, et(15, 55, 0))).isTrue();
        assertThat(PaperStopWatchJob.lastGridJudged(old, UsPaperMarket.INSTANCE, DAY, et(12, 55, 0))).isFalse();
        ObjectNode none = PaperFixtures.MAPPER.createObjectNode();
        none.put("mode", "ON").put("tradingDate", PREV.toString()).putNull("lastJudgedGrid");
        old.recordJobRun("stopwatch.summary", et(16, 5, 20), et(16, 5, 20), "OK", none);
        assertThat(PaperStopWatchJob.lastGridJudged(old, UsPaperMarket.INSTANCE, PREV, et(15, 55, 0))).as("판정한 격자 없음").isFalse();
    }

    @Test
    @DisplayName("QA-384 마지막 격자 판정 기록을 남기지 못하면(DB 오류) 다음 회차가 다시 남김 — 그동안 장부의 근거는 없음(대체 경로가 맡음)")
    void lastGridRecordIsRetried() {
        boolean[] fail = {true};
        store = new FakePaperStore() {
            @Override
            public void recordJobRun(String name, Instant startedAt, Instant finishedAt, String outcome, tools.jackson.databind.JsonNode detail) {
                if (fail[0] && "stopwatch.lastgrid".equals(name)) {
                    throw new IllegalStateException("기록 실패(시험)");
                }
                super.recordJobRun(name, startedAt, finishedAt, outcome, detail);
            }
        };
        PaperStopWatchJob failing = jobWith(new StopWatchStatus());
        settings("ON", "OFF");
        usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
        hold(PaperBooks.RULES, "AAA", 100, PREV, 99);
        usSnapshotOn(et(15, 55, 20), Map.of("AAA", new double[]{99, 93}), et(15, 54, 0));
        clock.now = et(15, 55, 40);

        PaperStopWatchJob.Outcome outcome = failing.run().get(0);

        assertThat(outcome.error()).as("판정은 끝남 — 기록 실패는 회차 오류가 아님").isNull();
        assertThat(outcome.grids()).containsExactly(et(15, 55, 0));
        assertThat(PaperStopWatchJob.lastGridJudged(store, UsPaperMarket.INSTANCE, DAY, et(15, 55, 0))).isFalse();

        fail[0] = false;
        clock.now = et(15, 56, 0);
        assertThat(failing.run().get(0).skipped()).isEqualTo("이미 본 저장본");
        assertThat(store.recentJobRuns("stopwatch.lastgrid", 5)).singleElement().satisfies(r -> {
            assertThat(r.startedAt()).as("판정한 시각").isEqualTo(et(15, 55, 40));
            assertThat(r.detail().path("lastJudgedGrid").asString()).isEqualTo(et(15, 55, 0).toString());
        });
        assertThat(PaperStopWatchJob.lastGridJudged(store, UsPaperMarket.INSTANCE, DAY, et(15, 55, 0))).isTrue();
    }

    @Test
    @DisplayName("QA-384 조기 폐장일(2026-11-27, 13:00 ET 마감) — 마지막 격자는 12:55 ET: 그 격자를 판정한 기록으로 13:15 확정 종가 관측치는 감시에 맡기고, "
            + "12:50까지만 판정했으면 종가 스탑")
    void earlyCloseLastGrid() {
        LocalDate early = LocalDate.of(2026, 11, 27);
        LocalDate before = LocalDate.of(2026, 11, 25);   // 11-26 추수감사절 휴장
        for (boolean judged : new boolean[]{true, false}) {
            setUp();
            settings("ON", "OFF");
            usBook(PaperBooks.RULES, PaperBooks.KIND_RULES, PaperBooks.ACTIVE);
            hold(PaperBooks.RULES, "AAA", 100, before, 99);
            clock.now = etOn(early, 9, 0, 0);
            job.run();
            earlySnapshot(early, etOn(early, 12, 50, 20), etOn(early, 12, 49, 0));
            clock.now = etOn(early, 12, 50, 40);
            assertThat(job.run().get(0).grids()).last().isEqualTo(etOn(early, 12, 50, 0));
            earlySnapshot(early, etOn(early, 12, 55, 20), etOn(early, 12, 54, 0));   // 수집기는 마지막 회차까지 저장
            if (judged) {
                clock.now = etOn(early, 12, 55, 40);
                assertThat(job.run().get(0).grids()).containsExactly(etOn(early, 12, 55, 0));
                assertThat(store.recentJobRuns("stopwatch.lastgrid", 5)).singleElement().satisfies(r ->
                        assertThat(r.detail().path("lastJudgedGrid").asString()).isEqualTo(etOn(early, 12, 55, 0).toString()));
            }

            PaperLedgerService closing = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER,
                    new PaperCheckpointJobTest.MovableClock(etOn(early, 13, 17, 0)));
            PaperLedgerService.Outcome outcome = closing.process(PaperFixtures.quotes(etOn(early, 13, 15, 0),
                    PaperFixtures.bar("AAA", before, 99.0, early, 90.0)));

            if (judged) {
                assertThat(stops()).isEmpty();
                assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("장중 감시에 맡김"));
            } else {
                assertThat(stops()).singleElement().satisfies(o ->
                        assertThat(o.reason().path("stopMode").asString()).isEqualTo(PaperLedgerService.STOP_MODE_HOURLY_FALLBACK));
            }
        }
    }

    private static Instant etOn(LocalDate day, int h, int m, int s) {
        return ZonedDateTime.of(day, LocalTime.of(h, m, s), UsMarketCalendar.NEW_YORK).toInstant();
    }

    /** {@code day} 세션의 AAA를 09:30부터 {@code until}(봉 시작)까지 93으로 지켜본 운영 형식(mode ON) 감시 저장본. */
    private void earlySnapshot(LocalDate day, Instant fetchedAt, Instant until) {
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("mode", "ON");
        payload.put("fetchedAt", fetchedAt.toString());
        Map<Instant, Double> bars = new LinkedHashMap<>();
        for (Instant at = etOn(day, 9, 30, 0); !at.isAfter(until); at = at.plus(Duration.ofMinutes(1))) {
            bars.put(at, 93.0);
        }
        ObjectNode entry = StopWatchTest.usEntry(day, bars, 99.0, null);
        ((ObjectNode) entry.path("day").path("first")).put("t", etOn(day, 9, 30, 0).toString());
        payload.putObject("tickers").set("AAA", entry);
        when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok",
                null, fetchedAt.plusSeconds(1))));
    }

    @Test
    @DisplayName("QA-384 한국 장 시간 변경일(10:00 개장·16:30 마감) — 마지막 격자는 16:20: 15:20 회차는 기록을 남기지 않고 16:20 회차가 kr.stopwatch.lastgrid를 남김")
    void koreaShiftedDayLastGrid() {
        ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
        ObjectNode kr = (ObjectNode) body.get("kr");
        ((ObjectNode) kr.get("stopWatch")).put("mode", "ON");
        ((ObjectNode) kr.get("calendar")).putObject("openTimeOverrides").putObject(DAY.toString()).put("open", "10:00").put("close", "16:30");
        store.initSettingsIfAbsent(body);
        store.books.put(PaperBooks.KR_RULES, new Book(PaperBooks.KR_RULES, PaperBooks.KIND_RULES, "한국 규칙", 100_000_000,
                LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(PaperBooks.KR_RULES, new BookState(PaperBooks.KR_RULES, 1000, 1000, 0, 0, null, null, null, null));
        store.upsertPosition(new Position(PaperBooks.KR_RULES, "005930", 10, 48_000, LocalDate.of(2026, 11, 2), PaperFixtures.FRI_CLOSE,
                50_000, PaperFixtures.FRI_CLOSE, null, null, false, PREV, 50_500, null));
        when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenReturn(KrConfirmed.NONE);
        clock.now = kst(9, 30, 0);
        job.run();

        krSnapshot(kst(15, 20, 20), 15, 6, 20);
        clock.now = kst(15, 20, 40);
        assertThat(job.run().get(1).grids()).last().isEqualTo(kst(15, 20, 0));
        assertThat(store.recentJobRuns("kr.stopwatch.lastgrid", 5)).as("이날의 격자 끝은 16:20 — 15:20은 중간 격자").isEmpty();

        krSnapshot(kst(16, 20, 20), 16, 6, 20);
        clock.now = kst(16, 20, 40);
        assertThat(job.run().get(1).grids()).last().isEqualTo(kst(16, 20, 0));
        assertThat(store.recentJobRuns("kr.stopwatch.lastgrid", 5)).singleElement().satisfies(r -> {
            assertThat(r.detail().path("market").asString()).isEqualTo("KR");
            assertThat(r.detail().path("mode").asString()).isEqualTo("ON");
            assertThat(r.detail().path("tradingDate").asString()).isEqualTo(DAY.toString());
            assertThat(r.detail().path("lastJudgedGrid").asString()).isEqualTo(kst(16, 20, 0).toString());
        });
        assertThat(PaperStopWatchJob.lastGridJudged(store, KrPaperMarket.INSTANCE, DAY, kst(16, 20, 0))).isTrue();
        assertThat(PaperStopWatchJob.lastGridJudged(store, KrPaperMarket.INSTANCE, DAY, kst(15, 20, 0))).isFalse();
    }

    /** 한국 감시 저장본 — 005930의 봉 끝 라벨 {@code hour}:{@code from}~{@code to}(50,000 — 스탑가 46,000 위), 갭 가드 통과. */
    private void krSnapshot(Instant fetchedAt, int hour, int from, int to) {
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("mode", "ON");
        payload.put("fetchedAt", fetchedAt.toString());
        Map<String, Double> bars = new LinkedHashMap<>();
        for (int m = from; m <= to; m++) {
            bars.put(String.format("%02d:%02d", hour, m), 50_000.0);
        }
        payload.putObject("tickers").set("005930", StopWatchTest.krEntry(DAY, bars, List.of(), 50_500.0, 50_500.0, 50_500.0));
        when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null,
                fetchedAt.plusSeconds(1))));
    }
}
