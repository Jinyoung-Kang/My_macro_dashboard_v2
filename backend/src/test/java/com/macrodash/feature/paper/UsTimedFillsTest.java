package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.ExecutionAuditFixtures.Bars;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Random;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON_DECIDED;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.TUE;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.et;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.data.Offset.offset;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 미국 시각 지정 체결({@link UsTimedFills} — 장부 2b·3a·3b, 명세 docs/specs/2026-10-30-claude-book2-timing-design.md §6-2·§8·§10·§15 '장부'). 계좌는
 * 시험용 정의({@value #BOOK} — 아직 {@code PaperBooks}에 없음, 1-5)를 가짜 저장소에 직접 둡니다. 1분봉 저장본은 수집기 모양(contract 1)을 손으로
 * 만들고({@link Bars}), 날짜는 실제 미국 달력입니다 — 기준 거래일 2026-10-26(월) → 목표 세션 E = 10-27(화, EDT — 10:00 ET = 14:00Z). 외부 호출 없음.
 */
class UsTimedFillsTest {

    /** 시험용 계좌 코드 — 시각 지정 주문을 내는 계좌2 자리(정의는 1-5). */
    private static final String BOOK = "claude2";
    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final LocalDate WED = LocalDate.of(2026, 10, 28);

    private FakePaperStore store;
    private PaperMarketData marketData;
    private MovableClock clock;
    private PaperLedgerService ledger;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        clock = new MovableClock(et(TUE, 9, 0));
        ledger = new PaperLedgerService(store, marketData, MAPPER, clock);
        activeBook(store, BOOK, PaperBooks.KIND_CLAUDE, 100_000, null);
    }

    // ------------------------------------------------------------------ 도우미
    /** 시각 지정 대기 주문 — 기준 거래일 asOf, 만료 = 목표 세션 E 하루(명세 §6-2). 수량·목표 비중·매도 비율 중 하나만. */
    private long timed(String ticker, String side, Integer qty, Double weight, Double fraction, String timing,
                       LocalDate asOf, Instant created) {
        return store.insertOrder(new Order(0, BOOK, 1L, ticker, side, qty, weight, fraction, timing, "CLAUDE",
                PaperBooks.ORDER_PENDING, null, null, asOf, created, US.nextTradingDay(asOf), null));
    }

    private long buy(String ticker, int qty, String timing) {
        return timed(ticker, PaperBooks.BUY, qty, null, null, timing, MON, MON_DECIDED);
    }

    private void bars(Bars bars) {
        when(marketData.barsUs()).thenReturn(Optional.of(bars.snapshot()));
    }

    /** 관측치 W를 처리 — 시계는 W 수집 + 90초(1분봉 기다림 상한 안). */
    private Outcome observe(Instant collectedAt, Bar... observed) {
        clock.at = collectedAt.plusSeconds(90);
        return ledger.process(quotes(collectedAt, observed));
    }

    private Order order(long id) {
        return store.orders.get(id);
    }

    private Fill fillOf(long orderId) {
        return store.fillsOf(BOOK).stream().filter(f -> f.orderId() == orderId).findFirst().orElse(null);
    }

    private ExecFill barOf(long orderId) {
        Fill fill = fillOf(orderId);
        return fill == null ? null : store.fillBars.get(fill.id());
    }

    private Position position(String ticker) {
        return store.positions(BOOK).stream().filter(p -> p.ticker().equals(ticker)).findFirst().orElse(null);
    }

    private void hold(String ticker, int qty, double avgCost, double watermark, double lastPrice) {
        store.upsertPosition(new Position(BOOK, ticker, qty, avgCost, MON, et(MON, 16, 20), watermark, et(MON, 16, 20),
                lastPrice, et(MON, 16, 20), false, MON, lastPrice, null));
    }

    /** 정규장 하루 1분봉(09:30~15:59 ET) — 시가 = base + 0.01 × 분, 거래량 1000. */
    private static Bars session(Bars bars, String ticker, LocalDate day, double base, Instant until) {
        for (int minute = 0; minute < 390; minute++) {
            Instant start = et(day, 9, 30).plus(Duration.ofMinutes(minute));
            if (!start.isBefore(until)) {
                break;
            }
            bars.bar(ticker, day, start, base + 0.01 * minute, 1000.0);
        }
        return bars;
    }

    private static double openAt(double base, LocalDate day, Instant start) {
        return base + 0.01 * Duration.between(et(day, 9, 30), start).toMinutes();
    }

    // ------------------------------------------------------------------ 검증기의 닫힌 시점(1-5)
    @Test
    @DisplayName("검증기의 닫힌 시점(계좌2 명세 §6-2·§10-5): 조기 폐장일 E(2026-11-27)의 AT_1300~AT_1500은 MALFORMED '조기 폐장 13:00 ET', 지금 + 60초 안에 지나는 시각은 LATE_FOR_TIMING, NEXT_CLOSE는 닫지 않음, 서머타임 끝난 주(E 11-02 EST)도 뉴욕 시각")
    void closedTimingsForTheValidator() {
        List<String> menu = PaperBooks.CLAUDE2_TIMINGS;
        // 11-25(수) 결정 → E = 11-27(금, 추수감사절 다음 날 조기 폐장). 결정은 11-26 07:30 KST(= 11-25 22:30Z).
        Map<String, com.macrodash.analytics.OrderValidator.Closed> early = UsTimedFills.closedTimings(menu,
                LocalDate.of(2026, 11, 25), Instant.parse("2026-11-25T22:30:00Z"), US);
        assertThat(early).containsOnlyKeys("AT_1300", "AT_1400", "AT_1500");
        assertThat(early.values()).allSatisfy(c -> {
            assertThat(c.reason()).isEqualTo(com.macrodash.analytics.OrderValidator.MALFORMED);
            assertThat(c.detail()).startsWith("조기 폐장 13:00 ET — 2026-11-27 ");
        });
        assertThat(early.get("AT_1300").detail()).contains("AT_1300(13:00 ET)은 마감 뒤라 받지 않음");

        // 늦은 수동 실행 — E(10-27) 09:59:30 ET에 검증하면 NEXT_OPEN·AT_1000(T ≤ 지금 + 60초)은 LATE_FOR_TIMING, AT_1100부터는 받음.
        Map<String, com.macrodash.analytics.OrderValidator.Closed> late = UsTimedFills.closedTimings(menu, MON,
                et(TUE, 9, 59).plusSeconds(30), US);
        assertThat(late).containsOnlyKeys("NEXT_OPEN", "AT_1000");
        assertThat(late.get("AT_1000").reason()).isEqualTo(com.macrodash.analytics.OrderValidator.LATE_FOR_TIMING);
        assertThat(late.get("AT_1000").detail()).contains("2026-10-27 10:00 ET").contains("+ 60초 이전");
        assertThat(UsTimedFills.closedTimings(menu, MON, et(TUE, 9, 58).plusSeconds(59), US)).as("정확히 61초 앞이면 받음")
                .containsOnlyKeys("NEXT_OPEN");
        assertThat(UsTimedFills.closedTimings(menu, MON, et(TUE, 9, 59), US)).as("정확히 60초 앞이면 막음(T ≤ 생성 + 60초 — ⑤)")
                .containsOnlyKeys("NEXT_OPEN", "AT_1000");

        // 서머타임 끝난 주 — 10-31(토) 07:30 KST 결정(기준 10-30 EDT)의 E = 11-02(월, EST): 닫힌 시점 없음.
        assertThat(UsTimedFills.closedTimings(menu, LocalDate.of(2026, 10, 30), Instant.parse("2026-10-30T22:30:00Z"), US))
                .isEmpty();
        assertThat(ExecutionAudit.targetAt("AT_1000", LocalDate.of(2026, 11, 2), US))
                .isEqualTo(Instant.parse("2026-11-02T15:00:00Z"));
    }

    // ------------------------------------------------------------------ 사다리
    @Nested
    @DisplayName("가격 사다리 R1·R2·R2b·R3·종가")
    class Ladder {

        @Test
        @DisplayName("R1 Y1M_AT — T 봉 시가 × (1 + 5bp), 체결 봉 = T, 장부 반영 = 관측치 수집 시각, 체결일 = E, 출처 paper.bars.us")
        void r1AtTheTargetBar() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.4, 300.0));

            Outcome outcome = observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 103.0));

            Fill fill = fillOf(id);
            assertThat(fill.rawPrice()).isEqualTo(100.0);
            assertThat(fill.price()).isCloseTo(100.05, offset(1e-9));
            assertThat(fill.qty()).isEqualTo(10);
            assertThat(fill.observedAt()).isEqualTo(et(TUE, 10, 20));
            assertThat(fill.observationDate()).isEqualTo(TUE);
            assertThat(fill.priceSource()).isEqualTo("paper.bars.us");
            assertThat(barOf(id).barAt()).isEqualTo(Instant.parse("2026-10-27T14:00:00Z"));
            assertThat(barOf(id).fillRung()).isEqualTo("Y1M_AT");
            assertThat(order(id).status()).isEqualTo("FILLED");
            assertThat(order(id).filledAt()).isEqualTo(et(TUE, 10, 20));
            assertThat(outcome.filled()).isEqualTo(1);
            assertThat(outcome.notes()).as("R1은 대체 체결이 아님").isEmpty();
        }

        @Test
        @DisplayName("R2 Y1M_NEXT — T 봉이 거래 없음이면 T+1~T+4분 첫 거래 봉 시가")
        void r2NextTradedBarInTheWindow() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 0.0)
                    .bar("AAPL", TUE, et(TUE, 10, 2), 100.7, 50.0).bar("AAPL", TUE, et(TUE, 10, 3), 100.9, 50.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 103.0));

            assertThat(fillOf(id).rawPrice()).isEqualTo(100.7);
            assertThat(barOf(id).barAt()).isEqualTo(et(TUE, 10, 2));
            assertThat(barOf(id).fillRung()).isEqualTo("Y1M_NEXT");
        }

        @Test
        @DisplayName("R2b Y1M_LATE(대체) — 창 안 거래 봉이 없고 T 뒤 첫 거래 봉(firstTradeAfter)이 있으면 그 봉 시가, 작업 기록에 대체 체결 한 줄")
        void r2bFirstTradeAfterTheWindow() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 11, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 0.0)
                    .bar("AAPL", TUE, et(TUE, 10, 37), 98.0, 400.0).bar("AAPL", TUE, et(TUE, 10, 38), 98.2, 400.0));

            Outcome outcome = observe(et(TUE, 11, 20), bar("AAPL", MON, 99.0, TUE, 97.0));

            assertThat(fillOf(id).rawPrice()).isEqualTo(98.0);
            assertThat(barOf(id).barAt()).isEqualTo(et(TUE, 10, 37));
            assertThat(barOf(id).fillRung()).isEqualTo("Y1M_LATE");
            assertThat(outcome.notes()).anySatisfy(note -> assertThat(note).contains("대체 체결(Y1M_LATE)"));
        }

        @Test
        @DisplayName("R3 QUOTES_FALLBACK(대체) — 1분봉 저장본(관측치 뒤)에 그 종목만 없으면 T + 20분 뒤 장중 관측치의 종가, 그 전에는 기다림")
        void r3OnlyWhenTheBarsThemselvesAreMissing() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 16)).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0)
                    .bar("SPY", TUE, et(TUE, 10, 15), 581.0, 9000.0));
            observe(et(TUE, 10, 15), bar("AAPL", MON, 99.0, TUE, 102.0));
            assertThat(fillOf(id)).as("T + 15분 관측치 — 아직 R3 아님").isNull();

            bars(new Bars(et(TUE, 10, 26)).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0)
                    .bar("SPY", TUE, et(TUE, 10, 25), 581.0, 9000.0));
            observe(et(TUE, 10, 25), bar("AAPL", MON, 99.0, TUE, 102.5));

            Fill fill = fillOf(id);
            assertThat(fill.rawPrice()).isEqualTo(102.5);
            assertThat(fill.priceSource()).isEqualTo("paper.quotes");
            assertThat(barOf(id).fillRung()).isEqualTo("QUOTES_FALLBACK");
            assertThat(barOf(id).barAt()).as("관측치 칸에는 1분봉 시각이 없음").isNull();
        }

        @Test
        @DisplayName("QUOTES_CLOSE(대체) — E 확정 종가 관측치(마감 + 15분 뒤)에서 1분봉 자료가 없으면 그 관측치의 E 종가")
        void quotesCloseAtTheFinalObservation() {
            long id = buy("AAPL", 10, "AT_1400");
            bars(new Bars(et(TUE, 16, 21)).bar("SPY", TUE, et(TUE, 15, 59), 581.0, 9000.0));

            Outcome outcome = observe(et(TUE, 16, 20), bar("AAPL", MON, 99.0, TUE, 104.0));

            assertThat(fillOf(id).rawPrice()).isEqualTo(104.0);
            assertThat(barOf(id).fillRung()).isEqualTo("QUOTES_CLOSE");
            assertThat(outcome.expired()).isZero();
        }

        @Test
        @DisplayName("NEXT_OPEN — E 09:30 ET 첫 봉 시가")
        void nextOpen() {
            long id = buy("AAPL", 10, "NEXT_OPEN");
            bars(new Bars(et(TUE, 9, 58)).bar("AAPL", TUE, et(TUE, 9, 30), 101.0, 9000.0)
                    .bar("AAPL", TUE, et(TUE, 9, 31), 101.3, 900.0));

            observe(et(TUE, 9, 57), bar("AAPL", MON, 99.0, TUE, 102.0));

            assertThat(barOf(id).barAt()).isEqualTo(Instant.parse("2026-10-27T13:30:00Z"));
            assertThat(fillOf(id).rawPrice()).isEqualTo(101.0);
        }
    }

    // ------------------------------------------------------------------ 조건 ⑤~⑧b
    @Nested
    @DisplayName("룩어헤드 조건 ⑤~⑧b와 장부 재검사")
    class Conditions {

        @Test
        @DisplayName("⑤ T ≤ 주문 생성 + 60초 — 체결할 수 없어 취소하고 운영 알림(LATE_FOR_TIMING)")
        void lateForTimingIsCancelledWithAnAlert() {
            long id = timed("AAPL", PaperBooks.BUY, 10, null, null, "AT_1000", MON, et(TUE, 9, 59).plusSeconds(10));
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.1, 500.0));

            Outcome outcome = observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 103.0));

            assertThat(order(id).status()).isEqualTo("CANCELLED");
            assertThat(order(id).rejectReason()).contains("LATE_FOR_TIMING");
            assertThat(outcome.alerts()).singleElement().satisfies(alert -> assertThat(alert).startsWith(BOOK + ": 장부 재검사"));
            assertThat(outcome.errors()).as("장부 오류(되돌림)가 아님").isEmpty();
            assertThat(fillOf(id)).isNull();
        }

        @Test
        @DisplayName("⑤ 경계 — 주문 생성이 T − 60초 정각이면(T = 생성 + 60초) 체결하지 않고 취소(LATE_FOR_TIMING), T − 61초면 T 봉으로 체결")
        void lateForTimingAtExactlySixtySeconds() {
            long exact = timed("AAPL", PaperBooks.BUY, 10, null, null, "AT_1000", MON, et(TUE, 9, 59));
            long inTime = timed("MSFT", PaperBooks.BUY, 10, null, null, "AT_1000", MON, et(TUE, 9, 58).plusSeconds(59));
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.1, 500.0).bar("MSFT", TUE, et(TUE, 10, 0), 300.0, 500.0)
                    .bar("MSFT", TUE, et(TUE, 10, 1), 300.1, 500.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 103.0), bar("MSFT", MON, 299.0, TUE, 303.0));

            assertThat(order(exact).status()).isEqualTo("CANCELLED");
            assertThat(order(exact).rejectReason()).contains("LATE_FOR_TIMING");
            assertThat(fillOf(exact)).isNull();
            assertThat(fillOf(inTime).rawPrice()).isEqualTo(300.0);
        }

        @Test
        @DisplayName("⑤ 창에 잘못 든 T 앞 봉은 건너뛰고 T 봉으로")
        void barBeforeTheTargetIsSkipped() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 21)).barIn("10:00", "AAPL", TUE, et(TUE, 9, 59), 99.0, 100.0)
                    .bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 100.0).bar("AAPL", TUE, et(TUE, 10, 1), 100.2, 100.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 103.0));

            assertThat(barOf(id).barAt()).isEqualTo(et(TUE, 10, 0));
        }

        @Test
        @DisplayName("⑤⑥ 장부 재검사 — 수집기 값이 틀린 T 뒤 첫 거래 봉(T 앞·다른 날)으로는 체결하지 않고 알림, 대기 그대로 → 세션이 끝나면 RECHECK_FAILED 만료")
        void recheckRefusesACorruptFirstTrade() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 11, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 0.0)
                    .bar("AAPL", TUE, et(TUE, 11, 0), 101.0, 0.0)
                    .firstTradeAfter("10:00", "AAPL", TUE, et(TUE, 9, 45), 97.0, 300.0));

            Outcome first = observe(et(TUE, 11, 20), bar("AAPL", MON, 99.0, TUE, 103.0));
            assertThat(fillOf(id)).isNull();
            assertThat(order(id).status()).isEqualTo("PENDING");
            assertThat(first.alerts()).singleElement().satisfies(alert -> assertThat(alert).contains("장부 재검사 오류")
                    .contains("⑤"));

            bars(new Bars(et(TUE, 16, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 0.0)
                    .bar("AAPL", TUE, et(TUE, 15, 59), 101.0, 0.0)
                    .firstTradeAfter("10:00", "AAPL", TUE, et(WED, 10, 0), 97.0, 300.0));
            Outcome last = observe(et(TUE, 16, 20), bar("AAPL", MON, 99.0, TUE, 103.0));
            assertThat(order(id).status()).isEqualTo("EXPIRED");
            assertThat(order(id).rejectReason()).startsWith("RECHECK_FAILED").contains("⑥");
            assertThat(last.expired()).isEqualTo(1);
        }

        @Test
        @DisplayName("⑦ 진행 중일 수 있는 봉(그 뒤 봉 없음, 마감 + 15분 전 수집)은 쓰지 않고 기다림 → 다음 저장본에서 체결")
        void unfinishedBarWaits() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 0.0)
                    .bar("AAPL", TUE, et(TUE, 10, 4), 100.4, 10.0));
            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 103.0));
            assertThat(fillOf(id)).isNull();

            bars(new Bars(et(TUE, 11, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 0.0)
                    .bar("AAPL", TUE, et(TUE, 10, 4), 100.4, 10.0).bar("AAPL", TUE, et(TUE, 10, 5), 100.6, 10.0));
            observe(et(TUE, 11, 20), bar("AAPL", MON, 99.0, TUE, 103.0));
            assertThat(barOf(id).barAt()).isEqualTo(et(TUE, 10, 4));
            assertThat(barOf(id).fillRung()).isEqualTo("Y1M_NEXT");
        }

        @Test
        @DisplayName("⑧ 이어받은 종목 항목 — W 전 저장본이면 기다리고, W 뒤 저장본이면 '종목만 받지 못함'(1분봉 자료 없음 — R3 조건)")
        void staleTickerEntry() {
            long id = buy("AAPL", 10, "AT_1000");
            clock.at = et(TUE, 10, 50);
            bars(new Bars(et(TUE, 10, 19)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.2, 500.0).stale("AAPL"));
            ledger.process(quotes(et(TUE, 10, 30), bar("AAPL", MON, 99.0, TUE, 102.0)));   // 상한이 지나 W 전 저장본으로
            assertThat(fillOf(id)).as("이어받은 항목의 봉으로는 체결하지 않음").isNull();

            bars(new Bars(et(TUE, 11, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.2, 500.0).stale("AAPL"));
            observe(et(TUE, 11, 20), bar("AAPL", MON, 99.0, TUE, 102.5));
            assertThat(barOf(id).fillRung()).isEqualTo("QUOTES_FALLBACK");
            assertThat(fillOf(id).rawPrice()).isEqualTo(102.5);
        }

        @Test
        @DisplayName("⑧ 거래량 0(또는 모름) 봉뿐이면 체결하지 않음 — 마감 + 15분 뒤 저장본에서도 T 뒤 거래가 없으면 NO_TRADE_AFTER_T 만료")
        void zeroVolumeOnly() {
            long id = buy("AAPL", 10, "AT_1000");
            Bars intraday = new Bars(et(TUE, 11, 21));
            for (int m = 0; m < 80; m++) {
                intraday.bar("AAPL", TUE, et(TUE, 10, 0).plus(Duration.ofMinutes(m)), 100.0, m % 2 == 0 ? 0.0 : null);
            }
            bars(intraday);
            observe(et(TUE, 11, 20), bar("AAPL", MON, 99.0, TUE, 100.0));
            assertThat(order(id).status()).isEqualTo("PENDING");

            Bars closing = new Bars(et(TUE, 16, 21));
            for (int m = 0; m < 360; m++) {
                closing.bar("AAPL", TUE, et(TUE, 10, 0).plus(Duration.ofMinutes(m)), 100.0, 0.0);
            }
            bars(closing);
            Outcome outcome = observe(et(TUE, 16, 20), bar("AAPL", MON, 99.0, TUE, 100.0));

            assertThat(order(id).status()).isEqualTo("EXPIRED");
            assertThat(order(id).rejectReason()).startsWith("NO_TRADE_AFTER_T");
            assertThat(fillOf(id)).as("멈춘 가격(관측치의 그날 값)으로 채우지 않음").isNull();
            assertThat(outcome.expired()).isEqualTo(1);
        }

        @Test
        @DisplayName("⑧b 종일 거래 정지(그 종목만 E 세션 없음, SPY는 있음) — 관측치에 그날 값이 있어도 R3·종가로 채우지 않고 마감 뒤 NO_TRADE_AFTER_T")
        void haltedAllDayIsNotFilledWithAFrozenPrice() {
            long id = buy("HALT", 10, "AT_1000");
            bars(new Bars(et(TUE, 11, 21)).bar("HALT", MON, et(MON, 15, 59), 50.0, 100.0)
                    .bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0).bar("SPY", TUE, et(TUE, 11, 19), 581.0, 9000.0));
            observe(et(TUE, 11, 20), bar("HALT", MON, 50.0, TUE, 50.0));
            assertThat(order(id).status()).isEqualTo("PENDING");

            bars(new Bars(et(TUE, 16, 21)).bar("HALT", MON, et(MON, 15, 59), 50.0, 100.0)
                    .bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0).bar("SPY", TUE, et(TUE, 15, 59), 581.0, 9000.0));
            observe(et(TUE, 16, 20), bar("HALT", MON, 50.0, TUE, 50.0));

            assertThat(order(id).status()).isEqualTo("EXPIRED");
            assertThat(order(id).rejectReason()).startsWith("NO_TRADE_AFTER_T").contains("거래 정지");
            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(store.states.get(BOOK).cash()).isEqualTo(100_000);
        }

        @Test
        @DisplayName("거래 정지 뒤 T 뒤 재개 — 재개 첫 거래 봉(R2b)으로 체결")
        void resumedAfterTheTarget() {
            long id = buy("HALT", 10, "AT_1000");
            bars(new Bars(et(TUE, 14, 21)).bar("HALT", TUE, et(TUE, 13, 7), 47.0, 2000.0)
                    .bar("HALT", TUE, et(TUE, 13, 8), 47.5, 2000.0));

            observe(et(TUE, 14, 20), bar("HALT", MON, 50.0, TUE, 48.0));

            assertThat(barOf(id).fillRung()).isEqualTo("Y1M_LATE");
            assertThat(barOf(id).barAt()).isEqualTo(et(TUE, 13, 7));
            assertThat(fillOf(id).rawPrice()).isEqualTo(47.0);
        }
    }

    // ------------------------------------------------------------------ 수량·현금·평가
    @Nested
    @DisplayName("수량은 T 시각의 순자산, 평가는 W의 봉(3b)")
    class Quantities {

        @Test
        @DisplayName("목표 비중 매수 = 비중 × (현금 + 보유 × 같은 T 창 시가) — W 관측가·갱신 전 평가 가격을 쓰지 않음")
        void navAtTheTarget() {
            store.states.put(BOOK, new com.macrodash.store.PaperStore.BookState(BOOK, 10_000, 15_000, 5_000, 33, null,
                    null, null, null));
            hold("ZZZ", 100, 50, 50, 50.0);
            long id = timed("AAPL", PaperBooks.BUY, null, 10.0, null, "AT_1000", MON, MON_DECIDED);
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0)
                    .bar("ZZZ", TUE, et(TUE, 10, 0), 60.0, 500.0).bar("ZZZ", TUE, et(TUE, 10, 1), 60.0, 500.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 101.0), bar("ZZZ", MON, 50.0, TUE, 70.0));

            // T 순자산 = 10,000 + 100 × 60 = 16,000 → 1,600 ÷ 100.05 = 15.99 → 15주(W 가격 70이면 16주, 갱신 전 50이면 14주)
            assertThat(fillOf(id).qty()).isEqualTo(15);
        }

        @Test
        @DisplayName("보유 종목의 T 창 봉이 없으면 갱신 전 평가 가격(W 관측가가 아님)")
        void navFallsBackToThePriceBeforeTheUpdate() {
            store.states.put(BOOK, new com.macrodash.store.PaperStore.BookState(BOOK, 10_000, 15_000, 5_000, 33, null,
                    null, null, null));
            hold("ZZZ", 100, 50, 50, 50.0);
            long id = timed("AAPL", PaperBooks.BUY, null, 10.0, null, "AT_1000", MON, MON_DECIDED);
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 101.0), bar("ZZZ", MON, 50.0, TUE, 70.0));

            assertThat(fillOf(id).qty()).as("15,000 × 10% ÷ 100.05 = 14.99").isEqualTo(14);
        }

        @Test
        @DisplayName("현금이 모자라면 줄여 사고 cashLimited·requestedQty·filledQty, 1주도 못 사면 취소")
        void cashLimited() {
            store.states.put(BOOK, new com.macrodash.store.PaperStore.BookState(BOOK, 10_000, 10_000, 0, 0, null, null,
                    null, null));
            long many = buy("AAPL", 200, "AT_1000");
            long none = buy("MSFT", 5, "AT_1100");
            bars(new Bars(et(TUE, 11, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0).bar("MSFT", TUE, et(TUE, 11, 0), 400.0, 500.0)
                    .bar("MSFT", TUE, et(TUE, 11, 1), 400.0, 500.0));

            Outcome outcome = observe(et(TUE, 11, 20), bar("AAPL", MON, 99.0, TUE, 101.0),
                    bar("MSFT", MON, 399.0, TUE, 401.0));

            assertThat(fillOf(many).qty()).isEqualTo(99);
            assertThat(order(many).reason().path("cashLimited").asBoolean()).isTrue();
            assertThat(order(many).reason().path("requestedQty").asInt()).isEqualTo(200);
            assertThat(order(many).reason().path("filledQty").asInt()).isEqualTo(99);
            assertThat(order(none).status()).isEqualTo("CANCELLED");
            assertThat(order(none).rejectReason()).contains("현금이 모자라");
            assertThat(outcome.notes()).anySatisfy(note -> assertThat(note).contains("cashLimited"));
        }

        @Test
        @DisplayName("보유 없는 매도는 취소")
        void sellWithoutAHoldingIsCancelled() {
            long id = timed("AAPL", PaperBooks.SELL, null, null, null, "AT_1000", MON, MON_DECIDED);
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 101.0));

            assertThat(order(id).status()).isEqualTo("CANCELLED");
            assertThat(order(id).rejectReason()).contains("보유가 없습니다");
        }

        @Test
        @DisplayName("같은 T에서는 매도 → 매수 — 매도 대금으로 산다(현금성은 마지막)")
        void sameTargetSellsFirstCashLikeLast() {
            store.states.put(BOOK, new com.macrodash.store.PaperStore.BookState(BOOK, 2_000, 7_000, 5_000, 70, null,
                    null, null, null));
            hold("BBB", 100, 45, 50, 50.0);
            long shy = timed("SHY", PaperBooks.BUY, 30, null, null, "AT_1000", MON, MON_DECIDED);
            long aapl = buy("AAPL", 60, "AT_1000");
            long sell = timed("BBB", PaperBooks.SELL, null, null, null, "AT_1000", MON, MON_DECIDED);
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0).bar("BBB", TUE, et(TUE, 10, 0), 50.0, 500.0)
                    .bar("BBB", TUE, et(TUE, 10, 1), 50.0, 500.0).bar("SHY", TUE, et(TUE, 10, 0), 82.0, 500.0)
                    .bar("SHY", TUE, et(TUE, 10, 1), 82.0, 500.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 101.0), bar("BBB", MON, 50.0, TUE, 50.0),
                    bar("SHY", MON, 82.0, TUE, 82.0));

            assertThat(fillOf(sell).qty()).isEqualTo(100);
            assertThat(fillOf(aapl).qty()).as("2,000 + 4,997.5 = 6,997.5 → 60 × 100.05 = 6,003").isEqualTo(60);
            // 남은 현금 994.5 → SHY 30주(82.041 × 30 = 2,461) 중 12주만(현금성 마지막)
            assertThat(fillOf(shy).qty()).isEqualTo(12);
        }

        @Test
        @DisplayName("새 보유: 최고가는 체결가부터, 분할 기준은 W 저장본의 E 직전 거래일 종가, 평가 가격은 W의 봉(3b) — W에 값이 없으면 T 가격 그대로 '가격 없음'")
        void newHoldingBasisAndRevaluation() {
            long aapl = buy("AAPL", 10, "AT_1000");
            long msft = buy("MSFT", 2, "AT_1000");
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0).bar("MSFT", TUE, et(TUE, 10, 0), 400.0, 500.0)
                    .bar("MSFT", TUE, et(TUE, 10, 1), 400.0, 500.0));

            observe(et(TUE, 10, 20), bar("AAPL", MON, 98.0, TUE, 99.0));

            Position held = position("AAPL");
            assertThat(held.highWatermark()).as("W 99 < 체결가 100.05").isEqualTo(100.05);
            assertThat(held.fillRefDate()).isEqualTo(MON);
            assertThat(held.fillRefClose()).isEqualTo(98.0);
            assertThat(held.openedOn()).isEqualTo(TUE);
            assertThat(held.lastPrice()).isEqualTo(99.0);
            assertThat(held.lastPriceAt()).isEqualTo(et(TUE, 10, 20));
            assertThat(held.priceStale()).isFalse();
            Position noQuote = position("MSFT");
            assertThat(noQuote.lastPrice()).isEqualTo(400.0);
            assertThat(noQuote.lastPriceAt()).isEqualTo(et(TUE, 10, 0));
            assertThat(noQuote.priceStale()).isTrue();
            assertThat(fillOf(msft)).isNotNull();
            assertThat(fillOf(aapl)).isNotNull();
            assertThat(store.states.get(BOOK).nav()).as("현금 + 10 × 99 + 2 × 400")
                    .isCloseTo(100_000 - 10 * 100.05 - 2 * 400.2 + 10 * 99 + 2 * 400, offset(1e-6));
        }
    }

    // ------------------------------------------------------------------ 스탑과의 순서
    @Nested
    @DisplayName("시간별 스탑과의 순서")
    class Stops {

        @Test
        @DisplayName("T(10:00) 매도가 W(11:20) 스탑보다 먼저 — 10:00 봉으로 팔고 스탑·재진입 금지 없음")
        void timedSellBeforeTheHourlyStop() {
            hold("XXX", 100, 90, 100, 100.0);
            long id = timed("XXX", PaperBooks.SELL, null, null, null, "AT_1000", MON, MON_DECIDED);
            bars(new Bars(et(TUE, 11, 21)).bar("XXX", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("XXX", TUE, et(TUE, 10, 1), 97.0, 500.0));

            Outcome outcome = observe(et(TUE, 11, 20), bar("XXX", MON, 100.0, TUE, 90.0));

            assertThat(fillOf(id).rawPrice()).isEqualTo(97.0);
            assertThat(outcome.stopped()).isZero();
            assertThat(store.lockouts(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("W(10:02)가 T(10:00) 창을 다 본 1분봉 전 — 시각 지정 매도가 대기로 남으면 그 종목은 이 W의 스탑에서 빼고(작업 기록 한 줄), 다음 W(11:02)에서 그 매도를 10:00 봉으로 먼저 풂 — 스탑·재진입 금지 없음")
        void pendingTimedSellDefersTheStopAtThatObservation() {
            hold("XXX", 100, 90, 100, 100.0);
            long id = timed("XXX", PaperBooks.SELL, null, null, null, "AT_1000", MON, MON_DECIDED);
            bars(new Bars(et(TUE, 10, 3)).bar("XXX", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("XXX", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));

            Outcome first = observe(et(TUE, 10, 2), bar("XXX", MON, 100.0, TUE, 90.0));

            assertThat(order(id).status()).as("1분봉 저장본이 T + 6분 전 — 아직 모름").isEqualTo("PENDING");
            assertThat(first.stopped()).isZero();
            assertThat(store.lockouts(BOOK)).isEmpty();
            assertThat(first.notes()).anySatisfy(note -> assertThat(note).contains("XXX 스탑 판정을 다음 관측치로 미룸"));

            bars(new Bars(et(TUE, 11, 3)).bar("XXX", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("XXX", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));
            Outcome second = observe(et(TUE, 11, 2), bar("XXX", MON, 100.0, TUE, 89.0));

            assertThat(fillOf(id).rawPrice()).isEqualTo(97.0);
            assertThat(second.stopped()).isZero();
            assertThat(store.lockouts(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("시각 지정 매수가 대기로 남은 종목도 그 W의 스탑에서 뺌 — 다음 W에서 T 매수를 10:00 봉으로 먼저 푼 뒤 스탑을 봄(늘어난 보유를 그 W 관측가로 팖, 재진입 금지로 취소되지 않음)")
        void pendingTimedBuyIsResolvedBeforeTheStop() {
            hold("YYY", 100, 90, 100, 100.0);
            long id = buy("YYY", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 3)).bar("YYY", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("YYY", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));

            Outcome first = observe(et(TUE, 10, 2), bar("YYY", MON, 100.0, TUE, 90.0));
            assertThat(first.stopped()).isZero();
            assertThat(order(id).status()).isEqualTo("PENDING");

            bars(new Bars(et(TUE, 11, 3)).bar("YYY", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("YYY", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));
            Outcome second = observe(et(TUE, 11, 2), bar("YYY", MON, 100.0, TUE, 89.0));

            assertThat(order(id).status()).isEqualTo("FILLED");
            assertThat(fillOf(id).rawPrice()).isEqualTo(97.0);
            assertThat(second.stopped()).as("T 매수 뒤의 스탑 — 110주").isEqualTo(1);
            assertThat(position("YYY")).isNull();
            assertThat(store.lockouts(BOOK)).extracting(Lockout::ticker).containsExactly("YYY");
        }

        @Test
        @Disabled("F5 재현 — 늦게 풂 문턱 T + 65분이 '다음 관측치에서 풂'(W2 ≈ T + 60~66분) 한가운데라 W1이 T + 5분 뒤면 늦음으로 셈. 수정 커밋에서 뗌")
        @DisplayName("W1(10:05:30)이 T + 6분 전이라 그 1분봉 저장본(10:05:45)이 T 창을 다 보지 못하면 다음 W2(11:05:30 = T + 65분 30초)에서 R1로 풂 — 늦게 풂이 아님(W1이 10:04면 W2 11:04와 같은 원인·같은 판정)")
        void resolvedAtTheNextObservationIsNotLate() {
            long id = buy("AAA", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 5).plusSeconds(45)).bar("AAA", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("AAA", TUE, et(TUE, 10, 1), 97.2, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));

            observe(et(TUE, 10, 5).plusSeconds(30), bar("AAA", MON, 96.0, TUE, 97.5));
            assertThat(order(id).status()).as("1분봉 저장본이 T + 6분 전 — 아직 모름").isEqualTo("PENDING");

            bars(new Bars(et(TUE, 11, 6)).bar("AAA", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("AAA", TUE, et(TUE, 10, 1), 97.2, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));
            observe(et(TUE, 11, 5).plusSeconds(30), bar("AAA", MON, 96.0, TUE, 98.0));

            assertThat(barOf(id).fillRung()).isEqualTo("Y1M_AT");
            assertThat(fillOf(id).observedAt()).as("장부 반영 = W2").isEqualTo(et(TUE, 11, 5).plusSeconds(30));
            assertThat(ExecutionAudit.lateResolved(order(id), barOf(id), US))
                    .as("T 뒤 첫 관측치가 T 창을 볼 수 없었던 경우의 다음 관측치 — 늦게 풂이 아님").isFalse();
        }

        @Test
        @DisplayName("미룬 스탑은 다음 W의 관측가로 다시 판정 — 미룬 W(10:02)의 트리거(90 ≤ 스탑 92)는 이어 가지 않아, 다음 W(11:02)에 스탑 위로 돌아온 종목(95)은 스탑·재진입 금지 없음, 아직 아래인 종목(89)은 미룬 W 가격(90)이 아니라 다음 W 가격에 팖")
        void deferredStopIsJudgedAgainAtTheNextObservation() {
            hold("YYY", 100, 90, 100, 100.0);
            hold("ZZZ", 100, 90, 100, 100.0);
            long yyy = buy("YYY", 10, "AT_1000");
            long zzz = buy("ZZZ", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 3)).bar("YYY", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("YYY", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("ZZZ", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("ZZZ", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));

            Outcome first = observe(et(TUE, 10, 2), bar("YYY", MON, 100.0, TUE, 90.0), bar("ZZZ", MON, 100.0, TUE, 90.0));
            assertThat(first.stopped()).isZero();
            assertThat(first.notes()).anySatisfy(note -> assertThat(note).contains("YYY 스탑 판정을 다음 관측치로 미룸"))
                    .anySatisfy(note -> assertThat(note).contains("ZZZ 스탑 판정을 다음 관측치로 미룸"));

            bars(new Bars(et(TUE, 11, 3)).bar("YYY", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("YYY", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("ZZZ", TUE, et(TUE, 10, 0), 97.0, 500.0)
                    .bar("ZZZ", TUE, et(TUE, 10, 1), 97.0, 500.0).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));
            Outcome second = observe(et(TUE, 11, 2), bar("YYY", MON, 100.0, TUE, 95.0), bar("ZZZ", MON, 100.0, TUE, 89.0));

            assertThat(fillOf(yyy).rawPrice()).isEqualTo(97.0);
            assertThat(fillOf(zzz).rawPrice()).isEqualTo(97.0);
            assertThat(second.stopped()).as("ZZZ만 — YYY는 다음 W 관측가 95 > 스탑 92").isEqualTo(1);
            assertThat(position("YYY").qty()).as("미룬 W의 트리거는 남지 않음 — 보유 + T 매수").isEqualTo(110);
            assertThat(position("ZZZ")).isNull();
            assertThat(store.fillsOf(BOOK)).filteredOn(f -> f.ticker().equals("ZZZ") && f.side().equals(PaperBooks.SELL))
                    .singleElement().satisfies(f -> assertThat(f.rawPrice()).as("다음 W 가격").isEqualTo(89.0));
            assertThat(store.lockouts(BOOK)).extracting(Lockout::ticker).containsExactly("ZZZ");
        }

        @Test
        @DisplayName("W1 스탑이 건 재진입 금지는 그 뒤 T의 시각 지정 매수를 막는다(E로 판정)")
        void stopLockoutCancelsALaterTimedBuy() {
            hold("YYY", 100, 90, 100, 100.0);
            long id = buy("YYY", 10, "AT_1100");
            bars(new Bars(et(TUE, 10, 21)).bar("SPY", TUE, et(TUE, 10, 0), 580.0, 9000.0));
            Outcome first = observe(et(TUE, 10, 20), bar("YYY", MON, 100.0, TUE, 91.0));
            assertThat(first.stopped()).isEqualTo(1);
            assertThat(store.lockouts(BOOK)).extracting(Lockout::ticker).containsExactly("YYY");

            bars(new Bars(et(TUE, 11, 21)).bar("YYY", TUE, et(TUE, 11, 0), 92.0, 500.0)
                    .bar("YYY", TUE, et(TUE, 11, 1), 92.0, 500.0));
            observe(et(TUE, 11, 20), bar("YYY", MON, 100.0, TUE, 92.5));

            assertThat(order(id).status()).isEqualTo("CANCELLED");
            assertThat(order(id).rejectReason()).contains("재진입 금지");
        }
    }

    // ------------------------------------------------------------------ 멱등·상태·만료
    @Nested
    @DisplayName("멱등·일시정지·만료 순서·시간별 경로 제외")
    class State {

        @Test
        @DisplayName("같은 관측치를 두 번 처리해도, 같은 1분봉 저장본으로 다음 관측치를 처리해도 체결은 한 번")
        void onceOnly() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0));
            var w = quotes(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 101.0));
            clock.at = et(TUE, 10, 22);
            ledger.process(w);
            ledger.process(w);
            observe(et(TUE, 11, 20), bar("AAPL", MON, 99.0, TUE, 102.0));

            assertThat(store.fillsOf(BOOK)).hasSize(1);
            assertThat(fillOf(id).observedAt()).isEqualTo(et(TUE, 10, 20));
        }

        @Test
        @DisplayName("일시정지 계좌 — 대기로 남은 시각 지정 주문을 체결하지 않고 기다리지도 않음")
        void pausedBook() {
            store.updateBookStatus(BOOK, PaperBooks.PAUSED);
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 9, 0)));

            Outcome outcome = observe(et(TUE, 10, 20), bar("AAPL", MON, 99.0, TUE, 101.0));

            assertThat(outcome.booksProcessed()).containsExactly(BOOK);
            assertThat(outcome.waiting()).isEmpty();
            assertThat(order(id).status()).isEqualTo("PENDING");
            assertThat(store.fillsOf(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("시간별 경로(fillable)는 시각 지정 주문을 체결하지 않는다 — 1분봉이 없고 T + 20분 전이면 W 봉(E, 새 값)이 있어도 대기")
        void hourlyPathNeverFillsTimedOrders() {
            long sell = timed("AAPL", PaperBooks.SELL, null, null, null, "AT_1000", MON, MON_DECIDED);
            hold("AAPL", 10, 90, 100, 100.0);
            long buy = buy("MSFT", 1, "NEXT_OPEN");
            clock.at = et(TUE, 10, 40);   // 상한이 지나 1분봉 저장본 없이

            Outcome outcome = ledger.process(quotes(et(TUE, 10, 10), bar("AAPL", MON, 99.0, TUE, 101.0),
                    bar("MSFT", MON, 399.0, TUE, 401.0)));

            assertThat(outcome.booksProcessed()).containsExactly(BOOK);
            assertThat(order(sell).status()).isEqualTo("PENDING");
            assertThat(order(buy).status()).isEqualTo("PENDING");
            assertThat(store.fillsOf(BOOK)).isEmpty();
            assertThat(outcome.notes()).as("시간별 매도의 '보유 없음' 취소도 없음").isEmpty();
        }

        @Test
        @DisplayName("만료(1단계)는 시각 지정 주문을 빼고 — E가 지난 뒤(E+1 장중)에도 2b가 E 1분봉으로 먼저 풂, 다른 시점 주문은 그대로 만료")
        void expiryComesAfterTimedFills() {
            long timedId = buy("AAPL", 10, "AT_1000");
            long hourly = store.insertOrder(new Order(0, BOOK, 1L, "MSFT", PaperBooks.BUY, 1, null, null,
                    "NEXT_OBSERVATION", "CLAUDE", "PENDING", null, null, LocalDate.of(2026, 10, 21), et(MON, 8, 0),
                    MON, null));
            bars(new Bars(et(WED, 11, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0).bar("AAPL", WED, et(WED, 10, 0), 120.0, 500.0)
                    .bar("AAPL", WED, et(WED, 10, 1), 120.0, 500.0));

            Outcome outcome = observe(et(WED, 11, 20), bar("AAPL", TUE, 101.0, WED, 121.0),
                    bar("MSFT", TUE, 401.0, WED, 402.0));

            assertThat(fillOf(timedId).rawPrice()).as("E(화) 10:00 봉 — E+1(수) 가격이 아님").isEqualTo(100.0);
            assertThat(fillOf(timedId).observationDate()).isEqualTo(TUE);
            assertThat(order(hourly).status()).isEqualTo("EXPIRED");
            assertThat(outcome.expired()).isEqualTo(1);
        }
    }

    // ------------------------------------------------------------------ 달력
    @Nested
    @DisplayName("서머타임·휴장·조기 폐장·임시 휴장")
    class Calendar {

        @Test
        @DisplayName("서머타임이 끝난 주(2026-11-02 EST): 10:00 ET = 15:00Z = 00:00 KST — 고정 오프셋(14:00Z) 봉은 쓰지 않음")
        void dstEndWeek() {
            LocalDate mon = LocalDate.of(2026, 11, 2);
            long id = timed("AAPL", PaperBooks.BUY, 10, null, null, "AT_1000", LocalDate.of(2026, 10, 30),
                    Instant.parse("2026-10-30T22:31:00Z"));
            bars(new Bars(Instant.parse("2026-11-02T16:21:00Z"))
                    .barIn("10:00", "AAPL", mon, Instant.parse("2026-11-02T14:00:00Z"), 90.0, 500.0)
                    .bar("AAPL", mon, Instant.parse("2026-11-02T15:00:00Z"), 100.0, 500.0)
                    .bar("AAPL", mon, Instant.parse("2026-11-02T15:01:00Z"), 100.1, 500.0));

            observe(Instant.parse("2026-11-02T16:20:00Z"), bar("AAPL", LocalDate.of(2026, 10, 30), 99.0, mon, 101.0));

            assertThat(barOf(id).barAt()).isEqualTo(Instant.parse("2026-11-02T15:00:00Z"));
            assertThat(barOf(id).barAt().atZone(ZoneId.of("Asia/Seoul")).toLocalTime().toString()).isEqualTo("00:00");
            assertThat(fillOf(id).rawPrice()).isEqualTo(100.0);
        }

        @Test
        @DisplayName("서머타임이 시작한 주(2027-03-15 EDT): 10:00 ET = 14:00Z")
        void dstStartWeek() {
            LocalDate mon = LocalDate.of(2027, 3, 15);
            long id = timed("AAPL", PaperBooks.BUY, 10, null, null, "AT_1000", LocalDate.of(2027, 3, 12),
                    Instant.parse("2027-03-12T22:31:00Z"));
            bars(new Bars(Instant.parse("2027-03-15T15:21:00Z"))
                    .bar("AAPL", mon, Instant.parse("2027-03-15T14:00:00Z"), 100.0, 500.0)
                    .bar("AAPL", mon, Instant.parse("2027-03-15T14:01:00Z"), 100.1, 500.0));

            observe(Instant.parse("2027-03-15T15:20:00Z"), bar("AAPL", LocalDate.of(2027, 3, 12), 99.0, mon, 101.0));

            assertThat(barOf(id).barAt()).isEqualTo(Instant.parse("2027-03-15T14:00:00Z"));
        }

        @Test
        @DisplayName("휴장(추수감사절) 다음 거래일이 E, 조기 폐장일(13:00)의 AT_1200은 체결·AT_1300은 마감 뒤라 취소 + 알림")
        void holidayAndEarlyClose() {
            LocalDate wed = LocalDate.of(2026, 11, 25);
            LocalDate fri = LocalDate.of(2026, 11, 27);
            Instant created = Instant.parse("2026-11-25T22:31:00Z");
            long noon = timed("AAPL", PaperBooks.BUY, 10, null, null, "AT_1200", wed, created);
            long late = timed("MSFT", PaperBooks.BUY, 1, null, null, "AT_1300", wed, created);
            bars(new Bars(et(fri, 13, 21)).bar("AAPL", fri, et(fri, 12, 0), 100.0, 500.0)
                    .bar("AAPL", fri, et(fri, 12, 1), 100.0, 500.0).bar("MSFT", fri, et(fri, 12, 59), 400.0, 500.0));

            Outcome outcome = observe(et(fri, 13, 20), bar("AAPL", wed, 99.0, fri, 101.0),
                    bar("MSFT", wed, 399.0, fri, 401.0));

            assertThat(fillOf(noon).observationDate()).isEqualTo(fri);
            assertThat(order(late).status()).isEqualTo("CANCELLED");
            assertThat(order(late).rejectReason()).contains("조기 폐장");
            assertThat(outcome.alerts()).hasSize(1);
        }

        @Test
        @DisplayName("임시 휴장(달력은 거래일, 1분봉·일봉 모두 E 없음) — 마감 + 15분 뒤 NO_SESSION_BARS 만료")
        void temporaryClosure() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 16, 21)).bar("AAPL", MON, et(MON, 15, 59), 99.0, 100.0)
                    .bar("SPY", MON, et(MON, 15, 59), 580.0, 9000.0));
            Outcome intraday = observe(et(TUE, 11, 20), bar("AAPL", FRI_BEFORE, 98.0, MON, 99.0));
            assertThat(order(id).status()).as("장중 — 관측치에도 E 봉이 없어 R3 없음").isEqualTo("PENDING");
            assertThat(intraday.filled()).isZero();

            observe(et(TUE, 16, 20), bar("AAPL", FRI_BEFORE, 98.0, MON, 99.0));

            assertThat(order(id).status()).isEqualTo("EXPIRED");
            assertThat(order(id).rejectReason()).startsWith("NO_SESSION_BARS");
        }
    }

    private static final LocalDate FRI_BEFORE = LocalDate.of(2026, 10, 23);

    // ------------------------------------------------------------------ 서버가 꺼졌던 경우
    @Nested
    @DisplayName("서버가 꺼졌던 경우 — E 주문은 E 가격으로만")
    class ServerDown {

        @Test
        @DisplayName("E 장중에 꺼져 E+1 개장 전에 켜짐 — 5d 1분봉으로 E 가격 체결, 1분봉이 없는 종목은 그 관측치의 E 종가(QUOTES_CLOSE)")
        void backBeforeTheNextOpen() {
            long ten = buy("AAPL", 10, "AT_1000");
            long two = buy("MSFT", 2, "AT_1400");
            long none = buy("CCC", 5, "AT_1100");
            Bars catchUp = new Bars(et(WED, 8, 56));
            session(catchUp, "AAPL", TUE, 100, et(TUE, 16, 0));
            session(catchUp, "MSFT", TUE, 400, et(TUE, 16, 0));
            session(catchUp, "SPY", TUE, 580, et(TUE, 16, 0));
            bars(catchUp);

            observe(et(WED, 8, 55), bar("AAPL", MON, 99.0, TUE, 104.0), bar("MSFT", MON, 399.0, TUE, 405.0),
                    bar("CCC", MON, 20.0, TUE, 21.0));

            assertThat(fillOf(ten).rawPrice()).isCloseTo(openAt(100, TUE, et(TUE, 10, 0)), offset(1e-9));
            assertThat(fillOf(two).rawPrice()).isCloseTo(openAt(400, TUE, et(TUE, 14, 0)), offset(1e-9));
            assertThat(barOf(none).fillRung()).isEqualTo("QUOTES_CLOSE");
            assertThat(fillOf(none).rawPrice()).isEqualTo(21.0);
            assertThat(store.fillsOf(BOOK)).allSatisfy(f -> assertThat(f.observationDate()).isEqualTo(TUE));
        }

        @Test
        @DisplayName("E+1 장중에 켜짐 — 만료보다 2b가 먼저(E 1분봉으로), 1분봉이 없는 종목은 E+1 가격으로 채우지 않고 NO_BARS 만료")
        void backDuringTheNextSession() {
            long ten = buy("AAPL", 10, "AT_1000");
            long none = buy("CCC", 5, "AT_1100");
            Bars catchUp = new Bars(et(WED, 11, 21));
            session(catchUp, "AAPL", TUE, 100, et(TUE, 16, 0));
            session(catchUp, "AAPL", WED, 130, et(WED, 11, 20));
            session(catchUp, "SPY", TUE, 580, et(TUE, 16, 0));
            session(catchUp, "SPY", WED, 590, et(WED, 11, 20));
            bars(catchUp);

            Outcome outcome = observe(et(WED, 11, 20), bar("AAPL", TUE, 104.0, WED, 131.0),
                    bar("CCC", TUE, 21.0, WED, 30.0));

            assertThat(fillOf(ten).rawPrice()).isCloseTo(openAt(100, TUE, et(TUE, 10, 0)), offset(1e-9));
            assertThat(barOf(ten).barAt()).isEqualTo(et(TUE, 10, 0));
            assertThat(order(none).status()).isEqualTo("EXPIRED");
            assertThat(order(none).rejectReason()).startsWith("NO_BARS");
            assertThat(fillOf(none)).isNull();
            assertThat(outcome.expired()).isEqualTo(1);
        }

        @Test
        @DisplayName("1분봉을 되짚을 수 있는 기간(8일)을 넘겨 켜짐 — E 세션이 없는 새 1분봉 저장본이면 이력 종가로 채우지 않고 만료")
        void beyondTheBarsHorizon() {
            long id = buy("AAPL", 10, "AT_1000");
            LocalDate later = LocalDate.of(2026, 11, 9);
            Bars fresh = new Bars(et(later, 11, 21));
            session(fresh, "AAPL", later, 150, et(later, 11, 20));
            session(fresh, "SPY", later, 600, et(later, 11, 20));
            bars(fresh);

            observe(et(later, 11, 20), bar("AAPL", MON, 99.0, TUE, 104.0, LocalDate.of(2026, 11, 6), 149.0, later,
                    151.0));

            assertThat(order(id).status()).isEqualTo("EXPIRED");
            assertThat(order(id).rejectReason()).startsWith("NO_BARS");
            assertThat(store.fillsOf(BOOK)).isEmpty();
        }
    }

    // ------------------------------------------------------------------ E가 끝난 관측치와 W 전 1분봉 저장본
    @Nested
    @DisplayName("E가 끝난 관측치 — W 전 1분봉 저장본(1분봉 태스크가 마지막 회차들만 실패)")
    class EndedSession {

        /** E 확정 종가 관측치 W(16:20 ET)를 1분봉 기다림 상한 뒤에 처리 — W 뒤의 1분봉 저장본이 끝내 오지 않음. */
        private Outcome observeAfterTheCap(Instant collectedAt, Bar... observed) {
            clock.at = collectedAt.plus(UsTimedFills.BARS_WAIT);
            return ledger.process(quotes(collectedAt, observed));
        }

        @Test
        @DisplayName("W 전 저장본(15:01)의 완성된 T 뒤 첫 거래 봉으로 E가 끝난 W(16:20)에서 R2b — 같은 저장본의 R1과 T 순(10:00 매도 대금으로 11:00 매수), 수량은 T 시각 순자산, 늦게 풂")
        void lateFirstTradeFromBarsBeforeTheObservation() {
            store.states.put(BOOK, new com.macrodash.store.PaperStore.BookState(BOOK, 2_000, 12_000, 10_000, 83, null,
                    null, null, null));
            hold("BBB", 100, 45, 50, 50.0);
            hold("ZZZ", 100, 50, 50, 50.0);
            long sell = timed("BBB", PaperBooks.SELL, null, null, null, "AT_1000", MON, MON_DECIDED);
            long weight = timed("AAPL", PaperBooks.BUY, null, 10.0, null, "AT_1000", MON, MON_DECIDED);
            long later = buy("MSFT", 10, "AT_1100");
            bars(new Bars(et(TUE, 15, 1)).bar("BBB", TUE, et(TUE, 10, 0), 50.0, 0.0)
                    .bar("BBB", TUE, et(TUE, 10, 40), 51.0, 300.0).bar("BBB", TUE, et(TUE, 10, 41), 51.2, 300.0)
                    .bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 0.0)
                    .bar("AAPL", TUE, et(TUE, 10, 37), 98.0, 400.0).bar("AAPL", TUE, et(TUE, 10, 38), 98.2, 400.0)
                    .bar("MSFT", TUE, et(TUE, 11, 0), 300.0, 500.0).bar("MSFT", TUE, et(TUE, 11, 1), 300.1, 500.0)
                    .bar("SPY", TUE, et(TUE, 9, 30), 580.0, 9000.0).bar("SPY", TUE, et(TUE, 15, 0), 581.0, 9000.0));

            Outcome outcome = observeAfterTheCap(et(TUE, 16, 20), bar("BBB", MON, 50.0, TUE, 52.0),
                    bar("ZZZ", MON, 50.0, TUE, 70.0), bar("AAPL", MON, 99.0, TUE, 97.0),
                    bar("MSFT", MON, 299.0, TUE, 305.0));

            assertThat(order(sell).status()).isEqualTo("FILLED");
            assertThat(barOf(sell).fillRung()).isEqualTo("Y1M_LATE");
            assertThat(barOf(sell).barAt()).isEqualTo(et(TUE, 10, 40));
            assertThat(fillOf(sell).rawPrice()).isEqualTo(51.0);
            assertThat(fillOf(sell).observedAt()).as("장부 반영 = 이 관측치").isEqualTo(et(TUE, 16, 20));
            assertThat(barOf(weight).fillRung()).isEqualTo("Y1M_LATE");
            assertThat(fillOf(weight).rawPrice()).isEqualTo(98.0);
            // T 순자산 = 2,000 + 100 × 51 × 0.9995(같은 T 매도 먼저) + ZZZ 100 × 갱신 전 50 = 12,097.45 → 1,209.7 ÷ 98.049 = 12주(W 70이면 14주)
            assertThat(fillOf(weight).qty()).isEqualTo(12);
            assertThat(barOf(later).fillRung()).as("같은 W 전 저장본의 R1도 그대로").isEqualTo("Y1M_AT");
            assertThat(fillOf(later).qty()).as("10:00 매도 대금이 먼저 — 11:00 매수가 현금 부족으로 줄지 않음").isEqualTo(10);
            assertThat(order(later).reason() == null || !order(later).reason().has("cashLimited")).isTrue();
            assertThat(outcome.expired()).isZero();
            assertThat(outcome.notes()).filteredOn(note -> note.contains("대체 체결(Y1M_LATE)")).hasSize(2);
            assertThat(ExecutionAudit.lateResolved(order(sell), barOf(sell), US)).as("대체 칸 — 늦게 풂").isTrue();
        }

        @Test
        @DisplayName("W 전 저장본(11:21)이 T 뒤 거래를 보이지 않음 — 그 뒤 거래가 있었을 수 있어 NO_TRADE_AFTER_T가 아니고, 멈춘 가격일 수 있어 종가로도 채우지 않음(⑧b) → NO_BARS")
        void noTradeSeenBeforeTheSessionEndIsNotProof() {
            long halt = buy("HALT", 10, "AT_1000");
            long gone = buy("GONE", 10, "AT_1000");
            Bars early = new Bars(et(TUE, 11, 21)).bar("GONE", MON, et(MON, 15, 59), 20.0, 100.0)
                    .bar("SPY", TUE, et(TUE, 9, 30), 580.0, 9000.0).bar("SPY", TUE, et(TUE, 11, 20), 581.0, 9000.0);
            for (int m = 0; m < 15; m++) {
                early.bar("HALT", TUE, et(TUE, 9, 30).plus(Duration.ofMinutes(m)), 50.0, 100.0);
            }
            bars(early);

            Outcome outcome = observeAfterTheCap(et(TUE, 16, 20), bar("HALT", MON, 50.0, TUE, 49.0),
                    bar("GONE", MON, 20.0, TUE, 20.0));

            assertThat(order(halt).status()).isEqualTo("EXPIRED");
            assertThat(order(halt).rejectReason()).startsWith("NO_BARS").contains("마감 + 15분 전");
            assertThat(order(gone).status()).isEqualTo("EXPIRED");
            assertThat(order(gone).rejectReason()).startsWith("NO_BARS").contains("마감 + 15분 전");
            assertThat(store.fillsOf(BOOK)).as("관측치의 E 종가(QUOTES_CLOSE)로 채우지 않음").isEmpty();
            assertThat(store.states.get(BOOK).cash()).isEqualTo(100_000);
            assertThat(outcome.expired()).isEqualTo(2);
        }

        @Test
        @DisplayName("W 전 저장본이라도 E 마감 + 15분 뒤(16:16)에 받았으면 E 전체를 본 것 — T 뒤 거래 없음·E 세션 없음은 NO_TRADE_AFTER_T")
        void noTradeSeenAfterTheSessionEndIsProof() {
            long halt = buy("HALT", 10, "AT_1000");
            long gone = buy("GONE", 10, "AT_1000");
            Bars closing = new Bars(et(TUE, 16, 16)).bar("GONE", MON, et(MON, 15, 59), 20.0, 100.0)
                    .bar("SPY", TUE, et(TUE, 9, 30), 580.0, 9000.0).bar("SPY", TUE, et(TUE, 15, 59), 581.0, 9000.0);
            for (int m = 0; m < 15; m++) {
                closing.bar("HALT", TUE, et(TUE, 9, 30).plus(Duration.ofMinutes(m)), 50.0, 100.0);
            }
            bars(closing);

            observeAfterTheCap(et(TUE, 17, 20), bar("HALT", MON, 50.0, TUE, 49.0), bar("GONE", MON, 20.0, TUE, 20.0));

            assertThat(order(halt).rejectReason()).startsWith("NO_TRADE_AFTER_T");
            assertThat(order(gone).rejectReason()).startsWith("NO_TRADE_AFTER_T");
            assertThat(store.fillsOf(BOOK)).isEmpty();
        }

        @Test
        @DisplayName("W 전 저장본(11:21)의 진행 중일 수 있는 봉(그 뒤 봉 없음 — ⑦)은 E가 끝나도 쓰지 않음 — T 뒤 첫 거래 봉·창 안 거래 봉 모두 NO_BARS(거래가 있었으니 NO_TRADE_AFTER_T도 아님)")
        void unfinishedBarsBeforeTheObservationAreNotUsed() {
            long late = buy("LAST", 10, "AT_1000");
            long window = buy("WIN", 10, "AT_1000");
            bars(new Bars(et(TUE, 11, 21)).bar("LAST", TUE, et(TUE, 10, 0), 30.0, 0.0)
                    .bar("LAST", TUE, et(TUE, 10, 37), 31.0, 400.0)
                    .bar("WIN", TUE, et(TUE, 10, 0), 40.0, 0.0).bar("WIN", TUE, et(TUE, 10, 2), 41.0, 400.0)
                    .bar("SPY", TUE, et(TUE, 9, 30), 580.0, 9000.0).bar("SPY", TUE, et(TUE, 11, 20), 581.0, 9000.0));

            observeAfterTheCap(et(TUE, 16, 20), bar("LAST", MON, 30.0, TUE, 32.0), bar("WIN", MON, 40.0, TUE, 42.0));

            assertThat(order(late).rejectReason()).startsWith("NO_BARS");
            assertThat(order(window).rejectReason()).startsWith("NO_BARS");
            assertThat(store.fillsOf(BOOK)).isEmpty();
        }
    }

    // ------------------------------------------------------------------ 1분봉 기다림
    @Nested
    @DisplayName("1분봉 기다림(§10-2) — 리스크 점검 기록은 첫 미룸·풀림만, 오류가 아님, 다른 계좌는 그대로")
    class Waiting {

        private final Instant w = et(TUE, 10, 20);
        private com.macrodash.read.StoreReader reader;

        @BeforeEach
        void observation() {
            reader = PaperFixtures.quietReader();
            when(marketData.quotes(PaperFixtures.market(UsPaperMarket.INSTANCE)))
                    .thenReturn(Optional.of(quotes(w, bar("AAPL", MON, 99.0, TUE, 103.0))));
        }

        private PaperRiskJob job() {
            return new PaperRiskJob(store, reader, marketData, ledger, PaperFixtures.config(), MAPPER, clock);
        }

        private Bars fresh() {
            return new Bars(et(TUE, 10, 21)).bar("AAPL", TUE, et(TUE, 10, 0), 100.0, 500.0)
                    .bar("AAPL", TUE, et(TUE, 10, 1), 100.0, 500.0);
        }

        @Test
        @DisplayName("관측치 뒤 1분봉 저장본을 기다림 → 다시 미룬 주기는 기록 없음 → 저장본이 오면 풀림(기록) — 계좌1은 첫 주기에 그대로 체결, 실패 기억에 들지 않음")
        void releasedByFreshBars() {
            activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
            long hourly = store.insertOrder(new Order(0, PaperBooks.CLAUDE, 1L, "AAPL", PaperBooks.BUY, 5, null, null,
                    "NEXT_OBSERVATION", "CLAUDE", "PENDING", null, null, MON, MON_DECIDED, WED, null));
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 9, 21)).bar("AAPL", MON, et(MON, 15, 59), 99.0, 100.0));

            clock.at = w.plusSeconds(120);
            Outcome first = job().run(false);
            assertThat(first.booksProcessed()).containsExactly(PaperBooks.CLAUDE);
            assertThat(first.waiting()).singleElement().satisfies(entry -> assertThat(entry).startsWith(BOOK + ": ")
                    .contains("1분봉 저장본을 기다립니다"));
            assertThat(first.errors()).isEmpty();
            assertThat(store.orders.get(hourly).status()).as("계좌1 — 기다림 없이 그 관측치로").isEqualTo("FILLED");
            assertThat(order(id).status()).isEqualTo("PENDING");
            assertThat(store.states.get(BOOK).lastProcessedCollectedAt()).as("멱등 키 그대로").isNull();
            assertThat(store.jobRuns).singleElement().satisfies(run -> assertThat(run.detail().path("barsWait").size())
                    .isEqualTo(1));
            var observed = quotes(w, bar("AAPL", MON, 99.0, TUE, 103.0));
            assertThat(ledger.failedBooks(UsPaperMarket.INSTANCE, observed)).isEmpty();
            assertThat(ledger.hasNewObservation(UsPaperMarket.INSTANCE, observed)).isTrue();

            clock.at = w.plus(Duration.ofMinutes(7));
            Outcome again = job().run(false);
            assertThat(again.booksProcessed()).isEmpty();
            assertThat(again.stillWaiting()).hasSize(1);
            assertThat(again.skippedReason()).contains("1분봉 기다림 중인 계좌(" + BOOK + ")");
            assertThat(store.jobRuns).as("다시 미루기만 한 주기는 기록하지 않음").hasSize(1);

            bars(fresh());
            clock.at = w.plus(Duration.ofMinutes(12));
            Outcome released = job().run(false);
            assertThat(released.booksProcessed()).containsExactly(BOOK);
            assertThat(released.notes()).anySatisfy(note -> assertThat(note).startsWith(BOOK + ": 1분봉 기다림 풀림")
                    .contains("관측치 뒤의 1분봉 저장본"));
            assertThat(barOf(id).fillRung()).isEqualTo("Y1M_AT");
            assertThat(store.jobRuns).hasSize(2);
            assertThat(store.states.get(BOOK).lastProcessedCollectedAt()).isEqualTo(w);
        }

        @Test
        @DisplayName("상한 15분 — 관측치 뒤 저장본이 끝내 없으면 W 수집 + 15분에 그 저장본 없이 처리(풀림 사유 기록)")
        void releasedByTheCap() {
            long id = buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 9, 21)).bar("AAPL", MON, et(MON, 15, 59), 99.0, 100.0));

            clock.at = w.plus(Duration.ofMinutes(14)).plusSeconds(59);
            assertThat(job().run(false).waiting()).hasSize(1);

            clock.at = w.plus(UsTimedFills.BARS_WAIT);
            Outcome released = job().run(false);
            assertThat(released.booksProcessed()).containsExactly(BOOK);
            assertThat(released.notes()).anySatisfy(note -> assertThat(note).contains("기다림 상한 15분"));
            assertThat(order(id).status()).as("W 전 저장본은 E 세션이 없어 아직 모름 — 다음 관측치에서").isEqualTo("PENDING");
        }

        @Test
        @DisplayName("상한은 그 실행 설정의 claude2.barsWaitMinutes(1-5) — 5분이면 W + 5분에 풀림, 0이면 기다리지 않음, 범위 밖이면 기본 15분")
        void capComesFromTheSettings() {
            tools.jackson.databind.node.ObjectNode body = (tools.jackson.databind.node.ObjectNode)
                    PaperFixtures.settings(store).defaultsJson();
            ((tools.jackson.databind.node.ObjectNode) body.get("claude2")).put("barsWaitMinutes", 5);
            store.initSettingsIfAbsent(body);
            buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 9, 21)).bar("AAPL", MON, et(MON, 15, 59), 99.0, 100.0));

            clock.at = w.plus(Duration.ofMinutes(4)).plusSeconds(59);
            Outcome waiting = job().run(false);
            assertThat(waiting.waiting()).singleElement().satisfies(entry -> assertThat(entry).contains("까지)"));
            assertThat(waiting.skippedReason()).contains("5분이 지나면 처리합니다");
            clock.at = w.plus(Duration.ofMinutes(5));
            assertThat(job().run(false).notes()).anySatisfy(note -> assertThat(note).contains("기다림 상한 5분"));

            assertThat(Claude2Settings.from(body).barsWait()).isEqualTo(Duration.ofMinutes(5));
            ((tools.jackson.databind.node.ObjectNode) body.get("claude2")).put("barsWaitMinutes", 0);
            assertThat(UsTimedFills.barsWait(UsTimedFills.Bars.NONE, w, w, Claude2Settings.from(body).barsWait())
                    .waiting()).as("0분 — 기다리지 않음").isFalse();
            ((tools.jackson.databind.node.ObjectNode) body.get("claude2")).put("barsWaitMinutes", 31);
            assertThat(Claude2Settings.from(body).barsWait()).as("범위 밖 — 기본값").isEqualTo(UsTimedFills.BARS_WAIT);
            assertThat(Claude2Settings.from(body).fallbacks()).containsExactly(Claude2Settings.BARS_WAIT_MINUTES);
        }

        @Test
        @DisplayName("기다릴 일이 없는 날 — 기준 시각이 지난 시각 지정 주문이 없으면 1분봉 저장본을 읽지도 않고 바로 처리")
        void noWaitWithoutDueOrders() {
            long later = buy("AAPL", 10, "AT_1500");

            Outcome outcome = job().run(false);

            assertThat(outcome.booksProcessed()).containsExactly(BOOK);
            assertThat(outcome.waiting()).isEmpty();
            assertThat(order(later).status()).isEqualTo("PENDING");
            org.mockito.Mockito.verify(marketData, org.mockito.Mockito.never()).barsUs();
        }

        @Test
        @DisplayName("수동 실행은 미룬 주기도 누를 때마다 기록(barsStillWaiting)")
        void manualRunsAlwaysRecord() {
            buy("AAPL", 10, "AT_1000");
            bars(new Bars(et(TUE, 9, 21)));
            clock.at = w.plusSeconds(120);

            job().runNow();
            Outcome again = job().runNow();

            assertThat(again.stillWaiting()).hasSize(1);
            assertThat(store.jobRuns).hasSize(2);
            assertThat(store.jobRuns.get(1).detail().path("barsStillWaiting").size()).isEqualTo(1);
        }
    }

    // ------------------------------------------------------------------ 폴링 불변
    @Test
    @DisplayName("폴링 불변 — 같은 1분봉을 마감 뒤 한 번에 넣은 결과 = 장중 30회에 나눠 넣은 결과(체결 행·현금이 같음)")
    void pollingInvariance() {
        List<String> batch = runSession(List.of(et(TUE, 16, 20)));
        long batchCash = Math.round(store.states.get(BOOK).cash() * 10_000);

        setUp();
        List<Instant> partial = new ArrayList<>();
        for (int k = 0; k < 30; k++) {
            partial.add(et(TUE, 9, 35).plus(Duration.ofMinutes(13L * k)));
        }
        partial.add(et(TUE, 16, 20));
        List<String> polled = runSession(partial);
        long polledCash = Math.round(store.states.get(BOOK).cash() * 10_000);

        assertThat(polled).hasSize(4).containsExactlyElementsOf(batch);
        assertThat(polledCash).isEqualTo(batchCash);
    }

    /** 폴링 불변 시험의 한 판 — 보유 ZZZ + 메뉴 네 주문, 관측치 W마다 그 시각까지의 1분봉(W 1분 뒤에 받음). 체결 행(장부 반영 시각 뺌)을 돌려줌. */
    private List<String> runSession(List<Instant> observations) {
        store.states.put(BOOK, new com.macrodash.store.PaperStore.BookState(BOOK, 60_000, 100_000, 40_000, 40, null,
                null, null, null));
        hold("ZZZ", 400, 95, 100, 100.0);
        timed("AAPL", PaperBooks.BUY, null, 30.0, null, "NEXT_OPEN", MON, MON_DECIDED);
        timed("MSFT", PaperBooks.BUY, null, 20.0, null, "AT_1100", MON, MON_DECIDED);
        timed("ZZZ", PaperBooks.SELL, null, null, 0.5, "AT_1300", MON, MON_DECIDED);
        timed("SHY", PaperBooks.BUY, null, 10.0, null, "AT_1500", MON, MON_DECIDED);
        for (Instant w : observations) {
            Instant fetched = w.plusSeconds(60);
            Bars bars = new Bars(fetched);
            for (String ticker : List.of("AAPL", "MSFT", "ZZZ", "SHY", "SPY")) {
                session(bars, ticker, TUE, base(ticker), w.isAfter(et(TUE, 16, 0)) ? et(TUE, 16, 0) : w);
            }
            bars(bars);
            List<Bar> observed = new ArrayList<>();
            Instant last = w.isAfter(et(TUE, 16, 0)) ? et(TUE, 15, 59) : w.minusSeconds(60);
            for (String ticker : List.of("AAPL", "MSFT", "ZZZ", "SHY", "SPY")) {
                observed.add(bar(ticker, MON, base(ticker), TUE, openAt(base(ticker), TUE, last)));
            }
            clock.at = fetched.plusSeconds(30);
            ledger.process(quotes(w, observed.toArray(new Bar[0])));
        }
        List<String> out = new ArrayList<>();
        for (Fill f : store.fillsOf(BOOK)) {
            ExecFill bar = store.fillBars.get(f.id());
            out.add(f.ticker() + " " + f.side() + " " + f.qty() + " raw=" + f.rawPrice() + " price=" + f.price() + " "
                    + bar.barAt() + " " + bar.fillRung());
        }
        return out;
    }

    private static double base(String ticker) {
        return switch (ticker) {
            case "AAPL" -> 100;
            case "MSFT" -> 400;
            case "ZZZ" -> 100;
            case "SHY" -> 82;
            default -> 580;
        };
    }

    // ------------------------------------------------------------------ 룩어헤드 성질
    @Test
    @DisplayName("룩어헤드 성질 — 생성 시각·봉·받은 시각을 무작위로 만들어도 시작 < max(T, 생성 + 60초)인 봉으로는 절대 체결하지 않음")
    void neverFillsWithABarBeforeTheTargetOrCreation() {
        Random random = new Random(20261030L);
        List<String> timings = new ArrayList<>(UsTimedFills.TIMINGS);
        int filled = 0;
        for (int round = 0; round < 300; round++) {
            setUp();
            String timing = timings.get(random.nextInt(timings.size()));
            Instant created = et(MON, 16, 30).plus(Duration.ofMinutes(random.nextInt(60 * 22)));
            long id = timed("AAPL", PaperBooks.BUY, 1, null, null, timing, MON, created);
            Instant fetched = et(TUE, 9, 30).plus(Duration.ofMinutes(random.nextInt(60 * 8)));
            Bars bars = new Bars(fetched);
            for (int minute = 0; minute < 390; minute++) {
                Instant start = et(TUE, 9, 30).plus(Duration.ofMinutes(minute));
                if (!start.isBefore(fetched)) {
                    break;
                }
                if (random.nextInt(4) > 0) {
                    bars.bar("AAPL", TUE, start, 100 + minute, random.nextInt(3) == 0 ? 0.0 : 100.0);
                }
            }
            bars.bar("SPY", TUE, et(TUE, 9, 30), 580.0, 100.0);
            bars(bars);
            Instant w = fetched.minusSeconds(random.nextInt(3) * 60L);
            clock.at = fetched.plusSeconds(30);
            ledger.process(quotes(w, bar("AAPL", MON, 99.0, TUE, 100.0 + random.nextInt(50))));

            ExecFill fill = barOf(id);
            if (fill == null || fill.barAt() == null) {
                continue;
            }
            filled++;
            Instant target = ExecutionAudit.targetAt(timing, TUE, US);
            Instant floor = target.isAfter(created.plusSeconds(60)) ? target : created.plusSeconds(60);
            assertThat(fill.barAt()).as(timing + " 생성 " + created).isAfterOrEqualTo(floor).isBefore(fetched);
            assertThat(fill.fill().rawPrice()).as("그 봉의 시가")
                    .isEqualTo(100.0 + Duration.between(et(TUE, 9, 30), fill.barAt()).toMinutes());
        }
        assertThat(filled).as("성질을 실제로 재 봄").isGreaterThan(30);
    }

    // ------------------------------------------------------------------ 계약 대조
    private static final Path V17 = Path.of("../db/migrations/V17__paper_timed_fills_and_exec.sql");
    private static final Path COLLECTOR_BARS = Path.of("../collector/app/tasks/paper_bars.py");

    @Test
    @DisplayName("봉 라벨 START = 수집기 paper_bars.BAR_LABEL, 사다리 칸 다섯 = V17 fill_rung CHECK, 시각 지정 시점 = 실행 감사 메뉴")
    void contractMatchesTheCollectorAndTheMigration() throws IOException {
        assumeTrue(Files.exists(V17) && Files.exists(COLLECTOR_BARS), "V17·수집기 파일을 찾을 수 없습니다");
        assertThat(Files.readString(COLLECTOR_BARS)).contains("BAR_LABEL = \"" + UsTimedFills.BAR_LABEL + "\"");
        String migration = Files.readString(V17);
        Matcher check = Pattern.compile("fill_rung IN \\(([^)]*)\\)").matcher(migration);
        assertThat(check.find()).isTrue();
        Set<String> rungs = new TreeSet<>();
        Matcher value = Pattern.compile("'([A-Z0-9_]+)'").matcher(check.group(1));
        while (value.find()) {
            rungs.add(value.group(1));
        }
        assertThat(rungs).containsExactlyInAnyOrder(UsTimedFills.RUNG_AT, UsTimedFills.RUNG_NEXT, UsTimedFills.RUNG_LATE,
                UsTimedFills.RUNG_FALLBACK, UsTimedFills.RUNG_CLOSE);
        assertThat(UsTimedFills.FALLBACK_RUNGS).containsExactlyInAnyOrder("Y1M_LATE", "QUOTES_FALLBACK", "QUOTES_CLOSE");
        assertThat(UsTimedFills.TIMINGS).containsExactlyElementsOf(ExecutionAudit.MENU.keySet());
    }

    /** 움직이는 시계 — 1분봉 기다림의 상한을 셉니다. */
    static final class MovableClock extends Clock {

        Instant at;

        MovableClock(Instant at) {
            this.at = at;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return at;
        }
    }

}
