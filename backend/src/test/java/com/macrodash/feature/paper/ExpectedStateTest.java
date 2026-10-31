package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 장중 확인의 예상 상태({@link ExpectedState}, 계좌2 명세 §10-6) — 순수 계산(저장본·DB 없음). 작업·패킷 경로의 시험은
 * {@link PaperCheckpointJobTest}·{@link CheckpointPacketTest}.
 *
 * <p>기본: 아침 결정 d = 2026-10-30(금), E = 11-02(월, EST), 지금 10:03 ET(15:03Z).
 */
class ExpectedStateTest {

    private static final LocalDate D = LocalDate.of(2026, 10, 30);
    private static final LocalDate E = LocalDate.of(2026, 11, 2);
    private static final Instant NOW = Instant.parse("2026-11-02T15:03:00Z");
    private static final TradingCalendar CALENDAR = UsPaperMarket.INSTANCE.calendar();

    private static Order pending(long id, String ticker, String side, Double weight, String timing) {
        return new Order(id, PaperBooks.CLAUDE2, 1L, ticker, side, null, weight, null, timing, "CLAUDE",
                PaperBooks.ORDER_PENDING, null, null, D, Instant.parse("2026-10-30T22:31:00Z"), E, null);
    }

    @Test
    @DisplayName("순서는 장부 2b와 같음(기준 시각 순, 같은 T 안에서만 매도 먼저) — 뒤 T(10:00) 매도 대금은 앞 T(09:30) 매수의 현금이 아님: 현금 1,000이면 AAA 20주, 매도 뒤 현금 9,000")
    void laterSaleDoesNotFundAnEarlierBuy() {
        BookState state = new BookState(PaperBooks.CLAUDE2, 1_000, 10_000, 9_000, 90, null, null, D, null);
        Instant opened = Instant.parse("2026-10-20T20:20:00Z");
        Position msft = new Position(PaperBooks.CLAUDE2, "MSFT", 90, 100, LocalDate.of(2026, 10, 20), opened, 100, opened,
                100.0, opened, false, LocalDate.of(2026, 10, 20), 100, null);
        List<Order> orders = List.of(pending(11, "AAA", PaperBooks.BUY, 50.0, PaperBooks.NEXT_OPEN),
                pending(12, "MSFT", PaperBooks.SELL, null, PaperBooks.AT_1000));

        ExpectedState.State s = ExpectedState.of(state, List.of(msft), orders, E, NOW, null, null,
                quotes(Instant.parse("2026-11-02T14:00:00Z"), bar("AAA", E, 50.0), bar("MSFT", E, 100.0)), CALENDAR);

        assertThat(s.assumed()).extracting(ExpectedState.Assumed::orderId).containsExactly(11L, 12L);
        assertThat(s.assumed().get(0).qty()).as("09:30 매수는 그때 현금 1,000 안 — 1,000 ÷ 50").isEqualTo(20);
        assertThat(s.cash()).as("1,000 − 20 × 50 + 90 × 100").isEqualTo(9_000.0);
        assertThat(s.positions()).extracting(Position::ticker).containsExactly("AAA");
    }

    @Test
    @DisplayName("같은 기준 시각 안에서는 매도 먼저 — 같은 AT_1000의 매도 대금으로 매수")
    void sameTargetSellsFirst() {
        BookState state = new BookState(PaperBooks.CLAUDE2, 1_000, 10_000, 9_000, 90, null, null, D, null);
        Instant opened = Instant.parse("2026-10-20T20:20:00Z");
        Position msft = new Position(PaperBooks.CLAUDE2, "MSFT", 90, 100, LocalDate.of(2026, 10, 20), opened, 100, opened,
                100.0, opened, false, LocalDate.of(2026, 10, 20), 100, null);
        List<Order> orders = List.of(pending(11, "AAA", PaperBooks.BUY, 50.0, PaperBooks.AT_1000),
                pending(12, "MSFT", PaperBooks.SELL, null, PaperBooks.AT_1000));

        ExpectedState.State s = ExpectedState.of(state, List.of(msft), orders, E, NOW, null, null,
                quotes(Instant.parse("2026-11-02T14:00:00Z"), bar("AAA", E, 50.0), bar("MSFT", E, 100.0)), CALENDAR);

        assertThat(s.assumed()).extracting(ExpectedState.Assumed::orderId).containsExactly(12L, 11L);
        assertThat(s.assumed().get(1).qty()).as("50% × 10,000 ÷ 50").isEqualTo(100);
        assertThat(s.cash()).isEqualTo(5_000.0);
    }
}
