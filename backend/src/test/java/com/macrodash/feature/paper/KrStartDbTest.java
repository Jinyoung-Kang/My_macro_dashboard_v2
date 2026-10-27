package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.SchemaCheck;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.mock;

/**
 * 한국 출발(C1c)을 실제 테스트 DB(macrodash_test)의 표로 — 출발 결정(INITIAL)·{@code NEXT_OPEN} 주문(V14 CHECK)·운용 전환·1억 원 순자산 줄이
 * 제약을 통과하는지. 가짜 저장소로는 CHECK(주문 시점·출처·결정 종류)·NUMERIC 자리를 알 수 없습니다. 한국 계좌({@code kr_*})는 시작·끝에
 * 지우고(장부는 외래키로 함께), 설정 행은 이 시험이 만들었을 때만 지웁니다. 저장본은 가짜 읽기로 넣습니다(수집기 표에 쓰지 않음).
 */
class KrStartDbTest {

    private static final LocalDate S = LocalDate.of(2026, 11, 30);

    private JdbcTemplate jdbc;
    private PaperStore store;
    private boolean settingsExisted;
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
        assumeTrue(store.ready(), "테스트 DB에 paper_* 표가 없습니다 — make db-test");
        settingsExisted = store.settings().isPresent();
        if (!settingsExisted) {
            store.initSettingsIfAbsent(new PaperSettingsService(store, MAPPER).defaultsJson());
        }
        deleteKrBooks();
        Long max = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM paper_job_runs", Long.class);
        jobRunsFrom = max == null ? 0 : max;
    }

    @AfterEach
    void tearDown() {
        if (jdbc == null || store == null || !store.ready()) {
            return;
        }
        deleteKrBooks();
        if (jobRunsFrom != null) {
            jdbc.update("DELETE FROM paper_job_runs WHERE job = 'kr.decision' AND id > ?", jobRunsFrom);
        }
        if (!settingsExisted) {
            jdbc.update("DELETE FROM paper_settings");
            jdbc.update("DELETE FROM paper_settings_history WHERE version = 1");
        }
    }

    private void deleteKrBooks() {
        jdbc.update("DELETE FROM paper_books WHERE code IN ('kr_rules', 'kr_claude', 'kr_bench_k200', 'kr_bench_mix')");
    }

    @Test
    @DisplayName("S 22:30 출발 — 결정 둘·NEXT_OPEN 주문 셋·운용 전환·S 순자산 1억이 실제 표의 제약을 통과하고, 다시 돌려도 한 번")
    void startRowsPassDbConstraints() {
        for (PaperBooks.Definition d : PaperBooks.KR) {
            assertThat(store.insertBookIfAbsent(new PaperStore.Book(d.code(), d.kind(), d.label(), 100_000_000, null,
                    PaperBooks.NOT_STARTED, null, PaperStore.Book.MARKET_KR, PaperStore.Book.CURRENCY_KRW))).isTrue();
            store.upsertState(new PaperStore.BookState(d.code(), 100_000_000, 100_000_000, 0, 0, null, null, null, null));
        }
        StoreReader reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        Map<String, LocalDate> bars = new LinkedHashMap<>();
        bars.put("069500", S);
        bars.put("153130", S);
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES,
                KrFixtures.quotesPayload(S, bars), ZonedDateTime.of(LocalDateTime.parse("2026-11-30T21:57"),
                        KrxCalendar.SEOUL).toInstant()));
        KrFixtures.stub(reader, Datasets.SNAP_FSC_PRICES_META, KrFixtures.snapshot(Datasets.SNAP_FSC_PRICES_META,
                KrFixtures.fscMeta(LocalDate.of(2026, 11, 27)), null));
        PaperMarketData marketData = new PaperMarketData(reader, new StoreRepository(jdbc, MAPPER));
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, MAPPER);
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, S, PaperConfig.DEFAULT_KR_INITIAL_CASH);
        Clock night = Clock.fixed(ZonedDateTime.of(LocalDateTime.parse("2026-11-30T22:31"), KrxCalendar.SEOUL)
                .toInstant(), ZoneOffset.UTC);
        PaperDecisionJob job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), mock(ClaudeBookService.class), new PaperSettingsService(store, MAPPER), config,
                MAPPER, night);

        assertThat(job.run(KrPaperMarket.INSTANCE).outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(job.run(KrPaperMarket.INSTANCE).outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);

        assertThat(jdbc.queryForList("SELECT book_code || ' ' || kind || ' ' || status || ' ' || as_of_trading_date "
                + "|| ' ' || target_exposure_pct::text || ' ' || prices_final FROM paper_decisions "
                + "WHERE book_code LIKE 'kr\\_%' ORDER BY book_code", String.class)).containsExactly(
                "kr_bench_k200 INITIAL OK 2026-11-30 100.0000 false",
                "kr_bench_mix INITIAL OK 2026-11-30 100.0000 false");
        assertThat(jdbc.queryForList("SELECT book_code || ' ' || ticker || ' ' || timing || ' ' || source || ' ' || status "
                + "|| ' ' || target_weight_pct::text || ' ' || as_of_trading_date || ' ' || expires_on "
                + "FROM paper_orders WHERE book_code LIKE 'kr\\_%' ORDER BY book_code, ticker", String.class))
                .containsExactly(
                        "kr_bench_k200 069500 NEXT_OPEN BENCHMARK PENDING 100.0000 2026-11-30 2026-12-03",
                        "kr_bench_mix 069500 NEXT_OPEN BENCHMARK PENDING 60.0000 2026-11-30 2026-12-03",
                        "kr_bench_mix 153130 NEXT_OPEN BENCHMARK PENDING 40.0000 2026-11-30 2026-12-03");
        assertThat(jdbc.queryForList("SELECT code || ' ' || status || ' ' || COALESCE(started_on::text, '-') "
                + "FROM paper_books WHERE code LIKE 'kr\\_%' ORDER BY code", String.class)).containsExactly(
                "kr_bench_k200 ACTIVE 2026-11-30", "kr_bench_mix ACTIVE 2026-11-30", "kr_claude NOT_STARTED -",
                "kr_rules NOT_STARTED -");
        assertThat(jdbc.queryForList("SELECT book_code || ' ' || trading_date || ' ' || nav::text || ' ' || prices_final "
                + "FROM paper_nav_daily WHERE book_code LIKE 'kr\\_%' ORDER BY book_code", String.class))
                .containsExactly("kr_bench_k200 2026-11-30 100000000.0000 true",
                        "kr_bench_mix 2026-11-30 100000000.0000 true");
        assertThat(jdbc.queryForList("SELECT outcome FROM paper_job_runs WHERE job = 'kr.decision' AND id > ?",
                String.class, jobRunsFrom)).isEqualTo(List.of(PaperDecisionJob.STARTED));
    }
}
