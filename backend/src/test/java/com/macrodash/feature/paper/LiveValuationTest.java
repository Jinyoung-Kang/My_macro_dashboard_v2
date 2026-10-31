package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.LiveValuation.LivePrice;
import com.macrodash.feature.paper.LiveValuation.Session;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 장중 평가 계산(GET /api/paper/live가 씀) — 장 상태, 장중 값으로 받는 범위, 계좌·종목 평가.
 *
 * <p>2026-10-30(금)은 미국 서머타임(동부 = UTC−4)이라 정규장이 13:30~20:00 UTC, 다음 거래일 11-02(월)은 서머타임이 끝나 14:30 UTC 개장.
 */
class LiveValuationTest {

    private static final LocalDate FRI = LocalDate.of(2026, 10, 30);
    private static final Instant OPEN = Instant.parse("2026-10-30T13:30:00Z");
    private static final Instant CLOSE = Instant.parse("2026-10-30T20:00:00Z");
    private static final Session REGULAR_FRI = new Session(LiveValuation.REGULAR, FRI, OPEN, CLOSE,
            Instant.parse("2026-11-02T14:30:00Z"));

    @Test
    @DisplayName("장 상태 — 개장 전 PRE(다음 개장 = 오늘), 정규장 REGULAR, 마감 뒤 AFTER, 휴장일 CLOSED(세션 = 직전 거래일)")
    void sessionPhases() {
        Session pre = LiveValuation.session(UsMarketCalendar.CALENDAR, Instant.parse("2026-10-30T12:00:00Z"));
        assertThat(pre.phase()).isEqualTo(LiveValuation.PRE);
        assertThat(pre.nextOpenAt()).isEqualTo(OPEN);

        Session regular = LiveValuation.session(UsMarketCalendar.CALENDAR, Instant.parse("2026-10-30T15:00:00Z"));
        assertThat(regular).isEqualTo(REGULAR_FRI);

        Session after = LiveValuation.session(UsMarketCalendar.CALENDAR, Instant.parse("2026-10-30T21:00:00Z"));
        assertThat(after.phase()).isEqualTo(LiveValuation.AFTER);
        assertThat(after.sessionDate()).isEqualTo(FRI);

        Session saturday = LiveValuation.session(UsMarketCalendar.CALENDAR, Instant.parse("2026-10-31T15:00:00Z"));
        assertThat(saturday.phase()).isEqualTo(LiveValuation.CLOSED);
        assertThat(saturday.sessionDate()).isEqualTo(FRI);
        assertThat(saturday.openAt()).isNull();
        assertThat(saturday.nextOpenAt()).isEqualTo(Instant.parse("2026-11-02T14:30:00Z"));
    }

    @Test
    @DisplayName("저장본 시세 — 가격이 양수이고 시각을 읽을 수 있는 것만, 이어받은 값은 stale")
    void livePrices() throws Exception {
        Map<String, LivePrice> prices = LiveValuation.livePrices(MAPPER.readTree("""
                {"tickers": {"AAA": {"price": 101.5, "at": "2026-10-30T14:31:00+00:00"},
                             "BBB": {"price": 50, "at": "2026-10-29T19:59:00+00:00", "isStale": true},
                             "ZERO": {"price": 0, "at": "2026-10-30T14:31:00+00:00"},
                             "NOAT": {"price": 3}, "BAD": {"price": 4, "at": "어제"}}}"""));
        assertThat(prices).containsOnlyKeys("AAA", "BBB");
        assertThat(prices.get("AAA")).isEqualTo(new LivePrice(101.5, Instant.parse("2026-10-30T14:31:00Z"), false));
        assertThat(prices.get("BBB").stale()).isTrue();
    }

    @Test
    @DisplayName("장중 값 — 그날 정규장 시작 이후·지금(마감 뒤면 마감) + 2분 이하이고 이어받지 않은 봉만")
    void acceptedWindow() {
        Instant now = Instant.parse("2026-10-30T15:00:00Z");
        assertThat(LiveValuation.accepted(price("2026-10-30T14:59:00Z", false), REGULAR_FRI, now)).isTrue();
        assertThat(LiveValuation.accepted(price("2026-10-30T14:59:00Z", true), REGULAR_FRI, now)).as("이어받은 값").isFalse();
        assertThat(LiveValuation.accepted(price("2026-10-29T19:59:00Z", false), REGULAR_FRI, now)).as("어제 봉").isFalse();
        assertThat(LiveValuation.accepted(price("2026-10-30T15:10:00Z", false), REGULAR_FRI, now)).as("미래 봉").isFalse();
        Session after = new Session(LiveValuation.AFTER, FRI, OPEN, CLOSE, REGULAR_FRI.nextOpenAt());
        assertThat(LiveValuation.accepted(price("2026-10-30T19:59:00Z", false), after, Instant.parse("2026-10-30T22:00:00Z")))
                .as("마감 뒤에는 그날 마지막 봉").isTrue();
        Session closed = new Session(LiveValuation.CLOSED, FRI, null, null, REGULAR_FRI.nextOpenAt());
        assertThat(LiveValuation.accepted(price("2026-10-30T19:59:00Z", false), closed, now)).as("휴장일").isFalse();
    }

