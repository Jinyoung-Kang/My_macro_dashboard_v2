package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.SchemaCheck;
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
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.mock;

/**
 * QA-152 — 장중 평가(GET /api/paper/live)가 장부를 한 스냅숏으로 읽는가, 실제 테스트 DB(macrodash_test)에서. 장부는 책마다 한 트랜잭션으로 보유와
 * 상태(현금)를 함께 커밋하는데({@link PaperStore#atomically}), 장중 평가가 상태·순자산 줄·보유를 따로 SELECT하면(PostgreSQL 기본 READ COMMITTED —
 * 문장마다 새 스냅숏) 그 사이 커밋된 체결이 보유에만 보여 '옛 현금 + 새 보유'로 순자산이 매수 금액만큼 부풉니다.
 *
 * <p>시험은 장중 평가가 상태를 읽은 직후 다른 연결(다른 스레드)에서 매수 한 건을 커밋해 그 엇갈림을 정해진 순서로 만듭니다 — 시간 흐름에 기대지 않고, 시계도
 * 고정(토요일 — 장 밖이라 장중 시세는 읽지 않고 장부의 마지막 관측 가격으로 평가). 책은 시험 접두어 {@value #BOOK}(PaperStoreDbTest도 {@code t_}로 지움)이고
 * 시작·끝에 그 책만 지웁니다(상태·보유·순자산 줄은 외래키로 함께).
 */
class PaperLiveSnapshotDbTest {

    private static final String BOOK = "t_live";
    private static final LocalDate THU = LocalDate.of(2026, 10, 29);
    private static final LocalDate FRI = LocalDate.of(2026, 10, 30);
    private static final Instant OBSERVED = Instant.parse("2026-10-30T20:20:00Z");
    /** 2026-10-31(토) 00:00 KST 뒤 — 미국 장 밖(CLOSED). */
    private static final Instant SATURDAY = Instant.parse("2026-10-31T15:00:00Z");

    private JdbcTemplate jdbc;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL",
                "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        assumeTrue(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready(),
                "테스트 DB에 V8~V18(paper_*)이 없습니다 — make db-test");
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM paper_books WHERE code = ?", BOOK);
    }

    @Test
    @DisplayName("QA-152: 상태를 읽은 직후 장부가 매수 한 건을 커밋해도 장중 평가의 현금·보유·순자산은 한 시점(커밋 전 또는 뒤) — 순자산 100,000 그대로")
    void liveReadsTheLedgerAsOneSnapshot() throws Exception {
        PaperStore writer = new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        // 책 t_live(미국·운용): 현금 10,000 + AAA 100주 × 900 = 순자산 100,000, 순자산 줄은 목요일(금요일 기준의 직전 줄)
        writer.insertBookIfAbsent(new Book(BOOK, "CLAUDE", "시험 계좌", 100_000, THU, "ACTIVE", null));
        writer.upsertState(new BookState(BOOK, 10_000, 100_000, 90_000, 90.0, OBSERVED, OBSERVED, FRI, null));
        writer.upsertPosition(position("AAA", 100, 900));
        writer.upsertNav(new NavRow(BOOK, THU, 99_000, 10_000, 89_000, 89.9, true));

        // 장중 평가가 상태를 읽은 바로 뒤, 다른 연결에서 장부 커밋 하나 — BBB 50주 × 100 매수: 현금 5,000, 순자산은 그대로 100,000
        HookedStore store = new HookedStore(jdbc);
        store.afterState = () -> CompletableFuture.runAsync(() -> writer.atomically(() -> {
            writer.upsertPosition(position("BBB", 50, 100));
            writer.upsertState(new BookState(BOOK, 5_000, 100_000, 95_000, 95.0, OBSERVED, OBSERVED, FRI, null));
            return null;
        })).get(30, TimeUnit.SECONDS);

        StoreReader reader = PaperFixtures.quietReader();
        PaperMarketData marketData = new PaperMarketData(reader, mock(StoreRepository.class),
                Clock.fixed(SATURDAY, ZoneOffset.UTC));
        PaperConfig config = new PaperConfig(true, THU, 100_000, null, PaperConfig.DEFAULT_KR_INITIAL_CASH);
        PaperLiveService live = new PaperLiveService(store, reader, marketData, new PaperMarkets(store, reader), config,
                Clock.fixed(SATURDAY, ZoneOffset.UTC));

        Map<String, Object> row = book(live.live("US"));
        assertThat(store.fired).as("시험의 끼어든 커밋이 실제로 돌았다").isTrue();
        @SuppressWarnings("unchecked")
        List<Object> tickers = ((List<Map<String, Object>>) row.get("positions")).stream().map(h -> h.get("ticker")).toList();
        assertThat(List.of(row.get("cash"), tickers)).as("현금과 보유가 같은 시점 — 커밋 전(10,000·AAA) 또는 뒤(5,000·AAA·BBB)")
                .isIn(List.of(10_000.0, List.of("AAA")), List.of(5_000.0, List.of("AAA", "BBB")));
        assertThat(row).as("커밋 전이든 뒤든 순자산은 100,000").containsEntry("nav", 100_000.0);
    }

    // ------------------------------------------------------------------ 재료
    @SuppressWarnings("unchecked")
    private static Map<String, Object> book(Map<String, Object> out) {
        return ((List<Map<String, Object>>) out.get("books")).stream().filter(b -> BOOK.equals(b.get("code")))
                .findFirst().orElseThrow();
    }

    private static Position position(String ticker, int qty, double price) {
        return new Position(BOOK, ticker, qty, price, FRI, OBSERVED, price, OBSERVED, price, OBSERVED, false, FRI, price,
                null);
    }

    /** 시험 책의 상태를 읽은 직후 한 번 {@link #afterState}를 돕니다 — 장부 커밋이 끼어드는 자리. */
    private static final class HookedStore extends PaperStore {

        interface Hook {
            void run() throws Exception;
        }

        Hook afterState;
        boolean fired;

        HookedStore(JdbcTemplate jdbc) {
            super(jdbc, MAPPER, new SchemaCheck(jdbc));
        }

        @Override
        public Optional<BookState> state(String code) {
            Optional<BookState> out = super.state(code);
            if (BOOK.equals(code) && afterState != null) {
                Hook hook = afterState;
                afterState = null;
                try {
                    hook.run();
                } catch (Exception e) {
                    throw new IllegalStateException("끼어든 커밋이 실패했습니다", e);
                }
                fired = true;
            }
            return out;
        }
    }
}
