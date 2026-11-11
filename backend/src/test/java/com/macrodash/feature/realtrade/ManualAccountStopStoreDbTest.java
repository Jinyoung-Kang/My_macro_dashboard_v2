package com.macrodash.feature.realtrade;

import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.NewInstruction;
import com.macrodash.store.ManualAccountStore.NewStopInstruction;
import com.macrodash.store.ManualAccountStore.StopInstruction;
import com.macrodash.store.ManualAccountStore.TradeValues;
import com.macrodash.store.SchemaCheck;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.realtrade.RealTradeFixtures.MAPPER;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static com.macrodash.feature.realtrade.RealTradeFixtures.kst;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * ISA 계좌의 장중 스탑 매도 지시 표(V28)와 잔고 표(V31 — ADR 0033·0034)를 실제 테스트 DB로: 모의 STOP 주문 하나에 지시 하나, 같은 날 같은 종목의 다음 시가 지시와
 * 함께 있음, 옛 코드의 다음 시가 지시 문장({@code ON CONFLICT (account, session, symbol)})이 그대로 동작(되돌리기 호환), 매매 내역은 두 지시 가운데 하나에만 묶임,
 * 상태·알림 시각, 계좌를 지우면(옛 QA 복원 순서) 함께 지워짐. 종목·금액은 모두 합성 값입니다.
 */
class ManualAccountStopStoreDbTest {

    private static final String CODE = ManualAccountService.CODE;
    private static final String A = ManualAccountServiceDbTest.A;
    private static final String B = ManualAccountServiceDbTest.B;
    private static final LocalDate MONDAY = ManualAccountServiceDbTest.MONDAY;
    private static final Instant T = kst("2026-11-09T10:42");

    private JdbcTemplate jdbc;
    private ManualAccountStore store;

    @BeforeEach
    void setUp() {
        jdbc = RealTradeFixtures.jdbc();
        store = new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        ManualAccountServiceDbTest.clean(jdbc);
        assertThat(store.insertAccount(CODE, "ISA 계좌", ManualAccountStore.MARKET_KR, "kr_rules", kst("2026-11-06T14:55"), d("1000000")))
                .isTrue();
    }

    @AfterEach
    void tearDown() {
        ManualAccountServiceDbTest.clean(jdbc);
    }

    private NewStopInstruction stop(long paperOrderId, String symbol, int quantity, String timing) {
        return new NewStopInstruction(MONDAY, paperOrderId, symbol, quantity, timing, T, MAPPER.createObjectNode().put("paperOrderId", paperOrderId));
    }

