package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.read.StoreReader;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 모의 매매 서비스 테스트의 공통 재료 — 날짜는 2026-10-23(금, 출발일) 뒤의 실제 달력입니다(EDT: 마감 20:00Z). */
final class PaperFixtures {

    private PaperFixtures() {
    }

    static final ObjectMapper MAPPER = new ObjectMapper();

    static final LocalDate FRI = LocalDate.of(2026, 10, 23);
    static final LocalDate MON = LocalDate.of(2026, 10, 26);
    static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    static final LocalDate WED = LocalDate.of(2026, 10, 28);

    /** 금요일 마감(16:00 ET). */
    static final Instant FRI_CLOSE = Instant.parse("2026-10-23T20:00:00Z");
    /** 토요일 낮(KST 일요일 새벽) — 수집기가 금요일 종가를 다시 저장하는 시각. */
    static final Instant SAT = Instant.parse("2026-10-24T15:00:00Z");
    /** 월요일 장중(11:00 ET). */
    static final Instant MON_INTRADAY = Instant.parse("2026-10-26T15:00:00Z");
    /** 월요일 마감 10분 뒤 — 아직 확정 종가 아님. */
    static final Instant MON_CLOSE_10 = Instant.parse("2026-10-26T20:10:00Z");
    /** 월요일 마감 20분 뒤 — 확정 종가. */
    static final Instant MON_FINAL = Instant.parse("2026-10-26T20:20:00Z");
    static final Instant TUE_INTRADAY = Instant.parse("2026-10-27T15:00:00Z");
    static final Instant TUE_FINAL = Instant.parse("2026-10-27T20:20:00Z");

    /** 날짜·종가를 번갈아 받아 봉을 만듭니다: bar("AAA", FRI, 100, MON, 101). 마지막 쌍이 관측 봉. */
    static Bar bar(String ticker, Object... dateAndClose) {
        return bar(ticker, false, dateAndClose);
    }

    static Bar staleBar(String ticker, Object... dateAndClose) {
        return bar(ticker, true, dateAndClose);
    }

    private static Bar bar(String ticker, boolean stale, Object... dateAndClose) {
        int n = dateAndClose.length / 2;
        int[] days = new int[n];
        double[] values = new double[n];
        for (int i = 0; i < n; i++) {
            days[i] = (int) ((LocalDate) dateAndClose[2 * i]).toEpochDay();
            values[i] = ((Number) dateAndClose[2 * i + 1]).doubleValue();
        }
        DailySeries recent = new DailySeries(days, values);
        return new Bar(ticker, recent.lastDate(), recent.lastValue(), stale, recent);
    }

    static Quotes quotes(Instant collectedAt, Bar... bars) {
        Map<String, Bar> map = new LinkedHashMap<>();
        for (Bar bar : bars) {
            map.put(bar.ticker(), bar);
        }
        return new Quotes(collectedAt, map);
    }

    /** 운용 중인 책 + 현금만 든 상태(멱등 키 = lastProcessed). */
    static void activeBook(FakePaperStore store, String code, String kind, double cash, Instant lastProcessed) {
        store.books.put(code, new Book(code, kind, code, 100_000, FRI, PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(code, new BookState(code, cash, cash, 0, 0, lastProcessed, lastProcessed, null, null));
    }

    /** 보유 한 건 — 분할 기준(refDate, refClose)과 최고가를 함께. */
    static void position(FakePaperStore store, String code, String ticker, int qty, double avgCost, double watermark,
                         Double lastPrice, LocalDate refDate, double refClose) {
        store.upsertPosition(new Position(code, ticker, qty, avgCost, FRI, FRI_CLOSE, watermark, FRI_CLOSE, lastPrice,
                FRI_CLOSE, false, refDate, refClose, null));
    }

    /** 대기 주문(PENDING). 수량·목표 비중·매도 비율 중 하나만 넣습니다. */
    static long pending(FakePaperStore store, String code, String ticker, String side, Integer qty, Double weightPct,
                        Double sellFraction, String timing, LocalDate asOf, Instant createdAt) {
        return store.insertOrder(new Order(0, code, null, ticker, side, qty, weightPct, sellFraction, timing, "CLAUDE",
                "PENDING", null, null, asOf, createdAt, asOf.plusDays(7), null));
    }

    static Order order(FakePaperStore store, long id) {
        return store.orders.get(id);
    }

    /** quietly는 받은 일을 그대로 합니다(테스트에는 수집 요청이 없음). */
    @SuppressWarnings("unchecked")
    /**
     * 가짜(mock) 협력 객체의 시장 인자 맞춤 — 그 시장 묶음 자신이든 그 묶음으로 연 실행({@link MarketRun})이든 받습니다(C1a: 작업·조회가
     * 시장 묶음 대신 실행을 넘김). Mockito 맞춤이라 같은 호출의 다른 인자도 맞춤(eq·any)이어야 합니다.
     */
    static PaperMarket market(PaperMarket definition) {
        return argThat(m -> m != null && m.definition() == definition);
    }

    static StoreReader quietReader() {
        StoreReader reader = mock(StoreReader.class);
        when(reader.quietly(any())).thenAnswer(invocation -> ((Supplier<Object>) invocation.getArgument(0)).get());
        return reader;
    }

    static PaperSettingsService settings(FakePaperStore store) {
        return new PaperSettingsService(store, MAPPER);
    }

    /**
     * 설정 행에서 실제 한국 묶음({@code kr.*} 기본값 — C1b부터 기본 본문에 있음)을 뺍니다. 시험용 한국 묶음({@link TestKrMarket}, 접두어
     * {@code kr.})이 실제 한국 기본값(1억 원 기준 최소 주문 500,000원·현금성 153130·결정 기한 01:00) 대신 자기 기본값(시험용 값)으로 돌게
     * — 한국 키가 없는 행(C1b 전에 만든 행)과 같습니다. 한국 키를 시험마다 정하는 시험은 {@code putObject("kr")}로 묶음을 통째로 바꿉니다.
     */
    static void dropKrDefaults(FakePaperStore store) {
        ((tools.jackson.databind.node.ObjectNode) store.settings.body()).remove("kr");
    }

    static PaperConfig config() {
        return new PaperConfig(true, FRI, 100_000);
    }
}
