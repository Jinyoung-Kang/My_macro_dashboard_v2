package com.macrodash.feature.paper;

import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.ApiUsage;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Checkpoint;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 장중 확인 작업({@link PaperCheckpointJob}, 계좌2 명세 §5-2·§5-3) — FakePaperStore·가짜 AiService(Mockito — 실제 API·네트워크 없음)·움직이는 시계.
 *
 * <p>기본 시각: 아침 결정 d = 2026-10-30(금), E = 11-02(월, EST 첫 거래일), 확인 10:00 ET = 15:00Z = 11-03 00:00 KST, MINUTE·감시 [AAA].
 */
class PaperCheckpointJobTest {

    private static final LocalDate D = LocalDate.of(2026, 10, 30);
    private static final LocalDate E = LocalDate.of(2026, 11, 2);
    private static final Instant T = Instant.parse("2026-11-02T15:00:00Z");
    private static final ZoneId NY = ZoneId.of("America/New_York");

    /** 시험이 옮기는 시계. */
    static final class MovableClock extends Clock {
        volatile Instant now;

        MovableClock(Instant now) {
            this.now = now;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PacketBuilder packets;
    private AiService ai;
    private PaperLedgerService ledger;
    private PaperSettingsService settings;
    private MovableClock clock;
    private final List<String[]> sent = new ArrayList<>();
    private final AtomicReference<Runnable> duringCall = new AtomicReference<>();
    private AiService.StructuredResult answer;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        clock = new MovableClock(T.plus(Duration.ofMinutes(3)));
        reader = PaperFixtures.quietReader();
        marketData = mock(PaperMarketData.class);
        packets = mock(PacketBuilder.class);
        when(packets.macroSection(any(), any())).thenReturn(MAPPER.readTree("{\"cards\":[]}"));
        ai = mock(AiService.class);
        answer = ok("{\"schemaVersion\":2,\"action\":\"KEEP\",\"summary\":\"계획대로\",\"orders\":[],\"noTradeReason\":\"갭 유지\"}");
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenAnswer(invocation -> {
            sent.add(new String[]{invocation.getArgument(1), invocation.getArgument(2),
                    MAPPER.writeValueAsString(invocation.getArgument(3))});
            Runnable hook = duringCall.getAndSet(null);
            if (hook != null) {
                hook.run();
            }
            return answer;
        });
        settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        claude2().put("enabled", true).put("checkpoints", true).put("maxCallsPerCycle", 3);
        ledger = new PaperLedgerService(store, marketData, MAPPER);
        book(PaperBooks.ACTIVE);
        long morning = morning(D);
        plan(E, LocalTime.of(10, 0), "MINUTE", List.of("AAA"), morning);
        when(marketData.watchUs()).thenReturn(Optional.of(watch(E, LocalTime.of(10, 0), T.plusSeconds(90), E)));
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.minusSeconds(600), bar("SPY", E, 580.0), bar("AAA", E, 50.0))));
    }

    private static AiService.StructuredResult ok(String json) {
        return new AiService.StructuredResult(true, json, "end_turn", null, null, true, 9_000L, 400L, 0L, 0L, 1_200L);
    }

    private ObjectNode claude2() {
        return (ObjectNode) store.settings.body().get("claude2");
    }

    private void book(String status) {
        store.books.put(PaperBooks.CLAUDE2, new Book(PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, PaperBooks.CLAUDE2_LABEL,
                100_000, D, status, T.minusSeconds(86_400 * 10L)));
        store.states.put(PaperBooks.CLAUDE2, new BookState(PaperBooks.CLAUDE2, 100_000, 100_000, 0, 0, null, null, D, null));
    }

    /** 아침 결정 행(모델 있음 — 결정 주기 호출 1회). */
    private long morning(LocalDate asOf) {
        return store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE2, asOf, RuleBookService.SCHEDULED, null, "OK",
                "claude-sonnet-5-5", 0, 1, null, 20.0, null, null, null, null, null, null, List.of(), true, 1L, 0,
                "{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\"}}")).orElseThrow();
    }

    private void plan(LocalDate session, LocalTime at, String feed, List<String> watch, long source) {
        store.upsertPlannedCheckpoint(new Checkpoint(PaperBooks.CLAUDE2, session, at, feed, watch, "갭 뒤 거래량", source,
                null, PaperBooks.CHECKPOINT_PLANNED, null, null, null, null, null));
    }

    /** 감시 저장본 — 그 확인(세션·시각)의 것, SPY는 {@code spySession} 세션 봉 하나. */
    private static Snapshot watch(LocalDate session, LocalTime at, Instant collectedAt, LocalDate spySession) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("contract", 1);
        payload.putObject("checkpoint").put("book", PaperBooks.CLAUDE2).put("sessionDate", session.toString())
                .put("atEt", CheckpointPacket.clock(at));
        payload.put("lagSeconds", 75);
        ObjectNode spy = payload.putObject("tickers").putObject("SPY");
        Instant barAt = collectedAt.minusSeconds(120);
        spy.put("fetchedAt", collectedAt.toString()).put("session", spySession.toString());
        spy.putArray("bars").addObject().put("t", barAt.toString()).put("o", 580).put("h", 581).put("l", 579).put("c", 580.5)
                .put("v", 1_000);
        spy.putObject("day").put("open", 578).put("high", 582).put("low", 577);
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

    private PaperCheckpointJob job(boolean enabled) {
        return new PaperCheckpointJob(store, reader, marketData, packets, service(), ledger,
                new PaperConfig(enabled, PaperFixtures.FRI, 100_000), MAPPER, clock);
    }

    private Checkpoint row(LocalDate session) {
        return store.checkpoint(PaperBooks.CLAUDE2, session).orElseThrow();
    }

    private PaperCheckpointJob.Outcome runAt(PaperCheckpointJob job, Instant at) {
        clock.now = at;
        return job.run();
    }

    // ------------------------------------------------------------------ 꺼짐
    @Test
    @DisplayName("dashboard.paper.enabled=false면 정기 실행은 아무것도 읽거나 쓰지 않음(PaperRiskJob 방식)")
    void disabledDoesNothing() {
        job(false).scheduledRun();
        verifyNoInteractions(marketData, ai, packets);
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("설정 claude2.checkpoints(또는 claude2.enabled)가 꺼져 있으면 부르지 않고, PLANNED 행은 창이 끝난 뒤 SKIPPED CHECKPOINTS_OFF — PLANNED 행이 없으면 쓰기 0")
    void checkpointsOffNeverCalls() {
        claude2().put("checkpoints", false);
        PaperCheckpointJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(5)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
        assertThat(store.jobRuns).isEmpty();
        runAt(job, T.plus(Duration.ofMinutes(21)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        assertThat(row(E).reason()).startsWith("CHECKPOINTS_OFF — ");
        assertThat(store.jobRuns).hasSize(1);
        runAt(job, T.plus(Duration.ofMinutes(30)));
        assertThat(store.jobRuns).as("PLANNED 행이 없으면 기록 없음").hasSize(1);
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
    }

    // ------------------------------------------------------------------ 창·한 번
    @Test
    @DisplayName("창(+2~+20분)에 한 번: +1분 59초에는 안 부름 → +2분에 한 번(c2-2 시스템 프롬프트·장중 확인 스키마·확인 패킷) → 결정 행 CHECKPOINT(기준 거래일 d)·행 DONE(결정·지연·부른 시각) → 다음 주기 다시 안 부름")
    void callsOnceInTheWindow() {
        PaperCheckpointJob job = job(true);
        runAt(job, T.plus(Duration.ofSeconds(119)));
        assertThat(sent).isEmpty();
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);

        Instant called = T.plus(Duration.ofMinutes(2));
        PaperCheckpointJob.Outcome outcome = runAt(job, called);
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)[0]).contains("## 장중 확인(고정)").contains(ClaudePrompts.CLAUDE2_PRIORITY);
        assertThat(sent.get(0)[1]).startsWith("{\"0_instructions\"").contains("\"decisionKind\":\"CHECKPOINT\"")
                .contains("\"asOfInstant\":\"" + called + "\"");
        assertThat(sent.get(0)[2]).contains("\"action\"").contains("KEEP").doesNotContain("stance");
        Decision d = store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.CHECKPOINT).orElseThrow();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(d.response().path("action").asString()).isEqualTo("KEEP");
        assertThat(d.response().path("retry").asBoolean()).isFalse();
        assertThat(d.packet().path("1_basis").path("session").asString()).isEqualTo("2026-11-02");
        Checkpoint done = row(E);
        assertThat(done.status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(done.checkpointDecisionId()).isEqualTo(d.id());
        assertThat(done.lagSeconds()).isEqualTo(75);
        assertThat(done.calledAt()).isEqualTo(called);
        assertThat(done.reason()).isNull();
        assertThat(outcome.changes()).containsKey("2026-11-02");
        assertThat(store.apiUsage(LocalDate.of(2026, 11, 3)).map(ApiUsage::calls)).as("11-02 10:00 ET = 11-03 00:00 KST")
                .contains(1);
        assertThat(store.jobRuns).hasSize(1);

        runAt(job, T.plus(Duration.ofMinutes(3)));
        runAt(job, T.plus(Duration.ofMinutes(25)));
        assertThat(sent).as("세션당 한 번").hasSize(1);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, D)).as("아침 1 + 확인 1").isEqualTo(2);
    }

    @Test
    @DisplayName("서버가 +21분에 켜짐 → EXPIRED WINDOW_MISSED, 나중에 대신 부르지 않음 / 지난 세션의 계획 → EXPIRED STALE_SESSION")
    void missedWindowExpires() {
        PaperCheckpointJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(21)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(E).reason()).startsWith("WINDOW_MISSED — ");
        runAt(job, T.plus(Duration.ofMinutes(40)));
        assertThat(sent).isEmpty();
    }

    @Test
    @DisplayName("지난 세션(뉴욕 날짜가 지남)의 PLANNED 행 → EXPIRED STALE_SESSION")
    void staleSessionExpires() {
        runAt(job(true), Instant.parse("2026-11-03T14:00:00Z"));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(E).reason()).startsWith("STALE_SESSION — ");
        assertThat(sent).isEmpty();
    }

    @Test
    @DisplayName("MINUTE: 확인 시각 뒤에 받은 그 확인의 감시 저장본이 있어야 부름 — T 전 저장본·다른 확인의 저장본·오래된 저장본이면 기다리다 창 끝에 EXPIRED NO_WATCH_SNAPSHOT")
    void minuteNeedsAWatchSnapshotAfterTheTime() {
        when(marketData.watchUs()).thenReturn(Optional.of(watch(E, LocalTime.of(10, 0), T.minusSeconds(30), E)));
        PaperCheckpointJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(5)));
        when(marketData.watchUs()).thenReturn(Optional.of(watch(E, LocalTime.of(11, 0), T.plusSeconds(200), E)));
        runAt(job, T.plus(Duration.ofMinutes(6)));
        when(marketData.watchUs()).thenReturn(Optional.of(watch(E, LocalTime.of(10, 0), T.plusSeconds(150), E)));
        runAt(job, T.plus(Duration.ofMinutes(15)));   // 받은 지 12분 30초 — 10분 넘음
        assertThat(sent).isEmpty();
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
        runAt(job, T.plus(Duration.ofMinutes(21)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(E).reason()).startsWith("NO_WATCH_SNAPSHOT — ");
    }

    @Test
    @DisplayName("HOURLY: SPY 봉 날짜가 E인 시간별 관측치로 부름(패킷 5_feed HOURLY·지연 null), 그런 관측치가 창 끝까지 없으면 EXPIRED NO_FRESH_QUOTES")
    void hourlyUsesQuotes() {
        store.checkpoints.clear();
        long source = store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.SCHEDULED).orElseThrow().id();
        plan(E, LocalTime.of(10, 0), "HOURLY", List.of(), source);
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.minusSeconds(3_600), bar("SPY", D, 575.0))));
        PaperCheckpointJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(5)));
        assertThat(sent).isEmpty();
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.plusSeconds(400), bar("SPY", E, 580.0))));
        runAt(job, T.plus(Duration.ofMinutes(8)));
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)[1]).contains("\"feed\":\"HOURLY\"").contains("\"source\":\"paper.quotes\"");
        verify(marketData, never()).watchUs();
        assertThat(row(E).lagSeconds()).isNull();

        store.checkpoints.clear();
        LocalDate next = LocalDate.of(2026, 11, 3);
        plan(next, LocalTime.of(10, 0), "HOURLY", List.of(), morning(E));
        runAt(job, Instant.parse("2026-11-03T15:05:00Z"));
        runAt(job, Instant.parse("2026-11-03T15:21:00Z"));
        assertThat(row(next).reason()).startsWith("NO_FRESH_QUOTES — ");
    }

    @Test
    @DisplayName("임시 휴장: 개장 + 5분 뒤 받은 감시 저장본의 SPY가 E 세션이 아니면 부르지 않고 SKIPPED NO_SESSION_BARS")
    void temporaryClosureSkips() {
        when(marketData.watchUs()).thenReturn(Optional.of(watch(E, LocalTime.of(10, 0), T.plusSeconds(90), D)));
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        assertThat(row(E).reason()).startsWith("NO_SESSION_BARS — ");
        assertThat(sent).isEmpty();
    }

    @Test
    @DisplayName("조기 폐장일(11-27 마감 13:00)의 13:00 확인은 마감 30분 전보다 늦어 SKIPPED LATE_CHECKPOINT, 12:30은 부름")
    void lateCheckpointSkips() {
        store.checkpoints.clear();
        LocalDate early = LocalDate.of(2026, 11, 27);
        long source = morning(LocalDate.of(2026, 11, 25));
        plan(early, LocalTime.of(13, 0), "HOURLY", List.of(), source);
        Instant at = java.time.ZonedDateTime.of(early, LocalTime.of(13, 0), NY).toInstant();
        runAt(job(true), at.plus(Duration.ofMinutes(3)));
        assertThat(row(early).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        assertThat(row(early).reason()).startsWith("LATE_CHECKPOINT — ");

        store.checkpoints.clear();
        plan(early, LocalTime.of(12, 30), "HOURLY", List.of(), source);
        when(marketData.quotes()).thenReturn(Optional.of(quotes(at.minus(Duration.ofMinutes(50)), bar("SPY", early, 580.0))));
        runAt(job(true), at.minus(Duration.ofMinutes(27)));
        assertThat(row(early).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(sent).hasSize(1);
    }

    @Test
    @DisplayName("계좌2가 일시정지면 부르지 않고 SKIPPED BOOK_NOT_ACTIVE")
    void pausedBookSkips() {
        book(PaperBooks.PAUSED);
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_SKIPPED);
        assertThat(row(E).reason()).startsWith("BOOK_NOT_ACTIVE — ");
        assertThat(sent).isEmpty();
    }

    // ------------------------------------------------------------------ 실패·상한
    @Test
    @DisplayName("재시도 없음: API 오류면 결정 행 API_ERROR(재시도 0)·행 DONE('API_ERROR — 재시도 없음')이고 다음 주기에 다시 부르지 않음, 결정 주기 호출 수에 셈")
    void noRetryOnApiError() {
        answer = new AiService.StructuredResult(false, null, null, "API_ERROR", "HTTP 500", false, null, null, null, null, 300L);
        PaperCheckpointJob job = job(true);
        runAt(job, T.plus(Duration.ofMinutes(3)));
        Decision d = store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.CHECKPOINT).orElseThrow();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(d.retryCount()).isZero();
        assertThat(d.response().path("summary").asString()).contains("재시도 없음");
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(row(E).reason()).isEqualTo("API_ERROR — 재시도 없음");
        assertThat(row(E).checkpointDecisionId()).isEqualTo(d.id());
        runAt(job, T.plus(Duration.ofMinutes(4)));
        runAt(job, T.plus(Duration.ofMinutes(10)));
        assertThat(sent).hasSize(1);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, D)).isEqualTo(2);
    }

    @Test
    @DisplayName("상한: 결정 주기 소상한(아침 1회 ≥ claude2.maxCallsPerCycle 1)이면 바로 EXPIRED CYCLE_CAP, 하루 상한 0이면 EXPIRED CALL_CAP — 부르지 않음")
    void cycleCapExpires() {
        claude2().put("maxCallsPerCycle", 1);
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(E).reason()).startsWith("CYCLE_CAP — ").contains("1회");
        assertThat(sent).isEmpty();
    }

    @Test
    @DisplayName("하루 호출 상한(apiDailyCallCap 0)이면 바로 EXPIRED CALL_CAP")
    void callCapExpires() {
        ((ObjectNode) store.settings.body()).put("apiDailyCallCap", 0);
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_EXPIRED);
        assertThat(row(E).reason()).startsWith("CALL_CAP — ");
        assertThat(sent).isEmpty();
    }

    // ------------------------------------------------------------------ 서머타임
    @Test
    @DisplayName("서머타임 시작 주(2027-03-15 EDT): 같은 KST 날(03-16) 확인 둘 — 3-15 세션 14:00 ET(03:00 KST, d 3-12)과 3-16 세션 10:00 ET(23:00 KST, d 3-15) — 이 서로 다른 결정 주기로 세져 소상한(2)에 막히지 않음")
    void dstStartWeekTwoCheckpointsInOneKstDay() {
        store.checkpoints.clear();
        claude2().put("maxCallsPerCycle", 2);
        LocalDate s1 = LocalDate.of(2027, 3, 15);
        LocalDate s2 = LocalDate.of(2027, 3, 16);
        plan(s1, LocalTime.of(14, 0), "HOURLY", List.of(), morning(LocalDate.of(2027, 3, 12)));
        plan(s2, LocalTime.of(10, 0), "HOURLY", List.of(), morning(s1));
        PaperCheckpointJob job = job(true);
        when(marketData.quotes()).thenReturn(Optional.of(quotes(Instant.parse("2027-03-15T17:30:00Z"), bar("SPY", s1, 600.0))));
        runAt(job, Instant.parse("2027-03-15T18:03:00Z"));
        when(marketData.quotes()).thenReturn(Optional.of(quotes(Instant.parse("2027-03-16T13:58:00Z"), bar("SPY", s2, 601.0))));
        runAt(job, Instant.parse("2027-03-16T14:03:00Z"));
        assertThat(row(s1).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(row(s2).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
        assertThat(sent).hasSize(2);
        assertThat(store.apiUsage(LocalDate.of(2027, 3, 16)).map(ApiUsage::calls)).as("한 KST 날 둘").contains(2);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, LocalDate.of(2027, 3, 12))).isEqualTo(2);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, s1)).isEqualTo(2);
    }

    // ------------------------------------------------------------------ 잠금·읽기
    @Test
    @DisplayName("자기 잠금: 호출하는 동안 같은 작업의 다음 주기는 바로 돌아오고(null), 장부 잠금은 쥐지 않음(다른 스레드가 장부 잠금을 바로 잡음)")
    void usesItsOwnLockAndCallsOutsideTheLedgerLock() throws Exception {
        PaperCheckpointJob job = job(true);
        AtomicReference<Object> second = new AtomicReference<>("unset");
        AtomicReference<Boolean> ledgerFree = new AtomicReference<>();
        duringCall.set(() -> {
            try {
                second.set(CompletableFuture.supplyAsync(job::run).get(5, TimeUnit.SECONDS));
                ledgerFree.set(CompletableFuture.supplyAsync(() -> ledger.exclusively(() -> true)).get(5, TimeUnit.SECONDS));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        runAt(job, T.plus(Duration.ofMinutes(3)));
        assertThat(second.get()).as("앞 주기가 도는 중").isNull();
        assertThat(ledgerFree.get()).as("Claude 호출은 장부 잠금 밖").isTrue();
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
    }

    @Test
    @DisplayName("저장본(감시·관측치)은 StoreReader.quietly 안에서만 읽음 — 수집을 깨우지 않음")
    void readsSnapshotsQuietly() {
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        verify(reader, atLeast(2)).quietly(any());
        verify(marketData, times(1)).watchUs();
        verify(marketData, never()).quotes(any());
    }

    @Test
    @DisplayName("결정 작업이 장중 확인 행을 재시도하지 않음 — CHECKPOINT 행은 retryable이어도 결정 작업이 보는 종류(정기·출발)가 아님")
    void checkpointRowIsNotADecisionJobKind() {
        answer = new AiService.StructuredResult(false, null, null, "API_ERROR", "HTTP 500", false, null, null, null, null, 300L);
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        Decision d = store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.CHECKPOINT).orElseThrow();
        assertThat(ClaudeBookService.retryable(d)).as("API 오류·재시도 0 — 종류로 걸러야 함").isTrue();
        assertThat(PacketBuilder.KINDS).doesNotContain(RuleBookService.CHECKPOINT);
        assertThat(store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.SCHEDULED).orElseThrow().retryCount()).isZero();
    }

    // ------------------------------------------------------------------ 적용(단계 2 — ⑩·§10-6)
    /** 아침 결정(d)이 낸 대기 주문 — 목표 세션 E 하루짜리, 만든 시각 = d 저녁. */
    private long pending(String ticker, String side, Double weight, Double fraction, String timing) {
        long morning = store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.SCHEDULED).orElseThrow().id();
        return store.insertOrder(new Order(0, PaperBooks.CLAUDE2, morning, ticker, side, null, weight, fraction, timing,
                "CLAUDE", PaperBooks.ORDER_PENDING, null, null, D, Instant.parse("2026-10-30T22:31:00Z"), E, null));
    }

    /** 보유 — 10-20에 연 것(보유 거래일 8 — 재량 매도 가능). */
    private void hold(String ticker, int qty, double price) {
        Instant opened = Instant.parse("2026-10-20T20:20:00Z");
        store.upsertPosition(new Position(PaperBooks.CLAUDE2, ticker, qty, price, LocalDate.of(2026, 10, 20), opened, price,
                opened, price, opened, false, LocalDate.of(2026, 10, 20), price, null));
    }

    private void cash(double cash, double nav) {
        store.states.put(PaperBooks.CLAUDE2, new BookState(PaperBooks.CLAUDE2, cash, nav, nav - cash,
                (nav - cash) / nav * 100, null, null, D, null));
    }

    private static String reply(String action, String... orders) {
        return "{\"schemaVersion\":2,\"action\":\"" + action + "\",\"summary\":\"장중 판단\",\"orders\":["
                + String.join(",", orders) + "],\"noTradeReason\":" + (orders.length == 0 ? "\"관망\"" : "null") + "}";
    }

    private static String checkpointOrder(String ticker, String side, Double weight, Double fraction, String timing) {
        return "{\"ticker\":\"" + ticker + "\",\"side\":\"" + side + "\",\"targetWeightPct\":" + weight
                + ",\"sellFraction\":" + fraction + ",\"timing\":\"" + timing + "\",\"executionNote\":\"" + timing
                + " — 장중 확인\",\"thesis\":\"" + ticker + " 논거\",\"labels\":[\"사실\"],\"invalidation\":\"갭 하락\"}";
    }

    /** 관측치 — SPY·AAA·BBB·CCC(E 봉). */
    private void universe() {
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.minusSeconds(600), bar("SPY", E, 580.0),
                bar("AAA", E, 50.0), bar("BBB", E, 20.0), bar("CCC", E, 10.0))));
    }

    private Decision checkpointDecision() {
        return store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.CHECKPOINT).orElseThrow();
    }

    private JsonNode verdict(Decision d, String ticker) {
        for (JsonNode row : d.response().path("validation")) {
            if (ticker.equals(row.path("ticker").asString())) {
                return row;
            }
        }
        throw new AssertionError("검증 줄 없음: " + ticker);
    }

    @Test
    @DisplayName("⑩ REPLACE는 기준 시각이 아직 오지 않은 대기 주문만 대신함 — 10:00 확인(10:03)에서 NEXT_OPEN(09:30, 지남·미해결)은 남고 AT_1100·NEXT_CLOSE는 '장중 확인이 대신함'으로 취소, 응답 supersededOrders·applied")
    void replaceCancelsOnlyOrdersWhoseTimeIsAhead() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        long open = pending("AAA", PaperBooks.BUY, 5.0, null, PaperBooks.NEXT_OPEN);
        long eleven = pending("BBB", PaperBooks.BUY, 5.0, null, PaperBooks.AT_1100);
        long close = pending("CCC", PaperBooks.BUY, 5.0, null, PaperBooks.NEXT_CLOSE);
        answer = ok(reply("REPLACE"));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        assertThat(store.orders.get(open).status()).as("기준 시각이 지난 주문은 자료로 풂").isEqualTo(PaperBooks.ORDER_PENDING);
        for (long id : List.of(eleven, close)) {
            assertThat(store.orders.get(id).status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
            assertThat(store.orders.get(id).rejectReason()).isEqualTo(ClaudeDecisionPipeline.SUPERSEDED_BY_CHECKPOINT);
        }
        Decision d = checkpointDecision();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(d.response().path("action").asString()).isEqualTo("REPLACE");
        assertThat(d.response().path("applied").asBoolean()).isTrue();
        assertThat(d.response().path("supersededOrders").toString()).isEqualTo("[" + eleven + "," + close + "]");
        assertThat(d.response().path("expectedState").path("assumedFills")).singleElement()
                .satisfies(f -> assertThat(f.path("orderId").asLong()).isEqualTo(open));
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
    }

    @Test
    @DisplayName("REPLACE의 새 주문이 모두 거절돼도(유니버스 밖) 형식 검사를 통과했으면 기준 시각이 뒤인 대기 주문은 대신함 — 거절 주문은 REJECTED와 사유로 남음")
    void replaceWithAllRejectedStillSupersedes() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        long eleven = pending("BBB", PaperBooks.BUY, 5.0, null, PaperBooks.AT_1100);
        answer = ok(reply("REPLACE", checkpointOrder("ZZZ", "BUY", 5.0, null, "MARKET")));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        assertThat(store.orders.get(eleven).status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
        Decision d = checkpointDecision();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(verdict(d, "ZZZ").path("rejectReason").asString()).isEqualTo("OUT_OF_UNIVERSE");
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).filteredOn(o -> "ZZZ".equals(o.ticker())).singleElement()
                .satisfies(o -> {
                    assertThat(o.status()).isEqualTo("REJECTED");
                    assertThat(o.decisionId()).isEqualTo(d.id());
                });
    }

    @Test
    @DisplayName("호출하는 사이 계좌2가 일시정지되면 REPLACE를 적용하지 않음 — 결정 SKIPPED·applied:false, 대기 주문 그대로(행은 DONE — 재시도 없음)")
    void pausedDuringCallDoesNotApply() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        long eleven = pending("BBB", PaperBooks.BUY, 5.0, null, PaperBooks.AT_1100);
        answer = ok(reply("REPLACE", checkpointOrder("CCC", "BUY", 3.0, null, "MARKET")));
        duringCall.set(() -> store.updateBookStatus(PaperBooks.CLAUDE2, PaperBooks.PAUSED));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        Decision d = checkpointDecision();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(d.response().path("applied").asBoolean(true)).isFalse();
        assertThat(store.orders.get(eleven).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).hasSize(1);
        assertThat(row(E).status()).isEqualTo(PaperBooks.CHECKPOINT_DONE);
    }

    @Test
    @DisplayName("KEEP은 아무것도 바꾸지 않음 — 대기 주문 그대로·새 주문 없음, 결정 NO_TRADE + action KEEP, 예상 상태만 기록")
    void keepChangesNothing() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        long open = pending("AAA", PaperBooks.BUY, 5.0, null, PaperBooks.NEXT_OPEN);
        long eleven = pending("BBB", PaperBooks.BUY, 5.0, null, PaperBooks.AT_1100);

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).extracting(Order::id).containsExactly(open, eleven);
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).allSatisfy(o -> assertThat(o.status()).isEqualTo("PENDING"));
        Decision d = checkpointDecision();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(d.response().path("action").asString()).isEqualTo("KEEP");
        assertThat(d.response().has("supersededOrders")).isFalse();
        assertThat(d.response().path("expectedState").isObject()).isTrue();
    }

    @Test
    @DisplayName("지난 AT_*(T ≤ 지금 + 60초)는 LATE_FOR_TIMING, 남은 AT_1100·MARKET은 통과 → 대기(기준 거래일 d, 만료 E, 결정 = 확인 결정)")
    void passedAtTimingIsLateForTiming() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3)).plusSeconds(20);
        answer = ok(reply("REPLACE", checkpointOrder("AAA", "BUY", 3.0, null, "AT_1000"),
                checkpointOrder("BBB", "BUY", 3.0, null, "AT_1100"), checkpointOrder("CCC", "BUY", 3.0, null, "MARKET")));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        Decision d = checkpointDecision();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(verdict(d, "AAA").path("rejectReason").asString()).isEqualTo("LATE_FOR_TIMING");
        List<Order> accepted = store.ordersByStatus(PaperBooks.CLAUDE2, PaperBooks.ORDER_PENDING);
        assertThat(accepted).extracting(Order::ticker).containsExactlyInAnyOrder("BBB", "CCC");
        assertThat(accepted).allSatisfy(o -> {
            assertThat(o.asOfTradingDate()).isEqualTo(D);
            assertThat(o.expiresOn()).isEqualTo(E);
            assertThat(o.decisionId()).isEqualTo(d.id());
        });
        Order market = accepted.stream().filter(o -> "CCC".equals(o.ticker())).findFirst().orElseThrow();
        assertThat(market.timing()).isEqualTo(PaperBooks.MARKET);
        assertThat(ExecutionAudit.targetAt(market, E, UsPaperMarket.INSTANCE.calendar()))
                .as("10:03:20 생성 → 10:05 ET").isEqualTo(T.plus(Duration.ofMinutes(5)));
    }

    @Test
    @DisplayName("순위: MARKET(0) 매도는 AT_1400(5) 매수의 현금을 만듦, AT_1400 매도는 MARKET 매수의 현금을 만들지 않음(OVER_ALLOCATED) — 검증기 순위 규칙의 장중 확인판")
    void marketRankFundsLaterBuys() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        cash(1_000, 100_000);
        hold("AAA", 1_980, 50);
        answer = ok(reply("REPLACE", checkpointOrder("AAA", "SELL", null, 0.5, "MARKET"),
                checkpointOrder("BBB", "BUY", 5.0, null, "AT_1400")));
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        Decision first = checkpointDecision();
        assertThat(verdict(first, "AAA").path("accepted").asBoolean()).isTrue();
        assertThat(verdict(first, "BBB").path("accepted").asBoolean()).as("앞 순위 매도의 대금").isTrue();

        setUp();
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        cash(1_000, 100_000);
        hold("AAA", 1_980, 50);
        answer = ok(reply("REPLACE", checkpointOrder("AAA", "SELL", null, 0.5, "AT_1400"),
                checkpointOrder("BBB", "BUY", 5.0, null, "MARKET")));
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        Decision second = checkpointDecision();
        assertThat(verdict(second, "AAA").path("accepted").asBoolean()).isTrue();
        assertThat(verdict(second, "BBB").path("rejectReason").asString()).as("뒤 순위 매도는 앞 매수의 현금이 아님")
                .isEqualTo("OVER_ALLOCATED");
    }

    @Test
    @DisplayName("예상 상태(§10-6): 기준 시각이 지난 대기 매수를 체결로 셈 — 1분봉·감시 자료가 없으면 마지막 가격(관측치 50 → 10% × 100,000 ÷ 50 = 200주, 현금 90,000), 1분봉 저장본이 있으면 그 T 봉 시가(48 → 208주), 패킷 4_portfolio.expected에도 같은 값")
    void expectedStateCountsDueOrdersAsFilled() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        long open = pending("AAA", PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN);
        pending("BBB", PaperBooks.BUY, 5.0, null, PaperBooks.AT_1100);
        when(marketData.watchUs()).thenReturn(Optional.empty());
        store.checkpoints.clear();
        long source = store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.SCHEDULED).orElseThrow().id();
        plan(E, LocalTime.of(10, 0), "HOURLY", List.of(), source);
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.plusSeconds(60), bar("SPY", E, 580.0),
                bar("AAA", E, 50.0), bar("BBB", E, 20.0))));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        JsonNode expected = checkpointDecision().response().path("expectedState");
        assertThat(expected.path("cash").asDouble()).isEqualTo(90_000.0);
        assertThat(expected.path("nav").asDouble()).isEqualTo(100_000.0);
        assertThat(expected.path("assumedFills")).singleElement().satisfies(f -> {
            assertThat(f.path("orderId").asLong()).isEqualTo(open);
            assertThat(f.path("qty").asInt()).isEqualTo(200);
            assertThat(f.path("priceSource").asString()).isEqualTo(ExpectedState.PRICE_LAST);
        });
        assertThat(expected.path("positions").get(0).path("weightPct").asDouble()).isEqualTo(10.0);
        JsonNode packet = MAPPER.readTree(sent.get(0)[1]);
        assertThat(packet.path("4_portfolio").path("expected").path("assumedFills").get(0).path("qty").asInt()).isEqualTo(200);

        // 1분봉 저장본(조립 전에 받음)에 09:30 봉 시가 48 — 그 가격으로(장부 2b의 R1과 같은 판정).
        setUp();
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        long again = pending("AAA", PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN);
        store.checkpoints.clear();
        plan(E, LocalTime.of(10, 0), "HOURLY", List.of(),
                store.decisionFor(PaperBooks.CLAUDE2, D, RuleBookService.SCHEDULED).orElseThrow().id());
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.plusSeconds(60), bar("SPY", E, 580.0),
                bar("AAA", E, 50.0))));
        when(marketData.barsUs()).thenReturn(Optional.of(new ExecutionAuditFixtures.Bars(T.plusSeconds(30))
                .bar("AAA", E, ExecutionAuditFixtures.et(E, 9, 30), 48.0, 500.0)
                .bar("AAA", E, ExecutionAuditFixtures.et(E, 9, 31), 48.5, 500.0).snapshot()));
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        JsonNode fromBars = checkpointDecision().response().path("expectedState").path("assumedFills").get(0);
        assertThat(fromBars.path("orderId").asLong()).isEqualTo(again);
        assertThat(fromBars.path("priceSource").asString()).isEqualTo(ExpectedState.PRICE_BARS);
        assertThat(fromBars.path("qty").asInt()).isEqualTo(208);
    }

    @Test
    @DisplayName("예상 매수 보유는 그 세션에 연 것 — 같은 날 MARKET 재량 매도는 MIN_HOLD로 거절(장중 단타 막음)")
    void expectedBuyCannotBeSoldSameDay() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        pending("AAA", PaperBooks.BUY, 10.0, null, PaperBooks.NEXT_OPEN);
        answer = ok(reply("REPLACE", checkpointOrder("AAA", "SELL", null, null, "MARKET")));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        assertThat(verdict(checkpointDecision(), "AAA").path("rejectReason").asString()).isEqualTo("MIN_HOLD");
    }

    @Test
    @DisplayName("월 상한은 계좌2 계산 — 출발(INITIAL) 주문만 빼고 장중 확인(CHECKPOINT) 결정의 체결 주문도 셈(상한 1에 이미 1건 → MONTHLY_CAP)")
    void monthlyCapCountsCheckpointOrders() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        ((ObjectNode) store.settings.body()).put("maxDiscretionaryOrdersPerMonth", 1);
        LocalDate earlier = LocalDate.of(2026, 10, 28);
        long cp = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE2, earlier, RuleBookService.CHECKPOINT,
                null, "OK", "claude-sonnet-5-5", 0, 1, null, null, null, null, null, null, null, null, List.of(), false, 1L, 0,
                "{}")).orElseThrow();
        store.insertOrder(new Order(0, PaperBooks.CLAUDE2, cp, "CCC", PaperBooks.BUY, 10, 2.0, null, PaperBooks.MARKET,
                "CLAUDE", PaperBooks.ORDER_FILLED, null, null, earlier, Instant.parse("2026-10-29T15:03:00Z"),
                LocalDate.of(2026, 10, 29), Instant.parse("2026-10-29T16:00:00Z")));
        answer = ok(reply("REPLACE", checkpointOrder("BBB", "BUY", 3.0, null, "AT_1100")));

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        Decision d = checkpointDecision();
        assertThat(d.response().path("monthlyDiscretionaryOrders").asInt()).isEqualTo(1);
        assertThat(verdict(d, "BBB").path("rejectReason").asString()).isEqualTo("MONTHLY_CAP");
    }

    @Test
    @DisplayName("⑨ 단언 — 확인 주문의 created_at(응답 뒤 DB now())은 패킷 asOfInstant보다 늦고, MARKET 기준 시각은 그보다 60초 넘게 뒤")
    void ordersCreatedAfterThePacketInstant() {
        universe();
        store.dbNow = T.plus(Duration.ofMinutes(3));
        answer = ok(reply("REPLACE", checkpointOrder("BBB", "BUY", 3.0, null, "MARKET")));
        duringCall.set(() -> {
            clock.now = clock.now.plusSeconds(45);
            store.dbNow = clock.now;
        });

        runAt(job(true), T.plus(Duration.ofMinutes(3)));

        Decision d = checkpointDecision();
        Instant asOfInstant = Instant.parse(d.packet().path("1_basis").path("asOfInstant").asString());
        Order order = store.ordersByStatus(PaperBooks.CLAUDE2, PaperBooks.ORDER_PENDING).get(0);
        assertThat(order.createdAt()).isAfter(asOfInstant);
        assertThat(ExecutionAudit.marketTarget(order.createdAt())).isAfter(asOfInstant.plusSeconds(60));
    }

    @Test
    @DisplayName("장부 cashLimited가 마지막 방어선 — 예상 상태가 가격을 몰라 빼 둔 대기 매수(unpriced)가 실제로 먼저 체결되면, 확인의 MARKET 매수 둘 가운데 뒤 것이 현금 부족으로 줄어듦")
    void ledgerCashLimitedIsTheLastDefence() {
        when(marketData.quotes()).thenReturn(Optional.of(quotes(T.minusSeconds(600), bar("SPY", E, 580.0),
                bar("BBB", E, 20.0), bar("CCC", E, 10.0), bar("ZZZ", E, 50.0))));
        store.dbNow = T.plus(Duration.ofMinutes(3));
        cash(20_000, 100_000);
        hold("ZZZ", 1_600, 50);
        long open = pending("AAA", PaperBooks.BUY, 9.0, null, PaperBooks.NEXT_OPEN);
        answer = ok(reply("REPLACE", checkpointOrder("BBB", "BUY", 10.0, null, "MARKET"),
                checkpointOrder("CCC", "BUY", 9.0, null, "MARKET")));
        runAt(job(true), T.plus(Duration.ofMinutes(3)));
        Decision d = checkpointDecision();
        assertThat(d.response().path("expectedState").path("unpriced").toString()).isEqualTo("[" + open + "]");
        assertThat(verdict(d, "BBB").path("accepted").asBoolean()).isTrue();
        assertThat(verdict(d, "CCC").path("accepted").asBoolean()).as("예상 현금 20,000 안").isTrue();

        // 장부: 11:00 ET 관측치 — AAA 09:30 봉으로 먼저 체결(약 9,000), BBB·CCC는 MARKET T(10:05) 봉.
        Instant w = ExecutionAuditFixtures.et(E, 11, 0);
        ExecutionAuditFixtures.Bars bars = new ExecutionAuditFixtures.Bars(w.plusSeconds(60)).market(LocalTime.of(10, 5));
        for (String ticker : List.of("AAA", "BBB", "CCC", "ZZZ", "SPY")) {
            double base = switch (ticker) {
                case "AAA" -> 50;
                case "BBB" -> 20;
                case "CCC" -> 10;
                case "ZZZ" -> 50;
                default -> 580;
            };
            for (int minute = 0; minute < 90; minute++) {
                bars.bar(ticker, E, ExecutionAuditFixtures.et(E, 9, 30).plus(Duration.ofMinutes(minute)), base, 1_000.0);
            }
        }
        when(marketData.barsUs()).thenReturn(Optional.of(bars.snapshot()));
        ledger.process(quotes(w, bar("AAA", D, 49.0, E, 50.0), bar("BBB", D, 19.0, E, 20.0), bar("CCC", D, 9.0, E, 10.0),
                bar("ZZZ", D, 50.0, E, 50.0), bar("SPY", D, 579.0, E, 580.0)));

        assertThat(store.orders.get(open).status()).isEqualTo(PaperBooks.ORDER_FILLED);
        Order ccc = store.ordersOf(PaperBooks.CLAUDE2).stream().filter(o -> "CCC".equals(o.ticker())).findFirst()
                .orElseThrow();
        assertThat(ccc.status()).isEqualTo(PaperBooks.ORDER_FILLED);
        assertThat(ccc.reason().path("cashLimited").asBoolean()).isTrue();
    }
}
