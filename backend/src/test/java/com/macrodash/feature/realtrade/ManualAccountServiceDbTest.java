package com.macrodash.feature.realtrade;

import com.macrodash.analytics.KrxCosts;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperMirrorService.TradeCosts;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.RealTradeFixtures.MutableClock;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.NewInstruction;
import com.macrodash.store.ManualAccountStore.NewStopInstruction;
import com.macrodash.store.ManualAccountStore.Position;
import com.macrodash.store.ManualAccountStore.Trade;
import com.macrodash.store.SchemaCheck;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.realtrade.RealTradeFixtures.MAPPER;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static com.macrodash.feature.realtrade.RealTradeFixtures.kst;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * ISA 계좌 API({@link ManualAccountService}, ADR 0034) — 실제 테스트 DB와 가짜 모의 공개 창으로: 시작 한 번만(현금 계산·이름 해석·옛 지시 닫기), 응답 모양(요약·보유·
 * 지시·매매 내역), 총 잔고·수수료율·보유 고침(현금 음수도 저장), 확인(비용·보유까지 팔기·실시간/직전 종가·±40%·한 트랜잭션), 되돌림, 건너뜀. 종목·금액은 모두 합성 값입니다.
 */
class ManualAccountServiceDbTest {

    static final String A = "005930";
    static final String B = "000660";
    static final String C = "035420";
    static final LocalDate MONDAY = LocalDate.of(2026, 11, 9);
    private static final BigDecimal COMMISSION_BP = new BigDecimal("1.5");

    private JdbcTemplate jdbc;
    private ManualAccountStore store;
    private PaperMirrorService paper;
    private MutableClock clock;
    private ManualAccountService service;

    static ManualAccountStore store(JdbcTemplate jdbc) {
        return new ManualAccountStore(jdbc, MAPPER, new SchemaCheck(jdbc));
    }

