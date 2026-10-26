package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperMarketData.SourcedClose;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.StartPrice;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 관리 — 초기화(네 책·벤치마크 사후 체결)·일시정지·리셋.
 */
class PaperAdminServiceTest {

    /** 출발일 다음 날 아침(KST 토요일 정오) — 금요일 종가가 확정된 뒤. */
    private static final Clock AFTER_START = Clock.fixed(Instant.parse("2026-10-24T03:00:00Z"), ZoneOffset.UTC);

    private FakePaperStore store;
    private PaperMarketData marketData;
    private PaperLedgerService ledger;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        when(marketData.sourcedCloseOn(anyString(), any())).thenReturn(Optional.empty());
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.settings(store), PaperFixtures.MAPPER);
    }

    private PaperAdminService admin(Clock clock) {
        return admin(clock, PaperFixtures.config());
    }

    private PaperAdminService admin(Clock clock, PaperConfig config) {
        return new PaperAdminService(store, marketData, PaperFixtures.quietReader(), PaperFixtures.settings(store),
                ledger, config, PaperFixtures.MAPPER, clock);
    }

    private void closes(double spy, double shy) {
        when(marketData.sourcedCloseOn("SPY", FRI)).thenReturn(Optional.of(new SourcedClose(spy, "equity_close")));
        when(marketData.sourcedCloseOn("SHY", FRI)).thenReturn(Optional.of(new SourcedClose(shy, "equity_close")));
    }

    @Test
    @DisplayName("초기화: 네 책·현금 상태·설정 행을 만들고, SPY 100% 책을 10-23 종가 × 1.0005로 사후 체결한다(100,000 ÷ 체결가 내림)")
    void initBackfillsBenchmarks() {
        closes(500, 82.5);

        PaperAdminService.InitResult result = admin(AFTER_START).init();

        assertThat(result.created()).containsExactly("rules", "claude", "bench_spy", "bench_mix");
        assertThat(result.backfilled()).containsExactly("bench_spy", "bench_mix");
        assertThat(result.skipped()).isEmpty();
        assertThat(result.settingsCreated()).isTrue();
        assertThat(store.settings).isNotNull();
        assertThat(store.settings.body().path("slippageBp").asDouble()).isEqualTo(5);
        assertThat(store.settings.body().path("trackRecord").path("candidateCiks").size()).isEqualTo(27);

        // 체결가 500.25, 100,000 / 500.25 = 199.9 → 199주 = 99,549.75 → 현금 450.25
        List<Fill> spyFills = store.fillsOf("bench_spy");
        assertThat(spyFills).singleElement().satisfies(f -> {
            assertThat(f.ticker()).isEqualTo("SPY");
            assertThat(f.qty()).isEqualTo(199);
            assertThat(f.price()).isEqualTo(500.25);
            assertThat(f.rawPrice()).isEqualTo(500);
            assertThat(f.gross()).isEqualTo(99_549.75);
            assertThat(f.backfill()).isTrue();
            assertThat(f.priceSource()).isEqualTo("equity_close");
            assertThat(f.observedAt()).as("출발일 16:00 ET").isEqualTo(FRI_CLOSE);
            assertThat(f.observationDate()).isEqualTo(FRI);
        });
        Order order = store.ordersOf("bench_spy").get(0);
        assertThat(order.timing()).isEqualTo("BACKFILL");
        assertThat(order.source()).isEqualTo("BENCHMARK");
        assertThat(order.status()).isEqualTo("FILLED");
        assertThat(order.targetWeightPct()).isEqualTo(100.0);
        assertThat(order.asOfTradingDate()).as("출발일 전 거래일").isEqualTo(LocalDate.of(2026, 10, 22));
        assertThat(order.createdAt()).as("체결 관측치보다 앞").isEqualTo(FRI_CLOSE.minusSeconds(1));
        assertThat(order.filledAt()).isEqualTo(FRI_CLOSE);

        BookState spy = store.states.get("bench_spy");
        assertThat(spy.cash()).isEqualTo(450.25);
        assertThat(spy.nav()).as("종가로 평가: 199 × 500 + 450.25").isEqualTo(99_950.25);
        assertThat(spy.lastProcessedCollectedAt()).as("출발일 전 저장본을 나중에 처리하지 않게").isEqualTo(FRI_CLOSE);
        assertThat(spy.lastNavTradingDate()).isEqualTo(FRI);
        assertThat(store.navSeries("bench_spy")).singleElement().satisfies(row -> {
            assertThat(row.tradingDate()).isEqualTo(FRI);
            assertThat(row.pricesFinal()).isTrue();
            assertThat(row.nav()).isEqualTo(99_950.25);
        });
        Book book = store.books.get("bench_spy");
        assertThat(book.status()).isEqualTo("ACTIVE");
        assertThat(book.startedOn()).isEqualTo(FRI);
        Position position = store.positions("bench_spy").get(0);
        assertThat(position.fillRefDate()).isEqualTo(FRI);
        assertThat(position.fillRefClose()).isEqualTo(500);
        assertThat(position.lastPrice()).isEqualTo(500);

        // SPY 60%: 60,000 / 500.25 → 119주, SHY 40%: 40,000 / 82.54125 → 484주
        assertThat(store.fillsOf("bench_mix")).extracting(Fill::ticker, Fill::qty).containsExactly(
                org.assertj.core.groups.Tuple.tuple("SPY", 119), org.assertj.core.groups.Tuple.tuple("SHY", 484));
        assertThat(store.states.get("bench_mix").cash()).isEqualTo(520.285);   // 100,000 − 59,529.75 − 39,949.965

        // 규칙·Claude 책은 현금만 든 '시작 전'
        for (String code : List.of("rules", "claude")) {
            assertThat(store.books.get(code).status()).isEqualTo("NOT_STARTED");
            assertThat(store.books.get(code).startedOn()).isNull();
            assertThat(store.states.get(code).cash()).isEqualTo(100_000);
            assertThat(store.ordersOf(code)).isEmpty();
        }
    }

    @Test
    @DisplayName("초기화는 멱등이다 — 두 번 눌러도 책·체결이 한 번")
    void initIsIdempotent() {
        closes(500, 82.5);
        PaperAdminService admin = admin(AFTER_START);
        admin.init();

        PaperAdminService.InitResult second = admin.init();

        assertThat(second.created()).isEmpty();
        assertThat(second.backfilled()).isEmpty();
        assertThat(second.settingsCreated()).isFalse();
        assertThat(store.fills).hasSize(3);
        assertThat(store.books).hasSize(4);
    }

    @Test
    @DisplayName("종가가 아직 없으면 벤치마크는 시작하지 않고 사유를 남기며, 받은 뒤 다시 누르면 체결한다")
    void initWithoutPricesSkipsWithReason() {
        PaperAdminService admin = admin(AFTER_START);

        PaperAdminService.InitResult result = admin.init();

        assertThat(result.backfilled()).isEmpty();
        assertThat(result.skipped()).extracting(skip -> skip.get("code")).containsExactly("bench_spy", "bench_mix");
        assertThat(result.skipped().get(0).get("reason")).contains("SPY").contains("종가가 아직 없습니다");
        assertThat(store.books.get("bench_spy").status()).isEqualTo("NOT_STARTED");
        assertThat(store.states.get("bench_spy").cash()).isEqualTo(100_000);
        assertThat(store.fills).isEmpty();
        assertThat(store.orders).isEmpty();

        closes(500, 82.5);
        assertThat(admin.init().backfilled()).containsExactly("bench_spy", "bench_mix");
    }

    @Test
    @DisplayName("출발일 장 마감 15분 전에는 사후 체결하지 않는다(그날 봉은 아직 장중 값)")
    void initBeforeFinalCloseSkips() {
        closes(500, 82.5);
        Clock beforeFinal = Clock.fixed(FRI_CLOSE.plusSeconds(5 * 60), ZoneOffset.UTC);

        PaperAdminService.InitResult result = admin(beforeFinal).init();

        assertThat(result.backfilled()).isEmpty();
        assertThat(result.skipped().get(0).get("reason")).contains("15분");
    }

    @Test
    @DisplayName("사후 체결 뒤 출발일 전에 수집한 저장본은 처리하지 않고, 그 뒤 관측치로 평가가 따라간다")
    void observationsAfterBackfill() {
        closes(500, 82.5);
        admin(AFTER_START).init();

        ledger.process(quotes(FRI_CLOSE.minusSeconds(3600), bar("SPY", FRI, 490)));
        assertThat(store.states.get("bench_spy").nav()).isEqualTo(99_950.25);

        ledger.process(quotes(MON_INTRADAY, bar("SPY", FRI, 500, MON, 510), bar("SHY", FRI, 82.5, MON, 82.6)));
        assertThat(store.states.get("bench_spy").nav()).isEqualTo(199 * 510 + 450.25);
        assertThat(store.positions("bench_spy").get(0).fillRefDate()).as("장중 관측치는 기준을 옮기지 않음").isEqualTo(FRI);
    }

    @Test
    @DisplayName("시작 전 책은 운용·일시정지로 바꿀 수 없고, 다른 상태 값·없는 책은 400")
    void statusRules() {
        admin(AFTER_START).init();
        PaperAdminService admin = admin(AFTER_START);

        assertThatThrownBy(() -> admin.setStatus("rules", "ACTIVE")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("시작 전");
        assertThatThrownBy(() -> admin.setStatus("rules", "PAUSED")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> admin.setStatus("bench_spy", "NOT_STARTED")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> admin.setStatus("nope", "PAUSED")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("없는 계좌");
    }

    @Test
    @DisplayName("초기화: 새 책 이름은 정의 그대로(규칙 계좌 · Claude 계좌 · SPY 계좌 · 60/40 계좌)")
    void initUsesDefinitionLabels() {
        admin(AFTER_START).init();

        assertThat(List.of("rules", "claude", "bench_spy", "bench_mix")).extracting(code -> store.books.get(code).label())
                .containsExactly("규칙 계좌", "Claude 계좌", "SPY 계좌", "60/40 계좌");
    }

    /** 2026-10-25 전 초기화가 남긴 행 — 이름만 옛 이름. */
    private void oldBook(String code, String kind, String label) {
        store.insertBookIfAbsent(new Book(code, kind, label, 100_000, null, PaperBooks.NOT_STARTED, FRI_CLOSE));
    }

    @Test
    @DisplayName("이름 맞추기: 옛 이름 그대로인 행만 새 이름으로, 손으로 고친 이름은 그대로, 두 번째는 바꾸는 것 없음")
    void reconcileLabelsRenamesOnlyLegacyLabels() {
        oldBook("rules", PaperBooks.KIND_RULES, "규칙 책");
        oldBook("claude", PaperBooks.KIND_CLAUDE, "Claude 재량 책");
        oldBook("bench_spy", PaperBooks.KIND_BENCHMARK, "SPY 100%");
        oldBook("bench_mix", PaperBooks.KIND_BENCHMARK, "내 60/40");
        PaperAdminService admin = admin(AFTER_START);

        assertThat(admin.reconcileLabels()).containsExactly("rules", "claude", "bench_spy");
        assertThat(List.of("rules", "claude", "bench_spy", "bench_mix")).extracting(code -> store.books.get(code).label())
                .containsExactly("규칙 계좌", "Claude 계좌", "SPY 계좌", "내 60/40");

        assertThat(admin.reconcileLabels()).as("멱등").isEmpty();
        assertThat(store.books.get("rules").label()).isEqualTo("규칙 계좌");
        assertThat(store.books.get("bench_mix").label()).as("모르는 이름은 그대로").isEqualTo("내 60/40");
    }

    @Test
    @DisplayName("이름 맞추기: 초기화를 다시 눌러도 옛 이름을 맞추고(이미 있는 책은 다시 넣지 않음), 장부는 건드리지 않는다")
    void initReconcilesLegacyLabels() {
        oldBook("bench_mix", PaperBooks.KIND_BENCHMARK, "SPY 60% · SHY 40%");
        store.upsertState(new BookState("bench_mix", 100_000, 100_000, 0, 0, null, null, null, null));

        PaperAdminService.InitResult result = admin(AFTER_START).init();

        assertThat(result.created()).doesNotContain("bench_mix");
        assertThat(store.books.get("bench_mix").label()).isEqualTo("60/40 계좌");
        assertThat(store.books.get("bench_mix").createdAt()).as("행은 그대로 — 이름만").isEqualTo(FRI_CLOSE);
    }

    @Test
    @DisplayName("기동 때 이름 맞추기: 옛 이름을 맞추고, 테이블이 없으면 건너뛰며, 실패해도 예외를 내지 않는다")
    void reconcileLabelsOnStartup() {
        oldBook("rules", PaperBooks.KIND_RULES, "규칙 책");

        store.ready = false;
        assertThatCode(() -> admin(AFTER_START).reconcileLabelsOnStartup()).doesNotThrowAnyException();
        assertThat(store.books.get("rules").label()).as("테이블이 없다고 보면 건너뜀").isEqualTo("규칙 책");

        store.ready = true;
        admin(AFTER_START).reconcileLabelsOnStartup();
        assertThat(store.books.get("rules").label()).isEqualTo("규칙 계좌");

        FakePaperStore broken = new FakePaperStore() {
            @Override
            public boolean relabelBook(String code, String from, String to) {
                throw new IllegalStateException("DB 끊김");
            }
        };
        PaperAdminService failing = new PaperAdminService(broken, marketData, PaperFixtures.quietReader(),
                PaperFixtures.settings(broken), ledger, PaperFixtures.config(), PaperFixtures.MAPPER, AFTER_START);
        assertThatCode(failing::reconcileLabelsOnStartup).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("일시정지하면 체결 전 주문을 취소하고, 재개하면 운용 중으로 돌아간다")
    void pauseCancelsPending() {
        closes(500, 82.5);
        PaperAdminService admin = admin(AFTER_START);
        admin.init();
        long id = PaperFixtures.pending(store, "bench_spy", "SPY", "BUY", 1, null, null, "NEXT_OBSERVATION", FRI,
                FRI_CLOSE.plusSeconds(60));

        PaperAdminService.StatusChange paused = admin.setStatus("bench_spy", "PAUSED");
        assertThat(paused.cancelledOrders()).isEqualTo(1);
        assertThat(store.orders.get(id).status()).isEqualTo("CANCELLED");
        assertThat(store.books.get("bench_spy").status()).isEqualTo("PAUSED");

        assertThat(admin.setStatus("bench_spy", "ACTIVE").cancelledOrders()).isZero();
        assertThat(store.books.get("bench_spy").status()).isEqualTo("ACTIVE");
    }

    @Test
    @DisplayName("리셋: 확인 문구가 책 코드와 다르면 400, 같으면 장부를 비우고 벤치마크는 다시 사후 체결한다")
    void resetRebackfills() {
        closes(500, 82.5);
        PaperAdminService admin = admin(AFTER_START);
        admin.init();
        ledger.process(quotes(MON_INTRADAY, bar("SPY", FRI, 500, MON, 510), bar("SHY", FRI, 82.5, MON, 82.6)));
        store.upsertNav(new NavRow("bench_spy", MON, 1, 1, 0, 0, true));

        assertThatThrownBy(() -> admin.reset("bench_spy", "bench_mix")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> admin.reset("bench_spy", null)).isInstanceOf(InvalidRequestException.class);

        PaperAdminService.ResetResult result = admin.reset("bench_spy", "bench_spy");

        assertThat(result.backfilled()).isTrue();
        assertThat(store.fillsOf("bench_spy")).hasSize(1);
        assertThat(store.navSeries("bench_spy")).extracting(NavRow::tradingDate).containsExactly(FRI);
        assertThat(store.states.get("bench_spy").nav()).isEqualTo(99_950.25);
        assertThat(store.books.get("bench_spy").status()).isEqualTo("ACTIVE");
        assertThat(store.fillsOf("bench_mix")).as("다른 책은 그대로").hasSize(2);
    }

    @Test
    @DisplayName("리셋: 규칙·Claude 책은 현금만 든 시작 전 책이 되고, 종가가 없으면 벤치마크도 시작 전으로 남는다")
    void resetWithoutPrices() {
        PaperAdminService admin = admin(AFTER_START);
        admin.init();

        assertThat(admin.reset("claude", "claude").backfilled()).isFalse();
        assertThat(store.books.get("claude").status()).isEqualTo("NOT_STARTED");
        assertThat(store.states.get("claude").cash()).isEqualTo(100_000);

        PaperAdminService.ResetResult bench = admin.reset("bench_mix", "bench_mix");
        assertThat(bench.backfilled()).isFalse();
        assertThat(bench.skippedReason()).contains("종가가 아직 없습니다");
        assertThat(store.books.get("bench_mix").status()).isEqualTo("NOT_STARTED");
        assertThat(store.books.get("bench_mix").startedOn()).isNull();
    }

    @Test
    @DisplayName("초기화는 관측치 유니버스 전체의 출발일 종가를 한 번 얼리고, 사후 체결은 그 값을 쓴다")
    void initFreezesStartPricesForWholeUniverse() {
        when(marketData.quotes(UsPaperMarket.INSTANCE)).thenReturn(Optional.of(quotes(MON_INTRADAY, bar("AAA", FRI, 100, MON, 101),
                bar("SPY", FRI, 500, MON, 505), bar("SHY", FRI, 82.5, MON, 82.6))));
        when(marketData.sourcedClosesOn(anyCollection(), eq(FRI))).thenReturn(Map.of(
                "AAA", new SourcedClose(100, "paper.quotes"), "SPY", new SourcedClose(500, "equity_close"),
                "SHY", new SourcedClose(82.5, "equity_close")));
        PaperAdminService admin = admin(AFTER_START);

        PaperAdminService.InitResult result = admin.init();

        assertThat(result.startPricesCaptured()).isEqualTo(3);
        assertThat(store.startPrices.keySet()).containsExactly("AAA", "SHY", "SPY");
        assertThat(store.startPrices.get("AAA").tradingDate()).isEqualTo(FRI);
        assertThat(result.backfilled()).containsExactly("bench_spy", "bench_mix");
        assertThat(store.fillsOf("bench_spy")).singleElement().satisfies(f -> {
            assertThat(f.rawPrice()).isEqualTo(500);
            assertThat(f.priceSource()).isEqualTo("equity_close");
        });
        verify(marketData, never()).sourcedCloseOn(anyString(), any());   // 얼린 값을 씀

        assertThat(admin.init().startPricesCaptured()).as("이미 얼린 종목은 다시 넣지 않음").isZero();
        assertThat(admin.startClose("AAA")).hasValue(new SourcedClose(100, "paper.quotes"));
    }

    @Test
    @DisplayName("리셋은 얼린 출발일 종가로 다시 사후 체결한다 — 배당락으로 수정 종가가 낮아져도 처음과 같은 수량·현금")
    void resetUsesFrozenStartPrice() {
        closes(500, 82.5);
        PaperAdminService admin = admin(AFTER_START);
        admin.init();
        assertThat(store.startPrices.keySet()).as("사후 체결이 얼림").containsExactly("SHY", "SPY");
        // 몇 주 뒤: 수집기가 auto_adjust로 출발일 종가를 낮게 다시 씀
        closes(497, 82.0);

        assertThat(admin.reset("bench_mix", "bench_mix").backfilled()).isTrue();

        assertThat(store.fillsOf("bench_mix")).extracting(Fill::ticker, Fill::qty, Fill::rawPrice).containsExactly(
                org.assertj.core.groups.Tuple.tuple("SPY", 119, 500.0),
                org.assertj.core.groups.Tuple.tuple("SHY", 484, 82.5));
        assertThat(store.states.get("bench_mix").cash()).isEqualTo(520.285);
        assertThat(store.startPrices.get("SHY").close()).isEqualTo(82.5);
    }

    @Test
    @DisplayName("출발일 마감 15분 전에는 종가를 얼리지 않는다")
    void noFreezeBeforeFinalClose() {
        when(marketData.sourcedClosesOn(anyCollection(), eq(FRI))).thenReturn(Map.of(
                "SPY", new SourcedClose(499, "paper.quotes")));

        PaperAdminService.InitResult result = admin(Clock.fixed(FRI_CLOSE.plusSeconds(5 * 60), ZoneOffset.UTC)).init();

        assertThat(result.startPricesCaptured()).isZero();
        assertThat(store.startPrices).isEmpty();
    }

    @Test
    @DisplayName("테이블이 없으면 초기화하지 않는다")
    void notReady() {
        store.ready = false;
        assertThatThrownBy(() -> admin(AFTER_START).init()).isInstanceOf(IllegalStateException.class);
        assertThat(store.books).isEmpty();
    }

    // ------------------------------------------------------------------ 정기 출발일 종가 얼리기(30분마다)

    /** 관측치 저장본에 AAA·SPY·SHY가 있고, 세 종목의 출발일 종가를 찾을 수 있는 상태. */
    private void universeWithCloses() {
        when(marketData.quotes(UsPaperMarket.INSTANCE)).thenReturn(Optional.of(quotes(MON_INTRADAY, bar("AAA", FRI, 100, MON, 101),
                bar("SPY", FRI, 500, MON, 505), bar("SHY", FRI, 82.5, MON, 82.6))));
        when(marketData.sourcedClosesOn(anyCollection(), eq(FRI))).thenReturn(Map.of(
                "AAA", new SourcedClose(100, "paper.quotes"), "SPY", new SourcedClose(500, "equity_close"),
                "SHY", new SourcedClose(82.5, "equity_close")));
    }

    @SuppressWarnings("unchecked")
    private static ArgumentCaptor<Collection<String>> tickersCaptor() {
        return ArgumentCaptor.forClass(Collection.class);
    }

    @Test
    @DisplayName("정기 얼리기: 꺼져 있거나(PAPER_ENABLED=false) 테이블이 없으면 아무것도 읽지도 얼리지도 않는다")
    void scheduledCaptureNoOpWhenDisabledOrNotReady() {
        universeWithCloses();

        admin(AFTER_START, new PaperConfig(false, FRI, 100_000)).scheduledCaptureStartPrices();
        store.ready = false;
        admin(AFTER_START).scheduledCaptureStartPrices();

        assertThat(store.startPrices).isEmpty();
        verify(marketData, never()).quotes();
        verify(marketData, never()).quotes(any());
        verify(marketData, never()).sourcedClosesOn(anyCollection(), any());
    }

    @Test
    @DisplayName("정기 얼리기: 출발일 마감 + 15분 전에는 묻지도 얼리지도 않고, 정확히 15분이 되면 얼린다")
    void scheduledCaptureWaitsForFinalClose() {
        universeWithCloses();

        admin(Clock.fixed(FRI_CLOSE.plusSeconds(15 * 60 - 1), ZoneOffset.UTC)).scheduledCaptureStartPrices();
        assertThat(store.startPrices).isEmpty();
        verify(marketData, never()).sourcedClosesOn(anyCollection(), any());

        admin(Clock.fixed(FRI_CLOSE.plusSeconds(15 * 60), ZoneOffset.UTC)).scheduledCaptureStartPrices();
        assertThat(store.startPrices.keySet()).containsExactly("AAA", "SHY", "SPY");
    }

    @Test
    @DisplayName("정기 얼리기: 마감 뒤에는 유니버스(관측치 종목 + 벤치마크 종목) 중 아직 없는 종목만 출발일 종가 출처에 묻고, 값·출처를 그대로 얼린다")
    void scheduledCaptureFreezesMissingTickersWithSource() {
        universeWithCloses();
        // SPY는 이미 얼려 둠(초기화 때 등). 다른 출발일의 행(설정을 바꾸기 전 것)은 없는 것으로 봅니다.
        store.insertStartPriceIfAbsent(new StartPrice("SPY", FRI, 499.5, "equity_close", null));
        store.insertStartPriceIfAbsent(new StartPrice("SHY", FRI.minusDays(1), 80, "equity_close", null));
        // 벤치마크 종목은 관측치에 없어도 유니버스에 들어갑니다.
        when(marketData.quotes(UsPaperMarket.INSTANCE)).thenReturn(Optional.of(quotes(MON_INTRADAY, bar("AAA", FRI, 100, MON, 101))));

        admin(AFTER_START).scheduledCaptureStartPrices();

        ArgumentCaptor<Collection<String>> asked = tickersCaptor();
        verify(marketData).sourcedClosesOn(asked.capture(), eq(FRI));
        assertThat(asked.getValue()).containsExactlyInAnyOrder("AAA", "SHY");
        assertThat(store.startPrices.get("SPY").close()).as("이미 얼린 값은 그대로").isEqualTo(499.5);
        assertThat(store.startPrices.get("AAA")).satisfies(p -> {
            assertThat(p.tradingDate()).isEqualTo(FRI);
            assertThat(p.close()).isEqualTo(100);
            assertThat(p.source()).isEqualTo("paper.quotes");
        });
        assertThat(store.startPrices.get("SHY")).satisfies(p -> {
            assertThat(p.tradingDate()).as("다른 출발일 행은 출발일 값으로 바뀜").isEqualTo(FRI);
            assertThat(p.close()).isEqualTo(82.5);
            assertThat(p.source()).isEqualTo("equity_close");
        });
        assertThat(store.books).as("얼리기만 — 책을 만들거나 사후 체결하지 않음").isEmpty();
        assertThat(store.fills).isEmpty();
    }

    @Test
    @DisplayName("정기 얼리기는 멱등이다 — 다시 돌면 얼린 값은 바뀌지 않고(수정주가로 낮아져도), 다 얼렸으면 다시 묻지 않는다")
    void scheduledCaptureIsIdempotent() {
        universeWithCloses();
        PaperAdminService admin = admin(AFTER_START);
        admin.scheduledCaptureStartPrices();
        // 몇 주 뒤: 배당락으로 수정 종가가 낮게 다시 쓰임
        when(marketData.sourcedClosesOn(anyCollection(), eq(FRI))).thenReturn(Map.of(
                "AAA", new SourcedClose(99, "equity_close"), "SPY", new SourcedClose(497, "equity_close"),
                "SHY", new SourcedClose(82.0, "equity_close")));

        admin.scheduledCaptureStartPrices();
        admin.scheduledCaptureStartPrices();

        verify(marketData, times(1)).sourcedClosesOn(anyCollection(), any());
        assertThat(store.startPrices.values()).extracting(StartPrice::ticker, StartPrice::close, StartPrice::source)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("AAA", 100.0, "paper.quotes"),
                        org.assertj.core.groups.Tuple.tuple("SHY", 82.5, "equity_close"),
                        org.assertj.core.groups.Tuple.tuple("SPY", 500.0, "equity_close"));
    }

    @Test
    @DisplayName("정기 얼리기: 종가를 못 찾은 종목이 있어도 찾은 종목은 얼리고, 다음 주기에는 못 찾은 종목만 다시 묻는다")
    void scheduledCaptureSkipsMissingTickerAndRetriesIt() {
        universeWithCloses();
        when(marketData.sourcedClosesOn(anyCollection(), eq(FRI))).thenReturn(Map.of(
                "AAA", new SourcedClose(100, "paper.quotes"), "SPY", new SourcedClose(500, "equity_close")));
        PaperAdminService admin = admin(AFTER_START);

        admin.scheduledCaptureStartPrices();
        assertThat(store.startPrices.keySet()).containsExactly("AAA", "SPY");

        when(marketData.sourcedClosesOn(anyCollection(), eq(FRI))).thenReturn(Map.of(
                "SHY", new SourcedClose(82.5, "equity_close")));
        admin.scheduledCaptureStartPrices();

        ArgumentCaptor<Collection<String>> asked = tickersCaptor();
        verify(marketData, times(2)).sourcedClosesOn(asked.capture(), eq(FRI));
        assertThat(asked.getAllValues().get(1)).containsExactly("SHY");
        assertThat(store.startPrices.keySet()).containsExactly("AAA", "SHY", "SPY");
        assertThat(store.startPrices.get("SHY").close()).isEqualTo(82.5);
    }

    @Test
    @DisplayName("정기 얼리기: 종가 조회가 통째로 실패하면 예외를 밖으로 내지 않고 아무것도 얼리지 않으며, 다음 주기에 다시 한다")
    void scheduledCaptureSwallowsFailureAndRetries() {
        universeWithCloses();
        when(marketData.sourcedClosesOn(anyCollection(), eq(FRI)))
                .thenThrow(new IllegalStateException("db down"))
                .thenReturn(Map.of("AAA", new SourcedClose(100, "paper.quotes"),
                        "SPY", new SourcedClose(500, "equity_close"), "SHY", new SourcedClose(82.5, "equity_close")));
        PaperAdminService admin = admin(AFTER_START);

        assertThatCode(admin::scheduledCaptureStartPrices).doesNotThrowAnyException();
        assertThat(store.startPrices).isEmpty();

        admin.scheduledCaptureStartPrices();
        assertThat(store.startPrices.keySet()).containsExactly("AAA", "SHY", "SPY");
    }

    // ------------------------------------------------------------------ 시장 문맥(2단계 명세 §9 A6)
    @Test
    @DisplayName("시장 문맥(A6): 초기화는 그 시장 책 정의로 책을 만들고 책 행에 시장·통화를 적음(미국 US·USD) — 초기 현금·출발일이 미국 설정뿐이라 다른 시장 초기화는 아무것도 쓰지 않고 거절")
    void initPerMarket() {
        closes(500, 82.5);
        PaperAdminService admin = admin(AFTER_START);

        assertThatThrownBy(() -> admin.init(TestKrMarket.INSTANCE)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("C1");
        assertThat(store.books).isEmpty();
        assertThat(store.settings).isNull();

        admin.init();
        assertThat(store.books.values()).extracting(Book::market, Book::currency).containsOnly(
                org.assertj.core.groups.Tuple.tuple("US", "USD"));
        assertThat(store.books).containsOnlyKeys("rules", "claude", "bench_spy", "bench_mix");
    }

    @Test
    @DisplayName("시장 문맥(A6): 다른 시장 책의 리셋은 그 책만 현금 상태로 — 벤치마크 다시 사후 체결은 미국 책만(한국은 출발일 사후 체결 없음, K28)")
    void resetOfOtherMarketBookDoesNotBackfill() {
        closes(500, 82.5);
        PaperAdminService admin = admin(AFTER_START);
        admin.init();
        String krBook = TestKrMarket.CLAUDE_BOOK;
        store.books.put(krBook, new Book(krBook, PaperBooks.KIND_BENCHMARK, "시험용 한국 벤치마크", 100_000_000, FRI,
                PaperBooks.ACTIVE, FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(krBook, new BookState(krBook, 1_000, 100_000_000, 99_999_000, 99.99, null, null, null, null));
        int usFills = store.fills.size();

        PaperAdminService.ResetResult result = admin.reset(krBook, krBook);

        assertThat(result.backfilled()).isFalse();
        assertThat(result.skippedReason()).isNull();
        assertThat(store.books.get(krBook).status()).isEqualTo(PaperBooks.NOT_STARTED);
        assertThat(store.states.get(krBook).cash()).isEqualTo(100_000_000);
        assertThat(store.fills).hasSize(usFills);
        assertThat(store.books.get("bench_spy").status()).isEqualTo(PaperBooks.ACTIVE);
    }
}
