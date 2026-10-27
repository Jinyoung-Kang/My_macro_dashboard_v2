package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static com.macrodash.feature.paper.PaperFixtures.SAT;
import static com.macrodash.feature.paper.PaperFixtures.TUE;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.pending;
import static com.macrodash.feature.paper.PaperFixtures.position;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 시장 격리(2단계 명세 §9 A5) — 장부·관측치·리스크 점검이 받은 시장({@link PaperMarket})의 책만 처리하고, 세션·확정 판정·체결 가격
 * 출처·이력·작업 기록 이름을 그 시장 묶음에서 가져오는지 시험용 한국 묶음({@link TestKrMarket})으로 봅니다. 미국 숫자 자체는
 * {@code PaperLedgerServiceTest}(고정본 포함)가, 실제 DB 표에서 미국 작업이 한국 책 행을 바꾸지 않는 것은 {@code PaperLedgerDbTest}가
 * 지킵니다.
 */
class PaperMarketIsolationTest {

    private static final PaperMarket US = UsPaperMarket.INSTANCE;
    private static final PaperMarket KR = TestKrMarket.INSTANCE;
    private static final String US_BOOK = PaperBooks.CLAUDE;
    private static final String KR_BOOK = TestKrMarket.CLAUDE_BOOK;

    /** 10-26(월) 21:00 KST — 시험용 한국 달력으로는 그날 세션의 확정 종가 뒤, 미국 달력으로는 개장 전(직전 세션 10-23). */
    private static final Instant KR_EVENING = Instant.parse("2026-10-26T12:00:00Z");