    @Test
    @DisplayName("준비 — V28의 표·칸이 있어야 준비됨(백엔드만 새로 띄운 배포에서 장부 조회의 SQL 오류 대신 '준비 중'), 시험 뒤 되돌림")
    void readyRequiresV28() {
        class Rollback extends RuntimeException {
        }
        assertThat(store.ready()).as("make db-test로 V28까지 적용했는가").isTrue();
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("ALTER TABLE manual_ledger DROP COLUMN stop_instruction_id");
            assertThat(new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("장부의 스탑 지시 칸이 없으면").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("DROP TABLE manual_stop_instructions CASCADE");
            assertThat(new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("스탑 지시 표가 없으면").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(store.ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("모의 STOP 주문 하나에 지시 하나 — 같은 주문은 두 번 넣지 않고(empty), 같은 날 같은 종목의 다른 주문·다음 시가 지시와 함께 있음, 목록·상태·알림 시각")
    void oneInstructionPerPaperOrder() {
        long first = store.insertStopInstruction(CODE, stop(9001, A, 7, "MARKET")).orElseThrow();
        assertThat(store.insertStopInstruction(CODE, stop(9001, A, 9, "MARKET"))).as("같은 모의 주문 — 두 번 알리거나 적지 않음").isEmpty();
        long second = store.insertStopInstruction(CODE, stop(9002, A, 3, "NEXT_CLOSE")).orElseThrow();
        long daily = store.insertInstruction(CODE, new NewInstruction(MONDAY, A, ManualAccountStore.SIDE_SELL, 2, d("10000"), d("0"),
                MAPPER.createObjectNode())).orElseThrow();
        assertThat(daily).as("같은 날 같은 종목의 다음 시가 지시와 따로").isPositive();

        StopInstruction row = store.stopInstruction(first).orElseThrow();
        assertThat(row.account()).isEqualTo(CODE);
        assertThat(row.session()).isEqualTo(MONDAY);
        assertThat(row.paperOrderId()).isEqualTo(9001);
        assertThat(row.symbol()).isEqualTo(A);
        assertThat(row.side()).isEqualTo("SELL");
        assertThat(row.quantity()).isEqualTo(7);
        assertThat(row.timing()).isEqualTo("MARKET");
        assertThat(row.targetAt()).isEqualTo(T);
        assertThat(row.reason().path("paperOrderId").asLong()).isEqualTo(9001);
        assertThat(row.planned()).isTrue();
        assertThat(row.notifiedAt()).isNull();
        assertThat(row.toString()).as("로그에 종목·수량을 싣지 않음").doesNotContain("quantity").doesNotContain(A);
        assertThat(store.stopInstructionForOrder(CODE, 9002)).hasValueSatisfying(s -> assertThat(s.id()).isEqualTo(second));
        assertThat(store.stopInstructionForOrder(CODE, 9003)).isEmpty();
        assertThat(store.stopInstructions(CODE, MONDAY)).extracting(StopInstruction::id).containsExactly(first, second);
        assertThat(store.plannedStopInstructions(CODE)).extracting(StopInstruction::id).containsExactly(first, second);
        assertThat(store.recentStopInstructions(CODE, 1)).extracting(StopInstruction::id).containsExactly(second);

        Instant sent = kst("2026-11-09T10:43");
        assertThat(store.markStopNotified(List.of(first, second), sent)).isEqualTo(2);
        assertThat(store.markStopNotified(List.of(first), kst("2026-11-09T10:50"))).as("이미 보낸 행은 그대로").isZero();
        assertThat(store.markStopNotified(List.of(), sent)).isZero();
        assertThat(store.stopInstruction(first).orElseThrow().notifiedAt()).isEqualTo(sent);

        assertThat(store.updateStopInstructionStatus(second, ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_RECORDED,
                Map.of("autoNote", "x"))).as("기대한 상태가 아님").isFalse();
        assertThat(store.updateStopInstructionStatus(second, ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                Map.of("autoNote", "not-notified"))).isTrue();
        StopInstruction skipped = store.stopInstruction(second).orElseThrow();
        assertThat(skipped.status()).isEqualTo("SKIPPED");
        assertThat(skipped.reason().path("autoNote").asString()).isEqualTo("not-notified");
        assertThat(skipped.reason().path("paperOrderId").asLong()).as("근거에 덧붙임").isEqualTo(9002);
        assertThat(store.plannedStopInstructions(CODE)).extracting(StopInstruction::id).containsExactly(first);
    }

    @Test
    @DisplayName("CHECK — 매도만, 체결 시점 넷, 수량 > 0, 종목 코드 모양")
    void checks() {
        String insert = "INSERT INTO manual_stop_instructions (account, session, paper_order_id, symbol, side, quantity, timing, target_at) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        Date session = Date.valueOf(MONDAY);
        Timestamp at = Timestamp.from(T);
        assertThatThrownBy(() -> jdbc.update(insert, CODE, session, 1L, A, "BUY", 1, "MARKET", at)).as("매수")
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, CODE, session, 2L, A, "SELL", 1, "AT_1000", at)).as("모르는 시점")
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, CODE, session, 3L, A, "SELL", 0, "MARKET", at)).as("수량 0")
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, CODE, session, 4L, "A00593", "SELL", 1, "MARKET", at)).as("종목 코드 모양")
                .isInstanceOf(DataIntegrityViolationException.class);
        long order = 100;
        for (String timing : List.of("MARKET", "AT_MINUTE", "NEXT_CLOSE", "NEXT_OPEN")) {
            assertThat(jdbc.update(insert, CODE, session, order++, A, "SELL", 1, timing, at)).as(timing).isEqualTo(1);
        }
    }

    @Test
    @DisplayName("되돌리기 호환 — 옛 코드(V28 전)의 다음 시가 지시 문장 ON CONFLICT (account, session, symbol)과 장부 문장(스탑 칸 모름)이 V28 뒤에도 그대로 동작")
    void oldStatementsStillWork() {
        // V25 때 ManualAccountStore.insertInstruction·insertLedger의 문장 그대로(옛 코드로 되돌린 백엔드가 보낼 SQL).
        String oldInstruction = "INSERT INTO manual_instructions (account, session, symbol, side, quantity, ref_price, weight_pct, reason) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (account, session, symbol) DO NOTHING RETURNING id";
        List<Long> first = jdbc.query(oldInstruction, (rs, n) -> rs.getLong("id"), CODE, Date.valueOf(MONDAY), B, "BUY", 3,
                new BigDecimal("21000"), new BigDecimal("5"), "{}");
        List<Long> again = jdbc.query(oldInstruction, (rs, n) -> rs.getLong("id"), CODE, Date.valueOf(MONDAY), B, "BUY", 4,
                new BigDecimal("21000"), new BigDecimal("5"), "{}");
        assertThat(first).hasSize(1);
        assertThat(again).as("같은 (계좌, 세션, 종목) — 아무것도 하지 않음").isEmpty();
        store.insertStopInstruction(CODE, stop(9100, B, 3, "MARKET")).orElseThrow();
        assertThat(jdbc.query(oldInstruction, (rs, n) -> rs.getLong("id"), CODE, Date.valueOf(MONDAY), A, "SELL", 1,
                new BigDecimal("12000"), new BigDecimal("0"), "{}")).as("스탑 지시가 있어도 다음 시가 지시 문장은 그대로").hasSize(1);

        String oldLedger = "INSERT INTO manual_ledger (account, at, kind, symbol, quantity, price, amount, fee, tax, instruction_id, source, note) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id";
        long ledgerId = jdbc.queryForObject(oldLedger, Long.class, CODE, Timestamp.from(kst("2026-11-09T09:10")), "BUY", B,
                new BigDecimal("3"), new BigDecimal("21000"), null, BigDecimal.ZERO, BigDecimal.ZERO, first.get(0), "AUTO", null);
        assertThat(jdbc.queryForObject("SELECT instruction_id FROM manual_ledger WHERE id = ?", Long.class, ledgerId)).isEqualTo(first.get(0));
        assertThat(jdbc.queryForObject("SELECT stop_instruction_id FROM manual_ledger WHERE id = ?", Long.class, ledgerId))
                .as("옛 문장은 스탑 칸을 모름 — NULL").isNull();
    }

    @Test
    @DisplayName("매매 내역은 지시·스탑 지시 가운데 하나에만 묶이고(같은 지시 두 번 안 됨), 계좌를 지우면(옛 QA 복원 순서) 스탑 지시·잔고·보유·내역도 함께")
    void tradeLinksAndCascade() {
        long stopId = store.insertStopInstruction(CODE, stop(9200, A, 5, "MARKET")).orElseThrow();
        long daily = store.insertInstruction(CODE, new NewInstruction(MONDAY, A, ManualAccountStore.SIDE_BUY, 1, d("12000"), d("1"),
                MAPPER.createObjectNode())).orElseThrow();
        assertThat(store.insertBalance(CODE, T, d("1000"))).isTrue();
        assertThat(store.insertBalance(CODE, T, d("2000"))).as("잔고는 계좌마다 한 행").isFalse();
        store.upsertPosition(CODE, A, null, d("5"), d("60000"));
        store.insertTrade(CODE, new TradeValues(T, ManualAccountStore.SIDE_SELL, A, d("5"), d("11800"), d("8"), d("118"), d("60000"), d("-1126"), false, null, stopId, "live"));

        assertThatThrownBy(() -> store.insertTrade(CODE, new TradeValues(T, ManualAccountStore.SIDE_SELL, A, d("1"), d("11800"), d("0"), d("0"), d("0"), null, false, daily,
                stopId, "live"))).as("한 행은 두 지시 가운데 하나에만").isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.insertTrade(CODE, new TradeValues(T, ManualAccountStore.SIDE_SELL, A, d("1"), d("11800"), d("0"), d("0"), d("0"), null, false, null,
                stopId, "live"))).as("같은 스탑 지시를 두 번 반영하지 않음").isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.insertTrade(CODE, new TradeValues(T, ManualAccountStore.SIDE_SELL, A, d("1"), d("11800"), d("0"), d("0"), d("0"), null, false, null,
                -1L, "live"))).as("없는 지시에는 묶지 않음").isInstanceOf(DataIntegrityViolationException.class);

        jdbc.update("DELETE FROM manual_trades");
        jdbc.update("DELETE FROM manual_ledger");
        jdbc.update("DELETE FROM manual_instructions");
        jdbc.update("DELETE FROM manual_sessions");
        jdbc.update("DELETE FROM manual_accounts");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM manual_stop_instructions", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM manual_balance", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM manual_positions", Integer.class)).isZero();
    }

    @Test
    @DisplayName("준비 — V31의 잔고 표·알림 칸이 있어야 준비됨, 시험 뒤 되돌림")
    void readyRequiresV31() {
        class Rollback extends RuntimeException {
        }
        assertThat(store.ready()).as("make db-test로 V31까지 적용했는가").isTrue();
        for (String table : List.of("manual_balance", "manual_positions", "manual_trades")) {
            assertThatThrownBy(() -> store.atomically(() -> {
                jdbc.execute("DROP TABLE " + table + " CASCADE");
                assertThat(new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as(table + " 표가 없으면").isFalse();
                throw new Rollback();
            })).isInstanceOf(Rollback.class);
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("ALTER TABLE manual_stop_instructions DROP COLUMN notified_preclose_at");
            assertThat(new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("마감 전 알림 칸이 없으면").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(store.ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @Disabled("QA-354: 수정 전 — ready()가 V32의 manual_trades.amount 칸을 보지 않아 V31까지만 적용된 DB에서도 참")
    @DisplayName("QA-354 준비 — V32의 체결 금액 칸(manual_trades.amount)이 있어야 준비됨(매매 내역 조회·확인·고치기가 그 칸을 읽고 씀), 시험 뒤 되돌림")
    void readyRequiresV32() {
        class Rollback extends RuntimeException {
        }
        assertThat(store.ready()).as("make db-test로 V32까지 적용했는가").isTrue();
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("ALTER TABLE manual_trades DROP COLUMN amount");
            assertThat(new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("체결 금액 칸이 없으면").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(store.ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("준비 — V30의 '매매함'·장 중반 알림 칸이 있어야 준비됨(지시 조회가 두 칸을 읽음), 시험 뒤 되돌림")
    void readyRequiresV30() {
        class Rollback extends RuntimeException {
        }
        assertThat(store.ready()).as("make db-test로 V30까지 적용했는가").isTrue();
        for (String column : List.of("confirmed_at", "notified_midday_at")) {
            assertThatThrownBy(() -> store.atomically(() -> {
                jdbc.execute("ALTER TABLE manual_instructions DROP COLUMN " + column);
                assertThat(new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as(column + " 칸이 없으면").isFalse();
                throw new Rollback();
            })).isInstanceOf(Rollback.class);
        }
        assertThat(store.ready()).as("되돌린 뒤").isTrue();
    }
}
