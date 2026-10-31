package com.macrodash.feature.paper;

import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.LiveValuation.Current;
import com.macrodash.feature.paper.LiveValuation.LivePrice;
import com.macrodash.feature.paper.LiveValuation.Session;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookLedger;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 개요의 지금 값(명세 docs/specs/2026-10-31-paper-live-overview.md §3) — 단계 고르기(장중 추정·장중 마지막 추정·장부·잠정·확정), 오늘 변화의 기준,
 * 기준 중립, 설명 문구, 오늘 추정 점. 시계는 모두 고정 시각입니다.
 *
 * <p>미국 2026-10-30(금)은 서머타임이라 정규장 13:30~20:00 UTC, 직전 거래일 10-29(목). 한국 10-30(금) 정규장 09:00~15:30 KST(00:00~06:30 UTC).
 */
class LiveCurrentTest {

    private static final LocalDate THU = LocalDate.of(2026, 10, 29);
    private static final LocalDate FRI = LocalDate.of(2026, 10, 30);
    private static final Instant US_REGULAR = Instant.parse("2026-10-30T15:00:00Z");
    private static final Instant US_AFTER = Instant.parse("2026-10-30T21:00:00Z");
    private static final Instant SATURDAY = Instant.parse("2026-10-31T15:00:00Z");
    /** 금요일 장중 시간별 관측치(장부 상태의 마지막 관측). */
    private static final Instant FRI_HOURLY = Instant.parse("2026-10-30T14:05:00Z");
    /** 목요일 마감 뒤 관측치(목요일 줄을 쓴 관측). */
    private static final Instant THU_FINAL = Instant.parse("2026-10-29T20:20:00Z");

    private static Session us(Instant now) {
        return LiveValuation.session(UsMarketCalendar.CALENDAR, now);
    }

    private static Current current(BookLedger ledger, Map<String, LivePrice> live, Instant now) {
        return LiveValuation.current(ledger, live, us(now), UsMarketCalendar.CALENDAR, now, false);
    }

    @Test
    @DisplayName("정규장 — 장중가로 평가한 보유가 있으면 장중 추정(LIVE): 기준 시각은 가장 오래된 봉, 오늘 변화는 그 세션 앞의 마지막 줄(목요일) 대비")
    void regularSessionIsLive() {
        BookLedger ledger = ledger(active("claude"), state(40_000, 100_000, FRI_HOURLY),
                List.of(position("AAA", 100, 600.0, FRI_HOURLY)), List.of(nav(THU, 99_000, true)));
        Current current = current(ledger, Map.of("AAA", live("2026-10-30T14:58:00Z", 610)), US_REGULAR);

        // 40,000 + 100 × 610 = 101,000
        assertThat(current.view()).containsEntry("nav", 101_000.0).containsEntry("returnPct", 1.0)
                .containsEntry("exposurePct", 60.4).containsEntry("dayChangePct", 2.02)
                .containsEntry("previousTradingDate", "2026-10-29").containsEntry("previousNavFinal", true)
                .containsEntry("basis", "LIVE").containsEntry("stage", "LIVE").containsEntry("tradingDate", "2026-10-30")
                .containsEntry("atKst", "2026-10-30 23:58 KST").containsEntry("isEstimated", true)
                .containsEntry("livePriced", 1).containsEntry("positionCount", 1).containsEntry("pendingOrders", 0)
                .containsEntry("neutral", false).containsEntry("note", null);
    }

    @Test
    @DisplayName("정규장 섞임 — 장부가 더 늦은 종목은 장부 관측가, 문구 '장중가 1/2종목', 가격을 한 번도 못 받은 종목이 있으면 장부 상태로(평단 평가)")
    void mixedAndUnpriced() {
        BookLedger mixed = ledger(active("claude"), state(10_000, 100_000, FRI_HOURLY),
                List.of(position("AAA", 100, 400.0, FRI_HOURLY), position("BBB", 200, 250.0, Instant.parse("2026-10-30T14:59:00Z"))),
                List.of(nav(THU, 99_000, true)));
        Current current = current(mixed, Map.of("AAA", live("2026-10-30T14:58:00Z", 410),
                "BBB", live("2026-10-30T14:30:00Z", 255)), US_REGULAR);
        // 10,000 + 100 × 410(장중) + 200 × 250(장부 14:59 > 봉 14:30) = 101,000
        assertThat(current.view()).containsEntry("stage", "LIVE").containsEntry("nav", 101_000.0)
                .containsEntry("livePriced", 1).containsEntry("positionCount", 2)
                .containsEntry("note", "장중가 1/2종목 — 나머지는 장부 관측가");

        BookLedger unpriced = ledger(active("claude"), state(10_000, 100_000, FRI_HOURLY),
                List.of(position("AAA", 100, 400.0, FRI_HOURLY), position("NEW", 10, null, null)), List.of(nav(THU, 99_000, true)));
        Current fallback = current(unpriced, Map.of("AAA", live("2026-10-30T14:58:00Z", 410)), US_REGULAR);
        assertThat(fallback.view()).as("장중 순자산이 없어(가격 없음) 장부 상태 — '—'로 바꾸지 않음")
                .containsEntry("stage", "LEDGER").containsEntry("basis", "LEDGER").containsEntry("nav", 100_000.0)
                .containsEntry("atKst", "2026-10-30 23:05 KST").containsEntry("tradingDate", "2026-10-30")
                .containsEntry("isEstimated", false).containsEntry("livePriced", 0)
                .containsEntry("note", "가격을 한 번도 받지 못한 종목 1개 — 장부 평가(평단)");
    }

