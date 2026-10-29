package com.macrodash.feature.paper;

import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.FillConfirmation;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 계좌의 체결·보유 응답(2단계 명세 §4-16 F2 — 화면의 잠정·확정·확정 조정·실효 비용 bp·'기업행위 확인 필요'): 체결 행의 비용 칸과 실효 비용 bp,
 * 확정 조정 행의 가격 차이·현금 차이·확정가 기준 bp, 확정 상태 셋(확정·확정 대기·미보정 — ETF와 주식의 라벨), 계좌 전체 합계, 보유의 기업행위 보류
 * 사유와 그 보류로 묶인 평가의 출처(§9 F3). 숫자는 손으로 셈니다. 미국 계좌의 체결·보유 행은 키 목록이 예전 그대로입니다.
 */
class PaperQueryKrBooksTest {

    private static final String BOOK = PaperBooks.KR_CLAUDE;
    /** 체결일 D+1 = 2026-11-03(화), 다음 체결일 11-04(수). */
    private static final LocalDate D1 = LocalDate.of(2026, 11, 3);
    private static final LocalDate D2 = LocalDate.of(2026, 11, 4);
    private static final Instant CREATED = Instant.parse("2026-11-02T13:30:00Z");   // 11-02 22:30 KST
    private static final Instant FILLED_D1 = Instant.parse("2026-11-03T12:57:00Z");  // 11-03 21:57 KST
    private static final Instant FILLED_D2 = Instant.parse("2026-11-04T12:57:00Z");
    private static final Instant RECONCILED = Instant.parse("2026-11-04T13:05:00Z"); // 11-04 22:05 KST
    private static final Clock NOW = Clock.fixed(Instant.parse("2026-11-04T14:00:00Z"), ZoneOffset.UTC);

