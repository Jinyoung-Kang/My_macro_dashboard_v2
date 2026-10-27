package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.GateRow;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Selection;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 결정 작업(설계 §6-2) — 결정 시각 전·확정 종가 기다림·기한 뒤 미확정 진행·재선정일·이미 결정함·게이트 지표·수동 실행.
 *
 * <p>거래일 d = 2026-10-23(금, EDT 마감 20:00Z). d 다음 날 07:30 KST = 2026-10-23T22:30Z, 12:00 KST = 2026-10-24T03:00Z.
 * 규칙 책 결정 자체({@link RuleBookService})는 가짜로 두고, 작업이 무엇을 언제 부르는지만 봅니다.
 */
class PaperDecisionJobTest {

    /** 정기·수동 실행이 미국 시장으로 저장본을 읽고 Claude 결정을 부릅니다(2단계 명세 §9 A6 — 시장마다 결정 작업이 돎). */
    private static final PaperMarket US = UsPaperMarket.INSTANCE;

    /** 금요일 장중(15:30 ET) 저장본 — 확정 종가 아님. */
    private static final Instant FRI_INTRADAY = Instant.parse("2026-10-23T19:30:00Z");
    /** 2026-10-22(목) — setUp의 규칙 책 출발일(출발일 당일은 초기 결정이 그날 결정이라 정기 결정을 내지 않음). */
    private static final LocalDate THU = LocalDate.of(2026, 10, 22);
    /** 2026-11-17(화) = 2026-09-30 분기의 재선정일. EST라 마감 21:00Z. */
    private static final LocalDate RESELECTION = LocalDate.of(2026, 11, 17);

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperSelectionService selection;
    private RuleBookService rules;
    private ClaudeBookService claude;
    private Map<String, Snapshot> snapshots;
    private List<String> decided;
    private List<String> claudeDecided;
    /** 두 책의 결정 호출을 부른 순서대로("rules …"·"claude …") — 순서를 보는 시험용. */
    private List<String> calls;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        store = new FakePaperStore();
        snapshots = new HashMap<>();
        reader = mock(StoreReader.class);
        when(reader.quietly(any())).thenAnswer(invocation -> ((Supplier<Object>) invocation.getArgument(0)).get());
        when(reader.read(anyString(), anyLong(), any())).thenAnswer(invocation ->
                Optional.ofNullable(snapshots.get((String) invocation.getArgument(0))));
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        selection = mock(PaperSelectionService.class);
        rules = mock(RuleBookService.class);
        decided = new ArrayList<>();
        calls = new ArrayList<>();
        when(rules.decide(any(), anyString(), anyBoolean())).thenAnswer(invocation -> {
            LocalDate d = invocation.getArgument(0);
            String kind = invocation.getArgument(1);
            boolean pricesFinal = invocation.getArgument(2);
            decided.add(d + " " + kind + " " + pricesFinal);
            calls.add("rules " + d + " " + kind + " " + pricesFinal);
            return new Decision(99, PaperBooks.RULES, d, kind, store.dbNow, "NO_TRADE", null, null, 1, null, null, null,
                    null, null, MAPPER.valueToTree(Map.of("summary", "주문 없음")), null, null, null, pricesFinal,
                    0L, 0);
        });
        claude = mock(ClaudeBookService.class);
        claudeDecided = new ArrayList<>();
        when(claude.decide(market(US), any(), anyString(), anyBoolean())).thenAnswer(invocation -> {
            LocalDate d = invocation.getArgument(1);
            String kind = invocation.getArgument(2);
            boolean pricesFinal = invocation.getArgument(3);
            claudeDecided.add(d + " " + kind + " " + pricesFinal);
            calls.add("claude " + d + " " + kind + " " + pricesFinal);
            return new Decision(98, PaperBooks.CLAUDE, d, kind, store.dbNow, "NO_TRADE", "claude-sonnet-5-5", null, 1,
                    null, 40.0, null, null, null, MAPPER.valueToTree(Map.of("summary", "주문 없음")), null, null, null,
                    pricesFinal, 0L, 0);
        });
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        // 운용 중인 규칙 책(현금만, 금요일 결정이 정기 결정이 되게 목요일 출발)과 시작 전 Claude 책
        store.books.put(PaperBooks.RULES, new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, "규칙 책", 100_000, THU,
                PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(PaperBooks.RULES, new BookState(PaperBooks.RULES, 100_000, 100_000, 0, 0, FRI_CLOSE,
                FRI_CLOSE, FRI, null));
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                null, PaperBooks.NOT_STARTED, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 100_000, 100_000, 0, 0, null, null, null,
                null));
        macro(4.5, 80.0, 75.0, 150.0);
    }

    private PaperDecisionJob job(Instant now) {
        PaperSettingsService settings = PaperFixtures.settings(store);
        return new PaperDecisionJob(store, reader, marketData,
                new PaperLedgerService(store, marketData, MAPPER), selection, rules, claude, settings,
                PaperFixtures.config(), MAPPER, Clock.fixed(now, ZoneOffset.UTC));
    }

    private void observed(Instant collectedAt, LocalDate barDate) {
        when(marketData.quotes(market(US))).thenReturn(Optional.of(quotes(collectedAt,
                bar("SPY", barDate.minusDays(1), 499, barDate, 500))));
    }

    /** 매크로 카드 저장본(us10y·brent·wti·usdjpy). null이면 그 카드는 수집 실패. 카드 시각은 10-23(금) 마감 무렵(KST). */
    private void macro(Double us10y, Double brent, Double wti, Double usdjpy) {
        macro("2026-10-24 05:00", Map.of(), us10y, brent, wti, usdjpy);
    }

    /**
     * 카드 시각(KST, 수집기 표기)과 이어 쓴(isStale) 카드를 정해 둔 매크로 저장본.
     *
     * @param stale 키 → 이어 쓴 값의 카드 시각(그 카드만 isStale)
     */
    private void macro(String lastTs, Map<String, String> stale, Double us10y, Double brent, Double wti,
                       Double usdjpy) {
        List<Map<String, Object>> items = new ArrayList<>();
        Object[][] cards = {{"us10y", us10y}, {"brent", brent}, {"wti", wti}, {"usdjpy", usdjpy}};
        for (Object[] card : cards) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("key", card[0]);
            item.put("status", card[1] == null ? "fail" : "ok");
            item.put("price", card[1]);
            item.put("lastTs", stale.getOrDefault((String) card[0], lastTs));
            item.put("isStale", stale.containsKey((String) card[0]));
            items.add(item);
        }
        snapshots.put(Datasets.SNAP_MACRO_COLLECTED, new Snapshot(Datasets.SNAP_MACRO_COLLECTED,
                MAPPER.valueToTree(Map.of("categories", List.of(Map.of("id", "rates", "items", items)))), "json",
                "ok", null, Instant.parse("2026-10-23T21:00:00Z")));
    }

    @Test
    @DisplayName("결정 시각(다음 날 07:30 KST) 전이면 아무것도 읽지 않고 기록도 남기지 않는다")
    void tooEarly() {
        PaperDecisionJob.Result result = job(Instant.parse("2026-10-23T22:00:00Z")).run();

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.TOO_EARLY);
        assertThat(result.tradingDate()).isEqualTo(FRI);
        verify(marketData, never()).quotes();
        verify(marketData, never()).quotes(any());
        assertThat(store.jobRuns).isEmpty();
        assertThat(store.gates).isEmpty();
    }

    @Test
    @DisplayName("확정 종가 관측치가 아니면 마감 기한(12:00 KST) 전까지 기다린다 — 결정·게이트·기록 없음")
    void pricesNotFinalBeforeDeadline() {
        observed(FRI_INTRADAY, FRI);

        PaperDecisionJob.Result result = job(Instant.parse("2026-10-23T23:00:00Z")).run();

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.PRICES_NOT_FINAL);
        assertThat(decided).isEmpty();
        assertThat(store.gates).isEmpty();
        assertThat(store.jobRuns).isEmpty();
        assertThat(store.nav.getOrDefault(PaperBooks.RULES, new java.util.TreeMap<>())).isEmpty();
    }

    @Test
    @DisplayName("기한을 넘기면 확정 종가 없이 진행 — 그날 순자산 줄과 결정에 prices_final=false, 재선정일이 아니면 SCHEDULED")
    void proceedsNonFinalAfterDeadline() {
        observed(FRI_INTRADAY, FRI);

        PaperDecisionJob.Result result = job(Instant.parse("2026-10-24T03:30:00Z")).run();

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(result.pricesFinal()).isFalse();
        assertThat(decided).containsExactly("2026-10-23 SCHEDULED false");
        verify(selection, never()).select(any());
        NavRow row = store.navSeries(PaperBooks.RULES).get(0);
        assertThat(row.tradingDate()).isEqualTo(FRI);
        assertThat(row.pricesFinal()).isFalse();
        assertThat(store.navSeries(PaperBooks.CLAUDE)).as("시작 전 책은 줄 없음").isEmpty();
        assertThat(store.jobRuns).singleElement().satisfies(run -> {
            assertThat(run.job()).isEqualTo("decision");
            assertThat(run.outcome()).isEqualTo("DECIDED");
            assertThat(run.detail().path("pricesFinal").asBoolean(true)).isFalse();
            assertThat(run.detail().path("pastDeadline").asBoolean()).isTrue();
            assertThat(run.detail().path("rules").path("kind").asString()).isEqualTo("SCHEDULED");
        });
    }

    @Test
    @DisplayName("재선정일이면 그날 기준으로 다시 선정한 뒤 규칙 책은 REBALANCE — 확정 종가면 prices_final=true")
    void reselectionDaySelectsThenRebalances() {
        observed(Instant.parse("2026-11-17T21:30:00Z"), RESELECTION);
        when(selection.select(RESELECTION)).thenReturn(new PaperSelectionService.SelectionOutcome(RESELECTION, true,
                new Selection(RESELECTION, List.of("0000000001"), null, 1, null), null, null));

        PaperDecisionJob.Result result = job(Instant.parse("2026-11-17T23:00:00Z")).run();

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(result.tradingDate()).isEqualTo(RESELECTION);
        verify(selection).select(RESELECTION);
        assertThat(decided).containsExactly("2026-11-17 REBALANCE true");
        JsonNode detail = store.jobRuns.get(0).detail();
        assertThat(detail.path("reselectionDay").asBoolean()).isTrue();
        assertThat(detail.path("selection").path("created").asBoolean()).isTrue();
        assertThat(detail.path("navSettled").isEmpty()).as("확정 줄은 관측치 처리가 씀").isTrue();
    }

    @Test
    @DisplayName("그날 게이트 지표와 규칙 책 정기 결정이 이미 있으면 ALREADY_DECIDED — 아무것도 다시 하지 않는다")
    void alreadyDecided() {
        observed(Instant.parse("2026-10-23T20:30:00Z"), FRI);
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, FRI, "SCHEDULED", null, "NO_TRADE", null, null, 1,
                null, null, null, null, null, null, null, null, null, true, 0L, 0));
        store.insertGateIfAbsent(new GateRow(FRI, MAPPER.createObjectNode(), "L0", MAPPER.createObjectNode(), null));

        PaperDecisionJob.Result result = job(Instant.parse("2026-10-24T00:00:00Z")).run();

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(decided).isEmpty();
        verify(marketData, never()).quotes();
        verify(marketData, never()).quotes(any());
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("게이트 지표: 매크로 카드 값과 출처·시각을 남기고, 연속 일수는 바로 전 거래일 기록에서 잇는다(빠진 날이 있으면 처음부터)")
    void gateRecordsInputsAndContinuesStreaks() {
        observed(Instant.parse("2026-10-23T20:30:00Z"), FRI);
        store.insertGateIfAbsent(new GateRow(LocalDate.of(2026, 10, 22), MAPPER.createObjectNode(), "L1",
                MAPPER.valueToTree(Map.of("G1", 2, "G2", 2, "G3", 2, "G4", 2, "G5", 0)), null));

        job(Instant.parse("2026-10-24T00:00:00Z")).run();

        GateRow gate = store.gates.get(FRI);
        assertThat(gate.level()).as("G2·G3·G4가 3거래일 연속").isEqualTo("L2");
        assertThat(gate.streaks().path("G2").asInt()).isEqualTo(3);
        assertThat(gate.streaks().path("G5").asInt()).as("USD/JPY 150 < 155").isZero();
        assertThat(gate.inputs().path("us10y").path("value").asDouble()).isEqualTo(4.5);
        assertThat(gate.inputs().path("us10y").path("source").asString()).isEqualTo("macro.collected");
        assertThat(gate.inputs().path("us10y").path("lastTs").asString()).isEqualTo("2026-10-24 05:00");
        assertThat(gate.inputs().path("conditions").path("G5").asBoolean(true)).isFalse();

        // 다음 거래일(월)은 전 거래일(금) 기록에서 잇고, 화·수 기록이 빠지면 목요일은 1부터
        macro("2026-10-27 05:00", Map.of(), null, 80.0, 75.0, 150.0);
        observed(Instant.parse("2026-10-26T20:30:00Z"), LocalDate.of(2026, 10, 26));
        job(Instant.parse("2026-10-27T00:00:00Z")).run();
        GateRow monday = store.gates.get(LocalDate.of(2026, 10, 26));
        assertThat(monday.level()).as("10년물 카드 수집 실패").isEqualTo("UNKNOWN");
        assertThat(monday.inputs().path("us10y").path("value").isNull()).isTrue();
        assertThat(monday.streaks().path("G1").isNull()).as("모르는 날은 null").isTrue();
        assertThat(monday.streaks().path("G3").asInt()).isEqualTo(4);

        macro("2026-10-30 05:00", Map.of(), 4.5, 80.0, 75.0, 150.0);
        observed(Instant.parse("2026-10-29T20:30:00Z"), LocalDate.of(2026, 10, 29));
        job(Instant.parse("2026-10-30T00:00:00Z")).run();   // 10-29(목) — 10-27·28 기록 없음
        assertThat(store.gates.get(LocalDate.of(2026, 10, 29)).streaks().path("G3").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("이어 쓴(isStale) 값·그 거래일보다 앞선 카드 값은 연속 일수에 넣지 않는다 — 하루치 값이 매일 +1 돼 '3일 확인'이 되지 않게")
    void staleGateInputsDoNotExtendStreaks() {
        observed(Instant.parse("2026-10-23T20:30:00Z"), FRI);
        store.insertGateIfAbsent(new GateRow(LocalDate.of(2026, 10, 22), MAPPER.createObjectNode(), "L1",
                MAPPER.valueToTree(Map.of("G1", 2, "G2", 2, "G3", 2, "G4", 2, "G5", 0)), null));
        // 10년물: 수집 실패로 월요일(10-19) 값을 이어 씀 · 브렌트: 이어 쓴 표시는 없지만 카드 시각이 목요일(10-22 ET) 마감
        macro("2026-10-24 05:00", Map.of("us10y", "2026-10-20 05:00"), 4.70, 80.0, 75.0, 150.0);
        snapshots.compute(Datasets.SNAP_MACRO_COLLECTED, (key, snapshot) -> {
            tools.jackson.databind.node.ObjectNode brent = (tools.jackson.databind.node.ObjectNode)
                    snapshot.payload().path("categories").get(0).path("items").get(1);
            brent.put("lastTs", "2026-10-23 05:59");
            return snapshot;
        });

        job(Instant.parse("2026-10-24T00:00:00Z")).run();

        GateRow gate = store.gates.get(FRI);
        assertThat(gate.level()).as("그날 값으로 확인되지 않은 입력이 있음").isEqualTo("UNKNOWN");
        assertThat(gate.streaks().path("G2").isNull()).as("이어 쓴 10년물로 G2를 3으로 올리지 않음").isTrue();
        assertThat(gate.streaks().path("G3").isNull()).as("목요일 카드 값").isTrue();
        assertThat(gate.streaks().path("G4").asInt()).as("그날 값인 WTI는 이어 셈").isEqualTo(3);
        JsonNode us10y = gate.inputs().path("us10y");
        assertThat(us10y.path("value").asDouble()).as("기록에는 값 그대로").isEqualTo(4.70);
        assertThat(us10y.path("isStale").asBoolean()).isTrue();
        assertThat(us10y.path("counted").asBoolean(true)).isFalse();
        assertThat(gate.inputs().path("brent").path("counted").asBoolean(true)).isFalse();
        assertThat(gate.inputs().path("wti").path("counted").asBoolean()).isTrue();
        assertThat(gate.inputs().path("missing").toString()).contains("us10y", "brent");

        assertThat(PaperGate.observedDate("2026-10-24 05:00 (TradingView 수집 시각)")).as("KST → 미국 동부")
                .isEqualTo(FRI);
        assertThat(PaperGate.observedDate("2026-10-22 일봉 기준")).isEqualTo(LocalDate.of(2026, 10, 22));
        assertThat(PaperGate.observedDate("N/A")).isNull();
        assertThat(PaperGate.counted(new PaperGate.Input(4.5, "N/A", false), FRI)).as("시각을 못 읽으면 시각으로 빼지 않음")
                .isTrue();
        assertThat(PaperGate.counted(new PaperGate.Input(4.5, "2026-10-24 05:00", true), FRI))
                .as("카드 시각이 그날이어도 이어 쓴 값이면 세지 않음").isFalse();
    }

    @Test
    @DisplayName("재선정일 결정을 놓쳤으면 다음 결정 날에 그 재선정일(r) 기준으로 선정하고 REBALANCE — r 이후 매수 결정이 있으면 하지 않는다")
    void missedReselectionDayCatchesUp() {
        LocalDate wednesday = LocalDate.of(2026, 11, 18);
        observed(Instant.parse("2026-11-18T21:30:00Z"), wednesday);
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, FRI, "INITIAL", null, "OK", null, null, 1, FRI,
                null, null, null, null, null, null, null, null, true, 0L, 0));
        when(selection.select(RESELECTION)).thenReturn(new PaperSelectionService.SelectionOutcome(RESELECTION, true,
                new Selection(RESELECTION, List.of("0000000001"), null, 1, null), null, null));

        // 11-17(재선정일)의 결정 창 동안 작업이 한 번도 끝나지 못했고, 지금은 11-18 다음 날 아침
        PaperDecisionJob.Result result = job(Instant.parse("2026-11-18T23:00:00Z")).run();

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        verify(selection).select(RESELECTION);
        verify(selection, never()).select(wednesday);
        assertThat(decided).containsExactly("2026-11-18 REBALANCE true");
        JsonNode detail = store.jobRuns.get(0).detail();
        assertThat(detail.path("reselectionDay").asBoolean(true)).isFalse();
        assertThat(detail.path("catchUpReselection").asString()).isEqualTo("2026-11-17");

        // 그 분기 매수 결정(REBALANCE)이 r 이후에 있으면 다음 날은 정기 결정만 — 다시 선정하지 않음
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, wednesday, "REBALANCE", null, "OK", null, null,
                1, RESELECTION, null, null, null, null, null, null, null, null, true, 0L, 0));
        LocalDate thursday = LocalDate.of(2026, 11, 19);
        observed(Instant.parse("2026-11-19T21:30:00Z"), thursday);
        job(Instant.parse("2026-11-19T23:00:00Z")).run();
        assertThat(decided).containsExactly("2026-11-18 REBALANCE true", "2026-11-19 SCHEDULED true");
        verify(selection).select(RESELECTION);   // 여전히 한 번
    }

    @Test
    @DisplayName("재선정일에 선정을 건너뛰면(수집 중) 그날 REBALANCE는 지난 선정이라 세지 않고, 다음 결정 날에 select(r)를 다시 불러 그 분기 매수를 낸다")
    void skippedReselectionIsRetriedNextDay() {
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, FRI, "INITIAL", null, "OK", null, null, 1, FRI,
                null, null, null, null, null, null, null, null, true, 0L, 0));
        // 진짜 규칙 책처럼 결정을 남기고 selection_as_of에 그날 유효한 선정(가장 최근 선정)의 기준일을 적습니다.
        LocalDate[] effective = {FRI};
        // doAnswer — when(rules.decide(…))로 다시 정하면 정하는 호출이 setUp의 답을 한 번 불러 decided에 남습니다.
        doAnswer(invocation -> {
            LocalDate d = invocation.getArgument(0);
            String kind = invocation.getArgument(1);
            boolean pricesFinal = invocation.getArgument(2);
            decided.add(d + " " + kind + " " + pricesFinal);
            store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, d, kind, null, "NO_TRADE", null, null, 1,
                    effective[0], null, null, null, null, MAPPER.valueToTree(Map.of("summary", "주문 없음")), null,
                    null, null, pricesFinal, 0L, 0));
            return store.decisionFor(PaperBooks.RULES, d, kind).orElseThrow();
        }).when(rules).decide(any(), anyString(), anyBoolean());
        String collecting = String.format(Locale.ROOT, PaperSelectionService.COLLECTING_SKIP_REASON, 3, 27);
        when(selection.select(RESELECTION))
                .thenReturn(new PaperSelectionService.SelectionOutcome(RESELECTION, false, null, null, collecting))
                .thenAnswer(invocation -> {
                    effective[0] = RESELECTION;
                    return new PaperSelectionService.SelectionOutcome(RESELECTION, true,
                            new Selection(RESELECTION, List.of("0000000001"), null, 1, null), null, null);
                });

        // 11-17(재선정일): 수집 중이라 선정을 남기지 않음 → REBALANCE는 지난 선정(FRI)으로, 매수 없이
        observed(Instant.parse("2026-11-17T21:30:00Z"), RESELECTION);
        assertThat(job(Instant.parse("2026-11-17T23:00:00Z")).run().outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided).containsExactly("2026-11-17 REBALANCE true");
        assertThat(store.decisionFor(PaperBooks.RULES, RESELECTION, "REBALANCE").orElseThrow().selectionAsOf())
                .isEqualTo(FRI);
        assertThat(store.jobRuns.get(0).detail().path("selection").path("skippedReason").asString())
                .startsWith("수집 중");

        // 11-18: 수집이 끝남 — r 선정으로 낸 매수 결정이 없으니 select(r)를 다시 불러 따라잡기 REBALANCE
        LocalDate wednesday = LocalDate.of(2026, 11, 18);
        observed(Instant.parse("2026-11-18T21:30:00Z"), wednesday);
        assertThat(job(Instant.parse("2026-11-18T23:00:00Z")).run().outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        verify(selection, times(2)).select(RESELECTION);
        assertThat(decided).containsExactly("2026-11-17 REBALANCE true", "2026-11-18 REBALANCE true");
        assertThat(store.jobRuns.get(1).detail().path("catchUpReselection").asString()).isEqualTo("2026-11-17");
        assertThat(store.decisionFor(PaperBooks.RULES, wednesday, "REBALANCE").orElseThrow().selectionAsOf())
                .isEqualTo(RESELECTION);

        // 11-19: r 선정으로 매수 결정을 냈으니 정기 결정만 — 다시 선정하지 않음
        LocalDate thursday = LocalDate.of(2026, 11, 19);
        observed(Instant.parse("2026-11-19T21:30:00Z"), thursday);
        job(Instant.parse("2026-11-19T23:00:00Z")).run();
        verify(selection, times(2)).select(RESELECTION);
        assertThat(decided).containsExactly("2026-11-17 REBALANCE true", "2026-11-18 REBALANCE true",
                "2026-11-19 SCHEDULED true");
    }

    @Test
    @DisplayName("초기화 전이면 아무것도 하지 않고, 시작 전 규칙 책은 결정하지 않지만 게이트 지표는 남긴다")
    void notInitializedAndNotStarted() {
        Map<String, Book> books = new java.util.TreeMap<>(store.books);
        store.books.clear();
        assertThat(job(Instant.parse("2026-10-24T00:00:00Z")).run().outcome())
                .isEqualTo(PaperDecisionJob.NOT_INITIALIZED);

        store.books.putAll(books);
        store.books.put(PaperBooks.RULES, new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, "규칙 책", 100_000, null,
                PaperBooks.NOT_STARTED, FRI_CLOSE));
        observed(Instant.parse("2026-10-23T20:30:00Z"), FRI);
        PaperDecisionJob job = job(Instant.parse("2026-10-24T00:00:00Z"));
        assertThat(job.run().outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided).isEmpty();
        assertThat(store.gates).containsKey(FRI);
        assertThat(job.run().outcome()).as("할 일을 다 함").isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
    }

    @Test
    @DisplayName("규칙 책도 출발일 이하 거래일에는 정기 결정을 내지 않는다 — 초기 결정(INITIAL)이 그날 결정, 할 일도 남지 않음")
    void rulesSkipsScheduledOnStartDay() {
        store.books.put(PaperBooks.RULES, new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, "규칙 책", 100_000, FRI,
                PaperBooks.ACTIVE, FRI_CLOSE));
        observed(Instant.parse("2026-10-23T20:30:00Z"), FRI);
        PaperDecisionJob job = job(Instant.parse("2026-10-24T00:00:00Z"));

        assertThat(job.run().outcome()).as("게이트 지표는 남김").isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided).isEmpty();
        assertThat(store.gates).containsKey(FRI);
        assertThat(store.jobRuns.get(0).detail().path("rules").asString()).contains("출발일");
        assertThat(job.run().outcome()).as("할 일이 남지 않음").isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
    }

    @Test
    @DisplayName("같은 거래일에 오류가 세 번 나면 그날은 더 시도하지 않고, 수동 실행은 다시 시도한다")
    void givesUpAfterRepeatedErrors() {
        observed(Instant.parse("2026-10-23T20:30:00Z"), FRI);
        when(rules.decide(eq(FRI), eq("SCHEDULED"), anyBoolean())).thenThrow(new IllegalStateException("고장"));
        PaperDecisionJob job = job(Instant.parse("2026-10-24T00:00:00Z"));

        for (int i = 0; i < PaperDecisionJob.MAX_ATTEMPTS; i++) {
            assertThat(job.run().outcome()).isEqualTo(PaperDecisionJob.ERROR);
        }
        assertThat(job.run().outcome()).isEqualTo(PaperDecisionJob.GAVE_UP);
        assertThat(store.jobRuns).hasSize(PaperDecisionJob.MAX_ATTEMPTS);
        assertThat(store.jobRuns.get(0).detail().path("error").asString()).contains("고장");

        // 수동 실행은 그날 오류 횟수를 지워, 다음 정기 실행이 다시 시도합니다(포기 상태로 남지 않음).
        assertThat(job.runNow("rules").kind()).isEqualTo("MANUAL");
        assertThat(job.run().outcome()).as("포기하지 않고 다시 시도해 같은 오류").isEqualTo(PaperDecisionJob.ERROR);
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("attempt").asInt())
                .as("오류 횟수를 처음부터 셈").isEqualTo(1);
    }

    @Test
    @DisplayName("수동 실행: 시각·확정 종가를 기다리지 않고 그 책만 MANUAL로 — Claude 책은 Claude 책 결정으로, 다른 값은 400")
    void runNowDecidesManual() {
        observed(FRI_INTRADAY, FRI);
        PaperDecisionJob job = job(Instant.parse("2026-10-23T22:00:00Z"));   // 결정 시각 전

        Decision decision = job.runNow("rules");

        assertThat(decision.kind()).isEqualTo("MANUAL");
        assertThat(decided).containsExactly("2026-10-23 MANUAL false");
        assertThat(claudeDecided).isEmpty();
        assertThat(store.jobRuns).singleElement().satisfies(run ->
                assertThat(run.detail().path("manual").asBoolean()).isTrue());

        Decision claudeDecision = job.runNow("claude");
        assertThat(claudeDecision.bookCode()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(claudeDecided).containsExactly("2026-10-23 MANUAL false");
        assertThat(decided).as("규칙 책은 다시 부르지 않음").hasSize(1);
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("claude").path("kind").asString())
                .isEqualTo("MANUAL");
        assertThatThrownBy(() -> job.runNow("bench_spy")).isInstanceOf(InvalidRequestException.class);
    }

    /** Claude 책을 운용 중(출발 = 금요일)으로. */
    private void claudeActive() {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                FRI, PaperBooks.ACTIVE, FRI_CLOSE));
    }

    @Test
    @DisplayName("Claude 책: 운용 중이면 규칙 책 다음에 SCHEDULED 결정 — 출발일(초기 결정이 그날 결정)·시작 전·일시정지면 부르지 않음")
    void claudeDecidesAfterRulesWhenActive() {
        // 시작 전 Claude 책(setUp) — 부르지 않고, 할 일이 남지 않음
        observed(Instant.parse("2026-10-26T20:30:00Z"), PaperFixtures.MON);
        job(Instant.parse("2026-10-26T23:00:00Z")).run();
        assertThat(claudeDecided).isEmpty();
        assertThat(store.jobRuns.get(0).detail().path("claude").asString()).contains("시작 전");

        // 출발일(금) 결정 — 초기 결정이 그날 결정이라 부르지 않음
        claudeActive();
        observed(Instant.parse("2026-10-23T20:30:00Z"), FRI);
        PaperDecisionJob.Result fri = job(Instant.parse("2026-10-24T00:00:00Z")).run();
        assertThat(fri.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(claudeDecided).isEmpty();
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("claude").asString()).contains("출발일");
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, FRI, "SCHEDULED", null, "NO_TRADE", null, null,
                1, null, null, null, null, null, null, null, null, null, true, 0L, 0));   // 가짜 규칙 책은 기록하지 않음
        assertThat(job(Instant.parse("2026-10-24T00:10:00Z")).run().outcome())
                .as("출발일은 Claude 할 일이 없음").isEqualTo(PaperDecisionJob.ALREADY_DECIDED);

        // 출발일 다음 거래일(월) — 규칙 책 다음에 부름(두 가짜가 한 목록에 부른 순서대로 남김), 결과에 둘 다
        decided.clear();
        calls.clear();
        observed(Instant.parse("2026-10-26T20:30:00Z"), PaperFixtures.MON);
        PaperDecisionJob.Result mon = job(Instant.parse("2026-10-26T23:00:00Z")).run();
        assertThat(mon.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(calls).as("규칙 책 → Claude 책 순서")
                .containsExactly("rules 2026-10-26 SCHEDULED true", "claude 2026-10-26 SCHEDULED true");
        assertThat(decided).containsExactly("2026-10-26 SCHEDULED true");
        assertThat(claudeDecided).containsExactly("2026-10-26 SCHEDULED true");
        assertThat(mon.claude().bookCode()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("claude").path("kind").asString())
                .isEqualTo("SCHEDULED");

        // 일시정지 — 부르지 않음
        claudeDecided.clear();
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                FRI, PaperBooks.PAUSED, FRI_CLOSE));
        observed(Instant.parse("2026-10-27T20:30:00Z"), PaperFixtures.TUE);
        job(Instant.parse("2026-10-27T23:00:00Z")).run();
        assertThat(claudeDecided).isEmpty();
    }

    @Test
    @DisplayName("ALREADY_DECIDED는 운용 중인 Claude 책의 그날 결정도 본다 — 없거나 재시도할 API 오류면 할 일이 남음, 재시도한 뒤에는 끝")
    void alreadyDecidedIncludesClaude() {
        claudeActive();
        LocalDate mon = PaperFixtures.MON;
        observed(Instant.parse("2026-10-26T20:30:00Z"), mon);
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, mon, "SCHEDULED", null, "NO_TRADE", null, null, 1,
                null, null, null, null, null, null, null, null, null, true, 0L, 0));
        store.insertGateIfAbsent(new GateRow(mon, MAPPER.createObjectNode(), "L0", MAPPER.createObjectNode(), null));
        Instant now = Instant.parse("2026-10-26T23:00:00Z");

        // 규칙 책·게이트는 다 했지만 Claude 결정이 없음 → 진행해 Claude만 부름(규칙 책은 그날 결정을 그대로 씀 — 다시 부르지 않음)
        assertThat(job(now).run().outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(claudeDecided).containsExactly("2026-10-26 SCHEDULED true");
        assertThat(decided).isEmpty();

        // 그날 결정이 API 오류(재시도 전) → 할 일이 남음
        claudeDecided.clear();
        long failed = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, mon, "SCHEDULED", null,
                "API_ERROR", "claude-sonnet-5-5", null, 1, null, null, null, null, null, null, null, "[RATE_LIMIT] 429",
                null, true, 10L, 0)).orElseThrow();
        assertThat(job(now).run().outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(claudeDecided).as("재시도 차례").containsExactly("2026-10-26 SCHEDULED true");

        // 재시도까지 한 API 오류·다른 상태 → 끝
        Decision old = store.decisions.get(failed);
        store.decisions.put(failed, new Decision(old.id(), old.bookCode(), old.asOfTradingDate(), old.kind(),
                old.decidedAt(), "API_ERROR", old.model(), null, 1, null, null, null, null, null, null, null, old.error(),
                null, true, 10L, 1));
        claudeDecided.clear();
        assertThat(job(now).run().outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(claudeDecided).isEmpty();
    }

    /** 진짜 규칙 책처럼 결정을 남기는 가짜 — selection_as_of에 그때 유효한 선정 기준일({@code effective[0]})을 적습니다. */
    private void recordingRules(LocalDate[] effective) {
        // doAnswer — when(rules.decide(…))로 다시 정하면 정하는 호출이 setUp의 답을 한 번 불러 decided에 남습니다.
        doAnswer(invocation -> {
            LocalDate d = invocation.getArgument(0);
            String kind = invocation.getArgument(1);
            boolean pricesFinal = invocation.getArgument(2);
            decided.add(d + " " + kind + " " + pricesFinal);
            store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, d, kind, null, "NO_TRADE", null, null, 1,
                    effective[0], null, null, null, null, MAPPER.valueToTree(Map.of("summary", "주문 없음")), null,
                    null, null, pricesFinal, 0L, 0));
            return store.decisionFor(PaperBooks.RULES, d, kind).orElseThrow();
        }).when(rules).decide(any(), anyString(), anyBoolean());
    }

    /**
     * 진짜 Claude 책처럼 결정을 남기는 가짜 — 처음은 {@code firstStatus}(API_ERROR면 재시도 전), 재시도할 API 오류 행이 있으면 같은
     * 행을 NO_TRADE로 바꿉니다(재시도 수 1). 이미 끝난 결정이면 그대로 돌려줍니다.
     */
    private void recordingClaude(String firstStatus) {
        doAnswer(invocation -> {
            LocalDate d = invocation.getArgument(1);
            String kind = invocation.getArgument(2);
            boolean pricesFinal = invocation.getArgument(3);
            claudeDecided.add(d + " " + kind + " " + pricesFinal);
            Optional<Decision> existing = store.decisionFor(PaperBooks.CLAUDE, d, kind);
            if (existing.isEmpty()) {
                long id = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, d, kind, null, firstStatus,
                        "claude-sonnet-5-5", null, 1, null, null, null, null, null,
                        MAPPER.valueToTree(Map.of("summary", firstStatus)), null,
                        "API_ERROR".equals(firstStatus) ? "[OVERLOADED] 529" : null, null, pricesFinal, 10L, 0))
                        .orElseThrow();
                return store.decision(id).orElseThrow();
            }
            Decision old = existing.get();
            if (ClaudeBookService.retryable(old)) {
                store.updateDecisionRetry(new Decision(old.id(), old.bookCode(), d, kind, null, "NO_TRADE",
                        old.model(), null, 1, null, null, null, null, null,
                        MAPPER.valueToTree(Map.of("summary", "주문 없음")), null, null, null, pricesFinal, 10L, 0));
            }
            return store.decision(old.id()).orElseThrow();
        }).when(claude).decide(market(US), any(), anyString(), anyBoolean());
    }

    @Test
    @DisplayName("재선정일에 Claude가 API 오류면 다음 주기엔 Claude만 다시 — 규칙 책은 그날 REBALANCE를 그대로 쓰고 SCHEDULED를 더 내지 않는다(C1·R5)")
    void claudeRetryOnReselectionDayDoesNotAddRulesDecision() {
        claudeActive();
        LocalDate[] effective = {FRI};
        recordingRules(effective);
        recordingClaude("API_ERROR");
        when(selection.select(RESELECTION)).thenAnswer(invocation -> {
            effective[0] = RESELECTION;
            return new PaperSelectionService.SelectionOutcome(RESELECTION, true,
                    new Selection(RESELECTION, List.of("0000000001"), null, 1, null), null, null);
        });
        observed(Instant.parse("2026-11-17T21:30:00Z"), RESELECTION);

        // 1회차: 선정 → REBALANCE(r 선정) → Claude API 오류(재시도 전)
        PaperDecisionJob.Result first = job(Instant.parse("2026-11-17T23:00:00Z")).run();
        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(first.claude().status()).isEqualTo("API_ERROR");

        // 10분 뒤: Claude 쪽 일이 남아 다시 돎 — 규칙 책은 그날 REBALANCE를 그대로(r 선정 매수 결정이 생겨 rebalanceMissing이
        // 거짓이 돼도 SCHEDULED를 새로 내지 않음), 선정도 다시 하지 않음
        PaperDecisionJob.Result second = job(Instant.parse("2026-11-17T23:10:00Z")).run();
        assertThat(second.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided).as("거래일마다 책당 한 번").containsExactly("2026-11-17 REBALANCE true");
        assertThat(store.decisionFor(PaperBooks.RULES, RESELECTION, "SCHEDULED")).isEmpty();
        assertThat(second.rules().kind()).isEqualTo("REBALANCE");
        verify(selection, times(1)).select(RESELECTION);
        assertThat(claudeDecided).containsExactly("2026-11-17 SCHEDULED true", "2026-11-17 SCHEDULED true");
        assertThat(store.decisionFor(PaperBooks.CLAUDE, RESELECTION, "SCHEDULED").orElseThrow().retryCount())
                .isEqualTo(1);
        assertThat(store.jobRuns.get(1).detail().path("rules").path("existing").asBoolean()).isTrue();

        // 따라잡기 날(d > r)도 같음: Claude가 예외로 끝나면(ERROR) 다음 주기에 규칙 책 REBALANCE를 다시 내지 않음
        LocalDate wednesday = LocalDate.of(2026, 11, 18);
        store.decisions.values().removeIf(d -> d.asOfTradingDate().equals(RESELECTION)
                && PaperBooks.RULES.equals(d.bookCode()));   // 11-17 REBALANCE가 없던 것으로 — 11-18에 따라잡기
        effective[0] = FRI;
        decided.clear();
        doAnswer(invocation -> {
            throw new IllegalStateException("패킷 고장");
        }).doAnswer(invocation -> {
            claudeDecided.add("retry");
            return new Decision(97, PaperBooks.CLAUDE, wednesday, "SCHEDULED", store.dbNow, "NO_TRADE",
                    "claude-sonnet-5-5", null, 1, null, null, null, null, null, null, null, null, null, true, 0L, 0);
        }).when(claude).decide(market(US), any(), anyString(), anyBoolean());
        observed(Instant.parse("2026-11-18T21:30:00Z"), wednesday);
        assertThat(job(Instant.parse("2026-11-18T23:00:00Z")).run().outcome()).isEqualTo(PaperDecisionJob.ERROR);
        assertThat(decided).containsExactly("2026-11-18 REBALANCE true");
        assertThat(job(Instant.parse("2026-11-18T23:10:00Z")).run().outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(decided).as("따라잡기 REBALANCE 뒤 SCHEDULED를 더 내지 않음").containsExactly("2026-11-18 REBALANCE true");
        assertThat(store.decisionFor(PaperBooks.RULES, wednesday, "SCHEDULED")).isEmpty();
    }

    @Test
    @DisplayName("규칙 책 쪽 오류가 Claude 책의 그날 결정을 막지 않는다 — Claude는 결정하고 실행은 ERROR(오류 횟수 +1), 다음 주기엔 규칙 책만 다시")
    void rulesErrorDoesNotBlockClaude() {
        claudeActive();
        recordingClaude("NO_TRADE");
        doAnswer(invocation -> {
            throw new IllegalStateException("13F 저장본 고장");
        }).when(rules).decide(any(), anyString(), anyBoolean());
        observed(Instant.parse("2026-10-26T20:30:00Z"), PaperFixtures.MON);
        PaperDecisionJob job = job(Instant.parse("2026-10-26T23:00:00Z"));

        PaperDecisionJob.Result first = job.run();

        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.ERROR);
        assertThat(first.rules()).isNull();
        assertThat(first.claude()).as("대조군 오류가 실험군의 하루를 지우지 않음").isNotNull();
        assertThat(first.claude().status()).isEqualTo("NO_TRADE");
        assertThat(first.message()).contains("규칙 계좌", "13F 저장본 고장");
        assertThat(claudeDecided).containsExactly("2026-10-26 SCHEDULED true");
        JsonNode detail = store.jobRuns.get(0).detail();
        assertThat(detail.path("rulesError").asString()).contains("13F 저장본 고장");
        assertThat(detail.path("claude").path("kind").asString()).isEqualTo("SCHEDULED");
        assertThat(detail.path("attempt").asInt()).isEqualTo(1);

        // 다음 주기: Claude는 이미 결정함 — 규칙 책만 다시(같은 오류), 세 번째 오류 뒤 그날 포기. Claude는 한 번만 불림.
        for (int i = 1; i < PaperDecisionJob.MAX_ATTEMPTS; i++) {
            assertThat(job.run().outcome()).isEqualTo(PaperDecisionJob.ERROR);
        }
        assertThat(job.run().outcome()).isEqualTo(PaperDecisionJob.GAVE_UP);
        assertThat(claudeDecided).hasSize(1);
    }

    @Test
    @DisplayName("설정의 결정 시각·마감 기한을 읽고, 없거나 틀리면 07:30·12:00")
    void decisionTimesFromSettings() {
        assertThat(job(FRI_CLOSE).times()).isEqualTo(new PaperDecisionJob.Times(
                java.time.LocalTime.of(7, 30), java.time.LocalTime.of(12, 0)));
        ((tools.jackson.databind.node.ObjectNode) store.settings.body()).put("decisionTimeKst", "08:15")
                .put("decisionDeadlineKst", "25:99");
        assertThat(job(FRI_CLOSE).times()).isEqualTo(new PaperDecisionJob.Times(
                java.time.LocalTime.of(8, 15), java.time.LocalTime.of(12, 0)));
    }

    @Test
    @DisplayName("수동 실행이 작업 잠금을 쥐고 있으면 정기 실행은 기다리지 않고 BUSY(기록 없음) — 스케줄러 스레드를 Claude 호출 동안 붙잡지 않음")
    void scheduledRunDoesNotWaitForManualRun() throws Exception {
        claudeActive();
        observed(Instant.parse("2026-10-26T20:30:00Z"), PaperFixtures.MON);
        PaperDecisionJob job = job(Instant.parse("2026-10-26T23:00:00Z"));
        CountDownLatch inCall = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        doAnswer(invocation -> {
            inCall.countDown();
            release.await(10, TimeUnit.SECONDS);
            return new Decision(96, PaperBooks.CLAUDE, PaperFixtures.MON, "MANUAL", store.dbNow, "NO_TRADE",
                    "claude-sonnet-5-5", null, 1, null, null, null, null, null, null, null, null, null, true, 0L, 0);
        }).when(claude).decide(market(US), any(), eq("MANUAL"), anyBoolean());
        Thread manual = new Thread(() -> job.runNow("claude"));
        manual.start();
        try {
            assertThat(inCall.await(5, TimeUnit.SECONDS)).isTrue();
            PaperDecisionJob.Result busy = assertTimeoutPreemptively(Duration.ofSeconds(5), () -> job.run());
            assertThat(busy.outcome()).isEqualTo(PaperDecisionJob.BUSY);
            assertThat(store.jobRuns).as("건너뛴 주기는 기록하지 않음").isEmpty();
            assertThat(claudeDecided).as("정기 결정을 부르지 않음").isEmpty();
        } finally {
            release.countDown();
            manual.join(10_000);
        }
        assertThat(job.run().outcome()).as("수동 실행이 끝나면 다음 주기는 그대로").isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(claudeDecided).containsExactly("2026-10-26 SCHEDULED true");
    }

    @Test
    @DisplayName("오류 횟수는 책마다 — Claude 책이 포기한 날 규칙 책 수동 결정은 그 포기를 풀지 않고(유료 호출을 다시 부르지 않음), Claude 책 수동 결정은 푼다")
    void runNowClearsOnlyItsBooksFailures() {
        claudeActive();
        recordingRules(new LocalDate[]{FRI});
        doAnswer(invocation -> {
            claudeDecided.add("scheduled");
            throw new IllegalStateException("저장 고장");
        }).when(claude).decide(market(US), any(), eq("SCHEDULED"), anyBoolean());
        observed(Instant.parse("2026-10-26T20:30:00Z"), PaperFixtures.MON);
        PaperDecisionJob job = job(Instant.parse("2026-10-26T23:00:00Z"));

        for (int i = 0; i < PaperDecisionJob.MAX_ATTEMPTS; i++) {
            assertThat(job.run().outcome()).isEqualTo(PaperDecisionJob.ERROR);
        }
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("attempts").path("claude").asInt())
                .isEqualTo(PaperDecisionJob.MAX_ATTEMPTS);
        assertThat(job.run().outcome()).isEqualTo(PaperDecisionJob.GAVE_UP);
        assertThat(claudeDecided).hasSize(PaperDecisionJob.MAX_ATTEMPTS);

        assertThat(job.runNow("rules").kind()).isEqualTo("MANUAL");
        assertThat(job.run().outcome()).as("규칙 책 수동 결정은 Claude 책의 포기를 풀지 않음")
                .isEqualTo(PaperDecisionJob.GAVE_UP);
        assertThat(claudeDecided).hasSize(PaperDecisionJob.MAX_ATTEMPTS);

        job.runNow("claude");
        assertThat(job.run().outcome()).as("Claude 책 수동 결정은 그 책의 횟수를 지움").isEqualTo(PaperDecisionJob.ERROR);
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("attempt").asInt()).isEqualTo(1);
    }

    // ------------------------------------------------------------------ 시장 격리(2단계 명세 §9 A6)
    private static final PaperMarket KR = TestKrMarket.INSTANCE;
    private static final String KR_BOOK = TestKrMarket.CLAUDE_BOOK;
    /** 10-26(월) 22:00 KST — 시험용 한국 달력으로는 그날 세션 마감 뒤·기본 결정 시각(22:30) 전, 미국 달력으로는 금요일 세션 다음 날. */
    private static final Instant KR_22_00 = Instant.parse("2026-10-26T13:00:00Z");

    private PaperDecisionJob job(Instant now, List<PaperMarket> markets) {
        PaperSettingsService settings = PaperFixtures.settings(store);
        return new PaperDecisionJob(store, reader, marketData,
                new PaperLedgerService(store, marketData, MAPPER), selection, rules, claude, settings,
                PaperFixtures.config(), MAPPER, Clock.fixed(now, ZoneOffset.UTC), markets);
    }

    /**
     * 시험용 한국 Claude 책(운용 중, 금요일 출발)과 그 시장 관측치(월요일 봉, 서울 21:00 수집 — 시험용 달력으로 확정 종가), 그 시장
     * Claude 결정(부른 인자를 calls에 남기고 결정 행을 저장 — 같은 거래일 두 번째 실행은 할 일이 없게).
     */
    private void krBook(RuntimeException failure) {
        store.books.put(KR_BOOK, TestKrMarket.book(KR_BOOK, 100_000_000, FRI));
        store.states.put(KR_BOOK, new BookState(KR_BOOK, 100_000_000, 100_000_000, 0, 0, null, null, null, null));
        when(marketData.quotes(market(KR))).thenReturn(Optional.of(quotes(Instant.parse("2026-10-26T12:00:00Z"),
                bar("005930", FRI, 70_000, PaperFixtures.MON, 71_000))));
        doAnswer(invocation -> {
            LocalDate d = invocation.getArgument(1);
            String kind = invocation.getArgument(2);
            boolean pricesFinal = invocation.getArgument(3);
            calls.add("kr claude " + d + " " + kind + " " + pricesFinal);
            if (failure != null) {
                throw failure;
            }
            store.insertDecisionIfAbsent(new Decision(0, KR_BOOK, d, kind, null, "NO_TRADE", "claude-sonnet-5-5", null,
                    1, null, 30.0, null, null, null, MAPPER.valueToTree(Map.of("summary", "주문 없음")), null, null,
                    null, pricesFinal, 0L, 0));
            return store.decisionFor(KR_BOOK, d, kind).orElseThrow();
        }).when(claude).decide(market(KR), any(), anyString(), anyBoolean());
    }

    @Test
    @DisplayName("시장 격리(A6): 결정 시각·기한은 그 시장의 설정 키(접두어)와 시장 기본값 — 미국 키와 서로 섞이지 않음")
    void decisionTimesPerMarket() {
        // 한국 키가 없는 행 — 시장 기본값(시험용 22:30·23:30). 실제 한국 기본 본문(C1b, 기한 01:00)을 이 작업이 결정 시각으로 접는 문제는
        // D1이 기한 규칙을 시장으로 옮길 자리입니다(명세 §9 'D1·E2 — 결정 기한').
        PaperFixtures.dropKrDefaults(store);
        assertThat(job(FRI_CLOSE).times(KR)).isEqualTo(new PaperDecisionJob.Times(java.time.LocalTime.of(22, 30),
                java.time.LocalTime.of(23, 30)));
        tools.jackson.databind.node.ObjectNode body = (tools.jackson.databind.node.ObjectNode) store.settings.body();
        body.put("decisionTimeKst", "08:15");
        body.putObject("kr").put("decisionTimeKst", "21:50").put("decisionDeadlineKst", "21:00");
        assertThat(job(FRI_CLOSE).times(KR)).as("기한이 결정 시각보다 앞이면 결정 시각").isEqualTo(
                new PaperDecisionJob.Times(java.time.LocalTime.of(21, 50), java.time.LocalTime.of(21, 50)));
        assertThat(job(FRI_CLOSE).times()).isEqualTo(new PaperDecisionJob.Times(java.time.LocalTime.of(8, 15),
                java.time.LocalTime.of(12, 0)));
        assertThat(PaperDecisionJob.decisionTime(KR, body)).isEqualTo(java.time.LocalTime.of(21, 50));
        assertThat(PaperDecisionJob.decisionTime(body)).isEqualTo(java.time.LocalTime.of(8, 15));
    }

    @Test
    @DisplayName("시장 격리(A6): 정기 실행은 시장마다 차례로 — 다른 시장은 그 시장 달력의 세션·결정 시각·관측치·확정 판정으로 그 시장 Claude 책만 결정하고, 게이트 지표·13F 선정·규칙 책(미국 전용 단계)은 돌지 않으며 기록 이름은 시장 접두어 · 미국 실행은 그 시장 책을 건드리지 않음")
    void eachMarketRunsOnlyItsBooks() {
        krBook(null);
        PaperDecisionJob.Result early = job(KR_22_00, List.of(KR)).run(KR);
        assertThat(early.outcome()).isEqualTo(PaperDecisionJob.TOO_EARLY);
        assertThat(early.tradingDate()).as("시험용 한국 달력의 세션").isEqualTo(PaperFixtures.MON);
        verify(marketData, never()).quotes(any());
        assertThat(store.jobRuns).isEmpty();

        ((tools.jackson.databind.node.ObjectNode) store.settings.body()).putObject("kr").put("decisionTimeKst",
                "21:50");
        BookState usRulesBefore = store.states.get(PaperBooks.RULES);
        job(KR_22_00, List.of(UsPaperMarket.INSTANCE, KR)).scheduledRun();

        assertThat(store.jobRuns).extracting(PaperStore.JobRun::job).as("시장마다 차례로, 기록 이름은 시장 접두어 + decision")
                .containsExactly("decision", "kr.decision");
        assertThat(store.jobRuns).extracting(PaperStore.JobRun::outcome).containsExactly("DECIDED", "DECIDED");
        // 미국: 금요일 세션(미국 달력), 확정 종가 없이 기한 뒤 진행 — 게이트·규칙 책 결정, 한국 책은 그대로
        assertThat(decided).containsExactly("2026-10-23 SCHEDULED false");
        assertThat(store.gates).containsOnlyKeys(FRI);
        assertThat(claudeDecided).as("미국 Claude 책은 시작 전").isEmpty();
        // 한국: 월요일 세션(시험용 달력), 확정 종가로 — 장부 처리 뒤 Claude 책만, 게이트·선정·규칙 책 없음
        assertThat(calls).containsExactly("rules 2026-10-23 SCHEDULED false", "kr claude 2026-10-26 SCHEDULED true");
        JsonNode kr = store.jobRuns.get(1).detail();
        assertThat(kr.path("tradingDate").asString()).isEqualTo("2026-10-26");
        assertThat(kr.path("pricesFinal").asBoolean()).isTrue();
        assertThat(kr.path("quotes").path("session").asString()).isEqualTo("2026-10-26");
        assertThat(kr.has("gateLevel")).isFalse();
        assertThat(kr.path("rules").asString()).isEqualTo(PaperDecisionJob.RULES_NOT_YET);
        assertThat(kr.path("claude").path("status").asString()).isEqualTo("NO_TRADE");
        verify(selection, never()).select(any());
        assertThat(store.states.get(KR_BOOK).lastProcessedCollectedAt()).as("그 시장 관측치를 그 시장 책에")
                .isEqualTo(Instant.parse("2026-10-26T12:00:00Z"));
        assertThat(store.navSeries(KR_BOOK)).extracting(NavRow::tradingDate, NavRow::pricesFinal)
                .as("그 시장 관측치의 확정 줄(월요일)뿐 — 미국 실행의 금요일 미확정 줄이 생기지 않음")
                .containsExactly(org.assertj.core.groups.Tuple.tuple(PaperFixtures.MON, true));
        assertThat(store.navSeries(PaperBooks.RULES)).extracting(NavRow::tradingDate, NavRow::pricesFinal)
                .as("미국 실행은 미국 책에 금요일 미확정 줄").containsExactly(org.assertj.core.groups.Tuple.tuple(FRI, false));
        assertThat(store.states.get(PaperBooks.RULES).lastProcessedCollectedAt())
                .isEqualTo(usRulesBefore.lastProcessedCollectedAt());

        // 같은 시장 두 번째 실행 — 그 시장의 그날 일이 끝남(미국 게이트·결정과 상관없이)
        assertThat(job(KR_22_00, List.of(KR)).run(KR).outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(calls).hasSize(2);
    }

    @Test
    @DisplayName("시장 격리(A6): 오류 횟수는 시장마다 — 다른 시장이 그날 포기해도 미국 실행은 그대로, 그 시장 수동 결정은 그 시장 Claude 책만 받고 그 시장 횟수만 지움")
    void failuresArePerMarket() {
        krBook(new IllegalStateException("한국 패킷 고장"));
        ((tools.jackson.databind.node.ObjectNode) store.settings.body()).putObject("kr").put("decisionTimeKst",
                "21:50");
        PaperDecisionJob job = job(KR_22_00, List.of(UsPaperMarket.INSTANCE, KR));
        for (int i = 0; i < PaperDecisionJob.MAX_ATTEMPTS; i++) {
            assertThat(job.run(KR).outcome()).isEqualTo(PaperDecisionJob.ERROR);
        }
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("attempts").path(KR_BOOK).asInt())
                .isEqualTo(PaperDecisionJob.MAX_ATTEMPTS);
        assertThat(job.run(KR).outcome()).isEqualTo(PaperDecisionJob.GAVE_UP);
        assertThat(job.run().outcome()).as("미국은 그 시장 오류 횟수와 상관없음").isEqualTo(PaperDecisionJob.DECIDED);

        assertThatThrownBy(() -> job.runNow(KR, PaperBooks.RULES)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> job.runNow(KR, KR_BOOK)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("한국 패킷 고장");
        assertThat(job.run(KR).outcome()).as("그 시장 수동 결정이 그 시장 횟수를 지움").isEqualTo(PaperDecisionJob.ERROR);
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).job()).isEqualTo("kr.decision");
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("attempt").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("정기 작업 스레드는 둘 이상(application.yml) — Spring Boot 기본 1개면 결정 작업의 Claude 호출 몇 분 동안 리스크 점검(스탑)이 멈춤")
    void schedulerHasMoreThanOneThread() throws Exception {
        // 통합 테스트는 정기 작업을 꺼 두어(dashboard.scheduler.enabled=false) 스케줄러 빈이 없으므로 설정 파일 값을 직접 봅니다.
        Object size = new YamlPropertySourceLoader().load("application", new ClassPathResource("application.yml"))
                .stream().map(source -> source.getProperty("spring.task.scheduling.pool.size"))
                .filter(Objects::nonNull).findFirst().orElse(null);
        assertThat(size).as("spring.task.scheduling.pool.size").isNotNull();
        assertThat(Integer.parseInt(size.toString())).isGreaterThanOrEqualTo(2);
    }
}
