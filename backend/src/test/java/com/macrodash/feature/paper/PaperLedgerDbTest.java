package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.SchemaCheck;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static com.macrodash.feature.paper.PaperFixtures.SAT;
import static com.macrodash.feature.paper.PaperFixtures.TUE_FINAL;
import static com.macrodash.feature.paper.PaperFixtures.TUE_INTRADAY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * 장부 흐름을 실제 테스트 DB(macrodash_test)의 V8 테이블로 — 초기화(사후 체결) → 장중 체결 → 스탑·재진입 금지 → 같은 관측치
 * 다시 처리. 가짜 저장소로는 CHECK 제약(주문 출처·시점·상태 값)·NUMERIC 자리·외래키가 실제로 받아 주는지 알 수 없습니다.
 *
 * <p>관측치 저장본은 {@link StoreReader}를 바꿔 끼워 넣습니다(수집기 테이블 snapshots에는 쓰지 않음). 책은 실제 코드
 * (rules·claude·bench_spy·bench_mix)라 통합 테스트(ApiIntegrationTest)와 같은 행을 쓰므로 시작·끝에 그 네 책만 지웁니다 —
 * 책을 지우면 장부가 외래키로 함께 지워집니다. 설정 행은 이 테스트가 만들었을 때만 지웁니다. 초기화가 얼리는 출발일 종가
 * ({@code paper_start_prices})도 이 테스트가 쓰는 종목만 지웁니다 — 남겨 두면 다른 테스트의 초기화가 그 값으로 사후 체결합니다.
 * 시장 격리 시험의 시험용 한국 책({@value #KR_BOOK})과 그 시험이 남긴 리스크 점검 기록, 시각 지정 체결 시험의 계좌({@value #TIMED_BOOK})도 지웁니다.
 */
class PaperLedgerDbTest {

    private static final Clock AFTER_START = Clock.fixed(Instant.parse("2026-10-24T03:00:00Z"), ZoneOffset.UTC);

    /** 시장 격리 시험의 시험용 한국 책 — 실제 한국 계좌 코드(kr_*)와 겹치지 않는 시험 접두어(PaperStoreDbTest도 t_로 지움). */
    private static final String KR_BOOK = "t_kr_claude";
    /**
     * 시각 지정 체결 시험의 계좌 — 계좌2 자리(정의는 단계 1-5). AT_* 주문 행이 남으면 make db-test가 V14를 다시 돌릴 때 옛 timing CHECK에 걸리므로
     * 시작·끝에 지웁니다(ADR 0022 '스키마 다시 실행').
     */
    private static final String TIMED_BOOK = "claude2";

    private JdbcTemplate jdbc;
    private PaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperLedgerService ledger;
    private PaperAdminService admin;
    private boolean settingsExisted;
    /** 시장 격리 시험이 시작할 때의 작업 기록 마지막 번호 — 그 뒤에 쌓인 리스크 점검 기록을 끝에 지웁니다. */
    private Long jobRunsFrom;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL",
                "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        store = new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        assumeTrue(store.ready(), "테스트 DB에 V8(paper_*)이 없습니다 — make db-test");
        settingsExisted = store.settings().isPresent();
        deleteBooks();

        reader = PaperFixtures.quietReader();
        marketData = new PaperMarketData(reader, new StoreRepository(jdbc, MAPPER), AFTER_START);
        PaperSettingsService settings = new PaperSettingsService(store, MAPPER);
        ledger = new PaperLedgerService(store, marketData, MAPPER);
        admin = new PaperAdminService(store, marketData, reader, settings, ledger, PaperFixtures.config(), MAPPER,
                AFTER_START);
    }

    @AfterEach
    void tearDown() {
        if (jdbc == null || store == null || !store.ready()) {
            return;
        }
        deleteBooks();
        if (jobRunsFrom != null) {
            jdbc.update("DELETE FROM paper_job_runs WHERE job = ? AND id > ?", PaperRiskJob.JOB, jobRunsFrom);
        }
        if (!settingsExisted) {
            jdbc.update("DELETE FROM paper_settings");
            jdbc.update("DELETE FROM paper_settings_history WHERE version = 1");
        }
    }

    private void deleteBooks() {
        jdbc.update("DELETE FROM paper_books WHERE code IN ('rules', 'claude', 'bench_spy', 'bench_mix', ?, ?)", KR_BOOK,
                TIMED_BOOK);
        jdbc.update("DELETE FROM paper_start_prices WHERE ticker IN ('SPY', 'SHY', 'AAA')");
    }

    /** paper.quotes 저장본 하나를 관측치로 내놓습니다(수집기 모양 그대로의 JSON). */
    private void observe(Instant collectedAt, String tickersJson) throws Exception {
        Snapshot snapshot = new Snapshot(Datasets.SNAP_PAPER_QUOTES,
                MAPPER.readTree("{\"period\":\"3mo\",\"tickers\":" + tickersJson + "}"), "json", "ok", null, collectedAt);
        when(reader.read(eq(Datasets.SNAP_PAPER_QUOTES), anyLong(), any())).thenReturn(Optional.of(snapshot));
    }

    private PaperLedgerService.Outcome processLatest() {
        return ledger.process(reader.quietly(marketData::quotes).orElseThrow());
    }

    private long count(String sql, Object... args) {
        Long n = jdbc.queryForObject(sql, Long.class, args);
        return n == null ? 0 : n;
    }

    @Test
    @DisplayName("초기화 → 장중 체결 → 스탑·재진입 금지 → 같은 관측치 다시: DB 제약을 통과하고 결과는 한 번")
    void ledgerFlowOnRealTables() throws Exception {
        // 1. 출발일 종가가 든 저장본(토요일 수집) — 10년 이력이 없으니 관측치의 그날 봉으로 사후 체결
        observe(SAT, """
                {"SPY":{"dates":["2026-10-22","2026-10-23"],"close":[495.0,500.0]},
                 "SHY":{"dates":["2026-10-22","2026-10-23"],"close":[82.4,82.5]},
                 "AAA":{"dates":["2026-10-22","2026-10-23"],"close":[99.0,100.0]}}""");
        PaperAdminService.InitResult init = admin.init();
        assertThat(init.backfilled()).containsExactly("bench_spy", "bench_mix");
        assertThat(count("SELECT COUNT(*) FROM paper_fills WHERE book_code = 'bench_spy' AND is_backfill "
                + "AND price_source = 'paper.quotes' AND qty = 199")).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM paper_nav_daily WHERE book_code = 'bench_mix' "
                + "AND trading_date = DATE '2026-10-23' AND prices_final")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT status FROM paper_books WHERE code = 'bench_spy'", String.class))
                .isEqualTo("ACTIVE");
        assertThat(init.startPricesCaptured()).as("관측치 유니버스 전체(SPY·SHY·AAA)를 얼림").isEqualTo(3);
        assertThat(jdbc.queryForList("SELECT ticker || '=' || close::text || ' ' || source FROM paper_start_prices "
                + "WHERE ticker IN ('SPY', 'SHY', 'AAA') AND trading_date = DATE '2026-10-23' ORDER BY ticker",
                String.class)).containsExactly("AAA=100.000000 paper.quotes", "SHY=82.500000 paper.quotes",
                "SPY=500.000000 paper.quotes");

        // 2. Claude 책을 운용 중으로 두고(시작 기능은 다음 단계) 대기 매수 하나 — 월요일 장중 관측치로 체결
        jdbc.update("UPDATE paper_books SET status = 'ACTIVE', started_on = DATE '2026-10-23' WHERE code = 'claude'");
        long buy = store.insertOrder(new PaperStore.Order(0, "claude", null, "AAA", "BUY", null, 10.0, null,
                "NEXT_OBSERVATION", "CLAUDE", "PENDING", null, null, FRI, SAT.plusSeconds(60), MON.plusDays(3), null));
        observe(MON_INTRADAY, """
                {"SPY":{"dates":["2026-10-23","2026-10-26"],"close":[500.0,505.0]},
                 "SHY":{"dates":["2026-10-23","2026-10-26"],"close":[82.5,82.5]},
                 "AAA":{"dates":["2026-10-23","2026-10-26"],"close":[100.0,100.0]}}""");
        PaperLedgerService.Outcome first = processLatest();
        assertThat(first.filled()).isEqualTo(1);
        assertThat(first.errors()).isEmpty();
        assertThat(jdbc.queryForObject("SELECT status FROM paper_orders WHERE id = ?", String.class, buy))
                .isEqualTo("FILLED");
        assertThat(jdbc.queryForObject("SELECT qty FROM paper_positions WHERE book_code = 'claude' AND ticker = 'AAA'",
                Integer.class)).isEqualTo(99);   // 10,000 / 100.05 → 99주

        // 3. 화요일 장중 −10% → 스탑(STOP·IMMEDIATE·FILLED) + 재진입 금지
        observe(TUE_INTRADAY, """
                {"SPY":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[500.0,505.0,506.0]},
                 "AAA":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[100.0,100.0,90.0]}}""");
        PaperLedgerService.Outcome stop = processLatest();
        assertThat(stop.stopped()).isEqualTo(1);
        Map<String, Object> stopOrder = jdbc.queryForMap("SELECT source, timing, status, qty, reason->>'trigger' AS trig "
                + "FROM paper_orders WHERE book_code = 'claude' AND source = 'STOP'");
        assertThat(stopOrder).containsEntry("timing", "IMMEDIATE").containsEntry("status", "FILLED")
                .containsEntry("qty", 99).containsEntry("trig", "TRAILING_STOP");
        assertThat(count("SELECT COUNT(*) FROM paper_positions WHERE book_code = 'claude'")).isZero();
        assertThat(jdbc.queryForObject("SELECT until_trading_date::text FROM paper_lockouts WHERE book_code = 'claude' "
                + "AND ticker = 'AAA'", String.class)).isEqualTo("2026-11-24");
        assertThat(count("SELECT COUNT(*) FROM paper_positions WHERE book_code = 'bench_mix' AND price_stale"))
                .as("SHY 봉이 빠진 관측치 — 가격 없음").isEqualTo(1);

        // 4. 같은 관측치를 다시 — 아무 책도 처리하지 않음
        long fillsBefore = count("SELECT COUNT(*) FROM paper_fills WHERE book_code IN "
                + "('rules', 'claude', 'bench_spy', 'bench_mix')");
        PaperLedgerService.Outcome again = processLatest();
        assertThat(again.booksProcessed()).isEmpty();
        assertThat(count("SELECT COUNT(*) FROM paper_fills WHERE book_code IN "
                + "('rules', 'claude', 'bench_spy', 'bench_mix')")).isEqualTo(fillsBefore);

        // 5. 순자산 줄은 확정 종가 관측치에서만 — 장중 관측치 둘로는 없고, 화요일 마감 뒤 관측치로 화요일 줄(확정)
        assertThat(count("SELECT COUNT(*) FROM paper_nav_daily WHERE book_code = 'claude'")).isZero();
        observe(TUE_FINAL, """
                {"SPY":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[500.0,505.0,507.0]},
                 "SHY":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[82.5,82.5,82.6]},
                 "AAA":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[100.0,100.0,91.0]}}""");
        processLatest();
        assertThat(jdbc.queryForList("SELECT book_code FROM paper_nav_daily WHERE trading_date = DATE '2026-10-27' "
                + "AND prices_final ORDER BY book_code", String.class))
                .containsExactly("bench_mix", "bench_spy", "claude");   // 시작 전 rules는 남기지 않음
        assertThat(jdbc.queryForObject("SELECT last_nav_trading_date::text FROM paper_book_state "
                + "WHERE book_code = 'claude'", String.class)).isEqualTo("2026-10-27");
    }

    @Test
    @DisplayName("리셋은 얼려 둔 출발일 종가로 다시 사후 체결한다 — 배당락으로 수정 종가가 낮아진 뒤에도 처음과 같은 가격·수량")
    void resetReusesFrozenStartPrice() throws Exception {
        observe(SAT, """
                {"SPY":{"dates":["2026-10-22","2026-10-23"],"close":[495.0,500.0]},
                 "SHY":{"dates":["2026-10-22","2026-10-23"],"close":[82.4,82.5]}}""");
        admin.init();
        // 몇 주 뒤: 수집기가 배당 조정으로 출발일 종가를 낮게 다시 씀(SHY 82.5 → 82.0, SPY 500 → 497).
        observe(TUE_FINAL, """
                {"SPY":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[497.0,505.0,507.0]},
                 "SHY":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[82.0,82.1,82.2]}}""");

        PaperAdminService.ResetResult reset = admin.reset("bench_mix", "bench_mix");

        assertThat(reset.backfilled()).isTrue();
        assertThat(jdbc.queryForList("SELECT ticker || ' ' || qty || ' ' || raw_price::text FROM paper_fills "
                + "WHERE book_code = 'bench_mix' ORDER BY ticker", String.class))
                .containsExactly("SHY 484 82.500000", "SPY 119 500.000000");
    }

    @Test
    @DisplayName("미국 시각 지정 체결(1-4)을 실제 표로 — AT_1000 매수는 1분봉 T 봉으로 체결(bar_at·fill_rung·출처), 종일 거래 없는 AT_1100은 마감 뒤 NO_TRADE_AFTER_T 만료")
    void timedFillsOnRealTables() {
        assertThat(store.insertBookIfAbsent(new PaperStore.Book(TIMED_BOOK, PaperBooks.KIND_CLAUDE, "시험용 계좌2", 100_000,
                FRI, PaperBooks.ACTIVE, null))).isTrue();
        store.upsertState(new PaperStore.BookState(TIMED_BOOK, 100_000, 100_000, 0, 0, null, null, null, null));
        Instant decided = Instant.parse("2026-10-26T22:31:00Z");
        LocalDate tue = LocalDate.of(2026, 10, 27);
        long ten = store.insertOrder(new PaperStore.Order(0, TIMED_BOOK, null, "AAA", "BUY", 10, null, null, "AT_1000",
                "CLAUDE", "PENDING", null, null, MON, decided, tue, null));
        long halted = store.insertOrder(new PaperStore.Order(0, TIMED_BOOK, null, "BBB", "BUY", 5, null, null, "AT_1100",
                "CLAUDE", "PENDING", null, null, MON, decided, tue, null));
        Instant w = Instant.parse("2026-10-27T20:20:00Z");   // 16:20 EDT — 화요일 확정 종가 관측치
        ExecutionAuditFixtures.Bars bars = new ExecutionAuditFixtures.Bars(w.plusSeconds(60))
                .bar("AAA", tue, Instant.parse("2026-10-27T14:00:00Z"), 100.0, 500.0)
                .bar("AAA", tue, Instant.parse("2026-10-27T19:59:00Z"), 101.0, 500.0)
                .bar("BBB", MON, Instant.parse("2026-10-26T19:59:00Z"), 50.0, 100.0)
                .bar("SPY", tue, Instant.parse("2026-10-27T19:59:00Z"), 507.0, 9000.0);
        when(reader.read(eq(Datasets.SNAP_PAPER_BARS_US), anyLong(), any())).thenReturn(Optional.of(bars.snapshot()));
        Snapshot quotes = new Snapshot(Datasets.SNAP_PAPER_QUOTES, MAPPER.valueToTree(Map.of("tickers", Map.of(
                "AAA", Map.of("dates", List.of("2026-10-26", "2026-10-27"), "close", List.of(99.0, 101.0)),
                "BBB", Map.of("dates", List.of("2026-10-26", "2026-10-27"), "close", List.of(50.0, 50.0)),
                "SPY", Map.of("dates", List.of("2026-10-26", "2026-10-27"), "close", List.of(505.0, 507.0))))),
                "json", "ok", null, w);
        when(reader.read(eq(Datasets.SNAP_PAPER_QUOTES), anyLong(), any())).thenReturn(Optional.of(quotes));

        PaperLedgerService.Outcome outcome = processLatest();

        assertThat(outcome.errors()).isEmpty();
        assertThat(outcome.booksProcessed()).contains(TIMED_BOOK);
        assertThat(jdbc.queryForMap("SELECT raw_price::text AS raw, price_source, fill_rung, bar_at = TIMESTAMPTZ "
                + "'2026-10-27 14:00:00+00' AS at_target, observation_date::text AS day FROM paper_fills WHERE order_id = ?",
                ten)).containsEntry("raw", "100.000000").containsEntry("price_source", "paper.bars.us")
                .containsEntry("fill_rung", "Y1M_AT").containsEntry("at_target", true).containsEntry("day", "2026-10-27");
        assertThat(jdbc.queryForMap("SELECT status, split_part(reject_reason, ' ', 1) AS code FROM paper_orders "
                + "WHERE id = ?", halted)).containsEntry("status", "EXPIRED").containsEntry("code", "NO_TRADE_AFTER_T");
        assertThat(count("SELECT COUNT(*) FROM paper_fills WHERE order_id = ?", halted)).isZero();
    }

    /**
     * 시장 격리 회귀(2단계 명세 §9 A5) — 같은 paper_books 표에 한국 책이 있어도 미국 작업은 그 책을 읽지도 쓰지도 않습니다. 묶음 전
     * 장부는 {@code store.books()} 전체를 돌아, 미국 관측치가 한국 책의 멱등 키를 미국 수집 시각으로 밀고(그 뒤 한국 관측치는 '이미
     * 처리함'), 미국 관측치에 없는 한국 보유를 '가격 없음'으로 바꾸고, 미국 세션으로 한국 주문을 만료·재진입 금지를 지우고, 미국
     * 거래일 순자산 줄을 한국 책에 썼습니다. 시험용 한국 책은 그 일이 하나라도 일어나면 행이 바뀌도록 차려 두고, book_code 열이 있는
     * 모든 표의 그 책 행을 전후로 글자 그대로 비교합니다.
     */
    @Test
    @DisplayName("시장 격리: 미국 리스크 점검(정기 실행)·장부 처리·미확정 순자산 줄은 같은 표의 시험용 한국 책 행을 하나도 바꾸지 않는다")
    void usJobsLeaveKoreanBookUntouched() throws Exception {
        // 1. 미국 네 책(벤치마크 사후 체결) + 운용 중인 Claude 책의 대기 매수 — 미국 장부가 실제로 일을 하게
        observe(SAT, """
                {"SPY":{"dates":["2026-10-22","2026-10-23"],"close":[495.0,500.0]},
                 "SHY":{"dates":["2026-10-22","2026-10-23"],"close":[82.4,82.5]},
                 "AAA":{"dates":["2026-10-22","2026-10-23"],"close":[99.0,100.0]}}""");
        admin.init();
        jdbc.update("UPDATE paper_books SET status = 'ACTIVE', started_on = DATE '2026-10-23' WHERE code = 'claude'");
        long buy = store.insertOrder(new PaperStore.Order(0, "claude", null, "AAA", "BUY", null, 10.0, null,
                "NEXT_OBSERVATION", "CLAUDE", "PENDING", null, null, FRI, SAT.plusSeconds(60), MON.plusDays(3), null));

        // 2. 시험용 한국 책 — 운용 중, 멱등 키는 미국 관측치보다 앞(미국 관측치가 '새 관측치'로 보이는 자리), 미국 관측치에 없는
        //    보유, 미국 세션으로 보면 기한이 지난 대기 주문, 미국 세션 전날까지의 재진입 금지, 순자산 줄 하나
        Instant krObserved = Instant.parse("2026-10-23T13:30:00Z");   // 10-23(금) 22:30 KST
        assertThat(store.insertBookIfAbsent(new PaperStore.Book(KR_BOOK, PaperBooks.KIND_CLAUDE, "시험용 한국 Claude 계좌",
                100_000_000, LocalDate.of(2026, 10, 22), PaperBooks.ACTIVE, null, PaperStore.Book.MARKET_KR,
                PaperStore.Book.CURRENCY_KRW))).isTrue();
        store.upsertState(new PaperStore.BookState(KR_BOOK, 30_000_000, 100_700_000, 70_700_000, 70.2085, krObserved,
                krObserved, FRI, null));
        store.upsertPosition(new PaperStore.Position(KR_BOOK, "005930", 1_000, 70_000, LocalDate.of(2026, 10, 22),
                Instant.parse("2026-10-23T00:01:00Z"), 72_000, krObserved, 70_700.0, krObserved, false, FRI, 70_700,
                null));
        long krOrder = store.insertOrder(new PaperStore.Order(0, KR_BOOK, null, "000660", "BUY", null, 10.0, null,
                "NEXT_OBSERVATION", "CLAUDE", "PENDING", null, null, LocalDate.of(2026, 10, 21),
                Instant.parse("2026-10-21T13:30:00Z"), LocalDate.of(2026, 10, 24), null));
        store.upsertLockout(new PaperStore.Lockout(KR_BOOK, "035420", FRI, "시험용 재진입 금지"));
        store.upsertNav(new PaperStore.NavRow(KR_BOOK, FRI, 100_700_000, 30_000_000, 70_700_000, 70.2085, true));
        assertThat(store.books()).extracting(PaperStore.Book::code).as("미국 작업이 읽는 같은 표에 있음")
                .contains(KR_BOOK, "claude");
        List<String> before = koreanRows();
        assertThat(before).as("책·상태·보유·주문·재진입 금지·순자산 행이 모두 비교 대상")
                .anyMatch(row -> row.startsWith("paper_books "))
                .anyMatch(row -> row.startsWith("paper_book_state "))
                .anyMatch(row -> row.startsWith("paper_positions "))
                .anyMatch(row -> row.startsWith("paper_orders "))
                .anyMatch(row -> row.startsWith("paper_lockouts "))
                .anyMatch(row -> row.startsWith("paper_nav_daily "));
        jobRunsFrom = count("SELECT COALESCE(MAX(id), 0) FROM paper_job_runs");

        // 3. 미국 리스크 점검 정기 실행 — 월 장중(체결) → 같은 저장본 다시(할 일 없음) → 화 확정(순자산 줄)
        PaperRiskJob job = new PaperRiskJob(store, reader, marketData, ledger, PaperFixtures.config(), MAPPER,
                Clock.fixed(TUE_FINAL.plusSeconds(30), ZoneOffset.UTC));
        observe(MON_INTRADAY, """
                {"SPY":{"dates":["2026-10-23","2026-10-26"],"close":[500.0,505.0]},
                 "SHY":{"dates":["2026-10-23","2026-10-26"],"close":[82.5,82.5]},
                 "AAA":{"dates":["2026-10-23","2026-10-26"],"close":[100.0,100.0]}}""");
        job.scheduledRun();
        assertThat(jdbc.queryForObject("SELECT status FROM paper_orders WHERE id = ?", String.class, buy))
                .as("미국 장부는 일함").isEqualTo("FILLED");

        job.scheduledRun();
        assertThat(job.run(false).skippedReason()).as("한국 책의 옛 멱등 키가 미국 관측치를 '새 관측치'로 만들지 않음")
                .contains("새 관측치가 없습니다");

        observe(TUE_FINAL, """
                {"SPY":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[500.0,505.0,507.0]},
                 "SHY":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[82.5,82.5,82.6]},
                 "AAA":{"dates":["2026-10-23","2026-10-26","2026-10-27"],"close":[100.0,100.0,101.0]}}""");
        job.scheduledRun();
        assertThat(jdbc.queryForList("SELECT book_code FROM paper_nav_daily WHERE trading_date = DATE '2026-10-27' "
                + "AND prices_final AND book_code IN ('rules', 'claude', 'bench_spy', 'bench_mix', ?) ORDER BY book_code",
                String.class, KR_BOOK)).containsExactly("bench_mix", "bench_spy", "claude");
        assertThat(koreanRows()).as("리스크 점검 뒤 한국 책의 행").isEqualTo(before);

        // 4. 결정 작업이 부르는 장부 처리(시장을 받지 않는 옛 시그니처 = 미국)·미확정 순자산 줄
        assertThat(processLatest().booksProcessed()).as("미국 책은 이미 처리함 — 한국 책을 대신 처리하지 않음").isEmpty();
        assertThat(ledger.settleNav(LocalDate.of(2026, 10, 28), false)).containsExactly("claude", "bench_spy",
                "bench_mix");

        // 5. 한국 책의 행은 글자 그대로, 리스크 점검 기록에도 한국 책이 없음
        assertThat(koreanRows()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT status FROM paper_orders WHERE id = ?", String.class, krOrder))
                .isEqualTo("PENDING");
        List<String> processed = jdbc.queryForList("SELECT detail->>'booksProcessed' FROM paper_job_runs "
                + "WHERE job = ? AND id > ? ORDER BY id", String.class, PaperRiskJob.JOB, jobRunsFrom);
        assertThat(processed).as("월 장중·화 확정 두 번만 기록(같은 저장본은 기록 없음)").hasSize(2)
                .allSatisfy(books -> assertThat(books).contains("claude").doesNotContain(KR_BOOK));
    }

    /**
     * 시험용 한국 책의 모든 행 — paper_books와 book_code 열이 있는 모든 표(정보 스키마에서 찾음 — 나중에 표가 늘어도 빠지지 않게).
     * 행마다 "표 이름 + JSON 한 줄"이고, 표 안에서는 글자 순입니다.
     */
    private List<String> koreanRows() {
        List<String> rows = new ArrayList<>(jdbc.queryForList(
                "SELECT 'paper_books ' || to_jsonb(b)::text FROM paper_books b WHERE code = ?", String.class, KR_BOOK));
        List<String> tables = jdbc.queryForList("SELECT table_name FROM information_schema.columns "
                + "WHERE table_schema = current_schema() AND column_name = 'book_code' ORDER BY table_name", String.class);
        for (String table : tables) {
            rows.addAll(jdbc.queryForList("SELECT CAST(? AS text) || ' ' || to_jsonb(t)::text FROM \"" + table
                    + "\" t WHERE book_code = ? ORDER BY 1", String.class, table, KR_BOOK));
        }
        return rows;
    }
}
