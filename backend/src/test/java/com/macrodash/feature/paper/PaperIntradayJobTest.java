package com.macrodash.feature.paper;

import com.macrodash.feature.ai.AiService;
import com.macrodash.feature.paper.PaperCheckpointJobTest.MovableClock;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Checkpoint;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.TransientDataAccessResourceException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 미국 장중 판단 작업({@link PaperIntradayJob} — 자유 시점 판, ADR 0027 결정 3·4) — FakePaperStore·가짜 AiService(Mockito — 실제 API·네트워크 없음)·움직이는
 * 시계. 끈 판 장중 확인 작업({@link PaperCheckpointJobTest})과 같은 규칙은 대표 경우만 보고, 다른 것(계좌·순번마다 한 행, 종류 INTRADAY_n, 판·문턱,
 * 응답 시점 셋, 다음 판단 예약, 저장본 신원 목록)을 봅니다.
 *
 * <p>기본 시각: 결정 d = 2026-10-30(금), E = 11-02(월, EST 첫 거래일), 계좌1({@code claude})의 첫 판단 10:00 ET = 15:00Z, MINUTE·감시 [AAA].
 */
class PaperIntradayJobTest {

    private static final LocalDate D = LocalDate.of(2026, 10, 30);
    private static final LocalDate E = LocalDate.of(2026, 11, 2);
    private static final Instant T = Instant.parse("2026-11-02T15:00:00Z");
    private static final LocalTime TEN = LocalTime.of(10, 0);

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PacketBuilder packets;
    private AiService ai;
    private PaperLedgerService ledger;
    private PaperSettingsService settings;
    private MovableClock clock;
    private final List<String[]> sent = new ArrayList<>();
    private AiService.StructuredResult answer;
    /** 심는 쓰기 실패(DB 순간 장애) — 남은 횟수만큼 계획 행 DONE 표시가 실패합니다. */
    private int failDone;
    private long morning1;
    private long morning2;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore() {
            @Override
            public int markIntradayPlan(String code, LocalDate session, int slot, String fromStatus, String status, String reason,
                                        Long intradayDecisionId, Integer lagSeconds, Instant calledAt) {
                if (PaperBooks.CHECKPOINT_DONE.equals(status) && failDone > 0) {
                    failDone--;
                    throw new TransientDataAccessResourceException("시험: DONE 쓰기 중 DB 순간 장애");
                }
                return super.markIntradayPlan(code, session, slot, fromStatus, status, reason, intradayDecisionId, lagSeconds, calledAt);
            }
        };
        clock = new MovableClock(T.plus(Duration.ofMinutes(3)));
        store.dbNow = clock.now;
        reader = PaperFixtures.quietReader();
        marketData = mock(PaperMarketData.class);
        packets = mock(PacketBuilder.class);
        when(packets.macroSection(any(), any())).thenReturn(MAPPER.readTree("{\"cards\":[]}"));
        ai = mock(AiService.class);
        answer = ok(reply("KEEP", null));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenAnswer(invocation -> {
            sent.add(new String[]{invocation.getArgument(1), invocation.getArgument(2),
                    MAPPER.writeValueAsString(invocation.getArgument(3)), invocation.getArgument(4)});
            return answer;
        });
        settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        group("claude").put("freeTiming", true);
        group("claude2").put("enabled", true).put("freeTiming", true).put("maxCallsPerCycle", 4);
        ledger = new PaperLedgerService(store, marketData, MAPPER);
        book(PaperBooks.CLAUDE);
        book(PaperBooks.CLAUDE2);
        morning1 = morning(PaperBooks.CLAUDE);
        morning2 = morning(PaperBooks.CLAUDE2);
        plan(PaperBooks.CLAUDE, 1, TEN, "MINUTE", List.of("AAA"), morning1, false);
        when(marketData.watchUs()).thenReturn(Optional.of(watch(T.plusSeconds(90), identity(PaperBooks.CLAUDE, TEN, 1))));
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.minusSeconds(600), bar("SPY", E, 580.0), bar("AAA", E, 50.0),
                bar("BBB", E, 20.0), bar("CCC", E, 10.0), bar("DDD", E, 30.0), bar("EEE", E, 40.0), bar("FFF", E, 25.0))));
    }

    private static AiService.StructuredResult ok(String json) {
        return new AiService.StructuredResult(true, json, "end_turn", null, null, true, 9_000L, 400L, 0L, 0L, 1_200L);
    }

    private ObjectNode group(String name) {
        return (ObjectNode) store.settings.body().get(name);
    }

    private void book(String code) {
        store.books.put(code, new Book(code, PaperBooks.KIND_CLAUDE, code, 100_000, D, PaperBooks.ACTIVE, T.minusSeconds(86_400 * 10L)));
        store.states.put(code, new BookState(code, 100_000, 100_000, 0, 0, null, null, D, null));
    }

    /** 그 세션의 결정 행(모델 있음 — 결정 주기 호출 1회). */
    private long morning(String code) {
        return store.insertDecisionIfAbsent(new Decision(0, code, D, RuleBookService.SCHEDULED, null, "OK", "claude-sonnet-5-5", 0,
                1, null, 20.0, null, null, null, null, null, null, List.of(), true, 1L, 0,
                "{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\"}}")).orElseThrow();
    }

    private void plan(String code, int slot, LocalTime at, String feed, List<String> watch, long source, boolean manual) {
        store.upsertPlannedIntradayPlan(IntradayPlan.planned(code, E, slot, at, feed, watch, "갭 뒤 거래량", "ft-1", manual, source, null));
    }

    private IntradayPlan row(String code, int slot) {
        return store.intradayPlans(code, E).stream().filter(p -> p.slot() == slot).findFirst().orElseThrow();
    }

    private static ObjectNode identity(String code, LocalTime at, Integer slot) {
        ObjectNode item = MAPPER.createObjectNode();
        item.put("book", code).put("sessionDate", E.toString()).put("atEt", CheckpointPacket.clock(at));
        if (slot == null) {
            item.putNull("slot");
        } else {
            item.put("slot", slot);
        }
        return item;
    }

    /** 감시 저장본 — 신원 목록({@code checkpoints})과 SPY·AAA·ZZZ의 E 세션 봉 하나씩(ZZZ는 다른 계좌 계획의 종목). */
    private static Snapshot watch(Instant collectedAt, ObjectNode... identities) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("contract", 1);
        payload.set("checkpoint", identities[0].deepCopy().without("slot"));
        ArrayNode list = payload.putArray("checkpoints");
        for (ObjectNode item : identities) {
            list.add(item);
        }
        payload.put("lagSeconds", 75);
        ObjectNode tickers = payload.putObject("tickers");
        for (String ticker : List.of("SPY", "AAA", "ZZZ")) {
            ObjectNode entry = tickers.putObject(ticker);
            entry.put("fetchedAt", collectedAt.toString()).put("session", E.toString());
            entry.putArray("bars").addObject().put("t", collectedAt.minusSeconds(120).toString()).put("o", 50).put("h", 51).put("l", 49)
                    .put("c", 50.5).put("v", 1_000);
            entry.putObject("day").put("open", 49).put("high", 52).put("low", 48);
        }
        return new Snapshot(Datasets.SNAP_PAPER_WATCH_US, payload, "snapshot", "OK", null, collectedAt);
    }

    private ClaudeBookService service() {
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        PaperAdminService admin = new PaperAdminService(store, marketData, reader, settings, ledger, PaperFixtures.config(),
                MAPPER, clock);
        return new ClaudeBookService(store, reader, marketData, mock(PaperSelectionService.class), ledger, admin, packets,
                new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock), calls, ai, settings,
                PaperFixtures.config(), MAPPER, 30, clock);
    }

    private PaperIntradayJob job(boolean enabled) {
        return new PaperIntradayJob(store, reader, marketData, packets, service(), ledger,
                new PaperConfig(enabled, PaperFixtures.FRI, 100_000), MAPPER, clock);
    }

    private PaperIntradayJob.Outcome runAt(PaperIntradayJob job, Instant at) {
        clock.now = at;
        store.dbNow = at;
        return job.run();
    }

    /** 장중 판단 응답 — {@code next}는 nextCheckpoint 글자(null이면 null). */
    private static String reply(String action, String next, String... orders) {
        return "{\"schemaVersion\":2,\"action\":\"" + action + "\",\"summary\":\"장중 판단\",\"orders\":[" + String.join(",", orders)
                + "],\"noTradeReason\":" + (orders.length == 0 ? "\"관망\"" : "null") + ",\"nextCheckpoint\":" + next + "}";
    }

    private static String order(String ticker, String side, Double weight, Double fraction, String timing, String atLocal) {
        return "{\"ticker\":\"" + ticker + "\",\"side\":\"" + side + "\",\"targetWeightPct\":" + weight + ",\"sellFraction\":" + fraction
                + ",\"timing\":\"" + timing + "\",\"atLocal\":" + (atLocal == null ? "null" : "\"" + atLocal + "\"")
                + ",\"executionNote\":\"" + timing + " — 장중 판단\",\"thesis\":\"" + ticker + " 논거\",\"labels\":[\"사실\"],"
                + "\"invalidation\":\"갭 하락\"}";
    }

    private static String next(String at, String feed, String watch) {
        return "{\"at\":\"" + at + "\",\"feed\":\"" + feed + "\",\"watch\":" + watch + ",\"question\":\"오후 확인\"}";
    }

    /** 그 세션의 결정이 낸 대기 주문 — 목표 세션 E 하루짜리, 만든 시각 = d 저녁. */
    private long pending(String code, String ticker, String timing, LocalTime at) {
        long source = store.decisionFor(code, D, RuleBookService.SCHEDULED).orElseThrow().id();
        return store.insertOrder(new Order(0, code, source, ticker, PaperBooks.BUY, null, 5.0, null, timing, "CLAUDE",
                PaperBooks.ORDER_PENDING, null, null, D, Instant.parse("2026-10-30T22:31:00Z"), E, null, at));
    }

    private Decision decision(String code, int slot) {
        return store.decisionFor(code, D, RuleBookService.intradayKind(slot)).orElseThrow();
    }

    private JsonNode verdict(Decision d, String ticker) {
        for (JsonNode row : d.response().path("validation")) {
            if (ticker.equals(row.path("ticker").asString())) {
                return row;
            }
        }
        throw new AssertionError("검증 줄 없음: " + ticker);
    }

    // ------------------------------------------------------------------ 꺼짐·멈춤
    @Test
    @DisplayName("dashboard.paper.enabled=false면 정기 실행은 아무것도 읽거나 쓰지 않음")
    void disabledDoesNothing() {
        job(false).scheduledRun();
        verifyNoInteractions(marketData, ai, packets);
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("멈춤: 세션당 횟수 설정이 0이면(또는 계좌2의 claude2.enabled가 꺼져 있으면) 부르지 않고 창이 끝난 뒤 SKIPPED INTRADAY_OFF — 스위치(freeTiming)를 "
            + "꺼도 그 세션의 남은 판단은 그 판으로 부름")
    void zeroLimitStopsTheJobButTheSwitchDoesNot() {
        plan(PaperBooks.CLAUDE2, 1, TEN, "HOURLY", List.of(), morning2, false);
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 0);
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(5)));
        assertThat(sent).isEmpty();
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
        runAt(job, T.plus(Duration.ofMinutes(21)));
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        assertThat(row(PaperBooks.CLAUDE, 1).reason()).isEqualTo(PaperIntradayJob.INTRADAY_OFF);
        assertThat(row(PaperBooks.CLAUDE2, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());

        // 횟수는 그대로 두고 스위치만 끔 — 결정이 쓴 판으로 부름(대기 주문이 그 판의 것). 계좌2는 claude2.enabled가 꺼져 있어 부르지 않음.
        store.intradayPlans.clear();
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 2);
        group("claude").put("freeTiming", false);
        group("claude2").put("enabled", false);
        plan(PaperBooks.CLAUDE, 1, TEN, "HOURLY", List.of(), morning1, false);
        plan(PaperBooks.CLAUDE2, 1, TEN, "HOURLY", List.of(), morning2, false);
        runAt(job, T.plus(Duration.ofMinutes(5)));
        assertThat(sent).hasSize(1);
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(row(PaperBooks.CLAUDE2, 1).status()).as("창 안 — 아직 그대로").isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
    }

    // ------------------------------------------------------------------ 창·한 번·판
    @Test
    @DisplayName("계좌1의 첫 판단: +2분 전에는 안 부르고 창 안에서 한 번 — 자유 시점 판 시스템 프롬프트(장중 판단 절, 투자 성향 절 없음)·장중 판단 스키마"
            + "(시점 셋·atLocal·nextCheckpoint)·패킷(계좌·순번·종류 INTRADAY_1), 결정 행 INTRADAY_1(기준 거래일 d)·계획 행 DONE(결정·지연·부른 시각), "
            + "다음 주기에 다시 부르지 않음. 패킷의 MINUTE 피드는 이 계획의 종목만(다른 계좌 계획의 ZZZ는 빠짐)")
    void callsOnceInTheWindowWithTheFreeTimingVariant() {
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofSeconds(119)));
        assertThat(sent).isEmpty();

        Instant called = T.plus(Duration.ofMinutes(2));
        PaperIntradayJob.Outcome outcome = runAt(job, called);

        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)[0]).contains("## 장중 판단(고정)").contains(ClaudePrompts.CLAUDE2_PRIORITY).contains("AT_MINUTE")
                .doesNotContain("## 장중 확인(고정)").doesNotContain("## 투자 성향").doesNotContain("AT_1000");
        JsonNode packet = MAPPER.readTree(sent.get(0)[1]);
        JsonNode basis = packet.get("1_basis");
        assertThat(basis.get("book").asString()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(basis.get("variant").asString()).isEqualTo(PacketBuilder.VARIANT_FREE);
        assertThat(basis.get("fixedRules").asString()).isEqualTo(PacketBuilder.FREE_FIXED_RULES_VERSION);
        assertThat(basis.get("decisionKind").asString()).isEqualTo("INTRADAY_1");
        assertThat(basis.get("slot").asInt()).isEqualTo(1);
        assertThat(basis.get("maxPerSession").asInt()).isEqualTo(2);
        assertThat(basis.get("manual").asBoolean()).isFalse();
        assertThat(basis.get("origin").asString()).as("결정의 예약").isEqualTo("RESERVED");
        assertThat(basis.get("remainingJudgments").asInt()).as("세션당 2 − 순번 1").isEqualTo(1);
        assertThat(basis.get("nextCheckpoint").get("replaces").isNull()).as("다음 순번의 남은 예약 없음").isTrue();
        assertThat(packet.get("3_request").get("trigger").isNull()).isTrue();
        assertThat(basis.get("asOfInstant").asString()).isEqualTo(called.toString());
        assertThat(basis.get("remainingTimings").toString()).isEqualTo("[\"MARKET\",\"AT_MINUTE\",\"NEXT_CLOSE\"]");
        assertThat(basis.get("atMinute").get("firstEt").asString()).as("10:02 + 60초 뒤의 다음 분").isEqualTo("10:04");
        assertThat(basis.get("atMinute").get("lastEt").asString()).isEqualTo("15:54");
        JsonNode nextOptions = basis.get("nextCheckpoint");
        assertThat(nextOptions.get("available").asBoolean()).isTrue();
        assertThat(nextOptions.get("firstEt").asString()).as("이 판단 시각 10:00 + 20분").isEqualTo("10:20");
        assertThat(nextOptions.get("lastEt").asString()).isEqualTo("15:30");
        assertThat(packet.get("4_portfolio").get("book").asString()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(packet.get("5_feed").get("status").asString()).isEqualTo("OK");
        assertThat(packet.get("5_feed").get("tickers").propertyNames()).as("이 계획의 감시·기준 종목만").containsExactlyInAnyOrder("SPY", "AAA");
        assertThat(packet.get("0_instructions").get("lines").toString()).contains("장중 판단이다").contains("nextCheckpoint");
        assertThat(packet.get("6_hardRules").get("lines").toString()).contains("MARKET·AT_MINUTE·NEXT_CLOSE").doesNotContain("AT_1000");
        assertThat(sent.get(0)[2]).contains("\"nextCheckpoint\"").contains("AT_MINUTE").contains("atLocal").contains("KEEP")
                .doesNotContain("AT_1000").doesNotContain("stance");

        Decision d = decision(PaperBooks.CLAUDE, 1);
        assertThat(d.asOfTradingDate()).isEqualTo(D);
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(d.response().path("action").asString()).isEqualTo("KEEP");
        assertThat(d.response().path("checkpoint").path("slot").asInt()).isEqualTo(1);
        assertThat(d.response().path("checkpoint").path("sourceDecisionId").asLong()).isEqualTo(morning1);
        assertThat(d.response().path("checkpoint").path("lagSeconds").asInt()).isEqualTo(75);
        assertThat(d.response().has("intradayPlan")).as("nextCheckpoint가 null — 남은 예약 그대로").isFalse();
        IntradayPlan done = row(PaperBooks.CLAUDE, 1);
        assertThat(done.status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(done.intradayDecisionId()).isEqualTo(d.id());
        assertThat(done.lagSeconds()).isEqualTo(75);
        assertThat(done.calledAt()).isEqualTo(called);
        assertThat(outcome.changes()).containsEntry("claude 2026-11-02 #1", "DONE 결정 #" + d.id());
        assertThat(store.jobRuns).hasSize(1);
        assertThat(store.checkpoints).as("끈 판의 장중 확인 표는 건드리지 않음").isEmpty();

        runAt(job, called.plusSeconds(60));
        assertThat(sent).as("순번마다 한 번").hasSize(1);
    }

    @Test
    @DisplayName("호출 이유(ADR 0031): 사건이 당긴 행(출처 EVENT·사건)은 패킷 1_basis.origin·3_request.trigger(원래 시각·사건)로, 다음 순번의 남은 예약은 "
            + "nextCheckpoint.replaces로 실림 — 결정 응답 checkpoint 칸에도 출처·사건이 남음")
    void packetCarriesTheCallReason() {
        store.intradayPlans.clear();
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 3);
        ObjectNode trigger = MAPPER.createObjectNode().put("originalAt", "13:30");
        trigger.putArray("events").addObject().put("type", "INDEX_MOVE").put("ticker", "SPY").put("direction", "DOWN")
                .put("changePct", -1.62);
        store.upsertPlannedIntradayPlan(IntradayPlan.planned(PaperBooks.CLAUDE, E, 1, TEN, "HOURLY", List.of(), "오후 확인", "ft-2", false,
                morning1, null, IntradayPlan.ORIGIN_EVENT, trigger));
        plan(PaperBooks.CLAUDE, 2, LocalTime.of(14, 0), "HOURLY", List.of(), morning1, false);

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        assertThat(sent).hasSize(1);
        JsonNode packet = MAPPER.readTree(sent.get(0)[1]);
        JsonNode basis = packet.get("1_basis");
        assertThat(basis.get("origin").asString()).isEqualTo("EVENT");
        assertThat(basis.get("remainingJudgments").asInt()).isEqualTo(2);
        assertThat(basis.get("nextCheckpoint").get("replaces").toString()).isEqualTo("{\"atEt\":\"14:00\",\"origin\":\"RESERVED\"}");
        JsonNode sentTrigger = packet.get("3_request").get("trigger");
        assertThat(sentTrigger.get("originalAtEt").asString()).isEqualTo("13:30");
        assertThat(sentTrigger.get("events").get(0).get("ticker").asString()).isEqualTo("SPY");
        assertThat(packet.get("3_request").get("note").asString()).startsWith("코드 사건 규칙");
        Decision d = decision(PaperBooks.CLAUDE, 1);
        assertThat(d.response().path("checkpoint").path("origin").asString()).isEqualTo("EVENT");
        assertThat(d.response().path("checkpoint").path("trigger")).isEqualTo(trigger);
    }

    @Test
    @DisplayName("계좌2는 투자 성향 절이 있는 같은 판으로 부르고, 결정 주기 소상한(결정·재시도·장중 판단 합)을 봄 — 소상한 2에서 결정 1 + 첫 판단 1 뒤 둘째 판단은 "
            + "EXPIRED CYCLE_CAP. 계좌1은 소상한이 없어 둘째 판단도 부름")
    void claude2CountsTheCycleCapAndBook1DoesNot() {
        store.intradayPlans.clear();
        group("claude2").put("maxCallsPerCycle", 2);
        LocalTime eleven = LocalTime.of(11, 0);
        for (String code : List.of(PaperBooks.CLAUDE, PaperBooks.CLAUDE2)) {
            long source = PaperBooks.CLAUDE.equals(code) ? morning1 : morning2;
            plan(code, 1, TEN, "HOURLY", List.of(), source, false);
            plan(code, 2, eleven, "HOURLY", List.of(), source, false);
        }
        PaperIntradayJob job = job(true);

        runAt(job, T.plus(Duration.ofMinutes(3)));
        assertThat(sent).hasSize(2);
        assertThat(sent.get(1)[0]).as("계좌·시각 순 — 둘째 호출이 계좌2").contains("## 투자 성향").contains("## 장중 판단(고정)");
        assertThat(MAPPER.readTree(sent.get(1)[1]).get("1_basis").get("book").asString()).isEqualTo(PaperBooks.CLAUDE2);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, D)).as("결정 1 + 장중 판단 1").isEqualTo(2);

        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.plus(Duration.ofMinutes(50)), bar("SPY", E, 581.0))));
        runAt(job, T.plus(Duration.ofMinutes(63)));
        assertThat(sent).hasSize(3);
        assertThat(row(PaperBooks.CLAUDE, 2).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(decision(PaperBooks.CLAUDE, 2).kind()).isEqualTo("INTRADAY_2");
        assertThat(row(PaperBooks.CLAUDE2, 2).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(PaperBooks.CLAUDE2, 2).reason()).startsWith("CYCLE_CAP — ").contains("2회");
    }

    @Test
    @DisplayName("셋째 장중 판단(INTRADAY_3 — 세션당 3): 계좌2 소상한이 셋째도 셈 — 결정 1 + 장중 판단 둘(3회) 뒤 소상한 3이면 셋째는 EXPIRED CYCLE_CAP, "
            + "소상한 4면 INTRADAY_3 결정 행으로 부르고 주기 호출은 4회")
    void claude2CycleCapCountsTheThirdJudgment() {
        store.intradayPlans.clear();
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 3);
        for (int slot = 1; slot <= 2; slot++) {
            store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE2, D, RuleBookService.intradayKind(slot), null, "NO_TRADE",
                    "claude-sonnet-5-5", 0, 1, null, 20.0, null, null, null, null, null, null, List.of(), false, 1L, 0, "{}")).orElseThrow();
        }
        assertThat(ClaudeBookService.claude2CallsInCycle(store, D)).as("결정 1 + 장중 판단 둘").isEqualTo(3);
        group("claude2").put("maxCallsPerCycle", 3);
        plan(PaperBooks.CLAUDE2, 3, TEN, "HOURLY", List.of(), morning2, false);
        PaperIntradayJob job = job(true);

        runAt(job, T.plus(Duration.ofMinutes(3)));
        assertThat(sent).isEmpty();
        assertThat(row(PaperBooks.CLAUDE2, 3).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(PaperBooks.CLAUDE2, 3).reason()).startsWith("CYCLE_CAP — ").contains("지금 3회");

        store.intradayPlans.clear();
        group("claude2").put("maxCallsPerCycle", 4);
        plan(PaperBooks.CLAUDE2, 3, TEN, "HOURLY", List.of(), morning2, false);
        runAt(job, T.plus(Duration.ofMinutes(4)));
        assertThat(sent).hasSize(1);
        JsonNode basis = MAPPER.readTree(sent.get(0)[1]).get("1_basis");
        assertThat(basis.get("decisionKind").asString()).isEqualTo(RuleBookService.INTRADAY_3);
        assertThat(basis.get("maxPerSession").asInt()).isEqualTo(3);
        assertThat(decision(PaperBooks.CLAUDE2, 3).kind()).isEqualTo(RuleBookService.INTRADAY_3);
        assertThat(row(PaperBooks.CLAUDE2, 3).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, D)).as("결정 1 + 장중 판단 셋").isEqualTo(4);
    }

    @Test
    @DisplayName("운영자가 당긴 판단(manual)은 수동 문턱(상한 − 정기 작업 몫 예약)으로 — 예약 행은 부르는 사용량에서 수동 행은 EXPIRED CALL_CAP")
    void manualPlansUseTheManualThreshold() {
        store.intradayPlans.clear();
        ((ObjectNode) store.settings.body()).put("apiDailyCallCap", 5).put("apiScheduledReserve", 5);
        plan(PaperBooks.CLAUDE, 1, TEN, "HOURLY", List.of(), morning1, true);
        plan(PaperBooks.CLAUDE2, 1, TEN, "HOURLY", List.of(), morning2, false);

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(PaperBooks.CLAUDE, 1).reason()).startsWith("CALL_CAP — ");
        assertThat(row(PaperBooks.CLAUDE2, 1).status()).as("예약 행은 정기 문턱(상한 5)").isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(sent).hasSize(1);
        assertThat(MAPPER.readTree(sent.get(0)[1]).get("1_basis").get("manual").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("effort(ADR 0031 결정 6): 장중 판단은 intradayEffort(medium)로 부르고 결정 행의 사용 기록도 medium — 키가 없으면 effort(high). 결정·"
            + "복기가 읽는 설정(ClaudeSettings.from)은 그대로 high이고 fallbacks는 같음")
    void intradayJudgmentsUseTheIntradayEffort() {
        store.intradayPlans.clear();
        plan(PaperBooks.CLAUDE, 1, TEN, "HOURLY", List.of(), morning1, false);
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(3)));
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)[3]).as("intradayEffort 없음 — effort 그대로").isEqualTo("high");
        assertThat(decision(PaperBooks.CLAUDE, 1).usage().path("effort").asString()).isEqualTo("high");

        ObjectNode body = (ObjectNode) store.settings.body();
        body.put(IntradayPolicy.EFFORT, "medium");
        plan(PaperBooks.CLAUDE2, 1, TEN, "HOURLY", List.of(), morning2, false);
        runAt(job, T.plus(Duration.ofMinutes(4)));
        assertThat(sent).hasSize(2);
        assertThat(sent.get(1)[3]).isEqualTo("medium");
        assertThat(decision(PaperBooks.CLAUDE2, 1).usage().path("effort").asString()).isEqualTo("medium");
        assertThat(ClaudeBookService.ClaudeSettings.from(body).effort()).as("결정·재시도·복기·프레임 제안").isEqualTo("high");
        assertThat(ClaudeBookService.ClaudeSettings.intraday(body).fallbacks()).isEqualTo(ClaudeBookService.ClaudeSettings.from(body).fallbacks());

        body.put(IntradayPolicy.EFFORT, "ultra");
        assertThat(ClaudeBookService.ClaudeSettings.intraday(body).effort()).as("목록 밖 — effort를 따름").isEqualTo("high");
        body.put("effort", "xhigh");
        body.remove(IntradayPolicy.EFFORT);
        assertThat(ClaudeBookService.ClaudeSettings.intraday(body).effort()).isEqualTo("xhigh");
    }

    // ------------------------------------------------------------------ 보장 1회(ADR 0031 결정 4)
    /** 그 세션의 자유 시점 판 결정(수동, 판 표시 free — 정기 결정보다 늦게 냄) — 보장 행이 붙는 결정. */
    private long freeDecision(String code) {
        store.dbNow = T.plusSeconds(60);
        long id = store.insertDecisionIfAbsent(new Decision(0, code, D, RuleBookService.MANUAL, null, "NO_TRADE", "claude-sonnet-5-5", 0,
                1, null, 20.0, null, null, null, null, null, null, List.of(), true, 1L, 0,
                "{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\",\"variant\":\"" + PacketBuilder.VARIANT_FREE + "\"}}")).orElseThrow();
        store.dbNow = clock.now;
        return id;
    }

    @Test
    @DisplayName("보장 1회(intradayMinPerSession 1): 세션 중간(12:30 ET)까지 예약이 없으면 주기가 두 계좌에 보장 행(12:31·출처 GUARANTEE·시간별 관측치·그 세션의 "
            + "자유 시점 판 결정)을 넣고 작업 기록에 남김 → 창 안에서 정기 문턱으로 부름(수동 문턱이 0이어도), 결정 응답 checkpoint.origin GUARANTEE·알림 "
            + "'장중 판단 1(코드 보장)'. 같은 분·부른 뒤에는 다시 넣지 않고, 보장이 꺼져 있으면(기본) 아무것도 넣지 않음")
    void guaranteesOneJudgmentByMidSession() {
        store.intradayPlans.clear();
        long free1 = freeDecision(PaperBooks.CLAUDE);
        long free2 = freeDecision(PaperBooks.CLAUDE2);
        ObjectNode body = (ObjectNode) store.settings.body();
        body.put("apiDailyCallCap", 5).put("apiScheduledReserve", 5);
        PaperIntradayJob job = job(true);
        Instant mid = Instant.parse("2026-11-02T17:30:20Z");   // 12:30:20 ET

        runAt(job, mid);
        assertThat(store.intradayPlans).as("보장 꺼짐(기본 0)").isEmpty();
        assertThat(store.jobRuns).isEmpty();

        body.put(IntradayPolicy.US_MIN, 1);
        runAt(job, Instant.parse("2026-11-02T17:29:30Z"));
        assertThat(store.intradayPlans).as("12:30 ET 전").isEmpty();
        PaperIntradayJob.Outcome outcome = runAt(job, mid);
        assertThat(outcome.changes()).containsEntry("claude 2026-11-02 #1", "PLANNED GUARANTEE 12:31 ET")
                .containsEntry("claude2 2026-11-02 #1", "PLANNED GUARANTEE 12:31 ET");
        assertThat(store.jobRuns).hasSize(1);
        IntradayPlan made = row(PaperBooks.CLAUDE, 1);
        assertThat(made.atLocal()).isEqualTo(LocalTime.of(12, 31));
        assertThat(made.origin()).isEqualTo(IntradayPlan.ORIGIN_GUARANTEE);
        assertThat(made.manual()).isFalse();
        assertThat(made.feed()).isEqualTo(ExecutionSection.FEED_HOURLY);
        assertThat(made.sourceDecisionId()).isEqualTo(free1);
        assertThat(row(PaperBooks.CLAUDE2, 1).sourceDecisionId()).isEqualTo(free2);
        runAt(job, mid.plusSeconds(30));
        assertThat(store.intradayPlans).as("같은 분 — 다시 넣지 않음").hasSize(2);
        assertThat(sent).isEmpty();

        runAt(job, Instant.parse("2026-11-02T17:33:10Z"));
        assertThat(sent).as("정기 문턱(상한 5) — 수동 문턱 0이어도 부름").hasSize(2);
        Decision d = decision(PaperBooks.CLAUDE, 1);
        assertThat(d.response().path("checkpoint").path("origin").asString()).isEqualTo(IntradayPlan.ORIGIN_GUARANTEE);
        assertThat(d.response().path("checkpoint").has("trigger")).as("사건 없음").isFalse();
        assertThat(PaperNotifications.decision(d, store.books.get(PaperBooks.CLAUDE), List.of(), Map.of(), null))
                .contains("장중 판단 1(코드 보장)");
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);

        runAt(job, Instant.parse("2026-11-02T18:10:00Z"));
        assertThat(store.intradayPlans).as("부른 뒤 — 다시 넣지 않음").hasSize(2);
        assertThat(sent).hasSize(2);
    }

    @Test
    @DisplayName("사건(intradayEvents·장중 스탑 감시 SHADOW — ADR 0031 결정 7): 꺼져 있으면 감시 저장본을 읽지 않음. 켜면 새 감시 저장본의 SPY −1.6% → 두 계좌에 "
            + "사건 행(지금 + 1분·감시 1분봉·출처 EVENT)을 넣고 작업 기록에 남김 → 그 계획의 감시 저장본이 오면 정기 문턱으로 부름(패킷 1_basis.origin EVENT·"
            + "3_request.trigger, 결정 응답 checkpoint.origin EVENT·알림 꼬리 '(사건)')")
    void eventsAddAJudgment() {
        store.intradayPlans.clear();
        long free1 = freeDecision(PaperBooks.CLAUDE);
        freeDecision(PaperBooks.CLAUDE2);
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("contract", 1).put("market", "US").put("reference", "SPY").put("fetchedAt", "2026-11-02T15:04:20Z");
        ObjectNode spy = payload.putObject("tickers").putObject("SPY");
        spy.put("session", E.toString()).put("prevClose", 600.0);
        spy.putObject("day").putObject("first").put("t", "2026-11-02T14:30:00+00:00").put("c", 599.0);
        spy.putArray("bars").addObject().put("t", "2026-11-02T15:03:00+00:00").put("c", 590.4);
        when(marketData.stopWatch(false)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok",
                null, Instant.parse("2026-11-02T15:04:20Z"))));
        PaperIntradayJob job = job(true);

        runAt(job, T.plus(Duration.ofMinutes(5)));
        verify(marketData, never()).stopWatch(false);
        assertThat(store.intradayPlans).as("사건 꺼짐(기본)").isEmpty();

        ObjectNode body = (ObjectNode) store.settings.body();
        body.put(IntradayPolicy.US_EVENTS, true);
        ((ObjectNode) body.get("stopWatch")).put("mode", "SHADOW");
        PaperIntradayJob.Outcome outcome = runAt(job, T.plus(Duration.ofMinutes(5)).plusSeconds(10));
        assertThat(outcome.changes()).containsEntry("claude 2026-11-02 #1", "PLANNED EVENT 10:06 ET — INDEX_MOVE SPY DOWN -1.60%")
                .containsEntry("claude2 2026-11-02 #1", "PLANNED EVENT 10:06 ET — INDEX_MOVE SPY DOWN -1.60%");
        assertThat(store.jobRuns).hasSize(1);
        IntradayPlan made = row(PaperBooks.CLAUDE, 1);
        assertThat(made.feed()).isEqualTo(ExecutionSection.FEED_MINUTE);
        assertThat(made.watch()).containsExactly("SPY");
        assertThat(made.origin()).isEqualTo(IntradayPlan.ORIGIN_EVENT);
        assertThat(made.sourceDecisionId()).isEqualTo(free1);

        when(marketData.watchUs()).thenReturn(Optional.of(watch(Instant.parse("2026-11-02T15:06:30Z"),
                identity(PaperBooks.CLAUDE, LocalTime.of(10, 6), 1), identity(PaperBooks.CLAUDE2, LocalTime.of(10, 6), 1))));
        runAt(job, Instant.parse("2026-11-02T15:08:10Z"));
        assertThat(sent).hasSize(2);
        JsonNode packet = MAPPER.readTree(sent.get(0)[1]);
        assertThat(packet.get("1_basis").get("origin").asString()).isEqualTo("EVENT");
        assertThat(packet.get("3_request").get("trigger").get("events").get(0).get("ticker").asString()).isEqualTo("SPY");
        assertThat(packet.get("3_request").get("question").asString()).isEqualTo(IntradayScheduler.EVENT_QUESTION);
        Decision d = decision(PaperBooks.CLAUDE, 1);
        assertThat(d.response().path("checkpoint").path("origin").asString()).isEqualTo(IntradayPlan.ORIGIN_EVENT);
        assertThat(PaperNotifications.decision(d, store.books.get(PaperBooks.CLAUDE), List.of(), Map.of(), null))
                .contains("장중 판단 1(사건)");
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
    }

    @Test
    @DisplayName("보장을 넣지 않음: 계좌2가 꺼짐·계좌2 소상한에 닿음·하루 정기 문턱에 닿음 — 넣으면 창 시작에 놓침으로 끝나 순번만 쓰므로 미리 봄")
    void guaranteeSkipsWhatTheCallWouldRefuse() {
        store.intradayPlans.clear();
        freeDecision(PaperBooks.CLAUDE);
        freeDecision(PaperBooks.CLAUDE2);
        ObjectNode body = (ObjectNode) store.settings.body();
        body.put(IntradayPolicy.US_MIN, 1);
        group("claude2").put("enabled", false);
        PaperIntradayJob job = job(true);
        runAt(job, Instant.parse("2026-11-02T17:30:20Z"));
        assertThat(store.intradayPlans(PaperBooks.CLAUDE2, E)).as("계좌2 꺼짐").isEmpty();
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, E)).hasSize(1);

        store.intradayPlans.clear();
        group("claude2").put("enabled", true).put("maxCallsPerCycle", 1);
        body.put("apiDailyCallCap", 0);
        runAt(job, Instant.parse("2026-11-02T17:31:20Z"));
        assertThat(store.intradayPlans).as("소상한 1(결정 1회로 닿음)·하루 상한 0").isEmpty();
    }

    // ------------------------------------------------------------------ 자료
    @Test
    @DisplayName("MINUTE: 저장본의 신원 목록에 이 계획(계좌·세션·시각·순번)이 있어야 부름 — 다른 계좌·다른 순번·끈 판 행(순번 없음)의 저장본이면 기다리다 창 끝에 "
            + "EXPIRED NO_WATCH_SNAPSHOT, 여러 계획을 실은 저장본에서는 자기 것을 찾음")
    void minuteNeedsItsOwnIdentityInTheWatchSnapshot() {
        when(marketData.watchUs()).thenReturn(Optional.of(watch(T.plusSeconds(90), identity(PaperBooks.CLAUDE2, TEN, 1),
                identity(PaperBooks.CLAUDE, TEN, 2), identity(PaperBooks.CLAUDE, TEN, null))));
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(5)));
        assertThat(sent).isEmpty();
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);

        when(marketData.watchUs()).thenReturn(Optional.of(watch(T.plus(Duration.ofMinutes(6)), identity(PaperBooks.CLAUDE2, TEN, 1),
                identity(PaperBooks.CLAUDE, TEN, 1))));
        runAt(job, T.plus(Duration.ofMinutes(7)));
        assertThat(sent).as("목록의 둘째가 이 계획").hasSize(1);
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);

        // 창 끝까지 자기 신원이 없으면 놓침.
        plan(PaperBooks.CLAUDE2, 1, TEN, "MINUTE", List.of("AAA"), morning2, false);
        when(marketData.watchUs()).thenReturn(Optional.of(watch(T.plus(Duration.ofMinutes(8)), identity(PaperBooks.CLAUDE, TEN, 1))));
        runAt(job, T.plus(Duration.ofMinutes(9)));
        runAt(job, T.plus(Duration.ofMinutes(21)));
        assertThat(row(PaperBooks.CLAUDE2, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(PaperBooks.CLAUDE2, 1).reason()).isEqualTo(PaperCheckpointJob.NO_WATCH_SNAPSHOT);
        assertThat(sent).hasSize(1);
    }

    @Test
    @DisplayName("놓침·건너뜀: 창이 끝남 → EXPIRED WINDOW_MISSED, 지난 세션 → EXPIRED STALE_SESSION, 계좌가 일시정지 → SKIPPED BOOK_NOT_ACTIVE, 받는 범위 밖 시각 → "
            + "SKIPPED OUT_OF_RANGE — 모두 부르지 않음")
    void missedAndSkippedRows() {
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(21)));
        assertThat(row(PaperBooks.CLAUDE, 1).reason()).isEqualTo(PaperCheckpointJob.WINDOW_MISSED);

        store.intradayPlans.clear();
        plan(PaperBooks.CLAUDE, 1, TEN, "HOURLY", List.of(), morning1, false);
        runAt(job, T.plus(Duration.ofHours(30)));
        assertThat(row(PaperBooks.CLAUDE, 1).reason()).isEqualTo(PaperCheckpointJob.STALE_SESSION);

        store.intradayPlans.clear();
        plan(PaperBooks.CLAUDE, 1, TEN, "HOURLY", List.of(), morning1, false);
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "claude", 100_000, D, PaperBooks.PAUSED,
                T.minusSeconds(86_400)));
        runAt(job, T.plus(Duration.ofMinutes(3)));
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        assertThat(row(PaperBooks.CLAUDE, 1).reason()).startsWith("BOOK_NOT_ACTIVE — ");

        store.intradayPlans.clear();
        book(PaperBooks.CLAUDE);
        plan(PaperBooks.CLAUDE, 1, LocalTime.of(15, 45), "HOURLY", List.of(), morning1, false);
        runAt(job, Instant.parse("2026-11-02T20:48:00Z"));
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        assertThat(row(PaperBooks.CLAUDE, 1).reason()).isEqualTo(PaperIntradayJob.OUT_OF_RANGE);
        assertThat(sent).isEmpty();
    }

    // ------------------------------------------------------------------ 응답
    @Test
    @DisplayName("REPLACE: 기준 시각이 남은 대기 주문(11:30 지정 시각·종가)만 대신하고 지난 것(시가·09:45 지정 시각)은 남김. 새 주문은 장중 시장가·남은 지정 "
            + "시각·그날 종가 — 지난 분(10:02)은 LATE_FOR_TIMING, 범위 밖(15:57)·시각 없음은 MALFORMED, 통과 주문은 AT_MINUTE + target_local 행(기준 거래일 d·만료 E)")
    void replaceSupersedesOnlyOrdersAheadAndAcceptsTheThreeTimings() {
        long open = pending(PaperBooks.CLAUDE, "AAA", PaperBooks.NEXT_OPEN, null);
        long early = pending(PaperBooks.CLAUDE, "AAA", PaperBooks.AT_MINUTE, LocalTime.of(9, 45));
        long later = pending(PaperBooks.CLAUDE, "BBB", PaperBooks.AT_MINUTE, LocalTime.of(11, 30));
        long close = pending(PaperBooks.CLAUDE, "CCC", PaperBooks.NEXT_CLOSE, null);
        answer = ok(reply("REPLACE", null, order("BBB", "BUY", 3.0, null, "MARKET", null),
                order("CCC", "BUY", 3.0, null, "AT_MINUTE", "13:15"), order("AAA", "BUY", 2.0, null, "AT_MINUTE", "10:02"),
                order("DDD", "BUY", 2.0, null, "AT_MINUTE", "15:57"), order("EEE", "BUY", 2.0, null, "AT_MINUTE", null),
                order("FFF", "BUY", 2.0, null, "NEXT_CLOSE", null)));

        runAt(job(true), T.plus(Duration.ofMinutes(3)).plusSeconds(20));

        for (long id : List.of(open, early)) {
            assertThat(store.orders.get(id).status()).as("기준 시각이 지난 주문은 자료로 풂").isEqualTo(PaperBooks.ORDER_PENDING);
        }
        for (long id : List.of(later, close)) {
            assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
            assertThat(store.orders.get(id).rejectReason()).isEqualTo(ClaudeDecisionPipeline.SUPERSEDED_BY_CHECKPOINT);
        }
        Decision d = decision(PaperBooks.CLAUDE, 1);
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(d.response().path("applied").asBoolean()).isTrue();
        assertThat(d.response().path("supersededOrders").toString()).isEqualTo("[" + later + "," + close + "]");
        List<Order> made = store.ordersOf(PaperBooks.CLAUDE).stream().filter(o -> d.id() == (o.decisionId() == null ? -1 : o.decisionId()))
                .toList();
        assertThat(made).extracting(o -> o.ticker() + " " + o.timing() + " " + o.targetLocal() + " " + o.status()
                + (o.rejectReason() == null ? "" : " " + o.rejectReason())).containsExactlyInAnyOrder(
                "BBB MARKET null PENDING", "CCC AT_MINUTE 13:15 PENDING", "AAA AT_MINUTE 10:02 REJECTED LATE_FOR_TIMING",
                "DDD AT_MINUTE 15:57 REJECTED MALFORMED", "EEE AT_MINUTE null REJECTED MALFORMED", "FFF NEXT_CLOSE null PENDING");
        assertThat(made.stream().filter(o -> PaperBooks.ORDER_PENDING.equals(o.status()))).allSatisfy(o -> {
            assertThat(o.asOfTradingDate()).isEqualTo(D);
            assertThat(o.expiresOn()).isEqualTo(E);
        });
        Order market = made.stream().filter(o -> PaperBooks.MARKET.equals(o.timing())).findFirst().orElseThrow();
        assertThat(ExecutionAudit.targetAt(market, E, UsPaperMarket.INSTANCE.calendar())).as("10:03:20 생성 → 10:05 ET")
                .isEqualTo(T.plus(Duration.ofMinutes(5)));
        assertThat(verdict(d, "AAA").path("rejectReason").asString()).isEqualTo("LATE_FOR_TIMING");
        Order late = made.stream().filter(o -> "AAA".equals(o.ticker())).findFirst().orElseThrow();
        assertThat(late.reason().path("validation").asString()).as("근거 문구의 세션 말은 '이 세션'이 아니라 지정 시각 그대로").contains("10:02 ET");
        assertThat(d.response().path("expectedState").path("assumedFills").size()).as("지난 주문 둘을 체결로 본 예상 장부").isEqualTo(2);
    }

    @Test
    @DisplayName("다음 판단 예약(nextCheckpoint): 첫 판단의 응답이 다음 순번 행을 넣거나(없을 때) 남은 예약을 그 시각으로 바꿈 — 그 세션의 결정은 그대로, 예약한 "
            + "판단은 이 응답 결정. 이 판단 시각과 20분 안이면 버리고 남은 예약은 그대로. 순번을 다 쓴 둘째 판단의 예약은 버림(세션당 횟수 기본 2)")
    void nextCheckpointPlansTheFollowingSlot() {
        answer = ok(reply("KEEP", next("13:30", "HOURLY", "[]")));
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(3)));

        Decision first = decision(PaperBooks.CLAUDE, 1);
        IntradayPlan second = row(PaperBooks.CLAUDE, 2);
        assertThat(second.status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
        assertThat(second.atLocal()).isEqualTo(LocalTime.of(13, 30));
        assertThat(second.feed()).isEqualTo("HOURLY");
        assertThat(second.sourceDecisionId()).as("패킷이 읽는 결정은 그 세션의 결정 그대로").isEqualTo(morning1);
        assertThat(second.requestedByDecisionId()).isEqualTo(first.id());
        assertThat(second.variant()).as("다음 판단 예약은 지금 켠 판의 판").isEqualTo(PacketBuilder.FREE_FIXED_RULES_VERSION).isEqualTo("ft-2");
        JsonNode view = first.response().path("intradayPlan");
        assertThat(view.path("planned").get(0).path("slot").asInt()).isEqualTo(2);
        assertThat(view.path("planned").get(0).path("atEt").asString()).isEqualTo("13:30");
        assertThat(view.path("superseded").asInt()).as("nextCheckpoint는 남은 행을 닫지 않음").isZero();

        // 이 판단 시각(10:00)과 20분 안 — 버리고 남은 예약은 그대로. 남은 예약(계좌2의 둘째)을 그 시각으로 바꾸는 경우도 함께.
        plan(PaperBooks.CLAUDE2, 1, TEN, "HOURLY", List.of(), morning2, false);
        plan(PaperBooks.CLAUDE2, 2, LocalTime.of(14, 0), "HOURLY", List.of(), morning2, false);
        answer = ok(reply("KEEP", next("10:15", "HOURLY", "[]")));
        runAt(job, T.plus(Duration.ofMinutes(4)));
        Decision close = decision(PaperBooks.CLAUDE2, 1);
        assertThat(close.response().path("intradayPlan").path("rejected").get(0).path("reason").asString()).contains("20분 안");
        assertThat(row(PaperBooks.CLAUDE2, 2).atLocal()).as("남은 예약 그대로").isEqualTo(LocalTime.of(14, 0));

        // 둘째 판단(13:30)의 nextCheckpoint — 순번을 다 써서 버림.
        when(marketData.quotes()).thenReturn(Optional.of(quotes(Instant.parse("2026-11-02T18:25:00Z"), bar("SPY", E, 581.0))));
        answer = ok(reply("KEEP", next("14:30", "HOURLY", "[]")));
        runAt(job, Instant.parse("2026-11-02T18:33:00Z"));
        Decision last = decision(PaperBooks.CLAUDE, 2);
        assertThat(last.response().path("intradayPlan").path("planned").size()).isZero();
        assertThat(last.response().path("intradayPlan").path("rejected").get(0).path("reason").asString()).contains("다 써서");
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, E)).extracting(p -> p.slot() + " " + p.status())
                .containsExactly("1 DONE", "2 DONE");
    }

    @Test
    @DisplayName("nextCheckpoint가 남은 예약을 대신함 — 둘째 순번의 PLANNED 행이 새 시각·감시 목록으로 바뀌고 예약한 판단이 적힘")
    void nextCheckpointReplacesTheRemainingPlan() {
        plan(PaperBooks.CLAUDE, 2, LocalTime.of(14, 0), "HOURLY", List.of(), morning1, false);
        answer = ok(reply("KEEP", next("11:15", "MINUTE", "[\"BBB\"]")));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        IntradayPlan second = row(PaperBooks.CLAUDE, 2);
        assertThat(second.atLocal()).isEqualTo(LocalTime.of(11, 15));
        assertThat(second.feed()).isEqualTo("MINUTE");
        assertThat(second.watch()).containsExactly("BBB");
        assertThat(second.requestedByDecisionId()).isEqualTo(decision(PaperBooks.CLAUDE, 1).id());
        assertThat(second.status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
    }

    @Test
    @DisplayName("QA-309: 세 예약(10:00·12:00·13:00, 세션당 3) — 첫 판단의 nextCheckpoint는 둘째만 대신하므로 그대로 남는 셋째(13:00)보다 20분 이상 앞이어야 함. "
            + "셋째 뒤(13:10·13:30)·셋째와 20분 안(12:45)은 버리고 행은 그대로(순번 순 = 시각 순·간격 20분), 12:40은 받음. 패킷 nextCheckpoint의 끝은 "
            + "셋째 − 20분(12:40)이고 그대로 남는 예약(laterReserved)이 실림")
    void nextCheckpointKeepsTheLaterReservation() {
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 3);
        plan(PaperBooks.CLAUDE, 2, LocalTime.of(12, 0), "HOURLY", List.of(), morning1, false);
        plan(PaperBooks.CLAUDE, 3, LocalTime.of(13, 0), "HOURLY", List.of(), morning1, false);
        answer = ok(reply("KEEP", next("13:10", "HOURLY", "[]")));
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(3)));

        JsonNode options = MAPPER.readTree(sent.get(0)[1]).get("1_basis").get("nextCheckpoint");
        assertThat(options.get("available").asBoolean()).isTrue();
        assertThat(options.get("firstEt").asString()).isEqualTo("10:20");
        assertThat(options.get("lastEt").asString()).as("그대로 남는 셋째 13:00 − 20분").isEqualTo("12:40");
        assertThat(options.get("replaces").toString()).isEqualTo("{\"atEt\":\"12:00\",\"origin\":\"RESERVED\"}");
        assertThat(options.get("laterReserved").toString()).isEqualTo("{\"atEt\":\"13:00\",\"origin\":\"RESERVED\"}");
        JsonNode view = decision(PaperBooks.CLAUDE, 1).response().path("intradayPlan");
        assertThat(view.path("planned").size()).as("셋째 뒤 — 버림").isZero();
        assertThat(view.path("rejected").get(0).path("reason").asString()).startsWith("CHECKPOINT_INVALID").contains("13:00");
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, E)).extracting(p -> p.slot() + " " + p.status() + " " + p.atLocal())
                .containsExactly("1 DONE 10:00", "2 PLANNED 12:00", "3 PLANNED 13:00");

        // 계좌2 — 셋째와 20분 안(12:45)도 버림.
        plan(PaperBooks.CLAUDE2, 1, TEN, "HOURLY", List.of(), morning2, false);
        plan(PaperBooks.CLAUDE2, 2, LocalTime.of(12, 0), "HOURLY", List.of(), morning2, false);
        plan(PaperBooks.CLAUDE2, 3, LocalTime.of(13, 0), "HOURLY", List.of(), morning2, false);
        answer = ok(reply("KEEP", next("12:45", "HOURLY", "[]")));
        runAt(job, T.plus(Duration.ofMinutes(4)));
        JsonNode close = decision(PaperBooks.CLAUDE2, 1).response().path("intradayPlan");
        assertThat(close.path("planned").size()).isZero();
        assertThat(close.path("rejected").get(0).path("reason").asString()).startsWith("CHECKPOINT_INVALID").contains("13:00");
        assertThat(store.intradayPlans(PaperBooks.CLAUDE2, E)).extracting(p -> p.slot() + " " + p.status() + " " + p.atLocal())
                .containsExactly("1 DONE 10:00", "2 PLANNED 12:00", "3 PLANNED 13:00");

        // 계획 쓰기 규칙만(같은 행에서): 셋째 − 20분(12:40)은 받고, 셋째 20분 뒤보다 늦은 13:30도 버림(간격 검사만으로는 못 거름).
        IntradayPlanner planner = new IntradayPlanner(store);
        Instant now = T.plus(Duration.ofMinutes(5));
        IntradayPlanner.Plan edge = planner.next(ClaudeBookProfile.US_CLAUDE_FT, MAPPER.readTree("{\"nextCheckpoint\":"
                + next("12:40", "HOURLY", "[]") + "}"), E, 1, UsPaperMarket.INSTANCE.calendar(), java.util.Set.of("AAA"), 3, now, MAPPER);
        assertThat(edge.verdict().accepted()).extracting(IntradayRequest.Item::at).containsExactly(LocalTime.of(12, 40));
        IntradayPlanner.Plan after = planner.next(ClaudeBookProfile.US_CLAUDE_FT, MAPPER.readTree("{\"nextCheckpoint\":"
                + next("13:30", "HOURLY", "[]") + "}"), E, 1, UsPaperMarket.INSTANCE.calendar(), java.util.Set.of("AAA"), 3, now, MAPPER);
        assertThat(after.verdict().accepted()).isEmpty();
        assertThat(after.verdict().rejected()).extracting(IntradayRequest.Rejected::reason).singleElement().asString().contains("13:00");
    }

    // ------------------------------------------------------------------ 재시도 없음
    @Test
    @DisplayName("재시도 없음: API 오류면 결정 행 API_ERROR·계획 행 DONE('API_ERROR — 재시도 없음')이고 다시 부르지 않음. 응답 뒤 쓰기가 실패해도 실패 결정 행"
            + "(AFTER_RESPONSE — 계획 칸 포함)을 남기고 다시 부르지 않음")
    void noRetryAfterFailures() {
        answer = new AiService.StructuredResult(false, null, null, "API_ERROR", "overloaded", true, 0L, 0L, 0L, 0L, 900L);
        PaperIntradayJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(3)));
        Decision failed = decision(PaperBooks.CLAUDE, 1);
        assertThat(failed.status()).isEqualTo("API_ERROR");
        assertThat(failed.response().path("summary").asString()).contains("장중 판단 재시도 없음");
        assertThat(row(PaperBooks.CLAUDE, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(row(PaperBooks.CLAUDE, 1).reason()).isEqualTo("API_ERROR — 재시도 없음");
        runAt(job, T.plus(Duration.ofMinutes(5)));
        assertThat(sent).hasSize(1);

        // 계좌2의 판단 — 응답은 받았는데 DONE 쓰기가 한 번 실패.
        plan(PaperBooks.CLAUDE2, 1, TEN, "HOURLY", List.of(), morning2, false);
        answer = ok(reply("KEEP", null));
        failDone = 1;
        PaperIntradayJob.Outcome outcome = runAt(job, T.plus(Duration.ofMinutes(6)));
        assertThat(outcome.error()).contains("DB 순간 장애");
        Decision after = decision(PaperBooks.CLAUDE2, 1);
        assertThat(after.status()).isEqualTo("API_ERROR");
        assertThat(after.response().path("failure").path("stage").asString()).isEqualTo("AFTER_RESPONSE");
        assertThat(after.response().path("summary").asString()).contains("장중 판단 재시도 없음");
        assertThat(after.response().path("checkpoint").path("slot").asInt()).isEqualTo(1);
        assertThat(row(PaperBooks.CLAUDE2, 1).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(row(PaperBooks.CLAUDE2, 1).reason()).isEqualTo(PaperCheckpointJob.AFTER_RESPONSE);
        runAt(job, T.plus(Duration.ofMinutes(7)));
        assertThat(sent).as("과금된 응답 — 다시 부르지 않음").hasSize(2);
    }

    @Test
    @DisplayName("끈 판과 켠 판의 작업은 서로의 표를 보지 않음 — 장중 확인 작업은 장중 판단 계획 행을, 장중 판단 작업은 장중 확인 행을 부르지 않음. 장중 판단 결정은 "
            + "다음 패킷의 직전 결정이 아님")
    void theTwoJobsKeepToTheirOwnTables() {
        group("claude2").put("checkpoints", true);
        store.upsertPlannedCheckpoint(new Checkpoint(PaperBooks.CLAUDE2, E, TEN, "HOURLY", List.of(), "끈 판 요청", morning2, null,
                PaperBooks.CHECKPOINT_PLANNED, null, null, null, null, null));
        store.intradayPlans.clear();

        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        assertThat(sent).as("장중 판단 계획 행이 없음").isEmpty();
        assertThat(store.checkpoint(PaperBooks.CLAUDE2, E).orElseThrow().status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);

        store.checkpoints.clear();
        plan(PaperBooks.CLAUDE, 1, TEN, "HOURLY", List.of(), morning1, false);
        PaperCheckpointJob legacy = new PaperCheckpointJob(store, reader, marketData, packets, service(), ledger,
                new PaperConfig(true, PaperFixtures.FRI, 100_000), MAPPER, clock);
        assertThat(legacy.run().planned()).isZero();
        assertThat(sent).isEmpty();

        assertThat(PacketBuilder.priorDecisionKind(PaperBooks.CLAUDE, RuleBookService.INTRADAY_1)).isFalse();
        assertThat(PacketBuilder.priorDecisionKind(PaperBooks.KR_CLAUDE, RuleBookService.INTRADAY_2)).isFalse();
        assertThat(PacketBuilder.priorDecisionKind(PaperBooks.CLAUDE, RuleBookService.SCHEDULED)).isTrue();
    }
}
