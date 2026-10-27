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
    /** 금융위 확정 시세(가짜 시세 저장본이 답함 — 종목 → 기준일별 값). 비어 있으면 모든 종목이 '모름'. */
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

    /** 보유 + 그 보유가 반영한 마지막 관측(since 봉 — fill_ref_date·fill_ref_close·fill_ref_volume). 최고가 처음 값 = 평단. */
    private void holdingSince(String code, String ticker, int qty, double avgCost, LocalDate since, double sinceClose,
                              Long sinceVolume) {
        store.upsertPosition(new Position(code, ticker, qty, avgCost, LocalDate.of(2026, 10, 27), CREATED, avgCost, CREATED,
                avgCost, CREATED, false, since, sinceClose, null));
        if (sinceVolume != null) {
            store.updateFillRefVolume(code, ticker, sinceVolume);
        }
    }

    /** 금융위 확정 시세 한 종목 — 그 데이터셋 최신 기준일과 행들(기준일·종가·거래량·상장주식수). */
    private void fsc(String ticker, LocalDate latest, KrConfirmed.Day... days) {
        java.util.TreeMap<LocalDate, KrConfirmed.Day> map = new java.util.TreeMap<>();
        for (KrConfirmed.Day day : days) {
            map.put(day.date(), day);
        }
        confirmed.put(ticker, new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, latest, map));
    }

    private static KrConfirmed.Day fscDay(LocalDate date, long close, long volume, Long listed) {
        return new KrConfirmed.Day(date, java.math.BigDecimal.valueOf(close), volume, listed);
    }

    private Position position(String code, String ticker) {
        return store.positions(code).stream().filter(p -> p.ticker().equals(ticker)).findFirst().orElseThrow();
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

        @Test
        @DisplayName("개장 봉 라벨은 JVM 기본 로캘과 상관없이 ASCII 숫자 — 아랍어(ar-EG)·페르시아어(fa-IR)·태국 숫자(th-TH-u-nu-thai) 로캘에서도 \"09:01\"(수능일 \"10:01\"), 그 로캘의 체결도 TOSS_1M_OPEN")
        void openLabelIgnoresTheDefaultLocale() {
            ((ObjectNode) store.settings.body().get("kr").get("calendar")).putObject("openTimeOverrides")
                    .putObject("2026-11-19").put("open", "10:00").put("close", "16:30");
            java.util.Locale saved = java.util.Locale.getDefault();
            try {
                for (String tag : List.of("ar-EG", "fa-IR", "th-TH-u-nu-thai")) {
                    java.util.Locale.setDefault(java.util.Locale.forLanguageTag(tag));
                    assertThat(KrFills.openLabel(D1, run().calendar())).as(tag).isEqualTo("09:01");
                    assertThat(KrFills.openLabel(LocalDate.of(2026, 11, 19), run().calendar())).as(tag)
                            .isEqualTo("10:01");
                }
                book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
                buy("005930", 10);
                KrFixtures.Payload payload = new KrFixtures.Payload(D1);
                openedAt(payload, "005930", 70_000);

                process(payload, COLLECTED_D1);

                assertThat(onlyFill().priceSource()).as("라벨 조회가 빗나가 사다리를 내려가지 않음")
                        .isEqualTo(KrQuotes.SOURCE_1M_OPEN);
                assertThat(onlyFill().price()).isEqualTo(70_000);
            } finally {
                java.util.Locale.setDefault(saved);
            }
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

    // ------------------------------------------------------------------ 기업행위(K32, 결정 d12 — C2c)
    @Nested
    @DisplayName("기업행위(§4-2 K32·§5) — 3중 조건을 채운 분할·병합만 수량을 고치고, 못 채운 큰 변동·사라진 종목은 '미처리 기업행위'(평가 묶음·스탑 없음·주문 보류)")
    class CorporateActions {

        /** 11-05(목)·11-06(금)·11-09(월)·11-10(화). */
        private final LocalDate thu = LocalDate.of(2026, 11, 5);
        private final LocalDate fri = LocalDate.of(2026, 11, 6);
        private final LocalDate mon2 = LocalDate.of(2026, 11, 9);
        private final LocalDate tue2 = LocalDate.of(2026, 11, 10);

        /** 50:1 분할 꼴 — P(D) 2,650,000원·30만 주·비율 0.02, 정지 D+1(거래량 0), 재상장 D+2 53,000원·비율 1(거래량은 인자). */
        private KrFixtures.Payload splitNight(long postVolume) {
            KrFixtures.Payload payload = new KrFixtures.Payload(D2);
            payload.code("005930", kst("2026-11-04T21:57"))
                    .bar(D, 2_640_000, 2_650_000, 300_000).ratio(0.02)
                    .bar(D1, 2_650_000, 2_650_000, 0).ratio(0.02)
                    .bar(D2, 52_000, 53_000, postVolume).ratio(1.0).minute("OK", "09:01", 52_000, 1_000);
            return payload;
        }

        @Test
        @DisplayName("3중 조건(가격비 ×50·거래량비 ×66.7·순자산 ×1.0)을 채운 50:1 분할 — 수량 10 → 500, 평단·최고가 ÷ 50, 그날 그 종목 주문 보류, since 봉을 재상장 봉으로(다음 밤 다시 고치지 않음)")
        void splitWithAllThreeConditions() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holdingSince(BOOK, "005930", 10, 2_600_000, D, 2_650_000, 300_000L);
            long sell = sell("005930", 5);

            Outcome outcome = process(splitNight(20_000_000), kst("2026-11-04T22:01"));

            assertThat(outcome.errors()).isEmpty();
            assertThat(outcome.splits()).isEqualTo(1);
            Position split = position(BOOK, "005930");
            assertThat(split.qty()).isEqualTo(500);
            assertThat(split.avgCost()).isEqualTo(52_000);
            assertThat(split.highWatermark()).as("최고가도 ÷ 50 — 가짜 스탑이 나지 않게").isEqualTo(52_000);
            assertThat(split.lastPrice()).as("평가 = 재상장 봉 종가").isEqualTo(53_000);
            assertThat(split.splitNote()).contains("2026-11-04 50:1 분할·병합 확인").contains("10주 → 500주");
            assertThat(split.fillRefDate()).as("since 봉 = 이번 관측치의 마지막 관측").isEqualTo(D2);
            assertThat(split.fillRefClose()).isEqualTo(53_000);
            assertThat(store.fillRefVolumes(BOOK)).containsEntry("005930", 20_000_000L);
            assertThat(store.corpActionHolds(BOOK)).as("분할은 미처리 표시가 아님").isEmpty();
            assertThat(store.orders.get(sell).status()).as("그날 그 종목 주문 보류").isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("분할·병합 확인").contains("가격비 ×50.00"))
                    .anySatisfy(n -> assertThat(n).contains("보류").contains("기업행위 분할·병합"));

            // 다음 밤 — 같은 비율 변화를 다시 반영하지 않음(since가 재상장 봉 뒤).
            KrFixtures.Payload next = new KrFixtures.Payload(thu);
            next.code("005930", kst("2026-11-05T21:57")).bar(D1, 2_650_000, 2_650_000, 0).ratio(0.02)
                    .bar(D2, 52_000, 53_000, 20_000_000).bar(thu, 53_100, 53_500, 9_000_000)
                    .minute("OK", "09:01", 53_100, 500);
            Outcome again = process(next, kst("2026-11-05T22:01"));
            assertThat(again.splits()).isZero();
            assertThat(position(BOOK, "005930").qty()).as("매도 5주 뒤 495 — 분할을 두 번 반영하지 않음").isEqualTo(495);
            assertThat(store.orders.get(sell).status()).isEqualTo(PaperBooks.ORDER_FILLED);
        }

        @Test
        @DisplayName("3중 조건 중 거래량비가 모자라면(재상장 거래량 그대로) 미처리 — 보유에 '기업행위 확인 필요'(머리 날짜 = 걸린 날), 수량 그대로, 평가는 since 날짜의 금융위 확정 종가로 묶음, 주문 보류, 다음 밤에도 묶인 채")
        void failedConditionIsUnprocessed() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holdingSince(BOOK, "005930", 10, 2_600_000, D, 2_650_000, 300_000L);
            long sell = sell("005930", 5);
            fsc("005930", D1, fscDay(D, 2_655_000, 120_000, null), fscDay(D1, 2_655_000, 0, null));

            Outcome outcome = process(splitNight(300_000), kst("2026-11-04T22:01"));

            assertThat(outcome.splits()).isZero();
            assertThat(store.corpActionHolds(BOOK)).singleElement().satisfies(hold -> assertThat(hold.reason())
                    .startsWith("2026-11-04 기업행위 확인 필요 — ").contains("3중 조건 불충족(거래량비)"));
            Position held = position(BOOK, "005930");
            assertThat(held.qty()).isEqualTo(10);
            assertThat(held.lastPrice()).as("since 날짜(D)의 금융위 종가 — 거래량 > 0 행").isEqualTo(2_655_000);
            assertThat(held.fillRefDate()).as("since 그대로").isEqualTo(D);
            assertThat(store.orders.get(sell).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("기업행위 확인 필요")
                    .contains("금융위 2026-11-02 종가 2655000원으로 묶음").contains("스탑 없음·주문 보류"));

            KrFixtures.Payload next = new KrFixtures.Payload(thu);
            next.code("005930", kst("2026-11-05T21:57")).bar(D2, 52_000, 53_000, 300_000)
                    .bar(thu, 53_100, 40_000, 9_000_000).minute("OK", "09:01", 53_100, 500);
            Outcome again = process(next, kst("2026-11-05T22:01"));
            assertThat(position(BOOK, "005930").lastPrice()).as("묶인 평가 그대로").isEqualTo(2_655_000);
            assertThat(store.orders.get(sell).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(again.notes()).anySatisfy(n -> assertThat(n).contains("보류").contains("미처리 기업행위 보유"));
            assertThat(again.alerts()).as("걸린 날 뒤 1거래일 — 알림 아님").isEmpty();
        }

        @Test
        @DisplayName("정지 4봉 + 재상장 봉(P가 5봉 창 밖) — 보유 쪽 since 봉(원시 종가·거래량, 결정 d12)을 이어 붙여 분할 확인, since 거래량을 모르면(V15 전 보유) 미처리")
        void fourBarSuspensionResolvedThroughTheSinceBar() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            book(PaperBooks.KR_RULES, PaperBooks.KIND_RULES, 0);
            holdingSince(BOOK, "005930", 10, 2_600_000, D, 2_650_000, 300_000L);
            holdingSince(PaperBooks.KR_RULES, "005930", 10, 2_600_000, D, 2_650_000, null);
            KrFixtures.Payload payload = new KrFixtures.Payload(mon2);
            KrFixtures.Entry entry = payload.code("005930", kst("2026-11-09T21:57"));
            for (LocalDate day : List.of(D1, D2, thu, fri)) {
                entry.bar(day, 2_650_000, 2_650_000, 0).ratio(0.02);
            }
            entry.bar(mon2, 52_000, 53_000, 20_000_000).ratio(1.0).minute("OK", "09:01", 52_000, 1_000);

            Outcome outcome = process(payload, kst("2026-11-09T22:01"));

            assertThat(outcome.errors()).isEmpty();
            assertThat(position(BOOK, "005930").qty()).as("since 봉 P(11-02, 30만 주)로 3중 조건").isEqualTo(500);
            assertThat(position(BOOK, "005930").fillRefDate()).isEqualTo(mon2);
            assertThat(store.corpActionHolds(PaperBooks.KR_RULES)).singleElement().satisfies(hold -> assertThat(hold.reason())
                    .contains("그 전 관측(거래량 > 0 봉)이 창에 없어 3중 조건을 볼 수 없음"));
            assertThat(position(PaperBooks.KR_RULES, "005930").qty()).isEqualTo(10);
        }

        @Test
        @DisplayName("사라진 종목은 토스(이번 응답의 NO_BARS)·금융위(최신 기준일에 행 없음) 둘 다 없을 때만 미처리 — 한쪽만 없거나 모르면 '가격 없음'(price_stale)뿐")
        void vanishedOnlyWhenBothSourcesAnswerAbsent() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holdingSince(BOOK, "000660", 3, 500_000, D, 500_000, 1_000L);
            holdingSince(BOOK, "035720", 3, 50_000, D, 50_000, 1_000L);
            holdingSince(BOOK, "051910", 3, 300_000, D, 300_000, 1_000L);
            holdingSince(BOOK, "005930", 3, 70_000, D, 70_000, 1_000L);
            fsc("000660", D1);                                                  // 최신 기준일 D+1에 행 없음
            fsc("035720", D1, fscDay(D1, 50_500, 900, null));                   // 금융위에는 있음
            fsc("051910", D1);                                                  // 금융위 없음, 토스는 모름(항목 없음)
            KrFixtures.Payload payload = new KrFixtures.Payload(D2);
            payload.code("000660", kst("2026-11-04T21:57")).node.put("status", "NO_BARS");
            payload.code("035720", kst("2026-11-04T21:57")).node.put("status", "NO_BARS");
            ((tools.jackson.databind.node.ArrayNode) payload.payload.get("scope")).add("051910");   // 범위에만 — 호출 실패, 이을 값 없음
            payload.code("005930", kst("2026-11-04T21:57")).bar(D2, 70_000, 70_500, 1_000);

            Outcome outcome = process(payload, kst("2026-11-04T22:01"));

            assertThat(store.corpActionHolds(BOOK)).singleElement().satisfies(hold -> {
                assertThat(hold.ticker()).isEqualTo("000660");
                assertThat(hold.reason()).contains("토스·금융위 모두 종목 없음");
            });
            assertThat(position(BOOK, "035720").priceStale()).as("토스만 없음").isTrue();
            assertThat(position(BOOK, "051910").priceStale()).as("금융위만 없음(토스 모름)").isTrue();
            assertThat(position(BOOK, "005930").priceStale()).isFalse();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("000660").contains("기업행위 확인 필요"));
        }

        @Test
        @DisplayName("보유가 없는 종목(주문만)도 판정 — 정지 중 비율이 바뀌어 재상장 관측을 기다리면(판정 대기) 그날 그 매수 주문만 보류, 수량·표시 없음")
        void orderOnlyTickerPendingHoldsTheBuy() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 10_000_000);
            long buy = buy("005930", 1);
            long other = buy("000660", 1);
            KrFixtures.Payload payload = new KrFixtures.Payload(D2);
            payload.code("005930", kst("2026-11-04T21:57")).bar(D, 2_640_000, 2_650_000, 300_000).ratio(0.02)
                    .bar(D1, 2_650_000, 2_650_000, 0).ratio(0.02).bar(D2, 2_650_000, 2_650_000, 0).ratio(1.0);
            openedAt(payload, "000660", 500_000);

            Outcome outcome = process(payload, kst("2026-11-04T22:01"));

            assertThat(store.orders.get(buy).status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(store.orders.get(other).status()).as("다른 종목은 체결").isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("005930").contains("판정 대기"));
            assertThat(store.corpActionHolds(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("미처리 기업행위 보류가 걸린 날 뒤 5거래일을 넘기면 운영 알림(11-02 월요일에 걸림 → 11-09는 아직, 11-10부터) — Outcome.alerts")
        void alertAfterFiveTradingDays() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            holdingSince(BOOK, "005930", 10, 70_000, D, 70_000, 1_000L);
            store.holdForCorpAction(BOOK, "005930", "2026-11-02 기업행위 확인 필요 — 시험용 사유");

            KrFixtures.Payload monday = new KrFixtures.Payload(mon2);
            monday.code("005930", kst("2026-11-09T21:57")).bar(mon2, 71_000, 72_000, 5_000);
            assertThat(process(monday, kst("2026-11-09T22:01")).alerts()).as("5거래일 — 아직").isEmpty();

            KrFixtures.Payload tuesday = new KrFixtures.Payload(tue2);
            tuesday.code("005930", kst("2026-11-10T21:57")).bar(mon2, 71_000, 72_000, 5_000)
                    .bar(tue2, 72_000, 73_000, 5_000);
            Outcome outcome = process(tuesday, kst("2026-11-10T22:01"));
            assertThat(outcome.alerts()).singleElement().satisfies(alert -> assertThat(alert)
                    .startsWith(BOOK + ": 005930 미처리 기업행위 보류 6거래일째(걸린 날 2026-11-02")
                    .contains("사람이 확인하세요").contains("시험용 사유"));
            assertThat(position(BOOK, "005930").lastPrice()).as("묶인 평가 — 새 봉으로 바꾸지 않음").isEqualTo(70_000);
        }
    }

    // ------------------------------------------------------------------ 트레일링 스탑·최고가(K30 — C2c)
    @Nested
    @DisplayName("트레일링 스탑(§4-2 K30·§5) — 잠정 평가가로 감지 → 다음 날 시가 STOP 주문, 체결 처리 때 확정 D 종가로 다시 판정, 최고가는 KRX 기준가로만")
    class Stops {

        /** 최고가 100,000(8% → 스탑가 92,000)인 보유 10주, since D. */
        private void heldAtHundred(String code) {
            holdingSince(code, "005930", 10, 100_000, D, 100_000, 1_000L);
        }

        /** D+1 밤 — D+1 종가 {@code close}(NXT 주식 → TOSS_INTEGRATED). */
        private KrFixtures.Payload nightD1(double close) {
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.code("005930", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 99_000, close, 2_000)
                    .minute("OK", "09:01", 99_000, 100);
            return payload;
        }

        /** D+2 밤 — D+2 시가(1분봉) {@code open}·종가 {@code close}. */
        private KrFixtures.Payload nightD2(double open, double close) {
            KrFixtures.Payload payload = new KrFixtures.Payload(D2);
            payload.code("005930", kst("2026-11-04T21:57")).bar(D1, 99_000, 91_000, 2_000)
                    .bar(D2, open + 300, close, 3_000).minute("OK", "09:01", open, 200);
            return payload;
        }

        private Order stopOrder() {
            return store.orders.values().stream().filter(o -> PaperBooks.SOURCE_STOP.equals(o.source())).findFirst()
                    .orElseThrow();
        }

        @Test
        @DisplayName("밤 잠정 종가 91,000 ≤ 스탑가 92,000 → 그 밤에는 팔지 않고 다음 거래일 시가 STOP 주문(NEXT_OPEN·PENDING·기준일 D+1·만료 D+1 + 3거래일·수량 null = 전량), 같은 밤 다시 쓴 저장본은 주문을 더 내지 않음")
        void detectionPlacesTheNextOpenStopOrder() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            heldAtHundred(BOOK);

            Outcome outcome = process(nightD1(91_000), COLLECTED_D1);

            Order stop = stopOrder();
            assertThat(stop.side()).isEqualTo(PaperBooks.SELL);
            assertThat(stop.timing()).isEqualTo(PaperBooks.NEXT_OPEN);
            assertThat(stop.status()).isEqualTo(PaperBooks.ORDER_PENDING);
            assertThat(stop.asOfTradingDate()).isEqualTo(D1);
            assertThat(stop.expiresOn()).isEqualTo(LocalDate.of(2026, 11, 6));
            assertThat(stop.qty()).isNull();
            assertThat(stop.sellFraction()).isNull();
            assertThat(stop.createdAt()).isEqualTo(COLLECTED_D1);
            assertThat(stop.reason().path("stopPrice").asDouble()).isEqualTo(92_000);
            assertThat(stop.reason().path("observedPrice").asDouble()).isEqualTo(91_000);
            assertThat(stop.reason().path("observedSource").asString()).isEqualTo(KrQuotes.SOURCE_INTEGRATED);
            assertThat(store.fillsOf(BOOK)).as("밤에는 그 가격으로 팔 수 없음").isEmpty();
            assertThat(position(BOOK, "005930").qty()).isEqualTo(10);
            assertThat(store.lockouts(BOOK)).isEmpty();
            assertThat(outcome.stopped()).as("체결한 스탑만 셈").isZero();
            assertThat(outcome.notes()).anySatisfy(n -> assertThat(n).contains("트레일링 스탑 감지").contains("92000"));

            process(nightD1(90_000), COLLECTED_D1.plusSeconds(3_600));
            assertThat(store.orders.values()).filteredOn(o -> PaperBooks.SOURCE_STOP.equals(o.source())).hasSize(1);
        }

        @Test
        @DisplayName("STOP_NOT_CONFIRMED — 체결 처리(D+2 밤) 때 금융위 D+1 종가 92,500이 스탑가 위면 취소(체결·재진입 금지 없음, 근거에 stopBasis FSC·확정 종가), 보유 그대로")
        void notConfirmedCancelsWithoutLockout() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            heldAtHundred(BOOK);
            process(nightD1(91_000), COLLECTED_D1);
            fsc("005930", D1, fscDay(D1, 92_500, 5_000, null));

            Outcome outcome = process(nightD2(93_000, 95_000), kst("2026-11-04T22:01"));

            Order stop = stopOrder();
            assertThat(stop.status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
            assertThat(stop.rejectReason()).startsWith("STOP_NOT_CONFIRMED — 금융위 2026-11-03 종가 92500원이 스탑가 92000원")
                    .contains("재진입 금지 없음");
            assertThat(stop.reason().path("stopBasis").asString()).isEqualTo(KrConfirmed.SOURCE_FSC);
            assertThat(stop.reason().path("confirmedClose").asDouble()).isEqualTo(92_500);
            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(store.lockouts(BOOK)).isEmpty();
            assertThat(position(BOOK, "005930").qty()).isEqualTo(10);
            assertThat(outcome.stopped()).isZero();
            assertThat(store.orders.values()).as("D+2 종가 95,000은 스탑가 위 — 새 감지 없음")
                    .filteredOn(o -> PaperBooks.SOURCE_STOP.equals(o.source())).hasSize(1);
        }

        @Test
        @DisplayName("확정 D+1 종가 91,500 ≤ 스탑가 → D+2 시가(1분봉 90,000)에 전량 매도, stopBasis FSC, 재진입 금지는 체결한 날(D+2)부터 20거래일 — 같은 시가의 그 종목 매수는 취소")
        void confirmedStopSellsAtTheNextOpen() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            heldAtHundred(BOOK);
            process(nightD1(91_000), COLLECTED_D1);
            fsc("005930", D1, fscDay(D1, 91_500, 5_000, null));
            Order rebuy = store.orders.get(store.insertOrder(new Order(0, BOOK, null, "005930", PaperBooks.BUY, 1, null, null,
                    PaperBooks.NEXT_OPEN, "CLAUDE", "PENDING", null, null, D1, kst("2026-11-03T22:30"),
                    LocalDate.of(2026, 11, 6), null)));

            Outcome outcome = process(nightD2(90_000, 89_000), kst("2026-11-04T22:01"));

            Fill fill = onlyFill();
            assertThat(fill.side()).isEqualTo(PaperBooks.SELL);
            assertThat(fill.qty()).isEqualTo(10);
            assertThat(fill.price()).isEqualTo(90_000);
            assertThat(fill.priceSource()).isEqualTo(KrQuotes.SOURCE_1M_OPEN);
            assertThat(fill.observationDate()).isEqualTo(D2);
            Order stop = stopOrder();
            assertThat(stop.status()).isEqualTo(PaperBooks.ORDER_FILLED);
            assertThat(stop.reason().path("stopBasis").asString()).isEqualTo(KrConfirmed.SOURCE_FSC);
            assertThat(store.positions(BOOK)).isEmpty();
            LocalDate until = run().calendar().addTradingDays(D2, 20);
            assertThat(store.lockouts(BOOK)).singleElement().satisfies(lockout -> {
                assertThat(lockout.untilTradingDate()).as("체결한 날부터 — 감지한 날(D+1)이 아님").isEqualTo(until);
                assertThat(lockout.reason()).contains("판정 FSC").contains("2026-11-04 시가 90000 체결");
            });
            assertThat(store.orders.get(rebuy.id()).status()).as("재진입 금지").isEqualTo(PaperBooks.ORDER_CANCELLED);
            assertThat(outcome.stopped()).isEqualTo(1);
        }

        @Test
        @DisplayName("금융위 D+1 행이 아직 없으면 잠정 판정대로 집행 — stopBasis=PROVISIONAL과 사유, 거래량 0 행(종가는 전날 값)도 확정 종가가 아니라 같음")
        void provisionalWhenTheConfirmedCloseIsMissing() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            heldAtHundred(BOOK);
            holdingSince(BOOK, "000660", 10, 100_000, D, 100_000, 1_000L);
            KrFixtures.Payload d1 = nightD1(91_000);
            d1.code("000660", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 99_000, 91_000, 2_000);
            process(d1, COLLECTED_D1);
            fsc("000660", D1, fscDay(D1, 92_500, 0, null));   // 거래 없던 행 — 92,500은 그날 종가가 아님

            KrFixtures.Payload d2 = nightD2(90_000, 89_000);
            d2.code("000660", kst("2026-11-04T21:57")).bar(D1, 99_000, 91_000, 2_000).bar(D2, 90_300, 89_000, 3_000)
                    .minute("OK", "09:01", 90_000, 200);
            process(d2, kst("2026-11-04T22:01"));

            assertThat(store.fillsOf(BOOK)).extracting(Fill::ticker).containsExactlyInAnyOrder("005930", "000660");
            for (Order stop : store.orders.values()) {
                assertThat(stop.status()).isEqualTo(PaperBooks.ORDER_FILLED);
                assertThat(stop.reason().path("stopBasis").asString()).isEqualTo(PaperLedgerService.STOP_BASIS_PROVISIONAL);
                assertThat(stop.reason().path("stopBasisNote").asString()).contains("확정 종가 없음");
            }
            assertThat(store.lockouts(BOOK)).hasSize(2);
        }

        @Test
        @DisplayName("최고가는 토스 종가로 오르지 않음 — NXT 통합가(TOSS_INTEGRATED) 120,000·KRX 단독 봉 종가 모두, 금융위 D+1 종가 110,000이 들어온 밤에 그 값으로(하루 늦게)")
        void watermarkRisesOnlyOnConfirmedCloses() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            heldAtHundred(BOOK);
            holdingSince(BOOK, "069500", 10, 100_000, D, 100_000, 1_000L);
            KrFixtures.Payload d1 = new KrFixtures.Payload(D1);
            d1.code("005930", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 101_000, 120_000, 2_000);
            d1.etf("069500", FETCHED_D1).bar(D, 100_000.0, 100_000.0, 1_000).bar(D1, 101_000.0, 118_000.0, 2_000);

            process(d1, COLLECTED_D1);

            assertThat(position(BOOK, "005930").highWatermark()).as("TOSS_INTEGRATED 종가").isEqualTo(100_000);
            assertThat(position(BOOK, "069500").highWatermark()).as("TOSS_DAILY 잠정 종가도").isEqualTo(100_000);
            assertThat(position(BOOK, "005930").lastPrice()).as("평가는 잠정 종가").isEqualTo(120_000);

            fsc("005930", D1, fscDay(D, 100_500, 1_000, null), fscDay(D1, 110_000, 5_000, null));
            KrFixtures.Payload d2 = new KrFixtures.Payload(D2);
            d2.code("005930", kst("2026-11-04T21:57")).bar(D1, 101_000, 120_000, 2_000).bar(D2, 116_000, 115_000, 3_000);
            process(d2, kst("2026-11-04T22:01"));

            assertThat(position(BOOK, "005930").highWatermark()).as("금융위 D+1 종가 — D+2 토스 종가 115,000은 아님")
                    .isEqualTo(110_000);
            assertThat(store.orders.values()).as("115,000 > 101,200(110,000 × 0.92) — 스탑 없음")
                    .noneMatch(o -> PaperBooks.SOURCE_STOP.equals(o.source()));
        }

        @Test
        @DisplayName("늦게 들어온 금융위 종가도 최고가에 — 금융위 D+1이 D+2 관측치 처리보다 늦어 since가 이미 D+2여도, D+3 밤 D+1 종가 110,000으로 올라 D+3 잠정 종가 100,000에 스탑 감지(스탑가 101,200)")
        void lateConfirmedCloseStillRaisesTheWatermark() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            heldAtHundred(BOOK);
            LocalDate d3 = LocalDate.of(2026, 11, 5);
            fsc("005930", D, fscDay(D, 100_000, 1_000, null));
            KrFixtures.Payload d1 = new KrFixtures.Payload(D1);
            d1.code("005930", FETCHED_D1).bar(D, 100_000, 100_000, 1_000).bar(D1, 109_000, 110_000, 2_000);
            process(d1, COLLECTED_D1);
            KrFixtures.Payload d2 = new KrFixtures.Payload(D2);
            d2.code("005930", kst("2026-11-04T21:57")).bar(D1, 109_000, 110_000, 2_000).bar(D2, 103_000, 102_000, 3_000);
            process(d2, kst("2026-11-04T22:01"));   // 금융위 D+1은 아직(첫 slow 실패) — since는 D+2로
            assertThat(store.positions(BOOK).get(0).fillRefDate()).isEqualTo(D2);
            assertThat(position(BOOK, "005930").highWatermark()).isEqualTo(100_000);

            fsc("005930", D2, fscDay(D, 100_000, 1_000, null), fscDay(D1, 110_000, 5_000, null),
                    fscDay(D2, 102_000, 4_000, null));
            KrFixtures.Payload night3 = new KrFixtures.Payload(d3);
            night3.code("005930", kst("2026-11-05T21:57")).bar(D2, 103_000, 102_000, 3_000).bar(d3, 101_000, 100_000, 3_000);
            process(night3, kst("2026-11-05T22:01"));

            assertThat(position(BOOK, "005930").highWatermark()).as("D+1 종가 — since(D+2) 앞이지만 금융위 창 안").isEqualTo(110_000);
            assertThat(store.orders.values()).filteredOn(o -> PaperBooks.SOURCE_STOP.equals(o.source())).singleElement()
                    .satisfies(o -> assertThat(o.reason().path("stopPrice").asDouble()).isEqualTo(101_200));
        }

        @Test
        @DisplayName("최고가를 읽기 시작할 날 — since와 금융위 최신 기준일 − 14일 중 이른 날, 보유를 연 날·마지막 분할 E 앞으로는 가지 않고, 분할 기록이 있는데 E를 못 읽으면 since부터")
        void watermarkWindowBounds() {
            LocalDate since = LocalDate.of(2026, 11, 10);
            LocalDate opened = LocalDate.of(2026, 10, 20);
            assertThat(PaperLedgerService.watermarkFrom(since, opened, null, since)).isEqualTo(LocalDate.of(2026, 10, 27));
            assertThat(PaperLedgerService.watermarkFrom(since, LocalDate.of(2026, 11, 2), null, since))
                    .as("보유를 연 날 앞으로는 가지 않음").isEqualTo(LocalDate.of(2026, 11, 2));
            assertThat(PaperLedgerService.watermarkFrom(since, opened,
                    "2026-10-28 2:1 분할·병합 확인 — 10주 → 20주 · 2026-11-06 50:1 분할·병합 확인 — 20주 → 1000주", since))
                    .as("마지막 분할 E(그 전 가격은 옛 단위)").isEqualTo(LocalDate.of(2026, 11, 6));
            assertThat(PaperLedgerService.watermarkFrom(since, opened, "…주 → 1000주, 평단 70000 → 1400", since))
                    .as("E를 읽을 수 없는 분할 기록 — 거슬러 읽지 않음").isEqualTo(since);
            assertThat(PaperLedgerService.watermarkFrom(since, opened, null, null)).as("금융위가 아무것도 받지 않음").isEqualTo(since);
            assertThat(PaperLedgerService.watermarkFrom(null, opened, null, since)).isNull();
        }

        @Test
        @DisplayName("스탑을 보지 않는 보유: 현금성(153130)·벤치마크 계좌·미처리 기업행위 보유·이번 관측치의 마지막 봉이 정지일(거래량 0)")
        void noStopForCashLikeBenchmarkHeldOrHaltedBars() {
            book(BOOK, PaperBooks.KIND_CLAUDE, 0);
            book(PaperBooks.KR_BENCH_K200, PaperBooks.KIND_BENCHMARK, 0);
            holdingSince(BOOK, "153130", 10, 100_000, D, 100_000, 1_000L);
            holdingSince(BOOK, "000660", 10, 100_000, D, 100_000, 1_000L);
            holdingSince(BOOK, "035720", 10, 100_000, D, 100_000, 1_000L);
            store.holdForCorpAction(BOOK, "035720", "2026-11-02 기업행위 확인 필요 — 시험용");
            holdingSince(PaperBooks.KR_BENCH_K200, "005930", 10, 100_000, D, 100_000, 1_000L);
            KrFixtures.Payload payload = new KrFixtures.Payload(D1);
            payload.etf("153130", FETCHED_D1).bar(D, 100_000.0, 100_000.0, 10).bar(D1, 80_000.0, 80_000.0, 10);
            payload.code("000660", FETCHED_D1).bar(D, 100_000, 100_000, 10).bar(D1, 80_000, 80_000, 0);
            payload.code("035720", FETCHED_D1).bar(D, 100_000, 100_000, 10).bar(D1, 80_000, 80_000, 10);
            payload.code("005930", FETCHED_D1).bar(D, 100_000, 100_000, 10).bar(D1, 80_000, 80_000, 10);

            process(payload, COLLECTED_D1);

            assertThat(store.orders.values()).noneMatch(o -> PaperBooks.SOURCE_STOP.equals(o.source()));
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
