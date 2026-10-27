package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.macrodash.feature.paper.KrRuleBookServiceTest.FRI;
import static com.macrodash.feature.paper.KrRuleBookServiceTest.R;
import static com.macrodash.feature.paper.KrRuleBookServiceTest.R1;
import static com.macrodash.feature.paper.KrRuleBookServiceTest.R2;
import static com.macrodash.feature.paper.KrRuleBookServiceTest.S;
import static com.macrodash.feature.paper.KrRuleBookServiceTest.kst;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 규칙 계좌를 결정 작업으로 끝까지(2단계 명세 §4-6·§4-9·§5 'K33', D1b·D1c): 자료 게이트 ①~⑥(§4-9 — 하나라도 미달이면 결정하지 않고
 * {@code DATA_NOT_READY}, 기록 없음), 재선정일 r(11-02)의 자료가 기한(11-03 01:00)까지 오지 않으면 기한 지남 NO_TRADE 행(그 순간의 게이트와 사유)이
 * 남고, 다음 KR 결정일 r′(11-03)에 r′ 자료로 REBALANCE(cycleDate r·selectionAsOf r′)를 내며, 그 뒤(11-04)에는 다시 선정하지 않는다. 외부 호출
 * 없음 — 가짜 저장소·가짜 저장본 읽기·움직이는 시계.
 */
class KrRulesJobTest {

