package com.macrodash.feature.realtrade;

import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.collector.CollectorTradeClient.CancelResult;
import com.macrodash.collector.CollectorTradeClient.OrderResult;
import com.macrodash.collector.CollectorTradeClient.Outcome;
import com.macrodash.collector.CollectorTradeClient.Reply;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.realtrade.RealTradeExecutor.Result;
import com.macrodash.feature.realtrade.RealTradeExecutor.Send;
import com.macrodash.feature.realtrade.RealTradeExecutor.Sent;
import com.macrodash.feature.realtrade.RealTradeFixtures.MutableClock;
import com.macrodash.store.RealTradeStore;
import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.OrderRow;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static com.macrodash.feature.realtrade.RealTradeFixtures.BOOK;
import static com.macrodash.feature.realtrade.RealTradeFixtures.SESSION;
import static com.macrodash.feature.realtrade.RealTradeFixtures.broker;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static com.macrodash.feature.realtrade.RealTradeFixtures.kst;
import static com.macrodash.feature.realtrade.RealTradeFixtures.row;
import static com.macrodash.feature.realtrade.RealTradeFixtures.rows;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 실제 주문 한 건의 일({@link RealTradeExecutor}, ADR 0028 — 명세 2026-11-06 §1·§4) — 실제 테스트 DB(macrodash_test)의 {@code real_trade_*} 표와 가짜 수집기·
 * 모의 공개 창으로: 선점·잠금(끄기 뒤 SENDING 없음), 결과 분류, 같은 키 재전송(같은 바이트), 7분 뒤 대조(하나·0·둘), 멱등 충돌, 추적, 종가 체결 시각, 이상 멈춤과
 * 취소. 실제 토스·수집기는 부르지 않습니다.
 */
class RealTradeExecutorDbTest {

    private static final String A = "005930";
    private static final String C = "035420";

    private JdbcTemplate jdbc;
    private RealTradeStore store;
    private CollectorTradeClient client;
    private PaperMirrorService paper;
    private MutableClock clock;
    private RealTradeExecutor executor;

    @BeforeEach
    void setUp() {
        jdbc = RealTradeFixtures.jdbc();
        store = RealTradeFixtures.store(jdbc);
        RealTradeFixtures.clean(jdbc);
        client = mock(CollectorTradeClient.class);
        paper = mock(PaperMirrorService.class);
        RealTradeFixtures.claimRunsInsert(paper);
        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        when(client.todayOrders()).thenReturn(Reply.of(List.of()));
        when(client.cancelOrder(anyString())).thenReturn(new CancelResult(Outcome.ACCEPTED, "C-1", null));
        clock = new MutableClock(kst("2026-11-06T10:00"));
        executor = new RealTradeExecutor(store, client, paper, RealTradeFixtures.MAPPER, clock);
    }

    @AfterEach
    void tearDown() {
        RealTradeFixtures.clean(jdbc);
    }

    private Config live() {
        return RealTradeFixtures.live(store, false, d("10000000"));
    }

