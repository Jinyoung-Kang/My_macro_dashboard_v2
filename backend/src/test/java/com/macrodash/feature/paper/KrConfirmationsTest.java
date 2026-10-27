package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.KrxCosts;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.FillConfirmation;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 금융위 확정 조정(2단계 명세 §4-1·§5 '확정 조정'·K29, 결정 d7·d14 — C3, {@link KrConfirmations}): 실제 한국 묶음과 그 실행의 달력,
 * 기본 설정 본문의 한국 키(수수료 1.5bp·슬리피지 5bp·2026 세율)로 장부를 돌려 잠정 체결을 만들고, 금융위 행(가짜 시세 저장본)이 들어오면
 * 체결마다 확정 조정 행 하나·현금·평단·최고가가 움직이는지 봅니다. 체결 행은 그대로입니다.
 */
class KrConfirmationsTest {

    private static final KrPaperMarket KR = KrPaperMarket.INSTANCE;
    private static final String BOOK = PaperBooks.KR_CLAUDE;

    /** 기준 거래일 D = 2026-11-02(월), 체결일 D+1 = 11-03(화), D+2 = 11-04(수). */
    private static final LocalDate D = LocalDate.of(2026, 11, 2);
    private static final LocalDate D1 = LocalDate.of(2026, 11, 3);
    private static final LocalDate D2 = LocalDate.of(2026, 11, 4);
    private static final Instant CREATED = kst("2026-11-02T22:30");
    private static final Instant FETCHED_D1 = kst("2026-11-03T21:57");
    private static final Instant COLLECTED_D1 = kst("2026-11-03T22:01");
    private static final Instant FETCHED_D2 = kst("2026-11-04T21:57");
    private static final Instant COLLECTED_D2 = kst("2026-11-04T22:01");

