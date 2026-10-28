package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 출발(2단계 명세 §4-8·K28, 결정 d13 — C1c, 규칙 계좌 몫은 D1b): S 22:30 결정 작업이 규칙 계좌(INITIAL — 재선정과 같은 계산)와 벤치마크 두
 * 계좌의 출발 결정·{@code NEXT_OPEN} 주문을 한 트랜잭션으로 쓰고(Claude E2는 갈고리 — 시작 전 그대로), 자료 게이트(§4-9 ②④⑤⑥) 미달이면 기다리며,
 * 기한 S+1 01:00이 지나면 내지 않고 다음 KR 거래일로 미룬다. 규칙 계좌 재료는 {@link KrRulesFixtures#standardThrough}(S = 11-30이면 후보 다섯).
 */
class KrStartTest {

    /** 한국 출발일 S — 2026-11-30(월). 직전 거래일 11-27(금), 다음 거래일 12-01(화). */
    private static final LocalDate S = LocalDate.of(2026, 11, 30);
    private static final LocalDate PREV = LocalDate.of(2026, 11, 27);
    private static final LocalDate NEXT = LocalDate.of(2026, 12, 1);

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private KrFixtures.MovableClock clock;
    private PaperDecisionJob job;
    private final AtomicBoolean failShortBond = new AtomicBoolean();
    private KrRulesFixtures rulesData;
    /** 실제 한국 Claude 경로({@link #realClaude})의 출발 재시도 전 기다림 — 실제로 기다리지 않고 시계를 옮기며 남김(사용자 결정 w12). */
    private KrClaudeFixtures.FakeSleeper sleeper;
    /** 가짜 저장소(유니버스·수급 읽기 — 읽은 횟수를 보는 시험이 씀). */
    private com.macrodash.store.StoreRepository repository;

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    private static PaperConfig config() {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, S, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    @BeforeEach
    void setUp() {
        // 153130 주문 넣기를 실패시킬 수 있는 가짜 저장소(트랜잭션 되돌림 시험).
        store = new FakePaperStore() {
            @Override
            public long insertOrder(Order o) {
                if (failShortBond.get() && PaperBooks.KR_BENCH_MIX.equals(o.bookCode())
                        && PaperBooks.KR_SHORT_BOND.equals(o.ticker())) {
                    throw new IllegalStateException("시험용 주문 실패");
                }
                return super.insertOrder(o);
            }
        };
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        repository = mock(com.macrodash.store.StoreRepository.class);
        // 금융위 시장 구분(체결 비용의 종목 구분) — 표준 U 주식 모두 코스피(S+1 시가 체결 — 다음 밤 정기 결정의 게이트 ①).
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(PREV);
        when(repository.readObservationsFor(eq(Datasets.OBS_FSC_PRICE), any(LocalDate.class), anyCollection()))
                .thenAnswer(invocation -> {
                    java.util.Collection<String> codes = invocation.getArgument(2);
                    Map<String, JsonNode> out = new LinkedHashMap<>();
                    codes.forEach(code -> out.put(code, PaperFixtures.MAPPER.createObjectNode().put("market", "KOSPI")));
                    return out;
                });
        rulesData = KrRulesFixtures.standardThrough(NEXT, LocalDate.of(2026, 11, 26), PREV, S);
        rulesData.install(repository, reader);
        marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        clock = new KrFixtures.MovableClock(kst("2026-11-27T12:00"));
        // 한국 초기화(설정 행 판 1 — 한국 묶음 포함 · 네 계좌 시작 전).
        new PaperAdminService(store, marketData, reader, PaperFixtures.settings(store), ledger, config(),
                PaperFixtures.MAPPER, clock).initKr();
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), mock(ClaudeBookService.class), PaperFixtures.settings(store), config(),
                PaperFixtures.MAPPER, clock);
        sessionData(S, PREV, everyCodeOn(S));
    }

    /** 수집 범위 열 종목(ETF 둘 + 표준 U 중 주식 여덟) 모두 마지막 봉이 그날. */
    private static Map<String, LocalDate> everyCodeOn(LocalDate day) {
        Map<String, LocalDate> out = new LinkedHashMap<>();
        for (String code : List.of("069500", "153130", "005930", "000660", "373220", "207940", "005380", "000270",
                "068270", "105560")) {
            out.put(code, day);
        }
        return out;
    }

    private void sessionData(LocalDate session, LocalDate fscLatest, Map<String, LocalDate> lastBars) {
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES,
                KrFixtures.quotesPayload(session, lastBars), kst(session + "T21:57")));
        KrFixtures.stub(reader, Datasets.SNAP_FSC_PRICES_META, KrFixtures.snapshot(Datasets.SNAP_FSC_PRICES_META,
                KrFixtures.fscMeta(fscLatest), kst(session + "T21:56")));
    }

    private PaperDecisionJob.Result runAt(String kstDateTime) {
        clock.set(kst(kstDateTime));
        return job.run(KrPaperMarket.INSTANCE);
    }

    private List<JobRun> krRuns() {
        return store.jobRuns.stream().filter(r -> r.job().equals("kr.decision")).toList();
    }

    private static List<String> gateStatuses(JsonNode gates) {
        List<String> out = new java.util.ArrayList<>();
        gates.forEach(g -> out.add(g.path("gate").asString() + " " + g.path("status").asString()));
        return out;
    }

    /** 결정 작업이 출발 결과를 남기는 것처럼 작업 기록 한 줄({@code kr.decision}). */
    private void recordAsTheJob(KrStartPipeline.Result result, Instant at) {
        store.recordJobRun("kr.decision", at, at, result.outcome(), PaperFixtures.MAPPER.valueToTree(result.detail()));
    }

    /** 재기동 — 새 장부·결정 작업(메모리 비움), 같은 저장소·저장본·시계. */
    private void restart() {
        job = new PaperDecisionJob(store, reader, marketData, new PaperLedgerService(store, marketData, PaperFixtures.MAPPER),
                mock(PaperSelectionService.class), mock(RuleBookService.class), mock(ClaudeBookService.class),
                PaperFixtures.settings(store), config(), PaperFixtures.MAPPER, clock);
    }

    /**
     * 실제 한국 Claude 경로(E2b — {@link KrClaudeFixtures})의 결정 작업으로 바꿈(네 계좌 몫 모두 운영 것). 재기동을 흉내 낼 때도 같은 가짜 AI로 새
     * 작업·새 서비스를 만듭니다(메모리 비움).
     */
    private void realClaude(KrClaudeFixtures.FakeAi fake) {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        sleeper = new KrClaudeFixtures.FakeSleeper(clock);
        job = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), KrClaudeFixtures.service(store, reader, repository, marketData, ledger,
                config(), clock, fake.ai, sleeper), PaperFixtures.settings(store), config(), PaperFixtures.MAPPER, clock);
    }

    /** 매크로 카드 저장본 — 한국 패킷 1_basis.markets.cards 네 장(카드 시각 = 그날 22:25 KST), 수집 시각 {@code collectedAt}. */
    private void macroCards(LocalDate day, Instant collectedAt) {
        tools.jackson.databind.node.ObjectNode macro = PaperFixtures.MAPPER.createObjectNode();
        tools.jackson.databind.node.ArrayNode items = macro.putArray("categories").addObject().putArray("items");
        for (String key : KrPacketBuilder.CARD_KEYS) {
            items.addObject().put("key", key).put("name", key).put("price", 100.0).put("prevValue", 99.0).put("pct", 1.01)
                    .put("lastTs", day + " 22:25 KST").put("isStale", false).put("source", "시험용");
        }
        KrFixtures.stub(reader, Datasets.SNAP_MACRO_COLLECTED, KrFixtures.snapshot(Datasets.SNAP_MACRO_COLLECTED, macro,
                collectedAt));
    }

    private static void assertNotStarted(FakePaperStore store) {
        assertThat(store.books.values()).filteredOn(b -> b.market().equals("KR"))
                .allSatisfy(b -> assertThat(b.status()).as(b.code()).isEqualTo(PaperBooks.NOT_STARTED));
    }

    private List<Decision> krDecisions() {
        return store.decisions.values().stream().filter(d -> d.bookCode().startsWith("kr_")).toList();
    }

    @Test
    @DisplayName("S 22:30 — 규칙 계좌(재선정과 같은 계산)·벤치마크 두 계좌의 INITIAL 결정·NEXT_OPEN 주문(기준 거래일 S, 만료 S+3거래일)·운용 전환·S 순자산 1억(확정)을 한 트랜잭션으로, Claude는 시작 전(가짜 Claude 서비스라 그 몫 없음 — 네 계좌는 fourBooksStartTogether)")
    void startsRulesAndBenchmarksAtS2230() {
        PaperDecisionJob.Result result = runAt("2026-11-30T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(result.tradingDate()).isEqualTo(S);
        assertThat(krDecisions()).extracting(Decision::bookCode).containsExactly("kr_rules", "kr_bench_k200", "kr_bench_mix");
        for (Decision d : krDecisions()) {
            assertThat(d.kind()).isEqualTo(RuleBookService.INITIAL);
            assertThat(d.status()).isEqualTo("OK");
            assertThat(d.asOfTradingDate()).isEqualTo(S);
            assertThat(d.settingsVersion()).as("그 실행이 읽은 판").isEqualTo(store.settings.version());
            assertThat(d.pricesFinal()).as("금융위 확정 전").isFalse();
            assertThat(d.model()).isNull();
            assertThat(d.response().path("timing").asString()).isEqualTo("NEXT_OPEN");
            assertThat(d.response().path("configuredStartDate").asString()).isEqualTo("2026-11-30");
            assertThat(d.response().path("postponed").asBoolean()).isFalse();
            assertThat(d.response().path("gates").size()).isEqualTo(5);
        }
        assertThat(krDecisions()).extracting(Decision::targetExposurePct).as("규칙 = 후보 다섯 × 100/15, 벤치마크 = 비중 합")
                .containsExactly(33.3333, 100.0, 100.0);
        // 규칙 계좌 출발 = S의 재선정과 같은 계산 — 주기 r(S) = 11-02(11월 첫 거래일), 입력 S(U 기준일 11-27).
        Decision rules = krDecisions().get(0);
        assertThat(rules.selectionAsOf()).isEqualTo(S);
        assertThat(rules.response().path("cycleDate").asString()).isEqualTo("2026-11-02");
        assertThat(rules.response().path("selectionAsOf").asString()).isEqualTo("2026-11-30");
        assertThat(rules.response().path("catchUp").asBoolean()).isFalse();
        assertThat(rules.response().path("input").path("universe").path("baseDate").asString()).isEqualTo("2026-11-27");
        List<Order> ruleOrders = store.orders.values().stream().filter(o -> o.bookCode().equals("kr_rules")).toList();
        // 153130: 현금 1억 − 다섯 종목 6,666,700원 × (1 + 6.5bp) = 66,644,833.225원 → 66.644833225% − 여유 0.5%p = 66.1448%.
        assertThat(ruleOrders).extracting(Order::ticker, Order::side, Order::targetWeightPct).containsExactly(
                org.assertj.core.groups.Tuple.tuple("000660", "BUY", 6.6667),
                org.assertj.core.groups.Tuple.tuple("005930", "BUY", 6.6667),
                org.assertj.core.groups.Tuple.tuple("005380", "BUY", 6.6667),
                org.assertj.core.groups.Tuple.tuple("105560", "BUY", 6.6667),
                org.assertj.core.groups.Tuple.tuple("000270", "BUY", 6.6667),
                org.assertj.core.groups.Tuple.tuple("153130", "BUY", 66.1448));
        assertThat(ruleOrders).allSatisfy(o -> assertThat(o.source()).isEqualTo("RULE"));
        List<Order> orders = store.orders.values().stream().filter(o -> o.bookCode().startsWith("kr_bench")).toList();
        assertThat(orders).extracting(Order::bookCode, Order::ticker, Order::targetWeightPct).containsExactly(
                org.assertj.core.groups.Tuple.tuple("kr_bench_k200", "069500", 100.0),
                org.assertj.core.groups.Tuple.tuple("kr_bench_mix", "069500", 60.0),
                org.assertj.core.groups.Tuple.tuple("kr_bench_mix", "153130", 40.0));
        assertThat(orders).allSatisfy(o -> assertThat(o.source()).isEqualTo("BENCHMARK"));
        assertThat(store.orders.values()).allSatisfy(o -> {
            assertThat(o.timing()).isEqualTo("NEXT_OPEN");
            assertThat(o.status()).isEqualTo("PENDING");
            assertThat(o.asOfTradingDate()).isEqualTo(S);
            assertThat(o.expiresOn()).as("S + 3거래일").isEqualTo(LocalDate.of(2026, 12, 3));
            assertThat(o.qty()).as("수량은 시가 체결 때").isNull();
            assertThat(o.decisionId()).isNotNull();
        });
        assertThat(orders).allSatisfy(o -> assertThat(o.side()).isEqualTo("BUY"));
        for (String started : List.of("kr_rules", "kr_bench_k200", "kr_bench_mix")) {
            Book book = store.books.get(started);
            assertThat(book.status()).isEqualTo(PaperBooks.ACTIVE);
            assertThat(book.startedOn()).isEqualTo(S);
            assertThat(store.navSeries(started)).singleElement().satisfies(row -> {
                assertThat(row.tradingDate()).isEqualTo(S);
                assertThat(row.nav()).isEqualTo(100_000_000);
                assertThat(row.cash()).isEqualTo(100_000_000);
                assertThat(row.pricesFinal()).isTrue();
            });
            assertThat(store.states.get(started).lastNavTradingDate()).isEqualTo(S);
        }
        assertThat(store.books.get("kr_claude").status()).as("Claude 몫 없음(가짜 Claude 서비스 — 실제 경로는 fourBooksStartTogether)")
                .isEqualTo(PaperBooks.NOT_STARTED);
        assertThat(store.navSeries("kr_claude")).isEmpty();
        assertThat(store.fills).as("사후 체결 없음(K28)").isEmpty();

        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.STARTED);
            JsonNode detail = run.detail();
            assertThat(detail.path("start").asBoolean()).isTrue();
            assertThat(detail.path("tradingDate").asString()).isEqualTo("2026-11-30");
            assertThat(detail.path("deadlineKst").asString()).contains("2026-12-01 01:00");
            assertThat(detail.path("books").path("kr_rules").path("orders").size()).isEqualTo(6);
            assertThat(detail.path("books").path("kr_claude").asString()).contains("이 파이프라인에 없음").contains("따라 출발하지 않음");
            assertThat(detail.path("books").path("kr_bench_mix").path("orders").size()).isEqualTo(2);
            assertThat(detail.path("gates").get(1).path("gate").asString()).isEqualTo("③");
            assertThat(detail.path("gates").get(1).path("status").asString()).isEqualTo("PASS");
            assertThat(detail.path("gates").get(1).path("note").asString())
                    .as("규칙 계좌 입력과 같은 읽기 — U 기준일 11-27").contains("U 8/8").contains("U 기준일 2026-11-27");
        });

        // 같은 밤 다음 주기 — 출발한 장부라 다시 내지 않음(규칙 계좌는 출발일 = 초기 결정이 그날 결정, Claude는 시작 전).
        PaperDecisionJob.Result again = runAt("2026-11-30T22:40");
        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(krDecisions()).hasSize(3);
        assertThat(store.orders).hasSize(9);
    }

    @Test
    @DisplayName("K28(E2b) — S 22:30 결정 작업이 네 계좌(규칙·Claude·벤치마크 둘)를 한 트랜잭션으로 출발: Claude는 정기 결정과 같은 조립의 출발 패킷(INITIAL — S 밤 판, 동결본 = 보낸 패킷, 카드 asOfMismatch=false·읽은 순간 22:30)으로 정기 작업 몫(수동 13회째 뒤에도)을 써 한 번 부르고, 통과 주문은 S+1 시가 대기·거절은 사유, 네 계좌 운용·출발일 S·S 순자산 1억")
    void fourBooksStartTogether() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(8, null, KrClaudeFixtures.order("005930", "BUY", 8.0, null),
                KrClaudeFixtures.order("999999", "BUY", 5.0, null)));
        realClaude(fake);
        macroCards(S, kst("2026-11-30T22:25"));
        LocalDate todayKst = S;
        store.apiUsage.put(todayKst, new com.macrodash.store.PaperStore.ApiUsage(todayKst, 13, 0, 0, 0, 0));

        PaperDecisionJob.Result result = runAt("2026-11-30T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(krDecisions()).extracting(Decision::bookCode)
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        assertThat(krDecisions()).allSatisfy(d -> {
            assertThat(d.kind()).isEqualTo(RuleBookService.INITIAL);
            assertThat(d.asOfTradingDate()).isEqualTo(S);
            assertThat(d.settingsVersion()).isEqualTo(store.settings.version());
            assertThat(d.pricesFinal()).isFalse();
            assertThat(d.response().path("configuredStartDate").asString()).isEqualTo("2026-11-30");
            assertThat(d.response().path("postponed").asBoolean()).isFalse();
            assertThat(d.response().path("gates").size()).isEqualTo(5);
        });
        Decision claude = krDecisions().get(1);
        assertThat(claude.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(claude.model()).isEqualTo("claude-sonnet-5-5");
        assertThat(claude.retryCount()).isZero();
        assertThat(claude.response().path("startCalls").asInt()).isEqualTo(1);
        assertThat(fake.requests).singleElement().satisfies(request -> {
            assertThat(request.user()).as("결정 행 동결본 = 보낸 패킷 글자").isEqualTo(claude.packetText());
            assertThat(request.system()).contains("우선순위(고정)").doesNotContain("주문 최소 $");
            assertThat(request.schema().toString()).contains("NEXT_OPEN").doesNotContain("NEXT_OBSERVATION");
            assertThat(request.timeoutSeconds()).as("기한(01:00)까지 2시간 반 — 설정 대기 한도 그대로")
                    .isEqualTo(ClaudeBookService.DEFAULT_TIMEOUT_SECONDS);
        });
        JsonNode basis = claude.packet().path("1_basis");
        assertThat(basis.path("market").asString()).isEqualTo("KR");
        assertThat(basis.path("readAtKst").asString()).as("읽은 순간 = 그 실행의 지금(규칙 계좌 입력과 같음)")
                .isEqualTo("2026-11-30 22:30 KST");
        assertThat(basis.path("markets").path("cards")).hasSize(4).allSatisfy(card ->
                assertThat(card.path("asOfMismatch").asBoolean()).as(card.path("key").asString() + " — S 밤 판").isFalse());
        assertThat(store.apiUsage(todayKst).map(com.macrodash.store.PaperStore.ApiUsage::calls))
                .as("정기 작업 — 상한 − 예약(13) 뒤에도 부름").contains(14);
        List<Order> claudeOrders = store.orders.values().stream().filter(o -> o.bookCode().equals("kr_claude")).toList();
        assertThat(claudeOrders).extracting(Order::ticker, Order::status, Order::rejectReason, Order::timing,
                Order::targetWeightPct, Order::expiresOn).containsExactly(
                org.assertj.core.groups.Tuple.tuple("005930", "PENDING", null, "NEXT_OPEN", 8.0, LocalDate.of(2026, 12, 3)),
                org.assertj.core.groups.Tuple.tuple("999999", "REJECTED", "OUT_OF_UNIVERSE", "NEXT_OPEN", 5.0, null));
        assertThat(claudeOrders).allSatisfy(o -> {
            assertThat(o.decisionId()).isEqualTo(claude.id());
            assertThat(o.source()).isEqualTo("CLAUDE");
            assertThat(o.asOfTradingDate()).isEqualTo(S);
        });
        for (String code : List.of("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix")) {
            assertThat(store.books.get(code).status()).as(code).isEqualTo(PaperBooks.ACTIVE);
            assertThat(store.books.get(code).startedOn()).as(code).isEqualTo(S);
            assertThat(store.navSeries(code)).as(code + " S 마감 순자산 1억").singleElement()
                    .satisfies(nav -> assertThat(nav.nav()).isEqualTo(100_000_000.0));
        }
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.STARTED);
            assertThat(run.detail().path("books").path("kr_claude").path("decisionId").asLong()).isEqualTo(claude.id());
            assertThat(run.detail().path("books").path("kr_claude").path("orders").size()).isEqualTo(2);
        });

        assertThat(runAt("2026-11-30T22:40").outcome()).as("출발한 장부 — 같은 밤 다시 내지 않음")
                .isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(fake.requests).hasSize(1);
    }

    @Test
    @DisplayName("K28(E2b) — 네 계좌 출발 다음 밤(S+1 22:30)이 Claude 계좌의 첫 정기 결정: 출발 주문이 S+1 시가에 체결된 뒤(게이트 ① 통과) 그 실행의 관측치로 SCHEDULED, 출발 결정 주문은 이달 재량 주문에 세지 않음")
    void firstScheduledClaudeDecisionFollowsTheStart() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(8, null, KrClaudeFixtures.order("005930", "BUY", 8.0, null)));
        realClaude(fake);
        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);

        fake.answer(KrClaudeFixtures.decision(8, "관망"));
        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result next = runAt("2026-12-01T22:30");

        assertThat(next.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.values()).filteredOn(o -> o.bookCode().equals("kr_claude") && o.asOfTradingDate().equals(S))
                .as("출발 주문은 S+1 시가에 체결된 뒤").singleElement()
                .satisfies(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED));
        Decision claude = next.claude();
        assertThat(claude.kind()).isEqualTo(RuleBookService.SCHEDULED);
        assertThat(claude.asOfTradingDate()).isEqualTo(NEXT);
        assertThat(claude.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(claude.response().path("gates").get(0).path("status").asString()).as("① kr_claude").isEqualTo("PASS");
        assertThat(claude.response().path("monthlyDiscretionaryOrders").asInt()).as("출발 결정 주문은 세지 않음(E1a)").isZero();
        assertThat(claude.packet().path("9_portfolio").toString()).contains("005930");
        assertThat(fake.requests).hasSize(2);
    }

    @Test
    @DisplayName("K28(E2b) — 출발 패킷은 읽은 순간(S 22:30) 뒤에 수집된 저장본을 쓰지 않음: 22:31에 수집된 매크로 카드·선물 일봉은 빠지고 사유가 남음(결정 시각 전 S 밤 판만 — §5 출발)")
    void claudeStartPacketLeavesOutSnapshotsAfterTheReadInstant() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(0, "관망"));
        realClaude(fake);
        macroCards(S, kst("2026-11-30T22:31"));
        tools.jackson.databind.node.ObjectNode futures = PaperFixtures.MAPPER.createObjectNode();
        futures.putArray("rows").addObject().put("date", S.toString()).put("contractName", "코스피200 F 202612 (주간)")
                .put("futuresClose", 560.0);
        KrFixtures.stub(reader, Datasets.SNAP_KRX_FUTURES, KrFixtures.snapshot(Datasets.SNAP_KRX_FUTURES, futures,
                kst("2026-11-30T22:31")));

        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);

        Decision claude = krDecisions().get(1);
        assertThat(claude.bookCode()).isEqualTo("kr_claude");
        assertThat(claude.status()).as("통과 주문 없음 — 현금만 든 채 출발").isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(claude.packet().path("1_basis").path("markets").path("missing").asString()).contains("읽은 순간 뒤에 수집됨");
        assertThat(claude.packet().path("1_basis").path("markets").has("cards")).isFalse();
        assertThat(claude.packet().path("1_basis").path("futures").path("daily").path("missing").asString())
                .startsWith(KrPacketBuilder.LATE_SNAPSHOT);
        assertThat(store.books.get("kr_claude").status()).isEqualTo(PaperBooks.ACTIVE);
    }

    @Test
    @DisplayName("K28(E2b) — Claude 출발이 하루 상한(정기 작업 몫까지 20회)에 막히면 부르지 않고 네 계좌 모두 출발하지 않음(쓰기 없음) → 미룸 한 번, 다음 KR 거래일 22:30에 네 계좌가 함께 출발(바뀐 출발일 = 결정 행 기준 거래일, postponed)")
    void claudeCapPostponesAllFourBooks() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        realClaude(fake);
        store.apiUsage.put(S, new com.macrodash.store.PaperStore.ApiUsage(S, 20, 0, 0, 0, 0));

        PaperDecisionJob.Result capped = runAt("2026-11-30T22:30");

        assertThat(capped.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(capped.message()).contains("kr_claude").contains("일일 호출 상한(20회").contains("2026-12-01");
        assertThat(fake.requests).isEmpty();
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertNotStarted(store);
        assertThat(store.navSeries("kr_bench_k200")).isEmpty();
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
            assertThat(run.detail().path("reason").asString()).contains("출발 계획 실패").contains("kr_claude")
                    .contains("일일 호출 상한");
            assertThat(run.detail().path("postponedTo").asString()).isEqualTo("2026-12-01");
        });
        assertThat(runAt("2026-11-30T22:40").outcome()).as("그 세션은 다시 계획하지 않음").isEqualTo(PaperDecisionJob.START_POSTPONED);

        fake.answer(KrClaudeFixtures.decision(0, "관망"));
        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result started = runAt("2026-12-01T22:30");

        assertThat(started.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(krDecisions()).extracting(Decision::bookCode)
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        assertThat(krDecisions()).allSatisfy(d -> {
            assertThat(d.asOfTradingDate()).isEqualTo(NEXT);
            assertThat(d.response().path("postponed").asBoolean()).isTrue();
            assertThat(d.response().path("configuredStartDate").asString()).isEqualTo("2026-11-30");
        });
        assertThat(store.books.get("kr_claude").startedOn()).isEqualTo(NEXT);
        assertThat(store.apiUsage(NEXT).map(com.macrodash.store.PaperStore.ApiUsage::calls)).contains(1);
    }

    @Test
    @DisplayName("K28(E2b) — Claude 출발 API 오류는 같은 계획 안에서 한 번 더 부르고(재시도 1회), 그래도 실패면 네 계좌 모두 미룸(사유에 재시도 1회 뒤) — 같은 창에서 재기동해도 다시 계획하지 않고(Claude를 다시 부르지 않음, 미룸 기록 한 번), 거절(refusal)은 다시 부르지 않음")
    void claudeErrorAfterOneRetryPostponesAndIsNotReplanned() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.fail("API_ERROR", "overloaded").fail("API_ERROR", "overloaded again");
        realClaude(fake);

        PaperDecisionJob.Result failed = runAt("2026-11-30T22:30");

        assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(fake.requests).as("첫 호출 + 재시도 1회").hasSize(2);
        assertThat(failed.message()).contains("Claude 출발 호출 실패(API 오류, 재시도 1회 뒤)").contains("overloaded again");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertNotStarted(store);
        assertThat(store.apiUsage(S).map(com.macrodash.store.PaperStore.ApiUsage::calls)).as("과금됐을 수 있는 호출 둘").contains(2);

        realClaude(fake);   // 같은 창에서 재기동
        PaperDecisionJob.Result again = runAt("2026-11-30T22:40");
        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(again.message()).contains("그 세션은 이미 미뤘음");
        assertThat(fake.requests).as("Claude를 다시 부르지 않음(K28 '다음 KR 거래일로')").hasSize(2);
        assertThat(krRuns()).as("미룸 기록은 재기동을 넘어 한 번").extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns().get(0).detail().path("reason").asString()).contains("재시도 1회 뒤");

        // 다음 KR 거래일 — 거절은 같은 입력이면 같은 답이라 다시 부르지 않고 바로 미룸.
        fake.fail("REFUSAL", "안전 분류기 거절");
        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result refused = runAt("2026-12-01T22:30");
        assertThat(refused.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(refused.message()).contains("Claude가 거절함(refusal)").doesNotContain("재시도");
        assertThat(fake.requests).hasSize(3);
        assertNotStarted(store);
    }

    @Test
    @DisplayName("K28(묶음 E 리뷰) — Claude 출발 API 오류의 재시도는 첫 호출의 패킷을 그대로 다시 보냄: 첫 호출 중에 매크로 카드가 다시 수집돼(22:35 — 읽은 순간 뒤) 저장본이 바뀌어도 재시도 패킷 = 첫 패킷(카드 넷), 결정 행 동결본도 같음")
    void claudeStartRetrySendsTheFirstPacket() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.fail("API_ERROR", "overloaded").answer(KrClaudeFixtures.decision(0, "관망"));
        macroCards(S, kst("2026-11-30T22:25"));
        fake.duringCall = () -> macroCards(S, kst("2026-11-30T22:35"));   // fast 그룹이 첫 호출 중에 카드 저장본을 다시 씀
        realClaude(fake);

        PaperDecisionJob.Result result = runAt("2026-11-30T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(fake.requests).as("첫 호출 + 재시도 1회").hasSize(2);
        assertThat(fake.requests.get(1).user()).as("재시도 패킷 = 첫 패킷").isEqualTo(fake.requests.get(0).user());
        assertThat(fake.requests.get(1).system()).isEqualTo(fake.requests.get(0).system());
        Decision claude = krDecisions().get(1);
        assertThat(claude.bookCode()).isEqualTo("kr_claude");
        assertThat(claude.retryCount()).isEqualTo(1);
        assertThat(claude.packetText()).isEqualTo(fake.requests.get(0).user());
        assertThat(claude.packet().path("1_basis").path("markets").path("cards")).as("읽은 순간에 있던 카드").hasSize(4);
    }

    @Test
    @DisplayName("K28·§9 'E2 — 출발 갈고리의 기한'(E2b) — Claude 출발 호출의 대기 한도는 기한까지 남은 시간(00:58이면 120초)으로 묶이고, 호출이 기한을 넘겨 끝나면 쓰기 트랜잭션이 막아 어느 계좌에도 쓰지 않음, 기한까지 최소 대기 한도 60초가 남지 않았으면(0.6초) 부르지 않고 미룸(w12)")
    void claudeStartCallIsBoundedByTheDeadline() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(0, "관망"));
        fake.duringCall = () -> clock.set(kst("2026-12-01T01:01"));   // 호출이 기한을 넘겨 끝남
        realClaude(fake);

        PaperDecisionJob.Result late = runAt("2026-12-01T00:58");

        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(fake.requests).singleElement().satisfies(request ->
                assertThat(request.timeoutSeconds()).as("기한 01:00 − 00:58").isEqualTo(120));
        assertThat(late.message()).contains("출발 계획이 기한을 넘겨 끝남(2026-12-01 01:01 KST)");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertNotStarted(store);

        sessionData(NEXT, S, everyCodeOn(NEXT));
        clock.set(kst("2026-12-02T00:59").plusMillis(59_400));   // 기한(12-02 01:00)까지 0.6초
        PaperDecisionJob.Result noTime = job.run(KrPaperMarket.INSTANCE);
        assertThat(noTime.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(noTime.message()).contains("kr_claude").contains("까지 0초 — 최소 대기 한도 60초보다 짧아 Claude를 부르지 않음");
        assertThat(fake.requests).as("부르지 않음").hasSize(1);
        assertNotStarted(store);
    }

    @Test
    @DisplayName("K28·사용자 결정 w12 — Claude 출발 호출의 최소 대기 한도 60초: 기한(S+1 01:00)까지 59초면 부르지 않고 네 계좌 모두 미룸(사유와 함께 저장 — 같은 창에서 재기동해도 다시 부르지 않음), 다음 KR 거래일 기한까지 정확히 60초면 대기 한도 60초로 불러 네 계좌가 함께 출발")
    void claudeStartNeedsSixtySecondsBeforeTheDeadline() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(0, "관망"));
        realClaude(fake);

        PaperDecisionJob.Result tooLate = runAt("2026-12-01T00:59:01");   // 기한 12-01 01:00까지 59초

        assertThat(tooLate.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(fake.requests).as("부르지 않음").isEmpty();
        assertThat(tooLate.message()).contains("kr_claude")
                .contains("출발 기한(2026-12-01 01:00 KST)까지 59초 — 최소 대기 한도 60초보다 짧아 Claude를 부르지 않음");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertNotStarted(store);
        assertThat(store.apiUsage(NEXT)).as("호출 수를 잡지 않음").isEmpty();
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
            assertThat(run.detail().path("reason").asString()).contains("출발 계획 실패").contains("kr_claude")
                    .contains("최소 대기 한도 60초보다 짧아 Claude를 부르지 않음");
            assertThat(run.detail().path("postponedTo").asString()).isEqualTo("2026-12-01");
            assertThat(run.detail().has("calls")).as("과금 호출 없음").isFalse();
        });

        realClaude(fake);   // 같은 창에서 재기동
        PaperDecisionJob.Result again = runAt("2026-12-01T00:59:30");
        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(again.message()).contains("그 세션은 이미 미뤘음");
        assertThat(fake.requests).isEmpty();
        assertThat(krRuns()).as("미룸 기록은 한 번").hasSize(1);

        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result started = runAt("2026-12-02T00:59:00");   // 기한 12-02 01:00까지 정확히 60초

        assertThat(started.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(fake.requests).singleElement().satisfies(request ->
                assertThat(request.timeoutSeconds()).as("대기 한도 = 기한까지 남은 60초").isEqualTo(60));
        assertThat(krDecisions()).extracting(Decision::bookCode)
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        assertThat(krDecisions()).allSatisfy(d -> assertThat(d.asOfTradingDate()).isEqualTo(NEXT));
        assertThat(store.books.get("kr_claude").startedOn()).isEqualTo(NEXT);
    }

    @Test
    @DisplayName("K28·사용자 결정 w12 — Claude 출발 호출이 429(RATE_LIMIT)면 30초 기다린 뒤(가짜 기다림 — 시계만 옮김) 첫 호출의 패킷 그대로 한 번만 다시 부르고, 성공하면 네 계좌가 함께 출발(결정 행 재시도 1·호출 2회)")
    void claudeStartRateLimitWaitsThirtySecondsThenRetriesOnce() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.rateLimited().answer(KrClaudeFixtures.decision(0, "관망"));
        realClaude(fake);

        PaperDecisionJob.Result result = runAt("2026-11-30T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(sleeper.sleeps).as("429 뒤 한 번 30초").containsExactly(java.time.Duration.ofSeconds(30));
        assertThat(fake.requests).as("첫 호출 + 기다린 재시도 1회").hasSize(2);
        assertThat(fake.requests.get(1).user()).as("재시도 패킷 = 첫 패킷").isEqualTo(fake.requests.get(0).user());
        assertThat(fake.requests).extracting(KrClaudeFixtures.Request::timeoutSeconds).containsExactly(300, 300);
        Decision claude = krDecisions().get(1);
        assertThat(claude.bookCode()).isEqualTo("kr_claude");
        assertThat(claude.retryCount()).isEqualTo(1);
        assertThat(claude.response().path("startCalls").asInt()).isEqualTo(2);
        assertThat(krDecisions()).extracting(Decision::bookCode)
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        assertThat(store.apiUsage(S).map(com.macrodash.store.PaperStore.ApiUsage::calls)).as("429도 호출 수에 셈").contains(2);
    }

    @Test
    @DisplayName("K28·사용자 결정 w12 — 429가 기한까지 90초(기다림 30초 + 최소 대기 한도 60초) 미만에 나면 기다리지 않고 다시 부르지 않으며 네 계좌 모두 미룸(사유·호출 기록과 함께 저장 — 재기동 뒤에도 다시 부르지 않음), 정확히 90초면 30초 기다려 대기 한도 60초로 다시 불러 출발")
    void claudeStartRateLimitNearTheDeadlineIsNotRetried() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.rateLimited();
        realClaude(fake);

        PaperDecisionJob.Result postponed = runAt("2026-12-01T00:58:31");   // 기한 12-01 01:00까지 89초

        assertThat(postponed.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(fake.requests).singleElement().satisfies(request ->
                assertThat(request.timeoutSeconds()).as("첫 호출의 대기 한도 = 남은 89초").isEqualTo(89));
        assertThat(sleeper.sleeps).as("기다리지 않음").isEmpty();
        assertThat(postponed.message()).contains("kr_claude").contains("Claude 출발 호출 실패(API 오류 — 429 속도 제한, "
                + "출발 기한(2026-12-01 01:00 KST)까지 89초라 30초 기다린 뒤 최소 대기 한도 60초가 남지 않아 다시 부르지 않음)");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertNotStarted(store);
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
            assertThat(run.detail().path("reason").asString()).contains("429 속도 제한");
            assertThat(run.detail().path("calls").path("kr_claude").path("calls").asInt()).isEqualTo(1);
            assertThat(run.detail().path("calls").path("kr_claude").path("attempts").get(0).path("errorKind").asString())
                    .isEqualTo("RATE_LIMIT");
        });

        realClaude(fake);   // 같은 창에서 재기동
        assertThat(runAt("2026-12-01T00:59:00").message()).contains("그 세션은 이미 미뤘음");
        assertThat(fake.requests).as("다시 부르지 않음").hasSize(1);

        fake.rateLimited().answer(KrClaudeFixtures.decision(0, "관망"));
        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result started = runAt("2026-12-02T00:58:30");   // 기한 12-02 01:00까지 정확히 90초

        assertThat(started.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(sleeper.sleeps).containsExactly(java.time.Duration.ofSeconds(30));
        assertThat(fake.requests.subList(1, 3)).extracting(KrClaudeFixtures.Request::timeoutSeconds)
                .as("90초 → 기다린 뒤 60초").containsExactly(90, 60);
        assertThat(krDecisions()).allSatisfy(d -> assertThat(d.asOfTradingDate()).isEqualTo(NEXT));
        assertThat(store.books.get("kr_claude").startedOn()).isEqualTo(NEXT);
    }

    @Test
    @DisplayName("K28·사용자 결정 w12 — 429가 아닌 API 오류(5xx·529)는 예전처럼 기다리지 않고 바로 한 번 더 부름 — 그 재시도에도 최소 대기 한도 60초(첫 호출이 끝났을 때 55초면 다시 부르지 않고 미룸)")
    void claudeStartServerErrorRetriesAtOnce() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.fail("HTTP", "HTTP 500 (api_error)");
        fake.duringCall = () -> clock.set(kst("2026-12-01T00:59:05"));   // 첫 호출이 00:59:05에 끝남 — 기한까지 55초
        realClaude(fake);

        PaperDecisionJob.Result postponed = runAt("2026-12-01T00:58:50");

        assertThat(postponed.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(fake.requests).hasSize(1);
        assertThat(sleeper.sleeps).isEmpty();
        assertThat(postponed.message()).contains("까지 55초 — 최소 대기 한도 60초보다 짧아 Claude를 다시 부르지 않음(첫 호출 API 오류)");
        assertNotStarted(store);

        fake.fail("HTTP", "HTTP 529 (overloaded_error) — Anthropic 서버가 과부하입니다. 잠시 후 다시 시도하세요.")
                .answer(KrClaudeFixtures.decision(0, "관망"));
        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result started = runAt("2026-12-01T22:30");

        assertThat(started.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(fake.requests).as("첫 호출 + 바로 재시도").hasSize(3);
        assertThat(sleeper.sleeps).as("기다리지 않음").isEmpty();
        assertThat(fake.requests.get(2).user()).isEqualTo(fake.requests.get(1).user());
        assertThat(krDecisions().get(1).retryCount()).isEqualTo(1);
        assertThat(store.books.get("kr_claude").startedOn()).isEqualTo(NEXT);
    }

    @Test
    @DisplayName("Claude 몫이 '아직 없음'이면(가짜 Claude 서비스) 규칙·벤치마크만 출발하고 Claude는 뒤따라 출발하지 않음 — 다음 밤은 정기 결정(규칙 계좌 12월 주기 REBALANCE)")
    void claudeNotYetStaysNotStarted() {
        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);

        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result next = runAt("2026-12-01T22:30");

        assertThat(next.outcome()).as("출발 판정(모두 시작 전)이 거짓 — 정기 결정").isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(store.orders.values()).filteredOn(o -> o.bookCode().equals("kr_rules") && o.asOfTradingDate().equals(S))
                .as("게이트 ① — 출발 주문이 S+1 시가에 체결된 뒤(그 실행이 장부를 처리)").isNotEmpty()
                .allSatisfy(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED));
        assertThat(next.rules().response().path("gates").get(0).path("status").asString()).isEqualTo("PASS");
        assertThat(next.rules().kind()).as("12-01 = 12월 첫 거래일 — 새 주기").isEqualTo(RuleBookService.REBALANCE);
        assertThat(next.rules().response().path("cycleDate").asString()).isEqualTo("2026-12-01");
        assertThat(store.books.get("kr_claude").status()).isEqualTo(PaperBooks.NOT_STARTED);
        assertThat(krRuns()).extracting(JobRun::outcome).containsExactly(PaperDecisionJob.STARTED, PaperDecisionJob.DECIDED);
        assertThat(krRuns().get(1).detail().path("claude").asString()).contains("시작 전");
    }

    @Test
    @DisplayName("출발 결정의 입력은 결정 시각(S 22:30) 전에 알 수 있던 것만 — S 당일 기준일 U·S 뒤 날짜·22:30 뒤에 다시 받은 수급은 쓰지 않음(initialPacketHasNothingAfterAsOf의 한국판)")
    void startInputsHaveNothingAfterTheDecision() {
        rulesData.member(S, 1, "999999", "미래종목", 1_000_000_000L);
        rulesData.flow("005930", S, 9_999_999L, 9_999_999L, "2026-12-01T06:50:04.000+09:00", kst("2026-11-30T23:00"));
        // 게이트 ③(U 90%)이 005930 하나 빠진 채 통과하도록 U를 열 종목으로(9/10) — 더한 둘은 S까지 수급, 둘 다 순매도.
        for (LocalDate base : rulesData.universe.keySet()) {
            rulesData.member(base, 9, "035420", "NAVER", 160_000_000L).member(base, 10, "035720", "카카오", 440_000_000L);
        }
        rulesData.flows("035420", S, 30, -1_000, -1_000).flows("035720", S, 30, -1_000, -1_000);

        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);

        Decision rules = krDecisions().get(0);
        JsonNode input = rules.response().path("input");
        assertThat(input.path("readAtKst").asString()).isEqualTo("2026-11-30 22:30 KST");
        assertThat(input.path("universe").path("baseDate").asString()).isEqualTo("2026-11-27");
        assertThat(input.path("members")).extracting(m -> m.path("code").asString()).doesNotContain("999999");
        assertThat(input.path("excludedFlowRecords").toString())
                .as("12-01 기록 8종목, 22:30 뒤에 받은 S 기록 하나").isEqualTo("{\"afterSession\":8,\"fetchedAfterRead\":1}");
        assertThat(rules.response().toString()).doesNotContain("9999999").doesNotContain("미래종목");
        for (JsonNode member : input.path("members")) {
            assertThat(member.path("flows").toString()).doesNotContain("2026-12-01");
            if (member.path("flows").path("sessionFetchedAt").isString()) {
                assertThat(Instant.parse(member.path("flows").path("sessionFetchedAt").asString()))
                        .isBeforeOrEqualTo(kst("2026-11-30T22:30"));
            }
        }
        assertThat(store.orders.values()).filteredOn(o -> o.bookCode().equals("kr_rules"))
                .extracting(Order::ticker).as("005930은 S 기록이 결정 뒤 판뿐 — 자료 부족").doesNotContain("005930");
    }

    @Test
    @DisplayName("규칙 계좌 출발 계획이 실패하면(계좌 상태 없음) 어느 계좌에도 쓰지 않고 그 세션을 미룸 — 사유에 규칙 계좌와 원인")
    void rulesLegFailurePostponesTheStart() {
        store.states.remove(PaperBooks.KR_RULES);

        PaperDecisionJob.Result result = runAt("2026-11-30T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(result.message()).contains("kr_rules").contains("상태가 없습니다");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(store.books.values()).filteredOn(b -> b.market().equals("KR"))
                .allSatisfy(b -> assertThat(b.status()).isEqualTo(PaperBooks.NOT_STARTED));
        assertThat(krRuns()).singleElement().satisfies(run ->
                assertThat(run.detail().path("reason").asString()).contains("규칙 계좌 출발 계획 실패"));
    }

    @Test
    @DisplayName("K28(묶음 E 리뷰) — 과금되는 Claude 몫은 다른 몫(규칙·벤치마크)을 모두 계획한 뒤에 부름: 규칙 계좌 계획이 실패하면 Claude를 부르지 않고(호출 0·사용량 0) 미룸, 사유에 '부르지 않음', 다음 KR 거래일에 네 계좌가 함께 출발(결정 행 순서는 그대로)")
    void claudeIsNotCalledWhenAnotherLegFails() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        realClaude(fake);
        com.macrodash.store.PaperStore.BookState rulesState = store.states.remove(PaperBooks.KR_RULES);

        PaperDecisionJob.Result result = runAt("2026-11-30T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(fake.requests).as("Claude를 부르지 않음").isEmpty();
        assertThat(store.apiUsage(S)).isEmpty();
        assertThat(result.message()).contains("kr_rules").contains("상태가 없습니다")
                .contains("다른 계좌의 출발 계획이 실패해 부르지 않음: kr_claude");
        assertNotStarted(store);

        store.states.put(PaperBooks.KR_RULES, rulesState);
        fake.answer(KrClaudeFixtures.decision(0, "관망"));
        sessionData(NEXT, S, everyCodeOn(NEXT));
        assertThat(runAt("2026-12-01T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(krDecisions()).extracting(Decision::bookCode)
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        assertThat(fake.requests).hasSize(1);
    }

    @Test
    @DisplayName("E0(사용자 결정 v3) 재기동 — 계획 실패로 미룬 세션은 같은 창에서 백엔드를 다시 띄워도 다시 계획하지 않음(저장된 미룸 기록): 계좌 상태가 돌아와도 그 세션은 출발하지 않고 미룸 기록도 한 번, 다음 KR 거래일 창에서 출발")
    void postponedSessionIsNotReplannedAfterARestart() {
        com.macrodash.store.PaperStore.BookState saved = store.states.remove(PaperBooks.KR_RULES);
        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.times(1)).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), any(LocalDate.class));

        restart();
        store.states.put(PaperBooks.KR_RULES, saved);   // 이제는 계획이 될 수 있어도 — 그 세션은 이미 미룸(K28 '다음 KR 거래일로')
        PaperDecisionJob.Result again = runAt("2026-11-30T22:40");

        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(again.message()).contains("그 세션은 이미 미뤘음").contains("2026-12-01");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.times(1)).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), any(LocalDate.class));
        assertThat(krRuns()).as("미룸 기록은 재기동을 넘어 세션마다 한 번").singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
            assertThat(run.detail().path("reason").asString()).contains("규칙 계좌 출발 계획 실패");
        });

        restart();
        sessionData(NEXT, S, everyCodeOn(NEXT));
        assertThat(runAt("2026-12-01T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(krDecisions()).extracting(Decision::asOfTradingDate).containsOnly(NEXT);
    }

    @Test
    @DisplayName("E0(사용자 결정 v3) 재기동 — 기한까지 ⑤로 기다린 세션은 기한 직후 백엔드를 다시 띄워도 미룸 사유가 그 창의 마지막 기다림(저장된 기다림 줄), 미룸 기록은 재기동을 넘어 한 번")
    void postponementReasonSurvivesARestart() {
        Map<String, LocalDate> noAnchor = everyCodeOn(S);
        noAnchor.put("069500", PREV);
        sessionData(S, PREV, noAnchor);
        assertThat(runAt("2026-11-30T23:50").outcome()).isEqualTo(PaperDecisionJob.START_WAITING);

        restart();
        PaperDecisionJob.Result postponed = runAt("2026-12-01T01:00");
        assertThat(postponed.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(postponed.message()).contains("⑤").contains("069500");
        restart();
        assertThat(runAt("2026-12-01T01:10").outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);

        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.START_WAITING, PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns().get(1).detail().path("reason").asString()).contains("⑤").contains("069500");
    }

    @Test
    @DisplayName("게이트 ③ — D 앞 기준일의 U가 없으면(수집기 kr_paper_universe 전) 계획 실패가 아니라 기다림: 쓰기 없음·기다림 한 줄, U가 들어오면 그 창에서 출발, 끝내 없으면 기한 뒤 미룸(사유 ③ — 그 기다림 줄에서)")
    void missingUniverseWaitsAtGateThree() {
        java.util.TreeMap<LocalDate, List<tools.jackson.databind.node.ObjectNode>> saved = new java.util.TreeMap<>(rulesData.universe);
        rulesData.universe.clear();

        PaperDecisionJob.Result waiting = runAt("2026-11-30T22:30");
        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
        assertThat(waiting.message()).contains("③").contains("U·수급을 읽지 못함").contains("kr_paper_universe")
                .doesNotContain("②").doesNotContain("④").doesNotContain("⑤");
        assertThat(krDecisions()).isEmpty();
        assertThat(krRuns()).as("기다림은 그 세션 기다림 한 줄(E0)").singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
            assertThat(run.detail().path("reason").asString()).contains("③").contains("kr_paper_universe");
            assertThat(gateStatuses(run.detail().path("gates"))).contains("③ FAIL");
        });

        PaperDecisionJob.Result postponed = runAt("2026-12-01T01:00");
        assertThat(postponed.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.START_WAITING, PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns().get(1).detail().path("reason").asString()).contains("③").contains("kr_paper_universe");

        // 다음 KR 거래일 창 — U가 들어와 있으면 출발(같은 읽기로 ③ 통과)
        rulesData.universe.putAll(saved);
        sessionData(NEXT, S, everyCodeOn(NEXT));
        assertThat(runAt("2026-12-01T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);
    }

    @Test
    @DisplayName("게이트 ③ — U 90% 미만에 장 마감 뒤 판(15:35 이후)·세부 칸이 있으면 기다림: 장중 판 하나(7/8)·세부 칸 없는 판 하나는 미달, 저녁 판이 오면 같은 창에서 출발하고 결정 행 ③에 U 8/8")
    void flowsGateNeedsTheEveningVersion() {
        rulesData.flow("005930", S, 100_000L, 50_000L, "2026-11-30T14:58:03.000+09:00", kst("2026-11-30T21:18"));

        PaperDecisionJob.Result intraday = runAt("2026-11-30T22:30");
        assertThat(intraday.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
        assertThat(intraday.message()).contains("③ U 7/8").contains("15:35 전 판 1(005930)").contains("90% 미만");

        rulesData.flow("005930", S, 100_000L, 50_000L, "2026-11-30T20:21:26.000+09:00", kst("2026-11-30T22:31"));
        rulesData.flows.get("005930").get(S).remove("breakdown");
        PaperDecisionJob.Result noDetail = runAt("2026-11-30T22:40");
        assertThat(noDetail.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
        assertThat(noDetail.message()).contains("③ U 7/8").contains("세부 칸 없음 1(005930)");

        rulesData.flow("005930", S, 100_000L, 50_000L, "2026-11-30T20:21:26.000+09:00", kst("2026-11-30T22:45"));
        assertThat(runAt("2026-11-30T22:50").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(krDecisions()).allSatisfy(d -> assertThat(d.response().path("gates").get(1).path("note").asString())
                .contains("U 8/8"));
        assertThat(krRuns()).as("이어진 기다림 둘은 한 줄(E0 — 마지막 사유, 두 주기)").extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.START_WAITING, PaperDecisionJob.STARTED);
        assertThat(krRuns().get(0).detail().path("reason").asString()).contains("세부 칸 없음 1(005930)");
        assertThat(krRuns().get(0).detail().path("checks").asInt()).isEqualTo(2);
        assertThat(krRuns().get(0).startedAt()).isEqualTo(kst("2026-11-30T22:30"));
        assertThat(krRuns().get(0).finishedAt()).as("줄의 끝 = 마지막 기다림").isEqualTo(kst("2026-11-30T22:40"));
    }

    @Test
    @DisplayName("게이트 ③ 문턱 — U 10종목 중 9(90%)에 저녁 판이면 통과(문턱 포함), 그 빠진 종목은 규칙 계좌 입력에서도 자료 부족(같은 읽기)")
    void flowsGateAtNinetyPercentPasses() {
        for (LocalDate base : rulesData.universe.keySet()) {
            rulesData.member(base, 9, "035420", "NAVER", 160_000_000L).member(base, 10, "035720", "카카오", 440_000_000L);
        }
        rulesData.flows("035420", S, 30, -1_000, -1_000).flows("035720", PREV, 30, -1_000, -1_000);   // 카카오는 S 기록 없음

        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        Decision rules = krDecisions().get(0);
        assertThat(rules.response().path("gates").get(1).path("note").asString()).contains("U 9/10")
                .contains("D 기록 없음 1(035720)");
        JsonNode kakao = null;
        for (JsonNode member : rules.response().path("input").path("members")) {
            if ("035720".equals(member.path("code").asString())) {
                kakao = member;
            }
        }
        assertThat(kakao).isNotNull();
        assertThat(kakao.path("candidate").asBoolean()).isFalse();
        assertThat(kakao.path("reasons").toString()).contains("자료 부족");
    }

    @Test
    @DisplayName("출발일 전·결정 시각 전에는 내지 않음 — 기록도 없음")
    void notBeforeTheWindow() {
        assertThat(runAt("2026-11-27T22:40").outcome()).as("S 전 세션(11-27)").isEqualTo(PaperDecisionJob.TOO_EARLY);
        assertThat(runAt("2026-11-30T22:29").outcome()).isEqualTo(PaperDecisionJob.TOO_EARLY);
        assertThat(runAt("2026-11-30T15:40").message()).contains("출발 결정 시각");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(krRuns()).isEmpty();
    }

    @Test
    @DisplayName("한 트랜잭션 — 마지막 계좌(60/40)의 주문을 넣다 실패하면 먼저 쓴 규칙·KODEX 200 계좌의 결정·주문·운용 전환·순자산 줄까지 모두 되돌리고 ERROR 기록, 다음 주기에 출발")
    void startIsAtomic() {
        failShortBond.set(true);
        PaperDecisionJob.Result failed = runAt("2026-11-30T22:30");

        assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.ERROR);
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(store.books.values()).filteredOn(b -> b.market().equals("KR"))
                .allSatisfy(b -> assertThat(b.status()).isEqualTo(PaperBooks.NOT_STARTED));
        assertThat(store.nav.values()).allSatisfy(rows -> assertThat(rows).isEmpty());
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.ERROR);
            assertThat(run.detail().path("start").asBoolean()).isTrue();
            assertThat(run.detail().path("error").asString()).contains("시험용 주문 실패");
        });

        failShortBond.set(false);
        assertThat(runAt("2026-11-30T22:40").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(store.orders).as("규칙 6 + 벤치마크 3").hasSize(9);
    }

    @Test
    @DisplayName("§4-10(묶음 E 리뷰) — 결정 행 없이 끝난 출발의 과금된 Claude 호출은 그 작업 기록에서 셈: 미룸(API 오류 두 번)·쓰기 오류 뒤 미룸(묶음 E 2차 리뷰) 기록의 calls.kr_claude = 호출 수·호출마다 상태·과금·토큰·추정 비용")
    void startRecordsCountTheChargedClaudeCalls() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.fail("API_ERROR", "overloaded").fail("API_ERROR", "overloaded again");
        realClaude(fake);

        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);

        assertThat(krRuns()).singleElement().satisfies(run -> {
            JsonNode calls = run.detail().path("calls").path("kr_claude");
            assertThat(calls.path("calls").asInt()).isEqualTo(2);
            assertThat(calls.path("isEstimated").asBoolean()).isTrue();
            assertThat(calls.path("attempts")).hasSize(2).allSatisfy(a -> {
                assertThat(a.path("status").asString()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
                assertThat(a.path("charged").asBoolean()).isTrue();
                assertThat(a.path("errorKind").asString()).isEqualTo("API_ERROR");
            });
        });

        // 다음 KR 거래일 — Claude 응답을 받은 뒤 쓰기 트랜잭션이 실패(그 세션 미룸 — chargedStartWriteFailurePostponesTheSession): 기록에 그 호출(토큰·추정 비용).
        fake.answer(KrClaudeFixtures.decision(0, "관망"));
        failShortBond.set(true);
        sessionData(NEXT, S, everyCodeOn(NEXT));
        assertThat(runAt("2026-12-01T22:30").outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns()).last().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
            assertThat(run.detail().path("error").asString()).as("오류 문구는 그대로").startsWith("IllegalStateException 시험용 주문 실패");
            JsonNode calls = run.detail().path("calls").path("kr_claude");
            assertThat(calls.path("calls").asInt()).isEqualTo(1);
            JsonNode attempt = calls.path("attempts").get(0);
            assertThat(attempt.path("status").asString()).isEqualTo("RESPONDED");
            assertThat(attempt.path("inputTokens").asLong()).isEqualTo(21_000);
            assertThat(attempt.path("outputTokens").asLong()).isEqualTo(3_100);
            assertThat(attempt.path("estCostUsd").asDouble()).as("기본 sonnet 단가 (21,000×2 + 3,100×10 + 7,800×0.1)/1e6")
                    .isCloseTo(0.07378, org.assertj.core.api.Assertions.within(1e-9));
        });
        assertNotStarted(store);
    }

    @Test
    @DisplayName("K28·사용자 결정 v3(묶음 E 2차 리뷰) — 과금된 Claude 출발 계획 뒤 쓰기가 실패하면 그 세션을 저장된 미룸으로: ERROR 대신 START_POSTPONED(사유 '출발 쓰기 오류'·오류 문구·calls), 22:40과 재기동 뒤 22:50에도 다시 계획하지 않아 Claude 호출은 1회, 미룸 기록 한 번, 다음 KR 거래일 창에서 네 계좌 출발")
    void chargedStartWriteFailurePostponesTheSession() {
        KrClaudeFixtures.FakeAi fake = new KrClaudeFixtures.FakeAi();
        fake.answer(KrClaudeFixtures.decision(0, "관망")).answer(KrClaudeFixtures.decision(0, "관망"))
                .answer(KrClaudeFixtures.decision(0, "관망"));
        realClaude(fake);
        failShortBond.set(true);

        PaperDecisionJob.Result failed = runAt("2026-11-30T22:30");

        assertThat(failed.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(failed.message()).contains("출발 쓰기 오류").contains("시험용 주문 실패").contains("2026-12-01");
        assertThat(fake.requests).hasSize(1);
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertNotStarted(store);
        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
            assertThat(run.detail().path("reason").asString()).contains("출발 쓰기 오류")
                    .contains("IllegalStateException 시험용 주문 실패");
            assertThat(run.detail().path("postponedTo").asString()).isEqualTo("2026-12-01");
            assertThat(run.detail().path("calls").path("kr_claude").path("calls").asInt()).isEqualTo(1);
        });

        assertThat(runAt("2026-11-30T22:40").outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(fake.requests).as("같은 창에서 다시 계획하지 않음").hasSize(1);
        realClaude(fake);   // 같은 창에서 재기동
        PaperDecisionJob.Result again = runAt("2026-11-30T22:50");
        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(again.message()).contains("그 세션은 이미 미뤘음");
        assertThat(fake.requests).as("재기동해도 Claude를 다시 부르지 않음").hasSize(1);
        assertThat(krRuns()).as("미룸 기록은 재기동을 넘어 한 번").extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.START_POSTPONED);
        assertThat(store.apiUsage(S).map(com.macrodash.store.PaperStore.ApiUsage::calls)).contains(1);

        failShortBond.set(false);
        sessionData(NEXT, S, everyCodeOn(NEXT));
        assertThat(runAt("2026-12-01T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(krDecisions()).extracting(Decision::bookCode)
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        assertThat(fake.requests).hasSize(2);
    }

    @Test
    @DisplayName("C1c·사용자 결정 v3(묶음 E 2차 리뷰) — 출발 오류 횟수는 그 세션의 저장된 출발 ERROR 기록 수: 쓰기 오류 세 번(과금 몫 없음 — attempt 1·2·3) 뒤에는 쓰기가 나아도 기한까지 쉬고, 같은 창에서 재기동해도 다시 시도하지 않음, 기한 뒤 미룸")
    void startErrorCountSurvivesARestart() {
        failShortBond.set(true);
        for (String at : List.of("2026-11-30T22:30", "2026-11-30T22:40", "2026-11-30T22:50")) {
            assertThat(runAt(at).outcome()).as(at).isEqualTo(PaperDecisionJob.ERROR);
        }
        assertThat(krRuns()).extracting(run -> run.detail().path("attempt").asInt()).containsExactly(1, 2, 3);

        failShortBond.set(false);
        assertThat(runAt("2026-11-30T23:00").message()).contains("출발 오류가 상한만큼");
        restart();   // 같은 창에서 재기동 — 오류 세 번은 저장된 기록이라 그대로
        PaperDecisionJob.Result rested = runAt("2026-11-30T23:10");
        assertThat(rested.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
        assertThat(rested.message()).contains("출발 오류가 상한만큼");
        assertThat(krDecisions()).isEmpty();
        assertNotStarted(store);

        assertThat(runAt("2026-12-01T01:10").outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns()).extracting(JobRun::outcome).containsExactly(PaperDecisionJob.ERROR, PaperDecisionJob.ERROR,
                PaperDecisionJob.ERROR, PaperDecisionJob.START_POSTPONED);
        sessionData(NEXT, S, everyCodeOn(NEXT));
        assertThat(runAt("2026-12-01T22:30").outcome()).as("다음 세션은 오류 횟수 0부터").isEqualTo(PaperDecisionJob.STARTED);
    }

    @Test
    @DisplayName("자료 게이트 — ⑤ 069500 S 봉 없음·② 범위 90% 미만·② 관측치 세션이 S가 아님·④ 금융위 기준일이 직전 거래일이 아님이면 기다림(쓰기 없음, 이어진 기다림은 기록 한 줄)")
    void waitsForSessionData() {
        Map<String, LocalDate> noAnchor = everyCodeOn(S);
        noAnchor.put("069500", PREV);
        sessionData(S, PREV, noAnchor);
        PaperDecisionJob.Result anchor = runAt("2026-11-30T22:30");
        assertThat(anchor.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
        assertThat(anchor.message()).contains("⑤").contains("069500").doesNotContain("②");

        Map<String, LocalDate> eight = everyCodeOn(S);
        eight.put("005930", PREV);
        eight.put("000660", null);
        sessionData(S, PREV, eight);
        assertThat(runAt("2026-11-30T22:40").message()).contains("②").contains("8/10");
        sessionData(PREV, PREV, everyCodeOn(PREV));
        assertThat(runAt("2026-11-30T22:50").message()).contains("②").contains("관측치 세션 2026-11-27");
        sessionData(S, LocalDate.of(2026, 11, 26), everyCodeOn(S));
        assertThat(runAt("2026-11-30T23:00").message()).contains("④").contains("2026-11-26");
        assertThat(krDecisions()).isEmpty();
        assertThat(krRuns()).as("기다림 넷은 한 줄(E0) — 마지막 판정").singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
            assertThat(run.detail().path("checks").asInt()).isEqualTo(4);
            assertThat(run.detail().path("reason").asString()).contains("④").contains("2026-11-26").doesNotContain("⑤");
            assertThat(gateStatuses(run.detail().path("gates"))).as("장부 전 게이트 넷").containsExactly("② PASS", "④ FAIL",
                    "⑤ PASS", "⑥ PASS");
        });
    }

    @Test
    @DisplayName("출발도 싼 게이트 ②④⑤⑥ 먼저 — 관측치 세션이 S가 아닌 주기(10분마다)에는 규칙 계좌 입력(U·20일 수급·DART)을 읽지 않고 기다림, 통과하면 그 주기에 한 번 읽음")
    void cheapGatesFirstAtStart() {
        sessionData(PREV, PREV, everyCodeOn(PREV));
        for (String at : List.of("2026-11-30T22:30", "2026-11-30T22:40")) {
            PaperDecisionJob.Result waiting = runAt(at);
            assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
            assertThat(waiting.message()).contains("②").contains("관측치 세션 2026-11-27");
        }
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.never()).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), any(LocalDate.class));
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.never()).latestObservationDateBefore(
                eq(Datasets.OBS_KR_PAPER_UNIVERSE), any(LocalDate.class));

        sessionData(S, PREV, everyCodeOn(S));
        assertThat(runAt("2026-11-30T22:50").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        org.mockito.Mockito.verify(repository, org.mockito.Mockito.times(1)).readObservationSeries(
                eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), any(LocalDate.class));
    }

    @Test
    @DisplayName("출발도 관측치 저장본을 시장 파서가 읽지 못하면(계약 판 2) ② 미달로 기다림 — 원문 머리·봉으로는 ②⑤가 통과해도 그 저장본으로 출발하지 않음(쓰기 없음, 기다림 한 줄)")
    void unreadableObservationWaitsAtStart() {
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES,
                KrFixtures.quotesPayload(S, everyCodeOn(S)).put("contract", 2), kst(S + "T21:57")));

        PaperDecisionJob.Result waiting = runAt("2026-11-30T22:30");

        assertThat(waiting.outcome()).isEqualTo(PaperDecisionJob.START_WAITING);
        assertThat(waiting.message()).contains("②").contains("계약 판 2").doesNotContain("⑤");
        assertThat(krDecisions()).isEmpty();
        assertThat(krRuns()).extracting(JobRun::outcome).containsExactly(PaperDecisionJob.START_WAITING);
    }

    @Test
    @DisplayName("게이트 ② 문턱 — 수집 범위 9/10(90%)에 S 봉이면 통과(문턱 포함)")
    void coverageAtNinetyPercentPasses() {
        Map<String, LocalDate> nine = everyCodeOn(S);
        nine.put("005930", PREV);
        sessionData(S, PREV, nine);

        assertThat(runAt("2026-11-30T22:30").outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(krDecisions().get(0).response().path("gates").get(0).path("note").asString()).contains("9/10");
    }

    @Test
    @DisplayName("기한 S+1 01:00 — 게이트가 끝까지 미달이면 미룸을 한 번 기록하고 다음 KR 거래일 22:30에 출발(바뀐 출발일 = 결정 행의 기준 거래일, postponed=true)")
    void postponesToTheNextTradingDay() {
        Map<String, LocalDate> noAnchor = everyCodeOn(S);
        noAnchor.put("069500", PREV);
        sessionData(S, PREV, noAnchor);
        assertThat(runAt("2026-11-30T23:50").outcome()).isEqualTo(PaperDecisionJob.START_WAITING);

        PaperDecisionJob.Result postponed = runAt("2026-12-01T01:00");
        assertThat(postponed.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(postponed.message()).contains("2026-12-01").contains("⑤");
        assertThat(runAt("2026-12-01T01:10").outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns()).extracting(JobRun::outcome).as("기다림 한 줄 + 미룸은 세션마다 한 번")
                .containsExactly(PaperDecisionJob.START_WAITING, PaperDecisionJob.START_POSTPONED);
        assertThat(krRuns().get(1)).satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
            assertThat(run.detail().path("tradingDate").asString()).isEqualTo("2026-11-30");
            assertThat(run.detail().path("postponedTo").asString()).isEqualTo("2026-12-01");
            assertThat(run.detail().path("reason").asString()).contains("⑤");
        });
        assertThat(krDecisions()).isEmpty();
        assertThat(runAt("2026-12-01T21:00").outcome()).as("다음 창 전").isEqualTo(PaperDecisionJob.TOO_EARLY);

        sessionData(NEXT, S, everyCodeOn(NEXT));
        PaperDecisionJob.Result started = runAt("2026-12-01T22:30");
        assertThat(started.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(started.tradingDate()).isEqualTo(NEXT);
        assertThat(krDecisions()).allSatisfy(d -> {
            assertThat(d.asOfTradingDate()).isEqualTo(NEXT);
            assertThat(d.response().path("postponed").asBoolean()).isTrue();
            assertThat(d.response().path("configuredStartDate").asString()).isEqualTo("2026-11-30");
        });
        assertThat(store.orders.values()).as("규칙 계좌 주문도").allSatisfy(o -> {
            assertThat(o.asOfTradingDate()).isEqualTo(NEXT);
            assertThat(o.expiresOn()).isEqualTo(LocalDate.of(2026, 12, 4));
        });
        assertThat(krDecisions().get(0).response().path("input").path("universe").path("baseDate").asString())
                .as("미룬 출발의 규칙 계좌 입력 = 그날(12-01) 자료").isEqualTo("2026-11-30");
        assertThat(store.books.get("kr_bench_k200").startedOn()).isEqualTo(NEXT);
        assertThat(krRuns()).extracting(JobRun::outcome).containsExactly(PaperDecisionJob.START_WAITING,
                PaperDecisionJob.START_POSTPONED, PaperDecisionJob.STARTED);
        assertThat(krRuns().get(2).detail().path("postponed").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("출발은 S+1 01:00 뒤에는 어떤 경우에도 내지 않음 — 그 밤 첫 실행이 01:05(게이트는 모두 통과)여도 미룸")
    void neverStartsAfterTheDeadline() {
        PaperDecisionJob.Result late = runAt("2026-12-01T01:05");

        assertThat(late.outcome()).isEqualTo(PaperDecisionJob.START_POSTPONED);
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(store.books.get("kr_bench_k200").status()).isEqualTo(PaperBooks.NOT_STARTED);
    }

    @Test
    @DisplayName("미룬 세션의 정기 실행 로그는 처음 한 번만 INFO — 기한 뒤 10분마다 나오는 같은 미룸은 DEBUG(작업 기록도 한 번)")
    void postponedSessionLogsOnce() {
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                .getLogger(PaperDecisionJob.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        ch.qos.logback.classic.Level saved = logger.getLevel();
        logger.setLevel(ch.qos.logback.classic.Level.DEBUG);
        try {
            for (String at : List.of("2026-12-01T01:05", "2026-12-01T01:15", "2026-12-01T01:25")) {
                clock.set(kst(at));
                job.scheduledRun();
            }

            assertThat(appender.list).filteredOn(e -> e.getFormattedMessage().contains("미룹니다"))
                    .extracting(ch.qos.logback.classic.spi.ILoggingEvent::getLevel).containsExactly(
                            ch.qos.logback.classic.Level.INFO, ch.qos.logback.classic.Level.DEBUG,
                            ch.qos.logback.classic.Level.DEBUG);
            assertThat(krRuns()).extracting(JobRun::outcome).containsExactly(PaperDecisionJob.START_POSTPONED);
        } finally {
            logger.detachAppender(appender);
            logger.setLevel(saved);
        }
    }

    @Test
    @DisplayName("계좌 몫 하나라도 계획 실패(E2의 Claude 실패 자리) — 어느 계좌에도 쓰지 않고 그 세션을 미룸으로 기록")
    void failedLegPostponesAllBooks() {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        KrStartPipeline plain = new KrStartPipeline(store, reader, marketData, ledger, config(), PaperFixtures.MAPPER);
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        KrStartPipeline.Leg claudeFails = new KrStartPipeline.Leg() {
            @Override
            public String book() {
                return PaperBooks.KR_CLAUDE;
            }

            @Override
            public KrStartPipeline.Plan plan(MarketRun run, LocalDate session, Instant deadline,
                                             KrDecisionGates.Checked gates) {
                calls.incrementAndGet();
                return KrStartPipeline.Plan.failed(PaperBooks.KR_CLAUDE, "시험용 호출 실패(재시도 1회 뒤)");
            }
        };
        KrStartPipeline pipeline = new KrStartPipeline(store, reader, marketData, ledger, config(), PaperFixtures.MAPPER, List.of(
                claudeFails, plain.benchmarkLeg(PaperBooks.KR_BENCH_K200), plain.benchmarkLeg(PaperBooks.KR_BENCH_MIX)));
        MarketRun run = new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE);

        KrStartPipeline.Result result = pipeline.run(run, kst("2026-11-30T22:30"));

        assertThat(result.outcome()).isEqualTo(KrStartPipeline.START_POSTPONED);
        assertThat(result.record()).isTrue();
        assertThat(result.detail().get("reason").toString()).contains("kr_claude").contains("시험용 호출 실패");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(store.books.get("kr_bench_k200").status()).isEqualTo(PaperBooks.NOT_STARTED);
        KrStartPipeline.Result unrecorded = pipeline.run(run, kst("2026-11-30T22:40"));
        assertThat(unrecorded.outcome()).as("그 세션은 다시 계획하지 않음(이 프로세스의 방어선 — 미룸 기록을 아직 쓰지 못함)")
                .isEqualTo(KrStartPipeline.START_POSTPONED);
        assertThat(unrecorded.record()).as("저장된 미룸 기록이 없으면 다음 주기에 다시 남김").isTrue();
        recordAsTheJob(unrecorded, kst("2026-11-30T22:40"));   // 결정 작업이 남기는 미룸 기록
        KrStartPipeline.Result again = pipeline.run(run, kst("2026-11-30T22:50"));
        assertThat(again.outcome()).isEqualTo(KrStartPipeline.START_POSTPONED);
        assertThat(again.record()).as("그 세션 미룸은 한 번 기록(저장된 기록이 판정)").isFalse();
        assertThat(calls.get()).as("계획(Claude 호출 자리)은 한 번").isEqualTo(1);
        assertThat(krDecisions()).isEmpty();
    }

    @Test
    @DisplayName("계획이 기한(S+1 01:00)을 넘겨 끝나면(E2의 긴 Claude 호출 자리) 쓰기 트랜잭션이 다시 보고 어느 계좌에도 쓰지 않음 — 계좌 몫은 그 기한을 받음, 그 세션은 미룸")
    void slowPlanPastTheDeadlineWritesNothing() {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        KrStartPipeline plain = new KrStartPipeline(store, reader, marketData, ledger, config(), PaperFixtures.MAPPER);
        List<Instant> deadlines = new java.util.ArrayList<>();
        KrStartPipeline.Leg slowClaude = new KrStartPipeline.Leg() {
            @Override
            public String book() {
                return PaperBooks.KR_CLAUDE;
            }

            @Override
            public KrStartPipeline.Plan plan(MarketRun run, LocalDate session, Instant deadline,
                                             KrDecisionGates.Checked gates) {
                deadlines.add(deadline);
                clock.set(kst("2026-12-01T01:02"));   // 호출이 기한을 넘겨 끝남
                return KrStartPipeline.Plan.notYet(PaperBooks.KR_CLAUDE, "시험용 — 계획은 냈지만 늦음");
            }
        };
        KrStartPipeline pipeline = new KrStartPipeline(store, reader, marketData, ledger, config(), PaperFixtures.MAPPER, clock,
                List.of(slowClaude, plain.benchmarkLeg(PaperBooks.KR_BENCH_K200), plain.benchmarkLeg(PaperBooks.KR_BENCH_MIX)));
        clock.set(kst("2026-11-30T22:30"));
        MarketRun run = new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE);

        KrStartPipeline.Result result = pipeline.run(run, kst("2026-11-30T22:30"));

        assertThat(deadlines).containsExactly(kst("2026-12-01T01:00"));
        assertThat(result.outcome()).isEqualTo(KrStartPipeline.START_POSTPONED);
        assertThat(result.record()).isTrue();
        assertThat(result.detail().get("reason").toString()).contains("기한을 넘겨 끝남").contains("2026-12-01 01:02");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(store.books.get("kr_bench_k200").status()).isEqualTo(PaperBooks.NOT_STARTED);
        assertThat(store.navSeries("kr_bench_k200")).isEmpty();
    }

    @Test
    @DisplayName("출발 뒤 S+1 밤 관측치(계약 1, C2b) — 벤치마크 두 계좌가 S+1 시가(1분봉 09:01)에 체결: 069500 100% · 069500 60% → 153130 40%(현금성 마지막), 비용 칸, 그날 잠정 순자산 = 현금 + 수량 × 토스 종가")
    void benchmarksFillAtTheNextOpen() {
        store.dbNow = kst("2026-11-30T22:30");   // 주문 생성 = 출발 트랜잭션 시각
        runAt("2026-11-30T22:30");
        KrFixtures.Payload payload = new KrFixtures.Payload(NEXT);
        payload.etf("069500", kst("2026-12-01T21:57")).bar(S, 94_000.0, 94_500.0, 30_000_000)
                .bar(NEXT, 95_300.0, 95_400.0, 31_000_000).minute("OK", "09:01", 95_000.0, 380_000, "10:01", 95_100.0, 9_000);
        payload.etf("153130", kst("2026-12-01T21:57")).bar(S, 107_990.0, 108_000.0, 40_000)
                .bar(NEXT, 108_010.0, 108_020.0, 41_000).minute("OK", "09:01", 108_000.0, 2_000);
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, payload.snapshot(kst("2026-12-01T22:01")));
        MarketRun run = new PaperMarkets(store, reader, List.of(KrPaperMarket.INSTANCE)).open(KrPaperMarket.INSTANCE);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);

        PaperLedgerService.Outcome outcome = ledger.process(run, marketData.quotes(run).orElseThrow());

        assertThat(outcome.errors()).isEmpty();
        assertThat(outcome.booksProcessed()).contains("kr_bench_k200", "kr_bench_mix");
        assertThat(store.orders.values()).filteredOn(o -> o.bookCode().startsWith("kr_bench"))
                .allSatisfy(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED));
        // 069500 100%: 1억 안에서 비용 포함 → 1,051주(금액 99,845,000 · 수수료 14,976 · 슬리피지 49,922), 현금 90,102.
        assertThat(store.fillsOf("kr_bench_k200")).singleElement().satisfies(f -> {
            assertThat(f.qty()).isEqualTo(1_051);
            assertThat(f.price()).isEqualTo(95_000);
            assertThat(f.priceSource()).isEqualTo("TOSS_1M_OPEN");
            assertThat(f.observationDate()).isEqualTo(NEXT);
            assertThat(f.fee()).isEqualByComparingTo("14976");
            assertThat(f.slippageCost()).isEqualByComparingTo("49922");
        });
        assertThat(store.states.get("kr_bench_k200").cash()).isEqualTo(90_102);
        // 60/40: 069500 6천만 원 안 631주(현금 40,016,037) → 153130은 그 뒤 순자산(평가 = 체결가) 99,961,037의 40% 안 369주.
        assertThat(store.fillsOf("kr_bench_mix")).extracting(f -> f.ticker() + " " + f.qty())
                .containsExactly("069500 631", "153130 369");
        assertThat(store.states.get("kr_bench_mix").cash()).isEqualTo(138_134);
        assertThat(store.navSeries("kr_bench_k200")).extracting(NavRow::tradingDate).containsExactly(S, NEXT);
        NavRow next = store.navSeries("kr_bench_k200").get(1);
        assertThat(next.nav()).as("현금 + 1,051주 × 95,400").isEqualTo(90_102 + 1_051 * 95_400.0);
        assertThat(next.pricesFinal()).as("토스 잠정가 — 금융위 확정은 C3").isFalse();
        assertThat(next.nav() / 100_000_000 - 1).as("출발가 대비 ETF 가격 변화(+0.42%)와 비용 오차 이내")
                .isCloseTo(95_400.0 / 95_000 - 1, org.assertj.core.data.Offset.offset(0.001));
    }

    @Test
    @DisplayName("출발 판정 — 한국 계좌가 모두 시작 전일 때만(한 계좌라도 운용·일시정지면 출발한 장부), 미국 묶음은 늘 아님")
    void pendingOnlyWhileEveryKoreanBookIsNotStarted() {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        KrStartPipeline pipeline = new KrStartPipeline(store, reader, marketData, ledger, config(), PaperFixtures.MAPPER);
        assertThat(pipeline.pending(KrPaperMarket.INSTANCE)).isTrue();
        assertThat(pipeline.pending(UsPaperMarket.INSTANCE)).isFalse();
        assertThat(pipeline.pending(TestKrMarket.INSTANCE)).as("한국 묶음 그 자체일 때만").isFalse();
        store.updateBookStatus(PaperBooks.KR_BENCH_MIX, PaperBooks.PAUSED);
        assertThat(pipeline.pending(KrPaperMarket.INSTANCE)).isFalse();
        store.books.clear();
        assertThat(pipeline.pending(KrPaperMarket.INSTANCE)).as("계좌 없음").isFalse();
    }
}