    private static Send mirror(long orderId, long root, String side, int qty) {
        return new Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, orderId, root, A, side, qty, "DAY", d("70000"), 1);
    }

    private long batch() {
        return store.upsertBatch("KR", SESSION, RealTradeStore.BATCH_SYNC, BOOK, null, List.of(), d("10000000")).id();
    }

    private void accepted(String orderId) {
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, orderId, null, 200));
    }

    private OrderRow only() {
        List<OrderRow> all = store.recentOrders("KR", 10);
        assertThat(all).hasSize(1);
        return all.getFirst();
    }

    // ------------------------------------------------------------------ 보내기·선점·잠금
    @Test
    @DisplayName("장중 따라 하기: 선점 안에서 SENDING을 쓰고 잠금 밖에서 보낸 뒤 접수 번호를 행에 — 보낸 본문은 행에 저장한 바이트 그대로")
    void sendsAfterClaim() {
        Config cfg = live();
        accepted("T-1");
        Sent sent = executor.send(mirror(101, 100, "BUY", 5), cfg);

        assertThat(sent.result()).isEqualTo(Result.ACCEPTED);
        verify(paper).claim(eq(BOOK), eq(101L), eq(clock.now), any());
        OrderRow row = only();
        assertThat(row.sendOutcome()).isEqualTo("ACCEPTED");
        assertThat(row.tossOrderId()).isEqualTo("T-1");
        assertThat(row.sendCount()).isEqualTo(1);
        assertThat(row.paperRootOrderId()).isEqualTo(100L);
        ArgumentCaptor<String> body = ArgumentCaptor.forClass(String.class);
        verify(client).placeOrder(body.capture());
        assertThat(body.getValue()).isEqualTo(row.requestBody()).contains("\"clientOrderId\":\"" + row.clientOrderId() + "\"")
                .contains("\"timeInForce\":\"DAY\"", "\"quantity\":\"5\"");
        assertThat(row.toString()).doesNotContain("T-1", row.clientOrderId());
    }

    @Test
    @DisplayName("선점 실패(장중 교체가 먼저 취소 — 모의 주문이 대기가 아님)면 행도 전송도 없음, 같은 뿌리를 두 번 보내면 두 번째는 행이 생기지 않음")
    void claimLostOrDuplicateRoot() {
        Config cfg = live();
        doReturn(Optional.empty()).when(paper).claim(anyString(), eq(201L), any(), any());
        assertThat(executor.send(mirror(201, 200, "BUY", 5), cfg).result()).isEqualTo(Result.NOT_INSERTED);
        assertThat(store.recentOrders("KR", 10)).isEmpty();
        verify(client, never()).placeOrder(anyString());

        accepted("T-1");
        assertThat(executor.send(mirror(101, 100, "BUY", 5), cfg).result()).isEqualTo(Result.ACCEPTED);
        assertThat(executor.send(mirror(102, 100, "BUY", 5), cfg).result()).as("재발행 주문(같은 뿌리)").isEqualTo(Result.NOT_INSERTED);
        verify(client, times(1)).placeOrder(anyString());
    }

    @Test
    @DisplayName("끄기 뒤 SENDING 없음 — 끄기가 설정 행을 잡은 동안 보내기는 기다리고, 커밋 뒤 바뀐 상태를 보고 행을 쓰지 않음(전송 0)")
    void noSendingAfterDisable() throws Exception {
        Config cfg = live();
        long batch = batch();
        accepted("T-1");
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<?> disabler = pool.submit(() -> store.lockConfig("KR", current -> {
                store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 1L);
                locked.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return null;
            }));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();
            Future<Sent> sender = pool.submit(() -> executor.send(new Send(SESSION, RealTradeStore.PURPOSE_SYNC, batch, null, null, C,
                    "SELL", 3, "OPG", d("1000"), 1), cfg));
            Thread.sleep(400);
            assertThat(sender.isDone()).as("설정 행 잠금을 기다림").isFalse();
            release.countDown();
            disabler.get(10, TimeUnit.SECONDS);
            assertThat(sender.get(10, TimeUnit.SECONDS).result()).isEqualTo(Result.NOT_INSERTED);
        } finally {
            pool.shutdownNow();
        }
        verify(client, never()).placeOrder(anyString());
        assertThat(store.recentOrders("KR", 10)).isEmpty();
    }

    @Test
    @DisplayName("계획 뒤 설정이 바뀌면(버전·책) 쓰지 않음, 매수 멈춤이면 매수만 쓰지 않음(매도는 씀)")
    void admissibleChecksVersionAndBuysPaused() {
        Config cfg = live();
        long batch = batch();
        accepted("T-1");
        store.lockConfig("KR", current -> store.updateConfig(current.withBuysPaused(true), null));
        Send buy = new Send(SESSION, RealTradeStore.PURPOSE_SYNC, batch, null, null, A, "BUY", 3, "OPG", d("70000"), 1);
        assertThat(executor.send(buy, cfg).result()).as("버전이 다름").isEqualTo(Result.NOT_INSERTED);
        Config paused = store.config("KR").orElseThrow();
        assertThat(executor.send(buy, paused).result()).as("매수 멈춤").isEqualTo(Result.NOT_INSERTED);
        Send sell = new Send(SESSION, RealTradeStore.PURPOSE_SYNC, batch, null, null, C, "SELL", 3, "OPG", d("1000"), 1);
        assertThat(executor.send(sell, paused).result()).isEqualTo(Result.ACCEPTED);
    }

    // ------------------------------------------------------------------ 결과 분류
    @Test
    @DisplayName("결과 분류 — REJECTED·NOT_SENT는 그 시도 종료, 422 idempotency-key-conflict는 결과 모름 + 즉시 이상 멈춤")
    void outcomes() {
        Config cfg = live();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.REJECTED, null, "opposite-pending-order-exists", 409));
        assertThat(executor.send(mirror(101, 100, "BUY", 5), cfg).result()).isEqualTo(Result.REJECTED);
        assertThat(store.recentOrders("KR", 1).getFirst().terminal()).isTrue();

        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.NOT_SENT, null, "outside-window", null));
        assertThat(executor.send(mirror(111, 110, "BUY", 5), cfg).result()).isEqualTo(Result.NOT_SENT);

        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "idempotency-key-conflict", 422));
        assertThat(executor.send(mirror(121, 120, "BUY", 5), cfg).result()).isEqualTo(Result.UNKNOWN);
        Config after = store.config("KR").orElseThrow();
        assertThat(after.state()).isEqualTo("HALTED");
        assertThat(after.haltReason()).isEqualTo("idempotency-conflict");
        assertThat(store.recentEvents("KR", 5)).anyMatch(e -> e.kind().equals("HALT") && e.notifies());
    }

    // ------------------------------------------------------------------ 멱등
    @Test
    @DisplayName("결과 모름 → 7분 안에는 같은 키·저장한 바이트로만 다시 보냄(재전송의 거절은 결과 모름 그대로), 접수되면 묶음")
    void unknownResendsSameBytes() {
        Config cfg = live();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        OrderRow first = only();
        assertThat(first.sendOutcome()).isEqualTo("UNKNOWN");

        clock.set(kst("2026-11-06T10:00:10"));
        executor.resolveUnknown(clock.now, store.config("KR").orElseThrow());
        verify(client, times(1)).placeOrder(anyString());   // 간격(20초) 전

        clock.set(kst("2026-11-06T10:00:25"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.REJECTED, null, "rate-limited", 429));
        executor.resolveUnknown(clock.now, store.config("KR").orElseThrow());
        assertThat(only().sendOutcome()).as("재전송의 거절은 첫 전송을 부정하지 못함").isEqualTo("UNKNOWN");

        clock.set(kst("2026-11-06T10:00:50"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-9", null, 200));
        executor.resolveUnknown(clock.now, store.config("KR").orElseThrow());
        OrderRow bound = only();
        assertThat(bound.sendOutcome()).isEqualTo("ACCEPTED");
        assertThat(bound.tossOrderId()).isEqualTo("T-9");
        assertThat(bound.sendCount()).isEqualTo(3);

        ArgumentCaptor<String> bodies = ArgumentCaptor.forClass(String.class);
        verify(client, times(3)).placeOrder(bodies.capture());
        assertThat(bodies.getAllValues()).containsOnly(first.requestBody());
    }

    @Test
    @DisplayName("결과 모름 — 꺼짐·멈춤이면 다시 보내지 않음(주문을 새로 만들 수 있으므로), 7분 + 여유 뒤 대조")
    void noResendWhenNotLive() {
        Config cfg = live();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        clock.set(kst("2026-11-06T10:01"));
        executor.resolveUnknown(clock.now, null);
        verify(client, times(1)).placeOrder(anyString());
        verify(client, never()).todayOrders();
    }

    @Test
    @DisplayName("7분 뒤 대조 — 후보가 정확히 하나면 묶음(다른 행에 묶인 주문·시각 밖·모양 다름은 후보 아님)")
    void reconcileExactlyOne() {
        Config cfg = live();
        accepted("T-OTHER");
        executor.send(new Send(SESSION, RealTradeStore.PURPOSE_MIRROR, null, 91L, 90L, A, "BUY", 5, "DAY", d("70000"), 1), cfg);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        OrderRow unknown = store.recentOrders("KR", 1).getFirst();

        when(client.todayOrders()).thenReturn(Reply.of(List.of(
                broker("T-OTHER", A, "BUY", "DAY", "FILLED", "5", "5", kst("2026-11-06T10:00:01"), null),     // 다른 행에 묶임
                broker("T-OK", A, "BUY", "DAY", "FILLED", "5", "5", kst("2026-11-06T10:00:02"), null),
                broker("T-QTY", A, "BUY", "DAY", "FILLED", "6", "6", kst("2026-11-06T10:00:02"), null),       // 수량 다름
                broker("T-EARLY", A, "BUY", "DAY", "FILLED", "5", "5", kst("2026-11-06T09:59:50"), null),     // 시각 밖
                broker("T-TIF", A, "BUY", "OPG", "FILLED", "5", "5", kst("2026-11-06T10:00:02"), null))));    // TIF 다름
        clock.set(kst("2026-11-06T10:07:30"));
        assertThat(executor.resolveUnknown(clock.now, store.config("KR").orElseThrow()))
                .isEqualTo(new RealTradeExecutor.Resolution(0, false));
        OrderRow bound = store.order(unknown.id()).orElseThrow();
        assertThat(bound.sendOutcome()).isEqualTo("ACCEPTED");
        assertThat(bound.outcomeCode()).isEqualTo("reconciled");
        assertThat(bound.tossOrderId()).isEqualTo("T-OK");
        assertThat(store.config("KR").orElseThrow().state()).isEqualTo("LIVE");
        verify(client, times(2)).placeOrder(anyString());   // 재전송 창이 지난 뒤에는 보내지 않음
    }

    @Test
    @DisplayName("7분 뒤 대조 — 후보가 0개면 이상 멈춤(unknown-order)")
    void reconcileNoneHalts() {
        Config cfg = live();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        clock.set(kst("2026-11-06T10:07:30"));
        assertThat(executor.resolveUnknown(clock.now, null)).isEqualTo(new RealTradeExecutor.Resolution(1, false));
        assertThat(store.config("KR").orElseThrow().state()).isEqualTo("LIVE");

        // 켜짐이면 멈춤
        clock.set(kst("2026-11-06T10:07:40"));
        executor.resolveUnknown(clock.now, store.config("KR").orElseThrow());
        Config halted = store.config("KR").orElseThrow();
        assertThat(halted.state()).isEqualTo("HALTED");
        assertThat(halted.haltReason()).isEqualTo("unknown-order");
        assertThat(only().sendOutcome()).isEqualTo("UNKNOWN");
    }

    @Test
    @DisplayName("7분 뒤 대조 — 후보가 둘이면 이상 멈춤(어느 쪽인지 모름)")
    void reconcileTwoHalts() {
        Config cfg = live();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        when(client.openOrders()).thenReturn(Reply.of(List.of(
                broker("T-1", A, "BUY", "DAY", "PENDING", "5", "0", kst("2026-11-06T10:00:01"), null))));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(
                broker("T-1", A, "BUY", "DAY", "PENDING", "5", "0", kst("2026-11-06T10:00:01"), null),
                broker("T-2", A, "BUY", "DAY", "FILLED", "5", "5", kst("2026-11-06T10:03"), null))));
        clock.set(kst("2026-11-06T10:07:30"));
        executor.resolveUnknown(clock.now, store.config("KR").orElseThrow());
        assertThat(store.config("KR").orElseThrow().haltReason()).isEqualTo("unknown-order");
        assertThat(only().tossOrderId()).isNull();
    }

    @Test
    @DisplayName("남은 SENDING(지난 실행이 보냈는지 모름)은 결과 모름(interrupted)으로 — 사람이 확인한 뒤(켜기·해제)에는 창이 끝난 결과 모름을 종료로")
    void orphansAndOperatorResolution() {
        Config cfg = live();
        long id = store.lockConfig("KR", current -> store.insertSending(new RealTradeStore.NewOrder("KR", SESSION,
                RealTradeStore.PURPOSE_MIRROR, null, BOOK, cfg.bookGeneration(), 101L, 100L, A, "BUY", 5, "DAY", d("70000"), 1,
                "00000000-0000-0000-0000-000000000001", "{}", clock.now)).orElseThrow());
        assertThat(executor.markOrphans()).isEqualTo(1);
        assertThat(store.order(id).orElseThrow().sendOutcome()).isEqualTo("UNKNOWN");
        assertThat(store.order(id).orElseThrow().outcomeCode()).isEqualTo("interrupted");

        assertThat(executor.resolveByOperator(kst("2026-11-06T10:03"))).as("창 안 — 아직 모름").isZero();
        assertThat(executor.resolveByOperator(kst("2026-11-06T10:08"))).isEqualTo(1);
        OrderRow resolved = store.order(id).orElseThrow();
        assertThat(resolved.terminal()).isTrue();
        assertThat(resolved.outcomeCode()).isEqualTo("operator-resolved");
    }

    @Test
    @DisplayName("접수 번호가 이미 다른 행에 묶여 있으면 이상 멈춤(unknown-order)")
    void tossIdInUseHalts() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        executor.send(mirror(111, 110, "BUY", 5), cfg);
        assertThat(store.config("KR").orElseThrow().haltReason()).isEqualTo("unknown-order");
    }

    // ------------------------------------------------------------------ 추적
    @Test
    @DisplayName("추적 — 미체결 목록 한 번 + 빠진 주문만 하나씩 조회, 종료 상태와 체결을 기록")
    void tracking() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        accepted("T-2");
        executor.send(mirror(111, 110, "BUY", 5), cfg);
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "DAY", "PARTIAL_FILLED", "5", "2", clock.now, null))));
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "BUY", "DAY", "FILLED", "5", "5", clock.now, clock.now)));

        executor.track(clock.now, null);

        verify(client, times(1)).openOrders();
        verify(client).order("T-2");
        verify(client, never()).order("T-1");
        List<OrderRow> all = store.recentOrders("KR", 10);
        OrderRow t1 = all.stream().filter(r -> "T-1".equals(r.tossOrderId())).findFirst().orElseThrow();
        OrderRow t2 = all.stream().filter(r -> "T-2".equals(r.tossOrderId())).findFirst().orElseThrow();
        assertThat(t1.terminal()).isFalse();
        assertThat(t1.filledQuantity()).isEqualByComparingTo("2");
        assertThat(t2.terminal()).isTrue();
        assertThat(t2.brokerStatus()).isEqualTo("FILLED");
        assertThat(t2.filledQuantity()).isEqualByComparingTo("5");
    }

    @Test
    @DisplayName("모르는 토스 상태 코드는 종료로 보지 않고 이상 멈춤(unknown-broker-status)")
    void unknownBrokerStatusHalts() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        when(client.openOrders()).thenReturn(Reply.of(List.of(broker("T-1", A, "BUY", "DAY", "MYSTERY", "5", "0", clock.now, null))));
        executor.track(clock.now, null);
        assertThat(only().terminal()).isFalse();
        assertThat(store.config("KR").orElseThrow().haltReason()).isEqualTo("unknown-broker-status");
    }

    @Test
    @DisplayName("종가 따라 하기 체결 시각이 정규장 끝 ± 2분 밖이면 이상 멈춤(close-auction-mismatch), 안이면 그대로")
    void closeAuctionCheck() {
        RealTradePlanner.Day day = RealTradePlanner.windows(SESSION, new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T08:00"), kst("2026-11-06T08:50"), kst("2026-11-06T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T09:00"), kst("2026-11-06T15:20"), kst("2026-11-06T15:30"))));
        Config cfg = live();
        clock.set(kst("2026-11-06T15:21"));
        accepted("T-1");
        executor.send(mirror(101, 100, "SELL", 5), cfg);
        when(client.order("T-1")).thenReturn(Reply.of(broker("T-1", A, "SELL", "DAY", "FILLED", "5", "5", clock.now,
                kst("2026-11-06T15:30:00"))));
        executor.track(clock.now, day);
        assertThat(store.config("KR").orElseThrow().state()).isEqualTo("LIVE");

        Config again = store.config("KR").orElseThrow();
        accepted("T-2");
        executor.send(mirror(111, 110, "SELL", 5), again);
        when(client.order("T-2")).thenReturn(Reply.of(broker("T-2", A, "SELL", "DAY", "FILLED", "5", "5", clock.now,
                kst("2026-11-06T15:22:00"))));
        executor.track(clock.now, day);
        assertThat(store.config("KR").orElseThrow().haltReason()).isEqualTo("close-auction-mismatch");
    }

    // ------------------------------------------------------------------ 이상 멈춤
    @Test
    @DisplayName("이상 멈춤 → 이 기능의 미체결 취소, 그 뒤로는 매도도 쓰지 않음 — 이미 멈췄으면 이벤트를 쌓지 않음")
    void haltCancelsAndStopsSells() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);

        assertThat(executor.halt("turnover", Map.of("turnoverPct", new BigDecimal("71.00")))).isTrue();
        verify(client).cancelOrder("T-1");
        OrderRow row = only();
        assertThat(row.cancelRequestedAt()).isNotNull();
        assertThat(row.cancelOutcome()).isEqualTo("ACCEPTED");
        Config halted = store.config("KR").orElseThrow();
        assertThat(halted.haltDetail().path("turnoverPct").decimalValue()).isEqualByComparingTo("71.00");

        assertThat(executor.send(mirror(111, 110, "SELL", 5), halted).result()).isEqualTo(Result.NOT_INSERTED);
        assertThat(executor.halt("unknown-order", Map.of())).isFalse();
        assertThat(store.recentEvents("KR", 10).stream().filter(e -> e.kind().equals("HALT")).count()).isEqualTo(1);

        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(1)).cancelOrder("T-1");   // 취소를 받았으면 다시 보내지 않음
    }

    @Test
    @DisplayName("취소 재시도 — 받았는데 간격이 지나도 원 주문이 살아 있으면(취소 거부로 되돌아감) 다시, 확정 거절(already-*)이면 다시 보내지 않음")
    void cancelRetry() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(1)).cancelOrder("T-1");

        clock.set(clock.now.plusSeconds(31));
        when(client.cancelOrder("T-1")).thenReturn(new CancelResult(Outcome.REJECTED, null, "already-filled"));
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(2)).cancelOrder("T-1");
        assertThat(only().cancelOutcome()).isEqualTo("REJECTED:already-filled");

        clock.set(clock.now.plusSeconds(31));
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(2)).cancelOrder("T-1");
    }

    @Test
    @DisplayName("취소의 지나가는 거절(rate-limited·already-processing·401 계열)은 다시 보냄 — 간격은 마지막 시도부터, 끝난 거절(cancel-restricted)에서 멈춤")
    void cancelRetriesTransientRejects() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        Instant t0 = clock.now;

        when(client.cancelOrder("T-1")).thenReturn(new CancelResult(Outcome.REJECTED, null, "rate-limited"));
        executor.cancelOpen(t0, r -> true);
        verify(client, times(1)).cancelOrder("T-1");

        clock.set(t0.plusSeconds(31));
        when(client.cancelOrder("T-1")).thenReturn(new CancelResult(Outcome.REJECTED, null, "already-processing"));
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(2)).cancelOrder("T-1");
        assertThat(only().cancelOutcome()).isEqualTo("REJECTED:already-processing");

        clock.set(t0.plusSeconds(45));   // 첫 취소에서는 30초가 지났지만 마지막 시도(31초)에서는 14초
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(2)).cancelOrder("T-1");

        clock.set(t0.plusSeconds(62));
        when(client.cancelOrder("T-1")).thenReturn(new CancelResult(Outcome.REJECTED, null, "token-revoked"));
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(3)).cancelOrder("T-1");

        clock.set(t0.plusSeconds(93));
        when(client.cancelOrder("T-1")).thenReturn(new CancelResult(Outcome.REJECTED, null, "cancel-restricted"));
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(4)).cancelOrder("T-1");

        clock.set(t0.plusSeconds(124));
        executor.cancelOpen(clock.now, r -> true);
        verify(client, times(4)).cancelOrder("T-1");
        assertThat(only().cancelRequestedAt()).as("처음 요청한 시각은 그대로").isEqualTo(t0);
    }

    @Test
    @DisplayName("끝난 거절(already-*·cancel-restricted·order-not-found·http-404)은 다시 보내지 않음(원 주문 상태는 추적이 따라감)")
    void cancelFinalRejectsNotRetried() {
        Config cfg = live();
        List<String> finals = List.of("already-filled", "already-canceled", "already-rejected", "already-modified", "cancel-restricted",
                "order-not-found", "http-404");
        for (int i = 0; i < finals.size(); i++) {
            accepted("T-F" + i);
            executor.send(mirror(201 + 10L * i, 200 + 10L * i, "BUY", 5), cfg);
            when(client.cancelOrder("T-F" + i)).thenReturn(new CancelResult(Outcome.REJECTED, null, finals.get(i)));
        }
        executor.cancelOpen(clock.now, r -> true);
        clock.set(clock.now.plusSeconds(31));
        executor.cancelOpen(clock.now, r -> true);
        clock.set(clock.now.plusSeconds(31));
        executor.cancelOpen(clock.now, r -> true);
        for (int i = 0; i < finals.size(); i++) {
            verify(client, times(1)).cancelOrder("T-F" + i);
        }
    }

    @Test
    @DisplayName("취소를 상한까지 보내도 원 주문이 살아 있으면 CANCEL_GAVE_UP 이벤트(알림, 건수만) 한 번 — 그 뒤로는 보내지도 다시 알리지도 않음")
    void cancelGivesUpAndNotifies() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        when(client.cancelOrder("T-1")).thenReturn(new CancelResult(Outcome.UNKNOWN, null, "collector-timeout"));
        Instant t0 = clock.now;
        for (int i = 0; i < RealTradeExecutor.MAX_CANCEL_TRIES; i++) {
            clock.set(t0.plusSeconds(31L * i));
            executor.cancelOpen(clock.now, r -> true);
        }
        verify(client, times(RealTradeExecutor.MAX_CANCEL_TRIES)).cancelOrder("T-1");
        assertThat(store.recentEvents("KR", 10)).noneMatch(e -> e.kind().equals("CANCEL_GAVE_UP"));

        clock.set(t0.plusSeconds(31L * RealTradeExecutor.MAX_CANCEL_TRIES));
        executor.cancelOpen(clock.now, r -> true);
        clock.set(clock.now.plusSeconds(31));
        executor.cancelOpen(clock.now, r -> true);

        verify(client, times(RealTradeExecutor.MAX_CANCEL_TRIES)).cancelOrder("T-1");
        assertThat(store.recentEvents("KR", 10).stream().filter(e -> e.kind().equals("CANCEL_GAVE_UP")).toList()).singleElement()
                .satisfies(e -> {
                    assertThat(e.notifies()).isTrue();
                    assertThat(e.detail().path("count").asInt()).isEqualTo(1);
                    assertThat(e.detail().toString()).doesNotContain("T-1", A);
                });
    }

    // ------------------------------------------------------------------ 끝난 주문의 부분 체결(RT-CONTRACT-2)
    private static RealTradePlanner.Day normalDay() {
        return RealTradePlanner.windows(SESSION, new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T08:00"), kst("2026-11-06T08:50"), kst("2026-11-06T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T09:00"), kst("2026-11-06T15:20"), kst("2026-11-06T15:30"))));
    }

    private static CollectorTradeClient.BrokerOrder partial(String orderId, Instant canceledAt) {
        return new CollectorTradeClient.BrokerOrder(orderId, A, "BUY", "MARKET", "DAY", "PARTIAL_FILLED", d("5"), d("2"), d("70000"),
                d("140000"), null, null, kst("2026-11-06T10:00"), canceledAt, null, "KRW");
    }

    @Test
    @DisplayName("미체결 목록에 없는 PARTIAL_FILLED — 오늘 장중이면 아직 살아 있음, 정규장 끝 + 5분부터는 끝난 주문(종료·잔량 시도 2)")
    void partialFilledOutsideOpenEndsAfterClose() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        when(client.order("T-1")).thenReturn(Reply.of(partial("T-1", null)));
        RealTradePlanner.Day day = normalDay();

        executor.track(kst("2026-11-06T10:05"), day);
        assertThat(only().terminal()).as("오늘 장중 — 목록 반영이 늦을 수 있어 아직 아님").isFalse();
        executor.track(kst("2026-11-06T15:34:59"), day);
        assertThat(only().terminal()).isFalse();

        executor.track(kst("2026-11-06T15:35"), day);
        OrderRow ended = only();
        assertThat(ended.terminal()).isTrue();
        assertThat(ended.filledQuantity()).isEqualByComparingTo("2");
        assertThat(RealTradeJob.nextAttempt(List.of(ended), null, RealTradeStore.PURPOSE_MIRROR, true)).isEqualTo(2);
        assertThat(executor.cleanupDone(kst("2026-11-06T15:35"))).isTrue();
        assertThat(store.config("KR").orElseThrow().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("미체결 목록에 없는 PARTIAL_FILLED — 주문 세션이 오늘보다 앞이거나 취소 시각이 있으면 끝난 주문")
    void partialFilledOutsideOpenPastSessionOrCanceled() {
        Config cfg = live();
        accepted("T-1");
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        accepted("T-2");
        executor.send(mirror(111, 110, "BUY", 5), cfg);
        when(client.order("T-1")).thenReturn(Reply.of(partial("T-1", null)));
        when(client.order("T-2")).thenReturn(Reply.of(partial("T-2", kst("2026-11-06T10:03"))));

        executor.track(kst("2026-11-06T10:05"), normalDay());
        List<OrderRow> all = store.recentOrders("KR", 10);
        assertThat(all.stream().filter(r -> "T-1".equals(r.tossOrderId())).findFirst().orElseThrow().terminal()).isFalse();
        assertThat(all.stream().filter(r -> "T-2".equals(r.tossOrderId())).findFirst().orElseThrow().terminal()).as("취소 시각 있음").isTrue();

        executor.track(kst("2026-11-07T09:10"), null);   // 다음 날(그날 창을 아직 모름)
        assertThat(store.unfinishedOrders("KR")).as("지난 세션의 부분 체결은 끝난 주문").isEmpty();
    }

    // ------------------------------------------------------------------ 결과 모름 재전송과 멈춤(RT-BE-4)
    @Test
    @DisplayName("같은 루프에서 앞 행의 대조 실패로 이상 멈춤하면 뒤 행(재전송 창 안)의 결과 모름은 다시 보내지 않음")
    void unknownResendStopsAfterReconcileHalt() {
        Config cfg = live();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(mirror(101, 100, "BUY", 5), cfg);           // 10:00 — 10:07:45에는 대조 차례(후보 0 → 멈춤)
        clock.set(kst("2026-11-06T10:07:20"));
        executor.send(mirror(111, 110, "BUY", 5), cfg);           // 재전송 창 안
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-9", null, 200));

        clock.set(kst("2026-11-06T10:07:45"));
        executor.resolveUnknown(clock.now, store.config("KR").orElseThrow());

        assertThat(store.config("KR").orElseThrow().haltReason()).isEqualTo("unknown-order");
        verify(client, times(2)).placeOrder(anyString());
    }

    @Test
    @DisplayName("결과 모름 재전송은 보내기 직전의 설정이 읽은 때와 같은 버전·켜짐일 때만(그사이 설정이 바뀌면 보내지 않고 창이 끝나면 대조)")
    void unknownResendNeedsSameVersion() {
        Config cfg = live();
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(mirror(101, 100, "BUY", 5), cfg);
        Config planned = store.config("KR").orElseThrow();
        store.lockConfig("KR", current -> store.updateConfig(current.withBuysPaused(true), null));   // 그사이 설정이 바뀜(켜짐 그대로)

        clock.set(kst("2026-11-06T10:00:25"));
        executor.resolveUnknown(clock.now, planned);
        verify(client, times(1)).placeOrder(anyString());
        assertThat(only().sendCount()).isEqualTo(1);

        executor.resolveUnknown(clock.now, store.config("KR").orElseThrow());   // 다음 주기 — 새로 읽은 설정
        verify(client, times(2)).placeOrder(anyString());
    }

    // ------------------------------------------------------------------ 시도 번호
    @Test
    @DisplayName("시도 2 조건 — 앞 시도가 지나가는 장애로 거절·안 보냄이거나(마무리·장중) 종료에 덜 체결일 때만, 남은 수량만, 최대 2번")
    void attemptRules() {
        String p = RealTradeStore.PURPOSE_SYNC_FOLLOWUP;
        assertThat(RealTradeJob.nextAttempt(List.of(), A, p, true)).isEqualTo(1);
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "REJECTED", "rate-limited", null, true, null, 5)), A, p, true))
                .isEqualTo(2);
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "REJECTED", "over-order-limit", null, true, null, 5)), A, p, true))
                .as("다시 보내도 같은 거절").isZero();
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "ACCEPTED", null, "T-1", false, "2", 5)), A, p, true))
                .as("진행 중").isZero();
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "UNKNOWN", "read-timeout", null, false, null, 5)), A, p, true))
                .as("결과 모름").isZero();
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "ACCEPTED", null, "T-1", true, "3", 5)), A, p, true))
                .as("부분 체결 뒤 종료").isEqualTo(2);
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "ACCEPTED", null, "T-1", true, "3", 5)), A, p, false))
                .as("시가 맞추기(OPG)는 부분 체결을 마무리가 메움").isZero();
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "ACCEPTED", null, "T-1", true, "5", 5)), A, p, true))
                .as("전량 체결").isZero();
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, A, 1, "NOT_SENT", "rate-limited", null, true, null, 5),
                row(2, p, A, 2, "NOT_SENT", "rate-limited", null, true, null, 5)), A, p, true)).as("최대 2번").isZero();
        assertThat(RealTradeJob.nextAttempt(rows(row(1, p, C, 1, "ACCEPTED", null, "T-1", false, null, 5)), A, p, true))
                .as("다른 종목").isEqualTo(1);

        assertThat(RealTradeJob.remaining(rows(row(1, p, A, 1, "ACCEPTED", null, "T-1", true, "3", 5)), A, p)).isEqualTo(2);
        assertThat(RealTradeJob.remaining(rows(row(1, p, A, 1, "REJECTED", "rate-limited", null, true, null, 5)), A, p)).isEqualTo(5);
    }

    @Test
    @DisplayName("행·결과 레코드의 toString에 토스 주문 번호·클라이언트 키·요청 본문이 없음(로그로 새지 않게)")
    void recordsHideIdentifiers() {
        Send send = mirror(101, 100, "BUY", 5);
        assertThat(send.toString()).doesNotContain(A, "70000");
        Instant at = Instant.parse("2026-11-06T01:00:00Z");
        assertThat(new Sent(Result.ACCEPTED, 1L, null).toString()).doesNotContain("T-");
        assertThat(at).isNotNull();
    }
}
