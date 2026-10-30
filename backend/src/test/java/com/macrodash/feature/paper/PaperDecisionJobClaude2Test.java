package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
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
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.ArgumentMatchers.same;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 결정 작업의 미국 Claude 계좌2 몫(계좌2 명세 §5-1·§4-1·§5-4) — 계좌1 바로 뒤 같은 실행·같은 시장 입력(입력 동결), 설정 {@code claude2.enabled}, 1분봉
 * 기다림(③), 출발을 그 창에서 한 번(작업 기록 {@code claude2.startTried} — 재기동해도), 계좌2 오류 횟수, 수동 결정·수동 출발의 창. 계좌2 결정 자체
 * ({@link ClaudeBookService#decideClaude2})는 가짜로 두고(그 몫은 Claude2DecisionTest), 작업이 무엇을 언제 무엇으로 부르는지만 봅니다.
 *
 * <p>기준 거래일 d = 2026-10-26(월, 마감 20:00Z). 결정 시각 07:30 KST = 22:30Z, 다음 세션 09:00 ET 컷오프 = 10-27 13:00Z.
 */
class PaperDecisionJobClaude2Test {

    private static final PaperMarket US = UsPaperMarket.INSTANCE;
    private static final LocalDate THU = LocalDate.of(2026, 10, 22);
    private static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    private static final Instant MON_OBSERVED = Instant.parse("2026-10-26T20:30:00Z");
    private static final Instant MON_RUN = Instant.parse("2026-10-26T23:00:00Z");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private RuleBookService rules;
    private ClaudeBookService claude;
    private PacketBuilder.MarketInputs inputs;
    private Map<String, Snapshot> snapshots;
    /** 세 계좌의 결정 호출을 부른 순서대로. */
    private List<String> calls;
    /** 가짜 계좌2 결정이 돌려줄 결과(없으면 그 거래일 NO_TRADE 행). */
    private ClaudeBookService.Claude2Outcome next;
    /** 참이면 계좌2 상태 저장(관측치 처리의 끝)이 늘 실패 — 계좌2 장부 오류(그 책만 되돌림). */
    private boolean claude2StateFails;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        store = new FakePaperStore() {
            @Override
            public void upsertState(BookState s) {
                if (claude2StateFails && PaperBooks.CLAUDE2.equals(s.bookCode())) {
                    throw new IllegalStateException("디스크 가득 참");
                }
                super.upsertState(s);
            }
        };
        snapshots = new HashMap<>();
        reader = mock(StoreReader.class);
        when(reader.quietly(any())).thenAnswer(invocation -> ((Supplier<Object>) invocation.getArgument(0)).get());
        when(reader.read(anyString(), anyLong(), any())).thenAnswer(invocation ->
                Optional.ofNullable(snapshots.get((String) invocation.getArgument(0))));
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        rules = mock(RuleBookService.class);
        calls = new ArrayList<>();
        when(rules.decide(any(PaperMarket.class), any(), anyString(), anyBoolean())).thenAnswer(invocation -> {
            calls.add("rules " + invocation.getArgument(1) + " " + invocation.getArgument(2));
            return row(99, PaperBooks.RULES, invocation.getArgument(1), invocation.getArgument(2));
        });
        claude = mock(ClaudeBookService.class);
        inputs = mock(PacketBuilder.MarketInputs.class);
        when(claude.usMarketInputs(any(), any())).thenReturn(inputs);
        when(claude.decide(market(US), any(), anyString(), anyBoolean())).thenAnswer(invocation -> {
            calls.add("claude " + invocation.getArgument(1) + " " + invocation.getArgument(2));
            return row(98, PaperBooks.CLAUDE, invocation.getArgument(1), invocation.getArgument(2));
        });
        when(claude.decideWith(market(US), any(), anyString(), anyBoolean(), any())).thenAnswer(invocation -> {
            calls.add("claude(shared) " + invocation.getArgument(1) + " " + invocation.getArgument(2));
            return row(98, PaperBooks.CLAUDE, invocation.getArgument(1), invocation.getArgument(2));
        });
        when(claude.decideClaude2(any(), any(), anyString(), anyBoolean(), any(), any(), anyBoolean()))
                .thenAnswer(invocation -> {
                    LocalDate d = invocation.getArgument(1);
                    String kind = invocation.getArgument(2);
                    calls.add("claude2 " + d + " " + kind);
                    if (next != null) {
                        return next;
                    }
                    return ClaudeBookService.Claude2Outcome.of(row(97, PaperBooks.CLAUDE2, d, kind));
                });
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        store.books.put(PaperBooks.RULES, new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, "규칙 책", 100_000, THU,
                PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(PaperBooks.RULES, state(PaperBooks.RULES));
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                FRI, PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, state(PaperBooks.CLAUDE));
        claude2(null, PaperBooks.NOT_STARTED);
        store.states.put(PaperBooks.CLAUDE2, state(PaperBooks.CLAUDE2));
        macro();
        observed(MON_OBSERVED, MON);
    }

    private static BookState state(String code) {
        return new BookState(code, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE, FRI, null);
    }

    private void claude2(LocalDate startedOn, String status) {
        store.books.put(PaperBooks.CLAUDE2, new Book(PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, PaperBooks.CLAUDE2_LABEL,
                100_000, startedOn, status, FRI_CLOSE));
    }

    private void enabled(boolean on) {
        ((ObjectNode) store.settings.body().get("claude2")).put("enabled", on);
    }

    private Decision row(long id, String book, LocalDate d, String kind) {
        return new Decision(id, book, d, kind, store.dbNow, "NO_TRADE", "claude-sonnet-5-5", null, 1, null, 40.0, null,
                null, null, MAPPER.valueToTree(Map.of("summary", "주문 없음")), null, null, null, true, 0L, 0);
    }

    private PaperDecisionJob job(Instant now) {
        return job(now, now);
    }

    /** @param ledgerNow 장부의 지금(1분봉 기다림 상한을 셈) */
    private PaperDecisionJob job(Instant now, Instant ledgerNow) {
        return job(now, new PaperLedgerService(store, marketData, MAPPER, Clock.fixed(ledgerNow, ZoneOffset.UTC)));
    }

    /** @param ledger 여러 실행이 함께 쓰는 장부(운영처럼 하나 — 오류 기억이 실행 사이에 이어짐) */
    private PaperDecisionJob job(Instant now, PaperLedgerService ledger) {
        return new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class), rules, claude,
                PaperFixtures.settings(store), PaperFixtures.config(), MAPPER, Clock.fixed(now, ZoneOffset.UTC));
    }

    private void observed(Instant collectedAt, LocalDate barDate) {
        when(marketData.quotes(market(US))).thenReturn(Optional.of(quotes(collectedAt,
                bar("SPY", barDate.minusDays(3), 499, barDate, 500))));
    }

    private void macro() {
        List<Map<String, Object>> items = new ArrayList<>();
        for (Object[] card : new Object[][]{{"us10y", 4.5}, {"brent", 80.0}, {"wti", 75.0}, {"usdjpy", 150.0}}) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("key", card[0]);
            item.put("status", "ok");
            item.put("price", card[1]);
            item.put("lastTs", "2026-10-27 05:00");
            item.put("isStale", false);
            items.add(item);
        }
        snapshots.put(Datasets.SNAP_MACRO_COLLECTED, new Snapshot(Datasets.SNAP_MACRO_COLLECTED,
                MAPPER.valueToTree(Map.of("categories", List.of(Map.of("id", "rates", "items", items)))), "json",
                "ok", null, Instant.parse("2026-10-26T21:00:00Z")));
    }

    private JsonNode lastRun() {
        List<JobRun> runs = store.jobRuns;
        return runs.get(runs.size() - 1).detail();
    }

    // ------------------------------------------------------------------ 정기
    @Test
    @DisplayName("켜진 계좌2: 규칙 → 계좌1 → 계좌2 순서로 같은 실행에서 — 그 실행의 시장 입력을 한 번 읽어 두 계좌가 쓰고(계좌1은 decideWith), 계좌2에는 계좌1이 낸 결정을 넘김 · 작업 기록 claude2 칸")
    void book2RunsAfterBook1WithTheSameInputs() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);

        PaperDecisionJob.Result result = job(MON_RUN).run();

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(calls).containsExactly("rules 2026-10-26 SCHEDULED", "claude(shared) 2026-10-26 SCHEDULED",
                "claude2 2026-10-26 SCHEDULED");
        verify(claude, times(1)).usMarketInputs(any(), eq(MON));
        verify(claude).decideClaude2(any(), eq(MON), eq(RuleBookService.SCHEDULED), eq(true), same(inputs),
                same(result.claude()), eq(true));
        verify(claude, never()).decide(any(PaperMarket.class), any(), anyString(), anyBoolean());
        assertThat(result.claude2().bookCode()).isEqualTo(PaperBooks.CLAUDE2);
        JsonNode view = lastRun().path(PaperBooks.CLAUDE2);
        assertThat(view.path("kind").asString()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(view.path("started").asBoolean()).isFalse();
        assertThat(view.has("sharedWith")).isTrue();
        assertThat(view.has(PaperDecisionJob.CLAUDE2_START_TRIED)).as("정기 결정에는 출발 표시 없음").isFalse();
    }

    @Test
    @DisplayName("꺼진 계좌2(기본): 부르지 않고 시장 입력도 함께 읽지 않음(계좌1은 예전처럼 decide) — 작업 기록에 claude2 칸 없음, 할 일로도 세지 않음")
    void disabledBook2IsNotCalled() {
        claude2(FRI, PaperBooks.ACTIVE);

        job(MON_RUN).run();

        assertThat(calls).containsExactly("rules 2026-10-26 SCHEDULED", "claude 2026-10-26 SCHEDULED");
        verify(claude, never()).decideClaude2(any(), any(), anyString(), anyBoolean(), any(), any(), anyBoolean());
        verify(claude, never()).usMarketInputs(any(), any());
        assertThat(lastRun().has(PaperBooks.CLAUDE2)).isFalse();
    }

    @Test
    @DisplayName("계좌1이 앞선 실행에서 이미 결정했으면 계좌2만 — 시장 입력을 함께 읽지 않고(null) 계좌1 결정도 넘기지 않음(계좌2가 저장된 계좌1 행의 섹션으로 조립)")
    void book1AlreadyDecided() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED, null, "OK",
                "claude-sonnet-5-5", 0, 1, null, 40.0, null, null, null, MAPPER.createObjectNode(), null, null, null, true,
                0L, 0));

        job(MON_RUN).run();

        assertThat(calls).containsExactly("rules 2026-10-26 SCHEDULED", "claude2 2026-10-26 SCHEDULED");
        verify(claude, never()).usMarketInputs(any(), any());
        verify(claude).decideClaude2(any(), eq(MON), eq(RuleBookService.SCHEDULED), eq(true), isNull(), isNull(),
                eq(true));
    }

    @Test
    @DisplayName("출발(INITIAL): 시작 전 계좌2는 그 창에 한 번 — 실패해 쓰지 않아도 작업 기록 claude2.startTried로 다시 부르지 않음(새 작업 객체 = 재기동해도), 다음 거래일 창에 다시")
    void startIsTriedOncePerWindow() {
        enabled(true);
        next = ClaudeBookService.Claude2Outcome.failed("Claude 출발 호출 실패(API 오류, 재시도 1회 뒤): boom", 2);

        PaperDecisionJob.Result first = job(MON_RUN).run();

        assertThat(first.outcome()).as("출발 실패는 오류가 아님(아무것도 쓰지 않고 다음 창)").isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(first.claude2()).isNull();
        JsonNode view = lastRun().path(PaperBooks.CLAUDE2);
        assertThat(view.path("kind").asString()).isEqualTo(RuleBookService.INITIAL);
        assertThat(view.path(PaperDecisionJob.CLAUDE2_START_TRIED).asBoolean()).isTrue();
        assertThat(view.path("started").asBoolean()).isFalse();
        assertThat(view.path("failure").asString()).startsWith("Claude 출발 호출 실패");
        assertThat(view.path("calls").asInt()).isEqualTo(2);

        job(MON_RUN.plusSeconds(600)).run();
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).containsExactly("claude2 2026-10-26 INITIAL");

        observed(Instant.parse("2026-10-27T20:30:00Z"), TUE);
        job(Instant.parse("2026-10-27T23:00:00Z")).run();
        assertThat(calls).filteredOn(c -> c.startsWith("claude2"))
                .containsExactly("claude2 2026-10-26 INITIAL", "claude2 2026-10-27 INITIAL");
    }

    @Test
    @DisplayName("③ 1분봉 기다림: 계좌2 장부가 기준 시각이 지난 시각 지정 주문 때문에 이번 관측치를 미뤘으면 계좌2는 결정하지 않고 다음 주기 — 계좌1은 그대로, 상한(claude2.barsWaitMinutes)이 지나 풀리면 결정")
    void waitsForTheMinuteBars() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);
        store.insertOrder(new Order(0, PaperBooks.CLAUDE2, null, "SPY", "BUY", null, 3.0, null, PaperBooks.AT_1500,
                "CLAUDE", PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode(), FRI, FRI_CLOSE, MON, null));
        Instant observedAt = Instant.parse("2026-10-26T22:50:00Z");
        observed(observedAt, MON);

        job(MON_RUN, observedAt.plusSeconds(60)).run();

        assertThat(calls).containsExactly("rules 2026-10-26 SCHEDULED", "claude(shared) 2026-10-26 SCHEDULED");
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("waiting").asString()).contains("1분봉 기다림");

        job(MON_RUN.plusSeconds(600), observedAt.plusSeconds(16 * 60)).run();
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).containsExactly("claude2 2026-10-26 SCHEDULED");
    }

    /** 규칙·계좌1이 그 거래일을 이미 결정함(저장된 정기 결정 행) — 계좌2만 할 일이 남은 실행. */
    private void book1AndRulesDecided() {
        store.insertDecisionIfAbsent(row(0, PaperBooks.RULES, MON, RuleBookService.SCHEDULED));
        store.insertDecisionIfAbsent(row(0, PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED));
    }

    /** 계좌2 장부가 1분봉을 기다리게 하는 대기 주문 — 기준 시각(월 15:00 ET)이 관측치 전인 시각 지정 매수. */
    private void dueTimedOrder() {
        store.insertOrder(new Order(0, PaperBooks.CLAUDE2, null, "SPY", "BUY", null, 3.0, null, PaperBooks.AT_1500,
                "CLAUDE", PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode(), FRI, FRI_CLOSE, MON, null));
    }

    @Test
    @DisplayName("계좌2만 남아 같은 관측치로 1분봉을 다시 기다리기만 한 주기는 기록하지 않음 — 첫 기다림(그 실행 기록의 claude2.waiting)·새 관측치의 첫 기다림·풀린 뒤의 결정만 기록(리스크 점검과 같은 규칙)")
    void repeatedBarsWaitIsRecordedOnce() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);
        book1AndRulesDecided();
        dueTimedOrder();
        Instant observedAt = Instant.parse("2026-10-26T22:50:00Z");
        observed(observedAt, MON);

        job(MON_RUN, observedAt.plusSeconds(60)).run();
        int first = store.jobRuns.size();
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("waiting").asString()).contains("1분봉 기다림");

        PaperDecisionJob.Result again = job(MON_RUN.plusSeconds(600), observedAt.plusSeconds(120)).run();
        job(MON_RUN.plusSeconds(1200), observedAt.plusSeconds(180)).run();
        assertThat(store.jobRuns).as("같은 관측치를 다시 기다리기만 한 주기").hasSize(first);
        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.BARS_WAITING);
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).isEmpty();

        Instant next = observedAt.plusSeconds(3600);
        observed(next, MON);
        job(MON_RUN.plusSeconds(3600), next.plusSeconds(60)).run();
        assertThat(store.jobRuns).as("새 관측치를 기다리면 다시 한 줄").hasSize(first + 1);

        job(MON_RUN.plusSeconds(4200), next.plusSeconds(16 * 60)).run();
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).containsExactly("claude2 2026-10-26 SCHEDULED");
        assertThat(store.jobRuns).as("풀린 뒤의 결정").hasSize(first + 2);
    }

    @Test
    @DisplayName("1분봉 기다림이 풀린 주기에 계좌2 장부가 오류로 되돌려지면 그 주기는 기록함 — 장부 오류(ledger.errors)와 '오류로 보류'(1분봉 기다림이 아님), 같은 관측치로 보류만 이어 가는 다음 주기는 기록 없음")
    void ledgerErrorAfterTheBarsWaitIsRecorded() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);
        book1AndRulesDecided();
        dueTimedOrder();
        Instant observedAt = Instant.parse("2026-10-26T22:50:00Z");
        observed(observedAt, MON);
        UsTimedFillsTest.MovableClock ledgerClock = new UsTimedFillsTest.MovableClock(observedAt.plusSeconds(60));
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, MAPPER, ledgerClock);

        job(MON_RUN, ledger).run();
        int first = store.jobRuns.size();
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("waiting").asString()).contains("1분봉 기다림");

        claude2StateFails = true;
        ledgerClock.at = observedAt.plusSeconds(16 * 60);   // 기다림 상한이 지나 풀림 → 계좌2 처리가 오류로 되돌려짐
        PaperDecisionJob.Result failed = job(MON_RUN.plusSeconds(600), ledger).run();

        assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.jobRuns).as("장부 오류가 든 주기").hasSize(first + 1);
        assertThat(lastRun().path("ledger").path("errors").toString()).contains(PaperBooks.CLAUDE2).contains("디스크 가득 참");
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("waiting").asString()).contains("오류")
                .doesNotContain("1분봉 기다림");
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).isEmpty();

        ledgerClock.at = observedAt.plusSeconds(17 * 60);
        PaperDecisionJob.Result held = job(MON_RUN.plusSeconds(1200), ledger).run();
        assertThat(store.jobRuns).as("같은 관측치로 보류만 이어 간 주기").hasSize(first + 1);
        assertThat(held.outcome()).isEqualTo(PaperDecisionJob.BARS_WAITING);
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).isEmpty();
    }

    @Test
    @DisplayName("계좌1 첫 응답이 재시도할 API 오류이고 계좌2가 같은 관측치로 1분봉을 기다리면, 다음 주기의 계좌1 재시도는 기록함 — 할 일이 계좌2만 남았을 때만 BARS_WAITING으로 접음")
    void book1RetryWhileBook2WaitsIsRecorded() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);
        store.insertDecisionIfAbsent(row(0, PaperBooks.RULES, MON, RuleBookService.SCHEDULED));
        dueTimedOrder();
        doAnswer(invocation -> {
            calls.add("claude(shared) " + invocation.getArgument(1) + " " + invocation.getArgument(2));
            Optional<Decision> earlier = store.decisionFor(PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED);
            if (earlier.isEmpty()) {   // 첫 응답 — 다음 주기에 재시도할 API 오류(retry_count 0)
                store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED, store.dbNow,
                        ClaudeBookService.STATUS_API_ERROR, "claude-sonnet-5-5", null, 1, null, null, null, null, null,
                        MAPPER.createObjectNode(), null, "overloaded", null, true, 0L, 0));
            } else {
                store.updateDecision(earlier.get().id(), "NO_TRADE", MAPPER.valueToTree(Map.of("summary", "재시도")), null);
            }
            return store.decisionFor(PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED).orElseThrow();
        }).when(claude).decideWith(market(US), any(), anyString(), anyBoolean(), any());
        Instant observedAt = Instant.parse("2026-10-26T22:50:00Z");
        observed(observedAt, MON);

        job(MON_RUN, observedAt.plusSeconds(60)).run();
        int first = store.jobRuns.size();
        assertThat(lastRun().path("claude").path("status").asString()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("waiting").asString()).contains("1분봉 기다림");

        PaperDecisionJob.Result retried = job(MON_RUN.plusSeconds(600), observedAt.plusSeconds(120)).run();

        assertThat(calls).filteredOn(c -> c.startsWith("claude(shared)")).as("계좌1 재시도").hasSize(2);
        assertThat(retried.outcome()).as("계좌2는 같은 관측치로 기다려도 계좌1 재시도가 있는 주기").isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.jobRuns).as("계좌1 재시도 결과가 기록됨").hasSize(first + 1);
        assertThat(lastRun().path("claude").path("status").asString()).isEqualTo("NO_TRADE");
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("waiting").asString()).contains("1분봉 기다림");
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).isEmpty();
    }

    @Test
    @DisplayName("⑤ 개장 전 컷오프가 ③ 1분봉 기다림보다 먼저: 계좌2 장부가 그 관측치를 아직 처리하지 않았어도(장부 보류·기다림) 목표 세션 09:00 ET 뒤면 계좌2 결정을 불러 그 거래일을 끝냄(부르는 쪽이 Claude 없이 SKIPPED '개장 전 컷오프'·출발은 실패)")
    void cutoffComesBeforeTheBarsWait() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);
        book1AndRulesDecided();
        dueTimedOrder();
        Instant observedAt = Instant.parse("2026-10-26T22:50:00Z");
        observed(observedAt, MON);
        Instant cutoff = Instant.parse("2026-10-27T13:00:00Z");

        job(cutoff.minusSeconds(60), observedAt.plusSeconds(60)).run();
        assertThat(calls).as("컷오프 전 — 기다림").filteredOn(c -> c.startsWith("claude2")).isEmpty();

        job(cutoff, observedAt.plusSeconds(120)).run();
        assertThat(calls).filteredOn(c -> c.startsWith("claude2")).containsExactly("claude2 2026-10-26 SCHEDULED");
        assertThat(lastRun().path(PaperBooks.CLAUDE2).has("waiting")).isFalse();
    }

    @Test
    @DisplayName("계좌2 오류는 계좌2만 — 실행은 ERROR(계좌1 결정은 그대로), 계좌2 오류 세 번이면 그날 계좌2만 포기(계좌1은 계속 부름)")
    void book2ErrorsCountForBook2() {
        enabled(true);
        claude2(FRI, PaperBooks.ACTIVE);
        when(claude.decideClaude2(any(), any(), anyString(), anyBoolean(), any(), any(), anyBoolean()))
                .thenThrow(new IllegalStateException("계좌2 boom"));

        PaperDecisionJob job = job(MON_RUN);
        PaperDecisionJob.Result first = job.run();

        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.ERROR);
        assertThat(first.claude().bookCode()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(lastRun().path("claude2Error").asString()).contains("계좌2 boom");
        job.run();
        job.run();
        PaperDecisionJob.Result fourth = job.run();
        verify(claude, times(3)).decideClaude2(any(), any(), anyString(), anyBoolean(), any(), any(), anyBoolean());
        assertThat(fourth.outcome()).as("계좌1·규칙은 그대로 결정").isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(lastRun().path(PaperBooks.CLAUDE2).isMissingNode()).as("포기 표시").isFalse();
        assertThat(calls).filteredOn(c -> c.startsWith("claude(shared)")).as("계좌2 포기 뒤에는 함께 읽지 않음 — 계좌1은 혼자")
                .hasSize(3);
        assertThat(calls).filteredOn(c -> c.startsWith("claude ")).hasSize(1);
    }

    // ------------------------------------------------------------------ 수동(§5-4)
    @Test
    @DisplayName("수동 결정 run/decision {book:claude2}: 꺼짐·정규장 중(다음 세션 09:00 ET 뒤)·확정 종가 전은 400(부르지 않음·기록 없음), 창 안이면 MANUAL을 수동 문턱으로(같은 실행 입력 없음)")
    void manualBook2Decision() {
        claude2(FRI, PaperBooks.ACTIVE);
        assertThatThrownBy(() -> job(MON_RUN).runNow(PaperBooks.CLAUDE2)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("꺼져 있습니다");
        enabled(true);
        observed(Instant.parse("2026-10-27T14:00:00Z"), TUE);
        assertThatThrownBy(() -> job(Instant.parse("2026-10-27T15:00:00Z")).runNow(PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("정규장 중에는 받지 않음");
        observed(Instant.parse("2026-10-26T19:30:00Z"), MON);
        assertThatThrownBy(() -> job(MON_RUN).runNow(PaperBooks.CLAUDE2)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("확정 종가");
        assertThat(calls).isEmpty();
        assertThat(store.jobRuns).isEmpty();

        observed(MON_OBSERVED, MON);
        Decision manual = job(MON_RUN).runNow(PaperBooks.CLAUDE2);

        assertThat(manual.bookCode()).isEqualTo(PaperBooks.CLAUDE2);
        verify(claude).decideClaude2(any(), eq(MON), eq(RuleBookService.MANUAL), eq(true), isNull(), isNull(), eq(false));
        assertThat(calls).containsExactly("claude2 2026-10-26 MANUAL");
        assertThat(lastRun().path("manual").asBoolean()).isTrue();
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("kind").asString()).isEqualTo(RuleBookService.MANUAL);
        assertThatThrownBy(() -> job(MON_RUN).runNow(PaperBooks.BENCH_SPY)).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("수동 출발 run/initial-decision {book:claude2}: 계좌 없음·창 밖은 400, 출발 실패는 400(쓰지 않음), 출발하면 STARTED, 이미 출발했으면 ALREADY_STARTED와 그 출발 기록(부르지 않음)")
    void manualBook2Start() {
        enabled(true);
        assertThatThrownBy(() -> job(Instant.parse("2026-10-27T13:00:00Z")).startClaude2Now())
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("09:00 ET");
        next = ClaudeBookService.Claude2Outcome.failed("개장 전 컷오프", 0);
        assertThatThrownBy(() -> job(MON_RUN).startClaude2Now()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("출발하지 않았습니다(아무것도 쓰지 않음)");
        verify(claude).decideClaude2(any(), eq(MON), eq(RuleBookService.INITIAL), eq(true), isNull(), isNull(), eq(false));

        next = new ClaudeBookService.Claude2Outcome(row(97, PaperBooks.CLAUDE2, MON, RuleBookService.INITIAL), true, null,
                1, 0);
        PaperDecisionJob.Claude2StartNow started = job(MON_RUN).startClaude2Now();
        assertThat(started.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(started.tradingDate()).isEqualTo(MON);
        assertThat(started.decision().kind()).isEqualTo(RuleBookService.INITIAL);
        assertThat(lastRun().path(PaperBooks.CLAUDE2).path("started").asBoolean()).isTrue();

        claude2(MON, PaperBooks.ACTIVE);
        long id = store.insertDecisionIfAbsent(row(0, PaperBooks.CLAUDE2, MON, RuleBookService.INITIAL)).orElseThrow();
        PaperDecisionJob.Claude2StartNow again = job(MON_RUN).startClaude2Now();
        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.ALREADY_STARTED);
        assertThat(again.decision().id()).isEqualTo(id);
        verify(claude, times(2)).decideClaude2(any(), any(), anyString(), anyBoolean(), any(), any(), anyBoolean());

        store.books.remove(PaperBooks.CLAUDE2);
        assertThatThrownBy(() -> job(MON_RUN).startClaude2Now()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("계좌2가 없습니다");
    }
}
