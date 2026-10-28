package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.Attempt;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.LedgerView;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.MarketChecks;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.Plan;
import com.macrodash.feature.paper.PacketBuilder.Packet;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 한국 Claude 계좌의 검증기 문맥(2단계 명세 §4-7·K34·사용자 결정 v2, E2a) — {@link KrClaudeValidation}의 칸과 결정 파이프라인
 * {@link ClaudeDecisionPipeline#plan}이 한국 실행에서 그 칸으로 판정하는지. 패킷 {@code 12_hardRules}는 합성 본문(실제 한국 패킷과의 대조는
 * {@code KrPacketBuilderTest.validatorChecksAreThePacketHardRules}), 관측치는 계약 1 저장본. 외부 호출 없음(Claude를 부르지 않음 — 받은 응답으로
 * 검증만).
 *
 * <p>날짜: 기준 세션 D = 2026-11-03(화), 지금 = D 22:35 KST(관측치 22:00 수집). 순자산 1억 원 — 비중 1% = 1,000,000원.
 */
class KrClaudeValidationTest {

    static final LocalDate D = LocalDate.of(2026, 11, 3);
    static final Instant NOW = kst("2026-11-03T22:35");
    static final double NAV = 100_000_000;

    private FakePaperStore store;
    private StoreReader reader;
    private MarketRun run;
    private ClaudeDecisionPipeline pipeline;

