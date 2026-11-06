package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.RealTradeFixtures.MutableClock;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.LedgerRow;
import com.macrodash.store.ManualAccountStore.NewInstruction;
import com.macrodash.store.SchemaCheck;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.realtrade.RealTradeFixtures.MAPPER;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static com.macrodash.feature.realtrade.RealTradeFixtures.kst;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * ISA 계좌 API({@link ManualAccountService}, ADR 0029 — 명세 §1·§3·§5) — 실제 테스트 DB와 가짜 모의 공개 창으로: 시작 한 번만(한 트랜잭션), 장부 계산과
 * 응답 모양(요약·보유·장부·지시), 가격 모르는 보유면 손익 비움, 음수 장부 거절(400 ledger-invalid), 행 추가·고침(자동 기록 행은 USER가 됨)·삭제, 지시에 묶기
 * (RECORDED — 사용자 입력 우선), 지시 건너뜀, 시작 전 409. 종목·금액은 모두 합성 값입니다.
 */
class ManualAccountServiceDbTest {

    static final String A = "005930";
    static final String B = "000660";
    static final String C = "035420";
    static final LocalDate MONDAY = LocalDate.of(2026, 11, 9);

    private JdbcTemplate jdbc;
    private ManualAccountStore store;
    private PaperMirrorService paper;
    private MutableClock clock;
    private ManualAccountService service;

