package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 장중 판단 보장 1회({@link IntradayScheduler} — ADR 0031 결정 4) — 순수 판정(보장 시각·넣을 시각·순번)과 FakePaperStore 위의 넣기(스위치·계좌·
 * 결정·문·멱등). 작업에 묶인 흐름(넣은 행을 정기 문턱으로 부름)은 {@link PaperIntradayJobTest}·{@link KrStartTest}가 봅니다.
 *
 * <p>미국 세션 2026-11-09(월, EST — 개장 14:30Z, 12:30 ET = 17:30Z), 한국 2026-12-02(수, 11:30 KST = 02:30Z).
 */
class IntradaySchedulerTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final TradingCalendar KR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    private static final LocalDate MON = LocalDate.of(2026, 11, 9);
    private static final LocalDate FRI = LocalDate.of(2026, 11, 6);
    private static final LocalDate KR_DAY = LocalDate.of(2026, 12, 2);

    private FakePaperStore store;
    private IntradayScheduler scheduler;
    private final List<String> gateCalls = new ArrayList<>();
    private String blocked;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.dbNow = Instant.parse("2026-11-07T00:00:00Z");
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        body().put(IntradayPolicy.US_MIN, 1).put(FreeTimingSettings.US_INTRADAY_MAX, 3);
        ((ObjectNode) body().get("claude")).put("freeTiming", true);
        ((ObjectNode) body().get("claude2")).put("enabled", true).put("freeTiming", true);
        for (String code : List.of(PaperBooks.CLAUDE, PaperBooks.CLAUDE2)) {
            store.books.put(code, new Book(code, PaperBooks.KIND_CLAUDE, code, 100_000, FRI, PaperBooks.ACTIVE, store.dbNow));
        }
        scheduler = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
    }

    private ObjectNode body() {
        return (ObjectNode) store.settings.body();
    }

    private static Instant et(LocalDate day, int hour, int minute, int second) {
        return java.time.ZonedDateTime.of(day, LocalTime.of(hour, minute, second), US.zone()).toInstant();
    }

    private static Instant kst(LocalDate day, int hour, int minute, int second) {
        return java.time.ZonedDateTime.of(day, LocalTime.of(hour, minute, second), KR.zone()).toInstant();
    }

    /** 그 세션의 자유 시점 판 결정(정기, 판 표시 free) — 보장 행이 붙는 결정. */
    private long freeDecision(String code, LocalDate asOf, String variant) {
        String packet = "{\"1_basis\":{\"book\":\"" + code + "\"" + (variant == null ? "" : ",\"variant\":\"" + variant + "\"") + "}}";
        return store.insertDecisionIfAbsent(new Decision(0, code, asOf, RuleBookService.SCHEDULED, null, "NO_TRADE", "claude-sonnet-5-5",
                0, 1, null, 20.0, null, null, null, null, null, null, List.of(), true, 1L, 0, packet)).orElseThrow();
    }

    private static IntradayPlan row(int slot, LocalTime at, String status) {
        IntradayPlan p = IntradayPlan.planned(PaperBooks.CLAUDE, MON, slot, at, "HOURLY", List.of(), "q", "ft-2", false, 1L, null);
        return new IntradayPlan(p.bookCode(), p.sessionDate(), p.slot(), p.atLocal(), p.feed(), p.watch(), p.question(), p.variant(),
                p.manual(), p.sourceDecisionId(), null, null, status, null, null, null, null, null, p.origin(), null);
    }

    private Map<String, String> guarantee(Instant now) {
        return scheduler.guarantee(PaperIntradayJob.BOOKS, store.settings, US, false, now, (code, source) -> {
            gateCalls.add(code + " " + source.id());
            return blocked;
        });
    }

    // ------------------------------------------------------------------ 순수 판정
    @Test
    @DisplayName("보장 시각 G: 개장 기준(미국 + 180분 = 12:30 ET, 한국 + 150분 = 11:30 KST, 수능일 10:00 개장이면 12:30 KST) — 미국 조기 폐장일(13:00 마감)은 "
            + "받는 범위 끝 12:30 − 10분 = 12:20으로 자름(QA-310)")
    void guaranteeTimeIsOpenRelative() {
        assertThat(IntradayScheduler.guaranteeAt(MON, US, false)).isEqualTo(et(MON, 12, 30, 0));
        assertThat(IntradayScheduler.guaranteeAt(KR_DAY, KR, true)).isEqualTo(kst(KR_DAY, 11, 30, 0));
        LocalDate exam = LocalDate.of(2026, 11, 19);
        TradingCalendar shifted = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(exam, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
        assertThat(IntradayScheduler.guaranteeAt(exam, shifted, true)).isEqualTo(kst(exam, 12, 30, 0));
        LocalDate early = LocalDate.of(2026, 11, 27);
        assertThat(IntradayScheduler.guaranteeAt(early, US, false)).as("추수감사절 다음 날 13:00 마감").isEqualTo(et(early, 12, 20, 0));
        assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 29, 20), 1, 3))
                .as("그날도 한 번 — 범위 끝 12:30").isEqualTo(LocalTime.of(12, 30));
    }

    @Test
    @DisplayName("QA-310: 미국 조기 폐장일(13:00 마감 — 받는 범위 끝 12:30)의 보장 시각은 범위 끝 − 10분(12:20 ET) — 12:20:00~12:29:59에 시작한 어느 주기든 "
            + "보장 행을 넣음(1분 창 하나가 아니라 10분 — 장중 판단 작업의 긴 호출 하나에 밀려도 기회가 남음), 12:30부터는 범위 밖. 결정 패킷의 보장 시각도 12:20. "
            + "보통 날·한국은 그대로")
    void earlyCloseGuaranteeLeavesRoomForALongCycle() {
        for (LocalDate early : List.of(LocalDate.of(2026, 11, 27), LocalDate.of(2026, 12, 24))) {
            assertThat(IntradayScheduler.guaranteeAt(early, US, false)).as(early + " 13:00 마감").isEqualTo(et(early, 12, 20, 0));
            assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 19, 59), 1, 3)).as("G 전").isNull();
            assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 20, 0), 1, 3)).isEqualTo(LocalTime.of(12, 21));
            assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 21, 0), 1, 3)).isEqualTo(LocalTime.of(12, 22));
            assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 25, 40), 1, 3)).as("긴 호출 뒤 주기")
                    .isEqualTo(LocalTime.of(12, 26));
            assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 29, 20), 1, 3)).isEqualTo(LocalTime.of(12, 30));
            assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 29, 59), 1, 3)).as("범위 끝 12:30")
                    .isEqualTo(LocalTime.of(12, 30));
            assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 30, 0), 1, 3)).as("범위 밖").isNull();
            assertThat(IntradayScheduler.guaranteeView(early, US, false, 1).get("atEt")).isEqualTo("12:20");
        }
        assertThat(IntradayScheduler.guaranteeAt(MON, US, false)).as("보통 날").isEqualTo(et(MON, 12, 30, 0));
        assertThat(IntradayScheduler.guaranteeAt(KR_DAY, KR, true)).isEqualTo(kst(KR_DAY, 11, 30, 0));
    }

    @Test
    @DisplayName("넣을 시각 = max(G, 지금 + 1분, 끝난 판단 시각 + 20분) — G 전·남은 예약이 있음·부른 판단이 최소 횟수만큼 있음·순번을 다 씀·범위 밖·최소 0·횟수 0이면 "
            + "넣지 않음(null)")
    void guaranteeTimeRules() {
        assertThat(IntradayScheduler.guaranteeTime(List.of(), MON, US, false, et(MON, 12, 29, 59), 1, 3)).as("G 전").isNull();
        assertThat(IntradayScheduler.guaranteeTime(List.of(), MON, US, false, et(MON, 12, 30, 0), 1, 3)).isEqualTo(LocalTime.of(12, 31));
        assertThat(IntradayScheduler.guaranteeTime(List.of(), MON, US, false, et(MON, 13, 47, 40), 1, 3)).as("늦게 본 주기 — 지금 + 1분")
                .isEqualTo(LocalTime.of(13, 48));
        assertThat(IntradayScheduler.guaranteeTime(List.of(row(1, LocalTime.of(14, 30), PaperBooks.CHECKPOINT_PLANNED)), MON, US, false,
                et(MON, 12, 31, 0), 1, 3)).as("남은 예약이 그 몫").isNull();
        assertThat(IntradayScheduler.guaranteeTime(List.of(row(1, LocalTime.of(10, 0), PaperBooks.CHECKPOINT_DONE)), MON, US, false,
                et(MON, 12, 31, 0), 1, 3)).as("이미 부름").isNull();
        assertThat(IntradayScheduler.guaranteeTime(List.of(row(1, LocalTime.of(12, 25), PaperBooks.CHECKPOINT_EXPIRED)), MON, US, false,
                et(MON, 12, 31, 0), 1, 3)).as("놓친 예약 + 20분").isEqualTo(LocalTime.of(12, 45));
        assertThat(IntradayScheduler.guaranteeTime(List.of(row(1, LocalTime.of(10, 0), PaperBooks.CHECKPOINT_SKIPPED),
                row(2, LocalTime.of(11, 0), PaperBooks.INTRADAY_SUPERSEDED)), MON, US, false, et(MON, 12, 31, 0), 1, 2))
                .as("닫힌 순번은 다시 씀 — 새 순번 2 ≤ 2").isEqualTo(LocalTime.of(12, 32));
        assertThat(IntradayScheduler.guaranteeTime(List.of(row(1, LocalTime.of(10, 0), PaperBooks.CHECKPOINT_SKIPPED),
                row(2, LocalTime.of(11, 0), PaperBooks.CHECKPOINT_EXPIRED)), MON, US, false, et(MON, 12, 31, 0), 1, 2))
                .as("순번을 다 씀").isNull();
        assertThat(IntradayScheduler.guaranteeTime(List.of(), MON, US, false, et(MON, 15, 29, 30), 1, 3)).as("범위 끝 15:30")
                .isEqualTo(LocalTime.of(15, 30));
        assertThat(IntradayScheduler.guaranteeTime(List.of(), MON, US, false, et(MON, 15, 30, 0), 1, 3)).as("범위 밖").isNull();
        assertThat(IntradayScheduler.guaranteeTime(List.of(), MON, US, false, et(MON, 12, 31, 0), 0, 3)).as("최소 0").isNull();
        assertThat(IntradayScheduler.guaranteeTime(List.of(), MON, US, false, et(MON, 12, 31, 0), 1, 0)).as("횟수 0").isNull();
        assertThat(IntradayScheduler.guaranteeTime(List.of(), KR_DAY, KR, true, kst(KR_DAY, 11, 30, 5), 1, 3)).isEqualTo(LocalTime.of(11, 31));
        assertThat(IntradayScheduler.guaranteeTime(List.of(), KR_DAY, KR, true, kst(KR_DAY, 14, 50, 0), 1, 3)).as("한국 범위 끝 14:50")
                .isNull();
    }

    // ------------------------------------------------------------------ 넣기
    @Test
    @DisplayName("넣기: 보장을 켠 계좌마다 G 뒤 첫 주기에 보장 행(순번 1·지금 + 1분·출처 GUARANTEE·수동 아님·미국 시간별 관측치·감시 목록 없음·그 세션의 "
            + "자유 시점 판 결정) — 같은 주기를 다시 돌거나 다음 주기에도 다시 넣지 않음(멱등)")
    void insertsOnceAfterTheGuaranteeTime() {
        long source1 = freeDecision(PaperBooks.CLAUDE, FRI, PacketBuilder.VARIANT_FREE);
        long source2 = freeDecision(PaperBooks.CLAUDE2, FRI, PacketBuilder.VARIANT_FREE);
        assertThat(guarantee(et(MON, 12, 29, 30))).as("G 전 — 계획 행도 읽지 않음").isEmpty();
        assertThat(gateCalls).isEmpty();

        Map<String, String> changes = guarantee(et(MON, 12, 30, 20));
        assertThat(changes).containsExactly(Map.entry("claude 2026-11-09 #1", "PLANNED GUARANTEE 12:31 ET"),
                Map.entry("claude2 2026-11-09 #1", "PLANNED GUARANTEE 12:31 ET"));
        IntradayPlan made = store.intradayPlans(PaperBooks.CLAUDE, MON).get(0);
        assertThat(made.origin()).isEqualTo(IntradayPlan.ORIGIN_GUARANTEE);
        assertThat(made.manual()).as("정기 문턱").isFalse();
        assertThat(made.feed()).isEqualTo(ExecutionSection.FEED_HOURLY);
        assertThat(made.watch()).isEmpty();
        assertThat(made.question()).isEqualTo(IntradayScheduler.GUARANTEE_QUESTION);
        assertThat(made.variant()).isEqualTo(PacketBuilder.FREE_FIXED_RULES_VERSION);
        assertThat(made.sourceDecisionId()).isEqualTo(source1);
        assertThat(made.requestedByDecisionId()).isNull();
        assertThat(made.trigger()).isNull();
        assertThat(store.intradayPlans(PaperBooks.CLAUDE2, MON).get(0).sourceDecisionId()).isEqualTo(source2);
        assertThat(gateCalls).containsExactly("claude " + source1, "claude2 " + source2);

        assertThat(guarantee(et(MON, 12, 30, 40))).as("같은 주기 다시").isEmpty();
        assertThat(guarantee(et(MON, 12, 32, 0))).as("다음 주기").isEmpty();
        assertThat(store.intradayPlans).hasSize(2);
    }

    @Test
    @DisplayName("놓친 보장은 순번이 남은 동안 다시 넣음(끝난 시각 + 20분) — 부른 판단이 있으면 그만, 순번을 다 쓰면 그만")
    void reinsertsAfterAMissedGuaranteeUntilSlotsRunOut() {
        body().put(FreeTimingSettings.US_INTRADAY_MAX, 2);
        ((ObjectNode) body().get("claude2")).put("freeTiming", false);
        freeDecision(PaperBooks.CLAUDE, FRI, PacketBuilder.VARIANT_FREE);
        guarantee(et(MON, 12, 30, 20));
        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 1, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_EXPIRED,
                PaperCheckpointJob.WINDOW_MISSED, null, null, null);
        assertThat(guarantee(et(MON, 12, 52, 10))).containsExactly(Map.entry("claude 2026-11-09 #2", "PLANNED GUARANTEE 12:53 ET"));

        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 2, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_EXPIRED,
                PaperCheckpointJob.NO_FRESH_QUOTES, null, null, null);
        assertThat(guarantee(et(MON, 13, 20, 0))).as("세션당 2번 — 순번을 다 씀").isEmpty();

        store.intradayPlans.clear();
        guarantee(et(MON, 12, 30, 20));
        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 1, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, 9L, 30,
                et(MON, 12, 33, 0));
        assertThat(guarantee(et(MON, 13, 0, 0))).as("부른 판단 1 ≥ 최소 1").isEmpty();
    }

    @Test
    @DisplayName("넣지 않음: 최소 0(기본 — 설정 행만 읽음), 스위치 꺼짐, 세션당 횟수 0, 거래일 아님, 범위 끝 뒤, 계좌가 운용 중이 아님, 그 세션의 자유 시점 판 결정 없음"
            + "(끈 판 결정), 문이 막음(파이프라인·계좌2·소상한·하루 상한 — 작업이 정함), 남은 예약이 있음")
    void skipsWhenAConditionFails() {
        freeDecision(PaperBooks.CLAUDE, FRI, PacketBuilder.VARIANT_FREE);
        freeDecision(PaperBooks.CLAUDE2, FRI, null);   // 끈 판 결정 — 계좌2는 넣지 않음
        Instant now = et(MON, 12, 31, 0);

        body().put(IntradayPolicy.US_MIN, 0);
        assertThat(IntradayScheduler.guaranteeWanted(PaperIntradayJob.BOOKS, body())).isFalse();
        assertThat(guarantee(now)).isEmpty();
        body().put(IntradayPolicy.US_MIN, 1);
        assertThat(IntradayScheduler.guaranteeWanted(PaperKrIntradayJob.BOOKS, body())).as("미국 키는 한국 계좌에 안 씀").isFalse();

        ((ObjectNode) body().get("claude")).put("freeTiming", false);
        assertThat(guarantee(now)).as("스위치 꺼짐").isEmpty();
        ((ObjectNode) body().get("claude")).put("freeTiming", true);
        body().put(FreeTimingSettings.US_INTRADAY_MAX, 0);
        assertThat(guarantee(now)).as("횟수 0").isEmpty();
        body().put(FreeTimingSettings.US_INTRADAY_MAX, 3);
        assertThat(guarantee(Instant.parse("2026-11-08T17:31:00Z"))).as("일요일").isEmpty();
        assertThat(guarantee(et(MON, 15, 31, 0))).as("범위 끝 뒤").isEmpty();

        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "claude", 100_000, FRI, PaperBooks.PAUSED,
                store.dbNow));
        assertThat(guarantee(now)).as("일시정지").isEmpty();
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "claude", 100_000, FRI, PaperBooks.ACTIVE,
                store.dbNow));

        blocked = PaperCheckpointJob.CALL_CAP;
        assertThat(guarantee(now)).as("문이 막음").isEmpty();
        assertThat(gateCalls).as("끈 판 결정만 있는 계좌2는 문까지 가지 않음").allMatch(call -> call.startsWith("claude "));
        blocked = null;

        store.upsertPlannedIntradayPlan(IntradayPlan.planned(PaperBooks.CLAUDE, MON, 1, LocalTime.of(14, 30), "HOURLY", List.of(), "예약",
                "ft-2", false, 1L, null));
        assertThat(guarantee(now)).as("남은 예약").isEmpty();
        store.intradayPlans.clear();
        assertThat(guarantee(now)).containsOnlyKeys("claude 2026-11-09 #1");
        assertThat(store.intradayPlans(PaperBooks.CLAUDE2, MON)).isEmpty();
    }

    // ------------------------------------------------------------------ 고정 두 시각(ADR 0039)
    private static IntradayPlan row(int slot, LocalTime at, String status, String origin) {
        IntradayPlan p = row(slot, at, status);
        return new IntradayPlan(p.bookCode(), p.sessionDate(), p.slot(), p.atLocal(), p.feed(), p.watch(), p.question(), p.variant(),
                p.manual(), p.sourceDecisionId(), null, null, status, null, null, null, null, null, origin, null);
    }

    @Test
    @DisplayName("고정 시각: 개장 1시간 뒤와 마감 40분 전 — 미국 10:30·15:20 ET, 한국 10:00·14:50 KST, 미국 조기 폐장일(13:00 마감)은 10:30·12:20, "
            + "한국 장 시간 변경일(10:00~16:30)은 11:00·15:50")
    void fixedTimesFollowTheSessionHours() {
        assertThat(IntradayScheduler.fixedTimes(MON, US, false)).containsExactly(et(MON, 10, 30, 0), et(MON, 15, 20, 0));
        assertThat(IntradayScheduler.fixedTimes(KR_DAY, KR, true)).containsExactly(kst(KR_DAY, 10, 0, 0), kst(KR_DAY, 14, 50, 0));
        LocalDate early = LocalDate.of(2026, 11, 27);
        assertThat(IntradayScheduler.fixedTimes(early, US, false)).containsExactly(et(early, 10, 30, 0), et(early, 12, 20, 0));
        LocalDate exam = LocalDate.of(2026, 11, 19);
        TradingCalendar shifted = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(exam, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
        assertThat(IntradayScheduler.fixedTimes(exam, shifted, true)).containsExactly(kst(exam, 11, 0, 0), kst(exam, 15, 50, 0));
        Map<String, Object> view = IntradayScheduler.fixedView(MON, US, false);
        assertThat(view.get("timesEt")).isEqualTo(List.of("10:30", "15:20"));
        assertThat((String) view.get("rule")).contains("개장 60분 뒤·마감 40분 전").contains("예약(checkpoints·nextCheckpoint)은 받지 않는다");
        assertThat(IntradayScheduler.fixedView(KR_DAY, KR, true).get("timesKst")).isEqualTo(List.of("10:00", "14:50"));
    }

    @Test
    @DisplayName("고정 판단을 넣을 때: 그 시각 2분 전까지는 없음, 2분 전부터는 그 시각 그대로, 지난 뒤에는 '지금 + 1분', 30분 넘게 놓치면 넣지 않음"
            + "(몰아서 부르지 않음), 그 시각대에 이미 판단이 있으면 넣지 않음, 남은 예약이 있으면 기다림, 끝난 판단과는 20분 간격, 순번을 다 쓰면 없음 — "
            + "한국 마감 전 시각(14:50)은 받는 범위의 끝이라 그 시각 전에 넣어야 들어간다")
    void fixedTimeRules() {
        assertThat(IntradayScheduler.fixedTime(List.of(), MON, US, false, et(MON, 10, 27, 59), 3)).isNull();
        assertThat(IntradayScheduler.fixedTime(List.of(), MON, US, false, et(MON, 10, 28, 0), 3)).as("2분 전부터 — 시각은 고정 시각 그대로")
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(10, 30), 0));
        assertThat(IntradayScheduler.fixedTime(List.of(), MON, US, false, et(MON, 10, 29, 59), 3))
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(10, 30), 0));
        assertThat(IntradayScheduler.fixedTime(List.of(), KR_DAY, KR, true, kst(KR_DAY, 9, 58, 30), 3))
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(10, 0), 0));
        assertThat(IntradayScheduler.fixedTime(List.of(), KR_DAY, KR, true, kst(KR_DAY, 14, 48, 30), 3)).as("한국 마감 전 — 범위 끝 14:50 그대로")
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(14, 50), 1));
        assertThat(IntradayScheduler.fixedTime(List.of(), KR_DAY, KR, true, kst(KR_DAY, 14, 50, 10), 3)).as("14:51은 받는 범위 밖 — 놓침").isNull();
        List<IntradayPlan> pulled = List.of(row(1, LocalTime.of(10, 29), PaperBooks.CHECKPOINT_DONE, IntradayPlan.ORIGIN_EVENT));
        assertThat(IntradayScheduler.fixedTime(pulled, MON, US, false, et(MON, 10, 35, 0), 3)).as("2분 전 안에 불린 사건 판단이 그 시각을 대신함").isNull();
        assertThat(IntradayScheduler.fixedTime(List.of(), MON, US, false, et(MON, 10, 30, 10), 3))
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(10, 31), 0));
        assertThat(IntradayScheduler.fixedTime(List.of(), MON, US, false, et(MON, 11, 0, 30), 3)).as("10:30을 30분 넘게 놓침").isNull();
        assertThat(IntradayScheduler.fixedTime(List.of(), MON, US, false, et(MON, 15, 20, 0), 3)).as("둘째 시각은 그대로 — 앞의 놓침과 무관")
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(15, 21), 1));
        List<IntradayPlan> served = List.of(row(1, LocalTime.of(10, 31), PaperBooks.CHECKPOINT_DONE, IntradayPlan.ORIGIN_GUARANTEE));
        assertThat(IntradayScheduler.fixedTime(served, MON, US, false, et(MON, 10, 40, 0), 3)).as("그 시각대에 이미 불렀음").isNull();
        assertThat(IntradayScheduler.fixedTime(served, MON, US, false, et(MON, 15, 20, 5), 3)).as("둘째 시각")
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(15, 21), 1));
        List<IntradayPlan> planned = List.of(row(1, LocalTime.of(10, 31), PaperBooks.CHECKPOINT_PLANNED, IntradayPlan.ORIGIN_EVENT));
        assertThat(IntradayScheduler.fixedTime(planned, MON, US, false, et(MON, 10, 30, 30), 3)).as("남은 예약이 불린 뒤 다시 봄").isNull();
        List<IntradayPlan> eventBefore = List.of(row(1, LocalTime.of(10, 20), PaperBooks.CHECKPOINT_DONE, IntradayPlan.ORIGIN_EVENT));
        assertThat(IntradayScheduler.fixedTime(eventBefore, MON, US, false, et(MON, 10, 30, 0), 3)).as("앞선 사건 판단과 20분 간격")
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(10, 40), 0));
        List<IntradayPlan> full = List.of(row(1, LocalTime.of(9, 50), PaperBooks.CHECKPOINT_DONE), row(2, LocalTime.of(10, 31), PaperBooks.CHECKPOINT_DONE),
                row(3, LocalTime.of(12, 0), PaperBooks.CHECKPOINT_DONE));
        assertThat(IntradayScheduler.fixedTime(full, MON, US, false, et(MON, 15, 20, 0), 3)).as("순번을 다 씀").isNull();
        assertThat(IntradayScheduler.fixedTime(List.of(), MON, US, false, et(MON, 10, 30, 10), 0)).isNull();
    }

    @Test
    @DisplayName("사건이 쓸 수 있는 순번: 아직 남은 고정 판단 수만큼 남겨 둔다 — 개장 직후 2, 첫 고정 판단 뒤 1, 둘째 뒤 0, 놓친 고정 시각은 세지 않음")
    void fixedPendingReservesSlots() {
        assertThat(IntradayScheduler.fixedPending(List.of(), MON, US, false, et(MON, 9, 45, 0))).isEqualTo(2);
        assertThat(IntradayScheduler.fixedPending(List.of(), MON, US, false, et(MON, 10, 30, 5))).as("지금 시각대 것이 아직 없음").isEqualTo(2);
        List<IntradayPlan> first = List.of(row(1, LocalTime.of(10, 31), PaperBooks.CHECKPOINT_DONE, IntradayPlan.ORIGIN_GUARANTEE));
        assertThat(IntradayScheduler.fixedPending(first, MON, US, false, et(MON, 11, 0, 0))).isEqualTo(1);
        assertThat(IntradayScheduler.fixedPending(List.of(), MON, US, false, et(MON, 11, 30, 0))).as("첫 시각은 놓침 — 둘째만").isEqualTo(1);
        List<IntradayPlan> both = List.of(first.get(0), row(2, LocalTime.of(15, 21), PaperBooks.CHECKPOINT_DONE, IntradayPlan.ORIGIN_GUARANTEE));
        assertThat(IntradayScheduler.fixedPending(both, MON, US, false, et(MON, 15, 25, 0))).isZero();
    }

    @Test
    @DisplayName("고정 일정 판(intradayFixed): 두 시각에 한 행씩 넣는다 — 보장 최소 횟수가 0이어도, 질문은 고정 시각의 것, 출처 GUARANTEE. 끈 계좌는 보장 "
            + "규칙 그대로이고 12:30 전에는 넣지 않음")
    void fixedScheduleInsertsTwoRows() {
        body().put(IntradayPolicy.US_FIXED, true).put(IntradayPolicy.US_MIN, 0);
        long source = freeDecision(PaperBooks.CLAUDE, FRI, PacketBuilder.VARIANT_FREE);
        assertThat(guarantee(et(MON, 10, 27, 0))).isEmpty();

        Map<String, String> first = guarantee(et(MON, 10, 28, 20));
        assertThat(first).containsExactly(Map.entry("claude 2026-11-09 #1", "PLANNED GUARANTEE 10:30 ET"));
        IntradayPlan one = store.intradayPlans(PaperBooks.CLAUDE, MON).get(0);
        assertThat(one.atLocal()).isEqualTo(LocalTime.of(10, 30));
        assertThat(one.origin()).isEqualTo(IntradayPlan.ORIGIN_GUARANTEE);
        assertThat(one.question()).isEqualTo(IntradayScheduler.FIXED_QUESTION_OPEN);
        assertThat(one.sourceDecisionId()).isEqualTo(source);
        assertThat(guarantee(et(MON, 10, 31, 20))).as("같은 시각대에 두 번 넣지 않음").isEmpty();

        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 1, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, 9L, 30,
                et(MON, 10, 33, 0));
        assertThat(guarantee(et(MON, 12, 30, 0))).as("고정 판은 세션 중간 보장을 넣지 않음").isEmpty();
        Map<String, String> second = guarantee(et(MON, 15, 20, 30));
        assertThat(second).containsOnlyKeys("claude 2026-11-09 #2");
        IntradayPlan two = store.intradayPlans(PaperBooks.CLAUDE, MON).stream().filter(p -> p.slot() == 2).findFirst().orElseThrow();
        assertThat(two.atLocal()).isEqualTo(LocalTime.of(15, 21));
        assertThat(two.question()).isEqualTo(IntradayScheduler.FIXED_QUESTION_CLOSE);
        assertThat(CheckpointPacket.originNote(false, two.origin(), two.question())).contains("고정 시각의 판단").contains("nextCheckpoint");
        assertThat(CheckpointPacket.originNote(false, IntradayPlan.ORIGIN_GUARANTEE, IntradayScheduler.GUARANTEE_QUESTION)).contains("보장 판단");
    }
}