    @Test
    @DisplayName("정규장에 장중가가 없으면 — 장부 상태가 그 세션을 관측했으면 장부(LEDGER), 아직 앞 세션 마감 뒤 관측뿐이면 그 줄(잠정·확정)")
    void regularWithoutLive() {
        BookLedger intraday = ledger(active("claude"), state(40_000, 100_500, FRI_HOURLY),
                List.of(position("AAA", 100, 605.0, FRI_HOURLY)), List.of(nav(THU, 99_000, true)));
        assertThat(current(intraday, Map.of(), US_REGULAR).view()).containsEntry("stage", "LEDGER")
                .containsEntry("nav", 100_500.0).containsEntry("atKst", "2026-10-30 23:05 KST")
                .containsEntry("previousTradingDate", "2026-10-29");

        // 개장 전 관측(10-30 08:05 ET — 봉은 목요일 종가)만 있음 → 목요일 줄(잠정)
        Instant pre = Instant.parse("2026-10-30T12:05:00Z");
        BookLedger early = ledger(active("claude"), state(40_000, 99_000, pre), List.of(position("AAA", 100, 590.0, pre)),
                List.of(nav(LocalDate.of(2026, 10, 28), 98_000, true), nav(THU, 99_000, false)));
        assertThat(current(early, Map.of(), US_REGULAR).view()).containsEntry("stage", "PROVISIONAL")
                .containsEntry("tradingDate", "2026-10-29").containsEntry("nav", 99_000.0)
                .containsEntry("atKst", "2026-10-30 05:00 KST").containsEntry("previousTradingDate", "2026-10-28")
                .containsEntry("dayChangePct", 1.02);
    }

    @Test
    @DisplayName("마감 뒤 같은 날 — 그 세션 줄 전이면 장중 마지막 추정(LIVE_LAST), 줄이 생기면 그 줄(확정·잠정), 휴장일은 직전 거래일 줄")
    void afterCloseBecomesTheRow() {
        List<Position> held = List.of(position("AAA", 100, 600.0, FRI_HOURLY));
        Map<String, LivePrice> lastBar = Map.of("AAA", live("2026-10-30T19:59:00Z", 615));

        BookLedger before = ledger(active("claude"), state(40_000, 100_000, FRI_HOURLY), held, List.of(nav(THU, 99_000, true)));
        assertThat(current(before, lastBar, US_AFTER).view()).containsEntry("stage", "LIVE_LAST")
                .containsEntry("nav", 101_500.0).containsEntry("atKst", "2026-10-31 04:59 KST").containsEntry("isEstimated", true);

        BookLedger finalRow = ledger(active("claude"), state(40_000, 101_200, Instant.parse("2026-10-30T20:20:00Z")), held,
                List.of(nav(THU, 99_000, true), nav(FRI, 101_200, true)));
        assertThat(current(finalRow, lastBar, US_AFTER).view()).containsEntry("stage", "FINAL").containsEntry("basis", "LEDGER")
                .containsEntry("nav", 101_200.0).containsEntry("tradingDate", "2026-10-30")
                .containsEntry("atKst", "2026-10-31 05:00 KST").containsEntry("dayChangePct", 2.22)
                .containsEntry("isEstimated", false);

        BookLedger provisional = ledger(active("claude"), state(40_000, 101_200, FRI_HOURLY), held,
                List.of(nav(THU, 99_000, true), nav(FRI, 101_200, false)));
        assertThat(current(provisional, lastBar, US_AFTER).view()).as("결정 작업이 확정 종가를 못 받아 남긴 잠정 줄")
                .containsEntry("stage", "PROVISIONAL").containsEntry("nav", 101_200.0);

        assertThat(current(finalRow, lastBar, SATURDAY).view()).as("휴장일 — 장중 값은 받지 않고 직전 거래일 줄")
                .containsEntry("stage", "FINAL").containsEntry("tradingDate", "2026-10-30");
    }

