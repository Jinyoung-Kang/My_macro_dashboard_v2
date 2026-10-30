package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.feature.ai.AiService;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 미국 Claude 계좌2의 검증·주문 행(계좌2 명세 §6-2·§10-5, 1-5) — 결정 파이프라인을 계좌2 문맥({@link ClaudeBookProfile#US_CLAUDE2})으로 만들어
 * Claude 호출 없이(받은 응답을 바로 넘김) 판정·주문 행을 봅니다: 메뉴 시점을 받고 순위로 자리를 셈, 그 결정에서 닫힌 시점(조기 폐장·지난 시각),
 * 주문은 목표 세션 E 하루짜리, 근거에 executionNote, 이달 재량 주문 수에서 출발(INITIAL) 결정 주문을 뺌 — 계좌1 문맥은 그대로.
 */
class Claude2PipelineTest {

    /** 10-26(월) 결정 → E = 10-27(화). 지금 = 10-27 07:30 KST(10-26 22:30Z). */
    private static final Instant DECIDED = Instant.parse("2026-10-26T22:30:00Z");
    private static final LocalDate TUE = LocalDate.of(2026, 10, 27);

    private FakePaperStore store;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        for (String code : List.of(PaperBooks.CLAUDE, PaperBooks.CLAUDE2)) {
            store.books.put(code, new Book(code, PaperBooks.KIND_CLAUDE, code, 100_000, FRI, PaperBooks.ACTIVE, FRI_CLOSE));
            store.states.put(code, new BookState(code, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE, FRI, null));
        }
    }

    /** 운영 미국 문맥(계좌1 = 0, 계좌2 = 1)의 파이프라인 — 패킷·프레임·호출은 쓰지 않음(받은 응답을 바로 검증). */
    private ClaudeDecisionPipeline pipeline(int index, Instant now) {
        ClaudeDecisionPipeline.MarketContext context = ClaudeBookService.marketContexts(mock(PacketBuilder.class), null)
                .get(index);
        return new ClaudeDecisionPipeline(context, store, null, null, null, MAPPER, Clock.fixed(now, ZoneOffset.UTC), 30);
    }

    private ClaudeDecisionPipeline book2(Instant now) {
        ClaudeDecisionPipeline pipeline = pipeline(1, now);
        assertThat(pipeline.profile()).isSameAs(ClaudeBookProfile.US_CLAUDE2);
        return pipeline;
    }

    private static ClaudeDecisionPipeline.Attempt attempt(String json) {
        JsonNode parsed = MAPPER.readTree(json);
        PacketBuilder.Packet packet = new PacketBuilder.Packet(MAPPER.createObjectNode(), "{}", "hash", List.of(), null);
        FrameworkService.Frame frame = new FrameworkService.Frame(0, "INTERIM", "시험", MAPPER.createObjectNode(), "", 0,
                null, null, null);
        AiService.StructuredResult result = new AiService.StructuredResult(true, json, "end_turn", null, null, true, 1L,
                1L, 0L, 0L, 5L);
        return new ClaudeDecisionPipeline.Attempt(packet, frame, result, null, null, parsed, List.of(),
                "claude-sonnet-5-5", "high");
    }

    private static String response(String... orders) {
        return "{\"schemaVersion\":2,\"stance\":\"NEUTRAL\",\"targetEquityExposurePct\":10,\"exposureRationale\":\"r\","
                + "\"summary\":\"s\",\"orders\":[" + String.join(",", orders) + "],\"noTradeReason\":null,\"confidence\":0.5}";
    }

    private static String buy(String ticker, double weight, String timing) {
        return "{\"ticker\":\"" + ticker + "\",\"side\":\"BUY\",\"targetWeightPct\":" + weight + ",\"sellFraction\":null,"
                + "\"timing\":\"" + timing + "\",\"executionNote\":\"" + timing + "을 고른 이유\",\"thesis\":\"t\","
                + "\"labels\":[\"사실\"],\"invalidation\":\"i\"}";
    }

    private ClaudeDecisionPipeline.Plan plan(ClaudeDecisionPipeline pipeline, LocalDate asOf, String json) {
        return plan(pipeline, asOf, json, DECIDED);
    }

    /** @param collectedAt 관측치 저장본의 수집 시각(검증 시각에서 24시간 안 — STALE_INPUT이 아니게) */
    private ClaudeDecisionPipeline.Plan plan(ClaudeDecisionPipeline pipeline, LocalDate asOf, String json,
                                             Instant collectedAt) {
        Optional<PaperMarketData.Quotes> quotes = Optional.of(quotes(collectedAt, bar("AAA", FRI, 99, MON, 100),
                bar("BBB", FRI, 49, MON, 50), bar("CCC", FRI, 9, MON, 10)));
        return pipeline.plan(asOf, RuleBookService.SCHEDULED, false, attempt(json), pipeline.ledgerView(false),
                store.settings().orElseThrow(), ClaudeBookService.ClaudeSettings.from(store.settings().orElseThrow().body()),
                quotes, ClaudeDecisionPipeline.observedUniverse(quotes), Map.of());
    }

    @Test
    @DisplayName("계좌2: 메뉴 시점 주문을 받고 주문 행은 목표 세션 E(10-27) 하루짜리·근거에 executionNote, NEXT_OBSERVATION은 MALFORMED — 계좌1 문맥은 3거래일·executionNote 없음 그대로")
    void acceptsTheMenuAndOrdersLastOneSession() {
        ClaudeDecisionPipeline pipeline = book2(DECIDED);
        ClaudeDecisionPipeline.Plan plan = plan(pipeline, MON, response(buy("AAA", 5, "NEXT_OPEN"),
                buy("BBB", 5, "AT_1500"), buy("CCC", 5, "NEXT_OBSERVATION")));
        assertThat(plan.verdicts()).extracting(OrderValidator.Verdict::rejectReason)
                .containsExactly(null, null, OrderValidator.MALFORMED);
        assertThat(plan.verdicts().get(2).detail()).contains("NEXT_OPEN 또는 AT_1000").contains("NEXT_CLOSE여야 함");
        List<Order> rows = pipeline.orderRows(7, MON, plan, PaperBooks.ORDER_PENDING);
        assertThat(rows).extracting(Order::bookCode).containsOnly(PaperBooks.CLAUDE2);
        assertThat(rows.subList(0, 2)).extracting(Order::timing, Order::expiresOn).containsExactly(
                org.assertj.core.groups.Tuple.tuple("NEXT_OPEN", TUE), org.assertj.core.groups.Tuple.tuple("AT_1500", TUE));
        assertThat(rows.get(0).reason().path("executionNote").asString()).isEqualTo("NEXT_OPEN을 고른 이유");
        assertThat(rows.get(2).expiresOn()).as("거절 행은 만료 없음").isNull();

        // 계좌1 문맥 — 같은 응답(executionNote가 섞여도 근거에 싣지 않음 — 계좌1 스키마에는 그 칸이 없음)에서 만료는 기준일 + 3거래일.
        ClaudeDecisionPipeline bound = pipeline(0, DECIDED);
        assertThat(bound.book()).isEqualTo(PaperBooks.CLAUDE);
        ClaudeDecisionPipeline.Plan plan1 = plan(bound, MON, response(buy("AAA", 5, "NEXT_OBSERVATION").replace(
                ",\"executionNote\":\"NEXT_OBSERVATION을 고른 이유\"", "")));
        Order row1 = bound.orderRows(8, MON, plan1, PaperBooks.ORDER_PENDING).get(0);
        assertThat(row1.expiresOn()).isEqualTo(LocalDate.of(2026, 10, 29));
        assertThat(row1.reason().has("executionNote")).isFalse();
    }

    @Test
    @DisplayName("계좌2 검증의 닫힌 시점: 조기 폐장일 E(11-27)의 AT_1300~AT_1500은 MALFORMED '조기 폐장 13:00 ET', E 09:59:30 ET에 검증하면 NEXT_OPEN·AT_1000은 LATE_FOR_TIMING")
    void closedTimingsComeFromTheDecisionDayAndTheClock() {
        ClaudeDecisionPipeline early = book2(Instant.parse("2026-11-25T22:30:00Z"));
        ClaudeDecisionPipeline.Plan plan = plan(early, LocalDate.of(2026, 11, 25), response(buy("AAA", 5, "AT_1200"),
                buy("BBB", 5, "AT_1300")), Instant.parse("2026-11-25T21:30:00Z"));
        assertThat(plan.verdicts()).extracting(OrderValidator.Verdict::rejectReason)
                .containsExactly(null, OrderValidator.MALFORMED);
        assertThat(plan.verdicts().get(1).detail()).startsWith("조기 폐장 13:00 ET");

        ClaudeDecisionPipeline late = book2(Instant.parse("2026-10-27T13:59:30Z"));
        ClaudeDecisionPipeline.Plan latePlan = plan(late, MON, response(buy("AAA", 5, "NEXT_OPEN"),
                buy("BBB", 5, "AT_1000"), buy("CCC", 5, "AT_1100")));
        assertThat(latePlan.verdicts()).extracting(OrderValidator.Verdict::rejectReason).containsExactly(
                OrderValidator.LATE_FOR_TIMING, OrderValidator.LATE_FOR_TIMING, null);
    }

    @Test
    @DisplayName("계좌2의 월 상한 — 이달 재량 주문 수에서 출발(INITIAL) 결정의 체결 주문은 빼고 정기 결정의 체결 주문만 셈(한국 계산 — T12), 계좌1은 사후 체결(BACKFILL)만 뺌")
    void monthlyCapLeavesOutTheStartDecision() {
        long start = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE2, LocalDate.of(2026, 10, 21),
                RuleBookService.INITIAL, null, "OK", "claude-sonnet-5-5", 0, 1, null, 50.0, null, null, null,
                MAPPER.createObjectNode(), null, null, null, true, 1L, 0)).orElseThrow();
        for (String ticker : List.of("S1", "S2", "S3")) {
            store.insertOrder(new Order(0, PaperBooks.CLAUDE2, start, ticker, "BUY", null, 5.0, null, "NEXT_OPEN", "CLAUDE",
                    "FILLED", null, null, LocalDate.of(2026, 10, 21), FRI_CLOSE, LocalDate.of(2026, 10, 22), FRI_CLOSE));
        }
        long regular = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE2, FRI, RuleBookService.SCHEDULED,
                null, "OK", "claude-sonnet-5-5", 0, 1, null, 50.0, null, null, null, MAPPER.createObjectNode(), null, null,
                null, true, 1L, 0)).orElseThrow();
        store.insertOrder(new Order(0, PaperBooks.CLAUDE2, regular, "R1", "BUY", null, 5.0, null, "AT_1000", "CLAUDE",
                "FILLED", null, null, FRI, FRI_CLOSE, MON, FRI_CLOSE));
        ClaudeDecisionPipeline.Plan plan = plan(book2(DECIDED), MON, response(buy("AAA", 5, "NEXT_OPEN")));
        assertThat(plan.response().path("monthlyDiscretionaryOrders").asInt()).isEqualTo(1);
        assertThat(KrPacketBuilder.monthlyDiscretionaryOrders(store, PaperBooks.CLAUDE2, MON)).isEqualTo(1);
        assertThat(PacketBuilder.monthlyDiscretionaryOrders(store.recentOrders(PaperBooks.CLAUDE2, 500), MON))
                .as("계좌1 계산이면 출발 주문까지 넷").isEqualTo(4);
    }
}
