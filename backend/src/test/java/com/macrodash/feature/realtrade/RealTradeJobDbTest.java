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
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150", "BUY " + A + " DAY 32");
        Batch batch = store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC).orElseThrow();
        assertThat(batch.absorbedOrderIds()).containsExactly(21L, 22L);
        assertThat(store.recentOrders("KR", 10)).allMatch(r -> r.purpose().equals("SYNC_FOLLOWUP") && r.batchId().equals(batch.id()));

        run("09:10:40");
        verify(client, times(3)).placeOrder(anyString());   // 묶음은 하루 하나 — 진행 중인 주문은 다시 보내지 않음
        run("09:14");
        assertThat(events("WINDOW_SUMMARY")).singleElement().satisfies(e -> {
            assertThat(e.detail().path("window").asString()).isEqualTo("SYNC_AT");
            assertThat(e.detail().path("accepted").asInt()).isEqualTo(3);
        });
        assertThat(RealTradeNotices.text(events("WINDOW_SUMMARY").getFirst())).contains("개장 10분 뒤 맞추기");
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

        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + C + " DAY 100", "BUY " + B + " DAY 150", "BUY " + A + " DAY 32");
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
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary)
                .containsExactly("SELL " + B + " DAY 200", "SELL " + A + " DAY 100", "BUY " + CASH_LIKE + " DAY 76");
        assertThat(store.batch("KR", SESSION, RealTradeStore.BATCH_SYNC)).isPresent();
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
        assertThat(sentSummaries()).hasSize(3).allMatch(o -> o.contains(" DAY "));
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
        assertThat(sentSummaries()).hasSize(4);
        assertThat(cfg().state()).isEqualTo("LIVE");
        assertThat(events("HALT")).isEmpty();
    }

    @Test
    @DisplayName("매매 제한 — 종목 제한 거절이 3건이어도 이상 멈춤이 아니고 그 종목들만 3분 뒤 다시 보냄")
    void timedSyncHoldsRestrictedSymbols() {
        timedRestrictionDay();
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
        assertThat(sentSummaries()).hasSize(3);
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
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", C, "SELL", "OPG", "FILLED", "100", "100", clock.now, clock.now)));
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
        assertThat(sentBodies()).extracting(RealTradeJobDbTest::summary).containsExactly("SELL " + C + " DAY 100", "BUY " + A + " DAY 92");
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
    @DisplayName("QA-342: 모의 달력의 개장 3분 전이 지나도록 토스 장 운영 정보를 받지 못하면 하루 한 번 알림 이벤트(calendar-unavailable) — 주문 없음, 재시도는 계속, 다시 띄워도 한 번")
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
    }

    @Test
    @DisplayName("QA-342: 켜짐인데 모의 달력의 개장 3분 전이 지나도록 수집기 매매 상태를 읽지 못하면 하루 한 번 알림 이벤트(status-unavailable) — 멈춤 아님")
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

        // 상태가 돌아온 뒤 달력까지 못 받으면 그것은 따로 한 번
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        when(client.calendar()).thenReturn(Reply.failed("calendar-unavailable"));
        run("09:31");
        run("09:33");
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
}
