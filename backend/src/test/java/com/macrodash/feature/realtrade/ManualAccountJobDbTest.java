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
import com.macrodash.store.ManualAccountStore.NewInstruction;
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
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ISA 계좌 정기 작업 한 주기({@link ManualAccountJob}, ADR 0029·0034) — 실제 테스트 DB와 가짜 모의 공개 창·텔레그램으로: 규칙 계좌 결정이 최종·장부 반영·시가 목표 완전일 때만
 * 지시(세션 한 번), 지시 없음(NONE — 알리지 않음), 잔고로 계산, 세션 마감이 지난 미확인 지시 만료(앞 지시를 기다리지 않음), 알림(08:00 한 통·장 중반·마감 30분 전 각 한 번·미확인만·
 * 종목 코드·이름·수량만), 못 만듦(UNAVAILABLE). 실제 텔레그램·수집기는 부르지 않습니다. 종목·금액은 모두 합성 값입니다.
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
        when(telegram.send(eq(PaperTelegram.Channel.ACCOUNT), anyString())).thenReturn(null);
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

    /** 시작한 계좌 — 총 잔고(total)와 보유(종목·수량·평균 매입가) — 현금 = 총 잔고 − Σ(수량 × 평균 매입가). */
    private void started(String total, String startedAt, Object... symbolQtyPrice) {
        Instant at = kst(startedAt);
        store.insertAccount("isa", "ISA 계좌", "KR", BOOK, at, d(total));
        BigDecimal cash = d(total);
        for (int i = 0; i < symbolQtyPrice.length; i += 3) {
            BigDecimal purchase = d((String) symbolQtyPrice[i + 1]).multiply(d((String) symbolQtyPrice[i + 2]));
            store.upsertPosition("isa", (String) symbolQtyPrice[i], null, d((String) symbolQtyPrice[i + 1]), purchase);
            cash = cash.subtract(purchase);
        }
        store.insertBalance("isa", at, cash);
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
    @DisplayName("결정 행이 없어도 기한(D+1 01:00)이 지나면 최종으로 보고 만든다 — 지금 잔고(현금을 더한 뒤)로 계산")
    void deadlinePassedAndEditedLedger() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        store.updateCash("isa", d("1900000"));
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
        verify(telegram, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());   // 지시는 08:00에만 알림
    }

    // ------------------------------------------------------------------ 알림
    @Test
    @DisplayName("지시 알림 — 밤에는 없고 E 08:00 뒤 첫 주기에 한 통만, 글은 종목 코드·이름·수량만(금액·평가액·현금·기준가 없음)")
    void morningNoticeOnly() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();

        cycleAt("2026-11-06T22:35");
        cycleAt("2026-11-06T22:45");
        verify(telegram, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
        cycleAt("2026-11-09T08:05");
        cycleAt("2026-11-09T08:15");
        cycleAt("2026-11-09T09:10");

        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(telegram, times(1)).send(eq(PaperTelegram.Channel.ACCOUNT), texts.capture());
        assertThat(PaperTelegram.plain(texts.getValue())).isEqualTo("[ISA 계좌] 11/09(월) 시가 매매 지시\n\n"
                + "• 매수 000660 합성하이닉스 15주\n"
                + "• 매수 005930 합성전자 40주\n"
                + "• 매수 153130 합성 단기채권 1주\n\n"
                + "장전 동시호가(08:30~09:00)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다.\n"
                + "매매했으면 ISA 계좌 탭에서 '확인'을 누르세요 — 체결 값이 다르면 매매 내역의 '고치기'로 고치세요.");
        assertThat(texts.getValue()).doesNotContain("원", "10000", "20000", "100000", "900000", "1000000", "%");
        assertThat(store.instructions("isa", E)).allSatisfy(i -> {
            assertThat(i.notifiedNightAt()).isNull();
            assertThat(i.notifiedMorningAt()).isEqualTo(kst("2026-11-09T08:05"));
        });
    }

    @Test
    @DisplayName("08:00 알림 — 보내기에 실패하면 다음 주기에 다시, 텔레그램이 설정되지 않으면 보내지 않음")
    void morningNoticeRetries() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        when(telegram.send(eq(PaperTelegram.Channel.ACCOUNT), anyString())).thenReturn("일시 실패").thenReturn(null);

        cycleAt("2026-11-09T08:05");
        assertThat(store.instructions("isa", E)).allSatisfy(i -> assertThat(i.notifiedMorningAt()).isNull());
        cycleAt("2026-11-09T08:15");
        assertThat(store.instructions("isa", E)).allSatisfy(i -> assertThat(i.notifiedMorningAt()).isEqualTo(kst("2026-11-09T08:15")));

        ManualAccountServiceDbTest.clean(jdbc);
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        PaperTelegram quiet = mock(PaperTelegram.class);
        when(quiet.configured()).thenReturn(false);
        job = new ManualAccountJob(store, paper, quiet, MAPPER, clock, true, true, 600_000);
        cycleAt("2026-11-09T08:05");
        verify(quiet, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
    }

    // ------------------------------------------------------------------ 만료(앞 지시를 기다리지 않음 — ADR 0034)
    @Test
    @DisplayName("세션 마감이 지난 미확인 지시는 SKIPPED(expired)로 닫고 잔고는 그대로, 다음 세션 지시는 앞 지시를 기다리지 않고 잔고로 만든다")
    void expiredInstructionsDoNotBlockNextPlan() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).hasSize(3);

        cycleAt("2026-11-09T15:25");
        assertThat(lines(E)).as("마감 전 — 그대로").allSatisfy(line -> assertThat(line).endsWith("PLANNED"));

        targets(E2, Map.of(A, 50.0), Map.of(A, 10_000.0), true);
        cycleAt("2026-11-09T22:35");   // 다음 세션 E2 — 규칙 계좌 E 결정 뒤

        assertThat(store.instructions("isa", E)).hasSize(3).allSatisfy(i -> {
            assertThat(i.status()).isEqualTo("SKIPPED");
            assertThat(i.reason().path("autoNote").asString()).isEqualTo(ManualAccountJob.AUTO_EXPIRED);
        });
        assertThat(store.balance("isa").orElseThrow().cash()).as("잔고는 건드리지 않음").isEqualByComparingTo("900000");
        assertThat(lines(E2)).as("앞 지시를 기다리지 않고 지금 잔고로").containsExactly("BUY " + A + " 40 PLANNED");
    }

    @Test
    @DisplayName("시작 전(잔고 행 없음)이면 계좌 행이 있어도 계산하지 않음")
    void noPlanBeforeStart() {
        store.insertAccount("isa", "ISA 계좌", "KR", BOOK, kst("2026-11-06T14:55"), d("1000000"));
        standardTargets();
        cycleAt("2026-11-06T22:35");
        assertThat(store.session("isa", E)).isEmpty();
        assertThat(job.waiting()).isNull();
        verify(paper, never()).openTargets(anyString(), any());
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
        verify(telegram, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
    }

    // ------------------------------------------------------------------ 시각 맞추기 날(ADR 0033 결정 7)
    private static final Instant SYNC_AT = kst("2026-11-09T09:10");

    private void timedTargets(List<Long> absorbed, List<Long> stops) {
        when(paper.dailySyncAt(BOOK, E)).thenReturn(Optional.of(SYNC_AT));
        when(paper.targetsAt(BOOK, E, SYNC_AT)).thenReturn(Optional.of(new OpenTargets(BOOK, E, Map.of(A, 50.0, B, 30.0, CASH, 10.0),
                Map.of(A, 10_000.0, B, 20_000.0, CASH, 100_000.0), 1e8, 0, absorbed, List.of(), stops)));
    }

    private static DueOrder ruleAt(long id, String ticker, String side, Instant at) {
        return new DueOrder(id, id, ticker, side, "AT_MINUTE", "RULE", at, at, true, 10.0, null, null);
    }

    private static DueOrder stopAt(long id, String ticker, String timing, Instant at) {
        return new DueOrder(id, id, ticker, "SELL", timing, "STOP", at, at, true, null, null, null);
    }

    @Test
    @DisplayName("시각 맞추기 날 — 규칙 계좌 09:10 주문은 그 시각까지의 목표로 지시(timed-orders 아님), 근거·세션에 09:10, 알림 글은 '09:10 이후 시장가'")
    void timedSyncInstructions() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        timedTargets(List.of(5L), List.of(9L));
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(ruleAt(5L, B, "BUY", SYNC_AT),
                stopAt(9L, X, "AT_MINUTE", SYNC_AT)));

        cycleAt("2026-11-06T22:35");

        assertThat(lines(E)).containsExactly("BUY " + B + " 15 PLANNED", "BUY " + A + " 40 PLANNED", "BUY " + CASH + " 1 PLANNED");
        verify(paper, never()).openTargets(anyString(), any());
        assertThat(store.instructions("isa", E)).allSatisfy(i -> assertThat(i.reason().path("targetAt").asString())
                .isEqualTo(SYNC_AT.toString()));
        assertThat(store.session("isa", E)).hasValueSatisfying(row -> {
            assertThat(row.detail().path("targetAt").asString()).isEqualTo(SYNC_AT.toString());
            assertThat(row.detail().path("coveredStopOrderIds").get(0).asLong()).isEqualTo(9L);
        });
        cycleAt("2026-11-09T08:05");
        ArgumentCaptor<String> text = ArgumentCaptor.forClass(String.class);
        verify(telegram).send(eq(PaperTelegram.Channel.ACCOUNT), text.capture());
        assertThat(PaperTelegram.plain(text.getValue())).contains("11/09(월) 09:10 매매 지시").contains("09:10 이후 시장가로 내면").doesNotContain("장전 동시호가");
        Map<String, Object> block = block(service().view());
        assertThat(block).containsEntry("targetAt", SYNC_AT.toString());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) block.get("items");
        assertThat(items).allSatisfy(item -> assertThat(item).containsEntry("targetAt", SYNC_AT.toString()));
    }

    @Test
    @DisplayName("시각 맞추기 날 — 목표에 들지 않는 시가 밖 규칙 주문(11:00)이 있으면 timed-orders, 시가 날에도 STOP 매도만 있으면 지시를 만듦(스탑 지시가 따로)")
    void timedOrdersIgnoreStops() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        timedTargets(List.of(5L), List.of());
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(ruleAt(5L, B, "BUY", SYNC_AT),
                ruleAt(6L, A, "SELL", kst("2026-11-09T11:00"))));
        cycleAt("2026-11-06T22:35");
        assertThat(store.session("isa", E)).isEmpty();
        assertThat(job.waiting().reason()).isEqualTo(ManualAccountJob.WAIT_TIMED);

        when(paper.dailySyncAt(BOOK, E)).thenReturn(Optional.empty());
        standardTargets();
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(stopAt(9L, X, "AT_MINUTE", SYNC_AT)));
        cycleAt("2026-11-06T22:45");
        assertThat(lines(E)).as("시가 날 — 밤 대체 STOP만 남음(감시 ON)").hasSize(3);
        assertThat(store.instructions("isa", E).getFirst().reason().has("targetAt")).isFalse();
    }

    // ------------------------------------------------------------------ 장중 스탑 지시(ADR 0033 결정 7)
    private static final Instant STOP_T = kst("2026-11-09T11:32");

    private void stopCycleAt(String local) {
        clock.set(kst(local));
        job.stopCycle(clock.instant());
    }

    private List<ManualAccountStore.StopInstruction> stops() {
        return store.stopInstructions("isa", E);
    }

    /** D 밤에 E 09:10 지시(A 40주 매수 등)를 만들어 둔 계좌 — ISA 장부 A 10주. */
    private void timedPlanned(List<Long> coveredStops) {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        timedTargets(List.of(), coveredStops);
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).hasSize(3);
    }

    @Test
    @DisplayName("장중 STOP이면 30초 주기에 스탑 지시 하나(수량 = 잔고 + 지시 시각이 지난 미확인 지시 증감), 같은 주문에 하나, 즉시 알림 한 통 — 종목·이름·수량만")
    void stopInstructionAndImmediateNotice() {
        timedPlanned(List.of());
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(stopAt(31L, A, "MARKET", STOP_T)));
        org.mockito.Mockito.clearInvocations(telegram);

        stopCycleAt("2026-11-09T11:30:10");

        assertThat(stops()).singleElement().satisfies(stop -> {
            assertThat(stop.paperOrderId()).isEqualTo(31L);
            assertThat(stop.quantity()).as("잔고 10주 + 09:10 매수 지시 40주(미확인)").isEqualTo(50);
            assertThat(stop.timing()).isEqualTo("MARKET");
            assertThat(stop.targetAt()).isEqualTo(STOP_T);
            assertThat(stop.notifiedAt()).isNotNull();
        });
        ArgumentCaptor<String> text = ArgumentCaptor.forClass(String.class);
        verify(telegram).send(eq(PaperTelegram.Channel.ACCOUNT), text.capture());
        assertThat(PaperTelegram.plain(text.getValue())).startsWith("[ISA 계좌] 11/09(월) 스탑 매도 지시").contains("• 매도 " + A + " 합성전자 50주\n")
                .contains("지금 시장가로 매도하세요(개장 10분 전이면 09:10 이후)").doesNotContain("원", "9,700", "10000");

        stopCycleAt("2026-11-09T11:30:40");
        assertThat(stops()).hasSize(1);
        verify(telegram, times(1)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
    }

    @Test
    @DisplayName("QA-322: 앞 세션 미확인 지시가 아직 닫히지 않았으면 다음 세션 장중 스탑 지시 수량에 그 지시를 더함(잔고에 없는 종목도)")
    void stopQuantityCountsEarlierSessionInstructions() {
        timedPlanned(List.of());   // E 09:10 지시: B 15주·A 40주·현금성 1주 매수 — E 1분봉 값을 못 구해 PLANNED 그대로
        when(paper.dueOrders(eq(BOOK), eq(E2), any())).thenReturn(List.of(stopAt(51L, B, "MARKET", kst("2026-11-10T11:32")),
                stopAt(52L, A, "MARKET", kst("2026-11-10T11:32"))));

        stopCycleAt("2026-11-10T11:30:10");

        assertThat(store.stopInstructions("isa", E2)).extracting(s -> s.symbol() + " " + s.quantity())
                .containsExactlyInAnyOrder(B + " 15", A + " 50");   // B: 잔고 0 + E 지시 15, A: 잔고 10 + E 지시 40
    }

    @Test
    @DisplayName("그날 지시 목표에 반영된(흡수된) STOP은 스탑 지시가 생기지 않고, 개장 전·마감 뒤·시작 전에는 보지 않음")
    void coveredStopMakesNoInstruction() {
        timedPlanned(List.of(31L));
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(stopAt(31L, A, "AT_MINUTE", SYNC_AT)));
        stopCycleAt("2026-11-09T09:10:10");
        assertThat(stops()).isEmpty();

        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(stopAt(32L, A, "MARKET", STOP_T)));
        stopCycleAt("2026-11-09T08:59");
        stopCycleAt("2026-11-09T15:31");
        assertThat(stops()).as("정규장 밖").isEmpty();
        stopCycleAt("2026-11-09T11:30");
        assertThat(stops()).as("밤 지시 뒤에 생긴 STOP은 스탑 지시").hasSize(1);
    }

    @Test
    @DisplayName("종가 STOP(15:20 뒤 감지)은 '종가 단일가(15:20~15:30)에 시장가' 글(R12)")
    void closingStopText() {
        timedPlanned(List.of());
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(new DueOrder(41L, 41L, A, "SELL", "NEXT_CLOSE", "STOP",
                kst("2026-11-09T15:30"), kst("2026-11-09T15:20"), true, null, null, null)));
        store.instructions("isa", E).forEach(i -> store.updateInstructionStatus(i.id(), "RECORDED", "PLANNED", Map.of("recordedBy", "USER")));   // 확인 알림은 빼고 스탑 글만
        org.mockito.Mockito.clearInvocations(telegram);
        stopCycleAt("2026-11-09T15:21");
        ArgumentCaptor<String> text = ArgumentCaptor.forClass(String.class);
        verify(telegram).send(eq(PaperTelegram.Channel.ACCOUNT), text.capture());
        assertThat(PaperTelegram.plain(text.getValue())).contains("종가 단일가(15:20~15:30)에 시장가로 매도하세요").doesNotContain("지금 시장가");
        assertThat(stops()).singleElement().satisfies(stop -> assertThat(stop.timing()).isEqualTo("NEXT_CLOSE"));
    }

    @Test
    @DisplayName("마감까지 알리지 못한 스탑 지시는 SKIPPED(not-notified) — 잔고를 바꾸지 않음, 다음 세션 지시를 막지 않음")
    void unnotifiedStopIsSkippedAtClose() {
        timedPlanned(List.of());
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(stopAt(31L, A, "MARKET", STOP_T)));
        when(telegram.configured()).thenReturn(false);
        stopCycleAt("2026-11-09T11:30");
        assertThat(stops()).singleElement().satisfies(stop -> assertThat(stop.notifiedAt()).isNull());
        stopCycleAt("2026-11-09T15:31");
        assertThat(stops()).singleElement().satisfies(stop -> {
            assertThat(stop.status()).isEqualTo("SKIPPED");
            assertThat(stop.reason().path("autoNote").asString()).isEqualTo(ManualAccountJob.AUTO_NOT_NOTIFIED);
        });
    }

    @Test
    @DisplayName("알린 스탑 지시가 미확인으로 세션 마감을 넘기면 SKIPPED(expired), 보기에 금액 없이 그 상태")
    void notifiedStopExpiresAtClose() {
        timedPlanned(List.of());
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of(stopAt(31L, A, "MARKET", STOP_T)));
        stopCycleAt("2026-11-09T11:30");
        when(paper.dueOrders(eq(BOOK), eq(E), any())).thenReturn(List.of());
        cycleAt("2026-11-09T15:40");
        assertThat(stops()).singleElement().satisfies(stop -> {
            assertThat(stop.status()).isEqualTo("SKIPPED");
            assertThat(stop.reason().path("autoNote").asString()).isEqualTo(ManualAccountJob.AUTO_EXPIRED);
        });
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> shown = (List<Map<String, Object>>) service().view().get("stopInstructions");
        assertThat(shown).singleElement().satisfies(row -> {
            assertThat(row).containsEntry("symbol", A).containsEntry("quantity", 50).containsEntry("status", "SKIPPED").containsEntry("autoNote", "expired");
            assertThat(row).doesNotContainKey("price");
        });
    }

    @Test
    @DisplayName("스탑 주기만(30초)은 스탑 지시만 보고, 정기 작업 한 번은 interval-ms가 지났을 때 전체 — 시작 전 계좌는 아무것도 하지 않음")
    void stopCycleOnlyScansStops() {
        stopCycleAt("2026-11-09T11:30");
        assertThat(stops()).isEmpty();
        verify(paper, never()).dueOrders(anyString(), any(), any());
    }

    private ManualAccountService service() {
        return new ManualAccountService(store, paper, job, clock);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> block(Map<String, Object> view) {
        return (Map<String, Object>) view.get("instructions");
    }

    @Test
    @DisplayName("ISA-R4: 다음 세션 지시를 만든 뒤 그 세션 08:00 전에 잔고를 고치면 그 세션 PLANNED 지시와 세션 행을 지우고, 다음 주기에 고친 잔고로 다시 만든다")
    void balanceEditBeforeMorningReplans() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        cycleAt("2026-11-06T22:35");
        assertThat(lines(E)).containsExactly("BUY " + B + " 15 PLANNED", "BUY " + A + " 40 PLANNED", "BUY " + CASH + " 1 PLANNED");

        clock.set(kst("2026-11-06T23:00"));
        service().setTotal(new ManualAccountService.TotalRequest(d("2000000"), Map.of()));
        assertThat(store.session("isa", E)).as("고친 잔고로 다시 만들게").isEmpty();
        assertThat(store.instructions("isa", E)).isEmpty();

        cycleAt("2026-11-06T23:05");
        // 평가액 2,000,000 — B 30, A 100 − 10 = 90, 현금성 2(총 잔고를 다시 넣었더니 현금 1,900,000)
        assertThat(lines(E)).containsExactly("BUY " + B + " 30 PLANNED", "BUY " + A + " 90 PLANNED", "BUY " + CASH + " 2 PLANNED");
        assertThat(block(service().view())).containsEntry("ledgerChanged", false);

        cycleAt("2026-11-09T08:05");
        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(telegram, times(1)).send(eq(PaperTelegram.Channel.ACCOUNT), texts.capture());
        assertThat(PaperTelegram.plain(texts.getValue())).startsWith("[ISA 계좌] 11/09(월) 시가 매매 지시\n\n").contains("• 매수 005930 합성전자 90주\n")
                .doesNotContain("다시 계산", "원", "%");
    }

    @Test
    @DisplayName("ISA-R4: 그 세션 08:00 뒤 잔고를 고치면 지시를 지우지 않고(이미 장전 주문을 냈을 수 있음) 보기의 instructions.ledgerChanged가 참")
    void balanceEditAfterMorningFlags() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        standardTargets();
        cycleAt("2026-11-06T22:35");

        clock.set(kst("2026-11-09T08:20"));
        service().setTotal(new ManualAccountService.TotalRequest(d("1001000"), Map.of()));
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
        verify(telegram, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());

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

    // ------------------------------------------------------------------ 장 중반·마감 30분 전 확인 알림(ADR 0034)
    private long dailyInstruction(LocalDate session, String symbol, String side, int quantity) {
        return store.insertInstruction("isa", new NewInstruction(session, symbol, side, quantity, d("10000"), d("10"), MAPPER.createObjectNode()))
                .orElseThrow();
    }

    private long stopInstruction(LocalDate session, long paperOrder, String symbol, int quantity, Instant notifiedAt) {
        long id = store.insertStopInstruction("isa", new ManualAccountStore.NewStopInstruction(session, paperOrder, symbol, quantity, "MARKET", kst("2026-11-09T10:00"),
                MAPPER.createObjectNode())).orElseThrow();
        if (notifiedAt != null) {
            store.markStopNotified(List.of(id), notifiedAt);
        }
        return id;
    }

    private List<String> sentTexts(int times) {
        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(telegram, times(times)).send(eq(PaperTelegram.Channel.ACCOUNT), texts.capture());
        return texts.getAllValues().stream().map(PaperTelegram::plain).toList();
    }

    @Test
    @DisplayName("장 중반 — 정규장 절반(12:15) 전에는 없고, 지나면 오늘 미확인 지시·알린 스탑 지시를 종목 코드·이름·수량 한 통, 칸마다 한 번, 다음 세션 지시는 들지 않음")
    void middayReminderOnce() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000", B, "5", "20000");
        long sell = dailyInstruction(E, A, "SELL", 3);
        long buy = dailyInstruction(E, CASH, "BUY", 2);
        dailyInstruction(E2, B, "SELL", 1);                 // 다음 세션 지시 — 오늘 알림에 들지 않음
        long stop = stopInstruction(E, 91L, X, 4, kst("2026-11-09T10:00"));

        job.reminders(kst("2026-11-09T12:14:30"));
        verify(telegram, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());

        job.reminders(kst("2026-11-09T12:15:00"));
        assertThat(sentTexts(1)).singleElement().asString().startsWith("[ISA 계좌] 11/09(월) 매매 확인")
                .contains("매도 " + A + " 합성전자 3주", "매수 " + CASH + " 합성 단기채권 2주", "매도 " + X + " 합성화학 4주", "실제 매매를 볼 수 없습니다")
                .doesNotContain(B, "원", "10000");
        assertThat(store.instruction(sell).orElseThrow().notifiedMiddayAt()).isEqualTo(kst("2026-11-09T12:15:00"));
        assertThat(store.stopInstruction(stop).orElseThrow().notifiedMiddayAt()).isEqualTo(kst("2026-11-09T12:15:00"));
        assertThat(store.instruction(buy).orElseThrow().notifiedMiddayAt()).isNotNull();

        job.reminders(kst("2026-11-09T12:15:30"));
        job.reminders(kst("2026-11-09T14:00:00"));
        verify(telegram, times(1)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
    }

    @Test
    @DisplayName("마감 30분 전(15:00) — 장 중반과 별도로 한 번 더, 칸마다 한 번, 마감 뒤에는 없음")
    void precloseReminderOnce() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        long sell = dailyInstruction(E, A, "SELL", 3);
        long stop = stopInstruction(E, 91L, A, 2, kst("2026-11-09T10:00"));

        job.reminders(kst("2026-11-09T12:20"));
        job.reminders(kst("2026-11-09T14:59:30"));
        verify(telegram, times(1)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());

        job.reminders(kst("2026-11-09T15:00"));
        List<String> texts = sentTexts(2);
        assertThat(texts.get(1)).startsWith("[ISA 계좌] 11/09(월) 마감 전 매매 확인").contains("마감 30분 전까지");
        assertThat(store.instruction(sell).orElseThrow().notifiedPrecloseAt()).isEqualTo(kst("2026-11-09T15:00"));
        assertThat(store.stopInstruction(stop).orElseThrow().notifiedPrecloseAt()).isEqualTo(kst("2026-11-09T15:00"));

        job.reminders(kst("2026-11-09T15:05"));
        job.reminders(kst("2026-11-09T15:31"));
        verify(telegram, times(2)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
    }

    @Test
    @DisplayName("확인 알림 — 확인(RECORDED)·건너뜀·아직 알리지 못한 스탑은 빼고, 없으면 보내지 않음. 그 시각 뒤에 즉시 알림을 보낸 스탑은 바로 다시 알리지 않음")
    void remindersOnlyUnconfirmed() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        long recorded = dailyInstruction(E, A, "SELL", 3);
        long skipped = dailyInstruction(E, B, "SELL", 1);
        store.updateInstructionStatus(recorded, "RECORDED", "PLANNED", Map.of("recordedBy", "USER"));
        store.updateInstructionStatus(skipped, "SKIPPED", "PLANNED", Map.of("skippedBy", "USER"));
        stopInstruction(E, 91L, X, 4, null);                                  // 아직 즉시 알림 전
        long fresh = stopInstruction(E, 92L, CASH, 2, kst("2026-11-09T14:58"));   // 장 중반 뒤 즉시 알림

        job.reminders(kst("2026-11-09T12:20"));
        job.reminders(kst("2026-11-09T14:59:30"));
        verify(telegram, never()).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
        assertThat(store.stopInstruction(fresh).orElseThrow().notifiedMiddayAt()).isNull();

        job.reminders(kst("2026-11-09T15:02"));   // 15:00 뒤 첫 확인 — 14:58 즉시 알림은 그 전이라 마감 전 알림 대상
        assertThat(sentTexts(1)).singleElement().asString().contains("합성 단기채권 2주").doesNotContain(X);
    }

    @Test
    @DisplayName("확인 알림 — 실패하면 다음 주기에 다시, 장 시간이 바뀐 날은 그날 시각(10:00~16:30 → 13:15·16:00), 30초 주기로 돎")
    void remindersTimingAndRetry() {
        started("1000000", "2026-11-06T14:55", A, "10", "10000");
        long sell = dailyInstruction(E, A, "SELL", 3);

        when(telegram.send(eq(PaperTelegram.Channel.ACCOUNT), anyString())).thenReturn("telegram-failed").thenReturn(null);
        job.reminders(kst("2026-11-09T12:15"));
        assertThat(store.instruction(sell).orElseThrow().notifiedMiddayAt()).as("실패 — 표시하지 않음").isNull();
        job.reminders(kst("2026-11-09T12:15:30"));
        assertThat(store.instruction(sell).orElseThrow().notifiedMiddayAt()).isEqualTo(kst("2026-11-09T12:15:30"));

        dailyInstruction(E2, A, "SELL", 1);
        when(paper.sessionHours(E2)).thenReturn(Optional.of(new SessionHours(E2, true, kst("2026-11-10T10:00"), kst("2026-11-10T16:30"))));
        job.stopCycle(kst("2026-11-10T13:14"));
        verify(telegram, times(2)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
        job.stopCycle(kst("2026-11-10T13:15"));
        verify(telegram, times(3)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
        job.stopCycle(kst("2026-11-10T15:59"));
        verify(telegram, times(3)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
        job.stopCycle(kst("2026-11-10T16:00"));
        verify(telegram, times(4)).send(eq(PaperTelegram.Channel.ACCOUNT), anyString());
    }
}
