package com.macrodash.feature.realtrade;

import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.DecisionState;
import com.macrodash.feature.paper.PaperMirrorService.DueOrder;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.RealTradeFixtures.MutableClock;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.LedgerRow;
import com.macrodash.store.ManualAccountStore.LedgerValues;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.realtrade.RealTradeFixtures.MAPPER;
import static com.macrodash.feature.realtrade.RealTradeFixtures.SEOUL;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static com.macrodash.feature.realtrade.RealTradeFixtures.kst;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ISA 계좌 정기 작업 한 주기({@link ManualAccountJob}, ADR 0029 — 명세 §2·§3·§4) — 실제 테스트 DB와 가짜 모의 공개 창·텔레그램으로: 규칙 계좌 결정이 최종·
 * 장부 반영·시가 목표 완전일 때만 지시(세션 한 번), 지시 없음(NONE — 알리지 않음), 고친 장부로 계산, 자동 기록(시가 사다리 값·사용자 입력 우선·시가 없음 대기·
 * 매도 시가 대기 중 매수도 대기·현금까지 줄임), 앞 지시 기록 대기 중 다음 지시 대기, 못 만듦(UNAVAILABLE), 알림(밤·아침 한 번씩·실패 재시도·08:00 뒤
 * 밤 알림 버림·종목 코드·이름·수량만). 실제 텔레그램·수집기는 부르지 않습니다. 종목·금액은 모두 합성 값입니다.
 */
class ManualAccountJobDbTest {

    private static final String A = "005930";
    private static final String B = "000660";
    private static final String X = "051910";
    private static final String CASH = "153130";
    private static final String BOOK = "kr_rules";
    /** 결정일 D(금)·매매 세션 E(월)·그다음 세션 E2(화). */
    private static final LocalDate D = LocalDate.of(2026, 11, 6);
    private static final LocalDate E = LocalDate.of(2026, 11, 9);
    private static final LocalDate E2 = LocalDate.of(2026, 11, 10);

    private JdbcTemplate jdbc;
    private ManualAccountStore store;
    private PaperMirrorService paper;
    private PaperTelegram telegram;
    private MutableClock clock;
    private ManualAccountJob job;
    private String decisionStatus = "OK";

    @BeforeEach
    void setUp() {
        jdbc = RealTradeFixtures.jdbc();
        store = ManualAccountServiceDbTest.store(jdbc);
        ManualAccountServiceDbTest.clean(jdbc);
        paper = mock(PaperMirrorService.class);
        telegram = mock(PaperTelegram.class);
        clock = new MutableClock(kst("2026-11-06T22:35"));
        when(paper.sessionHours(any())).thenAnswer(inv -> Optional.of(hours(inv.getArgument(0))));
        when(paper.book(BOOK)).thenReturn(Optional.of(new BookInfo(BOOK, "한국 규칙 계좌", "RULES", "KR", "ACTIVE", LocalDate.of(2026, 10, 30),
                Instant.parse("2026-10-29T13:00:00Z"), "g")));
        when(paper.decisionState(eq(BOOK), any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(1);
            return Optional.of(new DecisionState(date, decisionStatus == null ? null : 11L, decisionStatus == null ? null : "SCHEDULED",
                    decisionStatus, date.plusDays(1).atTime(1, 0).atZone(SEOUL).toInstant()));
        });
        when(paper.ledgerCaughtUp(eq(BOOK), any())).thenReturn(true);
        when(paper.openTargets(anyString(), any())).thenReturn(Optional.empty());
        when(paper.cashLikeTickers()).thenReturn(List.of(CASH));
        when(paper.names(any())).thenReturn(Map.of(A, "합성전자", B, "합성하이닉스", CASH, "합성 단기채권", X, "합성화학"));
        when(paper.lastPrices(any())).thenReturn(Map.of());
        when(paper.openPrices(any(), any())).thenReturn(Map.of());
        when(telegram.configured()).thenReturn(true);
        when(telegram.send(anyString())).thenReturn(null);
        job = new ManualAccountJob(store, paper, telegram, MAPPER, clock, true, true, 600_000);
    }

    @AfterEach
    void tearDown() {
        ManualAccountServiceDbTest.clean(jdbc);
    }

