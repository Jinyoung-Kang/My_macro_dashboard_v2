package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
 * 한국 규칙 계좌를 결정 작업으로 끝까지(2단계 명세 §4-6·§4-9·§5 'K33', D1b): 재선정일 r(11-02)의 관측치가 기한(11-03 01:00)까지 오지 않으면 기한
 * 지남 NO_TRADE 행이 남고, 다음 KR 결정일 r′(11-03)에 r′ 자료로 REBALANCE(cycleDate r·selectionAsOf r′)를 내며, 그 뒤(11-04)에는 다시 선정하지
 * 않는다. 외부 호출 없음 — 가짜 저장소·가짜 저장본 읽기·움직이는 시계.
 */
class KrRulesJobTest {

    private FakePaperStore store;
    private StoreReader reader;
    private KrFixtures.MovableClock clock;
    private PaperDecisionJob job;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        StoreRepository repository = mock(StoreRepository.class);
        // 금융위 시장 구분(비용 종목 구분) — 표준 U 여덟 종목 모두 코스피.
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(LocalDate.of(2026, 10, 30));
        when(repository.readObservationsFor(eq(Datasets.OBS_FSC_PRICE), org.mockito.ArgumentMatchers.any(LocalDate.class),
                anyCollection())).thenAnswer(invocation -> {
                    Collection<String> codes = invocation.getArgument(2);
                    Map<String, JsonNode> out = new LinkedHashMap<>();
                    codes.forEach(code -> out.put(code, PaperFixtures.MAPPER.createObjectNode().put("market", "KOSPI")));
                    return out;
                });
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        clock = new KrFixtures.MovableClock(kst("2026-10-28T12:00"));
        KrRuleBookServiceTest.startedBooks(store, reader, marketData, clock);
        KrRulesFixtures.standard(LocalDate.of(2026, 10, 28), S, LocalDate.of(2026, 10, 30), R, R1, R2)
                .install(repository, reader);
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), mock(ClaudeBookService.class), PaperFixtures.settings(store),
                KrRuleBookServiceTest.config(), PaperFixtures.MAPPER, clock);
    }

    private void quotes(LocalDate session) {
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrRulesFixtures.quotes(session));
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

    @Test
    @DisplayName("재선정일 r의 관측치가 기한까지 없음 → r NO_TRADE(기한 지남) → r′에 r′ 자료로 REBALANCE(cycleDate r·selectionAsOf r′) → 그 뒤 SCHEDULED(다시 선정 안 함)")
    void catchUpThroughTheJob() {
        quotes(LocalDate.of(2026, 10, 30));   // 11-02 밤 — 그날 관측치가 끝내 오지 않음(저장본은 10-30 판)
        assertThat(runAt("2026-11-02T22:30").outcome()).isEqualTo(PaperDecisionJob.PRICES_NOT_FINAL);
        assertThat(runAt("2026-11-03T00:50").outcome()).isEqualTo(PaperDecisionJob.PRICES_NOT_FINAL);

        PaperDecisionJob.Result missed = runAt("2026-11-03T01:00");
        assertThat(missed.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(missed.tradingDate()).isEqualTo(R);
        assertThat(missed.rules()).satisfies(row -> {
            assertThat(row.kind()).isEqualTo(RuleBookService.REBALANCE);
            assertThat(row.status()).isEqualTo("NO_TRADE");
            assertThat(row.response().path("noTradeReason").asString()).isEqualTo("기한 지남");
            assertThat(row.response().path("cycleDate").asString()).isEqualTo("2026-11-02");
        });
        assertThat(store.ordersByDecision(missed.rules().id())).isEmpty();
        assertThat(runAt("2026-11-03T01:10").outcome()).as("규칙 계좌 일은 행으로 끝남").isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
            assertThat(run.detail().path("rules").path("status").asString()).isEqualTo("NO_TRADE");
            assertThat(run.detail().path("rules").path("kind").asString()).isEqualTo("REBALANCE");
            assertThat(run.detail().path("claude").asString()).contains("시작 전");
        });

        quotes(R1);
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

        // 11-04 밤 — 11-03 주문은 11-04 시가에 체결되고(장부), 그 주기 매수 결정이 있으니 다시 고르지 않음.
        quotes(R2);
        PaperDecisionJob.Result after = runAt("2026-11-04T22:30");
        assertThat(after.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(after.rules().kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(store.ordersByDecision(rebalance.id())).allSatisfy(o -> assertThat(o.status()).isEqualTo("FILLED"));
        assertThat(store.ordersByDecision(after.rules().id())).noneMatch(o -> "BUY".equals(o.side())
                && !"153130".equals(o.ticker()));
        assertThat(after.rules().response().path("notes").toString()).contains("재선정일이 아니라 사지 않습니다");
        assertThat(rulesDecisions()).extracting(d -> d.asOfTradingDate() + " " + d.kind() + " " + d.status()).containsExactly(
                "2026-10-29 INITIAL OK", "2026-11-02 REBALANCE NO_TRADE", "2026-11-03 REBALANCE OK",
                "2026-11-04 SCHEDULED " + after.rules().status());
    }

    @Test
    @DisplayName("기한 안에 관측치가 오면 재선정일 당일 REBALANCE(따라잡기 아님) — 결정 시각 전에는 기다림, 같은 세션 다시 돌면 ALREADY_DECIDED")
    void reselectionOnTheDay() {
        quotes(R);
        assertThat(runAt("2026-11-02T22:29").outcome()).isEqualTo(PaperDecisionJob.TOO_EARLY);
        PaperDecisionJob.Result decided = runAt("2026-11-02T22:30");

        assertThat(decided.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
        assertThat(decided.rules().response().path("catchUp").asBoolean()).isFalse();
        assertThat(decided.rules().response().path("cycleDate").asString()).isEqualTo("2026-11-02");
        assertThat(runAt("2026-11-02T22:40").outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(rulesDecisions()).hasSize(2);
    }

    @Test
    @DisplayName("규칙 계좌 입력 오류(U 저장본 없음)는 그 계좌 오류로 셈 — ERROR 기록, 세 번이면 그날은 더 시도하지 않고, 기한이 지나면 NO_TRADE 행")
    void inputErrorCountsAsRulesFailure() {
        quotes(R);
        KrRulesFixtures empty = new KrRulesFixtures();
        // U 없음 — 같은 저장소 가짜에 빈 유니버스를 다시 넣음(수급·DART는 그대로).
        StoreRepository repository = mock(StoreRepository.class);
        empty.install(repository, reader);
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), mock(ClaudeBookService.class), PaperFixtures.settings(store),
                KrRuleBookServiceTest.config(), PaperFixtures.MAPPER, clock);

        for (String at : List.of("2026-11-02T22:30", "2026-11-02T22:40", "2026-11-02T22:50")) {
            PaperDecisionJob.Result failed = runAt(at);
            assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.ERROR);
            assertThat(failed.message()).contains("규칙 계좌").contains("kr_paper_universe");
        }
        assertThat(runAt("2026-11-02T23:00").outcome()).isEqualTo(PaperDecisionJob.GAVE_UP);
        assertThat(rulesDecisions()).hasSize(1);

        PaperDecisionJob.Result late = runAt("2026-11-03T01:00");
        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.PAST_DEADLINE);
        assertThat(late.rules().status()).isEqualTo("NO_TRADE");
        assertThat(late.rules().kind()).isEqualTo(RuleBookService.REBALANCE);
    }
}
