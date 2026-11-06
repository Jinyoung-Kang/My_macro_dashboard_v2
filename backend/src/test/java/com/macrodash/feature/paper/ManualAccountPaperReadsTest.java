package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.KrQuotes.Day;
import com.macrodash.feature.paper.KrQuotes.Minute;
import com.macrodash.feature.paper.KrQuotes.Open;
import com.macrodash.feature.paper.KrQuotes.Quote;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.feature.paper.PaperMirrorService.DecisionState;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * ISA 계좌(ADR 0029 — 명세 2026-11-06-isa-manual-account.md §1·§2·§3·§7)가 모의 공개 창({@link PaperMirrorService})에서 새로 읽는 네 도우미 — 세션 시가
 * ({@link PaperMirrorService#openPrices} — 모의 장부의 시가 사다리 그대로), 마지막 가격({@link PaperMirrorService#lastPrices} — 밤 종가),
 * 정기 결정과 기한({@link PaperMirrorService#decisionState}), 종목 이름. 달력은 천문연 실제 응답으로 만든 2026년 한국 달력이고, 종목·가격은 합성 값입니다.
 */
class ManualAccountPaperReadsTest {

    private static final String BOOK = PaperBooks.KR_RULES;
    /** 매매 세션 S(금)와 그 전 거래일 P(목). */
    private static final LocalDate S = LocalDate.of(2026, 11, 6);
    private static final LocalDate P = LocalDate.of(2026, 11, 5);
    private static final String A = "005930";
    private static final String B = "000660";
    private static final String C = "035420";
    private static final String D = "051910";
    private static final String E = "207940";

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperMarkets markets;
    private PaperLedgerService ledger;

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        when(marketData.quotes(any())).thenReturn(Optional.empty());
        when(marketData.watchKr()).thenReturn(Optional.empty());
        markets = new PaperMarkets(store, reader);
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        store.books.put(BOOK, new Book(BOOK, PaperBooks.KIND_RULES, PaperBooks.KR_RULES_LABEL, 100_000_000, LocalDate.of(2026, 10, 30),
                PaperBooks.ACTIVE, Instant.parse("2026-10-29T13:00:00Z"), Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put(BOOK, new BookState(BOOK, 1_000_000, 1_000_000, 0, 0, kst("2026-11-06T20:40"), kst("2026-11-06T20:40"), S, null));
    }

    private PaperMirrorService service() {
        return new PaperMirrorService(store, reader, marketData, markets, ledger, Clock.fixed(kst("2026-11-06T22:00"), ZoneOffset.UTC));
    }

    /** 한국 봉 — 날짜·시가·종가·거래량·1분봉(없으면 null). */
    private static Day day(LocalDate date, long open, long close, long volume, Minute minute) {
        return new Day(date, BigDecimal.valueOf(open), BigDecimal.valueOf(close), volume, KrQuotes.SOURCE_INTEGRATED, null, minute);
    }

    private static Minute minuteOk(long open, long volume) {
        return new Minute(KrQuotes.MINUTE_OK, Map.of("09:01", new Open(BigDecimal.valueOf(open), volume)), null);
    }

    private static Bar bar(String ticker, boolean stale, Day... days) {
        Day last = days[days.length - 1];
        Quote quote = new Quote(ticker, kst("2026-11-06T20:35"), "STOCK", true, false, List.of(days), "KOSPI", null);
        DailySeries recent = new DailySeries(new int[]{(int) last.date().toEpochDay()}, new double[]{last.close().doubleValue()});
        return new Bar(ticker, last.date(), last.close().doubleValue(), stale, recent, quote);
    }

    private void quotes(Instant collectedAt, Bar... bars) {
        Map<String, Bar> map = new LinkedHashMap<>();
        for (Bar b : bars) {
            map.put(b.ticker(), b);
        }
        when(marketData.quotes(any())).thenReturn(Optional.of(new Quotes(collectedAt, map, S)));
    }

    // ------------------------------------------------------------------ 시가
    @Test
    @DisplayName("세션 시가는 모의 장부의 사다리 — 개장+1분 1분봉 시가(거래량 > 0) → 거래량 0이면 토스 일봉 시가, 1분봉 FAILED는 기한 전이면 기다림, 그 세션 봉이 "
            + "없거나 이어받은 항목·정지일이면 없음")
    void openPricesFollowLedgerLadder() {
        Minute failed = new Minute(KrQuotes.MINUTE_FAILED, Map.of(), "timeout");
        quotes(kst("2026-11-06T21:00"),
                bar(A, false, day(P, 9_900, 10_000, 100, null), day(S, 10_050, 10_300, 100, minuteOk(10_100, 500))),
                bar(B, false, day(P, 19_900, 20_000, 100, null), day(S, 20_050, 20_500, 100, minuteOk(20_200, 0))),
                bar(C, false, day(P, 4_900, 5_000, 100, null), day(S, 5_050, 5_100, 100, failed)),
                bar(D, false, day(P, 29_900, 30_000, 100, null)),
                bar(E, true, day(P, 39_900, 40_000, 100, null), day(S, 40_050, 40_100, 100, minuteOk(40_100, 10))));

        Map<String, BigDecimal> opens = service().openPrices(S, Set.of(A, B, C, D, E, "999999"));

        assertThat(opens).containsOnlyKeys(A, B);
        assertThat(opens.get(A)).as("1분봉 '09:01' 시가").isEqualByComparingTo("10100");
        assertThat(opens.get(B)).as("1분봉 거래량 0 → 토스 일봉 시가").isEqualByComparingTo("20050");
        assertThat(service().openPrices(LocalDate.of(2026, 11, 7), Set.of(A))).as("토요일").isEmpty();
        assertThat(service().openPrices(S, Set.of())).isEmpty();
    }

    @Test
    @DisplayName("1분봉 FAILED도 그 밤 결정 기한(다음 날 01:00) 뒤 수집본이면 토스 일봉 시가로 내려간다 — 장부와 같은 끝")
    void openPricesFailedMinuteAfterDeadline() {
        Minute failed = new Minute(KrQuotes.MINUTE_FAILED, Map.of(), "timeout");
        quotes(kst("2026-11-07T01:10"), bar(C, false, day(P, 4_900, 5_000, 100, null), day(S, 5_050, 5_100, 100, failed)));

        assertThat(service().openPrices(S, Set.of(C))).containsEntry(C, new BigDecimal("5050"));
    }

    @Test
    @DisplayName("ISA-R1: 시가가 다시 오지 않을 종목(halted) — 그 세션 봉이 거래량 0(정지)이고 결정 기한 뒤 수집본이거나 뒤 봉이 이미 있음, 또는 그 세션 봉이 "
            + "없거나 관측이 아닌데 뒤 관측 봉이 있음. 기한 전 거래량 0·이어받은 항목·관측 봉·물량 모름은 없음(기다림)")
    void openUnfillableOnlyWhenTheOpenNeverComes() {
        LocalDate next = LocalDate.of(2026, 11, 9);
        quotes(kst("2026-11-07T01:10"),
                bar(A, false, day(P, 9_900, 10_000, 100, null), day(S, 10_050, 10_300, 0, null)),
                bar(B, false, day(P, 19_900, 20_000, 100, null), day(S, 20_050, 20_500, 100, minuteOk(20_200, 10))),
                bar(E, true, day(P, 39_900, 40_000, 100, null), day(S, 40_050, 40_100, 0, null)));
        assertThat(service().openUnfillable(S, Set.of(A, B, E, "999999"))).containsOnly(Map.entry(A, "halted"));

        quotes(kst("2026-11-06T21:00"), bar(A, false, day(P, 9_900, 10_000, 100, null), day(S, 10_050, 10_300, 0, null)),
                bar(C, false, day(P, 4_900, 5_000, 100, null), new Day(S, BigDecimal.valueOf(5_050), BigDecimal.valueOf(5_100), null,
                        KrQuotes.SOURCE_INTEGRATED, null, null)));
        assertThat(service().openUnfillable(S, Set.of(A, C))).as("기한 전 수집본의 거래량 0·물량 모름 — 다음 수집을 기다림").isEmpty();

        quotes(kst("2026-11-09T21:00"),
                bar(C, false, day(P, 4_900, 5_000, 100, null), day(next, 5_050, 5_100, 100, null)),
                bar(D, false, day(P, 29_900, 30_000, 100, null), day(S, 29_950, 30_000, 0, null), day(next, 30_050, 30_100, 100, null)));
        assertThat(service().openUnfillable(S, Set.of(C, D))).containsOnly(Map.entry(C, "halted"), Map.entry(D, "halted"));
        assertThat(service().openPrices(S, Set.of(C, D))).as("짝 — 같은 종목에 시가가 나오지 않음").isEmpty();
        assertThat(service().openUnfillable(LocalDate.of(2026, 11, 7), Set.of(C))).as("토요일").isEmpty();
    }

    // ------------------------------------------------------------------ 마지막 가격
    @Test
    @DisplayName("마지막 가격 — 밤 관측치 종가만(한국 감시 1분봉은 장중 판단 입력 전용이라 읽지 않음), 없으면 없음")
    void lastPricesUseNightCloseOnly() {
        quotes(kst("2026-11-05T21:00"), bar(A, false, day(P, 9_900, 10_000, 100, null)), bar(B, false, day(P, 19_900, 20_000, 100, null)));
        ObjectNode watch = PaperFixtures.MAPPER.createObjectNode();
        watch.putObject("tickers").putObject(B).putObject("lastBar").put("c", 20_700);
        when(marketData.watchKr()).thenReturn(Optional.of(KrFixtures.snapshot(Datasets.SNAP_PAPER_WATCH_KR, watch, kst("2026-11-06T10:05"))));

        Map<String, BigDecimal> prices = service().lastPrices(Set.of(A, B, C));
        assertThat(prices).containsOnlyKeys(A, B);
        assertThat(prices.get(A)).isEqualByComparingTo("10000");
        assertThat(prices.get(B)).as("늦게 받은 감시 1분봉이 있어도 밤 종가").isEqualByComparingTo("20000");
    }

    // ------------------------------------------------------------------ 결정·이름
    @Test
    @DisplayName("정기 결정과 기한 — 결정 행이 없으면 번호·상태 없이 기한만(기본 D+1 01:00 KST), 있으면 REBALANCE·SCHEDULED 순으로 찾음, 한국 책이 아니면 없음")
    void decisionStateReadsScheduledDecision() {
        DecisionState none = service().decisionState(BOOK, S).orElseThrow();
        assertThat(none.decisionId()).isNull();
        assertThat(none.status()).isNull();
        assertThat(none.deadline()).isEqualTo(kst("2026-11-07T01:00"));

        long id = store.insertDecisionIfAbsent(new Decision(0, BOOK, S, RuleBookService.SCHEDULED, null, RuleBookService.STATUS_NO_TRADE,
                null, null, 1, null, null, null, null, null, null, null, null, null, false, null, 0)).orElseThrow();
        DecisionState found = service().decisionState(BOOK, S).orElseThrow();
        assertThat(found.decisionId()).isEqualTo(id);
        assertThat(found.kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(found.status()).isEqualTo("NO_TRADE");
        assertThat(service().decisionState("nope", S)).isEmpty();
    }

    @Test
    @DisplayName("종목 이름은 물은 종목만(모르는 종목은 없음)")
    void namesOnlyRequested() {
        when(marketData.krNames()).thenReturn(Map.of(A, "합성전자", B, "합성하이닉스"));

        assertThat(service().names(Set.of(A, C))).containsExactly(Map.entry(A, "합성전자"));
        assertThat(service().names(Set.of())).isEmpty();
    }
}