    // ------------------------------------------------------------------ 합성 자료
    private static SessionHours hours(LocalDate date) {
        if (date.getDayOfWeek() == DayOfWeek.SATURDAY || date.getDayOfWeek() == DayOfWeek.SUNDAY) {
            return new SessionHours(date, false, null, null);
        }
        return new SessionHours(date, true, date.atTime(9, 0).atZone(SEOUL).toInstant(), date.atTime(15, 30).atZone(SEOUL).toInstant());
    }

    /** 시작한 계좌 — 현금(DEPOSIT)과 보유(BUY)를 D 14:55에. */
    private void started(String cash, String startedAt, Object... symbolQtyPrice) {
        Instant at = kst(startedAt);
        store.insertAccount("isa", "ISA 계좌", "KR", BOOK, at, d(cash));
        store.insertLedger("isa", new LedgerValues(at, "DEPOSIT", null, null, null, d(cash), BigDecimal.ZERO, BigDecimal.ZERO, null, "USER", null));
        for (int i = 0; i < symbolQtyPrice.length; i += 3) {
            store.insertLedger("isa", new LedgerValues(at, "BUY", (String) symbolQtyPrice[i], d((String) symbolQtyPrice[i + 1]),
                    d((String) symbolQtyPrice[i + 2]), null, BigDecimal.ZERO, BigDecimal.ZERO, null, "USER", null));
        }
    }

    private void targets(LocalDate session, Map<String, Double> weights, Map<String, Double> prices, boolean complete) {
        when(paper.openTargets(BOOK, session)).thenReturn(Optional.of(new OpenTargets(BOOK, session, weights, prices, 1e8, 0, List.of(1L),
                complete ? List.of() : List.of(1L))));
    }

    private void cycleAt(String local) {
        clock.set(kst(local));
        job.cycle(clock.instant());
    }

    private List<String> lines(LocalDate session) {
        return store.instructions("isa", session).stream().map(i -> i.side() + " " + i.symbol() + " " + i.quantity() + " " + i.status())
                .toList();
    }

    private void standardTargets() {
        targets(E, Map.of(A, 50.0, B, 30.0, CASH, 10.0), Map.of(A, 10_000.0, B, 20_000.0, CASH, 100_000.0), true);
    }

    // ------------------------------------------------------------------ 지시 만들기
    @Test
    @DisplayName("규칙 계좌 D 결정이 최종이고 장부 반영·시가 목표 완전일 때만 E 지시 — 기다리는 사유를 남기고, 만든 뒤에는 세션 한 번(다시 만들지 않음)")
    void plansOnlyWhenReadyAndOnce() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();

        decisionStatus = null;
        cycleAt("2026-11-06T22:35");
        assertThat(store.session("isa", E)).isEmpty();
        assertThat(job.waiting().session()).isEqualTo(E);
        assertThat(job.waiting().reason()).isEqualTo(ManualAccountJob.WAIT_DECISION);

        decisionStatus = "OK";
        when(paper.ledgerCaughtUp(BOOK, E)).thenReturn(false);
        cycleAt("2026-11-06T22:45");
        assertThat(store.session("isa", E)).isEmpty();
        assertThat(job.waiting().reason()).isEqualTo(ManualAccountJob.WAIT_LEDGER);

        when(paper.ledgerCaughtUp(BOOK, E)).thenReturn(true);
        targets(E, Map.of(A, 50.0), Map.of(A, 10_000.0), false);
        cycleAt("2026-11-06T22:55");
        assertThat(store.session("isa", E)).as("시가 목표가 불완전 — 빈 목표로 모두 팔지 않게").isEmpty();
        assertThat(job.waiting().reason()).isEqualTo(ManualAccountJob.WAIT_TARGETS);

        standardTargets();
        cycleAt("2026-11-06T23:05");
        // 평가액 1,000,000 — B floor(300,000 ÷ 20,000) = 15, A floor(500,000 ÷ 10,000) − 10 = 40, 현금성 1 — 순서 매수(코드 순) → 현금성 마지막
        assertThat(lines(E)).containsExactly("BUY " + B + " 15 PLANNED", "BUY " + A + " 40 PLANNED", "BUY " + CASH + " 1 PLANNED");
        assertThat(store.session("isa", E)).hasValueSatisfying(s -> {
            assertThat(s.state()).isEqualTo("PLANNED");
            assertThat(s.decisionId()).isEqualTo(11L);
        });
        Instruction a = store.instructions("isa", E).get(1);
        assertThat(a.refPrice()).isEqualByComparingTo("10000");
        assertThat(a.weightPct()).isEqualByComparingTo("50");
        assertThat(a.reason().path("decisionId").asLong()).isEqualTo(11L);
        assertThat(job.waiting()).isNull();