    static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        PaperMarketData marketData = new PaperMarketData(reader, mock(StoreRepository.class));
        KrFixtures.MovableClock clock = new KrFixtures.MovableClock(kst("2026-10-28T12:00"));
        KrRuleBookServiceTest.startedBooks(store, reader, marketData, clock);
        store.updateBookStatus(PaperBooks.KR_CLAUDE, PaperBooks.ACTIVE);
        store.updateBookStartedOn(PaperBooks.KR_CLAUDE, KrRuleBookServiceTest.S);
        clock.set(NOW);
        run = new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE);
        pipeline = new ClaudeDecisionPipeline(new ClaudeDecisionPipeline.MarketContext(KrPaperMarket.INSTANCE,
                (asOf, kind, initial, frameworkVersion, row) -> {
                    throw new UnsupportedOperationException("이 시험은 패킷을 만들지 않음");
                }, ClaudeBookService.KR_SCHEMA_RESOURCE), store, null, null, null, MAPPER, clock, 300).bind(run);
    }

    // ------------------------------------------------------------------ 재료
    /**
     * D 관측치 — 005930 49,950 · 207940 1,200,000 · 000660 180,000(D+1 봉도 있음 — 기준 가격은 D) · 051910 300,000 · 035720 40,000 · ETF 둘.
     * 035420은 항목 없음(봉 없음).
     */
    static Optional<Quotes> quotes() {
        KrFixtures.Payload payload = new KrFixtures.Payload(D);
        Instant fetched = kst("2026-11-03T21:58");
        stock(payload, "005930", 49_950, fetched);
        stock(payload, "207940", 1_200_000, fetched);
        stock(payload, "000660", 180_000, fetched).bar(D.plusDays(1), 181_000, 199_000, 9_000);
        stock(payload, "051910", 300_000, fetched);
        stock(payload, "035720", 40_000, fetched);
        payload.etf("069500", fetched).bar(D.minusDays(1), 94_000, 94_500, 30_000).bar(D, 94_600, 95_000, 31_000);
        payload.etf("153130", fetched).bar(D.minusDays(1), 107_990, 108_000, 5_000).bar(D, 108_000, 108_000, 5_100);
        return KrPaperMarket.INSTANCE.parse(payload.snapshot(kst("2026-11-03T22:00")));
    }

    private static KrFixtures.Entry stock(KrFixtures.Payload payload, String code, long close, Instant fetched) {
        return payload.code(code, fetched).bar(D.minusDays(1), close, close, 10_000).bar(D, close, close, 12_000);
    }

    /** 그 결정이 보낸 한국 패킷의 12_hardRules(합성) — 유니버스·ETF·재진입 금지·지금 체결할 수 없는 종목. */
    static Packet packet() {
        ObjectNode body = MAPPER.createObjectNode();
        ObjectNode hard = body.putObject(PacketBuilder.HARD_RULES);
        hard.put("universe", "000660,005930,035420,035720,051910,069500,153130,207940");
        hard.putArray("etfTickers").add("069500").add("153130");
        hard.putArray("lockedOut").add("000660");
        ObjectNode unfillable = hard.putObject("unfillableTickers");
        unfillable.put("035420", "이번 관측치에 그 종목 봉이 없음");
        unfillable.put("051910", D + " 거래정지(KRX 매매정지 또는 그날 거래량 0)");
        return new Packet(body, body.toString(), "시험", List.of(), null);
    }

    /** 운용 장부 — 051910 3%(거래정지 종목, 10주)·035720 2%(미처리 기업행위 보유, 50주), 둘 다 10-01에 산 보유. */
    private LedgerView view() {
        store.upsertPosition(position("051910", 10, 300_000));
        store.upsertPosition(position("035720", 50, 40_000));
        store.holdForCorpAction(PaperBooks.KR_CLAUDE, "035720", "가격제한폭 밖 변동 — 시험");
        List<Position> positions = List.of(position("035720", 50, 40_000), position("051910", 10, 300_000));
        return new LedgerView(95_000_000, NAV, 5.0, positions, Map.of("051910", 300_000.0, "035720", 40_000.0));
    }

    private static Position position(String code, int qty, double price) {
        return new Position(PaperBooks.KR_CLAUDE, code, qty, price, LocalDate.of(2026, 10, 1), kst("2026-10-01T22:00"),
                price, kst("2026-11-03T22:00"), price, kst("2026-11-03T22:00"), false, LocalDate.of(2026, 10, 1), price,
                null);
    }

    private static Attempt attempt(Packet packet, Object... orders) {
        ObjectNode parsed = MAPPER.createObjectNode();
        parsed.put("schemaVersion", 2).put("stance", "NEUTRAL").put("targetEquityExposurePct", 40)
                .put("exposureRationale", "시험").put("summary", "시험").putNull("noTradeReason").put("confidence", 0.5);
        ArrayNode list = parsed.putArray("orders");
        for (int i = 0; i < orders.length; i += 3) {
            ObjectNode o = list.addObject();
            o.put("ticker", (String) orders[i]).put("side", (String) orders[i + 1]).put("timing", PaperBooks.NEXT_OPEN)
                    .put("thesis", "시험").put("invalidation", "시험");
            o.putArray("labels").add("결정");
            Double value = (Double) orders[i + 2];
            if (OrderValidator.BUY.equals(orders[i + 1])) {
                o.put("targetWeightPct", value);
                o.putNull("sellFraction");
            } else {
                o.putNull("targetWeightPct");
                if (value == null) {
                    o.putNull("sellFraction");
                } else {
                    o.put("sellFraction", value);
                }
            }
        }
        FrameworkService.Frame frame = new FrameworkService.Frame(0, FrameworkService.STATUS_INTERIM, "임시",
                MAPPER.createObjectNode(), "", 0, null, null, null);
        return new Attempt(packet, frame, null, null, null, parsed, List.of(), "claude-test", "high");
    }

    private Plan plan(boolean initial, Attempt attempt, LedgerView view, Optional<Quotes> quotes) {
        SettingsRow row = run.settingsRow().orElseThrow();
        return pipeline.plan(D, initial ? RuleBookService.INITIAL : RuleBookService.SCHEDULED, initial, attempt, view,
                row, ClaudeBookService.ClaudeSettings.from(row.body()), quotes, Set.of(), Map.of());
    }

    private static List<String> reasons(Plan plan) {
        List<String> out = new ArrayList<>();
        plan.verdicts().forEach(v -> out.add(v.accepted() ? "OK" : v.rejectReason()));
        return out;
    }

    // ------------------------------------------------------------------ 시험
    @Test
    @DisplayName("결정 파이프라인(한국 실행) — 공통 검사 + 한국 칸: 1주 미만 매수 BUY_BELOW_ONE_SHARE, 체결할 수 없는 종목(패킷·지금 장부의 기업행위 보류)의 매수 UNFILLABLE·보유 매도는 받음, 재진입 금지·최소 500,000원·ETF 상한·패킷 유니버스")
    void planUsesKoreanChecks() {
        store.upsertLockout(new Lockout(PaperBooks.KR_CLAUDE, "000660", LocalDate.of(2026, 11, 20), "트레일링 스탑 −8%"));
        Plan plan = plan(false, attempt(packet(),
                "207940", "BUY", 0.6,
                "035420", "BUY", 3.0,
                "051910", "SELL", null,
                "035720", "BUY", 4.0,
                "000660", "BUY", 3.0,
                "005930", "BUY", 0.4,
                "069500", "BUY", 25.0,
                "153130", "BUY", 30.0,
                "005380", "BUY", 3.0), view(), quotes());

        assertThat(reasons(plan)).containsExactly(OrderValidator.BUY_BELOW_ONE_SHARE, OrderValidator.UNFILLABLE, "OK",
                OrderValidator.UNFILLABLE, OrderValidator.LOCKED_OUT, OrderValidator.MIN_NOTIONAL,
                OrderValidator.WEIGHT_CAP, "OK", OrderValidator.OUT_OF_UNIVERSE);
        assertThat(plan.verdicts().get(0).detail()).isEqualTo("매수 증가분 약 600,000원 < 1주 체결 금액 1,200,780원(기준 가격 "
                + "1,200,000원 + 수수료·슬리피지) — 정수 주라 1주도 살 수 없음(현재 0.00% → 목표 0.60%)");
        assertThat(plan.verdicts().get(1).detail()).isEqualTo("지금 체결할 수 없는 종목 — 이번 관측치에 그 종목 봉이 없음 · 매수만 거절(보유 매도는 받음)");
        assertThat(plan.verdicts().get(3).detail()).as("패킷 뒤 장부가 건 미처리 기업행위 보유도 — 규칙 계좌 Fillable과 같은 글")
                .isEqualTo("지금 체결할 수 없는 종목 — 미처리 기업행위 보유(가격제한폭 밖 변동 — 시험) — 장부가 그 종목 주문을 보류 · 매수만 거절(보유 매도는 받음)");
        assertThat(plan.verdicts().get(5).detail()).isEqualTo("매수 증가분 약 400,000원 < 최소 500,000원(현재 0.00% → 목표 0.40%)");
        assertThat(plan.verdicts().get(6).detail()).isEqualTo("목표 25.00% > ETF 상한 20.00%");
        assertThat(plan.planned().get(7).orderWeightPct()).as("153130은 현금성 — 상한 없음, 증가분 30%p").isEqualTo(30.0);
        assertThat(plan.planned().get(2).sellFraction()).as("거래정지 보유의 전량 매도는 받아 대기(장부가 풀리면 체결)").isNull();
        assertThat(plan.response().path("inputsStale").asBoolean()).isFalse();
        assertThat(plan.response().path("settings").path("minOrderNotional").asDouble()).isEqualTo(500_000);
        assertThat(plan.response().path("settings").path("cashLikeTickers").get(0).asString()).isEqualTo("153130");
        assertThat(plan.response().path("book").asString()).isEqualTo(PaperBooks.KR_CLAUDE);

        Plan enough = plan(false, attempt(packet(), "207940", "BUY", 1.3), view(), quotes());
        assertThat(reasons(enough)).as("1,300,000원 ≥ 1주 1,200,780원").containsExactly("OK");
        assertThat(enough.planned().get(0).orderWeightPct()).isEqualTo(1.3);
    }

    @Test
    @DisplayName("한국 칸 — 패킷 12_hardRules의 유니버스·ETF·재진입 금지(+ 지금 장부)·체결할 수 없는 종목(+ 지금 장부의 기업행위 보류), 기준 가격은 관측치의 기준 거래일 종가, 요율은 kr.*, 가격 없음 집합은 비움")
    void checksReadThePacketAndTheLedger() {
        view();
        MarketChecks checks = KrClaudeValidation.checks(run, store, D, false, packet().body(), run.settings(), quotes(),
                Set.of("005930"), NOW);

        assertThat(checks.universe()).containsExactly("000660", "005930", "035420", "035720", "051910", "069500",
                "153130", "207940");
        assertThat(checks.etfs()).containsExactly("069500", "153130");
        assertThat(checks.lockedOut()).containsExactly("000660", "005930");
        assertThat(checks.unfillable()).containsOnlyKeys("035420", "035720", "051910");
        assertThat(checks.noPrice()).isEmpty();
        assertThat(checks.stale()).isFalse();
        assertThat(checks.wholeShares().prices()).containsEntry("000660", BigDecimal.valueOf(180_000))
                .containsEntry("207940", BigDecimal.valueOf(1_200_000)).containsEntry("153130", BigDecimal.valueOf(108_000))
                .doesNotContainKey("035420");
        assertThat(checks.wholeShares().rates().commissionBp()).isEqualByComparingTo("1.5");
        assertThat(checks.wholeShares().rates().slippageBp()).isEqualByComparingTo("5");

        assertThat(KrClaudeValidation.checks(run, store, D, false, packet().body(), run.settings(), Optional.empty(),
                Set.of(), NOW).stale()).as("관측치 없음 → 전부 STALE_INPUT").isTrue();
        assertThat(KrClaudeValidation.checks(run, store, D, false, packet().body(), run.settings(), quotes(), Set.of(),
                kst("2026-11-04T22:01")).stale()).as("24시간 넘은 관측치").isTrue();
        assertThatThrownBy(() -> KrClaudeValidation.checks(run, store, D, false, MAPPER.createObjectNode(),
                run.settings(), quotes(), Set.of(), NOW)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("12_hardRules.universe");
    }

    @Test
    @DisplayName("이달 재량 주문 수 — 출발 결정(INITIAL)의 체결 주문은 빼고 정기 결정 주문만(패킷 9_portfolio와 같은 함수), 출발 결정 자신은 0부터")
    void monthlyCountLeavesOutTheStartDecision() {
        long initialId = decision(RuleBookService.INITIAL, LocalDate.of(2026, 11, 2));
        long scheduledId = decision(RuleBookService.SCHEDULED, LocalDate.of(2026, 11, 2));
        filled(initialId, "005930");
        filled(initialId, "000660");
        filled(scheduledId, "207940");

        assertThat(KrClaudeValidation.checks(run, store, D, false, packet().body(), run.settings(), quotes(), Set.of(),
                NOW).monthly()).isEqualTo(1).isEqualTo(KrPacketBuilder.monthlyDiscretionaryOrders(store, D));
        assertThat(KrClaudeValidation.checks(run, store, D, true, packet().body(), run.settings(), quotes(), Set.of(),
                NOW).monthly()).isZero();
        Plan plan = plan(false, attempt(packet(), "005930", "BUY", 3.0), view(), quotes());
        assertThat(plan.response().path("monthlyDiscretionaryOrders").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("사용자 결정 v2 '같은 조건' — 지금 체결할 수 없는 보유(051910 거래정지)의 매도는 받아 대기로 두되 같은 시가 매수의 현금(OVER_ALLOCATED)·종목 자리(MAX_POSITIONS)를 만들지 않음(규칙 계좌가 그 매도 대금을 현금 어림에서 빼는 것과 같음)")
    void unfillableSellFreesNoRoomForTheSameOpenBuys() {
        // 051910 9%(30주 × 300,000 — 거래정지) + 153130 90.936%(842주 × 108,000) + 현금 64,000 = 순자산 1억.
        LedgerView full = ledger(64_000, position("051910", 30, 300_000), position("153130", 842, 108_000));
        Plan cash = plan(false, attempt(packet(), "051910", "SELL", null, "005930", "BUY", 9.0), full, quotes());

        assertThat(reasons(cash)).containsExactly("OK", OrderValidator.OVER_ALLOCATED);
        assertThat(cash.verdicts().get(0).detail()).isEqualTo("보유 9.00% 전량 매도 — 지금 체결할 수 없어 대기(풀리면 그 뒤 체결)"
                + " · 이번 매수의 현금·종목 자리를 만들지 않음");
        assertThat(cash.verdicts().get(1).detail()).isEqualTo("매도 뒤 남는 보유 99.94% + 앞서 받은 매수 0.00%p + 이 주문 9.00%p = "
                + "108.94% > 100% (현재 현금 0.06%) · 지금 체결할 수 없는 매도 9.00%p는 자리를 만들지 못함");
        Plan alone = plan(false, attempt(packet(), "005930", "BUY", 9.0), full, quotes());
        assertThat(reasons(alone)).as("그 매도가 없을 때와 같은 판정").containsExactly(OrderValidator.OVER_ALLOCATED);

        // 051910 + 다른 보유 19종목 = 20종목(상한) — 거래정지 종목의 전량 매도는 신규 매수의 자리를 비우지 못함.
        List<Position> twenty = new ArrayList<>();
        twenty.add(position("051910", 30, 300_000));
        for (int i = 1; i <= 19; i++) {
            twenty.add(position(String.format("9%05d", i), 10, 100_000));
        }
        LedgerView crowded = ledger(100_000_000 - 9_000_000 - 19 * 1_000_000, twenty.toArray(Position[]::new));
        Plan slots = plan(false, attempt(packet(), "051910", "SELL", null, "005930", "BUY", 3.0), crowded, quotes());
        assertThat(reasons(slots)).containsExactly("OK", OrderValidator.MAX_POSITIONS);
        assertThat(slots.verdicts().get(1).detail()).isEqualTo("매수 뒤 종목 수 21 > 상한 20(현금성 제외)"
                + " · 지금 체결할 수 없는 전량 매도 1종목은 자리를 비우지 못함");

        // 체결할 수 있는 보유(207940)의 매도는 그대로 같은 시가 매수의 자리를 만듦.
        LedgerView fillable = ledger(64_000, position("207940", 7, 1_200_000), position("153130", 842, 108_000),
                position("000660", 3, 200_000));
        Plan freed = plan(false, attempt(packet(), "207940", "SELL", null, "005930", "BUY", 8.4), fillable, quotes());
        assertThat(reasons(freed)).containsExactly("OK", "OK");
        assertThat(freed.verdicts().get(0).detail()).isEqualTo("보유 8.40% 전량 매도");
    }

    /** 운용 장부(Claude 계좌) — 보유를 저장소에도 넣고(보유 거래일·기업행위 판정이 읽음) 순자산·비중을 장부와 같은 계산으로. */
    private LedgerView ledger(double cash, Position... positions) {
        Map<String, Double> price = new java.util.HashMap<>();
        Map<String, Integer> qty = new java.util.HashMap<>();
        for (Position p : positions) {
            store.upsertPosition(p);
            price.put(p.ticker(), p.lastPrice());
            qty.put(p.ticker(), p.qty());
        }
        com.macrodash.analytics.PaperLedger.Valuation valuation = com.macrodash.analytics.PaperLedger.value(cash, qty,
                price);
        return new LedgerView(cash, valuation.nav(), valuation.exposurePct(), List.of(positions), price);
    }

    @Test
    @DisplayName("관측치가 없으면 한국 결정도 전부 STALE_INPUT(매도 포함)")
    void missingQuotesRejectEverything() {
        Plan plan = plan(false, attempt(packet(), "005930", "BUY", 3.0, "051910", "SELL", null), view(), Optional.empty());
        assertThat(reasons(plan)).containsExactly(OrderValidator.STALE_INPUT, OrderValidator.STALE_INPUT);
    }

    private long decision(String kind, LocalDate asOf) {
        return store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_CLAUDE, asOf, kind, null, "OK", "claude-test", 1,
                store.settings.version(), null, 50.0, null, null, null, MAPPER.createObjectNode(), null, null, null, false,
                null, 0)).orElseThrow();
    }

    private void filled(long decisionId, String code) {
        long id = store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE, decisionId, code, PaperBooks.BUY, null, 3.0, null,
                PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null,
                MAPPER.createObjectNode(), LocalDate.of(2026, 11, 2), kst("2026-11-02T22:40"), LocalDate.of(2026, 11, 5),
                null));
        store.markOrderFilled(id, kst("2026-11-03T22:00"));
    }
}
