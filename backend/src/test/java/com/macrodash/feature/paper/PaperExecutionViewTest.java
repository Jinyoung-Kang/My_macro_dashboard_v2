package com.macrodash.feature.paper;

import com.macrodash.analytics.ExecutionTiming;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.ExecutionAuditFixtures.claudeOrder;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.et;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.observationFill;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * GET /api/paper/books/{code}/execution 응답({@link ExecutionView} — 명세 2026-10-30 §13-1·§14-2): 미국 Claude 계좌 밖 코드는 400, 테이블이 없으면
 * available:false, 주문은 감사 행이 있는 결정 주문만 최근 순·limit, NEXT_OPEN은 isProxy, 차이 bp, 요약은 문턱 아래 null·뺀 수, 같은 자료면 같은 구간.
 * 고른 시점(M1 — 주 판정)은 계좌2만: 체결 원가격 대비 계좌1식, 대체 체결은 따로, 기준 없는 체결·체결 없는 주문은 뺀 수, 메뉴 줄과 같은 문턱·부트스트랩.
 */
class PaperExecutionViewTest {

    private FakePaperStore store;
    private PaperQueryService query;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        PaperMarketData marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        when(marketData.quotes(market(UsPaperMarket.INSTANCE))).thenReturn(Optional.empty());
        query = new PaperQueryService(store, marketData, PaperFixtures.quietReader(), PaperFixtures.settings(store),
                PaperFixtures.config(), Clock.fixed(Instant.parse("2026-11-20T12:00:00Z"), ZoneOffset.UTC));
        activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
    }

    /** 결정일 asOf의 주문 하나 + 계좌1식 체결(원가격 base) + 감사 행(시가 open, 10:00 ten — null이면 그 시점 없음). */
    private long audited(LocalDate asOf, String side, double base, Double open, Double ten, int qty) {
        Instant created = et(asOf, 18, 31);
        long id = store.insertOrder(claudeOrder("AAPL", side, "NEXT_OBSERVATION", "FILLED", asOf, created));
        LocalDate session = UsPaperMarket.INSTANCE.calendar().nextTradingDay(asOf);
        store.insertFill(observationFill(id, "AAPL", side, qty, base, et(session, 9, 57), session));
        ObjectNode cf = MAPPER.createObjectNode();
        for (String timing : ExecutionAudit.TIMINGS) {
            cf.putNull(timing);
        }
        cf.set("NEXT_OBSERVATION", price(base, et(session, 9, 57), "QUOTES_OBSERVATION"));
        if (open != null) {
            cf.set("NEXT_OPEN", price(open, et(session, 9, 30), "Y1M_AT"));
        }
        if (ten != null) {
            cf.set("AT_1000", price(ten, et(session, 10, 1), "Y1M_NEXT"));
        }
        store.mergeOrderExec(new OrderExec(id, PaperBooks.CLAUDE, "NEXT_OBSERVATION", null, cf, 75, null, null));
        return id;
    }

    private static ObjectNode price(double raw, Instant at, String rung) {
        return MAPPER.createObjectNode().put("raw", raw).put("at", at.toString()).put("rung", rung);
    }

    /**
     * 계좌2 결정 주문 하나 — 체결 원가격 {@code fillRaw}(null이면 체결 없음 — 만료), 사다리 칸 {@code rung}(null이면 칸 없는 관측치 체결 — NEXT_CLOSE),
     * 감사 행의 계좌1식 기준 {@code base}(null이면 관측치 사슬로 증명하지 못함). 메뉴 반사실은 비워 둡니다 — M1은 체결 원가격만 씁니다.
     */
    private long book2(LocalDate asOf, String side, String timing, Double base, Double fillRaw, String rung, int qty) {
        LocalDate session = UsPaperMarket.INSTANCE.calendar().nextTradingDay(asOf);
        boolean buy = PaperBooks.BUY.equals(side);
        long id = store.insertOrder(new Order(0, PaperBooks.CLAUDE2, 1L, "AAPL", side, null, buy ? 5.0 : null,
                buy ? null : 0.5, timing, "CLAUDE", fillRaw == null ? "EXPIRED" : "FILLED", null, null, asOf,
                et(asOf, 18, 31), session, null));
        if (fillRaw != null) {
            double fillPrice = buy ? fillRaw * 1.0005 : fillRaw * 0.9995;
            Fill fill = new Fill(0, id, PaperBooks.CLAUDE2, "AAPL", side, qty, fillPrice, fillRaw, 5, qty * fillPrice,
                    et(session, 10, 57), session, rung == null ? PaperBooks.SOURCE_QUOTES : Datasets.SNAP_PAPER_BARS_US,
                    false, null);
            if (rung == null) {
                store.insertFill(fill);
            } else {
                store.insertTimedFill(fill, rung.startsWith("Y1M") ? et(session, 10, 0) : null, rung);
            }
        }
        ObjectNode cf = MAPPER.createObjectNode();
        ExecutionAudit.TIMINGS.forEach(cf::putNull);
        if (base != null) {
            cf.set("NEXT_OBSERVATION", price(base, et(session, 9, 57), "QUOTES_OBSERVATION"));
        }
        store.mergeOrderExec(new OrderExec(id, PaperBooks.CLAUDE2, timing, null, cf, null, null, null));
        return id;
    }

    /** 계좌2 M1 표본 하나의 기대값 — 체결 금액(슬리피지 얹은 체결가 × 수량) 가중, 차이는 원가격 대 계좌1식 기준. */
    private static ExecutionTiming.Sample expected(LocalDate asOf, long id, String side, double base, double raw, int qty) {
        boolean buy = PaperBooks.BUY.equals(side);
        double gross = qty * (buy ? raw * 1.0005 : raw * 0.9995);
        return new ExecutionTiming.Sample(asOf, id, gross, ExecutionTiming.advantageBp(buy ? 1 : -1, base, raw));
    }

    @Test
    @DisplayName("미국 Claude 계좌가 아닌 코드는 400(규칙·벤치마크·한국·없는 코드), 테이블이 없으면 available:false, 초기화 전 claude는 없는 계좌 400")
    void onlyUsClaudeBooks() {
        activeBook(store, PaperBooks.BENCH_SPY, PaperBooks.KIND_BENCHMARK, 100_000, null);
        for (String code : List.of(PaperBooks.RULES, PaperBooks.BENCH_SPY, PaperBooks.KR_CLAUDE, "nope")) {
            assertThatThrownBy(() -> query.execution(code, 50)).as(code).isInstanceOf(InvalidRequestException.class)
                    .hasMessageContaining("실행 감사는 미국 Claude 계좌만 있습니다").hasMessageContaining("(claude · claude2)");
        }
        // 계좌2(ADR 0022 — 정의 1-5)는 감사 대상이고, 그 계좌 행이 없으면(초기화 전) 다른 계좌 코드 경로처럼 '없는 계좌'.
        assertThatThrownBy(() -> query.execution(PaperBooks.CLAUDE2, 50)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("없는 계좌");
        activeBook(store, PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, 100_000, null);
        assertThat(query.execution(PaperBooks.CLAUDE2, 50)).containsEntry("book", PaperBooks.CLAUDE2)
                .containsEntry("orders", List.of());
        store.ready = false;
        assertThat(query.execution("nope", 50)).containsEntry("available", false);
        store.ready = true;
        store.books.remove(PaperBooks.CLAUDE);
        assertThatThrownBy(() -> query.execution(PaperBooks.CLAUDE, 50)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("없는 계좌");
    }

    @Test
    @DisplayName("주문 줄: 감사 행이 있는 결정 주문만 최근 순·limit, 반사실(원가격·시각·칸·NEXT_OPEN만 isProxy), 차이 bp(없으면 null), 체결 원가격·체결가, 지연, 계좌1은 실행 메모·늦게 풂 null")
    void orderRows() {
        long older = audited(LocalDate.of(2026, 11, 2), PaperBooks.BUY, 100.0, 99.0, null, 10);
        long newer = audited(LocalDate.of(2026, 11, 3), PaperBooks.SELL, 100.0, 101.0, 99.5, 10);
        store.insertOrder(claudeOrder("MSFT", PaperBooks.BUY, "NEXT_OBSERVATION", "PENDING", LocalDate.of(2026, 11, 4),
                et(LocalDate.of(2026, 11, 4), 18, 31)));   // 감사 행 없음 — 줄에 없음

        Map<String, Object> all = query.execution(PaperBooks.CLAUDE, 50);
        JsonNode body = MAPPER.valueToTree(all);
        assertThat(body.path("available").asBoolean()).isTrue();
        assertThat(body.path("book").asString()).isEqualTo("claude");
        assertThat(body.path("timings")).extracting(JsonNode::asString).containsExactlyElementsOf(ExecutionAudit.TIMINGS);
        assertThat(body.path("orders")).extracting(row -> row.path("orderId").asLong()).containsExactly(newer, older);

        JsonNode row = body.path("orders").get(0);
        assertThat(row.path("side").asString()).isEqualTo("SELL");
        assertThat(row.path("asOfTradingDate").asString()).isEqualTo("2026-11-03");
        assertThat(row.path("targetSession").asString()).isEqualTo("2026-11-04");
        assertThat(row.path("targetAtKst").isNull()).as("계좌1식 — 정해진 시각 없음").isTrue();
        assertThat(row.path("fill").path("rawPrice").asDouble()).isEqualTo(100.0);
        assertThat(row.path("fill").path("price").asDouble()).isEqualTo(99.95);
        assertThat(row.path("fill").path("barAtKst").isNull()).isTrue();
        assertThat(row.path("cf").path("NEXT_OPEN").path("raw").asDouble()).isEqualTo(101.0);
        assertThat(row.path("cf").path("NEXT_OPEN").path("isProxy").asBoolean()).isTrue();
        assertThat(row.path("cf").path("NEXT_OPEN").path("atKst").asString()).isEqualTo("2026-11-04 23:30 KST");
        assertThat(row.path("cf").path("AT_1000").path("isProxy").asBoolean(true)).isFalse();
        assertThat(row.path("cf").path("AT_1100").isNull()).isTrue();
        assertThat(row.path("advantageBp").path("NEXT_OPEN").asDouble()).as("매도 — 101에 팔면 100보다 +100bp").isEqualTo(100.0);
        assertThat(row.path("advantageBp").path("AT_1000").asDouble()).isEqualTo(-50.0);
        assertThat(row.path("advantageBp").path("NEXT_CLOSE").isNull()).isTrue();
        assertThat(row.path("advantageBp").has("NEXT_OBSERVATION")).as("기준 자신은 칸 없음").isFalse();
        assertThat(row.path("lagSeconds").asInt()).isEqualTo(75);
        assertThat(row.path("lateResolved").isNull()).isTrue();
        assertThat(row.path("executionNote").isNull()).isTrue();

        JsonNode limited = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE, 1));
        assertThat(limited.path("orders")).hasSize(1);
        assertThat(limited.path("summary").path("audited").asInt()).as("요약은 limit과 상관없이 전부").isEqualTo(2);
        assertThat(MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE, 0)).path("limit").asInt()).as("1~500으로 접음")
                .isEqualTo(1);
    }

    @Test
    @DisplayName("요약: 주문 10건 미만·결정일 5일 미만이면 평균·구간 null(0 아님)과 수, 기준이 없거나 그 시점 값이 없으면 따로 셈")
    void summaryNullsUnderThresholds() {
        LocalDate day = LocalDate.of(2026, 11, 2);
        for (int i = 0; i < 9; i++) {
            audited(day.plusDays(i % 3 == 2 ? 0 : i % 3), PaperBooks.BUY, 100.0, 99.0, null, 10);
        }
        long noBaseline = store.insertOrder(claudeOrder("NVDA", PaperBooks.BUY, "NEXT_CLOSE", "FILLED", day, et(day, 18, 31)));
        ObjectNode cf = MAPPER.createObjectNode();
        ExecutionAudit.TIMINGS.forEach(cf::putNull);
        store.mergeOrderExec(new OrderExec(noBaseline, PaperBooks.CLAUDE, "NEXT_CLOSE", null, cf, null, null, null));

        JsonNode timings = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE, 50)).path("summary").path("timings");
        assertThat(timings).extracting(t -> t.path("timing").asString())
                .containsExactly("NEXT_OPEN", "AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400", "AT_1500", "NEXT_CLOSE");
        JsonNode open = timings.get(0);
        assertThat(open.path("n").asInt()).isEqualTo(9);
        assertThat(open.path("days").asInt()).isEqualTo(2);
        assertThat(open.path("excludedNoBaseline").asInt()).isEqualTo(1);
        assertThat(open.path("excludedNoPrice").asInt()).isZero();
        assertThat(open.path("meanBp").isNull()).isTrue();
        assertThat(open.path("lowBp").isNull()).isTrue();
        assertThat(open.path("highBp").isNull()).isTrue();
        assertThat(open.path("isProxy").asBoolean()).isTrue();
        JsonNode ten = timings.get(1);
        assertThat(ten.path("n").asInt()).isZero();
        assertThat(ten.path("excludedNoPrice").asInt()).isEqualTo(9);
        assertThat(ten.path("isProxy").asBoolean(true)).isFalse();
    }

    @Test
    @DisplayName("요약: 주문 10건·결정일 5일 이상이면 금액 가중 평균과 90% 구간 — 같은 자료면 두 번 불러도 같은 구간")
    void summaryWithEnoughOrdersIsDeterministic() {
        double[] opens = {99.0, 99.5, 100.2, 98.8, 100.5, 99.9, 99.1, 100.8, 99.4, 100.1, 98.9, 99.7};
        for (int i = 0; i < opens.length; i++) {
            LocalDate asOf = UsPaperMarket.INSTANCE.calendar().addTradingDays(LocalDate.of(2026, 11, 2), i / 2);
            audited(asOf, PaperBooks.BUY, 100.0, opens[i], null, 10 + i);
        }
        JsonNode first = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE, 50)).path("summary");
        JsonNode second = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE, 50)).path("summary");
        assertThat(second).isEqualTo(first);
        JsonNode open = first.path("timings").get(0);
        assertThat(open.path("n").asInt()).isEqualTo(12);
        assertThat(open.path("days").asInt()).isEqualTo(6);
        double weighted = 0;
        double weight = 0;
        for (int i = 0; i < opens.length; i++) {
            double gross = (10 + i) * 100.0 * 1.0005;
            weighted += gross * (100.0 - opens[i]) / 100.0 * 10_000;
            weight += gross;
        }
        assertThat(open.path("meanBp").asDouble()).isCloseTo(weighted / weight, within(0.01));
        assertThat(open.path("lowBp").asDouble()).isLessThanOrEqualTo(open.path("meanBp").asDouble());
        assertThat(open.path("highBp").asDouble()).isGreaterThanOrEqualTo(open.path("meanBp").asDouble());
        assertThat(first.path("minOrders").asInt()).isEqualTo(10);
        assertThat(first.path("minDays").asInt()).isEqualTo(5);
        assertThat(first.path("interval").path("resamples").asInt()).isEqualTo(2000);
        assertThat(first.path("baseline").asString()).isEqualTo("NEXT_OBSERVATION");
    }

    @Test
    @DisplayName("고른 시점(M1): 계좌2만(계좌1은 null) — 체결된 주문의 체결 원가격 대 계좌1식, 대체 체결은 따로, 기준 없는 체결·체결 없는 주문은 뺀 수")
    void chosenSeparatesFallbackFills() {
        activeBook(store, PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, 100_000, null);
        audited(LocalDate.of(2026, 11, 2), PaperBooks.BUY, 100.0, 99.0, null, 10);   // 계좌1 주문 — 계좌2 요약에 섞이지 않음
        LocalDate mon = LocalDate.of(2026, 11, 2);
        LocalDate tue = LocalDate.of(2026, 11, 3);
        book2(mon, PaperBooks.BUY, PaperBooks.NEXT_OPEN, 100.0, 99.0, "Y1M_AT", 10);
        book2(mon, PaperBooks.SELL, PaperBooks.AT_1000, 100.0, 101.0, "Y1M_NEXT", 10);
        book2(tue, PaperBooks.BUY, PaperBooks.NEXT_CLOSE, 100.0, 100.5, null, 10);   // 칸 없는 종가 체결 — 본 줄
        book2(tue, PaperBooks.BUY, PaperBooks.AT_1100, null, 99.0, "Y1M_AT", 10);    // 계좌1식 기준 없음 — 뺀 수
        book2(mon, PaperBooks.BUY, PaperBooks.AT_1200, 100.0, 98.0, "Y1M_LATE", 10);
        book2(mon, PaperBooks.BUY, PaperBooks.AT_1300, 100.0, 98.0, "QUOTES_FALLBACK", 10);
        book2(tue, PaperBooks.SELL, PaperBooks.AT_1400, 100.0, 102.0, "QUOTES_CLOSE", 10);
        book2(tue, PaperBooks.BUY, PaperBooks.AT_1500, null, 98.0, "Y1M_LATE", 10);  // 대체 체결 + 기준 없음
        book2(mon, PaperBooks.BUY, PaperBooks.AT_1000, 100.0, null, null, 10);       // 체결 없음(만료)

        JsonNode book1 = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE, 50)).path("summary");
        assertThat(book1.has("chosen")).as("칸은 있음").isTrue();
        assertThat(book1.path("chosen").isNull()).as("계좌1 — 고른 시점이 곧 계좌1식 기준").isTrue();

        JsonNode summary = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE2, 50)).path("summary");
        assertThat(summary.path("audited").asInt()).isEqualTo(9);
        JsonNode chosen = summary.path("chosen");
        assertThat(chosen.path("formula").asString()).contains("P_체결").contains("슬리피지 전");
        assertThat(chosen.path("n").asInt()).isEqualTo(3);
        assertThat(chosen.path("days").asInt()).isEqualTo(2);
        assertThat(chosen.path("excludedNoBaseline").asInt()).isEqualTo(1);
        assertThat(chosen.path("excludedFallback").asInt()).as("대체 체결 넷(기준 없는 하나 포함)").isEqualTo(4);
        assertThat(chosen.path("notFilled").asInt()).isEqualTo(1);
        assertThat(chosen.path("meanBp").isNull()).as("주문 3건 — 문턱 아래, 0이 아님").isTrue();
        assertThat(chosen.path("lowBp").isNull()).isTrue();
        assertThat(chosen.path("highBp").isNull()).isTrue();
        assertThat(chosen.path("isProxy").asBoolean()).as("시가 체결가는 1분봉 첫 봉 시가").isTrue();
        JsonNode fallback = chosen.path("fallback");
        assertThat(fallback.path("n").asInt()).isEqualTo(3);
        assertThat(fallback.path("days").asInt()).isEqualTo(2);
        assertThat(fallback.path("excludedNoBaseline").asInt()).isEqualTo(1);
        assertThat(chosen.path("excludedFallback").asInt())
                .isEqualTo(fallback.path("n").asInt() + fallback.path("excludedNoBaseline").asInt());
        assertThat(fallback.path("meanBp").isNull()).isTrue();
        assertThat(fallback.path("isProxy").asBoolean(true)).isFalse();
        // 메뉴 줄(반사실 분포)은 그대로 — 계좌1식 기준이 없는 주문만 따로, 메뉴 반사실을 비운 계좌2 주문은 값 없음.
        JsonNode open = summary.path("timings").get(0);
        assertThat(open.path("excludedNoBaseline").asInt()).isEqualTo(3);
        assertThat(open.path("excludedNoPrice").asInt()).isEqualTo(6);
    }

    @Test
    @DisplayName("고른 시점(M1) 본 줄의 isProxy는 본 줄에 센 시가 체결(R1·R2 — 1분봉 첫 봉 시가)이 있을 때만: 시가 주문이 대체 체결(R2b·R3)로만 풀렸으면 본 줄도 대체 체결 줄도 거짓")
    void chosenProxyOnlyForPrimaryOpenFills() {
        activeBook(store, PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, 100_000, null);
        LocalDate mon = LocalDate.of(2026, 11, 2);
        book2(mon, PaperBooks.BUY, PaperBooks.AT_1000, 100.0, 99.0, "Y1M_AT", 10);
        book2(mon, PaperBooks.BUY, PaperBooks.NEXT_OPEN, 100.0, 98.0, "Y1M_LATE", 10);         // 시가 주문 — T 뒤 첫 거래 봉(대체)
        book2(mon, PaperBooks.SELL, PaperBooks.NEXT_OPEN, 100.0, 101.0, "QUOTES_FALLBACK", 10); // 시가 주문 — 관측 종가(대체)

        JsonNode late = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE2, 50)).path("summary").path("chosen");
        assertThat(late.path("n").asInt()).isEqualTo(1);
        assertThat(late.path("excludedFallback").asInt()).isEqualTo(2);
        assertThat(late.path("isProxy").asBoolean(true)).as("본 줄에 시가 체결 없음 — 시가 주문은 대체 체결로만 풂").isFalse();
        assertThat(late.path("fallback").path("isProxy").asBoolean(true)).as("대체 체결의 늦은 봉·종가는 시가를 대신하지 않음")
                .isFalse();

        book2(mon, PaperBooks.BUY, PaperBooks.NEXT_OPEN, 100.0, 99.5, "Y1M_NEXT", 10);         // 시가 주문 — R2(09:31~09:34 첫 거래 봉)
        JsonNode primary = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE2, 50)).path("summary").path("chosen");
        assertThat(primary.path("n").asInt()).isEqualTo(2);
        assertThat(primary.path("isProxy").asBoolean()).as("본 줄에 센 시가 체결").isTrue();
        assertThat(primary.path("fallback").path("isProxy").asBoolean(true)).isFalse();
    }

    @Test
    @DisplayName("고른 시점(M1): 대체 체결을 뺀 주문 10건·결정일 5일부터 금액 가중 평균·90% 구간 — 메뉴 줄과 같은 부트스트랩, 같은 자료면 같은 구간")
    void chosenWithEnoughFillsUsesTheSameBootstrap() {
        activeBook(store, PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, 100_000, null);
        double[] raws = {99.0, 100.4, 100.2, 98.8, 99.5, 101.1, 99.1, 100.8, 99.4, 100.1, 98.9, 99.7};
        List<ExecutionTiming.Sample> samples = new ArrayList<>();
        for (int i = 0; i < raws.length; i++) {
            LocalDate asOf = UsPaperMarket.INSTANCE.calendar().addTradingDays(LocalDate.of(2026, 11, 2), i / 2);
            String side = i % 3 == 0 ? PaperBooks.SELL : PaperBooks.BUY;
            long id = book2(asOf, side, PaperBooks.AT_1000, 100.0, raws[i], i % 2 == 0 ? "Y1M_AT" : "Y1M_NEXT", 10 + i);
            samples.add(expected(asOf, id, side, 100.0, raws[i], 10 + i));
        }
        // 대체 체결 셋 — 본 줄에 들면 평균이 크게 움직이는 값(90 → +1,000bp)이지만 본 줄의 수·평균에 들지 않음.
        LocalDate later = UsPaperMarket.INSTANCE.calendar().addTradingDays(LocalDate.of(2026, 11, 2), 7);
        for (String rung : List.of("Y1M_LATE", "QUOTES_FALLBACK", "QUOTES_CLOSE")) {
            book2(later, PaperBooks.BUY, PaperBooks.AT_1100, 100.0, 90.0, rung, 50);
        }

        JsonNode first = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE2, 50)).path("summary").path("chosen");
        JsonNode second = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE2, 50)).path("summary").path("chosen");
        assertThat(second).isEqualTo(first);
        ExecutionTiming.Summary want = ExecutionTiming.summarize(samples);
        assertThat(first.path("n").asInt()).isEqualTo(12);
        assertThat(first.path("days").asInt()).isEqualTo(6);
        assertThat(first.path("excludedFallback").asInt()).isEqualTo(3);
        assertThat(first.path("meanBp").asDouble()).isCloseTo(want.meanBp(), within(0.005));
        assertThat(first.path("lowBp").asDouble()).isEqualTo(PaperQueryService.round2(want.lowBp()));
        assertThat(first.path("highBp").asDouble()).isEqualTo(PaperQueryService.round2(want.highBp()));
        assertThat(first.path("lowBp").asDouble()).isLessThanOrEqualTo(first.path("meanBp").asDouble());
        assertThat(first.path("highBp").asDouble()).isGreaterThanOrEqualTo(first.path("meanBp").asDouble());
        assertThat(first.path("isProxy").asBoolean(true)).as("시가 체결 없음").isFalse();
        double weighted = 0;
        double weight = 0;
        for (ExecutionTiming.Sample sample : samples) {
            weighted += sample.weight() * sample.bp();
            weight += sample.weight();
        }
        assertThat(first.path("meanBp").asDouble()).as("체결 금액 가중 평균").isCloseTo(weighted / weight, within(0.005));
        assertThat(first.path("fallback").path("n").asInt()).isEqualTo(3);
        assertThat(first.path("fallback").path("days").asInt()).isEqualTo(1);
        assertThat(first.path("fallback").path("meanBp").isNull()).as("대체 체결 셋 — 문턱 아래").isTrue();
    }

    @Test
    @DisplayName("고른 시점(M1) 문턱: 대체 체결을 뺀 주문 9건이면 null, 10건·결정일 5일이면 값 — 대체 체결은 수에도 결정일에도 세지 않음")
    void chosenThresholdsCountOnlyPrimaryFills() {
        activeBook(store, PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, 100_000, null);
        LocalDate start = LocalDate.of(2026, 11, 2);
        for (int i = 0; i < 9; i++) {
            LocalDate asOf = UsPaperMarket.INSTANCE.calendar().addTradingDays(start, i % 4);   // 결정일 넷
            book2(asOf, PaperBooks.BUY, PaperBooks.AT_1200, 100.0, 99.0 + i * 0.1, "Y1M_AT", 10);
        }
        LocalDate fifth = UsPaperMarket.INSTANCE.calendar().addTradingDays(start, 4);
        book2(fifth, PaperBooks.BUY, PaperBooks.AT_1200, 100.0, 99.0, "Y1M_LATE", 10);
        book2(fifth, PaperBooks.BUY, PaperBooks.AT_1300, 100.0, 99.0, "QUOTES_FALLBACK", 10);

        JsonNode below = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE2, 50)).path("summary").path("chosen");
        assertThat(below.path("n").asInt()).as("대체 체결 둘은 N에 세지 않음").isEqualTo(9);
        assertThat(below.path("days").asInt()).as("대체 체결만 있는 다섯째 날은 결정일에 세지 않음").isEqualTo(4);
        assertThat(below.path("meanBp").isNull()).isTrue();

        book2(fifth, PaperBooks.BUY, PaperBooks.AT_1400, 100.0, 99.5, "Y1M_NEXT", 10);
        JsonNode enough = MAPPER.valueToTree(query.execution(PaperBooks.CLAUDE2, 50)).path("summary").path("chosen");
        assertThat(enough.path("n").asInt()).isEqualTo(10);
        assertThat(enough.path("days").asInt()).isEqualTo(5);
        assertThat(enough.path("meanBp").isNumber()).isTrue();
        assertThat(enough.path("lowBp").isNumber()).isTrue();
        assertThat(enough.path("highBp").isNumber()).isTrue();
    }
}