        standardTargets();
        targets(E, Map.of(A, 90.0), Map.of(A, 10_000.0), true);
        cycleAt("2026-11-06T23:15");
        assertThat(store.instructions("isa", E)).as("세션 한 번 — 목표가 바뀌어도 다시 만들지 않음").hasSize(3);
    }

    @Test
    @DisplayName("결정 행이 없어도 기한(D+1 01:00)이 지나면 최종으로 보고 만든다 — 고친 장부(입금 추가)로 계산")
    void deadlinePassedAndEditedLedger() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        store.insertLedger("isa", new LedgerValues(kst("2026-11-06T16:00"), "DEPOSIT", null, null, null, d("1000000"), BigDecimal.ZERO,
                BigDecimal.ZERO, null, "USER", null));
        standardTargets();
        decisionStatus = null;

        cycleAt("2026-11-07T00:50");
        assertThat(store.session("isa", E)).isEmpty();
        cycleAt("2026-11-07T01:05");
        // 평가액 2,000,000 — B 30, A 100 − 10 = 90, 현금성 2
        assertThat(lines(E)).containsExactly("BUY " + B + " 30 PLANNED", "BUY " + A + " 90 PLANNED", "BUY " + CASH + " 2 PLANNED");
        assertThat(store.session("isa", E).orElseThrow().decisionId()).isNull();
    }

    @Test
    @DisplayName("지시가 하나도 없으면 그 세션은 NONE으로 남기고 알리지 않음, 보유 가격을 모르면 만들지 않고 기다림")
    void noneSessionAndMissingPrice() {
        started("1000000", "2026-11-06T14:55", X, "3", "5000");
        targets(E, Map.of(), Map.of(), true);

        cycleAt("2026-11-06T22:35");
        assertThat(store.session("isa", E)).as("책에 없는 보유의 가격을 모름").isEmpty();
        assertThat(job.waiting().reason()).isEqualTo(ManualAccountJob.WAIT_PRICE);

        when(paper.lastPrices(any())).thenReturn(Map.of(X, d("5000")));
        cycleAt("2026-11-06T22:45");
        assertThat(lines(E)).as("책에 없는 보유는 1% 조건 없이 전량 매도").containsExactly("SELL " + X + " 3 PLANNED");

        ManualAccountServiceDbTest.clean(jdbc);
        started("1000000", "2026-11-06T14:55");
        cycleAt("2026-11-06T22:55");
        assertThat(store.session("isa", E)).hasValueSatisfying(s -> assertThat(s.state()).isEqualTo("NONE"));
        assertThat(store.instructions("isa", E)).isEmpty();
        verify(telegram, times(1)).send(anyString());   // 앞의 매도 지시 한 통뿐
    }

    // ------------------------------------------------------------------ 알림
    @Test
    @DisplayName("알림 — 밤에 한 통, E 08:00 뒤 첫 주기에 한 통 더, 각각 한 번씩. 글은 종목 코드·이름·수량만(금액·평가액·현금·기준가 없음)")
    void nightAndMorningOnce() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();

        cycleAt("2026-11-06T22:35");
        cycleAt("2026-11-06T22:45");
        cycleAt("2026-11-09T08:05");
        cycleAt("2026-11-09T08:15");
        cycleAt("2026-11-09T09:10");

        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(telegram, times(2)).send(texts.capture());
        String night = texts.getAllValues().get(0);
        assertThat(night).isEqualTo("<b>[ISA 계좌] 11/09(월) 시가 매매 지시</b>\n"
                + "매수 000660 합성하이닉스 15주\n"
                + "매수 005930 합성전자 40주\n"
                + "매수 153130 합성 단기채권 1주\n"
                + "장전 동시호가(08:30~09:00)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다. 다르게 매매했으면 화면에서 고치세요.");
        assertThat(texts.getAllValues()).allSatisfy(t -> assertThat(t).doesNotContain("원", "10000", "20000", "100000", "900000", "1000000",
                "%"));
        assertThat(texts.getAllValues().get(1)).isEqualTo(night);
        assertThat(store.instructions("isa", E)).allSatisfy(i -> {
            assertThat(i.notifiedNightAt()).isEqualTo(kst("2026-11-06T22:35"));
            assertThat(i.notifiedMorningAt()).isEqualTo(kst("2026-11-09T08:05"));
        });
    }

    @Test
    @DisplayName("보내기에 실패하면 다음 주기에 다시, 텔레그램이 설정되지 않아 08:00까지 못 보낸 밤 알림은 버리고 아침 알림만")
    void retryAndDropLateNight() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        when(telegram.send(anyString())).thenReturn("일시 실패").thenReturn(null);

        cycleAt("2026-11-06T22:35");
        assertThat(store.instructions("isa", E)).allSatisfy(i -> assertThat(i.notifiedNightAt()).isNull());
        cycleAt("2026-11-06T22:45");
        assertThat(store.instructions("isa", E)).allSatisfy(i -> assertThat(i.notifiedNightAt()).isEqualTo(kst("2026-11-06T22:45")));
        verify(telegram, times(2)).send(anyString());

        ManualAccountServiceDbTest.clean(jdbc);
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        PaperTelegram quiet = mock(PaperTelegram.class);
        when(quiet.configured()).thenReturn(false);
        when(quiet.send(anyString())).thenReturn(null);
        job = new ManualAccountJob(store, paper, quiet, MAPPER, clock, true, true, 600_000);
        cycleAt("2026-11-06T22:35");
        verify(quiet, never()).send(anyString());
        when(quiet.configured()).thenReturn(true);
        cycleAt("2026-11-09T08:10");
        cycleAt("2026-11-09T08:20");
        verify(quiet, times(1)).send(anyString());
        assertThat(store.instructions("isa", E)).allSatisfy(i -> {
            assertThat(i.notifiedNightAt()).as("08:00 뒤에는 밤 알림을 버림").isNull();
            assertThat(i.notifiedMorningAt()).isEqualTo(kst("2026-11-09T08:10"));
        });
    }

    // ------------------------------------------------------------------ 자동 기록
    @Test
    @DisplayName("E 밤 시가로 자동 기록(AUTO·비용 0·RECORDED) — 사용자가 먼저 그 지시에 넣은 행이 있으면 자동 기록하지 않고 RECORDED, 시가가 없는 종목은 PLANNED")
    void autoRecordsAtOpenPrices() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        cycleAt("2026-11-06T22:35");
        List<Instruction> made = store.instructions("isa", E);
        Instruction a = made.get(1);
        store.insertLedger("isa", new LedgerValues(kst("2026-11-09T09:01"), "BUY", A, d("40"), d("10150"), null, d("50"), BigDecimal.ZERO,
                a.id(), "USER", "직접"));

        when(paper.openPrices(eq(E), any())).thenReturn(Map.of(B, d("20500")));
        cycleAt("2026-11-09T08:55");
        assertThat(store.ledger("isa")).as("개장 전에는 적지 않음").hasSize(3);

        cycleAt("2026-11-09T21:00");
        assertThat(lines(E)).containsExactly("BUY " + B + " 15 RECORDED", "BUY " + A + " 40 RECORDED", "BUY " + CASH + " 1 PLANNED");
        List<LedgerRow> auto = store.ledger("isa").stream().filter(r -> "AUTO".equals(r.source())).toList();
        assertThat(auto).singleElement().satisfies(r -> {
            assertThat(r.symbol()).isEqualTo(B);
            assertThat(r.quantity()).isEqualByComparingTo("15");
            assertThat(r.price()).isEqualByComparingTo("20500");
            assertThat(r.fee()).isEqualByComparingTo("0");
            assertThat(r.tax()).isEqualByComparingTo("0");
            assertThat(r.at()).isEqualTo(kst("2026-11-09T09:00"));
            assertThat(r.instructionId()).isEqualTo(made.get(0).id());
        });
        assertThat(store.ledgerForInstruction(a.id())).singleElement().satisfies(r -> assertThat(r.source()).isEqualTo("USER"));

        when(paper.openPrices(eq(E), any())).thenReturn(Map.of(B, d("20500"), CASH, d("100100")));
        cycleAt("2026-11-09T21:10");
        assertThat(lines(E)).containsExactly("BUY " + B + " 15 RECORDED", "BUY " + A + " 40 RECORDED", "BUY " + CASH + " 1 RECORDED");
        assertThat(store.ledger("isa").stream().filter(r -> "AUTO".equals(r.source())).count()).isEqualTo(2);
    }

    @Test
    @DisplayName("매도 시가를 기다리는 동안 그 세션 매수도 기다리고(다음 세션 지시도 기록 대기), 매도 대금 뒤 현금이 모자라면 매수를 줄여 적음")
    void sellsFirstAndReducedBuys() {
        started("200000", "2026-11-06T14:55", X, "5", "20000");
        when(paper.lastPrices(any())).thenReturn(Map.of(X, d("20000")));
        targets(E, Map.of(A, 90.0), Map.of(A, 10_000.0), true);
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).containsExactly("SELL " + X + " 5 PLANNED", "BUY " + A + " 18 PLANNED");

        when(paper.openPrices(eq(E), any())).thenReturn(Map.of(A, d("11500")));
        targets(E2, Map.of(A, 90.0), Map.of(A, 11_000.0), true);
        cycleAt("2026-11-09T21:00");
        assertThat(lines(E)).as("매도 시가가 없으면 매수도 기다림").containsExactly("SELL " + X + " 5 PLANNED", "BUY " + A + " 18 PLANNED");
        assertThat(store.session("isa", E2)).as("앞 세션 지시가 적히기 전에는 다음 지시를 만들지 않음").isEmpty();
        assertThat(job.waiting().reason()).isEqualTo(ManualAccountJob.WAIT_RECORD);

        when(paper.openPrices(eq(E), any())).thenReturn(Map.of(X, d("19000"), A, d("11500")));
        cycleAt("2026-11-09T22:00");
        // 매도 5 × 19,000 = 95,000 → 현금 195,000 ÷ 11,500 = 16주(지시 18주)
        assertThat(lines(E)).containsExactly("SELL " + X + " 5 RECORDED", "BUY " + A + " 18 RECORDED");
        LedgerRow buy = store.ledger("isa").stream().filter(r -> "AUTO".equals(r.source()) && "BUY".equals(r.kind())).findFirst().orElseThrow();
        assertThat(buy.quantity()).isEqualByComparingTo("16");
        assertThat(buy.note()).contains("16주로 줄임");
        assertThat(store.instructions("isa", E).get(1).reason().path("autoNote").asString()).isEqualTo("reduced-cash");
        assertThat(ManualAccountLedger.firstInvalid(store.ledger("isa").stream().map(ManualAccountLedger.Entry::of).toList())).isNull();
        assertThat(store.session("isa", E2)).as("기록이 끝나면 같은 주기에 다음 지시").isPresent();
    }

    @Test
    @DisplayName("ISA-R1: E에 거래가 없어(거래량 0·정지) 시가가 다시 오지 않을 매도는 AUTO SKIPPED(halted) — 그 세션 매수는 기다리지 않고 현금까지 적고, "
            + "다음 세션 지시를 만든다")
    void haltedSellIsSkippedAndUnblocks() {
        started("200000", "2026-11-06T14:55", X, "5", "20000");
        when(paper.lastPrices(any())).thenReturn(Map.of(X, d("20000")));
        targets(E, Map.of(A, 90.0), Map.of(A, 10_000.0), true);
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).containsExactly("SELL " + X + " 5 PLANNED", "BUY " + A + " 18 PLANNED");

        when(paper.openPrices(eq(E), any())).thenReturn(Map.of(A, d("10000")));
        when(paper.openUnfillable(eq(E), any())).thenReturn(Map.of(X, "halted"));
        targets(E2, Map.of(A, 90.0), Map.of(A, 10_000.0), true);
        cycleAt("2026-11-10T01:10");

        assertThat(lines(E)).containsExactly("SELL " + X + " 5 SKIPPED", "BUY " + A + " 18 RECORDED");
        Instruction sell = store.instructions("isa", E).get(0);
        assertThat(sell.reason().path("skippedBy").asString()).isEqualTo("AUTO");
        assertThat(sell.reason().path("autoNote").asString()).isEqualTo("halted");
        LedgerRow buy = store.ledger("isa").stream().filter(r -> "AUTO".equals(r.source())).findFirst().orElseThrow();
        assertThat(buy.quantity()).as("매도 대금 없이 현금 100,000 ÷ 10,000").isEqualByComparingTo("10");
        assertThat(store.ledger("isa").stream().filter(r -> "SELL".equals(r.kind()))).as("정지된 매도는 장부에 쓰지 않음").isEmpty();
        assertThat(store.session("isa", E2)).as("앞 세션이 풀려 다음 지시").isPresent();
    }

    @Test
    @DisplayName("ISA-R1: 지시를 만든 뒤 그 세션이 거래일이 아니게 되면(늦은 휴장 지정) 그 세션 PLANNED 지시는 모두 AUTO SKIPPED(not-trading)이고 다음 거래일 "
            + "지시를 만든다")
    void lateHolidaySkipsAllPlanned() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).hasSize(3).allSatisfy(l -> assertThat(l).endsWith("PLANNED"));

        doAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            return Optional.of(E.equals(date) ? new SessionHours(E, false, null, null) : hours(date));
        }).when(paper).sessionHours(any());
        targets(E2, Map.of(A, 50.0), Map.of(A, 10_000.0), true);
        cycleAt("2026-11-07T10:00");

        assertThat(store.instructions("isa", E)).hasSize(3).allSatisfy(i -> {
            assertThat(i.status()).isEqualTo("SKIPPED");
            assertThat(i.reason().path("skippedBy").asString()).isEqualTo("AUTO");
            assertThat(i.reason().path("autoNote").asString()).isEqualTo("not-trading");
        });
        assertThat(store.ledger("isa")).as("장부에 쓰지 않음").hasSize(2);
        assertThat(store.session("isa", E2)).isPresent();
    }

    // ------------------------------------------------------------------ 시가 밖 시점·장부 고침 뒤 다시 계산
    @Test
    @DisplayName("ISA-R5: 규칙 계좌가 그 세션을 목표로 시가 밖 시점(분 지정 등) 대기 주문을 냈으면 지시를 만들지 않고 timed-orders로 기다리며, 개장 뒤 "
            + "UNAVAILABLE(사유 timed-orders)")
    void timedOrdersBlockPlanning() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(new DueOrder(5L, 5L, A, "SELL", "AT_MINUTE", "RULE",
                kst("2026-11-09T10:00"), kst("2026-11-09T10:00"), true, null, 1.0, null)));

        cycleAt("2026-11-06T22:35");
        assertThat(store.session("isa", E)).as("결정 주문이 시가 목표에 들어 있지 않음 — 반쪽 목표로 만들지 않음").isEmpty();
        assertThat(job.waiting().reason()).isEqualTo(ManualAccountJob.WAIT_TIMED);

        cycleAt("2026-11-09T09:05");
        assertThat(store.session("isa", E)).hasValueSatisfying(s -> {
            assertThat(s.state()).isEqualTo("UNAVAILABLE");
            assertThat(s.detail().path("reason").asString()).isEqualTo(ManualAccountJob.WAIT_TIMED);
        });
        verify(telegram, never()).send(anyString());
    }

    private ManualAccountService service() {
        return new ManualAccountService(store, paper, job, clock);
    }

    private static ManualAccountService.LedgerRequest newRow(String kind, String symbol, String qty, String price, String amount, String at) {
        return new ManualAccountService.LedgerRequest(null, kind, symbol, qty == null ? null : d(qty), price == null ? null : d(price),
                amount == null ? null : d(amount), null, null, at, null, null);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> block(Map<String, Object> view) {
        return (Map<String, Object>) view.get("instructions");
    }

    @Test
    @DisplayName("ISA-R4: 다음 세션 지시를 만든 뒤 그 세션 08:00 전에 장부를 고치면 그 세션 PLANNED 지시와 세션 행을 지우고, 다음 주기에 고친 장부로 다시 만들어 "
            + "'다시 계산' 밤 알림을 다시 보낸다")
    void ledgerEditBeforeMorningReplans() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).containsExactly("BUY " + B + " 15 PLANNED", "BUY " + A + " 40 PLANNED", "BUY " + CASH + " 1 PLANNED");

        clock.set(kst("2026-11-06T23:00"));
        service().saveLedger(newRow("DEPOSIT", null, null, null, "1000000", "2026-11-06T22:59"));
        assertThat(store.session("isa", E)).as("고친 장부로 다시 만들게").isEmpty();
        assertThat(store.instructions("isa", E)).isEmpty();

        cycleAt("2026-11-06T23:05");
        // 평가액 2,000,000 — B 30, A 100 − 10 = 90, 현금성 2
        assertThat(lines(E)).containsExactly("BUY " + B + " 30 PLANNED", "BUY " + A + " 90 PLANNED", "BUY " + CASH + " 2 PLANNED");
        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(telegram, times(2)).send(texts.capture());
        assertThat(texts.getAllValues().get(0)).doesNotContain("다시 계산");
        assertThat(texts.getAllValues().get(1)).startsWith("<b>[ISA 계좌] 11/09(월) 시가 매매 지시(다시 계산)</b>\n")
                .contains("\n매수 005930 합성전자 90주\n").doesNotContain("원", "%");
        assertThat(block(service().view())).containsEntry("ledgerChanged", false);

        cycleAt("2026-11-09T08:05");
        verify(telegram, times(3)).send(texts.capture());
        assertThat(texts.getValue()).as("아침 알림도 다시 계산한 지시").contains("(다시 계산)").contains("90주");
    }

    @Test
    @DisplayName("ISA-R4: 다시 계산해 지시가 없으면 '할 매매가 없음(다시 계산)' 한 통 — 앞서 보낸 지시를 내지 않게")
    void ledgerEditBeforeMorningToNone() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        targets(E, Map.of(A, 20.0), Map.of(A, 10_000.0), true);
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).containsExactly("BUY " + A + " 10 PLANNED");

        clock.set(kst("2026-11-06T23:00"));
        service().saveLedger(newRow("BUY", A, "10", "10000", null, "2026-11-06T22:50"));
        cycleAt("2026-11-06T23:05");
        assertThat(store.session("isa", E)).hasValueSatisfying(s -> assertThat(s.state()).isEqualTo("NONE"));
        cycleAt("2026-11-06T23:15");

        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(telegram, times(2)).send(texts.capture());
        assertThat(texts.getAllValues().get(1)).isEqualTo(ManualAccountNotices.noTrades(E));
    }

    @Test
    @DisplayName("ISA-R4: 그 세션 08:00 뒤 장부를 고치면 지시를 지우지 않고(이미 장전 주문을 냈을 수 있음) 보기의 instructions.ledgerChanged가 참")
    void ledgerEditAfterMorningFlags() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        cycleAt("2026-11-06T22:35");

        clock.set(kst("2026-11-09T08:20"));
        service().saveLedger(newRow("DEPOSIT", null, null, null, "1000", "2026-11-09T08:19"));
        cycleAt("2026-11-09T08:25");

        assertThat(lines(E)).containsExactly("BUY " + B + " 15 PLANNED", "BUY " + A + " 40 PLANNED", "BUY " + CASH + " 1 PLANNED");
        assertThat(block(service().view())).containsEntry("session", E.toString()).containsEntry("ledgerChanged", true);
    }

    // ------------------------------------------------------------------ 못 만듦·꺼짐
    @Test
    @DisplayName("E 개장까지 지시를 못 만들면 그 세션은 UNAVAILABLE(사유 남김) — 시작이 그 세션 개장 뒤면 남기지 않음")
    void unavailableAfterOpen() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        decisionStatus = null;
        when(paper.decisionState(eq(BOOK), eq(D))).thenReturn(Optional.of(new DecisionState(D, null, null, null,
                kst("2026-11-09T12:00"))));

        cycleAt("2026-11-09T08:50");
        cycleAt("2026-11-09T09:05");
        assertThat(store.session("isa", E)).hasValueSatisfying(s -> {
            assertThat(s.state()).isEqualTo("UNAVAILABLE");
            assertThat(s.detail().path("reason").asString()).isEqualTo(ManualAccountJob.WAIT_DECISION);
        });
        verify(telegram, never()).send(anyString());

        ManualAccountServiceDbTest.clean(jdbc);
        started("1000000", "2026-11-09T10:00", A, "10", "10000");
        cycleAt("2026-11-09T10:05");
        assertThat(store.session("isa", E)).as("시작이 E 개장 뒤").isEmpty();
    }

    @Test
    @DisplayName("모의 매매 정기 작업이나 스케줄러가 꺼진 서버에서는 꺼짐 — 시작해도 스케줄하지 않고 사유·마지막 주기를 보이지 않음")
    void disabledJob() {
        ManualAccountJob off = new ManualAccountJob(store, paper, telegram, MAPPER, clock, false, true, 600_000);
        off.start();
        off.stop();
        assertThat(off.enabled()).isFalse();
        assertThat(off.waiting()).isNull();
        assertThat(off.lastCycleAt()).isNull();
        assertThat(new ManualAccountJob(store, paper, telegram, MAPPER, clock, true, false, 600_000).enabled()).isFalse();
        assertThat(LocalTime.of(8, 0)).isEqualTo(ManualAccountJob.MORNING);
    }
}