    @Test
    @DisplayName("출발 전·현금뿐 계좌는 기준 중립(neutral) — 출발 전은 장부 상태 그대로(수익률 없음, '출발 전'), 현금뿐은 단계만 장부·줄")
    void neutralBooks() {
        BookLedger notStarted = ledger(new Book("claude2", "CLAUDE", "계좌2", 100_000, null, PaperBooks.NOT_STARTED, null),
                state(100_000, 100_000, THU_FINAL), List.of(), List.of());
        assertThat(current(notStarted, Map.of(), US_REGULAR).view()).containsEntry("stage", "LEDGER")
                .containsEntry("nav", 100_000.0).containsEntry("returnPct", null).containsEntry("neutral", true)
                .containsEntry("note", "출발 전");

        BookLedger cashOnly = ledger(active("claude2"), state(100_000, 100_000, THU_FINAL), List.of(),
                List.of(nav(THU, 100_000, true)));
        assertThat(current(cashOnly, Map.of(), US_REGULAR).view()).containsEntry("stage", "FINAL")
                .containsEntry("nav", 100_000.0).containsEntry("returnPct", 0.0).containsEntry("neutral", true)
                .containsEntry("note", null);
    }

    @Test
    @DisplayName("시각이 지난 대기 주문 — 미국은 '체결 대기 n건 반영 전', 한국은 시가 체결 대기(그날 밤 관측치), 한국 정규장 장중가")
    void pendingOrdersAndKorea() {
        Order timed = order("claude2", PaperBooks.AT_1000, THU);
        BookLedger us = new BookLedger(active("claude2"), state(40_000, 100_000, FRI_HOURLY),
                List.of(position("AAA", 100, 600.0, FRI_HOURLY)), List.of(nav(THU, 99_000, true)), List.of(timed));
        assertThat(current(us, Map.of("AAA", live("2026-10-30T14:58:00Z", 600)), US_REGULAR).view())
                .containsEntry("pendingOrders", 1).containsEntry("note", "체결 대기 1건 반영 전 — 다음 장부 관측치에서 체결");

        // 한국 10-30(금) 10:00 KST — 장부는 목요일 밤 관측치(목요일 줄, 잠정), 목요일 결정의 시가 주문은 금요일 09:00에 시각이 지남
        Instant krNow = Instant.parse("2026-10-30T01:00:00Z");
        Instant thuNight = Instant.parse("2026-10-29T11:35:00Z");
        Book krBook = new Book("kr_claude", "CLAUDE", "한국 Claude", 100_000_000, THU, PaperBooks.ACTIVE, null,
                Book.MARKET_KR, Book.CURRENCY_KRW);
        BookLedger kr = new BookLedger(krBook, state(40_000_000, 100_000_000, thuNight),
                List.of(position("005930", 1_000, 60_000.0, thuNight)),
                List.of(nav(THU, 100_000_000, false)), List.of(order("kr_claude", PaperBooks.NEXT_OPEN, THU)));
        Session krSession = LiveValuation.session(KrRulesFixtures.CALENDAR, krNow);
        assertThat(krSession.phase()).isEqualTo(LiveValuation.REGULAR);

        Current ledgerOnly = LiveValuation.current(kr, Map.of(), krSession, KrRulesFixtures.CALENDAR, krNow, true);
        assertThat(ledgerOnly.view()).as("장중가 없음 — 목요일 줄(토스 잠정)").containsEntry("stage", "PROVISIONAL")
                .containsEntry("tradingDate", "2026-10-29").containsEntry("pendingOrders", 1)
                .containsEntry("note", "시가 체결 대기 1건 반영 전 — 그날 밤 관측치에서 체결");

        Current live = LiveValuation.current(kr, Map.of("005930", live("2026-10-30T00:59:00Z", 61_000)), krSession,
                KrRulesFixtures.CALENDAR, krNow, true);
        assertThat(live.view()).containsEntry("stage", "LIVE").containsEntry("nav", 101_000_000.0)
                .containsEntry("atKst", "2026-10-30 09:59 KST").containsEntry("dayChangePct", 1.0);
    }

    @Test
    @DisplayName("달력이 그해를 모르면(UNKNOWN) 장부 상태")
    void unknownCalendarYear() {
        BookLedger ledger = ledger(active("claude"), state(40_000, 100_000, FRI_HOURLY),
                List.of(position("AAA", 100, 600.0, FRI_HOURLY)), List.of(nav(THU, 99_000, true)));
        Session unknown = new Session(LiveValuation.UNKNOWN, null, null, null, null);
        Current current = LiveValuation.current(ledger, Map.of("AAA", live("2026-10-30T14:58:00Z", 610)), unknown,
                UsMarketCalendar.CALENDAR, US_REGULAR, false);
        assertThat(current.view()).containsEntry("stage", "LEDGER").containsEntry("nav", 100_000.0)
                .containsEntry("previousTradingDate", null);
    }

