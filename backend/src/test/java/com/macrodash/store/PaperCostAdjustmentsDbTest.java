package com.macrodash.store;

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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 소급 비용 조정 표(V26 {@code paper_cost_adjustments} — ADR 0030)를 실제 테스트 DB(macrodash_test)로 — 체결마다 한 행(ON CONFLICT DO NOTHING)·대상
 * 고르기(비용 칸 0이고 조정 행 없음)·CHECK(비용 ≥ 0·현금 차이 ≤ 0)·외래키 CASCADE·순자산 줄과 상태의 현금·순자산 옮기기(노출 다시 셈). 가짜 저장소로는
 * SQL·NUMERIC 자리·CHECK를 알 수 없습니다. 책 코드는 {@code t_cost_}로 시작하는 것만 쓰고 시작·끝에 지웁니다.
 */
class PaperCostAdjustmentsDbTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String BOOK = "t_cost_us";
    private static final LocalDate FRI = LocalDate.of(2026, 10, 23);
    private static final LocalDate MON = LocalDate.of(2026, 10, 26);
    private static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    private static final Instant CLOSE = Instant.parse("2026-10-23T20:00:00Z");

    private JdbcTemplate jdbc;
    private PaperStore store;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL",
                "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        store = new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        assumeTrue(new SchemaCheck(jdbc).tableExists("paper_cost_adjustments"),
                "테스트 DB에 paper_cost_adjustments(V26)가 없습니다 — make db-test");
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        // 책을 지우면 상태·주문·체결·순자산·조정 행이 외래키로 함께 지워집니다.
        jdbc.update("DELETE FROM paper_books WHERE code LIKE 't\\_cost\\_%'");
    }

    private long fill(String ticker, String side, int qty, double price, double gross, LocalDate date, BigDecimal fee) {
        long order = store.insertOrder(new PaperStore.Order(0, BOOK, null, ticker, side, qty, null, null, "NEXT_OBSERVATION",
                "CLAUDE", "FILLED", null, null, date.minusDays(1), CLOSE, date.plusDays(3), CLOSE));
        return store.insertFill(new PaperStore.Fill(0, order, BOOK, ticker, side, qty, price, price, 5, gross, CLOSE, date,
                "paper.quotes", false, null, fee, BigDecimal.ZERO, BigDecimal.ZERO));
    }

    private PaperStore.CostAdjustment adjustment(long fillId, String fee, String tax, String cash, LocalDate date) {
        return new PaperStore.CostAdjustment(fillId, BOOK, "US", new BigDecimal(fee), new BigDecimal(tax), new BigDecimal(cash),
                date, 2, MAPPER.valueToTree(Map.of("commissionBp", 10)), PaperStore.CostAdjustment.REASON_US_BACKFILL, null);
    }

    @Test
    @DisplayName("준비 여부: V26 표가 없으면 준비 안 됨(백엔드만 새로 띄운 배포 — SQL 오류 대신 안내 문구), 시험 뒤 되돌림")
    void readyRequiresV26() {
        assertThat(store.ready()).as("make db-test로 V26까지 적용했는가").isTrue();
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("DROP TABLE paper_cost_adjustments");
            assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("대상 = 비용 칸 0이고 조정 행 없는 체결(체결 순, 금액은 저장 자리 그대로), 체결마다 한 행 — 두 번째 넣기는 false·첫 값 그대로, 읽은 행 = 넣은 값")
    void targetsAndOneRowPerFill() {
        store.insertBookIfAbsent(new PaperStore.Book(BOOK, "CLAUDE", "시험", 100_000, FRI, "ACTIVE", null));
        long buy = fill("AAA", "BUY", 10, 100.05, 1_000.5, FRI, BigDecimal.ZERO);
        long sell = fill("BBB", "SELL", 100, 91.85405, 9_185.405, MON, BigDecimal.ZERO);
        fill("CCC", "BUY", 1, 50.025, 50.025, MON, new BigDecimal("0.05"));   // 새 비용으로 체결 — 대상 아님

        List<PaperStore.CostBackfillFill> targets = store.costBackfillTargets(BOOK);
        assertThat(targets).extracting(PaperStore.CostBackfillFill::fillId).containsExactly(buy, sell);
        assertThat(targets.get(1).price()).isEqualByComparingTo("91.85405");
        assertThat(targets.get(1).price().scale()).as("NUMERIC(18,6) 그대로").isEqualTo(6);
        assertThat(targets.get(1).gross()).isEqualByComparingTo("9185.405");
        assertThat(targets.get(1).observationDate()).isEqualTo(MON);
        assertThat(targets.get(1).side()).isEqualTo("SELL");

        PaperStore.CostAdjustment first = adjustment(sell, "9.19", "0.21", "-9.40", MON);
        assertThat(store.insertCostAdjustmentIfAbsent(first)).isTrue();
        assertThat(store.insertCostAdjustmentIfAbsent(adjustment(sell, "1", "1", "-2", MON))).as("체결마다 한 행").isFalse();
        assertThat(store.costBackfillTargets(BOOK)).extracting(PaperStore.CostBackfillFill::fillId).containsExactly(buy);
        assertThat(store.costAdjustments(BOOK)).singleElement().satisfies(row -> {
            assertThat(row.createdAt()).as("DB now()").isNotNull();
            assertThat(row.rates().path("commissionBp").asInt()).isEqualTo(10);
            assertThat(new PaperStore.CostAdjustment(row.fillId(), row.bookCode(), row.market(), first.fee(), first.tax(),
                    first.cashDelta(), first.fillDate(), first.settingsVersion(), row.rates(), first.reason(), row.createdAt()))
                    .as("읽은 값 = 넣은 값(첫 값 그대로)").isEqualTo(row);
        });
        assertThat(jdbc.queryForObject("SELECT fee::text FROM paper_fills WHERE id = ?", String.class, sell))
                .as("체결 행은 그대로").isEqualTo("0.0000");

        // 판이 없으면(설정 행 없음) settings_version NULL
        store.insertCostAdjustmentIfAbsent(new PaperStore.CostAdjustment(buy, BOOK, "US", new BigDecimal("1.00"),
                BigDecimal.ZERO, new BigDecimal("-1.00"), FRI, null, null, "us-cost-backfill", null));
        assertThat(store.costAdjustments(BOOK).get(0).settingsVersion()).isNull();
        assertThat(store.costAdjustments(BOOK).get(0).rates().isEmpty()).as("비율 기록 없음 = {}").isTrue();

        store.resetBook(BOOK);
        assertThat(store.costAdjustments(BOOK)).as("초기화가 지운 체결의 조정 행도 함께(CASCADE)").isEmpty();
    }

    @Test
    @DisplayName("CHECK: 현금 차이 양수·비용 음수·모르는 시장은 DB가 막고(레코드도 막음), 없는 체결은 외래키 위반")
    void checks() {
        store.insertBookIfAbsent(new PaperStore.Book(BOOK, "CLAUDE", "시험", 100_000, FRI, "ACTIVE", null));
        long buy = fill("AAA", "BUY", 10, 100.05, 1_000.5, FRI, BigDecimal.ZERO);
        assertThatThrownBy(() -> jdbc.update("INSERT INTO paper_cost_adjustments (fill_id, book_code, market, fee, tax, "
                + "cash_delta, fill_date, reason) VALUES (?, ?, 'US', 1, 0, 1, DATE '2026-10-23', 'x')", buy, BOOK))
                .as("cash_delta ≤ 0").isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("INSERT INTO paper_cost_adjustments (fill_id, book_code, market, fee, tax, "
                + "cash_delta, fill_date, reason) VALUES (?, ?, 'JP', 1, 0, -1, DATE '2026-10-23', 'x')", buy, BOOK))
                .as("시장 US·KR").isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> adjustment(buy, "1", "0", "1", FRI)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> adjustment(buy, "-1", "0", "-1", FRI)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> adjustment(buy, "0.00001", "0", "0", FRI)).as("소수 4자리까지")
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.insertCostAdjustmentIfAbsent(adjustment(buy + 1_000_000, "1", "0", "-1", FRI)))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    @DisplayName("순자산 줄 옮기기: 그 날 이후 줄만 현금·순자산 + 차이, 노출 = 평가액 ÷ 순자산 × 100(4자리), 평가액·확정 표시 그대로 — 상태도 같은 규칙(멱등 키 그대로)")
    void shiftsNavRowsAndState() {
        store.insertBookIfAbsent(new PaperStore.Book(BOOK, "CLAUDE", "시험", 100_000, FRI, "ACTIVE", null));
        store.upsertNav(new PaperStore.NavRow(BOOK, FRI, 100_000, 50_000, 50_000, 50, true));
        store.upsertNav(new PaperStore.NavRow(BOOK, MON, 101_000, 51_000, 50_000, 49.505, true));
        store.upsertNav(new PaperStore.NavRow(BOOK, TUE, 100_000, 50_000, 50_000, 50, false));
        store.upsertState(new PaperStore.BookState(BOOK, 50_000, 100_000, 50_000, 50, CLOSE, CLOSE, TUE, null));

        assertThat(store.shiftNavFrom(BOOK, MON, new BigDecimal("-9.40"))).isEqualTo(2);
        assertThat(store.shiftNavFrom(BOOK, FRI, new BigDecimal("-1.00"))).isEqualTo(3);
        List<PaperStore.NavRow> nav = store.navSeries(BOOK);
        assertThat(nav).extracting(PaperStore.NavRow::nav).containsExactly(99_999.0, 100_989.6, 99_989.6);
        assertThat(nav).extracting(PaperStore.NavRow::cash).containsExactly(49_999.0, 50_989.6, 49_989.6);
        assertThat(nav).extracting(PaperStore.NavRow::equityValue).containsOnly(50_000.0);
        assertThat(nav).extracting(PaperStore.NavRow::pricesFinal).containsExactly(true, true, false);
        assertThat(nav).extracting(PaperStore.NavRow::exposurePct).containsExactly(50.0005, 49.51, 50.0052);

        assertThat(store.shiftStateCash(BOOK, new BigDecimal("-10.40"))).isTrue();
        PaperStore.BookState state = store.state(BOOK).orElseThrow();
        assertThat(state.cash()).isEqualTo(49_989.6);
        assertThat(state.nav()).isEqualTo(99_989.6);
        assertThat(state.exposurePct()).isEqualTo(50.0052);
        assertThat(state.lastProcessedCollectedAt()).isEqualTo(CLOSE);
        assertThat(state.lastNavTradingDate()).isEqualTo(TUE);
        assertThat(store.shiftStateCash("t_cost_none", BigDecimal.ONE.negate())).as("상태 행 없음").isFalse();
    }
}