    private FakePaperStore store;
    private PaperMarketData marketData;
    private PaperQueryService query;
    /** 금융위 확정 시세(종목 → 기준일 → 종가) — 보류로 묶인 평가의 출처를 가를 때 읽습니다. */
    private final Map<String, Map<LocalDate, Long>> fscCloses = new HashMap<>();

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        marketData = mock(PaperMarketData.class);
        when(marketData.krConfirmed(anyCollection(), anyCollection(), any())).thenAnswer(invocation -> {
            Map<String, KrConfirmed.Series> series = new HashMap<>();
            fscCloses.forEach((code, closes) -> {
                TreeMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
                closes.forEach((day, close) -> days.put(day, new KrConfirmed.Day(day, BigDecimal.valueOf(close), 1_000L, null,
                        BigDecimal.valueOf(close), "KOSPI")));
                series.put(code, new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, D2, days));
            });
            return new KrConfirmed(series);
        });
        query = new PaperQueryService(store, marketData, PaperFixtures.quietReader(), PaperFixtures.settings(store),
                PaperFixtures.config(), NOW);
        store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_CLAUDE, PaperBooks.KR_CLAUDE_LABEL, 100_000_000,
                LocalDate.of(2026, 11, 2), PaperBooks.ACTIVE, CREATED, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(BOOK, new BookState(BOOK, 99_000_000, 100_000_000, 1_000_000, 1, null, null, null, null));
    }

    private void fscLatest(LocalDate stocks, LocalDate etfs) {
        when(marketData.fscLatest()).thenReturn(new PaperMarketData.FscLatest(stocks, etfs));
    }

    /** 매수·매도 한 건 — 주문(NEXT_OPEN)과 그 체결(토스 1분봉 시가, 비용 칸). */
    private long fill(String ticker, String side, int qty, double price, LocalDate day, Instant at, long fee, long tax,
                      long slippage) {
        long orderId = store.insertOrder(new Order(0, BOOK, null, ticker, side, qty, null, null, PaperBooks.NEXT_OPEN,
                "CLAUDE", "FILLED", null, null, day.minusDays(1), CREATED, day.plusDays(4), at));
        return store.insertFill(new Fill(0, orderId, BOOK, ticker, side, qty, price, price, 5, price * qty, at, day,
                "TOSS_1M_OPEN", false, at, BigDecimal.valueOf(fee), BigDecimal.valueOf(tax), BigDecimal.valueOf(slippage)));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> rows(Map<String, Object> body) {
        return (List<Map<String, Object>>) body.get("fills");
    }

    private static Map<String, Object> row(Map<String, Object> body, String ticker) {
        return rows(body).stream().filter(r -> ticker.equals(r.get("ticker"))).findFirst().orElseThrow();
    }

    @Test
    @DisplayName("체결 행의 비용 칸과 실효 비용 bp — 매수 10주 71,300(수수료 106·슬리피지 356) → 462 ÷ 713,000 × 10⁴ = 6.48bp")
    void costColumnsAndEffectiveBp() {
        fscLatest(LocalDate.of(2026, 10, 30), LocalDate.of(2026, 10, 30));
        fill("005930", PaperBooks.BUY, 10, 71_300, D1, FILLED_D1, 106, 0, 356);

        Map<String, Object> r = row(query.fills(BOOK, 50), "005930");

        assertThat(r.get("fee")).isEqualTo(106.0);
        assertThat(r.get("tax")).isEqualTo(0.0);
        assertThat(r.get("slippageCost")).isEqualTo(356.0);
        assertThat(r.get("costBp")).isEqualTo(6.48);
        assertThat(r.get("confirmation")).isNull();
    }

    @Test
    @DisplayName("확정 조정 행: 확정 71,200 → 가격 차이 −100, 현금 차이 +1,000, 확정가 기준 bp 462 ÷ 712,000 × 10⁴ = 6.49, 상태 CONFIRMED")
    @SuppressWarnings("unchecked")
    void confirmationRow() {
        fscLatest(D1, D1);
        long id = fill("005930", PaperBooks.BUY, 10, 71_300, D1, FILLED_D1, 106, 0, 356);
        store.insertFillConfirmationIfAbsent(new FillConfirmation(id, BOOK, BigDecimal.valueOf(71_200), BigDecimal.valueOf(106),
                BigDecimal.ZERO, BigDecimal.valueOf(356), BigDecimal.valueOf(1_000), FillConfirmation.SOURCE_FSC, RECONCILED));

        Map<String, Object> r = row(query.fills(BOOK, 50), "005930");

        Map<String, Object> c = (Map<String, Object>) r.get("confirmation");
        assertThat(c.get("confirmedPrice")).isEqualTo(71_200.0);
        assertThat(c.get("priceDiff")).isEqualTo(-100.0);
        assertThat(c.get("cashDelta")).isEqualTo(1_000.0);
        assertThat(c.get("costBp")).isEqualTo(6.49);
        assertThat(c.get("fee")).isEqualTo(106.0);
        assertThat(c.get("slippageCost")).isEqualTo(356.0);
        assertThat(c.get("source")).isEqualTo("FSC");
        assertThat(c.get("reconciledAtKst")).isEqualTo("2026-11-04 22:05 KST");
        assertThat(r.get("confirmationState")).isEqualTo("CONFIRMED");
        assertThat(r.get("confirmationNote")).isNull();
        assertThat(r.get("costBp")).as("잠정 체결의 bp는 그대로").isEqualTo(6.48);
    }

    @Test
    @DisplayName("금융위가 그날을 아직 내지 않음 → WAITING('금융위 {기준일}까지 냄 — 그날 값 기다림'), 금융위 값이 아예 없으면 '아직 받지 못함'")
    void waitingWhileTheDayIsNotPublished() {
        fscLatest(LocalDate.of(2026, 11, 2), LocalDate.of(2026, 11, 2));
        fill("005930", PaperBooks.BUY, 10, 71_300, D1, FILLED_D1, 106, 0, 356);

        Map<String, Object> r = row(query.fills(BOOK, 50), "005930");
        assertThat(r.get("confirmationState")).isEqualTo("WAITING");
        assertThat(r.get("confirmationNote")).isEqualTo("금융위 2026-11-02까지 냄 — 그날 값 기다림");

        fscLatest(null, null);
        Map<String, Object> none = row(query.fills(BOOK, 50), "005930");
        assertThat(none.get("confirmationState")).isEqualTo("WAITING");
        assertThat(none.get("confirmationNote")).isEqualTo("금융위 값을 아직 받지 못함 — 그날 값 기다림");
    }

    @Test
    @DisplayName("그날을 냈는데 행 없음 → UNCORRECTED — ETF(현금성 153130)는 증권상품시세 기준일로 '금융위 확정 미보정(ETF)', 주식은 주식시세로 '금융위 확정 못 함'")
    void uncorrectedLabelsFollowTheDataset() {
        // 주식시세는 D1까지 냈고 증권상품시세는 D1 전까지 — ETF는 그 데이터셋 기준일로 봄(주식시세가 냈어도 기다림).
        fscLatest(D1, LocalDate.of(2026, 11, 2));
        fill("005930", PaperBooks.BUY, 10, 71_300, D1, FILLED_D1, 106, 0, 356);
        fill("153130", PaperBooks.BUY, 100, 108_000, D1, FILLED_D1.plusSeconds(1), 1_620, 0, 5_400);

        Map<String, Object> body = query.fills(BOOK, 50);
        assertThat(row(body, "005930").get("confirmationState")).isEqualTo("UNCORRECTED");
        assertThat(row(body, "005930").get("confirmationNote")).isEqualTo("금융위 확정 못 함");
        assertThat(row(body, "153130").get("confirmationState")).isEqualTo("WAITING");

        fscLatest(D1, D1);
        Map<String, Object> later = query.fills(BOOK, 50);
        assertThat(row(later, "153130").get("confirmationState")).isEqualTo("UNCORRECTED");
        assertThat(row(later, "153130").get("confirmationNote")).isEqualTo("금융위 확정 미보정(ETF)");
    }

    @Test
    @DisplayName("confirmationTotal — 계좌 전체(목록 상한과 무관)의 확정 조정 행 수·현금 차이 합·아직 확정 안 된 체결 수, 행이 없으면 합은 null(0 아님)")
    @SuppressWarnings("unchecked")
    void confirmationTotal() {
        fscLatest(D1, D1);
        long a = fill("005930", PaperBooks.BUY, 10, 71_300, D1, FILLED_D1, 106, 0, 356);
        long b = fill("000660", PaperBooks.SELL, 5, 200_000, D2, FILLED_D2, 150, 2_000, 500);

        Map<String, Object> before = (Map<String, Object>) query.fills(BOOK, 50).get("confirmationTotal");
        assertThat(before.get("rows")).isEqualTo(0);
        assertThat(before.get("cashDelta")).as("확정 조정 행이 없으면 합을 모름(—)").isNull();
        assertThat(before.get("unconfirmed")).isEqualTo(2);

        store.insertFillConfirmationIfAbsent(new FillConfirmation(a, BOOK, BigDecimal.valueOf(71_200), BigDecimal.valueOf(106),
                BigDecimal.ZERO, BigDecimal.valueOf(356), BigDecimal.valueOf(1_000), FillConfirmation.SOURCE_FSC, RECONCILED));
        store.insertFillConfirmationIfAbsent(new FillConfirmation(b, BOOK, BigDecimal.valueOf(199_900), BigDecimal.valueOf(149),
                BigDecimal.valueOf(1_999), BigDecimal.valueOf(499), new BigDecimal("-497.0000"), FillConfirmation.SOURCE_FSC,
                RECONCILED));

        Map<String, Object> body = query.fills(BOOK, 1);
        assertThat(rows(body)).as("목록은 최근 1건").hasSize(1);
        Map<String, Object> total = (Map<String, Object>) body.get("confirmationTotal");
        assertThat(total.get("rows")).isEqualTo(2);
        assertThat(total.get("cashDelta")).isEqualTo(503.0);   // 1,000 − 497
        assertThat(total.get("unconfirmed")).isEqualTo(0);
        assertThat(body.keySet()).containsExactly("available", "confirmationTotal", "fills");
    }

    @Test
    @DisplayName("한국 보유 행에 corpActionHold — 미처리 기업행위 보류 사유, 없으면 null")
    @SuppressWarnings("unchecked")
    void positionsCarryCorporateActionHolds() {
        Instant opened = FILLED_D1;
        store.upsertPosition(new Position(BOOK, "005930", 10, 71_300, D1, opened, 71_300, opened, 71_500.0, opened, false, D1,
                71_300, null));
        store.upsertPosition(new Position(BOOK, "000660", 5, 200_000, D1, opened, 200_000, opened, 201_000.0, opened, false, D1,
                200_000, null));
        store.holdForCorpAction(BOOK, "000660", "2026-11-03 상장주식수 변동(분할·병합 추정) — 확인 필요");

        List<Map<String, Object>> rows = (List<Map<String, Object>>) query.positions(BOOK).get("positions");

        Map<String, Object> held = rows.stream().filter(r -> "000660".equals(r.get("ticker"))).findFirst().orElseThrow();
        Map<String, Object> free = rows.stream().filter(r -> "005930".equals(r.get("ticker"))).findFirst().orElseThrow();
        assertThat(held.get("corpActionHold")).isEqualTo("2026-11-03 상장주식수 변동(분할·병합 추정) — 확인 필요");
        assertThat(free).containsKey("corpActionHold");
        assertThat(free.get("corpActionHold")).isNull();
        assertThat(free).containsKey("heldValuation");
        assertThat(free.get("heldValuation")).isNull();
    }

    @Test
    @DisplayName("묶인 평가의 출처 heldValuation — 평가 가격 = 그날 금융위 확정 종가면 FSC_CONFIRMED, 다르거나 없으면 LAST_VALUATION, 가격 없으면 AVG_COST")
    @SuppressWarnings("unchecked")
    void heldValuationSource() {
        Instant opened = FILLED_D1;
        String reason = "2026-11-03 상장주식수 변동(분할·병합 추정) — 확인 필요";
        // 장부가 금융위 11-03 종가 201,000으로 묶은 보유
        store.upsertPosition(new Position(BOOK, "000660", 5, 200_000, D1, opened, 201_000, opened, 201_000.0, RECONCILED, false, D1,
                200_000, null));
        // 금융위 11-03 종가(179,500)가 묶은 뒤에 들어와 장부가 아직 마지막 평가 가격(토스 180,000)으로 둔 보유
        store.upsertPosition(new Position(BOOK, "035420", 55, 182_000, D1, opened, 186_500, opened, 180_000.0, opened, false, D1,
                182_000, null));
        // 그날 금융위 행이 아예 없고, 가격도 받은 적 없는 보유(평단 평가)
        store.upsertPosition(new Position(BOOK, "247540", 3, 90_000, D1, opened, 90_000, opened, null, null, true, D1,
                90_000, null));
        for (String ticker : List.of("000660", "035420", "247540")) {
            store.holdForCorpAction(BOOK, ticker, reason);
        }
        fscCloses.put("000660", Map.of(D1, 201_000L));
        fscCloses.put("035420", Map.of(D1, 179_500L));

        List<Map<String, Object>> rows = (List<Map<String, Object>>) query.positions(BOOK).get("positions");

        Map<String, Map<String, Object>> held = new HashMap<>();
        rows.forEach(r -> held.put((String) r.get("ticker"), (Map<String, Object>) r.get("heldValuation")));
        assertThat(held.get("000660")).containsExactly(Map.entry("source", "FSC_CONFIRMED"), Map.entry("date", "2026-11-03"));
        assertThat(held.get("035420")).containsExactly(Map.entry("source", "LAST_VALUATION"), Map.entry("date", "2026-11-03"));
        assertThat(held.get("247540")).containsExactly(Map.entry("source", "AVG_COST"), Map.entry("date", "2026-11-03"));
    }

    @Test
    @DisplayName("미국 계좌의 체결·보유 응답은 키 목록이 예전 그대로 — 한국 칸(비용·확정·기업행위)이 붙지 않음")
    @SuppressWarnings("unchecked")
    void usRowsKeepTheirKeys() {
        store.books.put("claude", new Book("claude", PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000, PaperFixtures.FRI,
                PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE, Book.MARKET_US, Book.CURRENCY_USD));
        store.states.put("claude", new BookState("claude", 1_000, 3_000, 2_000, 66.6667, PaperFixtures.MON_FINAL,
                PaperFixtures.MON_FINAL, PaperFixtures.MON, null));
        PaperFixtures.position(store, "claude", "AAA", 10, 100, 110, 100.0, PaperFixtures.FRI, 100);
        long orderId = store.insertOrder(new Order(0, "claude", null, "AAA", PaperBooks.BUY, 10, null, null,
                "NEXT_OBSERVATION", "CLAUDE", "FILLED", null, null, PaperFixtures.FRI, PaperFixtures.FRI_CLOSE,
                PaperFixtures.MON, PaperFixtures.MON_INTRADAY));
        store.insertFill(new Fill(0, orderId, "claude", "AAA", PaperBooks.BUY, 10, 100.05, 100, 5, 1_000.5,
                PaperFixtures.MON_INTRADAY, PaperFixtures.MON, "equity_close", false, PaperFixtures.MON_INTRADAY));

        Map<String, Object> fills = query.fills("claude", 50);
        assertThat(fills.keySet()).containsExactly("available", "fills");
        assertThat(rows(fills).get(0).keySet()).containsExactly("id", "orderId", "ticker", "side", "qty", "price", "rawPrice",
                "slippageBp", "gross", "observedAtKst", "observationDate", "priceSource", "backfill");
        Map<String, Object> positions = query.positions("claude");
        assertThat(((List<Map<String, Object>>) positions.get("positions")).get(0).keySet()).containsExactly("ticker", "qty",
                "avgCost", "lastPrice", "lastPriceAtKst", "marketValue", "weightPct", "unrealizedPct", "highWatermark",
                "stopPrice", "stopDistancePct", "openedOn", "holdingTradingDays", "holdingTradingDaysReason", "priceStale",
                "splitNote", "cashLike", "backfilled");
    }
}
