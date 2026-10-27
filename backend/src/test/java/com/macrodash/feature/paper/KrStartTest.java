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
import static org.mockito.Mockito.mock;

/**
 * 한국 출발(2단계 명세 §4-8·K28, 결정 d13 — C1c): S 22:30 결정 작업이 벤치마크 두 계좌의 출발 결정·{@code NEXT_OPEN} 주문을 한 트랜잭션으로
 * 쓰고(규칙 D1·Claude E2는 갈고리), 자료 게이트(§4-9 ②④⑤⑥) 미달이면 기다리며, 기한 S+1 01:00이 지나면 내지 않고 다음 KR 거래일로 미룬다.
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
                if (failShortBond.get() && PaperBooks.KR_SHORT_BOND.equals(o.ticker())) {
                    throw new IllegalStateException("시험용 주문 실패");
                }
                return super.insertOrder(o);
            }
        };
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = new PaperMarketData(reader, mock(com.macrodash.store.StoreRepository.class));
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

    /** 수집 범위 열 종목(ETF 둘 + 주식 여덟) 모두 마지막 봉이 그날. */
    private static Map<String, LocalDate> everyCodeOn(LocalDate day) {
        Map<String, LocalDate> out = new LinkedHashMap<>();
        for (String code : List.of("069500", "153130", "005930", "000660", "373220", "207940", "005380", "000270",
                "068270", "035420")) {
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

    private List<Decision> krDecisions() {
        return store.decisions.values().stream().filter(d -> d.bookCode().startsWith("kr_")).toList();
    }

    @Test
    @DisplayName("S 22:30 — 벤치마크 두 계좌의 INITIAL 결정·NEXT_OPEN 주문(기준 거래일 S, 만료 S+3거래일)·운용 전환·S 순자산 1억(확정), 규칙·Claude는 시작 전(D1·E2 갈고리)")
    void startsBothBenchmarksAtS2230() {
        PaperDecisionJob.Result result = runAt("2026-11-30T22:30");

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(result.tradingDate()).isEqualTo(S);
        assertThat(krDecisions()).extracting(Decision::bookCode).containsExactly("kr_bench_k200", "kr_bench_mix");
        for (Decision d : krDecisions()) {
            assertThat(d.kind()).isEqualTo(RuleBookService.INITIAL);
            assertThat(d.status()).isEqualTo("OK");
            assertThat(d.asOfTradingDate()).isEqualTo(S);
            assertThat(d.settingsVersion()).as("그 실행이 읽은 판").isEqualTo(store.settings.version());
            assertThat(d.targetExposurePct()).isEqualTo(100.0);
            assertThat(d.pricesFinal()).as("금융위 확정 전").isFalse();
            assertThat(d.model()).isNull();
            assertThat(d.response().path("timing").asString()).isEqualTo("NEXT_OPEN");
            assertThat(d.response().path("configuredStartDate").asString()).isEqualTo("2026-11-30");
            assertThat(d.response().path("postponed").asBoolean()).isFalse();
            assertThat(d.response().path("gates").size()).isEqualTo(5);
        }
        List<Order> orders = store.orders.values().stream().toList();
        assertThat(orders).extracting(Order::bookCode, Order::ticker, Order::targetWeightPct).containsExactly(
                org.assertj.core.groups.Tuple.tuple("kr_bench_k200", "069500", 100.0),
                org.assertj.core.groups.Tuple.tuple("kr_bench_mix", "069500", 60.0),
                org.assertj.core.groups.Tuple.tuple("kr_bench_mix", "153130", 40.0));
        assertThat(orders).allSatisfy(o -> {
            assertThat(o.side()).isEqualTo("BUY");
            assertThat(o.timing()).isEqualTo("NEXT_OPEN");
            assertThat(o.source()).isEqualTo("BENCHMARK");
            assertThat(o.status()).isEqualTo("PENDING");
            assertThat(o.asOfTradingDate()).isEqualTo(S);
            assertThat(o.expiresOn()).as("S + 3거래일").isEqualTo(LocalDate.of(2026, 12, 3));
            assertThat(o.qty()).as("수량은 시가 체결 때").isNull();
            assertThat(o.decisionId()).isNotNull();
        });
        for (String bench : List.of("kr_bench_k200", "kr_bench_mix")) {
            Book book = store.books.get(bench);
            assertThat(book.status()).isEqualTo(PaperBooks.ACTIVE);
            assertThat(book.startedOn()).isEqualTo(S);
            assertThat(store.navSeries(bench)).singleElement().satisfies(row -> {
                assertThat(row.tradingDate()).isEqualTo(S);
                assertThat(row.nav()).isEqualTo(100_000_000);
                assertThat(row.cash()).isEqualTo(100_000_000);
                assertThat(row.pricesFinal()).isTrue();
            });
            assertThat(store.states.get(bench).lastNavTradingDate()).isEqualTo(S);
        }
        for (String hook : List.of("kr_rules", "kr_claude")) {
            assertThat(store.books.get(hook).status()).isEqualTo(PaperBooks.NOT_STARTED);
            assertThat(store.navSeries(hook)).isEmpty();
        }
        assertThat(store.fills).as("사후 체결 없음(K28)").isEmpty();

        assertThat(krRuns()).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo(PaperDecisionJob.STARTED);
            JsonNode detail = run.detail();
            assertThat(detail.path("start").asBoolean()).isTrue();
            assertThat(detail.path("tradingDate").asString()).isEqualTo("2026-11-30");
            assertThat(detail.path("deadlineKst").asString()).contains("2026-12-01 01:00");
            assertThat(detail.path("books").path("kr_rules").asString()).contains("D1");
            assertThat(detail.path("books").path("kr_claude").asString()).contains("E2");
            assertThat(detail.path("books").path("kr_bench_mix").path("orders").size()).isEqualTo(2);
            assertThat(detail.path("gates").toString()).contains("\"③\"", "STUB");
        });

        // 같은 밤 다음 주기 — 출발한 장부라 다시 내지 않음(정기 결정 쪽은 한국 Claude 계좌가 시작 전이라 할 일 없음).
        PaperDecisionJob.Result again = runAt("2026-11-30T22:40");
        assertThat(again.outcome()).isEqualTo(PaperDecisionJob.ALREADY_DECIDED);
        assertThat(krDecisions()).hasSize(2);
        assertThat(store.orders).hasSize(3);
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
    @DisplayName("한 트랜잭션 — 두 번째 계좌의 주문을 넣다 실패하면 두 계좌의 결정·주문·운용 전환·순자산 줄 모두 되돌리고 ERROR 기록, 다음 주기에 출발")
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
        assertThat(store.orders).hasSize(3);
    }

    @Test
    @DisplayName("자료 게이트 — ⑤ 069500 S 봉 없음·② 범위 90% 미만·② 관측치 세션이 S가 아님·④ 금융위 기준일이 직전 거래일이 아님이면 기다림(기록·쓰기 없음)")
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
        assertThat(krRuns()).as("기다림은 기록하지 않음").isEmpty();
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
        assertThat(krRuns()).as("세션마다 한 번").singleElement().satisfies(run -> {
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
        assertThat(store.orders.values()).allSatisfy(o -> {
            assertThat(o.asOfTradingDate()).isEqualTo(NEXT);
            assertThat(o.expiresOn()).isEqualTo(LocalDate.of(2026, 12, 4));
        });
        assertThat(store.books.get("kr_bench_k200").startedOn()).isEqualTo(NEXT);
        assertThat(krRuns()).extracting(JobRun::outcome)
                .containsExactly(PaperDecisionJob.START_POSTPONED, PaperDecisionJob.STARTED);
        assertThat(krRuns().get(1).detail().path("postponed").asBoolean()).isTrue();
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
    @DisplayName("계좌 몫 하나라도 계획 실패(E2의 Claude 실패 자리) — 어느 계좌에도 쓰지 않고 그 세션을 미룸으로 기록")
    void failedLegPostponesAllBooks() {
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        KrStartPipeline plain = new KrStartPipeline(store, reader, ledger, config(), PaperFixtures.MAPPER);
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        KrStartPipeline.Leg claudeFails = new KrStartPipeline.Leg() {
            @Override
            public String book() {
                return PaperBooks.KR_CLAUDE;
            }

            @Override
            public KrStartPipeline.Plan plan(MarketRun run, LocalDate session, List<KrStartPipeline.Gate> gates) {
                calls.incrementAndGet();
                return KrStartPipeline.Plan.failed(PaperBooks.KR_CLAUDE, "시험용 호출 실패(재시도 1회 뒤)");
            }
        };
        KrStartPipeline pipeline = new KrStartPipeline(store, reader, ledger, config(), PaperFixtures.MAPPER, List.of(
                claudeFails, plain.benchmarkLeg(PaperBooks.KR_BENCH_K200), plain.benchmarkLeg(PaperBooks.KR_BENCH_MIX)));
        MarketRun run = new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE);

        KrStartPipeline.Result result = pipeline.run(run, kst("2026-11-30T22:30"), false);

        assertThat(result.outcome()).isEqualTo(KrStartPipeline.START_POSTPONED);
        assertThat(result.record()).isTrue();
        assertThat(result.detail().get("reason").toString()).contains("kr_claude").contains("시험용 호출 실패");
        assertThat(krDecisions()).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(store.books.get("kr_bench_k200").status()).isEqualTo(PaperBooks.NOT_STARTED);
        KrStartPipeline.Result again = pipeline.run(run, kst("2026-11-30T22:40"), false);
        assertThat(again.outcome()).as("그 세션은 다시 계획하지 않음").isEqualTo(KrStartPipeline.START_POSTPONED);
        assertThat(again.record()).as("그 세션 미룸은 한 번 기록").isFalse();
        assertThat(calls.get()).as("계획(Claude 호출 자리)은 한 번").isEqualTo(1);
        assertThat(krDecisions()).isEmpty();
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
        assertThat(store.orders.values()).allSatisfy(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_FILLED));
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
        KrStartPipeline pipeline = new KrStartPipeline(store, reader, ledger, config(), PaperFixtures.MAPPER);
        assertThat(pipeline.pending(KrPaperMarket.INSTANCE)).isTrue();
        assertThat(pipeline.pending(UsPaperMarket.INSTANCE)).isFalse();
        assertThat(pipeline.pending(TestKrMarket.INSTANCE)).as("한국 묶음 그 자체일 때만").isFalse();
        store.updateBookStatus(PaperBooks.KR_BENCH_MIX, PaperBooks.PAUSED);
        assertThat(pipeline.pending(KrPaperMarket.INSTANCE)).isFalse();
        store.books.clear();
        assertThat(pipeline.pending(KrPaperMarket.INSTANCE)).as("계좌 없음").isFalse();
        assertThat(NavRow.class).isNotNull();
    }
}