    @Test
    @DisplayName("직전 확정 순자산 — 기준 거래일보다 엄격히 앞의 마지막 줄, 기준일을 모르면 null")
    void previousNav() {
        List<NavRow> rows = List.of(nav("2026-10-28", 100_500), nav("2026-10-29", 101_000), nav("2026-10-30", 102_000));
        assertThat(LiveValuation.previousNav(rows, FRI).tradingDate()).isEqualTo(LocalDate.of(2026, 10, 29));
        assertThat(LiveValuation.previousNav(rows, LocalDate.of(2026, 10, 28))).isNull();
        assertThat(LiveValuation.previousNav(rows, null)).isNull();
    }

    @Test
    @DisplayName("계좌 평가 — 장중 값·마지막 관측 가격을 섞어 순자산·출발 대비·직전 확정 대비·종목 비중, 기준 시각은 가장 오래된 장중 봉")
    void bookValuation() {
        Book book = book("claude", "ACTIVE");
        BookState state = new BookState("claude", 10_000, 99_000, 89_000, 89.9, Instant.parse("2026-10-30T09:05:00Z"),
                null, LocalDate.of(2026, 10, 29), Instant.parse("2026-10-30T09:05:00Z"));
        List<Position> positions = List.of(position("AAA", 100, 400, 410.0), position("BBB", 200, 250, 240.0));
        Map<String, LivePrice> live = Map.of("AAA", price("2026-10-30T14:58:00Z", false, 420),
                "BBB", price("2026-10-29T19:59:00Z", true, 245));
        Map<String, Bar> bars = Map.of("AAA", bar("AAA", Map.of("2026-10-28", 405.0, "2026-10-29", 410.0)));

        Map<String, Object> out = LiveValuation.book(book, state, positions, nav("2026-10-29", 99_000), FRI, live, bars,
                REGULAR_FRI, Instant.parse("2026-10-30T15:00:00Z"));

        // 10,000 + 100 × 420(장중) + 200 × 240(BBB는 이어받은 값이라 장부의 마지막 관측 가격) = 100,000
        assertThat(out).containsEntry("nav", 100_000.0).containsEntry("returnPct", 0.0)
                .containsEntry("dayChangePct", 1.01).containsEntry("previousTradingDate", "2026-10-29")
                .containsEntry("basis", LiveValuation.LIVE).containsEntry("basisAtKst", "2026-10-30 23:58 KST")
                .containsEntry("liveCount", 1).containsEntry("positionCount", 2);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) out.get("positions");
        assertThat(rows.get(0)).containsEntry("ticker", "AAA").containsEntry("price", 420.0)
                .containsEntry("priceBasis", LiveValuation.LIVE).containsEntry("returnPct", 5.0)
                .containsEntry("previousClose", 410.0).containsEntry("dayChangePct", 2.44).containsEntry("weightPct", 42.0);
        assertThat(rows.get(1)).containsEntry("price", 240.0).containsEntry("priceBasis", LiveValuation.LAST_OBSERVATION)
                .containsEntry("previousClose", null).containsEntry("dayChangePct", null).containsEntry("weightPct", 48.0);
    }

    @Test
    @DisplayName("가격을 모르는 종목이 있으면 순자산·수익률은 null(0으로 채우지 않음), 출발 전 계좌도 null")
    void unknownPriceAndNotStarted() {
        BookState state = new BookState("rules", 10_000, 99_000, 89_000, 89.9, null, null, null, null);
        Map<String, Object> missing = LiveValuation.book(book("rules", "ACTIVE"), state,
                List.of(position("AAA", 100, 400, null)), null, FRI, Map.of(), Map.of(), REGULAR_FRI, OPEN.plusSeconds(60));
        assertThat(missing).containsEntry("nav", null).containsEntry("returnPct", null).containsEntry("dayChangePct", null)
                .containsEntry("basis", LiveValuation.LAST_OBSERVATION);

        Map<String, Object> notStarted = LiveValuation.book(book("rules", PaperBooks.NOT_STARTED), null, List.of(), null,
                FRI, Map.of(), Map.of(), REGULAR_FRI, OPEN);
        assertThat(notStarted).containsEntry("cash", null).containsEntry("nav", null).containsEntry("basisAtKst", null);
    }

    // ------------------------------------------------------------------ 재료
    private static LivePrice price(String at, boolean stale) {
        return price(at, stale, 100);
    }

    private static LivePrice price(String at, boolean stale, double value) {
        return new LivePrice(value, Instant.parse(at), stale);
    }

    private static NavRow nav(String date, double value) {
        return new NavRow("claude", LocalDate.parse(date), value, 0, value, 100, true);
    }

    private static Book book(String code, String status) {
        return new Book(code, "CLAUDE", code, 100_000, PaperFixtures.FRI, status, Instant.parse("2026-10-23T00:00:00Z"),
                Book.MARKET_US, "USD");
    }

    private static Position position(String ticker, int qty, double avgCost, Double lastPrice) {
        Instant at = Instant.parse("2026-10-30T09:05:00Z");
        return new Position("claude", ticker, qty, avgCost, PaperFixtures.FRI, at, avgCost, at, lastPrice,
                lastPrice == null ? null : at, false, PaperFixtures.FRI, avgCost, null);
    }

    private static Bar bar(String ticker, Map<String, Double> closes) {
        TreeMap<LocalDate, Double> values = new TreeMap<>();
        closes.forEach((date, close) -> values.put(LocalDate.parse(date), close));
        return new Bar(ticker, values.lastKey(), values.lastEntry().getValue(), false, DailySeries.of(values));
    }
}
