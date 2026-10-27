package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 체결(2단계 명세 §4-1·§4-2·§4-3·§5, 결정 d10·d11·d14 — C2b) — 실제 한국 묶음({@link KrPaperMarket})과 그 실행의 {@code KrxCalendar}
 * (천문연 2026·2027 공휴일), 기본 설정 본문의 한국 키(수수료 1.5bp·슬리피지 5bp·2026 세율)로 장부를 돌립니다. 관측치는 계약 1 저장본을
 * 파서({@link KrQuotes})로 읽은 것이고, 금융위 시장 구분은 가짜 시세 저장본이 답합니다.
 */
class KrLedgerTest {

    private static final KrPaperMarket KR = KrPaperMarket.INSTANCE;
    private static final String BOOK = PaperBooks.KR_CLAUDE;

    /** 기준 거래일 D = 2026-11-02(월), 체결일 D+1 = 11-03(화), D+2 = 11-04(수). */
    private static final LocalDate D = LocalDate.of(2026, 11, 2);
    private static final LocalDate D1 = LocalDate.of(2026, 11, 3);
    private static final LocalDate D2 = LocalDate.of(2026, 11, 4);
    /** 주문 생성 = D 22:30 결정. */
    private static final Instant CREATED = kst("2026-11-02T22:30");
    /** D+1 밤 첫 slow — 종목을 받은 시각·저장본 수집 시각. */
    private static final Instant FETCHED_D1 = kst("2026-11-03T21:57");
    private static final Instant COLLECTED_D1 = kst("2026-11-03T22:01");

