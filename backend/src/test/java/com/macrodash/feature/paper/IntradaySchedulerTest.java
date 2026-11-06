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
 * 장중 판단 보장 1회({@link IntradayScheduler} — ADR 0031 초안 결정 4) — 순수 판정(보장 시각·넣을 시각·순번)과 FakePaperStore 위의 넣기(스위치·계좌·
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
            + "받는 범위 끝 12:30 − 1분 = 12:29로 자름")
    void guaranteeTimeIsOpenRelative() {
        assertThat(IntradayScheduler.guaranteeAt(MON, US, false)).isEqualTo(et(MON, 12, 30, 0));
        assertThat(IntradayScheduler.guaranteeAt(KR_DAY, KR, true)).isEqualTo(kst(KR_DAY, 11, 30, 0));
        LocalDate exam = LocalDate.of(2026, 11, 19);
        TradingCalendar shifted = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(exam, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
        assertThat(IntradayScheduler.guaranteeAt(exam, shifted, true)).isEqualTo(kst(exam, 12, 30, 0));
        LocalDate early = LocalDate.of(2026, 11, 27);
        assertThat(IntradayScheduler.guaranteeAt(early, US, false)).as("추수감사절 다음 날 13:00 마감").isEqualTo(et(early, 12, 29, 0));
        assertThat(IntradayScheduler.guaranteeTime(List.of(), early, US, false, et(early, 12, 29, 20), 1, 3))
                .as("그날도 한 번 — 범위 끝 12:30").isEqualTo(LocalTime.of(12, 30));
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
}
