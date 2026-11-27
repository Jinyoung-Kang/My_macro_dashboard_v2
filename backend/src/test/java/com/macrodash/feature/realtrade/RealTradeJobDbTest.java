package com.macrodash.feature.realtrade;

import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.collector.CollectorTradeClient.CancelResult;
import com.macrodash.collector.CollectorTradeClient.Holding;
import com.macrodash.collector.CollectorTradeClient.OrderResult;
import com.macrodash.collector.CollectorTradeClient.Outcome;
import com.macrodash.collector.CollectorTradeClient.Preflight;
import com.macrodash.collector.CollectorTradeClient.Quote;
import com.macrodash.collector.CollectorTradeClient.Reply;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.DueOrder;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperMirrorService.WeightAfter;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.RealTradeFixtures.MutableClock;
import com.macrodash.store.RealTradeStore;
import com.macrodash.store.RealTradeStore.Batch;
import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.Event;
import com.macrodash.store.RealTradeStore.OrderRow;
import com.macrodash.store.RealTradeStore.Valuation;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static com.macrodash.feature.realtrade.RealTradeFixtures.BOOK;
import static com.macrodash.feature.realtrade.RealTradeFixtures.GENERATION;
import static com.macrodash.feature.realtrade.RealTradeFixtures.SESSION;
import static com.macrodash.feature.realtrade.RealTradeFixtures.broker;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static com.macrodash.feature.realtrade.RealTradeFixtures.kst;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 실제 매매 정기 작업 한 주기({@link RealTradeJob}, ADR 0028 — 명세 2026-11-06 §3·§7.3·§7.4) — 실제 테스트 DB와 가짜 수집기·모의 공개 창·텔레그램으로: 시가
 * 맞추기 묶음과 순서, 회전율, 손실 한도(매수만 멈춤), 11-19형 장 시간(쉼), OPG 비동기 거절 → 마무리 1회·상태 미확인 → 0·부분 체결 → 잔량만, 장중 따라 하기와
 * 재발행 뿌리 0, 이상 멈춤(매도도 멈춤·취소), 끄는 중 → OFF, 같은 오류 반복, 알림 글. 실제 토스·수집기는 부르지 않습니다.
 */
class RealTradeJobDbTest {

    private static final String A = "005930";
    private static final String B = "000660";
    private static final String C = "035420";

    private JdbcTemplate jdbc;
    private RealTradeStore store;
    private CollectorTradeClient client;
    private PaperMirrorService paper;
    private PaperTelegram telegram;
    private MutableClock clock;
    private RealTradeExecutor executor;
    private RealTradeJob job;
    private final AtomicInteger orderIds = new AtomicInteger();

