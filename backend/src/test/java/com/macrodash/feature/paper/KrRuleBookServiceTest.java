package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.groups.Tuple.tuple;
import static org.mockito.Mockito.mock;

/**
 * 한국 규칙 계좌 결정(2단계 명세 §4-6·K7·K10·K26·K33, D1b) — 손계산 고정본({@link KrRulesFixtures#standard})으로 재선정일에만 매수·매도 신호(보유
 * 전량)·남는 현금 153130·'자료 없음' 사유·입력 동결(결정 시각 뒤 값 없음)·재진입 금지·그 실행의 설정 판(kr.*)·기한 지남 행과 따라잡기를 봅니다.
 * 외부 호출 없음 — 가짜 저장소와 가짜 저장본 읽기.
 *
 * <p>날짜: 출발 S = 2026-10-29(목, INITIAL이 10월 주기 r = 10-01을 덮음), 11월 주기 r = 11-02(월 — 그 달 첫 KR 거래일, MONTHLY_FIRST),
 * 따라잡기 r′ = 11-03(화).
 */
class KrRuleBookServiceTest {

    static final LocalDate S = LocalDate.of(2026, 10, 29);
    static final LocalDate FRI = LocalDate.of(2026, 10, 30);
    static final LocalDate R = LocalDate.of(2026, 11, 2);
    static final LocalDate R1 = LocalDate.of(2026, 11, 3);
    static final LocalDate R2 = LocalDate.of(2026, 11, 4);
    static final double NAV = 100_000_000;

    private FakePaperStore store;
    private StoreReader reader;
    private StoreRepository repository;
    private PaperMarketData marketData;
    private KrFixtures.MovableClock clock;
    private KrRulesFixtures data;
    private KrRuleBookService service;