    /** 이 기능만 쓰는 표를 비웁니다 — 매매 내역·옛 장부가 지시를, 나머지가 계좌를 참조하는 순서. */
    static void clean(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM manual_trades");
        jdbc.update("DELETE FROM manual_positions");
        jdbc.update("DELETE FROM manual_balance");
        jdbc.update("DELETE FROM manual_ledger");
        jdbc.update("DELETE FROM manual_stop_instructions");
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
        clock = new MutableClock(kst("2026-11-09T11:00"));
        when(paper.book(anyString())).thenAnswer(inv -> Optional.of(new BookInfo(inv.getArgument(0), "한국 규칙 계좌", "RULES", "KR", "ACTIVE",
                LocalDate.of(2026, 10, 30), Instant.parse("2026-10-29T13:00:00Z"), "g")));
        when(paper.names(any())).thenReturn(Map.of(A, "합성전자"));
        when(paper.allKrNames()).thenReturn(Map.of(A, "합성전자", B, "합성하이닉스", C, "합성화학"));
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000"), B, d("21000")));
        when(paper.sessionHours(any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            return Optional.of(new SessionHours(date, true, date.atTime(9, 0).atZone(RealTradeFixtures.SEOUL).toInstant(),
                    date.atTime(15, 30).atZone(RealTradeFixtures.SEOUL).toInstant()));
        });
        // 수수료 = 금액 × bp(원 미만 절사), 세금은 코스피 20bp(매도만) — 실제 계산기로.
        when(paper.krTradeCosts(anyString(), anyBoolean(), anyInt(), any(), any(), any())).thenAnswer(inv -> {
            boolean sell = inv.getArgument(1);
            int quantity = inv.getArgument(2);
            BigDecimal price = inv.getArgument(3);
            BigDecimal bp = inv.getArgument(4);
            KrxCosts.Costs costs = KrxCosts.fill(sell ? PaperLedger.Side.SELL : PaperLedger.Side.BUY, KrxCosts.Instrument.KOSPI, LocalDate.of(2026, 11, 9),
                    quantity, price, new KrxCosts.Rates(bp, BigDecimal.ZERO, KrxCosts.TaxRates.KRX_2026));
            return new TradeCosts(costs.commission(), costs.tax(), C.equals(inv.getArgument(0)));
        });
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

    private static ManualAccountService.StartPosition line(String symbol, String quantity, String purchase) {
        return new ManualAccountService.StartPosition(symbol, d(quantity), d(purchase));
    }

    /** 총 잔고 1,000,000 — 합성전자 10주·합성하이닉스 5주(직전 종가 12,000·21,000) → 현금 775,000. */
    private void startSynthetic() {
        service.start(new ManualAccountService.StartRequest(d("1000000"), List.of(line(A, "10", "100000"), line(B, "5", "100000")), null));
    }

    private Position position(String symbol) {
        return store.position("isa", symbol).orElseThrow();
    }

    private BigDecimal cash() {
        return store.balance("isa").orElseThrow().cash();
    }

    private long instruction(String symbol, String side, int quantity) {
        return instruction(MONDAY, symbol, side, quantity);
    }

    private long instruction(LocalDate session, String symbol, String side, int quantity) {
        return store.insertInstruction(ManualAccountService.CODE, new NewInstruction(session, symbol, side, quantity, d("10000"), d("10"),
                MAPPER.createObjectNode())).orElseThrow();
    }

    private long stop(long paperOrder, String symbol, int quantity) {
        return store.insertStopInstruction(ManualAccountService.CODE, new NewStopInstruction(MONDAY, paperOrder, symbol, quantity, "MARKET", kst("2026-11-09T10:30"),
                MAPPER.createObjectNode())).orElseThrow();
    }

    private static ManualAccountService.ApplyItem item(Long instructionId, Long stopId, String price, String source) {
        return new ManualAccountService.ApplyItem(instructionId, stopId, price == null ? null : d(price), source);
    }

    private Map<String, Object> apply(ManualAccountService.ApplyItem... items) {
        return service.apply(new ManualAccountService.ApplyRequest(List.of(items)));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> summary() {
        return (Map<String, Object>) service.view().get("summary");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Map<String, Object>> rows() {
        Map<String, Map<String, Object>> out = new HashMap<>();
        ((List<Map<String, Object>>) service.view().get("positions")).forEach(r -> out.put((String) r.get("symbol"), r));
        return out;
    }

    // ------------------------------------------------------------------ 시작
    @Test
    @DisplayName("시작은 한 번만 — 현금 = 총평가금액 − Σ(수량 × 직전 종가), 보유·시작 시각, 다시 시작하면 409 already-started")
    void startsOnce() {
        startSynthetic();

        assertThat(store.account("isa")).hasValueSatisfying(a -> {
            assertThat(a.label()).isEqualTo("ISA 계좌");
            assertThat(a.sourceBook()).isEqualTo("kr_rules");
            assertThat(a.state()).isEqualTo("ACTIVE");
        });
        assertThat(store.balance("isa")).hasValueSatisfying(b -> {
            assertThat(b.cash()).isEqualByComparingTo("775000");
            assertThat(b.commissionBp()).as("기본 1.5bp").isEqualByComparingTo("1.5");
            assertThat(b.startedAt()).isEqualTo(kst("2026-11-09T11:00"));
        });
        assertThat(position(A).quantity()).isEqualByComparingTo("10");
        assertThat(position(A).purchaseAmount()).isEqualByComparingTo("100000");
        rejects(this::startSynthetic, 409, "already-started");
    }

    @Test
    @DisplayName("시작 가격 — 본문 실시간 → 직전 종가 → 매입 금액 어림(메모), 현금이 음수여도 저장(막지 않음)")
    void startPricePrecedence() {
        when(paper.lastPrices(any())).thenReturn(Map.of(B, d("21000")));
        Map<String, Object> reply = service.start(new ManualAccountService.StartRequest(d("100000"),
                List.of(line(A, "10", "100000"), line(B, "5", "90000"), line(C, "4", "20000")), Map.of(A, d("13000"))));

        // A: 실시간 130,000 + B: 직전 종가 105,000 + C: 어림 20,000 → 현금 100,000 − 255,000
        assertThat(cash()).isEqualByComparingTo("-155000");
        assertThat(reply.get("notes")).asList().hasSize(1).first().asString().contains("어림");
    }

    @Test
    @DisplayName("시작 — 이름으로 넣으면 코드로, 못 찾거나 여럿이면 400, 같은 종목 두 줄·잘못된 값 400이고 아무것도 쓰지 않음")
    void startResolvesNames() {
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("100"), List.of(line("없는이름", "1", "1")), null)), 400, "invalid-request");
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("100"), List.of(line("합성", "1", "1")), null)), 400, "invalid-request");
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("100"), List.of(line(A, "1", "1"), line("합성전자", "2", "2")), null)), 400, "invalid-request");
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("0"), List.of(), null)), 400, "invalid-request");
        rejects(() -> service.start(new ManualAccountService.StartRequest(null, List.of(), null)), 400, "invalid-request");
        rejects(() -> service.start(new ManualAccountService.StartRequest(d("100"), List.of(line(A, "0", "1")), null)), 400, "invalid-request");
        assertThat(store.balance("isa")).isEmpty();
        assertThat(store.account("isa")).as("계좌 행도 쓰지 않음").isEmpty();

        service.start(new ManualAccountService.StartRequest(d("1000000"), List.of(line("합성화학", "1", "1000")), null));
        assertThat(store.positions("isa")).extracting(Position::symbol).containsExactly(C);
    }

    @Test
    @DisplayName("시작 — 이미 있는 계좌 행은 재사용하고, 옛 PLANNED 지시·스탑 지시는 SKIPPED(restart), 아직 열리지 않은 세션은 지워 새 잔고로 다시 만들게 함")
    void startReusesAccountAndClosesOld() {
        store.insertAccount("isa", "옛 이름", "KR", "kr_rules", kst("2026-11-01T09:00"), d("1"));
        long past = instruction(MONDAY.minusDays(3), A, "BUY", 1);
        long oldStop = stop(71, A, 1);
        LocalDate tomorrow = MONDAY.plusDays(1);
        long upcoming = instruction(tomorrow, A, "SELL", 1);
        store.insertSession("isa", MONDAY.minusDays(3), "PLANNED", null, MAPPER.createObjectNode());
        store.insertSession("isa", tomorrow, "PLANNED", null, MAPPER.createObjectNode());

        startSynthetic();

        assertThat(store.account("isa").orElseThrow().label()).isEqualTo("옛 이름");
        assertThat(store.instruction(past).orElseThrow()).satisfies(i -> {
            assertThat(i.status()).isEqualTo("SKIPPED");
            assertThat(i.reason().path("autoNote").asString()).isEqualTo("restart");
        });
        assertThat(store.stopInstruction(oldStop).orElseThrow().status()).isEqualTo("SKIPPED");
        assertThat(store.instruction(upcoming)).as("아직 열리지 않은 세션의 지시 — 같은 (세션, 종목) 유일 제약이라 지움").isEmpty();
        assertThat(store.session("isa", tomorrow)).isEmpty();
        assertThat(store.session("isa", MONDAY.minusDays(3))).as("지난 세션 기록은 남김").isPresent();
    }

    // ------------------------------------------------------------------ 보기
    @Test
    @DisplayName("보기 — 요약(현금·평가액·총 잔고·매입 금액 합·평가손익·수수료율), 보유(평단·현재가·평가액·손익·비중·수수료·세금 누적), 없는 값 null")
    void viewShape() {
        startSynthetic();
        long sell = instruction(A, "SELL", 4);
        apply(item(sell, null, "12000", "live"));

        Map<String, Object> view = service.view();
        assertThat(view).containsEntry("available", true).containsEntry("started", true);
        @SuppressWarnings("unchecked")
        Map<String, Object> summary = (Map<String, Object>) view.get("summary");
        // 현금 775,000 + 48,000 − 수수료 7 − 세금 96 = 822,897; A 6주·B 5주 평가 72,000 + 105,000
        assertThat((BigDecimal) summary.get("cash")).isEqualByComparingTo("822897");
        assertThat((BigDecimal) summary.get("marketValue")).isEqualByComparingTo("177000");
        assertThat((BigDecimal) summary.get("totalAsset")).isEqualByComparingTo("999897");
        assertThat((BigDecimal) summary.get("purchaseTotal")).isEqualByComparingTo("160000");
        assertThat((BigDecimal) summary.get("profitLoss")).isEqualByComparingTo("17000");
        assertThat((BigDecimal) summary.get("profitLossPct")).isEqualByComparingTo("10.63");
        assertThat((BigDecimal) summary.get("feesPaid")).isEqualByComparingTo("7");
        assertThat((BigDecimal) summary.get("taxesPaid")).isEqualByComparingTo("96");
        assertThat((BigDecimal) summary.get("commissionPct")).isEqualByComparingTo("0.015");
        assertThat(summary.get("unpriced")).asList().isEmpty();

        Map<String, Object> a = rows().get(A);
        assertThat(a).containsEntry("name", "합성전자");
        assertThat((BigDecimal) a.get("avgPrice")).isEqualByComparingTo("10000");
        assertThat((BigDecimal) a.get("purchaseAmount")).isEqualByComparingTo("60000");
        assertThat((BigDecimal) a.get("lastPrice")).isEqualByComparingTo("12000");
        assertThat((BigDecimal) a.get("marketValue")).isEqualByComparingTo("72000");
        assertThat((BigDecimal) a.get("profitLoss")).isEqualByComparingTo("12000");
        assertThat((BigDecimal) a.get("profitLossPct")).isEqualByComparingTo("20");
        assertThat((BigDecimal) a.get("weightPct")).isEqualByComparingTo("7.20");
        assertThat((BigDecimal) a.get("feesPaid")).isEqualByComparingTo("7");
        assertThat((BigDecimal) a.get("taxesPaid")).isEqualByComparingTo("96");
        assertThat((BigDecimal) rows().get(B).get("feesPaid")).as("낸 비용이 없으면 0").isEqualByComparingTo("0");

        @SuppressWarnings("unchecked")
        Map<String, Object> trade = ((List<Map<String, Object>>) view.get("trades")).getFirst();
        assertThat(trade).containsEntry("side", "SELL").containsEntry("symbol", A).containsEntry("name", "합성전자").containsEntry("priceSource", "live")
                .containsEntry("taxAssumed", false).containsEntry("instructionId", sell);
        assertThat((BigDecimal) trade.get("amount")).isEqualByComparingTo("48000");
        assertThat((BigDecimal) trade.get("realizedPnl")).isEqualByComparingTo("7897");
        assertThat((BigDecimal) trade.get("realizedPct")).isEqualByComparingTo("19.74");
    }

    @Test
    @DisplayName("시작 전이면 started=false·요약 없음, 가격을 모르는 보유는 평가에서 빼고 unpriced에 담고 손익은 비움, 고친 이름을 표시, 표가 없으면 available=false")
    void viewBeforeStartAndUnpriced() {
        Map<String, Object> before = service.view();
        assertThat(before).containsEntry("available", true).containsEntry("started", false);
        assertThat(before.get("summary")).isNull();
        assertThat(before.get("positions")).asList().isEmpty();

        startSynthetic();
        service.savePosition(new ManualAccountService.PositionRequest(B, B, "합성 하이닉스 우선", d("5"), d("20000")));
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000")));
        Map<String, Object> summary = summary();
        assertThat(summary.get("unpriced")).asList().containsExactly(B);
        assertThat(summary.get("profitLoss")).isNull();
        assertThat(summary.get("profitLossPct")).isNull();
        Map<String, Object> b = rows().get(B);
        assertThat(b).containsEntry("name", "합성 하이닉스 우선");
        assertThat(b.get("lastPrice")).isNull();
        assertThat(b.get("marketValue")).isNull();
        assertThat(b.get("profitLoss")).isNull();
        assertThat(b.get("weightPct")).isNull();

        SchemaCheck noTables = mock(SchemaCheck.class);
        ManualAccountStore notReady = new ManualAccountStore(jdbc, MAPPER, noTables);
        ManualAccountJob off = new ManualAccountJob(notReady, paper, mock(PaperTelegram.class), MAPPER, clock, false, false, 600_000);
        Map<String, Object> view = new ManualAccountService(notReady, paper, off, clock).view();
        assertThat(view).containsEntry("available", false).containsEntry("started", false);
        assertThat(view.get("message")).asString().contains("V32");
    }

    // ------------------------------------------------------------------ 잔고 고침
    @Test
    @DisplayName("총 잔고 다시 맞추기 — 현금만 다시 셈(본문 가격 → 직전 종가), 시작 전 409")
    void setTotal() {
        rejects(() -> service.setTotal(new ManualAccountService.TotalRequest(d("1000"), null)), 409, "not-started");
        startSynthetic();

        service.setTotal(new ManualAccountService.TotalRequest(d("800000"), Map.of(A, d("13000"))));

        // A 130,000 + B 105,000
        assertThat(cash()).isEqualByComparingTo("565000");
        assertThat(position(A).quantity()).isEqualByComparingTo("10");
    }

    @Test
    @DisplayName("수수료율 — 0~1%, 다음 확인부터 그 요율로, 범위 밖 400")
    void setCommission() {
        startSynthetic();
        service.setCommission(new ManualAccountService.CommissionRequest(d("0.1")));
        assertThat(store.balance("isa").orElseThrow().commissionBp()).isEqualByComparingTo("10");
        assertThat((BigDecimal) summary().get("commissionPct")).isEqualByComparingTo("0.1");

        long buy = instruction(A, "BUY", 1);
        apply(item(buy, null, "12000", "live"));
        assertThat(store.recentTrades("isa", 1).getFirst().fee()).as("12,000 × 10bp").isEqualByComparingTo("12");

        rejects(() -> service.setCommission(new ManualAccountService.CommissionRequest(d("1.5"))), 400, "invalid-request");
        rejects(() -> service.setCommission(new ManualAccountService.CommissionRequest(null)), 400, "invalid-request");
    }

    @Test
    @DisplayName("보유 추가·고치기 — 매입 금액 = 수량 × 가격, 코드가 바뀌면 옮김, 이미 있는 코드로 옮기거나 추가하면 400, 없는 행 404, 현금은 그대로")
    void savePosition() {
        startSynthetic();
        BigDecimal before = cash();

        service.savePosition(new ManualAccountService.PositionRequest(null, "합성화학", null, d("3"), d("5000")));
        assertThat(position(C).purchaseAmount()).isEqualByComparingTo("15000");
        assertThat(cash()).as("보유 고침은 현금을 바꾸지 않음").isEqualByComparingTo(before);

        service.savePosition(new ManualAccountService.PositionRequest(C, C, null, d("4"), d("5000")));
        assertThat(position(C).quantity()).isEqualByComparingTo("4");

        service.savePosition(new ManualAccountService.PositionRequest(C, "051910", "합성소재", d("4"), d("5000")));
        assertThat(store.position("isa", C)).isEmpty();
        assertThat(position("051910").name()).isEqualTo("합성소재");

        rejects(() -> service.savePosition(new ManualAccountService.PositionRequest("051910", A, null, d("1"), d("1"))), 400, "invalid-request");
        rejects(() -> service.savePosition(new ManualAccountService.PositionRequest(null, A, null, d("1"), d("1"))), 400, "invalid-request");
        rejects(() -> service.savePosition(new ManualAccountService.PositionRequest("999999", C, null, d("1"), d("1"))), 404, "not-found");
        rejects(() -> service.savePosition(new ManualAccountService.PositionRequest(null, "없는이름", null, d("1"), d("1"))), 400, "invalid-request");
        rejects(() -> service.savePosition(new ManualAccountService.PositionRequest(null, B, null, d("0"), d("1"))), 400, "invalid-request");

        service.deletePosition("051910");
        assertThat(store.position("isa", "051910")).isEmpty();
        rejects(() -> service.deletePosition("051910"), 404, "not-found");
        rejects(() -> service.deletePosition("abc"), 404, "not-found");
    }

    // ------------------------------------------------------------------ 확인
    @Test
    @DisplayName("확인 매수 — 화면 가격으로 현금 −(금액 + 수수료), 매입 금액·수량 +, RECORDED(recordedBy USER), 내역에 가격 출처, 시각은 누른 순간")
    void applyBuy() {
        startSynthetic();
        long buy = instruction(A, "BUY", 2);

        Map<String, Object> reply = apply(item(buy, null, "12100", "live"));

        assertThat(reply).containsEntry("count", 1).containsEntry("skipped", 0);
        assertThat(cash()).as("775,000 − 24,200 − 수수료 3").isEqualByComparingTo("750797");
        assertThat(position(A).quantity()).isEqualByComparingTo("12");
        assertThat(position(A).purchaseAmount()).isEqualByComparingTo("124200");
        Instruction row = store.instruction(buy).orElseThrow();
        assertThat(row.status()).isEqualTo("RECORDED");
        assertThat(row.reason().path("recordedBy").asString()).isEqualTo("USER");
        Trade trade = store.recentTrades("isa", 1).getFirst();
        assertThat(trade.at()).isEqualTo(kst("2026-11-09T11:00"));
        assertThat(trade.side()).isEqualTo("BUY");
        assertThat(trade.priceSource()).isEqualTo("live");
        assertThat(trade.costBasis()).isEqualByComparingTo("24200");
        assertThat(trade.realizedPnl()).isNull();
        assertThat(trade.instructionId()).isEqualTo(buy);
        assertThat(trade.toString()).as("로그에 금액을 싣지 않음").doesNotContain("24200");
    }

    @Test
    @DisplayName("확인 매도 — 비용·세금을 빼고, 매입 금액은 판 비율만큼, 실현 손익. 가격이 없으면 서버 직전 종가(close). 전량이면 행을 없앰")
    void applySell() {
        startSynthetic();
        long partial = instruction(A, "SELL", 4);
        long all = instruction(B, "SELL", 5);

        Map<String, Object> reply = apply(item(partial, null, null, null), item(all, null, "21000", "close"));

        assertThat(reply).containsEntry("count", 2);
        Trade soldA = store.recentTrades("isa", 200).stream().filter(t -> t.symbol().equals(A)).findFirst().orElseThrow();
        assertThat(soldA.priceSource()).isEqualTo("close");
        assertThat(soldA.price()).isEqualByComparingTo("12000");
        assertThat(soldA.fee()).isEqualByComparingTo("7");
        assertThat(soldA.tax()).isEqualByComparingTo("96");
        assertThat(soldA.costBasis()).isEqualByComparingTo("40000");
        assertThat(soldA.realizedPnl()).isEqualByComparingTo("7897");
        assertThat(position(A).quantity()).isEqualByComparingTo("6");
        assertThat(position(A).purchaseAmount()).isEqualByComparingTo("60000");
        assertThat(store.position("isa", B)).as("전량 매도 — 행 없앰").isEmpty();
        // 현금: 775,000 + (48,000 − 7 − 96) + (105,000 − 15 − 209 — 거래세 52 + 농특세 157)
        assertThat(cash()).isEqualByComparingTo("927673");
    }

    @Test
    @DisplayName("확인 매도 — 지시보다 적으면 보유까지(정수 주)만, 팔 보유가 없으면 그 지시만 SKIPPED(no-holding)하고 나머지는 반영")
    void applySellClampsAndSkips() {
        startSynthetic();
        store.upsertPosition("isa", A, null, d("3.5"), d("35000"));
        long clamp = instruction(A, "SELL", 10);
        long none = instruction(C, "SELL", 2);
        long buy = instruction(B, "BUY", 1);

        Map<String, Object> reply = apply(item(clamp, null, "12000", "live"), item(none, null, "5000", "live"), item(buy, null, "21000", "live"));

        assertThat(reply).containsEntry("count", 2).containsEntry("skipped", 1);
        assertThat(position(A).quantity()).as("3주까지만 — 0.5주는 남김").isEqualByComparingTo("0.5");
        assertThat(store.instruction(none).orElseThrow()).satisfies(i -> {
            assertThat(i.status()).isEqualTo("SKIPPED");
            assertThat(i.reason().path("autoNote").asString()).isEqualTo("no-holding");
        });
        assertThat(store.instruction(buy).orElseThrow().status()).isEqualTo("RECORDED");
    }

    @Test
    @DisplayName("확인 — 스탑 지시도 같은 길로(내역은 stopInstructionId), 세금 어림 표시, 매도가 현금을 음수로 만들어도 저장")
    void applyStopAndNegativeCash() {
        startSynthetic();
        long stop = stop(71, A, 5);
        apply(item(null, stop, "12000", "live"));
        assertThat(store.stopInstruction(stop).orElseThrow().status()).isEqualTo("RECORDED");
        Trade trade = store.recentTrades("isa", 1).getFirst();
        assertThat(trade.stopInstructionId()).isEqualTo(stop);
        assertThat(trade.instructionId()).isNull();

        store.upsertPosition("isa", C, null, d("2"), d("100"));
        long sellC = instruction(C, "SELL", 1);
        apply(item(sellC, null, "5000", "live"));
        assertThat(store.recentTrades("isa", 1).getFirst().taxAssumed()).as("시장 구분을 모르는 종목").isTrue();

        long big = instruction(B, "BUY", 100);
        apply(item(big, null, "21000", "live"));
        assertThat(cash()).as("막지 않고 저장").isNegative();
    }

    @Test
    @DisplayName("확인 — 직전 종가 ±40% 밖 400, 가격을 모르면 400, 한 줄이라도 안 되면 아무것도 쓰지 않음(한 트랜잭션), 이미 확인 409, 건너뜀 400, 없는 지시 404, 형식 400")
    void applyRejects() {
        startSynthetic();
        long ok = instruction(A, "BUY", 1);
        long bad = instruction(B, "BUY", 1);

        rejects(() -> apply(item(ok, null, "12000", "live"), item(bad, null, "40000", "live")), 400, "invalid-request");
        assertThat(store.instruction(ok).orElseThrow().status()).as("앞줄도 되돌림").isEqualTo("PLANNED");
        assertThat(cash()).isEqualByComparingTo("775000");
        assertThat(store.recentTrades("isa", 10)).isEmpty();

        rejects(() -> apply(item(instruction(C, "BUY", 1), null, null, null)), 400, "invalid-request");   // C는 직전 종가 없음
        apply(item(ok, null, "12000", "live"));
        rejects(() -> apply(item(ok, null, "12000", "live")), 409, "already-recorded");

        store.updateInstructionStatus(bad, "SKIPPED", "PLANNED", Map.of("skippedBy", "USER"));
        rejects(() -> apply(item(bad, null, "21000", "live")), 400, "invalid-request");
        rejects(() -> apply(item(999_999L, null, "21000", "live")), 404, "not-found");
        rejects(() -> apply(item(1L, 2L, "21000", "live")), 400, "invalid-request");
        rejects(() -> apply(item(null, null, "21000", "live")), 400, "invalid-request");
        rejects(() -> apply(item(5L, null, "21000", "live"), item(5L, null, "21000", "live")), 400, "invalid-request");
        rejects(() -> apply(item(5L, null, "21000", "bid")), 400, "invalid-request");
        rejects(() -> service.apply(new ManualAccountService.ApplyRequest(List.of())), 400, "invalid-request");
    }

    @Test
    @DisplayName("확인 — 시작 전 409")
    void applyBeforeStart() {
        rejects(() -> apply(item(1L, null, "21000", "live")), 409, "not-started");
    }

    // ------------------------------------------------------------------ 되돌림·건너뜀
    @Test
    @DisplayName("되돌리기 — 매수는 현금·수량·매입 금액을 정확히 되돌리고 지시는 PLANNED(recordedBy 지움), 내역 행은 지움")
    void undoBuy() {
        startSynthetic();
        long buy = instruction(A, "BUY", 2);
        apply(item(buy, null, "12100", "live"));
        long tradeId = store.recentTrades("isa", 1).getFirst().id();

        service.undoTrade(tradeId);

        assertThat(cash()).isEqualByComparingTo("775000");
        assertThat(position(A).quantity()).isEqualByComparingTo("10");
        assertThat(position(A).purchaseAmount()).isEqualByComparingTo("100000");
        Instruction row = store.instruction(buy).orElseThrow();
        assertThat(row.status()).isEqualTo("PLANNED");
        assertThat(row.reason().has("recordedBy")).isFalse();
        assertThat(store.recentTrades("isa", 10)).isEmpty();
        rejects(() -> service.undoTrade(tradeId), 404, "not-found");
    }

    @Test
    @DisplayName("되돌리기 — 전량 매도를 되돌리면 행이 다시 생기고, 그 세션 마감이 지났으면 지시는 SKIPPED(expired)")
    void undoSellAfterClose() {
        startSynthetic();
        long sell = instruction(B, "SELL", 5);
        apply(item(sell, null, "21000", "live"));
        assertThat(store.position("isa", B)).isEmpty();

        clock.set(kst("2026-11-09T16:00"));
        service.undoTrade(store.recentTrades("isa", 1).getFirst().id());

        assertThat(position(B).quantity()).isEqualByComparingTo("5");
        assertThat(position(B).purchaseAmount()).isEqualByComparingTo("100000");
        assertThat(cash()).isEqualByComparingTo("775000");
        Instruction row = store.instruction(sell).orElseThrow();
        assertThat(row.status()).isEqualTo("SKIPPED");
        assertThat(row.reason().path("autoNote").asString()).isEqualTo("expired");
    }

    @Test
    @DisplayName("되돌리기 — 스탑 지시도 다시 PLANNED")
    void undoStop() {
        startSynthetic();
        long stop = stop(71, A, 5);
        apply(item(null, stop, "12000", "live"));
        service.undoTrade(store.recentTrades("isa", 1).getFirst().id());
        assertThat(store.stopInstruction(stop).orElseThrow().status()).isEqualTo("PLANNED");
    }

    @Test
    @DisplayName("건너뜀 — PLANNED는 SKIPPED, 이미 건너뛴 지시는 그대로, 확인한 지시는 409, 대체된 지시 400, 없는 지시 404, 시작 전 409")
    void skip() {
        rejects(() -> service.skipInstruction(1), 409, "not-started");
        startSynthetic();
        long planned = instruction(A, "BUY", 1);
        service.skipInstruction(planned);
        assertThat(store.instruction(planned).orElseThrow().status()).isEqualTo("SKIPPED");
        service.skipInstruction(planned);

        long recorded = instruction(B, "BUY", 1);
        apply(item(recorded, null, "21000", "live"));
        rejects(() -> service.skipInstruction(recorded), 409, "already-recorded");

        long superseded = instruction(C, "BUY", 1);
        store.updateInstructionStatus(superseded, "SUPERSEDED", "PLANNED", Map.of());
        rejects(() -> service.skipInstruction(superseded), 400, "invalid-request");
        rejects(() -> service.skipInstruction(999_999), 404, "not-found");
    }

    // ------------------------------------------------------------------ '확인' 창의 입력(2026-11-09 — 수량·체결 금액·평균 단가·수수료)
    private static ManualAccountService.ApplyItem filled(Long instructionId, Long stopId, String quantity, String amount, String fee) {
        return new ManualAccountService.ApplyItem(instructionId, stopId, null, "user", d(quantity), d(amount), fee == null ? null : d(fee));
    }

    private Trade onlyTrade() {
        List<Trade> trades = store.recentTrades("isa", 10);
        assertThat(trades).hasSize(1);
        return trades.get(0);
    }

    @Test
    @DisplayName("확인 입력 매도 — 적은 수량·체결 금액·수수료 그대로 현금·실현 손익에, 평균 단가는 금액 ÷ 수량, 세금은 자동, 지시와 다른 수량도 받음")
    void applyWithEnteredAmountSell() {
        startSynthetic();                                          // 현금 775,000, A 10주(매입 100,000)
        long id = instruction(A, "SELL", 10);

        apply(filled(id, null, "4", "50001", "30"));

        Trade t = onlyTrade();
        assertThat(t.quantity()).isEqualByComparingTo("4");
        assertThat(t.gross()).as("적은 금액 그대로").isEqualByComparingTo("50001");
        assertThat(t.price()).as("평균 단가").isEqualByComparingTo("12500.25");
        assertThat(t.fee()).as("적은 수수료").isEqualByComparingTo("30");
        assertThat(t.tax()).as("세금 자동").isPositive();
        assertThat(t.priceSource()).isEqualTo("user");
        assertThat(cash()).isEqualByComparingTo(d("775000").add(d("50001")).subtract(d("30")).subtract(t.tax()));
        assertThat(position(A).quantity()).isEqualByComparingTo("6");
        assertThat(position(A).purchaseAmount()).as("판 비율만큼").isEqualByComparingTo("60000");
        assertThat(t.realizedPnl()).isEqualByComparingTo(d("50001").subtract(d("40000")).subtract(d("30")).subtract(t.tax()));
        assertThat(store.instruction(id).orElseThrow().status()).isEqualTo("RECORDED");
    }

    @Test
    @DisplayName("확인 입력 매수 — 적은 금액만큼 현금·매입 금액, 수수료를 안 적으면 수수료율로 자동")
    void applyWithEnteredAmountBuy() {
        startSynthetic();
        long id = instruction(B, "BUY", 2);

        apply(new ManualAccountService.ApplyItem(id, null, null, null, d("3"), d("65000"), null));

        Trade t = onlyTrade();
        assertThat(t.gross()).isEqualByComparingTo("65000");
        assertThat(t.fee()).as("1.5bp 절사").isEqualByComparingTo("9");
        assertThat(t.priceSource()).isEqualTo("user");
        assertThat(position(B).quantity()).isEqualByComparingTo("8");
        assertThat(position(B).purchaseAmount()).isEqualByComparingTo("165000");
        assertThat(cash()).isEqualByComparingTo(d("775000").subtract(d("65000")).subtract(d("9")));
    }

    @Test
    @DisplayName("확인 입력 — 총액 칸에 단가를 적으면(평균 단가가 종가 ±40% 밖) 400, 정수 아닌 수량·보유보다 많은 매도·음수 수수료는 400, 아무것도 쓰지 않음")
    void applyEnteredGuards() {
        startSynthetic();
        long good = instruction(B, "BUY", 1);
        long sell = instruction(A, "SELL", 10);
        assertThatThrownBy(() -> apply(filled(good, null, "1", "21000", null), filled(sell, null, "10", "12000", null)))
                .isInstanceOfSatisfying(ManualAccountException.class, e -> {
                    assertThat(e.status()).isEqualTo(400);
                    assertThat(e.getMessage()).contains(A).contains("체결 금액(총액)");
                });
        assertThat(cash()).isEqualByComparingTo("775000");
        assertThat(store.instruction(good).orElseThrow().status()).isEqualTo("PLANNED");

        rejects(() -> apply(filled(sell, null, "1.5", "18000", null)), 400, "invalid-request");
        rejects(() -> apply(filled(sell, null, "11", "132000", null)), 400, "invalid-request");
        rejects(() -> apply(filled(sell, null, "10", "120000", "-1")), 400, "invalid-request");
        rejects(() -> apply(filled(sell, null, "10", "0", null)), 400, "invalid-request");
        assertThat(store.recentTrades("isa", 10)).isEmpty();
    }

    @Test
    @DisplayName("매매 내역 고치기 — 일부 매도의 금액·수수료를 고치면 현금·실현 손익이 그 값으로, 수량을 고치면 보유·매입 금액도, 되돌리면 시작 잔고로")
    void editTradeSell() {
        startSynthetic();
        long id = instruction(A, "SELL", 4);
        apply(filled(id, null, "4", "48000", "10"));
        Trade first = onlyTrade();

        service.editTrade(first.id(), new ManualAccountService.EditTradeRequest(d("4"), d("50000"), d("20")));

        Trade edited = onlyTrade();
        assertThat(edited.gross()).isEqualByComparingTo("50000");
        assertThat(edited.fee()).isEqualByComparingTo("20");
        assertThat(edited.at()).as("시각은 그대로").isEqualTo(first.at());
        assertThat(edited.priceSource()).isEqualTo("user");
        assertThat(edited.costBasis()).isEqualByComparingTo("40000");
        assertThat(position(A).quantity()).isEqualByComparingTo("6");
        assertThat(cash()).isEqualByComparingTo(d("775000").add(d("50000")).subtract(d("20")).subtract(edited.tax()));
        assertThat(edited.realizedPnl()).isEqualByComparingTo(d("10000").subtract(d("20")).subtract(edited.tax()));

        service.editTrade(edited.id(), new ManualAccountService.EditTradeRequest(d("5"), d("60000"), d("20")));
        assertThat(position(A).quantity()).isEqualByComparingTo("5");
        assertThat(position(A).purchaseAmount()).isEqualByComparingTo("50000");

        service.undoTrade(edited.id());
        assertThat(position(A).quantity()).isEqualByComparingTo("10");
        assertThat(position(A).purchaseAmount()).isEqualByComparingTo("100000");
        assertThat(cash()).isEqualByComparingTo("775000");
        assertThat(store.instruction(id).orElseThrow().status()).isEqualTo("PLANNED");
    }

    @Test
    @DisplayName("매매 내역 고치기 — 새로 산 종목의 매수를 고쳐도 줄이 유지되고, 전량 매도를 고치면 줄 없이 현금만, 없는 행 404·보유보다 많은 매도·범위 밖 400")
    void editTradeBuyAndGuards() {
        startSynthetic();
        long buy = instruction(C, "BUY", 2);
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000"), B, d("21000"), C, d("30000")));
        apply(filled(buy, null, "2", "60000", "9"));
        long tradeId = onlyTrade().id();

        service.editTrade(tradeId, new ManualAccountService.EditTradeRequest(d("3"), d("91000"), d("9")));
        assertThat(position(C).quantity()).isEqualByComparingTo("3");
        assertThat(position(C).purchaseAmount()).isEqualByComparingTo("91000");
        assertThat(cash()).isEqualByComparingTo(d("775000").subtract(d("91000")).subtract(d("9")));

        rejects(() -> service.editTrade(999_999, new ManualAccountService.EditTradeRequest(d("1"), d("30000"), null)), 404, "not-found");
        rejects(() -> service.editTrade(tradeId, new ManualAccountService.EditTradeRequest(d("3"), d("9000"), null)), 400, "invalid-request");
        rejects(() -> service.editTrade(tradeId, null), 400, "invalid-request");

        long sell = instruction(A, "SELL", 10);
        apply(filled(sell, null, "10", "120000", "5"));
        Trade sold = store.recentTrades("isa", 10).stream().filter(t -> "SELL".equals(t.side())).findFirst().orElseThrow();
        assertThat(store.position("isa", A)).isEmpty();
        service.editTrade(sold.id(), new ManualAccountService.EditTradeRequest(d("10"), d("125000"), d("5")));
        assertThat(store.position("isa", A)).as("전량 매도는 고쳐도 줄 없음").isEmpty();
        rejects(() -> service.editTrade(sold.id(), new ManualAccountService.EditTradeRequest(d("11"), d("137500"), d("5"))), 400, "invalid-request");
    }

    // ------------------------------------------------------------------ QA-339: 매수 내역을 고치거나 되돌릴 때 그 뒤에 판 수량
    private Trade tradeOf(String side) {
        return store.recentTrades("isa", 10).stream().filter(t -> side.equals(t.side())).findFirst().orElseThrow();
    }

    /** 합성화학 4주를 400,000에 사고(보유 4·매입 400,000) {@code sold}주를 주당 100,000에 판 상태. */
    private void boughtFourThenSold(int sold) {
        startSynthetic();
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000"), B, d("21000"), C, d("100000")));
        apply(filled(instruction(C, "BUY", 4), null, "4", "400000", "60"));
        // 같은 (세션, 종목)에는 지시가 하나뿐이라 매도 지시는 다음 세션 것으로 둡니다.
        apply(filled(instruction(MONDAY.plusDays(1), C, "SELL", sold), null, String.valueOf(sold), String.valueOf(100_000L * sold), "15"));
    }

    @Test
    @DisplayName("QA-339 고치기 — 매수 뒤에 일부를 판 다음 그 매수의 수수료만 고쳐도 보유 수량·매입 금액은 그대로, 금액만 고치면 남은 몫만큼만 바뀜")
    void editTradeBuyAfterLaterSell() {
        boughtFourThenSold(1);
        assertThat(position(C).quantity()).isEqualByComparingTo("3");
        assertThat(position(C).purchaseAmount()).isEqualByComparingTo("300000");
        BigDecimal cashBefore = cash();
        long buyId = tradeOf("BUY").id();

        service.editTrade(buyId, new ManualAccountService.EditTradeRequest(d("4"), d("400000"), d("70")));

        assertThat(position(C).quantity()).as("판 1주가 되살아나지 않음").isEqualByComparingTo("3");
        assertThat(position(C).purchaseAmount()).isEqualByComparingTo("300000");
        assertThat(cash()).as("현금은 수수료 차이만").isEqualByComparingTo(cashBefore.subtract(d("10")));

        service.editTrade(buyId, new ManualAccountService.EditTradeRequest(d("4"), d("440000"), d("70")));
        assertThat(position(C).quantity()).isEqualByComparingTo("3");
        assertThat(position(C).purchaseAmount()).as("남은 3/4 몫만 — 300,000 + (440,000 − 400,000) × 3/4").isEqualByComparingTo("330000");
        assertThat(cash()).isEqualByComparingTo(cashBefore.subtract(d("10")).subtract(d("40000")));
    }

    @Test
    @DisplayName("QA-339 고치기 — 전량을 판 뒤 매수를 고쳐도 보유 줄이 다시 생기지 않고, 판 수량보다 적게는 고칠 수 없음(400)")
    void editTradeBuyAfterFullSell() {
        boughtFourThenSold(4);
        assertThat(store.position("isa", C)).isEmpty();
        long buyId = tradeOf("BUY").id();

        service.editTrade(buyId, new ManualAccountService.EditTradeRequest(d("4"), d("400000"), d("70")));
        assertThat(store.position("isa", C)).as("다 판 종목의 줄이 4주로 되살아나지 않음").isEmpty();

        rejects(() -> service.editTrade(buyId, new ManualAccountService.EditTradeRequest(d("3"), d("300000"), d("70"))), 400, "invalid-request");
        assertThat(store.position("isa", C)).isEmpty();
        assertThat(tradeOf("BUY").quantity()).as("거절된 고치기는 내역을 바꾸지 않음").isEqualByComparingTo("4");
    }

    @Test
    @DisplayName("QA-339 고치기 — 3주를 판 뒤 매수 수량을 2로 줄일 수 없음(400), 3으로 줄이면 보유 줄이 없어짐")
    void editTradeBuyBelowSoldQuantity() {
        boughtFourThenSold(3);
        assertThat(position(C).quantity()).isEqualByComparingTo("1");
        long buyId = tradeOf("BUY").id();

        rejects(() -> service.editTrade(buyId, new ManualAccountService.EditTradeRequest(d("2"), d("200000"), d("30"))), 400, "invalid-request");
        assertThat(position(C).quantity()).isEqualByComparingTo("1");
        assertThat(position(C).purchaseAmount()).isEqualByComparingTo("100000");

        service.editTrade(buyId, new ManualAccountService.EditTradeRequest(d("3"), d("300000"), d("45")));
        assertThat(store.position("isa", C)).as("3주 사고 3주 판 것이 됨").isEmpty();
    }

    @Test
    @DisplayName("QA-339 되돌리기 — 매수 뒤에 판 수량이 있으면 그 매수를 되돌릴 수 없음(400) — 보유 줄과 매도 내역이 그대로")
    void undoBuyAfterLaterSell() {
        boughtFourThenSold(1);
        long buyId = tradeOf("BUY").id();
        BigDecimal cashBefore = cash();

        rejects(() -> service.undoTrade(buyId), 400, "invalid-request");

        assertThat(position(C).quantity()).as("남은 3주의 줄이 지워지지 않음").isEqualByComparingTo("3");
        assertThat(position(C).purchaseAmount()).isEqualByComparingTo("300000");
        assertThat(cash()).isEqualByComparingTo(cashBefore);
        assertThat(store.recentTrades("isa", 10)).hasSize(2);

        service.undoTrade(tradeOf("SELL").id());
        service.undoTrade(buyId);
        assertThat(store.position("isa", C)).as("매도를 먼저 되돌리면 매수도 되돌려짐").isEmpty();
        assertThat(cash()).isEqualByComparingTo("775000");
    }

    // ------------------------------------------------------------------ QA-355: 수수료 상한
    @Test
    @DisplayName("QA-355 수수료 — max(체결 금액의 5%, 1,000원)을 넘으면 400(평균 단가를 수수료 칸에 적은 실수), 아주 작은 매매의 최소 수수료는 통과, 고치기도 같음")
    void feeCap() {
        startSynthetic();
        long buy = instruction(B, "BUY", 1);
        assertThatThrownBy(() -> apply(filled(buy, null, "1", "21000", "21000")))
                .isInstanceOfSatisfying(ManualAccountException.class, e -> {
                    assertThat(e.status()).isEqualTo(400);
                    assertThat(e.code()).isEqualTo("invalid-request");
                    assertThat(e.getMessage()).contains(B).contains("수수료");
                });
        rejects(() -> apply(filled(buy, null, "1", "21000", "1050.01")), 400, "invalid-request");
        assertThat(cash()).isEqualByComparingTo("775000");
        assertThat(store.instruction(buy).orElseThrow().status()).isEqualTo("PLANNED");

        apply(filled(buy, null, "1", "21000", "1000"));
        assertThat(cash()).as("5%(1,050) 아래는 통과").isEqualByComparingTo(d("775000").subtract(d("21000")).subtract(d("1000")));
        long tradeId = onlyTrade().id();
        rejects(() -> service.editTrade(tradeId, new ManualAccountService.EditTradeRequest(d("1"), d("21000"), d("21000"))), 400, "invalid-request");
        assertThat(onlyTrade().fee()).as("거절된 고치기는 수수료를 바꾸지 않음").isEqualByComparingTo("1000");

        // 500원짜리 매매의 최소 수수료 100원(20%)은 절대 하한 1,000원 아래라 통과
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000"), B, d("21000"), C, d("500")));
        long small = instruction(C, "BUY", 1);
        apply(filled(small, null, "1", "500", "100"));
        assertThat(position(C).quantity()).isEqualByComparingTo("1");
    }

    // ------------------------------------------------------------------ QA-356: 보유 없는 매도 지시를 수량과 함께 확인
    @Test
    @Disabled("QA-356: 수정 전 — 수량을 함께 보내면 보유 없는 매도 지시가 닫히지 않고 400")
    @DisplayName("QA-356 확인 매도 — 정수 보유가 0이면 수량을 함께 보내도 그 지시를 '보유 없음'으로 닫음(화면은 늘 수량을 보냄), 0 < 보유 < 수량일 때만 400")
    void applySellWithoutHoldingClosesEvenWithQuantity() {
        startSynthetic();
        long stop = stop(71, C, 2);
        when(paper.lastPrices(any())).thenReturn(Map.of(A, d("12000"), B, d("21000"), C, d("5000")));

        Map<String, Object> reply = apply(filled(null, stop, "2", "10000", "1"));

        assertThat(reply).containsEntry("count", 0).containsEntry("skipped", 1);
        assertThat(store.stopInstruction(stop).orElseThrow()).satisfies(row -> {
            assertThat(row.status()).isEqualTo("SKIPPED");
            assertThat(row.reason().path("autoNote").asString()).isEqualTo("no-holding");
        });
        assertThat(cash()).isEqualByComparingTo("775000");
        assertThat(store.recentTrades("isa", 10)).isEmpty();

        store.upsertPosition("isa", C, null, d("0.5"), d("2500"));
        long fractional = instruction(C, "SELL", 1);
        assertThat(apply(filled(fractional, null, "1", "5000", "1"))).as("정수 보유 0(0.5주)도 같음").containsEntry("skipped", 1);

        long more = instruction(A, "SELL", 11);
        rejects(() -> apply(filled(more, null, "11", "132000", "5")), 400, "invalid-request");
    }
}