    @BeforeEach
    void setUp() {
        jdbc = RealTradeFixtures.jdbc();
        store = RealTradeFixtures.store(jdbc);
        RealTradeFixtures.clean(jdbc);
        client = mock(CollectorTradeClient.class);
        paper = mock(PaperMirrorService.class);
        telegram = mock(PaperTelegram.class);
        RealTradeFixtures.claimRunsInsert(paper);
        clock = new MutableClock(kst("2026-11-06T08:51"));
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        when(client.calendar()).thenReturn(Reply.of(calendar(normalSession(), 0.3)));
        when(client.warmup()).thenReturn(Reply.of(new CollectorTradeClient.Warmup(false)));
        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        when(client.todayOrders()).thenReturn(Reply.of(List.of()));
        when(client.restrictions(any())).thenReturn(Reply.of(new CollectorTradeClient.Restrictions(Set.of(), Map.of())));
        when(client.order(anyString())).thenReturn(Reply.failed("collector-not-ok"));
        when(client.cancelOrder(anyString())).thenReturn(new CancelResult(Outcome.ACCEPTED, "C-1", null));
        when(client.placeOrder(anyString())).thenAnswer(inv -> new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        when(paper.book(BOOK)).thenReturn(Optional.of(book(GENERATION)));
        when(paper.sessionHours(SESSION)).thenReturn(Optional.of(new SessionHours(SESSION, true, kst("2026-11-06T09:00"),
                kst("2026-11-06T15:30"))));
        when(paper.ledgerCaughtUp(BOOK, SESSION)).thenReturn(true);
        when(paper.cashLikeTickers()).thenReturn(List.of("153130"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of());
        when(paper.openTargets(anyString(), any())).thenReturn(Optional.empty());
        executor = new RealTradeExecutor(store, client, paper, RealTradeFixtures.MAPPER, clock);
        job = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, false, 10_000);
    }

    @AfterEach
    void tearDown() {
        RealTradeFixtures.clean(jdbc);
    }

    // ------------------------------------------------------------------ 합성 자료
    private static BookInfo book(String generation) {
        return new BookInfo(BOOK, "Claude 계좌2", "CLAUDE", "KR", "ACTIVE", LocalDate.of(2026, 10, 30),
                Instant.parse("2026-10-29T13:00:00Z"), generation);
    }

    private static CollectorTradeClient.Session normalSession() {
        return new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T08:00"), kst("2026-11-06T08:50"), kst("2026-11-06T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T09:00"), kst("2026-11-06T15:20"), kst("2026-11-06T15:30")));
    }

    private static CollectorTradeClient.Calendar calendar(CollectorTradeClient.Session session, Double skew) {
        return new CollectorTradeClient.Calendar(SESSION, skew, session, SESSION.minusDays(1), SESSION.plusDays(3));
    }

    private void targets(Map<String, Double> weights, List<Long> absorbed) {
        when(paper.openTargets(BOOK, SESSION)).thenReturn(Optional.of(new OpenTargets(BOOK, SESSION, weights, Map.of(), 1e7, 0,
                absorbed, List.of())));
    }

    /** 사전 조회 — 현금, 보유(종목·수량·현재가), 시세는 보유 + 추가 종목(현재가). 상한가 = 현재가 × 1.3, 매도 가능 = 보유 정수. */
    private void preflight(String cash, Map<String, String[]> holdings, Map<String, String> extraQuotes) {
        List<Holding> hs = new ArrayList<>();
        Map<String, Quote> quotes = new LinkedHashMap<>();
        Map<String, BigDecimal> sellable = new LinkedHashMap<>();
        holdings.forEach((symbol, qp) -> {
            hs.add(new Holding(symbol, "합성" + symbol, d(qp[0]), d(qp[1])));
            quotes.put(symbol, new Quote(d(qp[1]), d(qp[1]).multiply(d("1.3")), null));
            sellable.put(symbol, d(qp[0]));
        });
        extraQuotes.forEach((symbol, price) -> quotes.put(symbol, new Quote(d(price), d(price).multiply(d("1.3")), null)));
        when(client.preflight(any(), any())).thenReturn(Reply.of(new Preflight(clock.now, d(cash), hs, quotes, sellable)));
    }

    private List<JsonNode> sentBodies() {
        ArgumentCaptor<String> bodies = ArgumentCaptor.forClass(String.class);
        verify(client, org.mockito.Mockito.atLeast(0)).placeOrder(bodies.capture());
        return bodies.getAllValues().stream().map(b -> RealTradeFixtures.MAPPER.readTree(b)).toList();
    }

    private static String summary(JsonNode body) {
        return body.path("side").asString() + " " + body.path("symbol").asString() + " " + body.path("timeInForce").asString() + " "
                + body.path("quantity").asString();
    }

    private Config cfg() {
        return store.config("KR").orElseThrow();
    }

    private List<Event> events(String kind) {
        return store.recentEvents("KR", 50).stream().filter(e -> e.kind().equals(kind)).toList();
    }

    private void run(String localTime) {
        clock.set(kst("2026-11-06T" + localTime));
        job.cycle(clock.now);
    }

    // ------------------------------------------------------------------ 시가 맞추기
    @Test
    @DisplayName("시가 맞추기 — 책에 없는 보유 매도(OPG) 먼저, 매수는 지금 매수 가능 금액 안에서(상한가 기준), 묶음은 하루 한 번(흡수한 모의 주문 기록)")
    void syncBatch() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of(11L, 12L));
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));

        run("08:51");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + C + " OPG 100", "BUY " + B + " OPG 150", "BUY " + A + " OPG 32");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(batch.absorbedOrderIds()).containsExactly(11L, 12L);
        assertThat(batch.targets().path(A).asDouble()).isEqualTo(50.0);
        assertThat(cfg().syncPending()).as("켜기 뒤 첫 묶음 — 회전율 예외를 쓰고 끔").isFalse();
        assertThat(store.recentOrders("KR", 10)).allMatch(r -> r.purpose().equals("SYNC") && r.batchId().equals(batch.id()));

        run("08:51:40");
        verify(client, times(3)).placeOrder(anyString());   // 묶음은 하루 한 번 — 재시도할 거절이 없으면 더 보내지 않음
    }

    @Test
    @DisplayName("회전율 60% 초과 — 켜기 직후가 아니면 보내지 않고 이상 멈춤(turnover)")
    void turnoverHalts() {
        RealTradeFixtures.live(store, false, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));

        run("08:51");

        verify(client, never()).placeOrder(anyString());
        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    @Test
    @DisplayName("손실 한도 — 운용 평가액 ≤ 기준 × (1 − 15%)면 매수만 멈추고(이벤트·알림) 매도는 보냄")
    void lossLimitPausesBuysOnly() {
        RealTradeFixtures.live(store, true, d("20000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));

        run("08:51");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + C + " OPG 100");
        assertThat(cfg().buysPaused()).isTrue();
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("BUYS_PAUSED")).singleElement().satisfies(e -> {
            assertThat(e.notifies()).isTrue();
            assertThat(e.detail().path("reason").asString()).isEqualTo("loss-limit");
        });
    }

    @Test
    @DisplayName("11-19형 — 토스 정규장 10:00~16:30인데 모의 달력은 09:00~15:30이면 그날 쉼(조회·주문 없이 쉼 이벤트·알림)")
    void examDaySkips() {
        RealTradeFixtures.live(store, true, d("10000000"));
        when(client.calendar()).thenReturn(Reply.of(calendar(new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T09:00"), kst("2026-11-06T09:50"), kst("2026-11-06T10:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T10:00"), kst("2026-11-06T16:20"), kst("2026-11-06T16:30"))), 0.0)));
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("09:55");
        run("09:56");

        verify(client, never()).preflight(any(), any());
        verify(client, never()).placeOrder(anyString());
        assertThat(events("SKIP_DAY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("reason").asString()).isEqualTo("hours-mismatch");
            assertThat(e.notifies()).isTrue();
        });
        assertThat(job.todayView().skipReason()).isEqualTo("hours-mismatch");
    }

    // ------------------------------------------------------------------ 시가 뒤 마무리
    private void syncBuy100() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        run("08:51");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 100");
    }

    @Test
    @DisplayName("OPG가 접수 뒤 비동기로 거절되면 시가 뒤 마무리가 시장가 DAY로 한 번만 메움")
    void opgRejectedThenFollowupOnce() {
        syncBuy100();
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "OPG", "REJECTED", "100", "0", clock.now, null)));

        run("09:00:40");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 100", "BUY " + A + " DAY 100");
        OrderRow followup = store.recentOrders("KR", 1).getFirst();
        assertThat(followup.purpose()).isEqualTo("SYNC_FOLLOWUP");
        assertThat(followup.attempt()).isEqualTo(1);

        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "BUY", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("5000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        run("09:01:20");
        run("09:02:00");
        verify(client, times(2)).placeOrder(anyString());
    }

    @Test
    @DisplayName("OPG 상태를 모르면(종료 확인 전) 대체 주문 없음 — 마무리 0")
    void opgStatusUnknownNoFollowup() {
        syncBuy100();
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "OPG", "PENDING", "100", "0", clock.now, null))));

        run("09:00:40");
        run("09:10:00");
        run("09:29:50");

        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("OPG가 부분 체결로 끝나면 마무리는 남은 차이만")
    void opgPartialThenRemainder() {
        syncBuy100();
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "OPG", "CANCELED", "100", "60", clock.now, clock.now)));
        preflight("7000000", Map.of(A, new String[]{"60", "50000"}), Map.of());

        run("09:00:40");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 100", "BUY " + A + " DAY 40");
    }

    @Test
    @DisplayName("시가 맞추기 창 요약 — 마무리 창 끝에 한 번(접수·체결·놓침·건너뜀·막힘·미룸), 다음 주기에 다시 남기지 않음")
    void windowSummaryOnce() {
        syncBuy100();
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "OPG", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("5000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        run("09:00:40");
        run("09:31:00");
        run("09:31:10");
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("window").asString()).isEqualTo("SYNC");
            assertThat(e.detail().path("accepted").asInt()).isEqualTo(1);
            assertThat(e.detail().path("filled").asInt()).isEqualTo(1);
            assertThat(e.detail().path("missed").asInt()).isZero();
            assertThat(e.notifies()).isTrue();
        });
    }

    // ------------------------------------------------------------------ 마무리와 장중 따라 하기가 겹칠 때(RT-BE-1)
    private static final String CASH_LIKE = "153130";

    /** 마무리가 09:30까지 이어지는 그날 묶음 — A·B는 목표 근처(1% 아래 차이), 현금성은 현금이 모자라 미룸(마무리가 끝나지 않음). */
    private Batch followupBatchStillRunning() {
        RealTradeFixtures.live(store, false, d("10000000"));
        Batch batch = store.upsertBatch("KR", SESSION, RealTradeStore.BATCH_SYNC, BOOK,
                RealTradeFixtures.MAPPER.valueToTree(Map.of(A, 50.0, B, 48.0, CASH_LIKE, 2.0)), List.of(), d("10000000"));
        preflight("100000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"240", "20000"}), Map.of(CASH_LIKE, "100000", C, "20000"));
        run("09:00:40");
        verify(client, never()).placeOrder(anyString());   // 현금성 1주는 상한가 130,000 > 현금 100,000 → 미룸(마무리 계속)
        return batch;
    }

    @Test
    @DisplayName("마무리가 남아 있는 동안 장중 따라 하기로 산 묶음 밖 종목은 마무리가 '책에 없는 보유'로 팔지 않음")
    void followupKeepsIntradayBuy() {
        followupBatchStillRunning();
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(901, 900, C, "BUY", kst("2026-11-06T09:05"))));
        when(paper.weightAfter(eq(BOOK), eq(901L), any())).thenReturn(Optional.of(new WeightAfter(901, C, "BUY", 5.0, 1e7, true,
                List.of(901L), List.of())));

        run("09:05:00");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + C + " DAY 3");

        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "BUY", "DAY", "FILLED", "3", "3", clock.now, clock.now)));
        preflight("40000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"240", "20000"}, C, new String[]{"3", "20000"}),
                Map.of(CASH_LIKE, "100000"));
        run("09:05:40");
        run("09:06:20");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).as("SELL " + C + " 없음").containsExactly("BUY " + C + " DAY 3");
    }

    @Test
    @DisplayName("장중 따라 하기로 묶음 종목을 판 뒤 마무리가 묶음 목표로 다시 사지 않음")
    void followupDoesNotRebuyIntradaySell() {
        followupBatchStillRunning();
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(911, 910, A, "SELL", kst("2026-11-06T09:10"))));
        when(paper.weightAfter(eq(BOOK), eq(911L), any())).thenReturn(Optional.of(new WeightAfter(911, A, "SELL", 0.0, 1e7, true,
                List.of(911L), List.of())));

        run("09:10:00");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100");

        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("5100000", Map.of(B, new String[]{"240", "20000"}), Map.of(A, "50000", CASH_LIKE, "100000"));
        run("09:10:40");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).as("BUY " + A + " 없음 — 묶음의 나머지(현금성)만 메움")
                .containsExactly("SELL " + A + " DAY 100", "BUY " + CASH_LIKE + " DAY 1");
    }

    // ------------------------------------------------------------------ 낡은 묶음(RT-BE-2)
    private static final String OTHER_BOOK = "kr_rules";
    private static final String OTHER_GENERATION = "2026-10-30|2026-10-29T13:00:00Z#rules";

    private void otherBookReady() {
        when(paper.book(OTHER_BOOK)).thenReturn(Optional.of(new BookInfo(OTHER_BOOK, "규칙 계좌", "RULE", "KR", "ACTIVE",
                LocalDate.of(2026, 10, 30), Instant.parse("2026-10-29T13:00:00Z"), OTHER_GENERATION)));
        when(paper.ledgerCaughtUp(OTHER_BOOK, SESSION)).thenReturn(true);
    }

    /** 첫 시도가 A만 429(rate-limited)로 거절되는 시가 맞추기 — A는 창 안 재시도 대상. */
    private void syncWithRetryableReject() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000", B, "20000"));
        when(client.placeOrder(anyString())).thenAnswer(inv -> A.equals(RealTradeFixtures.MAPPER.readTree((String) inv.getArgument(0))
                .path("symbol").asString()) ? new OrderResult(Outcome.REJECTED, null, "rate-limited", 429)
                : new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        run("08:51");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + B + " OPG 150", "BUY " + A + " OPG 93");
    }

    @Test
    @DisplayName("묶음을 만든 뒤 방식(책)을 바꾸면 그날 옛 묶음으로 시가 재시도·마무리를 하지 않음(batch-stale)")
    void staleBatchAfterBookUpdate() {
        syncWithRetryableReject();
        otherBookReady();
        store.lockConfig("KR", current -> store.updateConfig(current.withSource(OTHER_BOOK, OTHER_GENERATION).withSyncPending(true), 1L));
        store.addEvent("KR", RealTradeStore.EVENT_UPDATE, 1L, Map.of("changes", List.of("sourceBook"), "sourceBook", OTHER_BOOK), true);

        run("08:51:40");   // 옛 목표로 A 시도 2 — 없어야 함
        run("09:00:40");   // 옛 목표로 마무리 — 없어야 함
        run("09:10:00");

        verify(client, times(2)).placeOrder(anyString());
        run("09:31");
        assertThat(events("WINDOW_SUMMARY")).singleElement()
                .satisfies(e -> assertThat(e.detail().path("reasons").path("batch-stale").asInt()).isEqualTo(1));
    }

    /** 시가 맞추기 A 100주(OPG)가 비동기로 거절됨 — 그대로면 09:00:40 마무리가 A를 DAY로 메움. */
    private void syncRejectedAsync() {
        syncBuy100();
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "OPG", "REJECTED", "100", "0", clock.now, null)));
    }

    private void reenable(String book, String generation) {
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_OFF).withSyncPending(false), 1L));
        store.addEvent("KR", RealTradeStore.EVENT_DISABLE, 1L, Map.of("from", "LIVE", "to", "OFF"), true);
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_LIVE).withSource(book, generation)
                .withSyncPending(true), 1L));
        store.addEvent("KR", RealTradeStore.EVENT_ENABLE, 1L, Map.of("sourceBook", book), true);
    }

    @Test
    @DisplayName("끄고 다른 책으로 다시 켜면 그날 옛 묶음으로 마무리하지 않음")
    void staleBatchAfterReenableOtherBook() {
        syncRejectedAsync();
        otherBookReady();
        reenable(OTHER_BOOK, OTHER_GENERATION);
        run("09:00:40");
        run("09:01:20");
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("끄고 같은 책으로 다시 켜도 그날 묶음은 켜기 전 것 — 마무리하지 않음(다음 시가 맞추기부터)")
    void staleBatchAfterReenableSameBook() {
        syncRejectedAsync();
        reenable(BOOK, GENERATION);
        run("09:00:40");
        verify(client, times(1)).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 미체결 매수가 잡은 금액(F4)
    @Test
    @DisplayName("시가 재시도 — 미체결 OPG 매수가 매수 가능 금액을 잡아도 손실 한도가 걸리지 않고(잡은 금액을 되돌림), 목표는 묶음에 고정한 E로")
    void retryUsesBatchEquityAndAddsBackPendingBuys() {
        RealTradeFixtures.live(store, true, d("20000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("20000000", Map.of(), Map.of(A, "50000", B, "20000"));
        when(client.placeOrder(anyString())).thenAnswer(inv -> A.equals(RealTradeFixtures.MAPPER.readTree((String) inv.getArgument(0))
                .path("symbol").asString()) ? new OrderResult(Outcome.REJECTED, null, "rate-limited", 429)
                : new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        run("08:51");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + B + " OPG 300", "BUY " + A + " OPG 187");

        // B 300주 OPG가 미체결로 상한가 7,800,000원을 잡아 매수 가능 금액이 12,200,000원으로 보임
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", B, "BUY", "OPG", "PENDING", "300", "0", clock.now, null))));
        preflight("12200000", Map.of(), Map.of(A, "50000", B, "20000"));
        when(client.placeOrder(anyString())).thenAnswer(inv -> new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        run("08:51:40");

        assertThat(cfg().buysPaused()).as("손실이 아님 — 12,200,000 + 7,800,000 = 기준 그대로").isFalse();
        assertThat(events("BUYS_PAUSED")).isEmpty();
        // 목표 = 50% × 묶음 E 20,000,000 ÷ 50,000 = 200주. 매수 가능 금액 12,200,000 − 같은 창에서 잡은 B 7,800,000(보수적 이중 차감) = 4,400,000
        // → 67주(상한가 65,000). 새로 읽은 E(12,200,000)로 셌다면 목표가 122주로 줄었음.
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("BUY " + B + " OPG 300", "BUY " + A + " OPG 187", "BUY " + A + " OPG 67");
        assertThat(store.recentOrders("KR", 1).getFirst().attempt()).isEqualTo(2);
    }

    // ------------------------------------------------------------------ 켠 뒤 남은 몫(F6)
    private void smallOrderCap() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(2_000_000L, 200, 999_999_999L,
                999_999_999L)));
    }

    private void enableEvent() {
        store.addEvent("KR", RealTradeStore.EVENT_ENABLE, 1L, Map.of("sourceBook", BOOK), true);
    }

    private void priorBatch(LocalDate session) {
        store.upsertBatch("KR", session, RealTradeStore.BATCH_SYNC, BOOK, RealTradeFixtures.MAPPER.valueToTree(Map.of(A, 50.0)), List.of(),
                d("10000000"));
    }

    @Test
    @DisplayName("켠 뒤 첫 묶음이 1건 상한으로 다 못 맞추면 sync_pending(회전율 예외)을 켜 둠 — 같은 켜짐의 묶음이라 그날 마무리는 그대로")
    void syncPendingKeptWhenLeftover() {
        enableEvent();
        RealTradeFixtures.live(store, true, d("10000000"));
        smallOrderCap();
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("08:51");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 30");   // 2,000,000 / 65,000
        assertThat(cfg().syncPending()).as("남은 몫(capped) — 다음 시가 맞추기도 회전율 예외").isTrue();

        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "OPG", "FILLED", "30", "30", clock.now, clock.now)));
        preflight("8050000", Map.of(A, new String[]{"30", "50000"}), Map.of());
        run("09:00:40");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 30", "BUY " + A + " DAY 30");
    }

    @Test
    @DisplayName("켠 뒤 세 번째 묶음에서는 남은 몫이 있어도 sync_pending을 끔(회전율 예외를 끝없이 주지 않음)")
    void syncPendingOffAtThirdBatch() {
        enableEvent();
        priorBatch(SESSION.minusDays(2));
        priorBatch(SESSION.minusDays(1));
        RealTradeFixtures.live(store, true, d("10000000"));
        smallOrderCap();
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("08:51");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 30");
        assertThat(cfg().syncPending()).isFalse();
    }

    @Test
    @DisplayName("켜기 전에 만든 묶음은 세지 않음 — 켠 뒤 두 번째 묶음이면 남은 몫으로 sync_pending 유지")
    void syncPendingCountsOnlyBatchesAfterEnable() {
        priorBatch(SESSION.minusDays(4));
        priorBatch(SESSION.minusDays(3));
        enableEvent();
        priorBatch(SESSION.minusDays(1));
        RealTradeFixtures.live(store, true, d("10000000"));
        smallOrderCap();
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("08:51");
        assertThat(cfg().syncPending()).isTrue();
    }

    // ------------------------------------------------------------------ 남은 몫 묶음의 회전율(RT2-1)
    private void priorBatch(LocalDate session, Map<String, Double> weights) {
        store.upsertBatch("KR", session, RealTradeStore.BATCH_SYNC, BOOK, RealTradeFixtures.MAPPER.valueToTree(weights), List.of(),
                d("10000000"));
    }

    @Test
    @DisplayName("RT2-1: 켠 뒤 두 번째 묶음 — 목표가 앞 묶음과 같은 남은 몫이면 회전율 70%여도 보냄(목표 변화량 0)")
    void leftoverSameTargetsSendsDespiteTurnover() {
        enableEvent();
        priorBatch(SESSION.minusDays(1), Map.of(A, 70.0));
        RealTradeFixtures.live(store, true, d("10000000"));
        smallOrderCap();
        targets(Map.of(A, 70.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("08:51");

        // 목표 70% × 1,000만 원 = 700만 원(회전율 70%) — 1건 상한 200만 원 ÷ 상한가 65,000원 = 30주만 보내고 남은 몫은 다음 묶음으로
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 30");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(cfg().syncPending()).as("두 번째 묶음에도 남은 몫 — 세 번째 묶음까지 유지").isTrue();
        assertThat(events("HALT")).isEmpty();
    }

    @Test
    @DisplayName("RT2-1: 켠 뒤 두 번째 묶음 — 목표가 앞 묶음과 크게 다르면(목표 변화량 > 60%) sync_pending이어도 회전율 멈춤, 주문·묶음 없음")
    void leftoverNewTargetsHaltOnDrift() {
        enableEvent();
        priorBatch(SESSION.minusDays(1), Map.of(A, 70.0));
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(B, 70.0), List.of());
        preflight("10000000", Map.of(), Map.of(B, "20000"));

        run("08:51");

        verify(client, never()).placeOrder(anyString());
        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(events("HALT")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("targetDriftPct").asDouble()).as("|0 − 70| + |70 − 0|").isEqualTo(140.0);
            assertThat(e.detail().path("turnoverPct").asDouble()).isEqualTo(70.0);
        });
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    @Test
    @DisplayName("RT2-1: 목표 변화량 = Σ|지금 − 앞|(합집합 종목, 없는 종목은 0%) — 유한하지 않은 비중이 있으면 모름(멈춤으로 셈)")
    void targetDriftSumsUnion() {
        assertThat(RealTradeJob.targetDrift(Map.of(A, 70.0), Map.of(A, 70.0))).contains(new BigDecimal("0.00"));
        assertThat(RealTradeJob.targetDrift(Map.of(A, 70.0), Map.of(B, 70.0))).contains(new BigDecimal("140.00"));
        assertThat(RealTradeJob.targetDrift(Map.of(A, 50.0, B, 20.0), Map.of(A, 40.0, B, 30.0, C, 5.0))).contains(new BigDecimal("25.00"));
        assertThat(RealTradeJob.targetDrift(Map.of(A, 50.0), Map.of(A, Double.NaN))).isEmpty();
    }

    @Test
    @DisplayName("QA-302: 스탑 몫을 뺀 목표 변화량 — 대기 STOP 종목이 줄어든 몫과, 현금성이 늘어난 몫 가운데 그만큼을 뺌(스탑이 없으면 예전 값)")
    void qa302TargetDriftWithoutStops() {
        Set<String> cashLike = Set.of(CASH_LIKE);
        assertThat(RealTradeJob.targetDrift(Map.of(A, 35.0, C, 65.0), Map.of(C, 65.0, CASH_LIKE, 35.0), Set.of(A), cashLike))
                .as("70 − 스탑 35 − 현금성 35").contains(new BigDecimal("0.00"));
        assertThat(RealTradeJob.targetDrift(Map.of(A, 20.0, B, 50.0), Map.of(CASH_LIKE, 70.0), Set.of(A), cashLike))
                .as("140 − 스탑 20 − 현금성 중 20 — 스탑이 아닌 B와 그 대금의 현금성은 그대로").contains(new BigDecimal("100.00"));
        assertThat(RealTradeJob.targetDrift(Map.of(A, 70.0), Map.of(B, 70.0), Set.of(), cashLike)).contains(new BigDecimal("140.00"));
        assertThat(RealTradeJob.targetDrift(Map.of(A, 50.0), Map.of(A, Double.NaN), Set.of(A), cashLike)).isEmpty();
    }

    @Test
    @DisplayName("QA-302: 켠 뒤 두 번째 묶음 — 스탑(A)과 그 대금의 현금성 매수를 빼면 목표가 앞 묶음과 같은 남은 몫이라 회전율·목표 변화량 모두 예외 안, 보냄")
    void qa302LeftoverBatchDriftWithoutStops() {
        enableEvent();
        priorBatch(SESSION.minusDays(1), Map.of(A, 35.0, C, 65.0));
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(C, 65.0, CASH_LIKE, 35.0), List.of(681L));
        preflight("6500000", Map.of(A, new String[]{"70", "50000"}), Map.of(C, "40000", CASH_LIKE, "10000"));
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A));

        run("08:51");

        // 회전율 134.8%(A 매도 35% + C 매수 64.8% + 현금성 35%) → 스탑 몫을 빼면 64.8%, 목표 변화량 70 → 스탑 몫을 빼면 0
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " OPG 70", "BUY " + C + " OPG 125");
    }

    @Test
    @DisplayName("RT2-1: 켠 뒤 첫 묶음은 켜기 전 묶음과 목표가 달라도 회전율 예외(켜기 창에서 확인한 재조정)")
    void firstBatchAfterEnableIgnoresOlderTargets() {
        priorBatch(SESSION.minusDays(3), Map.of(A, 70.0));
        enableEvent();
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(B, 70.0), List.of());
        preflight("10000000", Map.of(), Map.of(B, "20000"));

        run("08:51");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + B + " OPG 350");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(cfg().syncPending()).as("남은 몫 없음 — 첫 묶음에서 끔").isFalse();
    }

    // ------------------------------------------------------------------ 마무리의 현금 배정(F8)
    @Test
    @DisplayName("마무리 — 시도를 다 쓴 종목은 현금을 잡지 않음, 뒤 순서 매수(현금성)가 남은 현금으로 나감")
    void followupCashOnlyForSendable() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(1_000_000L, 200, 999_999_999L,
                999_999_999L)));
        Config cfg = RealTradeFixtures.live(store, false, null);
        Batch batch = store.upsertBatch("KR", SESSION, RealTradeStore.BATCH_SYNC, BOOK,
                RealTradeFixtures.MAPPER.valueToTree(Map.of(A, 90.0, CASH_LIKE, 5.0)), List.of(), d("1750000"));
        clock.set(kst("2026-11-06T09:00:40"));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_SYNC_FOLLOWUP, batch.id(), null, null, A, "BUY", 15, "DAY",
                d("50000"), 1), cfg);   // A 마무리 시도 1 — 1건 상한 15주, 전량 체결
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "DAY", "FILLED", "15", "15", clock.now, clock.now)));
        preflight("1000000", Map.of(A, new String[]{"15", "50000"}), Map.of(CASH_LIKE, "10000"));

        run("09:01:20");

        // A는 목표(31주)보다 16주 모자라지만 마무리 시도가 끝남 → 현금 1,000,000원은 현금성 8주(상한가 13,000)에. 예전에는 A가 975,000원을 먼저 잡아 1주.
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " DAY 15", "BUY " + CASH_LIKE + " DAY 8");
    }

    // ------------------------------------------------------------------ 시각 맞추기(ADR 0033 결정 1)
    private static final Instant SYNC_AT = kst("2026-11-06T09:10");

    private void timedTargets(Map<String, Double> weights, List<Long> absorbed, List<Long> stops) {
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.of(SYNC_AT));
        when(paper.targetsAt(BOOK, SESSION, SYNC_AT)).thenReturn(Optional.of(new OpenTargets(BOOK, SESSION, weights, Map.of(), 1e7, 0,
                absorbed, List.of(), stops)));
    }

    @Test
    @DisplayName("시각 맞추기 날 — 08:50 OPG 없음, 09:10에 묶음 하나(시장가 DAY)가 09:10 주문을 흡수, 다음 주기에 묶음을 또 만들지 않고 창 요약은 SYNC_AT")
    void timedSyncBatch() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(21L, 22L), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));

        run("08:51");
        run("08:55");
        run("09:05");
        verify(client, never()).placeOrder(anyString());
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        verify(paper, never()).openTargets(anyString(), any());

        run("09:10:05");
        // A(목표 100주)는 남은 현금으로 32주뿐 — 같은 계획이 C를 팔므로 줄여 보내지 않고 매도 대금을 기다림(QA-1018, 수정 전에는 BUY A DAY 32도 나감)
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(batch.absorbedOrderIds()).containsExactly(21L, 22L);
        assertThat(store.recentOrders("KR", 10)).hasSize(2)
                .allMatch(r -> r.purpose().equals("SYNC_FOLLOWUP") && r.batchId().equals(batch.id()));

        run("09:10:40");
        // 묶음은 하루 하나 — 진행 중인 주문은 다시 보내지 않고, C 매도가 진행 중인 동안 A도 계속 미룸
        verify(client, times(2)).placeOrder(anyString());
        run("09:14");
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("window").asString()).isEqualTo("SYNC_AT");
            assertThat(e.detail().path("accepted").asInt()).isEqualTo(2);
            assertThat(e.detail().path("deferred").asInt()).as("매도가 창 끝까지 끝나지 않아 A는 미룸으로 남음").isEqualTo(1);
            assertThat(e.detail().path("reasons").path("deferred-cash").asInt()).isEqualTo(1);
        });
        assertThat(RealTradeNotices.text(events("WINDOW_SUMMARY").getFirst())).contains("개장 10분 뒤 맞추기");
    }

    @Test
    @DisplayName("QA-1018: 시각 맞추기 날 — 매도와 함께 계획된 매수가 현금이 모자라면 줄여 보내지 않고 미루고(진행 중인 매도가 있는 주기도), 매도가 끝나 대금이 "
            + "들어온 주기에 온전한 수량으로 보냄(줄인 32주가 체결돼 그 종목이 그날 닫히지 않음)")
    void timedSyncDefersACashCutBuyUntilTheSellProceedsArrive() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));

        run("09:10:05");
        assertThat(sentSummaries()).as("A(목표 100주)는 남은 현금으로 32주뿐 — 같은 계획이 C를 팔므로 줄여 보내지 않음")
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150");

        // 다음 주기 — C 매도가 아직 진행 중(대금 전): A는 여전히 32주뿐이라 다시 미룸
        run("09:10:40");
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150");

        // C 매도·B 매수가 체결로 끝나고 대금이 들어옴(현금 6,000,000 + 4,000,000 − 3,000,000) — A를 온전한 100주로
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", B, "BUY", "DAY", "FILLED", "150", "150", clock.now, clock.now)));
        preflight("7000000", Map.of(B, new String[]{"150", "20000"}), Map.of(A, "50000"));
        run("09:11:15");
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150", "BUY " + A + " DAY 100");
        assertThat(store.recentOrders("KR", 10)).filteredOn(r -> r.symbol().equals(A)).singleElement()
                .satisfies(r -> assertThat(r.attempt()).as("미룬 매수는 시도 1 — 시도 번호 규칙 그대로").isEqualTo(1));
    }

    // ------------------------------------------------------------------ 줄임 보이기(ADR 0028 덧붙임 2026-11-27 — 주문은 그대로)
    @Test
    @DisplayName("줄임 보이기: 매도 없이 현금이 모자라 줄여 낸 마무리 매수 — 주문은 예전 그대로 나가고, 창 요약 detail에 줄임 1과 순자산 대비 부족 %만 "
            + "(종목·수량·금액 없음), 알림 글에 한 구절")
    void windowSummaryCountsACashCutFollowupBuy() {
        RealTradeFixtures.live(store, true, d("3000000"));
        timedTargets(Map.of(A, 90.0), List.of(), List.of());
        // E 3,000,000원 · A 90%(목표 54주, 현재가 50,000 · 상한가 65,000) — 현금 3,000,000원으로는 46주까지: 8주 × 50,000원 = 400,000원(13.33%) 부족
        preflight("3000000", Map.of(), Map.of(A, "50000"));

        run("09:10:05");
        assertThat(sentSummaries()).as("주문은 예전처럼 줄여서 나감").containsExactly("BUY " + A + " DAY 46");

        run("09:10:40");
        assertThat(sentSummaries()).hasSize(1);
        run("09:14");
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("window").asString()).isEqualTo("SYNC_AT");
            assertThat(e.detail().path("accepted").asInt()).isEqualTo(1);
            assertThat(e.detail().path("skipped").asInt()).as("줄임은 건너뜀·미룸에 세지 않음").isZero();
            assertThat(e.detail().path("deferred").asInt()).isZero();
            assertThat(e.detail().path("reasons").has("deferred-cash")).isFalse();
            assertThat(e.detail().path("reduced").asInt()).isEqualTo(1);
            assertThat(e.detail().path("reducedPct").decimalValue()).isEqualByComparingTo("13.33");
            assertThat(e.detail().toString()).as("건수와 %뿐 — 종목·수량·금액 없음").doesNotContain(A, "400000", "\"46\"", "\"54\"");
        });
        assertThat(PaperTelegram.plain(RealTradeNotices.text(events("WINDOW_SUMMARY").getFirst())))
                .endsWith("\n현금 부족으로 줄여 낸 매수 1 · 부족 순자산의 13.33%").doesNotContain(A);
    }

    @Test
    @DisplayName("줄임 보이기: 미뤘던 매수를 매도 대금이 들어온 뒤의 마무리 주기에 현금이 모자라 줄여 낸 날도 창 요약에 줄임 1과 부족 %")
    void windowSummaryReducedOnlyWhenAFollowupBuyWasCut() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 70.0, B, 20.0), List.of(), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
        run("09:10:05");
        assertThat(sentSummaries()).as("A(목표 140주)는 같은 계획이 C를 팔므로 줄여 보내지 않고 미룸(QA-1018)")
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 100");

        // C 매도·B 매수가 끝나 대금이 들어옴(현금 6,000,000 + 4,000,000 − 2,000,000 = 8,000,000 · E 10,000,000) — A(목표 140주, 상한가 65,000)는
        // 123주까지: 17주 × 50,000 ÷ 10,000,000 = 8.50% 부족
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", B, "BUY", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("8000000", Map.of(B, new String[]{"100", "20000"}), Map.of(A, "50000"));
        run("09:11:15");
        assertThat(sentSummaries()).as("매도가 더 없으면 예전처럼 줄여 보냄")
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 100", "BUY " + A + " DAY 123");

        run("09:14");
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("accepted").asInt()).isEqualTo(3);
            assertThat(e.detail().path("reduced").asInt()).isEqualTo(1);
            assertThat(e.detail().path("reducedPct").decimalValue()).isEqualByComparingTo("8.50");
        });
    }

    @Test
    @DisplayName("줄임 보이기: 줄여 낸 매수가 없는 날 — 창 요약 detail의 칸은 예전 열 개 그대로이고 알림 글도 예전 글")
    void windowSummaryWithoutCashCutIsUnchanged() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
        run("09:10:05");   // A는 줄이지 않고 미룸(QA-1018) — 줄여 낸 매수 없음
        run("09:14");
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().propertyNames()).containsExactlyInAnyOrder("window", "date", "accepted", "filled", "missed", "skipped",
                    "blocked", "deferred", "unknown", "reasons");
            assertThat(PaperTelegram.plain(RealTradeNotices.text(e))).isEqualTo("[실제 매매] 개장 10분 뒤 맞추기\n\n접수 2 · 체결 0 · 놓침 0\n건너뜀 0 · 막힘 0 · 미룸 1");
        });
    }

    // QA-378(고치지 않음 — 경로 확인): 모의 장부가 보류해 목표 세션이 지난 STOP 아닌 대기 주문은 다음 세션 목표에 보이지 않습니다
    // (PaperMirrorServiceTest.heldDecisionOrdersPastTheirSessionAreInvisibleToTheNextSession). 그 목표를 받은 묶음은 어제 따라 한 매매를 되돌립니다 —
    // 뒤에 모의가 원래 세션 값으로 체결하면 다음 묶음이 다시 맞추므로 실제 돈이 왕복합니다. 아래는 지금 동작을 그대로 적은 것입니다(결정 전).
    @Test
    @DisplayName("QA-378 경로 확인(지금 동작): 모의 장부가 보류한 지난 세션 주문은 목표에 없으므로 — 어제 따라 산 종목은 '책에 없는 보유'로 팔고, 어제 따라 판 종목은 "
            + "목표 비중대로 다시 삼(회전율 한도 안이면 멈춤 없이)")
    void heldPaperOrdersFromTheLastSessionAreRevertedByTheNextBatch() {
        RealTradeFixtures.live(store, false, d("10000000"));
        // 모의 목표 — 어제 매도가 보류된 B는 비중이 남고(20%), 어제 매수가 보류된 A는 책에 없음
        timedTargets(Map.of(B, 20.0), List.of(), List.of());
        // 실제 계좌 — 어제 09:10 묶음에서 A 20주를 샀고 B는 모두 팔았음
        preflight("9000000", Map.of(A, new String[]{"20", "50000"}), Map.of(B, "20000"));

        run("09:10:05");

        assertThat(sentSummaries()).containsExactly("SELL " + A + " DAY 20", "BUY " + B + " DAY 100");
        assertThat(cfg().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("QA-344 고정: 맞추기 창이 열려 있는 동안(09:11) 켜면 첫 주기에 오늘 묶음을 만들어 바로 보냄 — 켜기 창 예상 목록이 이 세션을 보여야 함")
    void enabledInsideTimedSyncWindowSendsTodaysBatch() {
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(21L), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
        run("09:10:30");   // 꺼짐 — 아무것도 하지 않음
        verify(client, never()).placeOrder(anyString());

        RealTradeFixtures.live(store, true, d("10000000"));   // 09:11에 켬(켠 뒤 첫 묶음 — 회전율 예외)
        run("09:11");

        // 현금이 모자란 A(32주뿐)는 C 매도 대금을 기다림(QA-1018 — 수정 전에는 BUY A DAY 32도 나감)
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).as("오늘 묶음").isPresent();
    }

    @Test
    @DisplayName("QA-347 고정: 맞추기 창이 지난 뒤에 켠 날 — 전체 맞추기(묶음)는 다음 맞추기로 넘기지만, 기준 시각이 그 뒤인 장중 주문과 장중 스탑은 그날 바로 따라 함")
    void enabledAfterSyncWindowStillMirrorsTodaysIntradayOrdersAndStops() {
        timedTargets(Map.of(A, 50.0), List.of(), List.of());
        preflight("10000000", Map.of(B, new String[]{"10", "20000"}), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(801, 800, A, "BUY", kst("2026-11-06T10:30")),
                stopDue(802, B, "MARKET", kst("2026-11-06T10:40"))));
        when(paper.weightAfter(eq(BOOK), eq(801L), any())).thenReturn(Optional.of(new WeightAfter(801, A, "BUY", 20.0, 1e7, true,
                List.of(801L), List.of())));

        RealTradeFixtures.live(store, true, d("10200000"));   // 10:00에 켬 — 오늘 맞추기 창(09:10~09:13)은 이미 지남
        run("10:00");
        verify(client, never()).placeOrder(anyString());
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).as("전체 맞추기는 오늘 하지 않음").isEmpty();

        run("10:30:10");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).as("켠 날의 장중 주문은 바로 따라 함").containsExactly("BUY " + A + " DAY 40");
        run("10:40:10");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).as("장중 스탑도 바로")
                .containsExactly("BUY " + A + " DAY 40", "SELL " + B + " DAY 10");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        assertThat(cfg().syncPending()).as("전체 맞추기를 기다리는 표시는 다음 맞추기까지 남음").isTrue();
    }

    @Test
    @DisplayName("시각 맞추기 날의 묶음 몫 — 묶음을 아직 못 만든 동안 09:10 이하 모의 주문을 장중 따라 하기가 하나씩 보내지 않고, 묶음이 생기면 묶음으로만")
    void timedSyncShareGuard() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.of(SYNC_AT));
        when(paper.targetsAt(BOOK, SESSION, SYNC_AT)).thenReturn(Optional.empty());
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(501, 500, A, "BUY", SYNC_AT)));
        when(paper.weightAfter(eq(BOOK), eq(501L), any())).thenReturn(Optional.of(new WeightAfter(501, A, "BUY", 20.0, 1e7, true,
                List.of(501L), List.of())));

        run("09:10:05");
        verify(client, never()).placeOrder(anyString());
        verify(paper, never()).weightAfter(anyString(), anyLong(), any());

        timedTargets(Map.of(A, 20.0), List.of(501L), List.of());
        run("09:11");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " DAY 40");
        assertThat(store.recentOrders("KR", 10)).noneMatch(r -> r.purpose().equals("MIRROR"));
        run("09:12");
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("시각 맞추기 날 — 창 끝(09:13)까지 묶음을 만들지 못하면 보내지 않고 놓침, 그 주문들도 따라 하지 않음")
    void timedSyncMissed() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(A, 20.0), List.of(501L), List.of());
        when(client.preflight(any(), any())).thenReturn(Reply.failed("timeout"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(501, 500, A, "BUY", SYNC_AT)));

        run("09:10:05");
        run("09:11");
        run("09:12:30");
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        run("09:13:30");
        verify(client, never()).placeOrder(anyString());
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("window").asString()).isEqualTo("SYNC_AT");
            assertThat(e.detail().path("missed").asInt()).isEqualTo(1);
        });
    }

    // ------------------------------------------------------------------ 맞추기 시각이 개장 10분 뒤보다 늦은 날의 판정 시각(QA-377)
    /** 맞추기 시각이 {@code at}(KST)인 날 — 책 목표는 A 50%. */
    private void timedSyncAt(String at) {
        Instant syncAt = kst("2026-11-06T" + at);
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.of(syncAt));
        when(paper.targetsAt(BOOK, SESSION, syncAt)).thenReturn(Optional.of(new OpenTargets(BOOK, SESSION, Map.of(A, 50.0), Map.of(), 1e7, 0,
                List.of(), List.of(), List.of())));
    }

    private Instant syncAtWindowStart() {
        return job.todayView().windows().stream().filter(w -> w.kind().equals(RealTradePlanner.WINDOW_SYNC_AT)).findFirst().orElseThrow().start();
    }

    @Test
    @DisplayName("QA-377: 맞추기 시각이 10:00인 날 — 09:25의 장중 스탑은 그 시각에 판다(수정 전에는 09:57까지 아무것도 하지 않아 놓침), 묶음은 그대로 10:00에")
    void lateTimedSyncDayStillSellsEarlyStops() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedSyncAt("10:00");
        preflight("5000000", Map.of(B, new String[]{"100", "50000"}), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(701, B, "MARKET", kst("2026-11-06T09:25"))));

        run("09:25:10");

        assertThat(sentSummaries()).as("스탑 매도 창 09:25~09:28 안").containsExactly("SELL " + B + " DAY 100");
        assertThat(store.recentOrders("KR", 1).getFirst().purpose()).isEqualTo("MIRROR");
        assertThat(events("STOP_SELL")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("sent").asInt()).isEqualTo(1);
            assertThat(e.detail().path("missed").asInt()).isZero();
        });
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).as("전체 맞추기는 아직(10:00)").isEmpty();

        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", B, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        run("09:40");
        run("09:59:50");
        assertThat(sentSummaries()).as("맞추기 시각 전에는 묶음 주문 없음").hasSize(1);
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();

        run("10:00:05");
        assertThat(sentSummaries()).as("묶음은 맞추기 시각 10:00에").containsExactly("SELL " + B + " DAY 100", "BUY " + A + " DAY 100");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
    }

    @Test
    @DisplayName("QA-377: 맞추기 시각이 10:00이고 장부가 밀린 날 — 스탑만은 09:25에 판다(묶음·장중 따라 하기는 없음)")
    void lateTimedSyncLedgerBehindDayStillSellsEarlyStops() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.ledgerCaughtUp(BOOK, SESSION)).thenReturn(false);
        timedSyncAt("10:00");
        preflight("5000000", Map.of(B, new String[]{"100", "50000"}), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(711, B, "MARKET", kst("2026-11-06T09:25"))));

        run("09:25:10");

        assertThat(sentSummaries()).containsExactly("SELL " + B + " DAY 100");
        assertThat(events("SKIP_DAY")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString())
                .isEqualTo(RealTradePlanner.SKIP_LEDGER));
        run("10:00:05");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).as("장부가 밀린 날은 묶음 없음").isEmpty();
    }

    @Test
    @DisplayName("QA-377 고정: 운영 값(맞추기 09:10)의 판정 시각은 그대로 09:07 — 09:06:50에는 판정·장부 확인·모의 주문 읽기가 없고, 09:07 주기에 한다")
    void decisionTimeUnchangedAtOpenOffset() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(A, 50.0), List.of(), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("08:47:30");
        run("09:06:50");
        verify(paper, never()).ledgerCaughtUp(anyString(), any());
        verify(paper, never()).dueOrders(anyString(), any(), any());
        verify(client, never()).preflight(any(), any());

        run("09:07:00");
        verify(paper, times(1)).ledgerCaughtUp(BOOK, SESSION);
        verify(paper, times(1)).dueOrders(anyString(), any(), any());
        verify(client, never()).placeOrder(anyString());

        run("09:10:05");
        assertThat(sentSummaries()).containsExactly("BUY " + A + " DAY 100");
    }

    @Test
    @DisplayName("QA-377 고정: 시가 맞추기 날의 판정 시각은 그대로 시가 창 3분 전(08:47:30) — 그 전에는 판정이 없다")
    void decisionTimeUnchangedOnOpenSyncDay() {
        RealTradeFixtures.live(store, false, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("08:47:20");
        verify(paper, never()).ledgerCaughtUp(anyString(), any());
        verify(paper, never()).dueOrders(anyString(), any(), any());

        run("08:47:30");
        verify(paper, times(1)).ledgerCaughtUp(BOOK, SESSION);
        verify(paper, times(1)).dueOrders(anyString(), any(), any());
    }

    @Test
    @DisplayName("QA-377 고정: 맞추기 창은 지금처럼 그 창 3분 전에 굳는다 — 그 전까지는 주기마다 맞추기 시각을 다시 세고, 굳은 뒤에는 바뀐 시각을 따르지 않는다")
    void timedWindowStillFreezesThreeMinutesBeforeItsStart() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedSyncAt("10:00");
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("09:30");
        assertThat(syncAtWindowStart()).isEqualTo(kst("2026-11-06T10:00"));

        timedSyncAt("09:40");   // 굳기 전 — 다시 셈
        run("09:35");
        assertThat(syncAtWindowStart()).isEqualTo(kst("2026-11-06T09:40"));

        run("09:37:00");   // 09:40 창 3분 전 — 굳음
        timedSyncAt("11:00");
        run("09:38");
        assertThat(syncAtWindowStart()).as("굳은 뒤에는 그대로").isEqualTo(kst("2026-11-06T09:40"));
        run("09:40:05");
        assertThat(sentSummaries()).containsExactly("BUY " + A + " DAY 100");
    }

    @Test
    @DisplayName("QA-377 고정: 판정(09:07)과 창 굳히기(맞추기 10:00의 3분 전) 사이에 따라 하는 책이 바뀌면 그 주기에 새 책으로 다시 판정하고 창도 새 책의 시각으로 센다 — "
            + "옛 책의 판정(따라 함)으로는 아무것도 보내지 않고, 새 책이 장부 밀림이면 스탑만")
    void bookChangeBetweenDecisionAndWindowFreezeIsDecidedAgainBeforeSending() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedSyncAt("10:00");
        preflight("5000000", Map.of(B, new String[]{"100", "50000"}), Map.of(A, "50000"));

        run("09:07:00");   // 옛 책의 판정 — 따라 함. 창(10:00)은 09:57까지 굳지 않음
        verify(paper, times(1)).ledgerCaughtUp(BOOK, SESSION);
        assertThat(job.todayView().skipReason()).isNull();
        assertThat(syncAtWindowStart()).isEqualTo(kst("2026-11-06T10:00"));

        // 09:20 — 책을 바꿈. 새 책의 맞추기 시각은 09:10(그 창은 이미 지남)이고 장부가 전 거래일을 아직 반영하지 않음
        otherBookReady();
        when(paper.ledgerCaughtUp(OTHER_BOOK, SESSION)).thenReturn(false);
        when(paper.dailySyncAt(OTHER_BOOK, SESSION)).thenReturn(Optional.of(SYNC_AT));
        when(paper.dueOrders(eq(OTHER_BOOK), any(), any())).thenReturn(List.of(dueFor(801, 800, A, "BUY", kst("2026-11-06T09:20")),
                stopDue(802, B, "MARKET", kst("2026-11-06T09:25"))));
        when(paper.weightAfter(eq(OTHER_BOOK), eq(801L), any())).thenReturn(Optional.of(new WeightAfter(801, A, "BUY", 20.0, 1e7, true,
                List.of(801L), List.of())));
        store.lockConfig("KR", current -> store.updateConfig(current.withSource(OTHER_BOOK, OTHER_GENERATION).withSyncPending(true), 1L));

        run("09:20:10");
        verify(client, never()).placeOrder(anyString());   // 옛 책의 판정을 이어 썼다면 새 책의 09:20 장중 매수(A)가 나감
        verify(paper, never()).weightAfter(anyString(), anyLong(), any());
        verify(paper, times(1)).ledgerCaughtUp(OTHER_BOOK, SESSION);
        assertThat(job.todayView().skipReason()).as("새 책으로 다시 판정 — 장부 밀림").isEqualTo(RealTradePlanner.SKIP_LEDGER);
        assertThat(syncAtWindowStart()).as("창도 새 책의 맞추기 시각으로").isEqualTo(SYNC_AT);
        assertThat(events("SKIP_DAY")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString())
                .isEqualTo(RealTradePlanner.SKIP_LEDGER));

        run("09:25:10");
        assertThat(sentSummaries()).as("장부가 밀린 날 — 스탑만").containsExactly("SELL " + B + " DAY 100");
        run("09:30");
        run("10:00:05");   // 옛 책의 맞추기 시각 — 아무것도 없음
        assertThat(sentSummaries()).hasSize(1);
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        verify(paper, times(1)).ledgerCaughtUp(OTHER_BOOK, SESSION);   // 새 책의 판정은 한 번
    }

    @Test
    @DisplayName("QA-377 고정: 판정과 창 굳히기 사이에 따라 하는 책의 세대가 바뀌어도 새 세대로 다시 판정한다 — 옛 세대의 쉼(장부 밀림)을 이어 쓰지 않고, "
            + "창은 아직 굳지 않아 맞추기 시각을 계속 다시 세며, 묶음은 그 시각에")
    void generationChangeBetweenDecisionAndWindowFreezeIsDecidedAgain() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.ledgerCaughtUp(BOOK, SESSION)).thenReturn(false);
        timedSyncAt("10:00");
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("09:07:00");   // 옛 세대의 판정 — 쉼(장부 밀림)
        assertThat(job.todayView().skipReason()).isEqualTo(RealTradePlanner.SKIP_LEDGER);
        verify(paper, times(1)).ledgerCaughtUp(BOOK, SESSION);

        // 09:20 — 같은 책의 세대가 바뀜(합성 세대). 새 세대의 장부는 따라잡은 상태
        String next = "2026-11-06|2026-11-05T23:30:00Z";
        when(paper.book(BOOK)).thenReturn(Optional.of(book(next)));
        when(paper.ledgerCaughtUp(BOOK, SESSION)).thenReturn(true);
        store.lockConfig("KR", current -> store.updateConfig(current.withSource(BOOK, next).withSyncPending(true), 1L));

        run("09:20:10");
        verify(paper, times(2)).ledgerCaughtUp(BOOK, SESSION);
        assertThat(job.todayView().skipReason()).as("새 세대로 다시 판정 — 따라 함").isNull();
        assertThat(cfg().state()).isEqualTo("LIVE");
        verify(client, never()).placeOrder(anyString());

        timedSyncAt("09:40");   // 창은 아직 굳기 전 — 새 세대에서도 주기마다 다시 셈
        run("09:30");
        assertThat(syncAtWindowStart()).isEqualTo(kst("2026-11-06T09:40"));
        run("09:39:50");
        verify(client, never()).placeOrder(anyString());   // 맞추기 시각 전에는 묶음 없음

        run("09:40:05");
        assertThat(sentSummaries()).containsExactly("BUY " + A + " DAY 100");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(store.recentOrders("KR", 1).getFirst().bookGeneration()).isEqualTo(next);
        verify(paper, times(2)).ledgerCaughtUp(BOOK, SESSION);   // 세대마다 한 번
    }

    // ------------------------------------------------------------------ 장중 따라 하기
    private static DueOrder due(long id, long root, String side, String timing, Instant mirrorAt, boolean supported) {
        return new DueOrder(id, root, A, side, timing, "CLAUDE", mirrorAt, mirrorAt, supported, 10.0, null, null);
    }

    private static DueOrder dueFor(long id, long root, String ticker, String side, Instant mirrorAt) {
        return new DueOrder(id, root, ticker, side, "AT_MINUTE", "CLAUDE", mirrorAt, mirrorAt, true, 10.0, null, null);
    }

    @Test
    @DisplayName("장중 따라 하기 — 기준 시각이 지난 모의 주문을 선점해 그 주문 뒤 비중으로 보냄, 재발행 주문(같은 뿌리)은 다시 보내지 않음")
    void mirrorOncePerRoot() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(due(301, 300, "BUY", "AT_MINUTE", kst("2026-11-06T10:00"), true)));
        when(paper.weightAfter(eq(BOOK), eq(301L), any())).thenReturn(Optional.of(new WeightAfter(301, A, "BUY", 20.0, 1e7, true,
                List.of(301L), List.of())));

        run("10:00:20");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " DAY 40");
        OrderRow row = store.recentOrders("KR", 1).getFirst();
        assertThat(row.purpose()).isEqualTo("MIRROR");
        assertThat(row.paperOrderId()).isEqualTo(301L);
        assertThat(row.paperRootOrderId()).isEqualTo(300L);
        verify(paper).claim(eq(BOOK), eq(301L), any(), any());

        // 모의가 밤에 같은 주문을 다시 냄(뿌리 300) — 실제는 추가 0
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(due(302, 300, "BUY", "AT_MINUTE", kst("2026-11-06T10:01"), true)));
        when(paper.weightAfter(eq(BOOK), eq(302L), any())).thenReturn(Optional.of(new WeightAfter(302, A, "BUY", 20.0, 1e7, true,
                List.of(302L), List.of())));
        run("10:01:30");
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("장중 따라 하기 — 따라 할 수 없는 시점은 건너뜀·알림(뿌리마다 한 번), 창이 지나면 놓침")
    void mirrorUnsupportedAndMissed() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(
                new DueOrder(401, 400, A, "BUY", "AT_SOMETIME", "CLAUDE", null, null, false, 10.0, null, null),
                due(411, 410, "BUY", "AT_1000", kst("2026-11-06T10:00"), true)));
        run("11:00:00");
        run("11:00:10");
        verify(client, never()).placeOrder(anyString());
        assertThat(events("SKIPPED")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("reason").asString()).isEqualTo("timing-unsupported");
            assertThat(e.notifies()).isTrue();
        });
        run("15:19:40");
        assertThat(events("WINDOW_SUMMARY")).filteredOn(e -> e.detail().path("window").asString().equals("MIRROR")).singleElement()
                .satisfies(e -> {
                    assertThat(e.detail().path("missed").asInt()).isEqualTo(1);
                    assertThat(e.detail().path("skipped").asInt()).isEqualTo(1);
                    assertThat(e.detail().path("reasons").path("timing-unsupported").asInt()).isEqualTo(1);
                });
    }

    @Test
    @DisplayName("종가 따라 하기 — 종가 단일가 창에서 보내고, 마감 뒤 모의가 그 주문을 취소했으면(장중 교체 잔여 경합) 종가 요약에 건너뜀 사유로 알림")
    void closeMirrorAndPaperCancelled() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("5000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(due(801, 800, "SELL", "NEXT_CLOSE", kst("2026-11-06T15:20"),
                true)));
        when(paper.weightAfter(eq(BOOK), eq(801L), any())).thenReturn(Optional.of(new WeightAfter(801, A, "SELL", 0.0, 1e7, true,
                List.of(801L), List.of())));

        run("15:20:10");
        verify(client, never()).placeOrder(anyString());   // 종가 창(15:20:30~) 전
        run("15:21:00");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100");

        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "SELL", "DAY", "FILLED", "100", "100", clock.now,
                kst("2026-11-06T15:30:00"))));
        when(paper.orderStatus(BOOK, 801L)).thenReturn(Optional.of("CANCELLED"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of());
        run("15:34:00");
        assertThat(cfg().state()).as("체결 시각이 정규장 끝 ± 2분 안").isEqualTo("LIVE");
        assertThat(events("WINDOW_SUMMARY")).filteredOn(e -> e.detail().path("window").asString().equals("NEXT_CLOSE")).singleElement()
                .satisfies(e -> {
                    assertThat(e.detail().path("accepted").asInt()).isEqualTo(1);
                    assertThat(e.detail().path("filled").asInt()).isEqualTo(1);
                    assertThat(e.detail().path("reasons").path("paper-cancelled-after-claim").asInt()).isEqualTo(1);
                    assertThat(e.notifies()).isTrue();
                });
    }

    // ------------------------------------------------------------------ 장중 스탑 매도(ADR 0033 결정 2·3·4)
    private static DueOrder stopDue(long id, String ticker, String timing, Instant mirrorAt) {
        Instant target = "NEXT_CLOSE".equals(timing) ? kst("2026-11-06T15:30") : mirrorAt;
        return new DueOrder(id, id, ticker, "SELL", timing, "STOP", target, mirrorAt, true, null, null, null);
    }

    @Test
    @DisplayName("스탑 매도 — 비중을 셈하지 않고(가격을 몰라도) 정수 보유 전량을 T~T+3분에 매도, 매수 멈춤 중에도, 알림은 건수만")
    void stopSellsWholeHolding() {
        RealTradeFixtures.live(store, false, d("10000000"));
        store.lockConfig("KR", current -> store.updateConfig(current.withBuysPaused(true), null));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"10", "20000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(601, A, "MARKET", kst("2026-11-06T11:32"))));

        run("11:31:50");
        verify(client, never()).placeOrder(anyString());
        run("11:32:10");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100");
        verify(paper, never()).weightAfter(anyString(), anyLong(), any());
        OrderRow row = store.recentOrders("KR", 1).getFirst();
        assertThat(row.purpose()).isEqualTo("MIRROR");
        assertThat(row.paperOrderId()).isEqualTo(601L);
        assertThat(events("STOP_SELL")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("sent").asInt()).isEqualTo(1);
            assertThat(e.notifies()).isTrue();
            String text = RealTradeNotices.text(e);
            assertThat(text).contains("스탑 매도").contains("보냄 1").doesNotContain(A).doesNotContain("100");
        });

        run("11:32:40");
        verify(client, times(1)).placeOrder(anyString());   // 진행 중 — 이 기능 주문 진행 중으로 건너뜀(같은 뿌리 두 번 보내지 않음)
    }

    @Test
    @DisplayName("스탑 매도 — 개장 10분 전 T는 09:10부터 팔고, T + 3분이 지나도록 못 보내면 놓침(알림에 한 번만 — 팔 보유가 남았을 때, QA-321)")
    void stopWindowFloorAndMissed() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"10", "20000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(611, A, "AT_MINUTE", kst("2026-11-06T09:05"))));
        run("09:06");
        verify(client, never()).placeOrder(anyString());
        run("09:10:05");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100");

        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(621, B, "MARKET", kst("2026-11-06T10:00"))));
        run("10:03:30");
        run("10:04:00");
        assertThat(events("STOP_SELL")).filteredOn(e -> e.detail().path("missed").asInt() > 0).singleElement()
                .satisfies(e -> assertThat(e.detail().path("missed").asInt()).isEqualTo(1));
    }

    @Test
    @DisplayName("스탑 매도 — 1건 상한으로 일부만 팔면 체결로 끝난 뒤 시도 2를 새로 읽은 수량으로(뿌리당 최대 2)")
    void stopSecondAttemptAfterCappedFill() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(1_000_000, 20, 5_000_000, 100_000_000)));
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(631, A, "MARKET", kst("2026-11-06T11:00"))));

        run("11:00:10");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 19");
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "SELL", "DAY", "FILLED", "19", "19", clock.now, clock.now)));
        preflight("1950000", Map.of(A, new String[]{"81", "50000"}), Map.of());
        run("11:00:40");
        run("11:01:10");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 19", "SELL " + A + " DAY 19");
        assertThat(store.ordersForRoot("KR", 631L)).extracting(OrderRow::attempt).containsExactly(1, 2);

        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "SELL", "DAY", "FILLED", "19", "19", clock.now, clock.now)));
        preflight("2900000", Map.of(A, new String[]{"62", "50000"}), Map.of());
        run("11:01:40");
        run("11:02:20");
        verify(client, times(2)).placeOrder(anyString());   // 시도 2가 끝 — 남은 보유는 다음 날 맞추기가 '책에 없는 보유'로 팖
    }

    @Test
    @DisplayName("QA-303: 하루 건수 한도를 다 쓴 날 스탑이 미룸으로 창(T + 3분)을 넘기면 STOP_SELL 놓침 1(한 번만), 장중 창 요약은 미룸 1·놓침 0(두 번 세지 않음)")
    void qa303DeferredStopExpiryCountsAsMissed() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 2, 999_999_999L,
                999_999_999L)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(
                broker("X-1", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now),
                broker("X-2", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now))));
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(691, A, "MARKET", kst("2026-11-06T11:00"))));

        run("11:00:10");
        run("11:01:10");
        run("11:02:10");
        verify(client, never()).placeOrder(anyString());
        assertThat(events("STOP_SELL")).as("창 안에서는 미룸 — 다음 주기에 다시 봄").isEmpty();

        run("11:03:30");
        run("11:04:00");
        assertThat(events("STOP_SELL")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("missed").asInt()).isEqualTo(1);
            assertThat(e.detail().path("blocked").asInt()).isZero();
            assertThat(e.detail().path("sent").asInt()).isZero();
        });

        run("15:19:40");
        assertThat(events("WINDOW_SUMMARY")).filteredOn(e -> e.detail().path("window").asString().equals("MIRROR")).singleElement()
                .satisfies(e -> {
                    assertThat(e.detail().path("deferred").asInt()).isEqualTo(1);
                    assertThat(e.detail().path("missed").asInt()).isZero();
                });
    }

    @Test
    @DisplayName("QA-303: 보유는 있는데 매도 가능 수량이 0이라 스탑을 그날 닫으면 STOP_SELL 막힘 1(한 번만) — 놓침으로 또 세지 않음")
    void qa303StructurallySkippedStopCountsAsBlocked() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(client.preflight(any(), any())).thenReturn(Reply.of(new Preflight(clock.now, d("1000000"),
                List.of(new Holding(A, "합성" + A, d("100"), d("50000"))), Map.of(A, new Quote(d("50000"), d("65000"), null)),
                Map.of(A, d("0")))));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(692, A, "MARKET", kst("2026-11-06T11:00"))));

        run("11:00:10");
        run("11:00:40");
        run("11:03:30");

        verify(client, never()).placeOrder(anyString());
        assertThat(events("STOP_SELL")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("blocked").asInt()).isEqualTo(1);
            assertThat(e.detail().path("missed").asInt()).isZero();
        });
    }

    @Test
    @DisplayName("QA-303 대조: 스탑 종목의 보유가 이미 없으면(묶음이 먼저 팖 등) 가격을 몰라 건너뛰어도 STOP_SELL 막힘으로 세지 않음")
    void qa303FlatStopIsNotBlocked() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("6000000", Map.of(), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(693, A, "MARKET", kst("2026-11-06T11:00"))));

        run("11:00:10");
        run("11:03:30");

        verify(client, never()).placeOrder(anyString());
        assertThat(events("STOP_SELL")).isEmpty();
    }

    @Test
    @DisplayName("QA-321: 묶음이 이미 판 스탑은 백엔드를 다시 띄운 뒤에도 STOP_SELL 놓침으로 알리지 않고 장중 창 요약 놓침도 0")
    void qa321RestartDoesNotReportBatchSoldStopAsMissed() {
        RealTradeFixtures.live(store, true, d("6000000"));
        timedTargets(Map.of(B, 10.0), List.of(), List.of(641L));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of(B, "20000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(641, A, "AT_MINUTE", SYNC_AT)));
        run("09:10:05");
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", B, "BUY", "DAY", "FILLED", "30", "30", clock.now, clock.now)));
        preflight("6000000", Map.of(B, new String[]{"30", "20000"}), Map.of());
        run("09:10:40");
        run("09:11:20");
        run("09:14:00");
        assertThat(events("STOP_SELL")).as("묶음이 판 스탑 — 스탑 경로는 이미 맞음").isEmpty();

        clock.set(kst("2026-11-06T11:00:00"));
        RealTradeJob restarted = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, false, 10_000);
        restarted.cycle(clock.now);
        assertThat(events("STOP_SELL")).as("다시 띄운 뒤에도 놓침이 아님 — 그 종목 정수 보유 0").isEmpty();
        clock.set(kst("2026-11-06T15:19:40"));
        restarted.cycle(clock.now);
        assertThat(events("WINDOW_SUMMARY")).filteredOn(e -> e.detail().path("window").asString().equals("MIRROR"))
                .allSatisfy(e -> assertThat(e.detail().path("missed").asInt()).isZero());
    }

    @Test
    @DisplayName("QA-321: 이미 알린 스탑 놓침은 백엔드를 다시 띄워도 STOP_SELL을 다시 남기지 않음(그날 센 뿌리는 이벤트에서 되살림)")
    void qa321RestartKeepsCountedMissOnce() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(621, A, "MARKET", kst("2026-11-06T10:00"))));
        run("10:03:30");
        run("10:04:00");
        assertThat(events("STOP_SELL")).singleElement().satisfies(e -> assertThat(e.detail().path("missed").asInt()).isEqualTo(1));

        clock.set(kst("2026-11-06T10:20:00"));
        RealTradeJob restarted = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, false, 10_000);
        restarted.cycle(clock.now);
        restarted.cycle(kst("2026-11-06T10:20:30"));
        assertThat(events("STOP_SELL")).as("같은 놓침을 다시 알리지 않음").hasSize(1);
    }

    @Test
    @DisplayName("묶음 생성이 실패해도(시각 맞추기 목표 없음) 09:10 대체 스탑은 스탑 경로로 팔림(R3)")
    void stopSellsWhenBatchFails() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.of(SYNC_AT));
        when(paper.targetsAt(BOOK, SESSION, SYNC_AT)).thenReturn(Optional.empty());
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(641, A, "AT_MINUTE", SYNC_AT)));

        run("09:10:05");

        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).as("묶음은 못 만듦").isEmpty();
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100");
        assertThat(store.recentOrders("KR", 1).getFirst().purpose()).isEqualTo("MIRROR");
    }

    @Test
    @DisplayName("묶음과 스탑이 같은 종목을 함께 팔아도 더 팔지 않음 — 묶음 매도가 진행 중이면 스탑은 건너뛰고, 끝난 뒤 보유가 0이면 끝")
    void batchAndStopDoNotOversell() {
        RealTradeFixtures.live(store, true, d("6000000"));
        timedTargets(Map.of(B, 10.0), List.of(), List.of(641L));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of(B, "20000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(641, A, "AT_MINUTE", SYNC_AT)));

        run("09:10:05");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100", "BUY " + B + " DAY 30");
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("6000000", Map.of(), Map.of(B, "20000"));
        run("09:10:40");
        run("09:11:20");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).filteredOn(x -> x.startsWith("SELL")).hasSize(1);
    }

    // ------------------------------------------------------------------ 회전율 멈춤과 스탑(QA-302)
    /** 스탑이 걸린 계좌 — A 100주 × 50,000(E의 50%)·B 200주 × 20,000(40%)·현금 1,000,000, E = 10,000,000. 현금성은 10,000원(상한가 13,000). */
    private void stoppedAccount() {
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"200", "20000"}), Map.of(CASH_LIKE, "10000"));
    }

    @Test
    @DisplayName("QA-302: 시각 맞추기 날 09:10 대체 스탑(A·B, E의 90%)과 그 대금으로 사는 현금성 매수는 회전율 멈춤을 걸지 않음 — sync_pending이 꺼져 있어도 스탑 매도가 나가고 켜짐 유지")
    void qa302StopSellsDoNotTripTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(CASH_LIKE, 90.0), List.of(), List.of(661L, 662L));
        stoppedAccount();
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A, B));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(661, A, "AT_MINUTE", SYNC_AT),
                stopDue(662, B, "AT_MINUTE", SYNC_AT)));

        run("09:10:05");

        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        // 현금성 매수(목표 900주)는 남은 현금으로 76주뿐 — 같은 계획이 스탑 종목을 팔므로 줄여 보내지 않고 그 대금을 기다림(QA-1018 — 수정 전에는
        // BUY 153130 DAY 76도 이 주기에 나갔고, 그 76주가 체결되면 나머지를 그날 사지 못했음)
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + B + " DAY 200", "SELL " + A + " DAY 100");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();

        // 스탑 매도가 체결로 끝나 대금이 들어온 다음 주기 — 그 대금으로 현금성을 삼(같은 창 마무리 — 회전율 멈춤 없음). 매수는 상한가(13,000원)로
        // 현금을 잡으므로 1,000만 원으로는 900주가 아니라 769주
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", B, "SELL", "DAY", "FILLED", "200", "200", clock.now, clock.now)));
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("10000000", Map.of(), Map.of(CASH_LIKE, "10000"));
        run("09:10:40");

        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + B + " DAY 200", "SELL " + A + " DAY 100", "BUY " + CASH_LIKE + " DAY 769");
    }

    @Test
    @DisplayName("QA-302: 묶음보다 먼저 스탑 경로가 판 스탑(진행 중)의 대금으로 사는 현금성 매수도 회전율 멈춤을 걸지 않음 — 진행 중인 스탑 매도를 취소하지 않음")
    void qa302StopsSentBeforeBatchDoNotTripTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.of(SYNC_AT));
        when(paper.targetsAt(BOOK, SESSION, SYNC_AT)).thenReturn(Optional.empty());
        stoppedAccount();
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A, B));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(661, A, "AT_MINUTE", SYNC_AT),
                stopDue(662, B, "AT_MINUTE", SYNC_AT)));

        run("09:10:05");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100", "SELL " + B + " DAY 200");

        timedTargets(Map.of(CASH_LIKE, 90.0), List.of(), List.of(661L, 662L));
        run("09:10:40");

        // 계획의 회전율은 현금성 90%뿐(A·B는 이 기능 주문 진행 중) — 먼저 보낸 스탑 900만 원까지 빼면 0
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        verify(client, never()).cancelOrder(anyString());
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + A + " DAY 100", "SELL " + B + " DAY 200", "BUY " + CASH_LIKE + " DAY 76");
    }

    @Test
    @DisplayName("QA-302: 시가 맞추기 날 묶음이 흡수한 NEXT_OPEN 스탑도 회전율 멈춤을 걸지 않음 — OPG 매도가 나가고 켜짐 유지")
    void qa302OpgAbsorbedStopsDoNotTripTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));
        targets(Map.of(CASH_LIKE, 90.0), List.of(671L, 672L));
        stoppedAccount();
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A, B));

        run("08:51");

        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + B + " OPG 200", "SELL " + A + " OPG 100", "BUY " + CASH_LIKE + " OPG 76");
    }

    @Test
    @DisplayName("QA-302 대조: 스탑이 없으면 같은 목표(매도 90% + 현금성 매수 90%)는 그대로 회전율 이상 멈춤 — 묶음·주문 없음")
    void qa302NonStopSellsStillTripTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(CASH_LIKE, 90.0), List.of(), List.of());
        stoppedAccount();

        run("09:10:05");

        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        verify(client, never()).placeOrder(anyString());
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    @Test
    @DisplayName("QA-302: 스탑 대금으로 보는 현금성 매수는 스탑 매도 금액까지만 — 스탑 A(50%) + 스탑 아닌 B 매도(40%) + 현금성 매수(90%)는 80%로 이상 멈춤")
    void qa302StopFundedCashLikeOnlyUpToStopProceeds() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(CASH_LIKE, 90.0), List.of(), List.of(661L));
        stoppedAccount();
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A));

        run("09:10:05");

        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(cfg().haltDetail().path("turnoverPct").decimalValue()).as("180% − 스탑 50% − 현금성 중 스탑 대금 50%")
                .isEqualByComparingTo("80.00");
        verify(client, never()).placeOrder(anyString());
    }

    @Test
    @DisplayName("대기 STOP 종목은 매수를 보내지 않음 — 묶음(재시도 포함)·장중 따라 하기 모두 보내기 직전에 다시 읽음(R2)")
    void pendingStopBlocksBuys() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(B, 30.0, C, 10.0), List.of(), List.of());
        preflight("10000000", Map.of(), Map.of(B, "20000", C, "40000"));
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(B));

        run("09:10:05");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + C + " DAY 25");

        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(701, 700, B, "BUY", kst("2026-11-06T10:30"))));
        when(paper.weightAfter(eq(BOOK), eq(701L), any())).thenReturn(Optional.of(new WeightAfter(701, B, "BUY", 20.0, 1e7, true,
                List.of(701L), List.of())));
        run("10:30:10");
        verify(client, times(1)).placeOrder(anyString());
        assertThat(events("WINDOW_SUMMARY")).filteredOn(e -> e.detail().path("window").asString().equals("SYNC_AT")).singleElement()
                .satisfies(e -> assertThat(e.detail().path("reasons").path("pending-stop").asInt()).isEqualTo(1));
    }

    @Test
    @DisplayName("R2: 09:10 묶음의 매도 대금을 기다리던 매수가 재시도될 때 그사이 그 종목에 대기 STOP이 생겼으면 다시 사지 않음")
    void pendingStopBlocksDeferredRetry() {
        RealTradeFixtures.live(store, true, d("4000000"));
        timedTargets(Map.of(B, 50.0), List.of(), List.of());
        preflight("0", Map.of(C, new String[]{"100", "40000"}), Map.of(B, "20000"));

        run("09:10:05");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).as("매수는 매도 대금을 기다림(deferred-cash)")
                .containsExactly("SELL " + C + " DAY 100");

        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("4000000", Map.of(), Map.of(B, "20000"));
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(B));   // 09:12 감지 — B에 대기 STOP
        run("09:12:30");
        run("09:13:00");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).as("재시도 매수가 방금 판 종목을 다시 사지 않음")
                .containsExactly("SELL " + C + " DAY 100");

        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of());
        clock.set(kst("2026-11-06T09:12:00"));
        RealTradeJob fresh = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, false, 10_000);
        fresh.cycle(kst("2026-11-06T09:12:00"));
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).as("STOP이 없으면 같은 재시도가 매수를 보냄(대조)")
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 100");
    }

    @Test
    @DisplayName("장부 밀림으로 쉬는 날에도 스탑 매도만(묶음·장중 따라 하기 없음), 장 시간 불일치 날에는 스탑도 보내지 않음")
    void ledgerBehindStopsOnly() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.ledgerCaughtUp(BOOK, SESSION)).thenReturn(false);
        targets(Map.of(B, 50.0), List.of(11L));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of(B, "20000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(651, A, "MARKET", kst("2026-11-06T11:00")),
                dueFor(652, 652, B, "BUY", kst("2026-11-06T11:00"))));
        when(paper.weightAfter(eq(BOOK), eq(652L), any())).thenReturn(Optional.of(new WeightAfter(652, B, "BUY", 20.0, 1e7, true,
                List.of(652L), List.of())));

        run("08:51");
        run("11:00:10");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + A + " DAY 100");
        assertThat(events("SKIP_DAY")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString())
                .isEqualTo(RealTradePlanner.SKIP_LEDGER));
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    @Test
    @DisplayName("장 시간 불일치(수능일형 설정 없음) 날에는 스탑도 보내지 않음")
    void hoursMismatchNoStops() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.sessionHours(SESSION)).thenReturn(Optional.of(new SessionHours(SESSION, true, kst("2026-11-06T10:00"),
                kst("2026-11-06T16:30"))));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(661, A, "MARKET", kst("2026-11-06T11:00"))));
        run("08:51");
        run("11:00:10");
        verify(client, never()).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 멈춤·끄기
    @Test
    @DisplayName("이상 멈춤(토큰 경합) → 이 기능의 미체결 취소, 창 안이어도 매도까지 보내지 않음")
    void haltStopsEverything() {
        syncBuy100();
        when(client.status()).thenReturn(Reply.of(new CollectorTradeClient.Status(true, null, RealTradeFixtures.limits(), true,
                Instant.EPOCH)));
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "OPG", "PENDING", "100", "0", clock.now, null))));
        targets(Map.of(), List.of());
        preflight("0", Map.of(C, new String[]{"100", "40000"}), Map.of());

        run("08:52");

        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("token-contention");
        verify(client).cancelOrder("T-1");
        run("08:53");
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("복원 직후(HALTED·restored) — 창 안이어도 계획·주문 없이 이 기능의 미체결 취소와 추적만")
    void restoredHaltedOnlyCancels() {
        syncBuy100();
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_HALTED).withHalt("restored", null),
                null));
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "OPG", "PENDING", "100", "0", clock.now, null))));
        org.mockito.Mockito.clearInvocations(paper);

        run("08:52");

        verify(client).cancelOrder("T-1");
        verify(client, times(1)).placeOrder(anyString());
        verify(paper, never()).openTargets(anyString(), any());
        assertThat(cfg().state()).isEqualTo("HALTED");
    }

    @Test
    @DisplayName("따라 하는 책이 리셋·재출발(세대 다름)하면 이상 멈춤(book-changed)")
    void bookChangedHalts() {
        RealTradeFixtures.live(store, true, d("10000000"));
        when(paper.book(BOOK)).thenReturn(Optional.of(book("2026-11-05|2026-11-05T01:00:00Z")));
        run("08:51");
        assertThat(cfg().haltReason()).isEqualTo("book-changed");
        verify(client, never()).placeOrder(anyString());
    }

    @Test
    @DisplayName("끄는 중(STOPPING) → 이 기능의 미체결 취소를 따라가고, 모두 종료되면 OFF(STOPPED 이벤트)")
    void stoppingFinishes() {
        syncBuy100();
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "OPG", "PENDING", "100", "0", clock.now, null))));

        run("08:52");
        verify(client).cancelOrder("T-1");
        assertThat(cfg().state()).isEqualTo("STOPPING");

        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "OPG", "CANCELED", "100", "0", clock.now, null)));
        run("08:52:10");
        assertThat(cfg().state()).isEqualTo("OFF");
        assertThat(events("STOPPED")).hasSize(1);
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("끄는 중 — 지난 세션의 부분 체결(미체결 목록에 없음)은 끝난 주문으로 보고 OFF로 정리(취소를 끝없이 보내지 않음)")
    void stoppingEndsWithPastSessionPartialFill() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        clock.set(kst("2026-11-05T14:00"));
        executor.send(new RealTradeExecutor.Send(SESSION.minusDays(1), RealTradeStore.PURPOSE_MIRROR, null, 951L, 950L, A, "BUY", 10, "DAY",
                d("50000"), 1), cfg);
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "BUY", "DAY", "PARTIAL_FILLED", "10", "4", clock.now, null)));

        run("09:00:10");

        assertThat(cfg().state()).isEqualTo("OFF");
        verify(client, never()).cancelOrder(anyString());
        assertThat(store.recentOrders("KR", 1).getFirst().filledQuantity()).isEqualByComparingTo("4");
    }

    @Test
    @DisplayName("끄는 중 → OFF 이벤트(STOPPED)는 끈 뒤 끝난 주문을 취소로 끝남·체결로 끝남으로 나눠 셈(정리 결과를 단정하지 않게)")
    void stoppedSplitsCanceledAndFilled() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000", B, "20000"));
        run("08:51");
        assertThat(sentBodies()).hasSize(2);
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", B, "BUY", "OPG", "CANCELED", "150", "0", clock.now, null)));
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "BUY", "OPG", "FILLED", "93", "93", clock.now, clock.now)));

        run("08:52");

        assertThat(cfg().state()).isEqualTo("OFF");
        assertThat(events("STOPPED")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("canceled").asInt()).isEqualTo(1);
            assertThat(e.detail().path("filled").asInt()).isEqualTo(1);
            assertThat(e.detail().path("other").asInt()).isZero();
            assertThat(e.detail().path("unresolved").asInt()).isZero();
        });
    }

    // ------------------------------------------------------------------ 결과 모름 재전송과 끄기·멈춤(RT-BE-4)
    /** 행 하나는 접수(T-1), 하나는 결과 모름(재전송 창 안) — 그대로면 다음 주기가 결과 모름을 같은 키로 다시 보냄. */
    private void acceptedAndUnknown() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        clock.set(kst("2026-11-06T10:00"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-1", null, 200));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 961L, 960L, A, "BUY", 5, "DAY", d("50000"), 1),
                cfg);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 971L, 970L, B, "BUY", 5, "DAY", d("20000"), 1),
                cfg);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-2", null, 200));
    }

    @Test
    @DisplayName("추적이 이상 멈춤을 건 주기에서는 결과 모름을 다시 보내지 않음")
    void noResendAfterTrackHalts() {
        acceptedAndUnknown();
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "DAY", "MYSTERY", "5", "0", clock.now, null))));

        run("10:00:30");

        assertThat(cfg().haltReason()).isEqualTo("unknown-broker-status");
        verify(client, times(2)).placeOrder(anyString());
    }

    @Test
    @DisplayName("추적 도중 끄기가 커밋되면 같은 주기에서 결과 모름을 다시 보내지 않음")
    void noResendWhenDisabledDuringTrack() {
        acceptedAndUnknown();
        when(client.openOrders()).thenAnswer(inv -> {
            store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));
            return Reply.of(List.of(broker("T-1", A, "BUY", "DAY", "PENDING", "5", "0", clock.now, null)));
        });

        run("10:00:30");

        assertThat(cfg().state()).isEqualTo("STOPPING");
        verify(client, times(2)).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 정기 작업이 멈추지 않게(RT-BE-6)
    @Test
    @DisplayName("한 주기에서 Error가 나도 다음 주기가 돈다(전용 스케줄러가 조용히 멈추지 않게) — 마지막 주기 시각은 예외 없이 끝난 주기만")
    void tickSurvivesError() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(client.status()).thenThrow(new StackOverflowError()).thenReturn(RealTradeFixtures.enabledStatus());
        RealTradeJob scheduled = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, true, 10_000);

        clock.set(kst("2026-11-06T10:00"));
        scheduled.tick();
        assertThat(scheduled.lastCycleAt()).as("Error로 끝난 주기는 세지 않음").isNull();
        clock.set(kst("2026-11-06T10:00:10"));
        scheduled.tick();

        verify(client, times(2)).status();
        verify(client).calendar();
        assertThat(scheduled.lastCycleAt()).isEqualTo(kst("2026-11-06T10:00:10"));
        job.tick();
        assertThat(job.lastCycleAt()).as("스케줄러가 꺼진 정기 작업은 null").isNull();
    }

    // ------------------------------------------------------------------ 손실 한도의 기준(RT-BE-3)
    /** 안전 상한 1,000만 원·켤 때 총액 3,000만 원(E0 1,000만·U0 3,000만, 한도 15% = 150만 원) — 시가 맞추기 직전 보유 B가 떨어짐. */
    private void cappedBaseline(String cash, String bQuantity) {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 200, 999_999_999L,
                10_000_000L)));
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_LIVE).withSource(BOOK, GENERATION)
                .withSyncPending(true).withBaselineEquity(d("10000000")).withBaselineTotal(d("30000000")), 1L));
        targets(Map.of(A, 50.0), List.of());
        preflight(cash, Map.of(B, new String[]{bQuantity, "20000"}), Map.of(A, "50000"));
    }

    @Test
    @DisplayName("손실 한도 — 총액이 안전 상한보다 커도 (기준 총액 − 지금 총액) ≥ 기준 평가액 × 한도%면 매수 멈춤(상한 밖 현금이 손실을 가리지 않음)")
    void lossLimitUsesUncappedTotal() {
        cappedBaseline("20000000", "350");   // 운용분 1,000만 → 700만(−30%), 총액 2,700만 — 상한 적용 E는 여전히 1,000만

        run("08:51");

        assertThat(cfg().buysPaused()).isTrue();
        assertThat(events("BUYS_PAUSED")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString()).isEqualTo("loss-limit"));
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + B + " OPG 350");
    }

    @Test
    @DisplayName("손실 한도 — 총액이 상한보다 크고 손실이 한도 아래면 매수를 그대로 함")
    void lossBelowLimitAboveCapKeepsBuying() {
        cappedBaseline("20000000", "450");   // 총액 2,900만 — 손실 100만 < 150만

        run("08:51");

        assertThat(cfg().buysPaused()).isFalse();
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + B + " OPG 450", "BUY " + A + " OPG 100");
        assertThat(job.lastPreflight().total()).as("화면의 지금 총액(상한 없음)").isEqualByComparingTo("29000000");
        assertThat(job.lastPreflight().equity()).isEqualByComparingTo("10000000");
    }

    // ------------------------------------------------------------------ 손실 한도의 판정값과 앱 미체결 매수(QA-379)
    /** 기준 E0 = U0 = 1,000만 원(안전 상한에 닿지 않음), 손실 한도 15% = 150만 원. 따라 하는 책 목표는 A 50%. */
    private void plainBaseline() {
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_LIVE).withSource(BOOK, GENERATION)
                .withSyncPending(true).withBaselineEquity(d("10000000")).withBaselineTotal(d("10000000")), 1L));
        targets(Map.of(A, 50.0), List.of());
    }

    /** 사전 조회 — {@link #preflight}와 같되 하한가(현재가 × 0.7)도 줍니다. */
    private void preflightWithLimits(String cash, Map<String, String[]> holdings, Map<String, String> extraQuotes) {
        List<Holding> hs = new ArrayList<>();
        Map<String, Quote> quotes = new LinkedHashMap<>();
        Map<String, BigDecimal> sellable = new LinkedHashMap<>();
        holdings.forEach((symbol, qp) -> {
            hs.add(new Holding(symbol, "합성" + symbol, d(qp[0]), d(qp[1])));
            quotes.put(symbol, new Quote(d(qp[1]), d(qp[1]).multiply(d("1.3")), d(qp[1]).multiply(d("0.7"))));
            sellable.put(symbol, d(qp[0]));
        });
        extraQuotes.forEach((symbol, price) -> quotes.put(symbol, new Quote(d(price), d(price).multiply(d("1.3")), d(price).multiply(d("0.7")))));
        when(client.preflight(any(), any())).thenReturn(Reply.of(new Preflight(clock.now, d(cash), hs, quotes, sellable)));
    }

    /** 이 기능이 내지 않은 토스 미체결 매수(앱 주문) — 주문 번호는 이 기능의 행에 없는 합성 값. */
    private static CollectorTradeClient.BrokerOrder appBuy(String id, String symbol, String orderType, String quantity, String filled) {
        return new CollectorTradeClient.BrokerOrder(id, symbol, "BUY", orderType, "DAY", "PENDING", d(quantity), d(filled), null, null, null,
                null, kst("2026-11-06T08:40"), null, null, "KRW");
    }

    private void tossOrders(CollectorTradeClient.BrokerOrder... orders) {
        when(client.openOrders()).thenReturn(Reply.of(List.of(orders)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(orders)));
    }

    @Test
    @DisplayName("QA-379: 켠 뒤 앱에서 걸어 둔 시장가 매수(잡힌 금액 ≥ 손실 한도 금액)는 손실이 아니다 — 매수 멈춤 없이 그대로 따라 함")
    void appMarketBuyPendingIsNotALoss() {
        plainBaseline();
        // 실제 현금 600만·보유 C 400만(손실 0). 앱 시장가 매수 B 100주가 상한가 26,000 × 100 = 260만 원을 잡아 매수 가능 금액은 340만 원.
        preflightWithLimits("3400000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
        tossOrders(appBuy("APP-1", B, "MARKET", "100", "0"));

        run("08:51");

        assertThat(cfg().buysPaused()).as("수정 전에는 U0 − 지금 총액 = 260만 ≥ 150만이라 거짓 매수 멈춤").isFalse();
        assertThat(events("BUYS_PAUSED")).isEmpty();
        assertThat(job.lastPreflight().total()).as("지금 총액 = 340만 + 400만 + 되돌린 260만").isEqualByComparingTo("10000000");
        assertThat(sentSummaries()).containsExactly("SELL " + C + " OPG 100", "BUY " + A + " OPG 52");
    }

    @Test
    @DisplayName("QA-379: 앱 매수 종목이 책에도 보유에도 없어 사전 조회에 시세가 없으면, 하루 한도를 세며 한 번 더 물은 시세로 되돌린다(토스 호출을 더하지 않음)")
    void appBuyOnUnaskedSymbolUsesQuotesFetchedForDailyRoom() {
        plainBaseline();
        List<Holding> holdings = List.of(new Holding(C, "합성" + C, d("100"), d("40000")));
        Preflight base = new Preflight(clock.now, d("3400000"), holdings, Map.of(A, new Quote(d("50000"), d("65000"), d("35000")),
                C, new Quote(d("40000"), d("52000"), d("28000"))), Map.of(C, d("100")));
        Preflight withD = new Preflight(clock.now, d("3400000"), holdings, Map.of(D, new Quote(d("20000"), d("26000"), d("14000"))), Map.of());
        when(client.preflight(any(), any())).thenAnswer(inv -> ((java.util.Collection<?>) inv.getArgument(0)).contains(D)
                ? Reply.of(withD) : Reply.of(base));
        tossOrders(appBuy("APP-3", D, "MARKET", "100", "0"));   // 상한가 26,000 × 100 = 260만 원을 잡음

        run("08:51");

        assertThat(cfg().buysPaused()).isFalse();
        assertThat(job.lastPreflight().total()).isEqualByComparingTo("10000000");
        verify(client, times(2)).preflight(eq(new java.util.TreeSet<>(List.of(D))), any());   // 두 단계 사전 조회마다 하루 한도 셈이 한 번씩 — 손실 판정용 호출은 없음
    }

    @Test
    @DisplayName("QA-379: 앱 시장가 매수가 걸린 채 켜면 기준 총액과 첫 주기의 지금 총액이 같은 값이다 — 켜자마자 매수가 멈추지 않음")
    void enableBaselineMatchesTheJudgedTotal() {
        com.macrodash.feature.auth.AuthService auth = mock(com.macrodash.feature.auth.AuthService.class);
        when(auth.verify(eq("owner@test.local"), eq("synthetic-password"))).thenReturn(Optional.of(new com.macrodash.store.UserStore.User(7L,
                "owner@test.local", "hash", "OWNER", "PRO", Instant.EPOCH, Instant.EPOCH)));
        RealTradeService service = new RealTradeService(store, client, paper, auth, job, executor, clock, true);
        targets(Map.of(A, 50.0), List.of());
        preflightWithLimits("3400000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
        tossOrders(appBuy("APP-1", B, "MARKET", "100", "0"));
        clock.set(kst("2026-11-06T08:40"));

        service.enable(new com.macrodash.support.CurrentUser(7L, "owner@test.local", "OWNER", "PRO", null), new RealTradeService.EnableRequest(
                "KR", BOOK, new BigDecimal("15"), "실제 매매 켜기", "synthetic-password", 0));
        assertThat(cfg().baselineTotal()).as("기준 총액 = 340만 + 400만 + 앱 매수가 잡은 260만").isEqualByComparingTo("10000000");

        run("08:51");

        assertThat(job.lastPreflight().total()).as("판정값도 같은 정의").isEqualByComparingTo(cfg().baselineTotal());
        assertThat(cfg().buysPaused()).as("수정 전에는 켠 직후 첫 주기에 거짓 매수 멈춤").isFalse();
        assertThat(events("BUYS_PAUSED")).isEmpty();
    }

    @Test
    @DisplayName("QA-379: 앱 지정가 매수는 잡힌 금액을 모르므로 하한가 기준으로만 되돌린다 — 그만큼은 거짓 멈춤이 줄어듦(지정가 200만 원 → 차이 60만 원 < 150만 원)")
    void appLimitBuyPendingAddsBackItsFloor() {
        plainBaseline();
        // 실제 현금 600만·보유 C 400만(손실 0). 앱 지정가 매수 B 100주 @ 20,000이 200만 원을 잡아 매수 가능 금액은 400만 원. 하한가 14,000 × 100 = 140만 원만 되돌림.
        preflightWithLimits("4000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
        tossOrders(appBuy("APP-2", B, "LIMIT", "100", "0"));

        run("08:51");

        assertThat(cfg().buysPaused()).as("수정 전에는 차이 200만 ≥ 150만이라 거짓 매수 멈춤").isFalse();
        assertThat(job.lastPreflight().total()).as("400만 + 400만 + 140만").isEqualByComparingTo("9400000");
    }

    @Test
    @DisplayName("QA-379 반대 방향 고정: 앱 시장가 매수가 걸려 있어도 진짜 손실이 한도를 넘으면 매수를 멈춘다(되돌림이 손실을 가리지 않음)")
    void realLossStillPausesWhileAppBuyIsPending() {
        plainBaseline();
        // 보유 C가 400만 → 240만(손실 160만 ≥ 150만). 앱 시장가 매수 B가 260만을 잡음 — 되돌려도 지금 총액은 840만.
        preflightWithLimits("3400000", Map.of(C, new String[]{"100", "24000"}), Map.of(A, "50000", B, "20000"));
        tossOrders(appBuy("APP-1", B, "MARKET", "100", "0"));

        run("08:51");

        assertThat(cfg().buysPaused()).isTrue();
        assertThat(events("BUYS_PAUSED")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString()).isEqualTo("loss-limit"));
        assertThat(sentSummaries()).as("매도는 계속").containsExactly("SELL " + C + " OPG 100");
    }

    @Test
    @DisplayName("QA-379 반대 방향 고정: 앱 지정가 매수는 상한가가 아니라 하한가 기준으로만 되돌린다 — 상한가로 되돌리면 가려질 진짜 손실(160만 ≥ 150만)에 매수를 멈춘다")
    void appLimitBuyDoesNotHideARealLoss() {
        plainBaseline();
        // 보유 C가 400만 → 240만(손실 160만). 앱 지정가 매수 B 100주 @ 20,000이 200만을 잡아 매수 가능 금액 400만.
        // 상한가(26,000)로 되돌리면 지금 총액 900만(손실 100만 — 한도 아래로 보임), 하한가(14,000)로 되돌리면 780만(멈춤).
        preflightWithLimits("4000000", Map.of(C, new String[]{"100", "24000"}), Map.of(A, "50000", B, "20000"));
        tossOrders(appBuy("APP-2", B, "LIMIT", "100", "0"));

        run("08:51");

        assertThat(cfg().buysPaused()).isTrue();
        assertThat(sentSummaries()).containsExactly("SELL " + C + " OPG 100");
    }

    @Test
    @DisplayName("QA-379 반대 방향 고정: 이 기능이 낸 미체결 매수는 토스 미체결 목록에도 있지만 한 번만 되돌린다(두 번 되돌리면 손실 160만이 가려짐)")
    void ownPendingBuyIsAddedBackOnce() {
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_LIVE).withSource(BOOK, GENERATION)
                .withBaselineEquity(d("10000000")).withBaselineTotal(d("10000000")), 1L));
        clock.set(kst("2026-11-06T10:00"));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 901L, 900L, A, "BUY", 40, "DAY", d("50000"), 1),
                cfg());   // 이 기능의 매수 40주 접수(T-1) — 상한가 65,000 × 40 = 260만 원을 잡음
        tossOrders(broker("T-1", A, "BUY", "DAY", "PENDING", "40", "0", clock.now, null));
        // 실제 현금 600만 − 잡힌 260만 = 340만, 보유 C가 400만 → 240만(손실 160만)
        preflightWithLimits("3400000", Map.of(C, new String[]{"100", "24000"}), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(911, C, "MARKET", kst("2026-11-06T10:01"))));

        run("10:01:10");

        assertThat(job.lastPreflight().total()).as("340만 + 240만 + 260만(한 번)").isEqualByComparingTo("8400000");
        assertThat(cfg().buysPaused()).isTrue();
        assertThat(sentSummaries()).as("스탑 매도는 매수 멈춤과 상관없이").contains("SELL " + C + " DAY 100");
    }

    @Test
    @DisplayName("QA-379 반대 방향 고정: 주문 번호를 아직 묶지 못한 이 기능의 매수(결과 모름 행)가 토스 미체결 목록에 보여도 한 번만 되돌린다 — "
            + "묶기 전(미체결 목록 쪽)과 대조로 묶은 뒤(이 기능의 행 쪽)의 지금 총액이 같고, 손실 160만은 가려지지 않는다")
    void ownUnknownBuyListedByTossIsAddedBackOnce() {
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_LIVE).withSource(BOOK, GENERATION)
                .withBaselineEquity(d("10000000")).withBaselineTotal(d("10000000")), 1L));
        clock.set(kst("2026-11-06T10:00"));
        // 이 기능의 매수 A 40주가 결과 모름(같은 키 재전송도 계속 결과 모름) — 실제로는 토스에 주문이 생겨 상한가 65,000 × 40 = 260만 원을 잡음
        when(client.placeOrder(anyString())).thenAnswer(inv -> A.equals(RealTradeFixtures.MAPPER.readTree((String) inv.getArgument(0))
                .path("symbol").asString()) ? new OrderResult(Outcome.UNKNOWN, null, "collector-timeout", null)
                : new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 921L, 920L, A, "BUY", 40, "DAY", d("50000"), 1),
                cfg());
        OrderRow unknown = store.recentOrders("KR", 1).getFirst();
        assertThat(unknown.tossOrderId()).as("주문 번호를 아직 묶지 못함").isNull();
        tossOrders(broker("T-LATE", A, "BUY", "DAY", "PENDING", "40", "0", unknown.firstSentAt().plusSeconds(1), null));
        // 켤 때: 현금 580만 + C 400만 + B 20만 = 1,000만. 지금: 현금 580만 − 잡힌 260만 = 320만, C가 240만으로(손실 160만 ≥ 한도 150만), B 20만
        preflightWithLimits("3200000", Map.of(C, new String[]{"100", "24000"}, B, new String[]{"10", "20000"}), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(931, C, "MARKET", kst("2026-11-06T10:01")),
                stopDue(932, B, "MARKET", kst("2026-11-06T10:08"))));

        run("10:01:10");   // 재전송 창 안 — 행은 결과 모름 그대로, 그 주문은 토스 미체결 목록에만 보임

        assertThat(store.ordersForRoot("KR", 920L)).singleElement().satisfies(r -> assertThat(r.tossOrderId()).isNull());
        assertThat(job.lastPreflight().total()).as("320만 + 240만 + 20만 + 260만(미체결 목록 쪽으로 한 번 — 이 기능의 행 쪽은 주문 번호가 없어 0)")
                .isEqualByComparingTo("8400000");
        assertThat(cfg().buysPaused()).as("두 번 되돌리면 1,100만으로 보여 손실 160만이 가려짐").isTrue();
        assertThat(sentSummaries()).as("스탑 매도는 매수 멈춤과 상관없이").contains("SELL " + C + " DAY 100");

        clock.set(kst("2026-11-06T10:08:10"));
        preflightWithLimits("3200000", Map.of(C, new String[]{"100", "24000"}, B, new String[]{"10", "20000"}), Map.of(A, "50000"));
        run("10:08:10");   // 재전송 창(7분) + 여유(45초) 뒤 — 대조가 그 주문을 행에 묶음

        assertThat(store.ordersForRoot("KR", 920L)).singleElement().satisfies(r -> assertThat(r.tossOrderId()).isEqualTo("T-LATE"));
        assertThat(job.lastPreflight().fetchedAt()).as("묶은 뒤 새로 읽은 값").isEqualTo(kst("2026-11-06T10:08:10"));
        assertThat(job.lastPreflight().total()).as("묶은 뒤에는 이 기능의 행 쪽으로 한 번(미체결 목록 쪽은 주문 번호로 뺌) — 같은 값")
                .isEqualByComparingTo("8400000");
        assertThat(sentSummaries()).contains("SELL " + B + " DAY 10");
        assertThat(cfg().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("같은 사유 코드 3회(429·반대 방향·수집기 한도 거절 제외) → 이상 멈춤(repeated-error)")
    void repeatedErrorHalts() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.NOT_SENT, null, "invalid-symbol", null));
        clock.set(kst("2026-11-06T10:00"));
        for (long root = 500; root < 503; root++) {
            executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, root + 1, root, A, "BUY", 1, "DAY",
                    d("50000"), 1), cfg);
        }
        run("10:00:10");
        assertThat(cfg().haltReason()).isEqualTo("repeated-error");
    }

    @Test
    @DisplayName("수집기 한도 거절(over-daily-buy·over-daily-orders·over-order-limit)은 3회여도 이상 멈춤이 아님 — 접수된 주문을 취소하지 않음")
    void collectorLimitRejectsDoNotHalt() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        clock.set(kst("2026-11-06T10:00"));
        long root = 520;
        for (String code : List.of("over-daily-buy", "over-daily-buy", "over-daily-buy", "over-daily-orders", "over-daily-orders",
                "over-daily-orders", "over-order-limit", "over-order-limit", "over-order-limit")) {
            when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.NOT_SENT, null, code, null));
            executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, root + 1, root, A, "BUY", 1, "DAY",
                    d("50000"), 1), cfg);
            root += 2;
        }
        run("10:00:10");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(cfg().haltReason()).isNull();
        verify(client, never()).cancelOrder(anyString());
    }

    // ------------------------------------------------------------------ 시각 맞추기의 매매 제한 대기(2026-11-09 사용자 결정)
    private void timedRestrictionDay() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(21L, 22L), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
    }

    private void restrictions(Set<String> vi, String kospiPct) {
        when(client.restrictions(any())).thenReturn(Reply.of(new CollectorTradeClient.Restrictions(vi,
                kospiPct == null ? Map.of() : Map.of("KOSPI", d(kospiPct)))));
    }

    private List<String> sentSummaries() {
        return sentBodies().stream().map(RealTradeJobDbTest::summary).toList();
    }

    @Test
    @DisplayName("매매 제한 — VI 종목만 빼고 보내고, 풀리면 늘어난 창 안에서 그 종목을 시장가로 보냄")
    void timedSyncWaitsForVi() {
        timedRestrictionDay();
        restrictions(Set.of(A), null);

        run("09:10:05");
        assertThat(sentSummaries()).noneMatch(o -> o.contains(A)).anyMatch(o -> o.startsWith("SELL " + C));
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(events("RESTRICTED")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString()).isEqualTo("vi-active"));

        run("09:12:30");
        assertThat(sentSummaries()).noneMatch(o -> o.contains(A));

        // 09:10에 보낸 C 매도는 체결로 끝난 상태로 둠 — 진행 중이면 현금이 모자란 A(32주뿐)는 VI가 풀려도 매도 대금을 기다림(QA-1018). 끝났으면 지금처럼 줄여 보냄
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        restrictions(Set.of(), null);
        run("09:13:30");   // 원래 창(09:13) 뒤 — 늘어난 창 안
        assertThat(sentSummaries()).anyMatch(o -> o.startsWith("BUY " + A + " DAY"));
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("RESTRICTED")).hasSize(1);
    }

    /** 실제 클라이언트({@code CollectorTradeClient.restrictions})와 같은 입력 검사를 하는 가짜 — 형식 밖 종목이 하나라도 있거나 60개를 넘으면 조회 실패. */
    private void strictRestrictions(Set<String> vi, List<java.util.Collection<String>> asked) {
        when(client.restrictions(any())).thenAnswer(inv -> {
            java.util.Collection<String> symbols = inv.getArgument(0);
            asked.add(List.copyOf(symbols));
            if (symbols.size() > 60 || symbols.stream().anyMatch(s -> s == null || !s.matches("^[0-9][0-9A-Z]{5}$"))) {
                return Reply.failed("invalid-symbol");
            }
            return Reply.of(new CollectorTradeClient.Restrictions(vi, Map.of()));
        });
    }

    @Test
    @DisplayName("QA-351: 형식 밖 종목 코드의 보유가 있어도 매매 제한 조회는 형식에 맞는 종목만으로 부르고, VI 종목은 기다린다")
    void restrictionsQuerySkipsMalformedHoldings() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(21L, 22L), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}, "Q500001", new String[]{"3", "10000"}), Map.of(A, "50000", B, "20000"));
        List<java.util.Collection<String>> asked = new ArrayList<>();
        strictRestrictions(Set.of(A), asked);

        run("09:10:05");

        assertThat(asked).isNotEmpty().allSatisfy(symbols -> assertThat(symbols).doesNotContain("Q500001").contains(A, B, C));
        assertThat(sentSummaries()).as("VI인 A는 기다림(수정 전에는 조회가 빠져 바로 보냄)").noneMatch(o -> o.contains(A))
                .anyMatch(o -> o.startsWith("SELL " + C));
        assertThat(events("RESTRICTED")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString()).isEqualTo("vi-active"));
    }

    @Test
    @DisplayName("QA-351: 보유가 많아 물어볼 종목이 60개를 넘으면 주문 대상 종목을 먼저 넣고 60개에서 자른다")
    void restrictionsQueryKeepsOrderSymbolsWithinLimit() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(21L, 22L), List.of());
        Map<String, String[]> holdings = new LinkedHashMap<>();
        for (int i = 0; i < 70; i++) {
            holdings.put(String.format("9%05d", i), new String[]{"1", "1000"});   // 합성 종목 70개(주문 대상 A·B보다 뒤 순서)
        }
        preflight("6000000", holdings, Map.of(A, "50000", B, "20000"));
        List<java.util.Collection<String>> asked = new ArrayList<>();
        strictRestrictions(Set.of(A), asked);

        run("09:10:05");

        assertThat(asked).isNotEmpty().allSatisfy(symbols -> {
            assertThat(symbols).hasSizeLessThanOrEqualTo(60);
            assertThat(symbols).as("주문 대상 종목이 먼저").contains(A, B);
        });
        assertThat(sentSummaries()).as("VI인 A는 기다림").noneMatch(o -> o.contains(" " + A + " "));
    }

    @Test
    @DisplayName("QA-351: 매매 제한 조회 종목 — 형식 밖 코드는 빼고, 주문 대상 먼저·보유 다음, 상한은 수집기 RESTRICTION_MAX_SYMBOLS와 같다")
    void restrictionQueryOrderAndLimit() throws Exception {
        assertThat(RealTradeJob.restrictionQuery(List.of(B, "bad code", A), Set.of(C, "Q500001", "AAPL")))
                .as("주문 대상(코드 순) 먼저, 그다음 보유").containsExactly(B, A, C);
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            many.add(String.format("9%05d", i));
        }
        assertThat(RealTradeJob.restrictionQuery(List.of(A, B), many)).hasSize(RealTradeJob.RESTRICTION_MAX_SYMBOLS).startsWith(B, A);
        java.nio.file.Path trade = java.nio.file.Path.of("../collector/app/services/toss_trade.py");
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.exists(trade), "collector/app/services/toss_trade.py를 찾을 수 없습니다");
        java.util.regex.Matcher max = java.util.regex.Pattern.compile("(?m)^RESTRICTION_MAX_SYMBOLS\\s*=\\s*(\\d+)")
                .matcher(java.nio.file.Files.readString(trade));
        assertThat(max.find()).isTrue();
        assertThat(Integer.parseInt(max.group(1))).isEqualTo(RealTradeJob.RESTRICTION_MAX_SYMBOLS);
    }

    @Test
    @DisplayName("매매 제한 — VI 표시가 6분 넘게 안 풀리면 더 기다리지 않고 보냄")
    void timedSyncStopsWaitingForVi() {
        timedRestrictionDay();
        restrictions(Set.of(A), null);
        run("09:10:05");
        // 09:10에 보낸 C 매도는 체결로 끝난 상태로 둠 — 진행 중이면 현금이 모자란 A(32주뿐)는 VI 대기를 그만둬도 매도 대금을 기다림(QA-1018)
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        run("09:15:30");
        assertThat(sentSummaries()).noneMatch(o -> o.contains(A));
        run("09:16:10");
        assertThat(sentSummaries()).anyMatch(o -> o.startsWith("BUY " + A + " DAY"));
    }

    @Test
    @DisplayName("매매 제한 — 지수 −8%면 서킷브레이커로 보고 묶음도 만들지 않다가 31분 뒤 늘어난 창 안에서 보냄(지수가 그대로여도)")
    void timedSyncWaitsForCircuitBreaker() {
        timedRestrictionDay();
        restrictions(Set.of(), "-8.1");

        run("09:10:05");
        run("09:30");
        verify(client, never()).placeOrder(anyString());
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        assertThat(events("RESTRICTED")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString()).isEqualTo("circuit-breaker"));

        run("09:41:10");
        // 시장가 DAY로 — 현금이 모자란 A(32주뿐)는 같은 계획의 C 매도 대금을 기다림(QA-1018, 수정 전에는 BUY A DAY 32까지 세 건)
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(cfg().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("QA-344: 정기 작업이 매매 제한으로 시각 맞추기 창을 늘려 둔 동안(묶음 없음)의 예상 목록은 그 창 끝까지 오늘이고 immediate — 기본 길이(09:13)에서 끊지 않음")
    void previewFollowsExtendedTimedWindow() {
        timedRestrictionDay();
        restrictions(Set.of(), "-8.1");
        run("09:10:05");   // 서킷브레이커 — 묶음을 만들지 않고 창을 늘림
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        RealTradeService service = new RealTradeService(store, client, paper, mock(com.macrodash.feature.auth.AuthService.class), job, executor,
                clock, true);

        clock.set(kst("2026-11-06T09:30"));
        assertThat(service.preview("KR", BOOK)).containsEntry("ok", true).containsEntry("session", SESSION.toString())
                .containsEntry("immediate", true);
    }

    @Test
    @DisplayName("매매 제한 — 3단계(−20%)는 그날 보내지 않고 창이 끝나면 놓침으로 알림, 다음 맞추기가 메움")
    void timedSyncGivesUpOnThirdStage() {
        timedRestrictionDay();
        restrictions(Set.of(), "-20.5");
        run("09:10:05");
        run("09:54");
        run("09:56");
        verify(client, never()).placeOrder(anyString());
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("window").asString()).isEqualTo("SYNC_AT");
            assertThat(e.detail().path("missed").asInt()).isEqualTo(1);
        });
    }

    @Test
    @DisplayName("매매 제한 — 접수 불가 거절은 이상 멈춤이 아니고, 남은 주문을 멈췄다가 10분 뒤 다시 보냄")
    void timedSyncHoldsOnOrderHoursClosed() {
        timedRestrictionDay();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.REJECTED, null, "order-hours-closed", 422));

        run("09:10:05");
        assertThat(sentSummaries()).hasSize(1);
        run("09:15");
        assertThat(sentSummaries()).as("10분 안에는 다시 묻지 않음").hasSize(1);

        when(client.placeOrder(anyString())).thenAnswer(inv -> new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        run("09:20:10");
        // 거절된 C 매도(시도 2)와 멈춰 둔 B 매수가 다시 나감. 현금이 모자란 A(32주뿐)는 같은 계획의 C 매도 대금을 기다림(QA-1018, 수정 전에는 BUY A DAY 32까지 네 건)
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 100", "SELL " + C + " DAY 100", "BUY " + B + " DAY 150");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
    }

    @Test
    @DisplayName("매매 제한 — 종목 제한 거절이 3건이어도 이상 멈춤이 아니고 그 종목들만 3분 뒤 다시 보냄")
    void timedSyncHoldsRestrictedSymbols() {
        timedRestrictionDay();
        // 세 주문이 모두 종목 제한으로 거절되는 장면이라, A의 목표를 남은 현금 안에 드는 15%(30주)로 둠 — 50%(100주)면 현금이 모자라 같은 계획의 C 매도
        // 대금을 기다리느라(QA-1018) 첫 주기에 두 건만 나가 '거절 3건'이 되지 않음
        timedTargets(Map.of(A, 15.0, B, 30.0), List.of(21L, 22L), List.of());
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.REJECTED, null, "stock-restricted", 422));

        run("09:10:05");
        assertThat(sentSummaries()).hasSize(3);
        run("09:11");
        assertThat(sentSummaries()).hasSize(3);
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();

        when(client.placeOrder(anyString())).thenAnswer(inv -> new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        run("09:13:20");
        assertThat(sentSummaries()).hasSize(6);
    }

    @Test
    @DisplayName("매매 제한 — 조회가 실패해도 평소대로 보냄")
    void restrictionsNeverBlockOnReadFailure() {
        timedRestrictionDay();
        when(client.restrictions(any())).thenReturn(Reply.failed("collector-unreachable"));
        run("09:10:05");
        // 평소 묶음 그대로(timedSyncBatch의 첫 주기와 같은 목록 — 현금이 모자란 A는 C 매도 대금을 기다림, QA-1018)
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150");
    }

    // ------------------------------------------------------------------ 묶음을 만든 뒤의 '책에 없는 보유'(QA-376)
    private static final String D = "051910";

    @Test
    @DisplayName("QA-376: 시각 맞추기 — 책에 없는 보유(전량 매도 대상)가 묶음을 만들 때 VI였으면, 풀린 뒤 늘어난 창 안에서 시장가로 판다")
    void timedSyncWaitsForViOnHoldingNotInBook() {
        timedRestrictionDay();   // 책 A 50%·B 30%, 실제 보유는 책에 없는 C 100주
        restrictions(Set.of(C), null);

        run("09:10:05");
        assertThat(sentSummaries()).as("VI인 C는 기다리고 나머지는 보냄").containsExactly("BUY " + B + " DAY 150", "BUY " + A + " DAY 32");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(batch.targets().has(C)).as("묶음에 전량 매도 대상으로 남음(비중 0)").isTrue();
        assertThat(batch.targets().path(C).asDouble()).isZero();
        assertThat(events("RESTRICTED")).singleElement().satisfies(e -> assertThat(e.detail().path("reason").asString()).isEqualTo("vi-active"));

        run("09:12:30");
        assertThat(sentSummaries()).as("VI가 이어지는 동안은 팔지 않음").noneMatch(o -> o.contains(C));

        restrictions(Set.of(), null);
        run("09:13:30");   // 원래 창(09:13) 뒤 — 늘어난 창 안
        assertThat(sentSummaries()).as("VI가 풀리면 시장가(ADR 0033 — 수정 전에는 그날 다시 보지 않음)").contains("SELL " + C + " DAY 100");
        assertThat(store.recentOrders("KR", 10)).filteredOn(r -> r.symbol().equals(C)).singleElement().satisfies(r -> {
            assertThat(r.purpose()).isEqualTo("SYNC_FOLLOWUP");
            assertThat(r.batchId()).isEqualTo(batch.id());
            assertThat(r.attempt()).isEqualTo(1);
        });
        assertThat(cfg().state()).isEqualTo("LIVE");

        run("09:14:10");
        assertThat(sentSummaries()).as("한 번만").filteredOn(o -> o.contains(C)).hasSize(1);
    }

    @Test
    @DisplayName("QA-376: 책에 없는 보유는 평가액의 1%보다 작아도 전량 매도 — 묶음 뒤 재시도에서도 1% 문턱을 걸지 않는다")
    void timedSyncLaterLiquidationHasNoThreshold() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(21L, 22L), List.of());
        preflight("9960000", Map.of(C, new String[]{"1", "40000"}), Map.of(A, "50000", B, "20000"));   // C 1주 = 4만 원 < E의 1%(10만 원)
        restrictions(Set.of(C), null);

        run("09:10:05");
        assertThat(sentSummaries()).noneMatch(o -> o.contains(C));

        restrictions(Set.of(), null);
        run("09:13:30");
        assertThat(sentSummaries()).contains("SELL " + C + " DAY 1");
    }

    @Test
    @DisplayName("QA-376: 시각 맞추기 — 접수 불가 거절로 묶음 전송이 멈춘 뒤, 아직 보내지 못한 뒤 순서의 '책에 없는 보유'도 대기가 끝나면 판다")
    void timedSyncRefusedKeepsLaterLiquidations() {
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(21L, 22L), List.of());
        preflight("6000000", Map.of(C, new String[]{"50", "40000"}, D, new String[]{"20", "100000"}), Map.of(A, "50000", B, "20000"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.REJECTED, null, "order-hours-closed", 422));

        run("09:10:05");
        assertThat(sentSummaries()).as("첫 주문(C 매도)이 접수 불가 — 남은 주문은 보내지 않음").containsExactly("SELL " + C + " DAY 50");

        when(client.placeOrder(anyString())).thenAnswer(inv -> new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        run("09:20:10");   // 10분 대기 뒤 — 늘어난 창 안
        assertThat(sentSummaries()).as("거절된 C는 시도 2, 행이 없던 D도 시도 1(수정 전에는 D가 범위 밖)")
                .contains("SELL " + C + " DAY 50", "SELL " + D + " DAY 20");
        assertThat(sentSummaries()).as("매도가 매수보다 먼저").filteredOn(o -> o.startsWith("SELL")).hasSize(3);
        assertThat(cfg().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("QA-376: VI로 기다리는 전량 매도 대상의 몫도 묶음의 회전율에 센다 — 60%를 넘으면 예전처럼 이상 멈춤(풀린 뒤 팔리는 몫이 회전율 멈춤을 비켜 가지 않음)")
    void waitingLiquidationCountsTowardTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));   // 켠 뒤 첫 묶음이 아님 — 회전율 예외 없음
        timedTargets(Map.of(A, 10.0, B, 20.0), List.of(), List.of());
        // 책의 종목은 이미 목표대로(A 10%·B 20%), 책에 없는 C가 평가액의 70%
        preflight("0", Map.of(A, new String[]{"20", "50000"}, B, new String[]{"100", "20000"}, C, new String[]{"175", "40000"}), Map.of());
        restrictions(Set.of(C), null);

        run("09:10:05");

        verify(client, never()).placeOrder(anyString());
        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    @Test
    @DisplayName("QA-376: VI로 기다리는 전량 매도 대상을 세어도 회전율이 한도 안이면 묶음을 만들고, 풀린 뒤 판다(회전율 예외가 없는 평소 날)")
    void waitingLiquidationWithinTurnoverProceeds() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(A, 10.0, B, 60.0), List.of(), List.of());
        preflight("0", Map.of(A, new String[]{"20", "50000"}, B, new String[]{"300", "20000"}, C, new String[]{"75", "40000"}), Map.of());
        restrictions(Set.of(C), null);

        run("09:10:05");
        verify(client, never()).placeOrder(anyString());
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();

        restrictions(Set.of(), null);
        run("09:13:30");
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 75");
    }

    @Test
    @DisplayName("QA-376: 묶음 목표의 전량 매도 표시 — 책의 목표에 없는 정수 보유만 비중 0으로 남기고(소수 보유·형식 밖 코드·책의 종목은 아님), 비중 맵은 0을 읽지 않는다")
    void batchTargetsMarkWholeHoldingsNotInBook() {
        RealTradePlanner.Account account = RealTradePlanner.account(new Preflight(clock.now, d("0"), List.of(
                new Holding(A, "합성", d("7"), d("1000")), new Holding(C, "합성", d("3"), d("1000")), new Holding(D, "합성", d("0.5"), d("1000")),
                new Holding("Q500001", "합성", d("2"), d("1000"))), Map.of(), Map.of()), List.of());

        Map<String, Double> stored = RealTradeJob.batchTargets(Map.of(A, 50.0, B, 30.0), account);

        assertThat(stored).containsOnly(Map.entry(A, 50.0), Map.entry(B, 30.0), Map.entry(C, 0.0));
        Batch batch = store.upsertBatch("KR", SESSION, RealTradeStore.BATCH_SYNC, BOOK, RealTradeFixtures.MAPPER.valueToTree(stored), List.of(),
                d("10000000"));
        assertThat(RealTradeJob.weights(batch)).as("비중 맵에는 0을 넣지 않음(1% 문턱을 피함)").containsOnlyKeys(A, B);
        assertThat(RealTradeJob.liquidations(batch)).as("범위에만").containsExactly(C);
        Batch older = store.upsertBatch("KR", SESSION.minusDays(1), RealTradeStore.BATCH_SYNC, BOOK,
                RealTradeFixtures.MAPPER.valueToTree(Map.of(A, 50.0)), List.of(), d("10000000"));
        assertThat(RealTradeJob.liquidations(older)).as("표시 전에 만든 묶음").isEmpty();
    }

    @Test
    @DisplayName("QA-376 고정: 묶음을 만든 뒤에 생긴 책 밖 보유(앱에서 산 종목)는 그날 마무리가 팔지 않는다 — 다음 맞추기 몫 그대로")
    void followupLeavesHoldingsThatAppearedAfterTheBatch() {
        timedRestrictionDay();
        restrictions(Set.of(A), null);   // A가 VI라 마무리가 창 안에서 이어짐
        run("09:10:05");
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150");

        // 묶음 뒤 — C는 팔렸고, 그사이 앱에서 D를 삼(묶음을 만들 때는 없던 보유)
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", B, "BUY", "DAY", "FILLED", "150", "150", clock.now, clock.now)));
        preflight("5000000", Map.of(B, new String[]{"150", "20000"}, D, new String[]{"20", "100000"}), Map.of(A, "50000"));
        restrictions(Set.of(), null);
        run("09:13:30");

        assertThat(sentSummaries()).as("VI가 풀린 A는 사고, 묶음 뒤에 생긴 D는 건드리지 않음").anyMatch(o -> o.startsWith("BUY " + A + " DAY"))
                .noneMatch(o -> o.contains(D));
    }

    // ------------------------------------------------------------------ QA-376 고정 시험(전량 매도 범위와 다른 경로가 겹치는 날)
    @Test
    @DisplayName("QA-376 고정: 묶음을 만들 때 전량 매도 대상이던 책 밖 보유를 그 뒤 장중 따라 하기가 산 날 — 마무리는 그 종목을 팔지 않는다"
            + "(범위에 전량 매도 대상을 더한 뒤에 장중 따라 하기가 손댄 종목을 뺌 — 순서가 뒤집히면 장중에 산 종목을 되팖)")
    void followupLeavesLiquidationTargetBoughtByIntradayMirror() {
        timedRestrictionDay();   // 책 A 50%·B 30%, 실제 보유는 책에 없는 C 100주
        restrictions(Set.of(C), null);
        run("09:10:05");
        assertThat(sentSummaries()).containsExactly("BUY " + B + " DAY 150", "BUY " + A + " DAY 32");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(RealTradeJob.liquidations(batch)).as("VI로 기다린 C는 묶음의 전량 매도 대상(비중 0)").containsExactly(C);

        // 09:11 — VI가 풀리고, 모의 책이 C를 새로 삼(그 주문 뒤 비중 45% = 112주, 실제 보유 100주라 12주 매수)
        restrictions(Set.of(), null);
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(901, 900, C, "BUY", kst("2026-11-06T09:11"))));
        when(paper.weightAfter(eq(BOOK), eq(901L), any())).thenReturn(Optional.of(new WeightAfter(901, C, "BUY", 45.0, 1e7, true,
                List.of(901L), List.of())));
        run("09:11:10");
        assertThat(sentSummaries()).as("같은 주기 — 마무리가 먼저 돌지만 따라 할 시각이 지난 장중 주문의 종목이라 C를 팔지 않고, 장중 따라 하기가 삼")
                .containsExactly("BUY " + B + " DAY 150", "BUY " + A + " DAY 32", "BUY " + C + " DAY 12");
        assertThat(store.recentOrders("KR", 1).getFirst().purpose()).isEqualTo("MIRROR");

        // 장중 매수가 체결로 끝남(C 112주) — 그 종목의 이 기능 주문이 없어도 마무리는 되팔지 않음(오늘 MIRROR 행이 있는 종목)
        when(client.order("T-3")).thenReturn(Reply.of(broker("T-3", C, "BUY", "DAY", "FILLED", "12", "12", clock.now, clock.now)));
        preflight("5520000", Map.of(C, new String[]{"112", "40000"}), Map.of(A, "50000", B, "20000"));
        run("09:11:50");
        run("09:12:30");
        run("09:13:30");   // 원래 창(09:13) 뒤 — VI로 늘어난 창 안

        assertThat(store.recentOrders("KR", 10)).filteredOn(r -> r.symbol().equals(C)).singleElement()
                .satisfies(r -> assertThat(r.terminal()).as("장중 매수는 끝난 주문 — 이 기능 주문 진행 중이라 막힌 것이 아님").isTrue());
        assertThat(sentSummaries()).as("장중 따라 하기가 산 C를 '책에 없는 보유'로 되팔지 않음").noneMatch(o -> o.startsWith("SELL"))
                .hasSize(3);
    }

    @Test
    @DisplayName("QA-376 고정: 대기 STOP 종목이면서 묶음의 전량 매도 대상인 종목 — 묶음을 만들 때 VI라 스탑 매도 경로가 먼저 판 날, VI가 풀려도 마무리가 그 종목을 더 팔지 않는다"
            + "(1건 상한으로 스탑이 일부만 판 날에도 매도는 스탑 경로의 두 번까지, 보유 수량 안)")
    void stopSoldLiquidationTargetIsNotSoldAgainByFollowup() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(1_000_000L, 200, 999_999_999L,
                999_999_999L)));   // 1건 상한 100만 원 — A 매도는 한 번에 19주까지(현재가 50,000 × 가격 여유 1.03)
        RealTradeFixtures.live(store, true, d("6000000"));
        timedTargets(Map.of(B, 10.0), List.of(), List.of(641L));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of(B, "20000"));
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(641, A, "AT_MINUTE", SYNC_AT)));
        restrictions(Set.of(A), null);   // 묶음을 만들 때 A가 VI — 묶음은 A를 기다리고, 스탑 매도 경로는 기다리지 않음

        run("09:10:05");
        assertThat(sentSummaries()).containsExactly("BUY " + B + " DAY 30", "SELL " + A + " DAY 19");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(RealTradeJob.liquidations(batch)).as("A는 묶음의 전량 매도 대상이기도 함").containsExactly(A);
        assertThat(store.recentOrders("KR", 1).getFirst().purpose()).as("판 것은 스탑 매도 경로").isEqualTo("MIRROR");

        // VI가 풀림 — 스탑 매도는 아직 진행 중이고 사전 조회에는 A 100주가 그대로 보임
        restrictions(Set.of(), null);
        run("09:10:40");
        assertThat(sentSummaries()).as("진행 중인 스탑 매도와 겹쳐 더 팔지 않음").filteredOn(o -> o.startsWith("SELL")).hasSize(1);

        // 스탑 매도 19주가 체결로 끝남(A 81주 남음) — 마무리는 A를 건드리지 않고, 스탑 경로만 시도 2를 냄
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "SELL", "DAY", "FILLED", "19", "19", clock.now, clock.now)));
        preflight("1950000", Map.of(A, new String[]{"81", "50000"}), Map.of(B, "20000"));
        run("09:11:20");
        assertThat(sentSummaries()).filteredOn(o -> o.startsWith("SELL")).containsExactly("SELL " + A + " DAY 19", "SELL " + A + " DAY 19");

        when(client.order("T-3")).thenReturn(Reply.of(broker("T-3", A, "SELL", "DAY", "FILLED", "19", "19", clock.now, clock.now)));
        preflight("2900000", Map.of(A, new String[]{"62", "50000"}), Map.of(B, "20000"));
        run("09:12:00");
        run("09:12:40");
        run("09:13:30");   // 원래 창(09:13) 뒤 — VI로 늘어난 창 안

        assertThat(sentSummaries()).as("A 매도는 스탑 경로의 두 번뿐(38주 ≤ 보유 100주) — 남은 62주는 다음 맞추기 몫")
                .filteredOn(o -> o.startsWith("SELL")).containsExactly("SELL " + A + " DAY 19", "SELL " + A + " DAY 19");
        assertThat(store.recentOrders("KR", 10)).filteredOn(r -> r.symbol().equals(A)).as("마무리(SYNC_FOLLOWUP)의 A 매도 행은 없음")
                .extracting(OrderRow::purpose).containsExactly("MIRROR", "MIRROR");
        assertThat(store.ordersForRoot("KR", 641L)).extracting(OrderRow::attempt).containsExactly(1, 2);
        assertThat(events("STOP_SELL")).hasSize(2).allSatisfy(e -> {
            assertThat(e.detail().path("sent").asInt()).isEqualTo(1);
            assertThat(e.detail().path("missed").asInt()).isZero();
            assertThat(e.detail().path("blocked").asInt()).isZero();
        });
    }

    @Test
    @DisplayName("QA-376 고정: 묶음의 전량 매도 대상을 마무리가 먼저 판 뒤 그 종목에 장중 STOP이 생긴 날 — 스탑 매도 경로가 진행 중인 매도 위에 또 팔지 않고, 끝난 뒤에는 팔 보유가 없어 놓침·막힘 알림도 없다")
    void followupSoldLiquidationTargetIsNotSoldAgainByStop() {
        RealTradeFixtures.live(store, true, d("6000000"));
        timedTargets(Map.of(B, 10.0), List.of(), List.of());
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of(B, "20000"));
        restrictions(Set.of(A), null);   // 책에 없는 A가 묶음을 만들 때 VI
        run("09:10:05");
        assertThat(sentSummaries()).containsExactly("BUY " + B + " DAY 30");

        restrictions(Set.of(), null);
        run("09:10:40");   // VI가 풀림 — 마무리가 전량 매도 대상 A를 팖
        assertThat(sentSummaries()).containsExactly("BUY " + B + " DAY 30", "SELL " + A + " DAY 100");
        assertThat(store.recentOrders("KR", 1).getFirst().purpose()).isEqualTo("SYNC_FOLLOWUP");

        // 09:11:30 — 장중 감시가 A에 STOP을 냄. 마무리의 매도는 아직 진행 중이고 사전 조회에는 A 100주가 그대로 보임
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(651, A, "MARKET", kst("2026-11-06T09:11:30"))));
        run("09:11:40");
        assertThat(sentSummaries()).as("이 기능의 A 매도가 진행 중 — 스탑 매도를 겹쳐 보내지 않음").filteredOn(o -> o.startsWith("SELL")).hasSize(1);

        // 마무리의 매도가 전량 체결로 끝남 — 팔 보유가 없음
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("6000000", Map.of(), Map.of(A, "50000", B, "20000"));
        run("09:12:20");
        run("09:13:00");
        run("09:14:40");   // 스탑 창(09:11:30~09:14:30) 뒤

        assertThat(sentSummaries()).as("A 매도는 하루에 한 번, 보유 100주까지만").filteredOn(o -> o.startsWith("SELL"))
                .containsExactly("SELL " + A + " DAY 100");
        assertThat(store.recentOrders("KR", 10)).filteredOn(r -> r.symbol().equals(A)).extracting(OrderRow::purpose)
                .containsExactly("SYNC_FOLLOWUP");
        assertThat(events("STOP_SELL")).as("이미 팔린 스탑 — 놓침·막힘으로 알리지 않음").isEmpty();
    }

    @Test
    @DisplayName("QA-376 고정: 묶음을 만든 뒤 백엔드를 다시 띄워도 DB의 묶음(비중 0 표시)만으로 전량 매도 범위가 되살아난다 — 주문 행이 없던 VI 대기 종목을 풀린 뒤 창 안에서 판다")
    void restartKeepsLiquidationScopeFromStoredBatch() {
        timedRestrictionDay();   // 책 A 50%·B 30%, 실제 보유는 책에 없는 C 100주
        restrictions(Set.of(C), null);
        run("09:10:05");
        assertThat(sentSummaries()).containsExactly("BUY " + B + " DAY 150", "BUY " + A + " DAY 32");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(store.ordersForBatch(batch.id())).as("C는 주문 행이 없음").noneMatch(r -> r.symbol().equals(C));

        job = restartedJob();   // 같은 DB, 새 정기 작업·새 실행기(메모리 상태 없음)
        restrictions(Set.of(), null);
        run("09:11:00");

        assertThat(sentSummaries()).as("다시 띄운 작업도 묶음의 전량 매도 대상을 범위에 넣음").contains("SELL " + C + " DAY 100");
        assertThat(store.recentOrders("KR", 10)).filteredOn(r -> r.symbol().equals(C)).singleElement().satisfies(r -> {
            assertThat(r.purpose()).isEqualTo("SYNC_FOLLOWUP");
            assertThat(r.batchId()).isEqualTo(batch.id());
            assertThat(r.attempt()).isEqualTo(1);
        });
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow().id()).as("묶음은 하루 하나 그대로").isEqualTo(batch.id());

        run("09:11:40");
        assertThat(sentSummaries()).as("한 번만").filteredOn(o -> o.contains(C)).hasSize(1);
    }

    @Test
    @DisplayName("QA-376 고정: 하루 건수 한도로 묶음에서 미뤄진 전량 매도 대상 — 남은 건수가 없는 동안에는 보내지 않고(한도를 넘기지 않음), 남은 건수가 생기면 그날 창 안에서 매도 먼저 그만큼만 보낸다")
    void liquidationDeferredByDailyCapStaysWithinTheCap() {
        CollectorTradeClient.BrokerOrder x1 = broker("X-1", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now);
        CollectorTradeClient.BrokerOrder x2 = broker("X-2", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now);
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 3, 999_999_999L,
                999_999_999L)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(x1, x2)));   // 오늘 앱 주문 2건 — 남은 건수 1
        RealTradeFixtures.live(store, true, d("10000000"));
        timedTargets(Map.of(A, 50.0), List.of(), List.of());
        preflight("4000000", Map.of(C, new String[]{"100", "40000"}, D, new String[]{"20", "100000"}), Map.of(A, "50000"));

        run("09:10:05");
        assertThat(sentSummaries()).as("남은 건수 1 — 매도 먼저(종목 코드 순), 나머지는 미룸").containsExactly("SELL " + C + " DAY 100");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(RealTradeJob.liquidations(batch)).as("미뤄진 D도 묶음의 전량 매도 대상").containsExactly(C, D);

        // C 매도가 체결로 끝남 — 오늘 주문 3건으로 하루 건수 한도(3)를 다 씀
        CollectorTradeClient.BrokerOrder own = broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now);
        when(client.order("T-1")).thenReturn(Reply.of(own));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(x1, x2, own)));
        preflight("8000000", Map.of(D, new String[]{"20", "100000"}), Map.of(A, "50000"));
        run("09:10:40");
        run("09:11:20");
        assertThat(sentSummaries()).as("범위에는 들지만 남은 건수 0 — 한도를 넘겨 보내지 않음").containsExactly("SELL " + C + " DAY 100");

        // 남은 건수가 1 생김(수집기 하루 건수 한도가 4로 오른 경우를 흉내) — 그날 창 안에서 다시 보고 매도부터 그만큼만
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 4, 999_999_999L,
                999_999_999L)));
        run("09:12:00");
        assertThat(sentSummaries()).as("주문 행이 없던 D를 같은 날 창 안에서 팖 — 매수 A는 여전히 미룸")
                .containsExactly("SELL " + C + " DAY 100", "SELL " + D + " DAY 20");
        assertThat(store.recentOrders("KR", 1).getFirst()).satisfies(r -> {
            assertThat(r.purpose()).isEqualTo("SYNC_FOLLOWUP");
            assertThat(r.batchId()).isEqualTo(batch.id());
        });

        CollectorTradeClient.BrokerOrder second = broker("T-2", D, "SELL", "DAY", "FILLED", "20", "20", clock.now, clock.now);
        when(client.order("T-2")).thenReturn(Reply.of(second));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(x1, x2, own, second)));
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        run("09:12:40");
        run("09:13:30");   // 창(09:10~09:13) 뒤
        assertThat(sentSummaries()).as("한도(4건)를 다 쓴 뒤로는 더 보내지 않음").hasSize(2);
        assertThat(cfg().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("QA-376 고정: 회전율 보완은 대기 STOP 종목을 세지 않는다 — VI로 기다리는 전량 매도 대상(E의 70%)이 스탑 종목이면 이상 멈춤 없이 묶음을 만들고, 스탑 매도 경로가 판다")
    void waitingLiquidationThatIsPendingStopStaysOutOfTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));   // 켠 뒤 첫 묶음이 아님 — 회전율 예외 없음
        timedTargets(Map.of(A, 10.0, B, 20.0), List.of(), List.of(661L));
        // waitingLiquidationCountsTowardTurnover와 같은 계좌(책의 종목은 목표대로, 책에 없는 C가 70%) — C가 대기 STOP 종목인 것만 다름
        preflight("0", Map.of(A, new String[]{"20", "50000"}, B, new String[]{"100", "20000"}, C, new String[]{"175", "40000"}), Map.of());
        restrictions(Set.of(C), null);
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(C));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(661, C, "AT_MINUTE", SYNC_AT)));

        run("09:10:05");

        assertThat(cfg().state()).as("스탑 몫은 회전율 멈춤을 걸지 않음(QA-302) — 멈추면 같은 주기의 스탑 매도까지 섬").isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(sentSummaries()).containsExactly("SELL " + C + " DAY 175");
        assertThat(store.recentOrders("KR", 1).getFirst().purpose()).isEqualTo("MIRROR");
    }

    @Test
    @DisplayName("QA-376 고정: 회전율 보완은 이 기능의 주문이 진행 중인 종목을 세지 않는다 — 스탑 매도 경로가 묶음보다 먼저 보낸 매도가 진행 중인 책 밖 보유(E의 70%)가 VI여도 이상 멈춤 없이 묶음을 만든다")
    void waitingLiquidationWithOwnOrderInFlightStaysOutOfTurnover() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(A, 10.0, B, 20.0), List.of(), List.of());
        preflight("0", Map.of(A, new String[]{"20", "50000"}, B, new String[]{"100", "20000"}, C, new String[]{"175", "40000"}), Map.of());
        restrictions(Set.of(C), null);
        clock.set(kst("2026-11-06T09:10:00"));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 951L, 950L, C, "SELL", 175, "DAY", d("40000"),
                1), cfg);   // 이 기능의 C 매도(T-1)가 진행 중 — 대기 STOP 목록에는 이제 없음

        run("09:10:05");

        assertThat(cfg().state()).as("이미 나간 매도를 풀린 뒤 또 팔 몫으로 세지 않음").isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        verify(client, times(1)).placeOrder(anyString());   // 먼저 보낸 C 매도뿐 — 묶음은 보낼 것이 없음
    }

    // QA-949 전(2026-11-09 결정)에는 VI로 빠진 책의 종목 A의 몫을 세지 않아 B 30%만으로 묶음을 만들고 'BUY 000660 DAY 150'을 보냈다.
    @Test
    @DisplayName("QA-949: 회전율 보완은 책의 종목도 센다 — VI로 빠진 책의 종목(보유 2주, 목표까지 매수 49%)의 몫까지 79%라 이상 멈춤, 묶음·주문 없음")
    void restrictedBookSymbolCountsTowardTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));   // 회전율 예외 없음
        timedTargets(Map.of(A, 50.0, B, 30.0), List.of(), List.of());
        preflight("9900000", Map.of(A, new String[]{"2", "50000"}), Map.of(B, "20000"));   // 책의 종목 A를 이미 2주 들고 있음(E = 1,000만)
        restrictions(Set.of(A), null);

        run("09:10:05");

        verify(client, never()).placeOrder(anyString());
        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(cfg().haltDetail().path("turnoverPct").decimalValue()).isEqualByComparingTo("79.00");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    @Test
    @DisplayName("QA-376 고정: 매매 제한 종목이 없으면 회전율 판정은 계획의 값 그대로이고, 같은 전량 매도 대상이 VI로 기다릴 때도 같은 값으로 멈춘다(VI가 아니었을 때와 같은 판정)")
    void waitingLiquidationIsJudgedLikeAnUnrestrictedOne() {
        Map<String, String[]> holdings = Map.of(A, new String[]{"20", "50000"}, B, new String[]{"100", "20000"},
                C, new String[]{"175", "40000"});   // 책의 종목은 목표대로, 책에 없는 C가 E의 70%

        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(A, 10.0, B, 20.0), List.of(), List.of());
        preflight("0", holdings, Map.of());
        run("09:10:05");   // 매매 제한 없음 — C 매도 70%가 계획의 회전율
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        BigDecimal unrestricted = cfg().haltDetail().path("turnoverPct").decimalValue();
        assertThat(unrestricted).isEqualByComparingTo("70.00");
        verify(client, never()).placeOrder(anyString());

        RealTradeFixtures.clean(jdbc);
        RealTradeFixtures.live(store, false, d("10000000"));
        job = restartedJob();
        restrictions(Set.of(C), null);
        run("09:10:05");   // 같은 계좌, C가 VI — 계획에서는 빠지지만 기다리는 몫으로 셈
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(cfg().haltDetail().path("turnoverPct").decimalValue()).as("VI가 아니었을 때와 같은 값").isEqualByComparingTo(unrestricted);
        verify(client, never()).placeOrder(anyString());
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    // ------------------------------------------------------------------ 책의 종목이 매매 제한으로 빠진 몫도 회전율 판정에(QA-949)
    // 합성 계좌 E = 1,000만 원: 현금 500만 + D 50주(10만 원) — 책의 목표 A 30%(5만 원 → 60주 매수)·B 20%(2만 원 → 100주 매수)·D 10%(10주 → 40주 매도).
    // VI가 아니면 회전율 30 + 20 + 40 = 90%.
    // QA-949 — 수정 전(재현 커밋에서는 @Disabled): A·D가 VI라 계획에서 빠지면 판정 회전율이 B의 20%뿐이라 이상 멈춤 없이 묶음을 만들고
    // 'BUY 000660 DAY 100'을 보냄(그 뒤 VI가 풀리면 같은 창 마무리가 A 매수·D 매도 70%를 회전율 검사 없이 보냄).
    @Test
    @DisplayName("QA-949: 시각 맞추기 날 책의 종목 둘(A 매수 30%·D 매도 40%)이 VI — 판정 회전율은 VI가 아니었을 때와 같은 90%라 이상 멈춤, 묶음·주문 없음")
    void restrictedBookSymbolsCountTowardTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));   // 켠 뒤 첫 묶음이 아님 — 회전율 예외 없음
        timedTargets(Map.of(A, 30.0, B, 20.0, D, 10.0), List.of(), List.of());
        preflight("5000000", Map.of(D, new String[]{"50", "100000"}), Map.of(A, "50000", B, "20000"));
        restrictions(Set.of(A, D), null);

        run("09:10:05");

        verify(client, never()).placeOrder(anyString());
        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(cfg().haltDetail().path("turnoverPct").decimalValue()).as("VI가 아니었을 때와 같은 값").isEqualByComparingTo("90.00");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    @Test
    @DisplayName("QA-949 고정: VI로 빠진 책의 종목이 대기 STOP 종목이면 그 몫은 세지 않는다(QA-302) — D 매도 40%를 빼고 A·B 50%라 묶음을 만듦")
    void restrictedBookSymbolThatIsPendingStopStaysOutOfTurnover() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(A, 30.0, B, 20.0, D, 10.0), List.of(), List.of(661L));
        preflight("5000000", Map.of(D, new String[]{"50", "100000"}), Map.of(A, "50000", B, "20000"));
        restrictions(Set.of(D), null);
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(D));

        run("09:10:05");

        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(sentSummaries()).noneMatch(o -> o.contains(D));
    }

    @Test
    @DisplayName("QA-949 고정: VI로 빠진 현금성(책의 종목) 매수를 셀 때도 스탑 대금까지는 빼고 센다(QA-302) — 스탑 A·B 90% + 현금성 매수 90%는 VI가 아니었을 때처럼 멈춤 없음")
    void restrictedCashLikeBuyIsFundedByStopsLikeUnrestricted() {
        RealTradeFixtures.live(store, false, d("10000000"));
        timedTargets(Map.of(CASH_LIKE, 90.0), List.of(), List.of(661L, 662L));
        stoppedAccount();
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of(A, B));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(661, A, "AT_MINUTE", SYNC_AT),
                stopDue(662, B, "AT_MINUTE", SYNC_AT)));
        restrictions(Set.of(CASH_LIKE), null);

        run("09:10:05");

        assertThat(cfg().state()).as("현금성 매수 90%를 막는 종목으로 둔 채 빼면 스탑 대금과 맞추지 못해 90%로 멈춤").isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(sentSummaries()).noneMatch(o -> o.contains(CASH_LIKE));
    }

    // ------------------------------------------------------------------ 창 끝과 늦은 전송(RT3-MON-4 = RT3-BE-2)
    @Test
    @DisplayName("RT3-MON-4: 수집기 창 밖 안 보냄(outside-window)은 3회여도 이상 멈춤이 아님 — 접수된 주문을 취소하지 않음")
    void outsideWindowRejectsDoNotHalt() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        clock.set(kst("2026-11-06T10:00"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-1", null, 200));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 541L, 540L, B, "BUY", 1, "DAY", d("20000"), 1),
                cfg);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.NOT_SENT, null, "outside-window", null));
        for (long root = 550; root < 556; root += 2) {
            executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, root + 1, root, A, "BUY", 1, "DAY",
                    d("50000"), 1), cfg);
        }
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", B, "BUY", "DAY", "PENDING", "1", "0", clock.now, null))));

        run("10:00:10");

        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        verify(client, never()).cancelOrder(anyString());
    }

    @Test
    @DisplayName("RT3-MON-4: 시가 맞추기 묶음 전송 중 앞 주문이 길어져 시가 창 끝(08:58:30)을 넘기면 남은 주문은 보내지 않고 놓침 — 멈춤 없이 마무리가 DAY로 메움")
    void syncStopsSendingWhenWindowCloses() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));
        when(client.placeOrder(anyString())).thenAnswer(inv -> {
            clock.set(kst("2026-11-06T08:58:31"));   // 첫 주문의 수집기 검사·전송이 끝나니 창 끝을 넘김
            return new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200);
        });

        run("08:57:00");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + C + " OPG 100");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();

        when(client.placeOrder(anyString())).thenAnswer(inv -> new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
        // C 시가 매도가 체결로 끝남 — 주문 번호는 행에서 읽음. placeOrder를 다시 스텁할 때마다 번호가 하나씩 건너뛰어 그 주문은 T-1이 아니라서, 예전의
        // order("T-1") 스텁은 적용되지 않았음(그때는 결과에 영향이 없었음). 이제는 묶음에 진행 중인 매도가 있으면 현금이 모자란 매수(A — 93주뿐)가
        // 그 대금을 기다리므로(QA-1018), 이 시험이 뜻한 대로 매도가 끝난 계좌가 되게 함 — 끝났으니 A는 지금처럼 줄여 보냄
        String sold = store.recentOrders("KR", 10).getFirst().tossOrderId();
        when(client.order(sold)).thenReturn(Reply.of(broker(sold, C, "SELL", "OPG", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("10000000", Map.of(), Map.of(A, "50000", B, "20000"));
        run("09:00:40");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + C + " OPG 100", "BUY " + B + " DAY 150", "BUY " + A + " DAY 93");

        run("09:31");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> assertThat(e.detail().path("missed").asInt()).isEqualTo(2));
    }

    @Test
    @DisplayName("RT3-MON-4: 시가 창 끝 − 60초 뒤에 시작한 첫 시도는 OPG를 보내지 않고 묶음만 만듦(회전율 검사·sync_pending 그대로) — 마무리가 DAY로 메움")
    void lateSyncStartBuildsBatchWithoutOpg() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));

        run("08:57:40");

        verify(client, never()).placeOrder(anyString());
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(cfg().syncPending()).as("묶음을 만들며 sync_pending을 끔(켜기 뒤 첫 묶음)").isFalse();

        run("09:00:40");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " DAY 100");
    }

    @Test
    @DisplayName("QA-376: 시가 창 끝이 가까워 묶음만 만든 날 — 시가 뒤 마무리가 '책에 없는 보유'도 시장가 DAY로 판다(수정 전에는 책의 종목만 메움)")
    void lateSyncStartFollowupSellsHoldingNotInBook() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000"));

        run("08:57:40");
        verify(client, never()).placeOrder(anyString());
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(batch.targets().path(A).asDouble()).isEqualTo(50.0);

        run("09:00:40");
        // 책에 없는 C를 팖. 책의 A(목표 100주)는 남은 현금으로 92주뿐이라 같은 계획의 C 매도 대금을 기다림(QA-1018 — 수정 전에는 BUY A DAY 92도 이 주기에 나감)
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + C + " DAY 100");

        // C 매도가 체결로 끝나 대금이 들어온 다음 주기 — 책의 종목 A를 온전한 100주로 메움
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "DAY", "FILLED", "100", "100", clock.now, clock.now)));
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        run("09:01:15");
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + C + " DAY 100", "BUY " + A + " DAY 100");
    }

    @Test
    @DisplayName("RT3-MON-4: 시가 창 끝 − 60초 뒤에는 창 안 재시도도 시작하지 않음(마무리가 메움)")
    void lateSyncRetryNotStarted() {
        syncWithRetryableReject();

        run("08:57:45");

        verify(client, times(2)).placeOrder(anyString());
    }

    @Test
    @DisplayName("RT3-MON-4: 장중 따라 하기 — 앞 주문의 전송이 길어져 다음 주문의 창이 닫히면 보내지 않고 놓침")
    void mirrorSkipsWhenWindowClosesDuringSend() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("10000000", Map.of(), Map.of(A, "50000", B, "20000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(dueFor(1001, 1000, A, "BUY", kst("2026-11-06T10:00")),
                dueFor(1011, 1010, B, "BUY", kst("2026-11-06T10:00"))));
        when(paper.weightAfter(eq(BOOK), eq(1001L), any())).thenReturn(Optional.of(new WeightAfter(1001, A, "BUY", 20.0, 1e7, true,
                List.of(1001L), List.of())));
        when(paper.weightAfter(eq(BOOK), eq(1011L), any())).thenReturn(Optional.of(new WeightAfter(1011, B, "BUY", 10.0, 1e7, true,
                List.of(1011L), List.of())));
        when(client.placeOrder(anyString())).thenAnswer(inv -> {
            clock.set(kst("2026-11-06T10:03:05"));   // 창 [10:00, 10:03]이 첫 전송 도중에 닫힘
            return new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200);
        });

        run("10:02:50");

        assertThat(sentBodies()).hasSize(1);
        run("15:19:40");
        assertThat(events("WINDOW_SUMMARY")).filteredOn(e -> e.detail().path("window").asString().equals("MIRROR")).singleElement()
                .satisfies(e -> assertThat(e.detail().path("missed").asInt()).isEqualTo(1));
    }

    // ------------------------------------------------------------------ 끄는 중의 결과 모름(RT3-BE-1)
    /** 10:00에 장중 따라 하기 A 5주가 결과 모름(토스 장애) — 실제로는 주문이 생겼다고 봄. 돌려주는 값은 그 주문이 토스 목록에 보일 때의 모습. */
    private CollectorTradeClient.BrokerOrder unknownMirrorBuy() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        clock.set(kst("2026-11-06T10:00"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "collector-timeout", null));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 1101L, 1100L, A, "BUY", 5, "DAY", d("50000"),
                1), cfg);
        Instant firstSent = store.recentOrders("KR", 1).getFirst().firstSentAt();
        return broker("T-LATE", A, "BUY", "DAY", "PENDING", "5", "0", firstSent.plusSeconds(1), null);
    }

    @Test
    @DisplayName("RT3-BE-1: 끄는 중 — 결과 모름 행의 대조가 토스 목록을 못 읽으면 OFF로 넘기지 않고, 다음 주기에 목록이 돌아와 후보 하나로 묶이면 같은 주기에 취소")
    void stoppingWaitsForReconcileThenCancelsBound() {
        CollectorTradeClient.BrokerOrder late = unknownMirrorBuy();
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));
        when(client.openOrders()).thenReturn(Reply.failed("collector-timeout"));

        run("10:07:50");   // 재전송 창(7분) + 여유(45초)가 지남 — 대조할 차례인데 목록을 못 읽음

        assertThat(cfg().state()).as("대조를 끝내지 못함 — 끄는 중 그대로").isEqualTo("STOPPING");
        assertThat(events("STOPPED")).isEmpty();

        when(client.openOrders()).thenReturn(Reply.of(List.of(late)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(late)));
        run("10:08:00");

        assertThat(store.recentOrders("KR", 1).getFirst().tossOrderId()).isEqualTo("T-LATE");
        verify(client).cancelOrder("T-LATE");
        assertThat(cfg().state()).isEqualTo("STOPPING");
    }

    @Test
    @DisplayName("RT3-BE-1: 꺼짐(OFF)에서 대조로 늦게 묶인 이 기능의 토스 주문은 취소(꺼진 뒤에도 대조·추적·취소를 이어 감)")
    void offCancelsLateBoundOrder() {
        CollectorTradeClient.BrokerOrder late = unknownMirrorBuy();
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_OFF), 1L));
        when(client.openOrders()).thenReturn(Reply.of(List.of(late)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(late)));

        run("10:07:50");

        assertThat(store.recentOrders("KR", 1).getFirst().tossOrderId()).isEqualTo("T-LATE");
        verify(client).cancelOrder("T-LATE");
        assertThat(cfg().state()).isEqualTo("OFF");
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("RT3-BE-1: 끄는 중 — 목록을 읽은 대조가 후보를 정하지 못한 결과 모름 행만 남으면 OFF, 남은 수는 STOPPED 이벤트에")
    void stoppingFinishesWithUnresolvedCount() {
        unknownMirrorBuy();
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));

        run("10:07:50");   // 목록은 읽었고 후보 0개 — 끄는 중에는 멈추지 않고 사람 확인으로 남김

        assertThat(cfg().state()).isEqualTo("OFF");
        assertThat(events("STOPPED")).singleElement().satisfies(e -> assertThat(e.detail().path("unresolved").asInt()).isEqualTo(1));
    }

    // ------------------------------------------------------------------ 꺼짐·이상 멈춤에서 남은 결과 모름(QA-380)
    /** 어제(11-05) 14:00의 장중 따라 하기 A 5주가 결과 모름으로 남은 채 날이 바뀜 — 오늘 토스 목록에는 나타날 수 없는 주문. */
    private void unknownFromYesterday() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        clock.set(kst("2026-11-05T14:00"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "collector-timeout", null));
        executor.send(new RealTradeExecutor.Send(SESSION.minusDays(1), RealTradeStore.PURPOSE_MIRROR, null, 1201L, 1200L, A, "BUY", 5, "DAY",
                d("50000"), 1), cfg);
    }

    @Test
    @DisplayName("QA-380: 꺼짐·이상 멈춤의 주기는 지난 세션의 결과 모름 행 때문에 토스 주문 목록을 읽지 않는다 — 행은 결과 모름 그대로(화면의 확인 필요)")
    void offAndHaltedCyclesDoNotPollForPastSessionUnknown() {
        unknownFromYesterday();
        for (String state : List.of(RealTradeStore.STATE_HALTED, RealTradeStore.STATE_OFF)) {
            store.lockConfig("KR", current -> store.updateConfig(current.withState(state), 1L));
            org.mockito.Mockito.clearInvocations(client);

            run("08:51");
            run("08:51:10");
            run("10:00");

            verify(client, never()).openOrders();
            verify(client, never()).todayOrders();
            assertThat(cfg().state()).isEqualTo(state);
            assertThat(executor.stuckUnknown()).isEqualTo(1);
        }
        verify(client, never()).placeOrder(anyString());   // 호출 기록을 비운 뒤 — 꺼짐·이상 멈춤의 주기는 주문을 내지 않음
    }

    @Test
    @DisplayName("QA-380 대조: 끄는 중 — 지난 세션의 결과 모름 행도 그 주기의 대조가 토스 목록을 실제로 읽었을 때만 꺼짐으로(못 읽으면 끄는 중 그대로)")
    void stoppingStillNeedsARealReadForPastSessionUnknown() {
        unknownFromYesterday();
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));
        when(client.openOrders()).thenReturn(Reply.failed("collector-timeout"));

        run("08:51");
        run("08:51:10");

        assertThat(cfg().state()).as("목록을 못 읽음 — 끄는 중 그대로").isEqualTo("STOPPING");
        verify(client, times(2)).openOrders();

        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        run("08:51:20");

        assertThat(cfg().state()).isEqualTo("OFF");
        assertThat(events("STOPPED")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("unresolved").asInt()).isEqualTo(1);
            assertThat(PaperTelegram.plain(RealTradeNotices.text(e))).as("꺼짐 알림이 확인 필요 건수를 실음").contains("확인 필요 1건");
        });
    }

    @Test
    @DisplayName("QA-380 후속: 08:50 OPG 주문의 응답을 잃고 첫 대조(후보 0개)로 이상 멈춤이 된 뒤 그 주문이 목록에 뜨면 — 다음 주기에 묶어 09:00 단일가 전에 취소한다")
    void haltedCancelsLateListedOpgBeforeTheOpeningAuction() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        clock.set(kst("2026-11-06T08:50:40"));
        long batch = store.upsertBatch("KR", SESSION, RealTradeStore.BATCH_SYNC, BOOK, null, List.of(), d("10000000")).id();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "collector-timeout", null));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_SYNC, batch, null, null, A, "BUY", 5, "OPG", d("50000"), 1),
                cfg);
        Instant firstSent = store.recentOrders("KR", 1).getFirst().firstSentAt();

        run("08:58:30");   // 첫 전송 + 7분 45초 뒤 첫 대조 — 목록에 아직 없음(후보 0개) → 이상 멈춤
        assertThat(cfg().haltReason()).isEqualTo("unknown-order");
        verify(client, never()).cancelOrder(anyString());

        CollectorTradeClient.BrokerOrder late = broker("T-LATE", A, "BUY", "OPG", "PENDING", "5", "0", firstSent.plusSeconds(1), null);
        when(client.openOrders()).thenReturn(Reply.of(List.of(late)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(late)));
        run("08:58:40");

        assertThat(store.recentOrders("KR", 1).getFirst().tossOrderId()).as("수정 전: 다음 대조가 09:03:30이라 단일가(09:00) 체결 뒤에야 묶임")
                .isEqualTo("T-LATE");
        verify(client).cancelOrder("T-LATE");
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("QA-380 대조: 이상 멈춤에서 대조가 방금 실패한 당일 행이 있어도, 끄면 다음 주기의 대조는 목록을 다시 읽고(간격을 기다리지 않음) 못 읽으면 꺼짐으로 넘기지 않는다")
    void stoppingAfterHaltedFailureReadsAgainBeforeOff() {
        unknownMirrorBuy();

        run("10:07:50");   // 켜짐 — 목록은 읽었고 후보 0개 → 이상 멈춤
        assertThat(cfg().haltReason()).isEqualTo("unknown-order");
        run("10:15:10");   // 첫 전송 15분 뒤의 이상 멈춤 대조(후보 0개) — 여기서부터 5분 간격
        org.mockito.Mockito.clearInvocations(client);
        run("10:15:20");
        verify(client, never()).todayOrders();   // 이상 멈춤 — 간격 안이라 읽지 않음
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));
        when(client.todayOrders()).thenReturn(Reply.failed("collector-timeout"));

        run("10:15:30");

        verify(client).todayOrders();
        assertThat(cfg().state()).as("이 주기의 대조는 목록을 못 읽음").isEqualTo("STOPPING");

        when(client.todayOrders()).thenReturn(Reply.of(List.of()));
        run("10:15:40");
        assertThat(cfg().state()).isEqualTo("OFF");
    }

    @Test
    @DisplayName("QA-380: 조회를 아낀 주기(이상 멈춤으로 읽고 시작) 도중에 끄기가 커밋돼도 그 주기에는 꺼짐으로 넘기지 않는다 — 다음 주기가 목록을 실제로 읽은 뒤에")
    void disableDuringASparedCycleWaitsForARealRead() {
        unknownFromYesterday();
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_HALTED).withHalt("unknown-order", null),
                null));
        RealTradeExecutor racing = org.mockito.Mockito.spy(executor);
        org.mockito.Mockito.doAnswer(inv -> {
            Object resolution = inv.callRealMethod();   // 이상 멈춤으로 읽은 설정으로 대조(지난 세션 행 — 조회 없음)
            store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L));   // 그사이 끄기
            return resolution;
        }).doCallRealMethod().when(racing).resolveUnknown(any(), any());
        job = new RealTradeJob(store, racing, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, false, 10_000);
        org.mockito.Mockito.clearInvocations(client);

        run("08:51");

        verify(client, never()).todayOrders();
        assertThat(cfg().state()).as("목록을 읽지 않은 주기 — 끄는 중 그대로").isEqualTo("STOPPING");

        run("08:51:10");

        verify(client).todayOrders();
        assertThat(cfg().state()).isEqualTo("OFF");
        assertThat(events("STOPPED")).singleElement().satisfies(e -> assertThat(e.detail().path("unresolved").asInt()).isEqualTo(1));
    }

    // ------------------------------------------------------------------ 수집기 스위치가 꺼짐(OPS-3)
    @Test
    @DisplayName("OPS-3: 켜짐인데 수집기가 매매 스위치가 꺼졌다고 분명히 답하면 이상 멈춤(collector-disabled) — 다시 켤 때 멈춤 해제를 거치게, 이 기능의 미체결 취소")
    void collectorSwitchedOffHalts() {
        syncBuy100();
        when(client.status()).thenReturn(Reply.of(new CollectorTradeClient.Status(false, "disabled", null, false, Instant.EPOCH)));
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "OPG", "PENDING", "100", "0", clock.now, null))));

        run("08:52");

        assertThat(cfg().state()).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("collector-disabled");
        assertThat(events("HALT")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("reason").asString()).isEqualTo("collector-disabled");
            assertThat(e.detail().path("code").asString()).isEqualTo("disabled");
            assertThat(e.notifies()).isTrue();
        });
        verify(client).cancelOrder("T-1");
    }

    @Test
    @DisplayName("OPS-3: 수집기 상태를 읽지 못함(연결 실패)·한도 해석 실패는 멈추지 않고 그 주기만 건너뜀")
    void collectorStatusUnreadableSkipsWithoutHalt() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        when(client.status()).thenReturn(Reply.failed("collector-unreachable"),
                Reply.of(new CollectorTradeClient.Status(false, "limits-unreadable", null, false, Instant.EPOCH)));

        run("08:51");
        run("08:51:10");

        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        verify(client, never()).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 알림 없이 지나가는 날(QA-342)
    private RealTradeJob restartedJob() {
        return new RealTradeJob(store, new RealTradeExecutor(store, client, paper, RealTradeFixtures.MAPPER, clock), client, paper, telegram,
                RealTradeFixtures.MAPPER, clock, true, false, 10_000);
    }

    @Test
    @DisplayName("QA-342: 밤새 이어진 끊김 — 모의 달력의 개장 3분 전이 지나도록 토스 장 운영 정보를 받지 못하면 그 첫 주기에 알림 이벤트(calendar-unavailable), "
            + "같은 끊김은 한 번 — 주문 없음, 재시도는 계속. 다시 띄운 뒤에도 이어지면 앞 알림부터 30분 뒤 한 번 더(보완)")
    void calendarUnavailableNotifiesOnce() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        when(client.calendar()).thenReturn(Reply.failed("calendar-unavailable"));

        run("08:47");
        assertThat(events("UNAVAILABLE")).as("개장 3분 전(08:57) 전에는 아직 알리지 않음").isEmpty();
        run("08:58");
        run("09:14");

        assertThat(events("UNAVAILABLE")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("reason").asString()).isEqualTo("calendar-unavailable");
            assertThat(e.detail().path("date").asString()).isEqualTo(SESSION.toString());
            assertThat(e.notifies()).isTrue();
            assertThat(PaperTelegram.plain(RealTradeNotices.text(e))).contains("준비 안 됨").contains("calendar-unavailable").doesNotContain(A);
        });
        verify(client, never()).placeOrder(anyString());
        verify(client, org.mockito.Mockito.atLeast(3)).calendar();   // 알린 뒤에도 60초마다 다시 받아 봄
        assertThat(cfg().state()).as("멈춤이 아님").isEqualTo("LIVE");

        job = restartedJob();
        run("09:20");
        assertThat(events("UNAVAILABLE")).as("다시 띄운 작업은 그날 이벤트에서 되살려 또 알리지 않음").hasSize(1);
        // QA-342 보완 — 다시 띄운 작업은 끊김을 그때부터 다시 재고(3분), 최소 간격은 그날 이벤트의 알린 시각(08:58)에서 이어 셈
        run("09:24");
        assertThat(events("UNAVAILABLE")).as("다시 띄운 뒤 3분은 넘었지만 앞 알림부터 30분 안").hasSize(1);
        run("09:27:50");
        assertThat(events("UNAVAILABLE")).hasSize(1);
        run("09:28:10");
        assertThat(events("UNAVAILABLE")).as("앞 알림 + 30분 — 다시 띄운 뒤에도 이어지는 끊김을 한 번 더 알림").hasSize(2);
        run("10:30");
        assertThat(events("UNAVAILABLE")).as("알린 끊김은 이어져도 다시 알리지 않음").hasSize(2);
    }

    @Test
    @DisplayName("QA-342: 켜짐인데 모의 달력의 개장 3분 전이 지나도록 수집기 매매 상태를 읽지 못하면 알림 이벤트(status-unavailable — 같은 끊김은 한 번) — 멈춤 아님. "
            + "사유마다 따로 재고 따로 알림")
    void statusUnavailableNotifiesOnce() {
        RealTradeFixtures.live(store, true, d("10000000"));
        when(client.status()).thenReturn(Reply.failed("collector-unreachable"));

        run("08:51");
        assertThat(events("UNAVAILABLE")).isEmpty();
        run("08:58");
        run("09:30");

        assertThat(events("UNAVAILABLE")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("reason").asString()).isEqualTo("status-unavailable");
            assertThat(e.notifies()).isTrue();
        });
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        verify(client, never()).placeOrder(anyString());

        // 상태가 돌아온 뒤 달력까지 못 받으면 그것은 따로 한 번 — 그 사유가 3분 이어진 뒤에(QA-342 보완: 예전에는 첫 실패 주기 09:31에 바로)
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        when(client.calendar()).thenReturn(Reply.failed("calendar-unavailable"));
        run("09:31");
        run("09:33");
        assertThat(events("UNAVAILABLE")).as("장 운영 정보를 못 받은 지 2분 — 아직").hasSize(1);
        run("09:34:10");
        assertThat(events("UNAVAILABLE")).extracting(e -> e.detail().path("reason").asString())
                .containsExactlyInAnyOrder("status-unavailable", "calendar-unavailable");
    }

    @Test
    @DisplayName("QA-342 대조: 모의 달력이 휴장인 날과 마감 뒤에는 장 운영 정보·수집기 상태를 못 받아도 알리지 않음")
    void unavailableOutsideTradingHoursIsSilent() {
        RealTradeFixtures.live(store, true, d("10000000"));
        when(client.calendar()).thenReturn(Reply.failed("calendar-unavailable"));

        run("15:31");   // 마감 뒤 — 오늘 낼 주문이 없음
        assertThat(events("UNAVAILABLE")).isEmpty();

        when(paper.sessionHours(SESSION)).thenReturn(Optional.of(new SessionHours(SESSION, false, null, null)));
        job = restartedJob();
        run("10:00");
        assertThat(events("UNAVAILABLE")).isEmpty();
    }

    // ------------------------------------------------------------------ '준비 안 됨' 알림의 지속 조건·회복·최소 간격(QA-342 보완)
    private List<String> unavailableReasons() {
        return events("UNAVAILABLE").stream().map(e -> e.detail().path("reason").asString()).toList();
    }

    @Test
    @DisplayName("QA-342 보완: 수집기 매매 상태를 30초 못 읽은 것(장중 재기동)은 알리지 않는다 — 그동안 주문 없음, 돌아온 주기에 창 안의 주문은 그대로 나감")
    void briefStatusOutageDoesNotNotifyAndOrdersResume() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(due(331, 330, "BUY", "AT_MINUTE", kst("2026-11-06T10:00"), true)));
        when(paper.weightAfter(eq(BOOK), eq(331L), any())).thenReturn(Optional.of(new WeightAfter(331, A, "BUY", 60.0, 1e7, true,
                List.of(331L), List.of())));
        run("09:59:40");   // 평소 주기 — 장 운영 정보를 받아 둠

        when(client.status()).thenReturn(Reply.failed("collector-unreachable"));
        run("10:00:00");
        run("10:00:10");
        run("10:00:20");
        verify(client, never()).placeOrder(anyString());
        assertThat(events("UNAVAILABLE")).as("30초 끊김 — 아직 알리지 않음(수정 전: 첫 실패 주기에 바로 알림)").isEmpty();

        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        run("10:00:30");

        assertThat(sentSummaries()).as("받는 대로 이어 감 — 10:00 주문의 창(3분) 안").containsExactly("BUY " + A + " DAY 120");
        run("10:05");
        assertThat(events("UNAVAILABLE")).isEmpty();
        assertThat(cfg().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("QA-342 보완: 끊김이 3분 이어질 때 알리고(같은 끊김은 한 번), 회복한 뒤 다시 3분 끊기면 다시 알린다 — 주문 없음·멈춤 아님은 그대로")
    void outageNotifiesAfterThreeMinutesAndAgainAfterRecovery() {
        RealTradeFixtures.live(store, false, d("10000000"));
        run("09:59:40");

        when(client.status()).thenReturn(Reply.failed("collector-unreachable"));
        run("10:00:00");
        run("10:01:00");
        run("10:02:50");
        assertThat(events("UNAVAILABLE")).as("2분 50초 — 아직").isEmpty();
        run("10:03:00");
        assertThat(unavailableReasons()).containsExactly("status-unavailable");
        assertThat(events("UNAVAILABLE").getFirst().notifies()).isTrue();
        run("10:10");
        run("10:40");
        assertThat(events("UNAVAILABLE")).as("같은 끊김은 최소 간격(30분)이 지나도 다시 알리지 않음").hasSize(1);

        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        run("10:41");   // 회복 — 그 사유 없이 한 주기
        when(client.status()).thenReturn(Reply.failed("collector-unreachable"));
        run("11:30:00");
        run("11:32:50");
        assertThat(events("UNAVAILABLE")).hasSize(1);
        run("11:33:00");

        assertThat(unavailableReasons()).as("회복 뒤의 새 끊김 — 다시 3분 뒤 알림").containsExactly("status-unavailable", "status-unavailable");
        assertThat(cfg().state()).as("멈춤이 아님").isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        verify(client, never()).placeOrder(anyString());
    }

    @Test
    @DisplayName("QA-342 보완: 끊겼다 돌아오기를 되풀이해도 같은 사유의 알림은 30분에 한 번까지 — 30분이 지나도 이어지는 새 끊김은 그때 알림")
    void repeatedOutagesAreSpacedByTheMinimumInterval() {
        RealTradeFixtures.live(store, false, d("10000000"));
        run("09:59:40");
        when(client.status()).thenReturn(Reply.failed("collector-unreachable"));
        run("10:00:00");
        run("10:03:00");
        assertThat(events("UNAVAILABLE")).hasSize(1);
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        run("10:04");

        when(client.status()).thenReturn(Reply.failed("collector-unreachable"));
        run("10:10:00");
        run("10:13:10");
        assertThat(events("UNAVAILABLE")).as("새 끊김이 3분 넘었지만 앞 알림(10:03)부터 30분 안").hasSize(1);
        run("10:32:50");
        assertThat(events("UNAVAILABLE")).hasSize(1);
        run("10:33:00");
        assertThat(events("UNAVAILABLE")).as("앞 알림 + 30분 — 아직 이어지는 끊김을 알림").hasSize(2);
        run("10:50");
        run("11:10");
        assertThat(events("UNAVAILABLE")).as("알린 끊김은 이어져도 다시 알리지 않음").hasSize(2);
    }

    @Test
    @DisplayName("QA-342 보완: 장중에 다시 띄운 직후 토스 장 운영 정보를 한 번 못 받고 다음 재시도(60초 뒤)에 받으면 알리지 않는다")
    void briefCalendarFailureDoesNotNotify() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(client.calendar()).thenReturn(Reply.failed("calendar-unavailable"));
        run("10:00:00");
        run("10:00:30");

        when(client.calendar()).thenReturn(Reply.of(calendar(normalSession(), 0.3)));
        run("10:01:10");
        run("10:05");

        assertThat(events("UNAVAILABLE")).isEmpty();
        assertThat(job.todayView().windows()).as("받는 대로 이어 감").isNotEmpty();
    }

    @Test
    @DisplayName("QA-342 보완: 켜짐이 아닌 동안(끄기·이상 멈춤)은 끊김을 세지 않는다 — 다시 켠 뒤의 끊김은 그때부터 3분")
    void outageClockRestartsAfterNotLive() {
        RealTradeFixtures.live(store, false, d("10000000"));
        run("09:59:40");
        when(client.status()).thenReturn(Reply.failed("collector-unreachable"));
        run("10:00:00");
        run("10:02:00");
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_OFF), 1L));
        run("10:02:10");
        run("10:19:50");
        assertThat(events("UNAVAILABLE")).as("꺼짐 — 낼 주문이 없어 알리지 않음").isEmpty();

        RealTradeFixtures.live(store, false, d("10000000"));   // 다시 켬(시험 자리 — 켜기 API는 부르지 않음)
        run("10:20:00");
        run("10:22:50");
        assertThat(events("UNAVAILABLE")).as("다시 켠 뒤 2분 50초 — 꺼지기 전의 2분을 이어 세지 않음").isEmpty();
        run("10:23:00");
        assertThat(unavailableReasons()).containsExactly("status-unavailable");
    }

    @Test
    @DisplayName("QA-342: 토스만 휴장이라 답한 날(모의 달력은 거래일)은 쉼 이벤트를 알림 — 둘 다 휴장인 평소 휴장은 알리지 않음")
    void tossClosedButPaperTradingDayNotifies() {
        RealTradeFixtures.live(store, true, d("10000000"));
        when(client.calendar()).thenReturn(Reply.of(calendar(new CollectorTradeClient.Session(null, null), 0.3)));

        run("08:58");
        run("08:59");

        assertThat(events("SKIP_DAY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("reason").asString()).isEqualTo("market-closed");
            assertThat(e.notifies()).as("모의 달력은 거래일인데 토스가 휴장 — 알림").isTrue();
            assertThat(PaperTelegram.plain(RealTradeNotices.text(e))).contains("market-closed").contains("모의 달력");
        });
        verify(client, never()).placeOrder(anyString());

        // 대조 — 모의 달력도 휴장이면 평소 휴장이라 알리지 않음
        RealTradeFixtures.clean(jdbc);
        RealTradeFixtures.live(store, true, d("10000000"));
        when(paper.sessionHours(SESSION)).thenReturn(Optional.of(new SessionHours(SESSION, false, null, null)));
        job = restartedJob();
        run("09:01");
        assertThat(events("SKIP_DAY")).singleElement().satisfies(e -> assertThat(e.notifies()).isFalse());
    }

    @Test
    @DisplayName("QA-342: 토스 장 운영 정보에 종가 단일가 시각이 없는 날 — 따라 하지 못한 스탑은 STOP_SELL 놓침으로, 장중 주문은 마감 뒤 요약의 놓침으로 알림(주문 없음)")
    void noClosingAuctionCountsMisses() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(client.calendar()).thenReturn(Reply.of(calendar(new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T08:00"), kst("2026-11-06T08:50"), kst("2026-11-06T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T09:00"), null, kst("2026-11-06T15:30"))), 0.3)));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(701, A, "MARKET", kst("2026-11-06T10:00")),
                dueFor(702, 702, B, "BUY", kst("2026-11-06T10:30"))));

        run("09:59:50");
        assertThat(events("STOP_SELL")).isEmpty();
        run("10:00:10");
        run("10:00:20");

        assertThat(events("STOP_SELL")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("missed").asInt()).isEqualTo(1);
            assertThat(e.notifies()).isTrue();
        });

        run("10:31");
        run("15:34");
        run("15:35");

        assertThat(events("WINDOW_SUMMARY")).filteredOn(e -> "MIRROR".equals(e.detail().path("window").asString())).singleElement()
                .satisfies(e -> {
                    assertThat(e.detail().path("missed").asInt()).as("스탑 701 + 장중 주문 702").isEqualTo(2);
                    assertThat(e.notifies()).isTrue();
                });
        verify(client, never()).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 하루 한도(RT-CONTRACT-3)
    @Test
    @DisplayName("하루 건수 한도 — 오늘 주문 목록(앱 주문 포함)으로 남은 건수를 세어 그만큼만 보내고 나머지는 미룸(수집기가 거절할 주문을 보내지 않음)")
    void dailyOrderCapDefers() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 3, 999_999_999L,
                999_999_999L)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(
                broker("X-1", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now),
                broker("X-2", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now))));
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));

        run("08:51");

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + C + " OPG 100");
        run("09:31");
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("deferred").asInt()).isEqualTo(2);
            assertThat(e.detail().path("reasons").path("deferred-daily-cap").asInt()).isEqualTo(2);
        });
    }

    @Test
    @DisplayName("하루 매수 한도 — 오늘 체결 금액 + 진행 중 매수 잔량 × 상한가(모르는 상한가는 그 종목만 다시 물음)를 뺀 남은 금액 안으로 매수를 줄임")
    void dailyBuyCapIncludesOpenBuysAtUpper() {
        String app = "051910";
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 200, 3_000_000L,
                999_999_999L)));
        CollectorTradeClient.BrokerOrder appOpenBuy = broker("X-2", app, "BUY", "DAY", "PENDING", "10", "0", clock.now, null);
        when(client.todayOrders()).thenReturn(Reply.of(List.of(
                broker("X-1", "000270", "BUY", "DAY", "FILLED", "10", "10", clock.now, clock.now),   // 10 × 70,000 = 700,000
                appOpenBuy)));                                                                        // 10 × 상한가 26,000 = 260,000
        when(client.openOrders()).thenReturn(Reply.of(List.of(appOpenBuy)));
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        Preflight base = new Preflight(clock.now, d("10000000"), List.of(), Map.of(A, new Quote(d("50000"), d("65000"), null)), Map.of());
        Preflight withD = new Preflight(clock.now, d("10000000"), List.of(), Map.of(app, new Quote(d("20000"), d("26000"), null)), Map.of());
        when(client.preflight(any(), any())).thenAnswer(inv -> ((java.util.Collection<?>) inv.getArgument(0)).contains(app)
                ? Reply.of(withD) : Reply.of(base));

        run("08:51");

        // 남은 매수 금액 3,000,000 − 960,000 = 2,040,000 → floor(2,040,000 / 65,000) = 31주(목표 100주)
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("BUY " + A + " OPG 31");
        verify(client).preflight(eq(new java.util.TreeSet<>(List.of(app))), any());
    }

    @Test
    @DisplayName("오늘 주문 목록을 읽지 못하면(하루 한도를 셀 수 없음) 보내지 않음 — 수집기도 count-unavailable로 보내지 않음")
    void todayOrdersUnreadableSendsNothing() {
        when(client.todayOrders()).thenReturn(Reply.failed("timeout"));
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0), List.of());
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        run("08:51");
        verify(client, never()).placeOrder(anyString());
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
    }

    // ------------------------------------------------------------------ 형식 밖 종목 코드의 앱 미체결 매수(QA-413)
    /** 국내 종목 코드 모양(6자)이 아닌 합성 코드 — 수집기 사전 조회는 이런 종목의 시세를 주지 않고, 백엔드 클라이언트는 물으면 부르지 않고 실패합니다. */
    private static final String ODD = "Q500001";

    /**
     * {@link #preflight}와 같은 응답 — 단 실제 클라이언트({@code CollectorTradeClient.preflight})처럼, 물은 종목 가운데 국내 코드 모양이 아닌 것이 있으면
     * 부르지 않고 실패({@code invalid-symbol})합니다. 물은 종목 목록을 {@code asked}에 남깁니다.
     */
    private void strictPreflight(String cash, Map<String, String[]> holdings, Map<String, String> extraQuotes,
                                 List<java.util.Collection<String>> asked) {
        preflight(cash, holdings, extraQuotes);
        Reply<Preflight> ok = client.preflight(Set.of(), Set.of());
        when(client.preflight(any(), any())).thenAnswer(inv -> {
            java.util.Collection<String> symbols = inv.getArgument(0);
            java.util.Collection<String> sell = inv.getArgument(1);
            if (symbols == null || sell == null) {
                return null;   // 다시 정할 때(when(…) 안의 호출) — 인자 없음
            }
            asked.add(List.copyOf(symbols));
            boolean malformed = java.util.stream.Stream.concat(symbols.stream(), sell.stream())
                    .anyMatch(symbol -> symbol == null || !symbol.matches("^[0-9][0-9A-Z]{5}$"));
            return malformed ? Reply.failed("invalid-symbol") : ok;
        });
    }

    @Test
    @DisplayName("QA-413: 형식 밖 종목 코드의 앱 미체결 매수가 있어도 스탑 매도는 나간다 — 그 종목은 사전 조회에 넣지 않음")
    void malformedAppBuyDoesNotBlockStopSells() {
        RealTradeFixtures.live(store, false, d("10000000"));
        List<java.util.Collection<String>> asked = new ArrayList<>();
        strictPreflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of(), asked);
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "10", "0"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(601, A, "MARKET", kst("2026-11-06T11:32"))));

        run("11:32:10");

        assertThat(sentSummaries()).as("수정 전: 하루 한도를 셀 수 없다며 이 주기를 통째로 보내지 않음").containsExactly("SELL " + A + " DAY 100");
        assertThat(asked).allSatisfy(symbols -> assertThat(symbols).doesNotContain(ODD));
        assertThat(events("STOP_SELL")).singleElement().satisfies(e -> assertThat(e.detail().path("sent").asInt()).isEqualTo(1));
        assertThat(cfg().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("QA-413: 형식 밖 종목의 앱 미체결 매수가 걸린 동안 — 그 주문이 잡은 매수 금액을 셀 수 없으므로 매수는 모두 미루고(하루 한도 미룸) 매도만 보낸다. 그 주문이 끝나면 매수가 다시 나간다")
    void malformedAppBuyDefersBuysAndSendsSells() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        List<java.util.Collection<String>> asked = new ArrayList<>();
        strictPreflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"), asked);
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "10", "0"));

        run("08:51");

        assertThat(sentSummaries()).as("매도는 나가고 매수는 한 주도 나가지 않음(수정 전: 아무것도 보내지 않고 묶음도 없음)")
                .containsExactly("SELL " + C + " OPG 100");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(asked).allSatisfy(symbols -> assertThat(symbols).doesNotContain(ODD));

        // 그 앱 주문이 체결로 끝남(오늘 목록에 체결 금액과 함께 남고 미체결 목록에서 빠짐) — 쓴 매수 금액을 정확히 세어 매수가 다시 나감.
        // 시가 매도 C 100주도 체결돼 보유가 없고 현금이 늘어난 계좌.
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "OPG", "FILLED", "100", "100", clock.now, clock.now)));
        strictPreflight("10000000", Map.of(), Map.of(A, "50000", B, "20000"), asked);
        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(new CollectorTradeClient.BrokerOrder("APP-ODD", ODD, "BUY", "LIMIT", "DAY",
                "FILLED", d("10"), d("10"), d("10000"), d("100000"), null, null, kst("2026-11-06T08:40"), null, kst("2026-11-06T09:00"),
                "KRW"))));
        run("09:01");

        assertThat(sentSummaries()).containsExactly("SELL " + C + " OPG 100", "BUY " + B + " DAY 150", "BUY " + A + " DAY 93");
    }

    @Test
    @DisplayName("QA-413: 형식에 맞는 앱 매수와 형식 밖 앱 매수가 함께 걸려 있으면 — 형식에 맞는 종목만 상한가를 묻고, 매수는 미루고 매도는 보낸다")
    void malformedAppBuyNextToWellFormedOne() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        List<java.util.Collection<String>> asked = new ArrayList<>();
        strictPreflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"), asked);
        // D는 책에도 보유에도 없어 첫 사전 조회에 시세가 없음 — 하루 한도를 세며 D만 다시 물을 때 답함
        Reply<Preflight> base = client.preflight(Set.of(), Set.of());
        asked.clear();
        Preflight withD = new Preflight(clock.now, d("6000000"), List.of(), Map.of(D, new Quote(d("20000"), d("26000"), null)), Map.of());
        when(client.preflight(any(), any())).thenAnswer(inv -> {
            java.util.Collection<String> symbols = inv.getArgument(0);
            if (symbols == null) {
                return null;
            }
            asked.add(List.copyOf(symbols));
            if (symbols.stream().anyMatch(symbol -> !symbol.matches("^[0-9][0-9A-Z]{5}$"))) {
                return Reply.failed("invalid-symbol");
            }
            return symbols.contains(D) ? Reply.of(withD) : base;
        });
        tossOrders(appBuy("APP-D", D, "MARKET", "10", "0"), appBuy("APP-ODD", ODD, "LIMIT", "10", "0"));

        run("08:51");

        assertThat(sentSummaries()).containsExactly("SELL " + C + " OPG 100");
        assertThat(asked).as("상한가를 모르는 형식에 맞는 종목은 지금처럼 다시 물음").anyMatch(symbols -> symbols.equals(List.of(D)));
        assertThat(asked).allSatisfy(symbols -> assertThat(symbols).doesNotContain(ODD));
    }

    /** 형식 밖 종목의 앱 매수가 끝남(취소) — 미체결 목록에서 빠지고 오늘 목록에 체결 0으로 남음. */
    private void oddAppBuyEnded() {
        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(new CollectorTradeClient.BrokerOrder("APP-ODD", ODD, "BUY", "LIMIT", "DAY",
                "CANCELED", d("100"), d("0"), null, d("0"), null, null, kst("2026-11-06T08:40"), kst("2026-11-06T08:59"), null, "KRW"))));
    }

    @Test
    @DisplayName("QA-413 후속: 형식 밖 종목의 앱 매수가 걸린 주기에는 손실 한도로 매수 멈춤을 새로 켜지 않는다 — 잡힌 금액을 되돌릴 수 없어 판정값이 그만큼 낮게 "
            + "보일 뿐(그 주기의 매수는 이미 0). 그 주문이 끝나면 정확한 값으로 판정하고 매수가 다시 나간다")
    void malformedAppBuyDoesNotTripTheLossLimit() {
        plainBaseline();   // 기준 총액·기준 평가액 1,000만, 손실 한도 15%(150만)
        // 실제 손실 0 — 현금 600만 + 보유 C 400만. 형식 밖 종목의 앱 지정가 매수가 200만을 잡아 매수 가능 금액은 400만
        strictPreflight("4000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000"), new ArrayList<>());
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "100", "0"));

        run("08:51");

        assertThat(cfg().buysPaused()).as("수정 전: 지금 총액 800만으로 보아 손실 200만 ≥ 150만 — 거짓 매수 멈춤").isFalse();
        assertThat(events("BUYS_PAUSED")).isEmpty();
        assertThat(sentSummaries()).as("그 주기 — 매도만, 매수는 미룸").containsExactly("SELL " + C + " OPG 100");

        oddAppBuyEnded();   // 앱 주문이 끝나 잡혔던 200만이 매수 가능 금액으로 돌아옴
        // 시가 매도 C 100주도 체결로 끝나 보유가 없고 현금이 1,000만(총액 그대로 — 손실 0)인 계좌로 둠. 예전 준비 자료(C가 아직 보유·매도 진행 중, 현금
        // 600만)에서는 현금이 모자란 A(92주뿐)가 그 매도 대금을 기다려(QA-1018) '매수가 다시 나감'을 볼 수 없음 — 바로 위 시험의 둘째 단계와 같은 준비
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "OPG", "FILLED", "100", "100", clock.now, clock.now)));
        strictPreflight("10000000", Map.of(), Map.of(A, "50000"), new ArrayList<>());
        run("09:01");

        assertThat(cfg().buysPaused()).isFalse();
        assertThat(events("BUYS_PAUSED")).isEmpty();
        assertThat(sentSummaries()).as("그 주문이 끝난 뒤 매수가 다시 나감").containsExactly("SELL " + C + " OPG 100", "BUY " + A + " DAY 100");
    }

    @Test
    @DisplayName("QA-413 후속 대조: 실제로 손실 한도를 넘은 계좌 — 형식 밖 종목의 앱 매수가 걸린 동안에도 매수는 한 주도 나가지 않고(남은 매수 금액 0), "
            + "그 주문이 끝난 첫 주기에 판정이 매수보다 먼저 돌아 매수 멈춤이 켜진다")
    void realLossWithMalformedAppBuyNeverBuys() {
        plainBaseline();
        // 실제 손실 400만(현금 200만 + 보유 C 400만 = 600만) ≥ 150만. 형식 밖 종목의 앱 매수가 그 위에 100만을 더 잡아 매수 가능 금액은 100만
        strictPreflight("1000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000"), new ArrayList<>());
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "100", "0"));

        run("08:51");
        assertThat(sentSummaries()).as("매수 없음").containsExactly("SELL " + C + " OPG 100");

        oddAppBuyEnded();
        strictPreflight("2000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000"), new ArrayList<>());
        run("09:01");
        run("09:02");

        assertThat(cfg().buysPaused()).as("정확한 값(지금 총액 600만)으로 판정 — 매수 멈춤").isTrue();
        assertThat(events("BUYS_PAUSED")).hasSize(1);
        assertThat(sentSummaries()).as("어느 주기에도 매수는 나가지 않음").noneMatch(o -> o.startsWith("BUY"));
        assertThat(cfg().state()).as("손실 한도는 매수만 멈춤 — 이상 멈춤 아님").isEqualTo("LIVE");
    }

    @Test
    @DisplayName("QA-413 후속 대조: 이미 켜진 매수 멈춤은 형식 밖 종목의 앱 매수가 걸려 있어도, 그 주문이 끝나도 풀리지 않는다(해제는 사람이)")
    void pausedBuysStayPausedAroundMalformedAppBuy() {
        plainBaseline();
        store.lockConfig("KR", current -> store.updateConfig(current.withBuysPaused(true), null));
        strictPreflight("4000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000"), new ArrayList<>());
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "100", "0"));

        run("08:51");
        oddAppBuyEnded();
        strictPreflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000"), new ArrayList<>());
        run("09:01");

        assertThat(cfg().buysPaused()).isTrue();
        assertThat(sentSummaries()).noneMatch(o -> o.startsWith("BUY"));
    }

    // ---- 수집기도 그 종목을 셀 수 없을 때(QA-413 후속 — 수집기 자체 검사가 그 종목의 상한가를 토스에서 받지 못하면 모든 주문을 count-unavailable로 보내지 않음)
    private void collectorCannotCount() {
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.NOT_SENT, null, "count-unavailable", null));
    }

    private void collectorAccepts() {
        when(client.placeOrder(anyString())).thenAnswer(inv -> new OrderResult(Outcome.ACCEPTED, "T-" + orderIds.incrementAndGet(), null, 200));
    }

    private List<OrderRow> todayRows() {
        return store.ordersOn("KR", SESSION);
    }

    @Test
    @DisplayName("QA-413 후속: 형식 밖 종목의 앱 매수가 걸린 주기에 수집기가 count-unavailable로 답하면 — 수집기도 셀 수 없다는 뜻이라 그 주문이 걸려 있는 동안은 "
            + "보내지 않는 예전 동작으로 물러나고(행을 더 쓰지 않음), 그 앱 주문이 끝나면 스탑 매도가 창 안에서 다시 나간다")
    void collectorCannotCountFallsBackAndTheStopSellsLater() {
        RealTradeFixtures.live(store, false, d("10000000"));
        strictPreflight("1000000", Map.of(A, new String[]{"100", "50000"}), Map.of(), new ArrayList<>());
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "10", "0"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(601, A, "MARKET", kst("2026-11-06T11:32"))));
        collectorCannotCount();

        run("11:32:10");
        run("11:32:20");
        run("11:32:30");

        verify(client, times(1)).placeOrder(anyString());   // 수정 전: 2(시도 1·2를 20초 만에 다 씀)
        assertThat(todayRows()).singleElement().satisfies(row -> {
            assertThat(row.sendOutcome()).isEqualTo("NOT_SENT");
            assertThat(row.outcomeCode()).as("그 물러남을 일으킨 답 — 따로 적음").isEqualTo("count-unavailable-unpriced");
        });
        assertThat(cfg().state()).isEqualTo("LIVE");

        oddAppBuyEnded();
        collectorAccepts();
        run("11:32:40");

        assertThat(todayRows()).as("그 앱 주문이 끝난 뒤 — 스탑 창(3분) 안에서 다시 보냄").hasSize(2).last().satisfies(row -> {
            assertThat(row.sendOutcome()).isEqualTo("ACCEPTED");
            assertThat(row.side() + " " + row.symbol() + " " + row.quantity()).isEqualTo("SELL " + A + " 100");
        });
    }

    @Test
    @DisplayName("QA-413 후속: 매도 여러 건이 걸린 주기에 수집기가 count-unavailable로 답해도 — 첫 답에서 물러나 한 건만 적고, 같은 오류 반복으로 이상 멈춤이 되지 않는다. "
            + "앱 주문이 끝나면 모두 다시 나간다")
    void collectorCannotCountDoesNotHaltOnSeveralSells() {
        RealTradeFixtures.live(store, false, d("10000000"));
        strictPreflight("1000000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"10", "20000"}), Map.of(), new ArrayList<>());
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "10", "0"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(601, A, "MARKET", kst("2026-11-06T11:32")),
                stopDue(602, B, "MARKET", kst("2026-11-06T11:32"))));
        collectorCannotCount();

        run("11:32:10");
        run("11:32:20");
        run("11:32:30");
        run("11:32:40");

        assertThat(cfg().state()).as("수정 전: 세 번째 주기에 HALTED(repeated-error)").isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        verify(client, times(1)).placeOrder(anyString());

        oddAppBuyEnded();
        collectorAccepts();
        run("11:32:50");

        assertThat(todayRows().stream().filter(row -> "ACCEPTED".equals(row.sendOutcome())).map(row -> row.side() + " " + row.symbol()))
                .containsExactlyInAnyOrder("SELL " + A, "SELL " + B);
    }

    @Test
    @DisplayName("QA-413 후속: 물러남은 그날 행에서 되살린다 — 다시 띄운 작업은 형식 밖 주문이 걸려 있는 동안 한 번 더 보내지 않고(남은 시도를 쓰지 않게), "
            + "같은 날 다른 형식 밖 주문이 다시 걸려도 시도 없이 물러난다")
    void collectorCannotCountSurvivesRestart() {
        RealTradeFixtures.live(store, false, d("10000000"));
        strictPreflight("1000000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"10", "20000"}), Map.of(), new ArrayList<>());
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "10", "0"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(601, A, "MARKET", kst("2026-11-06T11:32"))));
        collectorCannotCount();
        run("11:32:10");
        verify(client, times(1)).placeOrder(anyString());

        job = restartedJob();
        run("11:32:20");
        run("11:32:30");
        verify(client, times(1)).placeOrder(anyString());

        oddAppBuyEnded();
        collectorAccepts();
        run("11:32:40");
        assertThat(todayRows()).hasSize(2).last().satisfies(row -> assertThat(row.sendOutcome()).isEqualTo("ACCEPTED"));

        // 같은 날 오후 — 다른 형식 밖 종목의 앱 매수가 걸린 채 새 스탑: 오늘 이미 수집기가 셀 수 없다고 답했으므로 시도 없이 물러남
        tossOrders(appBuy("APP-ODD2", "Q500002", "LIMIT", "10", "0"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(602, B, "MARKET", kst("2026-11-06T13:00"))));
        run("13:00:10");
        run("13:00:20");
        assertThat(todayRows()).hasSize(2);
    }

    @Test
    @DisplayName("QA-413 후속 대조: 형식 밖 주문이 없는 평소 주기의 count-unavailable은 그대로 — 사유 코드도, 시도 2 재시도도, 같은 오류 3회 이상 멈춤도")
    void plainCountUnavailableIsUnchanged() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("1000000", Map.of(A, new String[]{"100", "50000"}, B, new String[]{"10", "20000"}), Map.of());
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(601, A, "MARKET", kst("2026-11-06T11:32")),
                stopDue(602, B, "MARKET", kst("2026-11-06T11:32"))));
        collectorCannotCount();

        run("11:32:10");
        run("11:32:20");
        assertThat(todayRows()).hasSize(4).allSatisfy(row -> assertThat(row.outcomeCode()).isEqualTo("count-unavailable"));
        assertThat(todayRows()).extracting(OrderRow::attempt).containsExactlyInAnyOrder(1, 1, 2, 2);

        run("11:32:30");
        assertThat(cfg().haltReason()).isEqualTo("repeated-error");
    }

    @Test
    @DisplayName("QA-413 대조: 형식 밖 종목의 앱 매수도 하루 건수에는 그대로 센다 — 건수가 다 찼으면 매도도 미룸(한도가 느슨해지지 않음)")
    void malformedAppBuyStillCountsTowardDailyOrders() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 3, 999_999_999L,
                999_999_999L)));
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        strictPreflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"), new ArrayList<>());
        CollectorTradeClient.BrokerOrder odd = appBuy("APP-ODD", ODD, "LIMIT", "10", "0");
        when(client.openOrders()).thenReturn(Reply.of(List.of(odd)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(
                broker("X-1", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now),
                broker("X-2", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now), odd)));

        run("08:51");

        verify(client, never()).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 사전 조회 두 단계(RT-CONTRACT-5)
    @Test
    @DisplayName("사전 조회 — 매도 가능 수량은 팔 종목만 물음(먼저 매도 가능 수량 없이 계획 → 매도 후보만 다시), 장중 매수는 묻지 않음")
    void preflightAsksSellableOnlyForSells() {
        RealTradeFixtures.live(store, true, d("10000000"));
        targets(Map.of(A, 50.0, B, 30.0), List.of());
        preflight("6000000", Map.of(C, new String[]{"100", "40000"}), Map.of(A, "50000", B, "20000"));

        run("08:51");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<java.util.Collection<String>> sells = ArgumentCaptor.forClass(java.util.Collection.class);
        verify(client, times(2)).preflight(any(), sells.capture());
        assertThat(sells.getAllValues().get(0)).as("첫 조회 — 매도 가능 수량 없이").isEmpty();
        assertThat(sells.getAllValues().get(1)).as("매도 후보(책에 없는 보유)만").containsExactly(C);
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + C + " OPG 100", "BUY " + B + " OPG 150", "BUY " + A + " OPG 32");

        org.mockito.Mockito.clearInvocations(client);
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(due(331, 330, "BUY", "AT_MINUTE", kst("2026-11-06T10:00"), true)));
        when(paper.weightAfter(eq(BOOK), eq(331L), any())).thenReturn(Optional.of(new WeightAfter(331, A, "BUY", 60.0, 1e7, true,
                List.of(331L), List.of())));
        run("10:00:20");
        verify(client).preflight(any(), sells.capture());
        assertThat(sells.getValue()).as("장중 매수 주문 — 매도 가능 수량을 묻지 않음").isEmpty();
    }

    @Test
    @DisplayName("백엔드 스위치가 꺼져 있으면 정기 작업은 아무것도 하지 않음")
    void disabledDoesNothing() {
        RealTradeFixtures.live(store, true, d("10000000"));
        RealTradeJob off = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, false, true, 10_000);
        off.cycle(kst("2026-11-06T08:51"));
        verifyNoInteractions(client);
        verifyNoInteractions(telegram);
    }

    @Test
    @DisplayName("종료 훅 — 전용 스레드를 멈추고, 그 뒤로는 새 SENDING을 쓰지 않음")
    void shutdownBlocksNewSends() {
        Config cfg = RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeJob running = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, true, 10_000);
        running.start();
        running.stop();
        assertThat(executor.closing()).isTrue();
        RealTradeExecutor.Sent sent = executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 701L, 700L, A,
                "SELL", 1, "DAY", d("50000"), 1), cfg);
        assertThat(sent.result()).isEqualTo(RealTradeExecutor.Result.NOT_INSERTED);
        assertThat(store.recentOrders("KR", 10)).isEmpty();
        verify(client, never()).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 알림
    @Test
    @DisplayName("알림 — 알림 대기 이벤트를 보내고 표시, 실패하면 다음 주기에 다시. 글에 종목·수량·금액이 없음")
    void notifications() {
        when(telegram.configured()).thenReturn(true);
        when(telegram.send(eq(PaperTelegram.Channel.ACCOUNT), anyString())).thenReturn("일시 실패").thenReturn(null);
        store.addEvent("KR", "HALT", null, Map.of("reason", "unknown-order", "symbol", A, "amount", 1234567, "row", 9), true);
        store.addEvent("KR", "WINDOW_SUMMARY", null, Map.of("window", "SYNC", "accepted", 5, "filled", 5, "skipped", 1,
                "reasons", Map.of("opposite-pending", 1), "symbols", List.of(A, B)), true);

        job.notifyPending(clock.now);
        assertThat(store.unnotifiedEvents(10)).hasSize(2);
        job.notifyPending(clock.now);
        assertThat(store.unnotifiedEvents(10)).isEmpty();

        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(telegram, times(3)).send(eq(PaperTelegram.Channel.ACCOUNT), texts.capture());
        assertThat(com.macrodash.feature.paper.PaperTelegram.plain(texts.getAllValues().get(1))).isEqualTo("[실제 매매] 멈춤\n\n사유: unknown-order");
        assertThat(com.macrodash.feature.paper.PaperTelegram.plain(texts.getAllValues().get(2))).isEqualTo("[실제 매매] 시가 맞추기\n\n접수 5 · 체결 5 · 놓침 0\n건너뜀 1 · 막힘 0 · 미룸 0");
        assertThat(texts.getAllValues()).noneMatch(t -> t.contains(A) || t.contains(B) || t.contains("1234567") || t.contains("1,234,567"));
    }

    @Test
    @DisplayName("선점 실패(장중 교체가 먼저 취소 — 모의 주문이 대기가 아님)면 행도 전송도 없고, 그 뿌리는 그날 다시 보지 않음")
    void claimFailureMeansNoRow() {
        RealTradeFixtures.live(store, false, d("10000000"));
        preflight("10000000", Map.of(), Map.of(A, "50000"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(due(601, 600, "BUY", "AT_MINUTE", kst("2026-11-06T10:00"), true)));
        when(paper.weightAfter(eq(BOOK), eq(601L), any())).thenReturn(Optional.of(new WeightAfter(601, A, "BUY", 20.0, 1e7, true,
                List.of(601L), List.of())));
        org.mockito.Mockito.doReturn(Optional.empty()).when(paper).claim(anyString(), anyLong(), any(), any());
        run("10:00:20");
        run("10:00:40");
        verify(client, never()).placeOrder(anyString());
        assertThat(store.recentOrders("KR", 10)).isEmpty();
        verify(paper, times(1)).claim(anyString(), anyLong(), any(), any());
    }

    // ------------------------------------------------------------------ 마지막 운용 평가액(2026-11-08 — 휴장일·재기동 뒤에도 화면에)
    /** 11-02(월)~11-06(금) 거래일 09:00~15:30, 11-07·11-08 주말 — 마감 뒤 읽기가 거슬러 보는 모의 한국 달력. */
    private void week() {
        for (int day = 2; day <= 8; day++) {
            LocalDate date = LocalDate.of(2026, 11, day);
            String ymd = date.toString();
            when(paper.sessionHours(date)).thenReturn(Optional.of(day <= 6
                    ? new SessionHours(date, true, kst(ymd + "T09:00"), kst(ymd + "T15:30"))
                    : new SessionHours(date, false, null, null)));
        }
    }

    private void at(String local) {
        clock.set(kst(local));
        job.cycle(clock.now);
    }

    @Test
    @DisplayName("운용 평가액 — 창 안 사전 조회 값(E·상한 없는 총액·매수 가능 금액·읽은 시각)을 V29 표에 남김")
    void valuationPersistedFromCycle() {
        cappedBaseline("20000000", "450");   // 총액 2,900만, 안전 상한 1,000만

        run("08:51");

        assertThat(store.valuation("KR")).hasValueSatisfying(v -> {
            assertThat(v.equity()).isEqualByComparingTo("10000000");
            assertThat(v.total()).isEqualByComparingTo("29000000");
            assertThat(v.cashBuyingPower()).isEqualByComparingTo("20000000");
            assertThat(v.fetchedAt()).isEqualTo(kst("2026-11-06T08:51"));
        });
    }

    @Test
    @DisplayName("운용 평가액 — 다시 띄운 작업은 저장된 값을 보유 없이 되살리고, 그 값이 마지막 마감 뒤 값이면 토스를 부르지 않음")
    void valuationRestoredAfterRestart() {
        week();
        store.saveValuation(new Valuation("KR", kst("2026-11-05T15:41"), d("12000000"), d("15000000"), d("3000000")));

        at("2026-11-06T08:40");

        RealTradeJob.PreflightView view = job.lastPreflight();
        assertThat(view).isNotNull();
        assertThat(view.fetchedAt()).isEqualTo(kst("2026-11-05T15:41"));
        assertThat(view.equity()).isEqualByComparingTo("12000000");
        assertThat(view.total()).isEqualByComparingTo("15000000");
        assertThat(view.cashBuyingPower()).isEqualByComparingTo("3000000");
        assertThat(view.holdings()).as("보유는 저장하지 않음").isEmpty();
        verify(client, never()).preflight(any(), any());
    }

    @Test
    @DisplayName("운용 평가액 — 휴장일(토)에 마지막 거래일 마감 뒤 값이 없으면 읽기 전용 사전 조회 한 번(꺼짐에서도, 매도 가능 수량 없음), 읽은 뒤에는 다시 부르지 않음")
    void holidayReadsOnceAfterClose() {
        week();
        store.saveValuation(new Valuation("KR", kst("2026-11-06T09:05"), d("1"), d("1"), d("1")));   // 금요일 장중 값
        clock.set(kst("2026-11-07T12:00"));
        preflight("3000000", Map.of(A, new String[]{"10", "50000"}), Map.of());

        at("2026-11-07T12:00");

        verify(client, times(1)).preflight(eq(Set.of()), eq(List.of()));
        assertThat(job.lastPreflight().equity()).isEqualByComparingTo("3500000");
        assertThat(job.lastPreflight().total()).isEqualByComparingTo("3500000");
        assertThat(store.valuation("KR")).hasValueSatisfying(v -> {
            assertThat(v.equity()).isEqualByComparingTo("3500000");
            assertThat(v.fetchedAt()).isEqualTo(kst("2026-11-07T12:00"));
        });

        at("2026-11-07T12:30");
        at("2026-11-08T12:00");
        verify(client, times(1)).preflight(any(), any());
        verify(client, never()).placeOrder(anyString());
        assertThat(store.recentEvents("KR", 10)).isEmpty();
    }

    @Test
    @DisplayName("운용 평가액 — 토스 점검(사전 조회 실패)이면 마지막 값을 그대로 두고 15분 뒤 다시, 멈춤·이벤트·알림 없음, 점검이 끝나면 새 값")
    void holidayMaintenanceKeepsLastValueAndRetries() {
        week();
        store.saveValuation(new Valuation("KR", kst("2026-11-06T09:05"), d("12000000"), d("15000000"), d("3000000")));
        when(client.preflight(any(), any())).thenReturn(Reply.failed("upstream-error"));

        at("2026-11-07T12:00");
        assertThat(job.lastPreflight().equity()).isEqualByComparingTo("12000000");
        assertThat(job.lastPreflight().fetchedAt()).isEqualTo(kst("2026-11-06T09:05"));
        at("2026-11-07T12:10");
        verify(client, times(1)).preflight(any(), any());
        at("2026-11-07T12:15");
        verify(client, times(2)).preflight(any(), any());
        assertThat(store.configOrOff("KR").state()).isEqualTo(RealTradeStore.STATE_OFF);
        assertThat(store.recentEvents("KR", 10)).isEmpty();
        verify(telegram, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
        assertThat(store.valuation("KR")).hasValueSatisfying(v -> assertThat(v.fetchedAt()).isEqualTo(kst("2026-11-06T09:05")));

        clock.set(kst("2026-11-07T12:30"));
        preflight("3000000", Map.of(), Map.of());
        at("2026-11-07T12:30");
        assertThat(job.lastPreflight().equity()).isEqualByComparingTo("3000000");
        assertThat(store.valuation("KR")).hasValueSatisfying(v -> assertThat(v.fetchedAt()).isEqualTo(kst("2026-11-07T12:30")));
    }

    @Test
    @DisplayName("운용 평가액 — 거래일 장중(개장 30분 전 ~ 마감 10분 뒤)·이상 멈춤에는 마감 뒤 읽기를 하지 않고, 마감 10분 뒤 꺼짐이면 한 번")
    void noAfterCloseReadDuringSessionOrHalt() {
        week();
        store.saveValuation(new Valuation("KR", kst("2026-11-05T10:00"), d("12000000"), d("15000000"), d("3000000")));   // 목요일 장중 값
        clock.set(kst("2026-11-06T08:30"));
        preflight("3000000", Map.of(), Map.of());

        at("2026-11-06T08:30");
        at("2026-11-06T14:00");
        at("2026-11-06T15:39");
        verify(client, never()).preflight(any(), any());

        store.lockConfig("KR", c -> store.updateConfig(c.withState(RealTradeStore.STATE_HALTED).withHalt("restored", null), 1L));
        at("2026-11-06T15:41");
        verify(client, never()).preflight(any(), any());

        store.lockConfig("KR", c -> store.updateConfig(c.withState(RealTradeStore.STATE_OFF).withHalt(null, null), 1L));
        at("2026-11-06T15:42");
        verify(client, times(1)).preflight(any(), any());
    }

    // ------------------------------------------------------------------ 재선정 다음 묶음의 회전율 예외(ADR 0028 덧붙임 2026-11-19)
    // 계획 3판 6-2. 금액은 모두 합성(E = 1,000만 원, 모든 종목 1,000원 — 1% = 100주, 상한가 1,300원). 사례 이름(N1·S1b 등)은 계획 4절 표.
    /** 결정일 D — 세션 2026-11-06(금)의 앞 거래일(목). */
    private static final LocalDate DECISION_DAY = SESSION.minusDays(1);
    private static final double SLOT = 100.0 / 15;

    /** 글자 → 합성 종목 코드(A → 900001 ...). 153130은 그대로. */
    private static String r(String letter) {
        return letter.equals(CASH_LIKE) ? CASH_LIKE : String.format("9%05d", letter.charAt(0) - 'A' + 1);
    }

    /** 글자(또는 153130)와 % 쌍의 맵. */
    private static Map<String, Double> pcts(Object... pairs) {
        Map<String, Double> out = new java.util.TreeMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put(r((String) pairs[i]), ((Number) pairs[i + 1]).doubleValue());
        }
        return out;
    }

    private static Map<String, Double> each(String letters, double weight) {
        Map<String, Double> out = new java.util.TreeMap<>();
        for (char c : letters.toCharArray()) {
            out.put(r(String.valueOf(c)), weight);
        }
        return out;
    }

    @SafeVarargs
    private static Map<String, Double> merged(Map<String, Double>... maps) {
        Map<String, Double> out = new java.util.TreeMap<>();
        for (Map<String, Double> m : maps) {
            out.putAll(m);
        }
        return out;
    }

    private static Map<String, Double> scaled(Map<String, Double> weights, double factor) {
        Map<String, Double> out = new java.util.TreeMap<>();
        weights.forEach((k, v) -> out.put(k, v * factor));
        return out;
    }

    /** 글자들(또는 153130 하나)의 종목을 뺀 맵. */
    private static Map<String, Double> minus(Map<String, Double> weights, String letters) {
        Map<String, Double> out = new java.util.TreeMap<>(weights);
        if (letters.equals(CASH_LIKE)) {
            out.remove(CASH_LIKE);
            return out;
        }
        for (char c : letters.toCharArray()) {
            out.remove(r(String.valueOf(c)));
        }
        return out;
    }

    private static Set<String> letters(String letters) {
        Set<String> out = new java.util.TreeSet<>();
        for (char c : letters.toCharArray()) {
            out.add(r(String.valueOf(c)));
        }
        return out;
    }

    // 계획 4-1 공통 자료(10~11% 슬롯)
    private static final Map<String, Double> P1 = merged(pcts(CASH_LIKE, 44), each("ABCDE", 11));
    private static final Map<String, Double> H1 = pcts(CASH_LIKE, 44.0, "A", 11.4, "B", 10.7, "C", 11.2, "D", 10.9, "E", 10.6);
    private static final Map<String, Double> NOW1 = merged(pcts(CASH_LIKE, 4), each("ABCDE", 11), each("FGHI", 10));
    private static final Map<String, Double> P2 = merged(pcts(CASH_LIKE, 1), each("ABCDEFGHIJ", 9.8));
    private static final Map<String, Double> H2 = pcts(CASH_LIKE, 1.0, "A", 10.1, "B", 9.6, "C", 9.9, "D", 9.5, "E", 10.0, "F", 10.0,
            "G", 9.4, "H", 10.1, "I", 9.6, "J", 9.6);
    private static final Map<String, Double> NOW_N2 = merged(pcts(CASH_LIKE, 0.7), each("ABCDEF", 9.8), each("KLMN", 10));

    /** 따라 하는 책을 규칙 계좌(같은 코드·세대)로, 결정일 D의 모의 달력은 거래일. */
    private void rulesBook() {
        when(paper.book(BOOK)).thenReturn(Optional.of(new BookInfo(BOOK, "규칙 계좌", "RULES", "KR", "ACTIVE", LocalDate.of(2026, 10, 30),
                Instant.parse("2026-10-29T13:00:00Z"), GENERATION)));
        when(paper.sessionHours(DECISION_DAY)).thenReturn(Optional.of(new SessionHours(DECISION_DAY, true, kst("2026-11-05T09:00"),
                kst("2026-11-05T15:30"))));
    }

    /** 결정일 D의 정기 결정(종류·상태 — 둘 다 null이면 행 없음). */
    private void decision(String kind, String status) {
        when(paper.decisionState(BOOK, DECISION_DAY)).thenReturn(Optional.of(new PaperMirrorService.DecisionState(DECISION_DAY,
                kind == null ? null : 77L, kind, status, kst("2026-11-06T01:00"))));
    }

    /** 실제 계좌 — 보유(E 대비 %, 1,000원 — 수량은 내림), 현금 = E − 보유 금액, 시세는 보유 + {@code quoted}(가격 모름 {@code unpriced}는 뺌). */
    private void rulesAccount(Map<String, Double> heldPct, Set<String> quoted, Set<String> unpriced) {
        Map<String, String[]> holdings = new LinkedHashMap<>();
        long invested = 0;
        for (Map.Entry<String, Double> e : heldPct.entrySet()) {
            long qty = (long) Math.floor(e.getValue() * 100 + 1e-9);
            holdings.put(e.getKey(), new String[]{String.valueOf(qty), "1000"});
            invested += qty * 1000;
        }
        Map<String, String> extra = new LinkedHashMap<>();
        quoted.stream().filter(s -> !holdings.containsKey(s) && !unpriced.contains(s)).forEach(s -> extra.put(s, "1000"));
        preflight(String.valueOf(10_000_000L - invested), holdings, extra);
    }

    /** 시각 맞추기 날(09:10)의 목표 — 책 가격은 1,000원(덮어쓸 값은 {@code bookPrice}). */
    private void rulesTargets(Map<String, Double> now, Map<String, Double> bookPrice) {
        Map<String, Double> price = new java.util.HashMap<>();
        now.keySet().forEach(s -> price.put(s, 1000.0));
        price.putAll(bookPrice);
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.of(SYNC_AT));
        when(paper.targetsAt(BOOK, SESSION, SYNC_AT)).thenReturn(Optional.of(new OpenTargets(BOOK, SESSION, now, price, 1e7, 0, List.of(),
                List.of(), List.of())));
    }

    /**
     * 재선정 다음 날(시각 맞추기 09:10) — 켜짐(sync_pending 꺼짐), 규칙 계좌, D의 결정 REBALANCE·OK, 앞 묶음(D, 같은 책), 보유, 지금 목표, 스탑. 한도·매매 제한·
     * 미체결은 기본값으로 다시 정합니다(한 시험 안에서 사례를 이어 돌릴 때 앞 사례의 값이 남지 않게).
     */
    private void rebalanceDay(Map<String, Double> prev, Map<String, Double> held, Map<String, Double> now, Set<String> stops) {
        RealTradeFixtures.live(store, false, d("10000000"));
        rulesBook();
        decision("REBALANCE", "OK");
        priorBatch(DECISION_DAY, prev);
        rulesTargets(now, Map.of());
        Set<String> quoted = new java.util.TreeSet<>(now.keySet());
        quoted.addAll(prev.keySet());
        rulesAccount(held, quoted, Set.of());
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(stops);
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        when(client.restrictions(any())).thenReturn(Reply.of(new CollectorTradeClient.Restrictions(Set.of(), Map.of())));
        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        when(client.todayOrders()).thenReturn(Reply.of(List.of()));
    }

    /** 한 시험 안에서 다음 사례 — 표를 비우고 작업·실행기를 새로(그날 상태·호출 기록 없이). */
    private void nextCase() {
        RealTradeFixtures.clean(jdbc);
        org.mockito.Mockito.clearInvocations(client, paper, telegram);
        executor = new RealTradeExecutor(store, client, paper, RealTradeFixtures.MAPPER, clock);
        job = new RealTradeJob(store, executor, client, paper, telegram, RealTradeFixtures.MAPPER, clock, true, false, 10_000);
    }

    /** 기본 설정 15종목 동일비중(6.667%) 11-19형 — 앞 묶음·보유 8종목 + 153130 46.67%, 지금 목표는 유지 {@code 8 − swaps}개 + 새 종목, 남는 몫은 153130. */
    private record Slot(Map<String, Double> prev, Map<String, Double> now, Set<String> stops) {
    }

    private static String held8(int i) {
        return String.format("8000%02d", i);
    }

    private static String fresh15(int i) {
        return String.format("8100%02d", i);
    }

    private static Slot slot(int swaps, int stopsAfter) {
        Map<String, Double> prev = new java.util.TreeMap<>();
        for (int i = 0; i < 8; i++) {
            prev.put(held8(i), SLOT);
        }
        prev.put(CASH_LIKE, 100 - SLOT * 8);
        Map<String, Double> now = new java.util.TreeMap<>();
        Set<String> stops = new java.util.TreeSet<>();
        for (int i = swaps; i < 8; i++) {
            if (stops.size() < stopsAfter && i >= swaps + 1) {
                stops.add(held8(i));   // 결정 뒤 반영된 STOP — 그 종목 목표 0
            } else {
                now.put(held8(i), SLOT);
            }
        }
        for (int i = 0; i < swaps + 7; i++) {
            now.put(fresh15(i), SLOT);
        }
        double park = 100 - now.values().stream().mapToDouble(Double::doubleValue).sum() - SLOT * stops.size();
        if (park > 0.5) {
            now.put(CASH_LIKE, park);
        }
        return new Slot(prev, now, stops);
    }

    private JsonNode haltDetail() {
        List<Event> halts = events("HALT");
        assertThat(halts).hasSize(1);
        return halts.getFirst().detail();
    }

    /** 지금처럼 멈춤 — 사유 turnover, 판정 코드, 묶음·주문·예외 이벤트 없음. */
    private void assertHalted(String label, String check) {
        assertThat(cfg().state()).as(label).isEqualTo("HALTED");
        assertThat(cfg().haltReason()).as(label).isEqualTo("turnover");
        assertThat(haltDetail().path("rebalanceCheck").asString()).as(label).isEqualTo(check);
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).as(label).isEmpty();
        verify(client, never()).placeOrder(anyString());
        assertThat(events("TURNOVER_EXEMPT")).as(label).isEmpty();
    }

    /** 예외로 보냄 — 켜짐, 멈춤 없음, 묶음 있음, 예외 이벤트 하나(알림, %·배율·개수 칸만 — 종목 코드·수량·금액 칸 없음). */
    private JsonNode assertExempt(String label) {
        assertThat(cfg().state()).as(label).isEqualTo("LIVE");
        assertThat(events("HALT")).as(label).isEmpty();
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).as(label).isPresent();
        List<Event> exempt = events("TURNOVER_EXEMPT");
        assertThat(exempt).as(label).hasSize(1);
        assertThat(exempt.getFirst().notifies()).isTrue();
        JsonNode detail = exempt.getFirst().detail();
        List<String> fields = new ArrayList<>();
        detail.propertyNames().forEach(fields::add);
        assertThat(fields).as(label).containsExactlyInAnyOrder("decisionDate", "turnoverPct", "checkTurnoverPct", "bookDriftPct", "accountDriftPct",
                "dailyShortPct", "priceRatio", "nameJumpPct", "nameCutPct", "stockNames", "deriskPct", "investedPct", "allowancePct");
        assertThat(detail.path("decisionDate").asString()).isEqualTo("2026-11-05");
        detail.properties().forEach(e -> {
            if (!e.getKey().equals("decisionDate")) {
                assertThat(e.getValue().isNumber()).as(label + " " + e.getKey()).isTrue();
            }
        });
        return detail;
    }

    @Test
    @DisplayName("재선정 예외 — 기본 15종목 슬롯 교체 2(4-4), 09:10 시각 맞추기: 회전율 약 120%여도 보냄(153130·유지 종목 매도 DAY), 예외 이벤트 하나, sync_pending 꺼진 채")
    void rebalanceExemptsTurnoverOnTimedDay() {
        Slot s = slot(2, 0);
        rebalanceDay(s.prev(), s.prev(), s.now(), s.stops());

        run("09:10:05");

        JsonNode detail = assertExempt("교체 2");
        assertThat(detail.path("turnoverPct").asDouble()).isCloseTo(119.92, org.assertj.core.data.Offset.offset(0.05));
        assertThat(detail.path("checkTurnoverPct").asDouble()).isCloseTo(119.92, org.assertj.core.data.Offset.offset(0.05));
        assertThat(detail.path("bookDriftPct").asDouble()).isCloseTo(120.0, org.assertj.core.data.Offset.offset(0.05));
        assertThat(detail.path("accountDriftPct").asDouble()).isZero();
        assertThat(detail.path("stockNames").asInt()).isEqualTo(15);
        assertThat(sentSummaries()).startsWith("SELL " + CASH_LIKE + " DAY 4666", "SELL " + held8(0) + " DAY 666", "SELL " + held8(1) + " DAY 666");
        assertThat(cfg().syncPending()).isFalse();
        assertThat(store.recentOrders("KR", 20)).allMatch(o -> o.purpose().equals("SYNC_FOLLOWUP"));
        verify(paper, times(1)).decisionState(BOOK, DECISION_DAY);

        run("09:10:40");
        verify(paper, times(1)).decisionState(BOOK, DECISION_DAY);   // 한 번만 — 그날 묶음이 있으면 다시 판정하지 않음
        assertThat(events("TURNOVER_EXEMPT")).hasSize(1);
    }

    @Test
    @DisplayName("재선정 예외 — N1(153130 → 종목 넷), 시가 맞추기(OPG) 날에도 같음")
    void rebalanceExemptsTurnoverOnOpenDay() {
        rebalanceDay(P1, H1, NOW1, Set.of());
        Map<String, Double> price = new java.util.HashMap<>();
        NOW1.keySet().forEach(sym -> price.put(sym, 1000.0));
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.empty());
        when(paper.openTargets(BOOK, SESSION)).thenReturn(Optional.of(new OpenTargets(BOOK, SESSION, NOW1, price, 1e7, 0, List.of(), List.of())));

        run("08:51");

        JsonNode detail = assertExempt("N1");
        assertThat(detail.path("checkTurnoverPct").asDouble()).isEqualTo(80.0);
        assertThat(sentSummaries()).contains("SELL " + CASH_LIKE + " OPG 4000");
        assertThat(store.recentOrders("KR", 20)).allMatch(o -> o.purpose().equals("SYNC"));
    }

    @Test
    @DisplayName("재선정 예외 — N2(후보 넷 교체)·기본 슬롯 교체 4는 보냄, 교체 5는 over-cap(153130 46.7% 기준 판정 회전율 > 150)")
    void rebalanceSwapCounts() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        run("09:10:05");
        assertThat(assertExempt("N2").path("checkTurnoverPct").asDouble()).isEqualTo(78.7);

        nextCase();
        Slot four = slot(4, 0);
        rebalanceDay(four.prev(), four.prev(), four.now(), four.stops());
        run("09:10:05");
        assertThat(assertExempt("교체 4").path("checkTurnoverPct").asDouble()).isCloseTo(146.56, org.assertj.core.data.Offset.offset(0.05));

        nextCase();
        Slot five = slot(5, 0);
        rebalanceDay(five.prev(), five.prev(), five.now(), five.stops());
        run("09:10:05");
        assertHalted("교체 5", "over-cap");
        assertThat(haltDetail().path("checkTurnoverPct").asDouble()).isCloseTo(159.88, org.assertj.core.data.Offset.offset(0.05));
        assertThat(haltDetail().path("allowancePct").asDouble()).isEqualTo(150.0);
    }

    @Test
    @DisplayName("S1b — 8종목 교체 + 새 종목 K가 09:10 VI: 멈춤 판정도 판정 회전율도 156.5%(K 셈 — QA-949 전에는 멈춤 판정 146.7%) → over-cap, 묶음·주문 없음")
    void rebalanceRestrictedNewNameStillCapped() {
        rebalanceDay(P2, H2, merged(pcts(CASH_LIKE, 1, "A", 9.8, "B", 9.8), each("KLMNOPQR", 9.8)), Set.of());
        restrictions(Set.of(r("K")), null);

        run("09:10:05");

        assertHalted("S1b", "over-cap");
        assertThat(haltDetail().path("turnoverPct").asDouble()).isEqualTo(156.5);
        assertThat(haltDetail().path("checkTurnoverPct").asDouble()).isEqualTo(156.5);
    }

    // QA-949 — 수정 전(재현 커밋에서는 @Disabled): 새 종목 F~I(매수 40%)가 VI라 지금 멈춤 판정이 153130 매도 40%뿐이어서 재선정 예외 판정(열두 확인)을
    // 거치지 않고 묶음을 보냄 — 예외 이벤트 없음('expected size 1 but was 0').
    @Test
    @DisplayName("QA-949: N1(153130 → 종목 넷) 새 종목 넷이 모두 VI — 멈춤 판정 80%(VI 몫 셈)라 재선정 예외 판정으로 가서 보냄, 멈춤 판정과 판정 회전율이 같은 80%(두 번 세지 않음)")
    void rebalanceRestrictedNewNamesGoThroughExemption() {
        rebalanceDay(P1, H1, NOW1, Set.of());
        restrictions(letters("FGHI"), null);

        run("09:10:05");

        JsonNode detail = assertExempt("N1 + 새 종목 넷 VI");
        assertThat(detail.path("turnoverPct").asDouble()).as("멈춤 판정 회전율").isEqualTo(80.0);
        assertThat(detail.path("checkTurnoverPct").asDouble()).as("열두 확인의 판정 회전율 — 제한 종목을 한 번만 셈").isEqualTo(80.0);
        assertThat(sentSummaries()).contains("SELL " + CASH_LIKE + " DAY 4000").noneMatch(o -> o.contains(r("F")) || o.contains(r("G"))
                || o.contains(r("H")) || o.contains(r("I")));
    }

    @Test
    @DisplayName("기본 슬롯 교체 2 + 새 종목 하나 VI — 판정은 그 종목도 세어 예외로 묶음, VI가 풀리면 같은 창 마무리가 그 종목을 삼(회전율 검사 없음)")
    void rebalanceRestrictedNameExemptThenFollowupBuys() {
        Slot s = slot(2, 0);
        rebalanceDay(s.prev(), s.prev(), s.now(), s.stops());
        restrictions(Set.of(fresh15(0)), null);

        run("09:10:05");
        assertExempt("교체 2 + VI");
        assertThat(sentSummaries()).noneMatch(o -> o.contains(fresh15(0)));

        restrictions(Set.of(), null);
        Map<String, String[]> left = new LinkedHashMap<>();
        for (int i = 2; i < 8; i++) {
            left.put(held8(i), new String[]{"666", "1000"});
        }
        Map<String, String> quotes = new LinkedHashMap<>();
        s.now().keySet().forEach(sym -> quotes.put(sym, "1000"));
        preflight("6004000", left, quotes);   // 153130·유지 종목 둘을 판 대금
        run("09:10:40");

        assertThat(sentSummaries()).contains("BUY " + fresh15(0) + " DAY 666");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
    }

    @Test
    @DisplayName("S1d — 앱으로 유지 종목 A·B를 팔고 책 밖 X·Y를 산 날, 넷 다 VI: 계좌 어긋남 39.3%(제한 종목도 셈) → account-drift")
    void rebalanceRestrictedAppTradeHalts() {
        rebalanceDay(P2, merged(minus(H2, "AB"), pcts("X", 10.1, "Y", 9.6)), merged(pcts(CASH_LIKE, 1), each("ABCDEF", 9.8), each("KLMN", 9.8)),
                Set.of());
        restrictions(letters("ABXY"), null);

        run("09:10:05");

        assertHalted("S1d", "account-drift");
        assertThat(haltDetail().path("accountDriftPct").asDouble()).isEqualTo(39.3);
    }

    @Test
    @DisplayName("S7 — 앱이 유지 종목 A·B 전량 매도 주문을 걸어 둠(반대 방향 미체결): 판정에서 빠진 종목 2 → uncounted")
    void rebalanceOppositeAppOrderHalts() {
        rebalanceDay(P2, H2, merged(pcts(CASH_LIKE, 1), each("ABCDEF", 9.8), each("KLMN", 9.8)), Set.of());
        tossOrders(appSell("APP-A", r("A"), "1010"), appSell("APP-B", r("B"), "960"));

        run("09:10:05");

        assertHalted("S7", "uncounted");
        assertThat(haltDetail().path("uncounted").asInt()).isEqualTo(2);
    }

    private static CollectorTradeClient.BrokerOrder appSell(String id, String symbol, String quantity) {
        return new CollectorTradeClient.BrokerOrder(id, symbol, "SELL", "LIMIT", "DAY", "PENDING", d(quantity), d("0"), null, null, null,
                null, kst("2026-11-06T08:40"), null, null, "KRW");
    }

    @Test
    @DisplayName("A5 — 새 종목 F의 실제 시세를 모름(price-missing): 판정에서 빠진 종목 → uncounted")
    void rebalanceNewNamePriceMissingHalts() {
        double nav = 112.0;
        Map<String, Double> now = merged(scaled(NOW1, 100 / nav), pcts("F", 22 * 100 / nav));
        rebalanceDay(P1, H1, now, Set.of());
        Set<String> quoted = new java.util.TreeSet<>(now.keySet());
        rulesAccount(H1, quoted, Set.of(r("F")));

        run("09:10:05");

        assertHalted("A5", "uncounted");
    }

    /**
     * {@link #rulesAccount}와 같되 {@code noUpper} 종목은 현재가만 있고 상한가를 모름(수집기 사전 조회의 {@code upperLimitPrice} null — 상·하한가 칸은
     * 필수가 아님).
     */
    private void rulesAccountNoUpper(Map<String, Double> heldPct, Set<String> quoted, Set<String> noUpper) {
        List<Holding> hs = new ArrayList<>();
        Map<String, Quote> quotes = new LinkedHashMap<>();
        Map<String, BigDecimal> sellable = new LinkedHashMap<>();
        long invested = 0;
        for (Map.Entry<String, Double> e : heldPct.entrySet()) {
            long qty = (long) Math.floor(e.getValue() * 100 + 1e-9);
            hs.add(new Holding(e.getKey(), "합성" + e.getKey(), d(String.valueOf(qty)), d("1000")));
            quotes.put(e.getKey(), new Quote(d("1000"), noUpper.contains(e.getKey()) ? null : d("1300"), null));
            sellable.put(e.getKey(), d(String.valueOf(qty)));
            invested += qty * 1000;
        }
        quoted.stream().filter(s -> !quotes.containsKey(s)).forEach(s -> quotes.put(s, new Quote(d("1000"), noUpper.contains(s) ? null : d("1300"),
                null)));
        when(client.preflight(any(), any())).thenReturn(Reply.of(new Preflight(clock.now, d(String.valueOf(10_000_000L - invested)), hs, quotes,
                sellable)));
    }

    // QA-802 — 상한가를 모르는 매수가 하루 건수 한도에 가려 빠진 종목 수(U)와 하루 한도로 못 내는 매수(D) 모두에서 빠졌다. 수정 전(재현 커밋
    // 25951a84에서는 @Disabled): 예외로 보냄 —
    // 'expected HALTED but was LIVE', 보낸 주문은 'SELL 153130 DAY 4666' 하나(새 종목 매수 일곱은 하루 건수로 미룸, 다음 날은 지금처럼 멈춤).
    @Test
    @DisplayName("QA-802: 기본 슬롯 153130 46.7% → 15종목, 새 종목 일곱 상한가 모름, 남은 하루 건수 1(= 매도 다리 수) → uncounted, 묶음·주문 없음")
    void rebalanceUpperUnknownMaskedByDailyOrdersHalts() {
        Slot s = slot(0, 0);
        rebalanceDay(s.prev(), s.prev(), s.now(), s.stops());
        Set<String> fresh = new java.util.TreeSet<>();
        for (int i = 0; i < 7; i++) {
            fresh.add(fresh15(i));
        }
        rulesAccountNoUpper(s.prev(), s.now().keySet(), fresh);
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 1, 999_999_999L, 999_999_999L)));

        run("09:10:05");

        assertHalted("상한가 모름 + 남은 건수 1", "uncounted");
        assertThat(haltDetail().path("uncounted").asInt()).isEqualTo(7);
        assertThat(haltDetail().path("dailyShortPct").asDouble()).isZero();
    }

    @Test
    @DisplayName("S2·S2d — 하루 한도로 오늘 못 내는 매수가 E의 20%를 넘음(남은 하루 매수 금액 0 / 남은 건수 5) → daily-cap-short, 주문 없음")
    void rebalanceDailyCapShortHalts() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 200, 0L, 999_999_999L)));
        run("09:10:05");
        assertHalted("S2", "daily-cap-short");
        assertThat(haltDetail().path("dailyShortPct").asDouble()).isEqualTo(52.0);

        nextCase();
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 5, 999_999_999L, 999_999_999L)));
        run("09:10:05");
        assertHalted("S2d", "daily-cap-short");
        assertThat(haltDetail().path("dailyShortPct").asDouble()).isEqualTo(39.0);
    }

    // 수정 전(재현 커밋 3b237f2b에서는 @Disabled): 판정은 daily-cap-short로 맞게 멈추지만 HALT detail에 sellsDropped 칸이 없음.
    @Test
    @DisplayName("QA-801: 남은 하루 건수가 매도 다리보다 적음(N2 매도 넷, 남은 건수 3) → daily-cap-short, HALT detail에 밀리는 매도 1")
    void rebalanceDailyCapDroppedSellsRecorded() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 3, 999_999_999L, 999_999_999L)));

        run("09:10:05");

        assertHalted("남은 건수 3", "daily-cap-short");
        assertThat(haltDetail().path("sellsDropped").isNumber()).isTrue();
        assertThat(haltDetail().path("sellsDropped").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("S2c — 남은 하루 매수 금액이 E의 40%: 못 내는 매수 약 12% ≤ 20 → 보냄(그 몫은 다음 거래일 평소 묶음)")
    void rebalanceDailyCapSlackExempt() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 200, 4_000_000L, 999_999_999L)));

        run("09:10:05");

        assertThat(assertExempt("S2c").path("dailyShortPct").asDouble()).isCloseTo(12.0, org.assertj.core.data.Offset.offset(0.05));
    }

    @Test
    @DisplayName("N3b — 결정 전 STOP B(목표 0, 대금은 153130에): 스탑 몫을 빼고 셈 → 보냄")
    void rebalanceStopBeforeDecisionExempt() {
        rebalanceDay(P1, H1, merged(pcts(CASH_LIKE, 15), each("ACDE", 11), each("FGHI", 10)), letters("B"));

        run("09:10:05");

        assertThat(assertExempt("N3b").path("checkTurnoverPct").asDouble()).isEqualTo(69.0);
    }

    @Test
    @DisplayName("N4 — 스탑 경로가 묶음보다 먼저 J를 팖(오늘 스탑 행): 판정 회전율·책 변화량 모두 스탑 대금을 뺀 같은 기준 → 보냄")
    void rebalanceStopSoldBeforeBatchSameBasis() {
        rebalanceDay(P2, minus(H2, "J"), merged(pcts(CASH_LIKE, 10.8), each("ABCDE", 9.8), each("KLMN", 10)), letters("J"));
        executor.send(new RealTradeExecutor.Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 701L, 701L, r("J"), "SELL", 960, "DAY",
                d("1020.8333"), 1), cfg());   // 스탑 매도 접수(진행 중) — 대금 약 980,000원 = E의 9.8%

        run("09:10:05");

        JsonNode detail = assertExempt("N4");
        assertThat(detail.path("checkTurnoverPct").asDouble()).isCloseTo(79.1, org.assertj.core.data.Offset.offset(0.05));
        assertThat(detail.path("bookDriftPct").asDouble()).isCloseTo(79.2, org.assertj.core.data.Offset.offset(0.05));
    }

    @Test
    @DisplayName("E1b — 지난 세션 STOP A·B(어제 팔림, 장부는 대기) + 다섯 교체: 교차 확인은 스탑 감소만 뺀 B°(120) 기준 → 보냄")
    void rebalanceStaleStopSoldYesterdayExempt() {
        rebalanceDay(merged(pcts(CASH_LIKE, 29), each("ABCDEFG", 10)), merged(pcts(CASH_LIKE, 28.5), each("CDEFG", 10)),
                merged(pcts(CASH_LIKE, 49), each("HIJKL", 10)), letters("AB"));

        run("09:10:05");

        JsonNode detail = assertExempt("E1b");
        assertThat(detail.path("checkTurnoverPct").asDouble()).isEqualTo(120.5);
        assertThat(detail.path("bookDriftPct").asDouble()).isEqualTo(100.0);
        assertThat(detail.path("allowancePct").asDouble()).isEqualTo(140.0);
    }

    @Test
    @DisplayName("기본 슬롯 교체 2 + 결정 뒤 반영된 STOP 하나 — 목표 합 93.3% ≥ 90 → 보냄")
    void rebalanceReflectedStopAfterDecision() {
        Slot s = slot(2, 1);
        rebalanceDay(s.prev(), s.prev(), s.now(), s.stops());

        run("09:10:05");

        assertThat(assertExempt("STOP 하나").path("investedPct").asDouble()).isCloseTo(93.33, org.assertj.core.data.Offset.offset(0.01));
    }

    @Test
    @DisplayName("기본 슬롯 교체 2 + 결정 뒤 반영된 STOP 둘 — 목표 합 86.7%(크레딧 없음) → targets-thin")
    void rebalanceReflectedStopsAfterDecisionHalt() {
        Slot s = slot(2, 2);
        rebalanceDay(s.prev(), s.prev(), s.now(), s.stops());

        run("09:10:05");

        assertHalted("STOP 둘", "targets-thin");
        assertThat(haltDetail().path("investedPct").asDouble()).isCloseTo(86.67, org.assertj.core.data.Offset.offset(0.01));
    }

    @Test
    @DisplayName("S4b — 09:10 목표에 반영 안 된 감시 STOP 다섯 + 153130 미매수: 목표 합 88.4% → targets-thin")
    void rebalanceUnreflectedWatchStopsIdleCashHalts() {
        Map<String, Double> held = merged(pcts(CASH_LIKE, 44.0), each("ABCDE", 11 * 0.88));
        double sum = held.values().stream().mapToDouble(Double::doubleValue).sum();
        rebalanceDay(P1, scaled(held, 100 / sum), merged(each("ABCDE", 11 * 0.88), each("FGHI", 10)), letters("ABCDE"));

        run("09:10:05");

        assertHalted("S4b", "targets-thin");
        assertThat(haltDetail().path("investedPct").asDouble()).isEqualTo(88.4);
    }

    @Test
    @DisplayName("N1 예외 묶음의 매수가 현금 부족으로 미뤄짐 — 153130 매도 대금이 들어온 뒤 같은 창 마무리가 매수를 보냄(회전율 검사 없음). QA-1018: 현금이 "
            + "모자란 매수는 줄여 보내지 않고 미뤄 온전한 수량으로 — 다만 마지막 종목은 상한가로 잡는 현금 때문에 여전히 줄어들고, 그 주문이 체결되면 그날 닫힘")
    void rebalanceExemptFollowupSendsDeferredBuys() {
        rebalanceDay(P1, H1, NOW1, Set.of());

        run("09:10:05");
        assertExempt("N1");
        // 남은 현금 120,000원으로는 F(목표 1,000주)를 92주만 살 수 있음 — 같은 계획이 153130을 팔므로 줄여 보내지 않고 G·H·I(1주도 못 삼)와 함께 미룸
        // (QA-1018 — 수정 전에는 BUY F DAY 92가 이 주기에 나갔고, 그 92주가 체결되면 F는 그날 닫혀 나머지 908주를 사지 못했음)
        assertThat(sentSummaries()).containsExactly("SELL " + CASH_LIKE + " DAY 4000");

        Map<String, String[]> after = new LinkedHashMap<>();
        H1.forEach((sym, pct) -> after.put(sym, new String[]{sym.equals(CASH_LIKE) ? "400" : String.valueOf((long) Math.floor(pct * 100 + 1e-9)),
                "1000"}));
        Map<String, String> quotes = new LinkedHashMap<>();
        NOW1.keySet().forEach(sym -> quotes.put(sym, "1000"));
        // 153130 4,000주 매도가 체결로 끝나 대금이 들어옴
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", CASH_LIKE, "SELL", "DAY", "FILLED", "4000", "4000", clock.now, clock.now)));
        preflight("4120000", after, quotes);
        run("09:10:40");

        // F·G·H는 온전한 1,000주. 남는 한계(ADR 0028 덧붙임 QA-1018): 매수는 상한가(1,300원)로 현금을 잡으므로 셋이 390만 원을 잡으면 I에는 22만 원 —
        // 진행 중인 매도가 더 없으니 지금처럼 줄여 169주(수정 전에는 F가 92주, 이제는 I가 169주)
        List<String> sent = List.of("SELL " + CASH_LIKE + " DAY 4000", "BUY " + r("F") + " DAY 1000", "BUY " + r("G") + " DAY 1000",
                "BUY " + r("H") + " DAY 1000", "BUY " + r("I") + " DAY 169");
        assertThat(sentSummaries()).containsExactlyElementsOf(sent);
        assertThat(events("HALT")).isEmpty();

        // 네 매수가 기준가로 체결돼 끝난 다음 주기 — I의 시도 1이 169주 전량 체결로 닫혀, 현금 951,000원이 남아도 나머지 831주는 그날 나가지 않음
        int id = 2;
        for (String bought : List.of("F", "G", "H", "I")) {
            String qty = bought.equals("I") ? "169" : "1000";
            String toss = "T-" + id++;
            when(client.order(toss)).thenReturn(Reply.of(broker(toss, r(bought), "BUY", "DAY", "FILLED", qty, qty, clock.now, clock.now)));
            after.put(r(bought), new String[]{qty, "1000"});
        }
        preflight("951000", after, quotes);
        run("09:11:15");

        assertThat(sentSummaries()).as("줄여 보낸 I는 다시 사지 않음").containsExactlyElementsOf(sent);
        assertThat(store.recentOrders("KR", 10)).filteredOn(row -> row.symbol().equals(r("I"))).singleElement()
                .satisfies(row -> assertThat(row.terminal()).isTrue());
        assertThat(events("HALT")).isEmpty();
    }

    @Test
    @DisplayName("QA-1018: N1 예외 묶음 — 153130 매도가 진행 중인 주기에는 현금이 모자란 마지막 매수를 줄여 보내지 않고 미루고, 매도가 끝난 주기에 보냄. "
            + "그때도 상한가로 잡는 현금 때문에 온전한 수량은 아님(앞 매수들이 체결된 뒤라 861주)")
    void rebalanceExemptFollowupDefersTheLastBuyWhileTheSellIsInFlight() {
        rebalanceDay(P1, H1, NOW1, Set.of());

        run("09:10:05");
        assertExempt("N1");
        assertThat(sentSummaries()).containsExactly("SELL " + CASH_LIKE + " DAY 4000");

        // 대금은 매수 가능 금액에 보이지만 153130 매도 행은 아직 진행 중(상태 조회 전) — F·G·H는 온전히, 22만 원으로 169주뿐인 I는 줄이지 않고 미룸
        Map<String, String[]> after = new LinkedHashMap<>();
        H1.forEach((sym, pct) -> after.put(sym, new String[]{sym.equals(CASH_LIKE) ? "400" : String.valueOf((long) Math.floor(pct * 100 + 1e-9)),
                "1000"}));
        Map<String, String> quotes = new LinkedHashMap<>();
        NOW1.keySet().forEach(sym -> quotes.put(sym, "1000"));
        preflight("4120000", after, quotes);
        run("09:10:40");
        assertThat(sentSummaries()).containsExactly("SELL " + CASH_LIKE + " DAY 4000", "BUY " + r("F") + " DAY 1000", "BUY " + r("G") + " DAY 1000",
                "BUY " + r("H") + " DAY 1000");

        // 매도와 F·G·H 매수가 기준가로 체결돼 끝남(현금 4,120,000 − 3,000,000) — 진행 중인 매도가 없으니 I를 지금처럼 줄여 보냄: 1,120,000 ÷ 1,300 = 861주
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", CASH_LIKE, "SELL", "DAY", "FILLED", "4000", "4000", clock.now, clock.now)));
        int id = 2;
        for (String bought : List.of("F", "G", "H")) {
            String toss = "T-" + id++;
            when(client.order(toss)).thenReturn(Reply.of(broker(toss, r(bought), "BUY", "DAY", "FILLED", "1000", "1000", clock.now, clock.now)));
            after.put(r(bought), new String[]{"1000", "1000"});
        }
        preflight("1120000", after, quotes);
        run("09:11:15");
        assertThat(sentSummaries()).containsExactly("SELL " + CASH_LIKE + " DAY 4000", "BUY " + r("F") + " DAY 1000", "BUY " + r("G") + " DAY 1000",
                "BUY " + r("H") + " DAY 1000", "BUY " + r("I") + " DAY 861");
        assertThat(events("HALT")).isEmpty();
    }

    @Test
    @DisplayName("U1·U2a·U2b — 앱 매매(153130 → X)·출금·입금 50: 계좌 어긋남 88 / 86.9 / 33.1 → account-drift, 주문·묶음 없음")
    void rebalanceAccountDriftHalts() {
        rebalanceDay(P1, merged(pcts("X", 44), minus(H1, CASH_LIKE)), NOW1, Set.of());
        run("09:10:05");
        assertHalted("U1", "account-drift");
        assertThat(haltDetail().path("accountDriftPct").asDouble()).isEqualTo(88.0);

        nextCase();
        rebalanceDay(P1, scaled(minus(H1, CASH_LIKE), 100.0 / 56), NOW1, Set.of());
        run("09:10:05");
        assertHalted("U2a 출금", "account-drift");
        assertThat(haltDetail().path("accountDriftPct").asDouble()).isCloseTo(86.86, org.assertj.core.data.Offset.offset(0.05));

        nextCase();
        rebalanceDay(P1, scaled(H1, 100.0 / 150), NOW1, Set.of());
        run("09:10:05");
        assertHalted("U2b 입금", "account-drift");
        assertThat(haltDetail().path("accountDriftPct").asDouble()).isCloseTo(33.13, org.assertj.core.data.Offset.offset(0.05));
    }

    @Test
    @DisplayName("U3a·E2·S5b·스탑 종목뿐 — 후보 0(153130 99)·모두 팔기 + 현금 잔차·0.3% 잔여 종목·대기 STOP 종목만 남은 모두 팔기 → no-names")
    void rebalanceNoNamesHalts() {
        rebalanceDay(P1, H1, pcts(CASH_LIKE, 99), Set.of());
        run("09:10:05");
        assertHalted("U3a", "no-names");

        nextCase();
        rebalanceDay(pcts(CASH_LIKE, 70, "A", 29), pcts(CASH_LIKE, 67, "A", 29), pcts(CASH_LIKE, 99), Set.of());
        run("09:10:05");
        assertHalted("E2", "no-names");

        nextCase();
        rebalanceDay(merged(pcts(CASH_LIKE, 69), each("ABC", 10)), merged(pcts(CASH_LIKE, 66.0), each("ABC", 10), pcts("Z", 0.3)),
                pcts(CASH_LIKE, 99.4, "Z", 0.3), Set.of());
        run("09:10:05");
        assertHalted("S5b", "no-names");
        assertThat(haltDetail().path("stockNames").asInt()).isZero();

        // 지금 목표의 주식 종목이 대기 STOP 종목(09:10 목표에 반영 안 된 감시 STOP A)뿐인 '모두 팔기' — 스탑 종목은 N에 들지 않음(다른 확인은 지남)
        nextCase();
        rebalanceDay(pcts(CASH_LIKE, 32, "A", 30, "B", 28), pcts(CASH_LIKE, 32, "A", 30, "B", 28), pcts(CASH_LIKE, 70, "A", 30), letters("A"));
        run("09:10:05");
        assertHalted("스탑 종목뿐", "no-names");
        assertThat(haltDetail().path("stockNames").asInt()).isZero();
        assertThat(haltDetail().path("checkTurnoverPct").asDouble()).isEqualTo(66.0);
        assertThat(haltDetail().path("deriskPct").asDouble()).isEqualTo(28.0);
    }

    @Test
    @DisplayName("E3 넷 순감(153130 40.2) — 노출 감소 39.2%p > 30 → derisk-over; 책 가격이 빠진 목표 종목 → value-unknown(모르면 지금처럼 멈춤)")
    void rebalanceDeriskAndUnknownValueHalt() {
        rebalanceDay(P2, P2, merged(pcts(CASH_LIKE, 40.2), each("ABCDEF", 9.8)), Set.of());
        run("09:10:05");
        assertHalted("E3", "derisk-over");
        assertThat(haltDetail().path("deriskPct").asDouble()).isEqualTo(39.2);
        assertThat(haltDetail().path("checkTurnoverPct").asDouble()).isEqualTo(78.4);

        // 판정 경로가 책 가격(OpenTargets.price)을 측정에 넘기는지 — 한 종목의 책 가격이 빠지면 가격 배율을 셀 수 없어 value-unknown(그 칸은 넣지 않음)
        nextCase();
        rebalanceDay(P1, H1, NOW1, Set.of());
        Map<String, Double> price = new java.util.HashMap<>();
        NOW1.keySet().forEach(sym -> price.put(sym, 1000.0));
        price.remove(r("F"));
        when(paper.targetsAt(BOOK, SESSION, SYNC_AT)).thenReturn(Optional.of(new OpenTargets(BOOK, SESSION, NOW1, price, 1e7, 0, List.of(),
                List.of(), List.of())));
        run("09:10:05");
        assertHalted("책 가격 빠짐", "value-unknown");
        assertThat(haltDetail().path("priceRatio").isMissingNode()).isTrue();
        assertThat(haltDetail().path("checkTurnoverPct").asDouble()).isEqualTo(80.0);
    }

    @Test
    @DisplayName("U3d·A2 — 153130을 놀리는 현금으로(목표 합 75) / 결정 전 STOP B·C + 놀리는 현금(73) → targets-thin")
    void rebalanceIdleCashTargetsHalts() {
        rebalanceDay(P1, H1, merged(each("ABCDE", 11), each("FG", 10)), Set.of());
        run("09:10:05");
        assertHalted("U3d", "targets-thin");
        assertThat(haltDetail().path("investedPct").asDouble()).isEqualTo(75.0);

        nextCase();
        rebalanceDay(P1, H1, merged(each("ADE", 11), each("FGHI", 10)), letters("BC"));
        run("09:10:05");
        assertHalted("A2", "targets-thin");
        assertThat(haltDetail().path("investedPct").asDouble()).isEqualTo(73.0);
    }

    @Test
    @DisplayName("S3b — 새 종목 1.2배씩·책 현금 음수(목표 합 107) → targets-over")
    void rebalanceBookCashNegativeHalts() {
        rebalanceDay(P1, H1, merged(pcts(CASH_LIKE, 4), each("ABCDE", 11), each("FGHI", 12)), Set.of());

        run("09:10:05");

        assertHalted("S3b", "targets-over");
        assertThat(haltDetail().path("investedPct").asDouble()).isEqualTo(107.0);
    }

    @Test
    @DisplayName("U4a·A1 책 가격 10배 / 작은 비중의 1/100 → price-mismatch, U4b·A4·기본 슬롯 이중 체결 → name-jump, A1b 책 수량 1/10 → name-cut")
    void rebalanceBookErrorsHalt() {
        double navq = 100 - 11 + 110 + 1;
        Map<String, Double> u4a = merged(scaled(NOW1, 100 / navq), pcts("C", 110 * 100 / navq));
        rebalanceDay(P1, H1, u4a, Set.of());
        rulesTargets(u4a, Map.of(r("C"), 10_000.0));
        run("09:10:05");
        assertHalted("U4a", "price-mismatch");
        assertThat(haltDetail().path("priceRatio").asDouble()).isEqualTo(10.0);

        nextCase();
        double navA = 100 - 11 + 0.11;
        Map<String, Double> a1 = merged(scaled(NOW1, 100 / navA), pcts("C", 0.11 * 100 / navA));
        rebalanceDay(P1, H1, a1, Set.of());
        rulesTargets(a1, Map.of(r("C"), 10.0));
        run("09:10:05");
        assertHalted("A1", "price-mismatch");

        nextCase();
        double navb = 100 - 11 + 55;
        rebalanceDay(P1, H1, merged(scaled(NOW1, 100 / navb), pcts("C", 55 * 100 / navb)), Set.of());
        run("09:10:05");
        assertHalted("U4b", "name-jump");

        nextCase();
        rebalanceDay(P1, H1, merged(NOW1, pcts("F", 20)), Set.of());
        run("09:10:05");
        assertHalted("A4", "name-jump");

        nextCase();
        Slot ten = slot(2, 0);
        Map<String, Double> doubled = new java.util.TreeMap<>(ten.now());
        for (int i = 4; i < 9; i++) {
            doubled.remove(fresh15(i));   // 후보 10개(유지 6 + 새 종목 4) — 153130이 남음
        }
        doubled.put(fresh15(0), SLOT * 2);   // 새 종목 하나 이중 체결 — 153130이 그만큼 줆
        doubled.put(CASH_LIKE, 100 - doubled.values().stream().mapToDouble(Double::doubleValue).sum());
        rebalanceDay(ten.prev(), ten.prev(), doubled, Set.of());
        run("09:10:05");
        assertHalted("기본 슬롯 이중 체결", "name-jump");
        assertThat(haltDetail().path("nameJumpPct").asDouble()).isCloseTo(13.33, org.assertj.core.data.Offset.offset(0.01));

        nextCase();
        double nav = 100 - 11 + 1.1;
        rebalanceDay(P1, H1, merged(scaled(NOW1, 100 / nav), pcts("C", 1.1 * 100 / nav)), Set.of());
        run("09:10:05");
        assertHalted("A1b", "name-cut");
    }

    @Test
    @DisplayName("U5' 매수 멈춤 중 매도만 60% 초과 → buys-paused, A3 형식 밖 종목의 앱 매수 대기 → buys-unpriced — 둘 다 결정을 읽지 않음")
    void rebalanceBuyGatesHalt() {
        rebalanceDay(P1, H1, merged(pcts(CASH_LIKE, 4), each("ABC", 11), each("FGHI", 10)), Set.of());
        store.lockConfig("KR", current -> store.updateConfig(current.withBuysPaused(true), null));
        run("09:10:05");
        assertHalted("U5'", "buys-paused");
        assertThat(haltDetail().path("checkTurnoverPct").isMissingNode()).isTrue();
        verify(paper, never()).decisionState(anyString(), any());

        nextCase();
        rebalanceDay(P1, H1, merged(pcts(CASH_LIKE, 26), each("ABC", 11), each("FGHI", 10)), Set.of());
        tossOrders(appBuy("APP-ODD", ODD, "LIMIT", "10", "0"));
        run("09:10:05");
        assertHalted("A3", "buys-unpriced");
        verify(paper, never()).decisionState(anyString(), any());
    }

    @Test
    @DisplayName("앞 거래일 결정이 SCHEDULED·OK면 no-rebalance(결정 종류 코드와 함께)")
    void scheduledDecisionStillHalts() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        decision("SCHEDULED", "OK");

        run("09:10:05");

        assertHalted("SCHEDULED", "no-rebalance");
        assertThat(haltDetail().path("decisionKind").asString()).isEqualTo("SCHEDULED");
        assertThat(haltDetail().path("decisionStatus").asString()).isEqualTo("OK");
    }

    @Test
    @DisplayName("REBALANCE인데 NO_TRADE·SKIPPED, 결정 행 없음, 결정 상태를 못 읽음(empty), INITIAL·OK → 모두 no-rebalance")
    void rebalanceNotOkStillHalts() {
        String[][] cases = {{"REBALANCE", "NO_TRADE"}, {"REBALANCE", "SKIPPED"}, {null, null}, {"INITIAL", "OK"}};
        for (String[] c : cases) {
            nextCase();
            rebalanceDay(P2, H2, NOW_N2, Set.of());
            decision(c[0], c[1]);
            run("09:10:05");
            assertHalted(c[0] + "·" + c[1], "no-rebalance");
        }
        nextCase();
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        when(paper.decisionState(BOOK, DECISION_DAY)).thenReturn(Optional.empty());
        run("09:10:05");
        assertHalted("empty", "no-rebalance");
    }

    @Test
    @DisplayName("앞 묶음이 D 세션이 아님(D−1)·다른 책·없음 → prior-batch")
    void rebalancePriorBatchMismatchHalts() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        RealTradeFixtures.clean(jdbc);
        RealTradeFixtures.live(store, false, d("10000000"));
        priorBatch(DECISION_DAY.minusDays(1), P2);
        run("09:10:05");
        assertHalted("D−1", "prior-batch");

        nextCase();
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        RealTradeFixtures.clean(jdbc);
        RealTradeFixtures.live(store, false, d("10000000"));
        store.upsertBatch("KR", DECISION_DAY, RealTradeStore.BATCH_SYNC, "kr_claude", RealTradeFixtures.MAPPER.valueToTree(P2), List.of(),
                d("10000000"));
        run("09:10:05");
        assertHalted("다른 책", "prior-batch");

        nextCase();
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        RealTradeFixtures.clean(jdbc);
        RealTradeFixtures.live(store, false, d("10000000"));
        run("09:10:05");
        assertHalted("없음", "prior-batch");
    }

    @Test
    @DisplayName("모의 달력이 결정일 앞을 모름 → calendar-unknown(결정을 읽지 않음)")
    void rebalanceUnknownCalendarHalts() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        when(paper.sessionHours(DECISION_DAY)).thenReturn(Optional.empty());

        run("09:10:05");

        assertHalted("달력 모름", "calendar-unknown");
        verify(paper, never()).decisionState(anyString(), any());
    }

    @Test
    @DisplayName("Claude 책은 그대로 — REBALANCE·OK가 있어도 결정을 읽지 않고, HALT detail은 지금처럼 reason·turnoverPct뿐")
    void rebalanceForClaudeBookUnchanged() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        when(paper.book(BOOK)).thenReturn(Optional.of(book(GENERATION)));   // kind CLAUDE

        run("09:10:05");

        assertThat(cfg().state()).isEqualTo("HALTED");
        List<String> fields = new ArrayList<>();
        haltDetail().propertyNames().forEach(fields::add);
        assertThat(fields).containsExactlyInAnyOrder("reason", "turnoverPct");
        verify(paper, never()).decisionState(anyString(), any());
    }

    @Test
    @DisplayName("판정 오류 — 결정 읽기가 던지면 그 주기는 묶음·멈춤 없이 건너뜀(같은 주기 스탑 매도는 나감), 30초 뒤에도 던지면 '준비 안 됨' 알림 하나, 풀리면 예외 묶음")
    void rebalanceCheckErrorSkipsCycleAndNotifies() {
        Slot s = slot(2, 0);
        Map<String, Double> held = new java.util.TreeMap<>(s.prev());
        held.put(r("S"), 5.0);   // 대기 STOP 종목(목표 밖) — 장중 스탑 매도 경로가 팖
        rebalanceDay(s.prev(), held, s.now(), letters("S"));
        when(paper.dueOrders(anyString(), any(), any())).thenReturn(List.of(stopDue(901, r("S"), "AT_MINUTE", SYNC_AT)));
        when(paper.decisionState(BOOK, DECISION_DAY)).thenThrow(new IllegalStateException("합성 오류"));

        run("09:10:05");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        assertThat(sentSummaries()).containsExactly("SELL " + r("S") + " DAY 500");
        assertThat(events("UNAVAILABLE")).as("첫 실패는 시각만").isEmpty();

        run("09:10:35");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        assertThat(events("UNAVAILABLE")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("reason").asString()).isEqualTo("rebalance-check-unavailable");
            assertThat(e.notifies()).isTrue();
        });

        org.mockito.Mockito.doReturn(Optional.of(new PaperMirrorService.DecisionState(DECISION_DAY, 77L, "REBALANCE", "OK",
                kst("2026-11-06T01:00")))).when(paper).decisionState(BOOK, DECISION_DAY);
        run("09:11:05");
        assertExempt("오류 뒤");
        assertThat(events("UNAVAILABLE")).hasSize(1);

        run("09:14");   // 창 뒤 요약 — 건너뜀 사유에 판정 오류
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e ->
                assertThat(e.detail().path("reasons").path("rebalance-check-error").asInt()).isEqualTo(1));
    }

    @Test
    @DisplayName("한 번만 — 예외 묶음 다음 세션(앞 거래일 결정 SCHEDULED)에 남은 몫이 60%를 넘으면 지금처럼 멈춤(no-rebalance)")
    void rebalanceExemptionIsOneShot() {
        // 어제(D) 예외 묶음이 남긴 목표 그대로, 오늘(D+1 = 세션)은 정기 결정 SCHEDULED — 남은 몫(종목 매수 70%)이 아직 안 나감
        Map<String, Double> target = merged(pcts(CASH_LIKE, 30), each("KLMNOPQ", 10));
        rebalanceDay(target, pcts(CASH_LIKE, 100.0), target, Set.of());
        decision("SCHEDULED", "OK");

        run("09:10:05");

        assertHalted("다음 세션", "no-rebalance");
        assertThat(haltDetail().path("turnoverPct").asDouble()).isEqualTo(140.0);
    }

    @Test
    @DisplayName("sync_pending 남은 몫 묶음이 목표 변화량 > 60(RT2-1)으로 멈출 사례가 재선정 다음 묶음이면 — 예외로 보냄, 예외 묶음이라 sync_pending 끔(QA-803)")
    void rebalanceAfterLeftoverDriftHalt() {
        rebalanceDay(P2, H2, NOW_N2, Set.of());
        RealTradeFixtures.clean(jdbc);
        enableEvent();
        priorBatch(DECISION_DAY, P2);
        RealTradeFixtures.live(store, true, d("10000000"));

        run("09:10:05");

        assertExempt("남은 몫 뒤 재선정");
        // 이 묶음에도 남은 몫(현금 부족으로 미룬 매수)이 있고 켠 뒤 두 번째 묶음이지만 예외로 보낸 묶음이라 끔(QA-803 — 다음 날 남은 몫이 60%를 넘으면 지금처럼 멈춤).
        // 예외 전에는 '켠 채'(세 번째 묶음까지 유지)를 단언했다.
        assertThat(cfg().syncPending()).isFalse();
    }

    // QA-803 — sync_pending이 켜진 채 들어온 재선정 묶음이 예외로 나가면 잠금 안 keep(= sync_pending ∧ 남은 몫 ∧ 켠 뒤 세 번째 묶음 전)이 참이라 sync_pending이
    // 그대로 켜져 있고, 다음 날 turnoverHalt가 앞 묶음(= 예외 묶음)과의 목표 변화량(≈ 0)만 보아 회전율 60%를 넘는 남은 몫이 열두 확인 없이 나갔다(계획 3-6
    // 셋째 줄·명세 §12.2 '다음 날까지 남은 몫이 60%를 넘으면 지금처럼 멈춘다(이어 주기 없음)'와 어긋남).
    // 수정 전(재현 커밋 5d7fc8c9에서는 @Disabled): S 묶음 로그 '(남은 몫 — 회전율 예외 유지)', S+1 로그 '남은 몫 묶음 — 회전율 119.92%지만 목표 변화량
    // 0.00%라 회전율 예외 유지'로 주문 4건이 나가
    // 'expected: "HALTED" but was: "LIVE"'(그날 관찰 로그의 계좌 어긋남 119.92% — 열두 확인을 봤다면 account-drift), 그 묶음에서 sync_pending 꺼짐(세 번째 묶음).
    @Test
    @DisplayName("QA-803: sync_pending이 켜진 채 재선정 예외 묶음(S) → 예외 잠금에서 sync_pending 끔 → S+1(결정 SCHEDULED)의 남은 몫 회전율 > 60이면 지금처럼 멈춤")
    void rebalanceExemptTurnsOffSyncPendingSoLeftoverHaltsNextDay() {
        // 단계 S = 2026-11-05(목) — 앞 거래일 11-04가 재선정 결정일. 켬(ENABLE) → 11-04 묶음(켠 뒤 첫 묶음, 남은 몫으로 sync_pending 유지) → 11-05 예외 묶음
        LocalDate stepDay = DECISION_DAY;
        LocalDate stepDecision = DECISION_DAY.minusDays(1);
        Instant stepSyncAt = kst("2026-11-05T09:10");
        Slot s = slot(2, 0);
        enableEvent();
        priorBatch(stepDecision, s.prev());
        RealTradeFixtures.live(store, true, d("10000000"));
        rulesBook();
        when(paper.sessionHours(stepDecision)).thenReturn(Optional.of(new SessionHours(stepDecision, true, kst("2026-11-04T09:00"),
                kst("2026-11-04T15:30"))));
        when(paper.decisionState(BOOK, stepDecision)).thenReturn(Optional.of(new PaperMirrorService.DecisionState(stepDecision, 76L, "REBALANCE",
                "OK", kst("2026-11-05T01:00"))));
        when(paper.ledgerCaughtUp(BOOK, stepDay)).thenReturn(true);
        Map<String, Double> price = new java.util.HashMap<>();
        s.now().keySet().forEach(sym -> price.put(sym, 1000.0));
        when(paper.dailySyncAt(BOOK, stepDay)).thenReturn(Optional.of(stepSyncAt));
        when(paper.targetsAt(BOOK, stepDay, stepSyncAt)).thenReturn(Optional.of(new OpenTargets(BOOK, stepDay, s.now(), price, 1e7, 0, List.of(),
                List.of(), List.of())));
        when(paper.pendingStopSymbols(BOOK, stepDay)).thenReturn(Set.of());
        when(client.calendar()).thenReturn(Reply.of(new CollectorTradeClient.Calendar(stepDay, 0.3, new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-05T08:00"), kst("2026-11-05T08:50"), kst("2026-11-05T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-05T09:00"), kst("2026-11-05T15:20"), kst("2026-11-05T15:30"))),
                stepDecision, SESSION)));
        Set<String> quoted = new java.util.TreeSet<>(s.now().keySet());
        quoted.addAll(s.prev().keySet());
        clock.set(kst("2026-11-05T09:10:05"));
        rulesAccount(s.prev(), quoted, Set.of());
        job.cycle(clock.now);

        assertThat(events("TURNOVER_EXEMPT")).as("S — 재선정 예외 묶음").hasSize(1);
        assertThat(store.batch("KR", stepDay, RealTradeStore.BATCH_SYNC)).isPresent();
        assertThat(store.ordersOn("KR", stepDay)).isNotEmpty();
        assertThat(cfg().state()).isEqualTo("LIVE");

        // S의 주문은 체결 없이 끝남(남은 몫 그대로 — 153130·유지 종목 둘 매도와 새 종목 매수 전부)
        store.unfinishedOrders("KR").forEach(row -> store.recordTracking(row.id(), new RealTradeStore.Tracking("CANCELED", true, d("0"), null, null,
                null, null, null)));

        // 단계 S+1 = 2026-11-06(금) — 앞 거래일 11-05의 정기 결정은 SCHEDULED, 목표는 S와 같음(남은 몫 회전율 약 120%)
        decision("SCHEDULED", "OK");
        when(client.calendar()).thenReturn(Reply.of(calendar(normalSession(), 0.3)));
        rulesTargets(s.now(), Map.of());
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenReturn(Set.of());
        clock.set(kst("2026-11-06T09:10:05"));
        rulesAccount(s.prev(), quoted, Set.of());
        run("09:10:05");

        assertThat(cfg().state()).as("S+1 — 남은 몫 회전율 > 60").isEqualTo("HALTED");
        assertThat(cfg().haltReason()).isEqualTo("turnover");
        assertThat(haltDetail().path("rebalanceCheck").asString()).isEqualTo("no-rebalance");
        assertThat(haltDetail().path("turnoverPct").asDouble()).isGreaterThan(60.0);
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isEmpty();
        assertThat(store.ordersOn("KR", SESSION)).isEmpty();
        assertThat(events("TURNOVER_EXEMPT")).hasSize(1);
        assertThat(cfg().syncPending()).as("예외 묶음을 만든 잠금에서 끔").isFalse();
    }

    // QA-803 회귀 — 커밋된 재현 시험은 시각 맞추기 날(마무리 창이 묶음을 만드는 길)만 본다. 시가 날 창 끝 − 60초 뒤에 시작해 주문 없이(send=false) 만든
    // 예외 묶음도 같은 잠금에서 sync_pending을 끄고, 마무리는 그 묶음의 남은 몫을 회전율 검사 없이 메운다(2026-11-19 두 번째 반박 확인이 고친 줄을 되돌린
    // 사본에서 실패를 본 경로 R1).
    @Test
    @DisplayName("QA-803: 시가 날 창 끝 뒤(send=false)로 만든 재선정 예외 묶음도 sync_pending을 끄고, 마무리는 멈춤 없이 메움")
    void rebalanceExemptLateStartWithoutSendTurnsOffSyncPending() {
        rebalanceDay(P1, H1, NOW1, Set.of());
        RealTradeFixtures.clean(jdbc);
        enableEvent();
        priorBatch(DECISION_DAY, P1);
        RealTradeFixtures.live(store, true, d("10000000"));
        Map<String, Double> price = new java.util.HashMap<>();
        NOW1.keySet().forEach(sym -> price.put(sym, 1000.0));
        when(paper.dailySyncAt(BOOK, SESSION)).thenReturn(Optional.empty());
        when(paper.openTargets(BOOK, SESSION)).thenReturn(Optional.of(new OpenTargets(BOOK, SESSION, NOW1, price, 1e7, 0, List.of(), List.of())));

        run("08:57:40");

        verify(client, never()).placeOrder(anyString());
        assertExempt("send=false");
        assertThat(cfg().syncPending()).as("send=false 예외 묶음 — 끔").isFalse();

        run("09:00:40");

        assertThat(sentSummaries()).isNotEmpty();
        assertThat(events("HALT")).isEmpty();
        assertThat(events("TURNOVER_EXEMPT")).hasSize(1);
        assertThat(cfg().syncPending()).isFalse();
    }

    @Test
    @DisplayName("관찰 로그 — 회전율 60% 안의 평소 규칙 계좌 묶음은 측정이 실패해도(대기 STOP 읽기가 던짐) 묶음·주문이 그대로 나감")
    void observationLogDoesNotChangeBatch() {
        Slot s = slot(0, 0);
        Map<String, Double> calm = new java.util.TreeMap<>(s.prev());
        calm.put(held8(0), SLOT + 2);   // 평소 날 — 한 종목만 2%p 늘림(153130에서)
        calm.put(CASH_LIKE, s.prev().get(CASH_LIKE) - 2);
        rebalanceDay(s.prev(), s.prev(), calm, Set.of());
        when(paper.pendingStopSymbols(BOOK, SESSION)).thenThrow(new IllegalStateException("합성 오류")).thenReturn(Set.of());

        run("09:10:05");

        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(events("TURNOVER_EXEMPT")).isEmpty();
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
        // 매도만 — 매수(200주)는 남은 현금(6,000원)으로 4주뿐이라 같은 계획의 153130 매도 대금을 기다림(QA-1018 — 수정 전에는 BUY 4주도 이 주기에 나감)
        assertThat(sentSummaries()).containsExactly("SELL " + CASH_LIKE + " DAY 200");
        verify(paper, never()).decisionState(anyString(), any());

        // 매도가 체결로 끝나 대금이 들어온 다음 주기 — 매수 직전 대기 STOP 읽기(두 번째 부름)는 정상이라 그대로 나감. 매수는 상한가(1,300원)로 현금을
        // 잡으므로 206,000원으로는 200주가 아니라 158주
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", CASH_LIKE, "SELL", "DAY", "FILLED", "200", "200", clock.now, clock.now)));
        Map<String, Double> sold = new java.util.TreeMap<>(s.prev());
        sold.put(CASH_LIKE, s.prev().get(CASH_LIKE) - 2);
        rulesAccount(sold, calm.keySet(), Set.of());
        run("09:10:40");

        assertThat(sentSummaries()).containsExactly("SELL " + CASH_LIKE + " DAY 200", "BUY " + held8(0) + " DAY 158");
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
        assertThat(events("TURNOVER_EXEMPT")).isEmpty();
        verify(paper, never()).decisionState(anyString(), any());
    }
}
