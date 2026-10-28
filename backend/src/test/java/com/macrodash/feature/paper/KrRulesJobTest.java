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
 * {@code DATA_NOT_READY}, 이어진 기다림은 기록 한 줄 — E0), 재선정일 r(11-02)의 자료가 기한(11-03 01:00)까지 오지 않으면 기한 지남 NO_TRADE 행(그 순간의 게이트와 사유)이
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

    /**
     * 실제 한국 Claude 경로(E2b — {@link KrClaudeFixtures})의 결정 작업으로 바꾸고 Claude 계좌를 운용(출발 S)으로 둡니다. 재기동을 흉내 낼 때도
     * 같은 가짜 AI로 새 작업·새 서비스를 만듭니다.
     */
    private void realClaude(KrClaudeFixtures.FakeAi fake) {
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), KrClaudeFixtures.service(store, reader, repository, marketData, ledger,
                KrRuleBookServiceTest.config(), clock, fake.ai), PaperFixtures.settings(store),
                KrRuleBookServiceTest.config(), PaperFixtures.MAPPER, clock);
        store.updateBookStatus(PaperBooks.KR_CLAUDE, PaperBooks.ACTIVE);
        store.updateBookStartedOn(PaperBooks.KR_CLAUDE, S);
    }

    /** Claude 계좌의 기준일 FRI 대기 주문 — R 개장 뒤에 만들어 체결 조건 ⑤로 R 시가에 체결되지 않음(게이트 ①이 기다림, 결정 e3). */
    private long claudeOrderAfterTheOpen() {
        return store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE, null, "005930", PaperBooks.BUY, null, 5.0, null,
                PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null, null, FRI,
                kst("2026-11-02T10:00"), KrRulesFixtures.CALENDAR.addTradingDays(FRI, 3), null));
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
    @DisplayName("재선정일 r의 관측치가 기한까지 없음 → 기다림(DATA_NOT_READY, 기다림 한 줄) → r NO_TRADE(사유 '069500 D 봉 없음(휴장 또는 지연)'·그 순간의 게이트) → r′에 r′ 자료로 REBALANCE(cycleDate r·selectionAsOf r′) → 그 뒤 SCHEDULED(다시 선정 안 함)")
    void catchUpThroughTheJob() {
        session(FRI);   // 11-02 밤 — 그날 관측치가 끝내 오지 않음(저장본은 10-30 판)
        java.time.Instant processedBefore = store.state(PaperBooks.KR_RULES).orElseThrow().lastProcessedCollectedAt();
        PaperDecisionJob.Result waiting = runAt("2026-11-02T22:30");
        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(waiting.message()).contains("②").contains("관측치 세션 2026-10-30").contains("⑤")
                .contains("기한 2026-11-03 01:00 KST");
        assertThat(runAt("2026-11-03T00:50").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(krRuns()).as("이어진 기다림 둘은 한 줄(E0) — 끝 시각·마지막 판정은 00:50").singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
            assertThat(run.detail().path("checks").asInt()).isEqualTo(2);
            assertThat(run.startedAt()).isEqualTo(kst("2026-11-02T22:30"));
            assertThat(run.finishedAt()).isEqualTo(kst("2026-11-03T00:50"));
            assertThat(run.detail().path(PaperDecisionJob.RULES_GATES).path("judgedAtKst").asString())
                    .isEqualTo("2026-11-03 00:50 KST");
        });
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
        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.DATA_NOT_READY, PaperDecisionJob.PAST_DEADLINE);
        assertThat(krRuns().get(1)).satisfies(run -> {
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
    @DisplayName("게이트 하나씩 미달이면 결정하지 않음(DATA_NOT_READY, 결정 없음·이어진 기다림은 기록 한 줄) — ② 범위 8/10 · ④ 금융위 기준일 · ⑤ 069500 D 봉(②는 9/10 통과) · ③ U 7/8(장중 판) · ① 기준일 < D 대기 주문; 다 고치면 그 창에서 결정")
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
        // 1분봉 FAILED 기다림 — 그 종목 R 봉(관측 봉)의 1분봉 개장 봉을 아직 받지 못해 기준일 10-30 주문이 체결되지 않고 대기(장부가 아직 일하는
        // 주문 — 봉이 없는 주문은 ①이 기다리지 않음, 사용자 결정 u2).
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.minuteFailed(KrRulesFixtures.quotes(R), "005930"));
        PaperDecisionJob.Result ledger = runAt("2026-11-02T23:10");
        assertThat(ledger.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(ledger.message()).contains("① kr_rules").contains("#" + stale + " BUY 005930(기준일 2026-10-30)")
                .contains("정리 안 됨");
        assertThat(rulesDecisions()).as("출발 INITIAL뿐").hasSize(1);
        assertThat(krRuns()).as("이어진 기다림 다섯은 한 줄(E0) — 마지막 판정 ①").singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
            assertThat(run.detail().path("checks").asInt()).isEqualTo(5);
            assertThat(run.detail().path("waiting").asString()).contains("① kr_rules").contains("#" + stale);
            assertThat(gateStatuses(run.detail().path(PaperDecisionJob.RULES_GATES).path("gates")))
                    .containsExactly("① FAIL", "② PASS", "③ PASS", "④ PASS", "⑤ PASS", "⑥ PASS");
        });

        store.markOrderStatus(stale, PaperBooks.ORDER_CANCELLED, "시험 — 정리됨");
        quotes(R, Set.of());
        PaperDecisionJob.Result decided = runAt("2026-11-02T23:20");
        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(decided.rules().response().path("catchUp").asBoolean()).as("기다림은 그 세션 안 — 따라잡기 아님").isFalse();
        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.DATA_NOT_READY, PaperDecisionJob.DECIDED);
        assertThat(krRuns().get(1).detail().has(PaperDecisionJob.RULES_GATES)).as("결정한 실행은 판정을 남기지 않음(결정 행이 사실)")
                .isFalse();
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
        assertThat(krRuns()).extracting(JobRun::outcome).containsExactly(PaperDecisionJob.DATA_NOT_READY);

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
        assertThat(krRuns()).as("이어진 기다림 셋은 한 줄(E0)").singleElement()
                .satisfies(run -> assertThat(run.detail().path("checks").asInt()).isEqualTo(3));

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
    @DisplayName("게이트 ①은 결정하는 계좌의 주문만 — 벤치마크 계좌(60/40)의 기준일 < D 대기 주문(153130 R 봉의 1분봉 FAILED로 장부가 기다림)이 있어도 규칙 계좌는 결정, 그 주문은 대기 그대로")
    void gateOneIsPerAccount() {
        // 153130 R 봉은 관측 봉인데 1분봉 개장 봉을 아직 받지 못함 — 장부가 아직 일하는 주문(그 계좌의 ①이라면 막는 주문)
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.minuteFailed(KrRulesFixtures.quotes(R), "153130"));
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
    @DisplayName("게이트 ①은 계좌마다(Claude 계좌 쪽, 실제 한국 Claude 경로 — E2b) — Claude 계좌에만 기준일 < D 대기 주문이 있으면 규칙 계좌는 결정·DECIDED(Claude 칸에 ① 사유, Claude 부르지 않음), 다음 주기는 Claude만 남아 DATA_NOT_READY(기다림 한 줄 — 규칙 계좌 판정은 남기지 않음), 정리되면 그 주기에 Claude만 결정(한국 패킷·한국 스키마·한국 렌더링, 동결본 = 보낸 패킷, 응답에 그 계좌 ① + ②~⑥)")
    void gateOneHoldsTheClaudeBookAlone() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(0, "관망 — 수급 확인 전"));
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        ClaudeBookService claude = KrClaudeFixtures.service(store, reader, repository, marketData, ledger,
                KrRuleBookServiceTest.config(), clock, fake.ai);
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), claude, PaperFixtures.settings(store), KrRuleBookServiceTest.config(),
                PaperFixtures.MAPPER, clock);
        store.updateBookStatus(PaperBooks.KR_CLAUDE, PaperBooks.ACTIVE);
        store.updateBookStartedOn(PaperBooks.KR_CLAUDE, S);
        session(R);
        // R 개장 뒤에 만든 기준일 10-30 주문 — 체결 조건 ⑤로 R 시가에 체결되지 않아 대기(게이트 ①은 대기 그대로 셈, 결정 e3).
        long held = store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE, null, "005930", PaperBooks.BUY, null, 5.0, null,
                PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null, null, FRI,
                kst("2026-11-02T10:00"), KrRulesFixtures.CALENDAR.addTradingDays(FRI, 3), null));

        PaperDecisionJob.Result first = runAt("2026-11-02T22:30");

        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(first.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(first.claude()).isNull();
        assertThat(fake.requests).as("Claude를 부르지 않음").isEmpty();
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
            assertThat(run.detail().path("claude").asString()).startsWith("자료 게이트 미달 — 다음 주기에 다시: ① kr_claude")
                    .contains("#" + held + " BUY 005930(기준일 2026-10-30)");
            assertThat(gateStatuses(run.detail().path("gates"))).as("규칙 계좌 ① · Claude 계좌 ① · ②~⑥")
                    .containsExactly("① PASS", "① FAIL", "② PASS", "③ PASS", "④ PASS", "⑤ PASS", "⑥ PASS");
        });

        PaperDecisionJob.Result waiting = runAt("2026-11-02T22:40");
        assertThat(waiting.outcome()).as("규칙 계좌는 이미 결정 — Claude만 ①로 기다림").isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(waiting.message()).contains("① kr_claude").doesNotContain("kr_rules");
        assertThat(krRuns()).as("기다림 한 줄(E0)").extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.DECIDED, PaperDecisionJob.DATA_NOT_READY);
        assertThat(krRuns().get(1).detail().has(PaperDecisionJob.RULES_GATES)).as("규칙 계좌는 이미 결정 — 그 판정은 남기지 않음")
                .isFalse();
        assertThat(gateStatuses(krRuns().get(1).detail().path("gates"))).contains("① FAIL");
        assertThat(rulesDecisions()).as("규칙 계좌 결정은 그 세션에 한 번").hasSize(2);
        assertThat(fake.requests).isEmpty();

        store.markOrderStatus(held, PaperBooks.ORDER_CANCELLED, "시험 — 정리됨");
        PaperDecisionJob.Result decided = runAt("2026-11-02T22:50");
        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().id()).as("규칙 계좌는 그 결정 그대로").isEqualTo(first.rules().id());
        Decision row = decided.claude();
        assertThat(row.bookCode()).isEqualTo(PaperBooks.KR_CLAUDE);
        assertThat(row.kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(row.asOfTradingDate()).as("기준 거래일 = lastCompletedSession(그날)").isEqualTo(R);
        assertThat(row.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(row.settingsVersion()).as("그 실행이 읽은 판").isEqualTo(store.settings.version());
        assertThat(fake.requests).singleElement().satisfies(request -> {
            assertThat(request.user()).as("결정 행 동결본 = 보낸 패킷 글자").isEqualTo(row.packetText());
            assertThat(request.system()).as("한국 렌더링(K34)").contains("우선순위(고정)").doesNotContain("주문 최소 $");
            assertThat(request.schema().toString()).as("한국 스키마 — timing은 NEXT_OPEN뿐").contains("NEXT_OPEN")
                    .doesNotContain("NEXT_OBSERVATION");
            assertThat(request.timeoutSeconds()).isEqualTo(ClaudeBookService.DEFAULT_TIMEOUT_SECONDS);
        });
        assertThat(row.packet().path("1_basis").path("market").asString()).isEqualTo("KR");
        assertThat(row.packet().path("1_basis").path("packetVersion").asInt()).isEqualTo(KrPacketBuilder.PACKET_VERSION);
        assertThat(row.packet().path("1_basis").path("readAtKst").asString()).as("읽은 순간 = 그 실행의 지금")
                .isEqualTo("2026-11-02 22:50 KST");
        assertThat(gateStatuses(row.response().path("gates"))).as("결정 행에 그 계좌 ① + ②~⑥")
                .containsExactly("① PASS", "② PASS", "③ PASS", "④ PASS", "⑤ PASS", "⑥ PASS");
        assertThat(krRuns()).last().satisfies(run -> {
            assertThat(run.detail().path("rules").path("existing").asBoolean()).isTrue();
            assertThat(run.detail().path("claude").path("status").asString()).isEqualTo("NO_TRADE");
        });
        assertThat(runAt("2026-11-02T23:00").outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(fake.requests).as("그 세션에 한 번").hasSize(1);
    }

    @Test
    @DisplayName("사용자 결정 v4(E2b) — 기한 지난 세션의 Claude 계좌는 부르지 않고 SKIPPED 행: 규칙 계좌는 22:30에 결정했고 Claude만 ①로 00:50까지 기다렸으면 그 행의 판정은 저장된 Claude 몫의 기한 전 마지막 판정(00:50 — ① kr_claude FAIL, 사유 '기한 지남'), 재기동해도 다시 쓰지 않고 기한 지남 기록은 한 번")
    void claudePastDeadlineRowUsesTheStoredClaudeJudgement() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        realClaude(fake);
        session(R);
        long held = claudeOrderAfterTheOpen();

        assertThat(runAt("2026-11-02T22:30").outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.detail().has(PaperDecisionJob.RULES_GATES)).as("규칙 계좌는 결정 — 그 판정은 남기지 않음").isFalse();
            assertThat(gateStatuses(run.detail().path(PaperDecisionJob.CLAUDE_GATES).path("gates")))
                    .as("Claude 몫 판정(① 그 계좌 · ②~⑥)").containsExactly("① FAIL", "② PASS", "③ PASS", "④ PASS", "⑤ PASS", "⑥ PASS");
        });
        assertThat(runAt("2026-11-03T00:50").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        quotes(R, Set.of("069500"));   // 기한 직후 069500 R 봉이 빠진 저장본 — 지금 판정하면 ⑤ 미달이지만 기한 전 판정을 씀

        PaperDecisionJob.Result missed = runAt("2026-11-03T01:00");

        assertThat(missed.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(missed.rules()).as("규칙 계좌는 22:30 결정 — 기한 지남 행 없음").isNull();
        Decision row = missed.claude();
        assertThat(row.bookCode()).isEqualTo(PaperBooks.KR_CLAUDE);
        assertThat(row.asOfTradingDate()).isEqualTo(R);
        assertThat(row.kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(row.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(row.model()).as("Claude를 부르지 않음").isNull();
        assertThat(row.packet()).isNull();
        assertThat(row.pricesFinal()).isFalse();
        assertThat(row.response().path("summary").asString())
                .isEqualTo("결정 기한(2026-11-03 01:00 KST)이 지나 Claude를 부르지 않았습니다 — 그날 재량 주문 없음");
        assertThat(row.response().path("skippedReason").asString()).isEqualTo("기한 지남");
        assertThat(row.response().path("pastDeadline").asBoolean()).isTrue();
        assertThat(row.response().path("deadlineKst").asString()).isEqualTo("2026-11-03 01:00 KST");
        assertThat(row.response().path("gatesJudgedAtKst").asString()).isEqualTo("2026-11-03 00:50 KST");
        assertThat(row.response().path("gatesBasis").asString()).isEqualTo("기한 전 마지막 판정");
        assertThat(gateStatuses(row.response().path("gates"))).containsExactly("① FAIL", "② PASS", "③ PASS", "④ PASS",
                "⑤ PASS", "⑥ PASS");
        assertThat(row.response().path("waitedFor").toString()).contains("① kr_claude").contains("#" + held);
        assertThat(fake.requests).isEmpty();
        assertThat(store.ordersByDecision(row.id())).isEmpty();
        assertThat(store.orders.get(held).status()).as("대기 주문은 장부 몫 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(krRuns()).last().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
            assertThat(run.detail().path("claude").path("status").asString()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        });

        assertThat(runAt("2026-11-03T01:10").outcome()).as("그 세션 일이 행으로 끝남").isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        realClaude(fake);   // 재기동
        assertThat(runAt("2026-11-03T01:20").outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(store.decisionsOf(PaperBooks.KR_CLAUDE)).as("그 세션 Claude 행은 하나").hasSize(1);
        assertThat(krRuns()).extracting(JobRun::outcome).containsExactly(PaperDecisionJob.DECIDED,
                PaperDecisionJob.DATA_NOT_READY, PaperDecisionJob.PAST_DEADLINE);
    }

    @Test
    @DisplayName("사용자 결정 v4(E2b) — 그 밤 첫 실행이 기한 뒤면 Claude 행의 판정은 그 순간의 판정('기한 뒤 판정', ⑤ 미달이면 사유 '069500 D 봉 없음'), 재시도 차례인 API 오류 행이 있으면 기한이 그 재시도를 씀(같은 행·재시도 1회·사유 덧붙임, 부르지 않음)")
    void claudePastDeadlineJudgesNowOrConsumesTheRetry() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        realClaude(fake);
        quotes(R, Set.of("069500"));
        fsc(FRI);

        PaperDecisionJob.Result late = runAt("2026-11-03T01:05");

        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.rules().status()).isEqualTo("NO_TRADE");
        Decision row = late.claude();
        assertThat(row.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(row.response().path("skippedReason").asString()).isEqualTo("069500 D 봉 없음(휴장 또는 지연)");
        assertThat(row.response().path("summary").asString()).contains("— 069500 D 봉 없음(휴장 또는 지연)");
        assertThat(row.response().path("gatesBasis").asString()).startsWith("기한 뒤 판정");
        assertThat(row.response().path("gatesJudgedAtKst").asString()).isEqualTo("2026-11-03 01:05 KST");
        assertThat(gateStatuses(row.response().path("gates")))
                .as("① Claude 계좌(기한 뒤 작업은 장부를 처리하지 않아 이번 관측치 처리 전 — 미달) · ②~⑥ — 지금 판정")
                .containsExactly("① FAIL", "② PASS", "③ PASS", "④ PASS", "⑤ FAIL", "⑥ PASS");
        assertThat(row.response().path("gates").get(0).path("note").asString()).startsWith("kr_claude");
        assertThat(fake.requests).isEmpty();

        // 다음 세션: 22:30 API 오류 → 재시도 차례인 채 기한이 지남 → 기한이 그 재시도를 씀.
        fake.fail("API_ERROR", "overloaded");
        session(R1);
        PaperDecisionJob.Result failed = runAt("2026-11-03T22:30");
        assertThat(failed.claude().status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(failed.claude().retryCount()).isZero();

        // 그 사이 결정 작업이 돌지 못함(서버 지연 등) — 다음 실행이 기한 순간.
        PaperDecisionJob.Result consumed = runAt("2026-11-04T01:00");

        assertThat(consumed.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(consumed.claude().id()).as("같은 행").isEqualTo(failed.claude().id());
        assertThat(consumed.claude().status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(consumed.claude().retryCount()).isEqualTo(1);
        assertThat(consumed.claude().error()).contains("[API_ERROR] overloaded")
                .contains("재시도 안 함: 결정 기한(2026-11-04 01:00 KST)이 지나 Claude를 부르지 않았습니다");
        assertThat(fake.requests).as("22:30 한 번뿐").hasSize(1);
        assertThat(runAt("2026-11-04T01:10").outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
    }

    @Test
    @DisplayName("자정 넘은 한국 Claude 재시도(2단계 명세 §4-10·§5, 실제 한국 경로 — E2b): 22:30 API 오류 → D+1 00:10 실행의 기준 거래일은 lastCompletedSession = D 그대로 같은 행을 다시 내고(재시도 1회), 호출 수는 다음 KST 날 줄에 셈")
    void krClaudeMidnightRetryKeepsTheSessionAndCountsOnTheNextDay() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.fail("API_ERROR", "overloaded").answer(KrClaudeFixtures.decision(0, "관망"));
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), KrClaudeFixtures.service(store, reader, repository, marketData, ledger,
                KrRuleBookServiceTest.config(), clock, fake.ai), PaperFixtures.settings(store),
                KrRuleBookServiceTest.config(), PaperFixtures.MAPPER, clock);
        store.updateBookStatus(PaperBooks.KR_CLAUDE, PaperBooks.ACTIVE);
        store.updateBookStartedOn(PaperBooks.KR_CLAUDE, S);
        session(R);

        PaperDecisionJob.Result first = runAt("2026-11-02T22:30");
        assertThat(first.claude().status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(first.claude().retryCount()).isZero();
        assertThat(store.apiUsage(R).map(com.macrodash.store.PaperStore.ApiUsage::calls)).contains(1);

        PaperDecisionJob.Result retried = runAt("2026-11-03T00:10");
        assertThat(retried.tradingDate()).as("자정 넘은 실행도 세션 D").isEqualTo(R);
        assertThat(retried.claude().id()).as("같은 행을 다시 냄").isEqualTo(first.claude().id());
        assertThat(retried.claude().asOfTradingDate()).isEqualTo(R);
        assertThat(retried.claude().status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(retried.claude().retryCount()).isEqualTo(1);
        assertThat(store.apiUsage(LocalDate.of(2026, 11, 3)).map(com.macrodash.store.PaperStore.ApiUsage::calls))
                .as("호출 상한 줄 = Kst.today() — 다음 KST 날").contains(1);
        assertThat(store.apiUsage(R).map(com.macrodash.store.PaperStore.ApiUsage::calls)).as("세션 날 줄은 그대로").contains(1);
        assertThat(retried.claude().packet().path("1_basis").path("readAtKst").asString()).isEqualTo("2026-11-03 00:10 KST");
        assertThat(fake.requests).hasSize(2);
        assertThat(runAt("2026-11-03T00:20").outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
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
    @DisplayName("보유 종목이 재선정일에 거래정지(KRX 매매정지·그날 거래량 0)여도 '후보 밖' 매도 주문을 냄(사용자 결정 u2 — 52db145의 매도 쪽 되돌림, 지금 체결할 수 없는 사유는 notes) — 정지가 이어진 다음 밤 게이트 ①은 그 주문을 기다리지 않고 정기 결정, 정지가 만료 안에 풀리면 재개일 시가에 팔림(K10 이탈이 다음 재선정까지 미뤄지지 않음)")
    void suspendedHoldingIsSoldWithoutHoldingGateOne() {
        holding("000660", 100, 10_000);
        store.upsertState(new BookState(PaperBooks.KR_RULES, 99_000_000, 100_000_000, 1_000_000, 1.0, null, null, S, null));
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));
        fsc(FRI);

        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(store.ordersByDecision(decided.rules().id())).extracting(Order::ticker, Order::side)
                .as("000660은 거래정지로 후보 밖 — 그날 체결할 수 없어도 매도 주문").containsExactly(
                        org.assertj.core.groups.Tuple.tuple("000660", "SELL"),
                        org.assertj.core.groups.Tuple.tuple("005930", "BUY"),
                        org.assertj.core.groups.Tuple.tuple("105560", "BUY"),
                        org.assertj.core.groups.Tuple.tuple("153130", "BUY"));
        Order sell = store.ordersByDecision(decided.rules().id()).get(0);
        assertThat(sell.reason().path("reasons").toString()).contains("OUT_OF_CANDIDATES");
        assertThat(decided.rules().response().path("skipped")).noneMatch(row -> "000660".equals(row.path("ticker").asString()));
        assertThat(decided.rules().response().path("notes")).extracting(JsonNode::asString).anySatisfy(note ->
                assertThat(note).startsWith("000660 매도 신호(재선정 — 후보 밖)").contains("지금은 체결할 수 없음(2026-11-02 거래정지"));

        // 다음 밤 — 정지가 이어짐. 앞 결정의 다른 주문은 R1 시가에 체결되고, 000660 매도는 체결할 수 없어 ①이 기다리지 않음.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R1), "000660", true));
        fsc(R);
        PaperDecisionJob.Result next = runAt("2026-11-03T22:30");

        assertThat(next.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(next.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        JsonNode first = next.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).contains("#" + sell.id() + " SELL 000660").contains("기다리지 않음");
        assertThat(store.orders.get(sell.id()).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.positions(PaperBooks.KR_RULES)).extracting(Position::ticker).contains("000660");

        // R2 — 정지가 풀림(R1 봉은 정지일 봉 그대로). 만료(R + 3거래일) 안이라 R2 시가에 팔림.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspendedOn(KrRulesFixtures.quotes(R2), "000660", R1));
        fsc(R1);
        assertThat(runAt("2026-11-04T22:30").outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.get(sell.id()).status()).isEqualTo("FILLED");
        assertThat(store.positions(PaperBooks.KR_RULES)).extracting(Position::ticker).doesNotContain("000660");
    }

    @Test
    @DisplayName("주문 뒤에 시작된 정지(사용자 결정 u2 ⓑ) — R 결정의 매도가 R1부터 정지된 종목에 걸려도 R1 게이트 ①은 그 주문을 기다리지 않고 정기 결정(주문은 대기 그대로, 다시 내지 않음), 확정 순자산 줄 조건은 그 주문을 셈(R1 줄 잠정), 정지가 만료 안에 풀리면 재개일(R2) 시가에 체결")
    void suspensionAfterTheOrderDoesNotHoldGateOne() {
        holding("373220", 100, 10_000);   // 20일 외국인·기관 둘 다 순매도 — 매일 매도 신호
        store.upsertState(new BookState(PaperBooks.KR_RULES, 99_000_000, 100_000_000, 1_000_000, 1.0, null, null, S, null));
        session(R);
        PaperDecisionJob.Result placed = runAt("2026-11-02T22:30");
        assertThat(placed.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        Order sell = store.ordersByDecision(placed.rules().id()).stream()
                .filter(o -> "373220".equals(o.ticker()) && PaperBooks.SELL.equals(o.side())).findFirst().orElseThrow();

        // R1 — 373220 거래정지(KRX 매매정지·R1 봉 거래량 0). 다른 R 주문은 R1 시가에 체결.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R1), "373220", true));
        fsc(R);
        PaperDecisionJob.Result next = runAt("2026-11-03T22:30");

        assertThat(next.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(next.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        JsonNode first = next.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).startsWith("kr_rules")
                .contains("#" + sell.id() + " SELL 373220(기준일 2026-11-02)").contains("기준일 뒤 관측 봉(거래량 > 0)이 없음")
                .contains("기다리지 않음").contains("대기 그대로");
        assertThat(store.orders.get(sell.id()).status()).as("주문은 살아 있음").isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.ordersByDecision(placed.rules().id())).filteredOn(o -> o.id() != sell.id())
                .allSatisfy(o -> assertThat(o.status()).isEqualTo("FILLED"));
        assertThat(store.ordersByDecision(next.rules().id())).as("대기 매도가 있어 다시 내지 않음")
                .noneMatch(o -> "373220".equals(o.ticker()));
        assertThat(KrConfirmations.pendingThrough(store, KrPaperMarket.INSTANCE, KrRulesFixtures.CALENDAR,
                PaperBooks.KR_RULES, R1)).as("확정 순자산 줄 조건은 ①의 면제를 쓰지 않음 — 다음 저장본이 지난 봉을 채우면 R1 날짜로 체결될 수 있음")
                .singleElement(org.assertj.core.api.InstanceOfAssertFactories.STRING)
                .contains("주문 " + sell.id() + " SELL 373220");

        // R2 — 정지가 풀림(R1 봉은 정지일 봉 그대로, R2 봉 관측). 만료(R + 3거래일) 안이라 R2 시가에 체결.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspendedOn(KrRulesFixtures.quotes(R2), "373220", R1));
        fsc(R1);
        PaperDecisionJob.Result lifted = runAt("2026-11-04T22:30");

        assertThat(lifted.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.get(sell.id()).status()).isEqualTo("FILLED");
        assertThat(store.fillsOf(PaperBooks.KR_RULES)).filteredOn(f -> "373220".equals(f.ticker())).singleElement()
                .satisfies(f -> assertThat(f.observationDate()).as("재개일 시가").isEqualTo(R2));
        assertThat(store.positions(PaperBooks.KR_RULES)).extracting(Position::ticker).doesNotContain("373220");
    }

    /**
     * 재선정일 R — 보유 000660({@code qty}주, 평단 10,000)과 현금 {@code cash}, 000660이 R 거래정지라 후보 밖. 결정 작업이 R 22:30에 낸 규칙 계좌
     * 주문(매도 000660 · 매수 둘 · 153130).
     */
    private List<Order> suspendedHoldingOnTheReselectionDay(int qty, double cash) {
        holding("000660", qty, 10_000);
        store.upsertState(new BookState(PaperBooks.KR_RULES, cash, cash + qty * 10_000.0, qty * 10_000.0,
                qty * 10_000.0 / (cash + qty * 10_000.0) * 100, null, null, S, null));
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));
        fsc(FRI);
        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");
        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        List<Order> orders = store.ordersByDecision(decided.rules().id());
        assertThat(orders).extracting(Order::ticker, Order::side).containsExactly(
                org.assertj.core.groups.Tuple.tuple("000660", "SELL"), org.assertj.core.groups.Tuple.tuple("005930", "BUY"),
                org.assertj.core.groups.Tuple.tuple("105560", "BUY"), org.assertj.core.groups.Tuple.tuple("153130", "BUY"));
        return orders;
    }

    /** 그 주문들의 매수가 모두 요청대로 체결됐나 — FILLED이고 현금 한도로 줄지 않음(cashLimited 없음). */
    private void everyBuyFilledInFull(List<Order> orders) {
        for (Order planned : orders) {
            if (PaperBooks.BUY.equals(planned.side())) {
                Order now = store.orders.get(planned.id());
                assertThat(now.status()).as(planned.ticker()).isEqualTo("FILLED");
                assertThat(now.reason().has("cashLimited")).as(planned.ticker() + " — 현금 한도로 줄지 않음").isFalse();
            }
        }
    }

    @Test
    @DisplayName("재선정일에 거래정지인 보유의 '후보 밖' 매도 대금은 선정의 현금 어림에서 뺌(사용자 결정 u3) — 정지가 R1에도 이어져 그 매도가 대기로 남아도 R 결정의 종목 둘·153130 매수는 R1 시가에 요청 수량대로 모두 체결(cashLimited 없음 — 손계산)")
    void unfillableSellLeftOutSoEveryBuyFillsAtTheNextOpen() {
        List<Order> orders = suspendedHoldingOnTheReselectionDay(2_000, 80_000_000);
        // R 장부가 000660을 R 종가 10,100으로 평가 → 순자산 100,200,000. 종목 둘 = 6,680,033.40원 × (1 + 6.5bp) × 2 = 13,368,750.8434원,
        // 153130 = (80,000,000 − 13,368,750.8434) ÷ 100,200,000 − 여유 0.5%p = 65.9983%
        // (000660 대금 20,200,000 × (1 − 26.5bp) = 20,146,470원을 넣으면 86.1045% — R1 시가 현금으로는 그만큼 못 삼).
        assertThat(orders).extracting(Order::targetWeightPct).containsExactly(null, 6.6667, 6.6667, 65.9983);

        // R1 — 정지가 이어짐. 000660 매도는 대기 그대로(① 면제), 나머지는 R1 시가에.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R1), "000660", true));
        fsc(R);
        assertThat(runAt("2026-11-03T22:30").outcome()).isEqualTo(PaperDecisionJob.DECIDED);

        assertThat(store.orders.get(orders.get(0).id()).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        everyBuyFilledInFull(orders);
        // R1 시가(종목 10,000·153130 108,000, 비용 원 미만 절사): 005930 667주 6,674,335 · 105560 667주 6,674,335 ·
        // 153130 611주(65.9983% × 순자산 100,191,330 ÷ 108,070.2) 66,030,892 → 현금 80,000,000 − 79,379,562 = 620,438원.
        assertThat(store.fillsOf(PaperBooks.KR_RULES)).extracting(f -> f.ticker() + " " + f.qty())
                .containsExactly("005930 667", "105560 667", "153130 611");
        assertThat(store.state(PaperBooks.KR_RULES).orElseThrow().cash()).as("R1 시가 체결 뒤 현금").isEqualTo(620_438.0);
    }

    @Test
    @DisplayName("선정한 날 뒤 매일 결정도 대기 중인 정지 매도의 대금은 남는 현금 어림에서 뺌(사용자 결정 u4 ⑤) — 정지가 이어진 R1 결정은 그 대금으로 153130을 사지 않음(현금 0.62% — NO_TRADE, 매도는 대기 그대로), 정지가 풀린 R2 시가에 그 매도가 체결되면 R2 결정이 남는 현금 규칙(기준 2% 넘음)으로 153130 park_cash 20.059%(손계산)")
    void dailyDecisionsLeaveOutThePendingSuspendedSellUntilItFills() {
        List<Order> orders = suspendedHoldingOnTheReselectionDay(2_000, 80_000_000);

        // R1 — 정지가 이어짐(R 결정의 매수는 R1 시가에 모두 체결 → 현금 620,438원, 위 시험).
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R1), "000660", true));
        fsc(R);
        PaperDecisionJob.Result r1 = runAt("2026-11-03T22:30");
        assertThat(r1.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(r1.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        // R1 매일 결정: 000660 대기 매도(20,200,000 × (1 − 26.5bp) = 20,146,470원)는 지금 체결할 수 없어 뺌 → 현금 620,438원 ÷ 순자산
        // 100,294,058 = 0.6186% ≤ 기준 2% — 153130을 사지 않음(넣으면 20.7060% → 153130 20.206%를 내고, 정지가 R2에도 이어지면 그 매수가
        // 현금 한도로 5주만 체결돼 R2 결정이 같은 주문을 되풀이했음).
        assertThat(r1.rules().status()).isEqualTo("NO_TRADE");
        assertThat(store.ordersByDecision(r1.rules().id())).isEmpty();
        assertThat(store.orders.get(orders.get(0).id()).status()).as("매도는 대기 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.state(PaperBooks.KR_RULES).orElseThrow().cash()).isEqualTo(620_438.0);
        assertThat(r1.rules().response().path("notes")).extracting(JsonNode::asString).anySatisfy(note ->
                assertThat(note).startsWith("000660 대기 매도 — 지금은 체결할 수 없음(2026-11-03 거래정지")
                        .contains("그 대금을 현금 어림에서 뺐음"));

        // R2 — 정지가 풀림(R1 봉은 정지일 봉 그대로, R2 봉 관측 — 시가 10,000). 만료(R + 3거래일) 안이라 R2 시가에 팔림.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspendedOn(KrRulesFixtures.quotes(R2), "000660", R1));
        fsc(R1);
        PaperDecisionJob.Result r2 = runAt("2026-11-04T22:30");
        assertThat(r2.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.get(orders.get(0).id()).status()).isEqualTo("FILLED");
        // R2 시가: 000660 2,000주 × 10,000 매도 +19,947,000(수수료 3,000·슬리피지 10,000·거래세 10,000·농특세 30,000) → 현금 20,567,438원.
        assertThat(store.fillsOf(PaperBooks.KR_RULES)).filteredOn(f -> f.observationDate().equals(R2))
                .extracting(f -> f.ticker() + " " + f.side() + " " + f.qty()).containsExactly("000660 SELL 2000");
        assertThat(store.state(PaperBooks.KR_RULES).orElseThrow().cash()).isEqualTo(20_567_438.0);
        // R2 매일 결정: 남는 현금 20,567,438 ÷ 순자산 100,041,058(R2 종가 평가 — 10,100 × 1,334 + 108,020 × 611) = 20.5590% > 기준 2%
        // → 여유 0.5%p를 남기고 20.0590%를 153130에(park_cash — 신호 매수가 아닌 현금 관리).
        assertThat(r2.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        List<Order> parked = store.ordersByDecision(r2.rules().id());
        assertThat(parked).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("153130", "BUY", 20.059));
        assertThat(parked.get(0).reason().path("rule").asString()).isEqualTo(KrRuleBookService.RULE_PARK_DAILY);
        assertThat(parked.get(0).reason().path("thresholdPct").asDouble()).isEqualTo(2.0);
    }

    @Test
    @DisplayName("정지가 R1에 풀리면(u3의 맞바꿈) — 어림에 넣지 않은 000660 매도가 R1 시가에 체결되고 그 대금은 현금으로 남아, R1 정기 결정이 남는 현금 규칙(기준 2% 넘음)으로 153130 park_cash 매수(손계산)")
    void liftedSuspensionSellsAndTheProceedsFollowTheParkCashRule() {
        List<Order> orders = suspendedHoldingOnTheReselectionDay(2_000, 80_000_000);

        // R1 — 정지가 풀림(R 봉은 정지일 봉 그대로, R1 봉 관측 — 시가 10,000).
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspendedOn(KrRulesFixtures.quotes(R1), "000660", R));
        fsc(R);
        PaperDecisionJob.Result next = runAt("2026-11-03T22:30");

        assertThat(next.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.get(orders.get(0).id()).status()).isEqualTo("FILLED");
        assertThat(store.fillsOf(PaperBooks.KR_RULES)).filteredOn(f -> "000660".equals(f.ticker())).singleElement()
                .satisfies(f -> assertThat(f.observationDate()).as("재개일 시가").isEqualTo(R1));
        everyBuyFilledInFull(orders);
        // R1 시가: 000660 2,000주 × 10,000 매도 +19,947,000(수수료 3,000·슬리피지 10,000·거래세 10,000·농특세 30,000) → 현금 99,947,000,
        // 005930·105560 665주씩 6,654,322원씩, 153130 610주 65,922,822원 → 현금 20,715,534원.
        assertThat(store.fillsOf(PaperBooks.KR_RULES)).extracting(f -> f.ticker() + " " + f.side() + " " + f.qty())
                .containsExactly("000660 SELL 2000", "005930 BUY 665", "105560 BUY 665", "153130 BUY 610");
        assertThat(store.state(PaperBooks.KR_RULES).orElseThrow().cash()).isEqualTo(20_715_534.0);
        // R1 정기 결정: 남는 현금 20,715,534 ÷ 순자산 100,040,734(R1 종가 평가 — 10,100 × 1,330 + 108,020 × 610) = 20.7071% > 기준 2%
        // → 여유 0.5%p를 남기고 20.2071%를 153130에(park_cash — 신호 매수가 아닌 현금 관리).
        assertThat(next.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        List<Order> parked = store.ordersByDecision(next.rules().id());
        assertThat(parked).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("153130", "BUY", 20.2071));
        assertThat(parked.get(0).reason().path("rule").asString()).isEqualTo(KrRuleBookService.RULE_PARK_DAILY);
        assertThat(parked.get(0).reason().path("thresholdPct").asDouble()).isEqualTo(2.0);
    }

    @Test
    @DisplayName("정지가 R1에 풀렸는데 그 대금이 작으면(1%) 현금으로 남음(u3의 맞바꿈 — 남는 현금이 기준 2% 이하라 153130을 사지 않음, R1 정기 결정 NO_TRADE)")
    void liftedSuspensionBelowTheThresholdStaysCash() {
        List<Order> orders = suspendedHoldingOnTheReselectionDay(100, 99_000_000);

        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspendedOn(KrRulesFixtures.quotes(R1), "000660", R));
        fsc(R);
        PaperDecisionJob.Result next = runAt("2026-11-03T22:30");

        assertThat(store.orders.get(orders.get(0).id()).status()).isEqualTo("FILLED");
        everyBuyFilledInFull(orders);
        assertThat(next.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(next.rules().status()).isEqualTo("NO_TRADE");
        assertThat(store.ordersByDecision(next.rules().id())).isEmpty();
        // R1 시가: 000660 100주 매도 +997,350 → 현금 99,997,350, 005930·105560 666주씩 6,664,329원씩, 153130 787주(85.1480%) 85,051,247원
        // → 현금 1,617,445원 ÷ 순자산 100,082,385(R1 종가 평가) = 1.6161% ≤ 기준 2% — 153130을 사지 않고 현금으로 둠.
        BookState state = store.state(PaperBooks.KR_RULES).orElseThrow();
        assertThat(state.cash()).isEqualTo(1_617_445.0);
        assertThat(state.cash() / state.nav() * 100).as("남는 현금(순자산 %)")
                .isCloseTo(1.6161, org.assertj.core.data.Offset.offset(0.0001)).isLessThan(2.0);
    }

    @Test
    @DisplayName("153130으로 모자란 현금을 다 메울 수 없는 재선정일(u3 — 종목 매수도 다음 시가에 있을 현금으로) — 정지 보유의 대금을 빼고 153130을 전량 팔아도 모자라 105560 매수를 줄여 내고, 정지가 R1에도 이어져도 그 매수는 R1 시가에 요청 수량대로 체결(cashLimited 없음)")
    void trimmedStockBuyFillsInFullWhenTheSuspensionContinues() {
        holding("000660", 2_000, 10_000);   // R 거래정지 — 후보 밖, 매도는 대기로 남음
        holding("005930", 7_500, 10_000);   // 후보지만 이미 목표 이상
        holding("153130", 20, 108_000);     // 2,160,000원 — 전량 팔아도 모자람
        store.upsertState(new BookState(PaperBooks.KR_RULES, 3_000_000, 100_160_000, 97_160_000, 97.0048, null, null, S, null));
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));
        fsc(FRI);
        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");
        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        List<Order> orders = store.ordersByDecision(decided.rules().id());
        // R 장부 평가(종목 10,100·153130 108,020) → 순자산 101,110,400. 어림 = 3,000,000 − 105560 6,740,727.0368 × (1 + 6.5bp)
        // = −3,745,108.5094원 → 메울 현금 4,250,660.5094원 중 153130 전량 2,160,400 × (1 − 6.5bp) = 2,158,995.74원만 셈 → 남은 2,091,664.7694원을
        // 105560에서: (6,745,108.5094 − 2,091,664.7694) ÷ (1 + 6.5bp) = 4,650,420.97원 → 4.5993%(내림, 고치기 전 6.6667%).
        assertThat(orders).extracting(Order::ticker, Order::side, Order::targetWeightPct).containsExactly(
                org.assertj.core.groups.Tuple.tuple("000660", "SELL", null),
                org.assertj.core.groups.Tuple.tuple("105560", "BUY", 4.5993),
                org.assertj.core.groups.Tuple.tuple("153130", "SELL", null));

        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R1), "000660", true));
        fsc(R);
        assertThat(runAt("2026-11-03T22:30").outcome()).isEqualTo(PaperDecisionJob.DECIDED);

        assertThat(store.orders.get(orders.get(0).id()).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.orders.get(orders.get(2).id()).status()).isEqualTo("FILLED");
        everyBuyFilledInFull(orders);
        // R1 시가: 153130 20주 매도(현금 3,000,000 + 그 대금) → 105560 464주(4.5993% × 체결 직전 순자산) → 현금 515,580원(여유 약 0.5%p).
        assertThat(store.fillsOf(PaperBooks.KR_RULES)).extracting(f -> f.ticker() + " " + f.side() + " " + f.qty())
                .containsExactly("153130 SELL 20", "105560 BUY 464");
        assertThat(store.state(PaperBooks.KR_RULES).orElseThrow().cash()).as("R1 시가 체결 뒤 현금").isEqualTo(515_580.0);
    }

    @Test
    @DisplayName("1분봉 FAILED 기다림은 게이트 ①을 그대로 막음(관측 봉이 있음 — 장부가 아직 일하는 주문), 같은 밤 정지 종목의 대기 주문은 막지 않음 — 그 밤 다음 slow가 1분봉을 받아 장부가 체결하면 ① 통과")
    void minuteFailedWaitStillHoldsGateOne() {
        long waiting = pending("005930", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        long suspended = pending("373220", PaperBooks.SELL, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.minuteFailed(
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "373220", true), "005930"));
        fsc(FRI);

        PaperDecisionJob.Result blocked = runAt("2026-11-02T22:30");

        assertThat(blocked.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(blocked.message()).contains("① kr_rules — 기준일 < 2026-11-02인 대기 주문 1건 #" + waiting + " BUY 005930")
                .contains("그 밖의 대기 주문 1건은 장부가 이번 관측치로 체결할 수 없어 기다리지 않음 #" + suspended + " SELL 373220");
        assertThat(store.orders.get(waiting).status()).isEqualTo(PaperBooks.ORDER_PENDING);

        // 그 밤 다음 slow(22:57 저장)가 그 봉을 다시 받아 FAILED가 풀린 판(여기서는 1분봉 칸 없이 — 일봉 시가 사다리) — 새 수집 시각이라 장부가
        // 다시 처리해 체결.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.recollected(KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "373220", true),
                        kst("2026-11-02T22:57")));
        PaperDecisionJob.Result decided = runAt("2026-11-02T23:00");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.get(waiting).status()).isEqualTo("FILLED");
        assertThat(store.orders.get(suspended).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        JsonNode first = decided.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).contains("#" + suspended + " SELL 373220").contains("기다리지 않음");
    }

    @Test
    @DisplayName("미처리 기업행위 보유(장부가 그 종목 주문을 보류)의 대기 주문은 게이트 ①을 막지 않음 — 그 종목 R 봉이 관측 봉이어도, 주문은 대기 그대로")
    void corporateActionHoldDoesNotHoldGateOne() {
        holding("000660", 100, 10_000);
        store.holdForCorpAction(PaperBooks.KR_RULES, "000660", "큰 변동 — 3중 조건 미충족");
        store.upsertState(new BookState(PaperBooks.KR_RULES, 99_000_000, 100_000_000, 1_000_000, 1.0, null, null, S, null));
        long held = pending("000660", PaperBooks.SELL, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        session(R);

        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        JsonNode first = decided.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).contains("#" + held + " SELL 000660").contains("미처리 기업행위 보유(큰 변동")
                .contains("기다리지 않음");
        assertThat(store.orders.get(held).status()).as("장부가 보류 — 대기 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
    }

    @Test
    @DisplayName("분할·병합을 반영한 밤(장부가 그날 그 종목 주문을 보류 — 저장하지 않는 보류)의 대기 주문도 게이트 ①을 막지 않음 — 재선정일 R에 정지된 보유의 '후보 밖' 매도가 R1 2:1 분할 재상장(관측 봉 있음)에 걸려도 R1 정기 결정, 주문은 대기 그대로이고 R2에 분할 뒤 수량 전부가 팔림")
    void splitNightHoldDoesNotHoldGateOne() {
        holding("000660", 100, 10_000);
        store.upsertState(new BookState(PaperBooks.KR_RULES, 99_000_000, 100_000_000, 1_000_000, 1.0, null, null, S, null));
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));
        fsc(FRI);
        PaperDecisionJob.Result placed = runAt("2026-11-02T22:30");
        Order sell = store.ordersByDecision(placed.rules().id()).stream()
                .filter(o -> "000660".equals(o.ticker()) && PaperBooks.SELL.equals(o.side())).findFirst().orElseThrow();

        // R1 — 2:1 분할 재상장: R 봉은 정지일 봉(수정 비율 0.5 — 분할 뒤 단위로 고친 판), R1 봉은 관측 봉(원시가 절반·거래량 두 배, 비율 1).
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.rebar(
                KrRulesFixtures.rebar(KrRulesFixtures.quotes(R1), "000660", R, 10_050, 10_050, 0, 0.5),
                "000660", R1, 5_000, 5_050, 200_000, 1.0));
        fsc(R);
        PaperDecisionJob.Result next = runAt("2026-11-03T22:30");

        assertThat(next.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(next.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(store.positions(PaperBooks.KR_RULES)).filteredOn(p -> "000660".equals(p.ticker())).singleElement()
                .satisfies(p -> assertThat(p.qty()).as("장부가 분할을 반영").isEqualTo(200));
        JsonNode first = next.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).contains("#" + sell.id() + " SELL 000660")
                .contains("장부가 이번 관측치로는 보류").contains("분할·병합").contains("기다리지 않음");
        assertThat(store.orders.get(sell.id()).status()).as("장부가 그날 보류 — 대기 그대로").isEqualTo(PaperBooks.ORDER_PENDING);

        // R2 — 분할 뒤 첫 밤(since = R1). 새 사건이 없어 보류가 풀리고 분할 뒤 수량 전부를 팖.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.rebar(
                KrRulesFixtures.rebar(KrRulesFixtures.quotes(R2), "000660", R1, 5_000, 5_050, 200_000, 1.0),
                "000660", R2, 5_050, 5_100, 150_000, 1.0));
        fsc(R1);
        assertThat(runAt("2026-11-04T22:30").outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.get(sell.id()).status()).isEqualTo("FILLED");
        assertThat(store.fillsOf(PaperBooks.KR_RULES)).filteredOn(f -> "000660".equals(f.ticker())).singleElement()
                .satisfies(f -> assertThat(f.qty()).isEqualTo(200));
    }

    @Test
    @DisplayName("E0(사용자 결정 v3) 재기동 — 장부가 그 밤 관측치에서 그날 보류한 주문(분할 재상장 밤의 '후보 밖' 매도)은 주문 행 표시(V16)로 남아, 백엔드를 다시 띄운 뒤(장부는 그 관측치를 다시 처리하지 않음)에도 게이트 ①이 기다리지 않고 그 창에서 정기 결정, 다음 관측치 처리가 표시를 지움")
    void ledgerHoldSurvivesARestart() {
        holding("000660", 100, 10_000);
        store.upsertState(new BookState(PaperBooks.KR_RULES, 99_000_000, 100_000_000, 1_000_000, 1.0, null, null, S, null));
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.suspend(KrRulesFixtures.quotes(R), "000660", true));
        fsc(FRI);
        PaperDecisionJob.Result placed = runAt("2026-11-02T22:30");
        Order sell = store.ordersByDecision(placed.rules().id()).stream()
                .filter(o -> "000660".equals(o.ticker()) && PaperBooks.SELL.equals(o.side())).findFirst().orElseThrow();

        // R1 — 2:1 분할 재상장 밤. 22:30 실행이 장부를 처리(분할 반영·그 매도 그날 보류)했는데 ③(005930 R1 수급이 장중 판)으로 기다림.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.rebar(
                KrRulesFixtures.rebar(KrRulesFixtures.quotes(R1), "000660", R, 10_050, 10_050, 0, 0.5),
                "000660", R1, 5_000, 5_050, 200_000, 1.0));
        fsc(R);
        data.flow("005930", R1, 100_000L, 50_000L, "2026-11-03T14:58:03.000+09:00", kst("2026-11-03T21:18"));
        PaperDecisionJob.Result waiting = runAt("2026-11-03T22:30");
        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(waiting.message()).contains("③ U 7/8").doesNotContain("①");
        assertThat(store.positions(PaperBooks.KR_RULES)).filteredOn(p -> "000660".equals(p.ticker())).singleElement()
                .satisfies(p -> assertThat(p.qty()).as("장부가 그 관측치를 처리함(분할 반영)").isEqualTo(200));
        assertThat(store.ledgerHolds(PaperBooks.KR_RULES)).singleElement().satisfies(hold -> {
            assertThat(hold.orderId()).isEqualTo(sell.id());
            assertThat(hold.collectedAt()).as("그 관측치의 수집 시각").isEqualTo(kst("2026-11-03T21:57"));
            assertThat(hold.reason()).contains("분할·병합");
        });

        // 재기동 — 새 장부·결정 작업(메모리 비움), 같은 저장소. 저녁 판 수급이 들어옴.
        job = job(new PaperMarketData(reader, repository));
        data.flow("005930", R1, 100_000L, 50_000L, "2026-11-03T20:21:26.000+09:00", kst("2026-11-03T22:35"));
        PaperDecisionJob.Result decided = runAt("2026-11-03T22:40");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        JsonNode first = decided.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).contains("#" + sell.id() + " SELL 000660")
                .contains("장부가 이번 관측치로는 보류").contains("분할·병합").contains("기다리지 않음");
        assertThat(store.positions(PaperBooks.KR_RULES)).filteredOn(p -> "000660".equals(p.ticker())).singleElement()
                .satisfies(p -> assertThat(p.qty()).as("그 관측치를 다시 처리하지 않음(분할을 두 번 반영하지 않음)").isEqualTo(200));
        assertThat(store.orders.get(sell.id()).status()).isEqualTo(PaperBooks.ORDER_PENDING);

        // R2 — 분할 뒤 첫 밤. 새 관측치 처리가 보류를 풀고(표시를 지움) 분할 뒤 수량 전부를 팖.
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.rebar(
                KrRulesFixtures.rebar(KrRulesFixtures.quotes(R2), "000660", R1, 5_000, 5_050, 200_000, 1.0),
                "000660", R2, 5_050, 5_100, 150_000, 1.0));
        fsc(R1);
        assertThat(runAt("2026-11-04T22:30").outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.get(sell.id()).status()).isEqualTo("FILLED");
        assertThat(store.ledgerHoldMarks).as("다음 처리가 표시를 지움").isEmpty();
    }

    @Test
    @DisplayName("보유 없는 주문 종목의 기업행위 신호(장부가 그날 그 종목 주문을 보류 — since가 주문 기준일로 고정돼 만료까지 밤마다 되풀이)도 게이트 ①을 막지 않음 — 기준일 FRI 대기 매수 005930의 R 봉이 가격제한폭 밖이면 R 정기 결정, 주문은 대기 그대로")
    void orderOnlyCorporateActionHoldDoesNotHoldGateOne() {
        long held = pending("005930", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES,
                KrRulesFixtures.rebar(KrRulesFixtures.quotes(R), "005930", R, 15_000, 15_000, 120_000, 1.0));
        fsc(FRI);

        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        JsonNode first = decided.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).contains("#" + held + " BUY 005930")
                .contains("장부가 이번 관측치로는 보류").contains("가격제한폭").contains("기다리지 않음");
        assertThat(store.orders.get(held).status()).as("장부가 그날 보류 — 대기 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
    }

    @Test
    @DisplayName("관측치에 그 종목 항목이 아예 없는 대기 주문(수집 범위 밖 — U 밖 보유 034020의 매도)은 게이트 ①을 막지 않음 — 그 밤 정기 결정, 주문은 대기 그대로")
    void outOfScopeOrderDoesNotHoldGateOne() {
        store.upsertPosition(new Position(PaperBooks.KR_RULES, "034020", 100, 10_000, S, kst("2026-10-30T09:00"), 10_000,
                kst("2026-10-30T09:00"), 10_000.0, kst("2026-10-30T21:57"), false, S, 10_000, null));
        store.upsertState(new BookState(PaperBooks.KR_RULES, 99_000_000, 100_000_000, 1_000_000, 1.0, null, null, S, null));
        long out = pending("034020", PaperBooks.SELL, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        session(R);
        assertThat(KrRulesFixtures.quotes(R).payload().path("codes").has("034020")).as("수집 범위 밖").isFalse();

        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        JsonNode first = decided.rules().response().path("gates").get(0);
        assertThat(first.path("status").asString()).isEqualTo("PASS");
        assertThat(first.path("note").asString()).contains("#" + out + " SELL 034020").contains("수집 범위 밖·봉 없음")
                .contains("기다리지 않음");
        assertThat(store.orders.get(out).status()).isEqualTo(PaperBooks.ORDER_PENDING);
    }

    @Test
    @DisplayName("이어받은 항목(isStale)의 기준일 뒤 관측 봉은 센다(D2b) — 장부는 이어받은 봉으로 체결하지 않아 그 주문을 기다리고, 게이트 ①도 '정리 안 됨'으로 기다림(DATA_NOT_READY)")
    void staleEntryStillHoldsGateOne() {
        long waiting = pending("005930", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, FRI,
                "2026-10-30T22:30");
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.stale(KrRulesFixtures.quotes(R), "005930"));
        fsc(FRI);

        PaperDecisionJob.Result blocked = runAt("2026-11-02T22:30");

        assertThat(blocked.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(blocked.message()).contains("① kr_rules — 기준일 < 2026-11-02인 대기 주문 1건 #" + waiting + " BUY 005930")
                .contains("정리 안 됨").doesNotContain("기다리지 않음");
        assertThat(store.orders.get(waiting).status()).as("장부는 이어받은 봉으로 체결하지 않음").isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(rulesDecisions()).noneMatch(d -> R.equals(d.asOfTradingDate()));
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
        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.DATA_NOT_READY, PaperDecisionJob.PAST_DEADLINE);
        assertThat(krRuns().get(1)).satisfies(run -> {
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
    @DisplayName("E0(사용자 결정 v3) 재기동 — 기한 지남 행은 저장된 기한 전 마지막 판정으로: 00:50까지 ⑤로 기다린 뒤 백엔드를 다시 띄우고 기한 직후 069500 D 봉이 들어와도 사유 '069500 D 봉 없음'·'기한 전 마지막 판정'(00:50), 행 쓰기가 실패해 다시 띄운 뒤 쓴 행도 같고 기한 지남 기록은 그 세션에 한 번")
    void pastDeadlineUsesTheStoredJudgementAfterARestart() {
        quotes(R, Set.of("069500"));
        fsc(FRI);
        assertThat(runAt("2026-11-02T22:30").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        assertThat(runAt("2026-11-03T00:50").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        quotes(R, Set.of());   // 기한 직후 069500 R 봉이 들어옴 — 지금 판정하면 ⑤ 통과
        failRulesDecision = true;

        job = job(new PaperMarketData(reader, repository));   // 재기동 — 결정 작업의 메모리가 빔
        PaperDecisionJob.Result first = runAt("2026-11-03T01:00");
        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(first.rules()).as("행을 쓰지 못함 — 다음 주기에 다시").isNull();

        failRulesDecision = false;
        job = job(new PaperMarketData(reader, repository));   // 다시 재기동
        PaperDecisionJob.Result retry = runAt("2026-11-03T01:10");

        assertThat(retry.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        JsonNode row = retry.rules().response();
        assertThat(row.path("noTradeReason").asString()).as("기한까지 ⑤로 기다렸음(저장된 판정)")
                .isEqualTo("069500 D 봉 없음(휴장 또는 지연)");
        assertThat(row.path("waitedFor").toString()).contains("⑤");
        assertThat(row.path("gatesJudgedAtKst").asString()).isEqualTo("2026-11-03 00:50 KST");
        assertThat(row.path("gatesBasis").asString()).isEqualTo("기한 전 마지막 판정");
        assertThat(gateStatuses(row.path("gates"))).as("00:50 판정 — 장부 전 게이트(②는 9/10 통과)").containsExactly("② PASS", "④ PASS", "⑤ FAIL", "⑥ PASS");
        assertThat(krRuns()).extracting(JobRun::outcome).as("기한 지남 기록은 재기동을 넘어 한 번")
                .containsExactly(PaperDecisionJob.DATA_NOT_READY, PaperDecisionJob.PAST_DEADLINE);
        assertThat(krRuns().get(1).detail().path("gatesBasis").asString()).isEqualTo("기한 전 마지막 판정");
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
        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.DATA_NOT_READY, PaperDecisionJob.DECIDED);
        assertThat(krRuns().get(1)).satisfies(run -> {
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
    @DisplayName("한국 수동 결정(Claude 계좌)도 결정 창·자료 게이트 안에서만(D1c) — 창 전·게이트 ④ 미달이면 400(Claude 부르지 않음), 통과하면 기준 거래일 D로 MANUAL·작업 기록에 게이트 ①(그 계좌)~⑥, 실제 한국 경로(E2b — 그 실행의 관측치·읽은 순간, 수동 호출이라 상한 − 예약 문턱)")
    void manualDecisionNeedsWindowAndGates() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(0, "관망"));
        StoreRepository repository = repository();
        data.install(repository, reader);
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        ClaudeBookService claude = KrClaudeFixtures.service(store, reader, repository, marketData, ledger,
                KrRuleBookServiceTest.config(), clock, fake.ai);
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), claude, PaperFixtures.settings(store), KrRuleBookServiceTest.config(),
                PaperFixtures.MAPPER, clock);
        store.updateBookStatus(PaperBooks.KR_CLAUDE, PaperBooks.ACTIVE);
        store.updateBookStartedOn(PaperBooks.KR_CLAUDE, S);
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
        assertThat(fake.requests).isEmpty();
        assertThat(krRuns()).isEmpty();

        fsc(FRI);
        Decision manual = job.runNow(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE);
        assertThat(manual.asOfTradingDate()).isEqualTo(R);
        assertThat(manual.kind()).isEqualTo(RuleBookService.MANUAL);
        assertThat(manual.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(fake.requests).singleElement().satisfies(request ->
                assertThat(request.user()).isEqualTo(manual.packetText()));
        assertThat(manual.packet().path("1_basis").path("readAtKst").asString()).isEqualTo("2026-11-02 22:40 KST");
        assertThat(gateStatuses(manual.response().path("gates"))).containsExactly("① PASS", "② PASS", "③ PASS",
                "④ PASS", "⑤ PASS", "⑥ PASS");
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.detail().path("manual").asBoolean()).isTrue();
            assertThat(gateStatuses(run.detail().path("gates"))).containsExactly("① PASS", "② PASS", "③ PASS", "④ PASS",
                    "⑤ PASS", "⑥ PASS");
            assertThat(run.detail().path("gates").get(0).path("note").asString()).startsWith("kr_claude");
        });

        // 수동 호출은 상한 20 − 정기 작업 몫 7 = 13 미만일 때만(2단계 명세 §4-10) — 다음 KR 세션의 수동 결정은 부르지 않고 SKIPPED.
        session(R1);
        java.time.LocalDate today = java.time.LocalDate.of(2026, 11, 3);
        clock.set(kst("2026-11-03T22:40"));
        store.apiUsage.put(today, new com.macrodash.store.PaperStore.ApiUsage(today, 13, 0, 0, 0, 0));
        Decision capped = job.runNow(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE);
        assertThat(capped.asOfTradingDate()).isEqualTo(R1);
        assertThat(capped.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(capped.response().path("summary").asString()).contains("정기 작업 몫 7회를 남겨 수동 호출은 13회까지");
        assertThat(fake.requests).hasSize(1);
    }

    @Test
    @DisplayName("U 저장본이 없으면 게이트 ③ 미달 — 오류로 세지 않고 기다림(기다림 한 줄, 포기 없음), 기한이 지나면 NO_TRADE(기한 지남, 기다린 까닭 ③)")
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
        assertThat(krRuns()).as("오류 기록 없이 기다림 한 줄").singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
            assertThat(run.detail().path("checks").asInt()).isEqualTo(4);
        });

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
    @DisplayName("기한 지남 NO_TRADE 행 쓰기가 실패하면 다음 주기에 다시 씀 — 작업 기록 PAST_DEADLINE은 그 세션에 한 번(01:00 행 없음·기록 → 01:10 행 씀·기록 그대로 → 01:20 ALREADY_DECIDED)")
    void pastDeadlineRowIsRetriedAfterAWriteError() {
        quotes(R, Set.of("069500"));
        fsc(FRI);
        assertThat(runAt("2026-11-02T23:00").outcome()).isEqualTo(PaperDecisionJob.DATA_NOT_READY);
        failRulesDecision = true;

        PaperDecisionJob.Result first = runAt("2026-11-03T01:00");

        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(first.rules()).as("행을 쓰지 못함").isNull();
        assertThat(rulesDecisions()).as("출발 INITIAL뿐").hasSize(1);
        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.DATA_NOT_READY, PaperDecisionJob.PAST_DEADLINE);
        assertThat(krRuns().get(1)).satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
            assertThat(run.detail().path("rules").asString()).contains("기한 지남 NO_TRADE 행을 쓰지 못함")
                    .contains("다음 주기에 다시");
        });

        failRulesDecision = false;
        PaperDecisionJob.Result retry = runAt("2026-11-03T01:10");

        assertThat(retry.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(retry.rules()).as("다음 주기에 다시 씀").isNotNull();
        assertThat(retry.rules().status()).isEqualTo("NO_TRADE");
        assertThat(retry.rules().response().path("noTradeReason").asString()).as("기한 전 마지막 판정(23:00 ⑤)")
                .isEqualTo("069500 D 봉 없음(휴장 또는 지연)");
        assertThat(rulesDecisions()).extracting(d -> d.asOfTradingDate() + " " + d.kind() + " " + d.status())
                .containsExactly("2026-10-29 INITIAL OK", "2026-11-02 REBALANCE NO_TRADE");
        assertThat(krRuns()).as("기한 지남 기록은 그 세션에 한 번(기다림 한 줄 + 기한 지남)").hasSize(2);
        assertThat(runAt("2026-11-03T01:20").outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(krRuns()).hasSize(2);
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