    private FakePaperStore store;
    private StoreReader reader;
    private KrFixtures.MovableClock clock;
    private PaperDecisionJob job;
    private KrRulesFixtures data;
    /** 가짜 저장소(유니버스·수급 읽기 — 읽은 횟수를 보는 시험이 씀). */
    private StoreRepository repository;
    /** 장부 처리를 실패시킬 계좌(시험 — 그 계좌의 만료 정리에서 예외, 장부가 그 계좌만 되돌림). null이면 실패 없음. */
    private String failLedgerFor;
    /** 규칙 계좌 결정 행 쓰기를 실패시킴(시험 — 게이트를 통과한 뒤의 결정 예외). */
    private boolean failRulesDecision;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore() {
            @Override
            public int expireOrders(String code, LocalDate today) {
                if (code.equals(failLedgerFor)) {
                    throw new IllegalStateException("시험용 장부 오류");
                }
                return super.expireOrders(code, today);
            }

            @Override
            public java.util.Optional<Long> insertDecisionIfAbsent(Decision d) {
                if (failRulesDecision && PaperBooks.KR_RULES.equals(d.bookCode())) {
                    throw new IllegalStateException("시험용 결정 쓰기 오류");
                }
                return super.insertDecisionIfAbsent(d);
            }
        };
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        repository = repository();
        clock = new KrFixtures.MovableClock(kst("2026-10-28T12:00"));
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        KrRuleBookServiceTest.startedBooks(store, reader, marketData, clock);
        data = KrRulesFixtures.standard(LocalDate.of(2026, 10, 28), S, FRI, R, R1, R2);
        data.install(repository, reader);
        job = job(marketData);
    }

    /** 금융위 시장 구분(비용 종목 구분) — 표준 U 여덟 종목 모두 코스피. */
    private static StoreRepository repository() {
        StoreRepository repository = mock(StoreRepository.class);
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(LocalDate.of(2026, 10, 30));
        when(repository.readObservationsFor(eq(Datasets.OBS_FSC_PRICE), org.mockito.ArgumentMatchers.any(LocalDate.class),
                anyCollection())).thenAnswer(invocation -> {
                    Collection<String> codes = invocation.getArgument(2);
                    Map<String, JsonNode> out = new LinkedHashMap<>();
                    codes.forEach(code -> out.put(code, PaperFixtures.MAPPER.createObjectNode().put("market", "KOSPI")));
                    return out;
                });
        return repository;
    }

    private PaperDecisionJob job(PaperMarketData marketData) {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        return new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), mock(ClaudeBookService.class), PaperFixtures.settings(store),
                KrRuleBookServiceTest.config(), PaperFixtures.MAPPER, clock);
    }

    /** 그 세션 밤의 자료 — 관측치(그날 봉 모두)와 금융위 메타(기준일 = 직전 거래일, 게이트 ④). */
    private void session(LocalDate session) {
        quotes(session, Set.of());
        fsc(KrRulesFixtures.CALENDAR.previousTradingDay(session));
    }

    private void quotes(LocalDate session, Set<String> noSessionBar) {
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.quotes(session, noSessionBar));
    }

    private void fsc(LocalDate latest) {
        KrFixtures.stub(reader, Datasets.SNAP_FSC_PRICES_META, KrFixtures.snapshot(Datasets.SNAP_FSC_PRICES_META,
                KrFixtures.fscMeta(latest), kst(latest.plusDays(1) + "T21:56")));
    }

    private PaperDecisionJob.Result runAt(String kstDateTime) {
        clock.set(kst(kstDateTime));
        store.dbNow = clock.instant();
        return job.run(KrPaperMarket.INSTANCE);
    }

    private List<Decision> rulesDecisions() {
        return store.decisionsOf(PaperBooks.KR_RULES);
    }

    private List<JobRun> krRuns() {
        return store.jobRuns.stream().filter(r -> r.job().equals("kr.decision")).toList();
    }

    private static List<String> gateStatuses(JsonNode gates) {
        List<String> out = new ArrayList<>();
        gates.forEach(g -> out.add(g.path("gate").asString() + " " + g.path("status").asString()));
        return out;
    }

    /** 규칙 계좌 보유 하나(출발일 S에 그 가격으로 산 것 — 마지막 평가 가격도 같음). */
    private void holding(String code, int qty, double price) {
        store.upsertPosition(new Position(PaperBooks.KR_RULES, code, qty, price, S, kst("2026-10-30T09:00"), price,
                kst("2026-10-30T09:00"), price, kst("2026-10-30T21:57"), false, S, price, null));
    }

    /** 규칙 계좌의 대기 주문 하나. */
    private long pending(String ticker, String side, String timing, String source, LocalDate asOf, String createdKst) {
        return store.insertOrder(new Order(0, PaperBooks.KR_RULES, null, ticker, side, null,
                PaperBooks.BUY.equals(side) ? 1.0 : null, null, timing, source, PaperBooks.ORDER_PENDING, null, null, asOf,
                kst(createdKst), KrRulesFixtures.CALENDAR.addTradingDays(asOf, 3), null));
    }

    @Test
    @DisplayName("재선정일 r의 관측치가 기한까지 없음 → 기다림(DATA_NOT_READY, 기록 없음) → r NO_TRADE(사유 '069500 D 봉 없음(휴장 또는 지연)'·그 순간의 게이트) → r′에 r′ 자료로 REBALANCE(cycleDate r·selectionAsOf r′) → 그 뒤 SCHEDULED(다시 선정 안 함)")
    void catchUpThroughTheJob() {
        session(FRI);   // 11-02 밤 — 그날 관측치가 끝내 오지 않음(저장본은 10-30 판)
        java.time.Instant processedBefore = store.state(PaperBooks.KR_RULES).orElseThrow().lastProcessedCollectedAt();
        PaperDecisionJob.Result waiting = runAt("2026-11-02T22:30");
        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(waiting.message()).contains("②").contains("관측치 세션 2026-10-30").contains("⑤")
                .contains("기한 2026-11-03 01:00 KST");
        assertThat(runAt("2026-11-03T00:50").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(krRuns()).as("기다림은 기록하지 않음").isEmpty();
        // ②④⑤⑥ 미달이면 장부를 처리하지 않음 — 그날 관측치 전에 r의 미확정 순자산 줄을 쓰지 않게(D1c '정기 결정의 순서').
        assertThat(store.navSeries(PaperBooks.KR_RULES)).extracting(com.macrodash.store.PaperStore.NavRow::tradingDate)
                .as("r(11-02) 순자산 줄 없음").doesNotContain(R);
        assertThat(store.state(PaperBooks.KR_RULES).orElseThrow().lastProcessedCollectedAt())
                .as("10-30 관측치를 장부에 적용하지 않음").isEqualTo(processedBefore);

        PaperDecisionJob.Result missed = runAt("2026-11-03T01:00");
        assertThat(missed.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(missed.tradingDate()).isEqualTo(R);
        assertThat(missed.rules()).satisfies(row -> {
            assertThat(row.kind()).isEqualTo(RuleBookService.REBALANCE);
            assertThat(row.status()).isEqualTo("NO_TRADE");
            assertThat(row.response().path("noTradeReason").asString()).as("결정 e4 — 휴장과 지연을 가르지 않음")
                    .isEqualTo("069500 D 봉 없음(휴장 또는 지연)");
            assertThat(row.response().path("pastDeadline").asBoolean()).isTrue();
            assertThat(row.response().path("cycleDate").asString()).isEqualTo("2026-11-02");
            assertThat(gateStatuses(row.response().path("gates"))).as("기한 전 마지막 판정(00:50 — 장부 전 게이트에서 멈춤, ①③은 판정 전)")
                    .containsExactly("② FAIL", "④ FAIL", "⑤ FAIL", "⑥ PASS");
            assertThat(row.response().path("gatesJudgedAtKst").asString()).isEqualTo("2026-11-03 00:50 KST");
            assertThat(row.response().path("gatesBasis").asString()).isEqualTo("기한 전 마지막 판정");
            assertThat(row.response().path("waitedFor").toString()).contains("②").contains("④").contains("⑤");
        });
        assertThat(store.ordersByDecision(missed.rules().id())).isEmpty();
        assertThat(runAt("2026-11-03T01:10").outcome()).as("규칙 계좌 일은 행으로 끝남").isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
            assertThat(run.detail().path("rules").path("status").asString()).isEqualTo("NO_TRADE");
            assertThat(run.detail().path("rules").path("kind").asString()).isEqualTo("REBALANCE");
            assertThat(run.detail().path("claude").asString()).contains("시작 전");
            assertThat(gateStatuses(run.detail().path("gates"))).contains("⑤ FAIL");
        });

        session(R1);
        PaperDecisionJob.Result caught = runAt("2026-11-03T22:30");
        assertThat(caught.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        Decision rebalance = caught.rules();
        assertThat(rebalance.kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(rebalance.status()).isEqualTo("OK");
        assertThat(rebalance.asOfTradingDate()).isEqualTo(R1);
        assertThat(rebalance.selectionAsOf()).isEqualTo(R1);
        assertThat(rebalance.settingsVersion()).isEqualTo(store.settings.version());
        assertThat(rebalance.response().path("cycleDate").asString()).isEqualTo("2026-11-02");
        assertThat(rebalance.response().path("selectionAsOf").asString()).isEqualTo("2026-11-03");
        assertThat(rebalance.response().path("catchUp").asBoolean()).isTrue();
        assertThat(rebalance.response().path("input").path("flowsWindow").path("to").asString()).isEqualTo("2026-11-03");
        assertThat(store.ordersByDecision(rebalance.id())).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("000660", "BUY", 6.6667),
                        org.assertj.core.groups.Tuple.tuple("005930", "BUY", 6.6667),
                        org.assertj.core.groups.Tuple.tuple("105560", "BUY", 6.6667),
                        org.assertj.core.groups.Tuple.tuple("153130", "BUY", 79.4869));
        assertThat(krRuns()).last().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
            assertThat(run.detail().path("rules").path("cycleDate").asString()).isEqualTo("2026-11-02");
            assertThat(run.detail().path("rules").path("selectionAsOf").asString()).isEqualTo("2026-11-03");
            assertThat(run.detail().path("rules").path("catchUp").asBoolean()).isTrue();
        });

        // 11-04 밤 — 11-03 주문은 11-04 시가에 체결되고(장부 — 게이트 ①이 그 처리 뒤에 봄), 그 주기 매수 결정이 있으니 다시 고르지 않음.
        session(R2);
        PaperDecisionJob.Result after = runAt("2026-11-04T22:30");
        assertThat(after.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(after.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(store.ordersByDecision(rebalance.id())).allSatisfy(o -> assertThat(o.status()).isEqualTo("FILLED"));
        assertThat(after.rules().response().path("gates").get(0).path("note").asString())
                .contains("kr_rules").contains("대기 주문 없음");
        assertThat(store.ordersByDecision(after.rules().id())).noneMatch(o -> "BUY".equals(o.side())
                && !"153130".equals(o.ticker()));
        assertThat(after.rules().response().path("notes").toString()).contains("재선정일이 아니라 사지 않습니다");
        assertThat(rulesDecisions()).extracting(d -> d.asOfTradingDate() + " " + d.kind() + " " + d.status()).containsExactly(
                "2026-10-29 INITIAL OK", "2026-11-02 REBALANCE NO_TRADE", "2026-11-03 REBALANCE OK",
                "2026-11-04 SCHEDULED " + after.rules().status());
    }

    @Test
    @DisplayName("게이트가 모두 통과하면 재선정일 당일 REBALANCE(따라잡기 아님) — 결정 행 응답·작업 기록에 게이트 ①~⑥, 결정 시각 전에는 기다림, 같은 세션 다시 돌면 ALREADY_DECIDED")
    void reselectionOnTheDay() {
        session(R);
        assertThat(runAt("2026-11-02T22:29").outcome()).isEqualTo(PaperDecisionJob.TOO_EARLY);
        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(decided.rules().response().path("catchUp").asBoolean()).isFalse();
        assertThat(decided.rules().response().path("cycleDate").asString()).isEqualTo("2026-11-02");
        JsonNode gates = decided.rules().response().path("gates");
        assertThat(gateStatuses(gates)).containsExactly("① PASS", "② PASS", "③ PASS", "④ PASS", "⑤ PASS", "⑥ PASS");
        assertThat(gates.get(1).path("note").asString()).contains("10/10");
        assertThat(gates.get(2).path("note").asString()).as("규칙 계좌 입력과 같은 읽기 — U 여덟·기준일 10-30")
                .contains("U 8/8").contains("U 기준일 2026-10-30");
        assertThat(gates.get(3).path("note").asString()).contains("금융위 기준일 2026-10-30");
        assertThat(krRuns()).singleElement().satisfies(run ->
                assertThat(gateStatuses(run.detail().path("gates"))).containsExactly("① PASS", "② PASS", "③ PASS",
                        "④ PASS", "⑤ PASS", "⑥ PASS"));
        assertThat(runAt("2026-11-02T22:40").outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(rulesDecisions()).hasSize(2);
    }

    @Test
    @DisplayName("게이트 ③과 그 결정은 같은 읽기(결정 e5) — 한 실행에서 U·20일 수급을 한 번만 읽고, 결정 행의 동결 값·③ 문구가 그 읽기")
    void gateThreeAndTheDecisionShareOneRead() {
        session(R);
        org.mockito.Mockito.clearInvocations(repository);

        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.times(1)).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), org.mockito.ArgumentMatchers.any(LocalDate.class));
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.times(1)).latestObservationDateBefore(
                eq(Datasets.OBS_KR_PAPER_UNIVERSE), org.mockito.ArgumentMatchers.any(LocalDate.class));
        JsonNode response = decided.rules().response();
        assertThat(response.path("gates").get(2).path("note").asString()).contains("U 8/8").contains("U 기준일 2026-10-30");
        assertThat(response.path("input").path("universe").path("size").asInt()).isEqualTo(8);
        assertThat(response.path("input").path("readAtKst").asString()).isEqualTo("2026-11-02 22:30 KST");
    }

    @Test
    @DisplayName("게이트 하나씩 미달이면 결정하지 않음(DATA_NOT_READY, 결정·기록 없음) — ② 범위 8/10 · ④ 금융위 기준일 · ⑤ 069500 D 봉(②는 9/10 통과) · ③ U 7/8(장중 판) · ① 기준일 < D 대기 주문; 다 고치면 그 창에서 결정")
    void eachGateAloneBlocks() {
        quotes(R, Set.of("005930", "000660"));
        fsc(FRI);
        PaperDecisionJob.Result coverage = runAt("2026-11-02T22:30");
        assertThat(coverage.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(coverage.message()).contains("② 수집 범위 8/10").doesNotContain("④").doesNotContain("⑤").doesNotContain("③");

        quotes(R, Set.of());
        fsc(LocalDate.of(2026, 10, 29));
        assertThat(runAt("2026-11-02T22:40").message()).contains("④ 금융위 기준일 2026-10-29").doesNotContain("②")
                .doesNotContain("⑤");

        quotes(R, Set.of("069500"));
        fsc(FRI);
        PaperDecisionJob.Result anchor = runAt("2026-11-02T22:50");
        assertThat(anchor.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(anchor.message()).contains("⑤ 069500 2026-11-02 봉 없음(휴장 또는 지연)").doesNotContain("②");

        quotes(R, Set.of());
        data.flow("005930", R, 100_000L, 50_000L, "2026-11-02T14:58:03.000+09:00", kst("2026-11-02T21:18"));
        PaperDecisionJob.Result flows = runAt("2026-11-02T23:00");
        assertThat(flows.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(flows.message()).contains("③ U 7/8").contains("15:35 전 판 1(005930)").doesNotContain("①");

        data.flow("005930", R, 100_000L, 50_000L, "2026-11-02T20:21:26.000+09:00", kst("2026-11-02T21:18"));
        long stale = pending("005930", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        // 1분봉 FAILED 기다림 같은 자리 — 이 저장본에 그 종목 R 봉이 없어 기준일 10-30 주문이 체결되지 않고 대기(②는 9/10 통과).
        quotes(R, Set.of("005930"));
        PaperDecisionJob.Result ledger = runAt("2026-11-02T23:10");
        assertThat(ledger.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(ledger.message()).contains("① kr_rules").contains("#" + stale + " BUY 005930(기준일 2026-10-30)")
                .contains("정리 안 됨");
        assertThat(rulesDecisions()).as("출발 INITIAL뿐").hasSize(1);
        assertThat(krRuns()).as("기다림은 기록하지 않음").isEmpty();

        store.markOrderStatus(stale, PaperBooks.ORDER_CANCELLED, "시험 — 정리됨");
        quotes(R, Set.of());
        PaperDecisionJob.Result decided = runAt("2026-11-02T23:20");
        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(decided.rules().response().path("catchUp").asBoolean()).as("기다림은 그 세션 안 — 따라잡기 아님").isFalse();
        assertThat(krRuns()).singleElement().satisfies(run -> assertThat(run.outcome()).isEqualTo(PaperDecisionJob.DECIDED));
    }

    @Test
    @DisplayName("관측치 저장본을 시장 파서가 읽지 못하면(계약 판 2 — 수집기와 백엔드를 따로 배포하는 사이) 게이트 ② 미달 — 원문 머리·봉으로는 ②⑤가 통과해도 장부가 처리하지 않는 관측치로 결정하지 않음(입력도 읽지 않음), 판이 맞는 저장본이 오면 결정")
    void unreadableObservationBlocksGateTwo() {
        com.macrodash.store.Snapshot two = KrRulesFixtures.quotes(R);
        ((tools.jackson.databind.node.ObjectNode) two.payload()).put("contract", 2);
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, two);
        fsc(FRI);

        PaperDecisionJob.Result waiting = runAt("2026-11-02T22:30");

        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(waiting.message()).contains("② 관측치 저장본(paper.kr.quotes)을 장부가 읽지 못함").contains("계약 판 2")
                .doesNotContain("⑤");
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.never()).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), org.mockito.ArgumentMatchers.any(LocalDate.class));
        assertThat(rulesDecisions()).as("출발 INITIAL뿐").hasSize(1);
        assertThat(krRuns()).isEmpty();

        session(R);   // 판 1 저장본
        PaperDecisionJob.Result decided = runAt("2026-11-02T22:40");
        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().response().path("gates").get(1).path("status").asString()).isEqualTo("PASS");
    }

    @Test
    @DisplayName("게이트 ③ — 20거래일 창에 U 기록이 절반 미만인 날(달력이 모르는 휴장일·수집 구멍)이 있으면 미달: U 전 종목이 '자료 부족'인 채 재선정해 종목 0·153130 99.5%로 가지 않고 기다림 → 기한 뒤 NO_TRADE(③) → 그날을 임시휴장으로 저장하면 다음 KR 결정일에 따라잡기")
    void windowHoleBlocksGateThree() {
        LocalDate hole = LocalDate.of(2026, 10, 28);   // 달력은 거래일로 아는데 시장이 쉰 날(늦게 지정된 임시휴장) — 토스 기록 없음
        data.flows.values().forEach(days -> days.remove(hole));
        session(R);

        PaperDecisionJob.Result waiting = runAt("2026-11-02T22:30");

        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(waiting.message()).contains("③ U 8/8").contains("U 기록이 절반 미만인 날 1(2026-10-28 0/8)")
                .contains("kr.calendar.extraClosures");
        PaperDecisionJob.Result late = runAt("2026-11-03T01:00");
        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(late.rules().status()).isEqualTo("NO_TRADE");
        assertThat(late.rules().response().path("waitedFor").toString()).contains("③").contains("2026-10-28 0/8");

        // 운영자가 그날을 임시휴장으로 저장 — 그 실행의 달력이 그날을 건너뛰어 창이 다시 참.
        tools.jackson.databind.node.ObjectNode body = (tools.jackson.databind.node.ObjectNode) store.settings.body().deepCopy();
        tools.jackson.databind.node.ObjectNode kr = (tools.jackson.databind.node.ObjectNode) body.path("kr");
        tools.jackson.databind.node.ObjectNode calendar = kr.has("calendar")
                ? (tools.jackson.databind.node.ObjectNode) kr.get("calendar") : kr.putObject("calendar");
        calendar.putArray("extraClosures").add(hole.toString());
        store.saveSettings(body, List.of("kr.calendar.extraClosures"));
        session(R1);
        PaperDecisionJob.Result caught = runAt("2026-11-03T22:30");

        assertThat(caught.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(caught.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(caught.rules().response().path("catchUp").asBoolean()).isTrue();
        assertThat(store.ordersByDecision(caught.rules().id())).extracting(Order::ticker)
                .containsExactly("000660", "005930", "105560", "153130");
    }

    @Test
    @DisplayName("게이트 ③의 판 문턱은 D 15:35 KST 포함 — 15:34:59 판은 장중 판(7/8 기다림), 15:35:00 정각 판은 셈(U 8/8 결정)")
    void gateThreeEveningVersionBoundary() {
        session(R);
        data.flow("005930", R, 100_000L, 50_000L, "2026-11-02T15:34:59.000+09:00", kst("2026-11-02T21:18"));
        PaperDecisionJob.Result before = runAt("2026-11-02T22:30");
        assertThat(before.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(before.message()).contains("③ U 7/8").contains("15:35 전 판 1(005930)");

        data.flow("005930", R, 100_000L, 50_000L, "2026-11-02T15:35:00.000+09:00", kst("2026-11-02T21:18"));
        PaperDecisionJob.Result at = runAt("2026-11-02T22:40");
        assertThat(at.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(at.rules().response().path("gates").get(2).path("note").asString()).contains("U 8/8");
    }

    @Test
    @DisplayName("게이트 ⑥(D가 거래일) — 결정 작업의 D는 그 달력의 lastCompletedSession이라 늘 통과, 판정 자체는 달력이 휴장으로 아는 날을 막음")
    void gateSixJudgesTheCalendar() {
        assertThat(KrDecisionGates.tradingDay(KrRulesFixtures.CALENDAR, R).blocks()).isFalse();
        assertThat(KrDecisionGates.tradingDay(KrRulesFixtures.CALENDAR, LocalDate.of(2026, 10, 31)).blocks())
                .as("토요일").isTrue();
        assertThat(KrDecisionGates.tradingDay(KrRulesFixtures.CALENDAR, LocalDate.of(2026, 12, 31)).note())
                .as("연말 휴장").contains("KRX 거래일이 아님");
    }

    @Test
    @DisplayName("게이트 ①은 자기 판정(결정 e3) — 기준일 < D 대기 주문이 체결 조건 ⑤(D 개장 뒤 생성)로만 막혀 순자산 확정에서는 빠져도 게이트 ①은 '정리 안 됨', 기준일 = D 주문(그날 밤 스탑)·그 시장이 체결하지 않는 시점(NEXT_CLOSE)은 막지 않음")
    void gateOneIgnoresConditionFive() {
        session(R);
        long afterOpen = pending("005930", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-11-02T10:00");
        pending("373220", PaperBooks.SELL, PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_STOP, R, "2026-11-02T21:58");
        pending("000660", PaperBooks.BUY, "NEXT_CLOSE", RuleBookService.SOURCE_RULE, FRI, "2026-10-30T22:30");

        PaperDecisionJob.Result blocked = runAt("2026-11-02T22:30");

        assertThat(blocked.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(blocked.message()).contains("① kr_rules — 기준일 < 2026-11-02인 대기 주문 1건 #" + afterOpen + " BUY 005930");
        assertThat(store.orders.get(afterOpen).status()).as("R 시가는 주문 뒤가 아님(⑤) — 다음 관측 봉을 기다림")
                .isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(KrConfirmations.pendingThrough(store, KrPaperMarket.INSTANCE, KrRulesFixtures.CALENDAR,
                PaperBooks.KR_RULES, R)).as("확정 순자산 줄의 조건은 ⑤까지 봐 이 주문을 세지 않음").isEmpty();
        assertThat(KrConfirmations.pendingBefore(store, KrPaperMarket.INSTANCE, PaperBooks.KR_RULES, R))
                .extracting(Order::id).as("공통 거름 — 기준일 < D·체결하는 시점").containsExactly(afterOpen);

        store.markOrderStatus(afterOpen, PaperBooks.ORDER_CANCELLED, "시험 — 정리됨");
        PaperDecisionJob.Result decided = runAt("2026-11-02T22:40");
        assertThat(decided.outcome()).as("남은 두 대기 주문은 게이트 ①을 막지 않음").isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().response().path("gates").get(0).path("status").asString()).isEqualTo("PASS");
    }

    @Test
    @DisplayName("게이트 ①은 그 계좌 장부가 이 실행의 관측치를 처리했는지도 봄 — 규칙 계좌 장부 처리가 그 관측치에서 오류로 되돌려졌으면 대기 주문이 없어도 미달·기다림. 장부는 같은 관측치로 다시 시도하지 않고 수집기는 그 밤 새 저장본을 쓰지 않으므로(다음은 다음 KR 거래일 20:30 뒤) 원인을 고쳐도 기다림이 이어지고, 백엔드를 재기동하면(오류 기억이 지워짐) 그 창에서 결정")
    void gateOneNeedsTheLedgerToHaveProcessedTheObservation() {
        session(R);
        failLedgerFor = PaperBooks.KR_RULES;

        PaperDecisionJob.Result failed = runAt("2026-11-02T22:30");

        assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(failed.message()).contains("① kr_rules").contains("처리하지 못함")
                .contains("수집 2026-11-02 21:57 KST").contains("그 밤 새로 저장되지 않음").contains("백엔드 재기동")
                .doesNotContain("새 관측치에서");
        failLedgerFor = null;   // 원인은 풀렸지만 같은 관측치(운영 수집기는 '최신 상태'면 저장본을 다시 쓰지 않음)
        for (String at : List.of("2026-11-02T22:40", "2026-11-02T23:50")) {
            assertThat(runAt(at).outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        }
        assertThat(rulesDecisions()).as("출발 INITIAL뿐").hasSize(1);
        assertThat(krRuns()).as("기다림은 기록하지 않음").isEmpty();

        job = job(new PaperMarketData(reader, repository));   // 백엔드 재기동 — 장부의 오류 기억이 지워짐
        PaperDecisionJob.Result decided = runAt("2026-11-03T00:00");
        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.tradingDate()).isEqualTo(R);
        assertThat(decided.rules().response().path("gates").get(0).path("status").asString()).isEqualTo("PASS");
    }

    @Test
    @DisplayName("규칙 계좌 장부가 그 밤 관측치에서 오류로 되돌려진 채 재기동이 없으면 기한까지 ①로 기다리고 기한 뒤 NO_TRADE(기한 지남·waitedFor ①) — 다음 KR 거래일 관측치는 장부가 다시 시도해 처리하고 그날 재선정을 따라잡음")
    void ledgerErrorWithoutRestartEndsAsNoTrade() {
        session(R);
        failLedgerFor = PaperBooks.KR_RULES;
        assertThat(runAt("2026-11-02T22:30").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        failLedgerFor = null;
        assertThat(runAt("2026-11-03T00:50").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);

        PaperDecisionJob.Result late = runAt("2026-11-03T01:00");

        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.rules().status()).isEqualTo("NO_TRADE");
        assertThat(late.rules().response().path("noTradeReason").asString()).isEqualTo("기한 지남");
        assertThat(late.rules().response().path("waitedFor").toString()).contains("① kr_rules").contains("처리하지 못함")
                .doesNotContain("⑤");

        session(R1);   // 다음 KR 거래일 관측치(새 수집 시각) — 장부가 다시 시도함
        PaperDecisionJob.Result caught = runAt("2026-11-03T22:30");
        assertThat(caught.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(caught.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(caught.rules().response().path("catchUp").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("게이트 ①은 결정하는 계좌의 주문만 — 벤치마크 계좌(60/40)의 기준일 < D 대기 주문(153130 R 봉 없음으로 체결 못 함)이 있어도 규칙 계좌는 결정, 그 주문은 대기 그대로")
    void gateOneIsPerAccount() {
        quotes(R, Set.of("153130"));   // ②는 9/10 통과 — 153130만 R 봉이 없어 그 시가 주문이 체결되지 않음
        fsc(FRI);
        long bench = store.insertOrder(new Order(0, PaperBooks.KR_BENCH_MIX, null, "153130", PaperBooks.BUY, null, 40.0, null,
                PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_BENCHMARK, PaperBooks.ORDER_PENDING, null, null, FRI,
                kst("2026-10-30T22:30"), KrRulesFixtures.CALENDAR.addTradingDays(FRI, 3), null));

        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        JsonNode first = decided.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).startsWith("kr_rules").contains("대기 주문 없음");
        assertThat(store.orders.get(bench).status()).as("다른 계좌의 대기 주문은 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
    }

    @Test
    @DisplayName("일시정지 규칙 계좌 — 장부가 사고팔지 않아 남은 기준일 < D 대기 주문이 그 세션을 막지 않고 SKIPPED(입력·게이트·주문 없음)")
    void pausedBookIsNotHeldByGateOne() {
        session(R);
        long stale = pending("005930", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        store.updateBookStatus(PaperBooks.KR_RULES, PaperBooks.PAUSED);

        PaperDecisionJob.Result result = runAt("2026-11-02T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(result.rules().status()).isEqualTo(RuleBookService.STATUS_SKIPPED);
        assertThat(store.orders.get(stale).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.detail().path("rules").path("status").asString()).isEqualTo(RuleBookService.STATUS_SKIPPED);
            assertThat(run.detail().has("gates")).as("입력·게이트를 읽지 않음").isFalse();
        });
    }

    @Test
    @DisplayName("일시정지 규칙 계좌는 자료 게이트를 기다리지 않음 — ④ 미달인 밤에도 22:30에 SKIPPED(U·수급을 읽지 않음), 기한 뒤 첫 실행이어도 NO_TRADE가 아니라 SKIPPED")
    void pausedBookSkipsWithoutGates() {
        store.updateBookStatus(PaperBooks.KR_RULES, PaperBooks.PAUSED);
        quotes(R, Set.of());
        fsc(LocalDate.of(2026, 10, 29));   // ④ 미달

        PaperDecisionJob.Result skipped = runAt("2026-11-02T22:30");

        assertThat(skipped.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(skipped.rules().status()).isEqualTo(RuleBookService.STATUS_SKIPPED);
        assertThat(skipped.rules().kind()).as("재선정일 — 종류는 REBALANCE(따라잡기가 세지 않음)").isEqualTo(RuleBookService.REBALANCE);
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.never()).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), org.mockito.ArgumentMatchers.any(LocalDate.class));

        // 다음 세션은 그 밤 첫 실행이 기한 뒤 — 일시정지 계좌는 기한 지남 NO_TRADE가 아니라 SKIPPED.
        PaperDecisionJob.Result late = runAt("2026-11-04T01:00");
        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.tradingDate()).isEqualTo(R1);
        assertThat(late.rules().status()).isEqualTo(RuleBookService.STATUS_SKIPPED);
        assertThat(late.rules().response().path("pastDeadline").asBoolean()).isTrue();
        assertThat(late.rules().response().has("noTradeReason")).isFalse();
        assertThat(rulesDecisions()).extracting(d -> d.asOfTradingDate() + " " + d.status())
                .containsExactly("2026-10-29 OK", "2026-11-02 SKIPPED", "2026-11-03 SKIPPED");
    }

    @Test
    @DisplayName("보유 종목이 재선정일에 거래정지(KRX 매매정지·그날 거래량 0)면 '후보 밖' 매도 주문을 내지 않고 skipped에 사유 — 체결될 수 없는 주문이 만료(기준일 + 3거래일)까지 다음 결정의 게이트 ①을 막지 않게, 정지가 이어진 다음 밤도 정기 결정")
    void suspendedHoldingIsNotSoldIntoGateOne() {
        holding("000660", 100, 10_000);
        store.upsertState(new BookState(PaperBooks.KR_RULES, 99_000_000, 100_000_000, 1_000_000, 1.0, null, null, S, null));
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));
        fsc(FRI);

        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(store.ordersByDecision(decided.rules().id())).extracting(Order::ticker)
                .as("000660은 거래정지로 후보 밖이지만 그날 체결할 수 없어 매도하지 않음").containsExactly("005930", "105560", "153130");
        JsonNode skipped = decided.rules().response().path("skipped");
        assertThat(skipped).anySatisfy(row -> {
            assertThat(row.path("ticker").asString()).isEqualTo("000660");
            assertThat(row.path("reason").asString()).contains("재선정 — 후보 밖").contains("거래정지")
                    .contains("매도 주문을 내지 않음");
        });

        // 다음 밤 — 정지가 이어짐. 앞 결정의 다른 주문은 R1 시가에 체결되고, 체결될 수 없는 대기 주문이 없어 ①이 통과.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R1), "000660", true));
        fsc(R);
        PaperDecisionJob.Result next = runAt("2026-11-03T22:30");

        assertThat(next.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(next.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(next.rules().response().path("gates").get(0).path("status").asString()).isEqualTo("PASS");
        assertThat(store.positions(PaperBooks.KR_RULES)).extracting(Position::ticker).contains("000660");
    }

    @Test
    @DisplayName("기한이 지났는데 ⑤는 통과(④만 미달) — NO_TRADE 사유는 '기한 지남', 기다린 까닭은 waitedFor에")
    void pastDeadlineWithoutAnchorProblem() {
        quotes(R, Set.of());
        fsc(LocalDate.of(2026, 10, 29));
        assertThat(runAt("2026-11-02T23:30").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);

        PaperDecisionJob.Result late = runAt("2026-11-03T01:00");

        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.rules().status()).isEqualTo("NO_TRADE");
        assertThat(late.rules().response().path("noTradeReason").asString()).isEqualTo("기한 지남");
        assertThat(late.rules().response().path("waitedFor").toString()).contains("④").doesNotContain("⑤");
        assertThat(gateStatuses(late.rules().response().path("gates"))).as("23:30 판정 — 장부 전 게이트")
                .containsExactly("② PASS", "④ FAIL", "⑤ PASS", "⑥ PASS");
    }

    @Test
    @DisplayName("기한 지남 행의 게이트는 그 세션 기한 전 마지막 판정 — 00:50까지 ⑤로 기다렸는데 기한 직후 069500 D 봉이 들어와도 사유 '069500 D 봉 없음(휴장 또는 지연)'·waitedFor ⑤; 기한 전 판정이 없으면(그 밤 첫 실행이 기한 뒤) 지금 판정에 '기한 뒤 판정' 표시")
    void pastDeadlineKeepsTheLastWaitBeforeTheDeadline() {
        quotes(R, Set.of("069500"));
        fsc(FRI);
        assertThat(runAt("2026-11-03T00:50").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        quotes(R, Set.of());   // 00:55 slow가 01:01에 069500 R 봉을 다시 받음

        PaperDecisionJob.Result late = runAt("2026-11-03T01:07");

        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        JsonNode row = late.rules().response();
        assertThat(row.path("noTradeReason").asString()).as("기한까지 ⑤로 기다렸음").isEqualTo("069500 D 봉 없음(휴장 또는 지연)");
        assertThat(row.path("waitedFor").toString()).contains("⑤");
        assertThat(row.path("gatesJudgedAtKst").asString()).isEqualTo("2026-11-03 00:50 KST");
        assertThat(row.path("gatesBasis").asString()).isEqualTo("기한 전 마지막 판정");
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(gateStatuses(run.detail().path("gates"))).contains("⑤ FAIL");
            assertThat(run.detail().path("gatesBasis").asString()).isEqualTo("기한 전 마지막 판정");
        });

        // 다음 세션 — 그 밤 첫 실행이 기한 뒤(기한 전 판정 없음): 지금 저장본으로 판정하고 그렇게 표시.
        session(R1);
        PaperDecisionJob.Result first = runAt("2026-11-04T01:00");
        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(first.tradingDate()).isEqualTo(R1);
        assertThat(first.rules().response().path("noTradeReason").asString()).isEqualTo("기한 지남");
        assertThat(first.rules().response().path("gatesJudgedAtKst").asString()).isEqualTo("2026-11-04 01:00 KST");
        assertThat(first.rules().response().path("gatesBasis").asString()).startsWith("기한 뒤 판정");
        assertThat(gateStatuses(first.rules().response().path("gates"))).hasSize(6);
    }

    @Test
    @DisplayName("자정 넘은 재시도 — 23:50에는 ③ 미달(005930 R 기록을 23:58에 다시 받음), 00:10 실행이 기준 거래일 R 그대로 결정(읽은 순간 = 11-03 00:10 KST, 작업 기록도 다음 KST 날)하고, 다음 밤(R′)은 그 세션 결정을 따로 냄")
    void midnightRetryKeepsSessionD() {
        session(R);
        data.flow("005930", R, 100_000L, 50_000L, "2026-11-02T20:21:26.000+09:00", kst("2026-11-02T23:58"));
        PaperDecisionJob.Result beforeMidnight = runAt("2026-11-02T23:50");
        assertThat(beforeMidnight.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(beforeMidnight.message()).contains("③ U 7/8").contains("D 기록 없음 1(005930)");

        PaperDecisionJob.Result retry = runAt("2026-11-03T00:10");

        assertThat(retry.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(retry.tradingDate()).as("lastCompletedSession(11-03 00:10) = 11-02").isEqualTo(R);
        assertThat(retry.rules().asOfTradingDate()).isEqualTo(R);
        assertThat(retry.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(retry.rules().response().path("catchUp").asBoolean()).isFalse();
        assertThat(retry.rules().response().path("input").path("readAtKst").asString()).isEqualTo("2026-11-03 00:10 KST");
        assertThat(retry.rules().response().path("input").path("flowsWindow").path("to").asString()).isEqualTo("2026-11-02");
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.detail().path("tradingDate").asString()).isEqualTo("2026-11-02");
            assertThat(run.startedAt().atZone(Kst.ZONE).toLocalDate()).as("작업 기록은 다음 KST 날").isEqualTo(R1);
        });

        session(R1);
        PaperDecisionJob.Result next = runAt("2026-11-03T22:30");
        assertThat(next.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(next.rules().asOfTradingDate()).isEqualTo(R1);
        assertThat(next.rules().kind()).as("11-02 주기의 매수 결정이 있음 — 따라잡기 없음").isEqualTo(RuleBookService.SCHEDULED);
    }

    @Test
    @DisplayName("한국 수동 결정(Claude 계좌)도 결정 창·자료 게이트 안에서만(D1c) — 창 전·게이트 ④ 미달이면 400(Claude 부르지 않음), 통과하면 기준 거래일 D로 MANUAL·작업 기록에 게이트 ①(그 계좌)~⑥")
    void manualDecisionNeedsWindowAndGates() {
        ClaudeBookService claude = mock(ClaudeBookService.class);
        List<String> calls = new ArrayList<>();
        when(claude.decide(org.mockito.ArgumentMatchers.any(PaperMarket.class), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyBoolean())).thenAnswer(invocation -> {
                    LocalDate d = invocation.getArgument(1);
                    String kind = invocation.getArgument(2);
                    calls.add(d + " " + kind);
                    return new Decision(0, PaperBooks.KR_CLAUDE, d, kind, null, "NO_TRADE", "claude-sonnet-5-5", null, 1, null,
                            null, null, null, null, PaperFixtures.MAPPER.valueToTree(Map.of("summary", "주문 없음")), null,
                            null, null, false, 0L, 0);
                });
        StoreRepository repository = repository();
        data.install(repository, reader);
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        job = new PaperDecisionJob(store, reader, marketData, new PaperLedgerService(store, marketData, PaperFixtures.MAPPER),
                mock(PaperSelectionService.class), mock(RuleBookService.class), claude, PaperFixtures.settings(store),
                KrRuleBookServiceTest.config(), PaperFixtures.MAPPER, clock);
        quotes(R, Set.of());
        fsc(LocalDate.of(2026, 10, 29));

        clock.set(kst("2026-11-02T21:00"));
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> job.runNow(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE))
                .isInstanceOf(com.macrodash.support.InvalidRequestException.class)
                .hasMessageContaining("결정 창(2026-11-02 22:30 KST ~ 2026-11-03 01:00 KST 전)");
        clock.set(kst("2026-11-02T22:40"));
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> job.runNow(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE))
                .isInstanceOf(com.macrodash.support.InvalidRequestException.class)
                .hasMessageContaining("자료 게이트 미달").hasMessageContaining("④ 금융위 기준일 2026-10-29");
        assertThat(calls).isEmpty();
        assertThat(krRuns()).isEmpty();

        fsc(FRI);
        Decision manual = job.runNow(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE);
        assertThat(manual.asOfTradingDate()).isEqualTo(R);
        assertThat(calls).containsExactly("2026-11-02 MANUAL");
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.detail().path("manual").asBoolean()).isTrue();
            assertThat(gateStatuses(run.detail().path("gates"))).containsExactly("① PASS", "② PASS", "③ PASS", "④ PASS",
                    "⑤ PASS", "⑥ PASS");
            assertThat(run.detail().path("gates").get(0).path("note").asString()).startsWith("kr_claude");
        });
    }

    @Test
    @DisplayName("U 저장본이 없으면 게이트 ③ 미달 — 오류로 세지 않고 기다림(기록 없음, 포기 없음), 기한이 지나면 NO_TRADE(기한 지남, 기다린 까닭 ③)")
    void missingUniverseWaitsAtGateThree() {
        session(R);
        StoreRepository repository = repository();
        new KrRulesFixtures().install(repository, reader);   // U 없음 — 수급·DART도 빈 재료
        job = job(new PaperMarketData(reader, repository));

        for (String at : List.of("2026-11-02T22:30", "2026-11-02T22:40", "2026-11-02T22:50", "2026-11-02T23:00")) {
            PaperDecisionJob.Result waiting = runAt(at);
            assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
            assertThat(waiting.message()).contains("③ U·수급을 읽지 못함").contains("kr_paper_universe");
        }
        assertThat(rulesDecisions()).hasSize(1);
        assertThat(krRuns()).isEmpty();

        PaperDecisionJob.Result late = runAt("2026-11-03T01:00");
        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.rules().status()).isEqualTo("NO_TRADE");
        assertThat(late.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(late.rules().response().path("noTradeReason").asString()).isEqualTo("기한 지남");
        assertThat(late.rules().response().path("waitedFor").toString()).contains("③");
    }

    @Test
    @DisplayName("게이트를 통과한 뒤 규칙 계좌 결정이 예외면 그 계좌 오류로 셈 — ERROR 기록(게이트 포함), 세 번이면 그날은 더 시도하지 않고, 기한이 지나면 NO_TRADE 행")
    void decisionErrorCountsAsRulesFailure() {
        session(R);
        failRulesDecision = true;   // 게이트(장부 처리 포함)는 통과하고 결정 행 쓰기에서 예외

        for (String at : List.of("2026-11-02T22:30", "2026-11-02T22:40", "2026-11-02T22:50")) {
            PaperDecisionJob.Result failed = runAt(at);
            assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.ERROR);
            assertThat(failed.message()).contains("규칙 계좌").contains("시험용 결정 쓰기 오류");
        }
        assertThat(krRuns()).hasSize(3).allSatisfy(run -> assertThat(run.detail().path("gates").size()).isEqualTo(6));
        assertThat(runAt("2026-11-02T23:00").outcome()).isEqualTo(PaperDecisionJob.GAVE_UP);
        assertThat(rulesDecisions()).hasSize(1);

        failRulesDecision = false;
        PaperDecisionJob.Result late = runAt("2026-11-03T01:00");
        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.rules().status()).isEqualTo("NO_TRADE");
        assertThat(late.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(late.rules().response().path("waitedFor").toString()).as("게이트는 통과했음 — 오류로 결정하지 못함").isEqualTo("[]");
        assertThat(late.rules().response().path("noTradeReason").asString()).isEqualTo("기한 지남");
    }

    @Test
    @DisplayName("22:30에 ⑤로 기다린 뒤 22:40부터 ②④⑤⑥은 통과했는데 입력 읽기(수급)가 예외로 세 번 끝나 포기한 세션 — 기한 지남 행은 앞 주기의 ⑤ 기다림이 아니라 그 뒤 통과한 판정(사유 '기한 지남', waitedFor 빈 목록)")
    void pastDeadlineAfterErrorsBeyondTheCheapGates() {
        quotes(R, Set.of("069500"));
        fsc(FRI);
        assertThat(runAt("2026-11-02T22:30").message()).contains("⑤ 069500 2026-11-02 봉 없음");
        quotes(R, Set.of());   // 22:40부터 069500 R 봉 — 싼 게이트는 통과하고, 그 뒤 수급 읽기가 일시 오류
        org.mockito.Mockito.doThrow(new IllegalStateException("시험용 수급 읽기 오류")).when(repository).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), org.mockito.ArgumentMatchers.any(LocalDate.class));

        for (String at : List.of("2026-11-02T22:40", "2026-11-02T22:50", "2026-11-02T23:00")) {
            PaperDecisionJob.Result failed = runAt(at);
            assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.ERROR);
            assertThat(failed.message()).contains("시험용 수급 읽기 오류");
        }
        assertThat(runAt("2026-11-02T23:10").outcome()).isEqualTo(PaperDecisionJob.GAVE_UP);

        PaperDecisionJob.Result late = runAt("2026-11-03T01:00");

        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        JsonNode row = late.rules().response();
        assertThat(row.path("noTradeReason").asString()).as("⑤는 22:40부터 통과 — 오류로 결정하지 못함").isEqualTo("기한 지남");
        assertThat(row.path("waitedFor").toString()).isEqualTo("[]");
        assertThat(gateStatuses(row.path("gates"))).as("23:00 판정 — 장부 전 게이트 통과(①③은 그 뒤 오류로 판정 전)")
                .containsExactly("② PASS", "④ PASS", "⑤ PASS", "⑥ PASS");
        assertThat(row.path("gatesJudgedAtKst").asString()).isEqualTo("2026-11-02 23:00 KST");
        assertThat(row.path("gatesBasis").asString()).isEqualTo("기한 전 마지막 판정");
    }

    @Test
    @DisplayName("계좌 상태가 없어 장부가 그 계좌를 처리하지 못하면 게이트 ①(처리하지 못함)로 기다림 — 결정 예외로 세지 않음")
    void missingStateWaitsAtGateOne() {
        session(R);
        store.states.remove(PaperBooks.KR_RULES);

        PaperDecisionJob.Result waiting = runAt("2026-11-02T22:30");

        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(waiting.message()).contains("① kr_rules").contains("마지막 처리 없음");
    }
}