    private FakePaperStore store;
    private PaperMarketData marketData;
    private PaperLedgerService ledger;
    private final Map<String, String> fscMarkets = new HashMap<>();

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        marketData = mock(PaperMarketData.class);
        when(marketData.fscMarkets(anyCollection())).thenAnswer(invocation -> Map.copyOf(fscMarkets));
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        fscMarkets.put("005930", "KOSPI");
        fscMarkets.put("000660", "KOSPI");
        fscMarkets.put("035720", "KOSPI");
        fscMarkets.put("247540", "KOSDAQ");
    }

    // ------------------------------------------------------------------ 도우미
    /** 그 실행 — 지금 설정 행 + 그 판으로 만든 한국 달력(천문연 2026·2027). */
    private MarketRun run() {
        JsonNode body = store.settings.body();
        return new MarketRun(KR, KR.openCalendar(KrFixtures.inputs(body, KrFixtures.holidays(2026, 2027))),
                store.settings);
    }

    private Outcome process(KrFixtures.Payload payload, Instant collectedAt) {
        Quotes quotes = KrQuotes.parse(payload.snapshot(collectedAt)).orElseThrow();
        return ledger.process(run(), quotes);
    }

    /** 운용 중인 한국 책(현금만, 멱등 키 없음). */
    private void book(String code, String kind, double cash) {
        store.books.put(code, new Book(code, kind, code, 100_000_000, D, PaperBooks.ACTIVE, CREATED, "KR", "KRW"));
        store.states.put(code, new BookState(code, cash, cash, 0, 0, null, null, null, null));
    }

    private long order(String code, String ticker, String side, Integer qty, Double weight, String timing) {
        return store.insertOrder(new Order(0, code, null, ticker, side, qty, weight, null, timing, "CLAUDE", "PENDING",
                null, null, D, CREATED, LocalDate.of(2026, 11, 5), null));
    }

    private long buy(String ticker, int qty) {
        return order(BOOK, ticker, PaperBooks.BUY, qty, null, PaperBooks.NEXT_OPEN);
    }

    private long sell(String ticker, int qty) {
        return order(BOOK, ticker, PaperBooks.SELL, qty, null, PaperBooks.NEXT_OPEN);
    }

    private void holding(String ticker, int qty, double avgCost) {
        store.upsertPosition(new Position(BOOK, ticker, qty, avgCost, D, CREATED, avgCost, CREATED, avgCost, CREATED,
                false, D, avgCost, null));
    }

    /** D+1 밤 저장본에 그 종목 — D·D+1 봉, D+1 봉의 1분봉 09:01 시가 {@code open}(거래량 있음), 일봉 시가는 일부러 다른 값. */
    private static KrFixtures.Entry openedAt(KrFixtures.Payload payload, String ticker, double open) {
        return payload.code(ticker, FETCHED_D1).bar(D, open, open, 1_000_000).bar(D1, open + 500, open + 100, 900_000)
                .minute("OK", "09:01", open, 50_000, "10:01", open + 50, 4_000);
    }

    private Fill onlyFill() {
        assertThat(store.fillsOf(BOOK)).hasSize(1);
        return store.fillsOf(BOOK).get(0);
    }

    private double cash() {
        return store.states.get(BOOK).cash();
    }

    // ------------------------------------------------------------------ §5 비용 손계산(장부 경로)
    @Nested
    @DisplayName("§5 비용 손계산 — 장부가 쓰는 체결 행(체결가 = 관측가, 비용 칸 fee·tax·slippage_cost, 원 미만 절사)과 현금")
    class Costs {

        @Test
        @DisplayName("코스피 매수 10주 71,300 → 수수료 106·슬리피지 356·세금 0, 현금 −713,462, 평단 71,300(체결가만 — d14)")
        void kospiBuy() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 1_000_000);
            buy("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "005930", 71_300);

            Outcome outcome = process(payload, COLLECTED_D1);

            assertThat(outcome.errors()).isEmpty();
            Fill fill = onlyFill();
            assertThat(fill.price()).isEqualTo(71_300).isEqualTo(fill.rawPrice());
            assertThat(fill.priceSource()).isEqualTo(KrQuotes.SOURCE_1M_OPEN);
            assertThat(fill.slippageBp()).as("슬리피지 설정값 기록").isEqualTo(5);
            assertThat(fill.gross()).isEqualTo(713_000);
            assertThat(fill.fee()).isEqualByComparingTo("106");
            assertThat(fill.slippageCost()).isEqualByComparingTo("356");
            assertThat(fill.tax()).isEqualByComparingTo("0");
            assertThat(fill.observationDate()).as("체결 봉 날짜").isEqualTo(D1);
            assertThat(fill.observedAt()).isEqualTo(COLLECTED_D1);
            assertThat(cash()).isEqualTo(1_000_000 - 713_462);
            Position position = store.positions(BOOK).get(0);
            assertThat(position.qty()).isEqualTo(10);
            assertThat(position.avgCost()).as("평단 = 체결가(비용은 비용 칸)").isEqualTo(71_300);
            assertThat(position.openedOn()).isEqualTo(D1);
            assertThat(position.lastPrice()).as("평가 = 그날 토스 종가").isEqualTo(71_400);
            assertThat(store.orders.values()).singleElement()
                    .satisfies(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED));
        }

        @Test
        @DisplayName("코스피 매도 10주 72,000 → 수수료 108·슬리피지 360·세금 1,440(거래세 360 + 농특세 1,080), 현금 +718,092")
        void kospiSell() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holding("005930", 10, 70_000);
            sell("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "005930", 72_000);

            process(payload, COLLECTED_D1);

            Fill fill = onlyFill();
            assertThat(fill.price()).isEqualTo(72_000);
            assertThat(fill.fee()).isEqualByComparingTo("108");
            assertThat(fill.slippageCost()).isEqualByComparingTo("360");
            assertThat(fill.tax()).isEqualByComparingTo("1440");
            assertThat(cash()).isEqualTo(718_092);
            assertThat(store.positions(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("코스닥 매도 37주 18,450 → 수수료 102·슬리피지 341·거래세 1,365·농특세 0, 현금 +680,842")
        void kosdaqSell() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holding("247540", 37, 18_000);
            sell("247540", 37);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "247540", 18_450);

            process(payload, COLLECTED_D1);

            Fill fill = onlyFill();
            assertThat(fill.fee()).isEqualByComparingTo("102");
            assertThat(fill.slippageCost()).isEqualByComparingTo("341");
            assertThat(fill.tax()).isEqualByComparingTo("1365");
            assertThat(cash()).isEqualTo(680_842);
        }

        @Test
        @DisplayName("069500 매수 400주 95,000 → 수수료 5,700·슬리피지 19,000, 현금 −38,024,700 — ETF는 벤치마크 종목이라 금융위 시장 구분 없이")
        void etfBuy() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 40_000_000);
            buy("069500", 400);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.etf("069500", FETCHED_D1).bar(D, 94_000.0, 94_500.0, 1_000_000).bar(D1, 95_000.0, 95_400.0, 900_000)
                    .minute("OK", "09:01", 95_000.0, 30_000);

            Outcome outcome = process(payload, COLLECTED_D1);

            assertThat(outcome.notes()).noneMatch(note -> note.contains("보류"));
            Fill fill = onlyFill();
            assertThat(fill.fee()).isEqualByComparingTo("5700");
            assertThat(fill.slippageCost()).isEqualByComparingTo("19000");
            assertThat(fill.tax()).isEqualByComparingTo("0");
            assertThat(cash()).isEqualTo(40_000_000 - 38_024_700);
        }

        @Test
        @DisplayName("153130 매도 100주 108,000 → 수수료 1,620·슬리피지 5,400·세금 0(ETF), 현금 +10,792,980 — 현금성(설정 목록)이라 ETF")
        void cashLikeSell() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holding("153130", 100, 107_000);
            sell("153130", 100);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.etf("153130", FETCHED_D1).bar(D, 107_900.0, 107_950.0, 50_000).bar(D1, 108_000.0, 108_010.0, 40_000)
                    .minute("OK", "09:01", 108_000.0, 3_000);

            process(payload, COLLECTED_D1);

            Fill fill = onlyFill();
            assertThat(fill.fee()).isEqualByComparingTo("1620");
            assertThat(fill.slippageCost()).isEqualByComparingTo("5400");
            assertThat(fill.tax()).isEqualByComparingTo("0");
            assertThat(cash()).isEqualTo(10_792_980);
        }

        @Test
        @DisplayName("매수 가능 수량: 현금 1,000,000·49,950원·목표 비중 100% → 20주(현금 −999,648, 21주는 −1,049,631로 초과) — 예산은 목표 금액·현금 중 작은 쪽, 둘 다 비용 포함")
        void affordableQuantity() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 1_000_000);
            order(BOOK, "035720", PaperBooks.BUY, null, 100.0, PaperBooks.NEXT_OPEN);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "035720", 49_950);

            Outcome outcome = process(payload, COLLECTED_D1);

            Fill fill = onlyFill();
            assertThat(fill.qty()).isEqualTo(20);
            assertThat(fill.fee()).isEqualByComparingTo("149");
            assertThat(fill.slippageCost()).isEqualByComparingTo("499");
            assertThat(cash()).isEqualTo(1_000_000 - 999_648);
            assertThat(outcome.notes()).as("목표 금액(= 현금) 안이라 cashLimited 아님").noneMatch(n -> n.contains("cashLimited"));

            // 수량 주문 21주는 현금 한도(비용 포함 유출)로 20주에 그치고 근거에 cashLimited.
            book("kr_rules", PaperBooks.KIND_RULES, 1_000_000);
            long id = order("kr_rules", "035720", PaperBooks.BUY, 21, null, PaperBooks.NEXT_OPEN);
            KrFixtures.Payload next = new KrFixtures.Payload(D1);
            openedAt(next, "035720", 49_950);
            process(next, COLLECTED_D1.plusSeconds(60));
            assertThat(store.fillsOf("kr_rules")).singleElement().satisfies(f -> assertThat(f.qty()).isEqualTo(20));
            assertThat(store.orders.get(id).reason().path("cashLimited").asBoolean()).isTrue();
            assertThat(store.orders.get(id).reason().path("requestedQty").asInt()).isEqualTo(21);
        }
    }

    // ------------------------------------------------------------------ 시가 사다리
    @Nested
    @DisplayName("시가 사다리(§4-1·K14) — 갈래마다")
    class Ladder {

        @Test
        @DisplayName("① 1분봉 '개장+1분' 봉 시가가 있으면 반드시 그 값(TOSS_1M_OPEN) — NXT 종목의 토스 일봉 시가(08:00 프리마켓 첫 체결)와 달라도")
        void minuteOpenWins() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            buy("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", FETCHED_D1).bar(D, 214_000.0, 214_000.0, 17_000_000)
                    .bar(D1, 218_000.0, 214_000.0, 17_213_072)
                    .minute("OK", "09:01", 213_500.0, 592_667, "10:01", 214_000.0, 43_523);

            Outcome outcome = process(payload, COLLECTED_D1);

            Fill fill = onlyFill();
            assertThat(fill.price()).isEqualTo(213_500);
            assertThat(fill.priceSource()).isEqualTo(KrQuotes.SOURCE_1M_OPEN);
            assertThat(outcome.notes()).as("사다리를 내려가지 않음 — 경고 없음").noneMatch(n -> n.contains("체결 경고"));
        }

        @Test
        @DisplayName("② 1분봉 개장 봉이 없을 때만 토스 일봉 시가 — NXT 종목은 TOSS_INTEGRATED(잠정), KRX 단독 ETF는 TOSS_DAILY, 사유는 작업 기록과 주문 근거에")
        void dailyOpenOnlyWithoutMinuteBar() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 50_000_000);
            long stock = buy("005930", 10);
            long zero = buy("000660", 1);
            long unasked = buy("035720", 1);
            long etf = buy("069500", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", FETCHED_D1).bar(D, 214_000.0, 214_000.0, 1_000).bar(D1, 218_000.0, 214_000.0, 1_000)
                    .minute("NO_BAR");
            payload.code("000660", FETCHED_D1).bar(D, 500_000, 500_000, 10).bar(D1, 501_000, 502_000, 10)
                    .minute("OK", "09:01", 500_000, 0);
            payload.code("035720", FETCHED_D1).bar(D, 49_000, 49_000, 10).bar(D1, 49_500, 49_600, 10);
            payload.etf("069500", FETCHED_D1).bar(D, 94_000.0, 94_500.0, 10).bar(D1, 95_000.0, 95_400.0, 10)
                    .minute("NO_BAR");

            Outcome outcome = process(payload, COLLECTED_D1);

            Map<String, Fill> fills = new HashMap<>();
            store.fillsOf(BOOK).forEach(f -> fills.put(f.ticker(), f));
            assertThat(fills.get("005930").price()).isEqualTo(218_000);
            assertThat(fills.get("005930").priceSource()).isEqualTo(KrQuotes.SOURCE_INTEGRATED);
            assertThat(fills.get("000660").price()).as("1분봉 거래량 0").isEqualTo(501_000);
            assertThat(fills.get("000660").priceSource()).isEqualTo(KrQuotes.SOURCE_INTEGRATED);
            assertThat(fills.get("035720").price()).as("1분봉을 받지 않은 봉").isEqualTo(49_500);
            assertThat(fills.get("069500").price()).isEqualTo(95_000);
            assertThat(fills.get("069500").priceSource()).as("KRX 단독 봉의 시가").isEqualTo(KrQuotes.SOURCE_DAILY);
            assertThat(store.orders.get(stock).reason().path("fillWarnings").get(0).asString())
                    .contains("NO_BAR").contains("TOSS_INTEGRATED").contains("잠정");
            assertThat(store.orders.get(zero).reason().path("fillWarnings").get(0).asString()).contains("거래량 0");
            assertThat(store.orders.get(unasked).reason().path("fillWarnings").get(0).asString()).contains("받지 않은");
            assertThat(store.orders.get(etf).reason().path("fillWarnings").get(0).asString()).contains("TOSS_DAILY");
            assertThat(outcome.notes()).filteredOn(n -> n.contains("체결 경고")).hasSize(4);
        }

        @Test
        @DisplayName("③ NEXT_CLOSE는 토스 일봉 종가로 체결하지 않음(1분봉 15:30 봉 없음·ALLOW_NEXT_CLOSE=false) — 그 밤 체결 없이 대기, 기준일 + 3거래일 뒤 만료")
        void nextCloseIsNeverFilledFromTheDailyClose() {
            assertThat(KrPaperMarket.ALLOW_NEXT_CLOSE).isFalse();
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long id = order(BOOK, "005930", PaperBooks.BUY, 10, null, PaperBooks.NEXT_CLOSE);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "005930", 70_000);

            Outcome outcome = process(payload, COLLECTED_D1);

            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("체결 기다림").contains("NEXT_CLOSE"));

            // 만료일(11-05) 다음 세션의 관측치 — 체결 전에 만료로 정리됩니다.
            KrFixtures.Payload later = new KrFixtures.Payload(LocalDate.of(2026, 11, 6));
            later.code("005930", kst("2026-11-06T21:57")).bar(LocalDate.of(2026, 11, 6), 70_000, 70_100, 1_000);
            process(later, kst("2026-11-06T22:01"));
            assertThat(store.orders.get(id).status()).isEqualTo("EXPIRED");
        }

        @Test
        @DisplayName("장 시간 변경일(수능일 kr.calendar.openTimeOverrides 10:00~16:30) — 개장 + 1분 = '10:01' 봉 시가, 09:01 봉은 쓰지 않음")
        void openTimeOverrideMovesTheLabel() {
            ObjectNode body = (ObjectNode) store.settings.body();
            ((ObjectNode) body.get("kr").get("calendar")).putObject("openTimeOverrides").putObject("2026-11-19")
                    .put("open", "10:00").put("close", "16:30");
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            store.insertOrder(new Order(0, BOOK, null, "005930", PaperBooks.BUY, 10, null, null, PaperBooks.NEXT_OPEN,
                    "CLAUDE", "PENDING", null, null, LocalDate.of(2026, 11, 18), kst("2026-11-18T22:30"),
                    LocalDate.of(2026, 11, 23), null));
            LocalDate exam = LocalDate.of(2026, 11, 19);
            KrFixtures.Payload payload = new KrFixtures.Payload(exam);
            payload.code("005930", kst("2026-11-19T21:57")).bar(LocalDate.of(2026, 11, 18), 70_000, 70_000, 10)
                    .bar(exam, 72_000, 71_000, 10).minute("OK", "09:01", 69_000, 5, "10:01", 70_500, 5_000);

            process(payload, kst("2026-11-19T22:01"));

            assertThat(onlyFill().price()).isEqualTo(70_500);
            assertThat(onlyFill().priceSource()).isEqualTo(KrQuotes.SOURCE_1M_OPEN);
        }
    }

    // ------------------------------------------------------------------ 체결 조건
    @Nested
    @DisplayName("체결 조건(§4-2 ①~④) — 다음 거래일 가격으로만")
    class Conditions {

        @Test
        @DisplayName("② 기준 거래일 이하 봉으로는 체결하지 않음 — D 밤 저장본(D 봉뿐)은 그 주문보다 늦게 받았어도")
        void barOnOrBeforeBaseDate() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long id = buy("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D);
            payload.code("005930", kst("2026-11-02T23:00")).bar(D, 70_000, 70_100, 1_000).minute("OK", "09:01", 70_000, 9);

            process(payload, kst("2026-11-02T23:01"));

            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        }

        @Test
        @DisplayName("① 주문보다 먼저 받은 종목 항목으로는 체결하지 않음 — 봉 날짜가 기준일 뒤여도(그 종목 fetchedAt ≤ 주문 생성)")
        void entryOlderThanOrder() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            buy("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", CREATED).bar(D, 70_000, 70_100, 1_000).bar(D1, 70_500, 70_600, 1_000)
                    .minute("OK", "09:01", 70_400, 9);

            process(payload, COLLECTED_D1);

            assertThat(store.fillsOf(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("④ 거래량 0 봉(정지일)·이어받은 항목으로는 체결하지 않음 — 다음 관측 봉(D+2)이 오면 그 시가로(첫 관측 봉)")
        void volumeZeroAndCarriedEntries() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long halted = buy("005930", 10);
            long carried = buy("000660", 1);
            KrFixtures.Payload night1 = new KrFixtures.Payload(D1);
            night1.code("005930", FETCHED_D1).bar(D, 70_000, 70_000, 1_000).bar(D1, 70_000, 70_000, 0);
            openedAt(night1, "000660", 500_000).stale();

            process(night1, COLLECTED_D1);

            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(store.orders.get(halted).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(store.orders.get(carried).status()).isEqualTo(PaperBooks.ORDER_PENDING);

            KrFixtures.Payload night2 = new KrFixtures.Payload(D2);
            night2.code("005930", kst("2026-11-04T21:57")).bar(D, 70_000, 70_000, 1_000).bar(D1, 70_000, 70_000, 0)
                    .bar(D2, 69_000, 69_500, 2_000).minute("OK", "09:01", 68_900, 100);
            process(night2, kst("2026-11-04T22:01"));

            Fill fill = onlyFill();
            assertThat(fill.ticker()).isEqualTo("005930");
            assertThat(fill.observationDate()).isEqualTo(D2);
            assertThat(fill.price()).isEqualTo(68_900);
        }

        @Test
        @DisplayName("하룻밤 빠진 뒤의 저장본 — 마지막 봉이 아니라 기준일 뒤 첫 관측 봉(D+1)의 시가로 체결(결정 뒤 첫 실제 체결 가능가)")
        void missedNightStillFillsAtTheNextOpen() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            buy("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D2);
            payload.code("005930", kst("2026-11-04T21:57")).bar(D, 70_000, 70_000, 1_000)
                    .bar(D1, 71_000, 71_200, 1_000).minute("OK", "09:01", 70_800, 50)
                    .bar(D2, 72_000, 72_100, 1_000).minute("OK", "09:01", 71_900, 50);

            process(payload, kst("2026-11-04T22:01"));

            Fill fill = onlyFill();
            assertThat(fill.observationDate()).isEqualTo(D1);
            assertThat(fill.price()).isEqualTo(70_800);
            assertThat(store.positions(BOOK).get(0).lastPrice()).as("평가는 마지막 봉 종가").isEqualTo(72_100);
        }
    }

    // ------------------------------------------------------------------ 1분봉 FAILED(결정 d11)
    @Nested
    @DisplayName("1분봉 FAILED — 기다림(사다리로 내려가지 않음), 끝은 자료: 결정 기한(D+1 밤 → D+2 01:00) 뒤 수집본에도 FAILED면 토스 일봉 시가")
    class FailedMinute {

        private KrFixtures.Payload failed(Instant fetched) {
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", fetched).bar(D, 70_000, 70_000, 1_000).bar(D1, 71_000, 71_200, 1_000)
                    .minute("FAILED");
            return payload;
        }

        @Test
        @DisplayName("기한 전 수집본의 FAILED → 체결 없음(대기·작업 기록에 기다림), 다음 slow가 받은 OK → TOSS_1M_OPEN")
        void waitsThenFillsFromTheMinuteBar() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long id = buy("005930", 10);

            Outcome first = process(failed(FETCHED_D1), COLLECTED_D1);

            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(store.orders.get(id).status()).as("대기 = 결정 게이트 ①에는 '정리 안 됨'").isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(first.notes()).anySatisfy(n -> assertThat(n).contains("체결 기다림").contains("FAILED")
                    .contains("2026-11-04 01:00"));

            KrFixtures.Payload retried = new KrFixtures.Payload(D1);
            retried.code("005930", FETCHED_D1).bar(D, 70_000, 70_000, 1_000).bar(D1, 71_000, 71_200, 1_000)
                    .minute("OK", "09:01", 70_900, 77);
            process(retried, kst("2026-11-03T23:01"));

            assertThat(onlyFill().price()).isEqualTo(70_900);
            assertThat(onlyFill().priceSource()).isEqualTo(KrQuotes.SOURCE_1M_OPEN);
        }

        @Test
        @DisplayName("기한(D+2 01:00) 1분 전 수집본은 아직 기다림, 기한 뒤 수집본에도 FAILED면 토스 일봉 시가(TOSS_INTEGRATED, 잠정) + 사유")
        void fallsDownTheLadderAfterTheDeadline() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long id = buy("005930", 10);

            process(failed(FETCHED_D1), kst("2026-11-04T00:59"));
            assertThat(store.fillsOf(BOOK)).isEmpty();

            Outcome late = process(failed(FETCHED_D1), kst("2026-11-04T01:00"));

            Fill fill = onlyFill();
            assertThat(fill.price()).isEqualTo(71_000);
            assertThat(fill.priceSource()).isEqualTo(KrQuotes.SOURCE_INTEGRATED);
            assertThat(fill.observationDate()).isEqualTo(D1);
            assertThat(store.orders.get(id).reason().path("fillWarnings").get(0).asString())
                    .contains("FAILED").contains("결정 기한 2026-11-04 01:00").contains("TOSS_INTEGRATED");
            assertThat(late.notes()).anySatisfy(n -> assertThat(n).contains("체결 경고"));
        }

        @Test
        @DisplayName("기다림의 끝은 그 실행 설정 판의 결정 기한(kr.decisionDeadlineKst 00:30이면 00:30 뒤 수집본)")
        void deadlineFollowsTheSettings() {
            ((ObjectNode) store.settings.body().get("kr")).put("decisionDeadlineKst", "00:30");
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            buy("005930", 10);

            process(failed(FETCHED_D1), kst("2026-11-04T00:31"));

            assertThat(onlyFill().priceSource()).isEqualTo(KrQuotes.SOURCE_INTEGRATED);
        }
    }

    // ------------------------------------------------------------------ 종목 구분·세율·호가
    @Nested
    @DisplayName("비용을 셀 수 없으면 보류(짐작하지 않음), 호가에 안 맞으면 경고만")
    class Holds {

        @Test
        @DisplayName("금융위 시장 구분이 코넥스·없음이고 ETF 목록에도 없으면 주문 보류(대기 그대로, 작업 기록에 사유) — 다른 주문은 체결")
        void unknownMarketHoldsTheOrder() {
            fscMarkets.put("900110", "KONEX");
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long konex = buy("900110", 10);
            long unknown = buy("123450", 10);
            long kospi = buy("005930", 1);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "900110", 1_000);
            openedAt(payload, "123450", 2_000);
            openedAt(payload, "005930", 70_000);

            Outcome outcome = process(payload, COLLECTED_D1);

            assertThat(store.fillsOf(BOOK)).extracting(Fill::ticker).containsExactly("005930");
            assertThat(store.orders.get(konex).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(store.orders.get(unknown).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(store.orders.get(kospi).status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("900110").contains("보류").contains("KONEX"));
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("123450").contains("보류").contains("없음"));
        }

        @Test
        @DisplayName("매도 체결일이 그 설정 판의 세율 시행일보다 이르면 '세율 모름'으로 보류(KrxCosts가 던지기 전에 — 책을 되돌리지 않음), 매수는 세금이 없어 체결")
        void taxUnknownHoldsSells() {
            ((ObjectNode) store.settings.body().get("kr").get("tax")).put("effectiveFrom", "2026-11-04");
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            holding("005930", 10, 70_000);
            long sold = sell("005930", 10);
            buy("000660", 1);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "005930", 72_000);
            openedAt(payload, "000660", 500_000);

            Outcome outcome = process(payload, COLLECTED_D1);

            assertThat(outcome.errors()).isEmpty();
            assertThat(store.fillsOf(BOOK)).extracting(Fill::ticker).containsExactly("000660");
            assertThat(store.orders.get(sold).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("세율 모름").contains("2026-11-04"));
        }

        @Test
        @DisplayName("호가 단위에 안 맞는 관측가(71,330원 — 5만~20만 원 호가 100원)는 값 그대로 체결하고 경고만 남김")
        void offTickPriceIsWarnedNotChanged() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long id = buy("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "005930", 71_330);

            Outcome outcome = process(payload, COLLECTED_D1);

            assertThat(onlyFill().price()).isEqualTo(71_330);
            assertThat(store.orders.get(id).reason().path("fillWarnings").get(0).asString())
                    .contains("호가 단위").contains("71330").contains("호가 100원");
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("체결 경고").contains("호가"));
        }
    }

    // ------------------------------------------------------------------ 한 관측치 안 순서
    @Nested
    @DisplayName("한 관측치 안 순서(§4-2) — 시가 매도 → 시가 매수 → 종가 매도 → 종가 매수, 현금성(153130)은 각 묶음 마지막")
    class Ordering {

        @Test
        @DisplayName("시가 매도 대금으로 같은 시가의 매수를 함 — 현금 0에서 시작해도")
        void sellsFundBuysAtTheSameOpen() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holding("000660", 2, 400_000);
            long bought = buy("005930", 10);     // 매수를 먼저 만들어도
            sell("000660", 2);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            openedAt(payload, "000660", 500_000);
            openedAt(payload, "005930", 70_000);

            process(payload, COLLECTED_D1);

            assertThat(store.fillsOf(BOOK)).extracting(Fill::side).containsExactly(PaperBooks.SELL, PaperBooks.BUY);
            assertThat(store.orders.get(bought).status()).isEqualTo(PaperBooks.ORDER_FILLED);
        }

        @Test
        @DisplayName("현금성 매수(153130)는 그 묶음 마지막 — 먼저 만든 현금성 주문이 신호 종목과 현금을 다투지 않음")
        void cashLikeBuysGoLast() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 1_000_000);
            long park = order(BOOK, "153130", PaperBooks.BUY, 9, null, PaperBooks.NEXT_OPEN);
            long signal = buy("005930", 10);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.etf("153130", FETCHED_D1).bar(D, 108_000.0, 108_000.0, 10).bar(D1, 108_000.0, 108_010.0, 10)
                    .minute("OK", "09:01", 108_000.0, 5);
            openedAt(payload, "005930", 70_000);

            process(payload, COLLECTED_D1);

            assertThat(store.fillsOf(BOOK)).extracting(Fill::ticker).containsExactly("005930", "153130");
            assertThat(store.fillsOf(BOOK).get(0).qty()).as("신호 종목은 다 삼").isEqualTo(10);
            assertThat(store.orders.get(signal).status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(store.orders.get(park).reason().path("cashLimited").asBoolean()).as("남는 현금만큼").isTrue();
        }
    }

    // ------------------------------------------------------------------ 순자산·멱등·미국
    @Test
    @DisplayName("밤 순자산 줄 = 그 세션(D+1), 보유가 있으면 잠정(prices_final=false — 금융위 확정은 C3), 같은 저장본은 다시 처리하지 않음")
    void navIsProvisionalAndIdempotent() {
        book(BOOK, PaperBooks.KIND_CLAUDE, 1_000_000);
        buy("005930", 10);
        KrFixtures.Payload payload = new KrFixtures.Payload(D1);
        openedAt(payload, "005930", 71_300);

        process(payload, COLLECTED_D1);

        assertThat(store.navSeries(BOOK)).singleElement().satisfies(row -> {
            assertThat(row.tradingDate()).isEqualTo(D1);
            assertThat(row.pricesFinal()).isFalse();
            assertThat(row.nav()).as("현금 + 10주 × 그날 토스 종가").isEqualTo(1_000_000 - 713_462 + 10 * 71_400.0);
        });
        assertThat(process(payload, COLLECTED_D1).skippedReason()).contains("이미 처리한 관측치");
        assertThat(store.fillsOf(BOOK)).hasSize(1);
    }

    @Test
    @DisplayName("한국 체결 조건은 한국 비용 요율이 없는 설정(미국 판)을 받지 않음 — 시장 판으로 읽은 설정만")
    void termsNeedKoreanCostRates() {
        KrFixtures.Payload payload = new KrFixtures.Payload(D1);
        openedAt(payload, "005930", 70_000);
        Quotes quotes = KrQuotes.parse(payload.snapshot(COLLECTED_D1)).orElseThrow();
        Order order = new Order(1, BOOK, null, "005930", PaperBooks.BUY, 1, null, null, PaperBooks.NEXT_OPEN, "CLAUDE",
                "PENDING", null, null, D, CREATED, null, null);
        MarketRun run = run();
        PaperMarketData.Bar chosen = run.fillBar(order, quotes.bars().get("005930"), COLLECTED_D1, run.calendar(),
                run.settingsBody()).bar();
        assertThat(chosen.date()).isEqualTo(D1);
        assertThat(chosen.kr().choice().price()).isEqualByComparingTo("70000");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> KR.fill(order, chosen, PaperSettings.defaults(),
                        run.calendar()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("비용 요율");
        assertThat(KR.fill(order, chosen, PaperSettings.defaults(KR), run.calendar()).holdReason())
                .as("금융위 시장 구분을 덧붙이지 않은 봉 — 종목 구분 모름").contains("종목 구분 모름");
    }
}