    @Test
    @DisplayName("오늘 추정 점 — 정규장·마감 뒤에 그 세션 줄이 어느 계좌에도 없고 장중 값이 있을 때만: 장중 계좌는 그 값(추정), 현금뿐 운용 계좌는 장부 값(추정 아님), 그 밖은 null")
    void navEstimate() {
        BookLedger liveBook = ledger(active("claude"), state(40_000, 100_000, FRI_HOURLY),
                List.of(position("AAA", 100, 600.0, FRI_HOURLY)), List.of(nav(THU, 99_000, true)));
        BookLedger cashOnly = ledger(active("claude2"), state(100_000, 100_000, THU_FINAL), List.of(),
                List.of(nav(THU, 100_000, true)));
        BookLedger ledgerBook = ledger(active("rules"), state(50_000, 99_500, FRI_HOURLY),
                List.of(position("ZZZ", 10, 4_950.0, FRI_HOURLY)), List.of(nav(THU, 99_000, true)));
        BookLedger notStarted = ledger(new Book("bench_mix", "BENCHMARK", "혼합", 100_000, null, PaperBooks.NOT_STARTED, null),
                null, List.of(), List.of());
        Map<String, LivePrice> live = Map.of("AAA", live("2026-10-30T14:58:00Z", 610));
        List<BookLedger> ledgers = List.of(liveBook, cashOnly, ledgerBook, notStarted);

        Map<String, Object> estimate = LiveValuation.navEstimate(ledgers, currents(ledgers, live, US_REGULAR), us(US_REGULAR));
        assertThat(estimate).containsEntry("date", "2026-10-30").containsEntry("atKst", "2026-10-30 23:58 KST")
                .containsEntry("isEstimated", true);
        Map<String, Object> books = new LinkedHashMap<>();
        books.put("claude", point(101_000.0, true));
        books.put("claude2", point(100_000.0, false));
        books.put("rules", point(null, false));
        books.put("bench_mix", point(null, false));
        assertThat(estimate.get("books")).isEqualTo(books);
        assertThat(List.copyOf(estimate.keySet())).containsExactly("date", "atKst", "isEstimated", "books");

        List<BookLedger> withRow = List.of(liveBook, ledger(active("claude2"), state(100_000, 100_000, THU_FINAL), List.of(),
                List.of(nav(THU, 100_000, true), nav(FRI, 100_000, true))));
        assertThat(LiveValuation.navEstimate(withRow, currents(withRow, live, US_AFTER), us(US_AFTER)))
                .as("그 세션 줄이 한 계좌라도 생김").isNull();
        assertThat(LiveValuation.navEstimate(ledgers, currents(ledgers, Map.of(), US_REGULAR), us(US_REGULAR)))
                .as("장중 값 없음").isNull();
        assertThat(LiveValuation.navEstimate(ledgers, currents(ledgers, live, SATURDAY), us(SATURDAY))).as("휴장일").isNull();
    }

    // ------------------------------------------------------------------ 재료
    private static Map<String, Object> point(Double nav, boolean estimated) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("nav", nav);
        out.put("isEstimated", estimated);
        return out;
    }

    private static Map<String, Current> currents(List<BookLedger> ledgers, Map<String, LivePrice> live, Instant now) {
        Map<String, Current> out = new LinkedHashMap<>();
        ledgers.forEach(ledger -> out.put(ledger.book().code(), current(ledger, live, now)));
        return out;
    }

    private static BookLedger ledger(Book book, BookState state, List<Position> positions, List<NavRow> nav) {
        return new BookLedger(book, state, positions, nav, List.of());
    }

    private static Book active(String code) {
        return new Book(code, "CLAUDE", code, 100_000, THU, PaperBooks.ACTIVE, null);
    }

    private static BookState state(double cash, double nav, Instant observedAt) {
        return new BookState("book", cash, nav, nav - cash, nav > 0 ? (nav - cash) / nav * 100.0 : 0, observedAt,
                observedAt, THU, null);
    }

    private static Position position(String ticker, int qty, Double lastPrice, Instant lastPriceAt) {
        return new Position("book", ticker, qty, 100, THU, THU_FINAL, 100, THU_FINAL, lastPrice, lastPriceAt, false, THU,
                100, null);
    }

    private static NavRow nav(LocalDate date, double value, boolean pricesFinal) {
        return new NavRow("book", date, value, 0, value, 100, pricesFinal);
    }

    private static LivePrice live(String at, double price) {
        return new LivePrice(price, Instant.parse(at), false);
    }

    private static Order order(String book, String timing, LocalDate asOf) {
        return new Order(0, book, 1L, "AAA", PaperBooks.BUY, null, 10.0, null, timing, "CLAUDE", PaperBooks.ORDER_PENDING,
                null, null, asOf, Instant.parse("2026-10-29T22:00:00Z"), null, null);
    }
}