    private FakePaperStore store;
    private PaperMarketData marketData;
    private PaperLedgerService ledger;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
    }

    /** 미국 Claude 책(대기 매수 AAA)과 시험용 한국 책(보유 005930·대기 매수 000660)을 같은 저장소에. */
    private void twoMarkets(FakePaperStore target) {
        activeBook(target, US_BOOK, PaperBooks.KIND_CLAUDE, 100_000, null);
        pending(target, US_BOOK, "AAA", "BUY", 10, null, null, "NEXT_OBSERVATION", FRI, SAT);
        target.books.put(KR_BOOK, TestKrMarket.book(KR_BOOK, 100_000_000, FRI));
        Instant krFriday = Instant.parse("2026-10-23T13:30:00Z");
        target.states.put(KR_BOOK, new BookState(KR_BOOK, 30_000_000, 100_700_000, 70_700_000, 70.2085, krFriday,
                krFriday, FRI, null));
        position(target, KR_BOOK, "005930", 1_000, 70_000, 72_000, 70_700.0, FRI, 70_700);
        pending(target, KR_BOOK, "000660", "BUY", 10, null, null, "NEXT_OBSERVATION", FRI, krFriday);
    }

    /** 한국 관측치(10-26 21:00 KST) — 미국 책의 대기 주문 종목(AAA)도 일부러 넣음. */
    private static Quotes krQuotes() {
        return quotes(KR_EVENING, bar("005930", FRI, 70_700, MON, 71_000), bar("000660", FRI, 200_000, MON, 201_000),
                bar("AAA", FRI, 9_999, MON, 9_999));
    }

    /** 미국 관측치(10-26 장중) — 한국 보유 종목(005930)도 일부러 넣음. */
    private static Quotes usQuotes(Instant collectedAt) {
        return quotes(collectedAt, bar("AAA", FRI, 100, MON, 101), bar("005930", FRI, 1, MON, 1));
    }

    /** 한 책의 장부 전부(상태·보유·주문·체결·순자산·재진입 금지) — 전후 비교용. */
    private static String ledgerOf(FakePaperStore target, String code) {
        return target.states.get(code) + "\n" + target.positions(code) + "\n" + target.ordersOf(code) + "\n"
                + target.fillsOf(code) + "\n" + target.navSeries(code) + "\n" + target.lockouts(code);
    }

    @Test
    @DisplayName("한국 관측치는 한국 책만, 미국 관측치는 미국 책만 — 다른 시장 책의 장부는 글자 그대로이고, 세션·확정·가격 출처는 그 시장 묶음")
    void processTouchesOnlyThatMarket() {
        twoMarkets(store);
        String usBefore = ledgerOf(store, US_BOOK);

        Outcome kr = ledger.process(KR, krQuotes());

        assertThat(kr.booksProcessed()).containsExactly(KR_BOOK);
        assertThat(kr.errors()).isEmpty();
        assertThat(ledgerOf(store, US_BOOK)).as("미국 책은 한국 관측치로 체결·평가·멱등 키가 바뀌지 않음").isEqualTo(usBefore);
        assertThat(store.fillsOf(KR_BOOK)).singleElement().satisfies(fill -> {
            assertThat(fill.ticker()).isEqualTo("000660");
            assertThat(fill.priceSource()).as("체결 가격 출처 = 그 시장의 관측치 데이터셋")
                    .isEqualTo(TestKrMarket.QUOTES_DATASET);
            assertThat(fill.observationDate()).isEqualTo(MON);
        });
        assertThat(store.navSeries(KR_BOOK)).as("한국 달력: 21:00 KST는 10-26 세션의 확정 종가 뒤 — 그날 확정 줄(미국 달력이면 개장 전)")
                .anySatisfy(row -> {
                    assertThat(row.tradingDate()).isEqualTo(MON);
                    assertThat(row.pricesFinal()).isTrue();
                });
        assertThat(store.states.get(KR_BOOK).lastProcessedCollectedAt()).isEqualTo(KR_EVENING);
        String krAfterOwn = ledgerOf(store, KR_BOOK);

        Outcome us = ledger.process(US, usQuotes(MON_INTRADAY));

        assertThat(us.booksProcessed()).containsExactly(US_BOOK);
        assertThat(store.fillsOf(US_BOOK)).singleElement().satisfies(fill -> {
            assertThat(fill.ticker()).isEqualTo("AAA");
            assertThat(fill.priceSource()).isEqualTo(PaperBooks.SOURCE_QUOTES);
        });
        assertThat(ledgerOf(store, KR_BOOK)).as("한국 책은 미국 관측치(같은 종목 005930 = 1 포함)로 바뀌지 않음")
                .isEqualTo(krAfterOwn);
        assertThat(ledger.process(KR, krQuotes()).skippedReason()).as("한국 멱등 키는 한국 수집 시각 그대로")
                .contains("이미 처리한 관측치");
    }

    @Test
    @DisplayName("미확정 순자산 줄은 그 시장 책에만 — 미국 판(옛 시그니처)은 한국 책에 줄을 쓰지 않는다")
    void settleNavPerMarket() {
        twoMarkets(store);

        assertThat(ledger.settleNav(KR, TUE, false)).containsExactly(KR_BOOK);
        assertThat(store.navSeries(US_BOOK)).as("미국 책에 한국 거래일 줄이 생기지 않음").isEmpty();

        assertThat(ledger.settleNav(TUE.plusDays(1), false)).as("옛 시그니처 = 미국").containsExactly(US_BOOK);
        assertThat(store.navSeries(KR_BOOK)).extracting(row -> row.tradingDate()).containsExactly(TUE);
    }

    @Test
    @DisplayName("새 관측치 판정·오류 기억은 시장마다 — 수집 시각이 같아도 한국 책의 오류가 미국 관측치를 막지 않고, 미국 수동 실행이 지우지 않는다")
    void failureMemoryPerMarket() {
        FakePaperStore failing = new FakePaperStore() {
            @Override
            public void upsertState(BookState s) {
                if (s.bookCode().equals(KR_BOOK) && s.lastProcessedCollectedAt() != null
                        && s.lastProcessedCollectedAt().equals(KR_EVENING)) {
                    throw new IllegalStateException("디스크 가득 참");
                }
                super.upsertState(s);
            }
        };
        twoMarkets(failing);
        PaperLedgerService service = new PaperLedgerService(failing, marketData, PaperFixtures.MAPPER);
        Quotes kr = krQuotes();
        Quotes us = usQuotes(KR_EVENING);   // 수집 시각까지 같은 미국 관측치(최악의 경우)

        assertThat(service.process(KR, kr).errors()).singleElement().asString().startsWith(KR_BOOK + ": ");
        assertThat(service.failedBooks(KR, kr)).containsExactly(KR_BOOK);
        assertThat(service.failedBooks(US, us)).as("미국 실패 목록에 한국 책이 없음").isEmpty();
        assertThat(service.hasNewObservation(KR, kr)).isFalse();
        assertThat(service.hasNewObservation(US, us)).isTrue();

        Outcome usOutcome = service.process(US, us);
        assertThat(usOutcome.booksProcessed()).containsExactly(US_BOOK);
        assertThat(usOutcome.errors()).isEmpty();
        assertThat(usOutcome.skippedReason()).isNull();

        service.forgetFailures(US);
        assertThat(service.failedBooks(KR, kr)).as("미국 기억만 지움").containsExactly(KR_BOOK);
        service.forgetFailures(KR);
        assertThat(service.failedBooks(KR, kr)).isEmpty();
        assertThat(service.hasNewObservation(KR, kr)).as("기억을 지우면 같은 관측치로 한 번 더").isTrue();
    }

    @Test
    @DisplayName("리스크 점검 정기 실행은 시장마다 그 시장 저장본을 읽어 그 시장 책에만 적용하고, 그 시장 이름(kr.risk)과 그 시장 달력으로 기록한다")
    void riskJobRunsEachMarketSeparately() {
        twoMarkets(store);
        when(marketData.quotes(market(US))).thenReturn(Optional.of(usQuotes(MON_INTRADAY)));
        when(marketData.quotes(market(KR))).thenReturn(Optional.of(krQuotes()));
        PaperRiskJob job = new PaperRiskJob(store, PaperFixtures.quietReader(), marketData, ledger,
                PaperFixtures.config(), PaperFixtures.MAPPER, Clock.fixed(MON_INTRADAY.plusSeconds(30), ZoneOffset.UTC),
                List.of(US, KR));

        job.scheduledRun();

        assertThat(store.jobRuns).extracting(run -> run.job()).containsExactly("risk", "kr.risk");
        assertThat(store.jobRuns.get(0).detail().path("booksProcessed").toString()).isEqualTo("[\"" + US_BOOK + "\"]");
        assertThat(store.jobRuns.get(1).detail().path("booksProcessed").toString()).isEqualTo("[\"" + KR_BOOK + "\"]");
        assertThat(store.jobRuns.get(1).detail().path("session").asString()).as("한국 달력의 세션(미국 달력이면 10-23)")
                .isEqualTo("2026-10-26");
        assertThat(store.jobRuns.get(1).detail().path("finalClose").asBoolean()).as("한국 달력의 확정 판정").isTrue();
        assertThat(store.fillsOf(US_BOOK)).extracting(fill -> fill.ticker()).containsExactly("AAA");
        assertThat(store.fillsOf(KR_BOOK)).extracting(fill -> fill.ticker()).containsExactly("000660");

        // 한 시장의 '저장본 없음'이 다른 시장을 막지 않음 — 안내 문구는 그 시장의 데이터셋·태스크
        when(marketData.quotes(market(KR))).thenReturn(Optional.empty());
        assertThat(job.runNow(KR).skippedReason()).contains(TestKrMarket.QUOTES_DATASET)
                .contains(TestKrMarket.QUOTES_TASK);
        verify(marketData, never()).quotes();
    }

    @Test
    @DisplayName("사후 체결은 미국 책만 — 한국 책을 넣으면 아무것도 쓰지 않고 거절(한국은 출발일 사후 체결 없음, 명세 K28)")
    void backfillIsUsOnly() {
        Book krBook = new Book(KR_BOOK, PaperBooks.KIND_BENCHMARK, KR_BOOK, 100_000_000, null, PaperBooks.NOT_STARTED,
                PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW);
        store.books.put(KR_BOOK, krBook);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> ledger.backfill(new PaperLedgerService.BackfillRequest(
                        krBook, FRI, "BENCHMARK", null, 100_000_000, 100_000_000,
                        List.of(new PaperLedgerService.BackfillLeg("069500", "BUY", 100.0, null, null)),
                        java.util.Map.of("069500", new PaperMarketData.SourcedClose(40_000, "test")),
                        PaperSettings.defaults())))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining(KR_BOOK);
        assertThat(store.ordersOf(KR_BOOK)).isEmpty();
        assertThat(store.fillsOf(KR_BOOK)).isEmpty();
        assertThat(store.positions(KR_BOOK)).isEmpty();
        assertThat(store.books.get(KR_BOOK)).as("운용·출발일로 바뀌지 않음").isEqualTo(krBook);
        assertThat(store.navSeries(KR_BOOK)).isEmpty();
    }

    @Test
    @DisplayName("트레일링 스탑 뒤 재진입 금지는 그 시장 달력의 거래일로 센다 — 미국 추수감사절(11-26)이 낀 20거래일이 시험용 한국 책에서는 하루 이르게 끝남")
    void stopLockoutCountsThatMarketsTradingDays() {
        LocalDate tue = LocalDate.of(2026, 11, 24);
        LocalDate wed = LocalDate.of(2026, 11, 25);
        Instant krTuesday = Instant.parse("2026-11-24T12:00:00Z");
        Instant krWednesday = Instant.parse("2026-11-25T12:00:00Z");   // 서울 21:00 — 그날 세션의 확정 종가 뒤
        store.books.put(KR_BOOK, TestKrMarket.book(KR_BOOK, 100_000_000, FRI));
        store.states.put(KR_BOOK, new BookState(KR_BOOK, 30_000_000, 109_000_000, 79_000_000, 72.4771, krTuesday,
                krTuesday, tue, null));
        position(store, KR_BOOK, "005930", 1_000, 70_000, 80_000, 79_000.0, tue, 79_000);

        // 최고가 80,000 → 70,000(−12.5%)이라 스탑 8%에 걸림
        Outcome outcome = ledger.process(KR, quotes(krWednesday, bar("005930", tue, 79_000, wed, 70_000)));

        assertThat(outcome.errors()).isEmpty();
        assertThat(outcome.stopped()).isEqualTo(1);
        int days = PaperSettings.DEFAULT_LOCKOUT_TRADING_DAYS;
        assertThat(store.lockouts(KR_BOOK)).singleElement().satisfies(lockout -> {
            assertThat(lockout.ticker()).isEqualTo("005930");
            assertThat(lockout.untilTradingDate()).as("서울 평일 20거래일(미국 달력이면 12-24)")
                    .isEqualTo(LocalDate.of(2026, 12, 23)).isEqualTo(KR.calendar().addTradingDays(wed, days));
        });
        assertThat(US.calendar().addTradingDays(wed, days)).as("시험 전제: 같은 날·같은 거래일 수가 미국 달력으로는 다른 날")
                .isEqualTo(LocalDate.of(2026, 12, 24));
    }

    @Test
    @DisplayName("관측치·이력은 그 시장의 데이터셋에서 읽는다 — 미국 판(옛 시그니처)은 paper.quotes·equity_close 그대로")
    void marketDataReadsMarketDatasets() {
        com.macrodash.read.StoreReader reader = mock(com.macrodash.read.StoreReader.class);
        com.macrodash.store.StoreRepository repository = mock(com.macrodash.store.StoreRepository.class);
        PaperMarketData real = new PaperMarketData(reader, repository, Clock.fixed(KR_EVENING, ZoneOffset.UTC));
        when(reader.read(any(), org.mockito.ArgumentMatchers.anyLong(), any())).thenReturn(Optional.empty());

        real.quotes(KR);
        real.quotes();
        real.history(KR, List.of("005930"), FRI, MON);
        real.history(List.of("AAA"), FRI, MON);

        verify(reader).read(org.mockito.ArgumentMatchers.eq(TestKrMarket.QUOTES_DATASET),
                org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.eq(TestKrMarket.QUOTES_TASK));
        verify(reader).read(org.mockito.ArgumentMatchers.eq("paper.quotes"), org.mockito.ArgumentMatchers.anyLong(),
                org.mockito.ArgumentMatchers.eq("paper_quotes"));
        verify(repository).readTimeseriesColumns(TestKrMarket.HISTORY_DATASET, List.of("005930"), FRI, MON);
        verify(repository).readTimeseriesColumns("equity_close", List.of("AAA"), FRI, MON);
    }

    /** 이 클래스의 고정 날짜가 가정과 맞는지(10-26 월 21:00 KST = 미국 개장 전). */
    @Test
    @DisplayName("시험 전제: 10-26 21:00 KST는 시험용 한국 달력으로 그날 세션·확정, 미국 달력으로 직전 세션(10-23)·미확정")
    void premise() {
        assertThat(KR.calendar().currentOrLastSession(KR_EVENING)).isEqualTo(MON);
        assertThat(KR.isFinal(MON, KR_EVENING)).isTrue();
        assertThat(US.calendar().currentOrLastSession(KR_EVENING)).isEqualTo(LocalDate.of(2026, 10, 23));
        assertThat(US.isFinal(MON, KR_EVENING)).isFalse();
    }

    @Test
    @DisplayName("시장별 설정 읽기(C1a): 한국 책 장부는 그 시장 키(kr.)의 스탑 비율·재진입 금지·슬리피지·현금성을 쓴다 — 설정 루트(미국)의 8%·20거래일·5bp·SHY가 새면 현금성 153130과 −11% 종목에 가짜 스탑이 난다")
    void ledgerReadsThatMarketsSettings() {
        tools.jackson.databind.node.ObjectNode body =
                (tools.jackson.databind.node.ObjectNode) PaperFixtures.settings(store).defaultsJson();
        tools.jackson.databind.node.ObjectNode kr = body.putObject("kr");
        kr.put("trailingStopPct", 12).put("lockoutTradingDays", 10).put("slippageBp", 2);
        kr.putArray("cashLikeTickers").add("153130");
        store.initSettingsIfAbsent(body);
        store.books.put(KR_BOOK, TestKrMarket.book(KR_BOOK, 100_000_000, FRI));
        Instant krFriday = Instant.parse("2026-10-23T13:30:00Z");
        store.states.put(KR_BOOK, new BookState(KR_BOOK, 80_000_000, 100_000_000, 20_000_000, 20, krFriday, krFriday,
                FRI, null));
        position(store, KR_BOOK, "005930", 100, 75_000, 80_000, 72_000.0, FRI, 72_000);    // 최고가 대비 −11.25%
        position(store, KR_BOOK, "000660", 10, 190_000, 200_000, 180_000.0, FRI, 180_000);  // −15%
        position(store, KR_BOOK, "153130", 100, 110_000, 120_000, 105_000.0, FRI, 105_000); // −16.7%, 현금성
        Quotes quotes = quotes(KR_EVENING, bar("005930", FRI, 72_000, MON, 71_000),
                bar("000660", FRI, 180_000, MON, 170_000), bar("153130", FRI, 105_000, MON, 100_000));

        Outcome outcome = ledger.process(KR, quotes);

        assertThat(outcome.errors()).isEmpty();
        assertThat(outcome.stopped()).as("kr.trailingStopPct 12% — −15%만, 현금성 153130은 스탑 없음").isEqualTo(1);
        assertThat(store.fillsOf(KR_BOOK)).singleElement().satisfies(fill -> {
            assertThat(fill.ticker()).isEqualTo("000660");
            assertThat(fill.slippageBp()).as("kr.slippageBp").isEqualTo(2);
            assertThat(fill.price()).isEqualTo(169_966.0);
        });
        assertThat(store.lockouts(KR_BOOK)).singleElement().satisfies(lockout -> assertThat(
                lockout.untilTradingDate()).as("kr.lockoutTradingDays 10 — 그 시장 달력으로")
                .isEqualTo(com.macrodash.analytics.TrailingStop.lockoutUntil(KR.calendar(), MON, 10)));
        assertThat(store.positions(KR_BOOK)).extracting(p -> p.ticker()).containsExactlyInAnyOrder("005930", "153130");
    }
}