    private FakePaperStore store;
    private PaperMarketData marketData;
    private PaperLedgerService ledger;
    private final Map<String, String> fscMarkets = new HashMap<>();
    /** 금융위 확정 시세(가짜 시세 저장본이 답함). 비어 있으면 모든 종목이 '모름'. */
    private final Map<String, KrConfirmed.Series> confirmed = new HashMap<>();

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        marketData = mock(PaperMarketData.class);
        when(marketData.fscMarkets(anyCollection())).thenAnswer(invocation -> Map.copyOf(fscMarkets));
        when(marketData.krConfirmed(anyCollection(), anyCollection(), org.mockito.ArgumentMatchers.any()))
                .thenAnswer(invocation -> new KrConfirmed(confirmed));
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        fscMarkets.put("005930", "KOSPI");
        fscMarkets.put("000660", "KOSPI");
    }

    // ------------------------------------------------------------------ 도우미
    private MarketRun run() {
        JsonNode body = store.settings.body();
        return new MarketRun(KR, KR.openCalendar(KrFixtures.inputs(body, KrFixtures.holidays(2026, 2027))),
                store.settings);
    }

    private Outcome process(KrFixtures.Payload payload, Instant collectedAt) {
        Quotes quotes = KrQuotes.parse(payload.snapshot(collectedAt)).orElseThrow();
        return ledger.process(run(), quotes);
    }

    private Outcome confirm() {
        return ledger.confirm(run());
    }

    private void book(double cash) {
        store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_CLAUDE, BOOK, 100_000_000, D, PaperBooks.ACTIVE, CREATED, "KR",
                "KRW"));
        store.states.put(BOOK, new BookState(BOOK, cash, cash, 0, 0, null, null, null, null));
    }

    private long order(String ticker, String side, int qty, LocalDate asOf, Instant created) {
        return store.insertOrder(new Order(0, BOOK, null, ticker, side, qty, null, null, PaperBooks.NEXT_OPEN, "CLAUDE",
                "PENDING", null, null, asOf, created, asOf.plusDays(4), null));
    }

    /** D+1 밤 저장본 — D·D+1 봉, D+1 봉의 1분봉 09:01 시가 {@code open}(일봉 시가·종가는 다른 값). */
    private static KrFixtures.Payload nightD1(String ticker, double open) {
        KrFixtures.Payload payload = new KrFixtures.Payload(D1);
        payload.code(ticker, FETCHED_D1).bar(D, open, open, 1_000_000).bar(D1, open + 500, open + 100, 900_000)
                .minute("OK", "09:01", open, 50_000);
        return payload;
    }

    /** 금융위 한 종목 — 그 데이터셋 최신 기준일과 행들(주식시세 {@code FSC}·증권상품시세 {@code FSC_ETF}). */
    private void fsc(String ticker, String source, LocalDate latest, KrConfirmed.Day... days) {
        TreeMap<LocalDate, KrConfirmed.Day> map = new TreeMap<>();
        for (KrConfirmed.Day day : days) {
            map.put(day.date(), day);
        }
        confirmed.put(ticker, new KrConfirmed.Series(source, latest, map));
    }

    /** 금융위 한 기준일 — 시가(mkp)·종가·거래량·시장 구분. */
    private static KrConfirmed.Day day(LocalDate date, Long open, long close, long volume, String market) {
        return new KrConfirmed.Day(date, BigDecimal.valueOf(close), volume, null, open == null ? null : BigDecimal.valueOf(open),
                market);
    }

    private Fill onlyFill() {
        assertThat(store.fillsOf(BOOK)).hasSize(1);
        return store.fillsOf(BOOK).get(0);
    }

    private Position position(String ticker) {
        return store.positions(BOOK).stream().filter(p -> p.ticker().equals(ticker)).findFirst().orElseThrow();
    }

    private double cash() {
        return store.states.get(BOOK).cash();
    }

    // ------------------------------------------------------------------ §5 손계산
    @Test
    @DisplayName("§5 매수 10주 잠정 71,300 → 확정 71,200: 확정 조정 한 행(수수료 106·슬리피지 356 그대로, 현금 +1,000, 출처 FSC), 현금·순자산 +1,000, 평단 71,300 → 71,200(가격 차이만큼 — d14), 최고가 = max(확정 체결가, 체결일부터의 금융위 종가), 체결 행은 그대로")
    void buyConfirmation() {
        book(1_000_000);
        order("005930", PaperBooks.BUY, 10, D, CREATED);
        process(nightD1("005930", 71_300), COLLECTED_D1);
        Fill fill = onlyFill();
        assertThat(cash()).isEqualTo(1_000_000 - 713_462);
        assertThat(position("005930").highWatermark()).as("새 보유의 처음 값 = 잠정 체결가").isEqualTo(71_300);
        double navBefore = store.states.get(BOOK).nav();
        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, 71_200L, 71_000, 5_000_000, "KOSPI"));

        Outcome outcome = confirm();

        assertThat(outcome.errors()).isEmpty();
        assertThat(outcome.confirmed()).isEqualTo(1);
        assertThat(store.fillConfirmations(BOOK)).singleElement().satisfies(c -> {
            assertThat(c.fillId()).isEqualTo(fill.id());
            assertThat(c.confirmedPrice()).isEqualByComparingTo("71200");
            assertThat(c.fee()).isEqualByComparingTo("106");
            assertThat(c.slippageCost()).isEqualByComparingTo("356");
            assertThat(c.tax()).isEqualByComparingTo("0");
            assertThat(c.cashDelta()).isEqualByComparingTo("1000");
            assertThat(c.source()).isEqualTo(FillConfirmation.SOURCE_FSC);
        });
        assertThat(cash()).isEqualTo(1_000_000 - 713_462 + 1_000);
        assertThat(store.states.get(BOOK).nav()).as("순자산도 현금 차이만큼").isEqualTo(navBefore + 1_000);
        Position held = position("005930");
        assertThat(held.avgCost()).as("평단은 체결가로만 — 가격 차이만큼").isEqualTo(71_200);
        assertThat(held.highWatermark()).as("잠정 71,300 → max(확정 71,200, 금융위 D+1 종가 71,000)").isEqualTo(71_200);
        assertThat(held.lastPrice()).as("평가 가격(토스)은 그대로").isEqualTo(71_400);
        assertThat(store.fillsOf(BOOK)).as("체결 행은 고치지 않음").containsExactly(fill);
        assertThat(outcome.notes()).anySatisfy(note -> assertThat(note).contains("확정(FSC 2026-11-03 시가)")
                .contains("잠정 71300원(TOSS_1M_OPEN) → 확정 71200원, 현금 +1000원").contains("설정 v1"));
    }

    @Test
    @DisplayName("§5 코스피 매도 10주 잠정 72,000 → 확정 72,100: 수수료 108·슬리피지 360·거래세 360·농특세 1,081(세금 칸 1,441), 현금 +999 — 매도는 평단을 바꾸지 않음(보유 없음)")
    void kospiSellConfirmation() {
        book(0);
        store.upsertPosition(new Position(BOOK, "005930", 10, 70_000, D, CREATED, 70_000, CREATED, 70_000.0, CREATED, false,
                D, 70_000, null));
        order("005930", PaperBooks.SELL, 10, D, CREATED);
        process(nightD1("005930", 72_000), COLLECTED_D1);
        assertThat(cash()).isEqualTo(718_092);
        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, 72_100L, 72_300, 5_000_000, "KOSPI"));

        confirm();

        assertThat(store.fillConfirmations(BOOK)).singleElement().satisfies(c -> {
            assertThat(c.confirmedPrice()).isEqualByComparingTo("72100");
            assertThat(c.fee()).isEqualByComparingTo("108");
            assertThat(c.slippageCost()).isEqualByComparingTo("360");
            assertThat(c.tax()).as("거래세 360 + 농특세 1,081").isEqualByComparingTo("1441");
            assertThat(c.cashDelta()).isEqualByComparingTo("999");
        });
        assertThat(cash()).isEqualTo(718_092 + 999);
        assertThat(store.positions(BOOK)).isEmpty();
        assertThat(onlyFill().price()).isEqualTo(72_000);
    }

    @Test
    @DisplayName("멱등 — 같은 확정을 두 번 돌리거나 재기동한 장부(새 인스턴스)로 다시 돌려도 체결마다 한 행, 현금은 한 번만")
    void idempotentAcrossRestarts() {
        book(1_000_000);
        order("005930", PaperBooks.BUY, 10, D, CREATED);
        process(nightD1("005930", 71_300), COLLECTED_D1);
        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, 71_200L, 71_000, 5_000_000, "KOSPI"));

        assertThat(confirm().confirmed()).isEqualTo(1);
        Outcome again = confirm();
        PaperLedgerService restarted = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        Outcome afterRestart = restarted.confirm(run());

        assertThat(again.confirmed()).isZero();
        assertThat(again.skippedReason()).isEqualTo("새로 확정할 체결이 없습니다");
        assertThat(afterRestart.confirmed()).isZero();
        assertThat(store.fillConfirmations(BOOK)).hasSize(1);
        assertThat(cash()).isEqualTo(1_000_000 - 713_462 + 1_000);
        assertThat(position("005930").avgCost()).isEqualTo(71_200);
    }

    @Test
    @DisplayName("결정 d7 — 확정 조정은 체결 때 유효했던 설정 판(v1: 수수료 1.5bp·세율 2026-01-01)으로 다시 셈: 체결 뒤 v2(수수료 3bp·세율 시행일 11-04)를 저장해도 수수료 차이가 섞이지 않고 11-03 매도가 '세율 모름'이 되지 않음")
    void fillTimeSettingsVersion() {
        book(0);
        store.upsertPosition(new Position(BOOK, "005930", 10, 70_000, D, CREATED, 70_000, CREATED, 70_000.0, CREATED, false,
                D, 70_000, null));
        order("005930", PaperBooks.SELL, 10, D, CREATED);
        process(nightD1("005930", 72_000), COLLECTED_D1);
        store.dbNow = kst("2026-11-04T09:00");
        ObjectNode next = (ObjectNode) store.settings.body().deepCopy();
        ((ObjectNode) next.path("kr")).put("commissionBp", 3);
        ((ObjectNode) next.path("kr").path("tax")).put("effectiveFrom", "2026-11-04");
        assertThat(store.saveSettings(next, java.util.List.of("kr.commissionBp", "kr.tax.effectiveFrom"))).isEqualTo(2);
        PaperSettings current = PaperSettings.from(next, KR);
        assertThatThrownBy(() -> KrxCosts.fill(com.macrodash.analytics.PaperLedger.Side.SELL, KrxCosts.Instrument.KOSPI, D1,
                10, BigDecimal.valueOf(72_100), current.costRates().rates(current.slippageBp())))
                .as("지금 판(v2)으로 셌다면 세율 모름").hasMessageContaining("세율 모름");
        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, 72_100L, 72_300, 5_000_000, "KOSPI"));

        Outcome outcome = confirm();

        assertThat(outcome.errors()).isEmpty();
        assertThat(store.fillConfirmations(BOOK)).singleElement().satisfies(c -> {
            assertThat(c.fee()).as("v1 수수료 1.5bp — v2의 3bp(216)가 아님").isEqualByComparingTo("108");
            assertThat(c.cashDelta()).as("가격 차이만").isEqualByComparingTo("999");
        });
        assertThat(outcome.notes()).anySatisfy(note -> assertThat(note).contains("설정 v1").doesNotContain("주의"));
    }

    @Test
    @DisplayName("체결 뒤 같은 종목을 더 사도 평단이 원가 합 기준으로 맞음 — 71,300 10주 + 72,000 10주(평단 71,650) → 첫 체결 확정 71,200: 71,600 → 둘째 확정 72,050: 71,625(= (712,000 + 720,500) ÷ 20), 최고가는 그 보유를 연 체결만 다시 셈")
    void averageAcrossLaterBuys() {
        book(2_000_000);
        order("005930", PaperBooks.BUY, 10, D, CREATED);
        process(nightD1("005930", 71_300), COLLECTED_D1);
        order("005930", PaperBooks.BUY, 10, D1, kst("2026-11-03T22:30"));
        KrFixtures.Payload d2 = new KrFixtures.Payload(D2);
        d2.code("005930", FETCHED_D2).bar(D1, 71_800, 71_400, 900_000).bar(D2, 72_400, 72_100, 800_000)
                .minute("OK", "09:01", 72_000, 40_000);
        process(d2, COLLECTED_D2);
        assertThat(position("005930").qty()).isEqualTo(20);
        assertThat(position("005930").avgCost()).isEqualTo(71_650);

        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, 71_200L, 71_500, 5_000_000, "KOSPI"));
        confirm();
        assertThat(position("005930").avgCost()).isEqualTo(71_600);
        assertThat(position("005930").highWatermark()).as("그 보유를 연 체결 — max(71,200, 금융위 D+1 종가 71,500)")
                .isEqualTo(71_500);

        fsc("005930", KrConfirmed.SOURCE_FSC, D2, day(D1, 71_200L, 71_500, 5_000_000, "KOSPI"),
                day(D2, 72_050L, 71_900, 4_000_000, "KOSPI"));
        confirm();
        assertThat(store.fillConfirmations(BOOK)).hasSize(2);
        assertThat(position("005930").avgCost()).isEqualTo(71_625);
        assertThat(position("005930").highWatermark()).as("둘째 체결은 그 보유를 열지 않음 — 그대로").isEqualTo(71_500);
    }

    @Test
    @DisplayName("관측치 처리는 확정 조정을 먼저 — 금융위 D+1이 들어온 D+2 밤에 D+1 매수의 현금 +1,000이 D+2 시가 매수 전에 반영돼 4주를 삼(확정 전 현금이면 3주)")
    void processConfirmsBeforeTheObservation() {
        book(1_000_000);
        order("005930", PaperBooks.BUY, 10, D, CREATED);
        process(nightD1("005930", 71_300), COLLECTED_D1);
        assertThat(cash()).isEqualTo(286_538);
        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, 71_200L, 71_000, 5_000_000, "KOSPI"));
        order("000660", PaperBooks.BUY, 4, D1, kst("2026-11-03T22:30"));
        KrFixtures.Payload d2 = new KrFixtures.Payload(D2);
        d2.code("005930", FETCHED_D2).bar(D1, 71_800, 71_400, 900_000).bar(D2, 71_500, 71_300, 800_000)
                .minute("OK", "09:01", 71_400, 40_000);
        d2.code("000660", FETCHED_D2).bar(D1, 71_000, 71_000, 900_000).bar(D2, 71_900, 71_800, 800_000)
                .minute("OK", "09:01", 71_700, 40_000);

        Outcome outcome = process(d2, COLLECTED_D2);

        assertThat(outcome.confirmed()).isEqualTo(1);
        assertThat(outcome.notes().get(0)).as("확정 조정 기록이 앞").contains("확정(FSC 2026-11-03 시가)");
        Fill second = store.fillsOf(BOOK).stream().filter(f -> f.ticker().equals("000660")).findFirst().orElseThrow();
        assertThat(second.qty()).as("유출 286,986 ≤ 확정 현금 287,538(확정 전 286,538이면 3주)").isEqualTo(4);
        assertThat(cash()).isEqualTo(287_538 - 286_986);
    }

    @Test
    @DisplayName("ETF '금융위 확정 미보정'은 증권상품시세가 그날을 냈는데 그 종목 행이 없을 때만 — 그날을 아직 내지 않았으면 조용히 기다림, 행이 들어오면 FSC_ETF로 확정(069500 400주 95,000 → 94,950, 현금 +20,013)")
    void etfUncorrectedOnlyWhenTheRowIsMissing() {
        book(40_000_000);
        order("069500", PaperBooks.BUY, 400, D, CREATED);
        KrFixtures.Payload payload = new KrFixtures.Payload(D1);
        payload.etf("069500", FETCHED_D1).bar(D, 94_000.0, 94_500.0, 1_000_000).bar(D1, 95_100.0, 95_400.0, 900_000)
                .minute("OK", "09:01", 95_000.0, 30_000);
        process(payload, COLLECTED_D1);

        fsc("069500", KrConfirmed.SOURCE_FSC_ETF, D);
        Outcome waiting = confirm();
        assertThat(waiting.confirmed()).isZero();
        assertThat(waiting.notes()).as("증권상품시세가 D+1을 아직 내지 않음 — 미보정 아님").isEmpty();

        fsc("069500", KrConfirmed.SOURCE_FSC_ETF, D1);
        Outcome missing = confirm();
        assertThat(missing.confirmed()).isZero();
        assertThat(missing.notes()).singleElement().satisfies(note -> assertThat(note)
                .contains("금융위 확정 미보정(ETF) — 증권상품시세 2026-11-03 행 없음(최신 기준일 2026-11-03)"));
        assertThat(store.fillConfirmations(BOOK)).isEmpty();

        fsc("069500", KrConfirmed.SOURCE_FSC_ETF, D1, day(D1, 94_950L, 95_400, 3_000_000, null));
        assertThat(confirm().confirmed()).isEqualTo(1);
        assertThat(store.fillConfirmations(BOOK)).singleElement().satisfies(c -> {
            assertThat(c.source()).isEqualTo(FillConfirmation.SOURCE_FSC_ETF);
            assertThat(c.fee()).isEqualByComparingTo("5697");
            assertThat(c.slippageCost()).isEqualByComparingTo("18990");
            assertThat(c.cashDelta()).isEqualByComparingTo("20013");
        });
        assertThat(cash()).isEqualTo(40_000_000 - 38_024_700 + 20_013);
    }

    @Test
    @DisplayName("확정가 칸이 비면(그날 금융위 시가 없음 — 거래 없던 날·시가 칸 전 저장본) 행을 쓰지 않고 사유만, 다음 주기에 다시")
    void missingOpenLeavesTheFillProvisional() {
        book(1_000_000);
        order("005930", PaperBooks.BUY, 10, D, CREATED);
        process(nightD1("005930", 71_300), COLLECTED_D1);
        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, null, 71_000, 0, "KOSPI"));

        Outcome outcome = confirm();

        assertThat(outcome.confirmed()).isZero();
        assertThat(outcome.notes()).singleElement().satisfies(note -> assertThat(note)
                .contains("금융위 확정 못 함 — 주식시세 2026-11-03 시가 칸 없음"));
        assertThat(store.fillConfirmations(BOOK)).isEmpty();
        assertThat(cash()).isEqualTo(286_538);
        assertThat(store.unconfirmedFills(BOOK)).hasSize(1);
    }

    @Test
    @DisplayName("결과 JSON의 confirmed는 확정 조정이 있을 때만(0이면 칸 없음 — 미국 수동 실행 응답 그대로)")
    void confirmedFieldOnlyWhenNonZero() {
        Outcome none = new Outcome(1, 0, 0, 0, java.util.List.of("bench_spy"), null, java.util.List.of(),
                java.util.List.of());
        Outcome some = new Outcome(0, 0, 0, 0, java.util.List.of(BOOK), null, java.util.List.of(), java.util.List.of(),
                java.util.List.of(), 2);

        assertThat(PaperFixtures.MAPPER.valueToTree(none).has("confirmed")).isFalse();
        JsonNode json = PaperFixtures.MAPPER.valueToTree(some);
        assertThat(json.path("confirmed").asInt()).isEqualTo(2);
        assertThat(some.after(none).confirmed()).isEqualTo(2);
        assertThat(none.after(some).filled()).as("셈은 관측치 처리 쪽").isEqualTo(1);
        assertThat(none.after(some).confirmed()).isEqualTo(2);
    }

    @Test
    @DisplayName("확정 조정 오류는 그 책만 되돌리고 같은 오류는 다시 올리지 않음(5분마다 같은 기록이 쌓이지 않게) — 수동 실행(기억 지움)은 다시 올림, 미국은 확정 조정이 없음")
    void errorsAreRememberedAndUsHasNoConfirmations() {
        FakePaperStore failing = new FakePaperStore() {
            @Override
            public boolean insertFillConfirmationIfAbsent(FillConfirmation c) {
                throw new IllegalStateException("시험용 쓰기 실패");
            }
        };
        failing.initSettingsIfAbsent(PaperFixtures.settings(failing).defaultsJson());
        store = failing;
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        book(1_000_000);
        order("005930", PaperBooks.BUY, 10, D, CREATED);
        process(nightD1("005930", 71_300), COLLECTED_D1);
        fsc("005930", KrConfirmed.SOURCE_FSC, D1, day(D1, 71_200L, 71_000, 5_000_000, "KOSPI"));

        Outcome first = confirm();
        Outcome second = confirm();
        ledger.forgetFailures(KR);
        Outcome manual = confirm();

        assertThat(first.errors()).singleElement().satisfies(e -> assertThat(e).contains("시험용 쓰기 실패"));
        assertThat(second.errors()).as("같은 오류").isEmpty();
        assertThat(manual.errors()).hasSize(1);
        assertThat(cash()).as("되돌림").isEqualTo(286_538);
        assertThat(ledger.confirm(MarketRun.of(UsPaperMarket.INSTANCE, store)).skippedReason())
                .isEqualTo("확정 조정이 없는 시장입니다(US)");
        assertThat(UsPaperMarket.INSTANCE.confirmsFills()).isFalse();
        assertThat(run().confirmsFills()).isTrue();
    }
}