    static ManualAccountStore store(JdbcTemplate jdbc) {
        return new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc));
    }

    /** 네 표를 비웁니다(이 기능만 쓰는 표 — 장부가 지시를, 모두가 계좌를 참조하는 순서). */
    static void clean(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM manual_ledger");
        jdbc.update("DELETE FROM manual_instructions");
        jdbc.update("DELETE FROM manual_sessions");
        jdbc.update("DELETE FROM manual_accounts");
    }

    @BeforeEach
    void setUp() {
        jdbc = RealTradeFixtures.jdbc();
        store = store(jdbc);
        clean(jdbc);
        paper = mock(PaperMirrorService.class);
        clock = new MutableClock(kst("2026-11-09T21:00"));
        when(paper.book(anyString())).thenAnswer(inv -> Optional.of(new BookInfo(inv.getArgument(0), "한국 규칙 계좌", "RULES", "KR", "ACTIVE",
                LocalDate.of(2026, 10, 30), Instant.parse("2026-10-29T13:00:00Z"), "g")));
        when(paper.names(any())).thenReturn(Map.of(A, "합성전자"));
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000"), B, d("21000")));
        ManualAccountJob job = new ManualAccountJob(store, paper, mock(PaperTelegram.class), MAPPER, clock, false, false, 600_000);
        service = new ManualAccountService(store, paper, job, clock);
    }

    @AfterEach
    void tearDown() {
        clean(jdbc);
    }

    private static void rejects(Runnable call, int status, String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(ManualAccountException.class, e -> {
            assertThat(e.status()).isEqualTo(status);
            assertThat(e.code()).isEqualTo(code);
        });
    }

    private void startSynthetic() {
        service.start(new ManualAccountService.StartRequest(d("1000000"), "2026-11-06T14:55",
                List.of(new ManualAccountService.StartBuy(A, d("10"), d("10000")), new ManualAccountService.StartBuy(B, d("5"), d("20000")))));
    }

    private static ManualAccountService.LedgerRequest row(Long id, String kind, String symbol, String qty, String price, String amount,
                                                          String at, Long instructionId) {
        return new ManualAccountService.LedgerRequest(id, kind, symbol, qty == null ? null : d(qty), price == null ? null : d(price),
                amount == null ? null : d(amount), null, null, at, null, instructionId);
    }

    private long instruction(String symbol, String side, int quantity) {
        return store.insertInstruction(ManualAccountService.CODE, new NewInstruction(MONDAY, symbol, side, quantity, d("10000"), d("10"),
                MAPPER.createObjectNode())).orElseThrow();
    }

    // ------------------------------------------------------------------ 시작
    @Test
    @DisplayName("시작은 한 번만 — 시작 현금(DEPOSIT)과 시작 매수(BUY, USER)를 한 트랜잭션으로, 다시 시작하면 409 already-started")
    void startsOnce() {
        startSynthetic();

        assertThat(store.account("isa")).hasValueSatisfying(a -> {
            assertThat(a.label()).isEqualTo("ISA 계좌");
            assertThat(a.sourceBook()).isEqualTo("kr_rules");
            assertThat(a.state()).isEqualTo("ACTIVE");
            assertThat(a.startedAt()).isEqualTo(kst("2026-11-06T14:55"));
            assertThat(a.startCash()).isEqualByComparingTo("1000000");
        });
        List<LedgerRow> rows = store.ledger("isa");
        assertThat(rows).extracting(LedgerRow::kind).containsExactly("DEPOSIT", "BUY", "BUY");
        assertThat(rows).allSatisfy(r -> assertThat(r.source()).isEqualTo("USER"));
        rejects(this::startSynthetic, 409, "already-started");
        assertThat(store.ledger("isa")).hasSize(3);
    }

    @Test
    @DisplayName("시작 매수가 시작 현금보다 크면 400 ledger-invalid이고 아무것도 쓰지 않음, 미래 시각·잘못된 종목은 400 invalid-request")
    void startValidates() {
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("100000"), null,
                List.of(new ManualAccountService.StartBuy(A, d("11"), d("10000"))))), 400, "ledger-invalid");
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("100000"), "2026-11-10T09:00", List.of())), 400, "invalid-request");
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("100000"), null,
                List.of(new ManualAccountService.StartBuy("ABC", d("1"), d("10"))))), 400, "invalid-request");
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("0"), null, List.of())), 400, "invalid-request");
        rejects(() -> service.start(null), 400, "invalid-request");
        assertThat(store.account("isa")).isEmpty();
    }

    // ------------------------------------------------------------------ 보기
    @Test
    @DisplayName("보기 — 요약(현금·평가액·순입금·손익), 보유(평단·마지막 가격·비중), 장부(매매 행 금액 = 수량 × 체결가), 지시 없음")
    void viewShape() {
        startSynthetic();

        Map<String, Object> view = service.view();

        assertThat(view).containsEntry("available", true).containsEntry("started", true);
        @SuppressWarnings("unchecked")
        Map<String, Object> account = (Map<String, Object>) view.get("account");
        assertThat(account).containsEntry("code", "isa").containsEntry("label", "ISA 계좌").containsEntry("market", "KR")
                .containsEntry("sourceBook", "kr_rules").containsEntry("sourceLabel", "한국 규칙 계좌").containsEntry("state", "ACTIVE")
                .containsEntry("startedAt", "2026-11-06T05:55:00Z");
        @SuppressWarnings("unchecked")
        Map<String, Object> summary = (Map<String, Object>) view.get("summary");
        assertThat((BigDecimal) summary.get("cash")).isEqualByComparingTo("800000");
        assertThat((BigDecimal) summary.get("marketValue")).as("10 × 12,000 + 5 × 21,000").isEqualByComparingTo("225000");
        assertThat((BigDecimal) summary.get("equity")).isEqualByComparingTo("1025000");
        assertThat((BigDecimal) summary.get("netDeposit")).isEqualByComparingTo("1000000");
        assertThat((BigDecimal) summary.get("profitLoss")).isEqualByComparingTo("25000");
        assertThat((BigDecimal) summary.get("profitLossPct")).isEqualByComparingTo("2.5");
        assertThat((List<?>) summary.get("unpriced")).isEmpty();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> holdings = (List<Map<String, Object>>) view.get("holdings");
        assertThat(holdings).extracting(h -> h.get("symbol")).containsExactly(B, A);
        Map<String, Object> a = holdings.get(1);
        assertThat(a).containsEntry("name", "합성전자");
        assertThat((BigDecimal) a.get("avgPrice")).isEqualByComparingTo("10000");
        assertThat((BigDecimal) a.get("lastPrice")).isEqualByComparingTo("12000");
        assertThat((BigDecimal) a.get("weightPct")).isEqualByComparingTo("11.71");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> ledger = (List<Map<String, Object>>) view.get("ledger");
        assertThat(ledger).hasSize(3);
        assertThat(ledger).anySatisfy(r -> {
            assertThat(r).containsEntry("kind", "BUY").containsEntry("symbol", A).containsEntry("source", "USER");
            assertThat((BigDecimal) r.get("amount")).isEqualByComparingTo("100000");
        });
        assertThat(view.get("instructions")).isNull();
        assertThat((List<?>) view.get("recentInstructions")).isEmpty();
        assertThat(view.get("notes").toString()).contains("수수료·세금 0").contains("정기 작업이 꺼져");
    }

    @Test
    @DisplayName("시작 전이면 started=false·요약 없음, 가격을 모르는 보유가 있으면 평가에서 빼고 unpriced에 담고 손익은 비움")
    void viewBeforeStartAndUnpriced() {
        Map<String, Object> before = service.view();
        assertThat(before).containsEntry("available", true).containsEntry("started", false);
        assertThat(before.get("summary")).isNull();
        assertThat(before.get("notes").toString()).contains("시작 전");

        startSynthetic();
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000")));
        @SuppressWarnings("unchecked")
        Map<String, Object> summary = (Map<String, Object>) service.view().get("summary");
        assertThat(summary.get("unpriced")).isEqualTo(List.of(B));
        assertThat((BigDecimal) summary.get("marketValue")).isEqualByComparingTo("120000");
        assertThat(summary.get("profitLoss")).isNull();
        assertThat(summary.get("profitLossPct")).isNull();
    }

    // ------------------------------------------------------------------ 장부 고침
    @Test
    @DisplayName("행 추가·고침·삭제 — 고친 장부로 다시 셈, 음수가 되는 고침·삭제는 400 ledger-invalid, 없는 행 404, 시작 전 409 not-started")
    void ledgerEdits() {
        rejects(() -> service.saveLedger(row(null, "DEPOSIT", null, null, null, "1000", null, null)), 409, "not-started");
        startSynthetic();

        long sell = (long) service.saveLedger(row(null, "SELL", A, "4", "11000", null, "2026-11-09T09:00", null)).get("id");
        assertThat(ManualAccountLedger.replay(store.ledger("isa").stream().map(ManualAccountLedger.Entry::of).toList()).cash())
                .isEqualByComparingTo("844000");
        rejects(() -> service.saveLedger(row(null, "SELL", A, "7", "11000", null, "2026-11-09T10:00", null)), 400, "ledger-invalid");
        rejects(() -> service.saveLedger(row(sell, "SELL", A, "11", "11000", null, "2026-11-09T09:00", null)), 400, "ledger-invalid");

        service.saveLedger(row(sell, "SELL", A, "6", "11500", null, "2026-11-09T09:00", null));
        LedgerRow edited = store.ledgerRow(sell).orElseThrow();
        assertThat(edited.quantity()).isEqualByComparingTo("6");
        assertThat(edited.price()).isEqualByComparingTo("11500");

        LedgerRow deposit = store.ledger("isa").get(0);
        rejects(() -> service.deleteLedger(deposit.id()), 400, "ledger-invalid");
        service.deleteLedger(sell);
        assertThat(store.ledgerRow(sell)).isEmpty();
        rejects(() -> service.deleteLedger(999_999_999L), 404, "not-found");
        rejects(() -> service.saveLedger(row(999_999_999L, "DEPOSIT", null, null, null, "1", null, null)), 404, "not-found");
        rejects(() -> service.saveLedger(row(null, "BOGUS", null, null, null, "1", null, null)), 400, "invalid-request");
        rejects(() -> service.saveLedger(row(null, "BUY", A, "1.1234567", "100", null, null, null)), 400, "invalid-request");
        rejects(() -> service.saveLedger(row(null, "ADJUST", A, "0", null, null, null, null)), 400, "invalid-request");
    }

    @Test
    @DisplayName("지시에 묶은 행은 그 지시를 RECORDED로(사용자 입력 우선), 방향·종목이 다르면 400, 묶인 마지막 행을 지우면 SKIPPED")
    void linkingToInstructions() {
        startSynthetic();
        long buy = instruction(A, "BUY", 2);

        rejects(() -> service.saveLedger(row(null, "SELL", A, "2", "10000", null, "2026-11-09T09:00", buy)), 400, "invalid-request");
        rejects(() -> service.saveLedger(row(null, "BUY", B, "2", "10000", null, "2026-11-09T09:00", buy)), 400, "invalid-request");
        long id = (long) service.saveLedger(row(null, "BUY", A, "2", "10100", null, "2026-11-09T09:00", buy)).get("id");
        assertThat(store.instruction(buy).orElseThrow().status()).isEqualTo("RECORDED");
        assertThat(store.ledgerRow(id).orElseThrow().instructionId()).isEqualTo(buy);

        service.deleteLedger(id);
        assertThat(store.instruction(buy).orElseThrow().status()).as("다시 자동 기록하지 않게").isEqualTo("SKIPPED");
    }

    @Test
    @DisplayName("ISA-R2: 자동 기록(AUTO) 행만 묶인 지시에 id 없이 그 지시 번호로 새 행을 넣으면 AUTO 행을 지우고 USER 행으로 바꿈(사용자 입력 우선 — 장부에 "
            + "한 번만), USER 행이 이미 묶였으면 409 already-recorded")
    void newRowReplacesAutoRowOnce() {
        startSynthetic();
        long buy = instruction(A, "BUY", 3);
        long autoRow = store.insertLedger("isa", new ManualAccountStore.LedgerValues(kst("2026-11-09T09:00"), "BUY", A, d("3"), d("10200"), null,
                BigDecimal.ZERO, BigDecimal.ZERO, buy, "AUTO", "자동"));
        store.updateInstructionStatus(buy, "RECORDED", "PLANNED", Map.of("recordedBy", "AUTO"));

        long id = (long) service.saveLedger(row(null, "BUY", A, "3", "10150", null, "2026-11-09T09:00", buy)).get("id");

        assertThat(store.ledgerRow(autoRow)).as("자동 기록 행은 지움").isEmpty();
        assertThat(store.ledgerForInstruction(buy)).singleElement().satisfies(r -> {
            assertThat(r.id()).isEqualTo(id);
            assertThat(r.source()).isEqualTo("USER");
            assertThat(r.price()).isEqualByComparingTo("10150");
        });
        assertThat(ManualAccountLedger.replay(store.ledger("isa").stream().map(ManualAccountLedger.Entry::of).toList()).holdings().get(A)
                .quantity()).as("시작 10 + 지시 3 — 두 번 세지 않음").isEqualByComparingTo("13");
        assertThat(store.instruction(buy).orElseThrow().status()).isEqualTo("RECORDED");

        rejects(() -> service.saveLedger(row(null, "BUY", A, "3", "10100", null, "2026-11-09T09:00", buy)), 409, "already-recorded");
        assertThat(store.ledgerForInstruction(buy)).hasSize(1);
    }

    @Test
    @DisplayName("ISA-API-3·4, ISA-R6: 최신 세션보다 앞 세션의 PLANNED 지시는 pendingInstructions(세션 포함)로, instructions 묶음에 개장 시각(open)·"
            + "사유 코드(reason)·ledgerChanged")
    void viewPendingInstructionsAndReason() {
        startSynthetic();
        long earlier = instruction(A, "BUY", 2);
        store.insertSession("isa", MONDAY, "PLANNED", 11L, MAPPER.createObjectNode());
        LocalDate tuesday = MONDAY.plusDays(1);
        store.insertSession("isa", tuesday, "UNAVAILABLE", null, MAPPER.createObjectNode().put("reason", "record-pending"));
        when(paper.sessionHours(any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            LocalTime open = date.equals(tuesday) ? LocalTime.of(10, 0) : LocalTime.of(9, 0);
            return Optional.of(new SessionHours(date, true, date.atTime(open).atZone(Kst.ZONE).toInstant(),
                    date.atTime(15, 30).atZone(Kst.ZONE).toInstant()));
        });

        Map<String, Object> view = service.view();

        @SuppressWarnings("unchecked")
        Map<String, Object> block = (Map<String, Object>) view.get("instructions");
        assertThat(block).containsEntry("session", tuesday.toString()).containsEntry("status", "UNAVAILABLE")
                .containsEntry("open", "2026-11-10T01:00:00Z").containsEntry("reason", "record-pending").containsEntry("ledgerChanged", false);
        assertThat((List<?>) block.get("items")).isEmpty();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> pending = (List<Map<String, Object>>) view.get("pendingInstructions");
        assertThat(pending).singleElement().satisfies(i -> assertThat(i).containsEntry("id", earlier).containsEntry("session", MONDAY.toString())
                .containsEntry("symbol", A).containsEntry("name", "합성전자").containsEntry("status", "PLANNED").containsKey("notifiedMorningAt"));

        store.updateInstructionStatus(earlier, "SKIPPED", "PLANNED", Map.of());
        assertThat((List<?>) service.view().get("pendingInstructions")).isEmpty();
    }

    @Test
    @DisplayName("ISA-API-1: 시작 시각을 비우면 지금을 초 단위로 자른 시각 — 시작 매수 행을 그 시각(초까지) 그대로 고쳐 저장해도 순서가 뒤집히지 않음")
    void startTruncatesToSeconds() {
        clock.set(kst("2026-11-09T21:02:03").plusMillis(456));
        service.start(new ManualAccountService.StartRequest(d("1000000"), null, List.of(new ManualAccountService.StartBuy(A, d("10"), d("10000")))));

        assertThat(store.account("isa").orElseThrow().startedAt()).isEqualTo(kst("2026-11-09T21:02:03"));
        LedgerRow startBuy = store.ledger("isa").get(1);
        assertThat(startBuy.at()).isEqualTo(kst("2026-11-09T21:02:03"));
        service.saveLedger(new ManualAccountService.LedgerRequest(startBuy.id(), "BUY", A, d("10"), d("10000"), null, d("150"), null,
                "2026-11-09T21:02:03", null, null));
        assertThat(store.ledger("isa")).extracting(LedgerRow::kind).containsExactly("DEPOSIT", "BUY");
        assertThat(store.ledgerRow(startBuy.id()).orElseThrow().fee()).isEqualByComparingTo("150");
    }

    @Test
    @DisplayName("ISA-API-6: 시작 입금 행을 고치면 account.startCash도 장부를 따라 바뀜(시작 시각의 입금 합) — summary.netDeposit과 어긋나지 않음")
    void startCashFollowsLedger() {
        startSynthetic();
        LedgerRow deposit = store.ledger("isa").get(0);
        service.saveLedger(row(deposit.id(), "DEPOSIT", null, null, null, "1200000", "2026-11-06T14:55", null));

        Map<String, Object> view = service.view();
        @SuppressWarnings("unchecked")
        Map<String, Object> account = (Map<String, Object>) view.get("account");
        @SuppressWarnings("unchecked")
        Map<String, Object> summary = (Map<String, Object>) view.get("summary");
        assertThat((BigDecimal) account.get("startCash")).isEqualByComparingTo("1200000");
        assertThat((BigDecimal) summary.get("netDeposit")).isEqualByComparingTo("1200000");
    }

    @Test
    @DisplayName("ISA-API-7: 표가 없으면 available:false와 message(안내 글), 목록 칸은 비움")
    void viewWithoutTablesHasMessage() {
        ManualAccountStore missing = mock(ManualAccountStore.class);
        when(missing.ready()).thenReturn(false);
        ManualAccountJob job = new ManualAccountJob(missing, paper, mock(PaperTelegram.class), MAPPER, clock, false, false, 600_000);

        Map<String, Object> view = new ManualAccountService(missing, paper, job, clock).view();

        assertThat(view).containsEntry("available", false).containsEntry("started", false);
        assertThat((String) view.get("message")).contains("V25");
        assertThat((List<?>) view.get("pendingInstructions")).isEmpty();
    }

    @Test
    @DisplayName("자동 기록 행을 고치면 USER가 되고 지시 묶음은 그대로, 지시 건너뜀 — PLANNED는 SKIPPED, 자동 기록만 있는 RECORDED는 그 행을 지우고 SKIPPED, "
            + "직접 입력이 묶였으면 400, 없는 지시 404")
    void editAutoRowAndSkip() {
        startSynthetic();
        long planned = instruction(B, "SELL", 1);
        service.skipInstruction(planned);
        assertThat(store.instruction(planned).orElseThrow().status()).isEqualTo("SKIPPED");
        service.skipInstruction(planned);   // 이미 건너뜀 — 그대로

        long auto = instruction(A, "BUY", 3);
        long autoRow = store.insertLedger("isa", new ManualAccountStore.LedgerValues(kst("2026-11-09T09:00"), "BUY", A, d("3"), d("10200"), null,
                BigDecimal.ZERO, BigDecimal.ZERO, auto, "AUTO", "자동"));
        store.updateInstructionStatus(auto, "RECORDED", "PLANNED", Map.of());
        service.skipInstruction(auto);
        assertThat(store.ledgerRow(autoRow)).isEmpty();
        assertThat(store.instruction(auto).orElseThrow().status()).isEqualTo("SKIPPED");

        long fixed = instruction(C, "BUY", 1);
        long fixedRow = store.insertLedger("isa", new ManualAccountStore.LedgerValues(kst("2026-11-09T09:00"), "BUY", C, d("1"), d("20000"), null,
                BigDecimal.ZERO, BigDecimal.ZERO, fixed, "AUTO", "자동"));
        store.updateInstructionStatus(fixed, "RECORDED", "PLANNED", Map.of());
        service.saveLedger(row(fixedRow, "BUY", C, "1", "20300", null, "2026-11-09T09:00", null));
        LedgerRow user = store.ledgerRow(fixedRow).orElseThrow();
        assertThat(user.source()).isEqualTo("USER");
        assertThat(user.instructionId()).as("본문에 지시 번호가 없어도 묶음 유지").isEqualTo(fixed);
        rejects(() -> service.skipInstruction(fixed), 400, "invalid-request");
        rejects(() -> service.skipInstruction(999_999_999L), 404, "not-found");

        Instruction shown = store.instructions("isa", MONDAY).get(0);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> recent = (List<Map<String, Object>>) service.view().get("recentInstructions");
        assertThat(recent).anySatisfy(i -> assertThat(i).containsEntry("id", shown.id()).containsEntry("session", MONDAY.toString()));
    }
}
