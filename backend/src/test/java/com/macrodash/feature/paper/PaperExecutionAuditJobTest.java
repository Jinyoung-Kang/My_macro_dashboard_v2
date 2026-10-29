package com.macrodash.feature.paper;

import com.macrodash.feature.paper.ExecutionAuditFixtures.Bars;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.lang.reflect.Field;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static com.macrodash.feature.paper.ExecutionAuditFixtures.FRI_DECIDED;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.FRI_EDT;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON_DECIDED;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON_EST;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.TUE;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.claudeOrder;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.et;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.observationFill;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 실행 감사 정기 작업({@link PaperExecutionAuditJob}, 명세 2026-10-30 §14-1) — 꺼짐·테이블 없음은 아무것도 안 함, 계좌1 주문의 메뉴 반사실을
 * 시점마다 한 번만 씀(R1·R2, null은 0이 아님), 종가는 확정 뒤에만, 서머타임 전환 주, 감사 폭(최근 8일), 장부 잠금을 잡지 않고 장부 표를 쓰지
 * 않음, 기록은 새로 쓴 때·오류일 때만. 판정 갈래 자체는 {@code ExecutionAuditTest}.
 */
class PaperExecutionAuditJobTest {

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        marketData = mock(PaperMarketData.class);
        when(marketData.quotes(any(PaperMarket.class))).thenReturn(Optional.empty());
        when(reader.read(eq(Datasets.SNAP_PAPER_BARS_US), anyLong(), isNull())).thenReturn(Optional.empty());
        activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
    }

    private PaperExecutionAuditJob job(boolean enabled, Instant now) {
        return new PaperExecutionAuditJob(store, reader, marketData, new PaperConfig(enabled, PaperFixtures.FRI, 100_000),
                MAPPER, Clock.fixed(now, ZoneOffset.UTC));
    }

    private void bars(Bars bars) {
        Snapshot snapshot = bars.snapshot();
        when(reader.read(eq(Datasets.SNAP_PAPER_BARS_US), anyLong(), isNull())).thenReturn(Optional.of(snapshot));
    }

    private void observed(Quotes quotes) {
        when(marketData.quotes(any(PaperMarket.class))).thenReturn(Optional.of(quotes));
    }

    private long order(String ticker, String timing, String status, LocalDate asOf, Instant createdAt) {
        return store.insertOrder(claudeOrder(ticker, PaperBooks.BUY, timing, status, asOf, createdAt));
    }

    private JsonNode cf(long orderId) {
        return store.execs.get(orderId).cf();
    }

    /** 화요일(E) 10:55 ET 저장본 — 09:30 R1, 10:00 R2(T 봉 거래 없음), 11:00 창은 아직, SPY 지연 90초. */
    private static Bars tuesdayMorning() {
        return new Bars(et(TUE, 10, 55).plusSeconds(30))
                .bar("AAPL", TUE, et(TUE, 9, 30), 100.0, 1_000.0)
                .bar("AAPL", TUE, et(TUE, 10, 0), 101.0, 0.0)
                .bar("AAPL", TUE, et(TUE, 10, 1), 101.5, 400.0)
                .bar("AAPL", TUE, et(TUE, 10, 54), 102.0, 10.0)
                .bar("SPY", TUE, et(TUE, 9, 30), 500.0, 10.0)
                .bar("SPY", TUE, et(TUE, 10, 53), 501.0, 10.0);   // 10:55:30 − (10:53 + 60초) = 90초
    }

    @Test
    @DisplayName("꺼져 있으면(PAPER_ENABLED=false — 로컬 v2) 정기 실행은 저장본도 표도 읽지 않고 아무것도 쓰지 않는다")
    void disabledDoesNothing() {
        order("AAPL", "NEXT_OBSERVATION", "PENDING", MON, MON_DECIDED);
        bars(tuesdayMorning());

        job(false, et(TUE, 11, 0)).scheduledRun();

        verify(reader, never()).quietly(any());
        verify(reader, never()).read(any(), anyLong(), any());
        verify(marketData, never()).quotes(any(PaperMarket.class));
        assertThat(store.execs).isEmpty();
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("V17 전 DB(테이블 없음)면 읽지 않고 건너뜀 — 기록도 없음")
    void notReadySkips() {
        store.ready = false;
        PaperExecutionAuditJob.Outcome outcome = job(true, et(TUE, 11, 0)).run();
        assertThat(outcome.skippedReason()).contains("V17");
        verify(reader, never()).read(any(), anyLong(), any());
        assertThat(store.execs).isEmpty();
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("계좌1 주문 하나: 시가 R1·10:00 R2·11:00 이후 null(0 아님)·계좌1식 = 실제 체결 원가격·종가는 장중이라 null, 지연은 그 저장본의 90초, 기록 한 줄")
    void writesMenuCounterfactualsForBookOneOrders() {
        long id = order("AAPL", "NEXT_OBSERVATION", "FILLED", MON, MON_DECIDED);
        store.insertFill(observationFill(id, "AAPL", PaperBooks.BUY, 10, 99.5, et(TUE, 9, 57), TUE));
        bars(tuesdayMorning());
        observed(quotes(et(TUE, 10, 57), bar("AAPL", MON, 98, TUE, 102)));

        PaperExecutionAuditJob.Outcome outcome = job(true, et(TUE, 11, 0)).run();

        assertThat(outcome.error()).isNull();
        assertThat(outcome.rowsWritten()).isEqualTo(1);
        OrderExec row = store.execs.get(id);
        assertThat(row.bookCode()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(row.timing()).isEqualTo("NEXT_OBSERVATION");
        assertThat(row.targetAt()).as("계좌1식에는 정해진 시각이 없음").isNull();
        assertThat(row.lagSeconds()).isEqualTo(90);
        assertThat(row.lateResolved()).as("계좌1식 체결(사다리 칸 없음)은 늦게 풂을 세지 않음").isNull();
        JsonNode cf = row.cf();
        assertThat(cf.properties()).extracting(Map.Entry::getKey).containsExactlyElementsOf(ExecutionAudit.TIMINGS);
        assertThat(cf.get("NEXT_OBSERVATION").path("raw").asDouble()).isEqualTo(99.5);
        assertThat(cf.get("NEXT_OBSERVATION").path("rung").asString()).isEqualTo("QUOTES_OBSERVATION");
        assertThat(cf.get("NEXT_OPEN").path("raw").asDouble()).isEqualTo(100.0);
        assertThat(cf.get("NEXT_OPEN").path("at").asString()).isEqualTo("2026-10-27T13:30:00Z");
        assertThat(cf.get("NEXT_OPEN").path("rung").asString()).isEqualTo("Y1M_AT");
        assertThat(cf.get("AT_1000").path("raw").asDouble()).isEqualTo(101.5);
        assertThat(cf.get("AT_1000").path("rung").asString()).isEqualTo("Y1M_NEXT");
        for (String later : List.of("AT_1100", "AT_1200", "AT_1300", "AT_1400", "AT_1500", "NEXT_CLOSE")) {
            assertThat(cf.get(later).isNull()).as(later + " — 아직 없음은 null(0이 아님)").isTrue();
        }
        assertThat(store.jobRuns).singleElement().satisfies(run -> {
            assertThat(run.job()).isEqualTo("exec-audit");
            assertThat(run.outcome()).isEqualTo("OK");
            assertThat(run.detail().path("rowsWritten").asInt()).isEqualTo(1);
            assertThat(run.detail().path("valuesFilled").asInt()).isEqualTo(3);
            assertThat(run.detail().path("lagSeconds").asInt()).isEqualTo(90);
            assertThat(run.detail().path("barsStale").asBoolean(true)).isFalse();
        });

        // 같은 저장본으로 다시 돌면 쓸 것이 없어 행·기록 그대로
        Instant stamped = store.execs.get(id).updatedAt();
        store.dbNow = store.dbNow.plusSeconds(300);
        assertThat(job(true, et(TUE, 11, 5)).run().rowsWritten()).isZero();
        assertThat(store.execs.get(id).updatedAt()).isEqualTo(stamped);
        assertThat(store.jobRuns).hasSize(1);
    }

    @Test
    @DisplayName("한 번 쓴 시점은 고치지 않음 — 뒤 저장본이 T 봉 거래를 보여도 처음의 R2 값·처음 지연 그대로, 빈 시점만 채움")
    void valuesAreWriteOnce() {
        long id = order("AAPL", "NEXT_OBSERVATION", "PENDING", MON, MON_DECIDED);
        bars(tuesdayMorning());
        job(true, et(TUE, 11, 0)).run();
        assertThat(cf(id).get("AT_1000").path("raw").asDouble()).isEqualTo(101.5);

        Bars revised = new Bars(et(TUE, 11, 55))
                .bar("AAPL", TUE, et(TUE, 9, 30), 99.0, 1_000.0)
                .bar("AAPL", TUE, et(TUE, 10, 0), 101.0, 700.0)        // 고쳐진 T 봉 — 그래도 R2 값 그대로
                .bar("AAPL", TUE, et(TUE, 11, 0), 103.0, 50.0)
                .bar("AAPL", TUE, et(TUE, 11, 54), 103.5, 10.0)
                .bar("SPY", TUE, et(TUE, 11, 54), 502.0, 10.0);
        bars(revised);
        PaperExecutionAuditJob.Outcome second = job(true, et(TUE, 12, 0)).run();

        assertThat(second.rowsWritten()).isEqualTo(1);
        assertThat(second.valuesFilled()).as("새로 채운 것은 11:00 하나").isEqualTo(1);
        JsonNode cf = cf(id);
        assertThat(cf.get("NEXT_OPEN").path("raw").asDouble()).isEqualTo(100.0);
        assertThat(cf.get("AT_1000").path("raw").asDouble()).isEqualTo(101.5);
        assertThat(cf.get("AT_1000").path("rung").asString()).isEqualTo("Y1M_NEXT");
        assertThat(cf.get("AT_1100").path("raw").asDouble()).isEqualTo(103.0);
        assertThat(store.execs.get(id).lagSeconds()).as("처음 저장본의 지연").isEqualTo(90);
    }

    @Test
    @DisplayName("지연은 그 주문의 1분봉 반사실을 처음 적은 회차의 값 — 그 회차에 SPY를 이어받아 지연을 몰랐으면 뒤 회차가 다른 시점을 채워도 null 그대로")
    void lagStaysWithTheFirstBarsRoundEvenWhenUnknown() {
        long id = order("AAPL", "NEXT_OBSERVATION", "PENDING", MON, MON_DECIDED);
        bars(tuesdayMorning().stale("SPY"));                     // SPY만 이어받음 — 이 회차의 지연은 모름
        job(true, et(TUE, 11, 0)).run();
        assertThat(cf(id).get("NEXT_OPEN").path("raw").asDouble()).isEqualTo(100.0);
        assertThat(store.execs.get(id).lagSeconds()).isNull();

        bars(new Bars(et(TUE, 11, 55).plusSeconds(30))
                .bar("AAPL", TUE, et(TUE, 11, 0), 103.0, 50.0)
                .bar("AAPL", TUE, et(TUE, 11, 54), 103.5, 10.0)
                .bar("SPY", TUE, et(TUE, 11, 54), 502.0, 10.0));    // 지연 30초
        PaperExecutionAuditJob.Outcome second = job(true, et(TUE, 12, 0)).run();

        assertThat(second.valuesFilled()).as("새로 채운 것은 11:00 하나").isEqualTo(1);
        assertThat(store.execs.get(id).lagSeconds())
                .as("NEXT_OPEN·AT_1000을 적은 10:55 저장본의 지연(모름) — 11:55 저장본의 30초로 메우지 않음").isNull();
    }

    @Test
    @DisplayName("종가(NEXT_CLOSE)는 관측치가 E 마감 + 15분 뒤 수집일 때만 — 마감 + 10분 저장본은 null로 두고 다음 저장본에서 채움")
    void nextCloseWaitsForTheConfirmedClose() {
        long id = order("AAPL", "NEXT_CLOSE", "PENDING", MON, MON_DECIDED);
        observed(quotes(et(TUE, 16, 10), bar("AAPL", MON, 98, TUE, 104)));
        job(true, et(TUE, 16, 12)).run();
        assertThat(cf(id).get("NEXT_CLOSE").isNull()).isTrue();
        assertThat(store.execs.get(id).targetAt()).as("종가 주문의 목표 시각 = E 마감").isEqualTo(et(TUE, 16, 0));

        observed(quotes(et(TUE, 16, 20), bar("AAPL", MON, 98, TUE, 104)));
        job(true, et(TUE, 16, 22)).run();
        assertThat(cf(id).get("NEXT_CLOSE").path("raw").asDouble()).isEqualTo(104.0);
        assertThat(cf(id).get("NEXT_CLOSE").path("rung").asString()).isEqualTo("QUOTES_CLOSE");
        assertThat(cf(id).get("NEXT_OBSERVATION").isNull()).as("종가 주문의 계좌1식 기준은 체결 행에서 옮길 수 없음").isTrue();
        assertThat(store.execs.get(id).lagSeconds()).as("1분봉 저장본이 없음 — 지연 모름").isNull();
    }

    @Test
    @DisplayName("저장본에 지연(90초)이 있어도 그 주문에 1분봉 값이 하나도 생기지 않았으면 지연을 적지 않음 — 체결에서 옮긴 계좌1식 값만 있는 주문")
    void noLagWithoutABarsValueForThatOrder() {
        long id = order("MSFT", "NEXT_OBSERVATION", "FILLED", MON, MON_DECIDED);   // 저장본에 MSFT 봉이 없음
        store.insertFill(observationFill(id, "MSFT", PaperBooks.BUY, 10, 400.0, et(TUE, 9, 57), TUE));
        bars(tuesdayMorning());

        PaperExecutionAuditJob.Outcome outcome = job(true, et(TUE, 11, 0)).run();

        assertThat(outcome.valuesFilled()).as("계좌1식 기준 하나").isEqualTo(1);
        assertThat(cf(id).get("NEXT_OBSERVATION").path("raw").asDouble()).isEqualTo(400.0);
        assertThat(ExecutionAudit.MENU.keySet()).allSatisfy(timing -> assertThat(cf(id).get(timing).isNull()).as(timing).isTrue());
        assertThat(store.jobRuns).singleElement().satisfies(run -> assertThat(run.detail().path("lagSeconds").asInt())
                .as("저장본의 지연은 있음").isEqualTo(90));
        assertThat(store.execs.get(id).lagSeconds()).as("이 주문의 1분봉 반사실을 적은 저장본이 없음").isNull();
    }

    @Test
    @DisplayName("서머타임 전환 주(10-30 금 EDT 결정 → E = 11-02 월 EST): 09:30 ET = 14:30Z 봉, 13:30Z 봉은 시가가 아님")
    void dstWeek() {
        long id = order("AAPL", "NEXT_OBSERVATION", "PENDING", FRI_EDT, FRI_DECIDED);
        bars(new Bars(et(MON_EST, 10, 55))
                .barIn("09:30", "AAPL", MON_EST, Instant.parse("2026-11-02T13:30:00Z"), 90.0, 100.0)
                .bar("AAPL", MON_EST, Instant.parse("2026-11-02T14:30:00Z"), 100.0, 100.0)
                .bar("AAPL", MON_EST, Instant.parse("2026-11-02T15:00:00Z"), 101.0, 100.0)
                .bar("AAPL", MON_EST, et(MON_EST, 10, 50), 101.2, 100.0));
        job(true, et(MON_EST, 11, 0)).run();
        assertThat(cf(id).get("NEXT_OPEN").path("at").asString()).isEqualTo("2026-11-02T14:30:00Z");
        assertThat(cf(id).get("NEXT_OPEN").path("raw").asDouble()).isEqualTo(100.0);
        assertThat(cf(id).get("AT_1000").path("at").asString()).isEqualTo("2026-11-02T15:00:00Z");
    }

    @Test
    @DisplayName("감사 폭: 목표 세션이 오늘(뉴욕) − 8일보다 앞인 주문·스탑(IMMEDIATE)·거절·제안·다른 계좌 주문은 보지 않음, 아직 오지 않은 세션은 빈 행으로 만듦")
    void auditWindowAndScope() {
        long old = order("AAPL", "NEXT_OBSERVATION", "FILLED", LocalDate.of(2026, 10, 16), Instant.parse("2026-10-16T22:31:00Z"));
        long future = order("MSFT", "NEXT_OBSERVATION", "PENDING", TUE, Instant.parse("2026-10-27T22:31:00Z"));
        store.insertOrder(new Order(0, PaperBooks.CLAUDE, null, "AAPL", "SELL", 5, null, null, "IMMEDIATE", "STOP",
                "FILLED", null, null, MON, MON_DECIDED, null, null));
        long rejected = order("NVDA", "NEXT_OBSERVATION", "REJECTED", MON, MON_DECIDED);
        long proposed = order("AMD", "NEXT_OBSERVATION", "PROPOSED", MON, MON_DECIDED);
        activeBook(store, PaperBooks.RULES, PaperBooks.KIND_RULES, 100_000, null);
        long rules = store.insertOrder(new Order(0, PaperBooks.RULES, null, "AAPL", "BUY", null, 5.0, null,
                "NEXT_OBSERVATION", "RULE", "PENDING", null, null, MON, MON_DECIDED, null, null));

        job(true, et(LocalDate.of(2026, 10, 28), 0, 30)).run();

        // 10-16 기준 → E = 10-19, 오늘(뉴욕 10-28) − 8일 = 10-20보다 앞
        assertThat(store.execs).containsOnlyKeys(future);
        assertThat(store.execs.get(future).cf().properties()).allSatisfy(e -> assertThat(e.getValue().isNull()).isTrue());
        assertThat(List.of(old, rejected, proposed, rules)).noneMatch(store.execs::containsKey);
    }

    @Test
    @DisplayName("장부 잠금을 잡지 않고(장부 서비스를 모름 — 다른 스레드가 잠금을 쥐고 있어도 끝남) 장부 표(주문·체결·보유·상태·순자산·결정)는 바꾸지 않음")
    void neverTakesTheLedgerLockNorWritesLedgerTables() throws Exception {
        assertThat(Arrays.stream(PaperExecutionAuditJob.class.getDeclaredFields()).map(Field::getType))
                .doesNotContain(PaperLedgerService.class);
        long id = order("AAPL", "NEXT_OBSERVATION", "FILLED", MON, MON_DECIDED);
        store.insertFill(observationFill(id, "AAPL", PaperBooks.BUY, 10, 99.5, et(TUE, 9, 57), TUE));
        PaperFixtures.position(store, PaperBooks.CLAUDE, "AAPL", 10, 99.5, 100, 100.0, TUE, 99.5);
        bars(tuesdayMorning());
        observed(quotes(et(TUE, 16, 20), bar("AAPL", MON, 98, TUE, 104)));
        var orders = new TreeMap<>(store.orders);
        var fills = new TreeMap<>(store.fills);
        var positions = store.positions(PaperBooks.CLAUDE);
        var states = new TreeMap<>(store.states);
        var decisions = new TreeMap<>(store.decisions);
        var nav = store.navSeries(PaperBooks.CLAUDE);

        PaperLedgerService ledger = new PaperLedgerService(store, marketData, MAPPER);
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Thread holder = new Thread(() -> ledger.exclusively(() -> {
            held.countDown();
            try {
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return null;
        }));
        holder.start();
        assertThat(held.await(5, TimeUnit.SECONDS)).isTrue();
        try {
            PaperExecutionAuditJob.Outcome outcome = assertTimeoutPreemptively(Duration.ofSeconds(5),
                    () -> job(true, et(TUE, 16, 25)).run());
            assertThat(outcome.rowsWritten()).isEqualTo(1);
        } finally {
            release.countDown();
            holder.join(5_000);
        }

        assertThat(store.orders).isEqualTo(orders);
        assertThat(store.fills).isEqualTo(fills);
        assertThat(store.positions(PaperBooks.CLAUDE)).isEqualTo(positions);
        assertThat(store.states).isEqualTo(states);
        assertThat(store.decisions).isEqualTo(decisions);
        assertThat(store.navSeries(PaperBooks.CLAUDE)).isEqualTo(nav);
        assertThat(store.execs).containsOnlyKeys(id);
    }

    @Test
    @DisplayName("실패는 그 실행만 되돌리고 오류 기록 한 줄 — 정기 실행은 예외를 스케줄러로 던지지 않음")
    void failuresAreRecordedNotThrown() {
        FakePaperStore failing = new FakePaperStore() {
            @Override
            public List<Order> executionOrders(String code, LocalDate asOfFrom) {
                throw new IllegalStateException("시험 — 읽기 실패");
            }
        };
        activeBook(failing, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
        PaperExecutionAuditJob job = new PaperExecutionAuditJob(failing, reader, marketData,
                new PaperConfig(true, PaperFixtures.FRI, 100_000), MAPPER, Clock.fixed(et(TUE, 11, 0), ZoneOffset.UTC));

        assertThatCode(job::scheduledRun).doesNotThrowAnyException();
        assertThat(failing.execs).isEmpty();
        assertThat(failing.jobRuns).singleElement().satisfies(run -> {
            assertThat(run.job()).isEqualTo("exec-audit");
            assertThat(run.outcome()).isEqualTo("ERROR");
            assertThat(run.detail().path("error").asString()).contains("시험 — 읽기 실패");
        });
    }

    @Test
    @DisplayName("주문이 없으면 쓰지도 기록하지도 않는다 — 1분봉 저장본이 오래돼도(70분 넘음) 수집을 요청하지 않고 조용히 읽기만")
    void quietWhenNothingToDo() {
        bars(new Bars(et(TUE, 9, 0)));
        job(true, et(TUE, 11, 0)).scheduledRun();
        assertThat(store.execs).isEmpty();
        assertThat(store.jobRuns).isEmpty();
        verify(reader).read(eq(Datasets.SNAP_PAPER_BARS_US), eq(Datasets.MAX_AGE_BARS_US), isNull());
        verify(reader, org.mockito.Mockito.atLeast(2)).quietly(any());
    }

    @Test
    @DisplayName("시각 지정 체결의 늦게 풂 — 체결 행(사다리 칸·장부 반영 시각)으로 한 번 셈: 대체 칸 참·제때 1분봉 거짓, 반사실을 이미 적은 행에도 나중에 채움")
    void lateResolvedFromTimedFills() {
        long late = order("MSFT", "AT_1000", "FILLED", MON, MON_DECIDED);
        long onTime = order("AAPL", "AT_1000", "FILLED", MON, MON_DECIDED);
        bars(tuesdayMorning());
        observed(quotes(et(TUE, 10, 57), bar("AAPL", MON, 98, TUE, 102)));
        PaperExecutionAuditJob.Outcome before = job(true, et(TUE, 11, 0)).run();
        assertThat(before.rowsWritten()).isEqualTo(2);
        assertThat(store.execs.get(onTime).lateResolved()).as("아직 체결 없음").isNull();
        assertThat(store.execs.get(late).lateResolved()).isNull();

        long lateFill = store.insertFill(observationFill(late, "MSFT", PaperBooks.BUY, 1, 300, et(TUE, 11, 20), TUE));
        store.fillBars.put(lateFill, new com.macrodash.store.PaperStore.ExecFill(store.fills.get(lateFill), et(TUE, 10, 37),
                "Y1M_LATE"));
        long onTimeFill = store.insertFill(observationFill(onTime, "AAPL", PaperBooks.BUY, 1, 101.5, et(TUE, 10, 20), TUE));
        store.fillBars.put(onTimeFill, new com.macrodash.store.PaperStore.ExecFill(store.fills.get(onTimeFill),
                et(TUE, 10, 1), "Y1M_NEXT"));

        PaperExecutionAuditJob.Outcome after = job(true, et(TUE, 11, 25)).run();

        assertThat(after.rowsWritten()).isEqualTo(2);
        assertThat(store.execs.get(late).lateResolved()).isTrue();
        assertThat(store.execs.get(onTime).lateResolved()).as("반사실은 그대로 두고 늦게 풂만 채움").isFalse();
        assertThat(cf(onTime).get("NEXT_OPEN").path("raw").asDouble()).isEqualTo(100.0);
    }
}
