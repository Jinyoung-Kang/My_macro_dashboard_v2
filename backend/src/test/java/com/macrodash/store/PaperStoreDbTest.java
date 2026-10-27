package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 모의 매매 장부 테이블(V8)과 여러 시계열 읽기 — 실제 테스트 DB(macrodash_test)에서 유일 제약·덮어쓰기 규칙·트랜잭션을
 * 확인합니다. 가짜 저장소로는 ON CONFLICT·외래키·커서가 실제로 어떻게 도는지 알 수 없습니다.
 *
 * <p>운영 DB로 돌지 않도록 이름이 {@code _test}로 끝나는지 먼저 확인합니다. 다른 테스트(통합 테스트의 초기화 등)와
 * 겹치지 않게 책 코드·작업 이름은 {@code t_}로, 출발일 종가는 티커 {@code T_}로 시작하는 것만, 시계열은 데이터셋
 * {@code t_equity_close}만 쓰고 시작·끝에 그 행만 지웁니다. 설정은 한 행(id = 1)뿐이라, 설정 시험은 끝에 되돌리는
 * 트랜잭션 안에서만 합니다.
 *
 * <p>{@code timeseries}는 수집기 테이블입니다(ADR 0008). 백엔드 코드는 쓰지 않고, 여기서는 읽기를 시험할 행을 만들려고
 * 테스트에서만 씁니다(ArchitectureRulesTest는 main 소스만 검사).
 */
class PaperStoreDbTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String BOOK = "t_rules";
    private static final String OTHER_BOOK = "t_bench";
    private static final String TS_DATASET = "t_equity_close";
    private static final LocalDate DAY = LocalDate.of(2026, 10, 23);
    private static final Instant CLOSE = Instant.parse("2026-10-23T20:00:00Z");

    private JdbcTemplate jdbc;
    private PaperStore store;
    private StoreRepository repository;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL",
                "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        store = new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        repository = new StoreRepository(jdbc, MAPPER);
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        // 책을 지우면 상태·보유·재진입 금지·결정·주문·체결·순자산이 외래키로 함께 지워집니다.
        jdbc.update("DELETE FROM paper_books WHERE code LIKE 't\\_%'");
        jdbc.update("DELETE FROM paper_job_runs WHERE job LIKE 't\\_%'");
        jdbc.update("DELETE FROM paper_start_prices WHERE ticker LIKE 'T\\_%'");
        jdbc.update("DELETE FROM timeseries WHERE dataset = ?", TS_DATASET);
        // Claude 호출 사용량은 날짜가 키라, 시험은 쓰일 일이 없는 1999년 날짜만 씁니다.
        jdbc.update("DELETE FROM paper_api_usage WHERE day < DATE '2000-01-01'");
        // 주간 복기도 주가 키라 1999년 주만 씁니다(목록 시험은 되돌리는 트랜잭션 안에서만).
        jdbc.update("DELETE FROM paper_reviews WHERE week_ending < DATE '2000-01-01'");
    }

    private static PaperStore.Book book(String code, String label) {
        return new PaperStore.Book(code, "RULES", label, 100_000, null, "NOT_STARTED", null);
    }

    private static PaperStore.Order pendingBuy(String code, String ticker, Instant createdAt) {
        return new PaperStore.Order(0, code, null, ticker, "BUY", null, 10.0, null, "NEXT_OBSERVATION", "RULE",
                "PENDING", null, null, DAY, createdAt, DAY.plusDays(5), null);
    }

    private static PaperStore.Fill fill(long orderId, String code) {
        return new PaperStore.Fill(0, orderId, code, "SPY", "BUY", 147, 680.34, 680.0, 5, 100_009.98, CLOSE, DAY,
                "equity_close", true, null);
    }

    private static PaperStore.NavRow nav(LocalDate day, double value, boolean pricesFinal) {
        return new PaperStore.NavRow(BOOK, day, value, 10.0, value - 10.0, 99.99, pricesFinal);
    }

    @Test
    @DisplayName("테이블이 있다 — V8이 마지막에 만드는 paper_api_usage, V9~V11이 더하는 열, V12의 paper_reviews, V13의 paper_books 시장·통화 열, V14의 복기·메모 시장 열, V15의 since 봉 거래량 열로 준비 여부를 본다")
    void ready() {
        assertThat(store.ready()).as("make db-test로 V8~V15를 적용했는가").isTrue();
        assertThat(new SchemaCheck(jdbc).columnExists("paper_decisions", "packet_text")).isTrue();
        assertThat(new SchemaCheck(jdbc).tableExists("paper_reviews")).isTrue();
    }

    @Test
    @DisplayName("V13: paper_books에 market·currency 열 — 기존 계좌는 US·USD 기본값, 다른 값은 막힘(한국 책은 2단계)")
    void booksHaveMarketAndCurrency() {
        SchemaCheck schema = new SchemaCheck(jdbc);
        assertThat(schema.columnExists("paper_books", "market")).as("make db-test로 V13을 적용했는가").isTrue();
        assertThat(schema.columnExists("paper_books", "currency")).isTrue();
        assertThat(store.insertBookIfAbsent(book(BOOK, "시험 계좌"))).isTrue();
        assertThat(jdbc.queryForMap("SELECT market, currency FROM paper_books WHERE code = ?", BOOK))
                .containsEntry("market", "US").containsEntry("currency", "USD");
        assertThatThrownBy(() -> jdbc.update("UPDATE paper_books SET market = 'JP' WHERE code = ?", BOOK))
                .as("시장은 US·KR만").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    }

    @Test
    @DisplayName("V13 전 DB(paper_books.market·currency 열 없음)는 준비 안 됨 — 책 읽기·쓰기의 SQL 오류(500) 대신 안내 문구, 시험 뒤 되돌림")
    void readyRequiresV13() {
        class Rollback extends RuntimeException {
        }
        for (String column : List.of("market", "currency")) {
            assertThatThrownBy(() -> store.atomically(() -> {
                jdbc.execute("ALTER TABLE paper_books DROP COLUMN " + column);
                assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready())
                        .as("V13 열 " + column + "이 없으면 준비 안 됨").isFalse();
                throw new Rollback();
            })).isInstanceOf(Rollback.class);
        }
        assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("시장별 책 조회 — books(market)은 그 시장 책만 code 순, 시장·통화는 넣은 값 그대로 읽힘, 옛 모양(인자 7개)의 책은 US·USD, books()는 시장을 가리지 않음")
    void booksByMarket() {
        String krBook = "t_kr_rules";
        assertThat(store.insertBookIfAbsent(book(BOOK, "규칙 책"))).isTrue();
        assertThat(store.insertBookIfAbsent(book(OTHER_BOOK, "벤치마크"))).isTrue();
        assertThat(store.insertBookIfAbsent(new PaperStore.Book(krBook, "RULES", "한국 규칙 계좌", 100_000_000, null,
                "NOT_STARTED", null, PaperStore.Book.MARKET_KR, PaperStore.Book.CURRENCY_KRW))).isTrue();

        assertThat(jdbc.queryForMap("SELECT market, currency FROM paper_books WHERE code = ?", krBook))
                .containsEntry("market", "KR").containsEntry("currency", "KRW");
        assertThat(store.book(krBook).orElseThrow())
                .extracting(PaperStore.Book::market, PaperStore.Book::currency, PaperStore.Book::initialCash)
                .containsExactly("KR", "KRW", 100_000_000.0);
        assertThat(store.book(BOOK).orElseThrow())
                .extracting(PaperStore.Book::market, PaperStore.Book::currency)
                .as("옛 모양 생성자 = V13 기본값").containsExactly("US", "USD");

        assertThat(testCodes(store.books("US"))).as("미국 책만, code 순").containsExactly(OTHER_BOOK, BOOK);
        assertThat(testCodes(store.books("KR"))).as("한국 책만").containsExactly(krBook);
        assertThat(testCodes(store.books())).as("시장을 가리지 않음").containsExactly(OTHER_BOOK, krBook, BOOK);
        assertThat(store.books("JP")).as("모르는 시장").isEmpty();

        assertThatThrownBy(() -> new PaperStore.Book(BOOK, "RULES", "x", 1, null, null, null, null, "USD"))
                .as("시장을 비울 수 없음").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PaperStore.Book(BOOK, "RULES", "x", 1, null, null, null, "US", null))
                .as("통화를 비울 수 없음").isInstanceOf(IllegalArgumentException.class);
    }

    /** 이 시험이 만든 책(t_)의 코드만, 받은 순서대로 — 테스트 DB에 다른 테스트의 책이 있어도 흔들리지 않게. */
    private static List<String> testCodes(List<PaperStore.Book> books) {
        return books.stream().map(PaperStore.Book::code).filter(code -> code.startsWith("t_")).toList();
    }

    @Test
    @DisplayName("V8만 적용된 DB(paper_track_record.data_source 열 없음)는 준비 안 됨 — 트랙레코드 SQL 오류(500) 대신 안내 문구, 시험 뒤 되돌림")
    void readyRequiresV9() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("ALTER TABLE paper_track_record DROP COLUMN data_source");
            SchemaCheck schema = new SchemaCheck(jdbc);
            assertThat(schema.tableExists("paper_api_usage")).as("V8 테이블은 있음").isTrue();
            assertThat(schema.columnExists("paper_track_record", "data_source")).as("지운 열").isFalse();
            assertThat(new PaperStore(jdbc, MAPPER, schema).ready()).as("V9 전이면 준비 안 됨").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);

        SchemaCheck schema = new SchemaCheck(jdbc);
        assertThat(schema.columnExists("paper_track_record", "group_code")).isTrue();
        assertThat(schema.columnExists("paper_track_record", "data_source")).as("되돌린 뒤").isTrue();
        assertThat(schema.columnExists("paper_track_record", "no_such_column")).isFalse();
        assertThat(schema.columnExists("no_such_table", "data_source")).as("테이블이 없으면 false").isFalse();
        assertThat(new PaperStore(jdbc, MAPPER, schema).ready()).isTrue();
    }

    @Test
    @DisplayName("책은 한 번만 생긴다 — 두 번째 넣기는 false이고 처음 값이 남는다")
    void insertBookIfAbsentIsIdempotent() {
        assertThat(store.insertBookIfAbsent(book(BOOK, "규칙 책"))).isTrue();
        assertThat(store.insertBookIfAbsent(book(BOOK, "다른 이름"))).isFalse();

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_books WHERE code = ?", Integer.class, BOOK))
                .isEqualTo(1);
        PaperStore.Book saved = store.book(BOOK).orElseThrow();
        assertThat(saved.label()).isEqualTo("규칙 책");
        assertThat(saved.initialCash()).isEqualTo(100_000);
        assertThat(saved.startedOn()).as("시작 전이면 출발일 없음").isNull();
        assertThat(saved.createdAt()).as("비우면 DB가 채움").isNotNull();
        assertThat(store.book("t_none")).isEmpty();

        store.updateBookStatus(BOOK, "ACTIVE");
        store.updateBookStartedOn(BOOK, DAY);
        assertThat(store.book(BOOK).orElseThrow())
                .extracting(PaperStore.Book::status, PaperStore.Book::startedOn)
                .containsExactly("ACTIVE", DAY);
        store.updateBookStartedOn(BOOK, null);
        assertThat(store.book(BOOK).orElseThrow().startedOn()).isNull();
    }

    @Test
    @DisplayName("이름 바꾸기는 지금 이름이 옛 이름 그대로일 때만 — 두 번째는 false, 다른 이름·없는 책은 그대로")
    void relabelBookOnlyFromExactLabel() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        store.insertBookIfAbsent(book(OTHER_BOOK, "내가 붙인 이름"));

        assertThat(store.relabelBook(BOOK, "규칙 책", "규칙 계좌")).isTrue();
        assertThat(store.book(BOOK).orElseThrow().label()).isEqualTo("규칙 계좌");
        assertThat(store.relabelBook(BOOK, "규칙 책", "규칙 계좌")).as("이미 바뀜 — 멱등").isFalse();
        assertThat(store.book(BOOK).orElseThrow().label()).isEqualTo("규칙 계좌");

        assertThat(store.relabelBook(OTHER_BOOK, "SPY 100%", "SPY 계좌")).as("손으로 고친 이름").isFalse();
        assertThat(store.book(OTHER_BOOK).orElseThrow().label()).isEqualTo("내가 붙인 이름");
        assertThat(store.relabelBook("t_none", "규칙 책", "규칙 계좌")).as("없는 책").isFalse();
    }

    @Test
    @DisplayName("체결은 주문당 하나 — 같은 주문의 두 번째 체결은 DuplicateKeyException이고 행은 하나")
    void oneFillPerOrder() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        long orderId = store.insertOrder(pendingBuy(BOOK, "SPY", null));
        long fillId = store.insertFill(fill(orderId, BOOK));
        assertThat(fillId).isPositive();

        assertThatThrownBy(() -> store.insertFill(fill(orderId, BOOK))).isInstanceOf(DuplicateKeyException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_fills WHERE order_id = ?", Integer.class, orderId))
                .isEqualTo(1);

        PaperStore.Fill saved = store.recentFills(BOOK, 10).get(0);
        assertThat(saved.orderId()).isEqualTo(orderId);
        assertThat(saved.price()).isEqualTo(680.34);
        assertThat(saved.gross()).isEqualTo(100_009.98);
        assertThat(saved.observedAt()).isEqualTo(CLOSE);
        assertThat(saved.observationDate()).isEqualTo(DAY);
        assertThat(saved.backfill()).isTrue();
    }

    @Test
    @DisplayName("확정 순자산은 미확정 값으로 덮이지 않는다 — 미확정은 확정으로, 확정은 새 확정으로 바뀐다")
    void finalNavIsNotOverwrittenByProvisional() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        LocalDate next = DAY.plusDays(3);

        store.upsertNav(nav(DAY, 100_000, true));
        store.upsertNav(nav(DAY, 99_000, false));              // 다음 날 새벽의 묵은 관측치
        store.upsertNav(nav(next, 101_000, false));
        store.upsertNav(nav(next, 101_500, true));             // 장 마감 뒤 확정

        List<PaperStore.NavRow> series = store.navSeries(BOOK);
        assertThat(series).extracting(PaperStore.NavRow::tradingDate).containsExactly(DAY, next);
        assertThat(series.get(0).nav()).as("확정값이 남음").isEqualTo(100_000);
        assertThat(series.get(0).pricesFinal()).isTrue();
        assertThat(series.get(1).nav()).isEqualTo(101_500);
        assertThat(series.get(1).pricesFinal()).isTrue();

        store.upsertNav(nav(DAY, 100_100, true));              // 확정끼리는 새 값
        assertThat(store.navSeries(BOOK).get(0).nav()).isEqualTo(100_100);
        assertThat(store.navSeriesAll()).filteredOn(r -> r.bookCode().equals(BOOK)).hasSize(2);
    }

    @Test
    @DisplayName("그날 순자산 줄 하나 읽기(navRow) — 이력 전체 읽기와 같은 행, 없는 날·다른 책은 empty")
    void navRowReadsOneLine() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        LocalDate next = DAY.plusDays(3);
        store.upsertNav(nav(DAY, 100_000, true));
        store.upsertNav(nav(next, 101_000, false));

        assertThat(store.navRow(BOOK, next)).contains(store.navSeries(BOOK).get(1));
        assertThat(store.navRow(BOOK, DAY)).get().satisfies(row -> {
            assertThat(row.nav()).isEqualTo(100_000);
            assertThat(row.pricesFinal()).isTrue();
        });
        assertThat(store.navRow(BOOK, DAY.plusDays(1))).isEmpty();
        assertThat(store.navRow(OTHER_BOOK, DAY)).isEmpty();
    }

    @Test
    @DisplayName("atomically 안에서 예외가 나면 그 안의 쓰기가 모두 되돌려진다")
    void atomicallyRollsBackOnException() {
        assertThatThrownBy(() -> store.atomically(() -> {
            store.insertBookIfAbsent(book(BOOK, "규칙 책"));
            store.upsertState(new PaperStore.BookState(BOOK, 100_000, 100_000, 0, 0, null, null, null, null));
            throw new IllegalStateException("중간에 실패");
        })).isInstanceOf(IllegalStateException.class).hasMessage("중간에 실패");

        assertThat(store.book(BOOK)).isEmpty();
        assertThat(store.state(BOOK)).isEmpty();
    }

    @Test
    @DisplayName("트랜잭션 안의 중복 체결은 앞선 쓰기까지 함께 되돌린다 — 반쯤 적용된 관측치가 남지 않는다")
    void duplicateFillInsideTransactionRollsBackEverything() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        long orderId = store.insertOrder(pendingBuy(BOOK, "SPY", null));
        store.insertFill(fill(orderId, BOOK));

        assertThatThrownBy(() -> store.atomically(() -> {
            store.markOrderFilled(orderId, CLOSE);
            return store.insertFill(fill(orderId, BOOK));
        })).isInstanceOf(DuplicateKeyException.class);

        assertThat(store.ordersByStatus(BOOK, "PENDING")).as("상태 변경도 되돌려짐").hasSize(1);
    }

    @Test
    @DisplayName("시계열 여러 개를 한 번에 — 범위(양끝 포함)·날짜 오름차순·NULL 건너뜀·없는 시계열은 키 없음")
    void readTimeseriesColumns() {
        // 일부러 날짜를 섞어 넣습니다(정렬은 DB가 해야 함).
        insertPoint("T_A", "2026-10-21", 10.5);
        insertPoint("T_A", "2026-10-19", 10.0);
        insertPoint("T_A", "2026-10-23", 11.0);
        insertPoint("T_A", "2026-10-22", null);                // 건너뜀
        insertPoint("T_A", "2026-10-26", 12.0);                // 범위 밖
        insertPoint("T_B", "2026-10-20", 200.0);
        insertPoint("T_C", "2026-10-20", null);                // 값이 하나도 없는 시계열

        Map<String, StoreRepository.TimeseriesColumns> got = repository.readTimeseriesColumns(TS_DATASET,
                List.of("T_B", "T_A", "T_C", "T_MISSING", "T_A"), LocalDate.of(2026, 10, 19), DAY);

        assertThat(got).containsOnlyKeys("T_A", "T_B");
        assertThat(got.keySet()).as("series_id 순").containsExactly("T_A", "T_B");
        StoreRepository.TimeseriesColumns a = got.get("T_A");
        assertThat(a.epochDays()).containsExactly(epoch("2026-10-19"), epoch("2026-10-21"), epoch("2026-10-23"));
        assertThat(a.values()).containsExactly(10.0, 10.5, 11.0);
        assertThat(a.size()).isEqualTo(3);
        assertThat(LocalDate.ofEpochDay(a.epochDays()[0])).isEqualTo(LocalDate.of(2026, 10, 19));
        assertThat(got.get("T_B").values()).containsExactly(200.0);

        // 범위를 비우면 제한 없음, 한쪽만 주면 그쪽만.
        assertThat(repository.readTimeseriesColumns(TS_DATASET, List.of("T_A"), null, null).get("T_A").values())
                .containsExactly(10.0, 10.5, 11.0, 12.0);
        assertThat(repository.readTimeseriesColumns(TS_DATASET, List.of("T_A"), LocalDate.of(2026, 10, 23), null)
                .get("T_A").values()).containsExactly(11.0, 12.0);
        assertThat(repository.readTimeseriesColumns(TS_DATASET, List.of("T_A"), null, LocalDate.of(2026, 10, 19))
                .get("T_A").values()).containsExactly(10.0);
        assertThat(repository.readTimeseriesColumns(TS_DATASET, List.of(), null, null)).isEmpty();
        assertThat(repository.readTimeseriesColumns("t_other_dataset", List.of("T_A"), null, null)).isEmpty();
    }

    @Test
    @DisplayName("버퍼보다 긴 시계열도 빠짐없이 — 10년치(2,600점)가 그대로 온다")
    void readTimeseriesColumnsLongSeries() {
        LocalDate start = LocalDate.of(2016, 10, 24);
        int points = 2_600;
        jdbc.update("INSERT INTO timeseries (dataset, series_id, obs_date, value) "
                + "SELECT ?, 'T_LONG', ?::date + g, g FROM generate_series(0, ?) AS g", TS_DATASET,
                java.sql.Date.valueOf(start), points - 1);

        StoreRepository.TimeseriesColumns got = repository
                .readTimeseriesColumns(TS_DATASET, List.of("T_LONG"), null, null).get("T_LONG");

        assertThat(got.size()).isEqualTo(points);
        assertThat(got.epochDays()[0]).isEqualTo((int) start.toEpochDay());
        assertThat(got.epochDays()[points - 1]).isEqualTo((int) start.plusDays(points - 1).toEpochDay());
        assertThat(got.values()[points - 1]).isEqualTo(points - 1);
    }

    @Test
    @DisplayName("장부 트랜잭션 안에서 시계열을 읽고 이어서 써도 된다 — 읽기 전용 트랜잭션이 바깥 쓰기를 막지 않는다")
    void readTimeseriesColumnsJoinsOuterTransaction() {
        insertPoint("T_A", "2026-10-23", 11.0);

        store.atomically(() -> {
            store.insertBookIfAbsent(book(BOOK, "규칙 책"));
            assertThat(repository.readTimeseriesColumns(TS_DATASET, List.of("T_A"), DAY, DAY)).containsOnlyKeys("T_A");
            store.upsertState(new PaperStore.BookState(BOOK, 1, 1, 0, 0, null, CLOSE, null, null));
            return null;
        });

        assertThat(store.state(BOOK).orElseThrow().lastProcessedCollectedAt()).isEqualTo(CLOSE);
    }

    @Test
    @DisplayName("작업 기록은 작업마다 최근 200건만 남는다 — 다른 작업의 기록은 건드리지 않는다")
    void recordJobRunKeepsRecent200PerJob() {
        // 다른 테스트가 지금 시각으로 남긴 기록보다 뒤에 오도록 먼 미래 시각을 씁니다(최근 순 조회 검사).
        Instant base = Instant.parse("2099-01-01T00:00:00Z");
        JsonNode detail = MAPPER.valueToTree(Map.of("tickers", 572));
        for (int i = 0; i < 3; i++) {
            store.recordJobRun("t_other", base.plusSeconds(i), base.plusSeconds(i + 1), "ok", detail);
        }
        for (int i = 0; i < 205; i++) {
            store.recordJobRun("t_risk", base.plusSeconds(60L * i), base.plusSeconds(60L * i + 5), "ok",
                    i == 204 ? detail : null);
        }

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_job_runs WHERE job = 't_risk'", Integer.class))
                .isEqualTo(PaperStore.JOB_RUNS_KEPT);
        assertThat(jdbc.queryForObject("SELECT MIN(started_at) FROM paper_job_runs WHERE job = 't_risk'",
                Timestamp.class).toInstant()).as("가장 오래된 5건이 지워짐").isEqualTo(base.plusSeconds(60L * 5));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_job_runs WHERE job = 't_other'", Integer.class))
                .isEqualTo(3);

        List<PaperStore.JobRun> recent = store.recentJobRuns(2);
        assertThat(recent).extracting(PaperStore.JobRun::startedAt)
                .containsExactly(base.plusSeconds(60L * 204), base.plusSeconds(60L * 203));
        assertThat(recent.get(0).job()).isEqualTo("t_risk");
        assertThat(recent.get(0).finishedAt()).isEqualTo(base.plusSeconds(60L * 204 + 5));
        assertThat(recent.get(0).detail().path("tickers").asInt()).isEqualTo(572);
        assertThat(recent.get(1).detail().isObject() && recent.get(1).detail().isEmpty())
                .as("detail이 null이면 {}").isTrue();
    }

    @Test
    @DisplayName("주문: 넣은 값이 그대로 돌아오고, 만료·취소·체결 표시는 조건에 맞는 것만 바꾼다")
    void ordersLifecycle() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        store.insertBookIfAbsent(book(OTHER_BOOK, "벤치마크"));
        // 사후 체결 주문은 시각을 직접 줍니다. 순서 검사가 DB 시계에 기대지 않게 지금보다 확실히 앞선 시각을 씁니다.
        Instant backfillAt = Instant.parse("2001-01-01T00:00:00Z");
        long backfill = store.insertOrder(new PaperStore.Order(0, BOOK, null, "SPY", "BUY", 147, null, null,
                "BACKFILL", "BENCHMARK", "PENDING", null, MAPPER.valueToTree(Map.of("note", "사후 체결")),
                DAY.minusDays(1), backfillAt, null, null));
        long first = store.insertOrder(pendingBuy(BOOK, "XLK", null));
        long proposed = store.insertOrder(new PaperStore.Order(0, BOOK, null, "XLE", "SELL", null, null, 0.5,
                "NEXT_CLOSE", "CLAUDE", "PROPOSED", null, null, DAY, null, DAY.plusDays(5), null));
        long other = store.insertOrder(pendingBuy(OTHER_BOOK, "SPY", null));

        PaperStore.Order savedBackfill = store.ordersByStatus(BOOK, "PENDING").get(0);
        assertThat(savedBackfill.id()).as("created_at 순 — 사후 체결 주문이 앞").isEqualTo(backfill);
        assertThat(savedBackfill.createdAt()).as("준 시각을 씀").isEqualTo(backfillAt);
        assertThat(savedBackfill.qty()).isEqualTo(147);
        assertThat(savedBackfill.targetWeightPct()).as("없는 값은 null").isNull();
        assertThat(savedBackfill.decisionId()).isNull();
        assertThat(savedBackfill.expiresOn()).isNull();
        assertThat(savedBackfill.reason().path("note").asText()).isEqualTo("사후 체결");
        PaperStore.Order savedFirst = store.ordersByStatus(BOOK, "PENDING").get(1);
        assertThat(savedFirst.id()).isEqualTo(first);
        assertThat(savedFirst.qty()).isNull();
        assertThat(savedFirst.targetWeightPct()).isEqualTo(10.0);
        assertThat(savedFirst.reason().isObject() && savedFirst.reason().isEmpty()).as("reason이 null이면 {}").isTrue();
        assertThat(store.ordersByStatus(BOOK, "PROPOSED").get(0).sellFraction()).isEqualTo(0.5);

        store.markOrderFilled(backfill, CLOSE);
        assertThat(store.expireOrders(BOOK, DAY.plusDays(6)))
                .as("PENDING이고 기한이 지난 것만(기한 없는 주문·PROPOSED·다른 책 제외)").isEqualTo(1);
        assertThat(store.cancelPendingOrders(BOOK)).as("PROPOSED만 남아 있음").isEqualTo(1);
        store.markOrderStatus(other, "REJECTED", "OVER_ALLOCATED");

        List<PaperStore.Order> recent = store.recentOrders(BOOK, 10);
        assertThat(recent).extracting(PaperStore.Order::id).containsExactly(proposed, first, backfill);
        assertThat(recent).extracting(PaperStore.Order::status).containsExactly("CANCELLED", "EXPIRED", "FILLED");
        assertThat(recent.get(2).filledAt()).isEqualTo(CLOSE);
        assertThat(store.recentOrders(BOOK, 1)).hasSize(1);
        PaperStore.Order rejected = store.recentOrders(OTHER_BOOK, 10).get(0);
        assertThat(rejected.status()).isEqualTo("REJECTED");
        assertThat(rejected.rejectReason()).isEqualTo("OVER_ALLOCATED");
    }

    @Test
    @DisplayName("상태·보유·재진입 금지: 넣고 바꾸고 지운 값이 그대로 읽힌다(빈 값은 null)")
    void stateAndPositionsRoundTrip() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        store.upsertState(new PaperStore.BookState(BOOK, 100_000, 100_000, 0, 0, null, null, null, null));
        assertThat(store.state(BOOK).orElseThrow().lastProcessedCollectedAt()).isNull();
        store.upsertState(new PaperStore.BookState(BOOK, 50_000.1234, 100_500, 50_499.8766, 50.2486, CLOSE, CLOSE, DAY,
                null));
        PaperStore.BookState state = store.state(BOOK).orElseThrow();
        assertThat(state.cash()).isEqualTo(50_000.1234);
        assertThat(state.lastProcessedCollectedAt()).isEqualTo(CLOSE);
        assertThat(state.lastNavTradingDate()).isEqualTo(DAY);
        assertThat(state.updatedAt()).isNotNull();

        store.upsertPosition(new PaperStore.Position(BOOK, "XLK", 10, 250.5, DAY, CLOSE, 252, CLOSE, null, null, true,
                DAY, 250.123456, null));
        store.upsertPosition(new PaperStore.Position(BOOK, "AAPL", 3, 230, DAY, CLOSE, 230, CLOSE, 231.5, CLOSE, false,
                DAY, 230, "2:1 분할 반영"));
        List<PaperStore.Position> positions = store.positions(BOOK);
        assertThat(positions).extracting(PaperStore.Position::ticker).containsExactly("AAPL", "XLK");
        PaperStore.Position xlk = positions.get(1);
        assertThat(xlk.lastPrice()).as("가격을 못 받았으면 null").isNull();
        assertThat(xlk.lastPriceAt()).isNull();
        assertThat(xlk.priceStale()).isTrue();
        assertThat(xlk.fillRefClose()).isEqualTo(250.123456);
        assertThat(positions.get(0).splitNote()).isEqualTo("2:1 분할 반영");

        store.upsertPosition(new PaperStore.Position(BOOK, "XLK", 12, 251, DAY, CLOSE, 260, CLOSE, 259.9, CLOSE, false,
                DAY, 250.123456, null));
        assertThat(store.positions(BOOK).get(1)).extracting(PaperStore.Position::qty, PaperStore.Position::lastPrice)
                .containsExactly(12, 259.9);
        store.deletePosition(BOOK, "AAPL");
        assertThat(store.positions(BOOK)).extracting(PaperStore.Position::ticker).containsExactly("XLK");

        store.upsertLockout(new PaperStore.Lockout(BOOK, "XLE", DAY.plusDays(10), "트레일링 스탑"));
        store.upsertLockout(new PaperStore.Lockout(BOOK, "XLE", DAY.plusDays(30), "트레일링 스탑(다시)"));
        store.upsertLockout(new PaperStore.Lockout(BOOK, "XLB", DAY, "트레일링 스탑"));
        assertThat(store.lockouts(BOOK)).extracting(PaperStore.Lockout::ticker).containsExactly("XLB", "XLE");
        assertThat(store.lockouts(BOOK).get(1).untilTradingDate()).as("새 기한으로 덮음").isEqualTo(DAY.plusDays(30));
        assertThat(store.deleteLockoutsBefore(BOOK, DAY)).as("기한 당일까지는 남김").isZero();
        assertThat(store.deleteLockoutsBefore(BOOK, DAY.plusDays(1))).isEqualTo(1);
        assertThat(store.lockouts(BOOK)).extracting(PaperStore.Lockout::ticker).containsExactly("XLE");
    }

    @Test
    @DisplayName("출발일 종가는 같은 거래일이면 처음 값이 남고(배당락 뒤 다시 넣어도), 다른 거래일 행만 바뀐다")
    void startPriceIsFrozenPerTradingDate() {
        Instant first = Instant.parse("2026-10-24T03:00:00Z");
        assertThat(store.insertStartPriceIfAbsent(new PaperStore.StartPrice("T_SPY", DAY, 680.123456, "equity_close",
                first))).isTrue();
        assertThat(store.insertStartPriceIfAbsent(new PaperStore.StartPrice("T_SPY", DAY, 676.5, "equity_close",
                null))).as("배당락으로 낮아진 수정 종가 — 덮지 않음").isFalse();
        assertThat(store.insertStartPriceIfAbsent(new PaperStore.StartPrice("T_SHY", DAY, 82.5, "paper.quotes",
                null))).isTrue();

        PaperStore.StartPrice spy = store.startPrice("T_SPY").orElseThrow();
        assertThat(spy.close()).isEqualTo(680.123456);
        assertThat(spy.tradingDate()).isEqualTo(DAY);
        assertThat(spy.source()).isEqualTo("equity_close");
        assertThat(spy.capturedAt()).isEqualTo(first);
        assertThat(store.startPrice("T_SHY").orElseThrow().capturedAt()).as("비우면 DB가 채움").isNotNull();
        assertThat(store.startPrice("T_NONE")).isEmpty();
        assertThat(store.startPrices()).filteredOn(p -> p.ticker().startsWith("T_"))
                .extracting(PaperStore.StartPrice::ticker).containsExactly("T_SHY", "T_SPY");

        // 출발일 설정을 바꾼 경우 — 옛 날짜의 값은 새 날짜에 쓸 수 없어 바꿉니다.
        LocalDate other = DAY.plusDays(3);
        assertThat(store.insertStartPriceIfAbsent(new PaperStore.StartPrice("T_SPY", other, 690, "paper.quotes",
                null))).isTrue();
        assertThat(store.startPrice("T_SPY").orElseThrow())
                .extracting(PaperStore.StartPrice::tradingDate, PaperStore.StartPrice::close)
                .containsExactly(other, 690.0);
    }

    @Test
    @DisplayName("주문 근거를 통째로 바꾼다 — 현금 부족으로 줄인 매수의 cashLimited, null이면 {}")
    void updateOrderReason() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        long id = store.insertOrder(new PaperStore.Order(0, BOOK, null, "XLK", "BUY", 100, null, null,
                "NEXT_OBSERVATION", "RULE", "PENDING", null, MAPPER.valueToTree(Map.of("note", "신호")), DAY, null,
                DAY.plusDays(5), null));

        store.updateOrderReason(id, MAPPER.valueToTree(Map.of("note", "신호", "cashLimited", true,
                "requestedQty", 100, "filledQty", 40)));
        JsonNode reason = store.recentOrders(BOOK, 1).get(0).reason();
        assertThat(reason.path("cashLimited").asBoolean()).isTrue();
        assertThat(reason.path("requestedQty").asInt()).isEqualTo(100);
        assertThat(reason.path("filledQty").asInt()).isEqualTo(40);
        assertThat(reason.path("note").asString()).isEqualTo("신호");

        store.updateOrderReason(id, null);
        JsonNode cleared = store.recentOrders(BOOK, 1).get(0).reason();
        assertThat(cleared.isObject() && cleared.isEmpty()).isTrue();
    }

    @Test
    @DisplayName("NaN 금액은 저장하지 않는다 — NUMERIC이 받아 주는 계산 오류를 입구에서 막음")
    void nonFiniteMoneyIsRejected() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        assertThatThrownBy(() -> store.upsertNav(nav(DAY, Double.NaN, true)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("nav");
        assertThat(store.navSeries(BOOK)).isEmpty();
    }

    @Test
    @DisplayName("책 초기화는 그 책의 장부만 비우고 책 행과 다른 책은 남긴다")
    void resetBookClearsOnlyThatLedger() {
        for (String code : List.of(BOOK, OTHER_BOOK)) {
            store.insertBookIfAbsent(book(code, code));
            store.upsertState(new PaperStore.BookState(code, 1, 1, 0, 0, null, null, null, null));
            long orderId = store.insertOrder(pendingBuy(code, "SPY", null));
            store.insertFill(fill(orderId, code));
            store.upsertPosition(new PaperStore.Position(code, "SPY", 1, 1, DAY, CLOSE, 1, CLOSE, null, null, false,
                    DAY, 1, null));
            store.upsertLockout(new PaperStore.Lockout(code, "XLE", DAY, "스탑"));
            store.upsertNav(new PaperStore.NavRow(code, DAY, 1, 1, 0, 0, true));
        }
        store.updateBookStatus(BOOK, "ACTIVE");

        store.resetBook(BOOK);

        assertThat(store.book(BOOK).orElseThrow().status()).as("책 행·상태는 호출자가 맞춤").isEqualTo("ACTIVE");
        assertThat(store.state(BOOK)).isEmpty();
        assertThat(store.recentOrders(BOOK, 10)).isEmpty();
        assertThat(store.recentFills(BOOK, 10)).isEmpty();
        assertThat(store.positions(BOOK)).isEmpty();
        assertThat(store.lockouts(BOOK)).isEmpty();
        assertThat(store.navSeries(BOOK)).isEmpty();

        assertThat(store.state(OTHER_BOOK)).isPresent();
        assertThat(store.recentFills(OTHER_BOOK, 10)).hasSize(1);
        assertThat(store.navSeries(OTHER_BOOK)).hasSize(1);
    }

    @Test
    @DisplayName("설정: 초기화는 한 번(버전 1·이력 1), 저장은 버전 +1과 이력 — 시험 뒤 되돌림")
    void settingsVersioning() {
        // 설정은 한 행뿐이라 다른 테스트가 남긴 행을 건드리지 않도록 되돌리는 트랜잭션 안에서만 시험합니다.
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_settings_history");
            jdbc.update("DELETE FROM paper_settings");
            assertThat(store.settings()).isEmpty();

            JsonNode body = MAPPER.valueToTree(Map.of("slippageBp", 5, "trailingStopPct", 8));
            assertThat(store.initSettingsIfAbsent(body)).isTrue();
            assertThat(store.initSettingsIfAbsent(MAPPER.valueToTree(Map.of("slippageBp", 99)))).isFalse();
            PaperStore.SettingsRow first = store.settings().orElseThrow();
            assertThat(first.version()).isEqualTo(1);
            assertThat(first.body().path("slippageBp").asInt()).isEqualTo(5);

            int version = store.saveSettings(MAPPER.valueToTree(Map.of("slippageBp", 7, "trailingStopPct", 8)),
                    List.of("slippageBp"));
            assertThat(version).isEqualTo(2);
            assertThat(store.settings().orElseThrow().body().path("slippageBp").asInt()).isEqualTo(7);
            assertThat(jdbc.queryForList("SELECT version, array_to_string(changed_keys, ',') AS keys "
                    + "FROM paper_settings_history ORDER BY version"))
                    .extracting(row -> row.get("version") + ":" + row.get("keys"))
                    .containsExactly("1:", "2:slippageBp");
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("설정 이력: 최근 버전 순으로 본문·바뀐 키·시각 — 시험 뒤 되돌림")
    void settingsHistoryIsNewestFirst() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_settings_history");
            jdbc.update("DELETE FROM paper_settings");
            store.initSettingsIfAbsent(MAPPER.valueToTree(Map.of("slippageBp", 5)));
            store.saveSettings(MAPPER.valueToTree(Map.of("slippageBp", 6)), List.of("slippageBp"));
            store.saveSettings(MAPPER.valueToTree(Map.of("slippageBp", 6, "model", "claude-haiku-5-5")),
                    List.of("model", "effort"));

            List<PaperStore.SettingsHistoryRow> history = store.settingsHistory(10);
            assertThat(history).extracting(PaperStore.SettingsHistoryRow::version).containsExactly(3, 2, 1);
            assertThat(history.get(0).changedKeys()).containsExactly("model", "effort");
            assertThat(history.get(0).body().path("model").asString()).isEqualTo("claude-haiku-5-5");
            assertThat(history.get(2).changedKeys()).as("처음 값").isEmpty();
            assertThat(history.get(2).createdAt()).isNotNull();
            assertThat(store.settingsHistory(1)).hasSize(1);
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("Claude 호출 사용량: 상한 안에서만 호출을 잡고(한 문장), 되돌리기는 0 아래로 안 가고, 토큰은 아는 값만 더하고, 기간 합계")
    void apiUsageReservesWithinCap() {
        LocalDate day = LocalDate.of(1999, 1, 4);
        LocalDate next = LocalDate.of(1999, 1, 5);
        assertThat(store.apiUsage(day)).isEmpty();
        assertThat(store.reserveApiCall(day, 0)).as("상한 0").isFalse();
        assertThat(store.apiUsage(day)).as("상한 0이면 행도 만들지 않음").isEmpty();

        assertThat(store.reserveApiCall(day, 2)).isTrue();
        assertThat(store.reserveApiCall(day, 2)).isTrue();
        assertThat(store.reserveApiCall(day, 2)).as("세 번째는 상한").isFalse();
        assertThat(store.apiUsage(day).orElseThrow().calls()).isEqualTo(2);

        store.addApiTokens(day, 21_000L, 3_100L, null, 0L);
        store.addApiTokens(day, 1_000L, null, 7_800L, null);
        PaperStore.ApiUsage usage = store.apiUsage(day).orElseThrow();
        assertThat(usage.calls()).as("토큰 더하기는 호출 수를 바꾸지 않음").isEqualTo(2);
        assertThat(usage.inputTokens()).isEqualTo(22_000);
        assertThat(usage.outputTokens()).isEqualTo(3_100);
        assertThat(usage.cacheReadTokens()).isEqualTo(7_800);
        assertThat(usage.cacheWriteTokens()).isZero();

        store.releaseApiCall(day);
        store.releaseApiCall(day);
        store.releaseApiCall(day);
        assertThat(store.apiUsage(day).orElseThrow().calls()).as("0 아래로는 내리지 않음").isZero();

        store.addApiTokens(next, 5L, 6L, null, null);   // 행이 없으면 호출 0으로 만듦
        assertThat(store.apiUsage(next).orElseThrow().calls()).isZero();
        assertThat(store.reserveApiCall(next, 1)).isTrue();
        PaperStore.ApiUsageTotal total = store.apiUsageBetween(LocalDate.of(1999, 1, 1), LocalDate.of(1999, 1, 31));
        assertThat(total.days()).isEqualTo(2);
        assertThat(total.calls()).isEqualTo(1);
        assertThat(total.inputTokens()).isEqualTo(22_005);
        assertThat(total.outputTokens()).isEqualTo(3_106);
        PaperStore.ApiUsageTotal empty = store.apiUsageBetween(LocalDate.of(1998, 1, 1), LocalDate.of(1998, 1, 31));
        assertThat(empty.days()).isZero();
        assertThat(empty.calls()).isZero();
    }

    @Test
    @DisplayName("결정 재시도: API 오류·재시도 전 행만 통째로 바꾸고 재시도 수 1 — 두 번째·다른 상태는 바꾸지 않음")
    void decisionRetryUpdatesOnlyOnce() throws Exception {
        store.insertBookIfAbsent(book(BOOK, "Claude 책 시험"));
        long id = store.insertDecisionIfAbsent(new PaperStore.Decision(0, BOOK, DAY, "SCHEDULED", null, "API_ERROR",
                "claude-sonnet-5-5", null, 1, null, null, MAPPER.readTree("{\"p\":1}"), "h1", null, null, null,
                "[RATE_LIMIT] 429", List.of(), true, 12L, 0)).orElseThrow();
        long ok = store.insertDecisionIfAbsent(new PaperStore.Decision(0, BOOK, DAY, "MANUAL", null, "OK", null, null, 1,
                null, null, null, null, null, null, null, null, null, true, 1L, 0)).orElseThrow();

        PaperStore.Decision retry = new PaperStore.Decision(id, BOOK, DAY, "SCHEDULED", null, "OK",
                "claude-haiku-5-5", 3, 2, DAY, 42.5, MAPPER.readTree("{\"p\":2}"), "h2", "{\"raw\":true}",
                MAPPER.readTree("{\"summary\":\"두 번째\"}"), MAPPER.readTree("{\"inputTokens\":9}"), null,
                List.of(4L), false, 99L, 0);
        assertThat(store.updateDecisionRetry(retry)).isTrue();
        PaperStore.Decision saved = store.decision(id).orElseThrow();
        assertThat(saved.status()).isEqualTo("OK");
        assertThat(saved.retryCount()).isEqualTo(1);
        assertThat(saved.model()).isEqualTo("claude-haiku-5-5");
        assertThat(saved.frameworkVersion()).isEqualTo(3);
        assertThat(saved.settingsVersion()).isEqualTo(2);
        assertThat(saved.selectionAsOf()).isEqualTo(DAY);
        assertThat(saved.targetExposurePct()).isEqualTo(42.5);
        assertThat(saved.packet().path("p").asInt()).isEqualTo(2);
        assertThat(saved.packetHash()).isEqualTo("h2");
        assertThat(saved.responseRaw()).isEqualTo("{\"raw\":true}");
        assertThat(saved.response().path("summary").asString()).isEqualTo("두 번째");
        assertThat(saved.usage().path("inputTokens").asInt()).isEqualTo(9);
        assertThat(saved.error()).isNull();
        assertThat(saved.noteIds()).containsExactly(4L);
        assertThat(saved.pricesFinal()).isFalse();
        assertThat(saved.latencyMs()).isEqualTo(99L);
        assertThat(saved.kind()).isEqualTo("SCHEDULED");

        assertThat(store.updateDecisionRetry(retry)).as("이미 재시도함").isFalse();
        assertThat(store.updateDecisionRetry(new PaperStore.Decision(ok, BOOK, DAY, "MANUAL", null, "API_ERROR", null,
                null, 1, null, null, null, null, null, null, null, null, null, true, 1L, 0))).as("API 오류가 아님")
                .isFalse();
        assertThat(store.decision(ok).orElseThrow().status()).isEqualTo("OK");
    }

    @Test
    @DisplayName("패킷 문자열(V10): 보낸 글자 그대로 남아 SHA-256을 기록만으로 다시 만들고, 패킷은 보낸 섹션 순서로 읽힌다 — JSONB는 키를 다시 정렬함")
    void packetTextKeepsSentBytes() throws Exception {
        store.insertBookIfAbsent(book(BOOK, "Claude 책 시험"));
        // JSONB는 키를 길이·바이트 순으로 정렬합니다 — "0_instructions"(14자)가 "1_basis"(7자) 뒤로 갑니다.
        String sent = "{\"0_instructions\":{\"lines\":[\"가\"]},\"1_basis\":{\"asOf\":\"2026-10-23\"},\"12_hardRules\":1.50}";
        String hash = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(sent.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        long id = store.insertDecisionIfAbsent(new PaperStore.Decision(0, BOOK, DAY, "SCHEDULED", null, "API_ERROR",
                "claude-sonnet-5-5", null, 1, null, null, MAPPER.readTree(sent), hash, null, null, null, "[RATE_LIMIT] 429",
                List.of(), true, 12L, 0, sent)).orElseThrow();

        PaperStore.Decision saved = store.decision(id).orElseThrow();
        assertThat(saved.packetText()).isEqualTo(sent);
        assertThat(jdbc.queryForObject("SELECT encode(sha256(convert_to(packet_text, 'UTF8')), 'hex') FROM "
                + "paper_decisions WHERE id = ?", String.class, id)).as("기록만으로 해시 재현").isEqualTo(hash);
        assertThat(jdbc.queryForObject("SELECT encode(sha256(convert_to(packet::text, 'UTF8')), 'hex') FROM "
                + "paper_decisions WHERE id = ?", String.class, id)).as("JSONB로는 재현되지 않음").isNotEqualTo(hash);
        List<String> sections = new java.util.ArrayList<>();
        saved.packet().propertyNames().forEach(sections::add);
        assertThat(sections).as("보낸 섹션 순서").containsExactly("0_instructions", "1_basis", "12_hardRules");

        // 재시도도 패킷 문자열을 바꿔 씁니다.
        String resent = "{\"0_instructions\":2}";
        assertThat(store.updateDecisionRetry(new PaperStore.Decision(id, BOOK, DAY, "SCHEDULED", null, "OK",
                "claude-sonnet-5-5", null, 1, null, null, MAPPER.readTree(resent), "h2", null, null, null, null,
                List.of(), true, 5L, 0, resent))).isTrue();
        assertThat(store.decision(id).orElseThrow().packetText()).isEqualTo(resent);

        // 문자열이 없는 기록(규칙 책·V10 전)은 JSONB에서 읽고 packetText는 null.
        long legacy = store.insertDecisionIfAbsent(new PaperStore.Decision(0, BOOK, DAY, "MANUAL", null, "OK", null,
                null, 1, null, null, MAPPER.readTree(sent), "h3", null, null, null, null, null, true, 1L, 0))
                .orElseThrow();
        PaperStore.Decision old = store.decision(legacy).orElseThrow();
        assertThat(old.packetText()).isNull();
        assertThat(old.packet().path("1_basis").path("asOf").asString()).isEqualTo("2026-10-23");
    }

    private static PaperStore.TrackRecordRow trackRow(LocalDate asOf, String cik, Integer rank, Double cagr,
                                                      JsonNode periods) {
        boolean eligible = rank != null;
        return new PaperStore.TrackRecordRow(asOf, cik, 7, "CAGR", eligible ? 26 : 0, eligible ? 27 : 0,
                eligible ? LocalDate.of(2019, 8, 14) : null, eligible ? LocalDate.of(2026, 8, 14) : null,
                cagr == null ? null : cagr * 2, cagr, eligible ? 18.5 : null, eligible ? -22.25 : null,
                eligible ? 0.71 : null, eligible ? 3.5 : null, eligible ? 0.62 : null, eligible ? 0.81 : null,
                eligible, eligible ? null : "수집 중(저장 분기 0/30); 공시 없음", rank, periods, 1, null);
    }

    @Test
    @DisplayName("트랙레코드·선정: (기준일, CIK) 덮어쓰기, 없는 수치는 NULL 그대로, 순위 순, 선정은 한 번 — 시험 뒤 되돌림")
    void trackRecordAndSelection() {
        // 선정은 기준일이 키이고 '가장 최근 기준일'을 묻는 메서드가 있어, 다른 테스트의 행과 섞이지 않도록 지운 뒤
        // 되돌리는 트랜잭션 안에서만 시험합니다(설정 시험과 같은 방식).
        class Rollback extends RuntimeException {
        }
        LocalDate first = LocalDate.of(2026, 8, 17);
        LocalDate second = LocalDate.of(2026, 11, 17);
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_selection_log");
            jdbc.update("DELETE FROM paper_track_record");
            assertThat(store.latestTrackRecordAsOf()).isEmpty();
            assertThat(store.selections()).isEmpty();

            JsonNode periods = MAPPER.readTree("[{\"filingDate\":\"2026-08-14\",\"start\":\"2026-08-17\","
                    + "\"returnPct\":1.5,\"spyReturnPct\":null,\"coverage\":0.8,\"coveredTickers\":12}]");
            store.upsertTrackRecord(trackRow(first, "t_b", 2, 10.0, periods));
            store.upsertTrackRecord(trackRow(first, "t_a", 1, 99.0, null));
            store.upsertTrackRecord(trackRow(first, "t_c", null, null, null));
            store.upsertTrackRecord(trackRow(first, "t_a", 1, 12.0, null));   // 같은 기준일 재계산 → 덮어씀

            List<PaperStore.TrackRecordRow> rows = store.trackRecords(first);
            assertThat(rows).extracting(PaperStore.TrackRecordRow::cik).as("순위 순, 순위 없는 기관은 뒤")
                    .containsExactly("t_a", "t_b", "t_c");
            assertThat(rows.get(0).cagrPct()).isEqualTo(12.0);
            assertThat(rows.get(0).cumReturnPct()).isEqualTo(24.0);
            assertThat(rows.get(0).mddPct()).isEqualTo(-22.25);
            assertThat(rows.get(0).periods().isArray() && rows.get(0).periods().isEmpty()).as("null → []").isTrue();
            assertThat(rows.get(0).computedAt()).as("비우면 DB가 채움").isNotNull();
            assertThat(rows.get(1).periods().get(0).path("coverage").asDouble()).isEqualTo(0.8);
            assertThat(rows.get(1).periods().get(0).path("spyReturnPct").isNull()).isTrue();
            PaperStore.TrackRecordRow c = rows.get(2);
            assertThat(c.rank()).isNull();
            assertThat(c.eligible()).isFalse();
            assertThat(c.cagrPct()).as("0이 아니라 NULL").isNull();
            assertThat(c.coverageMin()).isNull();
            assertThat(c.firstFilingDate()).isNull();
            assertThat(c.ineligibleReason()).isEqualTo("수집 중(저장 분기 0/30); 공시 없음");

            store.upsertTrackRecord(trackRow(second, "t_a", 1, 11.0, null));
            assertThat(store.latestTrackRecordAsOf()).contains(second);
            assertThat(store.deleteTrackRecords(first)).isEqualTo(3);
            assertThat(store.trackRecords(first)).isEmpty();
            assertThat(store.trackRecords(second)).hasSize(1);
            assertThatThrownBy(() -> store.upsertTrackRecord(trackRow(second, "t_d", 2, Double.POSITIVE_INFINITY,
                    null))).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("유한한 수가 아닙니다");

            JsonNode ranking = MAPPER.readTree("[{\"cik\":\"t_b\",\"rank\":1},{\"cik\":\"t_a\",\"rank\":2}]");
            assertThat(store.insertSelectionIfAbsent(new PaperStore.Selection(first, List.of("t_b", "t_a"), ranking,
                    1, null))).isTrue();
            assertThat(store.insertSelectionIfAbsent(new PaperStore.Selection(first, List.of("t_c"), null, 2, null)))
                    .as("같은 기준일의 선정은 바꾸지 않음").isFalse();
            assertThat(store.insertSelectionIfAbsent(new PaperStore.Selection(second, List.of(), null, 1, null)))
                    .as("자격 기관 0곳 = 빈 선정").isTrue();

            assertThat(store.selections()).extracting(PaperStore.Selection::asOfDate).containsExactly(second, first);
            PaperStore.Selection saved = store.selectionOnOrBefore(second.minusDays(1)).orElseThrow();
            assertThat(saved.asOfDate()).isEqualTo(first);
            assertThat(saved.selectedCiks()).as("선정 순위 순 그대로").containsExactly("t_b", "t_a");
            assertThat(saved.ranking().get(0).path("cik").asString()).isEqualTo("t_b");
            assertThat(saved.settingsVersion()).isEqualTo(1);
            assertThat(saved.createdAt()).isNotNull();
            assertThat(store.selectionOnOrBefore(second).orElseThrow().selectedCiks()).isEmpty();
            assertThat(store.selectionOnOrBefore(second).orElseThrow().ranking().isArray()).isTrue();
            assertThat(store.selectionOnOrBefore(first.minusDays(1))).isEmpty();

            // 설정 이력 — 그 버전의 본문(트랙레코드가 어떤 기준으로 계산됐나).
            jdbc.update("DELETE FROM paper_settings_history");
            jdbc.update("DELETE FROM paper_settings");
            store.initSettingsIfAbsent(MAPPER.valueToTree(Map.of("trackRecord", Map.of("windowYears", 7))));
            store.saveSettings(MAPPER.valueToTree(Map.of("trackRecord", Map.of("windowYears", 5))),
                    List.of("trackRecord.windowYears"));
            assertThat(store.settingsAt(1).orElseThrow().body().path("trackRecord").path("windowYears").asInt())
                    .isEqualTo(7);
            assertThat(store.settingsAt(2).orElseThrow().body().path("trackRecord").path("windowYears").asInt())
                    .isEqualTo(5);
            assertThat(store.settingsAt(3)).isEmpty();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    /** trackRow를 그 그룹·창·출처로. */
    private static PaperStore.TrackRecordRow groupRow(LocalDate asOf, String cik, String group, int windowYears,
                                                      Integer rank, Double cagr, String source) {
        PaperStore.TrackRecordRow r = trackRow(asOf, cik, rank, cagr, null);
        return new PaperStore.TrackRecordRow(r.asOfDate(), r.cik(), windowYears, r.metric(), r.periodsUsed(),
                r.periodsTotal(), r.firstFilingDate(), r.lastFilingDate(), r.cumReturnPct(), r.cagrPct(), r.volPct(),
                r.mddPct(), r.sharpe(), r.excessVsSpyPct(), r.coverageMin(), r.coverageAvg(), r.eligible(),
                r.ineligibleReason(), r.rank(), r.periods(), r.settingsVersion(), r.computedAt(), group, source);
    }

    @Test
    @DisplayName("트랙레코드 그룹(V9): 같은 기준일·같은 기관도 그룹 A·B 행이 따로 — 그룹마다 덮어쓰고·읽고·지움, 그룹 없는 호출은 A")
    void trackRecordGroups() {
        class Rollback extends RuntimeException {
        }
        LocalDate asOf = LocalDate.of(2026, 8, 17);
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_track_record");
            // 두 그룹에 모두 있는 기관(Duquesne처럼) — 창이 달라 수치가 다른 두 행
            store.upsertTrackRecord(trackRow(asOf, "t_duq", 1, 27.5, null));   // 그룹 없는 생성자 → A
            store.upsertTrackRecord(groupRow(asOf, "t_duq", "B", 2, 1, 26.8, "q8"));
            store.upsertTrackRecord(groupRow(asOf, "t_fis", "B", 2, 2, 15.4, "q8"));
            store.upsertTrackRecord(groupRow(asOf, "t_duq", "B", 2, 1, 26.9, "q30"));   // 같은 그룹 재계산 → 덮어씀

            assertThat(store.trackRecords(asOf)).as("그룹 없는 읽기 = A").singleElement().satisfies(r -> {
                assertThat(r.groupCode()).isEqualTo("A");
                assertThat(r.cagrPct()).isEqualTo(27.5);
                assertThat(r.windowYears()).isEqualTo(7);
                assertThat(r.dataSource()).as("단계 1b 모양 — 출처 모름").isNull();
            });
            List<PaperStore.TrackRecordRow> b = store.trackRecords(asOf, "B");
            assertThat(b).extracting(PaperStore.TrackRecordRow::cik).containsExactly("t_duq", "t_fis");
            assertThat(b.get(0).cagrPct()).isEqualTo(26.9);
            assertThat(b.get(0).windowYears()).isEqualTo(2);
            assertThat(b.get(0).dataSource()).isEqualTo("q30");
            assertThat(b.get(1).dataSource()).isEqualTo("q8");
            assertThat(b).allSatisfy(r -> assertThat(r.groupCode()).isEqualTo("B"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_track_record WHERE as_of_date = ?",
                    Integer.class, java.sql.Date.valueOf(asOf))).isEqualTo(3);

            store.upsertTrackRecord(groupRow(asOf.plusDays(92), "t_fis", "B", 2, 1, 14.0, "q8"));
            assertThat(store.latestTrackRecordAsOf()).as("A는 8-17까지").contains(asOf);
            assertThat(store.latestTrackRecordAsOf("B")).contains(asOf.plusDays(92));

            assertThat(store.deleteTrackRecords(asOf, "B")).isEqualTo(2);
            assertThat(store.trackRecords(asOf)).as("다른 그룹은 그대로").hasSize(1);
            assertThat(store.deleteTrackRecords(asOf)).isEqualTo(1);
            assertThat(store.trackRecords(asOf, "B")).isEmpty();

            assertThatThrownBy(() -> store.trackRecords(asOf, "C")).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> groupRow(asOf, "t_x", "b", 2, 1, 1.0, null))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> groupRow(asOf, "t_x", "B", 2, 1, 1.0, "q1"))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> jdbc.update("INSERT INTO paper_track_record (as_of_date, cik, window_years, metric, "
                    + "periods_used, periods_total, eligible, settings_version, group_code) "
                    + "VALUES (?, 't_x', 2, 'CAGR', 0, 0, false, 1, 'C')", java.sql.Date.valueOf(asOf)))
                    .as("DB CHECK도 A·B만").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    private static PaperStore.Decision decision(LocalDate day, String kind, String status, JsonNode response) {
        return new PaperStore.Decision(0, BOOK, day, kind, null, status, null, null, 3, DAY, null, null, null, null,
                response, null, null, null, false, 42L, 0);
    }

    @Test
    @DisplayName("결정: (책, 거래일, 종류)마다 한 건 — 두 번째 넣기는 empty, 목록은 요약·주문 수·거절 수, 상세는 JSON 그대로, 갱신은 상태·응답·오류")
    void decisionsAreUniquePerBookDayKind() throws Exception {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        JsonNode response = MAPPER.readTree("{\"summary\":\"매도 1 (선정 2026-10-23 · 5곳)\",\"orders\":[{\"ticker\":\"SPY\"}]}");
        long id = store.insertDecisionIfAbsent(decision(DAY, "SCHEDULED", "OK", response)).orElseThrow();
        assertThat(store.insertDecisionIfAbsent(decision(DAY, "SCHEDULED", "NO_TRADE", null))).as("같은 날·같은 종류")
                .isEmpty();
        long manual = store.insertDecisionIfAbsent(decision(DAY, "MANUAL", "NO_TRADE", null)).orElseThrow();
        long later = store.insertDecisionIfAbsent(new PaperStore.Decision(0, BOOK, DAY.plusDays(3), "REBALANCE", null,
                "OK", "claude-sonnet-5-5", 2, 3, null, 55.5, MAPPER.readTree("{\"a\":1}"), "abc", "raw", null,
                MAPPER.readTree("{\"inputTokens\":10}"), "경고", List.of(7L, 9L), true, null, 1)).orElseThrow();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_decisions WHERE book_code = ?", Integer.class, BOOK))
                .isEqualTo(3);

        PaperStore.Order pending = pendingBuy(BOOK, "SPY", null);
        store.insertOrder(new PaperStore.Order(0, BOOK, id, "SPY", "SELL", null, null, null, "NEXT_OBSERVATION", "RULE",
                "PENDING", null, null, DAY, null, DAY.plusDays(5), null));
        store.insertOrder(new PaperStore.Order(0, BOOK, id, "QQQ", "BUY", null, 5.0, null, "NEXT_OBSERVATION", "RULE",
                "REJECTED", "상한 초과", null, DAY, null, DAY.plusDays(5), null));
        store.insertOrder(pending);   // 결정 없는 주문은 세지 않음

        List<PaperStore.DecisionSummary> list = store.decisions(BOOK, 10);
        assertThat(list).extracting(PaperStore.DecisionSummary::id).as("최근 거래일 순, 같은 날은 나중 것 먼저")
                .containsExactly(later, manual, id);
        PaperStore.DecisionSummary scheduled = list.get(2);
        assertThat(scheduled.summary()).isEqualTo("매도 1 (선정 2026-10-23 · 5곳)");
        assertThat(scheduled.orderCount()).isEqualTo(2);
        assertThat(scheduled.rejectedCount()).isEqualTo(1);
        assertThat(scheduled.settingsVersion()).isEqualTo(3);
        assertThat(scheduled.selectionAsOf()).isEqualTo(DAY);
        assertThat(scheduled.decidedAt()).as("비우면 DB가 채움").isNotNull();
        assertThat(list.get(1).summary()).as("응답 없음 → null").isNull();
        assertThat(store.decisions(BOOK, 1)).hasSize(1);
        assertThat(store.ordersByDecision(id)).extracting(PaperStore.Order::ticker).containsExactly("SPY", "QQQ");

        PaperStore.Decision full = store.decision(later).orElseThrow();
        assertThat(full.model()).isEqualTo("claude-sonnet-5-5");
        assertThat(full.frameworkVersion()).isEqualTo(2);
        assertThat(full.targetExposurePct()).isEqualTo(55.5);
        assertThat(full.packet().path("a").asInt()).isEqualTo(1);
        assertThat(full.usage().path("inputTokens").asInt()).isEqualTo(10);
        assertThat(full.noteIds()).containsExactly(7L, 9L);
        assertThat(full.pricesFinal()).isTrue();
        assertThat(full.latencyMs()).isNull();
        assertThat(full.retryCount()).isEqualTo(1);
        PaperStore.Decision bare = store.decision(manual).orElseThrow();
        assertThat(bare.noteIds()).isNull();
        assertThat(bare.response()).isNull();
        assertThat(bare.latencyMs()).isEqualTo(42L);
        assertThat(store.decisionFor(BOOK, DAY, "SCHEDULED").orElseThrow().id()).isEqualTo(id);
        assertThat(store.decisionFor(BOOK, DAY, "INITIAL")).isEmpty();
        assertThat(store.decision(-1)).isEmpty();
        // 선정 기준일로 찾기 — SCHEDULED·MANUAL은 선정 DAY, 나중 REBALANCE는 선정 없음(null)
        assertThat(store.hasDecisionWithSelection(BOOK, List.of("SCHEDULED", "MANUAL"), DAY)).isTrue();
        assertThat(store.hasDecisionWithSelection(BOOK, List.of("REBALANCE", "INITIAL"), DAY))
                .as("REBALANCE는 있지만 선정 DAY로 낸 것이 아님").isFalse();
        assertThat(store.hasDecisionWithSelection(BOOK, List.of("SCHEDULED"), DAY.plusDays(1))).isFalse();
        assertThat(store.hasDecisionWithSelection(BOOK, List.of("SCHEDULED"), null)).isFalse();
        assertThat(store.hasDecisionWithSelection(BOOK, List.of(), DAY)).isFalse();
        long rebalanced = store.insertDecisionIfAbsent(new PaperStore.Decision(0, BOOK, DAY.plusDays(4), "REBALANCE",
                null, "OK", null, null, 3, DAY.plusDays(4), null, null, null, null, null, null, null, null, true, 1L,
                0)).orElseThrow();
        assertThat(store.hasDecisionWithSelection(BOOK, List.of("REBALANCE", "INITIAL"), DAY.plusDays(4))).isTrue();
        assertThat(store.hasDecisionWithSelection("bench_spy", List.of("REBALANCE"), DAY.plusDays(4)))
                .as("다른 책").isFalse();
        jdbc.update("DELETE FROM paper_decisions WHERE id = ?", rebalanced);

        store.updateDecision(id, "NO_TRADE", MAPPER.readTree("{\"summary\":\"바뀜\"}"), "오류 한 줄");
        assertThat(store.decision(id).orElseThrow()).extracting(PaperStore.Decision::status,
                d -> d.response().path("summary").asString(), PaperStore.Decision::error)
                .containsExactly("NO_TRADE", "바뀜", "오류 한 줄");
        store.updateDecision(id, "OK", null, null);
        assertThat(store.decision(id).orElseThrow().response().path("summary").asString()).as("null이면 응답 그대로")
                .isEqualTo("바뀜");

        store.resetBook(BOOK);
        assertThat(store.decisions(BOOK, 10)).as("리셋이 결정도 지움").isEmpty();
        assertThat(store.hasDecisionWithSelection(BOOK, List.of("SCHEDULED"), DAY)).isFalse();
    }

    @Test
    @DisplayName("게이트 지표: 거래일마다 한 번(두 번째 넣기는 처음 값 그대로), 직전 기록·최근 순 — 시험 뒤 되돌림")
    void gateLogOncePerTradingDay() {
        class Rollback extends RuntimeException {
        }
        LocalDate thu = LocalDate.of(2026, 10, 22);
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_gate_log");
            JsonNode inputs = MAPPER.readTree("{\"us10y\":{\"value\":4.5,\"source\":\"macro.collected\"}}");
            JsonNode streaks = MAPPER.readTree("{\"G1\":3,\"G2\":null}");
            assertThat(store.insertGateIfAbsent(new PaperStore.GateRow(thu, inputs, "L1", streaks, null))).isTrue();
            assertThat(store.insertGateIfAbsent(new PaperStore.GateRow(thu, MAPPER.createObjectNode(), "L0", null,
                    null))).as("같은 거래일").isFalse();
            assertThat(store.insertGateIfAbsent(new PaperStore.GateRow(DAY, MAPPER.createObjectNode(), "UNKNOWN", null,
                    null))).isTrue();

            PaperStore.GateRow saved = store.gate(thu).orElseThrow();
            assertThat(saved.level()).isEqualTo("L1");
            assertThat(saved.inputs().path("us10y").path("value").asDouble()).isEqualTo(4.5);
            assertThat(saved.streaks().path("G1").asInt()).isEqualTo(3);
            assertThat(saved.streaks().path("G2").isNull()).as("모르는 연속은 null 그대로").isTrue();
            assertThat(saved.createdAt()).isNotNull();
            assertThat(store.gate(DAY).orElseThrow().streaks().isEmpty()).as("null → {}").isTrue();
            assertThat(store.latestGateBefore(DAY).orElseThrow().tradingDate()).isEqualTo(thu);
            assertThat(store.latestGateBefore(thu)).isEmpty();
            assertThat(store.recentGate(5)).extracting(PaperStore.GateRow::tradingDate).containsExactly(DAY, thu);
            assertThat(store.recentGate(1)).hasSize(1);
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("V11 전 DB(paper_api_usage.est_cost_calls 열 없음)는 준비 안 됨 — 사용량 SQL 오류(500) 대신 안내 문구, 시험 뒤 되돌림")
    void readyRequiresV11() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("ALTER TABLE paper_api_usage DROP COLUMN est_cost_calls");
            assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("V11 전이면 준비 안 됨").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("추정 비용(V11): 추정이 있으면 더하고 추정 호출 수 +1, 없으면(null) 비용 열은 그대로 — 추정이 없는 날은 null, 호출 번호는 한 문장으로")
    void apiUsageEstimatedCost() {
        LocalDate day = LocalDate.of(1999, 2, 1);
        LocalDate other = LocalDate.of(1999, 2, 2);
        assertThat(store.reserveApiCallNumber(day, 3)).contains(1);
        assertThat(store.reserveApiCallNumber(day, 3)).contains(2);
        assertThat(store.reserveApiCallNumber(day, 0)).as("상한 0").isEmpty();
        store.addApiTokens(day, 100L, 10L, 0L, 0L);
        PaperStore.ApiUsage before = store.apiUsage(day).orElseThrow();
        assertThat(before.estCostUsd()).as("추정한 호출이 없으면 null(0달러 아님)").isNull();
        assertThat(before.estCostCalls()).isZero();

        store.addApiTokens(day, 21_000L, 3_100L, 7_800L, 0L, 0.07378);
        store.addApiTokens(day, null, null, null, null, 0.0000015);
        store.addApiTokens(day, 5L, 5L, null, null, null);   // 추정 없는 호출 — 비용은 그대로
        PaperStore.ApiUsage usage = store.apiUsage(day).orElseThrow();
        assertThat(usage.calls()).isEqualTo(2);
        assertThat(usage.inputTokens()).isEqualTo(21_105);
        assertThat(usage.estCostUsd()).as("NUMERIC(12,6) — 소수 6자리").isEqualTo(0.073782);
        assertThat(usage.estCostCalls()).isEqualTo(2);
        assertThatThrownBy(() -> store.addApiTokens(day, 1L, 1L, 1L, 1L, Double.NaN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.addApiTokens(day, 1L, 1L, 1L, 1L, -0.01))
                .isInstanceOf(IllegalArgumentException.class);

        store.addApiTokens(other, 1L, 1L, 0L, 0L, null);
        PaperStore.ApiUsageTotal month = store.apiUsageBetween(LocalDate.of(1999, 2, 1), LocalDate.of(1999, 2, 28));
        assertThat(month.days()).isEqualTo(2);
        assertThat(month.estCostUsd()).as("추정한 날만 더함").isEqualTo(0.073782);
        assertThat(month.estCostCalls()).isEqualTo(2);
        PaperStore.ApiUsageTotal none = store.apiUsageBetween(other, other);
        assertThat(none.estCostUsd()).as("추정이 하나도 없으면 null").isNull();
        assertThat(none.estCostCalls()).isZero();
    }

    @Test
    @DisplayName("프레임 판: 번호가 있으면 넣지 않음(시드 한 번), 지금 판 = 가장 큰 번호, 목록은 제목·상태만 최근 순 — 시험 뒤 되돌림")
    void frameworkVersions() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_framework_versions");
            assertThat(store.currentFramework()).isEmpty();
            JsonNode v0 = MAPPER.readTree("{\"title\":\"임시 v0\",\"status\":\"INTERIM\",\"engines\":[]}");
            assertThat(store.insertFrameworkVersionIfAbsent(new PaperStore.FrameworkVersion(0, v0, "# v0", 3,
                    "임시", null, null))).isTrue();
            assertThat(store.insertFrameworkVersionIfAbsent(new PaperStore.FrameworkVersion(0,
                    MAPPER.readTree("{\"title\":\"다른 것\"}"), "# x", 1, "x", null, null))).as("같은 번호").isFalse();
            assertThat(store.insertFrameworkVersionIfAbsent(new PaperStore.FrameworkVersion(1,
                    MAPPER.readTree("{\"title\":\"사용자 v1\",\"status\":\"USER\"}"), "# v1", 5, "원문", 42L, null)))
                    .isTrue();

            PaperStore.FrameworkVersion current = store.currentFramework().orElseThrow();
            assertThat(current.version()).isEqualTo(1);
            assertThat(current.sourceProposalId()).isEqualTo(42L);
            assertThat(current.createdAt()).isNotNull();
            PaperStore.FrameworkVersion first = store.frameworkVersion(0).orElseThrow();
            assertThat(first.body().path("title").asString()).as("처음 값 그대로").isEqualTo("임시 v0");
            assertThat(first.rendered()).isEqualTo("# v0");
            assertThat(first.renderedTokensEst()).isEqualTo(3);
            assertThat(first.sourceProposalId()).isNull();
            assertThat(store.frameworkVersion(7)).isEmpty();
            assertThat(store.frameworkVersions()).extracting(PaperStore.FrameworkVersionSummary::version,
                    PaperStore.FrameworkVersionSummary::title, PaperStore.FrameworkVersionSummary::status)
                    .containsExactly(org.assertj.core.groups.Tuple.tuple(1, "사용자 v1", "USER"),
                            org.assertj.core.groups.Tuple.tuple(0, "임시 v0", "INTERIM"));
            assertThat(store.frameworkBodies()).as("모든 판의 본문, 번호 순(새 번호가 지운 id를 다시 쓰지 않게 — FW-2)")
                    .extracting(body -> body.path("title").asString()).containsExactly("임시 v0", "사용자 v1");

            // 경계: 그 책의 결정에 판마다 처음 쓰인 거래일, 판 번호 없는 결정은 세지 않음
            store.insertBookIfAbsent(new PaperStore.Book(BOOK, "CLAUDE", "t", 100_000, null, "ACTIVE", null));
            for (Object[] d : new Object[][]{{DAY, 0}, {DAY.plusDays(3), 0}, {DAY.plusDays(4), null},
                    {DAY.plusDays(5), 1}, {DAY.plusDays(6), 1}}) {
                store.insertDecisionIfAbsent(new PaperStore.Decision(0, BOOK, (LocalDate) d[0], "SCHEDULED", null,
                        "OK", null, (Integer) d[1], 1, null, null, null, null, null, null, null, null, null, true, null,
                        0));
            }
            assertThat(store.frameworkBoundaries(BOOK)).containsExactly(
                    new PaperStore.FrameworkBoundary(DAY, 0, "INTERIM"),
                    new PaperStore.FrameworkBoundary(DAY.plusDays(5), 1, "USER"));
            assertThat(store.frameworkBoundaries(OTHER_BOOK)).isEmpty();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("프레임 제안: PENDING·FAILED만 넣고, 승인·거절은 대기 중인 행만 한 번 — 시험 뒤 되돌림")
    void frameworkProposals() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            long note = store.insertNote(new PaperStore.Note(0, "INSIGHT", DAY, null, "방법론", "본문", false, null));
            JsonNode response = MAPPER.readTree("{\"summary\":\"요지\",\"operations\":[{\"op\":\"ADD_RULE\"}]}");
            long pending = store.insertProposal(new PaperStore.FrameworkProposal(0, note, 0, "본문",
                    "claude-sonnet-5-5", response, "{raw}", "PENDING", null, null, null, null));
            long failed = store.insertProposal(new PaperStore.FrameworkProposal(0, null, 0, "붙인 글",
                    "claude-haiku-5-5", null, null, "FAILED", "[NO_KEY] 키 없음", null, null, null));
            assertThatThrownBy(() -> store.insertProposal(new PaperStore.FrameworkProposal(0, null, 0, "x", "m", null,
                    null, "APPROVED", null, 1, null, null))).isInstanceOf(IllegalArgumentException.class);

            PaperStore.FrameworkProposal saved = store.proposal(pending).orElseThrow();
            assertThat(saved.noteId()).isEqualTo(note);
            assertThat(saved.response().path("summary").asString()).isEqualTo("요지");
            assertThat(saved.responseRaw()).isEqualTo("{raw}");
            assertThat(saved.decidedAt()).isNull();
            assertThat(saved.resultVersion()).isNull();
            assertThat(store.proposal(failed).orElseThrow().response()).isNull();
            assertThat(store.recentProposals(10)).extracting(PaperStore.FrameworkProposal::id)
                    .as("최근 순").startsWith(failed, pending);

            assertThat(store.decideProposal(pending, "APPROVED", 3)).isTrue();
            assertThat(store.decideProposal(pending, "REJECTED", null)).as("이미 결정됨").isFalse();
            assertThat(store.decideProposal(failed, "REJECTED", null)).as("FAILED는 대기가 아님").isFalse();
            assertThat(store.decideProposal(-1, "REJECTED", null)).isFalse();
            assertThatThrownBy(() -> store.decideProposal(failed, "PENDING", null))
                    .isInstanceOf(IllegalArgumentException.class);
            PaperStore.FrameworkProposal approved = store.proposal(pending).orElseThrow();
            assertThat(approved.status()).isEqualTo("APPROVED");
            assertThat(approved.resultVersion()).isEqualTo(3);
            assertThat(approved.decidedAt()).isNotNull();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("메모: 목록(보관·만료 제외/전부), 그 거래일의 유효 MARKET(기준일 ≤ 그날 ≤ 만료일, 최신 순), 보관은 지우지 않음 — 시험 뒤 되돌림")
    void notes() {
        class Rollback extends RuntimeException {
        }
        LocalDate thu = LocalDate.of(2026, 10, 22);
        LocalDate mon = LocalDate.of(2026, 10, 26);
        LocalDate wed = LocalDate.of(2026, 10, 28);
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_framework_proposals");
            jdbc.update("DELETE FROM paper_notes");
            long old = store.insertNote(new PaperStore.Note(0, "MARKET", thu, DAY, "목요일", "유가 급등", false, null));
            long fri = store.insertNote(new PaperStore.Note(0, "MARKET", DAY, wed, "금요일", "금리 하락", false, null));
            long later = store.insertNote(new PaperStore.Note(0, "MARKET", mon, wed, "월요일", "달러 약세", false, null));
            long insight = store.insertNote(new PaperStore.Note(0, "INSIGHT", thu, null, "방법론", "원문", false, null));

            assertThat(store.activeMarketNotes(DAY)).extracting(PaperStore.Note::id).as("PIT — 그날 이하·만료 당일 포함")
                    .containsExactly(fri, old);
            assertThat(store.activeMarketNotes(mon)).extracting(PaperStore.Note::id).as("목요일 메모는 금요일에 만료")
                    .containsExactly(later, fri);
            assertThat(store.activeMarketNotes(wed.plusDays(1))).isEmpty();

            assertThat(store.notes(false, mon)).extracting(PaperStore.Note::id).containsExactly(later, fri, insight);
            assertThat(store.archiveNote(fri)).isTrue();
            assertThat(store.archiveNote(fri)).as("이미 보관 — 멱등").isTrue();
            assertThat(store.archiveNote(-1)).isFalse();
            assertThat(store.note(fri).orElseThrow().archived()).isTrue();
            assertThat(store.activeMarketNotes(mon)).extracting(PaperStore.Note::id).containsExactly(later);
            assertThat(store.notes(false, mon)).extracting(PaperStore.Note::id).containsExactly(later, insight);
            assertThat(store.notes(true, mon)).extracting(PaperStore.Note::id).as("보관·만료까지 전부")
                    .containsExactly(later, fri, insight, old);
            PaperStore.Note saved = store.note(insight).orElseThrow();
            assertThat(saved.expiresOn()).isNull();
            assertThat(saved.createdAt()).isNotNull();
            assertThat(store.note(-1)).isEmpty();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    // ------------------------------------------------------------------ 주간 복기(V12)
    /** 1999년 금요일들 — 운영·다른 시험의 주와 겹치지 않게(cleanUp이 지움). */
    private static final LocalDate W1 = LocalDate.of(1999, 1, 8);
    private static final LocalDate W2 = LocalDate.of(1999, 1, 15);
    private static final LocalDate W3 = LocalDate.of(1999, 1, 22);
    private static final LocalDate W4 = LocalDate.of(1999, 1, 29);

    private static PaperStore.Review review(LocalDate week, String status, String inputText, JsonNode response)
            throws Exception {
        JsonNode input = MAPPER.readTree(inputText == null ? "{\"weekEnding\":\"" + week + "\",\"decisions\":[]}"
                : inputText);
        return new PaperStore.Review(week, 4, input, inputText, response, response == null ? null : response.toString(),
                PaperStore.Review.SKIPPED.equals(status) ? null : "claude-sonnet-5-5", null, status,
                PaperStore.Review.API_ERROR.equals(status) ? "[RATE_LIMIT] 429" : null, null, 3, 0, null);
    }

    private static JsonNode verdicts(String... thesisHeld) throws Exception {
        StringBuilder items = new StringBuilder();
        for (int i = 0; i < thesisHeld.length; i++) {
            items.append(i == 0 ? "" : ",").append("{\"decisionId\":").append(i + 1)
                    .append(",\"thesisHeld\":\"").append(thesisHeld[i]).append("\",\"note\":\"n\"}");
        }
        return MAPPER.readTree("{\"schemaVersion\":1,\"verdicts\":[" + items + "],\"recurringErrors\":[],"
                + "\"keep\":[],\"proposal\":null}");
    }

    @Test
    @DisplayName("V12 전 DB(paper_reviews 없음)는 준비 안 됨 — 복기 작업·화면의 SQL 오류(500) 대신 안내 문구, 시험 뒤 되돌림")
    void readyRequiresV12() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("DROP TABLE paper_reviews");
            assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("V12 전이면 준비 안 됨").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("주간 복기: 한 주에 한 건(두 번째 넣기는 false, 처음 값 그대로), 보낸 입력 문자열의 키 순서로 읽힘, 목록은 주 최근 순·판정 수는 OK 행만 — 시험 뒤 되돌림")
    void reviewsOncePerWeek() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            try {
                jdbc.update("DELETE FROM paper_reviews");
                assertThat(store.reviews(10)).isEmpty();

                assertThat(store.insertReviewIfAbsent(review(W1, "SKIPPED", null, null))).isTrue();
                assertThat(store.insertReviewIfAbsent(review(W1, "OK", null, verdicts("유지")))).as("같은 주")
                        .isFalse();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_reviews WHERE week_ending = ?",
                        Integer.class, java.sql.Date.valueOf(W1))).isEqualTo(1);
                PaperStore.Review skipped = store.review(W1).orElseThrow();
                assertThat(skipped.status()).as("처음 값 그대로").isEqualTo("SKIPPED");
                assertThat(skipped.inputText()).as("부르지 않은 행").isNull();
                assertThat(skipped.input().path("weekEnding").asString()).isEqualTo("1999-01-08");
                assertThat(skipped.model()).isNull();
                assertThat(skipped.retryCount()).isZero();
                assertThat(skipped.createdAt()).as("비우면 DB가 채움").isNotNull();

                // JSONB는 키를 길이·바이트 순으로 정렬합니다("a"가 앞으로) — 보낸 문자열이 있으면 그 순서로 읽습니다.
                String sent = "{\"weekEnding\":\"1999-01-15\",\"decisions\":[{\"id\":7}],\"a\":1.50}";
                assertThat(store.insertReviewIfAbsent(review(W2, "OK", sent, verdicts("유지", "반증", "유지", "판단불가"))))
                        .isTrue();
                PaperStore.Review ok = store.review(W2).orElseThrow();
                assertThat(ok.inputText()).isEqualTo(sent);
                List<String> keys = new java.util.ArrayList<>();
                ok.input().propertyNames().forEach(keys::add);
                assertThat(keys).as("보낸 키 순서").containsExactly("weekEnding", "decisions", "a");
                assertThat(jdbc.queryForObject("SELECT (SELECT array_agg(k) FROM jsonb_object_keys(input) k)::text "
                        + "FROM paper_reviews WHERE week_ending = ?", String.class, java.sql.Date.valueOf(W2)))
                        .as("JSONB는 순서를 바꿈").isEqualTo("{a,decisions,weekEnding}");
                assertThat(ok.windowWeeks()).isEqualTo(4);
                assertThat(ok.frameworkVersion()).isEqualTo(3);
                assertThat(ok.response().path("verdicts").size()).isEqualTo(4);
                assertThat(ok.proposalId()).isNull();

                assertThat(store.insertReviewIfAbsent(review(W3, "FORMAT_ERROR", null, verdicts("유지")))).isTrue();
                assertThat(store.insertReviewIfAbsent(review(W4, "API_ERROR", null, null))).isTrue();

                List<PaperStore.ReviewSummary> list = store.reviews(10);
                assertThat(list).extracting(PaperStore.ReviewSummary::weekEnding).as("주 최근 순")
                        .containsExactly(W4, W3, W2, W1);
                PaperStore.ReviewSummary okRow = list.get(2);
                assertThat(okRow.held()).isEqualTo(2);
                assertThat(okRow.refuted()).isEqualTo(1);
                assertThat(okRow.undetermined()).isEqualTo(1);
                assertThat(okRow.windowWeeks()).isEqualTo(4);
                assertThat(okRow.proposalId()).isNull();
                assertThat(okRow.proposalStatus()).isNull();
                for (PaperStore.ReviewSummary other : List.of(list.get(0), list.get(1), list.get(3))) {
                    assertThat(java.util.Arrays.asList(other.held(), other.refuted(), other.undetermined()))
                            .as("OK가 아닌 행(%s)은 판정 수 없음 — 0건이 아님", other.status()).containsOnlyNulls();
                }
                assertThat(list.get(0).error()).isEqualTo("[RATE_LIMIT] 429");
                assertThat(store.reviews(2)).extracting(PaperStore.ReviewSummary::weekEnding).containsExactly(W4, W3);
                assertThat(store.review(LocalDate.of(1999, 2, 5))).isEmpty();

                // 입력 문자열은 JSON이어야 합니다 — 구분자째 넣으면 읽을 때마다 깨지므로 넣을 때 막습니다.
                assertThatThrownBy(() -> store.insertReviewIfAbsent(new PaperStore.Review(LocalDate.of(1999, 2, 5), 4,
                        MAPPER.createObjectNode(), "<<복기 입력 시작>>{}<<복기 입력 끝>>", null, null, "m", null, "OK", null,
                        null, null, 0, null)))
                        .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("input_text");
                assertThat(store.review(LocalDate.of(1999, 2, 5))).isEmpty();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("복기 레코드는 DB CHECK·NOT NULL 전에 상태·입력을 막는다")
    void reviewRecordValidates() {
        JsonNode input = MAPPER.createObjectNode();
        assertThatThrownBy(() -> new PaperStore.Review(W1, 4, input, null, null, null, null, null, "DONE", null, null,
                null, 0, null)).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("DONE");
        assertThatThrownBy(() -> new PaperStore.Review(W1, 4, null, null, null, null, null, null, "SKIPPED", null, null,
                null, 0, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PaperStore.Review(W1, 4, input, null, null, null, null, null, "SKIPPED", null, null,
                null, -1, null)).isInstanceOf(IllegalArgumentException.class);
        assertThat(PaperStore.Review.STATUSES).containsExactlyInAnyOrder("OK", "FORMAT_ERROR", "API_ERROR", "REFUSED",
                "SKIPPED");
        // DB CHECK와 같은 목록인가 — 레코드만 넓히고 마이그레이션을 잊으면 여기서 걸립니다.
        String check = jdbc.queryForObject("SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
                + "WHERE c.conrelid = 'paper_reviews'::regclass AND c.contype = 'c' "
                + "AND pg_get_constraintdef(c.oid) LIKE '%status%'", String.class);
        for (String status : PaperStore.Review.STATUSES) {
            assertThat(check).contains("'" + status + "'");
        }
    }

    @Test
    @DisplayName("복기 재시도: API 오류·재시도 전 행만 같은 행에서 한 번 바꾸고 재시도 수 1 — 제안은 한 번만 이어지고, 제안을 지우면 연결만 비움 — 시험 뒤 되돌림")
    void reviewRetryOnceAndProposalLink() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            try {
                assertThat(store.insertReviewIfAbsent(review(W1, "API_ERROR", null, null))).isTrue();
                assertThat(store.insertReviewIfAbsent(review(W2, "FORMAT_ERROR", null, verdicts("유지")))).isTrue();
                assertThat(store.insertReviewIfAbsent(review(W3, "SKIPPED", null, null))).isTrue();

                String resent = "{\"weekEnding\":\"1999-01-08\",\"windowWeeks\":2}";
                PaperStore.Review retry = new PaperStore.Review(W1, 2, MAPPER.readTree(resent), resent,
                        verdicts("반증"), "{raw}", "claude-haiku-5-5", MAPPER.readTree("{\"inputTokens\":9}"), "OK", null,
                        null, 5, 0, null);
                assertThat(store.updateReviewRetry(retry)).isTrue();
                PaperStore.Review saved = store.review(W1).orElseThrow();
                assertThat(saved.status()).isEqualTo("OK");
                assertThat(saved.retryCount()).isEqualTo(1);
                assertThat(saved.windowWeeks()).isEqualTo(2);
                assertThat(saved.inputText()).isEqualTo(resent);
                assertThat(saved.model()).isEqualTo("claude-haiku-5-5");
                assertThat(saved.usage().path("inputTokens").asInt()).isEqualTo(9);
                assertThat(saved.responseRaw()).isEqualTo("{raw}");
                assertThat(saved.error()).isNull();
                assertThat(saved.frameworkVersion()).isEqualTo(5);
                assertThat(saved.createdAt()).isNotNull();

                assertThat(store.updateReviewRetry(retry)).as("이미 재시도함").isFalse();
                assertThat(store.updateReviewRetry(withWeek(retry, W2))).as("형식 오류는 그 주의 끝").isFalse();
                assertThat(store.updateReviewRetry(withWeek(retry, W3))).as("건너뛴 주").isFalse();
                assertThat(store.updateReviewRetry(withWeek(retry, W4))).as("없는 주").isFalse();
                assertThat(store.review(W2).orElseThrow().status()).isEqualTo("FORMAT_ERROR");

                long first = store.insertProposal(new PaperStore.FrameworkProposal(0, null, 5, "주간 복기 1999-01-08",
                        "claude-haiku-5-5", MAPPER.readTree("{\"summary\":\"요지\"}"), null, "PENDING", null, null,
                        null, null));
                long second = store.insertProposal(new PaperStore.FrameworkProposal(0, null, 5, "다른 것", "m", null,
                        null, "FAILED", "x", null, null, null));
                assertThat(store.linkReviewProposal(W1, first)).isTrue();
                assertThat(store.linkReviewProposal(W1, second)).as("먼저 이은 제안을 덮지 않음").isFalse();
                assertThat(store.linkReviewProposal(W4, first)).as("없는 주").isFalse();
                assertThat(store.review(W1).orElseThrow().proposalId()).isEqualTo(first);
                PaperStore.ReviewSummary row = store.reviews(50).stream().filter(r -> r.weekEnding().equals(W1))
                        .findFirst().orElseThrow();
                assertThat(row.proposalId()).isEqualTo(first);
                assertThat(row.proposalStatus()).isEqualTo("PENDING");
                assertThat(row.refuted()).isEqualTo(1);
                assertThat(store.decideProposal(first, "REJECTED", null)).isTrue();
                assertThat(store.reviews(50).stream().filter(r -> r.weekEnding().equals(W1)).findFirst().orElseThrow()
                        .proposalStatus()).as("제안의 지금 상태").isEqualTo("REJECTED");

                jdbc.update("DELETE FROM paper_framework_proposals WHERE id = ?", first);
                assertThat(store.review(W1).orElseThrow().proposalId()).as("ON DELETE SET NULL — 복기는 남음").isNull();
                assertThat(store.linkReviewProposal(W1, second)).as("비었으니 다시 이을 수 있음").isTrue();

                // 없는 제안 번호는 외래키가 막습니다 — 트랜잭션이 오류 상태가 되므로 마지막 문장입니다.
                assertThatThrownBy(() -> store.linkReviewProposal(W3, -1))
                        .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    // ------------------------------------------------------------------ 한국 책 스키마(V14, 2단계 명세 §4-14)
    /** V14 파일 — 백엔드 모듈에서 본 저장소 경로(DatasetsParityTest의 catalog.py와 같은 방식). */
    private static final Path V14 = Path.of("../db/migrations/V14__paper_kr_schema.sql");

    private static PaperStore.Review review(String market, LocalDate week, String status) throws Exception {
        PaperStore.Review r = review(week, status, null, null);
        return new PaperStore.Review(r.weekEnding(), r.windowWeeks(), r.input(), r.inputText(), r.response(),
                r.responseRaw(), r.model(), r.usage(), r.status(), r.error(), r.proposalId(), r.frameworkVersion(),
                r.retryCount(), r.createdAt(), market);
    }

    @Test
    @DisplayName("V14 전 DB(paper_reviews.market·paper_notes.market 열 없음)는 준비 안 됨 — 복기·메모 SQL 오류(500) 대신 안내 문구, 시험 뒤 되돌림")
    void readyRequiresV14() {
        class Rollback extends RuntimeException {
        }
        for (String table : List.of("paper_reviews", "paper_notes")) {
            assertThatThrownBy(() -> store.atomically(() -> {
                jdbc.execute("ALTER TABLE " + table + " DROP COLUMN market");
                assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready())
                        .as("V14 열 " + table + ".market이 없으면 준비 안 됨").isFalse();
                throw new Rollback();
            })).isInstanceOf(Rollback.class);
        }
        assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("V14: 주문 시점에 NEXT_OPEN(옛 네 시점 그대로, 모르는 시점은 막힘), 미국 체결의 비용 칸 fee·tax·slippage_cost는 0(음수는 막힘), 보유의 corp_action_hold는 NULL로 시작하고 보유 갱신이 지우지 않음")
    void v14TimingFillCostsAndCorpActionHold() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        long open = store.insertOrder(new PaperStore.Order(0, BOOK, null, "005930", "BUY", 10, null, null, "NEXT_OPEN",
                "RULE", "PENDING", null, null, DAY, null, DAY.plusDays(5), null));
        assertThat(store.ordersByStatus(BOOK, "PENDING")).singleElement()
                .satisfies(o -> assertThat(o.timing()).isEqualTo("NEXT_OPEN"));
        for (String timing : List.of("NEXT_OBSERVATION", "NEXT_CLOSE", "IMMEDIATE", "BACKFILL")) {
            assertThat(store.insertOrder(new PaperStore.Order(0, BOOK, null, "SPY", "BUY", 1, null, null, timing, "RULE",
                    "PROPOSED", null, null, DAY, null, null, null))).as("옛 시점 " + timing).isPositive();
        }
        assertThatThrownBy(() -> jdbc.update("UPDATE paper_orders SET timing = 'NEXT_NOON' WHERE id = ?", open))
                .as("모르는 시점").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);

        long orderId = store.insertOrder(pendingBuy(BOOK, "SPY", null));
        long fillId = store.insertFill(fill(orderId, BOOK));
        assertThat(jdbc.queryForMap("SELECT fee::text AS fee, tax::text AS tax, slippage_cost::text AS slippage_cost "
                + "FROM paper_fills WHERE id = ?", fillId)).as("미국 체결은 비용 칸 0(슬리피지는 price에 들어 있음)")
                .containsEntry("fee", "0.0000").containsEntry("tax", "0.0000").containsEntry("slippage_cost", "0.0000");
        assertThat(store.recentFills(BOOK, 1).get(0).price()).as("미국 체결가 그대로").isEqualTo(680.34);
        for (String column : List.of("fee", "tax", "slippage_cost")) {
            assertThatThrownBy(() -> jdbc.update("UPDATE paper_fills SET " + column + " = -1 WHERE id = ?", fillId))
                    .as(column + " 음수").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        }

        store.upsertPosition(new PaperStore.Position(BOOK, "005930", 10, 71_300, DAY, CLOSE, 71_300, CLOSE, null, null,
                false, DAY, 71_300, null));
        assertThat(jdbc.queryForObject("SELECT corp_action_hold FROM paper_positions WHERE book_code = ? AND ticker = ?",
                String.class, BOOK, "005930")).as("정상 보유").isNull();
        jdbc.update("UPDATE paper_positions SET corp_action_hold = ? WHERE book_code = ? AND ticker = ?",
                "가격제한폭 밖 변동 — 확인 필요", BOOK, "005930");
        store.upsertPosition(new PaperStore.Position(BOOK, "005930", 10, 71_300, DAY, CLOSE, 71_300, CLOSE, 70_000.0,
                CLOSE, false, DAY, 71_300, null));
        assertThat(jdbc.queryForObject("SELECT corp_action_hold FROM paper_positions WHERE book_code = ? AND ticker = ?",
                String.class, BOOK, "005930")).as("보유 갱신은 그 칸을 쓰지 않음").isEqualTo("가격제한폭 밖 변동 — 확인 필요");
    }

    @Test
    @DisplayName("체결 비용 칸(C2b): 한국 체결의 수수료·세금·슬리피지 금액을 넣고 그대로 읽음(소수 4자리), 비용 칸 없는 체결은 0 — 레코드가 음수·소수 5자리를 받지 않음")
    void fillCostColumnsRoundTrip() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        // §5 손계산 — 코스피 매도 10주 72,000: 수수료 108·슬리피지 360·세금 360 + 1,080, 체결가 = 관측가
        long sell = store.insertOrder(pendingBuy(BOOK, "005930", null));
        long fillId = store.insertFill(new PaperStore.Fill(0, sell, BOOK, "005930", "SELL", 10, 72_000, 72_000, 5,
                720_000, CLOSE, DAY, "TOSS_1M_OPEN", false, null, java.math.BigDecimal.valueOf(108),
                java.math.BigDecimal.valueOf(1_440), java.math.BigDecimal.valueOf(360)));
        assertThat(jdbc.queryForMap("SELECT fee::text AS fee, tax::text AS tax, slippage_cost::text AS slippage_cost, "
                + "price::text AS price FROM paper_fills WHERE id = ?", fillId))
                .containsEntry("fee", "108.0000").containsEntry("tax", "1440.0000")
                .containsEntry("slippage_cost", "360.0000").containsEntry("price", "72000.000000");
        PaperStore.Fill read = store.recentFills(BOOK, 1).get(0);
        assertThat(read.fee()).isEqualByComparingTo("108");
        assertThat(read.tax()).isEqualByComparingTo("1440");
        assertThat(read.slippageCost()).isEqualByComparingTo("360");
        assertThat(read.priceSource()).isEqualTo("TOSS_1M_OPEN");
        assertThat(new PaperStore.Fill(read.id(), read.orderId(), read.bookCode(), read.ticker(), read.side(), read.qty(),
                read.price(), read.rawPrice(), read.slippageBp(), read.gross(), read.observedAt(), read.observationDate(),
                read.priceSource(), read.backfill(), read.createdAt(), java.math.BigDecimal.valueOf(108),
                java.math.BigDecimal.valueOf(1_440), java.math.BigDecimal.valueOf(360)))
                .as("만든 값과 읽은 값이 같은 레코드(소수 4자리로 맞춤)").isEqualTo(read);

        long plain = store.insertFill(fill(store.insertOrder(pendingBuy(BOOK, "SPY", null)), BOOK));
        PaperStore.Fill us = store.recentFills(BOOK, 2).stream().filter(f -> f.id() == plain).findFirst().orElseThrow();
        assertThat(List.of(us.fee(), us.tax(), us.slippageCost())).as("비용 칸 없는 체결(미국)은 0")
                .allSatisfy(v -> assertThat(v).isEqualByComparingTo("0"));

        assertThatThrownBy(() -> new PaperStore.Fill(0, 1, BOOK, "005930", "BUY", 1, 1, 1, 5, 1, CLOSE, DAY, "X", false,
                null, java.math.BigDecimal.valueOf(-1), java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO))
                .as("음수 비용").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PaperStore.Fill(0, 1, BOOK, "005930", "BUY", 1, 1, 1, 5, 1, CLOSE, DAY, "X", false,
                null, new java.math.BigDecimal("0.00001"), java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO))
                .as("소수 5자리").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("V15 since 봉 거래량(C2c, 결정 d12): NULL로 시작하고 쓰면 그 책 목록에만, 보유 갱신은 지우지 않음, null로 비움, 0 이하는 코드·CHECK가 막음, 보유가 없으면 아무것도 안 함")
    void fillRefVolumeRoundTrip() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        store.insertBookIfAbsent(book(OTHER_BOOK, "벤치마크"));
        store.upsertPosition(new PaperStore.Position(BOOK, "005930", 10, 71_300, DAY, CLOSE, 71_300, CLOSE, null, null,
                false, DAY, 71_400, null));
        store.upsertPosition(new PaperStore.Position(OTHER_BOOK, "005930", 1, 71_300, DAY, CLOSE, 71_300, CLOSE, null,
                null, false, DAY, 71_400, null));
        assertThat(store.fillRefVolumes(BOOK)).as("새 보유·미국 보유는 모름(NULL)").isEmpty();

        store.updateFillRefVolume(BOOK, "005930", 17_213_072L);
        assertThat(store.fillRefVolumes(BOOK)).containsExactly(java.util.Map.entry("005930", 17_213_072L));
        assertThat(store.fillRefVolumes(OTHER_BOOK)).as("다른 책의 같은 종목").isEmpty();

        store.upsertPosition(new PaperStore.Position(BOOK, "005930", 12, 71_300, DAY, CLOSE, 71_300, CLOSE, 70_000.0,
                CLOSE, false, DAY, 71_400, null));
        assertThat(store.fillRefVolumes(BOOK)).as("보유 갱신은 그 칸을 쓰지 않음").containsEntry("005930", 17_213_072L);

        store.updateFillRefVolume(BOOK, "035420", 5L);
        assertThat(store.fillRefVolumes(BOOK)).as("보유 없는 종목 — 행이 생기지 않음").containsOnlyKeys("005930");
        assertThatThrownBy(() -> store.updateFillRefVolume(BOOK, "005930", 0L)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE paper_positions SET fill_ref_volume = 0 WHERE book_code = ?", BOOK))
                .as("CHECK > 0 — since 봉은 관측").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);

        store.updateFillRefVolume(BOOK, "005930", null);
        assertThat(store.fillRefVolumes(BOOK)).as("null로 비움").isEmpty();
    }

    @Test
    @DisplayName("V15 전 DB(paper_positions.fill_ref_volume 열 없음)는 준비 안 됨 — 한국 장부의 SQL 오류 대신 안내 문구, 시험 뒤 되돌림")
    void readyRequiresV15() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.execute("ALTER TABLE paper_positions DROP COLUMN fill_ref_volume");
            assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("V15 열이 없으면 준비 안 됨").isFalse();
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready()).as("되돌린 뒤").isTrue();
    }

    @Test
    @DisplayName("미처리 기업행위 표시(B7): 걸면 그 책 목록에만 나오고 다시 걸어도 처음 사유가 남음, 보유 갱신은 지우지 않음, 풀면 빠지고 다시 걸 수 있음, 보유 없는 종목·빈 사유, 보유를 지우면 표시도")
    void corpActionHoldIsSetOnceAndReleased() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        store.insertBookIfAbsent(book(OTHER_BOOK, "벤치마크"));
        PaperStore.Position samsung = new PaperStore.Position(BOOK, "005930", 10, 71_300, DAY, CLOSE, 71_300, CLOSE,
                null, null, false, DAY, 71_300, null);
        store.upsertPosition(samsung);
        store.upsertPosition(new PaperStore.Position(BOOK, "000660", 3, 250_000, DAY, CLOSE, 250_000, CLOSE, null, null,
                false, DAY, 250_000, null));
        store.upsertPosition(new PaperStore.Position(OTHER_BOOK, "005930", 1, 71_300, DAY, CLOSE, 71_300, CLOSE, null,
                null, false, DAY, 71_300, null));
        assertThat(store.corpActionHolds(BOOK)).isEmpty();

        String first = "2026-10-23 기업행위 확인 필요 — 2026-10-23 가격제한폭(±30%) 밖 변동 -40.0%(2026-10-22 71,300 → "
                + "2026-10-23 42,780)";
        assertThat(store.holdForCorpAction(BOOK, "005930", first)).isTrue();
        assertThat(store.holdForCorpAction(BOOK, "005930", "2026-10-26 기업행위 확인 필요 — 다른 사유"))
                .as("이미 걸림 — 처음 사유·걸린 날을 지킴").isFalse();
        assertThat(store.corpActionHolds(BOOK)).containsExactly(new PaperStore.CorpActionHold(BOOK, "005930", first));
        assertThat(store.corpActionHolds(OTHER_BOOK)).as("다른 책의 같은 종목").isEmpty();

        store.upsertPosition(new PaperStore.Position(BOOK, "005930", 10, 71_300, DAY, CLOSE, 71_300, CLOSE, 70_000.0,
                CLOSE, false, DAY, 71_300, null));
        assertThat(store.corpActionHolds(BOOK)).as("보유 갱신은 표시를 지우지 않음").extracting(PaperStore.CorpActionHold::reason)
                .containsExactly(first);
        assertThat(store.positions(BOOK)).hasSize(2);

        assertThat(store.holdForCorpAction(BOOK, "035420", first)).as("보유 없는 종목").isFalse();
        assertThat(store.corpActionHolds(BOOK)).hasSize(1);
        assertThatThrownBy(() -> store.holdForCorpAction(BOOK, "000660", " ")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.holdForCorpAction(BOOK, "000660", null)).isInstanceOf(IllegalArgumentException.class);

        assertThat(store.releaseCorpActionHold(BOOK, "005930")).isTrue();
        assertThat(store.releaseCorpActionHold(BOOK, "005930")).as("이미 풂").isFalse();
        assertThat(store.corpActionHolds(BOOK)).isEmpty();
        assertThat(store.holdForCorpAction(BOOK, "005930", first)).as("푼 뒤 다시 걸 수 있음").isTrue();

        assertThat(store.holdForCorpAction(BOOK, "000660", "2026-10-23 기업행위 확인 필요 — 토스·금융위 모두 종목 없음")).isTrue();
        assertThat(store.corpActionHolds(BOOK)).extracting(PaperStore.CorpActionHold::ticker)
                .as("ticker 순").containsExactly("000660", "005930");
        store.deletePosition(BOOK, "000660");
        assertThat(store.corpActionHolds(BOOK)).as("보유를 지우면 표시도").extracting(PaperStore.CorpActionHold::ticker)
                .containsExactly("005930");
    }

    @Test
    @DisplayName("V14 확정 조정 표: 체결마다 한 행(두 번째는 DuplicateKeyException), 출처는 FSC·FSC_ETF만, 비용 칸 음수 불가·현금 차이는 음수 가능, 책 초기화·삭제 때 체결과 함께 지워짐")
    void fillConfirmationsOnePerFill() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        long fillId = store.insertFill(fill(store.insertOrder(pendingBuy(BOOK, "SPY", null)), BOOK));
        String insert = "INSERT INTO paper_fill_confirmations (fill_id, book_code, confirmed_price, fee, tax, "
                + "slippage_cost, cash_delta, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        // §5 손계산 — 매수 10주 잠정 71,300 → 확정 71,200: 수수료 106·슬리피지 356 그대로, 현금 +1,000
        assertThat(jdbc.update(insert, fillId, BOOK, 71_200, 106, 0, 356, 1_000, "FSC")).isEqualTo(1);
        assertThatThrownBy(() -> jdbc.update(insert, fillId, BOOK, 71_100, 106, 0, 355, 2_000, "FSC"))
                .as("체결마다 한 행(추가만)").isInstanceOf(DuplicateKeyException.class);
        assertThat(jdbc.queryForMap("SELECT confirmed_price::text AS price, cash_delta::text AS delta, "
                + "reconciled_at IS NOT NULL AS stamped FROM paper_fill_confirmations WHERE fill_id = ?", fillId))
                .containsEntry("price", "71200.000000").containsEntry("delta", "1000.0000")
                .containsEntry("stamped", true);

        long second = store.insertFill(fill(store.insertOrder(pendingBuy(BOOK, "QQQ", null)), BOOK));
        assertThatThrownBy(() -> jdbc.update(insert, second, BOOK, 1, 0, 0, 0, 0, "TOSS_DAILY"))
                .as("확정 출처는 금융위만").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, second, BOOK, 1, -1, 0, 0, 0, "FSC"))
                .as("수수료 음수").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(insert, -1L, BOOK, 1, 0, 0, 0, 0, "FSC"))
                .as("없는 체결").isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(jdbc.update(insert, second, BOOK, 108_100, 1_621, 0, 5_405, -999, "FSC_ETF")).as("현금 차이 음수")
                .isEqualTo(1);

        store.resetBook(BOOK);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_fill_confirmations WHERE book_code = ?",
                Integer.class, BOOK)).as("초기화가 지운 체결의 확정 조정도 함께").isZero();
    }

    @Test
    @DisplayName("확정 조정 읽고 쓰기(C3): 확정 안 된 체결은 사후 체결을 빼고 체결 순·그 주문의 체결 시점과 함께, 두 번째 넣기는 false(현금을 두 번 옮기지 않게)·첫 값 그대로, 읽은 행 = 넣은 값(가격 6·금액 4자리), 가장 늦은 체결일, 초기화가 함께 지움")
    void fillConfirmationReadWrite() {
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        assertThat(store.latestFillDate(BOOK)).as("체결 없음").isEmpty();
        store.insertFill(fill(store.insertOrder(pendingBuy(BOOK, "SPY", null)), BOOK));   // 사후 체결(미국 출발) — 확정 대상 아님
        LocalDate fillDay = DAY.plusDays(4);
        long buyOrder = store.insertOrder(new PaperStore.Order(0, BOOK, null, "005930", "BUY", 10, null, null, "NEXT_OPEN",
                "CLAUDE", "FILLED", null, null, DAY, CLOSE, DAY.plusDays(7), CLOSE));
        long buy = store.insertFill(new PaperStore.Fill(0, buyOrder, BOOK, "005930", "BUY", 10, 71_300, 71_300, 5, 713_000,
                CLOSE, fillDay, "TOSS_1M_OPEN", false, null, java.math.BigDecimal.valueOf(106), java.math.BigDecimal.ZERO,
                java.math.BigDecimal.valueOf(356)));
        long sellOrder = store.insertOrder(new PaperStore.Order(0, BOOK, null, "000660", "SELL", 10, null, null,
                "NEXT_OPEN", "STOP", "FILLED", null, null, DAY, CLOSE, DAY.plusDays(7), CLOSE));
        long sell = store.insertFill(new PaperStore.Fill(0, sellOrder, BOOK, "000660", "SELL", 10, 72_000, 72_000, 5,
                720_000, CLOSE, DAY.plusDays(3), "TOSS_INTEGRATED", false, null, java.math.BigDecimal.valueOf(108),
                java.math.BigDecimal.valueOf(1_440), java.math.BigDecimal.valueOf(360)));

        assertThat(store.unconfirmedFills(BOOK)).extracting(u -> u.fill().id(), PaperStore.UnconfirmedFill::timing)
                .as("사후 체결 빼고 체결 순, 주문의 체결 시점").containsExactly(
                        org.assertj.core.groups.Tuple.tuple(buy, "NEXT_OPEN"),
                        org.assertj.core.groups.Tuple.tuple(sell, "NEXT_OPEN"));
        assertThat(store.unconfirmedFills(BOOK).get(0).fill().fee()).isEqualByComparingTo("106");
        assertThat(store.latestFillDate(BOOK)).contains(fillDay);

        // §5 손계산 — 매수 10주 잠정 71,300 → 확정 71,200: 수수료 106·슬리피지 356 그대로, 현금 +1,000
        PaperStore.FillConfirmation first = new PaperStore.FillConfirmation(buy, BOOK, java.math.BigDecimal.valueOf(71_200),
                java.math.BigDecimal.valueOf(106), java.math.BigDecimal.ZERO, java.math.BigDecimal.valueOf(356),
                java.math.BigDecimal.valueOf(1_000), PaperStore.FillConfirmation.SOURCE_FSC, null);
        assertThat(store.insertFillConfirmationIfAbsent(first)).isTrue();
        assertThat(store.insertFillConfirmationIfAbsent(new PaperStore.FillConfirmation(buy, BOOK,
                java.math.BigDecimal.valueOf(71_100), java.math.BigDecimal.valueOf(106), java.math.BigDecimal.ZERO,
                java.math.BigDecimal.valueOf(355), java.math.BigDecimal.valueOf(2_001), "FSC", null)))
                .as("체결마다 한 행 — 두 번째는 false").isFalse();
        assertThat(store.unconfirmedFills(BOOK)).extracting(u -> u.fill().id()).containsExactly(sell);
        List<PaperStore.FillConfirmation> rows = store.fillConfirmations(BOOK);
        assertThat(rows).singleElement().satisfies(row -> {
            assertThat(row.reconciledAt()).as("DB now()").isNotNull();
            assertThat(new PaperStore.FillConfirmation(row.fillId(), row.bookCode(), first.confirmedPrice(), first.fee(),
                    first.tax(), first.slippageCost(), first.cashDelta(), first.source(), row.reconciledAt()))
                    .as("읽은 값 = 넣은 값(첫 값 그대로)").isEqualTo(row);
        });
        assertThat(jdbc.queryForObject("SELECT price::text FROM paper_fills WHERE id = ?", String.class, buy))
                .as("체결 행은 그대로").isEqualTo("71300.000000");

        assertThatThrownBy(() -> new PaperStore.FillConfirmation(buy, BOOK, java.math.BigDecimal.ONE,
                java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO,
                "TOSS_DAILY", null)).as("확정 출처는 금융위 둘").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PaperStore.FillConfirmation(buy, BOOK, java.math.BigDecimal.ONE,
                java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO,
                new java.math.BigDecimal("0.00001"), "FSC", null)).as("금액 소수 4자리까지")
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PaperStore.FillConfirmation(buy, BOOK, java.math.BigDecimal.ZERO,
                java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO,
                "FSC", null)).as("확정가 0").isInstanceOf(IllegalArgumentException.class);

        store.resetBook(BOOK);
        assertThat(store.fillConfirmations(BOOK)).as("초기화가 지운 체결의 확정 조정도 함께").isEmpty();
    }

    @Test
    @DisplayName("그 시각에 유효했던 설정 판(결정 d7 — 확정 조정은 그 체결 때의 요율): 이력에서 그 시각 이전(같은 시각 포함)에 남긴 가장 늦은 판, 그 전이면 없음 — 시험 뒤 되돌림")
    void settingsInForceAt() {
        class Rollback extends RuntimeException {
        }
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_settings_history");
            String insert = "INSERT INTO paper_settings_history (version, body, changed_keys, created_at) "
                    + "VALUES (?, CAST(? AS jsonb), '{}', ?)";
            jdbc.update(insert, 1, "{\"v\": 1}", Timestamp.from(Instant.parse("2026-10-01T00:00:00Z")));
            jdbc.update(insert, 2, "{\"v\": 2}", Timestamp.from(Instant.parse("2026-11-01T00:00:00Z")));
            assertThat(store.settingsInForceAt(Instant.parse("2026-09-30T23:59:59Z"))).as("첫 판 전").isEmpty();
            assertThat(store.settingsInForceAt(Instant.parse("2026-10-01T00:00:00Z"))).as("같은 시각 포함")
                    .hasValueSatisfying(row -> assertThat(row.version()).isEqualTo(1));
            assertThat(store.settingsInForceAt(Instant.parse("2026-10-31T23:59:59Z")))
                    .hasValueSatisfying(row -> {
                        assertThat(row.version()).isEqualTo(1);
                        assertThat(row.body().path("v").asInt()).isEqualTo(1);
                        assertThat(row.updatedAt()).as("그 판을 남긴 시각").isEqualTo(Instant.parse("2026-10-01T00:00:00Z"));
                    });
            assertThat(store.settingsInForceAt(Instant.parse("2027-01-04T00:00:00Z")))
                    .hasValueSatisfying(row -> assertThat(row.version()).isEqualTo(2));
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("V14 복기 기본키 (market, week_ending): 같은 주의 미국·한국 행이 따로 들어가고(시장마다 두 번째는 false), 읽기·목록·재시도·제안 잇기가 그 시장 행만 — 시장을 받지 않는 옛 시그니처는 미국, 모르는 시장은 레코드·CHECK가 막음 — 시험 뒤 되돌림")
    void reviewsPerMarket() {
        class Rollback extends RuntimeException {
        }
        assertThat(jdbc.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conrelid = 'paper_reviews'::regclass AND contype = 'p'", String.class))
                .isEqualTo("PRIMARY KEY (market, week_ending)");
        assertThatThrownBy(() -> store.atomically(() -> {
            try {
                assertThat(store.insertReviewIfAbsent(review(W1, "API_ERROR", null, null))).as("옛 모양 = 미국").isTrue();
                assertThat(store.insertReviewIfAbsent(review("KR", W1, "API_ERROR"))).as("같은 주 한국").isTrue();
                assertThat(store.insertReviewIfAbsent(review("KR", W1, "OK"))).as("한국 같은 주 두 번째").isFalse();
                assertThat(store.insertReviewIfAbsent(review("US", W1, "OK"))).as("미국 같은 주 두 번째").isFalse();
                assertThat(store.insertReviewIfAbsent(review("KR", W2, "SKIPPED"))).isTrue();
                assertThat(jdbc.queryForList("SELECT market FROM paper_reviews WHERE week_ending = ? ORDER BY market",
                        String.class, java.sql.Date.valueOf(W1))).containsExactly("KR", "US");

                assertThat(store.review(W1).orElseThrow().market()).isEqualTo("US");
                assertThat(store.review("KR", W1).orElseThrow().market()).isEqualTo("KR");
                assertThat(store.review("US", W2)).as("한국에만 있는 주").isEmpty();
                assertThat(store.reviews(10)).extracting(PaperStore.ReviewSummary::weekEnding).containsExactly(W1);
                assertThat(store.reviews("KR", 10)).extracting(PaperStore.ReviewSummary::weekEnding)
                        .containsExactly(W2, W1);
                assertThat(store.reviews("JP", 10)).as("모르는 시장").isEmpty();

                String resent = "{\"weekEnding\":\"1999-01-08\",\"market\":\"KR\"}";
                PaperStore.Review retry = new PaperStore.Review(W1, 4, MAPPER.readTree(resent), resent, verdicts("유지"),
                        "{raw}", "claude-sonnet-5-5", null, "OK", null, null, 3, 0, null, "KR");
                assertThat(store.updateReviewRetry(retry)).isTrue();
                assertThat(store.review("KR", W1).orElseThrow()).extracting(PaperStore.Review::status,
                        PaperStore.Review::retryCount).containsExactly("OK", 1);
                assertThat(store.review(W1).orElseThrow()).as("같은 주 미국 행은 그대로(아직 재시도 전)")
                        .extracting(PaperStore.Review::status, PaperStore.Review::retryCount)
                        .containsExactly("API_ERROR", 0);
                assertThat(store.updateReviewRetry(withWeek(retry, W2))).as("한국 W2는 건너뛴 주").isFalse();

                long proposal = store.insertProposal(new PaperStore.FrameworkProposal(0, null, 3, "주간 복기 KR",
                        "m", null, null, "PENDING", null, null, null, null));
                assertThat(store.linkReviewProposal("KR", W1, proposal)).isTrue();
                assertThat(store.review(W1).orElseThrow().proposalId()).as("미국 행에는 잇지 않음").isNull();
                assertThat(store.linkReviewProposal("US", W2, proposal)).as("미국에 없는 주").isFalse();
                assertThat(store.linkReviewProposal(W1, proposal)).as("옛 시그니처 = 미국 행").isTrue();

                assertThatThrownBy(() -> review("JP", W3, "OK")).as("레코드가 먼저 막음")
                        .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("JP");
                // 모르는 시장은 CHECK가 막습니다 — 트랜잭션이 오류 상태가 되므로 마지막 문장입니다.
                assertThatThrownBy(() -> jdbc.update("UPDATE paper_reviews SET market = 'JP' WHERE week_ending = ?",
                        java.sql.Date.valueOf(W2)))
                        .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("V14 메모 시장: 넣은 시장 그대로 읽히고(옛 모양 = 미국), 목록·유효 시황은 그 시장 메모만, 번호 읽기·보관은 시장을 가리지 않음, 모르는 시장은 CHECK가 막음 — 시험 뒤 되돌림")
    void notesPerMarket() {
        class Rollback extends RuntimeException {
        }
        LocalDate mon = LocalDate.of(2026, 10, 26);
        assertThatThrownBy(() -> store.atomically(() -> {
            jdbc.update("DELETE FROM paper_framework_proposals");
            jdbc.update("DELETE FROM paper_notes");
            long us = store.insertNote(new PaperStore.Note(0, "MARKET", DAY, mon, "미국", "금리", false, null));
            long kr = store.insertNote(new PaperStore.Note(0, "MARKET", DAY, mon, "한국", "수급", false, null, "KR"));
            long krInsight = store.insertNote(new PaperStore.Note(0, "INSIGHT", DAY, null, "한국 방법론", "원문", false,
                    null, "KR"));
            assertThat(jdbc.queryForObject("SELECT market FROM paper_notes WHERE id = ?", String.class, us))
                    .as("옛 모양 = V14 기본값").isEqualTo("US");
            assertThat(store.note(kr).orElseThrow().market()).isEqualTo("KR");

            assertThat(store.notes(false, mon)).extracting(PaperStore.Note::id).as("옛 시그니처 = 미국").containsExactly(us);
            assertThat(store.notes("KR", false, mon)).extracting(PaperStore.Note::id).containsExactly(krInsight, kr);
            assertThat(store.notes("KR", true, mon)).extracting(PaperStore.Note::id).containsExactly(krInsight, kr);
            assertThat(store.activeMarketNotes(mon)).extracting(PaperStore.Note::id).containsExactly(us);
            assertThat(store.activeMarketNotes("KR", mon)).extracting(PaperStore.Note::id).containsExactly(kr);
            assertThat(store.activeMarketNotes("JP", mon)).isEmpty();

            assertThat(store.archiveNote(kr)).as("번호로 보관").isTrue();
            assertThat(store.activeMarketNotes("KR", mon)).isEmpty();
            assertThat(store.activeMarketNotes(mon)).extracting(PaperStore.Note::id).containsExactly(us);
            // 모르는 시장은 CHECK가 막습니다 — 트랜잭션이 오류 상태가 되므로 마지막 문장입니다.
            assertThatThrownBy(() -> jdbc.update("UPDATE paper_notes SET market = 'JP' WHERE id = ?", us))
                    .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
    }

    @Test
    @DisplayName("V14는 여러 번 실행해도 안전 — 이미 적용한 DB에서 두 번 더 돌려도 기존 미국 복기·메모·체결 행과 기본키·CHECK 모양이 그대로(make db-test·수집기 기동이 다시 돌림) — 시험 뒤 되돌림")
    void v14RerunIsSafe() throws Exception {
        assumeTrue(Files.exists(V14), "db/migrations/V14__paper_kr_schema.sql을 찾을 수 없습니다");
        String sql = Files.readString(V14);
        class Rollback extends RuntimeException {
        }
        store.insertBookIfAbsent(book(BOOK, "규칙 책"));
        long fillId = store.insertFill(fill(store.insertOrder(pendingBuy(BOOK, "SPY", null)), BOOK));
        String constraints = "SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), '; ' ORDER BY conname) "
                + "FROM pg_constraint WHERE conrelid IN ('paper_orders'::regclass, 'paper_fills'::regclass, "
                + "'paper_reviews'::regclass, 'paper_notes'::regclass, 'paper_fill_confirmations'::regclass, "
                + "'paper_positions'::regclass)";
        String before = jdbc.queryForObject(constraints, String.class);
        assertThatThrownBy(() -> store.atomically(() -> {
            try {
                assertThat(store.insertReviewIfAbsent(review(W1, "API_ERROR", null, null))).isTrue();
                long note = store.insertNote(new PaperStore.Note(0, "MARKET", DAY, DAY, "미국", "본문", false, null));
                jdbc.execute(sql);
                jdbc.execute(sql);
                assertThat(jdbc.queryForObject(constraints, String.class)).as("제약 모양 그대로").isEqualTo(before);
                assertThat(store.review(W1).orElseThrow()).extracting(PaperStore.Review::market,
                        PaperStore.Review::status).containsExactly("US", "API_ERROR");
                assertThat(store.note(note).orElseThrow().market()).isEqualTo("US");
                assertThat(jdbc.queryForObject("SELECT fee + tax + slippage_cost FROM paper_fills WHERE id = ?",
                        Double.class, fillId)).isZero();
                assertThat(store.insertReviewIfAbsent(review(W1, "OK", null, null))).as("다시 돌린 뒤에도 ON CONFLICT")
                        .isFalse();
                assertThat(store.insertReviewIfAbsent(review("KR", W1, "OK"))).isTrue();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            throw new Rollback();
        })).isInstanceOf(Rollback.class);
        assertThat(jdbc.queryForObject(constraints, String.class)).as("되돌린 뒤").isEqualTo(before);
    }

    private static PaperStore.Review withWeek(PaperStore.Review r, LocalDate week) {
        return new PaperStore.Review(week, r.windowWeeks(), r.input(), r.inputText(), r.response(), r.responseRaw(),
                r.model(), r.usage(), r.status(), r.error(), r.proposalId(), r.frameworkVersion(), r.retryCount(),
                r.createdAt(), r.market());
    }

    private void insertPoint(String seriesId, String date, Double value) {
        jdbc.update("INSERT INTO timeseries (dataset, series_id, obs_date, value) VALUES (?, ?, ?::date, ?)",
                TS_DATASET, seriesId, date, value);
    }

    private static int epoch(String date) {
        return (int) LocalDate.parse(date).toEpochDay();
    }
}
