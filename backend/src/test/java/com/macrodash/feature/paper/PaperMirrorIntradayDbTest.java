package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.feature.paper.PaperMirrorService.DueOrder;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.WeightAfter;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.SchemaCheck;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
import java.util.Set;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 거울 보기(ADR 0045 — 실제 계좌·ISA 공개 창이 장중 기록 STOP을 그 세션 밤 처리 전까지 대기로 봄)를 실제 저장소(macrodash_test)로: 실제 매매·ISA DB 시험은
 * 공개 창을 대역으로 쓰므로, 이 시험이 실제 {@link PaperStore}로 만든 {@link PaperMirrorService}의 값이 같은 행의 장중 기록 전·후에 같은지 봅니다(jsonb 근거
 * 조건·NUMERIC 자리·관측일 비교가 실제 SQL로 돎). 한 주기에 대기 STOP 종목과 시각 목표를 함께 읽는 실제 매매의 재선정 회전율 판정 입력도 같은지 봅니다.
 *
 * <p>책은 시험 접두어 {@value #BOOK}(PaperStoreDbTest의 {@code t_} 정리와 같은 접두어)만 쓰고 시작·끝에 지웁니다 — 장중 시장가(MARKET) 주문 행이 남으면 시험
 * DB 스키마를 다시 적용할 때 옛 시점 CHECK에 걸릴 수 있습니다.
 */
class PaperMirrorIntradayDbTest {

    private static final String BOOK = "t_kr_mirror";
    private static final LocalDate S = LocalDate.of(2026, 11, 6);
    private static final LocalDate P = LocalDate.of(2026, 11, 5);
    private static final String A = "005930";
    private static final String B = "000660";
    private static final String C = "035420";

    private JdbcTemplate jdbc;
    private PaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperMarkets markets;
    private PaperLedgerService ledger;

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url, System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        store = new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        assumeTrue(store.ready(), "테스트 DB에 모의 매매 표가 없습니다 — make db-test");
        cleanUp();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        when(marketData.watchKr()).thenReturn(Optional.empty());
        Map<String, Bar> bars = new LinkedHashMap<>();
        for (Object[] row : new Object[][]{{A, 10_000.0}, {B, 20_000.0}, {C, 5_010.0}}) {
            bars.put((String) row[0], PaperFixtures.bar((String) row[0], P.minusDays(1), (Double) row[1] * 0.99, P, row[1]));
        }
        when(marketData.quotes(any())).thenReturn(Optional.of(new Quotes(kst("2026-11-05T20:30"), bars, P)));
        markets = new PaperMarkets(store, reader);
        ledger = new PaperLedgerService(store, marketData, MAPPER);
    }

    @AfterEach
    void cleanUp() {
        if (jdbc != null) {
            jdbc.update("DELETE FROM paper_books WHERE code = ?", BOOK);
        }
    }

    private PaperMirrorService service(Instant now) {
        return new PaperMirrorService(store, reader, marketData, markets, ledger, Clock.fixed(now, ZoneOffset.UTC));
    }

    private record Seen(Optional<OpenTargets> open, Optional<OpenTargets> at, List<DueOrder> due, Set<String> stops,
                        Optional<WeightAfter> stopWeight, Optional<WeightAfter> otherWeight, Optional<String> status, Optional<String> claimed,
                        boolean caughtUp) {
    }

    private Seen seen(Instant now, long stop, long other) {
        PaperMirrorService s = service(now);
        // 실제 매매 한 주기(재선정 회전율 예외 판정)가 함께 읽는 두 값 — 대기 STOP 종목과 시각 목표.
        Set<String> stops = s.pendingStopSymbols(BOOK, S);
        Optional<OpenTargets> at = s.targetsAt(BOOK, S, kst("2026-11-06T11:00"));
        return new Seen(s.openTargets(BOOK, S), at, s.dueOrders(BOOK, S, now), stops, s.weightAfter(BOOK, stop, now),
                s.weightAfter(BOOK, other, now), s.orderStatus(BOOK, stop), s.claim(BOOK, stop, now, () -> "claimed"), s.ledgerCaughtUp(BOOK, S));
    }

    private void hold(String ticker, int qty, double price) {
        store.upsertPosition(new Position(BOOK, ticker, qty, price * 0.9, LocalDate.of(2026, 11, 2), kst("2026-11-02T09:10"), price * 1.1,
                kst("2026-11-04T20:40"), price, kst("2026-11-05T20:40"), false, P, price, null));
    }

    @Test
    @DisplayName("실제 저장소 — 같은 행의 장중 기록(STOP 둘·한 트랜잭션) 전·후에 시가·시각 목표·장중 주문·대기 STOP 종목·그 주문 뒤 비중·주문 상태·선점·장부 반영이 같음, "
            + "그 세션 밤 처리 뒤에는 되감지 않음")
    void mirrorIsTheSameWithTheRealStore() {
        store.insertBookIfAbsent(new Book(BOOK, PaperBooks.KIND_RULES, "시험 한국 책", 100_000_000, LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE,
                null, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.upsertState(new BookState(BOOK, 1_000_000.3, 4_665_330.3, 3_665_030, 78.5653, kst("2026-11-05T20:40"), kst("2026-11-05T20:40"),
                P, null));
        hold(A, 100, 10_000);
        hold(B, 50, 20_000);
        hold(C, 333, 5_010);
        ObjectNode reason = MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE).put("stopPct", 8).put("highWatermark", 11_000)
                .put("stopPrice", 10_120);
        long stopA = store.insertOrder(new Order(0, BOOK, null, A, PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                PaperBooks.ORDER_PENDING, null, reason, P, kst("2026-11-06T10:30:20"), S, null));
        long stopC = store.insertOrder(new Order(0, BOOK, null, C, PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                PaperBooks.ORDER_PENDING, null, reason, P, kst("2026-11-06T10:30:21"), S, null));
        long rule = store.insertOrder(new Order(0, BOOK, null, B, PaperBooks.BUY, null, 12.0, null, PaperBooks.AT_MINUTE,
                RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, P, kst("2026-11-05T22:40"), LocalDate.of(2026, 11, 10), null,
                LocalTime.of(11, 0)));
        Instant now = kst("2026-11-06T10:40");
        Seen off = seen(now, stopA, rule);

        Map<Long, Double> prices = new LinkedHashMap<>();
        prices.put(stopA, 9_870.0);
        prices.put(stopC, 4_615.0);
        IntradayRecords.record(store, BOOK, prices, kst("2026-11-06T10:35:20"), S, markets.open(KrPaperMarket.INSTANCE).calendar());
        assertThat(store.order(stopA).orElseThrow().status()).isEqualTo(PaperBooks.ORDER_FILLED);
        assertThat(store.positions(BOOK)).extracting(Position::ticker).containsExactly(B);
        assertThat(store.intradayRecordedStops(BOOK, P)).hasSize(2);
        Seen on = seen(now, stopA, rule);

        assertThat(on).isEqualTo(off);
        assertThat(off.stops()).containsExactlyInAnyOrder(A, C);
        assertThat(off.at().orElseThrow().stopOrderIds()).containsExactly(stopA, stopC);
        assertThat(off.open().orElseThrow().cash()).isEqualTo(1_000_000.3);
        assertThat(off.claimed()).contains("claimed");

        BookState state = store.state(BOOK).orElseThrow();
        store.upsertState(new BookState(BOOK, state.cash(), state.nav(), state.equityValue(), state.exposurePct(), kst("2026-11-06T20:40"),
                kst("2026-11-06T20:40"), S, null));
        PaperMirrorService after = service(kst("2026-11-06T21:00"));
        assertThat(after.pendingStopSymbols(BOOK, S)).as("S 밤 처리 뒤 — 되감지 않음").isEmpty();
        assertThat(after.orderStatus(BOOK, stopA)).contains(PaperBooks.ORDER_FILLED);
        assertThat(after.openTargets(BOOK, S).orElseThrow().cash()).isEqualTo(state.cash());
    }
}
