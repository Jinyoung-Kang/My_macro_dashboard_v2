package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperMarketData.SourcedClose;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_FINAL;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static com.macrodash.feature.paper.PaperFixtures.staleBar;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 화면 응답 — 준비 전·초기화 전·책 요약·보유 표의 모양과 숫자.
 */
class PaperQueryServiceTest {

    private static final Clock NOW = Clock.fixed(Instant.parse("2026-10-26T21:00:00Z"), ZoneOffset.UTC);

    private FakePaperStore store;
    private PaperMarketData marketData;
    private PaperQueryService query;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        when(marketData.sourcedCloseOn(anyString(), any())).thenReturn(Optional.empty());
        when(marketData.quotes(UsPaperMarket.INSTANCE)).thenReturn(Optional.empty());
        query = new PaperQueryService(store, marketData, PaperFixtures.quietReader(), PaperFixtures.settings(store),
                PaperFixtures.config(), NOW);
    }

    private void initWithBenchmarks() {
        when(marketData.sourcedCloseOn("SPY", FRI)).thenReturn(Optional.of(new SourcedClose(500, "equity_close")));
        when(marketData.sourcedCloseOn("SHY", FRI)).thenReturn(Optional.of(new SourcedClose(82.5, "equity_close")));
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.settings(store),
                PaperFixtures.MAPPER);
        new PaperAdminService(store, marketData, PaperFixtures.quietReader(), PaperFixtures.settings(store), ledger,
                PaperFixtures.config(), PaperFixtures.MAPPER, NOW).init();
    }

    @Test
    @DisplayName("테이블이 없으면 모든 응답이 available:false와 안내 문구")
    void notReady() {
        store.ready = false;
        for (Map<String, Object> body : List.of(query.overview(), query.positions("rules"), query.orders("rules", 50),
                query.fills("rules", 50), query.nav("rules"))) {
            assertThat(body.get("available")).isEqualTo(false);
            assertThat((String) body.get("message")).contains("V8").contains("V9").contains("make up");
        }
        Map<String, Object> status = query.status();
        assertThat(status.get("schemaReady")).isEqualTo(false);
        assertThat(status.get("enabled")).isEqualTo(true);
    }

    @Test
    @DisplayName("초기화 전: available:true, initialized:false, 책 없음, 한계 문구 여덟 줄")
    void beforeInit() {
        Map<String, Object> overview = query.overview();

        assertThat(overview.get("available")).isEqualTo(true);
        assertThat(overview.get("initialized")).isEqualTo(false);
        assertThat(overview.get("pendingBackfill")).isEqualTo(List.of());
        assertThat(overview.get("startDate")).isEqualTo("2026-10-23");
        assertThat((List<?>) overview.get("books")).isEmpty();
        assertThat(overview.get("quotes")).isNull();
        @SuppressWarnings("unchecked")
        List<String> limits = (List<String>) overview.get("limits");
        assertThat(limits).hasSize(8);
        assertThat(limits.get(0)).isEqualTo("모의 매매입니다. 어떤 주문도 밖으로 나가지 않습니다.");
        assertThat(limits.get(3)).isEqualTo("2026-10-23 체결은 사후 체결입니다.");
        assertThat(query.status().get("settingsVersion")).isNull();
        assertThatThrownBy(() -> query.positions("rules")).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("개요: 정의 순서의 네 책, 순자산 곡선(같은 길이·없는 날 null), 시작 전 책은 수익률·통계 null")
    @SuppressWarnings("unchecked")
    void overviewAfterInit() {
        initWithBenchmarks();
        store.upsertNav(new NavRow("bench_spy", MON, 101_000, 450.25, 100_549.75, 99.55, true));
        when(marketData.quotes(UsPaperMarket.INSTANCE)).thenReturn(Optional.of(quotes(MON_FINAL,
                bar("SPY", FRI, 500, MON, 505), staleBar("QQQ", FRI, 400))));

        Map<String, Object> overview = query.overview();

        assertThat(overview.get("initialized")).isEqualTo(true);
        assertThat(overview.get("pendingBackfill")).as("벤치마크 둘 다 사후 체결함").isEqualTo(List.of());
        List<Map<String, Object>> books = (List<Map<String, Object>>) overview.get("books");
        assertThat(books).extracting(b -> b.get("code")).containsExactly("rules", "claude", "bench_spy", "bench_mix");
        Map<String, Object> rules = books.get(0);
        assertThat(rules.get("status")).isEqualTo("NOT_STARTED");
        assertThat(rules.get("returnPct")).isNull();
        assertThat(rules.get("stats")).isNull();
        assertThat(rules.get("nav")).isEqualTo(100_000.0);
        assertThat(rules.get("benchmark")).isEqualTo("bench_spy");
        Map<String, Object> spy = books.get(2);
        assertThat(spy.get("benchmark")).isNull();
        assertThat(spy.get("cash")).isEqualTo(450.25);
        assertThat(spy.get("returnPct")).as("상태의 순자산 99,950.25 기준").isEqualTo(-0.05);
        assertThat(spy.get("positions")).isEqualTo(1);
        assertThat(spy.get("staleCount")).isEqualTo(0);
        Map<String, Object> stats = (Map<String, Object>) spy.get("stats");
        assertThat(stats.get("sampleDays")).isEqualTo(1);
        assertThat(stats.get("cumReturnPct")).isEqualTo(1.05);   // 99,950.25 → 101,000
        assertThat(stats.get("cagrPct")).as("표본 20일 미만").isNull();

        Map<String, Object> nav = (Map<String, Object>) overview.get("navSeries");
        assertThat((List<String>) nav.get("dates")).containsExactly("2026-10-23", "2026-10-26");
        Map<String, List<Double>> series = (Map<String, List<Double>>) nav.get("books");
        assertThat(series.get("bench_spy")).containsExactly(99_950.25, 101_000.0);
        assertThat(series.get("bench_mix")).containsExactly(99_950.29, null);   // 520.285 + 119 × 500 + 484 × 82.5
        assertThat(series.get("rules")).containsExactly(null, null);

        Map<String, Object> quotes = (Map<String, Object>) overview.get("quotes");
        assertThat(quotes.get("barDate")).isEqualTo("2026-10-26");
        assertThat(quotes.get("finalClose")).isEqualTo(true);
        assertThat(quotes.get("tickers")).isEqualTo(2);
        assertThat(quotes.get("staleTickers")).isEqualTo(List.of("QQQ"));
        assertThat(quotes.get("ageSeconds")).isEqualTo(40L * 60);
        assertThat(quotes.get("stale")).isEqualTo(false);
        assertThat(quotes.get("collectedAtKst")).isEqualTo("2026-10-27 05:20 KST");
    }

    @Test
    @DisplayName("종가를 받기 전에 초기화했으면 initialized는 true여도 pendingBackfill에 벤치마크가 남고, 다시 초기화하면 빈다")
    void pendingBackfillUntilBenchmarksStart() {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.settings(store),
                PaperFixtures.MAPPER);
        PaperAdminService admin = new PaperAdminService(store, marketData, PaperFixtures.quietReader(),
                PaperFixtures.settings(store), ledger, PaperFixtures.config(), PaperFixtures.MAPPER, NOW);
        admin.init();   // 종가 없음 — 벤치마크는 시작 전으로 남음

        Map<String, Object> before = query.overview();
        assertThat(before.get("initialized")).isEqualTo(true);
        assertThat(before.get("pendingBackfill")).isEqualTo(List.of("bench_spy", "bench_mix"));

        when(marketData.sourcedCloseOn("SPY", FRI)).thenReturn(Optional.of(new SourcedClose(500, "equity_close")));
        admin.init();   // SHY는 아직 없음 — SPY 100%만 시작
        assertThat(query.overview().get("pendingBackfill")).isEqualTo(List.of("bench_mix"));

        when(marketData.sourcedCloseOn("SHY", FRI)).thenReturn(Optional.of(new SourcedClose(82.5, "equity_close")));
        admin.init();
        assertThat(query.overview().get("pendingBackfill")).isEqualTo(List.of());
    }

    @Test
    @DisplayName("보유 표: 평가액·비중·스탑가(벤치마크·현금성은 null)·사후 체결 배지, 주문·체결 목록, limit은 1–500으로 접음")
    @SuppressWarnings("unchecked")
    void positionsAndLists() {
        initWithBenchmarks();
        store.books.put("claude", new com.macrodash.store.PaperStore.Book("claude", "CLAUDE", "Claude 재량 책", 100_000,
                FRI, "ACTIVE", PaperFixtures.FRI_CLOSE));
        store.states.put("claude", new com.macrodash.store.PaperStore.BookState("claude", 1_000, 3_000, 2_000, 66.6667,
                MON_FINAL, MON_FINAL, MON, null));
        PaperFixtures.position(store, "claude", "AAA", 10, 100, 110, 100.0, FRI, 100);
        PaperFixtures.position(store, "claude", "SHY", 10, 100, 100, null, FRI, 100);

        Map<String, Object> claude = query.positions("claude");
        List<Map<String, Object>> rows = (List<Map<String, Object>>) claude.get("positions");
        Map<String, Object> aaa = rows.get(0);
        assertThat(aaa.get("ticker")).isEqualTo("AAA");
        assertThat(aaa.get("marketValue")).isEqualTo(1_000.0);
        assertThat(aaa.get("weightPct")).isEqualTo(33.33);
        assertThat(aaa.get("stopPrice")).isEqualTo(101.2);          // 110 × 0.92
        assertThat(aaa.get("stopDistancePct")).isEqualTo(-1.19);    // 100 / 101.2 − 1
        assertThat(aaa.get("unrealizedPct")).isEqualTo(0.0);
        assertThat(aaa.get("holdingTradingDays")).isEqualTo(1);    // 금 → 월
        assertThat(aaa.get("backfilled")).isEqualTo(false);
        Map<String, Object> shy = rows.get(1);
        assertThat(shy.get("cashLike")).isEqualTo(true);
        assertThat(shy.get("stopPrice")).isNull();
        assertThat(shy.get("lastPrice")).isNull();
        assertThat(shy.get("priceStale")).as("가격을 한 번도 못 받음").isEqualTo(true);
        assertThat(shy.get("marketValue")).as("평단으로 평가").isEqualTo(1_000.0);
        assertThat(claude.get("cash")).isEqualTo(1_000.0);

        Map<String, Object> spy = query.positions("bench_spy");
        Map<String, Object> spyRow = ((List<Map<String, Object>>) spy.get("positions")).get(0);
        assertThat(spyRow.get("stopPrice")).as("벤치마크는 스탑 없음").isNull();
        assertThat(spyRow.get("backfilled")).isEqualTo(true);

        List<Map<String, Object>> fills = (List<Map<String, Object>>) query.fills("bench_mix", 0).get("fills");
        assertThat(fills).hasSize(1);   // limit 0 → 1
        assertThat(fills.get(0).get("observedAtKst")).isEqualTo("2026-10-24 05:00 KST");
        assertThat(fills.get(0).get("backfill")).isEqualTo(true);
        List<Map<String, Object>> orders = (List<Map<String, Object>>) query.orders("bench_mix", 9_999).get("orders");
        assertThat(orders).hasSize(2);
        assertThat(orders.get(0).get("asOfTradingDate")).isEqualTo("2026-10-22");
        assertThat(orders.get(0).get("timing")).isEqualTo("BACKFILL");

        Map<String, Object> nav = query.nav("bench_spy");
        assertThat((List<?>) nav.get("series")).hasSize(1);
        assertThat(((Map<String, Object>) nav.get("book")).get("code")).isEqualTo("bench_spy");

        assertThatThrownBy(() -> query.orders("nope", 50)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("없는 계좌");
        assertThat(query.status().get("settingsVersion")).isEqualTo(1);
    }

    @Test
    @DisplayName("개요의 게이트 지표는 가장 최근 거래일 줄(참고 문구 포함), 결정 목록·상세는 요약·주문 수·주문 행 — 없는 결정·책은 400")
    void gateAndDecisions() {
        initWithBenchmarks();
        assertThat(query.overview().get("gate")).as("기록 전").isNull();
        var mapper = PaperFixtures.MAPPER;
        store.insertGateIfAbsent(new com.macrodash.store.PaperStore.GateRow(FRI, mapper.valueToTree(Map.of(
                "us10y", Map.of("value", 4.5, "source", "macro.collected"), "conditions", Map.of("G1", true))), "L1",
                mapper.valueToTree(Map.of("G1", 3)), null));
        store.insertGateIfAbsent(new com.macrodash.store.PaperStore.GateRow(MON, mapper.valueToTree(Map.of(
                "us10y", Map.of("value", 4.9, "source", "macro.collected"), "conditions", Map.of("G1", false))), "L0",
                mapper.valueToTree(Map.of("G1", 0)), null));

        @SuppressWarnings("unchecked")
        Map<String, Object> gate = (Map<String, Object>) query.overview().get("gate");
        assertThat(gate.get("tradingDate")).isEqualTo("2026-10-26");
        assertThat(gate.get("level")).isEqualTo("L0");
        assertThat(gate.get("note")).isEqualTo("과거 OS가 쓴 트리거 수준 — 구속하지 않음");
        assertThat(((tools.jackson.databind.JsonNode) gate.get("conditions")).path("G1").asBoolean(true)).isFalse();
        assertThat(new ArrayList<Object>(((Map<?, ?>) gate.get("inputs")).keySet()))
                .containsExactly("us10y", "brent", "wti", "usdjpy");

        long id = store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, "rules", MON, "SCHEDULED",
                null, "OK", null, null, 1, FRI, null, null, null, null,
                mapper.valueToTree(Map.of("summary", "매도 1 (선정 2026-10-23 · 5곳)")), null, null, null, false, 5L,
                0)).orElseThrow();
        store.insertOrder(new com.macrodash.store.PaperStore.Order(0, "rules", id, "OLD", "SELL", null, null, null,
                "NEXT_OBSERVATION", "RULE", "PENDING", null, null, MON, null, TUE_EXPIRY, null));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) query.decisions("rules", 50).get("decisions");
        assertThat(rows).singleElement().satisfies(row -> {
            assertThat(row.get("kind")).isEqualTo("SCHEDULED");
            assertThat(row.get("asOfTradingDate")).isEqualTo("2026-10-26");
            assertThat(row.get("summary")).isEqualTo("매도 1 (선정 2026-10-23 · 5곳)");
            assertThat(row.get("orderCount")).isEqualTo(1);
            assertThat(row.get("rejectedCount")).isEqualTo(0);
            assertThat(row.get("pricesFinal")).isEqualTo(false);
            assertThat(row.get("selectionAsOf")).isEqualTo("2026-10-23");
            assertThat(row.get("model")).isNull();
        });
        Map<String, Object> detail = query.decision(id);
        @SuppressWarnings("unchecked")
        Map<String, Object> decision = (Map<String, Object>) detail.get("decision");
        assertThat(decision.get("latencyMs")).isEqualTo(5L);
        assertThat(decision.get("orderCount")).isEqualTo(1);
        assertThat((List<?>) detail.get("orders")).hasSize(1);
        assertThatThrownBy(() -> query.decision(12_345)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("없는 결정");
        assertThatThrownBy(() -> query.decisions("bench_spy", 50)).isInstanceOf(InvalidRequestException.class);
        assertThat(query.decisions("claude", 50).get("decisions")).isEqualTo(List.of());
    }

    @Test
    @DisplayName("Claude 책: 개요의 노출 추이(목표 = 그날 결정의 값, 같은 날이면 나중의 값 있는 결정 · 실제 = 순자산 줄), 상세의 원문·어긋남, 상태의 호출 사용량")
    void claudeExposureSeriesDetailAndUsage() {
        initWithBenchmarks();
        var mapper = PaperFixtures.MAPPER;
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, FRI, 100_000, 40_000, 60_000, 60, true));
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, MON, 101_000, 41_000, 60_000, 59.41, true));
        store.dbNow = Instant.parse("2026-10-24T01:00:00Z");
        store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, PaperBooks.CLAUDE, FRI, "INITIAL",
                null, "OK", "claude-sonnet-5-5", null, 1, FRI, 60.0, null, "h", "{}", mapper.valueToTree(Map.of(
                "summary", "시작", "exposureMismatch", false)), null, null, List.of(), true, 10L, 0));
        store.dbNow = Instant.parse("2026-10-26T23:00:00Z");
        long scheduled = store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, PaperBooks.CLAUDE,
                MON, "SCHEDULED", null, "OK", "claude-sonnet-5-5", null, 1, FRI, 30.0, null, "h2", "{\"raw\":1}",
                mapper.valueToTree(Map.of("summary", "줄임", "exposureMismatch", true)), null, null, List.of(), true,
                10L, 0)).orElseThrow();
        store.dbNow = Instant.parse("2026-10-26T23:30:00Z");
        store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, PaperBooks.CLAUDE, MON, "MANUAL",
                null, "API_ERROR", "claude-sonnet-5-5", null, 1, FRI, null, null, null, null,
                mapper.valueToTree(Map.of("summary", "API 오류")), null, "[RATE_LIMIT] 429", List.of(), true, 10L, 0));
        store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, PaperBooks.CLAUDE,
                PaperFixtures.TUE, "SCHEDULED", null, "OK", "claude-sonnet-5-5", null, 1, FRI, 45.5, null, null, null,
                null, null, null, List.of(), true, 10L, 0));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> series = (List<Map<String, Object>>) query.overview().get("claudeExposureSeries");
        assertThat(series).extracting(p -> p.get("tradingDate"), p -> p.get("targetExposurePct"),
                p -> p.get("actualExposurePct")).containsExactly(
                org.assertj.core.groups.Tuple.tuple("2026-10-23", 60.0, 60.0),
                org.assertj.core.groups.Tuple.tuple("2026-10-26", 30.0, 59.41),
                org.assertj.core.groups.Tuple.tuple("2026-10-27", 45.5, null));

        @SuppressWarnings("unchecked")
        Map<String, Object> detail = (Map<String, Object>) query.decision(scheduled).get("decision");
        assertThat(detail.get("exposureMismatch")).isEqualTo(true);
        assertThat(detail.get("responseRaw")).isEqualTo("{\"raw\":1}");
        assertThat(detail.get("targetExposurePct")).isEqualTo(30.0);

        store.apiUsage.put(java.time.LocalDate.of(2026, 10, 27), new com.macrodash.store.PaperStore.ApiUsage(
                java.time.LocalDate.of(2026, 10, 27), 2, 40_000, 6_000, 10_000, 0));
        store.apiUsage.put(java.time.LocalDate.of(2026, 10, 3), new com.macrodash.store.PaperStore.ApiUsage(
                java.time.LocalDate.of(2026, 10, 3), 1, 20_000, 3_000, 0, 9_000));
        tools.jackson.databind.JsonNode usage = mapper.valueToTree(query.status().get("apiUsage"));
        assertThat(usage.path("today").path("day").asString()).as("KST 오늘(NOW = 10-26 21:00Z → 10-27)")
                .isEqualTo("2026-10-27");
        assertThat(usage.path("today").path("calls").asInt()).isEqualTo(2);
        assertThat(usage.path("today").path("cap").asInt()).as("기본 상한 20(v2)").isEqualTo(20);
        assertThat(usage.path("month").path("calls").asInt()).isEqualTo(3);
        assertThat(usage.path("month").path("inputTokens").asLong()).isEqualTo(60_000);
        assertThat(usage.path("month").path("days").asInt()).isEqualTo(2);
    }

    @Test
    @DisplayName("상태의 추정 비용(V11): 오늘·이달 estCostUsd(추정한 호출이 없으면 null)·estimatedCalls·isEstimated, 안내에 빠진 호출을 적음")
    void apiUsageEstimatedCost() {
        var mapper = PaperFixtures.MAPPER;
        tools.jackson.databind.JsonNode empty = mapper.valueToTree(query.status().get("apiUsage"));
        assertThat(empty.path("today").path("estCostUsd").isNull()).as("호출이 없으면 null(0달러 아님)").isTrue();
        assertThat(empty.path("today").path("estimatedCalls").asInt(-1)).isZero();
        assertThat(empty.path("today").path("isEstimated").asBoolean()).isTrue();
        assertThat(empty.path("month").path("estCostUsd").isNull()).isTrue();

        java.time.LocalDate today = java.time.LocalDate.of(2026, 10, 27);
        store.apiUsage.put(today, new com.macrodash.store.PaperStore.ApiUsage(today, 3, 40_000, 6_000, 10_000, 0,
                0.123456, 2));
        java.time.LocalDate earlier = java.time.LocalDate.of(2026, 10, 3);
        store.apiUsage.put(earlier, new com.macrodash.store.PaperStore.ApiUsage(earlier, 1, 20_000, 3_000, 0, 0));
        tools.jackson.databind.JsonNode usage = mapper.valueToTree(query.status().get("apiUsage"));
        assertThat(usage.path("today").path("estCostUsd").asDouble()).as("소수 4자리").isEqualTo(0.1235);
        assertThat(usage.path("today").path("estimatedCalls").asInt()).isEqualTo(2);
        assertThat(usage.path("today").path("calls").asInt()).isEqualTo(3);
        assertThat(usage.path("month").path("estCostUsd").asDouble()).isEqualTo(0.1235);
        assertThat(usage.path("month").path("estimatedCalls").asInt()).isEqualTo(2);
        assertThat(usage.path("month").path("calls").asInt()).isEqualTo(4);
        assertThat(usage.path("month").path("isEstimated").asBoolean()).isTrue();
        assertThat(usage.path("note").asString()).contains("추정에서 빠졌습니다");
    }

    @Test
    @DisplayName("개요의 프레임 경계(F5): Claude 책 결정에 판마다 처음 쓰인 거래일·판·상태, 거래일 순 — 판 번호 없는 결정·규칙 책은 세지 않음")
    void frameworkBoundaries() {
        initWithBenchmarks();
        assertThat(query.overview().get("frameworkBoundaries")).as("결정이 없으면 빈 목록").isEqualTo(List.of());
        var mapper = PaperFixtures.MAPPER;
        store.insertFrameworkVersionIfAbsent(new com.macrodash.store.PaperStore.FrameworkVersion(0,
                mapper.valueToTree(Map.of("title", "임시", "status", "INTERIM")), "# v0", 1, "임시", null, null));
        store.insertFrameworkVersionIfAbsent(new com.macrodash.store.PaperStore.FrameworkVersion(1,
                mapper.valueToTree(Map.of("title", "사용자", "status", "USER")), "# v1", 1, "원문", null, null));
        for (Object[] d : new Object[][]{{PaperBooks.CLAUDE, FRI, "INITIAL", 0}, {PaperBooks.CLAUDE, MON, "SCHEDULED", 0},
                {PaperBooks.CLAUDE, PaperFixtures.TUE, "SCHEDULED", 1}, {PaperBooks.CLAUDE, PaperFixtures.WED, "SCHEDULED",
                null}, {PaperBooks.RULES, FRI, "INITIAL", 5}}) {
            store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, (String) d[0],
                    (java.time.LocalDate) d[1], (String) d[2], null, "OK", null, (Integer) d[3], 1, null, null, null, null,
                    null, null, null, null, null, true, null, 0));
        }
        tools.jackson.databind.JsonNode boundaries = mapper.valueToTree(query.overview().get("frameworkBoundaries"));
        assertThat(boundaries.size()).isEqualTo(2);
        assertThat(boundaries.get(0).path("tradingDate").asString()).isEqualTo("2026-10-23");
        assertThat(boundaries.get(0).path("version").asInt()).isZero();
        assertThat(boundaries.get(0).path("status").asString()).isEqualTo("INTERIM");
        assertThat(boundaries.get(1).path("tradingDate").asString()).isEqualTo("2026-10-27");
        assertThat(boundaries.get(1).path("version").asInt()).isEqualTo(1);
        assertThat(boundaries.get(1).path("status").asString()).isEqualTo("USER");
    }

    @Test
    @DisplayName("상태의 재무 수집 범위(D28): 상태 저장본에서 universe·mapped·covered(사실 있는 회사)·마지막 수집(KST)·이어받은 회사 수 — 없으면 숫자 null")
    void fundamentalsStatus() {
        var mapper = PaperFixtures.MAPPER;
        tools.jackson.databind.JsonNode missing = mapper.valueToTree(query.status().get("fundamentals"));
        assertThat(missing.path("available").asBoolean(true)).isFalse();
        assertThat(missing.path("covered").isNull()).as("저장본이 없으면 0이 아니라 null").isTrue();
        assertThat(missing.path("universe").isNull()).isTrue();
        assertThat(missing.path("latestFetchKst").isNull()).isTrue();
        assertThat(missing.path("note").asString()).contains("sec_fundamentals");

        com.macrodash.read.StoreReader reader = PaperFixtures.quietReader();
        tools.jackson.databind.JsonNode payload = mapper.valueToTree(Map.of(
                "companies", Map.of(
                        "AAPL", Map.of("ciks", List.of("0000320193"), "latestFiled", "2026-07-31", "facts", 252),
                        "JPM", Map.of("ciks", List.of("0000019617"), "latestFiled", "2026-08-06", "facts", 167,
                                "isStale", true, "staleReason", "HTTP 503"),
                        "GPRO", Map.of("ciks", List.of("0001500435"), "error", "no companyfacts", "facts", 0)),
                "universe", 596, "mapped", 571, "fetchedThisRun", 2, "failedThisRun", 1, "budget", 200));
        when(reader.readStored(com.macrodash.store.Datasets.SNAP_US_FUNDAMENTALS_STATUS)).thenReturn(Optional.of(
                new com.macrodash.store.Snapshot(com.macrodash.store.Datasets.SNAP_US_FUNDAMENTALS_STATUS, payload,
                        "json", "ok", null, Instant.parse("2026-10-25T03:10:00Z"))));
        PaperQueryService withStatus = new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store),
                PaperFixtures.config(), NOW);

        tools.jackson.databind.JsonNode view = mapper.valueToTree(withStatus.status().get("fundamentals"));
        assertThat(view.path("available").asBoolean()).isTrue();
        assertThat(view.path("universe").asInt()).isEqualTo(596);
        assertThat(view.path("mapped").asInt()).isEqualTo(571);
        assertThat(view.path("covered").asInt()).as("companyfacts 없는 GPRO는 빠짐").isEqualTo(2);
        assertThat(view.path("staleCompanies").asInt()).isEqualTo(1);
        assertThat(view.path("latestFetchKst").asString()).isEqualTo("2026-10-25 12:10 KST");
        assertThat(view.path("note").asString()).contains("8b_fundamentals").contains("CIK 200건");
        List<String> keys = new ArrayList<>();
        view.propertyNames().forEach(keys::add);
        assertThat(keys).containsExactly("available", "universe", "mapped", "covered", "latestFetchKst",
                "staleCompanies", "note");
    }

    @Test
    @DisplayName("상태의 일정 수집 범위(2단계 A): 저장본에서 거시 일정 수(수집 창 45일, FOMC 포함)·실적 받은 종목/대상·갱신 시각(KST)·FRED 상태 — 없으면 null")
    void calendarStatus() {
        var mapper = PaperFixtures.MAPPER;
        tools.jackson.databind.JsonNode missing = mapper.valueToTree(query.status().get("calendar"));
        assertThat(missing.path("available").asBoolean(true)).isFalse();
        assertThat(missing.path("macroCount").isNull()).as("저장본이 없으면 0이 아니라 null").isTrue();
        assertThat(missing.path("earningsCovered").isNull()).isTrue();
        assertThat(missing.path("generatedAtKst").isNull()).isTrue();
        assertThat(missing.path("fredStatus").isNull()).isTrue();

        com.macrodash.read.StoreReader reader = PaperFixtures.quietReader();
        tools.jackson.databind.JsonNode payload = mapper.valueToTree(Map.of(
                "macro", Map.of(
                        "events", List.of(
                                Map.of("name", "FOMC 성명", "date", "2026-10-28", "kind", "FOMC", "source", "fed"),
                                Map.of("name", "FOMC 성명 (경제전망 SEP 포함)", "date", "2026-12-09", "kind", "FOMC",
                                        "source", "fed")),
                        "fred", Map.of("status", "키 미설정", "lastKnownDate", Map.of())),
                "earnings", Map.of("items", Map.of(), "covered", 120, "universe", 576, "budget", 120)));
        when(reader.readStored(com.macrodash.store.Datasets.SNAP_US_CALENDAR)).thenReturn(Optional.of(
                new com.macrodash.store.Snapshot(com.macrodash.store.Datasets.SNAP_US_CALENDAR, payload, "json", "ok",
                        null, Instant.parse("2026-10-25T06:40:00Z"))));
        PaperQueryService withCalendar = new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store),
                PaperFixtures.config(), NOW);

        tools.jackson.databind.JsonNode view = mapper.valueToTree(withCalendar.status().get("calendar"));
        assertThat(view.path("available").asBoolean()).isTrue();
        assertThat(view.path("macroCount").asInt()).as("키가 없어도 FOMC 상수는 셈").isEqualTo(2);
        assertThat(view.path("earningsCovered").asInt()).isEqualTo(120);
        assertThat(view.path("universe").asInt()).isEqualTo(576);
        assertThat(view.path("generatedAtKst").asString()).isEqualTo("2026-10-25 15:40 KST");
        assertThat(view.path("fredStatus").asString()).isEqualTo("키 미설정");
        List<String> keys = new ArrayList<>();
        view.propertyNames().forEach(keys::add);
        assertThat(keys).containsExactly("available", "macroCount", "earningsCovered", "universe", "generatedAtKst",
                "fredStatus");
    }

    @Test
    @DisplayName("상태의 사건 뉴스 수집(2단계 B): 상태 저장본에서 7일 보관 건수·마지막 수집(KST)·받은 피드/전체·실패한 피드와 사유 — 없으면 null")
    void newsStatus() {
        var mapper = PaperFixtures.MAPPER;
        tools.jackson.databind.JsonNode missing = mapper.valueToTree(query.status().get("news"));
        assertThat(missing.path("available").asBoolean(true)).isFalse();
        for (String key : List.of("stored7d", "lastFetchKst", "feedsOk", "feedsTotal", "failedFeeds")) {
            assertThat(missing.path(key).isNull()).as(key + " — 저장본이 없으면 0·빈 목록이 아니라 null").isTrue();
        }

        com.macrodash.read.StoreReader reader = PaperFixtures.quietReader();
        tools.jackson.databind.JsonNode payload = mapper.valueToTree(Map.of(
                "generatedAt", "2026-10-25T06:00:12+00:00", "stored7d", 61, "feedsOk", 6, "feedsTotal", 7,
                "failedFeeds", List.of(Map.of("feed", "bls_cpi", "source", "BLS", "reason", "HTTP 403 — BLS 차단(UA)")),
                "insertedThisRun", 12, "maybeMissed", List.of()));
        when(reader.readStored(com.macrodash.store.Datasets.SNAP_NEWS_STATUS)).thenReturn(Optional.of(
                new com.macrodash.store.Snapshot(com.macrodash.store.Datasets.SNAP_NEWS_STATUS, payload, "json", "ok",
                        null, Instant.parse("2026-10-25T06:00:20Z"))));
        PaperQueryService withNews = new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store),
                PaperFixtures.config(), NOW);

        tools.jackson.databind.JsonNode view = mapper.valueToTree(withNews.status().get("news"));
        assertThat(view.path("available").asBoolean()).isTrue();
        assertThat(view.path("stored7d").asInt()).isEqualTo(61);
        assertThat(view.path("lastFetchKst").asString()).as("수집 시각(generatedAt, UTC) → KST").isEqualTo("2026-10-25 15:00 KST");
        assertThat(view.path("feedsOk").asInt()).isEqualTo(6);
        assertThat(view.path("feedsTotal").asInt()).isEqualTo(7);
        assertThat(view.path("failedFeeds").toString())
                .isEqualTo("[{\"feed\":\"bls_cpi\",\"source\":\"BLS\",\"reason\":\"HTTP 403 — BLS 차단(UA)\"}]");
        List<String> keys = new ArrayList<>();
        view.propertyNames().forEach(keys::add);
        assertThat(keys).containsExactly("available", "stored7d", "lastFetchKst", "feedsOk", "feedsTotal", "failedFeeds");

        // generatedAt이 없거나 읽을 수 없으면 저장 시각, 숫자가 아닌 칸은 null(0이 아님).
        tools.jackson.databind.JsonNode odd = mapper.valueToTree(Map.of("stored7d", "many", "feedsOk", 7));
        when(reader.readStored(com.macrodash.store.Datasets.SNAP_NEWS_STATUS)).thenReturn(Optional.of(
                new com.macrodash.store.Snapshot(com.macrodash.store.Datasets.SNAP_NEWS_STATUS, odd, "json", "ok",
                        null, Instant.parse("2026-10-25T06:00:20Z"))));
        tools.jackson.databind.JsonNode oddView = mapper.valueToTree(withNews.status().get("news"));
        assertThat(oddView.path("stored7d").isNull()).isTrue();
        assertThat(oddView.path("lastFetchKst").asString()).isEqualTo("2026-10-25 15:00 KST");
        assertThat(oddView.path("failedFeeds").isEmpty()).isTrue();
    }

    @Test
    @DisplayName("상태의 어닝 서프라이즈 수집 범위(2단계 C): 상태 저장본에서 행이 있는 종목/대상·추정치 4분기 이상 종목·갱신 시각(KST) — 없으면 null")
    void earningsStatus() {
        var mapper = PaperFixtures.MAPPER;
        tools.jackson.databind.JsonNode missing = mapper.valueToTree(query.status().get("earnings"));
        assertThat(missing.path("available").asBoolean(true)).isFalse();
        for (String key : List.of("covered", "universe", "withEstimate4", "generatedAtKst")) {
            assertThat(missing.path(key).isNull()).as(key + " — 저장본이 없으면 0이 아니라 null").isTrue();
        }

        com.macrodash.read.StoreReader reader = PaperFixtures.quietReader();
        // 수집기 상태 저장본 모양(earnings_surprise 태스크) — items는 요약에 쓰지 않음.
        tools.jackson.databind.JsonNode payload = mapper.valueToTree(Map.of(
                "generatedAt", "2026-10-25T12:30:05+00:00", "universe", 576, "covered", 98, "withEstimate4", 91,
                "budget", 100, "fetchedThisRun", 100, "failedThisRun", 2,
                "items", Map.of("AAPL", Map.of("fetchedAt", "2026-10-25T12:30:05+00:00", "rows", 4,
                        "latestReported", "2026-07-30"))));
        when(reader.readStored(com.macrodash.store.Datasets.SNAP_EARNINGS_SURPRISE_STATUS)).thenReturn(Optional.of(
                new com.macrodash.store.Snapshot(com.macrodash.store.Datasets.SNAP_EARNINGS_SURPRISE_STATUS, payload,
                        "json", "ok", null, Instant.parse("2026-10-25T12:30:09Z"))));
        PaperQueryService withEarnings = new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store),
                PaperFixtures.config(), NOW);

        tools.jackson.databind.JsonNode view = mapper.valueToTree(withEarnings.status().get("earnings"));
        assertThat(view.path("available").asBoolean()).isTrue();
        assertThat(view.path("covered").asInt()).isEqualTo(98);
        assertThat(view.path("universe").asInt()).isEqualTo(576);
        assertThat(view.path("withEstimate4").asInt()).isEqualTo(91);
        assertThat(view.path("generatedAtKst").asString()).as("수집 시각(generatedAt, UTC) → KST")
                .isEqualTo("2026-10-25 21:30 KST");
        List<String> keys = new ArrayList<>();
        view.propertyNames().forEach(keys::add);
        assertThat(keys).containsExactly("available", "covered", "universe", "withEstimate4", "generatedAtKst");

        // generatedAt이 없으면 저장 시각, 숫자가 아닌 칸은 null(0이 아님).
        tools.jackson.databind.JsonNode odd = mapper.valueToTree(Map.of("covered", "many", "universe", 576));
        when(reader.readStored(com.macrodash.store.Datasets.SNAP_EARNINGS_SURPRISE_STATUS)).thenReturn(Optional.of(
                new com.macrodash.store.Snapshot(com.macrodash.store.Datasets.SNAP_EARNINGS_SURPRISE_STATUS, odd, "json",
                        "ok", null, Instant.parse("2026-10-25T00:31:00Z"))));
        tools.jackson.databind.JsonNode oddView = mapper.valueToTree(withEarnings.status().get("earnings"));
        assertThat(oddView.path("covered").isNull()).isTrue();
        assertThat(oddView.path("withEstimate4").isNull()).isTrue();
        assertThat(oddView.path("universe").asInt()).isEqualTo(576);
        assertThat(oddView.path("generatedAtKst").asString()).isEqualTo("2026-10-25 09:31 KST");
    }


    // ------------------------------------------------------------------ 시장 격리(2단계 명세 §9 A6)
    @Test
    @DisplayName("시장 격리(A6): 개요는 그 시장 책·그 책들의 순자산 줄·그 시장 관측치만 — 미국 개요에 다른 시장 책·날짜가 섞이지 않고, 다른 시장 개요에는 미국 전용 칸(13F 선정·게이트·한계 문구·출발일)이 없음")
    @SuppressWarnings("unchecked")
    void overviewPerMarket() {
        initWithBenchmarks();
        PaperMarket kr = TestKrMarket.INSTANCE;
        String krBook = TestKrMarket.CLAUDE_BOOK;
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000_000, FRI));
        store.states.put(krBook, new com.macrodash.store.PaperStore.BookState(krBook, 100_000_000, 100_000_000, 0, 0,
                null, null, null, null));
        java.time.LocalDate krOnly = java.time.LocalDate.of(2026, 10, 21);   // 미국 책에는 없는 날
        store.upsertNav(new NavRow(krBook, krOnly, 100_000_000, 100_000_000, 0, 0, true));
        store.upsertNav(new NavRow("bench_spy", MON, 101_000, 450.25, 100_549.75, 99.55, true));
        when(marketData.quotes(kr)).thenReturn(Optional.of(quotes(Instant.parse("2026-10-26T12:00:00Z"),
                bar("005930", FRI, 70_000, MON, 71_000))));
        PaperQueryService both = new PaperQueryService(store, marketData, PaperFixtures.quietReader(),
                PaperFixtures.settings(store), PaperFixtures.config(), NOW, List.of(UsPaperMarket.INSTANCE, kr));

        Map<String, Object> us = both.overview();
        assertThat((List<Map<String, Object>>) us.get("books")).extracting(b -> b.get("code"))
                .containsExactly("rules", "claude", "bench_spy", "bench_mix");
        Map<String, Object> usNav = (Map<String, Object>) us.get("navSeries");
        assertThat((List<String>) usNav.get("dates")).doesNotContain(krOnly.toString());
        assertThat((Map<String, Object>) usNav.get("books")).doesNotContainKey(krBook);
        assertThat(us).isEqualTo(query.overview());

        Map<String, Object> other = both.overview(kr);
        assertThat(other.get("initialized")).isEqualTo(true);
        assertThat((List<Map<String, Object>>) other.get("books")).extracting(b -> b.get("code"))
                .containsExactly(krBook);
        assertThat(((List<Map<String, Object>>) other.get("books")).get(0).get("benchmark")).isNull();
        assertThat((List<String>) ((Map<String, Object>) other.get("navSeries")).get("dates"))
                .containsExactly(krOnly.toString());
        Map<String, Object> krQuotes = (Map<String, Object>) other.get("quotes");
        assertThat(krQuotes.get("barDate")).isEqualTo("2026-10-26");
        assertThat(krQuotes.get("finalClose")).as("그 시장 확정 판정(서울 15:30 + 15분 뒤 수집)").isEqualTo(true);
        assertThat(other.get("startDate")).isNull();
        assertThat(other.get("selection")).isNull();
        assertThat(other.get("gate")).isNull();
        assertThat(other.get("limits")).isEqualTo(List.of());
        assertThat(both.status(kr).get("initialCash")).isNull();
        assertThat(both.status(kr).get("quotes")).isEqualTo(krQuotes);
    }

    @Test
    @DisplayName("시장 격리(A6): 계좌 코드 경로는 그 책의 시장 달력(보유 거래일)·비교 기준을 쓰고, 결정 목록은 아는 시장의 규칙·Claude 책만 받음")
    @SuppressWarnings("unchecked")
    void bookPathsUseTheBooksMarket() {
        PaperMarket kr = TestKrMarket.INSTANCE;
        String krBook = TestKrMarket.CLAUDE_BOOK;
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000_000, FRI));
        store.states.put(krBook, new com.macrodash.store.PaperStore.BookState(krBook, 30_000_000, 100_000_000,
                70_000_000, 70, null, null, null, null));
        // 11-20(금) 연 보유를 11-27(금) 21:00 KST에 — 시험용 한국 달력(서울 평일)으로 5거래일. 미국 달력이었다면 추수감사절(11-26)
        // 휴장이 빠지고 그 시각은 미국 11-27 개장 전이라 더 적습니다.
        store.upsertPosition(new com.macrodash.store.PaperStore.Position(krBook, "005930", 1_000, 70_000,
                java.time.LocalDate.of(2026, 11, 20), Instant.parse("2026-11-20T06:30:00Z"), 70_000,
                Instant.parse("2026-11-20T06:30:00Z"), 70_000.0, Instant.parse("2026-11-20T06:30:00Z"), false,
                java.time.LocalDate.of(2026, 11, 20), 70_000, null));
        Clock friday = Clock.fixed(Instant.parse("2026-11-27T12:00:00Z"), ZoneOffset.UTC);
        PaperQueryService both = new PaperQueryService(store, marketData, PaperFixtures.quietReader(),
                PaperFixtures.settings(store), PaperFixtures.config(), friday, List.of(UsPaperMarket.INSTANCE, kr));

        Map<String, Object> positions = both.positions(krBook);
        List<Map<String, Object>> rows = (List<Map<String, Object>>) positions.get("positions");
        assertThat(rows.get(0).get("holdingTradingDays")).isEqualTo(5);
        assertThat(((Map<String, Object>) positions.get("book")).get("benchmark")).isNull();
        assertThat(both.decisions(krBook, 10).get("available")).isEqualTo(true);
        assertThatThrownBy(() -> query.decisions(krBook, 10)).as("모르는 시장의 책은 결정 목록에 받지 않음")
                .isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> query.positions(krBook)).as("모르는 시장의 책은 달력을 고를 수 없음")
                .isInstanceOf(IllegalStateException.class);
    }

    private static final java.time.LocalDate TUE_EXPIRY = java.time.LocalDate.of(2026, 10, 29);
}
