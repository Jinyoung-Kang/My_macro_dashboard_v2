package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.feature.paper.PaperMirrorService.DueOrder;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.WeightAfter;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.LedgerHold;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 모의 한국 책의 공개 창({@link PaperMirrorService}, ADR 0028 — 명세 2026-11-06 §3.1~3.3) — 시가 목표가 스탑·규칙·Claude 시가 주문을 모두 흡수하는지,
 * 장중 주문의 따라 할 시각·뿌리, 그 주문 뒤 비중, 선점이 장중 교체와 겨룰 때 잠금 안에서 다시 보는지, 장부 반영 판정을 확인합니다. 달력은 천문연 실제
 * 응답으로 만든 2026년 한국 달력이고, 종목·가격은 합성 값입니다.
 */
class PaperMirrorServiceTest {

    private static final String BOOK = PaperBooks.KR_CLAUDE2;
    /** 목표 세션 S(금)와 그 전 거래일 P(목)·P2(수). */
    private static final LocalDate S = LocalDate.of(2026, 11, 6);
    private static final LocalDate P = LocalDate.of(2026, 11, 5);
    private static final LocalDate P2 = LocalDate.of(2026, 11, 4);
    private static final String A = "005930";
    private static final String B = "000660";
    private static final String C = "035420";
    private static final String CASH_LIKE = PaperBooks.KR_SHORT_BOND;
    /** P 밤 결정이 주문을 만든 시각(22:40 KST). */
    private static final Instant NIGHT = kst("2026-11-05T22:40");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperMarkets markets;
    private PaperLedgerService ledger;

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        when(marketData.quotes(any())).thenReturn(Optional.empty());
        when(marketData.watchKr()).thenReturn(Optional.empty());
        markets = new PaperMarkets(store, reader);
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_CLAUDE, PaperBooks.KR_CLAUDE2_LABEL, 100_000_000,
                LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE, Instant.parse("2026-10-29T13:00:00Z"), Book.MARKET_KR, Book.CURRENCY_KRW));
        state(1_000_000, kst("2026-11-05T20:40"));
    }

    private PaperMirrorService service(Instant clockNow) {
        return new PaperMirrorService(store, reader, marketData, markets, ledger, Clock.fixed(clockNow, ZoneOffset.UTC));
    }

    private PaperMirrorService service() {
        return service(kst("2026-11-06T08:50"));
    }

    private void state(double cash, Instant processed) {
        store.states.put(BOOK, new BookState(BOOK, cash, cash, 0, 0, processed, processed, P, null));
    }

    private void position(String ticker, int qty, double lastPrice) {
        store.upsertPosition(new Position(BOOK, ticker, qty, lastPrice * 0.9, P2, NIGHT, lastPrice, NIGHT, lastPrice, NIGHT, false, P,
                lastPrice, null));
    }

    private long order(String ticker, String side, Double weight, Double sellFraction, String timing, String source, LocalDate asOf,
                       Instant createdAt, LocalTime targetLocal, JsonNode reason) {
        return store.insertOrder(new Order(0, BOOK, null, ticker, side, null, weight, sellFraction, timing, source,
                PaperBooks.ORDER_PENDING, null, reason, asOf, createdAt, asOf.plusDays(10), null, targetLocal));
    }

    private long order(String ticker, String side, Double weight, Double sellFraction, String timing, String source) {
        return order(ticker, side, weight, sellFraction, timing, source, P, NIGHT, null, null);
    }

    private void quotes(Instant collectedAt, Object... tickerAndClose) {
        Map<String, Bar> bars = new LinkedHashMap<>();
        for (int i = 0; i < tickerAndClose.length; i += 2) {
            String ticker = (String) tickerAndClose[i];
            bars.put(ticker, PaperFixtures.bar(ticker, P2, ((Number) tickerAndClose[i + 1]).doubleValue() * 0.99, P,
                    tickerAndClose[i + 1]));
        }
        when(marketData.quotes(any())).thenReturn(Optional.of(new Quotes(collectedAt, bars, P)));
    }

    // ------------------------------------------------------------------ 시가 목표
    @Test
    @DisplayName("시가 목표는 스탑·규칙·Claude 시가 주문을 모두 체결했다고 본 비중 — 흡수 번호는 그 세션 시가 주문뿐")
    void openTargetsAbsorbAllOpenOrders() {
        position(A, 100, 10_000);
        quotes(kst("2026-11-05T20:30"), A, 10_000, B, 20_000, C, 5_000);
        long stop = order(A, PaperBooks.SELL, null, null, PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_STOP);
        long rule = order(B, PaperBooks.BUY, 25.0, null, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE);
        long claude = order(C, PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        order(C, PaperBooks.BUY, 5.0, null, PaperBooks.AT_1000, PacketBuilder.SOURCE_CLAUDE);                     // 장중 — 흡수하지 않음
        order(B, PaperBooks.BUY, 5.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, S, kst("2026-11-06T22:40"), null,
                null);                                                                                           // 다음 세션 시가
        order(B, PaperBooks.BUY, 5.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, P, kst("2026-11-06T10:00"), null,
                null);                                                                                           // S 개장 뒤 생성 — 장부도 다음 시가
        long cancelled = order(B, PaperBooks.BUY, 50.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        store.markOrderStatus(cancelled, PaperBooks.ORDER_CANCELLED, "다음 결정이 대신함");

        OpenTargets targets = service().openTargets(BOOK, S).orElseThrow();

        assertThat(targets.absorbedOrderIds()).containsExactly(stop, rule, claude);
        assertThat(targets.complete()).isTrue();
        assertThat(targets.nav()).isCloseTo(2_000_000, within(0.01));
        assertThat(targets.weightPct()).containsOnlyKeys(B, C);
        assertThat(targets.weightPct().get(B)).as("25% × 200만 ÷ 2만 = 25주").isCloseTo(25.0, within(1e-9));
        assertThat(targets.weightPct().get(C)).as("10% × 200만 ÷ 5천 = 40주").isCloseTo(10.0, within(1e-9));
        assertThat(targets.cash()).isCloseTo(1_300_000, within(0.01));
        assertThat(targets.price().get(B)).isEqualTo(20_000.0);
    }

    @Test
    @DisplayName("시가 목표의 매수 순서는 장부와 같이 현금성을 마지막에 — 먼저 만든 현금성 매수가 현금을 먼저 쓰지 않는다")
    void cashLikeBuysLast() {
        quotes(kst("2026-11-05T20:30"), CASH_LIKE, 100_000, B, 20_000);
        order(CASH_LIKE, PaperBooks.BUY, 80.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        order(B, PaperBooks.BUY, 50.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);

        OpenTargets targets = service().openTargets(BOOK, S).orElseThrow();

        assertThat(targets.weightPct().get(B)).as("신호 종목이 먼저 25주").isCloseTo(50.0, within(1e-9));
        assertThat(targets.weightPct().get(CASH_LIKE)).as("현금성은 남은 현금으로 5주").isCloseTo(50.0, within(1e-9));
    }

    @Test
    @DisplayName("가격을 모르는 시가 주문은 흡수하되 불완전으로 알리고, 순자산이 0 이하·상태 없음·휴장·한국 책 아님은 목표를 내지 않는다")
    void openTargetsRefuseIncompleteInputs() {
        quotes(kst("2026-11-05T20:30"), B, 20_000);
        long unpriced = order(C, PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);

        OpenTargets targets = service().openTargets(BOOK, S).orElseThrow();
        assertThat(targets.absorbedOrderIds()).containsExactly(unpriced);
        assertThat(targets.unpricedOrderIds()).containsExactly(unpriced);
        assertThat(targets.complete()).isFalse();

        assertThat(service().openTargets(BOOK, LocalDate.of(2026, 11, 7))).as("토요일").isEmpty();
        state(0, kst("2026-11-05T20:40"));
        assertThat(service().openTargets(BOOK, S)).as("순자산 0 — 빈 목표로 모두 팔지 않게").isEmpty();
        store.states.remove(BOOK);
        assertThat(service().openTargets(BOOK, S)).isEmpty();
        store.books.put("claude2", new Book("claude2", PaperBooks.KIND_CLAUDE, "Claude 계좌2", 100_000, P, PaperBooks.ACTIVE,
                Instant.parse("2026-10-20T00:00:00Z")));
        assertThat(service().openTargets("claude2", S)).as("미국 책").isEmpty();
        assertThat(service().openTargets("nope", S)).isEmpty();
    }

    // ------------------------------------------------------------------ 장중 주문
    @Test
    @DisplayName("장중 주문 — 따라 할 시각이 지난 그 세션 시각 지정 주문만, 종가는 종가 단일가 시작부터, 모르는 시점은 건너뜀으로 늘 보이고 뿌리를 단다")
    void dueOrdersWindowAndRoots() {
        long hourly = order(B, PaperBooks.BUY, 5.0, null, PaperBooks.AT_1000, PacketBuilder.SOURCE_CLAUDE);
        long market = order(A, PaperBooks.SELL, null, 0.5, PaperBooks.MARKET, PacketBuilder.SOURCE_CLAUDE, P,
                kst("2026-11-06T10:30"), null, null);                                                      // 기준 분 10:32
        long minute = order(C, PaperBooks.BUY, 3.0, null, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P, NIGHT,
                LocalTime.of(10, 45), null);
        long close = order(C, PaperBooks.BUY, 2.0, null, PaperBooks.NEXT_CLOSE, PacketBuilder.SOURCE_CLAUDE);
        order(B, PaperBooks.BUY, 4.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);                    // 시가 — 흡수 몫
        order(B, PaperBooks.BUY, 4.0, null, PaperBooks.AT_1000, PacketBuilder.SOURCE_CLAUDE, P2, kst("2026-11-04T22:40"), null,
                null);                                                                                           // 목표 세션 P
        long r0 = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_1000, RuleBookService.SOURCE_RULE, P2, kst("2026-11-04T22:40"),
                null, null);
        store.markOrderStatus(r0, PaperBooks.ORDER_EXPIRED, "다시 냄");
        ObjectNode fromR0 = PaperFixtures.MAPPER.createObjectNode().put(UsTimedFills.REISSUED_FROM, r0);
        long r1 = order(A, PaperBooks.SELL, null, null, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, P2, kst("2026-11-05T21:00"),
                null, fromR0);
        store.markOrderStatus(r1, PaperBooks.ORDER_EXPIRED, "다시 냄");
        ObjectNode fromR1 = PaperFixtures.MAPPER.createObjectNode().put(UsTimedFills.REISSUED_FROM, r1);
        long r2 = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_1000, RuleBookService.SOURCE_RULE, P, NIGHT, null, fromR1);
        long odd = order(B, PaperBooks.BUY, 1.0, null, "NEXT_OBSERVATION", PacketBuilder.SOURCE_CLAUDE);

        List<DueOrder> at1040 = service().dueOrders(BOOK, S, kst("2026-11-06T10:40"));
        assertThat(at1040).extracting(DueOrder::orderId).containsExactly(r2, hourly, market, odd);
        DueOrder reissued = at1040.getFirst();
        assertThat(reissued.rootOrderId()).as("재발행 사슬의 첫 주문").isEqualTo(r0);
        assertThat(reissued.mirrorAt()).isEqualTo(kst("2026-11-06T10:00"));
        assertThat(at1040.get(1).rootOrderId()).isEqualTo(hourly);
        assertThat(at1040.get(2).mirrorAt()).isEqualTo(kst("2026-11-06T10:32"));
        assertThat(at1040.get(2).sellFraction()).isEqualTo(0.5);
        DueOrder unsupported = at1040.get(3);
        assertThat(unsupported.supported()).isFalse();
        assertThat(unsupported.mirrorAt()).isNull();

        List<DueOrder> at1521 = service().dueOrders(BOOK, S, kst("2026-11-06T15:21"));
        assertThat(at1521).extracting(DueOrder::orderId).contains(minute, close);
        DueOrder closing = at1521.stream().filter(d -> d.orderId() == close).findFirst().orElseThrow();
        assertThat(closing.mirrorAt()).as("종가 단일가 시작").isEqualTo(kst("2026-11-06T15:20"));
        assertThat(closing.target()).as("모의 기준 시각은 마감").isEqualTo(kst("2026-11-06T15:30"));
        assertThat(service().dueOrders(BOOK, S, kst("2026-11-06T15:19"))).extracting(DueOrder::orderId).doesNotContain(close);
        assertThat(service().dueOrders("nope", S, kst("2026-11-06T15:21"))).isEmpty();
    }

    @Test
    @DisplayName("그 주문 뒤 비중 — 시가 주문과 기준 시각이 그 주문 이하인 주문만 넣고, 감시 저장본은 지금 전에 받은 것만 쓴다")
    void weightAfterIncludesEverythingUpToT() {
        position(A, 100, 10_000);
        quotes(kst("2026-11-05T20:30"), A, 10_000, B, 20_000, C, 5_000);
        long open = order(B, PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        long sellHalf = order(A, PaperBooks.SELL, null, 0.5, PaperBooks.AT_1000, RuleBookService.SOURCE_RULE);
        long buyC = order(C, PaperBooks.BUY, 20.0, null, PaperBooks.AT_1100, PacketBuilder.SOURCE_CLAUDE);
        long later = order(A, PaperBooks.BUY, 10.0, null, PaperBooks.AT_1400, PacketBuilder.SOURCE_CLAUDE);

        WeightAfter afterSell = service().weightAfter(BOOK, sellHalf, kst("2026-11-06T10:01")).orElseThrow();
        assertThat(afterSell.applied()).isTrue();
        assertThat(afterSell.assumedOrderIds()).containsExactly(open, sellHalf);
        assertThat(afterSell.weightPct()).as("50주 × 1만 ÷ 200만").isCloseTo(25.0, within(1e-9));
        assertThat(afterSell.side()).isEqualTo(PaperBooks.SELL);

        WeightAfter afterBuy = service().weightAfter(BOOK, buyC, kst("2026-11-06T11:01")).orElseThrow();
        assertThat(afterBuy.assumedOrderIds()).containsExactly(open, sellHalf, buyC).doesNotContain(later);
        assertThat(afterBuy.weightPct()).as("20% × 200만 ÷ 5천 = 80주").isCloseTo(20.0, within(1e-9));
        assertThat(afterBuy.nav()).isCloseTo(2_000_000, within(0.01));

        // 감시 저장본의 10:00 창 첫 거래 봉(시가 12,000)으로 판 값 — 지금 전에 받은 저장본만.
        ObjectNode watch = PaperFixtures.MAPPER.createObjectNode();
        watch.putObject("tickers").putObject(A).putObject("windows").putArray("10:00").addObject()
                .put("label", "10:01").put("open", 12_000).put("volume", 500);
        when(marketData.watchKr()).thenReturn(Optional.of(KrFixtures.snapshot("paper.watch.kr", watch, kst("2026-11-06T10:01:30"))));
        WeightAfter watched = service().weightAfter(BOOK, sellHalf, kst("2026-11-06T10:02")).orElseThrow();
        assertThat(watched.nav()).as("현금 80만 + 50주×1.2만 + 60만 + B 20만").isCloseTo(2_200_000, within(0.01));
        assertThat(watched.weightPct()).isCloseTo(600_000.0 / 2_200_000 * 100, within(1e-9));
        WeightAfter tooEarly = service().weightAfter(BOOK, sellHalf, kst("2026-11-06T10:01")).orElseThrow();
        assertThat(tooEarly.weightPct()).as("지금 뒤에 받은 저장본은 쓰지 않음").isCloseTo(25.0, within(1e-9));

        store.markOrderStatus(later, PaperBooks.ORDER_CANCELLED, "장중 확인이 대신함");
        assertThat(service().weightAfter(BOOK, later, kst("2026-11-06T14:01"))).as("대기가 아님").isEmpty();
        assertThat(service().weightAfter("nope", sellHalf, kst("2026-11-06T10:01"))).isEmpty();
    }

    @Test
    @DisplayName("그 주문의 가격을 모르면 비중은 그 주문 전 값이고 applied=false")
    void weightAfterUnpricedOrder() {
        position(A, 100, 10_000);
        quotes(kst("2026-11-05T20:30"), A, 10_000);
        long buyC = order(C, PaperBooks.BUY, 20.0, null, PaperBooks.AT_1100, PacketBuilder.SOURCE_CLAUDE);

        WeightAfter after = service().weightAfter(BOOK, buyC, kst("2026-11-06T11:01")).orElseThrow();
        assertThat(after.applied()).isFalse();
        assertThat(after.unpricedOrderIds()).containsExactly(buyC);
        assertThat(after.weightPct()).isZero();
    }

    // ------------------------------------------------------------------ 선점
    @Test
    @DisplayName("선점 — 대기이고 따라 할 시각이 지났고 목표 세션이 오늘일 때만 받은 일을 부른다(시가·다른 책·지난 세션·멈춘 책·시계보다 앞선 now는 아님)")
    void claimChecks() {
        long hourly = order(B, PaperBooks.BUY, 5.0, null, PaperBooks.AT_1000, PacketBuilder.SOURCE_CLAUDE);
        long open = order(B, PaperBooks.BUY, 5.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        long stale = order(B, PaperBooks.BUY, 5.0, null, PaperBooks.AT_1000, PacketBuilder.SOURCE_CLAUDE, P2, kst("2026-11-04T22:40"),
                null, null);
        long close = order(C, PaperBooks.BUY, 2.0, null, PaperBooks.NEXT_CLOSE, PacketBuilder.SOURCE_CLAUDE);
        AtomicInteger calls = new AtomicInteger();
        Instant t = kst("2026-11-06T10:00:30");

        assertThat(service(t).claim(BOOK, hourly, t, () -> "row-" + calls.incrementAndGet())).contains("row-1");
        assertThat(service(t).claim(BOOK, hourly, kst("2026-11-06T09:59"), calls::incrementAndGet)).as("T 전").isEmpty();
        assertThat(service(kst("2026-11-06T09:59:30")).claim(BOOK, hourly, t, calls::incrementAndGet))
                .as("받은 now가 서비스 시계보다 앞섬").isEmpty();
        assertThat(service(t).claim(BOOK, open, t, calls::incrementAndGet)).as("시가 주문").isEmpty();
        assertThat(service(t).claim(BOOK, stale, t, calls::incrementAndGet)).as("목표 세션 P").isEmpty();
        assertThat(service(t).claim("kr_claude", hourly, t, calls::incrementAndGet)).as("다른 책 코드").isEmpty();
        assertThat(service(t).claim(BOOK, close, t, calls::incrementAndGet)).as("종가는 15:20부터").isEmpty();
        Instant closing = kst("2026-11-06T15:20:30");
        assertThat(service(closing).claim(BOOK, close, closing, () -> "close")).contains("close");
        assertThat(calls.get()).as("받은 일은 첫 선점에서만 불림").isEqualTo(1);

        store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_CLAUDE, PaperBooks.KR_CLAUDE2_LABEL, 100_000_000, LocalDate.of(2026, 10, 30),
                PaperBooks.PAUSED, Instant.parse("2026-10-29T13:00:00Z"), Book.MARKET_KR, Book.CURRENCY_KRW));
        assertThat(service(t).claim(BOOK, hourly, t, calls::incrementAndGet)).as("일시정지").isEmpty();
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("선점이 장중 교체와 겨루면 — 교체가 잠금을 쥔 동안 선점은 기다렸다가 잠금 안에서 다시 읽어 취소된 주문을 보고 부르지 않는다")
    void claimRacesSupersede() throws Exception {
        long hourly = order(B, PaperBooks.BUY, 5.0, null, PaperBooks.AT_1000, PacketBuilder.SOURCE_CLAUDE);
        Instant t = kst("2026-11-06T10:00:30");
        PaperMirrorService service = service(t);
        CountDownLatch supersedeHolds = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger inserts = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<?> supersede = pool.submit(() -> ledger.exclusively(() -> {
                supersedeHolds.countDown();
                await(release);
                store.markOrderStatus(hourly, PaperBooks.ORDER_CANCELLED, ClaudeDecisionPipeline.SUPERSEDED_BY_CHECKPOINT);
                return null;
            }));
            assertThat(supersedeHolds.await(5, TimeUnit.SECONDS)).isTrue();
            Future<Optional<Integer>> claim = pool.submit(() -> service.claim(BOOK, hourly, t, inserts::incrementAndGet));
            Thread.sleep(200);
            assertThat(claim.isDone()).as("교체가 잠금을 쥔 동안 선점은 기다림").isFalse();
            release.countDown();
            supersede.get(5, TimeUnit.SECONDS);
            assertThat(claim.get(5, TimeUnit.SECONDS)).isEmpty();
        } finally {
            pool.shutdownNow();
        }
        assertThat(inserts.get()).isZero();
    }

    @Test
    @DisplayName("선점의 일은 잠금 안에서 돈다 — 그동안 장부를 바꾸는 다른 일은 기다리고, 끝난 뒤에는 이미 쓰인 행을 본다")
    void claimRunsInsideTheLedgerLock() throws Exception {
        long hourly = order(B, PaperBooks.BUY, 5.0, null, PaperBooks.AT_1000, PacketBuilder.SOURCE_CLAUDE);
        Instant t = kst("2026-11-06T10:00:30");
        PaperMirrorService service = service(t);
        CountDownLatch inserting = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        List<String> sequence = new java.util.concurrent.CopyOnWriteArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Optional<String>> claim = pool.submit(() -> service.claim(BOOK, hourly, t, () -> {
                inserting.countDown();
                await(release);
                sequence.add("insert");
                return "row";
            }));
            assertThat(inserting.await(5, TimeUnit.SECONDS)).isTrue();
            Future<?> other = pool.submit(() -> ledger.exclusively(() -> {
                sequence.add("ledger");
                return null;
            }));
            Thread.sleep(200);
            assertThat(other.isDone()).isFalse();
            release.countDown();
            assertThat(claim.get(5, TimeUnit.SECONDS)).contains("row");
            other.get(5, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }
        assertThat(sequence).containsExactly("insert", "ledger");
    }

    // ------------------------------------------------------------------ 장부 반영·책·달력
    @Test
    @DisplayName("장부 반영 — P 관측치를 처리했고 일하는 이전 대기 주문이 없을 때만 참(장부가 그날 보류한 주문은 기다리지 않음)")
    void ledgerCaughtUp() {
        Instant processed = kst("2026-11-05T20:40");
        quotes(kst("2026-11-05T20:30"), A, 10_000, B, 20_000);
        assertThat(service().ledgerCaughtUp(BOOK, S)).isTrue();

        state(1_000_000, kst("2026-11-04T20:40"));
        assertThat(service().ledgerCaughtUp(BOOK, S)).as("마지막 처리가 P2").isFalse();
        state(1_000_000, processed);

        quotes(kst("2026-11-05T20:50"), A, 10_000, B, 20_000);
        assertThat(service().ledgerCaughtUp(BOOK, S)).as("더 새 관측치를 아직 처리하지 못함").isFalse();
        quotes(kst("2026-11-05T20:30"), A, 10_000, B, 20_000);

        long waiting = order(B, PaperBooks.BUY, 5.0, null, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P2,
                kst("2026-11-04T22:40"), LocalTime.of(10, 15), null);                                            // 목표 세션 P — 1분봉 기다림
        assertThat(service().ledgerCaughtUp(BOOK, S)).as("P 시각 지정 주문이 아직 대기").isFalse();
        store.ledgerHoldMarks.put(waiting, new LedgerHold(waiting, BOOK, B, "그날 1분봉 없음 · 체결하지 않음(만료까지)", processed));
        assertThat(service().ledgerCaughtUp(BOOK, S)).as("장부가 그 관측치로 보류").isTrue();

        store.states.remove(BOOK);
        assertThat(service().ledgerCaughtUp(BOOK, S)).isFalse();
        assertThat(service().ledgerCaughtUp("nope", S)).isFalse();
    }

    @Test
    @DisplayName("뿌리 — 사슬 중간이 지워졌으면 가리킨 번호, 고리·다른 책을 가리키면 거기서 멈춤, 다른 책의 주문이면 없음")
    void rootOf() {
        ObjectNode fromMissing = PaperFixtures.MAPPER.createObjectNode().put(UsTimedFills.REISSUED_FROM, 999_999L);
        long orphan = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_1000, RuleBookService.SOURCE_RULE, P, NIGHT, null, fromMissing);
        assertThat(service().rootOf(BOOK, orphan)).contains(999_999L);

        long first = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_1000, RuleBookService.SOURCE_RULE);
        long second = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_1000, RuleBookService.SOURCE_RULE, P, NIGHT, null,
                PaperFixtures.MAPPER.createObjectNode().put(UsTimedFills.REISSUED_FROM, first));
        store.updateOrderReason(first, PaperFixtures.MAPPER.createObjectNode().put(UsTimedFills.REISSUED_FROM, second));
        assertThat(service().rootOf(BOOK, second)).as("고리").contains(first);

        long other = store.insertOrder(new Order(0, PaperBooks.KR_RULES, null, A, PaperBooks.SELL, null, null, null, PaperBooks.AT_1000,
                RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, P, NIGHT, S, null, null));
        long pointsAcross = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_1000, RuleBookService.SOURCE_RULE, P, NIGHT, null,
                PaperFixtures.MAPPER.createObjectNode().put(UsTimedFills.REISSUED_FROM, other));
        assertThat(service().rootOf(BOOK, pointsAcross)).as("다른 책 주문을 가리킴").contains(pointsAcross);
        assertThat(service().rootOf(BOOK, other)).as("다른 책의 주문").isEmpty();
        assertThat(service().orderStatus(BOOK, first)).contains(PaperBooks.ORDER_PENDING);
        assertThat(service().orderStatus(BOOK, other)).isEmpty();
    }

    @Test
    @DisplayName("책 — 세대는 출발일|만든 시각(출발 전이면 '-'), 달력 — 거래일의 개장·마감, 휴장일, 모르는 해는 없음")
    void bookAndSessionHours() {
        PaperMirrorService.BookInfo info = service().book(BOOK).orElseThrow();
        assertThat(info.generation()).isEqualTo("2026-10-30|2026-10-29T13:00:00Z");
        assertThat(info.active()).isTrue();
        assertThat(info.market()).isEqualTo("KR");
        assertThat(service().book("nope")).isEmpty();
        assertThat(PaperMirrorService.generation(new Book(BOOK, PaperBooks.KIND_CLAUDE, "x", 1, null, PaperBooks.NOT_STARTED,
                Instant.parse("2026-10-29T13:00:00Z"), Book.MARKET_KR, Book.CURRENCY_KRW))).isEqualTo("-|2026-10-29T13:00:00Z");
        assertThat(PaperMirrorService.FOLLOWABLE).containsExactly("kr_rules", "kr_claude", "kr_claude2");

        PaperMirrorService.SessionHours friday = service().sessionHours(S).orElseThrow();
        assertThat(friday.tradingDay()).isTrue();
        assertThat(friday.open()).isEqualTo(kst("2026-11-06T09:00"));
        assertThat(friday.close()).isEqualTo(kst("2026-11-06T15:30"));
        assertThat(service().sessionHours(LocalDate.of(2026, 11, 7)).orElseThrow().tradingDay()).isFalse();
        assertThat(service().sessionHours(LocalDate.of(2028, 1, 3))).as("공휴일 목록이 없는 해").isEmpty();
    }

    @Test
    @DisplayName("표가 없으면 아무것도 읽지 않는다")
    void notReady() {
        store.ready = false;
        assertThat(service().book(BOOK)).isEmpty();
        assertThat(service().openTargets(BOOK, S)).isEmpty();
        assertThat(service().dueOrders(BOOK, S, kst("2026-11-06T10:40"))).isEmpty();
        assertThat(service().ledgerCaughtUp(BOOK, S)).isFalse();
        assertThat(service().claim(BOOK, 1, kst("2026-11-06T10:40"), () -> "x")).isEmpty();
    }

    // ------------------------------------------------------------------ 시각 맞추기(ADR 0033 — 실제 매매·ISA의 개장 10분 뒤 맞추기)
    private static final String RULES = PaperBooks.KR_RULES;

    private void rulesBook() {
        store.books.put(RULES, new Book(RULES, PaperBooks.KIND_RULES, "규칙 계좌", 100_000_000, LocalDate.of(2026, 10, 30),
                PaperBooks.ACTIVE, Instant.parse("2026-10-29T13:00:00Z"), Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(RULES, new BookState(RULES, 1_000_000, 1_000_000, 0, 0, kst("2026-11-05T20:40"), kst("2026-11-05T20:40"), P,
                null));
    }

    private long orderIn(String book, String ticker, String side, Double weight, String timing, String source, LocalDate asOf,
                         Instant createdAt, LocalTime targetLocal) {
        return store.insertOrder(new Order(0, book, null, ticker, side, null, weight, null, timing, source, PaperBooks.ORDER_PENDING,
                null, null, asOf, createdAt, asOf.plusDays(10), null, targetLocal));
    }

    /** 기본 설정 본문에 점 경로 값을 넣어 새 판으로 저장(중간 묶음이 없으면 만듦). */
    private void settings(Object... pathAndValue) {
        ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
        for (int i = 0; i < pathAndValue.length; i += 2) {
            String[] parts = ((String) pathAndValue[i]).split("\\.");
            ObjectNode node = body;
            for (int j = 0; j < parts.length - 1; j++) {
                node = node.get(parts[j]) instanceof ObjectNode child ? child : node.putObject(parts[j]);
            }
            Object value = pathAndValue[i + 1];
            if (value instanceof Boolean b) {
                node.put(parts[parts.length - 1], b);
            } else if (value instanceof JsonNode json) {
                node.set(parts[parts.length - 1], json);
            } else {
                node.put(parts[parts.length - 1], (String) value);
            }
        }
        store.saveSettings(body, List.of());
    }

    @Test
    @DisplayName("시각 맞추기 목표 — 시가 주문과 기준 시각이 T 이하인 시각 지정 주문만 넣고, 시각 지정 STOP은 비중에 반영하되 흡수하지 않는다(R3)")
    void targetsAtIncludesTimedUpToT() {
        position(A, 100, 10_000);
        quotes(kst("2026-11-05T20:30"), A, 10_000, B, 20_000, C, 5_000);
        long open = order(C, PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        long minute = order(B, PaperBooks.BUY, 25.0, null, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P, NIGHT,
                LocalTime.of(9, 10), null);
        long stop = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_MINUTE, PaperBooks.SOURCE_STOP, P, NIGHT, LocalTime.of(9, 10),
                null);
        order(C, PaperBooks.BUY, 5.0, null, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P, NIGHT, LocalTime.of(10, 30), null);
        order(B, PaperBooks.BUY, 5.0, null, PaperBooks.MARKET, PacketBuilder.SOURCE_CLAUDE, P, kst("2026-11-06T09:12"), null, null);

        OpenTargets at0910 = service().targetsAt(BOOK, S, kst("2026-11-06T09:10")).orElseThrow();

        assertThat(at0910.absorbedOrderIds()).as("시가·T 이하 지정 시각 — STOP은 흡수하지 않음").containsExactly(open, minute);
        assertThat(at0910.stopOrderIds()).containsExactly(stop);
        assertThat(at0910.weightPct()).as("스탑 종목은 목표 0").doesNotContainKey(A).containsKeys(B, C);
        assertThat(at0910.complete()).isTrue();
        OpenTargets atOpen = service().openTargets(BOOK, S).orElseThrow();
        assertThat(atOpen.absorbedOrderIds()).containsExactly(open);
        assertThat(atOpen.stopOrderIds()).isEmpty();
        assertThat(atOpen.weightPct()).containsKey(A);
    }

    @Test
    @DisplayName("시각 맞추기 목표 — T가 개장이고 시각 지정 주문이 없으면 시가 목표와 같은 값, 같은 T의 현금성 매수는 마지막")
    void targetsAtMatchesOpenTargetsAndCashLikeLast() {
        position(A, 100, 10_000);
        quotes(kst("2026-11-05T20:30"), A, 10_000, B, 20_000, CASH_LIKE, 100_000);
        order(B, PaperBooks.BUY, 20.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        assertThat(service().targetsAt(BOOK, S, kst("2026-11-06T09:00"))).isEqualTo(service().openTargets(BOOK, S));

        order(CASH_LIKE, PaperBooks.BUY, 90.0, null, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P, NIGHT, LocalTime.of(9, 10),
                null);
        order(B, PaperBooks.BUY, 50.0, null, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P, NIGHT, LocalTime.of(9, 10), null);
        OpenTargets targets = service().targetsAt(BOOK, S, kst("2026-11-06T09:10")).orElseThrow();
        assertThat(targets.weightPct().get(B)).as("신호 종목이 먼저 — 현금성이 현금을 먼저 쓰지 않음").isGreaterThan(40.0);
    }

    @Test
    @DisplayName("일일 맞추기 시각 — 규칙 계좌 지정 시각 주문이 있으면 그 시각, 시가 결정 주문이 남은 날은 시가 맞추기(전환일), 주문이 없으면 설정으로")
    void dailySyncAtForRules() {
        rulesBook();
        assertThat(service().dailySyncAt(RULES, S)).as("기본 설정(NEXT_OPEN) — 시가 맞추기").isEmpty();

        settings("kr.rules.timing", "AT_MINUTE", "kr.rules.timingAtKst", "09:10");
        assertThat(service().dailySyncAt(RULES, S)).as("주문이 없으면 설정 — 09:10").contains(kst("2026-11-06T09:10"));

        long stop = orderIn(RULES, A, PaperBooks.SELL, null, PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_STOP, P, NIGHT, null);
        assertThat(service().dailySyncAt(RULES, S)).as("시가 STOP은 결정 주문이 아님").contains(kst("2026-11-06T09:10"));
        store.markOrderStatus(stop, PaperBooks.ORDER_CANCELLED, "시험");

        long minute = orderIn(RULES, B, PaperBooks.BUY, 10.0, PaperBooks.AT_MINUTE, RuleBookService.SOURCE_RULE, P, NIGHT,
                LocalTime.of(9, 20));
        assertThat(service().dailySyncAt(RULES, S)).as("실제 대기 주문 시각이 먼저").contains(kst("2026-11-06T09:20"));
        store.markOrderStatus(minute, PaperBooks.ORDER_CANCELLED, "시험");

        orderIn(RULES, C, PaperBooks.BUY, 10.0, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, P, NIGHT, null);
        assertThat(service().dailySyncAt(RULES, S)).as("금요일 결정이 시가로 낸 월요일형 — 예전 시가 맞추기").isEmpty();

        assertThat(service().dailySyncAt(RULES, LocalDate.of(2026, 11, 7))).as("토요일").isEmpty();
        assertThat(service().dailySyncAt("nope", S)).isEmpty();
    }

    @Test
    @DisplayName("일일 맞추기 시각 — 수능일형(10:00 개장)은 그날 첫 분 10:10, 운용 중이 아니면 없음")
    void dailySyncAtLateOpenDay() {
        rulesBook();
        ObjectNode overrides = PaperFixtures.MAPPER.createObjectNode();
        overrides.putObject("2026-11-19").put("open", "10:00").put("close", "16:30");
        settings("kr.rules.timing", "AT_MINUTE", "kr.rules.timingAtKst", "09:10", "kr.calendar.openTimeOverrides", overrides);
        LocalDate exam = LocalDate.of(2026, 11, 19);
        assertThat(service().dailySyncAt(RULES, exam)).contains(kst("2026-11-19T10:10"));

        Book active = store.books.get(RULES);
        store.books.put(RULES, new Book(RULES, active.kind(), active.label(), active.initialCash(), active.startedOn(), "PAUSED",
                active.createdAt(), Book.MARKET_KR, Book.CURRENCY_KRW));
        assertThat(service().dailySyncAt(RULES, exam)).as("멈춘 책").isEmpty();
    }

    @Test
    @DisplayName("일일 맞추기 시각 — Claude 계좌는 자유 시점 판이 켜져 있을 때만 그 세션 첫 분")
    void dailySyncAtForClaude() {
        assertThat(service().dailySyncAt(BOOK, S)).as("끈 판").isEmpty();
        settings("kr.claude2.freeTiming", Boolean.TRUE);
        assertThat(service().dailySyncAt(BOOK, S)).contains(kst("2026-11-06T09:10"));
        order(B, PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE);
        assertThat(service().dailySyncAt(BOOK, S)).as("배포 전 결정의 시가 주문이 남은 날").isEmpty();
    }

    @Test
    @DisplayName("대기 STOP 종목 — 그 세션이 목표인 출처 STOP 매도와 목표 세션이 지난 만료 전 STOP(다음 세션 STOP·STOP 아닌 매도는 아님)")
    void pendingStopSymbols() {
        order(A, PaperBooks.SELL, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP, P, kst("2026-11-06T10:20"), null, null);
        order(B, PaperBooks.SELL, null, null, PaperBooks.AT_MINUTE, PaperBooks.SOURCE_STOP, S, kst("2026-11-06T21:30"),
                LocalTime.of(9, 10), null);
        order(C, PaperBooks.SELL, null, 1.0, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P, NIGHT, LocalTime.of(10, 0), null);
        long filled = order(C, PaperBooks.SELL, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP, P, kst("2026-11-06T11:00"), null,
                null);
        store.markOrderStatus(filled, PaperBooks.ORDER_FILLED, null);

        assertThat(service().pendingStopSymbols(BOOK, S)).containsExactly(A);
        assertThat(service().pendingStopSymbols(BOOK, LocalDate.of(2026, 11, 9))).as("S가 목표인 A STOP도 만료 전이면 듦(QA-328)")
                .containsExactlyInAnyOrder(A, B);
        assertThat(service().pendingStopSymbols("nope", S)).isEmpty();
    }

    // QA-328: 2차 리뷰 재검증 R2V-2 — 목표 세션이 지난 대기 STOP이 다음 세션 목표·대기 STOP 종목에서 빠짐. targets(시가·시각 지정 주문)와
    // pendingStopSymbols가 목표 세션 = 그 세션인 주문만 봐서, P 09:10 밤 대체 STOP(기준 P2, 만료 P2 + 3거래일)으로 실제 계좌가 P에 A를 판 뒤 모의
    // 장부가 그 STOP을 아직 체결하지 못했으면(장부가 기다리지 않는 보류·그날 봉 없음 등으로 S 맞추기가 돌 때) S 09:10 묶음이 장부 보유대로 A를 다시
    // 사고 매수 직전 확인도 막지 않음. 뒤에 모의가 P 09:10 값으로 체결하면 실제 계좌는 다음 묶음에서 다시 팖(실제 돈 왕복).
    @Test
    @DisplayName("목표 세션이 지난 대기 STOP(P 09:10 밤 대체 STOP — 아직 대기)은 S 목표에서 그 종목 비중 0·흡수 아님(stopOrderIds), 그 주문 뒤 비중에도 들고 "
            + "S 대기 STOP 종목에 듦 — 만료된 STOP·STOP 아닌 매도는 아님, 장중 주문 목록에는 넣지 않음(QA-328)")
    void staleStopCountsForTheNextSession() {
        position(A, 100, 10_000);
        position(B, 50, 20_000);
        position(C, 100, 5_000);
        quotes(kst("2026-11-05T20:30"), A, 10_000, B, 20_000, C, 5_000);
        ObjectNode night = PaperFixtures.MAPPER.createObjectNode().put("stopMode", PaperLedgerService.STOP_MODE_NIGHT_FALLBACK);
        long stale = order(A, PaperBooks.SELL, null, null, PaperBooks.AT_MINUTE, PaperBooks.SOURCE_STOP, P2, kst("2026-11-04T21:15"),
                LocalTime.of(9, 10), night);
        // 만료가 P인 P 감시 STOP — S에는 체결될 수 없음(S 밤 처리의 만료가 닫음)
        ObjectNode watch = PaperFixtures.MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE);
        store.insertOrder(new Order(0, BOOK, null, C, PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                PaperBooks.ORDER_PENDING, null, watch, P2, kst("2026-11-05T10:20"), P, null));
        order(B, PaperBooks.SELL, null, 1.0, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, P2, kst("2026-11-04T22:40"),
                LocalTime.of(10, 0), null);                                                                    // 목표 세션이 지난 결정 매도
        long halfA = order(A, PaperBooks.SELL, null, 0.5, PaperBooks.MARKET, PacketBuilder.SOURCE_CLAUDE, P, kst("2026-11-06T10:00"),
                null, null);                                                                                   // S 장중 확인의 A 절반 매도

        OpenTargets at0910 = service().targetsAt(BOOK, S, kst("2026-11-06T09:10")).orElseThrow();
        assertThat(at0910.weightPct()).as("S 09:10 묶음이 A를 다시 사지 않음 — 만료된 C STOP·결정 매도는 그대로").doesNotContainKey(A)
                .containsKeys(B, C);
        assertThat(at0910.stopOrderIds()).containsExactly(stale);
        assertThat(at0910.absorbedOrderIds()).doesNotContain(stale);
        assertThat(at0910.complete()).isTrue();
        OpenTargets atOpen = service().openTargets(BOOK, S).orElseThrow();
        assertThat(atOpen.weightPct()).as("시가 맞추기 날도 같음").doesNotContainKey(A).containsKeys(B, C);
        assertThat(atOpen.stopOrderIds()).containsExactly(stale);
        assertThat(atOpen.absorbedOrderIds()).isEmpty();

        WeightAfter afterHalf = service().weightAfter(BOOK, halfA, kst("2026-11-06T10:02")).orElseThrow();
        assertThat(afterHalf.assumedOrderIds()).as("지난 STOP이 먼저 A를 모두 팖 — 절반 매도는 팔 보유가 없음").containsExactly(stale);
        assertThat(afterHalf.weightPct()).isZero();

        assertThat(service().pendingStopSymbols(BOOK, S)).containsExactly(A);
        assertThat(service().pendingStopSymbols(BOOK, P)).containsExactlyInAnyOrder(A, C);
        assertThat(service().dueOrders(BOOK, S, kst("2026-11-06T15:30"))).as("스탑 매도 경로는 다시 팔지 않음 — S 장중 주문은 절반 매도뿐")
                .extracting(DueOrder::orderId).containsExactly(halfA);
    }

    @Test
    @DisplayName("사다리 가격 — 지정 시각 창 첫 거래 봉 시가, 그날 1분봉 없음은 체결 안 됨, 창이 아예 없는 종목은 창 없음(ISA 시가 어림 판단)")
    void ladderPrices() {
        Instant fetched = kst("2026-11-06T20:40");
        KrFixtures.Payload payload = new KrFixtures.Payload(S);
        payload.code(A, fetched).bar(P, 10_000, 10_000, 1_000).bar(S, 10_050, 9_800, 2_000).minute("OK", "09:01", 10_050, 100);
        payload.code(B, fetched).bar(P, 20_000, 20_000, 1_000).bar(S, 20_100, 20_200, 2_000).minute("OK", "09:01", 20_100, 100);
        payload.code(C, fetched).bar(P, 5_000, 5_000, 1_000).bar(S, 5_010, 5_020, 2_000).minute("OK", "09:01", 5_010, 100);
        when(marketData.quotes(any())).thenReturn(KrQuotes.parse(payload.snapshot(kst("2026-11-06T20:45"))));
        when(marketData.krTimed()).thenReturn(Map.of(
                A, Map.of(S, new KrQuotes.Timed(KrQuotes.TIMED_OK, null, kst("2026-11-06T16:41"),
                        Map.of("09:10", List.of(new KrQuotes.Bar1m("09:11", java.math.BigDecimal.valueOf(10_100), 50L)),
                                "11:32", List.of(new KrQuotes.Bar1m("11:33", java.math.BigDecimal.valueOf(9_700), 70L))),
                        Map.of(), Map.of())),
                B, Map.of(S, new KrQuotes.Timed(KrQuotes.TIMED_NO_BARS, null, kst("2026-11-06T16:41"), Map.of(), Map.of(), Map.of()))));

        Map<String, PaperMirrorService.LadderPrice> prices = service().pricesAt(S, LocalTime.of(9, 10), List.of(A, B, C));

        assertThat(prices.get(A).price()).isEqualByComparingTo("10100");
        assertThat(prices.get(B).unfillable()).isTrue();
        assertThat(prices.get(C).noWindow()).as("그 시각 모의 주문이 없던 종목").isTrue();
        assertThat(prices.get(C).price()).isNull();

        long stop = order(A, PaperBooks.SELL, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP, P, kst("2026-11-06T11:30:10"), null,
                null);                                                                                           // 기준 분 11:32
        assertThat(service().orderLadderPrice(BOOK, stop).orElseThrow().price()).as("그 주문과 같은 사다리").isEqualByComparingTo("9700");
        long open = order(A, PaperBooks.SELL, null, null, PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_STOP);
        assertThat(service().orderLadderPrice(BOOK, open)).as("시각 지정 시점이 아님").isEmpty();
        assertThat(service().orderLadderPrice("nope", stop)).isEmpty();
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("시험 대기 시간 초과");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
