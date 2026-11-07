package com.macrodash.store;

import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.NewOrder;
import com.macrodash.store.RealTradeStore.OrderRow;
import com.macrodash.store.RealTradeStore.OutcomeWrite;
import com.macrodash.store.RealTradeStore.Valuation;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 실제 매매 표(V24, ADR 0028) — 실제 테스트 DB(macrodash_test)에서 설정 잠금·버전 충돌·SENDING 유일·결과 기록·이벤트를 확인합니다.
 *
 * <p>운영 DB로 돌지 않도록 이름이 {@code _test}로 끝나는지 먼저 확인합니다. 네 표는 이 기능만 쓰므로 시험 앞뒤로 통째로 비웁니다. 종목·금액·주문 번호는
 * 모두 합성 값입니다.
 */
class RealTradeStoreDbTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final LocalDate SESSION = LocalDate.of(2026, 11, 6);
    private static final Instant AT = Instant.parse("2026-11-05T23:51:00Z");

    private JdbcTemplate jdbc;
    private RealTradeStore store;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL",
                "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        store = new RealTradeStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM real_trade_orders");
        jdbc.update("DELETE FROM real_trade_batches");
        jdbc.update("DELETE FROM real_trade_events");
        jdbc.update("DELETE FROM real_trade_config");
        jdbc.update("DELETE FROM real_trade_valuation");
    }

    private static NewOrder mirror(long paperOrderId, long rootId, int attempt) {
        String key = UUID.randomUUID().toString();
        return new NewOrder("KR", SESSION, RealTradeStore.PURPOSE_MIRROR, null, "kr_claude2", "2026-10-30|gen", paperOrderId,
                rootId, "005930", "BUY", 3, "DAY", new BigDecimal("70000"), attempt, key, "{\"clientOrderId\":\"" + key + "\"}",
                AT);
    }

    private static NewOrder sync(long batchId, String symbol, int attempt) {
        String key = UUID.randomUUID().toString();
        return new NewOrder("KR", SESSION, RealTradeStore.PURPOSE_SYNC, batchId, "kr_claude2", "2026-10-30|gen", null, null,
                symbol, "SELL", 10, "OPG", new BigDecimal("12345.5"), attempt, key, "{\"k\":\"" + key + "\"}", AT);
    }

    private Config live() {
        boolean updated = store.lockConfig("KR", current -> store.updateConfig(
                current.withState(RealTradeStore.STATE_LIVE).withSource("kr_claude2", "2026-10-30|gen"), 7L));
        assertThat(updated).isTrue();
        return store.config("KR").orElseThrow();
    }

    @Test
    @DisplayName("행이 없으면 꺼짐 — 처음 잠글 때 OFF 행을 만들고, 버전이 같을 때만 바꾸며 바꿀 때마다 버전이 는다")
    void configLockAndVersion() {
        assertThat(store.ready()).isTrue();
        assertThat(store.config("KR")).isEmpty();
        assertThat(store.configOrOff("KR").state()).isEqualTo("OFF");
        assertThat(store.configOrOff("KR").version()).isZero();

        Config locked = store.lockConfig("KR", current -> current);
        assertThat(locked.state()).isEqualTo("OFF");
        assertThat(locked.lossLimitPct()).isEqualByComparingTo("15");
        assertThat(locked.version()).isZero();

        Config live = live();
        assertThat(live.state()).isEqualTo("LIVE");
        assertThat(live.version()).isEqualTo(1);
        assertThat(live.updatedBy()).isEqualTo(7L);

        // 읽은 버전(0)이 지금(1)과 다르면 바꾸지 않는다 — 화면이 본 판과 다른 저장(409 version-conflict의 근거).
        assertThat(store.updateConfig(locked.withState(RealTradeStore.STATE_OFF), 7L)).isFalse();
        assertThat(store.config("KR").orElseThrow().state()).isEqualTo("LIVE");

        Config halted = store.config("KR").orElseThrow().withState(RealTradeStore.STATE_HALTED)
                .withHalt("unknown-order", MAPPER.valueToTree(Map.of("count", 1)));
        assertThat(store.updateConfig(halted, null)).isTrue();
        Config saved = store.config("KR").orElseThrow();
        assertThat(saved.version()).isEqualTo(2);
        assertThat(saved.haltReason()).isEqualTo("unknown-order");
        assertThat(saved.haltDetail().path("count").asInt()).isEqualTo(1);
        assertThat(saved.updatedBy()).isNull();
    }

    @Test
    @DisplayName("LIVE 행은 따라 하는 책·세대가 있어야 한다 — 손실 한도는 1~50")
    void configChecks() {
        store.lockConfig("KR", current -> current);
        Config current = store.config("KR").orElseThrow();
        assertThatThrownBy(() -> store.updateConfig(current.withState(RealTradeStore.STATE_LIVE), 1L))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.updateConfig(current.withLossLimitPct(new BigDecimal("60")), 1L))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(store.config("KR").orElseThrow().version()).isZero();
    }

    @Test
    @DisplayName("끄기가 잡은 동안 SENDING을 쓰려는 쪽은 기다렸다가 바뀐 상태(STOPPING)를 보고 쓰지 않는다")
    void disableBlocksNewSending() throws Exception {
        live();
        CountDownLatch disableHolds = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<?> disable = pool.submit(() -> store.lockConfig("KR", current -> {
                store.updateConfig(current.withState(RealTradeStore.STATE_STOPPING), 7L);
                disableHolds.countDown();
                sleep(400);
                return null;
            }));
            assertThat(disableHolds.await(5, TimeUnit.SECONDS)).isTrue();
            Future<Optional<Long>> sending = pool.submit(() -> store.lockConfig("KR", current ->
                    RealTradeStore.STATE_LIVE.equals(current.state()) ? store.insertSending(mirror(11, 11, 1)) : Optional.<Long>empty()));
            disable.get(10, TimeUnit.SECONDS);
            assertThat(sending.get(10, TimeUnit.SECONDS)).isEmpty();
        } finally {
            pool.shutdownNow();
        }
        assertThat(store.config("KR").orElseThrow().state()).isEqualTo("STOPPING");
        assertThat(store.unfinishedOrders("KR")).isEmpty();
    }

    @Test
    @DisplayName("같은 뿌리·용도·시도, 같은 묶음 종목·용도·시도, 같은 키는 한 행 — 중복은 예외 없이 빈 값이고 같은 트랜잭션이 이어진다")
    void sendingIsUniqueWithoutAbortingTheTransaction() {
        live();
        RealTradeStore.Batch batch = store.upsertBatch("KR", SESSION, RealTradeStore.BATCH_SYNC, "kr_claude2",
                MAPPER.valueToTree(Map.of("005930", 12.5)), List.of(101L, 102L), new BigDecimal("1000000"));

        List<Optional<Long>> results = store.lockConfig("KR", current -> {
            Optional<Long> first = store.insertSending(mirror(11, 10, 1));
            Optional<Long> sameRoot = store.insertSending(mirror(12, 10, 1));   // 재발행 주문 — 뿌리가 같음
            Optional<Long> secondAttempt = store.insertSending(mirror(11, 10, 2));
            Optional<Long> syncFirst = store.insertSending(sync(batch.id(), "000660", 1));
            Optional<Long> syncAgain = store.insertSending(sync(batch.id(), "000660", 1));
            NewOrder sameKey = mirror(13, 13, 1);
            Optional<Long> keyFirst = store.insertSending(sameKey);
            Optional<Long> keyAgain = store.insertSending(new NewOrder("KR", SESSION, "MIRROR", null, "kr_claude2", "g", 14L, 14L,
                    "000660", "SELL", 1, "DAY", null, 1, sameKey.clientOrderId(), "{}", AT));
            store.addEvent("KR", RealTradeStore.EVENT_WINDOW_SUMMARY, null, Map.of("accepted", 3), true);
            return List.of(first, sameRoot, secondAttempt, syncFirst, syncAgain, keyFirst, keyAgain);
        });

        assertThat(results.get(0)).isPresent();
        assertThat(results.get(1)).as("같은 뿌리").isEmpty();
        assertThat(results.get(2)).as("시도 2는 다른 행").isPresent();
        assertThat(results.get(3)).isPresent();
        assertThat(results.get(4)).as("같은 묶음 종목").isEmpty();
        assertThat(results.get(5)).isPresent();
        assertThat(results.get(6)).as("같은 클라이언트 키").isEmpty();
        assertThat(store.unfinishedOrders("KR")).hasSize(4)
                .allSatisfy(row -> assertThat(row.sendOutcome()).isEqualTo("SENDING"));
        assertThat(store.recentEvents("KR", 5)).as("중복 뒤의 쓰기도 커밋됨").hasSize(1);
        assertThat(store.ordersForRoot("KR", 10)).hasSize(2);
        assertThat(store.ordersForBatch(batch.id())).hasSize(1);
    }

    @Test
    @DisplayName("용도별 키·시도 상한·수량·한국 종목 모양은 DB가 막는다 — 잠금 안의 예외는 그 트랜잭션의 쓰기를 모두 되돌린다")
    void checksAndRollback() {
        live();
        NewOrder mirrorWithoutRoot = new NewOrder("KR", SESSION, "MIRROR", null, "kr_claude2", "g", 5L, null, "005930", "BUY", 1,
                "DAY", null, 1, UUID.randomUUID().toString(), "{}", AT);
        NewOrder syncWithoutBatch = new NewOrder("KR", SESSION, "SYNC", null, "kr_claude2", "g", null, null, "005930", "BUY", 1,
                "OPG", null, 1, UUID.randomUUID().toString(), "{}", AT);
        assertThatThrownBy(() -> store.insertSending(mirrorWithoutRoot)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.insertSending(syncWithoutBatch)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.insertSending(mirror(20, 20, 3))).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.insertSending(new NewOrder("KR", SESSION, "MIRROR", null, "kr_claude2", "g", 21L, 21L,
                "AAPL", "BUY", 1, "DAY", null, 1, UUID.randomUUID().toString(), "{}", AT)))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.insertSending(new NewOrder("KR", SESSION, "MIRROR", null, "kr_claude2", "g", 22L, 22L,
                "005930", "BUY", 0, "DAY", null, 1, UUID.randomUUID().toString(), "{}", AT)))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> store.lockConfig("KR", current -> {
            store.insertSending(mirror(30, 30, 1));
            store.updateConfig(current.withState(RealTradeStore.STATE_HALTED).withHalt("turnover", null), null);
            throw new IllegalStateException("시험 — 되돌림");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(store.unfinishedOrders("KR")).isEmpty();
        assertThat(store.config("KR").orElseThrow().state()).isEqualTo("LIVE");
    }

    @Test
    @DisplayName("결과 기록 — SENDING·UNKNOWN만 바뀌고, UNKNOWN은 NOT_SENT로 내리지 않으며, 한 토스 주문 번호는 한 행에만")
    void outcomes() {
        live();
        long a = store.insertSending(mirror(40, 40, 1)).orElseThrow();
        long b = store.insertSending(mirror(41, 41, 1)).orElseThrow();
        long c = store.insertSending(mirror(42, 42, 1)).orElseThrow();

        store.recordSend(a, AT.plusSeconds(1));
        store.recordSend(a, AT.plusSeconds(30));
        assertThat(store.recordOutcome(a, "UNKNOWN", "collector-timeout", null)).isEqualTo(OutcomeWrite.WRITTEN);
        assertThat(store.recordOutcome(a, "NOT_SENT", "connect-refused", null)).as("UNKNOWN → NOT_SENT 금지")
                .isEqualTo(OutcomeWrite.STALE);
        assertThat(store.recordOutcome(a, "ACCEPTED", null, "TOSSORDER-A")).isEqualTo(OutcomeWrite.WRITTEN);
        assertThat(store.recordOutcome(a, "UNKNOWN", null, null)).as("정해진 결과는 바꾸지 않음").isEqualTo(OutcomeWrite.STALE);
        assertThat(store.recordOutcome(b, "UNKNOWN", null, null)).isEqualTo(OutcomeWrite.WRITTEN);
        assertThat(store.recordOutcome(b, "ACCEPTED", "reconciled", "TOSSORDER-A")).isEqualTo(OutcomeWrite.TOSS_ID_IN_USE);
        assertThat(store.recordOutcome(c, "REJECTED", "opposite-pending-order-exists", null)).isEqualTo(OutcomeWrite.WRITTEN);
        assertThatThrownBy(() -> store.recordOutcome(c, "ACCEPTED", null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.recordOutcome(c, "SENDING", null, null)).isInstanceOf(IllegalArgumentException.class);

        OrderRow rowA = store.order(a).orElseThrow();
        assertThat(rowA.sendOutcome()).isEqualTo("ACCEPTED");
        assertThat(rowA.tossOrderId()).isEqualTo("TOSSORDER-A");
        assertThat(rowA.sendCount()).isEqualTo(2);
        assertThat(rowA.lastSentAt()).isEqualTo(AT.plusSeconds(30));
        assertThat(rowA.firstSentAt()).isEqualTo(AT);
        assertThat(rowA.terminal()).isFalse();
        assertThat(rowA.toString()).as("toString에 토스 주문 번호·요청 본문·클라이언트 키 없음")
                .doesNotContain("TOSSORDER-A", rowA.clientOrderId(), rowA.requestBody());
        assertThat(store.order(c).orElseThrow().terminal()).as("REJECTED는 종료").isTrue();
        assertThat(store.boundTossOrderIds("KR")).containsExactly("TOSSORDER-A");

        assertThat(store.recordTracking(a, new RealTradeStore.Tracking("FILLED", true, new BigDecimal("3"),
                new BigDecimal("70100.5"), new BigDecimal("210301.5"), new BigDecimal("31"), BigDecimal.ZERO, AT.plusSeconds(600))))
                .isTrue();
        assertThat(store.recordTracking(a, new RealTradeStore.Tracking("PENDING", false, null, null, null, null, null, null)))
                .isTrue();
        OrderRow tracked = store.order(a).orElseThrow();
        assertThat(tracked.terminal()).as("종료는 되돌리지 않음").isTrue();
        assertThat(store.recordTracking(b, new RealTradeStore.Tracking("FILLED", true, null, null, null, null, null, null)))
                .as("토스 주문 번호 없는 행").isFalse();
        store.recordCancel(b, AT.plusSeconds(5), "ACCEPTED");
        store.recordCancel(b, AT.plusSeconds(50), "already-filled");
        OrderRow canceled = store.order(b).orElseThrow();
        assertThat(canceled.cancelRequestedAt()).isEqualTo(AT.plusSeconds(5));
        assertThat(canceled.cancelOutcome()).isEqualTo("already-filled");
        assertThat(store.unfinishedOrders("KR")).extracting(OrderRow::id).containsExactly(b);
        assertThat(store.ordersOn("KR", SESSION)).hasSize(3);
        assertThat(store.recentOrders("KR", 2)).extracting(OrderRow::id).containsExactly(c, b);
    }

    @Test
    @DisplayName("기준 총액(상한 없는 총액)을 기준 평가액과 함께 저장 — 취소는 보낸 횟수·마지막 시각을 행에, 포기는 미종료 행에 한 번만, 끝난 행은 끝난 시각으로 고름")
    void baselineTotalCancelCountsAndEnded() {
        Config live = live();
        assertThat(live.baselineTotal()).isNull();
        assertThat(store.updateConfig(live.withBaselineEquity(new BigDecimal("10000000")).withBaselineTotal(new BigDecimal("30000000.50")),
                7L)).isTrue();
        Config saved = store.config("KR").orElseThrow();
        assertThat(saved.baselineEquity()).isEqualByComparingTo("10000000");
        assertThat(saved.baselineTotal()).isEqualByComparingTo("30000000.50");

        long a = store.lockConfig("KR", current -> store.insertSending(mirror(101, 100, 1))).orElseThrow();
        long b = store.lockConfig("KR", current -> store.insertSending(mirror(111, 110, 1))).orElseThrow();
        assertThat(store.recordOutcome(a, "ACCEPTED", null, "TOSSORDER-A")).isEqualTo(OutcomeWrite.WRITTEN);
        assertThat(store.recordOutcome(b, "ACCEPTED", null, "TOSSORDER-B")).isEqualTo(OutcomeWrite.WRITTEN);
        assertThat(store.order(a).orElseThrow().cancelCount()).isZero();
        store.recordCancel(a, AT.plusSeconds(5), "NOT_SENT:collector-unreachable");
        store.recordCancel(a, AT.plusSeconds(40), "REJECTED:rate-limited");
        OrderRow canceled = store.order(a).orElseThrow();
        assertThat(canceled.cancelRequestedAt()).isEqualTo(AT.plusSeconds(5));
        assertThat(canceled.cancelLastAt()).isEqualTo(AT.plusSeconds(40));
        assertThat(canceled.cancelCount()).isEqualTo(2);
        assertThat(canceled.cancelOutcome()).isEqualTo("REJECTED:rate-limited");

        assertThat(store.markCancelGaveUp(List.of(a), AT.plusSeconds(200))).isEqualTo(1);
        assertThat(store.markCancelGaveUp(List.of(a), AT.plusSeconds(300))).as("한 번만").isZero();
        assertThat(store.markCancelGaveUp(List.of(), AT)).isZero();
        assertThat(store.order(a).orElseThrow().cancelGaveUpAt()).isEqualTo(AT.plusSeconds(200));

        Instant since = jdbc.queryForObject("SELECT now()", java.sql.Timestamp.class).toInstant();
        assertThat(store.recordTracking(b, new RealTradeStore.Tracking("CANCELED", true, BigDecimal.ZERO, null, null, null, null, null)))
                .isTrue();
        assertThat(store.endedSince("KR", since)).extracting(OrderRow::id).containsExactly(b);
        assertThat(store.markCancelGaveUp(List.of(b), AT)).as("끝난 행은 포기로 표시하지 않음").isZero();
    }

    @Test
    @DisplayName("묶음은 시장·거래일·종류마다 하나 — 다시 쓰면 같은 번호에 목표만 바뀐다")
    void batchUpsert() {
        RealTradeStore.Batch first = store.upsertBatch("KR", SESSION, "SYNC", "kr_claude2", MAPPER.valueToTree(Map.of("005930", 10)),
                List.of(1L, 2L), new BigDecimal("1000"));
        RealTradeStore.Batch second = store.upsertBatch("KR", SESSION, "SYNC", "kr_claude2", MAPPER.valueToTree(Map.of("000660", 20)),
                List.of(3L), new BigDecimal("2000"));
        assertThat(second.id()).isEqualTo(first.id());
        RealTradeStore.Batch saved = store.batch("KR", SESSION, "SYNC").orElseThrow();
        assertThat(saved.targets().has("005930")).isFalse();
        assertThat(saved.targets().path("000660").asInt()).isEqualTo(20);
        assertThat(saved.absorbedOrderIds()).containsExactly(3L);
        assertThat(saved.equity()).isEqualByComparingTo("2000");
        assertThat(store.batch(first.id())).isPresent();
        assertThat(store.batch("KR", SESSION.plusDays(1), "SYNC")).isEmpty();
    }

    @Test
    @DisplayName("가장 최근 묶음 — 그 시장·종류에서 번호가 가장 큰 것(다른 시장은 보지 않음), 없으면 empty")
    void latestBatch() {
        assertThat(store.latestBatch("KR", "SYNC")).isEmpty();
        store.upsertBatch("KR", SESSION.minusDays(1), "SYNC", "kr_claude2", MAPPER.valueToTree(Map.of("005930", 10)), List.of(),
                new BigDecimal("1000"));
        RealTradeStore.Batch later = store.upsertBatch("KR", SESSION, "SYNC", "kr_claude2", MAPPER.valueToTree(Map.of("000660", 20)),
                List.of(), new BigDecimal("1000"));
        store.upsertBatch("US", SESSION.plusDays(1), "SYNC", "kr_claude2", MAPPER.valueToTree(Map.of("005930", 30)), List.of(),
                new BigDecimal("1000"));
        assertThat(store.latestBatch("KR", "SYNC")).map(RealTradeStore.Batch::id).contains(later.id());
        assertThat(store.latestBatch("KR", "OTHER")).isEmpty();
    }

    @Test
    @DisplayName("알림 대기 — 알림 대상이고 아직 보내지 않은 이벤트만, 표시는 한 번")
    void eventsAndNotifications() {
        long quiet = store.addEvent("KR", RealTradeStore.EVENT_UPDATE, 7L, Map.of("sourceBook", "kr_claude2"), false);
        long halt = store.addEvent("KR", RealTradeStore.EVENT_HALT, null, Map.of("reason", "unknown-order"), true);
        long summary = store.addEvent("KR", RealTradeStore.EVENT_WINDOW_SUMMARY, null, (Map<String, ?>) null, true);

        assertThat(store.unnotifiedEvents(10)).extracting(RealTradeStore.Event::id).containsExactly(halt, summary);
        assertThat(store.markNotified(halt, AT)).isTrue();
        assertThat(store.markNotified(halt, AT.plusSeconds(1))).isFalse();
        assertThat(store.unnotifiedEvents(10)).extracting(RealTradeStore.Event::id).containsExactly(summary);
        List<RealTradeStore.Event> recent = store.recentEvents("KR", 10);
        assertThat(recent).extracting(RealTradeStore.Event::id).containsExactly(summary, halt, quiet);
        assertThat(recent.get(1).detail().path("reason").asString()).isEqualTo("unknown-order");
        assertThat(recent.get(0).detail().isObject()).isTrue();
        assertThat(recent.get(2).userId()).isEqualTo(7L);
        assertThatThrownBy(() -> store.addEvent("KR", "lower-case", null, (Map<String, ?>) null, false))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    @DisplayName("연속 비밀번호 실패는 마지막 성공(켜기·바꾸기·해제) 뒤의 것만 센다")
    void passwordFailures() {
        Instant start = Instant.now().minusSeconds(5);
        store.addEvent("KR", RealTradeStore.EVENT_PASSWORD_FAILED, 7L, Map.of(), false);
        store.addEvent("KR", RealTradeStore.EVENT_PASSWORD_FAILED, 7L, Map.of(), false);
        assertThat(store.passwordFailuresSinceLastSuccess(start)).hasSize(2);
        sleep(20);
        store.addEvent("KR", RealTradeStore.EVENT_ENABLE, 7L, Map.of(), true);
        sleep(20);
        assertThat(store.passwordFailuresSinceLastSuccess(start)).isEmpty();
        store.addEvent("US", RealTradeStore.EVENT_PASSWORD_FAILED, 7L, Map.of(), false);
        assertThat(store.passwordFailuresSinceLastSuccess(start)).as("시장과 상관없이 셈").hasSize(1);
        assertThat(store.passwordFailuresSinceLastSuccess(Instant.now().plusSeconds(60))).isEmpty();
    }

    @Test
    @DisplayName("마지막 운용 평가액(V29) — 시장마다 한 행, 새 값으로 바꾸되 읽은 시각이 지금 행보다 이르면 덮지 않음")
    void valuationKeepsLatest() {
        assertThat(store.valuationReady()).as("make db-test로 V29까지 적용했는가").isTrue();
        assertThat(store.valuation("KR")).isEmpty();
        Instant t1 = Instant.parse("2026-11-06T06:40:00Z");
        store.saveValuation(new Valuation("KR", t1, new BigDecimal("1000.50"), null, new BigDecimal("200")));
        assertThat(store.valuation("KR")).hasValueSatisfying(v -> {
            assertThat(v.fetchedAt()).isEqualTo(t1);
            assertThat(v.equity()).isEqualByComparingTo("1000.50");
            assertThat(v.total()).as("모르면 null 그대로").isNull();
            assertThat(v.cashBuyingPower()).isEqualByComparingTo("200");
        });

        store.saveValuation(new Valuation("KR", t1.minusSeconds(60), new BigDecimal("1"), new BigDecimal("1"), new BigDecimal("1")));
        assertThat(store.valuation("KR")).hasValueSatisfying(v -> assertThat(v.equity()).as("늦게 끝난 옛 조회").isEqualByComparingTo("1000.50"));

        store.saveValuation(new Valuation("KR", t1.plusSeconds(60), new BigDecimal("2000"), new BigDecimal("2500"), new BigDecimal("300")));
        assertThat(store.valuation("KR")).hasValueSatisfying(v -> {
            assertThat(v.fetchedAt()).isEqualTo(t1.plusSeconds(60));
            assertThat(v.total()).isEqualByComparingTo("2500");
        });
        assertThat(store.valuation("US")).isEmpty();
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
