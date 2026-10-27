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

    private List<Order> ordersOf(Decision decision) {
        return store.ordersByDecision(decision.id());
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
    @DisplayName("'자료 없음' 사유가 결정 행에 — DART 없음·접수일이 기준일 뒤·접수일 모름, 자료 부족(19/20일)·수급 미달, 금융업(매출액 없음)은 부채비율로 빠지지 않음")
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
        assertThat(kb.path("dart").path("hasRevenueAccount").asBoolean()).isFalse();
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
    @DisplayName("체결될 수 없는 종목에는 주문을 내지 않음 — 미처리 기업행위 보유(장부가 보류)의 '후보 밖' 매도와 후보 보유의 더 사기, 관측치에 봉이 없는 보유의 매도는 skipped에 사유")
    void unfillableOrdersAreNotPlaced() {
        holding("207940", 100, 10_000);    // DART 없음 — 후보 밖, 미처리 기업행위 보유
        holding("000660", 100, 10_000);    // 후보 — 모자란 만큼 더 살 차례지만 미처리 기업행위 보유
        holding("034020", 100, 10_000);    // U 밖 보유 — 이번 관측치에 봉이 없음(수집 범위 밖)
        store.holdForCorpAction(PaperBooks.KR_RULES, "207940", "큰 변동 — 3중 조건 미충족");
        store.holdForCorpAction(PaperBooks.KR_RULES, "000660", "판정 대기");
        store.upsertState(new BookState(PaperBooks.KR_RULES, 97_000_000, NAV, 3_000_000, 3.0, null, null, S, null));

        Decision decision = decideAt(R, "22:30");

        assertThat(ordersOf(decision)).extracting(Order::ticker, Order::side)
                .containsExactly(tuple("005930", "BUY"), tuple("105560", "BUY"), tuple("153130", "BUY"));
        JsonNode skipped = decision.response().path("skipped");
        assertThat(skipped).extracting(row -> row.path("ticker").asString()).contains("207940", "000660", "034020");
        for (JsonNode row : skipped) {
            String reason = row.path("reason").asString();
            switch (row.path("ticker").asString()) {
                case "207940" -> assertThat(reason).contains("매도 신호(재선정 — 후보 밖)").contains("미처리 기업행위 보유")
                        .contains("매도 주문을 내지 않음");
                case "000660" -> assertThat(reason).contains("미처리 기업행위 보유(판정 대기)").contains("사지 않음");
                case "034020" -> assertThat(reason).contains("이번 관측치에 그 종목 봉이 없음").contains("매도 주문을 내지 않음");
                default -> { }
            }
        }
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