    static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    static PaperConfig config() {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, S, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    /** 한국 초기화 → 규칙·벤치마크 셋 운용(출발 S), 규칙 계좌의 출발 결정 INITIAL(S, OK — 주문은 이 시험 밖), Claude는 시작 전(E2 전과 같음). */
    static void startedBooks(FakePaperStore store, StoreReader reader, PaperMarketData marketData, java.time.Clock clock) {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        new PaperAdminService(store, marketData, reader, PaperFixtures.settings(store), ledger, config(),
                PaperFixtures.MAPPER, clock).initKr();
        for (String code : List.of(PaperBooks.KR_RULES, PaperBooks.KR_BENCH_K200, PaperBooks.KR_BENCH_MIX)) {
            store.updateBookStatus(code, PaperBooks.ACTIVE);
            store.updateBookStartedOn(code, S);
        }
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_RULES, S, RuleBookService.INITIAL, null, "OK", null,
                null, store.settings.version(), S, 20.0, null, null, null, PaperFixtures.MAPPER.createObjectNode(), null,
                null, null, false, null, 0));
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        repository = mock(StoreRepository.class);
        marketData = new PaperMarketData(reader, repository);
        clock = new KrFixtures.MovableClock(kst("2026-10-28T12:00"));
        startedBooks(store, reader, marketData, clock);
        data = KrRulesFixtures.standard(LocalDate.of(2026, 10, 28), S, FRI, R, R1, R2);
        data.install(repository, reader);
        service = new KrRuleBookService(store, reader, marketData,
                new PaperLedgerService(store, marketData, PaperFixtures.MAPPER), PaperFixtures.MAPPER, clock);
    }

    private MarketRun run() {
        return new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE);
    }

    private Decision decideAt(LocalDate session, String kstTime) {
        clock.set(kst(session + "T" + kstTime));
        store.dbNow = clock.instant();
        MarketRun run = run();
        Optional<PaperMarketData.Quotes> quotes = KrPaperMarket.INSTANCE.parse(KrRulesFixtures.quotes(session));
        return service.decide(run, session, false, quotes);
    }

    /** 그 세션 22:30에 주어진 관측치 저장본으로 정기 결정. */
    private Decision decideWith(LocalDate session, com.macrodash.store.Snapshot snapshot) {
        clock.set(kst(session + "T22:30"));
        store.dbNow = clock.instant();
        return service.decide(run(), session, false, KrPaperMarket.INSTANCE.parse(snapshot));
    }

    private List<Order> ordersOf(Decision decision) {
        return store.ordersByDecision(decision.id());
    }

    /** 매수 주문의 다음 시가 유출 어림(원) — 목표 비중 × 순자산 1억 × (1 + 매수 비용 6.5bp), 결정 때 가격 그대로. */
    private static java.math.BigDecimal buyOutflow(List<Order> orders) {
        java.math.BigDecimal out = java.math.BigDecimal.ZERO;
        for (Order order : orders) {
            if (PaperBooks.BUY.equals(order.side())) {
                out = out.add(java.math.BigDecimal.valueOf(order.targetWeightPct()).multiply(java.math.BigDecimal.valueOf(NAV))
                        .divide(java.math.BigDecimal.valueOf(100)).multiply(new java.math.BigDecimal("1.00065")));
            }
        }
        return out;
    }

    private static JsonNode member(Decision decision, String code) {
        for (JsonNode member : decision.response().path("input").path("members")) {
            if (code.equals(member.path("code").asString())) {
                return member;
            }
        }
        throw new AssertionError("동결본에 " + code + "가 없습니다");
    }

    private static List<String> subReasons(JsonNode member) {
        List<String> out = new ArrayList<>();
        member.path("reasons").forEach(r -> out.add(r.path("reason").asString() + "/" + r.path("sub").asString()));
        return out;
    }

    // ------------------------------------------------------------------ 재선정일에만 매수
    @Test
    @DisplayName("재선정일(11-02) — REBALANCE OK: 후보 000660·005930·105560 동일비중 6.6667%씩 NEXT_OPEN 매수, 남는 현금 79.4869%를 153130에(손계산)")
    void reselectionDayBuysHandComputed() {
        Decision decision = decideAt(R, "22:30");

        assertThat(decision.kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(decision.status()).isEqualTo("OK");
        assertThat(decision.selectionAsOf()).isEqualTo(R);
        assertThat(decision.targetExposurePct()).as("주식 노출 = 3 × 100/15").isEqualTo(20.0);
        assertThat(decision.pricesFinal()).isFalse();
        JsonNode response = decision.response();
        assertThat(response.path("cycleDate").asString()).isEqualTo("2026-11-02");
        assertThat(response.path("selectionAsOf").asString()).isEqualTo("2026-11-02");
        assertThat(response.path("catchUp").asBoolean()).isFalse();
        assertThat(response.path("selection").path("candidates")).extracting(n -> n.path("code").asString())
                .containsExactly("000660", "005930", "105560");
        assertThat(response.path("selection").path("candidates")).extracting(n -> n.path("score").asDouble())
                .containsExactly(0.2, 0.1, 0.05);
        assertThat(response.path("selection").path("stockWeightPct").asDouble()).isEqualTo(20.0);
        assertThat(response.path("selection").path("parkingWeightPct").asDouble()).isEqualTo(80.0);

        // 153130: 현금 1억 − 세 종목 6,666,700원 × (1 + 6.5bp) = 79,986,899.935원 → 79.986899935% − 여유 0.5%p = 79.4869%.
        assertThat(ordersOf(decision)).extracting(Order::ticker, Order::side, Order::targetWeightPct, Order::sellFraction)
                .containsExactly(tuple("000660", "BUY", 6.6667, null), tuple("005930", "BUY", 6.6667, null),
                        tuple("105560", "BUY", 6.6667, null), tuple("153130", "BUY", 79.4869, null));
        assertThat(ordersOf(decision)).allSatisfy(o -> {
            assertThat(o.timing()).isEqualTo("NEXT_OPEN");
            assertThat(o.source()).isEqualTo("RULE");
            assertThat(o.status()).isEqualTo("PENDING");
            assertThat(o.asOfTradingDate()).isEqualTo(R);
            assertThat(o.expiresOn()).as("R + 3 KR 거래일").isEqualTo(LocalDate.of(2026, 11, 5));
            assertThat(o.qty()).as("수량은 시가 체결 때").isNull();
        });
        assertThat(ordersOf(decision).get(3).reason().path("rule").asString()).isEqualTo(KrRuleBookService.RULE_PARK_SELECTION);

        // 같은 세션에 다시 불러도 한 건(이미 있는 결정을 돌려줌).
        assertThat(decideAt(R, "22:40").id()).isEqualTo(decision.id());
        assertThat(store.decisionsOf(PaperBooks.KR_RULES)).hasSize(2);
    }

    @Test
    @DisplayName("재선정일이 아닌 날(10-30 — 출발 INITIAL이 10월 주기를 덮음) — SCHEDULED: 후보 셋이 있어도 종목은 사지 않고 남는 현금 관리(park_cash)만")
    void scheduledDayDoesNotBuyStocks() {
        Decision decision = decideAt(FRI, "22:30");

        assertThat(decision.kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(decision.selectionAsOf()).isNull();
        assertThat(decision.response().path("cycleDate").isNull()).isTrue();
        assertThat(decision.response().path("selection").path("candidates")).hasSize(3);
        assertThat(decision.response().path("selection").path("targets").isNull()).isTrue();
        assertThat(ordersOf(decision)).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .as("현금 100% > 기준 2% → 여유 0.5%p를 남기고 153130").containsExactly(tuple("153130", "BUY", 99.5));
        assertThat(ordersOf(decision).get(0).reason().path("rule").asString()).isEqualTo(KrRuleBookService.RULE_PARK_DAILY);
        assertThat(decision.response().path("notes").toString()).contains("후보 3개는 재선정일이 아니라 사지 않습니다");
    }

    @Test
    @DisplayName("그 주기 매수 결정이 생긴 뒤에는 다시 선정하지 않음 — 11-02 REBALANCE OK 뒤 11-03은 SCHEDULED(매수 없음)")
    void selectsOncePerCycle() {
        decideAt(R, "22:30");
        Decision next = decideAt(R1, "22:30");

        assertThat(next.kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(ordersOf(next)).noneMatch(o -> "BUY".equals(o.side()) && !"153130".equals(o.ticker()));
    }

    @Test
    @DisplayName("이미 목표 비중이면 재선정일 결정은 주문 0건이어도 REBALANCE OK(그 주기 매수 결정) — 다음 KR 거래일은 SCHEDULED(따라잡기로 다시 선정하지 않음)")
    void selectionWithoutOrdersIsStillTheCycleBuy() {
        // 후보 셋 각 667주 × 10,000 = 6.67%(목표 6.6667% 이상) · 153130 795주 × 100,000 = 79.5% · 현금 490,000 = 0.49%(여유 0.5%p 이하).
        holding("000660", 667, 10_000);
        holding("005930", 667, 10_000);
        holding("105560", 667, 10_000);
        holding("153130", 795, 100_000);
        store.upsertState(new BookState(PaperBooks.KR_RULES, 490_000, NAV, 99_510_000, 99.51, null, null, S, null));

        Decision rebalance = decideAt(R, "22:30");

        assertThat(rebalance.kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(rebalance.status()).as("선정한 결정은 주문이 없어도 OK — 따라잡기가 세는 매수 결정").isEqualTo("OK");
        assertThat(ordersOf(rebalance)).isEmpty();
        assertThat(rebalance.response().path("skipped")).extracting(row -> row.path("ticker").asString())
                .containsExactly("000660", "005930", "105560");
        assertThat(rebalance.response().path("selection").path("targets")).hasSize(3);

        Decision next = decideAt(R1, "22:30");
        assertThat(next.kind()).as("그 주기 매수 결정이 있음 — 다시 선정하지 않음").isEqualTo(RuleBookService.SCHEDULED);
        assertThat(next.response().path("catchUp").asBoolean()).isFalse();
        assertThat(ordersOf(next)).isEmpty();
    }

    // ------------------------------------------------------------------ 자료 없음 사유
    @Test
    @DisplayName("'자료 없음' 사유가 결정 행에 — DART 없음·접수일이 기준일 뒤·접수일 모름, 자료 부족(19/20일)·수급 미달, 금융업 코드 표(KB금융)는 부채비율로 빠지지 않음")
    void missingDataReasonsAreRecorded() {
        Decision decision = decideAt(R, "22:30");

        assertThat(subReasons(member(decision, "207940"))).containsExactly("자료 없음/DART 없음");
        assertThat(member(decision, "207940").path("dart").isNull()).isTrue();
        assertThat(member(decision, "207940").path("score").asDouble()).as("후보가 아니어도 창이 차면 점수")
                .isCloseTo(40_000.0 / 71_174_000 * 100, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(subReasons(member(decision, "005380"))).containsExactly("자료 없음/접수일이 기준일 뒤");
        assertThat(member(decision, "005380").path("dart").path("rceptNo").asString()).isEqualTo("20261104000001");
        assertThat(member(decision, "005380").path("dart").path("receiptDate").asString()).isEqualTo("2026-11-04");
        assertThat(subReasons(member(decision, "068270"))).containsExactly("자료 없음/접수일 모름");
        assertThat(member(decision, "068270").path("dart").path("receiptDate").isNull()).isTrue();
        assertThat(subReasons(member(decision, "000270"))).containsExactly("자료 부족/자료 부족");
        assertThat(member(decision, "000270").path("reasons").get(0).path("detail").asString()).contains("20거래일 중 19일");
        assertThat(member(decision, "000270").path("flows").path("foreign20").isNull()).as("없는 숫자를 만들지 않음").isTrue();
        assertThat(subReasons(member(decision, "373220"))).containsExactly("수급 미달/수급 미달");
        JsonNode kb = member(decision, "105560");
        assertThat(kb.path("candidate").asBoolean()).isTrue();
        assertThat(kb.path("dart").path("financialSector").asBoolean()).isTrue();
        assertThat(kb.path("dart").path("hasCurrentAssetsAccount").asBoolean()).isFalse();
        assertThat(member(decision, "005930").path("dart").path("financialSector").asBoolean()).isFalse();
        assertThat(member(decision, "005930").path("dart").path("hasCurrentAssetsAccount").asBoolean()).isTrue();
        assertThat(decision.response().path("input").path("financialSectorTable").asString())
                .isEqualTo(com.macrodash.analytics.KrFinancialSector.VERSION);
        assertThat(kb.path("dart").path("debtRatioPct").asDouble()).as("2,000%여도 금융업은 통과").isEqualTo(2_000.0);
        assertThat(kb.path("dart").path("bsnsYear").asString()).isEqualTo("2025");
        assertThat(kb.path("dart").path("rceptNo").asString()).isEqualTo("20260619000333");
        assertThat(decision.response().path("selection").path("exclusionCounts").toString())
                .isEqualTo("{\"자료 부족\":1,\"수급 미달\":1,\"자료 없음\":3}");
    }

    @Test
    @DisplayName("저장본의 순매수 칸이 비었거나(null — 토스 buy·sell 없음) 정수가 아니면(1.5) 그날은 기록 없음 — 0으로 세지 않아 창이 덜 참('자료 부족', 20거래일 중 18일), 합·점수 null")
    void flowNetThatIsNotAWholeNumberIsMissing() {
        data.flow("005930", LocalDate.of(2026, 10, 29), 100_000L, null, "2026-10-29T20:21:26.000+09:00",
                kst("2026-10-29T21:18"));
        ((ObjectNode) data.flows.get("005930").get(LocalDate.of(2026, 10, 27)).path("investors").path("foreigner"))
                .put("net", 1.5);

        Decision decision = decideAt(R, "22:30");

        JsonNode samsung = member(decision, "005930");
        assertThat(subReasons(samsung)).containsExactly("자료 부족/자료 부족");
        assertThat(samsung.path("reasons").get(0).path("detail").asString()).contains("20거래일 중 18일");
        assertThat(samsung.path("flows").path("days").asInt()).isEqualTo(18);
        assertThat(samsung.path("flows").path("foreign20").isNull()).as("없는 숫자를 만들지 않음").isTrue();
        assertThat(samsung.path("flows").path("institution20").isNull()).isTrue();
        assertThat(samsung.path("score").isNull()).isTrue();
        assertThat(decision.response().path("selection").path("candidates")).extracting(n -> n.path("code").asString())
                .containsExactly("000660", "105560");
    }

    // ------------------------------------------------------------------ 입력 동결(K26)·룩어헤드 없음
    @Test
    @DisplayName("입력 동결 — U 기준일 B < D·순위·상장주식수, 종목마다 20일·5일 합·연속일·D 기록의 판(updatedAt)·받은 시각, 읽은 순간, DART 저장본 시각")
    void freezesInputs() {
        Decision decision = decideAt(R, "22:30");
        JsonNode input = decision.response().path("input");

        assertThat(input.path("session").asString()).isEqualTo("2026-11-02");
        assertThat(input.path("readAtKst").asString()).isEqualTo("2026-11-02 22:30 KST");
        assertThat(input.path("universe").path("baseDate").asString()).as("D 앞 가장 최근 기준일").isEqualTo("2026-10-30");
        assertThat(input.path("universe").path("rule").asString()).isEqualTo("kospi-mcap-top100-common/v3");
        assertThat(input.path("universe").path("size").asInt()).isEqualTo(8);
        assertThat(input.path("flowsWindow").path("to").asString()).isEqualTo("2026-11-02");
        assertThat(input.path("flowsWindow").path("tradingDays").asInt()).isEqualTo(20);
        assertThat(input.path("dart").path("collectedAtKst").asString()).isEqualTo("2026-10-20 22:00 KST");
        JsonNode samsung = member(decision, "005930");
        assertThat(samsung.path("rank").asInt()).isEqualTo(1);
        assertThat(samsung.path("listedShares").asLong()).isEqualTo(3_000_000_000L);
        assertThat(samsung.path("flows").path("foreign20").asLong()).isEqualTo(2_000_000);
        assertThat(samsung.path("flows").path("institution20").asLong()).isEqualTo(1_000_000);
        assertThat(samsung.path("flows").path("foreign5").asLong()).isEqualTo(500_000);
        assertThat(samsung.path("flows").path("streak").asInt()).isEqualTo(20);
        assertThat(samsung.path("flows").path("sessionUpdatedAt").asString()).isEqualTo("2026-11-02T20:21:26.000+09:00");
        assertThat(samsung.path("flows").path("sessionFetchedAt").asString()).isEqualTo("2026-11-02T12:18:00Z");
        assertThat(samsung.path("flows").path("sessionDetail").asBoolean()).isTrue();
        assertThat(samsung.path("dart").path("bsnsYear").asString()).isEqualTo("2025");
        assertThat(samsung.path("dart").path("rceptNo").asString()).isEqualTo("20260310002820");
        assertThat(decision.response().path("settings").path("settingsVersion").asInt()).isEqualTo(store.settings.version());
    }

    @Test
    @DisplayName("결정 시각 뒤 값은 쓰지 않음 — D 당일 기준일 U·D 뒤 날짜 기록·결정 뒤에 받은 기록·받은 시각 모르는 기록은 빼고 그 수를 남김(초기 패킷 initialPacketHasNothingAfterAsOf의 한국판)")
    void nothingAfterTheDecisionInstant() {
        // D(11-03) 당일 기준일 U에 낯선 종목(쓰면 안 됨), 005930의 D 기록은 23:10에 다시 받은 판(독 값), 000660의 10-30 기록은 받은 시각 없음.
        data.member(R1, 1, "999999", "미래종목", 1_000_000_000L);
        data.flow("005930", R1, 9_999_999L, 9_999_999L, "2026-11-04T06:50:04.000+09:00", kst("2026-11-03T23:10"));
        ((ObjectNode) data.flows.get("000660").get(FRI)).remove("fetchedAt");

        Decision decision = decideAt(R1, "22:30");
        JsonNode input = decision.response().path("input");

        assertThat(input.path("universe").path("baseDate").asString()).as("B < D").isEqualTo("2026-11-02");
        assertThat(input.path("members")).extracting(m -> m.path("code").asString()).doesNotContain("999999");
        assertThat(input.path("excludedFlowRecords").toString())
                .as("D 뒤 날짜 8종목 × 11-04·11-05 = 16, 결정 뒤 받음 1, 받은 시각 모름 1")
                .isEqualTo("{\"afterSession\":16,\"fetchedAfterRead\":1,\"unknownFetchedAt\":1}");
        assertThat(decision.response().toString()).doesNotContain("9999999").doesNotContain("9,999,999")
                .doesNotContain("미래종목");
        Instant readAt = kst("2026-11-03T22:30");
        for (JsonNode member : input.path("members")) {
            JsonNode flows = member.path("flows");
            assertThat(flows.toString()).as(member.path("code").asString()).doesNotContain("2026-11-04")
                    .doesNotContain("2026-11-05");
            if (flows.path("sessionFetchedAt").isString()) {
                assertThat(Instant.parse(flows.path("sessionFetchedAt").asString())).isBeforeOrEqualTo(readAt);
            }
            JsonNode dart = member.path("dart");
            if (member.path("candidate").asBoolean()) {
                assertThat(LocalDate.parse(dart.path("receiptDate").asString())).isBeforeOrEqualTo(R1);
            }
        }
        assertThat(subReasons(member(decision, "005930"))).as("D 기록이 결정 뒤 판뿐 — 자료 부족").containsExactly("자료 부족/자료 부족");
        assertThat(member(decision, "005930").path("flows").path("sessionUpdatedAt").isNull()).isTrue();
        assertThat(subReasons(member(decision, "000660"))).containsExactly("자료 부족/자료 부족");
        assertThat(decision.response().path("selection").path("candidates")).extracting(n -> n.path("code").asString())
                .containsExactly("105560");
    }

    // ------------------------------------------------------------------ 보유·매도·재진입 금지
    @Test
    @DisplayName("매도는 보유 전량(sellFraction null) — 매일 20일 둘 다 순매도, 재선정일엔 후보 밖도; 후보인 보유는 모자란 만큼만 더 삼, 모자란 현금은 153130 일부 매도(손계산)")
    void sellSignalsAndTopUps() {
        holding("373220", 100, 10_000);    // 수급 미달(둘 다 순매도)
        holding("207940", 100, 10_000);    // DART 없음 — 후보 밖
        holding("000660", 100, 10_000);    // 후보
        holding("153130", 965, 100_000);   // 남는 현금 자리(신호 아님)
        store.upsertState(new BookState(PaperBooks.KR_RULES, 500_000, NAV, 99_500_000, 99.5, null, null, S, null));

        Decision daily = decideAt(FRI, "22:30");
        // 매일: 둘 다 순매도만 — 매도 대금을 더해도 남는 현금 1.497% < 기준 2%라 153130을 사지 않음.
        assertThat(ordersOf(daily)).extracting(Order::ticker, Order::side, Order::sellFraction)
                .containsExactly(tuple("373220", "SELL", null));
        assertThat(ordersOf(daily).get(0).reason().path("reasons").toString()).isEqualTo("[\"FLOWS_BOTH_NEGATIVE\"]");
        assertThat(daily.response().path("holdings")).extracting(h -> h.path("code").asString() + " " + h.path("sell").asBoolean())
                .containsExactly("000660 false", "207940 false", "373220 true");

        store.markOrderStatus(ordersOf(daily).get(0).id(), PaperBooks.ORDER_CANCELLED, "시험 — 다음 날 계획을 따로 보려고");
        Decision rebalance = decideAt(R, "22:30");
        // 현금 500,000 + 매도 2 × 1,000,000 × (1 − 26.5bp) − 매수(5.6667% + 6.6667% × 2) × 1억 × (1 + 6.5bp) = −16,517,750.065원
        // → 153130 매도 필요 = (0.5 + 16.517750065)% × 1억 = 17,017,750.065원 ÷ (96,500,000 × (1 − 6.5bp)) = 0.176464.
        assertThat(ordersOf(rebalance)).extracting(Order::ticker, Order::side, Order::targetWeightPct, Order::sellFraction)
                .containsExactly(tuple("207940", "SELL", null, null), tuple("373220", "SELL", null, null),
                        tuple("000660", "BUY", 5.6667, null), tuple("005930", "BUY", 6.6667, null),
                        tuple("105560", "BUY", 6.6667, null), tuple("153130", "SELL", null, 0.176464));
        assertThat(ordersOf(rebalance).get(0).reason().path("reasons").toString()).isEqualTo("[\"OUT_OF_CANDIDATES\"]");
        assertThat(ordersOf(rebalance).get(1).reason().path("reasons").toString())
                .isEqualTo("[\"FLOWS_BOTH_NEGATIVE\",\"OUT_OF_CANDIDATES\"]");
        assertThat(ordersOf(rebalance).get(2).reason().path("currentWeightPct").asDouble()).isEqualTo(1.0);
        assertThat(ordersOf(rebalance).get(5).reason().path("rule").asString()).isEqualTo(KrRuleBookService.RULE_PARK_SELECTION);
    }

    @Test
    @DisplayName("모자란 현금의 153130 일부 매도는 153130이 그날 거래정지여도 냄(사용자 결정 u2) — 같은 손계산 비율 0.176464. 선정한 날이라 그 대금은 다음 시가 현금에서 빼고(u3) 종목 매수를 낮은 순위부터 줄임: 105560·005930 뺌, 000660 5.6667% → 1.9934%(손계산)")
    void parkingSellIsPlacedEvenWhenUnfillable() {
        holding("373220", 100, 10_000);
        holding("207940", 100, 10_000);
        holding("000660", 100, 10_000);
        holding("153130", 965, 100_000);
        store.upsertState(new BookState(PaperBooks.KR_RULES, 500_000, NAV, 99_500_000, 99.5, null, null, S, null));
        com.macrodash.store.Snapshot snapshot = KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "153130", true);
        clock.set(kst("2026-11-02T22:30"));
        store.dbNow = clock.instant();

        Decision rebalance = service.decide(run(), R, false, KrPaperMarket.INSTANCE.parse(snapshot));

        // 어림 = 현금 500,000 + 매도 둘 1,994,700 − 매수 19,012,450.065 = −16,517,750.065원 → 메울 현금 17,017,750.065원(여유 0.5%p 포함).
        // 153130은 지금 체결할 수 없어 그 대금을 셈하지 않으므로(u3) 종목 매수를 뒤에서부터: 105560·005930(6,671,033.355원씩)을 빼고 남은
        // 3,675,683.355원을 000660에서 — 5,670,383.355 − 3,675,683.355 = 1,994,700원 ÷ (1 + 6.5bp) = 1,993,404.29원 → 1.9934%(내림).
        assertThat(ordersOf(rebalance)).extracting(Order::ticker, Order::side, Order::targetWeightPct, Order::sellFraction)
                .containsExactly(tuple("207940", "SELL", null, null), tuple("373220", "SELL", null, null),
                        tuple("000660", "BUY", 1.9934, null), tuple("153130", "SELL", null, 0.176464));
        // 다음 시가 현금(153130 매도 없이) 500,000 + 1,994,700 − 여유 500,000 ≥ 000660 유출 1,994,695.71원.
        assertThat(buyOutflow(ordersOf(rebalance))).isEqualByComparingTo("1994695.71")
                .isLessThanOrEqualTo(java.math.BigDecimal.valueOf(1_994_700));
        assertThat(ordersOf(rebalance).get(2).reason().path("trimmedFromPct").asDouble()).isEqualTo(5.6667);
        assertThat(rebalance.response().path("skipped")).filteredOn(row -> row.path("reason").asString().contains("현금이 모자라"))
                .extracting(row -> row.path("ticker").asString()).containsExactly("105560", "005930");
        assertThat(rebalance.response().path("notes")).extracting(JsonNode::asString)
                .anySatisfy(note -> assertThat(note).contains("153130를 파는데 지금은 체결할 수 없음(2026-11-02 거래정지")
                        .contains("그 대금은 다음 시가 현금 어림에서 뺐음").doesNotContain("cashLimited"))
                .anySatisfy(note -> assertThat(note).contains("종목 매수를 낮은 순위부터 줄임")
                        .contains("000660 5.6667% → 1.9934%").contains("005930 뺌").contains("105560 뺌"));
    }

    @Test
    @DisplayName("재진입 금지 — 체결될 날(D 다음 KR 거래일)에도 금지인 종목은 후보에서 '재진입 금지'로 빠지고 사지 않음, 끝난 금지는 보지 않음")
    void lockoutIsRespected() {
        store.upsertLockout(new Lockout(PaperBooks.KR_RULES, "105560", R1, "트레일링 스탑"));
        store.upsertLockout(new Lockout(PaperBooks.KR_RULES, "000660", R, "트레일링 스탑 — 11-02까지"));

        Decision decision = decideAt(R, "22:30");

        assertThat(subReasons(member(decision, "105560"))).containsExactly("재진입 금지/재진입 금지");
        assertThat(member(decision, "000660").path("candidate").asBoolean()).as("11-02까지 금지 — 체결일 11-03엔 풀림").isTrue();
        assertThat(decision.response().path("input").path("lockedOut").toString())
                .isEqualTo("[{\"code\":\"105560\",\"until\":\"2026-11-03\"}]");
        assertThat(ordersOf(decision)).extracting(Order::ticker).containsExactly("000660", "005930", "153130");
    }

    @Test
    @DisplayName("거래정지 — 그 실행 관측치의 KRX 매매정지(또는 D 봉 거래량 0) 종목은 '거래정지'로 빠짐")
    void suspendedFromTheRunQuotes() {
        com.macrodash.store.Snapshot snapshot = KrRulesFixtures.quotes(R);
        ((ObjectNode) snapshot.payload().path("codes").path("000660")).put("krxTradingSuspended", true);
        clock.set(kst("2026-11-02T22:30"));
        Decision decision = service.decide(run(), R, false, KrPaperMarket.INSTANCE.parse(snapshot));

        assertThat(subReasons(member(decision, "000660"))).containsExactly("거래정지/거래정지");
        assertThat(decision.response().path("input").path("suspended").toString()).isEqualTo("[\"000660\"]");
    }

    @Test
    @DisplayName("거래정지 — 토스 매매정지 표시가 없어도 그 종목 D 봉 거래량이 0이면(정지일 봉 — 시고저종 = 전일 종가) '거래정지'로 빠짐, 전날 봉 거래량 0은 보지 않음")
    void suspendedByZeroVolumeBar() {
        com.macrodash.store.Snapshot snapshot = KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", false);
        JsonNode bars = snapshot.payload().path("codes").path("005930").path("bars");
        ((ObjectNode) bars.get(0)).put("volume", 0);   // 005930은 전날(10-30) 봉만 거래량 0 — D 판정과 무관
        assertThat(snapshot.payload().path("codes").path("000660").path("krxTradingSuspended").asBoolean()).isFalse();
        clock.set(kst("2026-11-02T22:30"));

        Decision decision = service.decide(run(), R, false, KrPaperMarket.INSTANCE.parse(snapshot));

        assertThat(subReasons(member(decision, "000660"))).containsExactly("거래정지/거래정지");
        assertThat(decision.response().path("input").path("suspended").toString()).isEqualTo("[\"000660\"]");
        assertThat(member(decision, "005930").path("candidate").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("체결될 수 없는 종목은 사지 않고 매도는 냄(사용자 결정 u2) — 미처리 기업행위 보유(장부가 보류)의 '후보 밖' 매도·관측치에 봉이 없는 보유의 매도는 주문(지금 체결할 수 없는 사유는 notes), 미처리 기업행위인 후보 보유의 더 사기는 skipped에 사유")
    void unfillableBuysAreSkippedButSellsArePlaced() {
        holding("207940", 100, 10_000);    // DART 없음 — 후보 밖, 미처리 기업행위 보유
        holding("000660", 100, 10_000);    // 후보 — 모자란 만큼 더 살 차례지만 미처리 기업행위 보유
        holding("034020", 100, 10_000);    // U 밖 보유 — 이번 관측치에 봉이 없음(수집 범위 밖)
        store.holdForCorpAction(PaperBooks.KR_RULES, "207940", "큰 변동 — 3중 조건 미충족");
        store.holdForCorpAction(PaperBooks.KR_RULES, "000660", "판정 대기");
        store.upsertState(new BookState(PaperBooks.KR_RULES, 97_000_000, NAV, 3_000_000, 3.0, null, null, S, null));

        Decision decision = decideAt(R, "22:30");

        assertThat(ordersOf(decision)).extracting(Order::ticker, Order::side).containsExactly(
                tuple("034020", "SELL"), tuple("207940", "SELL"), tuple("005930", "BUY"), tuple("105560", "BUY"),
                tuple("153130", "BUY"));
        JsonNode skipped = decision.response().path("skipped");
        assertThat(skipped).extracting(row -> row.path("ticker").asString()).contains("000660")
                .doesNotContain("207940", "034020");
        assertThat(skipped).filteredOn(row -> "000660".equals(row.path("ticker").asString())).singleElement()
                .satisfies(row -> assertThat(row.path("reason").asString()).contains("미처리 기업행위 보유(판정 대기)")
                        .contains("사지 않음"));
        assertThat(decision.response().path("notes")).extracting(JsonNode::asString)
                .anySatisfy(note -> assertThat(note).startsWith("207940 매도 신호(재선정 — 후보 밖)")
                        .contains("지금은 체결할 수 없음(미처리 기업행위 보유").contains("게이트 ①은 그 주문을 기다리지 않음"))
                .anySatisfy(note -> assertThat(note).startsWith("034020 매도 신호")
                        .contains("지금은 체결할 수 없음(이번 관측치에 그 종목 봉이 없음)"));
        // 선정한 날이라 그 매도 대금은 현금 어림에서 뺐음(u3) — 풀려서 팔린 뒤의 대금이 갈 곳(남는 현금 규칙)을 같은 note에 적음.
        assertThat(decision.response().path("notes")).extracting(JsonNode::asString)
                .filteredOn(note -> note.contains("지금은 체결할 수 없음")).hasSize(2)
                .allSatisfy(note -> assertThat(note).contains("선정한 날이라 그 매도 대금은 현금 어림에서 뺐음")
                        .contains("다음 시가에 있을 현금으로 정함")
                        .contains("다음 결정의 남는 현금 규칙(기준 2.0%를 넘을 때만 153130)")
                        .doesNotContain("현금 어림에 넣었음"));
    }

    // ------------------------------------------------------------------ 선정한 날의 현금 어림 — 체결할 수 없는 매도 대금(u3)
    @Test
    @DisplayName("재선정일에 거래정지인 보유(후보 밖)의 매도는 내되 그 대금은 현금 어림에서 뺌(사용자 결정 u3) — 새 종목 둘과 153130을 남은 현금으로 정해 다음 시가에 모두 들어감(153130 66.1579%, 대금을 넣으면 86.1049% — 손계산)")
    void unfillableSellProceedsAreLeftOutOfTheSelectionProjection() {
        holding("000660", 2_000, 10_000);   // 2천만 원(20%) — R 거래정지라 후보 밖
        store.upsertState(new BookState(PaperBooks.KR_RULES, 80_000_000, NAV, 20_000_000, 20.0, null, null, S, null));

        Decision rebalance = decideWith(R, KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));

        // 153130: 현금 8천만 − 두 종목 6,666,700원 × (1 + 6.5bp) × 2 = 66,657,933.29원 → 66.65793329% − 여유 0.5%p = 66.1579%.
        // (매도 대금 2천만 × (1 − 26.5bp) = 19,947,000원을 넣으면 86,604,933.29원 → 86.1049% — 정지가 이어지면 R1 시가 현금 8천만으로는 못 삼.)
        assertThat(ordersOf(rebalance)).extracting(Order::ticker, Order::side, Order::targetWeightPct, Order::sellFraction)
                .containsExactly(tuple("000660", "SELL", null, null), tuple("005930", "BUY", 6.6667, null),
                        tuple("105560", "BUY", 6.6667, null), tuple("153130", "BUY", 66.1579, null));
        assertThat(ordersOf(rebalance).get(0).reason().path("reasons").toString()).isEqualTo("[\"OUT_OF_CANDIDATES\"]");
        // 다음 시가에 매도가 체결되지 않아도 매수 유출(결정 가격·비용 6.5bp) 79,542,969.345원 ≤ 현금 8천만.
        assertThat(buyOutflow(ordersOf(rebalance))).isEqualByComparingTo("79542969.345")
                .isLessThanOrEqualTo(java.math.BigDecimal.valueOf(80_000_000));
        assertThat(rebalance.response().path("notes")).extracting(JsonNode::asString).anySatisfy(note ->
                assertThat(note).startsWith("000660 매도 신호(재선정 — 후보 밖)").contains("2026-11-02 거래정지")
                        .contains("선정한 날이라 그 매도 대금은 현금 어림에서 뺐음"));
    }

    @Test
    @DisplayName("현금이 모자란 재선정일 — 거래정지 보유의 매도 대금을 빼서(u3) 153130 일부 매도가 커지고 그 매도로 종목 매수가 다음 시가 현금 안에 듦(비율 0.167934, 대금을 넣으면 153130을 6.6049% 더 삼 — 손계산)")
    void unfillableSellProceedsLeftOutGrowTheParkingSell() {
        holding("000660", 2_000, 10_000);   // R 거래정지 — 후보 밖
        holding("153130", 795, 100_000);    // 79,500,000원
        store.upsertState(new BookState(PaperBooks.KR_RULES, 500_000, NAV, 99_500_000, 99.5, null, null, S, null));

        Decision rebalance = decideWith(R, KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));

        // 어림 = 현금 500,000 − 13,342,066.71 = −12,842,066.71원(−12.84206671%) → 153130 매도 필요 = (0.5 + 12.84206671)% × 1억
        // = 13,342,066.71원 ÷ (79,500,000 × (1 − 6.5bp) = 79,448,325) = 0.167934.
        // (매도 대금 19,947,000원을 넣으면 어림 7,104,933.29원 → 153130 6.6049% 매수 — 정지가 이어지면 현금 50만으로 종목도 못 삼.)
        assertThat(ordersOf(rebalance)).extracting(Order::ticker, Order::side, Order::targetWeightPct, Order::sellFraction)
                .containsExactly(tuple("000660", "SELL", null, null), tuple("005930", "BUY", 6.6667, null),
                        tuple("105560", "BUY", 6.6667, null), tuple("153130", "SELL", null, 0.167934));
        // 다음 시가 현금 = 500,000 + 153130 79,500,000 × 0.167934 × (1 − 6.5bp) ≥ 종목 매수 유출 13,342,066.71원.
        java.math.BigDecimal parkingSale = java.math.BigDecimal.valueOf(79_500_000L)
                .multiply(java.math.BigDecimal.valueOf(0.167934)).multiply(new java.math.BigDecimal("0.99935"));
        assertThat(buyOutflow(ordersOf(rebalance))).isEqualByComparingTo("13342066.71")
                .isLessThanOrEqualTo(parkingSale.add(java.math.BigDecimal.valueOf(500_000)));
    }

    @Test
    @DisplayName("153130 매도로도 다음 시가 현금이 모자라면 종목 매수를 낮은 순위부터 줄임(u3 — 선정한 날 매수는 다음 시가에 있을 현금 안) — 거래정지 보유의 대금은 빼고 153130 2백만 원을 전량 팔아도 모자라 105560 6.6667% → 4.4957%(손계산)")
    void stockBuysAreTrimmedWhenParkingCannotCoverTheShortfall() {
        holding("000660", 2_000, 10_000);   // 2천만 원 — R 거래정지라 후보 밖(그 대금은 어림 밖)
        holding("005930", 7_500, 10_000);   // 7천5백만 원 — 후보지만 이미 목표 비중 이상
        holding("153130", 20, 100_000);     // 2백만 원
        store.upsertState(new BookState(PaperBooks.KR_RULES, 3_000_000, NAV, 97_000_000, 97.0, null, null, S, null));

        Decision rebalance = decideWith(R, KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));

        // 어림 = 현금 3,000,000 − 105560 6,666,700 × (1 + 6.5bp) = 6,671,033.355 → −3,671,033.355원 → 메울 현금 4,171,033.355원(여유 0.5%p 포함).
        // 153130 전량 2,000,000 × (1 − 6.5bp) = 1,998,700원으로 모자란 2,172,333.355원을 105560에서: 6,671,033.355 − 2,172,333.355 = 4,498,700원
        // ÷ (1 + 6.5bp) = 4,495,777.74원 → 4.4957%(내림). 고치기 전에는 6.6667%를 내고 R1에 정지가 이어지면 장부가 현금 한도로 줄였음(cashLimited).
        assertThat(ordersOf(rebalance)).extracting(Order::ticker, Order::side, Order::targetWeightPct, Order::sellFraction)
                .containsExactly(tuple("000660", "SELL", null, null), tuple("105560", "BUY", 4.4957, null),
                        tuple("153130", "SELL", null, null));
        // 다음 시가 현금 = 3,000,000 + 1,998,700 = 4,998,700원 − 여유 500,000 ≥ 105560 유출 4,498,622.205원.
        assertThat(buyOutflow(ordersOf(rebalance))).isEqualByComparingTo("4498622.205")
                .isLessThanOrEqualTo(java.math.BigDecimal.valueOf(4_498_700));
        JsonNode reason = ordersOf(rebalance).get(1).reason();
        assertThat(reason.path("targetWeightPct").asDouble()).as("K10 목표는 그대로").isEqualTo(6.6667);
        assertThat(reason.path("orderWeightPct").asDouble()).isEqualTo(4.4957);
        assertThat(reason.path("trimmedFromPct").asDouble()).isEqualTo(6.6667);
        assertThat(rebalance.response().path("notes")).extracting(JsonNode::asString).anySatisfy(note ->
                assertThat(note).contains("153130 매도로 메울 수 있는 1,998,700원").contains("종목 매수를 낮은 순위부터 줄임")
                        .contains("105560 6.6667% → 4.4957%").contains("다음 재선정까지 채우지 않음"));
    }

    @Test
    @DisplayName("앞선 날의 대기 153130 매도가 있으면 다시 내지 않고 그 몫(파는 비율)만 다음 시가 현금으로 셈 — 모자란 만큼 종목 매수를 줄이고, 줄인 매수가 최소 금액 미만이면 뺌(105560 0.2996% < 50만 원 — 손계산)")
    void pendingParkingSellCountsOnlyItsShareAndSmallRemaindersAreDropped() {
        holding("000660", 2_000, 10_000);   // R 거래정지 — 후보 밖
        holding("005930", 7_740, 10_000);   // 77,400,000원 — 이미 목표 이상
        holding("153130", 20, 100_000);     // 2백만 원 — 그중 10%를 파는 대기 매도
        store.insertOrder(new Order(0, PaperBooks.KR_RULES, null, "153130", PaperBooks.SELL, null, null, 0.1,
                PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, FRI,
                kst("2026-10-30T22:30"), LocalDate.of(2026, 11, 4), null));
        store.upsertState(new BookState(PaperBooks.KR_RULES, 600_000, NAV, 99_400_000, 99.4, null, null, S, null));

        Decision rebalance = decideWith(R, KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));

        // 어림 = 600,000 − 6,671,033.355 = −6,071,033.355원 → 메울 현금 6,571,033.355원. 대기 매도 몫 1,998,700 × 0.1 = 199,870원만 셈 →
        // 105560에 남는 유출 6,671,033.355 − 6,371,163.355 = 299,870원 ÷ (1 + 6.5bp) → 0.2996% = 299,600원 < 최소 50만 원 → 뺌.
        assertThat(ordersOf(rebalance)).extracting(Order::ticker, Order::side).containsExactly(tuple("000660", "SELL"));
        assertThat(rebalance.response().path("skipped")).extracting(row -> row.path("ticker").asString() + " "
                + row.path("reason").asString()).anySatisfy(row -> assertThat(row)
                        .startsWith("153130 모자란 현금 — 이미 대기 중인 매도 주문이 있음"))
                .anySatisfy(row -> assertThat(row).startsWith("105560 최소 금액 미만(299,600원"));
        assertThat(rebalance.response().path("notes")).extracting(JsonNode::asString).anySatisfy(note ->
                assertThat(note).contains("153130 매도로 메울 수 있는 199,870원").contains("105560 뺌"));
    }

    @Test
    @DisplayName("이번 종목 매수를 모두 빼도 모자라면(앞선 날의 대기 매수가 현금보다 큼) 그 차이를 note에 — 대기 매수는 체결 때 살 수 있는 만큼으로 줄어듦(cashLimited)")
    void pendingBuysBeyondCashAreLeftToTheLedger() {
        holding("005930", 9_000, 10_000);   // 9천만 원 — 이미 목표 이상
        store.insertOrder(new Order(0, PaperBooks.KR_RULES, null, "373220", PaperBooks.BUY, null, 30.0, null,
                PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, FRI,
                kst("2026-10-30T22:30"), LocalDate.of(2026, 11, 4), null));
        store.upsertState(new BookState(PaperBooks.KR_RULES, 10_000_000, NAV, 90_000_000, 90.0, null, null, S, null));

        Decision rebalance = decideWith(R, KrRulesFixtures.quotes(R));

        // 어림 = 10,000,000 − 대기 매수 30,019,500 − 000660·105560 13,342,066.71 = −33,361,566.71원 → 메울 현금 33,861,566.71원,
        // 팔 153130 없음 → 105560·000660을 빼도 20,519,500원 모자람.
        assertThat(ordersOf(rebalance)).isEmpty();
        assertThat(rebalance.response().path("skipped")).filteredOn(row -> row.path("reason").asString().contains("현금이 모자라"))
                .extracting(row -> row.path("ticker").asString()).containsExactly("105560", "000660");
        assertThat(rebalance.response().path("notes")).extracting(JsonNode::asString).anySatisfy(note ->
                assertThat(note).contains("이번 종목 매수를 모두 빼도 20,519,500원 모자람").contains("cashLimited"));
    }

    @Test
    @DisplayName("체결할 수 있는 매도의 대금은 그대로 셈 — 같은 재선정일에 수급 미달 보유(관측 봉 있음)의 대금은 넣고 거래정지 보유의 대금만 뺌(153130 76.1314% — 손계산)")
    void fillableSellProceedsStillCountOnTheSelectionDay() {
        holding("000660", 1_000, 10_000);   // R 거래정지 — 후보 밖, 대금 뺌
        holding("373220", 1_000, 10_000);   // 20일 둘 다 순매도 — 체결할 수 있음, 대금 넣음
        store.upsertState(new BookState(PaperBooks.KR_RULES, 80_000_000, NAV, 20_000_000, 20.0, null, null, S, null));

        Decision rebalance = decideWith(R, KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));

        // 153130: 8천만 + 373220 1천만 × (1 − 26.5bp) = 9,973,500 − 13,342,066.71 = 76,631,433.29원 → 76.1314%(000660 대금까지 넣으면 86.1049%).
        assertThat(ordersOf(rebalance)).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(tuple("000660", "SELL", null), tuple("373220", "SELL", null), tuple("005930", "BUY", 6.6667),
                        tuple("105560", "BUY", 6.6667), tuple("153130", "BUY", 76.1314));
        assertThat(rebalance.response().path("notes")).extracting(JsonNode::asString)
                .filteredOn(note -> note.contains("지금은 체결할 수 없음")).singleElement(
                        org.assertj.core.api.InstanceOfAssertFactories.STRING).startsWith("000660 매도 신호");
    }

    @Test
    @DisplayName("재선정일이 아닌 날은 그대로(u3는 선정한 날만) — 거래정지 보유의 매일 매도 신호 대금도 남는 현금 어림에 넣어 기준 2%를 넘으면 153130(2.4947% — 손계산), note에 넣었음을 적음")
    void dailyDecisionStillCountsUnfillableSellProceeds() {
        holding("373220", 200, 10_000);     // 2,000,000원 — 20일 둘 다 순매도(매일 신호), FRI 거래정지
        holding("153130", 970, 100_000);    // 97,000,000원
        store.upsertState(new BookState(PaperBooks.KR_RULES, 1_000_000, NAV, 99_000_000, 99.0, null, null, S, null));

        Decision daily = decideWith(FRI, KrRulesFixtures.suspend(KrRulesFixtures.quotes(FRI), "373220", true));

        // 어림 = 현금 1,000,000 + 2,000,000 × (1 − 26.5bp) = 2,994,700원 = 2.9947% > 기준 2% → 2.4947%를 153130에(빼면 1% — 사지 않음).
        assertThat(daily.kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(ordersOf(daily)).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(tuple("373220", "SELL", null), tuple("153130", "BUY", 2.4947));
        assertThat(ordersOf(daily).get(1).reason().path("rule").asString()).isEqualTo(KrRuleBookService.RULE_PARK_DAILY);
        assertThat(daily.response().path("notes")).extracting(JsonNode::asString).anySatisfy(note ->
                assertThat(note).startsWith("373220 매도 신호(20일 외국인·기관 둘 다 순매도)").contains("2026-10-30 거래정지")
                        .contains("선정한 날이 아니라 그 매도 대금도 남는 현금 어림에 넣었음").contains("cashLimited"));
    }

    @Test
    @DisplayName("따라잡기 재선정(r′ = 11-03)도 같은 규칙(u3) — 거래정지 보유의 '후보 밖' 매도 대금과 앞선 날(FRI)의 체결할 수 없는 대기 매도 대금을 모두 빼고 153130 56.1579%(넣으면 86.0784% — 손계산)")
    void catchUpLeavesOutUnfillablePendingAndNewSells() {
        clock.set(kst("2026-11-03T01:00"));
        assertThat(service.pastDeadline(run(), R, kst("2026-11-03T01:00")).status()).isEqualTo("NO_TRADE");
        holding("000660", 2_000, 10_000);   // R1 거래정지 — 후보 밖(새 매도)
        holding("373220", 1_000, 10_000);   // FRI 매일 신호의 대기 매도 — R1 거래정지
        long pendingSell = store.insertOrder(new Order(0, PaperBooks.KR_RULES, null, "373220", PaperBooks.SELL, null, null,
                null, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, FRI,
                kst("2026-10-30T22:30"), LocalDate.of(2026, 11, 4), null));
        store.upsertState(new BookState(PaperBooks.KR_RULES, 70_000_000, NAV, 30_000_000, 30.0, null, null, S, null));
        com.macrodash.store.Snapshot quotes = KrRulesFixtures.suspend(
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R1), "000660", true), "373220", true);

        Decision catchUp = decideWith(R1, quotes);

        assertThat(catchUp.kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(catchUp.response().path("catchUp").asBoolean()).isTrue();
        // 153130: 현금 7천만 − 13,342,066.71 = 56,657,933.29원 → 56.1579%
        // (대기 매도 1천만 × (1 − 26.5bp) = 9,973,500원과 새 매도 19,947,000원을 넣으면 86,578,433.29원 → 86.0784%).
        assertThat(ordersOf(catchUp)).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(tuple("000660", "SELL", null), tuple("005930", "BUY", 6.6667),
                        tuple("105560", "BUY", 6.6667), tuple("153130", "BUY", 56.1579));
        assertThat(store.orders.get(pendingSell).status()).as("대기 매도는 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(catchUp.response().path("notes")).extracting(JsonNode::asString)
                .anySatisfy(note -> assertThat(note).startsWith("373220 대기 매도 — 지금은 체결할 수 없음(2026-11-03 거래정지")
                        .contains("선정한 날이라 그 대금을 현금 어림에서 뺐음"))
                .anySatisfy(note -> assertThat(note).startsWith("000660 매도 신호(재선정 — 후보 밖)")
                        .contains("선정한 날이라 그 매도 대금은 현금 어림에서 뺐음"));
    }

    @Test
    @DisplayName("출발(INITIAL) 계획도 같은 어림(u3) — 출발은 초기화 뒤라 실제로는 보유·대기 주문이 없지만, 보유를 심으면 재선정일과 같은 손계산(153130 66.1579%)이 나옴(출발 = S의 재선정과 같은 계산)")
    void startPlanUsesTheSameSelectionProjection() {
        holding("000660", 2_000, 10_000);   // 심은 보유 — S 거래정지라 후보 밖
        store.upsertState(new BookState(PaperBooks.KR_RULES, 80_000_000, NAV, 20_000_000, 20.0, null, null, S, null));
        clock.set(kst("2026-10-29T22:30"));
        MarketRun run = run();
        com.macrodash.store.Snapshot snapshot = KrRulesFixtures.suspend(KrRulesFixtures.quotes(S), "000660", true);
        Optional<PaperMarketData.Quotes> quotes = KrPaperMarket.INSTANCE.parse(snapshot);
        KrRuleBookService.Read read = service.readInputs(run, S, clock.instant(), quotes);

        KrStartPipeline.Plan plan = service.startLeg(config()).plan(run, S, kst("2026-10-30T01:00"),
                new KrDecisionGates.Checked(List.of(), new KrDecisionGates.Inputs(S, snapshot, quotes, null, read, null)));

        assertThat(plan.failed()).as(String.valueOf(plan.note())).isFalse();
        assertThat(plan.decision().kind()).isEqualTo(RuleBookService.INITIAL);
        assertThat(plan.orders()).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(tuple("000660", "SELL", null), tuple("005930", "BUY", 6.6667),
                        tuple("105560", "BUY", 6.6667), tuple("153130", "BUY", 66.1579));
    }

    @Test
    @DisplayName("일시정지 계좌 — 입력을 읽지 않고 SKIPPED(주문 없음), 재선정일이면 종류는 REBALANCE라 따라잡기가 셈하지 않음")
    void pausedBookIsSkipped() {
        store.updateBookStatus(PaperBooks.KR_RULES, PaperBooks.PAUSED);

        Decision decision = decideAt(R, "22:30");

        assertThat(decision.kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(decision.status()).isEqualTo("SKIPPED");
        assertThat(ordersOf(decision)).isEmpty();
        assertThat(decision.response().has("input")).isFalse();
    }

    // ------------------------------------------------------------------ 설정 판(e6)
    @Test
    @DisplayName("그 실행의 설정 판을 kr. 접두어로 — kr.rulesMaxNames 2면 상위 둘(상한 10%), 실행을 연 뒤 저장한 판은 끼지 않고 결정 행에 그 판 번호")
    void readsTheRunSettingsVersion() {
        saveKr("rulesMaxNames", 2);
        int version = store.settings.version();
        clock.set(kst("2026-11-02T22:30"));
        MarketRun run = run();
        saveKr("rulesMaxNames", 1);   // 실행을 연 뒤 저장 — 다음 실행부터

        Decision decision = service.decide(run, R, false, KrPaperMarket.INSTANCE.parse(KrRulesFixtures.quotes(R)));

        assertThat(decision.settingsVersion()).isEqualTo(version);
        assertThat(decision.response().path("settings").path("rulesMaxNames").asInt()).isEqualTo(2);
        assertThat(ordersOf(decision)).extracting(Order::ticker, Order::targetWeightPct)
                .as("min(100 ÷ 2, 종목 상한 10)").startsWith(tuple("000660", 10.0), tuple("005930", 10.0));
        assertThat(decision.response().path("selection").path("notChosen").toString()).isEqualTo("[\"105560\"]");
    }

    @Test
    @DisplayName("설정 키가 없거나 틀리면 그 키만 기본값 — 결정 행 settings.fallbacks에 실제 키 이름")
    void fallbacksNameTheRealKeys() {
        ObjectNode body = (ObjectNode) store.settings.body().deepCopy();
        ((ObjectNode) body.path("kr").path("rules")).put("weighting", "NONSENSE");
        ((ObjectNode) body.path("kr")).remove("minOrderNotional");
        store.saveSettings(body, List.of("kr.rules.weighting"));

        Decision decision = decideAt(R, "22:30");

        assertThat(decision.response().path("settings").path("weighting").asString()).isEqualTo("EQUAL");
        assertThat(decision.response().path("settings").path("minOrderNotional").asDouble()).isEqualTo(500_000);
        assertThat(decision.response().path("settings").path("fallbacks").toString())
                .contains("kr.rules.weighting").contains("kr.minOrderNotional");
    }

    // ------------------------------------------------------------------ 기한 지남·따라잡기(K33)
    @Test
    @DisplayName("기한 지남 행 — 재선정일 r(11-02)이면 REBALANCE NO_TRADE(사유 '기한 지남', 주문 없음), 다시 불러도 한 건 → r′(11-03) 따라잡기 REBALANCE(cycleDate r·selectionAsOf r′, r′ 자료) → 11-04 SCHEDULED")
    void pastDeadlineRowThenCatchUp() {
        clock.set(kst("2026-11-03T01:00"));
        Decision missed = service.pastDeadline(run(), R, kst("2026-11-03T01:00"));
        assertThat(missed.kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(missed.status()).isEqualTo("NO_TRADE");
        assertThat(missed.response().path("noTradeReason").asString()).isEqualTo("기한 지남");
        assertThat(missed.response().path("cycleDate").asString()).isEqualTo("2026-11-02");
        assertThat(ordersOf(missed)).isEmpty();
        assertThat(service.pastDeadline(run(), R, kst("2026-11-03T01:00")).id()).isEqualTo(missed.id());
        assertThat(service.due(R)).isFalse();

        Decision catchUp = decideAt(R1, "22:30");
        assertThat(catchUp.kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(catchUp.status()).isEqualTo("OK");
        assertThat(catchUp.selectionAsOf()).isEqualTo(R1);
        assertThat(catchUp.response().path("cycleDate").asString()).isEqualTo("2026-11-02");
        assertThat(catchUp.response().path("selectionAsOf").asString()).isEqualTo("2026-11-03");
        assertThat(catchUp.response().path("catchUp").asBoolean()).isTrue();
        assertThat(catchUp.response().path("input").path("universe").path("baseDate").asString())
                .as("r′ 자료 — U(r′)").isEqualTo("2026-11-02");
        assertThat(catchUp.response().path("input").path("flowsWindow").path("to").asString()).isEqualTo("2026-11-03");
        assertThat(catchUp.response().path("summary").asString()).contains("따라잡기 재선정(주기 2026-11-02, 입력 2026-11-03)");
        assertThat(ordersOf(catchUp)).extracting(Order::ticker).containsExactly("000660", "005930", "105560", "153130");

        Decision after = decideAt(R2, "22:30");
        assertThat(after.kind()).as("그 주기 매수 결정이 생긴 뒤").isEqualTo(RuleBookService.SCHEDULED);
    }

    @Test
    @DisplayName("입력 오류 — D 앞 기준일의 U가 없으면 결정하지 않고 예외(짐작한 U로 돌지 않음, 결정 작업이 오류로 셈)")
    void missingUniverseIsAnError() {
        data.universe.clear();
        clock.set(kst("2026-11-02T22:30"));
        MarketRun run = run();
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.decide(run, R, false, Optional.empty()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("kr_paper_universe");
        assertThat(service.decisionOn(R)).isEmpty();
    }

    // ------------------------------------------------------------------ 규칙 계좌 영향 표시
    @Test
    @DisplayName("설정 키 표의 '한국 규칙 계좌 영향'(affectsRules) = 이 계좌 결정이 읽는 kr.* 키 ∪ 장부가 이 계좌 체결·스탑에 읽는 kr.* 키 — ETF 상한은 아님")
    void affectsRulesMatchesTheKeysRead() {
        java.util.Set<String> marked = new java.util.TreeSet<>();
        for (PaperSettingKeys.Spec spec : PaperSettingKeys.ALL) {
            if (spec.scope() == PaperSettingKeys.Scope.KR && spec.affectsRules()) {
                marked.add(spec.key());
            }
        }
        java.util.Set<String> read = new java.util.TreeSet<>(KrRuleBookService.DECISION_KEYS);
        read.addAll(KrRuleBookService.LEDGER_KEYS);

        assertThat(marked).isEqualTo(read);
        assertThat(marked).doesNotContain("kr.maxWeightEtfPct");
        // 결정이 읽는 키는 결정 행 settings에 값이 남음(그 실행의 판).
        JsonNode used = decideAt(R, "22:30").response().path("settings");
        for (String key : List.of("rulesMaxNames", "weighting", "minStreakDays", "debtRatioMaxPct", "reselection",
                "parkCashThresholdPct", "maxWeightStockPct", "minOrderNotional", "cashLikeTickers", "slippageBp",
                "commissionBp", "stockSellCostBp")) {
            assertThat(used.has(key)).as(key).isTrue();
        }
    }

    private void holding(String code, int qty, double price) {
        store.upsertPosition(new Position(PaperBooks.KR_RULES, code, qty, price, S, kst("2026-10-30T09:00"), price,
                kst("2026-10-30T09:00"), price, kst("2026-10-30T21:57"), false, S, price, null));
    }

    private void saveKr(String key, int value) {
        ObjectNode body = (ObjectNode) store.settings.body().deepCopy();
        ((ObjectNode) body.path("kr")).put(key, value);
        store.saveSettings(body, List.of("kr." + key));
    }
}
